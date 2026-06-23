'use strict';

/**
 * fnf.js — Full-and-Final settlement math core (Feature 4 §4.3, §8 slice 4f).
 *
 * PURE: no DB, no I/O, no prisma, no `new Date()` for the business math (the
 * caller supplies every amount + date in `ctx`). Unit-testable to the exact
 * minor-unit with plain `node`, mirroring the payroll engine / compliance module
 * discipline (engine.js, compliance/india.js, compliance/newzealand.js). The
 * controller reads the DB (SeparationCase, Employee, comp, leave balance, loans,
 * assets), maps the rows into the plain `ctx` below, calls `computeFnf`, then
 * persists the returned line set onto the SeparationCase money fields + a
 * PayRun(type=FNF) input.
 *
 * MONEY: everything is INTEGER MINOR UNITS (paise for INR, cents for NZD).
 * Reuses the country compliance cores — NEVER re-implements them:
 *   - IN gratuity         → compliance/india.js computeGratuity (15/26 × Basic+DA
 *                            × completed years, >6mo rounds up, ₹20L cap, ≥5y gate)
 *   - NZ holiday payout    → compliance/holidaysAct.js (8% pre-entitlement on gross
 *                            since anniversary + untaken annual leave valued at the
 *                            GREATER OF OWP and AWE).
 *
 * The result mirrors a SeparationCase snapshot 1:1 (§7 QA15): every field the
 * controller persists (gratuityAmount, leaveEncashmentDays/Amount,
 * nzHolidayPayoutAmount, noticeRecoveryAmount, loanForeclosureAmount,
 * assetRecoveryAmount, netSettlement) is present in `result.snapshot`, and the
 * same numbers drive `result.payRunInput` (the PayRun(type=FNF) earnings/
 * deductions lines). A NEGATIVE net is a recoverable balance and STILL produces a
 * PayRun (§7 QA14).
 */

const { _internals: indiaInternals } = require('../payroll/compliance/india');
const holidaysAct = require('../payroll/compliance/holidaysAct');

const { computeGratuity } = indiaInternals;

// ── pure helpers (integer minor units only; never floats for money) ──────────
function int(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function sumMinor(lines) {
  return (lines || []).reduce((acc, l) => acc + int(l && l.amountMinor), 0);
}
// Per-day pay on the 26-paid-days convention (IN Payment-of-Gratuity / leave
// encashment basis): monthly Basic+DA ÷ 26, round-half-up to the minor unit.
function perDay26(basicDaMonthlyMinor) {
  return Math.floor(int(basicDaMonthlyMinor) / 26 + 0.5);
}
// Per-day pay on a calendar-month basis (notice pay-in-lieu / recovery): monthly
// gross ÷ daysInMonth, round-half-up. The caller passes the divisor it wants
// (default 30 — the common notice-period convention) so the math stays pure.
function perDayMonth(monthlyMinor, daysInMonth = 30) {
  const d = daysInMonth > 0 ? daysInMonth : 30;
  return Math.floor(int(monthlyMinor) / d + 0.5);
}

// ── 1. Gratuity (IN) ─────────────────────────────────────────────────────────
// Reuses compliance/india.js computeGratuity. Eligible ≥5 completed years; on
// DEATH / disablement the 5-year gate is WAIVED (Payment of Gratuity Act §4(1)
// proviso). >6 months rounds the final year up; cap ₹20,00,000. NZ → no gratuity.
function computeGratuityLine(ctx) {
  if (ctx.country === 'NZ') return { amountMinor: 0, eligible: false, completedYears: 0, waived: false };
  const waived = ctx.separationType === 'DEATH' || ctx.disablement === true;
  const g = computeGratuity({
    lastDrawnBasicDaMinor: int(ctx.basicDaMonthlyMinor),
    serviceYears: int(ctx.serviceYears),
    serviceMonths: int(ctx.serviceMonths),
    actCovered: true,
  });
  // On a death/disablement waiver, pay the formula amount even when <5 years.
  if (!g.eligible && waived) {
    const completedYears = int(ctx.serviceYears) + (int(ctx.serviceMonths) >= 6 ? 1 : 0);
    const grossRaw = (int(ctx.basicDaMonthlyMinor) * 15 * completedYears) / 26;
    const grossMinor = Math.floor(grossRaw + 0.5);
    const capMinor = 2000000 * 100; // ₹20,00,000 in paise
    return { amountMinor: Math.min(grossMinor, capMinor), eligible: true, waived: true, completedYears };
  }
  return {
    amountMinor: g.grossMinor,
    exemptMinor: g.exemptMinor,
    taxableMinor: g.taxableMinor,
    eligible: g.eligible,
    completedYears: g.completedYears,
    waived: false,
  };
}

// ── 2. Leave encashment (IN) ─────────────────────────────────────────────────
// encashableDays × (Basic+DA ÷ 26). The caller passes the ACTUAL encashable
// balance (LeaveBalance.closing for encashable types). Returns { days, amountMinor }.
function computeLeaveEncashment(ctx) {
  const days = Number(ctx.encashableLeaveDays) || 0;
  if (days <= 0) return { days: 0, amountMinor: 0, perDayMinor: perDay26(ctx.basicDaMonthlyMinor) };
  const perDayMinor = perDay26(ctx.basicDaMonthlyMinor);
  // days may be fractional (Decimal(8,4)); keep the product exact then round.
  const amountMinor = Math.floor(perDayMinor * days + 0.5);
  return { days, amountMinor, perDayMinor };
}

// ── 3. Notice (recovery deduction OR employer pay-in-lieu earning) ───────────
// Employee-initiated short notice → recovery (deduction): shortfallDays × per-day
// pay. Employer-initiated separation served short → pay-in-lieu (EARNING) for the
// employer's unserved notice. `employerInitiated` flips the sign/direction; the
// caller derives it from SeparationType (RETRENCHMENT/REDUNDANCY/
// TERMINATION_FOR_CAUSE-without-cause/PROBATION_FAILURE/etc).
const EMPLOYER_INITIATED_TYPES = new Set([
  'RETRENCHMENT', 'REDUNDANCY', 'END_OF_CONTRACT', 'PROBATION_FAILURE', 'DEATH',
]);
function isEmployerInitiated(ctx) {
  if (typeof ctx.employerInitiated === 'boolean') return ctx.employerInitiated;
  return EMPLOYER_INITIATED_TYPES.has(ctx.separationType);
}
function computeNotice(ctx) {
  const shortfallDays = Math.max(0, Number(ctx.noticeShortfallDays) || 0);
  // Per-day pay for notice uses the monthly GROSS over the notice-day convention
  // (default 30) unless an explicit per-day amount is supplied.
  const perDayMinor = ctx.noticePerDayMinor != null
    ? int(ctx.noticePerDayMinor)
    : perDayMonth(ctx.grossMonthlyMinor, ctx.noticeDaysInMonth || 30);
  if (shortfallDays <= 0) {
    return { shortfallDays: 0, recoveryMinor: 0, payInLieuMinor: 0, perDayMinor };
  }
  const amountMinor = Math.floor(perDayMinor * shortfallDays + 0.5);
  if (isEmployerInitiated(ctx)) {
    // Employer owes pay-in-lieu of the notice it did not let the employee serve.
    return { shortfallDays, recoveryMinor: 0, payInLieuMinor: amountMinor, perDayMinor };
  }
  // Employee resigned short → recover the unserved notice (deduction).
  return { shortfallDays, recoveryMinor: amountMinor, payInLieuMinor: 0, perDayMinor };
}

// ── 4. NZ holiday payout ─────────────────────────────────────────────────────
// 8% of gross-since-anniversary (pre-entitlement / termination 8%, s28) PLUS the
// untaken annual-leave entitlement valued at the GREATER OF OWP and AWE (§9.5).
// Reuses compliance/holidaysAct.js. IN → 0 (gratuity path instead).
function computeNzHolidayPayout(ctx) {
  if (ctx.country !== 'NZ') return { amountMinor: 0, eightPctMinor: 0, untakenMinor: 0 };
  const nz = ctx.nz || {};

  // (a) 8% pre-entitlement on gross earnings since the last anniversary.
  const preEntitle = holidaysAct.valueLeave('ANNUAL_HOLIDAY_PRE_ENTITLE', {
    grossEarningsSinceAnchorMinor: int(nz.grossSinceAnniversaryMinor),
    advancesTakenMinor: int(nz.holidayAdvancesTakenMinor),
    ruleDate: nz.ruleDate,
  });
  const eightPctMinor = int(preEntitle.amountMinor);

  // (b) Untaken vested annual leave valued at max(OWP, AWE).
  let untakenMinor = 0;
  if ((Number(nz.untakenAnnualLeaveWeeks) || 0) > 0 || (Number(nz.untakenAnnualLeaveDays) || 0) > 0) {
    const vested = holidaysAct.valueLeave('ANNUAL_HOLIDAY_VESTED', {
      owp: nz.owp || {},
      awe: nz.awe || {},
      weeksTaken: Number(nz.untakenAnnualLeaveWeeks) || 0,
      daysTaken: Number(nz.untakenAnnualLeaveDays) || 0,
      workingDaysPerWeek: nz.workingDaysPerWeek || 5,
    });
    untakenMinor = int(vested.amountMinor);
  }
  return { amountMinor: eightPctMinor + untakenMinor, eightPctMinor, untakenMinor };
}

// ── 5. Recoveries (loan foreclosure + asset recovery) ────────────────────────
// loanForeclosureAmount = Σ outstanding on the employee's active loans.
// assetRecoveryAmount   = Σ AssetAssignment.recoveryAmount for un-returned /
//                         lost / damaged assets (the controller resolves these).
function computeRecoveries(ctx) {
  const loanForeclosureMinor = int(ctx.loanOutstandingMinor);
  const assetRecoveryMinor = int(ctx.assetRecoveryMinor);
  return { loanForeclosureMinor, assetRecoveryMinor };
}

/**
 * computeFnf(separationCase, ctx) -> {
 *   country, lines: { earnings[], deductions[] },
 *   snapshot: { gratuityAmountMinor, leaveEncashmentDays, leaveEncashmentAmountMinor,
 *               nzHolidayPayoutAmountMinor, noticeRecoveryAmountMinor,
 *               loanForeclosureAmountMinor, assetRecoveryAmountMinor, netSettlementMinor },
 *   payRunInput: { type:'FNF', currencyCode, earnings[], deductions[],
 *                  grossMinor, totalDeductionsMinor, netMinor },
 *   recoverableBalance: boolean,
 * }
 *
 * PURE. `separationCase` is read for its identifiers/type only; ALL the money
 * inputs live in `ctx` so the function is DB-free and unit-testable. The caller
 * persists `snapshot` onto the SeparationCase Decimal columns (minor → Decimal)
 * and feeds `payRunInput` to the payroll service to mint the PayRun(type=FNF).
 *
 * ctx = {
 *   country: 'IN' | 'NZ',
 *   currencyCode: 'INR' | 'NZD',
 *   separationType: SeparationType,           // drives employer-initiated + waivers
 *   employerInitiated?: boolean,              // override the type-derived default
 *   disablement?: boolean,                    // gratuity 5y-gate waiver (with DEATH)
 *   basicDaMonthlyMinor, grossMonthlyMinor,   // last-drawn pay (minor units)
 *   serviceYears, serviceMonths,              // completed service (gratuity rounding)
 *   encashableLeaveDays,                      // actual encashable LeaveBalance.closing
 *   noticeShortfallDays, noticePerDayMinor?,  // notice math inputs
 *   unpaidSalaryMinor?,                       // days-worked-to-LWD earning (optional)
 *   statutoryDeductionsMinor?,                // TDS/PAYE/etc on the FnF (optional)
 *   loanOutstandingMinor, assetRecoveryMinor, // recoveries
 *   nz: { grossSinceAnniversaryMinor, untakenAnnualLeaveWeeks/Days, owp, awe, ... }
 * }
 */
function computeFnf(separationCase, ctx = {}) {
  const sep = separationCase || {};
  const country = ctx.country === 'NZ' ? 'NZ' : 'IN';
  const currencyCode = ctx.currencyCode || (country === 'NZ' ? 'NZD' : 'INR');
  const c = { ...ctx, country, separationType: ctx.separationType || sep.type };

  // ── component computations ──
  const gratuity = computeGratuityLine(c);
  const leave = computeLeaveEncashment(c);
  const notice = computeNotice(c);
  const nzHoliday = computeNzHolidayPayout(c);
  const recoveries = computeRecoveries(c);

  // ── earnings (positive cash to the employee) ──
  const earnings = [];
  const unpaidSalaryMinor = int(c.unpaidSalaryMinor);
  if (unpaidSalaryMinor > 0) {
    earnings.push({ code: 'FNF_UNPAID_SALARY', label: 'Unpaid salary to last working day', amountMinor: unpaidSalaryMinor });
  }
  if (country === 'IN' && gratuity.amountMinor > 0) {
    earnings.push({ code: 'FNF_GRATUITY', label: 'Gratuity (Payment of Gratuity Act)', amountMinor: gratuity.amountMinor });
  }
  if (country === 'IN' && leave.amountMinor > 0) {
    earnings.push({ code: 'FNF_LEAVE_ENCASH', label: `Leave encashment (${leave.days} days)`, amountMinor: leave.amountMinor });
  }
  if (country === 'NZ' && nzHoliday.amountMinor > 0) {
    earnings.push({ code: 'FNF_NZ_HOLIDAY_PAYOUT', label: 'Holiday pay (8% + untaken annual leave)', amountMinor: nzHoliday.amountMinor });
  }
  if (notice.payInLieuMinor > 0) {
    earnings.push({ code: 'FNF_NOTICE_PAY_IN_LIEU', label: 'Notice pay in lieu (employer-initiated)', amountMinor: notice.payInLieuMinor });
  }

  // ── deductions (recovered FROM the employee) ──
  const deductions = [];
  if (notice.recoveryMinor > 0) {
    deductions.push({ code: 'FNF_NOTICE_RECOVERY', label: `Notice shortfall recovery (${notice.shortfallDays} days)`, amountMinor: notice.recoveryMinor });
  }
  if (recoveries.loanForeclosureMinor > 0) {
    deductions.push({ code: 'FNF_LOAN_FORECLOSURE', label: 'Loan foreclosure (outstanding)', amountMinor: recoveries.loanForeclosureMinor });
  }
  if (recoveries.assetRecoveryMinor > 0) {
    deductions.push({ code: 'FNF_ASSET_RECOVERY', label: 'Asset recovery (un-returned / damaged)', amountMinor: recoveries.assetRecoveryMinor });
  }
  const statutoryDeductionsMinor = int(c.statutoryDeductionsMinor);
  if (statutoryDeductionsMinor > 0) {
    deductions.push({ code: 'FNF_STATUTORY', label: 'Statutory deductions (TDS/PAYE)', amountMinor: statutoryDeductionsMinor });
  }

  const grossMinor = sumMinor(earnings);
  const totalDeductionsMinor = sumMinor(deductions);
  const netMinor = grossMinor - totalDeductionsMinor;

  const snapshot = {
    gratuityAmountMinor: country === 'IN' ? gratuity.amountMinor : 0,
    leaveEncashmentDays: country === 'IN' ? leave.days : 0,
    leaveEncashmentAmountMinor: country === 'IN' ? leave.amountMinor : 0,
    nzHolidayPayoutAmountMinor: country === 'NZ' ? nzHoliday.amountMinor : 0,
    noticeRecoveryAmountMinor: notice.recoveryMinor,
    noticePayInLieuMinor: notice.payInLieuMinor,
    loanForeclosureAmountMinor: recoveries.loanForeclosureMinor,
    assetRecoveryAmountMinor: recoveries.assetRecoveryMinor,
    netSettlementMinor: netMinor,
  };

  return {
    country,
    currencyCode,
    lines: { earnings, deductions },
    snapshot,
    breakdown: { gratuity, leave, notice, nzHoliday, recoveries },
    payRunInput: {
      type: 'FNF',
      currencyCode,
      earnings,
      deductions,
      grossMinor,
      totalDeductionsMinor,
      netMinor,
    },
    // Negative net = the employee owes the company (recoveries > earnings). The
    // FnF still produces a PayRun(type=FNF) (§7 QA14); HR surfaces the balance.
    recoverableBalance: netMinor < 0,
  };
}

module.exports = {
  computeFnf,
  // exported for unit-testing each pillar in isolation (integer-minor semantics)
  _internals: {
    computeGratuityLine,
    computeLeaveEncashment,
    computeNotice,
    computeNzHolidayPayout,
    computeRecoveries,
    perDay26,
    perDayMonth,
    isEmployerInitiated,
    EMPLOYER_INITIATED_TYPES,
  },
};

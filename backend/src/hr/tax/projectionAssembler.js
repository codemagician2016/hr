'use strict';

/**
 * projectionAssembler.js — Feature 15. The READ-ONLY assembler that builds an
 * India employee's annual income-tax projection (the Figma "IT computation"
 * statement). IMPURE only in that it LOADS rows (comp + published payslips +
 * declaration); the ONLY math it does is calling the PURE engine in
 * ../payroll/compliance/india.js. Tenant-scoped (every query carries businessId);
 * never writes (computes on every read so it can never go stale).
 *
 * Reuse-first (spec §2/§5): resolveCurrentCompensation (authoritative current
 * package), published Payslip YTD actuals (the real TDS already deducted), the
 * StatutoryProfile declaration (regime + 80C/HRA/perq/prev-employer), and the
 * pure projectAnnualIncomeTax + monthlyTaxRecoverable. The number it prints for
 * "this month's TDS" reconciles to the paise with the live run's TDS line (the
 * golden parity test asserts this).
 *
 * India-only: the controller country-gates before calling. The assembler also
 * fail-closes on country (throws COUNTRY_UNSUPPORTED) so it can never compute a
 * non-IN statement.
 */

const prisma = require('../../core/lib/prisma');
const IN = require('../payroll/compliance/india.js');
const money = require('../payroll/money');
const payrollService = require('../payroll/service');
const { resolveStatutoryCountry } = require('../lib/resolveStatutoryCountry');

const {
  projectAnnualIncomeTax,
  monthlyTaxRecoverable,
} = IN._internals;

// Decimal|string|number → integer paise (annual amounts come in as rupees).
function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// paise → major-unit rupee number for the API/PDF edge.
function toRupees(minor) {
  return Math.round(minor) / 100;
}

// ISO 'YYYY-MM-DD' today (UTC) when no asOf is supplied.
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// 'YYYY-MM' of a date string.
function ymOf(iso) {
  return String(iso).slice(0, 7);
}

/**
 * Bucket a CompensationRevision's resolved lines into the projection's annual
 * earnings spine. Mirrors deriveBreakup's BASIC/DA classification and the
 * BALANCING (residual choice pay) identification — read-only, reuse-aligned.
 *
 * Returns { basicDaMinor, hraReceivedMinor, otherAllowancesMinor,
 *           residualChoicePayMinor } in ANNUAL paise.
 */
function bucketAnnualEarnings(compensation) {
  let basicDaMinor = 0;
  let hraReceivedMinor = 0;
  let otherAllowancesMinor = 0;
  let residualChoicePayMinor = 0;

  const lines = (compensation && compensation.lines) || [];
  for (const line of lines) {
    const comp = line.component || {};
    // Earnings only (EARNING category) feed taxable salary; deductions/employer
    // cost lines never inflate gross. Category lives on the component master.
    if (comp.category && comp.category !== 'EARNING') continue;

    // Prefer the resolved annual snapshot; fall back to monthly × 12.
    const annualMinor = line.amountAnnual != null
      ? rupeesToMinor(line.amountAnnual)
      : rupeesToMinor(line.amountMonthly) * 12;
    if (annualMinor <= 0) continue;

    const isBalancing =
      (line.calcMethod || comp.calcMethod) === 'BALANCING';

    if (comp.kind === 'BASIC' || comp.kind === 'DEARNESS_ALLOWANCE') {
      basicDaMinor += annualMinor;
    } else if (comp.kind === 'HRA') {
      hraReceivedMinor += annualMinor;
    } else if (isBalancing) {
      residualChoicePayMinor += annualMinor;
    } else {
      otherAllowancesMinor += annualMinor;
    }
  }

  return { basicDaMinor, hraReceivedMinor, otherAllowancesMinor, residualChoicePayMinor };
}

/**
 * YTD actuals from this FY's PUBLISHED|VIEWED payslips: Σ TDS deduction line +
 * Σ taxable gross. Reads Payslip.snapshotJson.employeeDeductions / earnings — the
 * frozen per-component data. taxYear gates the FY window.
 */
async function loadYtdActuals({ businessId, employeeId, taxYear, fyStartIso, fyEndIso, db }) {
  const payslips = await db.payslip.findMany({
    where: {
      businessId,
      employeeId,
      deletedAt: null,
      status: { in: ['PUBLISHED', 'VIEWED'] },
      periodEnd: { gte: new Date(fyStartIso), lte: new Date(fyEndIso) },
    },
    select: { snapshotJson: true, periodEnd: true, payDate: true },
    orderBy: { periodEnd: 'asc' },
  });

  let tdsDeductedThisFYMinor = 0;
  let ytdTaxableMinor = 0;
  const months = new Set();

  for (const ps of payslips) {
    const snap = ps.snapshotJson || {};
    const deductions = Array.isArray(snap.employeeDeductions) ? snap.employeeDeductions : [];
    for (const d of deductions) {
      if (d && d.code === 'TDS') tdsDeductedThisFYMinor += rupeesToMinor(d.amount);
    }
    const earnings = Array.isArray(snap.earnings) ? snap.earnings : [];
    for (const e of earnings) ytdTaxableMinor += rupeesToMinor(e.amount);
    months.add(ymOf(typeof ps.periodEnd === 'string' ? ps.periodEnd : ps.periodEnd.toISOString()));
  }

  return {
    tdsDeductedThisFYMinor,
    ytdTaxableMinor,
    monthsElapsed: months.size,
  };
}

/**
 * Read the employee's StatutoryProfile declaration into the engine input bag.
 * Under NEW regime exemptions/deductions are structurally skipped by the engine;
 * we still load the raw fields so the page can show "declared but ignored".
 */
function readDeclaration(sp) {
  const regime = sp && sp.taxRegime ? String(sp.taxRegime).toUpperCase() : 'NEW';
  return {
    regime: regime === 'OLD' ? 'OLD' : 'NEW',
    hasPan: !!(sp && sp.pan),
    sec80cGrossMinor: rupeesToMinor(sp && sp.section80CDeclared),
    sec80dGrossMinor: rupeesToMinor(sp && sp.sec80DDeclared),
    sec80ccd1bGrossMinor: rupeesToMinor(sp && sp.sec80CCD1BDeclared),
    sec80ttaGrossMinor: rupeesToMinor(sp && sp.sec80TTADeclared),
    sec24bGrossMinor: rupeesToMinor(sp && sp.sec24BHomeLoanInterest),
    hraRentPaidMinor: rupeesToMinor(sp && sp.hraAnnualRentPaid),
    hraMetro: !!(sp && sp.hraMetroCity),
    perq: {
      accom: sp && sp.perqRentFreeAccom
        ? {
            provided: true,
            leased: !!(sp && sp.perqAccomIsLeased),
            cityPopBand: (sp && sp.perqAccomCityPopBand) || '>40L',
            leaseRentAnnualMinor: rupeesToMinor(sp && sp.perqAccomLeaseRentPaid),
          }
        : null,
      loan: sp && sp.perqConcessionalLoanBal != null && Number(sp.perqConcessionalLoanBal) > 0
        ? {
            avgOutstandingAnnualMinor: rupeesToMinor(sp && sp.perqConcessionalLoanBal),
            rateChargedPct: sp && sp.perqLoanRateChargedPct != null ? Number(sp.perqLoanRateChargedPct) : 0,
          }
        : null,
    },
    prevEmployerFY: (sp && sp.prevEmployerFY) || null,
    prevEmployerTaxableIncomeMinor: rupeesToMinor(sp && sp.prevEmployerTaxableIncome),
    prevEmployerTdsMinor: rupeesToMinor(sp && sp.prevEmployerTdsDeducted),
  };
}

// Build the engine input for a chosen regime from earnings + declaration.
function buildEngineInput({ regime, annualEarnings, decl, prevEmployerCounted }) {
  const isOld = regime === 'OLD';
  return {
    regime,
    annualEarnings: {
      basicDaMinor: annualEarnings.basicDaMinor,
      hraReceivedMinor: annualEarnings.hraReceivedMinor,
      otherAllowancesMinor: annualEarnings.otherAllowancesMinor,
      residualChoicePayMinor: annualEarnings.residualChoicePayMinor,
    },
    perquisitesInput: decl.perq,
    hraInput: isOld
      ? {
          hraReceivedAnnualMinor: annualEarnings.hraReceivedMinor,
          rentPaidAnnualMinor: decl.hraRentPaidMinor,
          metro: decl.hraMetro,
        }
      : null,
    chapterVIAInput: isOld
      ? {
          sec80cGrossMinor: decl.sec80cGrossMinor,
          sec80dGrossMinor: decl.sec80dGrossMinor,
          sec80ccd1bGrossMinor: decl.sec80ccd1bGrossMinor,
          sec80ttaGrossMinor: decl.sec80ttaGrossMinor,
          sec24bGrossMinor: decl.sec24bGrossMinor,
        }
      : null,
    prevEmployer: {
      taxableIncomeMinor: prevEmployerCounted ? decl.prevEmployerTaxableIncomeMinor : 0,
    },
    hasPan: decl.hasPan,
  };
}

// Map the pure chapterVIA result (paise) → rupee statement lines.
function chapterVIAToStatement(chap) {
  if (!chap) return null;
  return {
    lines: chap.lines.map((l) => ({
      section: l.section,
      label: l.label,
      gross: toRupees(l.grossMinor),
      qualifying: toRupees(l.qualifyingMinor),
      deductible: toRupees(l.deductibleMinor),
    })),
    maxQualifying: toRupees(chap.maxQualifyingMinor),
    totalDeductible: toRupees(chap.totalDeductibleMinor),
  };
}

/**
 * buildTaxProjection — the public entry. Tenant-scoped, India-only, read-only.
 *
 * @param {{ businessId, employeeId, asOf?, db? }} args
 * @returns the statement object (§5.1) with all amounts in major-unit rupees.
 */
async function buildTaxProjection({ businessId, employeeId, asOf, db = prisma } = {}) {
  if (!businessId || !employeeId) {
    const e = new Error('businessId and employeeId are required');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  const asOfIso = asOf ? String(asOf).slice(0, 10) : todayIso();

  // 1. Country gate (fail-closed). Resolve the subject employee minimal shape.
  const emp = await db.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, code: true, firstName: true, middleName: true, lastName: true, countryCode: true, isActive: true },
  });
  if (!emp) {
    const e = new Error('Employee not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const country = await resolveStatutoryCountry(businessId, emp, db);
  if (country !== 'IN') {
    const e = new Error('Tax projection is available for India only');
    e.code = 'COUNTRY_UNSUPPORTED';
    e.country = country;
    throw e;
  }

  // 2. FY window (Apr–Mar). taxYear "2026-27"; fyStart 1-Apr; fyEnd 31-Mar.
  const taxYear = payrollService._internal.taxYearFor(asOfIso, 4);
  const startYear = Number(taxYear.slice(0, 4));
  const fyStartIso = `${startYear}-04-01`;
  const fyEndIso = `${startYear + 1}-03-31`;

  // 3. Annual earnings spine from the current compensation revision.
  const compensation = await payrollService._internal.resolveCurrentCompensation(
    businessId, employeeId, asOfIso, db,
  );
  const annualEarnings = compensation
    ? bucketAnnualEarnings(compensation)
    : { basicDaMinor: 0, hraReceivedMinor: 0, otherAllowancesMinor: 0, residualChoicePayMinor: 0 };
  const hasComp = !!compensation;

  // 4. YTD actuals from published payslips.
  const ytd = await loadYtdActuals({ businessId, employeeId, taxYear, fyStartIso, fyEndIso, db });
  const monthsElapsed = Math.min(12, ytd.monthsElapsed);
  const monthsRemaining = Math.max(1, 12 - monthsElapsed);

  // 5. Declaration.
  const sp = await db.statutoryProfile.findFirst({ where: { businessId, employeeId } });
  const decl = readDeclaration(sp);

  // Previous-employer counted ONLY when its declared FY equals the current FY.
  const prevEmployerCounted = decl.prevEmployerFY === taxYear;
  const prevEmployerTdsMinor = prevEmployerCounted ? decl.prevEmployerTdsMinor : 0;

  // 6/7. Compute the ELECTED regime + the OTHER regime (for the comparison line).
  const electedRegime = decl.regime;
  const otherRegime = electedRegime === 'OLD' ? 'NEW' : 'OLD';

  const electedResult = projectAnnualIncomeTax(
    buildEngineInput({ regime: electedRegime, annualEarnings, decl, prevEmployerCounted }),
  );
  const otherResult = projectAnnualIncomeTax(
    buildEngineInput({ regime: otherRegime, annualEarnings, decl, prevEmployerCounted }),
  );

  // 8. Monthly recoverable schedule (last month absorbs the residual).
  const firstRemainingMonth = (() => {
    // First remaining month = month after the last paid month, else FY start.
    const startMonth = ymOf(fyStartIso);
    if (monthsElapsed <= 0) return startMonth;
    const [y, m] = startMonth.split('-').map(Number);
    const total = y * 12 + (m - 1) + monthsElapsed;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  })();

  const sched = monthlyTaxRecoverable({
    totalAnnualTaxMinor: electedResult.totalAnnualTaxMinor,
    tdsDeductedThisFYMinor: ytd.tdsDeductedThisFYMinor,
    prevEmployerTdsMinor,
    monthsRemaining,
    startMonth: firstRemainingMonth,
  });

  // 9. 80C investments table (DERIVED from payslips vs DECLARED). PF is derived
  // from the employer-cost EPF the structure carries; the declared 80C umbrella
  // is the employee figure. We surface a small, honest table.
  const investments80C = [];
  // Derived PF: 12% of (Basic+DA capped at ₹15,000/mo) × 12 — the employee EPF
  // that auto-counts toward 80C. Read from the compensation employer block if
  // present; else approximate from Basic+DA.
  const pfAnnualMinor = derivePfAnnualMinor(annualEarnings.basicDaMinor);
  if (pfAnnualMinor > 0) {
    investments80C.push({ code: 'PF', label: 'Provident Fund (auto, from payslips)', amount: toRupees(pfAnnualMinor), source: 'DERIVED' });
  }
  if (decl.sec80cGrossMinor > 0) {
    const declared80cOver = Math.max(0, decl.sec80cGrossMinor - pfAnnualMinor);
    investments80C.push({ code: 'C80', label: '80C investments (declared)', amount: toRupees(decl.sec80cGrossMinor), source: 'DECLARED' });
    if (declared80cOver === 0) { /* fully covered */ }
  }

  // Anomalies surfaced on the statement.
  const anomalies = [];
  if (!decl.hasPan) {
    anomalies.push({ code: 'MISSING_PAN', severity: 'WARN', message: 'No PAN on record; tax is applied at 20% u/s 206AA. Add your PAN with HR to be taxed at slab rates.' });
  }
  if (!hasComp) {
    anomalies.push({ code: 'NO_COMPENSATION', severity: 'INFO', message: "We'll show your full projection once your salary structure is set up." });
  }

  const electedTotalRupees = toRupees(electedResult.totalAnnualTaxMinor);
  const otherTotalRupees = toRupees(otherResult.totalAnnualTaxMinor);
  const betterRegime = electedResult.totalAnnualTaxMinor <= otherResult.totalAnnualTaxMinor
    ? electedRegime
    : otherRegime;

  return {
    employeeId,
    employeeName: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' ') || emp.code,
    employeeCode: emp.code || null,
    taxYear,
    asOf: asOfIso,
    regime: electedRegime,
    currencyCode: 'INR',

    annualEarnings: {
      basicDa: toRupees(annualEarnings.basicDaMinor),
      hra: toRupees(annualEarnings.hraReceivedMinor),
      otherAllowances: toRupees(annualEarnings.otherAllowancesMinor),
      residualChoicePay: toRupees(annualEarnings.residualChoicePayMinor),
      grossSalary: toRupees(electedResult.grossSalaryMinor),
    },

    hraExemption: electedRegime === 'OLD' && electedResult.hra
      ? {
          exempt: toRupees(electedResult.hraExemptionMinor),
          leastLeg: electedResult.hra.leastLeg,
          legs: {
            received: toRupees(electedResult.hra.legs.received),
            rentMinus10: toRupees(electedResult.hra.legs.rentMinus10),
            pctOfSalary: toRupees(electedResult.hra.legs.pctOfSalary),
          },
        }
      : null,

    grossEarningAfterExemption: toRupees(electedResult.grossAfterExemptMinor),

    perquisites: electedResult.perquisites && electedResult.perquisites.lines.length
      ? {
          total: toRupees(electedResult.perquisites.totalMinor),
          lines: electedResult.perquisites.lines.map((l) => ({
            kind: l.kind, label: l.label, amount: toRupees(l.amountMinor), explain: l.explain,
          })),
        }
      : { total: 0, lines: [] },

    chapterVIA: electedRegime === 'OLD' ? chapterVIAToStatement(electedResult.chapterVIA) : null,

    standardDeduction: toRupees(electedResult.standardDeductionMinor),
    totalTaxableIncome: toRupees(electedResult.taxableIncomeMinor),

    taxPayable: toRupees(electedResult.taxPayableMinor),
    surcharge: toRupees(electedResult.surchargeMinor),
    cess: toRupees(electedResult.cessMinor),
    totalTax: electedTotalRupees,

    tdsDeductedThisFY: toRupees(ytd.tdsDeductedThisFYMinor),
    previousEmployerTds: toRupees(prevEmployerTdsMinor),
    previousEmployerTaxableIncome: prevEmployerCounted ? toRupees(decl.prevEmployerTaxableIncomeMinor) : 0,
    previousEmployerCounted: prevEmployerCounted,

    remainingTax: toRupees(sched.remainingTaxMinor),
    monthsElapsed,
    monthsRemaining,
    monthlyRecoverable: toRupees(sched.monthlyRecoverableMinor),
    schedule: sched.schedule.map((s) => ({ month: s.month, amount: toRupees(s.amountMinor) })),

    regimeComparison: {
      elected: electedRegime,
      electedTotalTax: electedTotalRupees,
      alternativeRegime: otherRegime,
      alternativeTotalTax: otherTotalRupees,
      betterRegime,
    },

    investments80C,
    noPanApplied: !!electedResult.noPanApplied,
    notes: [
      'Figures are projected from your current salary and declaration. Final tax is computed at year-end (Form 16).',
      'This is a projection, not a Form 16.',
    ],
    anomalies,
  };
}

/**
 * Lightweight regime comparison (for the declaration page's "which regime?"
 * helper). Reuses the full assembler then strips to the totals.
 */
async function buildRegimeComparison({ businessId, employeeId, asOf, db = prisma } = {}) {
  const stmt = await buildTaxProjection({ businessId, employeeId, asOf, db });
  return {
    elected: stmt.regimeComparison.elected,
    electedTotalTax: stmt.regimeComparison.electedTotalTax,
    NEW: { totalTax: stmt.regime === 'NEW' ? stmt.totalTax : stmt.regimeComparison.alternativeTotalTax },
    OLD: { totalTax: stmt.regime === 'OLD' ? stmt.totalTax : stmt.regimeComparison.alternativeTotalTax },
    betterRegime: stmt.regimeComparison.betterRegime,
    taxYear: stmt.taxYear,
  };
}

// Derive the employee's auto-80C PF: EE 12% of min(Basic+DA monthly, ₹15,000) × 12.
function derivePfAnnualMinor(basicDaAnnualMinor) {
  if (basicDaAnnualMinor <= 0) return 0;
  const monthlyBasicDa = basicDaAnnualMinor / 12;
  const ceiling = 15000 * 100; // ₹15,000 monthly in paise
  const pfWage = Math.min(monthlyBasicDa, ceiling);
  const monthlyPf = Math.round((pfWage * 12) / 100); // 12% nearest paise
  return monthlyPf * 12;
}

module.exports = { buildTaxProjection, buildRegimeComparison, _internals: { bucketAnnualEarnings, readDeclaration, derivePfAnnualMinor } };

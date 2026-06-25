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
// Feature 20 — the window-aware DECLARED→VERIFIED switch. readDeclaration consumes
// these to flip TDS to verified-only on/after the proof deadline (the §201 control).
const { resolveWindow } = require('./investmentProof/windowResolver');
const { amountForSection, shouldUseVerified } = require('./investmentProof/proofAggregator');
const { CLAIM_TYPE_META } = require('./investmentProof/claimTypes');
// Feature 25 — the FBP / Flexi Basket exemption. The SINGLE subtraction below
// (otherAllowancesMinor -= fbp.totalExemptMinor) carries the OLD-regime FBP relief
// into BOTH the monthly TDS run and the ESS projection atomically (both reconcile
// through buildTaxProjection). NEW-regime returns 0 (the basket pays but is taxable).
const { resolveFbpExempt } = require('./fbp/fbpProjection');

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
 *
 * Feature 20 — THE TDS SWITCH. `ctx = { window, proofs, asOf, pfAnnualMinor }` makes
 * this window-aware: BEFORE the proofDeadline → DECLARED (provisional, today's
 * behaviour); ON/AFTER → ONLY the HR-VERIFIED amount per claim = min(declared, Σ
 * ACCEPTED), then the existing 80C ₹1.5L / 24b ₹2L caps in chapterVIADeductions. No
 * window → fail-open-provisional (DECLARED). PF auto-80C (derived from our payslips)
 * is always "verified" — passed as the SEC_80C floor so it never drops out for want of
 * an upload. `proofBasis` + per-line `{declared,verified,used,basis}` are exposed for
 * the statement annotations. Backward-compatible: called with no ctx → DECLARED.
 */
function readDeclaration(sp, ctx = {}) {
  const regime = sp && sp.taxRegime ? String(sp.taxRegime).toUpperCase() : 'NEW';
  const window = ctx.window || null;
  const proofs = Array.isArray(ctx.proofs) ? ctx.proofs : [];
  const asOf = ctx.asOf || todayIso();
  const pfAnnualMinor = Math.max(0, Math.round(ctx.pfAnnualMinor || 0));
  const useVerified = shouldUseVerified(window, asOf);

  // Resolve one section's amount via the pure aggregator. Records the per-line basis.
  const lineBasis = {};
  function amountFor(claimType, declaredColumn, alwaysVerifiedMinor = 0) {
    const declaredMinor = rupeesToMinor(declaredColumn);
    const r = amountForSection({ declaredMinor, proofs, claimType, useVerified, alwaysVerifiedMinor });
    lineBasis[claimType] = {
      declared: toRupees(r.declaredMinor),
      verified: toRupees(r.verifiedMinor),
      used: toRupees(r.usedMinor),
      basis: r.basis,
    };
    return r.usedMinor;
  }

  return {
    regime: regime === 'OLD' ? 'OLD' : 'NEW',
    hasPan: !!(sp && sp.pan),
    sec80cGrossMinor: amountFor('SEC_80C', sp && sp.section80CDeclared, pfAnnualMinor),
    sec80dGrossMinor: amountFor('SEC_80D', sp && sp.sec80DDeclared),
    sec80ccd1bGrossMinor: amountFor('SEC_80CCD1B', sp && sp.sec80CCD1BDeclared),
    sec80ttaGrossMinor: amountFor('SEC_80TTA', sp && sp.sec80TTADeclared),
    sec24bGrossMinor: amountFor('SEC_24B_HOME_LOAN', sp && sp.sec24BHomeLoanInterest),
    hraRentPaidMinor: amountFor('HRA_RENT', sp && sp.hraAnnualRentPaid),
    hraMetro: !!(sp && sp.hraMetroCity),
    // Feature 20 — surfaced for the statement annotations (slice 20d).
    proofBasis: useVerified ? 'VERIFIED' : 'DECLARED',
    proofLines: lineBasis,
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
// Feature 25 — `fbpExemptMinor` (paise) is the regime-appropriate FBP-exempt total
// (0 under NEW). It is subtracted from otherAllowancesMinor HERE — the single seam
// (spec §6 Seam B): projectAnnualIncomeTax adds otherAllowancesMinor to gross, so
// subtracting the exempt basket reduces taxable income by exactly Σ exempt. No change
// to india.js math. Done inside the fresh copy so each regime gets its own subtraction.
function buildEngineInput({ regime, annualEarnings, decl, prevEmployerCounted, fbpExemptMinor = 0 }) {
  const isOld = regime === 'OLD';
  return {
    regime,
    annualEarnings: {
      basicDaMinor: annualEarnings.basicDaMinor,
      hraReceivedMinor: annualEarnings.hraReceivedMinor,
      otherAllowancesMinor: Math.max(0, annualEarnings.otherAllowancesMinor - Math.max(0, Math.round(fbpExemptMinor || 0))),
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

  // 5. Declaration + Feature 20 TDS switch (window-aware DECLARED→VERIFIED).
  const sp = await db.statutoryProfile.findFirst({ where: { businessId, employeeId } });
  // Load the FY window + this employee's ACCEPTED proofs (the verified truth). No
  // window → fail-open-provisional (resolveWindow returns null). PF auto-80C is
  // derived from our own payslips and is always "verified" — passed as the SEC_80C
  // floor so it never drops out for want of an upload (edge case 5).
  const window = await resolveWindow({ businessId, financialYear: taxYear, db });
  const acceptedProofs = window
    ? await db.investmentProof.findMany({
        where: { businessId, employeeId, financialYear: taxYear, deletedAt: null, status: 'ACCEPTED' },
        select: { claimType: true, verifiedAmount: true, status: true, deletedAt: true },
      })
    : [];
  const pfAnnualMinor = derivePfAnnualMinor(annualEarnings.basicDaMinor);
  const decl = readDeclaration(sp, { window, proofs: acceptedProofs, asOf: asOfIso, pfAnnualMinor });

  // Previous-employer counted ONLY when its declared FY equals the current FY.
  const prevEmployerCounted = decl.prevEmployerFY === taxYear;
  const prevEmployerTdsMinor = prevEmployerCounted ? decl.prevEmployerTdsMinor : 0;

  // 6/7. Compute the ELECTED regime + the OTHER regime (for the comparison line).
  const electedRegime = decl.regime;
  const otherRegime = electedRegime === 'OLD' ? 'NEW' : 'OLD';

  // Feature 25 — the FBP / Flexi Basket exemption (OLD-regime only). Resolved
  // per-regime (the OTHER-regime comparison line needs its own value: NEW → 0) and
  // subtracted from otherAllowancesMinor inside buildEngineInput. Date-authoritative
  // declared→verified flip (asOf >= the FBP window's proofDeadline) lives in the pure
  // aggregator, so correctness never depends on the cron firing.
  const fbpElected = await resolveFbpExempt({
    businessId, employeeId, financialYear: taxYear, asOf: asOfIso, regime: electedRegime, db,
  });
  const fbpOther = await resolveFbpExempt({
    businessId, employeeId, financialYear: taxYear, asOf: asOfIso, regime: otherRegime, db,
  });

  const electedResult = projectAnnualIncomeTax(
    buildEngineInput({ regime: electedRegime, annualEarnings, decl, prevEmployerCounted, fbpExemptMinor: fbpElected.totalExemptMinor }),
  );
  const otherResult = projectAnnualIncomeTax(
    buildEngineInput({ regime: otherRegime, annualEarnings, decl, prevEmployerCounted, fbpExemptMinor: fbpOther.totalExemptMinor }),
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
  // that auto-counts toward 80C (computed above for the SEC_80C verified-floor).
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
  // Feature 20 — verified<declared after the deadline. The unverified portion silently
  // → ₹0 for TDS; surface it LOUDLY (the §201 protection working as intended). Only
  // under OLD regime + on/after the deadline (when VERIFIED actually drives TDS).
  if (electedRegime === 'OLD' && decl.proofBasis === 'VERIFIED') {
    let unverifiedMinor = 0;
    const sections = [];
    for (const [claimType, line] of Object.entries(decl.proofLines || {})) {
      if (!CLAIM_TYPE_META[claimType] || !CLAIM_TYPE_META[claimType].engineConsumed) continue;
      const gap = rupeesToMinor(line.declared) - rupeesToMinor(line.used);
      if (gap > 0) { unverifiedMinor += gap; sections.push(CLAIM_TYPE_META[claimType].label); }
    }
    if (unverifiedMinor > 0) {
      anomalies.push({
        code: 'UNVERIFIED_DECLARATION',
        severity: 'WARN',
        message: `₹${toRupees(unverifiedMinor).toLocaleString('en-IN')} of declared deductions is unverified and excluded from TDS (${sections.join(', ')}). Upload/verify proof before March or your TDS stays higher.`,
      });
    }
  }
  // Feature 25 — the FBP unverified anomaly (the same §192(2D)/§201 control for the
  // bill-backed basket heads). Only OLD-regime + on/after the FBP deadline.
  if (electedRegime === 'OLD' && fbpElected.hasAllocation && fbpElected.basis === 'VERIFIED') {
    let fbpUnverifiedMinor = 0;
    const fbpSections = [];
    for (const line of fbpElected.lines || []) {
      if (line.unverifiedMinor > 0) { fbpUnverifiedMinor += line.unverifiedMinor; fbpSections.push(line.label); }
    }
    if (fbpUnverifiedMinor > 0) {
      anomalies.push({
        code: 'FBP_UNVERIFIED',
        severity: 'WARN',
        message: `₹${toRupees(fbpUnverifiedMinor).toLocaleString('en-IN')} of your declared flexi benefits is unverified and excluded — upload bills (${fbpSections.join(', ')}) or your March TDS stays higher.`,
      });
    }
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

    // Feature 25 — the FBP / Flexi Basket exemption block. `totalExempt` is the
    // "Less: FBP exemptions ₹…" line on the IT computation; `basis` drives the
    // F20-style "using declared (provisional)" → "using verified" badge after the
    // deadline. Under NEW the exemption is structurally 0 (the basket pays, taxed).
    fbp: fbpElected.hasAllocation
      ? {
          totalExempt: toRupees(fbpElected.totalExemptMinor),
          basis: fbpElected.basis,
          regimeGated: electedRegime !== 'OLD',
          lines: (fbpElected.lines || []).map((l) => ({
            headType: l.headType,
            label: l.label,
            taxSection: l.taxSection,
            allocated: toRupees(l.allocatedMinor),
            cap: l.capMinor == null ? null : toRupees(l.capMinor),
            verified: toRupees(l.verifiedMinor),
            exempt: toRupees(l.exemptMinor),
            unverified: toRupees(l.unverifiedMinor),
            basis: l.basis,
            proofRequired: l.proofRequired,
          })),
        }
      : null,

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

    // Feature 20 — the proof-basis the projection used: DECLARED (provisional, before
    // the deadline) or VERIFIED (on/after, min(declared, Σaccepted)). Per-line
    // {declared, verified, used, basis} drives the ESS "using declared/verified" badge.
    proofBasis: decl.proofBasis,
    proofWindow: window ? {
      financialYear: window.financialYear, status: window.status,
      proofDeadline: window.proofDeadline, opensAt: window.opensAt, closesAt: window.closesAt,
    } : null,
    proofLines: electedRegime === 'OLD' ? decl.proofLines : {},

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

/**
 * resolveRunTaxOverride — Feature 25 (FBP) / Feature 15 reconciliation. The LIVE
 * monthly TDS run (payroll/service → engine → india.compute → computeTds) must
 * deduct the SAME tax the ESS projection (buildTaxProjection) promises. Without
 * this, the run annualises the FULL taxable gross (FBP head lines included, all
 * isTaxable) and over-withholds, while the projection subtracts the FBP exemption —
 * the two surfaces diverge and the employee is over-deducted every month until the
 * Form-16 true-up.
 *
 * This returns the elected regime's paise-precise ANNUAL TAXABLE income and the
 * projected annual GROSS, computed through the EXACT SAME pure path the projection
 * uses (resolveFbpExempt → computeFbpExempt → buildEngineInput → projectAnnualIncomeTax),
 * so handing them to computeTds as { annualTaxableOverrideMinor, annualProjectionOverrideMinor }
 * makes run TDS === projection TDS to the paise. It is a STRICT SUBSET of
 * buildTaxProjection's elected-regime computation (no rupee rounding, no statement
 * assembly), so the single computeFbpExempt source is preserved.
 *
 * Returns null when there's no compensation or the projection would not apply an FBP
 * exemption (electedRegime !== OLD, or no allocation) — in that case the run keeps its
 * existing behaviour (golden parity for non-FBP / NEW-regime employees is untouched).
 *
 * @returns {{ annualTaxableOverrideMinor:number, annualProjectionOverrideMinor:number,
 *   regime:'OLD', fbpExemptMinor:number } | null}
 */
async function resolveRunTaxOverride({ businessId, employeeId, asOf, db = prisma } = {}) {
  if (!businessId || !employeeId) return null;
  const asOfIso = asOf ? String(asOf).slice(0, 10) : todayIso();

  // Country gate — FBP/OLD-regime projection is India-only. Fail-safe to null
  // (the run keeps its default §192 annualisation) if anything is missing.
  const emp = await db.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, countryCode: true },
  });
  if (!emp) return null;
  const country = await resolveStatutoryCountry(businessId, emp, db);
  if (country !== 'IN') return null;

  const taxYear = payrollService._internal.taxYearFor(asOfIso, 4);

  // The EFFECTIVE regime drives the elected/default regime. The FBP exemption (and
  // therefore any run/projection divergence) exists ONLY under OLD — NEW exempts ₹0, so
  // the run's default full-gross annualisation already equals the projection. Skip
  // (return null) for NEW so non-OLD employees are byte-identical to today.
  // Feature 15/25 — an UN-ELECTED employee resolves to the employer default
  // (TaxRegimePolicy.defaultRegime) here too, so the run override matches the same
  // effective regime the withholding stamps (consistency for a default-OLD tenant).
  const sp = await db.statutoryProfile.findFirst({ where: { businessId, employeeId } });
  // eslint-disable-next-line global-require
  const regimeService = require('./regime/regime.service');
  const { regime: elected } = await regimeService.getEffectiveRegime({
    businessId, employeeId, fy: taxYear, sp, db,
  });
  if (elected !== 'OLD') return null;

  // The current FBP exemption (the SINGLE computeFbpExempt source). No allocation →
  // nothing to reconcile; let the run behave as before.
  const fbp = await resolveFbpExempt({
    businessId, employeeId, financialYear: taxYear, asOf: asOfIso, regime: 'OLD', db,
  });
  if (!fbp.hasAllocation || fbp.totalExemptMinor <= 0) return null;

  // Earnings spine + declaration — identical to buildTaxProjection steps 3/5.
  const compensation = await payrollService._internal.resolveCurrentCompensation(
    businessId, employeeId, asOfIso, db,
  );
  if (!compensation) return null;
  const annualEarnings = bucketAnnualEarnings(compensation);

  const startYear = Number(taxYear.slice(0, 4));
  const fyStartIso = `${startYear}-04-01`;
  const fyEndIso = `${startYear + 1}-03-31`;
  const window = await resolveWindow({ businessId, financialYear: taxYear, db });
  const acceptedProofs = window
    ? await db.investmentProof.findMany({
        where: { businessId, employeeId, financialYear: taxYear, deletedAt: null, status: 'ACCEPTED' },
        select: { claimType: true, verifiedAmount: true, status: true, deletedAt: true },
      })
    : [];
  const pfAnnualMinor = derivePfAnnualMinor(annualEarnings.basicDaMinor);
  const decl = readDeclaration(sp, { window, proofs: acceptedProofs, asOf: asOfIso, pfAnnualMinor });
  const prevEmployerCounted = decl.prevEmployerFY === taxYear;

  // The SAME engine input the projection builds (FBP exemption subtracted in
  // buildEngineInput), through the SAME pure projectAnnualIncomeTax.
  const result = projectAnnualIncomeTax(
    buildEngineInput({ regime: 'OLD', annualEarnings, decl, prevEmployerCounted, fbpExemptMinor: fbp.totalExemptMinor }),
  );

  // The projected annual GROSS for the run = grossSalary (pre-exemption Σ earnings).
  // computeTds uses annualTaxableOverrideMinor verbatim (no further std deduction), so
  // the annualProjectionOverrideMinor is informational/consistent but the taxable
  // override is what makes the deduction reconcile.
  return {
    regime: 'OLD',
    fbpExemptMinor: fbp.totalExemptMinor,
    annualTaxableOverrideMinor: result.taxableIncomeMinor,
    annualProjectionOverrideMinor: result.grossSalaryMinor,
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

module.exports = { buildTaxProjection, buildRegimeComparison, resolveRunTaxOverride, _internals: { bucketAnnualEarnings, readDeclaration, derivePfAnnualMinor } };

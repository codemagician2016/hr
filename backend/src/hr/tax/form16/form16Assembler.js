'use strict';

/**
 * form16Assembler.js — Feature 24. Builds a Form-16 certificate's Part A + Part B
 * for ONE employee + financial year, REUSING the F15 projection engine and the
 * payroll TDS spine. ZERO new tax math, ZERO new challan model.
 *
 *   buildPartB({ businessId, employeeId, financialYear, db })  → §4.1 Part-B shape
 *   buildPartA({ businessId, employeeId, entity, financialYear, deductor, db }) → §5.1
 *   buildCertificate({ ... })  → { partA, partB, rollups, anomalies, regime } (no DB write)
 *
 * Part B = the F15 annual projection at FY-end: buildTaxProjection({ asOf: 31-Mar })
 * relabelled into the statutory §17 / §10 / §16 / Chapter-VIA / tax section order.
 * At FY-end months-remaining = 0, so the projection's annual figures ARE the final
 * year-end figures, and F20's verified-amount switch is already past its deadline,
 * so the certificate certifies the VERIFIED amounts. We NEVER recompute the tax —
 * Part B is a presentation of F15's output, so `netTaxPayable` reconciles to the
 * paise with what the live run actually deducted (the golden parity test asserts it).
 *
 * Part A = a TRACES-style quarter-wise TDS-deposited summary: Σ the `TDS` line on
 * this FY's published Payslip.snapshotJson, bucketed into Q1..Q4 by periodEnd, then
 * joined to the existing StatutoryRemittance(kind=IN_TDS) challan rows. The batch
 * reconciles Σdeducted vs Σdeposited and flags a §201 gap rather than certifying it.
 *
 * Tenant-scoped (every query carries businessId). All money is INTEGER paise inside;
 * the JSON it freezes onto the certificate carries paise (…Minor) for exact roll-ups.
 */

const prismaDefault = require('../../../core/lib/prisma');
const { buildTaxProjection } = require('../projectionAssembler');

// ── money helpers (rupees number → integer paise, and back) ──────────────────
function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// §288A — round a paise amount to the nearest ₹10 (Form-16 presentation only;
// running math stays paise so the cert reconciles to the live run before this).
function roundToTenRupeesMinor(minor) {
  const tenRupeesMinor = 1000; // ₹10 = 1000 paise
  return Math.round(minor / tenRupeesMinor) * tenRupeesMinor;
}

// ── FY window helpers ────────────────────────────────────────────────────────
// "2026-27" → { startYear: 2026, fyStartIso, fyEndIso, assessmentYear }.
function fyBounds(financialYear) {
  const m = String(financialYear || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) {
    const e = new Error(`financialYear must be "YYYY-YY" (got "${financialYear}")`);
    e.code = 'BAD_FINANCIAL_YEAR';
    throw e;
  }
  const startYear = Number(m[1]);
  const endYear = startYear + 1;
  return {
    startYear,
    endYear,
    fyStartIso: `${startYear}-04-01`,
    fyEndIso: `${endYear}-03-31`,
    // Assessment year = FY + 1 (e.g. FY 2026-27 → AY 2027-28).
    assessmentYear: `${endYear}-${String((endYear + 1) % 100).padStart(2, '0')}`,
  };
}

// Quarter of an Indian FY (Apr–Mar) from a period-end date.
//   Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
function fyQuarterOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  const month = d.getUTCMonth() + 1; // 1..12
  if (month >= 4 && month <= 6) return 'Q1';
  if (month >= 7 && month <= 9) return 'Q2';
  if (month >= 10 && month <= 12) return 'Q3';
  return 'Q4'; // Jan(1)–Mar(3)
}

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
// taxPeriod months for each FY quarter (StatutoryRemittance.taxPeriod = "YYYY-MM").
function quarterTaxPeriods(quarter, startYear) {
  switch (quarter) {
    case 'Q1': return [`${startYear}-04`, `${startYear}-05`, `${startYear}-06`];
    case 'Q2': return [`${startYear}-07`, `${startYear}-08`, `${startYear}-09`];
    case 'Q3': return [`${startYear}-10`, `${startYear}-11`, `${startYear}-12`];
    case 'Q4': return [`${startYear + 1}-01`, `${startYear + 1}-02`, `${startYear + 1}-03`];
    default: return [];
  }
}

function isoDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

// ── per-FY published-payslip TDS by quarter (the Part-A deducted spine) ───────
/**
 * Read this FY's PUBLISHED/VIEWED payslips and bucket the `TDS` deduction line +
 * professional-tax line + taxable gross by quarter. The SAME reader F15 uses
 * (Payslip.snapshotJson.employeeDeductions / earnings).
 *
 * @returns {{ byQuarter: {Q1..Q4:{tdsMinor,taxableMinor,count}}, totalTdsMinor,
 *             totalTaxableMinor, ptMinor }}
 */
async function readFyPayslipTds({ businessId, employeeId, fyStartIso, fyEndIso, db }) {
  const payslips = await db.payslip.findMany({
    where: {
      businessId,
      employeeId,
      deletedAt: null,
      status: { in: ['PUBLISHED', 'VIEWED'] },
      periodEnd: { gte: new Date(fyStartIso), lte: new Date(fyEndIso) },
    },
    select: { snapshotJson: true, periodEnd: true },
    orderBy: { periodEnd: 'asc' },
  });

  const byQuarter = {
    Q1: { tdsMinor: 0, taxableMinor: 0, count: 0 },
    Q2: { tdsMinor: 0, taxableMinor: 0, count: 0 },
    Q3: { tdsMinor: 0, taxableMinor: 0, count: 0 },
    Q4: { tdsMinor: 0, taxableMinor: 0, count: 0 },
  };
  let totalTdsMinor = 0;
  let totalTaxableMinor = 0;
  let ptMinor = 0;

  for (const ps of payslips) {
    const q = fyQuarterOf(ps.periodEnd);
    const snap = ps.snapshotJson || {};
    const deductions = Array.isArray(snap.employeeDeductions) ? snap.employeeDeductions : [];
    let slipTdsMinor = 0;
    for (const d of deductions) {
      if (!d) continue;
      if (d.code === 'TDS') slipTdsMinor += rupeesToMinor(d.amount);
      else if (d.code === 'PT' || d.code === 'PROF_TAX') ptMinor += rupeesToMinor(d.amount);
    }
    const earnings = Array.isArray(snap.earnings) ? snap.earnings : [];
    let slipTaxableMinor = 0;
    for (const e of earnings) slipTaxableMinor += rupeesToMinor(e.amount);

    byQuarter[q].tdsMinor += slipTdsMinor;
    byQuarter[q].taxableMinor += slipTaxableMinor;
    byQuarter[q].count += 1;
    totalTdsMinor += slipTdsMinor;
    totalTaxableMinor += slipTaxableMinor;
  }

  return { byQuarter, totalTdsMinor, totalTaxableMinor, ptMinor, payslipCount: payslips.length };
}

// ── Part A — quarter-wise TDS deposited summary (TRACES-style) ────────────────
/**
 * buildPartA — quarter-wise TDS deducted + the challan deposit detail from the
 * existing StatutoryRemittance(kind=IN_TDS) rows. The certificate number is minted
 * by the orchestrator (allocateCode) and passed in (so Part A is deterministic +
 * idempotent on re-compute); the assembler only assembles the shape.
 *
 * @param {{ businessId, employeeId, entity, deductor, deductee, financialYear,
 *           certificateNo, tracesCertNo?, employmentPeriod, db? }} args
 * @returns the §5.1 partA object (paise-bearing, with reconciledOk).
 */
async function buildPartA({
  businessId, employeeId, entity, deductor, deductee, financialYear,
  certificateNo, tracesCertNo = null, employmentPeriod, db = prismaDefault,
}) {
  const { startYear, fyStartIso, fyEndIso, assessmentYear } = fyBounds(financialYear);
  const tds = await readFyPayslipTds({ businessId, employeeId, fyStartIso, fyEndIso, db });

  // Challan deposit detail per quarter from the entity's IN_TDS remittance rows
  // (the compliance calendar / fileRun already write these). One employee's slice
  // of a pooled challan is presented as the quarter's deduction mapped to the
  // quarter's deposit, TRACES-style. PAID/FILED only (an unfiled quarter shows ₹0
  // deposited → a CHALLAN_MISSING gap at the batch level).
  const challanRows = await db.statutoryRemittance.findMany({
    where: {
      businessId,
      entityId: entity.id,
      kind: 'IN_TDS',
      taxPeriod: { in: QUARTERS.flatMap((q) => quarterTaxPeriods(q, startYear)) },
      status: { in: ['PAID', 'FILED'] },
    },
    select: { taxPeriod: true, challanRef: true, paidDate: true, filedDate: true, amount: true, status: true },
  });
  // Bucket challans into quarters by their taxPeriod month.
  const periodToQuarter = {};
  for (const q of QUARTERS) for (const p of quarterTaxPeriods(q, startYear)) periodToQuarter[p] = q;

  const quarters = QUARTERS.map((q) => {
    const deducted = tds.byQuarter[q];
    const challans = challanRows
      .filter((r) => periodToQuarter[r.taxPeriod] === q)
      .map((r) => ({
        // BSR code is the first 7 chars of the challan ref by NSDL convention; we
        // surface both so the tenant's FVU/RPU can reconcile against TRACES.
        bsrCode: r.challanRef ? String(r.challanRef).slice(0, 7) : null,
        challanRef: r.challanRef || null,
        paidDate: isoDate(r.paidDate || r.filedDate),
        // ENTITY-pool amount on the challan row (whole-entity deposit for the
        // quarter). This is the deductor's aggregate deposit and must NEVER be
        // written onto an individual employee's deposited figure (it would leak the
        // company-wide TDS onto every cert + defeat the §201 gap). It is retained
        // ONLY as challan-identity detail for FVU/TRACES reconciliation.
        entityDepositedMinor: rupeesToMinor(r.amount),
      }));
    // PER-EMPLOYEE deposited slice: when a covering PAID/FILED challan exists for the
    // quarter, this employee's own deducted TDS is treated as deposited (capped at
    // the employee's deducted — never more, never the entity pool). A quarter with
    // TDS deducted but NO matching challan row → depositedMinor stays 0, so the §201
    // reconcile flags it (the gap surfaces here AND at the batch level). A quarter
    // with no deduction needs no challan and deposits 0.
    const hasCoveringChallan = challans.length > 0;
    const depositedMinor = hasCoveringChallan ? deducted.tdsMinor : 0;
    return {
      quarter: q,
      tdsDeductedMinor: deducted.tdsMinor,
      tdsDepositedMinor: depositedMinor,
      challans,
    };
  });

  const totalDeductedMinor = quarters.reduce((s, q) => s + q.tdsDeductedMinor, 0);
  const totalDepositedMinor = quarters.reduce((s, q) => s + q.tdsDepositedMinor, 0);
  // Reconciled when every quarter that deducted TDS has a covering challan (deposited
  // === deducted for this employee). The deposited figure is now the employee's own
  // slice, so this is a true per-employee §201 check (not a trivially-true pool one).
  const reconciledOk = quarters.every(
    (q) => q.tdsDeductedMinor === 0 || q.tdsDepositedMinor >= q.tdsDeductedMinor,
  );

  return {
    certificateNo,
    tracesCertNo,
    deductor,
    deductee,
    financialYear,
    assessmentYear,
    employmentPeriod,
    quarters,
    totalTdsDeductedMinor: totalDeductedMinor,
    totalTdsDepositedMinor: totalDepositedMinor,
    reconciledOk,
    _payslipTotals: {
      totalTdsMinor: tds.totalTdsMinor,
      totalTaxableMinor: tds.totalTaxableMinor,
      ptMinor: tds.ptMinor,
      payslipCount: tds.payslipCount,
    },
  };
}

// ── Part B — year-end tax computation (REUSE F15, zero new tax math) ──────────
/**
 * buildPartB — the F15 annual projection at FY-end, relabelled into the statutory
 * Part-B section order (§4.1). The professional-tax §16(iii) line is read from the
 * payslip snapshot (passed in as ptMinor) since F15 nets it into the run, not the
 * projection's taxable; it is DISCLOSED on the certificate without re-deriving the
 * certified tax (which stays F15's value to the paise).
 *
 * @returns {{ partB, stmt }} — partB is the frozen §4.1 shape (paise-bearing);
 *          stmt is the raw F15 statement (carried so the caller reuses its anomalies).
 */
async function buildPartB({ businessId, employeeId, financialYear, ptMinor = 0, db = prismaDefault }) {
  const { fyEndIso } = fyBounds(financialYear);

  // The F15 assembler at FY-end. months-remaining = 0 ⇒ the projection's annual
  // figures ARE the final year-end figures; F20's verified switch is past its
  // deadline ⇒ the VERIFIED amounts drive it. NO recomputation here.
  const stmt = await buildTaxProjection({ businessId, employeeId, asOf: fyEndIso, db });

  // §17 gross salary breakup. F15's grossSalary EXCLUDES perquisites (they are
  // added by the engine as §17(2)); we surface them separately.
  const section17_1 = rupeesToMinor(stmt.annualEarnings && stmt.annualEarnings.grossSalary);
  const section17_2_perquisites = rupeesToMinor(stmt.perquisites && stmt.perquisites.total);
  const section17_3_profitsInLieu = 0; // not modelled (roadmap)
  const grossSalaryTotal = section17_1 + section17_2_perquisites + section17_3_profitsInLieu;

  // §10 exempt allowances — HRA exemption (OLD only) + LTA (0 until split).
  const exemptAllowances = [];
  const hraExemptMinor = stmt.hraExemption ? rupeesToMinor(stmt.hraExemption.exempt) : 0;
  if (hraExemptMinor > 0) exemptAllowances.push({ type: 'HRA', amount: hraExemptMinor });
  const exemptTotalMinor = exemptAllowances.reduce((s, a) => s + a.amount, 0);

  // §16 deductions: standard deduction (ia) + professional tax (iii).
  const standardDeductionMinor = rupeesToMinor(stmt.standardDeduction);
  const professionalTaxMinor = Math.max(0, Math.round(ptMinor || 0));

  // Net salary after §10 exemptions (before §16 deductions).
  const netSalaryMinor = Math.max(0, grossSalaryTotal - exemptTotalMinor);

  // Income under the head "Salaries" (after §16). The CERTIFIED totalIncome/tax
  // below come straight from F15 (zero new tax math), and the F15 income-tax engine
  // does NOT model professional tax (PT is a payroll deduction, not fed into the
  // §16(iii) line of the projection). To keep the DISPLAYED chain footing to the
  // certified F15 totalIncome to the paise (gross → −§10 → net → −§16 → income under
  // Salaries → +prev-emp → gross-total → −ChVI-A == totalIncome), the §16 deduction
  // that flows through this chain is the SAME standard-deduction F15 used; PT is
  // DISCLOSED as a §16(iii) memo line only and is NOT subtracted here (subtracting
  // it would make the chain disagree with the certified total by exactly the PT and
  // would silently over/under-state the cert). Feeding PT into the certified tax is
  // out of scope (it would require new tax math in the F15/india engine).
  const section16TotalMinor = standardDeductionMinor; // PT is memo-only (see above)
  const incomeUnderHeadSalariesMinor = Math.max(
    0,
    netSalaryMinor - section16TotalMinor,
  );

  // Chapter VI-A (OLD only) → section / gross / deductible.
  const chapterVIA = stmt.chapterVIA && Array.isArray(stmt.chapterVIA.lines)
    ? {
        lines: stmt.chapterVIA.lines.map((l) => ({
          section: l.section,
          label: l.label,
          grossAmount: rupeesToMinor(l.gross),
          qualifyingAmount: rupeesToMinor(l.qualifying),
          deductibleAmount: rupeesToMinor(l.deductible),
        })),
        totalDeductible: rupeesToMinor(stmt.chapterVIA.totalDeductible),
      }
    : { lines: [], totalDeductible: 0 };

  const prevEmployerIncomeMinor = stmt.previousEmployerCounted
    ? rupeesToMinor(stmt.previousEmployerTaxableIncome)
    : 0;

  // CERTIFIED chain — straight from F15 (no new math). The EXACT (paise) F15 taxable
  // income is what the displayed Part-B chain must foot to; `totalIncome` is the
  // statutory §288A nearest-₹10 PRESENTATION of that same figure.
  const totalIncomeExactMinor = rupeesToMinor(stmt.totalTaxableIncome);
  const totalIncomeMinor = roundToTenRupeesMinor(totalIncomeExactMinor);
  const taxPayableBeforeMinor = rupeesToMinor(stmt.taxPayable); // tax before surcharge/cess (post-rebate)
  const surchargeMinor = rupeesToMinor(stmt.surcharge);
  const cessMinor = rupeesToMinor(stmt.cess);
  const totalTaxMinor = rupeesToMinor(stmt.totalTax); // = taxPayable + surcharge + cess (post-rebate/relief)
  const tdsDeductedMinor = rupeesToMinor(stmt.tdsDeductedThisFY) + rupeesToMinor(stmt.previousEmployerTds);

  const grossTotalIncomeMinor = incomeUnderHeadSalariesMinor + prevEmployerIncomeMinor;

  // ── FOOTING ASSERTION — the displayed chain MUST reconcile to the certified F15
  // total income to the paise. grossTotalIncome − ChVI-A == (exact) F15 taxable
  // income. F15 clamps taxable income at ≥0 (Math.max(0, …)+prevTaxable); mirror
  // that clamp on the displayed side so a fully-deductible nil-income employee also
  // foots. A mismatch beyond ₹1 (rounding noise) is a hard error — the cert is a
  // statutory document and must never be issued not-footing.
  const chainTotalIncomeMinor = Math.max(
    0,
    incomeUnderHeadSalariesMinor - chapterVIA.totalDeductible,
  ) + prevEmployerIncomeMinor;
  const footingDeltaMinor = Math.abs(chainTotalIncomeMinor - totalIncomeExactMinor);
  if (footingDeltaMinor > 100) {
    const e = new Error(
      `Form-16 Part B does not foot: displayed chain total income ₹${(chainTotalIncomeMinor / 100).toFixed(2)} `
      + `≠ certified F15 total income ₹${(totalIncomeExactMinor / 100).toFixed(2)} `
      + `(delta ₹${(footingDeltaMinor / 100).toFixed(2)})`,
    );
    e.code = 'PARTB_NOT_FOOTING';
    throw e;
  }

  const partB = {
    grossSalary: {
      section17_1,
      section17_2_perquisites,
      section17_3_profitsInLieu,
      total: grossSalaryTotal,
    },
    exemptAllowances_section10: exemptAllowances,
    exemptAllowances_section10_total: exemptTotalMinor,
    netSalary: netSalaryMinor,
    standardDeduction_section16ia: standardDeductionMinor,
    professionalTax_section16iii: professionalTaxMinor,
    incomeUnderHeadSalaries: incomeUnderHeadSalariesMinor,
    incomeFromOtherSources: 0,
    previousEmployerIncome: prevEmployerIncomeMinor,
    grossTotalIncome: grossTotalIncomeMinor,
    chapterVIA,
    totalIncome: totalIncomeMinor,
    taxOnTotalIncome: taxPayableBeforeMinor,
    rebate_section87A: 0, // already netted into F15's taxPayable; disclosed as 0 here
    surcharge: surchargeMinor,
    healthAndEducationCess: cessMinor,
    taxPayable: totalTaxMinor,
    reliefs_section89: 0,
    netTaxPayable: totalTaxMinor,
    tdsDeducted: tdsDeductedMinor,
    regime: stmt.regime,
    verifiedBasis: stmt.proofBasis || 'DECLARED',
    noPanApplied: !!stmt.noPanApplied,
  };

  return { partB, stmt };
}

// ── buildCertificate — orchestration-free assembly of one full certificate ────
/**
 * buildCertificate — the single entry the orchestrator calls per employee. Reads
 * Part B (F15) and Part A (payslip TDS + challans), reconciles them, and rolls up
 * the money + anomalies. NO DB writes (the orchestrator persists the frozen JSON).
 *
 * @param {{ businessId, employeeId, entity, deductor, financialYear, certificateNo,
 *           tracesCertNo?, db? }} args
 * @returns {{ partA, partB, regime, rollups, anomalies, reconciledOk }}
 */
async function buildCertificate({
  businessId, employeeId, entity, deductor, financialYear, certificateNo,
  tracesCertNo = null, db = prismaDefault,
}) {
  const { fyStartIso, fyEndIso } = fyBounds(financialYear);

  // Subject employee identity (deductee).
  const emp = await db.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: {
      id: true, code: true, firstName: true, middleName: true, lastName: true,
      addressLine1: true, addressLine2: true, city: true, stateCode: true, postalCode: true,
      hireDate: true, terminationDate: true,
    },
  });
  if (!emp) {
    const e = new Error('Employee not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const sp = await db.statutoryProfile.findFirst({
    where: { businessId, employeeId },
    select: { pan: true },
  });

  const deductee = {
    name: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' ') || emp.code,
    pan: (sp && sp.pan) || null,
    address: [emp.addressLine1, emp.addressLine2, emp.city, emp.stateCode, emp.postalCode]
      .filter(Boolean).join(', ') || null,
    employeeCode: emp.code || null,
  };

  // Employment period clamps to [max(FY-start, hire), min(FY-end, termination)].
  const fyStart = new Date(fyStartIso);
  const fyEnd = new Date(fyEndIso);
  const hire = emp.hireDate ? new Date(emp.hireDate) : null;
  const term = emp.terminationDate ? new Date(emp.terminationDate) : null;
  const from = hire && hire > fyStart ? hire : fyStart;
  const to = term && term < fyEnd ? term : fyEnd;
  const employmentPeriod = { from: isoDate(from), to: isoDate(to) };

  // Part B first (so we can pass its professional-tax line into Part A's reader
  // is not needed; PT comes from the payslip reader inside Part A's totals).
  // Read the payslip TDS totals once and reuse for both Part A and Part B's PT.
  const tds = await readFyPayslipTds({ businessId, employeeId, fyStartIso, fyEndIso, db });

  const { partB, stmt } = await buildPartB({
    businessId, employeeId, financialYear, ptMinor: tds.ptMinor, db,
  });

  const partA = await buildPartA({
    businessId, employeeId, entity, deductor, deductee, financialYear,
    certificateNo, tracesCertNo, employmentPeriod, db,
  });

  // ── reconciliation (deducted-vs-deposited + Part B vs Part A) ──
  const anomalies = [];
  // Carry F15's own anomalies (MISSING_PAN, UNVERIFIED_DECLARATION).
  for (const a of stmt.anomalies || []) {
    anomalies.push({ code: a.code, severity: a.severity || 'WARN', message: a.message });
  }
  if (!deductee.pan) {
    if (!anomalies.some((a) => a.code === 'MISSING_PAN')) {
      anomalies.push({ code: 'MISSING_PAN', severity: 'WARN', message: 'No PAN on record (§206AA). 24Q will emit PANNOTAVBL.' });
    }
  }
  if (tds.payslipCount === 0) {
    anomalies.push({ code: 'NO_PAYSLIPS', severity: 'INFO', message: 'No published payslips in the financial year.' });
  }
  // Part B TDS (this FY + prev-employer) should equal the Part A quarter sum
  // (within ₹1 rounding tolerance). A mismatch is a TDS_GAP — never silently
  // certified. (Part B includes prev-employer TDS; Part A is this-employer only,
  // so compare the this-employer portion.)
  const partAtotalDeductedMinor = partA.totalTdsDeductedMinor;
  const thisEmployerTdsMinor = rupeesToMinor(stmt.tdsDeductedThisFY);
  if (Math.abs(partAtotalDeductedMinor - thisEmployerTdsMinor) > 100) {
    anomalies.push({
      code: 'TDS_GAP',
      severity: 'WARN',
      message: `Part A quarter-wise TDS (₹${(partAtotalDeductedMinor / 100).toFixed(2)}) does not match the payslip TDS total (₹${(thisEmployerTdsMinor / 100).toFixed(2)}).`,
    });
  }
  // Deducted-vs-deposited gap (§201): any quarter that deducted but did not deposit.
  if (!partA.reconciledOk) {
    anomalies.push({
      code: 'CHALLAN_MISSING',
      severity: 'WARN',
      message: 'One or more quarters have deducted TDS without a matching PAID/FILED challan (§201 exposure).',
    });
  }

  const rollups = {
    grossSalaryMinor: partB.grossSalary.total,
    totalTaxableMinor: partB.totalIncome,
    totalTaxMinor: partB.netTaxPayable,
    tdsDeductedMinor: partAtotalDeductedMinor,
    tdsDepositedMinor: partA.totalTdsDepositedMinor,
  };

  // Strip the internal helper field before freezing.
  const partAFrozen = { ...partA };
  delete partAFrozen._payslipTotals;

  return {
    partA: partAFrozen,
    partB,
    regime: stmt.regime,
    rollups,
    anomalies,
    reconciledOk: partA.reconciledOk && !anomalies.some((a) => a.code === 'TDS_GAP'),
  };
}

module.exports = {
  buildPartA,
  buildPartB,
  buildCertificate,
  _internals: {
    fyBounds, fyQuarterOf, quarterTaxPeriods, readFyPayslipTds,
    roundToTenRupeesMinor, rupeesToMinor,
  },
};

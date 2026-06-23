'use strict';

/*
 * orchestration.test.js — DB-FREE unit test for the payroll orchestrator's PURE
 * mapping layer (service.buildEmployeePayInput) + the engine.
 *
 * Plain-node test (built-in `assert`, NO jest, NO DB):
 *   node backend/src/hr/payroll/__tests__/orchestration.test.js
 *
 * It feeds MOCK Prisma-shaped rows for ONE India employee and ONE New Zealand
 * employee through buildEmployeePayInput(rows) -> computePayslip(args) and
 * asserts the resulting payslip net / deductions to the EXACT paise / cent.
 *
 * Every expected value is HAND-DERIVED from the statutory rate tables in
 * docs/05-compliance-india.md (paise) and docs/06-compliance-newzealand.md
 * (cents) — NOT copied from the engine's output. The arithmetic is shown inline.
 *
 * MONEY: all amounts are INTEGER MINOR UNITS. ₹1 = 100 paise; $1 = 100 cents.
 */

const assert = require('assert');
const service = require('../service.js');
const engine = require('../engine.js');

const P = 100; // paise per rupee / cents per dollar
const R = (major) => major * P;

let passed = 0;
let failed = 0;
const discrepancies = [];

function check(scenario, expected, actual) {
  try {
    assert.strictEqual(actual, expected);
    passed += 1;
  } catch (e) {
    failed += 1;
    const msg = `${scenario}: expected ${expected} got ${actual}`;
    discrepancies.push(msg);
    // eslint-disable-next-line no-console
    console.error(`FAIL  ${msg}`);
  }
}

function amt(arr, code) {
  const l = arr.find((x) => x.code === code);
  return l ? l.amountMinor : null;
}

// ===========================================================================
// SCENARIO 1 — INDIA. Maharashtra employee, monthly, June 2025.
// ---------------------------------------------------------------------------
//   Structure: BASIC ₹30,000 (isWageForPF) + HRA ₹20,000  => gross ₹50,000.
//   Basic+DA ₹30,000 = 60% of gross -> 50% rule compliant (no add-back).
//   PF (default cap policy): PFWage = min(30000, 15000) = ₹15,000.
//     EPF-EE   = 12% × 15,000          = ₹1,800   = 180000 paise
//     EPS      = 8.33% × 15,000 = 1,249.5 -> round ₹1,250, cap ₹1,250 = 125000
//     EPF-ER   = 12% × 15,000 − EPS     = 1,800 − 1,250 = ₹550 = 55000
//     EDLI     = 0.50% × 15,000         = ₹75      = 7500
//     ADMIN    = max(0.50%×15,000=75, ₹500 floor) = ₹500 = 50000
//   ESI: gross ₹50,000 > ₹21,000 ceiling, not latched -> NO ESI line.
//   PT (MH male, June, gross >₹10,000) -> ₹200 = 20000 paise.
//   TDS: projected annual = 50,000 × 12 = 6,00,000; taxable 5,25,000;
//        ≤12L -> §87A nil -> NO TDS line.
//   EE deductions = EPF 1,800 + PT 200 = ₹2,000 = 200000 paise.
//   Net = gross 50,000 − 2,000 = ₹48,000 = 4800000 paise.
// ===========================================================================
{
  const inRows = {
    employee: { id: 'emp-in-1', code: 'EMP-IN-1', gender: 'MALE', dateOfBirth: '1990-01-01', stateCode: null },
    compensation: {
      id: 'comp-in-1',
      lines: [
        {
          amountMonthly: '30000.00', sortOrder: 0,
          component: {
            id: 'BASIC', code: 'BASIC', name: 'Basic', kind: 'BASIC', category: 'EARNING',
            calcMethod: 'FLAT', isWageForPF: true, prorationMethod: 'CALENDAR_DAYS', isRecurring: true,
          },
        },
        {
          amountMonthly: '20000.00', sortOrder: 1,
          component: {
            id: 'HRA', code: 'HRA', name: 'House Rent Allowance', kind: 'HRA', category: 'EARNING',
            calcMethod: 'FLAT', isWageForPF: false, prorationMethod: 'CALENDAR_DAYS', isRecurring: true,
          },
        },
      ],
    },
    statutory: { countryCode: 'IN', pan: 'ABCDE1234F', uan: '100200300400', esiApplicable: false, ptStateCode: 'MH' },
    attendance: null,
    entity: { countryCode: 'IN', stateCode: 'MH', payCurrency: 'INR', taxYearStartMonth: 4 },
    period: { start: '2025-06-01', end: '2025-06-30', payDate: '2025-06-30', frequency: 'MONTHLY', taxYear: '2025-26' },
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: false },
  };

  const { engineArgs, meta } = service.buildEmployeePayInput(inRows);
  const r = engine.computePayslip(engineArgs);

  check('IN gross ₹50,000', R(50000), r.grossMinor);
  check('IN EPF-EE (12%×15,000=₹1,800)', R(1800), amt(r.employeeDeductions, 'EPF'));
  check('IN PT MH male June (₹200)', R(200), amt(r.employeeDeductions, 'PT'));
  check('IN no ESI line (gross >21k)', null, amt(r.employeeDeductions, 'ESI'));
  check('IN no TDS line (taxable ≤12L)', null, amt(r.employeeDeductions, 'TDS'));
  check('IN total EE deductions ₹2,000', R(2000), r.totalEmployeeDeductionsMinor);
  check('IN net ₹48,000', R(48000), r.netMinor);
  // employer contributions (cost-to-company, not deducted)
  check('IN EPS-ER (₹1,250)', R(1250), amt(r.employerContributions, 'EPS_ER'));
  check('IN EPF-ER balance (₹550)', R(550), amt(r.employerContributions, 'EPF_ER'));
  check('IN EDLI (₹75)', R(75), amt(r.employerContributions, 'EDLI'));
  check('IN ADMIN floor (₹500)', R(500), amt(r.employerContributions, 'ADMIN'));
  // mapping meta plumbs straight through
  check('IN meta.employeeId', 'emp-in-1', meta.employeeId);
  check('IN meta.compensationId', 'comp-in-1', meta.compensationId);
}

// ===========================================================================
// SCENARIO 2 — NEW ZEALAND. Fortnightly, paid 15-Apr-2026 (FY2026-27 rates).
// ---------------------------------------------------------------------------
//   Structure: SALARY $2,000 (isKiwiSaverable, isPayeable) => gross $2,000.
//   Tax code M; KiwiSaver ACTIVE 3.5% EE / 3.5% ER; prior-year income $52,000.
//
//   KiwiSaver EE  = 3.5% × $2,000          = $70.00  = 7000 cents
//   KiwiSaver ER  = 3.5% × $2,000          = $70.00  = 7000 cents (gross)
//   ESCT (tier on $52,000 -> 17.5%)        = 17.5% × $70.00 = $12.25 = 1225 cents
//
//   PAYE (annualised periodic method, M code):
//     annualised   = $2,000 × 26           = $52,000
//     bracket tax  : $0–15,600 @10.5% = $1,638.00
//                    $15,600–52,000 @17.5% = $36,400 × 0.175 = $6,370.00
//                    annual tax = $8,008.00 = 800800 cents
//     period income tax = 800,800 / 26     = $30.80  = 30800 cents (exact)
//     ACC levy = 1.75% × $2,000            = $35.00  = 3500 cents
//     PAYE     = 30,800 + 3,500            = $343.00 = 34300 cents
//
//   EE deductions = PAYE $343.00 + KS $70.00 = $413.00 = 41300 cents.
//   Net = gross $2,000 − $413.00 = $1,587.00 = 158700 cents.
// ===========================================================================
{
  const nzRows = {
    employee: { id: 'emp-nz-1', code: 'EMP-NZ-1', gender: 'FEMALE', dateOfBirth: '1990-01-01', stateCode: null },
    compensation: {
      id: 'comp-nz-1',
      lines: [
        {
          amountMonthly: '2000.00', sortOrder: 0,
          component: {
            id: 'SALARY', code: 'SALARY', name: 'Salary', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING',
            calcMethod: 'FLAT', isKiwiSaverable: true, isPayeable: true, prorationMethod: 'CALENDAR_DAYS', isRecurring: true,
          },
        },
      ],
    },
    statutory: { countryCode: 'NZ', taxCode: 'M', kiwiSaverStatus: 'ACTIVE', kiwiSaverEmployeeRate: '0.035', esctRate: '0.175' },
    attendance: null,
    entity: { countryCode: 'NZ', stateCode: null, payCurrency: 'NZD', taxYearStartMonth: 4 },
    period: { start: '2026-04-01', end: '2026-04-14', payDate: '2026-04-15', frequency: 'FORTNIGHTLY', taxYear: '2026-27' },
    ytd: { priorYearTaxableIncomeMinor: R(52000), accLiableEarningsMinor: 0 },
  };

  const { engineArgs, meta } = service.buildEmployeePayInput(nzRows);
  const r = engine.computePayslip(engineArgs);

  check('NZ gross $2,000', R(2000), r.grossMinor);
  check('NZ PAYE (income tax $30.80 + ACC $35.00 = $343.00)', 34300, amt(r.employeeDeductions, 'PAYE'));
  check('NZ KiwiSaver EE (3.5% = $70.00)', 7000, amt(r.employeeDeductions, 'KIWISAVER'));
  check('NZ total EE deductions $413.00', 41300, r.totalEmployeeDeductionsMinor);
  check('NZ net $1,587.00', 158700, r.netMinor);
  // employer side
  check('NZ KiwiSaver ER gross (3.5% = $70.00)', 7000, amt(r.employerContributions, 'KIWISAVER_ER'));
  check('NZ ESCT (17.5% × $70.00 = $12.25)', 1225, amt(r.employerContributions, 'ESCT'));
  // mapping meta
  check('NZ meta.employeeId', 'emp-nz-1', meta.employeeId);
}

// ===========================================================================
// SCENARIO 3 — INDIA with LOP proration (attendance-driven). 2 LOP days.
// ---------------------------------------------------------------------------
//   Same structure as Scenario 1 but attendance: 30 calendar days, 2 LOP days,
//   payableDays 28. CALENDAR_DAYS proration: each earning × 28/30.
//     BASIC ₹30,000 × 28/30 = ₹28,000.00       = 2800000 paise
//     HRA   ₹20,000 × 28/30 = ₹18,666.666... -> HALF_UP ₹18,666.67 = 1866667 paise
//   gross = 2,800,000 + 1,866,667 = 4,666,667 paise = ₹46,666.67.
//   (We assert the prorated gross; statutory recomputes off the lower base.)
// ===========================================================================
{
  const inRows = {
    employee: { id: 'emp-in-2', code: 'EMP-IN-2', gender: 'MALE', dateOfBirth: '1990-01-01', stateCode: null },
    compensation: {
      id: 'comp-in-2',
      lines: [
        {
          amountMonthly: '30000.00', sortOrder: 0,
          component: { id: 'BASIC', code: 'BASIC', name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: true, prorationMethod: 'CALENDAR_DAYS', isRecurring: true },
        },
        {
          amountMonthly: '20000.00', sortOrder: 1,
          component: { id: 'HRA', code: 'HRA', name: 'HRA', kind: 'HRA', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: false, prorationMethod: 'CALENDAR_DAYS', isRecurring: true },
        },
      ],
    },
    statutory: { countryCode: 'IN', pan: 'ABCDE1234F', uan: '100200300400', esiApplicable: false, ptStateCode: 'MH' },
    attendance: { calendarDays: '30.0000', payableDays: '28.0000', lopDays: '2.0000', overtimeHours: '0.00' },
    entity: { countryCode: 'IN', stateCode: 'MH', payCurrency: 'INR', taxYearStartMonth: 4 },
    period: { start: '2025-06-01', end: '2025-06-30', payDate: '2025-06-30', frequency: 'MONTHLY', taxYear: '2025-26' },
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: false },
  };

  const { engineArgs, meta } = service.buildEmployeePayInput(inRows);
  const r = engine.computePayslip(engineArgs);

  check('IN-LOP BASIC prorated 28/30 (₹28,000.00)', 2800000, amt(r.earnings, 'BASIC'));
  check('IN-LOP HRA prorated 28/30 (₹18,666.67)', 1866667, amt(r.earnings, 'HRA'));
  check('IN-LOP gross (₹46,666.67)', 4666667, r.grossMinor);
  check('IN-LOP meta.lopDays', 2, meta.lopDays);
  check('IN-LOP meta.payableDays', 28, meta.payableDays);
}

// ===========================================================================
// SCENARIO 3 — FINDING #5: the engine carries the REAL PF wage base on the EPF
// component (baseMinor), so filing reads it straight through instead of
// back-deriving it by dividing the contribution by 0.12. Reuse SCENARIO 1's IN
// employee (BASIC ₹30,000 wage-for-PF, default cap → PFWage = ₹15,000).
// ---------------------------------------------------------------------------
{
  const inRows = {
    employee: { id: 'emp-in-1', code: 'EMP-IN-1', gender: 'MALE', dateOfBirth: '1990-01-01', stateCode: null },
    compensation: {
      id: 'comp-in-1',
      lines: [
        {
          amountMonthly: '30000.00', sortOrder: 0,
          component: { id: 'BASIC', code: 'BASIC', name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: true, prorationMethod: 'CALENDAR_DAYS', isRecurring: true },
        },
        {
          amountMonthly: '20000.00', sortOrder: 1,
          component: { id: 'HRA', code: 'HRA', name: 'HRA', kind: 'HRA', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: false, prorationMethod: 'CALENDAR_DAYS', isRecurring: true },
        },
      ],
    },
    statutory: { countryCode: 'IN', pan: 'ABCDE1234F', uan: '100200300400', esiApplicable: false, ptStateCode: 'MH' },
    attendance: { calendarDays: '30.0000', payableDays: '30.0000', lopDays: '0.0000', overtimeHours: '0.00' },
    entity: { countryCode: 'IN', stateCode: 'MH', payCurrency: 'INR', taxYearStartMonth: 4 },
    period: { start: '2025-06-01', end: '2025-06-30', payDate: '2025-06-30', frequency: 'MONTHLY', taxYear: '2025-26' },
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: false },
  };
  const { engineArgs } = service.buildEmployeePayInput(inRows);
  const r = engine.computePayslip(engineArgs);
  const epf = (r.employeeDeductions || []).find((d) => d.code === 'EPF');
  // PF wage capped at ₹15,000 — baseMinor must carry the REAL capped base.
  check('IN-PF EPF component carries real PF wage base ₹15,000', R(15000), epf ? epf.baseMinor : null);
  // The back-derived figure would be EPF-EE / 0.12 = 1800 / 0.12 = ₹15,000 here,
  // but for a sub-ceiling / full-wage / VPF case the two diverge; what matters is
  // the base is now an EXPLICIT engine output, not reconstructed from a rate.
  check('IN-PF EPF-EE is ₹1,800 (12% of capped base)', R(1800), epf ? epf.amountMinor : null);
  // statutoryRollups must surface the base on the PayRunLine rollup columns.
  const rollups = service._internal.statutoryRollups(r);
  check('IN-PF statutoryRollups.pfWagesBase = "15000.00"', '15000.00', rollups.pfWagesBase);
}

// ===========================================================================
// SCENARIO 4 — FINDING #6: resolveFilingPlan rejects an unsupported country
// rather than returning [] (which would file nothing + close silently).
// ---------------------------------------------------------------------------
{
  const { resolveFilingPlan } = service._internal;
  check('IN filing plan resolves (4 obligations)', 4, resolveFilingPlan('IN').length);
  check('NZ filing plan resolves (2 obligations)', 2, resolveFilingPlan('NZ').length);
  let usCode = null;
  try { resolveFilingPlan('US'); } catch (e) { usCode = e.code; }
  check('Unsupported country US → COUNTRY_MISMATCH', 'COUNTRY_MISMATCH', usCode);
}

// ===========================================================================
console.log('');
console.log(`Orchestration test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
if (failed > 0) {
  console.log('Discrepancies:');
  for (const d of discrepancies) console.log('  - ' + d);
  process.exitCode = 1;
}

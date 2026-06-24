'use strict';

/*
 * india.golden.test.js — INDEPENDENT QA golden-dataset test for the India
 * compliance module (../compliance/india.js).
 *
 * Plain-node test (built-in `assert`, NO jest, NO node_modules):
 *   node backend/src/hr/payroll/__tests__/india.golden.test.js
 *
 * EVERY expected value below is derived BY HAND from the worked examples and
 * the rate/threshold/slab tables in docs/05-compliance-india.md. The engine's
 * internal arithmetic was deliberately NOT read to back-fill expecteds (that
 * would defeat the test). Only the public CONTRACT (compute(ctx) shape, the
 * exported _internals pillar-helper signatures, and the codes/labels) was
 * consulted.
 *
 * MONEY: all amounts are INTEGER MINOR UNITS (paise). ₹1 = 100 paise.
 *
 * Each scenario: comment citing its docs/05 basis -> inputs -> hand-derived
 * expected (with the arithmetic shown) -> assert. Discrepancies are reported,
 * not papered over.
 */

const assert = require('assert');
const IN = require('../compliance/india.js');

const P = 100; // paise per rupee
const R = (rupees) => rupees * P; // rupees -> paise

const {
  computeStatutoryWages,
  computeEpf,
  computeEsi,
  computeProfessionalTax,
  computeTds,
  annualTaxNewRegime,
  computeGratuity,
  // Feature 21 — Labour Welfare Fund
  computeLwf,
  periodIsPrimaryRun,
  resolveLwf,
  // Feature 22 — Payment of Bonus Act rule resolver
  resolveBonusRule,
} = IN._internals;

// ---- tiny harness ---------------------------------------------------------
let passed = 0;
let failed = 0;
const discrepancies = [];

function check(scenario, expected, actual) {
  try {
    assert.strictEqual(actual, expected);
    passed += 1;
    // console.log(`PASS  ${scenario}`);
  } catch (e) {
    failed += 1;
    const msg = `${scenario}: expected ${expected} got ${actual}`;
    discrepancies.push(msg);
    console.error(`FAIL  ${msg}`);
  }
}

function checkDeep(scenario, expected, actual) {
  try {
    assert.deepStrictEqual(actual, expected);
    passed += 1;
  } catch (e) {
    failed += 1;
    const msg = `${scenario}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`;
    discrepancies.push(msg);
    console.error(`FAIL  ${msg}`);
  }
}

// Helper: pull a line by code out of a compute() result array.
function byCode(arr, code) {
  return arr.find((x) => x.code === code);
}
function amt(arr, code) {
  const l = byCode(arr, code);
  return l ? l.amountMinor : null; // null = line absent
}

// ===========================================================================
// SECTION A — EPF / EPS / EDLI / ADMIN split with the ₹15,000 cap (docs/05 §4)
// ===========================================================================

// --- T4 (docs/05 §4.4, §17 T4): PF wage ₹25,000, establishment CAPS at ceiling.
//   PFWage(capped) = min(25000,15000) = 15000.
//   EE EPF   = 12% × 15000          = 1800.00   -> ₹1,800   = 180000 paise
//   EPS      = 8.33% × 15000 = 1249.5 -> round 1250, cap 1250 = 125000 paise
//   ER total = 12% × 15000          = 1800; EPF_ER = 1800 − 1250 = 550 = 55000 paise
//   EDLI     = 0.50% × 15000        = 75         = 7500 paise
//   ADMIN    = max(0.50%×15000=75, ₹500 floor)   = ₹500 = 50000 paise
{
  const e = computeEpf({ pfWageMinor: R(25000), capAtCeiling: true });
  check('T4 EE-EPF (PF25k cap)', R(1800), e.epfEeMinor);
  check('T4 EPS (PF25k cap)', R(1250), e.epsMinor);
  check('T4 EPF_ER balance (PF25k cap)', R(550), e.epfErMinor);
  check('T4 EDLI (PF25k cap)', R(75), e.edliMinor);
  check('T4 ADMIN floor (PF25k cap)', R(500), e.pfAdminMinor);
  check('T7 EDLI-admin A/c22 abolished', 0, e.edliAdminMinor);
}

// --- T5 (docs/05 §4.5, §17 T5): PF wage ₹25,000, establishment on FULL wage.
//   PFWage = 25000 (full). EPS still capped at min(25000,15000)=15000 base.
//   EE EPF   = 12% × 25000 = 3000    = ₹3,000 = 300000 paise
//   EPS      = 8.33% × 15000 -> 1250 cap = 125000 paise
//   ER total = 12% × 25000 = 3000; EPF_ER = 3000 − 1250 = 1750 = 175000 paise
//   EDLI     = 0.50% × 15000 = 75    = 7500 paise (follows 15k cap)
{
  const e = computeEpf({ pfWageMinor: R(25000), capAtCeiling: false });
  check('T5 EE-EPF (PF25k full)', R(3000), e.epfEeMinor);
  check('T5 EPS (PF25k full)', R(1250), e.epsMinor);
  check('T5 EPF_ER balance (PF25k full)', R(1750), e.epfErMinor);
  check('T5 EDLI 15k-cap (PF25k full)', R(75), e.edliMinor);
}

// --- T6 (docs/05 §4.2 trap#2, §17 T6): admin ₹500 floor on a small wage.
//   PFWage = ₹15,000 (at ceiling). 0.50%×15000 = ₹75 -> floor ₹500.
//   EE EPF = 12%×15000 = 1800; EPS = 1250; EPF_ER = 550; EDLI = 75.
{
  const e = computeEpf({ pfWageMinor: R(15000), capAtCeiling: true,
    establishmentHasContributoryMember: true });
  check('T6 ADMIN ₹500 floor (PF15k)', R(500), e.pfAdminMinor);
  check('T6 EE-EPF (PF15k)', R(1800), e.epfEeMinor);
  check('T6 EPS (PF15k)', R(1250), e.epsMinor);
}

// --- EPF below ceiling, no rounding edges (docs/05 §4.2). PF wage ₹12,000.
//   EE EPF   = 12% × 12000 = 1440 = 144000 paise
//   EPS      = 8.33% × 12000 = 999.6 -> round nearest ₹1 = 1000 = 100000 paise (< 1250 cap)
//   ER total = 12% × 12000 = 1440; EPF_ER = 1440 − 1000 = 440 = 44000 paise
//   EDLI     = 0.50% × 12000 = 60 = 6000 paise
{
  const e = computeEpf({ pfWageMinor: R(12000), capAtCeiling: true });
  check('EPF12k EE', R(1440), e.epfEeMinor);
  check('EPF12k EPS (8.33%×12000=999.6->1000)', R(1000), e.epsMinor);
  check('EPF12k EPF_ER (1440-1000)', R(440), e.epfErMinor);
  check('EPF12k EDLI', R(60), e.edliMinor);
}

// ===========================================================================
// SECTION B — ESI on / over the ₹21,000 threshold (docs/05 §5)
// ===========================================================================

// --- T8 (docs/05 §5.4, §17 T8): ESI gross ₹19,000, covered.
//   EE = 0.75% × 19000 = 142.5 -> round UP = ₹143 = 14300 paise
//   ER = 3.25% × 19000 = 617.5 -> round UP = ₹618 = 61800 paise
{
  const e = computeEsi({ esiGrossMinor: R(19000), latchedCovered: true });
  check('T8 ESI-EE ₹19k (142.5->143)', R(143), e.esiEeMinor);
  check('T8 ESI-ER ₹19k (617.5->618)', R(618), e.esiErMinor);
  check('T8 ESI covered ₹19k', true, e.covered);
}

// --- T8b (docs/05 §5.3 continue-till-period-end): raise to ₹22,000 mid-period,
//   latch keeps coverage (latchedCovered=true). Deducted on FULL new gross.
//   EE = 0.75% × 22000 = 165   -> ₹165 = 16500 paise
//   ER = 3.25% × 22000 = 715   -> ₹715 = 71500 paise
{
  const e = computeEsi({ esiGrossMinor: R(22000), latchedCovered: true });
  check('T8b ESI-EE ₹22k latched (165)', R(165), e.esiEeMinor);
  check('T8b ESI-ER ₹22k latched (715)', R(715), e.esiErMinor);
  check('T8b ESI still covered ₹22k', true, e.covered);
}

// --- ESI mid-period new joiner above ₹21,000 -> never covered (docs/05 §5.3).
//   latchedCovered=false -> no contribution at all.
{
  const e = computeEsi({ esiGrossMinor: R(22000), latchedCovered: false });
  check('ESI new joiner >21k not covered', false, e.covered);
  check('ESI new joiner EE = 0', 0, e.esiEeMinor);
  check('ESI new joiner ER = 0', 0, e.esiErMinor);
}

// --- ESI low-wage EE-share exemption (docs/05 §5.2): avg <= ₹176/day exempt
//   from EE share; employer still pays 3.25%. Gross ₹4,500, ₹150/day.
//   EE = 0 (exempt). ER = 3.25% × 4500 = 146.25 -> round UP = ₹147 = 14700 paise.
{
  const e = computeEsi({ esiGrossMinor: R(4500), latchedCovered: true,
    avgDailyWageRupees: 150 });
  check('ESI EE-exempt <=176/day', 0, e.esiEeMinor);
  check('ESI ER still pays (146.25->147)', R(147), e.esiErMinor);
}

// ===========================================================================
// SECTION C — Professional Tax per state (docs/05 §6)
// ===========================================================================

// --- T9 (docs/05 §6.1 MH, §17 T9): MH male >₹10,000 gross.
//   Normal month -> ₹200 = 20000 paise. February -> ₹300 = 30000 paise.
{
  const norm = computeProfessionalTax({ stateCode: 'MH', ptGrossMinor: R(30000),
    gender: 'male', month: 6, asOf: '2025-06-30' });
  check('T9 MH male June (₹200)', R(200), norm.amountMinor);
  const feb = computeProfessionalTax({ stateCode: 'MH', ptGrossMinor: R(30000),
    gender: 'male', month: 2, asOf: '2026-02-28' });
  check('T9 MH male Feb top-up (₹300)', R(300), feb.amountMinor);
}

// --- MH male ₹8,000 (band ₹7,501–10,000 -> ₹175). docs/05 §6.1 MH table.
{
  const r = computeProfessionalTax({ stateCode: 'MH', ptGrossMinor: R(8000),
    gender: 'male', month: 6, asOf: '2025-06-30' });
  check('MH male ₹8k (₹175)', R(175), r.amountMinor);
}

// --- MH female ≤₹25,000 exempt (docs/05 §6.1 MH). Gross ₹20,000 -> Nil.
{
  const r = computeProfessionalTax({ stateCode: 'MH', ptGrossMinor: R(20000),
    gender: 'female', month: 6, asOf: '2025-06-30' });
  check('MH female <=25k exempt (₹0)', 0, r.amountMinor);
}

// --- T10 (docs/05 §6.1 KA, §17 T10): KA gross ₹24,000 in May-2025.
//   Post 01-Apr-2025 threshold ₹25,000 -> ≤25,000 -> Nil.
{
  const r = computeProfessionalTax({ stateCode: 'KA', ptGrossMinor: R(24000),
    month: 5, asOf: '2025-05-31' });
  check('T10 KA ₹24k May-2025 (Nil, post-revision)', 0, r.amountMinor);
}

// --- T11 (docs/05 §6.1 KA, §17 T11): KA gross ₹24,000 in Jan-2025 (OLD rule).
//   Pre 01-Apr-2025 threshold ₹15,000 -> >15,000 -> ₹200 = 20000 paise.
{
  const r = computeProfessionalTax({ stateCode: 'KA', ptGrossMinor: R(24000),
    month: 1, asOf: '2025-01-31' });
  check('T11 KA ₹24k Jan-2025 (₹200, pre-revision)', R(200), r.amountMinor);
}

// --- T12 (docs/05 §6.1 TN, §17 T12): TN half-year income ₹62,000, FY2025-26.
//   Revised GCC band 60,001–75,000 -> ₹1,025 = 102500 paise.
{
  const r = computeProfessionalTax({ stateCode: 'TN', ptGrossMinor: R(62000),
    asOf: '2025-09-30' });
  check('T12 TN half-yr ₹62k (₹1,025)', R(1025), r.amountMinor);
}

// --- T12a (docs/05 §6.1 TN, §17 T12a): TN half-year ₹35,000, FY2024-25+.
//   Revised band 30,001–45,000 -> ₹425 = 42500 paise (NOT the old ₹315).
{
  const r = computeProfessionalTax({ stateCode: 'TN', ptGrossMinor: R(35000),
    asOf: '2025-09-30' });
  check('T12a TN half-yr ₹35k FY24-25 (₹425)', R(425), r.amountMinor);
}

// --- T12b (docs/05 §6.1 TN, §17 T12b): TN half-year ₹35,000, FY2023-24.
//   Pre-revision band 30,001–45,000 -> ₹315 = 31500 paise.
{
  const r = computeProfessionalTax({ stateCode: 'TN', ptGrossMinor: R(35000),
    asOf: '2023-09-30' });
  check('T12b TN half-yr ₹35k FY23-24 (₹315)', R(315), r.amountMinor);
}

// ===========================================================================
// SECTION C2 — Professional Tax: additional states (docs/05 §6 PT-state list).
//   WB has explicit slabs in docs/05 §6.1; the remaining states (TS/AP/MP/OR/
//   AS/KL/BR/JH) use the real current state PT schedules seeded in india.js
//   with sources cited inline. Each case targets a SLAB BOUNDARY so an off-by-
//   one band edit is caught. PT is an exact slab integer (docs/05 §16.6).
// ===========================================================================

// --- West Bengal (WB) monthly — docs/05 §6.1 WB table (110/130/150/200 bands).
//   <=10,000 Nil; 10,001-15,000 ₹110; 15,001-25,000 ₹130; 25,001-40,000 ₹150;
//   >40,000 ₹200. Boundaries: ₹10,000 (Nil edge), ₹15,000 (₹110 edge),
//   ₹40,001 (₹200 edge).
{
  const at = (g) => computeProfessionalTax({ stateCode: 'WB', ptGrossMinor: R(g),
    month: 6, asOf: '2025-06-30' }).amountMinor;
  check('WB ₹10,000 Nil edge', 0, at(10000));
  check('WB ₹15,000 ₹110 band edge', R(110), at(15000));
  check('WB ₹25,000 ₹130 band edge', R(130), at(25000));
  check('WB ₹40,000 ₹150 band edge', R(150), at(40000));
  check('WB ₹40,001 ₹200 top band', R(200), at(40001));
}

// --- Telangana (TS) monthly — <=15,000 Nil; 15,001-20,000 ₹150; >20,000 ₹200.
{
  const at = (g) => computeProfessionalTax({ stateCode: 'TS', ptGrossMinor: R(g),
    month: 6, asOf: '2025-06-30' }).amountMinor;
  check('TS ₹15,000 Nil edge', 0, at(15000));
  check('TS ₹20,000 ₹150 band edge', R(150), at(20000));
  check('TS ₹20,001 ₹200 top band', R(200), at(20001));
}

// --- Andhra Pradesh (AP) monthly — same band structure as TS (AP Act 1987).
{
  const at = (g) => computeProfessionalTax({ stateCode: 'AP', ptGrossMinor: R(g),
    month: 6, asOf: '2025-06-30' }).amountMinor;
  check('AP ₹15,000 Nil edge', 0, at(15000));
  check('AP ₹20,000 ₹150 band edge', R(150), at(20000));
  check('AP ₹20,001 ₹200 top band', R(200), at(20001));
}

// --- Madhya Pradesh (MP) monthly — <=18,750 Nil; 18,751-25,000 ₹125;
//   >25,000 ₹208 (Feb ₹212 to sum to the ₹2,500 national cap).
{
  const at = (g, m, asOf) => computeProfessionalTax({ stateCode: 'MP',
    ptGrossMinor: R(g), month: m, asOf }).amountMinor;
  check('MP ₹18,750 Nil edge', 0, at(18750, 6, '2025-06-30'));
  check('MP ₹25,000 ₹125 band edge', R(125), at(25000, 6, '2025-06-30'));
  check('MP ₹40,000 ₹208 top band (June)', R(208), at(40000, 6, '2025-06-30'));
  check('MP ₹40,000 Feb top-up ₹212', R(212), at(40000, 2, '2026-02-28'));
}

// --- Odisha (OR) monthly — <=13,304 Nil; 13,305-25,000 ₹125; >25,000 ₹200
//   (Feb ₹300 top-up -> ₹200×11 + ₹300 = ₹2,500 cap).
{
  const at = (g, m, asOf) => computeProfessionalTax({ stateCode: 'OR',
    ptGrossMinor: R(g), month: m, asOf }).amountMinor;
  check('OR ₹13,304 Nil edge', 0, at(13304, 6, '2025-06-30'));
  check('OR ₹25,000 ₹125 band edge', R(125), at(25000, 6, '2025-06-30'));
  check('OR ₹30,000 ₹200 top band (June)', R(200), at(30000, 6, '2025-06-30'));
  check('OR ₹30,000 Feb top-up ₹300', R(300), at(30000, 2, '2026-02-28'));
}

// --- Assam (AS) monthly — <=10,000 Nil; 10,001-15,000 ₹150; 15,001-25,000 ₹180;
//   >25,000 ₹208.
{
  const at = (g) => computeProfessionalTax({ stateCode: 'AS', ptGrossMinor: R(g),
    month: 6, asOf: '2025-06-30' }).amountMinor;
  check('AS ₹10,000 Nil edge', 0, at(10000));
  check('AS ₹15,000 ₹150 band edge', R(150), at(15000));
  check('AS ₹25,000 ₹180 band edge', R(180), at(25000));
  check('AS ₹25,001 ₹208 top band', R(208), at(25001));
}

// --- Kerala (KL) HALF-YEARLY — slab on half-year income. <=11,999 Nil;
//   12,000-17,999 ₹120; 30,000-44,999 ₹300; >=1,25,000 ₹1,250 (₹2,500/yr cap).
{
  const at = (g) => computeProfessionalTax({ stateCode: 'KL', ptGrossMinor: R(g),
    asOf: '2025-09-30' }).amountMinor;
  check('KL half-yr ₹11,999 Nil edge', 0, at(11999));
  check('KL half-yr ₹12,000 ₹120 band', R(120), at(12000));
  check('KL half-yr ₹35,000 ₹300 band', R(300), at(35000));
  check('KL half-yr ₹1,25,000 ₹1,250 top band', R(1250), at(125000));
  // half-yearly frequency is reported on the result.
  const r = computeProfessionalTax({ stateCode: 'KL', ptGrossMinor: R(35000),
    asOf: '2025-09-30' });
  check('KL frequency HALF_YEARLY', 'HALF_YEARLY', r.frequency);
}

// --- Bihar (BR) monthly — annual-income bands rendered monthly. <=25,000 Nil;
//   25,001-41,666 ₹83; 41,667-83,333 ₹167; >83,333 ₹208 (Feb ₹212).
{
  const at = (g, m, asOf) => computeProfessionalTax({ stateCode: 'BR',
    ptGrossMinor: R(g), month: m, asOf }).amountMinor;
  check('BR ₹25,000 Nil edge', 0, at(25000, 6, '2025-06-30'));
  check('BR ₹30,000 ₹83 band', R(83), at(30000, 6, '2025-06-30'));
  check('BR ₹60,000 ₹167 band', R(167), at(60000, 6, '2025-06-30'));
  check('BR ₹90,000 ₹208 top band (June)', R(208), at(90000, 6, '2025-06-30'));
  check('BR ₹90,000 Feb top-up ₹212', R(212), at(90000, 2, '2026-02-28'));
}

// --- Jharkhand (JH) monthly — <=25,000 Nil; 25,001-41,666 ₹100;
//   41,667-66,666 ₹150; 66,667-83,333 ₹175; >83,333 ₹208 (Feb ₹212).
{
  const at = (g, m, asOf) => computeProfessionalTax({ stateCode: 'JH',
    ptGrossMinor: R(g), month: m, asOf }).amountMinor;
  check('JH ₹25,000 Nil edge', 0, at(25000, 6, '2025-06-30'));
  check('JH ₹30,000 ₹100 band', R(100), at(30000, 6, '2025-06-30'));
  check('JH ₹60,000 ₹150 band', R(150), at(60000, 6, '2025-06-30'));
  check('JH ₹80,000 ₹175 band', R(175), at(80000, 6, '2025-06-30'));
  check('JH ₹90,000 Feb top-up ₹212', R(212), at(90000, 2, '2026-02-28'));
}

// --- NO-PT STATE: Delhi (DL) — no state PT levied (docs/05 §6 "Not levied in:
//   Delhi, Haryana, UP, ..."). computeProfessionalTax must report unconfigured
//   with amount 0, and compute() must emit NO PT line.
{
  const r = computeProfessionalTax({ stateCode: 'DL', ptGrossMinor: R(50000),
    month: 6, asOf: '2025-06-30' });
  check('DL no-PT: not configured', false, r.configured);
  check('DL no-PT: amount 0', 0, r.amountMinor);

  // End-to-end: a Delhi establishment yields no PT deduction line.
  const out = IN.compute({
    periodGrossMinor: R(50000),
    basicMinor: R(30000),
    components: [],
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: false },
    period: { end: '2025-06-30', year: 2025, month: 6 },
    employee: { hasPan: true, gender: 'male' },
    entity: { stateCode: 'DL', pfApplicable: true, esiApplicable: true },
  });
  check('DL no-PT: compute() emits no PT line', null, amt(out.employeeDeductions, 'PT'));
}

// ===========================================================================
// SECTION D — TDS §192 (slabs, §87A rebate band, marginal relief, surcharge,
//   cess, no-PAN 206AA, mid-year projection). docs/05 §2, §7.
//   annualTaxNewRegime(taxableRupees) -> { totalAnnualTaxMinor, ... }
// ===========================================================================

// --- T1 (docs/05 §2.6, §17 T1): gross ₹18,00,000 new regime.
//   Taxable = 18,00,000 − 75,000 std ded = 17,25,000.
//   Tax: 4-8L@5%=20,000; 8-12L@10%=40,000; 12-16L@15%=60,000; 16-17.25L@20%
//        on 1,25,000 = 25,000  => 1,45,000 before rebate.
//   >12L -> no §87A. Surcharge none. + 4% cess = 5,800. Total = 1,50,800.
//   = 15080000 paise.
{
  const t = annualTaxNewRegime(1725000);
  check('T1 annual tax taxable 17,25,000 (₹1,50,800)', R(150800), t.totalAnnualTaxMinor);
}

// --- T2 (docs/05 §2.7, §17 T2): taxable ₹11,85,000 -> §87A nil.
//   ≤12L -> rebate extinguishes tax -> total 0.
{
  const t = annualTaxNewRegime(1185000);
  check('T2 taxable 11,85,000 -> §87A nil (0)', 0, t.totalAnnualTaxMinor);
}

// --- Exactly at the rebate ceiling: taxable ₹12,00,000 -> nil (docs/05 §2.2).
{
  const t = annualTaxNewRegime(1200000);
  check('Taxable 12,00,000 -> nil at ceiling (0)', 0, t.totalAnnualTaxMinor);
}

// --- T3 (docs/05 §2.7, §17 T3): taxable ₹12,65,000 -> marginal relief.
//   Slab tax: 4-8L@5%=20,000; 8-12L@10%=40,000; 12-12.65L@15% on 65,000=9,750
//     => 69,750 before relief. §87A rebate (>12L) = 0.
//   Marginal relief: cap = 12,65,000 − 12,00,000 = 65,000 < 69,750 -> tax=65,000.
//   + 4% cess = 2,600. Total = 67,600 = 6760000 paise (NOT 72,540).
{
  const t = annualTaxNewRegime(1265000);
  check('T3 taxable 12,65,000 marginal relief (₹67,600)', R(67600), t.totalAnnualTaxMinor);
}

// --- docs/05 §2.2 worked: taxable ₹12,10,000 -> tax ₹10,000 + cess ₹400 = ₹10,400.
//   Slab tax: 20,000+40,000 + 15%×10,000=1,500 = 61,500; relief cap=10,000 -> 10,000.
//   + 4% cess = 400. Total ₹10,400 = 1040000 paise.
{
  const t = annualTaxNewRegime(1210000);
  check('§2.2 taxable 12,10,000 marginal relief (₹10,400)', R(10400), t.totalAnnualTaxMinor);
}

// --- T3a (docs/05 §2.2, §17 T3a): boundary of the marginal-relief band.
//   At taxable ₹12,70,588: slab tax = 20,000+40,000+15%×70,588 = 70,588.2;
//     relief cap = 70,588; min -> 70,588 (relief STILL binds by ₹0.2).
//     + 4% cess on 70,588 = 2,823.52 -> total 73,411.52.
//   NOTE: doc presents whole-rupee relief band crossover ≈ ₹12,70,588. The
//   engine works in whole taxable rupees; sub-rupee cess rounding is not
//   pinned by the doc, so this asserts the un-rounded hand figure and will
//   surface any rounding the engine applies (discrepancy = informative).
{
  const t = annualTaxNewRegime(1270588);
  check('T3a taxable 12,70,588 relief binds (₹73,411.52)', 7341152, t.totalAnnualTaxMinor);
}

// --- T3a upper: taxable ₹12,71,000 -> relief NO LONGER binds.
//   Slab tax = 20,000+40,000+15%×71,000 = 70,650; relief cap = 71,000;
//     min -> 70,650 (normal slab tax, relief inactive). + 4% cess 2,826 = 73,476.
//   = 7347600 paise.
{
  const t = annualTaxNewRegime(1271000);
  check('T3a taxable 12,71,000 relief stops (₹73,476)', R(73476), t.totalAnnualTaxMinor);
}

// --- Surcharge band (docs/05 §2.5): taxable ₹60,00,000 (>50L, ≤1cr) new regime.
//   Slab tax: 5%×4L=20,000; 10%×4L=40,000; 15%×4L=60,000; 20%×4L=80,000;
//     25%×4L=1,00,000; 30%×(60L−24L=36,00,000)=10,80,000 => 13,80,000.
//   Surcharge 10% (>50L) = 1,38,000. Tax+sur = 15,18,000.
//   + 4% cess = 60,720. Total = 15,78,720 = 157872000 paise.
//   (Marginal relief on surcharge does not bite well above ₹50L.)
{
  const t = annualTaxNewRegime(6000000);
  check('Surcharge taxable 60,00,000 (₹15,78,720)', R(1578720), t.totalAnnualTaxMinor);
}

// --- SURCHARGE MARGINAL RELIEF (docs/05 §2.5; Finance Act proviso). ₹10 over a
//   band edge must NOT trigger the full banded surcharge: (tax+surcharge) is
//   capped at taxAtThreshold + (income − threshold). Hand-derived to the paise.
//
//   NEW ₹50,00,010 (>₹50L, 10% band):
//     slab tax at 50L = ₹10,80,000; +30%×₹10 = ₹3 -> tax 10,80,003 (108000300p).
//     raw surcharge 10%×10,80,003 = 1,08,000.30. taxAtThreshold (NEW @50L) =
//     10,80,000 (108000000p); excess income ₹10 (1000p); cap = 108001000p.
//     relief: surcharge = cap − tax = 108001000 − 108000300 = 700p (₹7).
//     tax+sur = 108001000; cess 4% = 4,32,004 (4320040p);
//     total = 108001000 + 4320040 = 112321040p = ₹11,23,210.40.
//   (Without relief this would be ₹12,35,523 — a ₹1.12L cliff for ₹10 income.)
{
  const t = annualTaxNewRegime(5000010);
  check('Marginal relief NEW ₹50,00,010 surcharge -> ₹7', 700, t.surchargeMinor);
  check('Marginal relief NEW ₹50,00,010 total -> ₹11,23,210.40', 112321040, t.totalAnnualTaxMinor);
  // continuity: ₹10 over the edge costs only the marginal ₹10.40 of tax, not lakhs.
  check('Marginal relief NEW continuity (₹50L total ₹11,23,200)', R(1123200), annualTaxNewRegime(5000000).totalAnnualTaxMinor);
}

//   NEW ₹1,00,00,010 (>₹1cr, 15% band):
//     slab tax at 1cr+10 = ₹25,80,003 (258000300p; ₹25,80,000 + 30%×₹10).
//     taxAtThreshold = FULL liability @1cr = income-tax 25,80,000 + the 10%-band
//     surcharge ALREADY due at the ₹1cr edge (2,58,000) = ₹28,38,000 (283800000p).
//     [The 10%-band surcharge at exactly ₹1cr carries no marginal relief — ₹1cr is
//      not strictly above the 1cr edge, so it sits in the 10% band and the relief
//      proviso for THAT band is anchored at ₹50L where surcharge=0; recursion ends.]
//     excess income ₹10 (1000p); cap = 283800000 + 1000 = 283801000p.
//     raw 15% surcharge = 38,70,004.50 -> relief binds: surcharge = cap − tax =
//       283801000 − 258000300 = 25800700p (₹2,58,007).
//     tax+sur = 283801000; cess 4% = 11,35,204 (11352040p);
//     total = 295153040p = ₹29,51,530.40.
//     MONOTONIC: @1cr total ₹29,51,520.00 -> @1cr+10 ₹29,51,530.40 (RISES by the
//     marginal ₹10.40). [The earlier income-tax-ONLY threshold under-capped to
//     ₹26,83,210.40 — a ₹2.68L backwards DROP for ₹10 more income.]
{
  const t = annualTaxNewRegime(10000010);
  check('Marginal relief NEW ₹1,00,00,010 surcharge -> ₹2,58,007', 25800700, t.surchargeMinor);
  check('Marginal relief NEW ₹1,00,00,010 total -> ₹29,51,530.40', 295153040, t.totalAnnualTaxMinor);
}

//   NEW ₹2,00,00,010 (>₹2cr, 25%-capped band):
//     slab tax at 2cr+10 = ₹55,80,003 (558000300p; ₹55,80,000 + 30%×₹10).
//     taxAtThreshold = FULL liability @2cr = income-tax 55,80,000 + the 15%-band
//     surcharge ALREADY due at the ₹2cr edge (8,37,000) = ₹64,17,000 (641700000p).
//     excess income ₹10 (1000p); cap = 641700000 + 1000 = 641701000p.
//     raw 25% surcharge = 1,39,50,000.75 -> relief binds: surcharge = cap − tax =
//       641701000 − 558000300 = 83700700p (₹8,37,007).
//     tax+sur = 641701000; cess 4% = 25,66,804 (25668040p);
//     total = 667369040p = ₹66,73,690.40.
//     MONOTONIC: @2cr total ₹66,73,680.00 -> @2cr+10 ₹66,73,690.40 (RISES by the
//     marginal ₹10.40). [The earlier income-tax-ONLY threshold under-capped to
//     ₹58,03,210.40 — a ₹8.70L backwards DROP for ₹10 more income.]
{
  const t = annualTaxNewRegime(20000010);
  check('Marginal relief NEW ₹2,00,00,010 surcharge -> ₹8,37,007', 83700700, t.surchargeMinor);
  check('Marginal relief NEW ₹2,00,00,010 total -> ₹66,73,690.40', 667369040, t.totalAnnualTaxMinor);
}

// --- TDS monthly via compute() with explicit annual projection override.
//   docs/05 §7.1 averaging: annual tax ÷ remaining months − YTD.
//   Annual projection ₹18,00,000 (override), monthsElapsed 0 -> remaining 12,
//   no YTD TDS. Taxable = 18,00,000 − 75,000 = 17,25,000 -> annual tax ₹1,50,800.
//   Monthly TDS = 1,50,800 / 12 = 12,566.67 -> round nearest ₹1 = ₹12,567
//   (docs/05 §2.6 monthly TDS = 12,567). = 1256700 paise.
{
  const r = computeTds({
    periodGrossMinor: R(150000),
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
    period: { end: '2025-04-30' },
    employee: { hasPan: true },
    annualProjectionOverrideMinor: R(1800000),
  });
  check('TDS monthly ₹18L/yr (₹12,567)', R(12567), r.monthlyTdsMinor);
}

// --- T16 (docs/05 §16.2, §17 T16): No PAN -> 20% u/s 206AA.
//   Annual projection ₹18,00,000 (override). Taxable 17,25,000.
//   206AA = 20% of taxable 17,25,000 = ₹3,45,000 annual = 34500000 paise.
//   Monthly (÷12, monthsElapsed 0) = 3,45,000/12 = 28,750 = 2875000 paise.
//   (20% flat exceeds normal ₹1,50,800, so 206AA applies.)
{
  const r = computeTds({
    periodGrossMinor: R(150000),
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
    period: { end: '2025-04-30' },
    employee: { hasPan: false },
    annualProjectionOverrideMinor: R(1800000),
  });
  check('T16 no-PAN 206AA annual (₹3,45,000)', R(345000), r.annualTaxMinor);
  check('T16 no-PAN 206AA monthly (₹28,750)', R(28750), r.monthlyTdsMinor);
}

// --- Mid-year joiner projection (docs/05 §7.1): joins month 7 of FY, monthsElapsed 6,
//   monthsRemaining 6. Period gross ₹2,00,000/mo. No override -> projected annual
//   = YTD gross 0 + 2,00,000 × 6 = 12,00,000. Taxable = 12,00,000 − 75,000 = 11,25,000.
//   ≤12L -> §87A nil -> annual tax 0 -> monthly TDS 0 (docs/05 §7.2 nil case).
{
  const r = computeTds({
    periodGrossMinor: R(200000),
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 6 },
    period: { end: '2025-10-31' },
    employee: { hasPan: true },
  });
  check('Mid-year joiner projected taxable nil -> TDS 0', 0, r.monthlyTdsMinor);
  check('Mid-year joiner projected annual gross ₹12,00,000', R(1200000), r.projectedAnnualGrossMinor);
}

// --- Mid-year joiner WITH tax: monthsElapsed 6, period gross ₹3,00,000/mo.
//   Projected annual = 3,00,000 × 6 = 18,00,000. Taxable 17,25,000 -> annual ₹1,50,800.
//   Less YTD TDS 0; ÷ remaining 6 = 1,50,800/6 = 25,133.33 -> ₹25,133 = 2513300 paise.
{
  const r = computeTds({
    periodGrossMinor: R(300000),
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 6 },
    period: { end: '2025-10-31' },
    employee: { hasPan: true },
  });
  check('Mid-year joiner annual tax (₹1,50,800)', R(150800), r.annualTaxMinor);
  check('Mid-year joiner monthly TDS over 6 mo (₹25,133)', R(25133), r.monthlyTdsMinor);
}

// ===========================================================================
// SECTION E — Gratuity (docs/05 §8)
// ===========================================================================

// --- T13 (docs/05 §8.3, §17 T13): last drawn Basic+DA ₹60,000, service 8y7m.
//   7 months >= 6 -> rounds up -> 9 completed years.
//   Gratuity = 60,000 × 15 × 9 / 26 = 3,11,538.4615... ->
//     in paise: 6000000 × 15 × 9 / 26 = 31153846.15 -> roundHalfUp = 31153846 paise
//     = ₹3,11,538.46 (doc presents whole-rupee ₹3,11,538). Below ₹20L -> fully exempt.
{
  const g = computeGratuity({ lastDrawnBasicDaMinor: R(60000), serviceYears: 8, serviceMonths: 7 });
  check('T13 gratuity completed years (9)', 9, g.completedYears);
  check('T13 gratuity gross paise (₹3,11,538.46)', 31153846, g.grossMinor);
  check('T13 gratuity exempt = gross (<20L)', 31153846, g.exemptMinor);
  check('T13 gratuity taxable = 0', 0, g.taxableMinor);
}

// --- Gratuity not eligible: 4y service (<5y) -> 0 (docs/05 §8.1).
{
  const g = computeGratuity({ lastDrawnBasicDaMinor: R(50000), serviceYears: 4, serviceMonths: 0 });
  check('Gratuity <5y not eligible', false, g.eligible);
  check('Gratuity <5y gross 0', 0, g.grossMinor);
}

// --- Gratuity over the ₹20,00,000 exempt cap (docs/05 §8.1).
//   Basic+DA ₹2,00,000, 30 completed years: 2,00,000 × 15 × 30 / 26 = 34,61,538.46.
//   paise: 20000000 × 15 × 30 / 26 = 346153846.15 -> 346153846 paise.
//   Exempt capped at ₹20,00,000 = 200000000 paise; taxable = 146153846 paise.
{
  const g = computeGratuity({ lastDrawnBasicDaMinor: R(200000), serviceYears: 30, serviceMonths: 0 });
  check('Gratuity >cap gross (₹34,61,538.46)', 346153846, g.grossMinor);
  check('Gratuity >cap exempt = ₹20,00,000', 200000000, g.exemptMinor);
  check('Gratuity >cap taxable excess', 146153846, g.taxableMinor);
}

// ===========================================================================
// SECTION F — WAGES 50% cascade & deemed add-back (docs/05 §3)
// ===========================================================================

// --- T15 (docs/05 §3.1, §17 T15): basic 35% of gross -> breach + add-back.
//   Gross ₹1,00,000, Basic+DA ₹35,000 (35%). asOf post 21-Nov-2025.
//   50% floor = ₹50,000 > 35,000 -> breach. Deemed wages = floor ₹50,000 = 5000000 paise.
{
  const w = computeStatutoryWages({ periodGrossMinor: R(100000), basicDaMinor: R(35000),
    asOf: '2025-12-31' });
  check('T15 50% breach flag', true, w.breach);
  check('T15 deemed wages add-back to ₹50,000', R(50000), w.wagesMinor);
}

// --- 50%-compliant structure: Basic+DA ₹55,000 of ₹1,00,000 (55%) -> no breach.
//   wages = basic as-is = ₹55,000 = 5500000 paise.
{
  const w = computeStatutoryWages({ periodGrossMinor: R(100000), basicDaMinor: R(55000),
    asOf: '2025-12-31' });
  check('Compliant 55% no breach', false, w.breach);
  check('Compliant wages = basic ₹55,000', R(55000), w.wagesMinor);
}

// --- T18 (docs/05 §3.3, §17 T18): recompute an OCT-2025 (pre 21-Nov-2025) payslip.
//   Rule effective 2025-11-21 -> NOT applied. Basic 35% must NOT be added back.
//   wages = basic as-is = ₹35,000; no breach flagged.
{
  const w = computeStatutoryWages({ periodGrossMinor: R(100000), basicDaMinor: R(35000),
    asOf: '2025-10-31' });
  check('T18 Oct-2025 rule not applied: no breach', false, w.breach);
  check('T18 Oct-2025 wages = basic (no add-back)', R(35000), w.wagesMinor);
  check('T18 Oct-2025 ruleApplied flag false', false, w.ruleApplied);
}

// ===========================================================================
// SECTION G — End-to-end compute() integration (docs/05 §16.1 pipeline)
// ===========================================================================

// --- Integration: MH employee, gross ₹50,000, Basic+DA ₹30,000 (60% -> compliant),
//   June (no Feb top-up), has PAN, ESI not applicable (gross >21k), KA/MH PT.
//   Expected statutory lines:
//     EPF (cap policy default): PFWage = min(30000,15000)=15000 -> EE ₹1,800 = 180000
//     EPS ₹1,250 = 125000; EPF_ER ₹550 = 55000; EDLI ₹75 = 7500; ADMIN ₹500 = 50000
//     ESI: gross ₹50,000 > ₹21,000 ceiling; latch not covered -> NO ESI line
//     PT MH male June > ₹10,000 -> ₹200 = 20000
//   TDS: projected annual = gross 50,000 × 12 = 6,00,000; taxable 5,25,000;
//     slab tax = 5%×(5,25,000−4,00,000=1,25,000)=6,250; ≤12L -> §87A nil -> 0 -> no TDS line.
{
  const out = IN.compute({
    periodGrossMinor: R(50000),
    basicMinor: R(30000),
    components: [],
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: false },
    period: { end: '2025-06-30', year: 2025, month: 6 },
    employee: { hasPan: true, gender: 'male' },
    entity: { stateCode: 'MH', pfApplicable: true, esiApplicable: true,
      establishmentHasContributoryMember: true },
  });
  check('E2E EPF-EE line', R(1800), amt(out.employeeDeductions, 'EPF'));
  check('E2E EPS_ER line', R(1250), amt(out.employerContributions, 'EPS_ER'));
  check('E2E EPF_ER line', R(550), amt(out.employerContributions, 'EPF_ER'));
  check('E2E EDLI line', R(75), amt(out.employerContributions, 'EDLI'));
  check('E2E ADMIN floor line', R(500), amt(out.employerContributions, 'ADMIN'));
  check('E2E no ESI line (gross >21k, not latched)', null, amt(out.employeeDeductions, 'ESI'));
  check('E2E PT MH male June (₹200)', R(200), amt(out.employeeDeductions, 'PT'));
  check('E2E no TDS line (taxable <=12L, §87A nil)', null, amt(out.employeeDeductions, 'TDS'));
}

// --- Integration: ESI-eligible employee, gross ₹19,000, latched covered, GJ state.
//   ESI EE ₹143, ER ₹618 (docs/05 §5.4). GJ PT >₹12,000 -> ₹200 (docs/05 §6.1 GJ).
//   NOTE: GJ is in the doc's PT table (§6.1) but the engine's professionalTax.states
//   only seeds MH/KA/TN. If GJ is unconfigured the PT line will be ABSENT — this
//   asserts the doc value ₹200 and will surface that gap as a discrepancy.
{
  const out = IN.compute({
    periodGrossMinor: R(19000),
    basicMinor: R(12000),
    components: [],
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: true },
    period: { end: '2025-06-30', year: 2025, month: 6 },
    employee: { hasPan: true, gender: 'male' },
    entity: { stateCode: 'GJ', pfApplicable: true, esiApplicable: true },
  });
  check('E2E ESI-EE ₹19k (₹143)', R(143), amt(out.employeeDeductions, 'ESI'));
  check('E2E ESI-ER ₹19k (₹618)', R(618), amt(out.employerContributions, 'ESI_ER'));
  check('E2E GJ PT >₹12,000 (₹200 per docs §6.1)', R(200), amt(out.employeeDeductions, 'PT'));
}

// ===========================================================================
// SECTION F — FEATURE 15: ANNUAL IT PROJECTION (OLD regime + HRA + Chapter VI-A
//   + perquisites + §192 parity). Every expected derived BY HAND from the
//   Income-tax Act slabs/caps and the engine's PUBLIC contract only.
// ===========================================================================

const {
  annualTaxOldRegime,
  hraExemption,
  chapterVIADeductions,
  perquisiteValue,
  projectAnnualIncomeTax,
  monthlyTaxRecoverable,
} = IN._internals;

// --- F1: annualTaxOldRegime slab walk (taxable ₹5,35,000).
//   0–2.5L nil; 2.5–5L @5% = 12,500; 5–5.35L @20% = 35,000×20% = 7,000.
//   slab tax = 19,500. taxable > 5L => no §87A. surcharge 0. cess 4% × 19,500 = 780.
//   total = 20,280.
{
  const t = annualTaxOldRegime(535000);
  check('F1 OLD slab tax (taxable 5.35L) -> ₹19,500', R(19500), t.taxAfterReliefMinor);
  check('F1 OLD cess 4% -> ₹780', R(780), t.cessMinor);
  check('F1 OLD total tax -> ₹20,280', R(20280), t.totalAnnualTaxMinor);
}

// --- F2: §87A OLD-regime rebate (taxable ₹4,50,000 <= ₹5L ceiling).
//   2.5–4.5L @5% = 2,00,000×5% = 10,000. rebate min(10,000, 12,500) = 10,000 -> 0.
{
  const t = annualTaxOldRegime(450000);
  check('F2 OLD §87A rebate (taxable 4.5L) -> NIL', 0, t.totalAnnualTaxMinor);
}

// --- F3: OLD slabs at ₹10,00,000 and ₹15,00,000 (top slab walk).
//   10L: 2.5–5@5%=12,500; 5–10@20%=1,00,000 => 1,12,500; cess 4,500 -> 1,17,000.
//   15L: + 10–15@30%=1,50,000 => 2,62,500; cess 10,500 -> 2,73,000.
{
  check('F3 OLD taxable 10L -> ₹1,17,000', R(117000), annualTaxOldRegime(1000000).totalAnnualTaxMinor);
  check('F3 OLD taxable 15L -> ₹2,73,000', R(273000), annualTaxOldRegime(1500000).totalAnnualTaxMinor);
}

// --- F3b: SURCHARGE MARGINAL RELIEF (OLD regime). Same proviso as NEW; bands are
//   regime-independent. ₹10 over each edge must not trigger the full surcharge.
//
//   OLD ₹50,00,010 (>₹50L, 10% band):
//     slab tax at 50L = ₹13,12,500; +30%×₹10 = ₹3 -> tax 13,12,503 (131250300p).
//     taxAtThreshold (OLD @50L) = 13,12,500 (131250000p); excess ₹10 (1000p);
//     cap = 131251000p. surcharge = 131251000 − 131250300 = 700p (₹7).
//     tax+sur = 131251000; cess 4% = 5,25,004 (5250040p);
//     total = 136501040p = ₹13,65,010.40. (Without relief: ₹15,01,503.)
{
  const t = annualTaxOldRegime(5000010);
  check('F3b marginal relief OLD ₹50,00,010 surcharge -> ₹7', 700, t.surchargeMinor);
  check('F3b marginal relief OLD ₹50,00,010 total -> ₹13,65,010.40', 136501040, t.totalAnnualTaxMinor);
  check('F3b OLD continuity (₹50L total ₹13,65,000)', R(1365000), annualTaxOldRegime(5000000).totalAnnualTaxMinor);
}

//   OLD ₹1,00,00,010 (>₹1cr, 15% band):
//     slab tax at 1cr+10 = ₹28,12,503 (281250300p; ₹28,12,500 + 30%×₹10).
//     taxAtThreshold = FULL liability @1cr = income-tax 28,12,500 + the 10%-band
//     surcharge ALREADY due at the ₹1cr edge (2,81,250) = ₹30,93,750 (309375000p).
//     excess income ₹10 (1000p); cap = 309375000 + 1000 = 309376000p.
//     raw 15% surcharge = 42,18,754.50 -> relief binds: surcharge = cap − tax =
//       309376000 − 281250300 = 28125700p (₹2,81,257).
//     tax+sur = 309376000; cess 4% = 12,37,504 (12375040p);
//     total = 321751040p = ₹32,17,510.40.
//     MONOTONIC: @1cr total ₹32,17,500.00 -> @1cr+10 ₹32,17,510.40 (RISES ₹10.40).
{
  const t = annualTaxOldRegime(10000010);
  check('F3b marginal relief OLD ₹1,00,00,010 surcharge -> ₹2,81,257', 28125700, t.surchargeMinor);
  check('F3b marginal relief OLD ₹1,00,00,010 total -> ₹32,17,510.40', 321751040, t.totalAnnualTaxMinor);
}

//   OLD ₹2,00,00,010 (>₹2cr, 25%-capped band):
//     slab tax at 2cr+10 = ₹58,12,503 (581250300p; ₹58,12,500 + 30%×₹10).
//     taxAtThreshold = FULL liability @2cr = income-tax 58,12,500 + the 15%-band
//     surcharge ALREADY due at the ₹2cr edge (8,71,875) = ₹66,84,375 (668437500p).
//     excess income ₹10 (1000p); cap = 668437500 + 1000 = 668438500p.
//     raw 25% surcharge = 1,45,31,257.50 -> relief binds: surcharge = cap − tax =
//       668438500 − 581250300 = 87188200p (₹8,71,882).
//     tax+sur = 668438500; cess 4% = 26,73,754 (26737540p);
//     total = 695176040p = ₹69,51,760.40.
//     MONOTONIC: @2cr total ₹69,51,750.00 -> @2cr+10 ₹69,51,760.40 (RISES ₹10.40).
{
  const t = annualTaxOldRegime(20000010);
  check('F3b marginal relief OLD ₹2,00,00,010 surcharge -> ₹8,71,882', 87188200, t.surchargeMinor);
  check('F3b marginal relief OLD ₹2,00,00,010 total -> ₹69,51,760.40', 695176040, t.totalAnnualTaxMinor);
}

// --- F3c: SURCHARGE-EDGE MONOTONICITY (regression lock for the 1cr/2cr cliff).
//   Statutory invariant: total annual tax must be NON-DECREASING in income across
//   EVERY surcharge band edge — ₹50L, ₹1cr, ₹2cr (and ₹5cr, well inside the
//   25%-capped top band) — for BOTH regimes. The original F15 fix wired the
//   marginal-relief cap to income-tax ONLY (omitting the surcharge already due at
//   the ₹1cr/₹2cr edge), which made total tax DROP by lakhs for ₹10 more income —
//   a backwards cliff. These assertions sweep a fine ladder across each edge and
//   require strict monotonicity, so the cliff can never silently return.
//   (At ₹50L surcharge genuinely starts at 0, so the marginal-relief recursion
//   bottoms out there; ₹5cr sits inside the capped 25% band — no separate edge.)
{
  // Income ladder in RUPEES: just below / at / just above each edge, plus a span
  // climbing into each band and the ₹5cr capped-band sample. Strictly increasing.
  const ladder = [
    4999990, 5000000, 5000010, 6000000, 7500000,           // around / above ₹50L
    9999990, 10000000, 10000010, 15000000,                 // around / above ₹1cr
    19999990, 20000000, 20000010, 30000000, 50000000,      // around / above ₹2cr, incl ₹5cr
  ];
  for (const regimeName of ['NEW', 'OLD']) {
    const fn = regimeName === 'NEW' ? annualTaxNewRegime : annualTaxOldRegime;
    let prevIncome = null;
    let prevTotal = -1;
    let monotone = true;
    let firstBreak = null;
    for (const income of ladder) {
      const total = fn(income).totalAnnualTaxMinor;
      if (total < prevTotal) {
        monotone = false;
        if (!firstBreak) {
          firstBreak = `${regimeName} ₹${prevIncome}->₹${income}: total ${prevTotal}p DROPPED to ${total}p`;
        }
      }
      prevIncome = income;
      prevTotal = total;
    }
    check(`F3c monotonic total tax across surcharge edges (${regimeName})` +
      (firstBreak ? ` — ${firstBreak}` : ''), true, monotone);
  }
  // Pin the cliff direction explicitly at the two edges the bug inverted: a ₹10
  // step OVER each edge must cost MORE, never less (strict, both regimes).
  for (const regimeName of ['NEW', 'OLD']) {
    const fn = regimeName === 'NEW' ? annualTaxNewRegime : annualTaxOldRegime;
    check(`F3c ${regimeName} 1cr edge: +₹10 over costs more (no cliff)`,
      true, fn(10000010).totalAnnualTaxMinor > fn(10000000).totalAnnualTaxMinor);
    check(`F3c ${regimeName} 2cr edge: +₹10 over costs more (no cliff)`,
      true, fn(20000010).totalAnnualTaxMinor > fn(20000000).totalAnnualTaxMinor);
  }
}

// --- F4: HRA exemption least-of-three (§10(13A)).
//   Basic+DA 6L, received 2.4L, rent 3L, metro.
//   legs: received 2.4L; rent-10%(6L)=3L-60k=2.4L; 50%×6L=3L. least=2.4L (received/rentMinus10 tie).
{
  const hra = hraExemption({ basicDaAnnualMinor: R(600000), hraReceivedAnnualMinor: R(240000), rentPaidAnnualMinor: R(300000), metro: true });
  check('F4 HRA exempt least-of-three -> ₹2,40,000', R(240000), hra.exemptMinor);
  check('F4 HRA rentMinus10 leg -> ₹2,40,000', R(240000), hra.legs.rentMinus10);
  check('F4 HRA pctOfSalary leg (50% metro) -> ₹3,00,000', R(300000), hra.legs.pctOfSalary);
}

// --- F4b: HRA rent-minus-10% binds (low rent ₹1,00,000).
//   rent-10%(6L)=1L-60k=40k; received 2.4L; 50%=3L. least=40k.
{
  const hra = hraExemption({ basicDaAnnualMinor: R(600000), hraReceivedAnnualMinor: R(240000), rentPaidAnnualMinor: R(100000), metro: true });
  check('F4b HRA exempt (rent binds) -> ₹40,000', R(40000), hra.exemptMinor);
  check('F4b HRA leastLeg = rentMinus10', 'rentMinus10', hra.leastLeg);
}

// --- F5: Chapter VI-A caps. 80C gross 1.8L -> cap 1.5L; 80CCD(1B) separate 50k;
//   80D gross 28k -> cap 25k. total deductible = 1.5L + 50k + 25k = 2.25L.
{
  const chap = chapterVIADeductions({ sec80cGrossMinor: R(180000), sec80ccd1bGrossMinor: R(50000), sec80dGrossMinor: R(28000) });
  const c80c = chap.lines.find((l) => l.section === '80C');
  check('F5 80C gross -> ₹1,80,000', R(180000), c80c.grossMinor);
  check('F5 80C capped deductible -> ₹1,50,000', R(150000), c80c.deductibleMinor);
  const c1b = chap.lines.find((l) => l.section === '80CCD(1B)');
  check('F5 80CCD(1B) separate ₹50,000 (does not eat 80C cap)', R(50000), c1b.deductibleMinor);
  const c80d = chap.lines.find((l) => l.section === '80D');
  check('F5 80D capped -> ₹25,000', R(25000), c80d.deductibleMinor);
  check('F5 total deductible -> ₹2,25,000', R(225000), chap.totalDeductibleMinor);
}

// --- F6: perquisites. Rent-free employer-OWNED accommodation in a >40L city,
//   salary (Basic+DA) 6L -> 10% = ₹60,000.
{
  const perq = perquisiteValue({ accom: { provided: true, leased: false, cityPopBand: '>40L' }, salaryAnnualMinor: R(600000) });
  check('F6 owned-accom perq (10% of 6L) -> ₹60,000', R(60000), perq.totalMinor);
}

// --- F6b: concessional loan perq. avg outstanding 5L, charged 2%, SBI benchmark
//   8.5% -> spread 6.5% × 5L = ₹32,500.
{
  const perq = perquisiteValue({ loan: { avgOutstandingAnnualMinor: R(500000), rateChargedPct: 2 } });
  check('F6b concessional-loan perq (6.5% × 5L) -> ₹32,500', R(32500), perq.totalMinor);
}

// --- F7: projectAnnualIncomeTax OLD-regime end-to-end (the Figma statement spine).
//   Basic+DA 6L, HRA 2.4L, other 1.2L, residual 90k -> gross 10.5L.
//   HRA exempt 2.4L -> 8.1L; std 50k; Chapter VI-A 2.25L -> taxable 5.35L.
//   tax 19,500 + cess 780 = ₹20,280.
{
  const out = projectAnnualIncomeTax({
    regime: 'OLD',
    annualEarnings: { basicDaMinor: R(600000), hraReceivedMinor: R(240000), otherAllowancesMinor: R(120000), residualChoicePayMinor: R(90000) },
    hraInput: { hraReceivedAnnualMinor: R(240000), rentPaidAnnualMinor: R(300000), metro: true },
    chapterVIAInput: { sec80cGrossMinor: R(180000), sec80ccd1bGrossMinor: R(50000), sec80dGrossMinor: R(28000) },
    hasPan: true,
  });
  check('F7 OLD gross salary -> ₹10,50,000', R(1050000), out.grossSalaryMinor);
  check('F7 OLD HRA exemption -> ₹2,40,000', R(240000), out.hraExemptionMinor);
  check('F7 OLD gross after exemption -> ₹8,10,000', R(810000), out.grossAfterExemptMinor);
  check('F7 OLD total taxable -> ₹5,35,000', R(535000), out.taxableIncomeMinor);
  check('F7 OLD tax payable -> ₹19,500', R(19500), out.taxPayableMinor);
  check('F7 OLD cess -> ₹780', R(780), out.cessMinor);
  check('F7 OLD total tax -> ₹20,280', R(20280), out.totalAnnualTaxMinor);
}

// --- F20: Feature 20 — the DECLARED→VERIFIED TDS switch drives the engine.
//   The pure aggregator (amountForSection) computes the section amount; the SAME
//   engine consumes it. We prove: declared 80C ₹1.5L (fully relieved) vs verified
//   ₹90k (only ₹90k relieved) → taxable rises by exactly ₹60,000 → tax rises by the
//   exact 20%+cess slab delta (₹12,480), and the run TDS == projection to the paise.
//   Worked by hand: gross 18L, OLD regime, std 50k, 80C the only deduction.
//     declared:  taxable = 18L − 50k − 1.5L = 16,00,000
//     verified:  taxable = 18L − 50k − 0.9L = 16,60,000  (Δ +60,000)
//   Both sit in the 20% slab (₹5L–₹10L 20% then ₹10L+ 30% under OLD) — the ₹60,000
//   delta is fully in the 30% band, so Δtax = 60,000×30%×1.04(cess) = ₹18,720.
{
  const { amountForSection } = require('../../tax/investmentProof/proofAggregator');
  const earnings = { basicDaMinor: R(1200000), hraReceivedMinor: 0, otherAllowancesMinor: R(600000), residualChoicePayMinor: 0 };
  const declaredMinor = R(150000);
  const acceptedProofs = [{ claimType: 'SEC_80C', status: 'ACCEPTED', verifiedAmount: 90000, deletedAt: null }];

  // Pre-deadline (useVerified=false) → used == declared 1.5L.
  const pre = amountForSection({ declaredMinor, proofs: acceptedProofs, claimType: 'SEC_80C', useVerified: false });
  check('F20 pre-deadline 80C used = declared 1.5L', R(150000), pre.usedMinor);
  check('F20 pre-deadline basis DECLARED', 'DECLARED', pre.basis);

  // Post-deadline (useVerified=true) → used == min(1.5L, Σ90k) = 90k.
  const post = amountForSection({ declaredMinor, proofs: acceptedProofs, claimType: 'SEC_80C', useVerified: true });
  check('F20 post-deadline 80C used = verified 90k', R(90000), post.usedMinor);
  check('F20 post-deadline basis VERIFIED', 'VERIFIED', post.basis);

  const declaredOut = projectAnnualIncomeTax({ regime: 'OLD', annualEarnings: earnings, chapterVIAInput: { sec80cGrossMinor: pre.usedMinor }, hasPan: true });
  const verifiedOut = projectAnnualIncomeTax({ regime: 'OLD', annualEarnings: earnings, chapterVIAInput: { sec80cGrossMinor: post.usedMinor }, hasPan: true });

  check('F20 declared taxable -> ₹16,00,000', R(1600000), declaredOut.taxableIncomeMinor);
  check('F20 verified taxable -> ₹16,60,000 (+60k)', R(1660000), verifiedOut.taxableIncomeMinor);
  check('F20 taxable rises by exactly ₹60,000', R(60000), verifiedOut.taxableIncomeMinor - declaredOut.taxableIncomeMinor);
  // ₹60,000 of extra taxable in the 30% slab → 18,000 tax + 4% cess = ₹18,720 more.
  check('F20 tax rises by the exact slab delta (₹18,720)', R(18720), verifiedOut.totalAnnualTaxMinor - declaredOut.totalAnnualTaxMinor);

  // PARITY: the run TDS (computeTds with the verified taxable override) == the
  // projection's monthly recoverable, to the paise — the §201 control biting cleanly.
  const tds = computeTds({
    periodGrossMinor: R(150000),
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
    period: { end: '2026-04-30', year: 2026, month: 4 },
    employee: { hasPan: true, taxRegime: 'OLD' },
    annualProjectionOverrideMinor: R(1800000),
    annualTaxableOverrideMinor: verifiedOut.taxableIncomeMinor,
  });
  const sched = monthlyTaxRecoverable({
    totalAnnualTaxMinor: verifiedOut.totalAnnualTaxMinor,
    tdsDeductedThisFYMinor: 0, prevEmployerTdsMinor: 0, monthsRemaining: 12, startMonth: '2026-04',
  });
  check('F20 PARITY: run TDS === projection monthly (post-deadline verified)', tds.monthlyTdsMinor, sched.monthlyRecoverableMinor);
}

// --- F8: projectAnnualIncomeTax NEW-regime parity with the doc T1 (gross 18L).
//   std ded 75k -> taxable 17.25L -> annual tax ₹1,50,800 (docs/05 §2.6).
{
  const out = projectAnnualIncomeTax({
    regime: 'NEW',
    annualEarnings: { basicDaMinor: R(900000), hraReceivedMinor: 0, otherAllowancesMinor: R(900000), residualChoicePayMinor: 0 },
    hasPan: true,
  });
  check('F8 NEW taxable (18L − 75k std) -> ₹17,25,000', R(1725000), out.taxableIncomeMinor);
  check('F8 NEW total tax -> ₹1,50,800', R(150800), out.totalAnnualTaxMinor);
}

// --- F9: §192 PARITY — the statement's monthly recoverable MUST equal the live
//   run's computeTds() monthly TDS line, to the paise, for the SAME annual gross.
//   gross 18L, no YTD, 12 months remaining -> monthly ₹12,567 (docs/05 §2.6).
{
  const annualGross = R(1800000);
  const projected = projectAnnualIncomeTax({
    regime: 'NEW',
    annualEarnings: { basicDaMinor: R(900000), hraReceivedMinor: 0, otherAllowancesMinor: R(900000), residualChoicePayMinor: 0 },
    hasPan: true,
  });
  const tds = computeTds({
    periodGrossMinor: R(150000),
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
    period: { end: '2025-04-30', year: 2025, month: 4 },
    employee: { hasPan: true },
    annualProjectionOverrideMinor: annualGross,
  });
  const sched = monthlyTaxRecoverable({
    totalAnnualTaxMinor: projected.totalAnnualTaxMinor,
    tdsDeductedThisFYMinor: 0,
    prevEmployerTdsMinor: 0,
    monthsRemaining: 12,
    startMonth: '2025-04',
  });
  check('F9 computeTds monthly TDS -> ₹12,567', R(12567), tds.monthlyTdsMinor);
  check('F9 PARITY: statement monthlyRecoverable === run TDS', tds.monthlyTdsMinor, sched.monthlyRecoverableMinor);
  check('F9 schedule length = 12', 12, sched.schedule.length);
  check('F9 schedule Σ === remainingTax (residual absorbed)', sched.remainingTaxMinor, sched.schedule.reduce((a, s) => a + s.amountMinor, 0));
  check('F9 schedule first month', '2025-04', sched.schedule[0].month);
  check('F9 schedule last month', '2026-03', sched.schedule[11].month);
}

// --- F10: §192 PARITY mid-year (YTD deducted) — joiner with 3 months paid.
//   annual gross 18L, monthsElapsed 3, ytd TDS already 3×₹12,567 = ₹37,701.
//   computeTds: remaining = 150800 − 37701 = 113099 over 9 months -> ₹12,567/mo.
//   statement: same remaining over 9 months -> ₹12,567; residual on last month.
{
  const projected = projectAnnualIncomeTax({
    regime: 'NEW',
    annualEarnings: { basicDaMinor: R(900000), hraReceivedMinor: 0, otherAllowancesMinor: R(900000), residualChoicePayMinor: 0 },
    hasPan: true,
  });
  const ytdTds = R(12567) * 3;
  const tds = computeTds({
    periodGrossMinor: R(150000),
    ytd: { taxableGrossMinor: R(450000), tdsDeductedMinor: ytdTds, monthsElapsed: 3 },
    period: { end: '2025-07-31', year: 2025, month: 7 },
    employee: { hasPan: true },
    annualProjectionOverrideMinor: R(1800000),
  });
  const sched = monthlyTaxRecoverable({
    totalAnnualTaxMinor: projected.totalAnnualTaxMinor,
    tdsDeductedThisFYMinor: ytdTds,
    prevEmployerTdsMinor: 0,
    monthsRemaining: 9,
    startMonth: '2025-07',
  });
  check('F10 mid-year PARITY: statement === run TDS', tds.monthlyTdsMinor, sched.monthlyRecoverableMinor);
  check('F10 mid-year schedule length = 9', 9, sched.schedule.length);
  check('F10 mid-year schedule Σ === remaining', sched.remainingTaxMinor, sched.schedule.reduce((a, s) => a + s.amountMinor, 0));
}

// --- F11: NEW-regime structurally skips HRA/Chapter-VI-A — a stray declared 80C
//   cannot leak a NEW-regime deduction. Same gross, declared 80C/HRA ignored.
{
  const withDecls = projectAnnualIncomeTax({
    regime: 'NEW',
    annualEarnings: { basicDaMinor: R(900000), hraReceivedMinor: 0, otherAllowancesMinor: R(900000), residualChoicePayMinor: 0 },
    hraInput: { hraReceivedAnnualMinor: R(240000), rentPaidAnnualMinor: R(300000), metro: true },
    chapterVIAInput: { sec80cGrossMinor: R(150000) },
    hasPan: true,
  });
  check('F11 NEW ignores HRA exemption -> 0', 0, withDecls.hraExemptionMinor);
  check('F11 NEW ignores Chapter VI-A -> null', null, withDecls.chapterVIA);
  check('F11 NEW total tax unchanged by stray decls -> ₹1,50,800', R(150800), withDecls.totalAnnualTaxMinor);
}

// --- F12: §206AA no-PAN 20% flat under projection (tax otherwise due).
//   OLD taxable 5.35L: normal tax 20,280 > 0, so 20% × 5.35L = ₹1,07,000 flat.
{
  const out = projectAnnualIncomeTax({
    regime: 'OLD',
    annualEarnings: { basicDaMinor: R(600000), hraReceivedMinor: R(240000), otherAllowancesMinor: R(120000), residualChoicePayMinor: R(90000) },
    hraInput: { hraReceivedAnnualMinor: R(240000), rentPaidAnnualMinor: R(300000), metro: true },
    chapterVIAInput: { sec80cGrossMinor: R(180000), sec80ccd1bGrossMinor: R(50000), sec80dGrossMinor: R(28000) },
    hasPan: false,
  });
  check('F12 no-PAN §206AA 20% flat on taxable -> ₹1,07,000', R(107000), out.totalAnnualTaxMinor);
  check('F12 no-PAN flag set', true, out.noPanApplied);
}

// --- F13: previous-employer income adds to taxable (guard handled by assembler).
//   OLD taxable would be 5.35L; prev-employer taxable +2L -> 7.35L.
//   tax: 2.5–5@5%=12,500; 5–7.35@20%=2,35,000×20%=47,000 => 59,500; cess 2,380 -> 61,880.
{
  const out = projectAnnualIncomeTax({
    regime: 'OLD',
    annualEarnings: { basicDaMinor: R(600000), hraReceivedMinor: R(240000), otherAllowancesMinor: R(120000), residualChoicePayMinor: R(90000) },
    hraInput: { hraReceivedAnnualMinor: R(240000), rentPaidAnnualMinor: R(300000), metro: true },
    chapterVIAInput: { sec80cGrossMinor: R(180000), sec80ccd1bGrossMinor: R(50000), sec80dGrossMinor: R(28000) },
    prevEmployer: { taxableIncomeMinor: R(200000) },
    hasPan: true,
  });
  check('F13 prev-employer taxable folded -> ₹7,35,000', R(735000), out.taxableIncomeMinor);
  check('F13 total tax with prev-employer -> ₹61,880', R(61880), out.totalAnnualTaxMinor);
}

// --- F14: §206AA no-PAN is HIGHER-OF (normal vs 20% flat), NOT an unconditional
//   flat. At a HIGH income the normal effective rate (30% slab + surcharge + 4%
//   cess) exceeds 20%, so the normal tax is kept and no-PAN tax must be >= with-PAN.
//   NEW Basic+DA ₹60,00,000: taxable 60L − 75k std = 59,25,000.
//     normal = ₹15,52,980 (incl. surcharge ₹1,35,750 + cess ₹59,730).
//     flat 20% × 59,25,000 = ₹11,85,000 < normal -> higher-of keeps normal.
//   The OLD bug applied flat ₹11,85,000 (LOWER) — a missing PAN cut the tax.
{
  const noPan = projectAnnualIncomeTax({ regime: 'NEW', annualEarnings: { basicDaMinor: R(6000000) }, hasPan: false });
  const withPan = projectAnnualIncomeTax({ regime: 'NEW', annualEarnings: { basicDaMinor: R(6000000) }, hasPan: true });
  check('F14 no-PAN §206AA higher-of keeps normal -> ₹15,52,980', R(1552980), noPan.totalAnnualTaxMinor);
  check('F14 no-PAN flag still set', true, noPan.noPanApplied);
  check('F14 no-PAN keeps surcharge (not zeroed) -> ₹1,35,750', R(135750), noPan.surchargeMinor);
  check('F14 no-PAN keeps cess (not zeroed) -> ₹59,730', R(59730), noPan.cessMinor);
  check('F14 no-PAN tax >= with-PAN tax (penal floor, never a discount)', true, noPan.totalAnnualTaxMinor >= withPan.totalAnnualTaxMinor);
}

// --- F15: §192 PARITY for OLD-regime employees. computeTds is REGIME-AWARE
//   (employee.taxRegime + a pre-computed taxable) so the live deduction reconciles
//   to the OLD-regime projection to the paise. (Old bug: computeTds hard-wired
//   NEW regime -> an OLD employee's payslip TDS never matched the projection.)
//   OLD projection taxable 5,35,000 -> total tax ₹20,280; computeTds fed that
//   taxable under OLD regime must also yield ₹20,280; monthly = 20,280/12 = ₹1,690.
{
  const proj = projectAnnualIncomeTax({
    regime: 'OLD',
    annualEarnings: { basicDaMinor: R(600000), hraReceivedMinor: R(240000), otherAllowancesMinor: R(120000), residualChoicePayMinor: R(90000) },
    hraInput: { hraReceivedAnnualMinor: R(240000), rentPaidAnnualMinor: R(300000), metro: true },
    chapterVIAInput: { sec80cGrossMinor: R(180000), sec80ccd1bGrossMinor: R(50000), sec80dGrossMinor: R(28000) },
    hasPan: true,
  });
  const tds = computeTds({
    periodGrossMinor: 0,
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
    period: { end: '2025-04-30', year: 2025, month: 4 },
    employee: { hasPan: true, taxRegime: 'OLD' },
    annualTaxableOverrideMinor: proj.taxableIncomeMinor,
  });
  check('F15 OLD-regime projection total -> ₹20,280', R(20280), proj.totalAnnualTaxMinor);
  check('F15 OLD-regime computeTds annual === projection (PARITY)', proj.totalAnnualTaxMinor, tds.annualTaxMinor);
  check('F15 OLD-regime computeTds monthly -> ₹1,690', R(1690), tds.monthlyTdsMinor);
}

// --- F25: FBP / Flexi Basket §192 PARITY — the live monthly TDS run must apply the
//   SAME FBP exemption the projection applies, via the single computeFbpExempt source,
//   so run TDS === projection TDS to the paise (no over-withholding).
//   OLD regime. Basic+DA ₹6,00,000 + otherAllowances ₹2,00,000 (Σ gross ₹8,00,000).
//   FBP basket post-deadline: LTA ₹40,000 verified + MEAL_CARD ₹26,400 (the card,
//   always-verified) = ₹66,400 exempt. Projection subtracts it:
//     otherAllowances 2,00,000 − 66,400 = 1,33,600 ; gross-after-exempt 7,33,600 ;
//     − OLD std 50,000 -> taxable 6,83,600 -> total tax ₹51,188.80 ; /12 -> ₹4,266/mo.
//   THE BUG (no override): the run annualised the FULL ₹8,00,000 gross (FBP head lines
//   all isTaxable), only the std deduction subtracted: taxable 7,50,000 ->
//   2.5-5L@5%=12,500 + 5-7.5L@20%=50,000 = 62,500 + 4% cess = ₹65,000 ; /12 -> ₹5,417/mo.
//   The fixed run hands computeTds the projection's taxable override and matches ₹4,266.
{
  const { computeFbpExempt } = require('../../tax/fbp/fbpAggregator');

  // The FBP exemption — the SINGLE source the run + projection both consume.
  const fbpHeads = [
    { id: 'lta', headType: 'LTA', claimType: 'FBP_LTA', annualCapMinor: null, monthlyCapMinor: null, proofRequired: true },
    { id: 'meal', headType: 'MEAL_CARD', claimType: null, annualCapMinor: R(26400), monthlyCapMinor: R(2200), proofRequired: false },
  ];
  const fbpAlloc = [{ headId: 'lta', annualAmountMinor: R(40000) }, { headId: 'meal', annualAmountMinor: R(26400) }];
  const fbpWindow = { proofDeadline: '2027-02-15' };
  const fbpProofs = [{ claimType: 'FBP_LTA', status: 'ACCEPTED', verifiedAmount: 40000, deletedAt: null }];
  const fbp = computeFbpExempt({ heads: fbpHeads, allocation: fbpAlloc, proofs: fbpProofs, window: fbpWindow, asOf: '2027-03-01', regime: 'OLD' });
  check('F25 FBP exempt total -> ₹66,400 (LTA 40k verified + meal 26.4k card)', R(66400), fbp.totalExemptMinor);

  // The projection — FBP exemption subtracted from otherAllowances (the buildEngineInput seam).
  const annualEarnings = { basicDaMinor: R(600000), hraReceivedMinor: 0, otherAllowancesMinor: R(200000), residualChoicePayMinor: 0 };
  const proj = projectAnnualIncomeTax({
    regime: 'OLD',
    annualEarnings: { ...annualEarnings, otherAllowancesMinor: Math.max(0, annualEarnings.otherAllowancesMinor - fbp.totalExemptMinor) },
    hasPan: true,
  });
  check('F25 projection taxable (gross-after-FBP 7,33,600 − std 50k) -> ₹6,83,600', R(683600), proj.taxableIncomeMinor);
  check('F25 projection total tax -> ₹51,188.80', 5118880, proj.totalAnnualTaxMinor);

  const sched = monthlyTaxRecoverable({
    totalAnnualTaxMinor: proj.totalAnnualTaxMinor, tdsDeductedThisFYMinor: 0, prevEmployerTdsMinor: 0,
    monthsRemaining: 12, startMonth: '2026-04',
  });

  // THE FIX: the run hands computeTds the projection's taxable override.
  const runFixed = computeTds({
    periodGrossMinor: 0,
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
    period: { end: '2026-04-30', year: 2026, month: 4 },
    employee: { hasPan: true, taxRegime: 'OLD' },
    annualTaxableOverrideMinor: proj.taxableIncomeMinor,
  });
  check('F25 PARITY: run annual tax === projection annual tax', proj.totalAnnualTaxMinor, runFixed.annualTaxMinor);
  check('F25 PARITY: run monthly TDS === projection monthly recoverable', sched.monthlyRecoverableMinor, runFixed.monthlyTdsMinor);
  check('F25 run monthly TDS -> ₹4,266', R(4266), runFixed.monthlyTdsMinor);

  // THE BUG it fixes: without the override the run annualises the full taxable gross
  // (FBP head lines included) and OVER-withholds. Asserted so the regression is pinned.
  const runBug = computeTds({
    periodGrossMinor: Math.round(R(800000) / 12),
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
    period: { end: '2026-04-30', year: 2026, month: 4 },
    employee: { hasPan: true, taxRegime: 'OLD' },
    annualProjectionOverrideMinor: R(800000),
  });
  check('F25 BUG baseline: un-reconciled run over-withholds -> ₹5,417/mo', R(5417), runBug.monthlyTdsMinor);
  check('F25 fix recovers the over-withholding (₹1,151/mo less)', R(1151), runBug.monthlyTdsMinor - runFixed.monthlyTdsMinor);
}

// ===========================================================================
// SECTION L — FEATURE 21: LABOUR WELFARE FUND (computeLwf / resolveLwf)
//   FLAT rupees/head, EE + ER, fired ONLY in the state's deduction month(s).
//   Hand-derived from docs/features/21-lwf.md §1.3 rate table (verified 2026-06-24):
//     MH 25/75 half-yearly (Jun,Dec); KA 50/100 annual (Dec, eff. 2025) was 20/40;
//     DL 0.75/2.25 half-yearly (paise-exact); GJ 6/12 half-yearly, mgr-excl > ₹3,500;
//     TN 20/40 annual (Dec); HR 31/62 monthly. Unmapped (UP) => nil.
// ===========================================================================

// --- L1 (21 §8.1 deduction-month gating): MH fires in June (₹25 EE / ₹75 ER).
{
  const r = computeLwf({ stateCode: 'MH', month: 6, asOf: '2026-06-30' });
  check('L1 MH June LWF EE -> ₹25', R(25), r.eeMinor);
  check('L1 MH June LWF ER -> ₹75', R(75), r.erMinor);
  check('L1 MH June fires', true, r.fires);
  check('L1 MH frequency HALF_YEARLY', 'HALF_YEARLY', r.frequency);
}
// --- L2 (21 §8.1): MH does NOT fire in May (non-deduction month => ₹0, fires:false).
{
  const r = computeLwf({ stateCode: 'MH', month: 5, asOf: '2026-05-31' });
  check('L2 MH May LWF EE -> ₹0', 0, r.eeMinor);
  check('L2 MH May fires:false', false, r.fires);
  check('L2 MH May still configured', true, r.configured);
}
// --- L3 (21 §8.3 effective-dating): Karnataka ₹20→₹50 eff. 2025. Dec-2024 uses ₹20.
{
  const r = computeLwf({ stateCode: 'KA', month: 12, asOf: '2024-12-31' });
  check('L3 KA Dec-2024 LWF EE -> ₹20 (old version)', R(20), r.eeMinor);
  check('L3 KA Dec-2024 LWF ER -> ₹40 (old version)', R(40), r.erMinor);
}
// --- L4 (21 §8.3): Karnataka Dec-2025 uses the new ₹50/₹100 (2024 Act, eff. 2025).
{
  const r = computeLwf({ stateCode: 'KA', month: 12, asOf: '2025-12-31' });
  check('L4 KA Dec-2025 LWF EE -> ₹50 (new version)', R(50), r.eeMinor);
  check('L4 KA Dec-2025 LWF ER -> ₹100 (new version)', R(100), r.erMinor);
  check('L4 KA frequency ANNUAL', 'ANNUAL', r.frequency);
}
// --- L5 (21 §8.1): Karnataka annual fires only in Dec, NOT June.
{
  const r = computeLwf({ stateCode: 'KA', month: 6, asOf: '2025-06-30' });
  check('L5 KA June (annual) fires:false', false, r.fires);
  check('L5 KA June EE -> ₹0', 0, r.eeMinor);
}
// --- L6 (21 §8.4 sub-rupee paise-exact): Delhi ₹0.75 EE / ₹2.25 ER = 75 / 225 paise.
{
  const r = computeLwf({ stateCode: 'DL', month: 12, asOf: '2026-12-31' });
  check('L6 DL Dec LWF EE -> 75 paise (₹0.75, NOT rounded to ₹1)', 75, r.eeMinor);
  check('L6 DL Dec LWF ER -> 225 paise (₹2.25, NOT rounded to ₹2)', 225, r.erMinor);
}
// --- L7 (21 §8.5 managerial exclusion): GJ excludes managerial > ₹3,500/mo.
//   Managerial earning ₹5,000 -> exempt; managerial earning ₹3,000 -> covered.
{
  const exempt = computeLwf({ stateCode: 'GJ', month: 6, asOf: '2026-06-30', monthlyGrossRupees: 5000, isManagerial: true });
  check('L7 GJ managerial > ₹3,500 -> exempt (EE ₹0)', 0, exempt.eeMinor);
  check('L7 GJ managerial exempt reason', 'MANAGERIAL_ABOVE_CEILING', exempt.exemptReason);
  const covered = computeLwf({ stateCode: 'GJ', month: 6, asOf: '2026-06-30', monthlyGrossRupees: 3000, isManagerial: true });
  check('L7 GJ managerial <= ₹3,500 -> covered (EE ₹6)', R(6), covered.eeMinor);
  // Non-managerial above ceiling stays covered (exclusion is managerial-only).
  const worker = computeLwf({ stateCode: 'GJ', month: 6, asOf: '2026-06-30', monthlyGrossRupees: 50000, isManagerial: false });
  check('L7 GJ non-managerial above ceiling -> covered (EE ₹6)', R(6), worker.eeMinor);
}
// --- L8 (21 §8.6 no-LWF state): unmapped UP => nil, configured:false, no throw.
{
  const r = computeLwf({ stateCode: 'UP', month: 6, asOf: '2026-06-30' });
  check('L8 UP unmapped EE -> ₹0', 0, r.eeMinor);
  check('L8 UP unmapped configured:false', false, r.configured);
  check('L8 UP unmapped frequency NONE', 'NONE', r.frequency);
}
// --- L9 (21 §8.1): TN annual fires only in Dec (₹20/₹40), not other months.
{
  const dec = computeLwf({ stateCode: 'TN', month: 12, asOf: '2026-12-31' });
  check('L9 TN Dec LWF EE -> ₹20', R(20), dec.eeMinor);
  check('L9 TN Dec LWF ER -> ₹40', R(40), dec.erMinor);
  const jun = computeLwf({ stateCode: 'TN', month: 6, asOf: '2026-06-30' });
  check('L9 TN June (annual) fires:false', false, jun.fires);
}
// --- L10 (21 §1.3): Haryana monthly LWF fires EVERY month (₹31/₹62).
{
  const may = computeLwf({ stateCode: 'HR', month: 5, asOf: '2026-05-31' });
  check('L10 HR May (monthly) LWF EE -> ₹31', R(31), may.eeMinor);
  check('L10 HR May LWF ER -> ₹62', R(62), may.erMinor);
  check('L10 HR fires every month', true, may.fires);
}
// --- L11 (21 §6.2 read model): resolveLwf surfaces the resolved per-state figures.
{
  const r = resolveLwf('MH', '2026-06-30');
  check('L11 resolveLwf MH configured', true, r.configured);
  check('L11 resolveLwf MH eeRupees 25', 25, r.eeRupees);
  check('L11 resolveLwf MH frequency', 'HALF_YEARLY', r.frequency);
  const up = resolveLwf('UP', '2026-06-30');
  check('L11 resolveLwf UP configured:false', false, up.configured);
}

// ===========================================================================
// SECTION L2 — FEATURE 21 LWF RUN-GATING (CONFIRMED FIX): the flat, income-
//   independent LWF is owed ONCE per deduction period and must ride ONLY the
//   primary/regular monthly run. An OFF_CYCLE/ARREAR/SUPPLEMENTARY/BONUS/FNF/
//   CORRECTION run in the SAME month must NOT re-charge the flat EE+ER fee.
//   Plumbed through compliance compute() via period.runType. Maharashtra HALF_YEARLY
//   fires Jun/Dec at ₹25 EE / ₹75 ER (docs/features/21 §1.3, pinned in L1 above).
// ===========================================================================

// --- L12: periodIsPrimaryRun — the pure run-gate predicate.
{
  check('L12 REGULAR is primary (LWF-bearing)', true, periodIsPrimaryRun({ runType: 'REGULAR' }));
  check('L12 MIGRATED is primary (historical regular)', true, periodIsPrimaryRun({ runType: 'MIGRATED' }));
  check('L12 OFF_CYCLE is NOT primary', false, periodIsPrimaryRun({ runType: 'OFF_CYCLE' }));
  check('L12 ARREAR is NOT primary', false, periodIsPrimaryRun({ runType: 'ARREAR' }));
  check('L12 SUPPLEMENTARY is NOT primary', false, periodIsPrimaryRun({ runType: 'SUPPLEMENTARY' }));
  check('L12 BONUS is NOT primary', false, periodIsPrimaryRun({ runType: 'BONUS' }));
  check('L12 FNF is NOT primary', false, periodIsPrimaryRun({ runType: 'FNF' }));
  check('L12 CORRECTION is NOT primary', false, periodIsPrimaryRun({ runType: 'CORRECTION' }));
  // Back-compat: an UNTAGGED run (no runType) FAILS OPEN to primary so the pure
  // unit-test path and any legacy caller keep their single-run LWF behaviour.
  check('L12 untagged run fails open to primary', true, periodIsPrimaryRun({}));
  check('L12 null period fails open to primary', true, periodIsPrimaryRun(null));
  check('L12 case-insensitive (off_cycle)', false, periodIsPrimaryRun({ runType: 'off_cycle' }));
}

// --- L13: full compute() — REGULAR run in a deduction month CHARGES LWF once.
//   MH, gross ₹19,000 (>15k so EPF caps; ESI latched covered), June (LWF fires).
{
  const out = IN.compute({
    periodGrossMinor: R(19000),
    basicMinor: R(12000),
    components: [],
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: true },
    period: { end: '2025-06-30', year: 2025, month: 6, runType: 'REGULAR' },
    employee: { hasPan: true, gender: 'male' },
    entity: { stateCode: 'MH', pfApplicable: true, esiApplicable: true },
  });
  check('L13 REGULAR June MH charges LWF-EE ₹25', R(25), amt(out.employeeDeductions, 'LWF'));
  check('L13 REGULAR June MH charges LWF-ER ₹75', R(75), amt(out.employerContributions, 'LWF_ER'));
}

// --- L14: SAME month, but an OFF_CYCLE run — LWF must NOT fire (no double-charge).
{
  for (const rt of ['OFF_CYCLE', 'ARREAR', 'SUPPLEMENTARY', 'BONUS', 'FNF', 'CORRECTION']) {
    const out = IN.compute({
      periodGrossMinor: R(19000),
      basicMinor: R(12000),
      components: [],
      ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: true },
      period: { end: '2025-06-30', year: 2025, month: 6, runType: rt },
      employee: { hasPan: true, gender: 'male' },
      entity: { stateCode: 'MH', pfApplicable: true, esiApplicable: true },
    });
    check(`L14 ${rt} June MH does NOT charge LWF-EE`, null, amt(out.employeeDeductions, 'LWF'));
    check(`L14 ${rt} June MH does NOT charge LWF-ER`, null, amt(out.employerContributions, 'LWF_ER'));
  }
}

// --- L15: untagged run (no runType) STILL charges LWF (fail-open back-compat),
//   matching every pre-existing E2E compute() assertion that never set runType.
{
  const out = IN.compute({
    periodGrossMinor: R(19000),
    basicMinor: R(12000),
    components: [],
    ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0, esiLatchedCovered: true },
    period: { end: '2025-06-30', year: 2025, month: 6 }, // NO runType
    employee: { hasPan: true, gender: 'male' },
    entity: { stateCode: 'MH', pfApplicable: true, esiApplicable: true },
  });
  check('L15 untagged June MH still charges LWF-EE ₹25 (fail-open)', R(25), amt(out.employeeDeductions, 'LWF'));
}

// ===========================================================================
// SECTION M — FEATURE 22: PAYMENT OF BONUS ACT rule resolver (resolveBonusRule)
//   Effective-dated ceilings: FY2014-15+ => ₹21,000 eligibility / ₹7,000 calc;
//   pre-2015 (≤ 2014-03-31) => ₹10,000 / ₹3,500. (docs/features/22 §2/§5.1.)
//   The capped-base/rate arithmetic lives in bonus.golden.test.js (the new pure
//   payroll/bonus.js core); here we pin the rule version boundary to the paise.
// ===========================================================================
{
  const post = resolveBonusRule('2026-03-31');
  check('M1 bonus FY2025-26 eligibility ceiling -> ₹21,000', R(21000), post.eligibilityCeilingMinor);
  check('M1 bonus FY2025-26 calc ceiling -> ₹7,000', R(7000), post.calcCeilingMinor);
  check('M1 bonus min rate 833bp (8.33%)', 833, post.minRateNum);
  check('M1 bonus max rate 2000bp (20%)', 2000, post.maxRateNum);
  const pre = resolveBonusRule('2013-03-31');
  check('M2 bonus pre-2015 eligibility ceiling -> ₹10,000', R(10000), pre.eligibilityCeilingMinor);
  check('M2 bonus pre-2015 calc ceiling -> ₹3,500', R(3500), pre.calcCeilingMinor);
  // Boundary: 2014-03-31 is the last pre-amendment day; 2014-04-01 the first new day.
  check('M3 bonus boundary 2014-03-31 -> ₹10,000', R(10000), resolveBonusRule('2014-03-31').eligibilityCeilingMinor);
  check('M3 bonus boundary 2014-04-01 -> ₹21,000', R(21000), resolveBonusRule('2014-04-01').eligibilityCeilingMinor);
}

// ===========================================================================
// SECTION N — FEATURE 27: AUTO-ARREAR per-source-month PF/ESI delta primitives.
//   The auto-arrear engine charges PF/ESI on the arrear by taking the INCREMENTAL
//   computeEpf/computeEsi difference between the OLD and NEW wage OF EACH SOURCE
//   MONTH, so the ₹15,000 PF ceiling / ₹21,000 ESI cap bind on the source month, not
//   the payout month. These pin that delta math to the paise (docs/features/27 §2/§9).
//   No new module: these are the SAME computeEpf/computeEsi the engine + arrears.js use.
// ===========================================================================
{
  // N1 — below-ceiling increment: old PF wage ₹10,000 → new ₹14,000. EE delta = 12% of
  //   the ₹4,000 rise = ₹480 (both sides below the ₹15,000 cap).
  const oldPf = computeEpf({ pfWageMinor: R(10000), capAtCeiling: true });
  const newPf = computeEpf({ pfWageMinor: R(14000), capAtCeiling: true });
  check('N1 below-ceiling EPF EE delta = ₹480', R(480), newPf.epfEeMinor - oldPf.epfEeMinor);

  // N2 — AT-CEILING source month: old PF wage already ₹16,000 (≥ ₹15,000) → new ₹20,000.
  //   Both cap at ₹15,000 → ₹0 incremental EE PF (the spec §9 zero-PF edge).
  const oldPfCap = computeEpf({ pfWageMinor: R(16000), capAtCeiling: true });
  const newPfCap = computeEpf({ pfWageMinor: R(20000), capAtCeiling: true });
  check('N2 at-ceiling EPF EE delta = ₹0 (cap binds both sides)', 0, newPfCap.epfEeMinor - oldPfCap.epfEeMinor);

  // N3 — straddle-ceiling: old ₹13,000 → new ₹18,000. EE delta = 12%×(₹15,000−₹13,000)
  //   = 12% of ₹2,000 = ₹240 (the new side caps at ₹15,000).
  const oldStr = computeEpf({ pfWageMinor: R(13000), capAtCeiling: true });
  const newStr = computeEpf({ pfWageMinor: R(18000), capAtCeiling: true });
  check('N3 straddle-ceiling EPF EE delta = ₹240', R(240), newStr.epfEeMinor - oldStr.epfEeMinor);

  // N4 — ESI delta below cap: old gross ₹18,000 → new ₹20,000, both covered (latched).
  //   EE 0.75% rounds UP to the next ₹1: ₹18,000→₹135, ₹20,000→₹150 → delta ₹15.
  const oldEsi = computeEsi({ esiGrossMinor: R(18000), latchedCovered: true });
  const newEsi = computeEsi({ esiGrossMinor: R(20000), latchedCovered: true });
  check('N4 ESI EE delta (₹18k→₹20k, latched) = ₹15', R(15), newEsi.esiEeMinor - oldEsi.esiEeMinor);

  // N5 — ESI coverage CONTINUITY: a source month that was covered stays covered for the
  //   arrear even when the revised gross crosses ₹21,000 (latch honoured, §2).
  const newEsiOver = computeEsi({ esiGrossMinor: R(22000), latchedCovered: true });
  check('N5 ESI latched-covered above ₹21k still charges EE (continuity)', true, newEsiOver.esiEeMinor > 0);

  // N6 — ESI employer 3.25% delta (₹18k→₹20k): ₹585 → ₹650 → delta ₹65.
  check('N6 ESI ER delta (₹18k→₹20k, latched) = ₹65', R(65), newEsi.esiErMinor - oldEsi.esiErMinor);
}

// ===========================================================================
console.log('');
console.log(`India golden test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
if (failed > 0) {
  console.log('Discrepancies:');
  for (const d of discrepancies) console.log('  - ' + d);
  process.exitCode = 1;
}

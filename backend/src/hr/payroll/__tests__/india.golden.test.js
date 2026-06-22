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
console.log('');
console.log(`India golden test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
if (failed > 0) {
  console.log('Discrepancies:');
  for (const d of discrepancies) console.log('  - ' + d);
  process.exitCode = 1;
}

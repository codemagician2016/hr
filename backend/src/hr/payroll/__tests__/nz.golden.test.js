'use strict';

/**
 * nz.golden.test.js — INDEPENDENT golden-dataset test for the NZ compliance engine.
 *
 * Plain-node test: built-in `assert` only. No jest, no node_modules.
 *   node backend/src/hr/payroll/__tests__/nz.golden.test.js
 *
 * Every expected value below is derived BY HAND from the worked examples and the
 * rate/threshold tables in docs/06-compliance-newzealand.md (and §05 where cited).
 * The author did NOT read the engine's arithmetic to back-fill expecteds.
 *
 * Money is integer CENTS. Payment date >= 2026-04-01 selects FY2026-27 rates:
 *   PAYE brackets (§2.1):  10.5% to 15,600 | 17.5% to 53,500 | 30% to 78,100
 *                          | 33% to 180,000 | 39% over.
 *   ACC earners' levy (§5.1): 1.75% on first $156,641 (max annual $2,741.22).
 *   KiwiSaver (§4.1): default EE 3.5%, ER 3.5%; ESCT tiers §4.4.
 *   Student loan (§6.1): 12% over period threshold; secondary = 12% flat.
 *                        weekly threshold $464; fortnightly $928; monthly $2,010.67.
 *   Min wage (§8.1): adult $23.95/hr, starting-out/training $19.16/hr.
 *   PAYE de-annualise rounding: round-half-up to whole cents (§2.6).
 */

const assert = require('assert');
const path = require('path');

const nz = require(path.join(__dirname, '..', 'compliance', 'newzealand.js'));
const ha = require(path.join(__dirname, '..', 'compliance', 'holidaysAct.js'));

let passed = 0;
let failed = 0;
const discrepancies = [];

/** Assert helper that records pass/fail + a precise discrepancy string. */
function check(scenario, expected, actual) {
  try {
    assert.strictEqual(actual, expected);
    passed += 1;
  } catch (e) {
    failed += 1;
    discrepancies.push(`${scenario}: expected ${expected} got ${actual}`);
  }
}

/** Find a deduction/contribution line by code. */
function line(arr, code) {
  return (arr || []).find((l) => l.code === code);
}
function amt(arr, code) {
  const l = line(arr, code);
  return l ? l.amountMinor : undefined;
}

/* ════════════════════════════════════════════════════════════════════════════
 * PART 1 — PAYE per tax code + bracket boundaries (§2.1, §2.2, §2.3)
 * ════════════════════════════════════════════════════════════════════════════ */

// ── S1: M code, $2,000/fortnight, all ACC-liable, no KS/SL. (§2.2 method) ──
// Annualised = 2000 × 26 = $52,000 = 5,200,000c.
// Bracket tax annual:
//   10.5% × 15,600 = 1,638.00
//   17.5% × (52,000 - 15,600 = 36,400) = 6,370.00
//   total annual income tax = $8,008.00 = 800,800c.
// Period income tax = 800800 / 26 = 30,800c exactly = $308.00.
// ACC: min(52,000,156,641) × 1.75% annual = 910.00; per period = 910/26 = $35.00 = 3,500c.
//   (engine adds ACC per-period on the period liable base: 200,000c × 1.75% = 3,500c.)
// PAYE = 30,800 + 3,500 = 34,300c.
{
  const r = nz.compute({
    periodGrossMinor: 200000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S1 M $2000/fn PAYE', 34300, amt(r.employeeDeductions, 'PAYE'));
}

// ── S2: M code, $600/week. (cross-check with §6.3 base) ──
// Annualised = 600 × 52 = $31,200 = 3,120,000c.
//   10.5% × 15,600 = 1,638.00
//   17.5% × (31,200 - 15,600 = 15,600) = 2,730.00
//   annual income tax = $4,368.00 = 436,800c.  Per week = 436800/52 = 8,400c = $84.00.
// ACC period: 60,000c × 1.75% = 1,050c = $10.50.
// PAYE = 8,400 + 1,050 = 9,450c.
{
  const r = nz.compute({
    periodGrossMinor: 60000,
    period: { frequency: 'WEEKLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S2 M $600/wk PAYE', 9450, amt(r.employeeDeductions, 'PAYE'));
}

// ── S3: bracket boundary — annual income exactly $15,600 (top of 10.5%). ──
// Weekly = 15,600/52 = $300 = 30,000c. Annualised = 1,560,000c.
//   income tax = 10.5% × 15,600 = $1,638.00 = 163,800c. Per week = 163800/52 = 3,150c.
// ACC: 30,000c × 1.75% = 525c.
// PAYE = 3,150 + 525 = 3,675c.
{
  const r = nz.compute({
    periodGrossMinor: 30000,
    period: { frequency: 'WEEKLY', paymentDate: '2026-05-01', hoursWorked: 0 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S3 boundary $15,600 PAYE', 3675, amt(r.employeeDeductions, 'PAYE'));
}

// ── S4: bracket boundary — annual $78,100 (top of 30% band), monthly. ──
// Monthly = 78,100/12 = $6,508.3333 → use 650,833c period (annualised = 7,809,996c ≈ band).
// Simpler: feed annual exactly via monthly = 651,000c? Keep exact-band: use $78,000 annual.
// Annual $78,000 = 7,800,000c, monthly = 650,000c.
//   10.5% × 15,600 = 1,638.00
//   17.5% × (53,500-15,600=37,900) = 6,632.50
//   30% × (78,000-53,500=24,500) = 7,350.00
//   annual income tax = 15,620.50 = 1,562,050c. Per month = 1562050/12 = 130,170.8333 → round-half-up 130,171c.
// ACC: 650,000c × 1.75% = 11,375c.
// PAYE = 130,171 + 11,375 = 141,546c.
{
  const r = nz.compute({
    periodGrossMinor: 650000,
    period: { frequency: 'MONTHLY', paymentDate: '2026-06-01', hoursWorked: 0 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S4 $78,000 annual monthly PAYE', 141546, amt(r.employeeDeductions, 'PAYE'));
}

// ── S5: top bracket 39% — annual $200,000, monthly. (above ACC cap) ──
// Monthly = 200,000/12 = 1,666,666.67 → feed 1,666,667c? Use exact annual via monthly base.
// Use $216,000 annual? Keep $200,000: monthly = round? Provide 1,666,666c? Imprecise.
// Use annual $240,000 = 24,000,000c, monthly = 2,000,000c (clean).
//   10.5% × 15,600 = 1,638.00
//   17.5% × 37,900 = 6,632.50
//   30% × (78,100-53,500=24,600) = 7,380.00
//   33% × (180,000-78,100=101,900) = 33,627.00
//   39% × (240,000-180,000=60,000) = 23,400.00
//   annual income tax = 72,677.50 = 7,267,750c. Per month = 7267750/12 = 605,645.8333 → 605,646c.
// ACC: annual liable 240,000 > cap 156,641; YTD=0 so period liable = min(2,000,000c period, remainingCap)
//   = 2,000,000c (this month's $20,000 is well under the cap remaining). 2,000,000 × 1.75% = 35,000c.
// PAYE = 605,646 + 35,000 = 640,646c.
{
  const r = nz.compute({
    periodGrossMinor: 2000000,
    period: { frequency: 'MONTHLY', paymentDate: '2026-06-01', hoursWorked: 0 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S5 $240,000 annual top-bracket monthly PAYE', 640646, amt(r.employeeDeductions, 'PAYE'));
}

// ── S6: ME code with IETC. Annual $52,000 (in $24,000-$66,000 → full $520 credit). ──
// Same gross as S1 ($2,000/fn). Annual income tax (pre-credit) = $8,008.00 (from S1).
// IETC annual = $520.00 → annual tax = 8,008 - 520 = 7,488.00 = 748,800c.
// Per period = 748800/26 = 28,800c = $288.00.
// ACC period = 3,500c. PAYE = 28,800 + 3,500 = 32,300c.
{
  const r = nz.compute({
    periodGrossMinor: 200000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'ME', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S6 ME IETC $52k/yr PAYE', 32300, amt(r.employeeDeductions, 'PAYE'));
}

// ── S7: ME code, IETC abating. Annual $68,000 ($66k-$70k → abate 13c/$ over $66k). ──
// over = 68,000-66,000 = $2,000. abatement = 2,000 × 0.13 = $260.00. credit = 520-260 = $260.00.
// Annual income tax pre-credit: $68,000 = 6,800,000c.
//   10.5% × 15,600 = 1,638.00
//   17.5% × 37,900 = 6,632.50
//   30% × (68,000-53,500=14,500) = 4,350.00
//   annual = 12,620.50 ; minus IETC 260.00 = 12,360.50 = 1,236,050c.
// Fortnightly: $68,000/26 = $2,615.3846 → not clean. Use $68,000 annual but MONTHLY = 566,666.67 → not clean.
// Instead feed exact annual via the period: choose 4-weekly (13 periods): 68,000/13 = 5,230.769 not clean.
// Keep it clean by choosing annual $68,250? Cleanest: annual $68,000 with WEEKLY $1,307.69 not clean.
// Use annual exactly via period that divides: $68,000 / 26 fortnights → not integer cents? 6,800,000/26 = 261,538.46 → no.
// Choose annual $70,200 (just over $70k upper → IETC nil) instead handled in S8. For abate use annual $67,600:
//   $67,600/26 = 2,600.00 exactly (260,000c/fn). annualised = 6,760,000c.
//   over = 67,600-66,000 = 1,600 → abate 1,600×0.13 = 208.00 → credit = 520-208 = 312.00.
//   tax: 1,638.00 + 6,632.50 + 30%×(67,600-53,500=14,100)=4,230.00 = 12,500.50 ; -312.00 = 12,188.50 = 1,218,850c.
//   per fn = 1218850/26 = 46,878.846 → round-half-up 46,879c.
//   ACC: 260,000c × 1.75% = 4,550c. PAYE = 46,879 + 4,550 = 51,429c.
{
  const r = nz.compute({
    periodGrossMinor: 260000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'ME', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S7 ME IETC abating $67,600/yr PAYE', 51429, amt(r.employeeDeductions, 'PAYE'));
}

// ── S8: ME code, IETC nil at/over $70,000. Annual $72,800 ($2,800/fn). ──
// $72,800/26 = $2,800.00 (280,000c/fn). Over $70,000 → IETC = 0.
// tax: 1,638.00 + 6,632.50 + 30%×(72,800-53,500=19,300)=5,790.00 = 14,060.50 = 1,406,050c.
//   per fn = 1406050/26 = 54,078.846 → 54,079c. ACC: 280,000×1.75% = 4,900c.
//   PAYE = 54,079 + 4,900 = 58,979c.
{
  const r = nz.compute({
    periodGrossMinor: 280000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'ME', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S8 ME IETC nil $72,800/yr PAYE', 58979, amt(r.employeeDeductions, 'PAYE'));
}

// ── S9: Secondary S code (flat 17.5%, ACC embedded — no separate levy). (§2.3) ──
// $1,000/fn secondary 'S' → 17.5% × 100,000c = 17,500c. ACC = 0 (embedded). PAYE = 17,500c.
{
  const r = nz.compute({
    periodGrossMinor: 100000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'S', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S9 secondary S flat 17.5% PAYE', 17500, amt(r.employeeDeductions, 'PAYE'));
  check('S9 secondary ACC embedded (ACC line=0)', 0, amt(r.employerContributions, 'ACC'));
}

// ── S10: Secondary SH code flat 30%. $2,000/fn → 30% × 200,000 = 60,000c. ──
{
  const r = nz.compute({
    periodGrossMinor: 200000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'SH', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S10 secondary SH flat 30% PAYE', 60000, amt(r.employeeDeductions, 'PAYE'));
}

// ── S11: ND no-notification = 45% income tax + ACC = 46.75% total. (§2.3, §15.4) ──
// $2,000/fn. income tax = 45% × 200,000 = 90,000c. ACC = 1.75% × 200,000 = 3,500c.
// PAYE = 93,500c (= 46.75% × 200,000).
{
  const r = nz.compute({
    periodGrossMinor: 200000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'ND', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S11 ND 46.75% total PAYE', 93500, amt(r.employeeDeductions, 'PAYE'));
}

/* ════════════════════════════════════════════════════════════════════════════
 * PART 2 — KiwiSaver 3.5% + ESCT tiers (§4.1, §4.4, §4.5)
 * ════════════════════════════════════════════════════════════════════════════ */

// ── S12: §4.5 worked example. $2,000/fn, EE 3.5%, ER 3.5%, prior-year $52,000 → ESCT 17.5%. ──
// EE KS = 200,000 × 3.5% = 7,000c ($70.00).
// ER gross = 200,000 × 3.5% = 7,000c ($70.00).
// ESCT = 7,000 × 17.5% = 1,225c ($12.25).
// ER net = 7,000 - 1,225 = 5,775c ($57.75).
{
  const r = nz.compute({
    periodGrossMinor: 200000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: {
      taxCode: 'M',
      kiwiSaver: { status: 'ACTIVE', employeeRate: 0.035, employerRate: 0.035 },
      dateOfBirth: '1990-01-01',
    },
    ytd: { priorYearTaxableIncomeMinor: 5200000 },
  });
  check('S12 §4.5 EE KS', 7000, amt(r.employeeDeductions, 'KIWISAVER'));
  check('S12 §4.5 ER gross KS', 7000, amt(r.employerContributions, 'KIWISAVER_ER'));
  check('S12 §4.5 ESCT', 1225, amt(r.employerContributions, 'ESCT'));
}

// ── S13: ESCT tier 10.5% (prior-year $0-$16,800). $1,000/fn KS-liable, ER 3.5%. ──
// ER gross = 100,000 × 3.5% = 3,500c. ESCT = 3,500 × 10.5% = 367.5 → round-half-up 368c.
{
  const r = nz.compute({
    periodGrossMinor: 100000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: {
      taxCode: 'M',
      kiwiSaver: { status: 'ACTIVE', employeeRate: 0.035, employerRate: 0.035 },
      dateOfBirth: '1990-01-01',
    },
    ytd: { priorYearTaxableIncomeMinor: 1000000 }, // $10,000 → tier 10.5%
  });
  check('S13 ESCT tier 10.5%', 368, amt(r.employerContributions, 'ESCT'));
}

// ── S14: ESCT tier 30% (prior-year $57,601-$84,000). $2,000/fn, ER 3.5%. ──
// ER gross = 7,000c. ESCT = 7,000 × 30% = 2,100c.
{
  const r = nz.compute({
    periodGrossMinor: 200000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: {
      taxCode: 'M',
      kiwiSaver: { status: 'ACTIVE', employeeRate: 0.035, employerRate: 0.035 },
      dateOfBirth: '1990-01-01',
    },
    ytd: { priorYearTaxableIncomeMinor: 7000000 }, // $70,000 → tier 30%
  });
  check('S14 ESCT tier 30%', 2100, amt(r.employerContributions, 'ESCT'));
}

// ── S15: ESCT tier 39% (prior-year $216,001+). $5,000/fn, ER 3.5%. ──
// ER gross = 500,000 × 3.5% = 17,500c. ESCT = 17,500 × 39% = 6,825c.
{
  const r = nz.compute({
    periodGrossMinor: 500000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: {
      taxCode: 'M',
      kiwiSaver: { status: 'ACTIVE', employeeRate: 0.035, employerRate: 0.035 },
      dateOfBirth: '1990-01-01',
    },
    ytd: { priorYearTaxableIncomeMinor: 22000000 }, // $220,000 → tier 39%
  });
  check('S15 ESCT tier 39%', 6825, amt(r.employerContributions, 'ESCT'));
}

// ── S16: KiwiSaver employee elects 8%. $2,000/fn → EE = 200,000 × 8% = 16,000c. ──
// ER still 3.5% gross = 7,000c (employer min not raised by employee election).
{
  const r = nz.compute({
    periodGrossMinor: 200000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: {
      taxCode: 'M',
      kiwiSaver: { status: 'ACTIVE', employeeRate: 0.08, employerRate: 0.035 },
      dateOfBirth: '1990-01-01',
    },
    ytd: { priorYearTaxableIncomeMinor: 5200000 },
  });
  check('S16 KS EE 8%', 16000, amt(r.employeeDeductions, 'KIWISAVER'));
  check('S16 KS ER still 3.5%', 7000, amt(r.employerContributions, 'KIWISAVER_ER'));
}

// ── S17: Opted-out → no KS deduction, no employer contribution. (§4.2) ──
{
  const r = nz.compute({
    periodGrossMinor: 200000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'OPTED_OUT' }, dateOfBirth: '1990-01-01' },
    ytd: {},
  });
  check('S17 opted-out no KS line', undefined, amt(r.employeeDeductions, 'KIWISAVER'));
  check('S17 opted-out no ER KS line', undefined, amt(r.employerContributions, 'KIWISAVER_ER'));
}

/* ════════════════════════════════════════════════════════════════════════════
 * PART 3 — ACC 1.75% with $156,641 cap (§5)
 * ════════════════════════════════════════════════════════════════════════════ */

// ── S18: ACC cap reached mid-pay (§5.4 worked example). ──
// M code, $13,200/month, all ACC-liable. YTD liable = 11 × 13,200 = $145,200 = 14,520,000c.
// remainingCap = 156,641 - 145,200 = $11,441 = 1,144,100c.
// This period liable = min(1,320,000c period, 1,144,100c remaining) = 1,144,100c.
// ACC = 1,144,100 × 1.75% = 20,021.75 → round-half-up 20,022c = $200.22 (matches §5.4).
// PAYE here also includes income tax; we isolate ACC via the explain — but the contract folds ACC into PAYE.
// We instead assert the ACC liable cap behaviour by checking PAYE income-tax + ACC composition is internally
// consistent: compute income tax independently and subtract.
// Income tax on $13,200/month: annualised = 158,400 = 15,840,000c.
//   10.5%×15,600=1,638.00 ; 17.5%×37,900=6,632.50 ; 30%×24,600=7,380.00 ;
//   33%×(158,400-78,100=80,300)=26,499.00 ; total annual = 42,149.50 = 4,214,950c.
//   per month = 4214950/12 = 351,245.8333 → 351,246c.
// ACC this period = 20,022c (capped). PAYE = 351,246 + 20,022 = 371,268c.
{
  const r = nz.compute({
    periodGrossMinor: 1320000,
    period: { frequency: 'MONTHLY', paymentDate: '2027-03-01', hoursWorked: 0 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: { accLiableEarningsMinor: 14520000 },
  });
  check('S18 §5.4 ACC cap PAYE (incl capped ACC $200.22)', 371268, amt(r.employeeDeductions, 'PAYE'));
}

// ── S19: ACC fully capped — YTD already at cap → ACC = 0 this period. ──
// M code, $5,000/fn, YTD liable = $156,641 (cap). remainingCap=0 → ACC=0.
// Income tax: annualised = 5,000 × 26 = $130,000 = 13,000,000c.
//   10.5%×15,600=1,638.00 ; 17.5%×37,900=6,632.50 ; 30%×24,600=7,380.00 ;
//   33%×(130,000-78,100=51,900)=17,127.00 ; annual = 32,777.50 = 3,277,750c.
//   per fn = 3277750/26 = 126,067.307 → round-half-up 126,067c.
// ACC = 0. PAYE = 126,067c.
{
  const r = nz.compute({
    periodGrossMinor: 500000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2027-03-01', hoursWorked: 0 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: { accLiableEarningsMinor: 15664100 },
  });
  check('S19 ACC fully capped → PAYE = income tax only', 126067, amt(r.employeeDeductions, 'PAYE'));
}

/* ════════════════════════════════════════════════════════════════════════════
 * PART 4 — Student loan (§6)
 * ════════════════════════════════════════════════════════════════════════════ */

// ── S20: §6.3 worked example. M SL, $600/week. ──
// over = 60,000 - 46,400 (weekly threshold $464) = 13,600c. SL = 13,600 × 12% = 1,632c ($16.32).
{
  const r = nz.compute({
    periodGrossMinor: 60000,
    period: { frequency: 'WEEKLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'M SL', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S20 §6.3 SL standard', 1632, amt(r.employeeDeductions, 'SLOAN'));
}

// ── S21: §6.3 SL + SLCIR $20/week. total = 1,632 + 2,000 = 3,632c ($36.32). ──
{
  const r = nz.compute({
    periodGrossMinor: 60000,
    period: { frequency: 'WEEKLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: {
      taxCode: 'M SL',
      kiwiSaver: { status: 'NOT_MEMBER' },
      studentLoan: { slcirPerPeriodMinor: 2000 },
    },
    ytd: {},
  });
  check('S21 §6.3 SL + SLCIR', 3632, amt(r.employeeDeductions, 'SLOAN'));
}

// ── S22: SL secondary code (S SL) = 12% of every dollar, no threshold. (§6.1) ──
// $1,000/fn secondary → 100,000 × 12% = 12,000c.
{
  const r = nz.compute({
    periodGrossMinor: 100000,
    period: { frequency: 'FORTNIGHTLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'S SL', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S22 SL secondary 12% no threshold', 12000, amt(r.employeeDeductions, 'SLOAN'));
}

// ── S23: SL below threshold → 0. M SL, $400/week (< $464 weekly threshold). ──
// over = max(0, 40,000 - 46,400) = 0 → SL = 0.
{
  const r = nz.compute({
    periodGrossMinor: 40000,
    period: { frequency: 'WEEKLY', paymentDate: '2026-04-15', hoursWorked: 0 },
    employee: { taxCode: 'M SL', kiwiSaver: { status: 'NOT_MEMBER' } },
    ytd: {},
  });
  check('S23 SL below threshold', 0, amt(r.employeeDeductions, 'SLOAN'));
}

/* ════════════════════════════════════════════════════════════════════════════
 * PART 5 — Minimum wage floor (§8)
 * ════════════════════════════════════════════════════════════════════════════ */

// ── S24: adult below min wage → MINWAGE_FLOOR anomaly. ──
// $20/hr (2,000c) × 40h = 80,000c ordinary; effective 2,000c/hr < $23.95 (2,395c). Breach.
{
  const r = nz.compute({
    periodGrossMinor: 80000,
    basicMinor: 80000,
    period: { frequency: 'WEEKLY', paymentDate: '2026-04-15', hoursWorked: 40 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' }, minWageCategory: 'ADULT' },
    ytd: {},
  });
  const a = (r.anomalies || []).find((x) => x.code === 'MINWAGE_FLOOR');
  check('S24 adult min-wage breach raised', true, !!a);
}

// ── S25: adult above min wage → no anomaly. $24/hr × 40h = 96,000c; 2,400c/hr ≥ 2,395c. ──
{
  const r = nz.compute({
    periodGrossMinor: 96000,
    basicMinor: 96000,
    period: { frequency: 'WEEKLY', paymentDate: '2026-04-15', hoursWorked: 40 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' }, minWageCategory: 'ADULT' },
    ytd: {},
  });
  const a = (r.anomalies || []).find((x) => x.code === 'MINWAGE_FLOOR');
  check('S25 adult above min-wage no breach', false, !!a);
}

// ── S26: starting-out rate $19.16. $19/hr (1,900c) × 40h → 1,900c/hr < 1,916c → breach. ──
{
  const r = nz.compute({
    periodGrossMinor: 76000,
    basicMinor: 76000,
    period: { frequency: 'WEEKLY', paymentDate: '2026-04-15', hoursWorked: 40 },
    employee: { taxCode: 'M', kiwiSaver: { status: 'NOT_MEMBER' }, minWageCategory: 'STARTING_OUT' },
    ytd: {},
  });
  const a = (r.anomalies || []).find((x) => x.code === 'MINWAGE_FLOOR');
  check('S26 starting-out min-wage breach raised', true, !!a);
}

/* ════════════════════════════════════════════════════════════════════════════
 * PART 6 — Holidays Act suite (compliance/holidaysAct.js)
 * ════════════════════════════════════════════════════════════════════════════ */

// ── S27: §9.13 Example A — annual holiday, greater of OWP vs AWE. ──
// Base $1,500/week + commission. Last 4 weeks: 4×1500 + (280+320+300+340=1240) = 7240.00 ;
// b=0 ; OWP formula = 7240/4 = $1,810.00. specified = $1,500.00 → GREATER_OF picks 1,810.00.
// AWE: 52-wk gross = 1500×52 + 300×52 = 78,000 + 15,600 = 93,600 ; /52 = $1,800.00.
// max(1810, 1800) = $1,810.00 = 181,000c for 1 week.
{
  const v = ha.valueLeave('ANNUAL_HOLIDAY_VESTED', {
    owp: {
      specifiedWeeklyMinor: 150000,
      method: 'GREATER_OF',
      last4WeeksEntries: [
        { amountMinor: 150000 }, { amountMinor: 150000 },
        { amountMinor: 150000 }, { amountMinor: 150000 },
        { amountMinor: 28000 }, { amountMinor: 32000 },
        { amountMinor: 30000 }, { amountMinor: 34000 },
      ],
    },
    awe: { grossEarnings52Minor: 9360000 },
    weeksTaken: 1,
    workingDaysPerWeek: 5,
  });
  check('S27 ExA annual holiday greater-of', 181000, v.amountMinor);
  check('S27 ExA method picks OWP', 'GREATER_OF_OWP_AWE→OWP', v.method);
}

// ── S28: AWE > OWP — greater-of picks AWE. ──
// OWP specified $1,000/wk, no formula entries. AWE 52-wk gross = $60,000 → /52 = $1,153.8462 → 1,153.85?
//   AWE rate-units = roundHalfUp(6,000,000c × 100 / 52) = roundHalfUp(600,000,000/52)
//   = roundHalfUp(11,538,461.538) = 11,538,462 rate-units → cents = roundHalfUp(11,538,462/100)
//   = roundHalfUp(115,384.62) = 115,385c = $1,153.85.
// max(OWP 100,000c, AWE 115,385c) = 115,385c for 1 week.
{
  const v = ha.valueLeave('ANNUAL_HOLIDAY_VESTED', {
    owp: { specifiedWeeklyMinor: 100000, method: 'SPECIFIED' },
    awe: { grossEarnings52Minor: 6000000 },
    weeksTaken: 1,
    workingDaysPerWeek: 5,
  });
  check('S28 AWE greater-of picks AWE', 115385, v.amountMinor);
  check('S28 method picks AWE', 'GREATER_OF_OWP_AWE→AWE', v.method);
}

// ── S29: weeks-not-days — part-week. OWP $1,500/wk specified, take 2 days, 5-day week. ──
// weekly = max(1500 specified, AWE). AWE 52-wk gross = 78,000 → /52 = $1,500.00 (115,? )
//   AWE = roundHalfUp(7,800,000c×100/52)=roundHalfUp(780,000,000/52)=15,000,000 rate-units → 150,000c.
//   max(150,000c, 150,000c) = 150,000c weekly.
// dailyUnits = roundHalfUp(weeklyUnits / 5) = roundHalfUp(15,000,000/5) = 3,000,000 rate-units
//   → daily cents = 30,000c = $300.00. amount = 300.00 × 2 days = 60,000c.
{
  const v = ha.valueLeave('ANNUAL_HOLIDAY_VESTED', {
    owp: { specifiedWeeklyMinor: 150000, method: 'SPECIFIED' },
    awe: { grossEarnings52Minor: 7800000 },
    weeksTaken: 0,
    daysTaken: 2,
    workingDaysPerWeek: 5,
  });
  check('S29 part-week 2 days @ 5-day week', 60000, v.amountMinor);
}

// ── S30: weeks-not-days — different work pattern (4-day week). Same $1,500 weekly. ──
// dailyUnits = roundHalfUp(15,000,000/4) = 3,750,000 rate-units → daily = 37,500c = $375.00.
// take 1 day → 37,500c. (proves engine does NOT assume 5 days)
{
  const v = ha.valueLeave('ANNUAL_HOLIDAY_VESTED', {
    owp: { specifiedWeeklyMinor: 150000, method: 'SPECIFIED' },
    awe: { grossEarnings52Minor: 7800000 },
    weeksTaken: 0,
    daysTaken: 1,
    workingDaysPerWeek: 4,
  });
  check('S30 part-week 1 day @ 4-day week', 37500, v.amountMinor);
}

// ── S31: §9.13 Example B — public holiday WORKED, OWD. $30/hr, 8h, Labour Day. ──
// time-and-a-half = 1.5 × 30 × 8 = $360.00 = 36,000c. + alternative day accrued.
{
  const v = ha.valueLeave('PUBLIC_HOLIDAY', {
    isOWD: true,
    worked: true,
    hoursWorked: 8,
    hourlyRateMinor: 3000,
    ruleDate: '2026-10-26',
  });
  check('S31 ExB public holiday worked OWD pay', 36000, v.amountMinor);
  check('S31 ExB alt day accrued', true, v.alternativeDayAccrued);
}

// ── S32: §9.13 Example C — public holiday NOT worked, OWD. RDP = 30×8 = $240.00. ──
// paid RDP day off = 24,000c, no alt day.
{
  const v = ha.valueLeave('PUBLIC_HOLIDAY', {
    isOWD: true,
    worked: false,
    dailyRateCtx: { hoursThatDay: 8, hourlyRateMinor: 3000 },
    ruleDate: '2026-10-26',
  });
  check('S32 ExC public holiday not-worked OWD RDP pay', 24000, v.amountMinor);
  check('S32 ExC no alt day', false, v.alternativeDayAccrued);
}

// ── S33: public holiday WORKED, NOT OWD → time-and-a-half, NO alt day. (§9.7 quadrant) ──
// $25/hr, 6h → 1.5 × 25 × 6 = $225.00 = 22,500c. alternativeDayAccrued = false.
{
  const v = ha.valueLeave('PUBLIC_HOLIDAY', {
    isOWD: false,
    worked: true,
    hoursWorked: 6,
    hourlyRateMinor: 2500,
    ruleDate: '2026-10-26',
  });
  check('S33 public holiday worked NOT OWD pay', 22500, v.amountMinor);
  check('S33 public holiday worked NOT OWD no alt day', false, v.alternativeDayAccrued);
}

// ── S34: public holiday NOT worked, NOT OWD → nothing. (§9.7 quadrant) ──
{
  const v = ha.valueLeave('PUBLIC_HOLIDAY', {
    isOWD: false,
    worked: false,
    ruleDate: '2026-10-26',
  });
  check('S34 public holiday not-worked not-OWD = nothing', 0, v.amountMinor);
  check('S34 method NONE', 'NONE', v.method);
}

// ── S35: Mondayisation — Boxing Day Sat 26 Dec 2026 → observed Mon 28 Dec (not an OWD). ──
{
  const m = ha.mondayiseObservedDate({
    holidayCode: 'BOXING_DAY',
    actualDate: '2026-12-26',
    isOWDonActual: false,
    ruleDate: '2026-12-26',
  });
  check('S35 Boxing Day mondayised observed date', '2026-12-28', m.observedDate);
  check('S35 Boxing Day mondayised flag', true, m.mondayised);
}

// ── S36: Mondayisation suppressed when weekend day IS an OWD (§15.5). ANZAC Sat 25 Apr. ──
// Entitlement stays on the actual Saturday, never the Monday → one entitlement.
{
  const m = ha.mondayiseObservedDate({
    holidayCode: 'ANZAC_DAY',
    actualDate: '2026-04-25',
    isOWDonActual: true,
    ruleDate: '2026-04-25',
  });
  check('S36 ANZAC weekend-is-OWD stays on actual', '2026-04-25', m.observedDate);
  check('S36 ANZAC not mondayised', false, m.mondayised);
}

// ── S37: RDP vs ADP router — RDP determinable, no s9A trigger → RDP used. ──
// sick day: hoursThatDay 8 × $30 = $240.00 = 24,000c, method RDP.
{
  const v = ha.valueLeave('SICK', {
    rdpDeterminable: true,
    payVaries: false,
    hoursThatDay: 8,
    hourlyRateMinor: 3000,
    daysTaken: 1,
  });
  check('S37 sick RDP amount', 24000, v.amountMinor);
  check('S37 sick method RDP', 'RDP', v.method);
}

// ── S38: §9.13 Example D — sick day, variable hours → ADP (s9A pay varies). ──
// last 52-wk gross $36,400 ; paid days 182 → ADP = 36,400/182 = $200.00 = 20,000c.
//   ADP rate-units = roundHalfUp(3,640,000c × 100 / 182) = roundHalfUp(364,000,000/182)
//   = roundHalfUp(2,000,000) = 2,000,000 → cents = 20,000c.
{
  const v = ha.valueLeave('SICK', {
    rdpDeterminable: false,
    grossEarnings52Minor: 3640000,
    paidDays: 182,
    daysTaken: 1,
  });
  check('S38 ExD sick ADP amount', 20000, v.amountMinor);
  check('S38 ExD sick method ADP', 'ADP', v.method);
}

// ── S39: alternative day taken — valued at RDP, full day regardless of hours (§9.7). ──
// RDP = 8h × $30 = $240.00 = 24,000c.
{
  const v = ha.valueLeave('ALTERNATIVE_DAY', {
    dailyRateCtx: { hoursThatDay: 8, hourlyRateMinor: 3000 },
  });
  check('S39 alt day taken RDP value', 24000, v.amountMinor);
}

// ── S40: bereavement (BAPS) paid at RDP. 8h × $28 = $224.00 = 22,400c, 1 day. ──
{
  const v = ha.valueLeave('BEREAVEMENT', {
    rdpDeterminable: true,
    hoursThatDay: 8,
    hourlyRateMinor: 2800,
    daysTaken: 1,
  });
  check('S40 bereavement RDP', 22400, v.amountMinor);
}

// ── S41: §9.13 Example E — 8% PAYG ALLOWED (genuine 3-month fixed-term). ──
// gross this pay $2,000 → 8% = $160.00 = 16,000c, permitted, no anomaly.
{
  const v = ha.valueLeave('ANNUAL_HOLIDAY_PAYG', {
    grossEarningsThisPayMinor: 200000,
    employment: { type: 'FIXED_TERM', fixedTermMonths: 3, agreedInWriting: true },
    ruleDate: '2026-04-15',
  });
  check('S41 ExE PAYG 8% amount', 16000, v.amountMinor);
  check('S41 ExE PAYG permitted', true, v.permitted);
  check('S41 ExE PAYG no anomaly', 0, (v.anomalies || []).length);
}

// ── S42: 8% PAYG FORBIDDEN for permanent staff → PAYG_FORBIDDEN anomaly. (§9.6 gate) ──
{
  const v = ha.valueLeave('ANNUAL_HOLIDAY_PAYG', {
    grossEarningsThisPayMinor: 200000,
    employment: { type: 'PERMANENT', agreedInWriting: true },
    ruleDate: '2026-04-15',
  });
  check('S42 PAYG forbidden permanent', false, v.permitted);
  const a = (v.anomalies || []).find((x) => x.code === 'PAYG_FORBIDDEN');
  check('S42 PAYG_FORBIDDEN anomaly raised', true, !!a);
}

// ── S43: termination pre-entitlement — 8% of gross since anchor less advances (§9.6/§10). ──
// gross since start $26,000 = 2,600,000c, advances $500 = 50,000c.
// base = 2,600,000 - 50,000 = 2,550,000c. 8% = 204,000c = $2,040.00.
{
  const v = ha.valueLeave('ANNUAL_HOLIDAY_PRE_ENTITLE', {
    grossEarningsSinceAnchorMinor: 2600000,
    advancesTakenMinor: 50000,
    ruleDate: '2026-04-15',
  });
  check('S43 termination pre-entitlement 8%', 204000, v.amountMinor);
}

// ── S44: OWD test — regular weekly pattern includes the weekday. (§9.7) ──
// 2026-10-26 is Labour Day (Monday). Work pattern includes MON → isOWD true.
{
  const owd = ha.otherwiseWorkingDay({
    date: '2026-10-26',
    workPattern: { daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'] },
  });
  check('S44 OWD pattern includes Monday', true, owd.isOWD);
}

// ── S45: OWD test — pattern excludes the weekday → not OWD. ──
// 2026-10-26 Monday; pattern works Tue-Thu only → not OWD.
{
  const owd = ha.otherwiseWorkingDay({
    date: '2026-10-26',
    workPattern: { daysOfWeek: ['TUE', 'WED', 'THU'] },
  });
  check('S45 OWD pattern excludes Monday', false, owd.isOWD);
}

/* ════════════════════════════════════════════════════════════════════════════
 * Summary
 * ════════════════════════════════════════════════════════════════════════════ */

const total = passed + failed;
console.log(`\nNZ golden dataset: ${total} assertions, ${passed} passed, ${failed} failed.\n`);
if (discrepancies.length) {
  console.log('DISCREPANCIES:');
  for (const d of discrepancies) console.log('  - ' + d);
  console.log('');
}

module.exports = { passed, failed, discrepancies };

if (failed > 0) process.exitCode = 1;

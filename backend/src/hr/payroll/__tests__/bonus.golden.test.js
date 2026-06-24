'use strict';

/*
 * bonus.golden.test.js — INDEPENDENT QA golden-dataset test for the pure Statutory
 * Bonus core (../bonus.js), Payment of Bonus Act 1965 (Feature 22).
 *
 * Plain-node test (built-in `assert`, NO jest, NO node_modules):
 *   node backend/src/hr/payroll/__tests__/bonus.golden.test.js
 *
 * EVERY expected value is derived BY HAND from docs/features/22-statutory-bonus.md
 * §2 (worked examples), §10 (edge cases), §12 (acceptance). The engine internals
 * were NOT read to back-fill expecteds. MONEY: integer minor units (paise).
 *
 * §2 worked examples (FY2025-26, declared rate 8.33% = 833bp):
 *   ₹12,000 Basic+DA -> capped ₹7,000 -> 7,000×12=84,000 @8.33% = 6,997.20 -> ₹6,997
 *   ₹6,000  Basic+DA -> actual ₹6,000 -> 6,000×12=72,000 @8.33% = 5,997.6  -> ₹5,998
 *   ₹25,000 Basic+DA -> OVER ₹21,000 ceiling -> ineligible
 *   @20%: 84,000 × 20% = ₹16,800
 */

const assert = require('assert');
const B = require('../bonus.js');

const P = 100;
const R = (rupees) => rupees * P;

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
    console.error(`FAIL  ${msg}`);
  }
}

const FY2025 = '2026-03-31'; // accounting-year end for FY 2025-26
const FY2013 = '2013-03-31'; // a pre-2015 accounting year

// Convenience: compute ONE award via the cycle core (rate in bp; default 833).
function award(rupeesBasicDa, { months = 12, rateBp = 833, fyEnd = FY2025, advance = 0, workedDays = 365, disq = false, minWage = null } = {}) {
  const out = B.computeBonusCycle(
    { accountingYearEnd: fyEnd, rateBasisPoints: rateBp, minWageMonthlyMinor: minWage },
    [{ employeeId: 'e', monthlyBasicDaMinor: R(rupeesBasicDa), eligibleMonths: months, advancePaidMinor: advance, workedDays, disqualifiedS9: disq }],
  );
  return out.awards[0];
}

// ===========================================================================
// A — §2 worked examples (the documented golden seed)
// ===========================================================================
{
  const a = award(12000); // capped at ₹7,000
  check('A1 ₹12k eligible', true, a.eligible);
  check('A1 ₹12k capped base -> ₹7,000', R(7000), a.cappedBaseMinor);
  check('A1 ₹12k @8.33% -> ₹6,997 (6,997.20 → nearest ₹1)', R(6997), a.grossBonusMinor);
  check('A1 ₹12k net == gross (no advance)', R(6997), a.netBonusMinor);
}
{
  const a = award(6000); // under the ₹7,000 cap -> use ACTUAL
  check('A2 ₹6k uses actual base (NOT grossed up)', R(6000), a.cappedBaseMinor);
  check('A2 ₹6k @8.33% -> ₹5,998 (5,997.6 → nearest ₹1)', R(5998), a.grossBonusMinor);
}
{
  const a = award(25000); // over the ₹21,000 ceiling
  check('A3 ₹25k OVER_CEILING ineligible', false, a.eligible);
  check('A3 ₹25k reason OVER_CEILING', 'OVER_CEILING', a.ineligibleReason);
  check('A3 ₹25k gross ₹0', 0, a.grossBonusMinor);
}
{
  const a = award(12000, { rateBp: 2000 }); // 20% maximum
  check('A4 ₹12k @20% -> ₹16,800 (84,000 × 20%)', R(16800), a.grossBonusMinor);
}

// ===========================================================================
// B — §10 edge cases
// ===========================================================================
// B1 (§10.1) ceiling exactly ₹21,000 inclusive -> eligible; ₹21,001 -> ineligible.
{
  check('B1 ₹21,000 exactly -> eligible', true, award(21000).eligible);
  check('B1 ₹21,001 -> ineligible OVER_CEILING', 'OVER_CEILING', award(21001).ineligibleReason);
}
// B2 (§10.4 / §8) < 30 worked days -> ineligible even if wages ≤ ₹21,000.
{
  const a = award(8000, { workedDays: 20, months: 1 });
  check('B2 < 30 worked days -> UNDER_30_DAYS', 'UNDER_30_DAYS', a.ineligibleReason);
  check('B2 exactly 30 days -> eligible', true, award(8000, { workedDays: 30, months: 1 }).eligible);
}
// B3 (§10.6 / §9) disqualified for fraud/theft -> forfeits the whole year.
{
  const a = award(8000, { disq: true });
  check('B3 §9 disqualified -> DISQUALIFIED_S9', 'DISQUALIFIED_S9', a.ineligibleReason);
  check('B3 §9 disqualified gross ₹0', 0, a.grossBonusMinor);
}
// B4 (§10.7 / §13) mid-year proration: 6 eligible months on ₹12k @8.33%.
//   7,000 × 6 = 42,000 × 8.33% = 3,498.6 -> ₹3,499.
{
  const a = award(12000, { months: 6 });
  check('B4 6-month proration -> ₹3,499', R(3499), a.grossBonusMinor);
  check('B4 eligibleMonths frozen at 6', 6, a.eligibleMonths);
}
// B5 (§10.11) advance/interim already paid -> deduct from gross, floor net at 0.
{
  const a = award(12000, { advance: R(2000) }); // gross 6,997 - 2,000 advance
  check('B5 advance ₹2,000 -> net ₹4,997', R(4997), a.netBonusMinor);
  check('B5 gross unchanged ₹6,997', R(6997), a.grossBonusMinor);
  const floored = award(6000, { advance: R(100000) }); // advance > gross -> floor 0
  check('B5 advance > gross -> net floored at ₹0', 0, floored.netBonusMinor);
}
// B6 (§10.9) rate outside band -> clamped into [833, 2000] at the core.
{
  check('B6 rate 500bp clamped up to 833', 833, award(12000, { rateBp: 500 }).rateBasisPoints);
  check('B6 rate 9999bp clamped down to 2000', 2000, award(12000, { rateBp: 9999 }).rateBasisPoints);
}

// ===========================================================================
// C — §2 pre-2015 effective-dating (₹10,000 ceiling / ₹3,500 calc base)
// ===========================================================================
{
  // ₹12,000 was OVER the ₹10,000 pre-2015 ceiling -> ineligible.
  const over = award(12000, { fyEnd: FY2013 });
  check('C1 pre-2015 ₹12k OVER ₹10,000 ceiling -> ineligible', 'OVER_CEILING', over.ineligibleReason);
  // ₹8,000 capped at pre-2015 ₹3,500 -> 3,500 × 12 = 42,000 × 8.33% = 3,498.6 -> ₹3,499.
  const ok = award(8000, { fyEnd: FY2013 });
  check('C2 pre-2015 ₹8k capped at ₹3,500', R(3500), ok.cappedBaseMinor);
  check('C2 pre-2015 ₹8k @8.33% -> ₹3,499', R(3499), ok.grossBonusMinor);
}

// ===========================================================================
// D — §10.3 minimum-wage cap raise: calc ceiling = max(₹7,000, min wage)
// ===========================================================================
{
  // Min wage ₹10,000 > ₹7,000 -> ₹12k capped at ₹10,000 (not ₹7,000).
  //   10,000 × 12 = 120,000 × 8.33% = 9,996 -> ₹9,996.
  const a = award(12000, { minWage: R(10000) });
  check('D1 min-wage ₹10k raises calc ceiling -> capped base ₹10,000', R(10000), a.cappedBaseMinor);
  check('D1 ₹12k @8.33% on ₹10k base -> ₹9,996', R(9996), a.grossBonusMinor);
}

// ===========================================================================
// E — cycle-level totals + mint-ready payRunInput (the fnf.js parallel)
// ===========================================================================
{
  const out = B.computeBonusCycle(
    { accountingYearEnd: FY2025, rateBasisPoints: 833 },
    [
      { employeeId: 'a', monthlyBasicDaMinor: R(12000), eligibleMonths: 12, workedDays: 365 }, // ₹6,997
      { employeeId: 'b', monthlyBasicDaMinor: R(6000), eligibleMonths: 12, workedDays: 365 },  // ₹5,998
      { employeeId: 'c', monthlyBasicDaMinor: R(25000), eligibleMonths: 12, workedDays: 365 }, // ineligible
    ],
  );
  check('E1 eligibleCount 2', 2, out.totals.eligibleCount);
  check('E1 ineligibleCount 1', 1, out.totals.ineligibleCount);
  check('E1 totalNet 6,997 + 5,998 = ₹12,995', R(12995), out.totals.totalNetMinor);
  check('E2 payRunInput.type BONUS', 'BONUS', out.payRunInput.type);
  check('E2 payRunInput net == Σ eligible nets', R(12995), out.payRunInput.netMinor);
  check('E2 payRunInput has 2 lines (eligible only)', 2, out.payRunInput.lines.length);
  check('E2 line earning code STAT_BONUS', 'STAT_BONUS', out.payRunInput.lines[0].earnings[0].code);
  // gross − deductions == net by construction.
  check('E3 payRunInput gross − deductions == net', out.payRunInput.netMinor, out.payRunInput.grossMinor - out.payRunInput.totalDeductionsMinor);
}

// ===========================================================================
// F — §15/§16 set-on/set-off advisory (never gates an award)
// ===========================================================================
{
  // surplus 50,000 > max bonus 40,000 -> distribute max, set-on the 10,000 excess.
  const so = B.computeSetOnSetOff({ allocableSurplusMinor: R(50000), totalMinBonusMinor: R(20000), totalMaxBonusMinor: R(40000), priorSetOnMinor: 0 });
  check('F1 set-on excess -> ₹10,000', R(10000), so.setOnMinor);
  check('F1 distributable == max ₹40,000', R(40000), so.distributableMinor);
  // surplus 15,000 < min 20,000 -> set-off from prior set-on (cap at shortfall 5,000).
  const sf = B.computeSetOnSetOff({ allocableSurplusMinor: R(15000), totalMinBonusMinor: R(20000), totalMaxBonusMinor: R(40000), priorSetOnMinor: R(8000) });
  check('F2 set-off shortfall (capped at ₹5,000)', R(5000), sf.setOffMinor);
  check('F2 distributable == min ₹20,000', R(20000), sf.distributableMinor);
  // no allocable surplus entered -> advisory not applicable.
  const na = B.computeSetOnSetOff({ allocableSurplusMinor: null, totalMinBonusMinor: R(20000), totalMaxBonusMinor: R(40000) });
  check('F3 no surplus -> applicable:false', false, na.applicable);
}

// ===========================================================================
console.log('');
console.log(`Bonus golden test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
if (failed > 0) {
  console.log('Discrepancies:');
  for (const d of discrepancies) console.log('  - ' + d);
  process.exitCode = 1;
} else {
  console.log('=== ALL F22 BONUS GOLDENS PASSED ===');
}

'use strict';

/*
 * variablePay.golden.test.js — INDEPENDENT QA golden-dataset test for the pure
 * Variable-Pay core (../variablePay.js), Feature 46 (Phase 4).
 *
 * Plain-node test (built-in `assert`, NO jest, NO node_modules):
 *   node backend/src/hr/payroll/__tests__/variablePay.golden.test.js
 *
 * Every expected value is derived BY HAND. MONEY: integer minor units (paise).
 * ₹1 = 100 paise.  Formula under test:
 *   basis≠FIXED → targetMinor  = HALF_UP(basisMinor × targetPct%)
 *   basis=FIXED → targetMinor  = targetAmountMinor
 *   achievedMinor = HALF_UP(targetMinor × achievementPct%)
 *   computedMinor = HALF_UP(achievedMinor × prorationFactor)
 */

const assert = require('assert');
const V = require('../variablePay.js');

const P = 100;
const R = (rupees) => rupees * P; // rupees → paise

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

// ===========================================================================
// A — target from a PERCENT of basis (GROSS/BASIC/CTC)
// ===========================================================================
{
  // ₹50,000 gross @ 10% → ₹5,000 target; full achievement + no proration → ₹5,000.
  const a = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS' });
  check('A1 10% of ₹50,000 target', R(5000), a.targetMinor);
  check('A1 computed == target (100% × 1)', R(5000), a.computedMinor);
}
{
  // ₹15,000 basic @ 8.33% → ₹1,249.50 exactly (money.js golden example).
  const a = V.computeAward({ basisMinor: R(15000), targetPct: 8.33, basis: 'BASIC' });
  check('A2 8.33% of ₹15,000 → ₹1,249.50 (124950 paise)', 124950, a.targetMinor);
}
{
  // CTC basis: annual ₹12,00,000 @ 5% → ₹60,000 target.
  const a = V.computeAward({ basisMinor: R(1200000), targetPct: 5, basis: 'CTC' });
  check('A3 5% of ₹12,00,000 CTC target', R(60000), a.targetMinor);
}

// ===========================================================================
// B — target from a FIXED amount (basis ignored)
// ===========================================================================
{
  const a = V.computeAward({ basisMinor: R(999999), targetAmountMinor: R(8000), basis: 'FIXED_AMOUNT', targetPct: 10 });
  check('B1 FIXED target = targetAmount (ignores basis+pct)', R(8000), a.targetMinor);
  check('B1 FIXED computed == target', R(8000), a.computedMinor);
}

// ===========================================================================
// C — achievement% scaling
// ===========================================================================
{
  // ₹5,000 target × 80% = ₹4,000.
  const a = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS', achievementPct: 80 });
  check('C1 80% achievement → ₹4,000', R(4000), a.computedMinor);
}
{
  // Over-achievement 120% → ₹6,000.
  const a = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS', achievementPct: 120 });
  check('C2 120% achievement → ₹6,000', R(6000), a.computedMinor);
}
{
  // 0% achievement → ₹0.
  const a = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS', achievementPct: 0 });
  check('C3 0% achievement → ₹0', 0, a.computedMinor);
}

// ===========================================================================
// D — proration (resolveProration + computeAward)
// ===========================================================================
{
  check('D1 NONE → 1', 1, V.resolveProration({ method: 'NONE', activeDays: 45, periodDays: 90 }));
  check('D2 BY_TENURE 45/90 → 0.5', 0.5, V.resolveProration({ method: 'BY_TENURE', activeDays: 45, periodDays: 90 }));
  check('D3 BY_TENURE active>period clamps to 1', 1, V.resolveProration({ method: 'BY_TENURE', activeDays: 100, periodDays: 90 }));
  check('D4 zero periodDays → 1 (no data)', 1, V.resolveProration({ method: 'BY_TENURE', activeDays: 45, periodDays: 0 }));
  check('D5 BY_ATTENDANCE reuses day-fraction 30/90', 30 / 90, V.resolveProration({ method: 'BY_ATTENDANCE', activeDays: 30, periodDays: 90 }));
}
{
  // ₹5,000 target × 100% × 0.5 proration → ₹2,500.
  const a = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS', prorationFactor: 0.5 });
  check('D6 half-period proration → ₹2,500', R(2500), a.computedMinor);
}
{
  // Combined: ₹5,000 target × 80% × 0.5 → ₹2,000.
  const a = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS', achievementPct: 80, prorationFactor: 0.5 });
  check('D7 80% × half-period → ₹2,000', R(2000), a.computedMinor);
}

// ===========================================================================
// E — rounding (HALF_UP, exact paise)
// ===========================================================================
{
  // 8.35% of 1000 paise = 83.5 → HALF_UP → 84.
  const a = V.computeAward({ basisMinor: 1000, targetPct: 8.35, basis: 'GROSS' });
  check('E1 8.35% of 1000p = 83.5 → 84 (HALF_UP)', 84, a.targetMinor);
  // 8.33% of 1000 paise = 83.3 → 83.
  const b = V.computeAward({ basisMinor: 1000, targetPct: 8.33, basis: 'GROSS' });
  check('E2 8.33% of 1000p = 83.3 → 83', 83, b.targetMinor);
  // proration rounding: 1001 paise × 0.5 = 500.5 → HALF_UP → 501.
  const c = V.computeAward({ basisMinor: 0, targetAmountMinor: 1001, basis: 'FIXED_AMOUNT', prorationFactor: 0.5 });
  check('E3 1001p × 0.5 = 500.5 → 501 (HALF_UP)', 501, c.computedMinor);
  // achievement rounding: 1001 target × 50% = 500.5 → 501.
  const d = V.computeAward({ basisMinor: 0, targetAmountMinor: 1001, basis: 'FIXED_AMOUNT', achievementPct: 50 });
  check('E4 1001p × 50% = 500.5 → 501 (HALF_UP)', 501, d.computedMinor);
}

// ===========================================================================
// F — cycle totals sum
// ===========================================================================
{
  const a1 = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS' }); // 5,000
  const a2 = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS', achievementPct: 80 }); // 4,000
  const a3 = V.computeAward({ basisMinor: R(50000), targetPct: 10, basis: 'GROSS', prorationFactor: 0.5 }); // 2,500
  const totals = V.computeCycleTotals([a1, a2, a3]);
  check('F1 headcount 3', 3, totals.headcount);
  check('F2 Σ target = 15,000', R(15000), totals.totalTargetMinor);
  check('F3 Σ computed = 5,000+4,000+2,500 = ₹11,500', R(11500), totals.totalComputedMinor);
}

// ===========================================================================
console.log('');
console.log(`Variable-pay golden test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
if (failed > 0) {
  console.log('Discrepancies:');
  for (const d of discrepancies) console.log('  - ' + d);
  process.exitCode = 1;
} else {
  console.log('=== ALL F46 VARIABLE-PAY GOLDENS PASSED ===');
}

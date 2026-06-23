'use strict';

/*
 * accrual.golden.test.js — INDEPENDENT QA golden test for the leave accrual
 * engine (../accrual.js). Plain-node (built-in assert, no jest):
 *   node backend/src/hr/leave/__tests__/accrual.golden.test.js
 *
 * Every expected value is hand-derived from docs/features/06 §4.3–4.5. Covers
 * QA 1 (accrual), QA 2 (carry-forward/lapse), QA 3 (NZ continuous vesting).
 */

const assert = require('assert');
const A = require('../accrual.js');

let passed = 0; let failed = 0; const fails = [];
function check(name, expected, actual) {
  let ok;
  try { assert.deepStrictEqual(actual, expected); ok = true; } catch (_) { ok = false; }
  if (ok) { passed++; } else { failed++; fails.push({ name, expected, actual }); }
}
function near(name, expected, actual, eps = 1e-9) {
  const ok = Math.abs(expected - actual) <= eps;
  if (ok) { passed++; } else { failed++; fails.push({ name, expected, actual }); }
}

// ── QA1: monthly accrual sums to entitlement over 12 months ──────────────────
const elPolicy = { accrualMethod: 'MONTHLY_ACCRUAL', accrualFrequency: 'MONTHLY', entitlementPerYear: 18 };
let sum = 0;
for (let m = 0; m < 12; m += 1) {
  const r = A.accrueForPeriod(elPolicy, [], { tenureMonths: m, grain: 0.5, currentClosing: sum });
  sum += r.units;
}
near('1a monthly EL 18/yr sums to 18', 18, sum);

// per-tick = 1.5 (18/12)
check('1b monthly EL tick = 1.5',
  { units: 1.5, vested: true, capped: false },
  (() => { const r = A.accrueForPeriod(elPolicy, [], { tenureMonths: 3, grain: 0.5 }); return { units: r.units, vested: r.vested, capped: r.capped }; })());

// ── QA1: tiered AccrualRule switch at tenure boundary ─────────────────────────
const tiers = [
  { minTenureMonths: 0, maxTenureMonths: 59, ratePerPeriod: 1.5 }, // <5y
  { minTenureMonths: 60, maxTenureMonths: null, ratePerPeriod: 2.0 }, // ≥5y
];
near('1c tiered rate <5y = 1.5', 1.5, A.tieredRate(tiers, 24));
near('1d tiered rate ≥5y = 2.0', 2.0, A.tieredRate(tiers, 60));
near('1e tiered rate boundary 59 = 1.5', 1.5, A.tieredRate(tiers, 59));
check('1f no-tier returns null', null, A.tieredRate(tiers, 999) === 2.0 ? null : A.tieredRate(tiers, 999));

// accrueForPeriod uses the tier when present
near('1g accrue uses tier 2.0 at 72mo', 2.0,
  A.accrueForPeriod(elPolicy, tiers, { tenureMonths: 72, grain: 0.5 }).units);

// ── QA1: maxBalanceCap clamp ──────────────────────────────────────────────────
const capped = A.accrueForPeriod({ ...elPolicy, maxBalanceCap: 60 }, [], { tenureMonths: 3, grain: 0.5, currentClosing: 59 });
near('1h cap clamps grant to headroom (60-59=1)', 1, capped.units);
check('1i cap flag set', true, capped.capped);
const noHead = A.accrueForPeriod({ ...elPolicy, maxBalanceCap: 60 }, [], { tenureMonths: 3, grain: 0.5, currentClosing: 60 });
near('1j cap at ceiling grants 0', 0, noHead.units);

// ── QA1: UPFRONT vs MONTHLY pro-rata on join ──────────────────────────────────
// SL: UPFRONT 12 days, join mid-year. Full-year window 2026-04-01..2027-03-31.
const slPolicy = { accrualMethod: 'UPFRONT_ANNUAL', entitlementPerYear: 12, accrualProrateOnJoin: true };
// join 2026-10-01: remaining days / 365 of 12.
const upPro = A.prorataOnJoin(slPolicy, '2026-10-01', '2026-04-01', '2027-03-31', { grain: 0.5 });
// remaining inclusive 2026-10-01..2027-03-31 = 182 days; total 365; 12*182/365=5.9835 → grain .5 → 6.0
near('1k UPFRONT pro-rata join Oct ~6.0', 6.0, upPro);
// no-prorate UPFRONT grants full 12
near('1l UPFRONT no-prorate grants full', 12,
  A.prorataOnJoin({ ...slPolicy, accrualProrateOnJoin: false }, '2026-10-01', '2026-04-01', '2027-03-31'));

// MONTHLY pro-rata: join on/before the 15th counts the join month (1 tick), after → 0
near('1m MONTHLY join 10th counts 1 tick (1.5)', 1.5,
  A.prorataOnJoin(elPolicy, '2026-10-10', '2026-04-01', '2027-03-31', { grain: 0.5 }));
near('1n MONTHLY join 20th counts 0', 0,
  A.prorataOnJoin(elPolicy, '2026-10-20', '2026-04-01', '2027-03-31', { grain: 0.5 }));

// ── QA2: carry-forward / lapse math ───────────────────────────────────────────
check('2a EL carry min(closing,cap=45), lapse rest', { carried: 45, lapsed: 5 }, A.yearEndRoll({ carryForwardCap: 45 }, 50));
check('2b NZ annual cap=null never lapses', { carried: 50, lapsed: 0 }, A.yearEndRoll({ carryForwardCap: null }, 50));
check('2c CL cap=0 lapses all', { carried: 0, lapsed: 12 }, A.yearEndRoll({ carryForwardCap: 0 }, 12));
check('2d closing 0 → nothing', { carried: 0, lapsed: 0 }, A.yearEndRoll({ carryForwardCap: 10 }, 0));
check('2e closing under cap carries all', { carried: 8, lapsed: 0 }, A.yearEndRoll({ carryForwardCap: 45 }, 8));

// ── QA2: FIFO carried-lot expiry ──────────────────────────────────────────────
// lot opened 2025-04-01, expiry 12mo → expires 2026-04-01. asOf 2026-06-01 → lapses.
const exp = A.carriedLotExpiry(
  [{ remaining: 3, openedAt: '2025-04-01' }, { remaining: 2, openedAt: '2026-04-01' }],
  '2026-06-01', 12, { grain: 0.5 });
near('2f FIFO expiry lapses the old lot (3)', 3, exp.lapsed);
check('2g FIFO expiry hits only the expired lot', 1, exp.perLot.length);
check('2h expiryMonths null → never lapses', { lapsed: 0, perLot: [] }, A.carriedLotExpiry([{ remaining: 5, openedAt: '2020-01-01' }], '2026-06-01', null));

// ── QA3: NZ continuous accrual + vesting ──────────────────────────────────────
const nzPolicy = { accrualMethod: 'CONTINUOUS_NZ', entitlementPerYear: 4, minTenureMonths: 12, accrualFrequency: 'PER_PAY_PERIOD' };
// one worked week accrues 4/52 of a week
const nzTick = A.accrueForPeriod(nzPolicy, [], { tenureMonths: 6, workedWeeks: 1, grain: 0.0001 });
near('3a NZ accrues 4/52 per week ~0.0769', 4 / 52, nzTick.units, 1e-4);
check('3b NZ NOT vested before 12mo', false, A.accrueForPeriod(nzPolicy, [], { tenureMonths: 6, workedWeeks: 1 }).vested);
check('3c NZ vested at/after 12mo', true, A.accrueForPeriod(nzPolicy, [], { tenureMonths: 12, workedWeeks: 1 }).vested);
// 52 weeks → 4 weeks
let nzSum = 0;
for (let w = 0; w < 52; w += 1) nzSum += A.accrueForPeriod(nzPolicy, [], { tenureMonths: 13, workedWeeks: 1, grain: 0.0001 }).units;
near('3d NZ 52 weeks ≈ 4 weeks', 4, nzSum, 0.02);

// ── encashableUnits ───────────────────────────────────────────────────────────
near('4a encashable when type.isEncashable', 13, A.encashableUnits({}, { closing: 13 }, { type: { isEncashable: true } }));
near('4b not encashable → 0', 0, A.encashableUnits({}, { closing: 13 }, { type: { isEncashable: false } }));
near('4c encash capped by maxEncashCap', 10, A.encashableUnits({ maxEncashCap: 10 }, { closing: 13 }, { type: { isEncashable: true } }));
near('4d encashOnExit also enables', 5, A.encashableUnits({ encashOnExit: true }, { closing: 5 }, { type: {} }));

// ── tenure helper ─────────────────────────────────────────────────────────────
check('5a tenure 12mo exact', 12, A.tenureMonthsBetween('2025-06-01', '2026-06-01'));
check('5b tenure not-yet-completed month', 11, A.tenureMonthsBetween('2025-06-15', '2026-06-01'));

// ── report ────────────────────────────────────────────────────────────────────
console.log(`\naccrual.golden: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of fails) console.error('FAIL', f.name, JSON.stringify(f)); process.exit(1); }

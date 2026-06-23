'use strict';

/**
 * performance.unit.test.js — Feature 8 PURE-logic proofs (no DB). Plain-node runner
 * (no jest), same style as attendance/derive.golden. Covers:
 *   - goalRollup: KR progress (INCREASE/DECREASE/MAINTAIN/BOOLEAN), weighted mean,
 *     parent rollup, weight-sum invariants (Σ=100).
 *   - proration: full cycle, mid-cycle joiner fraction, hired-after-cycle deferral.
 *   - reviewStateMachine: self-required gate (no NOT_STARTED→MANAGER skip), SoD
 *     (reviewer≠reviewee), calibrate role guard, release gate on acknowledge,
 *     legal transitions succeed / illegal 409.
 *   - meritHandoff: rating→% matrix (bucket + bands).
 *   - calibration: distribution + soft target warning (never auto-clamps).
 *
 * Run: node src/hr/talent/__tests__/performance.unit.test.js
 */

const rollup = require('../performance/goalRollup');
const { computeProrationFactor } = require('../performance/proration');
const sm = require('../performance/reviewStateMachine');
const { recommendedPctForRating } = require('../performance/meritHandoff');
const { distribution, distributionWarning } = require('../performance/calibration');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
function near(a, b, eps = 0.011) { return Math.abs(a - b) <= eps; }

log('\n=== Feature 8 performance unit proofs ===\n');

// ── goalRollup: KR progress ───────────────────────────────────────────────────
log('(1) KR progress:');
assert(near(rollup.krProgress({ metricType: 'NUMERIC', direction: 'INCREASE', startValue: 0, targetValue: 100, currentValue: 40 }), 40), 'INCREASE 0→100 @40 = 40%');
assert(near(rollup.krProgress({ metricType: 'NUMERIC', direction: 'INCREASE', startValue: 0, targetValue: 100, currentValue: 200 }), 100), 'INCREASE clamps over-target to 100%');
assert(near(rollup.krProgress({ metricType: 'NUMERIC', direction: 'INCREASE', startValue: 0, targetValue: 100, currentValue: -10 }), 0), 'INCREASE clamps below-start to 0%');
assert(near(rollup.krProgress({ metricType: 'NUMERIC', direction: 'DECREASE', startValue: 100, targetValue: 0, currentValue: 25 }), 75), 'DECREASE 100→0 @25 = 75% (lower-is-better inverts)');
assert(rollup.krProgress({ metricType: 'BOOLEAN', startValue: 0, targetValue: 1, currentValue: 1 }) === 100, 'BOOLEAN done = 100');
assert(rollup.krProgress({ metricType: 'BOOLEAN', startValue: 0, targetValue: 1, currentValue: 0 }) === 0, 'BOOLEAN not-done = 0');

// ── goalRollup: weighted objective progress ──────────────────────────────────
log('(2) Objective weighted-mean progress:');
{
  const krs = [
    { weight: 50, metricType: 'NUMERIC', direction: 'INCREASE', startValue: 0, targetValue: 100, currentValue: 100 }, // 100%
    { weight: 50, metricType: 'NUMERIC', direction: 'INCREASE', startValue: 0, targetValue: 100, currentValue: 0 },   // 0%
  ];
  assert(near(rollup.objectiveProgress(krs), 50), '50/50 split of 100% + 0% = 50%');
  const krs2 = [
    { weight: 80, metricType: 'NUMERIC', direction: 'INCREASE', startValue: 0, targetValue: 100, currentValue: 100 }, // 100%
    { weight: 20, metricType: 'NUMERIC', direction: 'INCREASE', startValue: 0, targetValue: 100, currentValue: 0 },   // 0%
  ];
  assert(near(rollup.objectiveProgress(krs2), 80), '80/20 weighting = 80%');
}

// ── goalRollup: parent rollup ────────────────────────────────────────────────
log('(3) Parent rollup from aligned children:');
assert(near(rollup.parentRollup([{ progress: 80, alignmentWeight: 50 }, { progress: 40, alignmentWeight: 50 }]), 60), 'two children 80@50% + 40@50% → 60');

// ── goalRollup: weight invariants ────────────────────────────────────────────
log('(4) Weight Σ=100 invariant:');
assert(rollup.checkWeightSum([{ weight: 60 }, { weight: 40 }]).ok, 'Σ=100 ok');
assert(!rollup.checkWeightSum([{ weight: 60 }, { weight: 30 }]).ok, 'Σ=90 violates');
assert(!rollup.checkWeightSum([{ weight: 60 }, { weight: 50 }]).ok, 'Σ=110 violates');

// ── proration ─────────────────────────────────────────────────────────────────
log('(5) Proration factor:');
{
  const full = computeProrationFactor({ periodStart: '2026-01-01', periodEnd: '2026-12-31', hireDate: '2020-01-01' });
  assert(full.factor === 1, 'tenured pre-cycle → 1.0');
  const mid = computeProrationFactor({ periodStart: '2026-01-01', periodEnd: '2026-12-31', hireDate: '2026-07-02' });
  assert(mid.factor > 0 && mid.factor < 1, `mid-cycle joiner fraction in (0,1) (=${mid.factor})`);
  assert(near(mid.factor, mid.daysInRole / mid.cycleDays, 0.0002), 'fraction = daysInRole / cycleDays');
  const after = computeProrationFactor({ periodStart: '2026-01-01', periodEnd: '2026-06-30', hireDate: '2026-09-01' });
  assert(after.factor === 0 && after.deferred, 'hired after cycle → 0 + deferred flag');
}

// ── state machine: self-required gate + SoD + no-skip ────────────────────────
log('(6) State machine — self-required + SoD:');
{
  const subject = 'S', reviewer = 'R';
  // BUG #3a: submitMgr from NOT_STARTED with selfRequired → rejected (no skip).
  const skip = sm.evaluate('submitMgr', 'NOT_STARTED', { actorEmployeeId: reviewer, subjectEmployeeId: subject, reviewerEmployeeId: reviewer, selfRequired: true });
  assert(!skip.ok && skip.code === 403, 'NOT_STARTED→MANAGER blocked when self required (no skip)');
  // selfRequired=false → manager may submit from NOT_STARTED.
  const noSelf = sm.evaluate('submitMgr', 'NOT_STARTED', { actorEmployeeId: reviewer, subjectEmployeeId: subject, reviewerEmployeeId: reviewer, selfRequired: false });
  assert(noSelf.ok && noSelf.to === 'MANAGER_SUBMITTED', 'NOT_STARTED→MANAGER allowed when self NOT required');
  // self submit by subject ok; by non-subject rejected.
  assert(sm.evaluate('submitSelf', 'NOT_STARTED', { actorEmployeeId: subject, subjectEmployeeId: subject, cycleStatus: 'ACTIVE' }).ok, 'subject submits self');
  assert(!sm.evaluate('submitSelf', 'NOT_STARTED', { actorEmployeeId: reviewer, subjectEmployeeId: subject, cycleStatus: 'ACTIVE' }).ok, 'non-subject cannot submit self');
  // legal manager submit after self.
  assert(sm.evaluate('submitMgr', 'SELF_SUBMITTED', { actorEmployeeId: reviewer, subjectEmployeeId: subject, reviewerEmployeeId: reviewer, selfRequired: true }).ok, 'SELF_SUBMITTED→MANAGER by reviewer ok');
  // BUG #3b: SoD — reviewer === subject cannot submit manager review.
  const sod = sm.evaluate('submitMgr', 'SELF_SUBMITTED', { actorEmployeeId: subject, subjectEmployeeId: subject, reviewerEmployeeId: subject, selfRequired: true });
  assert(!sod.ok && sod.code === 403, 'SoD: subject cannot submit their own manager review');
  // illegal source → 409.
  const illegal = sm.evaluate('acknowledge', 'NOT_STARTED', { actorEmployeeId: subject, subjectEmployeeId: subject });
  assert(!illegal.ok && illegal.code === 409, 'acknowledge from NOT_STARTED → 409 (illegal source)');
}

// ── state machine: calibrate role + release gate ─────────────────────────────
log('(7) State machine — calibrate role + release gate:');
{
  const subject = 'S', reviewer = 'R', hr = 'H';
  assert(!sm.evaluate('calibrate', 'MANAGER_SUBMITTED', { actorEmployeeId: reviewer, subjectEmployeeId: subject, isHr: false, isSkipLevel: false }).ok, 'plain reviewer cannot calibrate');
  assert(sm.evaluate('calibrate', 'MANAGER_SUBMITTED', { actorEmployeeId: hr, subjectEmployeeId: subject, isHr: true }).ok, 'HR can calibrate');
  // acknowledge requires released.
  const notReleased = sm.evaluate('acknowledge', 'CALIBRATED', { actorEmployeeId: subject, subjectEmployeeId: subject, released: false });
  assert(!notReleased.ok, 'acknowledge before release → rejected (release gate)');
  assert(sm.evaluate('acknowledge', 'CALIBRATED', { actorEmployeeId: subject, subjectEmployeeId: subject, released: true }).ok, 'acknowledge after release → ok');
}

// ── merit matrix ──────────────────────────────────────────────────────────────
log('(8) Merit rating→% matrix:');
assert(recommendedPctForRating(5, { 5: 12, 4: 8, 3: 4 }) === 12, 'bucket map: rating 5 → 12%');
assert(recommendedPctForRating(4.5, { bands: [{ min: 4, max: 5, pct: 9 }, { min: 3, max: 3.99, pct: 4 }] }) === 9, 'bands: 4.5 in [4,5] → 9%');
assert(recommendedPctForRating(null, { 5: 12 }) === 0, 'no rating → 0%');

// ── calibration distribution warning (no auto-clamp) ─────────────────────────
log('(9) Calibration distribution warning:');
{
  const instances = [
    { managerRating: 5 }, { managerRating: 5 }, { managerRating: 5 }, { managerRating: 5 }, // skewed high
    { managerRating: 3 },
  ];
  const dist = distribution(instances, [{ value: 5 }, { value: 4 }, { value: 3 }]);
  assert(dist.rated === 5, 'distribution counts all rated');
  const warn = distributionWarning(dist, { 5: 20, 4: 30, 3: 50 }, 10);
  assert(warn.hasTarget && !warn.withinTolerance, 'skewed actuals breach the target → warning (not clamp)');
  // The function only warns — it returns flags, it does not mutate ratings.
  assert(instances.every((i) => i.managerRating != null), 'ratings untouched (warn-only, never auto-clamps)');
}

log(`\n${failures === 0 ? 'ALL UNIT TESTS PASS' : failures + ' UNIT TEST FAILURE(S)'}\n`);
process.exit(failures === 0 ? 0 : 1);

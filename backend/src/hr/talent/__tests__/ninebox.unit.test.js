'use strict';

/**
 * ninebox.unit.test.js — Feature 34 PURE-logic proofs (no DB). Plain-node runner,
 * same style as performance.unit.test.js. Covers:
 *   - nineBox: bandFromRating (default + configured bands, scale-agnostic), the box
 *     math for all 9 combos, box null until both bands set, the perf-axis derivation
 *     precedence (calibrated ?? final ?? manager), the grid concentration warning
 *     (reuses calibration.distributionWarning — soft, never clamps), box labels.
 *   - placementStateMachine: legal/illegal transitions, the perf-axis-existence guard
 *     on authorPotential, the move SoD (actor ≠ subject) + session-OPEN guard, the
 *     finalize/reopen grants.
 *   - competencyRollup: gap = actual − expected, weighted score %, unmapped role → null
 *     (no error), unrated competency → actual null.
 *
 * Run: node src/hr/talent/__tests__/ninebox.unit.test.js
 */

const nb = require('../performance/nineBox');
const psm = require('../performance/placementStateMachine');
const { competencyGap, actualForCompetency } = require('../performance/competencyRollup');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
function near(a, b, eps = 0.011) { return a != null && b != null && Math.abs(a - b) <= eps; }

log('\n=== Feature 34 nine-box + competency unit proofs ===\n');

// ── nineBox: perf-axis derivation precedence (calibration.js:21) ──────────────
log('(1) Performance axis derivation (calibrated ?? final ?? manager):');
assert(nb.effectiveRating({ calibratedRating: 4.5, finalRating: 3, managerRating: 2 }) === 4.5, 'calibrated wins');
assert(nb.effectiveRating({ calibratedRating: null, finalRating: 3.2, managerRating: 2 }) === 3.2, 'final when no calibrated');
assert(nb.effectiveRating({ calibratedRating: null, finalRating: null, managerRating: 2.1 }) === 2.1, 'manager when neither');
assert(nb.effectiveRating({ calibratedRating: null, finalRating: null, managerRating: null }) === null, 'unrated → null (cannot place)');

// ── nineBox: bandFromRating (default 5-pt bands: <3→1, 3..<4→2, ≥4→3) ─────────
log('(2) bandFromRating (default 5-point bands):');
assert(nb.bandFromRating(2.9) === 1, '2.9 → band 1 (low)');
assert(nb.bandFromRating(3) === 2, '3.0 → band 2 (med)');
assert(nb.bandFromRating(3.99) === 2, '3.99 → band 2 (med)');
assert(nb.bandFromRating(4) === 3, '4.0 → band 3 (high)');
assert(nb.bandFromRating(5) === 3, '5.0 → band 3 (high)');
assert(nb.bandFromRating(null) === null, 'null rating → null band (unrated)');

// ── nineBox: bandFromRating is scale-agnostic (configured thresholds) ─────────
log('(3) bandFromRating (configured 1..10 bands — scale-agnostic):');
{
  const bands10 = [{ max: 4, band: 1 }, { max: 7, band: 2 }, { band: 3 }];
  assert(nb.bandFromRating(3, bands10) === 1, '1..10 scale: 3 → band 1');
  assert(nb.bandFromRating(6, bands10) === 2, '1..10 scale: 6 → band 2');
  assert(nb.bandFromRating(9, bands10) === 3, '1..10 scale: 9 → band 3');
}

// ── nineBox: box math = (potentialBand-1)*3 + performanceBand for all 9 combos ─
log('(4) Box math (potentialBand-1)*3 + performanceBand, all 9 combos:');
{
  let ok = true;
  const expected = {
    '1,1': 1, '2,1': 2, '3,1': 3,   // potential 1 (bottom row)
    '1,2': 4, '2,2': 5, '3,2': 6,   // potential 2 (middle row)
    '1,3': 7, '2,3': 8, '3,3': 9,   // potential 3 (top row)
  };
  for (const perf of [1, 2, 3]) {
    for (const pot of [1, 2, 3]) {
      const got = nb.computeBox(perf, pot);
      if (got !== expected[`${perf},${pot}`]) { ok = false; log(`    perf=${perf} pot=${pot} → ${got} (want ${expected[`${perf},${pot}`]})`); }
    }
  }
  assert(ok, 'all 9 (perf,potential) combos map to the correct box 1..9');
  assert(nb.computeBox(2, null) === null, 'box null until BOTH bands set (potential missing)');
  assert(nb.computeBox(null, 2) === null, 'box null until BOTH bands set (performance missing)');
  assert(nb.boxLabel(9) === 'Star' && nb.boxLabel(1) === 'Risk', 'box labels: 1=Risk, 9=Star');
}

// ── nineBox: grid concentration warning reuses calibration (soft, never clamps) ─
log('(5) Grid concentration warning (reuses calibration.distributionWarning):');
{
  const placements = [
    { box: 9 }, { box: 9 }, { box: 9 }, { box: 9 }, // over-concentrated in Star
    { box: 5 }, { box: null }, // null box ignored
  ];
  const { distribution, warning } = nb.gridConcentration(placements, { '9': 10, '5': 20 }, 10);
  assert(distribution.rated === 5, 'only placed (non-null box) people counted (5 of 6)');
  assert(warning.hasTarget && !warning.withinTolerance, 'over-target Box 9 → warning (advisory, not a clamp)');
  // The function only flags — placements untouched.
  assert(placements.every((p) => 'box' in p), 'placements untouched (warn-only, never auto-clamps)');
}

// ── placementStateMachine ─────────────────────────────────────────────────────
log('(6) Placement state machine — authorPotential perf-axis guard:');
assert(psm.evaluate('authorPotential', 'DRAFT', { isManagerOfSubject: true, reviewStatus: 'NOT_STARTED' }).code === 403, 'authorPotential before MANAGER_SUBMITTED → 403 (no perf axis)');
assert(psm.evaluate('authorPotential', 'DRAFT', { isManagerOfSubject: true, reviewStatus: 'MANAGER_SUBMITTED' }).ok, 'authorPotential after MANAGER_SUBMITTED, by manager → ok → PROPOSED');
assert(psm.evaluate('authorPotential', 'DRAFT', { isManagerOfSubject: false, isHr: false, reviewStatus: 'CALIBRATED' }).code === 403, 'authorPotential by a non-manager/non-HR → 403');

log('(7) Placement state machine — move SoD + session-OPEN guard:');
assert(psm.evaluate('move', 'PROPOSED', { actorEmployeeId: 'E1', subjectEmployeeId: 'E1', isSkipLevel: true, sessionOpen: true }).code === 403, 'SoD: actor === subject cannot move own box → 403');
assert(psm.evaluate('move', 'PROPOSED', { actorEmployeeId: 'MGR', subjectEmployeeId: 'E1', isSkipLevel: true, sessionOpen: false }).code === 403, 'move with no OPEN session → 403');
assert(psm.evaluate('move', 'PROPOSED', { actorEmployeeId: 'MGR', subjectEmployeeId: 'E1', isSkipLevel: true, sessionOpen: true }).ok, 'move by skip-level, session OPEN, actor≠subject → ok → CALIBRATED');
assert(psm.evaluate('move', 'CALIBRATED', { actorEmployeeId: 'HR', subjectEmployeeId: 'E1', isHr: true, sessionOpen: true }).to === 'CALIBRATED', 'move from CALIBRATED stays CALIBRATED (idempotent)');

log('(8) Placement state machine — finalize / reopen grants + illegal transitions:');
assert(psm.evaluate('finalize', 'CALIBRATED', { canSucceed: false }).code === 403, 'finalize without canManageSuccession → 403');
assert(psm.evaluate('finalize', 'CALIBRATED', { canSucceed: true }).to === 'FINALIZED', 'finalize with the grant → FINALIZED');
assert(psm.evaluate('finalize', 'DRAFT', { canSucceed: true }).code === 409, 'illegal: finalize from DRAFT → 409');
assert(psm.evaluate('reopen', 'FINALIZED', { isHr: true }).to === 'PROPOSED', 'reopen (HR) FINALIZED → PROPOSED');
assert(psm.evaluate('move', 'FINALIZED', { actorEmployeeId: 'HR', subjectEmployeeId: 'E1', isHr: true, sessionOpen: true }).code === 409, 'illegal: move a FINALIZED placement → 409');

// ── competencyRollup ──────────────────────────────────────────────────────────
log('(9) Competency rollup — gap, weighted score, unmapped/unrated:');
{
  const competencyById = { c1: { code: 'C1', name: 'Comm', category: 'CORE' }, c2: { code: 'C2', name: 'Lead', category: 'LEADERSHIP' } };
  const roleMaps = [
    { competencyId: 'c1', expectedLevel: 4, weight: 2 },
    { competencyId: 'c2', expectedLevel: 3, weight: 1 },
  ];
  const responses = [
    { sectionKey: 'competency', itemKey: 'c1', ratingValue: 3 }, // below bar (gap -1)
    { sectionKey: 'competency', itemKey: 'c2', ratingValue: 4 }, // above bar (gap +1)
    { sectionKey: 'goals', itemKey: 'g1', ratingValue: 5 },      // not a competency row — ignored
  ];
  const out = competencyGap(responses, roleMaps, competencyById);
  const c1 = out.gaps.find((g) => g.competencyId === 'c1');
  const c2 = out.gaps.find((g) => g.competencyId === 'c2');
  assert(near(c1.actual, 3) && near(c1.gap, -1), 'c1: actual 3, gap = actual − expected = -1 (below bar)');
  assert(near(c2.actual, 4) && near(c2.gap, 1), 'c2: actual 4, gap = +1 (above bar)');
  // weighted score = Σ(actual×w)/Σ(expected×w) = (3*2 + 4*1)/(4*2 + 3*1) = 10/11 ≈ 90.91%
  assert(near(out.scorePct, 90.91, 0.02), 'weighted competency score % = Σ(actual×w)/Σ(expected×w) ≈ 90.91');
  assert(out.mappedCount === 2 && out.ratedMappedCount === 2, 'mappedCount/ratedMappedCount track the role map');
}
log('(10) Competency rollup — edge cases:');
{
  // Unmapped role → empty gaps + null score (NOT an error).
  const none = competencyGap([{ sectionKey: 'competency', itemKey: 'c1', ratingValue: 3 }], [], {});
  assert(none.gaps.length === 0 && none.scorePct === null, 'unmapped role → empty gaps + null score (no error)');
  // Mapped but unrated → actual null, gap null, score null.
  const unrated = competencyGap([], [{ competencyId: 'c1', expectedLevel: 4 }], { c1: { code: 'C1' } });
  assert(unrated.gaps[0].actual === null && unrated.gaps[0].gap === null && unrated.scorePct === null, 'mapped-but-unrated → actual/gap/score null');
  assert(actualForCompetency([{ ratingValue: 2 }, { ratingValue: 4 }]) === 3, 'actualForCompetency = mean of competency responses');
}

log(`\n${failures === 0 ? 'ALL UNIT TESTS PASS' : failures + ' UNIT TEST FAILURE(S)'}\n`);
process.exit(failures === 0 ? 0 : 1);

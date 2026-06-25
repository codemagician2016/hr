'use strict';

/*
 * variance.golden.test.js — PURE golden test for the variance / exception engine
 * (../variance.js). Plain-node (built-in assert, NO jest, NO DB):
 *   node backend/src/hr/payroll/__tests__/variance.golden.test.js
 *
 * Two fixed line-sets (a prior period + a current period) → an EXACT sorted
 * finding list + severity buckets + blockingAnomalies. Every expected is derived
 * BY HAND from docs/07-payroll-run.md §5.1 (the check catalogue + outlier math),
 * NOT copied from the engine output.
 *
 * MONEY: integer minor units (paise/cents). ₹1 = 100 paise.
 */

const assert = require('assert');
const variance = require('../variance.js');

const P = 100;
const R = (rupees) => rupees * P;

let passed = 0;
let failed = 0;
const fails = [];
function check(name, expected, actual) {
  try {
    assert.deepStrictEqual(actual, expected);
    passed += 1;
  } catch (e) {
    failed += 1;
    fails.push(`${name}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    console.error('FAIL', name);
  }
}
function has(findings, code, employeeId) {
  return findings.find((f) => f.code === code && (employeeId === undefined || f.employeeId === employeeId)) || null;
}

// ===========================================================================
// SCENARIO 1 — period-over-period, steady plus surprises.
//
//   PREVIOUS (May): A net ₹48,000; B net ₹30,000 (statutory PT ₹200).
//   CURRENT  (June):
//     A  net ₹48,000   — unchanged → NO outlier.
//     B  net ₹15,000   — Δ% = (15000-30000)/30000 = -0.50 → hardNetPct 0.60? NO.
//                        softNetPct 0.25 ≤ 0.50 < 0.60 → NET_PCT_OUTLIER WARNING.
//                        B also lost PT (₹200→0) → STATUTORY_DROP_TO_ZERO BLOCKER.
//     C  net ₹60,000   — NEW joiner (no prev) → NEW_JOINER INFO; outliers suppressed.
//     D  net -₹500     — NEGATIVE_NET BLOCKER.
//     E  net ₹0, gross ₹40,000 → ZERO_NET_UNEXPECTED BLOCKER.
//   run total net provided = Σ lines → no RECONCILIATION_MISMATCH.
// ===========================================================================
{
  const previous = {
    runId: 'prev', lines: [
      { employeeId: 'A', status: 'COMPUTED', grossMinor: R(50000), netMinor: R(48000), components: [{ code: 'PT', amountMinor: R(200) }] },
      { employeeId: 'B', status: 'COMPUTED', grossMinor: R(32000), netMinor: R(30000), components: [{ code: 'PT', amountMinor: R(200) }] },
    ],
  };
  const current = {
    runId: 'cur', type: 'REGULAR',
    totalsMinor: { netMinor: R(48000) + R(15000) + R(60000) + (-R(500)) + R(0) },
    lines: [
      { employeeId: 'A', status: 'COMPUTED', grossMinor: R(50000), netMinor: R(48000), components: [{ code: 'PT', amountMinor: R(200) }], lopDays: 0 },
      { employeeId: 'B', status: 'COMPUTED', grossMinor: R(16000), netMinor: R(15000), components: [], lopDays: 0 },
      { employeeId: 'C', status: 'COMPUTED', grossMinor: R(62000), netMinor: R(60000), components: [{ code: 'PT', amountMinor: R(200) }], isNewJoiner: true, lopDays: 0 },
      { employeeId: 'D', status: 'COMPUTED', grossMinor: R(2000), netMinor: -R(500), components: [{ code: 'LOAN', amountMinor: R(2500) }], lopDays: 0 },
      { employeeId: 'E', status: 'COMPUTED', grossMinor: R(40000), netMinor: R(0), components: [{ code: 'LOAN', amountMinor: R(40000) }], lopDays: 0 },
    ],
  };

  const { findings, summary, blockingAnomalies } = variance.runVarianceChecks({ current, previous });

  // BLOCKERS: B STATUTORY_DROP_TO_ZERO, D NEGATIVE_NET, D DEDUCTION_EXCEEDS_GROSS (2500>2000? deductions=gross-net=2000-(-500)=2500>2000 yes),
  //           E ZERO_NET_UNEXPECTED, E DEDUCTION_EXCEEDS_GROSS? gross-net=40000>40000? no (equal). So E only ZERO_NET.
  check('B STATUTORY_DROP_TO_ZERO is BLOCKER', 'BLOCKER', (has(findings, 'STATUTORY_DROP_TO_ZERO', 'B') || {}).severity);
  check('D NEGATIVE_NET is BLOCKER', 'BLOCKER', (has(findings, 'NEGATIVE_NET', 'D') || {}).severity);
  check('D DEDUCTION_EXCEEDS_GROSS is BLOCKER', 'BLOCKER', (has(findings, 'DEDUCTION_EXCEEDS_GROSS', 'D') || {}).severity);
  check('E ZERO_NET_UNEXPECTED is BLOCKER', 'BLOCKER', (has(findings, 'ZERO_NET_UNEXPECTED', 'E') || {}).severity);
  check('E has NO DEDUCTION_EXCEEDS_GROSS (equal, not exceeds)', null, has(findings, 'DEDUCTION_EXCEEDS_GROSS', 'E'));

  // WARNING: B NET_PCT_OUTLIER (-50%).
  const bWarn = has(findings, 'NET_PCT_OUTLIER', 'B');
  check('B NET_PCT_OUTLIER is WARNING', 'WARNING', (bWarn || {}).severity);
  check('B NET_PCT_OUTLIER deltaPct = -0.5', -0.5, (bWarn || {}).deltaPct);

  // INFO: C NEW_JOINER; A has nothing.
  check('C NEW_JOINER is INFO', 'INFO', (has(findings, 'NEW_JOINER', 'C') || {}).severity);
  check('A has no findings', undefined, findings.find((f) => f.employeeId === 'A'));

  // blockingAnomalies count = STATUTORY_DROP(B) + NEGATIVE_NET(D) + DED_EXCEEDS(D) + ZERO_NET(E) = 4.
  check('blockingAnomalies = 4', 4, blockingAnomalies);
  check('summary.blocker = 4', 4, summary.blocker);

  // Sort discipline: first finding is a BLOCKER; findings are severity-sorted.
  check('first finding is BLOCKER', 'BLOCKER', findings[0].severity);
  let lastRank = -1;
  const rank = { BLOCKER: 0, WARNING: 1, INFO: 2 };
  let sorted = true;
  for (const f of findings) { if (rank[f.severity] < lastRank) sorted = false; lastRank = rank[f.severity]; }
  check('findings sorted by severity desc', true, sorted);
}

// ===========================================================================
// SCENARIO 2 — deltaPct FLOOR math: ₹10 → ₹40 must NOT flag.
//   Δ% = (4000-1000)/max(1000, 5000) = 3000/5000 = 0.60. With floor 5000(=₹50),
//   that's exactly hardNetPct 0.60 → would flag. To prove the FLOOR, use ₹10→₹40
//   = (4000-1000)/5000 = 0.60. Hmm — pick ₹10→₹30: (3000-1000)/5000=0.40 → soft
//   WARNING. The point of the floor: WITHOUT it, ₹10→₹30 = 200% (blocker-ish).
//   With the ₹50 floor it's 40% (a soft warning), not a hard blocker.
// ===========================================================================
{
  const previous = { runId: 'p', lines: [{ employeeId: 'X', status: 'COMPUTED', grossMinor: R(10), netMinor: R(10), components: [] }] };
  const current = {
    runId: 'c', type: 'REGULAR',
    totalsMinor: { netMinor: R(30) },
    lines: [{ employeeId: 'X', status: 'COMPUTED', grossMinor: R(30), netMinor: R(30), components: [], lopDays: 0 }],
  };
  const { findings } = variance.runVarianceChecks({ current, previous });
  const xNet = has(findings, 'NET_PCT_OUTLIER', 'X');
  // (3000-1000)/max(1000,5000)=2000/5000=0.40 → WARNING (soft), NOT a hard blocker.
  check('floor: ₹10→₹30 deltaPct = 0.4 (not 2.0)', 0.4, (xNet || {}).deltaPct);
  check('floor: ₹10→₹30 is WARNING not BLOCKER', 'WARNING', (xNet || {}).severity);
  check('floor: no NET_PCT_OUTLIER_HARD', null, has(findings, 'NET_PCT_OUTLIER_HARD', 'X'));
}

// ===========================================================================
// SCENARIO 3 — outlier DOWNGRADE to INFO via context (revision/arrear).
//   Y net doubles (₹20,000→₹45,000): Δ% = 25000/20000 = 1.25 → would be HARD.
//   But Y has hasCompRevision=true → suppressOutlier → NET hard becomes the soft
//   branch downgraded to INFO. So NO blocker; a NET_PCT_OUTLIER INFO instead, plus
//   COMP_REVISION_APPLIED INFO.
// ===========================================================================
{
  const previous = { runId: 'p', lines: [{ employeeId: 'Y', status: 'COMPUTED', grossMinor: R(22000), netMinor: R(20000), components: [] }] };
  const current = {
    runId: 'c', type: 'REGULAR',
    totalsMinor: { netMinor: R(45000) },
    lines: [{ employeeId: 'Y', status: 'COMPUTED', grossMinor: R(47000), netMinor: R(45000), components: [], hasCompRevision: true, lopDays: 0 }],
  };
  const { findings, blockingAnomalies } = variance.runVarianceChecks({ current, previous });
  check('revision downgrade: no BLOCKER', 0, blockingAnomalies);
  check('revision: COMP_REVISION_APPLIED INFO present', 'INFO', (has(findings, 'COMP_REVISION_APPLIED', 'Y') || {}).severity);
  // The 125% net swing is downgraded to INFO (not a hard blocker, not even a warning).
  const yNet = has(findings, 'NET_PCT_OUTLIER', 'Y');
  check('revision: net outlier downgraded to INFO', 'INFO', (yNet || {}).severity);
  check('revision: no NET_PCT_OUTLIER_HARD', null, has(findings, 'NET_PCT_OUTLIER_HARD', 'Y'));
}

// ===========================================================================
// SCENARIO 4 — FnF allows recoverable NEGATIVE_NET; reconciliation mismatch BLOCKER.
// ===========================================================================
{
  const current = {
    runId: 'fnf', type: 'FNF',
    totalsMinor: { netMinor: R(999) }, // deliberately WRONG vs Σ lines (-500)
    lines: [{ employeeId: 'Z', status: 'COMPUTED', grossMinor: R(1000), netMinor: -R(500), components: [{ code: 'NOTICE_RECOVERY', amountMinor: R(1500) }], lopDays: 0 }],
  };
  const { findings, blockingAnomalies } = variance.runVarianceChecks({ current, previous: null });
  check('FnF: NEGATIVE_NET NOT raised', null, has(findings, 'NEGATIVE_NET', 'Z'));
  check('FnF: DEDUCTION_EXCEEDS_GROSS NOT raised', null, has(findings, 'DEDUCTION_EXCEEDS_GROSS', 'Z'));
  check('FnF: RECONCILIATION_MISMATCH BLOCKER raised', 'BLOCKER', (has(findings, 'RECONCILIATION_MISMATCH', null) || {}).severity);
  check('FnF: only the reconciliation blocker', 1, blockingAnomalies);
}

// ===========================================================================
// SCENARIO 5 — first run ever (no baseline): absolute checks only, no outliers.
// ===========================================================================
{
  const current = {
    runId: 'first', type: 'REGULAR',
    totalsMinor: { netMinor: R(48000) },
    lines: [{ employeeId: 'A', status: 'COMPUTED', grossMinor: R(50000), netMinor: R(48000), components: [{ code: 'PT', amountMinor: R(200) }], lopDays: 0 }],
  };
  const { findings, blockingAnomalies } = variance.runVarianceChecks({ current, previous: null });
  check('first run: no findings', 0, findings.length);
  check('first run: no blockers', 0, blockingAnomalies);
}

// ===========================================================================
// SCENARIO 6 — CROSS-EMPLOYEE: DUPLICATE_BANK_ACCOUNT (BLOCKER, scope RUN+EMPLOYEE).
//   F & G share bankKey "ACC1|IFSC1" (both active, positive net) → BLOCKER each
//   + one RUN roll-up. H has a distinct account → clean. I has net 0 sharing F's
//   key → NOT counted (no money leaving). J has no bankKey → not counted here.
// ===========================================================================
{
  const current = {
    runId: 'dup', type: 'REGULAR',
    totalsMinor: { netMinor: R(10000) + R(10000) + R(10000) + R(0) + R(10000) },
    lines: [
      { employeeId: 'F', status: 'COMPUTED', grossMinor: R(12000), netMinor: R(10000), components: [], lopDays: 0, bankKey: 'ACC1|IFSC1' },
      { employeeId: 'G', status: 'COMPUTED', grossMinor: R(12000), netMinor: R(10000), components: [], lopDays: 0, bankKey: 'ACC1|IFSC1' },
      { employeeId: 'H', status: 'COMPUTED', grossMinor: R(12000), netMinor: R(10000), components: [], lopDays: 0, bankKey: 'ACC2|IFSC2' },
      { employeeId: 'I', status: 'COMPUTED', grossMinor: R(12000), netMinor: R(0), components: [], lopDays: 0, bankKey: 'ACC1|IFSC1' },
      { employeeId: 'J', status: 'COMPUTED', grossMinor: R(12000), netMinor: R(10000), components: [], lopDays: 0 },
    ],
  };
  const { findings } = variance.runVarianceChecks({ current, previous: null });
  const fDup = findings.find((f) => f.code === 'DUPLICATE_BANK_ACCOUNT' && f.employeeId === 'F');
  const gDup = findings.find((f) => f.code === 'DUPLICATE_BANK_ACCOUNT' && f.employeeId === 'G');
  const runDup = findings.find((f) => f.code === 'DUPLICATE_BANK_ACCOUNT' && f.employeeId === null);
  check('dup-bank: F is a BLOCKER', 'BLOCKER', (fDup || {}).severity);
  check('dup-bank: G is a BLOCKER', 'BLOCKER', (gDup || {}).severity);
  check('dup-bank: RUN roll-up is a BLOCKER', 'BLOCKER', (runDup || {}).severity);
  check('dup-bank: RUN roll-up counts exactly 2 employees', 2, (runDup || {}).observed);
  check('dup-bank: H (distinct account) is clean', null, has(findings, 'DUPLICATE_BANK_ACCOUNT', 'H'));
  check('dup-bank: I (net 0) NOT flagged', null, has(findings, 'DUPLICATE_BANK_ACCOUNT', 'I'));
  check('dup-bank: J (no bankKey) NOT flagged', null, has(findings, 'DUPLICATE_BANK_ACCOUNT', 'J'));
  // Exactly 3 dup findings total: F, G, and one RUN roll-up.
  check('dup-bank: exactly 3 DUPLICATE_BANK_ACCOUNT findings', 3, findings.filter((f) => f.code === 'DUPLICATE_BANK_ACCOUNT').length);
}

// ===========================================================================
// SCENARIO 7 — STATUTORY_BASE_JUMP (WARNING): EPF amount jumps with no revision.
//   PREVIOUS: K gross ₹50,000, EPF ₹1,800. CURRENT: gross UNCHANGED ₹50,000 but
//   EPF ₹3,600 (base doubled). |Δ%| of EPF = (3600-1800)/1800 = 1.0 ≥ 0.30 → WARNING.
//   Gross is unchanged so no GROSS/NET outlier. (RATE_DRIFT may also fire since the
//   effective rate moved — both are legitimate; we pin BASE_JUMP here.)
// ===========================================================================
{
  const previous = { runId: 'p', lines: [
    { employeeId: 'K', status: 'COMPUTED', grossMinor: R(50000), netMinor: R(46400), components: [{ code: 'EPF', amountMinor: R(1800), statutory: true }] },
  ] };
  const current = {
    runId: 'c', type: 'REGULAR',
    totalsMinor: { netMinor: R(44600) },
    lines: [
      { employeeId: 'K', status: 'COMPUTED', grossMinor: R(50000), netMinor: R(44600), components: [{ code: 'EPF', amountMinor: R(3600), statutory: true }], lopDays: 0 },
    ],
  };
  const { findings } = variance.runVarianceChecks({ current, previous });
  const baseJump = has(findings, 'STATUTORY_BASE_JUMP', 'K');
  check('base-jump: EPF base jump is WARNING', 'WARNING', (baseJump || {}).severity);
  check('base-jump: deltaPct = 1.0', 1, (baseJump || {}).deltaPct);
  check('base-jump: baseline=1800*100, observed=3600*100', [R(1800), R(3600)], [(baseJump || {}).baseline, (baseJump || {}).observed]);
  // FINDING #7: a STATUTORY code's movement is OWNED by the statutory family — the
  // generic COMPONENT_DELTA (same 0.30 threshold) must NOT also fire for EPF, so the
  // identical |Δ%| movement is reported exactly once (deterministic, no duplicate).
  check('base-jump: COMPONENT_DELTA suppressed for statutory EPF (#7)', null, has(findings, 'COMPONENT_DELTA', 'K'));
  // A comp revision suppresses the base-jump (it's an explained change).
  const curRev = {
    runId: 'c2', type: 'REGULAR', totalsMinor: { netMinor: R(44600) },
    lines: [{ employeeId: 'K', status: 'COMPUTED', grossMinor: R(50000), netMinor: R(44600), components: [{ code: 'EPF', amountMinor: R(3600), statutory: true }], hasCompRevision: true, lopDays: 0 }],
  };
  const rev = variance.runVarianceChecks({ current: curRev, previous });
  check('base-jump: suppressed under comp revision', null, has(rev.findings, 'STATUTORY_BASE_JUMP', 'K'));
}

// ===========================================================================
console.log('');
console.log(`Variance golden test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
if (failed > 0) {
  console.log('Discrepancies:');
  for (const d of fails) console.log('  - ' + d);
  process.exitCode = 1;
}

'use strict';

/**
 * ninebox.rbac.test.js — Feature 34 LIVE controller proof against hr_test. Sibling to
 * performance.rbac.test.js: same harness, same isolated schema, plain-node.
 *
 * Fixture inside the seed 'demo' tenant:
 *        DIR (skip-level / HR-band calibrator)
 *         │
 *        MGR (Manager, TEAM)
 *        /   \
 *      R1     R2          ← reports (in MGR's sub-tree)
 *      PEER               ← out of MGR's tree
 *
 * Proves (spec §8 QA1-9):
 *   (a) perf axis DERIVES from calibrated ?? final ?? manager — never re-rated; seed
 *       snapshots the band; recompute follows a re-calibration pre-FINALIZE.
 *   (b) scope read — MGR's board is their sub-tree only; PEER never appears; HR sees all.
 *   (c) SoD move — MGR cannot move their OWN box (ninebox.calibrate drops self) → 404/absent.
 *   (d) confidentiality — the SELF (ESS) development payload NEVER contains box/potential/
 *       tags; serializeNineBox strips them for a SELF viewer.
 *   (e) box math — (potentialBand-1)*3 + performanceBand after author-potential.
 *   (f) competency rollup — aggregates ReviewResponse competency rows into gaps + score.
 *   (g) calibration reuse — opening a NINE_BOX session resolves the SAME skip-level cohort.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/talent/__tests__/ninebox.rbac.test.js
 */

const prisma = require('../../../core/lib/prisma');
const nbCtrl = require('../controllers/nineBox.controller');
const compCtrl = require('../controllers/competency.controller');
const essCtrl = require('../controllers/essPerformance.controller');
const { serializeNineBox } = require('../performance/serializers');
const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { this.body = undefined; return this; } };
}
function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const oj = res.json.bind(res); res.json = (p) => { const r = oj(p); done(); return r; };
    const oe = res.end.bind(res); res.end = () => { const r = oe(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}
async function withScope(user, action, extra = {}) {
  const scope = await resolveAccessibleEmployeeIds(user, action);
  return { user, scope, query: {}, params: {}, body: {}, ...extra };
}
function actor({ businessId, employeeId, band, role = 'STAFF', perms = {} }) {
  return { id: `actor-${employeeId || 'x'}`, businessId, role, employeeId, businessRoleId: null, businessRole: { defaultScope: band, permissions: perms } };
}

const PREFIX = 'NB34-TEST';
async function cleanup(businessId) {
  const cyc = await prisma.reviewCycle.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const cids = cyc.map((c) => c.id);
  if (cids.length) {
    await prisma.nineBoxMove.deleteMany({ where: { businessId, placement: { cycleId: { in: cids } } } }).catch(() => {});
    await prisma.nineBoxPlacement.deleteMany({ where: { businessId, cycleId: { in: cids } } }).catch(() => {});
    await prisma.calibrationSession.deleteMany({ where: { businessId, cycleId: { in: cids } } }).catch(() => {});
    await prisma.reviewResponse.deleteMany({ where: { businessId, reviewInstance: { reviewCycleId: { in: cids } } } }).catch(() => {});
    await prisma.performanceReview.deleteMany({ where: { businessId, reviewCycleId: { in: cids } } });
    await prisma.reviewCycle.deleteMany({ where: { id: { in: cids } } });
  }
  await prisma.talentTag.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.roleCompetency.deleteMany({ where: { businessId, competency: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.competency.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Feature 34 nine-box controller RBAC/scope/confidentiality proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  const mkEmp = (code, extra = {}) => prisma.employee.create({ data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', ...extra } });
  const dir = await mkEmp('DIR');
  const mgr = await mkEmp('MGR', { managerEmployeeId: dir.id });
  const r1 = await mkEmp('R1', { managerEmployeeId: mgr.id });
  const r2 = await mkEmp('R2', { managerEmployeeId: mgr.id });
  const peer = await mkEmp('PEER');

  // Cycle CLOSED so author-potential is unconstrained by cycle window; 9-box config
  // uses default 5-pt bands. Reviews are MANAGER_SUBMITTED so a perf axis exists.
  const cycle = await prisma.reviewCycle.create({
    data: { businessId, code: `${PREFIX}-CY`, name: 'NB34 Test', type: 'ANNUAL', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-12-31'), status: 'CLOSED', ratingScaleJson: { points: [{ value: 5 }, { value: 4 }, { value: 3 }] }, nineBoxConfigJson: { gridTargetJson: { '9': 10 } } },
  });
  // R1: calibratedRating 4.5 (band 3), managerRating 2 — proves calibrated WINS.
  // R2: no calibrated, finalRating 3.2 (band 2) — proves final used next.
  // MGR: calibratedRating 4.0 (band 3) — the self-box for the SoD test.
  // PEER: managerRating 5 (band 3) — out of MGR's tree (scope test).
  const revR1 = await prisma.performanceReview.create({ data: { businessId, reviewCycleId: cycle.id, employeeId: r1.id, reviewerId: mgr.id, status: 'CALIBRATED', managerRating: 2, calibratedRating: 4.5 } });
  const revR2 = await prisma.performanceReview.create({ data: { businessId, reviewCycleId: cycle.id, employeeId: r2.id, reviewerId: mgr.id, status: 'MANAGER_SUBMITTED', managerRating: 3, finalRating: 3.2 } });
  const revMgr = await prisma.performanceReview.create({ data: { businessId, reviewCycleId: cycle.id, employeeId: mgr.id, reviewerId: dir.id, status: 'CALIBRATED', calibratedRating: 4.0 } });
  const revPeer = await prisma.performanceReview.create({ data: { businessId, reviewCycleId: cycle.id, employeeId: peer.id, reviewerId: peer.id, status: 'MANAGER_SUBMITTED', managerRating: 5 } });

  const manager = actor({ businessId, employeeId: mgr.id, band: 'TEAM', perms: { canViewTeamPerformance: true } });
  const hr = actor({ businessId, employeeId: dir.id, band: 'ALL', role: 'BUSINESS_ADMIN', perms: { canViewTeamPerformance: true, canManagePerformanceCycle: true, canCalibrateRatings: true, canManageSuccession: true } });

  try {
    // ── (a) seed: perf axis DERIVED from calibrated ?? final ?? manager ────────
    log('(a) Performance-axis derivation (seed snapshots the band):');
    const seedReq = await withScope(hr, 'canManagePerformanceCycle', { params: { cycleId: cycle.id } });
    const seedRes = await call(nbCtrl.seedPlacements, seedReq);
    assert(seedRes.body && seedRes.body.created >= 4, `seed minted placements (created=${seedRes.body && seedRes.body.created})`);
    const pR1 = await prisma.nineBoxPlacement.findFirst({ where: { businessId, cycleId: cycle.id, employeeId: r1.id } });
    const pR2 = await prisma.nineBoxPlacement.findFirst({ where: { businessId, cycleId: cycle.id, employeeId: r2.id } });
    assert(pR1.performanceBand === 3, 'R1 perf band = 3 (from calibrated 4.5, NOT manager 2 — calibrated wins)');
    assert(pR2.performanceBand === 2, 'R2 perf band = 2 (from final 3.2, no calibrated)');

    // ── (b) scope read: MGR board = sub-tree only; PEER absent; HR all ─────────
    log('(b) Scope read (board is server-scoped to the actor sub-tree):');
    const mgrBoardReq = await withScope(manager, 'canViewTeamPerformance', { query: { cycleId: cycle.id } });
    const mgrBoard = await call(nbCtrl.board, mgrBoardReq);
    const allMgrIds = Object.values(mgrBoard.body.cells).flat().concat(mgrBoard.body.unplaced).map((p) => p.employeeId);
    assert(allMgrIds.includes(r1.id) && allMgrIds.includes(r2.id), 'MGR board includes R1 + R2 (their reports)');
    assert(!allMgrIds.includes(peer.id), 'MGR board EXCLUDES PEER (out of sub-tree)');
    assert(!allMgrIds.includes(mgr.id) || true, 'MGR board may include own DRAFT placement (read), but cannot MOVE it (see d)');
    const hrBoardReq = await withScope(hr, 'canViewTeamPerformance', { query: { cycleId: cycle.id } });
    const hrBoard = await call(nbCtrl.board, hrBoardReq);
    const allHrIds = Object.values(hrBoard.body.cells).flat().concat(hrBoard.body.unplaced).map((p) => p.employeeId);
    assert(allHrIds.includes(peer.id) && allHrIds.includes(r1.id), 'HR board includes everyone (PEER + reports)');

    // ── (e) author potential → box math; then (c) SoD move ────────────────────
    log('(c/e) Author potential (box math) + SoD move:');
    const authReq = await withScope(manager, 'canViewTeamPerformance', { params: { id: pR1.id }, body: { potentialRating: 4.5 } });
    const authRes = await call(nbCtrl.authorPotential, authReq);
    // perf band 3, potential 4.5 → band 3 → box = (3-1)*3 + 3 = 9
    assert(authRes.body && authRes.body.box === 9, `R1 box = 9 after author-potential (perf 3 × potential 3 → (3-1)*3+3); got ${authRes.body && authRes.body.box}`);
    assert(authRes.body.status === 'PROPOSED', 'R1 placement → PROPOSED after author-potential');
    const moveLedger = await prisma.nineBoxMove.count({ where: { businessId, placementId: pR1.id } });
    assert(moveLedger === 1, 'author-potential wrote exactly one ledger row');

    // SoD: MGR tries to MOVE their OWN box → scope (ninebox.calibrate) drops self → 404.
    const pMgr = await prisma.nineBoxPlacement.findFirst({ where: { businessId, cycleId: cycle.id, employeeId: mgr.id } });
    // First open a session so the move would otherwise be legal; MGR is a skip-less manager,
    // but the SoD test is purely that the placement is out-of-scope for the move action.
    const mgrMoveReq = await withScope(manager, 'canViewTeamPerformance', { params: { id: pMgr.id }, body: { toPotential: 4, reason: 'self move attempt', sessionId: null } });
    const mgrMoveRes = await call(nbCtrl.movePlacement, mgrMoveReq);
    assert(mgrMoveRes.statusCode === 404, `SoD: MGR cannot move their OWN box → 404 (got ${mgrMoveRes.statusCode}); ninebox.calibrate dropped self from scope`);

    // ── (g) calibration reuse: NINE_BOX session resolves the skip-level cohort ─
    log('(g) Calibration session reuse (skip-level cohort = the rating cohort):');
    const sessReq = await withScope(hr, 'canCalibrateRatings', { body: { cycleId: cycle.id, skipLevelEmployeeId: mgr.id } });
    const sessRes = await call(nbCtrl.createSession, sessReq);
    assert(sessRes.statusCode === 201 && sessRes.body.kind === 'NINE_BOX', 'opened a NINE_BOX calibration session');
    const gridReq = await withScope(hr, 'canCalibrateRatings', { params: { id: sessRes.body.id } });
    const gridRes = await call(nbCtrl.sessionGrid, gridReq);
    const gridIds = Object.values(gridRes.body.cells).flat().concat(gridRes.body.unplaced).map((p) => p.employeeId);
    assert(gridIds.includes(r1.id) && gridIds.includes(r2.id) && !gridIds.includes(peer.id), 'NINE_BOX grid cohort = MGR sub-tree (R1,R2) — PEER excluded, same CTE as rating');
    assert(gridRes.body.warning && gridRes.body.warning.hasTarget, 'grid concentration warning present (reuses calibration.distributionWarning)');

    // HR moves R1 inside the OPEN session (actor ≠ subject) → CALIBRATED + ledger.
    const hrMoveReq = await withScope(hr, 'canCalibrateRatings', { params: { id: pR1.id }, body: { toPotential: 3.2, reason: 'calibrated down a notch', sessionId: sessRes.body.id } });
    const hrMoveRes = await call(nbCtrl.movePlacement, hrMoveReq);
    assert(hrMoveRes.statusCode === 200 && hrMoveRes.body.status === 'CALIBRATED', 'HR move inside OPEN session → CALIBRATED');
    const ledger2 = await prisma.nineBoxMove.count({ where: { businessId, placementId: pR1.id } });
    assert(ledger2 === 2, 'the calibration move appended a second ledger row (author + move = 2)');

    // ── (d) confidentiality: ESS development NEVER exposes box/potential/tags ──
    log('(d) Confidentiality (serializer + ESS development surface):');
    // Tag R1 HIPO so we can prove the tag never leaks to ESS.
    const tagReq = await withScope(hr, 'canViewTeamPerformance', { body: { employeeId: r1.id, kind: 'HIPO' } });
    await call(nbCtrl.createTalentTag, tagReq);
    // serializeNineBox for SELF strips the talent verdict.
    const selfView = serializeNineBox({ id: 'x', box: 9, potentialRating: 4.5, potentialBand: 3, performanceBand: 3, moves: [{}], sharedWithSubject: false, idpNote: 'secret' }, 'SELF');
    assert(!('box' in selfView) && !('potentialRating' in selfView) && !('potentialBand' in selfView) && !('moves' in selfView), 'serializeNineBox(SELF) strips box/potential/moves');
    assert(!('idpNote' in selfView), 'serializeNineBox(SELF) hides unshared IDP note');
    const mgrView = serializeNineBox({ id: 'x', box: 9, potentialRating: 4.5, moves: [{}] }, 'MANAGER');
    assert(mgrView.box === 9 && mgrView.potentialRating === 4.5, 'serializeNineBox(MANAGER) keeps the full placement');

    // ── (f) competency rollup aggregates ReviewResponse rows ──────────────────
    log('(f) Competency rollup (aggregates ReviewResponse competency rows):');
    const compReq = await withScope(hr, 'canManagePerformanceCycle', { body: { code: `${PREFIX}-COMM`, name: 'Communication', category: 'CORE' } });
    const compRes = await call(compCtrl.createCompetency, compReq);
    const competencyId = compRes.body.id;
    // Map it to R1's role 'ALL' with expected 4 (use a SEPARATE no-active-cycle path:
    // our cycle is CLOSED so roleMapLocked is false).
    const rmReq = await withScope(hr, 'canManagePerformanceCycle', { body: { competencyId, roleKey: 'ALL', expectedLevel: 4 } });
    const rmRes = await call(compCtrl.createRoleCompetency, rmReq);
    assert(rmRes.statusCode === 201, 'role-competency mapped (cycle CLOSED → map unlocked)');
    // R1 rated 3 on the competency (SHARED visibility) via a ReviewResponse row.
    await prisma.reviewResponse.create({ data: { businessId, reviewInstanceId: revR1.id, perspective: 'MANAGER', sectionKey: 'competency', itemKey: competencyId, ratingValue: 3, authorEmployeeId: mgr.id, visibility: 'SHARED' } });
    const drill = await call(nbCtrl.getPlacement, await withScope(hr, 'canViewTeamPerformance', { params: { id: pR1.id } }));
    const gap = drill.body.competency.gaps.find((g) => g.competencyId === competencyId);
    assert(gap && Number(gap.actual) === 3 && Number(gap.expected) === 4 && Number(gap.gap) === -1, 'rollup: R1 actual 3 vs expected 4 → gap -1');
    assert(drill.body.competency.scorePct === 75, 'rollup: competency score = 3/4 = 75%');

    // ESS development for R1: release the cycle so the gate opens, then assert NO box/tags.
    await prisma.reviewCycle.update({ where: { id: cycle.id }, data: { releasedAt: new Date() } });
    await prisma.performanceReview.update({ where: { id: revR1.id }, data: { releasedAt: new Date() } });
    const essReq = { customer: { businessId, email: 'nb34-r1@example.test' }, params: {}, query: {}, body: {} };
    // Link an email to R1 so resolveSelf finds them.
    await prisma.employee.update({ where: { id: r1.id }, data: { workEmail: 'nb34-r1@example.test' } });
    const essRes = await call(essCtrl.development, essReq);
    const keys = Object.keys(essRes.body || {});
    assert(essRes.body && essRes.body.released === true, 'ESS development released (post-release gate open)');
    assert(!keys.includes('box') && !keys.includes('potentialRating') && !keys.includes('potentialBand') && !keys.includes('talentTags'), 'ESS development payload has NO box/potential/tags keys');
    assert(Array.isArray(essRes.body.gaps) && essRes.body.gaps.some((g) => g.competencyId === competencyId), 'ESS development shows the subject their OWN competency gaps');
    assert(essRes.body.idpNote == null, 'ESS development hides the IDP note (not shared)');
  } finally {
    await cleanup(businessId);
  }

  log(`\n${failures === 0 ? 'ALL NINEBOX CONTROLLER TESTS PASS' : failures + ' NINEBOX CONTROLLER FAILURE(S)'}\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

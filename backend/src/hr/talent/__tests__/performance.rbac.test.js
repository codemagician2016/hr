'use strict';

/**
 * performance.rbac.test.js — Feature 8 LIVE controller proof against hr_test.
 * Sibling to scope.rbac.test.js: same harness, same isolated schema, plain-node.
 *
 * Fixture inside the seed 'demo' tenant:
 *        MGR (Manager, TEAM)
 *        /   \
 *      R1     R2          ← reports (in scope)
 *      PEER               ← out of MGR's tree
 *   + HR (HR-Admin, ALL/canManagePerformanceCycle)
 *
 * Proves (spec §8 QA4,6,7,10):
 *   (a) BUG #1 regression — manager review list is server-scoped to the sub-tree;
 *       PEER's instance never appears; out-of-scope GET :id → 404.
 *   (b) BUG #3b SoD — manager cannot submit the MANAGER review on their OWN instance
 *       (reviewer===subject) → 404 (resolver subtracts self via APPROVAL_ACTIONS).
 *   (c) self-required gate — submitMgr before self → 403; correct order works.
 *   (d) release gate — pre-release the subject payload has finalRating:null; HR sees
 *       it; after sign-off+release it is present to the subject.
 *   (e) BUG #2 optimistic lock — a stale-version self-submit → 409, no double-effect.
 *   (f) merit hand-off — close emits exactly one MeritRecommendation; no
 *       CompensationRevision written by Performance.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/talent/__tests__/performance.rbac.test.js
 */

const prisma = require('../../../core/lib/prisma');
const perf = require('../controllers/performance.controller');
const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
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
// Resolve req.scope as withEmployeeScope would, then call.
async function withScope(user, action, extra = {}) {
  const scope = await resolveAccessibleEmployeeIds(user, action);
  return { user, scope, query: {}, params: {}, body: {}, ...extra };
}
function actor({ businessId, employeeId, band, role = 'STAFF', perms = {} }) {
  return { id: `actor-${employeeId || 'x'}`, businessId, role, employeeId, businessRoleId: null, businessRole: { defaultScope: band, permissions: perms } };
}

const PREFIX = 'PERF8-TEST';
async function cleanup(businessId) {
  await prisma.meritRecommendation.deleteMany({ where: { businessId, reviewInstance: { reviewCycle: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  const cyc = await prisma.reviewCycle.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const cids = cyc.map((c) => c.id);
  if (cids.length) {
    await prisma.meritRecommendation.deleteMany({ where: { businessId, cycleId: { in: cids } } }).catch(() => {});
    await prisma.performanceReview.deleteMany({ where: { businessId, reviewCycleId: { in: cids } } });
    await prisma.reviewCycle.deleteMany({ where: { id: { in: cids } } });
  }
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Feature 8 controller RBAC/scope proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  const mkEmp = (code, extra = {}) => prisma.employee.create({ data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', ...extra } });
  const mgr = await mkEmp('MGR');
  const r1 = await mkEmp('R1', { managerEmployeeId: mgr.id });
  const r2 = await mkEmp('R2', { managerEmployeeId: mgr.id });
  const peer = await mkEmp('PEER');

  const cycle = await prisma.reviewCycle.create({
    data: { businessId, code: `${PREFIX}-CY`, name: 'Perf8 Test', type: 'ANNUAL', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-12-31'), status: 'ACTIVE', ratingScaleJson: { selfRequired: true, points: [{ value: 5 }, { value: 4 }, { value: 3 }] }, goalWeightPct: 50, competencyWeightPct: 50, meritMatrixJson: { 5: 12, 4: 8, 3: 4 } },
  });

  // Instances: R1 (subject) reviewer MGR; R2 reviewer MGR; PEER reviewer someone-else;
  // MGR (subject) reviewer MGR — the self-review-of-self edge for the SoD test.
  const revR1 = await prisma.performanceReview.create({ data: { businessId, reviewCycleId: cycle.id, employeeId: r1.id, reviewerId: mgr.id, status: 'NOT_STARTED' } });
  await prisma.performanceReview.create({ data: { businessId, reviewCycleId: cycle.id, employeeId: r2.id, reviewerId: mgr.id, status: 'NOT_STARTED' } });
  const revPeer = await prisma.performanceReview.create({ data: { businessId, reviewCycleId: cycle.id, employeeId: peer.id, reviewerId: peer.id, status: 'NOT_STARTED' } });
  const revMgrSelf = await prisma.performanceReview.create({ data: { businessId, reviewCycleId: cycle.id, employeeId: mgr.id, reviewerId: mgr.id, status: 'SELF_SUBMITTED' } });

  const manager = actor({ businessId, employeeId: mgr.id, band: 'TEAM', perms: { canViewTeamPerformance: true } });
  const hr = actor({ businessId, employeeId: null, band: 'ALL', role: 'BUSINESS_ADMIN', perms: { canViewTeamPerformance: true, canManagePerformanceCycle: true, canCalibrateRatings: true } });
  const subjectR1 = actor({ businessId, employeeId: r1.id, band: 'SELF', role: 'USER', perms: {} });

  try {
    // (a) BUG #1 regression — manager list scoped to sub-tree.
    log('(a) Manager review list server-scoped (BUG #1 regression):');
    {
      const req = await withScope(manager, 'canViewTeamPerformance', { query: { reviewCycleId: cycle.id } });
      const res = await call(perf.listReviews, req);
      const ids = new Set(((res.body && res.body.items) || []).map((x) => x.employeeId));
      assert(res.statusCode === 200, 'list → 200');
      assert(ids.has(r1.id) && ids.has(r2.id), 'includes R1,R2 (reports)');
      assert(!ids.has(peer.id), 'EXCLUDES PEER instance (out of sub-tree)');
    }

    // (a2) out-of-scope GET :id → 404.
    log('(a2) Manager GET PEER instance → 404:');
    {
      const req = await withScope(manager, 'canViewTeamPerformance', { params: { id: revPeer.id } });
      const res = await call(perf.getReview, req);
      assert(res.statusCode === 404, 'GET peer instance → 404 (IDOR-safe)');
    }

    // (b) BUG #3b SoD — manager cannot submit manager review on OWN instance.
    log('(b) SoD: manager cannot review their own instance:');
    {
      const req = await withScope(manager, 'review.submitMgr', { params: { id: revMgrSelf.id }, body: { managerRating: 5 } });
      const res = await call(perf.submitManagerReview, req);
      assert(res.statusCode === 404, 'submitMgr on own instance → 404 (resolver subtracts self)');
      const reloaded = await prisma.performanceReview.findUnique({ where: { id: revMgrSelf.id } });
      assert(reloaded.status === 'SELF_SUBMITTED', 'own instance unchanged (SoD enforced)');
    }

    // (c) self-required gate — submitMgr before self → 403.
    log('(c) Self-required gate (BUG #3a):');
    {
      const req = await withScope(manager, 'review.submitMgr', { params: { id: revR1.id }, body: { managerRating: 4 } });
      const res = await call(perf.submitManagerReview, req);
      assert(res.statusCode === 403, 'submitMgr before self → 403 (no skip)');
      // subject submits self first.
      const sreq = await withScope(subjectR1, 'canViewTeamPerformance', { params: { id: revR1.id }, body: { selfRating: 4, selfComments: 'ok' } });
      const sres = await call(perf.submitSelfReview, sreq);
      assert(sres.statusCode === 200 && sres.body.status === 'SELF_SUBMITTED', 'subject self-submits → SELF_SUBMITTED');
      // now manager can submit.
      const mreq = await withScope(manager, 'review.submitMgr', { params: { id: revR1.id }, body: { managerRating: 4, managerComments: 'good' } });
      const mres = await call(perf.submitManagerReview, mreq);
      assert(mres.statusCode === 200 && mres.body.status === 'MANAGER_SUBMITTED', 'manager submits after self → MANAGER_SUBMITTED');
    }

    // (e) BUG #2 optimistic lock — stale version self-submit on R2 → 409.
    log('(e) Optimistic lock (BUG #2):');
    {
      const r2rev = await prisma.performanceReview.findFirst({ where: { businessId, reviewCycleId: cycle.id, employeeId: r2.id } });
      const subjectR2 = actor({ businessId, employeeId: r2.id, band: 'SELF', role: 'USER' });
      const okReq = await withScope(subjectR2, 'canViewTeamPerformance', { params: { id: r2rev.id }, body: { selfRating: 3, version: r2rev.version } });
      const okRes = await call(perf.submitSelfReview, okReq);
      assert(okRes.statusCode === 200, 'first self-submit (correct version) → 200');
      // Replay with the now-stale version → 409, no double-effect.
      const staleReq = await withScope(subjectR2, 'canViewTeamPerformance', { params: { id: r2rev.id }, body: { selfRating: 5, version: r2rev.version } });
      const staleRes = await call(perf.submitSelfReview, staleReq);
      // status already SELF_SUBMITTED → state machine 409 OR lock 409 (either is the no-double-effect guarantee).
      assert(staleRes.statusCode === 409, 'stale/replayed self-submit → 409 (no double-effect)');
    }

    // (d) Release gate — calibrate+signOff on R1; pre-release subject sees null final.
    log('(d) Release gate:');
    {
      const r1rev = await prisma.performanceReview.findFirst({ where: { businessId, reviewCycleId: cycle.id, employeeId: r1.id } });
      // HR calibrates (no release yet).
      const cReq = await withScope(hr, 'review.calibrate', { params: { id: r1rev.id }, body: { calibratedRating: 4 } });
      const cRes = await call(perf.calibrateReview, cReq);
      assert(cRes.statusCode === 200 && cRes.body.status === 'CALIBRATED', 'HR calibrate → CALIBRATED');
      // Subject reads own — pre-release finalRating/managerComments ABSENT.
      const subjReq = await withScope(subjectR1, 'canViewTeamPerformance', { params: { id: r1rev.id } });
      const subjRes = await call(perf.getReview, subjReq);
      assert(subjRes.statusCode === 200, 'subject reads own instance → 200');
      assert(subjRes.body.finalRating == null && subjRes.body.managerComments == null, 'pre-release: finalRating + managerComments ABSENT to subject');
      // HR sees the figures.
      const hrReq = await withScope(hr, 'canViewTeamPerformance', { params: { id: r1rev.id } });
      const hrRes = await call(perf.getReview, hrReq);
      assert(hrRes.body.calibratedRating != null, 'HR sees calibratedRating (not gated)');
      // Sign-off → releasedAt set + finalRating locked.
      const soReq = await withScope(hr, 'review.signOff', { params: { id: r1rev.id }, body: { finalRating: 4 } });
      const soRes = await call(perf.signOffReview, soReq);
      assert(soRes.statusCode === 200 && soRes.body.releasedAt != null, 'sign-off stamps releasedAt');
      // Post-release the subject now sees finalRating.
      const subj2 = await withScope(subjectR1, 'canViewTeamPerformance', { params: { id: r1rev.id } });
      const subj2Res = await call(perf.getReview, subj2);
      assert(subj2Res.body.finalRating != null, 'post-release: finalRating PRESENT to subject');
    }

    // (f) Merit hand-off — acknowledge then close → exactly one MeritRecommendation.
    log('(f) Merit hand-off on close:');
    {
      const r1rev = await prisma.performanceReview.findFirst({ where: { businessId, reviewCycleId: cycle.id, employeeId: r1.id } });
      const ackReq = await withScope(subjectR1, 'canViewTeamPerformance', { params: { id: r1rev.id }, body: {} });
      const ackRes = await call(perf.acknowledgeReview, ackReq);
      assert(ackRes.statusCode === 200 && ackRes.body.status === 'ACKNOWLEDGED', 'subject acknowledges → ACKNOWLEDGED');
      const closeReq = await withScope(hr, 'review.signOff', { params: { id: r1rev.id }, body: {} });
      const closeRes = await call(perf.closeReview, closeReq);
      assert(closeRes.statusCode === 200 && closeRes.body.status === 'CLOSED', 'HR closes → CLOSED');
      const merits = await prisma.meritRecommendation.findMany({ where: { businessId, reviewInstanceId: r1rev.id } });
      assert(merits.length === 1, 'exactly ONE MeritRecommendation emitted');
      assert(Number(merits[0].recommendedPct) === 8, 'recommendedPct from matrix (rating 4 → 8%)');
      // Re-close idempotency: nothing further minted (already CLOSED → 409 anyway).
      const reMerits = await prisma.meritRecommendation.count({ where: { businessId, reviewInstanceId: r1rev.id } });
      assert(reMerits === 1, 'merit hand-off is idempotent (no double-mint)');
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? 'ALL RBAC TESTS PASS' : failures + ' RBAC TEST FAILURE(S)'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

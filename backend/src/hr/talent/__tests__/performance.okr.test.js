'use strict';

/**
 * performance.okr.test.js — Feature 8 LIVE OKR + cycle-launch proof (hr_test).
 * Covers (spec §8 QA2,12 + §5.6):
 *   - KR check-in → Objective.progress rollup (weighted mean) + parent cascade.
 *   - Weight invariant validate (Σ=100 ok; Σ≠100 → 422).
 *   - Alignment guard: align to a parent OUTSIDE the manager chain → 422.
 *   - Cycle launch: bulk-mint, auto-reviewer=manager, no_manager skip reported,
 *     idempotent re-launch (no double-mint).
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/talent/__tests__/performance.okr.test.js
 */

const prisma = require('../../../core/lib/prisma');
const okr = require('../controllers/okr.controller');
const perf = require('../controllers/performance.controller');
const ess = require('../controllers/essPerformance.controller');
const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
function near(a, b, eps = 0.05) { return Math.abs(Number(a) - Number(b)) <= eps; }

function fakeRes() { return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } }; }
function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes(); let settled = false;
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

const PREFIX = 'OKR8-TEST';
async function cleanup(businessId) {
  const objs = await prisma.objective.findMany({ where: { businessId, title: { startsWith: PREFIX } }, select: { id: true } });
  const oids = objs.map((o) => o.id);
  if (oids.length) {
    const krs = await prisma.keyResult.findMany({ where: { objectiveId: { in: oids } }, select: { id: true } });
    await prisma.goalCheckIn.deleteMany({ where: { keyResultId: { in: krs.map((k) => k.id) } } });
    await prisma.keyResult.deleteMany({ where: { objectiveId: { in: oids } } });
    await prisma.objectiveAlignment.deleteMany({ where: { OR: [{ childObjectiveId: { in: oids } }, { parentObjectiveId: { in: oids } }] } });
    await prisma.objective.deleteMany({ where: { id: { in: oids } } });
  }
  const cyc = await prisma.reviewCycle.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const cids = cyc.map((c) => c.id);
  if (cids.length) {
    await prisma.performanceReview.deleteMany({ where: { reviewCycleId: { in: cids } } });
    await prisma.reviewCycle.deleteMany({ where: { id: { in: cids } } });
  }
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Feature 8 OKR + launch proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found");
  const businessId = demo.id;
  await cleanup(businessId);

  const mkEmp = (code, extra = {}) => prisma.employee.create({ data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', isActive: true, ...extra } });
  const mgr = await mkEmp('MGR');
  const ic = await mkEmp('IC', { managerEmployeeId: mgr.id });
  const outsider = await mkEmp('OUT'); // owns an objective OUTSIDE ic's chain

  const hr = actor({ businessId, employeeId: null, band: 'ALL', role: 'BUSINESS_ADMIN', perms: { canViewTeamPerformance: true, canManagePerformanceCycle: true } });
  const manager = actor({ businessId, employeeId: mgr.id, band: 'TEAM', perms: { canViewTeamPerformance: true } });

  try {
    // ── (1) Objective + KRs + check-in rollup ─────────────────────────────────
    log('(1) KR check-in → objective rollup:');
    const objReq = await withScope(manager, 'canViewTeamPerformance', { body: { ownerEmployeeId: ic.id, level: 'INDIVIDUAL', title: `${PREFIX} Ship v1`, weight: 100, dueDate: '2026-12-31' } });
    const objRes = await call(okr.createObjective, objReq);
    assert(objRes.statusCode === 201, 'create objective (owner in scope) → 201');
    const objId = objRes.body.id;

    const kr1Req = await withScope(manager, 'canViewTeamPerformance', { params: { id: objId }, body: { title: 'KR-A', metricType: 'NUMERIC', startValue: 0, targetValue: 100, weight: 50, direction: 'INCREASE' } });
    const kr1Res = await call(okr.createKeyResult, kr1Req);
    const kr2Req = await withScope(manager, 'canViewTeamPerformance', { params: { id: objId }, body: { title: 'KR-B', metricType: 'NUMERIC', startValue: 0, targetValue: 100, weight: 50, direction: 'INCREASE' } });
    const kr2Res = await call(okr.createKeyResult, kr2Req);
    assert(kr1Res.statusCode === 201 && kr2Res.statusCode === 201, 'two KRs created (50/50)');

    // Check-in KR-A to 100 → objective progress = 50% (weighted mean of 100% and 0%).
    const ciReq = await withScope(manager, 'canViewTeamPerformance', { params: { id: kr1Res.body.id }, body: { newValue: 100, confidence: 'ON_TRACK' } });
    const ciRes = await call(okr.createCheckIn, ciReq);
    assert(ciRes.statusCode === 201, 'check-in created (append-only ledger)');
    const objAfter = await prisma.objective.findUnique({ where: { id: objId } });
    assert(near(objAfter.progress, 50), `objective progress rolled up to 50% (=${objAfter.progress})`);
    const ledger = await prisma.goalCheckIn.count({ where: { keyResultId: kr1Res.body.id } });
    assert(ledger === 1, 'exactly one ledger entry for the check-in');

    // ── (1b) FINDING 3 — operator check-in honors the optimistic lock ──────────
    // Two concurrent check-ins reading the same KR version: the lock must let ONE
    // commit and 409 the other (no silent lost update / clobber). Use KR-B (still
    // at base) so both read the same fresh version.
    log('(1b) Operator OKR check-in optimistic lock (finding 3):');
    {
      const krB = kr2Res.body.id;
      // Deterministic lost-update: the controller reads version N, then a CONCURRENT
      // writer commits (version→N+1) before the controller's guarded updateMany
      // runs. We simulate that exact interleave by stubbing the KR read to return a
      // snapshot pinned at the now-stale version, while the DB has already advanced.
      const before = await prisma.keyResult.findUnique({ where: { id: krB } });
      // A real concurrent check-in commits first (advances version + currentValue).
      const winReq = await withScope(manager, 'canViewTeamPerformance', { params: { id: krB }, body: { newValue: 40 } });
      const winRes = await call(okr.createCheckIn, winReq);
      assert(winRes.statusCode === 201, 'first (winning) check-in → 201');
      // Stub the handler's KR read to hand back the PRE-commit (stale) version.
      const realFindFirst = prisma.keyResult.findFirst.bind(prisma.keyResult);
      prisma.keyResult.findFirst = async (args) => {
        const fresh = await realFindFirst(args);
        return fresh ? { ...fresh, version: before.version } : fresh; // pin stale version
      };
      let staleRes;
      try {
        const staleReq = await withScope(manager, 'canViewTeamPerformance', { params: { id: krB }, body: { newValue: 90 } });
        staleRes = await call(okr.createCheckIn, staleReq);
      } finally {
        prisma.keyResult.findFirst = realFindFirst; // restore
      }
      assert(staleRes.statusCode === 409, `stale-version check-in → 409 (not a silent lost update) (got ${staleRes.statusCode})`);
      // currentValue stays the WINNER's (40), never clobbered to the stale write (90).
      const krAfter = await prisma.keyResult.findUnique({ where: { id: krB } });
      assert(Number(krAfter.currentValue) === 40, `KR currentValue = winning check-in (40), not clobbered to 90 (=${krAfter.currentValue})`);
      // The 409'd writer's ledger insert rolled back → only the winner's row exists.
      const krBLedger = await prisma.goalCheckIn.count({ where: { keyResultId: krB } });
      assert(krBLedger === 1, 'stale check-in rolled back its ledger row (no orphan / no lost update)');
    }

    // ── (1c) FINDING 2 — ESS goal check-in honors the optimistic lock ──────────
    // The ESS self-service check-in resolves the subject from the CUSTOMER session.
    // It previously wrote currentValue with NO version predicate (lost-update). Two
    // concurrent self check-ins on the same KR must now → one 201, one 409.
    log('(1c) ESS goal check-in optimistic lock (finding 2):');
    {
      // A DEDICATED self-service employee (own workEmail) so the extra objective
      // never becomes a weight-sum sibling of the (2) fixture owned by IC.
      const essEmail = `${PREFIX.toLowerCase()}-ess@example.test`;
      const essEmp = await mkEmp('ESS', { workEmail: essEmail, isActive: true });
      const essObj = await prisma.objective.create({ data: { businessId, ownerEmployeeId: essEmp.id, level: 'INDIVIDUAL', title: `${PREFIX} ESS goal`, weight: 100, dueDate: new Date('2026-12-31'), status: 'ACTIVE' } });
      const essKr = await prisma.keyResult.create({ data: { businessId, objectiveId: essObj.id, title: 'ESS-KR', metricType: 'NUMERIC', startValue: 0, targetValue: 100, currentValue: 0, weight: 100, direction: 'INCREASE', confidence: 'ON_TRACK', status: 'ACTIVE' } });
      const customer = { businessId, email: essEmail };
      const before = await prisma.keyResult.findUnique({ where: { id: essKr.id } });
      // Winner commits first (advances version + currentValue=30).
      const winRes = await call(ess.createCheckIn, { customer, params: { id: essKr.id }, body: { newValue: 30 } });
      assert(winRes.statusCode === 201, 'first (winning) ESS check-in → 201');
      // Stub the ESS handler's KR read to a PRE-commit (stale) version snapshot.
      const realFindFirst = prisma.keyResult.findFirst.bind(prisma.keyResult);
      prisma.keyResult.findFirst = async (args) => {
        const fresh = await realFindFirst(args);
        return fresh && fresh.id === essKr.id ? { ...fresh, version: before.version } : fresh;
      };
      let staleRes;
      try {
        staleRes = await call(ess.createCheckIn, { customer, params: { id: essKr.id }, body: { newValue: 80 } });
      } finally {
        prisma.keyResult.findFirst = realFindFirst;
      }
      assert(staleRes.statusCode === 409, `stale-version ESS check-in → 409 (no lost update) (got ${staleRes.statusCode})`);
      const krAfter = await prisma.keyResult.findUnique({ where: { id: essKr.id } });
      assert(Number(krAfter.currentValue) === 30, `ESS KR currentValue = winning check-in (30), not clobbered to 80 (=${krAfter.currentValue})`);
      const essLedger = await prisma.goalCheckIn.count({ where: { keyResultId: essKr.id } });
      assert(essLedger === 1, 'stale ESS check-in rolled back its ledger row (no lost update)');
    }

    // ── (2) Weight invariant validate ─────────────────────────────────────────
    log('(2) Weight Σ=100 invariant:');
    const vwReq = await withScope(manager, 'canViewTeamPerformance', { params: { id: objId } });
    const vwRes = await call(okr.validateObjectiveWeights, vwReq);
    assert(vwRes.statusCode === 200 && vwRes.body.krOk, 'KR Σ=100 validates 200');
    // Break it: add a third KR of weight 20 → KR Σ=120 → 422.
    const kr3Req = await withScope(manager, 'canViewTeamPerformance', { params: { id: objId }, body: { title: 'KR-C', metricType: 'NUMERIC', startValue: 0, targetValue: 100, weight: 20 } });
    await call(okr.createKeyResult, kr3Req);
    const vw2 = await call(okr.validateObjectiveWeights, await withScope(manager, 'canViewTeamPerformance', { params: { id: objId } }));
    assert(vw2.statusCode === 422 && !vw2.body.krOk, 'KR Σ=120 → 422 invariant violation');

    // ── (3) Alignment guard ───────────────────────────────────────────────────
    log('(3) Alignment guard (manager-chain only):');
    // Outsider owns a parent objective NOT in ic's manager chain.
    const outObj = await prisma.objective.create({ data: { businessId, ownerEmployeeId: outsider.id, level: 'ORG', title: `${PREFIX} Outsider`, weight: 100, dueDate: new Date('2026-12-31'), status: 'ACTIVE' } });
    // IC (acting as themselves) tries to align a new objective to the outsider's → 422.
    const icActor = actor({ businessId, employeeId: ic.id, band: 'SELF', role: 'USER', perms: {} });
    const badAlign = await withScope(icActor, 'canViewTeamPerformance', { body: { ownerEmployeeId: ic.id, level: 'INDIVIDUAL', title: `${PREFIX} Aligned`, weight: 100, dueDate: '2026-12-31', parentObjectiveId: outObj.id } });
    // give IC self-scope so owner check passes
    badAlign.scope = await resolveAccessibleEmployeeIds(icActor, 'canViewTeamPerformance');
    const badRes = await call(okr.createObjective, badAlign);
    assert(badRes.statusCode === 422, 'align to out-of-manager-chain parent → 422');

    // Manager owns a parent → IC may align to it (manager is in IC's chain).
    const mgrParent = await prisma.objective.create({ data: { businessId, ownerEmployeeId: mgr.id, level: 'TEAM', title: `${PREFIX} Team Goal`, weight: 100, dueDate: new Date('2026-12-31'), status: 'ACTIVE' } });
    const okAlign = await withScope(icActor, 'canViewTeamPerformance', { body: { ownerEmployeeId: ic.id, level: 'INDIVIDUAL', title: `${PREFIX} Aligned2`, weight: 100, dueDate: '2026-12-31', parentObjectiveId: mgrParent.id } });
    const okRes = await call(okr.createObjective, okAlign);
    assert(okRes.statusCode === 201, 'align to manager-chain parent → 201');

    // ── (4) Cycle launch — bulk-mint + skip + idempotency ─────────────────────
    log('(4) Cycle launch:');
    const cycle = await prisma.reviewCycle.create({ data: { businessId, code: `${PREFIX}-CY`, name: 'OKR Launch', type: 'ANNUAL', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-12-31'), status: 'ACTIVE', ratingScaleJson: { selfRequired: true } } });
    const launchReq = await withScope(hr, 'canViewTeamPerformance', { params: { id: cycle.id }, body: {} });
    const launchRes = await call(perf.launchCycle, launchReq);
    assert(launchRes.statusCode === 200, 'launch → 200');
    // IC has a manager (MGR) → minted; MGR + OUT have no manager → skipped no_manager.
    const minted = await prisma.performanceReview.findMany({ where: { businessId, reviewCycleId: cycle.id }, select: { employeeId: true, reviewerId: true } });
    const mintedIds = new Set(minted.map((m) => m.employeeId));
    assert(mintedIds.has(ic.id), 'IC (has manager) minted');
    const icInstance = minted.find((m) => m.employeeId === ic.id);
    assert(icInstance.reviewerId === mgr.id, 'IC reviewer auto-assigned = manager');
    const skips = (launchRes.body.skipped || []).filter((s) => s.reason === 'no_manager').map((s) => s.employeeId);
    assert(skips.includes(mgr.id) && skips.includes(outsider.id), 'MGR + OUT reported as no_manager skips');
    // Re-launch → idempotent (no double-mint).
    const beforeCount = minted.length;
    const relaunchRes = await call(perf.launchCycle, await withScope(hr, 'canViewTeamPerformance', { params: { id: cycle.id }, body: {} }));
    const afterCount = await prisma.performanceReview.count({ where: { businessId, reviewCycleId: cycle.id } });
    assert(afterCount === beforeCount && relaunchRes.body.created === 0, 'idempotent re-launch: created=0, no double-mint');
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? 'ALL OKR TESTS PASS' : failures + ' OKR TEST FAILURE(S)'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

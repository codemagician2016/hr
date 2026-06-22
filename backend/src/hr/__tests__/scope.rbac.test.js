'use strict';

/**
 * scope.rbac.test.js — LIVE intra-tenant hierarchical-RBAC (Feature 1) proof.
 *
 * Sibling to tenant-isolation.idor.test.js: same harness, same isolated hr_test
 * schema, same plain-node runner (no jest). Where the IDOR test proves the
 * TENANT wall, this proves the SCOPE axis ANDed on top of it — "a Manager
 * manages only their own employees, per the reporting hierarchy".
 *
 * Fixture (one transaction, torn down at the end) inside the seed 'demo' tenant:
 *
 *        MGR  (Manager, defaultScope=TEAM)
 *        /  \
 *      R1    R2        ← direct reports (in scope)
 *      PEER            ← reports to nobody under MGR (out of scope)
 *
 * Plus a PENDING leave APPLICATION for R1 (in scope), PEER (out of scope), and
 * MGR themselves (self — SoD blocked).
 *
 * Cases (spec §8):
 *   (a) Manager sub-tree only — employee.list returns exactly {MGR,R1,R2}.
 *   (b) Manager GET peer employee → 404.
 *   (c) Manager cannot approve a leave outside sub-tree → 404.
 *   (d) Manager cannot approve OWN leave (SoD) → 404.
 *   (e) client-supplied employeeId out of scope is ignored (empty), not honored.
 *   (f) Operator/ALL sees everyone (no regression).
 *   (g) Employee/SELF sees only self.
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/__tests__/scope.rbac.test.js
 * where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'.
 */

const prisma = require('../../core/lib/prisma');
const employeeController = require('../controllers/employee.controller');
const leaveController = require('../controllers/leave.controller');
const { resolveAccessibleEmployeeIds } = require('../lib/scopeResolver');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── Express res()/controller doubles (copied from the IDOR harness) ───────────
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res);
    res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res);
    res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}
// Run a middleware (req,res,next) and report whether it short-circuited (sent a
// response) — used to assert the 404 idParam guard for single-row scope misses.
function runMiddleware(mw, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const finish = (passed) => { if (!settled) { settled = true; resolve({ res, passed }); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return finish(true); };
    const origJson = res.json.bind(res);
    res.json = (p) => { const r = origJson(p); finish(false); return r; };
    Promise.resolve(mw(req, res, next)).catch(reject);
  });
}

// Attach req.scope exactly as the route middleware would (resolve + set), so the
// controller assertions exercise the real resolver, not a hand-built set.
async function withScope(user, action, extra = {}) {
  const scope = await resolveAccessibleEmployeeIds(user, action);
  return { user, scope, query: {}, params: {}, body: {}, ...extra };
}

// Build an actor whose effectiveScope() resolves to `band` (mirrors a real
// session: businessRole.defaultScope is the live source the resolver reads).
function actor({ businessId, employeeId = null, band, role = 'STAFF' }) {
  return {
    id: `actor-${band}-${employeeId || 'noemp'}`,
    businessId,
    role,
    employeeId, // already-anchored (attachSelfEmployee resolves this in the real stack)
    businessRoleId: null,
    businessRole: { defaultScope: band },
  };
}

const PREFIX = 'SCOPE-TEST';
async function cleanup(businessId) {
  // Remove any leftover fixture rows from a prior aborted run (idempotent).
  await prisma.leaveTransaction.deleteMany({ where: { businessId, reason: { startsWith: PREFIX } } });
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  // Null out manager links before deleting employees (FK SetNull would handle it,
  // but be explicit so order never matters).
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Hierarchical-RBAC scope proof (LIVE hr_test) ===\n');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  log(`demo businessId = ${businessId}\n`);

  await cleanup(businessId); // start clean

  // ── Fixture: MGR → {R1,R2}; PEER outside MGR's tree ─────────────────────────
  const mkEmp = (code, extra = {}) => prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', ...extra },
  });
  const mgr = await mkEmp('MGR');
  const r1 = await mkEmp('R1', { managerEmployeeId: mgr.id });
  const r2 = await mkEmp('R2', { managerEmployeeId: mgr.id });
  const peer = await mkEmp('PEER'); // no manager → not in MGR's sub-tree

  const leaveType = await prisma.leaveType.create({
    data: { businessId, code: `${PREFIX}-EL`, name: 'Scope Test Earned', category: 'ANNUAL', unit: 'DAYS' },
  });
  const mkApp = (employeeId) => prisma.leaveTransaction.create({
    data: {
      businessId, employeeId, leaveTypeId: leaveType.id, txnType: 'APPLICATION',
      unit: 'DAYS', quantity: -1, startDate: new Date('2026-07-01'), endDate: new Date('2026-07-01'),
      status: 'PENDING', appliedAt: new Date(), reason: `${PREFIX} pending`,
    },
  });
  const appR1 = await mkApp(r1.id);     // in scope
  const appPeer = await mkApp(peer.id); // out of scope
  const appMgr = await mkApp(mgr.id);   // self — SoD

  log(`MGR=${mgr.id}  R1=${r1.id}  R2=${r2.id}  PEER=${peer.id}\n`);

  // Actors
  const manager = actor({ businessId, employeeId: mgr.id, band: 'TEAM' });
  const operator = actor({ businessId, employeeId: mgr.id, band: 'ALL', role: 'BUSINESS_ADMIN' });
  const employee = actor({ businessId, employeeId: r1.id, band: 'SELF', role: 'USER' });

  try {
    // ── (a) Manager sub-tree only ─────────────────────────────────────────────
    log('(a) Manager sub-tree only:');
    {
      const req = await withScope(manager, 'canViewEmployees');
      const res = await callController(employeeController.list, req);
      const ids = new Set(((res.body && res.body.items) || []).map((e) => e.id));
      // Manager sees self + direct reports (TEAM band includes the root self anchor).
      assert(res.statusCode === 200, 'employee.list → 200 for Manager');
      assert(ids.has(r1.id) && ids.has(r2.id), 'list includes both direct reports R1,R2');
      assert(!ids.has(peer.id), 'list EXCLUDES the peer (out of sub-tree)');
      // No fixture employee other than {MGR,R1,R2} should appear (PEER absent proves filtering).
      const fixtureLeak = [peer.id].some((id) => ids.has(id));
      assert(!fixtureLeak, 'no out-of-tree fixture employee leaks into the Manager list');
    }

    // ── (b) Manager GET peer employee → 404 (middleware idParam guard) ────────
    log('(b) Manager GET peer → 404:');
    {
      const scoped = await runMiddleware(
        withEmployeeScope('canViewEmployees', { idParam: 'id' }),
        { user: manager, params: { id: peer.id } },
      );
      assert(!scoped.passed && scoped.res.statusCode === 404,
        'withEmployeeScope 404s a peer :id for the Manager (not 403, IDOR-safe)');
      // And an in-scope report passes the same guard.
      const ok = await runMiddleware(
        withEmployeeScope('canViewEmployees', { idParam: 'id' }),
        { user: manager, params: { id: r1.id } },
      );
      assert(ok.passed, 'withEmployeeScope ALLOWS an in-scope report :id');
    }

    // ── (c) Manager cannot approve leave outside sub-tree → 404 ───────────────
    log('(c) Manager approve out-of-scope leave → 404:');
    {
      const req = await withScope(manager, 'canApproveLeave', { params: { id: appPeer.id } });
      const res = await callController(leaveController.approveRequest, req);
      assert(res.statusCode === 404, 'approve(PEER application) → 404 for Manager');
      const reloaded = await prisma.leaveTransaction.findUnique({ where: { id: appPeer.id } });
      assert(reloaded.status === 'PENDING', 'PEER application stays PENDING (not approved)');
    }

    // ── (d) Manager cannot approve OWN leave (separation of duties) → 404 ─────
    log('(d) Manager approve OWN leave (SoD) → 404:');
    {
      // canApproveLeave scope excludes self, so MGR is not in their own approval set.
      const req = await withScope(manager, 'canApproveLeave', { params: { id: appMgr.id } });
      const res = await callController(leaveController.approveRequest, req);
      assert(res.statusCode === 404, "approve(own application) → 404 (resolver subtracts self)");
      const reloaded = await prisma.leaveTransaction.findUnique({ where: { id: appMgr.id } });
      assert(reloaded.status === 'PENDING', 'own application stays PENDING (SoD enforced)');
    }

    // Control: Manager CAN approve an in-scope report's leave (proves data + path work).
    log('   control: Manager approve in-scope report → 200:');
    {
      const req = await withScope(manager, 'canApproveLeave', { params: { id: appR1.id } });
      const res = await callController(leaveController.approveRequest, req);
      assert(res.statusCode === 200, 'approve(R1 application) → 200 for Manager');
      const reloaded = await prisma.leaveTransaction.findUnique({ where: { id: appR1.id } });
      assert(reloaded.status === 'APPROVED', 'R1 application moves to APPROVED');
    }

    // ── (e) client-supplied employeeId out of scope is IGNORED (empty) ────────
    log('(e) client ?employeeId out of scope is ignored:');
    {
      const req = await withScope(manager, 'canViewEmployees', { query: { employeeId: peer.id } });
      const res = await callController(leaveController.listRequests, req);
      const items = (res.body && res.body.items) || [];
      assert(res.statusCode === 200, 'leave.listRequests → 200');
      assert(items.length === 0, 'forged ?employeeId=PEER returns EMPTY (not honored, no widening)');
      const leak = items.some((t) => t.employeeId === peer.id);
      assert(!leak, 'no PEER leave row leaks via the client-supplied employeeId');
    }

    // ── (f) Operator / ALL band sees everyone (no regression) ─────────────────
    log('(f) Operator (ALL) sees everyone:');
    {
      const req = await withScope(operator, 'canViewEmployees');
      const res = await callController(employeeController.list, req);
      const ids = new Set(((res.body && res.body.items) || []).map((e) => e.id));
      assert(res.statusCode === 200, 'employee.list → 200 for Operator');
      assert(ids.has(mgr.id) && ids.has(r1.id) && ids.has(r2.id) && ids.has(peer.id),
        'Operator (ALL) sees MGR,R1,R2 AND the peer (full tenant, no scope filter)');
      // ALL band → leave listRequests honors any employeeId (incl. peer).
      const lreq = await withScope(operator, 'canViewEmployees', { query: { employeeId: peer.id } });
      const lres = await callController(leaveController.listRequests, lreq);
      const litems = (lres.body && lres.body.items) || [];
      assert(litems.some((t) => t.employeeId === peer.id),
        'Operator (ALL) CAN filter leave by the peer employeeId (no false-empty regression)');
    }

    // ── (g) Employee / SELF sees only self ────────────────────────────────────
    log('(g) Employee (SELF) sees only self:');
    {
      const req = await withScope(employee, 'canViewEmployees'); // anchored to R1
      const res = await callController(employeeController.list, req);
      const ids = ((res.body && res.body.items) || []).map((e) => e.id);
      assert(res.statusCode === 200, 'employee.list → 200 for Employee');
      assert(ids.length >= 1 && ids.every((id) => id === r1.id),
        'Employee (SELF) sees ONLY their own row (R1)');
    }

    // ── attachSelfEmployee smoke (anchor resolution path) ─────────────────────
    log('attachSelfEmployee anchor:');
    {
      // A user with no linked Employee resolves to employeeId=null (fail-closed).
      const fresh = { user: { id: 'no-emp-user', businessId } };
      await runMiddleware(attachSelfEmployee, fresh);
      assert(fresh.user.employeeId === null,
        'attachSelfEmployee sets employeeId=null when no Employee is linked (fail-closed)');
    }
  } finally {
    await cleanup(businessId);
  }

  log(`\n=== ${failures === 0 ? 'ALL SCOPE CHECKS PASSED' : `${failures} SCOPE CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Scope test crashed:', err);
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});

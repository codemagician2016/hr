'use strict';

/**
 * leave.engine.test.js — Feature 10 slice 10c PROOF that LEAVE now routes through the
 * approval-workflow engine with behaviour-identical zero-config outcomes.
 *
 * Same plain-node + LIVE hr_test harness as the existing leave suites. Drives the REAL
 * leave.controller (createRequest → approveRequest / rejectRequest) and asserts:
 *
 *   (1) createRequest opens a PENDING ApprovalRequest (module LEAVE) routed to the
 *       BUILT_IN_DEFAULT chain's approver (the requester's manager), with the soft-hold
 *       placed — exactly today's routing, now via the engine.
 *   (2) approveRequest drives engine.recordDecision → the LEAVE consumer's onApprove
 *       fires → the ledger moves IDENTICALLY to the pre-10c direct path (hold→taken,
 *       closing−), and the ApprovalRequest reaches APPROVED. (open → decide → ledger
 *       move == old outcome.)
 *   (3) SoD: a requester cannot self-approve — still 404 (controller blockSelfDecision,
 *       fail-closed before the engine).
 *   (4) reject releases the hold; no units consumed; ApprovalRequest REJECTED.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/leave.engine.test.js
 */

const prisma = require('../../../core/lib/prisma');
const leaveController = require('../../controllers/leave.controller');
require('../registerConsumers'); // ensure LEAVE/EXPENSE consumers are wired
const ledger = require('../../leave/ledger');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
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

const PREFIX = 'LEAVEENG-TEST';
const ALL_SCOPE = { kind: 'ALL' };

async function cleanup(businessId) {
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { entityType: 'LeaveTransaction', module: 'LEAVE', requester: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  await prisma.approvalRequest.deleteMany({ where: { businessId, module: 'LEAVE', requester: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.leaveTransaction.deleteMany({ where: { businessId, leaveType: { code: { startsWith: PREFIX } } } });
  await prisma.leaveBalance.deleteMany({ where: { businessId, leaveType: { code: { startsWith: PREFIX } } } });
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } });
}

let seq = 0;
async function mkUserEmp(businessId, name, managerEmployeeId = null) {
  seq += 1;
  const user = await prisma.user.create({
    data: { businessId, email: `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`, password: 'x', name, role: 'USER', isActive: true },
  });
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status: 'ACTIVE', userId: user.id, managerEmployeeId, hireDate: new Date('2020-01-01') },
  });
  return { user, emp };
}

async function openApprovalRequestFor(businessId, txnId) {
  return prisma.approvalRequest.findFirst({ where: { businessId, module: 'LEAVE', entityType: 'LeaveTransaction', entityId: txnId } });
}

async function main() {
  log('\n=== Leave-through-the-engine proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    // Org: mgr → ic. ic requests leave; the BUILT_IN_DEFAULT LEAVE chain routes to ic's
    // reporting manager (REPORTING_MANAGER refId "1") — exactly today's routing.
    const mgr = await mkUserEmp(businessId, 'Mgr');
    const ic = await mkUserEmp(businessId, 'Ic', mgr.emp.id);

    const lt = await prisma.leaveType.create({
      data: { businessId, code: `${PREFIX}-EL`, name: 'Eng Earned', category: 'ANNUAL', unit: 'DAYS' },
    });
    const bal = await prisma.leaveBalance.create({
      data: { businessId, employeeId: ic.emp.id, leaveTypeId: lt.id, periodCode: '2026-27', unit: 'DAYS', opening: '10', closing: '10' },
    });
    await prisma.leaveTransaction.create({
      data: { businessId, employeeId: ic.emp.id, leaveTypeId: lt.id, leaveBalanceId: bal.id, txnType: 'OPENING_BALANCE', unit: 'DAYS', quantity: 10, status: 'APPROVED', reason: `${PREFIX} opening` },
    });

    // The applying user is the IC; the approving operator acts via the route (already
    // RBAC+scope gated). employeeId on the actor proves the SoD self-block path.
    const icActor = { id: ic.user.id, businessId, employeeId: ic.emp.id };
    const mgrActor = { id: mgr.user.id, businessId, employeeId: mgr.emp.id };

    // ── (1) apply → opens a PENDING engine request routed to the manager + soft-hold ──
    log('(1) apply opens a PENDING engine request routed to the manager:');
    let txnId;
    {
      const req = { user: icActor, body: { employeeId: ic.emp.id, leaveTypeId: lt.id, startDate: '2026-06-09', endDate: '2026-06-09' } };
      const res = await callController(leaveController.createRequest, req);
      assert(res.statusCode === 201, `apply → 201 (got ${res.statusCode}: ${JSON.stringify(res.body && res.body.message)})`);
      txnId = res.body.id;
      const freshBal = await prisma.leaveBalance.findUnique({ where: { id: bal.id } });
      assert(Number(freshBal.pendingApproval) === 1, `soft-hold = 1 (got ${Number(freshBal.pendingApproval)})`);

      const ar = await openApprovalRequestFor(businessId, txnId);
      assert(ar && ar.status === 'PENDING', `engine ApprovalRequest opened PENDING (got ${ar && ar.status})`);
      assert(ar && ar.module === 'LEAVE' && ar.entityType === 'LeaveTransaction' && ar.entityId === txnId, 'request bound to the LeaveTransaction');
      const active = ar && ar.payloadJson && ar.payloadJson._active;
      assert(active && active.approverUserIds.includes(mgr.user.id), `BUILT_IN_DEFAULT routes to the reporting manager (active=${JSON.stringify(active && active.approverUserIds)})`);
    }

    // ── (2) SoD: the requester cannot self-approve → 404 (fail-closed before engine) ──
    log('(2) SoD self-approve blocked → 404:');
    {
      const req = { user: icActor, scope: ALL_SCOPE, params: { id: txnId } };
      const res = await callController(leaveController.approveRequest, req);
      assert(res.statusCode === 404, `self-approve → 404 (got ${res.statusCode})`);
      const reloaded = await prisma.leaveTransaction.findUnique({ where: { id: txnId } });
      assert(reloaded.status === 'PENDING', 'application stays PENDING after blocked self-approve');
    }

    // ── (3) manager approves via the engine → ledger moves == old outcome ──
    log('(3) manager approves through the engine → ledger moves identically:');
    {
      const req = { user: mgrActor, scope: ALL_SCOPE, params: { id: txnId } };
      const res = await callController(leaveController.approveRequest, req);
      assert(res.statusCode === 200, `approve → 200 (got ${res.statusCode}: ${JSON.stringify(res.body && res.body.message)})`);
      assert(res.body && res.body.status === 'APPROVED', `application APPROVED (got ${res.body && res.body.status})`);

      const freshBal = await prisma.leaveBalance.findUnique({ where: { id: bal.id } });
      assert(Number(freshBal.taken) === 1, `taken = 1 (got ${Number(freshBal.taken)})`);
      assert(Number(freshBal.closing) === 9, `closing = 9 (got ${Number(freshBal.closing)})`);
      assert(Number(freshBal.pendingApproval) === 0, `hold released (got ${Number(freshBal.pendingApproval)})`);

      // ledger reconciles (same invariant the pre-10c leave.flow test asserts)
      const txns = await prisma.leaveTransaction.findMany({ where: { businessId, leaveBalanceId: bal.id } });
      assert(ledger.reconciles({ closing: Number(freshBal.closing) }, txns), `ledger reconciles (closing ${Number(freshBal.closing)} == reconstruction ${ledger.reconstructClosing(txns)})`);

      const ar = await openApprovalRequestFor(businessId, txnId);
      assert(ar && ar.status === 'APPROVED', `engine ApprovalRequest reached APPROVED (got ${ar && ar.status})`);
      const action = await prisma.approvalAction.findFirst({ where: { businessId, approvalRequestId: ar.id, decision: 'APPROVED', approverUserId: mgr.user.id } });
      assert(!!action, 'an APPROVED ApprovalAction is recorded for the manager (audit trail)');
    }

    // ── (4) reject path: hold released, no units consumed, request REJECTED ──
    log('(4) reject releases the hold; no units consumed:');
    {
      // A fresh application by the IC.
      const ar0 = await prisma.leaveBalance.findUnique({ where: { id: bal.id } });
      const before = { taken: Number(ar0.taken), closing: Number(ar0.closing) };
      const apply = await callController(leaveController.createRequest, { user: icActor, body: { employeeId: ic.emp.id, leaveTypeId: lt.id, startDate: '2026-06-10', endDate: '2026-06-10' } });
      assert(apply.statusCode === 201, `apply#2 → 201 (got ${apply.statusCode})`);
      const txn2 = apply.body.id;
      const held = await prisma.leaveBalance.findUnique({ where: { id: bal.id } });
      assert(Number(held.pendingApproval) === 1, `hold placed for reject test (got ${Number(held.pendingApproval)})`);

      const res = await callController(leaveController.rejectRequest, { user: mgrActor, scope: ALL_SCOPE, params: { id: txn2 }, body: { reason: 'not now' } });
      assert(res.statusCode === 200 && res.body.status === 'REJECTED', `reject → 200 REJECTED (got ${res.statusCode}/${res.body && res.body.status})`);
      const after = await prisma.leaveBalance.findUnique({ where: { id: bal.id } });
      assert(Number(after.pendingApproval) === 0, `hold released on reject (got ${Number(after.pendingApproval)})`);
      assert(Number(after.taken) === before.taken && Number(after.closing) === before.closing, `no units consumed on reject (taken ${Number(after.taken)}, closing ${Number(after.closing)})`);
      const ar = await openApprovalRequestFor(businessId, txn2);
      assert(ar && ar.status === 'REJECTED', `engine ApprovalRequest REJECTED (got ${ar && ar.status})`);
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL LEAVE-ENGINE CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

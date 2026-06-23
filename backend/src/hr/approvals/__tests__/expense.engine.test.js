'use strict';

/**
 * expense.engine.test.js — Feature 10 slice 10c PROOF that EXPENSE now routes through
 * the configurable approval engine (replacing the bare canManageEmployees flip).
 *
 * Same plain-node + LIVE hr_test harness. Drives the REAL expenses.controller
 * (submit → approve / reject) and asserts the BUILT_IN_DEFAULT EXPENSE chain
 * (manager → HR over a threshold, with the HR step conditional-skipped below it):
 *
 *   (1) SMALL claim (amount below the HR threshold): submit opens a PENDING engine
 *       request routed to the manager; the manager approves → claim APPROVED. The HR
 *       step is skipped (manager-only), exactly mirroring today's "small claims stop at
 *       the manager" behaviour.
 *   (2) BIG claim (amount over the threshold): submit opens a PENDING request; the
 *       manager approves but the chain DOES NOT terminate — it advances to the HR step;
 *       HR approves → claim APPROVED. (amount > threshold adds HR.)
 *   (3) reject path: a manager reject terminates the claim REJECTED.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/expense.engine.test.js
 */

const prisma = require('../../../core/lib/prisma');
const expensesController = require('../../controllers/expenses.controller');
require('../registerConsumers'); // ensure LEAVE/EXPENSE consumers are wired
const { EXPENSE_HR_THRESHOLD } = require('../workflowResolver');
const { usersWithPermission } = require('../approverResolver');

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

const PREFIX = 'EXPENG-TEST';

async function cleanup(businessId) {
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { module: 'EXPENSE', requester: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  await prisma.approvalRequest.deleteMany({ where: { businessId, module: 'EXPENSE', requester: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.expenseClaim.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.expenseCategory.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
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

async function mkClaim(businessId, employeeId, categoryId, amount) {
  return prisma.expenseClaim.create({
    data: { businessId, employeeId, categoryId, amount: String(amount), currencyCode: 'INR', status: 'DRAFT', expenseDate: new Date('2026-06-01') },
  });
}

async function openReqFor(businessId, claimId) {
  return prisma.approvalRequest.findFirst({ where: { businessId, module: 'EXPENSE', entityType: 'ExpenseClaim', entityId: claimId } });
}

async function main() {
  log('\n=== Expense-through-a-chain proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  // An HR approver (canApproveLeave/HR) exists in the seeded demo tenant — the
  // BUILT_IN_DEFAULT EXPENSE chain's over-threshold HR step resolves to them.
  const hrUsers = await usersWithPermission(businessId, 'canApproveLeave');
  if (hrUsers.length === 0) throw new Error('demo tenant has no HR approver (canApproveLeave) — needed for the over-threshold step');

  try {
    const mgr = await mkUserEmp(businessId, 'Mgr');
    const ic = await mkUserEmp(businessId, 'Ic', mgr.emp.id);
    const cat = await prisma.expenseCategory.create({ data: { businessId, code: `${PREFIX}-TRV`, name: 'Travel' } });

    const mgrActor = { id: mgr.user.id, businessId, employeeId: mgr.emp.id };
    const icActor = { id: ic.user.id, businessId, employeeId: ic.emp.id };
    const hrActor = { id: hrUsers[0], businessId, employeeId: null };

    // ── (1) SMALL claim: manager-only (HR step conditional-skips below threshold) ──
    log(`(1) small claim (< ${EXPENSE_HR_THRESHOLD}) → manager-only:`);
    {
      const claim = await mkClaim(businessId, ic.emp.id, cat.id, 100);
      const sub = await callController(expensesController.submit, { user: icActor, params: { id: claim.id }, body: {} });
      assert(sub.statusCode === 200 && sub.body.status === 'SUBMITTED', `submit → 200 SUBMITTED (got ${sub.statusCode}/${sub.body && sub.body.status})`);

      const ar = await openReqFor(businessId, claim.id);
      assert(ar && ar.status === 'PENDING', `engine request opened PENDING (got ${ar && ar.status})`);
      const active = ar && ar.payloadJson && ar.payloadJson._active;
      assert(active && active.approverUserIds.includes(mgr.user.id), `routed to the manager (active=${JSON.stringify(active && active.approverUserIds)})`);

      const appr = await callController(expensesController.approve, { user: mgrActor, params: { id: claim.id }, body: {} });
      assert(appr.statusCode === 200 && appr.body.status === 'APPROVED', `manager approve → claim APPROVED (got ${appr.statusCode}/${appr.body && appr.body.status})`);
      assert(appr.body.decidedBy === mgr.user.id, `decidedBy stamped to the manager (got ${appr.body.decidedBy})`);
      const arDone = await openReqFor(businessId, claim.id);
      assert(arDone.status === 'APPROVED', `engine request APPROVED after the single manager step (HR skipped) (got ${arDone.status})`);
    }

    // ── (2) BIG claim: manager → HR (amount > threshold adds the HR step) ──
    log(`(2) big claim (> ${EXPENSE_HR_THRESHOLD}) → manager THEN HR:`);
    {
      const big = EXPENSE_HR_THRESHOLD + 10000;
      const claim = await mkClaim(businessId, ic.emp.id, cat.id, big);
      const sub = await callController(expensesController.submit, { user: icActor, params: { id: claim.id }, body: {} });
      assert(sub.statusCode === 200 && sub.body.status === 'SUBMITTED', `submit → 200 SUBMITTED (got ${sub.statusCode})`);

      // manager approves → chain ADVANCES to HR, claim NOT yet approved.
      const appr1 = await callController(expensesController.approve, { user: mgrActor, params: { id: claim.id }, body: {} });
      assert(appr1.statusCode === 200, `manager approve → 200 (got ${appr1.statusCode})`);
      assert(appr1.body.status === 'SUBMITTED', `claim still SUBMITTED after manager (chain advanced to HR; got ${appr1.body.status})`);
      const arMid = await openReqFor(businessId, claim.id);
      assert(arMid.status === 'PENDING' && arMid.currentStepOrder === 2, `engine request advanced to HR level (status ${arMid.status}, step ${arMid.currentStepOrder})`);
      const activeHr = arMid.payloadJson._active;
      assert(activeHr && activeHr.approverUserIds.includes(hrUsers[0]), `HR is now the active approver (active=${JSON.stringify(activeHr && activeHr.approverUserIds)})`);

      // HR approves → claim APPROVED (terminal).
      const appr2 = await callController(expensesController.approve, { user: hrActor, params: { id: claim.id }, body: {} });
      assert(appr2.statusCode === 200 && appr2.body.status === 'APPROVED', `HR approve → claim APPROVED (got ${appr2.statusCode}/${appr2.body && appr2.body.status})`);
      const arDone = await openReqFor(businessId, claim.id);
      assert(arDone.status === 'APPROVED', `engine request APPROVED after manager+HR (got ${arDone.status})`);
    }

    // ── (3) reject path: a manager reject terminates the claim ──
    log('(3) reject path → claim REJECTED:');
    {
      const claim = await mkClaim(businessId, ic.emp.id, cat.id, 100);
      await callController(expensesController.submit, { user: icActor, params: { id: claim.id }, body: {} });
      const rej = await callController(expensesController.reject, { user: mgrActor, params: { id: claim.id }, body: { reason: 'over budget' } });
      assert(rej.statusCode === 200 && rej.body.status === 'REJECTED', `manager reject → claim REJECTED (got ${rej.statusCode}/${rej.body && rej.body.status})`);
      assert(rej.body.rejectReason === 'over budget', `reject reason stamped (got ${rej.body.rejectReason})`);
      const ar = await openReqFor(businessId, claim.id);
      assert(ar.status === 'REJECTED', `engine request REJECTED (got ${ar.status})`);
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL EXPENSE-ENGINE CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

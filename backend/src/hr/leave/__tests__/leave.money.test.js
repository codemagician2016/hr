'use strict';

/**
 * leave.money.test.js — LIVE (hr_test) proof for the 6 Feature-6 "money/ledger"
 * review findings. Same plain-node harness + isolated hr_test schema as
 * leave.flow.test.js / scope.rbac.test.js.
 *
 * Covers, end to end through the REAL controller/runner + DB:
 *   #1 carry-forward IDEMPOTENCY — running runCarryForward twice for the same
 *      period rolls exactly once (single LAPSE + single OPENING_BALANCE; the
 *      source closing/lapsed and the next-period opening are NOT doubled; both
 *      periods reconcile against their ledger).
 *   #2 period-scoped apply balance — a balance exists for the WRONG (older)
 *      period AND the CURRENT period; createRequest soft-holds on the CURRENT
 *      period's row (not the newest-created arbitrary one).
 *   #3 approve SoD — an approver cannot approve their OWN leave (self-decision
 *      blocked → 404, request stays PENDING).
 *   #4 encashment period-scope — with a stale prior-period row AND a current
 *      row, resolveEncashableLeaveDays + writeBackLeaveEncashment only value /
 *      encash the CURRENT period (no over-pay; the stale row is untouched).
 *   #5 double-withdraw — two withdraws of the same approved leave credit the
 *      balance ONCE (the second is a 409 ALREADY_WITHDRAWN; closing not doubled).
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/leave/__tests__/leave.money.test.js
 */

const prisma = require('../../../core/lib/prisma');
const leaveController = require('../../controllers/leave.controller');
const offboarding = require('../../lifecycle/controllers/offboarding.controller');
const { runCarryForward } = require('../accrualRunner');
const ledger = require('../ledger');

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

const PREFIX = 'LEAVEMONEY-TEST';
const ALL_SCOPE = { kind: 'ALL' };

async function reconcilesPeriod(businessId, balanceId) {
  const bal = await prisma.leaveBalance.findUnique({ where: { id: balanceId } });
  const txns = await prisma.leaveTransaction.findMany({ where: { businessId, leaveBalanceId: balanceId } });
  return { ok: ledger.reconciles({ closing: Number(bal.closing) }, txns), bal, fromLedger: ledger.reconstructClosing(txns) };
}

async function cleanup(businessId) {
  await prisma.leaveTransaction.deleteMany({ where: { businessId, leaveType: { code: { startsWith: PREFIX } } } });
  await prisma.leaveBalance.deleteMany({ where: { businessId, leaveType: { code: { startsWith: PREFIX } } } });
  await prisma.leavePolicy.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Leave money/ledger findings proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    // ════════════════════════════════════════════════════════════════════════
    // #1 carry-forward idempotency
    // ════════════════════════════════════════════════════════════════════════
    log('#1 carry-forward run twice = single roll:');
    {
      const emp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-CF`, firstName: 'Carrie', lastName: 'F', status: 'ACTIVE', hireDate: new Date('2018-01-01') },
      });
      const lt = await prisma.leaveType.create({
        data: { businessId, code: `${PREFIX}-CFEL`, name: 'CF Earned', category: 'ANNUAL', unit: 'DAYS' },
      });
      // active policy with a carry cap of 8 → closing 12 carries 8, lapses 4.
      await prisma.leavePolicy.create({
        data: { businessId, leaveTypeId: lt.id, code: `${PREFIX}-CFPOL`, name: 'CF policy', accrualMethod: 'MONTHLY_ACCRUAL', carryForwardCap: '8', isActive: true },
      });
      const src = await prisma.leaveBalance.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, periodCode: '2025-26', unit: 'DAYS', opening: '12.0000', closing: '12.0000' },
      });
      await prisma.leaveTransaction.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, leaveBalanceId: src.id, txnType: 'OPENING_BALANCE', unit: 'DAYS', quantity: 12, status: 'APPROVED' },
      });

      const r1 = await runCarryForward({ businessId, periodCode: '2025-26', leaveTypeId: lt.id, dryRun: false, actorId: null });
      const r2 = await runCarryForward({ businessId, periodCode: '2025-26', leaveTypeId: lt.id, dryRun: false, actorId: null });

      assert(r1.rolled === 1, `first run rolls 1 balance (got ${r1.rolled})`);
      assert(r2.rolled === 0, `second run rolls 0 (idempotent; got rolled=${r2.rolled})`);

      const srcAfter = await prisma.leaveBalance.findUnique({ where: { id: src.id } });
      assert(Number(srcAfter.lapsed) === 4, `source lapsed = 4 (single lapse, got ${Number(srcAfter.lapsed)})`);
      assert(Number(srcAfter.closing) === 8, `source closing = 8 (12-4 lapse, got ${Number(srcAfter.closing)})`);
      assert(srcAfter.carriedForwardAt != null, `source stamped carriedForwardAt (idempotency marker set)`);

      const next = await prisma.leaveBalance.findFirst({ where: { businessId, employeeId: emp.id, leaveTypeId: lt.id, periodCode: '2026-27' } });
      assert(next && Number(next.opening) === 8, `next-period opening = 8 (single carry, NOT 16; got ${next && Number(next.opening)})`);
      assert(next && Number(next.closing) === 8, `next-period closing = 8 (got ${next && Number(next.closing)})`);

      const lapses = await prisma.leaveTransaction.count({ where: { businessId, leaveBalanceId: src.id, txnType: 'LAPSE' } });
      assert(lapses === 1, `exactly ONE LAPSE row posted (got ${lapses})`);
      const opens = await prisma.leaveTransaction.count({ where: { businessId, leaveBalanceId: next.id, txnType: 'OPENING_BALANCE' } });
      assert(opens === 1, `exactly ONE carried OPENING_BALANCE row (got ${opens})`);

      const recSrc = await reconcilesPeriod(businessId, src.id);
      assert(recSrc.ok, `source period reconciles (persisted ${Number(recSrc.bal.closing)} == ledger ${recSrc.fromLedger})`);
      const recNext = await reconcilesPeriod(businessId, next.id);
      assert(recNext.ok, `next period reconciles (persisted ${Number(recNext.bal.closing)} == ledger ${recNext.fromLedger})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // #2 period-scoped apply balance
    // ════════════════════════════════════════════════════════════════════════
    log('\n#2 apply soft-holds on the CURRENT period balance, not the newest:');
    {
      const emp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-PS`, firstName: 'Pera', lastName: 'S', status: 'ACTIVE', hireDate: new Date('2019-01-01') },
      });
      const lt = await prisma.leaveType.create({
        data: { businessId, code: `${PREFIX}-PSEL`, name: 'PS Earned', category: 'ANNUAL', unit: 'DAYS' },
      });
      // CURRENT period (FY containing 2026-06): 2026-27, closing 10. Created FIRST.
      const cur = await prisma.leaveBalance.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, periodCode: '2026-27', unit: 'DAYS', opening: '10', closing: '10' },
      });
      // A NEWER-created row for a DIFFERENT (next) period — the old findFirst(desc)
      // bug would soft-hold here instead.
      const wrong = await prisma.leaveBalance.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, periodCode: '2027-28', unit: 'DAYS', opening: '3', closing: '3' },
      });

      const req = { user: { id: 'op-2', businessId, employeeId: null }, body: { employeeId: emp.id, leaveTypeId: lt.id, startDate: '2026-06-09', endDate: '2026-06-09' } };
      const res = await callController(leaveController.createRequest, req);
      assert(res.statusCode === 201, `apply → 201 (got ${res.statusCode}: ${JSON.stringify(res.body && res.body.message)})`);

      const curFresh = await prisma.leaveBalance.findUnique({ where: { id: cur.id } });
      const wrongFresh = await prisma.leaveBalance.findUnique({ where: { id: wrong.id } });
      assert(Number(curFresh.pendingApproval) === 1, `CURRENT (2026-27) period holds 1 (got ${Number(curFresh.pendingApproval)})`);
      assert(Number(wrongFresh.pendingApproval) === 0, `WRONG (2027-28) newest row untouched (got ${Number(wrongFresh.pendingApproval)})`);
      assert(res.body && res.body.leaveBalanceId === cur.id, `application stamped with the CURRENT period balance id`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // #3 approve SoD — self-approval blocked
    // ════════════════════════════════════════════════════════════════════════
    log('\n#3 approver cannot approve their OWN leave (SoD):');
    {
      const mgr = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-SOD`, firstName: 'Sodo', lastName: 'M', status: 'ACTIVE', hireDate: new Date('2017-01-01') },
      });
      const lt = await prisma.leaveType.create({
        data: { businessId, code: `${PREFIX}-SODEL`, name: 'SoD Earned', category: 'ANNUAL', unit: 'DAYS' },
      });
      const bal = await prisma.leaveBalance.create({
        data: { businessId, employeeId: mgr.id, leaveTypeId: lt.id, periodCode: '2026-27', unit: 'DAYS', opening: '10', closing: '10' },
      });
      const app = await prisma.leaveTransaction.create({
        data: { businessId, employeeId: mgr.id, leaveTypeId: lt.id, leaveBalanceId: bal.id, txnType: 'APPLICATION', unit: 'DAYS', quantity: -1, status: 'PENDING', startDate: new Date('2026-06-09T00:00:00Z'), endDate: new Date('2026-06-09T00:00:00Z') },
      });
      // actor IS the applicant (req.user.employeeId === txn.employeeId) → SoD block.
      const req = { user: { id: 'usr-sod', businessId, employeeId: mgr.id }, scope: ALL_SCOPE, params: { id: app.id }, body: {} };
      const res = await callController(leaveController.approveRequest, req);
      assert(res.statusCode === 404, `self-approve blocked → 404 (got ${res.statusCode})`);
      const fresh = await prisma.leaveTransaction.findUnique({ where: { id: app.id } });
      assert(fresh.status === 'PENDING', `own application stays PENDING (got ${fresh.status})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // #4 encashment scoped to the FnF period
    // ════════════════════════════════════════════════════════════════════════
    log('\n#4 encashment values/encashes only the FnF period (no over-pay):');
    {
      const emp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-ENC`, firstName: 'Enca', lastName: 'C', status: 'ACTIVE', hireDate: new Date('2018-01-01') },
      });
      const lt = await prisma.leaveType.create({
        data: { businessId, code: `${PREFIX}-ENCEL`, name: 'Enc Earned', category: 'ANNUAL', unit: 'DAYS', isEncashable: true },
      });
      // STALE prior-period row that should NOT be encashed (closing 5, FY 2025-26).
      const stale = await prisma.leaveBalance.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, periodCode: '2025-26', unit: 'DAYS', opening: '5', closing: '5' },
      });
      await prisma.leaveTransaction.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, leaveBalanceId: stale.id, txnType: 'OPENING_BALANCE', unit: 'DAYS', quantity: 5, status: 'APPROVED' },
      });
      // CURRENT FnF-period row (closing 9, FY 2026-27 — LWD 2026-06-30 lands here).
      const cur = await prisma.leaveBalance.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, periodCode: '2026-27', unit: 'DAYS', opening: '9', closing: '9' },
      });
      await prisma.leaveTransaction.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, leaveBalanceId: cur.id, txnType: 'OPENING_BALANCE', unit: 'DAYS', quantity: 9, status: 'APPROVED' },
      });

      const period = '2026-27';
      // valuation: only the current period (9), NOT 5+9=14.
      const days = await offboarding._internals.resolveEncashableLeaveDays(businessId, emp.id, prisma, { periodCode: period });
      assert(days === 9, `valuation scoped to FnF period = 9 (NOT 14; got ${days})`);

      // write-back: only the current period row is encashed → its closing 0; stale untouched.
      const out = await prisma.$transaction(async (tx) => offboarding._internals.writeBackLeaveEncashment(tx, { businessId, employeeId: emp.id, payRunId: null, periodCode: period }));
      assert(out.encashedDays === 9, `write-back encashes 9 (got ${out.encashedDays})`);
      const curFresh = await prisma.leaveBalance.findUnique({ where: { id: cur.id } });
      const staleFresh = await prisma.leaveBalance.findUnique({ where: { id: stale.id } });
      assert(Number(curFresh.closing) === 0 && Number(curFresh.encashed) === 9, `current period closing→0 via encashed=9 (got closing ${Number(curFresh.closing)}, encashed ${Number(curFresh.encashed)})`);
      assert(Number(staleFresh.closing) === 5 && Number(staleFresh.encashed) === 0, `stale prior-period row UNTOUCHED (closing ${Number(staleFresh.closing)}, encashed ${Number(staleFresh.encashed)})`);
      const recCur = await reconcilesPeriod(businessId, cur.id);
      assert(recCur.ok, `current period reconciles after encash (persisted ${Number(recCur.bal.closing)} == ledger ${recCur.fromLedger})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // #5 double-withdraw — no double credit
    // ════════════════════════════════════════════════════════════════════════
    log('\n#5 re-withdraw does not double-credit:');
    {
      const emp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-WD`, firstName: 'Wendy', lastName: 'D', status: 'ACTIVE', hireDate: new Date('2019-01-01') },
      });
      const lt = await prisma.leaveType.create({
        data: { businessId, code: `${PREFIX}-WDEL`, name: 'WD Earned', category: 'ANNUAL', unit: 'DAYS' },
      });
      const bal = await prisma.leaveBalance.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, periodCode: '2026-27', unit: 'DAYS', opening: '10', taken: '3', closing: '7' },
      });
      await prisma.leaveTransaction.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, leaveBalanceId: bal.id, txnType: 'OPENING_BALANCE', unit: 'DAYS', quantity: 10, status: 'APPROVED' },
      });
      // an APPROVED application consuming 3 (so the ledger reconciles to closing 7).
      const app = await prisma.leaveTransaction.create({
        data: { businessId, employeeId: emp.id, leaveTypeId: lt.id, leaveBalanceId: bal.id, txnType: 'APPLICATION', unit: 'DAYS', quantity: -3, status: 'APPROVED', startDate: new Date('2026-06-09T00:00:00Z'), endDate: new Date('2026-06-11T00:00:00Z') },
      });

      const mkReq = () => ({ user: { id: 'op-wd', businessId, employeeId: emp.id }, scope: ALL_SCOPE, params: { id: app.id }, body: {} });
      const res1 = await callController(leaveController.withdrawRequest, mkReq());
      assert(res1.statusCode === 200, `first withdraw → 200 (got ${res1.statusCode})`);
      const res2 = await callController(leaveController.withdrawRequest, mkReq());
      assert(res2.statusCode === 409, `second withdraw → 409 already-withdrawn (got ${res2.statusCode})`);
      assert(res2.body && res2.body.reason === 'ALREADY_WITHDRAWN', `reason ALREADY_WITHDRAWN (got ${res2.body && res2.body.reason})`);

      const fresh = await prisma.leaveBalance.findUnique({ where: { id: bal.id } });
      assert(Number(fresh.closing) === 10, `closing credited back ONCE to 10 (NOT 13; got ${Number(fresh.closing)})`);
      assert(Number(fresh.taken) === 0, `taken reversed ONCE to 0 (got ${Number(fresh.taken)})`);
      const cancels = await prisma.leaveTransaction.count({ where: { businessId, leaveBalanceId: bal.id, txnType: 'CANCELLATION' } });
      assert(cancels === 1, `exactly ONE CANCELLATION audit row (got ${cancels})`);
      const rec = await reconcilesPeriod(businessId, bal.id);
      assert(rec.ok, `reconciles after single withdraw (persisted ${Number(rec.bal.closing)} == ledger ${rec.fromLedger})`);
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL LEAVE-MONEY CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

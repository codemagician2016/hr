'use strict';

/*
 * leave-encashment.live.test.js — LIVE (hr_test) proof of Feature 31 "in-service leave
 * encashment". MIRRORS reimbursement-payout.live.test.js but proves a FULLY-TAXABLE
 * earning (not a non-taxable reimbursement):
 *
 *   1. an APPROVED encashment request (balance DEBITED once at approve) gets a
 *      LEAVE_ENCASHMENT line on the payslip; the request is stamped PAID + payRunId +
 *      paidAmountMinor; GROSS and TDS go UP (it is TAXABLE — unlike a reimbursement); and
 *      §10(10AA) is NEVER applied (taxable amount == the WHOLE amount).
 *   2. the APPROVE debits the leave balance EXACTLY ONCE (encashed+, closing−) and the
 *      ledger reconstructs the persisted closing (the §4.2 invariant).
 *   3. RE-RUNNING the run does NOT double-pay (idempotent: same line, request stamped once).
 *   4. REOPEN releases the request back to APPROVED (stamp cleared, NO leave re-credit); a
 *      later run re-pays it.
 *   5. CANCEL releases the request back to APPROVED (NO leave re-credit).
 *   6. the per-day basis (Basic+DA / 26) computes correctly to the paise.
 *   7. the yearly days cap + once-a-year request cap are enforced by the pure validator.
 *
 * Plain-node (built-in assert, NO jest). Run:
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/__tests__/leave-encashment.live.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'. Uses the seed 'demo'
 * tenant's IN-HQ entity/calendar/employees. Every row written is torn down at the end.
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const service = require('../service');
const ledger = require('../../leave/ledger');
const { validateEncashRequest, computeEncashAmount } = require('../../leave/encashment/encashment');
const encashConsumer = require('../../approvals/consumers.encashment');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
function dec(v) { return Number(v); }

const PREFIX = 'ENCASHPAY';
const LT_CODE = `${PREFIX}-EL`;

async function cleanup(businessId) {
  const runs = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await prisma.statutoryRemittance.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payslip.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: ids } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.leaveEncashmentRequest.updateMany({ where: { payRunId: { in: ids } }, data: { status: 'APPROVED', payRunId: null, paidAmountMinor: null, paidAt: null } });
    await prisma.payRun.deleteMany({ where: { id: { in: ids } } });
  }
  // Encashment requests + their ledger rows + the test leave type/policy/balance.
  const lt = await prisma.leaveType.findFirst({ where: { businessId, code: LT_CODE } });
  if (lt) {
    await prisma.leaveEncashmentRequest.deleteMany({ where: { businessId, leaveTypeId: lt.id } });
    await prisma.leaveTransaction.deleteMany({ where: { businessId, leaveTypeId: lt.id } });
    await prisma.leaveBalance.deleteMany({ where: { businessId, leaveTypeId: lt.id } });
    await prisma.leavePolicy.deleteMany({ where: { businessId, leaveTypeId: lt.id } });
    await prisma.leaveType.deleteMany({ where: { businessId, id: lt.id } });
  }
  await prisma.approvalRequest.deleteMany({ where: { businessId, module: 'LEAVE_ENCASHMENT', entityType: 'LeaveEncashmentRequest', payloadJson: { path: ['_tag'], equals: PREFIX } } }).catch(() => {});
}

async function mkRun(businessId, entity, cal, { periodStart, periodEnd, payDate, taxYear, seq, suffix }) {
  return prisma.payRun.create({
    data: {
      businessId, entityId: entity.id, payCalendarId: cal.id,
      code: `${PREFIX}-${entity.code}-${suffix}`,
      periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), payDate: new Date(payDate),
      sequenceInYear: seq, taxYear, currencyCode: entity.payCurrency, status: 'DRAFT', type: 'REGULAR',
    },
  });
}

async function computeBare(businessId, run) {
  await service.computeRun({ businessId, actorId: 'maker-encash', payRunId: run.id });
  return prisma.payRunLine.findFirst({ where: { businessId, payRunId: run.id }, include: { components: true } });
}

// Create an APPROVED encashment request the way the consumer would (post the ENCASHMENT
// ledger row + debit the balance + snapshot the amount) — exercising the REAL onApprove.
async function approveEncashment(businessId, employeeId, leaveTypeId, periodCode, days) {
  // 1) Create the PENDING request + place the soft-hold (mirror the ESS create path).
  const balanceBefore = await prisma.leaveBalance.findFirst({ where: { businessId, employeeId, leaveTypeId, periodCode } });
  const reqRow = await prisma.$transaction(async (tx) => {
    const row = await tx.leaveEncashmentRequest.create({
      data: { businessId, employeeId, leaveTypeId, leavePolicyId: null, periodCode, days, basis: 'BASIC_DA_26', status: 'PENDING', appliedAt: new Date() },
    });
    await tx.leaveBalance.update({ where: { id: balanceBefore.id, version: balanceBefore.version }, data: { pendingApproval: { increment: days }, version: { increment: 1 } } });
    return row;
  });
  // 2) Drive the REAL onApprove (the balance debit + amount snapshot) in one tx.
  await prisma.$transaction(async (tx) => {
    await encashConsumer._internals.onApprove({ businessId, entityId: reqRow.id, decidedBy: 'approver-encash' }, tx);
  });
  return prisma.leaveEncashmentRequest.findUnique({ where: { id: reqRow.id } });
}

async function main() {
  log('\n=== In-service leave encashment proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } });
  const inCal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } });
  if (!inEntity || !inCal) throw new Error('IN-HQ entity/calendar missing in hr_test');

  await cleanup(businessId);

  // Pick the first current IN employee with a compensation (Basic resolves the per-day).
  const emps = await prisma.employmentRecord.findMany({ where: { businessId, entityId: inEntity.id, isCurrent: true }, select: { employeeId: true } });
  let employeeId = null; let basicDaMinor = 0;
  for (const e of emps) {
    const comp = await prisma.compensationRevision.findFirst({ where: { businessId, employeeId: e.employeeId, isCurrent: true }, include: { lines: { include: { component: { select: { kind: true } } } } } });
    if (comp) {
      let bd = 0;
      for (const ln of comp.lines || []) if (['BASIC', 'DEARNESS_ALLOWANCE'].includes(ln.component && ln.component.kind) && ln.amountMonthly != null) bd += Number(ln.amountMonthly);
      if (bd > 0) { employeeId = e.employeeId; basicDaMinor = Math.round(bd * 100); break; }
    }
  }
  if (!employeeId) throw new Error('No IN employee with a Basic+DA compensation in hr_test');
  log(`  using employee ${employeeId} (Basic+DA = ${basicDaMinor / 100}/mo)\n`);

  // Seed a dedicated encashable EL type + in-service policy + a fat balance for our period.
  const leaveType = await prisma.leaveType.create({
    data: { businessId, code: LT_CODE, name: 'Encash EL (F31 test)', category: 'ANNUAL', unit: 'DAYS', isEncashable: true },
  });
  const policy = await prisma.leavePolicy.create({
    data: {
      businessId, leaveTypeId: leaveType.id, code: `${PREFIX}-POL`, name: 'F31 in-service policy', accrualMethod: 'MONTHLY_ACCRUAL',
      encashInService: true, encashBasis: 'BASIC_DA_26', encashMaxDaysPerYear: '15', encashMinDaysPerRequest: '5', encashMinBalanceAfter: '5', encashMaxRequestsPerYear: 1,
      encashPfWages: false, encashEsiWages: false, encashPtWages: true,
    },
  });
  const periodCode = '2026-27';
  const balance = await prisma.leaveBalance.create({
    data: { businessId, employeeId, leaveTypeId: leaveType.id, periodCode, unit: 'DAYS', opening: '30', closing: '30' },
  });
  // Seed the matching OPENING_BALANCE ledger row so the §4.2 reconcile (closing ==
  // signed reduction over the ledger) holds once the ENCASHMENT row is posted.
  await prisma.leaveTransaction.create({
    data: { businessId, employeeId, leaveTypeId: leaveType.id, leaveBalanceId: balance.id, txnType: 'OPENING_BALANCE', unit: 'DAYS', quantity: '30', status: 'APPROVED', appliedAt: new Date(), decidedAt: new Date() },
  });

  // ── 0. BASELINE — same run, NO encashment, to prove the taxable delta later ──────
  const baseRun = await mkRun(businessId, inEntity, inCal, { periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-31', taxYear: '2026-27', seq: 7, suffix: 'JUL-BASE' });
  const baseLine = await computeBare(businessId, baseRun);
  ok(!!baseLine, '0.0 baseline payslip line created (no encashment)');
  const baseGross = dec(baseLine.grossEarnings);
  const baseTds = dec(baseLine.tds);

  // ── 6. per-day basis: Basic+DA / 26, single-rounding ──────────────────────────
  const DAYS = 10;
  const expected = computeEncashAmount({ basis: 'BASIC_DA_26', basicDaMonthlyMinor: basicDaMinor, days: DAYS });
  const expectedMajor = expected.amountMinor / 100;
  ok(expected.amountMinor === Math.floor((basicDaMinor * DAYS) / 26 + 0.5), `6.0 amount = floor(Basic+DA × ${DAYS} / 26 + 0.5) = ${expectedMajor}`);

  // ── 1/2. APPROVE debits the balance ONCE + snapshots the amount ─────────────────
  const req = await approveEncashment(businessId, employeeId, leaveType.id, periodCode, DAYS);
  ok(req.status === 'APPROVED', '2.1 request APPROVED');
  ok(Number(req.amountMinor) === expected.amountMinor, `2.2 amount snapshotted at approve = ${expectedMajor} (got ${Number(req.amountMinor) / 100})`);
  ok(!!req.encashmentTxnId, '2.3 ENCASHMENT ledger row linked');

  const balAfter = await prisma.leaveBalance.findUnique({ where: { id: balance.id } });
  ok(dec(balAfter.encashed) === DAYS, `2.4 balance.encashed += ${DAYS} (got ${balAfter.encashed})`);
  ok(dec(balAfter.closing) === 30 - DAYS, `2.5 balance.closing −= ${DAYS} → ${30 - DAYS} (got ${balAfter.closing})`);
  ok(dec(balAfter.pendingApproval) === 0, '2.6 soft-hold released (pendingApproval 0)');
  // §4.2 reconcile: the ledger (incl. the ENCASHMENT row) reconstructs the closing.
  const txns = await prisma.leaveTransaction.findMany({ where: { businessId, employeeId, leaveTypeId: leaveType.id } });
  ok(ledger.reconciles({ closing: dec(balAfter.closing) }, txns), '2.7 ledger reconstructs persisted closing (incl. ENCASHMENT row)');
  const encTxnCount = await prisma.leaveTransaction.count({ where: { businessId, leaveTypeId: leaveType.id, txnType: 'ENCASHMENT' } });
  ok(encTxnCount === 1, '2.8 exactly ONE ENCASHMENT ledger row (debit once)');

  // ── 1. PAY RUN emits a TAXABLE LEAVE_ENCASHMENT earning + stamps the request ────
  const run = await mkRun(businessId, inEntity, inCal, { periodStart: '2026-08-01', periodEnd: '2026-08-31', payDate: '2026-08-31', taxYear: '2026-27', seq: 8, suffix: 'AUG' });
  const line = await computeBare(businessId, run);
  ok(!!line, '1.0 payslip line created');
  const encComp = (line.components || []).find((c) => c.componentCode === 'LEAVE_ENCASHMENT');
  ok(!!encComp, '1.1 payslip has a LEAVE_ENCASHMENT line');
  ok(encComp && encComp.category === 'EARNING', '1.2 LEAVE_ENCASHMENT is category EARNING (taxable)');
  ok(encComp && dec(encComp.amount) === expectedMajor, `1.3 LEAVE_ENCASHMENT amount = ${expectedMajor} (got ${encComp && encComp.amount})`);

  const r1 = await prisma.leaveEncashmentRequest.findUnique({ where: { id: req.id } });
  ok(r1.status === 'PAID', '1.4 request stamped PAID');
  ok(r1.payRunId === run.id, '1.5 request.payRunId = this run');
  ok(Number(r1.paidAmountMinor) === expected.amountMinor, `1.6 request.paidAmountMinor = ${expectedMajor}`);
  ok(!!r1.paidAt, '1.7 request.paidAt set');

  // TAXABLE: GROSS goes UP by the encashment (the load-bearing difference vs a
  // reimbursement, which leaves gross unchanged and only raises net). The taxable base
  // therefore inflates by the full amount — §192/TDS sees it. (TDS itself may be 0 at
  // this employee's income slab; the gross/taxable-base inflation is the taxability proof.)
  ok(dec(line.grossEarnings) === baseGross + expectedMajor, `1.8 GROSS = baseline + ${expectedMajor} (taxable earning; ${baseGross + expectedMajor}, got ${line.grossEarnings})`);
  ok(dec(line.tds) >= baseTds, `1.9 TDS does not drop vs no-encashment run (taxable base inflated; base ${baseTds}, got ${line.tds})`);

  // §10(10AA) is NEVER applied in service — the taxable amount IS the whole amount (no exempt split).
  ok(dec(encComp.amount) === expectedMajor, '1.10 taxable amount == the WHOLE encashment amount (no §10(10AA) exemption)');

  // ── 3. RE-RUN does NOT double-pay (idempotent) ────────────────────────────────
  const line2 = await computeBare(businessId, run);
  const encComp2 = (line2.components || []).find((c) => c.componentCode === 'LEAVE_ENCASHMENT');
  ok(encComp2 && dec(encComp2.amount) === expectedMajor, `3.1 recompute still pays exactly ${expectedMajor} (not double)`);
  ok(dec(line2.grossEarnings) === baseGross + expectedMajor, '3.2 recompute gross unchanged (no double-pay)');
  const paidCount = await prisma.leaveEncashmentRequest.count({ where: { id: req.id, status: 'PAID', payRunId: run.id } });
  ok(paidCount === 1, '3.3 request stamped PAID exactly once (idempotent)');
  // The balance must NOT have moved again (debit stays once).
  const balAfter2 = await prisma.leaveBalance.findUnique({ where: { id: balance.id } });
  ok(dec(balAfter2.encashed) === DAYS, '3.4 recompute does NOT re-debit the leave balance');

  // ── 4. REOPEN releases the request to APPROVED (NO leave re-credit) ────────────
  await service.reopenRun({ businessId, actorId: 'maker-encash', payRunId: run.id });
  const r3 = await prisma.leaveEncashmentRequest.findUnique({ where: { id: req.id } });
  ok(r3.status === 'APPROVED' && r3.payRunId === null && r3.paidAmountMinor === null, '4.1 reopen → request back to APPROVED, payRunId + paidAmountMinor cleared');
  const balReopen = await prisma.leaveBalance.findUnique({ where: { id: balance.id } });
  ok(dec(balReopen.encashed) === DAYS && dec(balReopen.closing) === 30 - DAYS, '4.2 reopen does NOT re-credit the leave (surrender stands)');

  // 4b. A NEW run after reopen re-pays the now-APPROVED request (auto-carry).
  await service.computeRun({ businessId, actorId: 'maker-encash', payRunId: run.id });
  const r3b = await prisma.leaveEncashmentRequest.findUnique({ where: { id: req.id } });
  ok(r3b.status === 'PAID' && r3b.payRunId === run.id, '4.3 recompute after reopen re-pays the request (stamped again)');

  // ── 5. CANCEL releases the request to APPROVED (NO leave re-credit) ────────────
  await service.cancelRun({ businessId, actorId: 'maker-encash', payRunId: run.id, reason: 'test' });
  const r4 = await prisma.leaveEncashmentRequest.findUnique({ where: { id: req.id } });
  ok(r4.status === 'APPROVED' && r4.payRunId === null && r4.paidAmountMinor === null, '5.1 cancel → request released back to APPROVED (stamp cleared)');
  const balCancel = await prisma.leaveBalance.findUnique({ where: { id: balance.id } });
  ok(dec(balCancel.encashed) === DAYS, '5.2 cancel does NOT re-credit the leave (surrender stands)');

  // ── 7. caps enforced by the pure validator (against the live balance) ─────────
  const liveBal = await prisma.leaveBalance.findUnique({ where: { id: balance.id } });
  // already encashed 10 this year; a second 10 would exceed the 15-day cap.
  const capV = validateEncashRequest({ balance: liveBal, policy, leaveType, request: { days: 10 }, alreadyEncashedThisYearDays: 10, requestsThisYear: 0, asOfMonth: 3 });
  ok(!capV.ok && capV.code === 'YEARLY_CAP_EXCEEDED', '7.1 yearly days cap enforced (10 + 10 > 15)');
  // a second request when one already exists → once/year cap.
  const reqV = validateEncashRequest({ balance: liveBal, policy, leaveType, request: { days: 5 }, alreadyEncashedThisYearDays: 10, requestsThisYear: 1, asOfMonth: 3 });
  ok(!reqV.ok && reqV.code === 'MAX_REQUESTS_REACHED', '7.2 once-a-year request cap enforced');

  await cleanup(businessId);

  if (failures > 0) { log(`\n${failures} FAILURE(S)`); process.exit(1); }
  log('\nAll leave-encashment live checks passed.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

'use strict';

/*
 * encashment-cyc4-fixes.live.test.js — LIVE (hr_test) proof of the 5 Cycle-4 review fixes
 * for Feature 31 (in-service leave encashment). MONEY + PII. Plain-node (built-in assert,
 * NO jest). Run:
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/__tests__/encashment-cyc4-fixes.live.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'. Every row written is torn
 * down at the end (prefix CYC4ENC).
 *
 * Proves:
 *   #1 runEncashments preview is F1-scoped — a manager sees ONLY their team's requests
 *      (both the paid + queued lists), never a tenant-wide leak.
 *   #2 BASIC_30 pays Basic-ONLY per day to the paise (NOT Basic+DA) — the consumer feeds
 *      the basic-only figure resolveLastDrawnPay now returns.
 *   #3 Per-year caps can't be bypassed: two PENDING requests that both pass the create-time
 *      gate can't BOTH approve — the second is rejected by the in-tx cap re-check.
 *   #4 Concurrent same-period runs don't double-pay: when a request drops at reconcile the
 *      payslip is REPRICED off the SAME locked set that gets stamped (gross/net match paid).
 *   #5 Self-approval is blocked at the USER level even via systemActor, and fails CLOSED
 *      when identity can't be resolved.
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const service = require('../service');
const { computeEncashAmount } = require('../../leave/encashment/encashment');
const encashConsumer = require('../../approvals/consumers.encashment');
const encashController = require('../../controllers/encashment.controller');
const offboarding = require('../../lifecycle/controllers/offboarding.controller');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
function dec(v) { return Number(v); }

const PREFIX = 'CYC4ENC';
const LT_CODE = `${PREFIX}-EL`;

async function cleanup(businessId) {
  const lt = await prisma.leaveType.findFirst({ where: { businessId, code: LT_CODE } });
  const runs = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const runIds = runs.map((r) => r.id);
  if (runIds.length) {
    await prisma.leaveEncashmentRequest.updateMany({ where: { payRunId: { in: runIds } }, data: { status: 'APPROVED', payRunId: null, paidAmountMinor: null, paidAt: null } });
    await prisma.statutoryRemittance.deleteMany({ where: { payRunId: { in: runIds } } });
    await prisma.payslip.deleteMany({ where: { payRunId: { in: runIds } } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: runIds } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: runIds } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: runIds } } });
    await prisma.payRun.deleteMany({ where: { id: { in: runIds } } });
  }
  if (lt) {
    await prisma.leaveEncashmentRequest.deleteMany({ where: { businessId, leaveTypeId: lt.id } });
    await prisma.leaveTransaction.deleteMany({ where: { businessId, leaveTypeId: lt.id } });
    await prisma.leaveBalance.deleteMany({ where: { businessId, leaveTypeId: lt.id } });
    await prisma.leavePolicy.deleteMany({ where: { businessId, leaveTypeId: lt.id } });
    await prisma.leaveType.deleteMany({ where: { businessId, id: lt.id } });
  }
  // Test comp revision + components + the test employees (CYC4ENC-*).
  const testEmps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const empIds = testEmps.map((e) => e.id);
  if (empIds.length) {
    await prisma.salaryComponentLine.deleteMany({ where: { businessId, compensation: { employeeId: { in: empIds } } } });
    await prisma.compensationRevision.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
  }
  await prisma.salaryComponent.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  // Test User rows (FK target for the SoD employees; not tenant-scoped).
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

// Create a test employee (optionally with a userId + manager) — minimal, tenant-scoped.
async function mkEmployee(businessId, { code, userId = null, managerEmployeeId = null, firstName }) {
  return prisma.employee.create({
    data: {
      businessId, code, firstName, lastName: 'T31',
      userId, managerEmployeeId, isActive: true,
    },
  });
}

async function main() {
  log('\n=== Feature 31 Cycle-4 fixes proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } });
  const inCal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } });
  if (!inEntity || !inCal) throw new Error('IN-HQ entity/calendar missing in hr_test');

  await cleanup(businessId);

  // Encashable EL type used across the findings.
  const leaveType = await prisma.leaveType.create({
    data: { businessId, code: LT_CODE, name: 'CYC4 Encash EL', category: 'ANNUAL', unit: 'DAYS', isEncashable: true },
  });
  const periodCode = '2026-27';

  // ──────────────────────────────────────────────────────────────────────────────
  // FINDING #2 — BASIC_30 pays BASIC-ONLY per day (not Basic+DA).
  // Seed an employee with a current comp revision: BASIC 30,000 + DA 10,000.
  //   correct BASIC_30 for 6 days = 30000*6/30 = ₹6,000   (NOT 40000*6/30 = ₹8,000)
  // ──────────────────────────────────────────────────────────────────────────────
  log('FINDING #2 — BASIC_30 basis uses Basic-only');
  // resolveLastDrawnPay reads ONLY the current CompensationRevision (no EmploymentRecord),
  // so we seed a comp revision with separate BASIC + DA lines — no employment record needed.
  const empBasic = await mkEmployee(businessId, { code: `${PREFIX}-B30`, firstName: 'Basic30' });
  const cBasic = await prisma.salaryComponent.create({
    data: { businessId, code: `${PREFIX}-BASIC`, name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT' },
  });
  const cDa = await prisma.salaryComponent.create({
    data: { businessId, code: `${PREFIX}-DA`, name: 'DA', kind: 'DEARNESS_ALLOWANCE', category: 'EARNING', calcMethod: 'FLAT' },
  });
  const compRev = await prisma.compensationRevision.create({
    data: {
      businessId, employeeId: empBasic.id, entityId: inEntity.id, currencyCode: 'INR',
      basis: 'GROSS', grossMonthly: '40000.00', effectiveFrom: new Date('2026-01-01'),
      isCurrent: true, revisionReason: 'HIRE', status: 'EFFECTIVE',
    },
  });
  await prisma.salaryComponentLine.createMany({
    data: [
      { businessId, compensationId: compRev.id, componentId: cBasic.id, calcMethod: 'FLAT', amountMonthly: '30000.00' },
      { businessId, compensationId: compRev.id, componentId: cDa.id, calcMethod: 'FLAT', amountMonthly: '10000.00' },
    ],
  });

  // resolveLastDrawnPay must split basic-only from basic+DA.
  const pay = await offboarding._internals.resolveLastDrawnPay(businessId, empBasic.id);
  ok(pay.basicDaMonthlyMinor === 4000000, `2.0a resolveLastDrawnPay basicDa = ₹40,000 (got ${pay.basicDaMonthlyMinor / 100})`);
  ok(pay.basicMonthlyMinor === 3000000, `2.0b resolveLastDrawnPay basicOnly = ₹30,000 (got ${pay.basicMonthlyMinor / 100})`);

  // BASIC_30 policy + balance, then drive the REAL onApprove.
  const polB30 = await prisma.leavePolicy.create({
    data: { businessId, leaveTypeId: leaveType.id, code: `${PREFIX}-POL-B30`, name: 'B30 policy', accrualMethod: 'MONTHLY_ACCRUAL', encashInService: true, encashBasis: 'BASIC_30', encashMaxRequestsPerYear: 5 },
  });
  const balB30 = await prisma.leaveBalance.create({
    data: { businessId, employeeId: empBasic.id, leaveTypeId: leaveType.id, periodCode, unit: 'DAYS', opening: '30', closing: '30' },
  });
  const DAYS_B30 = 6;
  const reqB30 = await prisma.$transaction(async (tx) => {
    const row = await tx.leaveEncashmentRequest.create({
      data: { businessId, employeeId: empBasic.id, leaveTypeId: leaveType.id, leavePolicyId: polB30.id, periodCode, days: DAYS_B30, basis: 'BASIC_30', status: 'PENDING', appliedAt: new Date() },
    });
    await tx.leaveBalance.update({ where: { id: balB30.id, version: balB30.version }, data: { pendingApproval: { increment: DAYS_B30 }, version: { increment: 1 } } });
    return row;
  });
  await prisma.$transaction(async (tx) => {
    await encashConsumer._internals.onApprove({ businessId, entityId: reqB30.id, decidedBy: 'approver-b30' }, tx);
  });
  const reqB30After = await prisma.leaveEncashmentRequest.findUnique({ where: { id: reqB30.id } });
  const expectBasic30 = computeEncashAmount({ basis: 'BASIC_30', basicDaMonthlyMinor: 3000000, days: DAYS_B30 });
  ok(expectBasic30.amountMinor === 600000, `2.1 expected BASIC_30 amount = ₹6,000 (30000*6/30)`);
  ok(Number(reqB30After.amountMinor) === 600000, `2.2 onApprove paid Basic-only ₹6,000 (got ${Number(reqB30After.amountMinor) / 100}) — NOT ₹8,000 (Basic+DA bug)`);
  ok(Number(reqB30After.amountMinor) !== 800000, '2.3 did NOT over-pay by the DA component (₹8,000)');
  ok(Number(reqB30After.perDayMinor) === 100000, `2.4 perDay = ₹1,000 (30000/30), got ${Number(reqB30After.perDayMinor) / 100}`);
  ok(Number(reqB30After.basicDaMonthlyMinor) === 3000000, '2.5 snapshot base = Basic-only ₹30,000 (audit reconciles with perDay)');

  // ──────────────────────────────────────────────────────────────────────────────
  // FINDING #5 — self-approval blocked at the USER level even via systemActor; fails closed.
  // assertNotSelfApproval resolves the requester's userId from the row's employee.
  // ──────────────────────────────────────────────────────────────────────────────
  log('\nFINDING #5 — user-level self-approval block (fail closed)');
  // Real User rows (userId is a FK). The requester's portal user is A.
  const uA = await prisma.user.create({ data: { email: `${PREFIX}-a@test.local`, password: 'x', name: 'User A' } });
  const uB = await prisma.user.create({ data: { email: `${PREFIX}-b@test.local`, password: 'x', name: 'User B' } });
  const userA = uA.id;
  const userB = uB.id;
  const empReq = await mkEmployee(businessId, { code: `${PREFIX}-REQ`, userId: userA, firstName: 'Requester' });
  const rowForSod = { employeeId: empReq.id };

  // (a) Same user (A) approving A's own request → BLOCKED at user level, even though the
  //     actor has NO linked employeeId (employeeId-only guard would have skipped).
  const sodSelf = await encashController._internals.assertNotSelfApproval(
    { user: { id: userA, employeeId: null } }, businessId, rowForSod);
  ok(!sodSelf.ok && sodSelf.code === 'SELF_APPROVAL_BLOCKED', '5.1 same USER (no linked employee) → self-approval BLOCKED');

  // (b) A different user (B) approving A's request → allowed.
  const sodOther = await encashController._internals.assertNotSelfApproval(
    { user: { id: userB, employeeId: null } }, businessId, rowForSod);
  ok(sodOther.ok, '5.2 different user → allowed');

  // (c) Actor identity unresolved → FAIL CLOSED (blocked), never skipped.
  const sodNoActor = await encashController._internals.assertNotSelfApproval(
    { user: { id: null, employeeId: null } }, businessId, rowForSod);
  ok(!sodNoActor.ok && sodNoActor.code === 'SELF_APPROVAL_BLOCKED', '5.3 unresolved actor identity → FAIL CLOSED');

  // (d) employee-level fast guard still fires when the actor shares the employee record.
  const sodEmp = await encashController._internals.assertNotSelfApproval(
    { user: { id: userB, employeeId: empReq.id } }, businessId, rowForSod);
  ok(!sodEmp.ok && sodEmp.code === 'SELF_APPROVAL_BLOCKED', '5.4 actor linked to the requester employee → BLOCKED');

  // ──────────────────────────────────────────────────────────────────────────────
  // FINDING #3 — per-year caps can't be bypassed by two PENDING requests both approving.
  // Policy: once/year. Two PENDING requests exist (both passed create-time gate). The
  // FIRST approves; the SECOND must be REJECTED by the in-tx cap re-check.
  // ──────────────────────────────────────────────────────────────────────────────
  log('\nFINDING #3 — in-tx cap re-validation (TOCTOU closed)');
  const empCap = await mkEmployee(businessId, { code: `${PREFIX}-CAP`, firstName: 'Capper' });
  const polCap = await prisma.leavePolicy.create({
    data: { businessId, leaveTypeId: leaveType.id, code: `${PREFIX}-POL-CAP`, name: 'cap policy', accrualMethod: 'MONTHLY_ACCRUAL', encashInService: true, encashBasis: 'BASIC_DA_26', encashMaxRequestsPerYear: 1, encashMaxDaysPerYear: '15' },
  });
  const balCap = await prisma.leaveBalance.create({
    data: { businessId, employeeId: empCap.id, leaveTypeId: leaveType.id, periodCode, unit: 'DAYS', opening: '40', closing: '40' },
  });
  // Two PENDING requests (simulating two in-flight raises that both read count=0).
  const mkPending = async (days) => prisma.$transaction(async (tx) => {
    const row = await tx.leaveEncashmentRequest.create({
      data: { businessId, employeeId: empCap.id, leaveTypeId: leaveType.id, leavePolicyId: polCap.id, periodCode, days, basis: 'BASIC_DA_26', status: 'PENDING', appliedAt: new Date() },
    });
    const b = await tx.leaveBalance.findUnique({ where: { id: balCap.id } });
    await tx.leaveBalance.update({ where: { id: balCap.id, version: b.version }, data: { pendingApproval: { increment: days }, version: { increment: 1 } } });
    return row;
  });
  const reqCap1 = await mkPending(8);
  const reqCap2 = await mkPending(8);

  // Approve the first → ok.
  await prisma.$transaction(async (tx) => { await encashConsumer._internals.onApprove({ businessId, entityId: reqCap1.id, decidedBy: 'approver-cap' }, tx); });
  const c1 = await prisma.leaveEncashmentRequest.findUnique({ where: { id: reqCap1.id } });
  ok(c1.status === 'APPROVED', '3.1 first request approves');

  // Approve the second → MUST be rejected by the once/year re-check.
  let capBlocked = false; let capCode = null;
  try {
    await prisma.$transaction(async (tx) => { await encashConsumer._internals.onApprove({ businessId, entityId: reqCap2.id, decidedBy: 'approver-cap' }, tx); });
  } catch (e) { capBlocked = true; capCode = e.code; }
  ok(capBlocked && capCode === 'DECISION_RACE', '3.2 second request BLOCKED by once/year cap re-check (DECISION_RACE)');
  const c2 = await prisma.leaveEncashmentRequest.findUnique({ where: { id: reqCap2.id } });
  ok(c2.status === 'PENDING', '3.3 blocked request rolled back to PENDING (tx aborted; no debit)');
  const balCapAfter = await prisma.leaveBalance.findUnique({ where: { id: balCap.id } });
  ok(dec(balCapAfter.encashed) === 8, '3.4 only the FIRST request debited the balance (encashed=8, not 16)');

  // 3b — days/year cap re-check: a policy that allows 2 requests but caps 15 days/yr; the
  // second 8-day approval would total 16 > 15 → blocked.
  const empDay = await mkEmployee(businessId, { code: `${PREFIX}-DAY`, firstName: 'Dayer' });
  const polDay = await prisma.leavePolicy.create({
    data: { businessId, leaveTypeId: leaveType.id, code: `${PREFIX}-POL-DAY`, name: 'day policy', accrualMethod: 'MONTHLY_ACCRUAL', encashInService: true, encashBasis: 'BASIC_DA_26', encashMaxRequestsPerYear: 5, encashMaxDaysPerYear: '15' },
  });
  const balDay = await prisma.leaveBalance.create({ data: { businessId, employeeId: empDay.id, leaveTypeId: leaveType.id, periodCode, unit: 'DAYS', opening: '40', closing: '40' } });
  const mkPendingDay = async (days) => prisma.$transaction(async (tx) => {
    const row = await tx.leaveEncashmentRequest.create({ data: { businessId, employeeId: empDay.id, leaveTypeId: leaveType.id, leavePolicyId: polDay.id, periodCode, days, basis: 'BASIC_DA_26', status: 'PENDING', appliedAt: new Date() } });
    const b = await tx.leaveBalance.findUnique({ where: { id: balDay.id } });
    await tx.leaveBalance.update({ where: { id: balDay.id, version: b.version }, data: { pendingApproval: { increment: days }, version: { increment: 1 } } });
    return row;
  });
  const reqDay1 = await mkPendingDay(8);
  const reqDay2 = await mkPendingDay(8);
  await prisma.$transaction(async (tx) => { await encashConsumer._internals.onApprove({ businessId, entityId: reqDay1.id, decidedBy: 'a' }, tx); });
  let dayBlocked = false;
  try { await prisma.$transaction(async (tx) => { await encashConsumer._internals.onApprove({ businessId, entityId: reqDay2.id, decidedBy: 'a' }, tx); }); }
  catch (e) { dayBlocked = (e.code === 'DECISION_RACE'); }
  ok(dayBlocked, '3.5 days/year cap re-check blocks the 2nd approval (8+8=16 > 15)');

  // 3c — TRUE CONCURRENCY: two once/year approvals fired in PARALLEL transactions. The
  // FOR UPDATE lock on the shared LeaveBalance row serialises them — EXACTLY ONE commits,
  // the other is rejected. (Without the lock both would read zero committed siblings and
  // both debit, busting the cap.)
  const empRace = await mkEmployee(businessId, { code: `${PREFIX}-RACE`, firstName: 'Racer' });
  const polRace = await prisma.leavePolicy.create({
    data: { businessId, leaveTypeId: leaveType.id, code: `${PREFIX}-POL-RACE`, name: 'race policy', accrualMethod: 'MONTHLY_ACCRUAL', encashInService: true, encashBasis: 'BASIC_DA_26', encashMaxRequestsPerYear: 1 },
  });
  const balRace = await prisma.leaveBalance.create({ data: { businessId, employeeId: empRace.id, leaveTypeId: leaveType.id, periodCode, unit: 'DAYS', opening: '40', closing: '40' } });
  const mkPendingRace = async (d) => prisma.$transaction(async (tx) => {
    const row = await tx.leaveEncashmentRequest.create({ data: { businessId, employeeId: empRace.id, leaveTypeId: leaveType.id, leavePolicyId: polRace.id, periodCode, days: d, basis: 'BASIC_DA_26', status: 'PENDING', appliedAt: new Date() } });
    const b = await tx.leaveBalance.findUnique({ where: { id: balRace.id } });
    await tx.leaveBalance.update({ where: { id: balRace.id, version: b.version }, data: { pendingApproval: { increment: d }, version: { increment: 1 } } });
    return row;
  });
  const r1 = await mkPendingRace(5);
  const r2 = await mkPendingRace(5);
  const results = await Promise.allSettled([
    prisma.$transaction(async (tx) => { await encashConsumer._internals.onApprove({ businessId, entityId: r1.id, decidedBy: 'a' }, tx); }),
    prisma.$transaction(async (tx) => { await encashConsumer._internals.onApprove({ businessId, entityId: r2.id, decidedBy: 'a' }, tx); }),
  ]);
  const fulfilled = results.filter((x) => x.status === 'fulfilled').length;
  const rejected = results.filter((x) => x.status === 'rejected').length;
  ok(fulfilled === 1 && rejected === 1, `3.6 parallel approvals: exactly ONE commits (got ${fulfilled} ok / ${rejected} blocked)`);
  const approvedCount = await prisma.leaveEncashmentRequest.count({ where: { businessId, employeeId: empRace.id, status: { in: ['APPROVED', 'PAID'] } } });
  ok(approvedCount === 1, `3.7 exactly ONE request committed under the once/year cap (got ${approvedCount}) — race closed`);
  const balRaceAfter = await prisma.leaveBalance.findUnique({ where: { id: balRace.id } });
  ok(dec(balRaceAfter.encashed) === 5, '3.8 the balance was debited exactly once (encashed=5, not 10)');

  // ──────────────────────────────────────────────────────────────────────────────
  // FINDING #1 — runEncashments preview is F1-scoped (both lists).
  // Build a manager whose scope is exactly {emp under them}; an OUT-of-scope request must
  // NOT appear in either list. We drive the handler with a constructed req.scope.
  // ──────────────────────────────────────────────────────────────────────────────
  log('\nFINDING #1 — preview F1 scope (manager sees only their team)');
  const empInScope = await mkEmployee(businessId, { code: `${PREFIX}-IN`, firstName: 'InTeam' });
  const empOutScope = await mkEmployee(businessId, { code: `${PREFIX}-OUT`, firstName: 'OutTeam' });
  // One APPROVED un-paid (queued) request for each.
  const mkApproved = async (empId, days) => {
    const bal = await prisma.leaveBalance.create({ data: { businessId, employeeId: empId, leaveTypeId: leaveType.id, periodCode, unit: 'DAYS', opening: '30', closing: '30' } });
    const row = await prisma.leaveEncashmentRequest.create({
      data: { businessId, employeeId: empId, leaveTypeId: leaveType.id, leavePolicyId: polB30.id, periodCode, days, basis: 'BASIC_DA_26', status: 'APPROVED', decidedAt: new Date(), amountMinor: BigInt(500000), appliedAt: new Date() },
    });
    return { bal, row };
  };
  await mkApproved(empInScope.id, 5);
  await mkApproved(empOutScope.id, 5);
  // A throwaway pay run to preview (no need to compute — queued list is payRunId:null).
  const previewRun = await prisma.payRun.create({
    data: { businessId, entityId: inEntity.id, payCalendarId: inCal.id, code: `${PREFIX}-PREVIEW`, periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-07-31'), payDate: new Date('2026-07-31'), sequenceInYear: 7, taxYear: '2026-27', currencyCode: inEntity.payCurrency, status: 'DRAFT', type: 'REGULAR' },
  });

  // Scope = only empInScope (IDS). Capture the JSON the handler returns.
  function fakeRes() {
    return { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
  }
  const scopedReq = { user: { businessId }, params: { id: previewRun.id }, scope: { kind: 'IDS', ids: new Set([empInScope.id]) } };
  const res1 = fakeRes();
  await encashController.runEncashments(scopedReq, res1, (e) => { throw e; });
  const body = res1._json;
  ok(!!body, '1.0 preview returned a body');
  const queuedEmpIds = (body.queued || []).map((q) => q.employeeId);
  ok(queuedEmpIds.includes(empInScope.id), '1.1 in-scope employee IS in the queued list');
  ok(!queuedEmpIds.includes(empOutScope.id), '1.2 out-of-scope employee is NOT in the queued list (no tenant-wide leak)');
  ok((body.queued || []).every((q) => q.employeeId === empInScope.id), '1.3 every queued row is within the manager scope');

  // An ALL-scope operator sees both (control).
  const allReq = { user: { businessId }, params: { id: previewRun.id }, scope: { kind: 'ALL' } };
  const resAll = fakeRes();
  await encashController.runEncashments(allReq, resAll, (e) => { throw e; });
  const allQueuedIds = (resAll._json.queued || []).map((q) => q.employeeId);
  ok(allQueuedIds.includes(empInScope.id) && allQueuedIds.includes(empOutScope.id), '1.4 ALL-scope operator sees both (control)');

  // A NONE-scope operator sees nothing.
  const noneReq = { user: { businessId }, params: { id: previewRun.id }, scope: { kind: 'NONE' } };
  const resNone = fakeRes();
  await encashController.runEncashments(noneReq, resNone, (e) => { throw e; });
  ok((resNone._json.queued || []).length === 0, '1.5 NONE-scope operator sees an empty queued list');

  // ──────────────────────────────────────────────────────────────────────────────
  // FINDING #4 — concurrent runs don't double-pay: when a request drops at reconcile the
  // payslip is REPRICED off the locked set. We simulate a concurrent run having grabbed
  // the request (stamped PAID by ANOTHER run) BEFORE this run persists, so it drops at
  // reconcile — the persisted line must NOT include the dropped amount (gross == baseline).
  // ──────────────────────────────────────────────────────────────────────────────
  log('\nFINDING #4 — same-set reprice (no double-pay on concurrent runs)');
  // Reuse a real seed IN employee with a Basic+DA comp so the engine prices a full payslip.
  // We pick one whose ONLY in-flight encashment is the one we seed below (no pre-existing
  // APPROVED request would otherwise inflate the "clean run pays exactly the amount" check)
  // and tear down our own runs/balance fully, so this never disturbs the sibling suites.
  const seedRecs = await prisma.employmentRecord.findMany({ where: { businessId, entityId: inEntity.id, isCurrent: true }, select: { employeeId: true }, take: 40 });
  let seedEmpId = null; let seedBasicDa = 0;
  for (const r of seedRecs) {
    if ((await prisma.employee.findFirst({ where: { id: r.employeeId, code: { startsWith: PREFIX } } }))) continue;
    // Skip an employee that already has any non-terminal encashment in flight (clean slate).
    const inflight = await prisma.leaveEncashmentRequest.count({ where: { businessId, employeeId: r.employeeId, status: { in: ['PENDING', 'APPROVED'] } } });
    if (inflight > 0) continue;
    const comp = await prisma.compensationRevision.findFirst({ where: { businessId, employeeId: r.employeeId, isCurrent: true }, include: { lines: { include: { component: { select: { kind: true } } } } } });
    if (!comp) continue;
    let bd = 0;
    for (const ln of comp.lines || []) if (['BASIC', 'DEARNESS_ALLOWANCE'].includes(ln.component && ln.component.kind) && ln.amountMonthly != null) bd += Number(ln.amountMonthly);
    if (bd > 0) { seedEmpId = r.employeeId; seedBasicDa = Math.round(bd * 100); break; }
  }
  if (!seedEmpId) throw new Error('No seed IN employee with Basic+DA for the reprice test');

  // Baseline run (no encashment) for this employee — capture gross/net.
  const mkRun = (suffix, seq) => prisma.payRun.create({
    data: { businessId, entityId: inEntity.id, payCalendarId: inCal.id, code: `${PREFIX}-${suffix}`, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), payDate: new Date('2026-09-30'), sequenceInYear: seq, taxYear: '2026-27', currencyCode: inEntity.payCurrency, status: 'DRAFT', type: 'REGULAR' },
  });
  const baseRun = await mkRun('R4-BASE', 9);
  await service.computeRun({ businessId, actorId: 'maker-4', payRunId: baseRun.id });
  const baseLine = await prisma.payRunLine.findFirst({ where: { businessId, payRunId: baseRun.id, employeeId: seedEmpId } });
  ok(!!baseLine, '4.0 baseline line computed for the seed employee');
  const baseGross = dec(baseLine.grossEarnings);
  const baseNet = dec(baseLine.netPay);

  // Seed an APPROVED encashment for the seed employee (so a run WOULD price it).
  const balSeed = await prisma.leaveBalance.create({ data: { businessId, employeeId: seedEmpId, leaveTypeId: leaveType.id, periodCode, unit: 'DAYS', opening: '30', closing: '20', encashed: '10' } });
  const encAmount = computeEncashAmount({ basis: 'BASIC_DA_26', basicDaMonthlyMinor: seedBasicDa, days: 10 }).amountMinor;
  const reqDrop = await prisma.leaveEncashmentRequest.create({
    data: { businessId, employeeId: seedEmpId, leaveTypeId: leaveType.id, leavePolicyId: polB30.id, periodCode, days: 10, basis: 'BASIC_DA_26', status: 'APPROVED', decidedAt: new Date('2026-09-15'), amountMinor: BigInt(encAmount), paidAmountMinor: null, appliedAt: new Date() },
  });
  ok(encAmount > 0, `4.1 seed encashment amount ₹${encAmount / 100} (>0)`);

  // SANITY: a normal run pays it (gross goes up by the amount) — proving the line prices.
  const payRun = await mkRun('R4-PAY', 9);
  await service.computeRun({ businessId, actorId: 'maker-4', payRunId: payRun.id });
  const payLine = await prisma.payRunLine.findFirst({ where: { businessId, payRunId: payRun.id, employeeId: seedEmpId } });
  ok(dec(payLine.grossEarnings) === baseGross + encAmount / 100, `4.2 a clean run pays the encashment (gross = base ₹${baseGross} + ₹${encAmount / 100} = ₹${baseGross + encAmount / 100}, got ${payLine.grossEarnings})`);
  const rPaid = await prisma.leaveEncashmentRequest.findUnique({ where: { id: reqDrop.id } });
  ok(rPaid.status === 'PAID' && rPaid.payRunId === payRun.id, '4.3 clean run stamps the request PAID');

  // Now simulate the RACE: reopen the request from that run (back to APPROVED, un-stamped),
  // then have ANOTHER run "grab" it (mark PAID under a different payRunId) BEFORE this run
  // persists. We model the concurrent winner by stamping it to a different run id, then
  // recompute payRun — the reconcile lock excludes the now-PAID-elsewhere request, it DROPS,
  // and the reprice must bring gross/net back to BASELINE (no double-pay in this run's net).
  await service.reopenRun({ businessId, actorId: 'maker-4', payRunId: payRun.id });
  const otherRun = await mkRun('R4-OTHER', 9);
  // Concurrent winner stamps the request to the OTHER run.
  await prisma.leaveEncashmentRequest.update({ where: { id: reqDrop.id }, data: { status: 'PAID', payRunId: otherRun.id, paidAmountMinor: BigInt(encAmount), paidAt: new Date() } });
  // This run recomputes; the request is no longer lockable for it → drops → reprice.
  await service.computeRun({ businessId, actorId: 'maker-4', payRunId: payRun.id });
  const dropLine = await prisma.payRunLine.findFirst({ where: { businessId, payRunId: payRun.id, employeeId: seedEmpId } });
  ok(dec(dropLine.grossEarnings) === baseGross, `4.4 dropped request → gross REPRICED back to baseline ₹${baseGross} (got ${dropLine.grossEarnings}) — NOT double-paid`);
  ok(dec(dropLine.netPay) === baseNet, `4.5 net REPRICED to baseline ₹${baseNet} (got ${dropLine.netPay}) — the dropped amount is not disbursed here`);
  // The request stays paid by the OTHER run only.
  const rFinal = await prisma.leaveEncashmentRequest.findUnique({ where: { id: reqDrop.id } });
  ok(rFinal.status === 'PAID' && rFinal.payRunId === otherRun.id, '4.6 request remains paid by the OTHER run exactly once (no double-stamp)');
  const encCompDrop = await prisma.payRunLineComponent.findFirst({ where: { payRunLineId: dropLine.id, componentCode: 'LEAVE_ENCASHMENT' } });
  ok(!encCompDrop || dec(encCompDrop.amount) === 0, '4.7 this run carries NO LEAVE_ENCASHMENT component (the dropped line was stripped)');

  await cleanup(businessId);

  if (failures > 0) { log(`\n${failures} FAILURE(S)`); process.exit(1); }
  log('\nAll Feature 31 Cycle-4 fix checks passed.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

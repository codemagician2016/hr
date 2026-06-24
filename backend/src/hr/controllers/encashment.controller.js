'use strict';

/**
 * encashment.controller.js — Feature 31 IN-SERVICE leave encashment request flow.
 *
 * Mirrors leave.controller.js: an employee (ESS) raises a request (PENDING + soft-hold
 * + an F10 ApprovalRequest), an approver clears it (the LEAVE_ENCASHMENT consumer debits
 * the balance via a ENCASHMENT LeaveTransaction inside the engine tx), and the cleared
 * days pay out through the next pay run as a FULLY-TAXABLE earning (the pay pass).
 *
 * Two surfaces share this controller:
 *   • ESS (req.customer)  — raise / list-mine / cancel. SELF_ONLY: the employee is
 *     resolved from the session; no employeeId is ever accepted from a path/body.
 *   • Operator (req.user) — list (F1-scoped) / approve / reject + the pay-run preview.
 *
 * The §10(10AA) exit exemption is NEVER applied here (it is EXIT-only); the payout is a
 * positive taxable EARNING. §89(1) relief is surfaced as an FYI, computed elsewhere.
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');
const { resolvePolicy } = require('../leave/policyResolver');
const { fyPeriodCode } = require('../leave/periodCode');
const ledger = require('../leave/ledger');
const { validateEncashRequest, computeEncashAmount } = require('../leave/encashment/encashment');
const engine = require('../approvals/engine');
const encashConsumer = require('../approvals/consumers.encashment');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');

// Map the guarded-transition races to a 409 (mirror leave.controller#isDecisionRace).
function isDecisionRace(e) {
  return e && (e.code === 'DECISION_RACE' || e.code === 'P2025' || e.code === 'CONCURRENT_UPDATE');
}

function serializeRequest(r) {
  if (!r) return r;
  const toNum = (v) => (v == null ? null : Number(v));
  return {
    ...r,
    days: toNum(r.days),
    basicDaMonthlyMinor: r.basicDaMonthlyMinor == null ? null : Number(r.basicDaMonthlyMinor),
    perDayMinor: r.perDayMinor == null ? null : Number(r.perDayMinor),
    amountMinor: r.amountMinor == null ? null : Number(r.amountMinor),
    paidAmountMinor: r.paidAmountMinor == null ? null : Number(r.paidAmountMinor),
  };
}

/**
 * resolveEncashContext — the employee/employment/policy/balance/period the request
 * draws from, scoped to the request's period (the SAME scheme accrualRunner mints
 * balances under). asOf drives the period code + the window month. Returns null parts
 * the caller turns into 404s.
 */
async function resolveEncashContext({ businessId, employeeId, leaveTypeId, asOf, db = prisma }) {
  const employee = await db.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, businessId: true, managerEmployeeId: true, departmentId: true, gradeId: true },
  });
  if (!employee) return { employee: null };

  const employment = await db.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: { entityId: true, departmentId: true, gradeId: true, entity: { select: { taxYearStartMonth: true } } },
  });
  const taxYearStartMonth = (employment && employment.entity && employment.entity.taxYearStartMonth) || 4;
  const periodCode = fyPeriodCode(asOf, taxYearStartMonth);

  const leaveType = await db.leaveType.findFirst({
    where: { id: leaveTypeId, businessId, deletedAt: null },
    select: { id: true, code: true, name: true, isEncashable: true, unit: true },
  });

  const empForPolicy = {
    id: employeeId,
    businessId,
    entityId: employment ? employment.entityId : null,
    departmentId: employment ? employment.departmentId : null,
    gradeId: employment ? employment.gradeId : null,
  };
  const policy = leaveType
    ? await resolvePolicy(empForPolicy, leaveTypeId, asOf, { tx: db })
    : null;

  // Period-scoped balance, with the newest-row fallback (mirror leaveContext).
  const periodBalance = await db.leaveBalance.findFirst({ where: { businessId, employeeId, leaveTypeId, periodCode } });
  const newestBalance = periodBalance
    ? null
    : await db.leaveBalance.findFirst({ where: { businessId, employeeId, leaveTypeId }, orderBy: { createdAt: 'desc' } });
  const balance = periodBalance || newestBalance;

  return {
    employee, employment, leaveType, policy, balance,
    periodCode: balance ? balance.periodCode : periodCode,
    departmentId: empForPolicy.departmentId,
    gradeId: empForPolicy.gradeId,
  };
}

// Σ days already committed this period (APPROVED or PAID) + the count of non-rejected
// requests this period — feed the yearly-cap / requests-per-year gates.
async function yearToDateUsage({ businessId, employeeId, leaveTypeId, periodCode, db = prisma }) {
  const rows = await db.leaveEncashmentRequest.findMany({
    where: { businessId, employeeId, leaveTypeId, periodCode, status: { in: ['PENDING', 'APPROVED', 'PAID'] } },
    select: { days: true, status: true },
  });
  let alreadyEncashedThisYearDays = 0;
  for (const r of rows) {
    if (r.status === 'APPROVED' || r.status === 'PAID') alreadyEncashedThisYearDays += Number(r.days);
  }
  // requestsThisYear counts every non-terminal-rejected/cancelled request (PENDING
  // counts so two in-flight requests can't both pass the once/year gate).
  const requestsThisYear = rows.length;
  return { alreadyEncashedThisYearDays, requestsThisYear };
}

/**
 * createEncashmentRequest — the shared raise path. Validates against policy, places the
 * pendingApproval soft-hold (so the same days can't be double-spent between request and
 * approval — mirrors a leave application's hold), and opens the F10 ApprovalRequest, all
 * in ONE tx. Returns { status, body } for the route to send.
 */
async function createEncashmentRequest({ businessId, employeeId, leaveTypeId, days, reason, decidedBy = null }) {
  const asOf = new Date();
  const ctx = await resolveEncashContext({ businessId, employeeId, leaveTypeId, asOf });
  if (!ctx.employee) return { status: 404, body: { message: 'Employee not found' } };
  if (!ctx.leaveType) return { status: 404, body: { message: 'Leave type not found' } };
  if (!ctx.balance) return { status: 422, body: { message: 'No leave balance to encash for this type/period', reason: 'INSUFFICIENT_BALANCE' } };

  const { alreadyEncashedThisYearDays, requestsThisYear } = await yearToDateUsage({
    businessId, employeeId, leaveTypeId, periodCode: ctx.periodCode,
  });

  // Apply the policy grain (e.g. 0.5) at the request boundary, then validate (pure).
  const grain = (ctx.policy && ctx.policy.compOffConfig && 0) || 0.5; // EL uses the 0.5 grain
  const reqDays = ledger.roundToGrain(Number(days), grain);
  const verdict = validateEncashRequest({
    balance: ctx.balance,
    policy: ctx.policy || {},
    leaveType: ctx.leaveType,
    request: { days: reqDays },
    alreadyEncashedThisYearDays,
    requestsThisYear,
    asOfMonth: asOf.getMonth() + 1,
  });
  if (!verdict.ok) {
    return { status: 422, body: { message: verdict.reason, reason: verdict.code } };
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.leaveEncashmentRequest.create({
        data: {
          businessId,
          employeeId,
          leaveTypeId,
          leavePolicyId: ctx.policy ? ctx.policy.id : null,
          periodCode: ctx.periodCode,
          days: reqDays,
          basis: (ctx.policy && ctx.policy.encashBasis) || 'BASIC_DA_26',
          reason: reason || null,
          status: 'PENDING',
          appliedAt: new Date(),
        },
      });
      // Soft-hold the requested days (version-optimistic; a racing apply/encash that
      // read the same balance fails P2025 → 409 and retries against the reduced available).
      await tx.leaveBalance.update({
        where: { id: ctx.balance.id, version: ctx.balance.version },
        data: { pendingApproval: { increment: reqDays }, version: { increment: 1 } },
      });
      // Open the F10 approval request in the SAME tx (after the hold). For a zero-config
      // tenant this resolves the BUILT_IN_DEFAULT LEAVE_ENCASHMENT chain (manager → escalate).
      await engine.openRequest({
        businessId,
        module: 'LEAVE_ENCASHMENT',
        entityType: 'LeaveEncashmentRequest',
        entityId: row.id,
        requesterEmployeeId: employeeId,
        payload: {
          leaveType: ctx.leaveType.code,
          leaveTypeId,
          days: Number(reqDays),
          periodCode: ctx.periodCode,
          reason: reason || null,
          taxable: true, // surfaced to the approver: this payout is fully taxable
        },
        ctx: {
          entityId: row.id,
          days: Number(reqDays),
          departmentId: ctx.departmentId || null,
          employeeLevel: ctx.gradeId || null,
        },
      }, tx);
      return row;
    });

    const fresh = await prisma.leaveEncashmentRequest.findUnique({ where: { id: created.id } });
    return { status: 201, body: serializeRequest(fresh) };
  } catch (e) {
    if (e && e.code === 'P2025') {
      return { status: 409, body: { message: 'Balance changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' } };
    }
    throw e;
  }
}

// driveTerminal — the single seam approve/reject/cancel use. Drives the F10 engine
// (which fires the LEAVE_ENCASHMENT consumer inside its own tx), trusting the route's
// RBAC + scope as the authorization boundary (systemActor), mirroring leave.controller.
async function driveTerminal({ businessId, requestId, decision, decidedBy, reason }) {
  const open = await prisma.approvalRequest.findFirst({
    where: { businessId, module: 'LEAVE_ENCASHMENT', entityType: 'LeaveEncashmentRequest', entityId: requestId, status: { in: ['PENDING', 'ESCALATED'] } },
  });
  if (open) {
    if (decision === 'CANCELLED') {
      await engine.cancel({ approvalRequestId: open.id, actorUserId: decidedBy || 'REQUESTER', comment: reason || null });
    } else {
      await prisma.approvalRequest.update({ where: { id: open.id }, data: { decidedBy: decidedBy || null } });
      await engine.recordDecision({ approvalRequestId: open.id, actorUserId: decidedBy || 'SYSTEM', decision, comment: reason || null, systemActor: true });
    }
    return prisma.leaveEncashmentRequest.findUnique({ where: { id: requestId } });
  }
  // Direct path (no engine request — a directly-created row). Run the consumer core in one tx.
  const hook = decision === 'APPROVED' ? 'onApprove' : decision === 'REJECTED' ? 'onReject' : 'onCancel';
  return prisma.$transaction(async (tx) => {
    await encashConsumer._internals[hook]({ businessId, entityId: requestId, decidedBy: decidedBy || null }, tx);
    return tx.leaveEncashmentRequest.findUnique({ where: { id: requestId } });
  });
}

// ── ESS (req.customer) ───────────────────────────────────────────────────────

async function resolveActiveSelfId(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true, isActive: true } });
  if (!emp || emp.isActive === false) return null;
  return emp.id;
}

// POST /me/leave/encashment — ESS raise.
async function meCreate(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.status(404).json({ message: 'No active employee record for this account' });
    const { businessId } = req.customer;
    const { leaveTypeId, days, reason } = req.body || {};
    if (!leaveTypeId || days == null) return res.status(400).json({ message: 'leaveTypeId and days are required' });
    const out = await createEncashmentRequest({ businessId, employeeId, leaveTypeId, days, reason });
    return res.status(out.status).json(out.body);
  } catch (e) { next(e); }
}

// GET /me/leave/encashment — ESS list-mine.
async function meList(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.json({ items: [] });
    const { businessId } = req.customer;
    const rows = await prisma.leaveEncashmentRequest.findMany({
      where: { businessId, employeeId },
      include: { leaveType: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return res.json({ items: rows.map(serializeRequest) });
  } catch (e) { next(e); }
}

// POST /me/leave/encashment/:id/cancel — ESS withdraw while PENDING.
async function meCancel(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.status(404).json({ message: 'No active employee record for this account' });
    const { businessId } = req.customer;
    const row = await prisma.leaveEncashmentRequest.findFirst({ where: { id: req.params.id, businessId, employeeId } });
    if (!row) return res.status(404).json({ message: 'Request not found' });
    if (row.status !== 'PENDING') return res.status(409).json({ message: `Cannot cancel a ${row.status} request`, reason: 'NOT_PENDING' });
    const updated = await driveTerminal({ businessId, requestId: row.id, decision: 'CANCELLED', decidedBy: employeeId });
    return res.json(serializeRequest(updated));
  } catch (e) {
    if (isDecisionRace(e)) return res.status(409).json({ message: 'Request changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    next(e);
  }
}

// ── Operator (req.user) ──────────────────────────────────────────────────────

// GET /leave/encashment — operator list, F1-scoped to the actor's sub-tree.
async function adminList(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (req.query.status) where.status = req.query.status;
    if (req.query.leaveTypeId) where.leaveTypeId = req.query.leaveTypeId;
    if (req.query.periodCode) where.periodCode = req.query.periodCode;
    if (req.query.employeeId) {
      if (!scopeAllows(req.scope, req.query.employeeId)) return res.json({ items: [], total: 0 });
      where.employeeId = req.query.employeeId;
    }
    const take = Math.min(Number(req.query.pageSize) || 50, 200);
    const [rows, total] = await Promise.all([
      prisma.leaveEncashmentRequest.findMany({
        where,
        include: { leaveType: { select: { code: true, name: true } }, employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      prisma.leaveEncashmentRequest.count({ where }),
    ]);
    return res.json({ items: rows.map(serializeRequest), total, pageSize: take });
  } catch (e) { next(e); }
}

// Load a PENDING request for a decision, enforcing F1 scope (out-of-scope ⇒ 404, IDOR-safe).
async function loadPendingForDecision(req, res, businessId) {
  const row = await prisma.leaveEncashmentRequest.findFirst({ where: { id: req.params.id, businessId } });
  if (!row || !scopeAllows(req.scope, row.employeeId)) { res.status(404).json({ message: 'Request not found' }); return null; }
  if (row.status !== 'PENDING') { res.status(409).json({ message: `Request is ${row.status}, not PENDING`, reason: 'NOT_PENDING' }); return null; }
  return row;
}

// POST /leave/encashment/:id/approve — debit the balance + queue payout.
async function adminApprove(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await loadPendingForDecision(req, res, businessId);
    if (!row) return;
    // SoD: an approver may never approve their own encashment.
    const actorEmployeeId = req.user.employeeId || null;
    if (actorEmployeeId && actorEmployeeId === row.employeeId) {
      return res.status(403).json({ message: 'You cannot approve your own encashment request', reason: 'SELF_APPROVAL_BLOCKED' });
    }
    const decidedBy = req.user.id || req.user.userId || null;
    const updated = await driveTerminal({ businessId, requestId: row.id, decision: 'APPROVED', decidedBy });
    return res.json(serializeRequest(updated));
  } catch (e) {
    if (isDecisionRace(e)) return res.status(409).json({ message: 'Request changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    next(e);
  }
}

// POST /leave/encashment/:id/reject — release the hold; no debit.
async function adminReject(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await loadPendingForDecision(req, res, businessId);
    if (!row) return;
    const decidedBy = req.user.id || req.user.userId || null;
    const updated = await driveTerminal({ businessId, requestId: row.id, decision: 'REJECTED', decidedBy, reason: (req.body && req.body.reason) || null });
    return res.json(serializeRequest(updated));
  } catch (e) {
    if (isDecisionRace(e)) return res.status(409).json({ message: 'Request changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    next(e);
  }
}

// GET /payroll/runs/:id/encashments — preview the requests a run will pay / has paid.
async function runEncashments(req, res, next) {
  try {
    const { businessId } = req.user;
    const payRunId = req.params.id;
    const run = await prisma.payRun.findFirst({ where: { id: payRunId, businessId }, select: { id: true } });
    if (!run) return res.status(404).json({ message: 'Pay run not found' });
    // Paid by this run (stamped) + still-queued APPROVED requests (un-paid) the next
    // run would pay; the preparer sees what rides this payslip before disburse.
    const [paid, queued] = await Promise.all([
      prisma.leaveEncashmentRequest.findMany({
        where: { businessId, payRunId, status: 'PAID' },
        include: { leaveType: { select: { code: true, name: true } }, employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
        orderBy: { decidedAt: 'asc' },
      }),
      prisma.leaveEncashmentRequest.findMany({
        where: { businessId, status: 'APPROVED', payRunId: null },
        include: { leaveType: { select: { code: true, name: true } }, employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
        orderBy: { decidedAt: 'asc' },
      }),
    ]);
    const sum = (rows) => rows.reduce((acc, r) => acc + Number(r.amountMinor || 0), 0);
    return res.json({
      paid: paid.map(serializeRequest),
      queued: queued.map(serializeRequest),
      paidTotalMinor: sum(paid),
      queuedTotalMinor: sum(queued),
      taxable: true,
    });
  } catch (e) { next(e); }
}

module.exports = {
  // shared
  createEncashmentRequest,
  resolveEncashContext,
  yearToDateUsage,
  // ESS
  meCreate, meList, meCancel,
  // operator
  adminList, adminApprove, adminReject, runEncashments,
};

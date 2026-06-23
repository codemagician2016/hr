'use strict';

/**
 * meLeave.controller.js — Employee Self-Service (ESS) leave API, mounted at
 * /api/hr/me/leave. CUSTOMER session (req.customer); the subject employee is
 * resolved ENTIRELY from the session, so there is NO employeeId accepted from the
 * client — applying, listing balances/requests and cancelling are all SELF_ONLY.
 *
 * The ESS leave page was previously pointed at the operator surface
 * (/api/hr/leave/*), which is operator-JWT-only and 401s for a customer session
 * (audit #54/#55). This surface authenticates the customer session, derives
 * employeeId server-side, and reuses the SAME pure leave engine the operator path
 * uses (calendar netting, policy validators, the soft-hold ledger), so the ESS
 * and operator apply/cancel rules agree exactly.
 *
 * Terminated/inactive employees are locked out (404).
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');
const { computeLeaveUnits, consecutiveCalendarDays } = require('../leave/calendar');
const { validateRequest } = require('../leave/validators');
const { loadApplyContext } = require('../leave/leaveContext');
const ledger = require('../leave/ledger');

// 409 reason codes that map to a conflict rather than a 400 (balance/overlap).
const CONFLICT_CODES = new Set(['INSUFFICIENT_BALANCE', 'NEGATIVE_CAP_EXCEEDED', 'OVERLAPPING_LEAVE']);

function toDate(v) {
  const s = typeof v === 'string' ? v : new Date(v).toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00.000Z`);
}

// Resolve the signed-in customer to their ACTIVE Employee (id). Returns the id or
// null (terminated/soft-deleted/inactive → null = ESS lockout). The employee id
// is NEVER taken from the request body.
async function resolveActiveSelfId(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, isActive: true },
  });
  if (!emp || emp.isActive === false) return null;
  return emp.id;
}

const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// ── GET /me/leave/types — leave types the employee may apply for ──────────────
async function listTypes(req, res, next) {
  try {
    const { businessId } = req.customer;
    const items = await prisma.leaveType.findMany({
      where: { businessId, deletedAt: null, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, code: true, name: true, category: true, unit: true,
        isPaid: true, requiresReason: true, color: true,
      },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// ── GET /me/leave/balances — own current leave balances (+ available) ─────────
async function listBalances(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.json({ items: [] });
    const { businessId } = req.customer;
    const where = { businessId, employeeId };
    if (req.query.leaveTypeId) where.leaveTypeId = req.query.leaveTypeId;
    if (req.query.periodCode) where.periodCode = req.query.periodCode;

    const rows = await prisma.leaveBalance.findMany({
      where,
      include: { leaveType: { select: { id: true, code: true, name: true, category: true, unit: true, color: true } } },
      orderBy: [{ leaveTypeId: 'asc' }, { periodCode: 'desc' }],
    });
    // Surface available = closing − pendingApproval so the ESS card renders the
    // right number (the §9.7 bug); the raw buckets stay for the breakdown.
    const items = rows.map((b) => ({ ...b, available: ledger.available(b, {}) }));
    res.json({ items });
  } catch (e) { next(e); }
}

// ── GET /me/leave/requests?status= — own leave applications ───────────────────
async function listRequests(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.json({ items: [], total: 0, page: 1, pageSize: 50 });
    const { businessId } = req.customer;
    const { status } = req.query;
    const take = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * take;

    const where = { businessId, employeeId, txnType: 'APPLICATION' };
    if (status) where.status = status;
    const [items, total] = await Promise.all([
      prisma.leaveTransaction.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take,
        include: { leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } } },
      }),
      prisma.leaveTransaction.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

// ── POST /me/leave/requests — apply for leave (self) ──────────────────────────
// Reuses the operator apply engine verbatim (working-day netting, policy gates,
// soft-hold ledger) but the employeeId is the SESSION's, never the body's.
async function applyForLeave(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const { leaveTypeId, startDate, endDate } = req.body || {};
    if (!leaveTypeId || !startDate || !endDate) {
      return res.status(400).json({ message: 'leaveTypeId, startDate and endDate are required' });
    }
    const startHalf = (req.body && req.body.startHalf) || null;
    const endHalf = (req.body && req.body.endHalf) || null;
    const isAdvance = req.body && req.body.isAdvance === true;
    const asOf = new Date();

    const ctx = await loadApplyContext({ businessId, employeeId, leaveTypeId, startDate, endDate, asOf });
    if (!ctx.employee) return res.status(404).json({ message: 'Employee not found' });
    if (!ctx.leaveType) return res.status(404).json({ message: 'Leave type not found' });

    const netted = computeLeaveUnits(
      { startDate, endDate, startHalf, endHalf },
      { employee: ctx.employee, leaveType: ctx.leaveType, weeklyOffDays: ctx.weeklyOffDays, holidays: ctx.holidays },
    );
    const units = netted.units;
    if (units == null || units <= 0) {
      return res.status(400).json({ message: 'The request spans no working days (or endDate precedes startDate)' });
    }

    const verdict = validateRequest({
      request: { startDate, endDate, startHalf, endHalf, reason: req.body.reason },
      units,
      consecutiveDays: consecutiveCalendarDays({ startDate, endDate }),
      policy: ctx.policy,
      leaveType: ctx.leaveType,
      balance: ctx.balance,
      employee: ctx.employee,
      overlapping: ctx.overlapping,
      asOf,
      isAdvance,
    });
    if (!verdict.ok) {
      const first = verdict.errors[0];
      const status = CONFLICT_CODES.has(first.code) ? 409 : 400;
      return res.status(status).json({ message: first.message, reason: first.code, errors: verdict.errors });
    }

    const balance = ctx.balance;
    const start = toDate(startDate);
    const end = toDate(endDate);

    const txn = await prisma.$transaction(async (tx) => {
      const created = await tx.leaveTransaction.create({
        data: {
          businessId,
          employeeId,
          leaveTypeId,
          leaveBalanceId: balance ? balance.id : null,
          txnType: 'APPLICATION',
          unit: ctx.leaveType.unit,
          quantity: -units,
          startDate: start,
          endDate: end,
          startHalf,
          endHalf,
          reason: (req.body && req.body.reason) || null,
          status: 'PENDING',
          appliedAt: new Date(),
        },
      });
      if (balance) {
        await tx.leaveBalance.update({
          where: { id: balance.id, version: balance.version },
          data: { pendingApproval: { increment: units }, version: { increment: 1 } },
        });
      }
      return created;
    });

    res.status(201).json({ ...txn, dayBreakdown: netted.dayBreakdown, units });
  } catch (e) {
    if (e && e.code === 'P2025') {
      return res.status(409).json({ message: 'Balance changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// ── POST /me/leave/requests/:id/cancel — withdraw own PENDING request ─────────
// SELF_ONLY: the request must belong to the caller (employeeId === self), else
// 404 (IDOR-safe). Releases the soft-hold under the version optimistic-lock.
async function cancelRequest(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.status(404).json({ message: 'Leave request not found' });
    const { businessId } = req.customer;

    const txn = await prisma.leaveTransaction.findFirst({
      where: { id: req.params.id, businessId, employeeId, txnType: 'APPLICATION' },
    });
    if (!txn) return res.status(404).json({ message: 'Leave request not found' });
    if (txn.status !== 'PENDING') {
      return res.status(409).json({ message: `Cannot withdraw a request in status ${txn.status}` });
    }

    const heldQty = Math.abs(Number(txn.quantity));
    const decidedBy = req.customer.id || null;

    const updated = await prisma.$transaction(async (tx) => {
      // Conditionally flip the status — a 0-rowcount means a racing decision
      // already moved it (→ 409, whole tx rolls back).
      const flip = await tx.leaveTransaction.updateMany({
        where: { id: txn.id, status: 'PENDING' },
        data: { status: 'CANCELLED', decidedAt: new Date(), decidedBy },
      });
      if (flip.count === 0) {
        const err = new Error('DECISION_RACE');
        err.code = 'DECISION_RACE';
        throw err;
      }
      // Release the soft-hold (floored, version-locked) when a balance is bound.
      if (txn.leaveBalanceId) {
        const bal = await tx.leaveBalance.findFirst({ where: { id: txn.leaveBalanceId, businessId } });
        if (bal) {
          const release = Math.min(Number(bal.pendingApproval), heldQty);
          await tx.leaveBalance.update({
            where: { id: bal.id, version: bal.version },
            data: { pendingApproval: { decrement: release }, version: { increment: 1 } },
          });
        }
      }
      return tx.leaveTransaction.findUnique({ where: { id: txn.id } });
    });

    res.json(updated);
  } catch (e) {
    if (e && (e.code === 'DECISION_RACE' || e.code === 'P2025')) {
      return res.status(409).json({ message: 'Request changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

module.exports = {
  listTypes,
  listBalances,
  listRequests,
  applyForLeave,
  cancelRequest,
};

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
const { buildHistory } = require('../leave/history');

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

// Feature 16 — ESS pay-reduction ESTIMATE for an LWP application. Best-effort and
// clearly labelled an estimate (the payslip is authoritative). Reduction ≈
// currentMonthlyGross × lwpUnits ÷ standardDays, where standardDays follows the
// entity's prorationBasis (CALENDAR_DAYS default = days in the leave's month).
// Returns null when no current compensation is on file (nothing to estimate from).
async function estimateLwpReduction(businessId, employeeId, units, startDate) {
  try {
    const employment = await prisma.employmentRecord.findFirst({
      where: { businessId, employeeId, isCurrent: true },
      select: { entityId: true, entity: { select: { prorationBasis: true, payCurrency: true } } },
    });
    const comp = await prisma.compensationRevision.findFirst({
      where: { businessId, employeeId, isCurrent: true },
      select: { grossMonthly: true, ctcAnnual: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!comp) return null;
    let grossMonthly = comp.grossMonthly != null ? Number(comp.grossMonthly) : null;
    if (grossMonthly == null && comp.ctcAnnual != null) grossMonthly = Number(comp.ctcAnnual) / 12;
    if (!grossMonthly || grossMonthly <= 0) return null;

    const d = startDate instanceof Date ? startDate : new Date(startDate);
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const basis = employment && employment.entity ? employment.entity.prorationBasis : null;
    let standardDays = daysInMonth;
    if (basis === 'THIRTY_DAY_STANDARD') standardDays = 30;
    // WORKING_DAYS estimate is approximated by calendar days here (the exact
    // working-day denominator is only known at freeze); CALENDAR_DAYS is the default.

    const perDay = grossMonthly / standardDays;
    const reduction = Math.round(perDay * units * 100) / 100;
    return {
      estimate: true,
      currency: (employment && employment.entity && employment.entity.payCurrency) || null,
      reductionAmount: reduction,
      perDayAmount: Math.round(perDay * 100) / 100,
      days: units,
      standardDays,
      note: 'Estimate only — your payslip is authoritative.',
    };
  } catch (_e) {
    return null; // estimate is non-critical; never block the apply
  }
}

// ── GET /me/leave/types — leave types the employee may apply for ──────────────
async function listTypes(req, res, next) {
  try {
    const { businessId } = req.customer;
    const items = await prisma.leaveType.findMany({
      where: { businessId, deletedAt: null, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, code: true, name: true, category: true, unit: true,
        isPaid: true, affectsLOP: true, requiresReason: true, color: true,
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
      // Feature 30 — comp-off lots feed the COMP_OFF_WOULD_BE_EXPIRED gate (null for
      // every other type, so the gate is inert). The per-day breakdown drives the
      // per-day FIFO expiry check (finding #4) so a multi-day span can't avail a lot
      // that expires mid-span.
      compOffLots: ctx.compOffLots,
      compOffDays: ctx.leaveType.category === 'COMP_OFF' ? netted.dayBreakdown : null,
    });
    if (!verdict.ok) {
      const first = verdict.errors[0];
      const status = CONFLICT_CODES.has(first.code) ? 409 : 400;
      return res.status(status).json({ message: first.message, reason: first.code, errors: verdict.errors });
    }

    // Feature 16 — LWP / UNPAID applies with NO balance (no row to draw/hold). Take
    // the no-balance branch explicitly: leaveBalanceId=null, no soft-hold, quantity
    // retained for audit. An UNPAID apply must NEVER touch a LeaveBalance.
    const isUnpaidLwp = ctx.leaveType.category === 'UNPAID' || ctx.leaveType.affectsLOP === true;
    const balance = isUnpaidLwp ? null : ctx.balance;
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
      // F10 — EVERY ESS leave application routes through the approval engine
      // (module LEAVE, built-in default chain = reporting manager), so the
      // manager's approvals inbox — mobile app, web ESS and operator console —
      // actually receives it; consumers.leave flips the transaction + moves the
      // soft-hold on decision. Previously only COMP_OFF routed here: a plain
      // EL/SL/CL self-apply created a stranded PENDING row that NO inbox ever
      // saw (found by the Feature-40 end-to-end audit). Mirrors the operator
      // createRequest engine.openRequest call shape exactly.
      {
        const engine = require('../approvals/engine');
        await engine.openRequest({
          businessId,
          module: 'LEAVE',
          entityType: 'LeaveTransaction',
          entityId: created.id,
          requesterEmployeeId: created.employeeId,
          payload: { leaveType: ctx.leaveType.code, leaveTypeId, startDate, endDate, days: units, reason: (req.body && req.body.reason) || null },
          ctx: {
            entityId: created.id, days: units,
            departmentId: (ctx.employee && ctx.employee.departmentId) || null,
            employeeLevel: (ctx.employee && ctx.employee.gradeId) || null,
          },
        }, tx);
      }
      return created;
    });

    // Feature 16 — ESS LWP pay-reduction ESTIMATE (labelled an estimate; the payslip
    // is authoritative). Reduction ≈ currentMonthlyGross × units ÷ standardDays.
    const payEstimate = isUnpaidLwp ? await estimateLwpReduction(businessId, employeeId, units, start) : null;

    res.status(201).json({ ...txn, dayBreakdown: netted.dayBreakdown, units, unpaid: isUnpaidLwp, payEstimate });
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

    // F10 — withdraw the engine request too (AFTER the authoritative flip: the
    // consumer's onCancel is tolerant of the already-CANCELLED transaction, and
    // cancelling clears the request from every approver inbox). Best-effort.
    try {
      const openReq = await prisma.approvalRequest.findFirst({
        where: { businessId, module: 'LEAVE', entityId: txn.id, status: 'PENDING' },
        select: { id: true },
      });
      if (openReq) {
        const engine = require('../approvals/engine');
        await engine.cancel({ approvalRequestId: openReq.id, actorUserId: 'SYSTEM', comment: 'Withdrawn by employee' });
      }
    } catch (_e) { /* the flip above is authoritative */ }

    res.json(updated);
  } catch (e) {
    if (e && (e.code === 'DECISION_RACE' || e.code === 'P2025')) {
      return res.status(409).json({ message: 'Request changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// ── GET /me/leave/history — own leave history (every movement + request) ──────
// SELF_ONLY: the subject is resolved from the session, never the client. Returns
// the employee's ENTIRE LeaveTransaction ledger (applications AND accrual / lapse
// / encashment / adjustment movements), shaped into a chronological, plain-English
// feed with signed deltas + a running balance. Optional ?leaveTypeId / ?periodCode
// narrows the feed; a terminated/inactive employee gets an empty feed (lockout).
async function listHistory(req, res, next) {
  try {
    const paged = req.query.page !== undefined || req.query.pageSize !== undefined;
    const take = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.json(paged ? { items: [], total: 0, page, pageSize: take } : { items: [] });
    const { businessId } = req.customer;

    const where = { businessId, employeeId };
    if (req.query.leaveTypeId) where.leaveTypeId = req.query.leaveTypeId;
    // periodCode scopes via the bound balance lot (movements carry leaveBalanceId).
    if (req.query.periodCode) {
      const lots = await prisma.leaveBalance.findMany({
        where: { businessId, employeeId, periodCode: req.query.periodCode },
        select: { id: true },
      });
      where.leaveBalanceId = { in: lots.map((l) => l.id) };
    }

    const rows = await prisma.leaveTransaction.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 1000,
      include: { leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } } },
    });
    // newest-first for display; the running balance is computed oldest→newest inside.
    // The running balance MUST be derived from the full chronological ledger, so we
    // build the entire feed first, then (only when the caller asks for a page) slice
    // the requested window. No-params callers get the full feed exactly as before.
    const full = buildHistory(rows).reverse();
    if (!paged) return res.json({ items: full });
    const total = full.length;
    const start = (page - 1) * take;
    res.json({ items: full.slice(start, start + take), total, page, pageSize: take });
  } catch (e) { next(e); }
}

module.exports = {
  listTypes,
  listBalances,
  listRequests,
  listHistory,
  applyForLeave,
  cancelRequest,
};

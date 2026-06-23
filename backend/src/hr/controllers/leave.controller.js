'use strict';
// Leave management. Three concerns, one tenant boundary (req.user.businessId):
//   (a) Config CRUD — LeaveType + LeavePolicy (soft-deleted, version-stamped).
//   (b) Request flow — a leave REQUEST is a LeaveTransaction row of
//       txnType=APPLICATION moving through the LeaveTxnStatus state machine
//       PENDING -> APPROVED | REJECTED | CANCELLED. The ledger is APPEND-ONLY:
//       we never delete a row and never rewrite its signed `quantity`; a
//       decision only flips `status`/`decidedAt`/`decidedBy` on the application
//       row and posts the balance effect.
//   (c) Balance read — LeaveBalance is the persisted running balance with a
//       soft-hold (`pendingApproval`) reconstructable from the ledger.
// Every query is scoped by businessId; an employee's rows also filter employeeId.
const prisma = require('../../core/lib/prisma');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const { resolveApprover } = require('../lib/approvalRouting');
const { computeLeaveUnits, consecutiveCalendarDays } = require('../leave/calendar');
const { validateRequest } = require('../leave/validators');
const ledger = require('../leave/ledger');
const { loadApplyContext } = require('../leave/leaveContext');
const { runCarryForward } = require('../leave/accrualRunner');

// ── Config allow-lists (never spread req.body) ──────────────────────────────
const LEAVE_TYPE_FIELDS = [
  'countryCode', 'code', 'name', 'category', 'unit', 'isPaid', 'isStatutory',
  'nzPayBasis', 'requiresReason', 'affectsLOP', 'isEncashable', 'sandwichPolicy',
  'color', 'isActive',
];
const LEAVE_POLICY_FIELDS = [
  'leaveTypeId', 'entityId', 'code', 'name', 'accrualMethod', 'entitlementPerYear',
  'accrualFrequency', 'accrualProrateOnJoin', 'carryForwardCap', 'carryForwardExpiryMonths',
  'maxBalanceCap', 'maxConsecutive', 'minNoticeDays', 'allowNegative', 'negativeCap',
  'minTenureMonths', 'appliesToEmploymentTypes', 'genderRestriction', 'encashOnExit',
  'encashFormula', 'maxEncashCap', 'workflowDefinitionId', 'isActive',
];

const DUP_MSG = 'A record with that code already exists';

function picker(fields, dates = []) {
  return (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    for (const d of dates) if (out[d] != null) out[d] = new Date(out[d]);
    return out;
  };
}

// ── Config CRUD factory (LeaveType, LeavePolicy) ────────────────────────────
// Mirrors org.controller's crud(): tenant-scoped, soft-deleted, P2002 -> 409.
function configCrud(model, { fields, required = [] }) {
  const pick = picker(fields);
  return {
    list: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const items = await prisma[model].findMany({
          where: { businessId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        });
        res.json({ items });
      } catch (e) { next(e); }
    },
    get: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const item = await prisma[model].findFirst({
          where: { id: req.params.id, businessId, deletedAt: null },
        });
        if (!item) return res.status(404).json({ message: 'Not found' });
        res.json(item);
      } catch (e) { next(e); }
    },
    create: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        for (const r of required) {
          if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
            return res.status(400).json({ message: `${r} is required` });
          }
        }
        const item = await prisma[model].create({ data: { ...pick(req.body), businessId } });
        res.status(201).json(item);
      } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
    },
    update: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const existing = await prisma[model].findFirst({
          where: { id: req.params.id, businessId, deletedAt: null },
        });
        if (!existing) return res.status(404).json({ message: 'Not found' });
        const item = await prisma[model].update({ where: { id: req.params.id }, data: pick(req.body) });
        res.json(item);
      } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
    },
    remove: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const existing = await prisma[model].findFirst({
          where: { id: req.params.id, businessId, deletedAt: null },
        });
        if (!existing) return res.status(404).json({ message: 'Not found' });
        await prisma[model].update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
        res.status(204).end();
      } catch (e) { next(e); }
    },
  };
}

const leaveTypes = configCrud('leaveType', {
  fields: LEAVE_TYPE_FIELDS,
  required: ['code', 'name', 'category'],
});
const leavePolicies = configCrud('leavePolicy', {
  fields: LEAVE_POLICY_FIELDS,
  required: ['leaveTypeId', 'code', 'name', 'accrualMethod'],
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE REQUEST FLOW  (LeaveTransaction, txnType = APPLICATION)
// State machine over LeaveTxnStatus: PENDING -> APPROVED | REJECTED | CANCELLED.
// ─────────────────────────────────────────────────────────────────────────────

// 409 reason codes that map to a conflict rather than a 400 (balance/overlap).
const CONFLICT_CODES = new Set(['INSUFFICIENT_BALANCE', 'NEGATIVE_CAP_EXCEEDED', 'OVERLAPPING_LEAVE']);

function toDate(v) {
  // accept "YYYY-MM-DD" (Zod-validated) → midnight-UTC @db.Date
  const s = typeof v === 'string' ? v : new Date(v).toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00.000Z`);
}

// POST /requests — employee applies for leave. Working-day-aware (calendar.js,
// reusing the attendance derive.js resolvers so leave & attendance agree on a
// working day), policy-gated (validators.js), overlap-checked, then creates a
// PENDING APPLICATION ledger row (signed −units) and soft-holds the units on the
// balance's pendingApproval bucket. Append-only; the ledger is the source of truth.
async function createRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, leaveTypeId, startDate, endDate } = req.body;
    if (!employeeId || !leaveTypeId || !startDate || !endDate) {
      return res.status(400).json({ message: 'employeeId, leaveTypeId, startDate and endDate are required' });
    }

    const startHalf = req.body.startHalf || null;
    const endHalf = req.body.endHalf || null;
    const isAdvance = req.body.isAdvance === true;
    const asOf = new Date();

    // Assemble the context the pure engines need (employee/shift/holidays/policy/
    // balance/overlap). Mirrors attendance/service.js resolution.
    const ctx = await loadApplyContext({ businessId, employeeId, leaveTypeId, startDate, endDate, asOf });
    if (!ctx.employee) return res.status(404).json({ message: 'Employee not found' });
    if (!ctx.leaveType) return res.status(404).json({ message: 'Leave type not found' });

    // Working-day netting (replaces the naive spanDays that charged weekends/holidays).
    const netted = computeLeaveUnits(
      { startDate, endDate, startHalf, endHalf },
      { employee: ctx.employee, leaveType: ctx.leaveType, weeklyOffDays: ctx.weeklyOffDays, holidays: ctx.holidays },
    );
    const units = netted.units;
    if (units == null || units <= 0) {
      return res.status(400).json({ message: 'The request spans no working days (or endDate precedes startDate)' });
    }

    // Policy gates → structured reason codes.
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
          quantity: -units, // signed: application consumes balance
          startDate: start,
          endDate: end,
          startHalf,
          endHalf,
          reason: req.body.reason || null,
          status: 'PENDING',
          appliedAt: new Date(),
        },
      });
      // Soft-hold the requested units so concurrent requests see them reserved.
      // version optimistic-lock: a concurrent apply that raced our read fails and
      // retries against the reduced available (QA 11).
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
    // optimistic-lock miss (P2025) → the balance moved under us; tell the client to retry.
    if (e && e.code === 'P2025') {
      return res.status(409).json({ message: 'Balance changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// GET /requests — paginated list of APPLICATION rows, tenant-scoped; optional
// employeeId / status / leaveTypeId filters.
//
// Feature 1: the list is filtered to the actor's reporting sub-tree via
// scopeWhere(req.scope, 'employeeId'). A client-supplied ?employeeId is NEVER
// trusted to widen scope — it is only honored when that employee is already in
// the actor's scope; otherwise the request returns empty (closes the audited IDOR).
async function listRequests(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, status, leaveTypeId, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;

    // AND the hierarchical scope (Manager → their reporting sub-tree only).
    const where = { businessId, txnType: 'APPLICATION', ...scopeWhere(req.scope, 'employeeId') };
    if (employeeId) {
      // Only honor a client-supplied employeeId when it is within scope; otherwise
      // return an empty result set rather than widening access.
      if (!scopeAllows(req.scope, employeeId)) {
        return res.json({ items: [], total: 0, page: pageNum, pageSize: take });
      }
      where.employeeId = employeeId;
    }
    if (leaveTypeId) where.leaveTypeId = leaveTypeId;
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.leaveTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.leaveTransaction.count({ where }),
    ]);
    res.json({ items, total, page: pageNum, pageSize: take });
  } catch (e) { next(e); }
}

async function getRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await prisma.leaveTransaction.findFirst({
      where: { id: req.params.id, businessId, txnType: 'APPLICATION' },
    });
    if (!txn) return res.status(404).json({ message: 'Leave request not found' });
    // Feature 1: out-of-scope applicant → 404 (IDOR-safe; don't reveal existence).
    if (!scopeAllows(req.scope, txn.employeeId)) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    res.json(txn);
  } catch (e) { next(e); }
}

// Shared guard + balance-release for terminal transitions. Returns the loaded
// PENDING application row, or sends the appropriate error response.
//
// Feature 1: `enforceScope` (set for approve/reject) re-resolves the decision
// scope server-side. The canApproveLeave scope excludes the actor (separation of
// duties) and is bounded to their reporting sub-tree, so an out-of-scope
// applicant — a peer, someone outside the team, or the approver themselves — is
// 404'd here (IDOR-safe; never trust a client-supplied employeeId to widen scope).
async function loadPendingApplication(req, res, businessId, { enforceScope = false } = {}) {
  const txn = await prisma.leaveTransaction.findFirst({
    where: { id: req.params.id, businessId, txnType: 'APPLICATION' },
  });
  if (!txn) { res.status(404).json({ message: 'Leave request not found' }); return null; }
  if (enforceScope && !scopeAllows(req.scope, txn.employeeId)) {
    res.status(404).json({ message: 'Leave request not found' });
    return null;
  }
  if (txn.status !== 'PENDING') {
    res.status(409).json({ message: `Cannot transition a request in status ${txn.status}` });
    return null;
  }
  return txn;
}

// POST /requests/:id/approve — PENDING -> APPROVED. Moves the soft-hold into
// `taken` and decrements `closing`. The ledger row is NOT rewritten beyond its
// terminal status + decision metadata (append-only invariant preserved).
async function approveRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await loadPendingApplication(req, res, businessId, { enforceScope: true });
    if (!txn) return;

    // Feature 1 (approval routing): the canonical approver for this application is
    // the applicant's manager (escalating up the chain to an HR-Admin fallback).
    // The scope guard above already proved this actor is allowed to act on the
    // applicant's sub-tree and is not the applicant (SoD); resolveApprover is the
    // single source of truth for *who* the request routes to (used by the ESS
    // inbox + notifications). We surface it as decision provenance, not a second
    // gate — the sub-tree scope is the authoritative authorization boundary.
    const applicant = await prisma.employee.findFirst({
      where: { id: txn.employeeId, businessId, deletedAt: null },
      select: { id: true, managerEmployeeId: true, businessId: true },
    });
    await resolveApprover(applicant); // eslint-disable-line no-unused-vars — provenance/guard hook

    const heldQty = Math.abs(Number(txn.quantity));
    const decidedBy = req.user.id || req.user.userId || null;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.leaveTransaction.update({
        where: { id: txn.id },
        data: { status: 'APPROVED', decidedAt: new Date(), decidedBy },
      });
      if (txn.leaveBalanceId) {
        // Release the hold and post the consumption; closing is the persisted
        // derived figure (opening+accrued-taken-encashed-lapsed+/-adjusted).
        await tx.leaveBalance.update({
          where: { id: txn.leaveBalanceId },
          data: {
            pendingApproval: { decrement: heldQty },
            taken: { increment: heldQty },
            closing: { decrement: heldQty },
          },
        });
      }
      return row;
    });

    res.json(updated);
  } catch (e) { next(e); }
}

// POST /requests/:id/reject — PENDING -> REJECTED. Releases the soft-hold; no
// units are consumed.
async function rejectRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await loadPendingApplication(req, res, businessId, { enforceScope: true });
    if (!txn) return;

    const heldQty = Math.abs(Number(txn.quantity));
    const decidedBy = req.user.id || req.user.userId || null;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.leaveTransaction.update({
        where: { id: txn.id },
        data: { status: 'REJECTED', decidedAt: new Date(), decidedBy, reason: req.body.reason || txn.reason },
      });
      if (txn.leaveBalanceId) {
        await tx.leaveBalance.update({
          where: { id: txn.leaveBalanceId },
          data: { pendingApproval: { decrement: heldQty } },
        });
      }
      return row;
    });

    res.json(updated);
  } catch (e) { next(e); }
}

// POST /requests/:id/cancel — PENDING -> CANCELLED (withdrawal before decision).
// Releases the soft-hold.
async function cancelRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await loadPendingApplication(req, res, businessId);
    if (!txn) return;

    const heldQty = Math.abs(Number(txn.quantity));
    const decidedBy = req.user.id || req.user.userId || null;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.leaveTransaction.update({
        where: { id: txn.id },
        data: { status: 'CANCELLED', decidedAt: new Date(), decidedBy },
      });
      if (txn.leaveBalanceId) {
        await tx.leaveBalance.update({
          where: { id: txn.leaveBalanceId },
          data: { pendingApproval: { decrement: heldQty } },
        });
      }
      return row;
    });

    res.json(updated);
  } catch (e) { next(e); }
}

// ── Balance read ────────────────────────────────────────────────────────────
// GET /employees/:employeeId/balances — current leave balances for an employee,
// scoped by businessId + employeeId. Optional leaveTypeId / periodCode filters.
async function listEmployeeBalances(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, businessId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const where = { businessId, employeeId };
    if (req.query.leaveTypeId) where.leaveTypeId = req.query.leaveTypeId;
    if (req.query.periodCode) where.periodCode = req.query.periodCode;

    const rows = await prisma.leaveBalance.findMany({
      where,
      include: { leaveType: { select: { id: true, code: true, name: true, category: true, unit: true, color: true } } },
      orderBy: [{ leaveTypeId: 'asc' }, { periodCode: 'desc' }],
    });
    // Surface `available = closing − pendingApproval` so the ESS card no longer
    // has to guess at a non-existent key (the §9.7 bug). The raw buckets stay so
    // the breakdown (opening/accrued/taken/pendingApproval/lapsed) renders too.
    const items = rows.map((b) => ({
      ...b,
      available: ledger.available(b, {}),
    }));
    res.json({ items });
  } catch (e) { next(e); }
}

// ── (NEW endpoints, §4.8) ────────────────────────────────────────────────────

// GET /me/requests — ESS self-list of own requests. employeeId from the
// attachSelfEmployee anchor; never widened by a client-supplied id (no scope).
async function listMyRequests(req, res, next) {
  try {
    const { businessId } = req.user;
    const employeeId = req.user.employeeId;
    if (!employeeId) return res.json({ items: [], total: 0, page: 1, pageSize: 25 });
    const { status, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;

    const where = { businessId, employeeId, txnType: 'APPLICATION' };
    if (status) where.status = status;
    const [items, total] = await Promise.all([
      prisma.leaveTransaction.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take,
        include: { leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } } },
      }),
      prisma.leaveTransaction.count({ where }),
    ]);
    res.json({ items, total, page: pageNum, pageSize: take });
  } catch (e) { next(e); }
}

// GET /calendar?from&to&entityId&leaveTypeId&includePending — org/team leave
// calendar, scope-filtered server-side (canViewEmployees sub-tree).
async function leaveCalendar(req, res, next) {
  try {
    const { businessId } = req.user;
    const { from, to, leaveTypeId, includePending } = req.query;
    const statuses = includePending === 'true' || includePending === true
      ? ['PENDING', 'APPROVED', 'AVAILED']
      : ['APPROVED', 'AVAILED'];

    const where = {
      businessId, txnType: 'APPLICATION', status: { in: statuses },
      ...scopeWhere(req.scope, 'employeeId'),
    };
    if (leaveTypeId) where.leaveTypeId = leaveTypeId;
    if (from) where.endDate = { gte: new Date(`${from}T00:00:00.000Z`) };
    if (to) where.startDate = { ...(where.startDate || {}), lte: new Date(`${to}T00:00:00.000Z`) };

    const items = await prisma.leaveTransaction.findMany({
      where,
      orderBy: { startDate: 'asc' },
      take: 1000,
      include: {
        leaveType: { select: { id: true, code: true, name: true, color: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// GET /requests/:id/history — per-request audit trail (the application row +
// any reversing ADJUSTMENT it spawned). Scope-guarded (404 if out of sub-tree).
async function requestHistory(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await prisma.leaveTransaction.findFirst({
      where: { id: req.params.id, businessId, txnType: 'APPLICATION' },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
    });
    if (!txn || !scopeAllows(req.scope, txn.employeeId)) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    // reversing/related rows: same employee+type+dates (the ADJUSTMENT from a withdraw)
    const related = await prisma.leaveTransaction.findMany({
      where: {
        businessId, employeeId: txn.employeeId, leaveTypeId: txn.leaveTypeId,
        txnType: { in: ['ADJUSTMENT', 'CANCELLATION'] },
        startDate: txn.startDate, endDate: txn.endDate,
      },
      orderBy: { createdAt: 'asc' },
    });
    const history = [txn, ...related]
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((r) => ({
        id: r.id, txnType: r.txnType, status: r.status, quantity: r.quantity,
        reason: r.reason, appliedAt: r.appliedAt, decidedAt: r.decidedAt, decidedBy: r.decidedBy,
        createdAt: r.createdAt,
      }));
    res.json({ request: txn, history });
  } catch (e) { next(e); }
}

// POST /requests/:id/withdraw — APPROVED → WITHDRAWN. Emits a reversing
// ADJUSTMENT (+units), credits the balance back (taken−, closing+), preserving
// the append-only ledger. Blocked when the covered day sits in a CLOSED pay run
// (payRunId stamped) so closed payroll is never rewritten.
async function withdrawRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await prisma.leaveTransaction.findFirst({
      where: { id: req.params.id, businessId, txnType: 'APPLICATION' },
    });
    if (!txn) return res.status(404).json({ message: 'Leave request not found' });
    // self OR in-scope approver may withdraw; out-of-scope → 404 (IDOR-safe).
    const isSelf = req.user.employeeId && req.user.employeeId === txn.employeeId;
    if (!isSelf && !scopeAllows(req.scope, txn.employeeId)) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    if (txn.status !== 'APPROVED' && txn.status !== 'AVAILED') {
      return res.status(409).json({ message: `Only an approved request can be withdrawn (status: ${txn.status})` });
    }
    if (txn.payRunId) {
      return res.status(422).json({
        message: 'This leave is in a closed pay run; it cannot be withdrawn (settle as a next-period credit)',
        reason: 'PAYRUN_CLOSED',
      });
    }
    const units = Math.abs(Number(txn.quantity));
    const decidedBy = req.user.id || req.user.userId || null;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.leaveTransaction.update({
        where: { id: txn.id },
        data: { status: 'WITHDRAWN', decidedAt: new Date(), decidedBy },
      });
      // Append-only audit marker for the reversal. The WITHDRAWN status flip already
      // removes the application's −units from the closing identity (the ledger
      // reducer scores a non-{APPROVED,AVAILED} APPLICATION as 0), so this row is
      // a zero-quantity CANCELLATION trail — posting +units here would DOUBLE-count
      // the credit and break the §4.2 reconciliation. The balance credit below
      // mirrors exactly the status flip.
      await tx.leaveTransaction.create({
        data: {
          businessId, employeeId: txn.employeeId, leaveTypeId: txn.leaveTypeId,
          leaveBalanceId: txn.leaveBalanceId,
          txnType: 'CANCELLATION', unit: txn.unit, quantity: 0,
          startDate: txn.startDate, endDate: txn.endDate,
          reason: `Withdrawal of approved leave ${txn.id} (+${units} ${txn.unit.toLowerCase()} credited back)`,
          status: 'APPROVED', appliedAt: new Date(), decidedAt: new Date(), decidedBy,
        },
      });
      if (txn.leaveBalanceId) {
        await tx.leaveBalance.update({
          where: { id: txn.leaveBalanceId },
          data: { taken: { decrement: units }, closing: { increment: units }, version: { increment: 1 } },
        });
      }
      return row;
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// POST /balances/adjust — audited manual adjustment → ADJUSTMENT ledger row +
// `adjusted`/`closing` bump. Append-only. canManageOrg gated at the route.
async function adjustBalance(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, leaveTypeId, periodCode, delta, reason } = req.body;
    if (!reason) return res.status(400).json({ message: 'reason is required' });
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return res.status(400).json({ message: 'delta must be a non-zero number' });

    const employee = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    const leaveType = await prisma.leaveType.findFirst({ where: { id: leaveTypeId, businessId, deletedAt: null } });
    if (!leaveType) return res.status(404).json({ message: 'Leave type not found' });

    const out = await prisma.$transaction(async (tx) => {
      const balance = await tx.leaveBalance.upsert({
        where: { businessId_employeeId_leaveTypeId_periodCode: { businessId, employeeId, leaveTypeId, periodCode } },
        update: {},
        create: { businessId, employeeId, leaveTypeId, periodCode, unit: leaveType.unit },
      });
      const row = await tx.leaveTransaction.create({
        data: {
          businessId, employeeId, leaveTypeId, leaveBalanceId: balance.id,
          txnType: 'ADJUSTMENT', unit: leaveType.unit, quantity: d,
          reason, status: 'APPROVED', appliedAt: new Date(), decidedAt: new Date(),
          decidedBy: req.user.id || req.user.userId || null,
        },
      });
      const before = Number(balance.closing);
      const updatedBal = await tx.leaveBalance.update({
        where: { id: balance.id },
        data: { adjusted: { increment: d }, closing: { increment: d }, version: { increment: 1 } },
      });
      return { row, before, after: Number(updatedBal.closing), balance: updatedBal };
    });
    res.status(201).json({ transaction: out.row, before: out.before, after: out.after });
  } catch (e) { next(e); }
}

// POST /runs/carry-forward {periodCode, leaveTypeId?, dryRun} — year-end roll.
// dryRun (default true) writes nothing. canManageOrg gated at the route.
async function carryForwardRun(req, res, next) {
  try {
    const { businessId } = req.user;
    const { periodCode, leaveTypeId, dryRun = true } = req.body;
    if (!periodCode) return res.status(400).json({ message: 'periodCode is required' });
    const result = await runCarryForward({
      businessId, periodCode, leaveTypeId: leaveTypeId || null,
      dryRun: dryRun !== false, actorId: req.user.id || null,
    });
    res.status(dryRun !== false ? 200 : 201).json(result);
  } catch (e) { next(e); }
}

// GET /reports/summary?from&to&entityId&groupBy — aggregate taken/pending/
// balance/LOP, scope-filtered. canViewReports/canManageOrg gated at the route.
async function reportsSummary(req, res, next) {
  try {
    const { businessId } = req.user;
    const { from, to, groupBy = 'type' } = req.query;
    const where = { businessId, txnType: 'APPLICATION', ...scopeWhere(req.scope, 'employeeId') };
    if (from) where.endDate = { gte: new Date(`${from}T00:00:00.000Z`) };
    if (to) where.startDate = { lte: new Date(`${to}T00:00:00.000Z`) };

    const rows = await prisma.leaveTransaction.findMany({
      where,
      include: { leaveType: { select: { id: true, code: true, name: true, affectsLOP: true } } },
    });
    const groups = {};
    for (const r of rows) {
      const key = groupBy === 'type' ? (r.leaveType ? r.leaveType.code : 'UNKNOWN') : r.employeeId;
      const g = groups[key] || (groups[key] = { key, taken: 0, pending: 0, lop: 0, count: 0 });
      const q = Math.abs(Number(r.quantity));
      g.count += 1;
      if (r.status === 'APPROVED' || r.status === 'AVAILED') {
        g.taken += q;
        if (r.leaveType && r.leaveType.affectsLOP) g.lop += q;
      } else if (r.status === 'PENDING') {
        g.pending += q;
      }
    }
    res.json({ groupBy, items: Object.values(groups) });
  } catch (e) { next(e); }
}

module.exports = {
  leaveTypes,
  leavePolicies,
  createRequest,
  listRequests,
  getRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
  withdrawRequest,
  listEmployeeBalances,
  // Feature 6 §4.8 new endpoints
  listMyRequests,
  leaveCalendar,
  requestHistory,
  adjustBalance,
  carryForwardRun,
  reportsSummary,
};

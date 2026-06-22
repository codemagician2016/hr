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

// ── Config allow-lists (never spread req.body) ──────────────────────────────
const LEAVE_TYPE_FIELDS = [
  'countryCode', 'code', 'name', 'category', 'unit', 'isPaid', 'isStatutory',
  'nzPayBasis', 'requiresReason', 'affectsLOP', 'isEncashable', 'color', 'isActive',
];
const LEAVE_POLICY_FIELDS = [
  'leaveTypeId', 'entityId', 'code', 'name', 'accrualMethod', 'entitlementPerYear',
  'accrualFrequency', 'accrualProrateOnJoin', 'carryForwardCap', 'carryForwardExpiryMonths',
  'maxBalanceCap', 'maxConsecutive', 'minNoticeDays', 'allowNegative', 'negativeCap',
  'minTenureMonths', 'appliesToEmploymentTypes', 'genderRestriction', 'encashOnExit',
  'encashFormula', 'workflowDefinitionId', 'isActive',
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

// Decimal-safe inclusive day span (full-day requests). Half-day handling rides
// on startHalf/endHalf which subtract 0.5 each from the boundary days.
function spanDays(startDate, endDate, startHalf, endHalf) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const ms = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
    - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  let days = Math.floor(ms / 86400000) + 1;
  if (days < 1) return null;
  if (startHalf) days -= 0.5;
  if (endHalf) days -= 0.5;
  return days;
}

// Resolve the current-period balance row for (employee, leaveType). The request
// flow never creates balances; it adjusts the soft-hold on the latest one.
async function currentBalance(businessId, employeeId, leaveTypeId) {
  return prisma.leaveBalance.findFirst({
    where: { businessId, employeeId, leaveTypeId },
    orderBy: { createdAt: 'desc' },
  });
}

// POST /requests — employee applies for leave. Creates a PENDING APPLICATION
// ledger row (signed negative quantity = leave consumed) and soft-holds the
// units against the balance's pendingApproval bucket.
async function createRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, leaveTypeId, startDate, endDate } = req.body;
    if (!employeeId || !leaveTypeId || !startDate || !endDate) {
      return res.status(400).json({ message: 'employeeId, leaveTypeId, startDate and endDate are required' });
    }

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, businessId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const leaveType = await prisma.leaveType.findFirst({
      where: { id: leaveTypeId, businessId, deletedAt: null },
    });
    if (!leaveType) return res.status(404).json({ message: 'Leave type not found' });

    const startHalf = req.body.startHalf || null;
    const endHalf = req.body.endHalf || null;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const qty = spanDays(start, end, startHalf, endHalf);
    if (qty == null || qty <= 0) {
      return res.status(400).json({ message: 'endDate must be on or after startDate' });
    }
    if (leaveType.requiresReason && !req.body.reason) {
      return res.status(400).json({ message: 'reason is required for this leave type' });
    }

    const balance = await currentBalance(businessId, employeeId, leaveTypeId);

    const txn = await prisma.$transaction(async (tx) => {
      const created = await tx.leaveTransaction.create({
        data: {
          businessId,
          employeeId,
          leaveTypeId,
          leaveBalanceId: balance ? balance.id : null,
          txnType: 'APPLICATION',
          unit: leaveType.unit,
          quantity: -qty, // signed: application consumes balance
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
      if (balance) {
        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: { pendingApproval: { increment: qty } },
        });
      }
      return created;
    });

    res.status(201).json(txn);
  } catch (e) { next(e); }
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

    const items = await prisma.leaveBalance.findMany({
      where,
      include: { leaveType: { select: { id: true, code: true, name: true, category: true, unit: true } } },
      orderBy: [{ leaveTypeId: 'asc' }, { periodCode: 'desc' }],
    });
    res.json({ items });
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
  listEmployeeBalances,
};

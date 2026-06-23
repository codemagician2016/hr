'use strict';

/**
 * meTeam.controller.js — Feature 13 Manager Self-Service (MSS), mounted at
 * /api/hr/me/team (CUSTOMER session). The customer session is given the SAME F1 scope
 * band the operator path has, via resolveCustomerScope (§4.2): resolve the manager's
 * Employee, read their band, then `resolveAccessibleEmployeeIds` over their reporting
 * sub-tree. EVERY team read/write is scoped to that id-set, ANDed with the tenant wall.
 *
 * Safety (§9):
 *   - The subject is ALWAYS the session employee; no employeeId is accepted from the
 *     client → cross-employee access is structurally impossible (IDOR-safe).
 *   - A non-manager (SELF band) gets their sub-tree minus self = ∅ for approval reads,
 *     or {self} for roster — never another person's data; an IC sees no peers.
 *   - Approval decides resolve with an APPROVAL_ACTIONS action (self dropped), so a
 *     manager can never approve their OWN leave/expense even though it's "their team".
 *   - The directory carries contact-card fields only (no compensation) — comp is
 *     inherently masked for the MSS surface.
 */

const prisma = require('../../core/lib/prisma');
const { resolveCustomerScope } = require('../lib/customerScope');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const engine = require('../approvals/engine');

const EMPTY = (res) => res.json({ items: [], total: 0 });

// Resolve { businessId, userId } for the engine (email → portal User), like meApprovals.
async function callerUserId(businessId, email) {
  if (!email) return null;
  const u = await prisma.user.findFirst({ where: { businessId, email, isActive: true }, select: { id: true } });
  return u ? u.id : null;
}

function fullName(e) { return [e.firstName, e.lastName].filter(Boolean).join(' ') || e.code; }
function dateOnly(x) { return x ? new Date(x).toISOString().slice(0, 10) : null; }

// Build a scopeWhere that EXCLUDES the manager themselves (the "team" = reports, not
// self). `scope` may be ALL/IDS/NONE; we always drop selfId from the rendered roster.
function teamIdsExcludingSelf(scope, selfId) {
  if (!scope || scope.kind === 'NONE') return [];
  if (scope.kind === 'ALL') return null; // ALL handled by caller (no in-list)
  return [...scope.ids].filter((id) => id !== selfId);
}

// ── GET /me/team/roster — direct + indirect reports (Photo|Name|Position|status) ──
async function roster(req, res, next) {
  try {
    const { businessId } = req.customer;
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canViewEmployees');
    if (!employee) return EMPTY(res);
    const ids = teamIdsExcludingSelf(scope, employee.id);
    // SELF band (no reports) → empty team. ALL band (rare for ESS) → whole tenant minus self.
    const where = { businessId, deletedAt: null, id: { not: employee.id } };
    if (ids !== null) { if (ids.length === 0) return EMPTY(res); where.id = { in: ids }; }

    const rows = await prisma.employee.findMany({
      where, orderBy: [{ firstName: 'asc' }], take: 1000,
      select: {
        id: true, code: true, firstName: true, lastName: true, photoUrl: true, status: true, managerEmployeeId: true,
        employmentRecords: { where: { isCurrent: true }, take: 1, select: { designation: { select: { title: true } }, department: { select: { name: true } }, location: { select: { name: true } } } },
      },
    });
    const items = rows.map((e) => {
      const rec = e.employmentRecords && e.employmentRecords[0];
      return {
        id: e.id, code: e.code, name: fullName(e), photoUrl: e.photoUrl || null, status: e.status,
        designation: rec && rec.designation ? rec.designation.title : null,
        department: rec && rec.department ? rec.department.name : null,
        location: rec && rec.location ? rec.location.name : null,
        isDirectReport: e.managerEmployeeId === employee.id,
      };
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// ── GET /me/team/attendance?date= — today's team attendance board ──
async function attendance(req, res, next) {
  try {
    const { businessId } = req.customer;
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canViewEmployees');
    if (!employee) return EMPTY(res);
    const ids = teamIdsExcludingSelf(scope, employee.id);
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

    const where = { businessId, date: day };
    if (ids !== null) { if (ids.length === 0) return res.json({ items: [], date: dateOnly(day) }); where.employeeId = { in: ids }; }
    else where.employeeId = { not: employee.id };

    const rows = await prisma.attendance.findMany({
      where, take: 1000,
      select: { employeeId: true, status: true, firstIn: true, lastOut: true, workedMinutes: true,
        employee: { select: { firstName: true, lastName: true, code: true, photoUrl: true } } },
    });
    const items = rows.map((a) => ({
      employeeId: a.employeeId, name: fullName(a.employee), code: a.employee.code, photoUrl: a.employee.photoUrl || null,
      status: a.status, firstIn: a.firstIn, lastOut: a.lastOut, workedMinutes: a.workedMinutes,
    }));
    res.json({ items, date: dateOnly(day), total: items.length });
  } catch (e) { next(e); }
}

// ── GET /me/team/directory — contact cards (NO compensation; comp masked) ──
async function directory(req, res, next) {
  try {
    const { businessId } = req.customer;
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canViewEmployees');
    if (!employee) return EMPTY(res);
    const ids = teamIdsExcludingSelf(scope, employee.id);
    const q = (req.query.q || '').trim().toLowerCase();
    const where = { businessId, deletedAt: null, id: { not: employee.id } };
    if (ids !== null) { if (ids.length === 0) return EMPTY(res); where.id = { in: ids }; }
    if (q) where.OR = [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }];

    const rows = await prisma.employee.findMany({
      where, orderBy: [{ firstName: 'asc' }], take: 1000,
      select: {
        id: true, code: true, firstName: true, lastName: true, photoUrl: true, workEmail: true, phone: true, officePhone: true,
        employmentRecords: { where: { isCurrent: true }, take: 1, select: { designation: { select: { title: true } }, department: { select: { name: true } } } },
      },
    });
    const items = rows.map((e) => {
      const rec = e.employmentRecords && e.employmentRecords[0];
      return {
        id: e.id, code: e.code, name: fullName(e), photoUrl: e.photoUrl || null,
        email: e.workEmail || null, phone: e.phone || e.officePhone || null,
        designation: rec && rec.designation ? rec.designation.title : null,
        department: rec && rec.department ? rec.department.name : null,
        // NOTE: compensation is intentionally NOT included on the MSS directory (masked).
      };
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// ── GET /me/team/leave/pending — leave awaiting THIS manager's decision (self excluded) ──
async function leavePending(req, res, next) {
  try {
    const { businessId } = req.customer;
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canApproveLeave');
    if (!employee) return EMPTY(res);
    // canApproveLeave drops self from scope (SoD). NONE/empty → [].
    if (scope.kind === 'NONE') return EMPTY(res);
    const where = { businessId, txnType: 'APPLICATION', status: 'PENDING', ...scopeWhere(scope, 'employeeId') };
    const rows = await prisma.leaveTransaction.findMany({
      where, orderBy: { appliedAt: 'desc' }, take: 500,
      select: { id: true, employeeId: true, startDate: true, endDate: true, quantity: true, unit: true, reason: true, appliedAt: true,
        leaveType: { select: { name: true, code: true } }, employee: { select: { firstName: true, lastName: true, code: true, photoUrl: true } } },
    });
    const items = rows.map((t) => ({
      id: t.id, employeeId: t.employeeId, name: fullName(t.employee), code: t.employee.code, photoUrl: t.employee.photoUrl || null,
      leaveType: t.leaveType ? t.leaveType.name : null, startDate: dateOnly(t.startDate), endDate: dateOnly(t.endDate),
      days: Math.abs(Number(t.quantity)), unit: t.unit, reason: t.reason, appliedAt: t.appliedAt,
    }));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// ── GET /me/team/reimbursements/pending — team expense claims awaiting decision ──
async function reimbursementsPending(req, res, next) {
  try {
    const { businessId } = req.customer;
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canApproveLeave');
    if (!employee) return EMPTY(res);
    if (scope.kind === 'NONE') return EMPTY(res);
    const where = { businessId, status: 'SUBMITTED', deletedAt: null, ...scopeWhere(scope, 'employeeId') };
    const rows = await prisma.expenseClaim.findMany({
      where, orderBy: { submittedAt: 'desc' }, take: 500,
      // Feature 11 — surface the policy verdict (the manager's "within / over budget"
      // banner) + the travel id when the claim is booked against a trip.
      select: { id: true, employeeId: true, amount: true, currencyCode: true, description: true, expenseDate: true, submittedAt: true, claimNumber: true,
        claimType: true, policyVerdict: true,
        travelRequest: { select: { travelNumber: true, destCity: true } },
        employee: { select: { firstName: true, lastName: true, code: true, photoUrl: true } } },
    });
    const items = rows.map((c) => ({
      id: c.id, employeeId: c.employeeId, name: fullName(c.employee), code: c.employee.code, photoUrl: c.employee.photoUrl || null,
      amount: Number(c.amount), currencyCode: c.currencyCode, description: c.description, claimNumber: c.claimNumber,
      claimType: c.claimType, policyVerdict: c.policyVerdict,
      travelNumber: c.travelRequest ? c.travelRequest.travelNumber : null,
      destCity: c.travelRequest ? c.travelRequest.destCity : null,
      expenseDate: dateOnly(c.expenseDate), submittedAt: c.submittedAt,
    }));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// ── GET /me/team/approvals — merged inbox (leave + reimbursements) for the nav badge ──
async function approvalsInbox(req, res, next) {
  try {
    // The merged leave+reimbursement inbox, each scoped to the manager's sub-tree.
    const { businessId } = req.customer;
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canApproveLeave');
    if (!employee || scope.kind === 'NONE') return res.json({ leave: [], reimbursements: [], total: 0 });
    const [leave, exp] = await Promise.all([
      prisma.leaveTransaction.findMany({ where: { businessId, txnType: 'APPLICATION', status: 'PENDING', ...scopeWhere(scope, 'employeeId') }, take: 500,
        select: { id: true, employeeId: true, startDate: true, endDate: true, quantity: true, leaveType: { select: { name: true } }, employee: { select: { firstName: true, lastName: true, code: true } } } }),
      prisma.expenseClaim.findMany({ where: { businessId, status: 'SUBMITTED', deletedAt: null, ...scopeWhere(scope, 'employeeId') }, take: 500,
        select: { id: true, employeeId: true, amount: true, currencyCode: true, description: true, employee: { select: { firstName: true, lastName: true, code: true } } } }),
    ]);
    res.json({
      leave: leave.map((t) => ({ id: t.id, name: fullName(t.employee), leaveType: t.leaveType?.name, startDate: dateOnly(t.startDate), endDate: dateOnly(t.endDate), days: Math.abs(Number(t.quantity)) })),
      reimbursements: exp.map((c) => ({ id: c.id, name: fullName(c.employee), amount: Number(c.amount), currencyCode: c.currencyCode, description: c.description })),
      total: leave.length + exp.length,
    });
  } catch (e) { next(e); }
}

// ── POST /me/team/leave/:id/decide — approve/decline a report's leave ──
// Scope + SoD enforced: the leave row must be in the manager's canApproveLeave scope
// (self dropped). The decision drives the existing leave engine path; here we directly
// flip via the F10 engine if an ApprovalRequest backs it, else via the leave controller's
// scope guard. We use the engine for consistency with the operator inbox.
async function leaveDecide(req, res, next) {
  try {
    const { businessId } = req.customer;
    const decision = decisionOf(req);
    if (!decision) return res.status(400).json({ message: 'decision must be approve or decline' });
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canApproveLeave');
    if (!employee || scope.kind === 'NONE') return res.status(404).json({ message: 'Not found' });
    const txn = await prisma.leaveTransaction.findFirst({ where: { id: req.params.id, businessId, txnType: 'APPLICATION' }, select: { id: true, employeeId: true, approvalRequestId: true, status: true } });
    if (!txn || !scopeAllows(scope, txn.employeeId)) return res.status(404).json({ message: 'Not found' });
    if (txn.status !== 'PENDING') return res.status(409).json({ message: `Request is ${txn.status}, not actionable` });

    const userId = await callerUserId(businessId, req.customer.email);
    if (!userId) return res.status(403).json({ message: 'No portal user is linked to this account.' });
    if (!txn.approvalRequestId) return res.status(409).json({ message: 'Leave request has no approval workflow attached' });

    const result = await engine.recordDecision({ approvalRequestId: txn.approvalRequestId, actorUserId: userId, decision: decision === 'approve' ? 'APPROVED' : 'REJECTED', comment: req.body && req.body.comment });
    res.json({ id: txn.id, terminal: result.terminal, status: result.terminal || 'PENDING' });
  } catch (e) {
    if (e && (e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e)))) {
      return res.status(e.statusCode || 409).json({ message: e.message, code: e.code });
    }
    next(e);
  }
}

// ── POST /me/team/reimbursements/:id/decide — approve/decline a report's claim ──
// FLAG (Feature 11 — shared edit): a manager's decision on a report's claim now drives
// the F10 EXPENSE engine when the claim is backed by an open ApprovalRequest (the F11
// submit path opens one), so the admin's configurable chain (manager → finance over
// threshold) + the engine SoD/version/active-step guards govern it — exactly like
// leaveDecide. A legacy claim with no open request keeps the direct version-locked flip.
async function reimbursementDecide(req, res, next) {
  try {
    const { businessId } = req.customer;
    const decision = decisionOf(req);
    if (!decision) return res.status(400).json({ message: 'decision must be approve or decline' });
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canApproveLeave');
    if (!employee || scope.kind === 'NONE') return res.status(404).json({ message: 'Not found' });
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, select: { id: true, employeeId: true, status: true, version: true } });
    if (!claim || !scopeAllows(scope, claim.employeeId)) return res.status(404).json({ message: 'Not found' });
    if (claim.status !== 'SUBMITTED') return res.status(409).json({ message: `Claim is ${claim.status}, not actionable` });

    const userId = await callerUserId(businessId, req.customer.email);

    // Prefer the F10 engine when an open EXPENSE request backs this claim.
    const open = await prisma.approvalRequest.findFirst({
      where: { businessId, module: 'EXPENSE', entityType: 'ExpenseClaim', entityId: claim.id, status: { in: ['PENDING', 'ESCALATED'] } },
      select: { id: true, payloadJson: true },
    });
    if (open) {
      if (!userId) return res.status(403).json({ message: 'No portal user is linked to this account.' });
      if (decision === 'decline' && req.body && req.body.comment) {
        await prisma.approvalRequest.update({ where: { id: open.id }, data: { payloadJson: { ...(open.payloadJson || {}), rejectReason: req.body.comment } } });
      }
      const result = await engine.recordDecision({
        approvalRequestId: open.id, actorUserId: userId,
        decision: decision === 'approve' ? 'APPROVED' : 'REJECTED', comment: req.body && req.body.comment,
      });
      const fresh = await prisma.expenseClaim.findUnique({ where: { id: claim.id }, select: { status: true } });
      return res.json({ id: claim.id, status: fresh ? fresh.status : 'PENDING', terminal: result.terminal });
    }

    // Legacy direct flip (no engine request).
    const toStatus = decision === 'approve' ? 'APPROVED' : 'REJECTED';
    const flip = await prisma.expenseClaim.updateMany({
      where: { id: claim.id, status: 'SUBMITTED', version: claim.version },
      data: { status: toStatus, decidedAt: new Date(), decidedBy: userId || null, version: { increment: 1 }, ...(toStatus === 'REJECTED' ? { rejectReason: (req.body && req.body.comment) || null } : {}) },
    });
    if (flip.count === 0) return res.status(409).json({ message: 'Claim changed concurrently' });
    res.json({ id: claim.id, status: toStatus });
  } catch (e) {
    if (e && (e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e)))) {
      return res.status(e.statusCode || 409).json({ message: e.message, code: e.code });
    }
    next(e);
  }
}

function decisionOf(req) {
  const d = (req.body && (req.body.decision || req.body.action)) || '';
  const s = String(d).toLowerCase();
  if (s === 'approve' || s === 'approved') return 'approve';
  if (s === 'decline' || s === 'reject' || s === 'rejected' || s === 'declined') return 'decline';
  return null;
}

// ── GET /me/team/org?root=me — reporting tree rooted at the manager (scope-filtered) ──
async function org(req, res, next) {
  try {
    const { businessId } = req.customer;
    const { scope, employee } = await resolveCustomerScope(req.customer, 'canViewEmployees');
    if (!employee) return res.json({ items: [], root: null });

    // The accessible id-set (self + sub-tree). ALL band → whole tenant (rare for ESS).
    let accessible = null;
    if (scope.kind === 'IDS') accessible = new Set([...scope.ids, employee.id]);

    const where = { businessId, deletedAt: null };
    if (accessible) where.id = { in: [...accessible] };

    const employees = await prisma.employee.findMany({
      where,
      select: {
        id: true, code: true, firstName: true, lastName: true, photoUrl: true, managerEmployeeId: true,
        employmentRecords: { where: { isCurrent: true }, take: 1, orderBy: { effectiveFrom: 'desc' }, select: { designation: { select: { title: true } }, department: { select: { name: true } } } },
      },
      orderBy: [{ firstName: 'asc' }, { code: 'asc' }],
    });

    const nodeById = new Map();
    for (const e of employees) {
      const rec = e.employmentRecords && e.employmentRecords[0];
      nodeById.set(e.id, {
        id: e.id, code: e.code, name: fullName(e), photoUrl: e.photoUrl || null,
        designation: rec && rec.designation ? rec.designation.title : null,
        departmentName: rec && rec.department ? rec.department.name : null,
        managerEmployeeId: e.managerEmployeeId, reportsCount: 0, children: [],
      });
    }
    for (const node of nodeById.values()) {
      const parent = node.managerEmployeeId ? nodeById.get(node.managerEmployeeId) : null;
      if (parent) { parent.children.push(node); parent.reportsCount += 1; }
    }
    const me = nodeById.get(employee.id) || null;
    res.json({ items: me ? [me] : [], root: employee.id });
  } catch (e) { next(e); }
}

module.exports = {
  roster, attendance, directory, leavePending, reimbursementsPending,
  approvalsInbox, leaveDecide, reimbursementDecide, org,
};

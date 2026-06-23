'use strict';

/**
 * profileChangeAdmin.controller.js — Feature 13 §4.3. HR-admin profile change-request
 * queue (operator session, `protect` + canManageEmployees). The queue is F1-SCOPED:
 * a Manager sees only their sub-tree's requests (withEmployeeScope on the route sets
 * req.scope; we filter ProfileChangeRequest by employeeId ∈ scope).
 *
 * approve/reject drive the SAME F10 engine the leave/expense admin paths use
 * (engine.recordDecision), so the SoD / version / active-step / idempotency guards are
 * identical. The PROFILE_CHANGE consumer applies the field write atomically on approve.
 *
 * SoD (§9): the engine already blocks "actor === requester's user". We add the extra
 * guard that the operator cannot decide a request for THEIR OWN linked employee (an HR
 * operator can't approve their own gated change even though they are an operator).
 */

const prisma = require('../../core/lib/prisma');
const engine = require('../approvals/engine');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const { writeAudit } = require('../../core/lib/audit');

function sendEngineError(res, e) {
  const status = e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e) ? 409 : 500);
  return res.status(status).json({ message: e.message, code: e.code });
}

// Resolve the operator's own linked employee id (for the SoD self-guard). null if the
// operator has no Employee row.
async function operatorEmployeeId(req) {
  if (req.user && req.user.employeeId !== undefined) return req.user.employeeId;
  if (!req.user || !req.user.id) return null;
  const emp = await prisma.employee.findFirst({ where: { userId: req.user.id, businessId: req.user.businessId, deletedAt: null }, select: { id: true } });
  return emp ? emp.id : null;
}

// GET /api/hr/profile/change-requests?status=PENDING — scoped HR queue.
async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const status = req.query.status || 'PENDING';
    const where = {
      businessId,
      ...(status === 'ALL' ? {} : { status }),
      ...scopeWhere(req.scope, 'employeeId'),
    };
    const rows = await prisma.profileChangeRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 500,
      select: {
        id: true, employeeId: true, field: true, oldValue: true, newValue: true, status: true,
        approvalRequestId: true, createdAt: true, decidedAt: true, decidedBy: true,
        employee: { select: { id: true, code: true, firstName: true, lastName: true } },
      },
    });
    const items = rows.map((r) => ({
      id: r.id,
      employee: { id: r.employee.id, code: r.employee.code, name: [r.employee.firstName, r.employee.lastName].filter(Boolean).join(' ') },
      field: r.field, oldValue: r.oldValue, newValue: r.newValue, status: r.status,
      approvalRequestId: r.approvalRequestId, createdAt: r.createdAt, decidedAt: r.decidedAt,
    }));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// Shared loader: fetch the CR, enforce tenant + scope + the self-SoD guard.
async function loadDecidable(req, res) {
  const { businessId } = req.user;
  const cr = await prisma.profileChangeRequest.findFirst({
    where: { id: req.params.id, businessId },
    select: { id: true, employeeId: true, field: true, status: true, approvalRequestId: true },
  });
  if (!cr) { res.status(404).json({ message: 'Not found' }); return null; }
  // F1 scope — a manager can only act within their sub-tree (out-of-scope → 404, IDOR-safe).
  if (!scopeAllows(req.scope, cr.employeeId)) { res.status(404).json({ message: 'Not found' }); return null; }
  // SoD: an operator cannot decide a change request for their OWN linked employee.
  const selfEmp = await operatorEmployeeId(req);
  if (selfEmp && selfEmp === cr.employeeId) { res.status(403).json({ message: 'You cannot decide a change request for your own profile', code: 'SOD_VIOLATION' }); return null; }
  return cr;
}

// Resolve the operator's portal userId (the engine decides by userId).
function actorUserId(req) { return req.user && req.user.id; }

// POST /api/hr/profile/change-requests/:id/approve — apply newValue (atomic, via the
// engine + PROFILE_CHANGE consumer).
async function approve(req, res, next) {
  try {
    const cr = await loadDecidable(req, res);
    if (!cr) return undefined;
    if (cr.status !== 'PENDING') return res.status(409).json({ message: `Request is ${cr.status}, not actionable` });
    if (!cr.approvalRequestId) return res.status(409).json({ message: 'Change request has no approval workflow attached' });
    const result = await engine.recordDecision({ approvalRequestId: cr.approvalRequestId, actorUserId: actorUserId(req), decision: 'APPROVED', comment: req.body && req.body.comment });
    await writeAudit({ businessId: req.user.businessId, actorId: req.user.id, action: 'PROFILE_CHANGE_APPROVED', entityType: 'ProfileChangeRequest', entityId: cr.id, meta: { field: cr.field } });
    return res.json({ id: cr.id, status: result.terminal === 'APPROVED' ? 'APPROVED' : 'PENDING', terminal: result.terminal });
  } catch (e) {
    if (e && (e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e)))) return sendEngineError(res, e);
    return next(e);
  }
}

// POST /api/hr/profile/change-requests/:id/reject — reject, no row change.
async function reject(req, res, next) {
  try {
    const cr = await loadDecidable(req, res);
    if (!cr) return undefined;
    if (cr.status !== 'PENDING') return res.status(409).json({ message: `Request is ${cr.status}, not actionable` });
    if (!cr.approvalRequestId) {
      // No workflow attached (defensive) — flip the CR directly.
      await prisma.profileChangeRequest.update({ where: { id: cr.id }, data: { status: 'REJECTED', decidedBy: req.user.id, decidedAt: new Date() } });
      return res.json({ id: cr.id, status: 'REJECTED', terminal: 'REJECTED' });
    }
    const result = await engine.recordDecision({ approvalRequestId: cr.approvalRequestId, actorUserId: actorUserId(req), decision: 'REJECTED', comment: req.body && req.body.comment });
    await writeAudit({ businessId: req.user.businessId, actorId: req.user.id, action: 'PROFILE_CHANGE_REJECTED', entityType: 'ProfileChangeRequest', entityId: cr.id, meta: { field: cr.field } });
    return res.json({ id: cr.id, status: 'REJECTED', terminal: result.terminal });
  } catch (e) {
    if (e && (e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e)))) return sendEngineError(res, e);
    return next(e);
  }
}

module.exports = { list, approve, reject, _internals: { operatorEmployeeId } };

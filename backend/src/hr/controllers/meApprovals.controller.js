'use strict';

/**
 * meApprovals.controller.js — Feature 10 (slice 10e) ESS-facing unified approvals
 * inbox + act, mounted at /api/hr/me/approvals. CUSTOMER session (req.customer).
 *
 * WHY THIS EXISTS — the operator inbox at /api/hr/approvals/inbox is gated by
 * `protect` (operator session, req.user) and so is unreachable from the employee
 * portal, which authenticates with a CUSTOMER session (req.customer). An employee
 * who is also an approver (e.g. a manager) needs to see + act on what's awaiting
 * them from inside ESS. This controller resolves the caller's portal User from the
 * ESS session (same email→User mapping the delegations controller already uses),
 * then reuses the SAME engine.recordDecision the operator path uses — identical
 * SoD / active-step / version / idempotency guards. No new authorisation surface:
 * the engine's resolved approver set is the gate, exactly as on the operator side.
 */

const prisma = require('../../core/lib/prisma');
const engine = require('../approvals/engine');

const MODULES = new Set([
  'LEAVE', 'EXPENSE', 'TRAVEL', 'LOAN', 'COMPENSATION', 'OFFER', 'PROFILE_CHANGE',
  'TIMESHEET', 'ATTENDANCE_REGULARIZATION', 'SEPARATION', 'ASSET', 'DOCUMENT_SIGN', 'PAYRUN',
]);
const DECISIONS = new Set(['APPROVED', 'REJECTED', 'REQUESTED_CHANGES']);

// Resolve { businessId, userId } from the ESS customer session (email → User).
async function resolveCaller(req) {
  if (req.customer && req.customer.id) {
    const businessId = req.customer.businessId;
    const user = req.customer.email
      ? await prisma.user.findFirst({ where: { businessId, email: req.customer.email, isActive: true }, select: { id: true } })
      : null;
    return { businessId, userId: user ? user.id : null };
  }
  return { businessId: null, userId: null };
}

function sendEngineError(res, e) {
  const status = e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e) ? 409 : 500);
  return res.status(status).json({ message: e.message, code: e.code });
}

// GET /me/approvals?module=&status= — pending-on-me across all modules.
async function inbox(req, res, next) {
  try {
    const { businessId, userId } = await resolveCaller(req);
    if (!userId) return res.json({ items: [], total: 0 });
    const { module, status } = req.query;
    if (module && !MODULES.has(module)) return res.status(400).json({ message: `Unknown module "${module}"` });
    const where = { businessId, status: status || 'PENDING', ...(module ? { module } : {}) };
    const rows = await prisma.approvalRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 500,
      select: {
        id: true, module: true, entityType: true, entityId: true, currentStepOrder: true,
        status: true, payloadJson: true, slaDueAt: true, createdAt: true, requesterEmployeeId: true,
      },
    });
    const items = rows.filter((r) => {
      const active = r.payloadJson && r.payloadJson._active;
      return active && Array.isArray(active.approverUserIds) && active.approverUserIds.includes(userId);
    }).map((r) => {
      const active = r.payloadJson && r.payloadJson._active;
      const delegatedFrom = active && active.delegationMap && active.delegationMap[userId] ? active.delegationMap[userId] : [];
      const { _ctx, _chain, _active, ...payload } = r.payloadJson || {};
      return {
        id: r.id, module: r.module, entityType: r.entityType, entityId: r.entityId,
        currentStepOrder: r.currentStepOrder, status: r.status, slaDueAt: r.slaDueAt, createdAt: r.createdAt,
        payload, onBehalfOf: delegatedFrom, minApprovals: active ? active.minApprovals : 1,
      };
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// POST /me/approvals/:id/decide — { decision, comment }
async function decide(req, res, next) {
  try {
    const { businessId, userId } = await resolveCaller(req);
    if (!userId) return res.status(403).json({ message: 'No portal user is linked to this account.' });
    const { decision, comment } = req.body || {};
    if (!DECISIONS.has(decision)) return res.status(400).json({ message: `decision must be one of ${[...DECISIONS].join('/')}` });
    const r = await prisma.approvalRequest.findFirst({ where: { id: req.params.id, businessId }, select: { id: true } });
    if (!r) return res.status(404).json({ message: 'Not found' });
    const result = await engine.recordDecision({ approvalRequestId: r.id, actorUserId: userId, decision, comment });
    res.json({
      id: result.approvalRequest.id, status: result.approvalRequest.status,
      terminal: result.terminal, levelComplete: !!result.levelComplete,
      idempotent: !!result.idempotent, changesRequested: !!result.changesRequested,
      currentStepOrder: result.approvalRequest.currentStepOrder,
    });
  } catch (e) {
    if (e && (e.statusCode || (engine.isConcurrencyError && engine.isConcurrencyError(e)))) return sendEngineError(res, e);
    next(e);
  }
}

// POST /me/approvals/preview — "who will approve this?" hint before submit.
// Body: { module, ctx } — pure previewChain, returns resolved approver user ids.
async function preview(req, res, next) {
  try {
    const { businessId, userId } = await resolveCaller(req);
    if (!businessId) return res.status(403).json({ message: 'No session.' });
    const { module, ctx } = req.body || {};
    if (!module || !MODULES.has(module)) return res.status(400).json({ message: 'module is required' });
    // Anchor the preview to the caller's own employee so REPORTING_MANAGER resolves.
    const emp = await prisma.employee.findFirst({
      where: { businessId, ...(req.customer?.email ? { user: { email: req.customer.email } } : {}), deletedAt: null },
      select: { id: true },
    }).catch(() => null);
    const chain = await engine.previewChain({
      businessId, module, ctx: ctx || {},
      requesterEmployeeId: emp ? emp.id : null,
    });
    res.json({ module, chain });
  } catch (e) { next(e); }
}

// GET /me/approvals/colleagues — minimal directory of active portal users in the
// SAME tenant (id + name only) so the "delegate while away" picker can choose a
// stand-in. We never expose anything beyond display name; the caller is excluded.
async function colleagues(req, res, next) {
  try {
    const { businessId, userId } = await resolveCaller(req);
    if (!businessId) return res.json({ items: [] });
    const users = await prisma.user.findMany({
      where: { businessId, isActive: true, ...(userId ? { id: { not: userId } } : {}) },
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, name: true, email: true },
    });
    res.json({ items: users.map((u) => ({ id: u.id, name: u.name || u.email })) });
  } catch (e) { next(e); }
}

module.exports = { inbox, decide, preview, colleagues };

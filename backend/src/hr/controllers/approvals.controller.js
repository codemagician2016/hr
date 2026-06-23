'use strict';

/**
 * approvals.controller.js — Feature 10 §7 HTTP surface for the approval engine.
 * Mounted at /api/hr/approvals/* (operator session) and the ESS delegation routes
 * at /api/hr/me/delegations/* (customer session). Admin config is gated by
 * canManageApprovalWorkflows; the inbox + decide are open to any approver (the
 * engine's resolved set is the real gate); delegation admin is gated too.
 *
 * Every query filters by businessId (tenant wall); a cross-tenant id ⇒ 404, never
 * a leak. Validation is inline + small (no external schema dependency).
 */

const prisma = require('../../core/lib/prisma');
const engine = require('../approvals/engine');
const { previewChain } = require('../approvals/engine');
const { validateCondition } = require('../approvals/conditions');

const MODULES = new Set([
  'LEAVE', 'EXPENSE', 'TRAVEL', 'LOAN', 'COMPENSATION', 'OFFER', 'PROFILE_CHANGE',
  'TIMESHEET', 'ATTENDANCE_REGULARIZATION', 'SEPARATION', 'ASSET', 'DOCUMENT_SIGN', 'PAYRUN',
]);
const APPROVER_TYPES = new Set([
  'REPORTING_MANAGER', 'DEPARTMENT_HEAD', 'HR', 'PAYROLL_MANAGER',
  'SPECIFIC_ROLE', 'SPECIFIC_EMPLOYEE', 'AUTO_APPROVE',
]);
const TIMEOUT_ACTIONS = new Set(['ESCALATE', 'AUTO_APPROVE', 'AUTO_REJECT', 'REMIND']);
const DECISIONS = new Set(['APPROVED', 'REJECTED', 'REQUESTED_CHANGES']);

function bad(res, message, extra = {}) { return res.status(400).json({ message, ...extra }); }
function slugCode(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

// Map the engine's coded errors to HTTP statuses.
function sendEngineError(res, e) {
  const status = e.statusCode || (engine.isConcurrencyError(e) ? 409 : 500);
  return res.status(status).json({ message: e.message, code: e.code });
}

// ── §7.1 Workflow config (canManageApprovalWorkflows) ───────────────────────────

async function listWorkflows(req, res, next) {
  try {
    const { businessId } = req.user;
    const { module } = req.query;
    if (module && !MODULES.has(module)) return bad(res, `Unknown module "${module}"`);
    const defs = await prisma.workflowDefinition.findMany({
      where: { businessId, ...(module ? { module } : {}), isActive: true },
      orderBy: [{ module: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
      include: { steps: { orderBy: { stepOrder: 'asc' } }, _count: { select: { steps: true } } },
    });
    // mark which def is the live module-default (published, no entityId/scope).
    const items = defs.map((d) => ({
      ...d,
      isLiveDefault: d.isPublished && !d.entityId && !d.scopeJson,
    }));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

async function createWorkflow(req, res, next) {
  try {
    const { businessId, id: userId } = req.user;
    const { name, module, scopeJson, priority, description, entityId } = req.body || {};
    if (!name || typeof name !== 'string') return bad(res, 'name is required');
    if (!module || !MODULES.has(module)) return bad(res, `module must be one of ${[...MODULES].join('/')}`);
    if (scopeJson !== undefined && scopeJson !== null && typeof scopeJson !== 'object') return bad(res, 'scopeJson must be an object or null');
    const def = await prisma.workflowDefinition.create({
      data: {
        businessId, code: slugCode(module), name, module,
        description: description || null, scopeJson: scopeJson || undefined,
        priority: Number.isFinite(priority) ? priority : 100,
        entityId: entityId || null,
        isPublished: false, isActive: true, createdBy: userId, updatedBy: userId,
      },
    });
    res.status(201).json(def);
  } catch (e) { next(e); }
}

async function getWorkflow(req, res, next) {
  try {
    const { businessId } = req.user;
    const def = await prisma.workflowDefinition.findFirst({
      where: { id: req.params.id, businessId, isActive: true },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!def) return res.status(404).json({ message: 'Not found' });
    res.json(def);
  } catch (e) { next(e); }
}

async function updateWorkflow(req, res, next) {
  try {
    const { businessId, id: userId } = req.user;
    const def = await prisma.workflowDefinition.findFirst({ where: { id: req.params.id, businessId, isActive: true } });
    if (!def) return res.status(404).json({ message: 'Not found' });
    const { name, scopeJson, priority, description, entityId } = req.body || {};
    if (scopeJson !== undefined && scopeJson !== null && typeof scopeJson !== 'object') return bad(res, 'scopeJson must be an object or null');
    // version-locked update (optimistic concurrency).
    const flip = await prisma.workflowDefinition.updateMany({
      where: { id: def.id, businessId, version: def.version },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(scopeJson !== undefined ? { scopeJson: scopeJson || null } : {}),
        ...(priority !== undefined ? { priority: Number(priority) } : {}),
        ...(entityId !== undefined ? { entityId: entityId || null } : {}),
        updatedBy: userId, version: { increment: 1 },
      },
    });
    if (flip.count === 0) return res.status(409).json({ message: 'Definition changed concurrently', code: 'CONCURRENT_UPDATE' });
    const fresh = await prisma.workflowDefinition.findUnique({ where: { id: def.id }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
    res.json(fresh);
  } catch (e) { next(e); }
}

// §7.1 PUT /:id/steps — replace the whole step array atomically. Validates: each
// step has a known approverType, conditions well-formed, minApprovals ≤ level size,
// no duplicate NON-parallel stepOrder.
async function replaceSteps(req, res, next) {
  try {
    const { businessId } = req.user;
    const def = await prisma.workflowDefinition.findFirst({ where: { id: req.params.id, businessId, isActive: true } });
    if (!def) return res.status(404).json({ message: 'Not found' });
    const steps = Array.isArray(req.body && req.body.steps) ? req.body.steps : null;
    if (!steps) return bad(res, 'steps must be an array');

    // Validate each step.
    const byOrder = new Map();
    for (const [i, s] of steps.entries()) {
      if (!s || typeof s !== 'object') return bad(res, `step ${i} is malformed`);
      if (!APPROVER_TYPES.has(s.approverType)) return bad(res, `step ${i}: approverType must be one of ${[...APPROVER_TYPES].join('/')}`);
      if (!Number.isInteger(s.stepOrder) || s.stepOrder < 1) return bad(res, `step ${i}: stepOrder must be a positive integer`);
      if (s.onTimeoutAction && !TIMEOUT_ACTIONS.has(s.onTimeoutAction)) return bad(res, `step ${i}: bad onTimeoutAction`);
      if (s.conditionJson) {
        const v = validateCondition(s.conditionJson);
        if (!v.ok) return bad(res, `step ${i}: ${v.error}`);
      }
      if (s.approverType === 'SPECIFIC_ROLE' && !s.approverRefId) return bad(res, `step ${i}: SPECIFIC_ROLE needs approverRefId (role id)`);
      if (s.approverType === 'SPECIFIC_EMPLOYEE' && !s.approverRefId) return bad(res, `step ${i}: SPECIFIC_EMPLOYEE needs approverRefId (employee id)`);
      if (!byOrder.has(s.stepOrder)) byOrder.set(s.stepOrder, []);
      byOrder.get(s.stepOrder).push(s);
    }
    // duplicate non-parallel order + minApprovals ≤ level size.
    for (const [order, level] of byOrder.entries()) {
      const parallelFlags = level.map((s) => !!s.isParallel);
      if (level.length > 1 && parallelFlags.some((p) => !p)) {
        return bad(res, `stepOrder ${order} has multiple steps but not all are marked parallel (isParallel)`);
      }
      const maxMin = Math.max(...level.map((s) => Number(s.minApprovals || 1)));
      if (maxMin > level.length) return bad(res, `stepOrder ${order}: minApprovals (${maxMin}) exceeds level size (${level.length})`);
    }
    // cross-tenant ref validation: SPECIFIC_ROLE/SPECIFIC_EMPLOYEE refs must belong here.
    for (const s of steps) {
      if (s.approverType === 'SPECIFIC_ROLE') {
        const role = await prisma.businessRole.findFirst({ where: { id: s.approverRefId, businessId }, select: { id: true } });
        if (!role) return res.status(404).json({ message: `role ${s.approverRefId} not found in this tenant` });
      }
      if (s.approverType === 'SPECIFIC_EMPLOYEE') {
        const emp = await prisma.employee.findFirst({ where: { id: s.approverRefId, businessId, deletedAt: null }, select: { id: true } });
        if (!emp) return res.status(404).json({ message: `employee ${s.approverRefId} not found in this tenant` });
      }
    }

    // Atomic replace inside a tx (bump the def version too).
    const result = await prisma.$transaction(async (tx) => {
      await tx.workflowStep.deleteMany({ where: { businessId, workflowDefinitionId: def.id } });
      for (const s of steps) {
        await tx.workflowStep.create({
          data: {
            businessId, workflowDefinitionId: def.id, stepOrder: s.stepOrder,
            name: s.name || s.approverType, approverType: s.approverType, approverRefId: s.approverRefId || null,
            conditionJson: s.conditionJson || undefined, isParallel: !!s.isParallel,
            minApprovals: Number(s.minApprovals || 1), slaHours: s.slaHours == null ? null : Number(s.slaHours),
            onTimeoutAction: s.onTimeoutAction || 'ESCALATE',
          },
        });
      }
      await tx.workflowDefinition.update({ where: { id: def.id }, data: { version: { increment: 1 }, updatedBy: req.user.id } });
      return tx.workflowDefinition.findUnique({ where: { id: def.id }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
    });
    res.json(result);
  } catch (e) { next(e); }
}

async function publishWorkflow(req, res, next) {
  try {
    const { businessId } = req.user;
    const def = await prisma.workflowDefinition.findFirst({ where: { id: req.params.id, businessId, isActive: true }, include: { _count: { select: { steps: true } } } });
    if (!def) return res.status(404).json({ message: 'Not found' });
    // a zero-step published def is the explicit "no approvals / auto-approve" choice —
    // allowed; the engine treats an empty applicable chain as auto-approve.
    const flip = await prisma.workflowDefinition.updateMany({
      where: { id: def.id, businessId, version: def.version },
      data: { isPublished: true, updatedBy: req.user.id, version: { increment: 1 } },
    });
    if (flip.count === 0) return res.status(409).json({ message: 'Definition changed concurrently', code: 'CONCURRENT_UPDATE' });
    const fresh = await prisma.workflowDefinition.findUnique({ where: { id: def.id }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
    res.json(fresh);
  } catch (e) { next(e); }
}

async function previewWorkflow(req, res, next) {
  try {
    const { businessId } = req.user;
    const { module, ctx, requesterEmployeeId } = req.body || {};
    let definition = null;
    if (req.params.id) {
      definition = await prisma.workflowDefinition.findFirst({
        where: { id: req.params.id, businessId, isActive: true },
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });
      if (!definition) return res.status(404).json({ message: 'Not found' });
    }
    const mod = (definition && definition.module) || module;
    if (!mod || !MODULES.has(mod)) return bad(res, 'module is required for preview');
    const chain = await previewChain({ businessId, module: mod, ctx: ctx || {}, definition, requesterEmployeeId: requesterEmployeeId || null });
    res.json({ module: mod, chain });
  } catch (e) { next(e); }
}

async function deleteWorkflow(req, res, next) {
  try {
    const { businessId } = req.user;
    const def = await prisma.workflowDefinition.findFirst({ where: { id: req.params.id, businessId, isActive: true } });
    if (!def) return res.status(404).json({ message: 'Not found' });
    // soft-disable; never hard-delete a def with approval history.
    await prisma.workflowDefinition.update({ where: { id: def.id }, data: { isActive: false, isPublished: false, updatedBy: req.user.id, version: { increment: 1 } } });
    res.json({ ok: true, id: def.id });
  } catch (e) { next(e); }
}

// ── §7.2 Inbox + act ────────────────────────────────────────────────────────────

// The caller's user id — operator session (req.user) or customer/ESS (req.customer's
// linked user). The inbox + decide work for any authenticated approver.
function callerUserId(req) {
  if (req.user && req.user.id) return req.user.id;
  return null; // ESS inbox handled separately via the me-routes if needed
}

async function inbox(req, res, next) {
  try {
    const { businessId } = req.user;
    const me = callerUserId(req);
    const { module, status } = req.query;
    if (module && !MODULES.has(module)) return bad(res, `Unknown module "${module}"`);
    // Pending-on-me: PENDING requests whose active level approver set contains me.
    // We filter in SQL by status/module then in-code by the snapshot approver set
    // (Json path filtering on arrays is awkward + version-fragile across PG versions).
    const where = { businessId, status: status || 'PENDING', ...(module ? { module } : {}) };
    const rows = await prisma.approvalRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 500,
      select: { id: true, module: true, entityType: true, entityId: true, currentStepOrder: true, status: true, payloadJson: true, slaDueAt: true, createdAt: true, requesterEmployeeId: true },
    });
    const items = rows.filter((r) => {
      const active = r.payloadJson && r.payloadJson._active;
      return active && Array.isArray(active.approverUserIds) && active.approverUserIds.includes(me);
    }).map((r) => {
      const active = r.payloadJson && r.payloadJson._active;
      const delegatedFrom = active && active.delegationMap && active.delegationMap[me] ? active.delegationMap[me] : [];
      // strip engine-internal keys from the payload the approver sees.
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

async function getRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const r = await prisma.approvalRequest.findFirst({
      where: { id: req.params.id, businessId },
      include: { actions: { orderBy: { actedAt: 'asc' } } },
    });
    if (!r) return res.status(404).json({ message: 'Not found' });
    const { _chain, _active, _ctx, ...payload } = r.payloadJson || {};
    res.json({
      id: r.id, module: r.module, entityType: r.entityType, entityId: r.entityId,
      status: r.status, currentStepOrder: r.currentStepOrder, slaDueAt: r.slaDueAt,
      requesterEmployeeId: r.requesterEmployeeId, payload,
      chain: _chain || null, active: _active || null,
      actions: r.actions, createdAt: r.createdAt, completedAt: r.completedAt,
    });
  } catch (e) { next(e); }
}

async function decide(req, res, next) {
  try {
    const { businessId } = req.user;
    const me = callerUserId(req);
    const { decision, comment } = req.body || {};
    if (!DECISIONS.has(decision)) return bad(res, `decision must be one of ${[...DECISIONS].join('/')}`);
    const r = await prisma.approvalRequest.findFirst({ where: { id: req.params.id, businessId }, select: { id: true } });
    if (!r) return res.status(404).json({ message: 'Not found' });
    const result = await engine.recordDecision({ approvalRequestId: r.id, actorUserId: me, decision, comment });
    res.json({
      id: result.approvalRequest.id, status: result.approvalRequest.status,
      terminal: result.terminal, levelComplete: !!result.levelComplete,
      idempotent: !!result.idempotent, changesRequested: !!result.changesRequested,
      currentStepOrder: result.approvalRequest.currentStepOrder,
    });
  } catch (e) {
    if (e && (e.statusCode || engine.isConcurrencyError(e))) return sendEngineError(res, e);
    next(e);
  }
}

// §7.2 (admin) reassign the active step to another approver (e.g. someone left).
async function reassign(req, res, next) {
  try {
    const { businessId, id: actorUserId } = req.user;
    const { toUserId, comment } = req.body || {};
    if (!toUserId) return bad(res, 'toUserId is required');
    const r = await prisma.approvalRequest.findFirst({ where: { id: req.params.id, businessId } });
    if (!r) return res.status(404).json({ message: 'Not found' });
    if (r.status !== 'PENDING') return res.status(409).json({ message: `Request is ${r.status}, cannot reassign` });
    const target = await prisma.user.findFirst({ where: { id: toUserId, businessId, isActive: true }, select: { id: true } });
    if (!target) return res.status(404).json({ message: 'Target user not found in this tenant' });

    const updated = await prisma.$transaction(async (tx) => {
      const fresh = await tx.approvalRequest.findUnique({ where: { id: r.id } });
      const payload = { ...(fresh.payloadJson || {}) };
      const active = { ...(payload._active || {}) };
      active.approverUserIds = [...new Set([...(active.approverUserIds || []), toUserId])];
      payload._active = active;
      const flip = await tx.approvalRequest.updateMany({
        where: { id: r.id, status: 'PENDING', version: fresh.version },
        data: { payloadJson: payload, version: { increment: 1 } },
      });
      if (flip.count === 0) { const e = new Error('Request changed concurrently'); e.statusCode = 409; e.code = 'CONCURRENT_UPDATE'; throw e; }
      await tx.approvalAction.create({
        data: {
          businessId, approvalRequestId: r.id, stepOrder: fresh.currentStepOrder,
          approverUserId: actorUserId, decision: 'ABSTAINED',
          comment: `Reassigned to ${toUserId}${comment ? `: ${comment}` : ''}`,
        },
      });
      return tx.approvalRequest.findUnique({ where: { id: r.id } });
    });
    res.json({ id: updated.id, active: updated.payloadJson._active });
  } catch (e) {
    if (e && e.statusCode) return res.status(e.statusCode).json({ message: e.message, code: e.code });
    next(e);
  }
}

// ── §7.3 Delegation (admin tenant-wide view) ────────────────────────────────────
async function listAllDelegations(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.approvalDelegation.findMany({
      where: { businessId },
      orderBy: { startsAt: 'desc' },
      include: { fromUser: { select: { id: true, name: true, email: true } }, toUser: { select: { id: true, name: true, email: true } } },
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

module.exports = {
  // workflow config
  listWorkflows, createWorkflow, getWorkflow, updateWorkflow, replaceSteps,
  publishWorkflow, previewWorkflow, deleteWorkflow,
  // inbox + act
  inbox, getRequest, decide, reassign,
  // delegation (admin)
  listAllDelegations,
};

'use strict';

/**
 * engine.js — Feature 10 §5.4. THE single chokepoint that instantiates and advances
 * an ApprovalRequest, mirroring how scopeResolver is the chokepoint for data scope.
 *
 * Public surface:
 *   openRequest({ businessId, module, entityType, entityId, requesterEmployeeId,
 *                 payload, ctx }, tx?) -> { approvalRequest, terminal }
 *   recordDecision({ approvalRequestId, actorUserId, decision, comment,
 *                    systemActor?, now? }, tx?) -> { approvalRequest, terminal, levelComplete }
 *   advance(approvalRequest, tx) -> { approvalRequest, terminal }   (internal-ish)
 *   cancel({ approvalRequestId, actorUserId, comment }, tx?)
 *   withdraw({ approvalRequestId, actorUserId, comment }, tx?)
 *   previewChain({ businessId, module, requesterEmployee, ctx, definition? }) -> [levels]  PURE (reads only)
 *
 * Model of a "level": all WorkflowSteps that share a stepOrder run together as one
 * parallel level; minApprovals governs how many YESes complete it (1 = any, n = all).
 * ApprovalRequest.currentStepOrder points at the active level's stepOrder.
 *
 * Conditional skip (§5.4): a level is APPLICABLE iff at least one of its steps'
 * conditionJson matches ctx. Non-matching steps are dropped from the level; an
 * empty/inapplicable level is skipped entirely. A condition is fail-closed (a
 * malformed one makes the step not apply) — never blocks the chain.
 *
 * Concurrency (§5.5): every transition is a version-locked updateMany
 * (where:{ id, status, version }); a lost race ⇒ CONCURRENT_UPDATE (409, mirrors
 * leave.controller decideTerminal/isDecisionRace). Idempotent: a duplicate decision
 * by the same user at the same level is a no-op.
 */

const prismaDefault = require('../../core/lib/prisma');
const { matches } = require('./conditions');
const { resolveDefinition } = require('./workflowResolver');
const { resolveStepApprovers } = require('./approverResolver');
const consumers = require('./consumers');
// Cycle 0 — real-channel notification fan-out (email/WhatsApp/push) for approvers.
// Lazy-required and fire-and-forget so it can NEVER affect the approval transaction.
const notify = require('./notify');

// ── errors ──────────────────────────────────────────────────────────────────────
function err(code, message, status) {
  const e = new Error(message || code);
  e.code = code;
  if (status) e.statusCode = status;
  return e;
}
function isConcurrencyError(e) {
  return e && (e.code === 'CONCURRENT_UPDATE' || e.code === 'P2025');
}

// Run `fn(tx)` in the caller's tx, or open a fresh one.
async function withTx(tx, db, fn) {
  if (tx) return fn(tx);
  return db.$transaction((t) => fn(t));
}

// ── level helpers ─────────────────────────────────────────────────────────────
// Group ordered steps into levels keyed by stepOrder, ascending.
function groupLevels(steps) {
  const byOrder = new Map();
  for (const s of steps) {
    if (!byOrder.has(s.stepOrder)) byOrder.set(s.stepOrder, []);
    byOrder.get(s.stepOrder).push(s);
  }
  return [...byOrder.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stepOrder, levelSteps]) => ({ stepOrder, steps: levelSteps }));
}

// Which steps of a level actually apply for this ctx (conditionJson match)?
function applicableSteps(level, ctx) {
  return level.steps.filter((s) => matches(s.conditionJson, ctx));
}

// The slaDueAt for a level = now + min(slaHours) across its applicable steps (the
// tightest clock); null when no step sets an SLA.
function levelSlaDueAt(applied, now) {
  const hrs = applied.map((s) => s.slaHours).filter((h) => h != null && h > 0);
  if (hrs.length === 0) return null;
  const min = Math.min(...hrs);
  return new Date(now.getTime() + min * 3600 * 1000);
}

// Resolve the union approver set + governing minApprovals for an APPLICABLE level.
// minApprovals is the MAX across the level's applicable steps (so "manager AND
// finance in parallel" = need both), capped to the union size. autoApprove when
// every applicable step auto-approves or the union is empty.
async function resolveLevel(level, ctx, requesterEmployee, businessId, module, now, db) {
  const applied = applicableSteps(level, ctx);
  if (applied.length === 0) return { applicable: false };

  const unionUsers = new Set();
  const delegationMap = {};
  let allAuto = true;
  let minApprovals = 1;
  const escalationReasons = [];

  for (const s of applied) {
    const r = await resolveStepApprovers(s, requesterEmployee, businessId, { module, now, prismaClient: db });
    if (!r.autoApprove) {
      allAuto = false;
      r.userIds.forEach((u) => unionUsers.add(u));
      // Level minApprovals = the MAX of the steps' CONFIGURED minApprovals (read from
      // the step, not the resolver's per-step-capped value — a parallel "all-of" level
      // of N single-approver steps must require N YESes, which the per-step cap of 1
      // would erase). Capped to the union size below so it can always be satisfied.
      minApprovals = Math.max(minApprovals, Number(s.minApprovals || 1));
      for (const [to, froms] of Object.entries(r.delegationMap || {})) {
        delegationMap[to] = [...new Set([...(delegationMap[to] || []), ...froms])];
      }
    }
    if (r.escalationReason) escalationReasons.push(r.escalationReason);
  }

  const userIds = [...unionUsers];
  const autoApprove = allAuto || userIds.length === 0;
  return {
    applicable: true,
    autoApprove,
    userIds,
    minApprovals: Math.min(minApprovals, userIds.length) || 1,
    slaDueAt: levelSlaDueAt(applied, now),
    delegationMap,
    escalationReason: escalationReasons.length ? escalationReasons.join(',') : undefined,
    appliedSteps: applied,
  };
}

// Snapshot the resolved chain into payloadJson._chain so the inbox + escalation
// runner read it without re-resolving (and so a published change can't retro-mutate
// an open request — §9.7). Stored as { levels:[{ stepOrder, approverUserIds,
// minApprovals, slaHours, onTimeoutAction }], stepsSnapshot:[...] }.
function chainSnapshot(levels) {
  return {
    levels: levels.map((l) => ({
      stepOrder: l.stepOrder,
      steps: l.steps.map((s) => ({
        stepOrder: s.stepOrder, name: s.name, approverType: s.approverType,
        approverRefId: s.approverRefId, conditionJson: s.conditionJson || null,
        minApprovals: s.minApprovals || 1, slaHours: s.slaHours == null ? null : s.slaHours,
        onTimeoutAction: s.onTimeoutAction || 'ESCALATE',
      })),
    })),
  };
}

// ── openRequest ───────────────────────────────────────────────────────────────
async function openRequest(input, tx) {
  const db = prismaDefault;
  const {
    businessId, module, entityType, entityId, requesterEmployeeId,
    payload = {}, ctx = {},
  } = input;
  if (!businessId || !module || !entityType || !entityId) {
    throw err('BAD_REQUEST', 'openRequest requires businessId, module, entityType, entityId', 400);
  }
  const now = input.now || new Date();

  return withTx(tx, db, async (t) => {
    // Resolve the requester Employee (for manager/department/level resolution + SoD).
    const requesterEmployee = requesterEmployeeId
      ? await t.employee.findFirst({
          where: { id: requesterEmployeeId, businessId },
          select: { id: true, businessId: true, userId: true, managerEmployeeId: true },
        })
      : null;

    const { definition, steps } = await resolveDefinition(businessId, module, ctx, { prismaClient: t });
    const levels = groupLevels(steps);

    // Persist the request in PENDING with a chain snapshot in payloadJson.
    const snapshot = chainSnapshot(levels);
    const firstStepOrder = levels.length ? levels[0].stepOrder : 1;

    let request = await t.approvalRequest.create({
      data: {
        businessId,
        workflowDefinitionId: definition ? definition.id : null,
        module,
        entityType,
        entityId,
        requesterEmployeeId: requesterEmployee ? requesterEmployee.id : null,
        currentStepOrder: firstStepOrder,
        status: 'PENDING',
        payloadJson: { ...payload, _ctx: ctx, _chain: snapshot },
      },
    });

    // Activate the first applicable level (auto-completing skipped/auto levels).
    const activated = await activateFrom(request, levels, ctx, requesterEmployee, businessId, module, now, t);
    return activated;
  });
}

// Walk forward from request.currentStepOrder, skipping inapplicable levels and
// auto-completing auto-approve levels, until we either land on a level that needs a
// human (PENDING) or run out of levels (terminal APPROVED).
async function activateFrom(request, levels, ctx, requesterEmployee, businessId, module, now, t) {
  let current = request;
  // levels at/after the current stepOrder.
  const remaining = levels.filter((l) => l.stepOrder >= current.currentStepOrder);

  for (const level of remaining) {
    const resolved = await resolveLevel(level, ctx, requesterEmployee, businessId, module, now, t);
    if (!resolved.applicable) continue; // conditional skip
    if (resolved.autoApprove) {
      // record an audit action for the auto-approval, then continue to next level.
      await t.approvalAction.create({
        data: {
          businessId, approvalRequestId: current.id, stepOrder: level.stepOrder,
          approverUserId: 'SYSTEM', decision: 'APPROVED',
          comment: resolved.escalationReason ? `Auto-approved (${resolved.escalationReason})` : 'Auto-approved (no approver / AUTO_APPROVE step)',
        },
      });
      current = await bumpStepOrder(current, level.stepOrder, t);
      continue;
    }
    // a human level — set currentStepOrder + slaDueAt, notify, stay PENDING.
    current = await setActiveLevel(current, level.stepOrder, resolved, businessId, t);
    await notifyApprovers(businessId, current, resolved.userIds, t);
    return { approvalRequest: current, terminal: null };
  }

  // No human level left → chain complete, APPROVED.
  const completed = await completeApproved(current, businessId, module, t, now);
  return { approvalRequest: completed, terminal: 'APPROVED' };
}

// Set currentStepOrder + slaDueAt under a version lock; store the resolved approver
// set into payloadJson._active for the inbox/escalation reads.
async function setActiveLevel(request, stepOrder, resolved, businessId, t) {
  const payload = { ...(request.payloadJson || {}) };
  payload._active = {
    stepOrder,
    approverUserIds: resolved.userIds,
    minApprovals: resolved.minApprovals,
    delegationMap: resolved.delegationMap || {},
    escalationReason: resolved.escalationReason || null,
  };
  const flip = await t.approvalRequest.updateMany({
    where: { id: request.id, version: request.version },
    data: {
      currentStepOrder: stepOrder,
      slaDueAt: resolved.slaDueAt,
      status: 'PENDING',
      payloadJson: payload,
      version: { increment: 1 },
    },
  });
  if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Approval request changed concurrently', 409);
  return t.approvalRequest.findUnique({ where: { id: request.id } });
}

// Move currentStepOrder past a (skipped/auto) level under a version lock.
async function bumpStepOrder(request, stepOrder, t) {
  const flip = await t.approvalRequest.updateMany({
    where: { id: request.id, version: request.version },
    data: { currentStepOrder: stepOrder + 1, version: { increment: 1 } },
  });
  if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Approval request changed concurrently', 409);
  return t.approvalRequest.findUnique({ where: { id: request.id } });
}

async function completeApproved(request, businessId, module, t, now) {
  const flip = await t.approvalRequest.updateMany({
    where: { id: request.id, status: 'PENDING', version: request.version },
    data: { status: 'APPROVED', completedAt: now || new Date(), slaDueAt: null, version: { increment: 1 } },
  });
  if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Approval request changed concurrently', 409);
  const fresh = await t.approvalRequest.findUnique({ where: { id: request.id } });
  await consumers.fire(module, 'onApprove', fresh, t);
  return fresh;
}

// ── recordDecision ──────────────────────────────────────────────────────────────
async function recordDecision(input, tx) {
  const db = prismaDefault;
  const { approvalRequestId, actorUserId, decision, comment } = input;
  const systemActor = !!input.systemActor;
  const now = input.now || new Date();
  if (!approvalRequestId || !actorUserId || !decision) {
    throw err('BAD_REQUEST', 'recordDecision requires approvalRequestId, actorUserId, decision', 400);
  }
  const VALID = ['APPROVED', 'REJECTED', 'REQUESTED_CHANGES'];
  if (!VALID.includes(decision)) throw err('BAD_DECISION', `decision must be one of ${VALID.join('/')}`, 400);

  return withTx(tx, db, async (t) => {
    const request = await t.approvalRequest.findFirst({ where: { id: approvalRequestId } });
    if (!request) throw err('NOT_FOUND', 'Approval request not found', 404);
    if (request.status !== 'PENDING') throw err('NOT_PENDING', `Request is ${request.status}, not actionable`, 409);

    const active = (request.payloadJson && request.payloadJson._active) || null;
    if (!active) throw err('NO_ACTIVE_LEVEL', 'Request has no active level', 409);

    const approverSet = new Set(active.approverUserIds || []);
    // System actor (SLA auto-decision) bypasses membership but is NOT the requester.
    if (!systemActor && !approverSet.has(actorUserId)) {
      throw err('NOT_AN_APPROVER', 'You are not an approver for the active step', 403);
    }

    // SoD re-check: the actor must not be the requester's user (maker ≠ checker).
    const reqUserId = await requesterUserIdOf(request, businessId(request), t);
    if (!systemActor && reqUserId && actorUserId === reqUserId) {
      throw err('SOD_VIOLATION', 'You cannot decide your own request', 403);
    }

    // Idempotency: a duplicate decision by the same user at the same level is a no-op.
    const dup = await t.approvalAction.findFirst({
      where: { businessId: request.businessId, approvalRequestId: request.id, stepOrder: request.currentStepOrder, approverUserId: actorUserId },
    });
    if (dup) {
      return { approvalRequest: request, terminal: null, levelComplete: false, idempotent: true };
    }

    // Append the action (with delegatedFromUserId provenance if a stand-in acted).
    const delegatedFrom = (active.delegationMap && active.delegationMap[actorUserId] && active.delegationMap[actorUserId][0]) || null;
    await t.approvalAction.create({
      data: {
        businessId: request.businessId, approvalRequestId: request.id, stepOrder: request.currentStepOrder,
        approverUserId: actorUserId, decision,
        comment: comment || (systemActor ? 'System decision' : null),
        delegatedFromUserId: delegatedFrom,
        actedAt: now,
      },
    });

    // REJECTED → terminal REJECTED (fires onReject).
    if (decision === 'REJECTED') {
      const flip = await t.approvalRequest.updateMany({
        where: { id: request.id, status: 'PENDING', version: request.version },
        data: { status: 'REJECTED', decidedBy: actorUserId, completedAt: now, slaDueAt: null, version: { increment: 1 } },
      });
      if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Approval request changed concurrently', 409);
      const fresh = await t.approvalRequest.findUnique({ where: { id: request.id } });
      await consumers.fire(request.module, 'onReject', fresh, t);
      return { approvalRequest: fresh, terminal: 'REJECTED', levelComplete: true };
    }

    // REQUESTED_CHANGES → back to requester; status stays PENDING, level reset (the
    // requester edits + re-submits; no auto-advance). We bump version to invalidate
    // racing approvals and clear the SLA clock.
    if (decision === 'REQUESTED_CHANGES') {
      const flip = await t.approvalRequest.updateMany({
        where: { id: request.id, status: 'PENDING', version: request.version },
        data: { slaDueAt: null, version: { increment: 1 } },
      });
      if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Approval request changed concurrently', 409);
      const fresh = await t.approvalRequest.findUnique({ where: { id: request.id } });
      // OPTIONAL consumer hook (backward compatible): a module may want to hand the
      // request back to the requester for editing (e.g. expense: SUBMITTED → DRAFT so
      // the ESS edit/resubmit controls light up). Modules WITHOUT this hook are wholly
      // unaffected — the request simply stays PENDING as before. We carry the actor's
      // reason in-memory on the request (NOT persisted to the engine row) so the hook
      // can store it as a return reason; fired INSIDE the engine tx like every other hook.
      await consumers.fire(request.module, 'onChangesRequested', { ...fresh, _changesReason: comment || null }, t);
      return { approvalRequest: fresh, terminal: null, levelComplete: false, changesRequested: true };
    }

    // APPROVED → count YESes at this level; complete when minApprovals met.
    const yesCount = await t.approvalAction.count({
      where: { businessId: request.businessId, approvalRequestId: request.id, stepOrder: request.currentStepOrder, decision: 'APPROVED' },
    });
    const minApprovals = active.minApprovals || 1;
    if (yesCount < minApprovals) {
      // stay on this parallel level, await remaining approvers (no version bump).
      const fresh = await t.approvalRequest.findUnique({ where: { id: request.id } });
      return { approvalRequest: fresh, terminal: null, levelComplete: false };
    }

    // level complete → advance to the next applicable level (or terminal APPROVED).
    const advanced = await advance(request, t, now);
    return { approvalRequest: advanced.approvalRequest, terminal: advanced.terminal, levelComplete: true };
  });
}

// ── advance ───────────────────────────────────────────────────────────────────
// Move to the next applicable level after the current one (re-resolving from the
// snapshot so an in-flight request keeps its original chain — §9.7).
async function advance(request, t, now = new Date()) {
  const fresh = await t.approvalRequest.findUnique({ where: { id: request.id } });
  const ctx = (fresh.payloadJson && fresh.payloadJson._ctx) || {};
  const snapshot = (fresh.payloadJson && fresh.payloadJson._chain) || { levels: [] };
  const requesterEmployee = fresh.requesterEmployeeId
    ? await t.employee.findFirst({ where: { id: fresh.requesterEmployeeId, businessId: fresh.businessId }, select: { id: true, businessId: true, userId: true, managerEmployeeId: true } })
    : null;

  // Rebuild levels from the snapshot's steps (the chain the request started with).
  const allSteps = [];
  for (const lvl of snapshot.levels) for (const s of lvl.steps) allSteps.push(s);
  const levels = groupLevels(allSteps);

  // mark currentStepOrder as done by moving past it, then activate forward.
  const moved = await bumpStepOrder(fresh, fresh.currentStepOrder, t);
  return activateFrom(moved, levels, ctx, requesterEmployee, fresh.businessId, fresh.module, now, t);
}

// ── cancel / withdraw ─────────────────────────────────────────────────────────
async function terminalByRequester(input, tx, status, hook) {
  const db = prismaDefault;
  const { approvalRequestId, actorUserId, comment } = input;
  const now = input.now || new Date();
  return withTx(tx, db, async (t) => {
    const request = await t.approvalRequest.findFirst({ where: { id: approvalRequestId } });
    if (!request) throw err('NOT_FOUND', 'Approval request not found', 404);
    if (!['PENDING', 'ESCALATED'].includes(request.status)) {
      // WITHDRAWN is allowed from an already-decided-but-still-open state too; keep
      // it strict here — only open requests cancel/withdraw.
      throw err('NOT_OPEN', `Request is ${request.status}, cannot ${status}`, 409);
    }
    const flip = await t.approvalRequest.updateMany({
      where: { id: request.id, status: request.status, version: request.version },
      data: { status, completedAt: now, slaDueAt: null, version: { increment: 1 } },
    });
    if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Approval request changed concurrently', 409);
    await t.approvalAction.create({
      data: {
        businessId: request.businessId, approvalRequestId: request.id, stepOrder: request.currentStepOrder,
        approverUserId: actorUserId || 'REQUESTER', decision: 'ABSTAINED',
        comment: comment || status, actedAt: now,
      },
    });
    const fresh = await t.approvalRequest.findUnique({ where: { id: request.id } });
    await consumers.fire(request.module, hook, fresh, t);
    return { approvalRequest: fresh, terminal: status };
  });
}

function cancel(input, tx) { return terminalByRequester(input, tx, 'CANCELLED', 'onCancel'); }
function withdraw(input, tx) { return terminalByRequester(input, tx, 'WITHDRAWN', 'onCancel'); }

// ── helpers ─────────────────────────────────────────────────────────────────────
function businessId(request) { return request.businessId; }

async function requesterUserIdOf(request, bizId, t) {
  if (!request.requesterEmployeeId) return null;
  const emp = await t.employee.findFirst({
    where: { id: request.requesterEmployeeId, businessId: request.businessId },
    select: { userId: true },
  });
  return emp ? emp.userId : null;
}

// Emit one "you have an approval" Notification per approver (deduped). Best-effort:
// a notification failure must not roll back the approval transition.
async function notifyApprovers(bizId, request, userIds, t) {
  const recipients = [...new Set((userIds || []).filter((u) => u && u !== 'SYSTEM'))];
  for (const uid of recipients) {
    try {
      await t.notification.create({
        data: {
          businessId: bizId, recipientUserId: uid, type: 'APPROVAL_PENDING', channel: 'IN_APP',
          title: 'Approval needed',
          body: `A ${request.module} request is awaiting your decision.`,
          entityType: 'ApprovalRequest', entityId: request.id,
          dataJson: { module: request.module, approvalRequestId: request.id },
        },
      });
    } catch (_e) { /* best-effort; notification schema enum mismatch must not break flow */ }
  }
  // Real-channel fan-out (email/WhatsApp/push) WITH a deep-link. Fire-and-forget +
  // OUTSIDE the engine tx (uses the default prisma client) so a notify failure can
  // never roll back the approval transition. The in-app rows above are the source of
  // truth and are written regardless.
  notify.fanOutApprovalPending({ businessId: bizId, request, approverUserIds: recipients }).catch(() => {});
}

// ── previewChain (PURE — reads only, no writes) ──────────────────────────────────
/**
 * previewChain({ businessId, module, requesterEmployee, ctx, definition? }) ->
 *   [ { stepOrder, label, approverUserIds, approverNames?, minApprovals, slaHours, autoApprove } ]
 * Powers the builder "preview for a sample request" + the ESS "who will approve this?"
 * hint. Resolves approvers exactly as the engine would, but writes nothing.
 */
async function previewChain(input) {
  const db = input.prismaClient || prismaDefault;
  const { businessId: bizId, module, ctx = {} } = input;
  const now = input.now || new Date();

  let requesterEmployee = input.requesterEmployee || null;
  if (!requesterEmployee && input.requesterEmployeeId) {
    requesterEmployee = await db.employee.findFirst({
      where: { id: input.requesterEmployeeId, businessId: bizId },
      select: { id: true, businessId: true, userId: true, managerEmployeeId: true },
    });
  }

  let steps;
  if (input.definition && Array.isArray(input.definition.steps)) {
    steps = input.definition.steps;
  } else {
    const resolved = await resolveDefinition(bizId, module, ctx, { prismaClient: db });
    steps = resolved.steps;
  }
  const levels = groupLevels(steps);

  const out = [];
  for (const level of levels) {
    const resolved = await resolveLevel(level, ctx, requesterEmployee, bizId, module, now, db);
    if (!resolved.applicable) {
      out.push({ stepOrder: level.stepOrder, label: level.steps.map((s) => s.name).join(' + '), skipped: true });
      continue;
    }
    out.push({
      stepOrder: level.stepOrder,
      label: resolved.appliedSteps.map((s) => s.name).join(' + '),
      approverUserIds: resolved.userIds,
      minApprovals: resolved.minApprovals,
      slaHours: resolved.appliedSteps.map((s) => s.slaHours).filter((h) => h != null)[0] || null,
      autoApprove: resolved.autoApprove,
      escalationReason: resolved.escalationReason || null,
    });
  }
  return out;
}

module.exports = {
  openRequest,
  recordDecision,
  advance,
  cancel,
  withdraw,
  previewChain,
  isConcurrencyError,
  // exported for tests
  _internals: { groupLevels, applicableSteps, resolveLevel, chainSnapshot, levelSlaDueAt },
};

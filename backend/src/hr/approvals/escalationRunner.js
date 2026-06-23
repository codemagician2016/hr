'use strict';

/**
 * escalationRunner.js — Feature 10 §5.5 SLA sweep (cron). Copies the
 * accrualRunner.js pattern: tenant loop, --dry-run, idempotent, version-guarded.
 *
 *   sweepEscalations({ businessId?, asOf?, dryRun? }) -> { scanned, remind,
 *     escalated, autoApproved, autoRejected, skipped, errors }
 *
 * For each ApprovalRequest with status PENDING and slaDueAt < now, read the ACTIVE
 * level's onTimeoutAction (from the chain snapshot in payloadJson._chain) and apply:
 *   REMIND       → re-notify the active approver set; push slaDueAt forward one SLA
 *                  window (so it nags, doesn't spam). Idempotent per window.
 *   ESCALATE     → re-resolve the active step as REPORTING_MANAGER one level above
 *                  the timed-out approver, reassign + notify, stamp ESCALATED
 *                  provenance on the action log, reset slaDueAt. No higher manager →
 *                  HR fallback.
 *   AUTO_APPROVE → recordDecision as a SYSTEM actor (exempt from SoD; not the
 *                  requester) → completes the level / chain via the normal engine.
 *   AUTO_REJECT  → recordDecision(REJECTED) as the SYSTEM actor.
 *
 * Concurrency: every state change is version-guarded; two overlapping runs can't
 * double-escalate the same request (a stale-version write is a no-op). The engine's
 * own version locks back this up for the AUTO_* path.
 *
 * CLI: node src/hr/approvals/escalationRunner.js [--dry-run] [--business=<id>]
 */

const prisma = require('../../core/lib/prisma');
const engine = require('./engine');
const { walkManagers, usersWithPermission } = require('./approverResolver');

const SYSTEM_ACTOR = 'SYSTEM';

// The active level's onTimeoutAction + slaHours, from the snapshot for currentStepOrder.
function activeTimeout(request) {
  const snap = request.payloadJson && request.payloadJson._chain;
  if (!snap || !Array.isArray(snap.levels)) return { onTimeoutAction: 'ESCALATE', slaHours: null };
  const lvl = snap.levels.find((l) => l.stepOrder === request.currentStepOrder);
  if (!lvl || !lvl.steps || !lvl.steps.length) return { onTimeoutAction: 'ESCALATE', slaHours: null };
  // tightest SLA + the FIRST step's timeout action (a level's steps share an action
  // in practice; the first one drives the sweep decision).
  const slas = lvl.steps.map((s) => s.slaHours).filter((h) => h != null && h > 0);
  return {
    onTimeoutAction: lvl.steps[0].onTimeoutAction || 'ESCALATE',
    slaHours: slas.length ? Math.min(...slas) : null,
  };
}

async function sweepEscalations({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  const summary = { scanned: 0, remind: 0, escalated: 0, autoApproved: 0, autoRejected: 0, skipped: 0, errors: 0 };

  const where = {
    status: 'PENDING',
    slaDueAt: { not: null, lt: now },
    ...(businessId ? { businessId } : {}),
  };
  const requests = await prisma.approvalRequest.findMany({ where, take: 5000, orderBy: { slaDueAt: 'asc' } });

  for (const request of requests) {
    summary.scanned += 1;
    const { onTimeoutAction, slaHours } = activeTimeout(request);
    try {
      if (onTimeoutAction === 'REMIND') {
        if (dryRun) { summary.remind += 1; continue; }
        await remind(request, slaHours, now);
        summary.remind += 1;
      } else if (onTimeoutAction === 'ESCALATE') {
        if (dryRun) { summary.escalated += 1; continue; }
        const did = await escalate(request, slaHours, now);
        if (did) summary.escalated += 1; else summary.skipped += 1;
      } else if (onTimeoutAction === 'AUTO_APPROVE') {
        if (dryRun) { summary.autoApproved += 1; continue; }
        await engine.recordDecision({ approvalRequestId: request.id, actorUserId: SYSTEM_ACTOR, decision: 'APPROVED', comment: 'SLA timeout auto-decision', systemActor: true, now });
        summary.autoApproved += 1;
      } else if (onTimeoutAction === 'AUTO_REJECT') {
        if (dryRun) { summary.autoRejected += 1; continue; }
        await engine.recordDecision({ approvalRequestId: request.id, actorUserId: SYSTEM_ACTOR, decision: 'REJECTED', comment: 'SLA timeout auto-decision', systemActor: true, now });
        summary.autoRejected += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (e) {
      // a concurrency loss / already-decided race is safe to ignore (idempotent).
      if (engine.isConcurrencyError(e) || e.code === 'NOT_PENDING') { summary.skipped += 1; continue; }
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[escalation] request', request.id, e.message);
    }
  }
  return summary;
}

// REMIND: re-notify + push slaDueAt forward one window (version-guarded so a double
// run doesn't push twice in the same sweep).
async function remind(request, slaHours, now) {
  const windowMs = (slaHours && slaHours > 0 ? slaHours : 24) * 3600 * 1000;
  const next = new Date(now.getTime() + windowMs);
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.approvalRequest.findUnique({ where: { id: request.id } });
    if (!fresh || fresh.status !== 'PENDING') return;
    const active = fresh.payloadJson && fresh.payloadJson._active;
    const flip = await tx.approvalRequest.updateMany({
      where: { id: request.id, status: 'PENDING', version: fresh.version },
      data: { slaDueAt: next, version: { increment: 1 } },
    });
    if (flip.count === 0) return; // raced; safe no-op
    for (const uid of (active && active.approverUserIds) || []) {
      if (!uid || uid === SYSTEM_ACTOR) continue;
      try {
        await tx.notification.create({
          data: {
            businessId: request.businessId, recipientUserId: uid, type: 'APPROVAL_PENDING', channel: 'IN_APP',
            title: 'Reminder: approval still pending',
            body: `A ${request.module} request is still awaiting your decision.`,
            entityType: 'ApprovalRequest', entityId: request.id,
            dataJson: { module: request.module, approvalRequestId: request.id, reminder: true },
          },
        });
      } catch (_e) { /* best-effort */ }
    }
  });
}

// ESCALATE: add one-manager-up of the timed-out approver(s) to the active set; if no
// higher manager, fall to HR. Stamp ESCALATED provenance + reset slaDueAt.
async function escalate(request, slaHours, now) {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.approvalRequest.findUnique({ where: { id: request.id } });
    if (!fresh || fresh.status !== 'PENDING') return false;
    const active = (fresh.payloadJson && fresh.payloadJson._active) || { approverUserIds: [] };

    // resolve "one manager above" the requester as the escalation target (the
    // simplest, cycle-safe choice that mirrors REPORTING_MANAGER N-up semantics).
    let escalationUsers = [];
    if (fresh.requesterEmployeeId) {
      const reqEmp = await tx.employee.findFirst({ where: { id: fresh.requesterEmployeeId, businessId: fresh.businessId }, select: { id: true, businessId: true, managerEmployeeId: true } });
      if (reqEmp) {
        // two levels up from the requester = one above the (timed-out) direct manager.
        const twoUp = await walkManagers(reqEmp, fresh.businessId, '2');
        if (twoUp.length) {
          const emps = await tx.employee.findMany({ where: { id: { in: twoUp }, businessId: fresh.businessId, deletedAt: null, userId: { not: null } }, select: { userId: true } });
          escalationUsers = emps.map((e) => e.userId).filter(Boolean);
        }
      }
    }
    if (escalationUsers.length === 0) {
      // HR fallback
      escalationUsers = await usersWithPermission(fresh.businessId, 'canApproveLeave');
    }
    // never route to the requester (SoD).
    const reqUserId = await requesterUserId(tx, fresh);
    escalationUsers = [...new Set(escalationUsers)].filter((u) => u && u !== reqUserId);
    if (escalationUsers.length === 0) return false; // nobody to escalate to — leave as-is

    const payload = { ...(fresh.payloadJson || {}) };
    const newActive = { ...(payload._active || {}) };
    newActive.approverUserIds = [...new Set([...(newActive.approverUserIds || []), ...escalationUsers])];
    newActive.escalationReason = 'SLA_ESCALATED';
    payload._active = newActive;

    const windowMs = (slaHours && slaHours > 0 ? slaHours : 24) * 3600 * 1000;
    const flip = await tx.approvalRequest.updateMany({
      where: { id: request.id, status: 'PENDING', version: fresh.version },
      data: { status: 'ESCALATED', slaDueAt: new Date(now.getTime() + windowMs), payloadJson: payload, version: { increment: 1 } },
    });
    if (flip.count === 0) return false; // raced
    // ESCALATED is a provenance marker; flip it back to PENDING so the engine's
    // recordDecision (which requires PENDING) still accepts the escalated approver.
    await tx.approvalRequest.updateMany({ where: { id: request.id, status: 'ESCALATED' }, data: { status: 'PENDING' } });
    await tx.approvalAction.create({
      data: {
        businessId: request.businessId, approvalRequestId: request.id, stepOrder: fresh.currentStepOrder,
        approverUserId: SYSTEM_ACTOR, decision: 'ABSTAINED', comment: `SLA escalation → added ${escalationUsers.length} approver(s)`,
      },
    });
    for (const uid of escalationUsers) {
      try {
        await tx.notification.create({
          data: {
            businessId: request.businessId, recipientUserId: uid, type: 'APPROVAL_PENDING', channel: 'IN_APP',
            title: 'Escalated to you', body: `A ${request.module} request was escalated to you after an SLA timeout.`,
            entityType: 'ApprovalRequest', entityId: request.id, dataJson: { module: request.module, approvalRequestId: request.id, escalated: true },
          },
        });
      } catch (_e) { /* best-effort */ }
    }
    return true;
  });
}

async function requesterUserId(tx, request) {
  if (!request.requesterEmployeeId) return null;
  const emp = await tx.employee.findFirst({ where: { id: request.requesterEmployeeId, businessId: request.businessId }, select: { userId: true } });
  return emp ? emp.userId : null;
}

// ── CLI entry (mirrors accrualRunner usage; same place the cron harness calls) ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const bizArg = args.find((a) => a.startsWith('--business='));
  const businessId = bizArg ? bizArg.split('=')[1] : null;
  sweepEscalations({ businessId, dryRun })
    .then((summary) => { console.log('[escalation] summary', JSON.stringify(summary)); return prisma.$disconnect(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[escalation] fatal', e); process.exit(1); });
}

module.exports = { sweepEscalations, _internals: { activeTimeout } };

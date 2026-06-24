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
const { matches } = require('./conditions');
// Cycle 0 — real-channel SLA fan-out (email/WhatsApp/push). Fire-and-forget; runs
// AFTER the version-guarded tx commits so it never affects the sweep's idempotency.
const notify = require('./notify');

const SYSTEM_ACTOR = 'SYSTEM';

// Terminal employee statuses — mirrors approverResolver.TERMINATED_STATUSES. A person
// in one of these (or isActive:false) has left the company and must NEVER become a live
// escalation target, even if their portal User row still lingers as active.
const TERMINATED_STATUSES = ['TERMINATED', 'RETIRED'];

// Resolve the active escalation user(s) by walking UP the requester's manager chain,
// starting ABOVE the timed-out direct manager (level 2), and skipping any manager who is
// terminated/inactive/soft-deleted. Returns the userIds of the FIRST level up the chain
// that has at least one live manager-with-a-portal-user. Empty ⇒ caller does HR fallback.
async function activeEscalationTargets(tx, reqEmp, businessId) {
  // Full ancestor chain (cycle-guarded, depth-capped) in nearest-first order.
  const chain = await walkManagers(reqEmp, businessId, 'ALL');
  // Skip level 1 (the direct manager who timed out); escalate to one above and up.
  for (let i = 1; i < chain.length; i++) {
    const emp = await tx.employee.findFirst({
      where: {
        id: chain[i], businessId, deletedAt: null,
        isActive: true, status: { notIn: TERMINATED_STATUSES }, userId: { not: null },
      },
      select: { userId: true },
    });
    if (emp && emp.userId) return [emp.userId];
  }
  return [];
}

// The active level's onTimeoutAction + slaHours, from the snapshot for currentStepOrder.
// CRITICAL: a level can carry several steps whose conditionJson selects WHICH ones
// actually applied for this request's ctx (the engine drops non-matching steps — see
// engine.applicableSteps). The sweep MUST read the timeout action from the APPLIED
// step(s), not blindly from steps[0]: steps[0] may be an unmatched config (e.g. a
// high-value AUTO_REJECT branch) while the request actually landed on a REMIND step.
// Reading steps[0] could AUTO_REJECT (as the SYSTEM actor, bypassing SoD) a request
// that should only have been REMINDed. We therefore filter to the steps that match the
// snapshotted ctx and derive the action + tightest SLA from those.
function activeTimeout(request) {
  const snap = request.payloadJson && request.payloadJson._chain;
  if (!snap || !Array.isArray(snap.levels)) return { onTimeoutAction: 'ESCALATE', slaHours: null };
  const lvl = snap.levels.find((l) => l.stepOrder === request.currentStepOrder);
  if (!lvl || !lvl.steps || !lvl.steps.length) return { onTimeoutAction: 'ESCALATE', slaHours: null };
  // The ctx the chain was resolved against (snapshotted at openRequest time). Use it to
  // select the steps that genuinely applied — exactly the set the engine activated.
  const ctx = (request.payloadJson && request.payloadJson._ctx) || {};
  let applied = lvl.steps.filter((s) => matches(s.conditionJson, ctx));
  // Defensive: if nothing matches (legacy snapshot / missing ctx), fall back to the
  // whole level rather than mis-deriving from a single arbitrary step.
  if (!applied.length) applied = lvl.steps;
  // tightest SLA across the APPLIED steps.
  const slas = applied.map((s) => s.slaHours).filter((h) => h != null && h > 0);
  // The timeout action of the applied step bearing the tightest SLA (the step whose
  // clock actually expired). Falls back to the first applied step when no SLA is set.
  let driver = applied[0];
  if (slas.length) {
    const minSla = Math.min(...slas);
    driver = applied.find((s) => s.slaHours === minSla) || applied[0];
  }
  return {
    onTimeoutAction: (driver && driver.onTimeoutAction) || 'ESCALATE',
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
  // Capture the notified approver set + the freshly-bumped request so the real-channel
  // fan-out runs AFTER the tx commits (never inside it).
  let notified = null;
  let fresh = null;
  let windowKey = null;
  await prisma.$transaction(async (tx) => {
    fresh = await tx.approvalRequest.findUnique({ where: { id: request.id } });
    if (!fresh || fresh.status !== 'PENDING') { fresh = null; return; }
    const active = fresh.payloadJson && fresh.payloadJson._active;
    const flip = await tx.approvalRequest.updateMany({
      where: { id: request.id, status: 'PENDING', version: fresh.version },
      data: { slaDueAt: next, version: { increment: 1 } },
    });
    if (flip.count === 0) { fresh = null; return; } // raced; safe no-op
    // Per-window discriminator for the reminder dedupe token. The version is bumped
    // exactly once per successful remind window, so the post-bump version uniquely and
    // monotonically identifies THIS window — letting each due window send its reminder
    // exactly once while a same-window double-run (same pre-bump version) still dedupes.
    windowKey = fresh.version + 1;
    notified = [];
    for (const uid of (active && active.approverUserIds) || []) {
      if (!uid || uid === SYSTEM_ACTOR) continue;
      notified.push(uid);
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
  // Post-commit REMINDER fan-out (email/WhatsApp/push) with a deep-link. The dedupe
  // token embeds reminderWindowKey (the bumped version), so a nag pushed within the SAME
  // window won't re-send, but each genuinely-new SLA window sends its reminder exactly
  // once (the prior bug keyed only on currentStepOrder, which never changes on REMIND, so
  // only ONE reminder ever left). Best-effort; never throws.
  if (fresh && notified && notified.length) {
    await notify.fanOutApprovalPending({
      businessId: request.businessId, request: fresh, approverUserIds: notified, reminder: true,
      reminderWindowKey: windowKey,
    }).catch(() => {});
  }
}

// ESCALATE: add one-manager-up of the timed-out approver(s) to the active set; if no
// higher manager, fall to HR. Stamp ESCALATED provenance + reset slaDueAt.
async function escalate(request, slaHours, now) {
  // Capture for the post-commit fan-out (run OUTSIDE the tx so it can't affect it).
  let escalatedUsers = null;
  let freshAfter = null;
  const did = await prisma.$transaction(async (tx) => {
    const fresh = await tx.approvalRequest.findUnique({ where: { id: request.id } });
    if (!fresh || fresh.status !== 'PENDING') return false;
    const active = (fresh.payloadJson && fresh.payloadJson._active) || { approverUserIds: [] };

    // resolve "one manager above" the requester as the escalation target, applying the
    // terminated/inactive lockout: a separated manager (status TERMINATED/RETIRED or
    // isActive:false) is skipped and we climb to the NEXT live manager up the chain
    // (activeEscalationTargets). This mirrors the leave/ESS terminated-employee lockout —
    // an SLA timeout must never route an open request to someone who has left the company.
    let escalationUsers = [];
    if (fresh.requesterEmployeeId) {
      const reqEmp = await tx.employee.findFirst({ where: { id: fresh.requesterEmployeeId, businessId: fresh.businessId }, select: { id: true, businessId: true, managerEmployeeId: true } });
      if (reqEmp) {
        escalationUsers = await activeEscalationTargets(tx, reqEmp, fresh.businessId);
      }
    }
    if (escalationUsers.length === 0) {
      // HR fallback (usersWithPermission already excludes terminated/inactive users).
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
    // Stash for the post-commit real-channel fan-out.
    escalatedUsers = escalationUsers;
    freshAfter = await tx.approvalRequest.findUnique({ where: { id: request.id } });
    return true;
  });
  // Post-commit fan-out (email/WhatsApp/push) to the newly-added escalation approvers,
  // with a deep-link. currentStepOrder is unchanged by escalation, so the PEND dedupe
  // token is distinct per approver — newly-added escalation approvers (who were not on
  // the original set) get notified exactly once. Best-effort; never throws.
  if (did && freshAfter && escalatedUsers && escalatedUsers.length) {
    await notify.fanOutApprovalPending({
      businessId: request.businessId, request: freshAfter, approverUserIds: escalatedUsers,
    }).catch(() => {});
  }
  return did;
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

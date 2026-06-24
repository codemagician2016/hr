'use strict';

/**
 * notify.js — Cycle 0 notification fan-out for the approval/SLA surface.
 *
 * The approval engine, escalation runner, and leave/expense consumers already write
 * an IN_APP Notification row (the inbox is the source of truth and is NEVER skipped).
 * This module ADDS the real-channel fan-out (email + WhatsApp/SMS via the EXISTING
 * router) WITH a deep-link, so an approver/requester gets the message on their phone/
 * inbox — not just in-app.
 *
 * It does NOT introduce a transport: it resolves the recipient's contact + channel
 * preferences and calls notifyHrEvent() → sendNotification() (the existing smart
 * router), which already enforces the per-tenant budget/opt-out engine, the universal
 * STOP list, country availability and the email-always-on fallback. If no SMS/WhatsApp
 * provider is configured for the tenant, the router falls back to email; if no email
 * either, it returns ok:false cleanly — never throws.
 *
 * Guarantees:
 *   - BEST-EFFORT / NON-BLOCKING: every public fn resolves to a summary and NEVER
 *     throws. Call-sites fire-and-forget (no await on the approval tx) — a notify
 *     failure can never break an approval/leave/expense transaction.
 *   - TENANT-SAFE: every recipient lookup is scoped by businessId.
 *   - IDEMPOTENT: each send carries a deterministic dedupe token in triggeredBy; a
 *     prior successful/blocked delivery with the same token short-circuits, so a retry
 *     (or an overlapping SLA sweep) does not double-send.
 *   - PREFERENCE-AWARE: per-employee notifyPrefs.optOut suppresses fan-out; a
 *     notifyPrefs.channels map narrows (never widens) the cascade. This sits ON TOP of
 *     the existing tenant budget/opt-out engine — it can only suppress, never bypass.
 *
 * This module must do its OWN reads OUTSIDE the engine transaction (it uses the default
 * prisma client, not the engine's `tx`), because the router writes MessageDelivery rows
 * and would otherwise be entangled with — and could roll back — the approval commit.
 */

const prisma = require('../../core/lib/prisma');
const { notifyHrEvent } = require('../integrations/notifications');

const BIZ_FALLBACK = 'DriftHR';

// Resolve the app base URL for deep-links. Mirrors core/lib/inbox.js precedence so
// links point at the same surface the rest of the platform uses. Trailing slash trimmed.
function appBaseUrl() {
  const base = process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL;
  if (base) return String(base).replace(/\/$/, '');
  return `https://${process.env.PLATFORM_DOMAIN || 'drifthr.com'}`;
}

// Deep-link for an approver: the approvals inbox, focused on this request.
function approvalDeepLink(requestId) {
  return `${appBaseUrl()}/approvals?request=${encodeURIComponent(requestId || '')}`;
}

// Deep-link for a requester: the module surface for the decided entity.
//   LEAVE   → /leave/<id>
//   EXPENSE → /expenses/<id>
//   else    → /approvals?request=<id>
function moduleDeepLink(module, entityId, requestId) {
  const base = appBaseUrl();
  const m = String(module || '').toUpperCase();
  if (m === 'LEAVE' && entityId) return `${base}/leave/${encodeURIComponent(entityId)}`;
  if (m === 'EXPENSE' && entityId) return `${base}/expenses/${encodeURIComponent(entityId)}`;
  if (m === 'TRAVEL' && entityId) return `${base}/travel/${encodeURIComponent(entityId)}`;
  return `${base}/approvals?request=${encodeURIComponent(requestId || '')}`;
}

// A human label for a module, used in copy ("a Leave request …").
function moduleLabel(module) {
  const m = String(module || '').toUpperCase();
  const map = { LEAVE: 'Leave', EXPENSE: 'Expense', TRAVEL: 'Travel', PROFILE_CHANGE: 'Profile change' };
  return map[m] || (module ? module.charAt(0) + module.slice(1).toLowerCase() : 'Request');
}

function displayName(emp) {
  if (!emp) return null;
  const n = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim();
  return n || emp.code || null;
}

// Resolve a recipient's contact + name + channel prefs by USER id (tenant-scoped).
// Returns null if the user has no Employee in this tenant (e.g. a pure-admin user with
// no HR profile) — the caller still keeps the IN_APP row; fan-out is just skipped.
async function recipientByUserId(businessId, userId) {
  if (!userId || userId === 'SYSTEM') return null;
  const emp = await prisma.employee.findFirst({
    where: { businessId, userId, deletedAt: null },
    select: {
      id: true, code: true, firstName: true, lastName: true,
      workEmail: true, personalEmail: true, phone: true, countryCode: true,
      notifyPrefs: true,
    },
  }).catch(() => null);
  if (emp) {
    return {
      employeeId: emp.id,
      name: displayName(emp),
      email: emp.workEmail || emp.personalEmail || null,
      phone: emp.phone || null,
      country: emp.countryCode || null,
      prefs: emp.notifyPrefs || null,
    };
  }
  // Fallback: a user with no employee profile — use the portal email so they still
  // get the mail (router will email-only). No phone/prefs available.
  const user = await prisma.user.findFirst({
    where: { id: userId, businessId },
    select: { email: true, name: true },
  }).catch(() => null);
  if (!user) return null;
  return { employeeId: null, name: user.name || null, email: user.email || null, phone: null, country: null, prefs: null };
}

// Resolve a recipient by EMPLOYEE id (tenant-scoped) — used for the requester side.
async function recipientByEmployeeId(businessId, employeeId) {
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { businessId, id: employeeId, deletedAt: null },
    select: {
      id: true, code: true, firstName: true, lastName: true,
      workEmail: true, personalEmail: true, phone: true, countryCode: true,
      notifyPrefs: true,
    },
  }).catch(() => null);
  if (!emp) return null;
  return {
    employeeId: emp.id,
    name: displayName(emp),
    email: emp.workEmail || emp.personalEmail || null,
    phone: emp.phone || null,
    country: emp.countryCode || null,
    prefs: emp.notifyPrefs || null,
  };
}

// Apply the per-employee preference. Returns one of:
//   { suppressed: true }                              — employee opted out of fan-out
//   { phone, email }                                  — possibly narrowed contact
// A `channels` map of { email, whatsapp, sms } narrows what we even pass to the router:
// dropping the phone disables SMS+WhatsApp; dropping email disables email. This can only
// SUPPRESS a channel; the router's budget/opt-out engine still governs the rest.
function applyPrefs(recipient) {
  const prefs = recipient && recipient.prefs;
  if (prefs && (prefs.optOut === true || prefs.optOutHrNotify === true)) {
    return { suppressed: true };
  }
  let { email, phone } = recipient;
  const ch = prefs && prefs.channels;
  if (ch && typeof ch === 'object') {
    // If the employee explicitly disabled BOTH phone channels, drop the phone so the
    // router never attempts SMS/WhatsApp for them.
    if (ch.whatsapp === false && ch.sms === false) phone = null;
    if (ch.email === false) email = null;
  }
  return { suppressed: false, email, phone };
}

// Idempotency: has an equivalent notification already left (or been blocked at) the
// router for this dedupe token? We encode the token into MessageDelivery.triggeredBy at
// send time, so a prior row with the same token means "already handled". A FAILED row
// does NOT count (we allow a genuine retry of a transient provider failure).
async function alreadySent(businessId, dedupeToken) {
  if (!dedupeToken) return false;
  const row = await prisma.messageDelivery.findFirst({
    where: {
      businessId,
      triggeredBy: dedupeToken,
      status: { in: ['SENT', 'DELIVERED', 'BLOCKED_OPTOUT'] },
    },
    select: { id: true },
  }).catch(() => null);
  return !!row;
}

// Core single-recipient send. Resolves contact, applies prefs, dedupes, then calls the
// existing router via notifyHrEvent. NEVER throws — returns a small summary.
async function dispatchOne({ businessId, recipient, event, variables, dedupeToken }) {
  try {
    if (!recipient) return { ok: false, reason: 'NO_RECIPIENT' };
    const pref = applyPrefs(recipient);
    if (pref.suppressed) return { ok: false, reason: 'EMPLOYEE_OPTED_OUT' };
    if (!pref.email && !pref.phone) return { ok: false, reason: 'NO_CONTACT' };

    if (await alreadySent(businessId, dedupeToken)) {
      return { ok: true, reason: 'ALREADY_SENT', deduped: true };
    }

    const res = await notifyHrEvent({
      businessId,
      event,
      recipientEmail: pref.email || null,
      recipientPhone: pref.phone || null,
      recipientCountry: recipient.country || undefined,
      variables,
      // The dedupe token doubles as the correlation tag persisted to
      // MessageDelivery.triggeredBy, which is exactly what alreadySent() reads back.
      triggeredBy: dedupeToken,
    });
    return res || { ok: false, reason: 'NO_RESULT' };
  } catch (e) {
    // Belt-and-braces: notifyHrEvent/router are designed not to throw, but a recipient
    // lookup or an unexpected error must never bubble into the approval flow.
    return { ok: false, reason: 'DISPATCH_ERROR', error: e && e.message };
  }
}

// ── Public fan-out helpers (best-effort; never throw) ─────────────────────────

/**
 * fanOutApprovalPending — notify each pending approver (by userId) that a request
 * awaits them. Mirrors engine.notifyApprovers' recipient set. IN_APP is written by the
 * engine; this adds email/WhatsApp/push.
 */
async function fanOutApprovalPending({ businessId, request, approverUserIds, reminder = false }) {
  const summary = { sent: 0, skipped: 0, total: 0 };
  try {
    const ids = [...new Set((approverUserIds || []).filter((u) => u && u !== 'SYSTEM'))];
    summary.total = ids.length;
    const requester = request.requesterEmployeeId
      ? await recipientByEmployeeId(businessId, request.requesterEmployeeId)
      : null;
    const requesterName = (requester && requester.name) || 'an employee';
    const event = reminder ? 'approval.reminder' : 'approval.pending';
    const link = approvalDeepLink(request.id);
    for (const uid of ids) {
      const recipient = await recipientByUserId(businessId, uid);
      const variables = {
        NAME: (recipient && recipient.name) || 'there',
        MODULE: moduleLabel(request.module),
        REQUESTER: requesterName,
        BIZ: BIZ_FALLBACK,
        LINK: link,
      };
      // Token: scope by request + step + recipient + kind so a re-activation of the
      // SAME level for the SAME approver doesn't double-send, but a genuine new SLA
      // reminder window (escalation bumps the step/level) can re-notify.
      const kind = reminder ? 'REM' : 'PEND';
      const token = `HR_${kind}:${request.id}:${request.currentStepOrder}:${uid}`;
      const r = await dispatchOne({ businessId, recipient, event, variables, dedupeToken: token });
      if (r && r.ok) summary.sent += 1; else summary.skipped += 1;
    }
  } catch (_e) { /* best-effort */ }
  return summary;
}

/**
 * fanOutApprovalDecided — notify the REQUESTER that their request was approved/rejected/
 * cancelled. Resolved by requesterEmployeeId. IN_APP for the requester is module-
 * specific (or absent); this guarantees they hear about the outcome on a real channel.
 */
async function fanOutApprovalDecided({ businessId, request, outcome }) {
  const summary = { sent: 0, skipped: 0 };
  try {
    const recipient = request.requesterEmployeeId
      ? await recipientByEmployeeId(businessId, request.requesterEmployeeId)
      : null;
    if (!recipient) { summary.skipped = 1; return summary; }
    let deciderName = 'your approver';
    if (request.decidedBy) {
      const decider = await recipientByUserId(businessId, request.decidedBy);
      if (decider && decider.name) deciderName = decider.name;
    }
    const variables = {
      NAME: recipient.name || 'there',
      MODULE: moduleLabel(request.module),
      OUTCOME: String(outcome || 'updated').toLowerCase(),
      DECIDER: deciderName,
      BIZ: BIZ_FALLBACK,
      LINK: moduleDeepLink(request.module, request.entityId, request.id),
    };
    // Token scoped by request + outcome — a request reaches a terminal outcome once, so
    // a retried consumer (or duplicated hook) won't double-send.
    const token = `HR_DEC:${request.id}:${String(outcome || '').toUpperCase()}`;
    const r = await dispatchOne({ businessId, recipient, event: 'approval.decided', variables, dedupeToken: token });
    if (r && r.ok) summary.sent = 1; else summary.skipped = 1;
  } catch (_e) { /* best-effort */ }
  return summary;
}

module.exports = {
  fanOutApprovalPending,
  fanOutApprovalDecided,
  // exported for tests / reuse
  _internals: {
    appBaseUrl, approvalDeepLink, moduleDeepLink, moduleLabel, displayName,
    recipientByUserId, recipientByEmployeeId, applyPrefs, alreadySent, dispatchOne,
  },
};

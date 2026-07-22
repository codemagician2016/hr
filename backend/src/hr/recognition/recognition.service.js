'use strict';

/**
 * recognition.service.js — Feature 35 §4.2. The peer-to-peer give path + the shared
 * POSTING core (credit recipients + project to the feed) used by BOTH the inline
 * (no-approval) path and the RECOGNITION consumer's onApprove.
 *
 * Flow (spec §4.2):
 *   1. validate (self-recognition blocked, recipients active + distinct + in-tenant,
 *      message required, pointsEach clamped, daily give cap, same-pair spam window)
 *   2. totalPoints = pointsEach × recipients; evaluateGive (threshold + budget)
 *   3. needsApproval → status PENDING_APPROVAL + engine.openRequest(RECOGNITION)
 *      else → POSTED immediately (points post inline, projection + notify)
 *   4. the consumer mirrors step 3's else-branch inside the engine tx on approve.
 *
 * Idempotency: recipient credits are guarded by ledgerEntryId still being null;
 * status flips are conditional updateMany; the projector no-ops on announcementId.
 */

const prismaDefault = require('../../core/lib/prisma');
const engine = require('../approvals/engine');
const pointsLedger = require('./pointsLedger');
const { getConfig } = require('./config');
const { resolveBudgetState, evaluateGive } = require('./budget');
const { projectRecognitionToFeed } = require('./feedProjector');
const { notifyHrEvent } = require('../integrations/notifications');

const MAX_RECIPIENTS = 20;
const SAME_PAIR_DAILY_CAP = 2; // same giver → same recipient, per day (kudos-farming guard)
const MAX_MESSAGE = 2000;
const ESS_WALL_LINK = '/feed';

function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function emailOf(emp) { return emp ? (emp.workEmail || emp.personalEmail || null) : null; }
function fullName(emp) { return emp ? ([emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code || 'A colleague') : 'A colleague'; }

// ── give ─────────────────────────────────────────────────────────────────────
/**
 * give({ businessId, giver, input }) — giver is the SESSION-resolved employee row.
 * input: { recipientEmployeeIds[], valueId?, badgeId?, message, pointsEach?, visibility? }
 * Returns { recognition, needsApproval } | { error } | { conflict, message }.
 */
async function give({ businessId, giver, input = {}, now = new Date() }) {
  const config = await getConfig(businessId);

  // ── recipients ──
  const rawIds = Array.isArray(input.recipientEmployeeIds) ? input.recipientEmployeeIds : [];
  const recipientIds = [...new Set(rawIds.filter((x) => typeof x === 'string' && x))];
  if (!recipientIds.length) return { error: 'recipientEmployeeIds must name at least one colleague' };
  if (recipientIds.length > MAX_RECIPIENTS) return { error: `A recognition can name at most ${MAX_RECIPIENTS} colleagues` };
  if (recipientIds.includes(giver.id)) return { error: 'You cannot recognise yourself' };

  const recipients = await prismaDefault.employee.findMany({
    where: { businessId, id: { in: recipientIds }, deletedAt: null, isActive: true, status: { notIn: ['TERMINATED', 'RETIRED'] } },
    select: { id: true },
  });
  if (recipients.length !== recipientIds.length) {
    return { error: 'One or more recipients are not active employees of this company' };
  }

  // ── message ──
  const message = String(input.message || '').trim();
  if (!message) return { error: 'message is required — say why they deserve it' };

  // ── value / badge (optional, tenant-validated) ──
  let valueId = null;
  if (input.valueId) {
    const v = await prismaDefault.recognitionValue.findFirst({ where: { id: String(input.valueId), businessId, isActive: true }, select: { id: true } });
    if (!v) return { error: 'Unknown or retired company value' };
    valueId = v.id;
  }
  let badge = null;
  if (input.badgeId) {
    badge = await prismaDefault.recognitionBadge.findFirst({ where: { id: String(input.badgeId), businessId, isActive: true }, select: { id: true, defaultPoints: true } });
    if (!badge) return { error: 'Unknown or retired badge' };
  }

  // ── points (clamped; forced 0 when the points economy is off) ──
  let pointsEach = 0;
  if (config.pointsEnabled) {
    const requested = input.pointsEach === undefined && badge ? badge.defaultPoints : Number(input.pointsEach || 0);
    if (!Number.isInteger(requested) || requested < 0) return { error: 'pointsEach must be a non-negative integer' };
    pointsEach = Math.min(requested, config.perGiveMaxPoints);
  }

  const visibility = ['PUBLIC', 'PRIVATE', 'TEAM'].includes(input.visibility) ? input.visibility : 'PUBLIC';

  // ── anti-spam: daily give cap + same-pair window ──
  const today = startOfToday(now);
  const givenToday = await prismaDefault.recognition.count({
    where: { businessId, giverEmployeeId: giver.id, createdAt: { gte: today }, status: { not: 'REJECTED' } },
  });
  if (givenToday >= config.peerGiveDailyCap) {
    return { conflict: 'DAILY_CAP', message: `You have reached today's limit of ${config.peerGiveDailyCap} recognitions` };
  }
  const pairCounts = await prismaDefault.recognitionRecipient.count({
    where: {
      businessId,
      employeeId: { in: recipientIds },
      recognition: { giverEmployeeId: giver.id, createdAt: { gte: today }, status: { not: 'REJECTED' } },
    },
  });
  if (pairCounts >= SAME_PAIR_DAILY_CAP * recipientIds.length) {
    return { conflict: 'PAIR_SPAM', message: 'You have already recognised these colleagues today — spread the love!' };
  }

  // ── budget + threshold gate ──
  const totalPoints = pointsEach * recipientIds.length;
  const budgetState = pointsEach > 0
    ? await resolveBudgetState(prismaDefault, { businessId, giverEmployeeId: giver.id, now })
    : { budget: null, allocated: null, consumed: 0, remaining: null };
  const verdict = evaluateGive({ config, totalPoints, remainingBudget: budgetState.remaining });

  // ── create (+ open the F10 request when governed) in ONE tx ──
  const created = await prismaDefault.$transaction(async (tx) => {
    let recognition = await tx.recognition.create({
      data: {
        businessId,
        giverEmployeeId: giver.id,
        valueId,
        badgeId: badge ? badge.id : null,
        message: message.slice(0, MAX_MESSAGE),
        pointsEach,
        visibility,
        status: verdict.needsApproval ? 'PENDING_APPROVAL' : 'POSTED',
        postedAt: verdict.needsApproval ? null : now,
        recipients: { create: recipientIds.map((id) => ({ businessId, employeeId: id })) },
      },
    });

    if (verdict.needsApproval) {
      const opened = await engine.openRequest({
        businessId,
        module: 'RECOGNITION',
        entityType: 'Recognition',
        entityId: recognition.id,
        requesterEmployeeId: giver.id,
        payload: {
          totalPoints,
          pointsEach,
          recipientCount: recipientIds.length,
          reasons: verdict.reasons,
          messagePreview: message.slice(0, 140),
        },
        ctx: { totalPoints, amount: totalPoints },
      }, tx);
      // A collapsed/auto chain approves inside openRequest — the consumer has
      // already POSTED + credited; re-read for the fresh status.
      await tx.recognition.updateMany({
        where: { id: recognition.id },
        data: { approvalRequestId: opened.approvalRequest.id },
      });
      recognition = await tx.recognition.findFirst({ where: { id: recognition.id } });
    } else {
      await postRecognitionTx(tx, { recognitionId: recognition.id, config, now });
      recognition = await tx.recognition.findFirst({ where: { id: recognition.id } });
    }
    return recognition;
  });

  // Post-commit best-effort: recipient notifications (only when actually POSTED) +
  // the giver's budget-low warning.
  if (created.status === 'POSTED') {
    notifyRecognitionPosted(created.id).catch(() => {});
  }
  if (budgetState.budget && budgetState.remaining != null) {
    const remainingAfter = Math.max(0, budgetState.remaining - totalPoints);
    if (remainingAfter <= budgetState.allocated * 0.1) {
      notifyBudgetLow({ businessId, giverId: giver.id, budgetState, remainingAfter }).catch(() => {});
    }
  }

  return { recognition: created, needsApproval: verdict.needsApproval };
}

// ── the shared posting core (inline give + consumer onApprove) ───────────────
/**
 * postRecognitionTx(tx, { recognitionId, config?, now }) — credit each recipient's
 * wallet (guarded on ledgerEntryId null), stamp postedAt, project to the feed.
 * The caller has already flipped/created status POSTED (conditional). Idempotent.
 */
async function postRecognitionTx(tx, { recognitionId, config = null, now = new Date() }) {
  const recognition = await tx.recognition.findFirst({ where: { id: recognitionId } });
  if (!recognition || recognition.status !== 'POSTED') return null;
  const cfg = config || await getConfig(recognition.businessId, { tx });

  if (cfg.pointsEnabled && recognition.pointsEach > 0) {
    const expiresAt = cfg.pointsExpiryMonths ? addMonths(now, cfg.pointsExpiryMonths) : null;
    const recipients = await tx.recognitionRecipient.findMany({
      where: { recognitionId: recognition.id, ledgerEntryId: null },
    });
    for (const rec of recipients) {
      const { entry } = await pointsLedger.credit(tx, {
        businessId: recognition.businessId,
        employeeId: rec.employeeId,
        points: recognition.pointsEach,
        reason: 'RECOGNITION',
        refType: 'Recognition',
        refId: recognition.id,
        expiresAt,
      });
      // Conditional stamp — a concurrent re-fire that lost the ledgerEntryId race
      // must NOT double-credit; updateMany(where ledgerEntryId null) is the guard.
      const stamped = await tx.recognitionRecipient.updateMany({
        where: { id: rec.id, ledgerEntryId: null },
        data: { pointsPosted: recognition.pointsEach, ledgerEntryId: entry.id },
      });
      if (stamped.count === 0) {
        // Lost the guard (already credited elsewhere) — reverse this credit to keep Σ intact.
        await pointsLedger.debit(tx, {
          businessId: recognition.businessId,
          employeeId: rec.employeeId,
          points: recognition.pointsEach,
          reason: 'REVERSAL',
          refType: 'Recognition',
          refId: recognition.id,
          note: 'Duplicate credit reversal',
        });
      }
    }
  }

  if (!recognition.postedAt) {
    await tx.recognition.updateMany({ where: { id: recognition.id, postedAt: null }, data: { postedAt: now } });
  }

  // Feed projection (no-ops if already projected).
  await projectRecognitionToFeed(tx, { recognition: { ...recognition, postedAt: recognition.postedAt || now }, now });
  return recognition;
}

// ── notifications (fire-and-forget, default prisma — NEVER inside a tx) ──────
async function notifyRecognitionPosted(recognitionId) {
  const r = await prismaDefault.recognition.findFirst({
    where: { id: recognitionId, status: 'POSTED' },
    include: {
      giver: { select: { firstName: true, lastName: true, code: true } },
      value: { select: { name: true } },
      recipients: { include: { employee: { select: { id: true, firstName: true, lastName: true, workEmail: true, personalEmail: true, phone: true, countryCode: true, userId: true, notifyPrefs: true } } } },
    },
  });
  if (!r) return 0;
  const biz = await prismaDefault.business.findUnique({ where: { id: r.businessId }, select: { name: true } }).catch(() => null);
  const bizName = (biz && biz.name) || 'your employer';
  let sent = 0;
  for (const rec of r.recipients) {
    const emp = rec.employee;
    if (!emp) continue;
    // In-app row (the inbox source of truth) — best-effort per recipient.
    if (emp.userId) {
      try {
        await prismaDefault.notification.create({
          data: {
            businessId: r.businessId,
            recipientUserId: emp.userId,
            type: 'ONBOARDING_TASK', // closest existing in-app type; dataJson carries the real kind
            channel: 'IN_APP',
            title: 'You were recognised! 🎉',
            body: `${fullName(r.giver)} recognised you${r.value ? ` for “${r.value.name}”` : ''}${rec.pointsPosted ? ` (+${rec.pointsPosted} points)` : ''}.`,
            entityType: 'Recognition',
            entityId: r.id,
            dataJson: { kind: 'RECOGNITION', recognitionId: r.id },
          },
        });
      } catch (_e) { /* best-effort */ }
    }
    const email = emailOf(emp);
    if (!email && !emp.phone) continue;
    notifyHrEvent({
      businessId: r.businessId,
      event: 'recognition.received',
      recipientEmail: email,
      recipientPhone: emp.phone || undefined,
      recipientCountry: emp.countryCode || undefined,
      variables: {
        NAME: emp.firstName || 'there',
        GIVER: fullName(r.giver),
        VALUE: r.value ? ` for “${r.value.name}”` : '',
        POINTS: rec.pointsPosted ? ` (+${rec.pointsPosted} points)` : '',
        MESSAGE: (r.message || '').slice(0, 200),
        BIZ: bizName,
        LINK: ESS_WALL_LINK,
      },
      triggeredBy: `HR_RECOGNITION:${r.id}:${emp.id}`,
    }).catch(() => {});
    sent += 1;
  }
  return sent;
}

async function notifyBudgetLow({ businessId, giverId, budgetState, remainingAfter }) {
  const emp = await prismaDefault.employee.findFirst({
    where: { id: giverId, businessId },
    select: { firstName: true, workEmail: true, personalEmail: true },
  });
  const email = emailOf(emp);
  if (!email) return;
  await notifyHrEvent({
    businessId,
    event: 'recognition.budget-low',
    recipientEmail: email,
    variables: {
      NAME: (emp && emp.firstName) || 'there',
      PERIOD: String(budgetState.budget.periodType || 'MONTHLY').toLowerCase().replace('ly', ''),
      REMAINING: String(remainingAfter),
      ALLOCATED: String(budgetState.allocated),
      BIZ: '',
    },
    triggeredBy: `HR_RNR_BUDGET_LOW:${budgetState.budget.id}:${giverId}`,
  });
}

// ── ESS reads ────────────────────────────────────────────────────────────────
const LIST_INCLUDE = {
  giver: { select: { id: true, code: true, firstName: true, lastName: true } },
  value: { select: { id: true, name: true, icon: true, colorHex: true } },
  badge: { select: { id: true, name: true, icon: true } },
  recipients: { select: { employeeId: true, pointsPosted: true, employee: { select: { id: true, code: true, firstName: true, lastName: true } } } },
};

/** Recognitions the employee GAVE + RECEIVED (self-scope), newest first, paginated. */
async function listForEmployee({ businessId, employeeId, direction = 'all', page = 1, pageSize = 20 }) {
  const take = Math.max(1, Math.min(50, Number(pageSize) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const or = [];
  if (direction === 'given' || direction === 'all') or.push({ giverEmployeeId: employeeId });
  if (direction === 'received' || direction === 'all') or.push({ recipients: { some: { employeeId } } });
  const where = {
    businessId,
    OR: or,
    // A giver sees their own PENDING_APPROVAL/REJECTED gives; a recipient only POSTED.
    AND: [{ OR: [{ giverEmployeeId: employeeId }, { status: 'POSTED' }] }],
  };
  const [items, total] = await Promise.all([
    prismaDefault.recognition.findMany({ where, include: LIST_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take }),
    prismaDefault.recognition.count({ where }),
  ]);
  return { items, total, page: Math.max(1, Number(page) || 1), pageSize: take };
}

module.exports = {
  give,
  postRecognitionTx,
  notifyRecognitionPosted,
  listForEmployee,
  _internals: { addMonths, startOfToday, SAME_PAIR_DAILY_CAP, MAX_RECIPIENTS },
};

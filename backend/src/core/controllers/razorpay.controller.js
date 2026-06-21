//
// razorpay.controller.js — Razorpay SUBSCRIPTION webhook handler (India / INR).
//
// Mirrors stripe.controller.js: verify signature → record into the
// RazorpayWebhookEvent ledger (dedup) → process async → dispatch into the SAME
// internal subscription sync + the SAME notification emails, so entitlements and
// comms stay single-sourced across gateways.
//
// NOTE: ecommerce ORDER payments use payments.controller.js (Razorpay Route).
// This file is ONLY plan subscriptions.
//
const prisma = require('../lib/prisma');
const { ROLES } = require('../lib/roles');
const { getGateway } = require('../lib/billing/gateways');
const { syncBusinessSubscriptionFromRazorpay } = require('../lib/subscriptionBilling');
const { recordGatewayPayment } = require('../lib/billingLedger');
const {
  sendSubscriptionStartedEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCancelledEmail,
} = require('../utils/email');

const razorpayGw = getGateway('RAZORPAY');

const WEBHOOK_STATUS = { PENDING: 'PENDING', PROCESSING: 'PROCESSING', PROCESSED: 'PROCESSED', FAILED: 'FAILED' };
const PROCESSING_STALE_MS = 10 * 60 * 1000;

function compactError(err, max = 4000) {
  const raw = String(err?.message || err || 'Unknown error');
  return raw.length > max ? `${raw.slice(0, max - 3)}...` : raw;
}
function isUniqueConstraintError(err) { return err?.code === 'P2002'; }

// Razorpay webhooks carry no top-level event id; derive a stable one for dedup.
function deriveEventId(event) {
  // Include EVERY entity id present — a subscription.charged carries both the
  // subscription id (same across charges) AND the payment id (unique per charge),
  // so keying on the subscription id alone collided two charges in the same
  // second and dropped the second as a duplicate. (B17)
  const ids = [
    event?.payload?.subscription?.entity?.id,
    event?.payload?.payment?.entity?.id,
    event?.payload?.refund?.entity?.id,
  ].filter(Boolean).join('|');
  return [event?.event || 'evt', ids, event?.created_at || ''].join(':');
}
function eventDate(event) {
  return Number.isFinite(event?.created_at) ? new Date(event.created_at * 1000) : null;
}

async function resolveBusinessId(normalized) {
  const fromMeta = normalized?.metadata?.businessId;
  if (fromMeta) {
    const ref = normalized?.gatewaySubscriptionId
      ? { razorpaySubscriptionId: normalized.gatewaySubscriptionId }
      : (normalized?.gatewayCustomerId ? { razorpayCustomerId: normalized.gatewayCustomerId } : null);
    if (ref) {
      const mapped = await prisma.subscription.findFirst({ where: ref, select: { businessId: true } });
      if (mapped?.businessId && mapped.businessId !== fromMeta) {
        console.warn('[razorpay webhook] metadata.businessId conflicts with existing mapping; using existing owner');
        return mapped.businessId;
      }
    }
    return fromMeta;
  }
  if (normalized?.gatewaySubscriptionId) {
    const bySub = await prisma.subscription.findFirst({ where: { razorpaySubscriptionId: normalized.gatewaySubscriptionId }, select: { businessId: true } });
    if (bySub?.businessId) return bySub.businessId;
  }
  if (normalized?.gatewayCustomerId) {
    const byCust = await prisma.subscription.findFirst({ where: { razorpayCustomerId: normalized.gatewayCustomerId }, orderBy: { updatedAt: 'desc' }, select: { businessId: true } });
    if (byCust?.businessId) return byCust.businessId;
  }
  return null;
}

async function sendBusinessEmail(businessId, send) {
  const admin = await prisma.user.findFirst({ where: { businessId, role: ROLES.BUSINESS_ADMIN }, select: { name: true, email: true } });
  if (!admin?.email) return;
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
  send(admin.email, admin.name, { businessName: business?.name || 'your business', businessId })
    .catch((e) => console.error('[razorpay webhook] email failed:', e?.message || e));
}

async function recordRazorpayWebhookEvent(event) {
  const record = {
    eventId: deriveEventId(event),
    eventType: String(event.event || ''),
    objectId: String(event?.payload?.subscription?.entity?.id || event?.payload?.payment?.entity?.id || '') || null,
    occurredAt: eventDate(event),
    payload: event,
  };
  try {
    const created = await prisma.razorpayWebhookEvent.create({ data: record });
    return { event: created, duplicate: false, requeued: false };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const existing = await prisma.razorpayWebhookEvent.findUnique({ where: { eventId: record.eventId } });
    if (!existing) throw err;
    if (existing.status === WEBHOOK_STATUS.PROCESSED) return { event: existing, duplicate: true, requeued: false };
    const updatedAtMs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    const stale = existing.status === WEBHOOK_STATUS.PROCESSING && updatedAtMs && Date.now() - updatedAtMs > PROCESSING_STALE_MS;
    if ([WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.PROCESSING].includes(existing.status) && !stale) {
      return { event: existing, duplicate: true, requeued: false };
    }
    const requeued = await prisma.razorpayWebhookEvent.update({
      where: { eventId: record.eventId },
      data: { ...record, status: WEBHOOK_STATUS.PENDING, failedAt: null, lastError: null },
    });
    return { event: requeued, duplicate: true, requeued: true };
  }
}

async function dispatchRazorpayEvent(event) {
  const normalized = razorpayGw.normalizeEvent(event);
  if (normalized.kind === 'ignored') return;

  const businessId = await resolveBusinessId(normalized);
  if (!businessId) {
    console.warn('[razorpay webhook] no business match for', event.event);
    return;
  }

  if (normalized.kind === 'payment_failed') {
    // Record the FAILED attempt so it surfaces in history like Paddle (B10).
    if (normalized.gatewayTransactionId) {
      await recordGatewayPayment({
        businessId, provider: 'razorpay', gatewayTransactionId: normalized.gatewayTransactionId,
        amountMinor: normalized.amountMinor, currencyCode: normalized.currency, status: 'FAILED',
        metadata: { source: 'webhook', event: normalized.rawType },
      }).catch((e) => console.error('[razorpay webhook] failed-charge record failed:', e?.message || e));
    }
    await sendBusinessEmail(businessId, sendPaymentFailedEmail);
    return;
  }

  if (normalized.kind === 'subscription_change') {
    const before = await prisma.subscription.findUnique({ where: { businessId }, select: { status: true } });
    const previousStatus = before?.status || null;
    await syncBusinessSubscriptionFromRazorpay({ businessId, normalized, eventAt: eventDate(event), eventId: deriveEventId(event) });

    // Record the actual money movement so it surfaces in Payment history /
    // Latest payment. Gate strictly on `subscription.charged` (NOT "amount
    // present") — activated/updated/pending events can carry or omit a payment
    // entity and must not create a phantom charge. Idempotent on the payment id.
    if (normalized.rawType === 'subscription.charged' && normalized.gatewayTransactionId) {
      await recordGatewayPayment({
        businessId,
        provider: 'razorpay',
        gatewayTransactionId: normalized.gatewayTransactionId,
        amountMinor: normalized.amountMinor,
        currencyCode: normalized.currency,
        status: 'COMPLETED',
        metadata: { source: 'webhook', event: normalized.rawType, razorpaySubscriptionId: normalized.gatewaySubscriptionId || null },
      }).catch((e) => console.error('[razorpay webhook] recordGatewayPayment failed:', e?.message || e));
    }

    const next = String(normalized.internalStatus || '');
    if (next === 'ACTIVE' && previousStatus !== 'ACTIVE') {
      await sendBusinessEmail(businessId, sendSubscriptionStartedEmail);
    } else if (next === 'CANCELLED' && previousStatus !== 'CANCELLED') {
      // Don't email "subscription cancelled" when this cancel is part of an
      // account deletion — the delete flow owns that messaging (see ecom8 spam).
      const { isBusinessDeletionPending } = require('../lib/accountDeletion');
      if (await isBusinessDeletionPending(businessId)) {
        console.log('[razorpay webhook] business deletion pending, skipping cancellation email', businessId);
      } else {
        await sendBusinessEmail(businessId, sendSubscriptionCancelledEmail);
      }
    } else if (next === 'PAST_DUE' && previousStatus !== 'PAST_DUE') {
      await sendBusinessEmail(businessId, sendPaymentFailedEmail);
    }
    return;
  }

  if (normalized.kind === 'refund') {
    // Persist the refund as a ledger row (was console.warn only) so it appears
    // in billing history. Distinct dedup key (status REFUNDED) from the charge.
    if (normalized.gatewayTransactionId) {
      await recordGatewayPayment({
        businessId,
        provider: 'razorpay',
        gatewayTransactionId: normalized.gatewayTransactionId, // refund id (rfnd_…)
        amountMinor: normalized.amountMinor,
        currencyCode: normalized.currency,
        status: 'REFUNDED',
        metadata: { source: 'webhook', event: normalized.rawType, paymentId: normalized.gatewayPaymentId || null },
      }).catch((e) => console.error('[razorpay webhook] refund record failed:', e?.message || e));
    }
  }
}

async function processRazorpayWebhookEventById(id) {
  if (!id) return { processed: false };
  const claim = await prisma.razorpayWebhookEvent.updateMany({
    where: { id, status: { in: [WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.FAILED] } },
    data: { status: WEBHOOK_STATUS.PROCESSING, attempts: { increment: 1 }, lastError: null },
  });
  if (!claim?.count) {
    const current = await prisma.razorpayWebhookEvent.findUnique({ where: { id }, select: { status: true } });
    return { processed: false, status: current?.status || null };
  }
  const row = await prisma.razorpayWebhookEvent.findUnique({ where: { id } });
  if (!row) return { processed: false };
  try {
    await dispatchRazorpayEvent(row.payload);
    const businessId = await resolveBusinessId(razorpayGw.normalizeEvent(row.payload)).catch(() => null);
    await prisma.razorpayWebhookEvent.update({
      where: { id }, data: { status: WEBHOOK_STATUS.PROCESSED, businessId: businessId || undefined, processedAt: new Date(), failedAt: null, lastError: null },
    });
    return { processed: true, eventType: row.eventType };
  } catch (err) {
    await prisma.razorpayWebhookEvent.update({ where: { id }, data: { status: WEBHOOK_STATUS.FAILED, failedAt: new Date(), lastError: compactError(err) } })
      .catch((e) => console.error('[razorpay webhook] could not mark failed:', e?.message || e));
    throw err;
  }
}

function enqueueRazorpayWebhookProcessing(id) {
  setImmediate(() => {
    processRazorpayWebhookEventById(id).catch((err) => console.error('[razorpay webhook] async processing failed:', err?.message || err));
  });
}

// Reliability backstop (scheduler-driven), mirroring the Stripe/Paddle drains.
// Re-drives PENDING/FAILED (and stale-PROCESSING) RazorpayWebhookEvent rows that
// the fast 200-ACK path left stranded after a crash/deploy — Razorpay treats a
// 200 as delivered and will not retry. maxAttempts dead-letters poison rows.
async function processPendingRazorpayWebhookEvents({ limit = 25, maxAttempts = 12 } = {}) {
  if (!prisma.razorpayWebhookEvent) return { scanned: 0, processed: 0, failed: 0 };
  const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
  await prisma.razorpayWebhookEvent.updateMany({
    where: { status: WEBHOOK_STATUS.PROCESSING, updatedAt: { lt: staleBefore } },
    data: { status: WEBHOOK_STATUS.FAILED, failedAt: new Date(), lastError: 'Processing timed out before completion; queued for retry.' },
  }).catch((err) => console.error('[razorpay webhook] stale processing reset failed:', err?.message || err));

  const events = await prisma.razorpayWebhookEvent.findMany({
    where: { status: { in: [WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.FAILED] }, attempts: { lt: maxAttempts } },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  });
  let processed = 0; let failed = 0;
  for (const event of events) {
    try {
      const result = await processRazorpayWebhookEventById(event.id);
      if (result.processed) processed += 1;
    } catch (err) {
      failed += 1;
      console.error('[razorpay webhook] queued event failed:', event.eventId, err?.message || err);
    }
  }
  return { scanned: events.length, processed, failed };
}

// Pull-based activation backstop. The webhook RETRY drain (above) can only
// re-drive events that were already LEDGERED; an event that never recorded —
// because the signature failed (e.g. a wrong RAZORPAY_WEBHOOK_SECRET) or the
// endpoint was never registered — is invisible to it, so a paid subscriber can
// stay stuck on "Trial" forever. This sweep PULLS the live subscription from
// Razorpay for tenants that started a Razorpay checkout (have a
// razorpaySubscriptionId) but are not yet ACTIVE, and reconciles them through
// the same sync. Idempotent; only ever reflects Razorpay's own state; never
// re-pulls an already-ACTIVE sub (so it can't accidentally downgrade a healthy
// one); never touches Stripe/Paddle.
async function reconcileStuckRazorpaySubscriptions({ limit = 25 } = {}) {
  if (!prisma.subscription) return { scanned: 0, reconciled: 0 };
  if (!razorpayGw.isConfigured()) return { scanned: 0, reconciled: 0, configured: false };
  const { FREE_TIER_SLUGS } = require('../lib/subscriptionBilling');
  // A "stuck" Razorpay sub is one that started checkout (has a subscription id)
  // but the paid plan never landed: either it isn't ACTIVE, or it IS ACTIVE but
  // still sitting on a FREE tier (activation never upgraded it). We deliberately
  // never re-pull an ACTIVE sub already on a PAID tier — that's the healthy case,
  // and skipping it removes any chance of a transient downgrade.
  const candidates = await prisma.subscription.findMany({
    where: { gateway: 'RAZORPAY', razorpaySubscriptionId: { not: null } },
    orderBy: { updatedAt: 'asc' },
    take: limit * 3,
    select: { businessId: true, razorpaySubscriptionId: true, status: true, tier: { select: { slug: true } } },
  });
  const stuck = candidates
    .filter((s) => s.status !== 'ACTIVE' || FREE_TIER_SLUGS.has(s.tier?.slug))
    .slice(0, limit);
  let reconciled = 0;
  for (const sub of stuck) {
    try {
      const live = await razorpayGw.getSubscription(sub.razorpaySubscriptionId).catch(() => null);
      if (!live) continue;
      const normalized = razorpayGw.normalizeEvent({ event: 'subscription.updated', payload: { subscription: { entity: live } } });
      if (!normalized.internalStatus) continue; // 'created' etc. — don't touch entitlements yet
      await syncBusinessSubscriptionFromRazorpay({ businessId: sub.businessId, normalized, eventAt: new Date(), eventId: null });
      reconciled += 1;
    } catch (err) {
      console.error('[razorpay reconcile] failed for business', sub.businessId, err?.message || err);
    }
  }
  if (stuck.length) console.log(`[razorpay reconcile] scanned ${stuck.length}, reconciled ${reconciled}`);
  return { scanned: stuck.length, reconciled };
}

async function handleRazorpayWebhook(req, res) {
  let event;
  try {
    event = razorpayGw.verifyWebhook({ rawBody: req.body, signatureHeader: req.get('X-Razorpay-Signature') });
  } catch (err) {
    console.warn('[razorpay webhook] signature verification failed:', err?.message || err);
    return res.status(400).json({ message: 'Invalid Razorpay webhook signature.' });
  }
  try {
    const { event: row, duplicate, requeued } = await recordRazorpayWebhookEvent(event);
    if (!duplicate || requeued) enqueueRazorpayWebhookProcessing(row.id);
    return res.json({ received: true, duplicate, status: row.status });
  } catch (err) {
    console.error('[razorpay webhook] enqueue failed:', err?.message || err);
    return res.status(err?.status || 500).json({ message: err?.message || 'Webhook processing failed.' });
  }
}

module.exports = {
  handleRazorpayWebhook,
  processRazorpayWebhookEventById,
  processPendingRazorpayWebhookEvents,
  reconcileStuckRazorpaySubscriptions,
  recordRazorpayWebhookEvent,
  dispatchRazorpayEvent,
};

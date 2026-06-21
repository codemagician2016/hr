//
// stripe.controller.js — Stripe subscription webhook handler for New Zealand.
//
// Mirrors paddle.controller.js: verify signature → record into the
// StripeWebhookEvent ledger (exact-once dedup on the Stripe event id) → process
// asynchronously → dispatch into the SAME internal subscription sync + the SAME
// notification emails Paddle uses, so entitlements and customer comms stay
// single-sourced across gateways.
//
const prisma = require('../lib/prisma');
const { ROLES } = require('../lib/roles');
const { getGateway } = require('../lib/billing/gateways');
const { syncBusinessSubscriptionFromStripe } = require('../lib/subscriptionBilling');
const { recordGatewayPayment } = require('../lib/billingLedger');
const {
  sendSubscriptionStartedEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCancelledEmail,
} = require('../utils/email');

const stripeGw = getGateway('STRIPE');

const WEBHOOK_STATUS = { PENDING: 'PENDING', PROCESSING: 'PROCESSING', PROCESSED: 'PROCESSED', FAILED: 'FAILED' };
const PROCESSING_STALE_MS = 10 * 60 * 1000;

function compactError(err, max = 4000) {
  const raw = String(err?.message || err || 'Unknown error');
  return raw.length > max ? `${raw.slice(0, max - 3)}...` : raw;
}
function isUniqueConstraintError(err) { return err?.code === 'P2002'; }
function eventDate(event) {
  return Number.isFinite(event?.created) ? new Date(event.created * 1000) : null;
}

// businessId resolution trust chain:
//   1. metadata.businessId is stamped by OUR authenticated checkout
//      (= req.user.businessId), and the event is Stripe-signature-verified, so a
//      third party cannot forge it.
//   2. Defence-in-depth (mirrors Paddle's F13 guard): if the Stripe
//      subscription/customer in this event is ALREADY mapped to a DIFFERENT
//      business locally, ignore the metadata and trust the existing mapping —
//      so a reused customer can't be re-pointed at another tenant.
//   3. Otherwise fall back to the customer/subscription → Subscription mapping.
async function resolveBusinessId(normalized) {
  const fromMeta = normalized?.metadata?.businessId;
  if (fromMeta) {
    const ref = normalized?.gatewaySubscriptionId
      ? { stripeSubscriptionId: normalized.gatewaySubscriptionId }
      : (normalized?.gatewayCustomerId ? { stripeCustomerId: normalized.gatewayCustomerId } : null);
    if (ref) {
      const mapped = await prisma.subscription.findFirst({ where: ref, select: { businessId: true } });
      if (mapped?.businessId && mapped.businessId !== fromMeta) {
        console.warn('[stripe webhook] metadata.businessId conflicts with existing Stripe mapping; using existing owner');
        return mapped.businessId;
      }
    }
    return fromMeta;
  }
  if (normalized?.gatewaySubscriptionId) {
    const bySub = await prisma.subscription.findFirst({
      where: { stripeSubscriptionId: normalized.gatewaySubscriptionId }, select: { businessId: true },
    });
    if (bySub?.businessId) return bySub.businessId;
  }
  if (normalized?.gatewayCustomerId) {
    const byCust = await prisma.subscription.findFirst({
      where: { stripeCustomerId: normalized.gatewayCustomerId },
      orderBy: { updatedAt: 'desc' }, select: { businessId: true },
    });
    if (byCust?.businessId) return byCust.businessId;
  }
  return null;
}

async function sendBusinessEmail(businessId, send) {
  const admin = await prisma.user.findFirst({
    where: { businessId, role: ROLES.BUSINESS_ADMIN }, select: { name: true, email: true },
  });
  if (!admin?.email) return;
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
  send(admin.email, admin.name, { businessName: business?.name || 'your business', businessId })
    .catch((e) => console.error('[stripe webhook] email failed:', e?.message || e));
}

async function recordStripeWebhookEvent(event) {
  const record = {
    eventId: String(event.id),
    eventType: String(event.type),
    objectId: String(event?.data?.object?.id || '') || null,
    occurredAt: eventDate(event),
    payload: event,
  };
  try {
    const created = await prisma.stripeWebhookEvent.create({ data: record });
    return { event: created, duplicate: false, requeued: false };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const existing = await prisma.stripeWebhookEvent.findUnique({ where: { eventId: record.eventId } });
    if (!existing) throw err;
    if (existing.status === WEBHOOK_STATUS.PROCESSED) return { event: existing, duplicate: true, requeued: false };
    const updatedAtMs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    const stale = existing.status === WEBHOOK_STATUS.PROCESSING && updatedAtMs && Date.now() - updatedAtMs > PROCESSING_STALE_MS;
    if ([WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.PROCESSING].includes(existing.status) && !stale) {
      return { event: existing, duplicate: true, requeued: false };
    }
    const requeued = await prisma.stripeWebhookEvent.update({
      where: { eventId: record.eventId },
      data: { ...record, status: WEBHOOK_STATUS.PENDING, failedAt: null, lastError: null },
    });
    return { event: requeued, duplicate: true, requeued: true };
  }
}

// Dispatch a single Stripe event into our internal state. Idempotent: a replayed
// event resolves to the same end state.
async function dispatchStripeEvent(event) {
  const normalized = stripeGw.normalizeEvent(event);
  if (normalized.kind === 'ignored') return;

  const businessId = await resolveBusinessId(normalized);
  if (!businessId) {
    console.warn('[stripe webhook] no business match for', event.type, event.id);
    return;
  }

  if (normalized.kind === 'transaction_completed') {
    // checkout.session.completed — first confirmation of a new subscription.
    const incomingSubId = normalized.gatewaySubscriptionId || null;
    const existing = await prisma.subscription.findUnique({ where: { businessId }, select: { stripeSubscriptionId: true } });
    const currentSubId = existing?.stripeSubscriptionId || null;
    // Duplicate-subscription guard (B9): if this business already has a DIFFERENT
    // live Stripe subscription, a second checkout completed (abandoned then
    // retried before the first stored its id). Cancel the newcomer and KEEP the
    // original, rather than overwriting the id and orphaning the first sub (which
    // would keep billing forever).
    if (incomingSubId && currentSubId && currentSubId !== incomingSubId) {
      console.warn(`[stripe webhook] duplicate subscription ${incomingSubId} for business ${businessId} (already on ${currentSubId}) — cancelling the duplicate`);
      await stripeGw.cancelSubscription(incomingSubId, { immediately: true })
        .catch((e) => console.error('[stripe webhook] could not cancel duplicate sub:', e?.message || e));
      return;
    }
    await prisma.subscription.updateMany({
      where: { businessId },
      data: {
        gateway: 'STRIPE',
        stripeCustomerId: normalized.gatewayCustomerId || undefined,
        stripeSubscriptionId: incomingSubId || undefined,
      },
    });
    await sendBusinessEmail(businessId, sendSubscriptionStartedEmail);
    return;
  }

  if (normalized.kind === 'charge') {
    // Successful Stripe subscription charge → record in the payment ledger (B5).
    if (normalized.gatewayTransactionId && Number(normalized.amountMinor) > 0) {
      await recordGatewayPayment({
        businessId, provider: 'stripe', gatewayTransactionId: normalized.gatewayTransactionId,
        amountMinor: normalized.amountMinor, currencyCode: normalized.currency, status: 'COMPLETED',
        metadata: { source: 'webhook', event: normalized.rawType, stripeSubscriptionId: normalized.gatewaySubscriptionId || null },
      }).catch((e) => console.error('[stripe webhook] recordGatewayPayment failed:', e?.message || e));
    }
    return;
  }

  if (normalized.kind === 'payment_failed') {
    // Record the FAILED attempt so it surfaces in history like Paddle (B10).
    if (normalized.gatewayTransactionId) {
      await recordGatewayPayment({
        businessId, provider: 'stripe', gatewayTransactionId: normalized.gatewayTransactionId,
        amountMinor: normalized.amountMinor, currencyCode: normalized.currency, status: 'FAILED',
        metadata: { source: 'webhook', event: normalized.rawType },
      }).catch((e) => console.error('[stripe webhook] failed-charge record failed:', e?.message || e));
    }
    await sendBusinessEmail(businessId, sendPaymentFailedEmail);
    return;
  }

  if (normalized.kind === 'subscription_change') {
    const before = await prisma.subscription.findUnique({ where: { businessId }, select: { status: true } });
    const previousStatus = before?.status || null;
    await syncBusinessSubscriptionFromStripe({
      businessId, normalized, eventAt: eventDate(event), eventId: event.id,
    });
    const next = String(normalized.internalStatus || '');
    if (next === 'CANCELLED' && previousStatus !== 'CANCELLED') {
      // Don't email "subscription cancelled" when this cancel is part of an
      // account deletion — the delete flow owns that messaging (see ecom8 spam).
      const { isBusinessDeletionPending } = require('../lib/accountDeletion');
      if (await isBusinessDeletionPending(businessId)) {
        console.log('[stripe webhook] business deletion pending, skipping cancellation email', businessId);
      } else {
        await sendBusinessEmail(businessId, sendSubscriptionCancelledEmail);
      }
    } else if (next === 'PAST_DUE' && previousStatus !== 'PAST_DUE') {
      await sendBusinessEmail(businessId, sendPaymentFailedEmail);
    }
    return;
  }

  if (normalized.kind === 'refund') {
    // Persist the refund as a ledger row so it appears in billing history (B5).
    // Distinct dedup key (status REFUNDED) from the charge row.
    if (normalized.gatewayTransactionId) {
      await recordGatewayPayment({
        businessId, provider: 'stripe', gatewayTransactionId: normalized.gatewayTransactionId,
        amountMinor: normalized.amountMinor, currencyCode: normalized.currency, status: 'REFUNDED',
        metadata: { source: 'webhook', event: normalized.rawType },
      }).catch((e) => console.error('[stripe webhook] refund record failed:', e?.message || e));
    }
  }
}

async function processStripeWebhookEventById(id) {
  if (!id) return { processed: false };
  const claim = await prisma.stripeWebhookEvent.updateMany({
    where: { id, status: { in: [WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.FAILED] } },
    data: { status: WEBHOOK_STATUS.PROCESSING, attempts: { increment: 1 }, lastError: null },
  });
  if (!claim?.count) {
    const current = await prisma.stripeWebhookEvent.findUnique({ where: { id }, select: { status: true } });
    return { processed: false, status: current?.status || null };
  }
  const row = await prisma.stripeWebhookEvent.findUnique({ where: { id } });
  if (!row) return { processed: false };
  try {
    await dispatchStripeEvent(row.payload);
    const businessId = await resolveBusinessId(stripeGw.normalizeEvent(row.payload)).catch(() => null);
    await prisma.stripeWebhookEvent.update({
      where: { id },
      data: { status: WEBHOOK_STATUS.PROCESSED, businessId: businessId || undefined, processedAt: new Date(), failedAt: null, lastError: null },
    });
    return { processed: true, eventType: row.eventType };
  } catch (err) {
    await prisma.stripeWebhookEvent.update({
      where: { id }, data: { status: WEBHOOK_STATUS.FAILED, failedAt: new Date(), lastError: compactError(err) },
    }).catch((e) => console.error('[stripe webhook] could not mark failed:', e?.message || e));
    throw err;
  }
}

function enqueueStripeWebhookProcessing(id) {
  setImmediate(() => {
    processStripeWebhookEventById(id).catch((err) => console.error('[stripe webhook] async processing failed:', err?.message || err));
  });
}

// Reliability backstop (scheduler-driven). The HTTP endpoint ACKs Stripe with a
// fast 200 and processes in-process via setImmediate — but a crash/deploy
// between the ACK and that callback strands the event, and Stripe does NOT retry
// a 200. This sweep re-drives PENDING/FAILED (and stale-PROCESSING) ledger rows.
// Mirrors processPendingPaddleWebhookEvents; maxAttempts dead-letters poison rows.
async function processPendingStripeWebhookEvents({ limit = 25, maxAttempts = 12 } = {}) {
  if (!prisma.stripeWebhookEvent) return { scanned: 0, processed: 0, failed: 0 };
  const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
  await prisma.stripeWebhookEvent.updateMany({
    where: { status: WEBHOOK_STATUS.PROCESSING, updatedAt: { lt: staleBefore } },
    data: { status: WEBHOOK_STATUS.FAILED, failedAt: new Date(), lastError: 'Processing timed out before completion; queued for retry.' },
  }).catch((err) => console.error('[stripe webhook] stale processing reset failed:', err?.message || err));

  const events = await prisma.stripeWebhookEvent.findMany({
    where: { status: { in: [WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.FAILED] }, attempts: { lt: maxAttempts } },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  });
  let processed = 0; let failed = 0;
  for (const event of events) {
    try {
      const result = await processStripeWebhookEventById(event.id);
      if (result.processed) processed += 1;
    } catch (err) {
      failed += 1;
      console.error('[stripe webhook] queued event failed:', event.eventId, err?.message || err);
    }
  }
  return { scanned: events.length, processed, failed };
}

async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripeGw.verifyWebhook({ rawBody: req.body, signatureHeader: req.get('Stripe-Signature') });
  } catch (err) {
    console.warn('[stripe webhook] signature verification failed:', err?.message || err);
    return res.status(400).json({ message: 'Invalid Stripe webhook signature.' });
  }
  try {
    const { event: row, duplicate, requeued } = await recordStripeWebhookEvent(event);
    if (!duplicate || requeued) enqueueStripeWebhookProcessing(row.id);
    return res.json({ received: true, duplicate, status: row.status });
  } catch (err) {
    console.error('[stripe webhook] enqueue failed:', err?.message || err);
    return res.status(err?.status || 500).json({ message: err?.message || 'Webhook processing failed.' });
  }
}

module.exports = {
  handleStripeWebhook,
  processStripeWebhookEventById,
  processPendingStripeWebhookEvents,
  recordStripeWebhookEvent,
  dispatchStripeEvent,
};

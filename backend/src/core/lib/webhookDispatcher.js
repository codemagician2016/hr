// Webhook dispatcher — emits events to all matching WebhookSubscription
// rows + retries failed deliveries with exponential backoff.
//
// Two entry points:
//   emit(event, payload, businessId)  — call from app code on event happen
//   dispatchPendingRetries()          — cron: retries due RETRYING rows
'use strict';

const { PrismaClient } = require('@prisma/client');
const { signWebhookEnvelope, signWebhookPayload } = require('./publicApi');
const prisma = new PrismaClient();

const MAX_ATTEMPTS = 5;
// Backoff (in minutes) per attempt: 1, 5, 15, 60, 240.
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

// Fire-and-forget wrapper for app code on hot paths (order/appointment
// creation, etc.). Never throws, never blocks the caller: enqueues deliveries
// in the background and swallows+logs any error. Use this from controllers;
// reserve raw emit() for places that already await + handle errors (tests).
function safeEmit(event, payload, businessId) {
  if (!businessId || !event) return;
  Promise.resolve()
    .then(() => emit(event, payload, businessId))
    .catch((err) => console.error('[webhook] emit failed', event, err?.message || err));
}

// Enqueue a delivery for every subscription that listens to this event.
async function emit(event, payload, businessId) {
  const subs = await prisma.webhookSubscription.findMany({
    where: { businessId, isActive: true },
  });
  for (const sub of subs) {
    const events = Array.isArray(sub.events) ? sub.events : [];
    if (!events.includes(event)) continue;
    await prisma.webhookDelivery.create({
      data: {
        businessId,
        subscriptionId: sub.id,
        event,
        payload,
        status: 'PENDING',
        nextRetryAt: new Date(),
      },
    });
  }
}

// Send a single delivery. Mutates the row in place. Public for testing.
async function deliverOne(delivery) {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: delivery.subscriptionId } });
  if (!sub || !sub.isActive) {
    return prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', responseBody: 'subscription disabled or removed' },
    });
  }
  const body = JSON.stringify({ event: delivery.event, payload: delivery.payload });
  const signature = signWebhookPayload(sub.secret, body);
  const signedEnvelope = signWebhookEnvelope(sub.secret, body);

  let res;
  try {
    res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sitepresso-Signature': `sha256=${signature}`,
        'X-Sitepresso-Signature-V2': signedEnvelope.header,
        'X-Sitepresso-Timestamp': signedEnvelope.timestamp,
        'X-Sitepresso-Delivery-Id': delivery.id,
        'X-Sitepresso-Webhook-Id': sub.id,
        'X-Sitepresso-Event': delivery.event,
      },
      body,
    });
  } catch (err) {
    const nextAttempt = delivery.attempts + 1;
    const isFinal = nextAttempt >= MAX_ATTEMPTS;
    return prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: nextAttempt,
        status: isFinal ? 'FAILED' : 'RETRYING',
        responseBody: err.message?.slice(0, 500) || 'network error',
        nextRetryAt: isFinal ? null : new Date(Date.now() + BACKOFF_MINUTES[nextAttempt - 1] * 60_000),
      },
    });
  }

  const respBody = await res.text().catch(() => '');
  if (res.ok) {
    return prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENT', deliveredAt: new Date(), responseStatus: res.status,
        responseBody: respBody.slice(0, 500), attempts: delivery.attempts + 1 },
    });
  }
  const nextAttempt = delivery.attempts + 1;
  const isFinal = nextAttempt >= MAX_ATTEMPTS;
  return prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: nextAttempt,
      status: isFinal ? 'FAILED' : 'RETRYING',
      responseStatus: res.status,
      responseBody: respBody.slice(0, 500),
      nextRetryAt: isFinal ? null : new Date(Date.now() + BACKOFF_MINUTES[nextAttempt - 1] * 60_000),
    },
  });
}

// Dispatcher cron — runs every minute. Picks up PENDING + RETRYING due now.
async function dispatchPendingRetries({ limit = 100 } = {}) {
  const due = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let processed = 0;
  for (const d of due) {
    await deliverOne(d).catch((err) => console.error('[webhook]', err));
    processed++;
  }
  return { processed };
}

module.exports = { emit, safeEmit, deliverOne, dispatchPendingRetries, MAX_ATTEMPTS, BACKOFF_MINUTES };

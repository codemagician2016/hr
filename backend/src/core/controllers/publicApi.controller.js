// API key + webhook subscription admin controller. BUSINESS_ADMIN scope.
'use strict';

const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const {
  EVENTS,
  PUBLIC_API_SCOPE_RESOURCES,
  generateApiKey,
  generateWebhookSecret,
} = require('../lib/publicApi');
const { assertBooleanFeature } = require('../lib/entitlements');
const { deliverOne } = require('../lib/webhookDispatcher');

const prisma = new PrismaClient();
async function bizId(req) { return req.user?.businessId || null; }

async function ensureApiAccessFeature(businessId, res) {
  try {
    await assertBooleanFeature({ businessId, key: 'api_access', label: 'API access & webhooks' });
    return true;
  } catch (err) {
    res.status(err.status || 403).json({ message: err.message, code: err.code });
    return false;
  }
}

// ─── API KEYS ────────────────────────────────────────────────────────────────
async function listKeys(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const keys = await prisma.apiKey.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, keyLast4: true, scopes: true, lastUsedAt: true, isActive: true, createdAt: true },
  });
  res.json({ keys });
}

const scopeValueSchema = z.enum([...PUBLIC_API_SCOPE_RESOURCES, '*']);
const keySchema = z.object({
  name: z.string().min(1).max(60),
  scopes: z.object({
    read: z.array(scopeValueSchema).default([]),
    write: z.array(scopeValueSchema).default([]),
  }).optional(),
});

async function createKey(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  // Tier gate: API access & webhooks are a Business/Agency-plan feature.
  if (!await ensureApiAccessFeature(businessId, res)) return undefined;
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  const { raw, hash, last4 } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      businessId, name: parsed.data.name, keyHash: hash, keyLast4: last4,
      scopes: parsed.data.scopes || { read: [], write: [] },
    },
  });
  // Return raw key ONCE — admin must copy it now.
  res.status(201).json({ id: key.id, name: key.name, keyLast4: key.keyLast4, key: raw, scopes: key.scopes });
}

async function revokeKey(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const existing = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  await prisma.apiKey.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.json({ ok: true });
}

// ─── WEBHOOKS ────────────────────────────────────────────────────────────────
async function listSubs(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const subs = await prisma.webhookSubscription.findMany({
    where: { businessId }, orderBy: { createdAt: 'desc' },
    select: { id: true, url: true, events: true, isActive: true, createdAt: true,
      _count: { select: { deliveries: true } } },
  });
  res.json({ subscriptions: subs, supportedEvents: EVENTS });
}

const subSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(EVENTS)).min(1),
});

async function createSub(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  if (!await ensureApiAccessFeature(businessId, res)) return undefined;
  const parsed = subSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  const secret = generateWebhookSecret();
  const sub = await prisma.webhookSubscription.create({
    data: { businessId, url: parsed.data.url, events: parsed.data.events, secret },
  });
  // Return secret ONCE — admin must copy it now to verify signatures.
  res.status(201).json({ id: sub.id, url: sub.url, events: sub.events, secret });
}

async function deleteSub(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const existing = await prisma.webhookSubscription.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  await prisma.webhookSubscription.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}

function presentWebhookDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody || null,
    nextRetryAt: row.nextRetryAt || null,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt || null,
    subscriptionId: row.subscriptionId,
    subscriptionUrl: row.subscription?.url || null,
    subscriptionActive: row.subscription?.isActive ?? null,
  };
}

const testWebhookSchema = z.object({
  event: z.enum(EVENTS).optional(),
  payload: z.unknown().optional(),
});

function testWebhookPayload({ business, subscription, event }) {
  return {
    test: true,
    event,
    sentAt: new Date().toISOString(),
    business: {
      id: business.id,
      slug: business.slug,
      name: business.name,
    },
    delivery: {
      id: 'test_delivery',
      externalRef: `TEST-${Date.now()}`,
      status: 'READY_FOR_DISPATCH',
      trackingUrl: null,
    },
    webhook: {
      subscriptionId: subscription.id,
      url: subscription.url,
    },
  };
}

async function testSub(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = testWebhookSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });

  const [business, sub] = await Promise.all([
    prisma.business.findUnique({ where: { id: businessId }, select: { id: true, slug: true, name: true } }),
    prisma.webhookSubscription.findFirst({ where: { id: req.params.id, businessId } }),
  ]);
  if (!sub) return res.status(404).json({ message: 'Not found' });
  if (!sub.isActive) return res.status(409).json({ message: 'Webhook endpoint is inactive' });

  const subscribedEvents = Array.isArray(sub.events) ? sub.events : [];
  const event = parsed.data.event || subscribedEvents.find((item) => String(item).startsWith('delivery.')) || subscribedEvents[0];
  if (!event || !subscribedEvents.includes(event)) {
    return res.status(400).json({ message: 'Webhook endpoint is not subscribed to the requested event' });
  }

  const payload = parsed.data.payload && typeof parsed.data.payload === 'object'
    ? parsed.data.payload
    : testWebhookPayload({ business: business || { id: businessId }, subscription: sub, event });

  const queued = await prisma.webhookDelivery.create({
    data: {
      businessId,
      subscriptionId: sub.id,
      event,
      payload,
      status: 'PENDING',
      nextRetryAt: new Date(),
    },
  });
  const delivered = await deliverOne(queued);
  res.status(202).json({ delivery: presentWebhookDelivery({ ...delivered, subscription: sub }) });
}

async function listDeliveries(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { businessId }, orderBy: { createdAt: 'desc' }, take: 50,
    select: { id: true, event: true, status: true, attempts: true, responseStatus: true,
      responseBody: true, nextRetryAt: true, createdAt: true, deliveredAt: true, subscriptionId: true,
      subscription: { select: { url: true, isActive: true } } },
  });
  res.json({ deliveries: deliveries.map(presentWebhookDelivery) });
}

async function replayDelivery(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const existing = await prisma.webhookDelivery.findFirst({
    where: { id: req.params.id, businessId },
    include: { subscription: true },
  });
  if (!existing) return res.status(404).json({ message: 'Not found' });

  const queued = await prisma.webhookDelivery.create({
    data: {
      businessId,
      subscriptionId: existing.subscriptionId,
      event: existing.event,
      payload: existing.payload,
      status: 'PENDING',
      nextRetryAt: new Date(),
    },
  });
  const delivered = await deliverOne(queued);
  res.status(202).json({
    replayOf: existing.id,
    delivery: presentWebhookDelivery({ ...delivered, subscription: existing.subscription }),
  });
}

module.exports = {
  listKeys, createKey, revokeKey,
  listSubs, createSub, deleteSub, testSub, listDeliveries, replayDelivery,
};

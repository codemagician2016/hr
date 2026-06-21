#!/usr/bin/env node
/* eslint-disable no-console */
//
// simulate-razorpay-lifecycle.js — sandbox-only "test clock" for Razorpay (IN).
//
// The Razorpay twin of simulate-stripe-lifecycle.js. Forges Razorpay-shaped
// subscription webhooks, SIGNS them with RAZORPAY_WEBHOOK_SECRET (HMAC-SHA256),
// pushes them through the REAL path — razorpayGateway.verifyWebhook →
// recordRazorpayWebhookEvent → processRazorpayWebhookEventById → dispatch →
// syncBusinessSubscriptionFromRazorpay — and prints the Subscription row after
// each event. Deterministic + in-process; verifies our lifecycle reaction
// WITHOUT needing Razorpay API keys (only the webhook secret).
//
// SAFETY: refuses to run against LIVE Razorpay keys (rzp_live_…).
//   ⚠ lifecycle handlers email the tenant admin — use a throwaway test tenant.
//
// Usage:
//   node scripts/simulate-razorpay-lifecycle.js --business <slug|id> --reset --scenario full
//
// Scenarios: subscribe | renew | dunning | recover | cancel | full

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getGateway } = require('../src/core/lib/billing/gateways');
const gw = getGateway('RAZORPAY');

if (String(process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_')) {
  console.error('\n✖ Refusing to run: RAZORPAY_KEY_ID is a LIVE key. Sandbox/test only.\n');
  process.exit(1);
}
if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
  console.error('\n✖ RAZORPAY_WEBHOOK_SECRET must be set so simulated events can be signed/verified.\n');
  process.exit(1);
}

const prisma = require('../src/core/lib/prisma');
const { recordRazorpayWebhookEvent, processRazorpayWebhookEventById } = require('../src/core/controllers/razorpay.controller');
const { getFreeTier } = require('../src/core/lib/subscriptionBilling');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) out[k] = true; else { out[k] = n; i += 1; } }
    else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
function die(m) { console.error(`\n✖ ${m}\n`); process.exit(1); }

const RUN = Date.now().toString(36);
let clockMs = Date.now();
let n = 0;
let stepN = 0;
function nextSec() { clockMs += 60 * 1000; return Math.floor(clockMs / 1000); }
const ctx = {};
function fmt(d) { try { return d ? new Date(d).toISOString().replace('.000Z', 'Z') : '-'; } catch { return String(d); } }

async function deliver(event) {
  const body = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  const verified = gw.verifyWebhook({ rawBody: Buffer.from(body), signatureHeader: sig });
  const { event: row, duplicate, requeued } = await recordRazorpayWebhookEvent(verified);
  if (!duplicate || requeued) return processRazorpayWebhookEventById(row.id);
  return { processed: false, reason: 'duplicate' };
}

async function printState(label) {
  const s = await prisma.subscription.findUnique({ where: { businessId: ctx.businessId }, include: { tier: true } });
  if (!s) { console.log(`     ${label} (no subscription)`); return; }
  console.log(`     ${label} tier=${s.tier?.slug} status=${s.status} cycle=${s.billingCycle} gw=${s.gateway} sub=${s.razorpaySubscriptionId || '-'}`);
  console.log(`       periodEnd=${fmt(s.currentPeriodEnd)} trialEnds=${fmt(s.trialEndsAt)} trialConverted=${fmt(s.trialConvertedAt)} pastDueSince=${fmt(s.pastDueSince)}`);
}

function notes() { return { businessId: ctx.businessId, businessSlug: ctx.businessSlug, tierSlug: ctx.tierSlug, billingCycle: 'MONTHLY' }; }
function periodEndSec() { return Math.floor((clockMs + 30 * 86400000) / 1000); }
function subEntity(status) {
  return { id: ctx.subId, plan_id: ctx.planId, status, customer_id: ctx.customerId, current_end: periodEndSec(), notes: notes() };
}
function paymentEntity() { return { id: `pay_sim_${RUN}_${n}`, amount: ctx.amountMinor, currency: 'INR', customer_id: ctx.customerId, subscription_id: ctx.subId }; }
function envelope(eventType, { withPayment = false } = {}) {
  n += 1;
  return {
    entity: 'event', account_id: 'acc_sim', event: eventType, contains: ['subscription'],
    payload: { subscription: { entity: subEntity(razorpayStatusFor(eventType)) }, ...(withPayment ? { payment: { entity: paymentEntity() } } : {}) },
    created_at: nextSec(),
  };
}
function razorpayStatusFor(eventType) {
  switch (eventType) {
    case 'subscription.authenticated': return 'authenticated';
    case 'subscription.activated': return 'active';
    case 'subscription.charged': return 'active';
    case 'subscription.pending': return 'pending';
    case 'subscription.halted': return 'halted';
    case 'subscription.cancelled': return 'cancelled';
    default: return 'created';
  }
}

async function runEvent(label, event) {
  stepN += 1;
  console.log(`\n[${stepN}] ${label}  →  ${event.event}`);
  const r = await deliver(event);
  console.log(r?.processed ? `     processed (${r.eventType || event.event})` : `     NOT processed: ${r?.reason || r?.status || '?'}`);
  await printState('state →');
}

const steps = {
  authenticated: () => runEvent('authorize mandate (authenticated)', envelope('subscription.authenticated')),
  activated: () => runEvent('first charge (activated)', envelope('subscription.activated', { withPayment: true })),
  charged: () => runEvent('renewal (charged)', envelope('subscription.charged', { withPayment: true })),
  payment_failed: () => runEvent('fail (payment.failed)', { entity: 'event', account_id: 'acc_sim', event: 'payment.failed', payload: { payment: { entity: paymentEntity() }, subscription: { entity: subEntity('pending') } }, created_at: nextSec() }),
  pending: () => runEvent('past_due (pending)', envelope('subscription.pending')),
  cancelled: () => runEvent('cancel (cancelled)', envelope('subscription.cancelled')),
};

const SCENARIOS = {
  subscribe: ['authenticated', 'activated'],
  renew: ['authenticated', 'activated', 'charged'],
  dunning: ['authenticated', 'activated', 'payment_failed', 'pending'],
  recover: ['authenticated', 'activated', 'payment_failed', 'pending', 'activated'],
  cancel: ['authenticated', 'activated', 'cancelled'],
  full: ['authenticated', 'activated', 'charged', 'payment_failed', 'pending', 'activated', 'cancelled'],
};

async function resetSubscription() {
  const free = await getFreeTier();
  if (!free) die('Free tier missing — run prisma/seeds/pricing.seed.js first.');
  await prisma.subscription.upsert({
    where: { businessId: ctx.businessId },
    update: {
      tierId: free.id, status: 'ACTIVE', billingCycle: 'MONTHLY', gateway: 'PADDLE',
      razorpayCustomerId: null, razorpaySubscriptionId: null,
      trialPlanSlug: null, trialStartedAt: null, trialEndsAt: null, trialConvertedAt: null,
      pastDueSince: null, accessGraceUntil: null,
      pendingTierSlug: null, pendingBillingCycle: null, pendingChangeEffectiveAt: null, pendingVertical: null,
      lastPaddleEventAt: null, lastPaddleEventId: null,
    },
    create: { businessId: ctx.businessId, tierId: free.id, status: 'ACTIVE', billingCycle: 'MONTHLY', theme: 'default', seatsUsed: 1 },
  });
  console.log('   ✓ reset to free + cleared gateway/razorpay/trial/past-due state');
}

async function main() {
  const scenarioName = String(args.scenario || 'subscribe').toLowerCase();
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) die(`Unknown --scenario "${scenarioName}". One of: ${Object.keys(SCENARIOS).join(', ')}`);

  const biz = await prisma.business.findFirst({
    where: { OR: [{ slug: String(args.business || '') }, { id: String(args.business || '') }] },
    select: { id: true, slug: true, name: true, vertical: true },
  });
  if (!biz) die(`No business for "${args.business}". Pass --business <slug|id>.`);

  // Pick a paid tier for this vertical and attach a FAKE Razorpay plan id to its
  // IN row so the sync's findTierForRazorpayPlanId matches (no API keys needed).
  const tier = await prisma.pricingTier.findFirst({
    where: { isActive: true, vertical: biz.vertical, slug: { not: 'free' }, ...(args.tier && args.tier !== true ? { slug: String(args.tier) } : { sortOrder: { gte: 1 } }) },
    orderBy: { sortOrder: 'asc' },
  });
  if (!tier) die(`No paid tier for vertical ${biz.vertical}`);
  const planId = `plan_sim_${RUN}`;
  const inRow = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: 'IN' } });
  if (inRow) await prisma.tierPrice.update({ where: { id: inRow.id }, data: { razorpayPlanIdMonthly: planId } });
  else await prisma.tierPrice.create({ data: { tierId: tier.id, countryCode: 'IN', currencyCode: 'INR', amountMonthlyMinor: 149900, amountAnnualMinor: 1439000, razorpayPlanIdMonthly: planId } });

  Object.assign(ctx, {
    businessId: biz.id, businessSlug: biz.slug, tierSlug: tier.slug,
    planId, customerId: `cust_sim_${RUN}`, subId: `sub_sim_${RUN}`,
    amountMinor: inRow?.amountMonthlyMinor || 149900,
  });

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(' Razorpay lifecycle simulator (sandbox/IN — logic only, no API keys)');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  business    ${biz.name} [${biz.slug}] vertical=${biz.vertical}`);
  console.log(`  tier        ${tier.slug}  → fake plan ${planId}`);
  console.log(`  scenario    ${scenarioName}  →  ${scenario.join(' → ')}`);
  console.log('  ⚠ lifecycle handlers may email the tenant admin — use a test tenant.');
  console.log('────────────────────────────────────────────────────────────');

  console.log('\n• Starting state:'); await printState('state →');
  if (args.reset) { console.log('\n• Reset:'); await resetSubscription(); }
  for (const key of scenario) await steps[key]();
  console.log('\n• Final state:'); await printState('state →');

  // Clean up the fake plan id so we don't leave a sim artifact on the tier.
  const cleanup = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: 'IN', razorpayPlanIdMonthly: planId } });
  if (cleanup) await prisma.tierPrice.update({ where: { id: cleanup.id }, data: { razorpayPlanIdMonthly: null } });
  console.log('\n✓ Done (fake plan id cleaned up).\n');
}

main()
  .catch((err) => { console.error('\n✖ Simulation failed:', err?.stack || err?.message || err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });

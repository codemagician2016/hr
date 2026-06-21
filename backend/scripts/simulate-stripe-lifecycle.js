#!/usr/bin/env node
/* eslint-disable no-console */
//
// simulate-stripe-lifecycle.js — sandbox-only "test clock" for Stripe (NZ).
//
// The Stripe twin of simulate-paddle-lifecycle.js. Forges Stripe-shaped webhook
// events, SIGNS them with STRIPE_WEBHOOK_SECRET (stripe.webhooks
// .generateTestHeaderString), pushes them through the REAL path —
// stripeGateway.verifyWebhook → recordStripeWebhookEvent →
// processStripeWebhookEventById → dispatch → syncBusinessSubscriptionFromStripe —
// and prints the Subscription row after each event. Deterministic + in-process,
// so it tests our reaction to the whole lifecycle without waiting real time and
// without Stripe delivering anything.
//
// SAFETY: hard-gated to a TEST Stripe key (sk_test_…); refuses on live.
//   ⚠ lifecycle handlers email the tenant admin — use a throwaway test tenant.
//
// Usage:
//   node scripts/simulate-stripe-lifecycle.js --business <slug|id> --reset --scenario full
//   node scripts/simulate-stripe-lifecycle.js --business <slug> --tier professional --cycle yearly --scenario dunning
//
// Scenarios: subscribe | trial | renew | dunning | recover | cancel | full

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getGateway } = require('../src/core/lib/billing/gateways');
const { getStripe } = require('../src/core/lib/billing/gateways/stripeGateway');

const stripeGw = getGateway('STRIPE');
if (stripeGw.environment() !== 'test') {
  console.error('\n✖ Refusing to run: Stripe is not in TEST mode (need sk_test_…). Prod (live) is blocked.\n');
  process.exit(1);
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error('\n✖ STRIPE_WEBHOOK_SECRET must be set so simulated events can be signed/verified.\n');
  process.exit(1);
}

const prisma = require('../src/core/lib/prisma');
const { recordStripeWebhookEvent, processStripeWebhookEventById } = require('../src/core/controllers/stripe.controller');
const { getFreeTier } = require('../src/core/lib/subscriptionBilling');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2); const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) out[k] = true; else { out[k] = n; i += 1; }
    } else out._.push(a);
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
function evtId() { n += 1; return `evt_sim_${RUN}_${n}`; }

const ctx = {};

function fmt(d) { try { return d ? new Date(d).toISOString().replace('.000Z', 'Z') : '-'; } catch { return String(d); } }

async function deliver(event) {
  const body = JSON.stringify(event);
  const header = getStripe().webhooks.generateTestHeaderString({ payload: body, secret: process.env.STRIPE_WEBHOOK_SECRET });
  // Verify (proves the signature path), then run the real record→process flow.
  const verified = stripeGw.verifyWebhook({ rawBody: Buffer.from(body), signatureHeader: header });
  const { event: row, duplicate, requeued } = await recordStripeWebhookEvent(verified);
  if (!duplicate || requeued) return processStripeWebhookEventById(row.id);
  return { processed: false, reason: 'duplicate' };
}

async function printState(label) {
  const s = await prisma.subscription.findUnique({ where: { businessId: ctx.businessId }, include: { tier: true } });
  if (!s) { console.log(`     ${label} (no subscription)`); return; }
  console.log(`     ${label} tier=${s.tier?.slug} status=${s.status} cycle=${s.billingCycle} gw=${s.gateway} sub=${s.stripeSubscriptionId || '-'}`);
  console.log(`       periodEnd=${fmt(s.currentPeriodEnd)} trialEnds=${fmt(s.trialEndsAt)} trialConverted=${fmt(s.trialConvertedAt)} pastDueSince=${fmt(s.pastDueSince)}`);
}

function meta() {
  return { businessId: ctx.businessId, businessSlug: ctx.businessSlug, tierSlug: ctx.tierSlug, billingCycle: ctx.cycle };
}
function subObject(status, periodEndSec) {
  return {
    id: ctx.subId, status, customer: ctx.customerId, latest_invoice: `in_sim_${RUN}_${n}`,
    current_period_end: periodEndSec, currency: ctx.currency.toLowerCase(),
    items: { data: [{ id: `si_sim_${RUN}`, price: { id: ctx.stripePriceId, currency: ctx.currency.toLowerCase(), unit_amount: ctx.amountMinor } }] },
    metadata: meta(),
  };
}
function envelope(type, object) { return { id: evtId(), type, created: nextSec(), data: { object } }; }

async function runEvent(label, event) {
  stepN += 1;
  console.log(`\n[${stepN}] ${label}  →  ${event.type}  (${event.id})`);
  const r = await deliver(event);
  console.log(r?.processed ? `     processed (${r.eventType || event.type})` : `     NOT processed: ${r?.reason || r?.status || '?'}`);
  await printState('state →');
}

function periodEnd() {
  return Math.floor((clockMs + (ctx.cycle === 'YEARLY' ? 365 : 30) * 86400000) / 1000);
}

const steps = {
  checkout: () => runEvent('checkout (session.completed)', envelope('checkout.session.completed', {
    id: `cs_sim_${RUN}`, customer: ctx.customerId, subscription: ctx.subId,
    currency: ctx.currency.toLowerCase(), amount_total: ctx.amountMinor, metadata: meta(),
  })),
  created_active: () => runEvent('activate (subscription.created)', envelope('customer.subscription.created', subObject('active', periodEnd()))),
  created_trial: () => runEvent('trial (subscription.created)', envelope('customer.subscription.created', subObject('trialing', periodEnd()))),
  updated_active: () => runEvent('renew/recover (subscription.updated)', envelope('customer.subscription.updated', subObject('active', periodEnd()))),
  payment_failed: () => runEvent('fail (invoice.payment_failed)', envelope('invoice.payment_failed', {
    id: `in_sim_${RUN}_${n}`, customer: ctx.customerId, subscription: ctx.subId, currency: ctx.currency.toLowerCase(),
    amount_due: ctx.amountMinor, lines: { data: [{ price: { id: ctx.stripePriceId } }] }, subscription_details: { metadata: meta() },
  })),
  past_due: () => runEvent('past_due (subscription.updated)', envelope('customer.subscription.updated', subObject('past_due', periodEnd()))),
  deleted: () => runEvent('cancel (subscription.deleted)', envelope('customer.subscription.deleted', subObject('canceled', periodEnd()))),
};

const SCENARIOS = {
  subscribe: ['checkout', 'created_active'],
  trial: ['checkout', 'created_trial', 'updated_active'],
  renew: ['checkout', 'created_active', 'updated_active'],
  dunning: ['checkout', 'created_active', 'payment_failed', 'past_due'],
  recover: ['checkout', 'created_active', 'payment_failed', 'past_due', 'updated_active'],
  cancel: ['checkout', 'created_active', 'deleted'],
  full: ['checkout', 'created_active', 'updated_active', 'payment_failed', 'past_due', 'updated_active', 'deleted'],
};

async function resetSubscription() {
  const free = await getFreeTier();
  if (!free) die('Free tier missing — run prisma/seeds/pricing.seed.js first.');
  await prisma.subscription.upsert({
    where: { businessId: ctx.businessId },
    update: {
      tierId: free.id, status: 'ACTIVE', billingCycle: 'MONTHLY', gateway: 'PADDLE',
      stripeCustomerId: null, stripeSubscriptionId: null,
      trialPlanSlug: null, trialStartedAt: null, trialEndsAt: null, trialConvertedAt: null,
      pastDueSince: null, accessGraceUntil: null,
      pendingTierSlug: null, pendingBillingCycle: null, pendingChangeEffectiveAt: null, pendingVertical: null,
      lastPaddleEventAt: null, lastPaddleEventId: null,
    },
    create: { businessId: ctx.businessId, tierId: free.id, status: 'ACTIVE', billingCycle: 'MONTHLY', theme: 'default', seatsUsed: 1 },
  });
  console.log('   ✓ reset to free + cleared gateway/stripe/trial/past-due state');
}

async function main() {
  const scenarioName = String(args.scenario || 'subscribe').toLowerCase();
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) die(`Unknown --scenario "${scenarioName}". One of: ${Object.keys(SCENARIOS).join(', ')}`);
  const cycle = String(args.cycle || 'monthly').toUpperCase() === 'YEARLY' ? 'YEARLY' : 'MONTHLY';

  const biz = await prisma.business.findFirst({
    where: { OR: [{ slug: String(args.business || '') }, { id: String(args.business || '') }] },
    select: { id: true, slug: true, name: true, vertical: true },
  });
  if (!biz) die(`No business for "${args.business}". Pass --business <slug|id>.`);

  const cycleField = cycle === 'YEARLY' ? 'stripePriceIdAnnual' : 'stripePriceIdMonthly';
  const rows = await prisma.tierPrice.findMany({
    where: { countryCode: 'NZ', [cycleField]: { not: null }, tier: { isActive: true, slug: { not: 'free' }, ...(args.tier && args.tier !== true ? { slug: String(args.tier) } : {}) } },
    include: { tier: true }, orderBy: { id: 'asc' },
  });
  const pool = rows.filter((r) => String(r.tier.vertical) === String(biz.vertical));
  const row = (pool.length ? pool : rows)[0];
  if (!row) die(`No NZ TierPrice with ${cycleField}${args.tier && args.tier !== true ? ` for tier ${args.tier}` : ''}. Run setup-stripe-catalog.js + backfill-stripe-prices.js.`);

  Object.assign(ctx, {
    businessId: biz.id, businessSlug: biz.slug, tierSlug: row.tier.slug, cycle,
    stripePriceId: cycle === 'YEARLY' ? row.stripePriceIdAnnual : row.stripePriceIdMonthly,
    currency: row.currencyCode, amountMinor: cycle === 'YEARLY' ? row.amountAnnualMinor : row.amountMonthlyMinor,
    customerId: `cus_sim_${RUN}`, subId: `sub_sim_${RUN}`,
  });

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(' Stripe lifecycle simulator (sandbox/NZ)');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  stripe env  ${stripeGw.environment()}`);
  console.log(`  business    ${biz.name} [${biz.slug}] vertical=${biz.vertical}`);
  console.log(`  tier        ${ctx.tierSlug} (${ctx.cycle})`);
  console.log(`  price       ${ctx.stripePriceId}  ${ctx.currency} ${(ctx.amountMinor / 100).toFixed(2)}`);
  console.log(`  scenario    ${scenarioName}  →  ${scenario.join(' → ')}`);
  console.log('  ⚠ lifecycle handlers may email the tenant admin — use a test tenant.');
  console.log('────────────────────────────────────────────────────────────');

  console.log('\n• Starting state:'); await printState('state →');
  if (args.reset) { console.log('\n• Reset:'); await resetSubscription(); }
  for (const key of scenario) await steps[key]();
  console.log('\n• Final state:'); await printState('state →');
  console.log('\n✓ Done.\n');
}

main()
  .catch((err) => { console.error('\n✖ Simulation failed:', err?.stack || err?.message || err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });

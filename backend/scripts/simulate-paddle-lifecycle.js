#!/usr/bin/env node
/* eslint-disable no-console */
//
// simulate-paddle-lifecycle.js — a sandbox-only "test clock" for Paddle billing.
//
// WHY THIS EXISTS
// Stripe has Test Clocks that fast-forward a subscription through its billing
// lifecycle. Paddle has no equivalent. But in this codebase every subscription
// state change arrives as a *webhook* and is applied by paddle.controller.js —
// so we can drive the whole lifecycle deterministically by feeding it the same
// events Paddle would send, in whatever order/time we choose. This script is
// that driver: it forges Paddle webhook payloads and pushes them through the
// REAL handler path (recordPaddleWebhookEvent -> processPaddleWebhookEventById
// -> dispatchPaddleWebhookPayload), printing the resulting Subscription row
// after each event.
//
// WHAT IT DOES *NOT* DO
// It cannot speed up Paddle's own billing engine (real dunning retries, real
// renewals). It tests OUR reaction to lifecycle events, which is the part that
// is currently untested (the Vitest billing suite is written in Jest syntax and
// runs 0 tests). For Paddle's own timing, use a sandbox `interval: day` price
// plus the Paddle dashboard's Simulations feature.
//
// SAFETY
//   * HARD-GATED to PADDLE_ENVIRONMENT=sandbox. It refuses to run otherwise, so
//     it can never touch the production database (prod runs PADDLE_ENVIRONMENT=live).
//   * It also prints the target DB host + business + tier before running.
//   * It only ever uses synthetic ids (sub_sim_* / txn_sim_* / ctm_sim_*), so it
//     never collides with real Paddle objects.
//
//   NOTE: the lifecycle handlers send real emails (started / payment-failed /
//   cancelled) to the business's admin, best-effort. Run this against a THROWAWAY
//   test tenant, not a real customer.
//
// USAGE (env must supply DATABASE_URL and PADDLE_ENVIRONMENT=sandbox):
//   node scripts/simulate-paddle-lifecycle.js --business <slug|id> [options]
//
// OPTIONS
//   --business <slug|id>   (required) which tenant to drive
//   --tier <slug>          paid tier to simulate (default: a paid tier matching
//                          the tenant's vertical that has a Paddle price id)
//   --cycle <monthly|yearly>   default: monthly
//   --scenario <name>      default: subscribe. One of:
//                            subscribe  pay -> activate                  (ends paid+ACTIVE)
//                            trial      pay -> trialing -> convert        (trial then convert)
//                            renew      pay -> activate -> renew          (a second billing period)
//                            dunning    pay -> activate -> fail -> pastdue
//                            recover    pay -> activate -> fail -> pastdue -> recover
//                            cancel     pay -> activate -> cancel         (downgrades to free)
//                            refund     pay -> activate -> refund         (revokes access)
//                            full       pay -> activate -> renew -> fail -> pastdue -> recover -> cancel
//   --reset                reset the tenant to free + clear paddle/trial/past-due state first
//   --http <baseUrl>       instead of in-process, POST signed webhooks to a running
//                          backend (needs PADDLE_WEBHOOK_SECRET). No DB verification.
//   --yes                  run without the interactive-style confirmation pause
//
// EXAMPLES
//   node scripts/simulate-paddle-lifecycle.js --business demo --reset --scenario full
//   node scripts/simulate-paddle-lifecycle.js --business demo --tier professional --cycle yearly --scenario dunning

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* dotenv optional */ }

const crypto = require('crypto');

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function die(msg, code = 1) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(code);
}

if (args.help || args.h) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(0);
}

// ---- safety gate (do this BEFORE requiring prisma so a misconfig can't connect)
const { getPaddleEnvironment, getPaddleWebhookSecret } = require('../src/core/lib/paddle');
const PADDLE_ENV = getPaddleEnvironment();
if (PADDLE_ENV !== 'sandbox') {
  die(
    `Refusing to run: PADDLE_ENVIRONMENT is "${PADDLE_ENV}", not "sandbox".\n`
    + `  This script mutates subscription/billing state, so it only runs against a\n`
    + `  sandbox environment. Prod runs PADDLE_ENVIRONMENT=live and is intentionally\n`
    + `  blocked. Set PADDLE_ENVIRONMENT=sandbox (staging/local) to proceed.`,
  );
}

const prisma = require('../src/core/lib/prisma');
const {
  recordPaddleWebhookEvent,
  processPaddleWebhookEventById,
} = require('../src/core/controllers/paddle.controller');
const { getPriceIdForBillingCycle, getFreeTier } = require('../src/core/lib/subscriptionBilling');

// ---- helpers ---------------------------------------------------------------
function dbHost() {
  try {
    const u = new URL(process.env.DATABASE_URL || '');
    return `${u.hostname}${u.port ? `:${u.port}` : ''}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function fmt(d) {
  if (!d) return '-';
  try { return new Date(d).toISOString().replace('.000Z', 'Z'); } catch { return String(d); }
}

const RUN = Date.now().toString(36);
let stepN = 0;
let eventN = 0;
// Monotonic event clock. syncBusinessSubscriptionFromPaddle ignores events whose
// occurred_at is older than the last one applied, so every event must advance.
let clockMs = Date.now();
function nextClock() {
  clockMs += 60 * 1000; // +1 minute per event
  return new Date(clockMs).toISOString();
}
function eventId() {
  eventN += 1;
  return `evt_sim_${RUN}_${eventN}`;
}

async function deliverInProcess(payload) {
  const { event, duplicate, requeued } = await recordPaddleWebhookEvent(payload);
  if (duplicate && !requeued) {
    return { processed: false, reason: 'duplicate' };
  }
  return processPaddleWebhookEventById(event.id);
}

async function deliverHttp(payload, base) {
  const secret = getPaddleWebhookSecret();
  if (!secret) die('--http requires PADDLE_WEBHOOK_SECRET to sign the webhook.');
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  const res = await fetch(`${base.replace(/\/$/, '')}/api/paddle/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Paddle-Signature': `ts=${ts};h1=${h1}` },
    body,
  });
  const text = await res.text().catch(() => '');
  return { processed: res.ok, http: res.status, body: text.slice(0, 200) };
}

let deliver;

async function printSubState(prefix) {
  const sub = await prisma.subscription.findUnique({
    where: { businessId: ctx.businessId },
    include: { tier: true },
  });
  if (!sub) { console.log(`     ${prefix} (no subscription row)`); return; }
  console.log(
    `     ${prefix} tier=${sub.tier?.slug || '?'} status=${sub.status} cycle=${sub.billingCycle}`
    + ` sub=${sub.paddleSubscriptionId || '-'} txn=${sub.paddleTransactionId || '-'}`,
  );
  console.log(
    `       periodEnd=${fmt(sub.currentPeriodEnd)} trialEnds=${fmt(sub.trialEndsAt)}`
    + ` trialConverted=${fmt(sub.trialConvertedAt)} pastDueSince=${fmt(sub.pastDueSince)}`,
  );
}

// ---- payload builders ------------------------------------------------------
const ctx = {}; // filled in main()

function customData(extra = {}) {
  return {
    businessId: ctx.businessId,
    businessSlug: ctx.businessSlug,
    kind: 'plan',
    checkoutKind: 'plan_subscription',
    tierSlug: ctx.tierSlug,
    billingCycle: ctx.cycle,
    expectedPriceId: ctx.priceId,
    expectedCurrencyCode: ctx.currency,
    expectedAmountMinor: String(ctx.amountMinor),
    ...extra,
  };
}

function items() {
  return [{
    quantity: 1,
    price: {
      id: ctx.priceId,
      unit_price: { amount: String(ctx.amountMinor), currency_code: ctx.currency },
    },
  }];
}

function periodFor(startIso) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + (ctx.cycle === 'YEARLY' ? 365 : 30) * 24 * 60 * 60 * 1000);
  return { starts_at: start.toISOString(), ends_at: end.toISOString() };
}

function txnCompletedPayload({ txnId, origin = null }) {
  const occurred = nextClock();
  return {
    event_id: eventId(),
    event_type: 'transaction.completed',
    occurred_at: occurred,
    data: {
      id: txnId,
      status: 'completed',
      customer_id: ctx.customerId,
      // Deliberately NO subscription_id: that branch calls the live Paddle API
      // (getPaddleSubscription). Omitting it keeps the sim fully offline; the
      // subsequent subscription.* event carries the real state.
      currency_code: ctx.currency,
      origin: origin || undefined,
      billed_at: occurred,
      items: items(),
      details: {
        totals: {
          currency_code: ctx.currency,
          grand_total: String(ctx.amountMinor),
          total: String(ctx.amountMinor),
          discount: '0',
        },
      },
      custom_data: customData(),
    },
  };
}

function subscriptionPayload({ eventType, status, txnId, scheduledChange = null, startIso }) {
  const occurred = nextClock();
  const period = periodFor(startIso || occurred);
  return {
    event_id: eventId(),
    event_type: eventType,
    occurred_at: occurred,
    data: {
      id: ctx.subId,
      status,
      customer_id: ctx.customerId,
      transaction_id: txnId || undefined,
      currency_code: ctx.currency,
      billing_cycle: { interval: ctx.cycle === 'YEARLY' ? 'year' : 'month', frequency: 1 },
      current_billing_period: period,
      next_billed_at: period.ends_at,
      scheduled_change: scheduledChange,
      items: items(),
      custom_data: customData(),
      created_at: ctx.createdAt,
      updated_at: occurred,
    },
  };
}

function paymentFailedPayload({ txnId }) {
  return {
    event_id: eventId(),
    event_type: 'transaction.payment_failed',
    occurred_at: nextClock(),
    data: {
      id: txnId,
      status: 'payment_failed',
      customer_id: ctx.customerId,
      subscription_id: ctx.subId,
      currency_code: ctx.currency,
      items: items(),
      payments: [{ error_code: 'declined', error_message: 'Card declined (simulated)' }],
      custom_data: customData(),
    },
  };
}

function refundPayload({ txnId }) {
  return {
    event_id: eventId(),
    event_type: 'adjustment.created',
    occurred_at: nextClock(),
    data: {
      id: `adj_sim_${RUN}_${eventN + 1}`,
      action: 'refund',
      status: 'approved',
      type: 'full',
      transaction_id: txnId,
      subscription_id: ctx.subId,
      customer_id: ctx.customerId,
      currency_code: ctx.currency,
      custom_data: customData(),
    },
  };
}

// ---- step runner -----------------------------------------------------------
async function runEvent(label, payload) {
  stepN += 1;
  console.log(`\n[${stepN}] ${label}  →  ${payload.event_type}  (${payload.event_id})`);
  const result = await deliver(payload);
  if (ctx.http) {
    console.log(`     http ${result.http} ${result.body || ''}`);
  } else if (result?.processed) {
    console.log(`     processed (${result.eventType || payload.event_type})`);
    await printSubState('state →');
  } else {
    console.log(`     NOT processed: ${result?.reason || result?.status || 'see logs above'}`);
    await printSubState('state →');
  }
}

// Each step key maps to a function emitting one or more events.
async function stepPay({ origin = null } = {}) {
  ctx.lastTxnId = `txn_sim_${RUN}_${stepN + 1}`;
  await runEvent(`pay (transaction.completed${origin ? ` origin=${origin}` : ''})`, txnCompletedPayload({ txnId: ctx.lastTxnId, origin }));
}
async function stepActivate() {
  await runEvent('activate (subscription.activated)', subscriptionPayload({
    eventType: 'subscription.activated', status: 'active', txnId: ctx.lastTxnId, startIso: ctx.createdAt,
  }));
}
async function stepTrial() {
  await runEvent('trial (subscription.trialing)', subscriptionPayload({
    eventType: 'subscription.trialing', status: 'trialing', txnId: ctx.lastTxnId, startIso: ctx.createdAt,
  }));
}
async function stepConvert() {
  await runEvent('convert (subscription.activated)', subscriptionPayload({
    eventType: 'subscription.activated', status: 'active', txnId: ctx.lastTxnId,
  }));
}
async function stepRenew() {
  await stepPay(); // a fresh transaction.completed for the new period
  await runEvent('renew (subscription.updated)', subscriptionPayload({
    eventType: 'subscription.updated', status: 'active', txnId: ctx.lastTxnId,
  }));
}
async function stepFail() {
  await runEvent('fail (transaction.payment_failed)', paymentFailedPayload({ txnId: `txn_sim_${RUN}_${stepN + 1}` }));
}
async function stepPastDue() {
  await runEvent('past_due (subscription.past_due)', subscriptionPayload({
    eventType: 'subscription.past_due', status: 'past_due', txnId: ctx.lastTxnId,
  }));
}
async function stepRecover() {
  await stepPay(); // retry succeeds -> a completed transaction clears the defer guard
  await runEvent('recover (subscription.activated)', subscriptionPayload({
    eventType: 'subscription.activated', status: 'active', txnId: ctx.lastTxnId,
  }));
}
async function stepCancel() {
  await runEvent('cancel (subscription.canceled)', subscriptionPayload({
    eventType: 'subscription.canceled', status: 'canceled', txnId: ctx.lastTxnId,
  }));
}
async function stepRefund() {
  await runEvent('refund (adjustment.created, full/approved)', refundPayload({ txnId: ctx.lastTxnId }));
}

const SCENARIOS = {
  subscribe: async () => { await stepPay({ origin: 'web' }); await stepActivate(); },
  trial: async () => { await stepPay({ origin: 'web' }); await stepTrial(); await stepConvert(); },
  renew: async () => { await stepPay({ origin: 'web' }); await stepActivate(); await stepRenew(); },
  dunning: async () => { await stepPay({ origin: 'web' }); await stepActivate(); await stepFail(); await stepPastDue(); },
  recover: async () => { await stepPay({ origin: 'web' }); await stepActivate(); await stepFail(); await stepPastDue(); await stepRecover(); },
  cancel: async () => { await stepPay({ origin: 'web' }); await stepActivate(); await stepCancel(); },
  refund: async () => { await stepPay({ origin: 'web' }); await stepActivate(); await stepRefund(); },
  full: async () => {
    await stepPay({ origin: 'web' }); await stepActivate(); await stepRenew();
    await stepFail(); await stepPastDue(); await stepRecover(); await stepCancel();
  },
};

// ---- resolution ------------------------------------------------------------
async function resolveBusiness(token) {
  if (!token || token === true) die('--business <slug|id> is required.');
  const biz = await prisma.business.findFirst({
    where: { OR: [{ slug: String(token) }, { id: String(token) }] },
    select: { id: true, slug: true, name: true, vertical: true, country: true },
  });
  if (!biz) die(`No business found for "${token}" (tried slug and id).`);
  return biz;
}

async function resolvePriceRow({ tierSlug, vertical, cycle }) {
  const cycleField = cycle === 'YEARLY' ? 'paddlePriceIdAnnual' : 'paddlePriceIdMonthly';
  const rows = await prisma.tierPrice.findMany({
    where: {
      [cycleField]: { not: null },
      tier: { isActive: true, slug: { not: 'free' } },
      ...(tierSlug ? { tier: { slug: String(tierSlug), isActive: true } } : {}),
    },
    include: { tier: true },
    orderBy: { id: 'asc' },
  });
  if (!rows.length) {
    die(`No paid TierPrice row with a ${cycleField} found${tierSlug ? ` for tier "${tierSlug}"` : ''}. `
      + 'Has the Paddle catalog been set up (scripts/setup-paddle-catalog.js / backfill-paddle-prices.js)?');
  }
  // Prefer the tenant's vertical, then the canonical USD base row, then anything.
  const byVertical = rows.filter((r) => String(r.tier.vertical) === String(vertical));
  const pool = byVertical.length ? byVertical : rows;
  return pool.find((r) => r.countryCode === null) || pool[0];
}

async function resetSubscription() {
  const free = await getFreeTier();
  if (!free) die('Free tier missing — run prisma/seeds/pricing.seed.js first.');
  await prisma.subscription.upsert({
    where: { businessId: ctx.businessId },
    update: {
      tierId: free.id, status: 'ACTIVE', billingCycle: 'MONTHLY',
      paddleCustomerId: null, paddleSubscriptionId: null, paddleTransactionId: null,
      trialPlanSlug: null, trialStartedAt: null, trialEndsAt: null, trialConvertedAt: null,
      pastDueSince: null, accessGraceUntil: null,
      pendingTierSlug: null, pendingBillingCycle: null, pendingChangeEffectiveAt: null, pendingVertical: null,
    },
    create: {
      businessId: ctx.businessId, tierId: free.id, status: 'ACTIVE',
      billingCycle: 'MONTHLY', theme: 'default', seatsUsed: 1,
    },
  });
  console.log('   ✓ reset to free tier + cleared paddle/trial/past-due state');
}

// ---- main ------------------------------------------------------------------
async function main() {
  const scenarioName = String(args.scenario || 'subscribe').toLowerCase();
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) die(`Unknown --scenario "${scenarioName}". One of: ${Object.keys(SCENARIOS).join(', ')}`);

  const cycle = String(args.cycle || 'monthly').toUpperCase() === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
  const biz = await resolveBusiness(args.business);
  const priceRow = await resolvePriceRow({ tierSlug: args.tier === true ? null : args.tier, vertical: biz.vertical, cycle });

  Object.assign(ctx, {
    businessId: biz.id,
    businessSlug: biz.slug,
    tierSlug: priceRow.tier.slug,
    cycle,
    priceId: getPriceIdForBillingCycle(priceRow, cycle),
    currency: priceRow.currencyCode,
    amountMinor: cycle === 'YEARLY' ? priceRow.amountAnnualMinor : priceRow.amountMonthlyMinor,
    customerId: `ctm_sim_${RUN}`,
    subId: `sub_sim_${RUN}`,
    createdAt: new Date(clockMs).toISOString(),
    http: typeof args.http === 'string' ? args.http : null,
  });

  deliver = ctx.http ? (p) => deliverHttp(p, ctx.http) : deliverInProcess;

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(' Paddle lifecycle simulator (sandbox)');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  env         PADDLE_ENVIRONMENT=${PADDLE_ENV}`);
  console.log(`  database    ${dbHost()}`);
  console.log(`  delivery    ${ctx.http ? `HTTP → ${ctx.http} (no DB verification)` : 'in-process (deterministic)'}`);
  console.log(`  business    ${biz.name}  [${biz.slug}]  vertical=${biz.vertical}`);
  console.log(`  tier        ${ctx.tierSlug}  (${ctx.cycle})`);
  console.log(`  price       ${ctx.priceId}  ${ctx.currency} ${(ctx.amountMinor / 100).toFixed(2)} (minor=${ctx.amountMinor})`);
  console.log(`  scenario    ${scenarioName}`);
  console.log(`  ids         sub=${ctx.subId} customer=${ctx.customerId}`);
  console.log('  ⚠ lifecycle handlers may email the tenant admin — use a test tenant.');
  console.log('────────────────────────────────────────────────────────────');

  if (!ctx.amountMinor) {
    die(`Resolved amount is 0 for tier ${ctx.tierSlug} (${ctx.cycle}); reconciliation would reject it. Pick a priced tier/cycle.`);
  }

  if (!ctx.http) {
    console.log('\n• Starting state:');
    await printSubState('state →');
  }

  if (args.reset) {
    console.log('\n• Reset:');
    await resetSubscription();
  }

  await scenario();

  if (!ctx.http) {
    console.log('\n• Final state:');
    await printSubState('state →');
  }
  console.log('\n✓ Done.\n');
}

main()
  .catch((err) => { console.error('\n✖ Simulation failed:', err?.stack || err?.message || err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });

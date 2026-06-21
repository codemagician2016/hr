'use strict';

// Publish-to-gateways service — the engine behind the super-admin "Publish
// prices" action. It makes super-admin the source of truth for the CHARGED
// price: for each sellable tier it (re)creates the gateway plan at the current
// TierPrice amount and writes the plan id back onto the row. Gateway plans are
// IMMUTABLE, so a changed amount mints a NEW plan and swaps the id; an unchanged
// amount is reused (idempotent — safe to run repeatedly). This is the in-process
// port of the standalone setup-*-catalog scripts, writing ids straight to the DB
// instead of a JSON file (so it also supersedes the backfill step).
//
// dryRun=true => "preview" (computes the before/after diff, mutates nothing).

const prisma = require('./prisma');
const { getGateway } = require('./billing/gateways');

const VERTICAL_LABEL = { APPOINTMENT: 'Booking', STATIC: 'Website', ECOMMERCE: 'Store' };
const APP_TAG = 'sitepresso'; // tag every product/price so we never touch sibling-app catalogs

// Which gateway bills which country/currency, and the TierPrice id columns it owns.
// Razorpay (IN/INR) + Stripe (NZ/NZD) price a per-country row; Paddle (rest of
// world) prices the BASE USD row and the resulting id applies to every row.
const GATEWAY_TARGETS = {
  RAZORPAY: { country: 'IN', currency: 'INR', monthlyId: 'razorpayPlanIdMonthly', annualId: 'razorpayPlanIdAnnual' },
  STRIPE:   { country: 'NZ', currency: 'nzd', monthlyId: 'stripePriceIdMonthly',  annualId: 'stripePriceIdAnnual' },
  PADDLE:   { country: null, currency: 'USD', monthlyId: 'paddlePriceIdMonthly',  annualId: 'paddlePriceIdAnnual' },
};

const SUPPORTED = Object.keys(GATEWAY_TARGETS);

function normalizeGateways(gateways) {
  const requested = Array.isArray(gateways) && gateways.length
    ? gateways.map((g) => String(g).toUpperCase())
    : SUPPORTED;
  return requested.filter((g) => SUPPORTED.includes(g));
}

// Active, non-custom (sellable) tiers + their price row for the target country.
async function sellableTiersWithPrice(countryCode) {
  const tiers = await prisma.pricingTier.findMany({
    where: { isActive: true, isCustomPriced: false },
    orderBy: [{ vertical: 'asc' }, { sortOrder: 'asc' }],
    include: { prices: { where: { countryCode } } },
  });
  return tiers.map((t) => ({ tier: t, price: (t.prices || [])[0] || null }));
}

// ── Razorpay publisher ───────────────────────────────────────────────────────
async function razorpayAction(gw, existingId, amountMinor, period) {
  if (!existingId) return 'create';
  const plan = await gw.getPlan(existingId).catch(() => null);
  // Reuse only if the live plan still charges exactly this amount AND on the
  // right cadence. A plan id whose period drifted (e.g. a monthly plan parked in
  // the annual slot with a matching amount) must be re-minted, never reused —
  // otherwise an annual subscription would bill monthly. Mirrors the Stripe
  // branch's interval check. (B11)
  if (plan
    && Number(plan?.item?.amount) === Number(amountMinor)
    && (!period || String(plan?.period || '').toLowerCase() === String(period).toLowerCase())) {
    return 'reuse';
  }
  return 'create';
}

async function publishRazorpay({ dryRun }) {
  const gw = getGateway('RAZORPAY');
  const target = GATEWAY_TARGETS.RAZORPAY;
  const rows = [];
  if (!gw.isConfigured()) return { gateway: 'RAZORPAY', configured: false, rows };

  const nested = await Promise.all((await sellableTiersWithPrice(target.country)).map(async ({ tier, price }) => {
    if (!price || !(price.amountMonthlyMinor > 0)) {
      return [{ tier: tier.slug, vertical: tier.vertical, status: 'skipped', reason: `no ${target.country} price` }];
    }
    const out = [];
    for (const period of ['monthly', 'yearly']) {
      const amountMinor = period === 'monthly' ? price.amountMonthlyMinor : price.amountAnnualMinor;
      const idField = period === 'monthly' ? target.monthlyId : target.annualId;
      const existingId = price[idField] || null;
      const action = await razorpayAction(gw, existingId, amountMinor, period);
      const row = {
        tier: tier.slug, vertical: tier.vertical, period, currency: target.currency,
        amountMinor, existingPlanId: existingId, action,
        status: dryRun ? 'preview' : (action === 'reuse' ? 'reused' : 'pending'),
      };
      if (!dryRun && action === 'create') {
        try {
          const plan = await gw.createPlan({
            name: `${VERTICAL_LABEL[tier.vertical] || tier.vertical} ${tier.name} (${target.country} ${period === 'yearly' ? 'annual' : 'monthly'})`,
            period, interval: 1, amountMinor, currency: target.currency,
            description: `Sitepresso ${tier.name} plan`,
          });
          await prisma.tierPrice.update({ where: { id: price.id }, data: { [idField]: plan.id } });
          row.newPlanId = plan.id;
          row.status = 'created';
        } catch (err) {
          row.status = 'failed';
          row.error = err?.message || String(err);
        }
      }
      out.push(row);
    }
    return out;
  }));
  for (const r of nested) rows.push(...r);
  return { gateway: 'RAZORPAY', configured: true, rows };
}

// ── Stripe publisher (NZ/NZD) ────────────────────────────────────────────────
// Stripe Prices are immutable; a changed amount creates a NEW price on the same
// Product. The Product is resolved from an existing price, else created.
async function publishStripe({ dryRun }) {
  const target = GATEWAY_TARGETS.STRIPE;
  const rows = [];
  let stripe;
  try {
    stripe = require('./billing/gateways/stripeGateway').getStripe();
  } catch {
    return { gateway: 'STRIPE', configured: false, rows };
  }

  const nested = await Promise.all((await sellableTiersWithPrice(target.country)).map(async ({ tier, price }) => {
    if (!price || !(price.amountMonthlyMinor > 0)) {
      return [{ tier: tier.slug, vertical: tier.vertical, status: 'skipped', reason: `no ${target.country} price` }];
    }
    const out = [];
    // Resolve the product from any existing price; create one only when publishing.
    let productId = null;
    for (const idField of [target.monthlyId, target.annualId]) {
      if (price[idField]) {
        const existing = await stripe.prices.retrieve(price[idField]).catch(() => null);
        if (existing?.product) { productId = existing.product; break; }
      }
    }
    for (const period of ['monthly', 'yearly']) {
      const amountMinor = period === 'monthly' ? price.amountMonthlyMinor : price.amountAnnualMinor;
      const idField = period === 'monthly' ? target.monthlyId : target.annualId;
      const interval = period === 'monthly' ? 'month' : 'year';
      const existingId = price[idField] || null;
      let action = 'create';
      if (existingId) {
        const existing = await stripe.prices.retrieve(existingId).catch(() => null);
        if (existing && existing.unit_amount === amountMinor && existing.currency === target.currency && existing.recurring?.interval === interval) action = 'reuse';
      }
      const row = { tier: tier.slug, vertical: tier.vertical, period, currency: target.currency.toUpperCase(), amountMinor, existingPlanId: existingId, action, status: dryRun ? 'preview' : (action === 'reuse' ? 'reused' : 'pending') };
      if (!dryRun && action === 'create') {
        try {
          if (!productId) {
            const product = await stripe.products.create({ name: `${VERTICAL_LABEL[tier.vertical] || tier.vertical} ${tier.name} (${target.country})`, metadata: { app: APP_TAG, tierSlug: tier.slug, vertical: tier.vertical, country: target.country } });
            productId = product.id;
          }
          const created = await stripe.prices.create({ product: productId, currency: target.currency, unit_amount: amountMinor, recurring: { interval }, metadata: { app: APP_TAG, tierSlug: tier.slug, vertical: tier.vertical, country: target.country } });
          await prisma.tierPrice.update({ where: { id: price.id }, data: { [idField]: created.id } });
          row.newPlanId = created.id; row.status = 'created';
        } catch (err) { row.status = 'failed'; row.error = err?.message || String(err); }
      }
      out.push(row);
    }
    return out;
  }));
  for (const r of nested) rows.push(...r);
  return { gateway: 'STRIPE', configured: true, rows };
}

// ── Paddle publisher (rest of world; base USD) ───────────────────────────────
function paddleBaseUrl() {
  return String(process.env.PADDLE_ENVIRONMENT || '').toLowerCase() === 'sandbox'
    ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
}
async function paddleApi(method, pathname, body) {
  const apiKey = String(process.env.PADDLE_API_KEY || '').trim();
  if (!apiKey) throw new Error('PADDLE_API_KEY is not set');
  const res = await fetch(`${paddleBaseUrl()}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const first = Array.isArray(json?.error?.errors) ? json.error.errors[0] : null;
    throw new Error(first?.detail || json?.error?.detail || `Paddle ${method} ${pathname} (${res.status})`);
  }
  return json.data;
}

async function publishPaddle({ dryRun }) {
  const target = GATEWAY_TARGETS.PADDLE;
  const rows = [];
  if (!String(process.env.PADDLE_API_KEY || '').trim()) return { gateway: 'PADDLE', configured: false, rows };

  // Paddle prices the BASE USD row; the resulting price id is written to ALL of
  // the tier's TierPrice rows (Paddle localizes per buyer at checkout).
  const nested = await Promise.all((await sellableTiersWithPrice(null)).map(async ({ tier, price }) => {
    if (!price || !(price.amountMonthlyMinor > 0)) {
      return [{ tier: tier.slug, vertical: tier.vertical, status: 'skipped', reason: 'no base USD price' }];
    }
    const out = [];
    const currency = price.currencyCode || 'USD';
    let productId = null;
    for (const idField of [target.monthlyId, target.annualId]) {
      if (price[idField]) {
        const existing = await paddleApi('GET', `/prices/${price[idField]}`).catch(() => null);
        if (existing?.product_id) { productId = existing.product_id; break; }
      }
    }
    for (const cycle of ['monthly', 'annual']) {
      const amountMinor = cycle === 'monthly' ? price.amountMonthlyMinor : price.amountAnnualMinor;
      const idField = cycle === 'monthly' ? target.monthlyId : target.annualId;
      const interval = cycle === 'monthly' ? 'month' : 'year';
      const existingId = price[idField] || null;
      // The tier's trial must be BAKED INTO the Paddle price (Paddle prices carry
      // their own trial_period). Keep it in sync with tier.trialDays so the
      // checkout guard (assertPaddlePriceMatchesTierTrial) passes — otherwise new
      // signups dead-end with "the Paddle price must have a/no trial period".
      const tierTrialDays = Number.parseInt(tier?.trialDays, 10);
      const wantTrial = Number.isFinite(tierTrialDays) && tierTrialDays > 0;
      let action = 'create';
      if (existingId) {
        const existing = await paddleApi('GET', `/prices/${existingId}`).catch(() => null);
        const exTrialDays = Number(existing?.trial_period?.frequency);
        const exHasDayTrial = String(existing?.trial_period?.interval || '').toLowerCase() === 'day' && exTrialDays > 0;
        const trialMatches = wantTrial ? (exHasDayTrial && exTrialDays === tierTrialDays) : !existing?.trial_period;
        // Reuse only if amount AND currency AND billing interval AND trial config
        // all still match — an amount-only check would silently keep a price whose
        // currency / cadence / trial drifted (mirror Stripe's 3-field check). (B11)
        if (existing
          && Number(existing.unit_price?.amount) === Number(amountMinor)
          && String(existing.unit_price?.currency_code || currency).toUpperCase() === String(currency).toUpperCase()
          && String(existing.billing_cycle?.interval || interval).toLowerCase() === String(interval).toLowerCase()
          && trialMatches) {
          action = 'reuse';
        }
      }
      const row = { tier: tier.slug, vertical: tier.vertical, period: cycle, currency, amountMinor, existingPlanId: existingId, action, status: dryRun ? 'preview' : (action === 'reuse' ? 'reused' : 'pending') };
      if (!dryRun && action === 'create') {
        try {
          if (!productId) {
            const product = await paddleApi('POST', '/products', { name: `Sitepresso ${VERTICAL_LABEL[tier.vertical] || tier.vertical} — ${tier.name}`, tax_category: 'saas', custom_data: { app: APP_TAG, tierSlug: tier.slug, vertical: tier.vertical } });
            productId = product.id;
          }
          const created = await paddleApi('POST', '/prices', {
            product_id: productId,
            description: `${tier.name} ${cycle === 'monthly' ? 'Monthly' : 'Annual'}`,
            billing_cycle: { interval, frequency: 1 },
            // Bake the tier's trial into the price (card-required), matching the
            // checkout guard; omit entirely for no-trial tiers.
            ...(wantTrial ? { trial_period: { interval: 'day', frequency: tierTrialDays } } : {}),
            unit_price: { amount: String(amountMinor), currency_code: currency },
            quantity: { minimum: 1, maximum: 1 },
            tax_mode: 'external',
            custom_data: { app: APP_TAG, tierSlug: tier.slug, cycle },
          });
          await prisma.tierPrice.updateMany({ where: { tierId: tier.id }, data: { [idField]: created.id, lastSyncedToPaddleAt: new Date() } });
          row.newPlanId = created.id; row.status = 'created';
        } catch (err) { row.status = 'failed'; row.error = err?.message || String(err); }
      }
      out.push(row);
    }
    return out;
  }));
  for (const r of nested) rows.push(...r);
  return { gateway: 'PADDLE', configured: true, rows };
}

const PUBLISHERS = { RAZORPAY: publishRazorpay, STRIPE: publishStripe, PADDLE: publishPaddle };

async function runPublish({ gateways, dryRun } = {}) {
  const targets = normalizeGateways(gateways);
  // Run the gateways CONCURRENTLY — each makes live API round-trips per plan, so
  // sequential was ~3× slower (the preview/sync was timing out at ~20s). One
  // gateway's failure must not abort the others (PARTIAL is acceptable).
  const results = await Promise.all(targets.map(async (g) => {
    try {
      return await PUBLISHERS[g]({ dryRun });
    } catch (err) {
      return { gateway: g, configured: true, error: err?.message || String(err), rows: [] };
    }
  }));
  const summary = results.reduce((acc, r) => {
    for (const row of (r.rows || [])) acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  return { dryRun: !!dryRun, gateways: targets, results, summary };
}

// ── Auto-sync — keep gateway plans in lock-step with the price catalog ───────
// Fired (non-blocking) after any pricing change so super-admin never has to
// remember to "Publish". Idempotent (amount-aware reuse), no-op for gateways
// that aren't configured. Bursts of saves collapse into a single trailing run.
// Escape hatch: PRICING_AUTO_SYNC_GATEWAYS=false.
let _syncInFlight = false;
let _syncQueued = false;
function syncGatewaysBackground(reason = 'price change') {
  if (String(process.env.PRICING_AUTO_SYNC_GATEWAYS || 'true').toLowerCase() === 'false') return;
  if (_syncInFlight) { _syncQueued = true; return; }
  _syncInFlight = true;
  Promise.resolve()
    .then(() => runPublish({ dryRun: false }))
    .then((r) => console.log(`[gateway auto-sync] (${reason})`, JSON.stringify(r.summary || {})))
    .catch((err) => console.error('[gateway auto-sync] failed:', err?.message || err))
    .finally(() => {
      _syncInFlight = false;
      if (_syncQueued) { _syncQueued = false; syncGatewaysBackground('queued re-sync'); }
    });
}

const FIELD_BY_GATEWAY = {
  STRIPE: { MONTHLY: 'stripePriceIdMonthly', YEARLY: 'stripePriceIdAnnual' },
  RAZORPAY: { MONTHLY: 'razorpayPlanIdMonthly', YEARLY: 'razorpayPlanIdAnnual' },
  PADDLE: { MONTHLY: 'paddlePriceIdMonthly', YEARLY: 'paddlePriceIdAnnual' },
};

// Self-heal a single gateway price/plan id at the POINT OF USE (checkout): if
// it's missing for this tier+country, publish that gateway (idempotent) and
// re-read. Returns the id, or null if it still can't be produced (gateway not
// configured / no amount). The safety net behind auto-sync — a signup never
// dead-ends on a price that just hadn't been published yet.
async function ensurePublishedPriceId({ gateway, tierId, countryCode, billingCycle }) {
  const g = String(gateway || '').toUpperCase();
  const fields = FIELD_BY_GATEWAY[g];
  if (!fields || !tierId) return null;
  const field = String(billingCycle).toUpperCase() === 'YEARLY' ? fields.YEARLY : fields.MONTHLY;
  const read = () => prisma.tierPrice.findFirst({ where: { tierId, countryCode: countryCode ?? null } });
  let row = await read();
  if (row && row[field]) return row[field];
  try {
    await runPublish({ gateways: [g], dryRun: false });
    row = await read();
  } catch (err) {
    console.error('[gateway self-heal] failed:', err?.message || err);
  }
  return (row && row[field]) || null;
}

module.exports = {
  SUPPORTED_GATEWAYS: SUPPORTED,
  GATEWAY_TARGETS,
  previewPublish: (opts = {}) => runPublish({ ...opts, dryRun: true }),
  publishToGateways: (opts = {}) => runPublish({ ...opts, dryRun: false }),
  syncGatewaysBackground,
  ensurePublishedPriceId,
};

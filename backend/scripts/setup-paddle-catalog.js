/* eslint-disable no-console */
//
// setup-paddle-catalog.js — one-time (idempotent) Paddle catalog provisioner.
//
// Creates one Paddle Product per pricing tier and a monthly + annual Price for
// each, then backfills every TierPrice row in the DB with the resulting Paddle
// price IDs so checkout (subscription.controller.selectPlan) can resolve a
// price for any tier + billing cycle.
//
// SAFE TO RE-RUN. Products/prices are tagged with custom_data.app='sitepresso'
// and matched by (tierSlug, cycle); an existing match is reused, never
// duplicated. Backfill is an idempotent updateMany per tier.
//
// This is account-shared-safe: it only ever creates/reads products that carry
// custom_data.app='sitepresso', so it never touches WorkVib / AapkaChat
// products living in the same Paddle account.
//
// Usage (env supplies PADDLE_API_KEY, PADDLE_ENVIRONMENT, DATABASE_URL):
//   node scripts/setup-paddle-catalog.js
//
// Reads the canonical USD price for each tier from the base TierPrice row
// (countryCode = null), which the pricing seed already populates — so amounts
// never drift from prisma/seeds/pricing.seed.js.

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const APP_TAG = 'sitepresso';
const PADDLE_VERSION = '1';
// Human label per vertical, used only for the Paddle product display name so
// the dashboard reads cleanly (three "Solo" tiers across verticals otherwise
// look identical).
const VERTICAL_LABEL = {
  APPOINTMENT: 'Booking',
  STATIC: 'Website',
  ECOMMERCE: 'Store',
};

function paddleEnv() {
  return String(process.env.PADDLE_ENVIRONMENT || '').toLowerCase() === 'sandbox'
    ? 'sandbox'
    : 'live';
}
function paddleBaseUrl() {
  return paddleEnv() === 'sandbox'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';
}

async function paddle(method, pathname, body, query) {
  const apiKey = String(process.env.PADDLE_API_KEY || '').trim();
  if (!apiKey) throw new Error('PADDLE_API_KEY is not set.');
  const url = new URL(pathname.replace(/^\//, ''), `${paddleBaseUrl()}/`);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Paddle-Version': PADDLE_VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const first = Array.isArray(json?.error?.errors) ? json.error.errors[0] : null;
    throw new Error(first?.detail || json?.error?.detail || `Paddle ${method} ${pathname} failed (${res.status})`);
  }
  return json;
}

// Cursor-paginate a Paddle list endpoint and return all rows.
async function paddleList(pathname, query = {}) {
  const out = [];
  let after;
  // hard stop well above any realistic catalogue size
  for (let i = 0; i < 50; i++) {
    const json = await paddle('GET', pathname, undefined, { per_page: 200, after, ...query });
    out.push(...(json.data || []));
    if (!json.meta?.pagination?.has_more) break;
    after = out[out.length - 1]?.id;
    if (!after) break;
  }
  return out;
}

function trialDaysForTier(tier) {
  const parsed = Number.parseInt(tier?.trialDays, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : null;
}

function priceMatchesTierTrial(price, tier) {
  const expectedTrialDays = trialDaysForTier(tier);
  const trial = price?.trial_period;
  const requiresPaymentMethod = trial?.requires_payment_method ?? price?.requires_payment_method;
  if (!expectedTrialDays) return !trial;
  return Boolean(
    trial
    && String(trial.interval || '').toLowerCase() === 'day'
    && Number(trial.frequency) === expectedTrialDays
    && requiresPaymentMethod !== false
  );
}

function trialPeriodForTier(tier) {
  const days = trialDaysForTier(tier);
  return days ? { interval: 'day', frequency: days, requires_payment_method: true } : null;
}

async function main() {
  const env = paddleEnv();
  console.log(`\n▸ Paddle catalog setup — environment: ${env}\n`);

  // 1) Load tiers + their canonical USD base price (countryCode = null).
  const tiers = await prisma.pricingTier.findMany({
    orderBy: [{ vertical: 'asc' }, { sortOrder: 'asc' }],
    include: { prices: { where: { countryCode: null }, take: 1 } },
  });
  if (!tiers.length) throw new Error('No PricingTier rows. Run prisma/seeds/pricing.seed.js first.');
  const tierBySlug = new Map(tiers.map((tier) => [tier.slug, tier]));

  // 2) Pull existing sitepresso-tagged products + prices for idempotency.
  const allProducts = await paddleList('/products', { status: 'active' });
  const ourProducts = new Map(); // tierSlug -> product
  for (const p of allProducts) {
    if (p.custom_data?.app === APP_TAG && p.custom_data?.tierSlug) {
      ourProducts.set(p.custom_data.tierSlug, p);
    }
  }
  const allPrices = await paddleList('/prices', { status: 'active' });
  const ourPrices = new Map(); // `${tierSlug}:${cycle}` -> price
  for (const pr of allPrices) {
    if (pr.custom_data?.app === APP_TAG && pr.custom_data?.tierSlug && pr.custom_data?.cycle) {
      const tier = tierBySlug.get(pr.custom_data.tierSlug);
      if (tier && priceMatchesTierTrial(pr, tier)) {
        ourPrices.set(`${pr.custom_data.tierSlug}:${pr.custom_data.cycle}`, pr);
      }
    }
  }

  const mapping = {}; // tierSlug -> { productId, monthly, annual }
  let created = 0;
  let reused = 0;

  for (const tier of tiers) {
    const base = tier.prices[0];
    if (!base) {
      console.warn(`  ! ${tier.slug}: no base USD price row — skipping`);
      continue;
    }
    // $0 tiers (e.g. the 'free' fallback) are not sold through Paddle. Don't
    // create a Paddle price; clear any stale price IDs left from when the slug
    // was priced (e.g. 'free' was $9 before the free/solo split) so checkout
    // resolution returns null and the free path is used.
    if (!(Number(base.amountMonthlyMinor) > 0)) {
      const cleared = await prisma.tierPrice.updateMany({
        where: { tierId: tier.id },
        data: { paddlePriceIdMonthly: null, paddlePriceIdAnnual: null, lastSyncedToPaddleAt: new Date() },
      });
      console.log(`  · ${tier.slug.padEnd(20)} $0 tier — no Paddle price; cleared ${cleared.count} row(s)`);
      continue;
    }
    const label = VERTICAL_LABEL[tier.vertical] || tier.vertical;
    const productName = `Sitepresso ${label} — ${tier.name}`;

    // -- Product --
    let product = ourProducts.get(tier.slug);
    if (product) {
      reused++;
    } else {
      const res = await paddle('POST', '/products', {
        name: productName,
        tax_category: 'saas',
        custom_data: { app: APP_TAG, tierSlug: tier.slug, vertical: tier.vertical },
      });
      product = res.data;
      created++;
      console.log(`  + product  ${tier.slug.padEnd(20)} ${product.id}  (${productName})`);
    }

    // -- Prices (monthly + annual) --
    const cycles = [
      { cycle: 'monthly', interval: 'month', amountMinor: base.amountMonthlyMinor },
      { cycle: 'annual', interval: 'year', amountMinor: base.amountAnnualMinor },
    ];
    const ids = {};
    for (const c of cycles) {
      const key = `${tier.slug}:${c.cycle}`;
      let price = ourPrices.get(key);
      if (price) {
        reused++;
      } else {
        const trialPeriod = trialPeriodForTier(tier);
        const res = await paddle('POST', '/prices', {
          product_id: product.id,
          description: `${tier.name} ${c.cycle === 'monthly' ? 'Monthly' : 'Annual'}`,
          billing_cycle: { interval: c.interval, frequency: 1 },
          ...(trialPeriod ? { trial_period: trialPeriod } : {}),
          unit_price: { amount: String(c.amountMinor), currency_code: base.currencyCode || 'USD' },
          // One subscription per tenant — lock quantity so the checkout never
          // shows a +/- stepper. Seats/staff are metered inside Sitepresso, not here.
          quantity: { minimum: 1, maximum: 1 },
          // tax_mode 'external' = price is tax-EXCLUSIVE; Paddle adds the buyer's
          // local tax on top at checkout (so we net the full sticker price).
          tax_mode: 'external',
          custom_data: {
            app: APP_TAG,
            tierSlug: tier.slug,
            cycle: c.cycle,
            trialDays: trialDaysForTier(tier),
            trialRequiresPaymentMethod: Boolean(trialPeriod),
          },
        });
        price = res.data;
        created++;
        console.log(`  + price    ${key.padEnd(28)} ${price.id}  (${c.amountMinor} ${base.currencyCode})`);
      }
      ids[c.cycle] = price.id;
    }

    mapping[tier.slug] = { productId: product.id, monthly: ids.monthly, annual: ids.annual };
  }

  // 3) Backfill EVERY TierPrice row for each tier. resolveTierPriceRecord can
  //    return a per-country row that lacks a price ID, so all rows must carry
  //    the Paddle IDs, not just the base USD row.
  console.log('\n▸ Backfilling TierPrice rows…');
  let rowsUpdated = 0;
  for (const tier of tiers) {
    const m = mapping[tier.slug];
    if (!m) continue;
    const r = await prisma.tierPrice.updateMany({
      where: { tierId: tier.id },
      data: {
        paddlePriceIdMonthly: m.monthly,
        paddlePriceIdAnnual: m.annual,
        lastSyncedToPaddleAt: new Date(),
      },
    });
    rowsUpdated += r.count;
    console.log(`  ↳ ${tier.slug.padEnd(20)} ${r.count} rows → m=${m.monthly} a=${m.annual}`);
  }

  // 4) Persist an audit/replay mapping so the SAME sandbox IDs can be applied
  //    to the staging DB at deploy time (run backfill-paddle-prices.js there).
  const outPath = path.join(__dirname, `paddle-catalog.${env}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ environment: env, tiers: mapping }, null, 2) + '\n');

  console.log(`\n✓ Done. products/prices created=${created} reused=${reused}; TierPrice rows updated=${rowsUpdated}`);
  console.log(`✓ Mapping written to ${path.relative(process.cwd(), outPath)}\n`);
}

main()
  .catch((e) => { console.error('\n✗ FAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });

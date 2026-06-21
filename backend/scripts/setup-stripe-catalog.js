/* eslint-disable no-console */
//
// setup-stripe-catalog.js — Stripe (NZ/NZD) catalog provisioner. The Stripe
// counterpart of setup-paddle-catalog.js.
//
// For every PAID, sold tier (one whose base TierPrice row carries a Paddle price
// id), it creates one Stripe Product + a monthly and annual recurring NZD Price,
// reading the amounts from the tier's NZ TierPrice row so Stripe never drifts
// from prisma/seeds/pricing.seed.js. The resulting ids are written to
// scripts/stripe-catalog.sandbox.json (the source for a later DB backfill, just
// like paddle-catalog.sandbox.json).
//
// IDEMPOTENT: re-reads the JSON mapping and reuses any Product/Price that still
// exists and matches; only missing/changed ones are (re)created.
//
// SAFETY: refuses to run against LIVE Stripe keys unless --live is passed, so a
// stray run can't mutate a production catalog.
//
// Usage (env supplies STRIPE_SECRET_KEY, DATABASE_URL):
//   node scripts/setup-stripe-catalog.js

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prisma = require('../src/core/lib/prisma');
const { getStripe } = require('../src/core/lib/billing/gateways/stripeGateway');

const COUNTRY = 'NZ';
const CURRENCY = 'nzd';
const APP_TAG = 'sitepresso';
const OUT_FILE = path.join(__dirname, 'stripe-catalog.sandbox.json');

const VERTICAL_LABEL = { APPOINTMENT: 'Booking', STATIC: 'Website', ECOMMERCE: 'Store' };

const isLive = !String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_');
if (isLive && !process.argv.includes('--live')) {
  console.error('\n✖ Refusing to run against LIVE Stripe keys without --live. Use sandbox (sk_test_…).\n');
  process.exit(1);
}

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch { return null; }
}

async function retrieveActive(stripe, type, id) {
  if (!id) return null;
  try {
    const obj = type === 'product' ? await stripe.products.retrieve(id) : await stripe.prices.retrieve(id);
    return obj && obj.active !== false ? obj : null;
  } catch { return null; }
}

async function ensureProduct(stripe, tier, prev) {
  const reused = await retrieveActive(stripe, 'product', prev?.productId);
  if (reused) return reused.id;
  const label = VERTICAL_LABEL[tier.vertical] || tier.vertical;
  const product = await stripe.products.create({
    name: `${label} ${tier.name} (NZ)`,
    metadata: { app: APP_TAG, tierSlug: tier.slug, vertical: tier.vertical, country: COUNTRY },
  });
  return product.id;
}

async function ensurePrice(stripe, { productId, interval, amountMinor, tier, prevPrice }) {
  const reused = await retrieveActive(stripe, 'price', prevPrice?.priceId);
  if (reused
    && reused.unit_amount === amountMinor
    && reused.currency === CURRENCY
    && reused.recurring?.interval === interval
    && reused.product === productId) {
    return { priceId: reused.id, amountMinor };
  }
  const price = await stripe.prices.create({
    product: productId,
    currency: CURRENCY,
    unit_amount: amountMinor,
    recurring: { interval },
    metadata: { app: APP_TAG, tierSlug: tier.slug, vertical: tier.vertical, country: COUNTRY },
  });
  return { priceId: price.id, amountMinor };
}

async function main() {
  const stripe = getStripe();
  console.log(`\nStripe catalog setup — ${isLive ? 'LIVE' : 'TEST'} · ${COUNTRY}/${CURRENCY.toUpperCase()}\n`);

  // Paid, sold tiers = those whose base (countryCode=null) row has a Paddle price id.
  const baseRows = await prisma.tierPrice.findMany({
    where: { countryCode: null, paddlePriceIdMonthly: { not: null }, tier: { isActive: true } },
    include: { tier: true },
    orderBy: { tier: { sortOrder: 'asc' } },
  });

  const prev = loadExisting();
  const out = { environment: isLive ? 'live' : 'test', country: COUNTRY, currency: CURRENCY.toUpperCase(), tiers: {} };
  let created = 0;
  let skipped = 0;

  for (const base of baseRows) {
    const tier = base.tier;
    const nz = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: COUNTRY } });
    if (!nz || !(nz.amountMonthlyMinor > 0)) {
      console.warn(`  ⚠ skip ${tier.slug} (${tier.vertical}) — no NZ price row / zero amount`);
      skipped += 1;
      continue;
    }
    const prevTier = prev?.tiers?.[`${tier.slug}:${tier.vertical}`] || null;
    const productId = await ensureProduct(stripe, tier, prevTier);
    const monthly = await ensurePrice(stripe, { productId, interval: 'month', amountMinor: nz.amountMonthlyMinor, tier, prevPrice: prevTier?.monthly });
    const annual = await ensurePrice(stripe, { productId, interval: 'year', amountMinor: nz.amountAnnualMinor, tier, prevPrice: prevTier?.annual });

    out.tiers[`${tier.slug}:${tier.vertical}`] = {
      tierSlug: tier.slug, vertical: tier.vertical, tierName: tier.name, productId, monthly, annual,
    };
    created += 1;
    console.log(`  ✓ ${tier.slug.padEnd(16)} ${String(tier.vertical).padEnd(11)} NZ$${(nz.amountMonthlyMinor / 100).toFixed(2)}/mo  ${monthly.priceId}`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\n✓ ${created} tiers written to ${path.relative(process.cwd(), OUT_FILE)} (${skipped} skipped)\n`);
}

main()
  .catch((err) => { console.error('\n✖ Stripe catalog setup failed:', err?.message || err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });

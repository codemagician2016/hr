/* eslint-disable no-console */
//
// setup-razorpay-catalog.js — Razorpay (IN/INR) subscription catalog provisioner.
// The Razorpay counterpart of setup-stripe-catalog.js.
//
// For each paid, sold tier, creates a Razorpay Plan (monthly + yearly) in INR
// from the tier's IN TierPrice row, and writes the plan ids to
// scripts/razorpay-catalog.sandbox.json (the source for backfill-razorpay-plans).
//
// REQUIRES Razorpay keys (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). Refuses to run
// against LIVE keys unless --live is passed.  Idempotent via the JSON mapping.
//
// Usage: node scripts/setup-razorpay-catalog.js

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prisma = require('../src/core/lib/prisma');
const { getGateway } = require('../src/core/lib/billing/gateways');

const COUNTRY = 'IN';
const CURRENCY = 'INR';
const OUT_FILE = path.join(__dirname, 'razorpay-catalog.sandbox.json');
const VERTICAL_LABEL = { APPOINTMENT: 'Booking', STATIC: 'Website', ECOMMERCE: 'Store' };

const gw = getGateway('RAZORPAY');
if (!gw.isConfigured()) {
  console.error('\n✖ Razorpay keys are not set (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). Add them and re-run.\n');
  process.exit(1);
}
const isLive = gw.environment() === 'live';
if (isLive && !process.argv.includes('--live')) {
  console.error('\n✖ Refusing to run against LIVE Razorpay keys without --live. Use rzp_test_… keys.\n');
  process.exit(1);
}

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch { return null; }
}

async function ensurePlan(prev, { period, amountMinor, tier }) {
  if (prev?.planId) return prev; // reuse from mapping (idempotent)
  const label = VERTICAL_LABEL[tier.vertical] || tier.vertical;
  const plan = await gw.createPlan({
    name: `${label} ${tier.name} (IN ${period === 'yearly' ? 'annual' : 'monthly'})`,
    period,
    interval: 1,
    amountMinor,
    currency: CURRENCY,
    description: `Sitepresso ${tier.name} plan`,
  });
  return { planId: plan.id, amountMinor };
}

async function main() {
  console.log(`\nRazorpay catalog setup — ${isLive ? 'LIVE' : 'TEST'} · ${COUNTRY}/${CURRENCY}\n`);
  const baseRows = await prisma.tierPrice.findMany({
    where: { countryCode: null, paddlePriceIdMonthly: { not: null }, tier: { isActive: true } },
    include: { tier: true },
    orderBy: { tier: { sortOrder: 'asc' } },
  });
  const prev = loadExisting();
  const out = { environment: isLive ? 'live' : 'test', country: COUNTRY, currency: CURRENCY, tiers: {} };
  let created = 0;
  let skipped = 0;

  for (const base of baseRows) {
    const tier = base.tier;
    const inr = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: COUNTRY } });
    if (!inr || !(inr.amountMonthlyMinor > 0)) {
      console.warn(`  ⚠ skip ${tier.slug} (${tier.vertical}) — no IN price row / zero amount`);
      skipped += 1;
      continue;
    }
    const key = `${tier.slug}:${tier.vertical}`;
    const prevTier = prev?.tiers?.[key] || null;
    const monthly = await ensurePlan(prevTier?.monthly, { period: 'monthly', amountMinor: inr.amountMonthlyMinor, tier });
    const annual = await ensurePlan(prevTier?.annual, { period: 'yearly', amountMinor: inr.amountAnnualMinor, tier });
    out.tiers[key] = { tierSlug: tier.slug, vertical: tier.vertical, tierName: tier.name, monthly, annual };
    created += 1;
    console.log(`  ✓ ${tier.slug.padEnd(16)} ${String(tier.vertical).padEnd(11)} ₹${(inr.amountMonthlyMinor / 100).toFixed(0)}/mo  ${monthly.planId}`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\n✓ ${created} tiers written to ${path.relative(process.cwd(), OUT_FILE)} (${skipped} skipped)\n`);
}

main()
  .catch((err) => { console.error('\n✖ Razorpay catalog setup failed:', err?.message || err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });

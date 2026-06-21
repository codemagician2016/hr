/* eslint-disable no-console */
//
// apply-all-paid-pricing.js — Phase 1 of the all-paid pricing strategy.
//
// Turns the current Free/Solo/Starter/Professional/Business mess into a clean,
// ALL-PAID ladder per vertical:  Starter → Professional → Business → Agency.
//   * deactivates the redundant sub-floor tier per vertical (solo / static-free
//     / ecom-free) so it's no longer SELLABLE (existing subscribers keep it);
//   * normalizes the three sellable tiers to Starter / Professional / Business
//     with consistent names, order, and "Most Popular" on Professional;
//   * reprices the base USD per the strategy (Booking unchanged 19/49/129;
//     Store down 39/99/299; Marketing up 15/29/79);
//   * adds an Agency (contact-us, custom-priced) anchor tier per vertical.
//
// The booking `free` tier stays active — it's the universal internal downgrade
// target (getFreeTier, slug 'free') — but it is never self-serve.
//
// SAFE + reversible: writes only to the local DB. The canonical seed
// (pricing.seed.js) + per-currency catalog cascade (Paddle/Stripe/Razorpay) is
// the productionization step, run with approval. Re-runnable (idempotent).
//
// Usage: node scripts/apply-all-paid-pricing.js [--dry]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../src/core/lib/prisma');

const DRY = process.argv.includes('--dry');
const annual = (m) => Math.round(m * 9.6); // ~20% off, matches existing convention
const NZD_FX = 1.65; // rough USD→NZD; charm-rounded to whole dollars
const toNzd = (usdMinor) => Math.round((usdMinor * NZD_FX) / 100) * 100;

// vertical → { kill, ladder: [{slug,name,monthlyMinor,badge,highlighted,sortOrder}], agency }
const PLAN = {
  APPOINTMENT: {
    kill: ['solo'],
    ladder: [
      { slug: 'starter', name: 'Starter', monthlyMinor: 1900, sortOrder: 1 },
      { slug: 'professional', name: 'Professional', monthlyMinor: 4900, sortOrder: 2, badge: 'Most Popular', highlighted: true },
      { slug: 'business', name: 'Business', monthlyMinor: 12900, sortOrder: 3 },
    ],
    agency: { slug: 'agency', name: 'Agency' },
  },
  STATIC: {
    kill: ['static-free'],
    ladder: [
      { slug: 'static-starter', name: 'Starter', monthlyMinor: 1500, sortOrder: 1 },
      { slug: 'static-professional', name: 'Professional', monthlyMinor: 2900, sortOrder: 2, badge: 'Most Popular', highlighted: true },
      { slug: 'static-business', name: 'Business', monthlyMinor: 7900, sortOrder: 3 },
    ],
    agency: { slug: 'static-agency', name: 'Agency' },
  },
  ECOMMERCE: {
    kill: ['ecom-free'],
    ladder: [
      { slug: 'ecom-starter', name: 'Starter', monthlyMinor: 3900, sortOrder: 1 },
      { slug: 'ecom-professional', name: 'Professional', monthlyMinor: 9900, sortOrder: 2, badge: 'Most Popular', highlighted: true },
      { slug: 'ecom-business', name: 'Business', monthlyMinor: 29900, sortOrder: 3 },
    ],
    agency: { slug: 'ecom-agency', name: 'Agency' },
  },
};

// Reprice the NZ (NZD, Stripe) rows for verticals whose USD base changed, so the
// Stripe catalog reflects the new ladder. Booking USD is unchanged → its tuned
// NZ prices are left alone.
const NZ_CASCADE_VERTICALS = new Set(['STATIC', 'ECOMMERCE']);

async function setNzd(tierId, usdMonthlyMinor) {
  const m = toNzd(usdMonthlyMinor);
  const yr = annual(m);
  const row = await prisma.tierPrice.findFirst({ where: { tierId, countryCode: 'NZ' } });
  if (row) {
    if (!DRY) await prisma.tierPrice.update({ where: { id: row.id }, data: { currencyCode: 'NZD', amountMonthlyMinor: m, amountAnnualMinor: yr } });
  } else if (!DRY) {
    await prisma.tierPrice.create({ data: { tierId, countryCode: 'NZ', currencyCode: 'NZD', amountMonthlyMinor: m, amountAnnualMinor: yr } });
  }
  return m;
}

async function setBaseUsd(tierId, monthlyMinor) {
  const monthly = monthlyMinor;
  const yr = annual(monthlyMinor);
  const existing = await prisma.tierPrice.findFirst({ where: { tierId, countryCode: null } });
  if (existing) {
    if (!DRY) await prisma.tierPrice.update({ where: { id: existing.id }, data: { currencyCode: 'USD', amountMonthlyMinor: monthly, amountAnnualMinor: yr } });
  } else if (!DRY) {
    await prisma.tierPrice.create({ data: { tierId, countryCode: null, currencyCode: 'USD', amountMonthlyMinor: monthly, amountAnnualMinor: yr } });
  }
}

async function main() {
  console.log(`\n${DRY ? '[DRY RUN] ' : ''}Applying all-paid ladder (local DB)\n`);
  for (const [vertical, cfg] of Object.entries(PLAN)) {
    console.log(`── ${vertical} ──`);

    // 1. Deactivate the redundant sub-floor tier(s) as sellable.
    for (const slug of cfg.kill) {
      const t = await prisma.pricingTier.findUnique({ where: { slug } });
      if (t) {
        if (!DRY) await prisma.pricingTier.update({ where: { slug }, data: { isActive: false } });
        console.log(`  ✗ deactivated (not sellable): ${slug}`);
      }
    }

    // 2. Normalize + reprice the three sellable tiers.
    for (const t of cfg.ladder) {
      const tier = await prisma.pricingTier.findUnique({ where: { slug: t.slug } });
      if (!tier) { console.warn(`  ⚠ missing tier ${t.slug}`); continue; }
      if (!DRY) {
        await prisma.pricingTier.update({
          where: { slug: t.slug },
          data: {
            name: t.name, sortOrder: t.sortOrder, isActive: true, isCustomPriced: false,
            badge: t.badge || null, highlighted: !!t.highlighted, trialDays: tier.trialDays ?? 14,
          },
        });
      }
      await setBaseUsd(tier.id, t.monthlyMinor);
      let nzNote = '';
      if (NZ_CASCADE_VERTICALS.has(vertical)) {
        const nz = await setNzd(tier.id, t.monthlyMinor);
        nzNote = `  (NZ$${(nz / 100).toFixed(0)})`;
      }
      console.log(`  ✓ ${t.slug.padEnd(20)} → ${t.name.padEnd(12)} $${(t.monthlyMinor / 100).toFixed(0)}/mo${nzNote}${t.badge ? '  ['+t.badge+']' : ''}`);
    }

    // 3. Agency anchor (contact-us, custom-priced).
    const a = cfg.agency;
    if (!DRY) {
      await prisma.pricingTier.upsert({
        where: { slug: a.slug },
        update: { name: a.name, vertical, sortOrder: 4, isActive: true, isCustomPriced: true, badge: null, highlighted: false, ctaLabel: 'Contact us', ctaHref: 'mailto:sales@sitepresso.com' },
        create: { slug: a.slug, name: a.name, vertical, sortOrder: 4, isActive: true, isCustomPriced: true, ctaLabel: 'Contact us', ctaHref: 'mailto:sales@sitepresso.com', description: 'White-label, multi-tenant, dedicated support.' },
      });
    }
    console.log(`  ✓ ${a.slug.padEnd(20)} → ${a.name.padEnd(12)} contact-us (anchor)`);
  }

  console.log('\nResulting sellable ladder (isActive, by vertical):');
  const tiers = await prisma.pricingTier.findMany({ where: { isActive: true }, orderBy: [{ vertical: 'asc' }, { sortOrder: 'asc' }], include: { prices: { where: { countryCode: null } } } });
  for (const t of tiers) {
    if (t.slug === 'free') continue; // internal fallback, not sold
    const p = t.prices[0];
    const price = t.isCustomPriced ? 'contact-us' : (p ? `$${(p.amountMonthlyMinor / 100).toFixed(0)}/mo` : 'no price');
    console.log(`  ${String(t.vertical).padEnd(12)} ${String(t.sortOrder)}. ${t.name.padEnd(12)} ${price}${t.badge ? '  ['+t.badge+']' : ''}`);
  }
  console.log('');
}

main()
  .catch((e) => { console.error('\n✖ failed:', e?.message || e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });

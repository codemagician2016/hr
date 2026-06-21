/* eslint-disable no-console */
//
// backfill-razorpay-plans.js — write Razorpay plan ids from
// razorpay-catalog.sandbox.json onto the matching IN TierPrice rows
// (razorpayPlanIdMonthly / razorpayPlanIdAnnual). Idempotent.
//
// Usage: node scripts/backfill-razorpay-plans.js [path-to-catalog.json]

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../src/core/lib/prisma');

async function main() {
  const file = process.argv[2] || path.join(__dirname, 'razorpay-catalog.sandbox.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  const country = catalog.country || 'IN';
  let updated = 0;
  let missing = 0;

  for (const [key, entry] of Object.entries(catalog.tiers || {})) {
    const tier = await prisma.pricingTier.findFirst({ where: { slug: entry.tierSlug, vertical: entry.vertical }, select: { id: true } });
    if (!tier) { console.warn(`  ⚠ no tier for ${key}`); missing += 1; continue; }
    const row = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: country } });
    if (!row) { console.warn(`  ⚠ no ${country} TierPrice row for ${key}`); missing += 1; continue; }
    await prisma.tierPrice.update({
      where: { id: row.id },
      data: { razorpayPlanIdMonthly: entry.monthly?.planId || null, razorpayPlanIdAnnual: entry.annual?.planId || null },
    });
    updated += 1;
    console.log(`  ✓ ${key.padEnd(28)} ${entry.monthly?.planId} / ${entry.annual?.planId}`);
  }
  console.log(`\n✓ backfilled ${updated} ${country} TierPrice rows (${missing} skipped)\n`);
}

main()
  .catch((err) => { console.error('\n✖ backfill failed:', err?.message || err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });

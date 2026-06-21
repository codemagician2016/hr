/* eslint-disable no-console */
//
// backfill-paddle-prices.js — write Paddle price IDs onto every TierPrice row
// from a saved catalog mapping. DB-only; makes no Paddle API calls.
//
// Use this on the staging / prod box at deploy time after the Paddle catalog
// already exists in the matching Paddle environment (created once by
// setup-paddle-catalog.js, which also writes the mapping file this reads).
//
// SAFE TO RE-RUN — idempotent updateMany per tier.
//
// Usage:
//   node scripts/backfill-paddle-prices.js [paddle-catalog.<env>.json]
// Defaults to scripts/paddle-catalog.sandbox.json.

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const file = process.argv[2]
    || path.join(__dirname, 'paddle-catalog.sandbox.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Mapping file not found: ${file}. Run setup-paddle-catalog.js first.`);
  }
  const { environment, tiers } = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\n▸ Backfilling Paddle price IDs from ${path.basename(file)} (env: ${environment})\n`);

  let rows = 0;
  let missing = 0;
  for (const [slug, ids] of Object.entries(tiers || {})) {
    const tier = await prisma.pricingTier.findUnique({ where: { slug }, select: { id: true } });
    if (!tier) { console.warn(`  ! tier '${slug}' not found in DB — skipping`); missing++; continue; }
    const r = await prisma.tierPrice.updateMany({
      where: { tierId: tier.id },
      data: {
        paddlePriceIdMonthly: ids.monthly,
        paddlePriceIdAnnual: ids.annual,
        lastSyncedToPaddleAt: new Date(),
      },
    });
    rows += r.count;
    console.log(`  ↳ ${slug.padEnd(20)} ${r.count} rows`);
  }
  console.log(`\n✓ Done. ${rows} TierPrice rows updated${missing ? `, ${missing} tier(s) missing` : ''}.\n`);
}

main()
  .catch((e) => { console.error('\n✗ FAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });

#!/usr/bin/env node
/* eslint-disable no-console */
//
// Loads the prebuilt demo-shop catalog into a tenant's product table.
// Idempotent — re-running skips existing slugs. Pass --reset to wipe
// the tenant's catalog first (destructive; admin confirms in UI).
//
// Usage on EC2:
//   cd /home/ubuntu/sitepresso/backend
//   node scripts/seed-demo-shop.js <business-slug>
//   node scripts/seed-demo-shop.js <business-slug> --reset

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { loadDemoShop } = require('../src/core/lib/demoShopSeeder');

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  const reset = args.includes('--reset');

  if (!slug) {
    console.error('Usage: node scripts/seed-demo-shop.js <business-slug> [--reset]');
    process.exit(1);
  }

  const business = await prisma.business.findUnique({
    where: { slug: slug.toLowerCase() },
    select: { id: true, name: true, slug: true, vertical: true },
  });

  if (!business) {
    console.error(`No business found with slug "${slug}".`);
    process.exit(1);
  }

  console.log(`Seeding demo shop into ${business.name} (${business.slug})…`);
  if (reset) console.log('  --reset: wiping existing categories + products first');

  const summary = await loadDemoShop({ businessId: business.id, reset });

  console.log('Done.');
  console.log(`  Categories created: ${summary.categoriesCreated} / ${summary.categoriesTotal}`);
  console.log(`  Products created:   ${summary.productsCreated} / ${summary.productsTotal}`);
  if (summary.skipped > 0) {
    console.log(`  Skipped (no matching category): ${summary.skipped}`);
  }
  console.log(`\nVisit https://${business.slug}.<your-platform-domain>/shop to see the live storefront.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

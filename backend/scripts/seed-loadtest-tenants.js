#!/usr/bin/env node
/*
 * Seed SYNTHETIC tenants for load testing — NOT production data.
 *
 * Every row is slug-tagged `lt-ecom-<n>` so teardown is trivial + safe:
 *   DELETE FROM "Business" WHERE slug LIKE 'lt-ecom-%';  (cascades to children)
 *
 * Tenants are put on a PAID ECOMMERCE tier + ACTIVE + future period so their
 * billingState resolves to `active` and the storefront API actually serves them
 * (otherwise the new billing gate 404s them). Each gets categories + published
 * products so /products and /categories return realistic data.
 *
 * Grow the pool in steps without recreating (START_INDEX is exclusive of prior):
 *   COUNT=4000  START_INDEX=1    node -r dotenv/config scripts/seed-loadtest-tenants.js
 *   COUNT=6000  START_INDEX=4001 node -r dotenv/config scripts/seed-loadtest-tenants.js   # → 10k total
 */
const prisma = require('../src/core/lib/prisma');
const crypto = require('crypto');

const COUNT = parseInt(process.env.COUNT || '4000', 10);
const START = parseInt(process.env.START_INDEX || '1', 10);
const PRODUCTS_PER = parseInt(process.env.PRODUCTS_PER || '12', 10);
const CATS_PER = parseInt(process.env.CATS_PER || '3', 10);
const BATCH = 1000;
const uuid = () => crypto.randomUUID();

async function insertMany(model, rows, label) {
  for (let k = 0; k < rows.length; k += BATCH) {
    await prisma[model].createMany({ data: rows.slice(k, k + BATCH), skipDuplicates: true });
    process.stdout.write(`\r  ${label}: ${Math.min(k + BATCH, rows.length)}/${rows.length}   `);
  }
  process.stdout.write('\n');
}

async function main() {
  const tier = await prisma.pricingTier.findFirst({
    where: { vertical: 'ECOMMERCE', slug: { notIn: ['ecom-free', 'free', 'trial', 'static-free'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, slug: true },
  });
  if (!tier) throw new Error('No paid ECOMMERCE tier found — cannot seed serving tenants.');
  console.log(`Paid tier: ${tier.slug} (${tier.id})  |  seeding ${COUNT} tenants lt-ecom-${START}..${START + COUNT - 1}`);

  const periodEnd = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const now = new Date();
  const businesses = [], subs = [], cats = [], products = [];

  for (let i = START; i < START + COUNT; i++) {
    const bizId = uuid();
    businesses.push({ id: bizId, name: `LoadTest Ecom ${i}`, slug: `lt-ecom-${i}`, vertical: 'ECOMMERCE', country: 'IN', category: 'boutique-apparel', isActive: true });
    subs.push({ id: uuid(), businessId: bizId, tierId: tier.id, status: 'ACTIVE', billingCycle: 'MONTHLY', gateway: 'PADDLE', currentPeriodEnd: periodEnd, activatedAt: now });
    const catIds = [];
    for (let c = 0; c < CATS_PER; c++) {
      const cid = uuid();
      catIds.push(cid);
      cats.push({ id: cid, businessId: bizId, name: `Category ${c + 1}`, slug: `c-${i}-${c + 1}`, isPublished: true });
    }
    for (let j = 0; j < PRODUCTS_PER; j++) {
      products.push({
        id: uuid(), businessId: bizId, categoryId: catIds[j % CATS_PER],
        name: `Product ${i}-${j + 1}`, slug: `p-${i}-${j + 1}`,
        priceMinor: 9900 + j * 100, currency: 'INR', isPublished: true, isFeatured: j < 3,
      });
    }
  }

  console.time('seed');
  await insertMany('business', businesses, 'businesses');
  await insertMany('subscription', subs, 'subscriptions');
  await insertMany('productCategory', cats, 'categories');
  await insertMany('product', products, 'products');
  console.timeEnd('seed');

  const total = await prisma.business.count({ where: { slug: { startsWith: 'lt-ecom-' } } });
  console.log(`Done. Total lt-ecom tenants now: ${total}  (this run: ${COUNT} tenants, ${products.length} products, ${cats.length} categories)`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

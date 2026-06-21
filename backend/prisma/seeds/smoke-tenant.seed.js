#!/usr/bin/env node
// Creates/activates smoke-test tenants in every env so scripts/smoke-test.sh
// has the slugs it expects — staging hits 'shreya', prod hits 'test123'.
// Both are minimal idempotent active tenants with a free-tier subscription.
//
// Usage (from backend/ dir):
//   node prisma/seeds/smoke-tenant.seed.js
'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SMOKE_SLUGS = ['test123', 'shreya'];

async function ensureTenant(slug) {
  const existing = await prisma.business.findUnique({ where: { slug } });

  if (existing) {
    if (!existing.isActive) {
      await prisma.business.update({ where: { slug }, data: { isActive: true } });
      console.log(`[smoke-tenant] ${slug} activated.`);
    } else {
      console.log(`[smoke-tenant] ${slug} already active — nothing to do.`);
    }
    return existing;
  }

  const biz = await prisma.business.create({
    data: {
      name: `Smoke Test Tenant (${slug})`,
      slug,
      vertical: 'APPOINTMENT',
      isActive: true,
      country: 'NZ',
      timezone: 'Pacific/Auckland',
    },
  });

  const freeTier = await prisma.pricingTier.findUnique({ where: { slug: 'free' } });
  if (freeTier) {
    const forever = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    await prisma.subscription.create({
      data: {
        businessId: biz.id,
        tierId: freeTier.id,
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        theme: 'default',
        currentPeriodEnd: forever,
        seatsUsed: 0,
      },
    });
  }

  console.log(`[smoke-tenant] Created business id=${biz.id} slug=${slug}`);
  return biz;
}

async function main() {
  for (const slug of SMOKE_SLUGS) {
    await ensureTenant(slug);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

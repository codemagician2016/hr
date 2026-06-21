#!/usr/bin/env node
// Creates 3 demo tenants — one per shipped theme — so the founder can
// visit each subdomain and confirm the theme renders correctly.
// Idempotent: re-run is safe.
//
// Tenants created:
//   legal-demo   → APPOINTMENT vertical, theme=legal
//   grocery-demo → ECOMMERCE   vertical, theme=grocery
//   corp-demo    → STATIC      vertical, theme=corporate
//
// Usage: node prisma/seeds/demo-themes.seed.js
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEMOS = [
  {
    slug: 'legal-demo',
    name: 'Sterling & Associates Law Firm',
    vertical: 'APPOINTMENT',
    theme: 'legal',
    description: 'Demo lawyer site — Sterling & Associates handles family law, criminal defense, personal injury, business law, real estate, and immigration matters.',
    address: '500 Market Street, Suite 1200, San Francisco, CA',
    phone: '+1 (415) 555-0100',
    email: 'hello@sterling-demo.example.com',
    country: 'US',
    timezone: 'America/Los_Angeles',
    category: 'Legal Services',
  },
  {
    slug: 'grocery-demo',
    name: 'GrocerFast Demo',
    vertical: 'ECOMMERCE',
    theme: 'grocery',
    description: 'Demo grocery store — fresh produce, dairy, bakery, and pantry essentials delivered same-day.',
    address: '88 Market Lane, Auckland Central',
    phone: '+64 9 555 0200',
    email: 'shop@grocer-demo.example.com',
    country: 'NZ',
    timezone: 'Pacific/Auckland',
    category: 'Grocery & Food',
  },
  {
    slug: 'corp-demo',
    name: 'Apex Solutions Demo',
    vertical: 'STATIC',
    theme: 'corporate',
    description: 'Demo corporate website — strategy consulting, digital transformation, and operations excellence for enterprise clients.',
    address: 'Level 30, 123 King Street, Sydney NSW',
    phone: '+61 2 5550 0300',
    email: 'contact@apex-demo.example.com',
    country: 'AU',
    timezone: 'Australia/Sydney',
    category: 'Business Consulting',
  },
];

async function ensureTier() {
  const free = await prisma.pricingTier.findUnique({ where: { slug: 'free' } });
  if (!free) throw new Error('Free pricing tier missing — run pricing.seed.js first.');
  return free;
}

async function ensureDemo(demo, freeTier) {
  let biz = await prisma.business.findUnique({ where: { slug: demo.slug } });

  if (biz) {
    biz = await prisma.business.update({
      where: { slug: demo.slug },
      data: {
        name: demo.name,
        vertical: demo.vertical,
        description: demo.description,
        address: demo.address,
        phone: demo.phone,
        email: demo.email,
        country: demo.country,
        timezone: demo.timezone,
        category: demo.category,
        isActive: true,
      },
    });
    console.log(`[demo-themes] Updated ${demo.slug}`);
  } else {
    biz = await prisma.business.create({
      data: {
        slug: demo.slug,
        name: demo.name,
        vertical: demo.vertical,
        description: demo.description,
        address: demo.address,
        phone: demo.phone,
        email: demo.email,
        country: demo.country,
        timezone: demo.timezone,
        category: demo.category,
        isActive: true,
      },
    });
    console.log(`[demo-themes] Created ${demo.slug} id=${biz.id}`);
  }

  const forever = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
  const existingSub = await prisma.subscription.findUnique({ where: { businessId: biz.id } });
  if (existingSub) {
    await prisma.subscription.update({
      where: { businessId: biz.id },
      data: { theme: demo.theme, status: 'ACTIVE', currentPeriodEnd: forever, tierId: freeTier.id },
    });
    console.log(`[demo-themes]   subscription theme=${demo.theme}`);
  } else {
    await prisma.subscription.create({
      data: {
        businessId: biz.id,
        tierId: freeTier.id,
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        theme: demo.theme,
        currentPeriodEnd: forever,
        seatsUsed: 0,
      },
    });
    console.log(`[demo-themes]   subscription created with theme=${demo.theme}`);
  }
}

async function main() {
  const freeTier = await ensureTier();
  for (const demo of DEMOS) {
    await ensureDemo(demo, freeTier);
  }
  console.log('[demo-themes] Done.');
  console.log('Visit:');
  console.log('  https://legal-demo.<your-domain>');
  console.log('  https://grocery-demo.<your-domain>');
  console.log('  https://corp-demo.<your-domain>');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

#!/usr/bin/env node
// Local-only login credentials for the three demo tenants.
//
// Run by `npm run local:setup` after demo tenants have been created.
// Idempotent: re-running resets these demo passwords and reactivates accounts.
'use strict';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { SYSTEM_ROLES } = require('../../src/core/lib/rbac');

const prisma = new PrismaClient();

const PASSWORD = process.env.SITEPRESSO_DEMO_PASSWORD || 'Demo1234!';
const TERMS_VERSION = 'local-demo-credentials';

const USERS = [
  {
    email: 'admin@sitepresso.test',
    name: 'Sitepresso Demo Admin',
    role: 'SUPER_ADMIN',
    businessSlug: null,
  },
  {
    email: 'legal.owner@sitepresso.test',
    name: 'Legal Demo Owner',
    role: 'BUSINESS_ADMIN',
    businessSlug: 'legal-demo',
  },
  {
    email: 'grocery.owner@sitepresso.test',
    name: 'Grocery Demo Owner',
    role: 'BUSINESS_ADMIN',
    businessSlug: 'grocery-demo',
  },
  {
    email: 'corp.owner@sitepresso.test',
    name: 'Static Demo Owner',
    role: 'BUSINESS_ADMIN',
    businessSlug: 'corp-demo',
  },
];

const CUSTOMERS = [
  {
    email: 'legal.customer@sitepresso.test',
    name: 'Legal Demo Customer',
    phone: '+1 415 555 0111',
    businessSlug: 'legal-demo',
  },
  {
    email: 'grocery.customer@sitepresso.test',
    name: 'Grocery Demo Customer',
    phone: '+64 9 555 0222',
    businessSlug: 'grocery-demo',
  },
  {
    email: 'corp.customer@sitepresso.test',
    name: 'Static Demo Customer',
    phone: '+61 2 5550 0333',
    businessSlug: 'corp-demo',
  },
];

async function businessBySlug(slug) {
  if (!slug) return null;
  const business = await prisma.business.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true },
  });
  if (!business) {
    throw new Error(`Missing demo tenant "${slug}". Run prisma/seeds/demo-themes.seed.js first.`);
  }
  return business;
}

async function ownerRoleForBusiness(businessId) {
  if (!businessId) return null;
  return prisma.businessRole.upsert({
    where: { businessId_name: { businessId, name: 'Owner' } },
    update: {
      isSystem: true,
      permissions: SYSTEM_ROLES.Owner,
    },
    create: {
      businessId,
      name: 'Owner',
      isSystem: true,
      permissions: SYSTEM_ROLES.Owner,
    },
    select: { id: true },
  });
}

async function seedUser(spec, hashedPassword) {
  const business = await businessBySlug(spec.businessSlug);
  const ownerRole = business ? await ownerRoleForBusiness(business.id) : null;

  const data = {
    email: spec.email,
    name: spec.name,
    password: hashedPassword,
    role: spec.role,
    businessId: business?.id || null,
    businessRoleId: ownerRole?.id || null,
    emailVerified: true,
    isActive: true,
    termsAcceptedAt: new Date(),
    termsVersion: TERMS_VERSION,
    emailOtp: null,
    emailOtpExpiry: null,
    resetToken: null,
    resetTokenExpiry: null,
  };

  await prisma.user.upsert({
    where: { email: spec.email },
    update: data,
    create: data,
  });
  console.log(`[local-demo-credentials] user ${spec.email}`);
}

async function seedCustomer(spec, hashedPassword) {
  const business = await businessBySlug(spec.businessSlug);
  const data = {
    businessId: business.id,
    email: spec.email,
    name: spec.name,
    phone: spec.phone,
    password: hashedPassword,
    emailVerified: true,
    isActive: true,
    termsAcceptedAt: new Date(),
    termsVersion: TERMS_VERSION,
    emailOtp: null,
    emailOtpExpiry: null,
  };

  await prisma.customer.upsert({
    where: { businessId_email: { businessId: business.id, email: spec.email } },
    update: data,
    create: data,
  });
  console.log(`[local-demo-credentials] customer ${spec.email} (${business.slug})`);
}

async function main() {
  const hashedPassword = await bcrypt.hash(PASSWORD, 12);
  for (const user of USERS) await seedUser(user, hashedPassword);
  for (const customer of CUSTOMERS) await seedCustomer(customer, hashedPassword);

  console.log('');
  console.log('[local-demo-credentials] Done.');
  console.log(`  password: ${PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

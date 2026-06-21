#!/usr/bin/env node
// Bootstrap a SUPER_ADMIN account so the founder can log into the
// superadmin panel after a clean DB reset. Idempotent — safe to re-run.
//
// Reads email + password from env vars (preferred) or CLI args:
//   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=secret node prisma/seeds/superadmin.seed.js
//   node prisma/seeds/superadmin.seed.js you@example.com secret
//
// On re-run with same email, updates the password (treats it as "reset").
'use strict';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const email = (process.env.SUPERADMIN_EMAIL || process.argv[2] || '').trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD || process.argv[3] || '';

  if (!email || !password) {
    console.error('Usage: SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... node superadmin.seed.js');
    console.error('   or: node superadmin.seed.js <email> <password>');
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, 12);
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    await prisma.user.update({
      where: { email },
      data: {
        password: hashed,
        role: 'SUPER_ADMIN',
        emailVerified: true,
        isActive: true,
        emailOtp: null,
        emailOtpExpiry: null,
      },
    });
    console.log(`[superadmin] Updated existing user ${email} — role SUPER_ADMIN, password reset.`);
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      password: hashed,
      name: 'Platform Admin',
      role: 'SUPER_ADMIN',
      emailVerified: true,
      isActive: true,
    },
  });
  console.log(`[superadmin] Created SUPER_ADMIN id=${user.id} email=${email}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

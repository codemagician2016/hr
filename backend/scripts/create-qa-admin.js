#!/usr/bin/env node
'use strict';

const bcrypt = require('bcryptjs');
const prisma = require('../src/core/lib/prisma');

function argValue(name) {
  const prefix = `--${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return '';
}

async function main() {
  const email = String(process.env.QA_ADMIN_EMAIL || argValue('email') || '').trim().toLowerCase();
  const password = String(process.env.QA_ADMIN_PASSWORD || argValue('password') || '');
  const name = String(process.env.QA_ADMIN_NAME || argValue('name') || 'QA Admin').trim();

  if (!email || !email.includes('@')) {
    throw new Error('Set QA_ADMIN_EMAIL or pass --email admin@example.com');
  }
  if (!password || password.length < 8) {
    throw new Error('Set QA_ADMIN_PASSWORD or pass --password with at least 8 characters');
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.qaUser.upsert({
    where: { email },
    create: {
      email,
      password: hashed,
      name,
      isAdmin: true,
      isActive: true,
    },
    update: {
      password: hashed,
      name,
      isAdmin: true,
      isActive: true,
      passwordChangedAt: new Date(),
    },
    select: { id: true, email: true, name: true, isAdmin: true, isActive: true },
  });

  console.log(`QA admin ready: ${user.email} (${user.id})`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

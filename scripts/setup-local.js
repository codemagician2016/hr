#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;

const args = new Set(process.argv.slice(2));

function usage() {
  console.log(`Usage: node scripts/setup-local.js [options]

Options:
  --skip-install   Do not run npm install
  --skip-db        Do not generate Prisma client or apply migrations
  --skip-seeds     Do not seed pricing/demo tenants

This command is safe to rerun. It applies committed migrations with
prisma migrate deploy; use backend/prisma:migrate manually when authoring
new schema migrations.
`);
}

function step(title, command, commandArgs, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${title}`);
    console.log(`    ${[command, ...commandArgs].join(' ')}`);
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit', env: process.env });
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${title} failed with ${signal || code}`));
    });
    child.on('error', reject);
  });
}

function readEnvValue(file, key) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) continue;
    return match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function canReach(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 1500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function assertDatabaseReachable() {
  const databaseUrl = process.env.DATABASE_URL || readEnvValue(path.join(BACKEND, '.env'), 'DATABASE_URL');
  if (!databaseUrl) {
    console.error('DATABASE_URL is missing from backend/.env.');
    console.error('Create backend/.env from backend/.env.example, then rerun local setup.');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    console.error('DATABASE_URL in backend/.env is not a valid URL.');
    process.exit(1);
  }

  const host = parsed.hostname || 'localhost';
  const port = Number(parsed.port || 5432);
  if (await canReach(host, port)) return;

  console.error(`Database is not reachable at ${host}:${port}.`);
  console.error('Start Postgres, or run "npm run local:db" for the repo-managed local container, then rerun local setup.');
  process.exit(1);
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    usage();
    return;
  }

  if (!fs.existsSync(path.join(BACKEND, '.env'))) {
    console.log('backend/.env is missing. Create it from backend/.env.example before running database steps.');
    console.log('Tip: pass --skip-db --skip-seeds if you only want dependencies for now.');
    if (!args.has('--skip-db') || !args.has('--skip-seeds')) process.exit(1);
  }

  if (!args.has('--skip-install')) {
    await step('Install root workspace dependencies', npm, ['install']);
    await step('Install backend dependencies', npm, ['--prefix', 'backend', 'install']);
  }

  if (!args.has('--skip-db') || !args.has('--skip-seeds')) {
    await assertDatabaseReachable();
  }

  if (!args.has('--skip-db')) {
    await step('Generate Prisma client', npm, ['--prefix', 'backend', 'run', 'prisma:generate']);
    await step('Apply committed database migrations', npm, ['--prefix', 'backend', 'run', 'prisma:deploy']);
  }

  if (!args.has('--skip-seeds')) {
    await step('Seed pricing tiers', npm, ['--prefix', 'backend', 'run', 'prisma:seed:pricing']);
    await step('Seed one demo tenant per vertical', node, ['prisma/seeds/demo-themes.seed.js'], BACKEND);
    await step('Seed local demo login credentials', node, ['prisma/seeds/local-demo-credentials.seed.js'], BACKEND);
    await step('Seed grocery demo catalog', node, ['scripts/seed-demo-shop.js', 'grocery-demo'], BACKEND);
  }

  console.log(`\nLocal setup complete.

Next:
  npm run dev:verticals
  npm run smoke:local
`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  console.error('\nLocal setup stopped. Fix the error above, then rerun the same command.');
  process.exit(1);
});

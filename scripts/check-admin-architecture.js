#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

function rel(...parts) {
  return path.join(root, ...parts);
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function fail(message) {
  failures.push(message);
}

const forbiddenPaths = [
  'apps/booking/admin',
  'apps/shop/admin',
  'apps/web/admin',
  'apps/booking/core/components/admin-tabs',
  'apps/booking/core/components/admin-modals',
  'apps/booking/core/components/admin-cards',
  'apps/booking/core/components/admin-shell.js',
  'apps/booking/core/components/admin-pickers.js',
  'apps/booking/core/components/admin-ui.js',
  'apps/booking/core/components/BlogPanel.js',
  'apps/shop/core/components/admin-tabs',
  'apps/web/core/components/admin-shell.js',
];

for (const p of forbiddenPaths) {
  if (fs.existsSync(rel(p))) {
    fail(`Forbidden legacy admin path exists: ${p}`);
  }
}

const filesThatMustNotReferenceLegacyAdmin = [
  'package.json',
  'package-lock.json',
  'docker/nextapp-base.Dockerfile',
  'scripts/deploy.sh',
  'scripts/setup-ecr.sh',
  'scripts/docker-smoke-test.sh',
  'apps/router/cloudflare-worker.js',
  'apps/router/index.js',
];

const forbiddenText = [
  'apps/booking/admin',
  'apps/shop/admin',
  'apps/web/admin',
  '@hr/booking-admin',
  '@hr/shop-admin',
  '@hr/web-admin',
  'sitepresso-booking-admin',
  'sitepresso-shop-admin',
  'sitepresso-web-admin',
  'sitepresso-prod-booking-admin',
  'sitepresso-prod-shop-admin',
  'sitepresso-prod-web-admin',
  'booking-admin',
  'shop-admin',
  'web-admin',
];

for (const file of filesThatMustNotReferenceLegacyAdmin) {
  const body = read(rel(file));
  for (const needle of forbiddenText) {
    if (body.includes(needle)) {
      fail(`${file} still references ${needle}`);
    }
  }
}

function walkFiles(dir, out = []) {
  const abs = rel(dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === '.next' || entry.name === 'node_modules') continue;
    const entryPath = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      walkFiles(path.relative(root, entryPath), out);
    } else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) {
      out.push(entryPath);
    }
  }
  return out;
}

const activeNonAdminSurfaces = [
  'apps/booking/public',
  'apps/booking/customer',
  'apps/booking/staff',
  'apps/shop/public',
  'apps/shop/customer',
  'apps/shop/staff',
  'apps/web/public',
  'apps/web/customer',
  'apps/web/staff',
  'business',
];

const forbiddenActiveImports = [
  /@\/components\/admin-(tabs|shell|modals|cards|pickers|ui)/,
  /['"][^'"]*\/admin-tabs(\/|['"])/,
  /['"][^'"]*\/admin-shell(\.js)?['"]/,
];

for (const surface of activeNonAdminSurfaces) {
  for (const file of walkFiles(surface)) {
    const body = read(file);
    for (const pattern of forbiddenActiveImports) {
      if (pattern.test(body)) {
        fail(`${path.relative(root, file)} imports retired admin surface code`);
      }
    }
  }
}

const worker = read(rel('apps/router/cloudflare-worker.js'));
for (const needle of [
  "admin:    'https://sitepresso-booking-admin",
  "admin:    'https://sitepresso-web-admin",
  "admin:           'https://sitepresso-shop-admin",
  "admin:    'https://sitepresso-prod-booking-admin",
  "admin:    'https://sitepresso-prod-web-admin",
  "admin:           'https://sitepresso-prod-shop-admin",
]) {
  if (worker.includes(needle)) {
    fail(`Cloudflare worker still routes tenant admin via ${needle}`);
  }
}

if (failures.length) {
  console.error('Admin architecture guard failed:');
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log('Admin architecture guard passed');

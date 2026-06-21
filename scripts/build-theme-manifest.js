#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { buildBackendThemeManifest } = require('@sitepresso/theme-engine');

const root = path.resolve(__dirname, '..');

function loadRegistry(relPath) {
  return require(path.join(root, relPath));
}

const registries = {
  booking: loadRegistry('apps/booking/lib/themeConfigs.js'),
  shop: loadRegistry('apps/shop/lib/themeConfigs.js'),
  web: loadRegistry('apps/web/lib/themeConfigs.js'),
};

const entries = Object.assign({}, registries.booking, registries.shop, registries.web);
const manifest = buildBackendThemeManifest(entries).sort((a, b) => a.key.localeCompare(b.key));
const payload = `${JSON.stringify({
  schemaVersion: 1,
  source: [
    'apps/booking/lib/themeConfigs.js',
    'apps/shop/lib/themeConfigs.js',
    'apps/web/lib/themeConfigs.js',
  ],
  themes: manifest,
}, null, 2)}\n`;

const relPath = 'backend/src/core/generated/themeManifest.json';
const abs = path.join(root, relPath);
fs.mkdirSync(path.dirname(abs), { recursive: true });
fs.writeFileSync(abs, payload);
console.log(`wrote ${relPath}`);

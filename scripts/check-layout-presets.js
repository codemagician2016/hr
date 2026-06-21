#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  LAYOUT_PRESETS,
  LAYOUT_PRESET_KEYS,
  VALID_LAYOUT_PRESETS,
} = require('../packages/theme-engine/layout-presets.cjs');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER_FILES = [
  'apps/platform/lib/layoutPresets.js',
  'apps/web/core/lib/layoutPresets.js',
  'business/lib/layoutPresets.js',
  'apps/booking/lib/layoutPresets.js',
  'apps/booking/core/lib/layoutPresets.js',
  'apps/shop/lib/layoutPresets.js',
  'apps/shop/core/lib/layoutPresets.js',
];

const errors = [];

if (LAYOUT_PRESETS.length !== 100) {
  errors.push(`Expected 100 layout presets, found ${LAYOUT_PRESETS.length}.`);
}
if (LAYOUT_PRESET_KEYS.length !== LAYOUT_PRESETS.length) {
  errors.push('LAYOUT_PRESET_KEYS is out of sync with LAYOUT_PRESETS.');
}
if (!VALID_LAYOUT_PRESETS.has('logistics-network')) {
  errors.push('Backend-visible preset key set is missing logistics-network.');
}

for (const file of WRAPPER_FILES) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (!content.includes('@hr/theme-engine/layout-presets.cjs')) {
    errors.push(`${file} does not re-export the shared layout preset registry.`);
  }
  if (content.includes('export const LAYOUT_PRESETS = [')) {
    errors.push(`${file} still contains a local layout preset array.`);
  }
}

if (errors.length) {
  console.error('Layout preset guard failed:');
  errors.forEach((error) => console.error(`  - ${error}`));
  process.exit(1);
}

console.log('Layout preset guard passed');

#!/usr/bin/env node
'use strict';

// Builds the theme-copy heal map: exact OLD theme-default copy string -> the
// improved NEW string, for every web-theme content field that changed during
// the copy-quality improvement work.
//
// WHY THIS EXISTS
// ---------------
// When a tenant selects a web theme, the backend snapshots that theme's default
// copy into the tenant's BusinessContent row (subscription.controller.js,
// buildThemeContentResetPatch). Later improvements to the theme DEFAULT do not
// reach those already-snapshotted rows — so an existing site keeps showing the
// old, bloated copy even after the theme file is fixed.
//
// This map lets the tenant resolve API heal a saved field at request time, but
// ONLY when the saved value is byte-for-byte one of these known old machine-
// generated defaults. A value the owner actually typed will never match, so
// genuine edits are never touched. No DB writes; fully reversible (delete the
// map + the heal call).
//
// Regenerate after further theme-copy improvements:
//   node scripts/build-theme-copy-heal-map.js
//
// and bump NEW_REV to the latest copy-improvement commit.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_FILE = 'apps/web/themes/_shared/staticThemes.js';
const OUT_FILE = path.join(ROOT, 'backend/src/core/lib/themeCopyHealMap.json');

// Range of the copy-quality improvement: parent of the first improvement
// commit (so we capture the original defaults) → the last improvement commit.
const OLD_REV = process.env.HEAL_OLD_REV || 'c689be6d^';
const NEW_REV = process.env.HEAL_NEW_REV || 'c4d60a58';

// Top-level theme blocks: `  <key>: makeTheme({`
const THEME_RE = /^  "?([a-z0-9_]+)"?:\s*makeTheme\(/;
// A content field literal (single- or double-quoted) at any indent.
const FIELD_RE = /^\s+"?([a-zA-Z0-9_]+)"?:\s*(['"])((?:\\.|(?!\2).)*)\2,?\s*$/;

// The storefront-managed copy fields we heal (must match the resolve heal +
// the frontend scrub's managed list).
const FIELDS = new Set([
  'heroHeadline', 'heroSubheading', 'tagline',
  'servicesEyebrow', 'servicesTitle', 'servicesIntro',
  'aboutEyebrow', 'aboutTitle', 'aboutBody',
  'testimonialsEyebrow', 'testimonialsTitle',
  'faqEyebrow', 'faqTitle',
  'contactTitle', 'contactBody', 'contactCardTitle', 'contactCardBody',
  'pricingEyebrow', 'pricingTitle',
  'ctaHeadline', 'ctaBody',
]);

function show(rev) {
  return execSync(`git show ${rev}:${SRC_FILE}`, { cwd: ROOT, maxBuffer: 1 << 30 }).toString();
}

// Parse a file version into { themeKey: { field: value } }. Only the first
// (top-level) occurrence of a field within a theme block is kept, so nested
// service-card / object fields never shadow the theme's own copy.
function parse(src) {
  const out = {};
  let cur = null;
  for (const line of src.split('\n')) {
    const t = line.match(THEME_RE);
    if (t) { cur = t[1]; out[cur] = out[cur] || {}; continue; }
    if (!cur) continue;
    const m = line.match(FIELD_RE);
    if (!m) continue;
    const [, field, , rawVal] = m;
    if (!FIELDS.has(field) || out[cur][field] !== undefined) continue;
    let val;
    try { val = JSON.parse('"' + rawVal.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"') + '"'); }
    catch { val = rawVal; }
    out[cur][field] = val;
  }
  return out;
}

const oldT = parse(show(OLD_REV));
const newT = parse(show(NEW_REV));

const map = {};
let collisions = 0;
for (const key of Object.keys(newT)) {
  if (!oldT[key]) continue;
  for (const field of Object.keys(newT[key])) {
    const o = oldT[key][field];
    const n = newT[key][field];
    if (o === undefined || n === undefined || o === n) continue;
    // Distinct old strings mapping to different new strings would be ambiguous
    // at heal time — skip them rather than risk a wrong swap.
    if (map[o] !== undefined && map[o] !== n) { collisions++; continue; }
    map[o] = n;
  }
}

const sorted = {};
for (const k of Object.keys(map).sort()) sorted[k] = map[k];
fs.writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 0) + '\n');

console.log(`themes: old=${Object.keys(oldT).length} new=${Object.keys(newT).length}`);
console.log(`wrote ${path.relative(ROOT, OUT_FILE)} — ${Object.keys(sorted).length} pairs (collisions skipped: ${collisions})`);

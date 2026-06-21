#!/usr/bin/env node
'use strict';

// Copy-quality lint for theme content.
//
// Flags the bulk-generated web themes' worst copy problems so they can be fixed
// and kept fixed: over-long hero headlines, bloated subheadings, comma-soup
// section titles, and over-used filler. Reports by theme key, and exits 1 when
// there are HARD violations (so it can gate CI once the backlog is cleared).
//
// Usage: node scripts/check-theme-copy.js [--all]   (--all also lists soft warnings)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'apps/web/themes/_shared/staticThemes.js');
const showAll = process.argv.includes('--all');

// Length/quality budgets (chars).
const LIMITS = {
  heroHeadline:   { soft: 60, hard: 80 },
  heroSubheading: { soft: 165, hard: 240 },
  tagline:        { soft: 70, hard: 110 },
};
const TITLE_FIELDS = ['servicesTitle', 'aboutTitle', 'ctaTitle', 'sectionTitle'];
const MAX_TITLE_COMMAS = 2; // 3+ commas in a heading = "comma-soup"
const FILLER = ['boardroom-ready', 'without friction', 'high-intent', 'decision makers'];
const FILLER_OVERUSE = { premium: 200 }; // flag words used absurdly often

// Matches both makeTheme single-quoted (field: '...') and the double-quoted
// generated block ("field": "...").
const FIELD_RE = /^\s*"?(heroHeadline|heroSubheading|tagline|servicesTitle|aboutTitle|ctaTitle|sectionTitle)"?:\s*["'](.*)["'],?\s*$/;
const KEY_RE = /^\s+"?([a-z0-9_]+)"?:\s*(?:makeTheme\(|\{)/;

const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

const hard = [];
const soft = [];
let currentTheme = '(top)';

lines.forEach((line, i) => {
  const keyM = line.match(KEY_RE);
  if (keyM) { currentTheme = keyM[1]; return; }
  const m = line.match(FIELD_RE);
  if (!m) return;
  const [, field, value] = m;
  const len = value.length;
  const at = `${currentTheme} (L${i + 1})`;
  const snippet = value.length > 64 ? `${value.slice(0, 61)}…` : value;

  if (LIMITS[field]) {
    const { soft: s, hard: h } = LIMITS[field];
    if (len > h) hard.push(`${at} · ${field} ${len} chars (>${h}): "${snippet}"`);
    else if (len > s) soft.push(`${at} · ${field} ${len} chars (>${s}): "${snippet}"`);
  }
  if (TITLE_FIELDS.includes(field)) {
    const commas = (value.match(/,/g) || []).length;
    if (commas >= MAX_TITLE_COMMAS + 1) hard.push(`${at} · ${field} has ${commas} commas (comma-soup): "${snippet}"`);
  }
});

// Filler scan (whole file).
const fillerReport = [];
for (const phrase of FILLER) {
  const n = (src.match(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
  if (n > 0) fillerReport.push(`  "${phrase}": ${n}`);
}
for (const [word, limit] of Object.entries(FILLER_OVERUSE)) {
  const n = (src.match(new RegExp(`\\b${word}\\b`, 'gi')) || []).length;
  if (n > limit) fillerReport.push(`  "${word}": ${n} (over-used, budget ${limit})`);
}

console.log(`\nTheme copy quality — ${path.relative(ROOT, FILE)}`);
console.log('='.repeat(64));
console.log(`HARD violations: ${hard.length}   ·   soft warnings: ${soft.length}`);

if (hard.length) {
  console.log('\nHARD (fix these):');
  hard.forEach((v) => console.log('  ✗ ' + v));
}
if (fillerReport.length) {
  console.log('\nFiller / over-used phrases:');
  fillerReport.forEach((v) => console.log(v));
}
if (showAll && soft.length) {
  console.log('\nSOFT (tighten when convenient):');
  soft.forEach((v) => console.log('  • ' + v));
} else if (soft.length) {
  console.log(`\n(${soft.length} soft warnings — run with --all to list)`);
}

console.log('');
process.exit(hard.length > 0 ? 1 : 0);

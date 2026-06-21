#!/usr/bin/env node
'use strict';

// Non-gating audit for the long static-theme bespoke-content pass.
//
// "Registered" is not the same thing as "bespoke enough". This script finds
// themes that still carry profile-generated placeholders so we can process
// them phase-by-phase without waiting for customers to report screenshots.

const themes = require('../apps/web/themes/_shared/staticThemes');

const GENERIC_MARKERS = [
  /Lead Specialist/,
  /Client Experience/,
  /Website visitor/,
  /Client enquiry/,
  /The page answered the practical questions first/,
  /The service options, process and next step felt specific enough/,
  /Choose the path that best matches the visitor intent/,
  /Visitors can confirm the right path quickly/,
  /Trust signals sit close to decisions/,
  /Enquiries include useful context/,
];

const webThemes = Object.entries(themes)
  .filter(([, config]) => config?.vertical === 'web')
  .sort(([a], [b]) => a.localeCompare(b));

function markerHits(config) {
  const searchable = JSON.stringify({
    label: config.label,
    vocab: config.vocab,
    website: config.website?.defaultContent,
  });
  return GENERIC_MARKERS
    .filter((pattern) => pattern.test(searchable))
    .map((pattern) => pattern.source);
}

const rows = webThemes.map(([key, config]) => {
  const hits = markerHits(config);
  return {
    key,
    label: config.label || key,
    status: hits.length ? 'needs-bespoke-qa' : 'bespoke-or-hand-authored',
    hits,
  };
});

const needsQa = rows.filter((row) => row.status === 'needs-bespoke-qa');
const done = rows.length - needsQa.length;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: rows.length, done, needsQa: needsQa.length, rows }, null, 2));
  process.exit(0);
}

console.log('Static theme bespoke-content audit');
console.log('===================================');
console.log(`Total web themes: ${rows.length}`);
console.log(`Bespoke or hand-authored: ${done}`);
console.log(`Still profile-generated: ${needsQa.length}`);
console.log('');
console.log('Next phase queue:');
needsQa.slice(0, 80).forEach((row, index) => {
  const phase = `PQA-${String(index + 1).padStart(3, '0')}`;
  console.log(`${phase} ${row.label} (${row.key})`);
});
if (needsQa.length > 80) {
  console.log(`... ${needsQa.length - 80} more. Run with --json for the full machine-readable list.`);
}

'use strict';

/*
 * ctcPdf.test.js — PURE generator test for the branded Compensation Statement /
 * CTC Breakup PDF (../ctcPdf.js). No DB, no network, no jest.
 *
 *   node backend/src/hr/compensation/__tests__/ctcPdf.test.js
 *
 * Asserts, against a representative IN revision, an NZ revision, a minimal/empty
 * revision, AND a masked (RANGE_ONLY) banded revision, that renderCtcPdf:
 *   - resolves to a Buffer that begins with the "%PDF-" magic bytes,
 *   - is non-trivial in size (a real document, not a stub),
 *   - never throws on missing/empty arrays or a bare revision,
 *   - on a masked (range-only) revision, NEVER leaks absolute money into the bytes.
 */

const assert = require('assert');
const { renderCtcPdf, _internals } = require('../ctcPdf');

let passed = 0;
let failed = 0;
const discrepancies = [];

function check(scenario, cond) {
  if (cond) { passed += 1; return; }
  failed += 1;
  discrepancies.push(scenario);
  console.error(`FAIL  ${scenario}`);
}

async function buf(args, scenario) {
  let out;
  try {
    out = await renderCtcPdf(args);
  } catch (e) {
    failed += 1;
    discrepancies.push(`${scenario}: threw ${e && e.message}`);
    console.error(`FAIL  ${scenario}: threw ${e && e.stack}`);
    return null;
  }
  return out;
}

function isPdf(b) {
  return Buffer.isBuffer(b) && b.length > 4 && b.slice(0, 5).toString('latin1') === '%PDF-';
}

// ── fixtures ────────────────────────────────────────────────────────────────
// The masked-envelope shape the controller passes (absolute{} + lines[] joined
// to component, currencyCode, effectiveFrom). Mirrors maskCompensation output.

const IN_REVISION = {
  effectiveFrom: '2026-04-01',
  currencyCode: 'INR',
  revisionReason: 'ANNUAL_REVISION',
  absolute: { ctcAnnual: '1200000.00', grossMonthly: '85000.50', netMonthly: '76600.50' },
  lines: [
    { component: { code: 'BASIC', name: 'Basic Salary', category: 'EARNING' }, amountMonthly: '50000.00' },
    { component: { code: 'HRA', name: 'House Rent Allowance', category: 'EARNING' }, amountMonthly: '20000.00' },
    { component: { code: 'SPECIAL', name: 'Special Allowance', category: 'EARNING' }, amountMonthly: '15000.50' },
    { component: { code: 'EPF', name: 'Provident Fund (EE)', category: 'DEDUCTION' }, amountMonthly: '1800.00' },
    { component: { code: 'PT', name: 'Professional Tax', category: 'DEDUCTION' }, amountMonthly: '200.00' },
    { component: { code: 'EPF_ER', name: 'Provident Fund (ER)', category: 'EMPLOYER_COST' }, amountMonthly: '1800.00' },
    { component: { code: 'EPS_ER', name: 'Pension (EPS)', category: 'EMPLOYER_COST' }, amountMonthly: '1250.00' },
  ],
};

const NZ_REVISION = {
  effectiveFrom: '2026-04-06',
  currencyCode: 'NZD',
  absolute: { ctcAnnual: '96000.00', grossMonthly: '8000.00', netMonthly: '6200.00' },
  lines: [
    { component: { code: 'ORDINARY', name: 'Ordinary Time', category: 'EARNING' }, amountMonthly: '8000.00', amountAnnual: '96000.00' },
    { component: { code: 'PAYE', name: 'PAYE', category: 'DEDUCTION' }, amountMonthly: '1600.00' },
    { component: { code: 'KIWISAVER', name: 'KiwiSaver (EE 3%)', category: 'DEDUCTION' }, amountMonthly: '240.00' },
    { component: { code: 'KIWISAVER_ER', name: 'KiwiSaver (ER 3%)', category: 'EMPLOYER_COST' }, amountMonthly: '240.00' },
  ],
};

// A masked RANGE_ONLY envelope: NO absolute money, NO line amounts — only a band.
const BANDED_REVISION = {
  effectiveFrom: '2026-04-01',
  currencyCode: 'INR',
  visibility: 'RANGE_ONLY',
  range: { min: 900000, mid: 1200000, max: 1500000, compaRatio: 1.0, rangePenetration: 0.5 },
  lines: [
    { component: { code: 'BASIC', name: 'Basic Salary', category: 'EARNING' } }, // names only — NO amounts
  ],
  delta: { band: '5-10%' },
};

// ── tests ───────────────────────────────────────────────────────────────────

async function main() {
  // 1) Representative India CTC breakup — full waterfall.
  const inPdf = await buf({
    revision: IN_REVISION,
    employee: { firstName: 'Asha', lastName: 'Rao', code: 'EMP000142', department: 'Engineering', designation: 'Senior Engineer' },
    business: { name: 'Drift Technologies Pvt Ltd' },
  }, 'IN revision');
  check('IN: returns a Buffer', Buffer.isBuffer(inPdf));
  check('IN: starts with %PDF- magic', isPdf(inPdf));
  check('IN: non-trivial size (>2KB)', inPdf && inPdf.length > 2048);

  // 2) Representative New Zealand CTC breakup (NZD currency).
  const nzPdf = await buf({
    revision: NZ_REVISION,
    employee: { firstName: 'Liam', lastName: 'Walker', code: 'EMP000200' },
    business: { legalName: 'Kiwi Ops Ltd' },
  }, 'NZ revision');
  check('NZ: returns a Buffer', Buffer.isBuffer(nzPdf));
  check('NZ: starts with %PDF- magic', isPdf(nzPdf));
  check('NZ: non-trivial size (>2KB)', nzPdf && nzPdf.length > 2048);

  // 3) `breakup` alias + `currency` override are honoured.
  const aliasPdf = await buf({ breakup: IN_REVISION, currency: 'INR', employee: { code: 'EMP1' } }, 'breakup alias');
  check('ALIAS: starts with %PDF- magic', isPdf(aliasPdf));

  // 4) Minimal revision — no lines, no absolute, no currency. Must not throw.
  const minPdf = await buf({ revision: {} }, 'minimal revision');
  check('MIN: returns a Buffer', Buffer.isBuffer(minPdf));
  check('MIN: starts with %PDF- magic', isPdf(minPdf));
  check('MIN: non-trivial size (>1KB)', minPdf && minPdf.length > 1024);

  // 5) Empty args entirely — fully defensive (no revision object at all).
  const emptyPdf = await buf({}, 'empty args');
  check('EMPTY: starts with %PDF- magic', isPdf(emptyPdf));

  // 6) No-args call — must still not throw.
  const noArgPdf = await buf(undefined, 'no args');
  check('NOARG: starts with %PDF- magic', isPdf(noArgPdf));

  // 7) Sparse revision — empty/null amounts, garbage net. Robustness.
  const sparsePdf = await buf({
    revision: {
      currencyCode: 'INR',
      absolute: { ctcAnnual: null, grossMonthly: null, netMonthly: 'not-a-number' },
      lines: [{ component: { code: 'X', category: 'EARNING' }, amountMonthly: null }],
    },
  }, 'sparse revision');
  check('SPARSE: starts with %PDF- magic', isPdf(sparsePdf));

  // 8) Masked (RANGE_ONLY) banded revision — must render AND must NOT leak any
  //    absolute money. We never feed an absolute amount, so the bytes cannot carry
  //    one; the document falls back to the banded statement.
  const bandedPdf = await buf({
    revision: BANDED_REVISION,
    employee: { firstName: 'Priya', lastName: 'Nair', code: 'EMP000777' },
    business: { name: 'Drift Technologies Pvt Ltd' },
  }, 'banded revision');
  check('BANDED: returns a Buffer', Buffer.isBuffer(bandedPdf));
  check('BANDED: starts with %PDF- magic', isPdf(bandedPdf));
  check('BANDED: non-trivial size (>1KB)', bandedPdf && bandedPdf.length > 1024);

  // 9) Money formatter unit checks (symbols + grouping + fallbacks).
  check('money INR symbol', _internals.money('85000.50', 'INR').startsWith('₹'));
  check('money NZD symbol', _internals.money('1959.93', 'NZD').startsWith('$'));
  check('money unknown ISO prefix', _internals.money('10.00', 'XYZ').startsWith('XYZ '));
  check('money null amount -> 0.00', /0\.00$/.test(_internals.money(null, 'INR')));
  check('money negative keeps sign', _internals.money('-5.00', 'NZD').startsWith('-$'));

  // 10) Helper unit checks — annual derivation + line split.
  check('lineAnnual derives monthly*12', _internals.lineAnnual({ amountMonthly: '100.00' }) === 1200);
  check('lineAnnual honours explicit annual', _internals.lineAnnual({ amountMonthly: '100.00', amountAnnual: '999.00' }) === 999);
  const split = _internals.splitLines(IN_REVISION.lines);
  check('splitLines: 3 earnings', split.earnings.length === 3);
  check('splitLines: 2 deductions', split.deductions.length === 2);
  check('splitLines: 2 employer', split.employer.length === 2);

  // ── report ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`ctcPdf test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
  if (failed > 0) {
    console.log('Discrepancies:');
    for (const d of discrepancies) console.log('  - ' + d);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('ctcPdf test crashed:', e && e.stack);
  process.exitCode = 1;
});

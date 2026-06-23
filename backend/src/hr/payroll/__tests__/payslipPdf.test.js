'use strict';

/*
 * payslipPdf.test.js — PURE generator test for the branded PDF payslip
 * (../payslipPdf.js). No DB, no network, no jest.
 *
 *   node backend/src/hr/payroll/__tests__/payslipPdf.test.js
 *
 * Asserts, against a representative IN snapshot, an NZ snapshot, and a
 * minimal/empty snapshot, that renderPayslipPdf:
 *   - resolves to a Buffer that begins with the "%PDF-" magic bytes,
 *   - is non-trivial in size (a real multi-element document, not a stub),
 *   - never throws on missing/empty arrays or a bare snapshot.
 */

const assert = require('assert');
const { renderPayslipPdf, _internals } = require('../payslipPdf');

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
    out = await renderPayslipPdf(args);
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

const IN_SNAP = {
  currencyCode: 'INR',
  periodStart: '2026-04-01',
  periodEnd: '2026-04-30',
  payDate: '2026-04-30',
  earnings: [
    { code: 'BASIC', label: 'Basic Salary', amount: '50000.00' },
    { code: 'HRA', label: 'House Rent Allowance', amount: '20000.00' },
    { code: 'SPECIAL', label: 'Special Allowance', amount: '15000.50' },
  ],
  employeeDeductions: [
    { code: 'EPF', label: 'Provident Fund (EE)', amount: '1800.00', statutory: true },
    { code: 'PT', label: 'Professional Tax', amount: '200.00', statutory: true },
    { code: 'TDS', label: 'Income Tax (TDS)', amount: '5400.00', statutory: true },
    { code: 'ADV', label: 'Salary Advance', amount: '1000.00', statutory: false },
  ],
  employerContributions: [
    { code: 'EPF_ER', label: 'Provident Fund (ER)', amount: '1800.00' },
    { code: 'EPS_ER', label: 'Pension (EPS)', amount: '1250.00' },
  ],
  gross: '85000.50',
  totalDeductions: '8400.00',
  totalEmployerCost: '3050.00',
  net: '76600.50',
};

const NZ_SNAP = {
  currencyCode: 'NZD',
  periodStart: '2026-04-06',
  periodEnd: '2026-04-19',
  payDate: '2026-04-24',
  earnings: [
    { code: 'ORDINARY', label: 'Ordinary Time', amount: '2500.00' },
    { code: 'OT', label: 'Overtime', amount: '180.75' },
  ],
  employeeDeductions: [
    { code: 'PAYE', label: 'PAYE', amount: '520.40', statutory: true },
    { code: 'KIWISAVER', label: 'KiwiSaver (EE 3%)', amount: '80.42', statutory: true },
    { code: 'SLOAN', label: 'Student Loan', amount: '120.00', statutory: true },
  ],
  employerContributions: [
    { code: 'KIWISAVER_ER', label: 'KiwiSaver (ER 3%)', amount: '80.42' },
    { code: 'ESCT', label: 'ESCT', amount: '13.50' },
  ],
  gross: '2680.75',
  totalDeductions: '720.82',
  totalEmployerCost: '93.92',
  net: '1959.93',
};

// ── tests ───────────────────────────────────────────────────────────────────

async function main() {
  // 1) Representative India payslip — full identity + YTD.
  const inPdf = await buf({
    payslip: {
      code: 'PS-2026-04-EMP000142',
      snapshotJson: IN_SNAP,
      yptdJson: { grossEarnings: '340002.00', totalDeductions: '33600.00', netPay: '306402.00', monthsPaid: 4 },
    },
    employee: { firstName: 'Asha', lastName: 'Rao', code: 'EMP000142', department: 'Engineering', designation: 'Senior Engineer' },
    business: { name: 'Drift Technologies Pvt Ltd' },
  }, 'IN payslip');
  check('IN: returns a Buffer', Buffer.isBuffer(inPdf));
  check('IN: starts with %PDF- magic', isPdf(inPdf));
  check('IN: non-trivial size (>2KB)', inPdf && inPdf.length > 2048);

  // 2) Representative New Zealand payslip — no YTD, employee relation on payslip.
  const nzPdf = await buf({
    payslip: {
      code: 'PS-2026-W16-EMP000200',
      snapshotJson: NZ_SNAP,
      employee: { firstName: 'Liam', lastName: 'Walker', code: 'EMP000200' },
    },
    business: { legalName: 'Kiwi Ops Ltd' },
  }, 'NZ payslip');
  check('NZ: returns a Buffer', Buffer.isBuffer(nzPdf));
  check('NZ: starts with %PDF- magic', isPdf(nzPdf));
  check('NZ: non-trivial size (>2KB)', nzPdf && nzPdf.length > 2048);

  // 3) Minimal snapshot — no arrays, no totals, missing currency. Must not throw.
  const minPdf = await buf({
    payslip: { code: 'PS-MIN', snapshotJson: {} },
  }, 'minimal snapshot');
  check('MIN: returns a Buffer', Buffer.isBuffer(minPdf));
  check('MIN: starts with %PDF- magic', isPdf(minPdf));
  check('MIN: non-trivial size (>1KB)', minPdf && minPdf.length > 1024);

  // 4) Empty args entirely — fully defensive (no payslip object at all).
  const emptyPdf = await buf({}, 'empty args');
  check('EMPTY: starts with %PDF- magic', isPdf(emptyPdf));

  // 5) No-args call — must still not throw.
  const noArgPdf = await buf(undefined, 'no args');
  check('NOARG: starts with %PDF- magic', isPdf(noArgPdf));

  // 6) Snapshot with empty arrays + null amounts — robustness.
  const sparsePdf = await buf({
    payslip: {
      code: 'PS-SPARSE',
      snapshotJson: {
        currencyCode: 'INR',
        earnings: [],
        employeeDeductions: [{ code: 'X', amount: null }],
        employerContributions: [],
        gross: null, totalDeductions: undefined, net: 'not-a-number',
      },
    },
  }, 'sparse snapshot');
  check('SPARSE: starts with %PDF- magic', isPdf(sparsePdf));

  // 7) Money formatter unit checks (symbols + grouping + fallbacks).
  check('money INR symbol', _internals.money('85000.50', 'INR').startsWith('₹'));
  check('money NZD symbol', _internals.money('1959.93', 'NZD').startsWith('$'));
  check('money unknown ISO prefix', _internals.money('10.00', 'XYZ').startsWith('XYZ '));
  check('money null amount -> 0.00', /0\.00$/.test(_internals.money(null, 'INR')));
  check('money negative keeps sign', _internals.money('-5.00', 'NZD').startsWith('-$'));

  // ── report ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`payslipPdf test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
  if (failed > 0) {
    console.log('Discrepancies:');
    for (const d of discrepancies) console.log('  - ' + d);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('payslipPdf test crashed:', e && e.stack);
  process.exitCode = 1;
});

'use strict';

/**
 * Plain-node test for accounting.js (no test runner required).
 *   node src/hr/integrations/accounting.test.js
 * Asserts the journal balances (debits == credits) and prints a sample export
 * for each target format. Exits non-zero on any failure.
 */

const assert = require('assert');
const acc = require('./accounting');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

// A synthetic pay-run aggregate matching the getRun() shape. Two employees,
// India statutory (PF + ESI + PT + TDS) + one with a non-statutory loan
// deduction so the "Other Deductions" credit line exercises too.
//
// Employee A: gross 50000, PF(ee) 1800, PT 200, TDS 3000 → stat 5000;
//             loan 2000 (non-stat); net = 50000-5000-2000 = 43000.
//             Employer: PF(er) 1800, ESI(er) 0.
// Employee B: gross 18000, PF(ee) 1800, ESI(ee) 135, PT 200 → stat 2135;
//             net = 18000-2135 = 15865. Employer: PF(er) 1800, ESI(er) 585.
const runAggregate = {
  payRun: {
    id: 'run-1',
    code: 'PR-2026-04-IN',
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    payDate: '2026-04-30',
    currencyCode: 'INR',
    entity: { code: 'IN1', legalName: 'Demo India Pvt Ltd' },
  },
  lines: [
    {
      grossEarnings: '50000.00',
      totalDeductions: '7000.00', // 5000 statutory + 2000 loan
      netPay: '43000.00',
      pfEmployee: '1800.00', pt: '200.00', tds: '3000.00',
      pfEmployer: '1800.00',
      currencyCode: 'INR',
    },
    {
      grossEarnings: '18000.00',
      totalDeductions: '2135.00',
      netPay: '15865.00',
      pfEmployee: '1800.00', esiEmployee: '135.00', pt: '200.00',
      pfEmployer: '1800.00', esiEmployer: '585.00',
      currencyCode: 'INR',
    },
  ],
};

const journal = acc.buildJournal(runAggregate);

check('journal balances (debits == credits)', () => {
  assert.strictEqual(journal.totals.debitMinor, journal.totals.creditMinor,
    `debit ${journal.totals.debitMinor} != credit ${journal.totals.creditMinor}`);
  assert.strictEqual(journal.balanced, true);
});

check('debit total equals gross + employer cost', () => {
  // gross 68000 + employer (1800+1800+585) 4185 = 72185.00 → 7218500 minor
  assert.strictEqual(journal.totals.debitMinor, acc.toMinor('72185.00'));
});

check('credit lines = statutory + other + net', () => {
  // statutory: employee 7135 + employer 4185 = 11320; other(loan) 2000; net 58865
  // 11320 + 2000 + 58865 = 72185
  const byAcct = Object.fromEntries(journal.lines.map((l) => [l.account, l]));
  assert.strictEqual(byAcct['2100'].creditMinor, acc.toMinor('11320.00'), 'statutory liability');
  assert.strictEqual(byAcct['2110'].creditMinor, acc.toMinor('2000.00'), 'other deductions');
  assert.strictEqual(byAcct['2200'].creditMinor, acc.toMinor('58865.00'), 'net pay clearing');
});

check('every line is debit-XOR-credit', () => {
  for (const l of journal.lines) {
    assert.ok(
      (l.debitMinor > 0) !== (l.creditMinor > 0),
      `line ${l.account} must be either debit or credit, not both/neither`
    );
  }
});

check('unbalanced input throws GL_UNBALANCED', () => {
  // Break the net-pay invariant on purpose.
  const bad = JSON.parse(JSON.stringify(runAggregate));
  bad.lines[0].netPay = '99999.00';
  assert.throws(() => acc.buildJournal(bad), (e) => e.code === 'GL_UNBALANCED');
});

check('xero export balances (sum of LineAmount == 0)', () => {
  const { body } = acc.exportRun(runAggregate, 'xero');
  const sum = body.JournalLines.reduce((s, l) => s + l.LineAmount, 0);
  assert.ok(Math.abs(sum) < 1e-9, `xero LineAmount sum ${sum} != 0`);
});

check('tally export is well-formed XML envelope', () => {
  const { body } = acc.exportRun(runAggregate, 'tally');
  assert.ok(body.startsWith('<ENVELOPE>') && body.trimEnd().endsWith('</ENVELOPE>'));
  assert.ok(body.includes('<VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>'));
});

check('zoho csv has header + one row per journal line', () => {
  const { body } = acc.exportRun(runAggregate, 'zoho-csv');
  const rows = body.split('\n');
  assert.strictEqual(rows.length, journal.lines.length + 1);
});

// ---- Sample output --------------------------------------------------------
console.log('\n--- SAMPLE: journal ---');
console.log(JSON.stringify({
  meta: journal.meta,
  currency: journal.currency,
  totals: { debit: acc.minorToStr(journal.totals.debitMinor), credit: acc.minorToStr(journal.totals.creditMinor) },
  lines: journal.lines.map((l) => ({
    account: l.account, name: l.accountName, type: l.type,
    debit: l.debitMinor ? acc.minorToStr(l.debitMinor) : '',
    credit: l.creditMinor ? acc.minorToStr(l.creditMinor) : '',
  })),
}, null, 2));

console.log('\n--- SAMPLE: Xero ManualJournal ---');
console.log(JSON.stringify(acc.exportRun(runAggregate, 'xero').body, null, 2));

console.log('\n--- SAMPLE: Tally XML ---');
console.log(acc.exportRun(runAggregate, 'tally').body);

console.log('\n--- SAMPLE: Zoho CSV ---');
console.log(acc.exportRun(runAggregate, 'zoho-csv').body);

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed === 0 ? 0 : 1);

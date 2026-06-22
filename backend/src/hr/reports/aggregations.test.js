'use strict';

/**
 * Plain-node test for the PURE report aggregations. No DB, no Prisma — feeds
 * fixed rows and asserts the folds. Run:  node src/hr/reports/aggregations.test.js
 * (also discoverable by `node --test` since it uses node:test).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const agg = require('./aggregations');

// ── money helpers ─────────────────────────────────────────────────────────────
test('sumMoney is exact in minor units (no float drift)', () => {
  // 0.1 + 0.2 famously != 0.3 in float; minor-unit sum must be exact.
  assert.equal(agg.sumMoney(['0.10', '0.20']), 0.3);
  assert.equal(agg.sumMoney([1000.05, 2000.95, '0.00']), 3001.0);
  assert.equal(agg.sumMoney([]), 0);
});

test('toNumber handles Decimal-like, string, null', () => {
  assert.equal(agg.toNumber({ toNumber: () => 42.5 }), 42.5);
  assert.equal(agg.toNumber('17.25'), 17.25);
  assert.equal(agg.toNumber(null), 0);
  assert.equal(agg.toNumber('not-a-number'), 0);
});

// ── 1. payroll register ───────────────────────────────────────────────────────
test('register column totals == sum of line totals', () => {
  const run = { id: 'run1', code: 'PR-2026-06-IN', currencyCode: 'INR', status: 'COMPUTED' };
  const lines = [
    { id: 'l1', employeeId: 'e1', employee: { code: 'E1', firstName: 'Asha', lastName: 'Rao' },
      grossEarnings: '50000.00', totalDeductions: '8000.50', netPay: '41999.50', employerCost: '6000.00', currencyCode: 'INR' },
    { id: 'l2', employeeId: 'e2', employee: { code: 'E2', firstName: 'Bilal', lastName: 'Khan' },
      grossEarnings: '30000.00', totalDeductions: '4500.25', netPay: '25499.75', employerCost: '3600.00', currencyCode: 'INR' },
    { id: 'l3', employeeId: 'e3', employee: { code: 'E3', firstName: 'Chitra', lastName: 'Iyer' },
      grossEarnings: '20000.00', totalDeductions: '2000.00', netPay: '18000.00', employerCost: '2400.00', currencyCode: 'INR' },
  ];
  const reg = agg.buildPayrollRegister({ run, lines });

  assert.equal(reg.rows.length, 3);
  assert.equal(reg.currencyCode, 'INR');
  assert.equal(reg.rows[0].employeeName, 'Asha Rao');

  // Totals equal the explicit sum of the per-line values.
  assert.equal(reg.totals.gross, agg.sumMoney(lines.map((l) => l.grossEarnings)));
  assert.equal(reg.totals.deductions, agg.sumMoney(lines.map((l) => l.totalDeductions)));
  assert.equal(reg.totals.net, agg.sumMoney(lines.map((l) => l.netPay)));
  assert.equal(reg.totals.employerCost, agg.sumMoney(lines.map((l) => l.employerCost)));
  assert.equal(reg.totals.headcount, 3);

  // Concrete expected figures.
  assert.equal(reg.totals.gross, 100000.0);
  assert.equal(reg.totals.deductions, 14500.75);
  assert.equal(reg.totals.net, 85499.25);
  assert.equal(reg.totals.employerCost, 12000.0);

  // Accounting identity: gross - deductions == net for each line.
  for (const r of reg.rows) {
    assert.equal(agg.sumMoney([r.gross, -r.deductions]), r.net, `net mismatch for ${r.employeeCode}`);
  }
});

test('register handles empty run', () => {
  const reg = agg.buildPayrollRegister({ run: { id: 'r', code: 'X', currencyCode: 'NZD' }, lines: [] });
  assert.deepEqual(reg.totals, { gross: 0, deductions: 0, net: 0, employerCost: 0, headcount: 0 });
});

// ── 2. statutory summary ──────────────────────────────────────────────────────
test('IN statutory summary sums each contribution + grand total', () => {
  const lines = [
    { pfEmployee: '1800.00', pfEmployer: '1950.00', esiEmployee: '375.00', esiEmployer: '1625.00', pt: '200.00', tds: '5000.00' },
    { pfEmployee: '1500.00', pfEmployer: '1500.00', esiEmployee: '0.00', esiEmployer: '0.00', pt: '200.00', tds: '2500.00' },
  ];
  const s = agg.buildStatutorySummary({ lines, countryCode: 'IN', currencyCode: 'INR', taxPeriod: '2026-06' });

  assert.equal(s.countryCode, 'IN');
  const byKey = Object.fromEntries(s.items.map((i) => [i.key, i.amount]));
  assert.equal(byKey.pfEmployee, 3300.0);
  assert.equal(byKey.pfEmployer, 3450.0);
  assert.equal(byKey.tds, 7500.0);
  assert.equal(byKey.pt, 400.0);

  // group rollup: PF group == pfEmployee + pfEmployer
  const pfGroup = s.groups.find((g) => g.group === 'PF');
  assert.equal(pfGroup.amount, agg.sumMoney([byKey.pfEmployee, byKey.pfEmployer]));

  // grand total == sum of every item
  assert.equal(s.total, agg.sumMoney(s.items.map((i) => i.amount)));
  assert.equal(s.total, 16650.0);
  assert.equal(s.headcount, 2);
});

test('NZ statutory summary selects PAYE/KiwiSaver/ESCT/ACC columns', () => {
  const lines = [
    { paye: '900.00', kiwiSaverEmployee: '120.00', kiwiSaverEmployer: '120.00', esct: '40.00', accLevy: '24.00', studentLoan: '0.00' },
    { paye: '1100.00', kiwiSaverEmployee: '160.00', kiwiSaverEmployer: '160.00', esct: '55.00', accLevy: '30.00', studentLoan: '45.00' },
  ];
  const s = agg.buildStatutorySummary({ lines, countryCode: 'NZ' });
  assert.equal(s.countryCode, 'NZ');
  assert.equal(s.currencyCode, 'NZD');
  const byKey = Object.fromEntries(s.items.map((i) => [i.key, i.amount]));
  assert.equal(byKey.paye, 2000.0);
  assert.equal(byKey.kiwiSaverEmployer, 280.0);
  assert.equal(byKey.studentLoan, 45.0);
  // No IN columns leaked in.
  assert.ok(!('pfEmployee' in byKey));
  assert.equal(s.total, agg.sumMoney(s.items.map((i) => i.amount)));
});

// ── 3. headcount & attrition ──────────────────────────────────────────────────
test('headcount buckets active/joined/terminated by department over a window', () => {
  const employees = [
    { id: '1', status: 'ACTIVE', isActive: true, hireDate: '2026-06-10', terminationDate: null, departmentId: 'eng', departmentName: 'Engineering' },
    { id: '2', status: 'ACTIVE', isActive: true, hireDate: '2025-01-01', terminationDate: null, departmentId: 'eng', departmentName: 'Engineering' },
    { id: '3', status: 'TERMINATED', isActive: false, hireDate: '2024-03-01', terminationDate: '2026-06-20', departmentId: 'eng', departmentName: 'Engineering' },
    { id: '4', status: 'ACTIVE', isActive: true, hireDate: '2020-01-01', terminationDate: null, departmentId: 'sales', departmentName: 'Sales' },
  ];
  const r = agg.buildHeadcount({ employees, periodStart: '2026-06-01', periodEnd: '2026-06-30', groupBy: 'department' });

  assert.equal(r.groupBy, 'department');
  assert.equal(r.totals.headcount, 4);
  assert.equal(r.totals.active, 3);
  assert.equal(r.totals.joined, 1);       // only id 1 hired in June
  assert.equal(r.totals.terminated, 1);   // only id 3 terminated in June

  const eng = r.buckets.find((b) => b.key === 'eng');
  assert.equal(eng.headcount, 3);
  assert.equal(eng.active, 2);
  assert.equal(eng.joined, 1);
  assert.equal(eng.terminated, 1);

  // bucket sums reconcile to totals
  assert.equal(r.buckets.reduce((a, b) => a + b.headcount, 0), r.totals.headcount);
  assert.equal(r.buckets.reduce((a, b) => a + b.terminated, 0), r.totals.terminated);
});

test('headcount groupBy entity respects dimension', () => {
  const employees = [
    { id: '1', status: 'ACTIVE', isActive: true, entityId: 'IN', entityName: 'India HQ' },
    { id: '2', status: 'ACTIVE', isActive: true, entityId: 'NZ', entityName: 'NZ Ltd' },
    { id: '3', status: 'ACTIVE', isActive: true, entityId: 'IN', entityName: 'India HQ' },
  ];
  const r = agg.buildHeadcount({ employees, groupBy: 'entity' });
  assert.equal(r.groupBy, 'entity');
  assert.equal(r.buckets.find((b) => b.key === 'IN').headcount, 2);
});

// ── 4. leave liability ────────────────────────────────────────────────────────
test('leave liability values closing balance * dayRate and prefers NZ valuation', () => {
  const balances = [
    { employeeId: 'e1', leaveTypeId: 'EL', leaveTypeName: 'Earned Leave', unit: 'DAYS', closing: '12.0000', dayRate: 1000, currencyCode: 'INR' },
    { employeeId: 'e2', leaveTypeId: 'EL', leaveTypeName: 'Earned Leave', unit: 'DAYS', closing: '5.0000', dayRate: 800, currencyCode: 'INR' },
    // NZ annual leave carries a pre-valued money figure → dayRate ignored.
    { employeeId: 'e3', leaveTypeId: 'ANNUAL', leaveTypeName: 'Annual', unit: 'WEEKS', closing: '4.0000', dayRate: 99999, nzAccruedGrossEarnings: '3200.00', currencyCode: 'INR' },
  ];
  const r = agg.buildLeaveLiability({ balances, currencyCode: 'INR' });

  assert.equal(r.rows[0].value, 12000.0); // 12 * 1000
  assert.equal(r.rows[1].value, 4000.0);  // 5 * 800
  assert.equal(r.rows[2].value, 3200.0);  // NZ pre-valued, not 4*99999

  // totalValue == sum of row values
  assert.equal(r.totalValue, agg.sumMoney(r.rows.map((x) => x.value)));
  assert.equal(r.totalValue, 19200.0);

  // by-type rollup: EL groups the two earned-leave rows
  const el = r.byType.find((t) => t.leaveTypeId === 'EL');
  assert.equal(el.value, 16000.0);
  assert.equal(el.quantity, 17);
});

// Allow a bare `node aggregations.test.js` run to print a clear pass line.
if (require.main === module) {
  // node:test auto-runs registered tests; nothing else needed here.
}

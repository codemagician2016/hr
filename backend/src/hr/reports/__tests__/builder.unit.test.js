'use strict';

/*
 * builder.unit.test.js — Reports Platform builder engine (builder.service.js),
 * pure compile/validate + fold parts. Plain-node, NO DB (validation runs against
 * the real datasets.js registry but never calls a fetch):
 *   node backend/src/hr/reports/__tests__/builder.unit.test.js
 */

const assert = require('assert');
const builder = require('../builder.service');
const { DATASET_KEYS, getDataset } = require('../datasets');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

function catching(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

async function main() {
  /* ── registry sanity: the 10 promised datasets exist ── */
  {
    const expected = [
      'employees', 'attendance_days', 'leave_requests', 'leave_balances',
      'payroll_lines', 'expenses', 'loans', 'assets_assignments',
      'helpdesk_tickets', 'recognition_ledger',
    ];
    for (const k of expected) ok(`dataset "${k}" registered`, DATASET_KEYS.includes(k));
    ok('exactly 10 datasets', DATASET_KEYS.length === 10);
    for (const k of DATASET_KEYS) {
      const d = getDataset(k);
      ok(`${k} has fetch()`, typeof d.fetch === 'function');
      ok(`${k} groupable ⊆ columns`, d.groupable.every((g) => d.columns.some((c) => c.key === g)));
    }
  }

  /* ── validate: unknown dataset → 400 listing allowed datasets ── */
  {
    const e = catching(() => builder.validateDefinition({ datasetKey: 'payslips' }));
    ok('unknown dataset rejects', !!e);
    ok('unknown dataset is 400', e.statusCode === 400);
    ok('message lists allowed datasets', DATASET_KEYS.every((k) => e.message.includes(k)));
  }

  /* ── validate: unknown column → 400 listing allowed columns ── */
  {
    const e = catching(() => builder.validateDefinition({ datasetKey: 'employees', columns: ['code', 'salary'] }));
    ok('unknown column rejects', !!e && e.statusCode === 400);
    ok('message names the bad column', e.message.includes('salary'));
    ok('message lists allowed columns', e.message.includes('firstName') && e.message.includes('departmentName'));
  }

  /* ── validate: duplicate column → 400 ── */
  {
    const e = catching(() => builder.validateDefinition({ datasetKey: 'employees', columns: ['code', 'code'] }));
    ok('duplicate column rejects', !!e && e.statusCode === 400);
  }

  /* ── validate: unknown filter → 400 listing allowed filters ── */
  {
    const e = catching(() => builder.validateDefinition({ datasetKey: 'loans', filters: { department: 'x' } }));
    ok('unknown filter rejects', !!e && e.statusCode === 400);
    ok('message lists allowed filters', e.message.includes('status') && e.message.includes('loanType'));
  }

  /* ── validate: empty filter values are dropped, not rejected ── */
  {
    const v = builder.validateDefinition({ datasetKey: 'loans', filters: { status: '', employeeId: null } });
    ok('empty filters dropped', Object.keys(v.filters).length === 0);
  }

  /* ── validate: unknown groupBy → 400 listing groupable ── */
  {
    const e = catching(() => builder.validateDefinition({ datasetKey: 'expenses', groupBy: 'amount' }));
    ok('non-groupable key rejects', !!e && e.statusCode === 400);
    ok('message lists groupable keys', e.message.includes('categoryName'));
  }

  /* ── validate: unknown sort key → 400 ── */
  {
    const e = catching(() => builder.validateDefinition({ datasetKey: 'employees', sort: { key: 'nope' } }));
    ok('unknown sort key rejects', !!e && e.statusCode === 400);
    ok('message lists sort keys', e.message.includes('code'));
  }

  /* ── validate: happy path — defaults + normalisation ── */
  {
    const v = builder.validateDefinition({ datasetKey: 'employees' });
    ok('missing columns → all dataset columns', v.columnKeys.length === getDataset('employees').columns.length);
    ok('no groupBy default', v.groupBy === null);
    const v2 = builder.validateDefinition({
      datasetKey: 'employees',
      columns: ['code', 'status'],
      filters: { status: 'ACTIVE' },
      groupBy: 'status',
      sort: { key: 'count', dir: 'DESC' },
    });
    ok('chosen columns kept in order', v2.columnKeys.join(',') === 'code,status');
    ok('sort dir normalised', v2.sort.dir === 'desc');
    ok('grouped mode admits count as a sort key', v2.sort.key === 'count');
  }

  /* ── applyGrouping: count + numeric/money sums ── */
  {
    const columns = [
      { key: 'status', label: 'Status', type: 'enum' },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'days', label: 'Days', type: 'number' },
      { key: 'name', label: 'Name', type: 'string' },
    ];
    const rows = [
      { status: 'APPROVED', amount: 10.1, days: 1, name: 'a' },
      { status: 'APPROVED', amount: 20.2, days: 2, name: 'b' },
      { status: 'REJECTED', amount: 5, days: 0.5, name: 'c' },
      { status: null, amount: 1, days: 1, name: 'd' },
    ];
    const g = builder.applyGrouping(rows, columns, 'status');
    ok('3 groups', g.rows.length === 3);
    const approved = g.rows.find((r) => r.status === 'APPROVED');
    ok('group count', approved.count === 2);
    ok('money sum exact (no float drift)', approved.amount === 30.3);
    ok('number sum', approved.days === 3);
    ok('null group bucketed as —', g.rows.some((r) => r.status === '—'));
    ok('string cols dropped from grouped output', !g.columns.some((c) => c.key === 'name'));
    ok('grouped columns = key, count, sums', g.columns.map((c) => c.key).join(',') === 'status,count,amount,days');
  }

  /* ── applySort: numbers, strings, dates, nulls last both ways ── */
  {
    const rows = [{ n: 2 }, { n: null }, { n: 10 }, { n: 1 }];
    ok('numeric asc', builder.applySort(rows, { key: 'n', dir: 'asc' }).map((r) => r.n).join(',') === '1,2,10,');
    ok('numeric desc, nulls still last', builder.applySort(rows, { key: 'n', dir: 'desc' }).map((r) => r.n).join(',') === '10,2,1,');
    const srows = [{ s: 'b' }, { s: 'a' }, { s: 'c' }];
    ok('string asc', builder.applySort(srows, { key: 's', dir: 'asc' }).map((r) => r.s).join('') === 'abc');
    const d1 = new Date('2026-01-01');
    const d2 = new Date('2026-06-01');
    const drows = [{ d: d2 }, { d: d1 }];
    ok('date asc', builder.applySort(drows, { key: 'd', dir: 'asc' })[0].d === d1);
    ok('no sort → same rows', builder.applySort(rows, null) === rows);
  }

  /* ── paginate ── */
  {
    const rows = Array.from({ length: 12 }, (_, i) => ({ i }));
    const p1 = builder.paginate(rows, 1, 5);
    ok('page 1 slice', p1.pageRows.length === 5 && p1.pageRows[0].i === 0);
    const p3 = builder.paginate(rows, 3, 5);
    ok('last page remainder', p3.pageRows.length === 2 && p3.pageRows[0].i === 10);
    const junk = builder.paginate(rows, 'x', 'y');
    ok('junk paging defaults', junk.page === 1 && junk.pageSize === 50);
  }

  /* ── computeTotals ── */
  {
    const columns = [
      { key: 's', label: 'S', type: 'string' },
      { key: 'm', label: 'M', type: 'money' },
      { key: 'n', label: 'N', type: 'number' },
    ];
    const totals = builder.computeTotals([{ s: 'a', m: 0.1, n: 1 }, { s: 'b', m: 0.2, n: 2 }], columns);
    ok('money total exact', totals.m === 0.3);
    ok('number total', totals.n === 3);
    ok('string not totalled', !('s' in totals));
    ok('no numeric cols → null totals', builder.computeTotals([], [{ key: 's', type: 'string' }]) === null);
  }

  /* ── runDefinition end-to-end over a FAKE dataset fetch (no DB) ── */
  {
    const { DATASETS } = require('../datasets');
    const original = DATASETS.loans.fetch;
    DATASETS.loans.fetch = async ({ filters }) => ({
      rows: [
        { loanNumber: 'L-2', employeeCode: 'E2', employeeName: 'Bee', loanType: 'LOAN', principal: 200, interestRate: null, tenureMonths: 10, emiAmount: 20, startDate: new Date('2026-02-01'), status: filters.status || 'APPROVED', amountRepaid: 50, outstanding: 150 },
        { loanNumber: 'L-1', employeeCode: 'E1', employeeName: 'Aye', loanType: 'LOAN', principal: 100, interestRate: null, tenureMonths: 10, emiAmount: 10, startDate: new Date('2026-01-01'), status: filters.status || 'APPROVED', amountRepaid: 25, outstanding: 75 },
      ],
      total: 2,
    });
    try {
      const run = await builder.runDefinition(
        { datasetKey: 'loans', columns: ['loanNumber', 'principal', 'status'], filters: { status: 'APPROVED' }, sort: { key: 'principal', dir: 'asc' } },
        { businessId: 'b1', scope: { kind: 'ALL' }, page: 1, pageSize: 10 },
      );
      ok('run projects chosen columns only', Object.keys(run.rows[0]).join(',') === 'loanNumber,principal,status');
      ok('run sorted asc by principal', run.rows[0].loanNumber === 'L-1');
      ok('run totals money col', run.totals.principal === 300);
      ok('run total count', run.total === 2);

      const grouped = await builder.runDefinition(
        { datasetKey: 'loans', columns: ['loanNumber', 'principal', 'status'], groupBy: 'status' },
        { businessId: 'b1', scope: { kind: 'ALL' } },
      );
      ok('grouped run: single status bucket', grouped.rows.length === 1 && grouped.rows[0].count === 2);
      ok('grouped run: principal summed', grouped.rows[0].principal === 300);
    } finally {
      DATASETS.loans.fetch = original;
    }
  }

  console.log(`builder.unit: ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });

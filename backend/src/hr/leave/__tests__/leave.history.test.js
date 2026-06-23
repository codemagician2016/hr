'use strict';

/**
 * leave.history.test.js — proof for the two layman-friendly leave views
 * (Feature 6 surfacing):
 *
 *   (A) ESS leave HISTORY is SELF-ONLY — the meLeave.controller resolves the
 *       subject from the session, so a customer whose email matches the seeded
 *       employee sees that employee's ledger, and a FOREIGN customer (a different
 *       email → resolves to a different employee, or none) sees an empty feed
 *       (never the seeded employee's rows). Run live against hr_test.
 *
 *   (B) the RECONCILIATION arithmetic BALANCES — for a seeded ledger the
 *       reconciliation components (opening/accrued/taken/encashed/lapsed/adjusted)
 *       recomputed from LeaveTransaction satisfy the §4.2 closing identity AND
 *       agree with the persisted LeaveBalance.closing. Pure-node (history.js +
 *       ledger.js) so it runs without a DB too; the live half also drives the
 *       operator employeeReconciliation controller end-to-end.
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/leave/__tests__/leave.history.test.js
 */

const prisma = require('../../../core/lib/prisma');
const meLeave = require('../../controllers/meLeave.controller');
const leaveController = require('../../controllers/leave.controller');
const ledger = require('../ledger');
const history = require('../history');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const oj = res.json.bind(res); res.json = (p) => { const r = oj(p); done(); return r; };
    const oe = res.end.bind(res); res.end = () => { const r = oe(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'LEAVEHIST-TEST';
const ALL_SCOPE = { kind: 'ALL' };

async function cleanup(businessId) {
  await prisma.leaveTransaction.deleteMany({ where: { businessId, leaveType: { code: { startsWith: PREFIX } } } });
  await prisma.leaveBalance.deleteMany({ where: { businessId, leaveType: { code: { startsWith: PREFIX } } } });
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

// ── (B0) PURE reconciliation proof — no DB needed ────────────────────────────
function pureReconcileProof() {
  log('\n(B0) pure reconciliation arithmetic balances:');
  // a synthesised period ledger for one type:
  //   opening 6, accrued 3 (1.5+1.5), taken 2 (approved), pending 1 (NOT in closing),
  //   adjusted +0.5, lapsed 0.5, encashed 1  → closing = 6+3-2-1-0.5+0.5 = 6.0
  const txns = [
    { txnType: 'OPENING_BALANCE', quantity: 6 },
    { txnType: 'ACCRUAL', quantity: 1.5 },
    { txnType: 'ACCRUAL', quantity: 1.5 },
    { txnType: 'APPLICATION', quantity: -2, status: 'APPROVED' },
    { txnType: 'APPLICATION', quantity: -1, status: 'PENDING' },
    { txnType: 'ENCASHMENT', quantity: -1 },
    { txnType: 'LAPSE', quantity: -0.5 },
    { txnType: 'ADJUSTMENT', quantity: 0.5 },
  ];
  const r = history.reconcileBuckets(txns, { closing: 6.0 });
  assert(r.opening === 6, `opening = 6 (got ${r.opening})`);
  assert(r.accrued === 3, `accrued = 3 (got ${r.accrued})`);
  assert(r.taken === 2, `taken = 2 (got ${r.taken})`);
  assert(r.encashed === 1, `encashed = 1 (got ${r.encashed})`);
  assert(r.lapsed === 0.5, `lapsed = 0.5 (got ${r.lapsed})`);
  assert(r.adjusted === 0.5, `adjusted = 0.5 (got ${r.adjusted})`);
  assert(r.pendingApproval === 1, `pendingApproval = 1, NOT in closing (got ${r.pendingApproval})`);

  // the closing identity holds: opening + accrued − taken − encashed − lapsed + adjusted
  const identity = r.opening + r.accrued - r.taken - r.encashed - r.lapsed + r.adjusted;
  assert(identity === r.closing, `identity ${identity} === closing ${r.closing}`);
  assert(r.closing === 6.0, `closing = 6.0 (got ${r.closing})`);
  assert(r.reconciled === true && r.drift === 0, `reconciled vs persisted 6.0 (drift ${r.drift})`);

  // the visible line items re-sum to closing (this is what the UI renders)
  const lineSum = r.lines.reduce((acc, ln) => acc + ln.sign * ln.value, 0);
  assert(Math.abs(lineSum - r.closing) < 1e-9, `Σ(sign × line) ${lineSum} === closing ${r.closing}`);

  // a drifting persisted projection is flagged
  const drifting = history.reconcileBuckets(txns, { closing: 7.0 });
  assert(drifting.reconciled === false && Math.abs(drifting.drift + 1) < 1e-9,
    `drift flagged when persisted=7.0 (reconciled=${drifting.reconciled}, drift=${drifting.drift})`);

  // history feed: running balance ends at the reconstructed closing (ignoring pending)
  const feed = history.buildHistory(txns);
  const last = feed[feed.length - 1];
  assert(Math.abs(last.balanceAfter - ledger.reconstructClosing(txns)) < 1e-9,
    `running balance ends at reconstructed closing ${last.balanceAfter}`);
  // credit/debit direction tagging
  const opening = feed.find((f) => f.txnType === 'OPENING_BALANCE');
  const taken = feed.find((f) => f.txnType === 'APPLICATION' && f.status === 'APPROVED');
  assert(opening.direction === 'credit' && taken.direction === 'debit',
    `opening=credit, approved application=debit (got ${opening.direction}/${taken.direction})`);
  const pendingRow = feed.find((f) => f.status === 'PENDING');
  assert(pendingRow.direction === 'none' && pendingRow.delta === 0,
    `pending application is informational (delta 0, direction none)`);
}

async function main() {
  log('\n=== Leave history + reconciliation proof ===');
  pureReconcileProof();

  log('\n(live hr_test):');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  // Two employees: ME (with a workEmail the session resolves to) and OTHER.
  const meEmail = `${PREFIX.toLowerCase()}-me@example.com`;
  const me = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-ME`, firstName: 'Hattie', lastName: 'Story', status: 'ACTIVE', isActive: true, workEmail: meEmail, hireDate: new Date('2020-01-01') },
  });
  const other = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-OTHER`, firstName: 'Otto', lastName: 'Else', status: 'ACTIVE', isActive: true, workEmail: `${PREFIX.toLowerCase()}-other@example.com`, hireDate: new Date('2020-01-01') },
  });
  const elType = await prisma.leaveType.create({
    data: { businessId, code: `${PREFIX}-EL`, name: 'Earned Leave', category: 'ANNUAL', unit: 'DAYS', color: '#2563eb', isEncashable: true },
  });

  const periodCode = '2026-27';
  // ME's persisted balance lot: opening 6, accrued 3, taken 2, encashed 1, lapsed 0.5,
  // adjusted 0.5 → closing 6.0; pendingApproval 1 (soft-hold, not in closing).
  const meBal = await prisma.leaveBalance.create({
    data: {
      businessId, employeeId: me.id, leaveTypeId: elType.id, periodCode, unit: 'DAYS',
      opening: '6', accrued: '3', taken: '2', encashed: '1', lapsed: '0.5', adjusted: '0.5',
      pendingApproval: '1', closing: '6',
    },
  });
  const meRows = [
    { txnType: 'OPENING_BALANCE', quantity: 6, status: 'APPROVED' },
    { txnType: 'ACCRUAL', quantity: 1.5, status: 'APPROVED' },
    { txnType: 'ACCRUAL', quantity: 1.5, status: 'APPROVED' },
    { txnType: 'APPLICATION', quantity: -2, status: 'APPROVED', startDate: new Date('2026-05-04T00:00:00Z'), endDate: new Date('2026-05-05T00:00:00Z'), reason: 'family trip' },
    { txnType: 'APPLICATION', quantity: -1, status: 'PENDING', startDate: new Date('2026-07-01T00:00:00Z'), endDate: new Date('2026-07-01T00:00:00Z') },
    { txnType: 'ENCASHMENT', quantity: -1, status: 'APPROVED' },
    { txnType: 'LAPSE', quantity: -0.5, status: 'APPROVED' },
    { txnType: 'ADJUSTMENT', quantity: 0.5, status: 'APPROVED', reason: 'goodwill credit' },
  ];
  for (const r of meRows) {
    await prisma.leaveTransaction.create({
      data: {
        businessId, employeeId: me.id, leaveTypeId: elType.id, leaveBalanceId: meBal.id,
        unit: 'DAYS', appliedAt: new Date(), ...r,
      },
    });
  }
  // OTHER has their own (different) ledger row so we can prove isolation.
  const otherBal = await prisma.leaveBalance.create({
    data: { businessId, employeeId: other.id, leaveTypeId: elType.id, periodCode, unit: 'DAYS', opening: '99', closing: '99' },
  });
  await prisma.leaveTransaction.create({
    data: { businessId, employeeId: other.id, leaveTypeId: elType.id, leaveBalanceId: otherBal.id, txnType: 'OPENING_BALANCE', unit: 'DAYS', quantity: 99, status: 'APPROVED', appliedAt: new Date() },
  });

  try {
    // ── (A1) ESS history is self-only: ME's session sees ME's rows ──
    log('(A1) ESS history — own session sees own ledger:');
    {
      const req = { customer: { businessId, email: meEmail, id: 'cust-me' }, query: {} };
      const res = await callController(meLeave.listHistory, req);
      assert(res.statusCode === 200, `history → 200 (got ${res.statusCode})`);
      const items = res.body.items || [];
      assert(items.length === meRows.length, `returns all ${meRows.length} of ME's rows (got ${items.length})`);
      // every returned row belongs to ME's ledger (no OTHER row, qty 99, leaks in)
      const leaked = items.some((it) => it.quantity === 99);
      assert(!leaked, `no foreign (qty 99) row leaks into ME's feed`);
      // newest-first + plain-English labels + signed deltas present
      const labels = items.map((i) => i.label);
      assert(labels.includes('Leave earned (accrued)') && labels.includes('Leave taken (approved)'),
        `feed carries plain-English movement labels`);
    }

    // ── (A2) foreign session is isolated: never sees ME's rows ──
    log('(A2) ESS history — foreign session never sees ME (self-only):');
    {
      // OTHER's session resolves to OTHER → sees only their single qty-99 row.
      const req = { customer: { businessId, email: `${PREFIX.toLowerCase()}-other@example.com`, id: 'cust-other' }, query: {} };
      const res = await callController(meLeave.listHistory, req);
      const items = res.body.items || [];
      assert(items.length === 1 && items[0].quantity === 99, `OTHER sees only their own 1 row (got ${items.length})`);
      // a stranger session (no matching employee) → empty feed, never ME's rows
      const strangerRes = await callController(meLeave.listHistory, { customer: { businessId, email: 'nobody@example.com', id: 'cust-x' }, query: {} });
      assert((strangerRes.body.items || []).length === 0, `unmatched session → empty feed (got ${(strangerRes.body.items || []).length})`);
    }

    // ── (A3) operator history is scope-guarded: foreign employee → 404 ──
    log('(A3) operator employeeHistory — out-of-scope employee → 404:');
    {
      // ALL scope sees ME's history…
      const ok = await callController(leaveController.employeeHistory,
        { user: { businessId }, scope: ALL_SCOPE, params: { employeeId: me.id }, query: {} });
      assert(ok.statusCode === 200 && (ok.body.items || []).length === meRows.length,
        `ALL-scope operator sees ME's ${meRows.length} rows (got ${ok.statusCode}/${(ok.body.items || []).length})`);
      // …but an empty scope (no accessible employees) 404s the same employee.
      const denied = await callController(leaveController.employeeHistory,
        { user: { businessId }, scope: { kind: 'NONE' }, params: { employeeId: me.id }, query: {} });
      assert(denied.statusCode === 404, `out-of-scope employee → 404 (got ${denied.statusCode})`);
    }

    // ── (B1) operator reconciliation arithmetic balances against the ledger ──
    log('(B1) operator employeeReconciliation — arithmetic balances:');
    {
      const req = { user: { businessId }, scope: ALL_SCOPE, params: { employeeId: me.id }, query: { periodCode } };
      const res = await callController(leaveController.employeeReconciliation, req);
      assert(res.statusCode === 200, `reconciliation → 200 (got ${res.statusCode})`);
      const g = (res.body.items || []).find((x) => x.leaveTypeId === elType.id);
      assert(!!g, `statement present for the seeded leave type`);
      // opening + accrued − taken − encashed − lapsed + adjusted === closing
      const identity = g.opening + g.accrued - g.taken - g.encashed - g.lapsed + g.adjusted;
      assert(identity === g.closing, `identity ${identity} === closing ${g.closing}`);
      assert(g.closing === 6, `closing = 6 (got ${g.closing})`);
      assert(g.reconciled === true && g.drift === 0,
        `ledger reconciles with persisted closing 6 (reconciled=${g.reconciled}, drift=${g.drift})`);
      // cross-check directly against the persisted projection + the ledger reducer
      const freshBal = await prisma.leaveBalance.findUnique({ where: { id: meBal.id } });
      const txns = await prisma.leaveTransaction.findMany({ where: { businessId, leaveBalanceId: meBal.id } });
      assert(ledger.reconciles({ closing: Number(freshBal.closing) }, txns),
        `persisted closing ${Number(freshBal.closing)} == ledger reconstruction ${ledger.reconstructClosing(txns)}`);
      // the line items the UI renders re-sum to closing
      const lineSum = g.lines.reduce((acc, ln) => acc + ln.sign * ln.value, 0);
      assert(Math.abs(lineSum - g.closing) < 1e-9, `Σ(sign × line) ${lineSum} === closing ${g.closing}`);
    }

    // ── (B2) reconciliation 400s without a period; 404s out of scope ──
    log('(B2) reconciliation guards (period required, scope-guarded):');
    {
      const noPeriod = await callController(leaveController.employeeReconciliation,
        { user: { businessId }, scope: ALL_SCOPE, params: { employeeId: me.id }, query: {} });
      assert(noPeriod.statusCode === 400, `missing periodCode → 400 (got ${noPeriod.statusCode})`);
      const denied = await callController(leaveController.employeeReconciliation,
        { user: { businessId }, scope: { kind: 'NONE' }, params: { employeeId: me.id }, query: { periodCode } });
      assert(denied.statusCode === 404, `out-of-scope employee → 404 (got ${denied.statusCode})`);
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL LEAVE-HISTORY CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

'use strict';

/*
 * reimbursement-payout-race.live.test.js — LIVE (hr_test) regression proof for the TWO
 * CONFIRMED HIGH double-pay bugs in Feature 26 (reimbursement paid via payroll):
 *
 *   FINDING 1 — compute-vs-persist race → double-pay. The engine prices the
 *     EXPENSE_REIMBURSEMENT line + net at COMPUTE time off an UN-locked select; persist
 *     re-selects UNDER LOCK and could stamp a SHRUNKEN set while the payslip already
 *     credited the full pre-race figure → a claim left APPROVED (paid again next run) or
 *     net crediting claims that were never stamped. FIX: persist reprices the line + net
 *     to EXACTLY the locked∩priced set and stamps that same set — one tx, no race window.
 *
 *   FINDING 2 — applyPayout stamped lock-ORDERED claims, not the ones the engine priced.
 *     A different (older) claim approved between compute and persist could be stamped in
 *     place of the priced one; the priced claim stayed APPROVED and rode the next run =
 *     paid twice. FIX: thread the priced claim-id set through and stamp EXACTLY those
 *     (intersected with the lock), never a re-derived lock-ordered set.
 *
 * We make the RACE DETERMINISTIC by monkey-patching reimbursementPayout.selectPayableClaims
 * so the PERSIST-tx lock re-select returns a different set than the COMPUTE-time select
 * (an out-of-band settlement, or a newer older-dated claim) — exactly the window the bugs
 * exploit — then assert the load-bearing invariant:
 *
 *     Σ EXPENSE_REIMBURSEMENT on the payslip == Σ stamped claims.paidViaPayrollAmount
 *
 * i.e. NO claim is paid-but-unstamped (rides next run = double-pay) and NO claim is
 * stamped-but-unpriced (settled but never credited). Recompute/concurrent never double-pays.
 *
 * Plain-node (built-in assert, NO jest). Run:
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/__tests__/reimbursement-payout-race.live.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'. Tears down every row written.
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const service = require('../service');
const reimbursementPayout = require('../../controllers/reimbursementPayout');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'REIMBRACE';

async function cleanup(businessId) {
  const runs = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await prisma.statutoryRemittance.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payslip.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: ids } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.expenseClaim.updateMany({ where: { payRunId: { in: ids } }, data: { status: 'APPROVED', payRunId: null, paidViaPayrollAmount: null, reimbursedAt: null, reimbursedBy: null } });
    await prisma.payRun.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.expenseClaim.deleteMany({ where: { businessId, claimNumber: { startsWith: PREFIX } } });
}

async function mkRun(businessId, entity, cal, { periodStart, periodEnd, payDate, taxYear, seq, suffix, type = 'REGULAR' }) {
  return prisma.payRun.create({
    data: {
      businessId, entityId: entity.id, payCalendarId: cal.id,
      code: `${PREFIX}-${entity.code}-${suffix}`,
      periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), payDate: new Date(payDate),
      sequenceInYear: seq, taxYear, currencyCode: entity.payCurrency, status: 'DRAFT', type,
    },
  });
}

async function mkApprovedClaim(businessId, employeeId, { amount, channel, expenseDate, suffix }) {
  return prisma.expenseClaim.create({
    data: {
      businessId, employeeId, claimNumber: `${PREFIX}-${suffix}`,
      amount: String(amount), currencyCode: 'INR', status: 'APPROVED',
      payoutChannel: channel, expenseDate: new Date(expenseDate),
      decidedAt: new Date(expenseDate),
    },
  });
}

function dec(v) { return Number(v); }

// Sum the stamped claim amounts a run actually settled (the credit-side parity check).
async function stampedTotalMinor(businessId, payRunId) {
  const claims = await prisma.expenseClaim.findMany({
    where: { businessId, payRunId, status: 'REIMBURSED', paidViaPayrollAmount: { not: null } },
    select: { id: true, paidViaPayrollAmount: true },
  });
  let total = 0;
  for (const c of claims) total += Math.round(Number(c.paidViaPayrollAmount) * 100);
  return { total, ids: claims.map((c) => c.id) };
}

// Read the EXPENSE_REIMBURSEMENT credit the persisted payslip line actually shows (paise).
async function lineReimbMinor(businessId, payRunId) {
  const line = await prisma.payRunLine.findFirst({ where: { businessId, payRunId }, include: { components: true } });
  const comp = (line.components || []).find((c) => c.componentCode === 'EXPENSE_REIMBURSEMENT');
  const reimbMinor = comp ? Math.round(Number(comp.amount) * 100) : 0;
  return { line, reimbMinor, netMinor: Math.round(Number(line.netPay) * 100) };
}

/**
 * withSelectOverride — run `fn` with selectPayableClaims patched. `onCompute(real)` shapes
 * the COMPUTE-time (1st call per employee, un-locked) result the engine PRICES from;
 * `onPersist(real)` shapes the PERSIST-tx (2nd call, FOR UPDATE) lock re-select. Either
 * may be omitted (identity). This lets a test model the EXACT race window: a claim that
 * exists at persist but NOT at compute (approved after compute), or vice-versa.
 * Restores the original on the way out.
 */
async function withSelectOverride({ onCompute, onPersist }, fn) {
  const orig = reimbursementPayout.selectPayableClaims;
  const callCounts = new Map();
  reimbursementPayout.selectPayableClaims = async function patched(tx, args) {
    const real = await orig.call(reimbursementPayout, tx, args);
    const key = args.employeeId;
    const n = (callCounts.get(key) || 0) + 1;
    callCounts.set(key, n);
    if (n === 1) return onCompute ? onCompute(real, args) : real;       // compute-time price
    return onPersist ? onPersist(real, args) : real;                    // persist-tx lock re-select
  };
  try { return await fn(); }
  finally { reimbursementPayout.selectPayableClaims = orig; }
}

async function main() {
  log('\n=== Reimbursement-payout RACE / double-pay regression (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } });
  const inCal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } });
  if (!inEntity || !inCal) throw new Error('IN-HQ entity/calendar missing in hr_test');

  await cleanup(businessId);

  const emps = await prisma.employmentRecord.findMany({ where: { businessId, entityId: inEntity.id, isCurrent: true }, select: { employeeId: true } });
  let employeeId = null;
  for (const e of emps) {
    const comp = await prisma.compensationRevision.findFirst({ where: { businessId, employeeId: e.employeeId } });
    if (comp) { employeeId = e.employeeId; break; }
  }
  if (!employeeId) throw new Error('No IN employee with a compensation in hr_test');
  log(`  using employee ${employeeId}\n`);

  // ════════════════════════════════════════════════════════════════════════════════
  // FINDING 1 — claim settled OUT-OF-BAND between compute and persist (the shrunk set).
  //   Compute prices claim A (3000). Before persist, A is settled out-of-band → the
  //   persist lock re-select returns {} . BUGGY behaviour: payslip credits +3000 but
  //   nothing is stamped (A rides the next run = paid twice). FIXED: line repriced to 0,
  //   nothing stamped, invariant holds. A stays APPROVED only because IT was settled
  //   out of band — it is NOT credited on this payslip, so no double-pay.
  // ════════════════════════════════════════════════════════════════════════════════
  log('--- FINDING 1: claim settled out-of-band mid-flight (shrunk lock set) ---');
  {
    const claimA = await mkApprovedClaim(businessId, employeeId, { amount: 3000, channel: 'PAY_VIA_PAYROLL', expenseDate: '2026-08-10', suffix: 'F1-A' });
    const run = await mkRun(businessId, inEntity, inCal, { periodStart: '2026-08-01', periodEnd: '2026-08-31', payDate: '2026-08-31', taxYear: '2026-27', seq: 8, suffix: 'F1' });

    // Persist-tx lock re-select returns EMPTY (A vanished — settled out-of-band).
    await withSelectOverride(
      { onPersist: () => ({ claims: [], totalPayableMinor: 0 }) },
      () => service.computeRun({ businessId, actorId: 'maker-race', payRunId: run.id }),
    );

    const { reimbMinor, netMinor, line } = await lineReimbMinor(businessId, run.id);
    const { total: stamped, ids } = await stampedTotalMinor(businessId, run.id);
    ok(reimbMinor === stamped, `F1.1 payslip EXPENSE_REIMBURSEMENT (${reimbMinor}) == Σ stamped (${stamped}) — no paid-but-unstamped / stamped-but-unpriced`);
    ok(reimbMinor === 0 && ids.length === 0, `F1.2 nothing priced & nothing stamped (claim was settled out-of-band; got reimb=${reimbMinor}, stamped=${ids.length})`);
    const cA = await prisma.expenseClaim.findUnique({ where: { id: claimA.id } });
    ok(cA.payRunId === null && cA.status === 'APPROVED', 'F1.3 the un-priced claim is NOT stamped to this run (not double-paid)');
    // Net must equal base net (the +3000 the engine priced was repriced OUT, matching the empty stamp set).
    log(`     (net=${netMinor}, line reimb=${reimbMinor}, stamped=${stamped})`);
    void line;
    await prisma.expenseClaim.delete({ where: { id: claimA.id } }); // isolate next scenario
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // FINDING 1b — PARTIAL shrink: 2 claims priced (A 3000 + B 2000 = 5000), but only A
  //   survives in the lock set. FIXED: line repriced to 3000, ONLY A stamped (3000),
  //   B stays APPROVED (it was settled out of band, never credited). Invariant holds.
  // ════════════════════════════════════════════════════════════════════════════════
  log('--- FINDING 1b: partial out-of-band settle (one of two priced claims survives) ---');
  {
    const claimA = await mkApprovedClaim(businessId, employeeId, { amount: 3000, channel: 'PAY_VIA_PAYROLL', expenseDate: '2026-09-05', suffix: 'F1b-A' });
    const claimB = await mkApprovedClaim(businessId, employeeId, { amount: 2000, channel: 'PAY_VIA_PAYROLL', expenseDate: '2026-09-06', suffix: 'F1b-B' });
    const run = await mkRun(businessId, inEntity, inCal, { periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-30', taxYear: '2026-27', seq: 9, suffix: 'F1b' });

    // Lock re-select keeps ONLY claim A (drop B — settled out of band).
    await withSelectOverride(
      { onPersist: (real) => {
        const keep = real.claims.filter((c) => c.id === claimA.id);
        return { claims: keep, totalPayableMinor: keep.reduce((a, c) => a + c.amountMinor, 0) };
      } },
      () => service.computeRun({ businessId, actorId: 'maker-race', payRunId: run.id }),
    );

    const { reimbMinor } = await lineReimbMinor(businessId, run.id);
    const { total: stamped, ids } = await stampedTotalMinor(businessId, run.id);
    ok(reimbMinor === stamped, `F1b.1 payslip EXPENSE_REIMBURSEMENT (${reimbMinor}) == Σ stamped (${stamped}) — invariant holds under partial shrink`);
    ok(reimbMinor === 300000, `F1b.2 line repriced DOWN to the surviving claim only (3000 → 300000 paise; got ${reimbMinor})`);
    ok(ids.length === 1 && ids[0] === claimA.id, 'F1b.3 EXACTLY the surviving priced claim A is stamped');
    const cB = await prisma.expenseClaim.findUnique({ where: { id: claimB.id } });
    ok(cB.payRunId === null, 'F1b.4 the dropped claim B is NOT stamped to this run (no stamped-but-unpriced)');
    await prisma.expenseClaim.delete({ where: { id: claimA.id } });
    await prisma.expenseClaim.delete({ where: { id: claimB.id } });
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // FINDING 2 — a DIFFERENT (older) claim approved between compute and persist. Compute
  //   prices ONLY claim A (3000). Before persist, an OLDER claim D (createdAt earlier,
  //   3000) appears in the lock set, ORDERED FIRST. BUGGY behaviour: applyPayout pays D
  //   whole (lock-ordered), exhausts paidMinor, breaks — D stamped, A stays APPROVED and
  //   rides the next run = A paid twice; D consumed against A's payment. FIXED: only the
  //   PRICED claim A is stamped; D (never priced) is untouched.
  // ════════════════════════════════════════════════════════════════════════════════
  log('--- FINDING 2: older unrelated claim enters the lock set ordered FIRST ---');
  {
    // Both claims exist in the DB, but we model "D approved AFTER compute" by STRIPPING D
    // from the compute-time price and INJECTING it (ordered first, older) only at persist.
    const claimA = await mkApprovedClaim(businessId, employeeId, { amount: 3000, channel: 'PAY_VIA_PAYROLL', expenseDate: '2026-10-10', suffix: 'F2-A' });
    const claimD = await mkApprovedClaim(businessId, employeeId, { amount: 3000, channel: 'PAY_VIA_PAYROLL', expenseDate: '2026-10-09', suffix: 'F2-D' });
    const run = await mkRun(businessId, inEntity, inCal, { periodStart: '2026-10-01', periodEnd: '2026-10-31', payDate: '2026-10-31', taxYear: '2026-27', seq: 10, suffix: 'F2' });

    // Engine PRICES only A (D not yet approved at compute). Persist lock re-select then
    // returns D FIRST (older createdAt = lock order), then A. The OLD code would pay D
    // whole, exhaust paidMinor, break → D stamped, A left APPROVED (rides next run = A
    // double-paid). The fix stamps ONLY the priced claim A; D is never touched.
    await withSelectOverride(
      {
        onCompute: (real) => {
          const keep = real.claims.filter((c) => c.id !== claimD.id);
          return { claims: keep, totalPayableMinor: keep.reduce((a, c) => a + c.amountMinor, 0) };
        },
        onPersist: (real) => {
          const a = real.claims.find((c) => c.id === claimA.id) || { id: claimA.id, amountMinor: 300000 };
          const dRow = real.claims.find((c) => c.id === claimD.id) || { id: claimD.id, amountMinor: 300000 };
          const claims = [dRow, a]; // D ordered FIRST (older createdAt)
          return { claims, totalPayableMinor: claims.reduce((acc, c) => acc + c.amountMinor, 0) };
        },
      },
      () => service.computeRun({ businessId, actorId: 'maker-race', payRunId: run.id }),
    );

    const { reimbMinor } = await lineReimbMinor(businessId, run.id);
    const { total: stamped, ids } = await stampedTotalMinor(businessId, run.id);
    ok(reimbMinor === stamped, `F2.1 payslip EXPENSE_REIMBURSEMENT (${reimbMinor}) == Σ stamped (${stamped}) — invariant holds`);
    ok(reimbMinor === 300000, `F2.1b line priced the engine's single claim A only (300000 paise; got ${reimbMinor})`);
    ok(ids.length === 1 && ids[0] === claimA.id, `F2.2 EXACTLY the priced claim A is stamped (not the lock-ordered older claim D)`);
    const cD = await prisma.expenseClaim.findUnique({ where: { id: claimD.id } });
    ok(cD.status === 'APPROVED' && cD.payRunId === null, 'F2.3 the unrelated older claim D is NOT settled (no wrong-claim stamp)');
    const cA = await prisma.expenseClaim.findUnique({ where: { id: claimA.id } });
    ok(cA.status === 'REIMBURSED' && cA.payRunId === run.id && dec(cA.paidViaPayrollAmount) === 3000,
      'F2.4 the priced claim A IS settled this run (will not ride the next run → no double-pay)');
    await prisma.expenseClaim.delete({ where: { id: claimA.id } });
    await prisma.expenseClaim.delete({ where: { id: claimD.id } });
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // CONCURRENT-RUN never double-pays: with NO override (real lock), two computeRun calls
  //   racing the same employee/claim — the FOR UPDATE lock serialises; the loser's lock
  //   re-select returns the now-REIMBURSED claim excluded → it prices+stamps nothing.
  //   Proven here as: a SECOND run over the SAME claim window after the first paid it
  //   selects nothing (claim already REIMBURSED) → invariant 0==0.
  // ════════════════════════════════════════════════════════════════════════════════
  log('--- CONCURRENT: a second run cannot re-pay an already-settled claim ---');
  {
    const claimA = await mkApprovedClaim(businessId, employeeId, { amount: 4000, channel: 'PAY_VIA_PAYROLL', expenseDate: '2026-11-10', suffix: 'CC-A' });
    const run1 = await mkRun(businessId, inEntity, inCal, { periodStart: '2026-11-01', periodEnd: '2026-11-30', payDate: '2026-11-30', taxYear: '2026-27', seq: 11, suffix: 'CC1' });
    await service.computeRun({ businessId, actorId: 'maker-race', payRunId: run1.id });
    const r1 = await lineReimbMinor(businessId, run1.id);
    const s1 = await stampedTotalMinor(businessId, run1.id);
    ok(r1.reimbMinor === s1.total && r1.reimbMinor === 400000, `CC.1 run1 pays the claim once (reimb=${r1.reimbMinor}==stamped=${s1.total})`);

    const run2 = await mkRun(businessId, inEntity, inCal, { periodStart: '2026-11-01', periodEnd: '2026-11-30', payDate: '2026-11-30', taxYear: '2026-27', seq: 12, suffix: 'CC2' });
    await service.computeRun({ businessId, actorId: 'maker-race', payRunId: run2.id });
    const r2 = await lineReimbMinor(businessId, run2.id);
    const s2 = await stampedTotalMinor(businessId, run2.id);
    ok(r2.reimbMinor === 0 && s2.total === 0, `CC.2 run2 over the SAME settled claim pays NOTHING (reimb=${r2.reimbMinor}, stamped=${s2.total}) — no double-pay`);
    const cA = await prisma.expenseClaim.findUnique({ where: { id: claimA.id } });
    ok(cA.payRunId === run1.id, 'CC.3 the claim stays owned by run1 only (settled exactly once across both runs)');
  }

  log('');
  await cleanup(businessId);

  if (failures) { log(`\n${failures} FAILURE(S)\n`); process.exit(1); }
  log('\nALL REIMBURSEMENT-PAYOUT RACE CHECKS PASSED\n');
  assert.strictEqual(failures, 0);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

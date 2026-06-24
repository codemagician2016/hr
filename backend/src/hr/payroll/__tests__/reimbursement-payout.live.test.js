'use strict';

/*
 * reimbursement-payout.live.test.js — LIVE (hr_test) proof of Feature 26
 * "reimbursement paid via payroll". Mirrors loan-recovery.live.test.js, but proves a
 * POSITIVE payment instead of a deduction:
 *
 *   1. an APPROVED claim marked PAY_VIA_PAYROLL gets an EXPENSE_REIMBURSEMENT line on
 *      the payslip; the claim is stamped REIMBURSED + payRunId + paidViaPayrollAmount;
 *      NET is INCREASED by the reimbursement; and the reimbursement is NON-TAXABLE —
 *      gross, PF/ESI/PT bases and TDS are BYTE-IDENTICAL to the same run without it.
 *   2. RE-RUNNING the run does NOT double-pay (idempotent: same line, claim stamped once).
 *   3. REOPEN releases the claim back to APPROVED (stamp cleared); a later run re-pays it.
 *   4. CANCEL releases the claim back to APPROVED.
 *   5. a PAY_SEPARATELY claim is NOT picked up (stays APPROVED, no line).
 *   6. the net-floor sanity guard DEFERS a claim that dwarfs net (>10× net): claim stays
 *      APPROVED + un-stamped, REIMBURSEMENT_EXCEEDS_NET_SANITY anomaly surfaces, NO line.
 *
 * Plain-node (built-in assert, NO jest). Run:
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/__tests__/reimbursement-payout.live.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'. Uses the seed 'demo'
 * tenant's IN-HQ entity/calendar/employees. Every row written is torn down at the end.
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const service = require('../service');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'REIMBPAY';

async function cleanup(businessId) {
  const runs = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await prisma.statutoryRemittance.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payslip.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: ids } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: ids } } });
    // Release any claims these runs stamped before deleting the runs.
    await prisma.expenseClaim.updateMany({ where: { payRunId: { in: ids } }, data: { status: 'APPROVED', payRunId: null, paidViaPayrollAmount: null, reimbursedAt: null, reimbursedBy: null } });
    await prisma.payRun.deleteMany({ where: { id: { in: ids } } });
  }
  // Claims created by this test (claimNumber tagged).
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

// Create an APPROVED ExpenseClaim of `amount` (major units), `channel`, expenseDate.
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

async function computeBare(businessId, run) {
  await service.computeRun({ businessId, actorId: 'maker-reimb', payRunId: run.id });
  return prisma.payRunLine.findFirst({
    where: { businessId, payRunId: run.id }, include: { components: true },
  });
}

async function main() {
  log('\n=== Reimbursement-via-payroll proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } });
  const inCal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } });
  if (!inEntity || !inCal) throw new Error('IN-HQ entity/calendar missing in hr_test');

  await cleanup(businessId);

  // Pick the first current IN employee that has a compensation (so the run pays them).
  const emps = await prisma.employmentRecord.findMany({ where: { businessId, entityId: inEntity.id, isCurrent: true }, select: { employeeId: true } });
  let employeeId = null;
  for (const e of emps) {
    const comp = await prisma.compensationRevision.findFirst({ where: { businessId, employeeId: e.employeeId } });
    if (comp) { employeeId = e.employeeId; break; }
  }
  if (!employeeId) throw new Error('No IN employee with a compensation in hr_test');
  log(`  using employee ${employeeId}\n`);

  // ── 0. BASELINE — same run, NO reimbursement, to prove base-invariance later ──────
  const baseRun = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-31', taxYear: '2026-27', seq: 7, suffix: 'IN-JUL-BASE',
  });
  const baseLine = await computeBare(businessId, baseRun);
  ok(!!baseLine, '0.0 baseline payslip line created (no reimbursement)');
  const baseGross = dec(baseLine.grossEarnings);
  const baseNet = dec(baseLine.netPay);
  const baseDed = dec(baseLine.totalDeductions);
  // Statutory rollups frozen on the line for byte-equality comparison.
  const baseRoll = JSON.stringify({
    pf: baseLine.pfEmployee, esi: baseLine.esiEmployee, pt: baseLine.pt,
    tds: baseLine.tds, pfBase: baseLine.pfWagesBase,
  });

  // ── 1. APPROVED + PAY_VIA_PAYROLL claim → REIMBURSEMENT line, stamps, NET up, base-invariant
  const claim = await mkApprovedClaim(businessId, employeeId, {
    amount: 3000, channel: 'PAY_VIA_PAYROLL', expenseDate: '2026-08-10', suffix: 'A',
  });
  const run = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-08-01', periodEnd: '2026-08-31', payDate: '2026-08-31', taxYear: '2026-27', seq: 8, suffix: 'IN-AUG',
  });
  const line = await computeBare(businessId, run);
  ok(!!line, '1.0 payslip line created');
  const reimbComp = (line.components || []).find((c) => c.componentCode === 'EXPENSE_REIMBURSEMENT');
  ok(!!reimbComp, '1.1 payslip has an EXPENSE_REIMBURSEMENT line');
  ok(reimbComp && reimbComp.category === 'REIMBURSEMENT', '1.2 EXPENSE_REIMBURSEMENT is category REIMBURSEMENT (non-taxable)');
  ok(reimbComp && dec(reimbComp.amount) === 3000, `1.3 EXPENSE_REIMBURSEMENT amount = 3000 (got ${reimbComp && reimbComp.amount})`);

  const c1 = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
  ok(c1.status === 'REIMBURSED', '1.4 claim stamped REIMBURSED');
  ok(c1.payRunId === run.id, '1.5 claim.payRunId = this run');
  ok(dec(c1.paidViaPayrollAmount) === 3000, `1.6 claim.paidViaPayrollAmount = 3000 (got ${c1.paidViaPayrollAmount})`);
  ok(!!c1.reimbursedAt, '1.7 claim.reimbursedAt set');

  // NET increased by exactly the reimbursement; gross UNCHANGED (reimbursement not earnings).
  ok(dec(line.grossEarnings) === baseGross, `1.8 GROSS unchanged vs baseline (${baseGross}, got ${line.grossEarnings})`);
  ok(dec(line.netPay) === baseNet + 3000, `1.9 NET = baseline net + 3000 (${baseNet + 3000}, got ${line.netPay})`);
  ok(dec(line.totalDeductions) === baseDed, `1.10 totalDeductions unchanged (reimbursement is post-tax; ${baseDed}, got ${line.totalDeductions})`);
  // THE STATUTORY HEART — PF/ESI/PT/TDS/taxable byte-identical to the no-reimbursement run.
  const roll = JSON.stringify({
    pf: line.pfEmployee, esi: line.esiEmployee, pt: line.pt,
    tds: line.tds, pfBase: line.pfWagesBase,
  });
  ok(roll === baseRoll, `1.11 PF/ESI/PT/TDS/PF-base BYTE-IDENTICAL to no-reimbursement run (base-invariance)`);

  // ── 2. RE-RUN does NOT double-pay (idempotent) ────────────────────────────────
  const line2 = await computeBare(businessId, run);
  const reimbComp2 = (line2.components || []).find((c) => c.componentCode === 'EXPENSE_REIMBURSEMENT');
  ok(reimbComp2 && dec(reimbComp2.amount) === 3000, '2.1 recompute still pays exactly 3000 (not 6000)');
  ok(dec(line2.netPay) === baseNet + 3000, '2.2 recompute net unchanged (no double-pay)');
  const stampedCount = await prisma.expenseClaim.count({ where: { id: claim.id, status: 'REIMBURSED', payRunId: run.id } });
  ok(stampedCount === 1, '2.3 claim stamped REIMBURSED exactly once (idempotent)');

  // ── 3. REOPEN releases the claim back to APPROVED ─────────────────────────────
  await service.reopenRun({ businessId, actorId: 'maker-reimb', payRunId: run.id });
  const c3 = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
  ok(c3.status === 'APPROVED' && c3.payRunId === null && c3.paidViaPayrollAmount === null,
    '3.1 reopen → claim back to APPROVED, payRunId + paidViaPayrollAmount cleared');

  // 3b. A NEW run after reopen re-pays the now-APPROVED claim (auto-carry).
  await service.computeRun({ businessId, actorId: 'maker-reimb', payRunId: run.id });
  const c3b = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
  ok(c3b.status === 'REIMBURSED' && c3b.payRunId === run.id, '3.2 recompute after reopen re-pays the claim (stamped again)');

  // ── 4. CANCEL releases the claim back to APPROVED ─────────────────────────────
  // Move the run to a cancellable state already (it is COMPUTED); cancelRun unwinds.
  await service.cancelRun({ businessId, actorId: 'maker-reimb', payRunId: run.id, reason: 'test' });
  const c4 = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
  ok(c4.status === 'APPROVED' && c4.payRunId === null && c4.paidViaPayrollAmount === null,
    '4.1 cancel → claim released back to APPROVED (stamp cleared)');

  // Isolate scenarios 5/6 from claim A (now back to APPROVED + PAY_VIA_PAYROLL after the
  // cancel above; its expenseDate <= the later periods would otherwise ride those runs and
  // contend for the same EXPENSE_REIMBURSEMENT line). Remove it for a clean slate.
  await prisma.expenseClaim.delete({ where: { id: claim.id } });

  // ── 5. PAY_SEPARATELY claim is NOT picked up ──────────────────────────────────
  const sepClaim = await mkApprovedClaim(businessId, employeeId, {
    amount: 1500, channel: 'PAY_SEPARATELY', expenseDate: '2026-09-10', suffix: 'B',
  });
  const run5 = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-30', taxYear: '2026-27', seq: 9, suffix: 'IN-SEP',
  });
  const line5 = await computeBare(businessId, run5);
  const sepComp = (line5.components || []).find((c) => c.componentCode === 'EXPENSE_REIMBURSEMENT');
  ok(!sepComp, '5.1 PAY_SEPARATELY claim does NOT produce a reimbursement line');
  const sc5 = await prisma.expenseClaim.findUnique({ where: { id: sepClaim.id } });
  ok(sc5.status === 'APPROVED' && sc5.payRunId === null, '5.2 PAY_SEPARATELY claim stays APPROVED, unstamped');

  // ── 6. NET-FLOOR SANITY GUARD defers a claim that dwarfs net (>10× net) ───────
  const hugeClaim = await mkApprovedClaim(businessId, employeeId, {
    amount: 99999999, channel: 'PAY_VIA_PAYROLL', expenseDate: '2026-10-10', suffix: 'C',
  });
  const run6 = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-10-01', periodEnd: '2026-10-31', payDate: '2026-10-31', taxYear: '2026-27', seq: 10, suffix: 'IN-OCT',
  });
  const det6 = await service.computeRun({ businessId, actorId: 'maker-reimb', payRunId: run6.id });
  const line6 = await prisma.payRunLine.findFirst({ where: { businessId, payRunId: run6.id }, include: { components: true } });
  const hugeComp = (line6.components || []).find((c) => c.componentCode === 'EXPENSE_REIMBURSEMENT');
  ok(!hugeComp, '6.1 over-sanity claim is DEFERRED → no reimbursement line on this run');
  const hc6 = await prisma.expenseClaim.findUnique({ where: { id: hugeClaim.id } });
  ok(hc6.status === 'APPROVED' && hc6.payRunId === null && hc6.paidViaPayrollAmount === null,
    '6.2 deferred claim stays APPROVED + un-stamped (carries to next run)');
  const guardAnom = (det6.anomalies || []).some((a) => a.code === 'REIMBURSEMENT_EXCEEDS_NET_SANITY');
  ok(guardAnom, '6.3 REIMBURSEMENT_EXCEEDS_NET_SANITY anomaly surfaced');
  ok(dec(line6.netPay) >= 0, `6.4 net pay positive/zero — deferred reimbursement not in net (net=${line6.netPay})`);

  log('');
  await cleanup(businessId);

  if (failures) { log(`\n${failures} FAILURE(S)\n`); process.exit(1); }
  log('\nALL REIMBURSEMENT-PAYOUT CHECKS PASSED\n');
  assert.strictEqual(failures, 0);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

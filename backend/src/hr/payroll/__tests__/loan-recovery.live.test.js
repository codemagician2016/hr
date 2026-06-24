'use strict';

/*
 * loan-recovery.live.test.js — LIVE (hr_test) proof of "loan/advance recovery in
 * the pay run" (Cycle 0 wiring; FACTOHR-GAP-ANALYSIS §3.2). Proves the feature is
 * now functional END-TO-END:
 *
 *   1. an employee with a PENDING installment DUE in the period gets a LOAN_REPAYMENT
 *      deduction line on the payslip; the installment is stamped PAID + payRunId +
 *      paidAt; Loan.amountRepaid is incremented and outstanding decremented.
 *   2. RE-RUNNING the run does NOT double-deduct (idempotent: same recovery, same
 *      stamps, amountRepaid unchanged).
 *   3. an installment that EXCEEDS available net is CAPPED to net (never negative net)
 *      and the residual DEFERS — the installment stays PENDING (matches the FnF
 *      cap-to-net / partial-defer rule). RECOVERY_CAPPED_TO_NET anomaly surfaces.
 *   4. REOPENING the run UNWINDS the stamps (installment → PENDING, totals reversed).
 *
 * Plain-node (built-in assert, NO jest). Run:
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/__tests__/loan-recovery.live.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'. Uses the seed 'demo'
 * tenant's IN-HQ entity/calendar/employees. Every row written is torn down at the end.
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const service = require('../service');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'LOANREC';

async function cleanup(businessId) {
  const runs = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await prisma.statutoryRemittance.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payslip.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: ids } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: ids } } });
    // Release any installments these runs stamped before deleting the runs.
    await prisma.loanInstallment.updateMany({ where: { payRunId: { in: ids } }, data: { status: 'PENDING', paidAt: null, payRunId: null } });
    await prisma.payRun.deleteMany({ where: { id: { in: ids } } });
  }
  // Loans created by this test (loanNumber tagged).
  const loans = await prisma.loan.findMany({ where: { businessId, loanNumber: { startsWith: PREFIX } }, select: { id: true } });
  const loanIds = loans.map((l) => l.id);
  if (loanIds.length) {
    await prisma.loanInstallment.deleteMany({ where: { loanId: { in: loanIds } } });
    await prisma.loan.deleteMany({ where: { id: { in: loanIds } } });
  }
}

async function mkRun(businessId, entity, cal, { periodStart, periodEnd, payDate, taxYear, seq, suffix }) {
  return prisma.payRun.create({
    data: {
      businessId, entityId: entity.id, payCalendarId: cal.id,
      code: `${PREFIX}-${entity.code}-${suffix}`,
      periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), payDate: new Date(payDate),
      sequenceInYear: seq, taxYear, currencyCode: entity.payCurrency, status: 'DRAFT',
    },
  });
}

// Create an APPROVED/DISBURSED loan with a single installment due `dueDate`, of
// `amount` (major units), for `employeeId`. We bypass the controller schedule
// builder and write exactly one installment so the recovery math is deterministic.
async function mkLoanWithDueInstallment(businessId, employeeId, { amount, dueDate, suffix }) {
  const loan = await prisma.loan.create({
    data: {
      businessId, employeeId, loanNumber: `${PREFIX}-${suffix}`, loanType: 'LOAN',
      principal: String(amount), currencyCode: 'INR', tenureMonths: 1,
      startDate: new Date(dueDate), status: 'DISBURSED',
      totalPayable: String(amount), amountRepaid: '0', outstanding: String(amount),
      disbursedAt: new Date(dueDate),
    },
  });
  const inst = await prisma.loanInstallment.create({
    data: {
      businessId, loanId: loan.id, seq: 1, dueDate: new Date(dueDate),
      principalComponent: String(amount), interestComponent: '0', amount: String(amount),
      status: 'PENDING',
    },
  });
  return { loan, inst };
}

function dec(v) { return Number(v); }

async function main() {
  log('\n=== Loan-recovery in pay run proof (LIVE hr_test) ===\n');
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

  // ── 1. DUE installment → LOAN_REPAYMENT line, stamps, totals ──────────────────
  const { loan, inst } = await mkLoanWithDueInstallment(businessId, employeeId, {
    amount: 5000, dueDate: '2026-07-15', suffix: 'A',
  });
  const run = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-31', taxYear: '2026-27', seq: 7, suffix: 'IN-JUL',
  });
  await service.computeRun({ businessId, actorId: 'maker-loanrec', payRunId: run.id });

  const line = await prisma.payRunLine.findFirst({
    where: { businessId, payRunId: run.id, employeeId },
    include: { components: true },
  });
  ok(!!line, '1.0 payslip line created for the borrower');
  const loanComp = (line.components || []).find((c) => c.componentCode === 'LOAN_REPAYMENT');
  ok(!!loanComp, '1.1 payslip has a LOAN_REPAYMENT deduction line');
  ok(loanComp && loanComp.category === 'DEDUCTION', '1.2 LOAN_REPAYMENT is a DEDUCTION (post-tax)');
  ok(loanComp && dec(loanComp.amount) === 5000, `1.3 LOAN_REPAYMENT amount = 5000 (got ${loanComp && loanComp.amount})`);

  const inst1 = await prisma.loanInstallment.findUnique({ where: { id: inst.id } });
  ok(inst1.status === 'PAID', '1.4 installment stamped PAID');
  ok(inst1.payRunId === run.id, '1.5 installment.payRunId = this run');
  ok(!!inst1.paidAt, '1.6 installment.paidAt set');

  const loan1 = await prisma.loan.findUnique({ where: { id: loan.id } });
  ok(dec(loan1.amountRepaid) === 5000, `1.7 Loan.amountRepaid incremented to 5000 (got ${loan1.amountRepaid})`);
  ok(dec(loan1.outstanding) === 0, `1.8 Loan.outstanding decremented to 0 (got ${loan1.outstanding})`);
  ok(loan1.status === 'CLOSED', '1.9 fully-recovered loan CLOSED');
  ok(dec(line.netPay) > 0, `1.10 net pay still positive after recovery (net=${line.netPay})`);
  // Net = gross − (statutory + LOAN_REPAYMENT); the deduction really reduced net.
  ok(dec(line.totalDeductions) >= 5000, `1.11 totalDeductions include the 5000 recovery (got ${line.totalDeductions})`);

  // ── 2. RE-RUN does NOT double-deduct (idempotent) ────────────────────────────
  await service.computeRun({ businessId, actorId: 'maker-loanrec', payRunId: run.id });
  const line2 = await prisma.payRunLine.findFirst({
    where: { businessId, payRunId: run.id, employeeId }, include: { components: true },
  });
  const loanComp2 = (line2.components || []).find((c) => c.componentCode === 'LOAN_REPAYMENT');
  ok(loanComp2 && dec(loanComp2.amount) === 5000, '2.1 recompute still recovers exactly 5000 (not 10000)');
  const loan2 = await prisma.loan.findUnique({ where: { id: loan.id } });
  ok(dec(loan2.amountRepaid) === 5000, `2.2 amountRepaid still 5000 after recompute (no double-deduct, got ${loan2.amountRepaid})`);
  const stampedCount = await prisma.loanInstallment.count({ where: { loanId: loan.id, status: 'PAID', payRunId: run.id } });
  ok(stampedCount === 1, '2.3 exactly one installment stamped PAID (idempotent)');

  // ── 3. INSTALLMENT EXCEEDING NET → capped to net, residual defers ────────────
  // A huge installment that no payslip net can cover. The engine caps it to the
  // available net (never negative) and the installment stays PENDING (deferred).
  const big = await mkLoanWithDueInstallment(businessId, employeeId, {
    amount: 99999999, dueDate: '2026-08-15', suffix: 'B',
  });
  const run2 = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-08-01', periodEnd: '2026-08-31', payDate: '2026-08-31', taxYear: '2026-27', seq: 8, suffix: 'IN-AUG',
  });
  const aug = await service.computeRun({ businessId, actorId: 'maker-loanrec', payRunId: run2.id });
  const bigLine = await prisma.payRunLine.findFirst({
    where: { businessId, payRunId: run2.id, employeeId }, include: { components: true },
  });
  ok(dec(bigLine.netPay) >= 0, `3.1 net pay never negative even when installment > net (net=${bigLine.netPay})`);
  const bigComp = (bigLine.components || []).find((c) => c.componentCode === 'LOAN_REPAYMENT');
  // The recovered amount equals the pre-recovery net (gross − statutory), i.e. net floored at 0.
  ok(bigComp && dec(bigComp.amount) < 99999999, '3.2 LOAN_REPAYMENT capped below the full installment');
  const bigInst = await prisma.loanInstallment.findUnique({ where: { id: big.inst.id } });
  ok(bigInst.status === 'PENDING', '3.3 over-net installment stays PENDING (deferred, not half-applied)');
  ok(bigInst.payRunId === null, '3.4 deferred installment carries no payRunId stamp');
  const bigLoan = await prisma.loan.findUnique({ where: { id: big.loan.id } });
  ok(dec(bigLoan.amountRepaid) === 0, `3.5 partly/uncovered installment did not move Loan.amountRepaid (got ${bigLoan.amountRepaid})`);
  const cappedAnom = (aug.anomalies || []).some((a) => a.code === 'RECOVERY_CAPPED_TO_NET');
  ok(cappedAnom, '3.6 RECOVERY_CAPPED_TO_NET anomaly surfaced');

  // ── 4. REOPEN unwinds the stamps ─────────────────────────────────────────────
  await service.reopenRun({ businessId, actorId: 'maker-loanrec', payRunId: run.id });
  const inst4 = await prisma.loanInstallment.findUnique({ where: { id: inst.id } });
  ok(inst4.status === 'PENDING' && inst4.payRunId === null, '4.1 reopen → installment back to PENDING, stamp cleared');
  const loan4 = await prisma.loan.findUnique({ where: { id: loan.id } });
  ok(dec(loan4.amountRepaid) === 0, `4.2 reopen → Loan.amountRepaid reversed to 0 (got ${loan4.amountRepaid})`);
  ok(dec(loan4.outstanding) === 5000, `4.3 reopen → Loan.outstanding restored to 5000 (got ${loan4.outstanding})`);
  ok(loan4.status === 'DISBURSED', '4.4 reopen → previously-CLOSED loan re-opened to DISBURSED');

  log('');
  await cleanup(businessId);

  if (failures) { log(`\n${failures} FAILURE(S)\n`); process.exit(1); }
  log('\nALL LOAN-RECOVERY CHECKS PASSED\n');
  assert.strictEqual(failures, 0);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

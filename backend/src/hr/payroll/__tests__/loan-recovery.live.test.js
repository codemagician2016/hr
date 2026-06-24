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
    await prisma.loanInstallment.updateMany({ where: { payRunId: { in: ids } }, data: { status: 'PENDING', paidAt: null, payRunId: null, recoveredAmount: null } });
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

// A loan with N installments, all DUE on `dueDate`, each of `amount` (major units).
// Used to exercise the cap landing MID-installment (first fully covered, second
// partially) — the exact HIGH reconciliation scenario.
async function mkLoanWithInstallments(businessId, employeeId, { amounts, dueDate, suffix }) {
  const total = amounts.reduce((a, b) => a + b, 0);
  const loan = await prisma.loan.create({
    data: {
      businessId, employeeId, loanNumber: `${PREFIX}-${suffix}`, loanType: 'LOAN',
      principal: String(total), currencyCode: 'INR', tenureMonths: amounts.length,
      startDate: new Date(dueDate), status: 'DISBURSED',
      totalPayable: String(total), amountRepaid: '0', outstanding: String(total),
      disbursedAt: new Date(dueDate),
    },
  });
  const insts = [];
  for (let i = 0; i < amounts.length; i++) {
    insts.push(await prisma.loanInstallment.create({
      data: {
        businessId, loanId: loan.id, seq: i + 1, dueDate: new Date(dueDate),
        principalComponent: String(amounts[i]), interestComponent: '0', amount: String(amounts[i]),
        status: 'PENDING',
      },
    }));
  }
  return { loan, insts };
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

  // ── 3. INSTALLMENT EXCEEDING NET → capped to net, RESIDUAL DEFERS, BOOKS RECONCILE
  // A huge installment that no payslip net can cover. The engine caps the deduction to
  // the available net (never negative). The HIGH reconciliation rule: whatever the
  // employee is DEBITED (LOAN_REPAYMENT) must be CREDITED to the loan to the paise —
  // a net-capped installment is PARTIALLY recovered (recoveredAmount = the cap),
  // stays PENDING so the remainder (amount − recoveredAmount) carries to a future run,
  // and is stamped with payRunId so the partial can be unwound exactly on reopen. The
  // old bug debited net but credited the loan 0 → the capped paise vanished.
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
  const debit3 = bigComp ? dec(bigComp.amount) : 0; // what the employee was debited
  const bigInst = await prisma.loanInstallment.findUnique({ where: { id: big.inst.id } });
  ok(bigInst.status === 'PENDING', '3.3 over-net installment stays PENDING (residual defers, not fully PAID)');
  ok(bigInst.payRunId === run2.id, '3.4 partly-recovered installment is OWNED by this run (payRunId stamped, so unwind reverses it exactly)');
  ok(dec(bigInst.recoveredAmount) === debit3, `3.4b installment recoveredAmount == the debit (${debit3}), residual defers (got ${bigInst.recoveredAmount})`);
  const bigLoan = await prisma.loan.findUnique({ where: { id: big.loan.id } });
  // RECONCILIATION: debit == credit == installment recoveredAmount, to the paise.
  ok(dec(bigLoan.amountRepaid) === debit3, `3.5 Loan.amountRepaid credited EXACTLY the capped debit ${debit3} (debit==credit, no paise vanish; got ${bigLoan.amountRepaid})`);
  ok(dec(bigLoan.outstanding) === 99999999 - debit3, `3.5b Loan.outstanding decremented by exactly the recovered figure (got ${bigLoan.outstanding})`);
  ok(bigLoan.status !== 'CLOSED', '3.5c partly-recovered loan NOT closed (residual outstanding remains)');
  const cappedAnom = (aug.anomalies || []).some((a) => a.code === 'RECOVERY_CAPPED_TO_NET');
  ok(cappedAnom, '3.6 RECOVERY_CAPPED_TO_NET anomaly surfaced');

  // ── 3R. REOPEN the capped run → the PARTIAL is reversed EXACTLY (apply/unwind symmetry)
  // The old unwind reversed the nominal installment `amount`, not what apply credited,
  // so a capped/partial recovery drifted the loan totals on every reopen. After the
  // fix, reopening run2 must restore the loan to its PRE-run baseline to the paise.
  await service.reopenRun({ businessId, actorId: 'maker-loanrec', payRunId: run2.id });
  const bigInstR = await prisma.loanInstallment.findUnique({ where: { id: big.inst.id } });
  ok(bigInstR.status === 'PENDING' && bigInstR.payRunId === null && bigInstR.recoveredAmount === null,
    '3R.1 reopen → partly-recovered installment back to clean PENDING (stamp + recoveredAmount cleared)');
  const bigLoanR = await prisma.loan.findUnique({ where: { id: big.loan.id } });
  ok(dec(bigLoanR.amountRepaid) === 0, `3R.2 reopen reversed EXACTLY the partial credit → amountRepaid back to 0 baseline (got ${bigLoanR.amountRepaid})`);
  ok(dec(bigLoanR.outstanding) === 99999999, `3R.3 reopen → outstanding back to full 99999999 baseline, no drift (got ${bigLoanR.outstanding})`);

  // ── 4. REOPEN unwinds the stamps ─────────────────────────────────────────────
  await service.reopenRun({ businessId, actorId: 'maker-loanrec', payRunId: run.id });
  const inst4 = await prisma.loanInstallment.findUnique({ where: { id: inst.id } });
  ok(inst4.status === 'PENDING' && inst4.payRunId === null, '4.1 reopen → installment back to PENDING, stamp cleared');
  const loan4 = await prisma.loan.findUnique({ where: { id: loan.id } });
  ok(dec(loan4.amountRepaid) === 0, `4.2 reopen → Loan.amountRepaid reversed to 0 (got ${loan4.amountRepaid})`);
  ok(dec(loan4.outstanding) === 5000, `4.3 reopen → Loan.outstanding restored to 5000 (got ${loan4.outstanding})`);
  ok(loan4.status === 'DISBURSED', '4.4 reopen → previously-CLOSED loan re-opened to DISBURSED');

  // Isolate scenarios 5/6 from the now-reopened loans above (their PENDING installments
  // are due <= the later periods and would otherwise compete for the same net). Remove
  // the run rows + the prior loans so each new scenario starts from a clean slate.
  for (const r of [run, run2]) {
    await prisma.payslip.deleteMany({ where: { payRunId: r.id } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: r.id } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: r.id } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: r.id } });
    await prisma.loanInstallment.updateMany({ where: { payRunId: r.id }, data: { status: 'PENDING', paidAt: null, payRunId: null, recoveredAmount: null } });
    await prisma.payRun.delete({ where: { id: r.id } });
  }
  for (const l of [loan.id, big.loan.id]) {
    await prisma.loanInstallment.deleteMany({ where: { loanId: l } });
    await prisma.loan.delete({ where: { id: l } });
  }

  // ── 5. CAP LANDS MID-INSTALLMENT → first PAID in full, second PARTIAL, books exact
  // The HIGH bug in its purest form: two due installments whose sum exceeds net. The
  // engine caps the LOAN_REPAYMENT to net; apply must credit that SAME figure across
  // the two — installment #1 fully (PAID), installment #2 partially (PENDING, residual
  // carries) — so debit == Σcredit == ΣrecoveredAmount to the paise. The old code
  // credited only the fully-covered prefix (#1) and dropped the partial → the paise
  // between #1 and the cap vanished.
  const ms = await mkLoanWithInstallments(businessId, employeeId, {
    amounts: [30000, 30000], dueDate: '2026-09-15', suffix: 'C',
  });
  const run3 = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-30', taxYear: '2026-27', seq: 9, suffix: 'IN-SEP',
  });
  await service.computeRun({ businessId, actorId: 'maker-loanrec', payRunId: run3.id });
  const msLine = await prisma.payRunLine.findFirst({
    where: { businessId, payRunId: run3.id, employeeId }, include: { components: true },
  });
  const msComp = (msLine.components || []).find((c) => c.componentCode === 'LOAN_REPAYMENT');
  const debit5 = msComp ? dec(msComp.amount) : 0;
  ok(dec(msLine.netPay) >= 0, `5.0 net never negative (net=${msLine.netPay})`);
  ok(debit5 > 30000 && debit5 < 60000, `5.1 cap lands MID-second-installment: 30000 < debit ${debit5} < 60000`);
  const i1 = await prisma.loanInstallment.findUnique({ where: { id: ms.insts[0].id } });
  const i2 = await prisma.loanInstallment.findUnique({ where: { id: ms.insts[1].id } });
  ok(i1.status === 'PAID' && dec(i1.recoveredAmount) === 30000, `5.2 installment #1 fully PAID, recoveredAmount=30000 (got ${i1.status}/${i1.recoveredAmount})`);
  ok(i2.status === 'PENDING' && dec(i2.recoveredAmount) === debit5 - 30000, `5.3 installment #2 PARTIAL: PENDING, recoveredAmount=${debit5 - 30000} (got ${i2.status}/${i2.recoveredAmount})`);
  ok(i2.payRunId === run3.id, '5.3b partial installment #2 owned by this run (unwindable)');
  const sumRecovered = dec(i1.recoveredAmount) + dec(i2.recoveredAmount);
  ok(sumRecovered === debit5, `5.4 RECONCILE: Σ installment recoveredAmount (${sumRecovered}) == LOAN_REPAYMENT debit (${debit5})`);
  const msLoan = await prisma.loan.findUnique({ where: { id: ms.loan.id } });
  ok(dec(msLoan.amountRepaid) === debit5, `5.5 RECONCILE: Loan.amountRepaid (${msLoan.amountRepaid}) == debit (${debit5}) — debit==credit, no vanish`);
  ok(dec(msLoan.outstanding) === 60000 - debit5, `5.6 outstanding decremented by exactly the recovered figure (got ${msLoan.outstanding})`);

  // 5R — recompute is idempotent on a partial: same debit, same split, no double-credit.
  await service.computeRun({ businessId, actorId: 'maker-loanrec', payRunId: run3.id });
  const msLoan2 = await prisma.loan.findUnique({ where: { id: ms.loan.id } });
  ok(dec(msLoan2.amountRepaid) === debit5, `5R.1 recompute keeps amountRepaid == ${debit5} (idempotent partial, no double-credit; got ${msLoan2.amountRepaid})`);
  const i2b = await prisma.loanInstallment.findUnique({ where: { id: ms.insts[1].id } });
  ok(i2b.status === 'PENDING' && dec(i2b.recoveredAmount) === debit5 - 30000, '5R.2 recompute reproduces the same partial on #2');

  // ── 6. CONCURRENCY → two runs racing on the SAME employee don't double-recover ──
  // Two pay runs cover the same period and the same single PENDING installment. The
  // FOR UPDATE row lock (held inside each persist tx) must serialise them so the
  // installment is recovered by EXACTLY ONE run; the loan is credited ONCE, never twice.
  const cc = await mkLoanWithDueInstallment(businessId, employeeId, {
    amount: 4000, dueDate: '2026-10-15', suffix: 'D',
  });
  const runA = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-10-01', periodEnd: '2026-10-31', payDate: '2026-10-31', taxYear: '2026-27', seq: 10, suffix: 'IN-OCT-A',
  });
  const runB = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-10-01', periodEnd: '2026-10-31', payDate: '2026-10-31', taxYear: '2026-27', seq: 11, suffix: 'IN-OCT-B',
  });
  // Fire both compute runs concurrently. allSettled — one may legitimately recover, the
  // other recovers nothing for the contested installment (it never double-stamps).
  await Promise.allSettled([
    service.computeRun({ businessId, actorId: 'maker-loanrec', payRunId: runA.id }),
    service.computeRun({ businessId, actorId: 'maker-loanrec', payRunId: runB.id }),
  ]);
  const ccInstAll = await prisma.loanInstallment.findMany({ where: { loanId: cc.loan.id } });
  const paidStamps = ccInstAll.filter((i) => i.status === 'PAID');
  ok(paidStamps.length === 1, `6.1 installment recovered by EXACTLY ONE run (no double-recover; got ${paidStamps.length} PAID)`);
  const ccLoan = await prisma.loan.findUnique({ where: { id: cc.loan.id } });
  ok(dec(ccLoan.amountRepaid) === 4000, `6.2 Loan.amountRepaid credited ONCE (4000, not 8000; got ${ccLoan.amountRepaid})`);
  ok(dec(ccLoan.outstanding) === 0, `6.3 Loan.outstanding decremented once to 0 (got ${ccLoan.outstanding})`);
  // The two runs must not have BOTH stamped the same installment with their payRunId.
  const distinctRunStamps = new Set(ccInstAll.filter((i) => i.payRunId).map((i) => i.payRunId));
  ok(distinctRunStamps.size <= 1, `6.4 at most one run owns the installment stamp (got ${distinctRunStamps.size})`);

  log('');
  await cleanup(businessId);

  if (failures) { log(`\n${failures} FAILURE(S)\n`); process.exit(1); }
  log('\nALL LOAN-RECOVERY CHECKS PASSED\n');
  assert.strictEqual(failures, 0);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

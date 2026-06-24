'use strict';

/**
 * arrearsPass.js — the RUN-PASS half of auto-arrears (Feature 27). It MIRRORS
 * controllers/loanRecovery.js / reimbursementPayout.js's stamp/unwind discipline,
 * but at the CYCLE granularity (an arrear is paid as a whole approved ArrearCycle,
 * not per-installment/claim).
 *
 * The arrear MONEY already flows through the payroll engine as the ARREAR_EARNINGS
 * line + the precomputed statutory passthroughs (service.js buildEmployeePayInput,
 * INJECT mode) — this module owns ONLY the ArrearCycle lifecycle flag so the run is
 * idempotent:
 *   - stampArrearCyclesPaidForRun : the run's APPROVED+INJECT cycles bound to this
 *     run → PAID (after the engine paid them). Re-running the run never double-pays.
 *   - unwindArrearStampsForRun    : the run's PAID cycles bound to this run → back to
 *     APPROVED (a recompute/reopen re-stamps them; a CANCEL fully releases them in
 *     arrears.service). Reverses EXACTLY what this run stamped, like loan/reimburse.
 *
 * Kept OUT of arrears.service.js (and required by service.js instead) to avoid a
 * circular require — arrears.service.js requires service.js for resolveCurrentCompensation.
 *
 * MONEY RECONCILIATION: there is no money written here — the paise live on the
 * payslip (ARREAR_EARNINGS + EPF_ARREAR/ESI_ARREAR + EPF_ER_ARREAR/ESI_ER_ARREAR)
 * and the frozen ArrearCycle totals. This pass only moves the lifecycle flag.
 */

/**
 * stampArrearCyclesPaidForRun(tx, { businessId, payRunId, paidAt })
 *   APPROVED + INJECT cycles bound to THIS run → PAID. Idempotent: a conditional
 *   updateMany on {status:'APPROVED', targetMode:'INJECT', payRunId} only ever flips
 *   the run's own APPROVED cycles (the unwind below resets them before a recompute).
 */
async function stampArrearCyclesPaidForRun(tx, { businessId, payRunId, paidAt }) {
  const res = await tx.arrearCycle.updateMany({
    where: { businessId, payRunId, status: 'APPROVED', targetMode: 'INJECT', deletedAt: null },
    data: { status: 'PAID', version: { increment: 1 } },
  });
  return { stamped: res.count, paidAt: paidAt || null };
}

/**
 * unwindArrearStampsForRun(tx, { businessId, payRunId })
 *   PAID + INJECT cycles bound to THIS run → APPROVED (so a recompute re-stamps them
 *   exactly once). We keep payRunId + targetMode set — the cycle stays bound to this
 *   run; only the PAID flag is reverted. A full release (payRunId=null, targetMode=null,
 *   status→COMPUTED) is the CANCEL path, handled in arrears.service.cancelArrearCycle.
 */
async function unwindArrearStampsForRun(tx, { businessId, payRunId }) {
  const res = await tx.arrearCycle.updateMany({
    where: { businessId, payRunId, status: 'PAID', targetMode: 'INJECT', deletedAt: null },
    data: { status: 'APPROVED', version: { increment: 1 } },
  });
  return { unwound: res.count };
}

/**
 * releaseArrearCyclesForRun(tx, { businessId, payRunId })
 *   FULL release for a CANCELLED run: any cycle bound to this run (PAID or APPROVED,
 *   INJECT mode) → COMPUTED + un-bound (payRunId=null, targetMode=null), so a LATER run
 *   can re-approve + pay the arrear. Mirrors loanRecovery/reimbursement releasing their
 *   stamps on cancel so the obligation isn't stranded on a dead run.
 */
async function releaseArrearCyclesForRun(tx, { businessId, payRunId }) {
  const res = await tx.arrearCycle.updateMany({
    where: { businessId, payRunId, targetMode: 'INJECT', status: { in: ['APPROVED', 'PAID'] }, deletedAt: null },
    data: { status: 'COMPUTED', payRunId: null, payRunInputItemId: null, targetMode: null, approvedAt: null, approvedBy: null, version: { increment: 1 } },
  });
  return { released: res.count };
}

module.exports = {
  stampArrearCyclesPaidForRun,
  unwindArrearStampsForRun,
  releaseArrearCyclesForRun,
};

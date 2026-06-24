'use strict';

/**
 * loanRecovery.js — the LOANS-MODULE half of "loan recovery in the pay run"
 * (Cycle 0 wiring; FACTOHR-GAP-ANALYSIS §3.2). It OWNS the LoanInstallment /
 * Loan running-total bookkeeping so the payroll run never forks the loan math:
 * payroll asks "how much is due for this employee this period?" (selectDueMinor)
 * and, after the engine has applied its net-floor cap, tells us "you actually
 * recovered N — stamp it" (applyRecovery). The reverse (unwind) lets a recompute /
 * reopen / cancel cleanly back the stamps out so the whole thing is idempotent.
 *
 * Discipline reused from the offboarding/FnF loan-recovery path
 * (lifecycle/controllers/offboarding.controller.js resolveLoanOutstanding):
 *   - only ACTIVE loans recover: status ∈ { DISBURSED, APPROVED }, deletedAt null;
 *   - outstanding = (loan.outstanding ?? principal − amountRepaid), clamped ≥ 0;
 *   - money is Prisma Decimal(15,2) — we move through INTEGER MINOR UNITS (paise)
 *     for the running arithmetic and only stringify back to Decimal on write, so
 *     the schedule reconciles to the cent and never drifts on a float.
 *
 * The NET-FLOOR guard ("never deduct beyond net") is NOT here: it lives in the
 * payroll ENGINE (engine.js CALC.BALANCE_RECOVERY → RECOVERY_CAPPED_TO_NET). The
 * engine caps the deduction to the employee's available net and hands the ACTUAL
 * recovered figure back; applyRecovery only ever stamps what the engine recovered,
 * so a capped/partial installment defers cleanly (mirrors the FnF cap-to-net rule).
 *
 * EVERYTHING here takes a tx client and does ZERO of its own transaction
 * management — the caller (payroll persistComputedRun) runs select → engine →
 * apply INSIDE one run transaction so a later throw rolls back the stamps too.
 */

const money = require('../payroll/money');

// Active loans that recover through payroll: disbursed (live) or approved (a
// scheduled-but-not-yet-disbursed advance still has a due schedule). Mirrors the
// FnF resolveLoanOutstanding status set exactly so the two paths agree on which
// loans are "live".
const RECOVERABLE_LOAN_STATUS = ['DISBURSED', 'APPROVED'];

function toMinor(decimalish) {
  // Prisma Decimal serialises to a string; Number()→toMinor handles both. A null
  // outstanding is treated as "unknown" by the caller, never as 0 here.
  if (decimalish == null) return 0;
  return money.toMinor(String(decimalish));
}
function decStr(minor) {
  return money.fromMinor(minor, 2);
}

/**
 * selectDuePending — installments DUE in (or before) the pay period for an
 * employee's active loans, oldest-first (dueDate, then seq). "Due in the period"
 * means dueDate <= periodEnd: a missed earlier installment (dueDate before this
 * period) is still recovered now, never skipped. Returns the rows + the total
 * minor the run should attempt to deduct.
 *
 * Selection set: PENDING installments owned by NO run, PLUS any already stamped by
 * THIS run (currentPayRunId). The latter matters for an IDEMPOTENT RECOMPUTE: the
 * default compute path runs selection BEFORE the persist tx that unwinds prior
 * stamps, so a recompute would otherwise see this run's own installments as PAID
 * and silently drop the deduction (changing net + inputHash). Re-including them
 * makes the second compute reproduce the first; persistComputedRun then unwinds +
 * re-stamps. Installments stamped by ANOTHER run are never re-grabbed.
 *
 * @returns {{ installments: Array, totalDueMinor: number }}
 */
async function selectDuePending(tx, { businessId, employeeId, periodEnd, currentPayRunId = null }) {
  const due = await tx.loanInstallment.findMany({
    where: {
      businessId,
      dueDate: { lte: periodEnd },
      // PENDING + un-stamped, OR already owned by THIS run (recompute idempotency).
      OR: currentPayRunId
        ? [
          { status: 'PENDING', payRunId: null },
          { payRunId: currentPayRunId },
        ]
        : [{ status: 'PENDING', payRunId: null }],
      loan: {
        businessId,
        employeeId,
        deletedAt: null,
        status: { in: RECOVERABLE_LOAN_STATUS },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { seq: 'asc' }],
    include: { loan: { select: { id: true, outstanding: true, principal: true, amountRepaid: true, status: true } } },
  });

  // On a recompute, the loan's outstanding/amountRepaid still reflect THIS run's
  // prior (not-yet-unwound) stamps. Add that back per loan so the clamp measures the
  // PRE-run outstanding and the gross due reproduces the first compute exactly.
  const priorByLoan = new Map();
  if (currentPayRunId) {
    for (const inst of due) {
      if (inst.payRunId === currentPayRunId) {
        priorByLoan.set(inst.loan.id, (priorByLoan.get(inst.loan.id) || 0) + toMinor(inst.amount));
      }
    }
  }

  // Defensive clamp: never let the run try to recover more than a loan's actual
  // outstanding (a stale schedule must not over-recover). Caps each installment's
  // contribution to its loan's remaining outstanding (FnF resolveLoanOutstanding
  // semantics: outstanding ?? principal − repaid, floored at 0), pre-this-run.
  const remainingByLoan = new Map();
  const installments = [];
  let totalDueMinor = 0;
  for (const inst of due) {
    const loanId = inst.loan.id;
    if (!remainingByLoan.has(loanId)) {
      const out = inst.loan.outstanding != null
        ? toMinor(inst.loan.outstanding)
        : Math.max(0, toMinor(inst.loan.principal) - toMinor(inst.loan.amountRepaid));
      remainingByLoan.set(loanId, Math.max(0, out) + (priorByLoan.get(loanId) || 0));
    }
    const loanRemaining = remainingByLoan.get(loanId);
    if (loanRemaining <= 0) continue; // loan already fully recovered elsewhere
    const instMinor = toMinor(inst.amount);
    const recoverable = Math.min(instMinor, loanRemaining);
    if (recoverable <= 0) continue;
    remainingByLoan.set(loanId, loanRemaining - recoverable);
    installments.push({ ...inst, _recoverableMinor: recoverable });
    totalDueMinor += recoverable;
  }
  return { installments, totalDueMinor };
}

/**
 * applyRecovery — stamp `recoveredMinor` (the amount the engine ACTUALLY deducted
 * after its net-floor cap) across the supplied due installments, oldest-first.
 * Per installment: pay it fully if the remaining recovery covers it (→ status PAID,
 * paidAt + payRunId stamped); if only part is left it stays PENDING and the residual
 * carries forward to a future run (FnF "partial/defer" behaviour) — we DON'T split a
 * PENDING row, we simply stop once recovery is exhausted, so the next run re-selects
 * the still-PENDING installment. For each loan touched, increments Loan.amountRepaid
 * and decrements outstanding by the recovered amount; a loan that reaches zero
 * outstanding is CLOSED.
 *
 * Idempotent by construction: the caller unwinds (see unwindForRun) any prior stamps
 * for this payRunId BEFORE re-selecting + re-applying, so re-running the same run
 * never double-deducts.
 *
 * @returns {{ recoveredMinor, paidInstallmentIds: string[], loanUpdates: object[] }}
 */
async function applyRecovery(tx, { businessId, payRunId, paidAt, installments, recoveredMinor }) {
  let remaining = Math.max(0, Math.round(recoveredMinor || 0));
  const paidInstallmentIds = [];
  const perLoanRecoveredMinor = new Map();

  for (const inst of installments) {
    if (remaining <= 0) break;
    const instMinor = Math.round(inst._recoverableMinor != null ? inst._recoverableMinor : toMinor(inst.amount));
    if (instMinor <= 0) continue;
    // Only FULLY-covered installments are stamped PAID. A partly-covered trailing
    // installment is left PENDING (defer) — matches the FnF cap-to-net rule where a
    // shortfall is carried, not half-applied.
    if (instMinor > remaining) break;
    await tx.loanInstallment.update({
      where: { id: inst.id },
      data: { status: 'PAID', paidAt, payRunId },
    });
    paidInstallmentIds.push(inst.id);
    remaining -= instMinor;
    const loanId = inst.loan.id;
    perLoanRecoveredMinor.set(loanId, (perLoanRecoveredMinor.get(loanId) || 0) + instMinor);
  }

  // Roll each touched loan's running totals forward by the amount recovered on it.
  const loanUpdates = [];
  for (const [loanId, recMinor] of perLoanRecoveredMinor.entries()) {
    const loan = await tx.loan.findUnique({
      where: { id: loanId },
      select: { id: true, principal: true, amountRepaid: true, outstanding: true, totalPayable: true, status: true },
    });
    if (!loan) continue;
    const repaidMinor = toMinor(loan.amountRepaid) + recMinor;
    const baseOutMinor = loan.outstanding != null
      ? toMinor(loan.outstanding)
      : Math.max(0, toMinor(loan.totalPayable != null ? loan.totalPayable : loan.principal) - toMinor(loan.amountRepaid));
    const outMinor = Math.max(0, baseOutMinor - recMinor);
    const data = {
      amountRepaid: decStr(repaidMinor),
      outstanding: decStr(outMinor),
    };
    // Fully recovered → CLOSED (mirrors loans.controller.close()). Only a DISBURSED
    // loan closes; an APPROVED-but-undisbursed one stays put (it has no live money).
    if (outMinor <= 0 && loan.status === 'DISBURSED') {
      data.status = 'CLOSED';
      data.closedAt = paidAt;
    }
    await tx.loan.update({ where: { id: loanId }, data });
    loanUpdates.push({ loanId, recoveredMinor: recMinor, outstandingMinor: outMinor, closed: data.status === 'CLOSED' });
  }

  return { recoveredMinor: Math.max(0, Math.round(recoveredMinor || 0)) - remaining, paidInstallmentIds, loanUpdates };
}

/**
 * unwindForRun — back out every loan stamp this payRunId previously wrote, so a
 * recompute / reopen / cancel restores the pre-run state and a fresh apply can run
 * cleanly. For each installment stamped with this payRunId: reverse its amount off
 * the owning Loan (amountRepaid −=, outstanding +=, re-open a CLOSED loan back to
 * DISBURSED) and reset the installment to PENDING (clear paidAt + payRunId).
 *
 * Pure-DB, takes a tx, no transaction management of its own. Returns the count of
 * installments unwound (0 = nothing to do — the common first-compute case).
 */
async function unwindForRun(tx, { businessId, payRunId }) {
  const stamped = await tx.loanInstallment.findMany({
    where: { businessId, payRunId },
    select: { id: true, amount: true, loanId: true },
  });
  if (stamped.length === 0) return { unwound: 0, loanIds: [] };

  const reverseByLoan = new Map();
  for (const inst of stamped) {
    reverseByLoan.set(inst.loanId, (reverseByLoan.get(inst.loanId) || 0) + toMinor(inst.amount));
  }

  for (const [loanId, revMinor] of reverseByLoan.entries()) {
    const loan = await tx.loan.findUnique({
      where: { id: loanId },
      select: { id: true, amountRepaid: true, outstanding: true, totalPayable: true, principal: true, status: true },
    });
    if (!loan) continue;
    const repaidMinor = Math.max(0, toMinor(loan.amountRepaid) - revMinor);
    const totalMinor = toMinor(loan.totalPayable != null ? loan.totalPayable : loan.principal);
    const outMinor = loan.outstanding != null
      ? toMinor(loan.outstanding) + revMinor
      : Math.max(0, totalMinor - repaidMinor);
    const data = { amountRepaid: decStr(repaidMinor), outstanding: decStr(outMinor) };
    // A loan we CLOSED via recovery re-opens to DISBURSED on unwind (it has live
    // outstanding again). We never touch a manually-closed loan we didn't stamp.
    if (loan.status === 'CLOSED' && outMinor > 0) {
      data.status = 'DISBURSED';
      data.closedAt = null;
    }
    await tx.loan.update({ where: { id: loanId }, data });
  }

  await tx.loanInstallment.updateMany({
    where: { businessId, payRunId },
    data: { status: 'PENDING', paidAt: null, payRunId: null },
  });

  return { unwound: stamped.length, loanIds: [...reverseByLoan.keys()] };
}

module.exports = {
  RECOVERABLE_LOAN_STATUS,
  selectDuePending,
  applyRecovery,
  unwindForRun,
  _internals: { toMinor, decStr },
};

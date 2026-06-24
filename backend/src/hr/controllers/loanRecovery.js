'use strict';

/**
 * loanRecovery.js — the LOANS-MODULE half of "loan recovery in the pay run"
 * (Cycle 0 wiring; FACTOHR-GAP-ANALYSIS §3.2). It OWNS the LoanInstallment /
 * Loan running-total bookkeeping so the payroll run never forks the loan math:
 * payroll asks "how much is due for this employee this period?" (selectDuePending)
 * and, after the engine has applied its net-floor cap, tells us "you actually
 * recovered N — stamp it" (applyRecovery). The reverse (unwind) lets a recompute /
 * reopen / cancel cleanly back the stamps out so the whole thing is idempotent.
 *
 * MONEY RECONCILIATION (the load-bearing invariant):
 *   For every installment the run touches, ONE figure — the engine-recovered paise —
 *   is the debit on the employee's payslip (LOAN_REPAYMENT), the credit to the loan
 *   (Loan.amountRepaid +=, outstanding −=) AND the installment's `recoveredAmount`.
 *   Debit == credit == installment-paid, to the paise. A NET-CAPPED recovery that
 *   lands MID-installment credits the trailing installment PARTIALLY (recoveredAmount
 *   < amount, row stays PENDING) so the books still reconcile and the remainder
 *   (amount − recoveredAmount) carries to a future run — we never debit net beyond
 *   what we credit the loan, and never credit the loan beyond what we debited net.
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
 * recovered figure back; applyRecovery only ever stamps what the engine recovered.
 *
 * CONCURRENCY: selectDuePending takes a row lock (SELECT … FOR UPDATE SKIP LOCKED)
 * on the candidate installments inside the run transaction, so two pay runs that
 * race on the same employee cannot both grab the same PENDING installment and
 * double-recover. The loser blocks on / skips the locked rows and re-reads them
 * (now stamped) on its next select.
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
// The paise already recovered against an installment by a PRIOR/OWNING run.
// recoveredAmount is the source of truth; fall back to amount for a row stamped PAID
// before this column existed (legacy rows have recoveredAmount null but status PAID).
function recoveredMinorOf(inst) {
  if (inst.recoveredAmount != null) return Math.max(0, toMinor(inst.recoveredAmount));
  if (inst.status === 'PAID') return toMinor(inst.amount);
  return 0;
}

/**
 * selectDuePending — installments DUE in (or before) the pay period for an
 * employee's active loans, oldest-first (dueDate, then seq). "Due in the period"
 * means dueDate <= periodEnd: a missed earlier installment (dueDate before this
 * period) is still recovered now, never skipped. Returns the rows + the total
 * minor the run should attempt to deduct.
 *
 * Selection set: every NOT-fully-PAID installment with REMAINING (= amount −
 * recoveredAmount) > 0 — fresh PENDING rows, partly-recovered PENDING rows left by
 * an EARLIER run (recover their remainder), PLUS any already stamped by THIS run
 * (currentPayRunId). Re-including this run's own stamps matters for an IDEMPOTENT
 * RECOMPUTE: the default compute path runs selection BEFORE the persist tx that
 * unwinds prior stamps, so a recompute would otherwise see this run's own
 * installments as PAID/partial and silently drop the deduction (changing net +
 * inputHash). Re-including them — and adding their prior recoveredAmount back to the
 * loan's pre-run outstanding below — makes the second compute reproduce the first;
 * persistComputedRun then unwinds + re-stamps. A row stamped by ANOTHER live run is
 * never grabbed: the FOR UPDATE row lock serialises concurrent runs (the loser
 * re-reads the now-PAID row and skips it), so an installment can't be recovered by
 * two runs.
 *
 * @returns {{ installments: Array, totalDueMinor: number }}
 */
async function selectDuePending(tx, { businessId, employeeId, periodEnd, currentPayRunId = null }) {
  // 1) ROW LOCK the candidate rows (FOR UPDATE) so a concurrent run on the same
  // employee can't select the same installment. SKIP LOCKED lets a parallel run on a
  // DIFFERENT employee proceed without blocking; a true racer on the SAME row blocks
  // until our tx commits, then re-reads it stamped and skips it. We lock by the same
  // predicate the findMany below uses (NOT fully PAID + due + active loan) and join
  // through Loan for the tenant/employee/status scope.
  //
  // $queryRaw is the only way to FOR UPDATE in Prisma; we lock IDs here, then hydrate
  // with findMany so the include/shape stays identical to the rest of the codebase.
  // The "owned by this run" branch (payRunId = currentPayRunId) is inlined per-arm
  // because Prisma tagged-template fragments can't be spliced into one query.
  const lockedIds = currentPayRunId
    ? await tx.$queryRaw`
        SELECT i."id"
        FROM "LoanInstallment" i
        JOIN "Loan" l ON l."id" = i."loanId"
        WHERE i."businessId" = ${businessId}
          AND i."dueDate" <= ${periodEnd}::date
          AND i."status" <> 'PAID'
          AND (i."payRunId" IS NULL OR i."payRunId" = ${currentPayRunId})
          AND l."businessId" = ${businessId}
          AND l."employeeId" = ${employeeId}
          AND l."deletedAt" IS NULL
          AND l."status" IN ('DISBURSED','APPROVED')
        ORDER BY i."dueDate" ASC, i."seq" ASC
        FOR UPDATE OF i SKIP LOCKED`
    : await tx.$queryRaw`
        SELECT i."id"
        FROM "LoanInstallment" i
        JOIN "Loan" l ON l."id" = i."loanId"
        WHERE i."businessId" = ${businessId}
          AND i."dueDate" <= ${periodEnd}::date
          AND i."status" <> 'PAID'
          AND i."payRunId" IS NULL
          AND l."businessId" = ${businessId}
          AND l."employeeId" = ${employeeId}
          AND l."deletedAt" IS NULL
          AND l."status" IN ('DISBURSED','APPROVED')
        ORDER BY i."dueDate" ASC, i."seq" ASC
        FOR UPDATE OF i SKIP LOCKED`;
  const lockedIdSet = lockedIds.map((r) => r.id);
  if (lockedIdSet.length === 0) return { installments: [], totalDueMinor: 0 };

  // 2) Hydrate the locked rows with the loan totals (same tenant scope as the lock).
  const due = await tx.loanInstallment.findMany({
    where: {
      id: { in: lockedIdSet },
      businessId,
      loan: {
        businessId,
        employeeId,
        deletedAt: null,
        status: { in: RECOVERABLE_LOAN_STATUS },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { seq: 'asc' }],
    include: { loan: { select: { id: true, outstanding: true, principal: true, amountRepaid: true, totalPayable: true, status: true } } },
  });

  // On a recompute, the loan's outstanding/amountRepaid still reflect THIS run's
  // prior (not-yet-unwound) recoveries. Add that back per loan so the clamp measures
  // the PRE-run outstanding and the gross due reproduces the first compute exactly.
  // We add back ONLY what THIS run recovered (its recoveredAmount), never an earlier
  // run's committed recovery — that is genuinely repaid and must stay out.
  const priorByLoan = new Map();
  if (currentPayRunId) {
    for (const inst of due) {
      if (inst.payRunId === currentPayRunId) {
        priorByLoan.set(inst.loan.id, (priorByLoan.get(inst.loan.id) || 0) + recoveredMinorOf(inst));
      }
    }
  }

  // Defensive clamp: never let the run try to recover more than a loan's actual
  // outstanding (a stale schedule must not over-recover). Caps each installment's
  // contribution to (a) its OWN remaining = amount − recoveredAmount, and (b) its
  // loan's remaining outstanding (FnF resolveLoanOutstanding: outstanding ?? totalPayable
  // − repaid, floored at 0), pre-this-run.
  const remainingByLoan = new Map();
  const installments = [];
  let totalDueMinor = 0;
  for (const inst of due) {
    const loanId = inst.loan.id;
    if (!remainingByLoan.has(loanId)) {
      const out = inst.loan.outstanding != null
        ? toMinor(inst.loan.outstanding)
        : Math.max(0, toMinor(inst.loan.totalPayable != null ? inst.loan.totalPayable : inst.loan.principal) - toMinor(inst.loan.amountRepaid));
      remainingByLoan.set(loanId, Math.max(0, out) + (priorByLoan.get(loanId) || 0));
    }
    const loanRemaining = remainingByLoan.get(loanId);
    if (loanRemaining <= 0) continue; // loan already fully recovered elsewhere
    // Per-installment remaining: a partly-recovered row owes only amount − recovered.
    // For THIS run's own prior stamp we measure against the FULL amount (its prior
    // recoveredAmount was added back to loanRemaining above and will be unwound), so a
    // recompute reproduces the original gross. For an EARLIER run's partial, only the
    // remainder is owed.
    const instMinor = toMinor(inst.amount);
    const priorOnThisInst = (currentPayRunId && inst.payRunId === currentPayRunId)
      ? recoveredMinorOf(inst)
      : 0;
    const instRemaining = Math.max(0, instMinor - (recoveredMinorOf(inst) - priorOnThisInst));
    if (instRemaining <= 0) continue;
    const recoverable = Math.min(instRemaining, loanRemaining);
    if (recoverable <= 0) continue;
    remainingByLoan.set(loanId, loanRemaining - recoverable);
    installments.push({ ...inst, _recoverableMinor: recoverable, _priorRecoveredMinor: recoveredMinorOf(inst) });
    totalDueMinor += recoverable;
  }
  return { installments, totalDueMinor };
}

/**
 * applyRecovery — credit `recoveredMinor` (the amount the engine ACTUALLY deducted
 * after its net-floor cap) across the supplied due installments, oldest-first, so
 * the loan is credited EXACTLY what the employee was debited (debit == credit).
 *
 * Per installment: take min(installment-remaining, recovery-left). If that fully
 * covers the installment's remaining → status PAID, recoveredAmount = amount, paidAt
 * + payRunId stamped. If it covers only part (the trailing, net-capped installment)
 * → the row STAYS PENDING with recoveredAmount bumped by the partial and payRunId
 * stamped, so (a) the loan is still credited the partial (books reconcile) and (b)
 * the remainder (amount − recoveredAmount) carries to a future run. For each loan
 * touched, increments Loan.amountRepaid and decrements outstanding by the recovered
 * amount; a loan that reaches zero outstanding is CLOSED.
 *
 * Idempotent by construction: the caller unwinds (see unwindForRun) any prior stamps
 * for this payRunId BEFORE re-selecting + re-applying, so re-running the same run
 * never double-deducts.
 *
 * @returns {{ recoveredMinor, paidInstallmentIds: string[], loanUpdates: object[] }}
 */
async function applyRecovery(tx, { businessId, payRunId, paidAt, installments, recoveredMinor }) {
  let remaining = Math.max(0, Math.round(recoveredMinor || 0));
  const requested = remaining;
  const paidInstallmentIds = [];
  const perLoanRecoveredMinor = new Map();

  for (const inst of installments) {
    if (remaining <= 0) break;
    // What this installment can still take in THIS run = its run-selectable remaining
    // (_recoverableMinor, already clamped to amount-remaining and loan-outstanding).
    const selectable = Math.round(inst._recoverableMinor != null ? inst._recoverableMinor : toMinor(inst.amount));
    if (selectable <= 0) continue;
    const credit = Math.min(selectable, remaining);
    if (credit <= 0) continue;

    const instMinor = toMinor(inst.amount);
    const priorRecovered = Math.round(inst._priorRecoveredMinor != null ? inst._priorRecoveredMinor : 0);
    const newRecovered = priorRecovered + credit;
    const fullyCovered = newRecovered >= instMinor;

    await tx.loanInstallment.update({
      where: { id: inst.id },
      data: fullyCovered
        ? { status: 'PAID', paidAt, payRunId, recoveredAmount: decStr(instMinor) }
        // Partial: stays PENDING but OWNED by this run (payRunId) with its running
        // recoveredAmount, so the remainder defers and unwind can reverse exactly it.
        : { status: 'PENDING', paidAt: null, payRunId, recoveredAmount: decStr(newRecovered) },
    });
    // If we fully covered but prior+credit overshot the nominal (can't happen given the
    // clamps, but be exact), the loan is only ever credited `credit` this run.
    paidInstallmentIds.push(inst.id);
    remaining -= credit;
    const loanId = inst.loan.id;
    perLoanRecoveredMinor.set(loanId, (perLoanRecoveredMinor.get(loanId) || 0) + credit);
    if (!fullyCovered) break; // a partial is always the trailing installment — stop.
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

  // recoveredMinor returned = what we actually credited (requested − remaining). With
  // the partial-credit path this equals `requested` whenever there is any selectable
  // installment, so debit == credit to the paise.
  return { recoveredMinor: requested - remaining, paidInstallmentIds, loanUpdates };
}

/**
 * unwindForRun — back out every loan recovery this payRunId previously wrote, so a
 * recompute / reopen / cancel restores the pre-run state and a fresh apply can run
 * cleanly. For each installment stamped with this payRunId: reverse the EXACT paise
 * this run credited (its recoveredAmount — NOT the nominal `amount`, which drifted
 * totals on every reopen for a capped/partial recovery) off the owning Loan
 * (amountRepaid −=, outstanding +=, re-open a CLOSED loan back to DISBURSED) and
 * reset the installment to PENDING (clear paidAt + payRunId + recoveredAmount).
 *
 * Pure-DB, takes a tx, no transaction management of its own. Returns the count of
 * installments unwound (0 = nothing to do — the common first-compute case).
 */
async function unwindForRun(tx, { businessId, payRunId }) {
  const stamped = await tx.loanInstallment.findMany({
    where: { businessId, payRunId },
    select: { id: true, amount: true, recoveredAmount: true, status: true, loanId: true },
  });
  if (stamped.length === 0) return { unwound: 0, loanIds: [] };

  // Reverse EXACTLY what apply credited per loan: Σ recoveredAmount (falling back to
  // `amount` only for a legacy PAID row written before recoveredAmount existed).
  const reverseByLoan = new Map();
  for (const inst of stamped) {
    reverseByLoan.set(inst.loanId, (reverseByLoan.get(inst.loanId) || 0) + recoveredMinorOf(inst));
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
    data: { status: 'PENDING', paidAt: null, payRunId: null, recoveredAmount: null },
  });

  return { unwound: stamped.length, loanIds: [...reverseByLoan.keys()] };
}

module.exports = {
  RECOVERABLE_LOAN_STATUS,
  selectDuePending,
  applyRecovery,
  unwindForRun,
  _internals: { toMinor, decStr, recoveredMinorOf },
};

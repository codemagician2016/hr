'use strict';

/**
 * reimbursementPayout.js — the EXPENSE-MODULE half of "reimbursement paid via
 * payroll" (Feature 26). It MIRRORS controllers/loanRecovery.js, but as a POSITIVE
 * payment instead of a deduction: where loan recovery selects DUE installments,
 * caps them to net and DEBITS the payslip, this pass selects APPROVED claims marked
 * PAY_VIA_PAYROLL and ADDS the approved amount to net as a non-taxable, post-tax
 * reimbursement line — settling the claim through the monthly payslip.
 *
 * It OWNS the ExpenseClaim bookkeeping so payroll never forks the claim math:
 * payroll asks "which approved claims should this run pay this employee?"
 * (selectPayableClaims) and, after the engine has reported the reimbursement line,
 * tells us "you paid N — stamp it" (applyPayout). The reverse (unwindForRun) lets a
 * recompute / reopen / cancel cleanly back the stamps out so the whole thing is
 * idempotent.
 *
 * MONEY RECONCILIATION (the load-bearing invariant — the debit-side parity):
 *   For every claim the run pays, ONE figure — the approved claim amount in paise —
 *   is the credit on the employee's payslip (EXPENSE_REIMBURSEMENT, ADDED to net)
 *   AND the claim's paidViaPayrollAmount. payslip-credit == claim-paid, to the paise.
 *   Σ EXPENSE_REIMBURSEMENT components == Σ stamped claims.paidViaPayrollAmount ==
 *   result.reimbursementsMinor. Unlike a loan there is NO running employer balance to
 *   roll forward — the claim simply closes (APPROVED → REIMBURSED).
 *
 * WHY NO NET-FLOOR CAP HERE: a reimbursement ADDS to net (it can never push net
 * negative on its own), so — unlike loan recovery — the engine does NOT cap it. The
 * net-floor protection is a SANITY GUARD that lives in the orchestrator
 * (service.js §6: defer-with-review, never silently partial-pay); this module never
 * fabricates or shrinks a claim's amount.
 *
 * CONCURRENCY: selectPayableClaims takes a row lock (SELECT … FOR UPDATE SKIP LOCKED)
 * on the candidate claims inside the run transaction, so two pay runs that race on
 * the same employee cannot both grab the same APPROVED claim and double-pay. The
 * loser blocks on / skips the locked rows and re-reads them (now REIMBURSED) on its
 * next select.
 *
 * EVERYTHING here takes a tx client and does ZERO of its own transaction
 * management — the caller (payroll persistComputedRun) runs select → engine →
 * apply INSIDE one run transaction so a later throw rolls back the stamps too.
 */

const money = require('../payroll/money');

// The single channel a payroll run settles. PAY_SEPARATELY claims are NEVER selected
// (they stay on the manual Finance reimburse path).
const PAYROLL_CHANNEL = 'PAY_VIA_PAYROLL';

function toMinor(decimalish) {
  // Prisma Decimal serialises to a string; Number()→toMinor handles both.
  if (decimalish == null) return 0;
  return money.toMinor(String(decimalish));
}
function decStr(minor) {
  return money.fromMinor(minor, 2);
}

/**
 * selectPayableClaims — the APPROVED, PAY_VIA_PAYROLL claims this employee's pay run
 * should settle this period, oldest-first (createdAt, then id). Returns the rows +
 * the total minor the run should add to net as a reimbursement line.
 *
 * Selection set (mirrors loanRecovery.selectDuePending's predicate + recompute trick):
 *   status = 'APPROVED'                                      (paid claims are REIMBURSED → already excluded)
 *   AND payoutChannel = 'PAY_VIA_PAYROLL'
 *   AND deletedAt IS NULL
 *   AND (payRunId IS NULL OR payRunId = currentPayRunId)     fresh OR this run's own prior stamp
 *   AND (expenseDate <= periodEnd OR expenseDate IS NULL)    never pre-pay a future-dated claim
 *   AND importJobId IS NULL                                  never auto-pay a back-dated imported claim
 *   AND currencyCode = runCurrency (when supplied)           V1: no FX — same-currency only
 *
 * Re-including this run's own stamps (payRunId = currentPayRunId) matters for an
 * IDEMPOTENT RECOMPUTE exactly as in loan recovery: the default compute path runs
 * selection BEFORE the persist tx that unwinds prior stamps, so a recompute would
 * otherwise see this run's own claims as REIMBURSED and silently drop the line
 * (changing net + inputHash). Re-including them makes the second compute reproduce
 * the first; persistComputedRun then unwinds + re-stamps. A claim stamped by ANOTHER
 * live run is never grabbed: the FOR UPDATE row lock serialises concurrent runs.
 *
 * MIGRATED runs select nothing — the caller gates on `!isMigrated` (mirrors loan
 * recovery); imported claims are also excluded here by `importJobId IS NULL`.
 *
 * @returns {{ claims: Array<{id, amountMinor}>, totalPayableMinor: number }}
 */
async function selectPayableClaims(tx, { businessId, employeeId, periodEnd, currentPayRunId = null, runCurrency = null }) {
  // 1) ROW LOCK the candidate rows (FOR UPDATE) so a concurrent run on the same
  // employee can't select the same claim. SKIP LOCKED lets a parallel run on a
  // DIFFERENT employee proceed without blocking; a true racer on the SAME row blocks
  // until our tx commits, then re-reads it stamped (REIMBURSED) and skips it.
  // $queryRaw is the only way to FOR UPDATE in Prisma; we lock IDs here, then hydrate
  // with findMany so the include/shape stays identical to the rest of the codebase.
  // The "owned by this run" branch (payRunId = currentPayRunId) is inlined per-arm
  // because Prisma tagged-template fragments can't be spliced into one query.
  const lockedIds = currentPayRunId
    ? await tx.$queryRaw`
        SELECT c."id"
        FROM "ExpenseClaim" c
        WHERE c."businessId" = ${businessId}
          AND c."employeeId" = ${employeeId}
          AND c."status" = 'APPROVED'
          AND c."payoutChannel" = ${PAYROLL_CHANNEL}::"ReimbursementPayoutChannel"
          AND c."deletedAt" IS NULL
          AND c."importJobId" IS NULL
          AND (c."payRunId" IS NULL OR c."payRunId" = ${currentPayRunId})
          AND (c."expenseDate" IS NULL OR c."expenseDate" <= ${periodEnd}::date)
          AND (${runCurrency}::text IS NULL OR c."currencyCode" = ${runCurrency})
        ORDER BY c."createdAt" ASC, c."id" ASC
        FOR UPDATE OF c SKIP LOCKED`
    : await tx.$queryRaw`
        SELECT c."id"
        FROM "ExpenseClaim" c
        WHERE c."businessId" = ${businessId}
          AND c."employeeId" = ${employeeId}
          AND c."status" = 'APPROVED'
          AND c."payoutChannel" = ${PAYROLL_CHANNEL}::"ReimbursementPayoutChannel"
          AND c."deletedAt" IS NULL
          AND c."importJobId" IS NULL
          AND c."payRunId" IS NULL
          AND (c."expenseDate" IS NULL OR c."expenseDate" <= ${periodEnd}::date)
          AND (${runCurrency}::text IS NULL OR c."currencyCode" = ${runCurrency})
        ORDER BY c."createdAt" ASC, c."id" ASC
        FOR UPDATE OF c SKIP LOCKED`;
  const lockedIdSet = lockedIds.map((r) => r.id);
  if (lockedIdSet.length === 0) return { claims: [], totalPayableMinor: 0 };

  // 2) Hydrate the locked rows (same tenant/employee scope as the lock). amount is the
  // APPROVED header figure — F11 already settles at the approved amount; we pay that.
  const rows = await tx.expenseClaim.findMany({
    where: { id: { in: lockedIdSet }, businessId, employeeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, amount: true },
  });

  const claims = [];
  let totalPayableMinor = 0;
  for (const c of rows) {
    const amountMinor = Math.max(0, toMinor(c.amount));
    if (amountMinor <= 0) continue; // a zero/blank-amount claim is never paid via payroll
    claims.push({ id: c.id, amountMinor });
    totalPayableMinor += amountMinor;
  }
  return { claims, totalPayableMinor };
}

/**
 * reconcilePayout — pin the AUTHORITATIVE claim set a persist tx will both PRICE on the
 * payslip and STAMP, eliminating the compute-vs-persist race (the two HIGH double-pay
 * bugs). The engine priced ONE set at compute time (`pricedClaims`, selected on the
 * non-tx client, un-locked); the persist tx holds a FOR UPDATE lock on a possibly-
 * different `lockedClaims` set. The only set that is BOTH (a) what the engine actually
 * summed onto the line and (b) provably un-settleable by any concurrent run is the
 * INTERSECTION: priced claims that are still lockable now.
 *
 *   - A priced claim MISSING from the lock set was settled out-of-band (manual reimburse
 *     or another run grabbed it) between compute and persist → we MUST NOT pay it again,
 *     so it drops out and the payslip line is repriced DOWN to match (see service.js).
 *   - A lock-set claim that was NOT priced (a newer/older claim approved after compute)
 *     is NOT added — the engine never put it on the line nor vetted it through the
 *     net-floor guard; adding it would credit money the payslip never showed. It stays
 *     APPROVED for the next run.
 *
 * The result is the EXACT set whose Σ amounts the caller writes to BOTH the
 * EXPENSE_REIMBURSEMENT line / net AND the claim stamps — priced set == stamped set,
 * to the paise, with no race window. We keep the priced claims' own amounts (the engine
 * summed THOSE), intersecting against lock-set membership only.
 *
 * @param {Array<{id, amountMinor}>} pricedClaims  what the engine priced (ln.reimbursementPayout.claims)
 * @param {Array<{id, amountMinor}>} lockedClaims  the FOR UPDATE set re-selected in the persist tx
 * @returns {{ claims: Array<{id, amountMinor}>, totalMinor: number, droppedIds: string[] }}
 */
function reconcilePayout(pricedClaims, lockedClaims) {
  const lockedIds = new Set((lockedClaims || []).map((c) => c.id));
  const claims = [];
  const droppedIds = [];
  let totalMinor = 0;
  for (const c of pricedClaims || []) {
    const amountMinor = Math.max(0, Math.round(c.amountMinor != null ? c.amountMinor : 0));
    if (amountMinor <= 0) continue;
    if (!lockedIds.has(c.id)) { droppedIds.push(c.id); continue; }
    claims.push({ id: c.id, amountMinor });
    totalMinor += amountMinor;
  }
  return { claims, totalMinor, droppedIds };
}

/**
 * applyPayout — stamp EXACTLY the supplied claims REIMBURSED, crediting each its OWN
 * priced amount (credit == claim-paid, to the paise). The caller passes the RECONCILED
 * set (reconcilePayout) — the same claims whose Σ amounts it ALSO wrote to the
 * EXPENSE_REIMBURSEMENT line / net — so the engine-priced set and the stamped set are
 * identical (closes the "stamp a different lock-ordered set than the engine priced"
 * bug). We do NOT greedily spread an aggregate `paidMinor` across a re-derived,
 * lock-ordered candidate list; every claim handed in is an engine-priced claim and is
 * stamped its own amount.
 *
 * Idempotent by construction: the caller unwinds (see unwindForRun) any prior stamps
 * for this payRunId BEFORE re-selecting + re-applying, so re-running the same run
 * never double-pays.
 *
 * @param {Array<{id, amountMinor}>} claims  the reconciled priced∩locked claim set
 * @returns {{ paidMinor, paidClaimIds: string[] }}
 */
async function applyPayout(tx, { businessId, payRunId, paidAt, actorId = null, claims }) {
  let paidMinor = 0;
  const paidClaimIds = [];

  for (const claim of claims) {
    const amountMinor = Math.round(claim.amountMinor != null ? claim.amountMinor : 0);
    if (amountMinor <= 0) continue;

    await tx.expenseClaim.update({
      where: { id: claim.id },
      data: {
        status: 'REIMBURSED',
        payRunId,
        reimbursedAt: paidAt,
        reimbursedBy: actorId || null,
        paidViaPayrollAmount: decStr(amountMinor),
        version: { increment: 1 },
      },
    });
    paidClaimIds.push(claim.id);
    paidMinor += amountMinor;
  }

  // paidMinor returned = Σ stamped amounts == Σ priced amounts of the reconciled set.
  return { paidMinor, paidClaimIds };
}

/**
 * unwindForRun — back out every reimbursement this payRunId previously stamped, so a
 * recompute / reopen / cancel restores the pre-run state and a fresh apply can run
 * cleanly. For each claim stamped with this payRunId, reset it to APPROVED and clear
 * payRunId / paidViaPayrollAmount / reimbursedAt / reimbursedBy. Simpler than the loan
 * unwind — there are NO running employer totals to reverse (the claim just re-opens).
 *
 * Pure-DB, takes a tx, no transaction management of its own. Returns the count of
 * claims unwound (0 = nothing to do — the common first-compute case).
 */
async function unwindForRun(tx, { businessId, payRunId }) {
  // Only release claims THIS payroll-payout pass stamped: status REIMBURSED via payroll
  // (paidViaPayrollAmount set). A claim manually reimbursed out-of-band (PAY_SEPARATELY:
  // paidViaPayrollAmount NULL) might also carry a payRunId from the legacy manual flow,
  // so we MUST NOT touch it — guard on paidViaPayrollAmount NOT NULL.
  const stamped = await tx.expenseClaim.findMany({
    where: { businessId, payRunId, status: 'REIMBURSED', paidViaPayrollAmount: { not: null } },
    select: { id: true },
  });
  if (stamped.length === 0) return { unwound: 0, claimIds: [] };

  const result = await tx.expenseClaim.updateMany({
    where: { businessId, payRunId, status: 'REIMBURSED', paidViaPayrollAmount: { not: null } },
    data: {
      status: 'APPROVED',
      payRunId: null,
      paidViaPayrollAmount: null,
      reimbursedAt: null,
      reimbursedBy: null,
    },
  });

  return { unwound: result.count, claimIds: stamped.map((c) => c.id) };
}

module.exports = {
  PAYROLL_CHANNEL,
  selectPayableClaims,
  reconcilePayout,
  applyPayout,
  unwindForRun,
  _internals: { toMinor, decStr },
};

'use strict';

/**
 * encashmentPass.js — Feature 31. The PAYROLL half of in-service leave encashment.
 * MIRRORS controllers/reimbursementPayout.js (the idempotent claim-stamp) but the line
 * is a POSITIVE, FULLY-TAXABLE EARNING (the F27 ARREAR_EARNINGS shape), not a
 * non-taxable reimbursement: the days were SURRENDERED in service, so §10(10AA) is NEVER
 * applied — the whole amount inflates the §192/TDS base.
 *
 * It OWNS the LeaveEncashmentRequest payout bookkeeping so payroll never forks it:
 *   selectPayableEncashments — which APPROVED, un-paid requests should this run pay?
 *   applyPayout              — after the engine emitted the LEAVE_ENCASHMENT line, stamp
 *                              each request PAID + payRunId + paidAmountMinor.
 *   unwindForRun             — back the stamps out (recompute / reopen / cancel) WITHOUT
 *                              re-crediting the leave (the surrender stands; the request
 *                              rides the next run).
 *
 * The leave-balance debit is NOT here — it happened ONCE at APPROVE (consumers.encashment
 * posts the ENCASHMENT LeaveTransaction + encashed+/closing−). The pay pass only settles cash.
 *
 * MONEY: each request carries the amountMinor SNAPSHOTTED at APPROVE (a comp revision
 * after approval can't re-value a settled day). The engine never caps a positive earning,
 * so paid == Σ request.amountMinor — there is NO net-floor here (an earning only raises net).
 *
 * CONCURRENCY: selection takes a row lock (SELECT … FOR UPDATE SKIP LOCKED) inside the run
 * tx, so two runs racing on the same employee can't both grab the same APPROVED request and
 * double-pay. Everything takes a `tx` and does ZERO own-tx management — the caller
 * (persistComputedRun) runs select → engine → apply in ONE run transaction.
 */

function bigToMinor(v) {
  if (v == null) return 0;
  return Number(v);
}

/**
 * selectPayableEncashments — the APPROVED, un-paid requests this employee's run should
 * pay this period, oldest-approval-first. Mirrors reimbursementPayout.selectPayableClaims:
 *   status = 'APPROVED'
 *   AND (payRunId IS NULL OR payRunId = currentPayRunId)   un-paid OR this run's own prior stamp
 *   AND decidedAt <= periodEnd                             don't pre-pay a request approved after the period
 *   ORDER BY decidedAt ASC
 *
 * Re-including this run's own stamps (payRunId = currentPayRunId) makes a RECOMPUTE
 * reproduce the first compute (the persist tx unwinds + re-stamps). A request stamped by
 * ANOTHER live run is never grabbed — the FOR UPDATE lock serialises concurrent runs.
 * MIGRATED runs select nothing (the caller gates on !isMigrated).
 *
 * @returns {{ requests: Array<{id, amountMinor}>, totalPayableMinor: number }}
 */
async function selectPayableEncashments(tx, { businessId, employeeId, periodEnd, currentPayRunId = null }) {
  const lockedIds = currentPayRunId
    ? await tx.$queryRaw`
        SELECT r."id"
        FROM "LeaveEncashmentRequest" r
        WHERE r."businessId" = ${businessId}
          AND r."employeeId" = ${employeeId}
          AND r."status" = 'APPROVED'
          AND (r."payRunId" IS NULL OR r."payRunId" = ${currentPayRunId})
          AND (r."decidedAt" IS NULL OR r."decidedAt" <= ${periodEnd}::timestamp)
        ORDER BY r."decidedAt" ASC, r."id" ASC
        FOR UPDATE OF r SKIP LOCKED`
    : await tx.$queryRaw`
        SELECT r."id"
        FROM "LeaveEncashmentRequest" r
        WHERE r."businessId" = ${businessId}
          AND r."employeeId" = ${employeeId}
          AND r."status" = 'APPROVED'
          AND r."payRunId" IS NULL
          AND (r."decidedAt" IS NULL OR r."decidedAt" <= ${periodEnd}::timestamp)
        ORDER BY r."decidedAt" ASC, r."id" ASC
        FOR UPDATE OF r SKIP LOCKED`;
  const lockedIdSet = lockedIds.map((r) => r.id);
  if (lockedIdSet.length === 0) return { requests: [], totalPayableMinor: 0 };

  const rows = await tx.leaveEncashmentRequest.findMany({
    where: { id: { in: lockedIdSet }, businessId, employeeId },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, amountMinor: true, leavePolicyId: true },
  });

  // Resolve the statutory wage flags from the policies that own these requests. The line
  // is aggregated per employee, so we pick the MOST-CONSERVATIVE (employer-contributing)
  // stance across the period's requests: PF/ESI wages if ANY request's policy says so, PT
  // wages unless EVERY request's policy opts out (default true). NULL policy ⇒ statutory
  // defaults (not PF/ESI wages, IS PT wages — the settled IN position).
  const policyIds = [...new Set(rows.map((r) => r.leavePolicyId).filter(Boolean))];
  const policies = policyIds.length
    ? await tx.leavePolicy.findMany({ where: { id: { in: policyIds } }, select: { id: true, encashPfWages: true, encashEsiWages: true, encashPtWages: true } })
    : [];
  const polById = new Map(policies.map((p) => [p.id, p]));

  const requests = [];
  let totalPayableMinor = 0;
  let pfWages = false;
  let esiWages = false;
  let ptWages = false; // becomes true if ANY payable request is PT wages (default true)
  for (const r of rows) {
    const amountMinor = Math.max(0, bigToMinor(r.amountMinor));
    if (amountMinor <= 0) continue; // a request whose amount never got snapshotted is not paid
    requests.push({ id: r.id, amountMinor });
    totalPayableMinor += amountMinor;
    const pol = r.leavePolicyId ? polById.get(r.leavePolicyId) : null;
    if (pol ? pol.encashPfWages === true : false) pfWages = true;
    if (pol ? pol.encashEsiWages === true : false) esiWages = true;
    if (pol ? pol.encashPtWages !== false : true) ptWages = true; // default PT wages true
  }
  return { requests, totalPayableMinor, pfWages, esiWages, ptWages };
}

/**
 * reconcilePayout — pin the AUTHORITATIVE request set the persist tx will both PRICE and
 * STAMP, eliminating the compute-vs-persist race (mirror reimbursementPayout.reconcilePayout).
 * The engine priced ONE set at compute (pricedRequests, un-locked); the persist tx holds a
 * FOR UPDATE lock on a possibly-different set. The only set that is BOTH priced AND lockable
 * now is the intersection. We keep the priced requests' own snapshot amounts.
 *
 * @returns {{ requests: Array<{id, amountMinor}>, totalMinor: number, droppedIds: string[] }}
 */
function reconcilePayout(pricedRequests, lockedRequests) {
  const lockedIds = new Set((lockedRequests || []).map((r) => r.id));
  const requests = [];
  const droppedIds = [];
  let totalMinor = 0;
  for (const r of pricedRequests || []) {
    const amountMinor = Math.max(0, Math.round(r.amountMinor != null ? r.amountMinor : 0));
    if (amountMinor <= 0) continue;
    if (!lockedIds.has(r.id)) { droppedIds.push(r.id); continue; }
    requests.push({ id: r.id, amountMinor });
    totalMinor += amountMinor;
  }
  return { requests, totalMinor, droppedIds };
}

/**
 * applyPayout — stamp EXACTLY the supplied requests PAID, each its OWN snapshot amount
 * (paid == amount, to the paise). The caller passes the RECONCILED set (the same requests
 * whose Σ amounts it wrote to the LEAVE_ENCASHMENT line). NO leave-balance touch here — the
 * balance was already debited at APPROVE. Idempotent: the caller unwinds prior stamps for
 * this payRunId BEFORE re-applying.
 *
 * @returns {{ paidMinor, paidRequestIds: string[] }}
 */
async function applyPayout(tx, { businessId, payRunId, paidAt, requests }) {
  let paidMinor = 0;
  const paidRequestIds = [];
  for (const r of requests || []) {
    const amountMinor = Math.round(r.amountMinor != null ? r.amountMinor : 0);
    if (amountMinor <= 0) continue;
    await tx.leaveEncashmentRequest.update({
      where: { id: r.id },
      data: {
        status: 'PAID',
        payRunId,
        paidAt,
        paidAmountMinor: BigInt(amountMinor),
        version: { increment: 1 },
      },
    });
    paidRequestIds.push(r.id);
    paidMinor += amountMinor;
  }
  return { paidMinor, paidRequestIds };
}

/**
 * unwindForRun — back out every encashment this payRunId previously stamped, so a
 * recompute / reopen / cancel restores the pre-run state and a fresh apply runs cleanly.
 * Reset PAID → APPROVED, clear payRunId / paidAmountMinor / paidAt. Does NOT re-credit the
 * leave balance (the surrender stands; the request rides the next run). Mirrors
 * reimbursementPayout.unwindForRun minus the channel reset. Returns the count.
 */
async function unwindForRun(tx, { businessId, payRunId }) {
  const stamped = await tx.leaveEncashmentRequest.findMany({
    where: { businessId, payRunId, status: 'PAID' },
    select: { id: true },
  });
  if (stamped.length === 0) return { unwound: 0, requestIds: [] };
  const result = await tx.leaveEncashmentRequest.updateMany({
    where: { businessId, payRunId, status: 'PAID' },
    data: { status: 'APPROVED', payRunId: null, paidAmountMinor: null, paidAt: null },
  });
  return { unwound: result.count, requestIds: stamped.map((r) => r.id) };
}

module.exports = {
  selectPayableEncashments,
  reconcilePayout,
  applyPayout,
  unwindForRun,
  _internals: { bigToMinor },
};

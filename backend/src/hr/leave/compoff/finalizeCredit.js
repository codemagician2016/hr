'use strict';

/**
 * finalizeCredit.js — bridge a comp-off LOT into the aggregate leave ledger
 * (Feature 30 §4.1.1). The single point where a credit becomes ACTIVE — shared by
 * auto-earn, HR manual grant, and earn-approval. Always called INSIDE a caller's
 * `$transaction(tx)` so the lot flip and the balance move commit atomically.
 *
 * On finalize (PENDING|fresh → ACTIVE), in one tx:
 *   1. Upsert the employee's COMP_OFF LeaveBalance for the credit's FY period.
 *   2. Append a LeaveTransaction { txnType: ACCRUAL, +qty, APPROVED } so the leave
 *      ledger reconciles + reconstructBuckets sees the grant. Stamp creditTxnId.
 *   3. LeaveBalance.update: accrued += qty, closing += qty, version++.
 *   4. CompOffCredit.update: status=ACTIVE, leaveBalanceId, creditTxnId, version++.
 *
 * This keeps the lot and the aggregate balance BYTE-CONSISTENT (the comp-off
 * reconcile invariant 1) and lets every existing balance/reconcile/history/FnF path
 * treat comp-off as just another leave type with an external accrual source.
 *
 * Idempotent: a credit that is no longer PENDING (already ACTIVE/VOIDED/EXPIRED) is
 * a no-op — the conditional updateMany short-circuits a double-finalize.
 */

const { fyPeriodCode } = require('../periodCode');

function utcDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

/**
 * finalizeCredit(tx, { credit, leaveTypeId, taxYearStartMonth, decidedBy }) —
 * flip a PENDING/just-created credit to ACTIVE and post the aggregate grant.
 * Returns { ok, balanceId, creditTxnId } (ok=false when the credit was not in a
 * finalizable state, i.e. already finalized/voided).
 *
 * `tx` MUST be a prisma transaction client (the caller owns the $transaction).
 */
async function finalizeCredit(tx, { credit, leaveTypeId, taxYearStartMonth = 4, decidedBy = null } = {}) {
  if (!credit || !credit.id) throw new Error('finalizeCredit requires a credit');
  if (!leaveTypeId) throw new Error('finalizeCredit requires leaveTypeId');

  // Conditional flip first: only finalize a credit still PENDING (a just-minted
  // auto-earn credit is created ACTIVE-less as PENDING then immediately finalized;
  // an approval flips PENDING→ACTIVE). A re-fire finds count===0 → no-op.
  const flip = await tx.compOffCredit.updateMany({
    where: { id: credit.id, status: 'PENDING' },
    data: { status: 'ACTIVE' },
  });
  if (flip.count === 0) {
    return { ok: false, reason: 'NOT_PENDING' };
  }

  const businessId = credit.businessId;
  const employeeId = credit.employeeId;
  const qty = Number(credit.quantity);
  const earnedOn = utcDay(credit.earnedOn || credit.sourceDate || new Date());
  const periodCode = fyPeriodCode(earnedOn, taxYearStartMonth);
  const now = new Date();

  // 1. Upsert the aggregate COMP_OFF balance for the credit's FY period.
  const balance = await tx.leaveBalance.upsert({
    where: {
      businessId_employeeId_leaveTypeId_periodCode: { businessId, employeeId, leaveTypeId, periodCode },
    },
    update: {},
    create: { businessId, employeeId, leaveTypeId, periodCode, unit: 'DAYS' },
  });

  // 2. Append the ACCRUAL ledger row (the leave ledger's view of the grant).
  const txn = await tx.leaveTransaction.create({
    data: {
      businessId, employeeId, leaveTypeId, leaveBalanceId: balance.id,
      txnType: 'ACCRUAL', unit: 'DAYS', quantity: qty,
      status: 'APPROVED', appliedAt: now, decidedAt: now, decidedBy,
      reason: `Comp-off earned (${credit.sourceKind}) for ${utcDay(credit.sourceDate).toISOString().slice(0, 10)}`,
    },
  });

  // 3. Bump the aggregate balance (accrued + closing). Version-locked.
  await tx.leaveBalance.update({
    where: { id: balance.id, version: balance.version },
    data: { accrued: { increment: qty }, closing: { increment: qty }, version: { increment: 1 } },
  });

  // 4. Stamp the lot with its bridge ids.
  await tx.compOffCredit.update({
    where: { id: credit.id },
    data: { leaveBalanceId: balance.id, creditTxnId: txn.id, version: { increment: 1 } },
  });

  return { ok: true, balanceId: balance.id, creditTxnId: txn.id, periodCode };
}

/**
 * voidCredit(tx, { credit, decidedBy, reason }) — reverse an UNCONSUMED credit
 * (earn rejected / attendance reversal / HR void; edge case 3). Posts an
 * ADJUSTMENT −remaining on the aggregate balance (when the credit was already
 * ACTIVE), drops closing, and flips the lot VOIDED. A PENDING credit (never
 * finalized) just flips VOIDED with no ledger effect. Idempotent on a
 * terminal-state credit. Refuses to void a partially/fully consumed lot (returns
 * ok:false, reason CONSUMED) — append-only history must stand.
 */
async function voidCredit(tx, { credit, leaveTypeId = null, decidedBy = null, reason = null } = {}) {
  if (!credit || !credit.id) throw new Error('voidCredit requires a credit');
  const consumed = Number(credit.consumed || 0);
  const qty = Number(credit.quantity);

  // PENDING → just void; no balance was ever bumped.
  if (credit.status === 'PENDING') {
    const flip = await tx.compOffCredit.updateMany({
      where: { id: credit.id, status: 'PENDING' },
      data: { status: 'VOIDED', reason: reason || credit.reason, version: { increment: 1 } },
    });
    return { ok: flip.count > 0, reason: flip.count > 0 ? null : 'NOT_PENDING' };
  }

  if (credit.status !== 'ACTIVE') return { ok: false, reason: 'NOT_VOIDABLE' };
  if (consumed > 0) return { ok: false, reason: 'CONSUMED' };

  const flip = await tx.compOffCredit.updateMany({
    where: { id: credit.id, status: 'ACTIVE', consumed: 0 },
    data: { status: 'VOIDED', reason: reason || credit.reason, version: { increment: 1 } },
  });
  if (flip.count === 0) return { ok: false, reason: 'RACE' };

  if (credit.leaveBalanceId) {
    const bal = await tx.leaveBalance.findUnique({
      where: { id: credit.leaveBalanceId }, select: { id: true, version: true, leaveTypeId: true },
    });
    if (bal) {
      await tx.leaveTransaction.create({
        data: {
          businessId: credit.businessId, employeeId: credit.employeeId,
          leaveTypeId: leaveTypeId || bal.leaveTypeId,
          leaveBalanceId: bal.id, txnType: 'ADJUSTMENT', unit: 'DAYS', quantity: -qty,
          status: 'APPROVED', appliedAt: new Date(), decidedAt: new Date(), decidedBy,
          reason: reason || `Comp-off credit voided (${credit.sourceKind})`,
        },
      });
      await tx.leaveBalance.update({
        where: { id: bal.id, version: bal.version },
        data: { adjusted: { decrement: qty }, closing: { decrement: qty }, version: { increment: 1 } },
      });
    }
  }
  return { ok: true };
}

module.exports = { finalizeCredit, voidCredit, _internals: { utcDay } };

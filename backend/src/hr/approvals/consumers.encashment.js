'use strict';

/**
 * consumers.encashment.js — Feature 31. The LEAVE_ENCASHMENT consumer bundle.
 *
 * Mirrors consumers.leave.js: the engine decides WHEN a terminal transition happens;
 * the domain effect (flip the LeaveEncashmentRequest status + move the LeaveBalance +
 * post the ENCASHMENT ledger row + snapshot the money) is carried HERE, in callbacks
 * the engine fires INSIDE its own transaction so the balance debit commits atomically
 * with the approval transition.
 *
 *   onApprove(req, tx) — PENDING → APPROVED: the REAL debit. Release the soft-hold,
 *                        post ONE ENCASHMENT LeaveTransaction, bump `encashed += days`
 *                        and `closing -= days` (version-locked), and SNAPSHOT the
 *                        last-drawn Basic+DA + the computed amount onto the request
 *                        (so a later comp revision never re-values a surrendered day).
 *                        The cash is now OWED and queued for the next pay run.
 *   onReject(req, tx)  — PENDING → REJECTED: release the hold; NO debit.
 *   onCancel(req, tx)  — requester cancel/withdraw while PENDING: release the hold; NO debit.
 *
 * Idempotency / concurrency mirror the leave consumer exactly: every status flip is a
 * conditional updateMany(where status='PENDING') (a lost race → DECISION_RACE 409), the
 * balance move is version-optimistic-locked (P2025 → 409), and `encashmentTxnId` being
 * set is the secondary guard so the ENCASHMENT row is posted EXACTLY once.
 *
 * The §10(10AA) exit exemption is NEVER touched here — in-service encashment is fully
 * taxable under §17; the taxable earning is emitted later by the pay pass.
 */

const consumers = require('./consumers');
const { computeEncashAmount } = require('../leave/encashment/encashment');
// The last-drawn Basic+DA resolver F&F uses (sums current CompensationRevision BASIC +
// DEARNESS_ALLOWANCE lines → integer paise). Reused so in-service == exit to the paise.
const { resolveLastDrawnPay } = require('../lifecycle/controllers/offboarding.controller')._internals;
// Fire-and-forget decision notify, OUTSIDE the engine tx (default prisma), so a notify
// failure can never roll back the balance debit. Mirrors consumers.leave.js.
const notify = require('./notify');

// pendingApproval can never go below zero — floor the release (mirror consumers.leave).
function flooredRelease(current, qty) {
  return Math.min(qty, Math.max(0, Number(current || 0)));
}

// Load the LeaveEncashmentRequest this ApprovalRequest gates. Tolerant of an
// already-terminal row (a re-fired/duplicate hook is then a no-op).
async function loadReq(tx, approvalRequest) {
  return tx.leaveEncashmentRequest.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
    include: { leaveType: { select: { id: true } } },
  });
}

// onApprove — PENDING → APPROVED. The real debit: release the hold, post the ENCASHMENT
// ledger row, bump encashed+/closing−, snapshot Basic+DA + amount. Version-locked.
async function onApprove(approvalRequest, tx) {
  const reqRow = await loadReq(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return; // already decided → no-op
  const days = Math.abs(Number(reqRow.days));
  const decidedBy = approvalRequest.decidedBy || null;
  const now = new Date();

  // (1) CONDITIONAL status flip — exactly-once. A lost race → DECISION_RACE (409).
  const flip = await tx.leaveEncashmentRequest.updateMany({
    where: { id: reqRow.id, status: 'PENDING' },
    data: { status: 'APPROVED', decidedAt: now, decidedBy },
  });
  if (flip.count === 0) {
    const err = new Error('Encashment request already decided concurrently');
    err.code = 'DECISION_RACE';
    throw err;
  }

  // (2) Resolve the snapshot money (last-drawn Basic+DA / gross) and compute the amount.
  //     Valued at APPROVE because the days are debited at APPROVE (spec §10.1) — a later
  //     comp revision must never re-value a surrendered day.
  const pay = await resolveLastDrawnPay(approvalRequest.businessId, reqRow.employeeId, tx);
  const money = computeEncashAmount({
    basis: reqRow.basis,
    basicDaMonthlyMinor: pay.basicDaMonthlyMinor,
    grossMonthlyMinor: pay.grossMonthlyMinor,
    days,
  });

  // (3) Resolve the LeaveBalance for this request's period and DEBIT it: post ONE
  //     ENCASHMENT LeaveTransaction (the append-only ledger row that ledger.js scores
  //     as −|q|), bump encashed += days, closing -= days. Version-locked (P2025 on race).
  //     The balance/ledger reconcile invariant (§4.2) holds with ZERO ledger changes.
  const balance = await tx.leaveBalance.findFirst({
    where: { businessId: approvalRequest.businessId, employeeId: reqRow.employeeId, leaveTypeId: reqRow.leaveTypeId, periodCode: reqRow.periodCode },
    select: { id: true, version: true, pendingApproval: true, unit: true },
  });

  let encashmentTxnId = null;
  if (balance) {
    const txn = await tx.leaveTransaction.create({
      data: {
        businessId: approvalRequest.businessId,
        employeeId: reqRow.employeeId,
        leaveTypeId: reqRow.leaveTypeId,
        leaveBalanceId: balance.id,
        txnType: 'ENCASHMENT',
        unit: balance.unit,
        quantity: days, // ledger scores ENCASHMENT as −|q|; stored magnitude
        reason: `In-service leave encashment (${days} day(s))`,
        status: 'APPROVED',
        appliedAt: now,
        decidedAt: now,
        decidedBy,
      },
    });
    encashmentTxnId = txn.id;
    // Release the soft-hold and apply the debit under the version lock.
    await tx.leaveBalance.update({
      where: { id: balance.id, version: balance.version },
      data: {
        pendingApproval: { decrement: flooredRelease(balance.pendingApproval, days) },
        encashed: { increment: days },
        closing: { decrement: days },
        version: { increment: 1 },
      },
    });
  }

  // (4) Stamp the snapshot + the ledger-row link on the request (the secondary
  //     exactly-once guard + the figure the pay pass pays).
  await tx.leaveEncashmentRequest.update({
    where: { id: reqRow.id },
    data: {
      basicDaMonthlyMinor: BigInt(pay.basicDaMonthlyMinor || 0),
      perDayMinor: BigInt(money.perDayMinor || 0),
      amountMinor: BigInt(money.amountMinor || 0),
      encashmentTxnId,
    },
  });

  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'APPROVED' }).catch(() => {});
}

// onReject — PENDING → REJECTED. Release the hold (floored); NO debit.
async function onReject(approvalRequest, tx) {
  const reqRow = await loadReq(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return;
  const days = Math.abs(Number(reqRow.days));
  const decidedBy = approvalRequest.decidedBy || null;
  const flip = await tx.leaveEncashmentRequest.updateMany({
    where: { id: reqRow.id, status: 'PENDING' },
    data: { status: 'REJECTED', decidedAt: new Date(), decidedBy },
  });
  if (flip.count === 0) {
    const err = new Error('Encashment request already decided concurrently');
    err.code = 'DECISION_RACE';
    throw err;
  }
  await releaseHold(tx, approvalRequest.businessId, reqRow, days);
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'REJECTED' }).catch(() => {});
}

// onCancel — requester cancel/withdraw while PENDING. Release the hold; NO debit.
async function onCancel(approvalRequest, tx) {
  const reqRow = await loadReq(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return;
  const days = Math.abs(Number(reqRow.days));
  const decidedBy = approvalRequest.decidedBy || null;
  const flip = await tx.leaveEncashmentRequest.updateMany({
    where: { id: reqRow.id, status: 'PENDING' },
    data: { status: 'CANCELLED', decidedAt: new Date(), decidedBy },
  });
  if (flip.count === 0) {
    const err = new Error('Encashment request already decided concurrently');
    err.code = 'DECISION_RACE';
    throw err;
  }
  await releaseHold(tx, approvalRequest.businessId, reqRow, days);
}

// Release the soft-hold placed at request time (no units consumed). Version-locked.
async function releaseHold(tx, businessId, reqRow, days) {
  const balance = await tx.leaveBalance.findFirst({
    where: { businessId, employeeId: reqRow.employeeId, leaveTypeId: reqRow.leaveTypeId, periodCode: reqRow.periodCode },
    select: { id: true, version: true, pendingApproval: true },
  });
  if (balance) {
    await tx.leaveBalance.update({
      where: { id: balance.id, version: balance.version },
      data: { pendingApproval: { decrement: flooredRelease(balance.pendingApproval, days) }, version: { increment: 1 } },
    });
  }
}

const bundle = { onApprove, onReject, onCancel };

function registerEncashmentConsumer() {
  return consumers.register('LEAVE_ENCASHMENT', bundle);
}

// Self-register on module load (idempotent — the registry overwrites the same bundle),
// like consumers.leave.js, so the callback fires for ANY entrypoint that loads the
// encashment controller. registerConsumers.js is still the explicit boot wiring point.
registerEncashmentConsumer();

module.exports = {
  registerEncashmentConsumer,
  bundle,
  flooredRelease,
  // exported for the unit/live tests + the controller's direct fallback.
  _internals: { onApprove, onReject, onCancel, releaseHold },
};

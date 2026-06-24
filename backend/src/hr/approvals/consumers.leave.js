'use strict';

/**
 * consumers.leave.js — Feature 10 slice 10c. The LEAVE consumer bundle.
 *
 * The engine never knows leave-balance semantics; it only decides WHEN a terminal
 * transition happens. The domain effect (flip the LeaveTransaction status + move the
 * soft-hold on the LeaveBalance) is carried HERE, in callbacks the engine fires
 * INSIDE its own transaction so the balance move commits atomically with the
 * approval transition.
 *
 * These bodies are the EXISTING `decideTerminal(...,'APPROVED', balanceMove)` /
 * soft-hold-release logic moved wholesale from leave.controller.js — ZERO behaviour
 * change. The controller's approve/reject/cancel routes now drive the engine, which
 * fires the matching hook; both the engine path and the legacy direct path share the
 * single `applyLeaveDecision` core below so the balance outcome is byte-identical.
 *
 *   onApprove(req, tx) — PENDING → APPROVED: release the hold into `taken`,
 *                        decrement `closing`.
 *   onReject(req, tx)  — PENDING → REJECTED: release the hold (floored); no units
 *                        are consumed.
 *   onCancel(req, tx)  — requester cancel/withdraw of an OPEN request: release the
 *                        hold (floored); no units consumed.
 *
 * Idempotency / concurrency are preserved exactly: every status flip is a
 * conditional `updateMany(where status ∈ from)` (a lost race → DECISION_RACE), and
 * every balance move is version-optimistic-locked (a concurrent move → P2025). Both
 * map to a 409 in the controller (isDecisionRace), identical to today.
 */

const consumers = require('./consumers');
// Feature 16 — the leave→attendance EAGER bridge: on the APPROVED transition we
// stamp ON_LEAVE Attendance rows (so an approved LWP day is a frozen-eligible LOP
// day even if the nightly derive never runs). Lives behind a single guard in the
// SHARED decision core so BOTH the engine path and the legacy direct path bridge.
const { stampLeaveAttendanceOnApproval } = require('../leave/leaveToAttendance');
// Feature 30 — comp-off lot debit. The ONE category-gated seam: on the APPROVED
// transition of a COMP_OFF leave APPLICATION, after the standard balance move, burn
// the FIFO comp-off lots so per-credit expiry stays honest. Inert for every other
// leave type (isCompOffCategory gate). The lot math is pure (compOffLots.js).
const { isCompOffCategory, debitLotsOnApprove } = require('../leave/compoff/compOffSeam');
// Cycle 0 — notify the REQUESTER of the decision on a real channel (email/WhatsApp/
// push) with a deep-link. Fire-and-forget + OUTSIDE the engine tx (the helper uses the
// default prisma client), so a notify failure can never roll back the balance move.
const notify = require('./notify');

// pendingApproval can never go below zero — floor the release so a duplicated
// decision (or a stale hold) cannot over-state `available` (leave finding #3).
function flooredRelease(current, qty) {
  return Math.min(qty, Math.max(0, Number(current || 0)));
}

// The shared guarded terminal transition for a LeaveTransaction APPLICATION row.
// IDENTICAL semantics to leave.controller#decideTerminal: a conditional status flip
// (DECISION_RACE on a lost race) + a version-locked balance move (P2025 on a
// concurrent move). `balanceMove(currentBalance)` returns the Prisma `data` for the
// locked update, or null to skip the balance write.
async function applyLeaveDecision(tx, { txn, toStatus, fromStatuses, decidedBy, reason, balanceMove }) {
  const flip = await tx.leaveTransaction.updateMany({
    where: { id: txn.id, status: { in: fromStatuses } },
    data: { status: toStatus, decidedAt: new Date(), decidedBy, ...(reason !== undefined ? { reason } : {}) },
  });
  if (flip.count === 0) {
    const err = new Error('Leave request already decided concurrently');
    err.code = 'DECISION_RACE';
    throw err;
  }
  if (txn.leaveBalanceId && typeof balanceMove === 'function') {
    const bal = await tx.leaveBalance.findUnique({
      where: { id: txn.leaveBalanceId },
      select: { id: true, version: true, pendingApproval: true, taken: true, closing: true },
    });
    if (bal) {
      const data = balanceMove(bal);
      if (data) {
        await tx.leaveBalance.update({
          where: { id: bal.id, version: bal.version },
          data: { ...data, version: { increment: 1 } },
        });
      }
    }
  }

  // Feature 16 — EAGER leave→attendance bridge. ONLY on the APPROVED transition,
  // ONLY for an APPLICATION row (an accrual/lapse/opening txn has no span). Stamps
  // ON_LEAVE Attendance rows for the leave's working days, in THIS tx, never
  // overwriting a frozen day (RETRO_LWP_DEFERRED). Reuses the SAME working-day
  // netting the apply path used, so an approved LWP day reliably becomes a
  // frozen-eligible LOP day even when no nightly derivation runs. Paid leave is
  // also stamped (lopFraction 0) so the attendance grid shows it and it can NEVER
  // produce LOP. Best-effort: a stamp miss must not roll back the approval, so we
  // swallow + log (the nightly recompute is the reconciler).
  if (toStatus === 'APPROVED' && txn.txnType === 'APPLICATION') {
    try {
      const res = await stampLeaveAttendanceOnApproval(tx, txn);
      if (res && res.deferred && res.deferred.length) {
        // eslint-disable-next-line no-console
        console.warn(`[leaveToAttendance] RETRO_LWP_DEFERRED for txn ${txn.id}: ${res.deferred.length} locked day(s) deferred to next open period`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[leaveToAttendance] stamp failed for txn', txn.id, e && e.message);
    }
  }

  return tx.leaveTransaction.findUnique({ where: { id: txn.id } });
}

// Load the LeaveTransaction APPLICATION row this ApprovalRequest is gating. Tolerant
// of an already-terminal row (a re-fired/duplicate hook is then a no-op). Includes the
// leaveType category so the comp-off seam can gate on it without a second read.
async function loadTxn(tx, approvalRequest) {
  return tx.leaveTransaction.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId, txnType: 'APPLICATION' },
    include: { leaveType: { select: { category: true } } },
  });
}

// onApprove — PENDING → APPROVED. Release the soft-hold into `taken`, drop `closing`.
async function onApprove(approvalRequest, tx) {
  const txn = await loadTxn(tx, approvalRequest);
  if (!txn || txn.status !== 'PENDING') return; // already decided/withdrawn → no-op
  const heldQty = Math.abs(Number(txn.quantity));
  const decidedBy = approvalRequest.decidedBy || null;
  await applyLeaveDecision(tx, {
    txn, toStatus: 'APPROVED', fromStatuses: ['PENDING'], decidedBy,
    balanceMove: (bal) => {
      const release = flooredRelease(bal.pendingApproval, heldQty);
      return {
        pendingApproval: { decrement: release },
        taken: { increment: heldQty },
        closing: { decrement: heldQty },
      };
    },
  });
  // Feature 30 — the ONE category-gated seam. For a COMP_OFF leave only, after the
  // standard balance move, debit the FIFO comp-off LOTS (oldest-expiry-first) so the
  // per-credit expiry ledger stays consistent with the aggregate balance. No-op for
  // every other leave type.
  if (txn.leaveType && isCompOffCategory(txn.leaveType.category)) {
    await debitLotsOnApprove(tx, {
      businessId: approvalRequest.businessId, employeeId: txn.employeeId, units: heldQty,
      leaveTransactionId: txn.id, // finding #5 — persist which lots THIS application debits
    });
  }
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'APPROVED' }).catch(() => {});
}

// onReject — PENDING → REJECTED. Release the hold (floored); no units consumed.
async function onReject(approvalRequest, tx) {
  const txn = await loadTxn(tx, approvalRequest);
  if (!txn || txn.status !== 'PENDING') return;
  const heldQty = Math.abs(Number(txn.quantity));
  const decidedBy = approvalRequest.decidedBy || null;
  await applyLeaveDecision(tx, {
    txn, toStatus: 'REJECTED', fromStatuses: ['PENDING'], decidedBy,
    balanceMove: (bal) => ({ pendingApproval: { decrement: flooredRelease(bal.pendingApproval, heldQty) } }),
  });
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'REJECTED' }).catch(() => {});
}

// onCancel — requester cancel/withdraw of an OPEN request: PENDING → CANCELLED,
// release the hold (floored); no units consumed.
async function onCancel(approvalRequest, tx) {
  const txn = await loadTxn(tx, approvalRequest);
  if (!txn || txn.status !== 'PENDING') return;
  const heldQty = Math.abs(Number(txn.quantity));
  const decidedBy = approvalRequest.decidedBy || null;
  await applyLeaveDecision(tx, {
    txn, toStatus: 'CANCELLED', fromStatuses: ['PENDING'], decidedBy,
    balanceMove: (bal) => ({ pendingApproval: { decrement: flooredRelease(bal.pendingApproval, heldQty) } }),
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerLeaveConsumer() {
  return consumers.register('LEAVE', bundle);
}

// Self-register on module load (idempotent — the registry overwrites the same bundle).
// registerConsumers.js is still the single explicit boot wiring point per §7.5, but
// self-registration guarantees the callback fires for ANY entrypoint that loads the
// leave controller (which requires this module) — tests, scripts, the API — without a
// separate boot require, so the engine path can never silently no-op the balance move.
registerLeaveConsumer();

module.exports = {
  registerLeaveConsumer,
  bundle,
  // exported so the controller's direct (no-engine-request) fallback path reuses the
  // identical balance-move core, and for unit tests.
  applyLeaveDecision,
  flooredRelease,
};

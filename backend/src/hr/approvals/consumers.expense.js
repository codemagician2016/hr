'use strict';

/**
 * consumers.expense.js — Feature 10 slice 10c. The EXPENSE consumer bundle.
 *
 * Replaces the bare `canManageEmployees` status flip in expenses.controller with a
 * real, configurable approval chain. The engine decides WHEN the claim is approved/
 * rejected (manager only for small claims; manager → HR over the threshold via the
 * BUILT_IN_DEFAULT EXPENSE chain's conditional-skip step); these callbacks carry the
 * domain effect — flip ExpenseClaim.status + stamp decidedBy/decidedAt — INSIDE the
 * engine transaction.
 *
 *   onApprove(req, tx) — SUBMITTED → APPROVED, stamp decidedAt/decidedBy.
 *   onReject(req, tx)  — SUBMITTED → REJECTED, stamp decidedAt/decidedBy.
 *   onCancel(req, tx)  — requester cancel of an open claim → CANCELLED.
 *
 * Each flip is a conditional `updateMany(where status='SUBMITTED')` so a duplicate/
 * re-fired hook is a safe no-op (the row is no longer SUBMITTED).
 */

const consumers = require('./consumers');
// Cycle 0 — notify the REQUESTER of the decision on a real channel (email/WhatsApp/
// push) with a deep-link. Fire-and-forget + OUTSIDE the engine tx (default prisma
// client), so a notify failure can never roll back the claim status flip.
const notify = require('./notify');

async function loadClaim(tx, approvalRequest) {
  return tx.expenseClaim.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId, deletedAt: null },
  });
}

// onApprove — SUBMITTED → APPROVED. decidedBy = the request's recorded decider
// (the engine stamps ApprovalRequest.decidedBy with the actor on the terminal flip).
async function onApprove(approvalRequest, tx) {
  const claim = await loadClaim(tx, approvalRequest);
  if (!claim || claim.status !== 'SUBMITTED') return; // no-op on a non-pending claim
  await tx.expenseClaim.updateMany({
    where: { id: claim.id, status: 'SUBMITTED' },
    data: { status: 'APPROVED', decidedAt: new Date(), decidedBy: approvalRequest.decidedBy || null, rejectReason: null },
  });
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'APPROVED' }).catch(() => {});
}

// onReject — SUBMITTED → REJECTED.
async function onReject(approvalRequest, tx) {
  const claim = await loadClaim(tx, approvalRequest);
  if (!claim || claim.status !== 'SUBMITTED') return;
  const reason = (approvalRequest.payloadJson && approvalRequest.payloadJson.rejectReason) || null;
  await tx.expenseClaim.updateMany({
    where: { id: claim.id, status: 'SUBMITTED' },
    data: { status: 'REJECTED', decidedAt: new Date(), decidedBy: approvalRequest.decidedBy || null, rejectReason: reason },
  });
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'REJECTED' }).catch(() => {});
}

// onCancel — requester withdraws an open claim → CANCELLED.
async function onCancel(approvalRequest, tx) {
  const claim = await loadClaim(tx, approvalRequest);
  if (!claim || claim.status !== 'SUBMITTED') return;
  await tx.expenseClaim.updateMany({
    where: { id: claim.id, status: 'SUBMITTED' },
    data: { status: 'CANCELLED' },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerExpenseConsumer() {
  return consumers.register('EXPENSE', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.leave.js, so any
// entrypoint that loads the expense controller wires the callback without depending
// solely on the boot require — the engine path can never silently no-op the flip.
registerExpenseConsumer();

module.exports = { registerExpenseConsumer, bundle };

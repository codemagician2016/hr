'use strict';

/**
 * consumers.redemption.js — Feature 35. The REDEMPTION consumer bundle.
 *
 * The ESS redeem path opens a REDEMPTION request when the tenant's
 * redemptionRequiresApproval switch is on (default). These callbacks carry the
 * domain effect INSIDE the engine transaction:
 *
 *   onApprove(req, tx) — PENDING → APPROVED via the SHARED approve core
 *     (redemption.service.approveRedemptionTx): re-checks the balance IN-TX
 *     (pointsLedger.debit fail-closes + version-locks, so two concurrent
 *     redemptions can never overspend), decrements finite stock (guarded), posts
 *     the -points REDEMPTION ledger row. An INSUFFICIENT_POINTS / OUT_OF_STOCK
 *     throw rolls the whole approval back — the request stays PENDING and the
 *     approver sees the conflict (never a silent overdraft).
 *   onReject(req, tx)  — PENDING → REJECTED (+ the approver's reason). No debit
 *     ever happened (v1 debits on approval — spec §8 debit-timing invariant).
 *   onCancel(req, tx)  — requester withdrew → CANCELLED (no debit).
 */

const consumers = require('./consumers');
const notify = require('./notify');
const redemptionService = require('../recognition/redemption.service');

const NOTIFY_DEFER_MS = 2000;

async function loadRedemption(tx, approvalRequest) {
  return tx.redemption.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

// onApprove — debit + stock + PENDING → APPROVED (idempotent, in the engine tx).
async function onApprove(approvalRequest, tx) {
  const redemption = await loadRedemption(tx, approvalRequest);
  if (!redemption || redemption.status !== 'PENDING') return; // no-op re-fire
  await redemptionService.approveRedemptionTx(tx, {
    redemptionId: redemption.id,
    decidedByUserId: approvalRequest.decidedBy || null,
  });
  // Employee notification AFTER the tx settles (the helper re-reads + no-ops on a
  // rolled-back approve).
  setTimeout(() => {
    redemptionService.notifyRedemption(redemption.id, 'redemption.approved').catch(() => {});
  }, NOTIFY_DEFER_MS);
}

// onReject — PENDING → REJECTED (points untouched — none were held).
async function onReject(approvalRequest, tx) {
  const redemption = await loadRedemption(tx, approvalRequest);
  if (!redemption || redemption.status !== 'PENDING') return;
  const reason = (approvalRequest.payloadJson && approvalRequest.payloadJson.rejectReason) || null;
  await tx.redemption.updateMany({
    where: { id: redemption.id, status: 'PENDING' },
    data: { status: 'REJECTED', rejectReason: reason },
  });
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'REJECTED' }).catch(() => {});
}

// onCancel — requester withdrew → CANCELLED.
async function onCancel(approvalRequest, tx) {
  const redemption = await loadRedemption(tx, approvalRequest);
  if (!redemption || redemption.status !== 'PENDING') return;
  await tx.redemption.updateMany({
    where: { id: redemption.id, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerRedemptionConsumer() {
  return consumers.register('REDEMPTION', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.expense.js.
registerRedemptionConsumer();

module.exports = { registerRedemptionConsumer, bundle };

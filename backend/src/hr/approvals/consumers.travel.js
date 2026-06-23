'use strict';

/**
 * consumers.travel.js — Feature 11. The TRAVEL consumer bundle (mirrors
 * consumers.expense.js). A pre-trip approval routes through the F10 engine for the
 * TRAVEL module (manager → HR over threshold, via the BUILT_IN_DEFAULT TRAVEL chain
 * already present in workflowResolver); these callbacks carry the domain effect —
 * flip TravelRequest.status + stamp decidedBy/decidedAt — INSIDE the engine tx.
 *
 *   onApprove(req, tx) — SUBMITTED → APPROVED (trip green-lit; bills may now attach).
 *   onReject(req, tx)  — SUBMITTED → REJECTED, stamp the reason.
 *   onCancel(req, tx)  — requester withdraw of an open trip → CANCELLED.
 *
 * Each flip is a conditional updateMany(where status='SUBMITTED') so a duplicate/
 * re-fired hook is a safe no-op.
 */

const consumers = require('./consumers');

async function loadTrip(tx, approvalRequest) {
  return tx.travelRequest.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

async function onApprove(approvalRequest, tx) {
  const trip = await loadTrip(tx, approvalRequest);
  if (!trip || trip.status !== 'SUBMITTED') return;
  await tx.travelRequest.updateMany({
    where: { id: trip.id, status: 'SUBMITTED' },
    data: { status: 'APPROVED', decidedAt: new Date(), decidedBy: approvalRequest.decidedBy || null, rejectReason: null },
  });
}

async function onReject(approvalRequest, tx) {
  const trip = await loadTrip(tx, approvalRequest);
  if (!trip || trip.status !== 'SUBMITTED') return;
  const reason = (approvalRequest.payloadJson && approvalRequest.payloadJson.rejectReason) || null;
  await tx.travelRequest.updateMany({
    where: { id: trip.id, status: 'SUBMITTED' },
    data: { status: 'REJECTED', decidedAt: new Date(), decidedBy: approvalRequest.decidedBy || null, rejectReason: reason },
  });
}

async function onCancel(approvalRequest, tx) {
  const trip = await loadTrip(tx, approvalRequest);
  if (!trip || trip.status !== 'SUBMITTED') return;
  await tx.travelRequest.updateMany({
    where: { id: trip.id, status: 'SUBMITTED' },
    data: { status: 'CANCELLED' },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerTravelConsumer() {
  return consumers.register('TRAVEL', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.expense.js.
registerTravelConsumer();

module.exports = { registerTravelConsumer, bundle };

'use strict';

/**
 * consumers.recognition.js — Feature 35. The RECOGNITION consumer bundle.
 *
 * The give path only opens a RECOGNITION request when a give is governed (totalPoints
 * over the tenant threshold, or over the giver's period budget — spec §4.2); the
 * BUILT_IN_DEFAULT chain routes it to the GIVER's manager. These callbacks carry the
 * domain effect INSIDE the engine transaction (mirrors consumers.expense.js):
 *
 *   onApprove(req, tx) — PENDING_APPROVAL → POSTED, then the SHARED posting core
 *     (recognition.service.postRecognitionTx): credit each recipient's wallet
 *     (ledgerEntryId-guarded — never double-credits), stamp postedAt, project the
 *     CELEBRATION announcement onto the engagement feed.
 *   onReject(req, tx)  — PENDING_APPROVAL → REJECTED: ZERO points post and the
 *     recognition is NEVER projected to the feed (spec §8 points-on-reject).
 *   onCancel(req, tx)  — giver withdrew → REJECTED (same zero-effect terminal).
 *
 * Every flip is a conditional updateMany(where status='PENDING_APPROVAL') so a
 * re-fired hook is a safe no-op. Recipient notifications fire AFTER the tx settles
 * (deferred + status-guarded) so an engine rollback can never have blasted anyone.
 */

const consumers = require('./consumers');
const notify = require('./notify');
const recognitionService = require('../recognition/recognition.service');

const NOTIFY_DEFER_MS = 2000;

async function loadRecognition(tx, approvalRequest) {
  return tx.recognition.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

// onApprove — PENDING_APPROVAL → POSTED + credit + project (all in the engine tx).
async function onApprove(approvalRequest, tx) {
  const recognition = await loadRecognition(tx, approvalRequest);
  if (!recognition || recognition.status !== 'PENDING_APPROVAL') return; // no-op re-fire
  const flip = await tx.recognition.updateMany({
    where: { id: recognition.id, status: 'PENDING_APPROVAL' },
    data: { status: 'POSTED' },
  });
  if (flip.count === 0) return;
  await recognitionService.postRecognitionTx(tx, { recognitionId: recognition.id });
  // Recipient fan-out AFTER the tx settles — the helper re-reads via the default
  // client and no-ops unless the recognition committed as POSTED.
  setTimeout(() => {
    recognitionService.notifyRecognitionPosted(recognition.id).catch(() => {});
  }, NOTIFY_DEFER_MS);
}

// onReject — PENDING_APPROVAL → REJECTED. No points, no feed projection.
async function onReject(approvalRequest, tx) {
  const recognition = await loadRecognition(tx, approvalRequest);
  if (!recognition || recognition.status !== 'PENDING_APPROVAL') return;
  await tx.recognition.updateMany({
    where: { id: recognition.id, status: 'PENDING_APPROVAL' },
    data: { status: 'REJECTED' },
  });
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'REJECTED' }).catch(() => {});
}

// onCancel — the giver withdrew a pending give → REJECTED (zero-effect terminal;
// the Recognition status vocabulary has no CANCELLED — spec §3.2).
async function onCancel(approvalRequest, tx) {
  const recognition = await loadRecognition(tx, approvalRequest);
  if (!recognition || recognition.status !== 'PENDING_APPROVAL') return;
  await tx.recognition.updateMany({
    where: { id: recognition.id, status: 'PENDING_APPROVAL' },
    data: { status: 'REJECTED' },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerRecognitionConsumer() {
  return consumers.register('RECOGNITION', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.expense.js.
registerRecognitionConsumer();

module.exports = { registerRecognitionConsumer, bundle };

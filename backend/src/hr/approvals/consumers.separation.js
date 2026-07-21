'use strict';

/**
 * consumers.separation.js — Program Phase 2 Wave B: the SEPARATION consumer.
 *
 * The gated act is FNF APPROVAL. onApprove runs the SAME mint core as the
 * direct approve-fnf route (offboarding.controller._mintFnfApproval): mint the
 * FnF PayRun from the persisted snapshot + flip FNF_APPROVED — inside the
 * engine tx, idempotent on (status FNF_COMPUTED ∧ no fnfPayRunId), closing the
 * double-PayRun risk from the audit. onReject leaves the case at FNF_COMPUTED
 * (HR reworks + recomputes, which supersedes the request); onCancel is the
 * recompute-supersede/no-op path.
 */

const consumers = require('./consumers');

async function onApprove(approvalRequest, tx) {
  const sep = await tx.separationCase.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
  if (!sep) return;
  const { _mintFnfApproval } = require('../lifecycle/controllers/offboarding.controller');
  await _mintFnfApproval(tx, {
    businessId: approvalRequest.businessId,
    sep,
    actorUserId: approvalRequest.decidedBy || 'SYSTEM',
  });
}

async function onReject() { /* case stays FNF_COMPUTED — rework + recompute reopens */ }
async function onCancel() { /* superseded by recompute / case cancel — nothing to undo */ }

function registerSeparationConsumer() {
  consumers.register('SEPARATION', { onApprove, onReject, onCancel });
}

registerSeparationConsumer();

module.exports = { registerSeparationConsumer };

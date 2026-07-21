'use strict';

/**
 * consumers.compensation.js — Program Phase 2: the COMPENSATION consumer.
 *
 * onApprove carries the PROPOSED → EFFECTIVE commit exactly as
 * compensation.controller revisions.approve does: supersede the prior
 * isCurrent revision (close effectiveTo the day before the new effectiveFrom)
 * and flip this one EFFECTIVE + isCurrent inside the engine tx — so a decision
 * from the approvals inbox and the legacy direct route produce byte-identical
 * supersession. onReject mirrors revisions.reject. A PROPOSED guard makes a
 * duplicate hook fire (or a decision racing the legacy route) a no-op — the
 * double-supersession risk flagged in the Phase-2 audit.
 *
 * SoD: the legacy route keeps its own fail-closed proposer≠approver check; the
 * inbox path relies on the engine's actor≠requester guard.
 */

const consumers = require('./consumers');

async function loadRevision(tx, approvalRequest) {
  return tx.compensationRevision.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

async function onApprove(approvalRequest, tx) {
  const rev = await loadRevision(tx, approvalRequest);
  if (!rev || rev.status !== 'PROPOSED') return; // decided already → no-op
  const effFrom = new Date(rev.effectiveFrom);
  const prior = await tx.compensationRevision.findFirst({
    where: { businessId: rev.businessId, employeeId: rev.employeeId, isCurrent: true, id: { not: rev.id } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (prior) {
    const closeAt = new Date(effFrom);
    closeAt.setUTCDate(closeAt.getUTCDate() - 1);
    await tx.compensationRevision.update({
      where: { id: prior.id },
      data: { isCurrent: false, effectiveTo: prior.effectiveFrom < effFrom ? closeAt : prior.effectiveTo },
    });
  }
  await tx.compensationRevision.update({
    where: { id: rev.id },
    data: {
      status: 'EFFECTIVE',
      isCurrent: true,
      approvedById: approvalRequest.decidedBy || null,
      approvedAt: new Date(),
    },
  });
}

async function onReject(approvalRequest, tx) {
  const rev = await loadRevision(tx, approvalRequest);
  if (!rev || rev.status !== 'PROPOSED') return;
  await tx.compensationRevision.update({
    where: { id: rev.id },
    data: { status: 'REJECTED', isCurrent: false },
  });
}

async function onCancel(approvalRequest, tx) {
  const rev = await loadRevision(tx, approvalRequest);
  if (!rev || rev.status !== 'PROPOSED') return;
  await tx.compensationRevision.update({
    where: { id: rev.id },
    data: { status: 'WITHDRAWN', isCurrent: false },
  });
}

function registerCompensationConsumer() {
  consumers.register('COMPENSATION', { onApprove, onReject, onCancel });
}

registerCompensationConsumer();

module.exports = { registerCompensationConsumer };

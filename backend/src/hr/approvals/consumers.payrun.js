'use strict';

/**
 * consumers.payrun.js — Program Phase 2 Wave B: the PAYRUN consumer.
 *
 * PAYRUN already owns a hardened maker-checker (four-eyes, STALE_TOTALS,
 * OPEN_BLOCKERS — payroll/payrun.js + service.approveRun). The engine NEVER
 * re-implements those guards; it DELEGATES:
 *
 *   inbox onApprove → service.approveRun({ actorId: decidedBy }) — every guard
 *   runs; a guard failure THROWS, rolling back the engine decision so the
 *   request stays PENDING and the approver sees the real error (STALE_TOTALS
 *   etc.). service.approveRun uses the global client (its own atomicity), so
 *   on the rare engine-tx failure AFTER a successful approve the request can
 *   lag terminal — the run itself is always guard-valid.
 *
 *   inbox onReject → service.sendBackRun (REVIEW → CALCULATED) with the
 *   decision comment as the send-back reason.
 *
 * The legacy /approve route runs service.approveRun FIRST (guards), then marks
 * the open request decided — see payroll.controller. Consumer no-ops when the
 * run is already past the gate (duplicate fire).
 */

const consumers = require('./consumers');

async function onApprove(approvalRequest) {
  const service = require('../payroll/service');
  const prisma = require('../../core/lib/prisma');
  const run = await prisma.payRun.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
    select: { status: true },
  });
  if (!run || !['COMPUTED', 'REVIEW'].includes(run.status)) return; // already decided
  await service.approveRun({
    businessId: approvalRequest.businessId,
    actorId: approvalRequest.decidedBy || 'SYSTEM',
    payRunId: approvalRequest.entityId,
  });
}

async function onReject(approvalRequest, tx) {
  const service = require('../payroll/service');
  const prisma = require('../../core/lib/prisma');
  const run = await prisma.payRun.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
    select: { status: true },
  });
  if (!run || run.status !== 'REVIEW') return;
  const lastAction = await tx.approvalAction.findFirst({
    where: { approvalRequestId: approvalRequest.id, decision: 'REJECTED' },
    orderBy: { createdAt: 'desc' },
    select: { comment: true },
  });
  await service.sendBackRun({
    businessId: approvalRequest.businessId,
    actorId: approvalRequest.decidedBy || 'SYSTEM',
    payRunId: approvalRequest.entityId,
    reason: (lastAction && lastAction.comment) || 'Rejected via approvals',
  });
}

async function onCancel() { /* send-back / cancel / reopen own the run state */ }

function registerPayrunConsumer() {
  consumers.register('PAYRUN', { onApprove, onReject, onCancel });
}

registerPayrunConsumer();

module.exports = { registerPayrunConsumer };

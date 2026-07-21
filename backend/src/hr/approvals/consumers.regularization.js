'use strict';

/**
 * consumers.regularization.js — Program Phase 2: ATTENDANCE_REGULARIZATION.
 *
 * The domain effect on APPROVE is heavy and MUST stay inside the engine tx:
 * materialize MANUAL IN/OUT punches from the requested in/out (deduped on
 * regularizationRequestId) and re-derive the affected civil day via
 * attendance/service.recompute — byte-identical to the controller's
 * decideRegularization APPROVED branch. Reject is a stamp-only flip.
 * A PENDING guard makes duplicate hook fires no-ops.
 */

const consumers = require('./consumers');

async function loadRow(tx, approvalRequest) {
  return tx.attendanceRegularizationRequest.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

async function onApprove(approvalRequest, tx) {
  const reqRow = await loadRow(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return;
  const { businessId } = approvalRequest;

  await tx.attendanceRegularizationRequest.update({
    where: { id: reqRow.id },
    data: { status: 'APPROVED', decidedBy: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });

  // Punch-bearing kinds materialize corrected IN/OUT rows (controller idiom).
  const punches = [];
  if (reqRow.kind === 'MISSED_PUNCH' || reqRow.requestedInAt || reqRow.requestedOutAt) {
    if (reqRow.requestedInAt) {
      punches.push({ businessId, employeeId: reqRow.employeeId, punchType: 'IN', source: 'MANUAL', punchAt: reqRow.requestedInAt, isManual: false, regularizationRequestId: reqRow.id });
    }
    if (reqRow.requestedOutAt) {
      punches.push({ businessId, employeeId: reqRow.employeeId, punchType: 'OUT', source: 'MANUAL', punchAt: reqRow.requestedOutAt, isManual: false, regularizationRequestId: reqRow.id });
    }
  }
  for (const p of punches) {
    const existing = await tx.attendancePunch.findFirst({
      where: { businessId, employeeId: p.employeeId, punchType: p.punchType, punchAt: p.punchAt, regularizationRequestId: reqRow.id },
      select: { id: true },
    });
    if (!existing) await tx.attendancePunch.create({ data: p });
  }

  // Re-derive the affected day INSIDE the engine tx (lazy require — the
  // attendance service itself reaches the engine via controllers).
  const { recompute } = require('../attendance/service');
  await recompute(businessId, reqRow.employeeId, reqRow.date, reqRow.date, tx);
}

async function onReject(approvalRequest, tx) {
  const reqRow = await loadRow(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return;
  await tx.attendanceRegularizationRequest.update({
    where: { id: reqRow.id },
    data: { status: 'REJECTED', decidedBy: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
}

async function onCancel(approvalRequest, tx) {
  const reqRow = await loadRow(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return;
  await tx.attendanceRegularizationRequest.update({
    where: { id: reqRow.id },
    data: { status: 'CANCELLED', decidedAt: new Date() },
  });
}

function registerRegularizationConsumer() {
  consumers.register('ATTENDANCE_REGULARIZATION', { onApprove, onReject, onCancel });
}

registerRegularizationConsumer();

module.exports = { registerRegularizationConsumer };

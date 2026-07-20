'use strict';

/**
 * consumers.faceEnrollment.js — Feature 39. The FACE_ENROLLMENT consumer bundle.
 *
 * The engine decides WHEN the chain completes; the domain effect — flipping the
 * FaceEnrollment's status so it becomes (or never becomes) the live face-matching
 * reference — is carried HERE, fired INSIDE the engine transaction (mirrors
 * consumers.profileChange, the closest analog: an ESS-submitted change HR must
 * approve before it takes effect).
 *
 *   onApprove — status PENDING → ACTIVE: the reference goes live; face punches for
 *               this employee start matching against it. Notify the employee.
 *   onReject  — status PENDING → REJECTED (+ HR's reason from payloadJson.rejectReason
 *               into decisionNote, surfaced on the ESS enrolment card). Notify.
 *   onCancel  — the request was superseded by a newer enrolment (or withdrawn):
 *               strictly a no-op unless this request is STILL the row's gating
 *               request — a superseded row was already overwritten to a new PENDING
 *               capture with its own request, and must not be touched.
 *
 * Every hook is guarded by `row.approvalRequestId === request.id && status===PENDING`
 * so a duplicate/late/stale fire can never clobber a newer enrolment. SoD (the
 * employee cannot approve their own face) is enforced by the engine itself.
 */

const consumers = require('./consumers');

async function loadRow(tx, approvalRequest) {
  return tx.faceEnrollment.findFirst({
    where: {
      id: approvalRequest.entityId,
      businessId: approvalRequest.businessId,
      approvalRequestId: approvalRequest.id, // stale/superseded request → no row → no-op
    },
  });
}

async function notifyEmployee(tx, businessId, employeeId, outcome, reason) {
  try {
    const emp = await tx.employee.findFirst({ where: { id: employeeId, businessId }, select: { userId: true } });
    if (!emp || !emp.userId) return;
    await tx.notification.create({
      data: {
        businessId,
        recipientUserId: emp.userId,
        type: 'APPROVAL_PENDING',
        channel: 'IN_APP',
        title: outcome === 'ACTIVE' ? 'Face registration approved' : 'Face registration declined',
        body: outcome === 'ACTIVE'
          ? 'HR approved your face registration — you can now use face check-in.'
          : `HR declined your face registration${reason ? `: ${reason}` : ''}. You can retake and resubmit.`,
        entityType: 'FaceEnrollment',
        entityId: null,
        dataJson: { outcome, reason: reason || null },
      },
    });
  } catch (_e) { /* best-effort; a notification failure must not roll back the flip */ }
}

async function onApprove(approvalRequest, tx) {
  const row = await loadRow(tx, approvalRequest);
  if (!row || row.status !== 'PENDING') return;
  await tx.faceEnrollment.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: {
      status: 'ACTIVE',
      isActive: true,
      decidedBy: approvalRequest.decidedBy || null,
      decidedAt: new Date(),
      decisionNote: null,
      version: { increment: 1 },
    },
  });
  await notifyEmployee(tx, row.businessId, row.employeeId, 'ACTIVE', null);
}

async function onReject(approvalRequest, tx) {
  const row = await loadRow(tx, approvalRequest);
  if (!row || row.status !== 'PENDING') return;
  const reason = (approvalRequest.payloadJson && approvalRequest.payloadJson.rejectReason) || null;
  await tx.faceEnrollment.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      decidedBy: approvalRequest.decidedBy || null,
      decidedAt: new Date(),
      decisionNote: reason,
      version: { increment: 1 },
    },
  });
  await notifyEmployee(tx, row.businessId, row.employeeId, 'REJECTED', reason);
}

async function onCancel(approvalRequest, tx) {
  const row = await loadRow(tx, approvalRequest);
  if (!row || row.status !== 'PENDING') return; // superseded → the new capture owns the row
  await tx.faceEnrollment.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: { status: 'REJECTED', decidedAt: new Date(), decisionNote: 'Withdrawn', version: { increment: 1 } },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerFaceEnrollmentConsumer() {
  return consumers.register('FACE_ENROLLMENT', bundle);
}

// Self-register on module load (idempotent), mirroring every other consumer.
registerFaceEnrollmentConsumer();

module.exports = { registerFaceEnrollmentConsumer, bundle };

'use strict';

/**
 * consumers.timesheet.js — Program Phase 2: the TIMESHEET consumer bundle.
 *
 * Approve/reject are stamp-only flips (SUBMITTED → APPROVED/REJECTED with
 * decidedAt/decidedBy), byte-identical to attendance.controller's
 * transitionTimesheet. LOCK (period close) stays a manual post-approval step —
 * deliberately NOT engine-driven (it belongs to the payroll period close).
 * Conditional updateMany guards make a duplicate hook re-fire a no-op.
 */

const consumers = require('./consumers');

async function flip(approvalRequest, tx, toStatus) {
  await tx.timesheet.updateMany({
    where: {
      id: approvalRequest.entityId,
      businessId: approvalRequest.businessId,
      status: 'SUBMITTED',
    },
    data: {
      status: toStatus,
      decidedAt: new Date(),
      decidedBy: approvalRequest.decidedBy || null,
    },
  });
}

async function onApprove(approvalRequest, tx) { await flip(approvalRequest, tx, 'APPROVED'); }
async function onReject(approvalRequest, tx) { await flip(approvalRequest, tx, 'REJECTED'); }
// Withdraw/cancel of the request returns the sheet to DRAFT so the employee can
// amend + resubmit (no DRAFT→CANCELLED state exists for timesheets).
async function onCancel(approvalRequest, tx) {
  await tx.timesheet.updateMany({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId, status: 'SUBMITTED' },
    data: { status: 'DRAFT' },
  });
}

function registerTimesheetConsumer() {
  consumers.register('TIMESHEET', { onApprove, onReject, onCancel });
}

registerTimesheetConsumer();

module.exports = { registerTimesheetConsumer };

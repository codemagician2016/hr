'use strict';

/**
 * consumers.overtime.js — the OVERTIME consumer bundle (OT pre-approval).
 *
 * OT pre-approval routes through the F10 engine under its own WorkflowModule
 * (OVERTIME) — the reporting manager authorizes the overtime minutes (built-in
 * REPORTING_MANAGER chain, escalate @48h). These callbacks carry the domain
 * effect INSIDE the engine transaction (mirrors consumers.compOff.js):
 *
 *   onApprove(req, tx) — PENDING → APPROVED (+ decidedByUserId / decidedAt). The
 *                        attendance derivation then credits OT up to these minutes
 *                        (when the resolved OvertimeRule.requirePreApproval is on).
 *   onReject(req, tx)  — PENDING → REJECTED. No OT is authorized (gate credits 0).
 *   onCancel(req, tx)  — requester withdrew → CANCELLED. No OT authorized.
 *
 * Each flip is conditional (updateMany guarded on status=PENDING) so a duplicate /
 * re-fired hook is a safe no-op. Self-registers on load like consumers.compOff.js.
 */

const consumers = require('./consumers');

async function loadRequest(tx, approvalRequest) {
  return tx.overtimeRequest.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

// Conditional-flip PENDING → status. Atomic + idempotent (only fires from PENDING),
// so a re-delivered hook or a race can never double-decide the row.
async function flip(tx, approvalRequest, status) {
  const reqRow = await loadRequest(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return; // already decided / voided → no-op
  await tx.overtimeRequest.updateMany({
    where: { id: reqRow.id, status: 'PENDING' },
    data: {
      status,
      decidedByUserId: approvalRequest.decidedBy || null,
      decidedAt: new Date(),
    },
  });
}

async function onApprove(approvalRequest, tx) { await flip(tx, approvalRequest, 'APPROVED'); }
async function onReject(approvalRequest, tx) { await flip(tx, approvalRequest, 'REJECTED'); }
async function onCancel(approvalRequest, tx) { await flip(tx, approvalRequest, 'CANCELLED'); }

const bundle = { onApprove, onReject, onCancel };

function registerOvertimeConsumer() {
  return consumers.register('OVERTIME', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.compOff.js.
registerOvertimeConsumer();

module.exports = { registerOvertimeConsumer, bundle };

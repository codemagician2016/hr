'use strict';

/**
 * consumers.asset.js — Program Phase 2: the ASSET consumer.
 *
 * ASSET had NO approval concept — assign was a direct HR act. The engine now
 * gates the HAND-OVER: assign() opens an ASSET request whose payload carries
 * the assignment args; the ASSIGNMENT IS CREATED HERE on approval (asset →
 * ASSIGNED atomically). With the AUTO_APPROVE built-in default the request
 * terminalizes inside the same tx and behaviour is byte-identical to the old
 * direct create; a tenant-authored chain (e.g. IT sign-off) makes assign()
 * return 202-pending until approved. Reject/cancel create nothing — the asset
 * simply stays AVAILABLE.
 *
 * Idempotency: the open-assignment guard re-checks inside the tx; a duplicate
 * hook fire or a racing manual assign leaves exactly one open assignment.
 */

const consumers = require('./consumers');

async function onApprove(approvalRequest, tx) {
  const { businessId } = approvalRequest;
  const p = (approvalRequest.payloadJson && approvalRequest.payloadJson.assignment) || null;
  if (!p || !p.assetId || !p.employeeId) return;

  const asset = await tx.asset.findFirst({ where: { id: p.assetId, businessId, deletedAt: null } });
  if (!asset) return;
  const openExisting = await tx.assetAssignment.findFirst({
    where: { assetId: p.assetId, businessId, returnedAt: null },
    select: { id: true },
  });
  if (openExisting) return; // already assigned (duplicate fire / racing manual assign)

  await tx.assetAssignment.create({
    data: {
      businessId,
      assetId: p.assetId,
      employeeId: p.employeeId,
      assignedAt: p.assignedAt ? new Date(p.assignedAt) : new Date(),
      ...(p.conditionOut !== undefined && p.conditionOut !== null ? { conditionOut: p.conditionOut } : {}),
      ...(p.notes !== undefined && p.notes !== null ? { notes: p.notes } : {}),
      status: 'ASSIGNED',
    },
  });
  await tx.asset.update({ where: { id: p.assetId }, data: { status: 'ASSIGNED' } });
}

async function onReject() { /* nothing was created — asset stays AVAILABLE */ }
async function onCancel() { /* nothing was created — asset stays AVAILABLE */ }

function registerAssetConsumer() {
  consumers.register('ASSET', { onApprove, onReject, onCancel });
}

registerAssetConsumer();

module.exports = { registerAssetConsumer };

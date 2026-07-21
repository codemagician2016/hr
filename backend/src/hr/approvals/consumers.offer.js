'use strict';

/**
 * consumers.offer.js — Program Phase 2 Wave B: the OFFER consumer.
 *
 * OFFER never had an internal approval — only send/accept SoD. This activates
 * the schema's dormant PENDING_APPROVAL/APPROVED states: when a tenant authors
 * an OFFER chain (built-in default is AUTO_APPROVE → nothing changes),
 * sendOffer on a DRAFT parks the offer PENDING_APPROVAL and opens the request;
 * onApprove flips it APPROVED (send can then proceed — sendOffer accepts
 * APPROVED); onReject/onCancel return it to DRAFT for rework. The send/accept
 * SoD (panellist/scorer conflict) is untouched — it guards the candidate-facing
 * dispatch, not this internal gate.
 */

const consumers = require('./consumers');

async function flip(approvalRequest, tx, toStatus) {
  await tx.offer.updateMany({
    where: {
      id: approvalRequest.entityId,
      businessId: approvalRequest.businessId,
      status: 'PENDING_APPROVAL',
    },
    data: { status: toStatus },
  });
}

async function onApprove(approvalRequest, tx) { await flip(approvalRequest, tx, 'APPROVED'); }
async function onReject(approvalRequest, tx) { await flip(approvalRequest, tx, 'DRAFT'); }
async function onCancel(approvalRequest, tx) { await flip(approvalRequest, tx, 'DRAFT'); }

function registerOfferConsumer() {
  consumers.register('OFFER', { onApprove, onReject, onCancel });
}

registerOfferConsumer();

module.exports = { registerOfferConsumer };

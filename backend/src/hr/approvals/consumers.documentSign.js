'use strict';

/**
 * consumers.documentSign.js — Program Phase 2: the DOCUMENT_SIGN consumer.
 *
 * Signing itself IS a workflow (signer magic-links), so the engine gates the
 * only non-conflicting seam: the DISPATCH. createEnvelope opens a
 * DOCUMENT_SIGN request whose payload carries the envelope args; the ENVELOPE
 * IS CREATED HERE on approval (builtin provider mints tokens + flips SENT).
 * With the AUTO_APPROVE built-in default this happens inside the same tx and
 * the controller returns the invite tokens exactly as before; under a
 * tenant-authored chain the controller returns 202-pending and, on approval,
 * this consumer emails each signer their sign link directly (the one-shot
 * tokens can no longer ride the API response).
 */

const consumers = require('./consumers');

async function onApprove(approvalRequest, tx) {
  const args = approvalRequest.payloadJson && approvalRequest.payloadJson.envelope;
  if (!args || !args.subject) return;
  const { businessId } = approvalRequest;

  // Idempotency: skip when an envelope for this request was already created.
  if (approvalRequest.payloadJson && approvalRequest.payloadJson._envelopeId) return;

  const esign = require('../lifecycle/esign');
  const provider = esign.getProvider('BUILTIN');
  const out = await provider.createEnvelope({
    businessId,
    subject: args.subject,
    employeeDocumentId: args.employeeDocumentId || null,
    documentTemplateId: args.documentTemplateId || null,
    signers: args.signers,
    sequential: !!args.sequential,
    expiresAt: args.expiresAt || null,
  }, tx);

  await tx.approvalRequest.update({
    where: { id: approvalRequest.id },
    data: { payloadJson: { ...approvalRequest.payloadJson, _envelopeId: out.envelope.id } },
  });

  // Deliver the one-shot sign links straight to the signers (fire-and-forget,
  // outside this tx — a mail failure must never roll back the envelope).
  try {
    const { notifyHrEvent } = require('../integrations/notifications');
    // The /onboarding?signToken=… page that consumes this link lives in the ESS
    // app, which is served on the TENANT host and resolves the tenant FROM that
    // host. This used to mirror approvals/notify.js and build the link on the
    // PLATFORM host, where /onboarding is the tenant-SIGNUP page — so a signer
    // clicking through was dropped into "create your company" instead of the
    // document they were asked to sign. Measured: drifthr.com/onboarding → 307
    // (signup), demo.drifthr.com/onboarding → 200 (the signing page).
    const { tenantAppBaseUrl, adminAppBaseUrl } = require('../../core/lib/appUrls');
    // This module has no module-level prisma — it works through the passed `tx`.
    // Required here rather than assumed; a bare `prisma.` would have thrown
    // "prisma is not defined" the first time a real signer link was sent, and no
    // test covers this path.
    const prisma = require('../../core/lib/prisma');
    const signerBiz = await prisma.business.findUnique({
      where: { id: businessId }, select: { slug: true },
    }).catch(() => null);
    // No slug → admin host rather than the platform host: still not the signing
    // page, but it does not hand the signer a company-signup form.
    const base = tenantAppBaseUrl(signerBiz && signerBiz.slug) || adminAppBaseUrl();
    for (const s of out.signers || []) {
      if (!s.email || !s.rawToken) continue;
      notifyHrEvent({
        businessId,
        event: 'esign.invite',
        recipientEmail: s.email,
        variables: {
          signerName: s.name || s.email,
          subject: args.subject,
          link: `${base}/onboarding?signToken=${encodeURIComponent(s.rawToken)}`,
        },
        triggeredBy: `HR_ESIGN_INVITE:${out.envelope.id}:${s.id}`,
      }).catch(() => {});
    }
  } catch (_e) { /* best-effort */ }
}

async function onReject() { /* nothing was dispatched */ }
async function onCancel() { /* nothing was dispatched */ }

function registerDocumentSignConsumer() {
  consumers.register('DOCUMENT_SIGN', { onApprove, onReject, onCancel });
}

registerDocumentSignConsumer();

module.exports = { registerDocumentSignConsumer };

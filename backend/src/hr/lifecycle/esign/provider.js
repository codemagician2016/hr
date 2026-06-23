'use strict';

/**
 * provider.js — the EsignProvider interface + registry (Feature 4 §3.2, §4.4,
 * slice 4d).
 *
 * A provider is the seam every e-sign vendor adapter (DocuSign / Zoho / Adobe /
 * Digio / Leegality) will slot into. In v1 only BUILTIN is registered — the
 * in-house signature-capture + audit-stamp flow (esign/builtin.js). Vendor
 * adapters are a later additive pass against the SAME SignatureEnvelope /
 * SignatureSigner tables + HMAC webhooks; they implement this same shape so the
 * controller is provider-agnostic.
 *
 * Interface (every method is async, takes a Prisma client/tx as the last arg so
 * the caller controls the transaction):
 *
 *   createEnvelope(input, prisma) -> { envelope, signers: [{ ...signer, rawToken? }] }
 *       input: { businessId, documentTemplateId?|employeeDocumentId?, subject,
 *                signers: [{ role, name, email, employeeId?, userId?, signerOrder? }],
 *                sequential?, expiresAt? }
 *       Creates the DRAFT envelope + SignatureSigner rows. BUILTIN mints a per-
 *       signer hashed magic-link token (rawToken returned ONLY here, for the
 *       invite — never persisted) and flips the envelope to SENT.
 *
 *   sign(input, prisma) -> { signer, envelope, completed }
 *       input: { token, signatureImageDataUrl, consent, ip, userAgent }
 *       Resolves the signer by token hash (timing-safe), enforces SEQUENTIAL
 *       order, captures ip/ua/consentAt + signatureHash, stores the signature.
 *       When all signers are SIGNED → re-stamp / certify + COMPLETED.
 *
 *   getStatus({ businessId, envelopeId }, prisma) -> envelope + signers (public)
 *
 *   void({ businessId, envelopeId, reason }, prisma) -> envelope (VOIDED)
 */

const registry = new Map();

function register(name, impl) {
  if (!impl || typeof impl.createEnvelope !== 'function') {
    throw new Error(`EsignProvider "${name}" must implement createEnvelope/sign/getStatus/void`);
  }
  registry.set(name, impl);
}

// Resolve a provider by its EsignProvider enum value. v1: only BUILTIN exists; an
// unknown/unregistered provider is an explicit error (never a silent no-op).
function getProvider(name = 'BUILTIN') {
  const impl = registry.get(name);
  if (!impl) throw new Error(`Unknown e-sign provider: ${name}`);
  return impl;
}

function listProviders() {
  return [...registry.keys()];
}

module.exports = { register, getProvider, listProviders };

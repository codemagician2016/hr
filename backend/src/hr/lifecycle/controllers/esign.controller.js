'use strict';

/**
 * esign.controller.js — built-in e-sign HTTP surface (Feature 4 §4.4, §4.6,
 * slice 4d). Mounted at /api/hr/esign.
 *
 * Two RBAC postures:
 *   (1) HR operator routes (createEnvelope / getEnvelope) — protect +
 *       requirePermission(canManageOnboarding|canGenerateLetters) +
 *       withEmployeeScope. The envelope's SUBJECT employee (resolved from the
 *       linked EmployeeDocument) must be in the actor's scope; out-of-team → 404.
 *   (2) PUBLIC token routes (GET/POST /sign/:token) — the TOKEN is the auth. They
 *       are NOT employee-scoped (a candidate signer may have no portal account at
 *       all), but they ARE tenant-correct: the businessId is derived from the
 *       envelope the token resolves to, never from any client hint. An expired /
 *       invalid token is a 401 with no signature recorded.
 *
 * All signing logic lives in the provider (esign/builtin.js, the only v1
 * provider). The controller is a thin, provider-agnostic adapter.
 */

const prisma = require('../../../core/lib/prisma');
const { scopeAllows } = require('../../lib/scopeResolver');
const esign = require('../esign'); // registers BUILTIN; exposes getProvider
const { sha256Hex } = require('../esign/builtin');

// Public shape for an envelope + signers (never leaks accessTokenHash).
function publicEnvelope(env) {
  if (!env) return null;
  return {
    id: env.id,
    subject: env.subject,
    status: env.status,
    provider: env.provider,
    sequential: env.sequential,
    employeeDocumentId: env.employeeDocumentId,
    documentTemplateId: env.documentTemplateId,
    finalFileUrl: env.finalFileUrl,
    certificateUrl: env.certificateUrl,
    expiresAt: env.expiresAt,
    sentAt: env.sentAt,
    completedAt: env.completedAt,
    voidedReason: env.voidedReason,
    createdAt: env.createdAt,
    signers: (env.signers || []).map(publicSigner),
  };
}

function publicSigner(s) {
  return {
    id: s.id,
    signerOrder: s.signerOrder,
    role: s.role,
    name: s.name,
    email: s.email,
    status: s.status,
    signedAt: s.signedAt,
    consentAt: s.consentAt,
    signatureImageUrl: s.signatureImageUrl,
    signatureHash: s.signatureHash,
  };
}

// Resolve the envelope's subject employee (for the F1 scope guard). An envelope
// bound to an EmployeeDocument inherits that doc's employeeId; a template-only
// envelope (generated-on-the-fly) has no subject → ALL-band (HR) only.
async function resolveEnvelopeSubject(businessId, envelope) {
  if (!envelope) return null;
  if (envelope.employeeDocumentId) {
    const doc = await prisma.employeeDocument.findFirst({
      where: { id: envelope.employeeDocumentId, businessId },
      select: { employeeId: true },
    });
    return doc ? doc.employeeId : null;
  }
  // A signer who is an Employee is also a subject anchor.
  const empSigner = (envelope.signers || []).find((s) => s.employeeId);
  return empSigner ? empSigner.employeeId : null;
}

// ── POST /envelopes (HR) ─────────────────────────────────────────────────────
// Create + send a signature envelope. Body: { subject, employeeDocumentId? |
// documentTemplateId?, signers:[{role,name,email,employeeId?,userId?,signerOrder?}],
// sequential?, expiresAt? }. Scope: the envelope's subject employee must be in
// the actor's scope (resolved from the linked EmployeeDocument).
async function createEnvelope(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const { subject, signers } = body;
    if (!subject) return res.status(400).json({ message: 'subject is required' });
    if (!Array.isArray(signers) || signers.length === 0) {
      return res.status(400).json({ message: 'at least one signer is required' });
    }
    if (!body.employeeDocumentId && !body.documentTemplateId) {
      return res.status(400).json({ message: 'employeeDocumentId or documentTemplateId is required' });
    }

    // Scope guard: when binding to an EmployeeDocument, the subject employee must
    // be in scope (404 out-of-team, IDOR-safe). Also validates the doc is this
    // tenant's. A template-only envelope is HR (ALL-band) only.
    if (body.employeeDocumentId) {
      const doc = await prisma.employeeDocument.findFirst({
        where: { id: body.employeeDocumentId, businessId, deletedAt: null },
        select: { id: true, employeeId: true },
      });
      if (!doc) return res.status(404).json({ message: 'Document not found' });
      if (req.scope && req.scope.kind !== 'ALL' && !scopeAllows(req.scope, doc.employeeId)) {
        return res.status(404).json({ message: 'Document not found' });
      }
    } else if (req.scope && req.scope.kind !== 'ALL') {
      // No subject anchor + not ALL-band → out of reach.
      return res.status(404).json({ message: 'Not found' });
    }

    if (body.documentTemplateId) {
      const tpl = await prisma.documentTemplate.findFirst({
        where: { id: body.documentTemplateId, businessId, deletedAt: null },
        select: { id: true },
      });
      if (!tpl) return res.status(404).json({ message: 'Document template not found' });
    }

    const provider = esign.getProvider('BUILTIN');
    const out = await provider.createEnvelope({
      businessId,
      subject,
      employeeDocumentId: body.employeeDocumentId || null,
      documentTemplateId: body.documentTemplateId || null,
      signers,
      sequential: !!body.sequential,
      expiresAt: body.expiresAt || null,
    }, prisma);

    // The raw magic-link tokens are returned ONCE here (the invite payload). For
    // SEQUENTIAL envelopes only the first signer's link is "live"; the rest are
    // returned too but the sign route enforces order, so a leaked later token is
    // inert until its turn. The caller (or a later notifications pass) emails them.
    const inviteSigners = out.signers.map((s) => ({
      id: s.id, signerOrder: s.signerOrder, role: s.role, name: s.name, email: s.email,
      status: s.status, token: s.rawToken,
    }));

    res.status(201).json({ envelope: publicEnvelope({ ...out.envelope, signers: out.signers }), signers: inviteSigners });
  } catch (e) { next(e); }
}

// ── GET /envelopes/:id (HR, scoped) ──────────────────────────────────────────
async function getEnvelope(req, res, next) {
  try {
    const { businessId } = req.user;
    const envelope = await prisma.signatureEnvelope.findFirst({
      where: { id: req.params.id, businessId },
      include: { signers: { orderBy: { signerOrder: 'asc' } } },
    });
    if (!envelope) return res.status(404).json({ message: 'Envelope not found' });
    // Subject-scope guard (manager TEAM band): out-of-team → 404.
    if (req.scope && req.scope.kind !== 'ALL') {
      const subject = await resolveEnvelopeSubject(businessId, envelope);
      if (!subject || !scopeAllows(req.scope, subject)) {
        return res.status(404).json({ message: 'Envelope not found' });
      }
    }
    res.json(publicEnvelope(envelope));
  } catch (e) { next(e); }
}

// ── GET /sign/:token (PUBLIC, token-auth) ────────────────────────────────────
// The sign-page payload, resolved entirely by the token hash. NOT employee-scoped
// (the token is the auth) but tenant-correct (businessId derived from the
// envelope). Expired/invalid → 401, no data leaked. Marks the signer VIEWED.
async function getSignPayload(req, res, next) {
  try {
    const token = req.params.token;
    const tokenHash = sha256Hex(String(token || ''));
    const signer = await prisma.signatureSigner.findFirst({ where: { accessTokenHash: tokenHash } });
    if (!signer) return res.status(401).json({ message: 'Invalid or expired signing link' });
    if (!signer.tokenExpiresAt || new Date(signer.tokenExpiresAt).getTime() < Date.now()) {
      return res.status(401).json({ message: 'This signing link has expired' });
    }
    const envelope = await prisma.signatureEnvelope.findFirst({
      where: { id: signer.envelopeId, businessId: signer.businessId },
      include: { signers: { orderBy: { signerOrder: 'asc' } } },
    });
    if (!envelope) return res.status(401).json({ message: 'Invalid or expired signing link' });

    // Surface the document/template to render. businessId derived from the
    // envelope (tenant-correct), never from a client hint.
    let document = null;
    if (envelope.employeeDocumentId) {
      const doc = await prisma.employeeDocument.findFirst({
        where: { id: envelope.employeeDocumentId, businessId: signer.businessId },
        select: { id: true, name: true, fileUrl: true, mimeType: true, category: true },
      });
      document = doc || null;
    } else if (envelope.documentTemplateId) {
      const tpl = await prisma.documentTemplate.findFirst({
        where: { id: envelope.documentTemplateId, businessId: signer.businessId },
        select: { id: true, name: true, kind: true, bodyMarkdown: true },
      });
      document = tpl ? { ...tpl, isTemplate: true } : null;
    }

    // SEQUENTIAL: is it this signer's turn yet?
    let myTurn = true;
    if (envelope.sequential) {
      myTurn = envelope.signers
        .filter((s) => s.signerOrder < signer.signerOrder)
        .every((s) => s.status === 'SIGNED');
    }

    // Best-effort mark VIEWED (don't fail the read if it races).
    if (signer.status === 'SENT' || signer.status === 'PENDING') {
      try {
        await prisma.signatureSigner.update({ where: { id: signer.id }, data: { status: 'VIEWED' } });
      } catch { /* non-fatal */ }
    }

    res.json({
      envelope: {
        id: envelope.id, subject: envelope.subject, status: envelope.status,
        sequential: envelope.sequential, completedAt: envelope.completedAt,
      },
      signer: { id: signer.id, name: signer.name, email: signer.email, role: signer.role, status: signer.status, signerOrder: signer.signerOrder },
      myTurn,
      alreadySigned: signer.status === 'SIGNED',
      document,
    });
  } catch (e) { next(e); }
}

// ── POST /sign/:token (PUBLIC, token-auth) ───────────────────────────────────
// Submit a signature. Body: { signatureImageDataUrl, consent, name? }. The
// provider resolves the signer by token hash (timing-safe), enforces order,
// captures consent/ip/ua + signatureHash, and completes the envelope when all
// have signed. Expired/invalid token → 401 (no signature recorded).
async function submitSignature(req, res, next) {
  try {
    const token = req.params.token;
    const body = req.body || {};
    if (body.consent !== true) {
      return res.status(422).json({ message: 'You must agree to sign electronically (consent is required)' });
    }
    if (!body.signatureImageDataUrl) {
      return res.status(422).json({ message: 'A signature is required' });
    }
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || null;
    const userAgent = req.get ? req.get('user-agent') : (req.headers && req.headers['user-agent']) || null;

    const provider = esign.getProvider('BUILTIN');
    const out = await provider.sign({
      token,
      signatureImageDataUrl: body.signatureImageDataUrl,
      consent: true,
      ip,
      userAgent,
    }, prisma);

    res.json({
      signer: publicSigner(out.signer),
      envelope: { id: out.envelope.id, status: out.envelope.status, completedAt: out.envelope.completedAt, finalFileUrl: out.envelope.finalFileUrl, certificateUrl: out.envelope.certificateUrl },
      completed: out.completed,
    });
  } catch (e) {
    if (e && e.name === 'EsignError') {
      return res.status(e.status || 422).json({ message: e.message });
    }
    return next(e);
  }
}

module.exports = {
  createEnvelope,
  getEnvelope,
  getSignPayload,
  submitSignature,
};

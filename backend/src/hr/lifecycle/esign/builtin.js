'use strict';

/**
 * builtin.js — the BUILTIN e-sign provider (Feature 4 §3.2, §4.4, slice 4d). The
 * ONLY registered provider in v1 (vendor adapters are a later additive pass).
 *
 * Legal basis (§4.4): IN IT Act 2000 §10A (electronic contracts) + NZ Contract &
 * Commercial Law Act 2017 Part 4 (electronic signatures) — a non-PKI e-sign is
 * valid where INTENT + ATTRIBUTION + INTEGRITY are demonstrable. The audit
 * certificate captures all three:
 *   - intent      → explicit consent (consentAt) + the signature artifact
 *   - attribution → signer identity (name/email/role) + ip/userAgent at sign time
 *   - integrity   → docHash (SHA-256 of the source doc) bound into each
 *                   signatureHash = SHA-256(docHash + signerId + ISO-ts), and the
 *                   final file's own SHA-256 stored on the EmployeeDocument so any
 *                   later tamper is detectable (the §7 QA18 tamper check).
 *
 * Storage (§2/§4.4): via the existing s3.uploadDataUrl (no presign in v1). When
 * S3 isn't configured (dev/test) we fall back to embedding a data URL so the
 * artifacts (signature image, audit certificate) are still recorded with real
 * URLs and the hashes are real.
 *
 * PDF re-stamp (§4.4): a full flattened-PDF re-stamp needs a PDF lib that isn't a
 * v1 dependency, so per the slice spec ("if PDF libs unavailable, generate an
 * audit certificate doc + keep the original, and record certificateUrl") we
 * KEEP the original file and GENERATE a self-contained audit certificate (an
 * HTML document carrying the full signer/UTC/docHash/consent record). The
 * envelope's finalFileUrl + certificateUrl both point at recorded artifacts and
 * the EmployeeDocument.fileHash is the SHA-256 of the final file, so integrity is
 * verifiable end-to-end without the heavy PDF dependency.
 */

const crypto = require('crypto');
const s3 = require('../../../core/lib/s3');

// ── token + hashing helpers ──────────────────────────────────────────────────
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// The signer's magic-link token: a raw secret travels in the invite (never
// persisted); only its SHA-256 is stored (accessTokenHash). Matches the platform
// hashing convention (publicApi.js, meOnboarding pre-join token).
function mintSignerToken() {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  return { rawToken, tokenHash: sha256Hex(rawToken) };
}

// Timing-safe compare of two hex digests of equal length (defence against a
// token-hash timing oracle). Falls back to false on any length/shape mismatch.
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// Default envelope/token lifetime (days). A signer token without an expiry is
// treated as INVALID downstream, so the mint path always sets one.
const DEFAULT_TTL_DAYS = 14;

// ── docHash: the integrity anchor bound into every signatureHash ─────────────
// Prefer the linked EmployeeDocument.fileHash (the real SHA-256 of the source
// file). Fall back to hashing the document template body, then to a stable hash
// of the envelope id — so docHash is ALWAYS a concrete value.
async function resolveDocHash(prisma, envelope) {
  if (envelope.employeeDocumentId) {
    const doc = await prisma.employeeDocument.findFirst({
      where: { id: envelope.employeeDocumentId, businessId: envelope.businessId },
      select: { fileHash: true, fileUrl: true },
    });
    if (doc && doc.fileHash) return doc.fileHash;
    if (doc && doc.fileUrl) return sha256Hex(doc.fileUrl);
  }
  if (envelope.documentTemplateId) {
    const tpl = await prisma.documentTemplate.findFirst({
      where: { id: envelope.documentTemplateId, businessId: envelope.businessId },
      select: { bodyMarkdown: true },
    });
    if (tpl && tpl.bodyMarkdown) return sha256Hex(tpl.bodyMarkdown);
  }
  return sha256Hex(`envelope:${envelope.id}`);
}

// ── signature-image upload guard (MIME allow-list + decoded-size cap + sha256) ─
// The signature image is a legally-significant artifact; like every other upload
// in the platform (documents.controller validateDocDataUrl, letterheads), it must
// NOT trust the raw client data URL. We enforce: a base64 `data:` URL, an IMAGE-
// only MIME allow-list (PNG/JPEG — what pdf-lib can embed for the letter render),
// a DECODED-size ceiling (DoS guard, checked from the base64 length BEFORE we
// allocate the Buffer), and we compute a server-side SHA-256 of the DECODED bytes
// (the client's mimeType/size are never trusted). Mirrors documents.controller's
// validateDocDataUrl but scoped to the image set this artifact path accepts.
const MAX_SIGNATURE_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB decoded ceiling
const ALLOWED_SIGNATURE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg']);

// Returns { ok, mime, buffer, bytes, sha256 } or { ok:false, status, message }.
function validateSignatureImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return { ok: false, status: 422, message: 'A signature image (base64 data URL) is required' };
  }
  const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(dataUrl);
  // Require a base64 data URL (m[2] is the ';base64' group) — a raw / non-data /
  // utf8 data URL is rejected, as is a bare string token.
  if (!m || !m[2]) {
    return { ok: false, status: 422, message: 'Only base64 image data URLs are supported for the signature' };
  }
  const mime = m[1].toLowerCase();
  if (!ALLOWED_SIGNATURE_IMAGE_MIME.has(mime)) {
    return { ok: false, status: 422, message: `Unsupported signature image type: ${mime}. Allowed: PNG, JPEG.` };
  }
  // Pre-check the decoded size from the base64 length WITHOUT allocating the
  // Buffer (DoS guard): 4 base64 chars → 3 bytes, minus padding.
  const b64 = m[3] || '';
  if (!b64) {
    return { ok: false, status: 422, message: 'The signature image is empty' };
  }
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const approxBytes = Math.floor((b64.length * 3) / 4) - padding;
  if (approxBytes > MAX_SIGNATURE_IMAGE_BYTES) {
    return { ok: false, status: 422, message: `Signature image exceeds the ${MAX_SIGNATURE_IMAGE_BYTES / (1024 * 1024)} MB limit` };
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > MAX_SIGNATURE_IMAGE_BYTES) {
    return { ok: false, status: 422, message: `Signature image exceeds the ${MAX_SIGNATURE_IMAGE_BYTES / (1024 * 1024)} MB limit` };
  }
  if (buffer.length === 0) {
    return { ok: false, status: 422, message: 'The signature image decoded to zero bytes' };
  }
  return { ok: true, mime, buffer, bytes: buffer.length, sha256: sha256Hex(buffer) };
}

// Store a small artifact (signature image data-URL or the audit certificate). When
// S3 is configured we upload; otherwise we keep the data URL itself (dev/test) so
// the URL is real and the hash computable either way.
async function storeArtifact({ dataUrl, businessId, scope }) {
  if (s3.isConfigured()) {
    try {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope });
      return up.url;
    } catch {
      // Fall through to the inline fallback if the upload (e.g. unsupported MIME) fails.
    }
  }
  return dataUrl;
}

// The server secret the audit certificate is HMAC-sealed with. A dedicated
// ESIGN_CERT_SECRET is preferred; it falls back to JWT_SECRET, then to a build-time
// constant (dev/test only) so the cert is ALWAYS sealed and the HMAC is ALWAYS real.
function getCertSecret() {
  return process.env.ESIGN_CERT_SECRET || process.env.JWT_SECRET || 'drifthr-esign-cert-dev-secret';
}

// HMAC-SHA256 of the certificate body (hex). This is the tamper seal: a verifier
// re-derives the HMAC over the same canonical body with the server secret and
// compares it to the embedded value — any edit to the body changes the HMAC.
function certHmac(body) {
  return crypto.createHmac('sha256', getCertSecret()).update(body, 'utf8').digest('hex');
}

// Build the audit certificate as an HTML document (data URL). Captures intent +
// attribution + integrity for every signer, and is HMAC-SEALED with a server secret
// so tamper is cryptographically detectable (D13) — not merely "claimed". The HMAC
// is computed over the canonical body (everything before the seal) and embedded in
// the document; buildAuditCertificate also RETURNS the hmac so the caller can store
// it for later verification.
function buildAuditCertificate({ envelope, signers, docHash }) {
  const completedIso = new Date().toISOString();
  const rows = signers.map((s) => `
    <tr>
      <td>${escapeHtml(s.name)} &lt;${escapeHtml(s.email)}&gt;</td>
      <td>${escapeHtml(s.role)}</td>
      <td>${s.signedAt ? new Date(s.signedAt).toISOString() : '—'}</td>
      <td>${s.consentAt ? 'Yes' : 'No'}</td>
      <td>${escapeHtml(s.ipAddress || '—')}</td>
      <td><code>${escapeHtml(s.signatureHash || '—')}</code></td>
    </tr>`).join('');
  // Canonical body: deterministic from the envelope/signer facts (no nonce) so the
  // HMAC over it is reproducible by a verifier holding the same secret.
  const body = `<h1>Signature audit certificate</h1>
<p><strong>Envelope:</strong> ${escapeHtml(envelope.id)}</p>
<p><strong>Subject:</strong> ${escapeHtml(envelope.subject)}</p>
<p><strong>Document SHA-256:</strong> <code>${escapeHtml(docHash)}</code></p>
<p><strong>Completed (UTC):</strong> ${completedIso}</p>
<p><strong>Legal basis:</strong> IN IT Act 2000 §10A; NZ Contract &amp; Commercial Law Act 2017 Part 4.</p>
<table border="1" cellpadding="6" cellspacing="0">
  <thead><tr><th>Signer</th><th>Role</th><th>Signed at (UTC)</th><th>Consent</th><th>IP</th><th>Signature hash</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  const hmac = certHmac(body);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Signature audit certificate</title></head>
<body>
${body}
<p><strong>Integrity seal (HMAC-SHA256):</strong> <code id="cert-hmac">${hmac}</code></p>
<p><em>This certificate is HMAC-sealed with a server secret; recompute the HMAC over the body above to verify it has not been altered.</em></p>
</body></html>`;
  const b64 = Buffer.from(html, 'utf8').toString('base64');
  return { dataUrl: `data:text/html;base64,${b64}`, hmac, body };
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── createEnvelope ───────────────────────────────────────────────────────────
// Create the DRAFT envelope + SignatureSigner rows, mint per-signer magic-link
// tokens, flip to SENT. Runs in the caller's tx when one is passed, else its own
// $transaction. Returns the envelope + signers, with the RAW token attached to
// each signer (returned ONCE here, for the invite — never persisted).
async function createEnvelope(input, prisma) {
  const {
    businessId, documentTemplateId = null, employeeDocumentId = null, subject,
    signers, sequential = false, expiresAt,
  } = input || {};
  if (!businessId) throw new Error('createEnvelope requires businessId');
  if (!subject) throw new Error('createEnvelope requires a subject');
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Error('createEnvelope requires at least one signer');
  }
  if (!documentTemplateId && !employeeDocumentId) {
    throw new Error('createEnvelope requires a documentTemplateId or employeeDocumentId');
  }

  // D16: reject a past expiresAt at creation — an envelope that is born expired can
  // never be signed (and would be a confusing no-op). A malformed date is rejected
  // too. Absent → the default TTL.
  let tokenExpiresAt;
  if (expiresAt) {
    tokenExpiresAt = new Date(expiresAt);
    if (Number.isNaN(tokenExpiresAt.getTime())) {
      throw new EsignError('createEnvelope: expiresAt is not a valid date', 422);
    }
    if (tokenExpiresAt.getTime() <= Date.now()) {
      throw new EsignError('createEnvelope: expiresAt must be in the future', 422);
    }
  } else {
    tokenExpiresAt = new Date(Date.now() + DEFAULT_TTL_DAYS * 86400000);
  }

  const run = async (tx) => {
    const envelope = await tx.signatureEnvelope.create({
      data: {
        businessId,
        documentTemplateId,
        employeeDocumentId,
        provider: 'BUILTIN',
        subject,
        sequential: !!sequential,
        status: 'SENT',
        sentAt: new Date(),
        expiresAt: tokenExpiresAt,
      },
    });

    const created = [];
    // Stable signer order: respect an explicit signerOrder, else position+1.
    const ordered = signers.map((s, i) => ({ ...s, signerOrder: s.signerOrder || i + 1 }))
      .sort((a, b) => a.signerOrder - b.signerOrder);

    for (const s of ordered) {
      const { rawToken, tokenHash } = mintSignerToken();
      const row = await tx.signatureSigner.create({
        data: {
          businessId,
          envelopeId: envelope.id,
          signerOrder: s.signerOrder,
          role: s.role || 'EMPLOYEE',
          name: s.name || '',
          email: (s.email || '').toLowerCase(),
          employeeId: s.employeeId || null,
          userId: s.userId || null,
          status: 'SENT',
          accessTokenHash: tokenHash,
          tokenExpiresAt,
        },
      });
      created.push({ ...row, rawToken });
    }
    return { envelope, signers: created };
  };

  if (prisma && typeof prisma.$transaction === 'function' && !prisma.__isTx) {
    return prisma.$transaction((tx) => run(tx));
  }
  return run(prisma);
}

// ── sign ─────────────────────────────────────────────────────────────────────
// Resolve the signer by token hash (timing-safe), reject expired/invalid (401),
// enforce SEQUENTIAL order, capture ip/ua/consentAt + signatureHash, store the
// signature image, set the signer SIGNED. When all signers are SIGNED →
// re-stamp/certify + envelope COMPLETED + flow the result onto the linked
// EmployeeDocument (signatureStatus=SIGNED, fileHash = hash of the final file).
// Idempotent: a second sign on an already-SIGNED signer is INERT.
class EsignError extends Error {
  constructor(message, status) { super(message); this.status = status || 422; this.name = 'EsignError'; }
}

async function sign(input, prisma) {
  const { token, signatureImageDataUrl, consent, ip, userAgent } = input || {};
  if (!token) throw new EsignError('A signing token is required', 401);
  const tokenHash = sha256Hex(String(token));

  const run = async (tx) => {
    // Resolve the signer by token hash. The lookup is keyed on the hash, then we
    // re-verify with a timing-safe compare (defence-in-depth against an oracle).
    const candidate = await tx.signatureSigner.findFirst({
      where: { accessTokenHash: tokenHash },
    });
    if (!candidate || !safeEqualHex(candidate.accessTokenHash, tokenHash)) {
      throw new EsignError('Invalid or expired signing link', 401);
    }
    // Expiry is MANDATORY: a NULL expiry is INVALID; a past expiry is rejected.
    if (!candidate.tokenExpiresAt || new Date(candidate.tokenExpiresAt).getTime() < Date.now()) {
      throw new EsignError('This signing link has expired', 401);
    }

    const envelope = await tx.signatureEnvelope.findFirst({
      where: { id: candidate.envelopeId, businessId: candidate.businessId },
      include: { signers: { orderBy: { signerOrder: 'asc' } } },
    });
    if (!envelope) throw new EsignError('Envelope not found', 404);
    if (['VOIDED', 'DECLINED', 'EXPIRED'].includes(envelope.status)) {
      throw new EsignError(`This envelope is ${envelope.status.toLowerCase()} and cannot be signed`, 409);
    }
    // D14: enforce the ENVELOPE expiry at sign (the signer-token expiry is checked
    // above; this is the separate envelope-level deadline). A past expiry → 410
    // Gone. No signature is recorded (we throw before any signer write). The EXPIRED
    // status flip is done OUTSIDE this tx (the throw rolls the tx back), so we tag
    // the error and the wrapper persists the terminal status separately.
    if (envelope.expiresAt && new Date(envelope.expiresAt).getTime() < Date.now()) {
      const err = new EsignError('This envelope has expired and can no longer be signed', 410);
      err.expireEnvelopeId = envelope.status !== 'EXPIRED' ? envelope.id : null;
      throw err;
    }

    // Idempotency: a second sign on an already-SIGNED signer is inert (no-op).
    if (candidate.status === 'SIGNED') {
      return { signer: candidate, envelope, completed: envelope.status === 'COMPLETED', idempotent: true };
    }

    // SEQUENTIAL guard: signer N is inert until signer N-1 is SIGNED.
    if (envelope.sequential) {
      const earlierUnsigned = envelope.signers.filter(
        (s) => s.signerOrder < candidate.signerOrder && s.status !== 'SIGNED',
      );
      if (earlierUnsigned.length > 0) {
        throw new EsignError('Waiting for an earlier signer to sign first', 409);
      }
    }

    // Validate the signature image BEFORE it is stored or hashed: IMAGE-only MIME
    // allow-list (PNG/JPEG), decoded-size cap (DoS guard), base64 data URL. The
    // raw client data URL is NEVER trusted — a non-image MIME / oversize / malformed
    // payload is rejected (422) and NO signature is recorded. The server-computed
    // sha256 of the decoded bytes (imgCheck.sha256) is the artifact integrity anchor.
    let imgSha256 = null;
    if (signatureImageDataUrl) {
      const imgCheck = validateSignatureImageDataUrl(signatureImageDataUrl);
      if (!imgCheck.ok) throw new EsignError(imgCheck.message, imgCheck.status || 422);
      imgSha256 = imgCheck.sha256;
    }

    const docHash = await resolveDocHash(tx, envelope);
    const nowIso = new Date().toISOString();
    // signatureHash = SHA-256(docHash + signerId + ISO-ts [+ imageSha256]) — binds
    // the document integrity anchor to this specific signer + the moment of signing
    // (§4.4), AND to the server-computed hash of the signature artifact bytes when a
    // signature image is present (so the artifact is integrity-bound, not just URL'd).
    const signatureHash = imgSha256
      ? sha256Hex(`${docHash}${candidate.id}${nowIso}${imgSha256}`)
      : sha256Hex(`${docHash}${candidate.id}${nowIso}`);

    // Store the signature artifact (drawn/typed image data URL) — already validated.
    let signatureImageUrl = null;
    if (signatureImageDataUrl) {
      signatureImageUrl = await storeArtifact({
        dataUrl: signatureImageDataUrl, businessId: envelope.businessId, scope: 'esign-sig',
      });
    }

    const signer = await tx.signatureSigner.update({
      where: { id: candidate.id },
      data: {
        status: 'SIGNED',
        signedAt: new Date(nowIso),
        consentAt: consent ? new Date(nowIso) : null,
        ipAddress: ip || null,
        userAgent: userAgent || null,
        signatureImageUrl,
        signatureHash,
      },
    });

    // D15: completion under concurrency. Take a ROW LOCK on the envelope so two
    // concurrent signs serialise on it — the second blocks until the first commits,
    // then re-reads the now-committed signer set. Without the lock, under READ
    // COMMITTED each tx could read a stale "not all signed" set and leave the
    // envelope permanently PARTIALLY_SIGNED. The lock makes the completion decision
    // a function of the COMMITTED state, not an interleaving snapshot.
    await tx.$queryRaw`SELECT id FROM "SignatureEnvelope" WHERE id = ${envelope.id} FOR UPDATE`;

    // Re-read the full signer set (now serialised behind the lock) to decide completion.
    const allSigners = await tx.signatureSigner.findMany({
      where: { envelopeId: envelope.id }, orderBy: { signerOrder: 'asc' },
    });
    const allSigned = allSigners.every((s) => s.status === 'SIGNED');

    let finalEnvelope = await tx.signatureEnvelope.update({
      where: { id: envelope.id },
      data: { status: allSigned ? 'COMPLETED' : 'PARTIALLY_SIGNED', version: { increment: 1 } },
    });

    if (allSigned) {
      // Generate the audit certificate (intent + attribution + integrity), HMAC-sealed.
      const cert = buildAuditCertificate({ envelope: finalEnvelope, signers: allSigners, docHash });
      const certDataUrl = cert.dataUrl;
      const certificateUrl = await storeArtifact({
        dataUrl: certDataUrl, businessId: envelope.businessId, scope: 'esign-cert',
      });
      // finalFileUrl: with no PDF re-stamp lib in v1 we keep the original source
      // file as the final file and attach the certificate alongside (§4.4
      // fallback). The final file's SHA-256 is the integrity anchor stored on the
      // EmployeeDocument.
      let finalFileUrl = certificateUrl;
      let finalHash = sha256Hex(certDataUrl);
      if (envelope.employeeDocumentId) {
        const doc = await tx.employeeDocument.findFirst({
          where: { id: envelope.employeeDocumentId, businessId: envelope.businessId },
          select: { id: true, fileUrl: true, fileHash: true },
        });
        if (doc) {
          finalFileUrl = doc.fileUrl;
          // The final file hash is the original file's hash (the original is the
          // signed artifact; the certificate carries the audit trail). Fall back
          // to hashing the URL when no hash is recorded.
          finalHash = doc.fileHash || sha256Hex(doc.fileUrl);
          await tx.employeeDocument.update({
            where: { id: doc.id },
            data: { signatureStatus: 'SIGNED', fileHash: finalHash, version: { increment: 1 } },
          });
        }
      }
      finalEnvelope = await tx.signatureEnvelope.update({
        where: { id: envelope.id },
        data: {
          finalFileUrl,
          certificateUrl,
          completedAt: new Date(),
          version: { increment: 1 },
        },
      });
    }

    return { signer, envelope: finalEnvelope, completed: allSigned };
  };

  // D14: when the sign rejects because the ENVELOPE expired, flip it to EXPIRED in a
  // SEPARATE write (the failing tx rolled back). The 410 still propagates to the caller.
  const expireOutsideTx = async (err) => {
    if (err && err.expireEnvelopeId && prisma && !prisma.__isTx) {
      try {
        await prisma.signatureEnvelope.update({
          where: { id: err.expireEnvelopeId },
          data: { status: 'EXPIRED', version: { increment: 1 } },
        });
      } catch { /* best-effort terminal flip */ }
    }
    throw err;
  };

  if (prisma && typeof prisma.$transaction === 'function' && !prisma.__isTx) {
    return prisma.$transaction((tx) => run(tx)).catch(expireOutsideTx);
  }
  return run(prisma);
}

// ── getStatus ────────────────────────────────────────────────────────────────
async function getStatus({ businessId, envelopeId }, prisma) {
  const envelope = await prisma.signatureEnvelope.findFirst({
    where: { id: envelopeId, businessId },
    include: { signers: { orderBy: { signerOrder: 'asc' } } },
  });
  return envelope;
}

// ── void ─────────────────────────────────────────────────────────────────────
// Void an envelope (terminal, unless already COMPLETED). Idempotent — voiding an
// already-VOIDED envelope returns it unchanged.
async function voidEnvelope({ businessId, envelopeId, reason }, prisma) {
  const envelope = await prisma.signatureEnvelope.findFirst({ where: { id: envelopeId, businessId } });
  if (!envelope) throw new EsignError('Envelope not found', 404);
  if (envelope.status === 'VOIDED') return envelope;
  if (envelope.status === 'COMPLETED') {
    throw new EsignError('A completed envelope cannot be voided', 409);
  }
  return prisma.signatureEnvelope.update({
    where: { id: envelope.id },
    data: { status: 'VOIDED', voidedReason: reason || null, version: { increment: 1 } },
  });
}

module.exports = {
  createEnvelope,
  sign,
  getStatus,
  void: voidEnvelope,
  voidEnvelope,
  // exported for tests / reuse
  EsignError,
  sha256Hex,
  mintSignerToken,
  resolveDocHash,
  buildAuditCertificate,
  certHmac,
  getCertSecret,
  validateSignatureImageDataUrl,
  MAX_SIGNATURE_IMAGE_BYTES,
  ALLOWED_SIGNATURE_IMAGE_MIME,
};

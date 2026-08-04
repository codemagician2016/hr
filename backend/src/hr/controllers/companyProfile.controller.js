'use strict';

/**
 * companyProfile.controller.js — Company Profile settings (HR).
 *
 * Three concerns, all tenant-scoped by req.user.businessId and gated on the
 * canManageCompanyProfile permission (reads allow any operator; writes require it):
 *
 *   1. Business profile  — India-first legal/registration fields (legal name,
 *      trade name, CIN, GSTIN, PAN, registered address, contact). Stored in the
 *      additive Business.companyProfile JSON column (no per-field migration).
 *
 *   2. Business documents — an OPTIONAL company document vault (licences, income-
 *      tax reports, financial statements, registration/GST certificates). Reuses
 *      the EmployeeDocument storage pattern: ≤10 MB, PDF/PNG/JPG allow-list, a
 *      server-computed SHA-256 integrity hash, S3 via s3.uploadDataUrl with an
 *      inline-data-URL fallback when S3 is not configured. Soft-deletable +
 *      paginated. The business MAY leave this empty.
 *
 *   3. Employee-number scheme — the auto employee-number format (prefix / padding /
 *      next-start), backed by the existing (businessId, scope:'EMPLOYEE')
 *      NumberSequence row. Get returns the config + a live preview; update edits
 *      the row (prefix/padding/nextValue). The allocator (lib/codes.js
 *      allocateCode) reads this row at employee-create time.
 */

const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');
const s3 = require('../../core/lib/s3');
const { writeAudit } = require('../../core/lib/audit');
const { format: formatCode, SCOPE_DEFAULTS } = require('../lifecycle/lib/codes');

// ── upload guards (mirror documents.controller.js) ───────────────────────────
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_DOC_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);
const BUSINESS_DOC_CATEGORIES = new Set([
  'BUSINESS_LICENSE', 'INCOME_TAX_REPORT', 'FINANCIAL_STATEMENT',
  'REGISTRATION_CERTIFICATE', 'GST_CERTIFICATE', 'OTHER',
]);

// Default window (days) within which an unexpired document counts as "expiring soon".
const EXPIRING_SOON_DAYS = 60;

// ── Company profile (India-first registration fields, JSON) ──────────────────
// Allow-list of profile keys — never persist arbitrary client JSON.
const PROFILE_FIELDS = [
  // `businessType` selects the legal structure (sole_proprietorship, llp,
  // private_limited, …); `registrationNo` is the polymorphic primary id whose
  // meaning depends on it (CIN / LLPIN / firm-reg / trust-reg). `proprietorName`
  // only applies to a sole proprietorship. See apps/*/lib/businessTypes.js.
  'businessType', 'proprietorName',
  'legalName', 'tradeName', 'registrationNo', 'gstin', 'pan', 'tan',
  // NZ registration identifiers (multi-country unlock) — persist alongside the
  // IN ids; the UI shows one set or the other by tenant hrCountry.
  'nzbn', 'irdEntityNumber',
  'registeredAddressLine1', 'registeredAddressLine2', 'registeredCity',
  'registeredState', 'registeredPostalCode', 'registeredCountry',
  'contactName', 'contactEmail', 'contactPhone', 'incorporationDate',
];
const PROFILE_MAX_LEN = 240;

// Sensible prefills from existing Business columns, used ONLY when the stored
// profile field is empty. Every other PROFILE_FIELDS key reads straight out of
// the JSON column — the read path iterates PROFILE_FIELDS rather than naming
// fields, so a newly-added key (businessType, nzbn, …) can never be saved-but-
// not-returned.
const PROFILE_PREFILL = {
  legalName: (b) => b.billingBusinessName ?? b.name,
  tradeName: (b) => b.name,
  registeredAddressLine1: (b) => b.address,
  registeredAddressLine2: (b) => b.addressLine2,
  registeredCity: (b) => b.city,
  registeredState: (b) => b.state,
  registeredPostalCode: (b) => b.postalCode,
  registeredCountry: (b) => b.country,
  contactEmail: (b) => b.email,
  contactPhone: (b) => b.phone,
};

function cleanProfileValue(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim().slice(0, PROFILE_MAX_LEN) || null;
}

// Parse + validate a base64 data URL (no trust in client mimeType/size). Returns
// { ok, mime, buffer, bytes } or { ok:false, status, message }.
function validateDocDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return { ok: false, status: 400, message: 'A file (fileBase64 data URL) is required' };
  }
  const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(dataUrl);
  if (!m || !m[2]) {
    return { ok: false, status: 422, message: 'Only base64 data URLs are supported' };
  }
  const mime = m[1].toLowerCase();
  if (!ALLOWED_DOC_MIME.has(mime)) {
    return { ok: false, status: 422, message: `Unsupported document type: ${mime}. Allowed: PDF, PNG, JPG.` };
  }
  const b64 = m[3] || '';
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const approxBytes = Math.floor((b64.length * 3) / 4) - padding;
  if (approxBytes > MAX_DOC_BYTES) {
    return { ok: false, status: 413, message: `File exceeds the ${MAX_DOC_BYTES / (1024 * 1024)} MB upload limit` };
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > MAX_DOC_BYTES) {
    return { ok: false, status: 413, message: `File exceeds the ${MAX_DOC_BYTES / (1024 * 1024)} MB upload limit` };
  }
  return { ok: true, mime, buffer, bytes: buffer.length };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const DOC_PUBLIC = [
  'id', 'category', 'name', 'fileUrl', 'fileHash', 'mimeType', 'sizeBytes',
  'uploadedBy', 'expiresAt', 'createdAt', 'updatedAt',
];
function publicDoc(doc) {
  const out = {};
  for (const f of DOC_PUBLIC) if (doc[f] !== undefined) out[f] = doc[f];
  return out;
}
function annotateExpiry(doc, now, soonMs) {
  const exp = doc.expiresAt ? new Date(doc.expiresAt) : null;
  const expired = !!(exp && exp.getTime() < now);
  const expiringSoon = !!(exp && !expired && exp.getTime() - now <= soonMs);
  return { ...publicDoc(doc), expired, expiringSoon };
}

// GET /company-profile — business profile (companyProfile JSON merged with a few
// useful Business columns) so the page can prefill from what we already hold.
async function getCompanyProfile(req, res, next) {
  try {
    const { businessId } = req.user;
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true, name: true, country: true, email: true, phone: true,
        address: true, addressLine2: true, city: true, state: true, postalCode: true,
        billingBusinessName: true, billingTaxId: true,
        companyProfile: true,
      },
    });
    if (!biz) return res.status(404).json({ message: 'Business not found' });

    const stored = (biz.companyProfile && typeof biz.companyProfile === 'object') ? biz.companyProfile : {};
    const profile = {};
    for (const f of PROFILE_FIELDS) {
      const prefill = PROFILE_PREFILL[f];
      profile[f] = stored[f] ?? (prefill ? (prefill(biz) ?? null) : null);
    }
    // Legacy: an early build stored the company PAN under `tax`.
    if (profile.pan === null && stored.tax) profile.pan = stored.tax;
    res.json({ profile });
  } catch (e) { next(e); }
}

// PATCH /company-profile — upsert the India-first registration profile.
async function updateCompanyProfile(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { companyProfile: true },
    });
    if (!biz) return res.status(404).json({ message: 'Business not found' });

    const current = (biz.companyProfile && typeof biz.companyProfile === 'object') ? biz.companyProfile : {};
    const next = { ...current };
    const changed = [];
    for (const f of PROFILE_FIELDS) {
      if (body[f] !== undefined) {
        const v = cleanProfileValue(body[f]);
        if (v !== (current[f] ?? null)) changed.push(f);
        if (v === null) delete next[f];
        else next[f] = v;
      }
    }

    await prisma.business.update({ where: { id: businessId }, data: { companyProfile: next } });
    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'company.profile.update', entityType: 'Business', entityId: businessId,
      meta: { changed },
    });
    res.json({ profile: next });
  } catch (e) { next(e); }
}

// ── Business document vault ───────────────────────────────────────────────────

// GET /company-profile/documents?page=&pageSize=&category= — paginated list.
async function listDocuments(req, res, next) {
  try {
    const { businessId } = req.user;
    const { category } = req.query;
    const take = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * take;

    const where = { businessId, deletedAt: null };
    if (category) {
      if (!BUSINESS_DOC_CATEGORIES.has(category)) {
        return res.status(422).json({ message: `Invalid document category: ${category}` });
      }
      where.category = category;
    }

    const now = Date.now();
    const soonMs = EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;
    const [rows, total] = await Promise.all([
      prisma.businessDocument.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.businessDocument.count({ where }),
    ]);
    res.json({
      items: rows.map((d) => annotateExpiry(d, now, soonMs)),
      total, page, pageSize: take,
    });
  } catch (e) { next(e); }
}

// POST /company-profile/documents — upload a company document (optional vault).
async function createDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const { category, name } = body;
    const dataUrl = body.fileBase64 || body.dataUrl;

    if (!category) return res.status(400).json({ message: 'A document category is required' });
    if (!BUSINESS_DOC_CATEGORIES.has(category)) {
      return res.status(422).json({ message: `Invalid document category: ${category}` });
    }

    const docCheck = validateDocDataUrl(dataUrl);
    if (!docCheck.ok) return res.status(docCheck.status).json({ message: docCheck.message });

    const mimeType = docCheck.mime;
    const sizeBytes = docCheck.bytes;
    const fileHash = sha256(docCheck.buffer);

    // Store the bytes. When S3 isn't configured (dev/test) fall back to embedding
    // the data URL as the fileUrl so the row still persists with real schema fields.
    let fileUrl;
    if (s3.isConfigured()) {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'business-doc' });
      fileUrl = up.url;
    } else {
      fileUrl = dataUrl;
    }

    const doc = await prisma.businessDocument.create({
      data: {
        businessId,
        category,
        name: (name && String(name).trim().slice(0, 200)) || 'Document',
        fileUrl,
        fileHash,
        mimeType,
        sizeBytes,
        uploadedBy: req.user.id || null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });

    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'company.document.upload', entityType: 'BusinessDocument', entityId: doc.id,
      meta: { category, name: doc.name, sizeBytes, mimeType },
    });
    res.status(201).json(publicDoc(doc));
  } catch (e) { next(e); }
}

// GET /company-profile/documents/:id/download — return the stored URL (or inline
// data URL on the no-S3 fallback). Tenant-scoped: a foreign-tenant id 404s.
async function downloadDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const doc = await prisma.businessDocument.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    res.json({ url: doc.fileUrl, name: doc.name, mimeType: doc.mimeType, fileHash: doc.fileHash });
  } catch (e) { next(e); }
}

// DELETE /company-profile/documents/:id — soft-delete (tenant-scoped).
async function deleteDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const doc = await prisma.businessDocument.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    await prisma.businessDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
    // Best-effort: remove the S3 object too (no-op for the inline fallback URL).
    try { await s3.deleteByUrl(doc.fileUrl); } catch { /* best-effort */ }

    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'company.document.delete', entityType: 'BusinessDocument', entityId: doc.id,
      meta: { category: doc.category, name: doc.name },
    });
    res.json({ message: 'Document deleted' });
  } catch (e) { next(e); }
}

// ── Employee-number scheme (NumberSequence, scope EMPLOYEE) ───────────────────

const EMP_SCOPE = 'EMPLOYEE';
const EMP_DEFAULTS = SCOPE_DEFAULTS[EMP_SCOPE] || { prefix: 'EMP-', padding: 6 };

// Resolve the tenant-wide EMPLOYEE NumberSequence row (entityId/periodKey null).
function findEmployeeSequence(businessId) {
  return prisma.numberSequence.findFirst({
    where: { businessId, entityId: null, scope: EMP_SCOPE, periodKey: null },
  });
}

function previewNext(prefix, nextValue, padding) {
  // P1.7 — sample token context so "EMP-{ENTITY}-{YY}-" previews as
  // "EMP-ENT-26-0001" (real codes use the hire's actual entity/dept codes).
  return formatCode(prefix, nextValue, padding, { entityCode: 'ENT', deptCode: 'DEPT' });
}

// GET /company-profile/employee-number — the current scheme + a live preview.
async function getEmployeeNumberScheme(req, res, next) {
  try {
    const { businessId } = req.user;
    const seq = await findEmployeeSequence(businessId);
    const prefix = seq ? seq.prefix : EMP_DEFAULTS.prefix;
    const padding = seq ? seq.padding : EMP_DEFAULTS.padding;
    const nextValue = seq ? seq.nextValue : 1;
    res.json({
      configured: !!seq,
      prefix,
      padding,
      nextValue,
      // "Next will be: EMP-0042" — the value the next auto-created employee gets.
      preview: previewNext(prefix, nextValue, padding),
      defaults: { prefix: EMP_DEFAULTS.prefix, padding: EMP_DEFAULTS.padding },
    });
  } catch (e) { next(e); }
}

// PATCH /company-profile/employee-number — set prefix / padding / next-start.
// Creates the EMPLOYEE NumberSequence row on first save (so the admin can choose
// the format before any employee is auto-numbered). Never lowers nextValue below
// an already-issued value implicitly — the admin sets the next-start explicitly.
async function updateEmployeeNumberScheme(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};

    // Validate inputs. Prefix: ≤40 chars (P1.7 tokens {ENTITY}/{DEPT}/{YYYY}/{YY}
    // may appear), printable. Padding: 1..12. nextValue ≥ 1.
    let prefix;
    if (body.prefix !== undefined) {
      prefix = String(body.prefix || '').slice(0, 40);
      if (/[\r\n\t]/.test(prefix)) {
        return res.status(422).json({ message: 'Prefix cannot contain line breaks or tabs.' });
      }
    }
    let padding;
    if (body.padding !== undefined) {
      padding = parseInt(body.padding, 10);
      if (!Number.isFinite(padding) || padding < 1 || padding > 12) {
        return res.status(422).json({ message: 'Padding must be a number between 1 and 12.' });
      }
    }
    let nextValue;
    if (body.nextValue !== undefined) {
      nextValue = parseInt(body.nextValue, 10);
      if (!Number.isFinite(nextValue) || nextValue < 1) {
        return res.status(422).json({ message: 'Next number must be a whole number of at least 1.' });
      }
    }

    const existing = await findEmployeeSequence(businessId);

    const finalPrefix = prefix !== undefined ? prefix : (existing ? existing.prefix : EMP_DEFAULTS.prefix);
    const finalPadding = padding !== undefined ? padding : (existing ? existing.padding : EMP_DEFAULTS.padding);
    const finalNext = nextValue !== undefined ? nextValue : (existing ? existing.nextValue : 1);

    let seq;
    if (existing) {
      seq = await prisma.numberSequence.update({
        where: { id: existing.id },
        data: { prefix: finalPrefix, padding: finalPadding, nextValue: finalNext },
      });
    } else {
      seq = await prisma.numberSequence.create({
        data: {
          businessId, entityId: null, scope: EMP_SCOPE, periodKey: null,
          prefix: finalPrefix, padding: finalPadding, nextValue: finalNext,
        },
      });
    }

    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'company.employeeNumber.update', entityType: 'NumberSequence', entityId: seq.id,
      meta: { prefix: seq.prefix, padding: seq.padding, nextValue: seq.nextValue },
    });
    res.json({
      configured: true,
      prefix: seq.prefix,
      padding: seq.padding,
      nextValue: seq.nextValue,
      preview: previewNext(seq.prefix, seq.nextValue, seq.padding),
      defaults: { prefix: EMP_DEFAULTS.prefix, padding: EMP_DEFAULTS.padding },
    });
  } catch (e) { next(e); }
}

module.exports = {
  getCompanyProfile,
  updateCompanyProfile,
  listDocuments,
  createDocument,
  downloadDocument,
  deleteDocument,
  getEmployeeNumberScheme,
  updateEmployeeNumberScheme,
  // exported for tests
  validateDocDataUrl,
  previewNext,
};

'use strict';

/**
 * documents.controller.js — Employee documents against the REAL EmployeeDocument
 * model (Feature 4 §3.1, §4.4, slice 4d). This is a FULL REWRITE: the previous
 * controller targeted a fabricated shape (`type`/`url`/`fileName`/`fileSize`/
 * `uploadedById`, status IN_PROGRESS) — none of those columns exist and every
 * write threw at runtime. The real model (schema.prisma L8467) is:
 *
 *   EmployeeDocument {
 *     category DocumentCategory   name   fileUrl   fileHash   mimeType
 *     sizeBytes   documentNumber   expiresAt(@db.Date)   verifiedAt   verifiedBy
 *     visibility DocumentVisibility(@default HR_ONLY)   isEmployeeUploaded
 *     signatureStatus SignatureStatus?   deletedAt(soft)   version
 *   }
 *
 * RBAC posture (§4.5): every per-employee read/write is Feature-1 SCOPED. The
 * routes attach `withEmployeeScope(action, { idParam:'employeeId' })`, so a
 * manager hitting an OUT-OF-TEAM employee resolves to 404 (IDOR-safe, never 403),
 * matching the F1 chokepoint. HR (ALL band) sees the whole tenant.
 *
 * Visibility filtering: an EMPLOYEE viewing their OWN documents (/me/documents)
 * sees only EMPLOYEE_VISIBLE rows plus anything they signed; HR_ONLY (the upload
 * default) is excluded from the employee's own view but always visible to HR.
 *
 * Upload: a base64 data-URL → s3.uploadDataUrl (no presign in v1, §2/§4.4);
 * fileHash = SHA-256 of the decoded bytes (computed server-side, not trusted from
 * the client); ≤10 MB + PDF/PNG/JPG allow-list; category validated against the
 * DocumentCategory enum (else 422, never a Prisma 500).
 */

const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');
const s3 = require('../../core/lib/s3');
const { scopeAllows } = require('../lib/scopeResolver');

// Default window (days) within which an unexpired document counts as "expiring soon".
const DEFAULT_EXPIRING_DAYS = 30;

// ── upload guards (size cap + MIME allow-list + category enum) ────────────────
// Hard ceiling on the DECODED payload (DoS guard): reject before storing.
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB
// HR documents are PDFs or scanned ID images only.
const ALLOWED_DOC_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);
// The DocumentCategory enum values (mirror prisma/schema.prisma L8494 — writing a
// value outside this set makes Prisma 500; we reject with a 422 instead).
const DOCUMENT_CATEGORIES = new Set([
  'ID_PROOF', 'ADDRESS_PROOF', 'PAN', 'AADHAAR', 'PASSPORT', 'VISA', 'WORK_PERMIT',
  'EDUCATION', 'EXPERIENCE', 'OFFER_LETTER', 'CONTRACT', 'PAYSLIP_COPY',
  'TAX_DECLARATION', 'FORM16', 'BANK_PROOF', 'MEDICAL', 'POLICY_ACK', 'OTHER',
]);
const DOCUMENT_VISIBILITIES = new Set(['HR_ONLY', 'MANAGER_AND_HR', 'EMPLOYEE_VISIBLE']);

// Public, read-only field set returned to clients. The fileHash is exposed so the
// UI can verify integrity (the tamper badge); documentNumber is exposed but the
// client masks it (PII).
const DOC_PUBLIC = [
  'id', 'employeeId', 'category', 'name', 'fileUrl', 'fileHash', 'mimeType',
  'sizeBytes', 'documentNumber', 'expiresAt', 'verifiedAt', 'verifiedBy',
  'visibility', 'isEmployeeUploaded', 'signatureStatus', 'createdAt', 'updatedAt',
];

function publicDoc(doc) {
  const out = {};
  for (const f of DOC_PUBLIC) if (doc[f] !== undefined) out[f] = doc[f];
  return out;
}

// Annotate a document row with expiry state relative to `now` / a soon-window.
function annotateExpiry(doc, now, soonMs) {
  const exp = doc.expiresAt ? new Date(doc.expiresAt) : null;
  const expired = !!(exp && exp.getTime() < now);
  const expiringSoon = !!(exp && !expired && exp.getTime() - now <= soonMs);
  return { ...publicDoc(doc), expired, expiringSoon };
}

// Parse + validate a base64 data URL against the allow-list + size cap WITHOUT
// trusting any client-supplied mimeType/sizeBytes. Returns { ok, mime, buffer,
// bytes } or { ok:false, status, message }.
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
  // Decoded size from the base64 length WITHOUT allocating yet (DoS guard): every
  // 4 base64 chars decode to 3 bytes, minus padding. Reject oversize up-front.
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

// SHA-256 of the decoded bytes (hex), computed server-side — never trusted from
// the client. This is the integrity anchor the tamper badge checks against.
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Resolve and tenant-scope the employee referenced by the route. Returns the
// employee row, or null if it does not belong to this tenant.
async function findEmployee(businessId, employeeId) {
  return prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
}

// ── HR / manager surface (per-employee, F1-scoped by the route) ──────────────

// GET /employees/:employeeId/documents — list an employee's documents (scoped).
// HR (ALL) sees everything; a manager (TEAM) gets the in-scope employee's docs but
// HR_ONLY rows are excluded from the manager view unless explicitly MANAGER_AND_HR
// (HR_ONLY is, by name, HR-only). HR includes HR_ONLY.
async function listDocuments(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const { category, q, expiring, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const soonDays = Math.max(parseInt(req.query.expiringDays, 10) || DEFAULT_EXPIRING_DAYS, 0);
    const now = Date.now();
    const soonMs = soonDays * 24 * 60 * 60 * 1000;

    const where = { businessId, employeeId, deletedAt: null };
    if (category) {
      if (!DOCUMENT_CATEGORIES.has(category)) return res.status(422).json({ message: `Invalid document category: ${category}` });
      where.category = category;
    }
    if (q) where.name = { contains: q, mode: 'insensitive' };
    // A manager (non-ALL scope) does not see HR_ONLY rows; HR does.
    if (req.scope && req.scope.kind !== 'ALL') {
      where.visibility = { in: ['MANAGER_AND_HR', 'EMPLOYEE_VISIBLE'] };
    }
    if (expiring === 'true') {
      where.expiresAt = { gte: new Date(now), lte: new Date(now + soonMs) };
    } else if (expiring === 'expired') {
      where.expiresAt = { lt: new Date(now) };
    }

    const [rows, total] = await Promise.all([
      prisma.employeeDocument.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.employeeDocument.count({ where }),
    ]);
    const items = rows.map((d) => annotateExpiry(d, now, soonMs));
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

// GET /employees/:employeeId/documents/:id — single document (404 out-of-scope).
async function getDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const doc = await prisma.employeeDocument.findFirst({
      where: { id, businessId, employeeId, deletedAt: null },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    // A manager cannot fetch an HR_ONLY doc (404, never an info-leaking 403).
    if (req.scope && req.scope.kind !== 'ALL' && doc.visibility === 'HR_ONLY') {
      return res.status(404).json({ message: 'Document not found' });
    }
    res.json(annotateExpiry(doc, Date.now(), DEFAULT_EXPIRING_DAYS * 24 * 60 * 60 * 1000));
  } catch (e) { next(e); }
}

// POST /employees/:employeeId/documents — upload a document. base64 data-URL →
// s3.uploadDataUrl; fileHash = SHA-256(decoded bytes) computed server-side; ≤10 MB
// + PDF/PNG/JPG; category validated against the enum. Writes a REAL EmployeeDocument
// row (the §7 QA22 regression guard against the old fabricated fields).
async function createDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const body = req.body || {};
    const { category, name } = body;
    const dataUrl = body.fileBase64 || body.dataUrl;
    if (!category) return res.status(400).json({ message: 'A document category is required' });
    if (!DOCUMENT_CATEGORIES.has(category)) {
      return res.status(422).json({ message: `Invalid document category: ${category}` });
    }
    let visibility = body.visibility || 'HR_ONLY';
    if (!DOCUMENT_VISIBILITIES.has(visibility)) {
      return res.status(422).json({ message: `Invalid visibility: ${visibility}` });
    }

    // Validate the payload (MIME + ≤10 MB) BEFORE storing; decode + hash server-side.
    const docCheck = validateDocDataUrl(dataUrl);
    if (!docCheck.ok) return res.status(docCheck.status).json({ message: docCheck.message });
    const mimeType = docCheck.mime;
    const sizeBytes = docCheck.bytes;
    const fileHash = sha256(docCheck.buffer);

    // Store the bytes. When S3 isn't configured (dev/test), fall back to embedding
    // the data URL as the fileUrl so the row is still written with REAL schema
    // fields (the same allow-list + cap already applied).
    let fileUrl;
    if (s3.isConfigured()) {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'employee-doc' });
      fileUrl = up.url;
    } else {
      fileUrl = dataUrl;
    }

    const doc = await prisma.employeeDocument.create({
      data: {
        businessId,
        employeeId,
        category,
        name: name || 'Document',
        fileUrl,
        fileHash,
        mimeType,
        sizeBytes,
        documentNumber: body.documentNumber || null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        visibility,
        isEmployeeUploaded: false,
        signatureStatus: body.signatureStatus && ['NOT_REQUIRED', 'PENDING'].includes(body.signatureStatus)
          ? body.signatureStatus : null,
      },
    });
    res.status(201).json(publicDoc(doc));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A document with that identity already exists' });
    next(e);
  }
}

// POST /employees/:employeeId/documents/:id/verify — HR marks a document verified
// (sets verifiedAt + verifiedBy). HR-only via the route's canManageEmployees.
async function verifyDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.employeeDocument.findFirst({
      where: { id, businessId, employeeId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Document not found' });
    const doc = await prisma.employeeDocument.update({
      where: { id },
      data: { verifiedAt: new Date(), verifiedBy: req.user.id, version: { increment: 1 } },
    });
    res.json(publicDoc(doc));
  } catch (e) { next(e); }
}

// PATCH /employees/:employeeId/documents/:id — edit a small set of metadata fields
// (name / visibility / documentNumber / expiresAt). The file itself is immutable
// (re-upload to replace), so the integrity hash stays the source of truth.
async function updateDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.employeeDocument.findFirst({
      where: { id, businessId, employeeId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Document not found' });

    const body = req.body || {};
    const data = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.documentNumber !== undefined) data.documentNumber = body.documentNumber;
    if (body.expiresAt !== undefined) data.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (body.visibility !== undefined) {
      if (!DOCUMENT_VISIBILITIES.has(body.visibility)) {
        return res.status(422).json({ message: `Invalid visibility: ${body.visibility}` });
      }
      data.visibility = body.visibility;
    }
    if (!Object.keys(data).length) return res.json(publicDoc(existing));
    data.version = { increment: 1 };
    const doc = await prisma.employeeDocument.update({ where: { id }, data });
    res.json(publicDoc(doc));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A document with that identity already exists' });
    next(e);
  }
}

// DELETE /employees/:employeeId/documents/:id — soft delete (sets deletedAt).
async function removeDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.employeeDocument.findFirst({
      where: { id, businessId, employeeId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Document not found' });
    await prisma.employeeDocument.update({ where: { id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// GET /documents/expiring — tenant-wide (HR) report of documents already expired
// or expiring within the window. Ordered by soonest expiry first.
async function expiringDocuments(req, res, next) {
  try {
    const { businessId } = req.user;
    const { page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const soonDays = Math.max(parseInt(req.query.expiringDays, 10) || DEFAULT_EXPIRING_DAYS, 0);
    const now = Date.now();
    const soonMs = soonDays * 24 * 60 * 60 * 1000;
    const includeExpired = req.query.includeExpired !== 'false';

    const upper = new Date(now + soonMs);
    const where = {
      businessId,
      deletedAt: null,
      expiresAt: includeExpired ? { not: null, lte: upper } : { gte: new Date(now), lte: upper },
    };

    const [rows, total] = await Promise.all([
      prisma.employeeDocument.findMany({
        where,
        orderBy: { expiresAt: 'asc' },
        skip,
        take,
        include: { employee: { select: { firstName: true, lastName: true } } },
      }),
      prisma.employeeDocument.count({ where }),
    ]);
    const items = rows.map((d) => ({ ...annotateExpiry(d, now, soonMs), employee: d.employee }));
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take, windowDays: soonDays });
  } catch (e) { next(e); }
}

// ── ESS self-service surface (/me/documents — subject derived from session) ──

// A customer's portal identity links to an Employee via matching workEmail /
// personalEmail, or via the linked User. Tenant-scoped. Returns the employee id
// or null (mirror of payroll service resolveSelfEmployee).
async function resolveSelfEmployeeId(businessId, customer) {
  if (!customer || !customer.email) return null;
  const byEmail = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] },
    select: { id: true },
  });
  if (byEmail) return byEmail.id;
  const byUser = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select: { id: true },
  });
  return byUser ? byUser.id : null;
}

// GET /me/documents — the caller's OWN documents. Returns only EMPLOYEE_VISIBLE
// rows plus anything the caller signed (signatureStatus=SIGNED). HR_ONLY is
// NEVER returned here (§7 QA20). Subject is session-derived; no id from the body.
async function listMyDocuments(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employeeId = await resolveSelfEmployeeId(businessId, req.customer);
    if (!employeeId) return res.json({ items: [], total: 0 });

    const now = Date.now();
    const soonMs = DEFAULT_EXPIRING_DAYS * 24 * 60 * 60 * 1000;
    const where = {
      businessId,
      employeeId,
      deletedAt: null,
      // The employee's own view: EMPLOYEE_VISIBLE, or anything they have SIGNED
      // (a signed offer/contract is theirs to see regardless of visibility).
      OR: [
        { visibility: 'EMPLOYEE_VISIBLE' },
        { signatureStatus: 'SIGNED' },
      ],
    };
    const rows = await prisma.employeeDocument.findMany({ where, orderBy: { createdAt: 'desc' } });
    const items = rows.map((d) => annotateExpiry(d, now, soonMs));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// GET /me/documents/:id — a single own document (same visibility gate → 404).
async function getMyDocument(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employeeId = await resolveSelfEmployeeId(businessId, req.customer);
    if (!employeeId) return res.status(404).json({ message: 'Document not found' });
    const doc = await prisma.employeeDocument.findFirst({
      where: {
        id: req.params.id,
        businessId,
        employeeId,
        deletedAt: null,
        OR: [{ visibility: 'EMPLOYEE_VISIBLE' }, { signatureStatus: 'SIGNED' }],
      },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    res.json(annotateExpiry(doc, Date.now(), DEFAULT_EXPIRING_DAYS * 24 * 60 * 60 * 1000));
  } catch (e) { next(e); }
}

// POST /me/documents — the employee uploads their OWN document (e.g. an ID proof
// or certificate) for HR to verify. The subject is derived ENTIRELY from the
// session (resolveSelfEmployeeId) — a client-supplied employeeId is NEVER trusted.
// The upload is FORCED isEmployeeUploaded:true and left UNVERIFIED (verifiedAt /
// verifiedBy null = pending HR verification), mirroring the admin verify flow.
// File handling mirrors createDocument: base64 data-URL → s3.uploadDataUrl,
// fileHash = SHA-256(decoded bytes) server-side, ≤10 MB + PDF/PNG/JPG allow-list.
async function createMyDocument(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employeeId = await resolveSelfEmployeeId(businessId, req.customer);
    if (!employeeId) return res.status(404).json({ message: 'Employee not found' });

    const body = req.body || {};
    const { category, name } = body;
    const dataUrl = body.fileBase64 || body.dataUrl;
    if (!category) return res.status(400).json({ message: 'A document category is required' });
    if (!DOCUMENT_CATEGORIES.has(category)) {
      return res.status(422).json({ message: `Invalid document category: ${category}` });
    }

    // Validate the payload (MIME + ≤10 MB) BEFORE storing; decode + hash server-side.
    const docCheck = validateDocDataUrl(dataUrl);
    if (!docCheck.ok) return res.status(docCheck.status).json({ message: docCheck.message });
    const mimeType = docCheck.mime;
    const sizeBytes = docCheck.bytes;
    const fileHash = sha256(docCheck.buffer);

    // Store the bytes (S3 when configured, else embed the data URL — same as the
    // admin path so the row always carries REAL schema fields).
    let fileUrl;
    if (s3.isConfigured()) {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'employee-doc' });
      fileUrl = up.url;
    } else {
      fileUrl = dataUrl;
    }

    const doc = await prisma.employeeDocument.create({
      data: {
        businessId,
        employeeId,
        category,
        name: name || 'Document',
        fileUrl,
        fileHash,
        mimeType,
        sizeBytes,
        documentNumber: body.documentNumber || null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        // The employee's own upload is visible to them and awaits HR verification.
        visibility: 'EMPLOYEE_VISIBLE',
        isEmployeeUploaded: true,
        verifiedAt: null,
        verifiedBy: null,
      },
    });
    res.status(201).json(publicDoc(doc));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A document with that identity already exists' });
    next(e);
  }
}

// ── DocumentRequest (employee asks HR for a letter/certificate) ──────────────
// Rewritten against the REAL model (schema L8584): templateKind(TemplateKind),
// purpose, status(RequestStatus PENDING/APPROVED/REJECTED/CANCELLED),
// generatedDocumentId — NOT the old fabricated type/subject/handledById/notes.
// The actual letter GENERATION (fulfilment → EmployeeDocument) is slice 4f; here
// we keep a schema-correct list/get/create/cancel surface so the routes resolve.
const TEMPLATE_KINDS = new Set([
  'OFFER_LETTER', 'APPOINTMENT_LETTER', 'CONFIRMATION_LETTER', 'PROMOTION_LETTER',
  'RELIEVING_LETTER', 'EXPERIENCE_LETTER', 'SALARY_CERTIFICATE', 'WARNING_LETTER',
  'PAYSLIP', 'FORM16', 'FNF_STATEMENT', 'POLICY_ACK', 'OTHER',
]);

async function listRequests(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const { status, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
    const where = { businessId, employeeId };
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.documentRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.documentRequest.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function getRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const reqDoc = await prisma.documentRequest.findFirst({ where: { id, businessId, employeeId } });
    if (!reqDoc) return res.status(404).json({ message: 'Document request not found' });
    res.json(reqDoc);
  } catch (e) { next(e); }
}

async function createRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const { templateKind, purpose } = req.body || {};
    if (!templateKind) return res.status(400).json({ message: 'templateKind is required' });
    if (!TEMPLATE_KINDS.has(templateKind)) {
      return res.status(422).json({ message: `Invalid templateKind: ${templateKind}` });
    }
    const reqDoc = await prisma.documentRequest.create({
      data: { businessId, employeeId, templateKind, purpose: purpose || null, status: 'PENDING' },
    });
    res.status(201).json(reqDoc);
  } catch (e) { next(e); }
}

async function cancelRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.documentRequest.findFirst({ where: { id, businessId, employeeId } });
    if (!existing) return res.status(404).json({ message: 'Document request not found' });
    if (existing.status !== 'PENDING') {
      return res.status(409).json({ message: `Cannot cancel a request in status ${existing.status}` });
    }
    const reqDoc = await prisma.documentRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
    res.json(reqDoc);
  } catch (e) { next(e); }
}

module.exports = {
  // HR / manager (per-employee, F1-scoped)
  listDocuments,
  getDocument,
  createDocument,
  verifyDocument,
  updateDocument,
  removeDocument,
  expiringDocuments,
  // ESS self-service
  listMyDocuments,
  getMyDocument,
  createMyDocument,
  // DocumentRequest (schema-correct minimal surface; generation lands in 4f)
  listRequests,
  getRequest,
  createRequest,
  cancelRequest,
  // exported for reuse/tests
  validateDocDataUrl,
  sha256,
  DOCUMENT_CATEGORIES,
};

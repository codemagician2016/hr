'use strict';

/**
 * letterheads.controller.js — Letters slice 9C. CRUD for CompanyLetterhead
 * (uploaded A4 PDF + visual position-picker layout) against the REAL
 * CompanyLetterhead model (schema.prisma:8800, merged in 9A).
 *
 * RBAC posture (docs/features/09-letters-communication.md §4.4/§4.5): every
 * endpoint is mounted under `protect` + `requirePermission('canManageLetters')`
 * (the config/checker key). These are TENANT-level config endpoints — no
 * per-employee F1 scope — but every query is `where:{ businessId }`-scoped, so a
 * cross-tenant id resolves to 404 (never leaks another tenant's row).
 *
 * Upload (§9): the A4 PDF arrives as a base64 data-URL. We reuse
 * `validateDocDataUrl` from the documents controller (≤10MB DoS pre-check + MIME
 * allow-list + server-side SHA-256 — never trust client mimeType/sizeBytes), but
 * we further constrain MIME to application/pdf only (a letterhead is a PDF, not a
 * scanned image). We then MEASURE page 1 with pdf-lib `getPage(0).getSize()` to
 * store `pageWidthPt/pageHeightPt` and warn (not refuse) on a wildly non-A4 page.
 * Bytes are stored via `s3.uploadDataUrl` with an inline-data-URL fallback when
 * no bucket is configured (mirrors documents.controller).
 *
 * Layout (§5.1): the visual picker posts normalized [0,1] TOP-LEFT rects for the
 * 5 zones (writingArea + fields.date/refNo/authority/signature). We schema-
 * validate every rect ∈ [0,1] before persisting `layoutJson`.
 *
 * Partial-unique binding (§3.2): the migration carries two raw-SQL partial-unique
 * indexes — one default per (tenant, entity) and one letterhead per category per
 * (tenant, entity). A 2nd default / 2nd-per-category write trips a Postgres
 * unique violation (Prisma P2002); we translate it to a graceful 409 instead of a
 * 500.
 */

const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const prisma = require('../../../core/lib/prisma');
const s3 = require('../../../core/lib/s3');
const { validateDocDataUrl } = require('../../controllers/documents.controller');

// LetterCategory enum (mirror schema.prisma:8782). A binding value outside this
// set would make Prisma 500; we reject with 422 instead.
const LETTER_CATEGORIES = new Set([
  'EXPERIENCE', 'BONAFIDE', 'EMPLOYMENT_PROOF', 'SALARY_PROOF', 'BANK', 'CONTRACT', 'CUSTOM',
]);

// A4 at 72pt/in = 595.28 × 841.89 pt. We warn (never refuse) when the uploaded
// page strays beyond this tolerance — an off-A4 letterhead still renders (the
// engine reads the real page size), but the operator should know.
const A4_W = 595.28;
const A4_H = 841.89;
const A4_TOLERANCE = 0.06; // ±6%

// Public field set returned to clients (the picker needs fileUrl to rasterize
// page 1 client-side; fileHash is the integrity anchor).
const LH_PUBLIC = [
  'id', 'businessId', 'entityId', 'code', 'name', 'fileUrl', 'fileHash', 'mimeType',
  'sizeBytes', 'pageWidthPt', 'pageHeightPt', 'layoutJson', 'fontKey', 'letterCategory',
  'isDefault', 'isActive', 'createdAt', 'updatedAt', 'version',
];

function publicLetterhead(row) {
  const out = {};
  for (const f of LH_PUBLIC) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Application-level invariant pre-check for the single-default / single-per-
// category bindings. The 9A migration carries partial-unique indexes
// (uniq_letterhead_default / uniq_letterhead_category) keyed on
// ("businessId","entityId"[, "letterCategory"]) — but Postgres treats NULL
// entityId values as DISTINCT in a unique index, so the DB backstop does NOT
// fire for the common tenant-wide (entityId IS NULL) case. We enforce the
// invariant here too so a 2nd default / 2nd-per-category bind is rejected with a
// graceful 409 regardless of whether entityId is null. Returns a 409 message
// string when the binding conflicts, or null when it's free. `excludeId` lets an
// UPDATE skip the row being edited.
async function conflictingBinding({ businessId, entityId, isDefault, letterCategory }, excludeId) {
  if (isDefault) {
    const clash = await prisma.companyLetterhead.findFirst({
      where: {
        businessId,
        entityId: entityId ?? null,
        isDefault: true,
        deletedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      return 'Another active letterhead is already the default for this entity. Unset it first, or bind this one to a category instead.';
    }
  }
  if (letterCategory) {
    const clash = await prisma.companyLetterhead.findFirst({
      where: {
        businessId,
        entityId: entityId ?? null,
        letterCategory,
        deletedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      return 'Another active letterhead is already bound to this category for this entity. Unbind it first.';
    }
  }
  return null;
}

// Translate the partial-unique violations into a human 409. The constraint name
// (when present on a P2002) lets us tell "2nd default" from "2nd-per-category".
function partialUniqueMessage(err) {
  const target = err && err.meta && err.meta.target;
  const name = Array.isArray(target) ? target.join(',') : String(target || '');
  if (name.includes('default')) {
    return 'Another active letterhead is already the default for this entity. Unset it first, or bind this one to a category instead.';
  }
  if (name.includes('category')) {
    return 'Another active letterhead is already bound to this category for this entity. Unbind it first.';
  }
  // The @@unique([businessId, code]) collision.
  if (name.includes('code')) return 'A letterhead with that code already exists.';
  return 'This letterhead binding conflicts with an existing one.';
}

// ── rect / layout validation ──────────────────────────────────────────────────
// A rect is { x, y, w, h } with every value a finite number ∈ [0,1] (normalized,
// top-left origin) and x+w ≤ 1, y+h ≤ 1 (the box stays on the page). Optional
// presentation keys (align/fontSize/lineGap) are validated leniently.
function isFinNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function inUnit(v) { return isFinNum(v) && v >= 0 && v <= 1; }

function validateRect(rect, label, errors) {
  if (rect == null) return; // a missing zone is allowed (operator may not place all 5)
  if (typeof rect !== 'object' || Array.isArray(rect)) {
    errors.push(`${label}: must be an object`); return;
  }
  for (const k of ['x', 'y', 'w', 'h']) {
    if (!inUnit(rect[k])) { errors.push(`${label}.${k}: must be a number in [0,1]`); }
  }
  if (inUnit(rect.x) && inUnit(rect.w) && rect.x + rect.w > 1.0001) {
    errors.push(`${label}: x+w exceeds page width (must be ≤ 1)`);
  }
  if (inUnit(rect.y) && inUnit(rect.h) && rect.y + rect.h > 1.0001) {
    errors.push(`${label}: y+h exceeds page height (must be ≤ 1)`);
  }
  if (rect.align !== undefined && !['left', 'right', 'center'].includes(rect.align)) {
    errors.push(`${label}.align: must be left|right|center`);
  }
  if (rect.fontSize !== undefined && !(isFinNum(rect.fontSize) && rect.fontSize > 0 && rect.fontSize <= 200)) {
    errors.push(`${label}.fontSize: must be a positive number ≤ 200`);
  }
  if (rect.lineGap !== undefined && !(isFinNum(rect.lineGap) && rect.lineGap >= 0 && rect.lineGap <= 200)) {
    errors.push(`${label}.lineGap: must be a number in [0,200]`);
  }
}

// Validate + normalize the whole layoutJson into a clean stored shape. Returns
// { ok, layout } or { ok:false, errors }.
function validateLayout(layoutJson) {
  if (layoutJson == null || typeof layoutJson !== 'object' || Array.isArray(layoutJson)) {
    return { ok: false, errors: ['layoutJson must be an object'] };
  }
  const errors = [];
  validateRect(layoutJson.writingArea, 'writingArea', errors);
  const fields = layoutJson.fields;
  if (fields != null) {
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      errors.push('fields: must be an object');
    } else {
      for (const z of ['date', 'refNo', 'authority', 'signature', 'subject']) {
        validateRect(fields[z], `fields.${z}`, errors);
      }
    }
  }
  if (layoutJson.overflowPolicy !== undefined
    && !['repeat-letterhead', 'blank-continuation'].includes(layoutJson.overflowPolicy)) {
    errors.push('overflowPolicy: must be repeat-letterhead|blank-continuation');
  }
  if (layoutJson.signatureOnLastPage !== undefined && typeof layoutJson.signatureOnLastPage !== 'boolean') {
    errors.push('signatureOnLastPage: must be a boolean');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, layout: layoutJson };
}

// ── GET /letterheads — list (tenant-scoped, optional isActive filter) ─────────
async function listLetterheads(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, deletedAt: null };
    if (req.query.isActive === 'true') where.isActive = true;
    else if (req.query.isActive === 'false') where.isActive = false;
    if (req.query.entityId) where.entityId = req.query.entityId;
    const rows = await prisma.companyLetterhead.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ items: rows.map(publicLetterhead) });
  } catch (e) { next(e); }
}

// ── POST /letterheads — upload an A4 PDF + create the row ──────────────────────
async function createLetterhead(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const { code, name } = body;
    if (!code || !String(code).trim()) return res.status(400).json({ message: 'A letterhead code is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'A letterhead name is required' });

    const dataUrl = body.fileBase64 || body.dataUrl;
    // Reuse the documents validator: ≤10MB + MIME allow-list + server-side decode.
    const check = validateDocDataUrl(dataUrl);
    if (!check.ok) return res.status(check.status).json({ message: check.message });
    // A letterhead must be a PDF specifically (the validator also allows images).
    if (check.mime !== 'application/pdf') {
      return res.status(422).json({ message: 'A letterhead must be a PDF (application/pdf).' });
    }
    const fileHash = sha256(check.buffer);
    const sizeBytes = check.bytes;

    // Measure page 1 with pdf-lib to record the real page size + guard non-A4.
    let pageWidthPt = null;
    let pageHeightPt = null;
    let nonA4Warning = null;
    try {
      const doc = await PDFDocument.load(new Uint8Array(check.buffer.buffer, check.buffer.byteOffset, check.buffer.byteLength));
      if (doc.getPageCount() < 1) {
        return res.status(422).json({ message: 'The uploaded PDF has no pages.' });
      }
      const { width, height } = doc.getPage(0).getSize();
      pageWidthPt = width;
      pageHeightPt = height;
      const wOff = Math.abs(width - A4_W) / A4_W;
      const hOff = Math.abs(height - A4_H) / A4_H;
      if (wOff > A4_TOLERANCE || hOff > A4_TOLERANCE) {
        nonA4Warning = `Page 1 is ${Math.round(width)}×${Math.round(height)}pt — not standard A4 (595×842pt). It will still render at its native size.`;
      }
    } catch (_e) {
      return res.status(422).json({ message: 'The uploaded file is not a readable PDF.' });
    }

    // Store the bytes (S3 when configured, else inline data-URL fallback).
    let fileUrl;
    if (s3.isConfigured()) {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'letterhead' });
      fileUrl = up.url;
    } else {
      fileUrl = dataUrl;
    }

    // Optional binding on create (default | per-category) — validated below.
    const letterCategory = body.letterCategory || null;
    if (letterCategory && !LETTER_CATEGORIES.has(letterCategory)) {
      return res.status(422).json({ message: `Invalid letter category: ${letterCategory}` });
    }
    const isDefault = body.isDefault === true;
    const entityId = body.entityId || null;

    // An empty seed layout — the picker fills it via PUT /:id/layout.
    const layoutJson = body.layoutJson != null ? body.layoutJson : {};
    if (body.layoutJson != null) {
      const v = validateLayout(body.layoutJson);
      if (!v.ok) return res.status(422).json({ message: 'Invalid layout', errors: v.errors });
    }

    // Enforce the single-default / single-per-category invariant in app code (the
    // DB partial-unique misses the NULL-entity case — see conflictingBinding).
    const bindClash = await conflictingBinding({ businessId, entityId, isDefault, letterCategory });
    if (bindClash) return res.status(409).json({ message: bindClash });

    const row = await prisma.companyLetterhead.create({
      data: {
        businessId,
        entityId,
        code: String(code).trim(),
        name: String(name).trim(),
        fileUrl,
        fileHash,
        mimeType: 'application/pdf',
        sizeBytes,
        pageWidthPt,
        pageHeightPt,
        layoutJson,
        fontKey: body.fontKey || 'noto-sans',
        letterCategory,
        isDefault,
        isActive: body.isActive === false ? false : true,
      },
    });
    res.status(201).json({ ...publicLetterhead(row), ...(nonA4Warning ? { warning: nonA4Warning } : {}) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: partialUniqueMessage(e) });
    next(e);
  }
}

// ── GET /letterheads/:id — one (incl. fileUrl for the client-side picker) ──────
async function getLetterhead(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await prisma.companyLetterhead.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
    });
    if (!row) return res.status(404).json({ message: 'Letterhead not found' });
    res.json(publicLetterhead(row));
  } catch (e) { next(e); }
}

// ── PUT /letterheads/:id/layout — persist normalized rects from the picker ─────
async function saveLayout(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.companyLetterhead.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Letterhead not found' });

    const layoutJson = (req.body || {}).layoutJson !== undefined ? req.body.layoutJson : req.body;
    const v = validateLayout(layoutJson);
    if (!v.ok) return res.status(422).json({ message: 'Invalid layout', errors: v.errors });

    const row = await prisma.companyLetterhead.update({
      where: { id: existing.id },
      data: { layoutJson: v.layout, version: { increment: 1 } },
    });
    res.json(publicLetterhead(row));
  } catch (e) { next(e); }
}

// ── PUT /letterheads/:id — name/code/binding/isDefault/isActive ────────────────
async function updateLetterhead(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.companyLetterhead.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Letterhead not found' });

    const body = req.body || {};
    const data = {};
    if (body.name !== undefined) {
      if (!String(body.name).trim()) return res.status(400).json({ message: 'Name cannot be empty' });
      data.name = String(body.name).trim();
    }
    if (body.code !== undefined) {
      if (!String(body.code).trim()) return res.status(400).json({ message: 'Code cannot be empty' });
      data.code = String(body.code).trim();
    }
    if (body.entityId !== undefined) data.entityId = body.entityId || null;
    if (body.fontKey !== undefined) data.fontKey = body.fontKey || 'noto-sans';
    if (body.letterCategory !== undefined) {
      if (body.letterCategory && !LETTER_CATEGORIES.has(body.letterCategory)) {
        return res.status(422).json({ message: `Invalid letter category: ${body.letterCategory}` });
      }
      data.letterCategory = body.letterCategory || null;
    }
    if (body.isDefault !== undefined) data.isDefault = body.isDefault === true;
    if (body.isActive !== undefined) data.isActive = body.isActive === true;

    if (!Object.keys(data).length) return res.json(publicLetterhead(existing));

    // Re-check the binding invariant against the RESULTING state (existing values
    // overlaid with this patch), excluding the row itself. Mirrors create's
    // app-level guard so flipping a 2nd row to default / same-category ⇒ 409.
    const resulting = {
      businessId,
      entityId: data.entityId !== undefined ? data.entityId : existing.entityId,
      isDefault: data.isDefault !== undefined ? data.isDefault : existing.isDefault,
      letterCategory: data.letterCategory !== undefined ? data.letterCategory : existing.letterCategory,
    };
    const bindClash = await conflictingBinding(resulting, existing.id);
    if (bindClash) return res.status(409).json({ message: bindClash });

    data.version = { increment: 1 };

    const row = await prisma.companyLetterhead.update({ where: { id: existing.id }, data });
    res.json(publicLetterhead(row));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: partialUniqueMessage(e) });
    next(e);
  }
}

// ── DELETE /letterheads/:id — soft-delete (config model carries deletedAt) ─────
// SetNull on IssuedLetter.letterheadId keeps issued-letter history intact, so a
// soft-delete is safe even when referenced. Clearing isDefault/binding on delete
// frees the partial-unique slot for a replacement.
async function deleteLetterhead(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.companyLetterhead.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Letterhead not found' });
    await prisma.companyLetterhead.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false, isDefault: false, version: { increment: 1 } },
    });
    res.json({ ok: true, id: existing.id });
  } catch (e) { next(e); }
}

module.exports = {
  listLetterheads,
  createLetterhead,
  getLetterhead,
  saveLayout,
  updateLetterhead,
  deleteLetterhead,
  // exported for the slice 9C controller test
  _internals: { validateLayout, partialUniqueMessage },
};

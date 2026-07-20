'use strict';

/*
 * letterLibrary.controller.js — Feature 39.
 *   (a) Tenant letter CATEGORIES ("Bank Resolution", "Visa Letter"…) — a managed
 *       list with type-to-create, used to group/filter templates + issued letters.
 *   (b) Reusable SIGNATURE / STAMP assets — uploaded once per tenant and referenced
 *       by any number of templates, so HR never re-uploads the same seal.
 * Both are tenant config: routes require canManageLetters (see the routes file).
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const s3 = require('../../../core/lib/s3');
const { writeAudit } = require('../../../core/lib/audit');
const { validateDocDataUrl } = require('../../controllers/documents.controller');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ASSET_KINDS = new Set(['SIGNATURE', 'STAMP']);
const fail = (res, status, message, extra) => res.status(status).json({ message, ...(extra || {}) });

// ── categories ────────────────────────────────────────────────────────────────
async function listCategories(req, res, next) {
  try {
    const items = await prisma.letterCategoryTag.findMany({
      where: { businessId: req.user.businessId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// Create (idempotent by name) — powers "type-to-create" in the template editor.
async function createCategory(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return fail(res, 422, 'A category name is required');
    if (name.length > 60) return fail(res, 422, 'Category name is too long (max 60)');
    const existing = await prisma.letterCategoryTag.findFirst({ where: { businessId, name } });
    if (existing) {
      // reactivate a previously archived one rather than 409ing the author.
      const row = existing.isActive ? existing
        : await prisma.letterCategoryTag.update({ where: { id: existing.id }, data: { isActive: true } });
      return res.status(200).json(row);
    }
    const row = await prisma.letterCategoryTag.create({
      data: { businessId, name, sortOrder: Number(req.body.sortOrder) || 0 },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'letter.category.create', entityType: 'LetterCategoryTag', entityId: row.id, meta: { name } });
    res.status(201).json(row);
  } catch (e) { next(e); }
}

async function updateCategory(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const existing = await prisma.letterCategoryTag.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return fail(res, 404, 'Category not found');
    const data = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return fail(res, 422, 'A category name is required');
      data.name = name;
    }
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
    try {
      res.json(await prisma.letterCategoryTag.update({ where: { id: existing.id }, data }));
    } catch (e) {
      if (e.code === 'P2002') return fail(res, 409, 'A category with that name already exists');
      throw e;
    }
  } catch (e) { next(e); }
}

// Archive (soft) — templates keep their categoryId; issued letters keep the snapshot.
async function deleteCategory(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const existing = await prisma.letterCategoryTag.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return fail(res, 404, 'Category not found');
    await prisma.letterCategoryTag.update({ where: { id: existing.id }, data: { isActive: false } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'letter.category.archive', entityType: 'LetterCategoryTag', entityId: existing.id, meta: {} });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

// ── reusable signature / stamp assets ─────────────────────────────────────────
async function listAssets(req, res, next) {
  try {
    const where = { businessId: req.user.businessId, isActive: true };
    const kind = req.query.kind ? String(req.query.kind).toUpperCase() : null;
    if (kind) {
      if (!ASSET_KINDS.has(kind)) return fail(res, 422, 'kind must be SIGNATURE or STAMP');
      where.kind = kind;
    }
    const items = await prisma.letterAsset.findMany({ where, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
    res.json({ items });
  } catch (e) { next(e); }
}

// Upload once → reuse on any template. Body: { kind, name, fileBase64 } (PNG).
async function createAsset(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const b = req.body || {};
    const kind = String(b.kind || '').toUpperCase();
    if (!ASSET_KINDS.has(kind)) return fail(res, 422, 'kind must be SIGNATURE or STAMP');
    const name = String(b.name || '').trim() || (kind === 'STAMP' ? 'Company stamp' : 'Signature');
    const dataUrl = b.fileBase64 || b.dataUrl || '';
    const check = validateDocDataUrl(dataUrl);
    if (!check.ok) return res.status(check.status).json({ message: check.message });
    // The renderer embeds these via pdf-lib embedPng, so require PNG (transparency).
    if (check.mime !== 'image/png') return fail(res, 422, `A ${kind.toLowerCase()} must be a PNG image (transparent background recommended).`);

    let imageUrl;
    if (s3.isConfigured()) {
      imageUrl = (await s3.uploadDataUrl({ dataUrl, businessId, scope: `letter-${kind.toLowerCase()}` })).url;
    } else {
      imageUrl = dataUrl; // inline fallback (dev / no bucket), mirrors letterheads
    }
    const row = await prisma.letterAsset.create({
      data: { businessId, kind, name, imageUrl, imageHash: sha256(check.buffer), mimeType: check.mime, sizeBytes: check.bytes },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'letter.asset.create', entityType: 'LetterAsset', entityId: row.id, meta: { kind, name } });
    res.status(201).json(row);
  } catch (e) { next(e); }
}

async function deleteAsset(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const existing = await prisma.letterAsset.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return fail(res, 404, 'Asset not found');
    // Soft-archive: templates referencing it keep working until re-pointed.
    await prisma.letterAsset.update({ where: { id: existing.id }, data: { isActive: false } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'letter.asset.archive', entityType: 'LetterAsset', entityId: existing.id, meta: { kind: existing.kind } });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { listCategories, createCategory, updateCategory, deleteCategory, listAssets, createAsset, deleteAsset };

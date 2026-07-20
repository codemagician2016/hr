'use strict';

/**
 * templates.controller.js — Letter template library (Feature 9, slice 9D).
 *
 * The `LetterTemplate` model (schema.prisma#LetterTemplate, slice 9A) is a
 * reusable, VERSIONED letter body + a declared merge-field allow-list. Templates
 * are tenant config: every route is mounted under `protect` +
 * `requirePermission('canManageLetters')` (see routes/templates.routes.js) and
 * every query is `where:{ businessId }`-scoped, so a cross-tenant id resolves to
 * 404 (never 403 / never a Prisma leak).
 *
 * Endpoint surface (docs/features/09 §4.5):
 *   GET    /                       list (filters: category, country, status, q)
 *   POST   /                       create (DRAFT or published)
 *   GET    /:id                    one
 *   PUT    /:id                    update → bumps `version` (value-pinned versioning)
 *   POST   /:id/publish            isActive=true (PUBLISHED)
 *   POST   /:id/archive            isActive=false (DRAFT/ARCHIVED)
 *   DELETE /:id                    soft-delete (deletedAt); REFUSES on isSystem
 *   GET    /merge-fields           the §7 placeholder palette (filter ?category &?country)
 *
 * Versioning is VALUE-PINNED, not row-cloned: each edit bumps `version`; an
 * IssuedLetter snapshots the rendered body + templateVersionAtIssue at issue, so
 * the issued letter stays immutable even after the template changes. We therefore
 * never clone rows here — PUT just mutates + increments.
 *
 * Body is MERGE-FIELDS-ONLY (no raw HTML/script — XSS posture, §9). We do not
 * sanitize HTML here because the renderer draws plain text via pdf-lib drawText;
 * what we DO is validate that mergeFieldsJson keys are real catalog tokens.
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const s3 = require('../../../core/lib/s3');
const { writeAudit } = require('../../../core/lib/audit');
const { validateDocDataUrl } = require('../../controllers/documents.controller');
const { mergeFieldCatalog, CATALOG } = require('../mergeFields');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const strOrNull = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);

// Validate/sanitize a per-template signature placement box: normalized {x,y,w,h}
// in [0,1]. Returns null to CLEAR, a clamped object to SET, or undefined when the
// input is malformed (caller 422s).
function sanitizeSigBox(v) {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const n = (x, d) => { const f = Number(x); return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : d; };
  return { x: n(v.x, 0.1), y: n(v.y, 0.76), w: n(v.w, 0.25), h: n(v.h, 0.06) };
}

// Phase 3 — manual (at-issue) fields. Sanitize the declared list: each entry
// { key (alphanumeric, token-safe), label, type, required }. Returns null to
// CLEAR, a normalized array to SET, or undefined when malformed (caller 422s).
const MANUAL_FIELD_TYPES = new Set(['text', 'date', 'number', 'currency']);
function sanitizeManualFields(v) {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const out = [];
  const seen = new Set();
  for (const f of v) {
    if (!f || typeof f !== 'object') return undefined;
    const key = typeof f.key === 'string' ? f.key.trim() : '';
    // must match the {{manual.<key>}} token grammar (letter then alphanumerics).
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || seen.has(key)) return undefined;
    seen.add(key);
    out.push({
      key,
      label: typeof f.label === 'string' && f.label.trim() ? f.label.trim() : key,
      type: MANUAL_FIELD_TYPES.has(f.type) ? f.type : 'text',
      required: !!f.required,
    });
  }
  return out;
}
// The set of {{manual.<key>}} tokens a declared manual-fields list authorizes.
function manualKeySet(manualFieldsJson) {
  const set = new Set();
  if (Array.isArray(manualFieldsJson)) for (const f of manualFieldsJson) if (f && f.key) set.add(`manual.${f.key}`);
  return set;
}

// LetterCategory enum (mirror prisma/schema.prisma#LetterCategory — writing a
// value outside this set 500s in Prisma; we 422 instead).
const LETTER_CATEGORIES = new Set([
  'EXPERIENCE', 'BONAFIDE', 'EMPLOYMENT_PROOF', 'SALARY_PROOF', 'BANK', 'CONTRACT', 'CUSTOM',
]);
// IN / NZ wording split (countryCode is @db.Char(2)). null = market-agnostic.
const COUNTRY_CODES = new Set(['IN', 'NZ']);

// Public projection. We expose the body + merge-field allow-list (the editor
// needs them) but never leak Prisma internals; deletedAt is implicit (filtered).
const TEMPLATE_PUBLIC = [
  'id', 'businessId', 'entityId', 'code', 'name', 'category', 'countryCode',
  'subject', 'bodyMarkdown', 'mergeFieldsJson', 'defaultLetterheadId',
  'requiresSignature', 'refNoPrefix', 'locale', 'isSystem', 'isActive',
  'version', 'createdAt', 'updatedAt',
  // Phase 2 — signatory block + static signature placement/flags. The signature
  // IMAGE (signatureImageUrl) is small (a PNG scan) and the editor needs it to
  // preview/place, so it is included here rather than behind a separate fetch.
  'signatureImageUrl', 'signatureBoxJson', 'signatureOnLastPage',
  'authorityName', 'authorityDesignation',
  // Phase 3 — declared manual (at-issue) fields (the issue wizard renders inputs).
  'manualFieldsJson',
  // Feature 39 — tenant category + reusable signature/stamp assets + stamp placement.
  'categoryId', 'signatureAssetId', 'stampAssetId', 'stampBoxJson',
];

function publicTemplate(t) {
  if (!t) return t;
  const out = {};
  for (const f of TEMPLATE_PUBLIC) if (t[f] !== undefined) out[f] = t[f];
  // A coarse status for the library grid: PUBLISHED vs DRAFT (isActive is the
  // published flag per the model comment; archived rows are also isActive=false).
  out.status = t.isActive ? 'PUBLISHED' : 'DRAFT';
  return out;
}

// Validate that every declared merge field is a real catalog token (so the UI
// palette + the renderer agree). Returns the list of unknown keys.
function unknownMergeFields(mergeFieldsJson) {
  if (mergeFieldsJson == null) return [];
  if (typeof mergeFieldsJson !== 'object' || Array.isArray(mergeFieldsJson)) return ['<not-an-object>'];
  return Object.keys(mergeFieldsJson).filter((k) => !(k in CATALOG));
}

// The {{namespace.field}} token grammar (mirror mergeFields.TOKEN_RE). We extract
// the same well-formed tokens the renderer substitutes — anything else is literal
// text and not a merge field.
const BODY_TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

// Pull the distinct {{tokens}} referenced anywhere in the supplied text(s).
function extractBodyTokens(...texts) {
  const set = new Set();
  for (const t of texts) {
    if (typeof t !== 'string' || !t) continue;
    BODY_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = BODY_TOKEN_RE.exec(t)) !== null) set.add(m[1]);
  }
  return [...set];
}

// Tokens used in the body/subject that the catalog doesn't know. These would be
// silently stripped at render time (renderMerge drops unknown tokens), so we
// reject them at save time instead — the editor gets a precise list to fix.
function unknownBodyTokens({ bodyMarkdown, subject, manualKeys }) {
  const allowManual = manualKeys instanceof Set ? manualKeys : new Set();
  return extractBodyTokens(bodyMarkdown, subject).filter((t) => !(t in CATALOG) && !allowManual.has(t));
}

function fail(res, status, message, extra) {
  return res.status(status).json({ message, ...(extra || {}) });
}

// ── tenant country resolution (India-first template filter) ───────────────────
// The Issue/Templates dropdowns must show ONLY the tenant's market (an India
// tenant must never see NZ templates). We resolve the tenant's country from
// Business.country, else the first Entity's countryCode, else default IN
// (India-first). One cheap read per list call.
async function resolveTenantCountry(businessId) {
  if (!businessId) return 'IN';
  const biz = await prisma.business.findFirst({
    where: { id: businessId },
    select: { country: true },
  });
  let cc = biz && biz.country ? String(biz.country).toUpperCase() : null;
  if (!cc || !COUNTRY_CODES.has(cc)) {
    const ent = await prisma.entity.findFirst({
      where: { businessId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { countryCode: true },
    });
    cc = ent && ent.countryCode ? String(ent.countryCode).toUpperCase() : null;
  }
  return COUNTRY_CODES.has(cc) ? cc : 'IN'; // India-first default
}

// ── GET /merge-fields ─────────────────────────────────────────────────────────
// Returns the §7 placeholder palette for the editor inserter drawer, filtered by
// ?country (IN | NZ — drops the other market's statutory namespace) and ?category
// (forward-compat; the catalog is category-agnostic today so category does not
// prune, but we echo it so the UI can group). Available to any canManageLetters
// operator; no DB read (pure catalog).
async function listMergeFields(req, res) {
  const country = req.query.country ? String(req.query.country).toUpperCase() : undefined;
  if (country && !COUNTRY_CODES.has(country)) {
    return fail(res, 422, `Unknown country "${country}". Allowed: IN, NZ.`);
  }
  const category = req.query.category ? String(req.query.category).toUpperCase() : undefined;
  if (category && !LETTER_CATEGORIES.has(category)) {
    return fail(res, 422, `Unknown category "${category}".`);
  }
  const catalog = mergeFieldCatalog({ country });
  // Shape into a grouped palette the inserter can render directly:
  //   [{ namespace, fields: [{ token, type, gatedBy, country }] }]
  const groups = {};
  for (const [token, spec] of Object.entries(catalog)) {
    const ns = spec.namespace;
    (groups[ns] || (groups[ns] = [])).push({
      token,
      insert: `{{${token}}}`,
      type: spec.type,
      gatedBy: spec.gatedBy,
      country: spec.country,
    });
  }
  const palette = Object.entries(groups).map(([namespace, fields]) => ({ namespace, fields }));
  return res.json({ country: country || null, category: category || null, palette, fields: catalog });
}

// ── GET / (list) ──────────────────────────────────────────────────────────────
async function listTemplates(req, res) {
  const businessId = req.user.businessId;
  const where = { businessId, deletedAt: null };
  // Feature 39 — filter by the TENANT category tag (e.g. "Bank Resolution").
  if (req.query.categoryId) where.categoryId = String(req.query.categoryId);

  if (req.query.category) {
    const cat = String(req.query.category).toUpperCase();
    if (!LETTER_CATEGORIES.has(cat)) return fail(res, 422, `Unknown category "${cat}".`);
    where.category = cat;
  }
  // India-first country filter. Precedence:
  //   - ?country=ALL          → no country filter (Templates-management "see all").
  //   - ?country=IN|NZ        → that market only (explicit override).
  //   - (omitted)             → DEFAULT to the TENANT's country so an India tenant
  //                             never sees NZ templates. We include market-agnostic
  //                             (countryCode null) templates alongside the tenant's
  //                             market so universal templates stay available.
  const rawCountry = req.query.country ? String(req.query.country).toUpperCase() : '';
  if (rawCountry === 'ALL') {
    // explicit opt-out — no country constraint
  } else if (rawCountry) {
    if (!COUNTRY_CODES.has(rawCountry)) return fail(res, 422, `Unknown country "${rawCountry}". Allowed: IN, NZ.`);
    where.countryCode = rawCountry;
  } else {
    // Default to the tenant's market + market-agnostic templates. Use AND so this
    // never clashes with the search-`q` OR set below (top-level OR can't co-exist).
    const tenantCountry = await resolveTenantCountry(businessId);
    where.AND = (where.AND || []).concat([{ OR: [{ countryCode: tenantCountry }, { countryCode: null }] }]);
  }
  // status filter: PUBLISHED (isActive) | DRAFT (!isActive). Default: all.
  if (req.query.status) {
    const st = String(req.query.status).toUpperCase();
    if (st === 'PUBLISHED' || st === 'ACTIVE') where.isActive = true;
    else if (st === 'DRAFT' || st === 'ARCHIVED' || st === 'INACTIVE') where.isActive = false;
  }
  if (req.query.system === 'true') where.isSystem = true;
  if (req.query.system === 'false') where.isSystem = false;

  const q = req.query.q ? String(req.query.q).trim() : '';
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { code: { contains: q, mode: 'insensitive' } },
      { subject: { contains: q, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.letterTemplate.findMany({
    where,
    orderBy: [{ category: 'asc' }, { countryCode: 'asc' }, { name: 'asc' }],
  });
  return res.json({ items: rows.map(publicTemplate) });
}

// ── GET /:id ────────────────────────────────────────────────────────────────--
async function getTemplate(req, res) {
  const businessId = req.user.businessId;
  const row = await prisma.letterTemplate.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
  });
  if (!row) return fail(res, 404, 'Template not found');
  return res.json(publicTemplate(row));
}

// ── POST / (create) ─────────────────────────────────────────────────────────--
async function createTemplate(req, res) {
  const businessId = req.user.businessId;
  const b = req.body || {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return fail(res, 422, 'A template name is required');

  const category = b.category ? String(b.category).toUpperCase() : '';
  if (!LETTER_CATEGORIES.has(category)) {
    return fail(res, 422, `category must be one of: ${[...LETTER_CATEGORIES].join(', ')}`);
  }

  let countryCode = null;
  if (b.countryCode != null && b.countryCode !== '') {
    countryCode = String(b.countryCode).toUpperCase();
    if (!COUNTRY_CODES.has(countryCode)) return fail(res, 422, 'countryCode must be IN or NZ');
  }

  const bodyMarkdown = typeof b.bodyMarkdown === 'string' ? b.bodyMarkdown : '';
  if (!bodyMarkdown.trim()) return fail(res, 422, 'A template body (bodyMarkdown) is required');

  const subject = typeof b.subject === 'string' ? b.subject : null;

  // mergeFieldsJson must reference real catalog tokens (UI palette ↔ renderer agreement).
  const unknown = unknownMergeFields(b.mergeFieldsJson);
  if (unknown.length) return fail(res, 422, 'mergeFieldsJson references unknown merge fields', { unknownMergeFields: unknown });

  // The body/subject themselves must only use catalog tokens. An unknown {{token}}
  // would be stripped silently at render (renderMerge drops it), so reject it here
  // with the exact list — the editor highlights the typo before it ships a letter
  // with a hole where a field should be.
  // Phase 3 — declared manual fields authorize {{manual.<key>}} tokens in the body.
  let manualFields;
  if (b.manualFieldsJson !== undefined) {
    manualFields = sanitizeManualFields(b.manualFieldsJson);
    if (manualFields === undefined) return fail(res, 422, 'manualFieldsJson must be an array of {key,label,type,required} with unique alphanumeric keys');
  }
  const unknownInBody = unknownBodyTokens({ bodyMarkdown, subject, manualKeys: manualKeySet(manualFields) });
  if (unknownInBody.length) {
    return fail(res, 422, 'The letter body references unknown merge fields', { unknownMergeFields: unknownInBody });
  }

  // code: tenant-unique. Auto-derive from name if not provided; ensure unique.
  let code = typeof b.code === 'string' && b.code.trim() ? b.code.trim() : null;
  if (!code) {
    const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'LTR';
    code = `${slug}${countryCode ? `-${countryCode}` : ''}-${Date.now().toString(36).toUpperCase()}`;
  }

  let sigBox;
  if (b.signatureBoxJson !== undefined) {
    sigBox = sanitizeSigBox(b.signatureBoxJson);
    if (sigBox === undefined) return fail(res, 422, 'signatureBoxJson must be a normalized {x,y,w,h} object');
  }

  // Operators cannot mint system templates (isSystem is seed-only).
  const data = {
    businessId,
    entityId: b.entityId || null,
    code,
    name,
    category,
    countryCode,
    subject,
    bodyMarkdown,
    mergeFieldsJson: b.mergeFieldsJson != null ? b.mergeFieldsJson : undefined,
    defaultLetterheadId: b.defaultLetterheadId || null,
    // CONTRACT letters route through e-sign by default; otherwise honour the flag.
    requiresSignature: b.requiresSignature === true || category === 'CONTRACT',
    refNoPrefix: typeof b.refNoPrefix === 'string' && b.refNoPrefix.trim() ? b.refNoPrefix.trim() : null,
    locale: typeof b.locale === 'string' && b.locale.trim() ? b.locale.trim() : null,
    // Phase 2 — signatory block + static signature placement (image uploaded separately).
    authorityName: strOrNull(b.authorityName),
    authorityDesignation: strOrNull(b.authorityDesignation),
    signatureBoxJson: sigBox,
    signatureOnLastPage: b.signatureOnLastPage !== undefined ? !!b.signatureOnLastPage : undefined,
    manualFieldsJson: manualFields,
    // Feature 39 — tenant category + reusable signature/stamp assets.
    categoryId: b.categoryId || null,
    signatureAssetId: b.signatureAssetId || null,
    stampAssetId: b.stampAssetId || null,
    isSystem: false,
    // New templates start as a DRAFT unless the caller explicitly publishes.
    isActive: b.isActive === true,
    version: 0,
  };

  let row;
  try {
    row = await prisma.letterTemplate.create({ data });
  } catch (e) {
    if (e && e.code === 'P2002') return fail(res, 409, `A template with code "${code}" already exists`);
    throw e;
  }

  await writeAudit({
    businessId, actorId: req.user.id, action: 'letter.template.create',
    entityType: 'LetterTemplate', entityId: row.id,
    meta: { code: row.code, category: row.category, countryCode: row.countryCode },
  });
  return res.status(201).json(publicTemplate(row));
}

// ── PUT /:id (update → bumps version) ─────────────────────────────────────────--
async function updateTemplate(req, res) {
  const businessId = req.user.businessId;
  const existing = await prisma.letterTemplate.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
  });
  if (!existing) return fail(res, 404, 'Template not found');

  const b = req.body || {};
  const data = {};

  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return fail(res, 422, 'name cannot be empty');
    data.name = name;
  }
  if (b.category !== undefined) {
    const cat = String(b.category).toUpperCase();
    if (!LETTER_CATEGORIES.has(cat)) return fail(res, 422, 'invalid category');
    data.category = cat;
  }
  if (b.countryCode !== undefined) {
    if (b.countryCode == null || b.countryCode === '') data.countryCode = null;
    else {
      const cc = String(b.countryCode).toUpperCase();
      if (!COUNTRY_CODES.has(cc)) return fail(res, 422, 'countryCode must be IN or NZ');
      data.countryCode = cc;
    }
  }
  if (b.subject !== undefined) data.subject = typeof b.subject === 'string' ? b.subject : null;
  if (b.bodyMarkdown !== undefined) {
    if (typeof b.bodyMarkdown !== 'string' || !b.bodyMarkdown.trim()) return fail(res, 422, 'bodyMarkdown cannot be empty');
    data.bodyMarkdown = b.bodyMarkdown;
  }
  if (b.mergeFieldsJson !== undefined) {
    const unknown = unknownMergeFields(b.mergeFieldsJson);
    if (unknown.length) return fail(res, 422, 'mergeFieldsJson references unknown merge fields', { unknownMergeFields: unknown });
    data.mergeFieldsJson = b.mergeFieldsJson;
  }

  // Phase 3 — sanitize declared manual fields up-front so body-token validation
  // (below) can authorize {{manual.<key>}} against the EFFECTIVE list.
  let manualFields;
  if (b.manualFieldsJson !== undefined) {
    manualFields = sanitizeManualFields(b.manualFieldsJson);
    if (manualFields === undefined) return fail(res, 422, 'manualFieldsJson must be an array of {key,label,type,required} with unique alphanumeric keys');
    data.manualFieldsJson = manualFields;
  }
  const effManualKeys = manualKeySet(b.manualFieldsJson !== undefined ? manualFields : existing.manualFieldsJson);

  // Validate the EFFECTIVE body + subject (new value if supplied, else the stored
  // one) against the catalog + declared manual fields — an edit that introduces an
  // unknown {{token}} (or removes a manual field a token relied on) is rejected
  // with the exact list before it's saved + silently stripped at render.
  if (b.bodyMarkdown !== undefined || b.subject !== undefined || b.manualFieldsJson !== undefined) {
    const effBody = b.bodyMarkdown !== undefined ? b.bodyMarkdown : existing.bodyMarkdown;
    const effSubject = b.subject !== undefined ? b.subject : existing.subject;
    const unknownInBody = unknownBodyTokens({ bodyMarkdown: effBody, subject: effSubject, manualKeys: effManualKeys });
    if (unknownInBody.length) {
      return fail(res, 422, 'The letter body references unknown merge fields', { unknownMergeFields: unknownInBody });
    }
  }
  if (b.defaultLetterheadId !== undefined) data.defaultLetterheadId = b.defaultLetterheadId || null;
  if (b.requiresSignature !== undefined) data.requiresSignature = !!b.requiresSignature;
  if (b.refNoPrefix !== undefined) data.refNoPrefix = typeof b.refNoPrefix === 'string' && b.refNoPrefix.trim() ? b.refNoPrefix.trim() : null;
  if (b.locale !== undefined) data.locale = typeof b.locale === 'string' && b.locale.trim() ? b.locale.trim() : null;
  if (b.entityId !== undefined) data.entityId = b.entityId || null;
  // Phase 2 — signatory block + static signature placement/flags.
  if (b.authorityName !== undefined) data.authorityName = strOrNull(b.authorityName);
  if (b.authorityDesignation !== undefined) data.authorityDesignation = strOrNull(b.authorityDesignation);
  if (b.signatureOnLastPage !== undefined) data.signatureOnLastPage = !!b.signatureOnLastPage;
  if (b.signatureBoxJson !== undefined) {
    const box = sanitizeSigBox(b.signatureBoxJson);
    if (box === undefined) return fail(res, 422, 'signatureBoxJson must be a normalized {x,y,w,h} object');
    data.signatureBoxJson = box;
  }
  // Feature 39 — tenant category + reusable signature/stamp assets + stamp placement.
  if (b.categoryId !== undefined) data.categoryId = b.categoryId || null;
  if (b.signatureAssetId !== undefined) data.signatureAssetId = b.signatureAssetId || null;
  if (b.stampAssetId !== undefined) data.stampAssetId = b.stampAssetId || null;
  if (b.stampBoxJson !== undefined) {
    const box = sanitizeSigBox(b.stampBoxJson);
    if (box === undefined) return fail(res, 422, 'stampBoxJson must be a normalized {x,y,w,h} object');
    data.stampBoxJson = box;
  }
  // `code` may be changed but stays tenant-unique; isSystem/isActive are not
  // editable here (publish/archive own isActive; isSystem is immutable seed flag).
  if (b.code !== undefined && typeof b.code === 'string' && b.code.trim()) data.code = b.code.trim();

  // Edit BUMPS version (value-pinned versioning — issued letters snapshot the
  // version, so historical letters stay immutable).
  data.version = { increment: 1 };

  let row;
  try {
    row = await prisma.letterTemplate.update({ where: { id: existing.id }, data });
  } catch (e) {
    if (e && e.code === 'P2002') return fail(res, 409, 'A template with that code already exists');
    throw e;
  }

  await writeAudit({
    businessId, actorId: req.user.id, action: 'letter.template.update',
    entityType: 'LetterTemplate', entityId: row.id,
    meta: { version: row.version, isSystem: row.isSystem },
  });
  return res.json(publicTemplate(row));
}

// ── POST /:id/publish ─────────────────────────────────────────────────────────
async function publishTemplate(req, res) {
  const businessId = req.user.businessId;
  const existing = await prisma.letterTemplate.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
  });
  if (!existing) return fail(res, 404, 'Template not found');

  const row = await prisma.letterTemplate.update({
    where: { id: existing.id },
    data: { isActive: true },
  });
  await writeAudit({
    businessId, actorId: req.user.id, action: 'letter.template.publish',
    entityType: 'LetterTemplate', entityId: row.id, meta: { version: row.version },
  });
  return res.json(publicTemplate(row));
}

// ── POST /:id/archive ─────────────────────────────────────────────────────────
async function archiveTemplate(req, res) {
  const businessId = req.user.businessId;
  const existing = await prisma.letterTemplate.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
  });
  if (!existing) return fail(res, 404, 'Template not found');

  const row = await prisma.letterTemplate.update({
    where: { id: existing.id },
    data: { isActive: false },
  });
  await writeAudit({
    businessId, actorId: req.user.id, action: 'letter.template.archive',
    entityType: 'LetterTemplate', entityId: row.id, meta: { version: row.version },
  });
  return res.json(publicTemplate(row));
}

// ── DELETE /:id (soft) — REFUSES on isSystem ──────────────────────────────────
async function deleteTemplate(req, res) {
  const businessId = req.user.businessId;
  const existing = await prisma.letterTemplate.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
  });
  if (!existing) return fail(res, 404, 'Template not found');

  // Seeded IN/NZ system templates are non-deletable (they back the library +
  // the issue wizard). Archive them instead if they are unwanted.
  if (existing.isSystem) {
    return fail(res, 409, 'System templates cannot be deleted (archive it instead)');
  }

  await prisma.letterTemplate.update({
    where: { id: existing.id },
    data: { deletedAt: new Date(), isActive: false },
  });
  await writeAudit({
    businessId, actorId: req.user.id, action: 'letter.template.delete',
    entityType: 'LetterTemplate', entityId: existing.id, meta: { code: existing.code },
  });
  return res.json({ ok: true, id: existing.id });
}

// ── POST /:id/signature — upload the static signature PNG (auto-stamped) ───────
async function uploadSignature(req, res) {
  const businessId = req.user.businessId;
  const existing = await prisma.letterTemplate.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
  });
  if (!existing) return fail(res, 404, 'Template not found');

  const dataUrl = (req.body && (req.body.fileBase64 || req.body.dataUrl)) || '';
  // Reuse the documents validator (≤10MB + MIME allow-list + server-side decode).
  const check = validateDocDataUrl(dataUrl);
  if (!check.ok) return res.status(check.status).json({ message: check.message });
  // The renderer embeds the signature via pdf-lib embedPng, so require PNG.
  if (check.mime !== 'image/png') return fail(res, 422, 'The signature must be a PNG image (image/png).');

  let signatureImageUrl;
  if (s3.isConfigured()) {
    const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'letter-signature' });
    signatureImageUrl = up.url;
  } else {
    signatureImageUrl = dataUrl; // inline fallback (dev / no-bucket), mirrors letterheads
  }

  const row = await prisma.letterTemplate.update({
    where: { id: existing.id },
    data: {
      signatureImageUrl,
      signatureImageHash: sha256(check.buffer),
      signatureMimeType: check.mime,
      signatureSizeBytes: check.bytes,
      version: { increment: 1 },
    },
  });
  await writeAudit({
    businessId, actorId: req.user.id, action: 'letter.template.signature.set',
    entityType: 'LetterTemplate', entityId: row.id, meta: { sizeBytes: check.bytes },
  });
  return res.json(publicTemplate(row));
}

// ── DELETE /:id/signature — remove the static signature ───────────────────────
async function deleteSignature(req, res) {
  const businessId = req.user.businessId;
  const existing = await prisma.letterTemplate.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
  });
  if (!existing) return fail(res, 404, 'Template not found');
  const row = await prisma.letterTemplate.update({
    where: { id: existing.id },
    data: {
      signatureImageUrl: null, signatureImageHash: null,
      signatureMimeType: null, signatureSizeBytes: null,
      version: { increment: 1 },
    },
  });
  await writeAudit({
    businessId, actorId: req.user.id, action: 'letter.template.signature.clear',
    entityType: 'LetterTemplate', entityId: row.id, meta: {},
  });
  return res.json(publicTemplate(row));
}

module.exports = {
  listMergeFields,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  publishTemplate,
  archiveTemplate,
  deleteTemplate,
  uploadSignature,
  deleteSignature,
  // exported for tests
  _internals: {
    unknownMergeFields, unknownBodyTokens, extractBodyTokens,
    publicTemplate, LETTER_CATEGORIES, COUNTRY_CODES, sanitizeSigBox,
    sanitizeManualFields, manualKeySet,
  },
};

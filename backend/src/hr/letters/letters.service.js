'use strict';

/**
 * letters.service.js — the Letters orchestration engine (Feature 9 §4.3, §3.6,
 * slice 9E). This is the shared interface every other slice (9F offboarding,
 * the ESS request-fulfilment path) calls; the public `issueLetter` /
 * `reissueLetter` / `revokeLetter` signatures below are the contract.
 *
 *   issueLetter(prismaOrTx, { businessId, entityId?, actorUserId, perms,
 *                            templateId, employeeId?, overrides?, mode,
 *                            documentRequestId? }) -> result
 *   reissueLetter(prismaOrTx, { businessId, actorUserId, perms, sourceId,
 *                              overrides?, reason? }) -> result
 *   revokeLetter(prismaOrTx, { businessId, actorUserId, perms, id, reason }) -> result
 *
 * Design (§4.3):
 *  1. Resolve + TENANT-SCOPE the template + employee; resolve the letterhead by
 *     precedence (template default → category binding → tenant default → none ⇒
 *     pdfkit fallback); load the comp snapshot (MASKED unless canViewCompensation)
 *     + TenantBrand + Entity.
 *  2. resolveMergeData → if missingRequired and mode !== 'draft' ⇒ 422 with the
 *     field list.
 *  3. Render: letterhead ⇒ renderLetter (pdf-lib overlay); none ⇒
 *     letterPdfFallback (pdfkit branded). mode 'preview' ⇒ watermark + NO ref-no +
 *     NO persistence — just return the bytes to stream.
 *  4. mode 'issue': in ONE transaction — allocateCode(LETTER, periodKey=taxYear)
 *     → sha256(pdf) → s3.uploadDataUrl (inline fallback) → insert IssuedLetter
 *     ISSUED + snapshot → write EmployeeDocument EMPLOYEE_VISIBLE + set
 *     employeeDocumentId → writeAudit. If template.requiresSignature ⇒ DRAFT +
 *     PENDING_SIGNATURE envelope (ref-no DEFERRED to COMPLETED).
 *  5. reissueLetter: new ref-no + supersedes/supersededBy chain (source retained).
 *     revokeLetter: require reason → VOIDED + voidedAt/By/Reason → flip the linked
 *     EmployeeDocument to HR_ONLY → audit; ref-no is BURNED, never reused.
 *
 * Errors are thrown as ServiceError carrying an HTTP `status` so the controller
 * can map them directly (422 missingRequired, 404 not-found/out-of-scope, 409
 * already-voided, 400 bad-input).
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const prismaDefault = require('../../core/lib/prisma');
const s3 = require('../../core/lib/s3');
const { writeAudit } = require('../../core/lib/audit');
const { allocateCode } = require('../lifecycle/lib/codes');
const esign = require('../lifecycle/esign'); // registers BUILTIN; exposes getProvider
// Feature 14: letter locale comes from the TENANT country's capability matrix
// (the single source of truth), not an inline `entity.countryCode==='NZ'?…:…`.
const { tenantCountry, countryCapabilities, assertCountry } = require('../tenant/countryContext');
const { resolveMergeData, renderMerge } = require('./mergeFields');
const { renderLetter } = require('./renderLetter');
const { renderLetterFallback } = require('./letterPdfFallback');
const { fulfilLetterRequest } = require('./controllers/meLetters.controller');

// Bounded retry budget for the ref-no resync loop (cross-entity / fell-behind
// sequence collision recovery — finding #4).
const MAX_REFNO_RETRIES = 6;

// ── bundled Unicode TTF (₹/non-Latin safe), loaded once ──────────────────────
const FONT_DIR = path.join(__dirname, 'fonts');
let _fontBytes = null;
let _fontBoldBytes = null;
function loadFonts() {
  if (_fontBytes === null) {
    try { _fontBytes = fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Regular.ttf')); }
    catch (_e) { _fontBytes = undefined; }
  }
  if (_fontBoldBytes === null) {
    try { _fontBoldBytes = fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Bold.ttf')); }
    catch (_e) { _fontBoldBytes = undefined; }
  }
  return { fontBytes: _fontBytes, fontBoldBytes: _fontBoldBytes };
}

class ServiceError extends Error {
  constructor(message, status, extra) {
    super(message);
    this.name = 'LettersServiceError';
    this.status = status || 400;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

// LetterCategory → EmployeeDocument.DocumentCategory (§3.1 mapping).
const CATEGORY_TO_DOC = {
  EXPERIENCE: 'EXPERIENCE',
  CONTRACT: 'CONTRACT',
  BANK: 'BANK_PROOF',
  BONAFIDE: 'OTHER',
  EMPLOYMENT_PROOF: 'OTHER',
  SALARY_PROOF: 'OTHER',
  CUSTOM: 'OTHER',
  // Feature 37 — an LMS completion certificate lands in the ESS vault as a typed
  // TRAINING_CERTIFICATE document (employee-visible proof of training, POSH audit).
  LMS_CERTIFICATE: 'TRAINING_CERTIFICATE',
};

const WATERMARK_PREVIEW = 'DRAFT — NOT VALID';
const WATERMARK_REVOKED = 'REVOKED';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Tax year string from a date + entity fiscal start month (Apr default). */
function taxYearFor(date, startMonth = 4) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startY = m >= startMonth ? y : y - 1;
  const endY = (startY + 1) % 100;
  return `${startY}-${String(endY).padStart(2, '0')}`;
}

// A short, ref-safe entity segment for the human referenceNo (finding #1). The
// per-entity sequence + per-TENANT @@unique([businessId, referenceNo]) mean two
// different entities under one tenant that share prefix + period + tail mint the
// SAME string → an unrecoverable P2002. Embedding the entity code disambiguates
// them so the per-tenant unique can never collide across entities, while the
// per-entity sequence resync (scoped on the same key set) converges. Strip to
// [A-Z0-9-], collapse separators, cap length. Empty/unsafe → null (omit segment),
// keeping single-entity / no-entity tenants clean (`${prefix}/${year}/${num}`).
//
// CRITICAL: the segment must be COLLISION-FREE across entities. A naive front
// truncation collides when two codes share a long common prefix (e.g.
// "ACME-LONGTENANT-HQ" vs "ACME-LONGTENANT-BR2" both truncate to the same 12
// chars). So when the cleaned code exceeds the cap we keep a readable head AND
// append a short hash of the FULL entity id/code — guaranteeing distinctness even
// for codes that differ only past the cap.
const ENTITY_SEG_CAP = 16;
function entityRefSegment(entity) {
  const codeRaw = entity && (entity.code || entity.id);
  if (!codeRaw) return null;
  const clean = String(codeRaw)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean) return null;
  if (clean.length <= ENTITY_SEG_CAP) return clean;
  // Truncated → append a deterministic 4-char hash of the full distinguishing key
  // (prefer the entity id, which is globally unique) so distinct entities never
  // share a segment.
  const hashKey = String((entity && entity.id) || codeRaw);
  const h = crypto.createHash('sha256').update(hashKey).digest('hex').slice(0, 4).toUpperCase();
  return `${clean.slice(0, ENTITY_SEG_CAP - 5)}-${h}`;
}

// `prisma.$transaction` clients expose the same model API as the base client; a
// passed-in `tx` has no `$transaction` of its own (Prisma interactive tx). We
// detect "am I already inside a tx?" by the absence of `$transaction`.
function isTx(client) {
  return !!client && typeof client.$transaction !== 'function';
}

// Run `fn` inside a transaction. If the caller already handed us a tx (9F passes
// its own), reuse it; otherwise open one.
async function inTx(client, fn) {
  if (isTx(client)) return fn(client);
  return client.$transaction((tx) => fn(tx), { timeout: 20000 });
}

// ── context loader: template + employee + letterhead + comp + brand + entity ──
// All reads are tenant-scoped (where businessId). A cross-tenant / missing id is
// a 404. The caller has already applied withEmployeeScope at the route, so the
// employeeId here is in-scope; we still re-assert businessId.
async function loadContext(db, { businessId, templateId, employeeId, perms }) {
  if (!businessId) throw new ServiceError('businessId is required', 400);
  if (!templateId) throw new ServiceError('templateId is required', 400);

  const template = await db.letterTemplate.findFirst({
    where: { id: templateId, businessId, deletedAt: null },
  });
  if (!template) throw new ServiceError('Template not found', 404);

  let employee = null;
  let employmentRecord = null;
  if (employeeId) {
    employee = await db.employee.findFirst({
      where: { id: employeeId, businessId, deletedAt: null },
    });
    if (!employee) throw new ServiceError('Employee not found', 404);
    // current employment record → designation/department/type/entity/location
    if (employee.currentEmploymentRecordId) {
      employmentRecord = await db.employmentRecord.findFirst({
        where: { id: employee.currentEmploymentRecordId, businessId },
        include: {
          designation: { select: { title: true } }, // Designation uses `title`, not `name`
          department: { select: { name: true } },
          location: { select: { name: true } },
          entity: true,
        },
      });
    }
  }

  // Entity: the employment record's entity, else the template's entity, else the
  // tenant default entity (for company-wide letters). Drives country + tax year +
  // statutory footer namespace.
  let entity = employmentRecord ? employmentRecord.entity : null;
  if (!entity) {
    // No current employment record → fall back to the template's entity, else the
    // tenant's first entity (company-wide letters). Employee has no entityId column
    // of its own; the EmploymentRecord is the authoritative entity link.
    const entId = template.entityId || null;
    if (entId) {
      entity = await db.entity.findFirst({ where: { id: entId, businessId, deletedAt: null } });
    }
    if (!entity) {
      entity = await db.entity.findFirst({ where: { businessId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    }
  }

  const business = await db.business.findFirst({ where: { id: businessId } });

  // TenantBrand: entity-bound brand → tenant-wide default.
  let brand = null;
  if (entity) {
    brand = await db.tenantBrand.findFirst({ where: { businessId, entityId: entity.id } });
  }
  if (!brand) {
    brand = await db.tenantBrand.findFirst({ where: { businessId, entityId: null } })
      || await db.tenantBrand.findFirst({ where: { businessId } });
  }

  // Compensation snapshot (current revision) — only loaded if the actor can view
  // it; otherwise the resolver masks comp.* anyway, so we skip the read entirely.
  let comp = null;
  if (employee && perms && perms.canViewCompensation && employee.currentCompensationId) {
    const rev = await db.compensationRevision.findFirst({
      where: { id: employee.currentCompensationId, businessId },
    });
    if (rev) {
      comp = {
        ctcAnnual: rev.ctcAnnual != null ? Number(rev.ctcAnnual) : null,
        grossMonthly: rev.grossMonthly != null ? Number(rev.grossMonthly) : null,
      };
    }
  }

  // Letterhead precedence: template.defaultLetterheadId → category binding →
  // tenant default → none (⇒ pdfkit fallback). All tenant-scoped + active.
  const letterhead = await resolveLetterhead(db, {
    businessId, template, entityId: entity ? entity.id : null,
  });

  return { template, employee, employmentRecord, entity, business, brand, comp, letterhead };
}

async function resolveLetterhead(db, { businessId, template, entityId }) {
  // 1) the template's explicit default.
  if (template.defaultLetterheadId) {
    const lh = await db.companyLetterhead.findFirst({
      where: { id: template.defaultLetterheadId, businessId, deletedAt: null, isActive: true },
    });
    if (lh) return lh;
  }
  // 2) a letterhead bound to this letter's category (prefer entity match).
  const byCategory = await db.companyLetterhead.findFirst({
    where: { businessId, deletedAt: null, isActive: true, letterCategory: template.category },
    orderBy: [{ entityId: entityId ? 'asc' : 'desc' }, { updatedAt: 'desc' }],
  });
  if (byCategory) return byCategory;
  // 3) the tenant default (isDefault, no category).
  const byDefault = await db.companyLetterhead.findFirst({
    where: { businessId, deletedAt: null, isActive: true, isDefault: true, letterCategory: null },
    orderBy: { updatedAt: 'desc' },
  });
  if (byDefault) return byDefault;
  // 4) none → caller renders the branded pdfkit fallback.
  return null;
}

// Fetch a letterhead's PDF bytes for the overlay. Two storage shapes (mirrors
// the e-sign/documents convention): an inline data URL (dev/no-bucket fallback),
// or an http(s) URL on OUR bucket (proxied, SSRF-guarded by isOurUrl).
async function fetchLetterheadBytes(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl) return null;
  if (fileUrl.startsWith('data:')) {
    const m = /^data:[^;,]+;base64,(.*)$/i.exec(fileUrl);
    if (m) return Buffer.from(m[1], 'base64');
    return null;
  }
  // Only proxy our own bucket's URLs (SSRF guard).
  if (!s3.isOurUrl(fileUrl)) return null;
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (_e) {
    return null;
  }
}

// Build the resolved field strings (date/refNo/subject/authority) + merged body
// from the template + merge values + overrides.
function buildRenderInputs({ template, ctx, overrides, refNo, locale, now }) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const authority = {
    // Phase 2 — the signatory block now has real backing columns on the template
    // (authorityName/authorityDesignation), fixing the previously-blank authority
    // line + {{authority.*}} / {{company.signatory*}} tokens. Per-issue overrides
    // still win; the tenant brand is the last-resort fallback.
    name: o.authorityName || template.authorityName || (ctx.brand && ctx.brand.signatoryName) || '',
    designation: o.authorityDesignation || template.authorityDesignation || (ctx.brand && ctx.brand.signatoryDesignation) || '',
    subject: o.subject != null ? o.subject : (template.subject || ''),
    purpose: o.purpose || '',
    addressee: o.addressee || '',
  };

  const perms = ctx.perms || {};
  const required = Array.isArray(o.required)
    ? o.required
    : deriveRequired(template);

  const { values, missingRequired, masked } = resolveMergeData({
    employee: ctx.mergeEmployee,
    business: ctx.business,
    comp: ctx.comp,
    entity: ctx.entity,
    locale,
    now,
    refNo,
    authority,
    perms,
    required,
    // Feature 37 — LMS certificate facts (overrides.course), additive; only the
    // LMS_CERTIFICATE template's course.* tokens consume them, ignored elsewhere.
    course: o.course || null,
    // Phase 3 — manual (at-issue) values the issuer filled + the template's
    // declared field list (types drive formatting; required drives missingRequired).
    manual: o.manual || null,
    manualFields: template.manualFieldsJson || null,
  });

  // Body: an explicit override body wins (custom paragraph append handled by the
  // wizard composing the override); else the template body. Tokens resolved
  // against the allow-list only (unknown stripped, never echoed).
  let bodySource = o.bodyMarkdown != null ? String(o.bodyMarkdown) : String(template.bodyMarkdown || '');
  if (o.customParagraph) {
    bodySource = `${bodySource}\n\n${String(o.customParagraph)}`;
  }
  const { text: bodyText, unknownTokens } = renderMerge(bodySource, values);

  const subjectSource = o.subject != null ? String(o.subject) : String(template.subject || '');
  const subject = renderMerge(subjectSource, values).text;

  const fields = {
    date: values['date.issueDate'] || values['date.today'] || '',
    refNo: refNo || '',
    subject,
    authority: authority.name || values['authority.name'] || '',
    authorityDesignation: authority.designation || values['authority.designation'] || '',
    addressee: authority.addressee || values['letter.addressee'] || '',
  };

  return { values, missingRequired, masked, unknownTokens, bodyText, subject, fields, authority };
}

// Derive the required merge keys from the template's mergeFieldsJson allow-list
// ({ "employee.name": { required:true } }). Absent declaration ⇒ none required.
function deriveRequired(template) {
  const m = template && template.mergeFieldsJson;
  if (!m || typeof m !== 'object') return [];
  const out = [];
  for (const [k, spec] of Object.entries(m)) {
    if (spec && typeof spec === 'object' && spec.required) out.push(k);
  }
  return out;
}

// Flatten the employee + employment record into the shape mergeFields expects.
function mergeEmployeeFrom(employee, employmentRecord, entity) {
  if (!employee) return null;
  const er = employmentRecord || {};
  const name = [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(' ').trim();
  return {
    name,
    firstName: employee.firstName,
    lastName: employee.lastName,
    code: employee.code,
    designation: er.designation ? er.designation.title : null,
    department: er.department ? er.department.name : null,
    workLocation: er.location ? er.location.name : null,
    employmentType: er.employmentType || null,
    dateOfJoining: employee.hireDate || null,
    lastWorkingDay: employee.terminationDate || null,
    email: employee.workEmail || employee.personalEmail || null,
    phone: employee.phone || null,
    // statutory ids live on the employee where present (forward-compat; absent
    // fields resolve to '' and only matter if the template references them).
    pan: employee.pan, uan: employee.uan, pfNumber: employee.pfNumber, esiNumber: employee.esiNumber,
    irdNumber: employee.irdNumber, taxCode: employee.taxCode, kiwiSaverRate: employee.kiwiSaverRate,
    bankName: employee.bankName, bankAccount: employee.bankAccount, bankAccountMasked: employee.bankAccountMasked,
    ifsc: employee.ifsc, bankBranch: employee.bankBranch,
    effectiveDate: null,
  };
}

// Render a letter PDF from ctx + resolved inputs. letterhead ⇒ pdf-lib overlay;
// none ⇒ pdfkit branded fallback. Returns a Buffer.
// Default placement for a per-template signature when neither the template nor the
// letterhead layout pins one (mirrors the picker's signature-zone default).
const DEFAULT_SIG_BOX = { x: 0.1, y: 0.76, w: 0.25, h: 0.06 };
// Feature 39 — default stamp placement (to the right of the signature).
const DEFAULT_STAMP_BOX = { x: 0.42, y: 0.74, w: 0.18, h: 0.09 };

async function renderPdf({ ctx, render, watermark }) {
  const { fontBytes, fontBoldBytes } = loadFonts();
  const template = ctx.template || {};
  // Phase 2 + Feature 39 — the STATIC signature/stamp images. A reusable LIBRARY
  // asset (uploaded once per tenant) wins; the legacy per-template signature image
  // stays supported so existing templates keep working.
  let sigUrl = template.signatureImageUrl || null;
  let stampUrl = null;
  if (template.signatureAssetId || template.stampAssetId) {
    const ids = [template.signatureAssetId, template.stampAssetId].filter(Boolean);
    try {
      const assets = await prismaDefault.letterAsset.findMany({ where: { id: { in: ids } } });
      const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
      if (template.signatureAssetId && byId[template.signatureAssetId]) sigUrl = byId[template.signatureAssetId].imageUrl;
      if (template.stampAssetId && byId[template.stampAssetId]) stampUrl = byId[template.stampAssetId].imageUrl;
    } catch (_e) { /* a missing asset must never block issuing a letter */ }
  }
  const signaturePng = sigUrl ? await fetchLetterheadBytes(sigUrl) : null;
  const stampPng = stampUrl ? await fetchLetterheadBytes(stampUrl) : null;

  if (ctx.letterhead) {
    const lhBytes = await fetchLetterheadBytes(ctx.letterhead.fileUrl);
    if (lhBytes) {
      const base = ctx.letterhead.layoutJson && typeof ctx.letterhead.layoutJson === 'object'
        ? ctx.letterhead.layoutJson : {};
      // Resolve the signature box: the template's own placement wins; else the
      // letterhead's picker zone; else a sensible default (so an uploaded signature
      // always lands somewhere sane).
      const layout = { ...base };
      if (signaturePng || stampPng) {
        layout.fields = { ...(base.fields || {}) };
        if (signaturePng) layout.fields.signature = template.signatureBoxJson || layout.fields.signature || DEFAULT_SIG_BOX;
        if (stampPng) layout.fields.stamp = template.stampBoxJson || layout.fields.stamp || DEFAULT_STAMP_BOX;
      }
      return renderLetter({
        letterheadPdf: lhBytes,
        layout,
        bodyText: render.bodyText,
        fields: render.fields,
        signaturePng: signaturePng || undefined,
        stampPng: stampPng || undefined,
        fontBytes,
        fontBoldBytes,
        opts: {
          overflowPolicy: layout.overflowPolicy || 'repeat-letterhead',
          // per-template flag wins; fall back to the letterhead layout's flag.
          signatureOnLastPage: template.signatureImageUrl != null
            ? template.signatureOnLastPage !== false
            : !!layout.signatureOnLastPage,
          watermark: watermark || undefined,
        },
      });
    }
    // letterhead row exists but its bytes are unreachable → fall back rather than
    // fail the whole letter.
  }
  return renderLetterFallback({
    business: ctx.business,
    brand: ctx.brand,
    bodyText: render.bodyText,
    fields: render.fields,
    signaturePng: signaturePng || undefined,
    signatureBox: signaturePng ? (template.signatureBoxJson || DEFAULT_SIG_BOX) : undefined,
    fontBytes,
    fontBoldBytes,
    opts: { watermark: watermark || undefined },
  });
}

// ── issueLetter ──────────────────────────────────────────────────────────────
/**
 * issueLetter(prismaOrTx, args) — the single entry point other slices import.
 *
 * @param {Object} client  prisma OR an interactive tx (9F passes its own tx).
 * @param {Object} args
 * @param {string} args.businessId
 * @param {string} [args.entityId]        forced entity (else derived from the employee)
 * @param {string} args.actorUserId       userId of the HR issuer
 * @param {Object} args.perms             effective permissions (canViewCompensation gates comp.*)
 * @param {string} args.templateId
 * @param {string} [args.employeeId]      subject employee (caller already F1-scoped it)
 * @param {Object} [args.overrides]       { subject, customParagraph, bodyMarkdown, authorityName,
 *                                          authorityDesignation, addressee, purpose, issueDate,
 *                                          letterheadId, required[] }
 * @param {string} args.mode              'preview' | 'draft' | 'issue'
 * @param {string} [args.documentRequestId]  ESS request being fulfilled
 * @param {Object} [args.signers]         e-sign signer list override (CONTRACT)
 *
 * @returns
 *   mode 'preview' ⇒ { mode:'preview', pdf:Buffer, watermarked:true, referenceNo:null,
 *                      masked:string[], unknownTokens:string[] }
 *   mode 'issue'   ⇒ { mode:'issue', issuedLetterId, referenceNo, fileUrl, fileHash,
 *                      status, employeeDocumentId, signatureEnvelopeId?, masked }
 */
async function issueLetter(client, args = {}) {
  const {
    businessId, entityId: forcedEntityId, actorUserId, perms = {}, templateId,
    employeeId = null, overrides = {}, mode = 'issue', documentRequestId = null,
    signers,
  } = args;

  const db = client || prismaDefault;

  // ── 1) resolve context (read; outside the write tx so preview never opens one) ──
  const ctx = await loadContext(db, { businessId, templateId, employeeId, perms });
  ctx.perms = perms;
  ctx.mergeEmployee = mergeEmployeeFrom(ctx.employee, ctx.employmentRecord, ctx.entity);

  // Allow an explicit letterhead override (the wizard may pin one).
  if (overrides.letterheadId) {
    const lh = await db.companyLetterhead.findFirst({
      where: { id: overrides.letterheadId, businessId, deletedAt: null },
    });
    if (lh) ctx.letterhead = lh;
  }

  // Feature 14 — the letter locale follows the TENANT country's capabilities (the
  // single source of truth), so an IN tenant never renders an en-NZ letter. When
  // the tenant country IS set the entity's countryCode is asserted to match it
  // (tripwire). The locale is presentation-only, so a PRE-SETUP tenant (hrCountry
  // not yet set — legitimately mid-onboarding) falls back to the entity country /
  // en-IN rather than blocking issuance (fail-SOFT — letters are not a country
  // security boundary).
  //
  // An AMBIGUOUS (hrCountryAmbiguous=true) tenant is DIFFERENT: it is quarantined
  // pending super-admin review, and loadHrCountry blocks every other HR surface
  // for it. Falling back to a per-row entity countryCode would let a quarantined
  // tenant issue a letter in the OTHER country's locale — the exact fail-open
  // F14 set out to delete. So we fail-CLOSED for ambiguous (rethrow → 409),
  // keeping the soft fallback only for the pre-setup case.
  let tCountry = null;
  try {
    tCountry = await tenantCountry(businessId);
    if (ctx.entity && ctx.entity.countryCode) await assertCountry(businessId, ctx.entity.countryCode);
  } catch (e) {
    if (e && e.code === 'HR_NOT_SET_UP') {
      tCountry = (ctx.entity && ctx.entity.countryCode) || 'IN';
    } else {
      // HR_COUNTRY_AMBIGUOUS (quarantined) and a real COUNTRY_MISMATCH both fail closed.
      throw e;
    }
  }
  const caps = countryCapabilities(tCountry);
  const locale = ctx.template.locale || (caps && caps.letterLocale) || 'en-IN';
  const now = overrides.issueDate ? new Date(overrides.issueDate) : new Date();

  // ── 2) merge + missingRequired (preview/draft render WITHOUT a ref-no) ────────
  const renderNoRef = buildRenderInputs({ template: ctx.template, ctx, overrides, refNo: '', locale, now });

  if (mode !== 'draft' && renderNoRef.missingRequired.length) {
    throw new ServiceError('Missing required merge fields', 422, {
      missingRequired: renderNoRef.missingRequired,
      code: 'MISSING_REQUIRED',
    });
  }

  // ── 3) PREVIEW: watermark, no ref-no, NO persistence ─────────────────────────
  if (mode === 'preview') {
    const pdf = await renderPdf({ ctx, render: renderNoRef, watermark: WATERMARK_PREVIEW });
    return {
      mode: 'preview',
      pdf,
      watermarked: true,
      referenceNo: null,
      masked: renderNoRef.masked,
      unknownTokens: renderNoRef.unknownTokens,
    };
  }

  // ── 4) ISSUE: one transaction — ref-no → render → store → rows → audit ────────
  const prefix = (ctx.template.refNoPrefix || 'LTR').replace(/\/+$/, '');
  const periodKey = taxYearFor(now, ctx.entity ? (ctx.entity.taxYearStartMonth || 4) : 4);
  const issueEntityId = forcedEntityId || (ctx.entity ? ctx.entity.id : null);
  // Entity segment for the human ref string (finding #1). Only when the letter is
  // actually entity-scoped — i.e. the entity we'll key the sequence on is the one
  // we resolved. A forcedEntityId without a matching ctx.entity falls back to the
  // entity id so disambiguation still holds.
  const refEntitySeg = issueEntityId
    ? (ctx.entity && ctx.entity.id === issueEntityId
      ? entityRefSegment(ctx.entity)
      : entityRefSegment({ id: issueEntityId }))
    : null;
  const requiresSignature = !!ctx.template.requiresSignature;
  const docCategory = CATEGORY_TO_DOC[ctx.template.category] || 'OTHER';

  const runIssueTx = () => inTx(db, async (tx) => {
    // Allocate the sequence value INSIDE the tx (atomic, row-locked). For
    // requiresSignature we DEFER the human ref-no to COMPLETED, but still need a
    // DRAFT row — we do NOT consume a sequence number until COMPLETED there.
    let referenceNo = null;
    let seqValue = null;
    if (!requiresSignature) {
      const code = await allocateCode(tx, {
        businessId, entityId: issueEntityId, scope: 'LETTER', prefix, padding: 4, periodKey,
      });
      // code is "<prefix>NNNN"; extract the padded numeric tail the allocator
      // produced and re-format the human ref string. We use the FULL TAX-YEAR
      // token (periodKey, e.g. "2026-27") — NOT the calendar year — so the visible
      // segment and the sequence's reset boundary agree (finding #2: no cross-tax-
      // year collisions, no mid-stream year flip). When the letter is entity-
      // scoped we embed the entity segment (finding #1) so two entities sharing
      // prefix + period + tail can't collide on @@unique([businessId, referenceNo]).
      const tail = String(code).replace(/^.*?(\d+)$/, '$1');
      seqValue = parseInt(tail, 10);
      referenceNo = refEntitySeg
        ? `${prefix}/${refEntitySeg}/${periodKey}/${tail}`
        : `${prefix}/${periodKey}/${tail}`;
    }

    // Render with the (possibly null) ref-no baked into the body/fields.
    const render = buildRenderInputs({
      template: ctx.template, ctx, overrides, refNo: referenceNo || '', locale, now,
    });
    const status = requiresSignature ? 'PENDING_SIGNATURE' : 'ISSUED';
    const watermark = requiresSignature ? WATERMARK_PREVIEW : undefined; // unsigned draft is watermarked
    const pdf = await renderPdf({ ctx, render, watermark });
    const fileHash = sha256(pdf);
    const fileUrl = await storePdf({ pdf, businessId });

    // EmployeeDocument (file-of-record) — only when there's a subject employee.
    let employeeDocumentId = null;
    if (ctx.employee) {
      const doc = await tx.employeeDocument.create({
        data: {
          businessId,
          employeeId: ctx.employee.id,
          category: docCategory,
          name: render.subject || `${ctx.template.name}`,
          fileUrl,
          fileHash,
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
          visibility: 'EMPLOYEE_VISIBLE',
          signatureStatus: requiresSignature ? 'PENDING' : 'NOT_REQUIRED',
        },
        select: { id: true },
      });
      employeeDocumentId = doc.id;
    }

    const letter = await tx.issuedLetter.create({
      data: {
        businessId,
        entityId: issueEntityId,
        referenceNo: referenceNo || draftRef(),
        category: ctx.template.category,
        employeeId: ctx.employee ? ctx.employee.id : null,
        templateId: ctx.template.id,
        letterheadId: ctx.letterhead ? ctx.letterhead.id : null,
        subject: render.subject || null,
        renderedBody: render.bodyText,
        mergeDataJson: render.values,
        templateVersionAtIssue: ctx.template.version,
        letterheadHash: ctx.letterhead ? ctx.letterhead.fileHash || null : null,
        fileUrl,
        fileHash,
        mimeType: 'application/pdf',
        sizeBytes: pdf.length,
        status,
        employeeDocumentId,
        documentRequestId: documentRequestId || null,
        issuedBy: actorUserId || 'system',
        issuedAt: requiresSignature ? null : now,
        seqScope: 'LETTER',
        seqPeriodKey: periodKey,
        seqValue,
      },
    });

    // requiresSignature ⇒ open a built-in e-sign envelope; ref-no/ISSUED deferred
    // to COMPLETED (the e-sign sign-flow re-stamps + flips, owned by F4).
    let signatureEnvelopeId = null;
    if (requiresSignature && employeeDocumentId) {
      const provider = esign.getProvider('BUILTIN');
      const envSigners = Array.isArray(signers) && signers.length
        ? signers
        : defaultContractSigners(ctx);
      // SoD (finding #13/§9): a CONTRACT must NOT collapse into a self-approve
      // loop. Reject when an EMPLOYER/APPROVER signer is the subject employee
      // (same email / employeeId / userId), and require at least one DISTINCT
      // non-subject employer/approver. Applies to BOTH caller-supplied signers
      // and the defaults.
      assertSignerDistinctness(envSigners, ctx);
      const out = await provider.createEnvelope({
        businessId,
        subject: render.subject || `${ctx.template.name} — ${ctx.mergeEmployee ? ctx.mergeEmployee.name : ''}`.trim(),
        employeeDocumentId,
        signers: envSigners,
        sequential: true,
      }, tx);
      signatureEnvelopeId = out.envelope.id;
      await tx.issuedLetter.update({
        where: { id: letter.id },
        data: { signatureEnvelopeId },
      });
      await tx.signatureEnvelope.update({
        where: { id: signatureEnvelopeId },
        data: { issuedLetterId: letter.id },
      });
    }

    // Fulfil the ESS DocumentRequest through the purpose-built hook (finding #6,
    // §3.6). It advances the request status AND enforces the (businessId,
    // employeeId) match inside this SAME tx — so a maker can't attach employee A's
    // letter to employee B's request, and the request no longer stays PENDING
    // forever. A missing/foreign request is a no-op (returns fulfilled:false).
    if (documentRequestId && employeeDocumentId && ctx.employee) {
      await fulfilLetterRequest(tx, {
        businessId,
        documentRequestId,
        issuedLetterId: letter.id,
        employeeDocumentId,
        employeeId: ctx.employee.id,
      });
    }

    return {
      mode: 'issue',
      issuedLetterId: letter.id,
      referenceNo,
      fileUrl,
      fileHash,
      status,
      employeeDocumentId,
      signatureEnvelopeId,
      masked: render.masked,
    };
  });

  // Mint with a BOUNDED retry: if the ref-no collides on @@unique(businessId,
  // referenceNo) — a sequence that fell behind reality (out-of-band insert/restore,
  // or a concurrent issuance that won the row-lock) — re-sync the LETTER sequence
  // past the highest existing letter for THIS (entity, period) key (now the same
  // key set the entity-disambiguated ref string + uniqueness use, so the resync
  // can converge), then retry. (Spec §6: "caller retries on P2002.") Only attempted
  // when `db` is a real client; never for deferred-ref drafts.
  let result;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { result = await runIssueTx(); break; }
    catch (e) {
      const target = String((e && e.meta && e.meta.target) || '').toLowerCase();
      const isP2002 = e && e.code === 'P2002';
      // Two retryable collisions (finding #3):
      //  (a) referenceNo dup → the sequence fell behind reality; resync past it.
      //  (b) the NumberSequence (businessId,entityId,scope,periodKey) dup → a
      //      first-creation thundering herd inside allocateCode (codes.js, out of
      //      scope to change): N concurrent issuers all find no row then all try to
      //      CREATE it; the losers get this P2002. The row now EXISTS, so a plain
      //      retry (NO resync) will find it and proceed. Without this branch the
      //      loser bubbles a raw 500 (the exact gap finding #3 flagged).
      const refDup = isP2002 && target.includes('referenceno');
      const seqDup = isP2002 && target.includes('businessid') && target.includes('scope')
        && target.includes('periodkey') && !target.includes('referenceno');
      // Fail fast (no spin) when: not a retryable collision, deferred-ref draft, no
      // real client to open a resync tx, or the retry budget is spent (finding #4).
      if ((!refDup && !seqDup) || requiresSignature || typeof db.$transaction !== 'function'
        || attempt >= MAX_REFNO_RETRIES) {
        throw e;
      }
      attempt += 1;
      if (refDup) {
        // Atomically advance the sequence past the observed collision (finding #3).
        let advanced;
        try {
          advanced = await resyncLetterSequence(db, {
            businessId, entityId: issueEntityId, prefix, periodKey,
          });
        } catch (resyncErr) {
          // A create-side P2002 (another thread created the sequence row in the
          // gap) is benign — retry the mint, which will now find that row.
          if (resyncErr && resyncErr.code === 'P2002') { /* fall through to retry */ }
          else throw resyncErr;
        }
        // Only retry if the resync actually moved nextValue PAST the colliding
        // tail; otherwise we'd burn the budget re-minting the identical ref → fail
        // fast with the original error instead of spinning (finding #4).
        if (advanced === null) throw e;
      }
      // Jittered backoff so a batch of concurrent losers don't re-collide in
      // lockstep — they spread out and each reads a freshly-committed nextValue,
      // letting the bounded retry actually converge under contention. (allocateCode
      // itself is read-then-increment in codes.js — out of scope to change here —
      // so the @@unique backstop + this resync/backoff is the convergence path.)
      await sleep(5 + Math.floor(Math.random() * 15 * attempt));
    }
  }

  // Audit OUTSIDE the tx (best-effort, never throws; append-only).
  await writeAudit({
    businessId,
    actorId: actorUserId,
    action: requiresSignature ? 'letter.issue.pending_signature' : 'letter.issue',
    entityType: 'IssuedLetter',
    entityId: result.issuedLetterId,
    meta: {
      referenceNo: result.referenceNo,
      category: ctx.template.category,
      templateId: ctx.template.id,
      employeeId: ctx.employee ? ctx.employee.id : null,
      status: result.status,
      fileHash: result.fileHash,
    },
  });

  return result;
}

// Atomically resync the LETTER NumberSequence past the highest existing letter
// for this (entity, period) key after a ref-no collision (findings #3/#4). Runs
// in ONE transaction with a SELECT … FOR UPDATE row-lock so concurrent issuers
// can't both read-modify-write the same nextValue and re-collide. Computes the
// target as max(seqValue)+1 over the SAME key set the uniqueness uses, then bumps
// nextValue to GREATEST(nextValue, target). Returns the advanced nextValue, or
// null if it could not move past the collision (caller then fails fast, no spin).
// A create-side P2002 (sequence row created in the gap by another thread) is
// re-thrown for the caller to treat as a retry.
async function resyncLetterSequence(db, { businessId, entityId, prefix, periodKey }) {
  return db.$transaction(async (tx) => {
    const agg = await tx.issuedLetter.aggregate({
      where: { businessId, entityId: entityId || null, seqScope: 'LETTER', seqPeriodKey: periodKey },
      _max: { seqValue: true },
    });
    const target = ((agg._max && agg._max.seqValue) || 0) + 1;

    // Row-lock the sequence row (NULL-safe on entityId/periodKey) so the bump is
    // serialized against concurrent resyncs.
    const locked = await tx.$queryRaw`
      SELECT "id", "nextValue" FROM "NumberSequence"
      WHERE "businessId" = ${businessId}
        AND "entityId" IS NOT DISTINCT FROM ${entityId || null}
        AND "scope" = 'LETTER'
        AND "periodKey" IS NOT DISTINCT FROM ${periodKey || null}
      FOR UPDATE`;

    if (Array.isArray(locked) && locked.length) {
      const row = locked[0];
      const current = Number(row.nextValue) || 0;
      const next = Math.max(current, target);
      if (next <= current) return null; // already at/past target — can't advance
      await tx.numberSequence.update({ where: { id: row.id }, data: { nextValue: next } });
      return next;
    }

    // No sequence row yet → create it at the target. A concurrent create races on
    // @@unique([businessId, entityId, scope, periodKey]) → P2002, which we let
    // propagate so the caller retries the mint (it'll then find the row).
    await tx.numberSequence.create({
      data: { businessId, entityId: entityId || null, scope: 'LETTER', prefix, padding: 4, nextValue: target, periodKey },
    });
    return target;
  }, { timeout: 20000 });
}

// A placeholder reference for a DRAFT/PENDING_SIGNATURE row that has not yet
// minted its human ref-no (still unique per tenant via the uuid suffix). Burned
// once the real ref-no is minted at COMPLETED.
function draftRef() {
  return `DRAFT-${crypto.randomBytes(8).toString('hex')}`;
}

function defaultContractSigners(ctx) {
  const emp = ctx.mergeEmployee || {};
  const empEmail = (ctx.employee && (ctx.employee.workEmail || ctx.employee.personalEmail)) || '';
  const signatoryName = (ctx.brand && ctx.brand.signatoryName) || 'Authorised Signatory';
  const signatoryEmail = (ctx.business && ctx.business.email) || empEmail || 'hr@example.com';
  return [
    { signerOrder: 1, role: 'EMPLOYER', name: signatoryName, email: signatoryEmail },
    {
      signerOrder: 2, role: 'EMPLOYEE', name: emp.name || 'Employee', email: empEmail || signatoryEmail,
      employeeId: ctx.employee ? ctx.employee.id : null,
    },
  ];
}

// Identity keys a signer can match the subject employee on (case-folded email,
// employeeId, userId). Used by the SoD distinctness check below.
function subjectIdentity(ctx) {
  const emp = ctx.employee || {};
  const email = (emp.workEmail || emp.personalEmail || '').toLowerCase().trim();
  return { email: email || null, employeeId: emp.id || null };
}
function signerMatchesSubject(signer, subj) {
  if (!signer) return false;
  const sEmail = (signer.email || '').toLowerCase().trim();
  if (subj.email && sEmail && sEmail === subj.email) return true;
  if (subj.employeeId && signer.employeeId && signer.employeeId === subj.employeeId) return true;
  // a signer carrying the subject's id via userId is also the subject
  if (subj.employeeId && signer.userId && signer.userId === subj.employeeId) return true;
  return false;
}

// SoD guard for CONTRACT e-sign (finding #13, §9): the employer/approver party
// must be a DISTINCT person from the subject employee — otherwise the two-party
// agreement collapses into a self-approve loop. Throws a 422 ServiceError on
// violation. Roles other than EMPLOYER/APPROVER (i.e. the EMPLOYEE/subject
// signer) are expected to be the subject and are not flagged.
function assertSignerDistinctness(signers, ctx) {
  if (!Array.isArray(signers) || !signers.length) {
    throw new ServiceError('CONTRACT requires at least one authorising signer', 422, {
      code: 'SIGNER_REQUIRED',
    });
  }
  const subj = subjectIdentity(ctx);
  const approvers = signers.filter((s) => {
    const role = String((s && s.role) || '').toUpperCase();
    return role === 'EMPLOYER' || role === 'APPROVER';
  });
  if (!approvers.length) {
    throw new ServiceError('CONTRACT requires an EMPLOYER/APPROVER signer', 422, {
      code: 'APPROVER_REQUIRED',
    });
  }
  // No employer/approver may BE the subject (self-approve loop).
  if (approvers.some((s) => signerMatchesSubject(s, subj))) {
    throw new ServiceError(
      'CONTRACT signer conflict: the authorising signer cannot be the subject employee',
      422,
      { code: 'SIGNER_SELF_APPROVE' },
    );
  }
  // At least one employer/approver must be a real distinct party (non-subject).
  const distinct = approvers.some((s) => !signerMatchesSubject(s, subj));
  if (!distinct) {
    throw new ServiceError(
      'CONTRACT requires at least one distinct non-subject authorising signer',
      422,
      { code: 'SIGNER_NOT_DISTINCT' },
    );
  }
}

// Store the rendered PDF. S3 when configured; else an inline data URL (dev/test)
// so the URL + hash are real either way (mirrors esign/builtin storeArtifact).
async function storePdf({ pdf, businessId }) {
  const dataUrl = `data:application/pdf;base64,${pdf.toString('base64')}`;
  if (s3.isConfigured()) {
    try {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'letter' });
      return up.url;
    } catch (_e) {
      // fall through to inline
    }
  }
  return dataUrl;
}

// ── reissueLetter ────────────────────────────────────────────────────────────
/**
 * reissueLetter(client, { businessId, actorUserId, perms, sourceId, overrides?, reason? })
 * Re-issues an existing letter: mints a NEW ref-no, renders fresh from the source
 * template/employee/letterhead, links supersedes/supersededBy (source kept ISSUED
 * for history). Requires canGenerateLetters (the maker key, enforced at the route).
 */
async function reissueLetter(client, args = {}) {
  const { businessId, actorUserId, perms = {}, sourceId, overrides = {} } = args;
  const db = client || prismaDefault;
  if (!sourceId) throw new ServiceError('sourceId is required', 400);

  const source = await db.issuedLetter.findFirst({ where: { id: sourceId, businessId } });
  if (!source) throw new ServiceError('Letter not found', 404);
  if (!source.templateId) throw new ServiceError('Source letter has no template to re-issue from', 422);
  if (source.status === 'VOIDED') {
    throw new ServiceError('Cannot re-issue a voided letter', 409);
  }

  // ATOMIC (finding #5): the fresh issue AND both supersede links commit or roll
  // back together. We open ONE interactive tx and pass it into issueLetter — a
  // partial failure (e.g. the link write throws) no longer orphans a fully-ISSUED
  // new letter with no chain. Source status is re-checked inside the tx (guards a
  // concurrent void between the read above and the link). NOTE: passing a tx into
  // issueLetter disables its ref-no resync/retry; a P2002 here rolls the whole
  // reissue back, and the caller may retry — correct for an atomic operation.
  const issued = await inTx(db, async (tx) => {
    const fresh = await issueLetter(tx, {
      businessId,
      entityId: source.entityId || undefined,
      actorUserId,
      perms,
      templateId: source.templateId,
      employeeId: source.employeeId || undefined,
      overrides: {
        subject: source.subject || undefined,
        letterheadId: source.letterheadId || undefined,
        ...overrides,
      },
      mode: 'issue',
    });

    // Re-read the source INSIDE the tx and refuse if it was voided concurrently.
    const live = await tx.issuedLetter.findFirst({
      where: { id: source.id, businessId },
      select: { status: true },
    });
    if (!live) throw new ServiceError('Letter not found', 404);
    if (live.status === 'VOIDED') {
      throw new ServiceError('Cannot re-issue a voided letter', 409);
    }

    // Link the supersede chain (source retained as ISSUED) — same tx as the issue.
    await tx.issuedLetter.update({
      where: { id: fresh.issuedLetterId },
      data: { supersedesLetterId: source.id },
    });
    await tx.issuedLetter.update({
      where: { id: source.id },
      data: { supersededByLetterId: fresh.issuedLetterId },
    });
    return fresh;
  });

  await writeAudit({
    businessId,
    actorId: actorUserId,
    action: 'letter.reissue',
    entityType: 'IssuedLetter',
    entityId: issued.issuedLetterId,
    meta: { supersedesLetterId: source.id, referenceNo: issued.referenceNo },
  });

  return { ...issued, supersedesLetterId: source.id };
}

// ── revokeLetter ─────────────────────────────────────────────────────────────
/**
 * revokeLetter(client, { businessId, actorUserId, perms, id, reason })
 * VOIDs an issued letter: requires a reason, sets voidedAt/By/Reason, flips the
 * linked EmployeeDocument to HR_ONLY (so ESS no longer surfaces it), audits. The
 * ref-no is BURNED (never reused). Requires canManageLetters (route-enforced).
 */
async function revokeLetter(client, args = {}) {
  const { businessId, actorUserId, id, reason } = args;
  const db = client || prismaDefault;
  if (!id) throw new ServiceError('id is required', 400);
  if (!reason || !String(reason).trim()) {
    throw new ServiceError('A revoke reason is required', 422, { code: 'REASON_REQUIRED' });
  }

  const letter = await db.issuedLetter.findFirst({ where: { id, businessId } });
  if (!letter) throw new ServiceError('Letter not found', 404);
  if (letter.status === 'VOIDED') {
    throw new ServiceError('Letter is already voided', 409);
  }

  const updated = await inTx(db, async (tx) => {
    const row = await tx.issuedLetter.update({
      where: { id: letter.id },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidedBy: actorUserId || null,
        voidReason: String(reason),
      },
    });
    // Flip the linked vault doc to HR_ONLY (ESS notice; struck-through per config).
    if (letter.employeeDocumentId) {
      await tx.employeeDocument.updateMany({
        where: { id: letter.employeeDocumentId, businessId },
        data: { visibility: 'HR_ONLY' },
      });
    }
    return row;
  });

  await writeAudit({
    businessId,
    actorId: actorUserId,
    action: 'letter.revoke',
    entityType: 'IssuedLetter',
    entityId: letter.id,
    meta: { referenceNo: letter.referenceNo, reason: String(reason) },
  });

  return { id: updated.id, status: updated.status, referenceNo: updated.referenceNo, voidedAt: updated.voidedAt };
}

// ── issueRenderedDocument ─────────────────────────────────────────────────────
/**
 * issueRenderedDocument(client, args) — issue a CALLER-RENDERED PDF (Form 16, an
 * FnF-statement bundle, a payslip-pack…) through the SAME audited register path
 * as issueLetter, WITHOUT the merge-field renderer. Factored out of issueLetter's
 * §4 ISSUE tail so a non-template PDF rides one path: allocateCode ref-no → sha256
 * → storePdf → IssuedLetter ISSUED + snapshot → EmployeeDocument EMPLOYEE_VISIBLE
 * → optional built-in e-sign envelope (when sign + a signer set) → audit.
 *
 * The caller owns rendering (the bytes ARE the certificate); we own provenance.
 * The register / scope / download / supersede-chain / e-sign all inherit for free.
 *
 * @param {Object} client  prisma OR an interactive tx (the caller may pass its own).
 * @param {Object} args
 * @param {string}  args.businessId
 * @param {string}  [args.entityId]            entity whose LETTER sequence + ref-segment apply
 * @param {string}  args.actorUserId
 * @param {string}  args.employeeId            subject employee (caller already F1-scoped it)
 * @param {Buffer}  args.pdf                   the rendered PDF bytes (required)
 * @param {string}  args.subject               document subject / EmployeeDocument name
 * @param {string}  [args.category='CUSTOM']   LetterCategory for the IssuedLetter row
 * @param {string}  [args.docCategory='FORM16'] EmployeeDocument.category
 * @param {string}  [args.refNoPrefix='F16']   ref-no prefix (allocateCode)
 * @param {string}  [args.templateId]          link the IssuedLetter to a template (optional)
 * @param {boolean} [args.sign=false]          open a built-in e-sign envelope
 * @param {Array}   [args.signers]             signer set (defaults to a single EMPLOYER signatory)
 * @param {Object}  [args.brand]               { signatoryName, signatoryDesignation } for default signer
 * @param {Object}  [args.business]            { email } for the default signer email
 * @param {Object}  [args.mergeDataJson]       audit snapshot of what was certified
 * @returns { issuedLetterId, referenceNo, fileUrl, fileHash, status,
 *            employeeDocumentId, signatureEnvelopeId, sizeBytes }
 */
async function issueRenderedDocument(client, args = {}) {
  const {
    businessId, entityId = null, actorUserId, employeeId = null, pdf,
    subject, category = 'CUSTOM', docCategory = 'FORM16', refNoPrefix = 'F16',
    templateId = null, sign = false, signers, brand = null, business = null,
    mergeDataJson = {}, periodKey: periodKeyArg = null,
  } = args;

  const db = client || prismaDefault;
  if (!businessId) throw new ServiceError('businessId is required', 400);
  if (!Buffer.isBuffer(pdf) || !pdf.length) throw new ServiceError('A rendered PDF buffer is required', 400);

  const prefix = String(refNoPrefix || 'F16').replace(/\/+$/, '');
  // Resolve the entity for the ref-segment + tax-year period key.
  let entity = null;
  if (entityId) {
    entity = await db.entity.findFirst({ where: { id: entityId, businessId, deletedAt: null } });
  }
  const now = new Date();
  const periodKey = periodKeyArg || taxYearFor(now, entity ? (entity.taxYearStartMonth || 4) : 4);
  const refEntitySeg = entity ? entityRefSegment(entity) : (entityId ? entityRefSegment({ id: entityId }) : null);
  const status = sign ? 'PENDING_SIGNATURE' : 'ISSUED';

  const result = await inTx(db, async (tx) => {
    // Ref-no: signed docs DEFER the human ref-no to COMPLETED (no seq burned),
    // exactly like issueLetter's requiresSignature path.
    let referenceNo = null;
    let seqValue = null;
    if (!sign) {
      const code = await allocateCode(tx, { businessId, entityId, scope: 'LETTER', prefix, padding: 4, periodKey });
      const tail = String(code).replace(/^.*?(\d+)$/, '$1');
      seqValue = parseInt(tail, 10);
      referenceNo = refEntitySeg
        ? `${prefix}/${refEntitySeg}/${periodKey}/${tail}`
        : `${prefix}/${periodKey}/${tail}`;
    }

    const fileHash = sha256(pdf);
    const fileUrl = await storePdf({ pdf, businessId });

    let employeeDocumentId = null;
    if (employeeId) {
      const doc = await tx.employeeDocument.create({
        data: {
          businessId,
          employeeId,
          category: docCategory,
          name: subject || 'Document',
          fileUrl,
          fileHash,
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
          visibility: 'EMPLOYEE_VISIBLE',
          signatureStatus: sign ? 'PENDING' : 'NOT_REQUIRED',
        },
        select: { id: true },
      });
      employeeDocumentId = doc.id;
    }

    const letter = await tx.issuedLetter.create({
      data: {
        businessId,
        entityId: entityId || null,
        referenceNo: referenceNo || draftRef(),
        category,
        employeeId: employeeId || null,
        templateId: templateId || null,
        subject: subject || null,
        renderedBody: subject || 'Rendered document',
        mergeDataJson: mergeDataJson || {},
        fileUrl,
        fileHash,
        mimeType: 'application/pdf',
        sizeBytes: pdf.length,
        status,
        employeeDocumentId,
        issuedBy: actorUserId || 'system',
        issuedAt: sign ? null : now,
        seqScope: 'LETTER',
        seqPeriodKey: periodKey,
        seqValue,
      },
    });

    // Optional built-in e-sign envelope (the same provider path issueLetter uses).
    let signatureEnvelopeId = null;
    if (sign && employeeDocumentId) {
      const provider = esign.getProvider('BUILTIN');
      const signatoryName = (brand && brand.signatoryName) || 'Authorised Signatory';
      const signatoryEmail = (business && business.email) || 'hr@example.com';
      const envSigners = Array.isArray(signers) && signers.length
        ? signers
        : [{ signerOrder: 1, role: 'EMPLOYER', name: signatoryName, email: signatoryEmail }];
      const out = await provider.createEnvelope({
        businessId,
        subject: subject || 'Document for signature',
        employeeDocumentId,
        signers: envSigners,
        sequential: true,
      }, tx);
      signatureEnvelopeId = out.envelope.id;
      await tx.issuedLetter.update({ where: { id: letter.id }, data: { signatureEnvelopeId } });
      await tx.signatureEnvelope.update({ where: { id: signatureEnvelopeId }, data: { issuedLetterId: letter.id } });
    }

    return {
      issuedLetterId: letter.id,
      referenceNo,
      fileUrl,
      fileHash,
      status,
      employeeDocumentId,
      signatureEnvelopeId,
      sizeBytes: pdf.length,
    };
  });

  await writeAudit({
    businessId,
    actorId: actorUserId,
    action: sign ? 'document.issue.pending_signature' : 'document.issue',
    entityType: 'IssuedLetter',
    entityId: result.issuedLetterId,
    meta: { referenceNo: result.referenceNo, category, docCategory, employeeId, status: result.status, fileHash: result.fileHash },
  });

  return result;
}

module.exports = {
  issueLetter,
  issueRenderedDocument,
  reissueLetter,
  revokeLetter,
  ServiceError,
  // exported for tests / register helpers
  _internals: { taxYearFor, CATEGORY_TO_DOC, resolveLetterhead, mergeEmployeeFrom, fetchLetterheadBytes },
};

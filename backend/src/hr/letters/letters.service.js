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
const { resolveMergeData, renderMerge } = require('./mergeFields');
const { renderLetter } = require('./renderLetter');
const { renderLetterFallback } = require('./letterPdfFallback');

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
};

const WATERMARK_PREVIEW = 'DRAFT — NOT VALID';
const WATERMARK_REVOKED = 'REVOKED';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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
          designation: { select: { name: true } },
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
    name: o.authorityName || (template.layoutAuthorityName) || (ctx.brand && ctx.brand.signatoryName) || '',
    designation: o.authorityDesignation || (ctx.brand && ctx.brand.signatoryDesignation) || '',
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
    designation: er.designation ? er.designation.name : null,
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
async function renderPdf({ ctx, render, watermark }) {
  const { fontBytes, fontBoldBytes } = loadFonts();
  if (ctx.letterhead) {
    const lhBytes = await fetchLetterheadBytes(ctx.letterhead.fileUrl);
    if (lhBytes) {
      const layout = ctx.letterhead.layoutJson && typeof ctx.letterhead.layoutJson === 'object'
        ? ctx.letterhead.layoutJson : {};
      return renderLetter({
        letterheadPdf: lhBytes,
        layout,
        bodyText: render.bodyText,
        fields: render.fields,
        fontBytes,
        fontBoldBytes,
        opts: {
          overflowPolicy: layout.overflowPolicy || 'repeat-letterhead',
          signatureOnLastPage: !!layout.signatureOnLastPage,
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

  const locale = ctx.template.locale
    || (ctx.entity && ctx.entity.countryCode === 'NZ' ? 'en-NZ' : 'en-IN');
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
      // code is "<prefix>NNNN"; we want "<prefix>/<year>/NNNN". Extract the
      // padded numeric tail the allocator produced, re-format with the year.
      const tail = String(code).replace(/^.*?(\d+)$/, '$1');
      seqValue = parseInt(tail, 10);
      const year = String(now.getUTCFullYear());
      referenceNo = `${prefix}/${year}/${tail}`;
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

    // Best-effort link the ESS DocumentRequest's generatedDocumentId (status flip
    // to FULFILLED is owned by 9F; RequestStatus has no FULFILLED in v1 enum).
    if (documentRequestId && employeeDocumentId) {
      try {
        await tx.documentRequest.updateMany({
          where: { id: documentRequestId, businessId },
          data: { generatedDocumentId: employeeDocumentId },
        });
      } catch (_e) { /* non-fatal */ }
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

  // Mint with a bounded retry: if the ref-no collides on @@unique(businessId,
  // referenceNo) — a sequence that fell behind reality (out-of-band insert/restore,
  // or a concurrent issuance that won the row-lock) — re-sync the LETTER sequence
  // past the highest existing letter for this (entity, period) key, then retry.
  // (Spec §6: "caller retries on P2002.") Only attempted when `db` is a real client
  // (issueLetter opens its own tx per attempt); never for deferred-ref drafts.
  let result;
  for (let attempt = 0; ; attempt += 1) {
    try { result = await runIssueTx(); break; }
    catch (e) {
      const refDup = e && e.code === 'P2002'
        && String((e.meta && e.meta.target) || '').toLowerCase().includes('referenceno');
      if (refDup && !requiresSignature && attempt < 6 && typeof db.$transaction === 'function') {
        const agg = await db.issuedLetter.aggregate({
          where: { businessId, entityId: issueEntityId, seqScope: 'LETTER', seqPeriodKey: periodKey },
          _max: { seqValue: true },
        });
        const nextVal = ((agg._max && agg._max.seqValue) || 0) + 1;
        const existing = await db.numberSequence.findFirst({
          where: { businessId, entityId: issueEntityId, scope: 'LETTER', periodKey },
          select: { id: true },
        });
        if (existing) {
          await db.numberSequence.update({ where: { id: existing.id }, data: { nextValue: nextVal } });
        } else {
          await db.numberSequence.create({
            data: { businessId, entityId: issueEntityId, scope: 'LETTER', prefix, padding: 4, nextValue: nextVal, periodKey },
          });
        }
        continue;
      }
      throw e;
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

  // Issue a fresh letter from the source's provenance + any overrides.
  const issued = await issueLetter(db, {
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

  // Link the supersede chain (source retained as ISSUED).
  await inTx(db, async (tx) => {
    await tx.issuedLetter.update({
      where: { id: issued.issuedLetterId },
      data: { supersedesLetterId: source.id },
    });
    await tx.issuedLetter.update({
      where: { id: source.id },
      data: { supersededByLetterId: issued.issuedLetterId },
    });
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

module.exports = {
  issueLetter,
  reissueLetter,
  revokeLetter,
  ServiceError,
  // exported for tests / register helpers
  _internals: { taxYearFor, CATEGORY_TO_DOC, resolveLetterhead, mergeEmployeeFrom, fetchLetterheadBytes },
};

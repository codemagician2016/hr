'use strict';

/*
 * issuance.service.test.js — LIVE service+controller proof for Feature 9 slice
 * 9E (Issue / preview / re-issue / revoke + register, the orchestration engine).
 *
 * Plain-node runner (no jest), same isolated hr_test schema convention as the
 * other live tests:
 *   DATABASE_URL="$HR_URL" node src/hr/letters/__tests__/issuance.service.test.js
 * where $HR_URL = the repo .env DATABASE_URL with ?schema=hr_test.
 *
 * Proves (docs/features/09 §8 "Slice 9E" acceptance):
 *   (1) POST /preview streams a watermarked PDF — NO persistence, NO ref-no;
 *   (2) POST /issue (one $transaction) mints ".../2026/0001", renders a flattened
 *       PDF, stores IssuedLetter ISSUED + EmployeeDocument EMPLOYEE_VISIBLE + a
 *       writeAudit row, with the SHA-256 fileHash as the tamper anchor;
 *   (3) missingRequired ⇒ 422 with the field list;
 *   (4) out-of-scope employee ⇒ 404 (not 403);
 *   (5) reissue ⇒ NEW ref-no + supersedes/supersededBy chain (source retained);
 *   (6) revoke (canManageLetters + reason) ⇒ VOIDED + linked doc flipped HR_ONLY,
 *       ref-no burned;
 *   (7) CONTRACT / requiresSignature ⇒ PENDING_SIGNATURE envelope (ref-no deferred);
 *   (8) register filters/searches + CSV export.
 *
 * A throwaway tenant is seeded and torn down (no reliance on the demo seed); a
 * single A4 letterhead PDF is generated in-test with pdf-lib (inline data URL,
 * exactly the dev/no-bucket storage path).
 */

const path = require('path');
const { PDFDocument } = require('pdf-lib');

const prisma = require('../../../core/lib/prisma');
const service = require('../letters.service');
const controller = require('../controllers/issuance.controller');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── Express res()/controller doubles ─────────────────────────────────────────
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    sent: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.sent = payload; return this; },
    send(payload) { this.body = payload; this.sent = payload; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const oJson = res.json.bind(res); res.json = (p) => { const r = oJson(p); done(); return r; };
    const oSend = res.send.bind(res); res.send = (p) => { const r = oSend(p); done(); return r; };
    const oEnd = res.end.bind(res); res.end = () => { const r = oEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const ALL_PERMS = {
  canGenerateLetters: true, canManageLetters: true, canViewCompensation: true,
  canViewEmployees: true,
};
function reqFor({ user, scope, body, params, query }) {
  return {
    user,
    scope: scope || { kind: 'ALL', ids: new Set() },
    body: body || {},
    params: params || {},
    query: query || {},
  };
}

const TAG = `lt9e_${Date.now()}`;

async function makeA4LetterheadDataUrl() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]); // A4 portrait
  const bytes = await doc.save();
  return `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function seed() {
  const biz = await prisma.business.create({
    data: {
      name: `Letters Co ${TAG}`, slug: `letters-${TAG}`, region: 'IN', country: 'IN',
      // Distinct employer email so the default CONTRACT EMPLOYER signer is NOT the
      // subject employee (the SoD self-approve guard rejects same-email signers).
      email: `hr@${TAG}.test`,
    },
  });
  const businessId = biz.id;

  const entity = await prisma.entity.create({
    data: {
      businessId, code: `${TAG}-HQ`, legalName: 'Letters Co Pvt Ltd', tradeName: 'Letters Co',
      countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata',
      taxYearStartMonth: 4, activeFrom: new Date('2026-04-01'), cin: 'U72900KA2020PTC000001', gstin: '29ABCDE1234F1Z5',
    },
  });

  const employee = await prisma.employee.create({
    data: {
      businessId, code: `${TAG}-E1`, firstName: 'Aarav', lastName: 'Sharma',
      workEmail: `aarav@${TAG}.test`, status: 'ACTIVE', hireDate: new Date('2024-01-15'),
    },
  });

  const comp = await prisma.compensationRevision.create({
    data: {
      businessId, employeeId: employee.id, entityId: entity.id, currencyCode: 'INR',
      basis: 'CTC', ctcAnnual: '1200000.00', grossMonthly: '100000.00',
      effectiveFrom: new Date('2024-01-15'), revisionReason: 'HIRE', isCurrent: true,
    },
  });
  await prisma.employee.update({ where: { id: employee.id }, data: { currentCompensationId: comp.id } });

  // An out-of-scope employee in the SAME tenant (for the 404-not-403 case).
  const otherEmp = await prisma.employee.create({
    data: {
      businessId, code: `${TAG}-E2`, firstName: 'Out', lastName: 'OfScope',
      workEmail: `out@${TAG}.test`, status: 'ACTIVE',
    },
  });

  const letterhead = await prisma.companyLetterhead.create({
    data: {
      businessId, code: `${TAG}-DEFAULT`, name: 'Default Letterhead',
      fileUrl: await makeA4LetterheadDataUrl(), fileHash: 'seedhash', mimeType: 'application/pdf',
      pageWidthPt: 595.28, pageHeightPt: 841.89,
      layoutJson: {
        writingArea: { x: 0.1, y: 0.3, w: 0.8, h: 0.5, fontSize: 11, lineGap: 4 },
        fields: {
          date: { x: 0.7, y: 0.18, w: 0.2, h: 0.03, align: 'right' },
          refNo: { x: 0.1, y: 0.18, w: 0.4, h: 0.03 },
          authority: { x: 0.1, y: 0.85, w: 0.4, h: 0.03 },
        },
        overflowPolicy: 'repeat-letterhead',
      },
      isDefault: true, isActive: true,
    },
  });

  // EXPERIENCE template — requires employee.name (so we can prove missingRequired).
  const tpl = await prisma.letterTemplate.create({
    data: {
      businessId, entityId: entity.id, code: `${TAG}-EXP`, name: 'Experience Certificate',
      category: 'EXPERIENCE', countryCode: 'IN', locale: 'en-IN',
      subject: 'Experience Certificate',
      bodyMarkdown:
        'This is to certify that {{employee.name}} ({{employee.code}}), {{employee.designation}}, '
        + 'was employed with {{company.legalName}} from {{employee.dateOfJoining}}. '
        + 'Annual CTC: {{comp.ctcAnnual}}.',
      mergeFieldsJson: { 'employee.name': { type: 'string', required: true } },
      defaultLetterheadId: letterhead.id, refNoPrefix: `${TAG}/HR`,
      isSystem: false, isActive: true, version: 1,
    },
  });

  // A CONTRACT template with requiresSignature for the e-sign path.
  const contractTpl = await prisma.letterTemplate.create({
    data: {
      businessId, entityId: entity.id, code: `${TAG}-CON`, name: 'Appointment Letter',
      category: 'CONTRACT', countryCode: 'IN', locale: 'en-IN', subject: 'Appointment Letter',
      bodyMarkdown: 'Dear {{employee.name}}, we are pleased to appoint you at {{company.legalName}}.',
      requiresSignature: true, refNoPrefix: `${TAG}/CON`, isActive: true, version: 1,
    },
  });

  // A template that REQUIRES a field the employee lacks (forces missingRequired).
  const reqTpl = await prisma.letterTemplate.create({
    data: {
      businessId, entityId: entity.id, code: `${TAG}-REQ`, name: 'Bank Letter',
      category: 'BANK', countryCode: 'IN', locale: 'en-IN', subject: 'Bank Confirmation',
      bodyMarkdown: 'Account: {{employee.bankAccountMasked}} at {{employee.ifsc}}.',
      mergeFieldsJson: { 'employee.ifsc': { type: 'string', required: true } },
      defaultLetterheadId: letterhead.id, refNoPrefix: `${TAG}/BANK`, isActive: true, version: 1,
    },
  });

  // ── A SECOND entity + employee + template sharing the SAME refNoPrefix as the
  // first (proves the cross-entity ref-no collision fix: two entities, same prefix,
  // same period, both naturally start at 0001 → must NOT collide on the per-tenant
  // @@unique([businessId, referenceNo])).
  const entity2 = await prisma.entity.create({
    data: {
      businessId, code: `${TAG}-BR2`, legalName: 'Letters Co Branch 2 Pvt Ltd', tradeName: 'Letters Co B2',
      countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata',
      taxYearStartMonth: 4, activeFrom: new Date('2026-04-01'),
    },
  });
  const emp2 = await prisma.employee.create({
    data: {
      businessId, code: `${TAG}-E3`, firstName: 'Priya', lastName: 'Verma',
      workEmail: `priya@${TAG}.test`, status: 'ACTIVE', hireDate: new Date('2023-06-01'),
    },
  });
  const tpl2 = await prisma.letterTemplate.create({
    data: {
      businessId, entityId: entity2.id, code: `${TAG}-EXP2`, name: 'Experience Certificate B2',
      category: 'EXPERIENCE', countryCode: 'IN', locale: 'en-IN', subject: 'Experience Certificate',
      bodyMarkdown: 'This certifies {{employee.name}} ({{employee.code}}) of {{company.legalName}}.',
      mergeFieldsJson: { 'employee.name': { type: 'string', required: true } },
      defaultLetterheadId: letterhead.id,
      refNoPrefix: `${TAG}/HR`, // SAME prefix as tpl → forces a cross-entity name clash absent disambiguation
      isSystem: false, isActive: true, version: 1,
    },
  });

  // An ESS DocumentRequest belonging to `employee` (for the fulfilment test) and a
  // second one belonging to `emp2` (to prove cross-employee fulfilment is rejected).
  const reqForEmp1 = await prisma.documentRequest.create({
    data: {
      businessId, employeeId: employee.id, templateKind: 'EXPERIENCE_LETTER',
      purpose: 'Need an experience letter', status: 'PENDING',
    },
  });
  const reqForEmp2 = await prisma.documentRequest.create({
    data: {
      businessId, employeeId: emp2.id, templateKind: 'EXPERIENCE_LETTER',
      purpose: 'Branch 2 experience letter', status: 'PENDING',
    },
  });

  return {
    businessId, entity, entity2, employee, emp2, otherEmp, letterhead,
    tpl, tpl2, contractTpl, reqTpl, reqForEmp1, reqForEmp2,
  };
}

async function cleanup(businessId) {
  if (!businessId) return;
  await prisma.signatureSigner.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.signatureEnvelope.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.issuedLetter.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.documentRequest.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.employeeDocument.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.letterTemplate.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.companyLetterhead.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.numberSequence.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.compensationRevision.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.employee.updateMany({ where: { businessId }, data: { currentCompensationId: null } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.entity.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.business.delete({ where: { id: businessId } }).catch(() => {});
}

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-';
}

async function main() {
  log('\n=== Feature 9 slice 9E — issuance engine (service + controller) ===\n');
  let s;
  try {
    s = await seed();
    const {
      businessId, entity, entity2, employee, emp2, otherEmp,
      tpl, tpl2, contractTpl, reqTpl, reqForEmp1, reqForEmp2,
    } = s;
    const user = { id: `${TAG}-user`, businessId, role: 'BUSINESS_ADMIN' };

    // ── (1) PREVIEW — watermarked PDF, no persistence, no ref-no ──────────────
    log('(1) POST /preview:');
    {
      const before = await prisma.issuedLetter.count({ where: { businessId } });
      const res = await callController(controller.preview, reqFor({
        user, body: { templateId: tpl.id, employeeId: employee.id },
      }));
      const after = await prisma.issuedLetter.count({ where: { businessId } });
      assert(res.statusCode === 200, 'preview → 200');
      assert(isPdf(res.sent), 'preview streams a %PDF- buffer');
      assert(res.headers['content-type'] === 'application/pdf', 'preview Content-Type application/pdf');
      assert(after === before, 'preview persists NOTHING (no IssuedLetter row)');
      // service-level: no ref-no surfaced on preview
      const svc = await service.issueLetter(prisma, {
        businessId, actorUserId: user.id, perms: ALL_PERMS, templateId: tpl.id,
        employeeId: employee.id, mode: 'preview',
      });
      assert(svc.referenceNo === null && svc.watermarked === true, 'preview returns referenceNo=null + watermarked');
    }

    // ── (2) ISSUE — atomic ref-no + ISSUED + EmployeeDocument + audit ─────────
    log('(2) POST /issue:');
    let issuedId; let issuedRef;
    {
      const res = await callController(controller.issue, reqFor({
        user, body: { templateId: tpl.id, employeeId: employee.id },
      }));
      assert(res.statusCode === 201, 'issue → 201');
      const out = res.body;
      issuedId = out.issuedLetterId; issuedRef = out.referenceNo;
      // Format (post-fix): `${prefix}/${entitySeg}/${taxYear}/0001`. The visible
      // year token is now the FULL TAX-YEAR (2026-27, == periodKey) — NOT the bare
      // calendar year — and an entity segment disambiguates per-tenant uniqueness.
      assert(/\/2026-27\/0001$/.test(out.referenceNo), `first ref-no ends /2026-27/0001 (got ${out.referenceNo})`);
      assert(out.referenceNo.startsWith(`${TAG}/HR/`), 'ref-no uses the template refNoPrefix');
      assert(!/\/2026\/0001$/.test(out.referenceNo), 'ref-no no longer uses the bare calendar year');
      // ref-string year token MUST match the persisted periodKey (finding #2).
      assert(out.referenceNo.includes(`/${'2026-27'}/`), 'ref-string year token == periodKey tax year');
      assert(out.status === 'ISSUED', 'status ISSUED');
      assert(typeof out.fileHash === 'string' && out.fileHash.length === 64, 'fileHash is a SHA-256 hex');

      const row = await prisma.issuedLetter.findUnique({ where: { id: issuedId } });
      assert(row && row.status === 'ISSUED', 'IssuedLetter row persisted ISSUED');
      assert(row.seqValue === 1 && row.seqPeriodKey === '2026-27', 'seqValue=1 + seqPeriodKey=2026-27 recorded');
      assert(row.templateVersionAtIssue === 1, 'templateVersionAtIssue snapshotted');
      assert(row.mergeDataJson && typeof row.mergeDataJson === 'object', 'mergeDataJson snapshotted');
      assert(/Aarav Sharma/.test(row.renderedBody), 'renderedBody has merged employee name');
      assert(typeof row.fileUrl === 'string' && row.fileUrl.startsWith('data:application/pdf'), 'fileUrl stored (inline fallback)');

      const doc = await prisma.employeeDocument.findUnique({ where: { id: row.employeeDocumentId } });
      assert(doc && doc.visibility === 'EMPLOYEE_VISIBLE', 'EmployeeDocument written EMPLOYEE_VISIBLE');
      assert(doc.category === 'EXPERIENCE', 'EmployeeDocument category mapped EXPERIENCE');
      assert(doc.fileHash === row.fileHash, 'doc.fileHash == letter.fileHash (same artifact)');
      assert(doc.signatureStatus === 'NOT_REQUIRED', 'doc signatureStatus NOT_REQUIRED (no e-sign)');

      const audits = await prisma.auditLog.findMany({ where: { businessId, entityType: 'IssuedLetter', entityId: issuedId } });
      assert(audits.some((a) => a.action === 'letter.issue'), 'writeAudit letter.issue row written');

      // second issue → 0002 (atomic increment within periodKey)
      const res2 = await callController(controller.issue, reqFor({
        user, body: { templateId: tpl.id, employeeId: employee.id },
      }));
      assert(/\/2026-27\/0002$/.test(res2.body.referenceNo), 'second issue increments to /2026-27/0002');
    }

    // ── (2b) download streams the stored flattened PDF ───────────────────────
    {
      const res = await callController(controller.download, reqFor({ user, params: { id: issuedId } }));
      assert(res.statusCode === 200 && isPdf(res.sent), 'GET /:id/download streams the issued %PDF-');
      assert(/attachment/.test(res.headers['content-disposition'] || ''), 'download is Content-Disposition: attachment');
    }

    // ── (3) missingRequired ⇒ 422 with the field list ────────────────────────
    log('(3) missingRequired ⇒ 422:');
    {
      const res = await callController(controller.issue, reqFor({
        user, body: { templateId: reqTpl.id, employeeId: employee.id },
      }));
      assert(res.statusCode === 422, 'issue with an unmet required field → 422');
      assert(Array.isArray(res.body.missingRequired) && res.body.missingRequired.includes('employee.ifsc'),
        '422 body carries missingRequired:[employee.ifsc]');
    }

    // ── (4) out-of-scope employee ⇒ 404 (not 403) ────────────────────────────
    log('(4) out-of-scope employee ⇒ 404:');
    {
      // A TEAM-band scope that does NOT include otherEmp.
      const teamScope = { kind: 'TEAM', ids: new Set([employee.id]) };
      const res = await callController(controller.issue, reqFor({
        user, scope: teamScope, body: { templateId: tpl.id, employeeId: otherEmp.id },
      }));
      assert(res.statusCode === 404, 'issue for an out-of-scope subject → 404 (not 403)');
      const previewRes = await callController(controller.preview, reqFor({
        user, scope: teamScope, body: { templateId: tpl.id, employeeId: otherEmp.id },
      }));
      assert(previewRes.statusCode === 404, 'preview for an out-of-scope subject → 404');
    }

    // ── (5) reissue ⇒ new ref + supersede chain (source retained) ────────────
    log('(5) POST /:id/reissue:');
    {
      const res = await callController(controller.reissue, reqFor({ user, params: { id: issuedId } }));
      assert(res.statusCode === 201, 'reissue → 201');
      const newId = res.body.issuedLetterId;
      assert(res.body.referenceNo !== issuedRef && /\/2026-27\/000\d$/.test(res.body.referenceNo),
        'reissue mints a NEW ref-no');
      const src = await prisma.issuedLetter.findUnique({ where: { id: issuedId } });
      const neu = await prisma.issuedLetter.findUnique({ where: { id: newId } });
      assert(neu.supersedesLetterId === issuedId, 'new letter.supersedesLetterId → source');
      assert(src.supersededByLetterId === newId, 'source.supersededByLetterId → new letter');
      assert(src.status === 'ISSUED', 'source retained ISSUED (not voided) for history');
    }

    // ── (6) revoke (canManageLetters + reason) ⇒ VOIDED + doc HR_ONLY ────────
    log('(6) POST /:id/revoke:');
    {
      const noReason = await callController(controller.revoke, reqFor({ user, params: { id: issuedId }, body: {} }));
      assert(noReason.statusCode === 422, 'revoke without a reason → 422');

      const row0 = await prisma.issuedLetter.findUnique({ where: { id: issuedId } });
      const docIdBefore = row0.employeeDocumentId;
      const res = await callController(controller.revoke, reqFor({
        user, params: { id: issuedId }, body: { reason: 'Superseded / data error' },
      }));
      assert(res.statusCode === 200 && res.body.status === 'VOIDED', 'revoke with reason → 200 VOIDED');
      const row = await prisma.issuedLetter.findUnique({ where: { id: issuedId } });
      assert(row.status === 'VOIDED' && row.voidedAt && row.voidReason === 'Superseded / data error',
        'VOIDED + voidedAt + voidReason persisted');
      const doc = await prisma.employeeDocument.findUnique({ where: { id: docIdBefore } });
      assert(doc.visibility === 'HR_ONLY', 'linked EmployeeDocument flipped to HR_ONLY (ESS notice)');
      // ref-no burned: the next NEW issue must NOT reuse the voided ref
      const all = await prisma.issuedLetter.findMany({ where: { businessId, referenceNo: row.referenceNo } });
      assert(all.length === 1, 'voided ref-no is burned (not reused by another row)');
    }

    // ── (7) CONTRACT / requiresSignature ⇒ PENDING_SIGNATURE envelope ────────
    log('(7) CONTRACT requiresSignature ⇒ PENDING_SIGNATURE:');
    {
      const res = await callController(controller.issue, reqFor({
        user, body: { templateId: contractTpl.id, employeeId: employee.id },
      }));
      assert(res.statusCode === 201, 'contract issue → 201');
      assert(res.body.status === 'PENDING_SIGNATURE', 'status PENDING_SIGNATURE');
      assert(res.body.referenceNo === null, 'ref-no DEFERRED (null until COMPLETED)');
      assert(typeof res.body.signatureEnvelopeId === 'string', 'a SignatureEnvelope was opened');
      const env = await prisma.signatureEnvelope.findUnique({ where: { id: res.body.signatureEnvelopeId } });
      assert(env && env.issuedLetterId === res.body.issuedLetterId, 'envelope.issuedLetterId back-links the letter');
      const letter = await prisma.issuedLetter.findUnique({ where: { id: res.body.issuedLetterId } });
      assert(letter.status === 'PENDING_SIGNATURE' && letter.seqValue === null, 'letter PENDING_SIGNATURE, no seq consumed');
      assert(letter.referenceNo.startsWith('DRAFT-'), 'letter holds a DRAFT- placeholder ref (real ref deferred)');
    }

    // ── (8) register: filter + search + CSV ──────────────────────────────────
    log('(8) GET /register:');
    {
      const res = await callController(controller.register, reqFor({ user, query: { category: 'EXPERIENCE' } }));
      assert(res.statusCode === 200 && Array.isArray(res.body.items), 'register → 200 with items[]');
      assert(res.body.items.every((r) => r.category === 'EXPERIENCE'), 'category filter applied');
      assert(typeof res.body.total === 'number' && res.body.page === 1, 'pagination envelope present');

      const search = await callController(controller.register, reqFor({ user, query: { search: 'Aarav' } }));
      assert(search.body.items.some((r) => r.employee && /Aarav/.test(r.employee.name)), 'search by employee name hits');

      const csv = await callController(controller.register, reqFor({ user, query: { format: 'csv' } }));
      assert(csv.headers['content-type'].startsWith('text/csv'), 'CSV export Content-Type text/csv');
      assert(typeof csv.sent === 'string' && csv.sent.split('\r\n')[0] === 'referenceNo,category,status,employee,employeeCode,issuedBy,issuedAt',
        'CSV has the header row');
      assert(/EXPERIENCE/.test(csv.sent), 'CSV body has issued rows');
    }

    // ── (9) tenant isolation: cross-tenant id ⇒ 404 ──────────────────────────
    log('(9) cross-tenant id ⇒ 404:');
    {
      const otherUser = { id: 'x', businessId: `${businessId}-nope`, role: 'BUSINESS_ADMIN' };
      const res = await callController(controller.getOne, reqFor({ user: otherUser, params: { id: issuedId } }));
      assert(res.statusCode === 404, 'GET /:id for a different tenant → 404');
    }

    // ── (10) cross-entity ref-no: two entities, same prefix, NO collision ─────
    log('(10) cross-entity ref-no disambiguation (findings #1/#2):');
    {
      // Issue for entity2's employee via tpl2 (SAME prefix `${TAG}/HR` as tpl). The
      // OLD code would mint an identical string to entity1's first letter and throw
      // an unrecoverable P2002; the fix embeds an entity segment so they differ.
      const r2 = await service.issueLetter(prisma, {
        businessId, entityId: entity2.id, actorUserId: user.id, perms: ALL_PERMS,
        templateId: tpl2.id, employeeId: emp2.id, mode: 'issue',
      });
      assert(r2.status === 'ISSUED' && typeof r2.referenceNo === 'string', 'entity2 issue succeeds (no P2002)');
      assert(r2.referenceNo.startsWith(`${TAG}/HR/`), 'entity2 ref uses the shared prefix');
      assert(/\/2026-27\/0001$/.test(r2.referenceNo), 'entity2 sequence is its OWN per-entity 0001');

      // The two entities' first letters share prefix + period + tail but the full
      // referenceNo strings MUST differ (entity segment).
      const e1first = await prisma.issuedLetter.findFirst({
        where: { businessId, entityId: entity.id, seqValue: 1, seqPeriodKey: '2026-27' },
        orderBy: { createdAt: 'asc' },
      });
      assert(e1first && e1first.referenceNo !== r2.referenceNo,
        `cross-entity refs differ (${e1first && e1first.referenceNo} vs ${r2.referenceNo})`);
      // and both are genuinely persisted (no swallowed collision)
      const both = await prisma.issuedLetter.findMany({
        where: { businessId, referenceNo: { in: [e1first.referenceNo, r2.referenceNo] } },
      });
      assert(both.length === 2, 'both cross-entity letters persisted under distinct ref-nos');
      // ref-string year token matches periodKey on BOTH (finding #2)
      assert(r2.referenceNo.includes('/2026-27/') && e1first.referenceNo.includes('/2026-27/'),
        'both ref strings carry the tax-year token matching periodKey');
    }

    // ── (11) concurrent issuance does NOT double-consume (best-effort) ────────
    // The hard guarantee (spec §6, finding #3): under concurrency the per-tenant
    // @@unique([businessId, referenceNo]) NEVER admits a duplicate, and no slot is
    // double-consumed. allocateCode (codes.js) is a non-atomic read-then-increment
    // that we MUST NOT change, so under a thundering herd some losers exhaust the
    // bounded retry and fail with a benign P2002 — that's acceptable; what is NOT
    // acceptable is a duplicate ref-no, a raw NumberSequence-create 500, or a
    // double-consumed number. We assert the invariants, not zero failures.
    log('(11) concurrent issuance — no duplicate / no double-consume:');
    {
      const N = 6;
      const results = await Promise.allSettled(Array.from({ length: N }, () =>
        service.issueLetter(prisma, {
          businessId, entityId: entity.id, actorUserId: user.id, perms: ALL_PERMS,
          templateId: tpl.id, employeeId: employee.id, mode: 'issue',
        })));
      const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.referenceNo);
      const fail = results.filter((r) => r.status === 'rejected');
      assert(ok.length >= 1, `at least one concurrent issue succeeded (${ok.length}/${N})`);
      const uniq = new Set(ok);
      assert(uniq.size === ok.length, `no duplicate ref-no across successes (${ok.length} unique)`);
      // every failure is a benign P2002 (retry-exhaustion), NOT a corrupt 500 — and
      // crucially never a raw NumberSequence-create error bubbling out.
      assert(fail.every((r) => r.reason && r.reason.code === 'P2002'),
        `every concurrent failure is a benign P2002 (got ${fail.map((r) => r.reason && r.reason.code).join(',') || 'none'})`);
      // DB-level: no two rows share a referenceNo in this tenant (the real invariant)
      const dupes = await prisma.$queryRawUnsafe(
        `SELECT "referenceNo", COUNT(*) c FROM "IssuedLetter" WHERE "businessId" = $1 GROUP BY "referenceNo" HAVING COUNT(*) > 1`,
        businessId,
      );
      assert(Array.isArray(dupes) && dupes.length === 0, 'DB has zero duplicate referenceNo rows in the tenant');
    }

    // ── (12) reissue is ATOMIC: a forced failure rolls back the new letter ────
    log('(12) reissue atomicity (finding #5):');
    {
      // Issue a fresh source to reissue from.
      const src = await service.issueLetter(prisma, {
        businessId, entityId: entity.id, actorUserId: user.id, perms: ALL_PERMS,
        templateId: tpl.id, employeeId: employee.id, mode: 'issue',
      });
      const beforeCount = await prisma.issuedLetter.count({ where: { businessId } });

      // Force a failure INSIDE the reissue tx, AFTER the new letter + supersede
      // links are written but BEFORE commit, by patching $transaction to throw once
      // its callback resolves. Because issue + links now share ONE tx, this must
      // roll the whole thing back — no orphan ISSUED letter, source not marked.
      const realTx = prisma.$transaction.bind(prisma);
      let armed = true;
      prisma.$transaction = (arg, opts) => {
        if (armed && typeof arg === 'function') {
          armed = false;
          return realTx(async (tx) => {
            await arg(tx);                       // run issue + both supersede links
            throw new Error('FORCED post-link failure (pre-commit)');
          }, opts);
        }
        return realTx(arg, opts);
      };
      let threw = false;
      try {
        await service.reissueLetter(prisma, {
          businessId, actorUserId: user.id, perms: ALL_PERMS, sourceId: src.issuedLetterId,
        });
      } catch (_e) { threw = true; }
      prisma.$transaction = realTx; // restore

      assert(threw, 'forced in-tx failure propagates (reissue throws)');
      const afterCount = await prisma.issuedLetter.count({ where: { businessId } });
      assert(afterCount === beforeCount, 'NO orphan letter persisted — reissue rolled back fully (atomic)');
      const srcAfter = await prisma.issuedLetter.findUnique({ where: { id: src.issuedLetterId } });
      assert(srcAfter.supersededByLetterId === null, 'source NOT marked superseded (rollback clean)');

      // and a normal reissue still works end-to-end
      const reok = await service.reissueLetter(prisma, {
        businessId, actorUserId: user.id, perms: ALL_PERMS, sourceId: src.issuedLetterId,
      });
      const srcLive = await prisma.issuedLetter.findUnique({ where: { id: src.issuedLetterId } });
      assert(reok.issuedLetterId && srcLive.supersededByLetterId === reok.issuedLetterId,
        'a clean reissue still links the supersede chain atomically');
    }

    // ── (13) DocumentRequest fulfilment flips status + employeeId-scoped ──────
    log('(13) DocumentRequest fulfilment (finding #6/#15):');
    {
      // Fulfil employee's OWN request → status advances + generatedDocumentId set.
      const fr = await service.issueLetter(prisma, {
        businessId, entityId: entity.id, actorUserId: user.id, perms: ALL_PERMS,
        templateId: tpl.id, employeeId: employee.id, mode: 'issue',
        documentRequestId: reqForEmp1.id,
      });
      const reqAfter = await prisma.documentRequest.findUnique({ where: { id: reqForEmp1.id } });
      assert(reqAfter.status !== 'PENDING', `request status advanced past PENDING (now ${reqAfter.status})`);
      assert(reqAfter.generatedDocumentId === fr.employeeDocumentId, 'generatedDocumentId == issued letter doc');

      // Attempt to fulfil emp2's request while issuing a letter to `employee`
      // (cross-employee) → must NOT touch reqForEmp2 (employeeId scope enforced).
      const cross = await service.issueLetter(prisma, {
        businessId, entityId: entity.id, actorUserId: user.id, perms: ALL_PERMS,
        templateId: tpl.id, employeeId: employee.id, mode: 'issue',
        documentRequestId: reqForEmp2.id, // belongs to emp2, NOT employee
      });
      const req2After = await prisma.documentRequest.findUnique({ where: { id: reqForEmp2.id } });
      assert(req2After.status === 'PENDING', 'foreign-employee request left PENDING (no cross-employee fulfilment)');
      assert(req2After.generatedDocumentId === null, 'foreign request NOT linked to the issued letter');
      assert(cross.status === 'ISSUED', 'the issuance itself still succeeds (foreign request is a no-op)');
    }

    // ── (14) CONTRACT self-signer (employer == subject) is rejected ───────────
    log('(14) CONTRACT e-sign self-approve guard (finding #13):');
    {
      // employer signer email == the subject employee's email → self-approve loop.
      const selfSigners = [
        { signerOrder: 1, role: 'EMPLOYER', name: 'Self', email: employee.workEmail },
        { signerOrder: 2, role: 'EMPLOYEE', name: 'Aarav', email: employee.workEmail, employeeId: employee.id },
      ];
      const res = await callController(controller.issue, reqFor({
        user, body: { templateId: contractTpl.id, employeeId: employee.id, signers: selfSigners },
      }));
      assert(res.statusCode === 422, `self-signer CONTRACT rejected with 422 (got ${res.statusCode})`);

      // employer matching by employeeId is also rejected
      const selfById = [
        { signerOrder: 1, role: 'EMPLOYER', name: 'Self', email: `boss@${TAG}.test`, employeeId: employee.id },
        { signerOrder: 2, role: 'EMPLOYEE', name: 'Aarav', email: employee.workEmail, employeeId: employee.id },
      ];
      const res2 = await callController(controller.issue, reqFor({
        user, body: { templateId: contractTpl.id, employeeId: employee.id, signers: selfById },
      }));
      assert(res2.statusCode === 422, 'self-signer by employeeId also rejected with 422');

      // a DISTINCT employer is accepted (PENDING_SIGNATURE)
      const goodSigners = [
        { signerOrder: 1, role: 'EMPLOYER', name: 'HR Head', email: `hrhead@${TAG}.test` },
        { signerOrder: 2, role: 'EMPLOYEE', name: 'Aarav', email: employee.workEmail, employeeId: employee.id },
      ];
      const ok = await callController(controller.issue, reqFor({
        user, body: { templateId: contractTpl.id, employeeId: employee.id, signers: goodSigners },
      }));
      assert(ok.statusCode === 201 && ok.body.status === 'PENDING_SIGNATURE',
        'a distinct non-subject employer signer is accepted');
    }
  } catch (err) {
    failures += 1;
    log('  CRASH ', err && err.stack ? err.stack : err);
  } finally {
    if (s) await cleanup(s.businessId);
  }

  log(`\n=== ${failures === 0 ? 'ALL 9E CHECKS PASSED' : `${failures} 9E CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('9E test crashed:', err);
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});

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
    data: { name: `Letters Co ${TAG}`, slug: `letters-${TAG}`, region: 'IN', country: 'IN' },
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

  return { businessId, entity, employee, otherEmp, letterhead, tpl, contractTpl, reqTpl };
}

async function cleanup(businessId) {
  if (!businessId) return;
  await prisma.signatureSigner.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.signatureEnvelope.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.issuedLetter.deleteMany({ where: { businessId } }).catch(() => {});
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
    const { businessId, employee, otherEmp, tpl, contractTpl, reqTpl } = s;
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
      assert(/\/2026\/0001$/.test(out.referenceNo), `first ref-no ends /2026/0001 (got ${out.referenceNo})`);
      assert(out.referenceNo.startsWith(`${TAG}/HR/`), 'ref-no uses the template refNoPrefix');
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
      assert(/\/2026\/0002$/.test(res2.body.referenceNo), 'second issue increments to /2026/0002');
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
      assert(res.body.referenceNo !== issuedRef && /\/2026\/000\d$/.test(res.body.referenceNo),
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

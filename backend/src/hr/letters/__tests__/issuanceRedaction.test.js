'use strict';

/*
 * issuanceRedaction.test.js — LIVE proof for the Letters read-path comp-masking /
 * IDOR review findings (Feature 9). Plain-node runner (no jest), same isolated
 * hr_test schema convention as issuance.service.test.js:
 *
 *   DATABASE_URL="$HR_URL" node src/hr/letters/__tests__/issuanceRedaction.test.js
 *   where $HR_URL = the repo .env DATABASE_URL with ?schema=hr_test.
 *
 * Proves:
 *   (1) A `canGenerateLetters`-only actor WITHOUT canViewCompensation (RANGE_ONLY)
 *       GET /:id on a salary letter issued by a comp-privileged issuer gets
 *       mergeDataJson comp.* MASKED ("••••") and NO renderedBody.
 *   (2) An ABSOLUTE actor (canViewCompensation) GET /:id gets the full figures +
 *       renderedBody intact (the snapshot itself is unchanged — masking is read-only).
 *   (3) register for a TEAM-scoped actor returns only in-scope employees' letters
 *       PLUS company-wide letters (employeeId == null) — never the whole tenant.
 *       The CSV branch is constrained identically.
 *   (4) A cross-tenant id ⇒ 404.
 *
 * A throwaway tenant is seeded with a comp-privileged issue of a SALARY_PROOF
 * letter (so mergeDataJson/renderedBody carry the absolute figures), then torn down.
 */

const { PDFDocument } = require('pdf-lib');

const prisma = require('../../../core/lib/prisma');
const service = require('../letters.service');
const controller = require('../controllers/issuance.controller');
const { MASK } = require('../mergeFields');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── Express res()/controller doubles (lifted from issuance.service.test.js) ────
function fakeRes() {
  return {
    statusCode: 200, body: undefined, headers: {}, sent: undefined,
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

const ISSUER_PERMS = { canGenerateLetters: true, canViewCompensation: true, canViewEmployees: true };

// An ABSOLUTE-visibility reader (HR-Admin band, holds canViewCompensation).
function absoluteUser(businessId) {
  return {
    id: 'absolute-reader', businessId, role: 'STAFF',
    businessRole: {
      name: 'HR-Admin', defaultScope: 'ALL',
      permissions: { canGenerateLetters: true, canViewCompensation: true },
    },
  };
}
// A maker-only reader: canGenerateLetters, NO canViewCompensation, RANGE_ONLY band.
function makerOnlyUser(businessId) {
  return {
    id: 'maker-only-reader', businessId, role: 'STAFF',
    businessRole: {
      name: 'LettersMaker', defaultScope: 'TEAM', compVisibility: 'RANGE_ONLY',
      permissions: { canGenerateLetters: true },
    },
  };
}

function reqFor({ user, scope, body, params, query }) {
  return {
    user, scope, // intentionally may be undefined (controller resolves it for register)
    body: body || {}, params: params || {}, query: query || {},
  };
}

const TAG = `ltredact_${Date.now()}`;

async function makeA4LetterheadDataUrl() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  const bytes = await doc.save();
  return `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function seed() {
  const biz = await prisma.business.create({
    data: { name: `Redact Co ${TAG}`, slug: `redact-${TAG}`, region: 'IN', country: 'IN' },
  });
  const businessId = biz.id;

  const entity = await prisma.entity.create({
    data: {
      businessId, code: `${TAG}-HQ`, legalName: 'Redact Co Pvt Ltd', tradeName: 'Redact Co',
      countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata',
      taxYearStartMonth: 4, activeFrom: new Date('2026-04-01'),
    },
  });

  // The subject of the salary letter (in the TEAM scope).
  const employee = await prisma.employee.create({
    data: {
      businessId, code: `${TAG}-E1`, firstName: 'Aarav', lastName: 'Sharma',
      workEmail: `aarav@${TAG}.test`, status: 'ACTIVE', hireDate: new Date('2024-01-15'),
    },
  });
  const comp = await prisma.compensationRevision.create({
    data: {
      businessId, employeeId: employee.id, entityId: entity.id, currencyCode: 'INR',
      basis: 'CTC', ctcAnnual: '1234567.00', grossMonthly: '98765.00',
      effectiveFrom: new Date('2024-01-15'), revisionReason: 'HIRE', isCurrent: true,
    },
  });
  await prisma.employee.update({ where: { id: employee.id }, data: { currentCompensationId: comp.id } });

  // An OUT-OF-SCOPE employee in the SAME tenant (gets their own letter → must NOT
  // appear in the TEAM-scoped register).
  const otherEmp = await prisma.employee.create({
    data: {
      businessId, code: `${TAG}-E2`, firstName: 'Out', lastName: 'OfScope',
      workEmail: `out@${TAG}.test`, status: 'ACTIVE', hireDate: new Date('2024-02-01'),
    },
  });

  const letterhead = await prisma.companyLetterhead.create({
    data: {
      businessId, code: `${TAG}-DEFAULT`, name: 'Default Letterhead',
      fileUrl: await makeA4LetterheadDataUrl(), fileHash: 'seedhash', mimeType: 'application/pdf',
      pageWidthPt: 595.28, pageHeightPt: 841.89,
      layoutJson: {
        writingArea: { x: 0.1, y: 0.3, w: 0.8, h: 0.5, fontSize: 11, lineGap: 4 },
        fields: { date: { x: 0.7, y: 0.18, w: 0.2, h: 0.03, align: 'right' }, refNo: { x: 0.1, y: 0.18, w: 0.4, h: 0.03 } },
        overflowPolicy: 'repeat-letterhead',
      },
      isDefault: true, isActive: true,
    },
  });

  // SALARY_PROOF template that bakes the absolute comp figures into the body.
  const salaryTpl = await prisma.letterTemplate.create({
    data: {
      businessId, entityId: entity.id, code: `${TAG}-SAL`, name: 'Salary Proof',
      category: 'SALARY_PROOF', countryCode: 'IN', locale: 'en-IN', subject: 'Salary Certificate',
      bodyMarkdown:
        'This is to certify that {{employee.name}} ({{employee.code}}) draws an annual CTC of '
        + '{{comp.ctcAnnual}} with a gross monthly of {{comp.grossMonthly}} at {{company.legalName}}.',
      defaultLetterheadId: letterhead.id, refNoPrefix: `${TAG}/SAL`,
      isSystem: false, isActive: true, version: 1,
    },
  });

  return { businessId, entity, employee, otherEmp, letterhead, salaryTpl };
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

const COMP_KEYS = ['comp.ctcAnnual', 'comp.basic', 'comp.hra', 'comp.grossMonthly', 'comp.netMonthly', 'comp.da', 'comp.specialAllowance'];

async function main() {
  log('\n=== Feature 9 — Letters read-path comp-masking / IDOR redaction ===\n');
  let s;
  try {
    s = await seed();
    const { businessId, employee, otherEmp, salaryTpl } = s;

    // Issue the salary letter with a COMP-PRIVILEGED issuer → snapshot carries the
    // ABSOLUTE figures in mergeDataJson + renderedBody.
    const issuer = { id: `${TAG}-issuer`, businessId, role: 'BUSINESS_ADMIN' };
    const issued = await service.issueLetter(prisma, {
      businessId, actorUserId: issuer.id, perms: ISSUER_PERMS,
      templateId: salaryTpl.id, employeeId: employee.id, mode: 'issue',
    });
    const issuedId = issued.issuedLetterId;

    // Sanity: the persisted snapshot really holds the absolute figure (else the
    // test would pass vacuously).
    const stored = await prisma.issuedLetter.findUnique({ where: { id: issuedId } });
    assert(stored && stored.mergeDataJson && /12,34,567/.test(String(stored.mergeDataJson['comp.ctcAnnual'])),
      'PRECHECK: persisted mergeDataJson holds the ABSOLUTE comp.ctcAnnual figure');
    assert(/12,34,567/.test(String(stored.renderedBody)),
      'PRECHECK: persisted renderedBody bakes the absolute figure into prose');

    // Also issue a COMPANY-WIDE letter (no subject employee) + an OUT-OF-SCOPE
    // letter, for the register-scope test.
    const companyWide = await service.issueLetter(prisma, {
      businessId, actorUserId: issuer.id, perms: ISSUER_PERMS,
      templateId: salaryTpl.id, employeeId: null, mode: 'issue',
    });
    const otherLetter = await service.issueLetter(prisma, {
      businessId, actorUserId: issuer.id, perms: ISSUER_PERMS,
      templateId: salaryTpl.id, employeeId: otherEmp.id, mode: 'issue',
    });

    // ── (1) maker-only (RANGE_ONLY) GET /:id ⇒ comp.* masked + NO renderedBody ──
    log('(1) maker-only (RANGE_ONLY) GET /:id is masked:');
    {
      const res = await callController(controller.getOne, reqFor({
        user: makerOnlyUser(businessId), scope: { kind: 'ALL' }, params: { id: issuedId },
      }));
      assert(res.statusCode === 200, 'GET /:id → 200 (in-scope/tenant)');
      const md = res.body && res.body.mergeDataJson;
      assert(md && COMP_KEYS.every((k) => !(k in md) || md[k] === MASK),
        'every comp.* key in mergeDataJson is MASKED ("••••")');
      assert(md && md['comp.ctcAnnual'] === MASK, 'comp.ctcAnnual specifically masked');
      assert(md && !/12,34,567/.test(JSON.stringify(md)), 'NO absolute figure anywhere in mergeDataJson');
      assert(!('renderedBody' in (res.body || {})), 'renderedBody OMITTED for the non-comp viewer');
      assert(md && md['employee.name'] === 'Aarav Sharma', 'non-comp fields (employee.name) preserved');
      assert(res.body && res.body.referenceNo, 'metadata (referenceNo) still present');
    }

    // ── (2) ABSOLUTE actor GET /:id ⇒ full figures + renderedBody intact ────────
    log('(2) ABSOLUTE actor GET /:id sees full figures:');
    {
      const res = await callController(controller.getOne, reqFor({
        user: absoluteUser(businessId), scope: { kind: 'ALL' }, params: { id: issuedId },
      }));
      assert(res.statusCode === 200, 'GET /:id → 200');
      const md = res.body && res.body.mergeDataJson;
      assert(md && /12,34,567/.test(String(md['comp.ctcAnnual'])), 'comp.ctcAnnual shows the absolute figure');
      assert('renderedBody' in (res.body || {}) && /12,34,567/.test(String(res.body.renderedBody)),
        'renderedBody present + carries the absolute figure');
    }

    // ── (2b) the stored snapshot is UNCHANGED (masking is read-only) ────────────
    {
      const after = await prisma.issuedLetter.findUnique({ where: { id: issuedId } });
      assert(/12,34,567/.test(String(after.mergeDataJson['comp.ctcAnnual'])) && /12,34,567/.test(String(after.renderedBody)),
        'persisted snapshot UNCHANGED after both reads (redaction is read-only)');
    }

    // ── (3) register for a TEAM-scoped actor ⇒ in-scope + company-wide only ─────
    log('(3) TEAM-scoped register excludes out-of-scope employees:');
    {
      const teamScope = { kind: 'IDS', ids: new Set([employee.id]) };
      const res = await callController(controller.register, reqFor({
        user: makerOnlyUser(businessId), scope: teamScope, query: {},
      }));
      assert(res.statusCode === 200, 'register → 200');
      const ids = (res.body.items || []).map((r) => r.id);
      assert(ids.includes(issuedId), 'in-scope employee letter IS present');
      assert(ids.includes(companyWide.issuedLetterId), 'company-wide (employeeId=null) letter IS present');
      assert(!ids.includes(otherLetter.issuedLetterId), 'out-of-scope employee letter is NOT present');
      assert((res.body.items || []).every((r) => !r.employee || r.employee.id === employee.id),
        'no row carries an out-of-scope subject employee');

      // CSV branch is constrained identically.
      const csv = await callController(controller.register, reqFor({
        user: makerOnlyUser(businessId), scope: teamScope, query: { format: 'csv' },
      }));
      assert(csv.headers['content-type'].startsWith('text/csv'), 'CSV export Content-Type text/csv');
      assert(/Aarav/.test(csv.sent) && !/OfScope/.test(csv.sent), 'CSV includes in-scope, excludes out-of-scope subject');
    }

    // ── (3b) ALL-scoped register still sees everything ─────────────────────────
    {
      const res = await callController(controller.register, reqFor({
        user: absoluteUser(businessId), scope: { kind: 'ALL' }, query: {},
      }));
      const ids = (res.body.items || []).map((r) => r.id);
      assert(ids.includes(otherLetter.issuedLetterId) && ids.includes(issuedId),
        'ALL-scoped register sees both in- and out-of-scope letters');
    }

    // ── (4) cross-tenant id ⇒ 404 ──────────────────────────────────────────────
    log('(4) cross-tenant id ⇒ 404:');
    {
      const otherTenantUser = { ...absoluteUser(`${businessId}-nope`) };
      const res = await callController(controller.getOne, reqFor({
        user: otherTenantUser, scope: { kind: 'ALL' }, params: { id: issuedId },
      }));
      assert(res.statusCode === 404, 'GET /:id for a different tenant → 404');
    }
  } catch (err) {
    failures += 1;
    log('  CRASH ', err && err.stack ? err.stack : err);
  } finally {
    if (s) await cleanup(s.businessId);
  }

  log(`\n=== ${failures === 0 ? 'ALL REDACTION CHECKS PASSED' : `${failures} REDACTION CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('redaction test crashed:', err);
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});

'use strict';

/*
 * requestLoop.test.js — LIVE hr_test proof of the Letters request→issue→download
 * loop overhaul (Feature 9 Letters module overhaul). Plain-node runner (no jest),
 * same isolated hr_test schema convention as the sibling letters tests:
 *
 *   DATABASE_URL="$HR_URL" node src/hr/letters/__tests__/requestLoop.test.js
 *   where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'.
 *
 * Proves the loop that was BROKEN (employee requested, nobody could see it,
 * employee couldn't get the letter):
 *   (1) employee POSTs a letter request → ESS GET /me/letters/requests shows it
 *       PENDING (self-only; another employee's request never appears);
 *   (2) admin GET /api/hr/letters/requests shows the OPEN request in the queue +
 *       GET /requests/count returns the badge count;
 *   (3) admin issues with documentRequestId → the fulfilment hook links the letter,
 *       sets generatedDocumentId, advances status;
 *   (4) ESS GET /me/letters/requests now shows the request FULFILLED with a
 *       downloadable letterId; ESS GET /me/letters/:id/download streams the PDF;
 *   (5) the admin queue no longer lists the fulfilled request and the count drops;
 *   (6) India-first template filter: GET /templates returns IN + market-agnostic
 *       templates but NEVER the NZ template.
 */

const { PDFDocument } = require('pdf-lib');

const prisma = require('../../../core/lib/prisma');
const service = require('../letters.service');
const issuanceController = require('../controllers/issuance.controller');
const templatesController = require('../controllers/templates.controller');
const meLetters = require('../controllers/meLetters.controller');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── Express res/controller doubles (mirror the sibling tests) ────────────────
function fakeRes() {
  return {
    statusCode: 200, body: undefined, headers: {}, sent: undefined, redirectedTo: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(p) { this.body = p; this.sent = p; this._done && this._done(); return this; },
    send(p) { this.body = p; this.sent = p; this._done && this._done(); return this; },
    redirect(u) { this.redirectedTo = u; this.statusCode = 302; this._done && this._done(); return this; },
    end() { this._done && this._done(); return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    res._done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return res._done(); };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const ALL_PERMS = { canGenerateLetters: true, canManageLetters: true, canViewCompensation: true, canViewEmployees: true };
const ALL_SCOPE = { kind: 'ALL', ids: new Set() };
function adminReq({ user, scope, body, params, query }) {
  return { user, scope: scope || ALL_SCOPE, body: body || {}, params: params || {}, query: query || {} };
}
function essReq({ customer, params, body }) {
  return { customer, params: params || {}, body: body || {} };
}

const TAG = `ltreq_${Date.now()}`;

async function a4DataUrl() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return `data:application/pdf;base64,${Buffer.from(await doc.save()).toString('base64')}`;
}

async function seed() {
  const biz = await prisma.business.create({
    data: { name: `ReqLoop ${TAG}`, slug: `reqloop-${TAG}`, region: 'IN', country: 'IN', email: `hr@${TAG}.test` },
  });
  const businessId = biz.id;
  const entity = await prisma.entity.create({
    data: {
      businessId, code: `${TAG}-HQ`, legalName: 'ReqLoop Pvt Ltd', tradeName: 'ReqLoop',
      countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata',
      taxYearStartMonth: 4, activeFrom: new Date('2026-04-01'),
    },
  });
  const employee = await prisma.employee.create({
    data: {
      businessId, code: `${TAG}-E1`, firstName: 'Asha', lastName: 'Rao',
      workEmail: `asha@${TAG}.test`, status: 'ACTIVE', hireDate: new Date('2022-01-10'),
    },
  });
  const other = await prisma.employee.create({
    data: {
      businessId, code: `${TAG}-E2`, firstName: 'Other', lastName: 'Person',
      workEmail: `other@${TAG}.test`, status: 'ACTIVE', hireDate: new Date('2023-02-01'),
    },
  });
  const letterhead = await prisma.companyLetterhead.create({
    data: {
      businessId, code: `${TAG}-LH`, name: 'Default LH', fileUrl: await a4DataUrl(),
      fileHash: 'seedhash', mimeType: 'application/pdf', pageWidthPt: 595.28, pageHeightPt: 841.89,
      layoutJson: {}, // EMPTY layout → exercises the default-writing-area path
      isDefault: true, isActive: true,
    },
  });
  // IN template (EXPERIENCE).
  const tplIN = await prisma.letterTemplate.create({
    data: {
      businessId, entityId: entity.id, code: `${TAG}-EXP-IN`, name: 'Experience Certificate IN',
      category: 'EXPERIENCE', countryCode: 'IN', locale: 'en-IN', subject: 'Experience Certificate',
      bodyMarkdown: 'This certifies {{employee.name}} ({{employee.code}}) of {{company.legalName}}.',
      mergeFieldsJson: { 'employee.name': { type: 'string', required: true } },
      defaultLetterheadId: letterhead.id, refNoPrefix: `${TAG}/HR`, isActive: true, version: 1,
    },
  });
  // NZ template — MUST NOT surface for this India tenant.
  const tplNZ = await prisma.letterTemplate.create({
    data: {
      businessId, entityId: entity.id, code: `${TAG}-EXP-NZ`, name: 'Service Letter NZ',
      category: 'EXPERIENCE', countryCode: 'NZ', locale: 'en-NZ', subject: 'Statement of Service',
      bodyMarkdown: 'This certifies {{employee.name}}.',
      defaultLetterheadId: letterhead.id, refNoPrefix: `${TAG}/NZ`, isActive: true, version: 1,
    },
  });
  // Market-agnostic template (countryCode null) — SHOULD surface.
  const tplANY = await prisma.letterTemplate.create({
    data: {
      businessId, entityId: entity.id, code: `${TAG}-ANY`, name: 'Generic Letter',
      category: 'CUSTOM', countryCode: null, subject: 'Letter',
      bodyMarkdown: 'Dear {{employee.name}}.',
      defaultLetterheadId: letterhead.id, refNoPrefix: `${TAG}/GEN`, isActive: true, version: 1,
    },
  });
  return { businessId, entity, employee, other, letterhead, tplIN, tplNZ, tplANY };
}

async function cleanup(businessId) {
  if (!businessId) return;
  await prisma.issuedLetter.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.documentRequest.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.employeeDocument.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.letterTemplate.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.companyLetterhead.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.numberSequence.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.entity.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.business.delete({ where: { id: businessId } }).catch(() => {});
}

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-';
}
function asItems(body) {
  return Array.isArray(body) ? body : (body && body.items) || [];
}

async function main() {
  log('\n=== Letters request→issue→download loop + count + India-first filter ===\n');
  let s;
  try {
    s = await seed();
    const { businessId, employee, other, tplIN, tplNZ, tplANY } = s;
    const adminUser = { id: `${TAG}-admin`, businessId, role: 'BUSINESS_ADMIN' };
    const customer = { businessId, email: employee.workEmail };
    const otherCustomer = { businessId, email: other.workEmail };

    // ── (1) employee requests a letter → ESS /requests shows it PENDING ───────
    log('(1) employee request → ESS sees it pending:');
    const createRes = await callController(meLetters.createLetterRequest, essReq({
      customer, body: { templateKind: 'EXPERIENCE_LETTER', purpose: 'For a bank loan' },
    }));
    assert(createRes.statusCode === 201, 'create request → 201');
    const requestId = createRes.body && createRes.body.id;
    assert(!!requestId, 'request id returned');

    // a second, OTHER employee's request (must never appear in `employee`'s ESS list)
    await prisma.documentRequest.create({
      data: { businessId, employeeId: other.id, templateKind: 'SALARY_CERTIFICATE', status: 'PENDING' },
    });

    const essList1 = await callController(meLetters.listMyLetterRequests, essReq({ customer }));
    const essItems1 = asItems(essList1.body);
    assert(essList1.statusCode === 200, 'ESS /requests → 200');
    assert(essItems1.length === 1, 'ESS /requests returns exactly the caller OWN request');
    assert(essItems1[0].id === requestId, 'ESS /requests row is the right request');
    assert(essItems1[0].status === 'PENDING', 'ESS request status PENDING');
    assert(essItems1[0].letterId === null, 'ESS request not yet downloadable (no letterId)');
    assert(essItems1[0].templateKindLabel === 'Experience Certificate', 'ESS request label humanized');

    // ── (2) admin queue + count see the OPEN request ──────────────────────────
    log('(2) admin queue + count:');
    const queue1 = await callController(issuanceController.requestsQueue, adminReq({ user: adminUser }));
    const queueItems1 = asItems(queue1.body);
    assert(queue1.statusCode === 200, 'admin /requests → 200');
    assert(queueItems1.some((r) => r.id === requestId), 'admin queue lists the employee request');
    assert(
      queueItems1.find((r) => r.id === requestId).employee.name === 'Asha Rao',
      'admin queue row carries the employee name'
    );
    const count1 = await callController(issuanceController.requestsCount, adminReq({ user: adminUser }));
    assert(count1.body.count === 2, 'admin /requests/count = 2 (both open requests)');

    // ── (3) admin issues against the request → fulfilment hook fires ──────────
    log('(3) admin issues with documentRequestId → fulfils:');
    const issueRes = await callController(issuanceController.issue, adminReq({
      user: adminUser,
      body: { templateId: tplIN.id, employeeId: employee.id, documentRequestId: requestId },
    }));
    assert(issueRes.statusCode === 201, 'issue → 201');
    const issuedLetterId = issueRes.body && issueRes.body.issuedLetterId;
    assert(!!issuedLetterId, 'issued letter id returned');

    const reqRow = await prisma.documentRequest.findUnique({ where: { id: requestId } });
    assert(!!reqRow.generatedDocumentId, 'request.generatedDocumentId set (fulfilment signal)');
    const letterRow = await prisma.issuedLetter.findUnique({ where: { id: issuedLetterId } });
    assert(letterRow.documentRequestId === requestId, 'IssuedLetter back-links the request');
    assert(isPdf(Buffer.from(letterRow.fileUrl.split('base64,')[1], 'base64')), 'issued PDF is a real %PDF');

    // ── (4) ESS now shows it FULFILLED + downloadable; download streams PDF ────
    log('(4) ESS sees it fulfilled + can download:');
    const essList2 = await callController(meLetters.listMyLetterRequests, essReq({ customer }));
    const row2 = asItems(essList2.body).find((r) => r.id === requestId);
    assert(row2 && row2.status === 'FULFILLED', 'ESS request now FULFILLED');
    assert(row2 && row2.letterId === issuedLetterId, 'ESS request exposes the downloadable letterId');
    assert(!!row2.referenceNo, 'ESS fulfilled request carries the reference no');

    const dl = await callController(meLetters.downloadMyLetter, essReq({ customer, params: { id: row2.letterId } }));
    assert(dl.statusCode === 200, 'ESS download → 200');
    assert(dl.headers['content-type'] === 'application/pdf', 'ESS download is application/pdf');
    assert(isPdf(dl.sent), 'ESS download streamed a %PDF buffer');

    // the OTHER employee still cannot see this request (self-only)
    const essOther = await callController(meLetters.listMyLetterRequests, essReq({ customer: otherCustomer }));
    assert(
      !asItems(essOther.body).some((r) => r.id === requestId),
      "other employee's ESS never shows the first employee's request"
    );

    // ── (5) admin queue no longer lists it; count drops ───────────────────────
    log('(5) admin queue drops the fulfilled request:');
    const queue2 = await callController(issuanceController.requestsQueue, adminReq({ user: adminUser }));
    assert(!asItems(queue2.body).some((r) => r.id === requestId), 'fulfilled request gone from admin queue');
    const count2 = await callController(issuanceController.requestsCount, adminReq({ user: adminUser }));
    assert(count2.body.count === 1, 'admin /requests/count dropped to 1');

    // ── (6) India-first template filter ───────────────────────────────────────
    log('(6) India-first template filter:');
    const tplRes = await callController(templatesController.listTemplates, adminReq({ user: adminUser }));
    const codes = asItems(tplRes.body).map((t) => t.code);
    assert(codes.includes(tplIN.code), 'IN tenant sees the IN template');
    assert(codes.includes(tplANY.code), 'IN tenant sees the market-agnostic template');
    assert(!codes.includes(tplNZ.code), 'IN tenant NEVER sees the NZ template');
    // explicit ?country=ALL opt-out shows everything (management view)
    const tplAll = await callController(templatesController.listTemplates, adminReq({ user: adminUser, query: { country: 'ALL' } }));
    assert(asItems(tplAll.body).map((t) => t.code).includes(tplNZ.code), '?country=ALL surfaces the NZ template (opt-out)');

    log('');
    if (failures === 0) log('=== ALL REQUEST-LOOP CHECKS PASSED ===\n');
    else log(`=== ${failures} CHECK(S) FAILED ===\n`);
  } catch (e) {
    failures += 1;
    console.error('CRASH:', e && e.stack);
  } finally {
    await cleanup(s && s.businessId);
    await prisma.$disconnect();
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main();

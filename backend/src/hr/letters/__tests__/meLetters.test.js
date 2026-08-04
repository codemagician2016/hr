'use strict';

/**
 * meLetters.test.js — LIVE hr_test test for the ESS "My Letters" controller
 * (Feature 09 slice 9F). Proves the §4.5 ESS contract:
 *
 *   GET  /                 → own ISSUED, non-voided letters only; fileHash present;
 *                            another employee's / a voided / a draft letter never appears.
 *   GET  /:id/download     → self-only PDF stream (200, application/pdf); another
 *                            employee's letter id ⇒ 404 (IDOR-safe, never 403).
 *   POST /requests         → creates a DocumentRequest (PENDING).
 *   fulfilLetterRequest    → links IssuedLetter ↔ DocumentRequest + sets
 *                            generatedDocumentId + advances status.
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/letters/__tests__/meLetters.test.js
 *   where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const assert = require('assert');

function log(...a) { console.log(...a); }
let PASS = 0;
function ok(cond, msg) { assert(cond, msg); PASS += 1; log('  ✓', msg); }
function eq(a, b, msg) { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); PASS += 1; log('  ✓', msg); }

// Minimal Express res double (mirrors offboarding.test.js fakeRes) that also
// captures res.send / headers for the PDF-stream assertions.
function fakeRes() {
  return {
    statusCode: 200, body: undefined, sent: undefined, headers: {}, redirectedTo: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; this._done && this._done(); return this; },
    send(p) { this.sent = p; this._done && this._done(); return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    redirect(u) { this.redirectedTo = u; this.statusCode = 302; this._done && this._done(); return this; },
    end() { this._done && this._done(); return this; },
  };
}
function callController(handler, req) {
  // Express ALWAYS gives a handler a `req.query` object, so controllers read
  // req.query.page directly and are right to. This fake req did not, so the very
  // first paginated read threw "Cannot read properties of undefined" and the
  // whole suite died — a harness gap reported as a product failure. Default it
  // here rather than at every call site.
  req = { query: {}, ...req };
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    res._done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } res._done(); };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'LTR9F-TEST';

async function main() {
  if (!process.env.DATABASE_URL) {
    log('[skip] meLetters.test — DATABASE_URL not set (needs the LIVE hr_test schema).');
    return;
  }
  const prisma = require('../../../core/lib/prisma');
  const c = require('../controllers/meLetters.controller');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const empIds = emps.map((e) => e.id);
    if (empIds.length) {
      await prisma.issuedLetter.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.documentRequest.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.employeeDocument.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    }
  }

  await cleanup();
  log('\n=== meLetters.test — LIVE hr_test (ESS My Letters) ===\n');

  try {
    // ── Two employees: ALICE (subject) + BOB (the "other" for the IDOR check) ──
    const alice = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-ALICE`, firstName: 'Alice', lastName: 'A', status: 'ACTIVE', isActive: true, workEmail: `${PREFIX}-alice@example.com`.toLowerCase() },
    });
    const bob = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-BOB`, firstName: 'Bob', lastName: 'B', status: 'ACTIVE', isActive: true, workEmail: `${PREFIX}-bob@example.com`.toLowerCase() },
    });
    log(`0) seeded ALICE(${alice.id}) + BOB(${bob.id})`);

    const PDF_DATA_URL = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test letter').toString('base64')}`;

    // Alice: one ISSUED letter (the one she should see + download)
    const aliceLetter = await prisma.issuedLetter.create({
      data: {
        businessId, employeeId: alice.id, referenceNo: `${PREFIX}/2026/0001`, category: 'EXPERIENCE',
        renderedBody: 'Experience certificate body', mergeDataJson: {}, status: 'ISSUED',
        issuedBy: 'test-issuer', issuedAt: new Date(),
        fileUrl: PDF_DATA_URL, fileHash: 'a'.repeat(64), mimeType: 'application/pdf', sizeBytes: 20, subject: 'Experience Certificate',
      },
    });
    // Alice: a VOIDED letter (must NOT appear in the list)
    await prisma.issuedLetter.create({
      data: {
        businessId, employeeId: alice.id, referenceNo: `${PREFIX}/2026/0002`, category: 'BONAFIDE',
        renderedBody: 'voided', mergeDataJson: {}, status: 'VOIDED', issuedBy: 'test-issuer', issuedAt: new Date(),
        voidedAt: new Date(), voidReason: 'superseded', fileUrl: PDF_DATA_URL, fileHash: 'b'.repeat(64),
      },
    });
    // Alice: a DRAFT letter (must NOT appear in the list)
    await prisma.issuedLetter.create({
      data: {
        businessId, employeeId: alice.id, referenceNo: `${PREFIX}/2026/0003`, category: 'SALARY_PROOF',
        renderedBody: 'draft', mergeDataJson: {}, status: 'DRAFT', issuedBy: 'test-issuer', fileUrl: PDF_DATA_URL,
      },
    });
    // Bob: his own ISSUED letter (the IDOR target — Alice must get 404 on it)
    const bobLetter = await prisma.issuedLetter.create({
      data: {
        businessId, employeeId: bob.id, referenceNo: `${PREFIX}/2026/0004`, category: 'EXPERIENCE',
        renderedBody: "Bob's letter", mergeDataJson: {}, status: 'ISSUED', issuedBy: 'test-issuer', issuedAt: new Date(),
        fileUrl: PDF_DATA_URL, fileHash: 'c'.repeat(64),
      },
    });
    log('1) seeded letters: Alice ISSUED+VOIDED+DRAFT, Bob ISSUED');

    const aliceReq = { customer: { businessId, email: alice.workEmail }, params: {}, body: {} };

    // ── T1: GET / lists only Alice's ISSUED non-voided letter, fileHash present ──
    {
      const res = await callController(c.listMyLetters, aliceReq);
      eq(res.statusCode, 200, 'T1 list → 200');
      const ids = (res.body.items || []).map((l) => l.id);
      eq(res.body.items.length, 1, 'T1 list returns exactly ONE letter (ISSUED, non-voided)');
      ok(ids.includes(aliceLetter.id), 'T1 list includes Alice ISSUED letter');
      ok(!ids.includes(bobLetter.id), "T1 list EXCLUDES Bob's letter");
      ok(res.body.items[0].fileHash === 'a'.repeat(64), 'T1 fileHash (tamper badge anchor) is present');
      ok(res.body.items.every((l) => l.status === 'ISSUED'), 'T1 no DRAFT/VOIDED leak into the list');
    }

    // ── T2: download OWN letter → 200 application/pdf buffer ────────────────────
    {
      const res = await callController(c.downloadMyLetter, { ...aliceReq, params: { id: aliceLetter.id } });
      eq(res.statusCode, 200, 'T2 own download → 200');
      eq(res.headers['content-type'], 'application/pdf', 'T2 content-type application/pdf');
      ok(Buffer.isBuffer(res.sent) && res.sent.length > 0, 'T2 streamed a non-empty PDF buffer');
      ok(String(res.headers['content-disposition'] || '').includes('attachment'), 'T2 attachment disposition');
    }

    // ── T3: download ANOTHER employee's letter → 404 (IDOR-safe, not 403) ───────
    {
      const res = await callController(c.downloadMyLetter, { ...aliceReq, params: { id: bobLetter.id } });
      eq(res.statusCode, 404, "T3 download Bob's letter as Alice → 404 (out-of-band)");
      ok(res.redirectedTo === undefined && res.sent === undefined, 'T3 no body/redirect leaked for the foreign letter');
    }

    // ── T3b: download a VOIDED own letter → 404 (only ISSUED non-voided stream) ──
    {
      const voided = await prisma.issuedLetter.findFirst({ where: { businessId, employeeId: alice.id, status: 'VOIDED' } });
      const res = await callController(c.downloadMyLetter, { ...aliceReq, params: { id: voided.id } });
      eq(res.statusCode, 404, 'T3b download own VOIDED letter → 404');
    }

    // ── T4: POST /requests creates a DocumentRequest (PENDING) ──────────────────
    {
      const res = await callController(c.createLetterRequest, {
        customer: { businessId, email: alice.workEmail }, params: {},
        body: { templateKind: 'SALARY_CERTIFICATE', purpose: 'bank loan' },
      });
      eq(res.statusCode, 201, 'T4 create request → 201');
      eq(res.body.templateKind, 'SALARY_CERTIFICATE', 'T4 templateKind echoed');
      eq(res.body.status, 'PENDING', 'T4 status PENDING');
      const row = await prisma.documentRequest.findFirst({ where: { businessId, employeeId: alice.id } });
      ok(row && row.purpose === 'bank loan', 'T4 DocumentRequest persisted with purpose');
    }

    // ── T4b: invalid templateKind → 422 ─────────────────────────────────────────
    {
      const res = await callController(c.createLetterRequest, {
        customer: { businessId, email: alice.workEmail }, params: {}, body: { templateKind: 'NOPE' },
      });
      eq(res.statusCode, 422, 'T4b invalid templateKind → 422');
    }

    // ── T5: fulfilment hook links request ↔ letter + sets generatedDocumentId ───
    {
      const empDoc = await prisma.employeeDocument.create({
        data: { businessId, employeeId: alice.id, category: 'EXPERIENCE', name: 'Fulfilled letter', fileUrl: PDF_DATA_URL, fileHash: 'd'.repeat(64), mimeType: 'application/pdf', visibility: 'EMPLOYEE_VISIBLE', signatureStatus: 'NOT_REQUIRED' },
      });
      const request = await prisma.documentRequest.findFirst({ where: { businessId, employeeId: alice.id, status: 'PENDING' } });
      const out = await c.fulfilLetterRequest(prisma, {
        businessId, documentRequestId: request.id, issuedLetterId: aliceLetter.id,
        employeeDocumentId: empDoc.id, employeeId: alice.id,
      });
      ok(out.fulfilled === true, 'T5 fulfilment hook reports fulfilled');
      const updated = await prisma.documentRequest.findFirst({ where: { id: request.id } });
      eq(updated.generatedDocumentId, empDoc.id, 'T5 DocumentRequest.generatedDocumentId set to the EmployeeDocument');
      eq(updated.status, c.FULFILLED_REQUEST_STATUS, `T5 DocumentRequest.status advanced to ${c.FULFILLED_REQUEST_STATUS}`);
      const linkedLetter = await prisma.issuedLetter.findFirst({ where: { id: aliceLetter.id } });
      eq(linkedLetter.documentRequestId, request.id, 'T5 IssuedLetter.documentRequestId back-links the request');
    }

    // ── T6: a customer with NO linked employee gets an empty list / 404 download ─
    {
      const stranger = { customer: { businessId, email: 'nobody-linked@example.com' }, params: {}, body: {} };
      const list = await callController(c.listMyLetters, stranger);
      eq(list.body.items.length, 0, 'T6 unlinked customer → empty list');
      const dl = await callController(c.downloadMyLetter, { ...stranger, params: { id: aliceLetter.id } });
      eq(dl.statusCode, 404, 'T6 unlinked customer download → 404');
    }

    log(`\nALL ESS My-Letters assertions passed (${PASS} checks).`);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });

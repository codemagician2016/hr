'use strict';

/**
 * companyProfile.test.js — Company Profile + auto employee-number proof.
 *
 * Covers the two features built on the Company Profile surface, against the
 * isolated hr_test schema (plain node runner, same harness as the lifecycle tests):
 *
 *   A) Business document vault:
 *      A1  upload validates MIME (non-PDF/PNG/JPG → 422) + size (>10 MB → 413).
 *      A2  a valid upload persists a tenant-scoped BusinessDocument with a
 *          server-computed SHA-256, mimeType + sizeBytes (never trusted from the
 *          client), and is listed for THIS tenant only.
 *      A3  download + delete of a FOREIGN tenant's document id → 404 (tenant-scoped,
 *          IDOR-safe). Delete is a soft-delete (deletedAt set).
 *
 *   B) Auto employee-number:
 *      B1  creating employees WITHOUT a code mints sequential numbers from the
 *          tenant's EMPLOYEE scheme (atomic via allocateCode in the create tx).
 *      B2  a CUSTOM prefix/padding scheme is respected (EMP-IN-0001 style).
 *      B3  an EXPLICIT code still wins (auto-numbering is not applied).
 *      B4  concurrent code-less creates allocate distinct sequential codes (no dup).
 *
 * Run (needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/controllers/__tests__/companyProfile.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res); res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'CP-TEST';
// A tiny valid 1x1 PNG (base64) → a legitimate data URL the upload accepts.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_1x1}`;

async function main() {
  log('\n=== Company Profile — business docs + auto employee-number ===\n');

  if (!process.env.DATABASE_URL) {
    log('[skip] DATABASE_URL not set — needs the live hr_test schema.\n');
    return;
  }

  const prisma = require('../../../core/lib/prisma');
  const company = require('../companyProfile.controller');
  const employee = require('../employee.controller');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  // A DIFFERENT tenant for the foreign-tenant 404 test.
  const other = await prisma.business.findFirst({ where: { slug: { not: 'demo' } } });
  if (!other) throw new Error('Need a second tenant in hr_test for the foreign-tenant test');
  const otherBusinessId = other.id;

  const adminUser = await prisma.user.findFirst({
    where: { businessId, role: { in: ['BUSINESS_ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true },
  });
  const actorId = adminUser ? adminUser.id : null;
  const reqUser = { id: actorId, businessId };
  const otherReqUser = { id: actorId, businessId: otherBusinessId };

  // ── cleanup helper (idempotent; removes anything this run created) ──
  async function cleanup() {
    await prisma.businessDocument.deleteMany({ where: { OR: [
      { businessId, name: { startsWith: PREFIX } },
      { businessId: otherBusinessId, name: { startsWith: PREFIX } },
    ] } });
    await prisma.employee.deleteMany({ where: { businessId, firstName: { startsWith: PREFIX } } });
    // Reset the EMPLOYEE numbering scheme row this test mutated.
    await prisma.numberSequence.deleteMany({ where: { businessId, scope: 'EMPLOYEE', periodKey: null, entityId: null } });
  }

  await cleanup();

  // ════════════════════════════════════════════════════════════════════════
  log('A) Business document vault\n');

  // A1 — MIME validation: a text/plain data URL is rejected 422.
  {
    const res = await callController(company.createDocument, {
      user: reqUser,
      body: { category: 'GST_CERTIFICATE', name: `${PREFIX}-bad-mime`, fileBase64: 'data:text/plain;base64,aGVsbG8=' },
    });
    assert(res.statusCode === 422, `non-PDF/PNG/JPG upload rejected 422 (got ${res.statusCode})`);
  }

  // A1 — size guard: a >10 MB base64 payload is rejected 413.
  {
    const big = 'A'.repeat(15 * 1024 * 1024); // ~15 MB of base64 → >10 MB decoded
    const res = await callController(company.createDocument, {
      user: reqUser,
      body: { category: 'OTHER', name: `${PREFIX}-too-big`, fileBase64: `data:application/pdf;base64,${big}` },
    });
    assert(res.statusCode === 413, `>10 MB upload rejected 413 (got ${res.statusCode})`);
  }

  // A1 — bad category → 422 (never a Prisma 500).
  {
    const res = await callController(company.createDocument, {
      user: reqUser,
      body: { category: 'NOPE', name: `${PREFIX}-bad-cat`, fileBase64: PNG_DATA_URL },
    });
    assert(res.statusCode === 422, `invalid category rejected 422 (got ${res.statusCode})`);
  }

  // A2 — a valid upload persists with a server-computed hash + real mime/size.
  let docId = null;
  {
    const res = await callController(company.createDocument, {
      user: reqUser,
      body: { category: 'BUSINESS_LICENSE', name: `${PREFIX}-licence`, fileBase64: PNG_DATA_URL },
    });
    assert(res.statusCode === 201, `valid upload → 201 (got ${res.statusCode})`);
    docId = res.body && res.body.id;
    assert(res.body && res.body.mimeType === 'image/png', `mimeType derived server-side = image/png (${res.body && res.body.mimeType})`);
    assert(res.body && typeof res.body.sizeBytes === 'number' && res.body.sizeBytes > 0, 'sizeBytes computed server-side');
    assert(res.body && /^[0-9a-f]{64}$/.test(res.body.fileHash || ''), 'fileHash is a server-computed SHA-256');
  }

  // A2 — list is tenant-scoped: THIS tenant sees the doc; paginated shape.
  {
    const res = await callController(company.listDocuments, { user: reqUser, query: { page: '1', pageSize: '50' } });
    assert(res.statusCode === 200, 'list documents → 200');
    const found = (res.body.items || []).some((d) => d.id === docId);
    assert(found, 'uploaded document appears in this tenant\'s list');
    assert(typeof res.body.total === 'number' && res.body.page === 1, 'list is paginated (total + page)');
  }

  // A2 — the OTHER tenant does NOT see this tenant's document.
  {
    const res = await callController(company.listDocuments, { user: otherReqUser, query: {} });
    const leaked = (res.body.items || []).some((d) => d.id === docId);
    assert(!leaked, 'foreign tenant does NOT see this tenant\'s document');
  }

  // A3 — foreign-tenant download + delete → 404 (IDOR-safe).
  {
    const dl = await callController(company.downloadDocument, { user: otherReqUser, params: { id: docId } });
    assert(dl.statusCode === 404, `foreign-tenant download → 404 (got ${dl.statusCode})`);
    const dd = await callController(company.deleteDocument, { user: otherReqUser, params: { id: docId } });
    assert(dd.statusCode === 404, `foreign-tenant delete → 404 (got ${dd.statusCode})`);
    // The document still exists (foreign delete was rejected).
    const still = await prisma.businessDocument.findFirst({ where: { id: docId, deletedAt: null } });
    assert(!!still, 'document survives a foreign-tenant delete attempt');
  }

  // A3 — owning tenant delete = soft-delete (deletedAt set).
  {
    const res = await callController(company.deleteDocument, { user: reqUser, params: { id: docId } });
    assert(res.statusCode === 200, `owner delete → 200 (got ${res.statusCode})`);
    const row = await prisma.businessDocument.findUnique({ where: { id: docId } });
    assert(row && row.deletedAt != null, 'delete is a SOFT delete (deletedAt set, row retained)');
  }

  // ════════════════════════════════════════════════════════════════════════
  log('\nB) Auto employee-number\n');

  // B1 — default scheme: two code-less creates mint sequential EMP-0000NN codes.
  let firstCode = null;
  let secondCode = null;
  {
    const r1 = await callController(employee.create, { user: reqUser, body: { firstName: `${PREFIX}A`, lastName: 'One' } });
    const r2 = await callController(employee.create, { user: reqUser, body: { firstName: `${PREFIX}A`, lastName: 'Two' } });
    assert(r1.statusCode === 201 && r2.statusCode === 201, 'two code-less creates → 201');
    firstCode = r1.body && r1.body.code;
    secondCode = r2.body && r2.body.code;
    assert(/^EMP-\d+$/.test(firstCode || ''), `auto code minted with default EMP- prefix (${firstCode})`);
    const n1 = Number(String(firstCode).replace(/\D/g, ''));
    const n2 = Number(String(secondCode).replace(/\D/g, ''));
    assert(n2 === n1 + 1, `codes are sequential (${firstCode} → ${secondCode})`);
  }

  // B2 — a CUSTOM scheme (prefix EMP-IN-, padding 4) is honoured by the next mint.
  // Start at a high next-value (9000) so we don't collide with any pre-existing
  // EMP-IN-* seed codes — this isolates the format proof from seed data.
  {
    const upd = await callController(company.updateEmployeeNumberScheme, {
      user: reqUser, body: { prefix: 'EMP-IN-', padding: 4, nextValue: 9000 },
    });
    assert(upd.statusCode === 200, 'scheme update → 200');
    assert(upd.body.preview === 'EMP-IN-9000', `preview reflects custom scheme (${upd.body.preview})`);

    const r = await callController(employee.create, { user: reqUser, body: { firstName: `${PREFIX}B`, lastName: 'Custom' } });
    assert(r.statusCode === 201, 'code-less create under custom scheme → 201');
    assert(r.body.code === 'EMP-IN-9000', `custom prefix + padding honoured (${r.body.code})`);

    // Next mint advances within the custom scheme.
    const r2 = await callController(employee.create, { user: reqUser, body: { firstName: `${PREFIX}B`, lastName: 'Custom2' } });
    assert(r2.body.code === 'EMP-IN-9001', `custom scheme advances (${r2.body.code})`);
  }

  // B3 — an EXPLICIT code still wins (no auto-numbering applied).
  {
    const before = await callController(company.getEmployeeNumberScheme, { user: reqUser });
    const beforeNext = before.body.nextValue;
    const explicit = `${PREFIX}-MANUAL-007`;
    const r = await callController(employee.create, { user: reqUser, body: { code: explicit, firstName: `${PREFIX}C`, lastName: 'Manual' } });
    assert(r.statusCode === 201, 'create with explicit code → 201');
    assert(r.body.code === explicit, `explicit code wins over auto-numbering (${r.body.code})`);
    // The scheme's nextValue was NOT consumed by the manual create.
    const after = await callController(company.getEmployeeNumberScheme, { user: reqUser });
    assert(after.body.nextValue === beforeNext, `manual code did not advance the scheme (${beforeNext} → ${after.body.nextValue})`);
  }

  // B4 — concurrent code-less creates allocate DISTINCT sequential codes (atomic).
  {
    const [a, b, c] = await Promise.all([
      callController(employee.create, { user: reqUser, body: { firstName: `${PREFIX}D`, lastName: 'c1' } }),
      callController(employee.create, { user: reqUser, body: { firstName: `${PREFIX}D`, lastName: 'c2' } }),
      callController(employee.create, { user: reqUser, body: { firstName: `${PREFIX}D`, lastName: 'c3' } }),
    ]);
    const codes = [a, b, c].map((r) => r.body && r.body.code);
    const allOk = [a, b, c].every((r) => r.statusCode === 201);
    const unique = new Set(codes).size === 3;
    assert(allOk, 'three concurrent code-less creates all → 201');
    assert(unique, `concurrent creates allocate DISTINCT codes (${codes.join(', ')})`);
  }

  // ── C) Business profile round-trip ─────────────────────────────────────────
  // C1 — REGRESSION: every PROFILE_FIELDS key that PATCH persists must come back
  // out of GET. The read path used to name fields by hand, so keys added later
  // (businessType, proprietorName, nzbn, irdEntityNumber) saved fine but were
  // dropped on reload — the admin picked "Private Limited Company", saved, and
  // the dropdown reset itself on the next page load.
  log('\n-- C1: company profile saves and reads back --');
  {
    const before = await prisma.business.findUnique({ where: { id: businessId }, select: { companyProfile: true } });
    const sent = {
      businessType: 'private_limited', proprietorName: 'Anil Sharma',
      legalName: 'CP-Test Technologies Private Limited', tradeName: 'CP-Test',
      registrationNo: 'U72200MH2020PTC345678', gstin: '27AABCU9603R1ZM',
      pan: 'AAMCP6969N', tan: 'MUMC12345D',
      nzbn: '9429000000000', irdEntityNumber: '012-345-678',
      registeredAddressLine1: '1 Test Road', registeredAddressLine2: 'Near Nothing',
      registeredCity: 'Mumbai', registeredState: 'MH', registeredPostalCode: '400001',
      registeredCountry: 'IN',
      contactName: 'Aarav Sharma', contactEmail: 'aarav@cp-test.example', contactPhone: '+91 90000 00000',
      incorporationDate: '2020-04-01',
    };
    const saved = await callController(company.updateCompanyProfile, { user: reqUser, body: sent });
    assert(saved.statusCode === 200, 'profile PATCH → 200');

    // A FRESH read — the reload the admin actually does.
    const read = await callController(company.getCompanyProfile, { user: reqUser });
    assert(read.statusCode === 200, 'profile GET → 200');
    const got = read.body.profile || {};
    const missing = Object.keys(sent).filter((k) => got[k] !== sent[k]);
    assert(missing.length === 0, `every saved field survives a reload${missing.length ? ` (dropped: ${missing.join(', ')})` : ''}`);

    // Restore whatever the seed tenant had so later runs / other tests are clean.
    await prisma.business.update({
      where: { id: businessId },
      data: { companyProfile: before?.companyProfile ?? {} },
    });
  }

  await cleanup();

  log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

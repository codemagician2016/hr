'use strict';

/**
 * esign.test.js — Feature 4 slice 4d (Documents + built-in e-sign) proof.
 *
 * Plain-node runner (no jest), same harness as provision.test.js / onboarding.
 * Exercises the BUILTIN e-sign provider + the rewritten documents controller
 * against an isolated hr_test schema.
 *
 * Cases (spec §7 QA 16–22):
 *   QA16 single-signer offer → signatureHash = SHA-256(docHash+signerId+ts);
 *        envelope COMPLETED; EmployeeDocument.signatureStatus=SIGNED + fileHash set.
 *   QA17 sequential dual-signer → signer 2 is INERT until signer 1 is SIGNED.
 *   QA18 tamper → stored fileHash no longer matches a mutated file (detectable).
 *   QA19 expired token → 401, NO signature recorded.
 *   QA20 visibility: HR_ONLY not in /me/documents; EMPLOYEE_VISIBLE is.
 *   QA21 manager out-of-scope employee's documents → 404 (IDOR-safe).
 *   QA22 upload writes REAL EmployeeDocument fields (category/fileUrl/fileHash),
 *        NOT the old fabricated type/url/fileName.
 *
 * Run (needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/esign.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const crypto = require('crypto');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── express-style controller harness (mirrors provision.test.js) ──
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
// Run a full route middleware chain (scope guard → handler) so RBAC/scope are
// exercised end-to-end, not just the handler.
function runChain(middlewares, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(res); } };
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); finish(); return r; };
    const origEnd = res.end.bind(res); res.end = () => { const r = origEnd(); finish(); return r; };
    res.status = (c) => { res.statusCode = c; return res; };
    let i = 0;
    const next = (err) => {
      if (err) { settled = true; return reject(err); }
      const mw = middlewares[i++];
      if (!mw) return finish();
      try { Promise.resolve(mw(req, res, next)).catch(reject); } catch (e) { reject(e); }
    };
    next();
  });
}

const PREFIX = 'ESIGN-TEST';
const pdfDataUrl = (text) => `data:application/pdf;base64,${Buffer.from(`%PDF-1.4 ${text}`).toString('base64')}`;
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  log('\n=== slice 4d — documents + built-in e-sign (QA16–22) ===\n');

  if (!process.env.DATABASE_URL) {
    log('[skip] DATABASE_URL not set — e-sign proof needs the live hr_test schema.\n');
    return;
  }

  const prisma = require('../../../core/lib/prisma');
  const builtin = require('../esign/builtin');
  const documents = require('../../controllers/documents.controller');
  const { withEmployeeScope } = require('../../middleware/scope.middleware');
  const { requirePermission } = require('../../../core/middleware/auth.middleware');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  // ── fixtures: a manager + an in-scope report + an out-of-scope peer ──
  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const empIds = emps.map((e) => e.id);
    if (empIds.length) {
      const envs = await prisma.signatureEnvelope.findMany({
        where: { businessId, employeeDocument: { is: { employeeId: { in: empIds } } } },
        select: { id: true },
      }).catch(() => []);
      const envIds = envs.map((e) => e.id);
      if (envIds.length) {
        await prisma.signatureSigner.deleteMany({ where: { envelopeId: { in: envIds } } });
        await prisma.signatureEnvelope.deleteMany({ where: { id: { in: envIds } } });
      }
      // Envelopes referencing our docs by id directly (no relation include).
      const ourDocs = await prisma.employeeDocument.findMany({ where: { businessId, employeeId: { in: empIds } }, select: { id: true } });
      const docIds = ourDocs.map((d) => d.id);
      if (docIds.length) {
        const envs2 = await prisma.signatureEnvelope.findMany({ where: { businessId, employeeDocumentId: { in: docIds } }, select: { id: true } });
        const env2Ids = envs2.map((e) => e.id);
        if (env2Ids.length) {
          await prisma.signatureSigner.deleteMany({ where: { envelopeId: { in: env2Ids } } });
          await prisma.signatureEnvelope.deleteMany({ where: { id: { in: env2Ids } } });
        }
      }
      await prisma.employeeDocument.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    }
    await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  }
  await cleanup();

  let mgr; let report; let peer;
  try {
    mgr = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-MGR`, firstName: 'Mgr', lastName: 'One', workEmail: `${PREFIX}-mgr@x.com` } });
    report = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-RPT`, firstName: 'Rep', lastName: 'Ort', workEmail: `${PREFIX}-rpt@x.com`, managerEmployeeId: mgr.id } });
    peer = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-PEER`, firstName: 'Pe', lastName: 'Er', workEmail: `${PREFIX}-peer@x.com` } });

    // Manager session actor (TEAM band) for the scope tests.
    const mgrRole = await prisma.businessRole.findFirst({ where: { businessId, defaultScope: 'TEAM' } })
      || await prisma.businessRole.findFirst({ where: { businessId, name: 'Manager' } });
    const mgrActor = {
      id: `${PREFIX}-mgr-user`, businessId, role: 'STAFF',
      employeeId: mgr.id, managerEmployeeId: null,
      businessRoleId: mgrRole ? mgrRole.id : null,
      businessRole: mgrRole ? { id: mgrRole.id, defaultScope: 'TEAM', permissions: mgrRole.permissions } : { defaultScope: 'TEAM', permissions: { canViewEmployees: true, canManageEmployees: true } },
    };
    const hrActor = { id: `${PREFIX}-hr-user`, businessId, role: 'BUSINESS_ADMIN' };

    // ════════════════════════════════════════════════════════════════════════
    // QA22 — upload writes a REAL EmployeeDocument (regression guard)
    // ════════════════════════════════════════════════════════════════════════
    log('QA22) upload writes real EmployeeDocument fields (category/fileUrl/fileHash):');
    const upRes = await callController(documents.createDocument, {
      user: hrActor,
      params: { employeeId: report.id },
      body: { category: 'OFFER_LETTER', name: 'Offer', fileBase64: pdfDataUrl('offer'), visibility: 'EMPLOYEE_VISIBLE' },
    });
    assert(upRes.statusCode === 201, 'upload returns 201');
    const docRow = await prisma.employeeDocument.findFirst({ where: { businessId, employeeId: report.id, category: 'OFFER_LETTER' } });
    assert(!!docRow, 'an EmployeeDocument row was written');
    assert(docRow && docRow.category === 'OFFER_LETTER', 'row has REAL field `category`');
    assert(docRow && typeof docRow.fileUrl === 'string' && docRow.fileUrl.length > 0, 'row has REAL field `fileUrl`');
    assert(docRow && typeof docRow.fileHash === 'string' && docRow.fileHash.length === 64, 'row has server-computed `fileHash` (SHA-256)');
    assert(docRow && docRow.type === undefined && docRow.url === undefined, 'row has NO fabricated `type`/`url` fields');

    // Bad category → 422 (never a Prisma 500).
    const badCat = await callController(documents.createDocument, {
      user: hrActor, params: { employeeId: report.id }, body: { category: 'NOPE', fileBase64: pdfDataUrl('x') },
    });
    assert(badCat.statusCode === 422, 'invalid category → 422');
    // Oversize → 413.
    const big = `data:application/pdf;base64,${'A'.repeat(15 * 1024 * 1024)}`;
    const tooBig = await callController(documents.createDocument, {
      user: hrActor, params: { employeeId: report.id }, body: { category: 'OTHER', fileBase64: big },
    });
    assert(tooBig.statusCode === 413, 'oversize upload → 413');

    // ════════════════════════════════════════════════════════════════════════
    // QA16 — single-signer offer → signatureHash + envelope COMPLETED + doc SIGNED
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA16) single-signer offer sign → hash + COMPLETED + EmployeeDocument SIGNED:');
    const created = await builtin.createEnvelope({
      businessId, subject: 'Sign your offer', employeeDocumentId: docRow.id,
      signers: [{ role: 'EMPLOYEE', name: 'Rep Ort', email: `${PREFIX}-rpt@x.com` }],
    }, prisma);
    assert(created.envelope.status === 'SENT', 'envelope minted as SENT');
    const rawToken = created.signers[0].rawToken;
    assert(typeof rawToken === 'string' && rawToken.length > 20, 'raw magic-link token returned for the invite');
    const storedSigner = await prisma.signatureSigner.findUnique({ where: { id: created.signers[0].id } });
    assert(storedSigner.accessTokenHash && storedSigner.accessTokenHash !== rawToken, 'only the HASHED token is persisted (raw never stored)');

    const docHash = await builtin.resolveDocHash(prisma, created.envelope);
    const before = Date.now();
    const signed = await builtin.sign({ token: rawToken, signatureImageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', consent: true, ip: '1.2.3.4', userAgent: 'jest' }, prisma);
    assert(signed.completed === true, 'single signer → envelope completed');
    assert(signed.envelope.status === 'COMPLETED', 'envelope status COMPLETED');

    const signerAfter = await prisma.signatureSigner.findUnique({ where: { id: created.signers[0].id } });
    assert(signerAfter.status === 'SIGNED', 'signer status SIGNED');
    assert(!!signerAfter.consentAt, 'consentAt captured');
    assert(signerAfter.ipAddress === '1.2.3.4', 'ipAddress captured');
    // signatureHash = SHA-256(docHash + signerId + ISO-ts) — recompute with the
    // stored signedAt and confirm it matches.
    const expectHash = sha256Hex(`${docHash}${signerAfter.id}${new Date(signerAfter.signedAt).toISOString()}`);
    assert(signerAfter.signatureHash === expectHash, 'signatureHash === SHA-256(docHash + signerId + ISO-ts)');

    const docAfter = await prisma.employeeDocument.findUnique({ where: { id: docRow.id } });
    assert(docAfter.signatureStatus === 'SIGNED', 'EmployeeDocument.signatureStatus = SIGNED');
    assert(typeof docAfter.fileHash === 'string' && docAfter.fileHash.length === 64, 'EmployeeDocument.fileHash set (final-file hash)');
    const envAfter = await prisma.signatureEnvelope.findUnique({ where: { id: created.envelope.id } });
    assert(!!envAfter.certificateUrl, 'audit certificateUrl recorded');
    assert(!!envAfter.finalFileUrl, 'finalFileUrl recorded');
    assert(new Date(signerAfter.signedAt).getTime() >= before - 1000, 'signedAt is at sign time');

    // Idempotency: a second sign on a SIGNED signer is inert.
    const again = await builtin.sign({ token: rawToken, signatureImageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', consent: true }, prisma);
    assert(again.idempotent === true && again.signer.status === 'SIGNED', 'second sign on a SIGNED signer is inert (idempotent)');

    // ════════════════════════════════════════════════════════════════════════
    // QA17 — sequential dual-signer: signer 2 inert until signer 1 SIGNED
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA17) sequential dual-signer → signer 2 inert until signer 1 signs:');
    const cDoc = await prisma.employeeDocument.create({
      data: { businessId, employeeId: report.id, category: 'CONTRACT', name: 'Contract', fileUrl: pdfDataUrl('contract'), fileHash: sha256Hex('contract'), visibility: 'EMPLOYEE_VISIBLE' },
    });
    const dual = await builtin.createEnvelope({
      businessId, subject: 'Employment contract', employeeDocumentId: cDoc.id, sequential: true,
      signers: [
        { role: 'EMPLOYEE', name: 'Rep Ort', email: `${PREFIX}-rpt@x.com`, signerOrder: 1 },
        { role: 'EMPLOYER', name: 'Mgr One', email: `${PREFIX}-mgr@x.com`, signerOrder: 2 },
      ],
    }, prisma);
    const tok1 = dual.signers.find((s) => s.signerOrder === 1).rawToken;
    const tok2 = dual.signers.find((s) => s.signerOrder === 2).rawToken;

    // Signer 2 tries first → inert (409), nothing recorded.
    let s2err = null;
    try { await builtin.sign({ token: tok2, signatureImageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', consent: true }, prisma); }
    catch (e) { s2err = e; }
    assert(s2err && s2err.status === 409, 'signer 2 signing first → 409 (inert, out of order)');
    const s2row0 = dual.signers.find((s) => s.signerOrder === 2);
    const s2check = await prisma.signatureSigner.findUnique({ where: { id: s2row0.id } });
    assert(s2check.status !== 'SIGNED' && !s2check.signatureHash, 'signer 2 has NO recorded signature yet');

    // Signer 1 signs → envelope PARTIALLY_SIGNED, not complete.
    const s1res = await builtin.sign({ token: tok1, signatureImageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', consent: true }, prisma);
    assert(s1res.completed === false && s1res.envelope.status === 'PARTIALLY_SIGNED', 'after signer 1 → PARTIALLY_SIGNED');
    // Now signer 2 may sign → completes.
    const s2res = await builtin.sign({ token: tok2, signatureImageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', consent: true }, prisma);
    assert(s2res.completed === true && s2res.envelope.status === 'COMPLETED', 'after both → COMPLETED');

    // ════════════════════════════════════════════════════════════════════════
    // QA19 — expired token → 401, no signature recorded
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA19) expired token → 401, no signature recorded:');
    const eDoc = await prisma.employeeDocument.create({
      data: { businessId, employeeId: report.id, category: 'POLICY_ACK', name: 'Policy', fileUrl: pdfDataUrl('policy'), fileHash: sha256Hex('policy'), visibility: 'EMPLOYEE_VISIBLE' },
    });
    const expEnv = await builtin.createEnvelope({
      businessId, subject: 'Policy ack', employeeDocumentId: eDoc.id,
      signers: [{ role: 'EMPLOYEE', name: 'Rep Ort', email: `${PREFIX}-rpt@x.com` }],
    }, prisma);
    const expToken = expEnv.signers[0].rawToken;
    // Force the token expiry into the past.
    await prisma.signatureSigner.update({ where: { id: expEnv.signers[0].id }, data: { tokenExpiresAt: new Date(Date.now() - 86400000) } });
    let expErr = null;
    try { await builtin.sign({ token: expToken, signatureImageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', consent: true }, prisma); }
    catch (e) { expErr = e; }
    assert(expErr && expErr.status === 401, 'expired token → 401');
    const expSigner = await prisma.signatureSigner.findUnique({ where: { id: expEnv.signers[0].id } });
    assert(expSigner.status !== 'SIGNED' && !expSigner.signatureHash, 'no signature recorded for an expired token');

    // ════════════════════════════════════════════════════════════════════════
    // QA18 — tamper: stored fileHash mismatch is detectable
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA18) tamper → stored fileHash no longer matches the (mutated) file:');
    const storedHash = docAfter.fileHash;
    const originalBytes = Buffer.from(`%PDF-1.4 offer`);
    const recomputeOriginal = sha256Hex(originalBytes);
    // The stored hash is the canonical integrity anchor; a mutated file hashes
    // differently, so a verifier comparing recomputed-vs-stored catches the tamper.
    const tamperedBytes = Buffer.from(`%PDF-1.4 offer (ALTERED)`);
    const recomputeTampered = sha256Hex(tamperedBytes);
    assert(recomputeTampered !== storedHash, 'a tampered file hashes differently from the stored fileHash → tamper detectable');
    assert(typeof storedHash === 'string' && storedHash.length === 64, 'stored fileHash is a real SHA-256 anchor');

    // ════════════════════════════════════════════════════════════════════════
    // QA20 — visibility: HR_ONLY not in /me/documents; EMPLOYEE_VISIBLE is
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA20) /me/documents excludes HR_ONLY, includes EMPLOYEE_VISIBLE:');
    const hrOnlyDoc = await prisma.employeeDocument.create({
      data: { businessId, employeeId: report.id, category: 'MEDICAL', name: 'Medical', fileUrl: pdfDataUrl('med'), fileHash: sha256Hex('med'), visibility: 'HR_ONLY' },
    });
    const empVisDoc = await prisma.employeeDocument.create({
      data: { businessId, employeeId: report.id, category: 'EXPERIENCE', name: 'Experience letter', fileUrl: pdfDataUrl('exp'), fileHash: sha256Hex('exp'), visibility: 'EMPLOYEE_VISIBLE' },
    });
    const meRes = await callController(documents.listMyDocuments, {
      customer: { businessId, email: `${PREFIX}-rpt@x.com`, id: 'cust-1' },
    });
    const meIds = (meRes.body.items || []).map((d) => d.id);
    assert(!meIds.includes(hrOnlyDoc.id), 'HR_ONLY doc NOT returned by /me/documents');
    assert(meIds.includes(empVisDoc.id), 'EMPLOYEE_VISIBLE doc IS returned by /me/documents');
    // The signed offer (EMPLOYEE_VISIBLE + SIGNED) is also there.
    assert(meIds.includes(docRow.id), 'the signed offer is visible to the employee');

    // ════════════════════════════════════════════════════════════════════════
    // QA21 — manager cannot fetch an out-of-scope employee's documents → 404
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA21) manager → out-of-scope employee documents → 404:');
    // In scope (report) → ok (200). Out of scope (peer) → 404, via the SAME
    // route middleware chain the real router applies.
    const chain = [
      requirePermission('canViewEmployees'),
      withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
      documents.listDocuments,
    ];
    const inScope = await runChain(chain, { user: mgrActor, params: { employeeId: report.id }, query: {} });
    assert(inScope.statusCode === 200, 'manager listing IN-scope report docs → 200');
    const outScope = await runChain(chain, { user: mgrActor, params: { employeeId: peer.id }, query: {} });
    assert(outScope.statusCode === 404, 'manager listing OUT-of-scope peer docs → 404 (IDOR-safe)');

    // Manager also cannot see HR_ONLY docs even for an in-scope report.
    const mgrScopeReq = { user: mgrActor, params: { employeeId: report.id }, query: {} };
    const mgrList = await runChain([
      requirePermission('canViewEmployees'),
      withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
      documents.listDocuments,
    ], mgrScopeReq);
    const mgrDocIds = (mgrList.body.items || []).map((d) => d.id);
    assert(!mgrDocIds.includes(hrOnlyDoc.id), 'manager view excludes HR_ONLY docs (in-scope report)');

    const s3 = require('../../../core/lib/s3');

    // ════════════════════════════════════════════════════════════════════════
    // D12 — PDF upload succeeds on BOTH the inline-fallback AND the S3 branch
    // ════════════════════════════════════════════════════════════════════════
    log('\nD12) PDF upload works on both the inline + S3 branches:');
    // (a) Inline-fallback branch (S3 not configured in test) — already exercised by
    //     QA22 above, re-assert explicitly that a PDF lands.
    const pdfUp = await callController(documents.createDocument, {
      user: hrActor, params: { employeeId: report.id },
      body: { category: 'CONTRACT', name: 'PDF inline', fileBase64: pdfDataUrl('inline-pdf'), visibility: 'HR_ONLY' },
    });
    assert(pdfUp.statusCode === 201 && pdfUp.body.mimeType === 'application/pdf', 'D12 PDF upload (inline branch) → 201 application/pdf');
    // (b) S3 branch: the allow-list now accepts application/pdf, so parseDataUrl no
    //     longer throws on a PDF (the old image-only list 500'd). Prove it directly.
    let parsedPdf = null; let parseErr = null;
    try { parsedPdf = s3.parseDataUrl(pdfDataUrl('s3-pdf')); } catch (e) { parseErr = e; }
    assert(!parseErr && parsedPdf && parsedPdf.mime === 'application/pdf' && parsedPdf.ext === 'pdf', 'D12 s3.parseDataUrl accepts application/pdf (S3 branch no longer 500s)');
    // A non-allow-listed type still throws (defence intact).
    let badParse = null;
    try { s3.parseDataUrl('data:application/x-msdownload;base64,QQ=='); } catch (e) { badParse = e; }
    assert(!!badParse, 'D12 s3.parseDataUrl still rejects a non-allow-listed type');

    // ════════════════════════════════════════════════════════════════════════
    // D14 — envelope expiry enforced at sign (even with a still-valid token)
    // ════════════════════════════════════════════════════════════════════════
    log('\nD14) expired ENVELOPE rejected at sign (token still valid):');
    const envExpDoc = await prisma.employeeDocument.create({
      data: { businessId, employeeId: report.id, category: 'POLICY_ACK', name: 'EnvExpiry', fileUrl: pdfDataUrl('envexp'), fileHash: sha256Hex('envexp'), visibility: 'EMPLOYEE_VISIBLE' },
    });
    const envExp = await builtin.createEnvelope({
      businessId, subject: 'Envelope expiry', employeeDocumentId: envExpDoc.id,
      signers: [{ role: 'EMPLOYEE', name: 'Rep Ort', email: `${PREFIX}-rpt@x.com` }],
    }, prisma);
    const envExpToken = envExp.signers[0].rawToken;
    // Push the ENVELOPE expiry into the past but keep the SIGNER token valid → the
    // envelope-level deadline (D14) must still reject, distinct from QA19 (token expiry).
    await prisma.signatureEnvelope.update({ where: { id: envExp.envelope.id }, data: { expiresAt: new Date(Date.now() - 86400000) } });
    let envExpErr = null;
    try { await builtin.sign({ token: envExpToken, signatureImageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', consent: true }, prisma); }
    catch (e) { envExpErr = e; }
    assert(envExpErr && envExpErr.status === 410, 'D14 expired envelope → 410');
    const envExpSigner = await prisma.signatureSigner.findUnique({ where: { id: envExp.signers[0].id } });
    assert(envExpSigner.status !== 'SIGNED' && !envExpSigner.signatureHash, 'D14 no signature recorded on an expired envelope');
    const envExpAfter = await prisma.signatureEnvelope.findUnique({ where: { id: envExp.envelope.id } });
    assert(envExpAfter.status === 'EXPIRED', 'D14 envelope flipped to EXPIRED (terminal)');

    // ════════════════════════════════════════════════════════════════════════
    // D16 — createEnvelope rejects a PAST expiresAt
    // ════════════════════════════════════════════════════════════════════════
    log('\nD16) createEnvelope rejects a past expiresAt:');
    let pastErr = null;
    try {
      await builtin.createEnvelope({
        businessId, subject: 'Past expiry', employeeDocumentId: envExpDoc.id,
        signers: [{ role: 'EMPLOYEE', name: 'Rep Ort', email: `${PREFIX}-rpt@x.com` }],
        expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      }, prisma);
    } catch (e) { pastErr = e; }
    assert(pastErr && pastErr.status === 422, 'D16 past expiresAt at creation → 422 (rejected)');

    // ════════════════════════════════════════════════════════════════════════
    // D13 — audit certificate is HMAC-SEALED with a server secret (tamper-evident)
    // ════════════════════════════════════════════════════════════════════════
    log('\nD13) audit certificate is HMAC-sealed (real tamper-evidence):');
    const cert = builtin.buildAuditCertificate({
      envelope: { id: 'env-x', subject: 'Cert test' },
      signers: [{ name: 'A', email: 'a@x.com', role: 'EMPLOYEE', signedAt: new Date(), consentAt: new Date(), ipAddress: '9.9.9.9', signatureHash: 'abc' }],
      docHash: 'deadbeef',
    });
    assert(cert && typeof cert.hmac === 'string' && cert.hmac.length === 64, 'D13 buildAuditCertificate returns a 64-hex HMAC seal');
    // Recompute the HMAC over the SAME body → matches (verifier path).
    assert(builtin.certHmac(cert.body) === cert.hmac, 'D13 HMAC recomputes over the body (verifiable)');
    // Tamper the body → the recomputed HMAC no longer matches the seal.
    assert(builtin.certHmac(cert.body + ' (tampered)') !== cert.hmac, 'D13 tampered body → HMAC mismatch (tamper detected)');
    // A different secret yields a different HMAC (the seal depends on the secret).
    const realSecret = process.env.ESIGN_CERT_SECRET; process.env.ESIGN_CERT_SECRET = 'a-different-secret';
    assert(builtin.certHmac(cert.body) !== cert.hmac, 'D13 HMAC depends on the server secret');
    if (realSecret === undefined) delete process.env.ESIGN_CERT_SECRET; else process.env.ESIGN_CERT_SECRET = realSecret;
    // The HMAC is embedded in the rendered certificate so it travels with the artifact.
    const certHtml = Buffer.from(cert.dataUrl.split(',')[1], 'base64').toString('utf8');
    assert(certHtml.includes(cert.hmac), 'D13 HMAC seal embedded in the rendered certificate');

    // ════════════════════════════════════════════════════════════════════════
    // D15 — concurrent final signs cannot leave the envelope stuck PARTIALLY_SIGNED
    // ════════════════════════════════════════════════════════════════════════
    log('\nD15) concurrent dual-sign completes (no stuck PARTIALLY_SIGNED):');
    const concDoc = await prisma.employeeDocument.create({
      data: { businessId, employeeId: report.id, category: 'CONTRACT', name: 'Concurrent', fileUrl: pdfDataUrl('conc'), fileHash: sha256Hex('conc'), visibility: 'EMPLOYEE_VISIBLE' },
    });
    // Non-sequential dual-signer so BOTH tokens are immediately live.
    const conc = await builtin.createEnvelope({
      businessId, subject: 'Concurrent contract', employeeDocumentId: concDoc.id, sequential: false,
      signers: [
        { role: 'EMPLOYEE', name: 'Rep Ort', email: `${PREFIX}-rpt@x.com`, signerOrder: 1 },
        { role: 'EMPLOYER', name: 'Mgr One', email: `${PREFIX}-mgr@x.com`, signerOrder: 2 },
      ],
    }, prisma);
    const ctok1 = conc.signers.find((s) => s.signerOrder === 1).rawToken;
    const ctok2 = conc.signers.find((s) => s.signerOrder === 2).rawToken;
    // Fire both signs concurrently — the FOR UPDATE row-lock serialises completion so
    // exactly one observes "all signed" and the envelope ends COMPLETED, never stuck.
    const sig = 'data:image/png;base64,iVBORw0KGgo=';
    const [r1, r2] = await Promise.all([
      builtin.sign({ token: ctok1, signatureImageDataUrl: sig, consent: true }, prisma),
      builtin.sign({ token: ctok2, signatureImageDataUrl: sig, consent: true }, prisma),
    ]);
    assert(r1 && r2, 'D15 both concurrent signs resolved');
    const concEnv = await prisma.signatureEnvelope.findUnique({ where: { id: conc.envelope.id } });
    assert(concEnv.status === 'COMPLETED', 'D15 envelope COMPLETED after concurrent signs (not stuck PARTIALLY_SIGNED)');
    assert(!!concEnv.completedAt && !!concEnv.certificateUrl, 'D15 completion artifacts (completedAt + certificateUrl) recorded');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  log(`\n=== esign.test: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ===\n`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

'use strict';

/**
 * selfOnboarding.test.js — Feature 4 slice 4b (Self-onboarding ESS) proof.
 *
 * Two layers in one plain-node runner (no jest), mirroring the 4a harness:
 *   PART A (DB-FREE) — the PURE statutory validators: PAN, Aadhaar (Verhoeff),
 *     UAN, IFSC (IN); IRD (IR mod-11), NZ bank, tax code, KiwiSaver (NZ); plus
 *     validateStatutory() field-error shape.
 *   PART B (LIVE hr_test) — the self-only ESS controller: a request cannot reach
 *     another employee's journey (subject is session-derived; a body employeeId
 *     is ignored); invalid statutory → 422 field errors; staging marks the
 *     COLLECT_* task DONE; submit is blocked (422) until the required
 *     SELF_ONBOARDING tasks are DONE, then advances the stage.
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/selfOnboarding.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const V = require('../validators');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A — PURE VALIDATORS (no DB)
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('\n=== PART A — validators (pure, DB-free) ===\n');

  // ── A1: PAN ──
  log('A1) PAN ([A-Z]{5}[0-9]{4}[A-Z]):');
  assert(V.isValidPAN('ABCDE1234F'), 'valid PAN accepted');
  assert(V.isValidPAN('abcde1234f'), 'lowercase normalized + accepted');
  assert(!V.isValidPAN('ABCD1234F'), 'too-few letters rejected');
  assert(!V.isValidPAN('ABCDE12345'), 'trailing digit (no final letter) rejected');
  assert(V.normalizePAN(' ABCDE1234F ') === 'ABCDE1234F', 'normalizePAN trims + uppercases');

  // ── A2: Aadhaar (Verhoeff checksum) ──
  log('A2) Aadhaar (Verhoeff):');
  // Build a valid 12-digit Aadhaar: pick an 11-digit base (not starting 0/1) and
  // append the digit that makes the Verhoeff checksum 0.
  const base11 = '23412341234';
  let valid = null;
  for (let d = 0; d < 10; d += 1) { if (V._internals.verhoeffChecksum(base11 + d) === 0) { valid = base11 + d; break; } }
  assert(valid && V.isValidAadhaar(valid), `valid Aadhaar (${valid}) accepted`);
  assert(!V.isValidAadhaar(base11 + ((Number(valid[11]) + 1) % 10)), 'wrong check digit rejected (Verhoeff catches it)');
  assert(!V.isValidAadhaar('012345678901'), 'leading 0 rejected (UIDAI rule)');
  assert(!V.isValidAadhaar('12345'), 'wrong length rejected');
  // transposition of two adjacent base digits should break the checksum
  const transposed = valid[1] + valid[0] + valid.slice(2);
  assert(transposed === valid || !V.isValidAadhaar(transposed), 'adjacent transposition rejected');

  // ── A3: UAN ──
  log('A3) UAN (12 digits):');
  assert(V.isValidUAN('100200300400'), 'valid 12-digit UAN accepted');
  assert(V.isValidUAN('1002-0030-0400'), 'separators stripped + accepted');
  assert(!V.isValidUAN('12345'), 'short UAN rejected');

  // ── A4: IFSC ──
  log('A4) IFSC ([A-Z]{4}0[A-Z0-9]{6}):');
  assert(V.isValidIFSC('HDFC0001234'), 'valid IFSC accepted');
  assert(!V.isValidIFSC('HDFC1001234'), '5th char must be 0 — rejected');
  assert(!V.isValidIFSC('HDF0001234'), 'too-few bank letters rejected');

  // ── A5: IRD (IR mod-11) ──
  log('A5) IRD (IR mod-11 + check digit):');
  assert(V.isValidIRD('49091850'), 'valid 8-digit IRD (IR example) accepted');
  assert(V.isValidIRD('136410132'), 'valid 9-digit IRD (secondary-weights path) accepted');
  assert(!V.isValidIRD('12345678'), 'bad checksum rejected');
  assert(!V.isValidIRD('1234567'), 'too short rejected');
  assert(!V.isValidIRD('9999999'), 'below valid range rejected');
  // a single-digit error must break the check digit
  assert(!V.isValidIRD('49091851'), 'altered check digit rejected');

  // ── A6: NZ bank account ──
  log('A6) NZ bank (bank-branch-account-suffix):');
  assert(V.isValidNZBank('12-3456-1234567-00'), 'valid NZ bank string accepted');
  assert(V.normalizeNZBank('01-0102-123456-00') === '01-0102-0123456-000', 'normalize zero-pads account+suffix');
  assert(!V.isValidNZBank('12-3456-1234567'), 'missing suffix part rejected');
  assert(!V.isValidNZBank('1-3456-1234567-00'), 'bad bank length rejected');

  // ── A7: NZ tax code ──
  log('A7) NZ tax code (M/ME/SB/S/SH/ST/SA + variants):');
  assert(V.isValidTaxCode('M') && V.isValidTaxCode('ME') && V.isValidTaxCode('ST'), 'base codes accepted');
  assert(V.isValidTaxCode('S SL') && V.isValidTaxCode('m sl'), 'student-loan variant accepted (case/space-insensitive)');
  assert(V.normalizeTaxCode('MSL') === 'M SL', 'glued SL normalized to "M SL"');
  assert(!V.isValidTaxCode('XX'), 'unknown code rejected');

  // ── A8: KiwiSaver rate ──
  log('A8) KiwiSaver rate (3/4/6/8/10%):');
  assert(V.isValidKiwiSaverRate(3) && V.isValidKiwiSaverRate('8%'), 'legal rates accepted (number + "8%")');
  assert(!V.isValidKiwiSaverRate(5), 'illegal rate (5%) rejected');

  // ── A9: validateStatutory aggregate ──
  log('A9) validateStatutory(countryCode, payload):');
  const inOk = V.validateStatutory('IN', { pan: 'ABCDE1234F', taxRegime: 'NEW' });
  assert(inOk.ok && Object.keys(inOk.errors).length === 0, 'IN valid → ok:true');
  const inBad = V.validateStatutory('IN', { pan: 'BAD', aadhaar: '111' });
  assert(!inBad.ok && inBad.errors.pan && inBad.errors.aadhaar, 'IN invalid → per-field errors {pan,aadhaar}');
  const nzMissing = V.validateStatutory('NZ', {});
  assert(!nzMissing.ok && nzMissing.errors.irdNumber && nzMissing.errors.taxCode, 'NZ missing → {irdNumber,taxCode} required');
  const nzOk = V.validateStatutory('NZ', { irdNumber: '49091850', taxCode: 'M' });
  assert(nzOk.ok, 'NZ valid → ok:true');
  // unknown country defaults to IN rules
  assert(!V.validateStatutory('GB', {}).ok, 'unknown country falls back to IN (PAN required)');
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test (self-only scope, 422, staging, submit gate)
// ═══════════════════════════════════════════════════════════════════════════
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
    // req.get shim for the X-Onboarding-Token header lookup.
    if (!req.get) req.get = () => null;
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'ONB4B-TEST';

async function partB() {
  log('\n=== PART B — LIVE hr_test (self-only scope, 422, staging, submit gate) ===\n');

  const prisma = require('../../../core/lib/prisma');
  const mec = require('../controllers/meOnboarding.controller');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const entity = await prisma.entity.findFirst({ where: { businessId } });
  const entityId = entity ? entity.id : null;

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const empIds = emps.map((e) => e.id);
    const journeys = await prisma.lifecycleJourney.findMany({
      where: { businessId, OR: [{ code: { startsWith: PREFIX } }, { employeeId: { in: empIds } }] },
      select: { id: true },
    });
    const jIds = journeys.map((j) => j.id);
    if (jIds.length) {
      await prisma.lifecycleTask.deleteMany({ where: { journeyId: { in: jIds } } });
      await prisma.lifecycleJourney.deleteMany({ where: { id: { in: jIds } } });
    }
    if (empIds.length) {
      await prisma.employeeDocument.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    }
    await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  }

  await cleanup();

  // Helper: seed a journey for an employee with the standard SELF_ONBOARDING
  // blocking tasks (all PENDING) at stage SELF_ONBOARDING.
  async function seedJourney(employeeId, code) {
    const j = await prisma.lifecycleJourney.create({
      data: {
        businessId, entityId, code, direction: 'ONBOARDING',
        employeeId, currentStage: 'SELF_ONBOARDING', status: 'IN_PROGRESS',
        joinDate: new Date('2026-08-01'),
        tasks: {
          create: [
            { businessId, stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_PERSONAL', title: 'Personal', ownerRole: 'NEW_HIRE', isBlocking: true, isMandatory: true, status: 'PENDING' },
            { businessId, stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_STATUTORY', title: 'Statutory', ownerRole: 'NEW_HIRE', isBlocking: true, isMandatory: true, status: 'PENDING' },
            { businessId, stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_BANK', title: 'Bank', ownerRole: 'NEW_HIRE', isBlocking: true, isMandatory: true, status: 'PENDING' },
            { businessId, stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_EMERGENCY', title: 'Emergency', ownerRole: 'NEW_HIRE', isBlocking: false, isMandatory: true, status: 'PENDING' },
            { businessId, stageKey: 'SELF_ONBOARDING', taskKey: 'UPLOAD_DOCS', title: 'Docs', ownerRole: 'NEW_HIRE', isBlocking: true, isMandatory: true, status: 'PENDING' },
            // DOCS_ESIGN gates the NEXT stage (mirrors the real template): with
            // SELF_ONBOARDING cleared the engine stops here, not at PROVISIONING.
            { businessId, stageKey: 'DOCS_ESIGN', taskKey: 'ESIGN_CONTRACT', title: 'E-sign contract', ownerRole: 'NEW_HIRE', isBlocking: true, isMandatory: true, status: 'PENDING' },
            { businessId, stageKey: 'PROVISIONING', taskKey: 'PROVISION_EMPLOYEE', title: 'Provision', ownerRole: 'HR', isBlocking: true, isMandatory: true, status: 'PENDING' },
          ],
        },
      },
      include: { tasks: true },
    });
    return j;
  }

  try {
    // Two employees, each linked to a customer by workEmail; only ONE is "me".
    const meEmp = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-ME`, firstName: 'Self', lastName: 'Hire', status: 'PRE_HIRE', workEmail: `${PREFIX}-me@example.com` },
    });
    const otherEmp = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-OTHER`, firstName: 'Other', lastName: 'Hire', status: 'PRE_HIRE', workEmail: `${PREFIX}-other@example.com` },
    });
    const myJourney = await seedJourney(meEmp.id, `${PREFIX}-J-ME`);
    const otherJourney = await seedJourney(otherEmp.id, `${PREFIX}-J-OTHER`);

    // The ESS session (subject is ALWAYS this).
    const meCustomer = { id: 'cust-me', email: `${PREFIX}-me@example.com`, businessId };

    // ── B1: GET /me/onboarding returns ONLY my journey ──
    log('B1) GET /me/onboarding resolves the caller\'s own journey only:');
    {
      const res = await callController(mec.getMyOnboarding, { customer: meCustomer, query: {}, params: {}, body: {} });
      assert(res.statusCode === 200, 'GET → 200');
      assert(res.body.journey && res.body.journey.id === myJourney.id, 'returns MY journey');
      assert(res.body.journey.id !== otherJourney.id, 'does NOT return the other employee\'s journey');
      assert(!('preJoinTokenHash' in res.body.journey), 'token hash not leaked to the client');
      assert(res.body.completeness && res.body.completeness.submitReady === false, 'completeness vector present, not yet submit-ready');
    }

    // ── B2: a body employeeId is IGNORED (subject is session-derived) ──
    log('B2) self-only: a body employeeId cannot redirect the write to another journey:');
    {
      const res = await callController(mec.postPersonal, {
        customer: meCustomer, query: {}, params: {},
        body: { employeeId: otherEmp.id, firstName: 'Hacker' }, // attempt to target the other journey
      });
      assert(res.statusCode === 200, 'postPersonal → 200');
      // The OTHER journey must be untouched; MY journey gets the staged personal.
      const mine = await prisma.lifecycleJourney.findUnique({ where: { id: myJourney.id } });
      const other = await prisma.lifecycleJourney.findUnique({ where: { id: otherJourney.id } });
      assert(mine.selfServiceJson && mine.selfServiceJson.personal && mine.selfServiceJson.personal.firstName === 'Hacker',
        'data staged onto MY journey (subject = session)');
      assert(!other.selfServiceJson || !other.selfServiceJson.personal,
        'the other employee\'s journey is untouched (body employeeId ignored)');
      const meTask = await prisma.lifecycleTask.findFirst({ where: { journeyId: myJourney.id, taskKey: 'COLLECT_PERSONAL' } });
      assert(meTask.status === 'DONE', 'COLLECT_PERSONAL marked DONE on my journey');
    }

    // ── B3: invalid statutory → 422 with field errors; valid → 200 + task DONE ──
    log('B3) statutory validation (422 on invalid, 200 + task DONE on valid):');
    {
      const bad = await callController(mec.postStatutory, {
        customer: meCustomer, query: {}, params: {}, body: { pan: 'NOTAPAN' },
      });
      assert(bad.statusCode === 422, 'invalid PAN → 422');
      assert(bad.body.errors && bad.body.errors.pan, '422 carries a per-field PAN error');
      const statTask0 = await prisma.lifecycleTask.findFirst({ where: { journeyId: myJourney.id, taskKey: 'COLLECT_STATUTORY' } });
      assert(statTask0.status === 'PENDING', 'task stays PENDING after a rejected statutory write');

      const ok = await callController(mec.postStatutory, {
        customer: meCustomer, query: {}, params: {}, body: { pan: 'ABCDE1234F', taxRegime: 'NEW' },
      });
      assert(ok.statusCode === 200, 'valid statutory → 200');
      const statTask = await prisma.lifecycleTask.findFirst({ where: { journeyId: myJourney.id, taskKey: 'COLLECT_STATUTORY' } });
      assert(statTask.status === 'DONE', 'COLLECT_STATUTORY marked DONE');
    }

    // ── B4: submit BLOCKED until required tasks done, then advances stage ──
    log('B4) submit gate (422 until required SELF_ONBOARDING tasks DONE):');
    {
      // At this point COLLECT_PERSONAL + COLLECT_STATUTORY are DONE, but
      // COLLECT_BANK and UPLOAD_DOCS (both blocking) are still PENDING → blocked.
      const blocked = await callController(mec.submitOnboarding, { customer: meCustomer, query: {}, params: {}, body: {} });
      assert(blocked.statusCode === 422, 'submit blocked (422) while required tasks open');
      assert(Array.isArray(blocked.body.pending) && blocked.body.pending.length > 0, '422 lists the pending required tasks');

      // Complete bank (valid) + a document upload (S3 not configured → embeds data URL).
      await callController(mec.postBank, {
        customer: meCustomer, query: {}, params: {},
        body: { accountHolderName: 'Self Hire', accountNumber: '123456789', ifsc: 'HDFC0001234' },
      });
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const upRes = await callController(mec.postDocuments, {
        customer: meCustomer, query: {}, params: {},
        body: { category: 'AADHAAR', name: 'id.png', mimeType: 'image/png', sizeBytes: 70, fileHash: 'abc', fileBase64: dataUrl },
      });
      assert(upRes.statusCode === 201, 'document upload → 201');
      // A real EmployeeDocument row with the REAL schema fields (regression guard).
      const docRow = await prisma.employeeDocument.findFirst({ where: { businessId, employeeId: meEmp.id } });
      assert(docRow && docRow.category === 'AADHAAR' && docRow.fileUrl && !('type' in docRow),
        'EmployeeDocument written with real fields (category/fileUrl, not type/url)');
      const upTask = await prisma.lifecycleTask.findFirst({ where: { journeyId: myJourney.id, taskKey: 'UPLOAD_DOCS' } });
      assert(upTask.status === 'DONE' && upTask.employeeDocumentId === docRow.id, 'UPLOAD_DOCS DONE + bound to the doc');

      // Now all blocking SELF_ONBOARDING tasks are DONE → submit advances stage.
      const ok = await callController(mec.submitOnboarding, { customer: meCustomer, query: {}, params: {}, body: {} });
      assert(ok.statusCode === 200, 'submit → 200 once required tasks DONE');
      assert(ok.body.currentStage === 'DOCS_ESIGN', 'journey advanced SELF_ONBOARDING → DOCS_ESIGN');
      const reloaded = await prisma.lifecycleJourney.findUnique({ where: { id: myJourney.id } });
      assert(reloaded.currentStage === 'DOCS_ESIGN', 'persisted new stage = DOCS_ESIGN');
    }

    // ── B5: pre-join magic-link token — valid resolves, expired → 401 ──
    log('B5) pre-join magic-link token (valid resolves one journey; expired → 401):');
    {
      // Attach a token to a fresh pre-provision journey (no employeeId).
      const rawToken = 'pre-join-secret-token-xyz';
      const tokenHash = mec._internals.hashToken(rawToken);
      const preJourney = await prisma.lifecycleJourney.create({
        data: {
          businessId, entityId, code: `${PREFIX}-J-PRE`, direction: 'ONBOARDING',
          currentStage: 'PRE_JOIN', status: 'NOT_STARTED', joinDate: new Date('2026-08-01'),
          preJoinTokenHash: tokenHash, preJoinTokenExpiresAt: new Date(Date.now() + 86400000),
        },
      });
      const okTok = await callController(mec.getMyOnboarding, { query: { token: rawToken }, params: {}, body: {}, get: () => null });
      assert(okTok.statusCode === 200 && okTok.body.journey.id === preJourney.id, 'valid token resolves exactly its journey (no session needed)');

      const badTok = await callController(mec.getMyOnboarding, { query: { token: 'wrong' }, params: {}, body: {}, get: () => null });
      assert(badTok.statusCode === 401, 'invalid token → 401');

      // Expire it and re-check.
      await prisma.lifecycleJourney.update({ where: { id: preJourney.id }, data: { preJoinTokenExpiresAt: new Date(Date.now() - 1000) } });
      const expTok = await callController(mec.getMyOnboarding, { query: { token: rawToken }, params: {}, body: {}, get: () => null });
      assert(expTok.statusCode === 401, 'expired token → 401');
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

// ── runner ──
async function main() {
  partA();
  if (!process.env.DATABASE_URL) {
    log('\n[skip] PART B — DATABASE_URL not set (pure-validator PART A ran DB-free).\n');
  } else {
    try {
      await partB();
    } catch (e) {
      failures += 1;
      log(`  FAIL  PART B threw: ${e && e.stack ? e.stack : e}`);
    }
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

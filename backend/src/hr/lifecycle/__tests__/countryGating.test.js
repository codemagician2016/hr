'use strict';

/**
 * countryGating.test.js — proves the IN/NZ country-isolation fixes end-to-end.
 *
 * Plain-node (no jest), same harness as selfOnboarding.test.js. Run with:
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/countryGating.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 *
 * Proves (the country-leak cleanup, global payroll IN + NZ):
 *   1. /api/hr/me/profile resolves the signed-in employee's country from their
 *      StatutoryProfile / Employee row / entity — NZ stays NZ, IN stays IN.
 *   2. resolveCountryCode() for onboarding resolves an NZ entity to NZ (never the
 *      old hardcoded IN default), so the self-onboarding statutory validators pick
 *      the NZ rule set: PAN is rejected and IRD/tax-code is accepted for NZ.
 *   3. An India employee/journey still resolves IN: IRD-only is rejected and PAN
 *      is required (existing IN behavior unchanged for a single-country IN tenant).
 *
 * DB-FREE assertions (the masking currency pass-through + the validator gating)
 * run first so a missing hr_test DB still proves the pure logic.
 */

const assert = require('assert');

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}`); }
}
function log(s) { console.log(s); }

// ═══════════════════════════════════════════════════════════════════════════
// PART A — DB-FREE
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('=== PART A — DB-FREE (validator gating + currency pass-through) ===\n');

  const V = require('../validators');
  log('A1) validateStatutory gates the rule set strictly by countryCode:');
  // NZ → only NZ rules: PAN is meaningless, IRD+taxCode required.
  const nzWithPanOnly = V.validateStatutory('NZ', { pan: 'ABCDE1234F' });
  check('NZ payload with only a PAN → NOT ok (PAN is not an NZ field)', !nzWithPanOnly.ok);
  check('NZ payload missing IRD → irdNumber error (NZ rules applied, not IN)', !!nzWithPanOnly.errors.irdNumber);
  check('NZ payload has NO pan error key (India rule not run)', !nzWithPanOnly.errors.pan);
  const nzOk = V.validateStatutory('NZ', { irdNumber: '49091850', taxCode: 'M' });
  check('NZ valid IRD+taxCode → ok (no India fields needed)', nzOk.ok);

  // IN → only IN rules: IRD is ignored, PAN required.
  const inWithIrdOnly = V.validateStatutory('IN', { irdNumber: '49091850' });
  check('IN payload with only an IRD → NOT ok (PAN still required)', !inWithIrdOnly.ok);
  check('IN payload → pan error (India rules applied)', !!inWithIrdOnly.errors.pan);
  check('IN payload has NO irdNumber error key (NZ rule not run)', !inWithIrdOnly.errors.irdNumber);

  log('\nA2) maskCompensation passes the pay currency through at every visibility:');
  const { maskCompensation } = require('../../compensation/maskCompensation');
  const nzPayload = { id: 'r1', employeeId: 'e1', status: 'EFFECTIVE', currencyCode: 'NZD', ctcAnnual: 120000, grossMonthly: 10000 };
  const selfEnv = maskCompensation(nzPayload, { employeeId: 'e1' }, { level: 'SELF_ONLY' });
  check('SELF_ONLY envelope carries currencyCode=NZD (NZ employee sees NZD)', selfEnv.currencyCode === 'NZD');
  const rangeEnv = maskCompensation(nzPayload, { employeeId: 'other' }, { level: 'RANGE_ONLY' });
  check('RANGE_ONLY envelope still carries currencyCode=NZD (no INR fallback leak)', rangeEnv.currencyCode === 'NZD');
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test
// ═══════════════════════════════════════════════════════════════════════════
const PREFIX = 'CCGATE-TEST';

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
    if (!req.get) req.get = () => null;
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

async function partB() {
  log('\n=== PART B — LIVE hr_test (meProfile + onboarding country resolution) ===\n');
  const prisma = require('../../../core/lib/prisma');
  const meProfile = require('../controllers/meProfile.controller');
  const meOnb = require('../controllers/meOnboarding.controller');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const empIds = emps.map((e) => e.id);
    const journeys = await prisma.lifecycleJourney.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const jIds = journeys.map((j) => j.id);
    if (jIds.length) {
      await prisma.lifecycleTask.deleteMany({ where: { journeyId: { in: jIds } } });
      await prisma.lifecycleJourney.deleteMany({ where: { id: { in: jIds } } });
    }
    if (empIds.length) {
      await prisma.statutoryProfile.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    }
    await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    await prisma.entity.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  }
  await cleanup();

  // Seed an NZ entity + an IN entity under the same tenant so the resolution is
  // proven per-entity (not a global tenant assumption). Each gets one employee
  // linked to a customer by workEmail, plus a current EmploymentRecord.
  const nzEntity = await prisma.entity.create({
    data: {
      businessId, code: `${PREFIX}-NZ`, legalName: 'CCGATE NZ Ltd', countryCode: 'NZ',
      payCurrency: 'NZD', timezone: 'Pacific/Auckland', activeFrom: new Date('2026-01-01'),
    },
  });
  const inEntity = await prisma.entity.create({
    data: {
      businessId, code: `${PREFIX}-IN`, legalName: 'CCGATE IN Pvt', countryCode: 'IN',
      payCurrency: 'INR', timezone: 'Asia/Kolkata', activeFrom: new Date('2026-01-01'),
    },
  });

  const nzEmp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-NZE`, firstName: 'Kiri', lastName: 'NZ', status: 'ACTIVE', isActive: true, countryCode: 'NZ', workEmail: `${PREFIX}-nz@example.com` },
  });
  const inEmp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-INE`, firstName: 'Asha', lastName: 'IN', status: 'ACTIVE', isActive: true, countryCode: 'IN', workEmail: `${PREFIX}-in@example.com` },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: nzEmp.id, entityId: nzEntity.id, isCurrent: true, effectiveFrom: new Date('2026-01-01'), employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE' },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: inEmp.id, entityId: inEntity.id, isCurrent: true, effectiveFrom: new Date('2026-01-01'), employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE' },
  });
  // NZ employee carries an NZ StatutoryProfile (the most-specific country source).
  await prisma.statutoryProfile.create({
    data: { businessId, employeeId: nzEmp.id, countryCode: 'NZ', irdNumber: '49091850', taxCode: 'M' },
  });

  try {
    // ── B1: /me/profile resolves the employee's own country + currency ──
    log('B1) /me/profile resolves each employee\'s country (NZ stays NZ, IN stays IN):');
    {
      const nzRes = await callController(meProfile.getMyProfile, { customer: { id: 'c-nz', email: `${PREFIX}-nz@example.com`, businessId } });
      check('NZ employee profile → 200', nzRes.statusCode === 200);
      check('NZ employee profile.countryCode === NZ', nzRes.body.countryCode === 'NZ');
      check('NZ employee profile.payCurrency === NZD', nzRes.body.payCurrency === 'NZD');

      const inRes = await callController(meProfile.getMyProfile, { customer: { id: 'c-in', email: `${PREFIX}-in@example.com`, businessId } });
      check('IN employee profile.countryCode === IN', inRes.body.countryCode === 'IN');
      check('IN employee profile.payCurrency === INR', inRes.body.payCurrency === 'INR');

      const unknownRes = await callController(meProfile.getMyProfile, { customer: { id: 'c-x', email: `${PREFIX}-nobody@example.com`, businessId } });
      check('unknown (no employee) → countryCode null (fail-closed, no wrong default)', unknownRes.body.countryCode === null);
    }

    // ── B2: onboarding resolveCountryCode resolves NZ for an NZ journey ──
    log('\nB2) onboarding resolveCountryCode → the journey/entity country (NZ, not IN):');
    {
      const cc = await meOnb._internals.resolveCountryCode(businessId, { entityId: nzEntity.id, employeeId: nzEmp.id });
      check('NZ-entity journey resolves countryCode === NZ', cc === 'NZ');
      const ccIn = await meOnb._internals.resolveCountryCode(businessId, { entityId: inEntity.id, employeeId: inEmp.id });
      check('IN-entity journey resolves countryCode === IN', ccIn === 'IN');
    }

    // ── B3: an NZ onboarding journey rejects PAN and accepts IRD via the controller ──
    log('\nB3) NZ self-onboarding statutory: PAN rejected, IRD/tax-code accepted:');
    {
      const journey = await prisma.lifecycleJourney.create({
        data: {
          businessId, entityId: nzEntity.id, code: `${PREFIX}-J-NZ`, direction: 'ONBOARDING',
          employeeId: nzEmp.id, currentStage: 'SELF_ONBOARDING', status: 'IN_PROGRESS', joinDate: new Date('2026-08-01'),
          tasks: { create: [{ businessId, stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_STATUTORY', title: 'Statutory', ownerRole: 'NEW_HIRE', isBlocking: true, isMandatory: true, status: 'PENDING' }] },
        },
      });
      const customer = { id: 'c-nz', email: `${PREFIX}-nz@example.com`, businessId };
      const panAttempt = await callController(meOnb.postStatutory, { customer, query: {}, params: {}, body: { pan: 'ABCDE1234F' } });
      check('NZ journey: PAN-only statutory → 422 (India field not accepted for NZ)', panAttempt.statusCode === 422);
      check('NZ journey: 422 carries irdNumber error (NZ rule set applied)', !!(panAttempt.body.errors && panAttempt.body.errors.irdNumber));

      const irdAttempt = await callController(meOnb.postStatutory, { customer, query: {}, params: {}, body: { irdNumber: '49091850', taxCode: 'M' } });
      check('NZ journey: valid IRD+taxCode statutory → 200', irdAttempt.statusCode === 200);
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

(async () => {
  partA();
  try {
    await partB();
  } catch (e) {
    console.error('\nPART B could not run (hr_test DB?):', e.message);
    failed += 1;
  }
  console.log(`\ncountryGating: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();

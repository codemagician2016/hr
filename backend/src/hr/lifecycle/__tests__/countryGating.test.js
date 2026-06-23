'use strict';

/**
 * countryGating.test.js — proves the IN/NZ country-isolation fixes end-to-end.
 *
 * Plain-node (no jest), same harness as selfOnboarding.test.js. Run with:
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/countryGating.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 *
 * Proves (the country-leak cleanup):
 *   PART A (DB-free, unchanged): validateStatutory gates the rule set STRICTLY by
 *     the country it is handed (IN vs NZ), and maskCompensation passes the pay
 *     currency through (no INR fallback leak). These test the modules directly —
 *     they do NOT go through a tenant, so the NZ rule set stays unit-tested
 *     (deferred-path coverage per spec §11).
 *   PART B (live, Feature 14): under STRICT single-country mode, onboarding's
 *     resolveCountryCode() returns the TENANT country (Business.hrCountry) — the
 *     single source of truth — NOT a per-entity guess. The demo tenant is IN, so:
 *       B1. resolveCountryCode resolves IN regardless of which entity is pinned.
 *       B2. pinning an OFF-country (NZ) entity trips the fail-closed tripwire
 *           (COUNTRY_MISMATCH) — the wrong market is never silently served.
 *       B3. IN self-onboarding statutory still works: PAN accepted, IRD rejected.
 *
 * DB-FREE assertions run first so a missing hr_test DB still proves the pure logic.
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
  log('\n=== PART B — LIVE hr_test (Feature 14 single-country resolution) ===\n');
  const prisma = require('../../../core/lib/prisma');
  const meOnb = require('../controllers/meOnboarding.controller');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  // Feature 14 — the demo tenant is single-country IN. Ensure it is stamped (the
  // backfill does this in CI; the test makes itself self-sufficient).
  if (demo.hrCountry !== 'IN') {
    await prisma.business.update({
      where: { id: businessId },
      data: { hrCountry: 'IN', hrCurrency: 'INR', hrCountrySetAt: demo.hrCountrySetAt || new Date(), hrCountryAmbiguous: false },
    });
  }

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

  // An IN employee under the IN tenant (the single-country happy path), plus a
  // dormant off-country (NZ) entity to prove the fail-closed tripwire. The NZ
  // entity is the deferred-path fixture — it never surfaces for an IN tenant.
  const inEntity = await prisma.entity.create({
    data: {
      businessId, code: `${PREFIX}-IN`, legalName: 'CCGATE IN Pvt', countryCode: 'IN',
      payCurrency: 'INR', timezone: 'Asia/Kolkata', activeFrom: new Date('2026-01-01'),
    },
  });
  const offEntity = await prisma.entity.create({
    data: {
      businessId, code: `${PREFIX}-NZ`, legalName: 'CCGATE NZ Ltd', countryCode: 'NZ',
      payCurrency: 'NZD', timezone: 'Pacific/Auckland', activeFrom: new Date('2026-01-01'),
    },
  });
  const inEmp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-INE`, firstName: 'Asha', lastName: 'IN', status: 'ACTIVE', isActive: true, countryCode: 'IN', workEmail: `${PREFIX}-in@example.com` },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: inEmp.id, entityId: inEntity.id, isCurrent: true, effectiveFrom: new Date('2026-01-01'), employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE' },
  });

  try {
    // ── B1: resolveCountryCode returns the TENANT country (IN), not a per-entity guess ──
    log('B1) onboarding resolveCountryCode → the TENANT country (IN), single source of truth:');
    {
      const cc = await meOnb._internals.resolveCountryCode(businessId, { entityId: inEntity.id, employeeId: inEmp.id });
      check('IN-entity journey resolves countryCode === IN', cc === 'IN');
      const ccNoEntity = await meOnb._internals.resolveCountryCode(businessId, {});
      check('no entity pinned → still resolves IN (tenant country, not a default)', ccNoEntity === 'IN');
    }

    // ── B2: pinning an off-country entity trips the fail-closed tripwire ──
    log('\nB2) an OFF-country (NZ) entity under an IN tenant → COUNTRY_MISMATCH (fail-closed):');
    {
      let threw = null;
      try {
        await meOnb._internals.resolveCountryCode(businessId, { entityId: offEntity.id });
      } catch (e) { threw = e; }
      check('off-country entity → throws COUNTRY_MISMATCH (wrong market never served)', threw && threw.code === 'COUNTRY_MISMATCH');
    }

    // ── B3: IN self-onboarding statutory — PAN accepted, IRD rejected ──
    log('\nB3) IN self-onboarding statutory: PAN required/accepted, IRD-only rejected:');
    {
      await prisma.lifecycleJourney.create({
        data: {
          businessId, entityId: inEntity.id, code: `${PREFIX}-J-IN`, direction: 'ONBOARDING',
          employeeId: inEmp.id, currentStage: 'SELF_ONBOARDING', status: 'IN_PROGRESS', joinDate: new Date('2026-08-01'),
          tasks: { create: [{ businessId, stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_STATUTORY', title: 'Statutory', ownerRole: 'NEW_HIRE', isBlocking: true, isMandatory: true, status: 'PENDING' }] },
        },
      });
      const customer = { id: 'c-in', email: `${PREFIX}-in@example.com`, businessId };
      const irdAttempt = await callController(meOnb.postStatutory, { customer, query: {}, params: {}, body: { irdNumber: '49091850', taxCode: 'M' } });
      check('IN journey: IRD-only statutory → 422 (NZ field not accepted for IN)', irdAttempt.statusCode === 422);
      check('IN journey: 422 carries pan error (IN rule set applied)', !!(irdAttempt.body.errors && irdAttempt.body.errors.pan));
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

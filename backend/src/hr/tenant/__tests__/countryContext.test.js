'use strict';

/**
 * countryContext.test.js — Feature 14 slice 14a unit tests (plain-node, no jest).
 *
 *   DATABASE_URL="$HR_URL" node src/hr/tenant/__tests__/countryContext.test.js
 *
 * PART A is DB-FREE: capability matrix shape, currency mapping, registrable
 * allow-list, and the fail-closed asserts (mismatch / pre-setup / ambiguous)
 * driven through the per-request cache so no DB is required. PART B (optional)
 * stamps a throwaway tenant in hr_test and proves the live PK read resolves it.
 */

const assert = require('assert');

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}`); }
}
function log(s) { console.log(s); }

const C = require('../countryContext');

async function expectThrow(fn, code) {
  try { await fn(); return false; }
  catch (e) { return e && e.code === code; }
}

function partA() {
  log('=== PART A — DB-FREE (caps matrix + currency + fail-closed asserts) ===\n');

  log('A1) REGISTRABLE_HR_COUNTRIES is frozen to India in v1 (NZ behind the flip):');
  check('REGISTRABLE_HR_COUNTRIES === [IN]', JSON.stringify(C.REGISTRABLE_HR_COUNTRIES) === '["IN"]');
  check('REGISTRABLE_HR_COUNTRIES is frozen', Object.isFrozen(C.REGISTRABLE_HR_COUNTRIES));
  check('isRegistrableHrCountry(IN) true', C.isRegistrableHrCountry('IN') === true);
  check('isRegistrableHrCountry(in) true (case-insensitive)', C.isRegistrableHrCountry('in') === true);
  check('isRegistrableHrCountry(NZ) false (deferred)', C.isRegistrableHrCountry('NZ') === false);
  check('isRegistrableHrCountry(US) false', C.isRegistrableHrCountry('US') === false);

  log('\nA2) currency mapping flows through the shared currency lib:');
  check('payCurrencyFor(IN) === INR', C.payCurrencyFor('IN') === 'INR');
  check('payCurrencyFor(NZ) === NZD (mapping still correct for §12)', C.payCurrencyFor('NZ') === 'NZD');

  log('\nA3) capability matrix shape (the front-end contract):');
  const inCaps = C.countryCapabilities('IN');
  check('IN caps present', !!inCaps);
  check('IN currency INR', inCaps.currency === 'INR');
  check('IN tax regimes [NEW,OLD] default NEW', JSON.stringify(inCaps.tax.regimes) === '["NEW","OLD"]' && inCaps.tax.default === 'NEW');
  check('IN statutoryIds = PAN/AADHAAR/UAN/IFSC', JSON.stringify(inCaps.statutoryIds) === '["PAN","AADHAAR","UAN","IFSC"]');
  check('IN payrollStatutory has EPF+ESI+PT+TDS', ['EPF', 'ESI', 'PT', 'TDS'].every((k) => inCaps.payrollStatutory.includes(k)));
  check('IN compBasis CTC + basicFloorPct 50', inCaps.compBasis === 'CTC' && inCaps.basicFloorPct === 50);
  check('IN leaveSandwich INCLUSIVE', inCaps.leaveSandwich === 'INCLUSIVE');
  check('IN letterLocale en-IN', inCaps.letterLocale === 'en-IN');
  check('IN no mondayisation', inCaps.holidays.mondayisation === false);
  check('IN caps are frozen (immutable contract)', Object.isFrozen(inCaps));

  const nzCaps = C.countryCapabilities('NZ');
  check('NZ caps present (registered for §12, just unreachable)', !!nzCaps);
  check('NZ currency NZD', nzCaps.currency === 'NZD');
  check('NZ statutoryIds = IRD/NZ_BANK_ACCOUNT (no PAN)', JSON.stringify(nzCaps.statutoryIds) === '["IRD","NZ_BANK_ACCOUNT"]');
  check('NZ mondayisation true (Holidays Act)', nzCaps.holidays.mondayisation === true);
  check('NZ leaveSandwich EXCLUSIVE', nzCaps.leaveSandwich === 'EXCLUSIVE');
  check('unknown country caps → null', C.countryCapabilities('ZZ') === null);

  log('\nA4) loadHrCountry / assertCountry fail-closed via per-request cache:');
  // Prime the cache so no DB read happens; this is the same memo path real requests use.
  const cacheIN = new Map([['biz-in', { country: 'IN', currency: 'INR', ambiguous: false }]]);
  (async () => {
    check('tenantCountry(IN) === IN', (await C.tenantCountry('biz-in', { cache: cacheIN })) === 'IN');
    check('tenantCurrency(IN) === INR', (await C.tenantCurrency('biz-in', { cache: cacheIN })) === 'INR');
    check('assertCountry(IN, IN) ok', (await C.assertCountry('biz-in', 'IN', { cache: cacheIN })) === 'IN');
    check('assertCountry(IN, in) ok (case-insensitive)', (await C.assertCountry('biz-in', 'in', { cache: cacheIN })) === 'IN');
    check('assertCountry(IN, NZ) → COUNTRY_MISMATCH', await expectThrow(() => C.assertCountry('biz-in', 'NZ', { cache: cacheIN }), 'COUNTRY_MISMATCH'));

    const caps = await C.tenantCapabilities('biz-in', { cache: cacheIN });
    check('tenantCapabilities returns { country, currency, capabilities }', caps.country === 'IN' && caps.currency === 'INR' && !!caps.capabilities);

    check('missing businessId → TENANT_NOT_FOUND', await expectThrow(() => C.tenantCountry(null, { cache: new Map() }), 'TENANT_NOT_FOUND'));
  })();
}

async function partB() {
  log('\n=== PART B — LIVE hr_test (PK read of a stamped tenant) ===\n');
  const prisma = require('../../../core/lib/prisma');
  const PREFIX = 'F14CTX-TEST';
  async function cleanup() {
    await prisma.business.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  }
  await cleanup();
  try {
    const stamped = await prisma.business.create({
      data: { name: 'F14 ctx IN', slug: `${PREFIX}-in`, hrCountry: 'IN', hrCurrency: 'INR', hrCountrySetAt: new Date() },
    });
    const ambiguous = await prisma.business.create({
      data: { name: 'F14 ctx amb', slug: `${PREFIX}-amb`, hrCountryAmbiguous: true },
    });
    const presetup = await prisma.business.create({
      data: { name: 'F14 ctx pre', slug: `${PREFIX}-pre` },
    });

    check('stamped tenant resolves IN (live PK read, no cache)', (await C.tenantCountry(stamped.id)) === 'IN');
    check('stamped tenant currency INR', (await C.tenantCurrency(stamped.id)) === 'INR');
    check('ambiguous tenant → HR_COUNTRY_AMBIGUOUS (409, quarantined)', await expectThrow(() => C.tenantCountry(ambiguous.id), 'HR_COUNTRY_AMBIGUOUS'));
    check('pre-setup tenant → HR_NOT_SET_UP (409)', await expectThrow(() => C.tenantCountry(presetup.id), 'HR_NOT_SET_UP'));
    check('unknown businessId → TENANT_NOT_FOUND (404)', await expectThrow(() => C.tenantCountry('00000000-0000-0000-0000-000000000000'), 'TENANT_NOT_FOUND'));
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

(async () => {
  partA();
  // give the async A4 IIFE a tick to settle before PART B
  await new Promise((r) => setTimeout(r, 50));
  try {
    await partB();
  } catch (e) {
    console.error('\nPART B could not run (hr_test DB?):', e.message);
    failed += 1;
  }
  console.log(`\ncountryContext: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();

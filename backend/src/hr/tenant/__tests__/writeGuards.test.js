'use strict';

/**
 * writeGuards.test.js — Feature 14 slices 14b+14c live tests (plain-node, no jest).
 *
 *   DATABASE_URL="$HR_URL" node src/hr/tenant/__tests__/writeGuards.test.js
 *
 * Proves, against a throwaway IN tenant in hr_test:
 *   - setupCountry sets the country once; a second call → 409 HR_COUNTRY_LOCKED.
 *   - a non-registrable country (NZ) at setup → 422 NOT_REGISTRABLE.
 *   - assertTenantCountryWrite: off-country create → 422; absent → stamped IN.
 *   - assertTenantCurrencyWrite: off-currency → 422.
 *   - GET country-context (operator + me) returns the IN capability matrix.
 *   - super-admin read returns the tenant state; resolve refuses a non-ambiguous
 *     tenant (409 NOT_AMBIGUOUS).
 */

const assert = require('assert');

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}`); }
}
function log(s) { console.log(s); }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function run(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}
// Drive a middleware: resolves { res, passed:boolean } — passed=true if next() ran w/o response.
function runMw(mw, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const next = (err) => { if (err) { settled = true; return reject(err); } if (!settled) { settled = true; resolve({ res, passed: true }); } };
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); if (!settled) { settled = true; resolve({ res, passed: false }); } return r; };
    Promise.resolve(mw(req, res, next)).catch(reject);
  });
}

async function main() {
  const prisma = require('../../../core/lib/prisma');
  const ctrl = require('../../controllers/countryContext.controller');
  const sa = require('../../../superadmin/controllers/tenantCountry.controller');
  const { assertTenantCountryWrite, assertTenantCurrencyWrite } = require('../assertTenantCountry.middleware');

  const PREFIX = 'F14WG-TEST';
  async function cleanup() {
    const bs = await prisma.business.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } });
    for (const b of bs) {
      await prisma.entity.deleteMany({ where: { businessId: b.id } });
    }
    await prisma.business.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  }
  await cleanup();

  try {
    // A pre-setup tenant (hrCountry NULL) so we exercise setupCountry from scratch.
    const biz = await prisma.business.create({ data: { name: 'F14 WG', slug: `${PREFIX}-1` } });
    const opReq = (body = {}) => ({ user: { businessId: biz.id }, body });
    const custReq = () => ({ customer: { businessId: biz.id } });

    log('=== setupCountry (lock-once + allow-list) ===');
    {
      const nz = await run(ctrl.setupCountry, opReq({ country: 'NZ' }));
      check('setup NZ → 422 NOT_REGISTRABLE (deferred market)', nz.statusCode === 422 && nz.body.code === 'NOT_REGISTRABLE');

      const ok = await run(ctrl.setupCountry, opReq({ country: 'IN' }));
      check('setup IN → 200 with capabilities', ok.statusCode === 200 && ok.body.country === 'IN' && ok.body.currency === 'INR' && !!ok.body.capabilities);

      const again = await run(ctrl.setupCountry, opReq({ country: 'IN' }));
      check('second setup → 409 HR_COUNTRY_LOCKED (immutable)', again.statusCode === 409 && again.body.code === 'HR_COUNTRY_LOCKED');
    }

    log('\n=== country-context endpoints ===');
    {
      const op = await run(ctrl.getCountryContext, opReq());
      check('GET /country-context → IN matrix', op.statusCode === 200 && op.body.country === 'IN' && op.body.capabilities.statutoryIds.includes('PAN'));
      check('country-context exposes NO NZ field (no IRD in statutoryIds)', !op.body.capabilities.statutoryIds.includes('IRD'));

      const me = await run(ctrl.getMyCountryContext, custReq());
      check('GET /me/country-context → IN matrix (ESS)', me.statusCode === 200 && me.body.currency === 'INR');
    }

    log('\n=== write-guards (fail-closed) ===');
    {
      // off-country entity create → 422
      const off = await runMw(assertTenantCountryWrite('body.countryCode'), opReq({ countryCode: 'NZ' }));
      check('entity create countryCode:NZ → blocked 422 COUNTRY_MISMATCH', !off.passed && off.res.statusCode === 422 && off.res.body.code === 'COUNTRY_MISMATCH');

      // matching → passes
      const match = await runMw(assertTenantCountryWrite('body.countryCode'), opReq({ countryCode: 'IN' }));
      check('entity create countryCode:IN → passes', match.passed === true);

      // absent → stamped IN
      const stampReq = opReq({});
      const stamped = await runMw(assertTenantCountryWrite('body.countryCode'), stampReq);
      check('entity create with NO country → stamped to IN', stamped.passed === true && stampReq.body.countryCode === 'IN');

      // off-currency comp → 422
      const offCur = await runMw(assertTenantCurrencyWrite('body.currencyCode'), opReq({ currencyCode: 'NZD' }));
      check('comp currencyCode:NZD → blocked 422 CURRENCY_MISMATCH', !offCur.passed && offCur.res.statusCode === 422 && offCur.res.body.code === 'CURRENCY_MISMATCH');

      // matching currency → passes
      const okCur = await runMw(assertTenantCurrencyWrite('body.currencyCode'), opReq({ currencyCode: 'INR' }));
      check('comp currencyCode:INR → passes', okCur.passed === true);

      // employee create with no country (stampWhenAbsent:false) → passes, stays null
      const empReq = opReq({});
      const emp = await runMw(assertTenantCountryWrite('body.countryCode', { stampWhenAbsent: false }), empReq);
      check('employee create with NO country → passes, country NOT stamped (nullable)', emp.passed === true && empReq.body.countryCode == null);
    }

    log('\n=== super-admin read + resolve guard ===');
    {
      const read = await run(sa.getTenantCountry, { params: { id: biz.id }, body: {} });
      check('super-admin read → hrCountry IN, not ambiguous', read.statusCode === 200 && read.body.hrCountry === 'IN' && read.body.hrCountryAmbiguous === false);

      const resolve = await run(sa.resolveTenantCountry, { params: { id: biz.id }, body: { country: 'IN' } });
      check('resolve on a non-ambiguous tenant → 409 NOT_AMBIGUOUS (immutable)', resolve.statusCode === 409 && resolve.body.code === 'NOT_AMBIGUOUS');
    }

    log('\n=== pre-setup tenant fail-closed ===');
    {
      const pre = await prisma.business.create({ data: { name: 'F14 WG pre', slug: `${PREFIX}-pre` } });
      const guard = await runMw(assertTenantCountryWrite('body.countryCode'), { user: { businessId: pre.id }, body: { countryCode: 'IN' } });
      check('country write on pre-setup tenant → 409 HR_NOT_SET_UP (fail-closed)', !guard.passed && guard.res.statusCode === 409 && guard.res.body.code === 'HR_NOT_SET_UP');
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main()
  .then(() => { console.log(`\nwriteGuards: ${passed} passed, ${failed} failed.`); process.exit(failed === 0 ? 0 : 1); })
  .catch((e) => { console.error('writeGuards could not run:', e); process.exit(1); });

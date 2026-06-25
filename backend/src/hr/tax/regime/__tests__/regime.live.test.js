'use strict';

/*
 * regime.live.test.js — Feature 15/25 LIVE (hr_test) proof of the income-tax REGIME
 * election service against a real Postgres (the new TaxRegimePolicy table +
 * StatutoryProfile.regimeLockedAt column). Plain-node assert:
 *   DATABASE_URL="$HR_URL" node src/hr/tax/regime/__tests__/regime.live.test.js
 * where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'.
 *
 * Proves end-to-end (real rows):
 *   - getEffectiveRegime falls back elected → employer DEFAULT → statutory NEW;
 *   - electRegime persists taxRegime + appends a StatutoryElectionHistory row;
 *   - an election past the lock date is REJECTED (WINDOW_CLOSED);
 *   - lockRegime stamps regimeLockedAt and then blocks further election (REGIME_LOCKED);
 *   - cross-tenant employeeId → NOT_FOUND.
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const regime = require('../regime.service');

const PREFIX = 'F15REGIME';
const FY = '2026-27';

let passed = 0; let failed = 0;
const fails = [];
function ok(name, cond) { if (cond) passed += 1; else { failed += 1; fails.push(name); console.error(`FAIL ${name}`); } }
async function throwsCode(name, fn, code) {
  try { await fn(); failed += 1; fails.push(`${name} (no throw)`); console.error(`FAIL ${name} (no throw)`); }
  catch (e) { ok(name, e && e.code === code); }
}

async function cleanup(businessId) {
  if (!businessId) return;
  await prisma.statutoryElectionHistory.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.statutoryProfile.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.taxRegimePolicy.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { businessId } }).catch(() => {});
  await prisma.business.deleteMany({ where: { id: businessId } }).catch(() => {});
}

(async () => {
  let businessId;
  let otherBusinessId;
  try {
    const stamp = Date.now();
    const biz = await prisma.business.create({ data: { name: `${PREFIX} Co`, slug: `${PREFIX.toLowerCase()}-${stamp}`, hrCountry: 'IN' } });
    businessId = biz.id;
    const other = await prisma.business.create({ data: { name: `${PREFIX} Other`, slug: `${PREFIX.toLowerCase()}-other-${stamp}`, hrCountry: 'IN' } });
    otherBusinessId = other.id;

    const emp = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-1`, firstName: 'Reg', lastName: 'Ime', countryCode: 'IN', isActive: true },
    });
    const otherEmp = await prisma.employee.create({
      data: { businessId: otherBusinessId, code: `${PREFIX}-O`, firstName: 'Other', lastName: 'Tenant', countryCode: 'IN', isActive: true },
    });

    // 1. No election + no policy → statutory NEW.
    {
      const r = await regime.getEffectiveRegime({ businessId, employeeId: emp.id, fy: FY });
      ok('no election + no policy → NEW/STATUTORY', r.regime === 'NEW' && r.source === 'STATUTORY');
    }

    // 2. Employer DEFAULT OLD → un-elected employee resolves to OLD/DEFAULT.
    await regime.setPolicy({ businessId, fy: FY, defaultRegime: 'OLD', actorId: 'hr-1' });
    {
      const r = await regime.getEffectiveRegime({ businessId, employeeId: emp.id, fy: FY });
      ok('un-elected + default OLD → OLD/DEFAULT', r.regime === 'OLD' && r.source === 'DEFAULT');
    }

    // 3. electRegime persists + appends history; effective becomes ELECTED.
    {
      const out = await regime.electRegime({ businessId, employeeId: emp.id, fy: FY, regime: 'NEW', actorId: 'u-emp' });
      ok('elect NEW changed=true', out.changed === true && out.regime === 'NEW');
      const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });
      ok('SP.taxRegime persisted = NEW', sp && sp.taxRegime === 'NEW');
      const hist = await prisma.statutoryElectionHistory.findMany({ where: { businessId, statutoryProfileId: sp.id, field: 'taxRegime' } });
      ok('one taxRegime history row written', hist.length === 1 && hist[0].newValue === 'NEW');
      const r = await regime.getEffectiveRegime({ businessId, employeeId: emp.id, fy: FY });
      ok('after elect NEW → effective NEW/ELECTED', r.regime === 'NEW' && r.source === 'ELECTED');
    }

    // 4. Election PAST the lock date is rejected (WINDOW_CLOSED).
    await regime.setPolicy({ businessId, fy: FY, electionLockDate: '2020-01-01' });
    await throwsCode('elect past lock date → WINDOW_CLOSED',
      () => regime.electRegime({ businessId, employeeId: emp.id, fy: FY, regime: 'OLD', actorId: 'u-emp' }),
      'WINDOW_CLOSED');

    // Re-open the window for the lock test.
    await regime.setPolicy({ businessId, fy: FY, electionLockDate: '2999-01-01' });

    // 5. lockRegime stamps regimeLockedAt and then blocks further election.
    {
      const r = await regime.lockRegime({ businessId, employeeId: emp.id });
      ok('lockRegime locked one', r.locked === 1);
      const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });
      ok('regimeLockedAt stamped', sp && sp.regimeLockedAt != null);
    }
    await throwsCode('elect when locked → REGIME_LOCKED',
      () => regime.electRegime({ businessId, employeeId: emp.id, fy: FY, regime: 'OLD', actorId: 'u-emp' }),
      'REGIME_LOCKED');

    // 6. Cross-tenant employeeId → NOT_FOUND (tenant wall).
    await throwsCode('cross-tenant elect → NOT_FOUND',
      () => regime.electRegime({ businessId, employeeId: otherEmp.id, fy: FY, regime: 'NEW', actorId: 'u-emp' }),
      'NOT_FOUND');

    console.log(`\nFeature 15/25 regime live test: ${passed} passed, ${failed} failed.`);
    if (failed) { console.error('FAILURES:', fails.join('; ')); process.exitCode = 1; }
  } catch (e) {
    console.error('SUITE ERROR:', e);
    process.exitCode = 1;
  } finally {
    await cleanup(businessId);
    await cleanup(otherBusinessId);
    await prisma.$disconnect();
  }
})();

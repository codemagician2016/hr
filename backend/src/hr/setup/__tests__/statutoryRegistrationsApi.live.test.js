'use strict';

/*
 * statutoryRegistrationsApi.live.test.js — LIVE (hr_test) proof of
 * /api/hr/statutory-registrations, the CRUD door that did not exist until now.
 *
 * Three steps of the setup guide (statutory_registrations, compliance_calendar,
 * statutory_registers) and the whole compliance calendar hang off this table —
 * calendarRunner.seedObligationsForEntity uses it as the APPLICABILITY gate — so the
 * things asserted here are the ones that would quietly break a filing:
 *   A) create/list/patch/deactivate, with a SOFT delete (the row is the historical
 *      applicability record behind already-generated obligations)
 *   B) tenant isolation — a foreign entityId or a foreign :id 404s, never 403s
 *   C) the natural key @@unique([businessId, entityId, kind, stateCode]) surfaces as
 *      a readable 409, never a raw Prisma error
 *   D) validation: unknown kind, wrong-country kind, PT/LWF without a state
 *   E) the setup step it exists to make completable actually turns green
 *
 *   DATABASE_URL="$HR_URL" node src/hr/setup/__tests__/statutoryRegistrationsApi.live.test.js
 */

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PFX = 'STATREG';
const BIZ = `${PFX}-biz-1`;
const BIZ2 = `${PFX}-biz-2`;

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}
async function call(handler, { user, params = {}, query = {}, body = {} }) {
  const res = mockRes();
  await new Promise((resolve, reject) => {
    const done = () => resolve();
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res); res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler({ user, params, query, body }, res, (e) => (e ? reject(e) : done()))).catch(reject);
  });
  return res;
}

async function main() {
  log('\n=== Entity → Registrations API (EPFO / ESIC / PT / TAN) ===\n');

  if (!process.env.DATABASE_URL) { log('[skip] DATABASE_URL not set — needs the live hr_test schema.\n'); return; }

  const prisma = require('../../../core/lib/prisma');
  const entitlementsLib = require('../../../core/lib/entitlements');
  entitlementsLib.hrEntitlements = async () => ({ talent_acquisition: { enabled: false, source: 'fallback' } });

  const ctrl = require('../../controllers/statutoryRegistrations.controller');
  const setupCtrl = require('../../controllers/setupChecklist.controller');

  async function teardown() {
    for (const id of [BIZ, BIZ2]) {
      await prisma.statutoryRegistration.deleteMany({ where: { businessId: id } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { businessId: id } }).catch(() => {});
      await prisma.entity.deleteMany({ where: { businessId: id } }).catch(() => {});
      await prisma.business.deleteMany({ where: { id } }).catch(() => {});
    }
  }
  await teardown();

  const mkBiz = (id, slug, country) => prisma.business.create({
    data: { id, name: `${id} Pvt`, slug, hrCountry: country, hrCurrency: country === 'IN' ? 'INR' : 'NZD', hrCountrySetAt: new Date() },
  });
  const mkEnt = (biz, code, country) => prisma.entity.create({
    data: {
      businessId: biz, code, legalName: code, countryCode: country,
      payCurrency: country === 'IN' ? 'INR' : 'NZD',
      timezone: country === 'IN' ? 'Asia/Kolkata' : 'Pacific/Auckland',
      stateCode: country === 'IN' ? 'KA' : 'AUK', activeFrom: new Date(Date.UTC(2020, 3, 1)),
    },
  });

  await mkBiz(BIZ, `${PFX.toLowerCase()}-1`, 'IN');
  await mkBiz(BIZ2, `${PFX.toLowerCase()}-2`, 'IN');
  const entA = await mkEnt(BIZ, `${PFX}-A-HQ`, 'IN');
  const entForeign = await mkEnt(BIZ2, `${PFX}-B-HQ`, 'IN');

  const user = { id: `${PFX}-user`, businessId: BIZ, role: 'BUSINESS_ADMIN' };
  const foreignUser = { id: `${PFX}-user-2`, businessId: BIZ2, role: 'BUSINESS_ADMIN' };

  // ══════════════════════════════════════════════════════════════════════════
  log('A) Create / list / patch / deactivate\n');

  let epfId = null;
  {
    const res = await call(ctrl.create, {
      user,
      body: { entityId: entA.id, kind: 'EPF', number: 'KNBNG1234567000', effectiveFrom: '2020-04-01' },
    });
    ok(res.statusCode === 201, `create EPF → 201 (got ${res.statusCode})`);
    epfId = res.body && res.body.id;
    ok(res.body.kind === 'EPF' && res.body.number === 'KNBNG1234567000', 'the row comes back with its kind + number');
    ok(res.body.isActive === true, 'and is active on creation');
    ok(res.body.entityId === entA.id, 'attached to the company it was filed under');
  }

  {
    // PT is levied per state, so the state is part of the natural key.
    const res = await call(ctrl.create, {
      user,
      body: { entityId: entA.id, kind: 'PT_STATE', number: 'PT-KA-99887766', stateCode: 'ka', effectiveFrom: '2020-04-01' },
    });
    ok(res.statusCode === 201, `create PT_STATE with a state → 201 (got ${res.statusCode})`);
    ok(res.body.stateCode === 'KA', 'the state code is normalised to upper case (the calendar matches on it)');
  }

  {
    const res = await call(ctrl.list, { user, query: {} });
    ok(res.statusCode === 200, 'list → 200');
    ok(res.body.items.length === 2, `both registrations are listed (${res.body.items.length})`);
    ok(res.body.items.every((r) => r.entity && r.entity.code), 'each row carries its company for display');
    ok(Array.isArray(res.body.kinds) && res.body.kinds.includes('TAN'), 'the payload offers the registration types the picker needs');

    const scoped = await call(ctrl.list, { user, query: { entityId: entA.id } });
    ok(scoped.body.items.length === 2, 'filtering by company works');
  }

  {
    const res = await call(ctrl.update, { user, params: { id: epfId }, body: { number: 'KNBNG7654321000' } });
    ok(res.statusCode === 200 && res.body.number === 'KNBNG7654321000', 'patching the number → 200');
    const audited = await prisma.auditLog.count({ where: { businessId: BIZ, action: 'statutory.registration.update' } });
    ok(audited === 1, 'the change is audited');
  }

  {
    const res = await call(ctrl.remove, { user, params: { id: epfId } });
    ok(res.statusCode === 200, 'delete → 200');
    const row = await prisma.statutoryRegistration.findUnique({ where: { id: epfId } });
    ok(row !== null && row.isActive === false, 'delete is a SOFT delete — the applicability history survives');

    const back = await call(ctrl.update, { user, params: { id: epfId }, body: { isActive: true } });
    ok(back.body.isActive === true, 'and it can be reactivated');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nB) Tenant isolation\n');
  {
    const foreignEntity = await call(ctrl.create, {
      user,
      body: { entityId: entForeign.id, kind: 'TAN', number: 'BLRA00000A', effectiveFrom: '2020-04-01' },
    });
    ok(foreignEntity.statusCode === 404, `filing against ANOTHER tenant's company → 404 (got ${foreignEntity.statusCode})`);
    const leaked = await prisma.statutoryRegistration.count({ where: { entityId: entForeign.id } });
    ok(leaked === 0, 'and nothing is written');

    const read = await call(ctrl.list, { user: foreignUser, query: {} });
    ok(read.body.items.length === 0, "a foreign tenant's list does not contain this tenant's registrations");

    const patch = await call(ctrl.update, { user: foreignUser, params: { id: epfId }, body: { number: 'HACKED' } });
    ok(patch.statusCode === 404, `a foreign-tenant PATCH → 404, not 403 (no existence oracle) (got ${patch.statusCode})`);
    const del = await call(ctrl.remove, { user: foreignUser, params: { id: epfId } });
    ok(del.statusCode === 404, `a foreign-tenant DELETE → 404 (got ${del.statusCode})`);
    const still = await prisma.statutoryRegistration.findUnique({ where: { id: epfId } });
    ok(still.number === 'KNBNG7654321000' && still.isActive === true, 'the row is untouched by both attempts');

    const scopedQuery = await call(ctrl.list, { user, query: { entityId: entForeign.id } });
    ok(scopedQuery.statusCode === 404, `filtering by a foreign company id → 404 (got ${scopedQuery.statusCode})`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nC) The natural key surfaces as a readable 409\n');
  {
    const dup = await call(ctrl.create, {
      user, body: { entityId: entA.id, kind: 'EPF', number: 'KNBNG0000000000', effectiveFrom: '2021-04-01' },
    });
    // NOTE: the DB constraint alone does NOT catch this — stateCode is NULL for an
    // entity-wide kind and Postgres treats NULLs as distinct — so this proves the
    // controller's explicit pre-check, not the index.
    ok(dup.statusCode === 409, `a second EPF for the same company → 409 (got ${dup.statusCode})`);
    ok(/already has/i.test(dup.body.message || '') && !!dup.body.existingId, `with a readable message pointing at the existing row ("${dup.body.message}")`);

    // …but the SAME kind in a different state is a legitimate second row.
    const otherState = await call(ctrl.create, {
      user, body: { entityId: entA.id, kind: 'PT_STATE', number: 'PT-MH-11223344', stateCode: 'MH', effectiveFrom: '2021-04-01' },
    });
    ok(otherState.statusCode === 201, 'a PT registration in a SECOND state is allowed (PT is per state)');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nD) Validation\n');
  {
    const cases = [
      [{ entityId: entA.id, kind: 'NOPE', number: 'X', effectiveFrom: '2020-04-01' }, 'an unknown registration type'],
      [{ entityId: entA.id, kind: 'ACC', number: 'X', effectiveFrom: '2020-04-01' }, "a New Zealand type on an India company"],
      [{ entityId: entA.id, kind: 'LWF', number: 'X', effectiveFrom: '2020-04-01' }, 'LWF without a state (it is a state levy)'],
      [{ entityId: entA.id, kind: 'TAN', number: '   ', effectiveFrom: '2020-04-01' }, 'a blank registration number'],
      [{ entityId: entA.id, kind: 'TAN', number: 'BLRA00000A' }, 'a missing effective-from date'],
      [{ entityId: entA.id, kind: 'TAN', number: 'BLRA00000A', effectiveFrom: 'not-a-date' }, 'an unparseable date'],
      [{ entityId: entA.id, kind: 'TAN', number: 'BLRA00000A', effectiveFrom: '2021-04-01', effectiveTo: '2020-04-01' }, 'an end date before the start'],
    ];
    for (const [body, label] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(ctrl.create, { user, body });
      ok(res.statusCode === 422, `${label} → 422 (got ${res.statusCode})`);
    }
    const noEntity = await call(ctrl.create, { user, body: { kind: 'TAN', number: 'BLRA00000A', effectiveFrom: '2020-04-01' } });
    ok(noEntity.statusCode === 404, `a missing company id → 404 (got ${noEntity.statusCode})`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nE) The setup step this API exists to unblock\n');
  {
    // Every ACTIVE India company needs at least one active registration.
    const p = (await call(setupCtrl.getChecklist, { user })).body;
    const s = p.stages.reduce((a, st) => a.concat(st.steps), []).find((x) => x.key === 'statutory_registrations');
    ok(s !== undefined, 'the India-only statutory-registrations step is present');
    ok(s.completed === true, 'and now reads DONE — the step is deliverable end to end');
    ok(s.coverage && s.coverage.total === 1 && s.coverage.unit === 'companies', `with per-company coverage (${s.coverage.done}/${s.coverage.total} ${s.coverage.unit})`);
    ok(s.route === '/org/registrations', 'and deep-links to the screen Track 2 ships');

    // A second uncovered company must drop it back to not-done.
    await mkEnt(BIZ, `${PFX}-A-2`, 'IN');
    const p2 = (await call(setupCtrl.getChecklist, { user })).body;
    const s2 = p2.stages.reduce((a, st) => a.concat(st.steps), []).find((x) => x.key === 'statutory_registrations');
    ok(s2.completed === false && s2.coverage.done === 1 && s2.coverage.total === 2, `a second uncovered company reopens it (${s2.coverage.done}/${s2.coverage.total})`);
  }

  await teardown();
  log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

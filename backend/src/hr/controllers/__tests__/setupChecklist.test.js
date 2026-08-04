'use strict';

/**
 * setupChecklist.test.js — Setup Guide API proof (GET /api/hr/setup-checklist).
 *
 * Same harness as companyProfile.test.js in this directory: plain node runner,
 * fakeRes + callController, DATABASE_URL-gated. Unlike that test it builds its OWN
 * throwaway tenants rather than leaning on the `demo` seed, because the whole point
 * of a completion score is that it reflects exactly what a tenant has, and a shared
 * seed drifts.
 *
 * Covers the four things that would be silently wrong in production:
 *   A) LOCKED steps are excluded from the percentage (both numerator AND
 *      denominator), so 100% is reachable on a plan without the add-on — and they
 *      are still RETURNED so the UI can render the upsell row.
 *   B) TENANT SCOPING — a second tenant's entities/employees/pay runs never bleed
 *      into this tenant's score, and businessId is taken from the session only.
 *   C) A THROWING PROBE degrades that one step to "couldn't check" and the endpoint
 *      still answers 200 with an honest percent. When every probe fails, percent is
 *      null rather than a fabricated 0 or 100.
 *   D) NEXT ACTION selection — deterministic, prerequisite-aware, permission-aware,
 *      and it moves on as steps are completed.
 *
 * Run (needs the live schema + the additive Business.setupState column):
 *   DATABASE_URL="$HR_URL" node src/hr/controllers/__tests__/setupChecklist.test.js
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

const PREFIX = 'SETUP-TEST';
const BIZ_A = `${PREFIX}-biz-a`;
const BIZ_B = `${PREFIX}-biz-b`;

// Find a step row inside the staged payload.
function step(payload, key) {
  for (const stage of payload.stages) {
    const found = stage.steps.find((s) => s.key === key);
    if (found) return found;
  }
  return null;
}
function allSteps(payload) {
  return payload.stages.reduce((acc, s) => acc.concat(s.steps), []);
}

async function main() {
  log('\n=== Setup checklist API — score, scoping, resilience, next action ===\n');

  if (!process.env.DATABASE_URL) {
    log('[skip] DATABASE_URL not set — needs the live hr_test schema.\n');
    return;
  }

  const prisma = require('../../../core/lib/prisma');

  // The controller destructures hrEntitlements at require time, so the stub has to
  // be installed BEFORE the controller module is loaded.
  const entitlementsLib = require('../../../core/lib/entitlements');
  let entitlementStub = { talent_acquisition: { enabled: false, source: 'fallback' } };
  entitlementsLib.hrEntitlements = async () => entitlementStub;

  const ctrl = require('../setupChecklist.controller');
  const { PROBES } = require('../../setup/probes');
  const { STEPS } = require('../../setup/checklistItems');

  // Does the additive column exist on this environment? Reads fail soft without it,
  // but the dismiss/restore writes cannot, so we say so rather than fail obscurely.
  let hasSetupStateColumn = true;
  try {
    await prisma.business.findFirst({ where: { id: BIZ_A }, select: { setupState: true } });
  } catch (_e) { hasSetupStateColumn = false; }

  async function teardown() {
    for (const id of [BIZ_A, BIZ_B]) {
      await prisma.compensationRevision.deleteMany({ where: { businessId: id } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { businessId: id } }).catch(() => {});
      await prisma.entity.deleteMany({ where: { businessId: id } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { businessId: id } }).catch(() => {});
      await prisma.business.deleteMany({ where: { id } }).catch(() => {});
    }
  }
  await teardown();

  // ── Fixtures: two isolated India tenants ───────────────────────────────────
  await prisma.business.create({
    data: {
      id: BIZ_A, name: `${PREFIX} A Pvt Ltd`, slug: `${PREFIX.toLowerCase()}-a`,
      hrCountry: 'IN', hrCurrency: 'INR', hrCountrySetAt: new Date(),
    },
  });
  await prisma.business.create({
    data: {
      id: BIZ_B, name: `${PREFIX} B Pvt Ltd`, slug: `${PREFIX.toLowerCase()}-b`,
      hrCountry: 'IN', hrCurrency: 'INR', hrCountrySetAt: new Date(),
    },
  });

  // Owner-equivalent session for tenant A. `role: BUSINESS_ADMIN` with no
  // businessRole resolves to the all-true legacy preset, so this operator holds
  // every permission — the maximal scope, which makes the score deterministic.
  const owner = { id: `${PREFIX}-user`, businessId: BIZ_A, role: 'BUSINESS_ADMIN' };
  const req = () => ({ user: owner, body: {}, query: {}, params: {} });

  // ════════════════════════════════════════════════════════════════════════
  log('A) Locked (not-on-your-plan) steps are excluded from the percentage\n');

  let baseline;
  {
    const res = await callController(ctrl.getChecklist, req());
    assert(res.statusCode === 200, `GET → 200 (got ${res.statusCode})`);
    baseline = res.body;

    const gated = STEPS.filter((s) => s.entitlement).map((s) => s.key);
    const lockedRows = allSteps(baseline).filter((s) => s.locked);
    assert(lockedRows.length === gated.length, `all ${gated.length} add-on steps render LOCKED without the entitlement (${lockedRows.length})`);
    assert(baseline.lockedCount === gated.length, `lockedCount reports them (${baseline.lockedCount})`);

    const hiring = step(baseline, 'hiring_pipeline');
    assert(hiring !== null, 'a locked step is still RETURNED, so the UI can show the upsell row');
    assert(hiring.state === 'locked' && hiring.completed === false, 'its state is "locked"');
    assert(hiring.lockedReason && hiring.lockedReason.addOn === 'talent_acquisition', 'lockedReason names the add-on');
    assert(hiring.lockedReason.route === '/settings?tab=billing&highlight=talent_acquisition', 'lockedReason deep-links to Billing');
    assert(hiring.cta === "See what's included", `its CTA is the upsell, not "Set up" ("${hiring.cta}")`);

    // The denominator must not contain them — this is what makes 100% reachable.
    const scored = allSteps(baseline).filter((s) => !s.locked && s.state !== 'dismissed' && s.permitted);
    assert(baseline.totalCount === scored.length, `totalCount excludes locked steps (${baseline.totalCount} scored of ${allSteps(baseline).length} shown)`);
    assert(!allSteps(baseline).some((s) => s.locked && s.completed), 'a locked step is never counted as completed');
  }

  // Granting the add-on must GROW the denominator, not the score.
  {
    entitlementStub = { talent_acquisition: { enabled: true, source: 'add_on' } };
    const res = await callController(ctrl.getChecklist, req());
    const granted = res.body;
    assert(granted.lockedCount === 0, 'with the add-on granted, nothing is locked');
    assert(granted.totalCount === baseline.totalCount + 4, `the denominator grows by the four unlocked steps (${baseline.totalCount} → ${granted.totalCount})`);
    assert(granted.percent <= baseline.percent, `and the percentage does not go UP on a purchase (${baseline.percent}% → ${granted.percent}%)`);
    assert(step(granted, 'hiring_pipeline').state === 'todo', 'the previously-locked step becomes an ordinary to-do');
    entitlementStub = { talent_acquisition: { enabled: false, source: 'fallback' } };
  }

  // Country filtering: India-only rows exist here, and are absent for NZ.
  {
    const inKeys = allSteps(baseline).map((s) => s.key);
    assert(inKeys.includes('statutory_registrations'), 'an India tenant sees the India-only PF/ESI/PT/TAN step');
    await prisma.business.update({ where: { id: BIZ_A }, data: { hrCountry: 'NZ', hrCurrency: 'NZD' } });
    const nz = (await callController(ctrl.getChecklist, req())).body;
    const nzKeys = allSteps(nz).map((s) => s.key);
    assert(!nzKeys.includes('statutory_registrations'), 'an NZ tenant does not see it AT ALL (not greyed out — absent)');
    assert(allSteps(baseline).length - allSteps(nz).length === 8, `the 8 India-only rows disappear entirely (${allSteps(baseline).length} → ${allSteps(nz).length})`);
    await prisma.business.update({ where: { id: BIZ_A }, data: { hrCountry: 'IN', hrCurrency: 'INR' } });
  }

  // ════════════════════════════════════════════════════════════════════════
  log('\nB) Tenant scoping — another tenant\'s data never moves this score\n');

  {
    // Give tenant B everything; tenant A nothing.
    await prisma.entity.create({
      data: {
        businessId: BIZ_B, code: `${PREFIX}-B-HQ`, legalName: 'B Pvt Ltd', countryCode: 'IN',
        payCurrency: 'INR', timezone: 'Asia/Kolkata', stateCode: 'MH', activeFrom: new Date(Date.UTC(2020, 3, 1)),
      },
    });
    await prisma.employee.create({
      data: { businessId: BIZ_B, code: `${PREFIX}-B-1`, firstName: 'B', lastName: 'One', status: 'ACTIVE' },
    });

    const a = (await callController(ctrl.getChecklist, req())).body;
    assert(step(a, 'entity').completed === false, "tenant B's registered company does not complete tenant A's step");
    assert(step(a, 'employees').completed === false, "tenant B's employee does not complete tenant A's step");

    // The session is the ONLY source of the tenant — a businessId in the body or
    // query must be ignored outright.
    const spoofed = await callController(ctrl.getChecklist, {
      user: owner, body: { businessId: BIZ_B }, query: { businessId: BIZ_B }, params: {},
    });
    assert(step(spoofed.body, 'entity').completed === false, 'a businessId in the body/query is ignored — the session wins');

    // And tenant B, asked properly, does see its own rows as done.
    const b = (await callController(ctrl.getChecklist, {
      user: { id: `${PREFIX}-user-b`, businessId: BIZ_B, role: 'BUSINESS_ADMIN' }, body: {}, query: {}, params: {},
    })).body;
    assert(step(b, 'entity').completed === true, 'tenant B sees its OWN company as done');
    assert(step(b, 'employees').completed === true, 'tenant B sees its OWN employee as done');
  }

  // Now give tenant A its own company and confirm the score moves.
  {
    const before = (await callController(ctrl.getChecklist, req())).body;
    await prisma.entity.create({
      data: {
        businessId: BIZ_A, code: `${PREFIX}-A-HQ`, legalName: 'A Pvt Ltd', countryCode: 'IN',
        payCurrency: 'INR', timezone: 'Asia/Kolkata', stateCode: 'KA', activeFrom: new Date(Date.UTC(2020, 3, 1)),
      },
    });
    const after = (await callController(ctrl.getChecklist, req())).body;
    assert(step(after, 'entity').completed === true, 'adding a company completes the step for THIS tenant');
    assert(after.completedCount === before.completedCount + 1, `and moves completedCount by exactly one (${before.completedCount} → ${after.completedCount})`);
    assert(after.percent >= before.percent, `and the percentage rises (${before.percent}% → ${after.percent}%)`);
  }

  // ════════════════════════════════════════════════════════════════════════
  log('\nC) A throwing probe degrades to "couldn\'t check" — never a 500\n');

  {
    const saved = PROBES.holidays;
    PROBES.holidays = () => { throw new Error('simulated: relation "Holiday" does not exist'); };
    try {
      const res = await callController(ctrl.getChecklist, req());
      assert(res.statusCode === 200, `the endpoint still answers 200 with a broken probe (got ${res.statusCode})`);
      const h = step(res.body, 'holidays');
      assert(h.state === 'unknown' && h.probe === 'unknown', 'the broken step reports state "unknown"');
      assert(h.completed === false, 'it is reported NOT completed (never optimistically green)');
      assert(res.body.probeDegraded === true && res.body.probeFailedCount === 1, `probeDegraded is raised with a count (${res.body.probeFailedCount})`);
      assert(typeof res.body.percent === 'number', 'the rest of the score is still computed');
      assert(res.body.nextAction === null || res.body.nextAction.key !== 'holidays', 'the broken step is never offered as the next action');
    } finally { PROBES.holidays = saved; }
  }

  // Every probe down → percent null, not a fabricated 0 or 100.
  {
    const saved = {};
    for (const s of STEPS) { saved[s.key] = PROBES[s.key]; PROBES[s.key] = () => { throw new Error('simulated total outage'); }; }
    try {
      const res = await callController(ctrl.getChecklist, req());
      assert(res.statusCode === 200, 'a total probe outage still answers 200');
      assert(res.body.percent === null, `percent is null, not 0 and not 100 (got ${res.body.percent})`);
      assert(res.body.completedCount === 0 && res.body.totalCount > 0, 'the denominator is intact — we know what we could not check');
      assert(res.body.nextAction === null, 'and no next action is invented');
    } finally { for (const s of STEPS) PROBES[s.key] = saved[s.key]; }
  }

  // ════════════════════════════════════════════════════════════════════════
  log('\nD) Next action — deterministic, prerequisite-aware, permission-aware\n');

  {
    // Tenant A: country locked + one company. `employees` blocks 25 steps and its
    // prerequisite is met, so it must be the answer.
    const res = (await callController(ctrl.getChecklist, req())).body;
    assert(res.nextAction && res.nextAction.key === 'employees', `next action is "add your people" (${res.nextAction && res.nextAction.key})`);
    assert(res.nextAction.blocking === 25, `because 25 steps hang off it (${res.nextAction.blocking})`);
    assert(res.nextAction.cta === 'Add an employee', `the card CTA is verb+object ("${res.nextAction.cta}")`);
    assert(res.nextAction.required === true && typeof res.nextAction.minutes === 'number', 'it carries required + a time estimate');
    assert(res.nextAction.orderInScope > 0 && res.nextAction.orderInScope <= res.totalCount, `and its position ("Step ${res.nextAction.orderInScope} of ${res.totalCount}")`);
    assert(!res.nextAction.route.includes('from='), 'the route is bare — the client appends ?from=setup');
    assert(res.nextActionBlocked === null, 'nothing is blocked for an operator who holds every key');

    // Stable across repeated calls.
    const again = (await callController(ctrl.getChecklist, req())).body;
    assert(again.nextAction.key === res.nextAction.key, 'the same operator gets the SAME next step on a repeat load');
  }

  {
    // Complete it, and the guide moves on rather than repeating itself.
    await prisma.employee.create({
      data: { businessId: BIZ_A, code: `${PREFIX}-A-1`, firstName: 'A', lastName: 'One', status: 'ACTIVE' },
    });
    const res = (await callController(ctrl.getChecklist, req())).body;
    assert(step(res, 'employees').completed === true, 'the step is now done');
    assert(res.nextAction.key !== 'employees', `and the next action has moved on (${res.nextAction.key})`);
  }

  {
    // An operator who lacks the top-ranked step's permission is still given work,
    // plus a pointer to who owns the one they cannot reach.
    const limited = {
      id: `${PREFIX}-user-ltd`, businessId: BIZ_A, role: 'STAFF',
      businessRole: { permissions: { canManageAttendance: true, canManageCompanyProfile: true } },
    };
    const res = (await callController(ctrl.getChecklist, { user: limited, body: {}, query: {}, params: {} })).body;
    assert(res.nextActionBlocked !== null, 'the unreachable higher-ranked step is named');
    assert(typeof res.nextActionBlocked.permission === 'string', `with the permission they are missing ("${res.nextActionBlocked.permission}")`);
    assert(res.nextAction === null || res.nextAction.permitted !== false, 'and the offered action is one they can actually do');
    assert(res.stepsNeedingSomeoneElse > 0, `"${res.stepsNeedingSomeoneElse} steps need someone else's access" is reported`);
    assert(res.totalCount < res.tenantTotalCount, `the operator's denominator is smaller than the tenant's (${res.totalCount} vs ${res.tenantTotalCount})`);
    const notMine = allSteps(res).filter((s) => !s.permitted);
    assert(notMine.length > 0 && notMine.every((s) => s.permitted === false), 'steps they cannot do are still listed, flagged permitted:false');
  }

  // ════════════════════════════════════════════════════════════════════════
  log('\nE) Dismissals + the contract\'s honesty flags\n');

  if (!hasSetupStateColumn) {
    log('  [skip] Business.setupState column not present on this schema — run:');
    log('         ALTER TABLE "Business" ADD COLUMN "setupState" JSONB;');
  } else {
    const before = (await callController(ctrl.getChecklist, req())).body;

    // A required step can never be hidden.
    const bad = await callController(ctrl.dismissStep, { user: owner, body: { key: 'employees' }, query: {}, params: {} });
    assert(bad.statusCode === 422, `dismissing a REQUIRED step is refused 422 (got ${bad.statusCode})`);
    const unknown = await callController(ctrl.dismissStep, { user: owner, body: { key: 'nope' }, query: {}, params: {} });
    assert(unknown.statusCode === 422, `an unknown key is refused 422 (got ${unknown.statusCode})`);

    // A recommended one is removed from BOTH sides of the fraction.
    const dis = await callController(ctrl.dismissStep, { user: owner, body: { key: 'biometric_devices' }, query: {}, params: {} });
    assert(dis.statusCode === 200, 'dismissing a recommended step → 200 with the recomputed payload');
    assert(dis.body.totalCount === before.totalCount - 1, `the denominator shrinks by one (${before.totalCount} → ${dis.body.totalCount})`);
    assert(dis.body.dismissedCount === 1, 'dismissedCount reports it');
    assert(step(dis.body, 'biometric_devices').state === 'dismissed', 'and the row is still returned, marked dismissed');

    const back = await callController(ctrl.restoreStep, { user: owner, body: { key: 'biometric_devices' }, query: {}, params: {} });
    assert(back.body.totalCount === before.totalCount, 'restoring puts it back in the denominator');
    assert(back.body.dismissedCount === 0, 'and clears the count');

    const audits = await prisma.auditLog.count({
      where: { businessId: BIZ_A, action: { in: ['setup.step.dismiss', 'setup.step.restore'] } },
    });
    assert(audits >= 2, `both writes are audited (${audits} rows)`);

    // Per-operator UI bookkeeping.
    const ui = await callController(ctrl.setUiState, { user: owner, body: { widgetHiddenDays: 7 }, query: {}, params: {} });
    assert(ui.statusCode === 204, `POST /ui → 204 (got ${ui.statusCode})`);
    const after = (await callController(ctrl.getChecklist, req())).body;
    assert(after.ui && after.ui.widgetHiddenUntil, 'widgetHiddenUntil is persisted per operator (it follows them across devices)');
    const badUi = await callController(ctrl.setUiState, { user: owner, body: { widgetHiddenDays: 999 }, query: {}, params: {} });
    assert(badUi.statusCode === 422, `an absurd hide window is refused 422 (got ${badUi.statusCode})`);
  }

  {
    const res = (await callController(ctrl.getChecklist, req())).body;
    assert(res.country === 'IN' && res.currency === 'INR', 'the payload carries the tenant country + currency for the money examples');
    assert(typeof res.generatedAt === 'string', 'and a generatedAt stamp');
    assert(res.percent >= 1, 'percent is floored at 1 once anything is done (never 0 with real progress)');
    assert(res.percent < 100, 'and capped below 100 while work remains');
    assert(res.allComplete === false && res.allRequiredComplete === false, 'the done state is not claimed early');
    // No registry internals leak.
    const leaked = allSteps(res).filter((s) => 'includeWhen' in s || 'ctaVerb' in s || 'stageOrder' in s).map((s) => s.key);
    assert(leaked.length === 0, `no registry internals are serialised${leaked.length ? ` (leaked on: ${leaked})` : ''}`);
    assert(allSteps(res).every((s) => typeof s.why === 'string' && s.explain && s.explain.plain), 'every row carries the plain-English explainer the page renders');
  }

  await teardown();

  log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

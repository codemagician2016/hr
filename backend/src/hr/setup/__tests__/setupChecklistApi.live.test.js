'use strict';

/*
 * setupChecklistApi.live.test.js — LIVE (hr_test) proof of the payload CONTRACT and
 * the bits the controller test deliberately leaves alone: stage grouping, the
 * conditional (migration-only) steps, 100% reachability, the one-time completion
 * stamp, and the per-operator nudge/widget bookkeeping.
 *
 * The score arithmetic, tenant scoping, probe resilience and next-action ranking are
 * proved in src/hr/controllers/__tests__/setupChecklist.test.js; this file does not
 * repeat them.
 *
 *   DATABASE_URL="$HR_URL" node src/hr/setup/__tests__/setupChecklistApi.live.test.js
 */

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PFX = 'SETUPAPI';
const BIZ = `${PFX}-biz-1`;

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
const flat = (p) => p.stages.reduce((a, s) => a.concat(s.steps), []);
const find = (p, k) => flat(p).find((s) => s.key === k) || null;

async function main() {
  log('\n=== Setup checklist — payload contract, stages, conditionals, celebration ===\n');

  if (!process.env.DATABASE_URL) { log('[skip] DATABASE_URL not set — needs the live hr_test schema.\n'); return; }

  const prisma = require('../../../core/lib/prisma');
  const entitlementsLib = require('../../../core/lib/entitlements');
  entitlementsLib.hrEntitlements = async () => ({ talent_acquisition: { enabled: false, source: 'fallback' } });

  const ctrl = require('../../controllers/setupChecklist.controller');
  const { PROBES } = require('../probes');
  const { STAGES, STEPS } = require('../checklistItems');

  let hasColumn = true;
  try { await prisma.business.findFirst({ where: { id: BIZ }, select: { setupState: true } }); } catch (_e) { hasColumn = false; }

  async function teardown() {
    await prisma.importJob.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.entity.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { businessId: BIZ } }).catch(() => {});
    await prisma.business.deleteMany({ where: { id: BIZ } }).catch(() => {});
  }
  await teardown();

  await prisma.business.create({
    data: {
      id: BIZ, name: `${PFX} Pvt Ltd`, slug: `${PFX.toLowerCase()}-1`,
      hrCountry: 'IN', hrCurrency: 'INR', hrCountrySetAt: new Date(),
    },
  });
  const entity = await prisma.entity.create({
    data: {
      businessId: BIZ, code: `${PFX}-HQ`, legalName: `${PFX} Pvt Ltd`, countryCode: 'IN',
      payCurrency: 'INR', timezone: 'Asia/Kolkata', stateCode: 'KA', activeFrom: new Date(Date.UTC(2020, 3, 1)),
    },
  });
  const owner = { id: `${PFX}-owner`, businessId: BIZ, role: 'BUSINESS_ADMIN' };

  // ══════════════════════════════════════════════════════════════════════════
  log('A) The documented payload contract\n');
  {
    const res = await call(ctrl.getChecklist, { user: owner });
    ok(res.statusCode === 200, 'GET → 200');
    const p = res.body;

    const scalars = {
      country: 'string', currency: 'string', generatedAt: 'string',
      completedCount: 'number', totalCount: 'number', requiredRemaining: 'number',
      allRequiredComplete: 'boolean', allComplete: 'boolean',
      tenantPercent: 'number', tenantCompletedCount: 'number', tenantTotalCount: 'number',
      tenantAllComplete: 'boolean', stepsNeedingSomeoneElse: 'number',
      lockedCount: 'number', dismissedCount: 'number',
      probeDegraded: 'boolean', probeFailedCount: 'number',
    };
    const wrong = Object.entries(scalars).filter(([k, t]) => typeof p[k] !== t).map(([k]) => k);
    ok(wrong.length === 0, `every documented scalar is present with the right type${wrong.length ? ` (wrong: ${wrong})` : ''}`);
    ok(Object.prototype.hasOwnProperty.call(p, 'completedAt') && Object.prototype.hasOwnProperty.call(p, 'celebratedAt'), 'completedAt + celebratedAt are always present (null before the moment)');
    ok(Number.isInteger(p.percent) || p.percent === null, 'percent is an integer or null — never a float');

    const stepFields = ['key', 'label', 'description', 'why', 'explain', 'stage', 'order', 'required',
      'route', 'cta', 'completed', 'state', 'probe', 'locked', 'lockedReason', 'permission', 'permitted',
      'countryOnly', 'prismaModel', 'dependsOn', 'prerequisitesMet', 'blocking', 'dismissible',
      'minutes', 'doneBy', 'coverage'];
    const thin = flat(p).filter((s) => stepFields.some((f) => !(f in s))).map((s) => s.key);
    ok(thin.length === 0, `every step object carries all ${stepFields.length} documented fields${thin.length ? ` (thin: ${thin})` : ''}`);
    const badState = flat(p).filter((s) => !['done', 'todo', 'unknown', 'locked', 'dismissed'].includes(s.state)).map((s) => s.key);
    ok(badState.length === 0, `state is always one of the five documented values${badState.length ? ` (${badState})` : ''}`);
    ok(flat(p).every((s) => (s.completed === true) === (s.state === 'done')), '`completed` and `state` can never disagree');
    ok(flat(p).every((s) => !s.required || s.dismissible === false), 'a required step is never marked dismissible');
    ok(flat(p).every((s) => (s.locked ? !!s.lockedReason : s.lockedReason === null)), 'lockedReason is present exactly when locked');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nB) Stages — grouping, ordering and status\n');
  {
    const p = (await call(ctrl.getChecklist, { user: owner })).body;
    ok(p.stages.length === 5, `five stages returned (${p.stages.length})`);
    ok(p.stages.every((s, i) => s.order === i + 1), 'stages come back in declared order');
    ok(p.stages.map((s) => s.key).join(',') === STAGES.map((s) => s.key).join(','), 'foundation → people → time → pay → engage');
    ok(p.stages.every((s) => s.title && s.subtitle), 'each stage carries its heading + subtitle');

    const misfiled = p.stages.flatMap((st) => st.steps.filter((s) => s.stage !== st.key).map((s) => s.key));
    ok(misfiled.length === 0, `every step sits in its own stage${misfiled.length ? ` (${misfiled})` : ''}`);
    const outOfOrder = p.stages.some((st) => st.steps.some((s, i) => i > 0 && st.steps[i - 1].order > s.order));
    ok(!outOfOrder, 'steps within a stage keep the global declared order');

    const sumTotal = p.stages.reduce((a, s) => a + s.totalCount, 0);
    const sumDone = p.stages.reduce((a, s) => a + s.completedCount, 0);
    ok(sumTotal === p.totalCount, `stage totals add up to the header total (${sumTotal} vs ${p.totalCount})`);
    ok(sumDone === p.completedCount, `stage completions add up to the header count (${sumDone} vs ${p.completedCount})`);

    const foundation = p.stages[0];
    ok(['not_started', 'in_progress', 'required_done', 'done'].includes(foundation.status), `stage status is one of the four documented values ("${foundation.status}")`);
    ok(foundation.status === 'in_progress', 'foundation is in progress (country + company locked, the rest is not)');
    const engage = p.stages.find((s) => s.key === 'engage');
    ok(engage.status === 'not_started', 'engage has not been started');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nC) Conditional steps — a greenfield tenant is never nagged about migration\n');
  {
    const green = (await call(ctrl.getChecklist, { user: owner })).body;
    ok(find(green, 'leave_opening_balances') === null, 'a greenfield tenant never sees "bring in current leave balances"');
    ok(find(green, 'payroll_history_import') === null, 'nor "bring in this year\'s pay history"');
    const beforeTotal = green.totalCount;

    // A COMMITTED employee import is the "you came from somewhere else" signal.
    await prisma.importJob.create({
      data: {
        businessId: BIZ, kind: 'EMPLOYEE', status: 'COMMITTED',
        fileName: `${PFX}.csv`, fileKey: `${PFX}/employees.csv`, fileHash: `${PFX}-hash-1`,
        uploadedBy: owner.id,
      },
    });
    // …and someone already on the payroll before this tax year started.
    await prisma.employee.create({
      data: {
        businessId: BIZ, code: `${PFX}-OLD`, firstName: 'Legacy', lastName: 'Joiner',
        status: 'ACTIVE', hireDate: new Date(Date.UTC(2019, 5, 1)),
      },
    });

    const migrated = (await call(ctrl.getChecklist, { user: owner })).body;
    ok(find(migrated, 'leave_opening_balances') !== null, 'a migrating tenant DOES see the leave-balance step');
    ok(find(migrated, 'payroll_history_import') !== null, 'and the pay-history step, because someone joined before this tax year');
    // Only the two conditional rows move the denominator — an unmet prerequisite
    // never removes a step from the score, it only stops it being offered next.
    ok(migrated.totalCount === beforeTotal + 2, `the denominator grows by exactly the two conditional rows (${beforeTotal} → ${migrated.totalCount})`);
    ok(find(migrated, 'employees').completed === true, 'and the imported person completes "add your people"');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nD) 100% is reachable — the operator-scoped score\n');
  {
    // An operator whose ONLY key is canEditBranding has exactly one step in scope.
    const brandOnly = {
      id: `${PFX}-brand`, businessId: BIZ, role: 'STAFF',
      businessRole: { permissions: { canEditBranding: true } },
    };
    const before = (await call(ctrl.getChecklist, { user: brandOnly })).body;
    ok(before.totalCount === 1, `their scored set is one step (${before.totalCount})`);
    ok(before.percent === 0 && before.allComplete === false, 'nothing done → an honest 0%');
    ok(before.stepsNeedingSomeoneElse === before.tenantTotalCount - 1, `everything else is flagged as someone else's (${before.stepsNeedingSomeoneElse})`);

    await prisma.tenantBrand.create({
      data: { businessId: BIZ, code: `${PFX}-BRAND`, name: `${PFX} brand`, primaryColor: '#1A73E8' },
    });
    const after = (await call(ctrl.getChecklist, { user: brandOnly })).body;
    ok(after.percent === 100 && after.allComplete === true, 'finishing their only step reaches 100% and allComplete');
    ok(after.nextAction === null, 'and no next action is offered');
    ok(after.tenantAllComplete === false, 'while the TENANT is plainly not finished — the two scores are independent');
    ok(after.completedAt === null, 'so the one-time completion stamp is NOT written');
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nE) The one-time completion stamp + celebration bookkeeping\n');
  if (!hasColumn) {
    log('  [skip] Business.setupState column not present — ALTER TABLE "Business" ADD COLUMN "setupState" JSONB;');
  } else {
    // Force every probe green so tenantAllComplete flips — the only honest way to
    // exercise the stamp without standing up all 17 required steps for real.
    const saved = {};
    for (const s of STEPS) { saved[s.key] = PROBES[s.key]; PROBES[s.key] = () => true; }
    try {
      const p = (await call(ctrl.getChecklist, { user: owner })).body;
      ok(p.tenantAllComplete === true && p.allComplete === true, 'with everything done, both scores read complete');
      ok(p.requiredRemaining === 0 && p.percent === 100, '100% with no required steps left');
      ok(typeof p.completedAt === 'string', 'completedAt is stamped the first time the tenant finishes');
      const stamp = p.completedAt;

      const again = (await call(ctrl.getChecklist, { user: owner })).body;
      ok(again.completedAt === stamp, 'and it is stamped ONCE — a later load does not move it');

      ok(again.celebratedAt === null, 'confetti has not fired yet (celebratedAt null)');
      const ui = await call(ctrl.setUiState, { user: owner, body: { celebrated: true } });
      ok(ui.statusCode === 204, 'POST /ui { celebrated:true } → 204');
      const after = (await call(ctrl.getChecklist, { user: owner })).body;
      ok(typeof after.celebratedAt === 'string', 'celebratedAt is recorded per operator, so it never fires twice');
    } finally { for (const s of STEPS) PROBES[s.key] = saved[s.key]; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  log('\nF) Per-operator nudge bookkeeping\n');
  if (!hasColumn) {
    log('  [skip] Business.setupState column not present.');
  } else {
    const a = { id: `${PFX}-op-a`, businessId: BIZ, role: 'BUSINESS_ADMIN' };
    const b = { id: `${PFX}-op-b`, businessId: BIZ, role: 'BUSINESS_ADMIN' };

    await call(ctrl.setUiState, { user: a, body: { nudgeShown: true } });
    let pa = (await call(ctrl.getChecklist, { user: a })).body;
    ok(pa.ui.nudgeShownCount === 1, `showing the nudge counts towards the lifetime cap (${pa.ui.nudgeShownCount})`);
    ok(pa.ui.nudgeDismissals === 0, 'and is not a dismissal');

    await call(ctrl.setUiState, { user: a, body: { nudgeDismissed: true } });
    pa = (await call(ctrl.getChecklist, { user: a })).body;
    ok(pa.ui.nudgeDismissals === 1, `"Later" counts towards the dismissal streak (${pa.ui.nudgeDismissals})`);
    ok(pa.ui.nudgeShownCount === 2, 'and also towards the lifetime shown count');
    ok(typeof pa.ui.nudgeLastShownAt === 'string', 'the last-shown timestamp drives "not already dismissed today"');

    const pb = (await call(ctrl.getChecklist, { user: b })).body;
    ok(pb.ui.nudgeShownCount === 0 && pb.ui.nudgeDismissals === 0, 'a SECOND operator has their own untouched counters');
    ok(pa.ui.widgetHiddenUntil === null || typeof pa.ui.widgetHiddenUntil === 'string', 'widgetHiddenUntil is per operator too');
    ok(typeof pa.tenantAgeDays === 'number', `tenantAgeDays is returned so the nudge can stop after 90 days (${pa.tenantAgeDays})`);

    // Finishing a step clears the dismissal streak (but never the lifetime cap).
    await prisma.entity.update({ where: { id: entity.id }, data: { prorationBasis: 'TWENTYSIX_DAY_STANDARD' } });
    pa = (await call(ctrl.getChecklist, { user: a })).body;
    ok(pa.ui.nudgeDismissals === 0, 'completing a step resets the dismissal streak to 0');
    ok(pa.ui.nudgeShownCount === 2, 'but the lifetime shown count is untouched');

    const bad = await call(ctrl.setUiState, { user: a, body: {} });
    ok(bad.statusCode === 422, `an empty /ui body is refused 422 (got ${bad.statusCode})`);
  }

  await teardown();
  log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

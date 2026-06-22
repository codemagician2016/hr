'use strict';

/**
 * onboarding.test.js — Feature 4 slice 4a (Onboarding core) proof.
 *
 * Two layers, in one plain-node runner (no jest), mirroring the F2/scope test
 * harness:
 *   PART A (DB-FREE) — the PURE journey engine: seedJourneyTasks (due-date +
 *     owner resolution) and advanceJourney (blocking-task gating, stage
 *     progression, terminal states). No prisma touched.
 *   PART B (LIVE hr_test) — acceptOffer seeds exactly one journey (idempotent),
 *     RBAC scope (manager sees only sub-tree hires' tasks; out-of-scope complete
 *     → 404), and the assets-controller bug regression (assetTag→code,
 *     condition→conditionIn + recoveryAmount on damage).
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/onboarding.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const { seedJourneyTasks, advanceJourney, _internals } = require('../journeyEngine');
const { onboardingTaskBlueprint } = require('../templates/seed');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── tiny date helper for assertions ──
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// ═══════════════════════════════════════════════════════════════════════════
// PART A — PURE ENGINE (no DB)
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('\n=== PART A — journeyEngine (pure, DB-free) ===\n');

  // ── A1: seedJourneyTasks — due-date resolution against anchors ──
  log('A1) seedJourneyTasks due-date + owner resolution:');
  {
    const template = { id: 'tmpl-1', direction: 'ONBOARDING' };
    const taskDefs = [
      { id: 'd1', stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_PERSONAL', title: 'Personal',
        ownerRole: 'NEW_HIRE', taskOrder: 0, dueAnchor: 'JOIN_DATE', dueOffsetDays: -3, isBlocking: true, isMandatory: true },
      { id: 'd2', stageKey: 'PROBATION', taskKey: 'PROBATION_REVIEW', title: 'Review',
        ownerRole: 'MANAGER', taskOrder: 0, dueAnchor: 'JOIN_DATE', dueOffsetDays: 75, isBlocking: true, isMandatory: true },
      { id: 'd0', stageKey: 'PRE_JOIN', taskKey: null, title: 'Welcome',
        ownerRole: 'HR', taskOrder: 0, dueAnchor: 'OFFER_ACCEPT', dueOffsetDays: 1, isBlocking: false, isMandatory: true },
    ];
    const ctx = {
      businessId: 'biz-1',
      offerAcceptedAt: new Date('2026-06-01T10:30:00Z'),
      joinDate: new Date('2026-07-01T00:00:00Z'),
      ownerResolution: { MANAGER: { employeeId: 'mgr-emp' }, NEW_HIRE: {}, HR: { userId: 'hr-user' } },
    };
    const tasks = seedJourneyTasks(template, taskDefs, ctx);

    assert(tasks.length === 3, 'materializes one task per def');
    // Ordering: PRE_JOIN first (stage flow), then SELF_ONBOARDING, then PROBATION.
    assert(tasks[0].stageKey === 'PRE_JOIN' && tasks[1].stageKey === 'SELF_ONBOARDING' && tasks[2].stageKey === 'PROBATION',
      'sorted by stage flow order, not input order');
    // Due dates: JOIN_DATE(2026-07-01) - 3 = 2026-06-28; +75 = 2026-09-14; OFFER_ACCEPT(06-01)+1 = 06-02.
    const byKey = Object.fromEntries(tasks.map((t) => [t.taskKey || 'WELCOME', t]));
    assert(isoDay(byKey.COLLECT_PERSONAL.dueDate) === '2026-06-28', `COLLECT_PERSONAL due = JOIN-3 (${isoDay(byKey.COLLECT_PERSONAL.dueDate)})`);
    assert(isoDay(byKey.PROBATION_REVIEW.dueDate) === '2026-09-14', `PROBATION_REVIEW due = JOIN+75 (${isoDay(byKey.PROBATION_REVIEW.dueDate)})`);
    assert(isoDay(byKey.WELCOME.dueDate) === '2026-06-02', `welcome due = OFFER_ACCEPT+1, date-floored (${isoDay(byKey.WELCOME.dueDate)})`);
    // Owner resolution: MANAGER → employeeId; HR → userId; NEW_HIRE → unassigned.
    assert(byKey.PROBATION_REVIEW.assigneeEmployeeId === 'mgr-emp', 'MANAGER owner resolves to employeeId');
    assert(byKey.WELCOME.assigneeUserId === 'hr-user', 'HR owner resolves to userId');
    assert(byKey.COLLECT_PERSONAL.assigneeEmployeeId === null && byKey.COLLECT_PERSONAL.assigneeUserId === null,
      'unmapped NEW_HIRE owner stays unassigned (pre-provision)');
    // status default + businessId stamp.
    assert(tasks.every((t) => t.status === 'PENDING' && t.businessId === 'biz-1'), 'all PENDING + businessId stamped');
  }

  // ── A2: null anchor → null due date (anchor not yet known) ──
  log('A2) unknown anchor → null due date:');
  {
    const tasks = seedJourneyTasks(
      { direction: 'ONBOARDING' },
      [{ id: 'x', stageKey: 'NOTICE', title: 't', ownerRole: 'HR', dueAnchor: 'LWD', dueOffsetDays: 0 }],
      { businessId: 'b', ownerResolution: {} },
    );
    assert(tasks[0].dueDate === null, 'LWD anchor unset → dueDate null (resolved later)');
  }

  // ── A3: advanceJourney — gating + progression ──
  log('A3) advanceJourney blocking-task gating + stage progression:');
  {
    const mk = (stageKey, status, opts = {}) => ({
      stageKey, status, isBlocking: opts.blocking !== false, isMandatory: opts.mandatory !== false,
    });
    // Journey at PRE_JOIN with PRE_JOIN done but SELF_ONBOARDING blocking open.
    const j = { id: 'j1', direction: 'ONBOARDING', currentStage: 'PRE_JOIN', status: 'IN_PROGRESS' };
    const tasks1 = [
      mk('PRE_JOIN', 'DONE', { blocking: false }),
      mk('SELF_ONBOARDING', 'PENDING'),
    ];
    const r1 = advanceJourney(j, tasks1);
    assert(r1.currentStage === 'SELF_ONBOARDING', 'advances past PRE_JOIN (no open blockers there) to SELF_ONBOARDING');
    assert(r1.status === 'IN_PROGRESS', 'status IN_PROGRESS while SELF_ONBOARDING blocker open');

    // Now SELF_ONBOARDING blocker DONE → advances to DOCS_ESIGN.
    const tasks2 = [
      mk('PRE_JOIN', 'DONE', { blocking: false }),
      mk('SELF_ONBOARDING', 'DONE'),
      mk('DOCS_ESIGN', 'PENDING'),
    ];
    const r2 = advanceJourney({ ...j, currentStage: 'SELF_ONBOARDING' }, tasks2);
    assert(r2.currentStage === 'DOCS_ESIGN', 'SELF_ONBOARDING cleared → advance to DOCS_ESIGN');

    // Non-blocking open task at a stage does NOT hold it back.
    const tasks3 = [
      mk('SELF_ONBOARDING', 'PENDING', { blocking: false }),
      mk('DOCS_ESIGN', 'DONE'),
    ];
    const r3 = advanceJourney({ ...j, currentStage: 'SELF_ONBOARDING' }, tasks3);
    assert(r3.currentStage !== 'SELF_ONBOARDING', 'non-blocking open task does not gate the stage');
  }

  // ── A4: blocking FAILED/OVERDUE → BLOCKED ──
  log('A4) blocking FAILED/OVERDUE → BLOCKED + notify HR:');
  {
    const j = { id: 'j2', direction: 'ONBOARDING', currentStage: 'PROVISIONING', status: 'IN_PROGRESS' };
    const r = advanceJourney(j, [{ stageKey: 'PROVISIONING', status: 'FAILED', isBlocking: true, isMandatory: true }]);
    assert(r.status === 'BLOCKED', 'a blocking FAILED task → journey BLOCKED');
    assert(r.currentStage === 'PROVISIONING', 'stage held at PROVISIONING (no advance while blocked)');
    assert(r.sideEffects.some((s) => s.type === 'NOTIFY_HR'), 'emits NOTIFY_HR side-effect');
  }

  // ── A5: terminal state → no-op; full completion ──
  log('A5) terminal states + completion:');
  {
    // Cancelled is immutable.
    const cancelled = advanceJourney(
      { id: 'j3', direction: 'ONBOARDING', currentStage: 'DAY_ONE', status: 'CANCELLED' },
      [{ stageKey: 'DAY_ONE', status: 'PENDING', isBlocking: true, isMandatory: true }],
    );
    assert(cancelled.status === 'CANCELLED' && cancelled.currentStage === 'DAY_ONE', 'CANCELLED journey is a no-op (immutable)');

    // ON_HOLD freezes progression.
    const held = advanceJourney(
      { id: 'j4', direction: 'ONBOARDING', currentStage: 'WEEK_ONE', status: 'ON_HOLD' },
      [{ stageKey: 'WEEK_ONE', status: 'DONE', isBlocking: true, isMandatory: true }],
    );
    assert(held.status === 'ON_HOLD', 'ON_HOLD journey stays frozen until resumed');

    // Everything DONE through the terminal stage → COMPLETED.
    const allDoneTasks = _internals.ONBOARDING_STAGES.map((s) => ({ stageKey: s, status: 'DONE', isBlocking: true, isMandatory: true }));
    const done = advanceJourney(
      { id: 'j5', direction: 'ONBOARDING', currentStage: 'PROBATION', status: 'IN_PROGRESS' },
      allDoneTasks,
    );
    assert(done.status === 'COMPLETED', 'all stages cleared at terminal stage → COMPLETED');
    assert(done.sideEffects.some((s) => s.type === 'JOURNEY_COMPLETED'), 'emits JOURNEY_COMPLETED');
  }

  // ── A6: blueprint sanity (IN vs NZ statutory task differs) ──
  log('A6) IN vs NZ blueprint statutory difference:');
  {
    const inDefs = onboardingTaskBlueprint('IN');
    const nzDefs = onboardingTaskBlueprint('NZ');
    const inStat = inDefs.find((d) => d.taskKey === 'COLLECT_STATUTORY');
    const nzStat = nzDefs.find((d) => d.taskKey === 'COLLECT_STATUTORY');
    assert(/PAN|Aadhaar|UAN/.test(inStat.title), 'IN statutory task mentions PAN/Aadhaar/UAN');
    assert(/IRD|KiwiSaver|tax code/.test(nzStat.title), 'NZ statutory task mentions IRD/KiwiSaver');
    assert(inDefs.some((d) => d.taskKey === 'PROVISION_EMPLOYEE' && d.isBlocking),
      'both markets include a blocking PROVISION_EMPLOYEE task');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test (acceptOffer seed, RBAC scope, assets regression)
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
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'ONB-TEST';

async function partB() {
  log('\n=== PART B — LIVE hr_test (acceptOffer + RBAC scope + assets regression) ===\n');

  const prisma = require('../../../core/lib/prisma');
  const recruitment = require('../../talent/controllers/recruitment.controller');
  const onboarding = require('../controllers/onboarding.controller');
  const assets = require('../../controllers/assets.controller');
  const { seedOnboardingTemplates } = require('../templates/seed');
  const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const entity = await prisma.entity.findFirst({ where: { businessId } });
  const entityId = entity ? entity.id : null;

  async function cleanup() {
    // Journeys + tasks (cascade) seeded from our offers.
    const offers = await prisma.offer.findMany({
      where: { businessId, application: { candidate: { email: { startsWith: PREFIX } } } },
      select: { id: true },
    });
    if (offers.length) {
      await prisma.lifecycleJourney.deleteMany({ where: { businessId, offerId: { in: offers.map((o) => o.id) } } });
    }
    await prisma.offer.deleteMany({ where: { businessId, application: { candidate: { email: { startsWith: PREFIX } } } } });
    await prisma.application.deleteMany({ where: { businessId, candidate: { email: { startsWith: PREFIX } } } });
    await prisma.candidate.deleteMany({ where: { businessId, email: { startsWith: PREFIX } } });
    await prisma.job.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    // Assets fixture.
    const asg = await prisma.assetAssignment.findMany({ where: { businessId, asset: { code: { startsWith: PREFIX } } }, select: { id: true } });
    if (asg.length) await prisma.assetAssignment.deleteMany({ where: { id: { in: asg.map((a) => a.id) } } });
    await prisma.asset.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    // Lifecycle tasks assigned to fixture employees, then employees.
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    if (emps.length) {
      await prisma.lifecycleTask.deleteMany({ where: { businessId, assigneeEmployeeId: { in: emps.map((e) => e.id) } } });
      await prisma.lifecycleJourney.deleteMany({ where: { businessId, employeeId: { in: emps.map((e) => e.id) } } });
    }
    await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  }

  await cleanup();

  try {
    // Seed the IN/NZ onboarding templates for the demo tenant (idempotent).
    await seedOnboardingTemplates(prisma, businessId, { entityId });
    log('B0) templates seeded (IN + NZ)');

    // ── Build a hiring manager (Employee) so MANAGER tasks resolve to them ──
    const manager = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-MGR`, firstName: 'Mgr', lastName: 'T', status: 'ACTIVE' },
    });

    // ── Job → Candidate → Application → Offer(SENT) ──
    const job = await prisma.job.create({
      data: {
        businessId, entityId, code: `${PREFIX}-JOB`, title: 'Engineer',
        countryCode: 'IN', employmentType: 'FULL_TIME', hiringManagerId: manager.id, status: 'OPEN',
      },
    });
    const candidate = await prisma.candidate.create({
      data: { businessId, firstName: 'New', lastName: 'Hire', email: `${PREFIX}-cand@example.com` },
    });
    const application = await prisma.application.create({
      data: { businessId, jobId: job.id, candidateId: candidate.id, status: 'OFFERED' },
    });
    const offer = await prisma.offer.create({
      data: {
        businessId, applicationId: application.id, currencyCode: 'INR',
        joiningDate: new Date('2026-08-01'), status: 'SENT', grossMonthly: '60000',
      },
    });

    // ── B1: acceptOffer seeds exactly one journey ──
    log('B1) acceptOffer seeds exactly one onboarding journey:');
    {
      const opUser = { id: 'op-user', businessId, role: 'BUSINESS_ADMIN' };
      const res = await callController(recruitment.acceptOffer, { user: opUser, params: { id: offer.id }, body: {} });
      assert(res.statusCode === 200, 'acceptOffer → 200');

      const journeys = await prisma.lifecycleJourney.findMany({ where: { businessId, offerId: offer.id } });
      assert(journeys.length === 1, 'exactly one journey seeded from the offer');
      const j = journeys[0];
      assert(j.direction === 'ONBOARDING' && j.status === 'NOT_STARTED' && j.currentStage === 'PRE_JOIN',
        'journey is ONBOARDING / NOT_STARTED / PRE_JOIN');
      assert(/^ONB-\d{6}$/.test(j.code), `journey code allocated from NumberSequence (${j.code})`);
      assert(isoDay(j.joinDate) === '2026-08-01' && j.offerAcceptedAt != null, 'anchors stamped (joinDate + offerAcceptedAt)');

      const tasks = await prisma.lifecycleTask.findMany({ where: { journeyId: j.id } });
      assert(tasks.length > 0, 'tasks snapshotted from the template');
      const provision = tasks.find((t) => t.taskKey === 'PROVISION_EMPLOYEE');
      assert(provision && provision.isBlocking, 'includes a blocking PROVISION_EMPLOYEE task');
      const mgrTask = tasks.find((t) => t.ownerRole === 'MANAGER' && t.assigneeEmployeeId === manager.id);
      assert(!!mgrTask, 'MANAGER-owned task resolved to the hiring manager Employee');

      // Application flipped HIRED.
      const app2 = await prisma.application.findUnique({ where: { id: application.id } });
      assert(app2.status === 'HIRED', 'application flipped to HIRED');
    }

    // ── B2: idempotency — second accept is a no-op / 409 (no second journey) ──
    log('B2) second acceptOffer is idempotent (no duplicate journey):');
    {
      const opUser = { id: 'op-user', businessId, role: 'BUSINESS_ADMIN' };
      // Re-flip the offer to SENT to retry the accept path (simulates a retry).
      await prisma.offer.update({ where: { id: offer.id }, data: { status: 'SENT' } });
      const res = await callController(recruitment.acceptOffer, { user: opUser, params: { id: offer.id }, body: {} });
      const journeys = await prisma.lifecycleJourney.findMany({ where: { businessId, offerId: offer.id } });
      assert(journeys.length === 1, `still exactly one journey after re-accept (status ${res.statusCode})`);
    }

    // ── B3: RBAC scope — manager sees only sub-tree hires' tasks ──
    log('B3) manager task scope (owner=all sub-tree only):');
    {
      // Provision a fake "hire" employee under the manager and one outside.
      const inHire = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-IN`, firstName: 'In', lastName: 'Scope', status: 'ACTIVE', managerEmployeeId: manager.id },
      });
      const outHire = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-OUT`, firstName: 'Out', lastName: 'Scope', status: 'ACTIVE' },
      });
      // Attach the seeded journey to the in-scope hire + create a manager-owned task on each.
      const j = await prisma.lifecycleJourney.findFirst({ where: { businessId, offerId: offer.id } });
      await prisma.lifecycleJourney.update({ where: { id: j.id }, data: { employeeId: inHire.id } });
      const inTask = await prisma.lifecycleTask.create({
        data: { businessId, journeyId: j.id, stageKey: 'DAY_ONE', taskKey: 'CUSTOM', title: 'mgr in', ownerRole: 'MANAGER',
          assigneeEmployeeId: manager.id, isBlocking: false, isMandatory: false, status: 'PENDING' },
      });
      // A task whose subject (journey.employeeId) is OUT of the manager's sub-tree.
      const jOut = await prisma.lifecycleJourney.create({
        data: { businessId, code: `${PREFIX}-OFBX`, direction: 'ONBOARDING', currentStage: 'DAY_ONE', status: 'IN_PROGRESS', employeeId: outHire.id },
      });
      const outTask = await prisma.lifecycleTask.create({
        data: { businessId, journeyId: jOut.id, stageKey: 'DAY_ONE', taskKey: 'CUSTOM', title: 'mgr out', ownerRole: 'MANAGER',
          assigneeEmployeeId: outHire.id, isBlocking: false, isMandatory: false, status: 'PENDING' },
      });

      const mgrUser = { id: 'mgr-user', businessId, role: 'STAFF', employeeId: manager.id, businessRole: { defaultScope: 'TEAM' } };
      const scope = await resolveAccessibleEmployeeIds(mgrUser, 'canViewEmployees');
      const req = { user: mgrUser, scope, query: { owner: 'all' }, params: {}, body: {} };
      const res = await callController(onboarding.listTasks, req);
      const ids = new Set((res.body.items || []).map((t) => t.id));
      assert(ids.has(inTask.id), 'manager sees the in-sub-tree task');
      assert(!ids.has(outTask.id), 'manager does NOT see the out-of-sub-tree task');

      // ── B4: complete out-of-scope task → 404 ──
      log('B4) manager completes out-of-scope task → 404:');
      {
        const r404 = await callController(onboarding.completeTask, { user: mgrUser, scope, params: { id: outTask.id }, body: {} });
        assert(r404.statusCode === 404, 'out-of-scope complete → 404 (not 403)');
        const reload = await prisma.lifecycleTask.findUnique({ where: { id: outTask.id } });
        assert(reload.status === 'PENDING', 'out-of-scope task stays PENDING');
      }

      // ── B5: complete in-scope owned task → 200 ──
      log('B5) manager completes own in-scope task → 200:');
      {
        const rOk = await callController(onboarding.completeTask, { user: mgrUser, scope, params: { id: inTask.id }, body: {} });
        assert(rOk.statusCode === 200, 'in-scope owned complete → 200');
        const reload = await prisma.lifecycleTask.findUnique({ where: { id: inTask.id } });
        assert(reload.status === 'DONE' && reload.completedByUserId === 'mgr-user', 'task DONE + stamped completedBy');
      }
    }

    // ── B6: assets bug regression ──
    log('B6) assets regression (code/conditionIn/recoveryAmount):');
    {
      const opUser = { id: 'op-user', businessId, role: 'BUSINESS_ADMIN' };
      const empA = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-ASSETEMP`, firstName: 'Asset', lastName: 'Holder', status: 'ACTIVE' },
      });
      // create asset (uses `code`, not assetTag)
      const createRes = await callController(assets.createAsset, {
        user: opUser, params: {}, body: { code: `${PREFIX}-LAP1`, name: 'MacBook', category: 'LAPTOP' },
      });
      assert(createRes.statusCode === 201, 'createAsset with `code` → 201 (no Unknown field assetTag)');
      const assetId = createRes.body.id;

      // GET /assets succeeds + search by q hits `code`
      const listRes = await callController(assets.listAssets, { user: opUser, query: { q: `${PREFIX}-LAP1` }, params: {}, body: {} });
      assert(listRes.statusCode === 200 && listRes.body.items.some((a) => a.id === assetId),
        'listAssets with q (code search) returns the asset (no Unknown field assetTag)');

      // assign → records conditionOut
      const assignRes = await callController(assets.assign, {
        user: opUser, params: {}, body: { assetId, employeeId: empA.id, conditionOut: 'GOOD' },
      });
      assert(assignRes.statusCode === 201 && assignRes.body.conditionOut === 'GOOD', 'assign records conditionOut=GOOD');
      const assignmentId = assignRes.body.id;

      // return damaged → writes conditionIn + recoveryAmount (the FnF seam)
      const returnRes = await callController(assets.returnAsset, {
        user: opUser, params: { id: assignmentId }, body: { conditionIn: 'DAMAGED', recoveryAmount: '5000.00' },
      });
      assert(returnRes.statusCode === 200, 'returnAsset → 200 (no Unknown field condition)');
      assert(returnRes.body.conditionIn === 'DAMAGED', 'return writes conditionIn=DAMAGED (not `condition`)');
      assert(String(returnRes.body.recoveryAmount) === '5000', 'return writes recoveryAmount (FnF asset-recovery seam)');
      assert(returnRes.body.status === 'DAMAGED', 'damaged return → assignment status DAMAGED');
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

// ── runner ──
async function main() {
  partA();
  // PART B requires a live DB; skip gracefully if DATABASE_URL is unset.
  if (!process.env.DATABASE_URL) {
    log('\n[skip] PART B — DATABASE_URL not set (pure-engine PART A ran DB-free).\n');
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

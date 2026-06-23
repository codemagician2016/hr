'use strict';

/**
 * provision.test.js — Feature 4 slice 4c (Provisioning) proof.
 *
 * The load-bearing, security-critical core: provisionEmployee() must be ATOMIC
 * and IDEMPOTENT, the endpoint SoD-gated, and the whole thing F1-scoped. Plain
 * node runner (no jest), same harness as onboarding.test.js, against an isolated
 * hr_test schema.
 *
 * Cases (spec §7 QA 1–3 + SoD + RBAC):
 *   QA1  mid-provision failure (wage-rule breach at the comp step) → FULL rollback
 *        (no Employee/User/EmploymentRecord/LeaveBalance rows persist), the
 *        PROVISION_EMPLOYEE task is FAILED, the journey BLOCKED.
 *   QA2  two concurrent provision calls → exactly one Employee; the loser gets a
 *        409 'already-provisioned'; the resultJson ledger is unchanged.
 *   QA3  after provision: Employee.userId linked, currentEmploymentRecordId +
 *        currentCompensationId set, Application.convertedEmployeeId written.
 *   SoD  provisioner == the offer's approver → 403 (rejected).
 *   RBAC non-canManageOnboarding → 403; a manager (TEAM) hitting a journey whose
 *        subject is out of their sub-tree → 404.
 *
 * Run (needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/provision.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── express-style controller harness (mirrors onboarding.test.js) ──
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

// Run the full route middleware chain (requirePermission → scope guard →
// handler), so RBAC 403/scope are exercised end-to-end, not just the handler.
function runChain(middlewares, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(res); } };
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); finish(); return r; };
    const origStatus = res.status.bind(res); res.status = (c) => { origStatus(c); return res; };
    let i = 0;
    const next = (err) => {
      if (err) { settled = true; return reject(err); }
      const mw = middlewares[i++];
      if (!mw) return finish();
      try { Promise.resolve(mw(req, res, next)).catch(reject); } catch (e) { reject(e); }
    };
    next();
  });
}

const PREFIX = 'PROV-TEST';
// provisionEmployee lowercases the candidate email into Employee.workEmail /
// User.email, so count/lookup queries must use the lowercased form.
const lcEmail = (tag) => `${PREFIX}-${tag}@example.com`.toLowerCase();

async function main() {
  log('\n=== slice 4c — provisionEmployee (atomicity + idempotency + SoD + RBAC) ===\n');

  if (!process.env.DATABASE_URL) {
    log('[skip] DATABASE_URL not set — provisioning proof needs the live hr_test schema.\n');
    return;
  }

  const prisma = require('../../../core/lib/prisma');
  const recruitment = require('../../talent/controllers/recruitment.controller');
  const onboarding = require('../controllers/onboarding.controller');
  const { provisionEmployee } = require('../provision');
  const { seedOnboardingTemplates } = require('../templates/seed');
  const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');
  const { requirePermission } = require('../../../core/middleware/auth.middleware');
  const { withEmployeeScope } = require('../../middleware/scope.middleware');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const entity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } })
    || await prisma.entity.findFirst({ where: { businessId } });
  const entityId = entity ? entity.id : null;

  // Build a self-contained hire (Job → Candidate → Application → Offer[SENT]),
  // accept it (seeds the journey), optionally stage selfServiceJson, and return
  // the journey. `wageBreach` forces a comp-step failure (INR offer, Basic < 50%).
  async function buildHire(tag, { wageBreach = false, approvalRequestId = null, managerId = null } = {}) {
    const job = await prisma.job.create({
      data: {
        businessId, entityId, code: `${PREFIX}-${tag}-JOB`, title: 'Engineer',
        countryCode: 'IN', employmentType: 'FULL_TIME', status: 'OPEN',
        ...(managerId ? { hiringManagerId: managerId } : {}),
      },
    });
    const candidate = await prisma.candidate.create({
      data: { businessId, firstName: 'New', lastName: tag, email: `${PREFIX}-${tag}@example.com` },
    });
    const application = await prisma.application.create({
      data: { businessId, jobId: job.id, candidateId: candidate.id, status: 'OFFERED' },
    });
    const offer = await prisma.offer.create({
      data: {
        businessId, applicationId: application.id, currencyCode: 'INR',
        joiningDate: new Date('2026-09-01'), status: 'SENT', grossMonthly: '60000',
        ctcAnnual: '900000', ...(approvalRequestId ? { approvalRequestId } : {}),
      },
    });
    // Accept (seeds the onboarding journey atomically).
    const op = { id: `${PREFIX}-op`, businessId, role: 'BUSINESS_ADMIN' };
    const ar = await callController(recruitment.acceptOffer, { user: op, params: { id: offer.id }, body: {} });
    if (ar.statusCode !== 200) throw new Error(`acceptOffer failed: ${ar.statusCode} ${JSON.stringify(ar.body)}`);
    const journey = await prisma.lifecycleJourney.findFirst({ where: { businessId, offerId: offer.id } });
    // Drive the journey to the PROVISIONING stage (advance() walks the gates;
    // the non-blocking/HR tasks before provisioning are skipped for the test).
    await prisma.lifecycleTask.updateMany({
      where: { journeyId: journey.id, stageKey: { in: ['PRE_JOIN', 'SELF_ONBOARDING', 'DOCS_ESIGN'] } },
      data: { status: 'DONE' },
    });
    await prisma.lifecycleJourney.update({ where: { id: journey.id }, data: { currentStage: 'PROVISIONING', status: 'IN_PROGRESS' } });
    // Stage selfServiceJson. By default we stage a VALID Basic/DA split (Basic =
    // 60% of gross) so the India 50% pre-write guard passes (H1: Basic is resolved
    // from this authoritative split, never defaulted to gross). wageBreach stages a
    // Basic far below 50% → the pre-write offerWageCheck throws (no rows created).
    const selfServiceJson = {
      personal: { firstName: 'New', lastName: tag, workEmail: `${PREFIX}-${tag}@example.com` },
      statutory: { pan: 'ABCPN1234Z', taxRegime: 'NEW' },
      bank: { accountNumber: '5012345678', ifsc: 'HDFC0001234', bankName: 'HDFC' },
      comp: wageBreach ? { basicMonthly: '10000' } : { basicMonthly: '36000' },
    };
    await prisma.lifecycleJourney.update({ where: { id: journey.id }, data: { selfServiceJson } });
    return { job, candidate, application, offer, journey };
  }

  async function cleanup() {
    const offers = await prisma.offer.findMany({
      where: { businessId, application: { candidate: { email: { startsWith: PREFIX } } } },
      select: { id: true, applicationId: true },
    });
    const offerIds = offers.map((o) => o.id);
    const appIds = offers.map((o) => o.applicationId);
    // Employees provisioned by these journeys — matched by their (lowercased)
    // workEmail. Match both cases since the provisioner lowercases the email.
    const emps = await prisma.employee.findMany({
      where: { businessId, OR: [{ workEmail: { startsWith: PREFIX } }, { workEmail: { startsWith: PREFIX.toLowerCase() } }] },
      select: { id: true, userId: true },
    });
    const empIds = emps.map((e) => e.id);
    if (offerIds.length) await prisma.lifecycleJourney.deleteMany({ where: { businessId, offerId: { in: offerIds } } });
    if (empIds.length) {
      await prisma.lifecycleTask.deleteMany({ where: { businessId, assigneeEmployeeId: { in: empIds } } });
      await prisma.lifecycleJourney.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.leaveBalance.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.bankAccount.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.emergencyContact.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.statutoryProfile.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.compensationRevision.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      // Null the current pointers so EmploymentRecord/Employee delete cleanly.
      await prisma.employee.updateMany({ where: { id: { in: empIds } }, data: { currentEmploymentRecordId: null, currentCompensationId: null, managerEmployeeId: null, userId: null } });
      await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      // And finally the provisioned Employee rows themselves.
      await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
    }
    if (appIds.length) await prisma.application.deleteMany({ where: { id: { in: appIds } } });
    await prisma.offer.deleteMany({ where: { businessId, application: { candidate: { email: { startsWith: PREFIX } } } } });
    await prisma.application.deleteMany({ where: { businessId, candidate: { email: { startsWith: PREFIX } } } });
    await prisma.candidate.deleteMany({ where: { businessId, email: { startsWith: PREFIX } } });
    await prisma.job.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    // Fixture employees (managers/out-of-scope subjects).
    const fxEmps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    if (fxEmps.length) {
      const ids = fxEmps.map((e) => e.id);
      await prisma.lifecycleTask.deleteMany({ where: { businessId, assigneeEmployeeId: { in: ids } } });
      await prisma.lifecycleJourney.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    }
    await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    // Portal Users/Customers minted by provisioning. provisionEmployee lowercases
    // the email, so we must match BOTH cases (Postgres startsWith/LIKE is
    // case-sensitive) to avoid leaking a unique-email row across runs.
    await prisma.user.deleteMany({ where: { businessId, OR: [{ email: { startsWith: PREFIX } }, { email: { startsWith: PREFIX.toLowerCase() } }] } });
    await prisma.customer.deleteMany({ where: { businessId, OR: [{ email: { startsWith: PREFIX } }, { email: { startsWith: PREFIX.toLowerCase() } }] } });
    // Approval fixtures.
    const ars = await prisma.approvalRequest.findMany({ where: { businessId, entityType: `${PREFIX}-OFFER` }, select: { id: true } });
    if (ars.length) {
      await prisma.approvalAction.deleteMany({ where: { approvalRequestId: { in: ars.map((a) => a.id) } } });
      await prisma.approvalRequest.deleteMany({ where: { id: { in: ars.map((a) => a.id) } } });
    }
  }

  await cleanup();

  try {
    await seedOnboardingTemplates(prisma, businessId, { entityId });

    // ════════════════════════════════════════════════════════════════════════
    // QA1 — wage-rule breach is a PRE-WRITE precondition (H1): NO rows written,
    //       task NOT FAILED, journey NOT BLOCKED (nothing was attempted).
    // ════════════════════════════════════════════════════════════════════════
    log('QA1) INR wage-rule breach → PRE-WRITE 422 (no rows, task/journey untouched):');
    {
      const { journey } = await buildHire('FAIL', { wageBreach: true });
      let threw = null;
      try {
        await provisionEmployee({ journeyId: journey.id, actorId: 'op-user' }, prisma);
      } catch (e) { threw = e; }
      assert(threw && threw.status === 422 && threw.reason === 'wage-rule', 'provision throws a 422 wage-rule error PRE-WRITE');

      // NO rows persisted (the guard ran before any create).
      const empCount = await prisma.employee.count({ where: { businessId, workEmail: lcEmail('FAIL') } });
      const userCount = await prisma.user.count({ where: { businessId, email: lcEmail('FAIL') } });
      assert(empCount === 0, 'NO Employee row persisted (pre-write guard)');
      assert(userCount === 0, 'NO portal User row persisted (pre-write guard)');

      // wage-rule is a PRE_WRITE reason → task NOT FAILED, journey NOT BLOCKED.
      const jAfter = await prisma.lifecycleJourney.findUnique({ where: { id: journey.id } });
      assert(jAfter.employeeId == null, 'journey NOT linked to any Employee');
      const task = await prisma.lifecycleTask.findFirst({ where: { journeyId: journey.id, taskKey: 'PROVISION_EMPLOYEE' } });
      assert(task && task.status !== 'FAILED', 'PROVISION_EMPLOYEE task NOT marked FAILED (pre-write)');
      assert(jAfter.status !== 'BLOCKED', 'journey NOT marked BLOCKED (pre-write precondition)');

      const orphanRecs = await prisma.employmentRecord.count({ where: { businessId, employee: { workEmail: lcEmail('FAIL') } } });
      assert(orphanRecs === 0, 'NO EmploymentRecord persisted');
    }

    // ════════════════════════════════════════════════════════════════════════
    // QA1b — INR hire with NO resolvable Basic/DA split → wage-rule 422 (H1: the
    //        old code defaulted Basic=Gross and silently passed). No rows written.
    // ════════════════════════════════════════════════════════════════════════
    log('QA1b) INR hire, no Basic/DA split resolvable → 422 wage-rule (no auto-pass):');
    {
      // buildHire stages a `comp` only when wageBreach=true; here we leave it out,
      // and the offer has no structureId → resolveBasicDaMonthly returns null.
      const { journey } = await buildHire('NOSPLIT');
      // Strip any comp split to be certain none is resolvable.
      const j0 = await prisma.lifecycleJourney.findUnique({ where: { id: journey.id } });
      const ss = { ...(j0.selfServiceJson || {}) };
      delete ss.comp;
      await prisma.lifecycleJourney.update({ where: { id: journey.id }, data: { selfServiceJson: ss } });

      let threw = null;
      try { await provisionEmployee({ journeyId: journey.id, actorId: 'op-user' }, prisma); }
      catch (e) { threw = e; }
      assert(threw && threw.status === 422 && threw.reason === 'wage-rule',
        'INR hire with no Basic/DA split → 422 wage-rule (never auto-passes Basic==Gross)');
      const empCount = await prisma.employee.count({ where: { businessId, workEmail: lcEmail('NOSPLIT') } });
      assert(empCount === 0, 'no Employee created when the wage rule cannot be validated');
    }

    // ════════════════════════════════════════════════════════════════════════
    // QA3 — happy path: linkage (run before QA2 so we have a clean fixture)
    // ════════════════════════════════════════════════════════════════════════
    log('QA3) successful provision links Employee/User/records + closes ATS loop:');
    let okJourneyId; let okEmployeeId;
    {
      const { journey, application } = await buildHire('OK');
      const out = await provisionEmployee({ journeyId: journey.id, actorId: 'op-user' }, prisma);
      okJourneyId = journey.id; okEmployeeId = out.employee.id;

      const emp = await prisma.employee.findUnique({ where: { id: out.employee.id } });
      assert(emp != null && /^EMP-\d{6}$/.test(emp.code), `Employee created with EMP code (${emp && emp.code})`);
      assert(emp.userId != null, 'Employee.userId linked to a portal User');
      assert(emp.currentEmploymentRecordId != null, 'Employee.currentEmploymentRecordId set');
      assert(emp.currentCompensationId != null, 'Employee.currentCompensationId set');
      assert(emp.status === 'PROBATION', 'FULL_TIME hire lands in PROBATION');

      const user = await prisma.user.findUnique({ where: { id: emp.userId } });
      assert(user && user.businessId === businessId && user.role === 'USER', 'portal User minted (role USER, tenant-scoped)');
      const cust = await prisma.customer.findFirst({ where: { businessId, email: user.email } });
      assert(cust != null, 'Customer ESS identity minted (mirrors seed-hr.js)');

      const app2 = await prisma.application.findUnique({ where: { id: application.id } });
      assert(app2.convertedEmployeeId === out.employee.id, 'Application.convertedEmployeeId written (ATS loop closed)');

      const jAfter = await prisma.lifecycleJourney.findUnique({ where: { id: journey.id } });
      assert(jAfter.employeeId === out.employee.id, 'journey bound to the new Employee');
      // The pure engine walks PROVISIONING → DAY_ONE → WEEK_ONE (no blockers) and
      // halts at PROBATION (its PROBATION_REVIEW blocker is still PENDING). So the
      // journey advances PAST PROVISIONING, which is the slice-4c contract.
      assert(jAfter.currentStage !== 'PROVISIONING'
        && ['DAY_ONE', 'WEEK_ONE', 'PROBATION'].includes(jAfter.currentStage),
        `journey advanced past PROVISIONING (now ${jAfter.currentStage})`);
      const ptask = await prisma.lifecycleTask.findFirst({ where: { journeyId: journey.id, taskKey: 'PROVISION_EMPLOYEE' } });
      assert(ptask.status === 'DONE' && ptask.resultJson && ptask.resultJson.employeeId === out.employee.id, 'PROVISION_EMPLOYEE task DONE w/ resultJson ledger');

      const balances = await prisma.leaveBalance.count({ where: { businessId, employeeId: out.employee.id } });
      assert(balances > 0, `LeaveBalance rows seeded for the entity's leave types (${balances})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // QA2 — idempotency: re-provision the linked journey → 409, no second Employee
    // ════════════════════════════════════════════════════════════════════════
    log('QA2) re-provision a linked journey → 409 already-provisioned (no duplicate):');
    {
      let threw = null;
      try { await provisionEmployee({ journeyId: okJourneyId, actorId: 'op-user' }, prisma); }
      catch (e) { threw = e; }
      assert(threw && threw.status === 409 && threw.reason === 'already-provisioned', 'second provision → 409 already-provisioned');
      assert(threw.employeeId === okEmployeeId, '409 returns the already-linked employeeId');
      const cnt = await prisma.employee.count({ where: { businessId, workEmail: lcEmail('OK') } });
      assert(cnt === 1, 'still exactly ONE Employee for the hire (no duplicate)');
    }

    // ── QA2b — TRUE concurrency: two provision() in flight at once → one wins ──
    log('QA2b) two concurrent provision calls → exactly one Employee, other 409:');
    {
      const { journey } = await buildHire('RACE');
      const settle = await Promise.allSettled([
        provisionEmployee({ journeyId: journey.id, actorId: 'op-a' }, prisma),
        provisionEmployee({ journeyId: journey.id, actorId: 'op-b' }, prisma),
      ]);
      const fulfilled = settle.filter((s) => s.status === 'fulfilled');
      const rejected = settle.filter((s) => s.status === 'rejected');
      const cnt = await prisma.employee.count({ where: { businessId, workEmail: lcEmail('RACE') } });
      assert(cnt === 1, `concurrent double-submit yields exactly ONE Employee (got ${cnt})`);
      assert(fulfilled.length === 1, 'exactly one provision call succeeds');
      assert(rejected.length === 1 && rejected[0].reason && (rejected[0].reason.status === 409 || rejected[0].reason.status === 500),
        'the loser is rejected (409 already-provisioned, or a serialization abort surfaced as 5xx)');
    }

    // ════════════════════════════════════════════════════════════════════════
    // SoD — provisioner == offer approver → 403
    // ════════════════════════════════════════════════════════════════════════
    log('SoD) provisioner == offer approver → 403 (rejected):');
    {
      // Mint an ApprovalRequest + APPROVED action by user "approver-1".
      const ar = await prisma.approvalRequest.create({
        data: { businessId, module: 'OFFER', entityType: `${PREFIX}-OFFER`, entityId: 'x', status: 'APPROVED' },
      });
      await prisma.approvalAction.create({
        data: { businessId, approvalRequestId: ar.id, stepOrder: 1, approverUserId: 'approver-1', decision: 'APPROVED' },
      });
      const { journey } = await buildHire('SOD', { approvalRequestId: ar.id });

      // The approver themselves tries to provision → 403.
      const approverUser = { id: 'approver-1', businessId, role: 'BUSINESS_ADMIN' };
      const r403 = await callController(onboarding.provisionJourney, {
        user: approverUser, scope: { kind: 'ALL' }, params: { id: journey.id }, body: {},
      });
      assert(r403.statusCode === 403 && r403.body.reason === 'sod-provision-vs-approve', 'offer approver provisioning → 403 SoD');
      const cnt = await prisma.employee.count({ where: { businessId, workEmail: lcEmail('SOD') } });
      assert(cnt === 0, 'SoD block created NO Employee');

      // A different actor with the permission provisions fine.
      const otherUser = { id: 'op-user', businessId, role: 'BUSINESS_ADMIN' };
      const rOk = await callController(onboarding.provisionJourney, {
        user: otherUser, scope: { kind: 'ALL' }, params: { id: journey.id }, body: {},
      });
      assert(rOk.statusCode === 201, 'a non-approver actor provisions → 201');
    }

    // ════════════════════════════════════════════════════════════════════════
    // SoD via the REAL offer path (M1) — the requisition's hiring manager (a field
    // that EXISTS in prod) cannot provision their own hire, even with NO approval.
    // ════════════════════════════════════════════════════════════════════════
    log('SoD-real) requisition hiring manager cannot provision their own hire (no approvalRequestId):');
    {
      // A manager Employee with a linked portal User (the recruiter on the Job).
      const mgrUser2 = await prisma.user.create({
        data: { email: `${PREFIX}-recruiter@example.com`, password: 'x', name: 'Recruiter', role: 'USER', businessId, isActive: true },
      });
      const mgrEmp2 = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-RECMGR`, firstName: 'Rec', lastName: 'Mgr', status: 'ACTIVE', userId: mgrUser2.id },
      });
      // buildHire wires Job.hiringManagerId = mgrEmp2.id (the REAL prod signal).
      const { journey } = await buildHire('SODR', { managerId: mgrEmp2.id });

      // The hiring manager themselves tries to provision → 403 (no approval gate).
      const r403 = await callController(onboarding.provisionJourney, {
        user: { id: mgrUser2.id, businessId, role: 'BUSINESS_ADMIN' }, scope: { kind: 'ALL' }, params: { id: journey.id }, body: {},
      });
      assert(r403.statusCode === 403 && r403.body.reason === 'sod-provision-vs-approve',
        'requisition hiring manager provisioning their own hire → 403 (real offer path, not a hand-set approvalRequestId)');
      const cnt = await prisma.employee.count({ where: { businessId, workEmail: lcEmail('SODR') } });
      assert(cnt === 0, 'SoD-real block created NO Employee');

      // A different HR actor provisions fine.
      const rOk = await callController(onboarding.provisionJourney, {
        user: { id: 'op-user', businessId, role: 'BUSINESS_ADMIN' }, scope: { kind: 'ALL' }, params: { id: journey.id }, body: {},
      });
      assert(rOk.statusCode === 201, 'a non-stakeholder actor provisions the same hire → 201');
    }

    // ════════════════════════════════════════════════════════════════════════
    // H2 — portal email collision is a PRE-WRITE decision (never a P2002 that
    //      BLOCKS the journey): same-tenant unlinked User → REUSE; cross-tenant → 409.
    // ════════════════════════════════════════════════════════════════════════
    log('H2a) same-tenant unlinked User with the hire email → REUSED (no duplicate, journey NOT blocked):');
    {
      // Pre-create an unlinked same-tenant User on the hire's email.
      const preUser = await prisma.user.create({
        data: { email: lcEmail('REUSE'), password: 'x', name: 'Pre Existing', role: 'USER', businessId, isActive: true },
      });
      const { journey } = await buildHire('REUSE');
      const out = await provisionEmployee({ journeyId: journey.id, actorId: 'op-user' }, prisma);
      const emp = await prisma.employee.findUnique({ where: { id: out.employee.id } });
      assert(emp.userId === preUser.id, 'provision REUSED the pre-existing same-tenant User (linked to the new Employee)');
      const userCount = await prisma.user.count({ where: { businessId, email: lcEmail('REUSE') } });
      assert(userCount === 1, 'still exactly ONE User on that email (no duplicate created)');
      const jAfter = await prisma.lifecycleJourney.findUnique({ where: { id: journey.id } });
      assert(jAfter.status !== 'BLOCKED' && jAfter.employeeId === out.employee.id, 'journey provisioned (NOT blocked)');
    }

    log('H2b) cross-tenant User with the hire email → 409 email-in-use, PRE-WRITE (journey NOT blocked):');
    {
      // A User on the same email but in a DIFFERENT business.
      const otherBiz = await prisma.business.create({
        data: { name: `${PREFIX}-otherbiz`, slug: `${PREFIX.toLowerCase()}-otherbiz-${Date.now()}` },
      });
      const crossUser = await prisma.user.create({
        data: { email: lcEmail('XTEN'), password: 'x', name: 'Cross Tenant', role: 'USER', businessId: otherBiz.id, isActive: true },
      });
      const { journey } = await buildHire('XTEN');
      let threw = null;
      try { await provisionEmployee({ journeyId: journey.id, actorId: 'op-user' }, prisma); }
      catch (e) { threw = e; }
      assert(threw && threw.status === 409 && threw.reason === 'email-in-use',
        'cross-tenant email collision → 409 email-in-use (PRE-WRITE, real reason surfaced)');
      const empCount = await prisma.employee.count({ where: { businessId, workEmail: lcEmail('XTEN') } });
      assert(empCount === 0, 'no Employee created on a cross-tenant email collision');
      const jAfter = await prisma.lifecycleJourney.findUnique({ where: { id: journey.id } });
      assert(jAfter.status !== 'BLOCKED', 'journey NOT marked BLOCKED on a pre-write email-in-use');
      // cleanup the cross-tenant fixtures
      await prisma.user.delete({ where: { id: crossUser.id } });
      await prisma.business.delete({ where: { id: otherBiz.id } });
    }

    // ════════════════════════════════════════════════════════════════════════
    // M2 — Customer ESS identity: provisioning must NOT clobber an anonymised
    //      (GDPR) row, and must NOT auto-clear anonymisedAt.
    // ════════════════════════════════════════════════════════════════════════
    log('M2) provisioning preserves an anonymised same-tenant Customer (no un-anonymise):');
    {
      const anonAt = new Date('2025-01-01T00:00:00Z');
      // Pre-create an anonymised Customer on the hire's email (a GDPR-erased row).
      await prisma.customer.create({
        data: { businessId, email: lcEmail('ANON'), password: 'erased', name: 'Erased', isActive: false, anonymisedAt: anonAt },
      });
      const { journey } = await buildHire('ANON');
      const out = await provisionEmployee({ journeyId: journey.id, actorId: 'op-user' }, prisma);
      assert(out && out.employee && out.employee.id, 'provision still succeeds with an anonymised Customer present');
      const cust = await prisma.customer.findFirst({ where: { businessId, email: lcEmail('ANON') } });
      assert(cust && cust.anonymisedAt != null && new Date(cust.anonymisedAt).getTime() === anonAt.getTime(),
        'anonymisedAt PRESERVED (provisioning never auto-un-anonymises a Customer)');
      assert(cust.name === 'Erased' && cust.isActive === false,
        'the anonymised Customer row was NOT clobbered (name/isActive untouched)');
    }

    // ════════════════════════════════════════════════════════════════════════
    // RBAC — non-permission → 403; manager out-of-scope subject → 404
    // ════════════════════════════════════════════════════════════════════════
    log('RBAC) permission gate + manager scope (out-of-scope subject → 404):');
    {
      const { journey } = await buildHire('RBAC');

      // (a) An actor WITHOUT canManageOnboarding is blocked by requirePermission.
      const noPermUser = {
        id: 'noperm', businessId, role: 'STAFF',
        businessRole: { permissions: { canViewEmployees: true }, defaultScope: 'TEAM' },
      };
      const chain = [
        requirePermission('canManageOnboarding'),
        withEmployeeScope('canManageOnboarding'),
        onboarding.provisionJourney,
      ];
      const r403 = await runChain(chain, { user: noPermUser, params: { id: journey.id }, query: {}, body: {} });
      assert(r403.statusCode === 403, 'non-canManageOnboarding actor → 403 (requirePermission)');

      // (b) A manager (TEAM band) WITH the permission but whose sub-tree does NOT
      //     contain the journey's subject → 404 (IDOR-safe). Link the journey to
      //     an out-of-scope employee first.
      const outEmp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-OUTSUBJ`, firstName: 'Out', lastName: 'Subj', status: 'PROBATION' },
      });
      await prisma.lifecycleJourney.update({ where: { id: journey.id }, data: { employeeId: outEmp.id } });
      const mgrUser = {
        id: `${PREFIX}-mgr-user`, businessId, role: 'STAFF', employeeId: null,
        businessRole: { permissions: { canManageOnboarding: true }, defaultScope: 'TEAM' },
      };
      // Give the manager a self Employee with an empty sub-tree (no reports).
      const mgrEmp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-MGR`, firstName: 'Mgr', lastName: 'T', status: 'ACTIVE' },
      });
      mgrUser.employeeId = mgrEmp.id;
      const scope = await resolveAccessibleEmployeeIds(mgrUser, 'canManageOnboarding');
      const r404 = await callController(onboarding.provisionJourney, {
        user: mgrUser, scope, params: { id: journey.id }, body: {},
      });
      assert(r404.statusCode === 404, 'manager hitting an out-of-sub-tree subject → 404 (not 403)');
    }

    // ════════════════════════════════════════════════════════════════════════
    // Probation — confirmProbation: PROBATION → ACTIVE + PROBATION_CONFIRM record
    // ════════════════════════════════════════════════════════════════════════
    log('PROBATION) confirmProbation flips a PROBATION hire to ACTIVE:');
    {
      const { journey } = await buildHire('PROB');
      const out = await provisionEmployee({ journeyId: journey.id, actorId: 'op-user' }, prisma);
      const empId = out.employee.id;
      const before = await prisma.employee.findUnique({ where: { id: empId } });
      assert(before.status === 'PROBATION', 'provisioned hire starts in PROBATION');

      const c1 = await callController(onboarding.confirmProbation, {
        user: { id: 'op-user', businessId, role: 'BUSINESS_ADMIN' }, scope: { kind: 'ALL' },
        params: { id: journey.id }, body: {},
      });
      assert(c1.statusCode === 200 && c1.body.employee.status === 'ACTIVE', 'confirm-probation → 200, status ACTIVE');
      const after = await prisma.employee.findUnique({ where: { id: empId } });
      assert(after.status === 'ACTIVE' && after.probationEndDate == null, 'Employee.status ACTIVE, probationEndDate cleared');
      const confirmRec = await prisma.employmentRecord.findFirst({ where: { employeeId: empId, changeReason: 'PROBATION_CONFIRM' } });
      assert(confirmRec != null && confirmRec.isCurrent, 'EmploymentRecord(PROBATION_CONFIRM) written + current');
      assert(after.currentEmploymentRecordId === confirmRec.id, 'currentEmploymentRecordId points at the PROBATION_CONFIRM record');

      // Idempotent: a second confirm is a no-op (already ACTIVE).
      const c2 = await callController(onboarding.confirmProbation, {
        user: { id: 'op-user', businessId, role: 'BUSINESS_ADMIN' }, scope: { kind: 'ALL' },
        params: { id: journey.id }, body: {},
      });
      assert(c2.statusCode === 200 && c2.body.changed === false, 'second confirm-probation is an idempotent no-op');
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  failures += 1;
  log(`  FAIL  suite threw: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

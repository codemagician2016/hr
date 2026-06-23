'use strict';

/**
 * profileMss.rbac.test.js — LIVE proof for Feature 13 (rich profile governance + MSS).
 * Same harness/runner as scope.rbac.test.js (plain node, isolated hr_test schema,
 * fixture torn down at the end). Proves:
 *
 *   GOVERNANCE
 *     (a) a self-edit field (phone) PATCH commits immediately (no change request).
 *     (b) a gated field (dateOfBirth) PATCH does NOT touch the row; it opens a
 *         ProfileChangeRequest(PENDING) + an ApprovalRequest(PROFILE_CHANGE).
 *     (c) HR approve applies newValue atomically + flips the CR to APPROVED.
 *     (d) SoD: the requester's own linked HR user cannot approve their own request.
 *     (e) a read-only field (code) is rejected (never written, never requested).
 *     (f) unknown field key fails closed (read-only → rejected).
 *     (g) emergency-contact cap (≤2) + nominee-percent (≤100) guards.
 *
 *   MSS SCOPE (the customer session gets the F1 TEAM band)
 *     (h) a Manager's /me/team/roster = their sub-tree (R1,R2), excludes the peer.
 *     (i) an IC (SELF band) gets an EMPTY team (no peers — IDOR-safe).
 *     (j) a Manager's team org is rooted at them and contains only their sub-tree.
 *     (k) a Manager cannot decide their OWN leave via /me/team (SoD → 404).
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/profile/__tests__/profileMss.rbac.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const prisma = require('../../../core/lib/prisma');
const rich = require('../meProfileRich.controller');
const sections = require('../meProfileSections.controller');
const team = require('../meTeam.controller');
const queue = require('../profileChangeAdmin.controller');
const { resolveCustomerScope } = require('../../lib/customerScope');
const engine = require('../../approvals/engine');
require('../../approvals/registerConsumers'); // ensure PROFILE_CHANGE consumer is wired

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); } }

// ── Express res()/controller doubles (from the scope harness) ─────────────────
function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { this.body = undefined; return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res);
    res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res);
    res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'F13-TEST';
async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { is: { requesterEmployeeId: { in: ids } } } } }).catch(() => {});
    await prisma.approvalRequest.deleteMany({ where: { businessId, requesterEmployeeId: { in: ids } } }).catch(() => {});
    await prisma.profileChangeRequest.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    await prisma.emergencyContact.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    await prisma.dependant.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    await prisma.employeeEducation.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    await prisma.employeeAddress.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    await prisma.leaveTransaction.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
  }
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  // Employees/users/roles are purged GLOBALLY by the F13 prefix (not businessId-scoped):
  // the shared hr_test schema can be reset by sibling agents mid-run, churning the
  // tenant id, so any orphan F13 fixture from a crashed run is cleared regardless of
  // which tenant it was under (User.email carries a global unique constraint).
  await prisma.employee.updateMany({ where: { code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { code: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX.toLowerCase() } } }).catch(() => {});
  await prisma.businessRole.deleteMany({ where: { name: { startsWith: PREFIX } } }).catch(() => {});
}

// Resolve a tenant to run inside: prefer the seed 'demo'; otherwise upsert a
// dedicated F13 test business (the hr_test schema is shared by sibling agents, so we
// never depend on another suite's fixture surviving).
async function resolveTenant() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' }, select: { id: true } });
  if (demo) return demo.id;
  const own = await prisma.business.upsert({
    where: { slug: `${PREFIX.toLowerCase()}-tenant` },
    update: {},
    create: { slug: `${PREFIX.toLowerCase()}-tenant`, name: 'F13 Test Co', region: 'IN' },
    select: { id: true },
  });
  return own.id;
}

async function main() {
  log('\n=== Feature 13 profile-governance + MSS proof (LIVE hr_test) ===\n');
  const businessId = await resolveTenant();
  log(`tenant businessId = ${businessId}\n`);
  await cleanup(businessId);

  // ── Roles: a TEAM-band role (managers) + an HR approver role (canApproveLeave) ──
  const teamRole = await prisma.businessRole.create({ data: { businessId, name: `${PREFIX}-TeamRole`, defaultScope: 'TEAM', permissions: { canViewEmployees: true, canApproveLeave: true } } });
  const selfRole = await prisma.businessRole.create({ data: { businessId, name: `${PREFIX}-SelfRole`, defaultScope: 'SELF', permissions: {} } });

  // Users (portal identities). The MGR is the manager; HR is a SEPARATE approver.
  const mkUser = (slug, roleId) => prisma.user.create({ data: { businessId, email: `${PREFIX.toLowerCase()}-${slug}@example.com`, name: `${slug}`, role: 'USER', isActive: true, businessRoleId: roleId, password: 'x-not-a-real-hash' } });
  const mgrUser = await mkUser('mgr', teamRole.id);
  const r1User = await mkUser('r1', selfRole.id);
  const hrUser = await mkUser('hr', teamRole.id); // an HR approver (canApproveLeave) ≠ requester

  // Employees: MGR → {R1,R2}; PEER outside MGR's tree. Emails link to the users.
  const mkEmp = (code, extra = {}) => prisma.employee.create({ data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', isActive: true, ...extra } });
  const mgr = await mkEmp('MGR', { userId: mgrUser.id, workEmail: mgrUser.email, dateOfBirth: new Date('1990-01-01'), phone: '+910000000000' });
  const r1 = await mkEmp('R1', { managerEmployeeId: mgr.id, userId: r1User.id, workEmail: r1User.email, dateOfBirth: new Date('1995-05-05'), phone: '+911111111111' });
  const r2 = await mkEmp('R2', { managerEmployeeId: mgr.id });
  const peer = await mkEmp('PEER');
  // An HR operator who is ALSO an employee (to prove the operator-self SoD guard).
  const hrEmp = await mkEmp('HR', { userId: hrUser.id, workEmail: hrUser.email });

  // Customer-session doubles (the ESS auth shape: { id, businessId, email }).
  const custOf = (user) => ({ id: `cust-${user.id}`, businessId, email: user.email });
  const mgrCust = custOf(mgrUser);
  const r1Cust = custOf(r1User);

  try {
    // ═══ (a) self-edit field commits immediately ═══
    log('(a) self-edit phone commits immediately:');
    {
      const res = await callController(rich.patchContact, { customer: r1Cust, body: { phone: '+919999999999' } });
      assert(res.statusCode === 200 && res.body.applied && res.body.applied.includes('phone'), 'phone reported as applied');
      const fresh = await prisma.employee.findUnique({ where: { id: r1.id }, select: { phone: true } });
      assert(fresh.phone === '+919999999999', 'phone written to the Employee row immediately');
      const crs = await prisma.profileChangeRequest.count({ where: { businessId, employeeId: r1.id, field: 'phone' } });
      assert(crs === 0, 'no ProfileChangeRequest was created for a self-edit field');
    }

    // ═══ (b) gated field opens a change request, does NOT write the row ═══
    log('(b) gated dateOfBirth opens a PENDING change request (row untouched):');
    let dobCrId = null; let dobArId = null;
    {
      const res = await callController(rich.patchPersonal, { customer: r1Cust, body: { dateOfBirth: '2000-12-31' } });
      assert(res.statusCode === 200 && res.body.pending && res.body.pending.length === 1, 'dateOfBirth reported as pending (not applied)');
      assert(!(res.body.applied || []).includes('dateOfBirth'), 'dateOfBirth NOT in the applied bucket');
      const cr = await prisma.profileChangeRequest.findFirst({ where: { businessId, employeeId: r1.id, field: 'dateOfBirth', status: 'PENDING' } });
      assert(!!cr, 'a ProfileChangeRequest(PENDING) exists for dateOfBirth');
      assert(!!cr.approvalRequestId, 'the change request is backed by an ApprovalRequest');
      dobCrId = cr.id; dobArId = cr.approvalRequestId;
      const ar = await prisma.approvalRequest.findUnique({ where: { id: dobArId } });
      assert(ar && ar.module === 'PROFILE_CHANGE' && ar.status === 'PENDING', 'ApprovalRequest(module=PROFILE_CHANGE, PENDING)');
      const fresh = await prisma.employee.findUnique({ where: { id: r1.id }, select: { dateOfBirth: true } });
      assert(fresh.dateOfBirth.toISOString().slice(0, 10) === '1995-05-05', 'the Employee.dateOfBirth row is UNCHANGED while pending');
    }

    // ═══ (d) SoD — the requester's own user cannot approve their own request ═══
    log('(d) SoD — requester cannot approve their own change request:');
    {
      let threw = null;
      try { await engine.recordDecision({ approvalRequestId: dobArId, actorUserId: r1User.id, decision: 'APPROVED' }); } catch (e) { threw = e; }
      assert(threw && (threw.code === 'SOD_VIOLATION' || threw.code === 'NOT_AN_APPROVER'), `requester self-approval blocked (${threw && threw.code})`);
      const fresh = await prisma.employee.findUnique({ where: { id: r1.id }, select: { dateOfBirth: true } });
      assert(fresh.dateOfBirth.toISOString().slice(0, 10) === '1995-05-05', 'row still unchanged after a blocked self-approval');
    }

    // ═══ (c) HR approve applies the value atomically + flips the CR ═══
    log('(c) HR approve applies dateOfBirth + flips the change request:');
    {
      // Decide as the HR user (an approver in the PROFILE_CHANGE HR step, ≠ requester).
      const result = await engine.recordDecision({ approvalRequestId: dobArId, actorUserId: hrUser.id, decision: 'APPROVED' });
      assert(result.terminal === 'APPROVED', 'engine returns terminal APPROVED');
      const cr = await prisma.profileChangeRequest.findUnique({ where: { id: dobCrId } });
      assert(cr.status === 'APPROVED', 'ProfileChangeRequest → APPROVED');
      const fresh = await prisma.employee.findUnique({ where: { id: r1.id }, select: { dateOfBirth: true } });
      assert(fresh.dateOfBirth.toISOString().slice(0, 10) === '2000-12-31', 'Employee.dateOfBirth now equals the approved newValue');
    }

    // ═══ (e) read-only field rejected ═══
    log('(e) read-only field (code) rejected:');
    {
      const res = await callController(rich.patchPersonal, { customer: r1Cust, body: { code: 'HACK-001' } });
      assert(res.statusCode === 400 && res.body.errors && res.body.errors.code, 'read-only code rejected (400, never written/requested)');
      const fresh = await prisma.employee.findUnique({ where: { id: r1.id }, select: { code: true } });
      assert(fresh.code === `${PREFIX}-R1`, 'employee code unchanged');
    }

    // ═══ (f) unknown field fails closed ═══
    log('(f) unknown field key fails closed (read-only → rejected):');
    {
      const res = await callController(rich.patchPersonal, { customer: r1Cust, body: { someBogusField: 'x' } });
      assert(res.statusCode === 400 && res.body.errors && res.body.errors.someBogusField, 'unknown field rejected (fail-closed)');
    }

    // ═══ (g) emergency cap + nominee-percent guards ═══
    log('(g) emergency cap (≤2) + nominee-percent (≤100):');
    {
      await callController(sections.createEmergency, { customer: r1Cust, body: { name: 'A', relationship: 'Spouse', phone: '1' } });
      await callController(sections.createEmergency, { customer: r1Cust, body: { name: 'B', relationship: 'Parent', phone: '2' } });
      const third = await callController(sections.createEmergency, { customer: r1Cust, body: { name: 'C', relationship: 'Sibling', phone: '3' } });
      assert(third.statusCode === 400, 'third emergency contact rejected (cap = 2)');
      const cnt = await prisma.emergencyContact.count({ where: { businessId, employeeId: r1.id } });
      assert(cnt === 2, 'exactly 2 emergency contacts stored');

      await callController(sections.createFamily, { customer: r1Cust, body: { name: 'N1', relationship: 'SPOUSE', isNominee: true, nomineePercent: 60 } });
      const over = await callController(sections.createFamily, { customer: r1Cust, body: { name: 'N2', relationship: 'CHILD', isNominee: true, nomineePercent: 50 } });
      assert(over.statusCode === 400, 'nominee sum > 100 rejected (60 + 50)');
      const ok = await callController(sections.createFamily, { customer: r1Cust, body: { name: 'N3', relationship: 'CHILD', isNominee: true, nomineePercent: 40 } });
      assert(ok.statusCode === 201, 'nominee sum = 100 accepted (60 + 40)');
    }

    // ═══ (h) MSS roster = the manager's sub-tree, peer excluded ═══
    log('(h) Manager /me/team/roster = sub-tree (R1,R2), peer excluded:');
    {
      const res = await callController(team.roster, { customer: mgrCust, query: {} });
      const ids = new Set((res.body.items || []).map((e) => e.id));
      assert(res.statusCode === 200, 'roster → 200');
      assert(ids.has(r1.id) && ids.has(r2.id), 'roster includes both direct reports R1,R2');
      assert(!ids.has(peer.id), 'roster EXCLUDES the peer (out of sub-tree)');
      assert(!ids.has(mgr.id), 'roster EXCLUDES the manager themselves (team = reports)');
    }

    // ═══ (i) IC (SELF band) gets an EMPTY team ═══
    log('(i) IC (SELF band) gets an empty team (no peers — IDOR-safe):');
    {
      const res = await callController(team.roster, { customer: r1Cust, query: {} });
      assert(res.statusCode === 200 && Array.isArray(res.body.items) && res.body.items.length === 0, 'IC roster is [] (sub-tree minus self = ∅)');
      const scopeProbe = await resolveCustomerScope(r1Cust, 'canViewEmployees');
      assert(scopeProbe.scope.kind === 'IDS' && scopeProbe.scope.ids.size === 1, 'IC scope = {self} only (no peers resolvable)');
    }

    // ═══ (j) Manager team org rooted at them, contains only the sub-tree ═══
    log('(j) Manager /me/team/org rooted at the manager:');
    {
      const res = await callController(team.org, { customer: mgrCust, query: { root: 'me' } });
      assert(res.statusCode === 200 && res.body.root === mgr.id, 'org root = the manager');
      const top = (res.body.items || [])[0];
      assert(top && top.id === mgr.id, 'top node is the manager');
      const childIds = new Set((top.children || []).map((c) => c.id));
      assert(childIds.has(r1.id) && childIds.has(r2.id) && !childIds.has(peer.id), 'children = {R1,R2}, peer absent');
      assert(Object.prototype.hasOwnProperty.call(top, 'photoUrl'), 'org node carries photoUrl (Photo|Name|Position)');
    }

    // ═══ (k) Manager cannot decide their OWN leave via /me/team (SoD → 404) ═══
    log('(k) Manager cannot decide OWN leave via /me/team (SoD → 404):');
    {
      const lt = await prisma.leaveType.create({ data: { businessId, code: `${PREFIX}-EL`, name: 'F13 EL', category: 'ANNUAL', unit: 'DAYS' } });
      const ownApp = await prisma.leaveTransaction.create({ data: { businessId, employeeId: mgr.id, leaveTypeId: lt.id, txnType: 'APPLICATION', unit: 'DAYS', quantity: -1, startDate: new Date('2026-07-01'), endDate: new Date('2026-07-01'), status: 'PENDING', appliedAt: new Date(), reason: `${PREFIX}` } });
      const res = await callController(team.leaveDecide, { customer: mgrCust, params: { id: ownApp.id }, body: { decision: 'approve' } });
      assert(res.statusCode === 404, 'own leave decide → 404 (resolver subtracts self from canApproveLeave scope)');
      const reload = await prisma.leaveTransaction.findUnique({ where: { id: ownApp.id } });
      assert(reload.status === 'PENDING', 'own leave stays PENDING (SoD enforced)');
    }

    // ═══ (l) operator-self SoD on the HR queue (operator ≠ own linked employee) ═══
    log('(l) HR operator cannot approve a change request for THEIR OWN linked employee:');
    {
      // hrEmp self-submits a gated change (as a customer), then tries to approve as the operator.
      const hrCust = custOf(hrUser);
      const submit = await callController(rich.patchPersonal, { customer: hrCust, body: { lastName: 'Changed' } });
      const cr = await prisma.profileChangeRequest.findFirst({ where: { businessId, employeeId: hrEmp.id, status: 'PENDING' } });
      assert(!!cr, 'HR employee self-submitted a gated lastName change');
      // operator session double: req.user with employeeId = hrEmp.id, ALL scope.
      const operatorReq = { user: { id: hrUser.id, businessId, employeeId: hrEmp.id, role: 'BUSINESS_ADMIN', businessRole: { defaultScope: 'ALL' } }, scope: { kind: 'ALL' }, params: { id: cr.id }, body: {} };
      const res = await callController(queue.approve, operatorReq);
      assert(res.statusCode === 403, 'operator-self approval blocked (SoD → 403)');
      const reload = await prisma.profileChangeRequest.findUnique({ where: { id: cr.id } });
      assert(reload.status === 'PENDING', 'the self change request stays PENDING');
    }
  } finally {
    await cleanup(businessId);
  }

  log(`\n=== ${failures === 0 ? 'ALL FEATURE-13 CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('F13 test crashed:', err);
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});

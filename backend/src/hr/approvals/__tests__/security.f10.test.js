'use strict';

/**
 * security.f10.test.js — Feature 10 §7 security-fix proofs against LIVE hr_test.
 * Drives the REAL rbac + approvals controllers through the fake-res harness (same
 * pattern as api.live.test.js). Proves the four CONFIRMED findings are closed:
 *
 *   1. HIGH  RBAC privilege escalation — a non-Owner canManageRoles holder CANNOT
 *            create/edit/grant/assign a role with perms they lack, an Owner-only key,
 *            or a broader data-scope (→ 403). An Owner-equivalent caller still can.
 *   2. MED   Last-Owner protection — cannot strip the tenant's last canManageRoles
 *            holder via assign-role or a role edit (→ 400).
 *   3. MED   GET /approvals/:id leak — a non-approver / non-admin / out-of-scope
 *            operator gets 404; an approver without ABSOLUTE comp-visibility gets a
 *            masked COMPENSATION payload (no absolute money).
 *   4. LOW   Terminated approver — a terminated employee with a still-active User is
 *            excluded from REPORTING_MANAGER / HR / SPECIFIC_EMPLOYEE resolution.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/security.f10.test.js
 */

const prisma = require('../../../core/lib/prisma');
const rbacC = require('../../controllers/rbac.controller');
const approvalsC = require('../../controllers/approvals.controller');
const engine = require('../engine');
const { resolveStepApprovers } = require('../approverResolver');
const { SYSTEM_ROLES, PERMISSION_KEYS } = require('../../../core/lib/rbac');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const oj = res.json.bind(res); res.json = (p) => { const r = oj(p); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'F10SEC-TEST';

async function cleanup(businessId) {
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { entityType: { startsWith: PREFIX } } } });
  await prisma.approvalRequest.deleteMany({ where: { businessId, entityType: { startsWith: PREFIX } } });
  await prisma.workflowStep.deleteMany({ where: { businessId, workflow: { code: { startsWith: PREFIX } } } });
  await prisma.workflowDefinition.deleteMany({ where: { businessId, OR: [{ code: { startsWith: PREFIX } }, { name: { startsWith: PREFIX } }] } });
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  // null out users' custom roles before deleting roles (FK), then delete emps/users/roles.
  const roleIds = (await prisma.businessRole.findMany({ where: { businessId, name: { startsWith: PREFIX } }, select: { id: true } })).map((r) => r.id);
  if (roleIds.length) await prisma.user.updateMany({ where: { businessId, businessRoleId: { in: roleIds } }, data: { businessRoleId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } });
  await prisma.businessRole.deleteMany({ where: { businessId, name: { startsWith: PREFIX } } });
}

let seq = 0;
async function mkUserEmp(businessId, name, { managerEmployeeId = null, businessRoleId = null, status = 'ACTIVE', isActive = true } = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { businessId, email: `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`, password: 'x', name, role: 'USER', isActive: true, businessRoleId },
  });
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status, isActive, userId: user.id, managerEmployeeId },
  });
  return { user, emp };
}

// Build a req.user that effectivePermissions() understands: carries the role JSON.
async function asOperator(businessId, roleId) {
  const role = roleId ? await prisma.businessRole.findUnique({ where: { id: roleId }, select: { id: true, name: true, permissions: true, isSystem: true, defaultScope: true, compVisibility: true } }) : null;
  return { id: `op-${roleId || 'none'}`, businessId, businessRoleId: roleId || null, businessRole: role, role: 'USER' };
}

async function main() {
  log('\n=== F10 security-fix proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    // ── roles ──────────────────────────────────────────────────────────────────
    // HR-Admin-like custom role: canManageRoles + canViewEmployees, scope TEAM, but
    // NOT canApprovePayroll / canEditBilling / canEditDomain (the escalation targets).
    const hrAdminRole = await prisma.businessRole.create({
      data: {
        businessId, name: `${PREFIX}-HRish`, isSystem: false, defaultScope: 'TEAM', compVisibility: 'NONE',
        permissions: { canManageRoles: true, canViewEmployees: true, canManageEmployees: true, canApproveLeave: true },
      },
    });
    // Owner-equivalent custom role (all keys) — the legitimate granter, scope ALL.
    const ownerRole = await prisma.businessRole.create({
      data: {
        businessId, name: `${PREFIX}-OwnerAll`, isSystem: false, defaultScope: 'ALL', compVisibility: 'ABSOLUTE',
        permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])),
      },
    });

    const hrAdmin = await asOperator(businessId, hrAdminRole.id);
    const owner = await asOperator(businessId, ownerRole.id);

    // ── (1) HIGH — privilege escalation blocked ──────────────────────────────────
    log('(1) RBAC privilege-escalation cap:');
    {
      // (a) non-Owner cannot grant an Owner-only key (canApprovePayroll) via createRole.
      const escPayroll = await call(rbacC.createRole, { user: hrAdmin, body: { name: `${PREFIX}-EscPay`, permissions: { canApprovePayroll: true } } });
      assert(escPayroll.statusCode === 403, `createRole canApprovePayroll by non-Owner → 403 (got ${escPayroll.statusCode})`);

      // (b) non-Owner cannot grant a key they simply don't hold (canManageStatutory).
      const escUnheld = await call(rbacC.createRole, { user: hrAdmin, body: { name: `${PREFIX}-EscStat`, permissions: { canManageStatutory: true } } });
      assert(escUnheld.statusCode === 403, `createRole of an unheld key by non-Owner → 403 (got ${escUnheld.statusCode})`);

      // (c) non-Owner cannot mint a broader-than-own data-scope (TEAM holder → ALL role).
      const escScope = await call(rbacC.createRole, { user: hrAdmin, body: { name: `${PREFIX}-EscScope`, permissions: { canViewEmployees: true }, defaultScope: 'ALL' } });
      assert(escScope.statusCode === 403, `createRole defaultScope ALL by a TEAM holder → 403 (got ${escScope.statusCode})`);

      // (d) the SAME role within the caller's own perms+scope succeeds.
      const okRole = await call(rbacC.createRole, { user: hrAdmin, body: { name: `${PREFIX}-OkSubset`, permissions: { canApproveLeave: true, canViewEmployees: true }, defaultScope: 'TEAM' } });
      assert(okRole.statusCode === 201, `createRole within own perms+scope → 201 (got ${okRole.statusCode})`);

      // (e) addGrant of an Owner-only key by a non-Owner → 403.
      const grantEsc = await call(rbacC.addGrant, { user: hrAdmin, params: { id: okRole.body.id }, body: { permissionKey: 'canEditBilling' } });
      assert(grantEsc.statusCode === 403, `addGrant canEditBilling by non-Owner → 403 (got ${grantEsc.statusCode})`);

      // (f) updateRole that adds an unheld key → 403.
      const updEsc = await call(rbacC.updateRole, { user: hrAdmin, params: { id: okRole.body.id }, body: { permissions: { canApproveLeave: true, canManageStatutory: true } } });
      assert(updEsc.statusCode === 403, `updateRole adding an unheld key → 403 (got ${updEsc.statusCode})`);

      // (g) an Owner-equivalent caller CAN grant the same Owner-only key.
      const ownerOk = await call(rbacC.createRole, { user: owner, body: { name: `${PREFIX}-OwnerGrant`, permissions: { canApprovePayroll: true, canEditBilling: true }, defaultScope: 'ALL' } });
      assert(ownerOk.statusCode === 201, `Owner-equivalent grants Owner-only keys → 201 (got ${ownerOk.statusCode})`);

      // (h) assignRole: a non-Owner cannot bind a role MORE privileged than themselves.
      const victim = await mkUserEmp(businessId, 'Victim');
      const assignEsc = await call(rbacC.assignRole, { user: hrAdmin, params: { id: victim.emp.id }, body: { businessRoleId: ownerRole.id } });
      assert(assignEsc.statusCode === 403, `assignRole of a more-privileged role by non-Owner → 403 (got ${assignEsc.statusCode})`);

      // (i) a non-Owner CANNOT propagate an Owner-only key — assigning even their OWN
      // role (which carries canManageRoles) is refused (no minting more tenant-controllers).
      const assignSelfRole = await call(rbacC.assignRole, { user: hrAdmin, params: { id: victim.emp.id }, body: { businessRoleId: hrAdminRole.id } });
      assert(assignSelfRole.statusCode === 403, `assignRole propagating canManageRoles by non-Owner → 403 (got ${assignSelfRole.statusCode})`);

      // (j) …but a LESSER role (only keys the caller holds, no Owner-only key, scope ≤ own)
      // assigns fine — proves we didn't over-block the legitimate path.
      const lesserRole = await prisma.businessRole.create({
        data: { businessId, name: `${PREFIX}-Lesser`, isSystem: false, defaultScope: 'SELF', permissions: { canApproveLeave: true, canViewEmployees: true } },
      });
      const assignOk = await call(rbacC.assignRole, { user: hrAdmin, params: { id: victim.emp.id }, body: { businessRoleId: lesserRole.id } });
      assert(assignOk.statusCode === 200, `assignRole of a lesser role within own perms+scope → 200 (got ${assignOk.statusCode})`);
    }

    // ── (2) MED — last-Owner protection ──────────────────────────────────────────
    log('(2) last-canManageRoles protection:');
    {
      // Make `soleOwner` the ONLY active canManageRoles holder in the tenant.
      // (the seeded demo Owner user could also hold it — neutralize by counting and,
      //  if needed, skipping; but we create an isolated guarantee below.)
      const soleOwner = await mkUserEmp(businessId, 'SoleOwner', { businessRoleId: ownerRole.id });
      // Strip every OTHER active canManageRoles holder so soleOwner is provably last.
      const holders = await prisma.user.findMany({
        where: { businessId, isActive: true },
        select: { id: true, role: true, businessRole: { select: { permissions: true, name: true, isSystem: true } } },
      });
      const { effectivePermissions } = require('../../../core/lib/rbac');
      const otherHolderIds = holders.filter((u) => u.id !== soleOwner.user.id && effectivePermissions(u).canManageRoles === true).map((u) => u.id);
      const stash = new Map();
      for (const id of otherHolderIds) {
        const u = await prisma.user.findUnique({ where: { id }, select: { businessRoleId: true, isActive: true } });
        stash.set(id, u);
        await prisma.user.update({ where: { id }, data: { isActive: false } });
      }
      try {
        const count = otherHolderIds.length;
        log(`     (neutralized ${count} other canManageRoles holder(s) for an isolated last-owner check)`);
        // assign-role soleOwner → a role WITHOUT canManageRoles must be refused.
        const noManageRole = await prisma.businessRole.create({
          data: { businessId, name: `${PREFIX}-NoManage`, isSystem: false, defaultScope: 'SELF', permissions: { canViewEmployees: true } },
        });
        const strip = await call(rbacC.assignRole, { user: owner, params: { id: soleOwner.emp.id }, body: { businessRoleId: noManageRole.id } });
        assert(strip.statusCode === 400 && /last canManageRoles/i.test(strip.body.message || ''), `assignRole stripping the last owner → 400 (got ${strip.statusCode})`);

        // assigning null (legacy USER fallback = no perms) is likewise refused.
        const stripNull = await call(rbacC.assignRole, { user: owner, params: { id: soleOwner.emp.id }, body: { businessRoleId: null } });
        assert(stripNull.statusCode === 400, `assignRole → null on the last owner → 400 (got ${stripNull.statusCode})`);

        // editing the owner role to drop canManageRoles is refused too.
        const editStrip = await call(rbacC.updateRole, { user: owner, params: { id: ownerRole.id }, body: { permissions: { canViewEmployees: true } } });
        assert(editStrip.statusCode === 400, `updateRole dropping canManageRoles from the last-owner role → 400 (got ${editStrip.statusCode})`);
      } finally {
        for (const [id, u] of stash) await prisma.user.update({ where: { id }, data: { isActive: u.isActive } });
      }
    }

    // ── (3) MED — GET /approvals/:id gate + comp mask ────────────────────────────
    log('(3) getRequest access gate + comp mask:');
    {
      // Org: mgr → ic. Open a COMPENSATION request for ic with a salary payload.
      const mgr = await mkUserEmp(businessId, 'Mgr3');
      const ic = await mkUserEmp(businessId, 'Ic3', { managerEmployeeId: mgr.emp.id });
      const outsider = await mkUserEmp(businessId, 'Outsider3'); // no relation, no role, not an approver
      await prisma.workflowDefinition.updateMany({ where: { businessId, module: 'COMPENSATION', isPublished: true }, data: { isPublished: false, isActive: false } });
      const def = await prisma.workflowDefinition.create({ data: { businessId, code: `${PREFIX}-COMP`, name: `${PREFIX}-comp`, module: 'COMPENSATION', isActive: true, isPublished: true, priority: 5 } });
      await prisma.workflowStep.create({ data: { businessId, workflowDefinitionId: def.id, stepOrder: 1, name: 'Manager', approverType: 'REPORTING_MANAGER', approverRefId: '1' } });
      const opened = await engine.openRequest({
        businessId, module: 'COMPENSATION', entityType: `${PREFIX}-COMP`, entityId: 'comp-1',
        requesterEmployeeId: ic.emp.id, payload: { ctcAnnual: 2400000, grossMonthly: 200000, netMonthly: 170000, reason: 'increment' }, ctx: {},
      });
      const reqId = opened.approvalRequest.id;

      // (a) an unrelated operator (not approver, not admin, out of scope) → 404.
      const leakRes = await call(approvalsC.getRequest, { user: { id: outsider.user.id, businessId, role: 'USER', employeeId: outsider.emp.id }, params: { id: reqId } });
      assert(leakRes.statusCode === 404, `non-approver/non-admin/out-of-scope → 404 (got ${leakRes.statusCode})`);

      // (b) the active approver (manager) CAN read it, but without ABSOLUTE comp
      // visibility the absolute money is masked (no ctcAnnual/grossMonthly/netMonthly).
      const mgrView = await call(approvalsC.getRequest, { user: { id: mgr.user.id, businessId, role: 'USER', employeeId: mgr.emp.id }, params: { id: reqId } });
      assert(mgrView.statusCode === 200, `active approver can read → 200 (got ${mgrView.statusCode})`);
      const p = mgrView.body && mgrView.body.payload || {};
      const noAbsRoot = p.ctcAnnual === undefined && p.grossMonthly === undefined && p.netMonthly === undefined;
      assert(noAbsRoot, 'approver without ABSOLUTE visibility sees NO absolute money at the payload root');
      // and the masking envelope itself must not carry absolute money for a NON-SELF approver
      // (SELF_ONLY must be floored to RANGE_ONLY here, else it would leak full pay).
      const env = p._comp || {};
      const noAbsEnv = !env.absolute || (env.absolute.ctcAnnual == null && env.absolute.grossMonthly == null);
      assert(env.visibility === 'RANGE_ONLY' || env.visibility === 'NONE', `non-self approver envelope floored to RANGE_ONLY/NONE (got ${env.visibility})`);
      assert(noAbsEnv, 'masked envelope carries NO absolute money for a non-self approver');

      // (c) an admin (canManageApprovalWorkflows) can read it.
      const adminUser = { id: `wfadmin`, businessId, role: 'USER', businessRole: { permissions: { canManageApprovalWorkflows: true } } };
      const adminView = await call(approvalsC.getRequest, { user: adminUser, params: { id: reqId } });
      assert(adminView.statusCode === 200, `canManageApprovalWorkflows admin can read → 200 (got ${adminView.statusCode})`);

      // (d) the REQUESTER viewing their OWN comp request passes the F1 scope gate and
      // sees their own pay (SELF_ONLY → full own breakup; not floored, because it's self).
      const selfView = await call(approvalsC.getRequest, { user: { id: ic.user.id, businessId, role: 'USER', employeeId: ic.emp.id }, params: { id: reqId } });
      assert(selfView.statusCode === 200, `requester reads own request via scope → 200 (got ${selfView.statusCode})`);
      const selfEnv = (selfView.body && selfView.body.payload && selfView.body.payload._comp) || {};
      assert(selfEnv.visibility === 'SELF_ONLY' && selfEnv.absolute && selfEnv.absolute.ctcAnnual === 2400000, `requester sees own absolute pay (visibility=${selfEnv.visibility})`);
    }

    // ── (4) LOW — terminated employee excluded from approver resolution ───────────
    log('(4) terminated-employee approver exclusion:');
    {
      // ic reports to a TERMINATED manager whose User is still active.
      const termMgr = await mkUserEmp(businessId, 'TermMgr', { status: 'TERMINATED', isActive: false });
      const ic = await mkUserEmp(businessId, 'Ic4', { managerEmployeeId: termMgr.emp.id });
      const requesterEmp = await prisma.employee.findUnique({ where: { id: ic.emp.id }, select: { id: true, userId: true, managerEmployeeId: true } });

      // REPORTING_MANAGER step → terminated manager must NOT be the resolved approver.
      const step = { approverType: 'REPORTING_MANAGER', approverRefId: '1', minApprovals: 1 };
      const resolved = await resolveStepApprovers(step, requesterEmp, businessId, { module: 'LEAVE', now: new Date() });
      assert(!resolved.userIds.includes(termMgr.user.id), 'terminated manager is NOT in the REPORTING_MANAGER approver set');

      // SPECIFIC_EMPLOYEE pointed straight at the terminated manager → empty/collapsed.
      const stepSpecific = { approverType: 'SPECIFIC_EMPLOYEE', approverRefId: termMgr.emp.id, minApprovals: 1 };
      const resolvedSpecific = await resolveStepApprovers(stepSpecific, requesterEmp, businessId, { module: 'LEAVE', now: new Date() });
      assert(!resolvedSpecific.userIds.includes(termMgr.user.id), 'terminated SPECIFIC_EMPLOYEE is NOT a resolved approver');

      // A LIVE manager in the same slot IS resolved (control — proves we didn't over-filter).
      const liveMgr = await mkUserEmp(businessId, 'LiveMgr');
      await prisma.employee.update({ where: { id: ic.emp.id }, data: { managerEmployeeId: liveMgr.emp.id } });
      const requesterEmp2 = await prisma.employee.findUnique({ where: { id: ic.emp.id }, select: { id: true, userId: true, managerEmployeeId: true } });
      const resolvedLive = await resolveStepApprovers(step, requesterEmp2, businessId, { module: 'LEAVE', now: new Date() });
      assert(resolvedLive.userIds.includes(liveMgr.user.id), 'a LIVE manager IS resolved (no over-filtering)');
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL F10 SECURITY CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

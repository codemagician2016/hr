'use strict';

/**
 * approverResolver.js — Feature 10 §5.3. Generalises lib/approvalRouting.js:
 * given ONE WorkflowStep + the requester's Employee, return the CONCRETE set of
 * approver userIds for that step, after delegation-expansion and SoD exclusion.
 *
 *   resolveStepApprovers(step, requesterEmployee, businessId, { module, now }) ->
 *     { userIds: string[], minApprovals, autoApprove, escalationReason? }
 *
 * Resolution by approverType (§5.3 table):
 *   REPORTING_MANAGER  walk Employee.managerEmployeeId N levels up (refId "1"/"2"/… ;
 *                      "ALL" ⇒ whole chain to the top). Cycle-guarded + depth-capped.
 *   DEPARTMENT_HEAD    the head of the requester's current department
 *                      (Department.headEmployeeId), else dept-tree fallback.
 *   HR                 any active user holding canApproveLeave/HR (the HR-Admin role).
 *   PAYROLL_MANAGER    any active user holding canApprovePayroll.
 *   SPECIFIC_ROLE      all active users with businessRoleId = refId.
 *   SPECIFIC_EMPLOYEE  the single Employee refId's portal user.
 *   AUTO_APPROVE       empty set ⇒ autoApprove=true (engine completes the step).
 *
 * Post-processing on the resolved user-set:
 *   1. Delegation expansion — for each approver user, an ACTIVE ApprovalDelegation
 *      covering (fromUser=approver, module, now ∈ [startsAt,endsAt]) ADDS its toUser.
 *   2. SoD exclusion — drop the requester's own user (maker ≠ checker). If the set
 *      empties BECAUSE of SoD, escalate one manager level up → HR fallback →
 *      auto-approve-with-audit-note (tiny-tenant collapse, §5.3 / §9.3).
 *   3. Dedup + active-only — inactive/terminated/soft-deleted users are dropped.
 *
 * Everything that needs the DB is async; the post-processing is data-driven, not
 * hard-coded, so a 3-person tenant and a 100-person one share one code path.
 */

const prisma = require('../../core/lib/prisma');
const { effectivePermissions } = require('../../core/lib/rbac');

const DEPTH_CAP = 64;

// Terminal employee statuses — a person in one of these has left the company and
// must never be a live approver, even if their portal User row is still isActive
// (User deactivation can lag employee termination). Mirrors the meTasks/leave/ESS
// lockout invariant (resolveActiveSelf checks emp.isActive).
const TERMINATED_STATUSES = ['TERMINATED', 'RETIRED'];

// A Prisma Employee `where` fragment for an EMPLOYABLE (live) employee: not
// soft-deleted, isActive (not the explicit termination flag), and not in a terminal
// status. Reused by every resolver that turns employees → approver userIds.
function liveEmployeeWhere(businessId) {
  return {
    businessId,
    deletedAt: null,
    isActive: true,
    status: { notIn: TERMINATED_STATUSES },
  };
}

// ── resolve the requester's portal user id (for SoD self-exclusion) ─────────────
function requesterUserId(requesterEmployee) {
  return requesterEmployee && requesterEmployee.userId ? requesterEmployee.userId : null;
}

// Map a set of Employee ids → their active portal user ids (Employee.userId).
// Excludes terminated/inactive employees: a separated employee whose User login is
// still active must NOT remain a valid SPECIFIC_EMPLOYEE / REPORTING_MANAGER approver.
async function employeeUserIds(businessId, employeeIds) {
  const ids = [...new Set(employeeIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const emps = await prisma.employee.findMany({
    where: { id: { in: ids }, ...liveEmployeeWhere(businessId), userId: { not: null } },
    select: { userId: true },
  });
  return emps.map((e) => e.userId).filter(Boolean);
}

// Walk N levels up Employee.managerEmployeeId. refId "1" = direct manager, "2" =
// skip-level, "ALL" = every ancestor to the top. Cycle-guarded (visited set) +
// depth-capped. Returns an array of manager Employee ids (the N-th, or all for ALL).
async function walkManagers(requesterEmployee, businessId, refId) {
  const wantAll = String(refId || '1').toUpperCase() === 'ALL';
  const targetLevel = wantAll ? Infinity : Math.max(1, parseInt(refId || '1', 10) || 1);

  const collected = [];
  const seen = new Set([requesterEmployee.id]);
  let currentManagerId = requesterEmployee.managerEmployeeId || null;
  let level = 0;

  while (currentManagerId && level < DEPTH_CAP) {
    if (seen.has(currentManagerId)) break; // reporting loop — bail
    seen.add(currentManagerId);
    const mgr = await prisma.employee.findFirst({
      where: { id: currentManagerId, businessId, deletedAt: null },
      select: { id: true, managerEmployeeId: true },
    });
    if (!mgr) break; // dangling/terminated manager
    level += 1;
    if (wantAll) {
      collected.push(mgr.id);
    } else if (level === targetLevel) {
      collected.push(mgr.id);
      break;
    }
    currentManagerId = mgr.managerEmployeeId || null;
  }
  return collected;
}

// Department head of the requester's CURRENT department. Walks up the department
// tree to the first ancestor with a head if the immediate dept has none.
async function departmentHead(requesterEmployee, businessId) {
  const er = await prisma.employmentRecord.findFirst({
    where: { employeeId: requesterEmployee.id, businessId, isCurrent: true },
    select: { departmentId: true },
  });
  let deptId = er ? er.departmentId : null;
  const seen = new Set();
  let hops = 0;
  while (deptId && !seen.has(deptId) && hops < DEPTH_CAP) {
    seen.add(deptId); hops += 1;
    const dept = await prisma.department.findFirst({
      where: { id: deptId, businessId, deletedAt: null },
      select: { headEmployeeId: true, parentId: true },
    });
    if (!dept) break;
    if (dept.headEmployeeId) return dept.headEmployeeId;
    deptId = dept.parentId || null;
  }
  return null;
}

// Set of userIds in the tenant linked to a TERMINATED/inactive employee. Such a user
// must be dropped from every resolver — a separated employee whose login lingers is
// not a valid approver (consistent with the leave/ESS terminated-employee lockout).
async function terminatedEmployeeUserIds(businessId) {
  const rows = await prisma.employee.findMany({
    where: {
      businessId,
      deletedAt: null,
      userId: { not: null },
      OR: [{ isActive: false }, { status: { in: TERMINATED_STATUSES } }],
    },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId).filter(Boolean));
}

// All active users in the tenant whose effective permissions grant `permKey`.
// Reuses the rbac catalog (effectivePermissions) so a custom role that ticks the
// key is honoured, not just the seeded HR-Admin/Finance presets. Users linked to a
// terminated/inactive employee are excluded (User.isActive can lag termination).
async function usersWithPermission(businessId, permKey) {
  const [users, terminated] = await Promise.all([
    prisma.user.findMany({
      where: { businessId, isActive: true },
      select: {
        id: true, role: true,
        businessRole: { select: { id: true, name: true, permissions: true, isSystem: true, defaultScope: true } },
      },
    }),
    terminatedEmployeeUserIds(businessId),
  ]);
  return users.filter((u) => {
    if (terminated.has(u.id)) return false;
    const perms = effectivePermissions(u);
    return !!(perms && perms[permKey]);
  }).map((u) => u.id);
}

// Users assigned a specific BusinessRole (SPECIFIC_ROLE), excluding any linked to a
// terminated/inactive employee.
async function usersInRole(businessId, roleId) {
  if (!roleId) return [];
  const [users, terminated] = await Promise.all([
    prisma.user.findMany({
      where: { businessId, isActive: true, businessRoleId: roleId },
      select: { id: true },
    }),
    terminatedEmployeeUserIds(businessId),
  ]);
  return users.filter((u) => !terminated.has(u.id)).map((u) => u.id);
}

// ── raw resolution: step → candidate userIds (before delegation + SoD) ──────────
async function rawApprovers(step, requesterEmployee, businessId) {
  switch (step.approverType) {
    case 'AUTO_APPROVE':
      return { userIds: [], auto: true };
    case 'REPORTING_MANAGER': {
      const mgrEmpIds = await walkManagers(requesterEmployee, businessId, step.approverRefId);
      return { userIds: await employeeUserIds(businessId, mgrEmpIds), auto: false };
    }
    case 'DEPARTMENT_HEAD': {
      const headEmpId = await departmentHead(requesterEmployee, businessId);
      return { userIds: await employeeUserIds(businessId, headEmpId ? [headEmpId] : []), auto: false };
    }
    case 'HR':
      return { userIds: await usersWithPermission(businessId, 'canApproveLeave'), auto: false };
    case 'PAYROLL_MANAGER':
      return { userIds: await usersWithPermission(businessId, 'canApprovePayroll'), auto: false };
    case 'SPECIFIC_ROLE':
      return { userIds: await usersInRole(businessId, step.approverRefId), auto: false };
    case 'SPECIFIC_EMPLOYEE':
      return { userIds: await employeeUserIds(businessId, step.approverRefId ? [step.approverRefId] : []), auto: false };
    default:
      return { userIds: [], auto: false };
  }
}

// ── delegation expansion ────────────────────────────────────────────────────────
// For each approver user, ADD the toUser of any active delegation covering
// (fromUser=approver, module, now ∈ window). Either may act (delegation, not
// abdication). Returns the union. Also returns a map approverUser→delegate(s) so
// the engine can stamp delegatedFromUserId on the action.
async function expandDelegations(businessId, userIds, module, now) {
  if (userIds.length === 0) return { userIds, delegationMap: {} };
  const dels = await prisma.approvalDelegation.findMany({
    where: {
      businessId,
      isActive: true,
      fromUserId: { in: userIds },
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    select: { fromUserId: true, toUserId: true, modules: true },
  });
  const out = new Set(userIds);
  const delegationMap = {};
  for (const d of dels) {
    // module narrowing: empty modules[] = all modules.
    if (Array.isArray(d.modules) && d.modules.length > 0 && !d.modules.includes(module)) continue;
    out.add(d.toUserId);
    if (!delegationMap[d.toUserId]) delegationMap[d.toUserId] = [];
    delegationMap[d.toUserId].push(d.fromUserId);
  }
  return { userIds: [...out], delegationMap };
}

// Drop inactive/terminated/soft-deleted users (active-only invariant). Also drops a
// user whose LINKED Employee is terminated/inactive even when User.isActive still
// lags — the single chokepoint that catches delegation targets + every resolver path.
async function activeOnly(businessId, userIds) {
  if (userIds.length === 0) return [];
  const unique = [...new Set(userIds)];
  const rows = await prisma.user.findMany({
    where: {
      id: { in: unique },
      businessId,
      isActive: true,
      // No linked employee, OR a linked employee that is live (not terminated/inactive).
      OR: [
        { hrEmployee: { is: null } },
        { hrEmployee: { isActive: true, status: { notIn: TERMINATED_STATUSES }, deletedAt: null } },
      ],
    },
    select: { id: true },
  });
  const live = new Set(rows.map((r) => r.id));
  return unique.filter((id) => live.has(id));
}

/**
 * resolveStepApprovers(step, requesterEmployee, businessId, opts) ->
 *   { userIds, minApprovals, autoApprove, escalationReason?, delegationMap }
 *
 * opts = { module, now }. PURE-ish: all reads, no writes.
 */
async function resolveStepApprovers(step, requesterEmployee, businessId, opts = {}) {
  const module = opts.module || null;
  const now = opts.now || new Date();
  const minApprovals = Math.max(1, Number(step.minApprovals || 1));
  const reqUser = requesterUserId(requesterEmployee);

  // AUTO_APPROVE short-circuits everything.
  const raw = await rawApprovers(step, requesterEmployee, businessId);
  if (raw.auto) {
    return { userIds: [], minApprovals: 1, autoApprove: true, delegationMap: {} };
  }

  // delegation-expand, then active-only filter.
  const expanded = await expandDelegations(businessId, raw.userIds, module, now);
  let userIds = await activeOnly(businessId, expanded.userIds);

  // SoD: remove the requester's own user (maker ≠ checker).
  let escalationReason;
  if (reqUser) {
    const before = userIds.length;
    userIds = userIds.filter((id) => id !== reqUser);
    if (userIds.length === 0 && before > 0) {
      // SoD emptied the set (requester is their own approver — tiny-tenant founder).
      // Collapse: escalate one manager level up → HR fallback → auto-approve+audit.
      const collapse = await collapseEmptyStep(requesterEmployee, businessId, module, now, reqUser);
      return collapse;
    }
  }

  if (userIds.length === 0) {
    // Step resolved to nobody (e.g. mis-provisioned role/manager) — escalate/HR/auto.
    const collapse = await collapseEmptyStep(requesterEmployee, businessId, module, now, reqUser);
    // preserve the step's minApprovals only when the collapse still has approvers.
    return collapse;
  }

  return {
    userIds: [...new Set(userIds)],
    minApprovals: Math.min(minApprovals, userIds.length) || 1,
    autoApprove: false,
    escalationReason,
    delegationMap: expanded.delegationMap,
  };
}

// SoD/empty collapse (§5.3, §9.3): escalate one manager level up; if still empty,
// HR fallback (canApproveLeave holders); if STILL empty, auto-approve with an audit
// note. Never deadlocks a 1-person chain, never silently grants without a trail.
async function collapseEmptyStep(requesterEmployee, businessId, module, now, reqUser) {
  // (a) one manager level up
  const mgrEmpIds = await walkManagers(requesterEmployee, businessId, '1');
  let userIds = await activeOnly(businessId, await employeeUserIds(businessId, mgrEmpIds));
  const expandedMgr = await expandDelegations(businessId, userIds, module, now);
  userIds = (await activeOnly(businessId, expandedMgr.userIds)).filter((id) => id !== reqUser);
  if (userIds.length > 0) {
    return { userIds, minApprovals: 1, autoApprove: false, escalationReason: 'SOD_ESCALATED_TO_MANAGER', delegationMap: expandedMgr.delegationMap };
  }

  // (b) HR fallback
  const hr = await usersWithPermission(businessId, 'canApproveLeave');
  const expandedHr = await expandDelegations(businessId, hr, module, now);
  userIds = (await activeOnly(businessId, expandedHr.userIds)).filter((id) => id !== reqUser);
  if (userIds.length > 0) {
    return { userIds, minApprovals: 1, autoApprove: false, escalationReason: 'SOD_ESCALATED_TO_HR', delegationMap: expandedHr.delegationMap };
  }

  // (c) auto-approve with an audit note — a sole owner cannot block their own chain.
  return { userIds: [], minApprovals: 1, autoApprove: true, escalationReason: 'SOD_COLLAPSE_AUTO_APPROVE', delegationMap: {} };
}

module.exports = {
  resolveStepApprovers,
  // exported for unit tests + reuse
  walkManagers,
  departmentHead,
  usersWithPermission,
  expandDelegations,
};

'use strict';

/**
 * approvalRouting.js — Feature 1: single approval-routing resolver.
 *
 * THE one place that answers "who approves this employee's request?". Mirrors the
 * scopeResolver chokepoint pattern: leave consumes it today; expense/regularization
 * reuse it later without re-deriving the chain.
 *
 *   resolveApprover(employee) -> Promise<ApproverResult>
 *     { kind: 'MANAGER',  employeeId }   // the applicant's direct manager
 *     { kind: 'ESCALATED', employeeId }  // nearest non-null ancestor up the chain
 *     { kind: 'HR_ADMIN', userId }       // terminal fallback — any HR-Admin (tenant-wide)
 *     { kind: 'NONE' }                   // no manager and no HR-Admin (mis-provisioned tenant)
 *
 * Routing rule (spec §5.4 / §7.5):
 *   1. The applicant's `managerEmployeeId`.
 *   2. If null, escalate up the reporting chain to the first non-null ancestor.
 *   3. Terminal fallback: any HR-Admin in the tenant (tenant-wide inbox).
 *
 * Separation of duties (a manager never approves their own leave) is enforced in
 * the scope layer (resolveAccessibleEmployeeIds excludes self for canApproveLeave);
 * this resolver only answers WHERE a request routes, not WHETHER a given actor may act.
 */

const prisma = require('../../core/lib/prisma');

const NONE = { kind: 'NONE' };

// Walk up Employee.managerEmployeeId from the applicant, returning the nearest
// non-null ancestor (the applicant's own manager when present, else the first
// non-null manager above a null link). Cycle-guarded by a visited set + a depth
// cap so a corrupt chain can never loop forever.
async function nearestManager(employee, businessId) {
  const seen = new Set([employee.id]);
  let current = employee;
  let hops = 0;
  while (current && current.managerEmployeeId && hops < 64) {
    const managerId = current.managerEmployeeId;
    if (seen.has(managerId)) break; // reporting loop — bail to HR fallback
    const manager = await prisma.employee.findFirst({
      where: { id: managerId, businessId, deletedAt: null },
      select: { id: true, managerEmployeeId: true },
    });
    if (!manager) break; // dangling/terminated manager → escalate to HR fallback
    return { employeeId: manager.id, direct: hops === 0 };
  }
  return null; // ascend stops here; nothing above resolves
}

// Terminal fallback: any HR-Admin in the tenant (tenant-wide). We resolve the
// role by its seeded name and return a member User id for the inbox/notification.
async function hrAdminFallback(businessId) {
  const role = await prisma.businessRole.findFirst({
    where: { businessId, name: 'HR-Admin' },
    select: { id: true },
  });
  if (!role) return null;
  const user = await prisma.user.findFirst({
    where: { businessId, businessRoleId: role.id },
    select: { id: true },
  });
  return user ? user.id : null;
}

async function resolveApprover(employee) {
  if (!employee || !employee.id || !employee.businessId) return NONE;
  const { businessId } = employee;

  const mgr = await nearestManager(employee, businessId);
  if (mgr) {
    return { kind: mgr.direct ? 'MANAGER' : 'ESCALATED', employeeId: mgr.employeeId };
  }

  const hrUserId = await hrAdminFallback(businessId);
  if (hrUserId) return { kind: 'HR_ADMIN', userId: hrUserId };

  return NONE;
}

module.exports = { resolveApprover };

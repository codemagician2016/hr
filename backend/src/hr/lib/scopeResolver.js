'use strict';

/**
 * scopeResolver.js — Feature 1: hierarchical RBAC data scope.
 *
 * THE single chokepoint that knows the reporting hierarchy. Every HR read/write
 * filters by the id-set this returns, ANDed with the (already proven) tenant wall.
 *
 *   resolveAccessibleEmployeeIds(actor, action) -> ScopeResult
 *     { kind: 'ALL' }                 // no IN-list; filter businessId only (fast path)
 *     { kind: 'IDS', ids: Set<id> }   // explicit set (self / team sub-tree)
 *     { kind: 'NONE' }                // ∅ → lists return [], single-row → 404
 *
 * The owner's requirement — "a Manager manages only their own employees, per the
 * hierarchy" — is satisfied by the TEAM band: the recursive reporting sub-tree
 * rooted at the actor's own Employee, over Employee.managerEmployeeId.
 */

const prisma = require('../../core/lib/prisma');
const { effectiveScope } = require('../../core/lib/rbac');
const { ROLES } = require('../../core/lib/roles');

// Approval actions exclude the actor themselves (separation of duties — a manager
// cannot approve their own leave/regularization; it escalates up the chain).
//
// Feature 8 adds the performance review *acting* steps (reviewer ≠ reviewee): a
// manager may never submit/calibrate/sign-off their OWN review instance. Because
// the resolved id-set drops `selfId` for these actions, a manager who is somehow
// the subject of their own instance is structurally absent from the scope — the
// instance 404s for them, fail-closed (identical to "cannot approve own leave").
const APPROVAL_ACTIONS = new Set([
  'canApproveLeave', 'canApprovePayroll', 'canApproveRegularization',
  'review.submitMgr', 'review.calibrate', 'review.signOff',
  // Feature 34 — 9-box SoD: a manager/skip-level may never MOVE their OWN box in a
  // calibration session. The key drops `selfId` from the resolved set, so the actor
  // is structurally absent from their own move scope (fail-closed, same as
  // "cannot calibrate own rating"). Authoring potential on a direct report uses
  // canViewTeamPerformance (TEAM, self already excluded — a manager isn't in their
  // own sub-tree).
  'ninebox.calibrate',
  // Feature 12 — recruitment SoD: an interviewer who SUBMITTED a scorecard on a
  // candidate's application may not be the sole offer approver/extender for that
  // candidate. The action key drops `selfId` from the resolved set, so a scorer is
  // structurally absent from the approver scope (fail-closed, same as own-leave).
  'offer.approve',
  // Feature 11 — reimbursement/travel SoD: an approver (manager/finance) may never
  // approve/reject/reimburse their OWN claim or trip. The key drops `selfId` from the
  // resolved set, so a maker is structurally absent from the approver scope.
  'canApproveExpense',
]);

const ALL = { kind: 'ALL' };
const NONE = { kind: 'NONE' };

async function resolveAccessibleEmployeeIds(actor, action /*, { asOf } = {} */) {
  if (!actor || !actor.businessId) return NONE;
  // Platform super-admin bypasses scope (still tenant-bounded by the caller's query).
  if (actor.role === ROLES.SUPER_ADMIN) return ALL;

  let band = effectiveScope(actor); // ALL | DEPARTMENT | TEAM | SELF | NONE
  // Defensive: if the session's businessRole didn't carry defaultScope (some
  // select paths drop it), read it straight from the assigned role so scoping
  // never silently degrades to SELF.
  if (actor.businessRoleId && (!actor.businessRole || actor.businessRole.defaultScope == null)) {
    const role = await prisma.businessRole.findUnique({
      where: { id: actor.businessRoleId },
      select: { defaultScope: true },
    });
    if (role && role.defaultScope) band = role.defaultScope;
  }
  if (band === 'ALL') return ALL;
  if (band === 'NONE') return NONE;

  const selfId = actor.employeeId || null;
  // Any narrower-than-ALL band needs a self anchor; without a linked Employee the
  // actor can touch nothing (fail-closed).
  if (!selfId) return NONE;

  if (band === 'SELF') {
    const ids = new Set([selfId]);
    if (APPROVAL_ACTIONS.has(action)) ids.delete(selfId);
    return ids.size ? { kind: 'IDS', ids } : NONE;
  }

  // TEAM (and DEPARTMENT, which v1 treats as the reporting sub-tree — a safe subset;
  // department-head closure is an additive refinement). Recursive CTE over the
  // self-relation Employee.managerEmployeeId, tenant-scoped, excluding soft-deleted.
  const ids = new Set([selfId]);
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE subtree AS (
      SELECT id FROM "Employee"
        WHERE "managerEmployeeId" = ${selfId}
          AND "businessId" = ${actor.businessId}
          AND "deletedAt" IS NULL
      UNION
      SELECT e.id FROM "Employee" e
        JOIN subtree s ON e."managerEmployeeId" = s.id
        WHERE e."businessId" = ${actor.businessId}
          AND e."deletedAt" IS NULL
    )
    SELECT id FROM subtree
  `;
  for (const r of rows) ids.add(r.id);

  if (APPROVAL_ACTIONS.has(action)) ids.delete(selfId);
  return ids.size ? { kind: 'IDS', ids } : NONE;
}

// Build a Prisma `where` fragment that AND-restricts an employee-keyed query to the
// scope. `field` is the column holding the employee id (default 'id'; pass
// 'employeeId' for child tables like Payslip/LeaveTxn).
function scopeWhere(scope, field = 'id') {
  if (!scope || scope.kind === 'ALL') return {};
  if (scope.kind === 'NONE') return { [field]: { in: [] } }; // matches nothing
  return { [field]: { in: [...scope.ids] } };
}

// True when a single resolved id is in scope (for GET/PUT/DELETE /:id → 404 if not).
function scopeAllows(scope, employeeId) {
  if (!scope) return false;
  if (scope.kind === 'ALL') return true;
  if (scope.kind === 'NONE') return false;
  return scope.ids.has(employeeId);
}

module.exports = { resolveAccessibleEmployeeIds, scopeWhere, scopeAllows, APPROVAL_ACTIONS };

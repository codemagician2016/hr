'use strict';

/**
 * customerScope.js — Feature 13 §4.2/§8. THE one new scope primitive: give a CUSTOMER
 * (ESS portal) session the same F1 data-scope band the operator path has.
 *
 * Until now `resolveAccessibleEmployeeIds` was only ever called for an OPERATOR
 * `req.user`. Manager Self-Service needs the SAME band on the customer session: resolve
 * the customer to their Employee, read the band from their linked User's
 * businessRole.defaultScope (fail-closed to SELF), synthesize an actor, and delegate to
 * the EXISTING `resolveAccessibleEmployeeIds`. NO new hierarchy math — it is the same
 * recursive-CTE chokepoint, so the team sub-tree is computed identically to the
 * operator path (and SoD on approval actions drops self, exactly as before).
 *
 *   resolveCustomerScope(customer, action) ->
 *     { scope, actor, employee }   // scope = ScopeResult; actor synthesized; employee = the row
 *   A customer with no linked Employee → { scope: NONE, actor: null, employee: null }.
 *   A SELF-band employee hitting a team endpoint gets a sub-tree of {self}; for an
 *   approval action self is dropped → ∅ → 200 with [], never another person's data.
 */

const prisma = require('../../core/lib/prisma');
const { resolveAccessibleEmployeeIds, APPROVAL_ACTIONS } = require('./scopeResolver');

const ACTOR_SELECT = { id: true, businessId: true, managerEmployeeId: true, isActive: true, status: true, userId: true };

// Resolve the customer's Employee + the band from its linked User.businessRole.
async function resolveCustomerActor(customer) {
  if (!customer || !customer.businessId || !customer.email) return { actor: null, employee: null };
  const businessId = customer.businessId;
  // Deterministic resolution (F13 hardening): prefer the LOGIN identity — the linked
  // portal User.email (which carries a global unique constraint) — then the official
  // workEmail, and only LAST the self-editable personalEmail. personalEmail is a
  // self-service field; keeping it the lowest-priority key means a self-edited
  // personalEmail can never hijack another account's session/scope resolution. (A
  // collision is independently rejected at write time in profileFieldValidate /
  // meProfileRich, so two rows can't share an email anyway.)
  const emp = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select: ACTOR_SELECT,
  }) || await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, workEmail: customer.email },
    select: ACTOR_SELECT,
  }) || await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, personalEmail: customer.email },
    select: ACTOR_SELECT,
  });
  if (!emp) return { actor: null, employee: null };

  // Read the band from the linked portal User's businessRole (fail-closed to SELF).
  let defaultScope = 'SELF';
  let role = 'USER';
  if (emp.userId) {
    const user = await prisma.user.findFirst({
      where: { id: emp.userId, businessId },
      select: { role: true, businessRoleId: true, businessRole: { select: { defaultScope: true } } },
    });
    if (user) {
      role = user.role || 'USER';
      if (user.businessRole && user.businessRole.defaultScope) defaultScope = user.businessRole.defaultScope;
    }
  }

  // Synthesize an actor identical in shape to an operator session actor, so
  // resolveAccessibleEmployeeIds reads it without any special-casing.
  const actor = {
    id: `customer-${customer.id}`,
    businessId,
    role,
    employeeId: emp.id,
    businessRoleId: null,
    businessRole: { defaultScope },
  };
  return { actor, employee: emp };
}

async function resolveCustomerScope(customer, action) {
  const { actor, employee } = await resolveCustomerActor(customer);
  if (!actor) return { scope: { kind: 'NONE' }, actor: null, employee: null };
  let scope = await resolveAccessibleEmployeeIds(actor, action);

  // F13 hardening — ALL-band SoD self-exclusion on the MSS (customer) surface.
  // resolveAccessibleEmployeeIds returns the ALL fast-path (no in-list) BEFORE the
  // APPROVAL_ACTIONS self-drop, so an ESS user whose role band is ALL would otherwise
  // read the WHOLE tenant's pending leave/expense (including their OWN requests) on the
  // /me/team approval endpoints, and scopeAllows(ALL) would let them reach the engine
  // to decide their own row (the engine SoD still blocks the finalize, but the
  // read/own-request visibility is a SoD leak). For an approval action we therefore
  // narrow the ALL band to an explicit id-set = the actor's reporting sub-tree MINUS
  // self, so the manager-inbox path can never read-as-approver nor decide their OWN
  // request via /me/team. Non-approval reads (roster/directory/org) keep ALL.
  if (scope && scope.kind === 'ALL' && APPROVAL_ACTIONS.has(action) && employee) {
    const ids = await reportingSubtreeIds(employee.businessId, employee.id);
    ids.delete(employee.id); // SoD: drop self from the approver scope
    scope = ids.size ? { kind: 'IDS', ids } : { kind: 'NONE' };
  }

  return { scope, actor, employee };
}

// The recursive reporting sub-tree rooted at `rootId` (direct + indirect reports),
// tenant-scoped, soft-delete-aware — identical math to scopeResolver's TEAM CTE. Used
// only to materialise an explicit id-set when narrowing the ALL band for an approval
// action on the customer/MSS surface (so the ALL fast-path can be self-excluded).
async function reportingSubtreeIds(businessId, rootId) {
  const ids = new Set([rootId]);
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE subtree AS (
      SELECT id FROM "Employee"
        WHERE "managerEmployeeId" = ${rootId}
          AND "businessId" = ${businessId}
          AND "deletedAt" IS NULL
      UNION
      SELECT e.id FROM "Employee" e
        JOIN subtree s ON e."managerEmployeeId" = s.id
        WHERE e."businessId" = ${businessId}
          AND e."deletedAt" IS NULL
    )
    SELECT id FROM subtree
  `;
  for (const r of rows) ids.add(r.id);
  return ids;
}

module.exports = { resolveCustomerScope, resolveCustomerActor };

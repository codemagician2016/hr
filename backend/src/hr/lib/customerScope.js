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
const { resolveAccessibleEmployeeIds } = require('./scopeResolver');

// Resolve the customer's Employee + the band from its linked User.businessRole.
async function resolveCustomerActor(customer) {
  if (!customer || !customer.businessId || !customer.email) return { actor: null, employee: null };
  const businessId = customer.businessId;
  // Match the same way the ESS self-resolution does: workEmail/personalEmail, then User.
  const emp = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] },
    select: { id: true, businessId: true, managerEmployeeId: true, isActive: true, status: true, userId: true },
  }) || await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select: { id: true, businessId: true, managerEmployeeId: true, isActive: true, status: true, userId: true },
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
  const scope = await resolveAccessibleEmployeeIds(actor, action);
  return { scope, actor, employee };
}

module.exports = { resolveCustomerScope, resolveCustomerActor };

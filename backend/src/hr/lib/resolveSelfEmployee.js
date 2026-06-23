'use strict';

/**
 * resolveSelfEmployee.js — Feature 13 §8. THE single helper that maps a CUSTOMER
 * (ESS portal) session to its own Employee row, tenant-scoped. Previously this was
 * copy-pasted three+ times (meProfile / meSeparation / documents / payrollService);
 * this hoists it to one place. Behaviour is unchanged — a select SUPERSET that each
 * caller narrows by reading only the fields it needs.
 *
 * The match order mirrors the originals: workEmail / personalEmail first, then the
 * linked User's email. ALWAYS businessId-scoped and `deletedAt: null` (tenant wall +
 * soft-delete). Returns the row or null (the SELF_ONLY invariant: no employeeId is
 * ever accepted from the client, so a cross-employee read is structurally impossible).
 */

const prisma = require('../../core/lib/prisma');

// The fields any ESS self-service surface needs. Callers narrow at the use-site.
const SELF_SELECT = {
  id: true,
  code: true,
  firstName: true,
  middleName: true,
  lastName: true,
  workEmail: true,
  personalEmail: true,
  countryCode: true,
  status: true,
  isActive: true,
  hireDate: true,
  managerEmployeeId: true,
  userId: true,
};

// Resolve the session customer's own Employee (superset select). Returns the row or
// null. `select` overrides the default superset when a caller wants a tighter shape.
async function resolveSelfEmployee(businessId, customer, select = SELF_SELECT) {
  if (!businessId || !customer || !customer.email) return null;
  const byEmail = await prisma.employee.findFirst({
    where: {
      businessId,
      deletedAt: null,
      OR: [{ workEmail: customer.email }, { personalEmail: customer.email }],
    },
    select,
  });
  if (byEmail) return byEmail;
  const byUser = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select,
  });
  return byUser || null;
}

// A leaver whose directory status is TERMINATED/RETIRED (or whose account is
// deactivated) keeps NO write surface — STATE-CHANGING ESS calls are rejected; reads
// of the final statement/letters stay open. Mirrors meSeparation.isSeparatedEmployee.
const SEPARATED_STATUSES = new Set(['TERMINATED', 'RETIRED']);
function isSeparatedEmployee(employee) {
  if (!employee) return false;
  if (employee.isActive === false) return true;
  return SEPARATED_STATUSES.has(employee.status);
}

module.exports = { resolveSelfEmployee, isSeparatedEmployee, SELF_SELECT };

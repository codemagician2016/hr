'use strict';

/**
 * meProfile.controller.js — Employee Self-Service (ESS) profile/country surface,
 * mounted at /api/hr/me/profile. CUSTOMER session (req.customer); SELF_ONLY (no
 * `:id` path → cross-employee leakage is structurally impossible).
 *
 * WHY THIS EXISTS — country gating (global payroll: IN + NZ). The ESS app has no
 * other way to learn the signed-in employee's operating country. Without it,
 * country-specific pages (tax declaration, payslip currency, separation labels)
 * fall open to a hardcoded "IN" default and leak India fields to NZ staff (and
 * vice-versa). This endpoint returns the employee's RESOLVED country so every ESS
 * page can gate by it and FAIL CLOSED (render nothing country-specific) when the
 * country is unknown — never the wrong country.
 *
 * Country resolution order (most-specific first):
 *   1. StatutoryProfile.countryCode  — the employee's own statutory market.
 *   2. Employee.countryCode          — denormalized on the employee row.
 *   3. current EmploymentRecord → Entity.countryCode — the entity they work in.
 * If none resolve, countryCode is null (unknown) and the client renders neither
 * country's blocks.
 */

const prisma = require('../../../core/lib/prisma');

// Customer's portal identity links to an Employee via matching workEmail /
// personalEmail, or via the linked User. Tenant-scoped. Returns { id, countryCode }
// (the denormalized employee country) or null.
async function resolveSelfEmployee(businessId, customer) {
  if (!customer || !customer.email) return null;
  const byEmail = await prisma.employee.findFirst({
    where: {
      businessId,
      deletedAt: null,
      OR: [{ workEmail: customer.email }, { personalEmail: customer.email }],
    },
    select: { id: true, countryCode: true, isActive: true },
  });
  if (byEmail) return byEmail;
  const byUser = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select: { id: true, countryCode: true, isActive: true },
  });
  return byUser || null;
}

// Normalize an ISO-2 country to upper-case, or null if not a 2-letter code.
function normCc(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

// Resolve the employee's operating country (see header). FAIL-CLOSED: returns
// null when nothing authoritative is found — the client must not assume a country.
async function resolveEmployeeCountry(businessId, employeeId) {
  // 1. StatutoryProfile — the employee's own statutory market.
  const sp = await prisma.statutoryProfile.findFirst({
    where: { businessId, employeeId },
    select: { countryCode: true },
  });
  const fromSp = sp && normCc(sp.countryCode);
  if (fromSp) return fromSp;

  // 3. current EmploymentRecord → Entity.countryCode.
  const rec = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: { entityId: true },
  });
  if (rec && rec.entityId) {
    const entity = await prisma.entity.findFirst({
      where: { id: rec.entityId, businessId },
      select: { countryCode: true, payCurrency: true },
    });
    const fromEntity = entity && normCc(entity.countryCode);
    if (fromEntity) return { countryCode: fromEntity, payCurrency: entity.payCurrency || null };
  }
  return null;
}

// GET /api/hr/me/profile — { employeeId, countryCode, payCurrency }.
// countryCode is null when it cannot be authoritatively resolved (fail-closed).
async function getMyProfile(req, res, next) {
  try {
    const { businessId } = req.customer;
    const emp = await resolveSelfEmployee(businessId, req.customer);
    if (!emp) return res.json({ employeeId: null, countryCode: null, payCurrency: null });

    // 1. StatutoryProfile.
    const sp = await prisma.statutoryProfile.findFirst({
      where: { businessId, employeeId: emp.id },
      select: { countryCode: true },
    });
    let countryCode = sp && normCc(sp.countryCode);
    let payCurrency = null;

    // 2. Employee.countryCode (denormalized).
    if (!countryCode) countryCode = normCc(emp.countryCode);

    // 3. current EmploymentRecord → Entity.
    if (!countryCode || !payCurrency) {
      const rec = await prisma.employmentRecord.findFirst({
        where: { businessId, employeeId: emp.id, isCurrent: true },
        select: { entityId: true },
      });
      if (rec && rec.entityId) {
        const entity = await prisma.entity.findFirst({
          where: { id: rec.entityId, businessId },
          select: { countryCode: true, payCurrency: true },
        });
        if (entity) {
          if (!countryCode) countryCode = normCc(entity.countryCode);
          if (!payCurrency) payCurrency = entity.payCurrency || null;
        }
      }
    }

    return res.json({ employeeId: emp.id, countryCode: countryCode || null, payCurrency: payCurrency || null });
  } catch (e) { return next(e); }
}

module.exports = { getMyProfile, _internals: { resolveSelfEmployee, resolveEmployeeCountry, normCc } };

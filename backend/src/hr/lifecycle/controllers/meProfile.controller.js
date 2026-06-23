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

// GET /api/hr/me/profile — country/currency gate PLUS the employee's profile
// details (audit #58: the ESS profile page + Sidebar previously had only the
// sparse customer session, so code/phone/dept/designation/location/DOJ were blank).
//
// Backwards-compatible: the original { employeeId, countryCode, payCurrency } keys
// are unchanged (useCountry / fail-closed gating still works); the extra profile
// fields are additive. countryCode stays null when it cannot be authoritatively
// resolved (fail-closed).
async function getMyProfile(req, res, next) {
  try {
    const { businessId } = req.customer;
    const self = await resolveSelfEmployee(businessId, req.customer);
    if (!self) {
      return res.json({ employeeId: null, countryCode: null, payCurrency: null, profile: null });
    }

    // Full employee row (denormalized identity/contact) + the current employment
    // record with its dept/designation/location/entity names. One self-scoped read.
    const emp = await prisma.employee.findFirst({
      where: { id: self.id, businessId, deletedAt: null },
      select: {
        id: true, code: true, firstName: true, middleName: true, lastName: true,
        preferredName: true, workEmail: true, personalEmail: true, phone: true,
        photoUrl: true, countryCode: true, hireDate: true, status: true,
        city: true, stateCode: true,
      },
    });
    if (!emp) return res.json({ employeeId: null, countryCode: null, payCurrency: null, profile: null });

    const rec = await prisma.employmentRecord.findFirst({
      where: { businessId, employeeId: emp.id, isCurrent: true },
      select: {
        entityId: true,
        entity: { select: { tradeName: true, legalName: true, countryCode: true, payCurrency: true } },
        department: { select: { name: true } },
        designation: { select: { title: true } },
        location: { select: { name: true } },
      },
    });

    // 1. StatutoryProfile → 2. Employee.countryCode → 3. current entity (fail-closed).
    const sp = await prisma.statutoryProfile.findFirst({
      where: { businessId, employeeId: emp.id },
      select: { countryCode: true },
    });
    let countryCode = sp && normCc(sp.countryCode);
    let payCurrency = null;
    if (!countryCode) countryCode = normCc(emp.countryCode);
    if (rec && rec.entity) {
      if (!countryCode) countryCode = normCc(rec.entity.countryCode);
      if (!payCurrency) payCurrency = rec.entity.payCurrency || null;
    }

    const fullName = [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' ').trim() || null;
    const profile = {
      employeeId: emp.id,
      name: fullName,
      preferredName: emp.preferredName || null,
      employeeCode: emp.code || null,
      email: emp.workEmail || emp.personalEmail || req.customer.email || null,
      personalEmail: emp.personalEmail || null,
      phone: emp.phone || null,
      photoUrl: emp.photoUrl || null,
      department: rec && rec.department ? rec.department.name : null,
      designation: rec && rec.designation ? rec.designation.title : null,
      location: rec && rec.location ? rec.location.name : null,
      entity: rec && rec.entity ? (rec.entity.tradeName || rec.entity.legalName) : null,
      dateOfJoining: emp.hireDate || null,
      countryCode: countryCode || null,
      status: emp.status || null,
    };

    return res.json({
      employeeId: emp.id,
      countryCode: countryCode || null,
      payCurrency: payCurrency || null,
      profile,
    });
  } catch (e) { return next(e); }
}

module.exports = { getMyProfile, _internals: { resolveSelfEmployee, resolveEmployeeCountry, normCc } };

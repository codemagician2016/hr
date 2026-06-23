'use strict';

/**
 * profileAdmin.controller.js — Feature 13 HR-admin profile surfaces (operator session).
 *   - getPolicy()      : the field-governance map (which fields self-edit / need HR
 *                        approval / are read-only) for the config view. v1 is the
 *                        sensible default map in code; a tenant override is deferred.
 *   - getEmployeeFull(): the rich, sectioned profile for ANY in-scope employee
 *                        (scope already enforced by withEmployeeScope idParam guard).
 */

const prisma = require('../../core/lib/prisma');
const { POLICY } = require('./profileFieldPolicy');

// GET /api/hr/profile/policy — the field-policy map (display/config view).
function getPolicy(req, res) {
  const fields = Object.entries(POLICY).map(([fieldKey, p]) => ({
    fieldKey,
    policy: p.policy,
    model: p.model || null,
    optional: !!p.optional,
    sensitive: !!p.sensitive,
  }));
  res.json({ fields, note: 'v1 policy is a code-default map; per-tenant override is deferred.' });
}

function dec(x) { return x == null ? null : Number(x); }
function dateOnly(x) { return x ? new Date(x).toISOString().slice(0, 10) : null; }

// GET /api/hr/profile/employees/:id/full — the rich sectioned profile for an in-scope
// employee. Scope is enforced on the route (withEmployeeScope idParam → 404 out-of-tree).
async function getEmployeeFull(req, res, next) {
  try {
    const { businessId } = req.user;
    const employeeId = req.params.id;
    const emp = await prisma.employee.findFirst({
      where: { id: employeeId, businessId, deletedAt: null },
      select: {
        id: true, code: true, firstName: true, middleName: true, lastName: true, preferredName: true,
        dateOfBirth: true, gender: true, maritalStatus: true, nationality: true,
        personalEmail: true, workEmail: true, phone: true, homePhone: true, officePhone: true,
        photoUrl: true, bloodGroup: true, religion: true, community: true, motherTongue: true,
        placeOfBirth: true, stateOfBirthCode: true, identificationMark: true, heightCm: true, weightKg: true,
        fatherName: true, fatherOccupation: true, motherName: true, motherOccupation: true,
        status: true, hireDate: true, managerEmployeeId: true,
      },
    });
    if (!emp) return res.status(404).json({ message: 'Not found' });

    const [bank, emergency, dependants, education, addresses, statutory, rec] = await Promise.all([
      prisma.bankAccount.findFirst({ where: { businessId, employeeId, deletedAt: null, isPrimary: true } }),
      prisma.emergencyContact.findMany({ where: { businessId, employeeId }, orderBy: { createdAt: 'asc' } }),
      prisma.dependant.findMany({ where: { businessId, employeeId }, orderBy: { createdAt: 'asc' } }),
      prisma.employeeEducation.findMany({ where: { businessId, employeeId }, orderBy: [{ isHighest: 'desc' }] }),
      prisma.employeeAddress.findMany({ where: { businessId, employeeId } }),
      prisma.statutoryProfile.findFirst({ where: { businessId, employeeId } }),
      prisma.employmentRecord.findFirst({
        where: { businessId, employeeId, isCurrent: true },
        select: { entity: { select: { tradeName: true, legalName: true } }, department: { select: { name: true } }, designation: { select: { title: true } }, location: { select: { name: true } }, employmentType: true },
      }),
    ]);

    res.json({
      employee: {
        id: emp.id, code: emp.code,
        name: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' '),
        firstName: emp.firstName, middleName: emp.middleName, lastName: emp.lastName, preferredName: emp.preferredName,
        dateOfBirth: dateOnly(emp.dateOfBirth), gender: emp.gender, maritalStatus: emp.maritalStatus, nationality: emp.nationality,
        personalEmail: emp.personalEmail, workEmail: emp.workEmail, phone: emp.phone, homePhone: emp.homePhone, officePhone: emp.officePhone,
        photoUrl: emp.photoUrl, bloodGroup: emp.bloodGroup, religion: emp.religion, community: emp.community, motherTongue: emp.motherTongue,
        placeOfBirth: emp.placeOfBirth, stateOfBirthCode: emp.stateOfBirthCode, identificationMark: emp.identificationMark,
        heightCm: dec(emp.heightCm), weightKg: dec(emp.weightKg),
        fatherName: emp.fatherName, fatherOccupation: emp.fatherOccupation, motherName: emp.motherName, motherOccupation: emp.motherOccupation,
        status: emp.status, dateOfJoining: dateOnly(emp.hireDate),
      },
      professional: rec ? { designation: rec.designation?.title || null, department: rec.department?.name || null, location: rec.location?.name || null, entity: rec.entity ? (rec.entity.tradeName || rec.entity.legalName) : null, employmentType: rec.employmentType } : null,
      bank: bank ? { accountName: bank.accountName, accountNumber: bank.accountNumber, ifsc: bank.ifsc, nzBankAccount: bank.nzBankAccount, bankName: bank.bankName, currencyCode: bank.currencyCode } : null,
      emergencyContacts: emergency.map((e) => ({ id: e.id, name: e.name, relationship: e.relationship, phone: e.phone, email: e.email, isPrimary: e.isPrimary })),
      family: dependants.map((d) => ({ id: d.id, name: d.name, relationship: d.relationship, dateOfBirth: dateOnly(d.dateOfBirth), isNominee: d.isNominee, nomineePercent: dec(d.nomineePercent), isInsured: d.isInsured })),
      education: education.map((e) => ({ id: e.id, level: e.level, institution: e.institution, fieldOfStudy: e.fieldOfStudy, startYear: e.startYear, endYear: e.endYear, grade: e.grade, isHighest: e.isHighest })),
      addresses: addresses.map((a) => ({ id: a.id, type: a.type, sameAsType: a.sameAsType, line1: a.line1, line2: a.line2, city: a.city, stateCode: a.stateCode, postalCode: a.postalCode, countryCode: a.countryCode })),
      statutory: statutory ? { countryCode: statutory.countryCode, pan: statutory.pan, uan: statutory.uan, irdNumber: statutory.irdNumber, aadhaarVerified: statutory.aadhaarVerified || false } : null,
    });
  } catch (e) { next(e); }
}

module.exports = { getPolicy, getEmployeeFull };

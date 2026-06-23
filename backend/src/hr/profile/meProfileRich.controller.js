'use strict';

/**
 * meProfileRich.controller.js — Feature 13 ESS rich-profile surface, mounted at
 * /api/hr/me/profile (extends the existing country-gate router). CUSTOMER session
 * (req.customer); SELF_ONLY by construction — NO `:id` for the subject employee in
 * any path; the subject is resolved ENTIRELY from the session (a body employeeId is
 * structurally ignored), so cross-employee read/write is impossible (§9).
 *
 * Reads the FULL sectioned profile with a per-field `policy` so the client renders
 * edit/lock/approval badges with zero policy guesswork. Writes go through ONE
 * policy-split resolver (§5.1): a self-edit field commits immediately + audits; a
 * gated (hr-approval) field is routed to a ProfileChangeRequest + ApprovalRequest
 * (the F10 engine) — even if a client smuggles a gated field into a self-edit body,
 * the SERVER routes it to approval, never an immediate write. A read-only field 400s.
 *
 * Terminated/inactive employees are read-only (no self-edit, no new change requests),
 * reusing the shared isSeparatedEmployee lockout.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { resolveSelfEmployee, isSeparatedEmployee } = require('../lib/resolveSelfEmployee');
const { fieldPolicy, annotate } = require('./profileFieldPolicy');
const { validateField } = require('./profileFieldValidate');
const engine = require('../approvals/engine');

// ── self resolution ──────────────────────────────────────────────────────────
const PROFILE_SELECT = {
  id: true, businessId: true, code: true,
  firstName: true, middleName: true, lastName: true, preferredName: true,
  dateOfBirth: true, gender: true, maritalStatus: true, nationality: true,
  personalEmail: true, workEmail: true, phone: true, homePhone: true, officePhone: true,
  addressLine1: true, addressLine2: true, city: true, stateCode: true, postalCode: true, countryCode: true,
  photoUrl: true, disabilityStatus: true, bloodGroup: true,
  religion: true, community: true, motherTongue: true, placeOfBirth: true, stateOfBirthCode: true,
  identificationMark: true, heightCm: true, weightKg: true,
  fatherName: true, fatherOccupation: true, motherName: true, motherOccupation: true,
  status: true, isActive: true, hireDate: true, managerEmployeeId: true, userId: true, version: true,
};

async function resolveSelf(req) {
  const { businessId } = req.customer;
  return resolveSelfEmployee(businessId, req.customer, PROFILE_SELECT);
}

const noEmployee = (res) => res.status(404).json({ message: 'No employee record is linked to your account' });
const lockedOut = (res) => res.status(403).json({ message: 'Your account is no longer active; this action is unavailable', reason: 'separated' });

function dec(x) { return x == null ? null : Number(x); }
function dateOnly(x) { return x ? new Date(x).toISOString().slice(0, 10) : null; }

// ── GET /me/profile/full — sectioned read with per-field policy ────────────────
async function getFull(req, res, next) {
  try {
    const { businessId } = req.customer;
    const emp = await resolveSelf(req);
    if (!emp) return res.json({ employeeId: null, sections: null });

    const [bank, emergency, dependants, education, addresses, statutory, rec] = await Promise.all([
      prisma.bankAccount.findFirst({ where: { businessId, employeeId: emp.id, deletedAt: null, isPrimary: true }, orderBy: { createdAt: 'desc' } }),
      prisma.emergencyContact.findMany({ where: { businessId, employeeId: emp.id }, orderBy: { createdAt: 'asc' } }),
      prisma.dependant.findMany({ where: { businessId, employeeId: emp.id }, orderBy: { createdAt: 'asc' } }),
      prisma.employeeEducation.findMany({ where: { businessId, employeeId: emp.id }, orderBy: [{ isHighest: 'desc' }, { endYear: 'desc' }] }),
      prisma.employeeAddress.findMany({ where: { businessId, employeeId: emp.id } }),
      prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } }),
      prisma.employmentRecord.findFirst({
        where: { businessId, employeeId: emp.id, isCurrent: true },
        select: {
          entity: { select: { tradeName: true, legalName: true, countryCode: true } },
          department: { select: { name: true } },
          designation: { select: { title: true } },
          location: { select: { name: true } },
          employmentType: true, effectiveFrom: true,
        },
      }),
    ]);

    // Pending change requests (so the UI shows "pending HR approval" chips per field).
    const pendingCrs = await prisma.profileChangeRequest.findMany({
      where: { businessId, employeeId: emp.id, status: 'PENDING' },
      select: { id: true, field: true, newValue: true, createdAt: true },
    });
    const pendingByField = {};
    for (const c of pendingCrs) pendingByField[c.field] = { id: c.id, newValue: c.newValue, createdAt: c.createdAt };

    // Resolve the manager's display name (read-only).
    let managerName = null;
    if (emp.managerEmployeeId) {
      const m = await prisma.employee.findFirst({ where: { id: emp.managerEmployeeId, businessId }, select: { firstName: true, lastName: true } });
      if (m) managerName = [m.firstName, m.lastName].filter(Boolean).join(' ') || null;
    }

    // Build typed-address map keyed by type (resolving "same as" pointers).
    const addrByType = {};
    for (const a of addresses) addrByType[a.type] = a;
    const resolveAddr = (type) => {
      const a = addrByType[type];
      if (!a) return null;
      if (a.sameAsType && addrByType[a.sameAsType]) {
        const src = addrByType[a.sameAsType];
        return { id: a.id, type, sameAsType: a.sameAsType, line1: src.line1, line2: src.line2, city: src.city, stateCode: src.stateCode, postalCode: src.postalCode, countryCode: src.countryCode };
      }
      return { id: a.id, type, sameAsType: a.sameAsType || null, line1: a.line1, line2: a.line2, city: a.city, stateCode: a.stateCode, postalCode: a.postalCode, countryCode: a.countryCode };
    };

    const sections = {
      personal: {
        firstName: annotate('firstName', emp.firstName),
        middleName: annotate('middleName', emp.middleName),
        lastName: annotate('lastName', emp.lastName),
        preferredName: { value: emp.preferredName, policy: 'self-edit', optional: true },
        dateOfBirth: annotate('dateOfBirth', dateOnly(emp.dateOfBirth)),
        gender: annotate('gender', emp.gender),
        maritalStatus: annotate('maritalStatus', emp.maritalStatus),
        nationality: annotate('nationality', emp.nationality),
        religion: annotate('religion', emp.religion),
        community: annotate('community', emp.community),
        motherTongue: annotate('motherTongue', emp.motherTongue),
        bloodGroup: annotate('bloodGroup', emp.bloodGroup),
        placeOfBirth: annotate('placeOfBirth', emp.placeOfBirth),
        stateOfBirthCode: annotate('stateOfBirthCode', emp.stateOfBirthCode),
        identificationMark: annotate('identificationMark', emp.identificationMark),
        heightCm: annotate('heightCm', dec(emp.heightCm)),
        weightKg: annotate('weightKg', dec(emp.weightKg)),
        fatherName: annotate('fatherName', emp.fatherName),
        fatherOccupation: annotate('fatherOccupation', emp.fatherOccupation),
        motherName: annotate('motherName', emp.motherName),
        motherOccupation: annotate('motherOccupation', emp.motherOccupation),
      },
      contact: {
        personalEmail: annotate('personalEmail', emp.personalEmail),
        workEmail: annotate('workEmail', emp.workEmail),
        phone: annotate('phone', emp.phone),
        homePhone: annotate('homePhone', emp.homePhone),
        officePhone: annotate('officePhone', emp.officePhone),
      },
      addresses: {
        CORRESPONDENCE: resolveAddr('CORRESPONDENCE'),
        PERMANENT: resolveAddr('PERMANENT'),
        OFFICE: resolveAddr('OFFICE'),
        policy: 'self-edit',
      },
      emergencyContacts: emergency.map((e) => ({ id: e.id, name: e.name, relationship: e.relationship, phone: e.phone, email: e.email, isPrimary: e.isPrimary })),
      family: dependants.map((d) => ({ id: d.id, name: d.name, relationship: d.relationship, dateOfBirth: dateOnly(d.dateOfBirth), isNominee: d.isNominee, nomineePercent: dec(d.nomineePercent), isInsured: d.isInsured })),
      bank: bank ? {
        id: bank.id,
        accountName: annotate('bank.accountName', bank.accountName),
        accountNumber: annotate('bank.accountNumber', bank.accountNumber),
        ifsc: annotate('bank.ifsc', bank.ifsc),
        nzBankAccount: annotate('bank.nzBankAccount', bank.nzBankAccount),
        bankName: annotate('bank.bankName', bank.bankName),
        currencyCode: bank.currencyCode,
      } : null,
      education: education.map((e) => ({ id: e.id, level: e.level, institution: e.institution, fieldOfStudy: e.fieldOfStudy, startYear: e.startYear, endYear: e.endYear, grade: e.grade, isHighest: e.isHighest })),
      professional: {
        employeeCode: annotate('code', emp.code),
        designation: annotate('employment.designation', rec && rec.designation ? rec.designation.title : null),
        department: annotate('employment.department', rec && rec.department ? rec.department.name : null),
        location: annotate('employment.location', rec && rec.location ? rec.location.name : null),
        entity: rec && rec.entity ? (rec.entity.tradeName || rec.entity.legalName) : null,
        employmentType: rec ? rec.employmentType : null,
        dateOfJoining: annotate('employment.dateOfJoining', dateOnly(emp.hireDate)),
        manager: annotate('manager', managerName),
        status: annotate('status', emp.status),
      },
      nomination: dependants.filter((d) => d.isNominee).map((d) => ({ id: d.id, name: d.name, relationship: d.relationship, nomineePercent: dec(d.nomineePercent) })),
      statutory: statutory ? {
        countryCode: statutory.countryCode,
        pan: annotate('statutory.pan', statutory.pan),
        uan: annotate('statutory.uan', statutory.uan),
        irdNumber: annotate('statutory.irdNumber', statutory.irdNumber),
        aadhaarVerified: statutory.aadhaarVerified || false, // FLAG only, never the number
      } : null,
      photo: { photoUrl: emp.photoUrl || null, policy: 'self-edit' },
    };

    return res.json({
      employeeId: emp.id,
      readOnly: isSeparatedEmployee(emp), // separated → client renders read-only
      sections,
      pendingChangeRequests: pendingByField,
    });
  } catch (e) { return next(e); }
}

// ── policy-split write resolver (single entry-point, §5.1) ─────────────────────
// Body is a flat { fieldKey: value } map. Splits by policy: self-edit commits now;
// hr-approval → change requests; read-only → 400. Returns { applied, pending, errors }.
async function applyEmployeeFields(req, res, fields) {
  const { businessId } = req.customer;
  const emp = await resolveSelf(req);
  if (!emp) return noEmployee(res);
  if (isSeparatedEmployee(emp)) return lockedOut(res);

  const selfEdit = {};   // committed to Employee now
  const gated = [];      // routed to change requests
  const errors = {};

  for (const [key, raw] of Object.entries(fields || {})) {
    const pol = fieldPolicy(key);
    if (pol.policy === 'read-only') { errors[key] = 'This field cannot be changed here'; continue; }
    const vr = validateField(key, raw);
    if (!vr.ok) { errors[key] = vr.error; continue; }
    if (pol.policy === 'self-edit' && pol.model === 'employee') {
      selfEdit[key] = vr.value;
    } else if (pol.policy === 'hr-approval') {
      gated.push({ field: key, newValue: vr.value });
    } else {
      // a self-edit field that lives on a non-employee model was sent to the wrong
      // endpoint — guide the client without committing.
      errors[key] = `Use the dedicated endpoint for ${key}`;
    }
  }

  if (Object.keys(errors).length && !Object.keys(selfEdit).length && !gated.length) {
    return res.status(400).json({ message: 'Validation failed', errors });
  }

  const applied = [];
  if (Object.keys(selfEdit).length) {
    // dateOfBirth would be gated; everything here is plain Employee columns.
    const data = {};
    for (const [k, val] of Object.entries(selfEdit)) {
      data[k] = (k === 'heightCm' || k === 'weightKg') ? (val == null ? null : Number(val)) : val;
    }
    await prisma.employee.update({ where: { id: emp.id }, data });
    applied.push(...Object.keys(selfEdit));
    await writeAudit({ businessId, actorId: req.customer.id, action: 'PROFILE_SELF_EDIT', entityType: 'Employee', entityId: emp.id, meta: { fields: Object.keys(selfEdit) } });
  }

  const pending = [];
  for (const g of gated) {
    const cr = await openChangeRequest(businessId, emp, g.field, g.newValue, req);
    if (cr) pending.push({ field: g.field, changeRequestId: cr.id });
  }

  return res.json({ applied, pending, errors: Object.keys(errors).length ? errors : undefined });
}

// Open ONE ProfileChangeRequest(PENDING) + an ApprovalRequest(PROFILE_CHANGE) via the
// F10 engine. Collapses a duplicate PENDING request for the same field (the latest
// supersedes; older auto-WITHDRAWN), keeping the HR queue clean (§9 idempotency).
async function openChangeRequest(businessId, emp, field, newValue, req) {
  const oldValue = await currentValueOf(businessId, emp, field);
  if (String(oldValue ?? '') === String(newValue ?? '')) return null; // no-op change

  return prisma.$transaction(async (tx) => {
    // supersede an existing PENDING request for the same field.
    const dupes = await tx.profileChangeRequest.findMany({
      where: { businessId, employeeId: emp.id, field, status: 'PENDING' },
      select: { id: true, approvalRequestId: true },
    });
    for (const d of dupes) {
      await tx.profileChangeRequest.update({ where: { id: d.id }, data: { status: 'CANCELLED', decidedAt: new Date() } });
      if (d.approvalRequestId) {
        try { await engine.withdraw({ approvalRequestId: d.approvalRequestId, actorUserId: 'SYSTEM', comment: 'Superseded by a newer change request' }, tx); } catch (_e) { /* tolerate already-closed */ }
      }
    }

    const cr = await tx.profileChangeRequest.create({
      data: { businessId, employeeId: emp.id, field, oldValue: oldValue == null ? null : String(oldValue), newValue: String(newValue), status: 'PENDING' },
    });

    // Drive the engine: module PROFILE_CHANGE, entity = the ProfileChangeRequest row.
    const opened = await engine.openRequest({
      businessId,
      module: 'PROFILE_CHANGE',
      entityType: 'ProfileChangeRequest',
      entityId: cr.id,
      requesterEmployeeId: emp.id,
      payload: { field, newValue: String(newValue) },
      ctx: { field },
    }, tx);

    await tx.profileChangeRequest.update({ where: { id: cr.id }, data: { approvalRequestId: opened.approvalRequest.id } });
    await writeAudit({ businessId, actorId: req.customer.id, action: 'PROFILE_CHANGE_REQUESTED', entityType: 'ProfileChangeRequest', entityId: cr.id, meta: { field } });
    return cr;
  });
}

// Read the current persisted value for a gated fieldKey (for the oldValue snapshot).
async function currentValueOf(businessId, emp, field) {
  const pol = fieldPolicy(field);
  if (pol.model === 'employee') {
    if (field === 'dateOfBirth') return dateOnly(emp.dateOfBirth);
    return emp[field] ?? null;
  }
  if (pol.model === 'bankAccount') {
    const bank = await prisma.bankAccount.findFirst({ where: { businessId, employeeId: emp.id, isPrimary: true, deletedAt: null } });
    if (!bank) return null;
    return bank[field.split('.')[1]] ?? null;
  }
  if (pol.model === 'statutoryProfile') {
    const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });
    if (!sp) return null;
    return sp[field.split('.')[1]] ?? null;
  }
  return null;
}

// ── PATCH /me/profile/personal — Personal fields (gated ones routed to approval) ─
async function patchPersonal(req, res, next) {
  try { return await applyEmployeeFields(req, res, req.body || {}); } catch (e) { return next(e); }
}
// ── PATCH /me/profile/contact — contact/phones/personal email ──────────────────
async function patchContact(req, res, next) {
  try { return await applyEmployeeFields(req, res, req.body || {}); } catch (e) { return next(e); }
}

// ── POST /me/profile/change-requests — explicit gated submit ───────────────────
// body { changes: [{ field, newValue }] }. Every field must be hr-approval policy;
// a self-edit/read-only field is rejected (clients use the PATCH endpoints for those).
async function submitChangeRequests(req, res, next) {
  try {
    const { businessId } = req.customer;
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);

    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length) return res.status(400).json({ message: 'changes[] is required' });

    const pending = [];
    const errors = {};
    for (const ch of changes) {
      const field = ch && ch.field;
      const pol = fieldPolicy(field);
      if (pol.policy !== 'hr-approval') { errors[field || '?'] = 'This field does not require an approval'; continue; }
      const vr = validateField(field, ch.newValue);
      if (!vr.ok) { errors[field] = vr.error; continue; }
      const cr = await openChangeRequest(businessId, emp, field, vr.value, req);
      if (cr) pending.push({ field, changeRequestId: cr.id });
    }
    if (!pending.length && Object.keys(errors).length) return res.status(400).json({ message: 'Validation failed', errors });
    return res.json({ pending, errors: Object.keys(errors).length ? errors : undefined });
  } catch (e) { return next(e); }
}

// ── GET /me/profile/change-requests — caller's own requests (self-scoped) ──────
async function listChangeRequests(req, res, next) {
  try {
    const { businessId } = req.customer;
    const emp = await resolveSelf(req);
    if (!emp) return res.json({ items: [] });
    const rows = await prisma.profileChangeRequest.findMany({
      where: { businessId, employeeId: emp.id },
      orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, field: true, oldValue: true, newValue: true, status: true, createdAt: true, decidedAt: true },
    });
    res.json({ items: rows });
  } catch (e) { return next(e); }
}

module.exports = {
  getFull,
  patchPersonal,
  patchContact,
  submitChangeRequests,
  listChangeRequests,
  // exported for the section sub-controllers + tests
  _internals: { resolveSelf, openChangeRequest, applyEmployeeFields, currentValueOf, PROFILE_SELECT },
};

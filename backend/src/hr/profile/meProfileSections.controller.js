'use strict';

/**
 * meProfileSections.controller.js — Feature 13 self-service SECTION CRUD (addresses,
 * emergency contacts ≤2, education, family/dependants with nominee ≤100%). CUSTOMER
 * session, SELF_ONLY — every row is keyed to the session-resolved employee; the
 * client never supplies an employeeId, and a :id param is always re-scoped to the
 * caller's own employee (a forged id 404s). These are all `self-edit` policy fields.
 *
 * Terminated/inactive employees are locked out of writes (read stays open via getFull).
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { resolveSelfEmployee, isSeparatedEmployee } = require('../lib/resolveSelfEmployee');

const SELECT = { id: true, businessId: true, status: true, isActive: true, workEmail: true, personalEmail: true, userId: true };
async function resolveSelf(req) {
  return resolveSelfEmployee(req.customer.businessId, req.customer, SELECT);
}
const noEmployee = (res) => res.status(404).json({ message: 'No employee record is linked to your account' });
const lockedOut = (res) => res.status(403).json({ message: 'Your account is no longer active; this action is unavailable', reason: 'separated' });

function audit(req, action, entityType, entityId, meta) {
  return writeAudit({ businessId: req.customer.businessId, actorId: req.customer.id, action, entityType, entityId, meta });
}

// ═══ ADDRESSES (typed: CORRESPONDENCE / PERMANENT / OFFICE + "same as") ═════════
const ADDRESS_TYPES = new Set(['CORRESPONDENCE', 'PERMANENT', 'OFFICE']);

// PUT /me/profile/addresses/:type — upsert one typed address. `{ sameAsType }`
// stores a POINTER (no copy) so a later edit to the source propagates.
async function upsertAddress(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const type = String(req.params.type || '').toUpperCase();
    if (!ADDRESS_TYPES.has(type)) return res.status(400).json({ message: 'Invalid address type' });

    const b = req.body || {};
    let sameAsType = b.sameAsType ? String(b.sameAsType).toUpperCase() : null;
    if (sameAsType) {
      if (!ADDRESS_TYPES.has(sameAsType) || sameAsType === type) return res.status(400).json({ message: 'Invalid "same as" type' });
    }
    const data = sameAsType
      ? { sameAsType, line1: null, line2: null, city: null, stateCode: null, postalCode: null, countryCode: null }
      : {
          sameAsType: null,
          line1: b.line1 ?? null, line2: b.line2 ?? null, city: b.city ?? null,
          stateCode: b.stateCode ?? null, postalCode: b.postalCode ?? null,
          countryCode: b.countryCode ? String(b.countryCode).toUpperCase().slice(0, 2) : null,
        };

    const row = await prisma.employeeAddress.upsert({
      where: { businessId_employeeId_type: { businessId: emp.businessId, employeeId: emp.id, type } },
      create: { businessId: emp.businessId, employeeId: emp.id, type, ...data },
      update: data,
    });
    await audit(req, 'PROFILE_SELF_EDIT', 'EmployeeAddress', row.id, { type });
    res.json({ address: row });
  } catch (e) { next(e); }
}

// ═══ EMERGENCY CONTACTS (max 2) ═════════════════════════════════════════════════
const MAX_EMERGENCY = 2;
async function createEmergency(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const count = await prisma.emergencyContact.count({ where: { businessId: emp.businessId, employeeId: emp.id } });
    if (count >= MAX_EMERGENCY) return res.status(400).json({ message: `You can store at most ${MAX_EMERGENCY} emergency contacts` });
    const b = req.body || {};
    if (!b.name || !b.relationship || !b.phone) return res.status(400).json({ message: 'name, relationship and phone are required' });
    const row = await prisma.emergencyContact.create({
      data: { businessId: emp.businessId, employeeId: emp.id, name: String(b.name), relationship: String(b.relationship), phone: String(b.phone), email: b.email ? String(b.email) : null, isPrimary: count === 0 },
    });
    await audit(req, 'PROFILE_SELF_EDIT', 'EmergencyContact', row.id, { op: 'create' });
    res.status(201).json({ emergencyContact: row });
  } catch (e) { next(e); }
}
async function updateEmergency(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const existing = await prisma.emergencyContact.findFirst({ where: { id: req.params.id, businessId: emp.businessId, employeeId: emp.id } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const b = req.body || {};
    const data = {};
    for (const f of ['name', 'relationship', 'phone', 'email']) if (b[f] !== undefined) data[f] = b[f] == null ? null : String(b[f]);
    const row = await prisma.emergencyContact.update({ where: { id: existing.id }, data });
    await audit(req, 'PROFILE_SELF_EDIT', 'EmergencyContact', row.id, { op: 'update' });
    res.json({ emergencyContact: row });
  } catch (e) { next(e); }
}
async function deleteEmergency(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const existing = await prisma.emergencyContact.findFirst({ where: { id: req.params.id, businessId: emp.businessId, employeeId: emp.id } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    await prisma.emergencyContact.delete({ where: { id: existing.id } });
    await audit(req, 'PROFILE_SELF_EDIT', 'EmergencyContact', existing.id, { op: 'delete' });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ═══ EDUCATION ══════════════════════════════════════════════════════════════════
const EDUCATION_LEVELS = new Set(['SCHOOL', 'DIPLOMA', 'BACHELORS', 'MASTERS', 'DOCTORATE', 'CERTIFICATION', 'OTHER']);
function educationData(b) {
  const data = {};
  if (b.level !== undefined) data.level = String(b.level).toUpperCase();
  if (b.institution !== undefined) data.institution = b.institution == null ? null : String(b.institution);
  if (b.fieldOfStudy !== undefined) data.fieldOfStudy = b.fieldOfStudy == null ? null : String(b.fieldOfStudy);
  if (b.startYear !== undefined) data.startYear = b.startYear == null ? null : Number(b.startYear);
  if (b.endYear !== undefined) data.endYear = b.endYear == null ? null : Number(b.endYear);
  if (b.grade !== undefined) data.grade = b.grade == null ? null : String(b.grade);
  if (b.isHighest !== undefined) data.isHighest = !!b.isHighest;
  return data;
}
async function createEducation(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const b = req.body || {};
    if (!b.level || !EDUCATION_LEVELS.has(String(b.level).toUpperCase())) return res.status(400).json({ message: 'A valid level is required' });
    if (!b.institution) return res.status(400).json({ message: 'institution is required' });
    const row = await prisma.employeeEducation.create({ data: { businessId: emp.businessId, employeeId: emp.id, ...educationData(b), institution: String(b.institution), level: String(b.level).toUpperCase() } });
    await audit(req, 'PROFILE_SELF_EDIT', 'EmployeeEducation', row.id, { op: 'create' });
    res.status(201).json({ education: row });
  } catch (e) { next(e); }
}
async function updateEducation(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const existing = await prisma.employeeEducation.findFirst({ where: { id: req.params.id, businessId: emp.businessId, employeeId: emp.id } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const b = req.body || {};
    if (b.level !== undefined && !EDUCATION_LEVELS.has(String(b.level).toUpperCase())) return res.status(400).json({ message: 'Invalid level' });
    const row = await prisma.employeeEducation.update({ where: { id: existing.id }, data: educationData(b) });
    await audit(req, 'PROFILE_SELF_EDIT', 'EmployeeEducation', row.id, { op: 'update' });
    res.json({ education: row });
  } catch (e) { next(e); }
}
async function deleteEducation(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const existing = await prisma.employeeEducation.findFirst({ where: { id: req.params.id, businessId: emp.businessId, employeeId: emp.id } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    await prisma.employeeEducation.delete({ where: { id: existing.id } });
    await audit(req, 'PROFILE_SELF_EDIT', 'EmployeeEducation', existing.id, { op: 'delete' });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ═══ FAMILY / DEPENDANTS (incl. nominee %, sum ≤ 100 enforced) ══════════════════
const DEPENDANT_RELATIONS = new Set(['SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER']);

// Enforce the nominee-percent invariant: across ALL nominee dependants the sum ≤ 100.
// `excludeId` drops a row being updated/replaced; `add` is the candidate row.
async function nomineeSumOk(businessId, employeeId, add, excludeId) {
  const rows = await prisma.dependant.findMany({ where: { businessId, employeeId, isNominee: true }, select: { id: true, nomineePercent: true } });
  let sum = 0;
  for (const r of rows) { if (excludeId && r.id === excludeId) continue; sum += Number(r.nomineePercent || 0); }
  if (add && add.isNominee) sum += Number(add.nomineePercent || 0);
  return sum <= 100;
}
function dependantData(b) {
  const data = {};
  if (b.name !== undefined) data.name = b.name == null ? null : String(b.name);
  if (b.relationship !== undefined) data.relationship = String(b.relationship).toUpperCase();
  if (b.dateOfBirth !== undefined) data.dateOfBirth = b.dateOfBirth ? new Date(b.dateOfBirth) : null;
  if (b.isNominee !== undefined) data.isNominee = !!b.isNominee;
  if (b.nomineePercent !== undefined) data.nomineePercent = b.nomineePercent == null ? null : Number(b.nomineePercent);
  if (b.isInsured !== undefined) data.isInsured = !!b.isInsured;
  return data;
}
async function createFamily(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const b = req.body || {};
    if (!b.name || !b.relationship || !DEPENDANT_RELATIONS.has(String(b.relationship).toUpperCase())) return res.status(400).json({ message: 'name and a valid relationship are required' });
    const cand = { isNominee: !!b.isNominee, nomineePercent: b.nomineePercent };
    if (!(await nomineeSumOk(emp.businessId, emp.id, cand))) return res.status(400).json({ message: 'Total nominee percentage cannot exceed 100%' });
    const row = await prisma.dependant.create({ data: { businessId: emp.businessId, employeeId: emp.id, ...dependantData(b), name: String(b.name), relationship: String(b.relationship).toUpperCase() } });
    await audit(req, 'PROFILE_SELF_EDIT', 'Dependant', row.id, { op: 'create' });
    res.status(201).json({ dependant: row });
  } catch (e) { next(e); }
}
async function updateFamily(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const existing = await prisma.dependant.findFirst({ where: { id: req.params.id, businessId: emp.businessId, employeeId: emp.id } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const b = req.body || {};
    if (b.relationship !== undefined && !DEPENDANT_RELATIONS.has(String(b.relationship).toUpperCase())) return res.status(400).json({ message: 'Invalid relationship' });
    const merged = { isNominee: b.isNominee !== undefined ? !!b.isNominee : existing.isNominee, nomineePercent: b.nomineePercent !== undefined ? b.nomineePercent : existing.nomineePercent };
    if (!(await nomineeSumOk(emp.businessId, emp.id, merged, existing.id))) return res.status(400).json({ message: 'Total nominee percentage cannot exceed 100%' });
    const row = await prisma.dependant.update({ where: { id: existing.id }, data: dependantData(b) });
    await audit(req, 'PROFILE_SELF_EDIT', 'Dependant', row.id, { op: 'update' });
    res.json({ dependant: row });
  } catch (e) { next(e); }
}
async function deleteFamily(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const existing = await prisma.dependant.findFirst({ where: { id: req.params.id, businessId: emp.businessId, employeeId: emp.id } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    await prisma.dependant.delete({ where: { id: existing.id } });
    await audit(req, 'PROFILE_SELF_EDIT', 'Dependant', existing.id, { op: 'delete' });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ═══ PHOTO ═══════════════════════════════════════════════════════════════════════
// POST /me/profile/photo — { photoUrl } : set/replace the profile photo. The upload
// itself (file → URL) is the existing lifecycle document-upload path; here we just
// persist the resolved URL on the employee (self-edit).
async function setPhoto(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const url = req.body && req.body.photoUrl;
    if (!url || typeof url !== 'string') return res.status(400).json({ message: 'photoUrl is required' });
    await prisma.employee.update({ where: { id: emp.id }, data: { photoUrl: url } });
    await audit(req, 'PROFILE_SELF_EDIT', 'Employee', emp.id, { field: 'photoUrl' });
    res.json({ photoUrl: url });
  } catch (e) { next(e); }
}

module.exports = {
  upsertAddress,
  createEmergency, updateEmergency, deleteEmergency,
  createEducation, updateEducation, deleteEducation,
  createFamily, updateFamily, deleteFamily,
  setPhoto,
  _internals: { nomineeSumOk },
};

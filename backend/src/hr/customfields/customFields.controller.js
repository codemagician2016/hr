'use strict';

/**
 * customFields.controller.js — Phase 5b HTTP surface for tenant-defined custom fields.
 *   - Admin (operator session): definition CRUD + per-employee value read/write. The
 *     employee-scoped routes are guarded by withEmployeeScope(idParam) so a manager can
 *     only touch their sub-tree (out-of-tree :id → 404 before the controller runs).
 *   - ESS (customer session, SELF_ONLY): the signed-in employee reads their own visible
 *     fields and self-edits the SELF_EDIT ones. The subject is resolved from the session
 *     (meProfileSections.resolveSelf precedent) — no employeeId is ever taken from the
 *     client, so a cross-employee read/write is structurally impossible. Separated
 *     employees are locked out of writes (reads stay open), like the profile sections.
 *
 * Service errors carry { status, code }; sendErr maps them to a JSON response, otherwise
 * the central error handler (src/index.js) sees err.status || 500.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { resolveSelfEmployee, isSeparatedEmployee } = require('../lib/resolveSelfEmployee');
const svc = require('./customFields.service');

// Map a service error (status/code on the Error) → a JSON response; else re-throw to next.
function sendErr(res, next, e) {
  if (e && e.status) {
    const body = { message: e.message, code: e.code };
    if (e.field) body.field = e.field;
    if (e.reason) body.reason = e.reason;
    return res.status(e.status).json(body);
  }
  return next(e);
}

// Read the values map off the request body — accept `{ values: {...} }` (preferred) or
// a bare `{ key: value }` map for convenience.
function valuesFromBody(req) {
  const b = req.body || {};
  if (b.values && typeof b.values === 'object' && !Array.isArray(b.values)) return b.values;
  return b;
}

// ═══ ADMIN — definition CRUD ════════════════════════════════════════════════════
// GET /api/hr/custom-fields/definitions?includeInactive=true
async function listDefs(req, res, next) {
  try {
    const { businessId } = req.user;
    const includeInactive = req.query.includeInactive === 'true' || req.query.includeInactive === '1';
    const defs = await svc.listDefinitions(prisma, businessId, { entityType: 'EMPLOYEE', includeInactive });
    res.json({ items: defs.map(svc.publicDefinition) });
  } catch (e) { sendErr(res, next, e); }
}

// POST /api/hr/custom-fields/definitions
async function createDef(req, res, next) {
  try {
    const { businessId, id: actorUserId } = req.user;
    const def = await svc.createDefinition(prisma, businessId, req.body || {});
    await writeAudit({
      businessId, actorId: actorUserId, action: 'customfield.definition.create',
      entityType: 'CustomFieldDefinition', entityId: def.id,
      meta: { key: def.key, fieldType: def.fieldType },
    }).catch(() => {});
    res.status(201).json(svc.publicDefinition(def));
  } catch (e) { sendErr(res, next, e); }
}

// PATCH /api/hr/custom-fields/definitions/:id
async function updateDef(req, res, next) {
  try {
    const { businessId, id: actorUserId } = req.user;
    const def = await svc.updateDefinition(prisma, businessId, req.params.id, req.body || {});
    await writeAudit({
      businessId, actorId: actorUserId, action: 'customfield.definition.update',
      entityType: 'CustomFieldDefinition', entityId: def.id, meta: { key: def.key },
    }).catch(() => {});
    res.json(svc.publicDefinition(def));
  } catch (e) { sendErr(res, next, e); }
}

// DELETE /api/hr/custom-fields/definitions/:id — soft archive.
async function deleteDef(req, res, next) {
  try {
    const { businessId, id: actorUserId } = req.user;
    const def = await svc.archiveDefinition(prisma, businessId, req.params.id);
    await writeAudit({
      businessId, actorId: actorUserId, action: 'customfield.definition.archive',
      entityType: 'CustomFieldDefinition', entityId: def.id, meta: { key: def.key },
    }).catch(() => {});
    res.json({ ok: true, id: def.id, isActive: def.isActive });
  } catch (e) { sendErr(res, next, e); }
}

// ═══ ADMIN — per-employee values ════════════════════════════════════════════════
// The route wires withEmployeeScope(idParam:'id') so an out-of-tree :id already 404s;
// we re-check the employee row exists in-tenant for a clean 404 on a bogus id.
async function loadScopedEmployee(businessId, employeeId) {
  return prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true },
  });
}

// GET /api/hr/employees/:id/custom-fields
async function getEmployeeValues(req, res, next) {
  try {
    const { businessId } = req.user;
    const emp = await loadScopedEmployee(businessId, req.params.id);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });
    const items = await svc.getEmployeeCustomFields(prisma, businessId, emp.id, {});
    res.json({ employeeId: emp.id, customFields: items });
  } catch (e) { sendErr(res, next, e); }
}

// PATCH /api/hr/employees/:id/custom-fields   body: { values: { <key>: <value> } }
async function patchEmployeeValues(req, res, next) {
  try {
    const { businessId, id: actorUserId } = req.user;
    const emp = await loadScopedEmployee(businessId, req.params.id);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });
    const items = await svc.setEmployeeCustomFields(prisma, businessId, emp.id, valuesFromBody(req), {
      actorUserId: actorUserId || null,
      essSelfEditOnly: false,
    });
    await writeAudit({
      businessId, actorId: actorUserId, action: 'customfield.values.update',
      entityType: 'Employee', entityId: emp.id, meta: { keys: Object.keys(valuesFromBody(req)) },
    }).catch(() => {});
    res.json({ employeeId: emp.id, customFields: items });
  } catch (e) { sendErr(res, next, e); }
}

// ═══ ESS — self service (customer session, SELF_ONLY) ═══════════════════════════
const SELF_SELECT = { id: true, businessId: true, status: true, isActive: true, workEmail: true, personalEmail: true, userId: true };
async function resolveSelf(req) {
  return resolveSelfEmployee(req.customer.businessId, req.customer, SELF_SELECT);
}
const noEmployee = (res) => res.status(404).json({ message: 'No employee record is linked to your account' });
const lockedOut = (res) => res.status(403).json({ message: 'Your account is no longer active; this action is unavailable', reason: 'separated' });

// GET /api/hr/me/custom-fields — the signed-in employee's visible fields. essVisible-only
// AND essPolicy !== HIDDEN (a HIDDEN field is never surfaced to ESS, even if essVisible).
async function getMyValues(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    const businessId = req.customer.businessId;
    const items = (await svc.getEmployeeCustomFields(prisma, businessId, emp.id, { essVisibleOnly: true }))
      .filter((it) => it.definition.essPolicy !== 'HIDDEN');
    res.json({ customFields: items });
  } catch (e) { sendErr(res, next, e); }
}

// PATCH /api/hr/me/custom-fields   body: { values: { <key>: <value> } }
// Self-edit only the SELF_EDIT-policy fields; separated employees are locked out.
async function patchMyValues(req, res, next) {
  try {
    const emp = await resolveSelf(req);
    if (!emp) return noEmployee(res);
    if (isSeparatedEmployee(emp)) return lockedOut(res);
    const businessId = req.customer.businessId;
    const items = (await svc.setEmployeeCustomFields(prisma, businessId, emp.id, valuesFromBody(req), {
      actorUserId: emp.userId || null,
      essSelfEditOnly: true,
    })).filter((it) => it.definition.essPolicy !== 'HIDDEN');
    await writeAudit({
      businessId, actorId: req.customer.id, action: 'PROFILE_SELF_EDIT',
      entityType: 'Employee', entityId: emp.id, meta: { customFieldKeys: Object.keys(valuesFromBody(req)) },
    }).catch(() => {});
    res.json({ customFields: items });
  } catch (e) { sendErr(res, next, e); }
}

module.exports = {
  listDefs, createDef, updateDef, deleteDef,
  getEmployeeValues, patchEmployeeValues,
  getMyValues, patchMyValues,
};

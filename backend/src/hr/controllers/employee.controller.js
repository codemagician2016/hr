'use strict';
// Employee master CRUD. Tenant-scoped by req.user.businessId; soft-delete via
// deletedAt; current employment + statutory profile included on detail reads.
// Lifecycle transitions (terminate) set denormalized status fields — the
// effective-dated history lives in EmploymentRecord (added by the service layer).
const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { scopeWhere } = require('../lib/scopeResolver');

const LIST_SELECT = {
  id: true, code: true, firstName: true, lastName: true, preferredName: true,
  workEmail: true, status: true, hireDate: true, managerEmployeeId: true,
};

// Allow-list of directly-assignable Employee fields (never trust the body wholesale).
const WRITABLE = [
  'code', 'firstName', 'middleName', 'lastName', 'preferredName',
  'dateOfBirth', 'gender', 'maritalStatus', 'nationality',
  'personalEmail', 'workEmail', 'phone',
  'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'countryCode',
  'photoUrl', 'preferredLanguage', 'status', 'hireDate', 'probationEndDate', 'managerEmployeeId',
];
const DATE_FIELDS = ['dateOfBirth', 'hireDate', 'probationEndDate'];

function pickWritable(body) {
  const out = {};
  for (const f of WRITABLE) if (body[f] !== undefined) out[f] = body[f];
  for (const d of DATE_FIELDS) if (out[d] != null) out[d] = new Date(out[d]);
  return out;
}

async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const { status, q, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    // Feature 1: AND the hierarchical scope (Manager → their reporting sub-tree only).
    const where = { businessId, deletedAt: null, ...scopeWhere(req.scope) };
    // Normalise the status filter to the EmployeeStatus enum (UI sends e.g. ?status=active).
    if (status) {
      const s = String(status).toUpperCase().replace(/[-\s]+/g, '_');
      const VALID = ['PRE_HIRE', 'PROBATION', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'SUSPENDED', 'TERMINATED', 'RETIRED'];
      if (VALID.includes(s)) where.status = s;
    }
    if (q) {
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
        { workEmail: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.employee.findMany({ where, select: LIST_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.employee.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const emp = await prisma.employee.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: {
        employmentRecords: { where: { isCurrent: true }, take: 1 },
        statutoryProfile: true,
        bankAccounts: true,
      },
    });
    if (!emp) return res.status(404).json({ message: 'Employee not found' });
    res.json(emp);
  } catch (e) { next(e); }
}

async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const { code, firstName, lastName } = req.body;
    if (!code || !firstName || !lastName) {
      return res.status(400).json({ message: 'code, firstName and lastName are required' });
    }
    const data = { ...pickWritable(req.body), businessId };
    const emp = await prisma.employee.create({ data });
    res.status(201).json(emp);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'An employee with that code already exists' });
    next(e);
  }
}

async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.employee.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Employee not found' });
    const emp = await prisma.employee.update({ where: { id: req.params.id }, data: pickWritable(req.body) });
    res.json(emp);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'An employee with that code already exists' });
    next(e);
  }
}

/**
 * settleEmployeeTermination(client, { businessId, employeeId, actorId, terminationDate,
 *   status }) — the INTERNAL settle helper (Feature 4 §4.3). DEMOTED from the
 * user-facing `terminate` endpoint: the lifecycle exit path is now
 * `POST /api/hr/separations/:id/settle` (offboarding.controller), which runs the
 * full SeparationCase / FnF machine and calls THIS helper at the end to flip the
 * directory status + close the current EmploymentRecord. Accepts a prisma client
 * or a `$transaction` tx handle so the caller can settle atomically.
 *
 * Sets Employee.status (TERMINATED by default, or RETIRED) + terminationDate +
 * isActive=false, closes the current EmploymentRecord (effectiveTo = terminationDate,
 * isCurrent=false — EmploymentChangeReason has no SEPARATION value, so we end-date
 * the segment per the append-only convention), and audits. Idempotent: an already-
 * TERMINATED/RETIRED employee is a no-op.
 */
async function settleEmployeeTermination(client, { businessId, employeeId, actorId, terminationDate, status = 'TERMINATED' } = {}) {
  const db = client || prisma;
  const existing = await db.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
  if (!existing) return { changed: false, notFound: true };
  if (existing.status === 'TERMINATED' || existing.status === 'RETIRED') {
    return { employee: existing, changed: false };
  }
  const termDate = terminationDate ? new Date(terminationDate) : new Date();
  const termDateOnly = new Date(Date.UTC(termDate.getUTCFullYear(), termDate.getUTCMonth(), termDate.getUTCDate()));

  // Close the current EmploymentRecord segment (end-date it; append-only history).
  await db.employmentRecord.updateMany({
    where: { businessId, employeeId, isCurrent: true },
    data: { isCurrent: false, effectiveTo: termDateOnly },
  });

  const emp = await db.employee.update({
    where: { id: employeeId },
    data: { status, terminationDate: termDate, isActive: false, version: { increment: 1 } },
  });
  await writeAudit({
    businessId,
    actorId,
    action: 'employee.settle',
    entityType: 'Employee',
    entityId: emp.id,
    meta: {
      code: emp.code,
      previousStatus: existing.status,
      newStatus: status,
      terminationDate: termDate.toISOString().slice(0, 10),
    },
  });
  return { employee: emp, changed: true };
}

// DEPRECATED user-facing termination (Feature 4 §4.3): kept for backward-compat on
// the directory route, but the proper lifecycle exit is the separation→FnF→settle
// flow (offboarding.controller). This is now a thin wrapper over the internal
// settle helper — it does NO SeparationCase / FnF work.
async function terminate(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await settleEmployeeTermination(prisma, {
      businessId,
      employeeId: req.params.id,
      actorId: req.user.id,
      terminationDate: req.body.terminationDate,
      status: 'TERMINATED',
    });
    if (out.notFound) return res.status(404).json({ message: 'Employee not found' });
    res.json(out.employee);
  } catch (e) { next(e); }
}

module.exports = { list, get, create, update, terminate, settleEmployeeTermination };

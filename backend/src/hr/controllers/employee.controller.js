'use strict';
// Employee master CRUD. Tenant-scoped by req.user.businessId; soft-delete via
// deletedAt; current employment + statutory profile included on detail reads.
// Lifecycle transitions (terminate) set denormalized status fields — the
// effective-dated history lives in EmploymentRecord (added by the service layer).
const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const { allocateCode, SCOPE_DEFAULTS } = require('../lifecycle/lib/codes');
const portalInvite = require('../lifecycle/portalInvite');

const EMP_SCOPE = 'EMPLOYEE';
const EMP_DEFAULTS = SCOPE_DEFAULTS[EMP_SCOPE] || { prefix: 'EMP-', padding: 6 };

// Ensure the tenant-wide EMPLOYEE NumberSequence row exists + is COMMITTED before
// we attempt an auto-numbered create. This matters for the collision-retry path:
// if allocateCode created the row inside a transaction that then aborted (insert
// hit a duplicate code), the row creation rolls back too — so a standalone bump of
// nextValue would touch nothing and the retry would re-mint the same value. A
// committed row lets the between-attempts bump actually advance the series.
async function ensureEmployeeSequence(businessId) {
  const existing = await prisma.numberSequence.findFirst({
    where: { businessId, entityId: null, scope: EMP_SCOPE, periodKey: null },
    select: { id: true },
  });
  if (existing) return;
  try {
    await prisma.numberSequence.create({
      data: {
        businessId, entityId: null, scope: EMP_SCOPE, periodKey: null,
        prefix: EMP_DEFAULTS.prefix, padding: EMP_DEFAULTS.padding, nextValue: 1,
      },
    });
  } catch (e) {
    // A concurrent create won the @@unique([businessId, entityId, scope, periodKey])
    // race — the row now exists, which is all we need.
    if (e.code !== 'P2002') throw e;
  }
}

const LIST_SELECT = {
  id: true, code: true, firstName: true, lastName: true, preferredName: true,
  workEmail: true, status: true, hireDate: true, managerEmployeeId: true,
  // Join the CURRENT employment segment so the directory can render the human
  // Department / Designation / Location values (not a blank cell or a UUID).
  employmentRecords: {
    where: { isCurrent: true },
    take: 1,
    orderBy: { effectiveFrom: 'desc' },
    select: {
      department: { select: { id: true, name: true } },
      designation: { select: { id: true, title: true } },
      location: { select: { id: true, name: true } },
    },
  },
};

// Flatten the joined current-employment segment onto the row so the UI reads a
// stable shape (department/designation/location + workEmail/hireDate) regardless
// of how the relation is nested. Keeps the wire contract small and predictable.
function shapeListRow(emp) {
  const rec = emp.employmentRecords && emp.employmentRecords[0];
  const { employmentRecords, ...rest } = emp;
  return {
    ...rest,
    department: rec && rec.department ? { id: rec.department.id, name: rec.department.name } : null,
    designation: rec && rec.designation ? { id: rec.designation.id, name: rec.designation.title } : null,
    location: rec && rec.location ? { id: rec.location.id, name: rec.location.name } : null,
  };
}

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

    const [rows, total] = await Promise.all([
      prisma.employee.findMany({ where, select: LIST_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.employee.count({ where }),
    ]);
    // Feature 4 — surface each employee's portal-access state (NOT_INVITED /
    // INVITED / ACTIVE / EXPIRED / REVOKED) in two batched reads so the directory
    // can render a "Portal" pill + drive the invite/resend actions per row.
    const portalMap = await portalInvite
      .portalStatusForEmployees(businessId, rows.map((r) => ({ id: r.id, workEmail: r.workEmail })))
      .catch(() => new Map());
    const items = rows.map((emp) => {
      const shaped = shapeListRow(emp);
      const portal = portalMap.get(emp.id) || { state: 'NOT_INVITED', invite: null, loginEmail: emp.workEmail || null };
      return { ...shaped, portalStatus: portal.state, portal };
    });
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const emp = await prisma.employee.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: {
        // Current employment segment, fully resolved so the detail page shows real
        // Department / Designation / Location / Grade / Band values (band via grade).
        employmentRecords: {
          where: { isCurrent: true },
          take: 1,
          orderBy: { effectiveFrom: 'desc' },
          include: {
            department: { select: { id: true, name: true } },
            designation: { select: { id: true, title: true } },
            location: { select: { id: true, name: true } },
            entity: { select: { id: true, legalName: true } },
          },
        },
        statutoryProfile: true,
        bankAccounts: true,
      },
    });
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const rec = emp.employmentRecords && emp.employmentRecords[0];
    // Grade/Band aren't relations off EmploymentRecord (only gradeId is stored), so
    // resolve them in a small follow-up read when a grade is set. Band hangs off Grade.
    let grade = null;
    let band = null;
    if (rec && rec.gradeId) {
      const g = await prisma.grade.findFirst({
        where: { id: rec.gradeId, businessId, deletedAt: null },
        select: { id: true, name: true, band: { select: { id: true, name: true } } },
      });
      if (g) {
        grade = { id: g.id, name: g.name };
        band = g.band ? { id: g.band.id, name: g.band.name } : null;
      }
    }

    // Surface a flat, predictable employment block alongside the raw record so the
    // detail page never has to dig through nested relations (or render a dash/UUID).
    const employment = rec
      ? {
          employmentRecordId: rec.id,
          department: rec.department ? { id: rec.department.id, name: rec.department.name } : null,
          designation: rec.designation ? { id: rec.designation.id, name: rec.designation.title } : null,
          location: rec.location ? { id: rec.location.id, name: rec.location.name } : null,
          entity: rec.entity ? { id: rec.entity.id, name: rec.entity.legalName } : null,
          grade,
          band,
          employmentType: rec.employmentType,
          effectiveFrom: rec.effectiveFrom,
        }
      : null;

    // Feature 4 — portal-access state for the detail header (status pill + login
    // email + invite controls). Best-effort; a lookup failure degrades to
    // NOT_INVITED rather than failing the whole profile read.
    const portal = await portalInvite
      .portalStatusForEmployee(businessId, { id: emp.id, workEmail: emp.workEmail })
      .catch(() => ({ state: 'NOT_INVITED', invite: null, loginEmail: emp.workEmail || null }));

    res.json({ ...emp, employment, portalStatus: portal.state, portal });
  } catch (e) { next(e); }
}

// @db.Date wants a UTC-midnight instant (mirrors provision.toDateOnly).
function toDateOnly(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Resolve the hiring Entity for the initial EmploymentRecord (which requires a
 * non-null entityId). Prefer an explicit entityId; else the location's entity;
 * else the tenant's first ACTIVE entity. Returns null when none can be resolved.
 */
async function resolveEntityId(tx, { businessId, entityId, locationId }) {
  if (entityId) {
    const e = await tx.entity.findFirst({ where: { id: entityId, businessId, deletedAt: null }, select: { id: true } });
    if (e) return e.id;
  }
  if (locationId) {
    const loc = await tx.location.findFirst({ where: { id: locationId, businessId, deletedAt: null }, select: { entityId: true } });
    if (loc && loc.entityId) return loc.entityId;
  }
  const active = await tx.entity.findFirst({
    where: { businessId, status: 'ACTIVE', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return active ? active.id : null;
}

async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const { code, firstName, lastName } = req.body;
    // `code` is now OPTIONAL: when the admin doesn't type one, we mint the next
    // number from the tenant's EMPLOYEE numbering scheme (atomic, inside the same
    // tx as the insert). An explicitly-provided code still wins — backwards
    // compatible with manual codes. firstName/lastName remain required.
    if (!firstName || !lastName) {
      return res.status(400).json({ message: 'firstName and lastName are required' });
    }
    const autoCode = !code || !String(code).trim();

    // Map the admin form's field names onto the model BEFORE pickWritable runs, so
    // the create wires the values the operator entered instead of silently dropping
    // them: email → workEmail, dateOfJoining → hireDate. The org context
    // (departmentId/designationId/locationId/entityId/managerEmployeeId) is NOT an
    // Employee column — it lives on the EmploymentRecord segment we create below.
    const body = { ...req.body };
    if (body.email !== undefined && body.workEmail === undefined) body.workEmail = body.email;
    if (body.dateOfJoining !== undefined && body.hireDate === undefined) body.hireDate = body.dateOfJoining;

    const data = { ...pickWritable(body), businessId };
    // Drop a blank/whitespace code so the auto-allocate path mints a real one
    // (pickWritable would otherwise carry an empty string through to the insert).
    if (autoCode) delete data.code;

    const departmentId = body.departmentId || null;
    const designationId = body.designationId || null;
    const locationId = body.locationId || null;
    const wantsEmployment = !!(departmentId || designationId || locationId);

    const runCreate = () => prisma.$transaction(async (tx) => {
      // Mint the next employee number from the tenant's EMPLOYEE scheme when the
      // admin didn't type a code. allocateCode atomically increments the
      // (businessId, scope:'EMPLOYEE') NumberSequence row inside THIS tx, so the
      // allocated value and the Employee row that uses it commit together.
      if (autoCode) {
        // P1.7 — token context so a tenant prefix like "EMP-{ENTITY}-{YY}-"
        // expands with the hire's entity/department codes + the current year.
        const tokenCtx = { year: new Date().getUTCFullYear() };
        if (body.entityId) {
          const ent = await tx.entity.findFirst({ where: { id: body.entityId, businessId }, select: { code: true } });
          if (ent) tokenCtx.entityCode = ent.code;
        }
        if (departmentId) {
          const dept = await tx.department.findFirst({ where: { id: departmentId, businessId }, select: { code: true } });
          if (dept) tokenCtx.deptCode = dept.code;
        }
        data.code = await allocateCode(tx, { businessId, scope: 'EMPLOYEE', tokenCtx });
      }
      const created = await tx.employee.create({ data });

      // Create the initial HIRE EmploymentRecord so the org context (department /
      // designation / location) is real and the directory/detail render it — mirror
      // of lifecycle provisionEmployee STEP 4 (effective-dated, append-only).
      // An EmploymentRecord requires a non-null entityId; if the tenant has no
      // entity yet we skip the segment rather than 500 (HR can add it via Edit once
      // an entity exists). When the operator picked org context but we cannot anchor
      // an entity, surface a clear 400 instead of dropping their input silently.
      const entityId = await resolveEntityId(tx, { businessId, entityId: body.entityId, locationId });
      if (entityId) {
        const effectiveFrom = toDateOnly(created.hireDate) || toDateOnly(new Date());
        const rec = await tx.employmentRecord.create({
          data: {
            businessId,
            employeeId: created.id,
            entityId,
            locationId,
            departmentId,
            designationId,
            gradeId: null,
            managerEmployeeId: created.managerEmployeeId || null,
            employmentType: 'FULL_TIME',
            workerCategory: 'STAFF',
            fteRatio: '1.0000',
            effectiveFrom,
            changeReason: 'HIRE',
            isCurrent: true,
          },
        });
        return tx.employee.update({ where: { id: created.id }, data: { currentEmploymentRecordId: rec.id } });
      }
      if (wantsEmployment) {
        // Operator chose dept/designation/location but the tenant has no entity to
        // anchor employment — fail loudly (rollback) rather than half-create.
        const err = new Error('NO_ENTITY');
        err.noEntity = true;
        throw err;
      }
      return created;
    });

    // For an AUTO-allocated code, a P2002 on the code means the minted number
    // collided with a pre-existing (likely manually-typed) code (e.g. a legacy
    // EMP-000001 typed before auto-numbering was switched on). The failed insert
    // ALSO rolls back allocateCode's increment (same tx), so a naive retry would
    // re-mint the same value forever. Instead, between attempts we advance the
    // tenant's EMPLOYEE sequence past the collision in its OWN committed statement,
    // then re-run — minting the next free number rather than 409-ing the admin. A
    // P2002 for a MANUAL code is a real duplicate the caller must fix → no retry.
    // Commit the EMPLOYEE sequence row up-front so the between-attempts bump below
    // can actually advance it (see ensureEmployeeSequence for why).
    if (autoCode) await ensureEmployeeSequence(businessId);

    let emp;
    const MAX_RETRIES = 10;
    for (let attempt = 0; ; attempt += 1) {
      try {
        emp = await runCreate();
        break;
      } catch (err) {
        const isCodeConflict = err && err.code === 'P2002'
          && String(JSON.stringify(err.meta?.target || '')).includes('code');
        if (!autoCode || !isCodeConflict || attempt >= MAX_RETRIES) throw err;
        // Skip the collided number: bump nextValue by 1 in a standalone write so
        // the next allocateCode (in a fresh tx) reads a higher, hopefully-free value.
        await prisma.numberSequence.updateMany({
          where: { businessId, entityId: null, scope: 'EMPLOYEE', periodKey: null },
          data: { nextValue: { increment: 1 } },
        });
      }
    }

    res.status(201).json(emp);
  } catch (e) {
    if (e && e.noEntity) {
      return res.status(400).json({
        message: 'Set up a legal entity under Org structure before assigning a department, designation, or location.',
      });
    }
    if (e.code === 'P2002') return res.status(409).json({ message: 'An employee with that code already exists' });
    next(e);
  }
}

/**
 * detectReportingCycle(tx, { businessId, employeeId, proposedManagerId }) — walk
 * the proposed manager chain UPWARD to make sure setting `employeeId`'s manager to
 * `proposedManagerId` does not create a loop. Returns true if a cycle would form
 * (the chain leads back to `employeeId`, or is itself already corrupt/too deep).
 * Self-assignment is rejected by the caller before this is reached.
 */
async function detectReportingCycle(tx, { businessId, employeeId, proposedManagerId }) {
  let cursor = proposedManagerId;
  const seen = new Set([employeeId]);
  // Bound the walk so a pre-existing corrupt chain can't spin forever.
  for (let i = 0; i < 1000 && cursor; i += 1) {
    if (seen.has(cursor)) return true; // chain loops back to the subject (or itself)
    seen.add(cursor);
    const mgr = await tx.employee.findFirst({
      where: { id: cursor, businessId, deletedAt: null },
      select: { managerEmployeeId: true },
    });
    if (!mgr) return false; // chain ends at an unknown/out-of-tenant node — no loop
    cursor = mgr.managerEmployeeId;
  }
  return false;
}

async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const id = req.params.id;
    const existing = await prisma.employee.findFirst({ where: { id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Employee not found' });

    // Map the admin form's aliases onto the model (mirror create): email→workEmail,
    // dateOfJoining→hireDate. The org context is handled on the EmploymentRecord.
    const body = { ...req.body };
    if (body.email !== undefined && body.workEmail === undefined) body.workEmail = body.email;
    if (body.dateOfJoining !== undefined && body.hireDate === undefined) body.hireDate = body.dateOfJoining;

    const data = pickWritable(body);

    // ── Reporting-cycle guard (M5). Only when managerEmployeeId actually changes. ──
    if ('managerEmployeeId' in data) {
      const proposed = data.managerEmployeeId || null;
      if (proposed) {
        if (proposed === id) {
          return res.status(400).json({ message: 'An employee cannot report to themselves.' });
        }
        const loops = await prisma.$transaction((tx) =>
          detectReportingCycle(tx, { businessId, employeeId: id, proposedManagerId: proposed }));
        if (loops) {
          return res.status(400).json({ message: 'reporting loop: that manager already reports (directly or indirectly) to this employee.' });
        }
        // Reject a manager that isn't a real in-tenant employee.
        const mgr = await prisma.employee.findFirst({ where: { id: proposed, businessId, deletedAt: null }, select: { id: true } });
        if (!mgr) return res.status(400).json({ message: 'The selected manager is not a valid employee.' });
      }
    }

    // Org context (department/designation/location/entity) lives on the current
    // EmploymentRecord, NOT on Employee. When the form sends any of those, append a
    // new effective-dated segment (TRANSFER) rather than mutating history in place.
    const hasOrgEdit = ['departmentId', 'designationId', 'locationId', 'entityId'].some((k) => k in body);

    const emp = await prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({ where: { id }, data });

      if (hasOrgEdit) {
        const current = await tx.employmentRecord.findFirst({
          where: { businessId, employeeId: id, isCurrent: true },
          orderBy: { effectiveFrom: 'desc' },
        });
        // Resolve the next values, falling back to the current segment for fields
        // the form did not send (a partial PATCH must not blank the others).
        const nextDept = 'departmentId' in body ? (body.departmentId || null) : (current ? current.departmentId : null);
        const nextDesig = 'designationId' in body ? (body.designationId || null) : (current ? current.designationId : null);
        const nextLoc = 'locationId' in body ? (body.locationId || null) : (current ? current.locationId : null);
        const entityId = await resolveEntityId(tx, {
          businessId,
          entityId: ('entityId' in body ? body.entityId : (current ? current.entityId : null)),
          locationId: nextLoc,
        });
        if (entityId) {
          const effectiveFrom = toDateOnly(new Date());
          // Append-only: end-date the current segment, open a new TRANSFER one.
          // If a segment already starts today (e.g. created moments ago), update it
          // in place to respect the @@unique([employeeId, effectiveFrom]).
          const sameDay = current && toDateOnly(current.effectiveFrom)
            && toDateOnly(current.effectiveFrom).getTime() === effectiveFrom.getTime();
          let rec;
          if (sameDay) {
            rec = await tx.employmentRecord.update({
              where: { id: current.id },
              data: { departmentId: nextDept, designationId: nextDesig, locationId: nextLoc, entityId, version: { increment: 1 } },
            });
          } else {
            if (current) {
              await tx.employmentRecord.updateMany({
                where: { businessId, employeeId: id, isCurrent: true },
                data: { isCurrent: false, effectiveTo: effectiveFrom },
              });
            }
            rec = await tx.employmentRecord.create({
              data: {
                businessId, employeeId: id, entityId,
                locationId: nextLoc, departmentId: nextDept, designationId: nextDesig,
                gradeId: current ? current.gradeId : null,
                managerEmployeeId: ('managerEmployeeId' in data ? (data.managerEmployeeId || null) : (current ? current.managerEmployeeId : updated.managerEmployeeId)),
                employmentType: current ? current.employmentType : 'FULL_TIME',
                workerCategory: current ? current.workerCategory : 'STAFF',
                payCalendarId: current ? current.payCalendarId : null,
                noticeDays: current ? current.noticeDays : null,
                fteRatio: current ? current.fteRatio : '1.0000',
                effectiveFrom,
                changeReason: 'TRANSFER_DEPARTMENT',
                isCurrent: true,
              },
            });
          }
          return tx.employee.update({ where: { id }, data: { currentEmploymentRecordId: rec.id } });
        }
        if (current === null) {
          // No entity resolvable and no current segment to update → can't persist org
          // context. Fail loudly so the operator isn't told "saved" while it dropped.
          const err = new Error('NO_ENTITY');
          err.noEntity = true;
          throw err;
        }
      }
      return updated;
    });

    res.json(emp);
  } catch (e) {
    if (e && e.noEntity) {
      return res.status(400).json({
        message: 'Set up a legal entity under Org structure before assigning a department, designation, or location.',
      });
    }
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

// ── Feature 4 — Employee portal-invitation controllers ─────────────────────
// All gated on canManageEmployees + the per-row employee scope (the route wires
// withEmployeeScope so a manager can only invite within their sub-tree). The
// heavy lifting (token mint/hash, revoke-old, fan-out, no-clobber) lives in the
// portalInvite service so it can be reused by bulk + the public accept path.

// Map a service reason → an HTTP status + message (kept here so the wire contract
// is in one place). Note the SERVICE never reveals token internals.
function inviteReasonResponse(res, reason, extra = {}) {
  switch (reason) {
    case 'EMPLOYEE_NOT_FOUND':
      return res.status(404).json({ message: 'Employee not found' });
    case 'NO_WORK_EMAIL':
      return res.status(422).json({ message: 'This employee has no work email — add one before inviting them to the portal.' });
    case 'EMPLOYEE_SEPARATED':
      return res.status(409).json({ message: 'This employee has been separated and cannot be invited to the portal.' });
    case 'ALREADY_ACTIVE':
      return res.status(409).json({ message: 'This employee has already activated their portal login. Use "Reset" to re-send a set-password link.', ...extra });
    default:
      return res.status(400).json({ message: 'Could not send the invite. Please try again.' });
  }
}

// POST /api/hr/employees/:id/invite   { reset?: boolean }
// Sends (or re-sends, invalidating the prior token) a portal invite. Returns the
// copyable link so the admin can share it directly even if the fan-out is best
// -effort. `reset: true` re-mints for an already-active login (explicit reset).
async function invite(req, res, next) {
  try {
    const { businessId, id: actorUserId } = req.user;
    const allowReset = req.body && (req.body.reset === true || req.body.allowReset === true);
    const out = await portalInvite.createInvite({
      businessId,
      employeeId: req.params.id,
      createdByUserId: actorUserId || null,
      allowReset,
    });
    if (!out.ok) return inviteReasonResponse(res, out.reason, out.alreadyActive ? { alreadyActive: true, loginEmail: out.loginEmail } : {});

    await writeAudit({
      businessId,
      actorId: actorUserId,
      action: 'employee.portal.invite',
      entityType: 'Employee',
      entityId: req.params.id,
      meta: { inviteId: out.invite && out.invite.id, reset: !!allowReset, notified: out.notified && out.notified.ok },
    }).catch(() => {});

    res.json({
      ok: true,
      employeeId: req.params.id,
      loginEmail: out.loginEmail,
      link: out.link,
      invite: out.invite,
      notified: out.notified,
      portalStatus: 'INVITED',
    });
  } catch (e) { next(e); }
}

// POST /api/hr/employees/invite/bulk   { employeeIds: [..], reset?: boolean }
// Invites many at once. Each row is independent — one failure (no email,
// separated, already-active) never aborts the batch; every row reports its own
// outcome + link. Capped to a sane page size.
async function inviteBulk(req, res, next) {
  try {
    const { businessId, id: actorUserId } = req.user;
    const ids = Array.isArray(req.body && req.body.employeeIds) ? req.body.employeeIds : [];
    const allowReset = req.body && (req.body.reset === true || req.body.allowReset === true);
    if (ids.length === 0) return res.status(400).json({ message: 'employeeIds is required' });
    if (ids.length > 200) return res.status(400).json({ message: 'Too many employees in one request (max 200).' });

    // Scope-enforce: only invite employees the actor can manage. req.scope is the
    // F1 ScopeResult set by withEmployeeScope on the route. Resolve the accessible
    // set EXPLICITLY for every band — NEVER fall open:
    //   ALL  → every requested id (tenant-wide operator)
    //   IDS  → only the requested ids inside the actor's sub-tree
    //   NONE → ∅ (a NONE/limited operator invites NOTHING)
    // A missing/unknown scope is treated as NONE (fail-closed). scopeAllows()
    // already encodes ALL→true / NONE→false / IDS→membership, so the intersection
    // is just a filter over it — there is no `else` that returns the raw ids.
    const scoped = ids.filter((eid) => scopeAllows(req.scope, eid));

    const results = [];
    let sent = 0;
    for (const employeeId of scoped) {
      // eslint-disable-next-line no-await-in-loop
      const out = await portalInvite.createInvite({ businessId, employeeId, createdByUserId: actorUserId || null, allowReset });
      if (out.ok) {
        sent += 1;
        results.push({ employeeId, ok: true, loginEmail: out.loginEmail, link: out.link, invite: out.invite, notified: out.notified && out.notified.ok });
      } else {
        results.push({ employeeId, ok: false, reason: out.reason, loginEmail: out.loginEmail || null });
      }
    }
    // Rows the actor isn't scoped to (silently dropped from the batch) are reported
    // as out-of-scope so the UI can explain the gap.
    for (const employeeId of ids) {
      if (!scoped.includes(employeeId)) results.push({ employeeId, ok: false, reason: 'OUT_OF_SCOPE' });
    }

    await writeAudit({
      businessId,
      actorId: actorUserId,
      action: 'employee.portal.invite.bulk',
      entityType: 'Employee',
      entityId: scoped[0] || null,
      meta: { requested: ids.length, sent, reset: !!allowReset },
    }).catch(() => {});

    res.json({ ok: true, requested: ids.length, sent, results });
  } catch (e) { next(e); }
}

module.exports = { list, get, create, update, terminate, settleEmployeeTermination, invite, inviteBulk };

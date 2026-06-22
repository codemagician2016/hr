'use strict';
// Attendance & time module. Tenant-scoped by req.user.businessId on EVERY query;
// employee-facing rows are additionally scoped by employeeId. Covers:
//   - AttendancePunch  : clock-in/out punches (+ break punches), geo + location.
//   - ShiftPattern     : shift master CRUD (soft-delete via deletedAt).
//   - ShiftAssignment  : effective-dated emp -> shift pattern mapping (hard model).
//   - Timesheet        : read + DRAFT/SUBMITTED/APPROVED/REJECTED transitions.
//   - AttendancePayInput: FROZEN payroll feed — READ ONLY here (see freeze note).
//   - Regularization   : manual-punch request + approve.
//
// SCHEMA NOTE (regularization): the schema declares
// `AttendanceRegularizationRequest[]` relations on Business/Employee, but the
// model itself is NOT yet defined (forward-declared by the lead). We therefore
// implement regularization against the REAL, existing AttendancePunch columns
// (`isManual`, `source = MANUAL`, `regularizationRequestId`): a request inserts
// pending manual punches grouped by a generated requestId; approve confirms them
// (clears the pending flag), reject removes them. When the dedicated model lands
// this controller's request/approve handlers can be repointed without changing
// the route contract. Until then there is no extra status column to rely on, so
// pending-state is tracked by `isManual = true` + a grouping requestId.
const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');

const PUNCH_TYPES = ['IN', 'OUT', 'BREAK_START', 'BREAK_END'];
const PUNCH_SOURCES = ['WEB', 'MOBILE_APP', 'BIOMETRIC', 'KIOSK', 'GEO_FENCE', 'API', 'IMPORT', 'MANUAL'];

function clampPage(query) {
  const take = Math.min(Math.max(parseInt(query.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

// Confirm an employee belongs to the caller's tenant (and is not soft-deleted)
// before writing employee-scoped rows. Returns the employee or null.
async function findEmployee(businessId, employeeId) {
  if (!employeeId) return null;
  return prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
}

/* ------------------------------------------------------------------ */
/* Punches                                                            */
/* ------------------------------------------------------------------ */

// POST /punch  — record a clock IN/OUT (or BREAK_START/BREAK_END) punch.
// Body: { employeeId, type, punchAt?, source?, locationId?, geoLat?, geoLng?,
//         ipAddress?, deviceId?, selfieUrl? }. punchAt defaults to now (UTC).
async function createPunch(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, type, source, locationId } = req.body;

    if (!employeeId) return res.status(400).json({ message: 'employeeId is required' });
    if (!PUNCH_TYPES.includes(type)) {
      return res.status(400).json({ message: `type must be one of ${PUNCH_TYPES.join(', ')}` });
    }
    const punchSource = source || 'WEB';
    if (!PUNCH_SOURCES.includes(punchSource)) {
      return res.status(400).json({ message: `source must be one of ${PUNCH_SOURCES.join(', ')}` });
    }

    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    if (locationId) {
      const loc = await prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null } });
      if (!loc) return res.status(400).json({ message: 'locationId does not belong to this business' });
    }

    const data = {
      businessId,
      employeeId,
      punchType: type,
      source: punchSource,
      punchAt: req.body.punchAt ? new Date(req.body.punchAt) : new Date(),
      locationId: locationId || null,
      // Decimal lat/lng — pass through, never parseInt.
      geoLat: req.body.geoLat != null ? req.body.geoLat : null,
      geoLng: req.body.geoLng != null ? req.body.geoLng : null,
      ipAddress: req.body.ipAddress || req.ip || null,
      deviceId: req.body.deviceId || null,
      selfieUrl: req.body.selfieUrl || null,
    };

    const punch = await prisma.attendancePunch.create({ data });
    res.status(201).json(punch);
  } catch (e) { next(e); }
}

// GET /punches?employeeId=&from=&to=  — paginated punch log for an employee.
async function listPunches(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, from, to } = req.query;
    const { take, skip, page } = clampPage(req.query);

    // Feature 1: filter to the actor's reporting sub-tree (employeeId-keyed).
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    // A client-supplied employeeId is only honored when it is in scope.
    if (employeeId) {
      if (!scopeAllows(req.scope, employeeId)) {
        return res.json({ items: [], total: 0, page, pageSize: take });
      }
      where.employeeId = employeeId;
    }
    if (from || to) {
      where.punchAt = {};
      if (from) where.punchAt.gte = new Date(from);
      if (to) where.punchAt.lte = new Date(to);
    }

    const [items, total] = await Promise.all([
      prisma.attendancePunch.findMany({ where, orderBy: { punchAt: 'desc' }, skip, take }),
      prisma.attendancePunch.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Shift patterns (the "Shift" CRUD) + assignments                    */
/* ------------------------------------------------------------------ */

const SHIFT_FIELDS = [
  'entityId', 'code', 'name', 'startTime', 'endTime', 'breakMinutes',
  'graceInMinutes', 'halfDayThresholdMinutes', 'fullDayMinutes',
  'isNightShift', 'crossesMidnight', 'weeklyOffDays', 'isActive',
];

function pickShift(body) {
  const out = {};
  for (const f of SHIFT_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

async function listShifts(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.shiftPattern.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getShift(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.shiftPattern.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { assignments: { orderBy: { effectiveFrom: 'desc' }, take: 50 } },
    });
    if (!item) return res.status(404).json({ message: 'Shift not found' });
    res.json(item);
  } catch (e) { next(e); }
}

async function createShift(req, res, next) {
  try {
    const { businessId } = req.user;
    const { code, name, startTime, endTime } = req.body;
    if (!code || !name || !startTime || !endTime) {
      return res.status(400).json({ message: 'code, name, startTime and endTime are required' });
    }
    const item = await prisma.shiftPattern.create({ data: { ...pickShift(req.body), businessId } });
    res.status(201).json(item);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A shift with that code already exists' });
    next(e);
  }
}

async function updateShift(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.shiftPattern.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Shift not found' });
    const item = await prisma.shiftPattern.update({ where: { id: req.params.id }, data: pickShift(req.body) });
    res.json(item);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A shift with that code already exists' });
    next(e);
  }
}

async function removeShift(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.shiftPattern.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Shift not found' });
    await prisma.shiftPattern.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// POST /shifts/:id/assign  — assign this shift pattern to an employee, effective-dated.
// ShiftAssignment has no deletedAt column → unassign is a hard delete.
async function assignShift(req, res, next) {
  try {
    const { businessId } = req.user;
    const shiftPatternId = req.params.id;
    const { employeeId, effectiveFrom, effectiveTo } = req.body;

    if (!employeeId || !effectiveFrom) {
      return res.status(400).json({ message: 'employeeId and effectiveFrom are required' });
    }
    const shift = await prisma.shiftPattern.findFirst({ where: { id: shiftPatternId, businessId, deletedAt: null } });
    if (!shift) return res.status(404).json({ message: 'Shift not found' });

    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const assignment = await prisma.shiftAssignment.create({
      data: {
        businessId,
        employeeId,
        shiftPatternId,
        effectiveFrom: new Date(effectiveFrom),
        effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
      },
    });
    res.status(201).json(assignment);
  } catch (e) { next(e); }
}

// GET /assignments?employeeId=  — current/historical shift assignments.
async function listAssignments(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.query;
    // Feature 1: filter to the actor's reporting sub-tree (employeeId-keyed).
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (employeeId) {
      if (!scopeAllows(req.scope, employeeId)) return res.json({ items: [] });
      where.employeeId = employeeId;
    }
    const items = await prisma.shiftAssignment.findMany({
      where,
      orderBy: { effectiveFrom: 'desc' },
      include: { shiftPattern: { select: { id: true, code: true, name: true } } },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function removeAssignment(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.shiftAssignment.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Assignment not found' });
    await prisma.shiftAssignment.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Timesheets (read + state transitions)                              */
/* ------------------------------------------------------------------ */

async function listTimesheets(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, status } = req.query;
    const { take, skip, page } = clampPage(req.query);

    // Feature 1: filter to the actor's reporting sub-tree (employeeId-keyed).
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (employeeId) {
      if (!scopeAllows(req.scope, employeeId)) {
        return res.json({ items: [], total: 0, page, pageSize: take });
      }
      where.employeeId = employeeId;
    }
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.timesheet.findMany({ where, orderBy: { periodStart: 'desc' }, skip, take }),
      prisma.timesheet.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

async function getTimesheet(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.timesheet.findFirst({
      where: { id: req.params.id, businessId },
      include: { entries: { orderBy: { date: 'asc' } } },
    });
    if (!item) return res.status(404).json({ message: 'Timesheet not found' });
    // Feature 1: out-of-scope employee → 404 (IDOR-safe).
    if (!scopeAllows(req.scope, item.employeeId)) {
      return res.status(404).json({ message: 'Timesheet not found' });
    }
    res.json(item);
  } catch (e) { next(e); }
}

// Allowed TimesheetStatus transitions: DRAFT→SUBMITTED→{APPROVED,REJECTED};
// REJECTED→SUBMITTED (resubmit); APPROVED→LOCKED (period close). LOCKED is terminal.
const TIMESHEET_TRANSITIONS = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['APPROVED', 'REJECTED'],
  REJECTED: ['SUBMITTED'],
  APPROVED: ['LOCKED'],
  LOCKED: [],
};

async function transitionTimesheet(req, res, next, target) {
  try {
    const { businessId } = req.user;
    const ts = await prisma.timesheet.findFirst({ where: { id: req.params.id, businessId } });
    if (!ts) return res.status(404).json({ message: 'Timesheet not found' });

    const allowed = TIMESHEET_TRANSITIONS[ts.status] || [];
    if (!allowed.includes(target)) {
      return res.status(409).json({ message: `Cannot move timesheet from ${ts.status} to ${target}` });
    }

    const data = { status: target };
    if (target === 'SUBMITTED') data.submittedAt = new Date();
    if (target === 'APPROVED' || target === 'REJECTED') {
      data.decidedAt = new Date();
      data.decidedBy = req.user.id || null;
    }

    const updated = await prisma.timesheet.update({ where: { id: ts.id }, data });
    res.json(updated);
  } catch (e) { next(e); }
}

const submitTimesheet = (req, res, next) => transitionTimesheet(req, res, next, 'SUBMITTED');
const approveTimesheet = (req, res, next) => transitionTimesheet(req, res, next, 'APPROVED');
const rejectTimesheet = (req, res, next) => transitionTimesheet(req, res, next, 'REJECTED');
const lockTimesheet = (req, res, next) => transitionTimesheet(req, res, next, 'LOCKED');

/* ------------------------------------------------------------------ */
/* AttendancePayInput — FROZEN payroll feed (READ ONLY)               */
/* ------------------------------------------------------------------ */

// GET /pay-inputs?payRunId=&employeeId=  — read the frozen attendance roll-up
// that feeds payroll. There is intentionally NO create/update/delete handler:
// these rows are frozen at `frozenAt` when the pay period is locked and must
// never be mutated post-freeze (immutable audit input). The lock lives on the
// parent PayRun; regenerating inputs is a payroll-engine concern, not an API edit.
async function listPayInputs(req, res, next) {
  try {
    const { businessId } = req.user;
    const { payRunId, employeeId } = req.query;
    const { take, skip, page } = clampPage(req.query);

    const where = { businessId };
    if (payRunId) where.payRunId = payRunId;
    if (employeeId) where.employeeId = employeeId;

    const [items, total] = await Promise.all([
      prisma.attendancePayInput.findMany({ where, orderBy: { frozenAt: 'desc' }, skip, take }),
      prisma.attendancePayInput.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Regularization (manual-punch request + approve)                    */
/* ------------------------------------------------------------------ */
// See SCHEMA NOTE at top: implemented over AttendancePunch until the dedicated
// AttendanceRegularizationRequest model is materialized by the lead.

// POST /regularizations  — employee/manager requests a manual punch correction.
// Body: { employeeId, punches: [{ type, punchAt, locationId? }], reason? }.
// Inserts pending manual punches grouped under a generated requestId.
async function createRegularization(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, punches } = req.body;

    if (!employeeId) return res.status(400).json({ message: 'employeeId is required' });
    if (!Array.isArray(punches) || punches.length === 0) {
      return res.status(400).json({ message: 'punches must be a non-empty array' });
    }
    for (const p of punches) {
      if (!PUNCH_TYPES.includes(p.type)) {
        return res.status(400).json({ message: `each punch.type must be one of ${PUNCH_TYPES.join(', ')}` });
      }
      if (!p.punchAt) return res.status(400).json({ message: 'each punch requires punchAt' });
    }

    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });
    // Feature 1: cannot raise a regularization for an out-of-scope employee → 404.
    if (!scopeAllows(req.scope, employeeId)) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const requestId = crypto.randomUUID();
    const rows = punches.map((p) => ({
      businessId,
      employeeId,
      punchType: p.type,
      source: 'MANUAL',
      punchAt: new Date(p.punchAt),
      locationId: p.locationId || null,
      isManual: true, // pending manual correction until approved
      regularizationRequestId: requestId,
    }));

    await prisma.attendancePunch.createMany({ data: rows });
    res.status(201).json({ requestId, employeeId, status: 'PENDING', punchCount: rows.length });
  } catch (e) { next(e); }
}

// GET /regularizations?employeeId=  — list pending/processed manual-punch groups.
async function listRegularizations(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.query;
    // Feature 1: filter to the actor's reporting sub-tree (employeeId-keyed).
    const where = { businessId, regularizationRequestId: { not: null }, ...scopeWhere(req.scope, 'employeeId') };
    if (employeeId) {
      if (!scopeAllows(req.scope, employeeId)) return res.json({ items: [] });
      where.employeeId = employeeId;
    }
    const items = await prisma.attendancePunch.findMany({
      where,
      orderBy: { punchAt: 'desc' },
      take: 200,
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// POST /regularizations/:requestId/approve  — confirm the manual punches.
// POST /regularizations/:requestId/reject   — discard them.
async function decideRegularization(req, res, next, decision) {
  try {
    const { businessId } = req.user;
    const { requestId } = req.params;

    const group = await prisma.attendancePunch.findMany({
      where: { businessId, regularizationRequestId: requestId },
    });
    if (group.length === 0) return res.status(404).json({ message: 'Regularization request not found' });
    // Feature 1: out-of-scope target employee → 404 (the :requestId is a group id,
    // so the per-target check is here rather than the middleware's idParam guard).
    if (!scopeAllows(req.scope, group[0].employeeId)) {
      return res.status(404).json({ message: 'Regularization request not found' });
    }

    if (decision === 'REJECTED') {
      await prisma.attendancePunch.deleteMany({ where: { businessId, regularizationRequestId: requestId } });
      return res.json({ requestId, status: 'REJECTED', removed: group.length });
    }

    // APPROVED: the punches stand as authoritative. There is no status column on
    // AttendancePunch, so approval is recorded by keeping the rows in place; the
    // grouping requestId remains as provenance. (No-op mutation by design.)
    return res.json({ requestId, status: 'APPROVED', confirmed: group.length });
  } catch (e) { next(e); }
}

const approveRegularization = (req, res, next) => decideRegularization(req, res, next, 'APPROVED');
const rejectRegularization = (req, res, next) => decideRegularization(req, res, next, 'REJECTED');

module.exports = {
  // punches
  createPunch, listPunches,
  // shifts
  listShifts, getShift, createShift, updateShift, removeShift,
  // assignments
  assignShift, listAssignments, removeAssignment,
  // timesheets
  listTimesheets, getTimesheet, submitTimesheet, approveTimesheet, rejectTimesheet, lockTimesheet,
  // payroll feed (read only)
  listPayInputs,
  // regularization
  createRegularization, listRegularizations, approveRegularization, rejectRegularization,
};

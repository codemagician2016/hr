'use strict';
// Attendance & time module. Tenant-scoped by req.user.businessId on EVERY query;
// employee-facing rows are additionally scoped by employeeId. Covers:
//   - AttendancePunch  : clock-in/out punches (+ break punches), geo + location.
//   - ShiftPattern     : shift master CRUD (soft-delete via deletedAt).
//   - ShiftAssignment  : effective-dated emp -> shift pattern mapping (hard model).
//   - Timesheet        : read + DRAFT/SUBMITTED/APPROVED/REJECTED transitions.
//   - AttendancePayInput: FROZEN payroll feed — READ ONLY here (see freeze note).
//   - Regularization   : AttendanceRegularizationRequest (real model) with a real
//     status/decidedBy/decidedAt and a `kind` discriminator. Self-create allowed
//     (PENDING + resolveApprover); approve materializes MANUAL IN/OUT punches and
//     re-derives; reject sets REJECTED (no hard-delete).
//
// Derivation: a punch (and an approved regularization) triggers
// attendance/service.recompute for the affected (employee, day) so the daily
// Attendance rollup stays current. Period-close freezes the rollup (isLocked) and
// a punch into a locked range is rejected (409).
const prisma = require('../../core/lib/prisma');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const { resolveApprover } = require('../lib/approvalRouting');
const { writeAudit } = require('../../core/lib/audit');
const { recompute } = require('../attendance/service');
const { resolveTimezone, civilDateInTz } = require('../attendance/tz');

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

// A @db.Date civil day at UTC midnight (matches the Attendance unique key).
function utcDay(value) {
  const t = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

// A 'YYYY-MM-DD' civil-day key → its @db.Date midnight-UTC Date.
function civilKeyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) return utcDay(new Date(key));
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// Resolve an employee's IANA timezone (location → entity → business → countryCode)
// from the CURRENT EmploymentRecord. Used to bucket a true-UTC punchAt into the
// correct LOCAL civil day (H5). Returns a zone string (never throws).
async function resolveEmployeeTz(businessId, employeeId, employee) {
  const employment = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: {
      entity: { select: { timezone: true, countryCode: true } },
      location: { select: { timezone: true, countryCode: true } },
    },
  });
  const business = await prisma.business.findFirst({ where: { id: businessId }, select: { timezone: true } });
  return resolveTimezone(
    { countryCode: employee ? employee.countryCode : null },
    { location: employment ? employment.location : null, entity: employment ? employment.entity : null, business },
  );
}

// The @db.Date civil day a UTC instant belongs to, in the employee timezone (H5):
// an NZ 11:00 NZST punch (23:00 UTC prev day) must bucket to its LOCAL date, not
// the UTC date. `tz` is the resolved zone from resolveEmployeeTz.
function civilDayInTz(instant, tz) {
  return civilKeyToDate(civilDateInTz(instant, tz));
}

// True when the (employee, civil-day) lands on a LOCKED Attendance row — writes
// into a frozen/closed period must be rejected (409). `day` is already the
// employee-local civil @db.Date (resolved by the caller via the employee tz).
async function isDayLocked(businessId, employeeId, day) {
  const row = await prisma.attendance.findFirst({
    where: { businessId, employeeId, date: utcDay(day), isLocked: true },
    select: { id: true },
  });
  return !!row;
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
    // Feature 1: a punch for an out-of-scope employee is an IDOR target → 404.
    if (!scopeAllows(req.scope, employeeId)) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (locationId) {
      const loc = await prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null } });
      if (!loc) return res.status(400).json({ message: 'locationId does not belong to this business' });
    }

    const punchAt = req.body.punchAt ? new Date(req.body.punchAt) : new Date();
    // H5 — bucket the punch into the employee's LOCAL civil day (not the UTC day)
    // so the lock guard and recompute key off the correct date for IN/NZ punches.
    const tz = await resolveEmployeeTz(businessId, employeeId, emp);
    const localDay = civilDayInTz(punchAt, tz);
    // Period-lock guard: cannot punch into a frozen/closed day (409).
    if (await isDayLocked(businessId, employeeId, localDay)) {
      return res.status(409).json({ message: 'Attendance for this day is locked (period closed)' });
    }

    const data = {
      businessId,
      employeeId,
      punchType: type,
      source: punchSource,
      punchAt,
      locationId: locationId || null,
      // Decimal lat/lng — pass through, never parseInt.
      geoLat: req.body.geoLat != null ? req.body.geoLat : null,
      geoLng: req.body.geoLng != null ? req.body.geoLng : null,
      ipAddress: req.body.ipAddress || req.ip || null,
      deviceId: req.body.deviceId || null,
      selfieUrl: req.body.selfieUrl || null,
    };

    const punch = await prisma.attendancePunch.create({ data });
    // Re-derive the affected LOCAL civil day so the daily Attendance rollup stays
    // current (recompute keys @db.Date by the employee-local day — H5). recompute
    // also runs the Haversine geofence check and stamps punch.outOfGeofence when the
    // punch carries coords and the assigned Location has a geofence.
    await recompute(businessId, employeeId, localDay, localDay);
    // Re-read so the response carries the geofence marker the recompute just stamped.
    const stamped = await prisma.attendancePunch.findUnique({ where: { id: punch.id } });
    res.status(201).json(stamped || punch);
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Bulk punch import (CSV / biometric feed)                           */
/* ------------------------------------------------------------------ */

// POST /punches/import — array (or {rows:[...]}) of {employeeCode|employeeId,
// punchType, punchAt, source?}. All-or-nothing: validates every row first, builds
// an error report, and only on a fully clean batch inserts (deduped) + recomputes
// the affected (employee, day) pairs. canManageAttendance + scope.
async function importPunches(req, res, next) {
  try {
    const { businessId } = req.user;
    const rows = Array.isArray(req.body) ? req.body : (Array.isArray(req.body.rows) ? req.body.rows : null);
    if (!rows || rows.length === 0) {
      return res.status(400).json({ message: 'Body must be a non-empty array (or { rows: [...] }) of punch rows' });
    }
    if (rows.length > 5000) {
      return res.status(400).json({ message: 'Import is capped at 5000 rows per call' });
    }

    // Resolve employees by code or id once (tenant-scoped).
    const codes = [...new Set(rows.map((r) => r.employeeCode).filter(Boolean))];
    const ids = [...new Set(rows.map((r) => r.employeeId).filter(Boolean))];
    const employees = await prisma.employee.findMany({
      where: {
        businessId, deletedAt: null,
        OR: [
          codes.length ? { code: { in: codes } } : undefined,
          ids.length ? { id: { in: ids } } : undefined,
        ].filter(Boolean),
      },
      select: { id: true, code: true, countryCode: true },
    });
    const byCode = new Map(employees.map((e) => [e.code, e.id]));
    const byId = new Map(employees.map((e) => [e.id, e.id]));
    const empById = new Map(employees.map((e) => [e.id, e]));

    // H5 — resolve each in-scope employee's tz ONCE so punchAt buckets into the
    // correct LOCAL civil day (not the UTC day) for lock-check + recompute keys.
    const tzCache = new Map();
    const tzFor = async (employeeId) => {
      if (tzCache.has(employeeId)) return tzCache.get(employeeId);
      const t = await resolveEmployeeTz(businessId, employeeId, empById.get(employeeId));
      tzCache.set(employeeId, t);
      return t;
    };

    const errors = [];
    const valid = [];
    const seen = new Set(); // intra-batch dedupe key (employeeId|type|punchAt|source)
    const lockCheck = new Set(); // (employeeId|localDayKey) to verify not locked

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const rowErr = (message) => errors.push({ row: i, message });

      const employeeId = r.employeeId ? byId.get(r.employeeId) : (r.employeeCode ? byCode.get(r.employeeCode) : null);
      if (!employeeId) { rowErr('employee not found in this tenant (employeeId/employeeCode)'); continue; }
      if (!scopeAllows(req.scope, employeeId)) { rowErr('employee is out of scope'); continue; }
      if (!PUNCH_TYPES.includes(r.punchType)) { rowErr(`punchType must be one of ${PUNCH_TYPES.join(', ')}`); continue; }
      const source = r.source || 'IMPORT';
      if (!PUNCH_SOURCES.includes(source)) { rowErr(`source must be one of ${PUNCH_SOURCES.join(', ')}`); continue; }
      const punchAt = r.punchAt ? new Date(r.punchAt) : null;
      if (!punchAt || Number.isNaN(punchAt.getTime())) { rowErr('punchAt is not a parseable date'); continue; }

      const dedupeKey = `${employeeId}|${r.punchType}|${punchAt.toISOString()}|${source}`;
      if (seen.has(dedupeKey)) { rowErr('duplicate of another row in this batch'); continue; }
      seen.add(dedupeKey);

      const tz = await tzFor(employeeId);
      const localKey = civilDateInTz(punchAt, tz); // 'YYYY-MM-DD' local
      valid.push({ businessId, employeeId, punchType: r.punchType, source, punchAt, locationId: r.locationId || null, _dedupeKey: dedupeKey, _localKey: localKey });
      lockCheck.add(`${employeeId}|${localKey}`);
    }

    if (errors.length) {
      // All-or-nothing: reject the whole batch with the error report.
      return res.status(422).json({ message: 'Import rejected; fix the listed rows', errors, accepted: 0, rejected: rows.length });
    }

    // Reject the batch if any target day is locked (keyed by LOCAL civil day).
    const lockedHits = [];
    for (const k of lockCheck) {
      const [employeeId, dayKey] = k.split('|');
      if (await isDayLocked(businessId, employeeId, civilKeyToDate(dayKey))) lockedHits.push({ employeeId, date: dayKey });
    }
    if (lockedHits.length) {
      return res.status(409).json({ message: 'Some rows fall in a locked period', locked: lockedHits, accepted: 0, rejected: rows.length });
    }

    // Persist + recompute in one transaction (dedupe against existing rows).
    const affected = new Set();
    let inserted = 0;
    await prisma.$transaction(async (tx) => {
      for (const v of valid) {
        const existing = await tx.attendancePunch.findFirst({
          where: { businessId, employeeId: v.employeeId, punchType: v.punchType, punchAt: v.punchAt, source: v.source },
          select: { id: true },
        });
        if (existing) continue; // dedupe against the DB (idempotent re-import)
        await tx.attendancePunch.create({
          data: { businessId, employeeId: v.employeeId, punchType: v.punchType, source: v.source, punchAt: v.punchAt, locationId: v.locationId },
        });
        inserted += 1;
        affected.add(`${v.employeeId}|${v._localKey}`); // LOCAL civil day (H5)
      }
      for (const k of affected) {
        const [employeeId, dayKey] = k.split('|');
        const localDay = civilKeyToDate(dayKey);
        await recompute(businessId, employeeId, localDay, localDay, tx);
      }
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'attendance.punches.import',
      entityType: 'AttendancePunch', entityId: null,
      meta: { rows: rows.length, inserted, recomputedDays: affected.size },
    });

    res.status(201).json({ accepted: rows.length, inserted, recomputedDays: affected.size, errors: [] });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Summary (dashboard aggregate)                                       */
/* ------------------------------------------------------------------ */

// GET /summary?from=&to=&groupBy=status|date — counts of Attendance rows, scoped.
async function summary(req, res, next) {
  try {
    const { businessId } = req.user;
    const { from, to } = req.query;
    const groupBy = req.query.groupBy === 'date' ? 'date' : 'status';

    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = utcDay(from);
      if (to) where.date.lte = utcDay(to);
    }

    const grouped = await prisma.attendance.groupBy({
      by: [groupBy],
      where,
      _count: { _all: true },
      _sum: { lopFraction: true, overtimeMinutes: true },
    });

    const buckets = grouped.map((g) => ({
      key: groupBy === 'date' ? (g.date instanceof Date ? g.date.toISOString().slice(0, 10) : g.date) : g.status,
      count: g._count._all,
      lopDays: Number(g._sum.lopFraction || 0),
      overtimeMinutes: g._sum.overtimeMinutes || 0,
    }));
    const total = buckets.reduce((a, b) => a + b.count, 0);
    res.json({ groupBy, total, buckets });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Recompute (idempotent re-derivation)                                */
/* ------------------------------------------------------------------ */

// POST /recompute { employeeId? | all in scope, from, to } — canManageAttendance + scope.
async function recomputeRange(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, from, to } = req.body;
    if (!from || !to) return res.status(400).json({ message: 'from and to are required' });
    const fromD = new Date(from);
    const toD = new Date(to);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
      return res.status(400).json({ message: 'from and to must be valid dates' });
    }

    let targets;
    if (employeeId) {
      if (!scopeAllows(req.scope, employeeId)) return res.status(404).json({ message: 'Employee not found' });
      targets = [employeeId];
    } else {
      // All employees in scope. ALL band → every active employee in the tenant.
      const where = { businessId, deletedAt: null, ...scopeWhere(req.scope, 'id') };
      const emps = await prisma.employee.findMany({ where, select: { id: true } });
      targets = emps.map((e) => e.id);
    }

    const results = [];
    for (const id of targets) {
      results.push(await recompute(businessId, id, fromD, toD));
    }
    const written = results.reduce((a, r) => a + (r.written || 0), 0);
    res.json({ employees: targets.length, written, results });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Period close (bulk lock)                                            */
/* ------------------------------------------------------------------ */

// POST /period/close { from, to, entityId? } — set Attendance.isLocked for the
// scoped range. Blocks when pending regularizations or unsubmitted timesheets
// exist in the range (returns the blockers). canManageAttendance.
async function closePeriod(req, res, next) {
  try {
    const { businessId } = req.user;
    const { from, to, entityId } = req.body;
    if (!from || !to) return res.status(400).json({ message: 'from and to are required' });
    const fromD = utcDay(from);
    const toD = utcDay(to);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
      return res.status(400).json({ message: 'from and to must be valid dates' });
    }

    // Scope the affected employees: entity filter (via current EmploymentRecord) ∩ scope.
    let employeeIds = null;
    if (entityId) {
      const emps = await prisma.employmentRecord.findMany({
        where: { businessId, entityId, isCurrent: true }, select: { employeeId: true },
      });
      employeeIds = [...new Set(emps.map((e) => e.employeeId))];
    }
    const scopeFilter = scopeWhere(req.scope, 'employeeId');
    const empFilter = {};
    if (employeeIds) empFilter.employeeId = { in: employeeIds };

    // Blockers: pending regularizations in the date range.
    const pendingRegs = await prisma.attendanceRegularizationRequest.count({
      where: { businessId, status: 'PENDING', date: { gte: fromD, lte: toD }, ...scopeFilter, ...empFilter },
    });
    // Blockers: timesheets overlapping the range that are not yet SUBMITTED/APPROVED/LOCKED.
    const unsubmitted = await prisma.timesheet.count({
      where: {
        businessId, status: { in: ['DRAFT', 'REJECTED'] },
        periodStart: { lte: toD }, periodEnd: { gte: fromD },
        ...scopeFilter, ...empFilter,
      },
    });
    const blockers = { pendingRegularizations: pendingRegs, unsubmittedTimesheets: unsubmitted };
    const hasBlockers = pendingRegs > 0 || unsubmitted > 0;

    // Dry-run preview: the UI calls with confirm:false to surface blockers + the
    // would-lock count WITHOUT mutating. Only confirm:true actually locks the period.
    if (req.body.confirm !== true) {
      const wouldLock = await prisma.attendance.count({
        where: { businessId, date: { gte: fromD, lte: toD }, ...scopeFilter, ...empFilter },
      });
      return res.json({
        dryRun: true,
        from: fromD.toISOString().slice(0, 10),
        to: toD.toISOString().slice(0, 10),
        blockers,
        wouldLock,
        canClose: !hasBlockers,
      });
    }

    if (hasBlockers) {
      return res.status(409).json({ message: 'Cannot close period; resolve blockers first', blockers });
    }

    const locked = await prisma.attendance.updateMany({
      where: { businessId, date: { gte: fromD, lte: toD }, ...scopeFilter, ...empFilter },
      data: { isLocked: true },
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'attendance.period.close',
      entityType: 'Attendance', entityId: null,
      meta: { from: fromD.toISOString().slice(0, 10), to: toD.toISOString().slice(0, 10), entityId: entityId || null, locked: locked.count },
    });

    res.json({ from: fromD.toISOString().slice(0, 10), to: toD.toISOString().slice(0, 10), locked: locked.count });
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
      // Resolve the employee so the admin punch log renders a name, not a UUID (#17).
      prisma.attendancePunch.findMany({
        where,
        orderBy: { punchAt: 'desc' },
        skip,
        take,
        include: { employee: { select: { id: true, firstName: true, lastName: true, code: true } } },
      }),
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
    // Feature 1 scope (write path): a manager may only assign within their sub-tree.
    if (!scopeAllows(req.scope, employeeId)) return res.status(404).json({ message: 'Employee not found' });

    const from = utcDay(effectiveFrom);
    const to = effectiveTo ? utcDay(effectiveTo) : null;
    if (to && to.getTime() < from.getTime()) {
      return res.status(400).json({ message: 'effectiveTo must be on or after effectiveFrom' });
    }

    // Reject an assignment whose [effectiveFrom, effectiveTo] window overlaps an
    // existing assignment for the same employee. Open-ended (null effectiveTo)
    // windows are treated as extending to +infinity. Overlap iff
    // existing.from <= new.to (or new open) AND new.from <= existing.to (or existing open).
    const existing = await prisma.shiftAssignment.findMany({
      where: { businessId, employeeId },
      select: { id: true, effectiveFrom: true, effectiveTo: true },
    });
    const overlaps = existing.some((a) => {
      const aFrom = utcDay(a.effectiveFrom).getTime();
      const aTo = a.effectiveTo ? utcDay(a.effectiveTo).getTime() : Infinity;
      const nFrom = from.getTime();
      const nTo = to ? to.getTime() : Infinity;
      return aFrom <= nTo && nFrom <= aTo;
    });
    if (overlaps) {
      return res.status(409).json({ message: 'Assignment overlaps an existing effective-dated assignment for this employee' });
    }

    const assignment = await prisma.shiftAssignment.create({
      data: {
        businessId,
        employeeId,
        shiftPatternId,
        effectiveFrom: from,
        effectiveTo: to,
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
    // Feature 1 scope (write path): out-of-sub-tree target → 404 (IDOR-safe).
    if (!scopeAllows(req.scope, existing.employeeId)) return res.status(404).json({ message: 'Assignment not found' });
    await prisma.shiftAssignment.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Timesheets (producer + read + state transitions)                   */
/* ------------------------------------------------------------------ */

// Worked/overtime minutes on the Attendance rollup are Ints; Timesheet/Entry hours
// are Decimal(.,2). Convert to a 2-dp hours number (Prisma accepts a JS number for
// a Decimal column). null/undefined minutes → 0.
function minutesToHours(min) {
  const n = Number(min || 0);
  return Math.round((n / 60) * 100) / 100;
}

// Presence statuses whose worked minutes count as a timesheet day-entry. ABSENT /
// ON_LEAVE / WEEKLY_OFF / HOLIDAY contribute no hours (no entry row written) but the
// employee still gets a (possibly empty) DRAFT timesheet for the period.
const TIMESHEET_PRESENT_STATUSES = new Set([
  'PRESENT', 'HALF_DAY', 'WORK_FROM_HOME', 'ON_DUTY', 'HOLIDAY_WORKED', 'MISSING_PUNCH',
]);

// POST /timesheets/generate { periodStart, periodEnd, employeeId? } —
// admin-TRIGGERED (NOT a cron) producer that materializes DRAFT Timesheets for the
// period from the existing Attendance rollup. Idempotent: an employee that already
// has a Timesheet for (businessId, periodStart) is skipped (the @@unique key). For
// each in-scope employee with Attendance rows in [periodStart, periodEnd] we sum
// worked/overtime minutes → hours, write one DRAFT Timesheet + a TimesheetEntry per
// present day. Tenant-walled by businessId and filtered to req.scope; gated on
// canManageAttendance by the route. canManageAttendance.
async function generateTimesheets(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.body;
    if (!req.body.periodStart || !req.body.periodEnd) {
      return res.status(400).json({ message: 'periodStart and periodEnd are required' });
    }
    const periodStart = utcDay(req.body.periodStart);
    const periodEnd = utcDay(req.body.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      return res.status(400).json({ message: 'periodStart and periodEnd must be valid dates' });
    }
    if (periodEnd.getTime() < periodStart.getTime()) {
      return res.status(400).json({ message: 'periodEnd must be on or after periodStart' });
    }

    // Resolve the in-scope target employees (mirrors recomputeRange): a single
    // client-supplied employeeId is only honored when in scope (→ 404 if not);
    // otherwise every employee in the actor's sub-tree.
    let targets;
    if (employeeId) {
      if (!scopeAllows(req.scope, employeeId)) return res.status(404).json({ message: 'Employee not found' });
      targets = [employeeId];
    } else {
      const where = { businessId, deletedAt: null, ...scopeWhere(req.scope, 'id') };
      const emps = await prisma.employee.findMany({ where, select: { id: true } });
      targets = emps.map((e) => e.id);
    }

    let created = 0;
    let skipped = 0;
    let entriesWritten = 0;
    const createdIds = [];

    for (const empId of targets) {
      // Idempotency: skip an employee that already has a timesheet for this period
      // start (matches the @@unique([businessId, employeeId, periodStart])).
      const existing = await prisma.timesheet.findFirst({
        where: { businessId, employeeId: empId, periodStart },
        select: { id: true },
      });
      if (existing) { skipped += 1; continue; }

      // Pull the daily Attendance rollup for the period (tenant- + employee-scoped).
      const days = await prisma.attendance.findMany({
        where: { businessId, employeeId: empId, date: { gte: periodStart, lte: periodEnd } },
        select: { date: true, status: true, workedMinutes: true, overtimeMinutes: true },
        orderBy: { date: 'asc' },
      });
      // No attendance recorded for this employee in the period → nothing to produce
      // (don't create empty shells for people with zero rows).
      if (days.length === 0) { skipped += 1; continue; }

      const entries = [];
      let totalHours = 0;
      let overtimeHours = 0;
      for (const d of days) {
        const hrs = minutesToHours(d.workedMinutes);
        const ot = minutesToHours(d.overtimeMinutes);
        totalHours += hrs;
        overtimeHours += ot;
        // Only days with worked time (present-ish) become entry rows; absence/leave
        // days are reflected in the rollup but carry no billable timesheet line.
        if (hrs > 0 && TIMESHEET_PRESENT_STATUSES.has(String(d.status))) {
          entries.push({
            businessId,
            date: utcDay(d.date),
            hours: hrs,
            isOvertime: ot > 0,
            isBillable: false,
            notes: null,
          });
        }
      }
      totalHours = Math.round(totalHours * 100) / 100;
      overtimeHours = Math.round(overtimeHours * 100) / 100;

      // Create the DRAFT timesheet + its entries in one transaction. The @@unique
      // makes a concurrent double-generate fail with P2002 → treat as a skip.
      try {
        const ts = await prisma.timesheet.create({
          data: {
            businessId,
            employeeId: empId,
            periodStart,
            periodEnd,
            status: 'DRAFT',
            totalHours,
            overtimeHours,
            billableHours: 0,
            entries: entries.length ? { create: entries } : undefined,
          },
          select: { id: true },
        });
        created += 1;
        entriesWritten += entries.length;
        createdIds.push(ts.id);
      } catch (e) {
        if (e.code === 'P2002') { skipped += 1; continue; } // raced — already exists
        throw e;
      }
    }

    await writeAudit({
      businessId, actorId: req.user.id, action: 'attendance.timesheets.generate',
      entityType: 'Timesheet', entityId: null,
      meta: {
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
        employees: targets.length, created, skipped, entriesWritten,
      },
    });

    res.status(201).json({
      periodStart: periodStart.toISOString().slice(0, 10),
      periodEnd: periodEnd.toISOString().slice(0, 10),
      employees: targets.length,
      created,
      skipped,
      entriesWritten,
      createdIds,
    });
  } catch (e) { next(e); }
}

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
      // Resolve the employee so the approval queue renders a name, not a UUID (#17).
      prisma.timesheet.findMany({
        where,
        orderBy: { periodStart: 'desc' },
        skip,
        take,
        include: { employee: { select: { id: true, firstName: true, lastName: true, code: true } } },
      }),
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

    // SUBMIT is a self/manager action: the owning employee may submit their own
    // timesheet, or anyone whose scope covers the owner (manager/HR). Other
    // transitions (approve/reject/lock) are management-gated by the route and only
    // need the scope-covers check. When req.scope is absent (route didn't attach
    // it — pure management path) the route's permission gate already authorised it.
    if (req.scope) {
      const isSelf = req.user.employeeId && req.user.employeeId === ts.employeeId;
      if (!isSelf && !scopeAllows(req.scope, ts.employeeId)) {
        return res.status(404).json({ message: 'Timesheet not found' });
      }
    }

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

    // H1 — IDOR fix: scope to the actor's reporting sub-tree (employeeId-keyed).
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (payRunId) where.payRunId = payRunId;
    // A client-supplied employeeId is only honored when it is in scope; an
    // out-of-scope/forged id yields an empty page (mirrors listPunches).
    if (employeeId) {
      if (!scopeAllows(req.scope, employeeId)) {
        return res.json({ items: [], total: 0, page, pageSize: take });
      }
      where.employeeId = employeeId;
    }

    const [items, total] = await Promise.all([
      prisma.attendancePayInput.findMany({ where, orderBy: { frozenAt: 'desc' }, skip, take }),
      prisma.attendancePayInput.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Regularization — AttendanceRegularizationRequest (real model)       */
/* ------------------------------------------------------------------ */

const REGULARIZATION_KINDS = ['MISSED_PUNCH', 'LATE_WAIVER', 'EARLY_OUT_WAIVER', 'WFH', 'ON_DUTY'];

// POST /regularizations — self/manager raises a correction request → PENDING +
// routed to an approver. Body: { employeeId, date, kind?, requestedInAt?,
// requestedOutAt?, reason }. Self-create allowed: an employee may raise their own
// request (employeeId defaults to the caller's own employee). A manager may raise
// for an in-scope report; out-of-scope → 404.
async function createRegularization(req, res, next) {
  try {
    const { businessId } = req.user;
    const employeeId = req.body.employeeId || req.user.employeeId;
    const { date, requestedInAt, requestedOutAt } = req.body;
    const kind = req.body.kind || 'MISSED_PUNCH';
    const reason = req.body.reason;

    if (!employeeId) return res.status(400).json({ message: 'employeeId is required (or link the caller to an employee)' });
    if (!date) return res.status(400).json({ message: 'date is required' });
    if (!REGULARIZATION_KINDS.includes(kind)) {
      return res.status(400).json({ message: `kind must be one of ${REGULARIZATION_KINDS.join(', ')}` });
    }
    if (!reason) return res.status(400).json({ message: 'reason is required' });

    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });
    // Self is always allowed; otherwise the target must be in scope (→ 404 if not).
    const isSelf = req.user.employeeId && req.user.employeeId === employeeId;
    if (!isSelf && !scopeAllows(req.scope, employeeId)) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const d = utcDay(date);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'date is not a valid YYYY-MM-DD' });
    // Cannot raise a correction for a locked (closed) day.
    if (await isDayLocked(businessId, employeeId, d)) {
      return res.status(409).json({ message: 'Attendance for this day is locked (period closed)' });
    }

    // Route to an approver (manager → escalate → HR-Admin fallback). Stored as a
    // hint on approvalRequestId; the actual decide path re-checks scope.
    const approver = await resolveApprover(emp);

    const reqRow = await prisma.attendanceRegularizationRequest.create({
      data: {
        businessId,
        employeeId,
        date: d,
        kind,
        requestedInAt: requestedInAt ? new Date(requestedInAt) : null,
        requestedOutAt: requestedOutAt ? new Date(requestedOutAt) : null,
        reason,
        status: 'PENDING',
        approvalRequestId: approver && approver.employeeId ? approver.employeeId : (approver && approver.userId ? approver.userId : null),
      },
    });
    res.status(201).json({ ...reqRow, routing: approver });
  } catch (e) { next(e); }
}

// GET /regularizations?employeeId=&status=[&page=&pageSize=] — scoped read.
// Backward-compatible pagination: with NO page/pageSize the response is the
// historical shape `{ items }` (capped at 200 rows as before). When the caller
// passes page/pageSize it switches to the standard `{ items, total, page,
// pageSize }` envelope with a scoped LIMIT/OFFSET + a scoped COUNT. The F1
// scope filter (scopeWhere) is applied to BOTH the page query and the count.
async function listRegularizations(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, status } = req.query;
    const paged = req.query.page !== undefined || req.query.pageSize !== undefined;
    const { take, skip, page } = clampPage(req.query);
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (employeeId) {
      if (!scopeAllows(req.scope, employeeId)) {
        return res.json(paged ? { items: [], total: 0, page, pageSize: take } : { items: [] });
      }
      where.employeeId = employeeId;
    }
    if (status) where.status = status;
    const findArgs = {
      where,
      orderBy: { date: 'desc' },
      // Resolve the employee so the list renders a name, not a UUID (#17).
      include: { employee: { select: { id: true, firstName: true, lastName: true, code: true } } },
    };
    let total = null;
    if (paged) {
      findArgs.skip = skip;
      findArgs.take = take;
      total = await prisma.attendanceRegularizationRequest.count({ where });
    } else {
      findArgs.take = 200; // unchanged legacy hard cap for no-params callers
    }
    const rows = await prisma.attendanceRegularizationRequest.findMany(findArgs);

    // `decidedBy` is a User id (no Prisma relation on this model), so resolve the
    // decider's display name in one batched lookup and surface it as decidedByName
    // — the admin "Decided by" column shows a person, not a raw user id (#19).
    const deciderIds = [...new Set(rows.map((r) => r.decidedBy).filter(Boolean))];
    const deciderById = new Map();
    if (deciderIds.length) {
      const users = await prisma.user.findMany({
        where: { id: { in: deciderIds } },
        select: { id: true, name: true, email: true },
      });
      for (const u of users) deciderById.set(u.id, u.name || u.email || null);
    }
    const items = rows.map((r) => ({
      ...r,
      decidedByName: r.decidedBy ? (deciderById.get(r.decidedBy) || null) : null,
    }));

    res.json(paged ? { items, total, page, pageSize: take } : { items });
  } catch (e) { next(e); }
}

// POST /regularizations/:id/approve — APPROVED + decidedBy/At; MATERIALIZE the
// manual IN/OUT punches from requestedInAt/Out, then re-derive the affected day.
// POST /regularizations/:id/reject  — REJECTED + decidedBy/At (no hard-delete).
async function decideRegularization(req, res, next, decision) {
  try {
    const { businessId } = req.user;
    const id = req.params.id;

    const reqRow = await prisma.attendanceRegularizationRequest.findFirst({ where: { id, businessId } });
    if (!reqRow) return res.status(404).json({ message: 'Regularization request not found' });
    // H2 (SoD) — a filer can NEVER approve/reject their OWN request, even with an
    // ALL-band scope (HR admin). The scope already excludes self for narrow bands;
    // this explicit guard closes the ALL-band self-approval hole. Materializing a
    // self-filed request would inflate the filer's own pay.
    if (req.user.employeeId && req.user.employeeId === reqRow.employeeId) {
      return res.status(404).json({ message: 'Regularization request not found' });
    }
    // Out-of-scope target employee → 404 (the :id is a request id, so the per-target
    // check lives here rather than the middleware idParam guard).
    if (!scopeAllows(req.scope, reqRow.employeeId)) {
      return res.status(404).json({ message: 'Regularization request not found' });
    }
    if (reqRow.status !== 'PENDING') {
      return res.status(409).json({ message: `Request is already ${reqRow.status}` });
    }

    if (decision === 'REJECTED') {
      const updated = await prisma.attendanceRegularizationRequest.update({
        where: { id },
        data: { status: 'REJECTED', decidedBy: req.user.id || null, decidedAt: new Date() },
      });
      await writeAudit({
        businessId, actorId: req.user.id, action: 'attendance.regularization.reject',
        entityType: 'AttendanceRegularizationRequest', entityId: id,
        meta: { employeeId: reqRow.employeeId, kind: reqRow.kind },
      });
      return res.json(updated);
    }

    // APPROVED: materialize manual punches from the requested in/out, then recompute.
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.attendanceRegularizationRequest.update({
        where: { id },
        data: { status: 'APPROVED', decidedBy: req.user.id || null, decidedAt: new Date() },
      });

      // Only punch-bearing kinds materialize IN/OUT rows. WFH/ON_DUTY are presence
      // markers consumed directly by derive (no punches needed); LATE/EARLY waivers
      // are advisory. MISSED_PUNCH (default) writes the corrected punches.
      const punches = [];
      if (reqRow.kind === 'MISSED_PUNCH' || reqRow.requestedInAt || reqRow.requestedOutAt) {
        if (reqRow.requestedInAt) {
          punches.push({ businessId, employeeId: reqRow.employeeId, punchType: 'IN', source: 'MANUAL', punchAt: reqRow.requestedInAt, isManual: false, regularizationRequestId: id });
        }
        if (reqRow.requestedOutAt) {
          punches.push({ businessId, employeeId: reqRow.employeeId, punchType: 'OUT', source: 'MANUAL', punchAt: reqRow.requestedOutAt, isManual: false, regularizationRequestId: id });
        }
      }
      for (const p of punches) {
        // Dedupe: don't double-materialize on a re-approve race.
        const existing = await tx.attendancePunch.findFirst({
          where: { businessId, employeeId: p.employeeId, punchType: p.punchType, punchAt: p.punchAt, regularizationRequestId: id },
          select: { id: true },
        });
        if (!existing) await tx.attendancePunch.create({ data: p });
      }
      // Re-derive the affected civil day inside the same transaction.
      await recompute(businessId, reqRow.employeeId, reqRow.date, reqRow.date, tx);
      return row;
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'attendance.regularization.approve',
      entityType: 'AttendanceRegularizationRequest', entityId: id,
      meta: { employeeId: reqRow.employeeId, kind: reqRow.kind, date: utcDay(reqRow.date).toISOString().slice(0, 10) },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

const approveRegularization = (req, res, next) => decideRegularization(req, res, next, 'APPROVED');
const rejectRegularization = (req, res, next) => decideRegularization(req, res, next, 'REJECTED');

module.exports = {
  // punches
  createPunch, listPunches, importPunches,
  // derivation / dashboard / period
  summary, recomputeRange, closePeriod,
  // shifts
  listShifts, getShift, createShift, updateShift, removeShift,
  // assignments
  assignShift, listAssignments, removeAssignment,
  // timesheets
  generateTimesheets, listTimesheets, getTimesheet, submitTimesheet, approveTimesheet, rejectTimesheet, lockTimesheet,
  // payroll feed (read only)
  listPayInputs,
  // regularization
  createRegularization, listRegularizations, approveRegularization, rejectRegularization,
};

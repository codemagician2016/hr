'use strict';

/**
 * meAttendance.controller.js — Employee Self-Service (ESS) attendance API,
 * mounted at /api/hr/me/attendance. CUSTOMER session (req.customer); the subject
 * employee is resolved ENTIRELY from the session (workEmail/personalEmail/linked
 * User), so there is NO `:employeeId` (or any other employee id) accepted from
 * the client — a cross-employee read/write is structurally impossible (SELF_ONLY).
 *
 * The ESS attendance page was previously pointed at the operator surface
 * (/api/hr/attendance/*), which is operator-JWT-only and 401s for a customer
 * session (audit #53/#55). This surface authenticates the customer session and
 * derives employeeId SERVER-SIDE for every read and every write (punch / timesheet
 * submit / correction), so a forged or foreign employeeId can never land on the
 * wrong person's record.
 *
 * Terminated/inactive employees are locked out (404) — the same ESS lockout the
 * rest of the /me/* surface applies.
 *
 * Punch derivation (recompute), the period-lock guard and the employee-timezone
 * civil-day bucketing mirror the operator attendance controller so the ESS and
 * operator paths agree on every rule.
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');
const { recompute } = require('../attendance/service');
const { resolveTimezone, civilDateInTz } = require('../attendance/tz');
const { resolveApprover } = require('../lib/approvalRouting');

const PUNCH_TYPES = ['IN', 'OUT', 'BREAK_START', 'BREAK_END'];
// Mirror the RegularizationKind enum in prisma/schema.prisma exactly — writing a
// value outside this set makes Prisma 500; we reject with a 400 instead.
const REGULARIZATION_KINDS = ['MISSED_PUNCH', 'LATE_WAIVER', 'EARLY_OUT_WAIVER', 'WFH', 'ON_DUTY'];

// ── self-employee bridge ─────────────────────────────────────────────────────
// Resolve the signed-in customer to their ACTIVE Employee. Returns the employee
// row or null. Terminated/soft-deleted/inactive → null (ESS lockout). Every
// handler below funnels through this — the employee id is NEVER taken from input.
async function resolveActiveSelf(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, countryCode: true, isActive: true },
  });
  if (!emp || emp.isActive === false) return null;
  return emp;
}

function clampPage(query) {
  const take = Math.min(Math.max(parseInt(query.pageSize, 10) || 50, 1), 200);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

function utcDay(value) {
  const t = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
function civilKeyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) return utcDay(new Date(key));
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

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
function civilDayInTz(instant, tz) {
  return civilKeyToDate(civilDateInTz(instant, tz));
}
async function isDayLocked(businessId, employeeId, day) {
  const row = await prisma.attendance.findFirst({
    where: { businessId, employeeId, date: utcDay(day), isLocked: true },
    select: { id: true },
  });
  return !!row;
}

const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// ── POST /me/attendance/punch — clock IN/OUT/BREAK (self only) ────────────────
// employeeId is derived from the session; the body carries ONLY { type, punchAt? }.
async function createPunch(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const { type } = req.body || {};
    if (!PUNCH_TYPES.includes(type)) {
      return res.status(400).json({ message: `type must be one of ${PUNCH_TYPES.join(', ')}` });
    }
    const punchAt = req.body && req.body.punchAt ? new Date(req.body.punchAt) : new Date();
    if (Number.isNaN(punchAt.getTime())) return res.status(400).json({ message: 'punchAt is not a valid date' });

    const tz = await resolveEmployeeTz(businessId, emp.id, emp);
    const localDay = civilDayInTz(punchAt, tz);
    if (await isDayLocked(businessId, emp.id, localDay)) {
      return res.status(409).json({ message: 'Attendance for this day is locked (period closed)' });
    }

    const punch = await prisma.attendancePunch.create({
      data: {
        businessId,
        employeeId: emp.id,
        punchType: type,
        source: 'WEB', // ESS self-punch — never trust a client-supplied source.
        punchAt,
        ipAddress: req.ip || null,
      },
    });
    await recompute(businessId, emp.id, localDay, localDay);
    res.status(201).json(punch);
  } catch (e) { next(e); }
}

// ── GET /me/attendance/punches?from=&to= — own punches ────────────────────────
async function listPunches(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [], total: 0, page: 1, pageSize: 50 });
    const { businessId } = req.customer;
    const { from, to } = req.query;
    const { take, skip, page } = clampPage(req.query);

    const where = { businessId, employeeId: emp.id };
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

// ── GET /me/attendance/summary?from=&to= — own daily rollup buckets ───────────
async function summary(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ groupBy: 'status', total: 0, buckets: [] });
    const { businessId } = req.customer;
    const { from, to } = req.query;
    const where = { businessId, employeeId: emp.id };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = utcDay(from);
      if (to) where.date.lte = utcDay(to);
    }
    const grouped = await prisma.attendance.groupBy({
      by: ['status'], where, _count: { _all: true }, _sum: { lopFraction: true, overtimeMinutes: true },
    });
    const buckets = grouped.map((g) => ({
      key: g.status,
      count: g._count._all,
      lopDays: Number(g._sum.lopFraction || 0),
      overtimeMinutes: g._sum.overtimeMinutes || 0,
    }));
    res.json({ groupBy: 'status', total: buckets.reduce((a, b) => a + b.count, 0), buckets });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/timesheets — own timesheets ────────────────────────────
async function listTimesheets(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [], total: 0 });
    const { businessId } = req.customer;
    const where = { businessId, employeeId: emp.id };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.timesheet.findMany({
      where, orderBy: { periodStart: 'desc' }, take: 100,
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/timesheets/:id — own timesheet detail (+ day entries) ──
async function getTimesheet(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.status(404).json({ message: 'Timesheet not found' });
    const { businessId } = req.customer;
    // SELF_ONLY: a timesheet whose employeeId ≠ self resolves to 404 (IDOR-safe).
    const ts = await prisma.timesheet.findFirst({
      where: { id: req.params.id, businessId, employeeId: emp.id },
      include: { entries: { orderBy: { date: 'asc' } } },
    });
    if (!ts) return res.status(404).json({ message: 'Timesheet not found' });
    res.json(ts);
  } catch (e) { next(e); }
}

// ── POST /me/attendance/timesheets/:id/submit — submit own DRAFT timesheet ────
async function submitTimesheet(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.status(404).json({ message: 'Timesheet not found' });
    const { businessId } = req.customer;
    const ts = await prisma.timesheet.findFirst({
      where: { id: req.params.id, businessId, employeeId: emp.id },
    });
    if (!ts) return res.status(404).json({ message: 'Timesheet not found' });
    if (ts.status !== 'DRAFT' && ts.status !== 'REJECTED') {
      return res.status(409).json({ message: `Cannot submit a timesheet in status ${ts.status}` });
    }
    const updated = await prisma.timesheet.update({
      where: { id: ts.id },
      data: { status: 'SUBMITTED', submittedAt: new Date(), version: { increment: 1 } },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// ── GET /me/attendance/regularizations — own correction requests ──────────────
async function listRegularizations(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [] });
    const { businessId } = req.customer;
    const where = { businessId, employeeId: emp.id };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.attendanceRegularizationRequest.findMany({
      where, orderBy: { date: 'desc' }, take: 200,
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// ── POST /me/attendance/regularizations — raise own correction request ────────
// employeeId is the session's; the body carries date/kind/reason/times only.
async function createRegularization(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const { date, requestedInAt, requestedOutAt, reason } = req.body || {};
    const kind = (req.body && req.body.kind) || 'MISSED_PUNCH';
    if (!date) return res.status(400).json({ message: 'date is required' });
    if (!REGULARIZATION_KINDS.includes(kind)) {
      return res.status(400).json({ message: `kind must be one of ${REGULARIZATION_KINDS.join(', ')}` });
    }
    if (!reason) return res.status(400).json({ message: 'reason is required' });

    const d = utcDay(date);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'date is not a valid YYYY-MM-DD' });
    if (await isDayLocked(businessId, emp.id, d)) {
      return res.status(409).json({ message: 'Attendance for this day is locked (period closed)' });
    }

    // Full employee row for approver routing (manager → escalate → HR fallback).
    const fullEmp = await prisma.employee.findFirst({ where: { id: emp.id, businessId, deletedAt: null } });
    const approver = await resolveApprover(fullEmp);

    const reqRow = await prisma.attendanceRegularizationRequest.create({
      data: {
        businessId,
        employeeId: emp.id,
        date: d,
        kind,
        requestedInAt: requestedInAt ? new Date(requestedInAt) : null,
        requestedOutAt: requestedOutAt ? new Date(requestedOutAt) : null,
        reason,
        status: 'PENDING',
        approvalRequestId: approver && approver.employeeId ? approver.employeeId
          : (approver && approver.userId ? approver.userId : null),
      },
    });
    res.status(201).json(reqRow);
  } catch (e) { next(e); }
}

// ── GET /me/attendance/schedule — own current shift assignment + pattern ──────
async function getSchedule(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ shift: null, assignment: null });
    const { businessId } = req.customer;
    const today = utcDay(new Date());
    const assignment = await prisma.shiftAssignment.findFirst({
      where: {
        businessId, employeeId: emp.id,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      include: { shiftPattern: true },
    });
    if (!assignment) return res.json({ shift: null, assignment: null });
    const { shiftPattern, ...assignmentRow } = assignment;
    res.json({ shift: shiftPattern || null, assignment: assignmentRow });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/holidays?year= — own market's holiday calendar ─────────
// countryCode is RESOLVED server-side from the employee (never client-supplied).
async function listHolidays(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [], countryCode: null });
    const { businessId } = req.customer;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    // Resolve the employee's operating country (employee row → current entity).
    let countryCode = (emp.countryCode || '').toUpperCase() || null;
    if (!countryCode) {
      const rec = await prisma.employmentRecord.findFirst({
        where: { businessId, employeeId: emp.id, isCurrent: true },
        select: { entity: { select: { countryCode: true } } },
      });
      countryCode = rec && rec.entity && rec.entity.countryCode ? rec.entity.countryCode.toUpperCase() : null;
    }
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const where = { businessId, date: { gte: yearStart, lte: yearEnd } };
    if (countryCode) where.countryCode = countryCode;
    const rows = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });
    // Normalize to the shape the ESS schedule page expects (observedDate alias).
    const items = rows.map((h) => ({ ...h, observedDate: h.date }));
    res.json({ items, countryCode });
  } catch (e) { next(e); }
}

module.exports = {
  createPunch,
  listPunches,
  summary,
  listTimesheets,
  getTimesheet,
  submitTimesheet,
  listRegularizations,
  createRegularization,
  getSchedule,
  listHolidays,
};

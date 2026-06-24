'use strict';

/*
 * sources.js — the FROZEN-source Prisma loaders for the statutory registers
 * (Feature 32). This is the ONLY DB-touching module in the feature; the projector
 * + exporters are pure and consume what these return.
 *
 * Every loader:
 *   - is businessId-scoped (tenant isolation) and entityId-scoped;
 *   - applies the F1 employee data-scope (scopeWhere on the actor's sub-tree);
 *   - GATES on frozen state and returns { frozen:false, code, reason } when the
 *     source isn't locked — it NEVER recomputes to fill a gap (the cardinal
 *     invariant). A frozen source returns { frozen:true, workers:[...], ... }.
 *
 * Frozen preconditions:
 *   - WAGE / OVERTIME / FINES / ESI register → the PayRun for (entity, period)
 *     must be at status ∈ {LOCKED, APPROVED, PAID, FILED} (terminal/locked), and
 *     its PayRunLine + PayRunLineComponent snapshot is read straight through.
 *   - MUSTER register → the attendance freeze must have run: the AttendancePayInput
 *     rollup must exist for that pay run (it is written by freeze.js at freeze).
 *   - LEAVE register → the LeaveBalance/LeaveTransaction ledger for the period.
 *   - EMPLOYEE register → an as-of snapshot (no freeze precondition).
 *   - PF_ANNUAL → 12 monthly LOCKED+ PayRuns rolled per member.
 */

const prisma = require('../../core/lib/prisma');
const { scopeWhere } = require('../lib/scopeResolver');

// PayRun statuses at which the snapshot is immutable (the register reads these).
const FROZEN_PAYRUN_STATUSES = Object.freeze(['LOCKED', 'APPROVED', 'PAID', 'FILED']);

const STATUTORY_SELECT = {
  uan: true, pan: true, pfMemberId: true, esicIp: true,
  ptStateCode: true, lwfStateCode: true,
};
const EMPLOYEE_SELECT = {
  id: true, code: true, firstName: true, middleName: true, lastName: true,
  fatherName: true, dateOfBirth: true, gender: true, hireDate: true,
  terminationDate: true, addressLine1: true, addressLine2: true, city: true,
  stateCode: true,
};

// ── period parsing ────────────────────────────────────────────────────────────

/** "2026-05" → { year:2026, month:5, start:Date, end:Date }. */
function parseMonthPeriod(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || '').trim());
  if (!m) {
    const e = new Error(`Invalid period "${period}" — expected "YYYY-MM"`);
    e.code = 'BAD_PERIOD';
    throw e;
  }
  const year = +m[1];
  const month = +m[2];
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { year, month, start, end };
}

/** "2025-26" (Indian FY) → { fyStart, start, end }. */
function parseFyPeriod(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || '').trim());
  if (!m || +m[2] <= 12) {
    const e = new Error(`Invalid FY "${period}" — expected "YYYY-YY" e.g. "2025-26"`);
    e.code = 'BAD_PERIOD';
    throw e;
  }
  const fyStart = +m[1];
  return {
    fyStart,
    start: new Date(Date.UTC(fyStart, 3, 1)), // 1 Apr
    end: new Date(Date.UTC(fyStart + 1, 2, 31)), // 31 Mar
  };
}

// ── employee header enrichment (designation, statutory IDs) ───────────────────

function attachDesignation(employee, employmentRecords) {
  const rec = employmentRecords && employmentRecords[0];
  const designation = rec && rec.designation ? rec.designation.title : null;
  return { ...employee, designation };
}

// ── locate the frozen pay run for an (entity, period) ─────────────────────────

async function findFrozenPayRun(businessId, entityId, period) {
  const { start } = parseMonthPeriod(period);
  // The pay run whose periodStart falls in the requested month (REGULAR type wins).
  const runs = await prisma.payRun.findMany({
    where: {
      businessId,
      entityId,
      deletedAt: null,
      periodStart: { gte: start, lte: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)) },
    },
    select: { id: true, code: true, status: true, periodStart: true, periodEnd: true, type: true, currencyCode: true },
    orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
  });
  if (!runs.length) return { run: null, frozen: false, code: 'NO_RUN', reason: `No pay run found for ${period}.` };
  const frozen = runs.find((r) => FROZEN_PAYRUN_STATUSES.includes(r.status));
  if (!frozen) {
    return {
      run: runs[0],
      frozen: false,
      code: 'NOT_FROZEN',
      reason: `The pay run for ${period} is ${runs[0].status} — lock the run to generate this statutory register.`,
    };
  }
  return { run: frozen, frozen: true };
}

// ── entity header (establishment title block) ─────────────────────────────────

async function loadEntityHeader(businessId, entityId) {
  const entity = await prisma.entity.findFirst({
    where: { id: entityId, businessId },
    select: {
      id: true, code: true, legalName: true, tradeName: true, countryCode: true,
      addressLine1: true, addressLine2: true, city: true, stateCode: true,
      postalCode: true, pan: true, tan: true, payCurrency: true,
    },
  });
  return entity;
}

// ── PAYRUN bundle (wage / overtime / fines / ESI registers) ───────────────────

async function loadPayrunBundle({ businessId, entityId, period, scope }) {
  const found = await findFrozenPayRun(businessId, entityId, period);
  if (!found.frozen) return { frozen: false, code: found.code, reason: found.reason };
  const run = found.run;

  const lines = await prisma.payRunLine.findMany({
    where: { businessId, payRunId: run.id, ...scopeWhere(scope, 'employeeId') },
    select: {
      id: true, employeeId: true, payableDays: true, lopDays: true, lwpDays: true,
      overtimeHours: true, grossEarnings: true, totalDeductions: true, netPay: true,
      pfEmployee: true, pfEmployer: true, esiEmployee: true, esiEmployer: true,
      pt: true, lwfEmployee: true, lwfEmployer: true, tds: true,
      pfWagesBase: true, epsWagesBase: true, edliWagesBase: true,
      employee: {
        select: {
          ...EMPLOYEE_SELECT,
          statutoryProfile: { select: STATUTORY_SELECT },
          employmentRecords: {
            where: { isCurrent: true },
            select: { designation: { select: { title: true } } },
            take: 1,
          },
        },
      },
      components: {
        select: { componentCode: true, componentName: true, category: true, amount: true, isStatutory: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { employee: { code: 'asc' } },
  });

  // Also pull the AttendancePayInput rollup per employee (combined / OT registers
  // read the attendance summary alongside the wage line) — frozen at freeze.
  const apInputs = await prisma.attendancePayInput.findMany({
    where: { businessId, payRunId: run.id, ...scopeWhere(scope, 'employeeId') },
    select: {
      employeeId: true, calendarDays: true, payableDays: true, lopDays: true,
      lwpDays: true, absentDays: true, paidLeaveDays: true, weeklyOffDays: true,
      holidayDays: true, overtimeHours: true,
    },
  });
  const summaryByEmp = new Map(apInputs.map((a) => [a.employeeId, a]));

  const workers = lines.map((l) => {
    const emp = attachDesignation(l.employee, l.employee.employmentRecords);
    delete emp.employmentRecords;
    const statutory = l.employee.statutoryProfile || {};
    const line = { ...l };
    delete line.employee;
    delete line.components;
    return {
      employee: emp,
      statutory,
      line,
      components: l.components || [],
      summary: summaryByEmp.get(l.employeeId) || null,
    };
  });

  return {
    frozen: true,
    payRun: { id: run.id, code: run.code, status: run.status, currencyCode: run.currencyCode },
    workers,
    sourceRefs: { payRunIds: [run.id], attendanceFrozen: apInputs.length > 0 },
    period: { year: parseMonthPeriod(period).year, month: parseMonthPeriod(period).month },
  };
}

// ── ATTENDANCE bundle (muster roll) ───────────────────────────────────────────

async function loadAttendanceBundle({ businessId, entityId, period, scope }) {
  const found = await findFrozenPayRun(businessId, entityId, period);
  if (!found.frozen) return { frozen: false, code: found.code, reason: found.reason };
  const run = found.run;
  const { start, end, year, month } = parseMonthPeriod(period);

  const apInputs = await prisma.attendancePayInput.findMany({
    where: { businessId, payRunId: run.id, ...scopeWhere(scope, 'employeeId') },
    select: {
      employeeId: true, calendarDays: true, payableDays: true, lopDays: true,
      lwpDays: true, absentDays: true, paidLeaveDays: true, weeklyOffDays: true,
      holidayDays: true, overtimeHours: true,
      employee: {
        select: {
          ...EMPLOYEE_SELECT,
          statutoryProfile: { select: STATUTORY_SELECT },
          employmentRecords: {
            where: { isCurrent: true },
            select: { designation: { select: { title: true } } },
            take: 1,
          },
        },
      },
    },
    orderBy: { employee: { code: 'asc' } },
  });

  if (!apInputs.length) {
    return {
      frozen: false,
      code: 'NOT_FROZEN',
      reason: `Attendance for ${period} is not frozen — close attendance / lock the run first.`,
    };
  }

  const empIds = apInputs.map((a) => a.employeeId);
  // The daily frozen attendance rows for the period (isLocked after freeze).
  const att = await prisma.attendance.findMany({
    where: { businessId, employeeId: { in: empIds }, date: { gte: start, lte: end } },
    select: { employeeId: true, date: true, status: true, lopFraction: true, firstIn: true, lastOut: true, overtimeMinutes: true, workedMinutes: true },
    orderBy: { date: 'asc' },
  });
  const daysByEmp = new Map();
  for (const a of att) {
    if (!daysByEmp.has(a.employeeId)) daysByEmp.set(a.employeeId, []);
    daysByEmp.get(a.employeeId).push(a);
  }

  const workers = apInputs.map((a) => {
    const emp = attachDesignation(a.employee, a.employee.employmentRecords);
    delete emp.employmentRecords;
    const statutory = a.employee.statutoryProfile || {};
    const summary = { ...a };
    delete summary.employee;
    return {
      employee: emp,
      statutory,
      summary,
      days: daysByEmp.get(a.employeeId) || [],
    };
  });

  return {
    frozen: true,
    workers,
    period: { year, month },
    sourceRefs: { payRunIds: [run.id], attendanceFrozen: true },
  };
}

// ── LEAVE bundle (leave register) ─────────────────────────────────────────────
// Row-per (employee, leaveType) — the append-only ledger IS the statutory register.

async function loadLeaveBundle({ businessId, entityId, periodCode, scope }) {
  // Scope to the entity's employees (via current employment record) ∩ F1 scope.
  const empRecs = await prisma.employmentRecord.findMany({
    where: { businessId, entityId, isCurrent: true, ...scopeWhere(scope, 'employeeId') },
    select: { employeeId: true },
  });
  const empIds = empRecs.map((r) => r.employeeId);
  if (!empIds.length) return { frozen: true, workers: [], sourceRefs: { leavePeriodCode: periodCode } };

  const balances = await prisma.leaveBalance.findMany({
    where: { businessId, employeeId: { in: empIds }, ...(periodCode ? { periodCode } : {}) },
    select: {
      employeeId: true, leaveTypeId: true, periodCode: true, unit: true,
      opening: true, accrued: true, taken: true, encashed: true, lapsed: true,
      adjusted: true, closing: true,
      leaveType: { select: { name: true } },
      employee: {
        select: {
          ...EMPLOYEE_SELECT,
          statutoryProfile: { select: STATUTORY_SELECT },
          employmentRecords: { where: { isCurrent: true }, select: { designation: { select: { title: true } } }, take: 1 },
        },
      },
    },
    orderBy: [{ employee: { code: 'asc' } }, { leaveType: { name: 'asc' } }],
  });

  // One worker-row per (employee, leaveType) — the register lists a line per type.
  const workers = balances.map((b) => {
    const emp = attachDesignation(b.employee, b.employee.employmentRecords);
    delete emp.employmentRecords;
    const statutory = b.employee.statutoryProfile || {};
    const balance = {
      leaveTypeName: b.leaveType ? b.leaveType.name : '',
      opening: b.opening, accrued: b.accrued, taken: b.taken,
      encashed: b.encashed, lapsed: b.lapsed, adjusted: b.adjusted, closing: b.closing,
    };
    return { employee: emp, statutory, balance };
  });

  return { frozen: true, workers, sourceRefs: { leavePeriodCode: periodCode || null } };
}

// ── EMPLOYEE bundle (register of employees — as-of snapshot) ───────────────────

async function loadEmployeeBundle({ businessId, entityId, scope }) {
  const empRecs = await prisma.employmentRecord.findMany({
    where: { businessId, entityId, isCurrent: true, ...scopeWhere(scope, 'employeeId') },
    select: {
      employeeId: true,
      designation: { select: { title: true } },
      employee: {
        select: { ...EMPLOYEE_SELECT, statutoryProfile: { select: STATUTORY_SELECT } },
      },
    },
    orderBy: { employee: { code: 'asc' } },
  });

  const workers = empRecs
    .filter((r) => r.employee)
    .map((r) => {
      const emp = { ...r.employee, designation: r.designation ? r.designation.title : null };
      const statutory = r.employee.statutoryProfile || {};
      delete emp.statutoryProfile;
      return { employee: emp, statutory };
    });

  return { frozen: true, workers, sourceRefs: { asOf: true } };
}

// ── ANNUAL PAYRUN bundle (PF 3A/6A — 12 monthly LOCKED+ runs rolled per member) ─

async function loadAnnualPayrunBundle({ businessId, entityId, fyPeriod, scope }) {
  const { start, end } = parseFyPeriod(fyPeriod);
  const runs = await prisma.payRun.findMany({
    where: {
      businessId, entityId, deletedAt: null,
      status: { in: FROZEN_PAYRUN_STATUSES },
      periodStart: { gte: start }, periodEnd: { lte: end },
    },
    select: { id: true, periodStart: true },
  });
  if (!runs.length) {
    return { frozen: false, code: 'NOT_FROZEN', reason: `No locked pay runs found in FY ${fyPeriod}.` };
  }
  const runIds = runs.map((r) => r.id);

  const lines = await prisma.payRunLine.findMany({
    where: { businessId, payRunId: { in: runIds }, ...scopeWhere(scope, 'employeeId') },
    select: {
      employeeId: true, pfEmployee: true, pfEmployer: true, pfWagesBase: true,
      epsWagesBase: true,
      employee: {
        select: {
          ...EMPLOYEE_SELECT,
          statutoryProfile: { select: STATUTORY_SELECT },
          employmentRecords: { where: { isCurrent: true }, select: { designation: { select: { title: true } } }, take: 1 },
        },
      },
    },
  });

  // Roll the 12 monthly lines into one per member (sum the Decimals as numbers; the
  // exporter/totals re-sum via paise so no float drift accumulates in display).
  const byEmp = new Map();
  for (const l of lines) {
    let agg = byEmp.get(l.employeeId);
    if (!agg) {
      const emp = attachDesignation(l.employee, l.employee.employmentRecords);
      delete emp.employmentRecords;
      agg = {
        employee: emp,
        statutory: l.employee.statutoryProfile || {},
        line: { pfEmployee: 0, pfEmployer: 0, pfWagesBase: 0, epsWagesBase: 0 },
      };
      byEmp.set(l.employeeId, agg);
    }
    agg.line.pfEmployee += num(l.pfEmployee);
    agg.line.pfEmployer += num(l.pfEmployer);
    agg.line.pfWagesBase += num(l.pfWagesBase);
    agg.line.epsWagesBase += num(l.epsWagesBase);
  }

  return { frozen: true, workers: [...byEmp.values()], sourceRefs: { payRunIds: runIds } };
}

function num(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── source dispatch by RegisterSource ─────────────────────────────────────────

async function loadBundleForSource(source, args) {
  switch (source) {
    case 'ATTENDANCE':
      return loadAttendanceBundle(args);
    case 'PAYRUN':
      return loadPayrunBundle(args);
    case 'LEAVE':
      return loadLeaveBundle({ ...args, periodCode: args.period });
    case 'EMPLOYEE':
      return loadEmployeeBundle(args);
    case 'PAYRUN_ANNUAL':
      return loadAnnualPayrunBundle({ ...args, fyPeriod: args.period });
    default: {
      const e = new Error(`Unknown register source "${source}"`);
      e.code = 'BAD_SOURCE';
      throw e;
    }
  }
}

module.exports = {
  FROZEN_PAYRUN_STATUSES,
  parseMonthPeriod,
  parseFyPeriod,
  findFrozenPayRun,
  loadEntityHeader,
  loadPayrunBundle,
  loadAttendanceBundle,
  loadLeaveBundle,
  loadEmployeeBundle,
  loadAnnualPayrunBundle,
  loadBundleForSource,
};

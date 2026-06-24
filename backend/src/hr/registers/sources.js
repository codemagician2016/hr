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

/**
 * Parse an ESI half-year contribution period to its 6-month window.
 * Accepts:
 *   - "H1-2026" → 1 Apr 2026 .. 30 Sep 2026 (April–September contribution period)
 *   - "H2-2026" → 1 Oct 2026 .. 31 Mar 2027 (October–March contribution period)
 *   - "2026-07" (any YYYY-MM) → the half-year that CONTAINS that month (back-compat
 *     with a month token, so an existing UI passing a month still resolves to the
 *     correct statutory 6-month window rather than a single month).
 * Returns { half:'H1'|'H2', label:'H1-2026', start, end }.
 */
function parseHalfYearPeriod(period) {
  const raw = String(period || '').trim().toUpperCase();
  let half;
  let year;
  let mHy = /^(H[12])[-/](\d{4})$/.exec(raw);
  if (mHy) {
    half = mHy[1];
    year = +mHy[2];
  } else {
    const mMonth = /^(\d{4})-(\d{2})$/.exec(raw);
    if (!mMonth || +mMonth[2] < 1 || +mMonth[2] > 12) {
      const e = new Error(`Invalid half-year "${period}" — expected "H1-YYYY"/"H2-YYYY" or "YYYY-MM"`);
      e.code = 'BAD_PERIOD';
      throw e;
    }
    year = +mMonth[1];
    const month = +mMonth[2];
    // Apr(4)..Sep(9) = H1; Oct(10)..Dec(12) = H2 of this year; Jan(1)..Mar(3) = H2
    // of the PREVIOUS FY year (the Oct–Mar window belongs to the year it started).
    if (month >= 4 && month <= 9) {
      half = 'H1';
    } else if (month >= 10) {
      half = 'H2';
    } else {
      half = 'H2';
      year -= 1;
    }
  }
  if (half === 'H1') {
    return { half, label: `H1-${year}`, start: new Date(Date.UTC(year, 3, 1)), end: new Date(Date.UTC(year, 8, 30)) };
  }
  return { half, label: `H2-${year}`, start: new Date(Date.UTC(year, 9, 1)), end: new Date(Date.UTC(year + 1, 2, 31)) };
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
  const { year, month } = parseMonthPeriod(period);
  // The muster grid window is the FROZEN pay run's actual period — NOT the raw
  // calendar month. For a non-calendar cycle (e.g. 26→25) this spans two calendar
  // months, keeping the daily grid byte-identical to the frozen summary's span.
  const start = run.periodStart;
  const end = run.periodEnd;

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
  // The daily FROZEN attendance rows over the run period. isLocked:true is the
  // cardinal invariant — only attendance the freeze locked is authoritative
  // statutory data; an admin-unlocked correction-in-flight or a post-freeze row
  // must NEVER surface in the register (it would diverge from the frozen summary).
  const att = await prisma.attendance.findMany({
    where: { businessId, employeeId: { in: empIds }, isLocked: true, date: { gte: start, lte: end } },
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
    // The grid window = the frozen run period (drives one day-column per actual
    // period day, NOT the calendar month). Carried through so the projector and
    // the frozen summary share ONE window on non-calendar cycles.
    window: { start, end },
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

// ── HALF-YEARLY PAYRUN bundle (ESI contribution register — 6 frozen monthly runs
// rolled per member over the Apr–Sep / Oct–Mar contribution period) ────────────

async function loadEsiHalfYearBundle({ businessId, entityId, period, scope }) {
  const { start, end, label } = parseHalfYearPeriod(period);
  const runs = await prisma.payRun.findMany({
    where: {
      businessId, entityId, deletedAt: null,
      status: { in: FROZEN_PAYRUN_STATUSES },
      periodStart: { gte: start }, periodEnd: { lte: end },
    },
    select: { id: true, periodStart: true },
  });
  if (!runs.length) {
    return { frozen: false, code: 'NOT_FROZEN', reason: `No locked pay runs found in ${label} (ESI half-year).` };
  }
  const runIds = runs.map((r) => r.id);

  const lines = await prisma.payRunLine.findMany({
    where: { businessId, payRunId: { in: runIds }, ...scopeWhere(scope, 'employeeId') },
    select: {
      employeeId: true, grossEarnings: true, esiEmployee: true, esiEmployer: true,
      employee: {
        select: {
          ...EMPLOYEE_SELECT,
          statutoryProfile: { select: STATUTORY_SELECT },
          employmentRecords: { where: { isCurrent: true }, select: { designation: { select: { title: true } } }, take: 1 },
        },
      },
    },
  });

  // Roll the (up to) 6 monthly lines into one per member — the half-yearly
  // contribution is the SUM of the period's monthly frozen figures, not one month.
  const byEmp = new Map();
  for (const l of lines) {
    let agg = byEmp.get(l.employeeId);
    if (!agg) {
      const emp = attachDesignation(l.employee, l.employee.employmentRecords);
      delete emp.employmentRecords;
      agg = {
        employee: emp,
        statutory: l.employee.statutoryProfile || {},
        line: { grossEarnings: 0, esiEmployee: 0, esiEmployer: 0 },
      };
      byEmp.set(l.employeeId, agg);
    }
    agg.line.grossEarnings += num(l.grossEarnings);
    agg.line.esiEmployee += num(l.esiEmployee);
    agg.line.esiEmployer += num(l.esiEmployer);
  }

  // Order by employee code for a stable register (the per-member aggregate).
  const workers = [...byEmp.values()].sort((a, b) => {
    const ca = (a.employee && a.employee.code) || '';
    const cb = (b.employee && b.employee.code) || '';
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });

  return { frozen: true, workers, sourceRefs: { payRunIds: runIds, halfYear: label } };
}

function num(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── source dispatch by RegisterSource ─────────────────────────────────────────

async function loadBundleForSource(source, args) {
  // A HALF_YEARLY register (ESI contribution) reads its OWN multi-month window:
  // 6 frozen monthly runs rolled per member over Apr–Sep / Oct–Mar, NOT a single
  // calendar month. We branch on cadence here (no new RegisterSource enum value /
  // schema migration needed) so a PAYRUN-source ESI form gets the half-year roll.
  if (args && args.cadence === 'HALF_YEARLY') {
    return loadEsiHalfYearBundle(args);
  }
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
  parseHalfYearPeriod,
  findFrozenPayRun,
  loadEntityHeader,
  loadPayrunBundle,
  loadAttendanceBundle,
  loadLeaveBundle,
  loadEmployeeBundle,
  loadAnnualPayrunBundle,
  loadEsiHalfYearBundle,
  loadBundleForSource,
};

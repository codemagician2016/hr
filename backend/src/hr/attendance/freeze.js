'use strict';

/**
 * freeze.js — Attendance → payroll FREEZE BRIDGE (Feature 2, Phase 3, §4.4).
 *
 * The end of the pipeline:
 *
 *   Attendance (daily rollup) ─► period roll-up ─► AttendancePayInput (immutable)
 *                                                  └─► engine.inputs (otHours, lopDays,
 *                                                      payableDays, calendarDays)
 *
 * `freezeAttendance(payRunId, businessId, periodStart, periodEnd, employeeIds, tx)`
 *   - For each employee, rolls up the daily Attendance rows in [periodStart,
 *     periodEnd] into one AttendancePayInput (UPSERT on @@unique([payRunId,
 *     employeeId])).
 *   - Locks the Attendance rows it rolled up (isLocked=true) — monotonic: a frozen
 *     day never retro-mutates.
 *   - Transitions any APPROVED timesheet overlapping the period to LOCKED.
 *
 * Maps 1:1 onto the payroll engine inputs (verified against payroll/engine.js
 * resolveProration/applyProration): calendarDays, payableDays, lopDays, otHours.
 * Days are Decimal (never money). overtimeHours is the multiplier-collapsed
 * equivalent-hours figure derived in derive.js (stored on Attendance.exceptionsJson
 * as otEquivalentHours).
 */

const prisma = require('../../core/lib/prisma');
const { daysBetweenInclusive } = require('./derive');

function utcDay(value) {
  const t = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round4(n) { return Math.round(n * 10000) / 10000; }
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Roll up one employee's daily Attendance rows into the AttendancePayInput shape.
 * PURE given the rows (no DB). Exported for unit reuse/tests.
 *
 * H3 — payableDays invariant: payableDays = calendarDays − Σ LOP. This is only
 * SAFE when the employee's working days are defined by attendance rows (a
 * scheduled employee always has a row per day — recompute writes ABSENT for every
 * scheduled no-punch day). An employee with ZERO Attendance rows in the period is
 * open-attendance / no-data: we must NOT silently pay a full month off no signal.
 * Policy (documented, defensible): set payableDays = calendarDays EXPLICITLY and
 * emit a NO_ATTENDANCE_DATA warning so the run surfaces it (rather than skipping
 * the employee, which would drop them from payroll entirely). The caller decides
 * whether to gate on the warning.
 */
function rollupEmployee(rows, periodStart, periodEnd) {
  const calendarDays = daysBetweenInclusive(utcDay(periodStart), utcDay(periodEnd));
  let weeklyOffDays = 0;
  let holidayDays = 0;
  let paidLeaveDays = 0;
  let lopDays = 0;
  let overtimeHours = 0;
  const attendanceIds = [];
  const anomalies = [];

  for (const a of rows) {
    attendanceIds.push(a.id);
    const lop = toNum(a.lopFraction);
    lopDays += lop;

    if (a.status === 'WEEKLY_OFF') weeklyOffDays += 1;
    if (a.status === 'HOLIDAY' || a.status === 'HOLIDAY_WORKED') holidayDays += 1;
    // Paid leave = the non-LOP portion of an ON_LEAVE / HALF_DAY-leave day.
    if (a.status === 'ON_LEAVE') paidLeaveDays += (1 - lop);
    if (a.status === 'HALF_DAY' && lop < 1) paidLeaveDays += 0; // half-day worked is presence, not paid leave

    // otEquivalentHours is stashed on exceptionsJson by the derivation service.
    const ex = a.exceptionsJson || {};
    overtimeHours += toNum(ex.otEquivalentHours);
  }

  lopDays = round4(lopDays);
  let payableDays = round4(calendarDays - lopDays);

  // H3 — no attendance rows at all: open-attendance / no-data. Pay calendar days
  // (lopDays is already 0 here) but flag it loudly so it isn't a silent full-pay.
  if (rows.length === 0) {
    payableDays = round4(calendarDays);
    anomalies.push({
      code: 'NO_ATTENDANCE_DATA',
      severity: 'WARNING',
      message: `No Attendance rows in [${utcDay(periodStart).toISOString().slice(0, 10)}, ${utcDay(periodEnd).toISOString().slice(0, 10)}]; payableDays defaulted to calendarDays (${calendarDays}). Verify the employee is open-attendance (no schedule) and not a missed derivation.`,
    });
  }

  return {
    calendarDays: round4(calendarDays),
    weeklyOffDays: round4(weeklyOffDays),
    holidayDays: round4(holidayDays),
    paidLeaveDays: round4(paidLeaveDays),
    lopDays,
    overtimeHours: round2(overtimeHours),
    payableDays,
    attendanceIds,
    anomalies,
  };
}

/**
 * freezeAttendance(payRunId, businessId, periodStart, periodEnd, employeeIds, tx)
 *
 * @param {string}   payRunId
 * @param {string}   businessId
 * @param {Date|string} periodStart
 * @param {Date|string} periodEnd
 * @param {string[]} employeeIds   employees to freeze (the run's headcount)
 * @param {object=}  tx            optional Prisma transaction client
 * @returns {Promise<{ frozen:number, lockedAttendance:number, lockedTimesheets:number,
 *                      anomalies:Array<{ employeeId, code, severity, message }> }>}
 */
async function freezeAttendance(payRunId, businessId, periodStart, periodEnd, employeeIds, tx) {
  const db = tx || prisma;
  const from = utcDay(periodStart);
  const to = utcDay(periodEnd);
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  if (!payRunId || !businessId || ids.length === 0) {
    return { frozen: 0, lockedAttendance: 0, lockedTimesheets: 0 };
  }

  const now = new Date();
  let frozen = 0;
  let lockedAttendance = 0;
  let lockedTimesheets = 0;
  const anomalies = []; // H3 — { employeeId, code, severity, message }

  for (const employeeId of ids) {
    const rows = await db.attendance.findMany({
      where: { businessId, employeeId, date: { gte: from, lte: to } },
      select: { id: true, status: true, lopFraction: true, exceptionsJson: true },
    });

    const roll = rollupEmployee(rows, from, to);
    for (const a of roll.anomalies || []) anomalies.push({ employeeId, ...a });

    const data = {
      periodStart: from,
      periodEnd: to,
      calendarDays: roll.calendarDays,
      payableDays: roll.payableDays,
      lopDays: roll.lopDays,
      paidLeaveDays: roll.paidLeaveDays,
      weeklyOffDays: roll.weeklyOffDays,
      holidayDays: roll.holidayDays,
      overtimeHours: roll.overtimeHours,
      frozenAt: now,
      sourceJson: {
        attendanceIds: roll.attendanceIds,
        basis: 'attendance-rollup',
        dayCount: rows.length,
      },
    };

    await db.attendancePayInput.upsert({
      where: { payRunId_employeeId: { payRunId, employeeId } },
      update: data,
      create: { businessId, payRunId, employeeId, ...data },
    });
    frozen += 1;

    // Lock the rolled-up Attendance rows (monotonic freeze).
    if (roll.attendanceIds.length) {
      const r = await db.attendance.updateMany({
        where: { businessId, employeeId, date: { gte: from, lte: to } },
        data: { isLocked: true },
      });
      lockedAttendance += r.count;
    }
  }

  // Transition APPROVED timesheets overlapping the period → LOCKED (terminal).
  const ts = await db.timesheet.updateMany({
    where: {
      businessId,
      employeeId: { in: ids },
      status: 'APPROVED',
      periodStart: { lte: to },
      periodEnd: { gte: from },
    },
    data: { status: 'LOCKED' },
  });
  lockedTimesheets = ts.count;

  // H3 — surface no-data warnings so the caller (computeRun) can log/gate rather
  // than silently full-paying an employee whose attendance was never derived.
  if (anomalies.length) {
    // eslint-disable-next-line no-console
    console.warn(`[freezeAttendance] ${anomalies.length} attendance anomaly(ies) for payRun ${payRunId}:`,
      anomalies.map((a) => `${a.employeeId}:${a.code}`).join(', '));
  }

  return { frozen, lockedAttendance, lockedTimesheets, anomalies };
}

module.exports = {
  freezeAttendance,
  _internals: { rollupEmployee },
};

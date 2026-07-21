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
 * H3 — payableDays invariant: payableDays = standardDays − Σ LOP, where
 * standardDays is the basis-specific proration denominator (calendar for
 * CALENDAR_DAYS, 30 for FIXED_30, calendar−weekoff−holiday for WORKING_DAYS). This
 * keeps the numerator and denominator the engine prorates over on ONE basis. It is
 * only SAFE when the employee's working days are defined by attendance rows (a
 * scheduled employee always has a row per day — recompute writes ABSENT for every
 * scheduled no-punch day). An employee with ZERO Attendance rows in the period is
 * open-attendance / no-data: we must NOT silently pay a full month off no signal.
 * Policy (documented, defensible): set payableDays = calendarDays EXPLICITLY and
 * emit a NO_ATTENDANCE_DATA warning so the run surfaces it (rather than skipping
 * the employee, which would drop them from payroll entirely). The caller decides
 * whether to gate on the warning.
 */
function rollupEmployee(rows, periodStart, periodEnd, opts = {}) {
  const calendarDays = daysBetweenInclusive(utcDay(periodStart), utcDay(periodEnd));
  let weeklyOffDays = 0;
  let holidayDays = 0;
  let paidLeaveDays = 0;
  let lopDays = 0;
  // Feature 16 — LOP provenance split. lwpDays = approved unpaid-leave LOP
  // (ON_LEAVE rows whose covering type affectsLOP → a positive lopFraction on an
  // ON_LEAVE day); absentDays = AWOL/unauthorised LOP (status ABSENT). Both are
  // SUBSETS of lopDays; the payableDays/lopDays math below is UNCHANGED — these are
  // pure provenance so the run review reads "12 payable, 3 LWP, 1 absent".
  let lwpDays = 0;
  let absentDays = 0;
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

    // LOP provenance: an ON_LEAVE day with a positive LOP is an APPROVED unpaid
    // leave (LWP) — only the affectsLOP fraction is unpaid (so a 0.5 SL + 0.5 LWP
    // day contributes 0.5 to lwpDays, matching its 0.5 lopFraction). An ABSENT day
    // is unauthorised LOP. HALF_DAY shortfalls/missing-punch LOP are neither.
    if (a.status === 'ON_LEAVE' && lop > 0) lwpDays += lop;
    if (a.status === 'ABSENT') absentDays += lop;

    // otEquivalentHours is stashed on exceptionsJson by the derivation service.
    const ex = a.exceptionsJson || {};
    overtimeHours += toNum(ex.otEquivalentHours);
  }

  lopDays = round4(lopDays);
  lwpDays = round4(lwpDays);
  absentDays = round4(absentDays);

  // standardDays = the proration denominator the engine will use. Default to the
  // calendar length (India CALENDAR_DAYS basis); the caller may freeze a different
  // basis (FIXED_30 → 30, WORKING_DAYS → calendar−weekoff−holiday) via opts.basis
  // so the denominator is frozen with the inputs (immutable, part of inputHash).
  let standardDays = round4(calendarDays);
  const basis = opts.prorationBasis || null;
  if (basis === 'THIRTY_DAY_STANDARD' || basis === 'FIXED_30') {
    standardDays = 30;
  } else if (basis === 'TWENTYSIX_DAY_STANDARD' || basis === 'FIXED_26') {
    // Feature 42 — the factory 26-day basis (Gratuity/Factories tradition).
    standardDays = 26;
  } else if (basis === 'WORKING_DAYS') {
    standardDays = round4(calendarDays - weeklyOffDays - holidayDays);
  }

  // F16 review fix (HIGH×2) — payableDays MUST share the SAME basis as standardDays,
  // i.e. the SAME denominator the engine prorates over. The old code set
  // payableDays = calendarDays − lopDays UNCONDITIONALLY (a CALENDAR numerator) while
  // standardDays followed the basis (30 for FIXED_30; calendar−weekoff−holiday for
  // WORKING_DAYS). A calendar numerator over a smaller denominator made payableDays
  // ≥ standardDays even WITH LOP, so engine.applyProration's
  // `if (payable >= standard) return fullMinor` CLAMPED LOP to zero (WORKING_DAYS:
  // absent employee paid in full, ~15% overpay) or systematically under-charged it
  // (FIXED_30: prorated 31−lop / 30 instead of 30−lop / 30). Deriving
  // payableDays = standardDays − lopDays puts numerator and denominator on ONE basis:
  //   CALENDAR_DAYS → calendarDays − lop  (standardDays == calendarDays; unchanged)
  //   WORKING_DAYS  → workingDays  − lop  (workingDays = calendar − weekoff − holiday)
  //   FIXED_30      → 30 − lop            (paise-exact 'paid = 30 − LOP')
  // Floor at 0 (a full-LOP month pays nothing; never a negative numerator).
  let payableDays = round4(Math.max(0, standardDays - lopDays));

  // H3 — no attendance rows at all: open-attendance / no-data. Pay the full standard
  // basis (lopDays is already 0 here) but flag it loudly so it isn't a silent
  // full-pay. payableDays == standardDays ⇒ no proration applied.
  if (rows.length === 0) {
    payableDays = round4(standardDays);
    anomalies.push({
      code: 'NO_ATTENDANCE_DATA',
      severity: 'WARNING',
      message: `No Attendance rows in [${utcDay(periodStart).toISOString().slice(0, 10)}, ${utcDay(periodEnd).toISOString().slice(0, 10)}]; payableDays defaulted to the standard basis (${round4(standardDays)} day(s)). Verify the employee is open-attendance (no schedule) and not a missed derivation.`,
    });
  }

  return {
    calendarDays: round4(calendarDays),
    weeklyOffDays: round4(weeklyOffDays),
    holidayDays: round4(holidayDays),
    paidLeaveDays: round4(paidLeaveDays),
    lopDays,
    lwpDays,
    absentDays,
    standardDays,
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
 * @param {object=}  opts          { prorationBasis } — Feature 16: the entity's
 *                                  salary-proration denominator policy (ProrationMethod),
 *                                  frozen into AttendancePayInput.standardDays.
 * @returns {Promise<{ frozen:number, lockedAttendance:number, lockedTimesheets:number,
 *                      anomalies:Array<{ employeeId, code, severity, message }> }>}
 */
async function freezeAttendance(payRunId, businessId, periodStart, periodEnd, employeeIds, tx, opts = {}) {
  const db = tx || prisma;
  const from = utcDay(periodStart);
  const to = utcDay(periodEnd);
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  if (!payRunId || !businessId || ids.length === 0) {
    return { frozen: 0, lockedAttendance: 0, lockedTimesheets: 0 };
  }
  const prorationBasis = opts.prorationBasis || null;

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

    const roll = rollupEmployee(rows, from, to, { prorationBasis });
    for (const a of roll.anomalies || []) anomalies.push({ employeeId, ...a });

    const data = {
      periodStart: from,
      periodEnd: to,
      calendarDays: roll.calendarDays,
      payableDays: roll.payableDays,
      lopDays: roll.lopDays,
      lwpDays: roll.lwpDays,
      absentDays: roll.absentDays,
      standardDays: roll.standardDays,
      paidLeaveDays: roll.paidLeaveDays,
      weeklyOffDays: roll.weeklyOffDays,
      holidayDays: roll.holidayDays,
      overtimeHours: roll.overtimeHours,
      frozenAt: now,
      sourceJson: {
        attendanceIds: roll.attendanceIds,
        basis: 'attendance-rollup',
        prorationBasis: prorationBasis || 'CALENDAR_DAYS',
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

'use strict';

/*
 * fixes.unit.test.js — DB-FREE regression tests for the adversarial-review fixes
 * whose logic is PURE (no DB). Plain-node (built-in assert, no jest):
 *   node backend/src/hr/attendance/__tests__/fixes.unit.test.js
 *
 * Covers the pure halves of:
 *   C2  — tz.js wall-clock ↔ UTC + civil-day-in-tz.
 *   C1  — shiftInstantWindow night-shift / day-shift instant windows.
 *   M5  — resolveLeaveForDay aggregates overlapping leave txns.
 *   M1  — buildEmployeePayInput keeps a frozen ZERO payableDays.
 *   M2  — buildEmployeePayInput emits OT_HOURS_UNCONSUMED.
 *   H4  — NZ mondayisation back-to-back collision (Christmas+Boxing, NY+Day-after).
 *   L4  — Matariki-missing warning surfaces from nzNationalSet table gap.
 *
 * The DB-backed fixes (H1/H2/H3/H5/L1/L2/L3, C1/C2 end-to-end) live in the
 * sibling LIVE test fixes.rbac.test.js.
 */

const assert = require('assert');
const tz = require('../tz');
const { _internals: svc } = require('../service');
const payroll = require('../../payroll/service');
const holidays = require('../../controllers/holidays.controller');

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed += 1; } else { failed += 1; fails.push(name); console.error(`  FAIL  ${name}`); }
}

/* ── C2 — tz.js ─────────────────────────────────────────────────────────────*/
// IST 09:00 on a winter date → 03:30 UTC (no DST in India).
check('tz IST 09:00 → 03:30Z',
  tz.zonedWallTimeToUtc('2026-06-22', '09:00', 'Asia/Kolkata').toISOString() === '2026-06-22T03:30:00.000Z');
// NZ standard time (June, +12) 09:00 → 21:00Z previous day.
check('tz NZ 09:00 NZST → prev 21:00Z',
  tz.zonedWallTimeToUtc('2026-06-22', '09:00', 'Pacific/Auckland').toISOString() === '2026-06-21T21:00:00.000Z');
// NZ daylight time (January, +13) 09:00 → 20:00Z previous day (DST refinement).
check('tz NZ 09:00 NZDT → prev 20:00Z',
  tz.zonedWallTimeToUtc('2026-01-15', '09:00', 'Pacific/Auckland').toISOString() === '2026-01-14T20:00:00.000Z');
// civilDateInTz: an NZ 11:00 NZST punch is 23:00Z the previous UTC day → local 06-22.
check('tz civilDateInTz buckets to local day',
  tz.civilDateInTz('2026-06-21T23:00:00Z', 'Pacific/Auckland') === '2026-06-22');
check('tz IST offset = +5.5h',
  tz.tzOffsetMs(Date.UTC(2026, 5, 22), 'Asia/Kolkata') === 5.5 * 3600000);
// resolveTimezone precedence: location → entity → business → countryCode → UTC.
check('tz resolve location wins',
  tz.resolveTimezone({}, { location: { timezone: 'Pacific/Auckland' }, entity: { timezone: 'Asia/Kolkata' } }) === 'Pacific/Auckland');
check('tz resolve entity over business',
  tz.resolveTimezone({}, { entity: { timezone: 'Asia/Kolkata' }, business: { timezone: 'UTC' } }) === 'Asia/Kolkata');
check('tz resolve countryCode fallback IN',
  tz.resolveTimezone({ countryCode: 'IN' }, {}) === 'Asia/Kolkata');
check('tz resolve countryCode fallback NZ',
  tz.resolveTimezone({ countryCode: 'NZ' }, {}) === 'Pacific/Auckland');
check('tz resolve UTC default',
  tz.resolveTimezone({}, {}) === 'UTC');

/* ── C1 — shiftInstantWindow ────────────────────────────────────────────────*/
{
  // Day shift 09:00–18:00 in IST: window = the civil day [00:00 IST, next 00:00 IST).
  const w = svc.shiftInstantWindow('2026-06-22', { startTime: '09:00', endTime: '18:00' }, 'Asia/Kolkata');
  check('C1 day-shift window start = 06-22 00:00 IST (06-21 18:30Z)',
    w.gte.toISOString() === '2026-06-21T18:30:00.000Z');
  check('C1 day-shift window end = 06-23 00:00 IST (06-22 18:30Z)',
    w.lt.toISOString() === '2026-06-22T18:30:00.000Z');
}
{
  // Night shift 22:00→06:00 (endTime <= startTime) in UTC for clean math: D's window
  // runs [D 22:00, D+1 22:00) so the post-midnight OUT — even one exactly at the
  // nominal 06:00 end — pairs with D and CANNOT be re-pulled into D+1.
  const wD = svc.shiftInstantWindow('2026-06-22', { startTime: '22:00', endTime: '06:00' }, 'UTC');
  check('C1 night-shift D window start = D 22:00Z',
    wD.gte.toISOString() === '2026-06-22T22:00:00.000Z');
  check('C1 night-shift D window end = D+1 22:00Z (next start)',
    wD.lt.toISOString() === '2026-06-23T22:00:00.000Z');
  // An on-time OUT exactly at 06:00Z D+1 is INSIDE D's window (half-open upper edge
  // is the next start, not the nominal end), so it pairs with D.
  const outOnTime = new Date('2026-06-23T06:00:00Z');
  check('C1 night-shift on-time OUT (06:00 D+1) is inside D window',
    outOnTime >= wD.gte && outOnTime < wD.lt);
  // D+1's own window starts at its OWN 22:00 = exactly D's window end → no overlap.
  const wD1 = svc.shiftInstantWindow('2026-06-23', { startTime: '22:00', endTime: '06:00' }, 'UTC');
  check('C1 night-shift D+1 window start = D window end (no re-pull)',
    wD1.gte.getTime() === wD.lt.getTime());
  check('C1 night-shift D OUT excluded from D+1 window',
    outOnTime < wD1.gte);
}

/* ── M5 — resolveLeaveForDay aggregates ─────────────────────────────────────*/
{
  const lt = (startHalf, endHalf, affectsLOP, sd = '2026-06-22', ed = '2026-06-22') => ({
    startDate: new Date(`${sd}T00:00:00Z`), endDate: new Date(`${ed}T00:00:00Z`),
    startHalf, endHalf, leaveType: { affectsLOP },
  });
  // FIRST_HALF + SECOND_HALF on the same day → full ON_LEAVE (fraction 1).
  const both = svc.resolveLeaveForDay('2026-06-22', [
    lt('FIRST_HALF', 'FIRST_HALF', false), lt('SECOND_HALF', 'SECOND_HALF', true),
  ]);
  check('M5 two half-days → fraction 1', both && both.fraction === 1);
  check('M5 two half-days OR affectsLOP', both && both.affectsLOP === true);
  // Single half-day stays 0.5.
  const half = svc.resolveLeaveForDay('2026-06-22', [lt('FIRST_HALF', 'FIRST_HALF', false)]);
  check('M5 single half-day → 0.5', half && half.fraction === 0.5);
  // No leave → null.
  check('M5 no overlap → null', svc.resolveLeaveForDay('2026-06-23', [lt('FIRST_HALF', 'FIRST_HALF', false)]) === null);
}

/* ── M1 / M2 — payroll mapping ──────────────────────────────────────────────*/
function baseRows(over = {}) {
  return {
    employee: { id: 'e1', code: 'E1', gender: 'MALE', dateOfBirth: '1990-01-01' },
    compensation: {
      id: 'c1',
      lines: [{
        amountMonthly: '30000.00', sortOrder: 0,
        component: { id: 'BASIC', code: 'BASIC', name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: true, prorationMethod: 'CALENDAR_DAYS', isRecurring: true },
      }],
    },
    statutory: { countryCode: 'IN', pan: 'ABCDE1234F' },
    entity: { countryCode: 'IN', payCurrency: 'INR', stateCode: 'MH' },
    period: { start: '2026-06-01', end: '2026-06-30', payDate: '2026-06-30', frequency: 'MONTHLY', taxYear: '2026-27' },
    ...over,
  };
}
{
  // M1 — a frozen ZERO payableDays must reach inputs (not dropped by truthiness).
  const rows = baseRows({ attendance: { calendarDays: 30, payableDays: 0, lopDays: 30, overtimeHours: 0 } });
  const { engineArgs } = payroll.buildEmployeePayInput(rows);
  check('M1 frozen payableDays 0 reaches engine', engineArgs.inputs.payableDays === 0);
  check('M1 frozen lopDays 30 reaches engine', engineArgs.inputs.lopDays === 30);
}
{
  // M2 — OT hours present but NO ATTENDANCE_DRIVEN component → OT_HOURS_UNCONSUMED.
  const rows = baseRows({ attendance: { calendarDays: 30, payableDays: 30, lopDays: 0, overtimeHours: 5 } });
  const { meta } = payroll.buildEmployeePayInput(rows);
  const has = (meta.preAnomalies || []).some((a) => a.code === 'OT_HOURS_UNCONSUMED' && a.severity === 'WARNING');
  check('M2 OT unconsumed → warning anomaly', has);
  // With a FORMULA (ATTENDANCE_DRIVEN) OT earning, NO anomaly.
  const rows2 = baseRows({
    attendance: { calendarDays: 30, payableDays: 30, lopDays: 0, overtimeHours: 5 },
    compensation: { id: 'c1', lines: [
      ...baseRows().compensation.lines,
      { calcValue: '200.00', sortOrder: 1, component: { id: 'OT', code: 'OT', name: 'Overtime', category: 'EARNING', calcMethod: 'FORMULA', prorationMethod: 'NONE', isRecurring: false } },
    ] },
  });
  const { meta: meta2 } = payroll.buildEmployeePayInput(rows2);
  const has2 = (meta2.preAnomalies || []).some((a) => a.code === 'OT_HOURS_UNCONSUMED');
  check('M2 OT consumed by FORMULA → no anomaly', !has2);
}

/* ── H4 — NZ mondayisation back-to-back ─────────────────────────────────────*/
function obs(year, name) {
  const set = holidays._internals.nzNationalSet(year).filter((h) => h.name === `${name} (observed)`);
  return set.length ? `${set[0].year}-${String(set[0].month).padStart(2, '0')}-${String(set[0].day).padStart(2, '0')}` : null;
}
// 2021: Christmas (Sat 25) → observed Mon 27; Boxing (Sun 26) → observed Tue 28.
check('H4 2021 Christmas observed Mon 27', obs(2021, 'Christmas Day') === '2021-12-27');
check('H4 2021 Boxing observed Tue 28 (collision bump)', obs(2021, 'Boxing Day') === '2021-12-28');
// 2022: New Year (Sat 1) → observed Mon 3; Day-after (Sun 2) → observed Tue 4.
check('H4 2022 New Year observed Mon 3', obs(2022, "New Year's Day") === '2022-01-03');
check('H4 2022 Day-after observed Tue 4 (collision bump)', obs(2022, 'Day after New Year') === '2022-01-04');

/* ── L4 — Matariki-missing detection (table gap) ────────────────────────────*/
check('L4 Matariki present in table year 2026',
  holidays._internals.nzNationalSet(2026).some((h) => h.name === 'Matariki'));
check('L4 Matariki absent in gap year 2035',
  !holidays._internals.nzNationalSet(2035).some((h) => h.name === 'Matariki'));

/* ── report ────────────────────────────────────────────────────────────────*/
console.log(`\nfixes.unit: ${passed} passed, ${failed} failed`);
if (failed) { console.error('FAILURES:', fails.join('; ')); process.exit(1); }
console.log('=== ALL FIXES UNIT TESTS PASSED ===');

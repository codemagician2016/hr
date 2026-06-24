'use strict';

/*
 * derive.roster.test.js — Feature 29 golden extension proving the roster precedence
 * in resolveSchedule (../derive.js) preserves invariant I1: a PUBLISHED roster WORK/OFF
 * day produces the BYTE-IDENTICAL DerivedDay as the equivalent ShiftAssignment / weekly-
 * off, and a DRAFT roster row is NOT read (falls back to the assignment). Plain-node:
 *   node backend/src/hr/attendance/__tests__/derive.roster.test.js
 */

const assert = require('assert');
const { derive, resolveSchedule } = require('../derive.js');

let passed = 0;
let failed = 0;
const fails = [];
function check(name, expected, actual) {
  let ok;
  try { assert.deepStrictEqual(actual, expected); ok = true; } catch (_) { ok = false; }
  if (ok) { passed += 1; } else { failed += 1; fails.push({ name, expected, actual }); }
}

const D = '2026-06-01';
const at = (hhmmss, day = D) => `${day}T${hhmmss}Z`;
const P = (punchType, punchAt) => ({ punchType, punchAt });

const dayPattern = { id: 'DAY', startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceInMinutes: 10, fullDayMinutes: 480, halfDayThresholdMinutes: 240, requireBothPunches: true, weeklyOffDays: '0' };
// 22:00→06:00 = 8h gross − 60m break = 420m worked, so fullDayMinutes is 420 to make
// it a genuine full present day (the point under test is the no-false-EARLY_OUT roll).
const nightPattern = { id: 'NIGHT', startTime: '22:00', endTime: '06:00', breakMinutes: 60, graceInMinutes: 10, fullDayMinutes: 420, halfDayThresholdMinutes: 210, requireBothPunches: true, isNightShift: true, weeklyOffDays: '0' };

// The covering ShiftAssignment for the SAME day pattern (the v1 path).
const assignments = [{ effectiveFrom: '2026-01-01', effectiveTo: null, shiftPattern: dayPattern }];

// ── 1. resolveSchedule precedence: a PUBLISHED WORK roster cell wins over the
//      covering assignment, returning the cell's pattern object ─────────────────
{
  const rosterDay = { dayType: 'WORK', shiftPattern: nightPattern };
  const sch = resolveSchedule(D, assignments, null, rosterDay);
  check('roster WORK cell → cell pattern', nightPattern, sch);
}

// ── 2. a PUBLISHED OFF cell → the { __off:true } sentinel ─────────────────────
{
  const sch = resolveSchedule(D, assignments, null, { dayType: 'OFF', shiftPattern: null });
  check('roster OFF cell → __off sentinel', { __off: true }, sch);
}

// ── 3. byte-identical (I1): deriving a day with the roster-resolved pattern gives
//      EXACTLY the same DerivedDay as deriving it with the assignment-resolved one.
{
  const punches = [P('IN', at('09:00:00')), P('OUT', at('18:00:00'))];
  const base = {
    date: D, scheduledStart: at('09:00:00'), scheduledEnd: at('18:00:00'),
    punches, holiday: false, weeklyOff: false,
    otRule: { weekdayMultiplier: 1, weeklyOffMultiplier: 2, holidayMultiplier: 2 },
  };
  // v1 path: schedule resolved from the assignment.
  const viaAssignment = derive({ ...base, schedule: resolveSchedule(D, assignments, null) });
  // v2 path: an EQUIVALENT roster WORK cell carrying the SAME pattern.
  const rosterDay = { dayType: 'WORK', shiftPattern: dayPattern };
  const viaRoster = derive({ ...base, schedule: resolveSchedule(D, assignments, null, rosterDay) });
  check('I1 byte-identical (roster WORK == assignment)', viaAssignment, viaRoster);
  check('I1 present full day', 'PRESENT', viaRoster.status);
}

// ── 4. a roster OFF day (service maps __off → weeklyOff=true, schedule=null) derives
//      identically to a pattern weekly-off day: no punches → WEEKLY_OFF. ─────────
{
  const offNoPunch = derive({ date: D, schedule: null, weeklyOff: true, punches: [] });
  check('roster OFF (no punch) → WEEKLY_OFF', 'WEEKLY_OFF', offNoPunch.status);
  const offWorked = derive({ date: D, schedule: null, weeklyOff: true, punches: [P('IN', at('10:00:00')), P('OUT', at('15:00:00'))] });
  check('roster OFF worked → HOLIDAY_WORKED', 'HOLIDAY_WORKED', offWorked.status);
}

// ── 5. a NIGHT roster cell: no false EARLY_OUT (scheduledEnd rolls to the next day).
//      The post-midnight OUT at 06:00 D+1 is exactly the nominal end → not early. ─
{
  const night = derive({
    date: D, schedule: nightPattern,
    scheduledStart: at('22:00:00'), scheduledEnd: at('06:00:00', '2026-06-02'),
    punches: [P('IN', at('22:00:00')), P('OUT', at('06:00:00', '2026-06-02'))],
    holiday: false, weeklyOff: false,
  });
  check('night roster cell → PRESENT', 'PRESENT', night.status);
  check('night roster cell → no EARLY_OUT', false, night.exceptions.includes('EARLY_OUT'));
}

// ── 6. DRAFT-ignored is enforced at the QUERY layer (service filters status:PUBLISHED),
//      so derive only ever receives a row for a PUBLISHED cell. When the caller passes
//      NO rosterDay (the no-roster / DRAFT-only case), resolveSchedule is byte-identical
//      to v1 — proven here by an undefined rosterDay yielding the assignment pattern. ─
{
  const withUndefined = resolveSchedule(D, assignments, null, undefined);
  const v1 = resolveSchedule(D, assignments, null);
  check('no rosterDay → v1 byte-identical', v1, withUndefined);
  check('no rosterDay → assignment pattern', dayPattern, withUndefined);
}

console.log(`\nderive roster goldens: ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of fails) console.log(`  FAIL ${f.name}\n    expected ${JSON.stringify(f.expected)}\n    actual   ${JSON.stringify(f.actual)}`);
  process.exit(1);
}
console.log('=== ALL DERIVE ROSTER GOLDENS PASSED ===');

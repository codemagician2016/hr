'use strict';

/*
 * calendar.test.js — INDEPENDENT QA for working-day leave netting (../calendar.js).
 * Plain-node:  node backend/src/hr/leave/__tests__/calendar.test.js
 *
 * Covers QA 5 (half-day + holiday-spanning): leading/trailing weekoff skipped;
 * interior INCLUSIVE debited / EXCLUSIVE not; half-day 0.5 fractions; NZ public
 * holiday inside an annual-leave block not debited. Reuses derive.js resolvers.
 *
 * Calendar anchors (UTC weekday): 2026-06-01 is a Monday.
 *   Mon 06-01 Tue 06-02 Wed 06-03 Thu 06-04 Fri 06-05 Sat 06-06 Sun 06-07
 *   Mon 06-08 ...
 * weeklyOffDays "0,6" = Sun+Sat.
 */

const assert = require('assert');
const C = require('../calendar.js');

let passed = 0; let failed = 0; const fails = [];
function near(name, expected, actual, eps = 1e-9) {
  if (Math.abs(expected - actual) <= eps) passed++; else { failed++; fails.push({ name, expected, actual }); }
}
function check(name, expected, actual) {
  let ok; try { assert.deepStrictEqual(actual, expected); ok = true; } catch (_) { ok = false; }
  if (ok) { passed++; } else { failed++; fails.push({ name, expected, actual }); }
}

const SAT_SUN = '0,6';
const holiday = (date, over = {}) => ({ date, entityId: null, locationId: null, isPaid: true, isRestricted: false, name: 'H', ...over });

// ── full working week (Mon-Fri) = 5 ──────────────────────────────────────────
near('1 Mon-Fri full = 5', 5,
  C.computeLeaveUnits({ startDate: '2026-06-01', endDate: '2026-06-05' }, { weeklyOffDays: SAT_SUN, leaveType: { countryCode: 'IN' } }).units);

// ── span over a weekend: Fri..next-Mon, interior Sat/Sun not debited (trailing/edge) ──
// Fri 06-05 .. Mon 06-08: working Fri+Mon (2); Sat/Sun interior but EXCLUSIVE-by-default? IN EL=INCLUSIVE.
// Sat/Sun are interior weekoffs → INCLUSIVE debits them. So 4.
near('2 Fri..Mon INCLUSIVE debits interior weekend = 4', 4,
  C.computeLeaveUnits({ startDate: '2026-06-05', endDate: '2026-06-08' }, { weeklyOffDays: SAT_SUN, leaveType: { countryCode: 'IN' } }).units);

// ── leading/trailing weekend skipped ─────────────────────────────────────────
// Sat 06-06 .. Mon 06-08: leading Sat+Sun skipped, only Mon works = 1.
near('3 leading weekend skipped = 1', 1,
  C.computeLeaveUnits({ startDate: '2026-06-06', endDate: '2026-06-08' }, { weeklyOffDays: SAT_SUN, leaveType: { countryCode: 'IN' } }).units);
// Fri 06-05 .. Sun 06-07: trailing Sat+Sun skipped, only Fri = 1.
near('4 trailing weekend skipped = 1', 1,
  C.computeLeaveUnits({ startDate: '2026-06-05', endDate: '2026-06-07' }, { weeklyOffDays: SAT_SUN, leaveType: { countryCode: 'IN' } }).units);

// ── interior holiday: IN INCLUSIVE debits, NZ EXCLUSIVE does not ──────────────
// Mon 06-01 .. Wed 06-03 with Tue 06-02 a holiday.
const inHol = C.computeLeaveUnits(
  { startDate: '2026-06-01', endDate: '2026-06-03' },
  { weeklyOffDays: SAT_SUN, holidays: [holiday('2026-06-02')], leaveType: { countryCode: 'IN' } });
near('5 IN interior holiday debited = 3', 3, inHol.units);

const nzHol = C.computeLeaveUnits(
  { startDate: '2026-06-01', endDate: '2026-06-03' },
  { weeklyOffDays: SAT_SUN, holidays: [holiday('2026-06-02')], leaveType: { countryCode: 'NZ' } });
near('6 NZ interior public holiday NOT debited = 2', 2, nzHol.units);
// the holiday day is reported but not charged
check('6b NZ holiday day kind=HOLIDAY frac 0', { kind: 'HOLIDAY', fraction: 0 },
  (() => { const d = nzHol.dayBreakdown.find((x) => x.date === '2026-06-02'); return { kind: d.kind, fraction: d.fraction }; })());

// ── explicit sandwichPolicy override beats countryCode ───────────────────────
near('7 explicit EXCLUSIVE on IN type = 2', 2,
  C.computeLeaveUnits({ startDate: '2026-06-01', endDate: '2026-06-03' },
    { weeklyOffDays: SAT_SUN, holidays: [holiday('2026-06-02')], leaveType: { countryCode: 'IN', sandwichPolicy: 'EXCLUSIVE' } }).units);

// ── half-day fractions ────────────────────────────────────────────────────────
// single working day, first-half only = 0.5
near('8 single day startHalf = 0.5', 0.5,
  C.computeLeaveUnits({ startDate: '2026-06-01', endDate: '2026-06-01', startHalf: 'FIRST_HALF' }, { weeklyOffDays: SAT_SUN, leaveType: { countryCode: 'IN' } }).units);
// Mon..Wed with endHalf on Wed = 1 + 1 + 0.5 = 2.5
near('9 endHalf on last day = 2.5', 2.5,
  C.computeLeaveUnits({ startDate: '2026-06-01', endDate: '2026-06-03', endHalf: 'SECOND_HALF' }, { weeklyOffDays: SAT_SUN, leaveType: { countryCode: 'IN' } }).units);
// both boundaries half: Mon startHalf + Wed endHalf = 0.5 + 1 + 0.5 = 2.0
near('10 both boundary halves = 2.0', 2.0,
  C.computeLeaveUnits({ startDate: '2026-06-01', endDate: '2026-06-03', startHalf: 'FIRST_HALF', endHalf: 'SECOND_HALF' }, { weeklyOffDays: SAT_SUN, leaveType: { countryCode: 'IN' } }).units);

// ── invalid range ─────────────────────────────────────────────────────────────
check('11 end before start = null units', null,
  C.computeLeaveUnits({ startDate: '2026-06-05', endDate: '2026-06-01' }, { weeklyOffDays: SAT_SUN, leaveType: {} }).units);

// ── consecutiveCalendarDays (raw span for maxConsecutive) ─────────────────────
check('12 raw span Mon..next-Mon = 8', 8, C.consecutiveCalendarDays({ startDate: '2026-06-01', endDate: '2026-06-08' }));

console.log(`\ncalendar: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of fails) console.error('FAIL', f.name, JSON.stringify(f)); process.exit(1); }

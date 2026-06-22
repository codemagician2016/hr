'use strict';

/*
 * derive.golden.test.js — INDEPENDENT QA golden test for the attendance
 * derivation core (../derive.js). Plain-node (built-in assert, no jest):
 *   node backend/src/hr/attendance/__tests__/derive.golden.test.js
 *
 * Every expected value is hand-derived from docs/features/02 §4.1 (the Step-B
 * decision table + the worked examples in §7.1). The engine internals were NOT
 * read back to fill expecteds. Times are UTC instants; worked minutes are
 * elapsed real time (so DST is correct without a tz lib).
 */

const assert = require('assert');
const { derive } = require('../derive.js');

let passed = 0;
let failed = 0;
const fails = [];
function check(name, expected, actual) {
  let ok;
  try { assert.deepStrictEqual(actual, expected); ok = true; } catch (_) { ok = false; }
  if (ok) { passed++; } else { failed++; fails.push({ name, expected, actual }); }
}

// ── builders ────────────────────────────────────────────────────────────────
const D = '2026-06-01';
const at = (hhmmss, day = D) => `${day}T${hhmmss}Z`;
const P = (punchType, punchAt) => ({ punchType, punchAt });
const sched = (over = {}) => ({
  startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceInMinutes: 10,
  fullDayMinutes: 480, halfDayThresholdMinutes: 240, requireBothPunches: true, ...over,
});
const otRule = (over = {}) => ({
  dailyThresholdMin: 480, weekdayMultiplier: 1.0, weeklyOffMultiplier: 2.0,
  holidayMultiplier: 2.0, roundingMin: 0, ...over,
});
// pull the comparable subset
const pick = (r) => ({ status: r.status, lopFraction: r.lopFraction, workedMinutes: r.workedMinutes });

// 1 — PRESENT full day: 09:00→18:00 gross 540, −60 break ⇒ worked 480 ⇒ PRESENT
check('1 PRESENT full day',
  { status: 'PRESENT', lopFraction: 0, workedMinutes: 480 },
  pick(derive({ date: D, schedule: sched(), punches: [P('IN', at('09:00:00')), P('OUT', at('18:00:00'))] })));

// 2 — LATE_IN flag but status PRESENT: IN 09:25→OUT 19:00 gross 575, −60 ⇒ 515 ⇒ PRESENT; late > grace 10
{
  const r = derive({
    date: D, schedule: sched(), scheduledStart: at('09:00:00'), scheduledEnd: at('18:00:00'),
    punches: [P('IN', at('09:25:00')), P('OUT', at('19:00:00'))],
  });
  check('2 LATE_IN status', { status: 'PRESENT', lopFraction: 0, workedMinutes: 515 }, pick(r));
  check('2 LATE_IN flag', true, r.exceptions.includes('LATE_IN'));
}

// 3 — HALF_DAY by threshold: worked 250 (break 0), halfThreshold 240 ⇒ HALF_DAY 0.5
check('3 HALF_DAY threshold',
  { status: 'HALF_DAY', lopFraction: 0.5, workedMinutes: 250 },
  pick(derive({ date: D, schedule: sched({ breakMinutes: 0 }), punches: [P('IN', at('09:00:00')), P('OUT', at('13:10:00'))] })));

// 4 — ABSENT: scheduled day, no punches
check('4 ABSENT',
  { status: 'ABSENT', lopFraction: 1, workedMinutes: 0 },
  pick(derive({ date: D, schedule: sched(), punches: [] })));

// 5 — leave ≠ absent (paid): full-day leave affectsLOP=false ⇒ ON_LEAVE 0
check('5 ON_LEAVE paid',
  { status: 'ON_LEAVE', lopFraction: 0, workedMinutes: 0 },
  pick(derive({ date: D, schedule: sched(), punches: [], leave: { fraction: 1, affectsLOP: false } })));

// 6 — leave ≠ absent (unpaid): full-day leave affectsLOP=true ⇒ ON_LEAVE 1 (NOT absent)
check('6 ON_LEAVE unpaid',
  { status: 'ON_LEAVE', lopFraction: 1, workedMinutes: 0 },
  pick(derive({ date: D, schedule: sched(), punches: [], leave: { fraction: 1, affectsLOP: true } })));

// 7 — HOLIDAY, no punches
check('7 HOLIDAY',
  { status: 'HOLIDAY', lopFraction: 0, workedMinutes: 0 },
  pick(derive({ date: D, schedule: sched(), punches: [], holiday: { isPaid: true } })));

// 8 — HOLIDAY_WORKED: holiday + worked 480, OT at holidayMultiplier 2 ⇒ otEq 16.0
{
  const r = derive({
    date: D, schedule: sched({ otEligible: true }), otRule: otRule(),
    holiday: { isPaid: true }, punches: [P('IN', at('09:00:00')), P('OUT', at('18:00:00'))],
  });
  check('8 HOLIDAY_WORKED', { status: 'HOLIDAY_WORKED', lopFraction: 0, workedMinutes: 480 }, pick(r));
  check('8 HOLIDAY_WORKED OT', 16, r.otEquivalentHours);
}

// 9 — WEEKLY_OFF, no punches
check('9 WEEKLY_OFF',
  { status: 'WEEKLY_OFF', lopFraction: 0, workedMinutes: 0 },
  pick(derive({ date: D, schedule: sched(), punches: [], weeklyOff: true })));

// 10 — weekly-off worked ⇒ HOLIDAY_WORKED, OT at weeklyOffMultiplier 2 ⇒ otEq 16.0
{
  const r = derive({
    date: D, schedule: sched({ otEligible: true }), otRule: otRule(),
    weeklyOff: true, punches: [P('IN', at('09:00:00')), P('OUT', at('18:00:00'))],
  });
  check('10 weekly-off worked', { status: 'HOLIDAY_WORKED', lopFraction: 0, workedMinutes: 480 }, pick(r));
  check('10 weekly-off OT', 16, r.otEquivalentHours);
}

// 11 — night shift over midnight: 22:00 D → 06:00 D+1, break 0 ⇒ worked 480, single date D
{
  const r = derive({
    date: D, schedule: sched({ breakMinutes: 0, crossesMidnight: true, isNightShift: true }),
    punches: [P('IN', at('22:00:00', D)), P('OUT', at('06:00:00', '2026-06-02'))],
  });
  check('11 night shift', { status: 'PRESENT', lopFraction: 0, workedMinutes: 480 }, pick(r));
}

// 12 — NZ DST night: two instants 8h apart in REAL time (civil clock fell back) ⇒ worked 480
//      (a naive civil-clock diff would wrongly give 540)
check('12 DST elapsed UTC',
  { status: 'PRESENT', lopFraction: 0, workedMinutes: 480 },
  pick(derive({
    date: '2026-04-05', schedule: sched({ breakMinutes: 0, crossesMidnight: true }),
    punches: [P('IN', '2026-04-05T13:00:00Z'), P('OUT', '2026-04-05T21:00:00Z')],
  })));

// 13 — half-day leave + present other half: SECOND_HALF unpaid leave + worked 240 ⇒ HALF_DAY 0.5
check('13a half-day leave unpaid + present',
  { status: 'HALF_DAY', lopFraction: 0.5, workedMinutes: 240 },
  pick(derive({
    date: D, schedule: sched({ breakMinutes: 0, minMinutesForPresent: 240 }),
    leave: { fraction: 0.5, affectsLOP: true, half: 'SECOND_HALF' },
    punches: [P('IN', at('09:00:00')), P('OUT', at('13:00:00'))],
  })));
// 13b — paid half ⇒ lop 0
check('13b half-day leave paid + present',
  { status: 'HALF_DAY', lopFraction: 0, workedMinutes: 240 },
  pick(derive({
    date: D, schedule: sched({ breakMinutes: 0, minMinutesForPresent: 240 }),
    leave: { fraction: 0.5, affectsLOP: false, half: 'SECOND_HALF' },
    punches: [P('IN', at('09:00:00')), P('OUT', at('13:00:00'))],
  })));

// 14 — MISSING_PUNCH then regularize: IN only ⇒ MISSING_PUNCH; add OUT ⇒ PRESENT
{
  const before = derive({ date: D, schedule: sched(), punches: [P('IN', at('09:00:00'))] });
  check('14a MISSING_PUNCH', { status: 'MISSING_PUNCH', lopFraction: 0, workedMinutes: 0 }, pick(before));
  check('14a flag', true, before.exceptions.includes('MISSING_PUNCH'));
  const after = derive({ date: D, schedule: sched(), punches: [P('IN', at('09:00:00')), P('OUT', at('18:00:00'))] });
  check('14b regularized PRESENT', { status: 'PRESENT', lopFraction: 0, workedMinutes: 480 }, pick(after));
}

// 15 — OT daily threshold: worked 600, threshold 480, weekday ×1.5 ⇒ otRaw 120, otEq 3.0
{
  const r = derive({
    date: D, schedule: sched({ breakMinutes: 0, otEligible: true, dailyOtThresholdMin: 480 }),
    otRule: otRule({ weekdayMultiplier: 1.5 }),
    punches: [P('IN', at('09:00:00')), P('OUT', at('19:00:00'))],
  });
  check('15 OT present', { status: 'PRESENT', lopFraction: 0, workedMinutes: 600 }, pick(r));
  check('15 OT minutes', 120, r.overtimeMinutes);
  check('15 OT equiv hours', 3, r.otEquivalentHours);
}

// 16 — no schedule (open attendance): any punch ⇒ PRESENT; no punch ⇒ null status
check('16a open-attendance present',
  { status: 'PRESENT', lopFraction: 0, workedMinutes: 480 },
  pick(derive({ date: D, schedule: null, punches: [P('IN', at('09:00:00')), P('OUT', at('17:00:00'))] })));
check('16b open-attendance excluded',
  { status: null, lopFraction: 0, workedMinutes: 0 },
  pick(derive({ date: D, schedule: null, punches: [] })));

// 17 — WFH approved ⇒ WORK_FROM_HOME
check('17 WFH',
  { status: 'WORK_FROM_HOME', lopFraction: 0, workedMinutes: 0 },
  pick(derive({ date: D, schedule: sched(), punches: [], presence: { wfh: true } })));

// 18 — idempotency: same ctx ⇒ identical DerivedDay
{
  const ctx = { date: D, schedule: sched(), punches: [P('IN', at('09:00:00')), P('OUT', at('18:00:00'))] };
  check('18 idempotent', derive(ctx), derive(ctx));
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nderive goldens: ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of fails) {
    console.log(`  ✗ ${f.name}\n     expected ${JSON.stringify(f.expected)}\n     actual   ${JSON.stringify(f.actual)}`);
  }
  console.log('\n=== DERIVE GOLDENS FAILED ===');
  process.exit(1);
} else {
  console.log('=== ALL DERIVE GOLDENS PASSED ===');
}

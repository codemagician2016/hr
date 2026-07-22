'use strict';

/*
 * scheduleDue.unit.test.js — Reports Platform schedule due-ness windows
 * (reportScheduleRunner.js pure math). Plain-node, NO DB:
 *   node backend/src/hr/reports/__tests__/scheduleDue.unit.test.js
 *
 * Covers: DAILY/WEEKLY/MONTHLY window matching on hourUtc + anchor, the
 * MONTHLY short-month clamp (31 → Feb 28), the lastRunAt within-window dedupe,
 * and recipient parsing.
 */

const assert = require('assert');
const runner = require('../reportScheduleRunner');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

function utc(iso) { return new Date(iso); }

async function main() {
  const { computeWindowStart, isScheduleDue, daysInMonthUtc, parseRecipients } = runner;

  /* ── daysInMonthUtc ── */
  {
    ok('Feb 2026 has 28 days', daysInMonthUtc(2026, 1) === 28);
    ok('Feb 2028 (leap) has 29 days', daysInMonthUtc(2028, 1) === 29);
    ok('Apr has 30 days', daysInMonthUtc(2026, 3) === 30);
    ok('Jul has 31 days', daysInMonthUtc(2026, 6) === 31);
  }

  /* ── DAILY: fires in its hour, any minute; other hours closed ── */
  {
    const s = { cronPreset: 'DAILY', hourUtc: 6 };
    const w = computeWindowStart(s, utc('2026-07-23T06:25:00Z'));
    ok('daily window opens at the hour', w && w.toISOString() === '2026-07-23T06:00:00.000Z');
    ok('daily due late in the hour too', computeWindowStart(s, utc('2026-07-23T06:59:59Z')) !== null);
    ok('daily closed the hour after', computeWindowStart(s, utc('2026-07-23T07:00:00Z')) === null);
    ok('daily closed the hour before', computeWindowStart(s, utc('2026-07-23T05:59:59Z')) === null);
  }

  /* ── WEEKLY: anchor = dayOfWeek (Sun=0), default Monday ── */
  {
    // 2026-07-23 is a Thursday (UTC day 4); 2026-07-20 is a Monday.
    const thu = { cronPreset: 'WEEKLY', anchor: 4, hourUtc: 9 };
    ok('weekly fires on its weekday', computeWindowStart(thu, utc('2026-07-23T09:10:00Z')) !== null);
    ok('weekly closed on other weekdays', computeWindowStart(thu, utc('2026-07-22T09:10:00Z')) === null);
    ok('weekly closed off-hour on the right day', computeWindowStart(thu, utc('2026-07-23T10:10:00Z')) === null);
    const defAnchor = { cronPreset: 'WEEKLY', anchor: null, hourUtc: 9 };
    ok('weekly default anchor = Monday', computeWindowStart(defAnchor, utc('2026-07-20T09:00:00Z')) !== null);
    ok('weekly default anchor not Thursday', computeWindowStart(defAnchor, utc('2026-07-23T09:00:00Z')) === null);
    ok('weekly bad anchor fails closed', computeWindowStart({ cronPreset: 'WEEKLY', anchor: 9, hourUtc: 9 }, utc('2026-07-23T09:00:00Z')) === null);
  }

  /* ── MONTHLY: anchor = dayOfMonth, clamped to short months ── */
  {
    const m15 = { cronPreset: 'MONTHLY', anchor: 15, hourUtc: 7 };
    ok('monthly fires on its day', computeWindowStart(m15, utc('2026-07-15T07:30:00Z')) !== null);
    ok('monthly closed on other days', computeWindowStart(m15, utc('2026-07-16T07:30:00Z')) === null);

    const m31 = { cronPreset: 'MONTHLY', anchor: 31, hourUtc: 7 };
    ok('anchor 31 fires on Jul 31', computeWindowStart(m31, utc('2026-07-31T07:00:00Z')) !== null);
    ok('anchor 31 CLAMPS to Feb 28', computeWindowStart(m31, utc('2026-02-28T07:00:00Z')) !== null);
    ok('anchor 31 clamps to Apr 30', computeWindowStart(m31, utc('2026-04-30T07:00:00Z')) !== null);
    ok('anchor 31 not due Apr 29', computeWindowStart(m31, utc('2026-04-29T07:00:00Z')) === null);
    ok('anchor 31 clamps to leap Feb 29', computeWindowStart(m31, utc('2028-02-29T07:00:00Z')) !== null);
    ok('anchor 31 not due leap Feb 28', computeWindowStart(m31, utc('2028-02-28T07:00:00Z')) === null);

    const defAnchor = { cronPreset: 'MONTHLY', anchor: null, hourUtc: 7 };
    ok('monthly default anchor = 1st', computeWindowStart(defAnchor, utc('2026-08-01T07:00:00Z')) !== null);
    ok('monthly bad anchor fails closed', computeWindowStart({ cronPreset: 'MONTHLY', anchor: 0, hourUtc: 7 }, utc('2026-07-01T07:00:00Z')) === null);
  }

  /* ── junk fails closed ── */
  {
    ok('unknown preset fails closed', computeWindowStart({ cronPreset: 'HOURLY', hourUtc: 7 }, utc('2026-07-23T07:00:00Z')) === null);
    ok('bad hourUtc fails closed', computeWindowStart({ cronPreset: 'DAILY', hourUtc: 24 }, utc('2026-07-23T07:00:00Z')) === null);
    ok('missing schedule fails closed', computeWindowStart(null, utc('2026-07-23T07:00:00Z')) === null);
    ok('invalid date fails closed', computeWindowStart({ cronPreset: 'DAILY', hourUtc: 7 }, new Date('nope')) === null);
  }

  /* ── isScheduleDue: lastRunAt dedupe inside the window ── */
  {
    const base = { cronPreset: 'DAILY', hourUtc: 6 };
    const now = utc('2026-07-23T06:25:00Z');

    const fresh = isScheduleDue({ ...base, lastRunAt: null }, now);
    ok('never-run schedule is due in window', fresh.due === true);
    ok('due carries the window start', fresh.windowStart.toISOString() === '2026-07-23T06:00:00.000Z');

    const ranYesterday = isScheduleDue({ ...base, lastRunAt: utc('2026-07-22T06:25:00Z') }, now);
    ok('yesterday run → due again today', ranYesterday.due === true);

    const ranThisWindow = isScheduleDue({ ...base, lastRunAt: utc('2026-07-23T06:05:00Z') }, now);
    ok('already served this window → not due', ranThisWindow.due === false);

    const ranAtWindowStart = isScheduleDue({ ...base, lastRunAt: utc('2026-07-23T06:00:00Z') }, now);
    ok('run exactly at window start → not due', ranAtWindowStart.due === false);

    const outOfWindow = isScheduleDue({ ...base, lastRunAt: null }, utc('2026-07-23T08:00:00Z'));
    ok('outside the window → not due regardless of lastRunAt', outOfWindow.due === false && outOfWindow.windowStart === null);

    // A manual run-now LATER the same day (after the window) must not make the
    // next day's window skip: lastRunAt after window start but before the NEXT
    // window is still < next windowStart.
    const nextDay = isScheduleDue({ ...base, lastRunAt: utc('2026-07-23T15:00:00Z') }, utc('2026-07-24T06:10:00Z'));
    ok('manual run-now yesterday → still due next window', nextDay.due === true);
  }

  /* ── WEEKLY/MONTHLY dedupe uses the same window stamp ── */
  {
    const weekly = { cronPreset: 'WEEKLY', anchor: 4, hourUtc: 9, lastRunAt: utc('2026-07-16T09:20:00Z') };
    ok('last week run → due this week', isScheduleDue(weekly, utc('2026-07-23T09:05:00Z')).due === true);
    const monthly = { cronPreset: 'MONTHLY', anchor: 31, hourUtc: 7, lastRunAt: utc('2026-01-31T07:10:00Z') };
    ok('Jan 31 run → due again on clamped Feb 28', isScheduleDue(monthly, utc('2026-02-28T07:10:00Z')).due === true);
  }

  /* ── parseRecipients: trims + filters invalid ── */
  {
    const got = parseRecipients(['ops@acme.com', ' hr@acme.co.in ', 'nope', '', null, 'a@b', 'x y@z.com']);
    ok('valid emails kept + trimmed', got.join(',') === 'ops@acme.com,hr@acme.co.in');
    ok('non-array → empty', parseRecipients('ops@acme.com').length === 0);
  }

  console.log(`scheduleDue.unit: ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });

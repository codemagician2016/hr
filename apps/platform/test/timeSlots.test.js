// Tests for the calendar time-slot math used by drag-and-drop reschedule
// in WeekCalendar. Pure functions, no DOM.

import { describe, test, expect } from 'vitest';
import { toMinutes, fromMinutes, snapDropMinutes } from '../lib/timeSlots.js';

describe('toMinutes', () => {
  test('parses common HH:MM strings', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('09:30')).toBe(570);
    expect(toMinutes('23:45')).toBe(23 * 60 + 45);
  });

  test('returns NaN for malformed input', () => {
    expect(Number.isNaN(toMinutes('9-30'))).toBe(true);
    expect(Number.isNaN(toMinutes(null))).toBe(true);
    expect(Number.isNaN(toMinutes(undefined))).toBe(true);
    expect(Number.isNaN(toMinutes(''))).toBe(true);
  });
});

describe('fromMinutes', () => {
  test('formats with leading zeros', () => {
    expect(fromMinutes(0)).toBe('00:00');
    expect(fromMinutes(570)).toBe('09:30');
    expect(fromMinutes(23 * 60 + 45)).toBe('23:45');
  });

  test('rounds non-integer minutes', () => {
    expect(fromMinutes(570.4)).toBe('09:30');
    expect(fromMinutes(570.6)).toBe('09:31');
  });

  test('clamps below 0', () => {
    expect(fromMinutes(-5)).toBe('00:00');
  });

  test('clamps at end of day', () => {
    expect(fromMinutes(24 * 60)).toBe('23:59');
  });
});

describe('snapDropMinutes', () => {
  // Calendar config: 60 px per hour, visible 7am–9pm.
  const cfg = { hourHeight: 60, startHour: 7, endHour: 21, durationMin: 30, snapMin: 15 };

  test('y=0 → start of visible window (7am)', () => {
    expect(snapDropMinutes({ ...cfg, yPx: 0 })).toBe(7 * 60);
  });

  test('y=60 (one hour) → 8am', () => {
    expect(snapDropMinutes({ ...cfg, yPx: 60 })).toBe(8 * 60);
  });

  test('snaps to 15-min boundaries (rounds to nearest)', () => {
    // 11 min after 7am → closer to :15 (vs :00) → 7:15
    expect(snapDropMinutes({ ...cfg, yPx: 11 })).toBe(7 * 60 + 15);
    // 22 min → midpoint of :15 and :30 is :22.5, so 22 rounds to :15
    expect(snapDropMinutes({ ...cfg, yPx: 22 })).toBe(7 * 60 + 15);
    // 23 min → just over the midpoint → 7:30
    expect(snapDropMinutes({ ...cfg, yPx: 23 })).toBe(7 * 60 + 30);
    // 7 min → closer to :00 than :15 → 7:00
    expect(snapDropMinutes({ ...cfg, yPx: 7 })).toBe(7 * 60);
  });

  test('clamps so a 30-min appointment cannot end after the visible 9pm', () => {
    // y way past the bottom — would snap to e.g. 23:00
    const tooLate = snapDropMinutes({ ...cfg, yPx: 9999 });
    // Latest valid start is 21:00 - 30 = 20:30
    expect(tooLate).toBe(20 * 60 + 30);
  });

  test('clamps the top — y negative cannot snap before 7am', () => {
    expect(snapDropMinutes({ ...cfg, yPx: -50 })).toBe(7 * 60);
  });

  test('respects different durations when computing the bottom clamp', () => {
    // 90-min appointment dropped at the very bottom → start no later than 19:30
    const sixtyMin = snapDropMinutes({ ...cfg, durationMin: 60, yPx: 9999 });
    const ninetyMin = snapDropMinutes({ ...cfg, durationMin: 90, yPx: 9999 });
    expect(sixtyMin).toBe(20 * 60); // 20:00 + 60 = 21:00
    expect(ninetyMin).toBe(19 * 60 + 30); // 19:30 + 90 = 21:00
  });

  test('respects a custom snap interval', () => {
    // 5-min snap, y=11 → 7:10
    expect(snapDropMinutes({ ...cfg, snapMin: 5, yPx: 11 })).toBe(7 * 60 + 10);
    // 30-min snap, y=22 → 7:30 (rounds nearest)
    expect(snapDropMinutes({ ...cfg, snapMin: 30, yPx: 22 })).toBe(7 * 60 + 30);
  });
});

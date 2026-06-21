// Slot generator unit tests. The pure function under test
// (generateSlotsForWindows) does ALL the per-staff slot math without
// touching prisma — windows in, slots out. The surrounding DB I/O
// (leave, schedules, existing appointments) lives in computeStaffSlots
// which calls this and is integration-tested elsewhere.

const {
  generateSlotsForWindows,
  SLOT_GRANULARITY_MIN,
} = require('../src/booking/controllers/booking.controller');

const m = (h, mins = 0) => h * 60 + mins; // helper: hours → minutes
const NINE_TO_FIVE = [[m(9), m(17)]];     // 9:00–17:00 single window

describe('generateSlotsForWindows — duration drives the step (the bug fix)', () => {
  test('15-min service keeps 15-min granularity (no behavior change for short services)', () => {
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 15, existingRanges: [], isToday: false, nowMins: 0,
    });
    // 9:00, 9:15, 9:30, ... 16:45 → 32 candidate starts in 8 hours
    expect(slots.length).toBe(32);
    expect(slots[0]).toBe('09:00');
    expect(slots[1]).toBe('09:15');
    expect(slots[slots.length - 1]).toBe('16:45');
  });

  test('30-min service steps by 30 minutes (NOT 15)', () => {
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 30, existingRanges: [], isToday: false, nowMins: 0,
    });
    expect(slots).toEqual([
      '09:00', '09:30', '10:00', '10:30',
      '11:00', '11:30', '12:00', '12:30',
      '13:00', '13:30', '14:00', '14:30',
      '15:00', '15:30', '16:00', '16:30',
    ]);
  });

  test('60-min service produces hourly slots', () => {
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 60, existingRanges: [], isToday: false, nowMins: 0,
    });
    expect(slots).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  });

  test('3-hour (180-min) service in 9:00–17:00 fits exactly two starts (9:00 and 12:00)', () => {
    // The user-reported bug: pre-fix this returned 32 slots (9:00,
    // 9:15, 9:30, …) for an 8-hour day. Post-fix it returns only
    // starts where the full 3-hour service still fits inside the
    // window — 9:00 → 12:00, 12:00 → 15:00. A 15:00 start would end
    // at 18:00 (past the 17:00 close), so it's correctly excluded.
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 180, existingRanges: [], isToday: false, nowMins: 0,
    });
    expect(slots).toEqual(['09:00', '12:00']);
  });

  test('3-hour service in a 9:00–18:00 window does fit three starts', () => {
    // Same logic, just a longer window — confirms the math is right.
    const slots = generateSlotsForWindows({
      windows: [[m(9), m(18)]], duration: 180,
      existingRanges: [], isToday: false, nowMins: 0,
    });
    expect(slots).toEqual(['09:00', '12:00', '15:00']);
  });

  test('granularity is the floor: a 5-min service still steps by 15', () => {
    // We don't allow ridiculously fine-grained slot grids even if the
    // service is very short — keeps URLs clean and prevents UI clutter.
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 5, existingRanges: [], isToday: false, nowMins: 0,
    });
    // First three starts should be 9:00, 9:15, 9:30 — not 9:00, 9:05, 9:10.
    expect(slots.slice(0, 3)).toEqual(['09:00', '09:15', '09:30']);
  });
});

describe('generateSlotsForWindows — overlap detection', () => {
  test('an existing 10:00–11:00 booking removes 10:00 from a 60-min service', () => {
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 60,
      existingRanges: [[m(10), m(11)]],
      isToday: false, nowMins: 0,
    });
    expect(slots).not.toContain('10:00');
    expect(slots).toContain('09:00');
    expect(slots).toContain('11:00');
  });

  test('overlap blocks all start times whose duration would clash, not just exact matches', () => {
    // 30-min service with an existing 10:15–10:45 booking. With a
    // 30-min step we never propose 10:15, but we ALSO must not propose
    // 10:00 (its 30-min slot would run 10:00–10:30 and overlap 10:15).
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 30,
      existingRanges: [[m(10, 15), m(10, 45)]],
      isToday: false, nowMins: 0,
    });
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30'); // 10:30+30 = 11:00, overlaps 10:45 end
    expect(slots).toContain('09:30');     // 09:30+30 = 10:00, just touches, OK
    expect(slots).toContain('11:00');
  });

  test('a 9:00–12:00 booking blocks the 9:00 start of a 3-hour service in 9:00–17:00', () => {
    // Step = 180. Candidates are 9:00, 12:00, 15:00.
    // - 9:00 conflicts with [9:00,12:00] → excluded.
    // - 12:00 doesn't overlap → kept.
    // - 15:00 would end at 18:00 (past 17:00) → excluded by the fit check.
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 180,
      existingRanges: [[m(9), m(12)]],
      isToday: false, nowMins: 0,
    });
    expect(slots).toEqual(['12:00']);
  });
});

describe('generateSlotsForWindows — today + booking buffer', () => {
  test('past-today slots are filtered out', () => {
    // Pretend now = 11:00 with a 15-min booking buffer. A 60-min
    // service should not propose 10:00 or 11:00 (within the buffer).
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 60,
      existingRanges: [], isToday: true, nowMins: m(11),
    });
    expect(slots).not.toContain('09:00');
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('11:00'); // exactly at "now" — buffer excludes it
    expect(slots[0]).toBe('12:00');
  });

  test('isToday=false ignores nowMins entirely', () => {
    const slots = generateSlotsForWindows({
      windows: NINE_TO_FIVE, duration: 60,
      existingRanges: [], isToday: false, nowMins: m(23),
    });
    expect(slots[0]).toBe('09:00');
  });
});

describe('generateSlotsForWindows — multi-window days (lunch break style)', () => {
  test('two windows split by lunch produce slots in both', () => {
    const slots = generateSlotsForWindows({
      windows: [[m(9), m(12)], [m(13), m(17)]], // 1pm lunch break
      duration: 60,
      existingRanges: [], isToday: false, nowMins: 0,
    });
    expect(slots).toEqual(['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00']);
  });
});

describe('generateSlotsForWindows — edge cases', () => {
  test('service longer than the window produces no slots', () => {
    const slots = generateSlotsForWindows({
      windows: [[m(9), m(11)]],
      duration: 180,
      existingRanges: [], isToday: false, nowMins: 0,
    });
    expect(slots).toEqual([]);
  });

  test('empty windows array produces no slots', () => {
    const slots = generateSlotsForWindows({
      windows: [], duration: 30, existingRanges: [], isToday: false, nowMins: 0,
    });
    expect(slots).toEqual([]);
  });

  test('granularity constant is exposed for callers that want to keep it in sync', () => {
    expect(SLOT_GRANULARITY_MIN).toBe(15);
  });
});

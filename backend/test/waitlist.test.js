// Tests for the pure waitlist matcher. No DB.

const { matchesFreedSlot, ACTIVE_WAITLIST_STATUSES } = require('../src/core/lib/waitlist');

const NOW = new Date('2026-04-25T10:00:00.000Z');
const FUTURE = new Date('2026-05-25T00:00:00.000Z');
const PAST = new Date('2026-04-20T00:00:00.000Z');

function freed(overrides = {}) {
  return {
    businessId: 'biz-1',
    serviceId: 'svc-1',
    staffId: 'st-1',
    date: '2026-05-10T00:00:00.000Z',
    startTime: '14:00',
    endTime: '14:30',
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    businessId: 'biz-1',
    status: 'PENDING',
    expiresAt: FUTURE,
    preferredDate: '2026-05-10T00:00:00.000Z',
    preferredStartTime: null,
    preferredEndTime: null,
    serviceId: null,
    staffId: null,
    ...overrides,
  };
}

describe('matchesFreedSlot — basic match', () => {
  test('matches when row is fully permissive', () => {
    expect(matchesFreedSlot(freed(), row(), NOW)).toBe(true);
  });

  test('businessId mismatch blocks match', () => {
    expect(matchesFreedSlot(freed({ businessId: 'biz-2' }), row(), NOW)).toBe(false);
  });

  test('inactive statuses do not match', () => {
    for (const s of ['CONVERTED', 'DISMISSED', 'EXPIRED']) {
      expect(matchesFreedSlot(freed(), row({ status: s }), NOW)).toBe(false);
    }
  });

  test('NOTIFIED still eligible (we re-notify on additional matches)', () => {
    expect(matchesFreedSlot(freed(), row({ status: 'NOTIFIED' }), NOW)).toBe(true);
  });

  test('expired rows do not match', () => {
    expect(matchesFreedSlot(freed(), row({ expiresAt: PAST }), NOW)).toBe(false);
  });

  test('different preferred date does not match', () => {
    expect(matchesFreedSlot(freed(), row({ preferredDate: '2026-05-11T00:00:00.000Z' }), NOW)).toBe(false);
  });
});

describe('matchesFreedSlot — service preference', () => {
  test('null serviceId on row matches any service', () => {
    expect(matchesFreedSlot(freed({ serviceId: 'svc-9' }), row({ serviceId: null }), NOW)).toBe(true);
  });

  test('matching serviceId on row matches', () => {
    expect(matchesFreedSlot(freed({ serviceId: 'svc-1' }), row({ serviceId: 'svc-1' }), NOW)).toBe(true);
  });

  test('different serviceId on row does not match', () => {
    expect(matchesFreedSlot(freed({ serviceId: 'svc-1' }), row({ serviceId: 'svc-2' }), NOW)).toBe(false);
  });
});

describe('matchesFreedSlot — staff preference', () => {
  test('null staffId on row matches any staff', () => {
    expect(matchesFreedSlot(freed({ staffId: 'st-9' }), row({ staffId: null }), NOW)).toBe(true);
  });

  test('different staffId on row does not match', () => {
    expect(matchesFreedSlot(freed({ staffId: 'st-1' }), row({ staffId: 'st-2' }), NOW)).toBe(false);
  });
});

describe('matchesFreedSlot — time window', () => {
  test('no time bounds → any time matches', () => {
    expect(matchesFreedSlot(freed({ startTime: '06:00' }), row({ preferredStartTime: null, preferredEndTime: null }), NOW)).toBe(true);
  });

  test('only lower bound: freed start must be >= preferredStartTime', () => {
    expect(matchesFreedSlot(freed({ startTime: '14:00' }), row({ preferredStartTime: '13:00' }), NOW)).toBe(true);
    expect(matchesFreedSlot(freed({ startTime: '12:00' }), row({ preferredStartTime: '13:00' }), NOW)).toBe(false);
  });

  test('only upper bound: freed start must be <= preferredEndTime', () => {
    expect(matchesFreedSlot(freed({ startTime: '14:00' }), row({ preferredEndTime: '15:00' }), NOW)).toBe(true);
    expect(matchesFreedSlot(freed({ startTime: '16:00' }), row({ preferredEndTime: '15:00' }), NOW)).toBe(false);
  });

  test('both bounds: freed start must fall in window', () => {
    const r = row({ preferredStartTime: '13:00', preferredEndTime: '15:00' });
    expect(matchesFreedSlot(freed({ startTime: '14:00' }), r, NOW)).toBe(true);
    expect(matchesFreedSlot(freed({ startTime: '13:00' }), r, NOW)).toBe(true);
    expect(matchesFreedSlot(freed({ startTime: '15:00' }), r, NOW)).toBe(true);
    expect(matchesFreedSlot(freed({ startTime: '15:01' }), r, NOW)).toBe(false);
  });

  test('malformed times fail-safe to no-match', () => {
    expect(matchesFreedSlot(freed({ startTime: 'not-a-time' }), row(), NOW)).toBe(false);
    expect(matchesFreedSlot(freed(), row({ preferredStartTime: 'bogus' }), NOW)).toBe(false);
  });
});

describe('matchesFreedSlot — null safety', () => {
  test('nullish args do not throw', () => {
    expect(matchesFreedSlot(null, row(), NOW)).toBe(false);
    expect(matchesFreedSlot(freed(), null, NOW)).toBe(false);
  });
});

describe('ACTIVE_WAITLIST_STATUSES', () => {
  test('contains exactly PENDING + NOTIFIED', () => {
    expect(ACTIVE_WAITLIST_STATUSES.size).toBe(2);
    expect(ACTIVE_WAITLIST_STATUSES.has('PENDING')).toBe(true);
    expect(ACTIVE_WAITLIST_STATUSES.has('NOTIFIED')).toBe(true);
  });
});

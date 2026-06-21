// Unit tests for the report aggregator. Pure JS, no DB — feeds in
// fixture appointments and asserts on the computed shape.

const { computeReport, priceFor } = require('../src/core/lib/reports');

function appt(overrides = {}) {
  return {
    id: overrides.id || 'a1',
    status: 'COMPLETED',
    date: '2026-04-20T00:00:00.000Z',
    startTime: '10:00',
    endTime: '10:30',
    originalPrice: 50,
    finalPrice: 50,
    serviceId: 'svc-1',
    staffId: 'st-1',
    service: { id: 'svc-1', name: 'Consult', price: 50 },
    staff: { id: 'st-1', name: 'Alice' },
    ...overrides,
  };
}

describe('priceFor', () => {
  test('prefers finalPrice', () => {
    expect(priceFor({ finalPrice: 30, originalPrice: 50, service: { price: 100 } })).toBe(30);
  });

  test('falls back to originalPrice', () => {
    expect(priceFor({ finalPrice: null, originalPrice: 50, service: { price: 100 } })).toBe(50);
  });

  test('falls back to service.price', () => {
    expect(priceFor({ service: { price: 100 } })).toBe(100);
  });

  test('returns 0 when nothing is set', () => {
    expect(priceFor({})).toBe(0);
  });
});

describe('computeReport — empty input', () => {
  test('returns zero summary + empty breakdowns', () => {
    const r = computeReport([]);
    expect(r.summary).toEqual({
      totalRevenue: 0, totalBookings: 0, completed: 0, noShow: 0, cancelled: 0,
      pending: 0, confirmed: 0, completionRate: 0, noShowRate: 0,
    });
    expect(r.byDay).toEqual([]);
    expect(r.byHour).toHaveLength(24);
    expect(r.byHour.every((h) => h.count === 0)).toBe(true);
    expect(r.byService).toEqual([]);
    expect(r.byStaff).toEqual([]);
  });
});

describe('computeReport — revenue + status counting', () => {
  const data = [
    appt({ id: 'a1', status: 'COMPLETED', finalPrice: 100 }),
    appt({ id: 'a2', status: 'CONFIRMED', finalPrice: 50 }),
    appt({ id: 'a3', status: 'PENDING',   finalPrice: 80 }),
    appt({ id: 'a4', status: 'NO_SHOW',   finalPrice: 40 }),
    appt({ id: 'a5', status: 'CANCELLED', finalPrice: 60 }),
  ];

  test('only CONFIRMED + COMPLETED count toward revenue', () => {
    const r = computeReport(data);
    // 100 + 50 = 150 (PENDING / NO_SHOW / CANCELLED don't count)
    expect(r.summary.totalRevenue).toBe(150);
  });

  test('byStatus tally is correct', () => {
    const r = computeReport(data);
    expect(r.byStatus).toEqual({ PENDING: 1, CONFIRMED: 1, COMPLETED: 1, NO_SHOW: 1, CANCELLED: 1 });
  });

  test('completionRate = completed / (pending + confirmed + completed + no_show)', () => {
    // CANCELLED is excluded from the denominator; only finishable bookings count.
    const r = computeReport(data);
    expect(r.summary.completionRate).toBe(0.25); // 1/4
    expect(r.summary.noShowRate).toBe(0.25);
  });
});

describe('computeReport — byDay grouping', () => {
  const data = [
    appt({ id: 'a1', date: '2026-04-20T00:00:00.000Z', status: 'COMPLETED', finalPrice: 100 }),
    appt({ id: 'a2', date: '2026-04-20T00:00:00.000Z', status: 'NO_SHOW',   finalPrice: 50 }),
    appt({ id: 'a3', date: '2026-04-22T00:00:00.000Z', status: 'COMPLETED', finalPrice: 30 }),
  ];

  test('aggregates per-day correctly', () => {
    const r = computeReport(data);
    expect(r.byDay).toHaveLength(2);
    const day1 = r.byDay.find((d) => d.date === '2026-04-20');
    expect(day1).toEqual({ date: '2026-04-20', bookings: 2, revenue: 100, completed: 1, noShow: 1, cancelled: 0 });
    const day2 = r.byDay.find((d) => d.date === '2026-04-22');
    expect(day2.revenue).toBe(30);
  });

  test('byDay is sorted ascending by date', () => {
    const r = computeReport(data);
    expect(r.byDay.map((d) => d.date)).toEqual(['2026-04-20', '2026-04-22']);
  });
});

describe('computeReport — byHour heatmap', () => {
  test('counts by start-hour across 24 buckets', () => {
    const data = [
      appt({ id: 'a1', startTime: '09:00' }),
      appt({ id: 'a2', startTime: '09:30' }),
      appt({ id: 'a3', startTime: '14:00' }),
    ];
    const r = computeReport(data);
    expect(r.byHour.find((h) => h.hour === 9).count).toBe(2);
    expect(r.byHour.find((h) => h.hour === 14).count).toBe(1);
    expect(r.byHour.find((h) => h.hour === 0).count).toBe(0);
    expect(r.byHour).toHaveLength(24);
  });
});

describe('computeReport — byService + byStaff', () => {
  const data = [
    appt({ id: 'a1', serviceId: 'svc-1', service: { id: 'svc-1', name: 'A', price: 50 }, status: 'COMPLETED', finalPrice: 50 }),
    appt({ id: 'a2', serviceId: 'svc-1', service: { id: 'svc-1', name: 'A', price: 50 }, status: 'COMPLETED', finalPrice: 50 }),
    appt({ id: 'a3', serviceId: 'svc-2', service: { id: 'svc-2', name: 'B', price: 200 }, status: 'CONFIRMED', finalPrice: 200 }),
    appt({ id: 'a4', staffId: 'st-2', staff: { id: 'st-2', name: 'Bob' }, serviceId: 'svc-1', service: { id: 'svc-1', name: 'A', price: 50 }, status: 'NO_SHOW', finalPrice: 50 }),
  ];

  test('byService sorted by revenue desc', () => {
    const r = computeReport(data);
    expect(r.byService[0].serviceId).toBe('svc-2'); // 200 > 100
    expect(r.byService[0].revenue).toBe(200);
    expect(r.byService[1].serviceId).toBe('svc-1');
    expect(r.byService[1].revenue).toBe(100);
    expect(r.byService[1].bookings).toBe(3); // includes the no-show
  });

  test('byStaff includes noShowCount', () => {
    const r = computeReport(data);
    const bob = r.byStaff.find((s) => s.staffId === 'st-2');
    expect(bob.noShowCount).toBe(1);
    expect(bob.revenue).toBe(0); // no-show doesn't count as revenue
    const alice = r.byStaff.find((s) => s.staffId === 'st-1');
    expect(alice.noShowCount).toBe(0);
  });
});

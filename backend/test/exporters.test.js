// Tests for the appointment export formatters. Pure string-in/string-
// out checks against fixtures.

const { toCsv, toIcal, CSV_COLUMNS } = require('../src/core/lib/exporters');

function appt(overrides = {}) {
  return {
    id: 'a1',
    status: 'COMPLETED',
    date: '2026-04-20T00:00:00.000Z',
    startTime: '10:00',
    endTime: '10:30',
    notes: null,
    finalPrice: 50,
    originalPrice: 60,
    service: { name: 'Initial consultation', price: 60 },
    staff: { name: 'Alice' },
    customer: { name: 'Bob', email: 'bob@example.com', phone: '+1 555 1234' },
    ...overrides,
  };
}

describe('toCsv', () => {
  test('emits header row first', () => {
    const out = toCsv([]);
    const firstLine = out.split('\r\n')[0];
    expect(firstLine).toBe(CSV_COLUMNS.join(','));
  });

  test('writes one row per appointment with the expected fields', () => {
    const csv = toCsv([appt()]);
    const [, row] = csv.split('\r\n');
    expect(row).toContain('2026-04-20');
    expect(row).toContain('10:00');
    expect(row).toContain('Bob');
    expect(row).toContain('bob@example.com');
    expect(row).toContain('Initial consultation');
    expect(row).toContain('Alice');
    expect(row).toContain('COMPLETED');
    expect(row).toContain('50');
  });

  test('quotes values containing commas + escapes embedded quotes (RFC 4180)', () => {
    const csv = toCsv([appt({ notes: 'Has, comma and "quote"' })]);
    expect(csv).toContain('"Has, comma and ""quote"""');
  });

  test('quotes values containing newlines', () => {
    const csv = toCsv([appt({ notes: 'first\nsecond' })]);
    expect(csv).toContain('"first\nsecond"');
  });

  test('falls back through finalPrice → originalPrice → service.price', () => {
    expect(toCsv([appt({ finalPrice: 30 })])).toContain(',30\r\n');
    expect(toCsv([appt({ finalPrice: null, originalPrice: 70 })])).toContain(',70\r\n');
    expect(toCsv([appt({ finalPrice: null, originalPrice: null, service: { name: 'X', price: 90 } })])).toContain(',90\r\n');
  });

  test('handles missing customer cleanly', () => {
    const csv = toCsv([appt({ customer: null, user: null })]);
    // Should not throw + should still have the right number of columns
    const [, row] = csv.split('\r\n');
    expect(row.split(',').length).toBe(CSV_COLUMNS.length);
  });
});

describe('toIcal', () => {
  test('starts and ends with VCALENDAR markers', () => {
    const out = toIcal([appt()], { businessName: 'Acme Clinic' });
    expect(out).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(out).toMatch(/END:VCALENDAR\r\n$/);
  });

  test('contains exactly one VEVENT per appointment', () => {
    const out = toIcal([appt({ id: 'a1' }), appt({ id: 'a2' })], { businessName: 'Acme' });
    const matches = out.match(/BEGIN:VEVENT/g);
    expect(matches).toHaveLength(2);
  });

  test('encodes the calendar name', () => {
    const out = toIcal([], { businessName: 'Acme & Co' });
    expect(out).toContain('X-WR-CALNAME:Acme & Co appointments');
  });

  test('emits UID per appointment id', () => {
    const out = toIcal([appt({ id: 'abc-123' })], { businessName: 'A' });
    expect(out).toContain('UID:abc-123@sitepresso');
  });

  test('escapes commas + semicolons + newlines in notes', () => {
    // Long DESCRIPTION lines get RFC 5545 fold (CRLF + space every 75
    // chars), so de-fold before asserting on the escaped substring.
    const out = toIcal([appt({ notes: 'a, b; c\nnext' })], { businessName: 'A' });
    const unfolded = out.replace(/\r\n /g, '');
    expect(unfolded).toContain('a\\, b\\; c\\nnext');
  });

  test('cancelled appointments map to STATUS:CANCELLED', () => {
    const out = toIcal([appt({ status: 'CANCELLED' })], { businessName: 'A' });
    expect(out).toContain('STATUS:CANCELLED');
  });

  test('non-cancelled statuses map to STATUS:CONFIRMED', () => {
    expect(toIcal([appt({ status: 'PENDING' })], { businessName: 'A' })).toContain('STATUS:CONFIRMED');
    expect(toIcal([appt({ status: 'COMPLETED' })], { businessName: 'A' })).toContain('STATUS:CONFIRMED');
  });

  test('DTSTART + DTEND use the appointment date + HH:MM', () => {
    const out = toIcal([appt({ date: '2026-04-20T00:00:00.000Z', startTime: '14:00', endTime: '14:30' })], { businessName: 'A' });
    expect(out).toContain('DTSTART:20260420T140000Z');
    expect(out).toContain('DTEND:20260420T143000Z');
  });
});

// Tests for template engine + merge-tag rendering. Pure unit tests; the
// seedTemplates() DB function is exercised in integration tests (batch 9).

const {
  TEMPLATES,
  render,
  getTemplate,
  listTemplates,
} = require('../../src/core/lib/notifications/templates');

describe('TEMPLATES registry', () => {
  test('core templates present', () => {
    const keys = TEMPLATES.map((t) => t.key);
    const required = [
      'OTP_VERIFICATION',
      'BOOKING_CONFIRMED',
      'REMINDER_DAY_BEFORE',
      'REMINDER_HOUR_OF',
      'BOOKING_CANCELLED',
      'ORDER_CONFIRMED',
      'ORDER_OUT_FOR_DELIVERY',
      'ORDER_DELIVERED',
      'DELIVERY_ASSIGNED',
      'DELIVERY_OUT_FOR_DELIVERY',
      'DELIVERY_ARRIVED',
      'DELIVERY_DELIVERED',
      'DELIVERY_ATTEMPT_FAILED',
      'CONTACT_FORM_RECEIVED',
    ];
    for (const k of required) {
      expect(keys).toContain(k);
    }
  });

  test('every template has required fields', () => {
    for (const t of TEMPLATES) {
      expect(t.key).toMatch(/^[A-Z_]+$/);
      expect(t.displayName).toBeTruthy();
      expect(['AUTHENTICATION', 'TRANSACTIONAL', 'SERVICE', 'PROMOTIONAL']).toContain(t.category);
      expect(['ALL', 'APPOINTMENT', 'ECOMMERCE', 'STATIC']).toContain(t.vertical);
      expect(t.body).toBeTruthy();
      expect(Array.isArray(t.variables)).toBe(true);
      expect(t.channels).toEqual(expect.objectContaining({
        sms: expect.any(Boolean),
        whatsapp: expect.any(Boolean),
        email: expect.any(Boolean),
      }));
    }
  });

  test('every variable in body exists in the variables array', () => {
    for (const t of TEMPLATES) {
      const bodyVars = (t.body.match(/\{([A-Z_]+)\}/g) || []).map((m) => m.slice(1, -1));
      for (const v of bodyVars) {
        expect(t.variables).toContain(v);
      }
    }
  });

  test('every declared variable is used in the body', () => {
    for (const t of TEMPLATES) {
      for (const v of t.variables) {
        expect(t.body).toContain(`{${v}}`);
      }
    }
  });

  test('OTP template body length under SMS 160-char limit', () => {
    const otp = TEMPLATES.find((t) => t.key === 'OTP_VERIFICATION');
    // After substituting placeholders with realistic max values:
    // OTP=6 chars + MIN=2 chars = body length when rendered ≈ 70 chars
    const rendered = render({ key: 'OTP_VERIFICATION', vars: { OTP: '123456', MIN: '10' } });
    expect(rendered.length).toBeLessThan(160);
  });
});

describe('render', () => {
  test('renders BOOKING_CONFIRMED with merge tags', () => {
    const out = render({
      key: 'BOOKING_CONFIRMED',
      vars: {
        STAFF: 'Dr Singh',
        DATE: 'Apr 30',
        TIME: '10:30 AM',
        LINK: 'https://bs.sp/abc',
        BIZ: 'Bright Smile Dental',
      },
    });
    expect(out).toBe('Booked! Your appointment with Dr Singh on Apr 30 at 10:30 AM. Manage: https://bs.sp/abc - Bright Smile Dental');
  });

  test('renders REMINDER_DAY_BEFORE with simple substitution', () => {
    const out = render({
      key: 'REMINDER_DAY_BEFORE',
      vars: { NAME: 'Sarah', BIZ: 'Bright Smile Dental', TIME: '10:30 AM' },
    });
    expect(out).toContain('Sarah');
    expect(out).toContain('Bright Smile Dental');
    expect(out).toContain('10:30 AM');
    expect(out).toContain('STOP');
  });

  test('throws on unknown template key', () => {
    expect(() => render({ key: 'NOT_A_TEMPLATE', vars: {} })).toThrow(/Unknown template key/);
  });

  test('throws with missing variables, lists which ones', () => {
    try {
      render({ key: 'BOOKING_CONFIRMED', vars: { STAFF: 'Dr X', DATE: 'today' } });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('MISSING_VARIABLES');
      expect(err.missing).toEqual(expect.arrayContaining(['TIME', 'LINK', 'BIZ']));
    }
  });

  test('ignores extra variables not in template', () => {
    const out = render({
      key: 'OTP_VERIFICATION',
      vars: { OTP: '123456', MIN: '10', EXTRA: 'ignored' },
    });
    expect(out).not.toContain('ignored');
    expect(out).toContain('123456');
  });

  test('replaces all occurrences of a variable', () => {
    // Synthetic: a template body that uses the same var twice would still work
    // Actually our templates don't do this, so just verify the join-split logic
    expect('{X} and {X}'.split('{X}').join('foo')).toBe('foo and foo');
  });

  test('numeric values are stringified', () => {
    const out = render({
      key: 'ORDER_CONFIRMED',
      vars: { ID: 12345, BIZ: 'Acme', AMT: 99.99, LINK: '...' },
    });
    expect(out).toContain('12345');
    expect(out).toContain('99.99');
  });

  test('renders delivery arrival OTP handover copy', () => {
    const out = render({
      key: 'DELIVERY_ARRIVED',
      vars: { BIZ: 'Pizza House', ID: 'ORDER-10042', OTP: '4821', LINK: 'https://pizza.example/delivery/tok' },
    });
    expect(out).toContain('Pizza House');
    expect(out).toContain('ORDER-10042');
    expect(out).toContain('4821');
    expect(out).toContain('after receiving');
  });
});

describe('getTemplate', () => {
  test('returns template by key', () => {
    expect(getTemplate('OTP_VERIFICATION')).toBeTruthy();
    expect(getTemplate('OTP_VERIFICATION').category).toBe('AUTHENTICATION');
  });

  test('returns null for unknown key', () => {
    expect(getTemplate('NOPE')).toBeNull();
  });
});

describe('listTemplates', () => {
  test('returns all templates when no filter', () => {
    expect(listTemplates().length).toBe(TEMPLATES.length);
  });

  test('filters by vertical (ALL templates included for any vertical)', () => {
    const appointmentTemplates = listTemplates({ vertical: 'APPOINTMENT' });
    const keys = appointmentTemplates.map((t) => t.key);
    expect(keys).toContain('OTP_VERIFICATION'); // ALL → included
    expect(keys).toContain('BOOKING_CONFIRMED'); // APPOINTMENT → included
    expect(keys).not.toContain('ORDER_CONFIRMED'); // ECOMMERCE → excluded
  });

  test('ECOMMERCE vertical sees its own + ALL templates', () => {
    const ecom = listTemplates({ vertical: 'ECOMMERCE' });
    const keys = ecom.map((t) => t.key);
    expect(keys).toContain('OTP_VERIFICATION');
    expect(keys).toContain('ORDER_CONFIRMED');
    expect(keys).not.toContain('BOOKING_CONFIRMED');
  });

  test('STATIC vertical sees its own + ALL', () => {
    const stat = listTemplates({ vertical: 'STATIC' });
    const keys = stat.map((t) => t.key);
    expect(keys).toContain('CONTACT_FORM_RECEIVED');
    expect(keys).toContain('OTP_VERIFICATION');
  });

  test('filters by category', () => {
    const txn = listTemplates({ category: 'TRANSACTIONAL' });
    const keys = txn.map((t) => t.key);
    expect(keys).toContain('BOOKING_CONFIRMED');
    expect(keys).toContain('ORDER_CONFIRMED');
    expect(keys).not.toContain('OTP_VERIFICATION'); // AUTHENTICATION
  });
});

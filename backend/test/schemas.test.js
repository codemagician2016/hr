// Zod schema tests. Pure unit tests — no DB, no network, no SES. Safe
// to run in any CI environment without secrets.
const { signupSchema, loginSchema, resetPasswordSchema } = require('../src/core/lib/schemas/signup.schema');
const { createBookingSchema } = require('../src/core/lib/schemas/booking.schema');
const { createServiceSchema, updateServiceSchema } = require('../src/core/lib/schemas/service.schema');

describe('signupSchema', () => {
  const valid = { name: 'Alice', email: 'alice@example.com', password: 'Good1pass', acceptTerms: true };

  test('accepts a well-formed signup', () => {
    const res = signupSchema.safeParse(valid);
    expect(res.success).toBe(true);
  });

  test('trims + lowercases email', () => {
    const res = signupSchema.safeParse({ ...valid, email: '  ALICE@Example.COM  ' });
    expect(res.success).toBe(true);
    expect(res.data.email).toBe('alice@example.com');
  });

  test('rejects disposable emails', () => {
    const res = signupSchema.safeParse({ ...valid, email: 'test@yopmail.com' });
    expect(res.success).toBe(false);
    expect(res.error.issues[0].message).toMatch(/permanent email/i);
  });

  test('rejects weak passwords', () => {
    const cases = ['short', 'alllowercase', 'ALLUPPERCASE', 'NoDigitsHere'];
    for (const p of cases) {
      const res = signupSchema.safeParse({ ...valid, password: p });
      expect(res.success).toBe(false);
    }
  });

  test('rejects acceptTerms = false', () => {
    const res = signupSchema.safeParse({ ...valid, acceptTerms: false });
    expect(res.success).toBe(false);
    expect(res.error.issues[0].message).toMatch(/accept the Terms/i);
  });

  test('caps name length at 120', () => {
    const res = signupSchema.safeParse({ ...valid, name: 'x'.repeat(121) });
    expect(res.success).toBe(false);
  });
});

describe('loginSchema', () => {
  test('minimal valid input passes', () => {
    const res = loginSchema.safeParse({ email: 'ok@gmail.com', password: 'anything' });
    expect(res.success).toBe(true);
  });

  test('empty password rejected', () => {
    const res = loginSchema.safeParse({ email: 'ok@gmail.com', password: '' });
    expect(res.success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  test('requires email + otp + strong password', () => {
    const res = resetPasswordSchema.safeParse({ email: 'x@y.com', otp: '123456', password: 'Good1pass' });
    expect(res.success).toBe(true);
  });

  test('rejects weak password even with valid OTP', () => {
    const res = resetPasswordSchema.safeParse({ email: 'x@y.com', otp: '123456', password: 'weak' });
    expect(res.success).toBe(false);
  });
});

describe('createBookingSchema', () => {
  const valid = { staffId: 'user-uuid', date: '2026-05-01', startTime: '14:00' };

  test('accepts minimal booking payload', () => {
    const res = createBookingSchema.safeParse(valid);
    expect(res.success).toBe(true);
  });

  test('rejects wrong date format', () => {
    const res = createBookingSchema.safeParse({ ...valid, date: '2026/05/01' });
    expect(res.success).toBe(false);
  });

  test('rejects wrong time format', () => {
    const res = createBookingSchema.safeParse({ ...valid, startTime: '2pm' });
    expect(res.success).toBe(false);
  });

  test('caps notes at 500 chars', () => {
    const res = createBookingSchema.safeParse({ ...valid, notes: 'x'.repeat(501) });
    expect(res.success).toBe(false);
  });

  test('allows optional notes', () => {
    const res = createBookingSchema.safeParse({ ...valid, notes: 'Please call at the door' });
    expect(res.success).toBe(true);
  });
});

describe('service schemas', () => {
  test('create requires at least name + duration', () => {
    const res = createServiceSchema.safeParse({ name: 'Haircut', duration: 30 });
    expect(res.success).toBe(true);
  });

  test('create rejects too-short duration', () => {
    const res = createServiceSchema.safeParse({ name: 'Haircut', duration: 5 });
    expect(res.success).toBe(false);
    expect(res.error.issues[0].message).toMatch(/at least 15 minutes/i);
  });

  test('create rejects too-long duration', () => {
    const res = createServiceSchema.safeParse({ name: 'Haircut', duration: 9999 });
    expect(res.success).toBe(false);
  });

  test('update allows partial fields', () => {
    const res = updateServiceSchema.safeParse({ name: 'New name' });
    expect(res.success).toBe(true);
  });

  test('update still rejects negative price', () => {
    const res = updateServiceSchema.safeParse({ price: -10 });
    expect(res.success).toBe(false);
  });

  test('coerces string numbers from form inputs', () => {
    const res = createServiceSchema.safeParse({ name: 'H', duration: '30', price: '49.99' });
    expect(res.success).toBe(true);
    expect(res.data.duration).toBe(30);
    expect(res.data.price).toBe(49.99);
  });
});

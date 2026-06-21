// Tests for Zod wave-2 schemas (the migration of coupon / adminCoupon /
// business.setup / hours / leave / enquiry / customer-OTP endpoints).
// Pure unit tests — no DB.

const {
  createCouponSchema,
  updateCouponSchema,
  validateCouponSchema,
} = require('../src/core/lib/schemas/coupon.schema');
const {
  createAdminCouponSchema,
  updateAdminCouponSchema,
} = require('../src/core/lib/schemas/adminCoupon.schema');
const { setupBusinessSchema, updateBusinessSettingsSchema } = require('../src/core/lib/schemas/business.schema');
const { setHoursSchema, addHolidaySchema } = require('../src/core/lib/schemas/hours.schema');
const { requestLeaveSchema } = require('../src/core/lib/schemas/leave.schema');
const { submitEnquirySchema, updateEnquiryStatusSchema } = require('../src/core/lib/schemas/enquiry.schema');
const { verifyOtpSchema, resendOtpSchema, changePasswordSchema } = require('../src/core/lib/schemas/customer.schema');

// ─── coupon (booking) ──────────────────────────────────────────────────
describe('createCouponSchema', () => {
  const base = { code: 'save10', discountType: 'PERCENTAGE', discountValue: 10, validFrom: '2026-01-01', validUntil: '2026-12-31' };

  test('accepts a well-formed coupon', () => {
    const r = createCouponSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.data.code).toBe('SAVE10'); // uppercased
    expect(r.data.applicableServiceIds).toEqual([]); // defaulted
    expect(r.data.isFirstBookingOnly).toBe(false);
    expect(r.data.validFrom).toBeInstanceOf(Date);
  });

  test('rejects empty code', () => {
    const r = createCouponSchema.safeParse({ ...base, code: '   ' });
    expect(r.success).toBe(false);
  });

  test('rejects PERCENTAGE > 100', () => {
    const r = createCouponSchema.safeParse({ ...base, discountValue: 150 });
    expect(r.success).toBe(false);
    expect(r.error.issues.map((i) => i.message).join('|')).toMatch(/100/);
  });

  test('rejects validUntil <= validFrom', () => {
    const r = createCouponSchema.safeParse({ ...base, validFrom: '2026-12-01', validUntil: '2026-06-01' });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toMatch(/after validFrom/);
  });

  test('rejects negative discountValue', () => {
    const r = createCouponSchema.safeParse({ ...base, discountValue: -5 });
    expect(r.success).toBe(false);
  });
});

describe('updateCouponSchema', () => {
  test('accepts a partial update with just isActive', () => {
    const r = updateCouponSchema.safeParse({ isActive: false });
    expect(r.success).toBe(true);
    expect(r.data.isActive).toBe(false);
  });

  test('still enforces 100% cap on PERCENTAGE updates', () => {
    const r = updateCouponSchema.safeParse({ discountType: 'PERCENTAGE', discountValue: 200 });
    expect(r.success).toBe(false);
  });
});

describe('validateCouponSchema (booking time)', () => {
  test('requires all three fields', () => {
    expect(validateCouponSchema.safeParse({}).success).toBe(false);
    expect(validateCouponSchema.safeParse({ code: 'X' }).success).toBe(false);
    expect(validateCouponSchema.safeParse({ code: 'X', serviceId: 'a', businessSlug: 'b' }).success).toBe(true);
  });
});

// ─── adminCoupon (subscription) ────────────────────────────────────────
describe('createAdminCouponSchema', () => {
  test('LIFETIME_FREE accepted with just code + type', () => {
    const r = createAdminCouponSchema.safeParse({ code: 'foreverfree', benefitType: 'LIFETIME_FREE' });
    expect(r.success).toBe(true);
    expect(r.data.code).toBe('FOREVERFREE');
  });

  test('FREE_PERIOD requires positive value + DAYS|MONTHS unit', () => {
    expect(createAdminCouponSchema.safeParse({ code: 'X', benefitType: 'FREE_PERIOD' }).success).toBe(false);
    expect(createAdminCouponSchema.safeParse({ code: 'X', benefitType: 'FREE_PERIOD', benefitValue: 30, benefitUnit: 'DAYS' }).success).toBe(true);
    expect(createAdminCouponSchema.safeParse({ code: 'X', benefitType: 'FREE_PERIOD', benefitValue: 30, benefitUnit: 'CYCLES' }).success).toBe(false);
  });

  test('PERCENT_OFF caps benefitValue at 100', () => {
    expect(createAdminCouponSchema.safeParse({ code: 'X', benefitType: 'PERCENT_OFF', benefitValue: 25 }).success).toBe(true);
    expect(createAdminCouponSchema.safeParse({ code: 'X', benefitType: 'PERCENT_OFF', benefitValue: 200 }).success).toBe(false);
  });

  test('FIXED_OFF requires benefitCurrency', () => {
    expect(createAdminCouponSchema.safeParse({ code: 'X', benefitType: 'FIXED_OFF', benefitValue: 50 }).success).toBe(false);
    expect(createAdminCouponSchema.safeParse({ code: 'X', benefitType: 'FIXED_OFF', benefitValue: 50, benefitCurrency: 'USD' }).success).toBe(true);
  });

  test('uppercases country codes + lowercases emails', () => {
    const r = createAdminCouponSchema.safeParse({
      code: 'X', benefitType: 'LIFETIME_FREE',
      allowedCountries: ['us', 'in', 'ZA'],
      allowedEmails: ['Foo@Example.COM', 'BAR@example.com'],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowedCountries).toEqual(['US', 'IN', 'ZA']);
    expect(r.data.allowedEmails).toEqual(['foo@example.com', 'bar@example.com']);
  });

  test('benefitType is required on create', () => {
    expect(createAdminCouponSchema.safeParse({ code: 'X' }).success).toBe(false);
  });
});

describe('updateAdminCouponSchema', () => {
  test('accepts partial isActive toggle', () => {
    expect(updateAdminCouponSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});

// ─── business setup ────────────────────────────────────────────────────
describe('setupBusinessSchema', () => {
  test('requires name', () => {
    expect(setupBusinessSchema.safeParse({}).success).toBe(false);
    expect(setupBusinessSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  test('rejects names > 120 chars', () => {
    const r = setupBusinessSchema.safeParse({ name: 'x'.repeat(121) });
    expect(r.success).toBe(false);
  });

  test('rejects review link without http(s) prefix', () => {
    const r = setupBusinessSchema.safeParse({ name: 'Acme', reviewRequestLink: 'no-protocol.com' });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toMatch(/http/);
  });

  test('uppercases country code', () => {
    const r = setupBusinessSchema.safeParse({ name: 'Acme', country: 'us' });
    expect(r.success).toBe(true);
    expect(r.data.country).toBe('US');
  });

  test('rejects invalid bookingType', () => {
    const r = setupBusinessSchema.safeParse({ name: 'Acme', bookingType: 'WHENEVER' });
    expect(r.success).toBe(false);
  });

  test('accepts valid defaultLanguage', () => {
    for (const locale of ['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR']) {
      const r = setupBusinessSchema.safeParse({ name: 'Acme', defaultLanguage: locale });
      expect(r.success).toBe(true);
      expect(r.data.defaultLanguage).toBe(locale);
    }
  });

  test('rejects unsupported defaultLanguage', () => {
    const r = setupBusinessSchema.safeParse({ name: 'Acme', defaultLanguage: 'zh' });
    expect(r.success).toBe(false);
  });

  test('empty string defaultLanguage transforms to null (clears preference)', () => {
    const r = setupBusinessSchema.safeParse({ name: 'Acme', defaultLanguage: '' });
    expect(r.success).toBe(true);
    expect(r.data.defaultLanguage).toBe(null);
  });

  test('omitting defaultLanguage leaves it undefined (no change)', () => {
    const r = setupBusinessSchema.safeParse({ name: 'Acme' });
    expect(r.success).toBe(true);
    expect(r.data.defaultLanguage).toBeUndefined();
  });
});

describe('updateBusinessSettingsSchema', () => {
  test('accepts each supported locale', () => {
    for (const locale of ['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR']) {
      const r = updateBusinessSettingsSchema.safeParse({ defaultLanguage: locale });
      expect(r.success).toBe(true);
    }
  });
  test('rejects unsupported locale', () => {
    expect(updateBusinessSettingsSchema.safeParse({ defaultLanguage: 'jp' }).success).toBe(false);
    expect(updateBusinessSettingsSchema.safeParse({ defaultLanguage: 'EN' }).success).toBe(false);
  });
  test('empty string clears (transforms to null)', () => {
    const r = updateBusinessSettingsSchema.safeParse({ defaultLanguage: '' });
    expect(r.success).toBe(true);
    expect(r.data.defaultLanguage).toBe(null);
  });
  test('null is accepted as explicit clear', () => {
    const r = updateBusinessSettingsSchema.safeParse({ defaultLanguage: null });
    expect(r.success).toBe(true);
    expect(r.data.defaultLanguage).toBe(null);
  });
  test('empty object is allowed (partial PATCH semantics)', () => {
    const r = updateBusinessSettingsSchema.safeParse({});
    expect(r.success).toBe(true);
  });
});

// ─── hours / holidays ──────────────────────────────────────────────────
describe('setHoursSchema', () => {
  test('rejects empty hours array', () => {
    expect(setHoursSchema.safeParse({ hours: [] }).success).toBe(false);
  });

  test('rejects more than 7 entries', () => {
    const tooMany = Array.from({ length: 8 }, (_, i) => ({ dayOfWeek: i % 7, openTime: '09:00', closeTime: '17:00' }));
    expect(setHoursSchema.safeParse({ hours: tooMany }).success).toBe(false);
  });

  test('rejects duplicate dayOfWeek', () => {
    const r = setHoursSchema.safeParse({ hours: [
      { dayOfWeek: 1, openTime: '09:00', closeTime: '17:00' },
      { dayOfWeek: 1, openTime: '10:00', closeTime: '16:00' },
    ] });
    expect(r.success).toBe(false);
  });

  test('rejects close <= open when not closed', () => {
    const r = setHoursSchema.safeParse({ hours: [{ dayOfWeek: 1, openTime: '17:00', closeTime: '09:00' }] });
    expect(r.success).toBe(false);
  });

  test('accepts a closed day with no times', () => {
    const r = setHoursSchema.safeParse({ hours: [{ dayOfWeek: 0, isClosed: true }] });
    expect(r.success).toBe(true);
  });
});

describe('addHolidaySchema', () => {
  test('requires date + name', () => {
    expect(addHolidaySchema.safeParse({}).success).toBe(false);
    expect(addHolidaySchema.safeParse({ date: '2026-12-25' }).success).toBe(false);
  });

  test('rejects bad date format', () => {
    expect(addHolidaySchema.safeParse({ date: '12/25/2026', name: 'X' }).success).toBe(false);
  });

  test('rejects name > 100 chars', () => {
    expect(addHolidaySchema.safeParse({ date: '2026-12-25', name: 'x'.repeat(101) }).success).toBe(false);
  });
});

// ─── leave ─────────────────────────────────────────────────────────────
describe('requestLeaveSchema', () => {
  test('full-day leave just needs a valid date', () => {
    const r = requestLeaveSchema.safeParse({ date: '2026-05-10' });
    expect(r.success).toBe(true);
    expect(r.data.isFullDay).toBe(true);
  });

  test('partial-day requires start + end times', () => {
    expect(requestLeaveSchema.safeParse({ date: '2026-05-10', isFullDay: false }).success).toBe(false);
    expect(requestLeaveSchema.safeParse({ date: '2026-05-10', isFullDay: false, startTime: '14:00' }).success).toBe(false);
    expect(requestLeaveSchema.safeParse({ date: '2026-05-10', isFullDay: false, startTime: '14:00', endTime: '15:00' }).success).toBe(true);
  });

  test('partial-day with start >= end fails', () => {
    expect(requestLeaveSchema.safeParse({ date: '2026-05-10', isFullDay: false, startTime: '15:00', endTime: '14:00' }).success).toBe(false);
  });

  test('reason > 500 chars rejected', () => {
    const r = requestLeaveSchema.safeParse({ date: '2026-05-10', reason: 'x'.repeat(501) });
    expect(r.success).toBe(false);
  });
});

// ─── enquiry ──────────────────────────────────────────────────────────
describe('submitEnquirySchema', () => {
  test('requires name + message + (email OR phone)', () => {
    expect(submitEnquirySchema.safeParse({ message: 'hi' }).success).toBe(false);
    expect(submitEnquirySchema.safeParse({ name: 'A' }).success).toBe(false);
    expect(submitEnquirySchema.safeParse({ name: 'A', message: 'hi' }).success).toBe(false);
    expect(submitEnquirySchema.safeParse({ name: 'A', message: 'hi', email: 'a@b.c' }).success).toBe(true);
    expect(submitEnquirySchema.safeParse({ name: 'A', message: 'hi', phone: '+1 555 1234' }).success).toBe(true);
  });

  test('caps name at 120 chars', () => {
    expect(submitEnquirySchema.safeParse({ name: 'x'.repeat(121), message: 'hi', email: 'a@b.c' }).success).toBe(false);
  });
});

describe('updateEnquiryStatusSchema', () => {
  test('uppercases incoming status', () => {
    const r = updateEnquiryStatusSchema.safeParse({ status: 'replied' });
    expect(r.success).toBe(true);
    expect(r.data.status).toBe('REPLIED');
  });

  test('rejects unknown status', () => {
    expect(updateEnquiryStatusSchema.safeParse({ status: 'PENDING' }).success).toBe(false);
  });
});

// ─── customer OTP / password ───────────────────────────────────────────
describe('verifyOtpSchema', () => {
  test('coerces numeric OTPs to string', () => {
    const r = verifyOtpSchema.safeParse({ email: 'a@b.com', otp: 123456 });
    expect(r.success).toBe(true);
    expect(r.data.otp).toBe('123456');
  });

  test('rejects empty OTP string', () => {
    expect(verifyOtpSchema.safeParse({ email: 'a@b.com', otp: '   ' }).success).toBe(false);
  });
});

describe('resendOtpSchema', () => {
  test('lowercases email', () => {
    const r = resendOtpSchema.safeParse({ email: 'Foo@Example.COM' });
    expect(r.success).toBe(true);
    expect(r.data.email).toBe('foo@example.com');
  });
});

describe('changePasswordSchema', () => {
  test('newPassword must meet strength rules', () => {
    expect(changePasswordSchema.safeParse({ newPassword: 'weak' }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ newPassword: 'NoDigit!' }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ newPassword: 'Strong1pass' }).success).toBe(true);
  });

  test('currentPassword optional (Google-only accounts)', () => {
    const r = changePasswordSchema.safeParse({ newPassword: 'Strong1pass' });
    expect(r.success).toBe(true);
  });
});

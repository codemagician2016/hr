// Subscription / tier coupon schema for the super-admin's AdminCoupon
// table. Distinct from booking-time coupons (coupon.schema.js) — these
// gate FREE_PERIOD / LIFETIME_FREE / PERCENT_OFF / FIXED_OFF benefits
// against signup attempts, restrictable by country / email / business /
// tier / first-subscription-only.

const { z } = require('zod');

const BENEFIT_TYPES = ['FREE_PERIOD', 'LIFETIME_FREE', 'PERCENT_OFF', 'FIXED_OFF'];
const BENEFIT_UNITS = ['DAYS', 'MONTHS', 'CYCLES'];

const codeField = z
  .string({ required_error: 'Coupon code is required' })
  .trim()
  .min(1, 'Coupon code is required')
  .max(50, 'Coupon code must be 50 characters or less')
  .transform((v) => v.toUpperCase().replace(/\s+/g, ''));

const stringArrayField = z
  .array(z.string())
  .optional()
  .default([])
  .transform((arr) =>
    arr
      .filter((x) => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim())
  );

const dateField = z.coerce.date({ errorMap: () => ({ message: 'Must be a valid date' }) });

// Permissive base — every field optional so the schema can be reused
// for partial updates. The superRefine block does the cross-field
// checks (FREE_PERIOD requires unit + value, PERCENT_OFF caps at 100,
// validUntil > validFrom).
const baseFields = {
  code: codeField.optional(),
  description: z.string().trim().max(400).optional().nullable(),
  benefitType: z.enum(BENEFIT_TYPES, {
    errorMap: () => ({ message: `benefitType must be one of ${BENEFIT_TYPES.join(', ')}` }),
  }).optional(),
  benefitValue: z.coerce.number().optional().nullable(),
  benefitUnit: z.enum(BENEFIT_UNITS).optional().nullable(),
  benefitCurrency: z.string().trim().toUpperCase().max(3).optional().nullable(),
  allowedCountries: stringArrayField.transform((arr) => arr.map((c) => c.toUpperCase().slice(0, 2))),
  allowedEmails:    stringArrayField.transform((arr) => arr.map((e) => e.toLowerCase())),
  allowedBusinessIds: stringArrayField,
  applicableTiers:    stringArrayField,
  validFrom: dateField.optional().nullable(),
  validUntil: dateField.optional().nullable(),
  maxTotalUses: z.coerce.number().int().positive('maxTotalUses must be a positive integer').optional().nullable(),
  maxPerUser:   z.coerce.number().int().positive('maxPerUser must be a positive integer').optional().nullable(),
  firstSubscriptionOnly: z.coerce.boolean().optional().default(false),
  isActive: z.coerce.boolean().optional().default(true),
};

// Cross-field rules. Used by both create + update so the same checks run
// after merging existing row data on update.
function applyCrossFieldChecks(val, ctx) {
  if (!val.benefitType) return; // partial update with no benefitType change
  if (val.benefitType === 'FREE_PERIOD') {
    if (val.benefitValue == null || !Number.isFinite(val.benefitValue) || val.benefitValue <= 0) {
      ctx.addIssue({ code: 'custom', path: ['benefitValue'], message: 'FREE_PERIOD requires a positive benefitValue (length of free period)' });
    }
    if (!val.benefitUnit || val.benefitUnit === 'CYCLES') {
      ctx.addIssue({ code: 'custom', path: ['benefitUnit'], message: 'FREE_PERIOD requires benefitUnit = DAYS or MONTHS' });
    }
  }
  if (val.benefitType === 'PERCENT_OFF') {
    if (val.benefitValue == null || !Number.isFinite(val.benefitValue) || val.benefitValue <= 0 || val.benefitValue > 100) {
      ctx.addIssue({ code: 'custom', path: ['benefitValue'], message: 'PERCENT_OFF benefitValue must be between 0 and 100' });
    }
  }
  if (val.benefitType === 'FIXED_OFF') {
    if (val.benefitValue == null || !Number.isFinite(val.benefitValue) || val.benefitValue <= 0) {
      ctx.addIssue({ code: 'custom', path: ['benefitValue'], message: 'FIXED_OFF benefitValue must be a positive amount' });
    }
    if (!val.benefitCurrency) {
      ctx.addIssue({ code: 'custom', path: ['benefitCurrency'], message: 'FIXED_OFF requires a benefitCurrency (ISO 4217, e.g. USD)' });
    }
  }
  if (val.validFrom && val.validUntil && val.validFrom >= val.validUntil) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'validUntil must be after validFrom' });
  }
}

// ─── Create ────────────────────────────────────────────────────────────
// Code + benefitType required on create. Other rules same as base.
const createAdminCouponSchema = z.object({
  ...baseFields,
  code: codeField, // required, no .optional()
  benefitType: z.enum(BENEFIT_TYPES, {
    required_error: `benefitType is required (one of ${BENEFIT_TYPES.join(', ')})`,
    invalid_type_error: `benefitType must be one of ${BENEFIT_TYPES.join(', ')}`,
  }),
}).superRefine(applyCrossFieldChecks);

// ─── Update ────────────────────────────────────────────────────────────
// Partial. The controller merges with the existing row before calling
// applyCrossFieldChecks, but the schema also runs the checks against the
// passed-in body so obviously-bad payloads fail early.
const updateAdminCouponSchema = z.object(baseFields).superRefine(applyCrossFieldChecks);

// ─── Public preview / redeem ──────────────────────────────────────────
// Both endpoints take just the code, called from the business admin
// signup flow.
const codeOnlySchema = z.object({
  code: z.string({ required_error: 'Coupon code is required' }).trim().min(1, 'Coupon code is required'),
});

module.exports = {
  BENEFIT_TYPES,
  BENEFIT_UNITS,
  createAdminCouponSchema,
  updateAdminCouponSchema,
  codeOnlySchema,
};

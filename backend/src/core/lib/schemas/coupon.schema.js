// Booking-time coupon schemas. Different from adminCoupon.schema.js
// (which validates SUBSCRIPTION coupons in the super-admin tier
// system) — these are per-business booking discount coupons.

const { z } = require('zod');

const couponCodeField = z
  .string({ required_error: 'Coupon code is required' })
  .trim()
  .min(1, 'Coupon code is required')
  .max(50, 'Coupon code must be 50 characters or less')
  // Normalise to uppercase, strip whitespace — matches the
  // controller's existing behaviour.
  .transform((v) => v.toUpperCase().replace(/\s+/g, ''));

const discountTypeField = z.enum(['FIXED', 'PERCENTAGE'], {
  required_error: 'discountType must be FIXED or PERCENTAGE',
  invalid_type_error: 'discountType must be FIXED or PERCENTAGE',
});

// "Date or ISO date-time" string. Coerced to a JS Date so the
// controller can hand it straight to Prisma. Accepts both
// "2026-04-25" and "2026-04-25T00:00:00.000Z" because the admin
// UI sends one or the other depending on the input type.
const dateOrDatetimeField = z.coerce.date({
  errorMap: () => ({ message: 'Must be a valid date' }),
});

const positiveNumberField = z.coerce.number().positive('Must be a positive number');

// ─── Create ────────────────────────────────────────────────────────────
const createCouponSchema = z.object({
  code: couponCodeField,
  description: z.string().trim().max(200, 'Description must be 200 characters or less').optional().nullable(),
  discountType: discountTypeField,
  discountValue: positiveNumberField,
  minOrderAmount: positiveNumberField.optional().nullable(),
  maxDiscount: positiveNumberField.optional().nullable(),
  maxUses: z.coerce.number().int().positive().optional().nullable(),
  maxUsesPerCustomer: z.coerce.number().int().positive().optional().nullable(),
  validFrom: dateOrDatetimeField,
  validUntil: dateOrDatetimeField,
  applicableServiceIds: z.array(z.string().min(1)).optional().default([]),
  isFirstBookingOnly: z.coerce.boolean().optional().default(false),
}).superRefine((val, ctx) => {
  if (val.discountType === 'PERCENTAGE' && val.discountValue > 100) {
    ctx.addIssue({ code: 'custom', path: ['discountValue'], message: 'Percentage discount cannot exceed 100%' });
  }
  if (val.validFrom >= val.validUntil) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'validUntil must be after validFrom' });
  }
});

// ─── Update ────────────────────────────────────────────────────────────
// Partial — every field is optional. We don't re-check the date order
// here because the controller has both new and existing values; the
// existing controller does that check itself with the merged values.
const updateCouponSchema = z.object({
  description: z.string().trim().max(200, 'Description must be 200 characters or less').optional().nullable(),
  discountType: discountTypeField.optional(),
  discountValue: positiveNumberField.optional(),
  minOrderAmount: positiveNumberField.optional().nullable(),
  maxDiscount: positiveNumberField.optional().nullable(),
  maxUses: z.coerce.number().int().positive().optional().nullable(),
  maxUsesPerCustomer: z.coerce.number().int().positive().optional().nullable(),
  validFrom: dateOrDatetimeField.optional(),
  validUntil: dateOrDatetimeField.optional(),
  applicableServiceIds: z.array(z.string().min(1)).optional(),
  isFirstBookingOnly: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional(),
}).superRefine((val, ctx) => {
  if (val.discountType === 'PERCENTAGE' && val.discountValue !== undefined && val.discountValue > 100) {
    ctx.addIssue({ code: 'custom', path: ['discountValue'], message: 'Percentage discount cannot exceed 100%' });
  }
});

// ─── Public validate (booking time) ───────────────────────────────────
const validateCouponSchema = z.object({
  code: z.string({ required_error: 'code, serviceId, and businessSlug are required' }).trim().min(1, 'code, serviceId, and businessSlug are required'),
  serviceId: z.string({ required_error: 'code, serviceId, and businessSlug are required' }).trim().min(1, 'code, serviceId, and businessSlug are required'),
  businessSlug: z.string({ required_error: 'code, serviceId, and businessSlug are required' }).trim().min(1, 'code, serviceId, and businessSlug are required'),
});

module.exports = {
  createCouponSchema,
  updateCouponSchema,
  validateCouponSchema,
};

// Schemas for the customer-side OTP and password endpoints. These hit
// the public-facing /api/customer/* routes (verify, resend, change
// password). The full register / login schemas are in signup.schema.js.

const { z } = require('zod');
const { emailSchema, passwordSchema } = require('./common');

const verifyOtpSchema = z.object({
  email: emailSchema,
  otp: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => v.length > 0, 'Email and OTP are required'),
});

const resendOtpSchema = z.object({
  email: emailSchema,
});

const changePasswordSchema = z.object({
  // Optional because Google-only accounts have no current password.
  currentPassword: z.string().optional().nullable(),
  newPassword: passwordSchema,
});

module.exports = { verifyOtpSchema, resendOtpSchema, changePasswordSchema };

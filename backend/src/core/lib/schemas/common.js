const { z } = require('zod');

// Reusable field-level schemas. Compose these in endpoint schemas so the
// rules stay consistent across booking / signup / service / etc.

const emailSchema = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(200, 'Email is too long')
  .email('Please enter a valid email address');

// 8+ chars, one uppercase, one lowercase, one digit. Matches the regex
// in lib/inputValidation.js so UI and API are aligned.
const passwordSchema = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/,
    'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  );

const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+\d\s()\-]{7,30}$/, 'Please enter a valid phone number')
  .refine(
    (v) => {
      const digits = v.replace(/[^\d]/g, '');
      return digits.length >= 7 && digits.length <= 20;
    },
    { message: 'Please enter a valid phone number' }
  );

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

const timeStringSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in HH:MM format');

module.exports = {
  emailSchema,
  passwordSchema,
  phoneSchema,
  dateStringSchema,
  timeStringSchema,
};

const { z } = require('zod');
const { emailSchema, passwordSchema } = require('./common');
const { isDisposableEmail } = require('../emailValidation');

// Shared across business-admin signup (auth/register) and customer signup
// (customer/register). The disposable-email check goes here so there is one
// source of truth for "which signups reject yopmail / mailinator".
const signupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
  email: emailSchema.refine(
    (e) => !isDisposableEmail(e),
    { message: 'Please use a permanent email address — temporary / disposable email providers are not allowed' }
  ),
  password: passwordSchema,
  acceptTerms: z.boolean().refine(
    (v) => v === true,
    { message: 'You must accept the Terms of Service and Privacy Policy to sign up' }
  ),
});

// POST /api/auth/login — simpler than signup, but consistent shape.
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

// POST /api/auth/forgot-password — only needs an email.
const forgotPasswordSchema = z.object({
  email: emailSchema,
});

// POST /api/auth/reset-password — OTP + new password.
const resetPasswordSchema = z.object({
  email: emailSchema,
  otp: z.string().trim().min(4, 'OTP is required'),
  password: passwordSchema,
});

module.exports = { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema };

const express = require('express');
const router = express.Router();
const { protect } = require('../../core/middleware/auth.middleware');
const {
  register,
  login,
  logout,
  me,
  forgotPassword,
  resetPassword,
  generateLoginCode,
  exchangeLoginCode,
  requestSelfDeletion,
  undoSelfDeletion,
} = require('../controllers/auth.controller');
const { sendOtp, verifyOtp } = require('../controllers/otp.controller');
const { authLimiter } = require('../../core/middleware/abuse.middleware');
const { validateBody } = require('../../core/lib/validate');
const { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } = require('../../core/lib/schemas/signup.schema');

// Email-triggering endpoints get per-IP rate limits so a bot can't spray
// SES into oblivion. Plain /login doesn't send email but a bot brute-
// force is still the right thing to throttle.
router.post('/register',         authLimiter, validateBody(signupSchema), register);
router.post('/login',            authLimiter, validateBody(loginSchema), login);
router.post('/logout',           logout);
router.get('/me', protect,       me);
router.post('/forgot-password',  authLimiter, validateBody(forgotPasswordSchema), forgotPassword);
router.post('/reset-password',   authLimiter, validateBody(resetPasswordSchema), resetPassword);
router.post('/send-otp',         authLimiter, sendOtp);
router.post('/verify-otp',       authLimiter, verifyOtp);
router.post('/generate-login-code', protect, generateLoginCode);
router.post('/exchange-login-code', authLimiter, exchangeLoginCode);

// GDPR Article 17 — staff self-delete (BUSINESS_ADMIN owners use the
// whole-tenant flow at /api/business/request-deletion instead).
router.post('/request-deletion', protect, requestSelfDeletion);
router.post('/undo-deletion',    protect, undoSelfDeletion);

module.exports = router;

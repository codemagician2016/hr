const express = require('express');
const router = express.Router();
const { register, login, me, logout, updateMe, changePassword, deleteAccount, undoDeleteAccount, verifyOtp, resendOtp, forgotPassword, resetPassword, acceptInvite } = require('../controllers/customer.controller');
const { socialStart, socialExchange, googleAuth, googleAuthCode, exchangeCode } = require('../controllers/social.controller');
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const { authLimiter } = require('../../core/middleware/abuse.middleware');
const { validateBody } = require('../../core/lib/validate');
const { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, acceptInviteSchema } = require('../../core/lib/schemas/signup.schema');
const { verifyOtpSchema, resendOtpSchema, changePasswordSchema } = require('../../core/lib/schemas/customer.schema');

// Customer-facing auth — same abuse limit as business auth so a bot can't
// brute-force customer credentials or spray Google OAuth code exchanges.
//
router.post('/register',         authLimiter, validateBody(signupSchema),           register);
router.post('/verify-otp',       authLimiter, validateBody(verifyOtpSchema),         verifyOtp);
router.post('/resend-otp',       authLimiter, validateBody(resendOtpSchema),         resendOtp);
router.post('/forgot-password',  authLimiter, validateBody(forgotPasswordSchema),   forgotPassword);
router.post('/reset-password',   authLimiter, validateBody(resetPasswordSchema),    resetPassword);
// Feature 4 — employee portal-invite claim (PUBLIC, token-driven). Same
// authLimiter as the rest of customer auth so the token can't be brute-forced;
// errors are generic (no enumeration). The token carries the tenant, so no
// X-Tenant-Host is required.
router.post('/accept-invite',    authLimiter, validateBody(acceptInviteSchema),     acceptInvite);
router.post('/login',            authLimiter, validateBody(loginSchema),            login);
router.get('/me',                requireCustomer, me);
router.put('/me',                requireCustomer, updateMe);
router.put('/password',          requireCustomer, authLimiter, validateBody(changePasswordSchema), changePassword);
router.delete('/account',        requireCustomer, deleteAccount);
// GDPR Article 17 — undo within 30-day grace period (signs back in to undo).
router.post('/undo-deletion',    requireCustomer, undoDeleteAccount);
router.post('/logout',           logout);
// Server-side fallback: bounce a tenant host to the centralised provider
// page on the platform origin. The frontend normally builds this URL
// directly; this exists for non-JS / deep-link entry. :provider is the
// social provider key (google | apple | microsoft | …).
router.get('/auth/:provider',    authLimiter, (req, res) => {
  const provider = String(req.params.provider || 'google').toLowerCase();
  const tenantHost = (req.get('X-Tenant-Host') || req.get('X-Forwarded-Host') || req.get('Host') || '').split(':')[0];
  const configuredPlatform = (process.env.PLATFORM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const platformDomain = configuredPlatform || (tenantHost.endsWith('.aapkatech.com') ? 'aapkatech.com' : 'sitepresso.com');
  const redirect = req.query.redirect || '/dashboard';
  const target = new URL(`https://${platformDomain}/auth/${provider}`);
  target.searchParams.set('host', tenantHost);
  target.searchParams.set('redirect', redirect);
  res.redirect(302, target.toString());
});
// Generic, provider-agnostic social login (Google now; Apple/MS later).
router.post('/social/:provider/start', authLimiter, socialStart); // platform → one-time code
router.post('/social/exchange',        authLimiter, socialExchange); // tenant host → JWT
// Legacy aliases — delegate to the generic handlers above. Kept so older
// already-deployed frontends keep working through the rollout.
router.post('/google-auth',      authLimiter, googleAuth);
router.post('/google-auth-code', authLimiter, googleAuthCode);
router.post('/exchange-code',    authLimiter, exchangeCode);

module.exports = router;

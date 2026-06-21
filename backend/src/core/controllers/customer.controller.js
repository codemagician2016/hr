const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { CURRENT_TERMS_VERSION } = require('../lib/legal');
const { logActivity } = require('../lib/ecomActivityLogger');
const { sendPasswordResetOtpEmail, sendCustomerWelcomeEmail, sendCustomerSignupOtpEmail } = require('../utils/email');
const { EMAIL_EVENTS } = require('../lib/emailEvents');
const { validateSignupEmail, validatePassword, validatePhone } = require('../lib/inputValidation');
const { setCustomerTokenCookie, clearCustomerTokenCookie } = require('../utils/generateToken');
const { resolveRecipientLocale } = require('../lib/locale');
const { claimOrdersForCustomer } = require('../../shop/controllers/order.controller');
const cartLib = require('../lib/cart');

// Fire-and-forget — never block auth on guest-order attachment failure.
function fireClaim({ customerId, businessId, email }) {
  claimOrdersForCustomer({ customerId, businessId, email })
    .catch((err) => console.error('[customer auth] order claim failed:', err?.message));
}

// Fire-and-forget — merge guest session cart into customer cart after login/verify.
function fireCartMerge({ customerId, businessId, sessionId }) {
  if (!cartLib.isValidSessionId(sessionId)) return;
  cartLib.mergeGuestCartIntoCustomer({ prisma, businessId, customerId, sessionId })
    .catch((err) => console.error('[customer auth] cart merge failed:', err?.message));
}

function generate6DigitOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Thin wrapper so existing call sites keep working while we delegate the
// actual rendering to the shared light-themed template in utils/email.js.
async function sendOtpEmail(to, name, otp, options = {}) {
  await sendCustomerSignupOtpEmail(to, name, otp, options);
}

// Resolve the businessId from the request — prefer a tenant host and only
// accept X-Business-Id when it does not conflict with that resolved tenant.
async function resolveBusinessId(req) {
  const directId = req.get('X-Business-Id') || null;

  // Resolve from tenant host header (same logic as tenant resolver)
  const host = (req.get('X-Tenant-Host') || '').toLowerCase().split(':')[0].trim();
  if (!host) return directId;

  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  const suffix = `.${platformDomain}`;

  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    if (!sub || sub.includes('.')) return null;
    const biz = await prisma.business.findUnique({ where: { slug: sub }, select: { id: true } });
    if (directId && biz?.id && directId !== biz.id) return null;
    return biz?.id || directId;
  }

  // BYO custom-domain lookup retired 2026-05-10. Fall back to directId
  // (X-Tenant-Host header alone is no longer sufficient if it's not a
  // platform subdomain).
  return directId;
}

// POST /api/customer/register
// Body: { name, email, password }
// Requires: business context (X-Tenant-Host header or businessId in body)
async function register(req, res) {
  const { name, email, password } = req.body;

  // Shape / password / disposable-email / acceptTerms are already enforced
  // by validateBody(signupSchema) on the route. Here we just handle the
  // business rule: customer must belong to a resolvable business, and
  // their email must be unique within that business.
  const businessId = await resolveBusinessId(req);
  if (!businessId) {
    return res.status(400).json({ message: 'Could not determine which business you are registering for' });
  }

  const existing = await prisma.customer.findUnique({
    where: { businessId_email: { businessId, email } },
  });
  if (existing && existing.emailVerified) {
    return res.status(409).json({
      message: 'This email is already registered at this business. Please sign in instead.',
      action: 'login',
    });
  }

  const hashed = await bcrypt.hash(password, 12);
  const otp = generate6DigitOtp();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);

  // Send OTP first; only persist the customer if the mail provider
  // accepted the address. Prevents orphaned unverified rows that would
  // block re-signup with a confusing "email already used" error.
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { defaultLanguage: true },
  });
  const trimmedName = name.trim();
  try {
    await sendOtpEmail(email, trimmedName, otp, {
      businessId,
      customerId: existing?.id || null,
      locale: resolveRecipientLocale({ business, cookieLocale: req.cookies?.NEXT_LOCALE }),
    });
  } catch (err) {
    console.error('[customer/register] OTP email failed:', err.message);
    return res.status(502).json({
      message: "We couldn't deliver a verification code to that address. Check the spelling and try again, or use a different email.",
    });
  }

  let customer;
  try {
    customer = existing
      ? await prisma.customer.update({
          where: { id: existing.id },
          data: {
            password: hashed,
            name: trimmedName,
            emailOtp: otp,
            emailOtpExpiry: expiry,
            termsAcceptedAt: new Date(),
            termsVersion: CURRENT_TERMS_VERSION,
          },
          select: { id: true, email: true, name: true, businessId: true, createdAt: true },
        })
      : await prisma.customer.create({
          data: {
            businessId,
            email,
            password: hashed,
            name: trimmedName,
            emailVerified: false,
            emailOtp: otp,
            emailOtpExpiry: expiry,
            termsAcceptedAt: new Date(),
            termsVersion: CURRENT_TERMS_VERSION,
          },
          select: { id: true, email: true, name: true, businessId: true, createdAt: true },
        });
  } catch (err) {
    // Duplicate-email race on @@unique([businessId, email]): the loser of two
    // concurrent signups throws P2002 — return the clean 409 instead of a 500.
    if (err?.code === 'P2002') {
      return res.status(409).json({ message: 'This email is already registered at this business. Please sign in instead.', action: 'login' });
    }
    throw err;
  }

  // Deliberately NO cookie here — account is inactive until OTP verified.
  res.status(201).json({
    customer,
    verificationRequired: true,
    message: 'Check your email for a 6-digit verification code.',
  });
}

// POST /api/customer/verify-otp
// Body: { email, otp }  — requires business context (X-Tenant-Host)
// Verifies the code, marks emailVerified=true, issues a session cookie so
// the customer is logged in immediately after.
async function verifyOtp(req, res) {
  // Schema (verifyOtpSchema) already enforces email format + non-empty OTP
  // and lower-cases / trims the email.
  const { email, otp } = req.body;

  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(400).json({ message: 'Could not determine which business' });

  const normalizedEmail = email;
  const customer = await prisma.customer.findUnique({
    where: { businessId_email: { businessId, email: normalizedEmail } },
  });
  // Generic error for an unknown email — a distinct 404 here was an account-
  // existence oracle (the OTP-mismatch path returns a generic 400).
  if (!customer) return res.status(400).json({ verified: false, message: 'Incorrect or expired code. Please request a new one.' });
  if (customer.emailVerified) {
    // Already verified — issue cookie, don't error out.
    setCustomerTokenCookie(res, { id: customer.id, businessId }, req);
    return res.json({ verified: true, customer: { id: customer.id, email: customer.email, name: customer.name, businessId } });
  }
  if (!customer.emailOtp || !customer.emailOtpExpiry) {
    return res.status(400).json({ verified: false, message: 'No code pending. Request a new one.' });
  }
  if (new Date() > customer.emailOtpExpiry) {
    return res.status(400).json({ verified: false, message: 'Code expired. Request a new one.' });
  }
  if (customer.emailOtp !== String(otp).trim()) {
    const { recordOtpFailure, OTP_LOCKED_MESSAGE } = require('../lib/otpGuard');
    const locked = await recordOtpFailure(prisma.customer, { id: customer.id }, customer.otpAttempts);
    return res.status(400).json({ verified: false, message: locked ? OTP_LOCKED_MESSAGE : 'Incorrect code. Try again.' });
  }

  const updated = await prisma.customer.update({
    where: { id: customer.id },
    data: { emailVerified: true, emailOtp: null, emailOtpExpiry: null },
    select: { id: true, email: true, name: true, businessId: true, preferredLanguage: true, business: { select: { name: true, defaultLanguage: true } } },
  });

  try {
    sendCustomerWelcomeEmail(updated.email, updated.name, {
      businessName: updated.business?.name || 'the business',
      businessId: updated.businessId,
      customerId: updated.id,
      locale: resolveRecipientLocale({ customer: updated, business: updated.business, cookieLocale: req.cookies?.NEXT_LOCALE }),
    }).catch(e => console.error('customer welcome email failed:', e.message));
  } catch (e) {
    console.error('welcome email error:', e.message);
  }

  setCustomerTokenCookie(res, { id: updated.id, businessId }, req);
  fireClaim({ customerId: updated.id, businessId, email: updated.email });
  fireCartMerge({ customerId: updated.id, businessId, sessionId: req.headers['x-cart-session'] });
  res.json({ verified: true, customer: updated });
}

// POST /api/customer/resend-otp
// Body: { email }  — requires business context (X-Tenant-Host)
async function resendOtp(req, res) {
  // Schema (resendOtpSchema) already lower-cases / trims the email.
  const { email } = req.body;

  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(400).json({ message: 'Could not determine which business' });

  const normalizedEmail = email;
  const customer = await prisma.customer.findUnique({
    where: { businessId_email: { businessId, email: normalizedEmail } },
  });
  // Don't leak whether account exists.
  if (!customer || customer.emailVerified) {
    return res.json({ sent: true, message: 'If an account exists and needs verification, a new code was sent.' });
  }

  const otp = generate6DigitOtp();
  await prisma.customer.update({
    where: { id: customer.id },
    data: { emailOtp: otp, emailOtpExpiry: new Date(Date.now() + 10 * 60 * 1000), otpAttempts: 0 },
  });
  try {
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { defaultLanguage: true },
    });
    await sendOtpEmail(normalizedEmail, customer.name, otp, {
      businessId,
      customerId: customer.id,
      // Existing customer requesting resend — prefer their stored language;
      // fall back to the cookie, then the business default.
      locale: resolveRecipientLocale({ customer, business: biz, cookieLocale: req.cookies?.NEXT_LOCALE }),
    });
  }
  catch (err) { console.error('[customer/resend-otp] email failed:', err.message); }
  res.json({ sent: true, message: 'A new code has been sent.' });
}

// POST /api/customer/forgot-password
// Body: { email } — requires business context (X-Tenant-Host)
async function forgotPassword(req, res) {
  const { email } = req.body;

  const businessId = await resolveBusinessId(req);
  if (!businessId) {
    return res.status(400).json({ message: 'Could not determine which business you are resetting a password for' });
  }

  const customer = await prisma.customer.findUnique({
    where: { businessId_email: { businessId, email } },
  });

  // Always return success to avoid leaking whether this email exists at the
  // current business.
  if (!customer) {
    return res.json({ sent: true, message: 'If an account exists, an OTP has been sent.' });
  }

  const otp = generate6DigitOtp();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.customer.update({
    where: { id: customer.id },
    data: { emailOtp: otp, emailOtpExpiry: expiry, otpAttempts: 0 },
  });

  try {
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { defaultLanguage: true },
    });
    await sendPasswordResetOtpEmail(email, customer.name, otp, {
      eventKey: EMAIL_EVENTS.CUSTOMER_PASSWORD_RESET_OTP,
      businessId,
      customerId: customer.id,
      locale: resolveRecipientLocale({ customer, business: biz, cookieLocale: req.cookies?.NEXT_LOCALE }),
    });
    res.json({ sent: true, message: 'OTP sent to your email' });
  } catch (err) {
    console.error('[customer/forgot-password] OTP email failed:', err.message);
    // Enumeration-safe: always report success; a delivery failure here would
    // otherwise let an attacker distinguish a real account from a non-existent
    // one. Logged server-side instead.
    res.json({ sent: true, message: 'If an account exists, an OTP has been sent.' });
  }
}

// POST /api/customer/reset-password
// Body: { email, otp, password } — requires business context (X-Tenant-Host)
async function resetPassword(req, res) {
  const { email, otp, password } = req.body;

  const businessId = await resolveBusinessId(req);
  if (!businessId) {
    return res.status(400).json({ message: 'Could not determine which business you are resetting a password for' });
  }

  const customer = await prisma.customer.findUnique({
    where: { businessId_email: { businessId, email } },
  });
  // Generic error for an unknown email — a 404 here was an account-existence
  // oracle (forgot-password deliberately masks the same lookup).
  if (!customer) {
    return res.status(400).json({ message: 'Incorrect or expired code. Please request a new one.' });
  }
  if (!customer.emailOtp || !customer.emailOtpExpiry) {
    return res.status(400).json({ message: 'No OTP requested. Please request a new one.' });
  }
  if (new Date() > customer.emailOtpExpiry) {
    return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
  }
  if (customer.emailOtp !== String(otp).trim()) {
    const { recordOtpFailure, OTP_LOCKED_MESSAGE } = require('../lib/otpGuard');
    const locked = await recordOtpFailure(prisma.customer, { id: customer.id }, customer.otpAttempts);
    if (locked) return res.status(400).json({ message: OTP_LOCKED_MESSAGE });
    return res.status(400).json({ message: 'Incorrect code. Please try again.' });
  }

  const hashed = await bcrypt.hash(password, 12);
  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      password: hashed,
      emailOtp: null,
      emailOtpExpiry: null,
      emailVerified: true,
      // Revoke any sessions/refresh tokens issued before this reset.
      passwordChangedAt: new Date(),
    },
  });

  res.json({ message: 'Password reset successfully. You can now sign in.' });
}

// POST /api/customer/login
// Body: { email, password }
async function login(req, res) {
  const { email, password } = req.body;

  const businessId = await resolveBusinessId(req);
  if (!businessId) {
    return res.status(400).json({ message: 'Could not determine which business you are logging into' });
  }

  const customer = await prisma.customer.findUnique({
    where: { businessId_email: { businessId, email } },
  });

  if (!customer) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const match = await bcrypt.compare(password, customer.password);
  if (!match) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  // Block deactivated / anonymised (purged) accounts from authenticating. A
  // soft-deleted account (pendingDeletionAt set, still active) is deliberately
  // allowed through so the owner can sign in to undo within the grace window.
  if (!customer.isActive || customer.anonymisedAt) {
    return res.status(403).json({ message: 'This account is no longer active. Please contact support if you need help.' });
  }

  // Block unverified accounts from signing in. Frontend sees verificationRequired
  // and renders the OTP entry step instead of logging the user in.
  if (!customer.emailVerified) {
    return res.status(403).json({
      verificationRequired: true,
      email: customer.email,
      message: 'Please verify your email to finish creating your account.',
    });
  }

  setCustomerTokenCookie(res, { id: customer.id, businessId }, req);
  fireClaim({ customerId: customer.id, businessId, email: customer.email });
  fireCartMerge({ customerId: customer.id, businessId, sessionId: req.headers['x-cart-session'] });
  res.json({
    customer: {
      id: customer.id,
      email: customer.email,
      name: customer.name,
      businessId: customer.businessId,
    },
  });
}

// GET /api/customer/me
async function me(req, res) {
  if (!req.customer) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  const { calendarFeedToken: _token, ...customer } = req.customer;
  res.json({ customer });
}

// Resolve the currently signed-in customer from the token cookie. Returns the
// customer row or sends a 401 and returns null.
async function currentCustomer(req, res) {
  if (!req.customer?.id || !req.customer?.businessId) {
    res.status(401).json({ message: 'Not authenticated' });
    return null;
  }
  const customer = await prisma.customer.findFirst({
    where: { id: req.customer.id, businessId: req.customer.businessId },
  });
  if (!customer) {
    res.status(401).json({ message: 'Customer not found or inactive' });
    return null;
  }
  return customer;
}

// PUT /api/customer/me
// Body: { name?, phone?, dateOfBirth? }
// Customers can edit their own display name, phone, and DOB. Email is not
// editable from the portal (identity + uniqueness constraint).
async function updateMe(req, res) {
  const customer = await currentCustomer(req, res);
  if (!customer) return;

  const data = {};
  if (typeof req.body.name === 'string') {
    const n = req.body.name.trim();
    if (n.length < 1 || n.length > 120) {
      return res.status(400).json({ message: 'Name must be 1–120 characters' });
    }
    data.name = n;
  }
  if (typeof req.body.phone === 'string' || req.body.phone === null) {
    const p = (req.body.phone || '').trim();
    if (p && !/^[+\d][\d\s()\-]{5,30}$/.test(p)) {
      return res.status(400).json({ message: 'Invalid phone number' });
    }
    data.phone = p || null;
  }
  if (req.body.dateOfBirth !== undefined) {
    if (req.body.dateOfBirth === null || req.body.dateOfBirth === '') {
      data.dateOfBirth = null;
    } else {
      const d = new Date(req.body.dateOfBirth);
      if (isNaN(d.getTime())) return res.status(400).json({ message: 'Invalid date of birth' });
      data.dateOfBirth = d;
    }
  }
  if (req.body.avatarUrl !== undefined) {
    if (req.body.avatarUrl === null || req.body.avatarUrl === '') {
      data.avatarUrl = null;
    } else {
      const url = String(req.body.avatarUrl);
      if (url.length > 2_000_000) return res.status(400).json({ message: 'Avatar too large' });
      data.avatarUrl = url;
    }
  }
  if (req.body.preferredLanguage !== undefined) {
    const lang = req.body.preferredLanguage;
    const ALLOWED = ['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR'];
    if (lang !== null && !ALLOWED.includes(lang)) {
      return res.status(400).json({ message: 'Unsupported language' });
    }
    data.preferredLanguage = lang || null;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'No fields to update' });
  }

  await prisma.customer.updateMany({
    where: { id: customer.id, businessId: customer.businessId },
    data,
  });
  const updated = await prisma.customer.findFirst({
    where: { id: customer.id, businessId: customer.businessId },
    select: {
      id: true, email: true, name: true, businessId: true,
      phone: true, dateOfBirth: true, avatarUrl: true, preferredLanguage: true,
    },
  });
  res.json({ customer: updated });
}

// PUT /api/customer/password
// Body: { currentPassword, newPassword }
// For Google-only customers (no password set), currentPassword is not checked.
async function changePassword(req, res) {
  const customer = await currentCustomer(req, res);
  if (!customer) return;

  // Schema (changePasswordSchema) already enforces password strength.
  const { currentPassword, newPassword } = req.body;

  // Social-only accounts (hasPassword=false) never set a password, so don't
  // demand a "current password" they can't provide — the authenticated session
  // is the proof. Password-bearing accounts must verify the current password.
  if (customer.hasPassword) {
    if (!currentPassword) {
      return res.status(400).json({ message: 'Current password is required' });
    }
    const ok = await bcrypt.compare(currentPassword, customer.password);
    if (!ok) return res.status(401).json({ message: 'Current password is incorrect' });
  }

  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.customer.updateMany({
    where: { id: customer.id, businessId: customer.businessId },
    // Now that they've set a real password, future changes require the current one.
    data: { password: hashed, passwordChangedAt: new Date(), hasPassword: true },
  });
  // Re-issue THIS session so changing the password signs out OTHER devices
  // (their tokens predate passwordChangedAt) while keeping the current one.
  setCustomerTokenCookie(res, { id: customer.id, businessId: customer.businessId }, req);
  res.json({ message: 'Password updated' });
}

// DELETE /api/customer/account
// Body: { confirmation: "DELETE", currentPassword? }
// Irreversible. Cascades: appointments keep the customerId reference but
// Customer row is removed. Front-end is the one that gates on the typed
// "DELETE" string for UX — the backend re-checks so nobody can bypass it.
//
// Password-bearing accounts also require currentPassword as a second factor
// against session-hijack-then-delete; Google-only accounts (no password set)
// are exempt because there's nothing to verify.
// GDPR Article 17 — soft-delete with 30-day grace period. The customer
// can undo within the window. After 30 days a cron in
// backend/src/core/lib/accountDeletion.js anonymises PII (name → '[deleted]',
// email → opaque, phone → null) while keeping the row + appointment links so
// the business retains revenue history (policy B1, agreed 2026-05-08).
async function deleteAccount(req, res) {
  const customer = await currentCustomer(req, res);
  if (!customer) return;

  if (req.body?.confirmation !== 'DELETE') {
    return res.status(400).json({ message: 'Type DELETE to confirm account deletion' });
  }

  // Social-only accounts (hasPassword=false) have no password to verify — the
  // authenticated session + typed "DELETE" is the second factor.
  if (customer.hasPassword) {
    const provided = req.body?.currentPassword;
    if (!provided) {
      return res.status(400).json({ message: 'Current password is required to delete your account' });
    }
    const ok = await bcrypt.compare(provided, customer.password);
    if (!ok) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }
  }

  const accountDeletion = require('../lib/accountDeletion');
  const { alreadyPending, purgeAt } = await accountDeletion.requestCustomerDeletion({
    customerId: customer.id,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent') || null,
    reason: req.body?.reason || null,
  });

  // Activity log — customer requested account deletion (purge happens later).
  logActivity(req, {
    eventKey: 'customer.account_deletion_requested',
    area: 'customers',
    targetType: 'customer',
    targetId: customer.id,
    targetCode: customer.email,
    payload: { deletedBy: 'customer', purgeAt },
  }).catch(() => {});

  clearCustomerTokenCookie(res, req);
  res.json({
    message: alreadyPending
      ? 'Account deletion was already scheduled'
      : 'Account deletion scheduled — you have 30 days to undo by signing back in',
    pending: true,
    purgeAt,
  });
}

// Customer reverses a pending deletion within the 30-day grace window.
// Re-authenticated via cookie + JWT (requireCustomer middleware on the route).
async function undoDeleteAccount(req, res) {
  const customer = await currentCustomer(req, res);
  if (!customer) return;
  if (!customer.pendingDeletionAt) {
    return res.status(404).json({ message: 'No pending deletion to undo' });
  }
  const accountDeletion = require('../lib/accountDeletion');
  await accountDeletion.undoCustomerDeletion({
    customerId: customer.id,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent') || null,
  });
  res.json({ pending: false });
}

// POST /api/customer/logout
function logout(req, res) {
  clearCustomerTokenCookie(res, req);
  res.json({ message: 'Logged out' });
}

module.exports = {
  register, login, me, logout, resolveBusinessId,
  updateMe, changePassword, deleteAccount, undoDeleteAccount, verifyOtp, resendOtp, forgotPassword, resetPassword,
};

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { ROLES } = require('../lib/roles');
const { generateToken, setTokenCookie, clearTokenCookie } = require('../utils/generateToken');
const { sendPasswordResetOtpEmail, sendUserSignupOtpEmail } = require('../utils/email');
const { EMAIL_EVENTS } = require('../lib/emailEvents');
const { CURRENT_TERMS_VERSION } = require('../lib/legal');
const { resolveRecipientLocale } = require('../lib/locale');

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Safe projection for the authenticated user returned to the client — mirrors
// USER_SELECT in auth.middleware.js (what /api/auth/me exposes). Login must NOT
// leak internal columns (emailOtp, emailOtpExpiry, otpAttempts, resetToken,
// resetTokenExpiry, passwordChangedAt, calendarFeedToken, …) just because the
// row was loaded for a bcrypt compare. Keep this list in sync with USER_SELECT.
const SAFE_LOGIN_USER_FIELDS = [
  'id', 'email', 'name', 'role', 'businessId', 'avatarUrl', 'subtitle', 'bio',
  'isActive', 'showOnWebsite', 'isServiceProvider', 'businessRoleId',
];

function projectSafeUser(user, extra = {}) {
  const safe = {};
  for (const key of SAFE_LOGIN_USER_FIELDS) {
    if (user[key] !== undefined) safe[key] = user[key];
  }
  if (user.businessRole !== undefined) {
    const r = user.businessRole;
    safe.businessRole = r
      ? { id: r.id, name: r.name, permissions: r.permissions, isSystem: r.isSystem }
      : null;
  }
  return { ...safe, ...extra };
}

// POST /api/auth/register
// Atomic signup: send OTP first, only create the user if the email is
// actually deliverable. Prevents the half-baked state where a user row
// exists but no verification code ever reached the inbox.
async function register(req, res) {
  const { name, email, password } = req.body; // already trimmed + lowercased by Zod

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && existing.emailVerified) {
    return res.status(409).json({
      message: 'This email is already registered. Please sign in instead.',
      action: 'login',
    });
  }

  const otp = generateOtp();
  const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  const hashed = await bcrypt.hash(password, 12);

  // Try sending the OTP BEFORE writing to the DB. If the mail provider
  // rejects the address (bad domain, dead mailbox, blocked), bail out
  // early — no orphan user row, the visitor can fix the email and retry.
  try {
    await sendUserSignupOtpEmail(email, name, otp, {
      eventKey: EMAIL_EVENTS.USER_SIGNUP_OTP,
      userId: existing?.id || null,
      businessId: existing?.businessId || null,
      metadata: { otpLength: otp.length, flow: 'register' },
    });
  } catch (err) {
    // A missing/misconfigured sender identity is OUR fault, not the visitor's.
    // Don't tell them to "use a different email" — surface a transient-error
    // message and let it page us via the error log instead.
    if (err?.code === 'EMAIL_CONFIG') {
      console.error('Signup OTP email config error (SES_FROM_EMAIL?):', err.message);
      return res.status(500).json({
        message: 'We’re having a temporary problem sending verification emails. Please try again in a few minutes.',
      });
    }
    console.error('Signup OTP email failed:', err.message);
    return res.status(502).json({
      message: "We couldn't deliver a verification code to that address. Check the spelling and try again, or use a different email.",
    });
  }

  // Email accepted by the provider — safe to persist the account.
  let user;
  try {
    user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            name,
            password: hashed,
            emailOtp: otp,
            emailOtpExpiry: expiry,
            termsAcceptedAt: new Date(),
            termsVersion: CURRENT_TERMS_VERSION,
          },
          select: { id: true, email: true, name: true, role: true, createdAt: true },
        })
      : await prisma.user.create({
          data: {
            name,
            email,
            password: hashed,
            role: ROLES.USER,
            emailOtp: otp,
            emailOtpExpiry: expiry,
            termsAcceptedAt: new Date(),
            termsVersion: CURRENT_TERMS_VERSION,
          },
          select: { id: true, email: true, name: true, role: true, createdAt: true },
        });
  } catch (err) {
    // Duplicate-email race: two concurrent signups both saw no existing row
    // and both tried to create. The unique constraint makes the loser throw
    // P2002 — turn it into the same clean 409 instead of an unhandled 500.
    if (err?.code === 'P2002') {
      return res.status(409).json({ message: 'This email is already registered. Please sign in instead.', action: 'login' });
    }
    throw err;
  }

  // Deliberately NO session cookie here — the account is not usable until the
  // email is verified (verify-otp issues the session). This closes the gap
  // where register handed out a live admin session for an unverified row, and
  // removes the value of overwriting an unverified row's password.
  res.status(201).json({
    user,
    otpSent: true,
    verificationRequired: true,
    message: 'Account created. Check your email for the 6-digit verification code.',
  });
}

// POST /api/auth/login
async function login(req, res) {
  const { email, password } = req.body;

  // Read the password (for the bcrypt compare) and emailVerified (for the
  // self-signup gate) explicitly, but project the RESPONSE to the safe field
  // set below so no internal columns ride along in the JSON.
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      ...Object.fromEntries(SAFE_LOGIN_USER_FIELDS.map((k) => [k, true])),
      businessRole: { select: { id: true, name: true, permissions: true, isSystem: true } },
      password: true,
      emailVerified: true,
    },
  });

  if (!user || !user.isActive) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  // Email verification only gates SELF-SIGNUP owners (USER → BUSINESS_ADMIN
  // lineage): they prove email ownership via OTP before getting access, which
  // also defeats overwriting an unverified row's password. Admin-invited STAFF
  // / riders and SUPER_ADMIN are provisioned with a credential delivered to
  // their email and have NO OTP step, so gating them here would lock them out.
  const selfSignupRole = user.role === ROLES.USER || user.role === ROLES.BUSINESS_ADMIN;
  if (selfSignupRole && !user.emailVerified) {
    return res.status(403).json({
      verificationRequired: true,
      email: user.email,
      message: 'Please verify your email to finish setting up your account.',
    });
  }

  const business = user.businessId
    ? await prisma.business.findUnique({
        where: { id: user.businessId },
        select: { id: true, slug: true, name: true, vertical: true },
      })
    : null;

  // Tenant-isolation gate. If the request came from a tenant subdomain
  // (e.g. acme.sitepresso.com), the user must belong to that tenant's
  // business — prevents an admin of business A from signing in at
  // business B's login page using their own credentials. SUPER_ADMIN
  // can sign in on any subdomain for support purposes.
  const tenantHost = (req.get('X-Tenant-Host') || '').toLowerCase().split(':')[0];
  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  const platformSuffix = `.${platformDomain}`;
  if (
    tenantHost &&
    tenantHost !== platformDomain &&
    user.role !== ROLES.SUPER_ADMIN
  ) {
    // Resolve the business the subdomain belongs to via slug only.
    // BYO custom-domain lookup retired 2026-05-10; all tenants live on
    // platform subdomains.
    let tenantBusiness = null;
    if (tenantHost.endsWith(platformSuffix)) {
      const sub = tenantHost.slice(0, -platformSuffix.length);
      if (sub && !sub.includes('.')) {
        tenantBusiness = await prisma.business.findUnique({
          where: { slug: sub },
          select: { id: true, name: true, slug: true },
        });
      }
    }

    // If we can't resolve a tenant, don't gate (fail open to avoid
    // locking people out when DNS is weird). If we CAN resolve one and
    // it doesn't match the user's businessId, block the sign-in.
    if (tenantBusiness && tenantBusiness.id !== user.businessId) {
      return res.status(403).json({
        message: `This sign-in is for "${tenantBusiness.name}". Your account belongs to a different business — please sign in at your own admin URL.`,
        wrongTenant: true,
      });
    }
  }

  const token = generateToken({ id: user.id });
  setTokenCookie(res, token, req);

  res.json({
    user: projectSafeUser(user, { businessSlug: business?.slug || null }),
    business,
  });
}

// POST /api/auth/logout
function logout(req, res) {
  clearTokenCookie(res, req);
  res.json({ message: 'Logged out successfully' });
}

// GET /api/auth/me
async function me(req, res) {
  // Include the user's own business slug so the admin shell can bounce them
  // to their correct workspace instead of dead-ending on "Wrong business"
  // when they land on another tenant's slug (stale URL / switched account).
  let businessSlug = null;
  if (req.user?.businessId) {
    const biz = await prisma.business
      .findUnique({ where: { id: req.user.businessId }, select: { slug: true } })
      .catch(() => null);
    businessSlug = biz?.slug || null;
  }
  res.json({ user: { ...req.user, businessSlug } });
}

// POST /api/auth/forgot-password — sends OTP to email for password reset
async function forgotPassword(req, res) {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });

  // Always return success to avoid email enumeration
  if (!user) {
    return res.json({ sent: true, message: 'If an account exists, an OTP has been sent.' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await prisma.user.update({
    where: { id: user.id },
    data: { emailOtp: otp, emailOtpExpiry: expiry, otpAttempts: 0 },
  });

  try {
    const biz = user.businessId
      ? await prisma.business.findUnique({
          where: { id: user.businessId },
          select: { defaultLanguage: true },
        })
      : null;
    await sendPasswordResetOtpEmail(email, user.name, otp, {
      userId: user.id,
      businessId: user.businessId || null,
      locale: resolveRecipientLocale({ user, business: biz, cookieLocale: req.cookies?.NEXT_LOCALE }),
    });
    res.json({ sent: true, message: 'OTP sent to your email' });
  } catch (err) {
    console.error('Password reset OTP email failed:', err.message);
    // Always report the enumeration-safe success. Surfacing a distinct
    // "undeliverable" error here let an attacker tell "no account" (generic
    // 200) apart from "account exists, bad domain" (502) — an existence
    // oracle. Delivery problems are logged server-side instead.
    res.json({ sent: true, message: 'If an account exists, an OTP has been sent.' });
  }
}

// POST /api/auth/reset-password — verify OTP + set new password
async function resetPassword(req, res) {
  const { email, otp, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });

  // Generic error for an unknown email — a 404 "Account not found" here was a
  // direct account-existence oracle (contrast forgot-password's masking).
  if (!user) {
    return res.status(400).json({ message: 'Incorrect or expired code. Please request a new one.' });
  }

  if (!user.emailOtp || !user.emailOtpExpiry) {
    return res.status(400).json({ message: 'No OTP requested. Please request a new one.' });
  }

  if (new Date() > user.emailOtpExpiry) {
    return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
  }

  if (user.emailOtp !== otp.trim()) {
    const { recordOtpFailure, OTP_LOCKED_MESSAGE } = require('../lib/otpGuard');
    const locked = await recordOtpFailure(prisma.user, { id: user.id }, user.otpAttempts);
    return res.status(400).json({ message: locked ? OTP_LOCKED_MESSAGE : 'Incorrect code. Please try again.' });
  }

  const hashed = await bcrypt.hash(password, 12);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashed,
      emailOtp: null,
      emailOtpExpiry: null,
      // Revoke any sessions/refresh tokens issued before this reset.
      passwordChangedAt: new Date(),
    },
  });

  res.json({ message: 'Password reset successfully. You can now log in.' });
}

// ---- One-time login codes (for cross-domain seamless redirect) ----
// In-memory store: code -> { userId, expiresAt }
// Cross-domain one-time login codes are stored via the shared issue/consume
// helper (Redis-backed, single-use, in-memory fallback) — NOT a per-process
// Map, so a code minted on one backend instance can be exchanged on another
// and survives restarts (fixed the flaky post-payment "log back in" path).
const { issueAuthCode, consumeAuthCode } = require('../lib/socialAuth');

// POST /api/auth/generate-login-code  (protected — generates a code for the current user)
async function generateLoginCode(req, res) {
  const code = await issueAuthCode({ kind: 'operator-login', userId: req.user.id });
  res.json({ code });
}

// POST /api/auth/exchange-login-code  (public — exchanges a one-time code for a JWT cookie)
async function exchangeLoginCode(req, res) {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: 'Code is required' });

  const entry = await consumeAuthCode(code); // atomic single-use
  if (!entry || entry.kind !== 'operator-login' || !entry.userId) {
    return res.status(401).json({ message: 'Invalid or expired code' });
  }

  const user = await prisma.user.findUnique({
    where: { id: entry.userId },
    select: {
      ...Object.fromEntries(SAFE_LOGIN_USER_FIELDS.map((k) => [k, true])),
      businessRole: { select: { id: true, name: true, permissions: true, isSystem: true } },
    },
  });
  if (!user || !user.isActive) {
    return res.status(401).json({ message: 'Account not found' });
  }

  const token = generateToken({ id: user.id });
  setTokenCookie(res, token, req);

  const business = user.businessId
    ? await prisma.business.findUnique({
        where: { id: user.businessId },
        select: { id: true, slug: true, name: true },
      })
    : null;

  res.json({
    user: projectSafeUser(user, { businessSlug: business?.slug || null }),
    business,
  });
}

// GDPR Article 17 — staff (USER role) self-deletion. Soft-delete with
// 30-day grace; cron purges PII after grace expires. BUSINESS_ADMIN owners
// use /api/business/request-deletion (whole-tenant flow) instead.
async function requestSelfDeletion(req, res) {
  const { reason } = req.body || {};
  const accountDeletion = require('../lib/accountDeletion');
  const { user, alreadyPending, purgeAt } = await accountDeletion.requestStaffDeletion({
    userId: req.user.id,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent') || null,
    reason: reason || null,
  });
  res.json({
    pending: true,
    alreadyPending: !!alreadyPending,
    purgeAt: purgeAt || null,
    userId: user.id,
  });
}

async function undoSelfDeletion(req, res) {
  const accountDeletion = require('../lib/accountDeletion');
  const restored = await accountDeletion.undoStaffDeletion({
    userId: req.user.id,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent') || null,
  });
  if (!restored) return res.status(404).json({ message: 'No pending deletion to undo' });
  res.json({ pending: false });
}

module.exports = { register, login, logout, me, forgotPassword, resetPassword, generateLoginCode, exchangeLoginCode, requestSelfDeletion, undoSelfDeletion };

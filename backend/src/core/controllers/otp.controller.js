const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { sendUserSignupOtpEmail, sendWelcomeEmail } = require('../utils/email');
const { EMAIL_EVENTS } = require('../lib/emailEvents');
const { generateToken, setTokenCookie } = require('../utils/generateToken');

function generateOtp() {
  // CSPRNG — Math.random() is predictable (its state is recoverable from
  // observed outputs), which would make verification/reset OTPs guessable.
  return crypto.randomInt(100000, 1000000).toString(); // 6-digit, uniform
}

// POST /api/auth/send-otp — send OTP to email for verification
// Body: { email }
// Can be called during signup before the account is fully created,
// OR after signup to verify the email.
async function sendOtp(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  const normalizedEmail = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!user) {
    // Enumeration-safe: don't reveal whether the account exists. (This is the
    // resend endpoint; a genuine signup always has a row, so a real user is
    // unaffected.)
    return res.json({ message: 'If an account exists, a verification code has been sent.', sent: true });
  }

  if (user.emailVerified) {
    return res.json({ message: 'Email already verified', verified: true });
  }

  const otp = generateOtp();
  const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await prisma.user.update({
    where: { id: user.id },
    data: { emailOtp: otp, emailOtpExpiry: expiry, otpAttempts: 0 },
  });

  try {
    await sendUserSignupOtpEmail(normalizedEmail, user.name, otp, {
      eventKey: EMAIL_EVENTS.USER_SIGNUP_OTP,
      userId: user.id,
      businessId: user.businessId || null,
      metadata: { otpLength: otp.length },
    });
    res.json({ message: 'OTP sent to your email', sent: true });
  } catch (err) {
    console.error('OTP email failed:', err.message);
    res.status(500).json({ message: 'Failed to send OTP email' });
  }
}

// POST /api/auth/verify-otp — verify the OTP
// Body: { email, otp }
async function verifyOtp(req, res) {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });

  const normalizedEmail = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  // Generic error for an unknown email — a distinct 404 here was an account-
  // existence oracle (the OTP-mismatch case below is a 400).
  if (!user) return res.status(400).json({ verified: false, message: 'Incorrect or expired code. Please request a new one.' });
  if (user.emailVerified) return res.json({ verified: true, message: 'Already verified' });

  if (!user.emailOtp || !user.emailOtpExpiry) {
    return res.status(400).json({ verified: false, message: 'No OTP requested. Please request a new one.' });
  }

  if (new Date() > user.emailOtpExpiry) {
    return res.status(400).json({ verified: false, message: 'OTP expired. Please request a new one.' });
  }

  if (user.emailOtp !== otp.trim()) {
    const { recordOtpFailure, OTP_LOCKED_MESSAGE } = require('../lib/otpGuard');
    const locked = await recordOtpFailure(prisma.user, { id: user.id }, user.otpAttempts);
    return res.status(400).json({ verified: false, message: locked ? OTP_LOCKED_MESSAGE : 'Incorrect code. Please try again.' });
  }

  // Mark email as verified + clear OTP
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, emailOtp: null, emailOtpExpiry: null },
  });

  // Issue the session now that the email is verified — this is the first point
  // a platform account becomes usable (register no longer logs in pre-verify),
  // so verifying must hand back a live session for the signup → dashboard flow.
  const token = generateToken({ id: user.id });
  setTokenCookie(res, token, req);

  // Tell the client where to land: an onboarded user (has a business) goes to
  // their admin; a fresh signup goes to onboarding. Lets the verify step serve
  // both fresh signups and the login→verify recovery path for legacy accounts.
  let businessSlug = null;
  if (user.businessId) {
    const biz = await prisma.business
      .findUnique({ where: { id: user.businessId }, select: { slug: true } })
      .catch(() => null);
    businessSlug = biz?.slug || null;
  }

  // Send welcome email now that email is verified (non-blocking)
  sendWelcomeEmail(normalizedEmail, user.name, {
    userId: user.id,
    businessId: user.businessId || null,
  }).catch(() => {});

  res.json({ verified: true, businessSlug, message: 'Email verified successfully' });
}

module.exports = { sendOtp, verifyOtp };

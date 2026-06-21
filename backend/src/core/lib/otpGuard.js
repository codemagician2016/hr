// Per-account OTP brute-force guard. Complements the per-IP authLimiter: an
// attacker rotating IPs against a known email otherwise gets effectively
// unlimited guesses at a 6-digit code. We count failed attempts on the row
// and, once the cap is hit, invalidate the OTP so they must request a fresh
// one (which resets the counter).
//
// Usage in a wrong-OTP branch:
//   const locked = await recordOtpFailure(prisma.user, { id: user.id }, user.otpAttempts);
//   return res.status(400).json({ message: locked ? LOCKED_MSG : 'Incorrect code…' });
// On OTP ISSUE/resend, set `otpAttempts: 0` alongside the new emailOtp.

const MAX_OTP_ATTEMPTS = 5;

// `delegate` is a Prisma model delegate (prisma.user / prisma.customer).
async function recordOtpFailure(delegate, where, currentAttempts) {
  const next = (currentAttempts || 0) + 1;
  const locked = next >= MAX_OTP_ATTEMPTS;
  await delegate.update({
    where,
    data: locked
      ? { otpAttempts: 0, emailOtp: null, emailOtpExpiry: null }
      : { otpAttempts: next },
  });
  return locked;
}

const OTP_LOCKED_MESSAGE = 'Too many incorrect attempts. Please request a new code.';

module.exports = { MAX_OTP_ATTEMPTS, OTP_LOCKED_MESSAGE, recordOtpFailure };

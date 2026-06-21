const disposableDomains = require('disposable-email-domains');

const disposableSet = new Set(disposableDomains.map((d) => d.toLowerCase()));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed || null;
}

function hasValidFormat(email) {
  return typeof email === 'string' && EMAIL_RE.test(email);
}

function isDisposableEmail(email) {
  if (!hasValidFormat(email)) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && disposableSet.has(domain);
}

// Returns null if the email is acceptable, or a user-facing error string.
function validateSignupEmail(email) {
  if (!email) return 'Email is required';
  if (!hasValidFormat(email)) return 'Please enter a valid email address';
  if (isDisposableEmail(email)) {
    return 'Please use a permanent email address — temporary / disposable email providers are not allowed';
  }
  return null;
}

module.exports = {
  normaliseEmail,
  hasValidFormat,
  isDisposableEmail,
  validateSignupEmail,
};

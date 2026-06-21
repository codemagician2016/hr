// Centralised input validation helpers. Use these anywhere we accept
// user-provided email / password / phone text so the rules stay consistent.

const { validateSignupEmail, normaliseEmail, hasValidFormat, isDisposableEmail } = require('./emailValidation');

// At least 8 chars, one lowercase, one uppercase, one digit.
// Symbols are allowed but not required — keeps passwords memorable without
// making them trivial to guess.
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length === 0) return 'Password is required';
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 128) return 'Password is too long (max 128 characters)';
  if (!PASSWORD_RE.test(pw)) {
    return 'Password must contain at least one uppercase letter, one lowercase letter, and one number';
  }
  return null;
}

// Permissive phone validator — accepts common formats like +64 21 1111,
// (555) 123-4567, 987-6543210 etc. Requires 7–20 digits after stripping
// separators. Strict per-country formatting belongs on the frontend with
// libphonenumber-js.
function validatePhone(phone, { required = false } = {}) {
  if (phone === null || phone === undefined || phone === '') {
    return required ? 'Phone number is required' : null;
  }
  if (typeof phone !== 'string') return 'Please enter a valid phone number';
  const trimmed = phone.trim();
  if (!/^[+\d\s()\-]{7,30}$/.test(trimmed)) {
    return 'Please enter a valid phone number';
  }
  const digitsOnly = trimmed.replace(/[^\d]/g, '');
  if (digitsOnly.length < 7 || digitsOnly.length > 20) {
    return 'Please enter a valid phone number';
  }
  return null;
}

module.exports = {
  validateSignupEmail,
  validatePassword,
  validatePhone,
  normaliseEmail,
  hasValidFormat,
  isDisposableEmail,
  PASSWORD_RE,
};

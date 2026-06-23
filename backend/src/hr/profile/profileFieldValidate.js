'use strict';

/**
 * profileFieldValidate.js — Feature 13 §5/§9. PURE per-field validators applied at
 * BOTH the ESS submit AND the HR commit (statutory IDs validate twice — §9 "Format
 * validation twice"). Statutory IDs reuse the canonical lifecycle validators (PAN
 * regex, IFSC, UAN, IRD mod-11, NZ bank) so the profile-change path and the
 * onboarding path agree byte-for-byte.
 *
 *   validateField(fieldKey, value) -> { ok, value, error? }
 * where `value` is the NORMALISED/canonical string when a canonical form exists
 * (PAN upper-cased, NZ bank zero-padded), so the committed value is clean.
 *
 * A self-edit free-text field (phone/email/name) is length+charset checked but not
 * over-constrained. Unknown keys fail closed (the policy map already rejects them).
 */

const v = require('../lifecycle/validators');

const isStr = (x) => typeof x === 'string';
const trimOrNull = (x) => (isStr(x) ? x.trim() : (x == null ? null : String(x)));

// email: lightweight RFC-ish shape (the auth layer is the real gate; this just blocks
// obvious garbage before it lands in a profile field).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// phone: digits, spaces, +, -, () — 6..20 chars.
const PHONE_RE = /^[+()\d][\d\s().-]{4,19}$/;

function ok(value) { return { ok: true, value }; }
function bad(error) { return { ok: false, error }; }

// Statutory-ID validators keyed by fieldKey. Each returns the canonical value or null.
const STATUTORY = {
  'statutory.pan': v.normalizePAN,
  'statutory.uan': v.normalizeUAN,
  'statutory.irdNumber': v.normalizeIRD,
  'bank.ifsc': v.normalizeIFSC,
  'bank.nzBankAccount': v.normalizeNZBank,
};

function validateField(fieldKey, raw) {
  const value = trimOrNull(raw);

  // Statutory IDs — canonical-or-reject (validated identically at submit + commit).
  if (STATUTORY[fieldKey]) {
    if (value == null || value === '') return bad(`${fieldKey} cannot be empty`);
    const canon = STATUTORY[fieldKey](value);
    if (!canon) return bad(`Enter a valid ${fieldKey.split('.').pop()}`);
    return ok(canon);
  }

  switch (fieldKey) {
    case 'personalEmail':
      if (value && !EMAIL_RE.test(value)) return bad('Enter a valid email address');
      return ok(value || null);
    case 'phone':
    case 'homePhone':
    case 'officePhone':
      if (value && !PHONE_RE.test(value)) return bad('Enter a valid phone number');
      return ok(value || null);
    case 'firstName':
    case 'lastName':
    case 'middleName':
    case 'motherName':
    case 'fatherName':
      if (value != null && value.length > 100) return bad('Name is too long (max 100)');
      if ((fieldKey === 'firstName' || fieldKey === 'lastName') && (!value || value.length === 0)) {
        return bad('Name cannot be empty');
      }
      return ok(value || null);
    case 'dateOfBirth': {
      if (value == null || value === '') return bad('Date of birth cannot be empty');
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return bad('Enter a valid date');
      if (d.getTime() > Date.now()) return bad('Date of birth cannot be in the future');
      return ok(d.toISOString().slice(0, 10));
    }
    case 'heightCm':
    case 'weightKg': {
      if (value == null || value === '') return ok(null);
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n > 9999) return bad('Enter a valid number');
      return ok(String(n));
    }
    case 'gender': {
      const set = new Set(['MALE', 'FEMALE', 'NON_BINARY', 'UNDISCLOSED', 'OTHER']);
      const up = value ? value.toUpperCase() : '';
      if (!set.has(up)) return bad('Invalid gender');
      return ok(up);
    }
    case 'maritalStatus': {
      const set = new Set(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED', 'CIVIL_UNION', 'UNDISCLOSED']);
      const up = value ? value.toUpperCase() : '';
      if (value && !set.has(up)) return bad('Invalid marital status');
      return ok(value ? up : null);
    }
    case 'stateOfBirthCode':
      if (value && value.length > 2) return bad('State code must be 2 characters');
      return ok(value ? value.toUpperCase() : null);
    case 'bank.accountNumber':
      if (!value || !/^[0-9]{6,20}$/.test(value)) return bad('Enter a valid account number (6-20 digits)');
      return ok(value);
    default:
      // generic free-text optional field — length-guard only.
      if (value != null && value.length > 255) return bad('Value is too long (max 255)');
      return ok(value == null || value === '' ? null : value);
  }
}

module.exports = { validateField };

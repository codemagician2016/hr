'use strict';

/**
 * validators.js — statutory field validators for new-hire self-onboarding
 * (Feature 4 §4.2, §6, slice 4b). PURE: no DB, no I/O — exercised directly by
 * the ESS controller (server-side gate) AND mirrored on the wizard for inline
 * feedback. Unit-tested with plain `node` (mirrors journeyEngine's discipline).
 *
 * Two markets:
 *   IN — PAN, Aadhaar (Verhoeff checksum), UAN (12-digit), IFSC.
 *   NZ — IRD number (IR mod-11 with the official weights + check digit), bank
 *        account (bank-branch-account-suffix), tax code, KiwiSaver rate.
 *
 * Each predicate `isValidX(value)` returns a boolean (never throws). Where a
 * canonical form exists, a `normalizeX(value)` returns the cleaned value (or
 * null when un-normalizable) so callers can store the canonical string.
 *
 * `validateStatutory(countryCode, payload)` → { ok, errors: { field: msg } }
 * picks the right rule set off the entity countryCode (IN default, NZ explicit).
 */

// ── helpers ──────────────────────────────────────────────────────────────────
const isStr = (v) => typeof v === 'string';
const upTrim = (v) => (isStr(v) ? v.trim().toUpperCase() : '');
const digitsOnly = (v) => (isStr(v) || typeof v === 'number' ? String(v).replace(/\D/g, '') : '');

// ═══════════════════════════════════════════════════════════════════════════
// INDIA
// ═══════════════════════════════════════════════════════════════════════════

// PAN — 10 chars: 5 letters, 4 digits, 1 letter. The 4th char encodes the
// holder type (P=individual, C=company, …); we accept the structural form
// (regex [A-Z]{5}[0-9]{4}[A-Z]) without over-constraining the holder class.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
function normalizePAN(v) {
  const s = upTrim(v).replace(/\s+/g, '');
  return PAN_RE.test(s) ? s : null;
}
function isValidPAN(v) {
  return normalizePAN(v) !== null;
}

// ── Aadhaar — 12 digits with a Verhoeff checksum (the last digit) ──
// Verhoeff is a dihedral-group (D5) check; it catches all single-digit errors
// and most adjacent transpositions, which a plain mod-10 would miss. Tables per
// the canonical algorithm (multiplication d, permutation p, inverse inv).
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
// Verhoeff checksum over the digit string; a valid number checksums to 0.
function verhoeffChecksum(num) {
  let c = 0;
  const reversed = String(num).split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const d = Number(reversed[i]);
    if (Number.isNaN(d)) return -1;
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][d]];
  }
  return c;
}
function normalizeAadhaar(v) {
  const d = digitsOnly(v);
  // 12 digits, can't start with 0 or 1 (UIDAI rule), valid Verhoeff.
  if (d.length !== 12) return null;
  if (d[0] === '0' || d[0] === '1') return null;
  if (verhoeffChecksum(d) !== 0) return null;
  return d;
}
function isValidAadhaar(v) {
  return normalizeAadhaar(v) !== null;
}

// ── UAN — Universal Account Number (EPFO): exactly 12 digits ──
function normalizeUAN(v) {
  const d = digitsOnly(v);
  return d.length === 12 ? d : null;
}
function isValidUAN(v) {
  return normalizeUAN(v) !== null;
}

// ── IFSC — bank/branch code: 4 letters, '0', then 6 alphanumerics ──
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
function normalizeIFSC(v) {
  const s = upTrim(v).replace(/\s+/g, '');
  return IFSC_RE.test(s) ? s : null;
}
function isValidIFSC(v) {
  return normalizeIFSC(v) !== null;
}

// ── IN tax regime election (Finance Act 2020 §115BAC) ──
const IN_TAX_REGIMES = new Set(['OLD', 'NEW']);
function isValidIndianTaxRegime(v) {
  return IN_TAX_REGIMES.has(upTrim(v));
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW ZEALAND
// ═══════════════════════════════════════════════════════════════════════════

// ── IRD number — IR's mod-11 algorithm (official weights + check digit) ──
// 8 or 9 digits. The LAST digit is the check digit; the remaining digits are the
// base, left-padded to 8. Primary weights [3,2,7,6,5,4,3,2] over the 8 base
// digits; the check digit is 11 - (sum mod 11), with remainder 0 → 0. A computed
// check digit of 10 → re-run with the SECONDARY weights [7,4,3,2,5,2,7,6]; a
// second 10 → invalid. The base value must lie in IR's range 10,000,000–150,000,000.
const IRD_WEIGHTS_PRIMARY = [3, 2, 7, 6, 5, 4, 3, 2];
const IRD_WEIGHTS_SECONDARY = [7, 4, 3, 2, 5, 2, 7, 6];
function irdCheckDigit(base8, weights) {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) sum += Number(base8[i]) * weights[i];
  const rem = sum % 11;
  return rem === 0 ? 0 : 11 - rem;
}
function normalizeIRD(v) {
  const d = digitsOnly(v);
  if (d.length < 8 || d.length > 9) return null;
  // IR's published valid range is for the whole IRD number (10,000,000–150,000,000).
  const whole = Number(d);
  if (whole < 10000000 || whole > 150000000) return null;
  // Split: last digit = check; the rest = base, left-padded to 8 digits.
  const provided = Number(d[d.length - 1]);
  const base8 = d.slice(0, -1).padStart(8, '0');
  let check = irdCheckDigit(base8, IRD_WEIGHTS_PRIMARY);
  if (check === 10) {
    check = irdCheckDigit(base8, IRD_WEIGHTS_SECONDARY);
    if (check === 10) return null; // invalid per IR spec
  }
  if (check !== provided) return null;
  // Canonical: the digits as given (IR prints 8- or 9-digit forms verbatim).
  return d;
}
function isValidIRD(v) {
  return normalizeIRD(v) !== null;
}

// ── NZ bank account — bank-branch-account-suffix ──
// Format BB-bbbb-AAAAAAA-SSS (2-4-7-2/3): bank 2, branch 4, account 7 (zero-pad
// from 6/7/8), suffix 2 or 3. We validate the structural shape (length per part)
// rather than the per-bank branch table (that's a registry lookup, deferred).
function normalizeNZBank(v) {
  if (!isStr(v)) return null;
  const parts = v.trim().replace(/\s+/g, '').split('-');
  if (parts.length !== 4) return null;
  const [bank, branch, account, suffix] = parts;
  if (!/^\d{2}$/.test(bank)) return null;
  if (!/^\d{4}$/.test(branch)) return null;
  if (!/^\d{6,8}$/.test(account)) return null;     // base 6-7, some banks 8
  if (!/^\d{2,4}$/.test(suffix)) return null;      // 2-3 typical, ≤4 tolerated
  // Canonical: zero-pad account to 7 and suffix to 3 (the storage form).
  const acct = account.padStart(7, '0');
  const suf = suffix.padStart(3, '0');
  return `${bank}-${branch}-${acct}-${suf}`;
}
function isValidNZBank(v) {
  return normalizeNZBank(v) !== null;
}

// ── NZ tax code — IR330 codes: M/ME/SB/S/SH/ST/SA + the common variants ──
// Base codes plus the student-loan ("SL") suffix variants and the "WT"
// withholding code. Upper-cased, whitespace-stripped.
const NZ_TAX_CODES = new Set([
  'M', 'ME', 'SB', 'S', 'SH', 'ST', 'SA',
  // student-loan variants
  'M SL', 'ME SL', 'SB SL', 'S SL', 'SH SL', 'ST SL', 'SA SL',
  // special / no-notification / withholding
  'WT', 'ND', 'STC', 'CAE', 'EDW', 'NSW',
]);
function normalizeTaxCode(v) {
  if (!isStr(v)) return null;
  // Collapse internal whitespace to a single space; uppercase; trim.
  const s = v.trim().toUpperCase().replace(/\s+/g, ' ');
  // Tolerate a glued "SL" suffix ("MSL" → "M SL").
  const glued = s.replace(/^([A-Z]{1,2})SL$/, '$1 SL');
  return NZ_TAX_CODES.has(glued) ? glued : null;
}
function isValidTaxCode(v) {
  return normalizeTaxCode(v) !== null;
}

// ── KiwiSaver contribution rate — employee election: 3, 4, 6, 8 or 10 (%) ──
// The legal employee contribution rates (KiwiSaver Act 2006, current schedule).
const KIWISAVER_RATES = new Set([3, 4, 6, 8, 10]);
function isValidKiwiSaverRate(v) {
  if (v == null || v === '') return false;
  const n = typeof v === 'number' ? v : Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) && KIWISAVER_RATES.has(n);
}

// ═══════════════════════════════════════════════════════════════════════════
// Statutory payload validation (entity countryCode drives the rule set)
// ═══════════════════════════════════════════════════════════════════════════

// IN statutory payload — { pan, aadhaar?, uan?, taxRegime?, pfOptIn? }.
// PAN is mandatory (TDS); Aadhaar/UAN are validated when supplied (UAN may be
// absent for a first job; Aadhaar may be deferred but, if given, must checksum).
function validateIN(payload) {
  const p = payload || {};
  const errors = {};
  if (p.pan == null || p.pan === '') {
    errors.pan = 'PAN is required';
  } else if (!isValidPAN(p.pan)) {
    errors.pan = 'Enter a valid PAN (e.g. ABCDE1234F)';
  }
  if (p.aadhaar != null && p.aadhaar !== '' && !isValidAadhaar(p.aadhaar)) {
    errors.aadhaar = 'Enter a valid 12-digit Aadhaar number';
  }
  if (p.uan != null && p.uan !== '' && !isValidUAN(p.uan)) {
    errors.uan = 'UAN must be 12 digits';
  }
  if (p.taxRegime != null && p.taxRegime !== '' && !isValidIndianTaxRegime(p.taxRegime)) {
    errors.taxRegime = 'Tax regime must be OLD or NEW';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// NZ statutory payload — { irdNumber, taxCode, kiwiSaverRate? }.
// IRD + tax code are mandatory (PAYE); KiwiSaver rate is validated when the
// employee elects to contribute (absent = opt-out / default scheme handling).
function validateNZ(payload) {
  const p = payload || {};
  const errors = {};
  if (p.irdNumber == null || p.irdNumber === '') {
    errors.irdNumber = 'IRD number is required';
  } else if (!isValidIRD(p.irdNumber)) {
    errors.irdNumber = 'Enter a valid IRD number';
  }
  if (p.taxCode == null || p.taxCode === '') {
    errors.taxCode = 'Tax code is required';
  } else if (!isValidTaxCode(p.taxCode)) {
    errors.taxCode = 'Enter a valid tax code (e.g. M, ME, S SL)';
  }
  if (p.kiwiSaverRate != null && p.kiwiSaverRate !== '' && !isValidKiwiSaverRate(p.kiwiSaverRate)) {
    errors.kiwiSaverRate = 'KiwiSaver rate must be 3, 4, 6, 8 or 10%';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * validateStatutory(countryCode, payload) → { ok, errors: { field: msg } }
 * Picks the IN or NZ rule set off the entity's country (IN is the default for
 * any non-NZ tenant). Returns `ok:true` with an empty errors map on success.
 */
function validateStatutory(countryCode, payload) {
  const cc = upTrim(countryCode);
  return cc === 'NZ' ? validateNZ(payload) : validateIN(payload);
}

module.exports = {
  // IN
  isValidPAN,
  normalizePAN,
  isValidAadhaar,
  normalizeAadhaar,
  isValidUAN,
  normalizeUAN,
  isValidIFSC,
  normalizeIFSC,
  isValidIndianTaxRegime,
  // NZ
  isValidIRD,
  normalizeIRD,
  isValidNZBank,
  normalizeNZBank,
  isValidTaxCode,
  normalizeTaxCode,
  isValidKiwiSaverRate,
  // aggregate
  validateStatutory,
  validateIN,
  validateNZ,
  // exposed for unit-testing the checksum core
  _internals: { verhoeffChecksum, irdCheckDigit },
};

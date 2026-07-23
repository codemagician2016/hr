'use strict';

/**
 * countryContext.js — Feature 14, the SINGLE source of truth for a tenant's HR
 * country. Every payroll / tax / leave / statutory / letters / currency /
 * onboarding-field / UI decision routes off `Business.hrCountry` via this module
 * instead of re-deriving the market from a per-row `countryCode` with its own
 * `|| 'IN'` / `NZ ? … : IN` fallback.
 *
 * Design:
 *   - `REGISTRABLE_HR_COUNTRIES` is the master switch that surfaces a market. v1
 *     is frozen to ['IN']; flip to ['IN','NZ'] when the NZ cycle (spec §12) ships.
 *   - `CAPABILITIES` is the front-end contract: the apps render country-specific
 *     surfaces from this matrix, never from a hard-coded 'IN'/'NZ' literal.
 *   - `loadHrCountry` is a single indexed PK read, memoized per-request via an
 *     optional cache object the caller threads through (hrCountry is immutable, so
 *     a per-request memo never goes stale). No I/O beyond `business.findUnique`.
 *   - Fail-closed: an unknown/missing/ambiguous tenant country throws (→ 409),
 *     a mismatched write throws COUNTRY_MISMATCH (→ 422). Never a silent default.
 */

const prisma = require('../../core/lib/prisma');
const { currencyForCountry } = require('../../core/lib/currency');

// The ONLY countries a tenant may register HR for. IN + NZ (§12 unlocked): the NZ
// payroll/tax/leave/statutory stack is fully built + golden-tested, so NZ is now a
// registrable market. This single constant is the hard backstop behind the UI
// gating and the sole server-side allow-list POST /api/hr/setup/country checks.
const REGISTRABLE_HR_COUNTRIES = Object.freeze(['IN', 'NZ']);

// Capability matrix the front-ends consume so neither app hard-codes IN/NZ. Both
// rows are reachable now that NZ ∈ REGISTRABLE_HR_COUNTRIES (§12 unlocked).
const CAPABILITIES = Object.freeze({
  IN: Object.freeze({
    country: 'IN',
    currency: 'INR',
    currencySymbol: '₹',
    flag: '🇮🇳',
    label: 'India',
    taxYearStartMonth: 4,
    tax: Object.freeze({
      regimes: ['NEW', 'OLD'],
      default: 'NEW',
      sections: ['80C', '80D', 'HRA', 'LTA'],
    }),
    statutoryIds: ['PAN', 'AADHAAR', 'UAN', 'IFSC'],
    payrollStatutory: ['EPF', 'ESI', 'PT', 'TDS', 'LWF'],
    compBasis: 'CTC',
    basicFloorPct: 50, // Labour-code Basic ≥ 50% of CTC
    hourlyRates: false,
    leaveSandwich: 'INCLUSIVE',
    letterLocale: 'en-IN',
    holidays: Object.freeze({ mondayisation: false }),
  }),
  // NZ — reachable now (§12 unlocked; NZ ∈ REGISTRABLE_HR_COUNTRIES).
  NZ: Object.freeze({
    country: 'NZ',
    currency: 'NZD',
    currencySymbol: '$',
    flag: '🇳🇿',
    label: 'New Zealand',
    taxYearStartMonth: 4,
    tax: Object.freeze({
      codes: ['M', 'ME', 'S', 'SH', 'ST'],
      default: 'M',
    }),
    statutoryIds: ['IRD', 'NZ_BANK_ACCOUNT'],
    payrollStatutory: ['PAYE', 'KIWISAVER', 'ACC', 'ESCT'],
    compBasis: 'GROSS',
    basicFloorPct: null,
    hourlyRates: true,
    leaveSandwich: 'EXCLUSIVE',
    letterLocale: 'en-NZ',
    holidays: Object.freeze({ mondayisation: true }), // Holidays Act 2003
  }),
});

class CountryError extends Error {
  constructor(code, status, detail) {
    super(code);
    this.name = 'CountryError';
    this.code = code;
    this.status = status;
    if (detail) this.detail = detail;
  }
}

/** IN → INR. Pure mapping via the shared currency lib. */
function payCurrencyFor(code) {
  return currencyForCountry(code);
}

/** Is a country one a tenant may register HR for today? */
function isRegistrableHrCountry(code) {
  return REGISTRABLE_HR_COUNTRIES.includes(String(code || '').toUpperCase());
}

/** The capability matrix for a country (frozen), or null if unknown. */
function countryCapabilities(code) {
  return CAPABILITIES[String(code || '').toUpperCase()] || null;
}

/**
 * Load the tenant's authoritative HR country/currency. Fail-closed: a missing,
 * pre-setup, or quarantined tenant throws a CountryError (never a default market).
 *
 * @param {string} businessId
 * @param {{ cache?: Map }} [opts] optional per-request memo (hrCountry is immutable)
 * @returns {Promise<{ country: string, currency: string, ambiguous: boolean }>}
 */
async function loadHrCountry(businessId, opts = {}) {
  if (!businessId) throw new CountryError('TENANT_NOT_FOUND', 404);
  const cache = opts.cache;
  if (cache && cache.has(businessId)) return cache.get(businessId);

  const b = await prisma.business.findUnique({
    where: { id: businessId },
    select: { hrCountry: true, hrCurrency: true, hrCountryAmbiguous: true },
  });
  if (!b) throw new CountryError('TENANT_NOT_FOUND', 404);
  if (b.hrCountryAmbiguous) throw new CountryError('HR_COUNTRY_AMBIGUOUS', 409); // quarantined
  if (!b.hrCountry) throw new CountryError('HR_NOT_SET_UP', 409); // pre-setup tenant

  const out = {
    country: String(b.hrCountry).toUpperCase(),
    currency: (b.hrCurrency || payCurrencyFor(b.hrCountry)).toUpperCase(),
    ambiguous: false,
  };
  if (cache) cache.set(businessId, out);
  return out;
}

/** The tenant's HR country (ISO-2). Throws fail-closed if not set / ambiguous. */
async function tenantCountry(businessId, opts) {
  return (await loadHrCountry(businessId, opts)).country;
}

/** The tenant's HR currency (ISO-3). Throws fail-closed if not set / ambiguous. */
async function tenantCurrency(businessId, opts) {
  return (await loadHrCountry(businessId, opts)).currency;
}

/** The tenant's full capability matrix. Throws fail-closed if not set / ambiguous. */
async function tenantCapabilities(businessId, opts) {
  const { country, currency } = await loadHrCountry(businessId, opts);
  return { country, currency, capabilities: countryCapabilities(country) };
}

/**
 * Fail-closed equality assert used by the write-guards AND the per-row tripwires.
 * Throws COUNTRY_MISMATCH (422) when `code` ≠ the tenant country. In a single
 * -country tenant this is always satisfied for legitimate rows; a throw means a
 * crafted off-country write or a bad backfill (the tripwire that catches drift).
 *
 * @returns {Promise<string>} the tenant country (on match)
 */
async function assertCountry(businessId, code, opts) {
  const c = await tenantCountry(businessId, opts);
  if (String(code || '').toUpperCase() !== c) {
    throw new CountryError('COUNTRY_MISMATCH', 422, { expected: c, got: code });
  }
  return c;
}

module.exports = {
  REGISTRABLE_HR_COUNTRIES,
  isRegistrableHrCountry,
  countryCapabilities,
  payCurrencyFor,
  loadHrCountry,
  tenantCountry,
  tenantCurrency,
  tenantCapabilities,
  assertCountry,
  CountryError,
  _CAPABILITIES: CAPABILITIES,
};

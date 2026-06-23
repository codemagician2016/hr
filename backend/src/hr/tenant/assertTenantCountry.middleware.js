'use strict';

/**
 * assertTenantCountry.middleware.js — Feature 14 write-guards (fail-closed).
 *
 * Mounted on every route that CREATES a country-bearing row (Entity, Location,
 * Holiday, compensation structure/revision currency, StatutoryProfile, Employee
 * when a country is supplied). Two behaviours:
 *   - field NOT supplied → stamp the tenant country/currency onto the body (so an
 *     entity create with no countryCode inherits the tenant country, never a guess).
 *   - field supplied     → must equal the tenant country/currency, else 422.
 *
 * The tenant country is read once per request and memoized on `req` (hrCountry is
 * immutable). businessId comes from F1 scope middleware (`req.user.businessId` for
 * operator sessions, `req.businessId` / `req.customer.businessId` otherwise).
 */

const {
  tenantCountry,
  tenantCurrency,
} = require('./countryContext');

function resolveBusinessId(req) {
  return (
    (req.user && req.user.businessId) ||
    req.businessId ||
    (req.customer && req.customer.businessId) ||
    null
  );
}

// Per-request memo so a route with multiple guards reads hrCountry once.
function reqCache(req) {
  if (!req._countryCtxCache) req._countryCtxCache = new Map();
  return req._countryCtxCache;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

function mapError(e, res, next) {
  if (e && e.code === 'COUNTRY_MISMATCH') {
    return res.status(422).json({
      message: 'This field does not match your business country',
      code: 'COUNTRY_MISMATCH',
      detail: e.detail,
    });
  }
  if (e && e.code === 'HR_NOT_SET_UP') {
    return res
      .status(409)
      .json({ message: 'Finish HR setup (set your business country) first', code: 'HR_NOT_SET_UP' });
  }
  if (e && e.code === 'HR_COUNTRY_AMBIGUOUS') {
    return res
      .status(409)
      .json({ message: 'Your tenant country needs admin review', code: 'HR_COUNTRY_AMBIGUOUS' });
  }
  if (e && e.code === 'TENANT_NOT_FOUND') {
    return res.status(404).json({ message: 'Tenant not found', code: 'TENANT_NOT_FOUND' });
  }
  return next(e);
}

/**
 * Guard a country field (default `body.countryCode`). Supplied → must match the
 * tenant country; absent → stamped to the tenant country UNLESS `stampWhenAbsent`
 * is false (e.g. Employee.countryCode is legitimately nullable, so we only assert
 * when a value is supplied and leave it null otherwise — the §11 edge case).
 *
 * @param {string} fieldPath
 * @param {{ stampWhenAbsent?: boolean }} [opts]
 */
function assertTenantCountryWrite(fieldPath = 'body.countryCode', opts = {}) {
  const stampWhenAbsent = opts.stampWhenAbsent !== false;
  return async (req, res, next) => {
    try {
      const businessId = resolveBusinessId(req);
      const cache = reqCache(req);
      const got = getPath(req, fieldPath);
      if (got == null || got === '') {
        if (!stampWhenAbsent) return next(); // nullable field — leave it null
        setPath(req, fieldPath, await tenantCountry(businessId, { cache }));
        return next();
      }
      const expected = await tenantCountry(businessId, { cache });
      if (String(got).toUpperCase() !== expected) {
        return res.status(422).json({
          message: 'This field does not match your business country',
          code: 'COUNTRY_MISMATCH',
          detail: { expected, got },
        });
      }
      return next();
    } catch (e) {
      return mapError(e, res, next);
    }
  };
}

/**
 * Guard a currency field (default `body.currencyCode`). Supplied → must equal the
 * tenant currency; absent → stamped to the tenant currency. Kills the off-currency
 * leak path on comp revisions / offers at the WRITE side.
 */
function assertTenantCurrencyWrite(fieldPath = 'body.currencyCode') {
  return async (req, res, next) => {
    try {
      const businessId = resolveBusinessId(req);
      const cache = reqCache(req);
      const got = getPath(req, fieldPath);
      if (got == null || got === '') {
        setPath(req, fieldPath, await tenantCurrency(businessId, { cache }));
        return next();
      }
      const expected = await tenantCurrency(businessId, { cache });
      if (String(got).toUpperCase() !== expected) {
        return res.status(422).json({
          message: 'This currency does not match your business country',
          code: 'CURRENCY_MISMATCH',
          detail: { expected, got },
        });
      }
      return next();
    } catch (e) {
      return mapError(e, res, next);
    }
  };
}

module.exports = {
  assertTenantCountryWrite,
  assertTenantCurrencyWrite,
  resolveBusinessId,
};

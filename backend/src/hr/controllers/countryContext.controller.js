'use strict';

/**
 * countryContext.controller.js — Feature 14 HTTP surface for the tenant country.
 *
 *   POST /api/hr/setup/country        set the tenant HR country ONCE (locked after)
 *   GET  /api/hr/country-context      capability matrix for hr-admin (operator)
 *   GET  /api/hr/me/country-context   capability matrix for the ESS employee
 *
 * `hrCountry` is writable EXACTLY here (setup) and nowhere else — there is no PATCH.
 * The two GET endpoints are the front-end contract: the apps render every
 * country-specific surface from `capabilities`, never from a hard-coded literal.
 */

const prisma = require('../../core/lib/prisma');
const {
  REGISTRABLE_HR_COUNTRIES,
  isRegistrableHrCountry,
  countryCapabilities,
  payCurrencyFor,
  loadHrCountry,
} = require('../tenant/countryContext');

// POST /api/hr/setup/country  { country }
// RBAC: canManageCompanyProfile (Owner/HR-Admin). Locked-once: a second call 409s.
async function setupCountry(req, res, next) {
  try {
    const businessId = req.user && req.user.businessId;
    if (!businessId) return res.status(401).json({ message: 'Unauthenticated' });
    const country = String((req.body && req.body.country) || '').toUpperCase();
    if (!country) return res.status(400).json({ message: 'country is required' });
    if (!isRegistrableHrCountry(country)) {
      return res.status(422).json({
        message: 'That country is not available yet',
        code: 'NOT_REGISTRABLE',
        registrable: REGISTRABLE_HR_COUNTRIES,
      });
    }
    const b = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, hrCountrySetAt: true, hrCountry: true },
    });
    if (!b) return res.status(404).json({ message: 'Tenant not found' });
    // Locked-once: immutable after the first successful setup.
    if (b.hrCountrySetAt != null) {
      return res.status(409).json({
        message: 'Your business country is already set and cannot be changed',
        code: 'HR_COUNTRY_LOCKED',
        country: b.hrCountry || null,
      });
    }
    const currency = payCurrencyFor(country);
    await prisma.business.update({
      where: { id: businessId },
      data: {
        hrCountry: country,
        hrCurrency: currency,
        hrCountrySetAt: new Date(),
        region: country,
        hrCountryAmbiguous: false,
      },
    });
    return res.json({ country, currency, capabilities: countryCapabilities(country) });
  } catch (e) { return next(e); }
}

// Shared body for the two GET endpoints. Fail-closed: a pre-setup / ambiguous
// tenant returns a non-200 status with a code the apps render as "HR not set up".
async function contextFor(businessId, res, next) {
  try {
    const { country, currency } = await loadHrCountry(businessId);
    return res.json({ country, currency, capabilities: countryCapabilities(country) });
  } catch (e) {
    if (e && e.code === 'HR_NOT_SET_UP') {
      return res.status(409).json({ message: 'HR is not configured for this business', code: 'HR_NOT_SET_UP' });
    }
    if (e && e.code === 'HR_COUNTRY_AMBIGUOUS') {
      return res.status(409).json({ message: 'Your tenant country needs admin review', code: 'HR_COUNTRY_AMBIGUOUS' });
    }
    if (e && e.code === 'TENANT_NOT_FOUND') {
      return res.status(404).json({ message: 'Tenant not found', code: 'TENANT_NOT_FOUND' });
    }
    return next(e);
  }
}

// GET /api/hr/country-context — operator (hr-admin). Any HR operator may read.
async function getCountryContext(req, res, next) {
  const businessId = req.user && req.user.businessId;
  if (!businessId) return res.status(401).json({ message: 'Unauthenticated' });
  return contextFor(businessId, res, next);
}

// GET /api/hr/me/country-context — ESS employee (customer session, self scope).
async function getMyCountryContext(req, res, next) {
  const businessId = req.customer && req.customer.businessId;
  if (!businessId) return res.status(401).json({ message: 'Unauthenticated' });
  return contextFor(businessId, res, next);
}

module.exports = { setupCountry, getCountryContext, getMyCountryContext };

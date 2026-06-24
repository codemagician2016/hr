'use strict';

/**
 * tenantCountry.controller.js — Feature 14 super-admin tenant-country surface.
 *
 *   GET  /api/superadmin/tenants/:id/country          → inspect a tenant's state
 *   POST /api/superadmin/tenants/:id/country/resolve  → break-glass repair of an
 *                                                        AMBIGUOUS (quarantined) tenant
 *
 * Mounted under the super-admin router (requireAuth + requireSuperAdmin), so these
 * are the ONLY off-tenant writes to hrCountry. There is no tenant-facing "change
 * country". The resolve action is allowed ONLY when hrCountryAmbiguous=true and
 * refuses if off-country entities still exist (returns the offending entity ids).
 */

const prisma = require('../../core/lib/prisma');
const {
  isRegistrableHrCountry,
  payCurrencyFor,
} = require('../../hr/tenant/countryContext');

function norm(cc) {
  return cc ? String(cc).toUpperCase() : null;
}

async function entityCountries(businessId) {
  const rows = await prisma.entity.findMany({
    where: { businessId, deletedAt: null },
    select: { countryCode: true },
  });
  return [...new Set(rows.map((r) => norm(r.countryCode)).filter(Boolean))];
}

// GET /api/superadmin/tenants/:id/country
async function getTenantCountry(req, res, next) {
  try {
    const { id } = req.params;
    const b = await prisma.business.findUnique({
      where: { id },
      select: {
        id: true, slug: true, name: true,
        hrCountry: true, hrCurrency: true, hrCountrySetAt: true, hrCountryAmbiguous: true,
        region: true, country: true,
      },
    });
    if (!b) return res.status(404).json({ message: 'Tenant not found' });
    const countries = await entityCountries(id);
    return res.json({
      id: b.id,
      slug: b.slug,
      name: b.name,
      hrCountry: b.hrCountry || null,
      hrCurrency: b.hrCurrency || null,
      hrCountrySetAt: b.hrCountrySetAt || null,
      hrCountryAmbiguous: !!b.hrCountryAmbiguous,
      storefrontRegion: b.region || null,
      storefrontCountry: b.country || null,
      entityCountries: countries,
    });
  } catch (e) { return next(e); }
}

// POST /api/superadmin/tenants/:id/country/resolve  { country }
async function resolveTenantCountry(req, res, next) {
  try {
    const { id } = req.params;
    const country = norm(req.body && req.body.country);
    if (!country) return res.status(400).json({ message: 'country is required' });
    if (!isRegistrableHrCountry(country)) {
      return res.status(422).json({ message: `country ${country} is not registrable`, code: 'NOT_REGISTRABLE' });
    }
    const b = await prisma.business.findUnique({
      where: { id },
      select: { id: true, hrCountry: true, hrCountrySetAt: true, hrCountryAmbiguous: true },
    });
    if (!b) return res.status(404).json({ message: 'Tenant not found' });
    // Break-glass ONLY for quarantined tenants. A normally-stamped tenant is immutable.
    if (!b.hrCountryAmbiguous) {
      return res.status(409).json({ message: 'Tenant is not ambiguous; country is immutable', code: 'NOT_AMBIGUOUS' });
    }
    // Refuse while off-country entities still exist — the remediation must precede
    // the stamp so the §3.3 invariant holds once the flag clears.
    const offCountry = await prisma.entity.findMany({
      where: { businessId: id, deletedAt: null, NOT: { countryCode: country } },
      select: { id: true, code: true, countryCode: true },
    });
    if (offCountry.length) {
      return res.status(409).json({
        message: 'Off-country entities still exist; remediate them before resolving',
        code: 'OFF_COUNTRY_ENTITIES',
        offendingEntities: offCountry,
      });
    }
    // Atomic break-glass: gate the write on hrCountryAmbiguous=true in the WHERE
    // so two concurrent resolves can't both pass the read-side check above and
    // double-stamp. Exactly one racer's update affects a row; the loser sees
    // count 0 → 409 (already resolved / no longer ambiguous).
    const { count } = await prisma.business.updateMany({
      where: { id, hrCountryAmbiguous: true },
      data: {
        hrCountry: country,
        hrCurrency: payCurrencyFor(country),
        hrCountrySetAt: new Date(),
        hrCountryAmbiguous: false,
        region: country,
      },
    });
    if (count === 0) {
      return res.status(409).json({ message: 'Tenant is not ambiguous; country is immutable', code: 'NOT_AMBIGUOUS' });
    }
    const updated = await prisma.business.findUnique({
      where: { id },
      select: { id: true, hrCountry: true, hrCurrency: true, hrCountrySetAt: true, hrCountryAmbiguous: true },
    });
    return res.json({ resolved: true, ...updated });
  } catch (e) { return next(e); }
}

module.exports = { getTenantCountry, resolveTenantCountry };

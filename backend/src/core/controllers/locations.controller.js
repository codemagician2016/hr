// Multi-location admin endpoints. BUSINESS_ADMIN scope.
'use strict';
const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { normalisePoint, resolveByCoordinates, resolveByPostalCode } = require('../lib/locationResolve');
const { assertNumericLimit } = require('../lib/entitlements');
const { resolveVertical } = require('../lib/vertical');
const prisma = new PrismaClient();

async function bizId(req) { return req.user?.businessId || null; }

function locationEntitlementForBusiness(business) {
  if (resolveVertical(business?.vertical) !== 'ECOMMERCE') {
    return { key: 'locations_count', label: 'locations' };
  }
  const mode = String(business?.multiStoreMode || 'OFF').toUpperCase();
  if (['CHAIN', 'REGIONAL', 'BOTH'].includes(mode)) {
    return { key: 'branches_count', label: 'branches' };
  }
  return { key: 'fulfillment_locations_count', label: 'fulfillment locations' };
}

async function list(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const items = await prisma.businessLocation.findMany({
    where: { businessId }, orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
  });
  res.json({ locations: items });
}

const schema = z.object({
  name: z.string().min(1).max(100),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(30).optional(),
  country: z.string().length(2).optional(),
  phone: z.string().max(40).optional(),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

async function create(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });

  const [business, existingCount] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { vertical: true, multiStoreMode: true },
    }),
    prisma.businessLocation.count({ where: { businessId } }),
  ]);
  const entitlement = locationEntitlementForBusiness(business);
  try {
    await assertNumericLimit({
      businessId,
      key: entitlement.key,
      currentCount: existingCount,
      increment: 1,
      label: entitlement.label,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      message: err.message || 'Plan limit reached.',
      code: err.code || 'plan_limit_error',
      entitlement: err.entitlement || null,
      currentCount: err.currentCount,
    });
  }

  // First location for a business is always the primary, active store — a
  // single-store seller shouldn't have to understand "primary" / "active"
  // to be ready. This makes the Store Setup window one-step for them.
  if (existingCount === 0) {
    parsed.data.isPrimary = true;
    parsed.data.isActive = true;
  }

  // If marking primary, unmark other primaries first.
  if (parsed.data.isPrimary) {
    await prisma.businessLocation.updateMany({ where: { businessId, isPrimary: true }, data: { isPrimary: false } });
  }
  const loc = await prisma.businessLocation.create({ data: { businessId, ...parsed.data } });
  res.status(201).json(loc);
}

async function update(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  const existing = await prisma.businessLocation.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });

  if (parsed.data.isPrimary) {
    await prisma.businessLocation.updateMany({
      where: { businessId, isPrimary: true, NOT: { id: req.params.id } },
      data: { isPrimary: false },
    });
  }
  const loc = await prisma.businessLocation.update({ where: { id: req.params.id }, data: parsed.data });
  res.json(loc);
}

async function remove(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const existing = await prisma.businessLocation.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  await prisma.businessLocation.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}

// Public — storefront calls this to render the location-picker step in
// the booking wizard. Returns active locations only, with no admin-only
// fields exposed.
async function listPublic(req, res) {
  const business = await prisma.business.findUnique({
    where: { slug: req.params.slug },
    select: { id: true, isActive: true },
  });
  if (!business || !business.isActive) return res.status(404).json({ message: 'Business not found' });
  const items = await prisma.businessLocation.findMany({
    where: { businessId: business.id, isActive: true },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    select: {
      id: true, name: true, addressLine1: true, addressLine2: true,
      city: true, state: true, postalCode: true, country: true,
      phone: true, isPrimary: true,
    },
  });
  res.json({ locations: items });
}

// GET /api/storefront/:slug/locations/resolve?postalCode=XXXXXX
// GET /api/storefront/:slug/locations/resolve?lat=28.61&lng=77.20
//
// ECOMMERCE multi-store Flow A (2026-05-11) — shopper types a postal
// code on the landing page; we return the store(s) that can deliver.
//
//   0 candidates → { serviceable: false } — render "we don't deliver here"
//   1 candidate  → frontend auto-picks → POST /cart/location
//   multiple     → frontend renders chooser → POST /cart/location
//
// Response shape is stable so Flow C (manual picker) and Flow B (geo pin)
// can share the rendering component.
async function resolvePublic(req, res) {
  const business = await prisma.business.findUnique({
    where: { slug: String(req.params.slug || '').toLowerCase() },
    select: { id: true, isActive: true },
  });
  if (!business || !business.isActive) return res.status(404).json({ message: 'Business not found' });

  const rawLat = req.query.lat ?? req.query.latitude;
  const rawLng = req.query.lng ?? req.query.lon ?? req.query.longitude;
  const hasCoordinateInput = rawLat !== undefined || rawLng !== undefined;
  const point = normalisePoint({ lat: rawLat, lng: rawLng });
  const postalCode = String(req.query.postalCode || req.query.pincode || '').trim();

  if (hasCoordinateInput && !point) {
    return res.status(400).json({ message: 'valid lat and lng are required' });
  }
  if (!point && !postalCode) return res.status(400).json({ message: 'postalCode or coordinates are required' });
  if (!point && postalCode.length > 20) return res.status(400).json({ message: 'postalCode too long' });

  const [result, activeDeliveryAreaCount] = await Promise.all([
    point
      ? resolveByCoordinates({ prisma, businessId: business.id, lat: point.lat, lng: point.lng })
      : resolveByPostalCode({ prisma, businessId: business.id, postalCode }),
    prisma.ecomDeliveryZone.count({ where: { businessId: business.id, isActive: true } }),
  ]);
  return res.json({
    mode: point ? 'coordinates' : 'postalCode',
    postalCode: result.postalCode || null,
    point: result.point || null,
    serviceable: result.candidates.length > 0,
    hasDeliveryAreas: activeDeliveryAreaCount > 0,
    locations: result.candidates.map(({ location, zone }) => ({
      ...location,
      zone: zone ? {
        id: zone.id,
        name: zone.name,
        slug: zone.slug,
        deliveryFeeMinor: zone.deliveryFeeMinor,
        freeDeliveryThresholdMinor: zone.freeDeliveryThresholdMinor,
        expressSurchargeMinor: zone.expressSurchargeMinor,
        promiseMinutes: zone.promiseMinutes,
      } : null,
    })),
  });
}

module.exports = { list, create, update, remove, listPublic, resolvePublic };

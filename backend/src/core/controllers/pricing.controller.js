// Pricing admin controller — tiers, zones, countries, prices.
// All mutations write a PricingAuditLog entry. All amounts are integer minor units.
// Public pricing lives in publicPricing.controller.js (mounted at /api/public/pricing).

const prisma = require('../lib/prisma');
const { buildPlanCatalogMatrix } = require('../lib/planCatalog');
const { VALID_VERTICALS, DEFAULT_VERTICAL } = require('../lib/vertical');
const { previewPublish, publishToGateways, syncGatewaysBackground, SUPPORTED_GATEWAYS } = require('../lib/gatewayCatalogService');

// -----------------------------------------------------------------------------
// Audit helper — fire-and-log; never blocks the caller if the write fails.
// -----------------------------------------------------------------------------

async function audit(req, entityType, entityId, action, oldValue, newValue, note) {
  try {
    await prisma.pricingAuditLog.create({
      data: {
        entityType, entityId, action,
        changedBy: req.user?.id || 'system',
        oldValue: oldValue ?? undefined,
        newValue: newValue ?? undefined,
        note: note || null,
      },
    });
  } catch (err) {
    console.error('[pricing audit] failed:', err.message);
  }
}

function normalizeTrialDays(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === false) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
    const err = new Error('Trial days must be blank/off or a whole number from 1 to 365.');
    err.status = 400;
    throw err;
  }
  return parsed;
}

// -----------------------------------------------------------------------------
// Tiers
// -----------------------------------------------------------------------------

async function listTiers(req, res) {
  // Optional ?vertical= filter so the super-admin Pricing UI can show
  // each vertical's catalogue separately. Omitted = return all.
  const { SUPPORTED_BILLING_CURRENCIES } = require('../lib/billing/gatewayRouter');
  const verticalRaw = String(req.query?.vertical || '').toUpperCase();
  const vertical = VALID_VERTICALS.has(verticalRaw) ? verticalRaw : null;
  const tiers = await prisma.pricingTier.findMany({
    where: vertical ? { vertical } : undefined,
    orderBy: { sortOrder: 'asc' },
    include: {
      // All 5 billing-currency rows (INR/NZD/GBP/EUR/USD), so the collapsed plan
      // cards can show the live customer-facing price in any currency — the same
      // canonical rows the landing resolves from. USD base = the countryCode:null row.
      prices: { where: { currencyCode: { in: SUPPORTED_BILLING_CURRENCIES } }, orderBy: [{ currencyCode: 'asc' }, { countryCode: 'asc' }] },
      _count: { select: { prices: true, tierFeatures: true } },
    },
  });
  res.json({ tiers });
}

async function getCatalogMatrix(_req, res) {
  const tiers = await prisma.pricingTier.findMany({
    orderBy: [{ vertical: 'asc' }, { sortOrder: 'asc' }],
    include: {
      prices: { where: { countryCode: null } },
    },
  });
  const matrix = buildPlanCatalogMatrix(tiers);
  const summary = {
    families: matrix.length,
    missingVariants: matrix.reduce((sum, row) => sum + row.missingVerticals.length, 0),
    selfServeReadyVariants: matrix.reduce((sum, row) => (
      sum + Object.values(row.variants).filter((variant) => variant?.coverage?.paidSelfServeReady).length
    ), 0),
  };
  res.json({ matrix, summary });
}

async function getTier(req, res) {
  const { SUPPORTED_BILLING_CURRENCIES } = require('../lib/billing/gatewayRouter');
  const tier = await prisma.pricingTier.findUnique({
    where: { id: req.params.id },
    include: {
      // Only the 5 currencies we actually bill in (INR/NZD/GBP/EUR/USD). Legacy
      // per-country rows in other currencies are inert and hidden from admin.
      prices: { where: { currencyCode: { in: SUPPORTED_BILLING_CURRENCIES } }, orderBy: [{ currencyCode: 'asc' }, { countryCode: 'asc' }] },
      tierFeatures: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!tier) return res.status(404).json({ message: 'Tier not found' });
  res.json({ tier });
}

async function createTier(req, res) {
  const {
    slug, name, description, badge, sortOrder, isCustomPriced, trialDays, baseMonthlyUsd,
    tagline, features, ctaLabel, ctaHref, highlighted, includedStaff, vertical,
    includedBranches, contactSalesAboveBranches,
  } = req.body;
  if (!slug || !name) return res.status(400).json({ message: 'slug and name are required' });

  const existing = await prisma.pricingTier.findUnique({ where: { slug } });
  if (existing) return res.status(409).json({ message: `Tier with slug "${slug}" already exists` });
  let normalizedTrialDays;
  try {
    normalizedTrialDays = normalizeTrialDays(trialDays);
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
  }

  // Vertical is optional in payload — defaults to APPOINTMENT (matches
  // schema default + back-compat with existing tiers). Validated against
  // the same enum the rest of the stack uses.
  const verticalNorm = String(vertical || '').toUpperCase();
  const verticalToSet = VALID_VERTICALS.has(verticalNorm) ? verticalNorm : DEFAULT_VERTICAL;

  const tier = await prisma.pricingTier.create({
    data: {
      slug, name,
      vertical: verticalToSet,
      description: description || null,
      badge: badge || null,
      tagline: tagline || null,
      features: Array.isArray(features) ? features.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [],
      ctaLabel: ctaLabel || null,
      ctaHref: ctaHref || null,
      highlighted: !!highlighted,
      includedStaff: includedStaff == null || includedStaff === '' ? null : Number(includedStaff),
      includedBranches: includedBranches == null || includedBranches === '' ? null : Number(includedBranches),
      contactSalesAboveBranches: contactSalesAboveBranches == null || contactSalesAboveBranches === '' ? null : Number(contactSalesAboveBranches),
      sortOrder: Number(sortOrder) || 0,
      isCustomPriced: !!isCustomPriced,
      trialDays: normalizedTrialDays ?? null,
    },
  });

  // Seed a base USD price row so the tier is usable immediately.
  if (baseMonthlyUsd != null) {
    const monthlyMinor = Math.round(Number(baseMonthlyUsd) * 100);
    await prisma.tierPrice.create({
      data: {
        tierId: tier.id, countryCode: null, currencyCode: 'USD',
        amountMonthlyMinor: monthlyMinor,
        amountAnnualMinor: Math.round(monthlyMinor * 9.6),
      },
    });
  }

  await audit(req, 'tier', tier.id, 'CREATED', null, tier);
  syncGatewaysBackground(`tier created: ${tier.slug}`);
  res.status(201).json({ tier });
}

async function updateTier(req, res) {
  const { id } = req.params;
  const {
    name, description, badge, sortOrder, isActive, isCustomPriced, trialDays,
    tagline, features, ctaLabel, ctaHref, highlighted, includedStaff, vertical,
    includedBranches, contactSalesAboveBranches,
  } = req.body;

  const before = await prisma.pricingTier.findUnique({ where: { id } });
  if (!before) return res.status(404).json({ message: 'Tier not found' });
  let normalizedTrialDays;
  try {
    normalizedTrialDays = normalizeTrialDays(trialDays);
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
  }

  const data = {};
  if (name !== undefined)            data.name = name;
  if (description !== undefined)     data.description = description;
  if (badge !== undefined)           data.badge = badge;
  if (sortOrder !== undefined)       data.sortOrder = Number(sortOrder);
  if (isActive !== undefined)        data.isActive = !!isActive;
  if (isCustomPriced !== undefined)  data.isCustomPriced = !!isCustomPriced;
  if (trialDays !== undefined)       data.trialDays = normalizedTrialDays;
  if (tagline !== undefined)         data.tagline = tagline || null;
  if (ctaLabel !== undefined)        data.ctaLabel = ctaLabel || null;
  if (ctaHref !== undefined)         data.ctaHref = ctaHref || null;
  if (highlighted !== undefined)     data.highlighted = !!highlighted;
  if (includedStaff !== undefined)   data.includedStaff = includedStaff == null || includedStaff === '' ? null : Number(includedStaff);
  if (includedBranches !== undefined)          data.includedBranches = includedBranches == null || includedBranches === '' ? null : Number(includedBranches);
  if (contactSalesAboveBranches !== undefined) data.contactSalesAboveBranches = contactSalesAboveBranches == null || contactSalesAboveBranches === '' ? null : Number(contactSalesAboveBranches);
  if (vertical !== undefined) {
    const v = String(vertical).toUpperCase();
    if (VALID_VERTICALS.has(v)) data.vertical = v;
  }
  if (features !== undefined) {
    // Accept either an array or a newline-separated string (the super-admin
    // textarea sends the latter). Filter empties, trim each, cap at 20 bullets.
    const arr = Array.isArray(features)
      ? features
      : typeof features === 'string'
        ? features.split(/\r?\n/)
        : [];
    data.features = arr.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).slice(0, 20);
  }

  const tier = await prisma.pricingTier.update({ where: { id }, data });
  await audit(req, 'tier', id, 'UPDATED', before, tier, req.body.note);
  syncGatewaysBackground(`tier updated: ${tier.slug}`);
  res.json({ tier });
}

async function reorderTiers(req, res) {
  const { order } = req.body; // array of tier IDs in desired order
  if (!Array.isArray(order)) return res.status(400).json({ message: 'order must be an array of tier IDs' });

  await prisma.$transaction(
    order.map((id, idx) => prisma.pricingTier.update({ where: { id }, data: { sortOrder: idx + 1 } })),
  );
  await audit(req, 'tier', 'reorder', 'UPDATED', null, { order });
  res.json({ message: 'Tiers reordered' });
}

async function archiveTier(req, res) {
  const { id } = req.params;
  const before = await prisma.pricingTier.findUnique({ where: { id } });
  if (!before) return res.status(404).json({ message: 'Tier not found' });

  const tier = await prisma.pricingTier.update({
    where: { id },
    data: { isActive: false },
  });
  await audit(req, 'tier', id, 'UPDATED', before, tier, 'archived');
  res.json({ tier });
}

// -----------------------------------------------------------------------------
// Zones
// -----------------------------------------------------------------------------

async function listZones(_req, res) {
  const zones = await prisma.pricingZone.findMany({
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { countries: true } } },
  });
  res.json({ zones });
}

async function updateZone(req, res) {
  const { id } = req.params;
  const { name, description, multiplier, sortOrder, isActive } = req.body;

  const before = await prisma.pricingZone.findUnique({ where: { id } });
  if (!before) return res.status(404).json({ message: 'Zone not found' });

  const data = {};
  if (name !== undefined)        data.name = name;
  if (description !== undefined) data.description = description;
  if (multiplier !== undefined)  data.multiplier = String(multiplier); // Prisma Decimal accepts strings
  if (sortOrder !== undefined)   data.sortOrder = Number(sortOrder);
  if (isActive !== undefined)    data.isActive = !!isActive;

  const zone = await prisma.pricingZone.update({ where: { id }, data });
  await audit(req, 'zone', id, 'UPDATED', before, zone, req.body.note);
  res.json({ zone });
}

// -----------------------------------------------------------------------------
// Countries
// -----------------------------------------------------------------------------

async function listCountries(req, res) {
  const { zoneSlug, region, search } = req.query;
  const where = {};
  if (zoneSlug) where.zone = { slug: zoneSlug };
  if (region) where.region = region;
  if (search) {
    where.OR = [
      { countryName: { contains: search, mode: 'insensitive' } },
      { countryCode: { contains: search, mode: 'insensitive' } },
    ];
  }
  const countries = await prisma.countryZoneAssignment.findMany({
    where,
    include: { zone: { select: { id: true, slug: true, name: true, multiplier: true } } },
    orderBy: { countryName: 'asc' },
  });
  res.json({ countries });
}

async function updateCountry(req, res) {
  const { code } = req.params;
  const { zoneId, currencyCode, currencySymbol, region } = req.body;

  const before = await prisma.countryZoneAssignment.findUnique({ where: { countryCode: code } });
  if (!before) return res.status(404).json({ message: 'Country not found' });

  const data = {};
  if (zoneId !== undefined) {
    const zone = await prisma.pricingZone.findUnique({ where: { id: zoneId } });
    if (!zone) return res.status(400).json({ message: 'Invalid zoneId' });
    data.zoneId = zoneId;
    data.isOverride = true;
    data.updatedBy = req.user?.id || null;
  }
  if (currencyCode !== undefined)   data.currencyCode = currencyCode;
  if (currencySymbol !== undefined) data.currencySymbol = currencySymbol;
  if (region !== undefined)         data.region = region;

  const country = await prisma.countryZoneAssignment.update({
    where: { countryCode: code }, data,
  });
  await audit(req, 'country', code, 'UPDATED', before, country, req.body.note);
  res.json({ country });
}

async function bulkAssignCountries(req, res) {
  const { countryCodes, zoneId } = req.body;
  if (!Array.isArray(countryCodes) || !zoneId) {
    return res.status(400).json({ message: 'countryCodes (array) and zoneId are required' });
  }
  const zone = await prisma.pricingZone.findUnique({ where: { id: zoneId } });
  if (!zone) return res.status(400).json({ message: 'Invalid zoneId' });

  const result = await prisma.countryZoneAssignment.updateMany({
    where: { countryCode: { in: countryCodes } },
    data: { zoneId, isOverride: true, updatedBy: req.user?.id || null },
  });
  await audit(req, 'country', 'bulk', 'UPDATED', null, { countryCodes, zoneId }, `Bulk assigned ${result.count} countries`);
  res.json({ updated: result.count });
}

// -----------------------------------------------------------------------------
// Prices  (per-tier, per-country; country=null is the base USD price)
// -----------------------------------------------------------------------------

async function listPrices(req, res) {
  const { tierId } = req.query;
  const where = {};
  if (tierId) where.tierId = tierId;
  const prices = await prisma.tierPrice.findMany({
    where,
    orderBy: [{ tierId: 'asc' }, { countryCode: 'asc' }],
  });
  res.json({ prices });
}

async function upsertPrice(req, res) {
  const { tierId, countryCode, currencyCode, amountMonthlyMinor, amountAnnualMinor, overageStaffPriceMinor, overageBranchPriceMinor } = req.body;
  if (!tierId || !currencyCode || amountMonthlyMinor == null || amountAnnualMinor == null) {
    return res.status(400).json({ message: 'tierId, currencyCode, amountMonthlyMinor, amountAnnualMinor are required' });
  }

  const tier = await prisma.pricingTier.findUnique({ where: { id: tierId } });
  if (!tier) return res.status(400).json({ message: 'Invalid tierId' });

  // countryCode = null means base price. Use findFirst/create/update because
  // Prisma won't accept null in compound-unique where clauses.
  const normalizedCountry = countryCode || null;
  const existing = await prisma.tierPrice.findFirst({
    where: { tierId, countryCode: normalizedCountry },
  });

  const data = {
    currencyCode,
    amountMonthlyMinor: Number(amountMonthlyMinor),
    amountAnnualMinor: Number(amountAnnualMinor),
    overageStaffPriceMinor: Number(overageStaffPriceMinor) || 0,
    overageBranchPriceMinor: Number(overageBranchPriceMinor) || 0,
    isOverride: !!normalizedCountry,
    lastSyncedToPaddleAt: null, // mark dirty
  };

  // Gateway price/plan IDs — only update when the caller included the key so a
  // price-only edit doesn't wipe an existing id; an empty string clears it. All
  // three gateways are editable now (previously Paddle-only). Note: Publish
  // normally manages these, but a manual override stays possible.
  for (const key of ['paddlePriceIdMonthly', 'paddlePriceIdAnnual', 'stripePriceIdMonthly', 'stripePriceIdAnnual', 'razorpayPlanIdMonthly', 'razorpayPlanIdAnnual']) {
    if (req.body[key] !== undefined) data[key] = req.body[key] ? String(req.body[key]).trim() : null;
  }

  let price;
  if (existing) {
    price = await prisma.tierPrice.update({ where: { id: existing.id }, data });
    await audit(req, 'tier_price', existing.id, 'UPDATED', existing, price, req.body.note);
  } else {
    price = await prisma.tierPrice.create({
      data: { tierId, countryCode: normalizedCountry, ...data },
    });
    await audit(req, 'tier_price', price.id, 'CREATED', null, price, req.body.note);
  }
  syncGatewaysBackground('tier price changed');
  res.json({ price });
}

async function deletePriceOverride(req, res) {
  const { tierId, countryCode } = req.params;
  if (!countryCode || countryCode === 'null') {
    return res.status(400).json({ message: 'Cannot delete base price; update it instead' });
  }
  const before = await prisma.tierPrice.findFirst({ where: { tierId, countryCode } });
  if (!before) return res.status(404).json({ message: 'Price override not found' });

  await prisma.tierPrice.delete({ where: { id: before.id } });
  await audit(req, 'tier_price', before.id, 'DELETED', before, null);
  res.json({ message: 'Override removed' });
}

// -----------------------------------------------------------------------------
// Tier features (structured entitlement rows — read by entitlements.js). These
// were seed-only before; the studio's feature editor needs full CRUD so card
// copy and real access can't drift.
// -----------------------------------------------------------------------------

const FEATURE_TYPES = ['BOOLEAN', 'NUMERIC', 'UNLIMITED'];

async function createFeature(req, res) {
  const { id: tierId } = req.params;
  const { featureKey, featureType, featureValue, displayLabel, description, isHighlighted, sortOrder } = req.body;
  if (!featureKey || !displayLabel) return res.status(400).json({ message: 'featureKey and displayLabel are required' });
  const type = String(featureType || 'BOOLEAN').toUpperCase();
  if (!FEATURE_TYPES.includes(type)) return res.status(400).json({ message: `featureType must be one of ${FEATURE_TYPES.join(', ')}` });
  const tier = await prisma.pricingTier.findUnique({ where: { id: tierId } });
  if (!tier) return res.status(404).json({ message: 'Tier not found' });
  try {
    const feature = await prisma.tierFeature.create({
      data: {
        tierId, featureKey: String(featureKey).trim(), featureType: type,
        featureValue: featureValue == null ? '' : String(featureValue),
        displayLabel: String(displayLabel).trim(),
        description: description ? String(description) : null,
        isHighlighted: !!isHighlighted,
        sortOrder: Number(sortOrder) || 0,
      },
    });
    await audit(req, 'tier_feature', feature.id, 'CREATED', null, feature);
    res.status(201).json({ feature });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: `Feature "${featureKey}" already exists on this tier` });
    throw err;
  }
}

async function updateFeature(req, res) {
  const { featureId } = req.params;
  const before = await prisma.tierFeature.findUnique({ where: { id: featureId } });
  if (!before) return res.status(404).json({ message: 'Feature not found' });
  const { featureKey, featureType, featureValue, displayLabel, description, isHighlighted, sortOrder } = req.body;
  const data = {};
  if (featureKey !== undefined)   data.featureKey = String(featureKey).trim();
  if (featureType !== undefined) {
    const type = String(featureType).toUpperCase();
    if (!FEATURE_TYPES.includes(type)) return res.status(400).json({ message: `featureType must be one of ${FEATURE_TYPES.join(', ')}` });
    data.featureType = type;
  }
  if (featureValue !== undefined)  data.featureValue = featureValue == null ? '' : String(featureValue);
  if (displayLabel !== undefined)  data.displayLabel = String(displayLabel).trim();
  if (description !== undefined)    data.description = description ? String(description) : null;
  if (isHighlighted !== undefined)  data.isHighlighted = !!isHighlighted;
  if (sortOrder !== undefined)      data.sortOrder = Number(sortOrder) || 0;
  const feature = await prisma.tierFeature.update({ where: { id: featureId }, data });
  await audit(req, 'tier_feature', featureId, 'UPDATED', before, feature, req.body.note);
  res.json({ feature });
}

async function deleteFeature(req, res) {
  const { featureId } = req.params;
  const before = await prisma.tierFeature.findUnique({ where: { id: featureId } });
  if (!before) return res.status(404).json({ message: 'Feature not found' });
  await prisma.tierFeature.delete({ where: { id: featureId } });
  await audit(req, 'tier_feature', featureId, 'DELETED', before, null);
  res.json({ message: 'Feature removed' });
}

async function reorderFeatures(req, res) {
  const { order } = req.body; // array of feature IDs in desired order
  if (!Array.isArray(order)) return res.status(400).json({ message: 'order must be an array of feature IDs' });
  await prisma.$transaction(order.map((id, idx) => prisma.tierFeature.update({ where: { id }, data: { sortOrder: idx + 1 } })));
  await audit(req, 'tier_feature', 'reorder', 'UPDATED', null, { order });
  res.json({ message: 'Features reordered' });
}

// -----------------------------------------------------------------------------
// Zone + country create/delete (were update-only). Lets the studio add new
// zones/currencies/countries without a seed/migration.
// -----------------------------------------------------------------------------

async function createZone(req, res) {
  const { slug, name, description, multiplier, sortOrder } = req.body;
  if (!slug || !name || multiplier == null) return res.status(400).json({ message: 'slug, name and multiplier are required' });
  const existing = await prisma.pricingZone.findUnique({ where: { slug } });
  if (existing) return res.status(409).json({ message: `Zone "${slug}" already exists` });
  const zone = await prisma.pricingZone.create({
    data: { slug: String(slug).trim(), name, description: description || null, multiplier: String(multiplier), sortOrder: Number(sortOrder) || 0 },
  });
  await audit(req, 'zone', zone.id, 'CREATED', null, zone);
  res.status(201).json({ zone });
}

async function deleteZone(req, res) {
  const { id } = req.params;
  const before = await prisma.pricingZone.findUnique({ where: { id }, include: { _count: { select: { countries: true } } } });
  if (!before) return res.status(404).json({ message: 'Zone not found' });
  if (before._count.countries > 0) {
    return res.status(409).json({ message: `Zone still has ${before._count.countries} countries — reassign them first` });
  }
  await prisma.pricingZone.delete({ where: { id } });
  await audit(req, 'zone', id, 'DELETED', before, null);
  res.json({ message: 'Zone removed' });
}

async function createCountry(req, res) {
  const { countryCode, countryName, region, currencyCode, currencySymbol, zoneId } = req.body;
  if (!countryCode || !countryName || !currencyCode || !zoneId) {
    return res.status(400).json({ message: 'countryCode, countryName, currencyCode and zoneId are required' });
  }
  const code = String(countryCode).toUpperCase().trim();
  const zone = await prisma.pricingZone.findUnique({ where: { id: zoneId } });
  if (!zone) return res.status(400).json({ message: 'Invalid zoneId' });
  const existing = await prisma.countryZoneAssignment.findUnique({ where: { countryCode: code } });
  if (existing) return res.status(409).json({ message: `Country ${code} already exists` });
  const country = await prisma.countryZoneAssignment.create({
    data: { countryCode: code, countryName, region: region || null, currencyCode, currencySymbol: currencySymbol || '', zoneId, isOverride: true, updatedBy: req.user?.id || null },
  });
  await audit(req, 'country', code, 'CREATED', null, country);
  syncGatewaysBackground(`country added: ${code}`);
  res.status(201).json({ country });
}

async function deleteCountry(req, res) {
  const { code } = req.params;
  const before = await prisma.countryZoneAssignment.findUnique({ where: { countryCode: code } });
  if (!before) return res.status(404).json({ message: 'Country not found' });
  await prisma.countryZoneAssignment.delete({ where: { countryCode: code } });
  await audit(req, 'country', code, 'DELETED', before, null);
  res.json({ message: 'Country removed' });
}

// -----------------------------------------------------------------------------
// Publish to gateways — recreate Razorpay/Stripe/Paddle plans at the current
// admin price so the CHARGED price matches what super-admin set. Preview first.
// -----------------------------------------------------------------------------

function requestedGateways(req) {
  const raw = req.body?.gateways || req.query?.gateways || req.body?.gateway || req.query?.gateway;
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

async function publishPreview(req, res) {
  try {
    const result = await previewPublish({ gateways: requestedGateways(req) });
    res.json({ ...result, supportedGateways: SUPPORTED_GATEWAYS });
  } catch (err) {
    res.status(500).json({ message: err?.message || 'Publish preview failed' });
  }
}

async function publishGateways(req, res) {
  try {
    const result = await publishToGateways({ gateways: requestedGateways(req) });
    await audit(req, 'pricing', 'publish', 'SYNCED', null, result.summary, `Published to ${result.gateways.join(',') || 'none'}`);
    res.json({ ...result, supportedGateways: SUPPORTED_GATEWAYS });
  } catch (err) {
    res.status(500).json({ message: err?.message || 'Publish failed' });
  }
}

// -----------------------------------------------------------------------------
// Audit log (read-only)
// -----------------------------------------------------------------------------

async function listAuditLog(req, res) {
  const { entityType, entityId, limit } = req.query;
  const where = {};
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  const rows = await prisma.pricingAuditLog.findMany({
    where, orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 100, 500),
  });
  res.json({ entries: rows });
}

// ─── Buyer-payment policy (integrated vs BYO, per country) ──────────────────
async function listPaymentPolicy(req, res) {
  const { integratedDefaultOn } = require('../lib/buyerPaymentPolicy');
  const countries = await prisma.paymentCountryPolicy.findMany({ orderBy: { countryCode: 'asc' } });
  res.json({ defaultIntegratedOn: integratedDefaultOn(), countries });
}

async function setPaymentPolicy(req, res) {
  const code = String(req.params.countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return res.status(400).json({ message: 'countryCode must be a 2-letter ISO code' });
  const integratedEnabled = !!req.body.integratedEnabled;
  const before = await prisma.paymentCountryPolicy.findUnique({ where: { countryCode: code } });
  const policy = await prisma.paymentCountryPolicy.upsert({
    where: { countryCode: code },
    create: { countryCode: code, integratedEnabled, updatedBy: req.user?.id || null },
    update: { integratedEnabled, updatedBy: req.user?.id || null },
  });
  await audit(req, 'payment_policy', code, before ? 'UPDATED' : 'CREATED', before, policy);
  res.json({ policy });
}

module.exports = {
  listTiers, getTier, getCatalogMatrix, createTier, updateTier, reorderTiers, archiveTier,
  createFeature, updateFeature, deleteFeature, reorderFeatures,
  listZones, updateZone, createZone, deleteZone,
  listCountries, updateCountry, bulkAssignCountries, createCountry, deleteCountry,
  listPrices, upsertPrice, deletePriceOverride,
  publishPreview, publishGateways,
  listPaymentPolicy, setPaymentPolicy,
  listAuditLog,
};

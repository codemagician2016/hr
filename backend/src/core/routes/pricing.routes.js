const express = require('express');
const router = express.Router();
const { requireAuth, requireSuperAdmin } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/pricing.controller');
const { ensurePricingReferenceData } = require('../../core/lib/pricingReferenceSync');

// All pricing-admin endpoints require SUPER_ADMIN.
router.use(requireAuth);
router.use(requireSuperAdmin);
router.use(async (_req, _res, next) => {
  try {
    await ensurePricingReferenceData();
    next();
  } catch (err) {
    console.error('[pricing reference sync] failed:', err.message);
    next(err);
  }
});

// Tiers
router.get('/catalog-matrix',   c.getCatalogMatrix);
router.get('/tiers',            c.listTiers);
router.get('/tiers/:id',        c.getTier);
router.post('/tiers',           c.createTier);
router.put('/tiers/reorder',    c.reorderTiers);
router.put('/tiers/:id',        c.updateTier);
router.delete('/tiers/:id',     c.archiveTier);

// Tier features (structured entitlements / feature editor)
router.post('/tiers/:id/features',        c.createFeature);
router.put('/tiers/:id/features/reorder', c.reorderFeatures);
router.put('/features/:featureId',        c.updateFeature);
router.delete('/features/:featureId',     c.deleteFeature);

// Zones
router.get('/zones',            c.listZones);
router.post('/zones',           c.createZone);
router.put('/zones/:id',        c.updateZone);
router.delete('/zones/:id',     c.deleteZone);

// Countries
router.get('/countries',        c.listCountries);
router.post('/countries',       c.createCountry);
router.put('/countries/bulk',   c.bulkAssignCountries);
router.put('/countries/:code',  c.updateCountry);
router.delete('/countries/:code', c.deleteCountry);

// Prices
router.get('/prices',                          c.listPrices);
router.put('/prices',                          c.upsertPrice);
router.delete('/prices/:tierId/:countryCode',  c.deletePriceOverride);

// Publish to gateways — recreate gateway plans at the current admin price so the
// CHARGED price matches what super-admin set. Preview shows the before/after diff.
router.get('/publish/preview',  c.publishPreview);
router.post('/publish',         c.publishGateways);

// Buyer-payment policy — integrated (Stripe Connect / Razorpay Route) vs BYO,
// per country. Default BYO-only; opt a country into integrated here.
router.get('/payment-policy',                c.listPaymentPolicy);
router.put('/payment-policy/:countryCode',   c.setPaymentPolicy);

// Audit log
router.get('/audit',            c.listAuditLog);

module.exports = router;

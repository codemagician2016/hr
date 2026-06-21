// Public API v1 — routes mounted under /api/v1.
// Auth: every route requires a valid API key + the appropriate scope.
// Scope names: 'appointments' | 'customers' | 'products' | 'orders' | 'services' | 'deliveries' | 'riders'.
// A scope of '*' grants all reads/writes for that action.
'use strict';

const express = require('express');
const { requireApiKey, requireScope } = require('../../core/middleware/apiKey.middleware');
const { requireAttachedBusinessVertical } = require('../../core/middleware/requireVertical');
const { apiKeyLimiter } = require('../../core/middleware/abuse.middleware');
const c = require('../controllers/publicV1.controller');

const router = express.Router();
router.use(requireApiKey);
// Per-key rate limit (after the key resolves so it keys on the key, not IP).
router.use(apiKeyLimiter);

const requireAppointmentApi = requireAttachedBusinessVertical('APPOINTMENT');
const requireShopApi = requireAttachedBusinessVertical('ECOMMERCE');
const requireCustomerApi = requireAttachedBusinessVertical('APPOINTMENT', 'ECOMMERCE');

// Identity probe — no scope required.
router.get('/whoami', c.whoami);

router.get('/appointments',     requireAppointmentApi, requireScope('read', 'appointments'), c.listAppointments);
router.get('/appointments/:id', requireAppointmentApi, requireScope('read', 'appointments'), c.getAppointment);

router.get('/customers',        requireCustomerApi, requireScope('read', 'customers'),    c.listCustomers);
router.get('/customers/:id',    requireCustomerApi, requireScope('read', 'customers'),    c.getCustomer);

router.get('/products',         requireShopApi, requireScope('read', 'products'),     c.listProducts);
router.get('/products/:id',     requireShopApi, requireScope('read', 'products'),     c.getProduct);

router.get('/orders',           requireShopApi, requireScope('read', 'orders'),       c.listOrders);
router.get('/orders/:id',       requireShopApi, requireScope('read', 'orders'),       c.getOrder);

router.get('/deliveries',       requireShopApi, requireScope('read', 'deliveries'),   c.listDeliveries);
router.post('/deliveries',      requireShopApi, requireScope('write', 'deliveries'),  c.createDelivery);
router.post('/deliveries/bulk', requireShopApi, requireScope('write', 'deliveries'),  c.createDeliveriesBulk);
router.get('/deliveries/capabilities', requireShopApi, requireScope('read', 'deliveries'), c.deliveryCapabilities);
router.get('/deliveries/openapi.json', requireShopApi, requireScope('read', 'deliveries'), c.deliveryOpenApi);
router.get('/deliveries/lookup', requireShopApi, requireScope('read', 'deliveries'), c.lookupDelivery);
router.get('/deliveries/:id',   requireShopApi, requireScope('read', 'deliveries'),   c.getDelivery);
router.post('/deliveries/:id/status', requireShopApi, requireScope('write', 'deliveries'), c.updateDeliveryStatus);
router.post('/deliveries/:id/exception', requireShopApi, requireScope('write', 'deliveries'), c.updateDeliveryExceptionHandler);
router.post('/deliveries/:id/cancel', requireShopApi, requireScope('write', 'deliveries'), c.cancelDelivery);

router.get('/riders',           requireShopApi, requireScope('read', 'riders'),       c.listRiders);
router.post('/riders',          requireShopApi, requireScope('write', 'riders'),      c.createRider);
router.get('/riders/:id',       requireShopApi, requireScope('read', 'riders'),       c.getRider);
router.patch('/riders/:id',     requireShopApi, requireScope('write', 'riders'),      c.updateRider);
router.post('/riders/:id/status', requireShopApi, requireScope('write', 'riders'),    c.updateRiderStatus);

router.get('/services',         requireAppointmentApi, requireScope('read', 'services'),     c.listServices);
router.get('/services/:id',     requireAppointmentApi, requireScope('read', 'services'),     c.getService);

module.exports = router;

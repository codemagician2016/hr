// F3 — sanity tests for the three new storefront controllers added to
// close the customer-portal honest gaps (loyalty engine, notification
// preferences, customer-facing returns). Pure module-load + auth gating
// — DB-touching flows live in the integration suite.

const request = require('supertest');
const express = require('express');

const loyalty = require('../src/shop/controllers/storefrontLoyalty.controller');
const prefs = require('../src/shop/controllers/storefrontNotificationPrefs.controller');
const returns = require('../src/shop/controllers/storefrontReturns.controller');
const storefrontRoutes = require('../src/core/routes/storefront.routes');

describe('storefrontLoyalty controller', () => {
  test('exports earn-on-PAID hook + GET handler', () => {
    expect(typeof loyalty.getMyLoyalty).toBe('function');
    expect(typeof loyalty.grantOnPaidOrder).toBe('function');
    expect(typeof loyalty.pointsForOrder).toBe('function');
  });

  test('pointsForOrder = floor(totalMinor / 10000) — 1pt per ₹100', () => {
    expect(loyalty.pointsForOrder(0)).toBe(0);
    expect(loyalty.pointsForOrder(9999)).toBe(0);
    expect(loyalty.pointsForOrder(10000)).toBe(1);
    expect(loyalty.pointsForOrder(199900)).toBe(19);
    expect(loyalty.pointsForOrder(null)).toBe(0);
    expect(loyalty.pointsForOrder(-500)).toBe(0);
  });
});

describe('storefrontNotificationPrefs controller', () => {
  test('exports GET + PUT handlers and merge helpers', () => {
    expect(typeof prefs.getPrefs).toBe('function');
    expect(typeof prefs.updatePrefs).toBe('function');
    expect(typeof prefs.mergePrefs).toBe('function');
    expect(typeof prefs.defaultPrefs).toBe('function');
  });

  test('defaultPrefs covers all 3 categories with all 3 channels enabled', () => {
    const d = prefs.defaultPrefs();
    expect(Object.keys(d).sort()).toEqual(['order_updates', 'promotions', 'restock_alerts']);
    for (const cat of Object.keys(d)) {
      expect(d[cat]).toEqual({ email: true, sms: true, whatsapp: true });
    }
  });

  test('mergePrefs forces locked channels back ON', () => {
    const merged = prefs.mergePrefs({
      order_updates: { email: false, sms: false, whatsapp: false },
      promotions:    { email: false, sms: false, whatsapp: false },
    });
    // order_updates.email is locked-on (transactional)
    expect(merged.order_updates.email).toBe(true);
    expect(merged.order_updates.sms).toBe(false);
    expect(merged.promotions.email).toBe(false);
  });

  test('mergePrefs ignores keys outside the catalog', () => {
    const merged = prefs.mergePrefs({ malicious: { email: true } });
    expect(merged.malicious).toBeUndefined();
  });
});

describe('storefrontReturns controller', () => {
  test('exports the customer-facing submitReturn handler', () => {
    expect(typeof returns.submitReturn).toBe('function');
  });
});

describe('storefront route mounts', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/storefront', storefrontRoutes);

  test('GET /:slug/loyalty rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/storefront/acme/loyalty');
    expect(res.status).toBe(401);
  });

  test('GET /:slug/notification-prefs rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/storefront/acme/notification-prefs');
    expect(res.status).toBe(401);
  });

  test('PUT /:slug/notification-prefs rejects unauthenticated requests', async () => {
    const res = await request(app)
      .put('/api/storefront/acme/notification-prefs')
      .send({ prefs: {} });
    expect(res.status).toBe(401);
  });

  test('POST /:slug/returns rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/storefront/acme/returns')
      .send({ orderId: '00000000-0000-0000-0000-000000000000', reason: 'OTHER' });
    expect(res.status).toBe(401);
  });
});

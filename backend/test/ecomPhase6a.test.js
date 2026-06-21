// Phase 6a sanity tests — Coupons / Notifications / Payments / Reports /
// Tax / Bulk controllers + their route mounts.

const request = require('supertest');
const express = require('express');

const coupons = require('../src/shop/controllers/ecomCoupons.controller');
const notifications = require('../src/shop/controllers/ecomNotifications.controller');
const payments = require('../src/shop/controllers/ecomPayments.controller');
const reports = require('../src/shop/controllers/ecomReports.controller');
const tax = require('../src/shop/controllers/ecomTax.controller');
const bulk = require('../src/shop/controllers/ecomBulk.controller');
const ecomRoutes = require('../src/shop/routes/ecom.routes');

describe('Phase 6a controller exports', () => {
  test('Coupons exposes CRUD + summary', () => {
    for (const name of ['list', 'summary', 'get', 'create', 'update', 'softDelete']) {
      expect(typeof coupons[name]).toBe('function');
    }
    expect(coupons.DISCOUNT_TYPES).toEqual(['FIXED', 'PERCENTAGE']);
  });

  test('Notifications exposes templates + deliveries', () => {
    for (const name of ['listTemplates', 'getTemplate', 'updateTemplate', 'listDeliveries', 'summary']) {
      expect(typeof notifications[name]).toBe('function');
    }
  });

  test('Payments exposes list + summary + get', () => {
    for (const name of ['list', 'summary', 'get']) {
      expect(typeof payments[name]).toBe('function');
    }
  });

  test('Reports exposes 4 aggregation handlers', () => {
    for (const name of ['summary', 'byDay', 'topProducts', 'byStatus']) {
      expect(typeof reports[name]).toBe('function');
    }
  });

  test('Tax exposes config get/put + summary', () => {
    for (const name of ['getConfig', 'updateConfig', 'summary']) {
      expect(typeof tax[name]).toBe('function');
    }
  });

  test('Bulk exposes import + jobs handlers', () => {
    for (const name of ['listJobs', 'summary', 'importProducts', 'importAdjustments']) {
      expect(typeof bulk[name]).toBe('function');
    }
  });
});

describe('Phase 6a routes — auth gating', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ecom', ecomRoutes);
    return app;
  }

  const guarded = [
    ['get', '/api/ecom/coupons'],
    ['post', '/api/ecom/coupons'],
    ['get', '/api/ecom/notifications/templates'],
    ['put', '/api/ecom/notifications/templates/abc'],
    ['get', '/api/ecom/payments'],
    ['get', '/api/ecom/payments/summary'],
    ['get', '/api/ecom/reports/summary'],
    ['get', '/api/ecom/reports/by-day'],
    ['get', '/api/ecom/reports/top-products'],
    ['get', '/api/ecom/tax/config'],
    ['put', '/api/ecom/tax/config'],
    ['post', '/api/ecom/bulk/products'],
    ['post', '/api/ecom/bulk/inventory-adjustments'],
    ['get', '/api/ecom/bulk/jobs'],
  ];

  test.each(guarded)('%s %s rejects unauthenticated', async (method, path) => {
    const res = await request(makeApp())[method](path).send({});
    expect([401, 403]).toContain(res.status);
  });
});

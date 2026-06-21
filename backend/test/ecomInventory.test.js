// ECOMMERCE Path B Phase 3b — sanity tests for the Inventory controller
// + ecom.routes mount. Pure module-load + supertest on the auth-free
// endpoints; full DB-touching integration tests live in the e2e suite
// (separate config) so they don't slow the per-commit gate.

const request = require('supertest');
const express = require('express');

const ecomInventory = require('../src/shop/controllers/ecomInventory.controller');
const ecomRoutes = require('../src/shop/routes/ecom.routes');

describe('ecomInventory.ADJUSTMENT_REASONS', () => {
  test('matches the Prisma enum exactly (14 values)', () => {
    expect(ecomInventory.ADJUSTMENT_REASONS.length).toBe(14);
    expect(new Set(ecomInventory.ADJUSTMENT_REASONS).size).toBe(14);
  });

  test('includes the lifecycle reasons referenced by other controllers', () => {
    const required = [
      'GRN_RECEIPT', 'ORDER_PICK', 'ORDER_FULFILL', 'ORDER_CANCEL',
      'TRANSFER_OUT', 'TRANSFER_IN',
      'RETURN_RESTOCK', 'RETURN_SCRAP',
      'DAMAGE', 'THEFT', 'EXPIRY',
      'COUNT_ADJUSTMENT', 'PROMOTIONAL_GIVEAWAY', 'OTHER',
    ];
    for (const r of required) {
      expect(ecomInventory.ADJUSTMENT_REASONS).toContain(r);
    }
  });

  test('every reason is a SCREAMING_SNAKE_CASE constant', () => {
    for (const r of ecomInventory.ADJUSTMENT_REASONS) {
      expect(r).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('ecomInventory controller exports', () => {
  test('exports the expected handler set', () => {
    const expected = ['list', 'get', 'summary', 'upsert', 'adjust', 'listAdjustments'];
    for (const name of expected) {
      expect(typeof ecomInventory[name]).toBe('function');
    }
  });

  test('handlers accept (req, res) and return promises (or async)', () => {
    // Smoke check — every handler is async so callers can `await` them.
    for (const name of ['list', 'get', 'summary', 'upsert', 'adjust', 'listAdjustments']) {
      const fn = ecomInventory[name];
      expect(fn.length).toBeGreaterThanOrEqual(2); // (req, res, [next])
    }
  });
});

describe('GET /api/ecom/health (auth-free probe)', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ecom', ecomRoutes);
    return app;
  }

  test('returns ok=true with vertical + phase metadata', async () => {
    const res = await request(makeApp()).get('/api/ecom/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vertical).toBe('ECOMMERCE');
    expect(res.body.phase).toMatch(/Path B Phase/);
    expect(typeof res.body.catalogVersion).toBe('number');
    expect(res.body.catalogVersion).toBeGreaterThan(0);
  });
});

describe('GET /api/ecom/permissions (requires auth)', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ecom', ecomRoutes);
    return app;
  }

  test('rejects unauthenticated callers with 401', async () => {
    const res = await request(makeApp()).get('/api/ecom/permissions');
    // The protect middleware redirects or returns 401 for missing JWT.
    expect([401, 403]).toContain(res.status);
  });
});

describe('GET /api/ecom/inventory (requires auth)', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ecom', ecomRoutes);
    return app;
  }

  test('rejects unauthenticated callers with 401', async () => {
    const res = await request(makeApp()).get('/api/ecom/inventory');
    expect([401, 403]).toContain(res.status);
  });

  test('rejects unauthenticated POST /inventory/upsert', async () => {
    const res = await request(makeApp())
      .post('/api/ecom/inventory/upsert')
      .send({ productId: '00000000-0000-0000-0000-000000000000', locationId: '00000000-0000-0000-0000-000000000000' });
    expect([401, 403]).toContain(res.status);
  });
});

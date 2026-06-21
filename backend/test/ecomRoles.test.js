// Phase 5 sanity tests — Roles controller exports + auth gating.

const request = require('supertest');
const express = require('express');
const roles = require('../src/shop/controllers/ecomRoles.controller');
const ecomRoutes = require('../src/shop/routes/ecom.routes');

describe('ecomRoles controller', () => {
  test('exports the expected handler set', () => {
    const expected = ['list', 'get', 'create', 'update', 'setGrants', 'softDelete'];
    for (const name of expected) {
      expect(typeof roles[name]).toBe('function');
    }
  });
});

describe('Phase 5 routes — auth gating', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ecom', ecomRoutes);
    return app;
  }

  const guarded = [
    ['get', '/api/ecom/roles'],
    ['post', '/api/ecom/roles'],
    ['put', '/api/ecom/roles/abc/grants'],
    ['delete', '/api/ecom/roles/abc'],
  ];

  test.each(guarded)('%s %s rejects unauthenticated', async (method, path) => {
    const res = await request(makeApp())[method](path).send({});
    expect([401, 403]).toContain(res.status);
  });
});

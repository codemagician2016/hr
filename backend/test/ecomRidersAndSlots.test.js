// ECOMMERCE Path B Phase 3c — sanity tests for Riders + Slots controllers
// + their route mounts. Pure module-load + supertest on the auth-gated
// surfaces; full DB-touching flows live in the e2e suite.

const request = require('supertest');
const express = require('express');

const riders = require('../src/shop/controllers/ecomRiders.controller');
const slots = require('../src/shop/controllers/ecomSlots.controller');
const ecomRoutes = require('../src/shop/routes/ecom.routes');

describe('ecomRiders.RIDER_STATUSES', () => {
  test('matches the Prisma enum exactly (5 values)', () => {
    expect(riders.RIDER_STATUSES.length).toBe(5);
    expect(new Set(riders.RIDER_STATUSES).size).toBe(5);
  });

  test('covers the full lifecycle', () => {
    const required = ['ACTIVE', 'OFF_SHIFT', 'ON_LEAVE', 'SUSPENDED', 'DEPARTED'];
    for (const s of required) {
      expect(riders.RIDER_STATUSES).toContain(s);
    }
  });

  test('every value is SCREAMING_SNAKE_CASE', () => {
    for (const s of riders.RIDER_STATUSES) {
      expect(s).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('ecomRiders.VEHICLE_TYPES', () => {
  test('contains the 5 supported vehicle modes', () => {
    expect(riders.VEHICLE_TYPES).toEqual(['BIKE', 'EBIKE', 'VAN', 'CYCLE', 'WALKING']);
  });
});

describe('ecomRiders controller exports', () => {
  test('exports the expected handler set', () => {
    const expected = [
      'list',
      'summary',
      'get',
      'create',
      'getRiderMe',
      'getRiderShift',
      'startShift',
      'endShift',
      'listRiderRoutes',
      'createRiderLocationPing',
      'updateRiderStopStatus',
      'update',
      'setStatus',
      'resendInvite',
      'softDelete',
    ];
    for (const name of expected) {
      expect(typeof riders[name]).toBe('function');
    }
  });
});

describe('ecomSlots.SLOT_TYPES', () => {
  test('matches the Prisma enum (5 values)', () => {
    expect(slots.SLOT_TYPES).toEqual(['STANDARD', 'EXPRESS', 'SAME_DAY', 'NEXT_DAY', 'SCHEDULED']);
  });
});

describe('ecomSlots controller exports', () => {
  test('exports the expected handler set', () => {
    const expected = ['list', 'get', 'create', 'update', 'softDelete', 'availability'];
    for (const name of expected) {
      expect(typeof slots[name]).toBe('function');
    }
  });
});

describe('Riders + Slots routes — auth gating', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ecom', ecomRoutes);
    return app;
  }

  test('GET /api/ecom/riders rejects unauthenticated', async () => {
    const res = await request(makeApp()).get('/api/ecom/riders');
    expect([401, 403]).toContain(res.status);
  });

  test('POST /api/ecom/riders rejects unauthenticated', async () => {
    const res = await request(makeApp())
      .post('/api/ecom/riders')
      .send({ fullName: 'Test', phone: '+44 7900 000000', vehicleType: 'BIKE' });
    expect([401, 403]).toContain(res.status);
  });

  test('GET /api/ecom/riders/summary rejects unauthenticated', async () => {
    const res = await request(makeApp()).get('/api/ecom/riders/summary');
    expect([401, 403]).toContain(res.status);
  });

  test('POST /api/ecom/rider/location rejects unauthenticated', async () => {
    const res = await request(makeApp())
      .post('/api/ecom/rider/location')
      .send({
        deliveryRequestId: '00000000-0000-0000-0000-000000000000',
        lat: 28.6139,
        lng: 77.2090,
      });
    expect([401, 403]).toContain(res.status);
  });

  test('POST /api/ecom/rider/shift/start rejects unauthenticated', async () => {
    const res = await request(makeApp())
      .post('/api/ecom/rider/shift/start')
      .send({ cashFloatMinor: 0 });
    expect([401, 403]).toContain(res.status);
  });

  test('GET /api/ecom/slots rejects unauthenticated', async () => {
    const res = await request(makeApp()).get('/api/ecom/slots');
    expect([401, 403]).toContain(res.status);
  });

  test('POST /api/ecom/slots rejects unauthenticated', async () => {
    const res = await request(makeApp())
      .post('/api/ecom/slots')
      .send({
        locationId: '00000000-0000-0000-0000-000000000000',
        startTime: '08:00',
        endTime: '10:00',
        dayOfWeek: 1,
      });
    expect([401, 403]).toContain(res.status);
  });

  test('GET /api/ecom/slots/availability rejects unauthenticated', async () => {
    const res = await request(makeApp())
      .get('/api/ecom/slots/availability?locationId=00000000-0000-0000-0000-000000000000&date=2026-05-01');
    expect([401, 403]).toContain(res.status);
  });
});

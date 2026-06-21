// ECOMMERCE Path B Phase 3d — sanity tests for the 6 new controllers
// (Returns, Reviews, Banners, CMS, Geo, Activity) + their route mounts.
// Pure module-load + supertest auth-gating; e2e DB-touching flows live
// in the integration suite.

const request = require('supertest');
const express = require('express');

const returns = require('../src/shop/controllers/ecomReturns.controller');
const reviews = require('../src/shop/controllers/ecomReviews.controller');
const banners = require('../src/shop/controllers/ecomBanners.controller');
const cmsBlocks = require('../src/shop/controllers/ecomCmsBlocks.controller');
const geo = require('../src/shop/controllers/ecomGeo.controller');
const activity = require('../src/shop/controllers/ecomActivity.controller');
const ecomRoutes = require('../src/shop/routes/ecom.routes');

describe('ecomReturns controller', () => {
  test('exports the lifecycle handler set', () => {
    const expected = ['list', 'summary', 'get', 'create', 'transition', 'setDisposition'];
    for (const name of expected) {
      expect(typeof returns[name]).toBe('function');
    }
  });

  test('exposes 6 statuses + 8 reasons matching the Prisma enums', () => {
    expect(returns.RETURN_STATUSES).toEqual(
      ['REQUESTED', 'APPROVED', 'REJECTED', 'COLLECTED', 'REFUNDED', 'CLOSED'],
    );
    expect(returns.RETURN_REASONS.length).toBe(8);
  });
});

describe('ecomReviews controller', () => {
  test('exports the moderation handler set', () => {
    const expected = ['list', 'summary', 'get', 'moderate', 'reply'];
    for (const name of expected) {
      expect(typeof reviews[name]).toBe('function');
    }
  });

  test('exposes 4 review statuses', () => {
    expect(reviews.REVIEW_STATUSES).toEqual(['PENDING', 'PUBLISHED', 'HIDDEN', 'REJECTED']);
  });
});

describe('ecomBanners controller', () => {
  test('exports the CRUD handler set', () => {
    const expected = ['list', 'get', 'create', 'update', 'softDelete'];
    for (const name of expected) {
      expect(typeof banners[name]).toBe('function');
    }
  });

  test('exposes 6 placements matching the Prisma enum', () => {
    expect(banners.PLACEMENTS).toEqual([
      'HOMEPAGE_HERO', 'HOMEPAGE_STRIP', 'CATEGORY_HERO',
      'CART_UPSELL', 'ACCOUNT_OFFER', 'CHECKOUT_BANNER',
    ]);
  });
});

describe('ecomCmsBlocks controller', () => {
  test('exports the CRUD + workflow handler set', () => {
    const expected = ['list', 'get', 'create', 'update', 'setStatus', 'softDelete'];
    for (const name of expected) {
      expect(typeof cmsBlocks[name]).toBe('function');
    }
  });

  test('exposes 8 block types and 4 statuses', () => {
    expect(cmsBlocks.BLOCK_TYPES.length).toBe(8);
    expect(cmsBlocks.STATUSES).toEqual(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED']);
  });
});

describe('ecomGeo controller', () => {
  test('exports city + zone CRUD handlers', () => {
    const expected = [
      'listCities', 'getCity', 'createCity', 'updateCity', 'deleteCity',
      'listZones', 'createZone', 'updateZone', 'deleteZone',
    ];
    for (const name of expected) {
      expect(typeof geo[name]).toBe('function');
    }
  });
});

describe('ecomActivity controller', () => {
  test('exports list + summary read-only handlers', () => {
    expect(typeof activity.list).toBe('function');
    expect(typeof activity.summary).toBe('function');
  });
});

describe('Phase 3d routes — auth gating', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ecom', ecomRoutes);
    return app;
  }

  const guarded = [
    ['get', '/api/ecom/returns'],
    ['get', '/api/ecom/returns/summary'],
    ['post', '/api/ecom/returns'],
    ['get', '/api/ecom/reviews'],
    ['get', '/api/ecom/reviews/summary'],
    ['get', '/api/ecom/banners'],
    ['post', '/api/ecom/banners'],
    ['get', '/api/ecom/cms-blocks'],
    ['post', '/api/ecom/cms-blocks'],
    ['get', '/api/ecom/cities'],
    ['post', '/api/ecom/cities'],
    ['get', '/api/ecom/zones'],
    ['post', '/api/ecom/zones'],
    ['get', '/api/ecom/activity'],
    ['get', '/api/ecom/activity/summary'],
  ];

  test.each(guarded)('%s %s rejects unauthenticated', async (method, path) => {
    const res = await request(makeApp())[method](path).send({});
    expect([401, 403]).toContain(res.status);
  });
});

// Reproduces two prod incidents (2026-05-12) where a user holding BOTH
// cookies (customer + operator) saw CUSTOMER notifications inside the
// operator/seller inbox — a vertical-isolation leak.
//
//   #1 (baab6f4): leak at app.sitepresso.com/dashboard — fixed by host check.
//   #2 (this fix): leak at sitepresso.com/ecom/admin?tab=notifications —
//                   host check never matched because the API is on a
//                   separate subdomain (api.sitepresso.com). Fixed by also
//                   inspecting Origin/Referer to recognise operator surfaces
//                   from the page URL, not the API host.

const path = require('path');

const MIDDLEWARE_PATH = path.resolve(__dirname, '../src/core/middleware/customerOrUser.middleware.js');
const AUTH_PATH = require.resolve('../src/core/middleware/auth.middleware.js');

function loadMiddleware({ platformDomain = 'sitepresso.com' } = {}) {
  process.env.PLATFORM_DOMAIN = platformDomain;
  jest.resetModules();
  jest.doMock(AUTH_PATH, () => ({
    authenticateCustomer: jest.fn(async () => ({ id: 'customer-id', email: 'shared@example.com' })),
    authenticateOperator: jest.fn(async () => ({ id: 'operator-id', email: 'shared@example.com', businessId: 'ecom-biz' })),
  }));
  // eslint-disable-next-line global-require
  return require(MIDDLEWARE_PATH);
}

function runMiddleware(mw, host, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = { headers: { host, ...extraHeaders }, cookies: {} };
    const res = { status: () => res, json: () => res };
    Promise.resolve(mw.customerOrUser(req, res, () => resolve(req))).catch(reject);
  });
}

afterEach(() => {
  jest.resetModules();
});

describe('customerOrUser middleware — vertical isolation', () => {
  test('operator host (app.sitepresso.com) resolves to operator first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'app.sitepresso.com');
    expect(req.authType).toBe('user');
    expect(req.user.id).toBe('operator-id');
    expect(req.customer).toBeUndefined();
  });

  test('admin host (admin.sitepresso.com) resolves to operator first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'admin.sitepresso.com');
    expect(req.authType).toBe('user');
    expect(req.user.id).toBe('operator-id');
  });

  test('tenant host (water.sitepresso.com) still resolves to customer first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'water.sitepresso.com');
    expect(req.authType).toBe('customer');
    expect(req.customer.id).toBe('customer-id');
    expect(req.user).toBeUndefined();
  });

  test('apex host with no admin referer (marketing) resolves to customer first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'sitepresso.com', {
      referer: 'https://sitepresso.com/pricing',
    });
    expect(req.authType).toBe('customer');
  });

  test('respects PLATFORM_DOMAIN env (staging aapkatech.com)', async () => {
    const mw = loadMiddleware({ platformDomain: 'aapkatech.com' });
    const req = await runMiddleware(mw, 'app.aapkatech.com');
    expect(req.authType).toBe('user');
  });

  test('x-forwarded-host wins over host (nginx-proxied)', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'localhost:5000', { 'x-forwarded-host': 'app.sitepresso.com' });
    expect(req.authType).toBe('user');
  });

  // Incident #2 — the reason for this commit. API at api.sitepresso.com,
  // page at sitepresso.com/ecom/admin. Host is the api subdomain; Referer
  // exposes the operator-surface page path.
  test('path-based seller console (/ecom/admin) via Referer resolves to operator first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'api.sitepresso.com', {
      referer: 'https://sitepresso.com/ecom/admin?tab=notifications',
    });
    expect(req.authType).toBe('user');
    expect(req.user.id).toBe('operator-id');
    expect(req.customer).toBeUndefined();
  });

  test('path-based booking admin (/booking/admin) via Referer resolves to operator first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'api.sitepresso.com', {
      referer: 'https://sitepresso.com/booking/admin',
    });
    expect(req.authType).toBe('user');
  });

  test('path-based staff console (/web/staff) via Referer resolves to operator first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'api.sitepresso.com', {
      referer: 'https://sitepresso.com/web/staff',
    });
    expect(req.authType).toBe('user');
  });

  test('tenant slug admin (/water/admin) via Referer resolves to operator first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'api.sitepresso.com', {
      referer: 'https://sitepresso.com/water/admin',
    });
    expect(req.authType).toBe('user');
  });

  test('customer storefront (/water/book) via Referer stays customer first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'api.sitepresso.com', {
      referer: 'https://sitepresso.com/water/book',
    });
    expect(req.authType).toBe('customer');
  });

  test('Origin from app.<platform> (when Referer absent) resolves to operator first', async () => {
    const mw = loadMiddleware();
    const req = await runMiddleware(mw, 'api.sitepresso.com', {
      origin: 'https://app.sitepresso.com',
    });
    expect(req.authType).toBe('user');
  });
});

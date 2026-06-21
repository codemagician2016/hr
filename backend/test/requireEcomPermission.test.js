// Tests for requireEcomPermission middleware (ECOM Path B Phase 5).
// Mocks the Prisma grant lookup so we can exercise the bypass + grant
// matrix without a live DB.

jest.mock('../src/core/lib/prisma', () => ({
  business: { findUnique: jest.fn() },
  ecomRolePermissionGrant: { findMany: jest.fn() },
}));

const prisma = require('../src/core/lib/prisma');
const { requireEcomPermission } = require('../src/core/middleware/auth.middleware');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function runMw(req, key) {
  const mw = requireEcomPermission(key);
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

function ecomUser(overrides = {}) {
  return { businessId: 'biz-ecom-1', ...overrides };
}

describe('requireEcomPermission', () => {
  beforeEach(() => {
    prisma.business.findUnique.mockReset();
    prisma.business.findUnique.mockResolvedValue({ vertical: 'ECOMMERCE' });
    prisma.ecomRolePermissionGrant.findMany.mockReset();
  });

  test('401 when no user is attached', async () => {
    const { res, nextCalled } = await runMw({}, 'orders.refund');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(prisma.ecomRolePermissionGrant.findMany).not.toHaveBeenCalled();
  });

  test('SUPER_ADMIN bypasses every permission, no DB lookup', async () => {
    const req = { user: { role: 'SUPER_ADMIN' } };
    const { res, nextCalled } = await runMw(req, 'orders.refund');
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(prisma.ecomRolePermissionGrant.findMany).not.toHaveBeenCalled();
  });

  test('BUSINESS_ADMIN with no businessRoleId passes (back-compat owner)', async () => {
    const req = { user: ecomUser({ role: 'BUSINESS_ADMIN', businessRoleId: null }) };
    const { nextCalled } = await runMw(req, 'inventory.adjust');
    expect(nextCalled).toBe(true);
    expect(prisma.ecomRolePermissionGrant.findMany).not.toHaveBeenCalled();
  });

  test('System Owner role bypasses without DB lookup', async () => {
    const req = {
      user: {
        businessId: 'biz-ecom-1',
        role: 'BUSINESS_ADMIN',
        businessRoleId: 'role-1',
        businessRole: { name: 'Owner', isSystem: true },
      },
    };
    const { nextCalled } = await runMw(req, 'finance.tax_edit');
    expect(nextCalled).toBe(true);
    expect(prisma.ecomRolePermissionGrant.findMany).not.toHaveBeenCalled();
  });

  test('STAFF with no businessRoleId is denied (must be assigned a role)', async () => {
    const req = { user: ecomUser({ role: 'STAFF', businessRoleId: null }) };
    const { res, nextCalled } = await runMw(req, 'orders.view');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.missingPermission).toBe('orders.view');
  });

  test('non-ecommerce businesses cannot use ecommerce permissions', async () => {
    prisma.business.findUnique.mockResolvedValueOnce({ vertical: 'APPOINTMENT' });
    const req = { user: ecomUser({ role: 'BUSINESS_ADMIN', businessRoleId: null }) };
    const { res, nextCalled } = await runMw(req, 'orders.view');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(prisma.ecomRolePermissionGrant.findMany).not.toHaveBeenCalled();
  });

  test('non-super users need a business in scope', async () => {
    const req = { user: { role: 'BUSINESS_ADMIN', businessRoleId: null } };
    const { res, nextCalled } = await runMw(req, 'orders.view');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(prisma.business.findUnique).not.toHaveBeenCalled();
  });

  test('STAFF with a custom role that grants the key passes', async () => {
    prisma.ecomRolePermissionGrant.findMany.mockResolvedValue([
      { permission: { key: 'orders.view' } },
      { permission: { key: 'orders.edit' } },
    ]);
    const req = {
      user: {
        businessId: 'biz-ecom-1',
        role: 'STAFF',
        businessRoleId: 'role-mgr',
        businessRole: { name: 'Manager', isSystem: true },
      },
    };
    const { nextCalled } = await runMw(req, 'orders.edit');
    expect(nextCalled).toBe(true);
    expect(prisma.ecomRolePermissionGrant.findMany).toHaveBeenCalledTimes(1);
  });

  test('STAFF with a custom role that does NOT grant the key gets 403', async () => {
    prisma.ecomRolePermissionGrant.findMany.mockResolvedValue([
      { permission: { key: 'orders.view' } },
    ]);
    const req = {
      user: {
        businessId: 'biz-ecom-1',
        role: 'STAFF',
        businessRoleId: 'role-readonly',
        businessRole: { name: 'ReadOnly', isSystem: true },
      },
    };
    const { res, nextCalled } = await runMw(req, 'orders.refund');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.missingPermission).toBe('orders.refund');
  });

  test('grants are cached on req across multiple checks in one request', async () => {
    prisma.ecomRolePermissionGrant.findMany.mockResolvedValue([
      { permission: { key: 'inventory.view' } },
      { permission: { key: 'inventory.adjust' } },
    ]);
    const req = {
      user: {
        businessId: 'biz-ecom-1',
        role: 'STAFF',
        businessRoleId: 'role-inv',
        businessRole: { name: 'Inventory', isSystem: true },
      },
    };
    await runMw(req, 'inventory.view');
    await runMw(req, 'inventory.adjust');
    expect(prisma.ecomRolePermissionGrant.findMany).toHaveBeenCalledTimes(1);
  });

  test('expired grants are filtered at the query level (mock honours where clause)', async () => {
    prisma.ecomRolePermissionGrant.findMany.mockImplementation(({ where }) => {
      // Verify the middleware sends the expiry filter
      expect(where.OR).toBeDefined();
      return Promise.resolve([{ permission: { key: 'orders.view' } }]);
    });
    const req = {
      user: ecomUser({ role: 'STAFF', businessRoleId: 'role-x', businessRole: { name: 'Custom', isSystem: false } }),
    };
    const { nextCalled } = await runMw(req, 'orders.view');
    expect(nextCalled).toBe(true);
  });

  test('5xx when prisma throws — never silently allows', async () => {
    prisma.ecomRolePermissionGrant.findMany.mockRejectedValue(new Error('DB exploded'));
    const req = {
      user: ecomUser({ role: 'STAFF', businessRoleId: 'role-x', businessRole: { name: 'Custom', isSystem: false } }),
    };
    const { res, nextCalled } = await runMw(req, 'orders.view');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(500);
  });
});

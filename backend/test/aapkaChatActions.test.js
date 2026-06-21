jest.mock('../src/core/lib/prisma', () => ({
  business: { findUnique: jest.fn() },
  ecomRolePermissionGrant: { findFirst: jest.fn() },
  coupon: { findUnique: jest.fn(), create: jest.fn() },
  ecomBanner: { count: jest.fn(), create: jest.fn() },
  ecomCmsBlock: { count: jest.fn(), create: jest.fn() },
  businessLocation: { count: jest.fn() },
  ecomDeliveryZone: { count: jest.fn() },
  ecomPickupLocation: { count: jest.fn() },
  ecomRider: { count: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../src/core/lib/ecomActivityLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../src/core/lib/entitlements', () => ({
  billableStaffSeatCount: jest.fn(() => Promise.resolve(2)),
  limitLabel: jest.fn((value) => (value == null ? 'unlimited' : String(value))),
  numericEntitlement: jest.fn(() => Promise.resolve({
    tierSlug: 'starter-commerce',
    limit: 1,
    accessAllowed: true,
  })),
}));

const prisma = require('../src/core/lib/prisma');
const controller = require('../src/core/controllers/aapkaChatActions.controller');
const gateway = require('../src/core/controllers/aapkaChatGateway.controller');
const originalAiDisable = process.env.AAPKACHAT_AI_DISABLE;

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function ownerReq(body = {}, overrides = {}) {
  return {
    body,
    query: {},
    user: {
      id: 'user-1',
      name: 'Owner',
      email: 'owner@example.com',
      role: 'BUSINESS_ADMIN',
      businessId: 'biz-1',
      businessRoleId: null,
      ...overrides,
    },
  };
}

function business(overrides = {}) {
  return {
    id: 'biz-1',
    name: 'Demo Grocery',
    slug: 'demo',
    vertical: 'ECOMMERCE',
    country: 'NZ',
    defaultCurrency: 'NZD',
    paymentMode: 'ONLINE_ONLY',
    pickupEnabled: true,
    deliveryMode: 'ASAP',
    multiStoreMode: 'BRANCH',
    ...overrides,
  };
}

describe('AapkaChat Sitepresso action bridge', () => {
  beforeAll(() => {
    process.env.AAPKACHAT_AI_DISABLE = '1';
  });

  afterAll(() => {
    if (originalAiDisable === undefined) delete process.env.AAPKACHAT_AI_DISABLE;
    else process.env.AAPKACHAT_AI_DISABLE = originalAiDisable;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.business.findUnique.mockResolvedValue(business());
    prisma.ecomRolePermissionGrant.findFirst.mockResolvedValue(null);
    prisma.coupon.findUnique.mockResolvedValue(null);
  });

  test('diagnoses payment setup using the country gateway policy', async () => {
    const req = ownerReq({
      context: 'admin_portal',
      actorRole: 'owner',
      query: 'razorpay not showing why',
    });
    const res = fakeRes();

    await controller.preview(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.preview.actionKey).toBe('diagnose_payment');
    expect(res.body.preview.allowed).toBe(true);
    expect(res.body.preview.previewLines.join(' ')).toContain('New Zealand: Stripe');
    expect(res.body.preview.previewLines.join(' ')).toContain('Stripe Connect');
  });

  test('filters ecommerce-only quick actions for non-ecommerce businesses', async () => {
    prisma.business.findUnique.mockResolvedValueOnce(business({ vertical: 'APPOINTMENT' }));
    const req = ownerReq();
    req.query = { context: 'admin_portal', actorRole: 'owner' };
    const res = fakeRes();

    await controller.catalog(req, res);

    const createCoupon = res.body.catalog.actions.find((item) => item.actionKey === 'create_coupon');
    const supportTicket = res.body.catalog.actions.find((item) => item.actionKey === 'raise_support_ticket');
    expect(createCoupon.allowed).toBe(false);
    expect(createCoupon.blockedReason).toMatch(/ecommerce stores only/i);
    expect(supportTicket.allowed).toBe(true);
  });

  test('saves banner drafts inactive with no uploaded image assumptions', async () => {
    prisma.ecomBanner.create.mockResolvedValue({
      id: 'banner-1',
      headline: '20% off selected groceries',
      placement: 'HOMEPAGE_STRIP',
    });
    const req = ownerReq({
      actionKey: 'create_banner',
      context: 'admin_portal',
      actorRole: 'owner',
      draft: {
        placement: 'HOMEPAGE_HERO',
        headline: '20% off selected groceries',
        ctaLabel: 'Shop now',
      },
    });
    const res = fakeRes();

    await controller.commit(req, res);

    expect(res.statusCode).toBe(201);
    expect(prisma.ecomBanner.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessId: 'biz-1',
        isActive: false,
        desktopImageUrl: null,
        mobileImageUrl: null,
      }),
    }));
    expect(res.body.targetUrl).toBe('/dashboard?tab=banners');
  });

  test('blocks staff preview when the required ecommerce permission is missing', async () => {
    const req = ownerReq({
      context: 'admin_portal',
      actorRole: 'staff',
      actionKey: 'create_banner',
      query: 'create banner for 20 percent off',
    }, {
      role: 'STAFF',
      businessRoleId: 'role-staff',
      businessRole: { name: 'Inventory', isSystem: false },
    });
    const res = fakeRes();

    await controller.preview(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.preview.allowed).toBe(false);
    expect(res.body.preview.message).toMatch(/catalogue\.edit/);
    expect(prisma.ecomRolePermissionGrant.findFirst).toHaveBeenCalled();
  });

  test('bootstraps a Sitepresso install through the AapkaChat adapter', () => {
    const req = ownerReq();
    req.query = {
      workspace: 'sitepresso',
      installation: 'sitepresso-demo-admin',
      tenantSlug: 'demo',
      context: 'admin_portal',
      actorRole: 'owner',
    };
    const res = fakeRes();

    gateway.bootstrap(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.integration.provider).toBe('sitepresso');
    expect(res.body.integration.actionBridge.enabled).toBe(true);
    expect(res.body.integration.actionBridge.previewUrl).toBe('/v1/actions/preview');
    expect(res.body.integration.training.articles.length).toBeGreaterThan(0);
  });

  test('answers Sitepresso knowledge through the AapkaChat adapter', async () => {
    const req = ownerReq({
      context: 'admin_portal',
      actorRole: 'owner',
      query: 'how to setup delivery pincode branch',
    });
    const res = fakeRes();

    await gateway.answerKnowledge(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.resolved).toBe(true);
    expect(res.body.answer).toContain('Store setup');
    expect(res.body.sources).toContain('Location based delivery');
    expect(res.body.ai.used).toBe(false);
  });
});

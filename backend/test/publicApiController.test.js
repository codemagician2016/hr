const mockApiKey = {
  create: jest.fn(),
  findMany: jest.fn(),
  findUnique: jest.fn(),
  update: jest.fn(),
};
const mockWebhookSubscription = {
  create: jest.fn(),
  findMany: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  delete: jest.fn(),
};
const mockWebhookDelivery = {
  create: jest.fn(),
  findMany: jest.fn(),
  findFirst: jest.fn(),
};
const mockBusiness = { findUnique: jest.fn() };

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    apiKey: mockApiKey,
    webhookSubscription: mockWebhookSubscription,
    webhookDelivery: mockWebhookDelivery,
    business: mockBusiness,
  })),
}));

jest.mock('../src/core/lib/entitlements', () => ({
  assertBooleanFeature: jest.fn(),
}));

jest.mock('../src/core/lib/webhookDispatcher', () => ({
  deliverOne: jest.fn(async (delivery) => ({ ...delivery, status: 'SENT', attempts: 1 })),
}));

const { assertBooleanFeature } = require('../src/core/lib/entitlements');
const controller = require('../src/core/controllers/publicApi.controller');

function res() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((code) => { r.statusCode = code; return r; });
  r.json = jest.fn((body) => { r.body = body; return r; });
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  assertBooleanFeature.mockResolvedValue(true);
});

describe('publicApi.controller API key and webhook admin hardening', () => {
  test('createKey rejects unknown scope resources', async () => {
    const req = {
      user: { businessId: 'biz-1' },
      body: {
        name: 'Bad key',
        scopes: { read: ['deliveries', 'billing-secrets'], write: ['riders'] },
      },
    };
    const out = res();

    await controller.createKey(req, out);

    expect(out.statusCode).toBe(400);
    expect(out.body.message).toBe('Invalid');
    expect(mockApiKey.create).not.toHaveBeenCalled();
  });

  test('createKey stores known delivery scopes when entitled', async () => {
    mockApiKey.create.mockResolvedValue({
      id: 'key-1',
      name: 'Delivery key',
      keyLast4: 'abcd',
      scopes: { read: ['deliveries'], write: ['deliveries', 'riders'] },
    });
    const req = {
      user: { businessId: 'biz-1' },
      body: {
        name: 'Delivery key',
        scopes: { read: ['deliveries'], write: ['deliveries', 'riders'] },
      },
    };
    const out = res();

    await controller.createKey(req, out);

    expect(out.statusCode).toBe(201);
    expect(out.body.key).toMatch(/^sp_live_/);
    expect(mockApiKey.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessId: 'biz-1',
        scopes: { read: ['deliveries'], write: ['deliveries', 'riders'] },
      }),
    }));
  });

  test('createSub uses the API access entitlement gate before creating a webhook', async () => {
    const err = new Error('API access & webhooks is not available on this plan');
    err.status = 402;
    err.code = 'FEATURE_NOT_AVAILABLE';
    assertBooleanFeature.mockRejectedValue(err);

    const req = {
      user: { businessId: 'biz-1' },
      body: { url: 'https://merchant.example/webhooks', events: ['delivery.created'] },
    };
    const out = res();

    await controller.createSub(req, out);

    expect(out.statusCode).toBe(402);
    expect(out.body).toMatchObject({ code: 'FEATURE_NOT_AVAILABLE' });
    expect(mockWebhookSubscription.create).not.toHaveBeenCalled();
  });
});

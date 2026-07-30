const mockWebhookSubscription = { findMany: jest.fn(), findUnique: jest.fn() };
const mockWebhookDelivery = { create: jest.fn(), findMany: jest.fn(), update: jest.fn() };

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    webhookSubscription: mockWebhookSubscription,
    webhookDelivery: mockWebhookDelivery,
  })),
  __mockWebhookSubscription: mockWebhookSubscription,
  __mockWebhookDelivery: mockWebhookDelivery,
}));

// The dispatcher wraps its request in the SSRF egress guard (safeFetch), which
// does a real DNS lookup. These tests assert signing/delivery behaviour with a
// fixture host (merchant.example) that intentionally doesn't resolve, so mock
// the guard to delegate straight to the mocked global.fetch. The guard itself
// is covered by ssrfGuard.test.js.
jest.mock('../src/core/lib/ssrfGuard', () => ({
  safeFetch: (url, opts) => global.fetch(url, opts),
  assertPublicUrl: async (u) => new URL(u),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const { signWebhookEnvelope, signWebhookPayload } = require('../src/core/lib/publicApi');
const { deliverOne } = require('../src/core/lib/webhookDispatcher');

describe('webhookDispatcher.deliverOne', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1781085968000);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: jest.fn().mockResolvedValue('accepted'),
    });
    mockWebhookDelivery.update.mockImplementation(async (args) => args);
  });

  afterEach(() => {
    Date.now.mockRestore();
  });

  test('posts signed V1 and V2 webhook headers for receiver verification', async () => {
    const subscription = {
      id: 'sub-1',
      isActive: true,
      url: 'https://merchant.example/webhooks/sitepresso',
      secret: 'whsec_test',
    };
    const delivery = {
      id: 'delivery-1',
      subscriptionId: subscription.id,
      event: 'delivery.delivered',
      payload: { id: 'del-1', status: 'DELIVERED' },
      attempts: 0,
    };
    const body = JSON.stringify({ event: delivery.event, payload: delivery.payload });

    mockWebhookSubscription.findUnique.mockResolvedValue(subscription);

    await deliverOne(delivery);

    expect(global.fetch).toHaveBeenCalledWith(subscription.url, expect.objectContaining({
      method: 'POST',
      body,
    }));
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Sitepresso-Signature']).toBe(`sha256=${signWebhookPayload(subscription.secret, body)}`);
    expect(headers['X-Sitepresso-Signature-V2']).toBe(signWebhookEnvelope(subscription.secret, body, 1781085968).header);
    expect(headers['X-Sitepresso-Timestamp']).toBe('1781085968');
    expect(headers['X-Sitepresso-Delivery-Id']).toBe(delivery.id);
    expect(headers['X-Sitepresso-Webhook-Id']).toBe(subscription.id);
    expect(headers['X-Sitepresso-Event']).toBe(delivery.event);
    expect(mockWebhookDelivery.update).toHaveBeenCalledWith({
      where: { id: delivery.id },
      data: expect.objectContaining({
        status: 'SENT',
        responseStatus: 202,
        responseBody: 'accepted',
        attempts: 1,
      }),
    });
  });
});

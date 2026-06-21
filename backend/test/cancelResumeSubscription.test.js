// POST /api/subscription/cancel + /resume — gateway-aware schedule-cancel-at-
// period-end and un-cancel. Cancel works on all 3 gateways; resume works on
// Paddle + Stripe; Razorpay can't un-cancel (re-subscribe).

const mockPrisma = { subscription: { update: jest.fn() } };
const mockSub = {
  getBusinessSubscription: jest.fn(),
  hydrateSubscription: jest.fn(async (s) => s),
  FREE_TIER_SLUG: 'free',
};
const mockPaddle = { cancelPaddleSubscription: jest.fn(), updatePaddleSubscription: jest.fn() };
const mockStripeUpdate = jest.fn();
const mockStripeGw = { cancelSubscription: jest.fn(), raw: () => ({ subscriptions: { update: mockStripeUpdate } }) };
const mockRazorpayGw = { cancelSubscription: jest.fn() };
const mockGetGateway = jest.fn((n) => (n === 'STRIPE' ? mockStripeGw : mockRazorpayGw));
const mockRouter = { activeGatewayFromSubscription: jest.fn(() => null) };

jest.mock('../src/core/lib/prisma', () => mockPrisma);
jest.mock('../src/core/lib/subscriptionBilling', () => new Proxy(mockSub, { get: (t, p) => (p in t ? t[p] : jest.fn()) }));
jest.mock('../src/core/lib/paddle', () => new Proxy(mockPaddle, { get: (t, p) => (p in t ? t[p] : jest.fn()) }));
jest.mock('../src/core/lib/billing/gateways', () => ({ getGateway: mockGetGateway }));
jest.mock('../src/core/lib/billing/gatewayRouter', () => new Proxy(mockRouter, { get: (t, p) => (p in t ? t[p] : jest.fn()) }));

const { cancelSubscriptionPlan, resumeSubscriptionPlan } = require('../src/core/controllers/subscription.controller');

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const REQ = { user: { businessId: 'biz1' } };
const PERIOD_END = new Date('2026-07-10T00:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.subscription.update.mockImplementation(async ({ data }) => ({ ...data, tier: { slug: 'professional', name: 'Pro' } }));
});

describe('cancelSubscriptionPlan', () => {
  test('Paddle: schedules cancel at next billing period + sets CANCEL_SCHEDULED locally', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'PADDLE', paddleSubscriptionId: 'sub_p', status: 'ACTIVE', currentPeriodEnd: PERIOD_END });
    const r = res();
    await cancelSubscriptionPlan(REQ, r);
    expect(mockPaddle.cancelPaddleSubscription).toHaveBeenCalledWith('sub_p', { effective_from: 'next_billing_period' });
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CANCEL_SCHEDULED', pendingTierSlug: 'free', pendingChangeEffectiveAt: PERIOD_END }),
    }));
    expect(r.body).toMatchObject({ scheduled: true });
  });

  test('Stripe: cancels at period end (immediately:false)', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'STRIPE', stripeSubscriptionId: 'sub_s', status: 'ACTIVE', currentPeriodEnd: PERIOD_END });
    const r = res();
    await cancelSubscriptionPlan(REQ, r);
    expect(mockStripeGw.cancelSubscription).toHaveBeenCalledWith('sub_s', { immediately: false });
    expect(r.body.scheduled).toBe(true);
  });

  test('Razorpay: cancels at cycle end', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'RAZORPAY', razorpaySubscriptionId: 'sub_r', status: 'ACTIVE', currentPeriodEnd: PERIOD_END });
    const r = res();
    await cancelSubscriptionPlan(REQ, r);
    expect(mockRazorpayGw.cancelSubscription).toHaveBeenCalledWith('sub_r', { immediately: false });
    expect(r.body.scheduled).toBe(true);
  });

  test('already CANCEL_SCHEDULED → no-op, alreadyScheduled', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'PADDLE', paddleSubscriptionId: 'sub_p', status: 'CANCEL_SCHEDULED' });
    const r = res();
    await cancelSubscriptionPlan(REQ, r);
    expect(mockPaddle.cancelPaddleSubscription).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ alreadyScheduled: true });
  });

  test('no paid subscription → 409', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: '', status: 'ACTIVE', tier: { slug: 'free' } });
    const r = res();
    await cancelSubscriptionPlan(REQ, r);
    expect(r.statusCode).toBe(409);
    expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
  });

  test('gateway error → 502, no local state change', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'STRIPE', stripeSubscriptionId: 'sub_s', status: 'ACTIVE' });
    mockStripeGw.cancelSubscription.mockRejectedValueOnce(new Error('stripe down'));
    const r = res();
    await cancelSubscriptionPlan(REQ, r);
    expect(r.statusCode).toBe(502);
    expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
  });
});

describe('resumeSubscriptionPlan', () => {
  test('Paddle: clears scheduled_change + sets ACTIVE', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'PADDLE', paddleSubscriptionId: 'sub_p', status: 'CANCEL_SCHEDULED', pendingTierSlug: 'free' });
    const r = res();
    await resumeSubscriptionPlan(REQ, r);
    expect(mockPaddle.updatePaddleSubscription).toHaveBeenCalledWith('sub_p', { scheduled_change: null });
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'ACTIVE', pendingTierSlug: null }),
    }));
    expect(r.body).toMatchObject({ resumed: true });
  });

  test('Stripe: cancel_at_period_end=false', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'STRIPE', stripeSubscriptionId: 'sub_s', status: 'CANCEL_SCHEDULED', pendingTierSlug: 'free' });
    const r = res();
    await resumeSubscriptionPlan(REQ, r);
    expect(mockStripeUpdate).toHaveBeenCalledWith('sub_s', { cancel_at_period_end: false });
    expect(r.body.resumed).toBe(true);
  });

  test('Razorpay: cannot resume → 409 with re-subscribe guidance', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'RAZORPAY', razorpaySubscriptionId: 'sub_r', status: 'CANCEL_SCHEDULED', pendingTierSlug: 'free' });
    const r = res();
    await resumeSubscriptionPlan(REQ, r);
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ resumed: false, code: 'RAZORPAY_RESUME_UNSUPPORTED' });
    expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
  });

  test('not scheduled → resumed:true alreadyActive (no gateway call)', async () => {
    mockSub.getBusinessSubscription.mockResolvedValue({ gateway: 'PADDLE', paddleSubscriptionId: 'sub_p', status: 'ACTIVE' });
    const r = res();
    await resumeSubscriptionPlan(REQ, r);
    expect(mockPaddle.updatePaddleSubscription).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ resumed: true, alreadyActive: true });
  });
});

// Multi-gateway subscription cancellation on account deletion.
// A deleted tenant must stop being billed on WHATEVER gateway it sits on
// (Paddle / Stripe / Razorpay), not just Paddle — and the cancel must be
// idempotent + non-blocking so a gateway error never blocks the deletion.

const mockPrisma = { subscription: { findUnique: jest.fn() } };
const mockPaddle = { cancelPaddleSubscription: jest.fn() };
const mockStripeGw = { cancelSubscription: jest.fn() };
const mockRazorpayGw = { cancelSubscription: jest.fn() };
const mockGetGateway = jest.fn((name) => {
  if (name === 'STRIPE') return mockStripeGw;
  if (name === 'RAZORPAY') return mockRazorpayGw;
  throw new Error(`Unknown gateway: ${name}`);
});

jest.mock('../src/core/lib/prisma', () => mockPrisma);
jest.mock('../src/core/lib/paddle', () => mockPaddle);
jest.mock('../src/core/lib/billing/gateways', () => ({ getGateway: mockGetGateway }));

const { cancelBusinessSubscription } = require('../src/core/lib/accountDeletion');

beforeEach(() => {
  jest.clearAllMocks();
  mockPaddle.cancelPaddleSubscription.mockResolvedValue({ ok: true });
  mockStripeGw.cancelSubscription.mockResolvedValue({ ok: true });
  mockRazorpayGw.cancelSubscription.mockResolvedValue({ ok: true });
});

describe('cancelBusinessSubscription (multi-gateway)', () => {
  test('cancels Paddle when only a Paddle sub exists', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ paddleSubscriptionId: 'sub_pad', stripeSubscriptionId: null, razorpaySubscriptionId: null });
    const r = await cancelBusinessSubscription('biz1');
    expect(r.canceled).toBe(true);
    expect(mockPaddle.cancelPaddleSubscription).toHaveBeenCalledWith('sub_pad', { effective_from: 'immediately' });
    expect(mockStripeGw.cancelSubscription).not.toHaveBeenCalled();
    expect(mockRazorpayGw.cancelSubscription).not.toHaveBeenCalled();
  });

  test('cancels Stripe via the gateway registry', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ paddleSubscriptionId: null, stripeSubscriptionId: 'sub_str', razorpaySubscriptionId: null });
    const r = await cancelBusinessSubscription('biz1');
    expect(r.canceled).toBe(true);
    expect(mockGetGateway).toHaveBeenCalledWith('STRIPE');
    expect(mockStripeGw.cancelSubscription).toHaveBeenCalledWith('sub_str', { immediately: true });
    expect(mockPaddle.cancelPaddleSubscription).not.toHaveBeenCalled();
  });

  test('cancels Razorpay via the gateway registry', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ paddleSubscriptionId: null, stripeSubscriptionId: null, razorpaySubscriptionId: 'sub_rzp' });
    const r = await cancelBusinessSubscription('biz1');
    expect(r.canceled).toBe(true);
    expect(mockRazorpayGw.cancelSubscription).toHaveBeenCalledWith('sub_rzp', { immediately: true });
  });

  test('cancels every gateway when more than one ref is present', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ paddleSubscriptionId: 'sub_pad', stripeSubscriptionId: 'sub_str', razorpaySubscriptionId: 'sub_rzp' });
    const r = await cancelBusinessSubscription('biz1');
    expect(r.canceled).toBe(true);
    expect(r.results).toHaveLength(3);
    expect(mockPaddle.cancelPaddleSubscription).toHaveBeenCalled();
    expect(mockStripeGw.cancelSubscription).toHaveBeenCalled();
    expect(mockRazorpayGw.cancelSubscription).toHaveBeenCalled();
  });

  test('honours immediately:false (cancel at period end)', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ paddleSubscriptionId: 'sub_pad', stripeSubscriptionId: 'sub_str', razorpaySubscriptionId: null });
    await cancelBusinessSubscription('biz1', { immediately: false });
    expect(mockPaddle.cancelPaddleSubscription).toHaveBeenCalledWith('sub_pad', { effective_from: 'next_billing_period' });
    expect(mockStripeGw.cancelSubscription).toHaveBeenCalledWith('sub_str', { immediately: false });
  });

  test('returns no_subscription when there is no subscription row', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue(null);
    const r = await cancelBusinessSubscription('biz1');
    expect(r).toEqual({ canceled: false, reason: 'no_subscription' });
    expect(mockPaddle.cancelPaddleSubscription).not.toHaveBeenCalled();
  });

  test('no-ops cleanly when a sub row has no gateway refs', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ paddleSubscriptionId: null, stripeSubscriptionId: null, razorpaySubscriptionId: null });
    const r = await cancelBusinessSubscription('biz1');
    expect(r.canceled).toBe(false);
    expect(r.results).toEqual([]);
  });

  test('is non-blocking: a gateway error is swallowed and reported, never thrown', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({ paddleSubscriptionId: 'sub_pad', stripeSubscriptionId: 'sub_str', razorpaySubscriptionId: null });
    mockStripeGw.cancelSubscription.mockRejectedValue(new Error('stripe 500'));
    const r = await cancelBusinessSubscription('biz1');
    // Paddle still cancelled; Stripe reported as failed but the call resolved.
    expect(r.canceled).toBe(true);
    const stripeResult = r.results.find((x) => x.gateway === 'STRIPE');
    expect(stripeResult).toMatchObject({ gateway: 'STRIPE', canceled: false });
    expect(stripeResult.error).toMatch(/stripe 500/);
  });

  test('does not throw if the whole lookup blows up', async () => {
    mockPrisma.subscription.findUnique.mockRejectedValue(new Error('db down'));
    const r = await cancelBusinessSubscription('biz1');
    expect(r.canceled).toBe(false);
    expect(r.error).toMatch(/db down/);
  });
});

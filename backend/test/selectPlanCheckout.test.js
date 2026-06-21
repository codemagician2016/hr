// Plan checkout handlers — the new-subscription path for Razorpay (IN) and
// Stripe (NZ). Verifies gateway-owned-country price lookup (B24), the embedded-
// checkout return fields (B2: razorpaySubscriptionId + razorpayKeyId), and the
// Stripe idempotency key (B9).

const mockPrisma = {
  tierPrice: { findFirst: jest.fn() },
  subscription: { update: jest.fn() },
};
const mockGw = {};
jest.mock('../src/core/lib/prisma', () => mockPrisma);
jest.mock('../src/core/lib/billing/gateways', () => ({ getGateway: (n) => mockGw[n] }));
jest.mock('../src/core/lib/gatewayCatalogService', () => ({
  ensurePublishedPriceId: jest.fn(),
  GATEWAY_TARGETS: { RAZORPAY: { country: 'IN' }, STRIPE: { country: 'NZ' }, PADDLE: { country: null } },
}));

const { handleRazorpayCheckout, handleStripeCheckout } = require('../src/core/controllers/subscription.controller');

function resMock() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const TIER = { id: 't1', name: 'Professional', slug: 'professional' };
const business = { id: 'biz1', slug: 'acme', name: 'Acme', billingCountry: null, country: 'GB', email: 'a@b.com' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_KEY_ID = 'rzp_test_KEY';
  // returned sub has pendingTierSlug null so the real hydrateSubscription returns early.
  mockPrisma.subscription.update.mockResolvedValue({ businessId: 'biz1', tier: TIER, pendingTierSlug: null, status: 'TRIALING' });
});

describe('handleRazorpayCheckout (new subscription)', () => {
  test('looks up the IN plan (B24), creates the sub, returns checkoutUrl + razorpaySubscriptionId + razorpayKeyId (B2)', async () => {
    mockPrisma.tierPrice.findFirst.mockResolvedValue({ razorpayPlanIdMonthly: 'plan_in_m', razorpayPlanIdAnnual: 'plan_in_a' });
    mockGw.RAZORPAY = {
      isConfigured: () => true,
      createSubscriptionCheckout: jest.fn(async () => ({ url: 'https://rzp.io/sub_xyz', reference: 'sub_xyz' })),
    };
    const res = resMock();
    await handleRazorpayCheckout({ req: { user: { id: 'u1', businessId: 'biz1', email: 'a@b.com' } }, res, business, tier: TIER, selectedBillingCycle: 'MONTHLY', subscription: null });

    // B24: price looked up by the gateway-owned country IN, not business.country GB
    expect(mockPrisma.tierPrice.findFirst).toHaveBeenCalledWith({ where: { tierId: 't1', countryCode: 'IN' } });
    expect(mockGw.RAZORPAY.createSubscriptionCheckout).toHaveBeenCalledWith(expect.objectContaining({ planRef: 'plan_in_m' }));
    expect(res.body).toMatchObject({
      action: 'checkout', gateway: 'RAZORPAY', checkoutUrl: 'https://rzp.io/sub_xyz',
      razorpaySubscriptionId: 'sub_xyz', razorpayKeyId: 'rzp_test_KEY',
    });
  });

  test('503 when Razorpay is not configured', async () => {
    mockGw.RAZORPAY = { isConfigured: () => false };
    const res = resMock();
    await handleRazorpayCheckout({ req: { user: { id: 'u1', businessId: 'biz1' } }, res, business, tier: TIER, selectedBillingCycle: 'MONTHLY', subscription: null });
    expect(res.statusCode).toBe(503);
  });
});

describe('handleStripeCheckout (new subscription)', () => {
  test('looks up the NZ price (B24) and passes a deterministic idempotency key (B9)', async () => {
    mockPrisma.tierPrice.findFirst.mockResolvedValue({ stripePriceIdMonthly: 'price_nz_m', stripePriceIdAnnual: 'price_nz_a' });
    mockGw.STRIPE = {
      isConfigured: () => true,
      createSubscriptionCheckout: jest.fn(async () => ({ url: 'https://checkout.stripe/sess' })),
    };
    const res = resMock();
    await handleStripeCheckout({ req: { user: { id: 'u1', businessId: 'biz1', email: 'a@b.com' }, headers: { origin: 'https://app.aapkatech.com' } }, res, business, tier: TIER, selectedBillingCycle: 'YEARLY', subscription: null });

    expect(mockPrisma.tierPrice.findFirst).toHaveBeenCalledWith({ where: { tierId: 't1', countryCode: 'NZ' } });
    expect(mockGw.STRIPE.createSubscriptionCheckout).toHaveBeenCalledWith(expect.objectContaining({
      priceRef: 'price_nz_a',
      idempotencyKey: 'stripe_checkout:biz1:professional:YEARLY',
    }));
    expect(res.body).toMatchObject({ action: 'checkout', gateway: 'STRIPE' });
  });
});

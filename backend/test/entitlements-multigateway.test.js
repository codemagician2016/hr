// Regression for SUB-001 (CRITICAL): paid access must be granted for ALL three
// billing gateways. The old gate keyed on paddleSubscriptionId only, so every
// paid Stripe (NZ) and Razorpay (IN) subscriber silently got NO features —
// defeating the whole IN→Razorpay / NZ→Stripe routing model.

jest.mock('../src/core/lib/launchPeriod', () => ({
  launchFreePlanGrantsAllowed: () => false, // deterministic: no launch-period override
}));

const { subscriptionGrantsAccess } = require('../src/core/lib/entitlements');

const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);
const paidTier = { slug: 'professional' };

describe('subscriptionGrantsAccess is gateway-agnostic', () => {
  test('free tier is always granted regardless of gateway', () => {
    expect(subscriptionGrantsAccess({ tier: { slug: 'free' } })).toBe(true);
  });

  test('Paddle ACTIVE + future period grants (unchanged behaviour)', () => {
    expect(subscriptionGrantsAccess({
      tier: paidTier, status: 'ACTIVE', paddleSubscriptionId: 'sub_p', currentPeriodEnd: FUTURE,
    })).toBe(true);
  });

  test('Stripe ACTIVE + future period grants (regression: NZ subscribers)', () => {
    expect(subscriptionGrantsAccess({
      tier: paidTier, status: 'ACTIVE', stripeSubscriptionId: 'sub_s', currentPeriodEnd: FUTURE,
    })).toBe(true);
  });

  test('Razorpay ACTIVE + future period grants (regression: IN subscribers)', () => {
    expect(subscriptionGrantsAccess({
      tier: paidTier, status: 'ACTIVE', razorpaySubscriptionId: 'sub_r', currentPeriodEnd: FUTURE,
    })).toBe(true);
  });

  test('Razorpay TRIALING + future trial grants', () => {
    expect(subscriptionGrantsAccess({
      tier: paidTier, status: 'TRIALING', razorpaySubscriptionId: 'sub_r', trialEndsAt: FUTURE,
    })).toBe(true);
  });

  test('Stripe CANCELLED is denied', () => {
    expect(subscriptionGrantsAccess({
      tier: paidTier, status: 'CANCELLED', stripeSubscriptionId: 'sub_s', currentPeriodEnd: FUTURE,
    })).toBe(false);
  });

  test('Stripe ACTIVE but expired period is denied', () => {
    expect(subscriptionGrantsAccess({
      tier: paidTier, status: 'ACTIVE', stripeSubscriptionId: 'sub_s', currentPeriodEnd: PAST,
    })).toBe(false);
  });

  test('paid tier with NO gateway subscription id is denied', () => {
    expect(subscriptionGrantsAccess({
      tier: paidTier, status: 'ACTIVE', currentPeriodEnd: FUTURE,
    })).toBe(false);
  });

  test('PAST_DUE within the grace window still grants (any gateway)', () => {
    expect(subscriptionGrantsAccess({
      tier: paidTier, status: 'PAST_DUE', razorpaySubscriptionId: 'sub_r', accessGraceUntil: FUTURE,
    })).toBe(true);
  });
});

// billingAccess — the "renew gate". B1 regression guard: a paid subscription on
// ANY gateway (Paddle / Stripe / Razorpay) must read as 'active'. Checking only
// paddleSubscriptionId locked out every paying NZ (Stripe) + IN (Razorpay) tenant
// (storefront renew notice + dashboard locked to Billing).

jest.mock('../src/core/lib/launchPeriod', () => ({ launchFreePlanGrantsAllowed: () => false }));

const { billingAccessState, needsRenewal } = require('../src/core/lib/billingAccess');

const PAID = { slug: 'professional' }; // isPaidTier → true (real featuresCatalog)
const NOW = new Date('2026-06-10T00:00:00Z');
const FUTURE = new Date('2026-07-10T00:00:00Z');
const PAST = new Date('2026-05-10T00:00:00Z');

function biz(sub) { return { subscription: sub ? { tier: PAID, ...sub } : null }; }

describe('billingAccessState — paid subscription on ANY gateway is active (B1)', () => {
  test('Stripe (NZ) ACTIVE in-period, NO paddle id → active', () => {
    const b = biz({ status: 'ACTIVE', stripeSubscriptionId: 'sub_str', currentPeriodEnd: FUTURE });
    expect(billingAccessState(b, NOW)).toEqual({ state: 'active' });
    expect(needsRenewal(b, NOW)).toBe(false);
  });

  test('Razorpay (IN) ACTIVE in-period, NO paddle id → active', () => {
    const b = biz({ status: 'ACTIVE', razorpaySubscriptionId: 'sub_rzp', currentPeriodEnd: FUTURE });
    expect(billingAccessState(b, NOW)).toEqual({ state: 'active' });
  });

  test('Stripe TRIALING with a future trialEndsAt → active', () => {
    const b = biz({ status: 'TRIALING', stripeSubscriptionId: 'sub_str', trialEndsAt: FUTURE });
    expect(billingAccessState(b, NOW)).toEqual({ state: 'active' });
  });

  test('Paddle ACTIVE in-period → active (regression guard)', () => {
    const b = biz({ status: 'ACTIVE', paddleSubscriptionId: 'sub_pad', currentPeriodEnd: FUTURE });
    expect(billingAccessState(b, NOW)).toEqual({ state: 'active' });
  });
});

describe('billingAccessState — genuinely lapsed / free', () => {
  test('paid tier, NO gateway id, past any grace → expired', () => {
    const b = biz({ status: 'ACTIVE', currentPeriodEnd: PAST });
    expect(billingAccessState(b, NOW)).toEqual({ state: 'expired' });
    expect(needsRenewal(b, NOW)).toBe(true);
  });

  test('PAST_DUE with a future grace window → grace', () => {
    const b = biz({ status: 'PAST_DUE', stripeSubscriptionId: 'sub_str', currentPeriodEnd: PAST, accessGraceUntil: FUTURE });
    expect(billingAccessState(b, NOW)).toMatchObject({ state: 'grace' });
  });

  test('free-tier (or no subscription) is never gated', () => {
    expect(billingAccessState(biz({ tier: { slug: 'free' }, status: 'ACTIVE' }), NOW)).toEqual({ state: 'active' });
    expect(billingAccessState(biz({ tier: { slug: 'ecom-free' }, status: 'ACTIVE' }), NOW)).toEqual({ state: 'active' });
    expect(billingAccessState({ subscription: null }, NOW)).toEqual({ state: 'active' });
  });

  test('paid Stripe sub but EXPIRED period and no grace → expired', () => {
    const b = biz({ status: 'ACTIVE', stripeSubscriptionId: 'sub_str', currentPeriodEnd: PAST });
    expect(billingAccessState(b, NOW)).toEqual({ state: 'expired' });
  });
});

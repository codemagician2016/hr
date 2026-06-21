// Regression for STRIPE-01 (HIGH): Stripe API 2025-03-31.basil+ (and stripe-node
// v22's pinned version) moved current_period_end off the top-level Subscription
// onto each subscription ITEM, and moved Invoice.subscription/price under
// parent.subscription_details / lines[].pricing. normalizeEvent must read the new
// shape (falling back to the legacy one) or renewal dates + business resolution
// silently break on real webhooks.

const { StripeGateway } = require('../src/core/lib/billing/gateways/stripeGateway');

const gw = new StripeGateway();
const PERIOD_END = 1893456000; // 2030-01-01Z

describe('StripeGateway.normalizeEvent — v22 / 2025-03-31.basil shapes', () => {
  test('reads current_period_end from the subscription ITEM (new shape)', () => {
    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', customer: 'cus_1', status: 'active',
          // No top-level current_period_end — removed in 2025-03-31.basil+.
          items: { data: [{ current_period_end: PERIOD_END, price: { id: 'price_1', currency: 'nzd', unit_amount: 2900 } }] },
          metadata: { businessId: 'biz-1' },
        },
      },
    };
    const n = gw.normalizeEvent(event);
    expect(n.kind).toBe('subscription_change');
    expect(n.internalStatus).toBe('ACTIVE');
    expect(n.priceRef).toBe('price_1');
    expect(n.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
  });

  test('falls back to legacy top-level current_period_end', () => {
    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', current_period_end: PERIOD_END,
          items: { data: [{ price: { id: 'price_1', currency: 'nzd', unit_amount: 2900 } }] },
        },
      },
    };
    expect(gw.normalizeEvent(event).currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
  });

  test('invoice.payment_failed resolves subscription/price/metadata from parent.subscription_details', () => {
    const event = {
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_1', customer: 'cus_1', amount_due: 2900, currency: 'nzd',
          parent: { subscription_details: { subscription: 'sub_1', metadata: { businessId: 'biz-1' } } },
          lines: { data: [{ pricing: { price_details: { price: 'price_1' } } }] },
        },
      },
    };
    const n = gw.normalizeEvent(event);
    expect(n.kind).toBe('payment_failed');
    expect(n.gatewaySubscriptionId).toBe('sub_1');
    expect(n.priceRef).toBe('price_1');
    expect(n.metadata.businessId).toBe('biz-1');
  });
});

// billingPlanChangePolicy — plan-change timing/proration + the entitlement
// preservation that mitigates B6/B7. A period-end DOWNGRADE keeps the higher
// tier's entitlement until the effective date even though the gateway item price
// was swapped immediately — so the user never loses paid features early.

const {
  classifyPlanChange, changeTiming, pendingEntitlementPatch,
  stripeProrationBehaviorFor, razorpayScheduleChangeAtFor, targetTrialDays,
} = require('../src/core/lib/billingPlanChangePolicy');

const NOW = new Date('2026-06-10T00:00:00Z');
const FUTURE = new Date('2026-07-01T00:00:00Z');
const PAST = new Date('2026-06-01T00:00:00Z');

describe('classifyPlanChange / changeTiming', () => {
  const pro = { sortOrder: 3 };
  const basic = { sortOrder: 1 };
  test('upgrade is immediate, downgrade is period_end', () => {
    expect(changeTiming(classifyPlanChange({ currentTier: basic, targetTier: pro, currentBillingCycle: 'MONTHLY', targetBillingCycle: 'MONTHLY' }))).toBe('immediate');
    expect(changeTiming(classifyPlanChange({ currentTier: pro, targetTier: basic, currentBillingCycle: 'MONTHLY', targetBillingCycle: 'MONTHLY' }))).toBe('period_end');
  });
});

describe('pendingEntitlementPatch — entitlement preservation (B6/B7 mitigation)', () => {
  const existing = { tierId: 'pro-id', billingCycle: 'MONTHLY', pendingTierSlug: 'basic', pendingChangeEffectiveAt: FUTURE };

  test('a FUTURE pending downgrade keeps the HIGHER tier even when the event reflects the lower price', () => {
    const matched = { tier: { id: 'basic-id', slug: 'basic' }, billingCycle: 'MONTHLY' };
    const r = pendingEntitlementPatch({ existing, matched, proposedTierId: 'basic-id', proposedBillingCycle: 'MONTHLY', now: NOW });
    expect(r.tierId).toBe('pro-id');               // NOT downgraded early
    expect(r.pendingTierSlug).toBe('basic');        // pending preserved
    expect(r.pendingChangeEffectiveAt).toBe(FUTURE);
  });

  test('a DUE pending downgrade whose target matches the event applies the lower tier', () => {
    const due = { ...existing, pendingChangeEffectiveAt: PAST };
    const matched = { tier: { id: 'basic-id', slug: 'basic' }, billingCycle: 'MONTHLY' };
    const r = pendingEntitlementPatch({ existing: due, matched, proposedTierId: 'basic-id', proposedBillingCycle: 'MONTHLY', now: NOW });
    expect(r.tierId).toBe('basic-id');             // applied
    expect(r.pendingTierSlug).toBeNull();
  });

  test('no pending change → applies the proposed tier directly', () => {
    const clean = { tierId: 'pro-id', billingCycle: 'MONTHLY', pendingTierSlug: null };
    const matched = { tier: { id: 'pro-id', slug: 'professional' }, billingCycle: 'MONTHLY' };
    const r = pendingEntitlementPatch({ existing: clean, matched, proposedTierId: 'pro-id', proposedBillingCycle: 'MONTHLY', now: NOW });
    expect(r.tierId).toBe('pro-id');
    expect(r.pendingTierSlug).toBeNull();
  });
});

describe('trial-aware scheduling (B14)', () => {
  test('razorpayScheduleChangeAtFor: trialing → cycle_end (no mid-trial charge); active upgrade → now', () => {
    expect(razorpayScheduleChangeAtFor({ direction: 'upgrade', subscription: { trialEndsAt: FUTURE, status: 'TRIALING' } })).toBe('cycle_end');
    expect(razorpayScheduleChangeAtFor({ direction: 'upgrade', subscription: { status: 'ACTIVE' } })).toBe('now');
    expect(razorpayScheduleChangeAtFor({ direction: 'downgrade', subscription: { status: 'ACTIVE' } })).toBe('cycle_end');
  });

  test('stripeProrationBehaviorFor: trialing → none; upgrade → always_invoice; downgrade → none', () => {
    expect(stripeProrationBehaviorFor({ direction: 'upgrade', subscription: { trialEndsAt: FUTURE, status: 'TRIALING' } })).toBe('none');
    expect(stripeProrationBehaviorFor({ direction: 'upgrade', subscription: { status: 'ACTIVE' } })).toBe('always_invoice');
    expect(stripeProrationBehaviorFor({ direction: 'downgrade', subscription: { status: 'ACTIVE' } })).toBe('none');
  });
});

describe('targetTrialDays', () => {
  test('returns the tier trialDays clamped 1..365, else null', () => {
    expect(targetTrialDays({ trialDays: 30 })).toBe(30);
    expect(targetTrialDays({ trialDays: 0 })).toBeNull();
    expect(targetTrialDays({ trialDays: null })).toBeNull();
    expect(targetTrialDays({ trialDays: 999 })).toBe(365);
  });
});

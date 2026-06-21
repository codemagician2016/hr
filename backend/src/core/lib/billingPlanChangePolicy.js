function normalizeBillingCycle(value) {
  return value === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
}

function tierSort(tier) {
  const value = Number(tier?.sortOrder);
  return Number.isFinite(value) ? value : 0;
}

function classifyPlanChange({
  currentTier,
  targetTier,
  currentBillingCycle = 'MONTHLY',
  targetBillingCycle = 'MONTHLY',
} = {}) {
  if (!currentTier) return 'new';
  const currentSort = tierSort(currentTier);
  const targetSort = tierSort(targetTier);
  if (targetSort > currentSort) return 'upgrade';
  if (targetSort < currentSort) return 'downgrade';
  if (normalizeBillingCycle(currentBillingCycle) !== normalizeBillingCycle(targetBillingCycle)) {
    return 'billing_cycle_change';
  }
  if (currentTier?.slug === targetTier?.slug) return 'same';
  return 'same_rank';
}

function isTrialingSubscription(subscription) {
  return ['TRIALING', 'TRIAL'].includes(String(subscription?.status || '').toUpperCase())
    || subscription?.trial?.state === 'TRIAL_ACTIVE';
}

function changeTiming(direction) {
  return direction === 'downgrade' ? 'period_end' : 'immediate';
}

function targetTrialDays(tier) {
  const parsed = Number.parseInt(tier?.trialDays, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, 365);
}

function paddleProrationModeFor({ direction, subscription } = {}) {
  if (isTrialingSubscription(subscription)) return 'do_not_bill';
  if (direction === 'downgrade') return 'do_not_bill';
  return 'prorated_immediately';
}

function stripeProrationBehaviorFor({ direction, subscription } = {}) {
  if (isTrialingSubscription(subscription)) return 'none';
  if (direction === 'downgrade') return 'none';
  return 'always_invoice';
}

function razorpayScheduleChangeAtFor({ direction, subscription } = {}) {
  // While trialing, never apply 'now' — that triggers an immediate proration
  // charge mid-trial. Defer to cycle end (the trial's end), mirroring the Stripe
  // (proration_behavior 'none') / Paddle ('do_not_bill') trial short-circuit. (B14)
  if (isTrialingSubscription(subscription)) return 'cycle_end';
  return direction === 'downgrade' ? 'cycle_end' : 'now';
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateFromUnixSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed * 1000) : null;
}

function pendingEffectiveAtFromGateway({ subscription, paddleSubscription, stripeSubscription, razorpaySubscription } = {}) {
  return parseDate(subscription?.currentPeriodEnd)
    || parseDate(paddleSubscription?.scheduled_change?.effective_at)
    || parseDate(paddleSubscription?.scheduled_change?.resume_at)
    || parseDate(paddleSubscription?.next_billed_at)
    || parseDate(paddleSubscription?.current_billing_period?.ends_at)
    // Stripe 2025-03-31.basil+ moved current_period_end onto the subscription
    // ITEM; read it there first, then the legacy top-level field.
    || dateFromUnixSeconds(stripeSubscription?.items?.data?.[0]?.current_period_end ?? stripeSubscription?.current_period_end)
    || dateFromUnixSeconds(razorpaySubscription?.change_scheduled_at)
    || dateFromUnixSeconds(razorpaySubscription?.current_end)
    || null;
}

function pendingChangeState(existing, matched, now = new Date()) {
  const pendingTierSlug = existing?.pendingTierSlug || null;
  if (!pendingTierSlug) {
    return { hasPending: false, future: false, due: false, targetMatches: false, effectiveAt: null };
  }
  const effectiveAt = parseDate(existing.pendingChangeEffectiveAt);
  const future = Boolean(effectiveAt && effectiveAt.getTime() > now.getTime());
  return {
    hasPending: true,
    future,
    due: !future,
    targetMatches: Boolean(matched?.tier?.slug && matched.tier.slug === pendingTierSlug),
    effectiveAt,
  };
}

function pendingEntitlementPatch({
  existing,
  matched,
  proposedTierId,
  proposedBillingCycle,
  now = new Date(),
} = {}) {
  const state = pendingChangeState(existing, matched, now);
  if (!state.hasPending) {
    return {
      tierId: proposedTierId,
      billingCycle: proposedBillingCycle,
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
      pendingVertical: null,
      state,
    };
  }

  if (state.future || !state.targetMatches) {
    return {
      tierId: existing.tierId,
      billingCycle: existing.billingCycle,
      pendingTierSlug: existing.pendingTierSlug,
      pendingBillingCycle: existing.pendingBillingCycle,
      pendingChangeEffectiveAt: existing.pendingChangeEffectiveAt,
      pendingVertical: existing.pendingVertical || null,
      state,
    };
  }

  return {
    tierId: matched.tier.id,
    billingCycle: matched.billingCycle || existing.pendingBillingCycle || proposedBillingCycle,
    pendingTierSlug: null,
    pendingBillingCycle: null,
    pendingChangeEffectiveAt: null,
    pendingVertical: null,
    state,
  };
}

module.exports = {
  changeTiming,
  classifyPlanChange,
  dateFromUnixSeconds,
  isTrialingSubscription,
  normalizeBillingCycle,
  paddleProrationModeFor,
  parseDate,
  pendingChangeState,
  pendingEffectiveAtFromGateway,
  pendingEntitlementPatch,
  razorpayScheduleChangeAtFor,
  stripeProrationBehaviorFor,
  targetTrialDays,
};

// billingAccess.js — the SINGLE source of truth for a tenant's billing access.
//
// Paid-only model (owner decision 2026-06-03: "there is no free, just stop; they
// change & pay"). Returns one of FOUR states; every consumer (storefront SSR,
// dashboard shell, entitlement 402s, API write-block) gates on this:
//
//   onboarding — never reached a paid/trial activation (the signup free-tier
//                placeholder). NO platform access; locked to onboarding/billing.
//   active     — a paid subscription that's active/trialing inside its period
//                (or the explicit launch-free promo). Full platform + storefront.
//   grace      — was active, payment is now overdue, still inside the dunning
//                grace window. Full access + a "pay now" banner/countdown.
//   expired    — was active, lapsed past grace (or cancelled + period ended).
//                Storefront goes DARK; dashboard locks to Billing + data export.
//
// The keystone is Subscription.activatedAt: set on first activation, never
// cleared, so a never-paid placeholder (onboarding) is distinguishable from a
// lapsed tenant (expired) even though both end up on the free tier.

const { launchFreePlanGrantsAllowed } = require('./launchPeriod');
const { isPaidTier } = require('./featuresCatalog');

const ACTIVE_STATUSES = new Set(['ACTIVE', 'TRIALING', 'CANCEL_SCHEDULED']);

function future(value, now) {
  return value && new Date(value).getTime() > now.getTime();
}

// → { state: 'onboarding' | 'active' | 'grace' | 'expired', graceUntil?: Date }
function billingAccessState(business, now = new Date()) {
  const sub = business?.subscription || null;
  const status = String(sub?.status || '').toUpperCase();
  // The tier is the source of truth for "paid", NOT a gateway subscription id.
  // Razorpay assigns the sub id at checkout-CREATION (before the mandate is
  // authorized), so a CANCELLED checkout leaves a stale id on the free
  // placeholder tier — that must never read as "paid".
  const onPaidTier = isPaidTier(sub?.tier?.slug || null);

  // Explicit launch-free promo (gated behind its own env flag) → full access.
  if (launchFreePlanGrantsAllowed()) return { state: 'active' };

  // Currently entitled: on a PAID tier, active/trialing, inside its period.
  const entitledNow = onPaidTier
    && ACTIVE_STATUSES.has(status)
    && (future(sub?.currentPeriodEnd, now) || future(sub?.trialEndsAt, now));
  if (entitledNow) return { state: 'active' };

  // Not entitled now. Has this tenant EVER genuinely activated? Either they're
  // still on a paid tier, or activatedAt was stamped on a real activation
  // (never cleared, survives a downgrade-to-free). A stale free-tier gateway id
  // does NOT count — that's the never-paid ONBOARDING placeholder.
  const everActivated = onPaidTier || !!sub?.activatedAt;
  if (!everActivated) return { state: 'onboarding' };

  // Lapsed: inside the dunning grace window → grace, else expired.
  if (future(sub?.accessGraceUntil, now)) {
    return { state: 'grace', graceUntil: sub.accessGraceUntil };
  }
  return { state: 'expired' };
}

// Storefront-dark / renew-lock states (NOT grace — grace keeps serving).
function needsRenewal(business, now) {
  return billingAccessState(business, now).state === 'expired';
}

// Whether the tenant still has platform/storefront access (active or in grace).
function hasBillingAccess(business, now) {
  const state = billingAccessState(business, now).state;
  return state === 'active' || state === 'grace';
}

module.exports = { billingAccessState, needsRenewal, hasBillingAccess };

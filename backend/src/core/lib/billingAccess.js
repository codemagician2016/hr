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

// FREEMIUM (owner decision reversed 2026-07-30): a never-paid Free-tier tenant
// gets BASELINE platform access — core HR works immediately on signup — while
// premium tiers and add-ons stay gated by per-tier ENTITLEMENTS (TierFeature +
// add-on purchase), NOT by a hard billing wall. This intentionally supersedes
// the 2026-06-03 paid-only model for the HR product. Flag-gated so ops can
// restore the strict paid-only wall with PAID_ONLY_BILLING=true. Lapsed PAID
// tenants are unaffected (they still hit grace/expired — see below).
function freeTierBaselineAccessEnabled() {
  return String(process.env.PAID_ONLY_BILLING || '').toLowerCase() !== 'true';
}

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
  //
  // "Inside its period" has to account for there being NO period at all. A paid,
  // ACTIVE subscription carrying neither currentPeriodEnd nor trialEndsAt has not
  // lapsed — there is no boundary for it to have lapsed past. Requiring a future
  // date treated that as `expired` and silently revoked every add-on: the prod
  // demo tenant sat on the Growth tier, status ACTIVE, and still 402'd on
  // recruitment, which is how "Create job is not available" was reported.
  // A plan comped by an admin is the common way to end up here.
  //
  // Deliberately narrow: a subscription that HAS a boundary and is past it still
  // falls through to grace/expired exactly as before, so a genuine lapse is
  // unaffected and the renewal incentive is preserved.
  const hasPeriodBoundary = !!(sub?.currentPeriodEnd || sub?.trialEndsAt);
  const entitledNow = onPaidTier
    && ACTIVE_STATUSES.has(status)
    && (!hasPeriodBoundary || future(sub?.currentPeriodEnd, now) || future(sub?.trialEndsAt, now));
  if (entitledNow) return { state: 'active' };

  // Not entitled now. Has this tenant EVER genuinely activated? Either they're
  // still on a paid tier, or activatedAt was stamped on a real activation
  // (never cleared, survives a downgrade-to-free). A stale free-tier gateway id
  // does NOT count — that's the never-paid ONBOARDING placeholder.
  const everActivated = onPaidTier || !!sub?.activatedAt;

  // FREEMIUM baseline: a NEVER-PAID tenant (free tier, or no subscription row)
  // gets active baseline access. The `!everActivated` guard is deliberate — a
  // tenant that once paid and then lapsed does NOT fall through to free access;
  // they still hit grace/expired below so the renewal incentive is preserved.
  if (freeTierBaselineAccessEnabled() && !everActivated) {
    return { state: 'active' };
  }
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

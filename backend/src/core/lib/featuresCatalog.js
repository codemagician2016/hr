// Sitepresso feature catalog. Single source of truth for:
//   • which feature keys exist (the storefront whitelist),
//   • per-feature DEFAULT state (when no TierFeature row exists),
//   • plan-tier requirement (free vs paid — UI shows "Upgrade to enable"),
//   • admin-facing label + description (drives the Features Settings panel),
//   • vertical scope (so a grocery feature doesn't show on a barber's panel).
//
// Resolution rule for the storefront (tenant.controller.js#resolveFeatures):
//   tierDefault   = TierFeature row for (tier, key) OR FEATURE_CATALOG.defaultOn
//   businessFlag  = business.featureFlags?.[key]   (admin override, NULL = unset)
//   rollout       = only LIVE features can resolve true
//   effective     = rollout && tierDefault && (businessFlag !== false)
//                   // admin can opt out of an enabled feature and can opt in
//                   // to a LIVE, plan-allowed feature whose default is off.
//
// Adding a feature in a future phase:
//   1. Add an entry here.
//   2. Gate the code paths with `useFeature(key)` (frontend) /
//      `featureEnabled(business, key)` (backend).
//   3. (Optional) Seed paid-only features as FALSE in the free tier's
//      TierFeature rows so they don't accidentally turn on for free shops.

// Vertical scopes — features may be ECOMMERCE-only, APPOINTMENT-only, ALL, etc.
const V = { ECOM: 'ECOMMERCE', APPT: 'APPOINTMENT', STATIC: 'STATIC', ALL: 'ALL' };

const FEATURE_CATALOG = Object.freeze({
  // ─── Existing keys (from the blog feature) ─────────────────────────────────
  blogEnabled: {
    label: 'Blog',
    description: 'Show the blog section on your public site.',
    defaultOn: true,
    rolloutStatus: 'LIVE',
    planRequired: null, // free
    vertical: V.ALL,
    excludeVerticals: [V.ECOM],
    category: 'content',
  },
  blogCommentsEnabled: {
    label: 'Blog comments',
    description: 'Allow customers to comment on blog posts.',
    defaultOn: true,
    rolloutStatus: 'LIVE',
    planRequired: null,
    vertical: V.ALL,
    excludeVerticals: [V.ECOM],
    category: 'content',
  },
  // ─── Grocery / ecom feature plan (Phase 0 retrofit + P1–P11 ahead) ─────────
  // Phase 0 retrofit — gate the order-level substitution-policy selector at
  // checkout (some shops want a simpler checkout with the safe default).
  substitutionPolicySelector: {
    label: 'Substitution policy selector at checkout',
    description: 'Let the buyer choose Ask-first / Auto-substitute / Skip-and-refund on each order. When OFF, every order uses the safe "Ask first" default and the picker proposes substitutions via the existing approval flow.',
    defaultOn: true,
    rolloutStatus: 'LIVE',
    planRequired: null,
    vertical: V.ECOM,
    category: 'checkout',
  },

  // P1 — "Buy again" reorder rail on the homepage + per-order CTA.
  buyAgain: {
    label: 'Buy again (reorder)',
    description: 'One-tap reorder from a customer\'s past orders. Big retention lever for grocery.',
    defaultOn: true,
    rolloutStatus: 'LIVE',
    planRequired: null,
    vertical: V.ECOM,
    category: 'discovery',
  },

  // P2 — per-item "If out of stock" preference per cart line.
  perItemSubstitution: {
    label: 'Per-item substitution preferences',
    description: 'Buyer picks a substitution preference on each cart line (e.g. "anything similar" for milk, "do not substitute" for medicine).',
    defaultOn: true,
    rolloutStatus: 'LIVE',
    planRequired: null,
    vertical: V.ECOM,
    category: 'checkout',
  },

  // P3 — refunds to in-store wallet (instant, fee-free) instead of card.
  walletCredit: {
    label: 'Wallet / store credit refunds',
    description: 'Offer "Refund to wallet (instant)" alongside "Back to card (3–7 days)" so refund money stays in your store. Requires a paid plan and the wallet ledger.',
    defaultOn: false,
    rolloutStatus: 'FOUNDATION',
    planRequired: 'PAID',
    vertical: V.ECOM,
    category: 'payments',
  },

  // P4 — buyer can add/remove items for a window after checkout.
  orderModificationWindow: {
    label: 'Order modification window',
    description: 'Let the buyer add/remove items for N minutes after placing the order (before picking). Cuts support tickets.',
    defaultOn: true,
    rolloutStatus: 'FOUNDATION',
    planRequired: null,
    vertical: V.ECOM,
    category: 'checkout',
    settings: { minutes: 30 },
  },

  // P5 — show stock signals on the product detail page.
  realTimeStock: {
    label: 'Real-time stock display',
    description: 'Show "Only N left" or "In stock" on product pages. Reduces substitution surprises and creates gentle urgency.',
    defaultOn: true,
    rolloutStatus: 'LIVE',
    planRequired: null,
    vertical: V.ECOM,
    category: 'discovery',
    settings: { lowStockThreshold: 5 },
  },

  // P6 — Subscribe & Save (recurring orders for staples).
  subscriptions: {
    label: 'Subscribe & save',
    description: 'Customers subscribe to weekly/monthly deliveries of staples with an automatic discount. Paid plan + Paddle product setup required.',
    defaultOn: false,
    rolloutStatus: 'COMING_SOON',
    planRequired: 'PAID',
    vertical: V.ECOM,
    category: 'retention',
  },

  // P7 — persistent shopping list across the week, optional family share.
  shoppingList: {
    label: 'Shopping list',
    description: 'A persistent list customers can add to over the week, then check out in one go. Boosts basket size + reduces cart-creation friction.',
    defaultOn: true,
    rolloutStatus: 'COMING_SOON',
    planRequired: null,
    vertical: V.ECOM,
    category: 'discovery',
  },

  // P8 — customer-visible "Picking → Packed → Out for delivery" tracker.
  liveTracker: {
    label: 'Live picking / delivery tracker',
    description: 'Surface the picker + rider progress to the customer (timeline + ETA + map when delivery starts). Requires picker discipline in your app.',
    defaultOn: false,
    rolloutStatus: 'FOUNDATION',
    planRequired: null,
    vertical: V.ECOM,
    category: 'fulfillment',
  },

  // P9 — recipes that add all ingredients to the cart.
  recipeToCart: {
    label: 'Recipe-to-cart',
    description: 'A recipes section where one tap adds every ingredient to the cart. Solves "what to cook" + lifts average order value. Paid plan (content management).',
    defaultOn: false,
    rolloutStatus: 'COMING_SOON',
    planRequired: 'PAID',
    vertical: V.ECOM,
    category: 'discovery',
  },

  // P10 — personalized homepage rails (usuals, seasonal, dietary).
  personalizedHome: {
    label: 'Personalized homepage',
    description: '"Your usuals", "Try this" and seasonal rails on the homepage, computed from purchase history. Paid plan (data + privacy).',
    defaultOn: false,
    rolloutStatus: 'COMING_SOON',
    planRequired: 'PAID',
    vertical: V.ECOM,
    category: 'discovery',
  },

  // P11 — one-tap "got it wrong" with automatic small credit.
  issueReport: {
    label: 'Got-it-wrong report flow',
    description: 'One-tap "this item was damaged / wrong / missing" on the order page (with photo). Auto-credits the customer up to a cap; bigger issues route to admin.',
    defaultOn: true,
    rolloutStatus: 'FOUNDATION',
    planRequired: null,
    vertical: V.ECOM,
    category: 'trust',
    settings: { autoCreditMaxMinor: 50000 }, // ₹500
  },
});

const FEATURE_KEYS_FOR_STOREFRONT = Object.keys(FEATURE_CATALOG);

// "PAID" means: tenant has a Subscription whose tier slug isn't 'free'. The
// caller passes the resolved tier (or its slug) for the check.
const FREE_TIER_SLUG_SET = new Set(['free', 'static-free', 'ecom-free', 'trial']);
function isPaidTier(tier) {
  if (!tier) return false;
  const slug = (typeof tier === 'string' ? tier : tier?.slug || '').toLowerCase();
  // Every vertical's free tier (free / static-free / ecom-free) is NOT paid.
  return Boolean(slug) && !FREE_TIER_SLUG_SET.has(slug);
}

// Returns the catalog filtered to the vertical (for admin UI rendering).
function rolloutIsLive(status) {
  return String(status || 'LIVE').toUpperCase() === 'LIVE';
}

function featureAppliesToVertical(meta, vertical) {
  if (!meta) return false;
  const v = String(vertical || '').toUpperCase();
  if (Array.isArray(meta.excludeVerticals) && meta.excludeVerticals.includes(v)) return false;
  return meta.vertical === V.ALL || meta.vertical === v;
}

function catalogForVertical(vertical) {
  return Object.fromEntries(
    Object.entries(FEATURE_CATALOG).filter(([, meta]) => featureAppliesToVertical(meta, vertical)),
  );
}

// Pure resolver: given catalog default, tier override and admin override,
// returns the effective boolean. Non-live rollouts and plan gates win first;
// otherwise admins may opt out or opt into a LIVE, plan-allowed feature.
function effectiveEnabled({ catalogDefault, tierOverride, adminOverride, planAllowed = true, rolloutStatus = 'LIVE' }) {
  if (!rolloutIsLive(rolloutStatus)) return false;
  if (!planAllowed) return false; // plan gate wins everything else
  if (adminOverride === true) return true;
  const tierLevel = typeof tierOverride === 'boolean' ? tierOverride : catalogDefault;
  if (!tierLevel) return false;
  if (adminOverride === false) return false; // explicit admin opt-out
  return true;
}

module.exports = {
  FEATURE_CATALOG,
  FEATURE_KEYS_FOR_STOREFRONT,
  isPaidTier,
  catalogForVertical,
  effectiveEnabled,
  rolloutIsLive,
  featureAppliesToVertical,
};

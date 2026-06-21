const express = require('express');
const router = express.Router();
const { submitEnquiry } = require('../../web/controllers/enquiry.controller');
const { joinWaitlist } = require('../../booking/controllers/waitlist.controller');
const { getPublicPages, getPublicSiteNav } = require('../../web/controllers/page.controller');
const {
  getPublicProducts,
  getPublicProduct,
  getPublicCategories,
} = require('../../shop/controllers/product.controller');
const {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
  setLocation: setCartLocation,
  previewLocation: previewCartLocation,
} = require('../../shop/controllers/cart.controller');
const {
  checkout,
  getPublicOrder,
  getCustomerOrders,
  getBuyAgainProducts,
  customerRemoveItem,
  cancelPendingOrder,
  resolvePublicSubstitution,
} = require('../../shop/controllers/order.controller');
const { enquiryLimiter, honeypot, verifyTurnstile } = require('../../core/middleware/abuse.middleware');
const { tryCustomer } = require('../../core/middleware/tryCustomer.middleware');
const { requireAuth, requireBusinessAdmin, requireCustomer } = require('../../core/middleware/auth.middleware');
const { requireStorefrontVertical } = require('../../core/middleware/requireVertical');
const { validateBody } = require('../../core/lib/validate');
const { submitEnquirySchema } = require('../../core/lib/schemas/enquiry.schema');
const { joinWaitlistSchema } = require('../../core/lib/schemas/waitlist.schema');
const domainPublic = require('../../domains/domainPublic.controller');

const requireBookingStorefront = requireStorefrontVertical('APPOINTMENT');
const requireShopStorefront = requireStorefrontVertical('ECOMMERCE');

// Public storefront endpoints — no auth. Scoped to a specific business
// via the :slug path param so a visitor on acme-clinic.sitepresso.com
// submits to /api/storefront/acme-clinic/enquiry.
//
// Three anti-abuse layers fire in order:
//   1. enquiryLimiter — 5 submissions per 10 min per IP.
//   2. honeypot       — drops any request with the decoy hp_field populated.
//   3. verifyTurnstile — Cloudflare captcha (skipped gracefully if the
//                         TURNSTILE_SECRET env var isn't set yet).
router.post('/:slug/enquiry', enquiryLimiter, honeypot, verifyTurnstile, validateBody(submitEnquirySchema), submitEnquiry);

// Waitlist join — same anti-abuse stack (limiter + honeypot +
// turnstile). tryCustomer is permissive: logged-in customers get
// req.customer populated, guests pass through unauthenticated.
router.post('/:slug/waitlist', enquiryLimiter, requireBookingStorefront, honeypot, verifyTurnstile, tryCustomer, validateBody(joinWaitlistSchema), joinWaitlist);

// Multi-page CMS — published pages only, no auth. Storefront uses this
// to render dropdowns under each nav section.
router.get('/:slug/pages', getPublicPages);
router.get('/:slug/site-nav', getPublicSiteNav);

// Domain reseller search is public/read-only so onboarding can show
// availability before a tenant buys anything. Mutations stay owner-gated.
router.get('/:slug/domain/search', domainPublic.search);
router.get('/:slug/domain', requireAuth, requireBusinessAdmin, domainPublic.listForSlug);
router.post('/:slug/domain/checkout', requireAuth, requireBusinessAdmin, domainPublic.checkoutForSlug);
router.post('/:slug/domain/register', requireAuth, requireBusinessAdmin, domainPublic.registerForSlug);
router.post('/:slug/domain/transfer-in', requireAuth, requireBusinessAdmin, domainPublic.transferInForSlug);
router.post('/:slug/domain/byod', requireAuth, requireBusinessAdmin, domainPublic.byodForSlug);

router.get('/:slug/locations', requireShopStorefront, require('../controllers/locations.controller').listPublic);
// Multi-store Flow A (2026-05-11) — postal-code → serving stores.
router.get('/:slug/locations/resolve', requireShopStorefront, require('../controllers/locations.controller').resolvePublic);
router.get('/:slug/store-brands', requireShopStorefront, require('../../shop/controllers/storeBrands.controller').listPublic);

// E-commerce — published products + categories. Storefront grid + detail.
router.get('/:slug/products', requireShopStorefront, getPublicProducts);
router.get('/:slug/products/:productSlug', requireShopStorefront, getPublicProduct);
router.get('/:slug/categories', requireShopStorefront, getPublicCategories);

// E-commerce Phase 2 — Cart. tryCustomer so logged-in shoppers attach to
// their account; guests pass through with X-Cart-Session header.
router.get('/:slug/cart',                       requireShopStorefront, tryCustomer, getCart);
router.post('/:slug/cart/items',                requireShopStorefront, tryCustomer, addItem);
router.patch('/:slug/cart/items/:itemId',       requireShopStorefront, tryCustomer, updateItem);
router.delete('/:slug/cart/items/:itemId',      requireShopStorefront, tryCustomer, removeItem);
router.delete('/:slug/cart',                    requireShopStorefront, tryCustomer, clearCart);
// Multi-store (2026-05-11) — set / change which physical store fulfils the cart.
router.post('/:slug/cart/location',             requireShopStorefront, tryCustomer, setCartLocation);
router.post('/:slug/cart/location/preview',     requireShopStorefront, tryCustomer, previewCartLocation);

// Checkout — converts cart → order. enquiryLimiter is the same anti-abuse
// rate limit used for enquiry/waitlist (5/10min/IP). honeypot rejects
// auto-fill bots; turnstile only validates if TURNSTILE_SECRET is set.
router.post('/:slug/checkout', enquiryLimiter, requireShopStorefront, honeypot, verifyTurnstile, tryCustomer, checkout);
router.post('/:slug/coupon/validate', requireShopStorefront, tryCustomer, require('../../shop/controllers/storefrontCoupon.controller').validateCoupon);

// Order lookup (guest or customer). Guests must supply ?email= matching
// the email used at checkout; logged-in customers are matched by id.
router.get('/:slug/orders/:orderId', requireShopStorefront, tryCustomer, getPublicOrder);

// Cancel a PENDING order (buyer-initiated abandonment). Restores stock
// and rolls back any coupon redemption so the buyer can edit cart and try
// again. Same auth model as the GET above (customer match OR ?email=).
router.post('/:slug/orders/:orderId/cancel', requireShopStorefront, tryCustomer, cancelPendingOrder);

// Approve / reject a proposed item substitution. Same auth model as the GET
// above (customer match OR email in the body), so guests can act from the
// tracking link.
router.post('/:slug/orders/:orderId/items/:itemId/substitution', requireShopStorefront, tryCustomer, resolvePublicSubstitution);

// Customer order history — requires customer JWT
router.get('/:slug/customer/orders', requireCustomer, requireShopStorefront, getCustomerOrders);
router.get('/:slug/customer/orders/:orderId', requireCustomer, requireShopStorefront, getPublicOrder);
// P1 — Buy Again rail + per-order reorder button. Gated client-side by the
// buyAgain feature flag; server still requires a logged-in customer so a
// guest can't probe another shopper's purchase history.
router.get('/:slug/customer/buy-again', requireCustomer, requireShopStorefront, getBuyAgainProducts);
// P3 — wallet balance + recent ledger. Gated client-side by walletCredit;
// requireCustomer ensures only the owner can read their own balance.
router.get('/:slug/customer/wallet', requireCustomer, requireShopStorefront, require('../../shop/controllers/wallet.controller').getWallet);
// P4 — within the modification window, the customer can drop a line item
// from their just-placed order. Gated server-side by the feature flag +
// time window + status; the existing applyReconciliation pipeline issues
// the refund through wallet (P3) or Paddle.
router.post('/:slug/customer/orders/:orderId/items/:itemId/remove', requireCustomer, requireShopStorefront, customerRemoveItem);

// P6 — Customer "Subscribe & Save" CRUD. Storefront UI is gated by the
// subscriptions feature flag (paid tier); the API itself is unconditional
// so cron jobs and admin tooling keep operating during a wind-down.
const subsCtrl = require('../../shop/controllers/subscriptions.controller');
router.get   ('/:slug/customer/subscriptions',            requireCustomer, requireShopStorefront, subsCtrl.listMine);
router.post  ('/:slug/customer/subscriptions',            requireCustomer, requireShopStorefront, subsCtrl.createSubscription);
router.post  ('/:slug/customer/subscriptions/:id/pause',  requireCustomer, requireShopStorefront, subsCtrl.pauseSubscription);
router.post  ('/:slug/customer/subscriptions/:id/resume', requireCustomer, requireShopStorefront, subsCtrl.resumeSubscription);
router.post  ('/:slug/customer/subscriptions/:id/skip',   requireCustomer, requireShopStorefront, subsCtrl.skipNext);
router.delete('/:slug/customer/subscriptions/:id',        requireCustomer, requireShopStorefront, subsCtrl.cancelSubscription);

// P7 — Persistent shopping list. UI gated by shoppingList flag client-side.
const shoppingListCtrl = require('../../shop/controllers/shoppingList.controller');
router.get   ('/:slug/customer/shopping-list',                  requireCustomer, requireShopStorefront, shoppingListCtrl.getMyList);
router.post  ('/:slug/customer/shopping-list/items',            requireCustomer, requireShopStorefront, shoppingListCtrl.addItem);
router.delete('/:slug/customer/shopping-list/items/:itemId',    requireCustomer, requireShopStorefront, shoppingListCtrl.removeItem);

// P8 — Live picking / delivery tracker. tryCustomer (not requireCustomer)
// so a guest can track via ?email= the same way the public order detail
// flow already works.
router.get('/:slug/customer/orders/:orderId/timeline', tryCustomer, requireShopStorefront, require('../../shop/controllers/orderTimeline.controller').getTimeline);

// P9 — Recipe-to-cart. Public list + detail; admin CRUD is a clean follow-on.
const recipesCtrl = require('../../shop/controllers/recipes.controller');
router.get('/:slug/recipes',                requireShopStorefront, recipesCtrl.listPublic);
router.get('/:slug/recipes/:recipeSlug',    requireShopStorefront, recipesCtrl.getPublic);

// P10 — Personalized homepage rails. One round-trip → { yourUsuals,
// seasonal, tryThis } for the logged-in customer; the homepage component
// just gates the mount with useFeature('personalizedHome').
router.get('/:slug/customer/personal-rails', requireCustomer, requireShopStorefront, require('../../shop/controllers/personalRails.controller').getRails);

// P11 — "Got it wrong" report. tryCustomer (not requireCustomer) so guests
// can submit too; auto-credit only runs for a logged-in customer (the
// wallet has nowhere to land otherwise) and is gated by both issueReport
// AND walletCredit feature flags + the per-feature autoCreditMaxMinor cap.
router.post('/:slug/customer/orders/:orderId/issue', tryCustomer, requireShopStorefront, require('../../shop/controllers/orderIssue.controller').reportIssue);

// Wishlist — guest (session-keyed) or customer. tryCustomer so logged-in
// shoppers bind to their account; guests use X-Cart-Session header.
const {
  getWishlist,
  addWishlistItem,
  removeWishlistItem,
  mergeWishlist,
} = require('../../shop/controllers/wishlist.controller');
router.get('/:slug/wishlist',                    requireShopStorefront, tryCustomer, getWishlist);
router.post('/:slug/wishlist/items',             requireShopStorefront, tryCustomer, addWishlistItem);
router.delete('/:slug/wishlist/items/:itemId',   requireShopStorefront, tryCustomer, removeWishlistItem);
router.post('/:slug/wishlist/merge',             requireCustomer, requireShopStorefront, mergeWishlist);

// Banners — public, no auth. Returns active banners filtered by placement.
const { getPublicBanners } = require('../../shop/controllers/storefrontBanners.controller');
router.get('/:slug/banners', requireShopStorefront, getPublicBanners);

// CMS blocks — public, no auth. Returns PUBLISHED blocks filtered by slotKey.
const { getPublicCmsBlocks } = require('../../shop/controllers/storefrontCmsBlocks.controller');
router.get('/:slug/cms-blocks', requireShopStorefront, getPublicCmsBlocks);

// Legal policies — public. List (for footer / signup) + single policy content.
const storePolicies = require('../../shop/controllers/storePolicies.controller');
router.get('/:slug/policies', requireShopStorefront, storePolicies.publicList);
router.get('/:slug/policies/:policySlug', requireShopStorefront, storePolicies.publicGet);

// Reviews — GET is public (PUBLISHED only). POST requires a signed-in customer
// who purchased the product (enforced in the controller). can-review tells the
// storefront UI whether to show the form / a sign-in prompt / "buyers only".
const { getProductReviews, submitReview, canReviewProduct } = require('../../shop/controllers/storefrontReviews.controller');
router.get('/:slug/products/:productId/reviews', requireShopStorefront, getProductReviews);
router.get('/:slug/products/:productId/can-review', requireShopStorefront, tryCustomer, canReviewProduct);
router.post('/:slug/reviews', requireShopStorefront, tryCustomer, submitReview);

// Delivery slots — public availability for the next N days. Used by the
// grocery checkout slot picker. Read-only; capacity is held when the
// matching order is created (see order.controller checkout).
const { getSlotAvailability } = require('../../shop/controllers/storefrontSlots.controller');
router.get('/:slug/slots', requireShopStorefront, getSlotAvailability);

// Payment providers — public read of which gateways the tenant has
// onboarded (ACTIVE only). Storefront checkout uses this to decide
// whether to offer Online vs COD-only.
const { getProviders } = require('../../shop/controllers/storefrontPayment.controller');
router.get('/:slug/payment-providers', requireShopStorefront, getProviders);

// Click & Collect — public list of active pickup locations. Returns
// { enabled: false, locations: [] } when the tenant has the feature off
// so the storefront can render a fallback.
const { publicList: pickupPublicList } = require('../../shop/controllers/pickupLocation.controller');
router.get('/:slug/pickup-locations', requireShopStorefront, pickupPublicList);

// Brand catalog for the storefront — drives the "Shop by brand" widget.
const { publicList: brandPublicList } = require('../../shop/controllers/productBrand.controller');
router.get('/:slug/brands', requireShopStorefront, brandPublicList);

// Related products — frequently-bought-together + trending fallback.
// Used by the PDP "More like this" strip.
const { getRelatedProducts } = require('../../shop/controllers/storefrontRelated.controller');
router.get('/:slug/products/:productId/related', requireShopStorefront, getRelatedProducts);

// F3 — customer-facing returns. Customer files a return on a delivered
// order; backend translates the lightweight payload into a full
// EcomReturn the staff Returns panel manages. requireCustomer guard.
const { submitReturn } = require('../../shop/controllers/storefrontReturns.controller');
router.post('/:slug/returns', requireCustomer, requireShopStorefront, submitReturn);

// F3 — loyalty / rewards. Read-only for customers; balance derived from
// EcomLoyaltyLedger SUM(points). Earn happens server-side on PAID, so
// no POST here — redemption ships in the checkout flow later.
const { getMyLoyalty } = require('../../shop/controllers/storefrontLoyalty.controller');
router.get('/:slug/loyalty', requireCustomer, requireShopStorefront, getMyLoyalty);

// F3 — customer notification preferences (per-category × per-channel).
// JSON blob on Customer.notificationPrefs; locked channels force ON.
const { getPrefs, updatePrefs } = require('../../shop/controllers/storefrontNotificationPrefs.controller');
router.get('/:slug/notification-prefs', requireCustomer, requireShopStorefront, getPrefs);
router.put('/:slug/notification-prefs', requireCustomer, requireShopStorefront, updatePrefs);

module.exports = router;

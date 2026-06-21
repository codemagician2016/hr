const express = require('express');
const router = express.Router();
const { requireAuth, requireBusinessAdmin } = require('../../core/middleware/auth.middleware');
const {
  getBilling,
  getBillingWorkspace,
  getBillingProfile,
  getBillingInvoice,
  viewSubscriptionInvoice,
  getPaddleClientConfig,
  getMySubscription,
  commitBillingChange,
  openBillingPortal,
  previewBillingChange,
  reconcileBillingState,
  cancelSubscriptionPlan,
  resumeSubscriptionPlan,
  selectPlan,
  startTrial,
  syncFromPaddle,
  syncFromStripe,
  syncFromRazorpay,
  updateBillingProfile,
  updateTheme,
  switchArchetype,
  updateCustomDomain,
  disconnectCustomDomain,
  getCustomDomainStatus,
} = require('../controllers/subscription.controller');
const { redeemCoupon, validateCouponPreview } = require('../../booking/controllers/adminCoupon.controller');
const { confirmMandate } = require('../lib/billing/chargeAtWill');

// Razorpay charge-at-will: the frontend posts the Checkout.js authorization
// result here to capture the mandate token + activate the TOKEN subscription.
// Flag-gated inside confirmMandate (409 when RAZORPAY_CHARGE_AT_WILL is off).
router.post('/razorpay/confirm-mandate', requireBusinessAdmin, async (req, res) => {
  try {
    const updated = await confirmMandate({
      businessId: req.user.businessId,
      razorpayOrderId: req.body.razorpay_order_id,
      razorpayPaymentId: req.body.razorpay_payment_id,
      razorpaySignature: req.body.razorpay_signature,
    });
    res.json({ ok: true, status: updated.status, tier: updated.tier?.slug || null });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Could not confirm the mandate.' });
  }
});

// Paddle client token is public (it's the frontend-side token). Serve the
// config endpoint before `protect` so the checkout launcher page — which
// has no user session yet if opened via direct URL — can initialise Paddle.js.
router.get('/paddle-config', getPaddleClientConfig);

router.use(requireAuth);

// Any authenticated owner of a business can read their subscription (BUSINESS_ADMIN in practice)
router.get('/', getMySubscription);
router.get('/workspace', requireBusinessAdmin, getBillingWorkspace);
router.get('/billing', requireBusinessAdmin, getBilling);
router.get('/billing-profile', requireBusinessAdmin, getBillingProfile);
router.put('/billing-profile', requireBusinessAdmin, updateBillingProfile);
router.post('/billing/portal', requireBusinessAdmin, openBillingPortal);
router.post('/billing/invoices/:transactionId', requireBusinessAdmin, getBillingInvoice);
// Printable HTML GST invoice (India/self-billed). GET so it opens in a new tab.
router.get('/billing/invoices/:transactionId/view', requireBusinessAdmin, viewSubscriptionInvoice);

// Mutations are BUSINESS_ADMIN only
router.post('/change-preview', requireBusinessAdmin, previewBillingChange);
router.post('/change', requireBusinessAdmin, commitBillingChange);
router.post('/reconcile', requireBusinessAdmin, reconcileBillingState);
router.post('/cancel', requireBusinessAdmin, cancelSubscriptionPlan);
router.post('/resume', requireBusinessAdmin, resumeSubscriptionPlan);
router.post('/select', requireBusinessAdmin, selectPlan);
router.post('/start-trial', requireBusinessAdmin, startTrial);
router.post('/sync-from-paddle', requireBusinessAdmin, syncFromPaddle);
router.post('/sync-from-stripe', requireBusinessAdmin, syncFromStripe);
router.post('/sync-from-razorpay', requireBusinessAdmin, syncFromRazorpay);
router.put('/theme', requireBusinessAdmin, updateTheme);
router.post('/switch-archetype', requireBusinessAdmin, switchArchetype);
router.put('/custom-domain', requireBusinessAdmin, updateCustomDomain);
router.delete('/custom-domain', requireBusinessAdmin, disconnectCustomDomain);
router.get('/custom-domain/status', requireBusinessAdmin, getCustomDomainStatus);
router.post('/custom-domain/verify', requireBusinessAdmin, getCustomDomainStatus);

// Super-admin subscription coupon redemption (validate + apply)
router.post('/validate-coupon', requireBusinessAdmin, validateCouponPreview);
router.post('/redeem-coupon', requireBusinessAdmin, redeemCoupon);

module.exports = router;

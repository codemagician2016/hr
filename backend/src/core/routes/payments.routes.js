'use strict';
const express = require('express');
const { protect, requireRole } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const a = require('../middleware/asyncHandler');
const c = require('../controllers/payments.controller');
const { paymentLimiter } = require('../../core/middleware/abuse.middleware');

const router = express.Router();

// Public: storefront kicks off a payment + Razorpay buyer-success callback.
// Rate-limited — unauthenticated, so cap abuse of the payment gateway.
router.post('/order', paymentLimiter, a(c.createPaymentOrder));
router.post('/razorpay/success', paymentLimiter, a(c.razorpayCheckoutSuccess));

// NOTE: the buyer-payment webhooks (/api/payments/razorpay/webhook and
// /api/payments/stripe/webhook) are intentionally NOT registered here. They
// need the RAW request body for HMAC verification, so they are mounted directly
// on the app in src/index.js BEFORE the global express.json() parser.

// Admin: account management
router.get('/accounts',                 protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), a(c.listAccounts));
router.post('/accounts/connect',        protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), a(c.connectAccount));
router.delete('/accounts/:id',          protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), a(c.disconnectAccount));

// Stripe Connect (rest of world) — gateway-hosted onboarding
router.post('/stripe/onboarding-link',  protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), a(c.stripeOnboardingLink));
router.get('/stripe/onboarding-status', protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), a(c.stripeOnboardingStatus));
// Stripe BYO — tenant connects their OWN Stripe account/keys (no Connect)
router.post('/stripe/connect-keys',     protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), a(c.stripeConnectKeys));

// Razorpay (India) — BYO: tenant connects their OWN Razorpay account/keys
router.post('/razorpay/connect-keys',   protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), a(c.razorpayConnectKeys));
router.get('/razorpay/onboarding-status', protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN), a(c.razorpayOnboardingStatus));

module.exports = router;

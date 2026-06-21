// ECOMMERCE payments controller — admin onboarding + storefront checkout
// payment-order creation + webhook handlers.
//
// Tenant onboarding model by region:
//   • India (Razorpay) → BYO ("bring your own"): the tenant connects their OWN
//     Razorpay account (Key ID + Key Secret + Webhook Secret). RBI's Payment-
//     Aggregator rules mean a platform can't legally collect/route buyer funds on
//     a merchant's behalf without a PA licence, so each India tenant uses their
//     own Razorpay account (KYC'd directly with Razorpay). Sitepresso creates the
//     order + verifies signatures with the TENANT's keys and is never in the
//     money flow. This mirrors the Shopify-India model.
//   • Rest of world (Stripe) → Stripe Connect direct charges. Stripe holds the
//     money-transmitter licences, so the tenant onboards via Stripe-hosted KYC
//     and Sitepresso only takes an application fee.
'use strict';

const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { encrypt, decrypt } = require('../lib/crypto');
const razorpay = require('../lib/razorpayRoute');
const stripe = require('../lib/stripeConnect');
const { getDefaultCurrency } = require('../lib/currency');
const {
  normalizeCountry,
  resolveTenantPaymentGateway,
  resolveTenantPaymentRoute,
  tenantGatewayCurrencyBlock,
  tenantGatewayMismatch,
} = require('../lib/billing/gatewayRouter');
const {
  buildTenantPaymentReadiness,
} = require('../lib/billing/tenantPaymentReadiness');
const { integratedBuyerPaymentsAllowed } = require('../lib/buyerPaymentPolicy');
const { getBuyerGateway } = require('../lib/billing/buyerGateways');
const { clearCartOnPaidOrder, confirmSlotBookingForOrder } = require('../../shop/controllers/order.controller');
const { grantOnPaidOrder } = require('../../shop/controllers/storefrontLoyalty.controller');
const { safeEmit } = require('../lib/webhookDispatcher');

const prisma = new PrismaClient();
async function bizId(req) { return req.user?.businessId || null; }

async function loadPaymentRouteForBusiness(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, name: true, slug: true, email: true, phone: true, country: true, defaultCurrency: true },
  });
  if (!business) return { business: null, route: null, currency: null };
  const currency = getDefaultCurrency({ business });
  const route = resolveTenantPaymentRoute({ countryCode: business.country, currency });
  return { business, route, currency };
}

// India = BYO Razorpay (the tenant brings their own account/keys), so there is
// no platform-level "backend key" requirement for Razorpay buyer checkout.
// Stripe still needs the platform secret key (the Connect platform account).
function providerIsConfigured(provider) {
  return provider === 'RAZORPAY' ? true : stripe.isConfigured();
}

function backendBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host');
  return `${proto}://${host}`;
}

// The Razorpay referral link a tenant should use to CREATE their Razorpay
// account, so the owner earns reseller-partner commission on the tenant's
// payments. Configured per environment.
function razorpayReferralUrl() {
  return process.env.RAZORPAY_PARTNER_REFERRAL_URL || null;
}

function businessCountryRequiredResponse() {
  return {
    code: 'BUSINESS_COUNTRY_REQUIRED',
    message: 'Set the store country before connecting online payments. Payment gateway routing depends on the seller country.',
  };
}

function paymentRouteMismatchResponse(mismatch) {
  return {
    ...mismatch,
    message: `${mismatch.requiredProviderLabel} is the required checkout path for this store country. Create a separate store account for another country, or change the store country before onboarding a different provider.`,
  };
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// A Razorpay account connected via BYO keys (the only India model).
function isRazorpayByoAccount(account) {
  return account?.provider === 'RAZORPAY' && jsonObject(account.metadata).connectionModel === 'BYO_KEYS';
}

function getRazorpayByoKeys(account) {
  const m = jsonObject(account.metadata);
  return {
    keyId: m.keyId || null,
    keySecret: m.keySecretEncrypted ? decrypt(m.keySecretEncrypted) : null,
    webhookSecret: m.webhookSecretEncrypted ? decrypt(m.webhookSecretEncrypted) : null,
  };
}

// A Stripe account connected via BYO keys (the tenant's own Stripe account).
function isStripeByoAccount(account) {
  return account?.provider === 'STRIPE' && jsonObject(account.metadata).connectionModel === 'BYO_KEYS';
}

function getStripeByoKeys(account) {
  const m = jsonObject(account.metadata);
  return {
    publishableKey: m.publishableKey || account.accountId,
    secretKey: m.secretKeyEncrypted ? decrypt(m.secretKeyEncrypted) : null,
    webhookSecret: m.webhookSecretEncrypted ? decrypt(m.webhookSecretEncrypted) : null,
  };
}

// Never return any secret material to the client.
function publicAccount(account) {
  if (!account) return account;
  const safeMetadata = { ...jsonObject(account.metadata) };
  delete safeMetadata.keySecretEncrypted;     // Razorpay BYO secret
  delete safeMetadata.secretKeyEncrypted;     // Stripe BYO secret
  delete safeMetadata.webhookSecretEncrypted; // both
  return { ...account, metadata: safeMetadata };
}

// Emit the order.paid webhook for a freshly-paid order. Looks the order up so
// the payload + businessId are correct from any payment path. Fire-and-forget.
async function emitOrderPaid(orderId) {
  try {
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, businessId: true, status: true, paymentMethod: true,
        paymentProvider: true, currency: true, subtotalMinor: true, totalMinor: true,
        customerEmail: true, customerName: true, paidAt: true,
      },
    });
    if (o) safeEmit('order.paid', o, o.businessId);
  } catch (e) { console.error('[webhook] order.paid lookup', e?.message); }
}

async function refreshStripeAccountStatus(account) {
  if (!account || account.provider !== 'STRIPE' || !account.accountId || !stripe.isConfigured()) return account;
  const fetched = await stripe.fetchConnectedAccount(account.accountId);
  if (!fetched.ok) return account;
  if (fetched.status !== account.status) {
    return prisma.businessPaymentAccount.update({
      where: { id: account.id },
      data: { status: fetched.status },
      select: {
        id: true, provider: true, accountId: true, status: true,
        platformFeePct: true, createdAt: true, updatedAt: true,
      },
    });
  }
  return account;
}

// ─── ADMIN: list payment accounts + readiness + route ───────────────────────
async function listAccounts(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const { business, route, currency } = await loadPaymentRouteForBusiness(businessId);
  if (!business) return res.status(404).json({ message: 'Business not found' });
  const rows = await prisma.businessPaymentAccount.findMany({
    where: { businessId },
    select: { id: true, provider: true, accountId: true, status: true, platformFeePct: true, metadata: true, createdAt: true, updatedAt: true },
  });
  // Only Stripe has an async-resolving status to refresh; BYO Razorpay accounts
  // are ACTIVE the moment valid keys are stored.
  const accounts = await Promise.all(rows.map(async (account) => {
    if (account.provider === 'STRIPE' && account.status !== 'ACTIVE') {
      return refreshStripeAccountStatus(account).catch(() => account);
    }
    return account;
  }));
  const requiredAccount = accounts.find((account) => account.provider === route.provider) || null;
  const readiness = buildTenantPaymentReadiness({
    business,
    currency,
    account: requiredAccount,
    providerConfigured: providerIsConfigured(route.provider),
  });
  // Whether INTEGRATED (Stripe Connect) onboarding may be offered for this
  // country. Default BYO-only; the seller UI hides the "connect with Stripe"
  // path when this is false.
  const integratedAllowed = await integratedBuyerPaymentsAllowed(route.country);
  res.json({
    accounts: accounts.map(publicAccount),
    readiness,
    route: {
      country: route.country,
      currency,
      provider: route.provider,
      providerLabel: route.providerLabel,
      model: route.model,
      modelLabel: route.modelLabel,
      expectedCurrency: route.expectedCurrency,
      countryRequired: route.countryRequired,
      // Compliance policy: is integrated (Stripe Connect) offered here, or
      // BYO-only? Razorpay (IN) is BYO regardless of this flag.
      integratedAllowed,
      byoOnly: !integratedAllowed,
      canAcceptOnline: readiness.canAcceptOnline,
      setupState: readiness.setupState,
      // India = BYO Razorpay: the tenant connects their own account + keys.
      razorpayConnectModel: 'BYO_KEYS',
      razorpayReferralUrl: razorpayReferralUrl(),
      // The webhook URL the tenant must add in THEIR Razorpay dashboard.
      razorpayWebhookUrl: `${backendBaseUrl(req)}/api/payments/razorpay/webhook`,
      // The webhook URL a BYO Stripe tenant must add in THEIR Stripe dashboard.
      stripeWebhookUrl: `${backendBaseUrl(req)}/api/payments/stripe/webhook`,
    },
  });
}

// ─── ADMIN: connect Stripe-style account by id (manual; Stripe only) ─────────
const connectSchema = z.object({
  provider: z.enum(['STRIPE']),
  accountId: z.string().min(1).max(200),
  platformFeePct: z.number().min(0).max(10).optional(),
});
async function connectAccount(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  const { business, currency } = await loadPaymentRouteForBusiness(businessId);
  if (!business) return res.status(404).json({ message: 'Business not found' });
  if (!normalizeCountry(business.country)) return res.status(409).json(businessCountryRequiredResponse());
  const mismatch = tenantGatewayMismatch({ provider: parsed.data.provider, countryCode: business.country, currency });
  if (mismatch) return res.status(409).json(paymentRouteMismatchResponse(mismatch));

  const account = await prisma.businessPaymentAccount.upsert({
    where: { businessId_provider: { businessId, provider: parsed.data.provider } },
    update: { accountId: parsed.data.accountId,
              ...(parsed.data.platformFeePct != null && { platformFeePct: parsed.data.platformFeePct }) },
    create: {
      businessId, provider: parsed.data.provider, accountId: parsed.data.accountId,
      platformFeePct: parsed.data.platformFeePct ?? 0, status: 'PENDING',
    },
  });
  res.json(publicAccount(account));
}

async function disconnectAccount(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const existing = await prisma.businessPaymentAccount.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  await prisma.businessPaymentAccount.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}

// ─── ADMIN: kick off Stripe Connect Express onboarding link ─────────────────
async function stripeOnboardingLink(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const { business, currency } = await loadPaymentRouteForBusiness(businessId);
  if (!business) return res.status(404).json({ message: 'Business not found' });
  if (!normalizeCountry(business.country)) return res.status(409).json(businessCountryRequiredResponse());
  // Compliance gate: integrated (Stripe Connect) onboarding is only offered where
  // the owner has opted that country into integrated. Default = BYO-only.
  if (!(await integratedBuyerPaymentsAllowed(business.country))) {
    return res.status(409).json({
      message: 'Integrated card payments are not available for your country. Connect your own payment account (BYO) under Payments instead.',
      reason: 'INTEGRATED_PAYMENTS_DISABLED',
      country: normalizeCountry(business.country),
    });
  }
  const mismatch = tenantGatewayMismatch({ provider: 'STRIPE', countryCode: business.country, currency });
  if (mismatch) return res.status(409).json(paymentRouteMismatchResponse(mismatch));

  let account = await prisma.businessPaymentAccount.findUnique({
    where: { businessId_provider: { businessId, provider: 'STRIPE' } },
  });
  if (!account) {
    const created = await stripe.createConnectedAccount({
      businessEmail: business.email || `noreply@${business.slug}.sitepresso.com`,
      businessName: business.name,
      country: business.country,
    });
    if (!created.ok) return res.status(500).json({ message: created.message || 'Stripe error', reason: created.reason });
    account = await prisma.businessPaymentAccount.create({
      data: { businessId, provider: 'STRIPE', accountId: created.accountId, status: 'PENDING' },
    });
  }
  const returnUrl = `${req.headers.origin || `https://${business.slug}.sitepresso.com`}/dashboard?tab=payments`;
  const link = await stripe.createOnboardingLink({ accountId: account.accountId, returnUrl });
  if (!link.ok) return res.status(500).json({ message: link.message });
  res.json({ url: link.url });
}

async function stripeOnboardingStatus(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const account = await prisma.businessPaymentAccount.findUnique({
    where: { businessId_provider: { businessId, provider: 'STRIPE' } },
  });
  if (!account?.accountId) return res.json({ connected: false });
  if (!stripe.isConfigured()) return res.status(503).json({ message: 'Stripe is not configured on the backend.' });

  const fetched = await stripe.fetchConnectedAccount(account.accountId);
  if (!fetched.ok) return res.status(502).json({ message: fetched.message || 'Could not fetch Stripe account status.', reason: fetched.reason });
  if (fetched.status !== account.status) {
    await prisma.businessPaymentAccount.update({ where: { id: account.id }, data: { status: fetched.status } });
  }
  return res.json({
    connected: true,
    accountId: fetched.accountId,
    status: fetched.status,
    chargesEnabled: fetched.chargesEnabled,
    payoutsEnabled: fetched.payoutsEnabled,
    detailsSubmitted: fetched.detailsSubmitted,
    disabledReason: fetched.disabledReason,
    requirements: fetched.requirements,
  });
}

// ─── ADMIN: connect Razorpay via BYO keys (India) ───────────────────────────
// The tenant pastes their own Razorpay Key ID + Key Secret (+ Webhook Secret).
// We validate the keys against Razorpay, then store them ENCRYPTED. We never
// collect KYC/PII — the tenant did that directly with Razorpay.
const razorpayConnectSchema = z.object({
  keyId: z.string().trim().min(8).max(80),
  keySecret: z.string().trim().min(8).max(160),
  webhookSecret: z.string().trim().min(6).max(256).optional(),
});
async function razorpayConnectKeys(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const { business, currency } = await loadPaymentRouteForBusiness(businessId);
  if (!business) return res.status(404).json({ message: 'Business not found' });
  if (!normalizeCountry(business.country)) return res.status(409).json(businessCountryRequiredResponse());
  const mismatch = tenantGatewayMismatch({ provider: 'RAZORPAY', countryCode: business.country, currency });
  if (mismatch) return res.status(409).json(paymentRouteMismatchResponse(mismatch));

  const parsed = razorpayConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ code: 'RAZORPAY_KEYS_REQUIRED', message: 'Enter your Razorpay Key ID and Key Secret.', issues: parsed.error.issues });
  }
  const keyId = parsed.data.keyId.trim();
  const keySecret = parsed.data.keySecret.trim();
  const webhookSecret = parsed.data.webhookSecret?.trim() || null;

  // Validate the keys actually authenticate against Razorpay before saving.
  const valid = await razorpay.validateKeys({ keyId, keySecret });
  if (!valid.ok) {
    return res.status(400).json({ code: 'RAZORPAY_KEYS_INVALID', message: valid.message || 'These Razorpay keys did not authenticate.' });
  }

  const metadata = {
    connectionModel: 'BYO_KEYS',
    keyId,
    keySecretEncrypted: encrypt(keySecret),
    webhookSecretEncrypted: webhookSecret ? encrypt(webhookSecret) : null,
    mode: valid.mode || (keyId.startsWith('rzp_test_') ? 'test' : 'live'),
    connectedAt: new Date().toISOString(),
  };
  const account = await prisma.businessPaymentAccount.upsert({
    where: { businessId_provider: { businessId, provider: 'RAZORPAY' } },
    update: { accountId: keyId, status: 'ACTIVE', platformFeePct: 0, metadata },
    create: { businessId, provider: 'RAZORPAY', accountId: keyId, status: 'ACTIVE', platformFeePct: 0, metadata },
  });
  return res.json({
    ok: true,
    connected: true,
    status: 'ACTIVE',
    keyId,
    mode: metadata.mode,
    webhookConfigured: Boolean(webhookSecret),
    account: publicAccount(account),
  });
}

// ─── ADMIN: Razorpay connection status (BYO) ────────────────────────────────
async function razorpayOnboardingStatus(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const account = await prisma.businessPaymentAccount.findUnique({ where: { businessId_provider: { businessId, provider: 'RAZORPAY' } } });
  if (!account || !isRazorpayByoAccount(account)) return res.json({ connected: false, connectionModel: 'BYO_KEYS' });
  const meta = jsonObject(account.metadata);
  return res.json({
    connected: true,
    connectionModel: 'BYO_KEYS',
    status: account.status,
    keyId: meta.keyId || account.accountId,
    mode: meta.mode || null,
    webhookConfigured: Boolean(meta.webhookSecretEncrypted),
    message: account.status === 'ACTIVE'
      ? 'Your Razorpay account is connected. Buyers pay you directly.'
      : 'Razorpay is connected but not active yet.',
  });
}

// ─── ADMIN: connect Stripe via BYO keys (any non-India country) ─────────────
// The tenant pastes their OWN Stripe publishable + secret keys (+ webhook
// secret). We validate the secret key against Stripe, then store it ENCRYPTED.
// Funds settle to the tenant; Sitepresso is never in the flow and carries no
// liability — the BYO alternative to Stripe Connect.
const stripeConnectSchema = z.object({
  publishableKey: z.string().trim().min(8).max(255),
  secretKey: z.string().trim().min(8).max(255),
  // REQUIRED for Stripe BYO: the webhook is the ONLY way a Stripe order becomes
  // PAID (there is no signed client-success callback like Razorpay's), so without
  // a webhook secret a buyer could be charged with the order never confirmed.
  webhookSecret: z.string().trim().min(6).max(255),
});
async function stripeConnectKeys(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const { business, currency } = await loadPaymentRouteForBusiness(businessId);
  if (!business) return res.status(404).json({ message: 'Business not found' });
  if (!normalizeCountry(business.country)) return res.status(409).json(businessCountryRequiredResponse());
  const mismatch = tenantGatewayMismatch({ provider: 'STRIPE', countryCode: business.country, currency });
  if (mismatch) return res.status(409).json(paymentRouteMismatchResponse(mismatch));

  const parsed = stripeConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ code: 'STRIPE_KEYS_REQUIRED', message: 'Enter your Stripe publishable key, secret key, and webhook signing secret.', issues: parsed.error.issues });
  }
  const publishableKey = parsed.data.publishableKey.trim();
  const secretKey = parsed.data.secretKey.trim();
  const webhookSecret = parsed.data.webhookSecret?.trim() || null;
  if (!/^pk_(test|live)_/.test(publishableKey)) {
    return res.status(400).json({ code: 'STRIPE_KEYS_INVALID', message: 'The publishable key should start with pk_test_ or pk_live_.' });
  }

  const valid = await stripe.validateSecretKey(secretKey);
  if (!valid.ok) {
    return res.status(400).json({ code: 'STRIPE_KEYS_INVALID', message: valid.message || 'These Stripe keys did not authenticate.' });
  }
  // Publishable + secret must be the same mode (both test or both live).
  const pkMode = publishableKey.startsWith('pk_live_') ? 'live' : 'test';
  if (pkMode !== valid.mode) {
    return res.status(400).json({ code: 'STRIPE_KEYS_MODE_MISMATCH', message: 'Your publishable and secret keys are different modes (test vs live). Use a matching pair.' });
  }

  const metadata = {
    connectionModel: 'BYO_KEYS',
    publishableKey,
    secretKeyEncrypted: encrypt(secretKey),
    webhookSecretEncrypted: webhookSecret ? encrypt(webhookSecret) : null,
    mode: valid.mode,
    connectedAt: new Date().toISOString(),
  };
  const account = await prisma.businessPaymentAccount.upsert({
    where: { businessId_provider: { businessId, provider: 'STRIPE' } },
    update: { accountId: publishableKey, status: 'ACTIVE', platformFeePct: 0, metadata },
    create: { businessId, provider: 'STRIPE', accountId: publishableKey, status: 'ACTIVE', platformFeePct: 0, metadata },
  });
  return res.json({
    ok: true,
    connected: true,
    status: 'ACTIVE',
    publishableKey,
    mode: valid.mode,
    webhookConfigured: Boolean(webhookSecret),
    account: publicAccount(account),
  });
}

// ─── PUBLIC: storefront checkout creates a payment-provider order ────────────
const paymentOrderSchema = z.object({
  orderId: z.string().min(1),
});

async function createPaymentOrder(req, res) {
  const parsed = paymentOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });

  const order = await prisma.order.findUnique({
    where: { id: parsed.data.orderId },
    include: { business: true, location: true },
  });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (order.status !== 'PENDING') return res.status(400).json({ message: `Order is ${order.status}` });
  if (order.paymentMethod !== 'online') {
    return res.status(409).json({ message: 'This order is not marked for online payment', reason: 'PAYMENT_METHOD_NOT_ONLINE' });
  }
  if (order.business?.paymentMode === 'COD_ONLY') {
    return res.status(409).json({ message: 'Online payment is disabled for this store', reason: 'ONLINE_DISABLED' });
  }

  // Pick provider from tenant country first: India → Razorpay (BYO), all other
  // countries → Stripe Connect. In multi-location grocery stores the selected
  // fulfilment location country wins over the tenant signup country.
  const routeCountry = normalizeCountry(order.location?.country)
    || normalizeCountry(order.shippingAddress?.country)
    || normalizeCountry(order.business?.country);
  const provider = resolveTenantPaymentGateway({ countryCode: routeCountry, currency: order.currency });
  const currencyBlock = tenantGatewayCurrencyBlock({ provider, currency: order.currency });
  if (currencyBlock) return res.status(409).json(currencyBlock);
  const account = await prisma.businessPaymentAccount.findUnique({
    where: { businessId_provider: { businessId: order.businessId, provider } },
  });
  if (!account || account.status !== 'ACTIVE') {
    return res.status(409).json({ message: `Seller hasn't connected ${provider} yet`, reason: 'PROVIDER_NOT_READY' });
  }

  // Dispatch via the common buyer-gateway interface — each provider's adapter
  // creates the order on the right account (BYO tenant key / Razorpay / Stripe
  // Connect) and returns a uniform { paymentRef, checkout } shape. Adding a new
  // gateway = one new adapter, no branching here.
  const gateway = getBuyerGateway(provider);
  if (!gateway) {
    return res.status(409).json({ message: `Unsupported payment provider ${provider}`, reason: 'PROVIDER_NOT_READY' });
  }
  const result = await gateway.createOrder({ account, order });
  if (!result.ok) return res.status(result.status || 502).json(result.body);
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentProvider: provider, paymentRef: result.paymentRef },
  });
  return res.json(result.checkout);
}

// ─── PUBLIC: Razorpay buyer-success handler (after their JS checkout closes) ──
const razorpaySuccessSchema = z.object({
  razorpay_order_id:    z.string().min(1),
  razorpay_payment_id:  z.string().min(1),
  razorpay_signature:   z.string().min(1),
  orderId:              z.string().min(1),
});
async function razorpayCheckoutSuccess(req, res) {
  const parsed = razorpaySuccessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });

  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (order.paymentMethod !== 'online') {
    return res.status(409).json({ message: 'This order is not marked for online payment' });
  }

  const account = await prisma.businessPaymentAccount.findUnique({
    where: { businessId_provider: { businessId: order.businessId, provider: 'RAZORPAY' } },
  });
  if (!account || !isRazorpayByoAccount(account)) {
    return res.status(409).json({ message: 'Seller Razorpay account is not connected' });
  }
  // The order was created on the tenant's account, so Razorpay Checkout signed
  // the response with the TENANT's key secret. Verify against that.
  const keys = getRazorpayByoKeys(account);
  const ok = razorpay.verifyPaymentSignatureWithSecret({
    orderId: parsed.data.razorpay_order_id,
    paymentId: parsed.data.razorpay_payment_id,
    signature: parsed.data.razorpay_signature,
    secret: keys.keySecret,
  });
  if (!ok) return res.status(400).json({ message: 'Invalid signature' });

  // Bind the signed Razorpay order to THIS local order — a (valid) signature for
  // a different, e.g. cheaper, order must not be able to confirm this one.
  if (order.paymentRef && order.paymentRef !== parsed.data.razorpay_order_id) {
    return res.status(409).json({ message: 'Payment does not match this order', reason: 'ORDER_PAYMENT_MISMATCH' });
  }

  // Status-guarded so a replay can neither re-fire side-effects nor relax a
  // CANCELLED/REFUNDED order back to PAID. Store the PAYMENT id (for refunds).
  const updated = await prisma.order.updateMany({
    where: { id: order.id, status: 'PENDING', paymentMethod: 'online' },
    data: { status: 'PAID', paymentRef: parsed.data.razorpay_payment_id, paidAt: new Date() },
  });
  if (updated.count === 0) return res.json({ ok: true, alreadyProcessed: true });

  clearCartOnPaidOrder(order.id).catch((e) => console.error('[razorpay-success] cart clear', e?.message));
  confirmSlotBookingForOrder(order.id).catch((e) => console.error('[razorpay-success] slot confirm', e?.message));
  grantOnPaidOrder(order.id).catch((e) => console.error('[razorpay-success] loyalty grant', e?.message));
  emitOrderPaid(order.id);
  res.json({ ok: true });
}

// ─── WEBHOOKS (public, signature-verified) ──────────────────────────────────
// BYO: each tenant configures a webhook on THEIR Razorpay account pointing here,
// with their own secret. We parse the (unverified) body to learn which order/
// tenant it is for, then verify the HMAC against THAT tenant's stored webhook
// secret before acting. An attacker without the tenant's secret cannot forge it.
// Doctor v2 — start an online consult-fee payment for an appointment. The
// patient hits this after booking (or from a payment link); the webhook below
// marks the appointment PAID + CONFIRMED on capture. India / Razorpay path.
async function createAppointmentOrder(req, res) {
  const appointmentId = req.params.appointmentId || req.body?.appointmentId;
  if (!appointmentId) return res.status(400).json({ message: 'appointmentId required' });
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      service: { select: { price: true } },
      staff: { select: { consultationFee: true } },
    },
  });
  if (!appt) return res.status(404).json({ message: 'Appointment not found' });
  // Only the patient who owns the appointment may start its payment.
  const owns = (req.customer?.id && appt.customerId === req.customer.id)
    || (req.user?.id && appt.userId === req.user.id);
  if (!owns) return res.status(403).json({ message: 'Not your appointment' });
  if (appt.paymentStatus === 'PAID') return res.status(400).json({ message: 'Already paid' });

  const account = await prisma.businessPaymentAccount.findUnique({
    where: { businessId_provider: { businessId: appt.businessId, provider: 'RAZORPAY' } },
  });
  const keys = account && isRazorpayByoAccount(account) ? getRazorpayByoKeys(account) : null;
  if (!keys?.keyId || !keys?.keySecret) {
    return res.status(503).json({ message: 'Online payment is not set up for this clinic' });
  }

  const amount = appt.finalPrice ?? appt.service?.price ?? appt.staff?.consultationFee ?? 0;
  const amountMinor = Math.round(Number(amount) * 100);
  if (!amountMinor) return res.status(400).json({ message: 'No fee is set for this visit' });

  const order = await razorpay.createOrderWithKeys({
    keyId: keys.keyId, keySecret: keys.keySecret,
    amountMinor, currency: 'INR',
    receipt: `appt_${appt.id}`,
    notes: { appointmentId: appt.id, type: 'APPOINTMENT', businessId: appt.businessId },
  });
  if (!order.ok) return res.status(502).json({ message: 'Could not start payment', reason: order.reason });

  await prisma.appointment.update({
    where: { id: appt.id },
    data: { gatewayOrderId: order.orderId, paymentGateway: 'RAZORPAY' },
  });
  return res.json({
    keyId: keys.keyId, orderId: order.orderId,
    amount: order.amount, currency: order.currency, appointmentId: appt.id,
  });
}

async function razorpayWebhook(req, res) {
  // express.raw() must mount this route so req.body is a Buffer.
  const body = req.body?.toString?.() || '';
  const sig = req.headers['x-razorpay-signature'];
  let parsed;
  try { parsed = JSON.parse(body); } catch { return res.status(400).send('Invalid JSON'); }

  if (parsed.event !== 'payment.captured') return res.send('OK');
  const entity = parsed.payload?.payment?.entity || {};
  const orderId = entity.notes?.orderId;

  // Doctor v2 — appointment consult-fee payment. Razorpay does NOT copy ORDER
  // notes onto the PAYMENT entity, so we cannot rely on notes.appointmentId here.
  // Match by the Razorpay order id we persisted at order-create
  // (Appointment.gatewayOrderId). ecom orders carry notes.orderId, so they fall
  // through to the order branch below — no collision.
  if (!orderId && entity.order_id) {
    const appt = await prisma.appointment.findFirst({
      where: { gatewayOrderId: entity.order_id },
      select: { id: true, businessId: true, finalPrice: true, paymentStatus: true },
    });
    if (appt) {
      const acct = await prisma.businessPaymentAccount.findUnique({
        where: { businessId_provider: { businessId: appt.businessId, provider: 'RAZORPAY' } },
      });
      const k = acct && isRazorpayByoAccount(acct) ? getRazorpayByoKeys(acct) : null;
      if (!k?.webhookSecret || !razorpay.verifyWebhookSignatureWithSecret({ body, signatureHeader: sig, secret: k.webhookSecret })) {
        return res.status(400).send('Invalid signature');
      }
      // The captured payment is bound to this exact Razorpay order, and Razorpay
      // enforces captured-amount == order-amount, so a matching gatewayOrderId +
      // a valid tenant webhook signature is sufficient verification.
      await prisma.appointment.updateMany({
        where: { id: appt.id, paymentStatus: { not: 'PAID' } },
        data: {
          paymentStatus: 'PAID', paymentMethod: 'ONLINE',
          paidAmount: entity.amount ? entity.amount / 100 : appt.finalPrice,
          paymentReference: entity.id || null, paidAt: new Date(), status: 'CONFIRMED',
        },
      });
      return res.send('OK');
    }
  }

  if (!orderId) return res.send('OK');

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, businessId: true, totalMinor: true, currency: true },
  });
  if (!order) return res.send('OK');

  const account = await prisma.businessPaymentAccount.findUnique({
    where: { businessId_provider: { businessId: order.businessId, provider: 'RAZORPAY' } },
  });
  const keys = account && isRazorpayByoAccount(account) ? getRazorpayByoKeys(account) : null;
  if (!keys?.webhookSecret || !razorpay.verifyWebhookSignatureWithSecret({ body, signatureHeader: sig, secret: keys.webhookSecret })) {
    return res.status(400).send('Invalid signature');
  }

  // Confirm only when the captured amount + currency match the order.
  const amountOk = !Number.isFinite(entity.amount) || entity.amount === order.totalMinor;
  const currencyOk = !entity.currency || String(entity.currency).toUpperCase() === String(order.currency || '').toUpperCase();
  if (amountOk && currencyOk) {
    const r = await prisma.order.updateMany({
      where: { id: orderId, status: 'PENDING', paymentMethod: 'online' },
      data: { status: 'PAID', paidAt: new Date(), ...(entity.id ? { paymentRef: entity.id } : {}) },
    });
    if (r.count > 0) {
      clearCartOnPaidOrder(orderId).catch((e) => console.error('[rzp-webhook] cart clear', e?.message));
      confirmSlotBookingForOrder(orderId).catch((e) => console.error('[rzp-webhook] slot confirm', e?.message));
      grantOnPaidOrder(orderId).catch((e) => console.error('[rzp-webhook] loyalty grant', e?.message));
      emitOrderPaid(orderId);
    }
  } else {
    console.error('[rzp-webhook] amount/currency mismatch — not marking PAID', orderId, entity.amount, entity.currency);
  }
  res.send('OK');
}

async function stripeWebhook(req, res) {
  // express.raw() mounts this so req.body is a Buffer. One endpoint serves BOTH
  // BYO tenants (who sign with their OWN endpoint secret) and Connect stores (the
  // platform secret) — so we parse first to learn the order/tenant, then verify
  // against the RIGHT secret before acting.
  const body = req.body?.toString?.() || '';
  const sig = req.headers['stripe-signature'];
  let parsed;
  try { parsed = JSON.parse(body); } catch { return res.status(400).send('Invalid JSON'); }

  if (parsed.type !== 'payment_intent.succeeded') {
    if (!stripe.verifyWebhookSignature({ body, signatureHeader: sig })) return res.status(400).send('Invalid signature');
    return res.send('OK');
  }
  const pi = parsed.data?.object || {};
  const orderId = pi.metadata?.orderId;

  let order = null;
  let verified = false;
  let isByoOrder = false;
  if (orderId) {
    order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, businessId: true, totalMinor: true, currency: true },
    });
    if (order) {
      const acct = await prisma.businessPaymentAccount.findUnique({
        where: { businessId_provider: { businessId: order.businessId, provider: 'STRIPE' } },
      });
      if (acct && isStripeByoAccount(acct)) {
        // A BYO order lives entirely on the tenant's OWN Stripe account — it MUST
        // be verified against the tenant's own webhook secret and NEVER the
        // platform Connect secret (a different account). No fallback: otherwise
        // anyone holding the shared platform secret could forge a paid order.
        isByoOrder = true;
        const keys = getStripeByoKeys(acct);
        verified = keys.webhookSecret
          ? stripe.verifyWebhookSignatureWithSecret({ body, signatureHeader: sig, secret: keys.webhookSecret })
          : false;
      }
    }
  }
  // Platform (Connect) secret applies ONLY to non-BYO orders.
  if (!verified && !isByoOrder) verified = stripe.verifyWebhookSignature({ body, signatureHeader: sig });
  if (!verified) return res.status(400).send('Invalid signature');
  if (!order) return res.send('OK');

  const captured = Number.isFinite(pi.amount_received) ? pi.amount_received : pi.amount;
  const amountOk = !Number.isFinite(captured) || captured === order.totalMinor;
  const currencyOk = !pi.currency || String(pi.currency).toUpperCase() === String(order.currency || '').toUpperCase();
  if (amountOk && currencyOk) {
    const r = await prisma.order.updateMany({
      where: { id: order.id, status: 'PENDING', paymentMethod: 'online' },
      data: { status: 'PAID', paidAt: new Date(), ...(pi.id ? { paymentRef: pi.id } : {}) },
    });
    if (r.count > 0) {
      clearCartOnPaidOrder(order.id).catch((e) => console.error('[stripe-webhook] cart clear', e?.message));
      confirmSlotBookingForOrder(order.id).catch((e) => console.error('[stripe-webhook] slot confirm', e?.message));
      grantOnPaidOrder(order.id).catch((e) => console.error('[stripe-webhook] loyalty grant', e?.message));
      emitOrderPaid(order.id);
    }
  } else {
    console.error('[stripe-webhook] amount/currency mismatch — not marking PAID', order.id, captured, pi.currency);
  }
  res.send('OK');
}

module.exports = {
  listAccounts, connectAccount, disconnectAccount,
  stripeOnboardingLink, stripeOnboardingStatus, stripeConnectKeys,
  razorpayConnectKeys, razorpayOnboardingStatus,
  createPaymentOrder, razorpayCheckoutSuccess,
  razorpayWebhook, stripeWebhook,
  createAppointmentOrder,
};

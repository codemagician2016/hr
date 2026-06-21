// Reseller business-email (Zoho mailbox) endpoints. Provisioning is delegated
// to the mailboxProvisioning service; this controller resolves the business +
// its connected custom domain and returns the Mailbox status.
const prisma = require('../lib/prisma');
const { provisionMailbox } = require('../lib/mailboxProvisioning');
const {
  createPaddleCustomer,
  createPaddleTransaction,
  isPaddleConfigured,
} = require('../lib/paddle');
const { ensureBusinessSubscription } = require('../lib/subscriptionBilling');
const { ensurePaddleBillingProfile } = require('../lib/paddleCustomerProfile');
const { recordCheckoutCreated } = require('../lib/billingLedger');

function businessIdFor(req) {
  return req.user?.businessId;
}

function mailboxBillingMode() {
  const envLabel = String(process.env.ENV_LABEL || process.env.NODE_ENV || '').trim().toLowerCase();
  const billingEnv = ['staging', 'stage', 'prod', 'production'].includes(envLabel);
  const allowUnpaid = String(process.env.MAILBOX_ALLOW_UNPAID_PROVISIONING || '').toLowerCase() === 'true';
  if (isPaddleConfigured()) return 'paddle';
  if (allowUnpaid && !billingEnv) return 'manual';
  return 'blocked';
}

function mailboxPriceIdForCycle(cycle) {
  const normalized = String(cycle || 'MONTHLY').trim().toUpperCase();
  return normalized === 'YEARLY'
    ? String(process.env.PADDLE_MAILBOX_PRICE_ID_ANNUAL || '').trim()
    : String(process.env.PADDLE_MAILBOX_PRICE_ID_MONTHLY || '').trim();
}

function getPlatformBaseUrl(req = null) {
  const explicit = String(process.env.NEXT_PUBLIC_PLATFORM_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const frontendUrl = String(process.env.FRONTEND_URL || '').trim();
  if (frontendUrl) return frontendUrl.replace(/\/$/, '');
  const forwardedHost = String(req?.get?.('X-Forwarded-Host') || req?.get?.('Host') || '').trim();
  if (forwardedHost) {
    const proto = String(req?.get?.('X-Forwarded-Proto') || '').trim() || 'https';
    return `${proto}://${forwardedHost.replace(/\/$/, '')}`;
  }
  const platformDomain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
  return `https://${platformDomain}`;
}

function buildMailboxCheckoutUrl(req, business, transactionId) {
  const base = getPlatformBaseUrl(req);
  const url = new URL(`${base}/billing/checkout`);
  url.searchParams.set('redirect', `/${business.slug}/admin?tab=mailbox&mailbox=success`);
  url.searchParams.set('_ptxn', transactionId);
  return url.toString();
}

function cleanLocalPart(value) {
  return String(value || 'hello').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'hello';
}

function cleanDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.$/, '');
}

function billingNameForBusiness(business) {
  if (business?.billingPurchaserType === 'BUSINESS') {
    return business.billingBusinessName || business.billingContactName || business.name || 'Sitepresso customer';
  }
  return business?.billingContactName || business?.name || 'Sitepresso customer';
}

function extractPaddleCustomerIdFromConflict(err) {
  const directId = String(
    err?.data?.error?.errors?.[0]?.meta?.existing_customer_id
    || err?.data?.meta?.existing_customer_id
    || ''
  ).trim();
  if (directId) return directId;
  const detail = String(err?.data?.error?.errors?.[0]?.detail || err?.message || '');
  const match = detail.match(/\bcustomer of id\s+(ctm_[a-z0-9]+)\b/i);
  return match ? match[1] : null;
}

async function ensureMailboxPaddleCustomer({ business, user }) {
  const subscription = await ensureBusinessSubscription(business.id);
  if (subscription?.paddleCustomerId) return subscription.paddleCustomerId;

  try {
    const customer = await createPaddleCustomer({
      email: business.billingEmail || business.email || user?.email,
      name: billingNameForBusiness(business),
      custom_data: {
        businessId: business.id,
        businessSlug: business.slug,
        businessName: business.name,
        userId: user?.id || null,
        userEmail: user?.email || null,
      },
    });
    const paddleCustomerId = customer?.id || null;
    if (paddleCustomerId) {
      await prisma.subscription.update({
        where: { businessId: business.id },
        data: { paddleCustomerId },
      }).catch(() => null);
    }
    return paddleCustomerId;
  } catch (err) {
    const existingCustomerId = extractPaddleCustomerIdFromConflict(err);
    if (!existingCustomerId) throw err;
    await prisma.subscription.update({
      where: { businessId: business.id },
      data: { paddleCustomerId: existingCustomerId },
    }).catch(() => null);
    return existingCustomerId;
  }
}

async function createMailboxCheckout({ business, user, req, localPart, domain, deliverTo, billingCycle, quantity }) {
  const priceId = mailboxPriceIdForCycle(billingCycle);
  if (!priceId) {
    const err = new Error('Mailbox Paddle price ID is not configured.');
    err.status = 409;
    throw err;
  }

  const address = `${localPart}@${domain}`;
  const paddleCustomerId = await ensureMailboxPaddleCustomer({ business, user });
  const paddleProfile = await ensurePaddleBillingProfile({
    business,
    paddleCustomerId,
    user,
  }).catch(() => ({ addressId: null, businessId: null }));

  const customData = {
    kind: 'mailbox',
    businessId: business.id,
    businessSlug: business.slug,
    businessName: business.name,
    userId: user?.id || null,
    userEmail: user?.email || null,
    mailboxAddress: address,
    localPart,
    domain,
    deliverTo,
    billingCycle,
    quantity,
    expectedPriceId: priceId,
  };

  const transaction = await createPaddleTransaction({
    items: [{ price_id: priceId, quantity }],
    collection_mode: 'automatic',
    customer_id: paddleCustomerId,
    address_id: paddleProfile.addressId || undefined,
    business_id: paddleProfile.businessId || undefined,
    custom_data: customData,
  });

  await recordCheckoutCreated({
    businessId: business.id,
    productKind: 'MAILBOX',
    checkoutKind: 'mailbox_subscription',
    transaction,
    expectedPriceId: priceId,
    metadata: customData,
  }).catch((ledgerErr) => {
    console.error('[mailbox.checkout] billing ledger checkout write failed', ledgerErr?.message || ledgerErr);
  });

  await prisma.mailbox.upsert({
    where: { businessId_address: { businessId: business.id, address } },
    create: {
      businessId: business.id,
      address,
      domain,
      status: 'PENDING',
      statusMessage: 'Payment pending. Mailbox provisioning starts after checkout completes.',
      deliveredTo: deliverTo,
      billingStatus: 'PENDING',
      billingCycle,
      billingQuantity: quantity,
      paddleCustomerId,
      paddleTransactionId: transaction?.id || null,
    },
    update: {
      domain,
      status: 'PENDING',
      statusMessage: 'Payment pending. Mailbox provisioning starts after checkout completes.',
      deliveredTo: deliverTo,
      billingStatus: 'PENDING',
      billingCycle,
      billingQuantity: quantity,
      paddleCustomerId,
      paddleTransactionId: transaction?.id || null,
    },
  });

  return {
    action: 'checkout',
    checkoutUrl: buildMailboxCheckoutUrl(req, business, transaction?.id || ''),
    transactionId: transaction?.id || null,
    message: `Continue to secure checkout to create ${address}.`,
  };
}

// POST /api/business/mailbox/provision  { localPart?, domain?, deliverTo? }
async function provision(req, res) {
  try {
    const businessId = businessIdFor(req);
    if (!businessId) return res.status(400).json({ message: 'No business in context.' });

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        slug: true,
        name: true,
        email: true,
        country: true,
        billingPurchaserType: true,
        billingBusinessName: true,
        billingContactName: true,
        billingEmail: true,
        billingTaxId: true,
        billingAddressLine1: true,
        billingAddressLine2: true,
        billingCity: true,
        billingState: true,
        billingPostalCode: true,
        billingCountry: true,
        paddleBillingAddressId: true,
        paddleBillingBusinessId: true,
        subscription: { select: { customDomain: true, customDomainStatus: true } },
      },
    });
    if (!business) return res.status(404).json({ message: 'Business not found.' });

    const localPart = cleanLocalPart(req.body?.localPart);
    const domain = cleanDomain(req.body?.domain || business.subscription?.customDomain || '');
    const deliverTo = String(req.body?.deliverTo || business.email || '').trim();
    const billingCycle = String(req.body?.billingCycle || 'MONTHLY').trim().toUpperCase() === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    const quantity = Math.max(1, Math.min(100, Number.parseInt(req.body?.quantity || 1, 10) || 1));

    if (!domain) {
      return res.status(422).json({ message: 'A connected custom domain is required before creating a business mailbox.' });
    }

    const billingMode = mailboxBillingMode();
    if (billingMode === 'blocked') {
      return res.status(503).json({
        message: 'Mailbox checkout is unavailable until Paddle is configured. No mailbox will be provisioned without payment confirmation.',
      });
    }

    if (billingMode === 'paddle') {
      const checkout = await createMailboxCheckout({
        business,
        user: req.user,
        req,
        localPart,
        domain,
        deliverTo,
        billingCycle,
        quantity,
      });
      return res.status(202).json(checkout);
    }

    const mailbox = await provisionMailbox({ businessId, localPart, domain, deliverTo, businessName: business.name });
    return res.status(201).json({ mailbox });
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message || 'Could not create the mailbox.' });
  }
}

// GET /api/business/mailbox  -> { mailboxes: [...] }
async function list(req, res) {
  const businessId = businessIdFor(req);
  if (!businessId) return res.status(400).json({ message: 'No business in context.' });
  const mailboxes = await prisma.mailbox.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      address: true,
      domain: true,
      status: true,
      statusMessage: true,
      dnsManaged: true,
      deliveredTo: true,
      credentialsSentAt: true,
      billingStatus: true,
      billingCycle: true,
      billingQuantity: true,
      paddleSubscriptionId: true,
      createdAt: true,
    },
  });
  return res.json({ mailboxes });
}

module.exports = { provision, list };

// Customer-facing notification config endpoints. Mounted under
// /api/notification-config (BUSINESS_ADMIN scope). Customer can:
//   - View their NotificationConfig + slot counts (live)
//   - Toggle per-event channels
//   - Request access to managed channels (creates a PENDING request)
//   - Accept SMS terms-of-use
//   - Pick quotaExhaustedAction policy
'use strict';

const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { computeSlotCounts, getCurrentCycle } = require('../lib/notifications/budgetEngine');
const { listTemplates } = require('../lib/notifications/templates');
const {
  createPaddleCustomer,
  createPaddleTransaction,
  isPaddleConfigured,
} = require('../lib/paddle');
const { recordCheckoutCreated } = require('../lib/billingLedger');
const { ensureBusinessSubscription } = require('../lib/subscriptionBilling');
const { ensurePaddleBillingProfile } = require('../lib/paddleCustomerProfile');

const prisma = new PrismaClient();

// Resolve the businessId from the authed user (BUSINESS_ADMIN owns one business).
async function resolveBusinessId(req) {
  if (req.user?.businessId) return req.user.businessId;
  // Fallback: lookup via user's owned business (if relationship exists).
  return null;
}

// =============================================================================
// GET /api/notification-config
// Returns config + live slot counts for the current cycle.
// =============================================================================
async function getMyConfig(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, country: true, vertical: true, slug: true, name: true },
    });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    let config = await prisma.notificationConfig.findUnique({
      where: { businessId },
    });
    // Lazy-create on first read so customer always has a row to render.
    if (!config) {
      config = await prisma.notificationConfig.create({ data: { businessId } });
    } else if (config.quotaExhaustedAction === 'AUTOBUY_5') {
      config = await prisma.notificationConfig.update({
        where: { businessId },
        data: { quotaExhaustedAction: 'PAUSE' },
      });
    }

    const cycle = getCurrentCycle();
    const usage = await prisma.budgetUsage.findUnique({
      where: { businessId_cycle: { businessId, cycle } },
    });
    const slotCounts = await computeSlotCounts(businessId, business.country || 'US').catch(() => null);

    // Templates available for this vertical (so customer can map events → channels)
    const templates = listTemplates({ vertical: business.vertical });

    res.json({
      business,
      config,
      cycle,
      usage,
      slotCounts,
      templates: templates.map((t) => ({
        key: t.key,
        displayName: t.displayName,
        category: t.category,
        channels: t.channels,
      })),
    });
  } catch (err) {
    console.error('[notificationConfig.getMyConfig]', err);
    res.status(500).json({ message: 'Failed to load notification config' });
  }
}

// =============================================================================
// PUT /api/notification-config/event-channels
// Update per-event channel preferences (the grid).
// =============================================================================
const eventChannelsSchema = z.object({
  eventChannels: z.record(
    z.string(),
    z.object({
      sms: z.boolean().optional(),
      whatsapp: z.boolean().optional(),
      email: z.boolean().optional(),
    }),
  ),
});

async function updateEventChannels(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const parsed = eventChannelsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid input', issues: parsed.error.issues });

    const updated = await prisma.notificationConfig.upsert({
      where: { businessId },
      update: { eventChannels: parsed.data.eventChannels },
      create: { businessId, eventChannels: parsed.data.eventChannels },
    });
    res.json(updated);
  } catch (err) {
    console.error('[notificationConfig.updateEventChannels]', err);
    res.status(500).json({ message: 'Failed to update event channels' });
  }
}

// =============================================================================
// POST /api/notification-config/request-access
// Customer requests access to managed channels.
// =============================================================================
const requestSchema = z.object({
  note: z.string().min(10).max(500),
});

async function requestAccess(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Tell us briefly how you plan to use SMS/WA (10-500 chars)', issues: parsed.error.issues });

    const updated = await prisma.notificationConfig.upsert({
      where: { businessId },
      update: {
        requestAccessStatus: 'PENDING',
        requestAccessNote: parsed.data.note,
        requestAccessAt: new Date(),
        requestReviewedAt: null,
        requestReviewedBy: null,
      },
      create: {
        businessId,
        requestAccessStatus: 'PENDING',
        requestAccessNote: parsed.data.note,
        requestAccessAt: new Date(),
      },
    });
    res.json(updated);
  } catch (err) {
    console.error('[notificationConfig.requestAccess]', err);
    res.status(500).json({ message: 'Failed to submit request' });
  }
}

// =============================================================================
// PUT /api/notification-config/quota-action
// Update what happens when budget hits 100%.
// =============================================================================
const quotaSchema = z.object({
  quotaExhaustedAction: z.enum(['PAUSE', 'STOP']),
});

async function updateQuotaAction(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const parsed = quotaSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid action', issues: parsed.error.issues });

    const updated = await prisma.notificationConfig.upsert({
      where: { businessId },
      update: { quotaExhaustedAction: parsed.data.quotaExhaustedAction },
      create: { businessId, quotaExhaustedAction: parsed.data.quotaExhaustedAction },
    });
    res.json(updated);
  } catch (err) {
    console.error('[notificationConfig.updateQuotaAction]', err);
    res.status(500).json({ message: 'Failed to update quota policy' });
  }
}

// =============================================================================
// POST /api/notification-config/buy-pack
// Buy an overage pack ($5 / $20 / $50) for the current cycle.
// =============================================================================
const packSchema = z.object({
  amountUsd: z.union([z.literal(5), z.literal(20), z.literal(50)]),
});

const PACK_AMOUNTS = new Set([5, 20, 50]);

function topupPriceIdForAmount(amountUsd) {
  const exact = String(process.env[`PADDLE_SMS_TOPUP_PRICE_ID_${amountUsd}`] || '').trim();
  if (exact) return { priceId: exact, quantity: 1 };

  // Optional generic $1 SMS-credit price. Quantity is the selected USD pack.
  const unitPriceId = String(process.env.PADDLE_SMS_TOPUP_UNIT_PRICE_ID || '').trim()
    || String(process.env.PADDLE_SMS_TOPUP_PRICE_ID || '').trim();
  if (unitPriceId) return { priceId: unitPriceId, quantity: amountUsd };

  return null;
}

function topupItemForAmount(amountUsd) {
  const amountMinor = amountUsd * 100;
  const configuredPrice = topupPriceIdForAmount(amountUsd);
  if (configuredPrice) {
    return {
      item: {
        price_id: configuredPrice.priceId,
        quantity: configuredPrice.quantity,
      },
      expectedPriceId: configuredPrice.priceId,
      expectedAmountMinor: amountMinor,
    };
  }

  return {
    item: {
      quantity: 1,
      price: {
        description: `Sitepresso SMS top-up ${amountUsd} USD`,
        name: `$${amountUsd} SMS credit`,
        billing_cycle: null,
        trial_period: null,
        unit_price: {
          amount: String(amountMinor),
          currency_code: 'USD',
        },
        product: {
          name: 'Sitepresso messaging top-up',
          tax_category: 'standard',
          description: 'One-time managed messaging budget for SMS and WhatsApp notifications.',
        },
        custom_data: {
          productKind: 'SMS',
          checkoutKind: 'sms_topup',
          amountUsd,
        },
      },
    },
    expectedPriceId: null,
    expectedAmountMinor: amountMinor,
  };
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

function buildTopupCheckoutUrl(req, business, transactionId) {
  const base = getPlatformBaseUrl(req);
  const url = new URL(`${base}/billing/checkout`);
  url.searchParams.set('redirect', `/${business.slug}/admin?tab=notifications&topup=success`);
  url.searchParams.set('_ptxn', transactionId);
  return url.toString();
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

async function ensureTopupPaddleCustomer({ business, user }) {
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

async function buyPack(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const parsed = packSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Pack must be $5, $20, or $50', issues: parsed.error.issues });

    if (!isPaddleConfigured()) {
      return res.status(503).json({
        ok: false,
        code: 'PADDLE_NOT_CONFIGURED',
        message: 'SMS top-up checkout is not available because Paddle is not configured.',
      });
    }

    const amountUsd = parsed.data.amountUsd;
    if (!PACK_AMOUNTS.has(amountUsd)) {
      return res.status(400).json({ message: 'Pack must be $5, $20, or $50' });
    }

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
      },
    });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const cycle = getCurrentCycle();
    const { item, expectedPriceId, expectedAmountMinor } = topupItemForAmount(amountUsd);
    const paddleCustomerId = await ensureTopupPaddleCustomer({ business, user: req.user });
    const paddleProfile = await ensurePaddleBillingProfile({
      business,
      paddleCustomerId,
      user: req.user,
    }).catch(() => ({ addressId: null, businessId: null }));

    const customData = {
      kind: 'sms',
      productKind: 'SMS',
      checkoutKind: 'sms_topup',
      businessId: business.id,
      businessSlug: business.slug,
      businessName: business.name,
      userId: req.user?.id || null,
      userEmail: req.user?.email || null,
      cycle,
      amountUsd,
      expectedPriceId,
      expectedCurrencyCode: 'USD',
      expectedAmountMinor,
      grantRequiresWebhook: true,
    };

    const transaction = await createPaddleTransaction({
      items: [item],
      collection_mode: 'automatic',
      customer_id: paddleCustomerId,
      address_id: paddleProfile.addressId || undefined,
      business_id: paddleProfile.businessId || undefined,
      custom_data: customData,
    });

    await recordCheckoutCreated({
      businessId,
      productKind: 'SMS',
      checkoutKind: 'sms_topup',
      transaction,
      expectedPriceId,
      expectedCurrencyCode: 'USD',
      expectedAmountMinor,
      metadata: customData,
    }).catch((ledgerErr) => {
      console.error('[notificationConfig.buyPack] billing ledger checkout write failed', ledgerErr?.message || ledgerErr);
    });

    return res.status(202).json({
      action: 'checkout',
      checkoutUrl: buildTopupCheckoutUrl(req, business, transaction?.id || ''),
      transactionId: transaction?.id || null,
      amountUsd,
      cycle,
      message: `Continue to secure checkout to add $${amountUsd} SMS credit.`,
    });
  } catch (err) {
    console.error('[notificationConfig.buyPack]', err);
    res.status(err.status || 500).json({ message: err.message || 'Failed to purchase pack' });
  }
}

// =============================================================================
// POST /api/notification-config/accept-sms-terms
// Click-through SMS terms acceptance (required before managed SMS activates).
// =============================================================================
const termsSchema = z.object({
  version: z.string().min(1).max(50),
});

async function acceptSmsTerms(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const parsed = termsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid terms version' });

    const updated = await prisma.notificationConfig.upsert({
      where: { businessId },
      update: {
        smsTermsAcceptedAt: new Date(),
        smsTermsVersion: parsed.data.version,
      },
      create: {
        businessId,
        smsTermsAcceptedAt: new Date(),
        smsTermsVersion: parsed.data.version,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error('[notificationConfig.acceptSmsTerms]', err);
    res.status(500).json({ message: 'Failed to record terms acceptance' });
  }
}

module.exports = {
  getMyConfig,
  updateEventChannels,
  requestAccess,
  updateQuotaAction,
  buyPack,
  acceptSmsTerms,
};

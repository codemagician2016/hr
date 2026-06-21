// Marketing automation endpoints — customer-facing (BUSINESS_ADMIN scope).
//   GET  /api/marketing-automation                     — list campaigns + tenant config + 30-day stats
//   PUT  /api/marketing-automation/:campaignKey        — toggle / customize a campaign
//   POST /api/marketing-automation/:campaignKey/test   — send a test to admin's email
'use strict';

const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { CAMPAIGNS, getCampaign, renderCampaign } = require('../lib/marketing/campaigns');

const prisma = new PrismaClient();

async function resolveBusinessId(req) {
  return req.user?.businessId || null;
}

// =============================================================================
// GET /api/marketing-automation
// =============================================================================
async function listAll(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const existing = await prisma.automationCampaign.findMany({ where: { businessId } });
    const byKey = Object.fromEntries(existing.map((c) => [c.campaignKey, c]));

    // For every registered campaign, return the tenant's config (or default).
    const campaigns = CAMPAIGNS.map((def) => {
      const row = byKey[def.key] || null;
      return {
        key: def.key,
        displayName: def.displayName,
        description: def.description,
        isEnabled: row?.isEnabled ?? false,
        channels: row?.channels ?? def.defaultChannels,
        customSubject: row?.customSubject ?? null,
        customBody: row?.customBody ?? null,
        customCouponCode: row?.customCouponCode ?? null,
        defaultSubject: def.defaultSubject,
        defaultBody: def.defaultBody,
        suggestedCoupon: !!def.suggestedCoupon,
        delayHours: row?.delayHoursOverride ?? def.delayHours,
        defaultDelayHours: def.delayHours,
        frequencyCap: def.frequencyCap,
        variables: def.variables,
      };
    });

    // 30-day engagement stats per campaign.
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    const stats = await prisma.automationEnrollment.groupBy({
      by: ['campaignId', 'status'],
      where: { businessId, createdAt: { gte: since } },
      _count: { _all: true },
    });
    const statsByKey = {};
    for (const c of existing) {
      statsByKey[c.campaignKey] = { sent: 0, suppressed: 0, failed: 0, pending: 0 };
    }
    for (const s of stats) {
      const camp = existing.find((c) => c.id === s.campaignId);
      if (!camp) continue;
      const bucket = statsByKey[camp.campaignKey] || (statsByKey[camp.campaignKey] = { sent: 0, suppressed: 0, failed: 0, pending: 0 });
      const k = String(s.status).toLowerCase();
      if (k in bucket) bucket[k] = s._count._all;
    }

    res.json({ campaigns, stats: statsByKey });
  } catch (err) {
    console.error('[marketingAutomation.listAll]', err);
    res.status(500).json({ message: 'Failed to load campaigns' });
  }
}

// =============================================================================
// PUT /api/marketing-automation/:campaignKey
// =============================================================================
const updateSchema = z.object({
  isEnabled: z.boolean().optional(),
  channels: z.object({
    email: z.boolean().optional(),
    sms: z.boolean().optional(),
    whatsapp: z.boolean().optional(),
  }).optional(),
  customSubject: z.union([z.string().max(200), z.null()]).optional(),
  customBody: z.union([z.string().max(5000), z.null()]).optional(),
  customCouponCode: z.union([z.string().max(50), z.null()]).optional(),
  delayHoursOverride: z.union([z.number().int().min(0).max(24 * 30), z.null()]).optional(),
});

async function update(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const { campaignKey } = req.params;
    if (!getCampaign(campaignKey)) return res.status(404).json({ message: 'Unknown campaign' });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid input', issues: parsed.error.issues });

    const data = { ...parsed.data };
    // Sanitise to undefined so the upsert doesn't try to set fields not provided.
    Object.keys(data).forEach((k) => { if (data[k] === undefined) delete data[k]; });

    const updated = await prisma.automationCampaign.upsert({
      where: { businessId_campaignKey: { businessId, campaignKey } },
      update: data,
      create: { businessId, campaignKey, ...data },
    });
    res.json(updated);
  } catch (err) {
    console.error('[marketingAutomation.update]', err);
    res.status(500).json({ message: 'Failed to update campaign' });
  }
}

// =============================================================================
// POST /api/marketing-automation/:campaignKey/test
// Send a preview to the admin's email (uses sample data).
// =============================================================================
async function sendTest(req, res) {
  try {
    const businessId = await resolveBusinessId(req);
    if (!businessId) return res.status(403).json({ message: 'No business in scope' });

    const { campaignKey } = req.params;
    const def = getCampaign(campaignKey);
    if (!def) return res.status(404).json({ message: 'Unknown campaign' });

    const camp = await prisma.automationCampaign.findUnique({
      where: { businessId_campaignKey: { businessId, campaignKey } },
    });
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true, slug: true },
    });
    const recipientEmail = req.user?.email;
    if (!recipientEmail) return res.status(400).json({ message: 'No email on user record' });

    const sampleVars = {
      NAME:          'Sarah',
      BIZ:           business?.name || 'Your Business',
      LINK:          `https://${business?.slug || 'demo'}.${process.env.PLATFORM_DOMAIN || 'sitepresso.com'}`,
      REVIEW_LINK:   `https://${business?.slug || 'demo'}.${process.env.PLATFORM_DOMAIN || 'sitepresso.com'}/review`,
      STAFF:         'Dr Singh',
      DATE_OF_VISIT: new Date().toISOString().slice(0, 10),
      VISIT_COUNT:   '10',
      GIFT_LABEL:    'small treat',
      COUPON_LINE:   camp?.customCouponCode ? ` — use code ${camp.customCouponCode} for 15% off` : '',
      COUPON_CODE:   camp?.customCouponCode || '',
      COUPON_PERCENT:'15',
      COUPON_EXPIRY_LINE: '',
    };

    const { subject, body } = renderCampaign({
      campaignKey,
      customSubject: camp?.customSubject,
      customBody: camp?.customBody,
      vars: sampleVars,
    });

    const { sendEmail } = require('../utils/email');
    const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6"><p style="background:#fff3cd;padding:10px;border:1px solid #ffeaa7;border-radius:6px"><strong>Test send</strong> — this is what your customers will see.</p>${body.replace(/\n/g, '<br/>')}</div>`;
    await sendEmail(recipientEmail, `[TEST] ${subject}`, html);

    res.json({ ok: true, sentTo: recipientEmail });
  } catch (err) {
    console.error('[marketingAutomation.sendTest]', err);
    res.status(500).json({ message: 'Failed to send test' });
  }
}

module.exports = {
  listAll,
  update,
  sendTest,
};

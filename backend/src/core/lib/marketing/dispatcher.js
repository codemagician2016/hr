// Send dispatcher — runs every 5 minutes.
//
// 1. Find PENDING AutomationEnrollment rows where scheduledFor <= now
// 2. For each:
//    a. Re-check campaign is still enabled
//    b. Frequency-cap check (caps in lib/marketing/campaigns.js)
//    c. CustomerMarketingOptOut check (per-tenant unsubscribe)
//    d. Channel availability (NotificationConfig from Sprint 1.1)
//    e. Render subject + body
//    f. Call sendNotification() → uses the smart channel router
//    g. Update enrollment status (SENT / FAILED / SUPPRESSED) + messageDeliveryId
//
// Email is the default + always-on channel. SMS / WhatsApp only fire if
// the tenant explicitly opted in via channels JSON on the campaign row.
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { CAMPAIGNS_BY_KEY, renderCampaign } = require('./campaigns');
const { sendNotification } = require('../notifications/router');

// Frequency cap check — has this customer received N+ messages from this
// campaign in the last `perWindowDays`? Returns true if OK to send.
async function withinFrequencyCap({ businessId, campaign, customerId, recipientEmail }) {
  const def = CAMPAIGNS_BY_KEY[campaign.campaignKey];
  if (!def?.frequencyCap) return true;
  const { perWindowDays, maxSendsInWindow } = def.frequencyCap;
  if (!maxSendsInWindow) return true;

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - perWindowDays);

  const recentSends = await prisma.automationEnrollment.count({
    where: {
      businessId,
      campaignId: campaign.id,
      status: 'SENT',
      sentAt: { gte: since },
      ...(customerId
        ? { customerId }
        : { recipientEmail }),
    },
  });
  return recentSends < maxSendsInWindow;
}

// Marketing opt-out check — customer specifically unsubscribed from this
// tenant's marketing (separate from universal SmsOptOut).
async function isMarketingOptedOut({ businessId, customerId, recipientEmail, campaignKey }) {
  // Two queries — one for global tenant opt-out, one for per-campaign opt-out.
  const where = customerId
    ? { businessId, customerId }
    : { businessId, recipientEmail };

  const optouts = await prisma.customerMarketingOptOut.findMany({ where });
  if (!optouts.length) return false;
  // Global opt-out (campaignKey IS NULL) blocks everything.
  if (optouts.some((o) => o.campaignKey == null)) return true;
  // Per-campaign opt-out blocks only that campaign.
  if (optouts.some((o) => o.campaignKey === campaignKey)) return true;
  return false;
}

// Send a single enrollment. Updates the row in-place to SENT/FAILED/SUPPRESSED.
async function dispatchOne(enrollment) {
  const camp = await prisma.automationCampaign.findUnique({
    where: { id: enrollment.campaignId },
  });
  if (!camp || !camp.isEnabled) {
    await prisma.automationEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'SUPPRESSED', failureReason: 'CAMPAIGN_DISABLED' },
    });
    return { result: 'SUPPRESSED', reason: 'CAMPAIGN_DISABLED' };
  }

  const def = CAMPAIGNS_BY_KEY[camp.campaignKey];
  if (!def) {
    await prisma.automationEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'FAILED', failureReason: 'UNKNOWN_CAMPAIGN' },
    });
    return { result: 'FAILED', reason: 'UNKNOWN_CAMPAIGN' };
  }

  // Frequency cap
  const ok = await withinFrequencyCap({
    businessId: enrollment.businessId,
    campaign: camp,
    customerId: enrollment.customerId,
    recipientEmail: enrollment.recipientEmail,
  });
  if (!ok) {
    await prisma.automationEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'SUPPRESSED', failureReason: 'FREQUENCY_CAP' },
    });
    return { result: 'SUPPRESSED', reason: 'FREQUENCY_CAP' };
  }

  // Opt-out
  const optedOut = await isMarketingOptedOut({
    businessId: enrollment.businessId,
    customerId: enrollment.customerId,
    recipientEmail: enrollment.recipientEmail,
    campaignKey: camp.campaignKey,
  });
  if (optedOut) {
    await prisma.automationEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'SUPPRESSED', failureReason: 'MARKETING_OPTOUT' },
    });
    return { result: 'SUPPRESSED', reason: 'MARKETING_OPTOUT' };
  }

  // Compose merge-tag context
  const business = await prisma.business.findUnique({
    where: { id: enrollment.businessId },
    select: { id: true, name: true, slug: true, country: true },
  });

  const platformDomain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
  const link = `https://${business?.slug || 'app'}.${platformDomain}`;
  // Coupon line — used by win-back / anniversary campaigns when a coupon
  // has been configured by the tenant.
  let couponLine = '';
  let couponCode = '';
  let couponPercent = '';
  let couponExpiryLine = '';
  if (camp.customCouponCode) {
    couponCode = camp.customCouponCode;
    couponPercent = '15'; // sensible default; tenants can edit body to taste
    couponLine = ` — use code ${couponCode} for ${couponPercent}% off`;
  }

  const baseVars = {
    NAME:      enrollment.recipientName || 'there',
    BIZ:       business?.name || '',
    LINK:      link,
    REVIEW_LINK: `${link}/review`,
    COUPON_LINE: couponLine,
    COUPON_CODE: couponCode,
    COUPON_PERCENT: couponPercent,
    COUPON_EXPIRY_LINE: couponExpiryLine,
    ...(enrollment.variables || {}),
  };

  const { subject, body } = renderCampaign({
    campaignKey: camp.campaignKey,
    customSubject: camp.customSubject,
    customBody: camp.customBody,
    vars: baseVars,
  });

  // Channels: only the ones the tenant explicitly enabled. Email is default-on.
  const channels = camp.channels || { email: true, sms: false, whatsapp: false };

  let sentResult = null;
  let lastError = null;

  // Try each enabled channel — prefer email for marketing (rich content,
  // free, opt-out friendly). Fall back to SMS / WA if email fails.
  const order = ['email', 'whatsapp', 'sms'].filter((ch) => channels[ch]);

  for (const channel of order) {
    let recipientPhone = enrollment.recipientPhone;
    let recipientEmail = enrollment.recipientEmail;
    if (channel === 'email' && !recipientEmail) continue;
    if ((channel === 'sms' || channel === 'whatsapp') && !recipientPhone) continue;

    // Marketing campaigns don't use Sprint 1.1 templates (those are
    // transactional). Email path uses the full subject + body directly.
    // For SMS/WA we'd normally also need a DLT-approved promo template —
    // which is Phase 1.1b. So here we only send via email by default.
    if (channel !== 'email') {
      lastError = 'PROMO_TEMPLATES_NOT_YET_APPROVED';
      continue;
    }

    try {
      const { sendEmail } = require('../../utils/email');
      const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6">${
        body.replace(/\n/g, '<br/>')
      }<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/><p style="font-size:11px;color:#888">Don't want these? <a href="${link}/unsubscribe?e=${encodeURIComponent(recipientEmail)}&c=${camp.campaignKey}&b=${enrollment.businessId}">Unsubscribe</a></p></div>`;
      const result = await sendEmail(recipientEmail, subject, html);
      sentResult = {
        channel: 'email',
        provider: 'SES_EMAIL',
        ok: !!result?.ok,
        providerMessageId: result?.messageId || null,
        message: result?.message || null,
      };
      if (sentResult.ok) break;
      lastError = sentResult.message || 'email_failed';
    } catch (err) {
      lastError = err.message;
    }
  }

  if (sentResult?.ok) {
    await prisma.automationEnrollment.update({
      where: { id: enrollment.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        variables: baseVars,
      },
    });
    return { result: 'SENT', channel: sentResult.channel };
  }

  await prisma.automationEnrollment.update({
    where: { id: enrollment.id },
    data: { status: 'FAILED', failureReason: lastError || 'NO_VIABLE_CHANNEL' },
  });
  return { result: 'FAILED', reason: lastError || 'NO_VIABLE_CHANNEL' };
}

// Public entry point — process all due enrollments. Limited to N per run
// to avoid hammering email infra. Returns summary stats.
async function dispatchDue({ now = new Date(), limit = 100, logger = console } = {}) {
  const due = await prisma.automationEnrollment.findMany({
    where: {
      status: 'PENDING',
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
  });

  const summary = { processed: 0, sent: 0, suppressed: 0, failed: 0 };

  for (const en of due) {
    try {
      const r = await dispatchOne(en);
      summary.processed++;
      if (r.result === 'SENT') summary.sent++;
      else if (r.result === 'SUPPRESSED') summary.suppressed++;
      else summary.failed++;
    } catch (err) {
      logger.error?.(`[dispatcher] enrollment ${en.id}: ${err.message}`);
      summary.failed++;
    }
  }

  return summary;
}

module.exports = {
  dispatchOne,
  dispatchDue,
  withinFrequencyCap,
  isMarketingOptedOut,
};

// Smart channel router — orchestrates the multi-channel send pipeline.
//
// Call site flow (e.g., a booking is confirmed):
//   sendNotification({
//     businessId, recipientPhone, recipientEmail, recipientCountry,
//     templateKey: 'BOOKING_CONFIRMED',
//     variables: { STAFF, DATE, TIME, LINK, BIZ },
//     triggeredBy: 'BOOKING_CREATED',
//     appointmentId,
//   })
//
// Internal pipeline:
//   1. Look up NotificationConfig (per-business gates + event preferences)
//   2. Detect recipient country if not provided
//   3. Check universal SmsOptOut (TCPA/TRAI compliance)
//   4. Look up MessageTemplate (provider IDs + DLT approval status)
//   5. Build channel cascade per the per-event preferences (eventChannels)
//   6. For each channel, in priority order:
//        a. Confirm gate is enabled (NotificationConfig.managedSmsEnabled etc.)
//        b. Confirm channel is available in recipient country (priceCache)
//        c. Pre-flight budget check (budgetEngine.checkBudget)
//        d. Render template body
//        e. Pick provider via countryRouting
//        f. Call adapter (providers.getAdapter)
//        g. On success: log MessageDelivery + recordSpend; return
//        h. On failure: log + try next channel
//   7. Email is the always-on fallback (no quota, no budget impact)
//
// On final failure: log a MessageDelivery row with status=FAILED and
// the cascade attempted. Never throws — caller should not crash if a
// notification couldn't reach the recipient.
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { detectCountryFromPhone, getRoute, PROVIDERS } = require('./countryRouting');
const { CHANNELS, getCostOrFallback } = require('./priceCache');
const { checkBudget, recordSpend } = require('./budgetEngine');
const { render, getTemplate } = require('./templates');
const { getAdapter } = require('./providers');

// Default channel cascade when a tenant hasn't customised eventChannels.
// Order matters: WhatsApp first (cheaper + better UX in emerging markets),
// then SMS (universal fallback), then Email (always-on safety net).
const DEFAULT_CASCADE = ['whatsapp', 'sms', 'email'];

// Determine the channel cascade for a given event from NotificationConfig.
// Returns ordered array of channel ids ('whatsapp' | 'sms' | 'email').
function buildCascade({ notificationConfig, templateKey }) {
  const prefs = notificationConfig?.eventChannels?.[templateKey];
  if (!prefs) return DEFAULT_CASCADE.slice();
  // prefs is { sms: bool, whatsapp: bool, email: bool }. Walk the default
  // cascade order, keeping only those the customer has enabled.
  const result = DEFAULT_CASCADE.filter((ch) => prefs[ch] === true);
  // Always keep email as last-resort fallback unless customer explicitly disabled.
  if (!result.includes('email') && prefs.email !== false) result.push('email');
  return result;
}

// Map channel id → ProviderPriceCache channel string for cost lookup.
function channelToCacheKey(channel) {
  if (channel === 'sms') return CHANNELS.SMS;
  if (channel === 'whatsapp') return CHANNELS.WHATSAPP_UTILITY;
  return null; // email is free / not cost-tracked
}

// Map channel id → adapter provider key, given country routing.
function pickProvider(channel, countryRoute) {
  if (channel === 'sms') return countryRoute.smsProvider;
  if (channel === 'whatsapp') return countryRoute.waProvider;
  if (channel === 'email') return 'SES_EMAIL';
  return null;
}

// Universal opt-out check. If the recipient phone has STOP'd at any tenant,
// SMS+WhatsApp are blocked across the platform. Email is unaffected.
async function isOptedOut(recipientPhone) {
  if (!recipientPhone) return false;
  const cleaned = String(recipientPhone).replace(/\D/g, '');
  if (!cleaned) return false;
  const row = await prisma.smsOptOut.findUnique({
    where: { recipientPhone: `+${cleaned}` },
  });
  return !!row;
}

// Persist a MessageDelivery row capturing outcome + cost for the audit log.
async function logDelivery({
  businessId,
  recipientPhone,
  recipientEmail,
  recipientCountry,
  channel,
  templateId,
  bodySnapshot,
  variables,
  providerCostUsd,
  provider,
  providerMessageId,
  status,
  failureReason,
  triggeredBy,
  appointmentId,
  orderId,
  sentAt,
}) {
  return prisma.messageDelivery.create({
    data: {
      businessId,
      recipientPhone: recipientPhone || null,
      recipientEmail: recipientEmail || null,
      recipientCountry: recipientCountry || 'XX',
      channel: channel === 'whatsapp' ? 'WHATSAPP' : channel === 'sms' ? 'SMS' : 'EMAIL',
      templateId: templateId || null,
      bodySnapshot: bodySnapshot || '',
      variables: variables || null,
      providerCostUsd: providerCostUsd || 0,
      provider: provider || 'UNKNOWN',
      providerMessageId: providerMessageId || null,
      status,
      failureReason: failureReason || null,
      triggeredBy: triggeredBy || 'UNKNOWN',
      appointmentId: appointmentId || null,
      orderId: orderId || null,
      sentAt: sentAt || null,
    },
  });
}

// =============================================================================
// Public entry point
// =============================================================================

// sendNotification — fire a templated message at a recipient. The router
// picks channel(s) intelligently and never throws.
//
// Returns:
//   {
//     ok: true,
//     channel: 'whatsapp' | 'sms' | 'email',
//     provider: 'TWILIO_WA' | ...,
//     deliveryId: '...',
//     attempts: [...],   // each cascade attempt, including failures
//   }
// or
//   {
//     ok: false,
//     reason: 'NO_VIABLE_CHANNEL' | 'OPTED_OUT' | 'UNKNOWN_TEMPLATE' | 'CONFIG_MISSING',
//     attempts: [...],
//   }
async function sendNotification({
  businessId,
  recipientPhone,
  recipientEmail,
  recipientCountry,
  templateKey,
  variables = {},
  triggeredBy = 'MANUAL',
  appointmentId,
  orderId,
}) {
  const attempts = [];

  // 1. Validate template
  const template = getTemplate(templateKey);
  if (!template) {
    return { ok: false, reason: 'UNKNOWN_TEMPLATE', attempts };
  }

  // 2. Country detection
  const country = (recipientCountry || detectCountryFromPhone(recipientPhone) || 'XX').toUpperCase();
  const route = getRoute(country);

  // 3. Opt-out guard (universal across all tenants). A universal STOP is a PHONE-CHANNEL
  // opt-out (TCPA/TRAI) — it must suppress SMS + WhatsApp but NOT email, which is the
  // always-on fallback. Previously this returned OPTED_OUT immediately, so an approver who
  // had STOP'd their phone got NOTHING (no SMS AND no email). We now log the phone block
  // for the audit trail, drop the phone so the SMS/WhatsApp legs are skipped, and FALL
  // THROUGH so the email leg still fires.
  let phoneOptedOut = false;
  if (recipientPhone && await isOptedOut(recipientPhone)) {
    await logDelivery({
      businessId,
      recipientPhone,
      recipientCountry: country,
      channel: 'sms',
      bodySnapshot: '',
      provider: 'NONE',
      status: 'BLOCKED_OPTOUT',
      triggeredBy,
      appointmentId,
      orderId,
    });
    phoneOptedOut = true;
    // Suppress every phone channel for this send; email remains eligible.
    recipientPhone = null;
  }

  // 4. Load NotificationConfig + DB-side template (for provider IDs)
  const [config, dbTemplate] = await Promise.all([
    prisma.notificationConfig.findUnique({ where: { businessId } }),
    prisma.messageTemplate.findUnique({ where: { templateKey } }),
  ]);

  // 5. Render the body (with merge tags). Surface user errors clearly.
  let body;
  try {
    body = render({ key: templateKey, vars: variables });
  } catch (err) {
    return { ok: false, reason: err.code || 'RENDER_ERROR', attempts: [{ error: err.message }] };
  }

  // 6. Build the channel cascade
  const cascade = buildCascade({ notificationConfig: config, templateKey });

  // 7. Walk the cascade
  for (const channel of cascade) {
    const attempt = { channel };

    // Email is always-on if recipient has email; doesn't need cache/budget.
    if (channel === 'email') {
      if (!recipientEmail) {
        attempt.skipped = 'NO_RECIPIENT_EMAIL';
        attempts.push(attempt);
        continue;
      }
      const adapter = getAdapter('SES_EMAIL');
      const result = await adapter({
        to: recipientEmail,
        body,
        templateContext: {
          displayName: template.displayName,
          emailSubject: template.displayName,
        },
      });
      attempt.result = result;
      attempts.push(attempt);
      const delivery = await logDelivery({
        businessId,
        recipientEmail,
        recipientCountry: country,
        channel: 'email',
        templateId: dbTemplate?.id,
        bodySnapshot: body,
        variables,
        providerCostUsd: 0,
        provider: result.provider || 'SES_EMAIL',
        providerMessageId: result.providerMessageId,
        status: result.ok ? 'SENT' : 'FAILED',
        failureReason: result.ok ? null : (result.message || result.reason),
        triggeredBy,
        appointmentId,
        orderId,
        sentAt: result.ok ? new Date() : null,
      });
      if (result.ok) {
        return { ok: true, channel: 'email', provider: 'SES_EMAIL', deliveryId: delivery.id, attempts };
      }
      continue;
    }

    // SMS / WhatsApp paths share validation
    const isWa = channel === 'whatsapp';
    const isSms = channel === 'sms';

    // 7a0. Phone-channel opt-out (universal STOP) — suppress SMS/WhatsApp but keep walking
    // so the email leg below can still fire. Attributed explicitly for the audit trail.
    if (phoneOptedOut) {
      attempt.skipped = 'PHONE_OPTED_OUT';
      attempts.push(attempt);
      continue;
    }

    // 7a. Gate check
    const gateField = isWa ? 'managedWhatsappEnabled' : 'managedSmsEnabled';
    if (!config?.[gateField]) {
      attempt.skipped = 'GATE_DISABLED';
      attempts.push(attempt);
      continue;
    }

    // 7b. Recipient phone required
    if (!recipientPhone) {
      attempt.skipped = 'NO_RECIPIENT_PHONE';
      attempts.push(attempt);
      continue;
    }

    // 7c. Channel availability in country (via priceCache)
    const cacheKey = channelToCacheKey(channel);
    const cost = await getCostOrFallback(country, cacheKey);
    if (!cost && cost !== 0) {
      attempt.skipped = 'CHANNEL_UNAVAILABLE_IN_COUNTRY';
      attempts.push(attempt);
      continue;
    }

    // 7d. Budget check
    const budget = await checkBudget({ businessId, channel: cacheKey, recipientCountry: country });
    if (!budget.allowed) {
      attempt.skipped = `BUDGET_${budget.reason}`;
      attempts.push(attempt);
      continue;
    }

    // 7e. Template channel support
    if (isSms && !template.channels.sms) {
      attempt.skipped = 'TEMPLATE_DOES_NOT_SUPPORT_SMS';
      attempts.push(attempt);
      continue;
    }
    if (isWa && !template.channels.whatsapp) {
      attempt.skipped = 'TEMPLATE_DOES_NOT_SUPPORT_WHATSAPP';
      attempts.push(attempt);
      continue;
    }

    // 7f. Pick provider + adapter
    const providerKey = pickProvider(channel, route);
    const adapter = getAdapter(providerKey);
    if (!adapter) {
      attempt.skipped = 'ADAPTER_NOT_FOUND';
      attempts.push(attempt);
      continue;
    }

    // 7g. Call provider
    const result = await adapter({
      to: recipientPhone,
      body,
      templateContext: {
        msg91TemplateId: dbTemplate?.msg91TemplateId,
        contentSid: dbTemplate?.twilioContentSid,
        contentVariables: variables,
        variables,
        displayName: template.displayName,
      },
    });
    attempt.result = result;
    attempts.push(attempt);

    // 7h. Log delivery + record spend
    const delivery = await logDelivery({
      businessId,
      recipientPhone,
      recipientCountry: country,
      channel,
      templateId: dbTemplate?.id,
      bodySnapshot: body,
      variables,
      providerCostUsd: result.ok ? cost : 0,
      provider: result.provider || providerKey,
      providerMessageId: result.providerMessageId,
      status: result.ok ? 'SENT' : 'FAILED',
      failureReason: result.ok ? null : (result.message || result.reason),
      triggeredBy,
      appointmentId,
      orderId,
      sentAt: result.ok ? new Date() : null,
    });

    if (result.ok) {
      // Only deduct budget on actual successful send.
      await recordSpend({
        businessId,
        channel: cacheKey,
        costUsd: cost,
      });
      return { ok: true, channel, provider: result.provider || providerKey, deliveryId: delivery.id, attempts };
    }

    // Failure → keep going to next channel
  }

  // No channel succeeded.
  return { ok: false, reason: 'NO_VIABLE_CHANNEL', attempts };
}

module.exports = {
  sendNotification,
  // Exposed for tests
  buildCascade,
  channelToCacheKey,
  pickProvider,
  isOptedOut,
};

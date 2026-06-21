// Webhook receivers for SMS / WhatsApp providers.
//
// Twilio inbound — fires when a recipient replies to a message we sent
// (e.g., "STOP" to opt out, or any reply to a transactional SMS).
// Public endpoint (no auth — Twilio signs the request; we verify the
// X-Twilio-Signature header in production).
//
// Twilio status callback — fires when delivery state changes.
// We update the matching MessageDelivery row.
//
// MSG91 inbound — analogous flow for IN SMS via MSG91. Slightly different
// payload shape but same intent: STOP → opt-out + status callbacks.
'use strict';

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPT-OUT', 'OPTOUT']);

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

// Twilio request signature verification.
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
// Twilio signs `URL + sortedFormParamsConcatenated` with HMAC-SHA1 using your
// auth token. Compare the base64 digest against X-Twilio-Signature.
//
// Behaviour:
//  - TWILIO_AUTH_TOKEN unset → skip only outside production.
//  - TWILIO_AUTH_TOKEN set + signature mismatch → 403.
function verifyTwilioSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return process.env.NODE_ENV !== 'production';
  const signature = req.get('X-Twilio-Signature') || '';
  if (!signature) return false;

  // Reconstruct the URL Twilio signed. With `app.set('trust proxy', 1)` and
  // nginx forwarding, req.protocol/host already reflect the public URL.
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// MSG91 doesn't sign webhooks. We require a shared secret in the
// X-MSG91-Webhook-Secret header (configure the same value in MSG91's
// webhook settings). Skipped only outside production when unset.
function verifyMsg91Secret(req) {
  const secret = process.env.MSG91_WEBHOOK_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const provided = req.get('X-MSG91-Webhook-Secret') || '';
  if (!provided) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  } catch {
    return false;
  }
}

// =============================================================================
// POST /api/notifications/webhook/twilio/inbound
// Twilio inbound message webhook. Body is form-encoded:
//   From, To, Body, MessageSid, ...
// =============================================================================
async function twilioInbound(req, res) {
  try {
    if (!verifyTwilioSignature(req)) {
      return res.status(403).send('Invalid signature');
    }
    const from = normalizePhone(req.body?.From || '');
    const body = String(req.body?.Body || '').trim().toUpperCase();
    if (!from || !body) return res.status(200).send(''); // ignore noise

    if (STOP_WORDS.has(body)) {
      // Universal opt-out across all tenants.
      await prisma.smsOptOut.upsert({
        where: { recipientPhone: from },
        update: { source: 'STOP_REPLY', optedOutAt: new Date() },
        create: { recipientPhone: from, source: 'STOP_REPLY' },
      });
      console.log(`[notifications.webhook] STOP from ${from} — added to global opt-out`);
    }
    res.status(200).send('');
  } catch (err) {
    console.error('[notifications.webhook.twilioInbound]', err);
    res.status(200).send(''); // never fail Twilio's webhook
  }
}

// =============================================================================
// POST /api/notifications/webhook/twilio/status
// Twilio status callback. Body: MessageSid, MessageStatus,
// ErrorCode (optional), To, From.
// =============================================================================
async function twilioStatus(req, res) {
  try {
    if (!verifyTwilioSignature(req)) {
      return res.status(403).send('Invalid signature');
    }
    const sid = req.body?.MessageSid;
    const status = String(req.body?.MessageStatus || '').toLowerCase();
    if (!sid) return res.status(200).send('');

    let dbStatus = null;
    let deliveredAt = null;
    if (['delivered', 'read'].includes(status)) {
      dbStatus = 'DELIVERED';
      deliveredAt = new Date();
    } else if (['undelivered', 'failed'].includes(status)) {
      dbStatus = 'FAILED';
    }

    if (dbStatus) {
      await prisma.messageDelivery.updateMany({
        where: { providerMessageId: sid },
        data: {
          status: dbStatus,
          deliveredAt,
          failureReason: req.body?.ErrorCode ? `Twilio ${req.body.ErrorCode}` : null,
        },
      });
    }
    res.status(200).send('');
  } catch (err) {
    console.error('[notifications.webhook.twilioStatus]', err);
    res.status(200).send('');
  }
}

// =============================================================================
// POST /api/notifications/webhook/msg91/inbound
// MSG91 inbound (DLT compliance). Body shape varies; we accept multiple.
// =============================================================================
async function msg91Inbound(req, res) {
  try {
    if (!verifyMsg91Secret(req)) {
      return res.status(403).send('Invalid secret');
    }
    const from = normalizePhone(req.body?.mobile || req.body?.from || req.body?.From);
    const body = String(req.body?.message || req.body?.text || req.body?.Body || '').trim().toUpperCase();
    if (!from || !body) return res.status(200).send('');

    if (STOP_WORDS.has(body)) {
      await prisma.smsOptOut.upsert({
        where: { recipientPhone: from },
        update: { source: 'STOP_REPLY', optedOutAt: new Date() },
        create: { recipientPhone: from, source: 'STOP_REPLY' },
      });
      console.log(`[notifications.webhook] MSG91 STOP from ${from}`);
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[notifications.webhook.msg91Inbound]', err);
    res.status(200).send('OK');
  }
}

// =============================================================================
// POST /api/notifications/webhook/msg91/status
// MSG91 delivery status callback.
// =============================================================================
async function msg91Status(req, res) {
  try {
    if (!verifyMsg91Secret(req)) {
      return res.status(403).send('Invalid secret');
    }
    const requestId = req.body?.requestId || req.body?.message_id;
    const status = String(req.body?.status || '').toLowerCase();
    if (!requestId) return res.status(200).send('OK');

    let dbStatus = null;
    let deliveredAt = null;
    if (status === 'delivered' || status === 'success') {
      dbStatus = 'DELIVERED';
      deliveredAt = new Date();
    } else if (status === 'failed' || status === 'undelivered') {
      dbStatus = 'FAILED';
    }

    if (dbStatus) {
      await prisma.messageDelivery.updateMany({
        where: { providerMessageId: requestId },
        data: { status: dbStatus, deliveredAt },
      });
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[notifications.webhook.msg91Status]', err);
    res.status(200).send('OK');
  }
}

module.exports = {
  twilioInbound,
  twilioStatus,
  msg91Inbound,
  msg91Status,
  // exposed for tests
  STOP_WORDS,
  normalizePhone,
};

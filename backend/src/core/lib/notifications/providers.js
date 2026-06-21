// Provider adapter layer — thin wrappers over Twilio SMS, Twilio WhatsApp,
// MSG91 SMS, and SES email. Each adapter has the same shape:
//
//   send({ to, body, templateContext }) → { ok, providerMessageId, error }
//
// The smart router calls these. Provider auth (env vars) is the same as the
// pre-existing lib/sms.js — TWILIO_ACCOUNT_SID, MSG91_API_KEY, etc. Nothing
// in this file requires credentials at import time; missing creds just yield
// `{ ok: false, reason: 'NOT_CONFIGURED' }` per call.
'use strict';

// ─── Twilio SMS ──────────────────────────────────────────────────────────────
function isTwilioConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

async function sendViaTwilioSms({ to, body }) {
  if (!isTwilioConfigured()) {
    return { ok: false, reason: 'NOT_CONFIGURED', provider: 'TWILIO_SMS' };
  }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({
      From: process.env.TWILIO_FROM_NUMBER,
      To: String(to),
      Body: body,
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: 'PROVIDER_ERROR', provider: 'TWILIO_SMS', message: data.message || `HTTP ${res.status}` };
    }
    return { ok: true, provider: 'TWILIO_SMS', providerMessageId: data.sid || null };
  } catch (err) {
    return { ok: false, reason: 'NETWORK_ERROR', provider: 'TWILIO_SMS', message: err.message };
  }
}

// ─── Twilio WhatsApp Business ────────────────────────────────────────────────
function isTwilioWaConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM
  );
}

async function sendViaTwilioWa({ to, body, templateContext }) {
  if (!isTwilioWaConfigured()) {
    return { ok: false, reason: 'NOT_CONFIGURED', provider: 'TWILIO_WA' };
  }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    // WhatsApp via Twilio uses 'whatsapp:+...' prefix on both From and To.
    const from = process.env.TWILIO_WHATSAPP_FROM.startsWith('whatsapp:')
      ? process.env.TWILIO_WHATSAPP_FROM
      : `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;
    const toFormatted = String(to).startsWith('whatsapp:')
      ? String(to)
      : `whatsapp:${String(to)}`;

    // For approved Content templates (recommended for Business-Initiated
    // messages outside the 24h customer window), use ContentSid + ContentVariables.
    // Falls back to plain Body for OTPs / ad-hoc.
    const params = new URLSearchParams({ From: from, To: toFormatted });
    if (templateContext?.contentSid) {
      params.set('ContentSid', templateContext.contentSid);
      if (templateContext.contentVariables) {
        params.set('ContentVariables', JSON.stringify(templateContext.contentVariables));
      }
    } else {
      params.set('Body', body);
    }

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: 'PROVIDER_ERROR', provider: 'TWILIO_WA', message: data.message || `HTTP ${res.status}` };
    }
    return { ok: true, provider: 'TWILIO_WA', providerMessageId: data.sid || null };
  } catch (err) {
    return { ok: false, reason: 'NETWORK_ERROR', provider: 'TWILIO_WA', message: err.message };
  }
}

// ─── MSG91 SMS ───────────────────────────────────────────────────────────────
function isMsg91Configured() {
  return !!(process.env.MSG91_API_KEY && process.env.MSG91_SENDER_ID);
}

async function sendViaMsg91Sms({ to, body, templateContext }) {
  if (!isMsg91Configured()) {
    return { ok: false, reason: 'NOT_CONFIGURED', provider: 'MSG91_SMS' };
  }
  // MSG91 strictly requires a DLT-approved template ID; reject if absent.
  const templateId = templateContext?.msg91TemplateId;
  if (!templateId) {
    return { ok: false, reason: 'TEMPLATE_NOT_APPROVED', provider: 'MSG91_SMS', message: 'msg91TemplateId required for IN sends' };
  }
  try {
    const cleaned = String(to).replace(/\D/g, '');
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: {
        authkey: process.env.MSG91_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: templateId,
        sender: process.env.MSG91_SENDER_ID,
        short_url: '0',
        mobiles: cleaned,
        // MSG91 renders the template server-side using these variables; the
        // pre-rendered `body` from our template engine is included as a
        // fallback variable for templates we authored that accept it.
        ...(templateContext?.variables || {}),
        VAR1: body,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type === 'error') {
      return { ok: false, reason: 'PROVIDER_ERROR', provider: 'MSG91_SMS', message: data.message || `HTTP ${res.status}` };
    }
    return { ok: true, provider: 'MSG91_SMS', providerMessageId: data.message_id || data.id || null };
  } catch (err) {
    return { ok: false, reason: 'NETWORK_ERROR', provider: 'MSG91_SMS', message: err.message };
  }
}

// ─── SES Email ───────────────────────────────────────────────────────────────
// Reuses the existing email infrastructure. Lightweight wrapper to match
// the adapter signature; downstream uses utils/email.js for full templating.
async function sendViaSes({ to, body, templateContext }) {
  // Delegate to the existing rich-email helper if a render function is
  // provided; otherwise just send a plain-text minimal email.
  try {
    const { renderEmail, sendEmail } = require('../../utils/email');
    if (typeof sendEmail !== 'function') throw new Error('sendEmail not available');
    const subject = templateContext?.emailSubject || templateContext?.displayName || 'Notification';
    const html = templateContext?.emailHtml || `<p>${body.replace(/\n/g, '<br/>')}</p>`;
    const result = await sendEmail(to, subject, html, templateContext?.emailExtras || {});
    return { ok: !!result?.ok, provider: 'SES_EMAIL', providerMessageId: result?.messageId || null };
  } catch (err) {
    return { ok: false, reason: 'PROVIDER_ERROR', provider: 'SES_EMAIL', message: err.message };
  }
}

// ─── Adapter registry ────────────────────────────────────────────────────────
// Provider → adapter function. Smart router picks one based on the country
// route + channel preferences.
const ADAPTERS = Object.freeze({
  TWILIO_SMS:  sendViaTwilioSms,
  TWILIO_WA:   sendViaTwilioWa,
  MSG91_SMS:   sendViaMsg91Sms,
  SES_EMAIL:   sendViaSes,
});

function getAdapter(providerKey) {
  return ADAPTERS[providerKey] || null;
}

function adapterStatus() {
  return {
    twilioSms:    isTwilioConfigured(),
    twilioWa:     isTwilioWaConfigured(),
    msg91:        isMsg91Configured(),
    sesEmail:     true, // SES configured at app boot; lib/email handles it
  };
}

module.exports = {
  ADAPTERS,
  getAdapter,
  adapterStatus,
  // Exposed for tests / direct use:
  sendViaTwilioSms,
  sendViaTwilioWa,
  sendViaMsg91Sms,
  sendViaSes,
  isTwilioConfigured,
  isTwilioWaConfigured,
  isMsg91Configured,
};

// SMS provider abstraction. Routes outbound SMS to the right provider based
// on the recipient's country code. Today we have two providers wired:
//
//   IN (+91)        → MSG91 (cheapest IN-domestic, DLT-compliant)
//   Everywhere else → Twilio (global coverage)
//
// All call sites use sendSMS() — the only public function. Providers are
// internally stubbed so the lib is safe to import even when no credentials
// are set (it returns { ok: false, reason: 'NOT_CONFIGURED' } and the call
// site can decide whether to fall back to email).
//
// Env vars (all optional — missing = provider disabled, no error thrown):
//   MSG91_API_KEY · MSG91_SENDER_ID · MSG91_TEMPLATE_<TYPE>
//   TWILIO_ACCOUNT_SID · TWILIO_AUTH_TOKEN · TWILIO_FROM_NUMBER
//
// To enable a provider in production: set the env vars on EC2 and reload
// PM2. No code change needed.

const COUNTRY_TO_PROVIDER = {
  IN: 'msg91',
};
const DEFAULT_PROVIDER = 'twilio';

// Detect the destination country from a phone number. Accepts E.164 (+91…)
// or with a separate `country` argument. Falls back to default provider.
function detectProvider(to, hint) {
  const explicit = (hint || '').toUpperCase();
  if (explicit && COUNTRY_TO_PROVIDER[explicit]) return COUNTRY_TO_PROVIDER[explicit];

  const cleaned = String(to || '').replace(/\s|-|\(|\)/g, '');
  // Common dial codes — not exhaustive, but covers the IN routing case
  // which is the one with cost differentiation. Add more as needed.
  if (/^\+?91\d/.test(cleaned)) return 'msg91';
  // Default for everything else (including +1 US, +44 UK, +61 AU, +64 NZ)
  return DEFAULT_PROVIDER;
}

function isMsg91Configured() {
  return !!(process.env.MSG91_API_KEY && process.env.MSG91_SENDER_ID);
}

function isTwilioConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

// MSG91 send — uses their HTTP API. Templates must be DLT-registered before
// sending in production. `templateType` maps to MSG91_TEMPLATE_<TYPE> env var.
async function sendViaMsg91({ to, message, templateType }) {
  if (!isMsg91Configured()) {
    return { ok: false, reason: 'NOT_CONFIGURED', provider: 'msg91' };
  }
  const templateId = templateType
    ? process.env[`MSG91_TEMPLATE_${templateType.toUpperCase()}`]
    : null;
  if (templateType && !templateId) {
    return {
      ok: false,
      reason: 'TEMPLATE_NOT_CONFIGURED',
      provider: 'msg91',
      message: `MSG91_TEMPLATE_${templateType.toUpperCase()} env var not set`,
    };
  }
  try {
    const url = 'https://control.msg91.com/api/v5/flow/';
    const body = {
      template_id: templateId,
      sender: process.env.MSG91_SENDER_ID,
      short_url: '0',
      mobiles: String(to).replace(/\D/g, ''),
      // Templates have placeholder variables — the call site can pass
      // structured data via the `message` arg as a stringified JSON object
      // OR plain text. For DLT templates, prefer structured.
      VAR1: message,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authkey: process.env.MSG91_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type === 'error') {
      return {
        ok: false,
        reason: 'PROVIDER_ERROR',
        provider: 'msg91',
        message: data.message || `HTTP ${res.status}`,
      };
    }
    return { ok: true, provider: 'msg91', providerId: data.message_id || data.id || null };
  } catch (err) {
    return { ok: false, reason: 'NETWORK_ERROR', provider: 'msg91', message: err.message };
  }
}

// Twilio send — uses Basic auth + their REST API.
async function sendViaTwilio({ to, message }) {
  if (!isTwilioConfigured()) {
    return { ok: false, reason: 'NOT_CONFIGURED', provider: 'twilio' };
  }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer
      .from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`)
      .toString('base64');
    const params = new URLSearchParams({
      From: process.env.TWILIO_FROM_NUMBER,
      To: String(to),
      Body: message,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        reason: 'PROVIDER_ERROR',
        provider: 'twilio',
        message: data.message || `HTTP ${res.status}`,
      };
    }
    return { ok: true, provider: 'twilio', providerId: data.sid || null };
  } catch (err) {
    return { ok: false, reason: 'NETWORK_ERROR', provider: 'twilio', message: err.message };
  }
}

// Public API — call this from anywhere that needs to send an SMS.
//
// Args:
//   to:           E.164 phone number ('+91...' or '+1...')
//   message:      plaintext body. For MSG91, may be the template variable.
//   country:      optional ISO-3166-1 alpha-2 (e.g. 'IN'). Overrides
//                 phone-number-based detection.
//   templateType: optional, used by MSG91 to look up MSG91_TEMPLATE_<TYPE>.
//                 Common values: SIGNUP_OTP, BOOKING_CONFIRM, BOOKING_REMIND,
//                 ORDER_CONFIRM, ORDER_OUT_FOR_DELIVERY.
//
// Returns:
//   { ok: true, provider, providerId }                 — sent successfully
//   { ok: false, reason, provider, message? }          — failed; reason in:
//     NOT_CONFIGURED, TEMPLATE_NOT_CONFIGURED, PROVIDER_ERROR,
//     NETWORK_ERROR, INVALID_RECIPIENT
async function sendSMS({ to, message, country, templateType } = {}) {
  if (!to || !message) {
    return { ok: false, reason: 'INVALID_RECIPIENT', message: 'to + message are required' };
  }
  const provider = detectProvider(to, country);
  if (provider === 'msg91') {
    return sendViaMsg91({ to, message, templateType });
  }
  return sendViaTwilio({ to, message });
}

// Cheap config probe for /health endpoints + admin dashboards.
function status() {
  return {
    msg91: { configured: isMsg91Configured() },
    twilio: { configured: isTwilioConfigured() },
  };
}

module.exports = {
  sendSMS,
  status,
  // exposed for tests
  detectProvider,
  isMsg91Configured,
  isTwilioConfigured,
};

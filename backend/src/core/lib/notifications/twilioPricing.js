// Twilio Pricing API client — fetches real per-country SMS + WhatsApp rates
// so the budget engine can compute customer-visible slot counts dynamically.
//
// Twilio publishes outbound messaging rates per country at:
//   GET https://pricing.twilio.com/v1/Messaging/Countries
//   GET https://pricing.twilio.com/v1/Messaging/Countries/{ISO}
//
// Pricing API auth uses the same SID + Auth Token as the Messages API. No
// extra cost to query.
//
// We cache per-country results in ProviderPriceCache (refreshed daily by a
// cron job). The smart router and slot-count calculator read from cache so
// page renders never block on a Twilio API call.
//
// Test mode: if TWILIO_ACCOUNT_SID is missing, we use the hardcoded fallback
// rates (collected from Twilio's pricing pages 2026-04-29). Lets dev/CI run
// without credentials and provides a safety net if Twilio's API is down.
'use strict';

// Hardcoded reference rates (2026-04-29) — safety fallback if the live
// pricing API is unreachable. Stored in USD per outbound message. Updated
// quarterly by a refresh script (see scripts/refresh-twilio-rates.js).
const TWILIO_RATES_FALLBACK = Object.freeze({
  // ISO-2 → { sms, whatsappUtility } in USD
  US: { sms: 0.0079, whatsappUtility: 0.0079 },
  CA: { sms: 0.0079, whatsappUtility: 0.0079 },
  GB: { sms: 0.0413, whatsappUtility: 0.0418 },
  IE: { sms: 0.0760, whatsappUtility: 0.0418 },
  AU: { sms: 0.0517, whatsappUtility: 0.0418 },
  NZ: { sms: 0.0426, whatsappUtility: 0.0418 },
  SG: { sms: 0.0445, whatsappUtility: 0.0418 },
  HK: { sms: 0.0445, whatsappUtility: 0.0418 },
  JP: { sms: 0.0703, whatsappUtility: 0.0418 },
  KR: { sms: 0.2057, whatsappUtility: 0.0118 },
  TW: { sms: 0.0445, whatsappUtility: 0.0418 },
  IN: { sms: 0.0397, whatsappUtility: 0.0079 }, // Note: MSG91 used in practice ($0.0024)
  ID: { sms: 0.0220, whatsappUtility: 0.0290 },
  PH: { sms: 0.0297, whatsappUtility: 0.0418 },
  TH: { sms: 0.0496, whatsappUtility: 0.0418 },
  VN: { sms: 0.0388, whatsappUtility: 0.0418 },
  MY: { sms: 0.0496, whatsappUtility: 0.0418 },
  PK: { sms: 0.0680, whatsappUtility: 0.0250 },
  BD: { sms: 0.0660, whatsappUtility: 0.0250 },
  LK: { sms: 0.0488, whatsappUtility: 0.0418 },
  NP: { sms: 0.0488, whatsappUtility: 0.0418 },
  TR: { sms: 0.0314, whatsappUtility: 0.0418 },
  AE: { sms: 0.0498, whatsappUtility: 0.0418 },
  SA: { sms: 0.1180, whatsappUtility: 0.0418 },
  IL: { sms: 0.1230, whatsappUtility: 0.0418 },
  EG: { sms: 0.0666, whatsappUtility: 0.0870 },
  ZA: { sms: 0.0383, whatsappUtility: 0.0079 },
  NG: { sms: 0.0608, whatsappUtility: 0.0110 },
  KE: { sms: 0.0488, whatsappUtility: 0.0488 },
  GH: { sms: 0.0700, whatsappUtility: 0.0488 },
  MX: { sms: 0.0419, whatsappUtility: 0.0418 },
  BR: { sms: 0.0461, whatsappUtility: 0.0079 },
  AR: { sms: 0.1140, whatsappUtility: 0.0418 },
  CO: { sms: 0.0090, whatsappUtility: 0.0079 },
  CL: { sms: 0.0640, whatsappUtility: 0.0418 },
  PE: { sms: 0.0345, whatsappUtility: 0.0418 },
  DE: { sms: 0.0779, whatsappUtility: 0.0758 },
  FR: { sms: 0.0779, whatsappUtility: 0.0758 },
  ES: { sms: 0.0707, whatsappUtility: 0.0758 },
  IT: { sms: 0.0703, whatsappUtility: 0.0758 },
  NL: { sms: 0.0858, whatsappUtility: 0.0758 },
  BE: { sms: 0.0703, whatsappUtility: 0.0758 },
  AT: { sms: 0.0703, whatsappUtility: 0.0758 },
  CH: { sms: 0.0556, whatsappUtility: 0.0758 },
  PT: { sms: 0.0779, whatsappUtility: 0.0758 },
  PL: { sms: 0.0508, whatsappUtility: 0.0758 },
  SE: { sms: 0.0526, whatsappUtility: 0.0758 },
  NO: { sms: 0.0588, whatsappUtility: 0.0758 },
  DK: { sms: 0.0454, whatsappUtility: 0.0758 },
  FI: { sms: 0.0703, whatsappUtility: 0.0758 },
});

// MSG91 manual rates — IN-only. Stable, reviewed quarterly. Stored in USD
// for parity with Twilio rates (so the budget engine works in one currency).
// Source: MSG91 dashboard transactional pricing (~₹0.20/SMS at 83 INR/USD).
const MSG91_RATES = Object.freeze({
  IN: { sms: 0.0024 }, // MSG91 transactional SMS
});

function isTwilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

// Fetch live rate for one country from Twilio's Pricing API.
// Returns { sms, whatsappUtility } or null if unavailable.
// Twilio's Messaging Pricing endpoint returns prices per carrier — we take
// the median (most representative) outbound rate. WhatsApp pricing comes
// from a separate endpoint Twilio added in 2024 (Conversations Pricing).
async function fetchLiveRate(countryCode) {
  if (!isTwilioConfigured()) return null;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  try {
    const res = await fetch(
      `https://pricing.twilio.com/v1/Messaging/Countries/${countryCode.toUpperCase()}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (!res.ok) return null;
    const data = await res.json();

    // outbound_sms_prices = [{ carrier, mcc, mnc, prices: [{ number_type, base_price, current_price }] }]
    // We want the median current_price across carriers for 'mobile' number_type.
    const allPrices = [];
    for (const carrier of data.outbound_sms_prices || []) {
      for (const price of carrier.prices || []) {
        const cp = parseFloat(price.current_price);
        if (Number.isFinite(cp) && cp > 0) allPrices.push(cp);
      }
    }
    if (!allPrices.length) return null;
    allPrices.sort((a, b) => a - b);
    const median = allPrices[Math.floor(allPrices.length / 2)];

    // WhatsApp utility rate isn't in the SMS Pricing endpoint. For now we
    // use the fallback table; future enhancement: call Conversations Pricing
    // API per Meta-category. Most of the per-country variance is in SMS.
    const fallback = TWILIO_RATES_FALLBACK[countryCode.toUpperCase()] || {};
    return {
      sms: median,
      whatsappUtility: fallback.whatsappUtility ?? 0.05, // safe upper-bound default
    };
  } catch {
    return null;
  }
}

// Get rate for a country — live API if available, fallback otherwise.
// Returns { sms, whatsappUtility, source } where source ∈ 'TWILIO_API' | 'TWILIO_FALLBACK' | 'MSG91_MANUAL'.
async function getRate(countryCode) {
  const upper = String(countryCode || '').toUpperCase();
  if (!upper) return null;

  // For India, MSG91 is our preferred SMS provider — override Twilio's rate.
  if (MSG91_RATES[upper]) {
    const fallback = TWILIO_RATES_FALLBACK[upper] || {};
    return {
      sms: MSG91_RATES[upper].sms,
      whatsappUtility: fallback.whatsappUtility ?? 0.05,
      source: 'MSG91_MANUAL',
    };
  }

  const live = await fetchLiveRate(upper);
  if (live) return { ...live, source: 'TWILIO_API' };

  const fallback = TWILIO_RATES_FALLBACK[upper];
  if (fallback) return { ...fallback, source: 'TWILIO_FALLBACK' };

  return null;
}

// Return all hardcoded fallback rates synchronously — useful for seeding
// the price cache on first deploy before the live cron runs, and for tests.
function getAllFallbackRates() {
  const merged = {};
  for (const [country, rates] of Object.entries(TWILIO_RATES_FALLBACK)) {
    merged[country] = { ...rates, source: 'TWILIO_FALLBACK' };
  }
  // MSG91 overlays IN
  if (MSG91_RATES.IN) {
    merged.IN = {
      sms: MSG91_RATES.IN.sms,
      whatsappUtility: TWILIO_RATES_FALLBACK.IN?.whatsappUtility ?? 0.05,
      source: 'MSG91_MANUAL',
    };
  }
  return merged;
}

module.exports = {
  TWILIO_RATES_FALLBACK,
  MSG91_RATES,
  isTwilioConfigured,
  fetchLiveRate,
  getRate,
  getAllFallbackRates,
};

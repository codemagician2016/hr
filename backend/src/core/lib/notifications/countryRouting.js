// Country-aware channel routing rules for the smart notification router.
//
// For each ISO-2 country code, we record:
//   - smsProvider: which provider to use for managed SMS (or null = unsupported)
//   - waProvider:  which provider to use for managed WhatsApp (always 'TWILIO_WA' today)
//   - dialCodes:   E.164 dial-code prefixes that map back to this country (for
//                  reverse-routing when only the recipient phone is known)
//
// Slot count = budget / actual_provider_cost. Cost comes from
// ProviderPriceCache (refreshed daily from Twilio Pricing API + MSG91 manual).
// So this file controls *which provider handles a country*, not *what it costs*.
//
// Adding a country: append a row + add at least one dial code. The cost is
// auto-discovered from Twilio Pricing API on the next cron tick (see
// `src/lib/notifications/priceCache.js`).
'use strict';

// Provider identifiers — these match what's stored in ProviderPriceCache.source
// and MessageDelivery.provider so the router can pick the right adapter.
const PROVIDERS = Object.freeze({
  MSG91_SMS:   'MSG91_SMS',
  TWILIO_SMS:  'TWILIO_SMS',
  TWILIO_WA:   'TWILIO_WA',
  // Future: Africa's Talking, BulkSMS BD, SimplyCast, Unifonic, etc.
  AFRICAS_TALKING_SMS: 'AFRICAS_TALKING_SMS',
});

// Default routing — every Twilio-supported country can receive SMS via Twilio
// + WhatsApp via Twilio WA Business. India routes through MSG91 (DLT compliance
// + 20× cheaper). Countries below are explicit overrides; everything else
// falls back to Twilio for both channels.
//
// Status:
//   'live'      — provider integration ready, slot count calc enabled
//   'planned'   — country listed but provider integration not yet built
//                 (router falls back to Twilio while waiting)
//
// References (pricing as of 2026-04-29 from Twilio's published rates):
//   IN  MSG91   $0.0024 SMS · Twilio WA $0.0079 utility
//   US  Twilio  $0.0079 SMS · $0.0079 WA utility
//   UK  Twilio  $0.0413 SMS · $0.0418 WA utility
//   DE  Twilio  $0.0779 SMS · $0.0758 WA utility
//   KR  Twilio  $0.2057 SMS · $0.0118 WA utility
const COUNTRY_ROUTES = Object.freeze({
  // ── Asia ─────────────────────────────────────────────────────────────────
  IN: { smsProvider: PROVIDERS.MSG91_SMS,  waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['91'],  status: 'live' },
  PK: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['92'],  status: 'live' },
  BD: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['880'], status: 'live' },
  LK: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['94'],  status: 'live' },
  NP: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['977'], status: 'live' },
  SG: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['65'],  status: 'live' },
  MY: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['60'],  status: 'live' },
  ID: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['62'],  status: 'live' },
  PH: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['63'],  status: 'live' },
  TH: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['66'],  status: 'live' },
  VN: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['84'],  status: 'live' },
  HK: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['852'], status: 'live' },
  TW: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['886'], status: 'live' },
  JP: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['81'],  status: 'live' },
  KR: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['82'],  status: 'live' },
  // ── Americas ─────────────────────────────────────────────────────────────
  US: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['1'],   status: 'live' },
  CA: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['1'],   status: 'live' },
  MX: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['52'],  status: 'live' },
  BR: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['55'],  status: 'live' },
  AR: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['54'],  status: 'live' },
  CO: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['57'],  status: 'live' },
  CL: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['56'],  status: 'live' },
  PE: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['51'],  status: 'live' },
  // ── Europe ───────────────────────────────────────────────────────────────
  GB: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['44'],  status: 'live' },
  IE: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['353'], status: 'live' },
  DE: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['49'],  status: 'live' },
  FR: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['33'],  status: 'live' },
  ES: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['34'],  status: 'live' },
  IT: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['39'],  status: 'live' },
  NL: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['31'],  status: 'live' },
  BE: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['32'],  status: 'live' },
  AT: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['43'],  status: 'live' },
  CH: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['41'],  status: 'live' },
  PT: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['351'], status: 'live' },
  PL: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['48'],  status: 'live' },
  SE: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['46'],  status: 'live' },
  NO: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['47'],  status: 'live' },
  DK: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['45'],  status: 'live' },
  FI: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['358'], status: 'live' },
  TR: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['90'],  status: 'live' },
  // ── Oceania ──────────────────────────────────────────────────────────────
  AU: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['61'],  status: 'live' },
  NZ: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['64'],  status: 'live' },
  // ── Middle East ──────────────────────────────────────────────────────────
  AE: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['971'], status: 'live' },
  SA: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['966'], status: 'live' },
  IL: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['972'], status: 'live' },
  EG: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['20'],  status: 'live' },
  // ── Africa ───────────────────────────────────────────────────────────────
  ZA: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['27'],  status: 'live' },
  NG: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['234'], status: 'live' },
  KE: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['254'], status: 'live' },
  GH: { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: ['233'], status: 'live' },
});

// Reverse map: dial code prefix → ISO-2 country code. Built lazily; the
// longest match wins (e.g., '880' BD beats '88' which doesn't exist anyway).
let DIAL_CODE_TO_COUNTRY = null;

function buildDialCodeIndex() {
  if (DIAL_CODE_TO_COUNTRY) return DIAL_CODE_TO_COUNTRY;
  const map = new Map();
  for (const [country, route] of Object.entries(COUNTRY_ROUTES)) {
    for (const code of route.dialCodes) {
      // For ambiguous '1' (US/CA share NANP), the order in COUNTRY_ROUTES
      // matters; US wins because it's listed first. NANP differentiation
      // by area code is not done here — sender's country preference can
      // override at send time if needed.
      if (!map.has(code)) map.set(code, country);
    }
  }
  // Sort once into descending-length order so detectCountryFromPhone can
  // do a single linear scan and pick the longest prefix that matches.
  DIAL_CODE_TO_COUNTRY = Array.from(map.entries()).sort(
    (a, b) => b[0].length - a[0].length,
  );
  return DIAL_CODE_TO_COUNTRY;
}

// Detect ISO-2 country from a phone number. Accepts E.164 ('+91…') or raw
// digits ('919876543210'). Returns null if no dial-code match.
function detectCountryFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const idx = buildDialCodeIndex();
  for (const [code, country] of idx) {
    if (digits.startsWith(code)) return country;
  }
  return null;
}

// Look up the route for a country. Returns the route object (with smsProvider
// + waProvider + status) or a sensible Twilio fallback for unmapped countries.
function getRoute(countryCode) {
  const upper = String(countryCode || '').toUpperCase();
  if (COUNTRY_ROUTES[upper]) return COUNTRY_ROUTES[upper];
  // Fallback for any unmapped country — Twilio supports ~200 countries.
  // If Twilio can't deliver to that country, the cron-refreshed
  // ProviderPriceCache will have isAvailable=false and the smart router
  // will hide the channel from the customer.
  return { smsProvider: PROVIDERS.TWILIO_SMS, waProvider: PROVIDERS.TWILIO_WA, dialCodes: [], status: 'fallback' };
}

// All countries we have explicit routing for. Useful for the daily cron
// to know which countries to fetch prices for.
function listCountries() {
  return Object.keys(COUNTRY_ROUTES);
}

module.exports = {
  PROVIDERS,
  COUNTRY_ROUTES,
  detectCountryFromPhone,
  getRoute,
  listCountries,
};

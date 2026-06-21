// Locale registry for next-intl. Adding a new language is a 3-step:
//   1. Add the BCP-47 code here
//   2. Create messages/<code>.json with the translations
//   3. (Optional) add it to COUNTRY_LOCALE_MAP for auto-detect
//
// Why these 7 to start:
//   en      — base / fallback
//   hi      — India (large home market)
//   es      — Spain + LatAm (largest non-English Western market)
//   fr      — France + Quebec + parts of Africa
//   de      — DACH (highest SMB software spend per capita)
//   it      — Italy (user-requested specifically)
//   pt-BR   — Brazil (large bootstrap-friendly market)
//
// More can be added later — each one is a single JSON file and a
// translation pass. No code changes needed.

export const SUPPORTED_LOCALES = ['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR'];
export const DEFAULT_LOCALE = 'en';

// Friendly display names + native labels for the language picker.
// Native label is what shows in the dropdown — most users find their
// own language faster when it's written in its own script.
export const LOCALE_LABELS = {
  'en':    { native: 'English',     english: 'English'    },
  'hi':    { native: 'हिन्दी',        english: 'Hindi'      },
  'es':    { native: 'Español',     english: 'Spanish'    },
  'fr':    { native: 'Français',    english: 'French'     },
  'de':    { native: 'Deutsch',     english: 'German'     },
  'it':    { native: 'Italiano',    english: 'Italian'    },
  'pt-BR': { native: 'Português',   english: 'Portuguese' },
};

// Country-code → preferred language for first-visit auto-detect.
// Customer in Italy lands → cookie not set → Accept-Language read →
// we fall back to country IP if header is unhelpful (e.g. browser
// configured for English while traveller is in Italy). Country lookup
// itself is done client-side via the existing /api/geo endpoint.
//
// India defaults to Hindi — geo-IP-based auto-pick. English-fluent
// Indian users can switch via the picker (their explicit choice
// becomes sticky via NEXT_LOCALE_EXPLICIT cookie).
export const COUNTRY_LOCALE_MAP = {
  IT: 'it',
  FR: 'fr', BE: 'fr', LU: 'fr', MC: 'fr',
  DE: 'de', AT: 'de', CH: 'de', LI: 'de',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', UY: 'es', VE: 'es', PY: 'es', BO: 'es', EC: 'es', GT: 'es', HN: 'es', SV: 'es', NI: 'es', CR: 'es', PA: 'es', DO: 'es', CU: 'es',
  BR: 'pt-BR', PT: 'pt-BR', // Use pt-BR for both Brazil and Portugal until pt-PT is added
  IN: 'hi',
};

export function localeFromCountry(countryCode) {
  if (!countryCode) return DEFAULT_LOCALE;
  return COUNTRY_LOCALE_MAP[countryCode.toUpperCase()] || DEFAULT_LOCALE;
}

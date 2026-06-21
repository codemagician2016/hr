// Tiny dependency-free translator for backend emails.
//
// Mirrors the shape of next-intl on the frontend (nested keys, {var}
// interpolation) so future engineers don't context-switch — but kept
// stand-alone because backend has no need to pull in next-intl + React.
//
// Usage:
//   const { tFor } = require('./translator');
//   const t = tFor('hi');                       // bind locale once
//   t('booking.confirmed.subject')              // → "बुकिंग कन्फर्म!"
//   t('booking.confirmed.greeting', { name: 'Ravi' })  // → "नमस्ते Ravi"
//
// Missing keys fall back through: requested locale → English → key string.

const SUPPORTED_LOCALES = ['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR'];
const DEFAULT_LOCALE = 'en';

const bundles = {};
for (const locale of SUPPORTED_LOCALES) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  bundles[locale] = require(`./email/${locale}.json`);
}

function getNested(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function interpolate(template, vars) {
  if (typeof template !== 'string') return template;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

// Normalise a locale string to one we support, otherwise default.
// Accepts case-insensitive input and a few common aliases.
function resolveLocale(locale) {
  if (!locale || typeof locale !== 'string') return DEFAULT_LOCALE;
  const trimmed = locale.trim();
  if (!trimmed) return DEFAULT_LOCALE;
  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;
  // Accept-Language style "pt-BR" → "pt-BR", "pt" → "pt-BR"
  const prefix = trimmed.split('-')[0].toLowerCase();
  const prefixHit = SUPPORTED_LOCALES.find((l) => l.toLowerCase().startsWith(prefix));
  return prefixHit || DEFAULT_LOCALE;
}

function t(key, locale, vars) {
  const resolved = resolveLocale(locale);
  const direct = getNested(bundles[resolved], key);
  if (direct !== undefined) return interpolate(direct, vars);
  const fallback = getNested(bundles[DEFAULT_LOCALE], key);
  if (fallback !== undefined) return interpolate(fallback, vars);
  // Last-resort: return the key itself so the template still renders
  // (better than blank spots) and the missing key is visible during QA.
  return key;
}

// Convenience: returns a t() bound to a specific locale, so call sites
// stay short — `t('foo')` instead of `t('foo', 'hi')` everywhere.
function tFor(locale) {
  const resolved = resolveLocale(locale);
  return (key, vars) => t(key, resolved, vars);
}

module.exports = {
  t,
  tFor,
  resolveLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
};

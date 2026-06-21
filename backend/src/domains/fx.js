// ============================================================================
// FX service — converts money between currencies off a single USD base table.
// Rates come from Frankfurter (https://frankfurter.app), a free, no-key feed of
// the ECB's official daily reference rates, fetched once with base=USD and
// cached 24h (served stale on any fetch failure so a hiccup never blocks a
// price). Every cross-rate is derived as (USD->to) / (USD->from), so USD is the
// pivot for all conversions and USD-pegged currencies are exact. Used to
// localize domain prices into the customer's currency.
// ============================================================================

const FX_BASE = 'https://api.frankfurter.app';
const TTL_MS = 24 * 60 * 60 * 1000;
const BASE = 'USD';
let baseCache = null; // { rates, fetchedAt } — rates are USD -> X

// Currencies billed without a minor unit (no cents).
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

// Currencies the ECB feed doesn't publish but which are hard-pegged to the USD.
// 1 USD = N of the currency. Merged into the USD base table so Gulf/pegged
// markets convert exactly (no third-currency detour).
const USD_PEG = {
  AED: 3.6725, SAR: 3.75, QAR: 3.64, OMR: 0.3845, BHD: 0.376, KWD: 0.3075,
  JOD: 0.709, LBP: 89500, HKD: 7.8,
};

function divisorFor(currency) {
  return ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 1 : 100;
}

// USD -> X rate table (USD:1 + ECB rates + pegs). Cached 24h, stale on failure.
async function baseRates() {
  if (baseCache && Date.now() - baseCache.fetchedAt < TTL_MS) return baseCache.rates;
  try {
    const res = await fetch(`${FX_BASE}/latest?from=${BASE}`);
    const json = await res.json().catch(() => ({}));
    if (res.ok && json && json.rates) {
      const rates = { ...json.rates, [BASE]: 1, ...USD_PEG };
      baseCache = { rates, fetchedAt: Date.now() };
      return rates;
    }
  } catch {
    /* fall through to stale cache below */
  }
  return baseCache ? baseCache.rates : null; // serve stale on failure; null if never fetched
}

// Returns the multiplier from `from` -> `to`, or null if unknown. Everything is
// derived from the USD base: from -> to == (USD->to) / (USD->from).
async function rate(from, to) {
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  if (!f || !t) return null;
  if (f === t) return 1;
  const rates = await baseRates();
  if (!rates) return null;
  const usdFrom = f === BASE ? 1 : Number(rates[f]);
  const usdTo = t === BASE ? 1 : Number(rates[t]);
  if (!(usdFrom > 0) || !(usdTo > 0)) return null;
  return usdTo / usdFrom;
}

// Convert a minor-unit amount from one currency to another (minor units out).
// Returns null when the rate is unknown so callers can keep the original price.
async function convertMinor(amountMinor, from, to) {
  const r = await rate(from, to);
  if (r == null) return null;
  const major = (Number(amountMinor) / divisorFor(from)) * r;
  return Math.round(major * divisorFor(to));
}

// Charm-round a minor amount to a clean retail price (e.g. NZ$88.99). Zero-
// decimal currencies just ceil to a whole unit.
function charmRoundMinor(minor, currency) {
  const n = Number(minor) || 0;
  if (divisorFor(currency) === 1) return Math.max(0, Math.ceil(n));
  const major = n / 100;
  const ceilMajor = Math.max(1, Math.ceil(major));
  return ceilMajor * 100 - 1; // -> .99
}

module.exports = { rate, convertMinor, charmRoundMinor, divisorFor, ZERO_DECIMAL };

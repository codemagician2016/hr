// ============================================================================
// Localize domain prices into the customer's currency. Retail is computed as
// wholesale x (1 + margin%) converted via FX (+ a buffer% to absorb rate
// drift), then charm-rounded — so a NZ customer sees/pays NZD, a US customer
// USD, etc., all derived from the INR wholesale cost. Margin + buffer are
// env-configurable. If the wholesale or FX rate is unknown, the original price
// is kept untouched (never break a search/checkout over pricing).
//   DOMAIN_MARGIN_PCT     default 20  (margin over wholesale cost)
//   DOMAIN_FX_BUFFER_PCT  default 4   (cushion for FX drift)
// ============================================================================

const prismaDefault = require('../core/lib/prisma');
const fx = require('./fx');

// Fallback country -> currency when CountryZoneAssignment has no row.
const FALLBACK_CURRENCY = {
  IN: 'INR', NZ: 'NZD', AU: 'AUD', US: 'USD', GB: 'GBP', CA: 'CAD', SG: 'SGD',
  AE: 'AED', ZA: 'ZAR', JP: 'JPY', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  // Eurozone
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', PT: 'EUR', AT: 'EUR', BE: 'EUR', FI: 'EUR',
};

function marginPct() {
  const n = Number(process.env.DOMAIN_MARGIN_PCT);
  return Number.isFinite(n) ? n : 20;
}
function bufferPct() {
  const n = Number(process.env.DOMAIN_FX_BUFFER_PCT);
  return Number.isFinite(n) ? n : 4;
}

async function currencyForCountry(country, prisma = prismaDefault) {
  const code = String(country || '').toUpperCase();
  if (!code) return null;
  try {
    const row = await prisma.countryZoneAssignment.findUnique({ where: { countryCode: code }, select: { currencyCode: true } });
    if (row?.currencyCode) return String(row.currencyCode).toUpperCase();
  } catch {
    /* table optional — fall back below */
  }
  return FALLBACK_CURRENCY[code] || null;
}

// Recompute one search result's price in the target currency.
async function localizeDomainResult(result, targetCurrency) {
  const target = String(targetCurrency || '').toUpperCase();
  if (!result || !target) return result;
  const src = String(result.currency || 'INR').toUpperCase();

  // Same currency as the priced TLD → keep its curated retail price untouched
  // (the customer already sees their own currency; nothing to convert).
  if (src === target) return result;

  const m = 1 + marginPct() / 100;
  const b = 1 + bufferPct() / 100;

  const wholesale = Number(result.wholesaleMinor);
  const hasWholesale = Number.isFinite(wholesale) && wholesale > 0;
  const retailSrc = Number(result.priceMinor) || 0;

  // Two floors, both FX-converted into the target currency:
  //  • marginFloor = wholesale x (1 + margin%)  → never sell below our margin
  //  • retailFloor = the curated home retail     → never undercut home pricing
  // The localized price is the higher of the two (then + FX buffer + charm).
  const wholesaleConv = hasWholesale ? await fx.convertMinor(wholesale, src, target) : null;
  const retailConv = retailSrc > 0 ? await fx.convertMinor(retailSrc, src, target) : null;
  if (wholesaleConv == null && retailConv == null) return result; // unknown FX -> keep original

  const marginFloor = wholesaleConv != null ? wholesaleConv * m : 0;
  const retailFloor = retailConv != null ? retailConv : 0;
  const priceMinor = fx.charmRoundMinor(Math.max(marginFloor, retailFloor) * b, target);

  let renewalPriceMinor = result.renewalPriceMinor;
  if (Number(result.renewalPriceMinor) > 0) {
    const rn = await fx.convertMinor(Number(result.renewalPriceMinor), src, target);
    if (rn != null) renewalPriceMinor = fx.charmRoundMinor(Math.max(marginFloor, rn) * b, target);
  }

  return {
    ...result,
    priceMinor,
    renewalPriceMinor,
    currency: target,
    baseCurrency: src,
    localized: true,
  };
}

async function localizeResults(results, targetCurrency) {
  if (!Array.isArray(results) || !targetCurrency) return results;
  return Promise.all(results.map((r) => localizeDomainResult(r, targetCurrency)));
}

module.exports = { currencyForCountry, localizeDomainResult, localizeResults, marginPct, bufferPct };

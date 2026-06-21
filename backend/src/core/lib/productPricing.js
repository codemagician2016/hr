// Per-currency price resolution.
// Sprint 2.6b — when a storefront renders a product in a currency that isn't
// the business's defaultCurrency, this picks the right price:
//   1. Explicit override row (`ProductPrice` for the requested currency) — use that.
//   2. Otherwise FX-convert from the product's defaultCurrency `priceMinor`.
//
// FX rates come from the same FX_TO_USD table used by budgetEngine. Conversion
// is two-hop: defaultCurrency → USD → requested currency.
'use strict';

// Subset of FX_TO_USD rates needed at storefront render time. Kept inline
// (not imported from budgetEngine) to avoid pulling in unrelated SMS budget
// logic. Update when adding a new supportedCurrencies value.
const FX_TO_USD = Object.freeze({
  USD: 1.00,
  INR: 0.012,    // ₹1 ≈ $0.012
  GBP: 1.27,
  EUR: 1.08,
  AUD: 0.66,
  CAD: 0.74,
  NZD: 0.61,
  AED: 0.27,
  SGD: 0.74,
});

function isZeroDecimal(code) {
  return new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']).has(code);
}

// Convert minor units between currencies. Returns null if either rate unknown.
function convertMinor(amountMinor, fromCurrency, toCurrency) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (from === to) return amountMinor;
  const fromRate = FX_TO_USD[from];
  const toRate = FX_TO_USD[to];
  if (!fromRate || !toRate) return null;

  // Convert minor → major in source, then USD, then to target's major, then minor.
  const sourceDivisor = isZeroDecimal(from) ? 1 : 100;
  const targetDivisor = isZeroDecimal(to) ? 1 : 100;
  const sourceMajor = amountMinor / sourceDivisor;
  const usd = sourceMajor * fromRate;
  const targetMajor = usd / toRate;
  return Math.round(targetMajor * targetDivisor);
}

// Resolve the displayed price for a product in a given currency.
// `product` must include `prices` relation OR a fallback applies.
//
// Returns { priceMinor, comparePriceMinor, currencyCode, source }
//   source = 'override' | 'fx-converted' | 'default'
function resolvePrice(product, requestedCurrency) {
  if (!product) return null;
  const requested = String(requestedCurrency || product.currency || '').toUpperCase();
  const productCurrency = String(product.currency || '').toUpperCase();

  // 1. Same currency as the product → no conversion needed
  if (requested === productCurrency) {
    return {
      priceMinor: product.priceMinor,
      comparePriceMinor: product.comparePriceMinor || null,
      currencyCode: productCurrency,
      source: 'default',
    };
  }

  // 2. Explicit per-currency override exists → use that
  const override = (product.prices || []).find((p) => p.currencyCode === requested);
  if (override) {
    return {
      priceMinor: override.priceMinor,
      comparePriceMinor: override.comparePriceMinor || null,
      currencyCode: requested,
      source: 'override',
    };
  }

  // 3. FX-convert from default
  const converted = convertMinor(product.priceMinor, productCurrency, requested);
  if (converted == null) {
    // Unknown currency — fall back to default
    return {
      priceMinor: product.priceMinor,
      comparePriceMinor: product.comparePriceMinor || null,
      currencyCode: productCurrency,
      source: 'default',
    };
  }
  return {
    priceMinor: converted,
    comparePriceMinor: product.comparePriceMinor != null
      ? convertMinor(product.comparePriceMinor, productCurrency, requested)
      : null,
    currencyCode: requested,
    source: 'fx-converted',
  };
}

module.exports = { resolvePrice, convertMinor, FX_TO_USD };

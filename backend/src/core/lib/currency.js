// Single source of truth for "what currency should we use here?".
// Pre-2026-04-30 this was scattered across ~15 callsites with three
// different fallback policies (INR / USD / NZD). A tenant with no
// defaultCurrency set would see their cart in INR and their WhatsApp
// share in USD — silent customer-facing mismatch.
//
// Two functions exposed:
//   - DEFAULT_CURRENCY: hardcoded global fallback. Use this in
//     display-side callsites where the only thing you have is a
//     possibly-null currency string and you need *something*.
//   - getDefaultCurrency({ business, country }): the smart resolver
//     for creating new entities (products, orders, prices, ...).
//     Prefers business.defaultCurrency, then country.currencyCode,
//     then DEFAULT_CURRENCY.
//
// Mirror copy at platform/lib/currency.js + business/lib/currency.js
// because verticals don't share modules. Keep them in lockstep.

// Why USD: it's the most-used existing fallback in the codebase, and
// our customers in non-USD regions almost always set
// business.defaultCurrency at signup so this branch rarely fires for
// real traffic.
const DEFAULT_CURRENCY = 'USD';

const COUNTRY_CURRENCY = {
  IN: 'INR', US: 'USD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', CA: 'CAD',
  SG: 'SGD', HK: 'HKD', JP: 'JPY', KR: 'KRW', BR: 'BRL', MX: 'MXN',
  ZA: 'ZAR', AE: 'AED', SA: 'SAR', PK: 'PKR', BD: 'BDT', LK: 'LKR',
  NP: 'NPR', NG: 'NGN', KE: 'KES', EG: 'EGP', TR: 'TRY', PH: 'PHP',
  MY: 'MYR', ID: 'IDR', TH: 'THB', VN: 'VND',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR',
  PT: 'EUR', AT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR',
};

function currencyForCountry(countryCode) {
  return COUNTRY_CURRENCY[String(countryCode || '').toUpperCase()] || DEFAULT_CURRENCY;
}

function getDefaultCurrency({ business, country } = {}) {
  if (business && typeof business.defaultCurrency === 'string' && business.defaultCurrency) {
    return business.defaultCurrency.toUpperCase();
  }
  if (business && typeof business.country === 'string' && business.country) {
    return currencyForCountry(business.country);
  }
  if (country && typeof country.currencyCode === 'string' && country.currencyCode) {
    return country.currencyCode.toUpperCase();
  }
  if (country && typeof country.code === 'string' && country.code) {
    return currencyForCountry(country.code);
  }
  return DEFAULT_CURRENCY;
}

module.exports = { DEFAULT_CURRENCY, COUNTRY_CURRENCY, currencyForCountry, getDefaultCurrency };

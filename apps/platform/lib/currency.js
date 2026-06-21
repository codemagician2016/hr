// Mirror of backend/src/lib/currency.js — verticals don't share
// modules. See that file for rationale.

export const DEFAULT_CURRENCY = 'USD';

export const COUNTRY_CURRENCY = {
  IN: 'INR', US: 'USD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', CA: 'CAD',
  SG: 'SGD', HK: 'HKD', JP: 'JPY', KR: 'KRW', BR: 'BRL', MX: 'MXN',
  ZA: 'ZAR', AE: 'AED', SA: 'SAR', PK: 'PKR', BD: 'BDT', LK: 'LKR',
  NP: 'NPR', NG: 'NGN', KE: 'KES', EG: 'EGP', TR: 'TRY', PH: 'PHP',
  MY: 'MYR', ID: 'IDR', TH: 'THB', VN: 'VND',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR',
  PT: 'EUR', AT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR',
};

export function currencyForCountry(countryCode) {
  return COUNTRY_CURRENCY[String(countryCode || '').toUpperCase()] || DEFAULT_CURRENCY;
}

export function getDefaultCurrency({ business, country } = {}) {
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

export function formatCurrencyMinor(minor, currency = DEFAULT_CURRENCY, options = {}) {
  if (minor === null || minor === undefined) return '—';
  const code = String(currency || DEFAULT_CURRENCY).toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: options.maximumFractionDigits ?? 0,
    }).format(Number(minor || 0) / 100);
  } catch {
    return `${code} ${(Number(minor || 0) / 100).toFixed(2)}`;
  }
}

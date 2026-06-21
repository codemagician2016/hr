// Starter retail table for mock/sandbox scaffolding only. Production search
// reads live registrar pricing into DomainPricing before checkout.
const STARTER_DOMAIN_PRICING = Object.freeze({
  com: { wholesaleMinor: 74000, retailMinor: 129900, renewalRetailMinor: 129900, currency: 'INR' },
  in: { wholesaleMinor: 40000, retailMinor: 99900, renewalRetailMinor: 99900, currency: 'INR' },
  net: { wholesaleMinor: 83000, retailMinor: 149900, renewalRetailMinor: 149900, currency: 'INR' },
  org: { wholesaleMinor: 85000, retailMinor: 149900, renewalRetailMinor: 149900, currency: 'INR' },
  store: {
    wholesaleMinor: 10000,
    retailMinor: 149900,
    renewalWholesaleMinor: 250000,
    renewalRetailMinor: 250000,
    currency: 'INR',
    promotional: true,
    notes: 'First-year promotional price; renewal is higher.',
  },
  online: { wholesaleMinor: 15000, retailMinor: 149900, renewalRetailMinor: 149900, currency: 'INR' },
  shop: { wholesaleMinor: 40000, retailMinor: 149900, renewalRetailMinor: 149900, currency: 'INR' },
  tech: { wholesaleMinor: 35000, retailMinor: 179900, renewalRetailMinor: 179900, currency: 'INR' },
  co: { wholesaleMinor: 200000, retailMinor: 279900, renewalRetailMinor: 279900, currency: 'INR' },
  io: { wholesaleMinor: 420000, retailMinor: 549900, renewalRetailMinor: 549900, currency: 'INR' },
  me: { wholesaleMinor: 150000, retailMinor: 229900, renewalRetailMinor: 229900, currency: 'INR' },
  'co.uk': { wholesaleMinor: 50000, retailMinor: 99900, renewalRetailMinor: 99900, currency: 'INR' },
  uk: { wholesaleMinor: 50000, retailMinor: 99900, renewalRetailMinor: 99900, currency: 'INR' },
  eu: { wholesaleMinor: 60000, retailMinor: 149900, renewalRetailMinor: 149900, currency: 'INR' },
  de: { wholesaleMinor: 70000, retailMinor: 149900, renewalRetailMinor: 149900, currency: 'INR' },
  fr: { wholesaleMinor: 70000, retailMinor: 149900, renewalRetailMinor: 149900, currency: 'INR', requiresTrustee: true },
  es: { wholesaleMinor: 70000, retailMinor: 149900, renewalRetailMinor: 149900, currency: 'INR' },
  ca: { wholesaleMinor: 90000, retailMinor: 169900, renewalRetailMinor: 169900, currency: 'INR', requiresTrustee: true },
  nz: { wholesaleMinor: 2200, retailMinor: 3900, renewalRetailMinor: 3900, currency: 'USD' },
  'co.nz': { wholesaleMinor: 1800, retailMinor: 3500, renewalRetailMinor: 3500, currency: 'USD' },
  au: { wholesaleMinor: 2100, retailMinor: 3900, renewalRetailMinor: 3900, currency: 'USD', requiresTrustee: true },
  'com.au': { wholesaleMinor: 2100, retailMinor: 3900, renewalRetailMinor: 3900, currency: 'USD', requiresTrustee: true },
});

const DEFAULT_SEARCH_TLDS = Object.freeze([
  'com',
  'in',
  'store',
  'online',
  'shop',
  'tech',
  'net',
  'org',
  'co',
  'io',
  'co.nz',
  'nz',
  'com.au',
  'au',
  'co.uk',
  'uk',
  'eu',
  'me',
]);

const PREMIUM_WHOLESALE_CEILING_MINOR = 500000;

function starterPriceForTld(tld) {
  return STARTER_DOMAIN_PRICING[tld] || {
    wholesaleMinor: 180000,
    retailMinor: 299900,
    renewalRetailMinor: 299900,
    currency: 'INR',
  };
}

module.exports = {
  DEFAULT_SEARCH_TLDS,
  PREMIUM_WHOLESALE_CEILING_MINOR,
  STARTER_DOMAIN_PRICING,
  starterPriceForTld,
};

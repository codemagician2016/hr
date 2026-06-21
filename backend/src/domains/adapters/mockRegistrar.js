const { buildDomainName, normalizeTld } = require('../domainNames');
const { PREMIUM_WHOLESALE_CEILING_MINOR, starterPriceForTld } = require('../pricing');
const { addYears, stableRef } = require('./interface');

function isMockAvailable(label, tld) {
  const normalized = `${label}.${tld}`.toLowerCase();
  if (normalized.includes('taken') || normalized.includes('unavailable')) return false;
  if (normalized === 'sitepresso.com' || normalized === 'aapkatech.com') return false;
  return true;
}

function mockSearchResults({ registrar, label, tlds }) {
  return (tlds || []).map((rawTld) => {
    const tld = normalizeTld(rawTld);
    const domainName = buildDomainName(label, tld);
    const pricing = starterPriceForTld(tld);
    const premium = pricing.wholesaleMinor > PREMIUM_WHOLESALE_CEILING_MINOR || domainName.includes('premium');

    return {
      domainName,
      tld,
      registrar,
      available: isMockAvailable(label, tld),
      premium,
      priceMinor: pricing.retailMinor,
      renewalPriceMinor: pricing.renewalRetailMinor || pricing.retailMinor,
      wholesaleMinor: pricing.wholesaleMinor,
      currency: pricing.currency,
      requiresTrustee: Boolean(pricing.requiresTrustee),
      promotional: Boolean(pricing.promotional),
      notes: pricing.notes || null,
    };
  });
}

function mockRegisterResult({ prefix, domainName, years = 1, now = new Date() }) {
  return {
    registrarRef: stableRef(prefix, domainName),
    expiresAt: addYears(now, years).toISOString(),
  };
}

function mockTransferResult({ prefix, domainName }) {
  return {
    registrarRef: stableRef(`${prefix}-TRANSFER`, domainName),
    status: 'TRANSFER_IN_PENDING',
  };
}

function mockAuthCode(prefix, registrarRef) {
  return {
    authCode: `${prefix}-AUTH-${String(registrarRef || '').replace(/[^A-Za-z0-9]/g, '').slice(-10).toUpperCase() || 'CODE'}`,
  };
}

module.exports = {
  mockAuthCode,
  mockRegisterResult,
  mockSearchResults,
  mockTransferResult,
};

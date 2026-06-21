const SECOND_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk',
  'co.in', 'firm.in', 'net.in', 'org.in', 'gen.in',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'org.nz',
]);

function normalizeDomainName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .split(':')[0]
    .replace(/\.$/, '');
}

function normalizeTld(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

function labelsFor(domainName) {
  return normalizeDomainName(domainName).split('.').filter(Boolean);
}

function isValidDomainLabel(label) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(label || ''));
}

function assertValidDomainName(domainName) {
  const labels = labelsFor(domainName);
  if (labels.length < 2 || labels.some((label) => !isValidDomainLabel(label))) {
    const err = new Error('Enter a valid domain name.');
    err.code = 'INVALID_DOMAIN_NAME';
    throw err;
  }
  return labels.join('.');
}

function tldFromDomain(domainName) {
  const labels = labelsFor(domainName);
  if (labels.length < 2) return '';
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && SECOND_LEVEL_TLDS.has(lastTwo)) return lastTwo;
  return labels[labels.length - 1];
}

function sldFromDomain(domainName) {
  const labels = labelsFor(domainName);
  const tld = tldFromDomain(domainName);
  if (!tld) return labels[0] || '';
  const tldParts = tld.split('.').length;
  return labels.slice(0, -tldParts).join('.');
}

function buildDomainName(label, tld) {
  const cleanLabel = normalizeDomainName(label).replace(/\.+$/, '');
  const cleanTld = normalizeTld(tld);
  if (!cleanLabel || !cleanTld) {
    const err = new Error('Domain label and TLD are required.');
    err.code = 'INVALID_DOMAIN_NAME';
    throw err;
  }
  return assertValidDomainName(`${cleanLabel}.${cleanTld}`);
}

function parseDomainSearchQuery(query, defaultTlds = []) {
  const normalized = normalizeDomainName(query);
  const tld = tldFromDomain(normalized);
  if (tld) {
    const label = sldFromDomain(normalized);
    return { label, exactDomain: normalized, requestedTlds: [tld] };
  }
  return {
    label: normalized.replace(/\.+$/, ''),
    exactDomain: '',
    requestedTlds: defaultTlds.map(normalizeTld).filter(Boolean),
  };
}

module.exports = {
  SECOND_LEVEL_TLDS,
  assertValidDomainName,
  buildDomainName,
  isValidDomainLabel,
  labelsFor,
  normalizeDomainName,
  normalizeTld,
  parseDomainSearchQuery,
  sldFromDomain,
  tldFromDomain,
};

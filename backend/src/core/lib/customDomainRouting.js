// Only ACTIVE (verified) rows resolve to a tenant. Subdomains are bound
// ACTIVE+verified so they still route; an unverified custom domain sitting in
// PENDING_* (or FAILED) no longer resolves — closes the squat-routes-immediately
// hole where merely saving a domain would route it before ownership/cert proof.
const ROUTABLE_CUSTOM_DOMAIN_STATUSES = ['ACTIVE'];
const COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.in', 'firm.in', 'net.in', 'org.in', 'gen.in',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'org.nz',
  'com.br', 'com.mx', 'com.sg', 'com.my', 'com.pk',
  'co.za',
]);

function normalizeCustomDomainHost(raw) {
  return String(raw || '').toLowerCase().split(':')[0].replace(/\.$/, '').trim();
}

function customDomainLabels(domain) {
  return String(domain || '').split('.').filter(Boolean);
}

function isLikelyApexDomain(domain) {
  const labels = customDomainLabels(domain);
  if (labels.length === 2) return true;
  if (labels.length === 3 && COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES.has(labels.slice(1).join('.'))) return true;
  return false;
}

function customDomainLookupHosts(rawHost) {
  const host = normalizeCustomDomainHost(rawHost);
  if (!host) return [];
  if (host.startsWith('www.')) {
    const apex = host.slice(4);
    return isLikelyApexDomain(apex) ? [host, apex] : [host];
  }
  return isLikelyApexDomain(host) ? [host, `www.${host}`] : [host];
}

function routableCustomDomainWhere(rawHost) {
  const hosts = customDomainLookupHosts(rawHost);
  if (!hosts.length) return null;
  return {
    customDomain: { in: hosts },
    OR: [
      { customDomainVerified: true },
      { customDomainStatus: { in: ROUTABLE_CUSTOM_DOMAIN_STATUSES } },
    ],
  };
}

module.exports = {
  ROUTABLE_CUSTOM_DOMAIN_STATUSES,
  customDomainLookupHosts,
  normalizeCustomDomainHost,
  routableCustomDomainWhere,
};

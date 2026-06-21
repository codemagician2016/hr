const { normalizeTld, parseDomainSearchQuery } = require('./domainNames');
const { DEFAULT_SEARCH_TLDS } = require('./pricing');
const { ByodAdapter } = require('./adapters/byod');
const { OpenproviderAdapter } = require('./adapters/openprovider');

const REGISTRAR = Object.freeze({
  OPENPROVIDER: 'OPENPROVIDER',
  BYOD: 'BYOD',
});

// Openprovider carries 1200+ TLDs, so it is the single registrar for every
// supported extension. Restricted TLDs (sponsored/ccTLDs we don't resell) stay
// unsupported and route to BYOD instead.
const UNSUPPORTED_TLDS = new Set([
  'gov',
  'edu',
  'mil',
  'jp',
  'kr',
]);

function createDefaultAdapters(options = {}) {
  return {
    [REGISTRAR.OPENPROVIDER]: new OpenproviderAdapter(options),
    [REGISTRAR.BYOD]: new ByodAdapter(options),
  };
}

function resolveRegistrarForTld(rawTld) {
  const tld = normalizeTld(rawTld);
  if (!tld) return { tld, supported: false, registrar: null, reason: 'missing_tld' };
  if (UNSUPPORTED_TLDS.has(tld)) return { tld, supported: false, registrar: null, reason: 'restricted_tld' };
  return { tld, supported: true, registrar: REGISTRAR.OPENPROVIDER };
}

function groupTldsByRegistrar(tlds) {
  const groups = {
    [REGISTRAR.OPENPROVIDER]: [],
    unsupported: [],
  };

  for (const rawTld of tlds || []) {
    const route = resolveRegistrarForTld(rawTld);
    if (!route.supported) {
      groups.unsupported.push(route);
    } else {
      groups[route.registrar].push(route.tld);
    }
  }

  groups[REGISTRAR.OPENPROVIDER] = [...new Set(groups[REGISTRAR.OPENPROVIDER])];
  return groups;
}

function getAdapterForTld(tld, adapters = createDefaultAdapters()) {
  const route = resolveRegistrarForTld(tld);
  if (!route.supported) return null;
  return adapters[route.registrar] || null;
}

async function searchAvailableAcrossRegistrars(query, options = {}) {
  const defaultTlds = options.defaultTlds || DEFAULT_SEARCH_TLDS;
  const parsed = parseDomainSearchQuery(query, defaultTlds);
  const tlds = options.tlds || parsed.requestedTlds;
  const groups = groupTldsByRegistrar(tlds);
  const adapters = options.adapters || createDefaultAdapters(options);
  const searches = [];

  for (const registrar of [REGISTRAR.OPENPROVIDER]) {
    const routedTlds = groups[registrar];
    if (!routedTlds.length) continue;
    searches.push(adapters[registrar].searchAvailable(parsed.label || query, routedTlds));
  }

  const tldRank = new Map(tlds.map((tld, index) => [normalizeTld(tld), index]));
  const results = (await Promise.all(searches)).flat();
  return {
    query: String(query || ''),
    label: parsed.label,
    results: results.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (a.premium !== b.premium) return a.premium ? 1 : -1;
      const rankDelta = (tldRank.get(a.tld) ?? 999) - (tldRank.get(b.tld) ?? 999);
      if (rankDelta !== 0) return rankDelta;
      return (a.priceMinor || 0) - (b.priceMinor || 0);
    }),
    unsupported: groups.unsupported,
  };
}

module.exports = {
  REGISTRAR,
  UNSUPPORTED_TLDS,
  createDefaultAdapters,
  getAdapterForTld,
  groupTldsByRegistrar,
  resolveRegistrarForTld,
  searchAvailableAcrossRegistrars,
};

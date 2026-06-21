// Resolve the platform domain at runtime.
//
// History: most components do
//   process.env.NEXT_PUBLIC_PLATFORM_DOMAIN || 'sitepresso.com'
// which bakes the wrong fallback into the staging bundle whenever the
// env var isn't set at build time, so links like "View site" on staging
// silently point at *.sitepresso.com.
//
// This helper preserves the env-var path (still source of truth on the
// server / during SSR) but on the client also derives the platform
// domain from `window.location.hostname`, which IS correct by definition
// — the user is reading the page on whatever host the deploy serves.

const RESERVED_PLATFORM_PREFIXES = new Set(['app', 'www', 'admin']);

function normalizeHost(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/:\d+$/, '');
}

function isLoopbackHost(host) {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || String(host || '').toLowerCase().endsWith('.localhost');
}

// Return the bare platform domain. It also fixes already-prefixed values like
// app.sitepresso.com so callers never produce app.app.sitepresso.com.
function normalizePlatformDomain(value) {
  const host = normalizeHost(value);
  if (!host) return null;
  if (isLoopbackHost(host)) return 'localhost';

  const labels = host.split('.').filter(Boolean);
  while (labels.length > 2 && RESERVED_PLATFORM_PREFIXES.has(labels[0])) {
    labels.shift();
  }
  if (labels.length > 2) labels.shift();
  return labels.join('.');
}

const ENV_FALLBACK =
  normalizePlatformDomain(
    typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_PLATFORM_DOMAIN
  ) || 'sitepresso.com';

// Returns the bare platform domain (e.g. "aapkatech.com" on staging,
// "sitepresso.com" on prod). Resolution order:
//   1. window.location.hostname stripped of its first subdomain
//   2. NEXT_PUBLIC_PLATFORM_DOMAIN at build time
//   3. "sitepresso.com" hardcoded fallback
export function getPlatformDomain() {
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const fromWindow = normalizePlatformDomain(window.location.hostname);
    if (fromWindow) return fromWindow;
  }
  return ENV_FALLBACK;
}

// Build a URL on the unified-admin host (app.<platform-domain>).
// Used by login redirects from the marketing site and any link that
// wants to land in the new admin shell.
export function getUnifiedAdminUrl(path = '/') {
  const domain = getPlatformDomain();
  // localhost dev → no app. prefix; just use the current origin so links
  // keep working without env wrangling. Use a relative URL so SSR and the
  // browser hydrate the same href on 127.0.0.1 vs localhost.
  if (domain === 'localhost' || domain.startsWith('localhost:')) {
    return path.startsWith('/') ? path : `/${path}`;
  }
  return `https://app.${domain}${path.startsWith('/') ? path : `/${path}`}`;
}

// Build the public URL for a tenant's site. When an ACTIVE custom domain is
// passed it wins (so "View site" opens the customer's own domain); otherwise it
// falls back to the tenant subdomain (<slug>.<platform-domain>).
// Used by "View site" buttons from the admin shell.
export function getTenantStorefrontUrl(slug, path = '/', activeCustomDomain = null) {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (activeCustomDomain) {
    const host = normalizeHost(activeCustomDomain);
    if (host) return `https://${host}${cleanPath}`;
  }
  if (!slug) return null;
  const domain = getPlatformDomain();
  if (domain === 'localhost' || domain.startsWith('localhost:')) {
    // Local dev — single host, can't really model multi-tenant subdomains
    // without /etc/hosts trickery. Surface a query-param preview link
    // that the business app's TenantProvider already understands.
    if (typeof window !== 'undefined') {
      return `${window.location.origin}${path}?tenant=${encodeURIComponent(slug)}`;
    }
    return `http://localhost${path}?tenant=${encodeURIComponent(slug)}`;
  }
  return `https://${slug}.${domain}${path.startsWith('/') ? path : `/${path}`}`;
}

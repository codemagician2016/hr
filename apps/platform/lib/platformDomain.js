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

// Resolve the tenant HR-admin (app) host the SAME way platform middleware does
// (middleware.js → hrAdminBase): the live admin host is hyphenated on a
// sub-labelled deploy (staging.drifthr.com → app-staging.drifthr.com) and
// dotted on the apex (drifthr.com → app.drifthr.com). Deriving from the
// current hostname keeps the marketing host and the admin host in lock-step so
// redirects never point at a non-existent app.staging.drifthr.com (NXDOMAIN).
function hrAdminOrigin() {
  if (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_HR_ADMIN_URL) {
    return process.env.NEXT_PUBLIC_HR_ADMIN_URL.replace(/\/$/, '');
  }
  const raw = (typeof window !== 'undefined' && window.location?.hostname) || '';
  const host = normalizeHost(raw);
  if (!host || isLoopbackHost(host)) return null; // localhost dev → same-origin
  // Already on the admin host (app. / app-…)? Use it verbatim.
  if (host.startsWith('app.') || host.startsWith('app-')) return `https://${host}`;
  const firstDot = host.indexOf('.');
  if (firstDot <= 0) return 'https://app.drifthr.com';
  const sub = host.slice(0, firstDot);   // "staging"
  const apex = host.slice(firstDot + 1); // "drifthr.com"
  if (!apex.includes('.')) return `https://app.${host}`; // host was already an apex
  return `https://app-${sub}.${apex}`;
}

// Build a URL on the unified tenant-admin (hr-admin) host. Used by login +
// onboarding redirects from the marketing site to land in the admin shell.
// The admin app's dashboard lives at "/", so default the path to "/".
export function getUnifiedAdminUrl(path = '/') {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const origin = hrAdminOrigin();
  // localhost dev (or no resolvable host) → relative URL so SSR + browser
  // hydrate the same href on 127.0.0.1 vs localhost.
  if (!origin) return cleanPath;
  return `${origin}${cleanPath}`;
}

// True when the page is being served FROM the unified tenant-admin host
// (app.<domain> on prod, app-<sub>.<domain> on staging). Mirrors the
// middleware's isUnifiedAdminHost so page-level redirects agree with it.
export function isUnifiedAdminHost() {
  if (typeof window === 'undefined' || !window.location?.hostname) return false;
  const host = window.location.hostname.toLowerCase();
  return host.startsWith('app.') || host.startsWith('app-');
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

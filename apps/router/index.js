const http = require('http');
const httpProxy = require('http-proxy');
const Redis = require('ioredis');

const localHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: parseInt(process.env.ROUTER_MAX_SOCKETS || '4096', 10),
  maxFreeSockets: parseInt(process.env.ROUTER_MAX_FREE_SOCKETS || '512', 10),
  timeout: parseInt(process.env.ROUTER_SOCKET_TIMEOUT_MS || '60000', 10),
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
});
redis.on('error', () => {});

const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '5000', 10);

// Public-facing ports (storefront)
const PUBLIC_PORTS = {
  booking: 3001,
  shop:    3002,
  web:     3003,
};

// Sub-app ports per vertical + path prefix
// Tenant admin paths are intentionally not listed here. The operator console
// is canonical on app.<platform-domain>/dashboard, so /admin bookmarks should
// leave the tenant/custom host instead of selecting a per-vertical admin app.
const SUB_APP_PORTS = {
  booking: {
    staff:    3012,
    customer: 3013,
  },
  shop: {
    'staff/manager': 3022,
    'staff/delivery':3023,
    customer:        3024,
  },
  web: {
    staff:    3032,
    customer: 3033,
  },
};

// Customer-side path prefixes (not admin/staff)
// Wishlist stays on the public storefront — guests can have a wishlist via
// X-Cart-Session (same pattern as the cart). Routing /wishlist to the
// customer sub-app forced a 307 to /login for guests, even though they
// could add items just fine. Logged-in customers still get their items
// because the public storefront WishlistContext fetches the same backend.
const CUSTOMER_PATHS = {
  booking: ['dashboard'],
  shop:    ['account', 'orders'],
  web:     ['enquiries'],
};

// Asset-prefix routing. A non-public sub-app (e.g. the customer portal at
// /account) sets `assetPrefix` in its next.config so its /_next/* chunks load
// under one of these prefixes; route the whole prefix back to that sub-app.
// Without it /customer-static/* falls through to the public storefront → 404
// → unstyled, un-hydrated page (the "Loading account…" hang that breaks
// login). The first path segment maps to a SUB_APP_PORTS key; honoured only
// when that key exists for the resolved vertical. Keep in sync with each
// non-public sub-app's next.config assetPrefix (mirrors the CF worker).
const ASSET_PREFIX_SUBAPP = {
  'customer-static': 'customer',
  'staff-static':    'staff',
  'manager-static':  'staff/manager',
  'delivery-static': 'staff/delivery',
};

const PLATFORM_PORT = parseInt(process.env.PLATFORM_PORT || '3000', 10);
const MOBILE_PORT = parseInt(process.env.MOBILE_PORT || '3025', 10);
const QA_PORTAL_PORT = parseInt(process.env.QA_PORTAL_PORT || '3801', 10);
const PUBLIC_MICROCACHE_TTL_SECONDS = parseInt(process.env.PUBLIC_MICROCACHE_TTL_SECONDS || '300', 10);
const PUBLIC_MICROCACHE_MAX_BYTES = parseInt(process.env.PUBLIC_MICROCACHE_MAX_BYTES || String(2 * 1024 * 1024), 10);
const TENANT_ADMIN_PATH_RE = /^\/admin(?:\/|$)/;
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'admin', 'app', 'mail', 'platform', 'm', 'test']);
// Standalone app hosts are handled by their own domains or tunnel ingress now;
// only the QA portal (`test`) is still routed off the Sitepresso platform domain.
const STANDALONE_PRODUCT_PORTS = {
  test: QA_PORTAL_PORT,
};

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  agent: localHttpAgent,
  proxyTimeout: parseInt(process.env.ROUTER_PROXY_TIMEOUT_MS || '15000', 10),
  timeout: parseInt(process.env.ROUTER_INCOMING_TIMEOUT_MS || '16000', 10),
});
proxy.on('error', (_err, _req, res) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, { 'Content-Type': 'text/plain' });
  res.end('Bad gateway');
});

function hasPrivateCookie(cookieHeader) {
  return /(^|;\s*)(ae_|connect\.sid|session|token)/i.test(String(cookieHeader || ''));
}

function microcacheLocaleKey(cookieHeader, acceptLanguage) {
  const cookie = String(cookieHeader || '');
  const explicit = cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1];
  if (explicit) return explicit;
  const preferred = String(acceptLanguage || '').split(',')[0].trim().toLowerCase();
  return preferred ? preferred.slice(0, 32).replace(/[^a-z0-9-]/g, '') : 'default';
}

function publicMicrocacheKey(host, url, cookieHeader, acceptLanguage) {
  const cleanHost = (host || '').toLowerCase().split(':')[0];
  let pathname = '/';
  let search = '';
  try {
    const parsed = new URL(url || '/', `http://${host || cleanHost || 'localhost'}`);
    pathname = parsed.pathname || '/';
    search = parsed.search || '';
  } catch {}

  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  const isApexHost = cleanHost === platformDomain || cleanHost === `www.${platformDomain}`;
  const isAuthShellHost = cleanHost === `app.${platformDomain}` || cleanHost === `admin.${platformDomain}`;
  const isApiHost = cleanHost === `api.${platformDomain}`;
  const isApexCachePath = (
    pathname === '/' ||
    pathname === '/blog' ||
    pathname.startsWith('/blog/') ||
    pathname === '/legal' ||
    pathname.startsWith('/legal/') ||
    pathname === '/sitemap.xml' ||
    pathname === '/robots.txt'
  );
  const isAuthShellCachePath = (
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/forgot-password'
  );
  const isApiCachePath = pathname === '/api/subscription/paddle-config';

  if (
    (!isApexHost || !isApexCachePath) &&
    (!isAuthShellHost || !isAuthShellCachePath) &&
    (!isApiHost || !isApiCachePath)
  ) {
    return null;
  }
  if (hasPrivateCookie(cookieHeader)) return null;
  const locale = microcacheLocaleKey(cookieHeader, acceptLanguage);
  return `public-microcache:v1:${cleanHost}:${locale}:${pathname}${search}`;
}

// Private/dynamic paths that must never be edge-cached even when they resolve to
// the public storefront app: cart/checkout/order are per-session, /account &
// /orders are customer-scoped, /api & /_next/data carry request state.
const STOREFRONT_NO_CACHE_PREFIXES = [
  '/api', '/_next/data', '/cart', '/checkout', '/wishlist',
  '/shop/cart', '/shop/checkout', '/shop/order', '/account', '/orders', '/enquiries',
];

function isPublicStorefrontPath(pathname) {
  return !STOREFRONT_NO_CACHE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// True when the request carries no personalizing cookie — only the benign
// NEXT_LOCALE (which is folded into the cache key) or nothing at all. Anything
// else (cart/location/auth) means the page may be personalized → don't cache.
function onlyLocaleCookie(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .every((c) => /^NEXT_LOCALE=/i.test(c));
}

// Tenant storefront microcache key. Unlike publicMicrocacheKey (which only
// allowlisted the apex marketing host), this caches the ANONYMOUS storefront SSR
// shell for any tenant — but ONLY when the route resolved to the PUBLIC
// storefront app for its vertical (never staff/customer sub-apps, standalone
// products, or the backend — those use different ports / no vertical), the path
// is public, and no personalizing cookie is present. Per-user data (cart,
// account) is fetched client-side after hydration, so the SSR shell is identical
// for all anonymous visitors and safe to share from the edge.
function storefrontMicrocacheKey(route, host, url, cookieHeader, acceptLanguage) {
  if (!route || !route.vertical) return null;
  const publicPort = PUBLIC_PORTS[route.vertical];
  if (!publicPort || route.target !== `http://localhost:${publicPort}`) return null;
  if (hasPrivateCookie(cookieHeader) || !onlyLocaleCookie(cookieHeader)) return null;

  const cleanHost = (host || '').toLowerCase().split(':')[0];
  let pathname = '/';
  let search = '';
  try {
    const parsed = new URL(url || '/', `http://${host || cleanHost || 'localhost'}`);
    pathname = parsed.pathname || '/';
    search = parsed.search || '';
  } catch {}
  if (!isPublicStorefrontPath(pathname)) return null;

  const locale = microcacheLocaleKey(cookieHeader, acceptLanguage);
  return `public-microcache:v1:${cleanHost}:${locale}:${pathname}${search}`;
}

function cacheablePublicResponse(headers, statusCode, bodyLength) {
  if (statusCode !== 200) return false;
  if (bodyLength > PUBLIC_MICROCACHE_MAX_BYTES) return false;
  const contentType = String(headers['content-type'] || '').toLowerCase();
  return (
    contentType.includes('text/html') ||
    contentType.includes('application/xml') ||
    contentType.includes('application/json') ||
    contentType.includes('text/xml') ||
    contentType.includes('text/plain')
  );
}

function publicCacheHeaders(headers, cacheState) {
  const out = { ...headers };
  delete out['set-cookie'];
  delete out['x-middleware-set-cookie'];
  delete out['transfer-encoding'];
  delete out['content-encoding'];
  out['cache-control'] = `public, max-age=60, s-maxage=${PUBLIC_MICROCACHE_TTL_SECONDS}, stale-while-revalidate=86400`;
  out['cdn-cache-control'] = `public, max-age=${PUBLIC_MICROCACHE_TTL_SECONDS}, stale-while-revalidate=86400`;
  out['cloudflare-cdn-cache-control'] = `public, max-age=${PUBLIC_MICROCACHE_TTL_SECONDS}, stale-while-revalidate=86400`;
  out['vary'] = 'Accept-Encoding';
  out['x-sitepresso-cache'] = cacheState;
  return out;
}

async function servePublicMicrocache(req, res, target, cacheKey) {
  if (!cacheKey || !Number.isFinite(PUBLIC_MICROCACHE_TTL_SECONDS) || PUBLIC_MICROCACHE_TTL_SECONDS <= 0) {
    return false;
  }

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      const body = Buffer.from(parsed.body || '', 'base64');
      const headers = publicCacheHeaders(parsed.headers || {}, 'HIT');
      headers['content-length'] = String(body.length);
      res.writeHead(parsed.statusCode || 200, headers);
      if (req.method !== 'HEAD') res.end(body);
      else res.end();
      return true;
    } catch {}
  }

  const targetUrl = new URL(req.url || '/', target);
  const upstreamHeaders = { ...req.headers };
  upstreamHeaders.host = targetUrl.host;
  upstreamHeaders['x-forwarded-host'] = req.headers.host || '';
  upstreamHeaders['x-tenant-host'] = req.headers.host || '';
  upstreamHeaders['x-sitepresso-host'] = req.headers.host || '';
  upstreamHeaders['accept-encoding'] = 'identity';
  delete upstreamHeaders.connection;
  delete upstreamHeaders['content-length'];

  const response = await new Promise((resolve, reject) => {
    const upstreamReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: 'GET',
        headers: upstreamHeaders,
        agent: localHttpAgent,
        timeout: 12000,
      },
      (upstreamRes) => {
        const chunks = [];
        let size = 0;
        upstreamRes.on('data', (chunk) => {
          size += chunk.length;
          if (size <= PUBLIC_MICROCACHE_MAX_BYTES) chunks.push(chunk);
        });
        upstreamRes.on('end', () => {
          resolve({
            statusCode: upstreamRes.statusCode || 502,
            headers: upstreamRes.headers || {},
            body: Buffer.concat(chunks),
            tooLarge: size > PUBLIC_MICROCACHE_MAX_BYTES,
          });
        });
      }
    );
    upstreamReq.on('error', reject);
    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('public microcache upstream timeout'));
    });
    upstreamReq.end();
  });

  const headers = publicCacheHeaders(response.headers, 'MISS');
  headers['content-length'] = String(response.body.length);
  res.writeHead(response.statusCode, headers);
  if (req.method !== 'HEAD') res.end(response.body);
  else res.end();

  if (!response.tooLarge && cacheablePublicResponse(response.headers, response.statusCode, response.body.length)) {
    const payload = JSON.stringify({
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body.toString('base64'),
    });
    redis.set(cacheKey, payload, 'EX', PUBLIC_MICROCACHE_TTL_SECONDS).catch(() => {});
  }

  return true;
}

function resolveSubAppPort(vertical, pathname) {
  const stripped = pathname.replace(/^\//, '');                 // remove leading /
  const subPorts = SUB_APP_PORTS[vertical] || {};

  // Asset-prefix routing FIRST — keep a sub-app's /_next/* chunks with the
  // sub-app that rendered the HTML (else customer/staff pages render unstyled
  // and never hydrate). Can't be shadowed by a tenant path sharing a segment.
  const assetKey = ASSET_PREFIX_SUBAPP[stripped.split('/')[0]];
  if (assetKey && subPorts[assetKey]) {
    return subPorts[assetKey];
  }

  // Check staff/customer path prefixes (longest match first)
  for (const [prefix, port] of Object.entries(subPorts).sort((a, b) => b[0].length - a[0].length)) {
    if (stripped === prefix || stripped.startsWith(prefix + '/')) {
      return port;
    }
  }

  // Check customer paths
  const customerPaths = CUSTOMER_PATHS[vertical] || [];
  for (const prefix of customerPaths) {
    if (stripped === prefix || stripped.startsWith(prefix + '/')) {
      return subPorts.customer || PUBLIC_PORTS[vertical];
    }
  }

  // Default → public storefront
  return PUBLIC_PORTS[vertical] || PLATFORM_PORT;
}

function platformTenantSlug(host) {
  const cleanHost = (host || '').toLowerCase().split(':')[0];
  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  const suffix = `.${platformDomain}`;
  if (!cleanHost.endsWith(suffix)) return null;

  const slug = cleanHost.slice(0, -suffix.length);
  if (!slug || slug.includes('.') || RESERVED_SUBDOMAINS.has(slug)) return null;
  return slug;
}

function platformSubdomainForHost(cleanHost, platformDomain) {
  const host = (cleanHost || '').toLowerCase().split(':')[0];
  const apex = (platformDomain || '').toLowerCase();
  if (!host || !apex) return null;
  if (host === apex) return '';
  const suffix = `.${apex}`;
  if (!host.endsWith(suffix)) return null;
  return host.slice(0, -suffix.length);
}

function pathStartsWith(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function pathNeedsTenantSlug(vertical, pathname, target) {
  let port = null;
  try {
    port = Number(new URL(target).port || 80);
  } catch {
    return false;
  }

  // These sub-apps keep their app-router pages under /:slug/... internally
  // while the public tenant URL remains clean, e.g. /staff.
  if ((vertical === 'booking' || vertical === 'web') && port === SUB_APP_PORTS[vertical]?.staff) {
    return pathStartsWith(pathname, '/staff');
  }
  if (vertical === 'shop' && port === SUB_APP_PORTS.shop['staff/manager']) {
    return pathStartsWith(pathname, '/staff/manager');
  }
  if (vertical === 'shop' && port === SUB_APP_PORTS.shop['staff/delivery']) {
    return pathStartsWith(pathname, '/staff/delivery');
  }
  if (vertical === 'web' && port === SUB_APP_PORTS.web.customer) {
    return pathStartsWith(pathname, '/enquiries');
  }

  return false;
}

function tenantScopedUrl(host, url, vertical, target) {
  const slug = platformTenantSlug(host);
  if (!slug) return url;

  const parsed = new URL(url || '/', `http://${host || 'localhost'}`);
  if (!pathNeedsTenantSlug(vertical, parsed.pathname, target)) return url;

  parsed.pathname = `/${slug}${parsed.pathname}`;
  return `${parsed.pathname}${parsed.search}`;
}

async function lookupVerticalFromBackend(slug, { host = null } = {}) {
  return new Promise((resolve) => {
    const query = host
      ? `host=${encodeURIComponent(host)}`
      : `slug=${encodeURIComponent(slug)}`;
    const req = http.request(
      { hostname: 'localhost', port: BACKEND_PORT, path: `/api/internal/tenant-vertical?${query}`, method: 'GET', agent: localHttpAgent },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data).vertical || null); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function lookupDomainRouteFromBackend(host) {
  const cleanHost = (host || '').toLowerCase().split(':')[0];
  const cacheKey = `domain-route:${cleanHost}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: BACKEND_PORT, path: `/api/internal/domain-route?host=${encodeURIComponent(cleanHost)}`, method: 'GET', agent: localHttpAgent },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const parsed = JSON.parse(data);
            redis.set(cacheKey, JSON.stringify(parsed), 'EX', 60).catch(() => {});
            resolve(parsed);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function domainRedirectUrl(host, requestUrl, route) {
  if (!route?.targetHost) return null;
  const cleanHost = (host || '').toLowerCase().split(':')[0];
  const incomingPort = (host || '').includes(':') ? (host || '').split(':').pop() : '';
  const targetHost = incomingPort && !String(route.targetHost).includes(':')
    ? `${route.targetHost}:${incomingPort}`
    : route.targetHost;
  const parsed = new URL(requestUrl || '/', `http://${host || cleanHost}`);
  parsed.host = targetHost;
  return parsed.toString();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unknownSiteHtml(host, platformDomain) {
  const safeHost = escapeHtml(host);
  const homeUrl = `https://${platformDomain || 'sitepresso.com'}/`;
  const loginUrl = `https://app.${platformDomain || 'sitepresso.com'}/login`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>No site connected | Sitepresso</title>
  <style>
    :root { color-scheme: light; --ink: #111827; --muted: #667085; --line: #d9e2ec; --bg: #f7faf8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: radial-gradient(circle at top left, #e5fff2 0, #f6fbff 34%, #ffffff 70%); }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 72px 0 44px; }
    .panel { min-height: 420px; border: 1px solid var(--line); border-radius: 24px; background: linear-gradient(135deg, rgba(230, 255, 244, .92), rgba(255, 255, 255, .95)); box-shadow: 0 24px 70px rgba(15, 23, 42, .08); display: grid; place-items: center; text-align: center; padding: 48px 24px; }
    .brand { display: inline-flex; align-items: center; justify-content: center; margin-bottom: 28px; }
    .sitepresso-logo { display: block; width: min(248px, 72vw); height: auto; }
    .eyebrow { margin: 0 0 14px; color: #52606d; font-size: 13px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0 auto; max-width: 760px; font-size: clamp(36px, 6vw, 64px); line-height: 1.02; letter-spacing: 0; }
    .lead { margin: 22px auto 0; max-width: 680px; color: var(--muted); font-size: 18px; line-height: 1.65; }
    code { display: inline-block; border: 1px solid #d5dde7; border-radius: 8px; background: rgba(255, 255, 255, .76); padding: 2px 7px; color: #1f2937; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; margin-top: 34px; }
    a { color: inherit; }
    .button { min-width: 172px; border: 2px solid #0b1220; border-radius: 999px; background: #0b1220; color: white; padding: 14px 24px; font-weight: 800; text-decoration: none; }
    .button.secondary { background: transparent; color: #0b1220; }
    .notes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; margin-top: 46px; }
    .note h2 { margin: 0 0 10px; font-size: 20px; }
    .note p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
    footer { margin-top: 54px; text-align: center; color: #7b8794; font-size: 13px; }
    @media (max-width: 760px) { main { padding-top: 36px; } .panel { min-height: 0; border-radius: 18px; padding: 38px 18px; } .lead { font-size: 16px; } .actions { flex-direction: column; } .button { width: 100%; } .notes { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <section class="panel" aria-labelledby="missing-site-title">
      <div>
        <div class="brand" aria-label="Sitepresso">
          <svg class="sitepresso-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 140" role="img" aria-labelledby="sitepresso-logo-title">
            <title id="sitepresso-logo-title">Sitepresso</title>
            <defs>
              <linearGradient id="missing-site-logo-g1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#8B5CF6"/>
                <stop offset="100%" stop-color="#4C1D95"/>
              </linearGradient>
              <linearGradient id="missing-site-logo-steam" x1="0%" y1="100%" x2="0%" y2="0%">
                <stop offset="0%" stop-color="#8B5CF6" stop-opacity="0.6"/>
                <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <path d="M 38 22 Q 32 14 38 6" stroke="url(#missing-site-logo-steam)" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>
            <path d="M 52 24 Q 58 14 52 4" stroke="url(#missing-site-logo-steam)" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>
            <path d="M 66 22 Q 60 14 66 6" stroke="url(#missing-site-logo-steam)" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>
            <g transform="translate(20,30)">
              <rect x="4" y="8" width="64" height="68" rx="10" fill="url(#missing-site-logo-g1)"/>
              <rect x="4" y="8" width="64" height="14" rx="10" fill="#1E1B4B"/>
              <rect x="4" y="16" width="64" height="6" fill="#1E1B4B"/>
              <circle cx="12" cy="15" r="2" fill="#A78BFA"/>
              <circle cx="20" cy="15" r="2" fill="#C4B5FD"/>
              <circle cx="28" cy="15" r="2" fill="#EDE9FE"/>
              <path d="M 38 30 L 28 50 L 36 50 L 32 66 L 46 44 L 38 44 L 42 30 Z" fill="#FFFFFF"/>
              <path d="M 68 30 Q 88 30 88 48 Q 88 64 68 64" stroke="url(#missing-site-logo-g1)" stroke-width="6" fill="none" stroke-linecap="round"/>
              <ellipse cx="36" cy="82" rx="40" ry="4" fill="#1E1B4B" opacity="0.9"/>
            </g>
            <text x="125" y="82" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="42" font-weight="800" fill="#1E1B4B" letter-spacing="-1.5">
              site<tspan fill="url(#missing-site-logo-g1)">presso</tspan>
            </text>
            <text x="126" y="106" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="11" font-weight="500" fill="#6B7280" letter-spacing="2">
              WEBSITES IN 5 MINUTES
            </text>
          </svg>
        </div>
        <p class="eyebrow">Site address unavailable</p>
        <h1 id="missing-site-title">No Sitepresso site is connected at this address.</h1>
        <p class="lead">The address <code>${safeHost}</code> does not currently point to a published Sitepresso storefront or website. If you expected a store, check the spelling or contact the business owner.</p>
        <div class="actions">
          <a class="button" href="${homeUrl}">Go to Sitepresso</a>
          <a class="button secondary" href="${loginUrl}">Sign in</a>
        </div>
      </div>
    </section>
    <section class="notes" aria-label="Helpful next steps">
      <div class="note"><h2>Looking for a store?</h2><p>Store addresses are created by each business. A small spelling change can open a different address.</p></div>
      <div class="note"><h2>Managing your site?</h2><p>Sign in to connect a domain, publish your storefront, or check your Sitepresso subdomain.</p></div>
      <div class="note"><h2>New to Sitepresso?</h2><p>Visit the main Sitepresso site to see the current product and setup options.</p></div>
    </section>
    <footer>HTTP 404 - This page is not indexed by search engines.</footer>
  </main>
</body>
</html>`;
}

function tenantNotFoundRoute(host, platformDomain) {
  return {
    statusCode: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
    body: unknownSiteHtml(host, platformDomain),
  };
}

async function resolveRoute(host, url, referer) {
  const cleanHost = (host || '').toLowerCase().split(':')[0];
  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  const subdomain = platformSubdomainForHost(cleanHost, platformDomain);
  const isPlatformHost = subdomain !== null;
  const pathname = (url || '/').split('?')[0];

  if (isPlatformHost && STANDALONE_PRODUCT_PORTS[subdomain]) {
    return { target: `http://localhost:${STANDALONE_PRODUCT_PORTS[subdomain]}` };
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return { target: `http://localhost:${BACKEND_PORT}` };
  }

  if (!isPlatformHost) {
    const cacheKey = `vertical:custom:${cleanHost}`;
    let customVertical = await redis.get(cacheKey).catch(() => null);
    if (!customVertical || !PUBLIC_PORTS[customVertical]) {
      const route = await lookupDomainRouteFromBackend(cleanHost);
      customVertical = route?.action === 'serve' ? route.vertical : null;
      if (!customVertical) {
        customVertical = await lookupVerticalFromBackend(cleanHost, { host: cleanHost });
      }
      if (customVertical && PUBLIC_PORTS[customVertical]) {
        redis.set(cacheKey, customVertical, 'EX', 60).catch(() => {});
      }
    }
    if (customVertical && PUBLIC_PORTS[customVertical]) {
      return { target: `http://localhost:${resolveSubAppPort(customVertical, pathname)}`, vertical: customVertical };
    }
    return tenantNotFoundRoute(cleanHost, platformDomain);
  }

  // Mobile web app host. It resolves tenant + role from the path:
  //   m.aapkatech.com/:tenant
  //   m.ecom.aapkatech.com/:tenant/pos
  if (subdomain === 'm') {
    return { target: `http://localhost:${MOBILE_PORT}` };
  }

  if (!subdomain || RESERVED_SUBDOMAINS.has(subdomain)) {
    return { target: `http://localhost:${PLATFORM_PORT}` };
  }

  // 60 s TTL — vertical rarely changes, but when it does (tenant deleted
  // and re-created on a different vertical, etc.) we don't want a 24 h
  // stale value sending traffic to the wrong app. The backend lookup is a
  // single indexed query, so 1× per minute per slug is cheap.
  let vertical = await redis.get(`vertical:${subdomain}`).catch(() => null);
  if (!vertical || !PUBLIC_PORTS[vertical]) {
    vertical = await lookupVerticalFromBackend(subdomain);
    if (vertical && PUBLIC_PORTS[vertical]) {
      redis.set(`vertical:${subdomain}`, vertical, 'EX', 60).catch(() => {});
    }
  }

  if (!vertical || !PUBLIC_PORTS[vertical]) {
    return tenantNotFoundRoute(cleanHost, platformDomain);
  }

  // /_next/ static assets have no sub-app context in their own path.
  // Use the Referer header (the page that loaded the asset) to route them
  // to whichever sub-app owns that page — otherwise customer-sub-app assets
  // fall through to the public storefront and return 404.
  let routingPath = pathname;
  if (pathname.startsWith('/_next/') && referer) {
    try {
      routingPath = new URL(referer).pathname;
    } catch {}
  }

  const port = resolveSubAppPort(vertical, routingPath);
  return { target: `http://localhost:${port}`, vertical };
}

async function resolveTarget(host, url, referer) {
  const route = await resolveRoute(host, url, referer);
  if (!route.target) throw new Error(route.body || 'Route not proxyable');
  return route.target;
}

// The admin.<platform-domain> host is an OPERATOR-ONLY entry point: it must
// expose the super-admin login + console, never the marketing landing or any
// tenant/business page. The platform app's own middleware enforces this, but
// only when it can see the real Host — and behind the cloudflared tunnel this
// router proxies with changeOrigin (Host rewritten to localhost), so that guard
// never fires. We therefore enforce it here at the edge of the box, where the
// true Host is still intact. Everything except the explicit allow-list (and
// API / Next internals / static assets) 302s to /login.
const ADMIN_HOST_ALLOWED_PREFIXES = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/superadmin',
  '/__connect',   // OAuth callback popups
  '/business',    // post-login SUPER_ADMIN role redirect
];

function adminHostLoginRedirectUrl(host, requestUrl) {
  const cleanHost = (host || '').toLowerCase().split(':')[0];
  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  if (cleanHost !== `admin.${platformDomain}`) return null;

  const pathname = (requestUrl || '/').split('?')[0];
  // Never touch API, Next internals, or static assets (login page needs them).
  if (pathname === '/api' || pathname.startsWith('/api/')) return null;
  if (pathname.startsWith('/_next/') || pathname.startsWith('/__next')) return null;
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return null; // favicon.ico, *.png, *.css …
  if (ADMIN_HOST_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const protocol = process.env.ROUTER_REDIRECT_PROTOCOL || 'https';
  const incomingPort = (host || '').includes(':') ? `:${(host || '').split(':').pop()}` : '';
  return `${protocol}://${cleanHost}${platformDomain === 'localhost' ? incomingPort : ''}/login`;
}

function hasOperatorCookie(cookieHeader) {
  return /(?:^|;\s*)ae_operator(?:_[^=;]*)?=/.test(String(cookieHeader || ''));
}

function unauthenticatedDashboardRedirectUrl(host, requestUrl, cookieHeader) {
  if (hasOperatorCookie(cookieHeader)) return null;

  const cleanHost = (host || '').toLowerCase().split(':')[0];
  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  if (cleanHost !== `app.${platformDomain}`) return null;

  const parsed = new URL(requestUrl || '/', `http://${host || cleanHost}`);
  if (parsed.pathname !== '/dashboard' && !parsed.pathname.startsWith('/dashboard/')) return null;

  const protocol = process.env.ROUTER_REDIRECT_PROTOCOL || 'https';
  const incomingPort = (host || '').includes(':') ? `:${(host || '').split(':').pop()}` : '';
  const login = new URL(`${protocol}://${cleanHost}${platformDomain === 'localhost' ? incomingPort : ''}/login`);
  login.searchParams.set('redirect', `${parsed.pathname}${parsed.search || ''}`);
  return login.toString();
}

function unifiedAdminRedirectUrl(host, requestUrl) {
  const cleanHost = (host || '').toLowerCase().split(':')[0];
  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  const subdomain = platformSubdomainForHost(cleanHost, platformDomain);
  const isPlatformHost = subdomain !== null;
  const base = `http://${host || `app.${platformDomain}`}`;
  const parsed = new URL(requestUrl || '/', base);

  if (!TENANT_ADMIN_PATH_RE.test(parsed.pathname)) return null;
  if (isPlatformHost && (!subdomain || RESERVED_SUBDOMAINS.has(subdomain))) return null;

  const protocol = process.env.ROUTER_REDIRECT_PROTOCOL || 'https';
  const incomingPort = (host || '').includes(':') ? (host || '').split(':').pop() : '';
  const targetHost = platformDomain === 'localhost' && incomingPort
    ? `app.${platformDomain}:${incomingPort}`
    : `app.${platformDomain}`;
  const target = new URL(`${protocol}://${targetHost}/dashboard`);
  target.search = parsed.search;
  return target.toString();
}

const server = http.createServer(async (req, res) => {
  try {
    const cleanHost = (req.headers.host || '').toLowerCase().split(':')[0];
    const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
    const isPlatformHost = cleanHost === platformDomain || cleanHost.endsWith(`.${platformDomain}`);
    const microcacheKey = (req.method === 'GET' || req.method === 'HEAD')
      ? publicMicrocacheKey(req.headers.host, req.url, req.headers.cookie, req.headers['accept-language'])
      : null;
    if (!isPlatformHost) {
      const route = await lookupDomainRouteFromBackend(req.headers.host);
      if (route?.action === 'redirect') {
        const target = domainRedirectUrl(req.headers.host, req.url, route);
        if (target) {
          res.writeHead(route.statusCode || 301, { Location: target });
          res.end();
          return;
        }
      }
    }

    // Operator-only admin host: lock it to the super-admin login/console.
    const adminLogin = adminHostLoginRedirectUrl(req.headers.host, req.url);
    if (adminLogin) {
      res.writeHead(302, { Location: adminLogin });
      res.end();
      return;
    }

    const dashboardLogin = unauthenticatedDashboardRedirectUrl(req.headers.host, req.url, req.headers.cookie);
    if (dashboardLogin) {
      res.writeHead(302, { Location: dashboardLogin, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const redirect = unifiedAdminRedirectUrl(req.headers.host, req.url);
    if (redirect) {
      res.writeHead(302, { Location: redirect });
      res.end();
      return;
    }

    const route = await resolveRoute(req.headers.host, req.url, req.headers.referer);
    if (!route.target) {
      res.writeHead(route.statusCode || 404, route.headers || { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(route.body || 'Not found');
      return;
    }
    // Microcache key: the early host-based one (apex/auth/api allowlist) OR — now
    // that the route is resolved — a tenant-storefront key when it landed on the
    // PUBLIC storefront app. Storefronts were never edge-cached before, so every
    // anonymous page view hit the SSR origin; this serves them from Redis and
    // emits public cache-control so Cloudflare caches them at the edge too.
    let effectiveCacheKey = microcacheKey;
    if (!effectiveCacheKey && (req.method === 'GET' || req.method === 'HEAD')) {
      effectiveCacheKey = storefrontMicrocacheKey(route, req.headers.host, req.url, req.headers.cookie, req.headers['accept-language']);
    }
    if (effectiveCacheKey && await servePublicMicrocache(req, res, route.target, effectiveCacheKey)) {
      return;
    }
    const { target, vertical } = route;
    // changeOrigin rewrites Host to the sub-app target, so the real tenant host
    // must be forwarded explicitly. Sub-app SSR (web/booking/shop) resolves the
    // tenant from x-tenant-host / x-sitepresso-host. In production this was the
    // Cloudflare Worker's job; on EC2-behind-tunnel this router owns it, so set
    // the tenant host on EVERY proxied request, not just /api.
    const tenantHost = req.headers.host || '';
    req.headers['x-tenant-host'] = tenantHost;
    req.headers['x-sitepresso-host'] = tenantHost;
    if (vertical) {
      req.url = tenantScopedUrl(req.headers.host, req.url, vertical, target);
    }
    proxy.web(req, res, { target });
  } catch {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Router error');
  }
});

// WebSocket upgrade (for Next.js HMR in dev)
server.on('upgrade', async (req, socket, head) => {
  const target = await resolveTarget(req.headers.host, req.url, req.headers.referer).catch(
    () => `http://localhost:${PLATFORM_PORT}`
  );
  proxy.ws(req, socket, head, { target });
});

const PORT = parseInt(process.env.PORT || '3099', 10);
server.keepAliveTimeout = parseInt(process.env.ROUTER_KEEP_ALIVE_TIMEOUT_MS || '65000', 10);
server.headersTimeout = parseInt(process.env.ROUTER_HEADERS_TIMEOUT_MS || '66000', 10);
server.requestTimeout = parseInt(process.env.ROUTER_REQUEST_TIMEOUT_MS || '120000', 10);
server.listen(PORT, () => console.log(`[router] listening on :${PORT}`));

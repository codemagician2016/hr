/**
 * Cloudflare Worker — SitePresso subdomain router
 *
 * Routes tenant subdomains → the correct Vercel project, for BOTH
 * environments off a single Worker (host-aware):
 *   • staging  → *.aapkatech.com   → api.aapkatech.com  + sitepresso-*       projects
 *   • prod     → *.sitepresso.com  → api.sitepresso.com + sitepresso-prod-*  projects
 *
 * The environment is derived from the request hostname, so the same
 * Worker is attached to both zone routes (see wrangler.toml).
 */

// Per-environment config. Keyed by platform apex domain.
const ENVS = {
  'aapkatech.com': {
    BACKEND_API: 'https://api.aapkatech.com',
    PLATFORM_DOMAIN: 'app.aapkatech.com',
    PLATFORM_VERCEL: 'https://sitepresso-platform.vercel.app',
    VERCEL_URLS: {
      booking: {
        public:   'https://sitepresso-business.vercel.app',
        staff:    'https://sitepresso-booking-staff.vercel.app',
        customer: 'https://sitepresso-booking-customer.vercel.app',
      },
      shop: {
        public:          'https://sitepresso-shop-public.vercel.app',
        'staff/manager': 'https://sitepresso-shop-manager.vercel.app',
        'staff/delivery':'https://sitepresso-shop-delivery.vercel.app',
        customer:        'https://sitepresso-shop-customer.vercel.app',
      },
      web: {
        public:   'https://sitepresso-web-public.vercel.app',
        staff:    'https://sitepresso-web-staff.vercel.app',
        customer: 'https://sitepresso-web-customer.vercel.app',
      },
    },
  },
  'sitepresso.com': {
    BACKEND_API: 'https://api.sitepresso.com',
    PLATFORM_DOMAIN: 'app.sitepresso.com',
    PLATFORM_VERCEL: 'https://sitepresso-prod-platform.vercel.app',
    VERCEL_URLS: {
      booking: {
        public:   'https://sitepresso-prod-booking-public.vercel.app',
        staff:    'https://sitepresso-prod-booking-staff.vercel.app',
        customer: 'https://sitepresso-prod-booking-customer.vercel.app',
      },
      shop: {
        public:          'https://sitepresso-prod-shop-public.vercel.app',
        'staff/manager': 'https://sitepresso-prod-shop-manager.vercel.app',
        'staff/delivery':'https://sitepresso-prod-shop-delivery.vercel.app',
        customer:        'https://sitepresso-prod-shop-customer.vercel.app',
      },
      web: {
        public:   'https://sitepresso-prod-web-public.vercel.app',
        staff:    'https://sitepresso-prod-web-staff.vercel.app',
        customer: 'https://sitepresso-prod-web-customer.vercel.app',
      },
    },
  },
};

const CUSTOMER_PATHS = {
  booking: ['dashboard'],
  shop:    ['account', 'orders'],
  web:     ['enquiries'],
};

// Static-asset namespaces. Every sub-app shares one tenant host, but each is
// a separate Vercel build with its own /_next/* hashes. A non-public sub-app
// (e.g. customer at /account) sets `assetPrefix` in its next.config so its
// chunks load under one of these prefixes; we route the whole prefix to that
// sub-app. Without it /_next/* falls through to `public` → 404 → unstyled
// page. Vertical-agnostic: the prefix maps to a sub-app KEY, and
// resolveSubAppKey only honours it if that key exists for the resolved
// vertical (so e.g. manager-static is a no-op outside `shop`). Keep in sync
// with `assetPrefix` in each non-public sub-app's next.config.js.
const ASSET_PREFIX_SUBAPP = {
  'customer-static': 'customer',
  'staff-static':    'staff',
  'manager-static':  'staff/manager',
  'delivery-static': 'staff/delivery',
};

const RESERVED = new Set(['www', 'api', 'admin', 'app', 'mail', 'platform', 'm']);
const TENANT_ADMIN_PATH_RE = /^\/admin(?:\/|$)/;

// KV namespace bound as ROUTER_CACHE in worker settings (60s TTL)
// If not available, falls back to direct API call every time.

// Pick the env config for a request host (e.g. shreya.sitepresso.com).
function resolveEnvForHost(host) {
  for (const apex of Object.keys(ENVS)) {
    if (host === apex || host.endsWith(`.${apex}`)) {
      return { apex, cfg: ENVS[apex] };
    }
  }
  return null;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unknownSiteHtml(host, apex = 'sitepresso.com') {
  const safeHost = escapeHtml(host);
  const homeUrl = `https://${apex}/`;
  const loginUrl = `https://app.${apex}/login`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>No site connected | Sitepresso</title>
  <style>
    :root { color-scheme: light; --ink: #111827; --muted: #667085; --line: #d9e2ec; }
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

function tenantNotFoundResponse(host, apex) {
  return new Response(unknownSiteHtml(host, apex), {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function resolveSubAppKey(vertical, pathname, vercelUrls) {
  const stripped = pathname.replace(/^\//, '');
  const subApps = vercelUrls[vertical] || {};

  // Asset-prefix routing: keep a sub-app's /_next/* chunks with the sub-app
  // that rendered the HTML. Checked first so it can't be shadowed by a
  // tenant path that happens to share a leading segment.
  const assetSubKey = ASSET_PREFIX_SUBAPP[stripped.split('/')[0]];
  if (assetSubKey && subApps[assetSubKey]) {
    return assetSubKey;
  }

  // Longest prefix match for non-public sub-app paths
  const prefixes = Object.keys(subApps).filter(k => k !== 'public').sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (stripped === prefix || stripped.startsWith(prefix + '/')) {
      return prefix;
    }
  }

  // Customer paths
  const customerPaths = CUSTOMER_PATHS[vertical] || [];
  for (const prefix of customerPaths) {
    if (stripped === prefix || stripped.startsWith(prefix + '/')) {
      return 'customer';
    }
  }

  return 'public';
}

function pathStartsWith(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function tenantScopedPathname(vertical, subKey, pathname, tenantSlug) {
  if (!tenantSlug) return pathname;

  // Static asset prefixes are already namespaced for a sub-app. They should
  // stay at /staff-static, /customer-static, etc. rather than /:slug/...
  const firstSegment = pathname.replace(/^\//, '').split('/')[0];
  if (ASSET_PREFIX_SUBAPP[firstSegment] || pathname.startsWith('/_next/')) {
    return pathname;
  }

  // These app-router pages live under /:slug/... internally, but tenants use
  // clean public URLs such as /staff and /enquiries.
  if ((vertical === 'booking' || vertical === 'web') && subKey === 'staff' && pathStartsWith(pathname, '/staff')) {
    return `/${tenantSlug}${pathname}`;
  }
  if (vertical === 'shop' && subKey === 'staff/manager' && pathStartsWith(pathname, '/staff/manager')) {
    return `/${tenantSlug}${pathname}`;
  }
  if (vertical === 'shop' && subKey === 'staff/delivery' && pathStartsWith(pathname, '/staff/delivery')) {
    return `/${tenantSlug}${pathname}`;
  }
  if (vertical === 'web' && subKey === 'customer' && pathStartsWith(pathname, '/enquiries')) {
    return `/${tenantSlug}${pathname}`;
  }

  return pathname;
}

function unifiedAdminRedirect(url, cfg) {
  const target = new URL(`${url.protocol}//${cfg.PLATFORM_DOMAIN}/dashboard`);
  target.search = url.search;
  return Response.redirect(target.toString(), 302);
}

async function lookupVertical(slug, backendApi, env) {
  // Try KV cache first (namespaced per backend so staging/prod don't collide)
  const cacheKey = `v:${backendApi}:${slug}`;
  if (env.ROUTER_CACHE) {
    const cached = await env.ROUTER_CACHE.get(cacheKey);
    if (cached) return cached;
  }

  // Call backend API
  const res = await fetch(`${backendApi}/api/internal/tenant-vertical?slug=${encodeURIComponent(slug)}`, {
    headers: { 'x-internal-secret': env.INTERNAL_SECRET || '' },
    cf: { cacheTtl: 60 },
  });

  if (!res.ok) return null;
  const data = await res.json();
  const vertical = data?.vertical?.toLowerCase() || null;

  // Store in KV
  if (vertical && env.ROUTER_CACHE) {
    await env.ROUTER_CACHE.put(cacheKey, vertical, { expirationTtl: 60 });
  }

  return vertical;
}

async function lookupCustomTenant(host, env) {
  const cacheKey = `custom-host:${host}`;
  if (env.ROUTER_CACHE) {
    const cached = await env.ROUTER_CACHE.get(cacheKey, 'json');
    if (cached?.action === 'redirect' && cached?.targetHost && cached?.apex && ENVS[cached.apex]) {
      return { ...cached, cfg: ENVS[cached.apex] };
    }
    if (cached?.vertical && cached?.slug && cached?.apex && ENVS[cached.apex]) {
      return { ...cached, cfg: ENVS[cached.apex] };
    }
  }

  // Custom hostnames are registered on one SaaS zone, but the incoming Host
  // header is the customer's domain. Try staging first because its target is
  // custom.aapkatech.com, then prod. Only ACTIVE verified mappings resolve.
  for (const [apex, cfg] of Object.entries(ENVS)) {
    const routeRes = await fetch(`${cfg.BACKEND_API}/api/internal/domain-route?host=${encodeURIComponent(host)}`, {
      headers: { 'x-internal-secret': env.INTERNAL_SECRET || '' },
      cf: { cacheTtl: 60 },
    }).catch(() => null);

    if (routeRes?.ok) {
      const route = await routeRes.json().catch(() => null);
      if (route?.action === 'redirect' && route.targetHost) {
        const tenant = { apex, action: 'redirect', targetHost: route.targetHost };
        if (env.ROUTER_CACHE) {
          await env.ROUTER_CACHE.put(cacheKey, JSON.stringify(tenant), { expirationTtl: 60 });
        }
        return { ...tenant, cfg };
      }

      const vertical = route?.vertical?.toLowerCase() || null;
      const slug = route?.slug || null;
      if (vertical && slug && cfg.VERCEL_URLS[vertical]) {
        const tenant = { apex, action: 'serve', vertical, slug };
        if (env.ROUTER_CACHE) {
          await env.ROUTER_CACHE.put(cacheKey, JSON.stringify(tenant), { expirationTtl: 60 });
        }
        return { ...tenant, cfg };
      }
    }

    const res = await fetch(`${cfg.BACKEND_API}/api/internal/tenant-vertical?host=${encodeURIComponent(host)}`, {
      headers: { 'x-internal-secret': env.INTERNAL_SECRET || '' },
      cf: { cacheTtl: 60 },
    }).catch(() => null);

    if (!res?.ok) continue;
    const data = await res.json().catch(() => null);
    const vertical = data?.vertical?.toLowerCase() || null;
    const slug = data?.slug || null;
    if (!vertical || !slug || !cfg.VERCEL_URLS[vertical]) continue;

    const tenant = { apex, action: 'serve', vertical, slug };
    if (env.ROUTER_CACHE) {
      await env.ROUTER_CACHE.put(cacheKey, JSON.stringify(tenant), { expirationTtl: 60 });
    }
    return { ...tenant, cfg };
  }

  return null;
}

function proxyToSubApp({ request, url, host, pathname, cfg, vertical, tenantSlug }) {
  const subKey = resolveSubAppKey(vertical, pathname, cfg.VERCEL_URLS);
  const targetBase = cfg.VERCEL_URLS[vertical][subKey] || cfg.VERCEL_URLS[vertical].public;
  const targetPathname = tenantScopedPathname(vertical, subKey, pathname, tenantSlug);

  const target = new URL(`${targetBase}${targetPathname}${url.search}`);
  target.searchParams.set('__tenantHost', host);
  target.searchParams.set('__tenantSlug', tenantSlug);
  return fetch(target.toString(), {
    method: request.method,
    headers: {
      ...Object.fromEntries(request.headers),
      host: new URL(targetBase).hostname,
      'x-forwarded-host': host,
      'x-tenant-host': host,
      'x-sitepresso-host': host,
      'x-tenant-slug': tenantSlug,
    },
    body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname; // e.g. shreya.sitepresso.com
    const pathname = url.pathname;

    // Resolve which environment (staging vs prod) this host belongs to
    const resolved = resolveEnvForHost(host);
    if (!resolved) {
      const customTenant = await lookupCustomTenant(host, env);
      if (!customTenant) {
        return tenantNotFoundResponse(host);
      }
      if (customTenant.action === 'redirect' && customTenant.targetHost) {
        url.hostname = customTenant.targetHost;
        return Response.redirect(url.toString(), 301);
      }
      if (TENANT_ADMIN_PATH_RE.test(pathname)) {
        return unifiedAdminRedirect(url, customTenant.cfg);
      }
      return proxyToSubApp({
        request,
        url,
        host,
        pathname,
        cfg: customTenant.cfg,
        vertical: customTenant.vertical,
        tenantSlug: customTenant.slug,
      });
    }
    const { apex, cfg } = resolved;

    const suffix = `.${apex}`;
    const subdomain = host === apex ? '' : host.slice(0, -suffix.length);

    // API subdomain passes through to EC2 via its own DNS record (never proxy
    // through the Worker). `api` = sitepresso backend. Standalone app hosts are
    // handled by their own domains/tunnel ingress; prod Rider still lives under
    // the prod Sitepresso zone, so keep that explicit pass-through below.
    const passthrough = new Set(['api']);
    const prodRiderHost = apex === 'sitepresso.com' && /^rider(-api)?$/.test(subdomain);
    if (passthrough.has(subdomain) || prodRiderHost) {
      return fetch(request);
    }

    // app.<domain> is the APPLICATION host, never the marketing site. The
    // landing page lives ONLY on the apex (aapkatech.com / sitepresso.com).
    // Redirect the bare app root to the login entry. Done at the edge on
    // purpose: the Worker knows the true hostname, whereas the platform app
    // can't reliably tell apex from app (both are proxied with
    // host=app.<apex>, and Vercel rewrites x-forwarded-host).
    if (subdomain === 'app' && (pathname === '/' || pathname === '')) {
      return Response.redirect(`${url.protocol}//${host}/login`, 302);
    }

    // No subdomain or reserved → platform admin (admin.<domain> handled separately)
    if (!subdomain || RESERVED.has(subdomain)) {
      return fetch(`${cfg.PLATFORM_VERCEL}${pathname}${url.search}`, {
        method: request.method,
        headers: {
          ...Object.fromEntries(request.headers),
          host: `app.${apex}`,
          'x-forwarded-host': host,
          'x-tenant-host': host,
          'x-sitepresso-host': host,
        },
        body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      });
    }

    // Resolve tenant vertical
    const vertical = await lookupVertical(subdomain, cfg.BACKEND_API, env);
    if (!vertical || !cfg.VERCEL_URLS[vertical]) {
      return tenantNotFoundResponse(host, apex);
    }

    if (TENANT_ADMIN_PATH_RE.test(pathname)) {
      return unifiedAdminRedirect(url, cfg);
    }

    return proxyToSubApp({
      request,
      url,
      host,
      pathname,
      cfg,
      vertical,
      tenantSlug: subdomain,
    });
  },
};

/**
 * Cloudflare Worker — HRMS subdomain router
 *
 * Routes hosts → the correct Vercel project, for BOTH environments off a single
 * Worker (host-aware). HR is a SINGLE vertical with three fixed surfaces:
 *   • hr.com / www / reserved subdomains → PLATFORM project (marketing + signup
 *     + onboarding + super-admin on admin.<domain>)
 *   • app.<domain>                       → HR_ADMIN project (tenant HR console)
 *   • <slug>.<domain> OR bound custom domain → ESS project (white-label
 *     Employee Self-Service; tenant resolved by Host)
 *
 *   • staging  → *.aapkatech.com   → api.aapkatech.com  + hr-*       projects
 *   • prod     → *.hr.com          → api.hr.com         + hr-prod-*  projects
 *
 * The environment is derived from the request hostname, so the same Worker is
 * attached to both zone routes (see wrangler.toml).
 */

// Per-environment config. Keyed by platform apex domain.
const ENVS = {
  'aapkatech.com': {
    BACKEND_API: 'https://api.aapkatech.com',
    PLATFORM_DOMAIN: 'app.aapkatech.com',
    PLATFORM_VERCEL: 'https://hr-platform.vercel.app',
    HR_ADMIN_VERCEL: 'https://hr-admin.vercel.app',
    ESS_VERCEL:      'https://hr-ess.vercel.app',
  },
  'hr.com': {
    BACKEND_API: 'https://api.hr.com',
    PLATFORM_DOMAIN: 'app.hr.com',
    PLATFORM_VERCEL: 'https://hr-prod-platform.vercel.app',
    HR_ADMIN_VERCEL: 'https://hr-prod-admin.vercel.app',
    ESS_VERCEL:      'https://hr-prod-ess.vercel.app',
  },
};

// Static-asset namespace. The ESS sub-app is a separate Vercel build with its
// own /_next/* hashes; it sets `assetPrefix` (/ess-static) in its next.config so
// its chunks load under that prefix. With a single tenant app every tenant-host
// path already lands on the ESS project, so this is documentation of the
// contract more than a fan-out. Keep in sync with the ESS next.config.
const ASSET_PREFIX_SUBAPP = {
  'ess-static': 'ess',
};

const RESERVED = new Set(['www', 'api', 'admin', 'app', 'mail', 'platform', 'm', 'hr']);
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

function unifiedAdminRedirect(url, cfg) {
  const target = new URL(`${url.protocol}//${cfg.PLATFORM_DOMAIN}/dashboard`);
  target.search = url.search;
  return Response.redirect(target.toString(), 302);
}

// Existence check for a platform-subdomain tenant (<slug>.hr.com). HR has a
// single vertical, so the Worker no longer asks WHICH vertical a slug is — only
// WHETHER it maps to a routable tenant. Returns the slug if it exists, else null.
// NOTE FOR LEAD: hits the legacy /api/internal/tenant-vertical?slug endpoint as
// an existence probe (its `vertical` field is ignored). Rename it to a
// vertical-agnostic existence endpoint when the backend is rewired.
async function lookupTenantExists(slug, backendApi, env) {
  // Try KV cache first (namespaced per backend so staging/prod don't collide)
  const cacheKey = `t:${backendApi}:${slug}`;
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
  const data = await res.json().catch(() => null);
  const resolvedSlug = (data?.slug || slug) ? slug : null;

  // Store in KV
  if (resolvedSlug && env.ROUTER_CACHE) {
    await env.ROUTER_CACHE.put(cacheKey, resolvedSlug, { expirationTtl: 60 });
  }

  return resolvedSlug;
}

// Resolve a bound custom domain (e.g. careers.acme.com) → the ESS app for its
// tenant. The backend's /domain-route returns action:'serve' for a routable
// mapping (gated by ROUTABLE_CUSTOM_DOMAIN_STATUSES) or action:'redirect' for a
// non-primary alias. We keep the serve/redirect + slug shape; the `vertical`
// field is no longer consulted (HR has one).
async function lookupCustomTenant(host, env) {
  const cacheKey = `custom-host:${host}`;
  if (env.ROUTER_CACHE) {
    const cached = await env.ROUTER_CACHE.get(cacheKey, 'json');
    if (cached?.action === 'redirect' && cached?.targetHost && cached?.apex && ENVS[cached.apex]) {
      return { ...cached, cfg: ENVS[cached.apex] };
    }
    if (cached?.action === 'serve' && cached?.slug && cached?.apex && ENVS[cached.apex]) {
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

      const slug = route?.slug || null;
      if (route?.action === 'serve' && slug) {
        const tenant = { apex, action: 'serve', slug };
        if (env.ROUTER_CACHE) {
          await env.ROUTER_CACHE.put(cacheKey, JSON.stringify(tenant), { expirationTtl: 60 });
        }
        return { ...tenant, cfg };
      }
    }
  }

  return null;
}

// Proxy a tenant host (subdomain slug or bound custom domain) → the ESS Vercel
// project. The ESS app resolves the tenant (businessId) from x-tenant-host; the
// path is passed through unchanged (no per-vertical slug rewrite — the tenant is
// keyed by Host, not a path prefix). Asset-prefix routing: the ESS app's
// /ess-static/* chunks are host-keyed static assets, so they pass straight
// through to the same ESS project (the ASSET_PREFIX_SUBAPP contract collapses to
// a single project here — kept explicit and in sync with the ESS next.config).
function proxyToEss({ request, url, host, pathname, cfg, tenantSlug }) {
  const targetBase = cfg.ESS_VERCEL;
  const firstSegment = pathname.replace(/^\//, '').split('/')[0];
  const isAssetPrefix = Boolean(ASSET_PREFIX_SUBAPP[firstSegment]) || pathname.startsWith('/_next/');

  const target = new URL(`${targetBase}${pathname}${url.search}`);
  target.searchParams.set('__tenantHost', host);
  // Asset chunks don't need the tenant-slug hint (they're host-keyed builds).
  if (tenantSlug && !isAssetPrefix) target.searchParams.set('__tenantSlug', tenantSlug);
  return fetch(target.toString(), {
    method: request.method,
    headers: {
      ...Object.fromEntries(request.headers),
      host: new URL(targetBase).hostname,
      'x-forwarded-host': host,
      'x-tenant-host': host,
      'x-sitepresso-host': host,
      ...(tenantSlug ? { 'x-tenant-slug': tenantSlug } : {}),
    },
    body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname; // e.g. shreya.sitepresso.com
    const pathname = url.pathname;

    // Resolve which environment (staging vs prod) this host belongs to.
    // A non-platform host is a bound custom domain → the white-label ESS app.
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
      // /admin on a tenant host → the tenant HR console (app.<domain>/dashboard).
      if (TENANT_ADMIN_PATH_RE.test(pathname)) {
        return unifiedAdminRedirect(url, customTenant.cfg);
      }
      return proxyToEss({
        request,
        url,
        host,
        pathname,
        cfg: customTenant.cfg,
        tenantSlug: customTenant.slug,
      });
    }
    const { apex, cfg } = resolved;

    const suffix = `.${apex}`;
    const subdomain = host === apex ? '' : host.slice(0, -suffix.length);

    // api.<domain> passes through to the backend via its own DNS record (never
    // proxy through the Worker).
    if (subdomain === 'api') {
      return fetch(request);
    }

    // app.<domain> is the tenant HR console (operator session), never the
    // marketing site. Redirect the bare app root to the login entry, then proxy
    // everything else to the HR_ADMIN project. Done at the edge on purpose: the
    // Worker knows the true hostname, whereas the app can't reliably tell apex
    // from app (Vercel rewrites x-forwarded-host).
    if (subdomain === 'app') {
      if (pathname === '/' || pathname === '') {
        return Response.redirect(`${url.protocol}//${host}/login`, 302);
      }
      return fetch(`${cfg.HR_ADMIN_VERCEL}${pathname}${url.search}`, {
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

    // Apex / www / other reserved subdomains (admin, mail, platform, hr, …) →
    // the platform project: marketing + signup + onboarding, and the super-admin
    // console on admin.<domain>. The platform app's own middleware locks
    // admin.<domain> down to the super-admin surface.
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

    // <slug>.<domain> → the white-label ESS app for that tenant. HR is a single
    // vertical, so we only confirm the slug maps to a routable tenant.
    const tenantSlug = await lookupTenantExists(subdomain, cfg.BACKEND_API, env);
    if (!tenantSlug) {
      return tenantNotFoundResponse(host, apex);
    }

    // /admin on a tenant subdomain → the tenant HR console (app.<domain>/dashboard).
    if (TENANT_ADMIN_PATH_RE.test(pathname)) {
      return unifiedAdminRedirect(url, cfg);
    }

    return proxyToEss({
      request,
      url,
      host,
      pathname,
      cfg,
      tenantSlug,
    });
  },
};

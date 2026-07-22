'use client';

// SSO helpers for the ESS login surface.
//
// The PUBLIC SSO endpoints (GET /sso/:tenant/status, GET /sso/:tenant/login)
// are mounted at the BACKEND APP ROOT. Two ways to reach them, both supported:
//
//   1. SAME-ORIGIN — the edge router (apps/router, Wave P3.4 change) proxies
//      /sso/* on any tenant/platform host straight to the backend. Preferred:
//      no CORS, works on bound custom domains too.
//   2. API ORIGIN — api.<domain> (the backend's resolveApiBaseUrl()) reaches
//      the backend directly via tunnel ingress. Fallback for deploys where the
//      router doesn't (yet) forward /sso/*. Derived from the current host +
//      the resolved tenant slug:
//        <slug>.<domain>       (prod dotted)         → https://api.<domain>
//        <slug>-<sub>.<apex>   (staging hyphen form) → https://api-<sub>.<apex>
//        m-<slug>[-<sub>]…     (mobile alias)        → same rule, stripped base
//        custom domain         → cannot derive       → same-origin only
//      NEXT_PUBLIC_API_URL (baked for local dev) wins when present.
//
// probeSso() tries the bases in order and remembers which one answered, so the
// login button navigates through a base that provably serves /sso/*. Any
// failure fails SOFT — callers render no SSO affordance.

export function ssoApiOrigin(slug) {
  const baked = String(process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
  if (baked) return baked;
  if (typeof window === 'undefined' || !slug) return null;
  const proto = window.location.protocol === 'http:' ? 'http:' : 'https:';
  const host = String(window.location.hostname || '').toLowerCase();
  const dot = host.indexOf('.');
  if (dot <= 0) return null;
  let label = host.slice(0, dot);
  const rest = host.slice(dot + 1);
  const s = String(slug).toLowerCase();
  // Feature 41 mobile alias — m-<slug>… inherits the base host's rule.
  if (label.startsWith('m-') && label.length > 2) label = label.slice(2);
  if (label === s) return `${proto}//api.${rest}`;
  if (label.startsWith(`${s}-`)) return `${proto}//api-${label.slice(s.length + 1)}.${rest}`;
  return null; // custom domain — no derivable api host
}

// Candidate URL bases, in preference order. '' = same-origin.
export function ssoBases(slug) {
  const bases = [''];
  const api = ssoApiOrigin(slug);
  if (api) bases.push(api);
  return bases;
}

// Probe GET /sso/<slug>/status across the candidate bases. Resolves to
//   { status: { configured, protocol, displayName, loginTarget, tenant }, base }
// for the FIRST base that answers with real status JSON, or null when none
// does (unknown tenant, router not forwarding /sso/*, network/CORS error, …).
export async function probeSso(slug) {
  if (!slug) return null;
  for (const base of ssoBases(slug)) {
    try {
      const res = await fetch(`${base}/sso/${encodeURIComponent(slug)}/status`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue; // 404 HTML (no proxy) or 404 JSON (unknown tenant)
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue; // an HTML page answered — not the backend
      const status = await res.json();
      if (typeof status?.configured !== 'boolean') continue;
      return { status, base };
    } catch { /* try the next base */ }
  }
  return null;
}

// Full-page navigation target for the SP-initiated login leg, on the base the
// probe validated. `redirect` is an optional in-app path carried through the
// round trip (the backend sanitises it again server-side).
export function ssoLoginUrl(base, slug, target, redirect) {
  if (!slug) return null;
  const path = `/sso/${encodeURIComponent(slug)}/login`;
  const url = new URL(`${base || ''}${path}`, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
  if (target) url.searchParams.set('target', target);
  if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
    url.searchParams.set('redirect', redirect);
  }
  return url.toString();
}

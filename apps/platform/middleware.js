// Locale-detection middleware.
//
// Strategy: NO URL prefixes. Existing paths (/pricing, /signup, …)
// stay exactly as they are; the active locale lives in a cookie set
// once on the first visit. Trade-off: lose per-language SEO URLs in
// exchange for keeping every path / link / share untouched.
//
// Two cookies, on purpose:
//   NEXT_LOCALE          — current effective locale (sticky once set)
//   NEXT_LOCALE_EXPLICIT — '1' iff the user explicitly picked from the
//                          language selector. Informational; both
//                          cookies are sticky.
//
// Resolution on FIRST visit only (no NEXT_LOCALE cookie present):
//   1. Geo-IP country (Vercel edge `geo.country` → COUNTRY_LOCALE_MAP).
//      Uses the same signal pricing already trusts.
//   2. Accept-Language header.
//   3. DEFAULT_LOCALE.
//
// Once set, the cookie is respected on every subsequent visit until
// the user clears it or picks a different language from the selector.
// This means a VPN change after first visit does NOT auto-flip the
// language — the user must pick from the selector to override their
// initial detection. Predictable beats clever.

import { NextResponse } from 'next/server';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, localeFromCountry } from './i18n/config';

const COOKIE = 'NEXT_LOCALE';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function bestLocaleFromHeader(header) {
  if (!header) return null;
  const tags = header.split(',').map((entry) => entry.split(';')[0].trim()).filter(Boolean);
  for (const raw of tags) {
    const tag = raw.toLowerCase();
    const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const prefix = tag.split('-')[0];
    const prefixHit = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === prefix);
    if (prefixHit) return prefixHit;
  }
  return null;
}

// Routes the super-admin console (admin.* host) is allowed to serve.
// Anything else hits a redirect to /login. Marketing pages (landing,
// pricing, legal) and signup are NOT exposed on the admin subdomain —
// it's an operator-only entry point. /api and /_next paths are excluded
// from the matcher entirely so they reach the app without redirect.
const ADMIN_HOST_ALLOWED_PREFIXES = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/superadmin',
  '/__connect',          // OAuth callback popups
  '/business',           // post-login role redirect for SUPER_ADMIN
];

function isAdminHost(host) {
  return typeof host === 'string' && host.startsWith('admin.');
}

function isUnifiedAdminHost(host) {
  return typeof host === 'string' && host.startsWith('app.');
}

function isAllowedOnAdminHost(pathname) {
  return ADMIN_HOST_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function hasOperatorCookie(request) {
  return request.cookies.getAll().some(({ name, value }) => (
    !!value && (name === 'ae_operator' || name === 'ae_operator_refresh' || name.startsWith('ae_operator_'))
  ));
}

function isProtectedPlatformPath(pathname) {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  if (pathname === '/business' || pathname.startsWith('/business/')) return true;
  if (pathname === '/onboarding' || pathname.startsWith('/onboarding/')) return true;
  return /^\/[^/]+\/(admin|staff)(?=($|[/?#]))/.test(pathname);
}

function redirectToLogin(request) {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  const redirect = `${request.nextUrl.pathname}${request.nextUrl.search || ''}`;
  if (redirect && redirect !== '/login') url.searchParams.set('redirect', redirect);
  return NextResponse.redirect(url);
}

export function middleware(request) {
  // Admin-host routing guard — runs BEFORE locale detection so the
  // redirect happens on the very first visit too.
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  if (isAdminHost(host)) {
    const { pathname } = request.nextUrl;
    if (!isAllowedOnAdminHost(pathname)) {
      return redirectToLogin(request);
    }
  }

  if (isProtectedPlatformPath(request.nextUrl.pathname) && !hasOperatorCookie(request)) {
    return redirectToLogin(request);
  }

  // Canonical unified-admin URL. If an old app-domain path-based admin
  // bookmark is opened (app.aapkatech.com/<slug>/admin), send it to the
  // JWT-scoped dashboard instead of rendering the slug route on app.*.
  if (isUnifiedAdminHost(host) && /^\/[^/]+\/admin(?=($|[/?#]))/.test(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  const existing = request.cookies.get(COOKIE)?.value;

  // Cookie already set → respect it. Sticky regardless of how it was
  // set (auto-detect or explicit pick). User can clear cookies or use
  // the language selector to change.
  if (existing && SUPPORTED_LOCALES.includes(existing)) {
    return NextResponse.next();
  }

  // First visit: detect. Geo-IP first because pricing already trusts
  // it (so language and currency stay consistent). Fall back to
  // browser language, then default.
  let locale = null;
  const country = request.headers.get('cf-ipcountry')
    || request.geo?.country
    || request.headers.get('x-vercel-ip-country')
    || null;
  const fromGeo = localeFromCountry(country);
  if (SUPPORTED_LOCALES.includes(fromGeo)) locale = fromGeo;

  if (!locale) {
    locale = bestLocaleFromHeader(request.headers.get('accept-language'));
  }
  if (!locale) locale = DEFAULT_LOCALE;

  const res = NextResponse.next();
  res.cookies.set(COOKIE, locale, {
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax',
  });
  return res;
}

export const config = {
  // Exclude API routes, _next/static, _next/image, favicon, and any
  // path with a file extension (images, manifest, etc). Everything
  // else is a page that needs locale.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};

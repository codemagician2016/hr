'use client';

// Operator login (tenant-admin / HR users). POSTs to /api/auth/login which
// sets the ae_operator session cookie; on success we send the operator to
// the requested redirect (or the dashboard). Renders bare — ShellGate keeps
// this route outside the AdminShell. useSearchParams is read inside a child
// wrapped in <Suspense> (Next.js app-router CSR-bailout requirement).
//
// White-label: this page resolves the tenant from the host (GET /api/tenant/
// resolve) and renders THEIR brand — logo if set, else the business NAME as a
// styled wordmark in the brand colour, plus the brand favicon + document title.
// The DriftHR vendor mark NEVER appears on a tenant login.
//
// Enterprise SSO (operator target): this console lives on the SHARED app host,
// so the tenant usually can't be derived from the Host header. Two doors:
//   1. A known slug (?org=<slug> query param, or a tenant-branded host that
//      resolves) → probe GET /sso/<slug>/status and render a "Continue with
//      <IdP>" button ABOVE the password form (?target=operator — the server
//      enforces the allowed target).
//   2. Otherwise an "Use single sign-on" affordance reveals an organisation-ID
//      input (the workspace subdomain — same org-ID pattern as the mobile app)
//      and navigates to /sso/<org>/login?target=operator.
// Everything fails SOFT — password sign-in is never blocked.

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PrimaryButton, TextInput, ErrorBanner } from '@hr/ui';
import { get, post } from '@/lib/api';
import { resolveTenantTheme } from '@hr/theme-engine';
import { themeVarsFromResolved } from '@/lib/themeVars';
import { probeSso, ssoLoginUrl } from '@/lib/sso';

// Apply the resolved brand's --theme-* vars + set the browser favicon and
// document title from the tenant brand (never "DriftHR").
function applyBrandChrome(brand) {
  if (typeof document === 'undefined' || !brand) return;
  let subPrimary;
  if (typeof brand.themeColors === 'string') {
    try { subPrimary = JSON.parse(brand.themeColors)?.primary; } catch { subPrimary = undefined; }
  }
  const resolved = resolveTenantTheme({
    styleKey: brand.themeStyle || brand.theme,
    primary: brand.primaryColor || subPrimary,
    logoUrl: brand.logoUrl,
  });
  const vars = themeVarsFromResolved(resolved);
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);

  if (brand.name) document.title = `Sign in · ${brand.name}`;
  if (brand.faviconUrl) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = brand.faviconUrl;
  }
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') || '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Tenant brand (host-resolved). logoUrl OR the business name wordmark; never
  // the DriftHR mark. Also captures the tenant SLUG when the host resolves —
  // it seeds the SSO button (rare on the shared app host, normal on a branded one).
  const [brand, setBrand] = useState(null);
  const [hostSlug, setHostSlug] = useState(null);
  useEffect(() => {
    let alive = true;
    get('/api/tenant/resolve')
      .then((r) => {
        if (!alive) return;
        const b = r?.brand || null;
        if (b) {
          setBrand(b);
          applyBrandChrome({ ...b, themeStyle: r?.subscription?.themeStyle, themeColors: r?.subscription?.themeColors });
        }
        if (r?.business?.slug) setHostSlug(r.business.slug);
      })
      .catch(() => { /* unbranded host (e.g. platform domain) — neutral chrome */ });
    return () => { alive = false; };
  }, []);

  // ── Enterprise SSO (operator) ────────────────────────────────────────────
  // Slug precedence: explicit ?org= param, then the host-resolved tenant.
  const orgParam = (params.get('org') || '').toLowerCase().trim();
  const ssoSlug = orgParam || hostSlug || null;
  const [sso, setSso] = useState(null); // { status, base } from the probe
  useEffect(() => {
    if (!ssoSlug) return undefined;
    let alive = true;
    probeSso(ssoSlug)
      .then((r) => {
        if (!alive || !r?.status?.configured) return;
        if (r.status.loginTarget === 'ESS') return; // operator sign-in not allowed here
        setSso(r);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [ssoSlug]);
  const ssoHref = sso && ssoSlug ? ssoLoginUrl(sso.base, ssoSlug, 'operator', redirect) : null;

  // Manual org-ID door (shared host, tenant unknown).
  const [showOrgSso, setShowOrgSso] = useState(false);
  const [orgInput, setOrgInput] = useState('');
  const [orgError, setOrgError] = useState('');
  const [orgChecking, setOrgChecking] = useState(false);

  async function startOrgSso(e) {
    e.preventDefault();
    const slug = orgInput.toLowerCase().trim();
    if (!slug) return;
    setOrgError('');
    setOrgChecking(true);
    try {
      const r = await probeSso(slug);
      if (!r) {
        setOrgError('Could not find that organisation ID — check it and try again.');
        setOrgChecking(false);
        return;
      }
      if (!r.status.configured) {
        setOrgError(r.status.message || 'Single sign-on is not set up for this organisation.');
        setOrgChecking(false);
        return;
      }
      window.location.assign(ssoLoginUrl(r.base, slug, 'operator', redirect));
    } catch {
      setOrgError('Could not start single sign-on. Please try again.');
      setOrgChecking(false);
    }
  }

  const logoUrl = brand?.logoUrl || null;
  const tenantName = brand?.name || null;

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await post('/api/auth/login', { email, password });
      router.replace(redirect.startsWith('/') ? redirect : '/');
    } catch (err) {
      setError(err.status === 401 ? 'Invalid email or password.' : err.message || 'Sign in failed.');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        {/* White-label brand: logo if set, else the business NAME wordmark in the
            brand colour. NEVER the DriftHR vendor mark. */}
        <div className="mb-5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={tenantName || 'Logo'} className="h-8 w-auto max-w-[180px] object-contain" />
          ) : tenantName ? (
            <span
              className="inline-block text-lg font-bold"
              style={{ color: 'var(--theme-primary, #4F46E5)' }}
            >
              {tenantName}
            </span>
          ) : (
            // Unbranded host (platform domain / unresolved tenant): a neutral
            // wordmark, NOT the DriftHR mark.
            <span className="inline-block text-lg font-bold text-gray-900">HR Console</span>
          )}
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Sign in</h1>
        <p className="text-sm text-gray-500 mb-6">
          {tenantName ? `Sign in to ${tenantName}.` : 'Sign in to your account.'}
        </p>
        {ssoHref && (
          <div className="mb-5">
            {/* Full-page navigation — the SSO round trip leaves and re-enters the app. */}
            <a
              href={ssoHref}
              className="flex w-full items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-semibold transition hover:opacity-90"
              style={{ borderColor: 'var(--theme-primary, #4F46E5)', color: 'var(--theme-primary, #4F46E5)' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
              </svg>
              Continue with {sso.status.displayName || 'Single sign-on'}
            </a>
            <div className="mt-5 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-gray-200" />
              <span className="text-xs text-gray-400">or sign in with your password</span>
              <span className="h-px flex-1 bg-gray-200" />
            </div>
          </div>
        )}
        <form onSubmit={onSubmit} className="space-y-4">
          <TextInput
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            placeholder="you@company.com"
          />
          <TextInput
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            required
          />
          {error && <ErrorBanner message={error} />}
          <PrimaryButton type="submit" loading={loading}>
            Sign in
          </PrimaryButton>
        </form>

        {/* Org-ID SSO door — the shared console host can't know the tenant, so
            let SSO users name their workspace. Hidden when a status-probed
            button already renders above. */}
        {!ssoHref && (
          <div className="mt-6 border-t border-gray-100 pt-4">
            {showOrgSso ? (
              <form onSubmit={startOrgSso} className="space-y-3">
                <TextInput
                  label="Organisation ID"
                  value={orgInput}
                  onChange={setOrgInput}
                  required
                  placeholder="e.g. acme"
                  hint="Your workspace subdomain — the part before the dot in your employee portal address."
                />
                {orgError && <ErrorBanner message={orgError} />}
                <div className="flex items-center gap-3">
                  <PrimaryButton type="submit" loading={orgChecking}>
                    Continue with single sign-on
                  </PrimaryButton>
                  <button
                    type="button"
                    onClick={() => { setShowOrgSso(false); setOrgError(''); }}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setShowOrgSso(true)}
                className="w-full text-center text-sm font-medium hover:underline"
                style={{ color: 'var(--theme-primary, #4F46E5)' }}
              >
                Use single sign-on instead
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <LoginForm />
    </Suspense>
  );
}

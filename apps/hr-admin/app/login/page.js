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

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PrimaryButton, TextInput, ErrorBanner } from '@hr/ui';
import { get, post } from '@/lib/api';
import { resolveTenantTheme } from '@hr/theme-engine';
import { themeVarsFromResolved } from '@/lib/themeVars';

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
  // the DriftHR mark.
  const [brand, setBrand] = useState(null);
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
      })
      .catch(() => { /* unbranded host (e.g. platform domain) — neutral chrome */ });
    return () => { alive = false; };
  }, []);

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

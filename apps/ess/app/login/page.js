'use client';

// Employee (customer) login — POST /api/customer/login sets the session
// cookie; on success we route to the dashboard. Branded via TenantProvider
// (logo + brand color), rendered bare (no AppShell) so it's reachable
// unauthenticated.
//
// Enterprise SSO: on mount we probe the public GET /sso/<slug>/status (slug
// from the host-resolved tenant). When a connection is configured AND allows
// the ESS target, a "Continue with <IdP>" button renders ABOVE the password
// form as a full-page navigation to /sso/<slug>/login?target=ess on the api
// origin. Any probe failure fails SOFT — the password form is never blocked.

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ErrorBanner } from '@hr/ui';
import { useTenant } from '@/components/TenantProvider';
import { apiPost } from '@/lib/api';
import { probeSso, ssoLoginUrl } from '@/lib/sso';

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { tenant, theme } = useTenant();
  const business = tenant?.business || {};
  // White-label brand: prefer the resolved tenant-wide brand object, then the
  // theme/business fallbacks. Render the logo if set, else the business NAME as a
  // styled wordmark — NEVER the DriftHR vendor mark.
  const brand = tenant?.brand || {};
  const logoUrl = brand.logoUrl || theme?.logoUrl || business.logoUrl || null;
  const tenantName = brand.name || business.name || business.displayName || null;
  const name = tenantName || 'Sign in';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Enterprise SSO — probe the tenant's public status endpoint once the slug
  // resolves (same-origin first, api-origin fallback — see lib/sso.js).
  // Fail-soft: any error → no button, password login unaffected.
  const slug = business.slug || null;
  const [sso, setSso] = useState(null); // { status, base } from the probe
  useEffect(() => {
    if (!slug) return undefined;
    let alive = true;
    probeSso(slug)
      .then((r) => {
        if (!alive || !r?.status?.configured) return;
        if (r.status.loginTarget === 'OPERATOR') return; // ESS not allowed on this connection
        setSso(r);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [slug]);
  const redirectParam = params.get('redirect');
  const ssoHref = sso ? ssoLoginUrl(sso.base, slug, 'ess', redirectParam) : null;

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/api/customer/login', { email, password });
      const redirect = params.get('redirect') || '/';
      router.replace(redirect.startsWith('/') ? redirect : '/');
    } catch (err) {
      setError(err.message || 'Login failed. Check your email and password.');
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen w-full lg:grid-cols-2" style={{ background: 'var(--theme-bg)' }}>
      {/* ── Brand / hero panel (desktop only). Generous space for the tenant's
            logo + a branded gradient in their own colour. Never the DriftHR mark. */}
      <div
        className="relative hidden flex-col justify-between overflow-hidden p-12 lg:flex"
        style={{
          background: 'linear-gradient(135deg, var(--theme-primary), var(--theme-primary-dark, var(--theme-primary)))',
          color: 'var(--theme-on-primary)',
        }}
      >
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full" style={{ background: 'rgba(255,255,255,0.10)' }} />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-20 h-96 w-96 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }} />

        {/* Logo slot */}
        <div className="relative">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={name} className="h-16 w-auto max-w-[260px] object-contain" />
          ) : (
            <div className="inline-flex h-16 items-center rounded-2xl bg-white/15 px-6 text-2xl font-bold backdrop-blur-sm">
              {tenantName || 'Employee Portal'}
            </div>
          )}
        </div>

        {/* Hero copy */}
        <div className="relative max-w-md">
          <h2 className="text-3xl font-bold leading-tight">
            {tenantName ? `Welcome to ${tenantName}` : 'Welcome to your Employee Portal'}
          </h2>
          <p className="mt-4 text-base leading-relaxed" style={{ color: 'rgba(255,255,255,0.82)' }}>
            Payslips, leave, attendance and documents — your whole work life, in one secure place.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            {['Payslips', 'Leave & attendance', 'Documents', 'Reimbursements'].map((f) => (
              <span key={f} className="rounded-full bg-white/15 px-3 py-1 text-xs font-medium backdrop-blur-sm">{f}</span>
            ))}
          </div>
        </div>

        <div className="relative text-xs" style={{ color: 'rgba(255,255,255,0.6)' }}>Secure employee sign-in</div>
      </div>

      {/* ── Sign-in panel ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          {/* Mobile brand (logo) — only when the hero panel is hidden */}
          <div className="mb-8 flex flex-col items-center gap-3 text-center lg:hidden">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={name} className="h-12 w-auto max-w-[200px] object-contain" />
            ) : (
              <div className="flex h-12 items-center rounded-xl px-4 text-lg font-bold" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                {tenantName || 'Employee Portal'}
              </div>
            )}
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--theme-text)' }}>Sign in</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>
              {tenantName ? `Welcome back to ${tenantName}.` : 'Welcome back.'} Sign in to your account.
            </p>
          </div>

          {ssoHref && (
            <div className="mb-6">
              {/* Full-page navigation — the SSO round trip leaves and re-enters the app. */}
              <a
                href={ssoHref}
                className="flex w-full items-center justify-center gap-2 rounded-xl border py-3 text-sm font-semibold shadow-sm transition hover:opacity-90"
                style={{
                  borderColor: 'var(--theme-primary)',
                  color: 'var(--theme-primary)',
                  background: 'transparent',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
                </svg>
                Continue with {sso.status.displayName || 'Single sign-on'}
              </a>
              <div className="mt-6 flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1" style={{ background: 'var(--theme-border)' }} />
                <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>or sign in with your password</span>
                <span className="h-px flex-1" style={{ background: 'var(--theme-border)' }} />
              </div>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            {error && <ErrorBanner message={error} />}

            <div>
              <label htmlFor="ess-email" className="mb-1.5 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Email</label>
              <input
                id="ess-email" type="email" required autoComplete="username" placeholder="you@company.com"
                value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border bg-white px-4 py-2.5 text-sm outline-none transition"
                style={{ borderColor: 'var(--theme-border)' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--theme-border)'; }}
              />
            </div>

            <div>
              <label htmlFor="ess-password" className="mb-1.5 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Password</label>
              <div className="relative">
                <input
                  id="ess-password" type={showPw ? 'text' : 'password'} required autoComplete="current-password" placeholder="••••••••"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border bg-white px-4 py-2.5 pr-14 text-sm outline-none transition"
                  style={{ borderColor: 'var(--theme-border)' }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--theme-border)'; }}
                />
                <button
                  type="button" onClick={() => setShowPw((v) => !v)} tabIndex={-1}
                  className="absolute inset-y-0 right-0 flex items-center px-4 text-xs font-semibold"
                  style={{ color: 'var(--theme-muted)' }}
                >
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <button
              type="submit" disabled={submitting}
              className="w-full rounded-xl py-3 text-sm font-semibold shadow-sm transition hover:opacity-95 disabled:opacity-60"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-10 text-center text-xs" style={{ color: 'var(--theme-muted)' }}>
            Powered by <span className="font-semibold" style={{ color: 'var(--theme-text)' }}>DriftHR</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams() must sit under a Suspense boundary in app-router.
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

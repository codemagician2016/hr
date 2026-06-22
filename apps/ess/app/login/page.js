'use client';

// Employee (customer) login — POST /api/customer/login sets the session
// cookie; on success we route to the dashboard. Branded via TenantProvider
// (logo + brand color), rendered bare (no AppShell) so it's reachable
// unauthenticated.

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ErrorBanner } from '@hr/ui';
import { useTenant } from '@/components/TenantProvider';
import { apiPost } from '@/lib/api';

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { tenant, theme } = useTenant();
  const business = tenant?.business || {};
  const logoUrl = theme?.logoUrl || business.logoUrl || null;
  const name = business.name || business.displayName || 'Employee Portal';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

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
    <div className="flex min-h-screen flex-col items-center justify-center px-4"
         style={{ background: 'var(--theme-bg)' }}>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={name} className="h-12 w-auto max-w-[180px] object-contain" />
          ) : (
            <div
              className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              {name.charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>{name}</h1>
            <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>Sign in to your account</p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl border bg-white p-5 shadow-sm"
          style={{ borderColor: 'var(--theme-border)' }}
        >
          {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

          <label className="mb-3 block text-sm">
            <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>Email</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2"
              style={{ borderColor: 'var(--theme-border)' }}
            />
          </label>

          <label className="mb-4 block text-sm">
            <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2"
              style={{ borderColor: 'var(--theme-border)' }}
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg py-2.5 text-sm font-semibold transition disabled:opacity-60"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
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

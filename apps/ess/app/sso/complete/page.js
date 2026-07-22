'use client';

// SSO return leg (ESS). The backend's IdP callback/ACS validates the assertion,
// mints a single-use Redis auth code and 302s the browser to
//   https://<tenant-host>/sso/complete?code=<code>[&redirect=<path>]
// (sso.controller completeRedirect). This page POSTs the code to
//   POST /api/customer/sso/exchange { code }
// which consumes it and sets the Customer session cookie ON THIS HOST (the only
// place a host-scoped cookie can be set), then routes into the app. Renders
// bare (no AppShell) — the user is not signed in until the exchange lands.

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiPost } from '@/lib/api';

function safePath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/';
}

function CompleteInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState('');
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return; // codes are single-use — never POST twice (StrictMode)
    ranRef.current = true;
    const code = params.get('code');
    if (!code) {
      setError('Missing sign-in code. Please start again from the sign-in page.');
      return;
    }
    apiPost('/api/customer/sso/exchange', { code })
      .then(() => {
        router.replace(safePath(params.get('redirect')));
      })
      .catch((err) => {
        setError(err.message || 'Single sign-on failed. Please try again.');
      });
  }, [params, router]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: 'var(--theme-bg)' }}>
      <div className="w-full max-w-sm rounded-2xl border bg-white p-8 text-center shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        {error ? (
          <>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>We couldn&apos;t sign you in</h1>
            <p className="mt-2 text-sm" style={{ color: 'var(--theme-muted)' }}>{error}</p>
            <a
              href="/login"
              className="mt-6 inline-flex w-full items-center justify-center rounded-xl py-3 text-sm font-semibold"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              Back to sign in
            </a>
          </>
        ) : (
          <>
            <div
              className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-transparent"
              style={{ borderTopColor: 'var(--theme-primary)', borderRightColor: 'var(--theme-primary)' }}
              aria-hidden="true"
            />
            <p className="mt-4 text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Completing sign-in…</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>Finishing your single sign-on session.</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function SsoCompletePage() {
  // useSearchParams() must sit under a Suspense boundary in app-router.
  return (
    <Suspense fallback={null}>
      <CompleteInner />
    </Suspense>
  );
}

'use client';

// SSO return leg (operator). The backend's IdP callback/ACS validates the
// assertion, mints a single-use Redis auth code and 302s the browser to
//   <operator-app-origin>/sso/complete?code=<code>&target=operator[&redirect=<path>]
// (sso.controller completeRedirect + operatorBaseUrl). This page POSTs the code to
//   POST /api/auth/sso/exchange { code }
// which consumes it and sets the operator session cookie ON THIS HOST, then
// routes into the console. Renders bare (ShellGate public prefix) — the user
// is not signed in until the exchange lands.

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { post } from '@/lib/api';

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
    post('/api/auth/sso/exchange', { code })
      .then(() => {
        router.replace(safePath(params.get('redirect')));
      })
      .catch((err) => {
        setError(err.data?.message || err.message || 'Single sign-on failed. Please try again.');
      });
  }, [params, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-gray-900">We couldn&apos;t sign you in</h1>
            <p className="mt-2 text-sm text-gray-500">{error}</p>
            <a
              href="/login"
              className="mt-6 inline-flex w-full items-center justify-center rounded-lg py-2.5 text-sm font-semibold text-white"
              style={{ background: 'var(--theme-primary, #4F46E5)' }}
            >
              Back to sign in
            </a>
          </>
        ) : (
          <>
            <div
              className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-gray-200"
              style={{ borderTopColor: 'var(--theme-primary, #4F46E5)' }}
              aria-hidden="true"
            />
            <p className="mt-4 text-sm font-medium text-gray-900">Completing sign-in…</p>
            <p className="mt-1 text-xs text-gray-500">Finishing your single sign-on session.</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function SsoCompletePage() {
  // useSearchParams() must sit under a Suspense boundary in app-router.
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <CompleteInner />
    </Suspense>
  );
}

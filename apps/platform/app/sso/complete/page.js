'use client';

// SSO return leg (operator) — SAFETY NET on the platform app.
//
// The backend 302s a finished operator SSO login to
//   <operatorBaseUrl>/sso/complete?code=<code>&target=operator[&redirect=<path>]
// where operatorBaseUrl = NEXT_PUBLIC_PLATFORM_URL || FRONTEND_URL ||
// https://<PLATFORM_DOMAIN> (sso.controller). On deploys where that env points
// at THIS app (the apex marketing host) rather than the hr-admin app host, the
// redirect lands here. The operator cookie set by the exchange is shared across
// platform subdomains, so we complete the exchange on this host and then hand
// the browser to the unified admin console (app.<domain> / app-<sub>.<apex>).

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';
import { getUnifiedAdminUrl } from '@/lib/platformDomain';

function safePath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/';
}

function CompleteInner() {
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
    axios
      .post('/api/auth/sso/exchange', { code }, {
        withCredentials: true,
        headers: { 'Content-Type': 'application/json' },
      })
      .then(() => {
        // Into the operator console — the shared operator cookie travels along.
        window.location.replace(getUnifiedAdminUrl(safePath(params.get('redirect'))));
      })
      .catch((err) => {
        setError(err.response?.data?.message || 'Single sign-on failed. Please try again.');
      });
  }, [params]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-gray-900">We couldn&apos;t sign you in</h1>
            <p className="mt-2 text-sm text-gray-500">{error}</p>
            <a
              href="/login"
              className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Back to sign in
            </a>
          </>
        ) : (
          <>
            <div
              className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-gray-200"
              style={{ borderTopColor: '#4F46E5' }}
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

'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams, useParams } from 'next/navigation';

/**
 * Centralised social sign-in page at <platform>/auth/<provider>
 *
 * This is the ONLY authorised JavaScript origin for OAuth. Every tenant
 * subdomain AND every verified custom domain bounces here, then gets
 * redirected back to <tenantHost>/auth/callback?code=… with a one-time code.
 *
 * Query params:
 *   ?host=barbar.sitepresso.com   — which tenant the customer is signing into
 *                                    (a platform subdomain or a custom domain)
 *   ?redirect=/book               — where to send them on the tenant site
 *
 * Adding Apple / Microsoft: add a PROVIDERS entry whose load() resolves a
 * credential string, and ship the matching backend provider. The two-leg
 * exchange + callback below is provider-agnostic already.
 */

const PROVIDERS = {
  google: {
    name: 'Google',
    clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '',
    // Loads GSI, renders the button, calls onCredential(idToken).
    load(buttonEl, onCredential, onReady) {
      const start = () => {
        if (!window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: this.clientId,
          callback: (resp) => onCredential(resp?.credential),
          auto_select: false,
        });
        if (buttonEl) {
          window.google.accounts.id.renderButton(buttonEl, {
            type: 'standard', theme: 'outline', size: 'large',
            width: 320, text: 'continue_with', shape: 'pill',
          });
        }
        onReady();
      };
      if (document.getElementById('gsi-script')) { start(); return; }
      const s = document.createElement('script');
      s.id = 'gsi-script';
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = start;
      document.head.appendChild(s);
    },
  },
};

function AuthPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const provider = String(params?.provider || 'google').toLowerCase();
  const cfg = PROVIDERS[provider];

  const host = searchParams.get('host') || '';
  // Default landing after OAuth. `/dashboard` exists ONLY on the unified admin
  // host — on the marketing host it 404s — so fall back to the tenant home "/".
  // The backend resolves the real per-tenant destination from the `host` param;
  // this is only the tail-end default appended to that tenant redirect.
  const redirect = searchParams.get('redirect') || '/';

  const [status, setStatus] = useState('loading'); // loading|ready|processing|success|error
  const [error, setError] = useState('');
  const buttonRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!cfg || !cfg.clientId || !host || startedRef.current) return;
    startedRef.current = true;

    async function onCredential(credential) {
      if (!credential) { setError('Sign-in was cancelled'); setStatus('error'); return; }
      setStatus('processing');
      try {
        const res = await fetch(`/api/customer/social/${provider}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ credential, host, redirect }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || 'Authentication failed');
        }
        const { redirectUrl } = await res.json();
        const finalUrl = new URL(redirectUrl);
        // Open-redirect guard: the backend should only ever return a URL on the
        // tenant host we started the sign-in from. Refuse anything else so a
        // tampered/unexpected redirectUrl can't bounce the authed user off-site.
        const expectedHost = String(host || '').split(':')[0].toLowerCase();
        if (expectedHost && finalUrl.host.split(':')[0].toLowerCase() !== expectedHost) {
          throw new Error('Unexpected sign-in redirect target');
        }
        if (!finalUrl.searchParams.get('redirect')) finalUrl.searchParams.set('redirect', redirect);
        window.location.href = finalUrl.toString();
        setStatus('success');
      } catch (err) {
        setError(err.message);
        setStatus('error');
      }
    }

    cfg.load(buttonRef.current, onCredential, () => setStatus('ready'));
  }, [cfg, provider, host, redirect]);

  if (!cfg) {
    return (
      <Card>
        <h1 className="text-xl font-bold text-gray-900">Sign-in method unavailable</h1>
        <p className="mt-2 text-sm text-gray-500">
          “{provider}” sign-in isn’t available yet.
        </p>
      </Card>
    );
  }
  if (!host) {
    return (
      <Card>
        <h1 className="text-xl font-bold text-gray-900">Missing business</h1>
        <p className="mt-2 text-sm text-gray-500">This page requires a ?host= parameter.</p>
      </Card>
    );
  }
  if (!cfg.clientId) {
    return (
      <Card>
        <h1 className="text-xl font-bold text-gray-900">{cfg.name} Sign-In not configured</h1>
        <p className="mt-2 text-sm text-gray-500">
          NEXT_PUBLIC_GOOGLE_CLIENT_ID is missing from this build.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-center">
        <h1 className="text-xl font-bold text-gray-900">Sign in with {cfg.name}</h1>
        <p className="mt-1 text-sm text-gray-500">
          Signing into <strong>{host}</strong>
        </p>
      </div>

      <div className="mt-6 flex justify-center">
        {status === 'loading' && <p className="text-sm text-gray-500">Loading {cfg.name}…</p>}
        {(status === 'ready' || status === 'loading') && <div ref={buttonRef} />}
        {status === 'processing' && (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Spinner /> Signing you in…
          </div>
        )}
        {status === 'success' && <p className="text-sm text-emerald-700">Redirecting you back…</p>}
      </div>

      {status === 'error' && (
        <div className="mt-4">
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-center">
            {error}
          </p>
          <button onClick={() => { setStatus('ready'); setError(''); }}
            className="mt-3 w-full text-sm text-indigo-600 hover:underline">
            Try again
          </button>
        </div>
      )}

      <p className="mt-6 text-center text-xs text-gray-400">
        Secure authentication powered by {cfg.name}
      </p>
    </Card>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

function Card({ children }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        {children}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Card><p className="text-center text-sm text-gray-500">Loading…</p></Card>}>
      <AuthPage />
    </Suspense>
  );
}

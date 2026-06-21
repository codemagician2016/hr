'use client';

import Script from 'next/script';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

function mutateRedirectUrl(value, mutator) {
  const input = value || '/';
  const relative = input.startsWith('/');
  try {
    const url = new URL(input, 'https://sitepresso.local');
    mutator(url);
    return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    return input;
  }
}

function checkoutSuccessRedirectUrl(redirectUrl, transactionId) {
  return mutateRedirectUrl(redirectUrl, (url) => {
    if (transactionId) url.searchParams.set('_ptxn', transactionId);
  });
}

function manualReturnUrl(redirectUrl) {
  return mutateRedirectUrl(redirectUrl, (url) => {
    url.searchParams.delete('_ptxn');
    url.searchParams.delete('transaction_id');
    for (const key of ['billing', 'topup', 'domain', 'mailbox']) {
      if (url.searchParams.get(key) === 'success') url.searchParams.delete(key);
    }
  });
}

export default function PaddleCheckoutLauncherClient({ transactionId = '', redirectUrl = '/', cancelUrl = '' }) {
  const [scriptReady, setScriptReady] = useState(false);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(transactionId ? 'loading' : 'missing');
  const hasOpenedRef = useRef(false);
  const completedRef = useRef(false);
  const safeManualReturnUrl = useMemo(() => manualReturnUrl(redirectUrl), [redirectUrl]);
  // Where a cancelled/closed checkout goes. During onboarding the backend
  // passes cancel=/onboarding; otherwise fall back to the admin return URL.
  const cancelDest = useMemo(() => cancelUrl || safeManualReturnUrl, [cancelUrl, safeManualReturnUrl]);
  const isOnboardingCancel = cancelDest.startsWith('/onboarding');

  const message = useMemo(() => {
    if (status === 'loading') return 'Preparing secure checkout...';
    if (status === 'opening') return 'Opening checkout...';
    if (status === 'ready') return 'Checkout opened. Complete payment in the secure payment window.';
    if (status === 'missing') return 'This payment link is missing a transaction id.';
    return '';
  }, [status]);

  useEffect(() => {
    if (!transactionId) return;

    let cancelled = false;
    fetch('/api/subscription/paddle-config', { credentials: 'include' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || 'Could not load checkout configuration.');
        return body;
      })
      .then((body) => {
        if (!cancelled) setConfig(body);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Could not load checkout configuration.');
          setStatus('error');
        }
      });

    return () => { cancelled = true; };
  }, [transactionId]);

  useEffect(() => {
    if (!scriptReady || !config?.clientToken || !transactionId || hasOpenedRef.current) return;

    const Paddle = window.Paddle;
    if (!Paddle) return;

    try {
      if (config.environment === 'sandbox') {
        Paddle.Environment.set('sandbox');
      }

      if (!Paddle.Initialized) {
        Paddle.Initialize({
          token: config.clientToken,
          // Route a CLOSED (cancelled) overlay back to the right place. Success
          // still uses successUrl — we only redirect-on-close when payment was
          // NOT completed, so a paid checkout isn't bounced to the cancel page.
          eventCallback: (ev) => {
            if (ev?.name === 'checkout.completed') completedRef.current = true;
            if (ev?.name === 'checkout.closed' && !completedRef.current && cancelDest) {
              window.location.href = cancelDest;
            }
          },
        });
      }

      // Paddle requires successUrl to be an absolute http(s) URL. redirectUrl is
      // a same-origin relative path (e.g. "/restaurant/admin?billing=success"),
      // so resolve it against the current origin before handing it to Paddle —
      // passing the bare relative path fails validation and blocks checkout.
      const successRedirectUrl = checkoutSuccessRedirectUrl(redirectUrl, transactionId);
      const successUrl = successRedirectUrl?.startsWith('/')
        ? `${window.location.origin}${successRedirectUrl}`
        : successRedirectUrl;

      hasOpenedRef.current = true;
      setStatus('opening');
      Paddle.Checkout.open({
        transactionId,
        settings: {
          displayMode: 'overlay',
          allowLogout: false,
          theme: 'light',
          successUrl,
        },
      });
      setStatus('ready');
    } catch (err) {
      setError(err?.message || 'Could not open checkout.');
      setStatus('error');
    }
  }, [config, redirectUrl, scriptReady, transactionId, cancelDest]);

  return (
    <>
      <Script
        src="https://cdn.paddle.com/paddle/v2/paddle.js"
        strategy="afterInteractive"
        onLoad={() => setScriptReady(true)}
      />
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
        <div className="w-full max-w-xl bg-white border border-gray-200 rounded-3xl shadow-sm p-8 sm:p-10 text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center text-2xl">
            $
          </div>
          <h1 className="mt-5 text-2xl font-bold text-gray-900">Secure checkout</h1>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            {message || 'Follow the prompts to complete your plan change.'}
          </p>

          {transactionId && (
            <p className="mt-4 text-[11px] font-mono text-gray-400 break-all">
              Transaction: {transactionId}
            </p>
          )}

          {error && (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left">
              <p className="text-sm font-semibold text-red-800">Checkout could not open</p>
              <p className="text-sm text-red-700 mt-1">{error}</p>
            </div>
          )}

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href={cancelDest}
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800"
            >
              {isOnboardingCancel ? 'Back to setup' : 'Return to admin'}
            </a>
            <Link
              href="/login"
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-xl border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-400"
            >
              Go to login
            </Link>
          </div>

          <p className="mt-6 text-xs text-gray-400">
            Test mode checkout may show a sandbox watermark.
          </p>
        </div>
      </div>
    </>
  );
}

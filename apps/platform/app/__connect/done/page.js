'use client';

// Landing page after the OAuth callback finishes. The admin sees this in
// the new window the LanguageSelector opened; we read the result from the
// query string, show a friendly message, and auto-close the window so
// they're back to the admin tab where the integration list refreshes on
// focus.
//
// No auth required — the caller already proved authority via the
// JWT-signed `state` parameter that the backend's callback handler
// verified before reaching this redirect.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

export default function ConnectDonePage() {
  const params = useSearchParams();
  const provider = params.get('provider') || 'integration';
  const ok = params.get('ok') === '1';
  const errorMsg = params.get('error') || null;
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (ok && !errorMsg) {
      // Give the user a moment to see the success state, then close.
      const timer = setTimeout(() => {
        setClosing(true);
        try { window.close(); } catch { /* some browsers refuse window.close() unless we opened it ourselves */ }
      }, 1500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [ok, errorMsg]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full bg-white rounded-2xl border border-gray-200 p-8 text-center">
        {ok && !errorMsg ? (
          <>
            <div className="mx-auto w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-gray-900">Connected</h1>
            <p className="text-sm text-gray-500 mt-1">
              {provider.replace('_', ' ')} is now linked. {closing ? 'Closing…' : 'You can close this window.'}
            </p>
          </>
        ) : (
          <>
            <div className="mx-auto w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-gray-900">Connection failed</h1>
            <p className="text-sm text-gray-500 mt-1 break-words">
              {errorMsg || 'Something went wrong. Please close this window and try again.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

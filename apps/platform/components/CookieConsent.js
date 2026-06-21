'use client';

// Cookie consent banner. Shown on first visit until the user picks
// Accept or Reject. Stores the choice in localStorage so it doesn't
// re-prompt on every page load. Triggers a window event so other
// scripts (e.g. PostHogInit) can react when consent changes.
//
// Strictly-necessary cookies (auth / session / cart) are exempt from
// GDPR consent under the "necessary for the service the user requested"
// carve-out — they fire regardless. This banner gates only NON-essential
// cookies (currently: PostHog product analytics).
//
// Mounted in platform/app/layout.js. Footer should also expose a
// "Cookie preferences" link calling reopenCookieConsent().

import { useEffect, useState } from 'react';
import Link from 'next/link';

const STORAGE_KEY = 'sitepresso:cookie-consent';
const EVENT_NAME = 'sitepresso:cookie-consent-changed';

// Public helper — call from elsewhere to read the current decision.
// Returns 'accepted' | 'rejected' | null (no choice yet).
export function getCookieConsent() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.choice || null;
  } catch {
    return null;
  }
}

// Public helper — re-show the banner so the user can change their mind.
// Wire this to a "Cookie preferences" footer link.
export function reopenCookieConsent() {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { choice: null } }));
}

function setChoice(choice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      choice,
      version: 1,
      decidedAt: new Date().toISOString(),
    }));
  } catch { /* localStorage might be disabled — fail open, no banner */ }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { choice } }));
  }
}

export default function CookieConsent() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Only show banner if no choice recorded.
    const decision = getCookieConsent();
    setShow(decision === null);

    // Re-show if reopenCookieConsent() is called from elsewhere.
    function onChange(e) {
      setShow(e.detail?.choice === null);
    }
    window.addEventListener(EVENT_NAME, onChange);
    return () => window.removeEventListener(EVENT_NAME, onChange);
  }, []);

  if (!show) return null;

  function accept() { setChoice('accepted'); setShow(false); }
  function reject() { setChoice('rejected'); setShow(false); }

  return (
    <div
      role="dialog"
      aria-label="Cookie preferences"
      aria-describedby="cookie-consent-description"
      className="fixed bottom-0 inset-x-0 z-50 p-4"
    >
      <div className="max-w-3xl mx-auto rounded-2xl border border-gray-200 bg-white shadow-2xl p-5 sm:p-6">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0 max-w-xl">
            <p className="text-sm font-semibold text-gray-900">We use cookies</p>
            <p id="cookie-consent-description" className="mt-1 text-xs text-gray-600 leading-relaxed">
              Strictly-necessary cookies (sign-in, session, language) always run.
              We&rsquo;d also like to set optional analytics cookies to understand how
              Sitepresso is used so we can improve it. You can accept or reject the
              optional cookies — your choice is saved and you can change it anytime.{' '}
              <Link href="/legal/cookies" className="text-indigo-600 hover:underline whitespace-nowrap">
                Learn more →
              </Link>
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={reject}
              className="px-4 py-2 rounded-lg text-sm font-semibold border border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50"
            >
              Reject optional
            </button>
            <button
              type="button"
              onClick={accept}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-gray-900 hover:bg-black text-white"
            >
              Accept all
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

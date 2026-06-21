'use client';

// PostHog product-analytics initializer.
//
// Gated on cookie consent — the banner in CookieConsent.js writes
// 'accepted' to localStorage when the user accepts optional cookies;
// only then do we boot PostHog. Reject = nothing loaded; nothing
// captured. Listens for the consent-changed event so toggling consent
// from the footer 'Cookie preferences' link takes effect immediately.

import { useEffect, useState } from 'react';
import posthog from 'posthog-js';
import { getCookieConsent } from './CookieConsent';

// Public PostHog write key. Public by design — ships in every frontend
// bundle, can only write events (not read data). Override with
// NEXT_PUBLIC_POSTHOG_KEY if you ever need to rotate or point at a
// different project.
const DEFAULT_POSTHOG_KEY = 'phc_snixp6LDrguRt8xGUG73tjxPbpV58g4RWP3w9JdahKEi';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

const CONSENT_EVENT = 'sitepresso:cookie-consent-changed';

function initPostHog() {
  if (typeof window === 'undefined') return;
  if (posthog.__loaded) return; // guard against double-init in StrictMode
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY || DEFAULT_POSTHOG_KEY;
  if (!key) return;
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
    capture_pageview: true,
    capture_pageleave: true,
    respect_dnt: true,
    autocapture: { dom_event_allowlist: ['click', 'submit'] },
    persistence: 'localStorage+cookie',
    loaded: (ph) => {
      if (process.env.NODE_ENV === 'development') ph.debug();
    },
  });
}

function shutdownPostHog() {
  if (typeof window === 'undefined') return;
  // posthog-js doesn't expose a clean uninit, but we can reset the
  // identity + clear localStorage entries so no further data is sent
  // tied to the previous identity. Future page-loads won't init unless
  // consent is granted again.
  try {
    if (posthog.__loaded) posthog.reset(true); // clears local identity
  } catch { /* swallow */ }
  // Wipe any posthog-* localStorage keys so a future opt-in starts clean.
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ph_')) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

export default function PostHogInit() {
  const [, force] = useState(0);

  useEffect(() => {
    if (getCookieConsent() === 'accepted') initPostHog();

    function onConsentChange(e) {
      const choice = e.detail?.choice;
      if (choice === 'accepted') initPostHog();
      else shutdownPostHog();
      force((n) => n + 1);
    }
    window.addEventListener(CONSENT_EVENT, onConsentChange);
    return () => window.removeEventListener(CONSENT_EVENT, onConsentChange);
  }, []);

  return null;
}

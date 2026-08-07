'use client';

/**
 * UpdateAvailable — offers a reload when a deploy has replaced the app underneath
 * an open tab.
 *
 * THE PROBLEM
 * -----------
 * These apps are built locally and the prebuilt .next is copied to the box, where
 * pm2 restarts the server. A tab that was already open keeps running the OLD
 * bundle. Its JS chunks are content-hashed, so any chunk it has not fetched YET
 * now 404s — the user clicks something and gets a blank panel or a dead button,
 * and the only known cure is "hard-refresh / clear your cache". People do not
 * know to do that, and should not have to.
 *
 * HOW IT DETECTS
 * --------------
 * NEXT_PUBLIC_BUILD_ID is frozen into this bundle at build time. /app-version is
 * answered by the CURRENTLY RUNNING server. They agree until a deploy happens.
 * When they stop agreeing, this tab is provably stale.
 *
 * DESIGN CHOICES
 * --------------
 *  - ASKS, never reloads by itself: a silent reload mid-form would throw away
 *    whatever the user was typing. The one exception is a failed chunk fetch,
 *    where the screen is already broken and there is nothing left to protect.
 *  - Polls on FOCUS and visibility, not just a timer. The realistic case is a tab
 *    left open overnight through a deploy; it should be correct the moment
 *    someone comes back to it, not up to a poll-interval later.
 *  - Fails silent. A network blip must never produce a spurious "update" nag, so
 *    anything other than a clean, differing build id is ignored.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 2 * 60 * 1000;      // gentle: a deploy is not an emergency
const MIN_GAP_MS = 20 * 1000;       // never hammer on rapid focus/blur
const SNOOZE_MS = 30 * 60 * 1000;   // "Later" must MEAN later

export default function UpdateAvailable() {
  const [stale, setStale] = useState(false);
  const [broken, setBroken] = useState(false); // a chunk actually failed to load
  const [reloading, setReloading] = useState(false);
  const lastCheck = useRef(0);
  const snoozedUntil = useRef(0);
  const mine = process.env.NEXT_PUBLIC_BUILD_ID || '';

  const check = useCallback(async () => {
    if (!mine || stale) return;             // nothing to compare, or already known
    const now = Date.now();
    // Without this, dismissing the banner just means it reappears on the next
    // poll — a nag the user cannot escape while they finish what they were doing.
    if (now < snoozedUntil.current) return;
    if (now - lastCheck.current < MIN_GAP_MS) return;
    lastCheck.current = now;
    try {
      const r = await fetch('/app-version', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      const theirs = j && j.buildId;
      // Only a CONFIRMED, different, known id counts. 'unknown' or a missing
      // value means the check is inconclusive, not that an update exists.
      if (theirs && theirs !== 'unknown' && theirs !== mine) setStale(true);
    } catch { /* offline or mid-restart — try again next time */ }
  }, [mine, stale]);

  useEffect(() => {
    check();
    const timer = setInterval(check, POLL_MS);
    const onFocus = () => check();
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check]);

  // A chunk that 404s is the deploy already having broken this tab. Next surfaces
  // it as a ChunkLoadError; the plain script-tag failure arrives as an 'error'
  // event with no message. Either way the page is unusable, so escalate the
  // banner instead of waiting for the poll.
  useEffect(() => {
    function isChunkFailure(msg) {
      const s = String(msg || '');
      return s.includes('ChunkLoadError')
        || s.includes('Loading chunk')
        || s.includes('Loading CSS chunk')
        || s.includes('error loading dynamically imported module');
    }
    const onError = (e) => {
      if (isChunkFailure(e?.message) || isChunkFailure(e?.error?.name) || isChunkFailure(e?.error?.message)) {
        setStale(true); setBroken(true);
      }
    };
    const onRejection = (e) => {
      const r = e?.reason;
      if (isChunkFailure(r?.name) || isChunkFailure(r?.message)) { setStale(true); setBroken(true); }
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  const update = useCallback(async () => {
    setReloading(true);
    // Drop anything that could serve the old bundle back to us. A plain reload
    // can be answered from the bfcache/HTTP cache with the very HTML that
    // referenced the dead chunks, which would leave the user exactly where they
    // started — the "I refreshed and it is still broken" complaint.
    try {
      if (typeof caches !== 'undefined' && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch { /* Cache Storage unavailable — the reload below still helps */ }
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch { /* no service worker — fine */ }
    // Cache-busted URL so the HTML itself cannot come from cache. The parameter is
    // stripped from the address bar afterwards by the browser's normal navigation.
    const url = new URL(window.location.href);
    url.searchParams.set('_v', Date.now().toString(36));
    window.location.replace(url.toString());
  }, []);

  if (!stale) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-3 pointer-events-none"
    >
      <div className="pointer-events-auto w-full max-w-xl rounded-xl border border-gray-200 bg-white shadow-lg px-4 py-3 flex items-center gap-3">
        <div className="flex-1 text-sm">
          <div className="font-semibold text-gray-900">
            {broken ? 'This page is out of date' : 'A new version is available'}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {broken
              ? 'The app was updated while this tab was open, so parts of this page stopped working. Reload to fix it.'
              : 'Reload to pick it up. Finish anything you are typing first — reloading discards unsaved changes.'}
          </div>
        </div>
        {!broken && (
          <button
            type="button"
            onClick={() => { snoozedUntil.current = Date.now() + SNOOZE_MS; setStale(false); }}
            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
          >
            Later
          </button>
        )}
        <button
          type="button"
          onClick={update}
          disabled={reloading}
          className="text-sm font-medium rounded-lg px-3 py-1.5 text-white disabled:opacity-60"
          style={{ backgroundColor: 'var(--theme-primary)' }}
        >
          {reloading ? 'Reloading…' : 'Reload'}
        </button>
      </div>
    </div>
  );
}

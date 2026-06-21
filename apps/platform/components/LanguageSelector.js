'use client';

// Language picker — a tiny dropdown sitting in the top-right of every
// page. Reads the current locale from the NEXT_LOCALE cookie (set by
// the middleware on first visit, or by the user via this component
// thereafter). On change, writes the cookie + reloads so server
// components pick up the new locale.
//
// Logged-in users (admin / staff / customer) also persist the choice
// in the DB so the same locale follows them across devices. The DB
// write is fire-and-forget; the cookie write is the source of truth
// for the current page render.

import { useState } from 'react';
import { SUPPORTED_LOCALES, LOCALE_LABELS } from '@/i18n/config';

export default function LanguageSelector({ currentLocale, compact = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = SUPPORTED_LOCALES.includes(currentLocale) ? currentLocale : 'en';

  async function pick(next) {
    if (next === active || busy) return;
    setBusy(true);
    // Two cookies: the locale itself + an "explicit" flag the
    // middleware checks to know this is a user pick (sticky) and
    // not auto-detection (recomputed every request from geo-IP).
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=${oneYear}; samesite=lax`;
    document.cookie = `NEXT_LOCALE_EXPLICIT=1; path=/; max-age=${oneYear}; samesite=lax`;
    // Best-effort DB persistence for logged-in users. Endpoint is no-
    // op-friendly for guests (returns 401 silently). We don't await
    // on the navigation to keep the UX snappy.
    try {
      fetch('/api/locale', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      }).catch(() => {});
    } catch { /* fail silent */ }
    // Reload so server-side rendering picks up the new locale.
    window.location.reload();
  }

  const label = LOCALE_LABELS[active] || LOCALE_LABELS.en;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 ${compact ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'}`}
        aria-label="Change language"
      >
        <svg width={compact ? '12' : '14'} height={compact ? '12' : '14'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
        <span>{label.native}</span>
        <svg className={`transition-transform ${open ? 'rotate-180' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-40">
            {SUPPORTED_LOCALES.map((code) => {
              const l = LOCALE_LABELS[code];
              const selected = code === active;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => { setOpen(false); pick(code); }}
                  disabled={busy}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center justify-between gap-2 ${selected ? 'font-semibold text-indigo-600 bg-indigo-50/30' : 'text-gray-700'}`}
                >
                  <span>
                    <span className="block">{l.native}</span>
                    {l.native !== l.english && (
                      <span className="block text-[10px] text-gray-400">{l.english}</span>
                    )}
                  </span>
                  {selected && <span className="text-indigo-600">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

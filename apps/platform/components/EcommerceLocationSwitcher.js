'use client';

// Location switcher for ECOMMERCE Path B (2026-05-01).
// Mounts in the admin topbar when Business.vertical === 'ECOMMERCE'.
//
// Why this exists: every ECOMMERCE panel (orders, inventory, slots,
// payments, etc.) is per-location. The owner of a 5-store grocery chain
// wants to flip between "all stores" and "just Bandra" in one click rather
// than re-entering filters on each tab. The active location lives in
// localStorage so it survives navigation and reloads.
//
// Storage key: `ecom-active-location-${businessSlug}` — value is either
// 'ALL' or the location id. Panels read it via `useEcommerceLocation()`.
// Store-scoped admin panels depend on this provider for permission-aware APIs.

import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const LocationContext = createContext({
  active: 'ALL',
  setActive: () => {},
  locations: [],
  allowAll: true,
  loading: false,
});

const STORAGE_PREFIX = 'ecom-active-location:';

export function EcommerceLocationProvider({ businessSlug, children }) {
  const [locations, setLocations] = useState([]);
  const [allowAll, setAllowAll] = useState(true);
  const [loading, setLoading] = useState(true);
  const [active, setActiveState] = useState('ALL');

  const storageKey = businessSlug ? `${STORAGE_PREFIX}${businessSlug}` : null;

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(storageKey);
    if (stored) setActiveState(stored);
  }, [storageKey]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/ecom/locations', { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled) setLocations([]);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const rows = Array.isArray(data?.locations) ? data.locations : [];
        const canUseAll = data?.allowAll !== false;
        const stored = storageKey && typeof window !== 'undefined'
          ? window.localStorage.getItem(storageKey)
          : null;
        const storedIsValid = stored === 'ALL'
          ? canUseAll
          : rows.some((loc) => loc.id === stored);
        const nextActive = storedIsValid
          ? stored
          : (data?.defaultLocationId && data.defaultLocationId !== 'ALL' ? data.defaultLocationId : (canUseAll ? 'ALL' : rows[0]?.id || 'ALL'));
        setAllowAll(canUseAll);
        setLocations(rows);
        setActiveState(nextActive);
        if (storageKey && typeof window !== 'undefined') {
          window.localStorage.setItem(storageKey, nextActive);
        }
      } catch {
        if (!cancelled) setLocations([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const setActive = useCallback((next) => {
    setActiveState(next);
    if (storageKey && typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, next);
    }
  }, [storageKey]);

  const value = { active, setActive, locations, allowAll, loading };
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useEcommerceLocation() {
  return useContext(LocationContext);
}

export default function EcommerceLocationSwitcher() {
  const { active, setActive, locations, allowAll, loading } = useEcommerceLocation();
  const [open, setOpen] = useState(false);

  const activeLabel = active === 'ALL'
    ? 'All locations'
    : (locations.find((l) => l.id === active)?.name || 'All locations');

  const activeCount = active === 'ALL'
    ? locations.length
    : 1;

  if (loading && locations.length === 0) {
    return (
      <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 text-xs text-gray-500">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-pulse" />
        Loading locations…
      </div>
    );
  }

  if (locations.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 text-sm font-medium hover:border-gray-300 transition-all bg-white"
        style={{ color: '#374151' }}
      >
        <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21s-7-7-7-12a7 7 0 1114 0c0 5-7 12-7 12z" />
          <circle cx="12" cy="9" r="2.5" />
        </svg>
        <span className="hidden sm:inline">{activeLabel}</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
          {activeCount}
        </span>
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute right-0 mt-2 w-72 bg-white rounded-2xl shadow-lg border border-gray-200 z-40 overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Filter all panels by</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">Active location</p>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {allowAll && (
                <button
                  type="button"
                  onClick={() => { setActive('ALL'); setOpen(false); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center justify-between gap-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-900">All locations</p>
                    <p className="text-xs text-gray-500 mt-0.5">{locations.length} stores combined</p>
                  </div>
                  {active === 'ALL' && (
                    <span className="w-5 h-5 rounded-full flex items-center justify-center text-white" style={{ background: 'var(--theme-primary)' }}>
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                  )}
                </button>
              )}
              {locations.map((loc) => (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => { setActive(loc.id); setOpen(false); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center justify-between gap-3 border-t border-gray-50"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{loc.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {[loc.city, loc.region].filter(Boolean).join(', ') || loc.address || '—'}
                    </p>
                  </div>
                  {active === loc.id && (
                    <span className="w-5 h-5 rounded-full flex items-center justify-center text-white flex-shrink-0" style={{ background: 'var(--theme-primary)' }}>
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
              <p className="text-[10px] text-gray-500">
                Switching here filters every ECOMMERCE panel — orders, inventory, slots, payments.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

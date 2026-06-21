'use client';

// Tenant context for platform-path portals (sitepresso.com/<slug>/admin
// and /staff). Unlike the subdomain TenantProvider which resolves from
// the hostname, this version resolves from the URL slug segment.
//
// Shape of `tenant` matches what the legacy business/admin/staff UI
// expects — `{ business, content, subscription }` — so the ported UI
// can keep using `useTenant()` unchanged.
//
// Applies theme CSS vars to the document root on every tenant change,
// so `var(--theme-primary)` etc. resolve correctly inside the ported
// admin shell.

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { getThemeVars, resolveThemeKey } from '@/lib/themes';
import { parseThemeColors } from '@/lib/themeColors';

const TenantContext = createContext({
  tenant: null,
  loading: true,
  error: null,
  refresh: async () => {},
});

function extractLegacyOverrides(content) {
  return {
    primary: content?.customPrimary,
    bg: content?.customBg,
    surface: content?.customSurface,
    text: content?.customText,
    accent: content?.customAccent,
  };
}

function applyThemeVars(tenant) {
  if (typeof document === 'undefined') return;
  const subscription = tenant?.subscription || null;
  const themeName = resolveThemeKey(subscription?.theme || tenant?.theme);
  const themeStyle = subscription?.themeStyle;
  const themeColors = {
    ...extractLegacyOverrides(tenant?.content),
    ...parseThemeColors(subscription?.themeColors),
  };
  const vars = getThemeVars(themeName, themeStyle, themeColors);
  for (const [key, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(key, value);
  }
}

// First-visit locale sync — same logic as the storefront TenantProvider.
// Mirrored here so an admin / staff member who hasn't picked a language
// gets the business's house language on the admin pages too.
const SUPPORTED_LOCALE_SET = new Set(['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR']);

function syncLocaleToBusinessDefault(tenant) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const target = tenant?.business?.defaultLanguage;
  if (!target || !SUPPORTED_LOCALE_SET.has(target)) return;
  const cookies = document.cookie || '';
  const explicit = /(?:^|;\s*)NEXT_LOCALE_EXPLICIT=1/.test(cookies);
  if (explicit) return;
  const current = cookies.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1];
  if (current === target) return;
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `NEXT_LOCALE=${target}; path=/; max-age=${oneYear}; samesite=lax`;
  window.location.reload();
}

async function fetchTenantBySlug(slug) {
  const res = await fetch(`/api/tenant/resolve?slug=${encodeURIComponent(slug)}`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  return res.json();
}

// Self-mode — used by the unified-admin domain (app.aapkatech.com) where
// the URL has no slug. Tenant comes from the caller's JWT.
async function fetchTenantSelf() {
  const res = await fetch('/api/tenant/me', { credentials: 'include' });
  if (!res.ok) return null;
  return res.json();
}

// `slug` resolves the tenant from the URL slug segment (path-based admin).
// `mode="self"` resolves from the caller's JWT (unified-admin domain).
// The two modes are mutually exclusive — pass exactly one.
export default function TenantProvider({ slug, mode, children }) {
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const lastKeyRef = useRef(null);
  const isSelfMode = mode === 'self' && !slug;
  const key = isSelfMode ? '__self__' : slug;

  async function load() {
    if (!key) {
      setTenant(null);
      setLoading(false);
      setError(new Error('No tenant slug provided'));
      return;
    }
    lastKeyRef.current = key;
    try {
      const fresh = isSelfMode ? await fetchTenantSelf() : await fetchTenantBySlug(slug);
      if (lastKeyRef.current !== key) return; // changed mid-fetch
      if (!fresh) {
        setTenant(null);
        setError(new Error(isSelfMode ? 'No business linked to your account' : 'Business not found'));
      } else {
        setTenant(fresh);
        applyThemeVars(fresh);
        syncLocaleToBusinessDefault(fresh);
        setError(null);
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const value = { tenant, loading, error, refresh: load };
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  return useContext(TenantContext);
}

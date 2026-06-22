'use client';

// White-label surface for the ESS app.
//
// 1. Resolves the tenant by Host header — GET /api/tenant/resolve (the router
//    fronts tenant.com / <slug>.hr.com and proxies through, so the backend
//    keys off Host; no slug needed here).
// 2. Feeds the subscription brand { styleKey/theme, themeColors, logoUrl } into
//    @hr/theme-engine resolveTenantTheme({ styleKey, colorKey, logoUrl }).
// 3. Injects the resulting CSS variables on <html> so var(--theme-primary) etc.
//    resolve everywhere. THIS is where the 5 styles x 12 colors land.
//
// Exposes useTenant() → { tenant, theme, loading, error, refresh } for the
// branded header and any page that needs the business name / logo.

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { resolveTenantTheme } from '@hr/theme-engine';
import { themeVarsFromResolved } from '@/lib/themeVars';
import { resolveTenant } from '@/lib/api';

const TenantContext = createContext({
  tenant: null,
  theme: null,
  loading: true,
  error: null,
  refresh: async () => {},
});

// The resolve payload shape is { business, subscription }, where the brand
// lives on subscription as { styleKey | theme, themeColors, logoUrl }. Pull a
// normalized brand input for resolveTenantTheme, tolerating a couple of legacy
// field names so the white-label surface never renders unstyled.
function brandInputFromResolve(data) {
  const sub = data?.subscription || {};
  const brand = sub.brand || sub || {};
  return {
    styleKey: brand.styleKey || brand.theme || brand.themeStyle,
    colorKey: brand.colorKey || brand.themeColors || brand.color,
    logoUrl: brand.logoUrl || brand.logo || data?.business?.logoUrl,
  };
}

function applyThemeVars(theme) {
  if (typeof document === 'undefined' || !theme) return;
  const vars = themeVarsFromResolved(theme);
  for (const [key, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(key, value);
  }
  // Expose the style key for any per-style CSS hooks (mirrors platform's
  // [data-theme] convention).
  if (theme.styleKey) {
    document.documentElement.setAttribute('data-theme', theme.styleKey);
  }
}

export default function TenantProvider({ children }) {
  const [tenant, setTenant] = useState(null);
  const [theme, setTheme] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const tickRef = useRef(0);

  async function load() {
    const myTick = ++tickRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await resolveTenant();
      if (myTick !== tickRef.current) return;
      const resolved = resolveTenantTheme(brandInputFromResolve(data));
      setTenant(data);
      setTheme(resolved);
      applyThemeVars(resolved);
      setError(null);
    } catch (e) {
      if (myTick !== tickRef.current) return;
      setError(e);
    } finally {
      if (myTick === tickRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = { tenant, theme, loading, error, refresh: load };
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  return useContext(TenantContext);
}

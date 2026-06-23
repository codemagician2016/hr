'use client';

// useTenantCountries — Feature 14 (strict single-country mode). The tenant operates
// in exactly ONE HR country: Business.hrCountry, the authoritative selector. This
// hook reads /api/hr/country-context (the single source of truth) and returns that
// ONE country as a one-element array, so every config surface (holidays, leave
// types, statutory fields) offers ONLY the tenant country — an IN tenant is NEVER
// offered NZ, and vice-versa.
//
// Returns { countries: string[], country, currency, capabilities, loading, error }.
// `countries` is kept (one element, e.g. ['IN']) so existing consumers that gate on
// the array need no change. FAIL-CLOSED: on error / pre-setup the array is empty —
// callers fall back to NOT offering a wrong-country option.

import { useEffect, useMemo, useState } from 'react';
import { get } from '@/lib/api';

export function useTenantCountries() {
  const [ctx, setCtx] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    get('/api/hr/country-context')
      .then((r) => { if (alive) setCtx(r || {}); })
      .catch((e) => { if (alive) { setCtx({}); setError(e); } });
    return () => { alive = false; };
  }, []);

  const country = ctx && ctx.country ? String(ctx.country).toUpperCase() : null;
  const countries = useMemo(() => (country ? [country] : []), [country]);

  return {
    countries,
    country,
    currency: (ctx && ctx.currency) || null,
    capabilities: (ctx && ctx.capabilities) || null,
    loading: ctx === null,
    error,
  };
}

// Helper: is this country the tenant's? Single-country tenants gate strictly; an
// unknown set (loading / pre-setup) is fail-closed (false).
export function tenantHasCountry(countries, cc) {
  if (!Array.isArray(countries) || countries.length === 0) return false;
  return countries.includes(String(cc || '').toUpperCase());
}

export default useTenantCountries;

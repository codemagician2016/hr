'use client';

// useCountry — the single, authoritative way an ESS page learns the signed-in
// employee's tenant country + capability matrix (Feature 14: strict single-country
// mode). It calls /api/hr/me/country-context, which resolves off the tenant's
// Business.hrCountry (the ONE source of truth). The capability matrix drives every
// country-specific surface (statutory ids, tax regime, currency) so no ESS page
// hard-codes 'IN'/'NZ'.
//
// FAIL-CLOSED contract: `country` is one of 'IN' | 'NZ' | null. It is `null` while
// loading AND whenever the tenant country is not set up / ambiguous (the endpoint
// 409s). Callers MUST NOT default a null country to a market — they render neither
// country's fields/components/validators when country is null. `capabilities` is
// null until resolved; gate UI on `capabilities.*`, never a literal.

import { useEffect, useState } from 'react';
import { fetchMyCountryContext } from '@/lib/api';

// Normalize whatever the backend returns to exactly 'IN' | 'NZ' | null.
function normalize(cc) {
  if (typeof cc !== 'string') return null;
  const s = cc.trim().toUpperCase();
  if (s === 'IN' || s === 'NZ') return s;
  return null;
}

export function useCountry() {
  const [state, setState] = useState({
    country: null, currency: null, capabilities: null, loading: true, error: null, notConfigured: false,
  });

  useEffect(() => {
    let alive = true;
    fetchMyCountryContext()
      .then((c) => {
        if (!alive) return;
        setState({
          country: normalize(c?.country),
          currency: c?.currency || null,
          capabilities: c?.capabilities || null,
          loading: false,
          error: null,
          notConfigured: false,
        });
      })
      .catch((e) => {
        // Fail closed. A 409 means the tenant has no HR country yet (pre-setup) or
        // is quarantined — render an "HR not configured" state, never a market guess.
        if (!alive) return;
        const notConfigured = e && (e.status === 409);
        setState({ country: null, currency: null, capabilities: null, loading: false, error: e, notConfigured });
      });
    return () => { alive = false; };
  }, []);

  return state;
}

export default useCountry;

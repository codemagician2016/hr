'use client';

// useCountry — the single, authoritative way an ESS page learns the signed-in
// employee's operating country (global payroll: IN + NZ). It calls the backend
// /api/hr/me/profile endpoint, which resolves the country from the employee's
// StatutoryProfile / Employee row / the entity they work in.
//
// FAIL-CLOSED contract: `country` is one of 'IN' | 'NZ' | null. It is `null`
// while loading AND whenever the backend cannot authoritatively determine the
// country. Callers MUST NOT default a null country to a market — they render
// neither country's fields/components/validators when country is null, so an NZ
// employee never sees India blocks and vice-versa.

import { useEffect, useState } from 'react';
import { fetchMyProfile } from '@/lib/api';

// Normalize whatever the backend returns to exactly 'IN' | 'NZ' | null.
function normalize(cc) {
  if (typeof cc !== 'string') return null;
  const s = cc.trim().toUpperCase();
  if (s === 'IN' || s === 'NZ') return s;
  return null;
}

export function useCountry() {
  const [state, setState] = useState({ country: null, currency: null, loading: true, error: null });

  useEffect(() => {
    let alive = true;
    fetchMyProfile()
      .then((p) => {
        if (!alive) return;
        setState({ country: normalize(p?.countryCode), currency: p?.payCurrency || null, loading: false, error: null });
      })
      .catch((e) => {
        // On error, fail closed: country stays null (no wrong-country block shown).
        if (!alive) return;
        setState({ country: null, currency: null, loading: false, error: e });
      });
    return () => { alive = false; };
  }, []);

  return state;
}

export default useCountry;

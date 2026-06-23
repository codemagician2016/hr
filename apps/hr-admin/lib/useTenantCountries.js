'use client';

// useTenantCountries — the tenant's distinct operating countries (global payroll:
// IN + NZ), derived from its Entities (each Entity carries the authoritative
// countryCode). Admin config surfaces use this to gate country-specific options:
// a single-country NZ tenant must NOT be offered India-only fields/options and
// vice-versa; only a genuinely multi-country tenant sees both.
//
// Returns { countries: string[], loading, error } where `countries` is the
// distinct, upper-cased set (e.g. ['NZ'] or ['IN','NZ']). FAIL-CLOSED: on error
// or while loading it is the empty array — callers fall back to NOT offering a
// wrong-country option rather than showing both.

import { useEffect, useMemo, useState } from 'react';
import { get } from '@/lib/api';

export function useTenantCountries() {
  const [entities, setEntities] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    get('/api/hr/payroll/entities')
      .then((r) => { if (alive) setEntities(r?.items || []); })
      .catch((e) => { if (alive) { setEntities([]); setError(e); } });
    return () => { alive = false; };
  }, []);

  const countries = useMemo(() => {
    if (!Array.isArray(entities)) return [];
    return [...new Set(entities.map((e) => String(e.countryCode || '').toUpperCase()).filter(Boolean))];
  }, [entities]);

  return { countries, loading: entities === null, error };
}

// Helper: is this country relevant to the tenant? When the tenant's country set
// is unknown (still loading / empty), be permissive ONLY for the multi-country
// case — single-country tenants gate strictly. Callers typically use
// `countries.length <= 1 ? countries.includes(cc) : true` semantics; this helper
// encodes "show option for country cc given the tenant's set".
export function tenantHasCountry(countries, cc) {
  if (!Array.isArray(countries) || countries.length === 0) return false;
  return countries.includes(String(cc || '').toUpperCase());
}

export default useTenantCountries;

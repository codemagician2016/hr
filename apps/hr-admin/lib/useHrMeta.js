'use client';

// useHrMeta — Program P1.7. One fetch of GET /api/hr/meta (operator session)
// serves every enum vocabulary the console used to hardcode: genders, marital
// statuses, employment types, dependant relations, education levels, separation
// types, document categories, holiday types, payout banks, address types.
//
// Module-level cache: the first mounted consumer fetches; everyone else reuses
// the same promise/result. Each key falls back to a tiny hardcoded list when
// the fetch fails (or a key comes back empty) so pages NEVER render an empty
// select — but the server list is authoritative whenever it arrives.

import { useEffect, useMemo, useState } from 'react';
import { get } from '@/lib/api';

// Fetched-failed fallbacks — mirror the backend enums as of P1.7.
export const FALLBACK_META = {
  genders: ['MALE', 'FEMALE', 'NON_BINARY', 'UNDISCLOSED', 'OTHER'],
  maritalStatuses: ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED', 'CIVIL_UNION', 'UNDISCLOSED'],
  employmentTypes: ['FULL_TIME', 'PART_TIME', 'FIXED_TERM', 'CONTRACT', 'INTERN', 'APPRENTICE', 'CASUAL', 'CONSULTANT'],
  dependantRelations: ['SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER'],
  educationLevels: ['SCHOOL', 'DIPLOMA', 'BACHELORS', 'MASTERS', 'DOCTORATE', 'CERTIFICATION', 'OTHER'],
  separationTypes: [
    'RESIGNATION', 'TERMINATION_FOR_CAUSE', 'RETRENCHMENT', 'REDUNDANCY', 'END_OF_CONTRACT',
    'RETIREMENT', 'DEATH', 'ABSCONDING', 'PROBATION_FAILURE', 'MUTUAL_SEPARATION',
  ],
  documentCategories: [],
  holidayTypes: [],
  payoutBanks: ['HDFC', 'ICICI', 'AXIS', 'KOTAK', 'SBI', 'NEFT_RTGS'],
  addressTypes: ['CORRESPONDENCE', 'PERMANENT', 'OFFICE'],
};

// "FULL_TIME" → "Full Time" — the shared SNAKE → Title-case humanizer.
export function labelize(v) {
  return String(v || '')
    .split('_')
    .map((w) => (w ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ');
}

let cached = null; // resolved meta body
let inflight = null; // in-progress fetch promise

function fetchMeta() {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = get('/api/hr/meta')
      .then((body) => {
        cached = body && typeof body === 'object' ? body : {};
        return cached;
      })
      .catch(() => {
        inflight = null; // allow a later mount to retry
        return null;
      });
  }
  return inflight;
}

// Returns the meta vocabularies, fallback-merged per key (a fetched non-empty
// array wins; anything missing keeps the hardcoded fallback).
export function useHrMeta() {
  const [fetched, setFetched] = useState(cached);

  useEffect(() => {
    let alive = true;
    if (!cached) fetchMeta().then((m) => { if (alive && m) setFetched(m); });
    return () => { alive = false; };
  }, []);

  return useMemo(() => {
    const merged = {};
    for (const key of Object.keys(FALLBACK_META)) {
      const v = fetched?.[key];
      merged[key] = Array.isArray(v) && v.length > 0 ? v : FALLBACK_META[key];
    }
    return merged;
  }, [fetched]);
}

export default useHrMeta;

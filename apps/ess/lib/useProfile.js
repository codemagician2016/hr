'use client';

// useProfile — the single way an ESS page/component reads the signed-in
// employee's PROFILE details (code, department, designation, location, date of
// joining, phone, email, photo). It calls /api/hr/me/profile, which resolves the
// employee SERVER-SIDE from the customer session and returns a `profile` object
// (the bare /api/customer/me session does NOT carry these fields — audit #58).
//
// Returns { profile, employeeId, countryCode, loading, error }. `profile` is null
// while loading and whenever the employee cannot be resolved, so callers should
// degrade gracefully (the page still renders name/email from the session).

import { useEffect, useState } from 'react';
import { fetchMyProfile } from '@/lib/api';

export function useProfile() {
  const [state, setState] = useState({
    profile: null, employeeId: null, countryCode: null, loading: true, error: null,
  });

  useEffect(() => {
    let alive = true;
    fetchMyProfile()
      .then((p) => {
        if (!alive) return;
        setState({
          profile: p?.profile || null,
          employeeId: p?.employeeId || p?.profile?.employeeId || null,
          countryCode: p?.countryCode || null,
          loading: false,
          error: null,
        });
      })
      .catch((e) => {
        if (!alive) return;
        setState({ profile: null, employeeId: null, countryCode: null, loading: false, error: e });
      });
    return () => { alive = false; };
  }, []);

  return state;
}

export default useProfile;

'use client';

// Cleanup #5 — single hook for the loading/error/data dance. Replaces
// the ~15-line useState(loading) + useState(error) + useEffect(fetch +
// setState + cleanup) pattern repeated across ~16 admin panels.
//
// Usage:
//   const { data, loading, error, reload } = useApi('/api/services');
//
// Options:
//   - enabled:   when false, the hook stays idle (no fetch). Useful
//                when the URL depends on something that isn't ready
//                yet, e.g. `enabled: !!businessId`.
//   - deps:      extra dependency array — the hook re-fetches when any
//                value changes. Default [] = fetch only on mount.
//   - select:    (raw) => unwrappedData — lets callers extract a
//                nested key like `(r) => r.services` so consumers
//                don't all repeat `data?.services || []`.
//
// Cleans up via an `aborted` flag so a slow response from a previous
// URL doesn't clobber state after a deps change.

import { useCallback, useEffect, useRef, useState } from 'react';

async function jsonOrThrow(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.errors = body.errors || body.issues || [];
    throw err;
  }
  return body;
}

export function useApi(url, { enabled = true, deps = [], select } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!!enabled);
  const [error, setError] = useState(null);
  const tickRef = useRef(0); // bumps on every reload — discards stale fetches

  const reload = useCallback(async () => {
    if (!url || !enabled) {
      setLoading(false);
      return;
    }
    const myTick = ++tickRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { credentials: 'include' });
      const body = await jsonOrThrow(res);
      if (myTick !== tickRef.current) return; // stale — newer reload in flight
      setData(select ? select(body) : body);
    } catch (e) {
      if (myTick !== tickRef.current) return;
      setError(e);
    } finally {
      if (myTick === tickRef.current) setLoading(false);
    }
  }, [url, enabled, select]);

  useEffect(() => {
    if (!enabled) return;
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled, ...deps]);

  return { data, loading, error, reload, setData };
}

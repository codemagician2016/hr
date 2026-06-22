'use client';

// ESS port of the platform's useApi hook — loading/error/data with stale-fetch
// guarding. Uses lib/api (credentials:'include') so every read is cookie-authed.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';

export function useApi(path, { enabled = true, deps = [], select } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!!enabled);
  const [error, setError] = useState(null);
  const tickRef = useRef(0);

  const reload = useCallback(async () => {
    if (!path || !enabled) {
      setLoading(false);
      return;
    }
    const myTick = ++tickRef.current;
    setLoading(true);
    setError(null);
    try {
      const body = await apiGet(path);
      if (myTick !== tickRef.current) return;
      setData(select ? select(body) : body);
    } catch (e) {
      if (myTick !== tickRef.current) return;
      setError(e);
    } finally {
      if (myTick === tickRef.current) setLoading(false);
    }
  }, [path, enabled, select]);

  useEffect(() => {
    if (!enabled) return;
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, ...deps]);

  return { data, loading, error, reload, setData };
}

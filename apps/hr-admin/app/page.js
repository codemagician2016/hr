'use client';

// Dashboard: headcount tiles derived from the employees endpoint. We pull
// page-1 totals per status (active / on leave / terminated) using the
// paginated /api/hr/employees `total` count so we don't have to load every
// record. Departments count comes from /api/hr/org/departments.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Spinner, ErrorBanner } from '@hr/ui';
import { get } from '@/lib/api';

function Tile({ label, value, href }) {
  const body = (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 hover:shadow-sm transition-shadow">
      <div className="text-3xl font-semibold text-gray-900">{value ?? '—'}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

async function countFor(status) {
  // pageSize:1 — we only need `total` from the paginated envelope.
  const res = await get('/api/hr/employees', { status, page: 1, pageSize: 1 });
  return res?.total ?? (Array.isArray(res?.items) ? res.items.length : 0);
}

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [total, active, onLeave, departments] = await Promise.all([
          countFor(undefined),
          countFor('active'),
          countFor('on_leave'),
          get('/api/hr/org/departments').then((r) => (Array.isArray(r) ? r.length : r?.items?.length ?? r?.total ?? 0)),
        ]);
        if (alive) setStats({ total, active, onLeave, departments });
      } catch (err) {
        if (alive) setError(err.message || 'Failed to load dashboard.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">Dashboard</h1>
      <p className="text-sm text-gray-500 mb-6">Headcount overview</p>

      {loading && <Spinner />}
      {error && <ErrorBanner message={error} />}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Tile label="Total employees" value={stats.total} href="/people" />
          <Tile label="Active" value={stats.active} href="/people?status=active" />
          <Tile label="On leave" value={stats.onLeave} href="/people?status=on_leave" />
          <Tile label="Departments" value={stats.departments} href="/org" />
        </div>
      )}
    </div>
  );
}

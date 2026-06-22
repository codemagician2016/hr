'use client';

// Dashboard: headcount tiles + operational counts. Headcount comes from the
// paginated /api/hr/employees `total` (pageSize:1 — we only need the count).
// We also surface pending leave requests (GET /api/hr/leave/requests?status=
// PENDING) and the most recent pay run (GET /api/hr/payroll/runs). Each
// secondary count is best-effort: a failing/absent endpoint degrades to '—'
// rather than breaking the whole dashboard.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Spinner, ErrorBanner, formatAdminDate } from '@hr/ui';
import { get } from '@/lib/api';

function Tile({ label, value, sub, href }) {
  const body = (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 hover:shadow-sm transition-shadow h-full">
      <div className="text-3xl font-semibold text-gray-900">{value ?? '—'}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-2">{sub}</div>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

async function countFor(status) {
  // pageSize:1 — we only need `total` from the paginated envelope.
  const res = await get('/api/hr/employees', { status, page: 1, pageSize: 1 });
  return res?.total ?? (Array.isArray(res?.items) ? res.items.length : 0);
}

// Count every descendant of a node (excludes the node itself).
function subtreeSize(node) {
  const kids = node?.children || [];
  let n = kids.length;
  for (const k of kids) n += subtreeSize(k);
  return n;
}

// Best-effort: resolve to null on any failure so one missing module doesn't
// blank the whole dashboard.
function safe(promise) {
  return promise.catch(() => null);
}

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [total, active, onLeave, departments, pendingLeave, lastRun, myTeam] = await Promise.all([
          countFor(undefined),
          countFor('active'),
          countFor('on_leave'),
          safe(get('/api/hr/org/departments')).then((r) =>
            r == null ? null : Array.isArray(r) ? r.length : r?.items?.length ?? r?.total ?? 0
          ),
          safe(get('/api/hr/leave/requests', { status: 'PENDING', page: 1, pageSize: 1 })).then((r) =>
            r == null ? null : r?.total ?? (Array.isArray(r?.items) ? r.items.length : 0)
          ),
          safe(get('/api/hr/payroll/runs', { page: 1, pageSize: 1 })).then((r) =>
            r == null ? null : Array.isArray(r?.items) ? r.items[0] : r?.items?.[0] || null
          ),
          // "My team" — the caller's own reporting sub-tree. root=me roots at the
          // operator's Employee; meaningful only when they manage anyone.
          safe(get('/api/hr/org/tree', { root: 'me' })).then((r) => {
            if (r == null) return null;
            const me = Array.isArray(r?.items) ? r.items[0] : null;
            if (!r?.root || !me) return null; // not linked to an Employee → no team widget
            return { headcount: subtreeSize(me), name: me.name };
          }),
        ]);
        if (alive) setStats({ total, active, onLeave, departments, pendingLeave, lastRun, myTeam });
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

  const lastRun = stats?.lastRun;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">Dashboard</h1>
      <p className="text-sm text-gray-500 mb-6">Headcount and operations overview</p>

      {loading && <Spinner />}
      {error && <ErrorBanner message={error} />}

      {stats && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <Tile label="Total employees" value={stats.total} href="/people" />
            <Tile label="Active" value={stats.active} href="/people?status=active" />
            <Tile label="On leave" value={stats.onLeave} href="/people?status=on_leave" />
            <Tile label="Departments" value={stats.departments} href="/org" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Pending leave" value={stats.pendingLeave} href="/leave" />
            <Tile
              label="Last pay run"
              value={lastRun ? lastRun.status : '—'}
              sub={lastRun ? `${formatAdminDate(lastRun.periodStart)} – ${formatAdminDate(lastRun.periodEnd)}` : 'No runs yet'}
              href={lastRun ? `/payroll?run=${lastRun.id}` : '/payroll'}
            />
          </div>

          {stats.myTeam && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">My team</h2>
              {stats.myTeam.headcount > 0 ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <Tile label="People in my team" value={stats.myTeam.headcount} sub="Direct + indirect reports" href="/org/chart" />
                  <Tile label="Pending approvals" value={stats.pendingLeave} sub="Leave awaiting my decision" href="/leave" />
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center">
                  <p className="text-sm font-medium text-gray-900">You don&apos;t manage anyone yet.</p>
                  <p className="text-sm text-gray-500 mt-1">
                    Ask HR to set your team&apos;s reporting lines and your team will appear here.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

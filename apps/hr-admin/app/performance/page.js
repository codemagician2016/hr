'use client';

// Performance & Goals (Feature 8) — HR-Admin + Manager console.
//   Tabs: Cycles · Reviews.
//   - Cycles: list (GET /performance/cycles) + per-cycle completion (GET
//     /cycles/:id/stats, not N+1). Launch (bulk-mint) + Release CTAs are gated on
//     canManagePerformanceCycle via hasPermission — a Manager sees the list
//     read-only (server is the real boundary; their list is TEAM-scoped anyway).
//   - Reviews: the reviewer's queue (GET /performance/reviews?reviewerId=me,
//     SERVER-scoped — never trusts the query). Release gate holds: finalRating is
//     absent from the payload pre-release.
// All data is F1-scoped server-side; a Manager only ever sees their sub-tree.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';

const REVIEW_STATUSES = ['', 'NOT_STARTED', 'SELF_SUBMITTED', 'MANAGER_SUBMITTED', 'CALIBRATED', 'ACKNOWLEDGED', 'CLOSED'];

export default function PerformancePage() {
  const [tab, setTab] = useState('cycles');
  const [perms, setPerms] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [statsById, setStatsById] = useState({});
  const [reviews, setReviews] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const canConfig = hasPermission(perms, 'canManagePerformanceCycle');

  const loadCycles = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const me = await get('/api/auth/me').catch(() => null);
      setPerms(permissionsFromSession(me));
      const data = await get('/api/hr/performance/cycles');
      const items = asList(data);
      setCycles(items);
      // Per-cycle completion stats (one call each — small N, not row-level N+1).
      const stats = {};
      await Promise.all(items.map(async (c) => {
        try { stats[c.id] = await get(`/api/hr/performance/cycles/${c.id}/stats`); } catch { /* ignore */ }
      }));
      setStatsById(stats);
    } catch (e) { setError(e.message || 'Failed to load cycles.'); }
    finally { setLoading(false); }
  }, []);

  const loadReviews = useCallback(async () => {
    setLoading(true); setError('');
    try {
      // reviewerId=me is resolved server-side from the session (not trusted here).
      const data = await get('/api/hr/performance/reviews', { reviewerId: 'me', status: statusFilter });
      setReviews(asList(data));
    } catch (e) { setError(e.message || 'Failed to load reviews.'); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { if (tab === 'cycles') loadCycles(); else loadReviews(); }, [tab, loadCycles, loadReviews]);

  async function act(cycleId, action) {
    setBusyId(cycleId); setError('');
    try {
      await post(`/api/hr/performance/cycles/${cycleId}/${action}`, {});
      await loadCycles();
    } catch (e) { setError(e.message || `Failed to ${action} cycle.`); }
    finally { setBusyId(''); }
  }

  const cycleColumns = [
    { key: 'code', header: 'Code', render: (c) => c.code },
    { key: 'name', header: 'Name', render: (c) => c.name },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge value={c.status} /> },
    { key: 'completion', header: 'Completion', render: (c) => {
      const s = statsById[c.id];
      if (!s) return '—';
      const done = (s.byStatus?.CLOSED || 0) + (s.byStatus?.ACKNOWLEDGED || 0);
      return `${done}/${s.total || 0}${s.releasedAt ? ' · released' : ''}`;
    } },
    { key: 'actions', header: '', render: (c) => canConfig ? (
      <div style={{ display: 'flex', gap: 8 }}>
        <ActionButton label="Launch" tone="neutral" disabled={busyId === c.id} onClick={() => act(c.id, 'launch')} />
        <ActionButton label="Release" tone="positive" disabled={busyId === c.id} onClick={() => act(c.id, 'release')} />
      </div>
    ) : <span style={{ color: '#888' }}>read-only</span> },
  ];

  const reviewColumns = [
    { key: 'employeeId', header: 'Employee', render: (r) => r.employeeId },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
    { key: 'self', header: 'Self', render: (r) => (r.selfRating ?? '—') },
    { key: 'manager', header: 'Manager', render: (r) => (r.managerRating ?? '—') },
    // finalRating is ABSENT pre-release (server omits it) — shown only when present.
    { key: 'final', header: 'Final', render: (r) => (r.finalRating ?? (r.releasedAt ? '—' : 'pending release')) },
  ];

  return (
    <div>
      <PageHeader title="Performance & Goals" subtitle="Review cycles, ratings, and your team's reviews" />
      {error ? <ErrorBanner message={error} /> : null}
      <Tabs
        tabs={[{ key: 'cycles', label: 'Cycles' }, { key: 'reviews', label: 'My Team Reviews' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'cycles' ? (
        <DataTable columns={cycleColumns} rows={cycles} loading={loading} emptyText="No review cycles yet." />
      ) : (
        <div>
          <div style={{ margin: '12px 0' }}>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
            </select>
          </div>
          <DataTable columns={reviewColumns} rows={reviews} loading={loading} emptyText="No reviews assigned to you." />
        </div>
      )}
    </div>
  );
}

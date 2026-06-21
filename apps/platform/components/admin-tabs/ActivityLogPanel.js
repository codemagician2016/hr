'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — real ActivityLogPanel.
// Backend: /api/ecom/activity + /api/ecom/activity/summary (Phase 3d).
// Read-only — every other controller writes here via ecomActivityLogger.

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  KpiCard, KpiGrid,
  PageHeader, EmptyState, ErrorBanner, SecondaryButton,
  fmtNumber, timeAgo as fmtTimeAgo,
} from '@/components/ecom-ui';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const AREAS = ['orders', 'catalogue', 'inventory', 'customers', 'finance', 'auth', 'system', 'marketing'];
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL', 'SECURITY'];

const SEVERITY_TONES = {
  INFO: 'bg-gray-100 text-gray-700 border-gray-200',
  WARNING: 'bg-amber-50 text-amber-700 border-amber-200',
  CRITICAL: 'bg-orange-50 text-orange-700 border-orange-200',
  SECURITY: 'bg-red-50 text-red-700 border-red-200',
};

const OUTCOME_TONES = {
  SUCCESS: 'text-emerald-700',
  DENIED: 'text-amber-700',
  FAILED: 'text-red-700',
};

function timeAgo(iso) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return `${Math.floor(diff / (1000 * 60))}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Group rows by relative-time bucket so the timeline reads top-down with
// clear "Today / Yesterday / This week / Older" section headers — much
// more scannable than a flat list with timestamps.
function bucketize(rows) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo   = new Date(today.getTime() - 7 * 86400000);
  const groups = { Today: [], Yesterday: [], 'This week': [], Older: [] };
  for (const r of rows) {
    const t = new Date(r.createdAt);
    if (t >= today) groups.Today.push(r);
    else if (t >= yesterday) groups.Yesterday.push(r);
    else if (t >= weekAgo) groups['This week'].push(r);
    else groups.Older.push(r);
  }
  return groups;
}

// Severity dot — small visual marker on the left of each row that gives
// the seller scan-ability at a glance (red dots = security issues).
function SeverityDot({ severity }) {
  const cls = ({
    INFO: 'bg-gray-300',
    WARNING: 'bg-amber-500',
    CRITICAL: 'bg-orange-500',
    SECURITY: 'bg-red-500',
  })[severity] || 'bg-gray-300';
  return <span className={`inline-block w-2 h-2 rounded-full mt-1.5 ${cls}`} />;
}

export default function ActivityLogPanel() {
  const { active: activeLocation } = useEcommerceLocation();
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize] = useState(100);
  const [filters, setFilters] = useState({ area: 'all', severity: 'all', search: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filters.area !== 'all') params.set('area', filters.area);
      if (filters.severity !== 'all') params.set('severity', filters.severity);
      if (filters.search.trim()) params.set('search', filters.search.trim());
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const summaryParams = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') summaryParams.set('locationId', activeLocation);

      const [list, sum] = await Promise.all([
        api(`/api/ecom/activity?${params.toString()}`),
        api(`/api/ecom/activity/summary?${summaryParams.toString()}`),
      ]);
      setRows(list.rows || []);
      setTotal(list.total || 0);
      setSummary(sum);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filters.area, filters.severity, filters.search, page, pageSize, activeLocation]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setPage(1); }, [filters.area, filters.severity, filters.search, activeLocation]);

  const groups = useMemo(() => bucketize(rows), [rows]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity log"
        subtitle={summary
          ? `${fmtNumber(summary.eventsToday)} events today · ${fmtNumber(summary.eventsThisWeek)} this week · ${fmtNumber(summary.securityEvents24h)} security events 24h`
          : 'Loading…'}
        actions={<SecondaryButton onClick={reload} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</SecondaryButton>}
      />

      <KpiGrid cols={4}>
        <KpiCard label="Today" value={fmtNumber(summary?.eventsToday)} hint="All actors" />
        <KpiCard label="This week" value={fmtNumber(summary?.eventsThisWeek)} hint="Last 7 days" />
        <KpiCard label="Security · 24h" value={fmtNumber(summary?.securityEvents24h)}
          hint="Login + auth events"
          tone={summary?.securityEvents24h > 0 ? 'warning' : null} />
        <KpiCard label="Top area"
          value={summary?.byArea?.length ? summary.byArea[0].area : '—'}
          hint={summary?.byArea?.length ? `${fmtNumber(summary.byArea[0].count)} events` : 'No data'} />
      </KpiGrid>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-center gap-2">
        <input type="search" value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          placeholder="Search event key, actor, or target…"
          className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        <select value={filters.area}
          onChange={(e) => setFilters((f) => ({ ...f, area: e.target.value }))}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm">
          <option value="all">All areas</option>
          {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={filters.severity}
          onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm">
          <option value="all">All severities</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {loading && rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No events match the filters" message="Activity events fire on every mutation across the admin. Loosen the filters or try a different search to see more." />
        ) : (
          <div>
            {Object.keys(groups).map((bucket) => (
              groups[bucket].length > 0 && (
                <div key={bucket}>
                  <div className="px-5 py-2 bg-gray-50 border-b border-t border-gray-100 first:border-t-0">
                    <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-gray-500">
                      {bucket} · {groups[bucket].length} event{groups[bucket].length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <ul className="divide-y divide-gray-100">
                    {groups[bucket].map((e) => (
                      <li key={e.id} className="px-5 py-3 hover:bg-gray-50/60">
                        <div className="flex items-start gap-3">
                          <SeverityDot severity={e.severity} />
                          <div className="text-[10px] font-mono text-gray-400 pt-0.5 w-20 shrink-0">
                            {timeAgo(e.createdAt)}
                          </div>
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider border shrink-0 ${SEVERITY_TONES[e.severity] || SEVERITY_TONES.INFO}`}>
                            {e.severity}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-gray-900 font-mono">{e.eventKey}</span>
                              <span className={`text-[10px] font-mono ${OUTCOME_TONES[e.outcome] || ''}`}>{e.outcome}</span>
                              {e.actorName && <span className="text-xs text-gray-700">by {e.actorName}</span>}
                              {e.actorRole && <span className="text-[10px] font-mono text-gray-500">{e.actorRole}</span>}
                            </div>
                            {e.targetCode && (
                              <p className="text-xs text-gray-600 mt-0.5">
                                <span className="text-gray-400">{e.targetType}:</span> {e.targetCode}
                              </p>
                            )}
                            {e.message && <p className="text-xs text-gray-700 mt-0.5">{e.message}</p>}
                            {e.ipAddress && (
                              <p className="text-[10px] font-mono text-gray-400 mt-0.5">IP {e.ipAddress}</p>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            ))}
          </div>
        )}

        {total > pageSize && (
          <div className="p-4 border-t border-gray-100 flex items-center justify-between">
            <p className="text-xs text-gray-500">
              Page {page} of {Math.max(1, Math.ceil(total / pageSize))} · {total} events
            </p>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700 disabled:opacity-50">← Prev</button>
              <button type="button" disabled={page >= Math.ceil(total / pageSize) || loading} onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700 disabled:opacity-50">Next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

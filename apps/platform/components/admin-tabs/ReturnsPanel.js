'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — real ReturnsPanel.
// Backend: /api/ecom/returns + /api/ecom/returns/summary (Phase 3d).

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
    err.allowed = body.allowed;
    throw err;
  }
  return body;
}

const STATUSES = [
  { key: 'REQUESTED', label: 'Requested', tone: 'pending' },
  { key: 'APPROVED',  label: 'Approved',  tone: 'info' },
  { key: 'COLLECTED', label: 'Collected', tone: 'info' },
  { key: 'REFUNDED',  label: 'Refunded',  tone: 'success' },
  { key: 'CLOSED',    label: 'Closed',    tone: 'neutral' },
  { key: 'REJECTED',  label: 'Rejected',  tone: 'danger' },
];
const STATUS_KEYS = new Set(STATUSES.map((status) => status.key));

const REASON_LABELS = {
  DAMAGED: 'Damaged',
  WRONG_ITEM: 'Wrong item',
  EXPIRED: 'Expired',
  CHANGED_MIND: 'Changed mind',
  POOR_QUALITY: 'Poor quality',
  NOT_AS_DESCRIBED: 'Not as described',
  ARRIVED_LATE: 'Arrived late',
  OTHER: 'Other',
};

const TONE_CLASSES = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  danger: 'bg-red-50 text-red-700 border-red-200',
  neutral: 'bg-gray-50 text-gray-700 border-gray-200',
};

function StatusBadge({ status }) {
  const meta = STATUSES.find((s) => s.key === status) || STATUSES[0];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono tracking-wider border ${TONE_CLASSES[meta.tone]}`}>
      {meta.label.toUpperCase()}
    </span>
  );
}

function formatMoney(minor) {
  if (!minor) return '£0';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: 'GBP', maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `£${(minor / 100).toFixed(2)}`;
  }
}

function ReturnDetailDrawer({ ret, activeLocation, onClose, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!ret) return null;

  async function transition(toStatus) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/returns/${ret.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({
          toStatus,
          ...(activeLocation && activeLocation !== 'ALL' ? { locationId: activeLocation } : {}),
        }),
      });
      onRefresh?.();
      onClose?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Allowed transitions table — mirror server-side TRANSITIONS map
  const allowed = {
    REQUESTED: [['APPROVED', 'Approve'], ['REJECTED', 'Reject']],
    APPROVED: [['COLLECTED', 'Mark collected'], ['REJECTED', 'Reject']],
    COLLECTED: [['REFUNDED', 'Mark refunded']],
    REFUNDED: [['CLOSED', 'Close']],
  };
  const transitions = allowed[ret.status] || [];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-end" onClick={onClose}>
      <div className="bg-white border-l border-gray-200 w-full max-w-xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-start justify-between">
          <div>
            <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Return</p>
            <h3 className="text-lg font-bold text-gray-900">{ret.code}</h3>
            <div className="mt-1"><StatusBadge status={ret.status} /></div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <p className="text-xs font-mono tracking-[0.18em] uppercase text-gray-500 mb-1">Customer</p>
            <p className="text-sm font-semibold text-gray-900">{ret.customerName}</p>
            <p className="text-xs text-gray-500">{ret.customerEmail}</p>
          </div>
          {ret.orderCode && (
            <div>
              <p className="text-xs font-mono tracking-[0.18em] uppercase text-gray-500 mb-1">Order</p>
              <p className="text-sm font-mono text-gray-900">{ret.orderCode}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-mono tracking-[0.18em] uppercase text-gray-500 mb-1">Reason</p>
            <p className="text-sm text-gray-900">{REASON_LABELS[ret.reasonCategory] || ret.reasonCategory}</p>
            {ret.reasonNote && <p className="text-xs text-gray-600 mt-1 italic">"{ret.reasonNote}"</p>}
          </div>
          <div>
            <p className="text-xs font-mono tracking-[0.18em] uppercase text-gray-500 mb-2">Items ({ret.items?.length || 0})</p>
            <div className="space-y-2">
              {(ret.items || []).map((item) => (
                <div key={item.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{item.productName}</p>
                      <p className="text-xs text-gray-500">Qty {item.quantity} · {formatMoney(item.unitPriceMinor)} each</p>
                      {item.note && <p className="text-xs text-gray-600 mt-1 italic">"{item.note}"</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-gray-900 font-mono">{formatMoney(item.refundAmountMinor)}</p>
                      <p className="text-[10px] font-mono text-gray-500">{item.disposition}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-sm font-semibold text-gray-900 text-right mt-2">
              Total refund: {formatMoney(ret.totalRefundMinor)}
            </p>
          </div>
          {ret.events && ret.events.length > 0 && (
            <div>
              <p className="text-xs font-mono tracking-[0.18em] uppercase text-gray-500 mb-2">Timeline</p>
              <div className="space-y-2">
                {ret.events.slice(0, 10).map((e) => (
                  <div key={e.id} className="text-xs flex gap-2">
                    <span className="text-gray-500 font-mono shrink-0">{new Date(e.createdAt).toLocaleString('en-GB')}</span>
                    <span className="text-gray-900">
                      {e.fromStatus ? `${e.fromStatus} → ${e.toStatus}` : e.toStatus || e.kind}
                      {e.message ? ` — ${e.message}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
        </div>
        {transitions.length > 0 && (
          <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex flex-wrap gap-2 justify-end">
            {transitions.map(([toStatus, label]) => (
              <button
                key={toStatus}
                type="button"
                onClick={() => transition(toStatus)}
                disabled={busy}
                className={`px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50 ${
                  toStatus === 'REJECTED'
                    ? 'border border-red-300 text-red-700 hover:bg-red-50'
                    : 'bg-indigo-600 text-white hover:bg-indigo-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReturnsPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { active: activeLocation } = useEcommerceLocation();
  const urlStatus = searchParams.get('status') || 'all';
  const urlSearch = searchParams.get('q') || '';
  const urlId = searchParams.get('id') || '';
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilterValue] = useState(STATUS_KEYS.has(urlStatus) ? urlStatus : 'all');
  const [search, setSearchValue] = useState(urlSearch);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenIdValue] = useState(urlId || null);
  const [openDetail, setOpenDetail] = useState(null);

  const replaceReturnsQuery = useCallback((mutate) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(params.toString() ? `?${params.toString()}` : window.location.pathname, { scroll: false });
  }, [router, searchParams]);

  const setStatusFilter = useCallback((status) => {
    const nextStatus = STATUS_KEYS.has(status) ? status : 'all';
    setStatusFilterValue(nextStatus);
    replaceReturnsQuery((params) => {
      if (nextStatus === 'all') params.delete('status');
      else params.set('status', nextStatus);
    });
  }, [replaceReturnsQuery]);

  const setSearch = useCallback((value) => {
    setSearchValue(value);
    replaceReturnsQuery((params) => {
      const trimmed = value.trim();
      if (trimmed) params.set('q', trimmed);
      else params.delete('q');
    });
  }, [replaceReturnsQuery]);

  const setOpenId = useCallback((id) => {
    setOpenIdValue(id || null);
    replaceReturnsQuery((params) => {
      if (id) params.set('id', id);
      else params.delete('id');
    });
  }, [replaceReturnsQuery]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (search.trim()) params.set('search', search.trim());
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      params.set('pageSize', '100');
      const summaryParams = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') summaryParams.set('locationId', activeLocation);
      const [list, sum] = await Promise.all([
        api(`/api/ecom/returns?${params.toString()}`),
        api(`/api/ecom/returns/summary?${summaryParams.toString()}`),
      ]);
      setRows(list.rows || []);
      setSummary(sum);
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search, activeLocation]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    setStatusFilterValue(STATUS_KEYS.has(urlStatus) ? urlStatus : 'all');
    setSearchValue(urlSearch);
    setOpenIdValue(urlId || null);
  }, [urlId, urlSearch, urlStatus]);

  useEffect(() => {
    if (!openId) { setOpenDetail(null); return; }
    let cancelled = false;
    const params = new URLSearchParams();
    if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
    api(`/api/ecom/returns/${openId}?${params.toString()}`).then((d) => { if (!cancelled) setOpenDetail(d); });
    return () => { cancelled = true; };
  }, [openId, activeLocation]);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Returns</h2>
          <p className="text-sm text-gray-500 mt-1">
            {summary
              ? `${summary.open} open · ${summary.refunded30dCount} refunded last 30d (${formatMoney(summary.refunded30dAmountMinor)})`
              : 'Loading…'}
          </p>
        </div>
        <button type="button" onClick={reload} disabled={loading}
          className="px-3 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:border-gray-400 disabled:opacity-50">
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Open" value={summary?.open} hint="Awaiting decision" />
        <KpiCard label="Refunded 30d" value={summary?.refunded30dCount} hint="Last 30 days" />
        <KpiCard label="Refund total 30d" value={summary ? formatMoney(summary.refunded30dAmountMinor) : null} hint="Last 30 days" />
        <KpiCard
          label="Top reason 30d"
          value={summary?.byReason?.length ? REASON_LABELS[summary.byReason[0].reason] || summary.byReason[0].reason : null}
          hint={summary?.byReason?.length ? `${summary.byReason[0].count} requests` : 'No data'}
        />
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-center gap-2">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, customer, or order…"
          className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {error && <div className="p-4 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading && rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-semibold text-gray-900">No returns yet</p>
            <p className="text-xs text-gray-500 mt-1">Customer return requests will appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-[10px] font-mono tracking-[0.18em] uppercase text-gray-500">
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3 text-right">Items</th>
                  <th className="px-4 py-3 text-right">Refund</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => setOpenId(r.id)}
                    className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer">
                    <td className="px-4 py-3 font-mono font-semibold text-indigo-700">{r.code}</td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-900">{r.customerName}</p>
                      <p className="text-xs text-gray-500">{r.customerEmail}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{REASON_LABELS[r.reasonCategory] || r.reasonCategory}</td>
                    <td className="px-4 py-3 text-right font-mono text-gray-900">{r.items?.length || 0}</td>
                    <td className="px-4 py-3 text-right font-mono text-gray-900">{formatMoney(r.totalRefundMinor)}</td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3 text-xs text-gray-500">{new Date(r.createdAt).toLocaleDateString('en-GB')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openDetail && (
        <ReturnDetailDrawer
          ret={openDetail}
          activeLocation={activeLocation}
          onClose={() => setOpenId(null)}
          onRefresh={reload}
        />
      )}
    </div>
  );
}

function KpiCard({ label, value, hint }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-[11px] font-mono tracking-[0.18em] uppercase text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-gray-900">{value === null || value === undefined ? '—' : value}</p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

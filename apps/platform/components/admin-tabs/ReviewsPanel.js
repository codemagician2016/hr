'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — real ReviewsPanel.
// Backend: /api/ecom/reviews + /api/ecom/reviews/summary (Phase 3d).

import { useState, useEffect, useCallback } from 'react';
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

const STATUSES = ['PENDING', 'PUBLISHED', 'HIDDEN', 'REJECTED'];
const TONE_CLASSES = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  PUBLISHED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  HIDDEN: 'bg-gray-50 text-gray-700 border-gray-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
};

function Stars({ rating }) {
  const r = Math.max(0, Math.min(5, rating));
  return (
    <span className="inline-flex items-center text-amber-500">
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className={i < r ? 'text-amber-500' : 'text-gray-300'}>★</span>
      ))}
      <span className="ml-1 text-xs text-gray-600">({r})</span>
    </span>
  );
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono tracking-wider border ${TONE_CLASSES[status] || TONE_CLASSES.PENDING}`}>
      {status}
    </span>
  );
}

function ReplyForm({ review, activeLocation, onSaved, onCancel }) {
  const [reply, setReply] = useState(review.merchantReply || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!reply.trim()) { setError('Reply cannot be empty'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/ecom/reviews/${review.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          reply: reply.trim(),
          ...(activeLocation && activeLocation !== 'ALL' ? { locationId: activeLocation } : {}),
        }),
      });
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea value={reply} onChange={(e) => setReply(e.target.value)}
        rows={3} maxLength={5000}
        placeholder="Public reply visible on the product page…"
        className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700">Cancel</button>
        <button type="submit" disabled={busy}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? 'Saving…' : 'Post reply'}
        </button>
      </div>
    </form>
  );
}

export default function ReviewsPanel() {
  const { active: activeLocation } = useEcommerceLocation();
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('PENDING');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (search.trim()) params.set('search', search.trim());
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      params.set('pageSize', '50');
      const summaryParams = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') summaryParams.set('locationId', activeLocation);
      const [list, sum] = await Promise.all([
        api(`/api/ecom/reviews?${params.toString()}`),
        api(`/api/ecom/reviews/summary?${summaryParams.toString()}`),
      ]);
      setRows(list.rows || []);
      setSummary(sum);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search, activeLocation]);

  useEffect(() => { reload(); }, [reload]);

  async function moderate(id, status, flagReason) {
    try {
      await api(`/api/ecom/reviews/${id}/moderate`, {
        method: 'PUT',
        body: JSON.stringify({
          status,
          flagReason: flagReason || undefined,
          ...(activeLocation && activeLocation !== 'ALL' ? { locationId: activeLocation } : {}),
        }),
      });
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  // Clear the whole moderation backlog in one click — fetch every PENDING review
  // (location-scoped to match what the owner is looking at) and publish each.
  async function publishAllPending() {
    if (!window.confirm('Publish every pending review? They go live on your storefront immediately — you can still hide any individual one afterwards.')) return;
    setBulkBusy(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('status', 'PENDING');
      params.set('pageSize', '100');
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      const pending = await api(`/api/ecom/reviews?${params.toString()}`);
      for (const r of pending.rows || []) {
        await api(`/api/ecom/reviews/${r.id}/moderate`, {
          method: 'PUT',
          body: JSON.stringify({
            status: 'PUBLISHED',
            ...(activeLocation && activeLocation !== 'ALL' ? { locationId: activeLocation } : {}),
          }),
        });
      }
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-xl font-semibold text-gray-900">Reviews</h2>
        <p className="text-sm text-gray-500 mt-1">
          {summary
            ? `${summary.pending} pending · avg ${summary.avgRatingAllTime?.toFixed?.(2) || '—'} from ${summary.publishedTotal} published`
            : 'Loading…'}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Pending" value={summary?.pending} hint="Awaiting moderation" tone={summary?.pending > 0 ? 'warning' : null} />
        <KpiCard label="Avg rating (all time)" value={summary?.avgRatingAllTime?.toFixed?.(2)} hint={`from ${summary?.publishedTotal || 0} published`} />
        <KpiCard label="Avg rating 30d" value={summary?.avgRating30d?.toFixed?.(2)} hint="Recent sentiment" />
        <KpiCard label="Verified buyer 30d" value={summary?.verifiedBuyerPercent != null ? `${Math.round(summary.verifiedBuyerPercent)}%` : null} hint="Linked to a paid order" />
      </div>

      {summary?.pending > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-900">
              {summary.pending} review{summary.pending === 1 ? '' : 's'} waiting for you
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              Pending reviews stay hidden from shoppers until you publish them. Verified-buyer reviews go live automatically.
            </p>
          </div>
          <button type="button" onClick={publishAllPending} disabled={bulkBusy}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap">
            {bulkBusy ? 'Publishing…' : 'Publish all pending'}
          </button>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-center gap-2">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reviewer, title, or body…"
          className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          <button type="button" onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md ${statusFilter === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>All</button>
          {STATUSES.map((s) => (
            <button key={s} type="button" onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md ${statusFilter === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{s}</button>
          ))}
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">{error}</div>}

      <div className="space-y-3">
        {loading && rows.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
            <p className="text-sm font-semibold text-gray-900">No reviews matching filters</p>
          </div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="bg-white rounded-2xl border border-gray-200 p-5">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Stars rating={r.rating} />
                    <span className="text-sm font-semibold text-gray-900">{r.customerName}</span>
                    {r.verifiedBuyer && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded">VERIFIED</span>}
                    <StatusBadge status={r.status} />
                  </div>
                  {r.title && <p className="text-sm font-semibold text-gray-900 mt-2">{r.title}</p>}
                  {r.body && <p className="text-sm text-gray-700 mt-1">{r.body}</p>}
                  <p className="text-xs text-gray-500 mt-2">{new Date(r.createdAt).toLocaleDateString('en-GB')}</p>
                </div>
              </div>
              {r.merchantReply && replyingTo !== r.id && (
                <div className="mt-3 ml-4 pl-3 border-l-2 border-indigo-200">
                  <p className="text-[10px] font-mono tracking-[0.18em] uppercase text-indigo-700">Merchant reply</p>
                  <p className="text-sm text-gray-700 mt-1">{r.merchantReply}</p>
                </div>
              )}
              {replyingTo === r.id && (
                <div className="mt-3 ml-4 pl-3 border-l-2 border-indigo-200">
                  <ReplyForm
                    review={r}
                    activeLocation={activeLocation}
                    onCancel={() => setReplyingTo(null)}
                    onSaved={() => { setReplyingTo(null); reload(); }}
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                {r.status === 'PENDING' && (
                  <>
                    <button type="button" onClick={() => moderate(r.id, 'PUBLISHED')}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">Publish</button>
                    <button type="button" onClick={() => moderate(r.id, 'REJECTED', window.prompt('Reason for rejection:') || undefined)}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-300 text-red-700 hover:bg-red-50">Reject</button>
                    <button type="button" onClick={() => moderate(r.id, 'HIDDEN')}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">Hide</button>
                  </>
                )}
                {r.status === 'PUBLISHED' && (
                  <button type="button" onClick={() => moderate(r.id, 'HIDDEN')}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">Hide</button>
                )}
                {r.status === 'HIDDEN' && (
                  <button type="button" onClick={() => moderate(r.id, 'PUBLISHED')}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">Publish</button>
                )}
                {replyingTo !== r.id && (
                  <button type="button" onClick={() => setReplyingTo(r.id)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
                    {r.merchantReply ? 'Edit reply' : 'Reply'}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function KpiCard({ label, value, hint, tone }) {
  const cls = tone === 'warning' ? 'text-amber-700' : 'text-gray-900';
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-[11px] font-mono tracking-[0.18em] uppercase text-gray-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${cls}`}>{value === null || value === undefined ? '—' : value}</p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

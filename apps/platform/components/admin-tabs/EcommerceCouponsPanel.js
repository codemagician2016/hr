'use client';

// ECOMMERCE Path B Phase 6b (2026-05-01) — EcommerceCouponsPanel
// Polish pass 2026-05-08: ecom-ui primitives + colored badges by discount
// type + usage progress + expiry warnings + click-to-edit rows.
//
// Backend: /api/ecom/coupons (Phase 6a) + /api/ecom/coupons/summary.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  KpiCard, KpiGrid,
  StatusBadge, toneForStatus,
  PageHeader, EmptyState, ErrorBanner, PrimaryButton, SecondaryButton,
  fmtNumber,
} from '@/components/ecom-ui';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${res.status}`);
  return body;
}

const DISCOUNT_TYPES = [
  { key: 'PERCENTAGE', label: 'Percent off' },
  { key: 'FIXED',      label: 'Fixed amount off' },
];
const COUPON_FILTERS = new Set(['all', 'true', 'false']);

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500';
function L({ children }) {
  return <label className="block text-xs font-medium text-gray-700 mb-1">{children}</label>;
}

// ---------------------------------------------------------------------------
// Discount badge — colored differently per discount type so the seller can
// scan the list and instantly see "this is a 20% off code" vs "₹100 off".
// ---------------------------------------------------------------------------
function DiscountBadge({ type, value }) {
  const isPct = type === 'PERCENTAGE';
  const cls = isPct
    ? 'bg-purple-50 text-purple-700 border-purple-200'
    : 'bg-emerald-50 text-emerald-700 border-emerald-200';
  return (
    <span className={`inline-flex items-baseline gap-1 px-2.5 py-1 rounded-lg text-sm font-bold border ${cls}`}>
      {isPct
        ? <><span>{value}</span><span className="text-xs">% OFF</span></>
        : <><span className="text-xs">₹</span><span>{value}</span><span className="text-xs">OFF</span></>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Usage progress — small bar showing usedCount / maxUses (if cap set).
// ---------------------------------------------------------------------------
function UsageBar({ used, max }) {
  if (!max) {
    return <span className="text-xs text-gray-500 font-mono">{fmtNumber(used)} <span className="text-gray-400">used</span></span>;
  }
  const pct = Math.min(100, Math.round((used / max) * 100));
  const tone = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="w-28">
      <div className="flex items-center justify-between text-[11px] mb-0.5">
        <span className="font-mono text-gray-700">{fmtNumber(used)} / {fmtNumber(max)}</span>
        <span className="font-semibold text-gray-500">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Status derivation — combines isActive + valid window into a single label
// so the seller doesn't have to mentally diff "is it active AND within
// window AND not at the cap?".
function deriveStatus(c) {
  if (!c.isActive) return 'inactive';
  const now = Date.now();
  const from  = c.validFrom  ? new Date(c.validFrom).getTime()  : null;
  const until = c.validUntil ? new Date(c.validUntil).getTime() : null;
  if (from && from > now) return 'scheduled';
  if (until && until < now) return 'expired';
  if (c.maxUses && c.usedCount >= c.maxUses) return 'fully_used';
  // Expiring within the next 7 days
  if (until && (until - now) < 7 * 24 * 60 * 60 * 1000) return 'expiring_soon';
  return 'active';
}
function statusLabel(s) {
  return ({
    active: 'active', inactive: 'inactive', scheduled: 'scheduled',
    expired: 'expired', expiring_soon: 'expiring soon', fully_used: 'fully used',
  })[s] || s;
}
function statusTone(s) {
  if (s === 'active') return 'success';
  if (s === 'expiring_soon') return 'warning';
  if (s === 'expired' || s === 'fully_used') return 'danger';
  if (s === 'scheduled') return 'neutral';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Coupon editor form
// ---------------------------------------------------------------------------
function CouponForm({ initial, onSave, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => ({
    code: initial?.code || '',
    description: initial?.description || '',
    discountType: initial?.discountType || 'PERCENTAGE',
    discountValue: initial?.discountValue ?? 10,
    minOrderAmount: initial?.minOrderAmount ?? '',
    maxDiscount: initial?.maxDiscount ?? '',
    maxUses: initial?.maxUses ?? '',
    maxUsesPerCustomer: initial?.maxUsesPerCustomer ?? '',
    validFrom: initial?.validFrom ? initial.validFrom.slice(0, 10) : '',
    validUntil: initial?.validUntil ? initial.validUntil.slice(0, 10) : '',
    isActive: initial?.isActive ?? true,
  }));
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const payload = {
        code: form.code.trim().toUpperCase(),
        discountType: form.discountType,
        discountValue: Number(form.discountValue),
        isActive: form.isActive,
      };
      if (form.description.trim()) payload.description = form.description.trim();
      ['minOrderAmount', 'maxDiscount', 'maxUses', 'maxUsesPerCustomer'].forEach((k) => {
        if (form[k] !== '') payload[k] = Number(form[k]);
      });
      if (form.validFrom) payload.validFrom = new Date(form.validFrom).toISOString();
      if (form.validUntil) payload.validUntil = new Date(form.validUntil).toISOString();

      if (initial?.id) await api(`/api/ecom/coupons/${initial.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else             await api('/api/ecom/coupons', { method: 'POST', body: JSON.stringify(payload) });
      onSave?.();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  // Live preview of the badge so the seller sees the customer's view of
  // the discount as they type.
  const previewValue = Number(form.discountValue) || 0;

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="bg-gradient-to-br from-purple-50 to-indigo-50 border border-purple-200 rounded-2xl p-4 flex items-center gap-3">
        <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-purple-700">Customer sees</div>
        <DiscountBadge type={form.discountType} value={previewValue} />
        <span className="text-xs text-gray-600">on code <code className="font-mono font-bold uppercase text-gray-900">{form.code || 'YOURCODE'}</code></span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <L>Code *</L>
          <input type="text" value={form.code} onChange={set('code')} required maxLength={40}
            placeholder="WELCOME20"
            className={`${INPUT_CLS} font-mono uppercase`} />
        </div>
        <div>
          <L>Discount type *</L>
          <select value={form.discountType} onChange={set('discountType')} className={INPUT_CLS}>
            {DISCOUNT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <L>Value * {form.discountType === 'PERCENTAGE' ? '(%)' : '(major units)'}</L>
          <input type="number" step="0.01" value={form.discountValue} onChange={set('discountValue')} required min="0"
            className={`${INPUT_CLS} font-mono`} />
        </div>
        <div>
          <L>Min order amount</L>
          <input type="number" step="0.01" value={form.minOrderAmount} onChange={set('minOrderAmount')} min="0"
            placeholder="No minimum"
            className={`${INPUT_CLS} font-mono`} />
        </div>
        {form.discountType === 'PERCENTAGE' && (
          <div>
            <L>Max discount cap</L>
            <input type="number" step="0.01" value={form.maxDiscount} onChange={set('maxDiscount')} min="0"
              placeholder="No cap"
              className={`${INPUT_CLS} font-mono`} />
          </div>
        )}
        <div>
          <L>Max total uses</L>
          <input type="number" value={form.maxUses} onChange={set('maxUses')} min="1" placeholder="∞"
            className={`${INPUT_CLS} font-mono`} />
        </div>
        <div>
          <L>Per customer cap</L>
          <input type="number" value={form.maxUsesPerCustomer} onChange={set('maxUsesPerCustomer')} min="1" placeholder="∞"
            className={`${INPUT_CLS} font-mono`} />
        </div>
        <div>
          <L>Valid from</L>
          <input type="date" value={form.validFrom} onChange={set('validFrom')} className={INPUT_CLS} />
        </div>
        <div>
          <L>Valid until</L>
          <input type="date" value={form.validUntil} onChange={set('validUntil')} className={INPUT_CLS} />
        </div>
        <div className="sm:col-span-2">
          <L>Description</L>
          <input type="text" value={form.description} onChange={set('description')} maxLength={500}
            placeholder="Internal note — what's this code for?"
            className={INPUT_CLS} />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={form.isActive} onChange={set('isActive')} className="rounded" /> Active
      </label>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
        <SecondaryButton type="button" onClick={onCancel} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" disabled={busy}>{busy ? 'Saving…' : initial?.id ? 'Save coupon' : 'Create coupon'}</PrimaryButton>
      </div>
    </form>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-2 sm:p-6 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-2xl max-w-2xl w-full max-h-[calc(100vh-2rem)] overflow-y-auto my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-100 sticky top-0 bg-white">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none -mt-1">×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
export default function EcommerceCouponsPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlSearch = searchParams.get('q') || '';
  const urlFilter = searchParams.get('status') || 'all';
  const urlView = searchParams.get('view') || '';
  const urlId = searchParams.get('id') || '';
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [search, setSearchValue] = useState(urlSearch);
  const [activeFilter, setActiveFilterValue] = useState(COUPON_FILTERS.has(urlFilter) ? urlFilter : 'all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const replaceCouponQuery = useCallback((mutate) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(params.toString() ? `?${params.toString()}` : window.location.pathname, { scroll: false });
  }, [router, searchParams]);

  const setSearch = useCallback((value) => {
    setSearchValue(value);
    replaceCouponQuery((params) => {
      const trimmed = value.trim();
      if (trimmed) params.set('q', trimmed);
      else params.delete('q');
    });
  }, [replaceCouponQuery]);

  const setActiveFilter = useCallback((value) => {
    const nextValue = COUPON_FILTERS.has(value) ? value : 'all';
    setActiveFilterValue(nextValue);
    replaceCouponQuery((params) => {
      if (nextValue === 'all') params.delete('status');
      else params.set('status', nextValue);
    });
  }, [replaceCouponQuery]);

  const openEditor = useCallback((coupon = {}) => {
    setEditing(coupon);
    replaceCouponQuery((params) => {
      params.set('view', coupon.id ? 'ecom-coupon-edit' : 'ecom-coupon-create');
      if (coupon.id) params.set('id', coupon.id);
      else params.delete('id');
    });
  }, [replaceCouponQuery]);

  const closeEditor = useCallback(() => {
    setEditing(null);
    replaceCouponQuery((params) => {
      params.delete('view');
      params.delete('id');
    });
  }, [replaceCouponQuery]);

  useEffect(() => {
    setSearchValue(urlSearch);
    setActiveFilterValue(COUPON_FILTERS.has(urlFilter) ? urlFilter : 'all');
  }, [urlFilter, urlSearch]);

  useEffect(() => {
    if (urlView === 'ecom-coupon-create') {
      setEditing({});
      return;
    }
    if (urlView === 'ecom-coupon-edit' && urlId) {
      const row = rows.find((coupon) => coupon.id === urlId);
      if (row) setEditing(row);
      return;
    }
    setEditing(null);
  }, [rows, urlId, urlView]);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (activeFilter !== 'all') params.set('isActive', activeFilter);
      params.set('pageSize', '100');
      const [list, sum] = await Promise.all([
        api(`/api/ecom/coupons?${params.toString()}`),
        api('/api/ecom/coupons/summary'),
      ]);
      setRows(list.rows || []);
      setSummary(sum);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [search, activeFilter]);

  useEffect(() => { reload(); }, [reload]);

  async function deactivate(id) {
    if (!window.confirm('Deactivate this coupon?')) return;
    try { await api(`/api/ecom/coupons/${id}`, { method: 'DELETE' }); reload(); }
    catch (err) { setError(err.message); }
  }

  // Highlight expiring-soon rows in the strip — surfaces the seller's
  // most time-sensitive action without them having to scan the table.
  const expiringSoon = useMemo(
    () => rows.filter((c) => deriveStatus(c) === 'expiring_soon').length,
    [rows],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coupons"
        subtitle={summary
          ? `${summary.activeCount} active · ${summary.redemptions30d} redemptions in last 30 days`
          : 'Loading…'}
        actions={<PrimaryButton onClick={() => openEditor({})}>+ New coupon</PrimaryButton>}
      />

      <KpiGrid cols={4}>
        <KpiCard label="Active" value={fmtNumber(summary?.activeCount)} tone="success"
          hint={expiringSoon > 0 ? `⚠ ${expiringSoon} expiring soon` : null} />
        <KpiCard label="All-time created" value={fmtNumber(summary?.totalCount)} hint="incl. inactive" />
        <KpiCard label="Redemptions · 30d" value={fmtNumber(summary?.redemptions30d)} />
        <KpiCard label="Discount given · 30d"
          value={summary?.discountGiven30d != null ? `₹${fmtNumber(Math.round(summary.discountGiven30d))}` : '—'}
          hint="Major units" />
      </KpiGrid>

      <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 flex flex-wrap gap-3 items-center">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code or description…"
          className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {[
            { key: 'all',   label: 'All' },
            { key: 'true',  label: 'Active' },
            { key: 'false', label: 'Inactive' },
          ].map((f) => (
            <button key={f.key} type="button" onClick={() => setActiveFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                activeFilter === f.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {loading && rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No coupons yet"
          message="Discount codes are the fastest way to win first-time orders. Try a 20% off welcome code with a 7-day expiry."
          action={<PrimaryButton onClick={() => openEditor({})}>+ Create your first coupon</PrimaryButton>}
        />
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-[10px] font-mono tracking-[0.18em] uppercase text-gray-500">
                  <th className="px-5 py-3">Code</th>
                  <th className="px-5 py-3">Discount</th>
                  <th className="px-5 py-3">Usage</th>
                  <th className="px-5 py-3">Validity</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 w-1"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const status = deriveStatus(c);
                  return (
                    <tr key={c.id} onClick={() => openEditor(c)}
                      className="border-b border-gray-100 hover:bg-indigo-50/30 cursor-pointer transition-colors">
                      <td className="px-5 py-4">
                        <p className="font-mono font-bold text-gray-900 text-base">{c.code}</p>
                        {c.description && <p className="text-xs text-gray-500 mt-0.5 truncate max-w-md">{c.description}</p>}
                      </td>
                      <td className="px-5 py-4">
                        <DiscountBadge type={c.discountType} value={c.discountValue} />
                        {c.minOrderAmount ? <p className="text-[10px] text-gray-500 mt-1">min ₹{c.minOrderAmount}</p> : null}
                      </td>
                      <td className="px-5 py-4">
                        <UsageBar used={c.usedCount} max={c.maxUses} />
                      </td>
                      <td className="px-5 py-4 text-xs text-gray-600">
                        <p>{c.validFrom ? new Date(c.validFrom).toLocaleDateString('en-GB') : 'Always'}</p>
                        <p>→ {c.validUntil ? new Date(c.validUntil).toLocaleDateString('en-GB') : 'Forever'}</p>
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge tone={statusTone(status)}>{statusLabel(status)}</StatusBadge>
                      </td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex justify-end gap-3" onClick={(e) => e.stopPropagation()}>
                          <button type="button" onClick={() => openEditor(c)}
                            className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 hover:underline">Edit</button>
                          {c.isActive && (
                            <button type="button" onClick={() => deactivate(c.id)}
                              className="text-xs font-semibold text-gray-500 hover:text-red-700 hover:underline">Deactivate</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? 'Edit coupon' : 'New coupon'} onClose={closeEditor}>
          <CouponForm initial={editing.id ? editing : null}
            onCancel={closeEditor}
            onSave={() => { closeEditor(); reload(); }} />
        </Modal>
      )}
    </div>
  );
}

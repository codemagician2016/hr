'use client';

// ECOMMERCE Path B Phase 6b (2026-05-01) — real EcommerceReportsPanel.
// Backend: /api/ecom/reports/* (Phase 6a).

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import { useTenant } from '@/components/TenantProvider';
import { formatCurrencyMinor, getDefaultCurrency } from '@/lib/currency';

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

function fmt(minor, currency) {
  return formatCurrencyMinor(minor, currency);
}

function Sparkline({ rows, accessor }) {
  if (!rows || rows.length === 0) return null;
  const values = rows.map(accessor);
  const max = Math.max(...values, 1);
  const w = 600;
  const h = 80;
  const step = w / Math.max(1, rows.length - 1);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(h - (v / max) * h).toFixed(2)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-20" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="rgb(99 102 241)" strokeWidth="2" />
      <path d={`${path} L${w},${h} L0,${h} Z`} fill="rgba(99,102,241,0.1)" />
    </svg>
  );
}

export default function EcommerceReportsPanel() {
  const { tenant } = useTenant();
  const businessCurrency = getDefaultCurrency({ business: tenant?.business });
  const { active: activeLocation } = useEcommerceLocation();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState(null);
  const [byDay, setByDay] = useState([]);
  const [topProducts, setTopProducts] = useState([]);
  const [byStatus, setByStatus] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      const [s, d, t, st] = await Promise.all([
        api(`/api/ecom/reports/summary?${params.toString()}`),
        api(`/api/ecom/reports/by-day?${params.toString()}`),
        api(`/api/ecom/reports/top-products?${params.toString()}&limit=10`),
        api(`/api/ecom/reports/by-status?${params.toString()}`),
      ]);
      setSummary(s);
      setByDay(d.rows || []);
      setTopProducts(t.rows || []);
      setByStatus(st.rows || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeLocation, days]);

  useEffect(() => { reload(); }, [reload]);

  const totalForStatusBars = useMemo(
    () => byStatus.reduce((s, r) => s + r.count, 0) || 1,
    [byStatus],
  );

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Reports</h2>
          <p className="text-sm text-gray-500 mt-1">
            {summary ? `Last ${summary.days} days · ${summary.paidOrderCount} paid orders` : 'Loading…'}
          </p>
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {[7, 30, 90, 365].map((n) => (
            <button key={n} type="button" onClick={() => setDays(n)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md ${days === n ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              {n === 365 ? '1y' : `${n}d`}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Revenue" value={summary ? fmt(summary.revenueMinor, businessCurrency) : null} hint={`${summary?.paidOrderCount || 0} orders`} />
        <KpiCard label="Avg basket" value={summary ? fmt(summary.avgBasketMinor, businessCurrency) : null} hint={`${summary?.avgItemsPerOrder || 0} items/order`} />
        <KpiCard label="Customer LTV" value={summary ? fmt(summary.customerLtvMinor, businessCurrency) : null} hint={`${summary?.uniqueCustomers || 0} unique`} />
        <KpiCard label="Total items sold" value={summary?.totalItemsSold} hint={`${summary?.publishedProducts || 0} published`} />
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">{error}</div>}

      {/* Revenue trend */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Revenue trend</h3>
        {byDay.length > 0 ? (
          <>
            <Sparkline rows={byDay} accessor={(r) => r.revenueMinor} />
            <div className="flex justify-between mt-2 text-[10px] text-gray-500 font-mono">
              <span>{byDay[0]?.date}</span>
              <span>{byDay[byDay.length - 1]?.date}</span>
            </div>
          </>
        ) : (
          <p className="text-xs text-gray-500">No revenue data yet for this window.</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Top products</h3>
            <p className="text-xs text-gray-500 mt-0.5">By revenue · last {days}d</p>
          </div>
          {topProducts.length === 0 ? (
            <p className="p-6 text-xs text-gray-500">No paid orders yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-[10px] font-mono tracking-[0.18em] uppercase text-gray-500">
                  <th className="px-4 py-2">Product</th>
                  <th className="px-4 py-2 text-right">Units</th>
                  <th className="px-4 py-2 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.map((p, i) => (
                  <tr key={p.productId || i} className="border-b border-gray-100">
                    <td className="px-4 py-2 truncate max-w-xs">{p.productName}</td>
                    <td className="px-4 py-2 text-right font-mono">{p.unitsSold}</td>
                    <td className="px-4 py-2 text-right font-mono font-semibold">{fmt(p.revenueMinor, businessCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Order status mix</h3>
            <p className="text-xs text-gray-500 mt-0.5">Last {days}d</p>
          </div>
          {byStatus.length === 0 ? (
            <p className="p-6 text-xs text-gray-500">No orders in this window.</p>
          ) : (
            <div className="p-4 space-y-2">
              {byStatus.map((s) => (
                <div key={s.status}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-mono">{s.status}</span>
                    <span className="font-mono">{s.count}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500"
                      style={{ width: `${(s.count / totalForStatusBars) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
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

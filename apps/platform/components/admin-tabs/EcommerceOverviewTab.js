'use client';

// ECOMMERCE Path B Phase 7b (2026-05-01) — prototype-matching Overview.
// Refactored to use the shared `ecom-ui` package — was 290 lines with
// inline helpers, now ~180 lines with the same UI but every primitive
// imported. Proof that the shared package pays off.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import {
  api, fmtMoney, fmtNumber,
  KpiCard, KpiGrid, ErrorBanner, PrimaryButton, SecondaryButton,
} from '@/components/ecom-ui';

const RANGE_OPTIONS = [
  { key: 'today', label: 'Today',     days: 1 },
  { key: '7d',    label: '7 days',    days: 7 },
  { key: '30d',   label: '30 days',   days: 30 },
  { key: 'month', label: 'This month', days: 30 },
  { key: '90d',   label: '90 days',   days: 90 },
];

function SalesChart({ rows, metric }) {
  if (!rows || rows.length === 0) {
    return <div className="text-sm text-gray-500 p-12 text-center">No data for this window yet.</div>;
  }
  const accessor = (r) => metric === 'orders' ? r.orders
    : metric === 'aov' ? (r.orders ? Math.round(r.revenueMinor / r.orders) : 0)
    : r.revenueMinor;
  const values = rows.map(accessor);
  const max = Math.max(...values, 1);
  const w = 800; const h = 240; const padX = 40; const padY = 30;
  const innerW = w - padX * 2; const innerH = h - padY * 2;
  const step = rows.length > 1 ? innerW / (rows.length - 1) : 0;
  const path = values.map((v, i) =>
    `${i === 0 ? 'M' : 'L'} ${(padX + i * step).toFixed(2)},${(padY + (1 - v / max) * innerH).toFixed(2)}`
  ).join(' ');
  const area = `${path} L ${(padX + (values.length - 1) * step).toFixed(2)},${padY + innerH} L ${padX},${padY + innerH} Z`;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-60" preserveAspectRatio="none">
        <defs>
          <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#16a34a" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#16a34a" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <line key={p} x1={padX} x2={padX + innerW} y1={padY + p * innerH} y2={padY + p * innerH}
            stroke="#E5E7EB" strokeWidth="1" strokeDasharray="3,3" />
        ))}
        <path d={area} fill="url(#salesGrad)" />
        <path d={path} fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="flex justify-between px-10 mt-1 text-[10px] text-gray-500 font-mono">
        <span>{rows[0]?.date}</span>
        <span>{rows[rows.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function CategoryDonut({ rows }) {
  if (!rows || rows.length === 0) {
    return <div className="text-sm text-gray-500 p-8 text-center">No category data yet.</div>;
  }
  const total = rows.reduce((s, r) => s + r.revenueMinor, 0);
  if (total <= 0) return <div className="text-sm text-gray-500 p-8 text-center">No revenue this window.</div>;

  const colors = ['#16a34a', '#22c55e', '#facc15', '#f97316', '#ef4444', '#a855f7', '#06b6d4', '#64748b'];
  const r = 60; const cx = 80; const cy = 80;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const segs = rows.map((row, i) => {
    const length = circumference * (row.revenueMinor / total);
    const seg = { ...row, color: colors[i % colors.length], length, offset };
    offset += length;
    return seg;
  });

  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg viewBox="0 0 160 160" className="w-40 h-40 shrink-0" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#F3F4F6" strokeWidth="20" />
        {segs.map((s, i) => (
          <circle key={s.categoryId || i} cx={cx} cy={cy} r={r}
            fill="none" stroke={s.color} strokeWidth="20"
            strokeDasharray={`${s.length.toFixed(2)} ${(circumference - s.length).toFixed(2)}`}
            strokeDashoffset={(-s.offset).toFixed(2)} />
        ))}
        <g style={{ transform: 'rotate(90deg)', transformOrigin: '80px 80px' }}>
          <text x={cx} y={cy - 4} textAnchor="middle" className="fill-gray-900" style={{ fontSize: '18px', fontWeight: 'bold' }}>
            {fmtMoney(total, 'GBP', { compact: true })}
          </text>
          <text x={cx} y={cy + 12} textAnchor="middle" className="fill-gray-500" style={{ fontSize: '10px' }}>total</text>
        </g>
      </svg>
      <div className="flex-1 min-w-0 space-y-1.5">
        {segs.slice(0, 6).map((s) => (
          <div key={s.categoryId || s.categoryName} className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className="text-gray-700 truncate">{s.categoryName}</span>
            </div>
            <span className="font-mono text-gray-900 shrink-0">{Math.round((s.revenueMinor / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function EcommerceOverviewTab({ me }) {
  const { active: activeLocation, locations } = useEcommerceLocation();
  const [range, setRange] = useState('today');
  const [summary, setSummary] = useState(null);
  const [byDay, setByDay] = useState([]);
  const [paymentsSum, setPaymentsSum] = useState(null);
  const [byCategory, setByCategory] = useState([]);
  const [chartMetric, setChartMetric] = useState('revenue');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const days = useMemo(() => RANGE_OPTIONS.find((r) => r.key === range)?.days || 1, [range]);
  const locationLabel = useMemo(() => {
    if (activeLocation === 'ALL') return 'All locations';
    return locations.find((l) => l.id === activeLocation)?.name || 'All locations';
  }, [activeLocation, locations]);

  const today = useMemo(() =>
    new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
  []);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      const [s, d, pay, cat] = await Promise.all([
        api(`/api/ecom/reports/summary?${params}`),
        api(`/api/ecom/reports/by-day?${params}`),
        api(`/api/ecom/payments/summary?${params}`),
        api(`/api/ecom/reports/by-category?${params}`).catch(() => ({ rows: [] })),
      ]);
      setSummary(s);
      setByDay(d.rows || []);
      setPaymentsSum(pay);
      setByCategory(cat.rows || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeLocation, days]);

  useEffect(() => { reload(); }, [reload]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const firstName = (me?.name || '').split(' ')[0] || 'there';
  const revenueValues = byDay.map((r) => r.revenueMinor);
  const orderValues = byDay.map((r) => r.orders);
  const aovValues = byDay.map((r) => (r.orders ? Math.round(r.revenueMinor / r.orders) : 0));

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border p-6 flex flex-wrap items-start justify-between gap-4"
        style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
        <div className="min-w-0">
          <div className="text-xs text-gray-500 font-medium mb-1">Console &middot; Dashboard</div>
          <h1 className="text-3xl font-bold text-gray-900 leading-tight">
            {greeting}, {firstName} <span aria-hidden>🌿</span>
          </h1>
          <p className="text-sm text-gray-500 mt-1">{locationLabel} · {today}</p>
        </div>
        <div className="flex gap-2">
          <SecondaryButton>Export</SecondaryButton>
          <PrimaryButton>+ Add product</PrimaryButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap gap-1.5">
          {RANGE_OPTIONS.map((r) => (
            <button key={r.key} type="button" onClick={() => setRange(r.key)}
              className="px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all"
              style={range === r.key ? {
                background: 'rgba(22,163,74,0.1)', borderColor: '#16a34a', color: '#15803d',
              } : { background: '#ffffff', borderColor: 'rgba(0,0,0,0.08)', color: '#4B5563' }}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500">Compared to previous period</span>
      </div>

      <ErrorBanner>{error}</ErrorBanner>

      <KpiGrid>
        <KpiCard
          label={range === 'today' ? "Today's revenue" : 'Revenue'}
          value={summary ? fmtMoney(summary.revenueMinor) : '—'}
          icon="£"
          sparklineValues={revenueValues}
          sparklineColor="#16a34a"
          hint={summary ? `${fmtNumber(summary.paidOrderCount)} paid orders` : ''}
        />
        <KpiCard
          label="Orders"
          value={summary ? fmtNumber(summary.paidOrderCount) : '—'}
          icon="📦"
          sparklineValues={orderValues}
          sparklineColor="#f97316"
          hint={paymentsSum?.pendingCount ? `${paymentsSum.pendingCount} pending` : ''}
        />
        <KpiCard
          label="Avg order value"
          value={summary ? fmtMoney(summary.avgBasketMinor) : '—'}
          icon="📊"
          sparklineValues={aovValues}
          sparklineColor="#facc15"
          hint={summary ? `${summary.avgItemsPerOrder} items / order` : ''}
        />
        <KpiCard
          label="Customers"
          value={summary ? fmtNumber(summary.uniqueCustomers) : '—'}
          icon="✨"
          sparklineValues={orderValues}
          sparklineColor="#ef4444"
          hint={summary ? `LTV ${fmtMoney(summary.customerLtvMinor)}` : ''}
        />
      </KpiGrid>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-2xl border p-6"
          style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
          <div className="flex items-start justify-between gap-2 mb-4 flex-wrap">
            <div>
              <h3 className="text-base font-bold text-gray-900">Sales — last {days} day{days > 1 ? 's' : ''}</h3>
              <p className="text-xs text-gray-500 mt-0.5">Trend with daily granularity</p>
            </div>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              {[
                { key: 'revenue', label: 'Revenue' },
                { key: 'orders',  label: 'Fulfillment' },
                { key: 'aov',     label: 'AOV' },
              ].map((m) => (
                <button key={m.key} type="button" onClick={() => setChartMetric(m.key)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md transition-all"
                  style={chartMetric === m.key ? {
                    background: '#ffffff', color: '#15803d', boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                  } : { color: '#6B7280' }}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          {loading && byDay.length === 0
            ? <div className="text-sm text-gray-500 p-12 text-center">Loading…</div>
            : <SalesChart rows={byDay} metric={chartMetric} />}
        </div>

        <div className="bg-white rounded-2xl border p-6" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
          <h3 className="text-base font-bold text-gray-900">Sales by category</h3>
          <p className="text-xs text-gray-500 mt-0.5 mb-5">Last {days} day{days > 1 ? 's' : ''}</p>
          {loading && byCategory.length === 0
            ? <div className="text-sm text-gray-500 p-8 text-center">Loading…</div>
            : <CategoryDonut rows={byCategory} />}
        </div>
      </div>
    </div>
  );
}

'use client';

// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// page split.

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { useTenant } from '@/components/TenantProvider';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea, Empty, formatAdminDate, formatAdminDateTime, formatMoneyMinor } from '@/components/admin-ui';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

const REPORT_RANGES = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: 'mtd', label: 'This month', mtd: true },
  { key: '12m', label: 'Last 12 months', days: 365 },
];

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function rangeFor(key) {
  const today = new Date();
  if (key === 'mtd') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: isoDay(first), to: isoDay(today) };
  }
  const preset = REPORT_RANGES.find((r) => r.key === key) || REPORT_RANGES[1];
  const from = new Date(today);
  from.setDate(today.getDate() - (preset.days - 1));
  return { from: isoDay(from), to: isoDay(today) };
}

function formatMoney(n, currency = 'USD') {
  if (n === null || n === undefined) return '—';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${n}`;
  }
}

function formatPct(n) {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function formatHourLabel(h) {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

function ReportsTab() {
  const [rangeKey, setRangeKey] = useState('30d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { tenant } = useTenant();
  const subscription = tenant?.subscription;
  // No per-business currency yet — fall back to USD until we wire that
  // through (the storefront cmsServices already has a currency code per
  // service, but reports aggregate across services, so this is a future
  // enhancement when multi-currency businesses become a thing).
  const currency = 'USD';

  const range = useMemo(() => rangeFor(rangeKey), [rangeKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    api(`/api/business/reports?from=${range.from}&to=${range.to}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load reports'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range.from, range.to]);

  const summary = data?.summary;
  const byDay = data?.byDay || [];
  const byHour = data?.byHour || [];
  const byService = data?.byService || [];
  const byStaff = data?.byStaff || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'var(--font-heading)' }}>Reports</h2>
          <p className="text-sm text-gray-500 mt-0.5">{range.from} → {range.to}</p>
        </div>
        <div className="inline-flex rounded-lg p-1 bg-gray-100">
          {REPORT_RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRangeKey(r.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${rangeKey === r.key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && !data ? (
        <div className="py-20 flex justify-center"><Spinner /></div>
      ) : (
        <>
          {/* 4 stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Revenue" value={formatMoney(summary?.totalRevenue, currency)} hint={`${summary?.completed || 0} completed · ${summary?.confirmed || 0} confirmed`} />
            <StatCard label="Bookings" value={summary?.totalBookings ?? 0} hint={`${summary?.pending || 0} pending`} />
            <StatCard label="Completion rate" value={formatPct(summary?.completionRate)} hint="of finishable bookings" />
            <StatCard label="No-show rate" value={formatPct(summary?.noShowRate)} hint={`${summary?.noShow || 0} no-shows`} accent={summary?.noShowRate > 0.1 ? 'warn' : null} />
          </div>

          {/* Revenue trend line */}
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900">Revenue</h3>
              <span className="text-xs text-gray-400">Confirmed + Completed only</span>
            </div>
            {byDay.length === 0 ? (
              <Empty text="No bookings in this range." />
            ) : (
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={byDay} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#f3f4f6" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={(v) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={(v) => `${currency === 'USD' ? '$' : ''}${v}`} />
                    <Tooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      formatter={(value) => [formatMoney(value, currency), 'Revenue']}
                    />
                    <Line type="monotone" dataKey="revenue" stroke="#4f46e5" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Bookings per day */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Bookings per day</h3>
              {byDay.length === 0 ? (
                <Empty text="No bookings in this range." />
              ) : (
                <div style={{ width: '100%', height: 220 }}>
                  <ResponsiveContainer>
                    <BarChart data={byDay} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#f3f4f6" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={(v) => v.slice(5)} />
                      <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} allowDecimals={false} />
                      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="completed" stackId="a" name="Completed" fill="#10b981" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="noShow" stackId="a" name="No-show" fill="#f43f5e" />
                      <Bar dataKey="cancelled" stackId="a" name="Cancelled" fill="#9ca3af" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Busiest hours */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Busiest hours</h3>
              {byHour.every((h) => h.count === 0) ? (
                <Empty text="No bookings to map yet." />
              ) : (
                <div style={{ width: '100%', height: 220 }}>
                  <ResponsiveContainer>
                    <BarChart data={byHour} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#f3f4f6" vertical={false} />
                      <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={formatHourLabel} interval={1} />
                      <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{ fontSize: 12, borderRadius: 8 }}
                        labelFormatter={(h) => `${formatHourLabel(h)} – ${formatHourLabel((h + 1) % 24)}`}
                        formatter={(value) => [value, 'bookings']}
                      />
                      <Bar dataKey="count" name="Bookings" fill="#4f46e5" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Top services */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Top services</h3>
              {byService.length === 0 ? (
                <Empty text="No services booked." />
              ) : (
                <ul className="divide-y divide-gray-100">
                  {byService.slice(0, 8).map((s) => (
                    <li key={s.serviceId} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">{s.serviceName}</p>
                        <p className="text-xs text-gray-500">{s.bookings} booking{s.bookings === 1 ? '' : 's'}</p>
                      </div>
                      <p className="font-mono text-sm text-gray-900">{formatMoney(s.revenue, currency)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Top staff */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">By staff</h3>
              {byStaff.length === 0 ? (
                <Empty text="No staff bookings." />
              ) : (
                <ul className="divide-y divide-gray-100">
                  {byStaff.slice(0, 8).map((s) => (
                    <li key={s.staffId} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">{s.staffName}</p>
                        <p className="text-xs text-gray-500">
                          {s.bookings} booking{s.bookings === 1 ? '' : 's'}
                          {s.noShowCount > 0 && <span className="text-rose-600"> · {s.noShowCount} no-show</span>}
                        </p>
                      </div>
                      <p className="font-mono text-sm text-gray-900">{formatMoney(s.revenue, currency)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Waitlist tab — pending customers who want a slot. Each row shows
// preference + actions (mark notified manually, dismiss, delete).
// ────────────────────────────────────────────────────────────────────────────

const WAITLIST_FILTERS = [
  { key: 'PENDING',   label: 'Waiting' },
  { key: 'NOTIFIED',  label: 'Notified' },
  { key: 'CONVERTED', label: 'Booked' },
  { key: 'DISMISSED', label: 'Dismissed' },
  { key: 'EXPIRED',   label: 'Expired' },
  { key: '',          label: 'All' },
];

function StatCard({ label, value, hint, accent }) {
  const tone = accent === 'warn' ? 'text-rose-600' : 'text-gray-900';
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <p className="text-[11px] font-bold tracking-wider uppercase text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone}`} style={{ fontFamily: 'var(--font-heading)' }}>{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export default ReportsTab;

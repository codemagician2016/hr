'use client';

// Premium hospitality Revenue panel for the restaurant_reservations admin.
// Self-fetches GET /api/restaurant/admin/revenue?days=30 and renders KPI cards, a
// pure-CSS daily revenue bar chart (no chart lib) and a service-period breakdown.
// Revenue here is an ESTIMATE derived from reservation values + deposits/prepaid,
// since live POS isn't integrated — clearly captioned below.

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { RX } from './theme';

const DAY_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
];

function money(value, currencyCode, { compact = false } = {}) {
  if (value == null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const opts = {
    maximumFractionDigits: 0,
    ...(compact ? { notation: 'compact', compactDisplay: 'short' } : {}),
  };
  if (currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode, ...opts }).format(num);
    } catch {
      // fall through to plain formatting on an unknown currency code
    }
  }
  return new Intl.NumberFormat(undefined, opts).format(num);
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function dowLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

export default function RevenuePanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [days, setDays] = useState(30);

  async function load(windowDays = days) {
    setLoading(true);
    setError('');
    try {
      const next = await api(`/api/restaurant/admin/revenue?days=${windowDays}`);
      setData(next);
    } catch (err) {
      setError(err.message || 'Could not load revenue insights');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(days); /* eslint-disable-next-line */ }, [days]);

  const currency = data?.currencyCode || null;
  const totals = data?.totals || {};
  const byPeriod = data?.byPeriod || [];
  const byDay = data?.byDay || [];

  const maxRevenue = useMemo(
    () => byDay.reduce((max, d) => Math.max(max, Number(d.revenue) || 0), 0),
    [byDay],
  );
  const hasRevenue = byDay.some((d) => (Number(d.revenue) || 0) > 0)
    || Number(totals.estimatedRevenue || 0) > 0;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-2xl border p-5" style={{ borderColor: RX.line, background: RX.panel }}>
              <div className="h-3 w-20 rounded animate-pulse" style={{ background: RX.lineSoft }} />
              <div className="mt-4 h-8 w-16 rounded animate-pulse" style={{ background: RX.lineSoft }} />
            </div>
          ))}
        </div>
        <div className="rounded-2xl border p-6" style={{ borderColor: RX.line, background: RX.panel }}>
          <div className="h-5 w-40 rounded animate-pulse" style={{ background: RX.lineSoft }} />
          <div className="mt-6 h-56 rounded-xl animate-pulse" style={{ background: RX.lineSoft }} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" style={{ color: RX.ink }}>
      {error && (
        <div className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: '#E7B7B0', background: RX.wineSoft, color: RX.wineDark }}>
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className={EYEBROW} style={{ color: RX.gold }}>Performance</p>
          <h2 className="mt-1 text-2xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Revenue &amp; covers</h2>
          <p className="mt-1 text-sm" style={{ color: RX.muted }}>
            Estimated dining value from your reservations, deposits and prepaid bookings.
          </p>
        </div>
        <label className="block">
          <span className={EYEBROW} style={{ color: RX.muted }}>Window</span>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="mt-1 block rounded-xl border px-3 py-2 text-sm outline-none"
            style={{ borderColor: RX.line, background: RX.panel, color: RX.ink }}
          >
            {DAY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="Est. dining revenue" value={money(totals.estimatedRevenue, currency, { compact: true })} accent="wine" big />
        <Metric label="Covers" value={totals.covers || 0} accent="teal" />
        <Metric label="Reservations" value={totals.reservations || 0} />
        <Metric label="Deposits collected" value={money(totals.depositsCollected, currency, { compact: true })} accent="teal" />
        <Metric label="Avg party size" value={fmtNum(totals.avgPartySize)} />
        <Metric label="No-shows" value={totals.noShows || 0} accent="wine" />
      </div>

      <section className="rounded-2xl border p-5" style={{ borderColor: RX.line, background: RX.panel }}>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className={EYEBROW} style={{ color: RX.gold }}>Daily Trend</p>
            <h3 className="mt-1 text-lg font-semibold" style={{ color: RX.ink }}>Estimated revenue by day</h3>
          </div>
          {currency && hasRevenue && (
            <span className="text-xs" style={{ color: RX.muted }}>Peak {money(maxRevenue, currency)}</span>
          )}
        </div>

        {!hasRevenue ? (
          <EmptyState
            title="No revenue yet"
            body="Once you take reservations with deposits or prepaid bookings, your estimated daily revenue trend will appear here."
          />
        ) : (
          <div className="mt-6">
            <div className="flex h-56 items-end gap-1 overflow-x-auto pb-1">
              {byDay.map((d, i) => {
                const rev = Number(d.revenue) || 0;
                const pct = maxRevenue > 0 ? Math.max((rev / maxRevenue) * 100, rev > 0 ? 4 : 0) : 0;
                const isPeak = rev > 0 && rev === maxRevenue;
                return (
                  <div key={d.date || i} className="group flex min-w-[18px] flex-1 flex-col items-center justify-end" style={{ height: '100%' }}>
                    <div className="relative flex w-full flex-1 items-end justify-center">
                      <div
                        className="w-full max-w-[26px] rounded-t-md transition-all"
                        style={{
                          height: `${pct}%`,
                          background: isPeak ? RX.wine : RX.teal,
                          opacity: rev > 0 ? 1 : 0.25,
                        }}
                        title={`${shortDate(d.date)} · ${money(rev, currency)} · ${d.covers || 0} covers`}
                      />
                      <div
                        className="pointer-events-none absolute bottom-full mb-1 hidden whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold text-white group-hover:block"
                        style={{ background: RX.ink }}
                      >
                        {money(rev, currency)} · {d.covers || 0} covers
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-1 overflow-x-auto">
              {byDay.map((d, i) => {
                const compact = byDay.length > 31;
                const show = !compact || i % 7 === 0;
                return (
                  <div key={`lbl-${d.date || i}`} className="min-w-[18px] flex-1 text-center text-[10px]" style={{ color: RX.muted }}>
                    {show ? (compact ? shortDate(d.date) : dowLabel(d.date)) : ''}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <p className="mt-5 rounded-xl px-3 py-2 text-xs" style={{ background: RX.cream, color: RX.muted, border: `1px solid ${RX.lineSoft}` }}>
          <span style={{ color: RX.gold, fontWeight: 700 }}>Estimate.</span>{' '}
          Revenue is calculated from reservation values, deposits and prepaid bookings — not from a live point-of-sale. Connect a POS later for actual settled sales.
        </p>
      </section>

      <section className="rounded-2xl border" style={{ borderColor: RX.line, background: RX.panel }}>
        <div className="p-5" style={{ borderBottom: `1px solid ${RX.lineSoft}` }}>
          <p className={EYEBROW} style={{ color: RX.gold }}>Service Periods</p>
          <h3 className="mt-1 text-lg font-semibold" style={{ color: RX.ink }}>Lunch &amp; dinner breakdown</h3>
        </div>
        {byPeriod.length === 0 ? (
          <EmptyState
            title="No service data"
            body="Revenue split across your lunch and dinner services will appear here as reservations come in."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr style={{ background: RX.cream, color: RX.muted }} className="text-[11px] uppercase tracking-[0.12em]">
                  <th className="px-5 py-3 font-bold">Service</th>
                  <th className="px-5 py-3 font-bold text-center">Reservations</th>
                  <th className="px-5 py-3 font-bold text-center">Covers</th>
                  <th className="px-5 py-3 font-bold text-right">Est. revenue</th>
                </tr>
              </thead>
              <tbody>
                {byPeriod.map((p, i) => (
                  <tr key={p.name || i} style={{ borderTop: `1px solid ${RX.lineSoft}` }}>
                    <td className="px-5 py-4 font-semibold" style={{ color: RX.ink }}>{p.name}</td>
                    <td className="px-5 py-4 text-center" style={{ color: RX.inkSoft }}>{p.reservations || 0}</td>
                    <td className="px-5 py-4 text-center" style={{ color: RX.inkSoft }}>{p.covers || 0}</td>
                    <td className="px-5 py-4 text-right" style={{ fontFamily: RX.serif, color: RX.wine }}>{money(p.revenue, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const EYEBROW = 'text-[11px] font-bold uppercase tracking-[0.18em]';

function fmtNum(value) {
  if (value == null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return Math.round(num * 10) / 10;
}

function Metric({ label, value, hint, accent, big }) {
  const valueColor = accent === 'teal' ? RX.teal : accent === 'wine' ? RX.wine : RX.ink;
  return (
    <div className="rounded-2xl border p-5" style={{ borderColor: RX.line, background: RX.panel }}>
      <p className={EYEBROW} style={{ color: RX.muted }}>{label}</p>
      <p className={`mt-2 ${big ? 'text-2xl' : 'text-3xl'}`} style={{ fontFamily: RX.serif, color: valueColor }}>{value}</p>
      {hint && <p className="mt-1 text-xs" style={{ color: RX.muted }}>{hint}</p>}
    </div>
  );
}

function EmptyState({ title, body }) {
  return (
    <div className="px-6 py-14 text-center">
      <div
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full text-xl"
        style={{ background: RX.tealSoft, color: RX.teal }}
      >
        ✦
      </div>
      <p className="mt-4 text-base font-semibold" style={{ color: RX.ink }}>{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm" style={{ color: RX.muted }}>{body}</p>
    </div>
  );
}

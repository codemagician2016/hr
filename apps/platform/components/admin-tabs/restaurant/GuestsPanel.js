'use client';

// Premium hospitality Guests (CRM) panel for the restaurant_reservations admin.
// Self-fetches GET /api/restaurant/admin/guests?days=90 and renders a searchable,
// sortable guest book with VIP / regular recognition. On-brand via the shared RX
// wine + teal + warm cream tokens so it matches the diner-facing storefront.

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { RX } from './theme';

const DAY_OPTIONS = [
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 365, label: 'Last 12 months' },
];

const SORTS = [
  { value: 'visits', label: 'Most visits' },
  { value: 'recent', label: 'Recently visited' },
  { value: 'covers', label: 'Most covers' },
  { value: 'name', label: 'Name (A–Z)' },
];

function money(value, currencyCode) {
  if (value == null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode,
        maximumFractionDigits: 0,
      }).format(num);
    } catch {
      // fall through to plain formatting on an unknown currency code
    }
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(num);
}

function relativeDate(iso) {
  if (!iso) return 'Never';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const diffMs = Date.now() - then.getTime();
  const day = 86400000;
  const days = Math.floor(diffMs / day);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months > 1 ? 's' : ''} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years > 1 ? 's' : ''} ago`;
}

export default function GuestsPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [days, setDays] = useState(90);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('visits');

  async function load(windowDays = days) {
    setLoading(true);
    setError('');
    try {
      const next = await api(`/api/restaurant/admin/guests?days=${windowDays}`);
      setData(next);
    } catch (err) {
      setError(err.message || 'Could not load your guest book');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(days); /* eslint-disable-next-line */ }, [days]);

  const currency = data?.currencyCode || null;
  const guests = data?.guests || [];

  const kpis = useMemo(() => {
    if (!guests.length) {
      return { total: 0, repeat: 0, vips: 0, avgCovers: 0 };
    }
    const repeat = guests.filter((g) => (g.visits || 0) > 1).length;
    const vips = guests.filter((g) => g.vip).length;
    const totalCovers = guests.reduce((sum, g) => sum + (g.totalCovers || 0), 0);
    return {
      total: data?.total ?? guests.length,
      repeat,
      vips,
      avgCovers: Math.round((totalCovers / guests.length) * 10) / 10,
    };
  }, [guests, data]);

  const visibleGuests = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = guests;
    if (q) {
      rows = rows.filter((g) => {
        const hay = `${g.name || ''} ${g.email || ''} ${g.phone || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }
    const sorted = [...rows];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'recent': {
          const at = a.lastVisit ? new Date(a.lastVisit).getTime() : 0;
          const bt = b.lastVisit ? new Date(b.lastVisit).getTime() : 0;
          return bt - at;
        }
        case 'covers':
          return (b.totalCovers || 0) - (a.totalCovers || 0);
        case 'name':
          return (a.name || '').localeCompare(b.name || '');
        case 'visits':
        default:
          return (b.visits || 0) - (a.visits || 0);
      }
    });
    return sorted;
  }, [guests, query, sort]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl border p-5" style={{ borderColor: RX.line, background: RX.panel }}>
              <div className="h-3 w-24 rounded animate-pulse" style={{ background: RX.lineSoft }} />
              <div className="mt-4 h-8 w-16 rounded animate-pulse" style={{ background: RX.lineSoft }} />
            </div>
          ))}
        </div>
        <div className="rounded-2xl border p-6" style={{ borderColor: RX.line, background: RX.panel }}>
          <div className="h-5 w-48 rounded animate-pulse" style={{ background: RX.lineSoft }} />
          <div className="mt-6 space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 rounded-xl animate-pulse" style={{ background: RX.lineSoft }} />
            ))}
          </div>
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
          <p className={EYEBROW} style={{ color: RX.gold }}>Guest Relations</p>
          <h2 className="mt-1 text-2xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Your guest book</h2>
          <p className="mt-1 text-sm" style={{ color: RX.muted }}>
            Recognise regulars, remember occasions and reward your most valued diners.
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

      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Total guests" value={kpis.total} />
        <Metric label="Repeat guests" value={kpis.repeat} accent="teal" hint="2+ visits" />
        <Metric label="VIPs" value={kpis.vips} accent="gold" hint="recognised" />
        <Metric label="Avg covers" value={kpis.avgCovers} hint="per guest" />
      </div>

      <section className="rounded-2xl border" style={{ borderColor: RX.line, background: RX.panel }}>
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between" style={{ borderBottom: `1px solid ${RX.lineSoft}` }}>
          <div>
            <p className={EYEBROW} style={{ color: RX.gold }}>Directory</p>
            <h3 className="mt-1 text-lg font-semibold" style={{ color: RX.ink }}>{visibleGuests.length} guests</h3>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email or phone"
              className="w-full rounded-xl border px-3 py-2 text-sm outline-none sm:w-64"
              style={{ borderColor: RX.line, background: RX.cream, color: RX.ink }}
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="rounded-xl border px-3 py-2 text-sm outline-none"
              style={{ borderColor: RX.line, background: RX.panel, color: RX.ink }}
            >
              {SORTS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
        </div>

        {guests.length === 0 ? (
          <EmptyState
            title="No guests yet"
            body="When diners reserve a table their details land here automatically, so you can build relationships and recognise regulars over time."
          />
        ) : visibleGuests.length === 0 ? (
          <EmptyState
            title="No matches"
            body={`No guests match “${query}”. Try a different name, email or phone number.`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr style={{ background: RX.cream, color: RX.muted }} className="text-[11px] uppercase tracking-[0.12em]">
                  <th className="px-5 py-3 font-bold">Guest</th>
                  <th className="px-5 py-3 font-bold">Contact</th>
                  <th className="px-5 py-3 font-bold text-center">Visits</th>
                  <th className="px-5 py-3 font-bold">Last visit</th>
                  <th className="px-5 py-3 font-bold text-center">Covers</th>
                  <th className="px-5 py-3 font-bold">Occasions &amp; notes</th>
                </tr>
              </thead>
              <tbody>
                {visibleGuests.map((g, idx) => {
                  const regular = (g.visits || 0) >= 3;
                  return (
                    <tr
                      key={g.email || g.phone || g.name || idx}
                      style={{ borderTop: `1px solid ${RX.lineSoft}` }}
                    >
                      <td className="px-5 py-4 align-top">
                        <div className="flex items-center gap-2">
                          {g.vip && (
                            <span title="VIP" aria-label="VIP" style={{ color: RX.gold }} className="text-base leading-none">★</span>
                          )}
                          <span className="font-semibold" style={{ color: RX.ink }}>{g.name || 'Guest'}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {regular && (
                            <Badge bg={RX.tealSoft} color={RX.teal}>Regular</Badge>
                          )}
                          {g.vip && (
                            <Badge bg="#F6EFDD" color={RX.gold}>VIP</Badge>
                          )}
                          {(g.noShows || 0) > 0 && (
                            <Badge bg={RX.wineSoft} color={RX.wine}>{g.noShows} no-show{g.noShows > 1 ? 's' : ''}</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-4 align-top" style={{ color: RX.inkSoft }}>
                        {g.email && <div className="truncate">{g.email}</div>}
                        {g.phone && <div className="mt-0.5" style={{ color: RX.muted }}>{g.phone}</div>}
                        {!g.email && !g.phone && <span style={{ color: RX.muted }}>—</span>}
                      </td>
                      <td className="px-5 py-4 text-center align-top">
                        <span className="text-lg" style={{ fontFamily: RX.serif, color: RX.wine }}>{g.visits || 0}</span>
                      </td>
                      <td className="px-5 py-4 align-top" style={{ color: RX.inkSoft }}>
                        {relativeDate(g.lastVisit)}
                      </td>
                      <td className="px-5 py-4 text-center align-top">
                        <span className="text-base font-semibold" style={{ color: RX.ink }}>{g.totalCovers || 0}</span>
                      </td>
                      <td className="px-5 py-4 align-top">
                        <div className="flex flex-wrap gap-1.5">
                          {(g.occasions || []).map((occ) => (
                            <Badge key={occ} bg={RX.cream} color={RX.inkSoft} border={RX.line}>{occ}</Badge>
                          ))}
                        </div>
                        {g.dietaryNotes && (
                          <p className="mt-1.5 text-xs italic" style={{ color: RX.muted }}>{g.dietaryNotes}</p>
                        )}
                        {!(g.occasions || []).length && !g.dietaryNotes && (
                          <span style={{ color: RX.muted }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {currency && guests.length > 0 && (
          <p className="px-5 py-3 text-xs" style={{ color: RX.muted, borderTop: `1px solid ${RX.lineSoft}` }}>
            Spend figures, where shown, are reported in {currency}.
          </p>
        )}
      </section>
    </div>
  );
}

const EYEBROW = 'text-[11px] font-bold uppercase tracking-[0.18em]';

function Metric({ label, value, hint, accent }) {
  const valueColor = accent === 'teal' ? RX.teal : accent === 'gold' ? RX.gold : RX.wine;
  return (
    <div className="rounded-2xl border p-5" style={{ borderColor: RX.line, background: RX.panel }}>
      <p className={EYEBROW} style={{ color: RX.muted }}>{label}</p>
      <p className="mt-2 text-3xl" style={{ fontFamily: RX.serif, color: valueColor }}>{value}</p>
      {hint && <p className="mt-1 text-xs" style={{ color: RX.muted }}>{hint}</p>}
    </div>
  );
}

function Badge({ children, bg, color, border }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ background: bg, color, border: border ? `1px solid ${border}` : undefined }}
    >
      {children}
    </span>
  );
}

function EmptyState({ title, body }) {
  return (
    <div className="px-6 py-14 text-center">
      <div
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full text-xl"
        style={{ background: RX.wineSoft, color: RX.wine }}
      >
        ✦
      </div>
      <p className="mt-4 text-base font-semibold" style={{ color: RX.ink }}>{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm" style={{ color: RX.muted }}>{body}</p>
    </div>
  );
}

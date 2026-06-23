'use client';

// Leave — apply for leave, see balances + own requests + a plain-English history
// and balance breakdown (Feature 6).
//
// SELF-SERVICE SURFACE (audit #54/#55): every call goes to the customer-session
// /api/hr/me/leave/* endpoints, which resolve the employee SERVER-SIDE from the
// session. The page NEVER sends an employeeId — the operator /api/hr/leave/* API
// 401s for a customer session, and a client-derived employeeId resolved to the
// WRONG subject (the customer id).
//   Balances : GET  /api/hr/me/leave/balances
//   Types    : GET  /api/hr/me/leave/types
//   History  : GET  /api/hr/me/leave/history   (every movement + request, signed)
//   Apply    : POST /api/hr/me/leave/requests   { leaveTypeId, startDate, endDate, ... }
//   Mine     : GET  /api/hr/me/leave/requests
//   Withdraw : POST /api/hr/me/leave/requests/:id/cancel  (PENDING)
//
// Balance card fix (§9.7): we use the server-computed `available` (= closing −
// pendingApproval), with the raw buckets as a fallback. There is NO `carryForward`
// field; carried units are folded into `opening`.
//
// Layman bar: the "Balance breakdown" card spells out the closing identity in
// plain English ("You started with X, earned Y, used Z, so you have W left"), and
// the History tab colour-codes every movement (green = credit, red = debit).

import { useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';
import { useProfile } from '@/lib/useProfile';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Tidy a Decimal-ish quantity to a short number (no trailing zeros).
function fmt(v) {
  const n = num(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

// Available = closing − pendingApproval (server also sends `available`; trust it
// first, fall back to the computed identity from the real buckets).
function availableOf(b) {
  if (b.available != null) return num(b.available);
  return num(b.closing) - num(b.pendingApproval);
}
function typeNameOf(b) {
  return b.leaveType?.name || b.leaveTypeName || b.name || 'Leave';
}
function unitWord(u) {
  const x = String(u || 'DAYS').toLowerCase();
  return x === 'weeks' ? 'weeks' : x === 'hours' ? 'hours' : 'days';
}
function unitLabel(b) {
  return unitWord(b.leaveType?.unit || b.unit);
}

const DOT = (color) => (
  <span className="inline-block h-2.5 w-2.5 rounded-full align-middle"
        style={{ backgroundColor: color || 'var(--theme-primary)' }} aria-hidden="true" />
);

// ── Balance breakdown card — the closing identity in plain English ────────────
// "You started with X, earned Y, used Z … so you have W left." Only non-zero
// movements are shown, so a fresh balance reads cleanly.
function BreakdownCard({ b }) {
  const unit = unitLabel(b);
  const avail = availableOf(b);
  const opening = num(b.opening);
  const accrued = num(b.accrued);
  const taken = num(b.taken);
  const encashed = num(b.encashed);
  const lapsed = num(b.lapsed);
  const adjusted = num(b.adjusted);
  const pending = num(b.pendingApproval);

  // line items: [label, signedValue, tone]
  const rows = [
    ['You started with', opening, 'neutral'],
    ['You earned (accrued)', accrued, 'credit'],
    ['You used (approved leave)', -taken, 'debit'],
    encashed ? ['Paid out (encashed)', -encashed, 'debit'] : null,
    lapsed ? ['Lapsed (expired unused)', -lapsed, 'debit'] : null,
    adjusted ? [adjusted >= 0 ? 'Manual credit' : 'Manual debit', adjusted, adjusted >= 0 ? 'credit' : 'debit'] : null,
  ].filter(Boolean);

  const toneColor = (tone, val) => {
    if (tone === 'credit' || (tone !== 'debit' && val > 0 && tone !== 'neutral')) return 'var(--theme-success, #15803d)';
    if (tone === 'debit') return 'var(--theme-danger, #b91c1c)';
    return 'var(--theme-text)';
  };

  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
          {DOT(b.leaveType?.color)}{typeNameOf(b)}
        </div>
        {b.periodCode && (
          <span className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>{b.periodCode}</span>
        )}
      </div>

      <dl className="space-y-1 text-sm">
        {rows.map(([label, val, tone], i) => (
          <div key={i} className="flex items-center justify-between">
            <dt style={{ color: 'var(--theme-muted)' }}>{label}</dt>
            <dd className="tabular-nums font-medium" style={{ color: toneColor(tone, val) }}>
              {val > 0 ? '+' : val < 0 ? '−' : ''}{fmt(Math.abs(val))}
            </dd>
          </div>
        ))}
        <div className="my-1 border-t" style={{ borderColor: 'var(--theme-border)' }} />
        <div className="flex items-center justify-between">
          <dt className="font-semibold" style={{ color: 'var(--theme-text)' }}>So you have left</dt>
          <dd className="tabular-nums text-base font-bold" style={{ color: 'var(--theme-primary)' }}>
            {fmt(avail)} {unit}
          </dd>
        </div>
        {pending > 0 && (
          <p className="pt-1 text-[11px]" style={{ color: 'var(--theme-muted)' }}>
            {fmt(pending)} {unit} of this is on hold for a request awaiting approval.
          </p>
        )}
      </dl>
    </div>
  );
}

// ── History feed — every movement + request, colour-coded green/red ───────────
function directionColor(dir) {
  if (dir === 'credit') return 'var(--theme-success, #15803d)';
  if (dir === 'debit') return 'var(--theme-danger, #b91c1c)';
  return 'var(--theme-muted)';
}
function STATUS_PILL(status) {
  const s = String(status || '').toUpperCase();
  const tone = s === 'APPROVED' || s === 'AVAILED' ? '#15803d'
    : s === 'PENDING' ? '#b45309'
    : s === 'REJECTED' || s === 'CANCELLED' || s === 'WITHDRAWN' ? '#b91c1c'
    : 'var(--theme-muted)';
  return (
    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: tone, border: `1px solid ${tone}` }}>{s}</span>
  );
}

function HistoryFeed({ items, loading }) {
  if (loading) return <Centered><Spinner small /></Centered>;
  if (!items || items.length === 0) {
    return <Empty text="No leave activity yet. When you apply for leave or earn leave, it will appear here." />;
  }
  return (
    <ol className="space-y-2">
      {items.map((h) => {
        const unit = unitWord(h.unit || h.leaveType?.unit);
        const sign = h.delta > 0 ? '+' : h.delta < 0 ? '−' : '';
        return (
          <li key={h.id} className="flex items-start justify-between gap-3 rounded-xl border bg-white p-3 text-sm shadow-sm"
              style={{ borderColor: 'var(--theme-border)' }}>
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium" style={{ color: 'var(--theme-text)' }}>
                {DOT(h.leaveType?.color)}
                <span className="truncate">{h.leaveType?.name || 'Leave'}</span>
                {STATUS_PILL(h.status)}
              </div>
              <div className="mt-0.5 text-[12px]" style={{ color: 'var(--theme-muted)' }}>
                {h.label}
                {h.startDate ? ` · ${h.startDate}${h.endDate && h.endDate !== h.startDate ? ` → ${h.endDate}` : ''}` : ''}
              </div>
              {h.reason && (
                <div className="mt-0.5 truncate text-[11px] italic" style={{ color: 'var(--theme-muted)' }}>“{h.reason}”</div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div className="tabular-nums font-semibold" style={{ color: directionColor(h.direction) }}>
                {h.delta ? `${sign}${fmt(Math.abs(h.delta))} ${unit}` : `—`}
              </div>
              {h.balanceAfter != null && (
                <div className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>
                  balance {fmt(h.balanceAfter)}
                </div>
              )}
              <div className="text-[10px]" style={{ color: 'var(--theme-muted)' }}>
                {String(h.appliedAt || h.createdAt || '').slice(0, 10)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function LeaveInner() {
  // The employee is resolved SERVER-SIDE by every /api/hr/me/leave/* call; we read
  // the profile only to gate the apply form when there is genuinely no record.
  const { employeeId } = useProfile();
  const canAct = !!employeeId;
  const [tab, setTab] = useState('overview'); // 'overview' | 'history'

  const { data: types, loading: typesLoading } = useApi('/api/hr/me/leave/types', {
    select: (b) => (Array.isArray(b) ? b : b?.items || []),
  });
  const { data: balances, loading: balLoading, reload: reloadBalances } = useApi(
    '/api/hr/me/leave/balances',
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.balances || []) }
  );
  const { data: myReqs, loading: reqLoading, reload: reloadReqs } = useApi(
    '/api/hr/me/leave/requests',
    { select: (b) => (Array.isArray(b) ? b : b?.items || []) }
  );
  const { data: history, loading: histLoading, reload: reloadHistory } = useApi(
    '/api/hr/me/leave/history',
    { select: (b) => (Array.isArray(b) ? b : b?.items || []) }
  );

  const typeOptions = useMemo(() => types || [], [types]);

  const [typeId, setTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startHalf, setStartHalf] = useState('');
  const [endHalf, setEndHalf] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const selectedType = useMemo(() => typeOptions.find((t) => t.id === typeId) || null, [typeOptions, typeId]);
  const reasonRequired = !!selectedType?.requiresReason;

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await apiPost('/api/hr/me/leave/requests', {
        leaveTypeId: typeId,
        startDate,
        endDate,
        startHalf: startHalf || undefined,
        endHalf: endHalf || undefined,
        reason,
      });
      setSuccess(true);
      setReason(''); setStartDate(''); setEndDate(''); setTypeId(''); setStartHalf(''); setEndHalf('');
      reloadBalances();
      reloadReqs();
      reloadHistory();
    } catch (err) {
      setError(err.message || 'Could not submit your leave request.');
    } finally {
      setSubmitting(false);
    }
  }

  async function onWithdraw(id) {
    try {
      await apiPost(`/api/hr/me/leave/requests/${encodeURIComponent(id)}/cancel`, {});
      reloadReqs();
      reloadBalances();
      reloadHistory();
    } catch (err) {
      setError(err.message || 'Could not withdraw the request.');
    }
  }

  const TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'history', label: 'History' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Leave</h1>

      {/* tabs */}
      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--theme-border)' }}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition"
              style={{
                borderColor: active ? 'var(--theme-primary)' : 'transparent',
                color: active ? 'var(--theme-primary)' : 'var(--theme-muted)',
              }}>
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'history' ? (
        <section>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
            Your leave history
          </h2>
          <p className="mb-3 text-[12px]" style={{ color: 'var(--theme-muted)' }}>
            Everything that changed your balance — leave you requested, leave you earned each month
            (accrued), and anything that lapsed or was paid out. Green adds to your balance, red takes away.
          </p>
          <HistoryFeed items={history} loading={histLoading} />
        </section>
      ) : (
        <>
          {/* ── Balances (headline) ── */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
              Your balances
            </h2>
            {balLoading ? (
              <Centered><Spinner small /></Centered>
            ) : !balances || balances.length === 0 ? (
              <Empty text="No leave balances to show." />
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {balances.map((b, i) => (
                  <div key={b.id || b.leaveTypeId || i}
                       className="rounded-2xl border bg-white p-3 shadow-sm"
                       style={{ borderColor: 'var(--theme-border)' }}>
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {DOT(b.leaveType?.color)}{typeNameOf(b)}
                    </div>
                    <div className="text-lg font-semibold" style={{ color: 'var(--theme-primary)' }}>
                      {fmt(availableOf(b))}
                      <span className="ml-1 text-xs font-normal" style={{ color: 'var(--theme-muted)' }}>{unitLabel(b)} available</span>
                    </div>
                    <div className="mt-1 text-[11px] leading-tight" style={{ color: 'var(--theme-muted)' }}>
                      Opening {fmt(b.opening)} · Accrued {fmt(b.accrued)} · Taken {fmt(b.taken)}
                      {num(b.pendingApproval) > 0 ? ` · On hold ${fmt(b.pendingApproval)}` : ''}
                      {num(b.lapsed) > 0 ? ` · Lapsed ${fmt(b.lapsed)}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Balance breakdown (the closing identity, layman-friendly) ── */}
          {!balLoading && balances && balances.length > 0 && (
            <section>
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
                Why your balance is what it is
              </h2>
              <p className="mb-3 text-[12px]" style={{ color: 'var(--theme-muted)' }}>
                Each card walks through the maths: what you started with, what you earned, and what you used.
              </p>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {balances.map((b, i) => (
                  <BreakdownCard key={b.id || b.leaveTypeId || i} b={b} />
                ))}
              </div>
            </section>
          )}

          {/* ── Apply ── */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
              Apply for leave
            </h2>
            <form onSubmit={onSubmit} className="max-w-2xl rounded-2xl border bg-white p-5 shadow-sm space-y-3"
                  style={{ borderColor: 'var(--theme-border)' }}>
              {error && <ErrorBanner message={error} />}
              {success && (
                <div className="rounded-lg px-3 py-2 text-sm"
                     style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                  Leave request submitted.
                </div>
              )}

              <label className="block text-sm">
                <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>Leave type</span>
                <select
                  required value={typeId} onChange={(e) => setTypeId(e.target.value)} disabled={typesLoading}
                  className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none"
                  style={{ borderColor: 'var(--theme-border)' }}
                >
                  <option value="" disabled>{typesLoading ? 'Loading…' : 'Select a type'}</option>
                  {typeOptions.map((t) => (<option key={t.id} value={t.id}>{t.name || t.label}</option>))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>From</span>
                  <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none" style={{ borderColor: 'var(--theme-border)' }} />
                  <select value={startHalf} onChange={(e) => setStartHalf(e.target.value)}
                    className="mt-1 w-full rounded-lg border bg-white px-2 py-1 text-xs outline-none" style={{ borderColor: 'var(--theme-border)' }}>
                    <option value="">Full day</option>
                    <option value="SECOND_HALF">2nd half only</option>
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>To</span>
                  <input type="date" required value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none" style={{ borderColor: 'var(--theme-border)' }} />
                  <select value={endHalf} onChange={(e) => setEndHalf(e.target.value)}
                    className="mt-1 w-full rounded-lg border bg-white px-2 py-1 text-xs outline-none" style={{ borderColor: 'var(--theme-border)' }}>
                    <option value="">Full day</option>
                    <option value="FIRST_HALF">1st half only</option>
                  </select>
                </label>
              </div>

              <label className="block text-sm">
                <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>
                  Reason{reasonRequired ? ' (required)' : ''}
                </span>
                <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required={reasonRequired}
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none" style={{ borderColor: 'var(--theme-border)' }} />
              </label>

              <button type="submit" disabled={submitting || !canAct}
                className="w-full rounded-lg py-2.5 text-sm font-semibold transition disabled:opacity-60"
                style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                {submitting ? 'Submitting…' : 'Submit request'}
              </button>
            </form>
          </section>

          {/* ── My requests ── */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
              My requests
            </h2>
            {reqLoading ? (
              <Centered><Spinner small /></Centered>
            ) : !myReqs || myReqs.length === 0 ? (
              <Empty text="You have no leave requests yet." />
            ) : (
              <div className="space-y-2">
                {myReqs.map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-xl border bg-white p-3 text-sm shadow-sm"
                       style={{ borderColor: 'var(--theme-border)' }}>
                    <div>
                      <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--theme-text)' }}>
                        {DOT(r.leaveType?.color)}{r.leaveType?.name || 'Leave'} · {fmt(Math.abs(num(r.quantity)))} {unitLabel(r)}
                      </div>
                      <div className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>
                        {String(r.startDate).slice(0, 10)} → {String(r.endDate).slice(0, 10)} · {r.status}
                        {r.status === 'REJECTED' && r.reason ? ` · ${r.reason}` : ''}
                      </div>
                    </div>
                    {r.status === 'PENDING' && (
                      <button onClick={() => onWithdraw(r.id)}
                        className="rounded-lg border px-3 py-1 text-xs font-medium" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}>
                        Withdraw
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default function LeavePage() {
  return (
    <AppShell>
      <LeaveInner />
    </AppShell>
  );
}

'use client';

// Leave — apply for leave, see balances + own requests (Feature 6).
//
// SELF-SERVICE SURFACE (audit #54/#55): every call goes to the customer-session
// /api/hr/me/leave/* endpoints, which resolve the employee SERVER-SIDE from the
// session. The page NEVER sends an employeeId — the operator /api/hr/leave/* API
// 401s for a customer session, and a client-derived employeeId resolved to the
// WRONG subject (the customer id).
//   Balances : GET  /api/hr/me/leave/balances
//   Types    : GET  /api/hr/me/leave/types
//   Apply    : POST /api/hr/me/leave/requests   { leaveTypeId, startDate, endDate, ... }
//   Mine     : GET  /api/hr/me/leave/requests
//   Withdraw : POST /api/hr/me/leave/requests/:id/cancel  (PENDING)
//
// Balance card fix (§9.7): the old card read `b.available ?? b.balance ??
// b.remaining ?? 0` — none of those keys existed, so every card rendered 0. We
// now use the server-computed `available` (= closing − pendingApproval), with the
// raw buckets as a fallback. There is NO `carryForward` field; carried units are
// folded into `opening`.

import { useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';
import { useProfile } from '@/lib/useProfile';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Available = closing − pendingApproval (server also sends `available`; trust it
// first, fall back to the computed identity from the real buckets).
function availableOf(b) {
  if (b.available != null) return num(b.available);
  return num(b.closing) - num(b.pendingApproval);
}
function typeNameOf(b) {
  return b.leaveType?.name || b.leaveTypeName || b.name || 'Leave';
}
function unitLabel(b) {
  const u = (b.leaveType?.unit || b.unit || 'DAYS').toLowerCase();
  return u === 'weeks' ? 'weeks' : u === 'hours' ? 'hours' : 'days';
}

function LeaveInner() {
  // The employee is resolved SERVER-SIDE by every /api/hr/me/leave/* call; we read
  // the profile only to gate the apply form when there is genuinely no record.
  const { employeeId } = useProfile();
  const canAct = !!employeeId;

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
    } catch (err) {
      setError(err.message || 'Could not withdraw the request.');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Leave</h1>

      {/* ── Balances ── */}
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
                <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>{typeNameOf(b)}</div>
                <div className="text-lg font-semibold" style={{ color: 'var(--theme-primary)' }}>
                  {availableOf(b)}
                  <span className="ml-1 text-xs font-normal" style={{ color: 'var(--theme-muted)' }}>{unitLabel(b)} available</span>
                </div>
                <div className="mt-1 text-[11px] leading-tight" style={{ color: 'var(--theme-muted)' }}>
                  Opening {num(b.opening)} · Accrued {num(b.accrued)} · Taken {num(b.taken)}
                  {num(b.pendingApproval) > 0 ? ` · Pending ${num(b.pendingApproval)}` : ''}
                  {num(b.lapsed) > 0 ? ` · Lapsed ${num(b.lapsed)}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

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
                  <div className="font-medium" style={{ color: 'var(--theme-text)' }}>
                    {r.leaveType?.name || 'Leave'} · {Math.abs(num(r.quantity))} {unitLabel(r)}
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

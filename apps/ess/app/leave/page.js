'use client';

// Leave — apply for leave + show balances.
//   Balances : GET  /api/hr/leave/employees/:id/balances  (id from session)
//   Types    : GET  /api/hr/leave/types
//   Apply    : POST /api/hr/leave/requests

import { useMemo, useState } from 'react';
import AppShell, { useSession } from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';

function employeeId(me) {
  return me?.employee?.id || me?.employeeId || me?.customer?.employeeId || me?.id || null;
}

function LeaveInner() {
  const me = useSession();
  const empId = employeeId(me);

  const { data: types, loading: typesLoading } = useApi('/api/hr/leave/types', {
    select: (b) => (Array.isArray(b) ? b : b?.items || []),
  });
  const { data: balances, loading: balLoading, reload: reloadBalances } = useApi(
    empId ? `/api/hr/leave/employees/${encodeURIComponent(empId)}/balances` : null,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.balances || []) }
  );

  const typeOptions = useMemo(() => types || [], [types]);

  const [typeId, setTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await apiPost('/api/hr/leave/requests', {
        employeeId: empId,
        leaveTypeId: typeId,
        startDate,
        endDate,
        reason,
      });
      setSuccess(true);
      setReason('');
      setStartDate('');
      setEndDate('');
      setTypeId('');
      reloadBalances();
    } catch (err) {
      setError(err.message || 'Could not submit your leave request.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>Leave</h1>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          Your balances
        </h2>
        {balLoading ? (
          <Centered><Spinner small /></Centered>
        ) : !balances || balances.length === 0 ? (
          <Empty text="No leave balances to show." />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {balances.map((b, i) => (
              <div key={b.id || b.leaveTypeId || i}
                   className="rounded-2xl border bg-white p-3 shadow-sm"
                   style={{ borderColor: 'var(--theme-border)' }}>
                <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                  {b.leaveTypeName || b.name || b.type || 'Leave'}
                </div>
                <div className="text-lg font-semibold" style={{ color: 'var(--theme-primary)' }}>
                  {b.available ?? b.balance ?? b.remaining ?? 0}
                  <span className="ml-1 text-xs font-normal" style={{ color: 'var(--theme-muted)' }}>days</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          Apply for leave
        </h2>
        <form onSubmit={onSubmit} className="rounded-2xl border bg-white p-4 shadow-sm space-y-3"
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
              required
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              disabled={typesLoading}
              className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none"
              style={{ borderColor: 'var(--theme-border)' }}
            >
              <option value="" disabled>{typesLoading ? 'Loading…' : 'Select a type'}</option>
              {typeOptions.map((t) => (
                <option key={t.id} value={t.id}>{t.name || t.label}</option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>From</span>
              <input
                type="date" required value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                style={{ borderColor: 'var(--theme-border)' }}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>To</span>
              <input
                type="date" required value={endDate} min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                style={{ borderColor: 'var(--theme-border)' }}
              />
            </label>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>Reason</span>
            <textarea
              rows={3} value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{ borderColor: 'var(--theme-border)' }}
            />
          </label>

          <button
            type="submit"
            disabled={submitting || !empId}
            className="w-full rounded-lg py-2.5 text-sm font-semibold transition disabled:opacity-60"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
        </form>
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

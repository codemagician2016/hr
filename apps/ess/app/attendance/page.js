'use client';

// Attendance — clock in / out, today's punches, this-period summary.
//
//   Punch   : POST /api/hr/attendance/punch  { employeeId, type, source }
//             (type ∈ IN | OUT | BREAK_START | BREAK_END)
//   Punches : GET  /api/hr/attendance/punches?employeeId=&from=&to=
//
// All reads/writes are cookie-authed against the employee session and tenant-
// scoped server-side by req.user.businessId; we pass our own employeeId so the
// backend records the punch against the right employee.

import { useMemo, useState } from 'react';
import AppShell, { useSession } from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';
import { formatTime, formatDate, employeeIdOf } from '@/lib/format';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfPeriod() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

const PUNCH_LABELS = {
  IN: 'Clocked in',
  OUT: 'Clocked out',
  BREAK_START: 'Break started',
  BREAK_END: 'Break ended',
};

// Sum worked ms across IN→OUT pairs (ignores breaks for a simple headline).
function workedMs(punches) {
  const sorted = [...punches].sort((a, b) => new Date(a.punchAt) - new Date(b.punchAt));
  let total = 0;
  let openIn = null;
  for (const p of sorted) {
    if (p.punchType === 'IN') openIn = new Date(p.punchAt);
    else if (p.punchType === 'OUT' && openIn) {
      total += new Date(p.punchAt) - openIn;
      openIn = null;
    }
  }
  return total;
}

function fmtHours(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function AttendanceInner() {
  const me = useSession();
  const empId = employeeIdOf(me);

  const from = useMemo(() => startOfPeriod().toISOString(), []);
  const to = useMemo(() => endOfToday().toISOString(), []);

  const { data: punches, loading, error, reload } = useApi(
    empId ? `/api/hr/attendance/punches?employeeId=${encodeURIComponent(empId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : null,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.punches || []) }
  );

  const all = punches || [];
  const today = useMemo(() => {
    const t0 = startOfToday().getTime();
    return all.filter((p) => new Date(p.punchAt).getTime() >= t0)
      .sort((a, b) => new Date(b.punchAt) - new Date(a.punchAt));
  }, [all]);

  const lastType = today[0]?.punchType;
  const isClockedIn = lastType === 'IN' || lastType === 'BREAK_END';

  const periodWorked = useMemo(() => fmtHours(workedMs(all)), [all]);
  const todayWorked = useMemo(() => fmtHours(workedMs(today)), [today]);
  const daysPresent = useMemo(() => {
    const days = new Set(all.map((p) => formatDate(p.punchAt)));
    return days.size;
  }, [all]);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  async function punch(type) {
    if (!empId) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiPost('/api/hr/attendance/punch', { employeeId: empId, type, source: 'WEB' });
      reload();
    } catch (e) {
      setActionError(e.message || 'Could not record your punch.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Centered><Spinner /></Centered>;
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load attendance.'} />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>Attendance</h1>

      {/* Clock card */}
      <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="mb-4 text-center">
          <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
            {isClockedIn ? 'You are clocked in' : 'You are clocked out'}
          </p>
          <p className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>{todayWorked}</p>
          <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>worked today</p>
        </div>

        {actionError && <ErrorBanner message={actionError} />}

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => punch('IN')}
            disabled={busy || !empId || isClockedIn}
            className="rounded-lg py-3 text-sm font-semibold transition disabled:opacity-50"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {busy ? '…' : 'Clock in'}
          </button>
          <button
            onClick={() => punch('OUT')}
            disabled={busy || !empId || !isClockedIn}
            className="rounded-lg border py-3 text-sm font-semibold transition disabled:opacity-50"
            style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}
          >
            {busy ? '…' : 'Clock out'}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            onClick={() => punch('BREAK_START')}
            disabled={busy || !empId || !isClockedIn}
            className="rounded-lg border py-2 text-xs font-medium transition disabled:opacity-50"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
          >
            Start break
          </button>
          <button
            onClick={() => punch('BREAK_END')}
            disabled={busy || !empId || lastType !== 'BREAK_START'}
            className="rounded-lg border py-2 text-xs font-medium transition disabled:opacity-50"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
          >
            End break
          </button>
        </div>
      </section>

      {/* This-period summary */}
      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border bg-white p-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>This period worked</div>
          <div className="text-lg font-semibold" style={{ color: 'var(--theme-primary)' }}>{periodWorked}</div>
        </div>
        <div className="rounded-2xl border bg-white p-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>Days present</div>
          <div className="text-lg font-semibold" style={{ color: 'var(--theme-primary)' }}>{daysPresent}</div>
        </div>
      </section>

      {/* Today's punches */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          Today's punches
        </h2>
        {today.length === 0 ? (
          <Empty text="No punches recorded today." />
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            {today.map((p, i) => (
              <li key={p.id || i} className="flex items-center justify-between border-b px-4 py-3 text-sm last:border-b-0"
                  style={{ borderColor: 'var(--theme-border)' }}>
                <span style={{ color: 'var(--theme-text)' }}>{PUNCH_LABELS[p.punchType] || p.punchType}</span>
                <span className="font-medium" style={{ color: 'var(--theme-muted)' }}>{formatTime(p.punchAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function AttendancePage() {
  return (
    <AppShell>
      <AttendanceInner />
    </AppShell>
  );
}

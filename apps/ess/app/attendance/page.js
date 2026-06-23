'use client';

// Attendance (ESS) — clock, timesheets, corrections, schedule (Feature 2, Phase 4).
//
//   Punch        : POST /api/hr/attendance/punch  { employeeId, type, source }
//                  (type ∈ IN | OUT | BREAK_START | BREAK_END)
//   Punches      : GET  /api/hr/attendance/punches?employeeId=&from=&to=
//   Timesheets   : GET  /api/hr/attendance/timesheets?employeeId=
//                  GET  /api/hr/attendance/timesheets/:id   (per-day entries)
//                  POST /api/hr/attendance/timesheets/:id/submit  (self allowed)
//   Corrections  : GET  /api/hr/attendance/regularizations?employeeId=
//                  POST /api/hr/attendance/regularizations
//                  { date, requestedInAt, requestedOutAt, kind, reason }
//   Schedule     : (from punches' resolved shift / shifts assignments) — best-effort
//   Holidays     : GET  /api/hr/attendance/holidays?countryCode=&year=
//
// All reads/writes are cookie-authed and tenant-/scope-filtered server-side; we
// pass our own employeeId so writes land on the right employee. Headline figures
// here are client-side indicative; the authoritative payable comes from the
// frozen period summary.

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
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const PUNCH_LABELS = {
  IN: 'Clocked in',
  OUT: 'Clocked out',
  BREAK_START: 'Break started',
  BREAK_END: 'Break ended',
};

const CORRECTION_KINDS = [
  ['MISSED_PUNCH', 'Missed punch'],
  ['WFH', 'Work from home'],
  ['ON_DUTY', 'On duty'],
  ['LATE_WAIVER', 'Late waiver'],
];

const SECTIONS = [
  { key: 'clock', label: 'Clock' },
  { key: 'timesheet', label: 'My timesheet' },
  { key: 'corrections', label: 'Corrections' },
  { key: 'schedule', label: 'Schedule' },
];

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

function StatusPill({ status }) {
  const s = String(status || '').toUpperCase();
  let cls = 'bg-gray-100 text-gray-600';
  if (['APPROVED', 'LOCKED', 'AVAILED'].includes(s)) cls = 'bg-emerald-100 text-emerald-700';
  else if (['SUBMITTED', 'PENDING', 'DRAFT'].includes(s)) cls = 'bg-amber-100 text-amber-700';
  else if (['REJECTED', 'CANCELLED'].includes(s)) cls = 'bg-red-100 text-red-700';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  );
}

// ─── Clock (existing behaviour, kept) ────────────────────────────────────────

function ClockSection({ empId }) {
  const from = useMemo(() => startOfPeriod().toISOString(), []);
  const to = useMemo(() => endOfToday().toISOString(), []);

  const { data: punches, loading, error, reload } = useApi(
    empId ? `/api/hr/attendance/punches?employeeId=${encodeURIComponent(empId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : null,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.punches || []) }
  );

  const all = punches || [];
  const today = useMemo(() => {
    const t0 = startOfToday().getTime();
    return all
      .filter((p) => new Date(p.punchAt).getTime() >= t0)
      .sort((a, b) => new Date(b.punchAt) - new Date(a.punchAt));
  }, [all]);

  const lastType = today[0]?.punchType;
  const isClockedIn = lastType === 'IN' || lastType === 'BREAK_END';

  const periodWorked = useMemo(() => fmtHours(workedMs(all)), [all]);
  const todayWorked = useMemo(() => fmtHours(workedMs(today)), [today]);
  const daysPresent = useMemo(() => new Set(all.map((p) => formatDate(p.punchAt))).size, [all]);

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
      <p className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>
        These figures are indicative. Your payable days are confirmed when the period is locked.
      </p>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          Today&apos;s punches
        </h2>
        {today.length === 0 ? (
          <Empty text="No punches recorded today." />
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            {today.map((p, i) => (
              <li
                key={p.id || i}
                className="flex items-center justify-between border-b px-4 py-3 text-sm last:border-b-0"
                style={{ borderColor: 'var(--theme-border)' }}
              >
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

// ─── My timesheet ────────────────────────────────────────────────────────────

function TimesheetDetail({ timesheet, onSubmitted }) {
  const { data, loading, error } = useApi(
    `/api/hr/attendance/timesheets/${encodeURIComponent(timesheet.id)}`,
    { select: (b) => b }
  );
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const entries = useMemo(() => {
    const e = data?.entries || data?.days || data?.timesheetEntries;
    return Array.isArray(e) ? e : [];
  }, [data]);

  const status = data?.status || timesheet.status;
  const canSubmit = String(status || '').toUpperCase() === 'DRAFT';

  async function submit() {
    setBusy(true);
    setSubmitError(null);
    try {
      await apiPost(`/api/hr/attendance/timesheets/${encodeURIComponent(timesheet.id)}/submit`, {});
      onSubmitted();
    } catch (e) {
      setSubmitError(e.message || 'Could not submit your timesheet.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="px-4 py-3"><Spinner small /></div>;
  if (error && error.status !== 404) {
    return <div className="px-4 py-3"><ErrorBanner message={error.message || 'Could not load timesheet.'} /></div>;
  }

  return (
    <div className="px-4 py-3 space-y-3" style={{ background: 'var(--theme-surface-muted, #f9fafb)' }}>
      {submitError && <ErrorBanner message={submitError} />}
      {entries.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>No day-level entries on this timesheet yet.</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-white" style={{ borderColor: 'var(--theme-border)' }}>
          {entries.map((e, i) => (
            <li key={e.id || i} className="flex items-center justify-between px-3 py-2 text-sm">
              <span style={{ color: 'var(--theme-text)' }}>{formatDate(e.date || e.workDate)}</span>
              <span className="flex items-center gap-2">
                {e.status && <StatusPill status={e.status} />}
                <span className="font-medium" style={{ color: 'var(--theme-muted)' }}>
                  {e.hours != null ? `${e.hours}h` : e.workedMinutes != null ? fmtHours(e.workedMinutes * 60000) : '—'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {canSubmit && (
        <button
          onClick={submit}
          disabled={busy}
          className="rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50"
          style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
        >
          {busy ? 'Submitting…' : 'Submit timesheet'}
        </button>
      )}
    </div>
  );
}

function TimesheetSection({ empId }) {
  const { data: timesheets, loading, error, reload } = useApi(
    empId ? `/api/hr/attendance/timesheets?employeeId=${encodeURIComponent(empId)}` : null,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.timesheets || []) }
  );
  const [openId, setOpenId] = useState(null);

  if (loading) return <Centered><Spinner /></Centered>;
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load your timesheets.'} />;
  }

  const list = timesheets || [];

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
        My timesheets
      </h2>
      {list.length === 0 ? (
        <Empty text="No timesheet periods yet." />
      ) : (
        <ul className="space-y-2">
          {list.map((t) => {
            const open = openId === t.id;
            return (
              <li key={t.id} className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : t.id)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                >
                  <span>
                    <span className="block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                      {formatDate(t.periodStart || t.weekStart)} – {formatDate(t.periodEnd || t.weekEnd)}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {t.totalHours != null ? `${t.totalHours}h` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusPill status={t.status} />
                    <span aria-hidden="true" style={{ color: 'var(--theme-muted)' }}>{open ? '−' : '+'}</span>
                  </span>
                </button>
                {open && <TimesheetDetail timesheet={t} onSubmitted={reload} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Request correction ──────────────────────────────────────────────────────

function CorrectionsSection({ empId }) {
  const { data: requests, loading, error, reload } = useApi(
    empId ? `/api/hr/attendance/regularizations?employeeId=${encodeURIComponent(empId)}` : null,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.requests || []) }
  );

  const [date, setDate] = useState(todayISO());
  const [inAt, setInAt] = useState('');
  const [outAt, setOutAt] = useState('');
  const [kind, setKind] = useState('MISSED_PUNCH');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [success, setSuccess] = useState(false);

  // Combine a yyyy-mm-dd date and a hh:mm time into an ISO instant for the API.
  function toInstant(d, t) {
    if (!d || !t) return undefined;
    const dt = new Date(`${d}T${t}`);
    return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
  }

  async function submit(e) {
    e.preventDefault();
    setFormError(null);
    setSuccess(false);
    if (!reason.trim()) {
      setFormError('Please give a reason for your request.');
      return;
    }
    setSubmitting(true);
    try {
      await apiPost('/api/hr/attendance/regularizations', {
        employeeId: empId,
        date,
        requestedInAt: toInstant(date, inAt),
        requestedOutAt: toInstant(date, outAt),
        kind,
        reason: reason.trim(),
      });
      setSuccess(true);
      setReason('');
      setInAt('');
      setOutAt('');
      reload();
    } catch (err) {
      setFormError(err.message || 'Could not submit your request.');
    } finally {
      setSubmitting(false);
    }
  }

  const list = requests || [];
  const inputCls = 'w-full rounded-lg border px-3 py-2 text-sm';
  const inputStyle = { borderColor: 'var(--theme-border)' };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Request a correction</h2>
        {formError && <ErrorBanner message={formError} />}
        {success && (
          <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Request sent to your manager for approval.
          </p>
        )}
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="corr-date" className="mb-1 block text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Date</label>
            <input id="corr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required className={inputCls} style={inputStyle} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="corr-in" className="mb-1 block text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Clock-in time</label>
              <input id="corr-in" type="time" value={inAt} onChange={(e) => setInAt(e.target.value)} className={inputCls} style={inputStyle} />
            </div>
            <div>
              <label htmlFor="corr-out" className="mb-1 block text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Clock-out time</label>
              <input id="corr-out" type="time" value={outAt} onChange={(e) => setOutAt(e.target.value)} className={inputCls} style={inputStyle} />
            </div>
          </div>
          <div>
            <label htmlFor="corr-kind" className="mb-1 block text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Kind</label>
            <select id="corr-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls} style={inputStyle}>
              {CORRECTION_KINDS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="corr-reason" className="mb-1 block text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Reason</label>
            <textarea
              id="corr-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              required
              className={inputCls}
              style={inputStyle}
              placeholder="Why is this correction needed?"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !empId}
            className="rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {submitting ? 'Sending…' : 'Send request'}
          </button>
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          My requests
        </h2>
        {loading ? (
          <Centered><Spinner small /></Centered>
        ) : error && error.status !== 404 ? (
          <ErrorBanner message={error.message || 'Could not load your requests.'} />
        ) : list.length === 0 ? (
          <Empty text="You haven't raised any corrections yet." />
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            {list.map((r, i) => {
              const kindLabel = CORRECTION_KINDS.find(([v]) => v === r.kind)?.[1] || r.kind || 'Correction';
              return (
                <li key={r.id || r.requestId || i} className="border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--theme-border)' }}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                      {formatDate(r.date || r.forDate || r.createdAt)} · {kindLabel}
                    </span>
                    <StatusPill status={r.status} />
                  </div>
                  {r.reason && <p className="mt-0.5 text-xs" style={{ color: 'var(--theme-muted)' }}>{r.reason}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─── My schedule + holidays ──────────────────────────────────────────────────

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function countryOf(me) {
  return (
    me?.employee?.countryCode ||
    me?.employee?.country ||
    me?.countryCode ||
    me?.customer?.countryCode ||
    null
  );
}

function ScheduleSection({ empId, me }) {
  const countryCode = countryOf(me);
  const year = new Date().getFullYear();

  // Current shift assignment for this employee (best-effort: the backend scopes
  // /shifts to the tenant; we surface the one whose assignment covers today).
  const { data: assignment, loading: aLoading } = useApi(
    empId ? `/api/hr/attendance/shifts?employeeId=${encodeURIComponent(empId)}` : null,
    {
      select: (b) => {
        const shifts = Array.isArray(b) ? b : b?.items || b?.shifts || [];
        // Find the shift carrying an assignment for this employee.
        for (const s of shifts) {
          const assigns = s.assignments || [];
          const mine = assigns.find((a) => a.employeeId === empId);
          if (mine) return { shift: s, assignment: mine };
        }
        // Fall back to the single shift if the API already filtered to this employee.
        if (shifts.length === 1) return { shift: shifts[0], assignment: shifts[0].assignment || null };
        return null;
      },
    }
  );

  const { data: holidays, loading: hLoading, error: hError } = useApi(
    `/api/hr/attendance/holidays?year=${year}${countryCode ? `&countryCode=${encodeURIComponent(countryCode)}` : ''}`,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.holidays || []) }
  );

  const upcoming = useMemo(() => {
    const list = holidays || [];
    const today = startOfToday().getTime();
    return list
      .filter((h) => {
        const t = new Date(h.observedDate || h.date).getTime();
        return !Number.isNaN(t) && t >= today;
      })
      .sort((a, b) => new Date(a.observedDate || a.date) - new Date(b.observedDate || b.date))
      .slice(0, 12);
  }, [holidays]);

  const shift = assignment?.shift;
  const weeklyOff = useMemo(() => {
    if (!shift) return [];
    const raw = shift.weeklyOffDays;
    const arr = Array.isArray(raw) ? raw : String(raw || '').split(',').map((x) => x.trim()).filter((x) => x !== '');
    return arr.map((d) => WEEKDAY_NAMES[Number(d)]).filter(Boolean);
  }, [shift]);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          My schedule
        </h2>
        {aLoading ? (
          <Centered><Spinner small /></Centered>
        ) : !shift ? (
          <div className="rounded-2xl border border-dashed bg-white p-6 text-center" style={{ borderColor: 'var(--theme-border)' }}>
            <p className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>No shift assigned yet.</p>
            <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>
              You&apos;re on open attendance — clock in and out whenever you work. Ask HR if you expect a fixed shift.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            <p className="text-base font-semibold" style={{ color: 'var(--theme-text)' }}>{shift.name}</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs" style={{ color: 'var(--theme-muted)' }}>Hours</dt>
                <dd style={{ color: 'var(--theme-text)' }}>{shift.isFlexi ? 'Flexi' : `${shift.startTime || '—'} – ${shift.endTime || '—'}`}</dd>
              </div>
              <div>
                <dt className="text-xs" style={{ color: 'var(--theme-muted)' }}>Weekly off</dt>
                <dd style={{ color: 'var(--theme-text)' }}>{weeklyOff.length ? weeklyOff.join(', ') : '—'}</dd>
              </div>
              {assignment?.assignment && (
                <div className="col-span-2">
                  <dt className="text-xs" style={{ color: 'var(--theme-muted)' }}>Effective</dt>
                  <dd style={{ color: 'var(--theme-text)' }}>
                    {formatDate(assignment.assignment.effectiveFrom)} – {assignment.assignment.effectiveTo ? formatDate(assignment.assignment.effectiveTo) : 'open'}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          Upcoming holidays{countryCode ? ` (${countryCode})` : ''}
        </h2>
        {hLoading ? (
          <Centered><Spinner small /></Centered>
        ) : hError && hError.status !== 404 ? (
          <ErrorBanner message={hError.message || 'Could not load holidays.'} />
        ) : upcoming.length === 0 ? (
          <Empty text="No upcoming holidays on your calendar." />
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            {upcoming.map((h, i) => (
              <li key={h.id || i} className="flex items-center justify-between border-b px-4 py-3 text-sm last:border-b-0" style={{ borderColor: 'var(--theme-border)' }}>
                <span>
                  <span className="block font-medium" style={{ color: 'var(--theme-text)' }}>{h.name}</span>
                  {h.isRestricted && <span className="text-xs text-amber-600">Restricted — optional</span>}
                </span>
                <span className="font-medium" style={{ color: 'var(--theme-muted)' }}>
                  {formatDate(h.observedDate || h.date)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

function AttendanceInner() {
  const me = useSession();
  const empId = employeeIdOf(me);
  const [section, setSection] = useState('clock');

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Attendance</h1>

      {/* Section switcher — keyboard-navigable tablist */}
      <div className="flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--theme-border)' }} role="tablist" aria-label="Attendance sections">
        {SECTIONS.map((s) => {
          const on = s.key === section;
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSection(s.key)}
              className="-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors"
              style={
                on
                  ? { borderBottomColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }
                  : { borderBottomColor: 'transparent', color: 'var(--theme-muted)' }
              }
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {!empId && (
        <ErrorBanner message="We couldn't resolve your employee record. Please contact HR." />
      )}

      {section === 'clock' && <ClockSection empId={empId} />}
      {section === 'timesheet' && <TimesheetSection empId={empId} />}
      {section === 'corrections' && <CorrectionsSection empId={empId} />}
      {section === 'schedule' && <ScheduleSection empId={empId} me={me} />}
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

'use client';

// Attendance (ESS) — monthly "Attendance Details" table is the PRIMARY view, with
// the clock in/out control and regularizations/timesheets/schedule folded into tabs
// (Feature 2). Everything reads the customer-session /api/hr/me/attendance/*
// surface, which resolves the employee SERVER-SIDE from the session — the page
// NEVER sends an employeeId (audit #53/#55).
//
//   Punch        : POST /api/hr/me/attendance/punch        { type, geoLat?, geoLng?, selfieDataUrl? }
//                  (F39 — coords + live selfie are gathered client-side per the
//                   capture policy; 201 may carry captureFlagged/-Reasons, a 403
//                   reason:'CAPTURE_POLICY' means the punch was NOT recorded)
//   Policy       : GET  /api/hr/me/attendance/policy        (F39 — what MY punch must capture)
//   Face         : GET  /api/hr/me/attendance/face          (F39 — my face registration state)
//                  POST /api/hr/me/attendance/face/enroll   { selfieDataUrl } → PENDING (HR approves)
//   Punches      : GET  /api/hr/me/attendance/punches?from=&to=
//   Day rollup   : GET  /api/hr/me/attendance/days?from=&to=   (one row per civil day)
//   Timesheets   : GET  /api/hr/me/attendance/timesheets
//                  GET  /api/hr/me/attendance/timesheets/:id   (per-day entries)
//                  POST /api/hr/me/attendance/timesheets/:id/submit
//   Regularizations : GET  /api/hr/me/attendance/regularizations
//                     POST /api/hr/me/attendance/regularizations
//                     { date, requestedInAt, requestedOutAt, kind, reason }
//                     (the ONE endpoint behind both the tab form and the per-day
//                      "Regularize" button — there is no separate "correction" API)
//   Schedule     : GET  /api/hr/me/attendance/schedule  → { shift, assignment }
//   Holidays     : GET  /api/hr/me/attendance/holidays?year=
//
// The "Attendance Details" table joins the day rollup (authoritative status, shift,
// workedMinutes) with the raw punches (the IN→OUT pairs stacked per cell). For days
// with no rollup row we derive WEEKOFF (shift weekly-off) / HOLIDAY (calendar) /
// ABSENT (past working day) so the month reads as a complete calendar.

import { useMemo, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';
import { useProfile } from '@/lib/useProfile';
import { formatTime, formatDate } from '@/lib/format';
import InfoTip from '@/components/InfoTip';
import CameraCaptureModal from '@/components/CameraCaptureModal';

// ── time helpers ─────────────────────────────────────────────────────────────

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
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Local civil-day key (YYYY-MM-DD) for an instant — buckets punches by the user's
// local day so they line up with the rollup rows.
function localDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Civil-day key for a date-only API value (YYYY-MM-DD…), taken from the string so
// a UTC-midnight Date never slips to the previous local day.
function isoDayKey(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : localDayKey(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(year, month) {
  return `${MONTHS[month].toUpperCase()}-${year}`;
}
function dmy(year, month, day) {
  return `${String(day).padStart(2, '0')}-${String(month + 1).padStart(2, '0')}-${year}`;
}

const PUNCH_LABELS = {
  IN: 'Clocked in',
  OUT: 'Clocked out',
  BREAK_START: 'Break started',
  BREAK_END: 'Break ended',
};

// ── Feature 39 — face & geo capture at punch ─────────────────────────────────

// Friendly labels for the server's captureFlagReasons codes. A FLAGGED punch IS
// recorded — these just explain the "pending HR review" notice in plain words.
const FLAG_LABELS = {
  OUT_OF_GEOFENCE: 'outside your work zone',
  OFF_NETWORK: 'not on an office network',
  FACE_LOW_SCORE: "face didn't match confidently",
  FACE_NEEDS_REVIEW: 'face pending manual review',
  MISSING_GEO: 'location unavailable',
  FACE_NO_REFERENCE: 'no approved face on file',
  FACE_MISSING_SELFIE: 'no selfie captured',
};
function flagReasonLabel(code) {
  return FLAG_LABELS[code] || String(code || '').toLowerCase().replace(/_/g, ' ');
}

// Face registration lifecycle chip (FaceEnrollmentStatus) — semantic hues like
// StatusPill; the HR gate means only ACTIVE actually enables face check-in.
const FACE_STATUS_META = {
  NONE: { label: 'Not registered', cls: 'bg-gray-100 text-gray-600' },
  PENDING: { label: 'Pending HR approval', cls: 'bg-amber-100 text-amber-700' },
  ACTIVE: { label: 'Approved ✓', cls: 'bg-emerald-100 text-emerald-700' },
  REJECTED: { label: 'Rejected', cls: 'bg-red-100 text-red-700' },
  REVOKED: { label: 'Revoked', cls: 'bg-red-100 text-red-700' },
};
function FaceStatusChip({ status }) {
  const m = FACE_STATUS_META[String(status || 'NONE').toUpperCase()] || FACE_STATUS_META.NONE;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

// One chip on the capture strip ("what today's punch needs").
function CaptureChip({ icon, label, title }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)', background: 'var(--theme-primary-soft, #f8fafc)' }}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

// Browser geolocation as a promise. Resolves null on deny/timeout/unavailable —
// the CALLER decides whether that blocks (geoEnforce) or proceeds (server flags
// MISSING_GEO). High accuracy, 10s cap, accepts a fix up to 30s old.
function getBrowserPosition() {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

// Regularization reason types — these mirror the backend REGULARIZATION_KINDS
// (meAttendance.controller.js) one-for-one. A "regularization" (the India-standard
// term) is how an employee fixes a missed or incorrect punch for a day; "correction"
// is just a synonym, surfaced only in the one ⓘ tooltip below.
const REGULARIZATION_KINDS = [
  ['MISSED_PUNCH', 'Missed punch'],
  ['WFH', 'Work from home'],
  ['ON_DUTY', 'On duty'],
  ['LATE_WAIVER', 'Late waiver'],
  ['EARLY_OUT_WAIVER', 'Early-out waiver'],
];

// One-line plain-language explainer reused by every "Regularize" entry point.
const REGULARIZE_HELP =
  'Regularize (also called a correction) = fix a missed or incorrect punch for a day. '
  + 'It goes to your manager for approval.';

const SECTIONS = [
  { key: 'details', label: 'Attendance details' },
  { key: 'clock', label: 'Clock' },
  { key: 'timesheet', label: 'Timesheets' },
  { key: 'regularizations', label: 'Regularizations' },
  { key: 'schedule', label: 'Schedule' },
];

// ── attendance status → display badge ────────────────────────────────────────
// Maps the AttendanceStatus enum (+ a few derived pseudo-statuses) to a clear
// label + semantic hues (green/red/amber/violet/slate/blue) for legibility. The
// page chrome stays theme-driven; status colors are intentionally semantic.
const STATUS_META = {
  PRESENT: { label: 'PRESENT', fg: '#047857', bg: '#ECFDF5', bd: '#A7F3D0' },
  WORK_FROM_HOME: { label: 'WFH', fg: '#047857', bg: '#ECFDF5', bd: '#A7F3D0' },
  ON_DUTY: { label: 'ON DUTY', fg: '#047857', bg: '#ECFDF5', bd: '#A7F3D0' },
  HOLIDAY_WORKED: { label: 'HOLIDAY WORKED', fg: '#047857', bg: '#ECFDF5', bd: '#A7F3D0' },
  HALF_DAY: { label: 'HALF DAY', fg: '#B45309', bg: '#FFFBEB', bd: '#FDE68A' },
  MISSING_PUNCH: { label: 'MISSING PUNCH', fg: '#B45309', bg: '#FFFBEB', bd: '#FDE68A' },
  ON_LEAVE: { label: 'LEAVE', fg: '#6D28D9', bg: '#F5F3FF', bd: '#DDD6FE' },
  ABSENT: { label: 'ABSENT', fg: '#B91C1C', bg: '#FEF2F2', bd: '#FECACA' },
  WEEKLY_OFF: { label: 'WEEKOFF', fg: '#475569', bg: '#F8FAFC', bd: '#E2E8F0' },
  HOLIDAY: { label: 'HOLIDAY', fg: '#1D4ED8', bg: '#EFF6FF', bd: '#BFDBFE' },
  // Before the employee's joining date — not their day. Muted, no action.
  NA: { label: 'NA', fg: '#94A3B8', bg: '#F8FAFC', bd: '#E2E8F0' },
};
function statusMeta(status) {
  return STATUS_META[String(status || '').toUpperCase()] || { label: status || '—', fg: '#475569', bg: '#F8FAFC', bd: '#E2E8F0' };
}
function AttnBadge({ status }) {
  if (!status) return <span style={{ color: 'var(--theme-muted)' }}>—</span>;
  const m = statusMeta(status);
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide"
      style={{ color: m.fg, background: m.bg, border: `1px solid ${m.bd}` }}
    >
      {m.label}
    </span>
  );
}

// ── pair builders ────────────────────────────────────────────────────────────
// Walk a day's punches (ascending) and emit IN→OUT pairs. BREAK_* punches do not
// open/close a worked pair; the pairs are what the table stacks in In/Out cells.
function pairsForDay(punches) {
  const sorted = [...punches].sort((a, b) => new Date(a.punchAt) - new Date(b.punchAt));
  const pairs = [];
  let openIn = null;
  for (const p of sorted) {
    if (p.punchType === 'IN') {
      if (openIn) pairs.push({ in: openIn, out: null }); // unmatched IN before a new IN
      openIn = p.punchAt;
    } else if (p.punchType === 'OUT') {
      pairs.push({ in: openIn, out: p.punchAt });
      openIn = null;
    }
  }
  if (openIn) pairs.push({ in: openIn, out: null }); // still clocked in / missing OUT
  return pairs;
}
// Worked ms across IN→OUT pairs (ignores breaks) — the fallback when the rollup
// carries no workedMinutes.
function workedMsFromPairs(pairs) {
  let total = 0;
  for (const p of pairs) {
    if (p.in && p.out) total += new Date(p.out) - new Date(p.in);
  }
  return total;
}
// HH:MM:SS for the Actual Time column.
function fmtHMS(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtHours(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
// Local HH:MM for an instant — feeds the type="time" prefill on the per-day
// Regularize modal (so the row's existing punches seed the corrected times).
function localHM(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

// ─── Attendance Details (PRIMARY view) ───────────────────────────────────────

const WEEKDAY_ISO = ['0', '1', '2', '3', '4', '5', '6']; // 0=Sun

// Combine a yyyy-mm-dd date and a hh:mm time into an ISO instant for the API.
function toInstant(d, t) {
  if (!d || !t) return undefined;
  const dt = new Date(`${d}T${t}`);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}

// ── RegularizationForm — THE one regularization flow ─────────────────────────
// A single source of truth: the same field set (date, in-time, out-time, reason
// type, reason) + the same submit handler + the same backing endpoint
// (POST /api/hr/me/attendance/regularizations) for BOTH entry points — the
// standalone tab form and the per-day "Regularize" modal. There is no second
// "correction" concept and no second endpoint.
//
//   variant="page"  → standalone form on the Regularizations tab (date is editable).
//   variant="modal" → per-day modal; `lockedDate` pins the date and the caller
//                     prefills in/out from the table row. Renders Cancel + Send.
function RegularizationForm({
  variant = 'page',
  lockedDate = null,        // when set, the date field is fixed (per-day modal)
  initialDate = todayISO(),
  initialInAt = '',
  initialOutAt = '',
  canAct,
  onSubmitted,
  onCancel,
}) {
  const [date, setDate] = useState(lockedDate || initialDate);
  const [inAt, setInAt] = useState(initialInAt);
  const [outAt, setOutAt] = useState(initialOutAt);
  const [kind, setKind] = useState('MISSED_PUNCH');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const effectiveDate = lockedDate || date;

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (!effectiveDate) { setError('Please pick the day to regularize.'); return; }
    if (!reason.trim()) { setError('Please give a reason for this regularization.'); return; }
    setSubmitting(true);
    try {
      await apiPost('/api/hr/me/attendance/regularizations', {
        date: effectiveDate,
        requestedInAt: toInstant(effectiveDate, inAt),
        requestedOutAt: toInstant(effectiveDate, outAt),
        kind,
        reason: reason.trim(),
      });
      setSuccess(true);
      setReason('');
      setInAt('');
      setOutAt('');
      onSubmitted && onSubmitted();
    } catch (err) {
      setError(err.message || 'Could not submit your regularization.');
    } finally {
      setSubmitting(false);
    }
  }

  const isModal = variant === 'modal';
  const inputCls = 'w-full rounded-lg border px-3 py-2 text-sm outline-none';
  const inputStyle = { borderColor: 'var(--theme-border)' };

  // Modal shows a "done" confirmation that swaps out the form; the page form
  // keeps the form mounted (so the employee can raise another) with an inline
  // success note above it.
  if (isModal && success) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Regularization sent to your manager for approval.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="w-full rounded-lg py-2.5 text-sm font-semibold"
          style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <ErrorBanner message={error} />}
      {!isModal && success && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Regularization sent to your manager for approval.
        </p>
      )}

      {/* Date — editable on the tab, pinned (read-only) in the per-day modal. */}
      {lockedDate ? null : (
        <div>
          <label htmlFor="reg-date" className="mb-1 flex items-center text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Date<InfoTip text="The day whose attendance you want to regularize." /></label>
          <input id="reg-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required className={inputCls} style={inputStyle} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="reg-in" className="mb-1 flex items-center text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Corrected in-time<InfoTip text="The clock-in time it should have been. Leave blank if only the out-time was wrong." /></label>
          <input id="reg-in" type="time" value={inAt} onChange={(e) => setInAt(e.target.value)} className={inputCls} style={inputStyle} />
        </div>
        <div>
          <label htmlFor="reg-out" className="mb-1 flex items-center text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Corrected out-time<InfoTip text="The clock-out time it should have been. Leave blank if only the in-time was wrong." /></label>
          <input id="reg-out" type="time" value={outAt} onChange={(e) => setOutAt(e.target.value)} className={inputCls} style={inputStyle} />
        </div>
      </div>
      <div>
        <label htmlFor="reg-kind" className="mb-1 flex items-center text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Reason type<InfoTip text="Why the punch needs fixing — e.g. you forgot to clock in, were on a work-from-home day, or were out on official duty." /></label>
        <select id="reg-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={`${inputCls} bg-white`} style={inputStyle}>
          {REGULARIZATION_KINDS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
        </select>
      </div>
      <div>
        <label htmlFor="reg-reason" className="mb-1 flex items-center text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Reason<InfoTip text="A short explanation for your manager. Required — this is recorded with the request." /></label>
        <textarea
          id="reg-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={isModal ? 3 : 2}
          required
          className={inputCls}
          style={inputStyle}
          placeholder="Why does this day need regularizing?"
        />
      </div>

      {isModal ? (
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border py-2.5 text-sm font-semibold"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !canAct}
            className="flex-1 rounded-lg py-2.5 text-sm font-semibold transition disabled:opacity-50"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {submitting ? 'Sending…' : 'Send request'}
          </button>
        </div>
      ) : (
        <button
          type="submit"
          disabled={submitting || !canAct}
          className="rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50"
          style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
        >
          {submitting ? 'Sending…' : 'Send request'}
        </button>
      )}
    </form>
  );
}

// Per-day "Regularize" modal — a thin chrome wrapper around the ONE
// RegularizationForm. It pins the day's date and prefills the in/out times from
// the table row, then defers entirely to the shared form for fields + submit.
function RegRequestModal({ open, onClose, day, canAct, onSubmitted }) {
  if (!open || !day) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reg-modal-title"
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        className="relative z-10 w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
        style={{ border: '1px solid var(--theme-border)' }}
      >
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 id="reg-modal-title" className="flex items-center text-base font-semibold" style={{ color: 'var(--theme-text)' }}>
              Regularization request
              <InfoTip text={REGULARIZE_HELP} />
            </h3>
            <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>{formatDate(day.key)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-sm"
            style={{ color: 'var(--theme-muted)' }}
          >
            ✕
          </button>
        </div>

        <RegularizationForm
          variant="modal"
          lockedDate={day.key}
          initialInAt={day.prefillInAt || ''}
          initialOutAt={day.prefillOutAt || ''}
          canAct={canAct}
          onSubmitted={onSubmitted}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

function TableSkeleton({ rows = 8 }) {
  return (
    <div className="animate-pulse">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b px-4 py-4" style={{ borderColor: 'var(--theme-border)' }}>
          <div className="h-3 w-20 rounded bg-gray-200" />
          <div className="h-3 w-10 rounded bg-gray-200" />
          <div className="h-3 w-16 rounded bg-gray-200" />
          <div className="h-3 w-16 rounded bg-gray-200" />
          <div className="h-3 w-16 rounded bg-gray-200" />
          <div className="ml-auto h-5 w-16 rounded-full bg-gray-200" />
        </div>
      ))}
    </div>
  );
}

function AttendanceDetailsSection({ canAct }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() }; // month 0-11
  });

  // The employee's date of joining — days before it are not their days, so we
  // show them blank instead of ABSENT (a new joiner has no attendance history).
  // Defensive across the profile shape; null → no guard (safe degradation).
  const { profile } = useProfile();
  const joiningRaw = profile?.employment?.dateOfJoining?.value
    || profile?.professional?.dateOfJoining?.value
    || profile?.dateOfJoining?.value
    || profile?.dateOfJoining
    || null;
  const hireKey = joiningRaw ? String(joiningRaw).slice(0, 10) : null; // YYYY-MM-DD

  const range = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1, 0, 0, 0, 0);
    const last = new Date(cursor.year, cursor.month + 1, 0, 23, 59, 59, 999);
    return { from: first.toISOString(), to: last.toISOString(), first, last };
  }, [cursor]);

  // Authoritative per-day rollup (status, shift, workedMinutes) for the month.
  const daysApi = useApi(
    `/api/hr/me/attendance/days?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
    { select: (b) => (Array.isArray(b) ? b : b?.items || []), deps: [cursor.year, cursor.month] }
  );
  // Raw punches for the IN/OUT pairs.
  const punchesApi = useApi(
    `/api/hr/me/attendance/punches?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&pageSize=200`,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.punches || []), deps: [cursor.year, cursor.month] }
  );
  // Current shift (for the weekly-off derivation + the Shift column default).
  const scheduleApi = useApi('/api/hr/me/attendance/schedule', {
    select: (b) => (b && b.shift ? { shift: b.shift } : null),
  });
  // Holidays for the year (to label HOLIDAY days that have no rollup row).
  const holidaysApi = useApi(`/api/hr/me/attendance/holidays?year=${cursor.year}`, {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.holidays || []),
    deps: [cursor.year],
  });

  const [regDay, setRegDay] = useState(null); // open the modal for this day

  const loading = daysApi.loading || punchesApi.loading;
  const error = (daysApi.error && daysApi.error.status !== 404 && daysApi.error)
    || (punchesApi.error && punchesApi.error.status !== 404 && punchesApi.error)
    || null;

  // Index punches by local civil day.
  const punchesByDay = useMemo(() => {
    const map = {};
    for (const p of punchesApi.data || []) {
      const k = localDayKey(p.punchAt);
      if (!k) continue;
      (map[k] = map[k] || []).push(p);
    }
    return map;
  }, [punchesApi.data]);

  // Index rollup rows by civil day.
  const rollupByDay = useMemo(() => {
    const map = {};
    for (const r of daysApi.data || []) map[isoDayKey(r.date)] = r;
    return map;
  }, [daysApi.data]);

  // Holidays by civil day.
  const holidayByDay = useMemo(() => {
    const map = {};
    for (const h of holidaysApi.data || []) map[isoDayKey(h.observedDate || h.date)] = h;
    return map;
  }, [holidaysApi.data]);

  // Weekly-off ISO weekdays from the current shift (CSV "0,6" → Set).
  const weeklyOff = useMemo(() => {
    const raw = scheduleApi.data?.shift?.weeklyOffDays;
    const arr = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(',').map((x) => x.trim()).filter((x) => x !== '');
    return new Set(arr.map(String));
  }, [scheduleApi.data]);

  const shiftDefaultLabel = scheduleApi.data?.shift
    ? (scheduleApi.data.shift.isNightShift ? 'Night' : 'Day')
    : '—';

  const todayKey = todayISO();

  // Build one row per civil day in the month.
  const rows = useMemo(() => {
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
    const out = [];
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dateObj = new Date(cursor.year, cursor.month, d);
      const key = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isFuture = key > todayKey;
      const rollup = rollupByDay[key] || null;
      const dayPunches = punchesByDay[key] || [];
      const pairs = pairsForDay(dayPunches);
      const holiday = holidayByDay[key] || null;
      const isWeeklyOff = weeklyOff.has(WEEKDAY_ISO[dateObj.getDay()]);

      // Before the joining date the employee didn't exist here → show NA, never ABSENT.
      const isPreJoin = hireKey && key < hireKey;
      // Status precedence: rollup (authoritative) → pre-join NA → holiday →
      // weekly-off → (past working day with no record = ABSENT) → blank for future.
      let status = rollup?.status || null;
      if (!status) {
        if (isPreJoin) status = 'NA';
        else if (holiday) status = 'HOLIDAY';
        else if (isWeeklyOff) status = 'WEEKLY_OFF';
        else if (!isFuture) status = pairs.length ? 'PRESENT' : 'ABSENT';
      }

      // Actual time: prefer the rollup's workedMinutes, else sum the pairs.
      const workedMs = rollup && rollup.workedMinutes != null
        ? rollup.workedMinutes * 60000
        : workedMsFromPairs(pairs);

      // Shift label: rollup's pattern → current-schedule default → off/holiday.
      let shiftLabel = rollup?.shift?.name || null;
      if (!shiftLabel) {
        if (status === 'HOLIDAY') shiftLabel = 'Holiday';
        else if (status === 'WEEKLY_OFF') shiftLabel = 'Weekoff';
        else shiftLabel = shiftDefaultLabel;
      }

      out.push({
        key,
        dmy: dmy(cursor.year, cursor.month, d),
        isFuture,
        status,
        statusKey: String(status || '').toUpperCase(),
        shiftLabel,
        pairs,
        workedMs,
        locked: !!rollup?.isLocked,
        // Seed the per-day Regularize modal with this row's first IN / last OUT.
        prefillInAt: localHM(pairs[0]?.in),
        prefillOutAt: localHM(pairs[pairs.length - 1]?.out),
      });
    }
    return out;
  }, [cursor, rollupByDay, punchesByDay, holidayByDay, weeklyOff, shiftDefaultLabel, todayKey, hireKey]);

  const hasAnyData = rows.some((r) => r.pairs.length || (r.status && r.status !== 'WEEKLY_OFF' && r.status !== 'HOLIDAY'));

  function gotoMonth(delta) {
    setCursor((c) => {
      const m = c.month + delta;
      const year = c.year + Math.floor(m / 12);
      const month = ((m % 12) + 12) % 12;
      return { year, month };
    });
  }
  function gotoThisMonth() {
    const d = new Date();
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
  }
  const isThisMonth = (() => {
    const d = new Date();
    return d.getFullYear() === cursor.year && d.getMonth() === cursor.month;
  })();

  const reload = useCallback(() => {
    daysApi.reload();
    punchesApi.reload();
  }, [daysApi, punchesApi]);

  // Which rows surface a Leave-request deep-link: ABSENT past working days, where
  // applying for leave actually makes sense.
  function showLeaveBtn(r) {
    if (r.isFuture || r.locked) return false;
    return r.statusKey === 'ABSENT';
  }
  // Reg request: any past/today non-locked, non-weekoff/holiday/leave working day.
  function showRegBtn(r) {
    if (r.isFuture || r.locked || !canAct) return false;
    return !['WEEKLY_OFF', 'HOLIDAY', 'ON_LEAVE', 'NA'].includes(r.statusKey);
  }

  return (
    <div className="space-y-4">
      {/* Header: title + month navigator */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>Attendance Details</h2>
          <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
            Your daily attendance for the selected month.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isThisMonth && (
            <button
              type="button"
              onClick={gotoThisMonth}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium transition"
              style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
            >
              This month
            </button>
          )}
          <div
            className="flex items-center gap-1 rounded-xl border bg-white p-1 shadow-sm"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            <button
              type="button"
              onClick={() => gotoMonth(-1)}
              aria-label="Previous month"
              className="rounded-lg px-2.5 py-1.5 text-sm font-semibold transition hover:opacity-80"
              style={{ color: 'var(--theme-primary)' }}
            >
              ◀
            </button>
            <span
              className="min-w-[7.5rem] text-center text-sm font-semibold tabular-nums"
              style={{ color: 'var(--theme-text)' }}
              aria-live="polite"
            >
              {monthLabel(cursor.year, cursor.month)}
            </span>
            <button
              type="button"
              onClick={() => gotoMonth(1)}
              aria-label="Next month"
              className="rounded-lg px-2.5 py-1.5 text-sm font-semibold transition hover:opacity-80"
              style={{ color: 'var(--theme-primary)' }}
            >
              ▶
            </button>
          </div>
        </div>
      </div>

      {error && <ErrorBanner message={error.message || 'Could not load your attendance.'} />}

      {/* The table card */}
      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr style={{ background: 'var(--theme-primary-soft, #f8fafc)' }}>
                {['Date', 'Shift', 'In-Time', 'Out-Time', 'Actual Time', 'Attn. Status', 'Requests'].map((h, i) => (
                  <th
                    key={h}
                    className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide ${i >= 2 && i <= 4 ? 'text-center' : 'text-left'} ${i === 6 ? 'text-right' : ''}`}
                    style={{ color: 'var(--theme-muted)', borderBottom: '1px solid var(--theme-border)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-0">
                    <TableSkeleton />
                  </td>
                </tr>
              ) : !hasAnyData ? (
                <tr>
                  <td colSpan={7}>
                    <div className="px-4 py-14 text-center">
                      <p className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                        No attendance recorded for this month
                      </p>
                      <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
                        Punches and approved leave for {monthLabel(cursor.year, cursor.month)} will appear here.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((r, idx) => {
                  const isToday = r.key === todayKey;
                  const bg = isToday
                    ? 'var(--theme-primary-soft, #eef2ff)'
                    : idx % 2 === 1
                      ? 'color-mix(in srgb, var(--theme-text) 2.5%, transparent)'
                      : 'transparent';
                  const dim = r.isFuture ? 0.45 : 1;
                  return (
                    <tr
                      key={r.key}
                      style={{ background: bg, borderBottom: '1px solid var(--theme-border)', opacity: dim }}
                    >
                      {/* Date */}
                      <td className="whitespace-nowrap px-4 py-3 align-top">
                        <span className="font-medium tabular-nums" style={{ color: 'var(--theme-text)' }}>{r.dmy}</span>
                        {isToday && (
                          <span className="ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                            Today
                          </span>
                        )}
                      </td>
                      {/* Shift */}
                      <td className="whitespace-nowrap px-4 py-3 align-top" style={{ color: 'var(--theme-muted)' }}>
                        {r.shiftLabel}
                      </td>
                      {/* In-Time (stacked) */}
                      <td className="px-4 py-3 text-center align-top">
                        {r.pairs.length ? (
                          <div className="flex flex-col items-center gap-0.5 tabular-nums" style={{ color: 'var(--theme-text)' }}>
                            {r.pairs.map((p, i) => (
                              <span key={i}>{p.in ? formatTime(p.in) : '—'}</span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--theme-muted)' }}>—</span>
                        )}
                      </td>
                      {/* Out-Time (stacked) */}
                      <td className="px-4 py-3 text-center align-top">
                        {r.pairs.length ? (
                          <div className="flex flex-col items-center gap-0.5 tabular-nums" style={{ color: 'var(--theme-text)' }}>
                            {r.pairs.map((p, i) => (
                              <span key={i}>{p.out ? formatTime(p.out) : '—'}</span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--theme-muted)' }}>—</span>
                        )}
                      </td>
                      {/* Actual Time */}
                      <td className="whitespace-nowrap px-4 py-3 text-center align-top tabular-nums" style={{ color: 'var(--theme-text)' }}>
                        {r.workedMs > 0 ? fmtHMS(r.workedMs) : <span style={{ color: 'var(--theme-muted)' }}>—</span>}
                      </td>
                      {/* Status */}
                      <td className="whitespace-nowrap px-4 py-3 align-top">
                        <AttnBadge status={r.status} />
                      </td>
                      {/* Requests */}
                      <td className="whitespace-nowrap px-4 py-3 text-right align-top">
                        <div className="inline-flex items-center gap-2">
                          {showLeaveBtn(r) && (
                            <Link
                              href={`/leave?date=${r.key}`}
                              className="rounded-lg border px-2.5 py-1 text-xs font-medium transition hover:opacity-80"
                              style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-primary)' }}
                            >
                              Leave
                            </Link>
                          )}
                          {showRegBtn(r) && (
                            <button
                              type="button"
                              onClick={() => setRegDay(r)}
                              className="rounded-lg px-2.5 py-1 text-xs font-semibold transition hover:opacity-90"
                              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
                            >
                              Regularize
                            </button>
                          )}
                          {r.locked && (
                            <span className="text-[11px]" style={{ color: 'var(--theme-muted)' }} title="Period locked">Locked</span>
                          )}
                          {!showLeaveBtn(r) && !showRegBtn(r) && !r.locked && (
                            <span style={{ color: 'var(--theme-muted)' }}>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--theme-muted)' }}>
        {['PRESENT', 'ABSENT', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY'].map((s) => (
          <AttnBadge key={s} status={s} />
        ))}
      </div>

      <RegRequestModal
        open={!!regDay}
        day={regDay || { key: todayISO() }}
        canAct={canAct}
        onClose={() => setRegDay(null)}
        onSubmitted={reload}
      />
    </div>
  );
}

// ─── Clock (kept) ────────────────────────────────────────────────────────────

function ClockSection({ canAct }) {
  const from = useMemo(() => startOfPeriod().toISOString(), []);
  const to = useMemo(() => endOfToday().toISOString(), []);

  const { data: punches, loading, error, reload } = useApi(
    `/api/hr/me/attendance/punches?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=200`,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.punches || []) }
  );

  // F39 — the capture policy that applies to ME (drives the capture strip + the
  // punch orchestration below) and my face registration state (the face card).
  // The face detail is only fetched when it can matter: face is required, or a
  // registration already exists (any status).
  const policyApi = useApi('/api/hr/me/attendance/policy', { select: (b) => b || null });
  const policy = policyApi.data || null;
  const faceRelevant = !!policy && (!!policy.requireFace || (policy.faceStatus && policy.faceStatus !== 'NONE'));
  const faceApi = useApi('/api/hr/me/attendance/face', {
    select: (b) => b || null,
    enabled: faceRelevant,
  });
  const face = faceApi.data;
  const faceStatus = String(face?.status || policy?.faceStatus || 'NONE').toUpperCase();

  const all = punches || [];
  const today = useMemo(() => {
    const t0 = startOfToday().getTime();
    return all
      .filter((p) => new Date(p.punchAt).getTime() >= t0)
      .sort((a, b) => new Date(b.punchAt) - new Date(a.punchAt));
  }, [all]);

  const lastType = today[0]?.punchType;
  const isClockedIn = lastType === 'IN' || lastType === 'BREAK_END';

  const periodWorked = useMemo(() => fmtHours(workedMsFromPairs(pairsForDay(all))), [all]);
  const todayWorked = useMemo(() => fmtHours(workedMsFromPairs(pairsForDay(today))), [today]);
  const daysPresent = useMemo(() => new Set(all.map((p) => localDayKey(p.punchAt))).size, [all]);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  // F39 punch-orchestration state.
  const [punchNotice, setPunchNotice] = useState(null);   // 201-but-flagged gentle notice
  const [geoState, setGeoState] = useState(null);         // null|'fetching'|'captured'|'skipped'
  const [cameraPunch, setCameraPunch] = useState(null);   // { type, coords } → face check-in modal open
  const [noFaceConfirm, setNoFaceConfirm] = useState(null); // { type, coords, status } → warn-mode inline confirm
  const [enrollOpen, setEnrollOpen] = useState(false);    // face registration modal
  const [enrollNotice, setEnrollNotice] = useState(null); // "sent to HR" success message
  const [faceHighlight, setFaceHighlight] = useState(false);
  const faceCardRef = useRef(null);

  // Draw the eye to the Face check-in card (used when a punch needs a face the
  // employee hasn't registered / had approved yet).
  function pointToFaceCard(scroll = true) {
    setFaceHighlight(true);
    if (scroll && faceCardRef.current) {
      faceCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setTimeout(() => setFaceHighlight(false), 2500);
  }

  // Bare punch POST — THROWS on failure so each entry point surfaces the error in
  // the right place (page banner vs inside the camera modal, where it enables an
  // immediate retake). A 201 with captureFlagged means the punch WAS recorded but
  // goes to HR's review queue — a gentle notice, not an error. A 403 with
  // reason:'CAPTURE_POLICY' means it was NOT recorded; the server's message says
  // exactly which control blocked it and is shown verbatim.
  async function doPunch(type, coords, selfieDataUrl) {
    const body = { type };
    if (coords) { body.geoLat = coords.lat; body.geoLng = coords.lng; }
    if (selfieDataUrl) body.selfieDataUrl = selfieDataUrl;
    const resp = await apiPost('/api/hr/me/attendance/punch', body);
    if (resp && resp.captureFlagged) {
      const reasons = (resp.captureFlagReasons || []).map(flagReasonLabel).filter(Boolean);
      setPunchNotice(`Punch recorded — pending HR review${reasons.length ? ` (${reasons.join(', ')})` : ''}.`);
    }
    reload();
  }

  // Banner-error variant for the non-modal paths.
  async function submitPunch(type, coords, selfieDataUrl) {
    setBusy(true);
    setActionError(null);
    try {
      await doPunch(type, coords, selfieDataUrl);
    } catch (e) {
      setActionError(e.message || 'Could not record your punch.');
    } finally {
      setBusy(false);
      setGeoState(null);
    }
  }

  // F39 orchestration: gather what the resolved capture policy asks for BEFORE
  // posting — (1) browser geolocation when requireGeo, (2) a live camera selfie
  // when requireFace + the registration is ACTIVE. Everything is best-effort on
  // WARN mode (server records + flags) and blocking on ENFORCE mode. IP needs no
  // client step — the server observes the request IP itself.
  async function punch(type) {
    if (busy) return;
    setActionError(null);
    setPunchNotice(null);
    setNoFaceConfirm(null);

    // 1) Location.
    let coords = null;
    if (policy?.requireGeo) {
      setBusy(true);
      setGeoState('fetching');
      coords = await getBrowserPosition();
      setBusy(false);
      if (!coords) {
        if (policy.geoEnforce) {
          setGeoState(null);
          setActionError('Location is required to punch — enable location access for this site and retry.');
          return;
        }
        setGeoState('skipped'); // server records the punch and flags MISSING_GEO
      } else {
        setGeoState('captured');
      }
    }

    // 2) Face.
    if (policy?.requireFace) {
      if (faceStatus === 'ACTIVE') {
        setCameraPunch({ type, coords }); // camera modal takes over; submit happens on capture
        return;
      }
      // No usable (HR-approved) face yet: PENDING / NONE / REJECTED / REVOKED.
      if (policy.faceEnforce) {
        setGeoState(null);
        if (faceStatus === 'PENDING') {
          setActionError('Your face registration is awaiting HR approval — you can punch once it is approved.');
        } else {
          setActionError('Face check-in is required — register your face first (see the Face check-in card below).');
          pointToFaceCard();
        }
        return;
      }
      // WARN mode → offer to punch without face (server flags it) via an inline confirm.
      setNoFaceConfirm({ type, coords, status: faceStatus });
      if (faceStatus !== 'PENDING') pointToFaceCard(false);
      return;
    }

    await submitPunch(type, coords, null);
  }

  // Inline warn-mode confirm ("punch without face?") — proceed.
  async function punchWithoutFace() {
    const ctx = noFaceConfirm;
    if (!ctx) return;
    setNoFaceConfirm(null);
    await submitPunch(ctx.type, ctx.coords, null);
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

        {/* F39 capture strip — what today's punch must carry (only the required ones). */}
        {policy && (policy.requireGeo || policy.requireIp || policy.requireFace) && (
          <div className="mb-4 space-y-1 text-center">
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <span className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>Punch checks:</span>
              {policy.requireGeo && (
                <CaptureChip
                  icon="📍"
                  label="Location"
                  title={policy.zoneNames?.length ? `Your work zones: ${policy.zoneNames.join(', ')}` : undefined}
                />
              )}
              {policy.requireIp && <CaptureChip icon="🌐" label="Office network" />}
              {policy.requireFace && <CaptureChip icon="🙂" label="Face" />}
            </div>
            {policy.requireGeo && policy.zoneNames?.length > 0 && (
              <p className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>
                Zones: {policy.zoneNames.join(' · ')}
              </p>
            )}
          </div>
        )}

        {actionError && <div className="mb-3"><ErrorBanner message={actionError} /></div>}
        {punchNotice && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{punchNotice}</p>
        )}
        {geoState && (
          <p className="mb-3 text-center text-[11px]" style={{ color: 'var(--theme-muted)' }}>
            {geoState === 'fetching' && '📍 Getting your location…'}
            {geoState === 'captured' && '📍 Location captured ✓'}
            {geoState === 'skipped' && '📍 Location unavailable — punching without it (HR may review).'}
          </p>
        )}

        {/* F39 warn-mode inline confirm: face applies but there's no approved face
            yet — the punch still goes through, flagged for HR review. */}
        {noFaceConfirm && (
          <div className="mb-3 rounded-lg border px-3 py-2.5 text-xs" style={{ borderColor: 'var(--theme-border)' }}>
            <p style={{ color: 'var(--theme-text)' }}>
              {noFaceConfirm.status === 'PENDING'
                ? 'Your face registration is awaiting HR approval.'
                : noFaceConfirm.status === 'REJECTED'
                  ? 'Your face registration was rejected — retake it from the Face check-in card below.'
                  : noFaceConfirm.status === 'REVOKED'
                    ? 'Your face registration was revoked — register again from the Face check-in card below.'
                    : "You haven't registered your face yet — see the Face check-in card below."}
              {' '}You can still punch without face check-in; the punch will be flagged for HR review.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={punchWithoutFace}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 font-semibold transition disabled:opacity-50"
                style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
              >
                Punch without face
              </button>
              <button
                type="button"
                onClick={() => { setNoFaceConfirm(null); setGeoState(null); }}
                className="rounded-lg border px-3 py-1.5 font-medium"
                style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => punch('IN')}
            disabled={busy || !canAct || isClockedIn}
            className="rounded-lg py-3 text-sm font-semibold transition disabled:opacity-50"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {busy ? '…' : 'Clock in'}
          </button>
          <button
            onClick={() => punch('OUT')}
            disabled={busy || !canAct || !isClockedIn}
            className="rounded-lg border py-3 text-sm font-semibold transition disabled:opacity-50"
            style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}
          >
            {busy ? '…' : 'Clock out'}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            onClick={() => punch('BREAK_START')}
            disabled={busy || !canAct || !isClockedIn}
            className="rounded-lg border py-2 text-xs font-medium transition disabled:opacity-50"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
          >
            Start break
          </button>
          <button
            onClick={() => punch('BREAK_END')}
            disabled={busy || !canAct || lastType !== 'BREAK_START'}
            className="rounded-lg border py-2 text-xs font-medium transition disabled:opacity-50"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
          >
            End break
          </button>
        </div>
      </section>

      {/* F39 — Face check-in (registration) card. Shown only when the policy asks
          for face OR a registration already exists in any state. Registration is
          HR-gated: submit → PENDING → HR approves → ACTIVE (only then does the
          punch flow open the face camera). */}
      {policy && (policy.requireFace || faceStatus !== 'NONE') && (
        <section
          ref={faceCardRef}
          className="rounded-2xl border bg-white p-5 shadow-sm transition-shadow"
          style={{
            borderColor: 'var(--theme-border)',
            boxShadow: faceHighlight ? '0 0 0 3px var(--theme-primary)' : undefined,
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
                Face check-in
                <FaceStatusChip status={faceStatus} />
              </h2>
              {faceApi.loading ? (
                <div className="mt-2"><Spinner small /></div>
              ) : (
                <>
                  <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
                    {faceStatus === 'ACTIVE' && 'Approved — your face is checked at every punch.'}
                    {faceStatus === 'PENDING' && 'Sent to HR for approval — face check-in activates once approved.'}
                    {faceStatus === 'REJECTED' && 'HR rejected this photo. Retake it to try again.'}
                    {faceStatus === 'REVOKED' && 'HR revoked your face registration. Register again to re-enable face check-in.'}
                    {faceStatus === 'NONE' && 'Register your face to enable face check-in. HR reviews and approves it before it activates.'}
                  </p>
                  {(faceStatus === 'REJECTED' || faceStatus === 'REVOKED') && face?.decisionNote && (
                    <p className="mt-1 text-xs text-red-600">HR&apos;s note: {face.decisionNote}</p>
                  )}
                </>
              )}
            </div>
            {face?.imageUrl && (
              <img
                src={face.imageUrl}
                alt="Your registered face"
                className="h-14 w-14 flex-shrink-0 rounded-xl border object-cover"
                style={{ borderColor: 'var(--theme-border)' }}
              />
            )}
          </div>

          {enrollNotice && (
            <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{enrollNotice}</p>
          )}

          <button
            type="button"
            onClick={() => { setEnrollNotice(null); setEnrollOpen(true); }}
            disabled={!canAct}
            className="mt-3 rounded-lg px-4 py-2 text-xs font-semibold transition disabled:opacity-50"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {faceStatus === 'NONE' ? 'Register face' : 'Retake'}
          </button>
          {faceStatus === 'ACTIVE' && (
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--theme-muted)' }}>
              Retaking sends the new photo to HR — face check-in pauses until it&apos;s re-approved.
            </p>
          )}
        </section>
      )}

      {/* F39 — face check-in camera at punch time (registration is ACTIVE). The
          submit runs INSIDE the modal so a policy rejection (e.g. face didn't
          match, enforce mode) shows there with an immediate Retake. */}
      {cameraPunch && (
        <CameraCaptureModal
          title="Face check-in"
          hint="Look straight at the camera so we can match your registered face."
          onCapture={async (dataUrl) => {
            await doPunch(cameraPunch.type, cameraPunch.coords, dataUrl); // throws → shown in-modal
            setCameraPunch(null);
            setGeoState(null);
          }}
          onClose={() => { setCameraPunch(null); setGeoState(null); }}
        />
      )}

      {/* F39 — face registration camera. A 422 (no face / too small / multiple
          faces) throws out of onCapture → the modal shows the message and stays
          open for a retake. */}
      {enrollOpen && (
        <CameraCaptureModal
          title="Register your face"
          hint="Look straight at the camera, alone, in good light."
          onCapture={async (dataUrl) => {
            const resp = await apiPost('/api/hr/me/attendance/face/enroll', { selfieDataUrl: dataUrl });
            setEnrollOpen(false);
            setEnrollNotice(resp?.message || 'Face submitted — HR will review and approve it.');
            faceApi.reload();
            policyApi.reload();
          }}
          onClose={() => setEnrollOpen(false)}
        />
      )}

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

// ─── My timesheet (kept) ──────────────────────────────────────────────────────

function TimesheetDetail({ timesheet, onSubmitted }) {
  const { data, loading, error } = useApi(
    `/api/hr/me/attendance/timesheets/${encodeURIComponent(timesheet.id)}`,
    { select: (b) => b }
  );
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const entries = useMemo(() => {
    const e = data?.entries || data?.days || data?.timesheetEntries;
    return Array.isArray(e) ? e : [];
  }, [data]);

  const status = data?.status || timesheet.status;
  const canSubmit = ['DRAFT', 'REJECTED'].includes(String(status || '').toUpperCase());

  async function submit() {
    setBusy(true);
    setSubmitError(null);
    try {
      await apiPost(`/api/hr/me/attendance/timesheets/${encodeURIComponent(timesheet.id)}/submit`, {});
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

function TimesheetSection() {
  const { data: timesheets, loading, error, reload } = useApi(
    '/api/hr/me/attendance/timesheets',
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

// ─── Regularizations (ONE place: raise + history) ─────────────────────────────
// The single regularization surface. The standalone form (RegularizationForm,
// variant="page") and the per-day "Regularize" button on the Attendance details
// table share the SAME component, the SAME submit handler, and the SAME endpoint
// (POST /api/hr/me/attendance/regularizations). The "My regularizations" list
// below shows EVERY request the employee has raised — whether from this form or
// from a per-day button — in one history. "Correction" is only a synonym (ⓘ).
function RegularizationsSection({ canAct }) {
  const { data: requests, loading, error, reload } = useApi(
    '/api/hr/me/attendance/regularizations',
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.requests || []) }
  );

  const list = requests || [];

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <h2 className="mb-1 flex items-center text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
          Regularize a day
          <InfoTip text={REGULARIZE_HELP} />
        </h2>
        <p className="mb-3 text-xs" style={{ color: 'var(--theme-muted)' }}>
          Raise it here for any date, or use the <strong>Regularize</strong> button on a day in the{' '}
          <strong>Attendance details</strong> table — both land in your list below.
        </p>
        <RegularizationForm
          variant="page"
          canAct={canAct}
          onSubmitted={reload}
        />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          My regularizations
        </h2>
        {loading ? (
          <Centered><Spinner small /></Centered>
        ) : error && error.status !== 404 ? (
          <ErrorBanner message={error.message || 'Could not load your regularizations.'} />
        ) : list.length === 0 ? (
          <Empty text="You haven't raised any regularizations yet." />
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            {list.map((r, i) => {
              const kindLabel = REGULARIZATION_KINDS.find(([v]) => v === r.kind)?.[1] || r.kind || 'Regularization';
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

// ─── My schedule + holidays (kept) ────────────────────────────────────────────

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ScheduleSection() {
  const year = new Date().getFullYear();

  // Current shift assignment for the signed-in employee. The backend resolves the
  // employee + the assignment that covers today server-side → { shift, assignment }.
  const { data: assignment, loading: aLoading } = useApi(
    '/api/hr/me/attendance/schedule',
    {
      select: (b) => {
        if (!b || !b.shift) return null;
        return { shift: b.shift, assignment: b.assignment || null };
      },
    }
  );

  // Holidays for the employee's own market — country is resolved server-side from
  // the employee (never a client-derived country).
  const { data: holidays, loading: hLoading, error: hError } = useApi(
    `/api/hr/me/attendance/holidays?year=${year}`,
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
          Upcoming holidays
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
  // The employee is resolved SERVER-SIDE by every /api/hr/me/attendance/* call;
  // we read the profile only to gate the "couldn't resolve your record" banner
  // and to disable write actions when there is genuinely no employee record.
  const { employeeId, loading: profileLoading } = useProfile();
  const canAct = !!employeeId;
  const [section, setSection] = useState('details');

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

      {!profileLoading && !canAct && (
        <ErrorBanner message="We couldn't resolve your employee record. Please contact HR." />
      )}

      {section === 'details' && <AttendanceDetailsSection canAct={canAct} />}
      {section === 'clock' && <ClockSection canAct={canAct} />}
      {section === 'timesheet' && <TimesheetSection />}
      {section === 'regularizations' && <RegularizationsSection canAct={canAct} />}
      {section === 'schedule' && <ScheduleSection />}
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

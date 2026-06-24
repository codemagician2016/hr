'use client';

// Attendance console (Feature 2, Phase 4) against /api/hr/attendance/*.
//
// Tabs:
//  - Dashboard:       GET /summary?from=&to=&groupBy=status — today's status
//                     counts + a present% bar. Data is server-scoped: a Manager
//                     sees only their sub-tree (banner makes that explicit).
//  - Punches:         GET /punches (paginated).
//  - Shifts:          GET/POST/PATCH/DELETE /shifts (full ShiftPattern fields);
//                     row → detail drawer with employee assignment (overlap 409).
//  - Holidays:        GET/POST/DELETE /holidays + POST /holidays/import.
//  - Timesheets:      GET /timesheets with approve/reject (canManageAttendance).
//  - Regularizations: GET /regularizations (real status/decidedBy); approve/reject
//                     only on PENDING. Route uses :requestId, not :id.
//  - Period close:    POST /period/close — preview blockers (409) then lock.
//                     Hidden for operators without canManageAttendance.
//
// All reads/writes are cookie-authed and tenant- + scope-filtered server-side.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ErrorBanner,
  Empty,
  Spinner,
  PrimaryButton,
  TextInput,
  TimeField,
  DateField,
  Modal,
  ModalActions,
  formatAdminDate,
  formatAdminDateTime,
} from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel, ServerPagination } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { useTenantCountries } from '@/lib/useTenantCountries';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';

const PAGE_SIZES = [50, 100];

const BASE_TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'punches', label: 'Punches' },
  { key: 'shifts', label: 'Shifts' },
  { key: 'holidays', label: 'Holidays' },
  { key: 'timesheets', label: 'Timesheets' },
  { key: 'regularizations', label: 'Regularizations' },
];
const CLOSE_TAB = { key: 'close', label: 'Period close' };

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function isoToDateInput(v) {
  if (!v) return '';
  return String(v).slice(0, 10);
}

// ─── Read-only banner shown to operators without canManageAttendance ─────────
function ReadOnlyBanner() {
  return (
    <p className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
      You have read-only access to attendance. Managing shifts, holidays and period close requires the
      <span className="font-medium"> canManageAttendance</span> permission.
    </p>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

// Present-ish statuses for the headline percentage. Spec §3.5 status vocabulary.
const PRESENTISH = new Set(['PRESENT', 'WORK_FROM_HOME', 'ON_DUTY', 'HALF_DAY', 'HOLIDAY_WORKED']);
const STATUS_TONE = {
  PRESENT: 'bg-emerald-500',
  WORK_FROM_HOME: 'bg-teal-500',
  ON_DUTY: 'bg-cyan-500',
  HALF_DAY: 'bg-lime-500',
  HOLIDAY_WORKED: 'bg-green-600',
  ON_LEAVE: 'bg-violet-500',
  HOLIDAY: 'bg-blue-400',
  WEEKLY_OFF: 'bg-slate-400',
  ABSENT: 'bg-red-500',
  MISSING_PUNCH: 'bg-amber-500',
};

function prettyStatus(s) {
  return String(s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Turn the period-close blockers object — { pendingRegularizations, unsubmittedTimesheets }
// — into a normalized list the blocker renderer understands. Only non-zero counts
// surface as actionable rows, each with a `kind` so blockerLink can deep-link the tab (#15).
function blockersFromCounts(counts) {
  if (!counts || typeof counts !== 'object') return [];
  const out = [];
  const reg = Number(counts.pendingRegularizations || 0);
  const ts = Number(counts.unsubmittedTimesheets || 0);
  if (reg > 0) {
    out.push({
      kind: 'regularization',
      count: reg,
      label: `${reg} pending regularization${reg === 1 ? '' : 's'} awaiting a decision`,
    });
  }
  if (ts > 0) {
    out.push({
      kind: 'timesheet',
      count: ts,
      label: `${ts} unsubmitted timesheet${ts === 1 ? '' : 's'} in this range`,
    });
  }
  return out;
}

// Normalise the /summary payload into [{ status, count, lopDays }]. The server
// returns { groupBy:'status', total, buckets:[{ key, count, lopDays, overtimeMinutes }] }
// — map b.key → status (#14). We stay tolerant of a few legacy shapes (array,
// { items }, { counts:{} } map) so a payload change never blanks the dashboard.
function normaliseCounts(res) {
  if (!res) return [];
  if (Array.isArray(res.buckets)) {
    return res.buckets.map((b) => ({
      status: b.key ?? b.status,
      count: Number(b.count ?? b.total ?? 0),
      lopDays: b.lopDays != null ? Number(b.lopDays) : 0,
    }));
  }
  if (Array.isArray(res)) return res.map((r) => ({ status: r.status, count: Number(r.count ?? r.total ?? 0), lopDays: Number(r.lopDays ?? 0) }));
  if (Array.isArray(res.items)) return res.items.map((r) => ({ status: r.status, count: Number(r.count ?? r.total ?? 0), lopDays: Number(r.lopDays ?? 0) }));
  const map = res.counts || res.byStatus || res.summary;
  if (map && typeof map === 'object') {
    return Object.entries(map).map(([status, count]) => ({ status, count: Number(count) || 0, lopDays: 0 }));
  }
  return [];
}

function DashboardTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [scoped, setScoped] = useState(false); // true → manager (TEAM/DEPARTMENT) → show team banner

  useEffect(() => {
    const day = todayISO();
    setLoading(true);
    Promise.all([
      get('/api/hr/attendance/summary', { from: day, to: day, groupBy: 'status' }),
      get('/api/auth/me').catch(() => null),
    ])
      .then(([res, me]) => {
        setData(res);
        const session = me?.user || me;
        const band = String(session?.businessRole?.defaultScope || '').toUpperCase();
        setScoped(band === 'TEAM' || band === 'DEPARTMENT' || band === 'SELF');
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load the attendance summary.'))
      .finally(() => setLoading(false));
  }, []);

  const counts = useMemo(() => normaliseCounts(data), [data]);
  // LOP is reported per-bucket on the /summary payload; total it across statuses
  // (the server never sends a top-level data.lopDays — #14).
  const lopDays = useMemo(() => {
    if (!counts.length) return null;
    const sum = counts.reduce((s, c) => s + (Number(c.lopDays) || 0), 0);
    return Math.round(sum * 100) / 100;
  }, [counts]);

  const total = counts.reduce((s, c) => s + c.count, 0);
  const present = counts.filter((c) => PRESENTISH.has(String(c.status).toUpperCase())).reduce((s, c) => s + c.count, 0);
  const presentPct = total > 0 ? Math.round((present / total) * 100) : 0;
  const sorted = [...counts].sort((a, b) => b.count - a.count);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error} />}

      {scoped && (
        <p className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          Showing your team. Figures cover only the people in your reporting sub-tree.
        </p>
      )}

      {total === 0 && !error ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-gray-900">No attendance recorded for today yet.</p>
          <p className="text-sm text-gray-500 mt-1">
            Counts appear here as punches are derived through the day{scoped ? ' for your team' : ''}.
          </p>
        </div>
      ) : (
        <>
          {/* Present% headline + bar */}
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-end justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Present today</h2>
                <p className="text-xs text-gray-500">{present} of {total} {total === 1 ? 'person' : 'people'} present-equivalent</p>
              </div>
              <div className="text-3xl font-semibold" style={{ color: 'var(--theme-primary)' }}>
                {presentPct}%
              </div>
            </div>
            <div
              className="h-3 w-full rounded-full bg-gray-100 overflow-hidden"
              role="progressbar"
              aria-label="Present today"
              aria-valuenow={presentPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full rounded-full transition-all" style={{ width: `${presentPct}%`, backgroundColor: 'var(--theme-primary)' }} />
            </div>
          </section>

          {/* Status breakdown — dependency-free flex bars */}
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">By status</h2>
            <ul className="space-y-2.5">
              {sorted.map((c) => {
                const pct = total > 0 ? Math.round((c.count / total) * 100) : 0;
                const tone = STATUS_TONE[String(c.status).toUpperCase()] || 'bg-gray-400';
                return (
                  <li key={c.status} className="flex items-center gap-3 text-sm">
                    <span className="w-36 shrink-0 text-gray-700">{prettyStatus(c.status)}</span>
                    <span className="flex-1 h-2.5 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
                      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(pct, c.count > 0 ? 4 : 0)}%` }} />
                    </span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-gray-900 font-medium">{c.count}</span>
                    <span className="w-10 shrink-0 text-right tabular-nums text-gray-400 text-xs">{pct}%</span>
                  </li>
                );
              })}
            </ul>
            {lopDays != null && (
              <p className="mt-4 text-xs text-gray-500">
                Loss-of-pay accrued in range: <span className="font-medium text-gray-700">{lopDays}</span> day{lopDays === 1 ? '' : 's'}.
              </p>
            )}
          </section>
          <p className="text-xs text-gray-400">
            Server-authoritative counts for {formatAdminDate(todayISO())}.
          </p>
        </>
      )}
    </div>
  );
}

// ─── Punches ─────────────────────────────────────────────────────────────────

function PunchesTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);

  useEffect(() => {
    setLoading(true);
    get('/api/hr/attendance/punches', { page, pageSize })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load punches.'))
      .finally(() => setLoading(false));
  }, [page, pageSize]);

  const items = asList(data);
  const total = data?.total ?? items.length;

  const columns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
    { key: 'direction', header: 'Type', render: (r) => r.punchType || r.direction || r.type || '—' },
    { key: 'at', header: 'Time', render: (r) => formatAdminDateTime(r.punchAt || r.punchedAt || r.timestamp || r.at) },
    { key: 'source', header: 'Source', render: (r) => r.source || r.method || '—' },
  ];

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No punches recorded." />
      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun="punches"
        onPageChange={setPage}
        onPageSizeChange={(ps) => { setPage(1); setPageSize(ps); }}
      />
    </div>
  );
}

// ─── Shifts (full ShiftPattern fields) + assignment drawer ──────────────────

// Field groups for the shift editor. Booleans render as checkboxes, the rest as
// number/text/time inputs. weeklyOffDays is a CSV of 0=Sun..6=Sat.
const NUMBER_FIELDS = [
  ['breakMinutes', 'Break minutes'],
  ['graceInMinutes', 'Grace in (min)'],
  ['graceOutMinutes', 'Grace out (min)'],
  ['fullDayMinutes', 'Full-day minutes'],
  ['halfDayThresholdMinutes', 'Half-day threshold (min)'],
  ['minMinutesForPresent', 'Min minutes for present'],
  ['dailyOtThresholdMin', 'Daily OT threshold (min)'],
];
const BOOL_FIELDS = [
  ['isActive', 'Active'],
  ['isFlexi', 'Flexi (no fixed start/end)'],
  ['isNightShift', 'Night shift'],
  ['crossesMidnight', 'Crosses midnight'],
  ['otEligible', 'Overtime eligible'],
];
const WEEKDAYS = [
  ['0', 'Sun'],
  ['1', 'Mon'],
  ['2', 'Tue'],
  ['3', 'Wed'],
  ['4', 'Thu'],
  ['5', 'Fri'],
  ['6', 'Sat'],
];

const EMPTY_SHIFT = {
  name: '',
  code: '',
  startTime: '',
  endTime: '',
  entityId: '',
  breakMinutes: '',
  graceInMinutes: '',
  graceOutMinutes: '',
  fullDayMinutes: '',
  halfDayThresholdMinutes: '',
  minMinutesForPresent: '',
  dailyOtThresholdMin: '',
  weeklyOffDays: '0', // Sunday off by default
  isActive: true,
  isFlexi: false,
  isNightShift: false,
  crossesMidnight: false,
  otEligible: false,
};

function shiftToDraft(s) {
  if (!s) return { ...EMPTY_SHIFT };
  const d = { ...EMPTY_SHIFT };
  for (const k of Object.keys(EMPTY_SHIFT)) {
    if (s[k] === undefined || s[k] === null) continue;
    d[k] = s[k];
  }
  // weeklyOffDays may come back as an array — normalise to CSV.
  if (Array.isArray(s.weeklyOffDays)) d.weeklyOffDays = s.weeklyOffDays.join(',');
  else if (s.weeklyOffDays != null) d.weeklyOffDays = String(s.weeklyOffDays);
  return d;
}

// Build the POST/PATCH payload: numbers parsed, blanks dropped, booleans kept.
function shiftPayload(draft) {
  const out = {};
  for (const [k, v] of Object.entries(draft)) {
    if (typeof v === 'boolean') {
      out[k] = v;
      continue;
    }
    if (v === '' || v === null || v === undefined) continue;
    if (NUMBER_FIELDS.some(([key]) => key === k)) {
      const n = Number(v);
      if (!Number.isNaN(n)) out[k] = n;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function ShiftEditor({ shift, canManage, onClose, onSaved }) {
  const isNew = !shift;
  const [draft, setDraft] = useState(() => shiftToDraft(shift));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const readOnly = !canManage;

  function set(k, v) {
    setDraft((d) => ({ ...d, [k]: v }));
  }
  function toggleWeekly(dayValue) {
    const set = new Set(String(draft.weeklyOffDays || '').split(',').map((x) => x.trim()).filter(Boolean));
    if (set.has(dayValue)) set.delete(dayValue);
    else set.add(dayValue);
    setDraft((d) => ({ ...d, weeklyOffDays: [...set].sort().join(',') }));
  }

  async function save() {
    if (readOnly) return;
    setSaving(true);
    setError('');
    try {
      const payload = shiftPayload(draft);
      if (isNew) await post('/api/hr/attendance/shifts', payload);
      else await patch(`/api/hr/attendance/shifts/${shift.id}`, payload);
      onSaved();
    } catch (e) {
      // 409 = duplicate code; surface inline per spec §5.1.
      setError(e.data?.message || (e.status === 409 ? 'A shift with this code already exists.' : e.message) || 'Failed to save shift.');
      setSaving(false);
    }
  }

  const weeklyOffSet = new Set(String(draft.weeklyOffDays || '').split(',').map((x) => x.trim()).filter(Boolean));

  return (
    <Modal title={isNew ? 'New shift pattern' : readOnly ? draft.name || 'Shift pattern' : `Edit ${draft.name || 'shift'}`} onClose={onClose} size="lg">
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {readOnly && (
        <p className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Read-only — you don&apos;t have permission to edit shift patterns.
        </p>
      )}

      <div className="grid sm:grid-cols-2 gap-4 mb-4">
        <TextInput label="Name" value={draft.name} onChange={readOnly ? () => {} : (v) => set('name', v)} required />
        <TextInput label="Code" value={draft.code} onChange={readOnly ? () => {} : (v) => set('code', v)} hint="Unique per tenant" />
        <TimeField label="Start time" value={draft.startTime} onChange={readOnly ? () => {} : (v) => set('startTime', v)} />
        <TimeField label="End time" value={draft.endTime} onChange={readOnly ? () => {} : (v) => set('endTime', v)} />
        <TextInput label="Entity ID" value={draft.entityId} onChange={readOnly ? () => {} : (v) => set('entityId', v)} hint="Optional — scopes the pattern to one legal entity" />
      </div>

      <fieldset className="mb-4">
        <legend className="text-sm font-medium text-gray-700 mb-2">Derivation thresholds</legend>
        <div className="grid sm:grid-cols-2 gap-4">
          {NUMBER_FIELDS.map(([key, label]) => (
            <TextInput
              key={key}
              label={label}
              type="number"
              min={0}
              value={draft[key] === '' ? '' : String(draft[key])}
              onChange={readOnly ? () => {} : (v) => set(key, v)}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="mb-4">
        <legend className="text-sm font-medium text-gray-700 mb-2">Weekly off days</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map(([value, label]) => {
            const on = weeklyOffSet.has(value);
            return (
              <button
                key={value}
                type="button"
                onClick={readOnly ? undefined : () => toggleWeekly(value)}
                aria-pressed={on}
                disabled={readOnly}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors disabled:opacity-60 ${
                  on ? 'border-transparent text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
                style={on ? { backgroundColor: 'var(--theme-primary)' } : undefined}
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="mb-5">
        <legend className="text-sm font-medium text-gray-700 mb-2">Flags</legend>
        <div className="grid sm:grid-cols-2 gap-2">
          {BOOL_FIELDS.map(([key, label]) => (
            <label key={key} className={`flex items-center gap-2 text-sm ${readOnly ? '' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={!!draft[key]}
                onChange={readOnly ? undefined : (e) => set(key, e.target.checked)}
                disabled={readOnly}
              />
              <span className="text-gray-800">{label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <ModalActions>
        <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <PrimaryButton loading={saving} onClick={save} disabled={!draft.name?.trim()}>
            {isNew ? 'Create shift' : 'Save changes'}
          </PrimaryButton>
        )}
      </ModalActions>
    </Modal>
  );
}

// Employee picker — click to browse the directory, filter by name/code/email.
// Thin wrapper over the reusable EmployeeSearchSelect; keeps this page's
// { value: employee|null, onChange: (employee|null) } contract.
function EmployeePicker({ value, onChange }) {
  return (
    <EmployeeSearchSelect
      label="Employee"
      tip="Click to browse the directory, then filter by name, code or work email."
      value={value?.id || ''}
      selectedLabel={value ? employeeLabel(value) : ''}
      onSelect={(emp) => onChange(emp || null)}
      placeholder="Search by name, code or email…"
    />
  );
}

function ShiftDetailDrawer({ shiftId, canManage, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Assignment form
  const [emp, setEmp] = useState(null);
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`/api/hr/attendance/shifts/${shiftId}`)
      .then(setDetail)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load shift.'))
      .finally(() => setLoading(false));
  }, [shiftId]);

  useEffect(() => {
    load();
  }, [load]);

  async function assign(e) {
    e.preventDefault();
    if (!emp?.id) {
      setAssignError('Pick an employee first.');
      return;
    }
    setAssigning(true);
    setAssignError('');
    try {
      await post(`/api/hr/attendance/shifts/${shiftId}/assign`, {
        employeeId: emp.id,
        shiftPatternId: shiftId,
        effectiveFrom: from,
        effectiveTo: to || undefined,
      });
      setEmp(null);
      setFrom(todayISO());
      setTo('');
      load();
    } catch (err) {
      // 409 = overlapping assignment for this employee.
      setAssignError(
        err.data?.message ||
          (err.status === 409 ? 'This employee already has an overlapping assignment for that date range.' : err.message) ||
          'Failed to assign.'
      );
    } finally {
      setAssigning(false);
    }
  }

  const list = Array.isArray(detail?.assignments) ? detail.assignments : asList(detail?.assignments);

  return (
    <Modal title={detail?.name ? `${detail.name} — assignments` : 'Shift assignments'} onClose={onClose} size="lg">
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : (
        <>
          {canManage ? (
            <form onSubmit={assign} className="rounded-xl border border-gray-200 bg-gray-50 p-4 mb-5 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900">Assign an employee</h3>
              {assignError && <ErrorBanner message={assignError} />}
              <EmployeePicker value={emp} onChange={setEmp} />
              <div className="grid sm:grid-cols-2 gap-3">
                <DateField label="Effective from" value={from} onChange={setFrom} required />
                <DateField label="Effective to" value={to} onChange={setTo} hint="Leave blank for open-ended" />
              </div>
              <PrimaryButton type="submit" loading={assigning} disabled={!emp}>
                Assign employee
              </PrimaryButton>
            </form>
          ) : (
            <p className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Read-only — assigning employees requires canManageAttendance.
            </p>
          )}

          <h3 className="text-sm font-semibold text-gray-900 mb-2">Current assignments</h3>
          {!list || list.length === 0 ? (
            <Empty text="No employees assigned to this shift yet." />
          ) : (
            <ul className="rounded-xl border border-gray-200 divide-y divide-gray-100">
              {list.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="font-medium text-gray-900">{employeeLabel(a)}</span>
                  <span className="text-gray-500">
                    {formatAdminDate(a.effectiveFrom)} – {a.effectiveTo ? formatAdminDate(a.effectiveTo) : 'open'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}

function ShiftsTab({ canManage }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(undefined); // undefined closed | null new | obj edit
  const [detailId, setDetailId] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(() => {
    setError('');
    get('/api/hr/attendance/shifts')
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.data?.message || e.message || 'Failed to load shifts.');
        setRows([]);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmDelete() {
    try {
      await del(`/api/hr/attendance/shifts/${deleting.id}`);
      setDeleting(null);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete shift.');
      setDeleting(null);
    }
  }

  const columns = [
    { key: 'name', header: 'Shift', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => r.code || '—' },
    { key: 'window', header: 'Window', render: (r) => (r.isFlexi ? 'Flexi' : `${r.startTime || '—'} – ${r.endTime || '—'}`) },
    {
      key: 'flags',
      header: 'Flags',
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.isNightShift && <span className="rounded bg-indigo-50 text-indigo-700 px-1.5 py-0.5 text-[11px]">Night</span>}
          {r.otEligible && <span className="rounded bg-emerald-50 text-emerald-700 px-1.5 py-0.5 text-[11px]">OT</span>}
          {r.isActive === false && <span className="rounded bg-gray-100 text-gray-500 px-1.5 py-0.5 text-[11px]">Inactive</span>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cellClassName: 'text-right whitespace-nowrap',
      render: (r) => (
        <div className="inline-flex gap-2">
          <ActionButton onClick={() => setDetailId(r.id)}>Assignments</ActionButton>
          <ActionButton onClick={() => setEditing(r)}>{canManage ? 'Edit' : 'View'}</ActionButton>
          {canManage && (
            <ActionButton tone="danger" onClick={() => setDeleting(r)}>
              Delete
            </ActionButton>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      {!canManage && <ReadOnlyBanner />}
      {canManage && (
        <div className="flex justify-end mb-4">
          <PrimaryButton onClick={() => setEditing(null)}>New shift</PrimaryButton>
        </div>
      )}
      <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No shifts defined." />

      {editing !== undefined && (
        <ShiftEditor
          shift={editing}
          canManage={canManage}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}
      {detailId && <ShiftDetailDrawer shiftId={detailId} canManage={canManage} onClose={() => setDetailId(null)} />}
      {deleting && (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}>
          <p className="text-sm text-gray-600 mb-5">
            This shift pattern will be removed. Employees currently assigned to it lose their schedule until reassigned.
          </p>
          <ModalActions>
            <button type="button" onClick={() => setDeleting(null)} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="button" onClick={confirmDelete} className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-red-600 hover:bg-red-700">
              Delete shift
            </button>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

// ─── Holidays ────────────────────────────────────────────────────────────────

const COUNTRY_OPTIONS = [
  ['', 'All countries'],
  ['IN', 'India'],
];

function HolidayForm({ defaults, canManage, countries = [], onClose, onSaved }) {
  // Default the country to the tenant's own when single-country. The tenant operates
  // in exactly ONE HR country (Feature 14), so single-country is the norm; multi/unknown
  // falls back to any passed default, else blank (operator must choose).
  const single = Array.isArray(countries) && countries.length === 1;
  const defaultCountry = defaults.countryCode || (single ? countries[0] : '');
  const [draft, setDraft] = useState({
    name: '',
    date: '',
    countryCode: defaultCountry,
    type: 'PUBLIC',
    isRestricted: false,
    entityId: defaults.entityId || '',
    locationId: defaults.locationId || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function set(k, v) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(
        Object.entries(draft).filter(([, v]) => v !== '' && v !== null && v !== undefined)
      );
      await post('/api/hr/attendance/holidays', payload);
      onSaved();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to add holiday.');
      setSaving(false);
    }
  }

  return (
    <Modal title="Add holiday" onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      <div className="space-y-4">
        <TextInput label="Holiday name" value={draft.name} onChange={(v) => set('name', v)} required />
        <DateField label="Date" value={draft.date} onChange={(v) => set('date', v)} required />
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="hol-country">Country</label>
            <select
              id="hol-country"
              value={draft.countryCode}
              onChange={(e) => set('countryCode', e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white"
            >
              {/* Offer only the tenant's operating country (no cross-country leak).
                  Falls back to India alone — the product is single-country India. */}
              {(single ? [] : [['', 'Select…']]).map(([v, l]) => <option key="blank" value={v}>{l}</option>)}
              {(Array.isArray(countries) && countries.length ? countries : ['IN']).map((cc) => (
                <option key={cc} value={cc}>{cc === 'IN' ? 'India' : cc}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="hol-type">Type</label>
            <select
              id="hol-type"
              value={draft.type}
              onChange={(e) => set('type', e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="PUBLIC">Public</option>
              <option value="RESTRICTED">Restricted / optional</option>
            </select>
          </div>
          <TextInput label="Entity ID" value={draft.entityId} onChange={(v) => set('entityId', v)} hint="Optional scope" />
          <TextInput label="Location ID" value={draft.locationId} onChange={(v) => set('locationId', v)} hint="Optional scope" />
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={draft.isRestricted} onChange={(e) => set('isRestricted', e.target.checked)} />
          <span className="text-gray-800">Restricted (employee may opt in)</span>
        </label>
      </div>
      <ModalActions>
        <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
          Cancel
        </button>
        <PrimaryButton loading={saving} onClick={save} disabled={!draft.name.trim() || !draft.date}>
          Add holiday
        </PrimaryButton>
      </ModalActions>
    </Modal>
  );
}

function ImportHolidaysModal({ year, countries = [], onClose, onDone }) {
  // Offer/seed only the tenant's operating country. The product is single-country
  // India (Feature 14); when the tenant's country set is unknown, fall back to
  // India alone — never any other country.
  const importCountries = Array.isArray(countries) && countries.length ? countries : ['IN'];
  const [countryCode, setCountryCode] = useState(importCountries[0]);
  const [importYear, setImportYear] = useState(String(year));
  const [entityId, setEntityId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const res = await post('/api/hr/attendance/holidays/import', {
        countryCode,
        year: Number(importYear),
        entityId: entityId || undefined,
      });
      setResult(res);
      onDone();
    } catch (e) {
      setError(e.data?.message || e.message || 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  // The import returns { total, created, updated } (#20). Headline the new rows
  // (created), falling back to total/updated; surface the updated count too so a
  // re-run reads clearly ("0 new, N already present") rather than a blank.
  const createdCount = result?.created ?? result?.total ?? result?.imported ?? null;
  const updatedCount = result?.updated ?? null;

  return (
    <Modal title="Import statutory holiday set" onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            Imported {createdCount != null ? createdCount : 'the'} statutory holiday{createdCount === 1 ? '' : 's'} for {countryCode} {importYear}
            {updatedCount != null && updatedCount > 0 ? ` (${updatedCount} already present, left unchanged)` : ''}.
          </p>
          <p className="text-xs text-gray-500">
            Re-running is safe — existing holidays are de-duplicated, not doubled.
          </p>
          <ModalActions>
            <PrimaryButton onClick={onClose}>Done</PrimaryButton>
          </ModalActions>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Seeds the official India public-holiday set (national + restricted/optional) for the chosen year.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="imp-country">Country</label>
              <select
                id="imp-country"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white"
              >
                {importCountries.map((cc) => (
                  <option key={cc} value={cc}>{cc === 'IN' ? 'India' : cc}</option>
                ))}
              </select>
            </div>
            <TextInput label="Year" type="number" value={importYear} onChange={setImportYear} />
          </div>
          <TextInput label="Entity ID" value={entityId} onChange={setEntityId} hint="Optional — restrict the import to one entity" />
          <ModalActions>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <PrimaryButton loading={busy} onClick={run}>
              Import {countryCode} {importYear}
            </PrimaryButton>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

function HolidaysTab({ canManage }) {
  const thisYear = new Date().getFullYear();
  // The tenant's operating country (Feature 14) gates the country filter + add/import
  // forms so the tenant is only ever shown its own country (India).
  const { countries } = useTenantCountries();
  const [year, setYear] = useState(thisYear);
  const [countryCode, setCountryCode] = useState('');
  const [entityId, setEntityId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(() => {
    setError('');
    setRows(null);
    get('/api/hr/attendance/holidays', { year, countryCode, entityId, locationId })
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.data?.message || e.message || 'Failed to load holidays.');
        setRows([]);
      });
  }, [year, countryCode, entityId, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmDelete() {
    try {
      await del(`/api/hr/attendance/holidays/${deleting.id}`);
      setDeleting(null);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete holiday.');
      setDeleting(null);
    }
  }

  const yearOptions = [];
  for (let y = thisYear - 2; y <= thisYear + 2; y += 1) yearOptions.push(y);

  const columns = [
    { key: 'date', header: 'Date', render: (r) => formatAdminDate(r.date) },
    { key: 'name', header: 'Holiday', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'country', header: 'Country', render: (r) => r.countryCode || '—' },
    { key: 'type', header: 'Type', render: (r) => r.type || '—' },
    {
      key: 'flags',
      header: 'Flags',
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.isRestricted && <span className="rounded bg-amber-50 text-amber-700 px-1.5 py-0.5 text-[11px]">Restricted</span>}
          {r.observedDate && r.observedDate !== r.date && (
            <span className="rounded bg-blue-50 text-blue-700 px-1.5 py-0.5 text-[11px]">
              Observed {formatAdminDate(r.observedDate)}
            </span>
          )}
          {r.isMondayised && <span className="rounded bg-blue-50 text-blue-700 px-1.5 py-0.5 text-[11px]">Mondayised</span>}
        </div>
      ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            className: 'text-right',
            cellClassName: 'text-right whitespace-nowrap',
            render: (r) => (
              <ActionButton tone="danger" onClick={() => setDeleting(r)}>
                Delete
              </ActionButton>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      {!canManage && <ReadOnlyBanner />}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="hol-year">Year</label>
          <select
            id="hol-year"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="hol-filter-country">Country</label>
          <select
            id="hol-filter-country"
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
          >
            {COUNTRY_OPTIONS
              .filter(([v]) => v === '' || !Array.isArray(countries) || countries.length === 0 || countries.includes(v))
              .map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="hol-filter-entity">Entity ID</label>
          <input
            id="hol-filter-entity"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="any"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-32"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="hol-filter-location">Location ID</label>
          <input
            id="hol-filter-location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            placeholder="any"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-32"
          />
        </div>
        {canManage && (
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Import statutory set
            </button>
            <PrimaryButton onClick={() => setAdding(true)}>Add holiday</PrimaryButton>
          </div>
        )}
      </div>

      <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No holidays for this filter." />

      {adding && (
        <HolidayForm
          defaults={{ countryCode: countryCode || '', entityId, locationId }}
          canManage={canManage}
          countries={countries}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
      {importing && (
        <ImportHolidaysModal year={year} countries={countries} onClose={() => setImporting(false)} onDone={load} />
      )}
      {deleting && (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}>
          <p className="text-sm text-gray-600 mb-5">This holiday will be removed from the calendar for the selected scope.</p>
          <ModalActions>
            <button type="button" onClick={() => setDeleting(null)} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="button" onClick={confirmDelete} className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-red-600 hover:bg-red-700">
              Delete holiday
            </button>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

// ─── Approval lists (timesheets + regularizations) ──────────────────────────

function ApprovalListTab({ endpoint, idField, pending, columnsFor, emptyText, noun }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`/api/hr/attendance/${endpoint}`, { page, pageSize })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load.'))
      .finally(() => setLoading(false));
  }, [endpoint, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  const items = asList(data);
  const total = data?.total ?? items.length;

  async function decide(row, action) {
    const id = row[idField] || row.id;
    setBusyId(id);
    setError('');
    try {
      await post(`/api/hr/attendance/${endpoint}/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action}.`);
    } finally {
      setBusyId('');
    }
  }

  const columns = [
    ...columnsFor(),
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cellClassName: 'text-right',
      render: (r) => {
        const id = r[idField] || r.id;
        const isPending = String(r.status || pending).toUpperCase() === String(pending).toUpperCase();
        if (!isPending) return null;
        return (
          <div className="inline-flex gap-2">
            <ActionButton tone="positive" disabled={busyId === id} onClick={() => decide(r, 'approve')}>
              Approve
            </ActionButton>
            <ActionButton tone="danger" disabled={busyId === id} onClick={() => decide(r, 'reject')}>
              Reject
            </ActionButton>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        emptyText={emptyText || 'Nothing awaiting action.'}
        rowKey={(r) => r[idField] || r.id}
      />
      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun={noun || 'rows'}
        onPageChange={setPage}
        onPageSizeChange={(ps) => { setPage(1); setPageSize(ps); }}
      />
    </div>
  );
}

// ─── Period close ────────────────────────────────────────────────────────────

function PeriodCloseTab() {
  const monthStart = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  }, []);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO());
  const [entityId, setEntityId] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | checking | blocked | ready | locking | done
  const [blockers, setBlockers] = useState([]);
  const [wouldLock, setWouldLock] = useState(null); // rows that would be frozen
  const [error, setError] = useState('');

  // Preview: the dry-run (confirm:false) returns 200 with the real blocker counts
  // — { blockers:{pendingRegularizations,unsubmittedTimesheets}, wouldLock, canClose }
  // — it never throws a 409 (#15). Read canClose to branch: false → blocked (build
  // the blocker list from the counts), true → ready to lock. We still defend the
  // 409 path in case an older backend short-circuits to it.
  async function preview() {
    setPhase('checking');
    setError('');
    setBlockers([]);
    setWouldLock(null);
    try {
      const res = await post('/api/hr/attendance/period/close', { from, to, entityId: entityId || undefined, confirm: false });
      setWouldLock(res?.wouldLock ?? null);
      if (res?.canClose === false) {
        setBlockers(blockersFromCounts(res?.blockers));
        setPhase('blocked');
      } else {
        // canClose === true (or an older 200 with no counts) → ready for an explicit lock.
        setPhase('ready');
      }
    } catch (e) {
      // Legacy fallback: a 409 with the same blockers object (or a list).
      if (e.status === 409) {
        const raw = e.data?.blockers || e.data?.issues || e.data?.errors;
        const list = Array.isArray(raw) ? raw : blockersFromCounts(raw);
        setBlockers(list);
        setPhase('blocked');
        if (list.length === 0) setError(e.data?.message || 'The period cannot be closed yet.');
      } else {
        setError(e.data?.message || e.message || 'Failed to check the period.');
        setPhase('idle');
      }
    }
  }

  async function lock() {
    setPhase('locking');
    setError('');
    try {
      await post('/api/hr/attendance/period/close', { from, to, entityId: entityId || undefined, confirm: true });
      setPhase('done');
    } catch (e) {
      // A real lock that races a new blocker returns 409 with the blockers object.
      if (e.status === 409) {
        const raw = e.data?.blockers || e.data?.issues || e.data?.errors;
        setBlockers(Array.isArray(raw) ? raw : blockersFromCounts(raw));
        setPhase('blocked');
      } else {
        setError(e.data?.message || e.message || 'Failed to lock the period.');
        setPhase('ready');
      }
    }
  }

  function blockerLink(b) {
    // Deep-link a blocker to the relevant tab if we can infer its kind.
    const kind = String(b.kind || b.type || '').toLowerCase();
    if (kind.includes('regular')) return '/attendance?tab=regularizations';
    if (kind.includes('timesheet')) return '/attendance?tab=timesheets';
    return null;
  }

  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-sm text-gray-500">
        Locking a period freezes its attendance rows so payroll can compute against immutable inputs. The period can only
        be locked once pending regularizations are decided and all timesheets are submitted.
      </p>

      {error && <ErrorBanner message={error} />}

      <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <DateField label="From" value={from} onChange={(v) => { setFrom(v); setPhase('idle'); }} required />
          <DateField label="To" value={to} onChange={(v) => { setTo(v); setPhase('idle'); }} required />
        </div>
        <TextInput label="Entity ID" value={entityId} onChange={(v) => { setEntityId(v); setPhase('idle'); }} hint="Optional — close one legal entity only" />
        <div className="flex gap-2">
          <PrimaryButton onClick={preview} loading={phase === 'checking'} disabled={!from || !to}>
            Check for blockers
          </PrimaryButton>
          {phase === 'ready' && (
            <button
              type="button"
              onClick={lock}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50"
              disabled={phase === 'locking'}
            >
              Lock period
            </button>
          )}
        </div>
      </div>

      {phase === 'blocked' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <h3 className="text-sm font-semibold text-amber-800 mb-2">Resolve these before locking</h3>
          {blockers.length === 0 ? (
            <p className="text-sm text-amber-700">The period has unresolved items. Check pending regularizations and unsubmitted timesheets.</p>
          ) : (
            <ul className="space-y-1.5 text-sm text-amber-800">
              {blockers.map((b, i) => {
                const link = blockerLink(b);
                const label = b.message || b.label || `${b.kind || b.type || 'Item'}${b.count != null ? `: ${b.count}` : ''}`;
                return (
                  <li key={i} className="flex items-center justify-between gap-3">
                    <span>• {label}</span>
                    {link && (
                      <a href={link} className="text-amber-900 underline underline-offset-2 hover:text-amber-700 whitespace-nowrap">
                        Resolve →
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-amber-700">
            Once these are cleared, re-run <span className="font-medium">Check for blockers</span> to lock the period.
          </p>
        </div>
      )}

      {phase === 'ready' && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">
          No blockers found for {formatAdminDate(from)} – {formatAdminDate(to)}.{' '}
          {wouldLock != null && (
            <>
              Locking will freeze <span className="font-medium tabular-nums">{wouldLock}</span> attendance row{wouldLock === 1 ? '' : 's'}.{' '}
            </>
          )}
          Click <span className="font-medium">Lock period</span> to freeze it. This cannot be undone.
        </div>
      )}

      {phase === 'done' && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">
          Period {formatAdminDate(from)} – {formatAdminDate(to)} is locked. Attendance rows in range are now immutable; payroll can compute against them.
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const [tab, setTab] = useState('dashboard');
  const [canManage, setCanManage] = useState(false);
  const [permsLoaded, setPermsLoaded] = useState(false);

  useEffect(() => {
    // Read the deep-link tab from the query (period-close blocker links use it).
    if (typeof window !== 'undefined') {
      const t = new URLSearchParams(window.location.search).get('tab');
      if (t && BASE_TABS.concat(CLOSE_TAB).some((x) => x.key === t)) setTab(t);
    }
    get('/api/auth/me')
      .then((me) => {
        const session = me?.user || me;
        setCanManage(hasPermission(permissionsFromSession(session), 'canManageAttendance'));
      })
      .catch(() => setCanManage(false))
      .finally(() => setPermsLoaded(true));
  }, []);

  const tabs = useMemo(() => (canManage ? [...BASE_TABS, CLOSE_TAB] : BASE_TABS), [canManage]);

  // If perms loaded and the active tab is gated-away, fall back to dashboard.
  useEffect(() => {
    if (permsLoaded && tab === 'close' && !canManage) setTab('dashboard');
  }, [permsLoaded, tab, canManage]);

  return (
    <div>
      <PageHeader title="Attendance" subtitle="Dashboard, punches, shifts, holidays, timesheets and regularizations" />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'punches' && <PunchesTab />}
      {tab === 'shifts' && <ShiftsTab canManage={canManage} />}
      {tab === 'holidays' && <HolidaysTab canManage={canManage} />}
      {tab === 'timesheets' && (
        <ApprovalListTab
          endpoint="timesheets"
          idField="id"
          pending="SUBMITTED"
          noun="timesheets"
          emptyText="No timesheets awaiting action."
          columnsFor={() => [
            { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
            { key: 'period', header: 'Period', render: (r) => `${formatAdminDate(r.periodStart || r.weekStart)} – ${formatAdminDate(r.periodEnd || r.weekEnd)}` },
            { key: 'hours', header: 'Hours', render: (r) => r.totalHours ?? r.hours ?? '—' },
          ]}
        />
      )}
      {tab === 'regularizations' && (
        <ApprovalListTab
          endpoint="regularizations"
          idField="requestId"
          pending="PENDING"
          noun="requests"
          emptyText="No correction requests."
          columnsFor={() => [
            { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
            { key: 'date', header: 'Date', render: (r) => formatAdminDate(r.date || r.forDate || r.createdAt) },
            { key: 'kind', header: 'Kind', render: (r) => prettyStatus(r.kind) || '—' },
            { key: 'reason', header: 'Reason', render: (r) => <span className="text-gray-600">{r.reason || '—'}</span> },
            {
              key: 'decidedBy',
              header: 'Decided by',
              // decidedBy is an operator user-id; the controller resolves the
              // person's name into decidedByName (#19). Never render the raw id.
              render: (r) => (r.decidedByName ? <span className="text-gray-700">{r.decidedByName}</span> : <span className="text-gray-400">—</span>),
            },
          ]}
        />
      )}
      {tab === 'close' && canManage && <PeriodCloseTab />}
    </div>
  );
}

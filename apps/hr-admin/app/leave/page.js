'use client';

// Leave console against /api/hr/leave/*.
//  - Requests:  paginated GET /requests with approve/reject (canApproveLeave).
//  - Balances:  employee picker → GET /employees/:id/balances; audited Adjust
//               (POST /balances/adjust).
//  - Calendar:  GET /calendar — who is off across the team in a date window.
//  - Reports:   GET /reports/summary — taken/pending/LOP rolled up by type.
//  - Carry-fwd: POST /runs/carry-forward — year-end roll (dry-run preview → apply).
//  - Types:     GET/POST /types   (config; create gated by canManageOrg backend-side).
//  - Policies:  GET/POST /policies.
// List envelopes are {items[,total,page,pageSize]}; request decisions POST to
// /requests/:id/{approve,reject} and we optimistically refetch on success.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner,
  ErrorBanner,
  Empty,
  PrimaryButton,
  TextInput,
  Modal,
  ModalActions,
  formatAdminDate,
} from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel, ServerPagination } from '@/lib/ui';
import { useTenantCountries } from '@/lib/useTenantCountries';
import { InfoTip } from '@/lib/widgets';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';
import ModuleGuide from '@/components/ModuleGuide';

const TABS = [
  { key: 'requests', label: 'Requests' },
  { key: 'balances', label: 'Balances' },
  { key: 'history', label: 'History' },
  { key: 'reconciliation', label: 'Reconciliation' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'reports', label: 'Reports' },
  { key: 'carryforward', label: 'Year-end' },
  { key: 'types', label: 'Leave types' },
  { key: 'policies', label: 'Policies' },
];

const STATUSES = ['', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
const PAGE_SIZES = [25, 50, 100];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Format a Decimal-ish leave quantity (Prisma returns strings) to a tidy number.
function qty(v) {
  if (v == null) return '—';
  const n = typeof v === 'object' && v.toNumber ? v.toNumber() : Number(v);
  if (Number.isNaN(n)) return String(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

// ─── Shared employee picker (search → GET /employees?q=) ─────────────────────

function EmployeePicker({ value, onChange, label = 'Employee', placeholder = 'Search by name, code or email…' }) {
  // Thin wrapper over the reusable EmployeeSearchSelect: keeps this page's
  // { value: employee|null, onChange: (employee|null) } contract while giving
  // the operator the click-to-browse, filter-as-you-type directory list.
  return (
    <EmployeeSearchSelect
      label={label}
      tip="Click to browse the directory, then filter by name, code or work email."
      value={value?.id || ''}
      selectedLabel={value ? employeeLabel(value) : ''}
      onSelect={(emp) => onChange(emp || null)}
      placeholder={placeholder}
    />
  );
}

// ─── Requests ────────────────────────────────────────────────────────────────

function RequestsTab() {
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/leave/requests', { status, page, pageSize })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load leave requests.'))
      .finally(() => setLoading(false));
  }, [status, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id, action) {
    setBusyId(id);
    setError('');
    try {
      await post(`/api/hr/leave/requests/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} request.`);
    } finally {
      setBusyId('');
    }
  }

  // Post-approval withdraw (APPROVED/AVAILED → WITHDRAWN): reverses the −units,
  // credits the balance back and re-credits comp-off lots, server-side. Blocked
  // (422 PAYRUN_CLOSED) when the covered day sits in a closed pay run — the server
  // message is surfaced via decide()'s catch rather than crashing. Mirrors the
  // approve/reject wiring (same ActionButton + busyId + load-on-success).
  async function withdraw(id) {
    if (!window.confirm('Withdraw this approved leave? The balance will be credited back.')) return;
    await decide(id, 'withdraw');
  }

  const items = data?.items || [];
  const total = data?.total ?? items.length;

  const columns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
    { key: 'leaveType', header: 'Type', render: (r) => r.leaveType?.name || r.leaveTypeName || '—' },
    { key: 'from', header: 'From', render: (r) => formatAdminDate(r.startDate || r.fromDate) },
    { key: 'to', header: 'To', render: (r) => formatAdminDate(r.endDate || r.toDate) },
    { key: 'qty', header: 'Days', render: (r) => (r.quantity != null ? qty(Math.abs(Number(r.quantity))) : '—') },
    { key: 'reason', header: 'Reason', render: (r) => <span className="text-gray-600">{r.reason || '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cellClassName: 'text-right',
      render: (r) => {
        const st = String(r.status).toUpperCase();
        if (st === 'PENDING') {
          return (
            <div className="inline-flex gap-2">
              <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => decide(r.id, 'approve')}>
                Approve
              </ActionButton>
              <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => decide(r.id, 'reject')}>
                Reject
              </ActionButton>
            </div>
          );
        }
        if (st === 'APPROVED' || st === 'AVAILED') {
          return (
            <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => withdraw(r.id)}>
              Withdraw
            </ActionButton>
          );
        }
        return null;
      },
    },
  ];

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || 'All statuses'}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBanner message={error} />}

      <DataTable columns={columns} rows={items} loading={loading} emptyText="No leave requests match." />

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun="requests"
        onPageChange={setPage}
        onPageSizeChange={(ps) => { setPage(1); setPageSize(ps); }}
      />
    </div>
  );
}

// ─── Balances (employee picker → balances + audited adjust) ──────────────────

function AdjustBalanceModal({ employee, balance, onClose, onSaved }) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      await post('/api/hr/leave/balances/adjust', {
        employeeId: employee.id,
        leaveTypeId: balance.leaveTypeId,
        periodCode: balance.periodCode,
        delta: Number(delta),
        reason,
      });
      onSaved();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to adjust the balance.');
      setSaving(false);
    }
  }

  const d = Number(delta);
  const valid = Number.isFinite(d) && d !== 0 && reason.trim().length > 0;

  return (
    <Modal title={`Adjust ${balance.leaveType?.name || 'leave'} balance`} onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      <p className="text-sm text-gray-500 mb-4">
        Posts an audited <span className="font-medium">ADJUSTMENT</span> for{' '}
        <span className="font-medium text-gray-700">{employeeLabel(employee)}</span> in period{' '}
        <span className="font-medium text-gray-700">{balance.periodCode}</span>. Use a positive delta to credit,
        negative to debit. Append-only — the original balance is never overwritten.
      </p>
      <div className="space-y-4">
        <TextInput
          label="Delta (days, +credit / −debit)"
          type="number"
          value={delta}
          onChange={setDelta}
          hint={`Current closing: ${qty(balance.closing)} ${String(balance.unit || 'days').toLowerCase()}`}
          required
        />
        <TextInput label="Reason" value={reason} onChange={setReason} required hint="Recorded on the ledger row" />
      </div>
      <ModalActions>
        <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
          Cancel
        </button>
        <PrimaryButton loading={saving} onClick={save} disabled={!valid}>
          Post adjustment
        </PrimaryButton>
      </ModalActions>
    </Modal>
  );
}

function BalancesTab() {
  const [employee, setEmployee] = useState(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [adjusting, setAdjusting] = useState(null); // balance row being adjusted

  const load = useCallback(() => {
    if (!employee?.id) {
      setRows(null);
      return;
    }
    setLoading(true);
    setError('');
    get(`/api/hr/leave/employees/${employee.id}/balances`)
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.data?.message || e.message || 'Failed to load balances.');
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, [employee]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    {
      key: 'type',
      header: 'Leave type',
      render: (r) => (
        <span className="inline-flex items-center gap-2 font-medium text-gray-900">
          {r.leaveType?.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.leaveType.color }} aria-hidden="true" />}
          {r.leaveType?.name || r.leaveTypeId || '—'}
        </span>
      ),
    },
    { key: 'period', header: 'Period', render: (r) => r.periodCode || '—' },
    { key: 'opening', header: 'Opening', cellClassName: 'text-right tabular-nums text-gray-700', className: 'text-right', render: (r) => qty(r.opening) },
    { key: 'accrued', header: 'Accrued', cellClassName: 'text-right tabular-nums text-gray-700', className: 'text-right', render: (r) => qty(r.accrued) },
    { key: 'taken', header: 'Taken', cellClassName: 'text-right tabular-nums text-gray-700', className: 'text-right', render: (r) => qty(r.taken) },
    { key: 'pending', header: 'On hold', cellClassName: 'text-right tabular-nums text-amber-700', className: 'text-right', render: (r) => qty(r.pendingApproval) },
    {
      key: 'available',
      header: 'Available',
      className: 'text-right',
      cellClassName: 'text-right tabular-nums font-semibold text-gray-900',
      render: (r) => qty(r.available ?? (Number(r.closing) - Number(r.pendingApproval))),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cellClassName: 'text-right',
      render: (r) => (
        <ActionButton onClick={() => setAdjusting(r)}>Adjust</ActionButton>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="max-w-md">
        <EmployeePicker value={employee} onChange={setEmployee} />
      </div>

      {error && <ErrorBanner message={error} />}

      {!employee ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-gray-900">Pick an employee to view their leave balances.</p>
          <p className="text-sm text-gray-500 mt-1">
            You can post an audited adjustment (credit or debit) against any period from here.
          </p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          emptyText="No leave balances for this employee yet."
          rowKey={(r) => r.id}
        />
      )}

      {adjusting && (
        <AdjustBalanceModal
          employee={employee}
          balance={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── History (employee picker → chronological leave history) ─────────────────
// Every request decision AND every ledger movement (accrued/taken/encashed/
// lapsed/adjusted), plain-English-labelled with a signed delta + running balance.
// Reads GET /employees/:id/history (F1 scope-guarded server-side; 404 out of tree).

function unitWord(u) {
  const x = String(u || 'DAYS').toLowerCase();
  return x === 'weeks' ? 'weeks' : x === 'hours' ? 'hours' : 'days';
}
function dirColor(dir) {
  if (dir === 'credit') return 'text-emerald-700';
  if (dir === 'debit') return 'text-red-700';
  return 'text-gray-500';
}

function HistoryTab() {
  const [employee, setEmployee] = useState(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!employee?.id) {
      setRows(null);
      return;
    }
    setLoading(true);
    setError('');
    get(`/api/hr/leave/employees/${employee.id}/history`)
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.data?.message || e.message || 'Failed to load leave history.');
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, [employee]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    {
      key: 'when',
      header: 'When',
      cellClassName: 'whitespace-nowrap text-gray-500',
      render: (r) => formatAdminDate(r.appliedAt || r.createdAt),
    },
    {
      key: 'type',
      header: 'Leave type',
      render: (r) => (
        <span className="inline-flex items-center gap-2 font-medium text-gray-900">
          {r.leaveType?.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.leaveType.color }} aria-hidden="true" />}
          {r.leaveType?.name || '—'}
        </span>
      ),
    },
    { key: 'label', header: 'Movement', render: (r) => <span className="text-gray-700">{r.label}</span> },
    {
      key: 'dates',
      header: 'Dates',
      render: (r) => (r.startDate ? `${r.startDate}${r.endDate && r.endDate !== r.startDate ? ` → ${r.endDate}` : ''}` : '—'),
    },
    {
      key: 'delta',
      header: 'Change',
      className: 'text-right',
      cellClassName: 'text-right tabular-nums',
      render: (r) => (
        <span className={`font-semibold ${dirColor(r.direction)}`}>
          {r.delta ? `${r.delta > 0 ? '+' : '−'}${qty(Math.abs(r.delta))} ${unitWord(r.unit)}` : '—'}
        </span>
      ),
    },
    {
      key: 'balanceAfter',
      header: 'Balance after',
      className: 'text-right',
      cellClassName: 'text-right tabular-nums text-gray-700',
      render: (r) => (r.balanceAfter != null ? qty(r.balanceAfter) : '—'),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'reason', header: 'Reason', render: (r) => <span className="text-gray-500">{r.reason || '—'}</span> },
  ];

  return (
    <div className="space-y-5">
      <div className="max-w-md">
        <EmployeePicker value={employee} onChange={setEmployee} />
      </div>

      {error && <ErrorBanner message={error} />}

      {!employee ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-gray-900">Pick an employee to see their leave history.</p>
          <p className="text-sm text-gray-500 mt-1">
            Every request and every balance movement (earned, taken, lapsed, encashed, adjusted), newest first.
            Green adds to the balance, red takes away.
          </p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          emptyText="No leave history for this employee yet."
          rowKey={(r) => r.id}
        />
      )}
    </div>
  );
}

// ─── Reconciliation (employee + period + type → a statement that balances) ───
// GET /employees/:id/reconciliation?periodCode=&leaveTypeId= returns one lot per
// leave type. The closing identity is laid out as line items that visibly sum to
// the closing balance; drift against the persisted projection is flagged.

function ReconLine({ label, sign, value, kind, unit }) {
  const tone =
    kind === 'credit' ? 'text-emerald-700' :
    kind === 'debit' ? 'text-red-700' :
    'text-gray-800';
  const display = `${sign > 0 ? '+' : '−'} ${qty(Math.abs(Number(value)))} ${unit}`;
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm tabular-nums font-medium ${tone}`}>{value === 0 ? `· 0 ${unit}` : display}</span>
    </div>
  );
}

function ReconCard({ group }) {
  const unit = unitWord(group.unit || group.leaveType?.unit);
  const balances = group.reconciled;
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-gray-900">
          {group.leaveType?.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: group.leaveType.color }} aria-hidden="true" />}
          {group.leaveType?.name || group.leaveTypeId}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${balances ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
          title={balances ? 'Ledger matches the persisted balance' : `Drift of ${qty(group.drift)} vs the persisted balance`}
        >
          {balances ? 'Balances ✓' : `Drift ${qty(group.drift)}`}
        </span>
      </div>

      <div className="rounded-xl bg-gray-50 px-3 py-2">
        {group.lines.map((ln) => (
          <ReconLine key={ln.key} {...ln} unit={unit} />
        ))}
        <div className="mt-1 flex items-center justify-between border-t-2 border-gray-300 pt-2">
          <span className="text-sm font-semibold text-gray-900">= Closing balance</span>
          <span className="text-base font-bold tabular-nums text-gray-900">{qty(group.closing)} {unit}</span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-gray-500">
        <span>Available now (closing − on hold): <span className="font-medium text-gray-800 tabular-nums">{qty(group.available)} {unit}</span></span>
        {Number(group.pendingApproval) > 0 && (
          <span>On hold for pending requests: <span className="font-medium text-amber-700 tabular-nums">{qty(group.pendingApproval)} {unit}</span></span>
        )}
        {group.persistedClosing != null && (
          <span>Recorded balance: <span className="font-medium text-gray-800 tabular-nums">{qty(group.persistedClosing)} {unit}</span></span>
        )}
      </div>
    </div>
  );
}

function ReconciliationTab() {
  const defaultPeriod = useMemo(() => {
    // India FY "YYYY-YY" for the current year (the most common period code shape).
    const now = new Date();
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  }, []);
  const [employee, setEmployee] = useState(null);
  const [periodCode, setPeriodCode] = useState(defaultPeriod);
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [types, setTypes] = useState([]);
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Leave types for the optional filter (same source the Policies tab uses).
  useEffect(() => {
    get('/api/hr/leave/types').then((r) => setTypes(asList(r))).catch(() => setTypes([]));
  }, []);

  const load = useCallback(() => {
    if (!employee?.id || !periodCode.trim()) {
      setGroups(null);
      return;
    }
    setLoading(true);
    setError('');
    const params = { periodCode: periodCode.trim() };
    if (leaveTypeId) params.leaveTypeId = leaveTypeId;
    get(`/api/hr/leave/employees/${employee.id}/reconciliation`, params)
      .then((r) => setGroups(asList(r)))
      .catch((e) => {
        setError(e.data?.message || e.message || 'Failed to load the reconciliation.');
        setGroups([]);
      })
      .finally(() => setLoading(false));
  }, [employee, periodCode, leaveTypeId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500 max-w-3xl">
        A line-by-line statement per leave type for one period:{' '}
        <span className="font-medium text-gray-700">Opening + Accrued − Taken − Encashed − Lapsed + Adjusted = Closing</span>.
        Recomputed from the ledger and cross-checked against the recorded balance — any drift is flagged.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="max-w-md flex-1 min-w-[240px]">
          <EmployeePicker value={employee} onChange={setEmployee} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="recon-period">Period code</label>
          <input
            id="recon-period"
            type="text"
            value={periodCode}
            onChange={(e) => setPeriodCode(e.target.value)}
            placeholder='e.g. "2026-27"'
            className="w-44 px-4 py-2.5 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="recon-type">Leave type</label>
          <select
            id="recon-type"
            value={leaveTypeId}
            onChange={(e) => setLeaveTypeId(e.target.value)}
            className="w-56 px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white"
          >
            <option value="">All leave types</option>
            {(types || []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.code ? ` (${t.code})` : ''}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {!employee ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-gray-900">Pick an employee and a period to see the reconciliation.</p>
          <p className="text-sm text-gray-500 mt-1">Each leave type gets its own statement that visibly balances to the closing figure.</p>
        </div>
      ) : loading ? (
        <Spinner />
      ) : !groups || groups.length === 0 ? (
        <Empty text="No leave balances for this employee in that period." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <ReconCard key={g.leaveTypeId} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Calendar (who is off across the team) ───────────────────────────────────

function CalendarTab() {
  const monthStart = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  }, []);
  const monthEnd = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
  }, []);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(monthEnd);
  const [includePending, setIncludePending] = useState(true);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/leave/calendar', { from, to, includePending: includePending ? 'true' : 'false' })
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.data?.message || e.message || 'Failed to load the leave calendar.');
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, [from, to, includePending]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
    {
      key: 'type',
      header: 'Type',
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          {r.leaveType?.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.leaveType.color }} aria-hidden="true" />}
          {r.leaveType?.name || '—'}
        </span>
      ),
    },
    { key: 'from', header: 'From', render: (r) => formatAdminDate(r.startDate) },
    { key: 'to', header: 'To', render: (r) => formatAdminDate(r.endDate) },
    { key: 'days', header: 'Days', cellClassName: 'tabular-nums text-gray-700', render: (r) => qty(Math.abs(Number(r.quantity))) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="cal-from">From</label>
          <input id="cal-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="cal-to">To</label>
          <input id="cal-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 pb-2 cursor-pointer">
          <input type="checkbox" checked={includePending} onChange={(e) => setIncludePending(e.target.checked)} />
          Include pending
        </label>
      </div>

      {error && <ErrorBanner message={error} />}

      <DataTable columns={columns} rows={rows} loading={loading} emptyText="No one is on leave in this window." />
    </div>
  );
}

// ─── Reports (taken / pending / LOP by type) ─────────────────────────────────

function ReportsTab() {
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const yearEnd = `${new Date().getFullYear()}-12-31`;
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(yearEnd);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/leave/reports/summary', { from, to, groupBy: 'type' })
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.data?.message || e.message || 'Failed to load the report.');
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    const list = rows || [];
    return list.reduce(
      (acc, r) => ({
        taken: acc.taken + Number(r.taken || 0),
        pending: acc.pending + Number(r.pending || 0),
        lop: acc.lop + Number(r.lop || 0),
      }),
      { taken: 0, pending: 0, lop: 0 },
    );
  }, [rows]);

  const columns = [
    { key: 'key', header: 'Leave type', render: (r) => <span className="font-medium text-gray-900">{r.key}</span> },
    { key: 'count', header: 'Requests', cellClassName: 'text-right tabular-nums text-gray-700', className: 'text-right', render: (r) => r.count ?? 0 },
    { key: 'taken', header: 'Taken', cellClassName: 'text-right tabular-nums text-gray-700', className: 'text-right', render: (r) => qty(r.taken) },
    { key: 'pending', header: 'Pending', cellClassName: 'text-right tabular-nums text-amber-700', className: 'text-right', render: (r) => qty(r.pending) },
    { key: 'lop', header: 'LOP', cellClassName: 'text-right tabular-nums text-red-700', className: 'text-right', render: (r) => qty(r.lop) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="rep-from">From</label>
          <input id="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="rep-to">To</label>
          <input id="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {!loading && rows && rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            ['Taken', totals.taken, 'text-gray-900'],
            ['Pending', totals.pending, 'text-amber-700'],
            ['Loss of pay', totals.lop, 'text-red-700'],
          ].map(([label, value, tone]) => (
            <div key={label} className="rounded-2xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500">{label}</p>
              <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{qty(value)}</p>
            </div>
          ))}
        </div>
      )}

      <DataTable columns={columns} rows={rows} loading={loading} emptyText="No leave activity in this window." rowKey={(r) => r.key} />
    </div>
  );
}

// ─── Year-end carry-forward (dry-run preview → apply) ────────────────────────

function CarryForwardTab() {
  // Default the period to "YYYY-YY" for the year that just ended (the roll source).
  const defaultPeriod = useMemo(() => {
    const y = new Date().getFullYear() - 1;
    return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  }, []);
  const [periodCode, setPeriodCode] = useState(defaultPeriod);
  const [result, setResult] = useState(null); // dry-run preview
  const [applied, setApplied] = useState(null); // applied result
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(dryRun) {
    setBusy(true);
    setError('');
    try {
      const res = await post('/api/hr/leave/runs/carry-forward', { periodCode, dryRun });
      if (dryRun) {
        setResult(res);
        setApplied(null);
      } else {
        setApplied(res);
        setResult(res);
      }
    } catch (e) {
      setError(e.data?.message || e.message || 'Carry-forward run failed.');
    } finally {
      setBusy(false);
    }
  }

  const lines = result?.lines || [];
  const columns = [
    { key: 'employeeId', header: 'Employee', render: (r) => <span className="text-gray-700">{r.employeeId}</span> },
    { key: 'toPeriod', header: 'Into period', render: (r) => r.toPeriod || '—' },
    { key: 'closing', header: 'Closing', cellClassName: 'text-right tabular-nums text-gray-700', className: 'text-right', render: (r) => qty(r.closing) },
    { key: 'carried', header: 'Carried', cellClassName: 'text-right tabular-nums text-emerald-700', className: 'text-right', render: (r) => qty(r.carried) },
    { key: 'lapsed', header: 'Lapsed', cellClassName: 'text-right tabular-nums text-red-700', className: 'text-right', render: (r) => qty(r.lapsed) },
  ];

  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-sm text-gray-500">
        Rolls each employee&apos;s closing balance into the next period&apos;s opening — capped and expiring per policy. The
        run is idempotent: balances already carried are skipped, so re-running is safe. Always preview before applying.
      </p>

      {error && <ErrorBanner message={error} />}

      <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
        <div className="max-w-xs">
          <TextInput
            label="Source period code"
            value={periodCode}
            onChange={(v) => {
              setPeriodCode(v);
              setResult(null);
              setApplied(null);
            }}
            hint='e.g. "2025-26" (India FY) or "2025-ANNIV"'
          />
        </div>
        <div className="flex gap-2">
          <PrimaryButton onClick={() => run(true)} loading={busy && !applied} disabled={!periodCode.trim()}>
            Preview run
          </PrimaryButton>
          {result && !applied && (
            <button
              type="button"
              onClick={() => run(false)}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50"
              style={{ backgroundColor: 'var(--theme-primary)' }}
            >
              Apply carry-forward
            </button>
          )}
        </div>
      </div>

      {result && (
        <div className="space-y-4">
          <div
            className={`rounded-2xl border p-5 text-sm ${
              applied ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-blue-200 bg-blue-50 text-blue-800'
            }`}
          >
            {applied ? (
              <>
                Carry-forward applied for <span className="font-medium">{result.periodCode}</span> → <span className="font-medium">{result.nextPeriodCode}</span>.{' '}
                Rolled <span className="font-medium tabular-nums">{result.rolled}</span>, skipped{' '}
                <span className="font-medium tabular-nums">{result.skipped}</span>.
              </>
            ) : (
              <>
                Preview for <span className="font-medium">{result.periodCode}</span> → <span className="font-medium">{result.nextPeriodCode}</span>:{' '}
                <span className="font-medium tabular-nums">{result.lineCount}</span> balance{result.lineCount === 1 ? '' : 's'} to roll.
                Nothing has been written yet.
              </>
            )}
            <div className="mt-2 flex gap-6">
              <span>Carried total: <span className="font-medium tabular-nums">{qty(result.carriedTotal)}</span></span>
              <span>Lapsed total: <span className="font-medium tabular-nums">{qty(result.lapsedTotal)}</span></span>
            </div>
          </div>

          {lines.length === 0 ? (
            <Empty text="No balances qualify for carry-forward in this period (already rolled, or zero closing)." />
          ) : (
            <DataTable columns={columns} rows={lines} emptyText="No lines." rowKey={(r, i) => `${r.employeeId}-${i}`} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Config (Types + Policies) ───────────────────────────────────────────────

const CATEGORY_OPTS = ['ANNUAL', 'CASUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'BEREAVEMENT', 'PUBLIC_HOLIDAY', 'ALTERNATIVE_DAY', 'COMP_OFF', 'UNPAID', 'SABBATICAL', 'MARRIAGE', 'ADOPTION', 'FAMILY_VIOLENCE', 'OTHER'];
const UNIT_OPTS = ['DAYS', 'HOURS', 'WEEKS'];
const SANDWICH_OPTS = ['', 'INCLUSIVE', 'EXCLUSIVE'];
const COUNTRY_OPTS = ['', 'IN'];
const ACCRUAL_METHOD_OPTS = ['UPFRONT_ANNUAL', 'MONTHLY_ACCRUAL', 'ANNIVERSARY_GRANT', 'WORKED_HOURS_RATIO', 'NONE'];
const ACCRUAL_FREQ_OPTS = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PER_PAY_PERIOD'];
const GENDER_OPTS = ['', 'MALE', 'FEMALE', 'OTHER'];

function prettyEnum(v) {
  return String(v || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Per-resource column definitions so each config table shows its key fields
// instead of a shared name/code/paid trio (#21). Each entry: { key, header, render? }.
function typeColumns() {
  return [
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <span className="inline-flex items-center gap-2 font-medium text-gray-900">
          {r.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.color }} aria-hidden="true" />}
          {r.name}
        </span>
      ),
    },
    { key: 'code', header: 'Code', render: (r) => r.code || '—' },
    { key: 'category', header: 'Category', render: (r) => prettyEnum(r.category) || '—' },
    { key: 'unit', header: 'Unit', render: (r) => prettyEnum(r.unit) || '—' },
    { key: 'countryCode', header: 'Country', render: (r) => r.countryCode || 'All' },
    { key: 'isPaid', header: 'Paid', render: (r) => ((r.isPaid ?? r.paid) === false ? <span className="text-gray-500">Unpaid</span> : 'Paid') },
  ];
}

function policyColumns(typeById) {
  return [
    { key: 'name', header: 'Policy', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => r.code || '—' },
    {
      key: 'leaveType',
      header: 'Leave type',
      render: (r) => {
        const t = r.leaveType || typeById?.get(r.leaveTypeId);
        return t ? `${t.name}${t.code ? ` (${t.code})` : ''}` : (r.leaveTypeId || '—');
      },
    },
    { key: 'accrualMethod', header: 'Accrual', render: (r) => prettyEnum(r.accrualMethod) || '—' },
    {
      key: 'entitlementPerYear',
      header: 'Entitlement / yr',
      className: 'text-right',
      cellClassName: 'text-right tabular-nums text-gray-700',
      render: (r) => (r.entitlementPerYear != null ? qty(r.entitlementPerYear) : '—'),
    },
  ];
}

function ConfigTab({ resource, title, fields, columns }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map((f) => [f.key, ''])));

  const load = useCallback(() => {
    setError('');
    get(`/api/hr/leave/${resource}`)
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.data?.message || e.message || `Failed to load ${title.toLowerCase()}.`);
        setRows([]);
      });
  }, [resource, title]);

  useEffect(() => {
    load();
  }, [load]);

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      await post(`/api/hr/leave/${resource}`, payload);
      setDraft(Object.fromEntries(fields.map((f) => [f.key, ''])));
      load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to create.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        {error && <ErrorBanner message={error} />}
        <DataTable columns={columns} rows={rows} loading={rows === null} emptyText={`No ${title.toLowerCase()} yet.`} />
      </div>
      <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
        <h2 className="text-sm font-semibold text-gray-900">Add {title.replace(/s$/, '').toLowerCase()}</h2>
        {fields.map((f) => {
          const set = (v) => setDraft((d) => ({ ...d, [f.key]: v }));
          if (f.type === 'select') {
            return (
              <label key={f.key} className="block text-sm">
                <span className="mb-1 flex items-center font-medium text-gray-700">{f.label}{f.required ? ' *' : ''}{f.hint ? <InfoTip text={f.hint} /> : null}</span>
                <select
                  value={draft[f.key]} required={f.required} onChange={(e) => set(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                >
                  <option value="">{f.placeholder || 'Select…'}</option>
                  {(f.options || []).map((o) => (
                    <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
                  ))}
                </select>
              </label>
            );
          }
          if (f.type === 'checkbox') {
            return (
              <label key={f.key} className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={draft[f.key] === true || draft[f.key] === 'true'}
                  onChange={(e) => set(e.target.checked)} />
                {f.label}{f.hint ? <InfoTip text={f.hint} /> : null}
              </label>
            );
          }
          return (
            <div key={f.key} className="flex items-end gap-1">
              <div className="flex-1">
                <TextInput
                  label={f.label} type={f.type === 'number' ? 'number' : undefined}
                  value={draft[f.key]} onChange={set} required={f.required}
                />
              </div>
              {f.hint ? <span className="pb-2"><InfoTip text={f.hint} /></span> : null}
            </div>
          );
        })}
        <PrimaryButton type="submit" loading={saving}>
          Save
        </PrimaryButton>
      </form>
    </div>
  );
}

// Full LeaveType allow-list (matches the controller LEAVE_TYPE_FIELDS + §5.1 spec).
// Single-country India (Feature 14): the Country select is constrained to the
// tenant's own country (India). The sandwich policy (e.g. holidays inside an LWP
// block) applies to India leave types too, so it's always available.
function typeFields(countries) {
  const list = Array.isArray(countries) ? countries : [];
  const single = list.length === 1;
  const countryOpts = single ? [list[0]] : COUNTRY_OPTS;
  const fields = [
    { key: 'name', label: 'Name', required: true },
    { key: 'code', label: 'Code', required: true },
    { key: 'category', label: 'Category', type: 'select', options: CATEGORY_OPTS, required: true, hint: 'Choose UNPAID for Leave Without Pay (LWP): it applies with no balance and reduces pay for the days taken. CASUAL = Casual Leave (paid, lapses at year-end). India statutory floors apply to EL/SL/CL policies.' },
    { key: 'unit', label: 'Unit', type: 'select', options: UNIT_OPTS },
    { key: 'countryCode', label: single ? 'Country' : 'Country', type: 'select', options: countryOpts },
    { key: 'sandwichPolicy', label: 'Sandwich policy', type: 'select', options: SANDWICH_OPTS },
  ];
  fields.push(
    { key: 'color', label: 'Calendar colour (#hex)' },
    { key: 'isPaid', label: 'Paid', type: 'checkbox' },
    { key: 'isStatutory', label: 'Statutory', type: 'checkbox' },
    { key: 'requiresReason', label: 'Requires reason', type: 'checkbox' },
    { key: 'affectsLOP', label: 'Affects LOP (unpaid)', type: 'checkbox', hint: 'When on, the days taken are Loss-of-Pay and reduce salary pro-rata (an authorised unpaid absence, not a balance deduction). A paid type cannot also affect LOP. UNPAID-category types force this on automatically.' },
    { key: 'isEncashable', label: 'Encashable', type: 'checkbox' },
  );
  return fields;
}

// Full LeavePolicy allow-list (sectioned: entitlement/carry-forward/rules/eligibility/exit).
function policyFields(typeOptions) {
  return [
    { key: 'leaveTypeId', label: 'Leave type', type: 'select', required: true, options: (typeOptions || []).map((t) => ({ value: t.id, label: `${t.name} (${t.code})` })) },
    { key: 'name', label: 'Policy name', required: true },
    { key: 'code', label: 'Code', required: true },
    { key: 'accrualMethod', label: 'Accrual method', type: 'select', options: ACCRUAL_METHOD_OPTS, required: true, hint: 'How the balance grows. Choose NONE for Leave Without Pay (LWP): it never creates a balance and must have no entitlement.' },
    { key: 'entitlementPerYear', label: 'Entitlement / year', type: 'number', hint: 'Days granted per year. For India EL/SL/CL this must be at or above the state statutory floor (e.g. Maharashtra EL ≥ 21/yr) — saving below the floor is blocked. Leave blank for LWP.' },
    { key: 'accrualFrequency', label: 'Accrual frequency', type: 'select', options: ACCRUAL_FREQ_OPTS },
    { key: 'accrualProrateOnJoin', label: 'Pro-rate on join', type: 'checkbox' },
    { key: 'carryForwardCap', label: 'Carry-forward cap (blank = unbounded)', type: 'number' },
    { key: 'carryForwardExpiryMonths', label: 'Carry-forward expiry (months)', type: 'number' },
    { key: 'maxBalanceCap', label: 'Max balance cap', type: 'number' },
    { key: 'maxConsecutive', label: 'Max consecutive days', type: 'number' },
    { key: 'minNoticeDays', label: 'Min notice days', type: 'number' },
    { key: 'allowNegative', label: 'Allow advance (negative)', type: 'checkbox' },
    { key: 'negativeCap', label: 'Negative cap', type: 'number' },
    { key: 'minTenureMonths', label: 'Min tenure (months)', type: 'number' },
    { key: 'appliesToEmploymentTypes', label: 'Employment types (CSV)' },
    { key: 'genderRestriction', label: 'Gender restriction', type: 'select', options: GENDER_OPTS },
    { key: 'encashOnExit', label: 'Encash on exit', type: 'checkbox' },
    { key: 'maxEncashCap', label: 'Max encash cap', type: 'number' },
  ];
}

function LeaveInner() {
  const [tab, setTab] = useState('requests');
  const [types, setTypes] = useState([]);
  // The tenant's operating country (Feature 14) drives the leave-type Country
  // select — an India tenant only ever sees India.
  const { countries } = useTenantCountries();
  useEffect(() => {
    get('/api/hr/leave/types').then((r) => setTypes(asList(r))).catch(() => setTypes([]));
  }, [tab]);

  const typeById = useMemo(() => new Map((types || []).map((t) => [t.id, t])), [types]);

  return (
    <div>
      <PageHeader title="Leave" subtitle="Requests, balances, calendar, reports, year-end and config" />
      <ModuleGuide
        id="leave"
        title="Run leave end-to-end: approve, balance, reconcile"
        what="The leave console is where you action pending leave requests, manage each employee's balances and history, see who's off across the team, report on taken/pending/LOP, and run year-end carry-forward. Config tabs let you define leave types and policies (with India statutory floors enforced)."
        steps={[
          "On Requests, filter by PENDING and Approve or Reject each request — decisions are audited and balances update on hold immediately.",
          "On Balances, pick an employee to see Opening / Accrued / Taken / On hold / Available per type; use Adjust to post an audited credit or debit with a reason.",
          "Use Reconciliation to prove a period statement balances (Opening + Accrued − Taken − Encashed − Lapsed + Adjusted = Closing) and catch any drift.",
          "Check Calendar for overlaps before approving, then use Reports to roll up taken, pending and Loss-of-Pay by leave type.",
          "At year-end, open the Year-end tab, Preview the carry-forward run for the closing period, review carried vs lapsed, then Apply.",
          "Configure Leave types and Policies (accrual method, entitlement/yr, carry-forward cap) under the last two tabs before onboarding employees.",
        ]}
        example={<>Aarav Sharma at Acme India Pvt Ltd applies for <b>3 days Earned Leave</b> (10–12 June 2026). You approve it on Requests; his Balances show <b>Available</b> drop by 3. At year-end you Preview carry-forward for period <b>2025-26</b>: his closing <b>18 EL</b> rolls forward capped at <b>15</b>, with <b>3 lapsing</b>.</>}
        tips={[
          "Always Preview the carry-forward before Apply — the run is idempotent, so already-rolled balances are safely skipped on re-run.",
          "Period codes use India FY format like \"2026-27\"; LWP/UNPAID types affect LOP and reduce pay pro-rata rather than deducting a balance.",
        ]}
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'requests' && <RequestsTab />}
      {tab === 'balances' && <BalancesTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'reconciliation' && <ReconciliationTab />}
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'reports' && <ReportsTab />}
      {tab === 'carryforward' && <CarryForwardTab />}
      {tab === 'types' && (
        <ConfigTab resource="types" title="Leave types" fields={typeFields(countries)} columns={typeColumns()} />
      )}
      {tab === 'policies' && (
        <ConfigTab resource="policies" title="Policies" fields={policyFields(types)} columns={policyColumns(typeById)} />
      )}
    </div>
  );
}

export default function LeavePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <LeaveInner />
    </Suspense>
  );
}

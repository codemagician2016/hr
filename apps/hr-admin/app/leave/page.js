'use client';

// Leave console: three tabs against /api/hr/leave/*.
//  - Requests: paginated GET /requests with approve/reject (canApproveLeave).
//  - Types:    GET/POST /types (config; create gated by canManageOrg backend-side).
//  - Policies: GET/POST /policies.
// List envelopes are {items[,total,page,pageSize]}; request decisions POST to
// /requests/:id/{approve,reject} and we optimistically refetch on success.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, TextInput, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel } from '@/lib/ui';

const TABS = [
  { key: 'requests', label: 'Requests' },
  { key: 'types', label: 'Leave types' },
  { key: 'policies', label: 'Policies' },
];

const STATUSES = ['', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
const PAGE_SIZE = 25;

function RequestsTab() {
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/leave/requests', { status, page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load leave requests.'))
      .finally(() => setLoading(false));
  }, [status, page]);

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

  const items = data?.items || [];
  const total = data?.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
    { key: 'leaveType', header: 'Type', render: (r) => r.leaveType?.name || r.leaveTypeName || r.leaveTypeId || '—' },
    { key: 'from', header: 'From', render: (r) => formatAdminDate(r.startDate || r.fromDate) },
    { key: 'to', header: 'To', render: (r) => formatAdminDate(r.endDate || r.toDate) },
    { key: 'qty', header: 'Days', render: (r) => (r.quantity != null ? Math.abs(Number(r.quantity)) : '—') },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        String(r.status).toUpperCase() === 'PENDING' ? (
          <div className="flex gap-2">
            <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => decide(r.id, 'approve')}>
              Approve
            </ActionButton>
            <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => decide(r.id, 'reject')}>
              Reject
            </ActionButton>
          </div>
        ) : null,
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
          >
            Previous
          </button>
          <span className="text-gray-500">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function ConfigTab({ resource, title, fields }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map((f) => [f.key, ''])));

  const load = useCallback(() => {
    setError('');
    get(`/api/hr/leave/${resource}`)
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.message || `Failed to load ${title.toLowerCase()}.`);
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
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to create.');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => r.code || '—' },
    { key: 'paid', header: 'Paid', render: (r) => (r.isPaid ?? r.paid) === false ? 'Unpaid' : 'Paid' },
  ];

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
                <span className="mb-1 block font-medium text-gray-700">{f.label}{f.required ? ' *' : ''}</span>
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
                {f.label}
              </label>
            );
          }
          return (
            <TextInput
              key={f.key} label={f.label} type={f.type === 'number' ? 'number' : undefined}
              value={draft[f.key]} onChange={set} required={f.required}
            />
          );
        })}
        <PrimaryButton type="submit" loading={saving}>
          Save
        </PrimaryButton>
      </form>
    </div>
  );
}

const CATEGORY_OPTS = ['ANNUAL', 'CASUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'BEREAVEMENT', 'PUBLIC_HOLIDAY', 'ALTERNATIVE_DAY', 'COMP_OFF', 'UNPAID', 'SABBATICAL', 'MARRIAGE', 'ADOPTION', 'FAMILY_VIOLENCE', 'OTHER'];
const UNIT_OPTS = ['DAYS', 'HOURS', 'WEEKS'];
const NZ_BASIS_OPTS = ['', 'RDP', 'ADP', 'AWE_8PCT', 'OWP'];
const SANDWICH_OPTS = ['', 'INCLUSIVE', 'EXCLUSIVE'];
const COUNTRY_OPTS = ['', 'IN', 'NZ'];
const ACCRUAL_METHOD_OPTS = ['UPFRONT_ANNUAL', 'MONTHLY_ACCRUAL', 'ANNIVERSARY_GRANT', 'WORKED_HOURS_RATIO', 'CONTINUOUS_NZ'];
const ACCRUAL_FREQ_OPTS = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PER_PAY_PERIOD'];
const GENDER_OPTS = ['', 'MALE', 'FEMALE', 'OTHER'];

// Full LeaveType allow-list (matches the controller LEAVE_TYPE_FIELDS + §5.1 spec).
const TYPE_FIELDS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'code', label: 'Code', required: true },
  { key: 'category', label: 'Category', type: 'select', options: CATEGORY_OPTS, required: true },
  { key: 'unit', label: 'Unit', type: 'select', options: UNIT_OPTS },
  { key: 'countryCode', label: 'Country (blank = both)', type: 'select', options: COUNTRY_OPTS },
  { key: 'nzPayBasis', label: 'NZ pay basis', type: 'select', options: NZ_BASIS_OPTS },
  { key: 'sandwichPolicy', label: 'Sandwich policy', type: 'select', options: SANDWICH_OPTS },
  { key: 'color', label: 'Calendar colour (#hex)' },
  { key: 'isPaid', label: 'Paid', type: 'checkbox' },
  { key: 'isStatutory', label: 'Statutory', type: 'checkbox' },
  { key: 'requiresReason', label: 'Requires reason', type: 'checkbox' },
  { key: 'affectsLOP', label: 'Affects LOP (unpaid)', type: 'checkbox' },
  { key: 'isEncashable', label: 'Encashable', type: 'checkbox' },
];

// Full LeavePolicy allow-list (sectioned: entitlement/carry-forward/rules/eligibility/exit).
function policyFields(typeOptions) {
  return [
    { key: 'leaveTypeId', label: 'Leave type', type: 'select', required: true, options: (typeOptions || []).map((t) => ({ value: t.id, label: `${t.name} (${t.code})` })) },
    { key: 'name', label: 'Policy name', required: true },
    { key: 'code', label: 'Code', required: true },
    { key: 'accrualMethod', label: 'Accrual method', type: 'select', options: ACCRUAL_METHOD_OPTS, required: true },
    { key: 'entitlementPerYear', label: 'Entitlement / year', type: 'number' },
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
  useEffect(() => {
    get('/api/hr/leave/types').then((r) => setTypes(asList(r))).catch(() => setTypes([]));
  }, [tab]);
  return (
    <div>
      <PageHeader title="Leave" subtitle="Requests, leave types and policies" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'requests' && <RequestsTab />}
      {tab === 'types' && <ConfigTab resource="types" title="Leave types" fields={TYPE_FIELDS} />}
      {tab === 'policies' && <ConfigTab resource="policies" title="Policies" fields={policyFields(types)} />}
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

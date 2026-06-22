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
    { key: 'qty', header: 'Days', render: (r) => r.quantity ?? r.days ?? r.numDays ?? '—' },
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
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none"
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
        {fields.map((f) => (
          <TextInput
            key={f.key}
            label={f.label}
            value={draft[f.key]}
            onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
            required={f.required}
          />
        ))}
        <PrimaryButton type="submit" loading={saving}>
          Save
        </PrimaryButton>
      </form>
    </div>
  );
}

function LeaveInner() {
  const [tab, setTab] = useState('requests');
  return (
    <div>
      <PageHeader title="Leave" subtitle="Requests, leave types and policies" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'requests' && <RequestsTab />}
      {tab === 'types' && (
        <ConfigTab
          resource="types"
          title="Leave types"
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'code', label: 'Code' },
          ]}
        />
      )}
      {tab === 'policies' && (
        <ConfigTab
          resource="policies"
          title="Policies"
          fields={[
            { key: 'name', label: 'Policy name', required: true },
            { key: 'code', label: 'Code' },
          ]}
        />
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

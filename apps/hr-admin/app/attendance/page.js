'use client';

// Attendance console: four tabs against /api/hr/attendance/*.
//  - Punches:         GET /punches (paginated).
//  - Shifts:          GET /shifts + inline create POST /shifts (canManageAttendance).
//  - Timesheets:      GET /timesheets with approve/reject (canManageAttendance).
//  - Regularizations: GET /regularizations with approve/reject; note the route
//    uses :requestId, not :id.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, TextInput, TimeField, formatAdminDate, formatAdminDateTime } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel } from '@/lib/ui';

const TABS = [
  { key: 'punches', label: 'Punches' },
  { key: 'shifts', label: 'Shifts' },
  { key: 'timesheets', label: 'Timesheets' },
  { key: 'regularizations', label: 'Regularizations' },
];

function PunchesTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    get('/api/hr/attendance/punches', { page: 1, pageSize: 50 })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load punches.'))
      .finally(() => setLoading(false));
  }, []);

  const columns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
    { key: 'direction', header: 'Direction', render: (r) => r.direction || r.type || '—' },
    { key: 'at', header: 'Time', render: (r) => formatAdminDateTime(r.punchedAt || r.timestamp || r.at) },
    { key: 'source', header: 'Source', render: (r) => r.source || r.method || '—' },
  ];

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={asList(data)} loading={loading} emptyText="No punches recorded." />
    </div>
  );
}

function ShiftsTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ name: '', code: '', startTime: '', endTime: '' });

  const load = useCallback(() => {
    setError('');
    get('/api/hr/attendance/shifts')
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.message || 'Failed to load shifts.');
        setRows([]);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      await post('/api/hr/attendance/shifts', payload);
      setDraft({ name: '', code: '', startTime: '', endTime: '' });
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to create shift.');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    { key: 'name', header: 'Shift', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => r.code || '—' },
    { key: 'start', header: 'Start', render: (r) => r.startTime || r.start || '—' },
    { key: 'end', header: 'End', render: (r) => r.endTime || r.end || '—' },
  ];

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        {error && <ErrorBanner message={error} />}
        <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No shifts defined." />
      </div>
      <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
        <h2 className="text-sm font-semibold text-gray-900">Add shift</h2>
        <TextInput label="Name" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} required />
        <TextInput label="Code" value={draft.code} onChange={(v) => setDraft((d) => ({ ...d, code: v }))} />
        <TimeField label="Start time" value={draft.startTime} onChange={(v) => setDraft((d) => ({ ...d, startTime: v }))} />
        <TimeField label="End time" value={draft.endTime} onChange={(v) => setDraft((d) => ({ ...d, endTime: v }))} />
        <PrimaryButton type="submit" loading={saving}>
          Save shift
        </PrimaryButton>
      </form>
    </div>
  );
}

// Shared approve/reject list used by timesheets + regularizations. `idKey`
// selects the path param the route expects (timesheets → :id;
// regularizations → :requestId).
function ApprovalListTab({ endpoint, idField, pending = 'SUBMITTED', columnsFor }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`/api/hr/attendance/${endpoint}`, { page: 1, pageSize: 50 })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load.'))
      .finally(() => setLoading(false));
  }, [endpoint]);

  useEffect(() => {
    load();
  }, [load]);

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
      render: (r) => {
        const id = r[idField] || r.id;
        const isPending = String(r.status || pending).toUpperCase() === String(pending).toUpperCase();
        if (!isPending) return null;
        return (
          <div className="flex gap-2">
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
        rows={asList(data)}
        loading={loading}
        emptyText="Nothing awaiting action."
        rowKey={(r) => r[idField] || r.id}
      />
    </div>
  );
}

export default function AttendancePage() {
  const [tab, setTab] = useState('punches');
  return (
    <div>
      <PageHeader title="Attendance" subtitle="Punches, shifts, timesheets and regularizations" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'punches' && <PunchesTab />}
      {tab === 'shifts' && <ShiftsTab />}
      {tab === 'timesheets' && (
        <ApprovalListTab
          endpoint="timesheets"
          idField="id"
          pending="SUBMITTED"
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
          columnsFor={() => [
            { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
            { key: 'date', header: 'Date', render: (r) => formatAdminDate(r.date || r.forDate || r.createdAt) },
            { key: 'count', header: 'Punches', render: (r) => r.punchCount ?? '—' },
            { key: 'reason', header: 'Reason', render: (r) => r.reason || '—' },
          ]}
        />
      )}
    </div>
  );
}

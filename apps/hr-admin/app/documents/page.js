'use client';

// Employee documents against /api/hr/documents/*. The document + request
// resources are per-employee (/employees/:employeeId/documents|requests), so
// the page takes an employee id, lists both, and supports uploading a document
// (POST .../documents) and fulfilling a request (POST .../requests/:id/fulfil).
// A tenant-wide "expiring soon" report (GET /expiring) anchors the top.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, TextInput, DateField, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton } from '@/lib/ui';

function ExpiringPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    get('/api/hr/documents/expiring', { page: 1, pageSize: 25 })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load expiring documents.'))
      .finally(() => setLoading(false));
  }, []);

  const columns = [
    { key: 'name', header: 'Document', render: (r) => <span className="font-medium text-gray-900">{r.name || r.type}</span> },
    { key: 'employee', header: 'Employee', render: (r) => r.employee ? [r.employee.firstName, r.employee.lastName].filter(Boolean).join(' ') : r.employeeId || '—' },
    { key: 'type', header: 'Type', render: (r) => r.type || '—' },
    { key: 'expiresAt', header: 'Expires', render: (r) => formatAdminDate(r.expiresAt) },
  ];

  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Expiring soon</h2>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={asList(data)} loading={loading} emptyText="No documents expiring soon." />
    </div>
  );
}

function DocumentsTab({ employeeId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ type: '', name: '', url: '', expiresAt: '' });

  const load = useCallback(() => {
    if (!employeeId) return;
    setError('');
    get(`/api/hr/documents/employees/${employeeId}/documents`, { page: 1, pageSize: 100 })
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.message || 'Failed to load documents.');
        setRows([]);
      });
  }, [employeeId]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      await post(`/api/hr/documents/employees/${employeeId}/documents`, payload);
      setDraft({ type: '', name: '', url: '', expiresAt: '' });
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to add document.');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    { key: 'name', header: 'Document', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'type', header: 'Type', render: (r) => r.type || '—' },
    { key: 'url', header: 'File', render: (r) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline" style={{ color: 'var(--theme-primary)' }}>Open</a> : '—') },
    { key: 'issuedAt', header: 'Issued', render: (r) => formatAdminDate(r.issuedAt) },
    { key: 'expiresAt', header: 'Expires', render: (r) => formatAdminDate(r.expiresAt) },
  ];

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        {error && <ErrorBanner message={error} />}
        <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No documents on file." />
      </div>
      <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
        <h2 className="text-sm font-semibold text-gray-900">Add document</h2>
        <TextInput label="Type" value={draft.type} onChange={(v) => setDraft((d) => ({ ...d, type: v }))} placeholder="ID_PROOF / CONTRACT" required />
        <TextInput label="Name" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} required />
        <TextInput label="File URL" value={draft.url} onChange={(v) => setDraft((d) => ({ ...d, url: v }))} required />
        <DateField label="Expires at" value={draft.expiresAt} onChange={(v) => setDraft((d) => ({ ...d, expiresAt: v }))} />
        <PrimaryButton type="submit" loading={saving}>
          Save document
        </PrimaryButton>
      </form>
    </div>
  );
}

function RequestsTab({ employeeId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    if (!employeeId) return;
    setError('');
    get(`/api/hr/documents/employees/${employeeId}/requests`, { page: 1, pageSize: 100 })
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.message || 'Failed to load requests.');
        setRows([]);
      });
  }, [employeeId]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  async function act(id, action) {
    setBusyId(id);
    setError('');
    try {
      await post(`/api/hr/documents/employees/${employeeId}/requests/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} request.`);
    } finally {
      setBusyId('');
    }
  }

  const columns = [
    { key: 'type', header: 'Request', render: (r) => <span className="font-medium text-gray-900">{r.subject || r.type}</span> },
    { key: 'purpose', header: 'Purpose', render: (r) => r.purpose || '—' },
    { key: 'created', header: 'Raised', render: (r) => formatAdminDate(r.createdAt) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        const s = String(r.status || '').toUpperCase();
        return (
          <div className="flex gap-2">
            {s === 'PENDING' && (
              <ActionButton disabled={busyId === r.id} onClick={() => act(r.id, 'start')}>
                Start
              </ActionButton>
            )}
            {(s === 'PENDING' || s === 'IN_PROGRESS') && (
              <>
                <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => act(r.id, 'fulfil')}>
                  Fulfil
                </ActionButton>
                <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => act(r.id, 'reject')}>
                  Reject
                </ActionButton>
              </>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No document requests." />
    </div>
  );
}

const TABS = [
  { key: 'documents', label: 'Documents' },
  { key: 'requests', label: 'Requests' },
];

export default function DocumentsPage() {
  const [employeeId, setEmployeeId] = useState('');
  const [active, setActive] = useState('');
  const [tab, setTab] = useState('documents');

  function onLookup(e) {
    e.preventDefault();
    setActive(employeeId.trim());
  }

  return (
    <div>
      <PageHeader title="Documents" subtitle="Employee documents and document requests" />

      <ExpiringPanel />

      <form onSubmit={onLookup} className="flex gap-2 mb-5">
        <input
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          placeholder="Employee ID"
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm w-80 focus:outline-none"
        />
        <button type="submit" className="px-4 py-2.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
          Load
        </button>
      </form>

      {!active ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-500">
          Enter an employee ID to view their documents and requests.
        </div>
      ) : (
        <>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
          {tab === 'documents' && <DocumentsTab employeeId={active} />}
          {tab === 'requests' && <RequestsTab employeeId={active} />}
        </>
      )}
    </div>
  );
}

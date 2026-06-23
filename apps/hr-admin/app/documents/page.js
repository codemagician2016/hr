'use client';

// Employee documents against /api/hr/documents/*. The document + request
// resources are per-employee (/employees/:employeeId/documents|requests), so
// the page takes an employee id, lists both, and supports uploading a document
// (POST .../documents) and fulfilling a request (POST .../requests/:id/fulfil).
// A tenant-wide "expiring soon" report (GET /expiring) anchors the top.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, TextInput, DateField, formatAdminDate, DocumentDropzone, maskDocumentNumber } from '@hr/ui';
import { get, post, del } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton } from '@/lib/ui';

// DocumentCategory enum (mirrors prisma/schema.prisma) for the upload picker.
const DOC_CATEGORIES = [
  'ID_PROOF', 'ADDRESS_PROOF', 'PAN', 'AADHAAR', 'PASSPORT', 'VISA', 'WORK_PERMIT',
  'EDUCATION', 'EXPERIENCE', 'OFFER_LETTER', 'CONTRACT', 'PAYSLIP_COPY',
  'TAX_DECLARATION', 'FORM16', 'BANK_PROOF', 'MEDICAL', 'POLICY_ACK', 'OTHER',
];
const VISIBILITIES = [
  ['HR_ONLY', 'HR only'],
  ['MANAGER_AND_HR', 'Manager & HR'],
  ['EMPLOYEE_VISIBLE', 'Employee visible'],
];

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
    { key: 'name', header: 'Document', render: (r) => <span className="font-medium text-gray-900">{r.name || r.category}</span> },
    { key: 'employee', header: 'Employee', render: (r) => r.employee ? [r.employee.firstName, r.employee.lastName].filter(Boolean).join(' ') : r.employeeId || '—' },
    { key: 'category', header: 'Category', render: (r) => r.category || '—' },
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
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState({ category: 'ID_PROOF', name: '', visibility: 'HR_ONLY', expiresAt: '' });

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

  // Upload a real EmployeeDocument: the dropzone hands us the base64 + client
  // hash; the server re-hashes + stores via s3.uploadDataUrl.
  async function onUpload(file) {
    setBusy(true);
    setError('');
    try {
      await post(`/api/hr/documents/employees/${employeeId}/documents`, {
        category: meta.category,
        name: meta.name || file.name,
        visibility: meta.visibility,
        expiresAt: meta.expiresAt || undefined,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        fileHash: file.fileHash,
        fileBase64: file.fileBase64,
      });
      setMeta((m) => ({ ...m, name: '', expiresAt: '' }));
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(id) {
    setBusy(true); setError('');
    try { await post(`/api/hr/documents/employees/${employeeId}/documents/${id}/verify`); load(); }
    catch (e) { setError(e.data?.message || e.message || 'Verify failed.'); }
    finally { setBusy(false); }
  }

  async function onDelete(id) {
    setBusy(true); setError('');
    try { await del(`/api/hr/documents/employees/${employeeId}/documents/${id}`); load(); }
    catch (e) { setError(e.data?.message || e.message || 'Delete failed.'); }
    finally { setBusy(false); }
  }

  const columns = [
    { key: 'name', header: 'Document', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'category', header: 'Category', render: (r) => r.category || '—' },
    { key: 'documentNumber', header: 'Number', render: (r) => (r.documentNumber ? maskDocumentNumber(r.documentNumber) : '—') },
    { key: 'fileUrl', header: 'File', render: (r) => (r.fileUrl ? <a href={r.fileUrl} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: 'var(--theme-primary)' }}>Open</a> : '—') },
    { key: 'integrity', header: 'Integrity', render: (r) => (r.fileHash ? <span title={r.fileHash} className="text-xs text-emerald-600">✓ hashed</span> : <span className="text-xs text-gray-400">—</span>) },
    { key: 'signatureStatus', header: 'Signature', render: (r) => (r.signatureStatus ? <StatusBadge status={r.signatureStatus} /> : '—') },
    { key: 'verifiedAt', header: 'Verified', render: (r) => (r.verifiedAt ? formatAdminDate(r.verifiedAt) : '—') },
    { key: 'expiresAt', header: 'Expires', render: (r) => formatAdminDate(r.expiresAt) },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex gap-2">
          {!r.verifiedAt && <ActionButton tone="positive" disabled={busy} onClick={() => onVerify(r.id)}>Verify</ActionButton>}
          <ActionButton tone="danger" disabled={busy} onClick={() => onDelete(r.id)}>Delete</ActionButton>
        </div>
      ),
    },
  ];

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        {error && <ErrorBanner message={error} />}
        <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No documents on file." />
      </div>
      <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
        <h2 className="text-sm font-semibold text-gray-900">Upload document</h2>
        <label className="block text-sm font-medium text-gray-700">
          Category
          <select value={meta.category} onChange={(e) => setMeta((m) => ({ ...m, category: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <TextInput label="Name (optional)" value={meta.name} onChange={(v) => setMeta((m) => ({ ...m, name: v }))} placeholder="Defaults to file name" />
        <label className="block text-sm font-medium text-gray-700">
          Visibility
          <select value={meta.visibility} onChange={(e) => setMeta((m) => ({ ...m, visibility: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {VISIBILITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <DateField label="Expires at (optional)" value={meta.expiresAt} onChange={(v) => setMeta((m) => ({ ...m, expiresAt: v }))} />
        <DocumentDropzone category={meta.category} busy={busy} onFile={onUpload} label="" />
      </div>
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
    { key: 'templateKind', header: 'Request', render: (r) => <span className="font-medium text-gray-900">{r.templateKind}</span> },
    { key: 'purpose', header: 'Purpose', render: (r) => r.purpose || '—' },
    { key: 'created', header: 'Raised', render: (r) => formatAdminDate(r.createdAt) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        const s = String(r.status || '').toUpperCase();
        // Letter GENERATION (fulfilment → EmployeeDocument) lands in slice 4f; here
        // a PENDING request can be cancelled.
        return (
          <div className="flex gap-2">
            {s === 'PENDING' && (
              <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => act(r.id, 'cancel')}>
                Cancel
              </ActionButton>
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
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm w-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]"
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

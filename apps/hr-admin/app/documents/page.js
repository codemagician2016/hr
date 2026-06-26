'use client';

// Employee documents against /api/hr/documents/*. The document + request
// resources are per-employee (/employees/:employeeId/documents|requests), so
// the page takes an employee id, lists both, and supports uploading a document
// (POST .../documents) and fulfilling a request (POST .../requests/:id/fulfil).
// A tenant-wide "expiring soon" report (GET /expiring) anchors the top.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, TextInput, DateField, formatAdminDate, DocumentDropzone, maskDocumentNumber } from '@hr/ui';
import { get, post, del } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel, ServerPagination } from '@/lib/ui';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';
import ModuleGuide from '@/components/ModuleGuide';

const PAGE_SIZES = [25, 50, 100];

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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);

  useEffect(() => {
    setLoading(true);
    get('/api/hr/documents/expiring', { page, pageSize })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load expiring documents.'))
      .finally(() => setLoading(false));
  }, [page, pageSize]);

  const items = asList(data);
  const total = data?.total ?? items.length;

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
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No documents expiring soon." />
      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun="documents"
        onPageChange={setPage}
        onPageSizeChange={(ps) => { setPage(1); setPageSize(ps); }}
      />
    </div>
  );
}

function DocumentsTab({ employeeId }) {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState({ category: 'ID_PROOF', name: '', visibility: 'HR_ONLY', expiresAt: '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[1]);

  const load = useCallback(() => {
    if (!employeeId) return;
    setError('');
    get(`/api/hr/documents/employees/${employeeId}/documents`, { page, pageSize })
      .then((r) => { setRows(asList(r)); setTotal(r?.total ?? asList(r).length); })
      .catch((e) => {
        setError(e.message || 'Failed to load documents.');
        setRows([]);
        setTotal(0);
      });
  }, [employeeId, page, pageSize]);

  // Reset to page 1 when the selected employee changes.
  useEffect(() => { setPage(1); }, [employeeId]);

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
        <ServerPagination
          page={page}
          pageSize={pageSize}
          total={total}
          sizes={PAGE_SIZES}
          noun="documents"
          onPageChange={setPage}
          onPageSizeChange={(ps) => { setPage(1); setPageSize(ps); }}
        />
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

// Employee search/autocomplete backed by GET /api/hr/employees. The admin
// clicks to see the directory, filters by name/code/email, and we hand the
// caller the selected employee object. F1 scoping is enforced server-side, so
// this only ever surfaces people the admin may see. Thin wrapper over the
// reusable EmployeeSearchSelect — keeps the { selected, onSelect, onClear }
// contract used by this page.
function EmployeePicker({ selected, onSelect, onClear }) {
  return (
    <div className="mb-5 max-w-md">
      <EmployeeSearchSelect
        label="Employee"
        tip="Click to browse the directory, then filter by name, code or work email."
        value={selected?.id || ''}
        selectedLabel={selected ? employeeLabel(selected) : ''}
        onSelect={(emp) => (emp ? onSelect(emp) : onClear())}
        placeholder="Search by name, code or email…"
      />
    </div>
  );
}

export default function DocumentsPage() {
  const [employee, setEmployee] = useState(null);
  const [tab, setTab] = useState('documents');

  const activeId = employee?.id || '';

  return (
    <div>
      <PageHeader title="Documents" subtitle="Employee documents and document requests" />

      <ModuleGuide
        id="documents"
        title="Manage employee documents and requests"
        what="A per-employee document vault with integrity hashing, verification and visibility controls — plus the requests an employee has raised (e.g. an experience or salary letter). The 'Expiring soon' panel at the top flags time-bound IDs across the company so nothing lapses unnoticed."
        steps={[
          "Review the 'Expiring soon' panel — it lists documents (passports, visas, work permits) nearing expiry across all employees.",
          "Search for an employee by name, code or work email to open their file.",
          "On the Documents tab, pick a Category (PAN, AADHAAR, FORM16, OFFER_LETTER, etc.), set Visibility (HR only / Manager & HR / Employee visible) and an optional expiry date, then drop the file to upload.",
          "Click Verify on an uploaded document once you've checked it; the green '✓ hashed' badge confirms the file's integrity hash was stored.",
          "Switch to the Requests tab to see letters the employee has raised, and Cancel any PENDING request that's no longer needed.",
        ]}
        example={<>For <b>Aarav Sharma</b> (code EMP-2041) you upload his <b>FORM16</b> for FY 2025-26 as <b>HR only</b>, and his <b>PASSPORT</b> with an expiry of <b>14 Mar 2027</b> set to <b>Employee visible</b>. The passport then surfaces in 'Expiring soon' a few months before it lapses, and the document number shows masked as <b>•••••567</b>.</>}
        tips={[
          "Document numbers (PAN/Aadhaar) are always masked in the table — only verify against the opened file, never paste the full number into the Name field.",
          "Set an Expires at date on passports, visas and work permits so they roll up into the company-wide 'Expiring soon' report.",
        ]}
      />

      <ExpiringPanel />

      <EmployeePicker
        selected={employee}
        onSelect={setEmployee}
        onClear={() => setEmployee(null)}
      />

      {!activeId ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-500">
          Search for an employee to view their documents and requests.
        </div>
      ) : (
        <>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
          {tab === 'documents' && <DocumentsTab employeeId={activeId} />}
          {tab === 'requests' && <RequestsTab employeeId={activeId} />}
        </>
      )}
    </div>
  );
}

'use client';

// Letterhead Manager (Feature 9 slice 9C) — /letters/letterheads.
//
// Lists the tenant's uploaded A4 letterhead PDFs, lets HR upload a new one
// (client-validated PDF ≤10MB via the shared DocumentDropzone → base64 data-URL),
// and manage each one's binding: mark it the fixed Default, bind it to a single
// LetterCategory, toggle active, or open the visual position-picker to place the
// 5 zones. CRUD goes through /api/hr/letters/letterheads (canManageLetters).
//
// No nav entry is added here — slice 9E owns the hr-admin "Letters" nav group;
// this page just lives under /letters/letterheads.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ErrorBanner, PrimaryButton, TextInput, DocumentDropzone } from '@hr/ui';
import { get, post, del, request } from '@/lib/api';
import { asList, PageHeader, DataTable, StatusBadge, ActionButton } from '@/lib/ui';

// PUT helper (the shared api lib exposes get/post/patch/del + request; the
// letterheads endpoints use PUT for both layout and metadata updates).
const put = (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data ?? {}) });

// LetterCategory enum (mirror prisma/schema.prisma:8782) for the binding picker.
const LETTER_CATEGORIES = [
  ['', 'Unbound'],
  ['EXPERIENCE', 'Experience / Service'],
  ['BONAFIDE', 'Bonafide / TWIMC'],
  ['EMPLOYMENT_PROOF', 'Employment proof'],
  ['SALARY_PROOF', 'Salary proof'],
  ['BANK', 'Bank confirmation'],
  ['CONTRACT', 'Contract / Appointment'],
  ['CUSTOM', 'Custom'],
];

function categoryLabel(value) {
  const m = LETTER_CATEGORIES.find((c) => c[0] === (value || ''));
  return m ? m[1] : value || 'Unbound';
}

function UploadPanel({ onCreated }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState(null); // DocumentDropzone payload { name, mimeType, sizeBytes, fileHash, fileBase64 } — chosen, not yet uploaded
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  // Choosing a file just STAGES it — we don't validate/upload here (that fought
  // the user: a memoized closure could see empty code/name, and it forced an
  // order: fill fields THEN pick). Validation + upload happen on the button.
  const onFile = useCallback((payload) => {
    setError('');
    setWarning('');
    setFile(payload || null);
  }, []);

  const canSubmit = !!(code.trim() && name.trim() && file && !busy);

  const submit = useCallback(async () => {
    if (!code.trim() || !name.trim()) { setError('Enter a code and a name.'); return; }
    if (!file || !file.fileBase64) { setError('Choose an A4 letterhead PDF.'); return; }
    setBusy(true);
    setError('');
    setWarning('');
    try {
      const created = await post('/api/hr/letters/letterheads', {
        code: code.trim(),
        name: name.trim(),
        fileBase64: file.fileBase64,
      });
      if (created.warning) setWarning(created.warning);
      setCode('');
      setName('');
      setFile(null);
      if (onCreated) onCreated(created);
    } catch (e) {
      setError(e.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }, [code, name, file, onCreated]);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 mb-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Upload a letterhead</h2>
      {error && <ErrorBanner message={error} />}
      {warning && (
        <p className="mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          {warning}
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <TextInput label="Code" value={code} onChange={setCode} placeholder="ACME-DEFAULT" />
        <TextInput label="Name" value={name} onChange={setName} placeholder="Acme default stationery" />
      </div>
      <DocumentDropzone
        label="A4 letterhead PDF"
        hint="PDF up to 10 MB — page 1 is used as the stationery underlay"
        accept="application/pdf"
        busy={busy}
        onFile={onFile}
      />
      {file && (
        <p className="mt-2 text-xs text-emerald-700">
          Selected: {file.name || 'letterhead.pdf'} — ready to upload.
        </p>
      )}
      <div className="mt-4">
        <PrimaryButton onClick={submit} disabled={!canSubmit} loading={busy}>
          Upload letterhead
        </PrimaryButton>
      </div>
    </div>
  );
}

export default function LetterheadsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/letters/letterheads')
      .then((res) => setRows(asList(res)))
      .catch((e) => setError(e.message || 'Failed to load letterheads.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const patchRow = useCallback(async (id, data) => {
    setError('');
    try {
      await put(`/api/hr/letters/letterheads/${id}`, data);
      load();
    } catch (e) {
      setError(e.message || 'Update failed.');
    }
  }, [load]);

  const removeRow = useCallback(async (id) => {
    setError('');
    try {
      await del(`/api/hr/letters/letterheads/${id}`);
      load();
    } catch (e) {
      setError(e.message || 'Delete failed.');
    }
  }, [load]);

  const columns = [
    {
      key: 'name',
      header: 'Letterhead',
      render: (r) => (
        <div>
          <span className="font-medium text-gray-900">{r.name}</span>
          <span className="block text-xs text-gray-400">{r.code}</span>
        </div>
      ),
    },
    {
      key: 'page',
      header: 'Page size',
      render: (r) => (r.pageWidthPt && r.pageHeightPt
        ? <span className="text-xs text-gray-500">{Math.round(r.pageWidthPt)}×{Math.round(r.pageHeightPt)}pt</span>
        : <span className="text-xs text-gray-400">—</span>),
    },
    {
      key: 'binding',
      header: 'Binding',
      render: (r) => (
        <div className="flex flex-col gap-1">
          {r.isDefault
            ? <StatusBadge status="DEFAULT" />
            : <span className="text-xs text-gray-500">{categoryLabel(r.letterCategory)}</span>}
          <select
            value={r.letterCategory || ''}
            onChange={(e) => patchRow(r.id, { letterCategory: e.target.value || null })}
            className="text-xs border border-gray-300 rounded-md px-1.5 py-1 bg-white"
          >
            {LETTER_CATEGORIES.map(([v, label]) => (
              <option key={v || 'none'} value={v}>{label}</option>
            ))}
          </select>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} />,
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cellClassName: 'text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <Link href={`/letters/letterheads/${r.id}`}>
            <ActionButton>Position picker</ActionButton>
          </Link>
          {!r.isDefault && (
            <ActionButton tone="positive" onClick={() => patchRow(r.id, { isDefault: true })}>
              Make default
            </ActionButton>
          )}
          {r.isDefault && (
            <ActionButton onClick={() => patchRow(r.id, { isDefault: false })}>
              Unset default
            </ActionButton>
          )}
          <ActionButton onClick={() => patchRow(r.id, { isActive: !r.isActive })}>
            {r.isActive ? 'Deactivate' : 'Activate'}
          </ActionButton>
          <ActionButton tone="danger" onClick={() => removeRow(r.id)}>Delete</ActionButton>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Letterheads"
        subtitle="Upload A4 stationery PDFs and place the writing area + field anchors with the visual picker. Resolution: template override → category binding → tenant default."
      />
      {error && <ErrorBanner message={error} />}
      <UploadPanel onCreated={load} />
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No letterheads yet. Upload an A4 PDF to get started."
      />
    </div>
  );
}

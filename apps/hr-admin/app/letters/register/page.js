'use client';

// Letter Register (Feature 9 §5.1, slice 9E). The tenant-wide register table:
//   columns: ref no · type · employee · status · issued-by · issued/created-at
//   filters: category + status + free-text search (refNo / employee)
//   actions: view (detail drawer) · download (PDF) · re-issue (new ref + chain)
//            · revoke (reason modal, canManageLetters — server-enforced)
//   export:  CSV of the current filter (GET /register?format=csv)
//
// Pagination is server-side ({items,total,page,pageSize,totalPages}). The server
// is the real RBAC/scope boundary; a revoke a non-checker attempts 403s server-side.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ErrorBanner, PrimaryButton, TextArea, Modal, ModalActions, Spinner, formatAdminDate,
} from '@hr/ui';
import { get, post } from '@/lib/api';
import {
  PageHeader, DataTable, StatusBadge, ActionButton, asList,
} from '@/lib/ui';
import { getPdf, downloadBlob, LETTER_CATEGORIES, LETTER_STATUSES } from '../lib';

const PAGE_SIZE = 25;

export default function RegisterPage() {
  const router = useRouter();
  const [rows, setRows] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [filters, setFilters] = useState({ search: '', category: '', status: '' });
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(() => {
    setError('');
    get('/api/hr/letters/register', {
      page, pageSize: PAGE_SIZE,
      search: filters.search.trim(), category: filters.category, status: filters.status,
    })
      .then((r) => {
        setRows(asList(r));
        setTotal(r.total ?? 0);
        setTotalPages(r.totalPages ?? 1);
      })
      .catch((e) => { setRows([]); setError(e.message || 'Failed to load the register.'); });
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  async function onDownload(row) {
    setBusyId(row.id); setError('');
    try {
      const blob = await getPdf(`/api/hr/letters/${row.id}/download`);
      downloadBlob(blob, `${(row.referenceNo || 'letter').replace(/\//g, '-')}.pdf`);
    } catch (e) {
      setError(e.message || 'Download failed.');
    } finally { setBusyId(''); }
  }

  async function onReissue(row) {
    if (!window.confirm(`Re-issue ${row.referenceNo}? A new reference number is minted and this letter is marked superseded.`)) return;
    setBusyId(row.id); setError('');
    try {
      await post(`/api/hr/letters/${row.id}/reissue`, {});
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Re-issue failed.');
    } finally { setBusyId(''); }
  }

  async function onRevokeConfirm(reason) {
    if (!revokeTarget) return;
    setBusyId(revokeTarget.id); setError('');
    try {
      await post(`/api/hr/letters/${revokeTarget.id}/revoke`, { reason });
      setRevokeTarget(null);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Revoke failed.');
    } finally { setBusyId(''); }
  }

  function exportCsv() {
    const base = String(process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
    const params = new URLSearchParams({ format: 'csv' });
    if (filters.search.trim()) params.set('search', filters.search.trim());
    if (filters.category) params.set('category', filters.category);
    if (filters.status) params.set('status', filters.status);
    window.open(`${base}/api/hr/letters/register?${params.toString()}`, '_blank');
  }

  const columns = [
    { key: 'referenceNo', header: 'Reference', render: (r) => <span className="font-mono text-xs">{r.referenceNo}</span> },
    { key: 'category', header: 'Type', render: (r) => <span className="text-gray-700">{r.category}</span> },
    { key: 'employee', header: 'Employee', render: (r) => (r.employee ? <span>{r.employee.name} <span className="text-gray-400">{r.employee.code}</span></span> : <span className="text-gray-400">Company-wide</span>) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'issuedBy', header: 'Issued by', render: (r) => <span className="text-gray-600 text-xs">{r.issuedByName || r.issuedBy || '—'}</span> },
    { key: 'issuedAt', header: 'Date', render: (r) => <span className="text-gray-500 text-xs">{formatAdminDate(r.issuedAt || r.createdAt)}</span> },
    {
      key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <ActionButton onClick={() => setDetail(r)} disabled={busyId === r.id}>View</ActionButton>
          <ActionButton onClick={() => onDownload(r)} disabled={busyId === r.id}>Download</ActionButton>
          {r.status === 'ISSUED' && (
            <ActionButton onClick={() => onReissue(r)} disabled={busyId === r.id}>Re-issue</ActionButton>
          )}
          {r.status !== 'VOIDED' && (
            <ActionButton tone="danger" onClick={() => setRevokeTarget(r)} disabled={busyId === r.id}>Revoke</ActionButton>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="max-w-7xl">
      <PageHeader
        title="Letter register"
        subtitle="Every issued letter, tenant-wide. Filter, search, export, and govern with re-issue / revoke."
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={exportCsv} className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">Export CSV</button>
            <PrimaryButton onClick={() => router.push('/letters/issue')}>Issue a letter</PrimaryButton>
          </div>
        )}
      />

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      {/* ── filters ── */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label htmlFor="reg-search" className="block text-xs text-gray-500 mb-1">Search</label>
          <input
            id="reg-search"
            type="search"
            value={filters.search}
            onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, search: e.target.value })); }}
            placeholder="Ref no or employee…"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-64"
          />
        </div>
        <FilterSelect label="Type" value={filters.category} options={LETTER_CATEGORIES} onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, category: v })); }} />
        <FilterSelect label="Status" value={filters.status} options={LETTER_STATUSES} onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, status: v })); }} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={rows === null}
        emptyText="No letters issued yet. Issue your first letter to populate the register."
        rowKey={(r) => r.id}
        caption="Letter register"
      />

      {/* ── pagination ── */}
      {rows && rows.length > 0 && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
          <span>{total} letter{total === 1 ? '' : 's'}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 border border-gray-300 rounded-md disabled:opacity-40">Prev</button>
            <span>Page {page} / {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 border border-gray-300 rounded-md disabled:opacity-40">Next</button>
          </div>
        </div>
      )}

      {revokeTarget && (
        <RevokeModal target={revokeTarget} busy={busyId === revokeTarget.id} onClose={() => setRevokeTarget(null)} onConfirm={onRevokeConfirm} />
      )}
      {detail && <DetailDrawer id={detail.id} onClose={() => setDetail(null)} />}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">All</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function RevokeModal({ target, busy, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Revoke ${target.referenceNo}`} onClose={onClose}>
      <p className="text-sm text-gray-600 mb-4">
        Revoking voids this letter (a legal record — it is never deleted), burns its reference number, and hides it from the employee’s portal. A reason is required and audited.
      </p>
      <TextArea label="Reason" value={reason} onChange={setReason} rows={3} maxLength={500} />
      <div className="mt-5">
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">Cancel</button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={!reason.trim() || busy}
            className="px-3 py-2 text-sm font-medium rounded-lg text-white bg-red-600 hover:bg-red-700 disabled:opacity-40"
          >
            {busy ? 'Revoking…' : 'Revoke letter'}
          </button>
        </ModalActions>
      </div>
    </Modal>
  );
}

function DetailDrawer({ id, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    get(`/api/hr/letters/${id}`).then(setData).catch((e) => setErr(e.message || 'Failed to load.'));
  }, [id]);
  return (
    <Modal title="Letter detail" onClose={onClose} size="lg">
      {err && <ErrorBanner message={err} />}
      {!data && !err ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : data ? (
        <dl className="space-y-2 text-sm">
          <Row k="Reference" v={<span className="font-mono">{data.referenceNo}</span>} />
          <Row k="Type" v={data.category} />
          <Row k="Status" v={<StatusBadge status={data.status} />} />
          <Row k="Subject" v={data.subject || '—'} />
          <Row k="Employee" v={data.employee ? `${[data.employee.firstName, data.employee.lastName].filter(Boolean).join(' ')} (${data.employee.code})` : 'Company-wide'} />
          <Row k="Template" v={data.template ? `${data.template.name} v${data.templateVersionAtIssue ?? '—'}` : '—'} />
          <Row k="Letterhead" v={data.letterhead ? data.letterhead.name : 'Branded fallback'} />
          <Row k="Issued by" v={data.issuedByName || data.issuedBy || '—'} />
          <Row k="Issued at" v={formatAdminDate(data.issuedAt || data.createdAt)} />
          <Row k="File SHA-256" v={<span className="font-mono text-xs break-all">{data.fileHash || '—'}</span>} />
          {data.supersedesLetterId && <Row k="Re-issues" v={<span className="font-mono text-xs">{data.supersedesLetterId}</span>} />}
          {data.supersededByLetterId && <Row k="Superseded by" v={<span className="font-mono text-xs">{data.supersededByLetterId}</span>} />}
          {data.voidedAt && <Row k="Voided" v={`${formatAdminDate(data.voidedAt)} — ${data.voidReason || ''}`} />}
          <div className="pt-3">
            <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Rendered body (snapshot)</p>
            <pre className="whitespace-pre-wrap text-xs text-gray-600 bg-gray-50 rounded-lg p-3 max-h-60 overflow-y-auto">{data.renderedBody}</pre>
          </div>
        </dl>
      ) : null}
    </Modal>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-500">{k}</dt>
      <dd className="text-gray-900 text-right">{v}</dd>
    </div>
  );
}

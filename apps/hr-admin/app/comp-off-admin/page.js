'use client';

// Comp-off console (Feature 30) against /api/hr/comp-off/*.
//  - Queue:   GET /queue → PENDING earned credits; approve/reject (canApproveLeave).
//  - Ledger:  paginated GET /credits — every credit (earned/used/expiring/lapsed),
//             scoped to the actor's sub-tree (F1).
//  - Grant:   POST /credits — HR manual grant (HR_GRANT, canManageOrg).
//  - Runs:    POST /runs/earn | /runs/expiry — ops triggers (canManageOrg).
// AVAIL is on the Leave console (apply a COMP_OFF leave) — not here.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, TextInput } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel, ServerPagination } from '@/lib/ui';

const TABS = [
  { key: 'queue', label: 'Approvals' },
  { key: 'ledger', label: 'Ledger' },
  { key: 'grant', label: 'Grant' },
];

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return String(d).slice(0, 10); }
}
function num(v) { return v == null ? 0 : Number(v); }

export default function CompOffAdminPage() {
  const [tab, setTab] = useState('queue');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // ── Approvals queue ──
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const loadQueue = useCallback(() => {
    setQueueLoading(true);
    get('/api/hr/comp-off/queue')
      .then((res) => setQueue((res && res.credits) || asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setQueueLoading(false));
  }, []);

  // ── Ledger ──
  const [ledger, setLedger] = useState([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const loadLedger = useCallback(() => {
    setLedgerLoading(true);
    const params = { page, pageSize };
    if (statusFilter) params.status = statusFilter;
    get('/api/hr/comp-off/credits', params)
      .then((res) => { setLedger((res && res.credits) || asList(res) || []); setTotal((res && res.total) || 0); })
      .catch((e) => setError(e.message))
      .finally(() => setLedgerLoading(false));
  }, [page, pageSize, statusFilter]);

  useEffect(() => { if (tab === 'queue') loadQueue(); }, [tab, loadQueue]);
  useEffect(() => { if (tab === 'ledger') loadLedger(); }, [tab, loadLedger]);

  async function decide(id, action, reason) {
    setError(''); setNotice('');
    try {
      await post(`/api/hr/comp-off/credits/${id}/${action}`, action === 'reject' ? { reason: reason || '' } : {});
      setNotice(`Credit ${action === 'approve' ? 'approved' : 'rejected'}.`);
      loadQueue();
    } catch (e) { setError(e.message); }
  }

  async function runJob(which) {
    setError(''); setNotice('');
    try {
      const r = await post(`/api/hr/comp-off/runs/${which}`, {});
      setNotice(`${which === 'earn' ? 'Earn' : 'Expiry'} runner: ${JSON.stringify(r)}`);
      if (tab === 'queue') loadQueue(); else if (tab === 'ledger') loadLedger();
    } catch (e) { setError(e.message); }
  }

  const queueCols = useMemo(() => [
    { key: 'emp', header: 'Employee', render: (r) => employeeLabel(r.employee || {}) },
    { key: 'sourceKind', header: 'Earned for', render: (r) => String(r.sourceKind || '').replace('_', ' ').toLowerCase() },
    { key: 'sourceDate', header: 'Worked on', render: (r) => fmtDate(r.sourceDate) },
    { key: 'quantity', header: 'Days', render: (r) => num(r.quantity) },
    { key: 'expiresOn', header: 'Expires', render: (r) => fmtDate(r.expiresOn) },
    {
      key: 'actions', header: '', render: (r) => (
        <div className="flex gap-2">
          <ActionButton tone="positive" onClick={() => decide(r.id, 'approve')}>Approve</ActionButton>
          <ActionButton tone="danger" onClick={() => decide(r.id, 'reject', '')}>Reject</ActionButton>
        </div>
      ),
    },
  ], []);

  const ledgerCols = useMemo(() => [
    { key: 'emp', header: 'Employee', render: (r) => employeeLabel(r.employee || {}) },
    { key: 'sourceKind', header: 'Source', render: (r) => String(r.sourceKind || '').replace('_', ' ').toLowerCase() },
    { key: 'sourceDate', header: 'Earned', render: (r) => fmtDate(r.sourceDate) },
    { key: 'quantity', header: 'Days', render: (r) => num(r.quantity) },
    { key: 'consumed', header: 'Used', render: (r) => num(r.consumed) },
    { key: 'remaining', header: 'Left', render: (r) => num(r.remaining) },
    { key: 'expiresOn', header: 'Expires', render: (r) => fmtDate(r.expiresOn) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '', render: (r) => (
        r.status === 'ACTIVE'
          ? <ActionButton tone="danger" onClick={() => voidCredit(r.id)}>Void</ActionButton>
          : null
      ),
    },
  ], []);

  async function voidCredit(id) {
    setError(''); setNotice('');
    try {
      await post(`/api/hr/comp-off/credits/${id}/void`, { reason: 'HR void' });
      setNotice('Credit voided.');
      loadLedger();
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Comp-off"
        subtitle="Earned compensatory-off credits — approve, grant, and track expiry. Employees avail comp-off on the Leave console."
        actions={(
          <div className="flex gap-2">
            <PrimaryButton onClick={() => runJob('earn')}>Run earn</PrimaryButton>
            <PrimaryButton onClick={() => runJob('expiry')}>Run expiry</PrimaryButton>
          </div>
        )}
      />

      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <div className="my-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div> : null}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'queue' && (
        <div className="mt-4">
          <DataTable columns={queueCols} rows={queue} loading={queueLoading} emptyText="No comp-off credits awaiting approval." rowKey={(r) => r.id} />
        </div>
      )}

      {tab === 'ledger' && (
        <div className="mt-4">
          <div className="mb-3 flex items-center gap-2">
            <label className="text-sm text-gray-600">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
            >
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING">Pending</option>
              <option value="EXHAUSTED">Used</option>
              <option value="EXPIRED">Expired</option>
              <option value="VOIDED">Voided</option>
            </select>
          </div>
          <DataTable columns={ledgerCols} rows={ledger} loading={ledgerLoading} emptyText="No comp-off credits in scope." rowKey={(r) => r.id} />
          <ServerPagination
            page={page} pageSize={pageSize} total={total} noun="credits"
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          />
        </div>
      )}

      {tab === 'grant' && <GrantForm onGranted={(msg) => { setNotice(msg); }} onError={setError} />}
    </div>
  );
}

// HR manual grant form (HR_GRANT). canManageOrg is enforced backend-side.
function GrantForm({ onGranted, onError }) {
  const [employeeId, setEmployeeId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [sourceDate, setSourceDate] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    onError(''); setBusy(true);
    try {
      const body = { employeeId: employeeId.trim(), quantity: Number(quantity), reason: reason || undefined };
      if (sourceDate) body.sourceDate = sourceDate;
      await post('/api/hr/comp-off/credits', body);
      onGranted('Comp-off granted.');
      setEmployeeId(''); setQuantity('1'); setReason(''); setSourceDate('');
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mt-4 max-w-lg rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3">
        <label className="mb-1 block text-sm font-medium text-gray-700">Employee ID</label>
        <TextInput value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="employee uuid" />
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Days</label>
          <TextInput type="number" step="0.5" min="0.5" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Custom expiry source date (optional)</label>
          <TextInput type="date" value={sourceDate} onChange={(e) => setSourceDate(e.target.value)} />
        </div>
      </div>
      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium text-gray-700">Reason</label>
        <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. off-system weekend support" />
      </div>
      <PrimaryButton type="submit" disabled={busy || !employeeId.trim()}>{busy ? 'Granting…' : 'Grant comp-off'}</PrimaryButton>
    </form>
  );
}

'use client';

// Reimbursement claims queue (Feature 11). Reads /api/hr/expenses/claims (paginated
// {items,total}, F1-SCOPED server-side: a Manager sees only their reporting sub-tree,
// Finance/HR see the tenant). Decisions POST to /claims/:id/{approve,reject,return}
// (canApproveExpense, engine-driven + SoD) and /reimburse (Finance settle). Each claim
// carries a POLICY VERDICT banner (green Within / amber Flagged / red Hard-cap) + the
// travel ID when it is booked against a trip.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, employeeLabel, moneyish, ServerPagination } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';

const STATUSES = ['', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED', 'CANCELLED'];
const VERDICTS = ['', 'OK', 'FLAGGED', 'AUTO_REJECTED', 'NO_POLICY'];
const PAGE_SIZES = [25, 50, 100];

function VerdictBadge({ v }) {
  if (!v || v === 'NO_POLICY') return <span className="text-xs text-gray-400">—</span>;
  const map = {
    OK: ['bg-green-100 text-green-800', 'Within policy'],
    FLAGGED: ['bg-amber-100 text-amber-800', 'Flagged'],
    AUTO_REJECTED: ['bg-red-100 text-red-800', 'Over hard cap'],
  };
  const [cls, label] = map[v] || ['bg-gray-100 text-gray-600', v];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

export default function ExpensesPage() {
  const [status, setStatus] = useState('SUBMITTED');
  const [verdict, setVerdict] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [detail, setDetail] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/expenses/claims', { status, policyVerdict: verdict, page, pageSize })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load claims.'))
      .finally(() => setLoading(false));
  }, [status, verdict, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  async function act(id, action, body) {
    setBusyId(id);
    setError('');
    try {
      await post(`/api/hr/expenses/claims/${id}/${action}`, body);
      load();
      if (detail && detail.id === id) openDetail(id);
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} claim.`);
    } finally {
      setBusyId('');
    }
  }

  async function openDetail(id) {
    try { setDetail(await get(`/api/hr/expenses/claims/${id}`)); }
    catch (e) { setError(e.message); }
  }

  const items = data?.items || [];
  const total = data?.total ?? items.length;

  const columns = [
    { key: 'number', header: 'Claim', render: (r) => <button onClick={() => openDetail(r.id)} className="font-medium text-blue-700 hover:underline">{r.claimNumber || r.id.slice(0, 8)}</button> },
    { key: 'employee', header: 'Employee', render: (r) => employeeLabel(r) },
    { key: 'type', header: 'Type', render: (r) => r.travelRequest ? <span className="text-xs text-indigo-600">{r.travelRequest.travelNumber}</span> : <span className="text-xs text-gray-500">Reimbursement</span> },
    { key: 'amount', header: 'Amount', render: (r) => moneyish(r.amount, r.currencyCode) },
    { key: 'policy', header: 'Policy', render: (r) => <VerdictBadge v={r.policyVerdict} /> },
    { key: 'submitted', header: 'Submitted', render: (r) => formatAdminDate(r.submittedAt || r.createdAt) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '',
      render: (r) => {
        const s = String(r.status || '').toUpperCase();
        if (s === 'SUBMITTED') return (
          <div className="flex gap-2">
            <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => act(r.id, 'approve')}>Approve</ActionButton>
            <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => act(r.id, 'reject', { reason: prompt('Reason for rejection?') || '' })}>Reject</ActionButton>
          </div>
        );
        if (s === 'APPROVED') return <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => act(r.id, 'reimburse', { paymentRef: prompt('Payment reference (optional)') || undefined })}>Reimburse</ActionButton>;
        return null;
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Reimbursements" subtitle="Employee expense claims — approve, return, reimburse" />

      <div className="mb-4 flex items-center gap-3">
        <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm">
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
        <label className="flex items-center text-sm text-gray-500">Policy <InfoTip text="Filter by the claim's worst bill verdict. Flagged claims are over a soft limit; Over-hard-cap bills were blocked at submit under HARD enforcement." /></label>
        <select value={verdict} onChange={(e) => { setPage(1); setVerdict(e.target.value); }} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm">
          {VERDICTS.map((v) => <option key={v} value={v}>{v || 'Any policy verdict'}</option>)}
        </select>
      </div>

      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No claims match." />

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun="claims"
        onPageChange={setPage}
        onPageSizeChange={(ps) => { setPage(1); setPageSize(ps); }}
      />

      {detail && <ClaimDetailModal claim={detail} onClose={() => setDetail(null)} onAct={act} busyId={busyId} />}
    </div>
  );
}

function ClaimDetailModal({ claim, onClose, onAct, busyId }) {
  const s = String(claim.status || '').toUpperCase();
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="mt-16 w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{claim.claimNumber} <StatusBadge status={claim.status} /></h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="mb-3 text-sm text-gray-600">
          {employeeLabel(claim)} · {moneyish(claim.amount, claim.currencyCode)}
          {claim.travelRequest ? <span className="ml-2 text-indigo-600">trip {claim.travelRequest.travelNumber}</span> : null}
        </div>
        {claim.policyVerdict && claim.policyVerdict !== 'NO_POLICY' && (
          <div className={`mb-3 rounded p-2 text-sm ${claim.policyVerdict === 'OK' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
            {claim.policyVerdict === 'OK' ? 'Within policy.' : `Policy: ${(claim.lines || []).filter((l) => l.policyStatus && l.policyStatus !== 'OK' && l.policyStatus !== 'NO_POLICY').length} bill(s) over budget — review below before approving.`}
          </div>
        )}
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500"><th className="py-1">Bill</th><th>Amount</th><th>Cap</th><th>Policy</th></tr></thead>
          <tbody>
            {(claim.lines || []).map((l) => (
              <tr key={l.id} className="border-t align-top">
                <td className="py-1">{l.description || l.category?.name || l.transportMode || (l.nights ? 'Hotel' : 'Bill')}{l.receiptUrl ? <span className="ml-1 text-xs text-blue-600">📎</span> : null}</td>
                <td>{moneyish(l.amount, claim.currencyCode)}</td>
                <td>{l.appliedCap != null ? moneyish(l.appliedCap, claim.currencyCode) : '—'}</td>
                <td><VerdictBadge v={l.policyStatus} />{l.policyReason ? <div className="text-xs text-gray-500">{l.policyReason}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {s === 'SUBMITTED' && (
          <div className="mt-4 flex gap-2">
            <ActionButton tone="positive" disabled={busyId === claim.id} onClick={() => onAct(claim.id, 'approve')}>Approve</ActionButton>
            <ActionButton tone="neutral" disabled={busyId === claim.id} onClick={() => onAct(claim.id, 'return', { reason: prompt('What needs fixing?') || '' })}>Return for changes</ActionButton>
            <ActionButton tone="danger" disabled={busyId === claim.id} onClick={() => onAct(claim.id, 'reject', { reason: prompt('Reason for rejection?') || '' })}>Reject</ActionButton>
          </div>
        )}
        {s === 'APPROVED' && (
          <div className="mt-4"><ActionButton tone="positive" disabled={busyId === claim.id} onClick={() => onAct(claim.id, 'reimburse', { paymentRef: prompt('Payment reference (optional)') || undefined })}>Mark reimbursed</ActionButton></div>
        )}
      </div>
    </div>
  );
}

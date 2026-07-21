'use client';

// Reimbursement claims queue (Feature 11). Reads /api/hr/expenses/claims (paginated
// {items,total}, F1-SCOPED server-side: a Manager sees only their reporting sub-tree,
// Finance/HR see the tenant). Decisions POST to /claims/:id/{approve,reject,return}
// (canApproveExpense, engine-driven + SoD) and /reimburse (Finance settle). Each claim
// carries a POLICY VERDICT banner (green Within / amber Flagged / red Hard-cap) + the
// travel ID when it is booked against a trip.
//
// Feature 45/26 — APPROVED claims additionally show the payout channel as a chip plus a
// small flip control (PAY_SEPARATELY ↔ PAY_VIA_PAYROLL) → PATCH /claims/:id/payout-channel
// (frozen with a 409 once a pay run has stamped the claim).

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, employeeLabel, moneyish, ServerPagination } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';

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

// Feature 45/26 — the claim's payout channel as a small chip.
function ChannelChip({ channel }) {
  const via = channel === 'PAY_VIA_PAYROLL';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${via ? 'bg-indigo-100 text-indigo-800' : 'bg-gray-100 text-gray-600'}`}>
      {via ? 'Via payroll' : 'Paid separately'}
    </span>
  );
}

// Chip + flip control for an APPROVED claim's payout channel.
function ChannelControl({ claim, busy, onFlip }) {
  const value = claim.payoutChannel === 'PAY_VIA_PAYROLL' ? 'PAY_VIA_PAYROLL' : 'PAY_SEPARATELY';
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-xs text-gray-500">Payout</span>
      <InfoTip text="Pay separately settles the claim outside payroll (Reimburse below). Pay via payroll adds it to the next pay run's net as a tax-exempt reimbursement line. Frozen once a run picks the claim up." />
      <select
        value={value}
        disabled={busy}
        onChange={(e) => onFlip(claim.id, e.target.value)}
        className="rounded-md border border-gray-300 px-1.5 py-0.5 text-xs disabled:opacity-50"
      >
        <option value="PAY_SEPARATELY">Pay separately</option>
        <option value="PAY_VIA_PAYROLL">Pay via payroll</option>
      </select>
    </span>
  );
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

  // Flip an APPROVED claim's payout channel (409 once a pay run has stamped it).
  async function flipChannel(id, payoutChannel) {
    setBusyId(id);
    setError('');
    try {
      await patch(`/api/hr/expenses/claims/${id}/payout-channel`, { payoutChannel });
      load();
      if (detail && detail.id === id) openDetail(id);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to change the payout channel.');
    } finally {
      setBusyId('');
    }
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
    {
      key: 'status', header: 'Status',
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={r.status} />
          {String(r.status || '').toUpperCase() === 'APPROVED' && <ChannelChip channel={r.payoutChannel} />}
        </div>
      ),
    },
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
        if (s === 'APPROVED') return (
          <div className="flex flex-wrap items-center gap-2">
            <ChannelControl claim={r} busy={busyId === r.id} onFlip={flipChannel} />
            <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => act(r.id, 'reimburse', { paymentRef: prompt('Payment reference (optional)') || undefined })}>Reimburse</ActionButton>
          </div>
        );
        return null;
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Reimbursements" subtitle="Employee expense claims — approve, return, reimburse" />

      <ModuleGuide
        id="expenses"
        title="Review and settle employee expense claims"
        what="This is the reimbursement approval queue. Employees submit expense claims (travel, food, hotel) against your policy; you approve, return for fixes, or reject them, then Finance marks the approved ones reimbursed. The policy engine pre-checks every bill so you see what's within budget before deciding."
        steps={[
          "Pick a status — the queue opens on Submitted (claims waiting on you).",
          "Use the Policy filter to surface only Flagged or Over-hard-cap claims when you're short on time.",
          "Click a claim number to open the bill-by-bill breakdown, each line's cap, and any receipts (📎).",
          "Approve a clean claim, or Return for changes when a receipt is missing, or Reject with a reason.",
          "Once approved, Finance hits Reimburse and records the payment reference (UTR/NEFT).",
        ]}
        example={<>Aarav Sharma submits a <b>₹18,400</b> Bengaluru trip claim against travel <b>TRV-2026-0142</b>: a ₹6,200 hotel night (cap ₹5,000) shows <b>Flagged</b>. You open it, see the amber line, Return it for a corporate-rate invoice, then Approve the revised <b>₹17,200</b>. Finance reimburses it with NEFT ref <b>HDFC0001234</b> in the June 2026 cycle.</>}
        tips={[
          "Flagged = over a soft limit (you can still approve with judgement); Over-hard-cap bills were already blocked at submit.",
          "You only see claims in your reporting sub-tree as a Manager — Finance and HR see the whole tenant.",
        ]}
      />

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

      {detail && <ClaimDetailModal claim={detail} onClose={() => setDetail(null)} onAct={act} onFlipChannel={flipChannel} busyId={busyId} />}
    </div>
  );
}

function ClaimDetailModal({ claim, onClose, onAct, onFlipChannel, busyId }) {
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
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <ChannelControl claim={claim} busy={busyId === claim.id} onFlip={onFlipChannel} />
            <ActionButton tone="positive" disabled={busyId === claim.id} onClick={() => onAct(claim.id, 'reimburse', { paymentRef: prompt('Payment reference (optional)') || undefined })}>Mark reimbursed</ActionButton>
          </div>
        )}
      </div>
    </div>
  );
}

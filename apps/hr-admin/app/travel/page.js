'use client';

// Travel / outdoor-duty queue (Feature 11). Reads /api/hr/expenses/trips (paginated,
// F1-scoped). Pre-trip decisions POST to /trips/:id/{approve,reject} (canApproveExpense,
// engine-driven via the TRAVEL workflow + SoD). Each trip shows its TRV-#### id, the
// resolved destination tier, dates, and the count of bills booked against it.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, employeeLabel } from '@/lib/ui';
import ModuleGuide from '@/components/ModuleGuide';

const STATUSES = ['', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const PAGE_SIZE = 25;

export default function TravelPage() {
  const [status, setStatus] = useState('SUBMITTED');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true); setError('');
    get('/api/hr/expenses/trips', { status, page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load trips.'))
      .finally(() => setLoading(false));
  }, [status, page]);

  useEffect(() => { load(); }, [load]);

  async function act(id, action, body) {
    setBusyId(id); setError('');
    try { await post(`/api/hr/expenses/trips/${id}/${action}`, body); load(); }
    catch (e) { setError(e.data?.message || e.message || `Failed to ${action} trip.`); }
    finally { setBusyId(''); }
  }

  const items = data?.items || [];
  const total = data?.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = [
    { key: 'trv', header: 'Travel ID', render: (r) => <span className="font-medium text-gray-900">{r.travelNumber}</span> },
    { key: 'employee', header: 'Employee', render: (r) => employeeLabel(r) },
    { key: 'purpose', header: 'Purpose', render: (r) => <span className="text-sm">{r.purpose}{r.isOutdoorDuty ? <span className="ml-1 text-xs text-gray-400">(outdoor duty)</span> : null}</span> },
    { key: 'route', header: 'Route', render: (r) => <span className="text-sm">{r.originCity || '—'} → {r.destCity || '—'}{r.destTier ? <span className="ml-1 text-xs text-gray-400">{r.destTier}</span> : null}</span> },
    { key: 'dates', header: 'Dates', render: (r) => <span className="text-xs text-gray-500">{formatAdminDate(r.startAt)} → {formatAdminDate(r.endAt)}</span> },
    { key: 'bills', header: 'Bills', render: (r) => r._count?.claims || 0 },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '',
      render: (r) => String(r.status).toUpperCase() === 'SUBMITTED' ? (
        <div className="flex gap-2">
          <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => act(r.id, 'approve')}>Approve</ActionButton>
          <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => act(r.id, 'reject', { reason: prompt('Reason for rejection?') || '' })}>Reject</ActionButton>
        </div>
      ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title="Travel & outdoor duty" subtitle="Pre-trip approvals — employees submit bills against an approved travel ID" />
      <ModuleGuide
        id="travel"
        title="Approve travel before bills can be claimed"
        what="This is the pre-trip approval queue for business travel and outdoor duty. Each request gets a TRV-#### travel ID; employees can only book expense bills against an approved ID, so your decision here gates the whole claim trail."
        steps={[
          "Leave the status filter on Submitted to see requests waiting on you.",
          "Open a row and check the employee, purpose, route and destination tier (e.g. Tier-1 Mumbai vs Tier-2 Pune) — the tier drives the per-diem and hotel caps.",
          "Confirm the dates and whether it is flagged as outdoor duty.",
          "Click Approve to issue the travel ID, or Reject and enter a reason that goes back to the employee.",
          "Track booked bills in the Bills column; switch the filter to In progress / Completed to follow trips after approval.",
        ]}
        example={<>Aarav Sharma of <b>Acme India Pvt Ltd</b> submits <b>TRV-2041</b> — Bengaluru → Mumbai (<b>Tier-1</b>), 12–14 June 2026, purpose "client onsite". You approve it; he then books a <b>₹6,200</b> flight and <b>₹4,500/night</b> hotel against TRV-2041, which surface here under Bills.</>}
        tips={[
          "Reject with a clear reason — the employee sees it and reuses the same TRV id when resubmitting.",
          "A higher destination tier means higher allowed per-diem and lodging limits, so verify origin → dest before approving.",
        ]}
      />
      <div className="mb-4 flex items-center gap-3">
        <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm">
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No trips match." />
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50">Previous</button>
          <span className="text-gray-500">Page {page} of {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50">Next</button>
        </div>
      )}
    </div>
  );
}

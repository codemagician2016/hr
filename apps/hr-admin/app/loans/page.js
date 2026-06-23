'use client';

// Employee loans / salary advances against /api/hr/loans (GET '/' paginated
// {items,total}). Lifecycle DRAFT → PENDING → APPROVED → DISBURSED → CLOSED
// with REJECTED/CANCELLED exits; lifecycle transitions POST to /:id/<action>.
// Reads need canViewCompensation, transitions canManageCompensation.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, employeeLabel, moneyish, ServerPagination } from '@/lib/ui';

const STATUSES = ['', 'DRAFT', 'PENDING', 'APPROVED', 'DISBURSED', 'CLOSED', 'REJECTED', 'CANCELLED'];
const PAGE_SIZES = [25, 50, 100];

// Which transition buttons to show for each lifecycle state.
const NEXT_ACTIONS = {
  DRAFT: [{ action: 'submit', label: 'Submit', tone: 'neutral' }],
  PENDING: [
    { action: 'approve', label: 'Approve', tone: 'positive' },
    { action: 'reject', label: 'Reject', tone: 'danger' },
  ],
  APPROVED: [{ action: 'disburse', label: 'Disburse', tone: 'positive' }],
  DISBURSED: [{ action: 'close', label: 'Close', tone: 'neutral' }],
};

export default function LoansPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/loans', { status, page, pageSize })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load loans.'))
      .finally(() => setLoading(false));
  }, [status, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id, action) {
    setBusyId(id);
    setError('');
    try {
      await post(`/api/hr/loans/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} loan.`);
    } finally {
      setBusyId('');
    }
  }

  const items = data?.items || [];
  const total = data?.total ?? items.length;

  const columns = [
    { key: 'number', header: 'Loan', render: (r) => <span className="font-medium text-gray-900">{r.loanNumber || r.id.slice(0, 8)}</span> },
    { key: 'employee', header: 'Employee', render: (r) => employeeLabel(r) },
    { key: 'type', header: 'Type', render: (r) => r.loanType || '—' },
    { key: 'principal', header: 'Principal', render: (r) => moneyish(r.principal, r.currencyCode) },
    { key: 'outstanding', header: 'Outstanding', render: (r) => moneyish(r.outstanding, r.currencyCode) },
    { key: 'emi', header: 'EMI', render: (r) => moneyish(r.emiAmount, r.currencyCode) },
    { key: 'start', header: 'Start', render: (r) => formatAdminDate(r.startDate) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        const actions = NEXT_ACTIONS[String(r.status || '').toUpperCase()];
        if (!actions) return null;
        return (
          <div className="flex gap-2">
            {actions.map((a) => (
              <ActionButton key={a.action} tone={a.tone} disabled={busyId === r.id} onClick={() => act(r.id, a.action)}>
                {a.label}
              </ActionButton>
            ))}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Loans" subtitle="Employee loans and salary advances" />

      <div className="flex items-center gap-3 mb-4">
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || 'All statuses'}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBanner message={error} />}

      <DataTable columns={columns} rows={items} loading={loading} emptyText="No loans match." />

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun="loans"
        onPageChange={setPage}
        onPageSizeChange={(ps) => {
          setPage(1);
          setPageSize(ps);
        }}
      />
    </div>
  );
}

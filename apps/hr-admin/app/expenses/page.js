'use client';

// Expense claims against /api/hr/expenses/claims (paginated {items,total}).
// Workflow actions POST to /claims/:id/{submit,approve,reject,reimburse}; the
// admin console surfaces approve/reject for SUBMITTED claims and reimburse for
// APPROVED ones. Reads need canViewEmployees, actions canManageEmployees.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, employeeLabel, moneyish } from '@/lib/ui';

const STATUSES = ['', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED', 'CANCELLED'];
const PAGE_SIZE = 25;

export default function ExpensesPage() {
  const [status, setStatus] = useState('SUBMITTED');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/expenses/claims', { status, page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load claims.'))
      .finally(() => setLoading(false));
  }, [status, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id, action) {
    setBusyId(id);
    setError('');
    try {
      await post(`/api/hr/expenses/claims/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} claim.`);
    } finally {
      setBusyId('');
    }
  }

  const items = data?.items || [];
  const total = data?.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = [
    { key: 'number', header: 'Claim', render: (r) => <span className="font-medium text-gray-900">{r.claimNumber || r.number || r.id.slice(0, 8)}</span> },
    { key: 'employee', header: 'Employee', render: (r) => employeeLabel(r) },
    { key: 'category', header: 'Category', render: (r) => r.category?.name || r.categoryName || '—' },
    { key: 'amount', header: 'Amount', render: (r) => moneyish(r.totalAmount ?? r.amount, r.currencyCode) },
    { key: 'submitted', header: 'Submitted', render: (r) => formatAdminDate(r.submittedAt || r.createdAt) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        const s = String(r.status || '').toUpperCase();
        if (s === 'SUBMITTED') {
          return (
            <div className="flex gap-2">
              <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => act(r.id, 'approve')}>
                Approve
              </ActionButton>
              <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => act(r.id, 'reject')}>
                Reject
              </ActionButton>
            </div>
          );
        }
        if (s === 'APPROVED') {
          return (
            <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => act(r.id, 'reimburse')}>
              Reimburse
            </ActionButton>
          );
        }
        return null;
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Expenses" subtitle="Employee expense claims" />

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

      <DataTable columns={columns} rows={items} loading={loading} emptyText="No claims match." />

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
          >
            Previous
          </button>
          <span className="text-gray-500">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

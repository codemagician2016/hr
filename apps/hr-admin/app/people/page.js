'use client';

// Employees list: search (q) + status filter + pagination against the
// paginated GET /api/hr/employees envelope {items,total,page,pageSize}.
// URL is the source of truth for q/status/page so links (from dashboard
// tiles) and back/forward work. @hr/ui has no Table primitive, so we render
// a styled <table> here and reuse Spinner/ErrorBanner/Empty/TextInput.

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Spinner, ErrorBanner, Empty, formatAdminDate } from '@hr/ui';
import { get } from '@/lib/api';
import { ServerPagination } from '@/lib/ui';

const STATUSES = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'on_leave', label: 'On leave' },
  { value: 'terminated', label: 'Terminated' },
];

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZES = [20, 50, 100];

// Backend stores the EmployeeStatus enum in UPPER_SNAKE (ACTIVE, ON_LEAVE…).
// Normalise before matching so badges/labels render regardless of casing.
function statusBadgeClass(status) {
  switch (String(status || '').toUpperCase()) {
    case 'ACTIVE':
      return 'bg-green-50 text-green-700 border-green-200';
    case 'PROBATION':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'ON_LEAVE':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'NOTICE_PERIOD':
      return 'bg-orange-50 text-orange-700 border-orange-200';
    case 'SUSPENDED':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'TERMINATED':
    case 'RETIRED':
      return 'bg-gray-100 text-gray-600 border-gray-200';
    default:
      return 'bg-gray-50 text-gray-600 border-gray-200';
  }
}

// "ON_LEAVE" → "On leave" — a human label from the enum.
function statusLabel(status) {
  if (!status) return 'Unknown';
  const s = String(status).replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function PeopleInner() {
  const router = useRouter();
  const params = useSearchParams();

  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
  const pageSize = PAGE_SIZES.includes(parseInt(params.get('pageSize') || '', 10))
    ? parseInt(params.get('pageSize'), 10)
    : DEFAULT_PAGE_SIZE;

  const [search, setSearch] = useState(q);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setSearch(q);
  }, [q]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    get('/api/hr/employees', { q, status, page, pageSize })
      .then((res) => {
        if (alive) setData(res);
      })
      .catch((err) => {
        if (alive) setError(err.message || 'Failed to load employees.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [q, status, page, pageSize]);

  function pushQuery(next) {
    const sp = new URLSearchParams();
    const merged = { q, status, page, pageSize, ...next };
    if (merged.q) sp.set('q', merged.q);
    if (merged.status) sp.set('status', merged.status);
    if (merged.page && merged.page > 1) sp.set('page', String(merged.page));
    if (merged.pageSize && merged.pageSize !== DEFAULT_PAGE_SIZE) sp.set('pageSize', String(merged.pageSize));
    router.push(`/people${sp.toString() ? `?${sp.toString()}` : ''}`);
  }

  const items = data?.items || [];
  const total = data?.total ?? items.length;

  const pageInfo = useMemo(() => {
    if (!total) return '0 employees';
    const from = (page - 1) * pageSize + 1;
    const to = Math.min(total, page * pageSize);
    return `${from}–${to} of ${total}`;
  }, [page, pageSize, total]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">People</h1>
          <p className="text-sm text-gray-500">{pageInfo}</p>
        </div>
        {/* FLAG (Feature 17): the default "Add employee" CTA is now the Onboard-by-CTC
            wizard (creates the person AND their pay in one step). The bare pay-less
            form stays as an explicit "Add without pay (advanced)" link. */}
        <div className="flex items-center gap-3">
          <Link href="/people/new" className="text-sm text-gray-500 hover:underline">Add without pay (advanced)</Link>
          <Link
            href="/people/onboard"
            className="px-4 py-2 text-white text-sm font-semibold rounded-lg"
            style={{ backgroundColor: 'var(--theme-primary)' }}
          >
            Add employee
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            pushQuery({ q: search.trim(), page: 1 });
          }}
          className="flex gap-2"
        >
          <label htmlFor="people-search" className="sr-only">
            Search employees by name, code, or email
          </label>
          <input
            id="people-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, email…"
            className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm w-72"
          />
          <button
            type="submit"
            className="px-4 py-2.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Search
          </button>
        </form>
        <label htmlFor="people-status" className="sr-only">
          Filter by status
        </label>
        <select
          id="people-status"
          value={status}
          onChange={(e) => pushQuery({ status: e.target.value, page: 1 })}
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
        {loading ? (
          <div className="py-12 flex justify-center">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty text="No employees match your filters." />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Employees</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
                <th scope="col" className="px-4 py-3 font-medium">Code</th>
                <th scope="col" className="px-4 py-3 font-medium">Name</th>
                <th scope="col" className="px-4 py-3 font-medium">Department</th>
                <th scope="col" className="px-4 py-3 font-medium">Designation</th>
                <th scope="col" className="px-4 py-3 font-medium">Email</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              {items.map((emp) => (
                <tr key={emp.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-500">{emp.code}</td>
                  <td className="px-4 py-3">
                    <Link href={`/people/${emp.id}`} className="font-medium text-gray-900 hover:underline">
                      {[emp.firstName, emp.lastName].filter(Boolean).join(' ') || '—'}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {emp.department?.name || <span className="text-gray-400">Unassigned</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {emp.designation?.name || <span className="text-gray-400">Unassigned</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {emp.workEmail ? (
                      <a href={`mailto:${emp.workEmail}`} className="hover:underline">{emp.workEmail}</a>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(
                        emp.status
                      )}`}
                    >
                      {statusLabel(emp.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {emp.hireDate ? formatAdminDate(emp.hireDate) : <span className="text-gray-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun="employees"
        onPageChange={(p) => pushQuery({ page: p })}
        onPageSizeChange={(ps) => pushQuery({ pageSize: ps, page: 1 })}
      />
    </div>
  );
}

export default function PeoplePage() {
  // useSearchParams requires a Suspense boundary in the app router.
  return (
    <Suspense fallback={<Spinner />}>
      <PeopleInner />
    </Suspense>
  );
}

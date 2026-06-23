'use client';

// Payslips list — the logged-in employee's own payslips.
//
// Wired to the REAL contract route GET /api/hr/me/payslips (employee/customer
// session, cookie-authed). The route is implemented by the backend agent; until
// it lands in a given environment we degrade a 404 to a friendly empty state so
// the page stays branded and shippable.

import { useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { money, formatPeriod } from '@/lib/format';
import { ServerPagination } from '@/lib/pagination';

const PAGE_SIZES = [10, 25, 50];

function PayslipsInner() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const { data, loading, error } = useApi(`/api/hr/me/payslips?page=${page}&pageSize=${pageSize}`, {
    deps: [page, pageSize],
    select: (b) => (Array.isArray(b) ? { items: b, total: b.length } : { items: b?.items || b?.payslips || [], total: b?.total ?? (b?.items || []).length }),
  });
  const items = data?.items || [];
  const total = data?.total ?? items.length;

  if (loading) return <Centered><Spinner /></Centered>;

  // The route may not be deployed yet — treat 404 as "no payslips" rather than
  // a hard error so the page still renders branded and usable.
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load payslips.'} />;
  }

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Payslips</h1>

      {items.length === 0 ? (
        <Empty text="No payslips available yet." />
      ) : (
        <>
        <ul className="space-y-2">
          {items.map((p) => {
            const net = p.net ?? p.netPay ?? p.netPayable;
            const currency = p.currency || p.currencyCode || 'INR';
            return (
              <li key={p.id}>
                <Link
                  href={`/payslips/${encodeURIComponent(p.id)}`}
                  className="flex items-center justify-between rounded-xl border bg-white px-4 py-3 shadow-sm active:scale-[0.99]"
                  style={{ borderColor: 'var(--theme-border)' }}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                      {formatPeriod(p.period || p)}
                    </span>
                    {p.status && (
                      <span className="block text-xs" style={{ color: 'var(--theme-muted)' }}>
                        {String(p.status).toLowerCase()}
                      </span>
                    )}
                  </span>
                  <span className="text-sm font-semibold" style={{ color: 'var(--theme-primary)' }}>
                    {money(net, currency)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <ServerPagination
          page={page}
          pageSize={pageSize}
          total={total}
          sizes={PAGE_SIZES}
          noun="payslips"
          onPageChange={setPage}
          onPageSizeChange={(ps) => { setPage(1); setPageSize(ps); }}
        />
        </>
      )}
    </div>
  );
}

export default function PayslipsPage() {
  return (
    <AppShell>
      <PayslipsInner />
    </AppShell>
  );
}

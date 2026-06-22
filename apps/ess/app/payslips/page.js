'use client';

// Payslips list.
//
// STUB WIRE-UP: the payslip read route is a later backend task. We fetch from
// /api/hr/me/payslips (clearly marked) and degrade gracefully to an empty
// state if it 404s, so the page is shippable now and only the path changes
// when the real route lands.

import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';

// TODO(payslips): swap to the real read route once implemented in the backend.
const PAYSLIPS_PATH = '/api/hr/me/payslips';

function formatPeriod(p) {
  if (!p) return '';
  if (p.label) return p.label;
  if (p.month && p.year) return `${p.month} ${p.year}`;
  if (p.periodStart) return new Date(p.periodStart).toLocaleDateString();
  return p.id || '';
}

function money(net) {
  if (net == null) return '';
  const amount = typeof net === 'object' ? net.amount : net;
  const currency = (typeof net === 'object' && net.currency) || 'INR';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
  } catch {
    return String(amount);
  }
}

function PayslipsInner() {
  const { data, loading, error } = useApi(PAYSLIPS_PATH);
  const items = Array.isArray(data) ? data : (data?.items || []);

  if (loading) return <Centered><Spinner /></Centered>;

  // The stub route may not exist yet — treat 404 as "no payslips" rather than
  // a hard error so the page still renders branded and usable.
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load payslips.'} />;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>Payslips</h1>

      {items.length === 0 ? (
        <Empty text="No payslips available yet." />
      ) : (
        <ul className="space-y-2">
          {items.map((p) => (
            <li key={p.id}>
              <Link
                href={`/payslips/${encodeURIComponent(p.id)}`}
                className="flex items-center justify-between rounded-xl border bg-white px-4 py-3 shadow-sm active:scale-[0.99]"
                style={{ borderColor: 'var(--theme-border)' }}
              >
                <span className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                  {formatPeriod(p.period || p)}
                </span>
                <span className="text-sm font-semibold" style={{ color: 'var(--theme-primary)' }}>
                  {money(p.net ?? p.netPay)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
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

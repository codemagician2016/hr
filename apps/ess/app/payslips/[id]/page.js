'use client';

// Payslip detail.
//
// STUB WIRE-UP: the single-payslip read route is a later backend task. We fetch
// from /api/hr/me/payslips/:id (clearly marked) and render whatever line items
// the payload carries; the path is the only thing that changes when the real
// route lands.

import Link from 'next/link';
import { useParams } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';

function money(value, currency = 'INR') {
  if (value == null) return '—';
  const amount = typeof value === 'object' ? value.amount : value;
  const code = (typeof value === 'object' && value.currency) || currency;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(Number(amount));
  } catch {
    return String(amount);
  }
}

function Row({ label, value, strong }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span style={{ color: strong ? 'var(--theme-text)' : 'var(--theme-muted)' }}
            className={strong ? 'font-semibold' : ''}>{label}</span>
      <span style={{ color: 'var(--theme-text)' }} className={strong ? 'font-semibold' : ''}>{value}</span>
    </div>
  );
}

function PayslipDetailInner() {
  const params = useParams();
  const id = params?.id;
  // TODO(payslips): swap to the real single-read route once implemented.
  const { data, loading, error } = useApi(id ? `/api/hr/me/payslips/${encodeURIComponent(id)}` : null);

  if (loading) return <Centered><Spinner /></Centered>;
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load this payslip.'} />;
  }

  const slip = data?.payslip || data;
  const currency = slip?.currency || 'INR';
  const earnings = slip?.earnings || slip?.lineItems?.earnings || [];
  const deductions = slip?.deductions || slip?.lineItems?.deductions || [];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm">
        <Link href="/payslips" style={{ color: 'var(--theme-primary)' }}>← Payslips</Link>
      </div>

      {!slip ? (
        <Empty text="Payslip not found." />
      ) : (
        <>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>
            {slip.period?.label || slip.label || 'Payslip'}
          </h1>

          <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>Earnings</h2>
            {earnings.length === 0 ? (
              <p className="py-2 text-sm" style={{ color: 'var(--theme-muted)' }}>No line items.</p>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--theme-border)' }}>
                {earnings.map((e, i) => (
                  <Row key={i} label={e.label || e.name} value={money(e.amount, currency)} />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>Deductions</h2>
            {deductions.length === 0 ? (
              <p className="py-2 text-sm" style={{ color: 'var(--theme-muted)' }}>No line items.</p>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--theme-border)' }}>
                {deductions.map((d, i) => (
                  <Row key={i} label={d.label || d.name} value={money(d.amount, currency)} />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl p-4" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium opacity-90">Net pay</span>
              <span className="text-lg font-bold">{money(slip.net ?? slip.netPay, currency)}</span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default function PayslipDetailPage() {
  return (
    <AppShell>
      <PayslipDetailInner />
    </AppShell>
  );
}

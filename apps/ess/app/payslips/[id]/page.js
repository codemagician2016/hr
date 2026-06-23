'use client';

// Payslip detail — full branded breakdown for one of the logged-in employee's
// own payslips.
//
// Wired to GET /api/hr/me/payslips/:id (contract). Renders earnings,
// deductions and employer contributions, the net, a YTD strip, and the
// employee's OWN payslip download (GET /api/hr/me/payslips/:id/pdf).
//
// SECURITY FIX (Feature 7 §6.6): the download MUST be the employee's own payslip
// — NEVER the run-level bank/statutory file. The earlier `runFileHref` pointed at
// /api/hr/payroll/runs/:runId/files/:kind, which would expose every employee's
// pay to a single employee. That is removed; we link the per-employee PDF route.
// Tolerant of several payload shapes (snapshotJson, lines[] with a `category`, or
// pre-split earnings/deductions arrays).

import Link from 'next/link';
import { useParams } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { money, formatPeriod, formatDate } from '@/lib/format';

function Row({ label, value, strong, accent }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span
        className={strong ? 'font-semibold' : ''}
        style={{ color: strong ? 'var(--theme-text)' : 'var(--theme-muted)' }}
      >
        {label}
      </span>
      <span
        className={strong ? 'font-semibold' : ''}
        style={{ color: accent ? 'var(--theme-primary)' : 'var(--theme-text)' }}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, lines, currency, total }) {
  return (
    <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
        {title}
      </h2>
      {(!lines || lines.length === 0) ? (
        <p className="py-2 text-sm" style={{ color: 'var(--theme-muted)' }}>No line items.</p>
      ) : (
        <>
          <div className="divide-y" style={{ borderColor: 'var(--theme-border)' }}>
            {lines.map((l, i) => (
              <Row key={l.id || l.code || i} label={l.label || l.name || l.code} value={money(l.amount, currency)} />
            ))}
          </div>
          {total != null && (
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--theme-border)' }}>
              <Row label="Total" value={money(total, currency)} strong />
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Split a flat lines[] array by category into earnings/deductions/employer. The
// payslip snapshotJson (the frozen source of truth) carries pre-split arrays.
function splitLines(slip) {
  const earnings = [];
  const deductions = [];
  const employer = [];

  const push = (arr, list) => { if (Array.isArray(list)) arr.push(...list); };

  const snap = slip?.snapshotJson || slip;

  // Pre-split shapes (snapshotJson uses earnings/employeeDeductions/employerContributions).
  push(earnings, snap?.earnings || slip?.lineItems?.earnings);
  push(deductions, snap?.employeeDeductions || slip?.deductions || slip?.lineItems?.deductions);
  push(employer, snap?.employerContributions || slip?.employerContrib || slip?.lineItems?.employerContributions);

  // Flat lines[] with a category/type field.
  const flat = slip?.lines || slip?.components || [];
  for (const l of flat) {
    const cat = String(l.category || l.type || l.kind || '').toUpperCase();
    if (cat.includes('EARN') || cat === 'ALLOWANCE' || cat === 'EARNING') earnings.push(l);
    else if (cat.includes('EMPLOYER') || cat.includes('CONTRIB')) employer.push(l);
    else if (cat.includes('DEDUC') || cat.includes('TAX') || cat.includes('STATUTORY')) deductions.push(l);
    else if (Number(l.amount?.amount ?? l.amount) < 0) deductions.push(l);
    else earnings.push(l);
  }
  return { earnings, deductions, employer };
}

function sumOf(lines, currency) {
  if (!lines || lines.length === 0) return undefined;
  const total = lines.reduce((acc, l) => {
    const a = typeof l.amount === 'object' ? Number(l.amount.amount ?? l.amount.value ?? 0) : Number(l.amount);
    return acc + (Number.isFinite(a) ? a : 0);
  }, 0);
  return { amount: total, currency };
}

// SECURITY: download the employee's OWN payslip (per-employee, server-scoped),
// NEVER the run-level bank/statutory file. The id is the payslip id.
function ownPayslipHref(id) {
  if (!id) return null;
  return `/api/hr/me/payslips/${encodeURIComponent(id)}/pdf`;
}

function PayslipDetailInner() {
  const params = useParams();
  const id = params?.id;
  const { data, loading, error } = useApi(
    id ? `/api/hr/me/payslips/${encodeURIComponent(id)}` : null
  );

  if (loading) return <Centered><Spinner /></Centered>;
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load this payslip.'} />;
  }

  const slip = data?.payslip || data;
  const snap = slip?.snapshotJson || {};
  const currency = slip?.currency || slip?.currencyCode || snap.currencyCode || 'INR';
  const { earnings, deductions, employer } = splitLines(slip || {});
  const gross = snap.gross ?? slip?.gross ?? slip?.grossPay ?? slip?.grossEarnings ?? sumOf(earnings, currency);
  const net = snap.net ?? slip?.net ?? slip?.netPay ?? slip?.netPayable;
  const fileHref = ownPayslipHref(id);
  const status = String(slip?.status || '').toUpperCase();
  // YTD strip from the snapshot (yptdJson if present).
  const ytd = slip?.yptdJson || snap.ytd || null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm">
        <Link href="/payslips" style={{ color: 'var(--theme-primary)' }}>← Payslips</Link>
      </div>

      {!slip ? (
        <Empty text="Payslip not found." />
      ) : (
        <>
          <header>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>
              {formatPeriod(slip.period || slip) || 'Payslip'}
            </h1>
            {(slip.employee?.name || slip.employeeName) && (
              <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
                {slip.employee?.name || slip.employeeName}
                {(slip.employee?.employeeCode || slip.employeeCode) ? ` · ${slip.employee?.employeeCode || slip.employeeCode}` : ''}
              </p>
            )}
            {(slip.payDate || slip.paidOn) && (
              <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>Paid on {formatDate(slip.payDate || slip.paidOn)}</p>
            )}
            {status && (
              <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold"
                style={{ background: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                {status === 'VIEWED' ? 'Viewed' : status === 'PUBLISHED' ? 'Published' : status.toLowerCase()}
              </span>
            )}
          </header>

          <Section title="Earnings" lines={earnings} currency={currency} total={gross} />
          <Section title="Deductions" lines={deductions} currency={currency} total={sumOf(deductions, currency)} />
          {employer.length > 0 && (
            <Section title="Employer contributions" lines={employer} currency={currency} total={sumOf(employer, currency)} />
          )}

          <section className="rounded-2xl p-4" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium opacity-90">Net pay</span>
              <span className="text-lg font-bold">{money(net, currency)}</span>
            </div>
          </section>

          {ytd && (typeof ytd === 'object') && (
            <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>Year to date</h2>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(ytd).slice(0, 6).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between">
                    <span style={{ color: 'var(--theme-muted)' }}>{k}</span>
                    <span style={{ color: 'var(--theme-text)' }}>{typeof v === 'number' ? money(v, currency) : String(v)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {fileHref && (
            <a
              href={fileHref}
              className="block w-full rounded-lg border py-2.5 text-center text-sm font-semibold"
              style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-primary)' }}
            >
              Download my payslip
            </a>
          )}
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

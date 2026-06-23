'use client';

// Compensation — the logged-in employee's own CTC breakup + revision history.
//
// Wired to the REAL contract route GET /api/hr/me/compensation (employee/customer
// session, cookie-authed). SELF_ONLY: there is no `:id` path, so an employee can
// only ever see their own pay. Reuses the payslip Section/Row grammar so the
// breakup matches actual payslips. A 404 (no current revision / not deployed)
// degrades to a friendly "contact HR" empty state — never fabricated numbers.

import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { money, formatDate } from '@/lib/format';

const PATH = '/api/hr/me/compensation';

function Row({ label, value, strong, accent }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className={strong ? 'font-semibold' : ''} style={{ color: strong ? 'var(--theme-text)' : 'var(--theme-muted)' }}>{label}</span>
      <span className={strong ? 'font-semibold' : ''} style={{ color: accent ? 'var(--theme-primary)' : 'var(--theme-text)' }}>{value}</span>
    </div>
  );
}

function Section({ title, note, lines, currency, total }) {
  return (
    <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>{title}</h2>
      {note && <p className="mb-1 text-xs" style={{ color: 'var(--theme-muted)' }}>{note}</p>}
      {(!lines || lines.length === 0) ? (
        <p className="py-2 text-sm" style={{ color: 'var(--theme-muted)' }}>No line items.</p>
      ) : (
        <>
          <div className="divide-y" style={{ borderColor: 'var(--theme-border)' }}>
            {lines.map((l, i) => (
              <Row key={l.code || i} label={l.component?.name || l.name || l.code} value={money(num(l.amountMonthly), currency)} />
            ))}
          </div>
          {total != null && (
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--theme-border)' }}>
              <Row label="Total (monthly)" value={money(total, currency)} strong />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function num(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Split the revision lines (joined to component.category) into the three groups.
function splitLines(current) {
  const earnings = [];
  const employeeDed = [];
  const employer = [];
  for (const l of current?.lines || []) {
    const cat = l.component?.category || l.category || 'EARNING';
    if (cat === 'EARNING') earnings.push(l);
    else if (cat === 'EMPLOYER_COST') employer.push(l);
    else employeeDed.push(l);
  }
  return { earnings, employeeDed, employer };
}

function CompensationInner() {
  const { data, loading, error } = useApi(PATH, { select: (b) => b });

  if (loading) return <Centered><Spinner /></Centered>;

  // 404 (no current revision OR route not deployed in this env) → contact HR.
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load compensation.'} />;
  }
  const current = data?.current;
  const history = data?.history || [];

  if (!current || !current.absolute) {
    return (
      <Empty text="No compensation on record yet — please contact HR." />
    );
  }

  const currency = 'INR';
  const { earnings, employeeDed, employer } = splitLines(current);
  const abs = current.absolute || {};

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Compensation</h1>
      <header className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>Cost to company (annual)</p>
            <p className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>{money(num(abs.ctcAnnual), currency)}</p>
          </div>
          <div className="text-right text-sm" style={{ color: 'var(--theme-muted)' }}>
            <div>Gross (monthly): <span style={{ color: 'var(--theme-text)' }}>{money(num(abs.grossMonthly), currency)}</span></div>
            {current.effectiveFrom && <div>Effective {formatDate(current.effectiveFrom)}</div>}
          </div>
        </div>
      </header>

      <Section title="Earnings" lines={earnings} currency={currency} total={sum(earnings)} />
      {employeeDed.length > 0 && <Section title="Employee deductions" lines={employeeDed} currency={currency} total={sum(employeeDed)} />}
      {employer.length > 0 && (
        <Section
          title="Employer contributions"
          note="Cost to company — not paid to you"
          lines={employer}
          currency={currency}
          total={sum(employer)}
        />
      )}

      {history.length > 1 && (
        <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>Revision history</h2>
          <div className="divide-y" style={{ borderColor: 'var(--theme-border)' }}>
            {history.map((h, i) => (
              <div key={h.id || i} className="flex items-center justify-between py-2 text-sm">
                <span style={{ color: 'var(--theme-muted)' }}>{h.effectiveFrom ? formatDate(h.effectiveFrom) : '—'} · {h.revisionReason || ''}</span>
                <span style={{ color: 'var(--theme-text)' }}>
                  {h.absolute ? money(num(h.absolute.ctcAnnual), currency) : '•••'}
                  {h.delta?.pct != null && <span className="ml-2 text-xs" style={{ color: 'var(--theme-primary)' }}>({h.delta.pct > 0 ? '+' : ''}{h.delta.pct}%)</span>}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function sum(lines) {
  return (lines || []).reduce((s, l) => s + num(l.amountMonthly), 0);
}

export default function CompensationPage() {
  return (
    <AppShell>
      <CompensationInner />
    </AppShell>
  );
}

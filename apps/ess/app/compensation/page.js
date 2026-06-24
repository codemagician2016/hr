'use client';

// Compensation — the logged-in employee's own CTC breakup + revision history.
//
// Wired to the REAL contract route GET /api/hr/me/compensation (employee/customer
// session, cookie-authed). SELF_ONLY: there is no `:id` path, so an employee can
// only ever see their own pay. Reuses the payslip Section/Row grammar so the
// breakup matches actual payslips. A 404 (no current revision / not deployed)
// degrades to a friendly "contact HR" empty state — never fabricated numbers.

import { useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { money, formatDate } from '@/lib/format';

const PATH = '/api/hr/me/compensation';
const PDF_PATH = '/api/hr/me/compensation/pdf';

// Premium "Download CTC (PDF)" control — a same-origin blob fetch (the customer
// session cookie rides along) with a loading state, so the page never shows a
// dead button. The server streams an application/pdf of the employee's CURRENT
// compensation (SELF_ONLY, full own figures).
function DownloadCtcButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function onDownload() {
    setBusy(true); setErr('');
    try {
      const res = await fetch(PDF_PATH, { credentials: 'include', headers: { Accept: 'application/pdf' } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename="?([^"]+)"?/.exec(cd);
      const name = m ? m[1] : 'compensation-statement.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e.message || 'Could not download your compensation statement.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onDownload}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition disabled:opacity-60"
        style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
      >
        {busy ? (
          <>
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Preparing…
          </>
        ) : (
          <>
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 3v9m0 0 3-3m-3 3-3-3M4 15v1.5A1.5 1.5 0 0 0 5.5 18h9a1.5 1.5 0 0 0 1.5-1.5V15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Download CTC (PDF)
          </>
        )}
      </button>
      {err && <span className="text-xs" style={{ color: 'var(--theme-danger, #b91c1c)' }}>{err}</span>}
    </div>
  );
}

function Row({ label, value, strong, accent }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className={strong ? 'font-semibold' : ''} style={{ color: strong ? 'var(--theme-text)' : 'var(--theme-muted)' }}>{label}</span>
      <span className={strong ? 'font-semibold' : ''} style={{ color: accent ? 'var(--theme-primary)' : 'var(--theme-text)' }}>{value}</span>
    </div>
  );
}

// A line's amount for the chosen period (annual = the stored annual, else monthly*12).
function lineAmount(l, period) {
  const mo = num(l.amountMonthly);
  if (period === 'annual') {
    const an = num(l.amountAnnual);
    return an || mo * 12;
  }
  return mo;
}

function Section({ title, note, lines, currency, total, period = 'monthly' }) {
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
              <Row key={l.code || i} label={l.component?.name || l.name || l.code} value={money(lineAmount(l, period), currency)} />
            ))}
          </div>
          {total != null && (
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--theme-border)' }}>
              <Row label={`Total (${period === 'annual' ? 'annual' : 'monthly'})`} value={money(period === 'annual' ? total * 12 : total, currency)} strong />
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Annual / monthly toggle (the "My CTC" statement view control).
function PeriodToggle({ period, onChange }) {
  return (
    <div className="inline-flex rounded-lg border overflow-hidden text-xs font-semibold" style={{ borderColor: 'var(--theme-border)' }}>
      {['monthly', 'annual'].map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className="px-3 py-1.5 capitalize"
          style={period === p
            ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }
            : { background: 'white', color: 'var(--theme-muted)' }}
        >
          {p}
        </button>
      ))}
    </div>
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
  // Feature 17 — "My CTC" annual/monthly toggle over the same waterfall.
  const [period, setPeriod] = useState('monthly');

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

  // Pay currency comes from the revision (entity pay currency: INR for India) —
  // never hardcoded.
  const currency = current.currencyCode || undefined;
  const { earnings, employeeDed, employer } = splitLines(current);
  const abs = current.absolute || {};

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>My CTC</h1>
        <div className="flex items-center gap-3">
          <PeriodToggle period={period} onChange={setPeriod} />
          <DownloadCtcButton />
        </div>
      </div>
      <header className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>Cost to company (annual)</p>
            <p className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>{money(num(abs.ctcAnnual), currency)}</p>
          </div>
          <div className="text-right text-sm" style={{ color: 'var(--theme-muted)' }}>
            <div>Gross ({period}): <span style={{ color: 'var(--theme-text)' }}>{money(period === 'annual' ? num(abs.grossMonthly) * 12 : num(abs.grossMonthly), currency)}</span></div>
            {current.effectiveFrom && <div>Effective {formatDate(current.effectiveFrom)}</div>}
          </div>
        </div>
      </header>

      <Section title="Earnings" lines={earnings} currency={currency} total={sum(earnings)} period={period} />
      {employeeDed.length > 0 && <Section title="My deductions" lines={employeeDed} currency={currency} total={sum(employeeDed)} period={period} />}
      {employer.length > 0 && (
        <Section
          title="Company contributions"
          note="Cost to company — not paid to you"
          lines={employer}
          currency={currency}
          total={sum(employer)}
          period={period}
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

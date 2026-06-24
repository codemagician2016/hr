'use client';

// Tax projection — the full India income-tax computation statement (the Figma):
// gross salary breakup → HRA exemption → gross after exemption → perquisites →
// Chapter VI-A deductions (gross/qualifying/deductible) → standard deduction →
// total taxable income → tax/surcharge/cess → TDS this year & previous-employer
// TDS → monthly tax recoverable + the 80C investments table + an OLD-vs-NEW
// comparison banner + a downloadable PDF.
//
// India-only. The page is country-gated client-side (useCountry) AND the backend
// 422s a non-IN request — defence in depth. It is read-only: editing the
// declaration deep-links to /tax (the existing declaration page).

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import InfoTip from '@/components/InfoTip';
import { Spinner, ErrorBanner, Empty } from '@hr/ui';
import { apiGet } from '@/lib/api';
import { money } from '@/lib/format';
import { useCountry } from '@/lib/useCountry';

const PROJECTION_PATH = '/api/hr/me/tax-projection';
const PDF_PATH = '/api/hr/me/tax-projection/pdf';

function Card({ title, tip, children, right }) {
  return (
    <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      {title && (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
            {title}
            {tip ? <InfoTip text={tip} /> : null}
          </h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

// A label / amount row. `bold` for subtotals; `tip` adds an ⓘ tooltip.
function Row({ label, value, bold, muted, tip, indent }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm" style={{ paddingLeft: indent ? 12 : 0 }}>
      <span className="flex items-center" style={{ color: muted ? 'var(--theme-muted)' : 'var(--theme-text)', fontWeight: bold ? 600 : 400 }}>
        {label}
        {tip ? <InfoTip text={tip} /> : null}
      </span>
      <span style={{ color: muted ? 'var(--theme-muted)' : 'var(--theme-text)', fontWeight: bold ? 700 : 500 }}>
        {money(value, 'INR')}
      </span>
    </div>
  );
}

// Feature 20 — the quiet badge per Chapter VI-A: "using declared (provisional)" before
// the proof deadline, flipping to "using verified" after — so the employee understands
// why their projected TDS moved.
function ProofBasisBadge({ basis, deadline }) {
  const isVerified = basis === 'VERIFIED';
  return (
    <span
      title={isVerified
        ? 'The proof deadline has passed — only HR-verified investments now reduce your TDS.'
        : `Provisional — your declared figures are used until the proof deadline${deadline ? ` (${String(deadline).slice(0, 10)})` : ''}.`}
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${isVerified ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}
    >
      {isVerified ? 'using verified' : 'using declared (provisional)'}
    </span>
  );
}

function ProjectionInner() {
  const { country, loading: countryLoading } = useCountry();
  const [statement, setStatement] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Only fetch once the country is resolved AND is India (fail-closed).
    if (countryLoading) return;
    if (country !== 'IN') { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    apiGet(PROJECTION_PATH)
      .then((res) => { if (alive) { setStatement(res); setError(null); } })
      .catch((err) => { if (alive) setError(err.message || 'Could not load your tax projection.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [country, countryLoading]);

  if (countryLoading || loading) {
    return <div className="py-12"><Spinner /></div>;
  }

  // India-only surface — never render for other markets.
  if (country !== 'IN') {
    return <Empty text="Tax projection is available for India only." />;
  }

  if (error) return <ErrorBanner message={error} />;
  if (!statement) return <Empty text="We'll show your projection once your salary is set up." />;

  const s = statement;
  const isOld = s.regime === 'OLD';
  const rc = s.regimeComparison || {};
  const betterIsElected = rc.betterRegime === rc.elected;

  return (
    <div className="max-w-2xl space-y-5">
      {/* Header strip */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Tax projection</h1>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
            FY {s.taxYear} · {isOld ? 'Old' : 'New'} regime · projected from your current salary
          </p>
        </div>
        <a
          href="/tax"
          className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
          style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-primary)' }}
        >
          Change regime / declaration
        </a>
      </div>

      {/* Anomalies (e.g. missing PAN) */}
      {Array.isArray(s.anomalies) && s.anomalies.length > 0 && (
        <div className="space-y-2">
          {s.anomalies.map((a, i) => (
            <div key={i} className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)', background: 'var(--theme-primary-soft, #f7f7f9)' }}>
              {a.message}
            </div>
          ))}
        </div>
      )}

      {/* Gross salary breakup */}
      <Card title="Gross salary breakup" tip="Your annual earnings, projected from your current salary structure.">
        <Row label="Basic + DA" value={s.annualEarnings.basicDa} />
        <Row label="House Rent Allowance (HRA)" value={s.annualEarnings.hra} />
        <Row label="Other allowances" value={s.annualEarnings.otherAllowances} />
        <Row label="Residual / choice pay" value={s.annualEarnings.residualChoicePay} />
        <div className="my-1 border-t" style={{ borderColor: 'var(--theme-border)' }} />
        <Row label="Gross salary" value={s.annualEarnings.grossSalary} bold />
      </Card>

      {/* HRA exemption (OLD only) */}
      {isOld && s.hraExemption ? (
        <Card title="HRA exemption (Section 10(13A))" tip="The exemption is the LEAST of: HRA received, rent paid minus 10% of salary, and 50%/40% of salary.">
          <Row label="HRA received" value={s.hraExemption.legs.received} muted />
          <Row label="Rent paid − 10% of salary" value={s.hraExemption.legs.rentMinus10} muted />
          <Row label="50%/40% of salary" value={s.hraExemption.legs.pctOfSalary} muted />
          <div className="my-1 border-t" style={{ borderColor: 'var(--theme-border)' }} />
          <Row label="Exemption (least of three)" value={s.hraExemption.exempt} bold />
          <Row label="Gross earning after exemption" value={s.grossEarningAfterExemption} bold />
        </Card>
      ) : (
        <Card title="Exemptions">
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
            New regime — HRA exemption and Chapter VI-A deductions do not apply.
          </p>
        </Card>
      )}

      {/* Perquisites */}
      {s.perquisites && Array.isArray(s.perquisites.lines) && s.perquisites.lines.length > 0 && (
        <Card title="Value of perquisites" tip="Non-cash benefits (e.g. employer accommodation or a concessional loan) are taxed as income.">
          {s.perquisites.lines.map((p, i) => (
            <div key={i}>
              <Row label={p.label || p.kind} value={p.amount} />
              {p.explain && <p className="mb-1 text-xs" style={{ color: 'var(--theme-muted)', paddingLeft: 12 }}>{p.explain}</p>}
            </div>
          ))}
          <div className="my-1 border-t" style={{ borderColor: 'var(--theme-border)' }} />
          <Row label="Total perquisites" value={s.perquisites.total} bold />
        </Card>
      )}

      {/* Chapter VI-A (OLD only) — gross / qualifying / deductible table */}
      {isOld && s.chapterVIA && Array.isArray(s.chapterVIA.lines) && s.chapterVIA.lines.length > 0 && (
        <Card
          title="Deductions under Chapter VI-A"
          tip="Each section has a cap: the DEDUCTIBLE amount is the lower of what you qualify for and the legal limit."
          right={s.proofBasis ? <ProofBasisBadge basis={s.proofBasis} deadline={s.proofWindow ? s.proofWindow.proofDeadline : null} /> : null}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
                  <th className="py-1 pr-2 font-semibold">Section</th>
                  <th className="py-1 px-2 text-right font-semibold">Gross</th>
                  <th className="py-1 px-2 text-right font-semibold">Qualifying</th>
                  <th className="py-1 pl-2 text-right font-semibold">Deductible</th>
                </tr>
              </thead>
              <tbody>
                {s.chapterVIA.lines.map((l, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--theme-border)' }}>
                    <td className="py-1.5 pr-2">
                      <span className="font-semibold" style={{ color: 'var(--theme-text)' }}>{l.section}</span>
                      {l.label && <span className="block text-xs" style={{ color: 'var(--theme-muted)' }}>{l.label}</span>}
                    </td>
                    <td className="py-1.5 px-2 text-right" style={{ color: 'var(--theme-muted)' }}>{money(l.gross, 'INR')}</td>
                    <td className="py-1.5 px-2 text-right" style={{ color: 'var(--theme-muted)' }}>{money(l.qualifying, 'INR')}</td>
                    <td className="py-1.5 pl-2 text-right font-semibold" style={{ color: 'var(--theme-text)' }}>{money(l.deductible, 'INR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="my-1 border-t" style={{ borderColor: 'var(--theme-border)' }} />
          <Row label="Maximum qualifying amount" value={s.chapterVIA.maxQualifying} muted />
          <Row label="Total deductible (Chapter VI-A)" value={s.chapterVIA.totalDeductible} bold />
        </Card>
      )}

      {/* Taxable income */}
      <Card title="Taxable income">
        <Row label="Standard deduction" value={s.standardDeduction} />
        {s.previousEmployerCounted && (
          <Row label="Add: previous-employer income" value={s.previousEmployerTaxableIncome} muted />
        )}
        <div className="my-1 border-t" style={{ borderColor: 'var(--theme-border)' }} />
        <Row label="Total taxable income" value={s.totalTaxableIncome} bold />
      </Card>

      {/* Tax payable */}
      <Card title="Tax payable">
        <Row label="Tax payable (before surcharge/cess)" value={s.taxPayable} />
        <Row label="Surcharge" value={s.surcharge} />
        <Row label="Health & Education cess (4%)" value={s.cess} tip="A 4% cess applies on tax plus surcharge." />
        <div className="my-1 border-t" style={{ borderColor: 'var(--theme-border)' }} />
        <Row label="Total tax" value={s.totalTax} bold />
        {s.noPanApplied && (
          <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
            No PAN on record — tax applied at 20% flat (Section 206AA). Add your PAN with HR to be taxed at slab rates.
          </p>
        )}
      </Card>

      {/* TDS already accounted */}
      <Card title="Tax already accounted">
        <Row label="Tax deducted this year (your payslips)" value={s.tdsDeductedThisFY} tip="Sum of the TDS line across your published payslips this financial year." />
        <Row label="Tax deducted by previous employer" value={s.previousEmployerTds} />
        <div className="my-1 border-t" style={{ borderColor: 'var(--theme-border)' }} />
        <Row label="Balance tax remaining" value={s.remainingTax} bold />
      </Card>

      {/* Monthly tax recoverable — highlighted card */}
      <section className="rounded-2xl p-5 shadow-sm" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
        <p className="text-xs uppercase tracking-wide opacity-80">Monthly tax recoverable</p>
        <p className="mt-1 text-3xl font-bold">{money(s.monthlyRecoverable, 'INR')}<span className="text-base font-medium opacity-80"> / month</span></p>
        <p className="mt-1 text-sm opacity-90">
          will be deducted in each of your remaining {s.monthsRemaining} month{s.monthsRemaining === 1 ? '' : 's'}.
        </p>
        {Array.isArray(s.schedule) && s.schedule.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs opacity-90 sm:grid-cols-3">
            {s.schedule.map((m, i) => (
              <div key={i} className="flex justify-between">
                <span>{m.month}</span>
                <span>{money(m.amount, 'INR')}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 80C investments table */}
      {Array.isArray(s.investments80C) && s.investments80C.length > 0 && (
        <Card title="80C investments" tip="PF auto-counts toward 80C from your payslips; the rest is what you declared.">
          {s.investments80C.map((inv, i) => (
            <div key={i} className="flex items-center justify-between py-1.5 text-sm">
              <span style={{ color: 'var(--theme-text)' }}>
                {inv.label || inv.code}
                <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" style={{ background: 'var(--theme-primary-soft, #eef)', color: 'var(--theme-muted)' }}>
                  {inv.source === 'DERIVED' ? 'from payslips' : 'declared'}
                </span>
              </span>
              <span style={{ color: 'var(--theme-text)', fontWeight: 500 }}>{money(inv.amount, 'INR')}</span>
            </div>
          ))}
        </Card>
      )}

      {/* Regime comparison banner */}
      {rc.alternativeRegime && (
        <div className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--theme-border)', background: 'var(--theme-primary-soft, #f7f7f9)' }}>
          <p style={{ color: 'var(--theme-text)' }}>
            Under the <strong>{rc.alternativeRegime === 'NEW' ? 'New' : 'Old'} regime</strong> your total tax would be{' '}
            <strong>{money(rc.alternativeTotalTax, 'INR')}</strong>.{' '}
            {betterIsElected
              ? `You're already on the cheaper ${rc.elected === 'NEW' ? 'New' : 'Old'} regime.`
              : `You'd save by switching to the ${rc.betterRegime === 'NEW' ? 'New' : 'Old'} regime.`}
          </p>
          {!betterIsElected && (
            <a href="/tax" className="mt-1 inline-block text-xs font-semibold" style={{ color: 'var(--theme-primary)' }}>
              Switch regime in your declaration →
            </a>
          )}
        </div>
      )}

      {/* Download PDF */}
      <a
        href={PDF_PATH}
        className="block w-full rounded-lg border py-3 text-center text-sm font-semibold"
        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-primary)' }}
      >
        Download IT computation (PDF)
      </a>

      {/* Disclaimer */}
      <p className="text-center text-xs" style={{ color: 'var(--theme-muted)' }}>
        Projected from your current salary and declaration — this is not a Form 16. Final tax is computed at year-end.
      </p>
    </div>
  );
}

export default function TaxProjectionPage() {
  return (
    <AppShell>
      <ProjectionInner />
    </AppShell>
  );
}

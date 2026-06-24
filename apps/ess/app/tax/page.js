'use client';

// Tax declaration — branded, mobile-first, shippable.
//
//   India : regime choice (OLD vs NEW) + investment declaration (80C, 80D,
//           HRA, home-loan interest, etc.).
//
// The product is single-country India (Feature 14). The form prefills from the
// saved declaration (GET) and persists on submit (POST) — both at
// /api/hr/me/tax-declaration, which writes onto the employee's StatutoryProfile
// (audit #57: the page could collect a declaration but had nowhere to persist it,
// so every submission was lost).

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner } from '@hr/ui';
import { apiGet, apiPost } from '@/lib/api';
import { useCountry } from '@/lib/useCountry';

const TAX_PATH = '/api/hr/me/tax-declaration';

// India 80C-style investment heads (amounts in major units, employee-entered).
const INDIA_HEADS = [
  { key: 'sec80c', label: 'Section 80C (PF, ELSS, LIC, PPF…)', hint: 'Max 1,50,000' },
  { key: 'sec80d', label: 'Section 80D (Medical insurance)', hint: '' },
  { key: 'hra', label: 'HRA — annual rent paid', hint: '' },
  { key: 'homeLoanInterest', label: 'Home loan interest (Sec 24)', hint: '' },
  { key: 'nps80ccd1b', label: 'NPS (Sec 80CCD(1B))', hint: 'Max 50,000' },
  { key: 'sec80e', label: 'Section 80E (Education loan interest)', hint: '' },
];

function Card({ children }) {
  return (
    <section className="rounded-2xl border bg-white p-4 shadow-sm space-y-3" style={{ borderColor: 'var(--theme-border)' }}>
      {children}
    </section>
  );
}

function MoneyField({ label, hint, value, onChange }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>{label}</span>
      <input
        type="number" inputMode="decimal" min="0" value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
        style={{ borderColor: 'var(--theme-border)' }}
        placeholder="0"
      />
      {hint && <span className="mt-1 block text-xs" style={{ color: 'var(--theme-muted)' }}>{hint}</span>}
    </label>
  );
}

function TaxInner() {
  // Country is the AUTHORITATIVE employee country from the backend. It is null
  // while loading and whenever it cannot be resolved — in which case we render no
  // country block (fail-closed). India is the only supported country (Feature 14).
  const { country, loading: countryLoading } = useCountry();

  // India state
  const [regime, setRegime] = useState('NEW');
  const [india, setIndia] = useState(() => Object.fromEntries(INDIA_HEADS.map((h) => [h.key, ''])));

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [success, setSuccess] = useState(false);

  // Prefill from the saved declaration (GET). Seeds the regime/80C so the employee
  // sees + edits their current election, not a blank form. Best-effort: a
  // missing/empty declaration leaves the defaults.
  useEffect(() => {
    let alive = true;
    apiGet(TAX_PATH)
      .then((res) => {
        if (!alive) return;
        const d = res && res.declaration;
        if (!d) return;
        if (d.country === 'IN') {
          if (d.regime) setRegime(d.regime);
          if (d.investments && d.investments.sec80c != null) {
            setIndia((s) => ({ ...s, sec80c: String(d.investments.sec80c || '') }));
          }
        }
      })
      .catch(() => { /* prefill is best-effort — keep the defaults on error */ });
    return () => { alive = false; };
  }, []);

  function buildPayload() {
    if (country === 'IN') {
      const investments = Object.fromEntries(
        Object.entries(india).map(([k, v]) => [k, Number(v) || 0])
      );
      return { country: 'IN', regime, investments };
    }
    // Unknown country — never submit a wrong-country declaration.
    return null;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const payload = buildPayload();
    if (!payload) {
      setError('We could not determine your tax jurisdiction. Please contact HR.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setNote(null);
    setSuccess(false);
    try {
      await apiPost(TAX_PATH, payload);
      setSuccess(true);
    } catch (err) {
      // 422 carries a friendly validation message from the backend (wrong-country
      // payload, jurisdiction not set up).
      setError(err.message || 'Could not submit your tax declaration.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Tax declaration</h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
          {country === 'IN' ? 'India income-tax declaration' : 'Tax declaration'}
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Fail-closed: while the country is loading, or if it cannot be resolved,
          render no country block — never a wrong-country default. */}
      {countryLoading && (
        <Card>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>Loading your tax details…</p>
        </Card>
      )}
      {!countryLoading && country == null && (
        <Card>
          <p className="text-sm" style={{ color: 'var(--theme-text)' }}>
            We could not determine your tax jurisdiction yet. Please contact HR to complete your profile.
          </p>
        </Card>
      )}
      {note && (
        <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}>
          {note}
        </div>
      )}
      {success && (
        <div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
          Tax declaration submitted.
        </div>
      )}

      {country === 'IN' && (
        <>
          <Card>
            <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>Tax regime</h2>
            <div className="grid grid-cols-2 gap-3">
              {['NEW', 'OLD'].map((r) => {
                const active = regime === r;
                return (
                  <button
                    type="button" key={r} onClick={() => setRegime(r)}
                    className="rounded-lg border py-3 text-sm font-semibold"
                    style={active
                      ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)', borderColor: 'var(--theme-primary)' }
                      : { borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
                  >
                    {r === 'NEW' ? 'New regime' : 'Old regime'}
                  </button>
                );
              })}
            </div>
            <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
              {regime === 'NEW'
                ? 'Lower slab rates, most exemptions not available.'
                : 'Standard slabs with Chapter VI-A deductions below.'}
            </p>
          </Card>

          <Card>
            <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
              Investment declaration
            </h2>
            <fieldset disabled={regime === 'NEW'} className={regime === 'NEW' ? 'opacity-50' : ''}>
              <div className="space-y-3">
                {INDIA_HEADS.map((h) => (
                  <MoneyField
                    key={h.key} label={h.label} hint={h.hint}
                    value={india[h.key]}
                    onChange={(v) => setIndia((s) => ({ ...s, [h.key]: v }))}
                  />
                ))}
              </div>
            </fieldset>
            {regime === 'NEW' && (
              <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                Deductions don't apply under the new regime.
              </p>
            )}
          </Card>
        </>
      )}

      {/* Only allow submission once we know the jurisdiction (India). */}
      {country === 'IN' && (
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg py-3 text-sm font-semibold transition disabled:opacity-60"
          style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
        >
          {submitting ? 'Submitting…' : 'Submit declaration'}
        </button>
      )}
    </form>
  );
}

export default function TaxPage() {
  return (
    <AppShell>
      <TaxInner />
    </AppShell>
  );
}

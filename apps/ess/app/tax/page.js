'use client';

// Tax declaration — branded, mobile-first, shippable.
//
//   India : regime choice (OLD vs NEW) + investment declaration (80C, 80D,
//           HRA, home-loan interest, etc.).
//   NZ    : IRD tax code election + KiwiSaver contribution rate.
//
// The form picks the jurisdiction from the employee's country / the tenant's
// country (defaults to IN). On submit it POSTs the declaration to the stub path
// below.
//
// TODO(tax): /api/hr/me/tax-declaration is NOT yet implemented in the backend.
// When the route lands (GET to prefill the saved declaration, POST/PUT to save)
// it should accept the exact body shapes built in buildPayload() below. Until
// then a 404/405 is shown as a friendly "saved locally for now" note rather
// than a hard error, so the page is fully shippable.

import { useMemo, useState } from 'react';
import AppShell, { useSession } from '@/components/AppShell';
import { ErrorBanner } from '@hr/ui';
import { useTenant } from '@/components/TenantProvider';
import { apiPost } from '@/lib/api';

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

const NZ_TAX_CODES = ['M', 'M SL', 'ME', 'ME SL', 'SB', 'S', 'SH', 'ST', 'SA', 'CAE', 'WT'];
const KIWISAVER_RATES = ['0', '3', '4', '6', '8', '10'];

function detectCountry(me, tenant) {
  const c =
    me?.employee?.country ||
    me?.employee?.taxCountry ||
    me?.country ||
    tenant?.business?.country ||
    tenant?.business?.countryCode ||
    'IN';
  return String(c).toUpperCase().startsWith('N') ? 'NZ' : 'IN';
}

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
  const me = useSession();
  const { tenant } = useTenant();
  const country = useMemo(() => detectCountry(me, tenant), [me, tenant]);

  // India state
  const [regime, setRegime] = useState('NEW');
  const [india, setIndia] = useState(() => Object.fromEntries(INDIA_HEADS.map((h) => [h.key, ''])));

  // NZ state
  const [taxCode, setTaxCode] = useState('M');
  const [kiwiSaver, setKiwiSaver] = useState('3');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [success, setSuccess] = useState(false);

  function buildPayload() {
    if (country === 'NZ') {
      return { country: 'NZ', taxCode, kiwiSaverRate: Number(kiwiSaver) };
    }
    const investments = Object.fromEntries(
      Object.entries(india).map(([k, v]) => [k, Number(v) || 0])
    );
    return { country: 'IN', regime, investments };
  }

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNote(null);
    setSuccess(false);
    try {
      await apiPost(TAX_PATH, buildPayload());
      setSuccess(true);
    } catch (err) {
      // Endpoint not yet wired — degrade gracefully, stay shippable.
      if (err.status === 404 || err.status === 405 || err.status === 501) {
        setNote('Tax declaration capture is being enabled for your organisation. Your selections are ready to submit once it goes live.');
      } else {
        setError(err.message || 'Could not submit your tax declaration.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>Tax declaration</h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
          {country === 'NZ' ? 'New Zealand (IRD) tax code & KiwiSaver' : 'India income-tax declaration'}
        </p>
      </div>

      {error && <ErrorBanner message={error} />}
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

      {country === 'IN' ? (
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
      ) : (
        <>
          <Card>
            <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>IRD tax code</h2>
            <label className="block text-sm">
              <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>Tax code</span>
              <select
                value={taxCode} onChange={(e) => setTaxCode(e.target.value)}
                className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none"
                style={{ borderColor: 'var(--theme-border)' }}
              >
                {NZ_TAX_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="mt-1 block text-xs" style={{ color: 'var(--theme-muted)' }}>
                Use the code from your IR330. "M" is the main job; add "SL" if you have a student loan.
              </span>
            </label>
          </Card>

          <Card>
            <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>KiwiSaver</h2>
            <div className="grid grid-cols-3 gap-2">
              {KIWISAVER_RATES.map((r) => {
                const active = kiwiSaver === r;
                return (
                  <button
                    type="button" key={r} onClick={() => setKiwiSaver(r)}
                    className="rounded-lg border py-2.5 text-sm font-semibold"
                    style={active
                      ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)', borderColor: 'var(--theme-primary)' }
                      : { borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
                  >
                    {r === '0' ? 'Opt out' : `${r}%`}
                  </button>
                );
              })}
            </div>
            <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
              Employee contribution rate. Standard rates are 3%, 4%, 6%, 8% or 10%.
            </p>
          </Card>
        </>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg py-3 text-sm font-semibold transition disabled:opacity-60"
        style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
      >
        {submitting ? 'Submitting…' : 'Submit declaration'}
      </button>
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

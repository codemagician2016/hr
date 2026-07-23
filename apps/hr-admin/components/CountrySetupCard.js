'use client';

// CountrySetupCard — Feature 14 (strict single-country mode). Settings → Company
// profile → Country tab. Two states:
//   1. NOT set up (hrCountry NULL → GET /api/hr/country-context 409s): a one-time
//      "Which country do you run payroll in?" picker (India or New Zealand).
//      Submitting POSTs /setup/country.
//   2. ALREADY set: a READ-ONLY badge — "Payroll country: India 🇮🇳 · Currency:
//      INR" — with a tooltip explaining a country change means a new workspace.
//      There is NO edit control (the server locks it after the first set).
//
// The hard backstop is server-side (the allow-list + locked-once endpoint); this
// is the convenience surface. Gated on canManageCompanyProfile for the write.

import { useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, Spinner } from '@hr/ui';
import { get, post } from '@/lib/api';
import { InfoTip } from '@/lib/widgets';

// The registrable HR countries. This mirrors the backend REGISTRABLE_HR_COUNTRIES
// constant — the server is the authority (the submit still POSTs to a locked-once,
// allow-listed endpoint). Enabled entries are selectable at first setup.
const HR_COUNTRY_CHOICES = [
  { code: 'IN', label: 'India', flag: '🇮🇳', enabled: true },
  { code: 'NZ', label: 'New Zealand', flag: '🇳🇿', enabled: true },
];

export default function CountrySetupCard({ canEdit = false }) {
  const [ctx, setCtx] = useState(null); // { country, currency, capabilities } | null
  const [notSetUp, setNotSetUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState('IN');
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    setError('');
    get('/api/hr/country-context')
      .then((r) => { setCtx(r); setNotSetUp(false); })
      .catch((e) => {
        // 409 (HR_NOT_SET_UP / HR_COUNTRY_AMBIGUOUS) → show the setup picker / review state.
        if (e && e.status === 409) { setNotSetUp(true); setCtx(null); }
        else setError(e?.message || 'Could not load your business country.');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function submit() {
    setSaving(true);
    setError('');
    try {
      const r = await post('/api/hr/setup/country', { country: picked });
      setCtx(r);
      setNotSetUp(false);
    } catch (e) {
      setError(e?.data?.message || e?.message || 'Could not set your business country.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  // ── State 2: locked read-only badge ──
  if (ctx && ctx.country) {
    const caps = ctx.capabilities || {};
    return (
      <div className="max-w-xl">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-gray-700">Payroll country</span>
          <InfoTip text="Your business operates HR & payroll in one country. This is set once and locked — changing country means a new workspace, not an edit here." />
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 flex items-center justify-between">
          <div className="text-base font-semibold text-gray-900">
            {caps.flag || '🌐'} {caps.label || ctx.country}
            <span className="ml-3 text-sm font-normal text-gray-500">
              Currency: {ctx.currency}
            </span>
          </div>
          <span className="text-xs uppercase tracking-wide text-gray-400">Locked</span>
        </div>
        {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      </div>
    );
  }

  // ── Ambiguous / under-review (409 but not a clean pre-setup pick) ──
  // notSetUp covers both pre-setup and ambiguous; the picker only makes sense
  // pre-setup, so we still show it (a successful set clears an ambiguous flag too).

  // ── State 1: one-time setup picker ──
  return (
    <div className="max-w-xl">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium text-gray-700">Which country do you run payroll in?</span>
        <InfoTip text="Pick the country your business runs HR & payroll in. This is set once and then locked — it drives your tax regime, statutory IDs, leave rules, letters and currency." />
      </div>
      <div className="space-y-2">
        {HR_COUNTRY_CHOICES.map((c) => (
          <label
            key={c.code}
            className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
              c.enabled ? 'cursor-pointer border-gray-200 hover:border-gray-300' : 'opacity-50 cursor-not-allowed border-gray-100'
            } ${picked === c.code && c.enabled ? 'ring-2 ring-indigo-500 border-indigo-300' : ''}`}
          >
            <input
              type="radio"
              name="hrCountry"
              value={c.code}
              disabled={!c.enabled || !canEdit}
              checked={picked === c.code}
              onChange={() => c.enabled && setPicked(c.code)}
            />
            <span className="text-base">{c.flag} {c.label}</span>
            {c.note ? <span className="ml-auto text-xs uppercase tracking-wide text-gray-400">{c.note}</span> : null}
          </label>
        ))}
      </div>
      {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      <div className="mt-4">
        <PrimaryButton onClick={submit} disabled={!canEdit || saving || !HR_COUNTRY_CHOICES.find((c) => c.code === picked)?.enabled}>
          {saving ? 'Saving…' : 'Set business country'}
        </PrimaryButton>
      </div>
      {!canEdit ? (
        <p className="mt-2 text-xs text-gray-500">You need the “Manage company profile” permission to set this.</p>
      ) : null}
    </div>
  );
}

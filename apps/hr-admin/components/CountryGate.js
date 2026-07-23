'use client';

// CountryGate — Feature 14 (country-context). Wraps an India-only statutory
// surface (Form 16/24Q, Statutory Registers, the tax declaration-window / proof
// / regime consoles, FBP) so a deep link opened by a non-IN (e.g. New Zealand)
// tenant renders a friendly "not available for your country" panel instead of the
// page's raw 404/422 from the country-gated API.
//
// FAIL-OPEN while the tenant country is still unresolved (loading / pre-setup) so
// an IN tenant — the common case — renders EXACTLY as before with no spinner or
// flash. The panel only replaces the page once we KNOW the tenant country is out
// of scope. The server remains the real enforcement boundary; this is UX.

import { useTenantCountries } from '@/lib/useTenantCountries';

const COUNTRY_LABELS = { IN: 'India', NZ: 'New Zealand' };

export default function CountryGate({ allow = 'IN', label, children }) {
  const { country, loading } = useTenantCountries();
  const allowed = (Array.isArray(allow) ? allow : [allow]).map((c) => String(c).toUpperCase());
  const cc = country ? String(country).toUpperCase() : null;

  // Unresolved (loading / pre-setup) or in-scope → render the page unchanged.
  if (loading || !cc || allowed.includes(cc)) return children;

  const here = COUNTRY_LABELS[cc] || cc;
  const allowedLabels = allowed.map((c) => COUNTRY_LABELS[c] || c).join(', ');
  return (
    <div className="p-6 sm:p-8">
      <div className="max-w-xl rounded-xl border border-gray-200 bg-gray-50 px-6 py-8 text-center">
        <div className="text-3xl mb-3" aria-hidden="true">🌐</div>
        <h1 className="text-lg font-semibold text-gray-900">
          {label ? `${label} isn't available for your country` : "Not available for your country"}
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          This is a statutory surface for {allowedLabels} tenants. Your workspace runs
          HR &amp; payroll in {here}, so it doesn't apply here.
        </p>
      </div>
    </div>
  );
}

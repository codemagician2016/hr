'use client';

import { useEffect, useRef, useState } from 'react';
import { addressProfile } from '../lib/addressProfiles';
import { loadGoogleMaps, parseGooglePlace } from '../lib/googlePlaces';

const DEFAULT_INPUT = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900';

function Field({ label, children, hint, error }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs font-medium text-red-600">{error}</span>
        : hint ? <span className="mt-1 block text-xs text-gray-400">{hint}</span> : null}
    </label>
  );
}

// Country-aware address + tax-ID block. value = { line1, line2, city, state,
// postalCode }; onChange(nextValue). taxId/onTaxIdChange handled separately so
// it can live on the parent's billing profile.
export default function CountryAddressFields({
  country,
  value,
  onChange,
  taxId = '',
  onTaxIdChange,
  purchaserType = 'INDIVIDUAL',
  disabled = false,
  showTax = true,
  inputClass = DEFAULT_INPUT,
}) {
  const profile = addressProfile(country);
  const v = value || {};
  const valueRef = useRef(v);
  valueRef.current = v;
  const set = (patch) => onChange?.({ ...valueRef.current, ...patch });

  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState('');
  const [localities, setLocalities] = useState([]);
  const searchRef = useRef(null);

  // ── India: PIN → state + city ──────────────────────────────────────────────
  useEffect(() => {
    if (profile.kind !== 'IN') return undefined;
    const pin = String(v.postalCode || '').trim();
    if (!/^[1-9][0-9]{5}$/.test(pin)) { setLocalities([]); setPinError(''); return undefined; }
    let cancelled = false;
    setPinLoading(true); setPinError('');
    fetch(`/api/geo/in-pincode/${pin}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
      .then((d) => {
        if (cancelled) return;
        set({ state: d.state || valueRef.current.state || '', city: d.city || valueRef.current.city || '' });
        setLocalities(Array.isArray(d.localities) && d.localities.length > 1 ? d.localities : []);
      })
      .catch(() => { if (!cancelled) setPinError('Could not find that PIN — enter city/state manually.'); })
      .finally(() => { if (!cancelled) setPinLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.kind, v.postalCode]);

  // ── NZ: Google Places autocomplete on the search box ───────────────────────
  useEffect(() => {
    if (profile.kind !== 'NZ' || !searchRef.current || disabled) return undefined;
    let ac;
    let active = true;
    loadGoogleMaps().then((maps) => {
      if (!active || !maps?.places || !searchRef.current) return;
      ac = new maps.places.Autocomplete(searchRef.current, {
        fields: ['address_components', 'name'],
        componentRestrictions: { country: ['nz'] },
        types: ['address'],
      });
      ac.addListener('place_changed', () => {
        const parsed = parseGooglePlace(ac.getPlace());
        set(parsed);
      });
    });
    return () => {
      active = false;
      if (ac && window.google?.maps?.event) window.google.maps.event.clearInstanceListeners(ac);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.kind, disabled]);

  const ro = disabled;
  const roClass = ro ? `${inputClass} bg-gray-50 text-gray-500 cursor-not-allowed` : inputClass;
  const taxInvalid = profile.tax?.show && profile.tax?.validate && taxId && !profile.tax.validate(taxId);

  return (
    <div className="space-y-3.5">
      {/* NZ address search */}
      {profile.kind === 'NZ' && !ro && (
        <Field label="Search your address" hint="Start typing — pick your address to auto-fill the fields below.">
          <input ref={searchRef} className={inputClass} placeholder="e.g. 123 Queen Street, Auckland" disabled={disabled} />
        </Field>
      )}

      <div className="grid gap-3.5 md:grid-cols-2">
        <Field label="Address line 1">
          <input className={roClass} value={v.line1 || ''} onChange={(e) => set({ line1: e.target.value })} placeholder="Street address" disabled={disabled} />
        </Field>
        <Field label="Address line 2">
          <input className={roClass} value={v.line2 || ''} onChange={(e) => set({ line2: e.target.value })} placeholder="Suite, unit, floor (optional)" disabled={disabled} />
        </Field>
      </div>

      {/* India leads with PIN so state/city auto-fill */}
      {profile.kind === 'IN' && (
        <div className="grid gap-3.5 md:grid-cols-2">
          <Field label={profile.postalLabel} error={pinError} hint={pinLoading ? 'Looking up…' : 'Enter PIN — city & state fill in automatically.'}>
            <input className={roClass} inputMode="numeric" maxLength={6} value={v.postalCode || ''} onChange={(e) => set({ postalCode: e.target.value.replace(/[^0-9]/g, '').slice(0, 6) })} placeholder={profile.postalPlaceholder} disabled={disabled} />
          </Field>
          {localities.length > 1 ? (
            <Field label="Area / Locality" hint="Pick the exact locality for this PIN.">
              <select className={roClass} value={v.line2 || ''} onChange={(e) => set({ line2: e.target.value })} disabled={disabled}>
                <option value="">Select locality…</option>
                {localities.map((loc) => <option key={loc} value={loc}>{loc}</option>)}
              </select>
            </Field>
          ) : (
            <Field label={profile.cityLabel}>
              <input className={roClass} value={v.city || ''} onChange={(e) => set({ city: e.target.value })} disabled={disabled} />
            </Field>
          )}
        </div>
      )}

      <div className="grid gap-3.5 md:grid-cols-2">
        {profile.kind !== 'IN' && (
          <Field label={profile.cityLabel}>
            <input className={roClass} value={v.city || ''} onChange={(e) => set({ city: e.target.value })} disabled={disabled} />
          </Field>
        )}
        <Field label={profile.stateLabel}>
          {profile.states ? (
            <select className={roClass} value={v.state || ''} onChange={(e) => set({ state: e.target.value })} disabled={disabled}>
              <option value="">Select {profile.stateLabel.toLowerCase()}…</option>
              {profile.states.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <input className={roClass} value={v.state || ''} onChange={(e) => set({ state: e.target.value })} disabled={disabled} />
          )}
        </Field>
        {profile.kind !== 'IN' && (
          <Field label={profile.postalLabel}>
            <input className={roClass} value={v.postalCode || ''} onChange={(e) => set({ postalCode: e.target.value })} placeholder={profile.postalPlaceholder} disabled={disabled} />
          </Field>
        )}
      </div>

      {/* Tax ID — only where the buyer's tax id is relevant (IN, UK/EU), and only
          when the consumer wants it (billing yes; public storefront address no). */}
      {profile.tax?.show && showTax && (
        <Field
          label={profile.tax.label}
          error={taxInvalid ? profile.tax.invalidMsg : ''}
          hint={!taxInvalid && profile.kind === 'IN' && purchaserType === 'BUSINESS' ? 'Required for a business tax invoice + input credit.' : ''}
        >
          <input className={inputClass} value={taxId || ''} onChange={(e) => onTaxIdChange?.(e.target.value.toUpperCase())} placeholder={profile.tax.placeholder} disabled={disabled} />
        </Field>
      )}
    </div>
  );
}

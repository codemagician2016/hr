'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — real CitiesPanel.
// Backend: /api/ecom/cities + /api/ecom/zones (Phase 3d).

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  KpiCard, KpiGrid,
  StatusBadge,
  PageHeader, EmptyState, ErrorBanner, PrimaryButton, SecondaryButton,
  fmtNumber,
} from '@/components/ecom-ui';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${res.status}`);
  return body;
}

const STATUSES = [
  { key: 'LIVE',         label: 'Live',         tone: 'success' },
  { key: 'COMING_SOON',  label: 'Coming soon',  tone: 'info' },
  { key: 'PAUSED',       label: 'Paused',       tone: 'warning' },
];

const TONE_CLASSES = {
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
};

function formatMoney(minor) {
  if (!minor) return '£0';
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100); }
  catch { return `£${(minor / 100).toFixed(2)}`; }
}

function CityForm({ initial, onSave, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => ({
    name: initial?.name || '',
    slug: initial?.slug || '',
    countryCode: initial?.countryCode || 'GB',
    region: initial?.region || '',
    timezone: initial?.timezone || '',
    status: initial?.status || 'LIVE',
    taxJurisdiction: initial?.taxJurisdiction || '',
    currency: initial?.currency || '',
    defaultLocale: initial?.defaultLocale || '',
  }));

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.slug.trim() || !form.countryCode.trim()) {
      setError('Name, slug, and country code are required'); return;
    }
    setBusy(true); setError('');
    try {
      const payload = {
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase(),
        countryCode: form.countryCode.trim().toUpperCase(),
        status: form.status,
      };
      if (form.region.trim()) payload.region = form.region.trim();
      if (form.timezone.trim()) payload.timezone = form.timezone.trim();
      if (form.taxJurisdiction.trim()) payload.taxJurisdiction = form.taxJurisdiction.trim();
      if (form.currency.trim()) payload.currency = form.currency.trim().toUpperCase();
      if (form.defaultLocale.trim()) payload.defaultLocale = form.defaultLocale.trim();

      if (initial?.id) {
        await api(`/api/ecom/cities/${initial.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/ecom/cities', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSave?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="City name *" value={form.name} onChange={set('name')} placeholder="Mumbai" />
        <Field label="Slug *" value={form.slug} onChange={set('slug')} placeholder="mumbai" />
        <Field label="Country (ISO-2) *" value={form.countryCode} onChange={set('countryCode')} placeholder="IN" maxLength={2} />
        <Field label="Region" value={form.region} onChange={set('region')} placeholder="Maharashtra" />
        <Field label="Timezone (IANA)" value={form.timezone} onChange={set('timezone')} placeholder="Asia/Kolkata" />
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Status</label>
          <select value={form.status} onChange={set('status')}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm">
            {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <Field label="Tax jurisdiction" value={form.taxJurisdiction} onChange={set('taxJurisdiction')} placeholder="IN_GST" />
        <Field label="Currency (ISO-3)" value={form.currency} onChange={set('currency')} placeholder="INR" maxLength={3} />
        <Field label="Default locale" value={form.defaultLocale} onChange={set('defaultLocale')} placeholder="hi" />
      </div>
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700">Cancel</button>
        <button type="submit" disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? 'Saving…' : initial?.id ? 'Save' : 'Add city'}
        </button>
      </div>
    </form>
  );
}

function ZoneForm({ initial, cityId, storeLocations = [], onSave, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => ({
    name: initial?.name || '',
    slug: initial?.slug || '',
    primaryLocationId: initial?.primaryLocationId || '',
    postcodes: (initial?.postcodes || []).join(', '),
    deliveryFeeMinor: initial?.deliveryFeeMinor || 0,
    freeDeliveryThresholdMinor: initial?.freeDeliveryThresholdMinor || 0,
    expressSurchargeMinor: initial?.expressSurchargeMinor || 0,
    promiseMinutes: initial?.promiseMinutes || '',
  }));
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.slug.trim()) { setError('Name and slug are required'); return; }
    setBusy(true); setError('');
    try {
      const payload = {
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase(),
        primaryLocationId: form.primaryLocationId || null,
        postcodes: form.postcodes.split(',').map((p) => p.trim()).filter(Boolean),
        deliveryFeeMinor: Number(form.deliveryFeeMinor),
        freeDeliveryThresholdMinor: Number(form.freeDeliveryThresholdMinor),
        expressSurchargeMinor: Number(form.expressSurchargeMinor),
      };
      if (!initial?.id) payload.cityId = cityId;
      if (form.promiseMinutes) payload.promiseMinutes = Number(form.promiseMinutes);

      if (initial?.id) {
        await api(`/api/ecom/zones/${initial.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/ecom/zones', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSave?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Zone name *" value={form.name} onChange={set('name')} />
        <Field label="Slug *" value={form.slug} onChange={set('slug')} />
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Fulfilled by store</label>
          <select
            value={form.primaryLocationId}
            onChange={set('primaryLocationId')}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
          >
            <option value="">City pool — any active store in this city</option>
            {storeLocations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}{loc.city ? ` · ${loc.city}` : ''}{loc.isPrimary ? ' · Primary' : ''}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-gray-500">
            Pin a postcode zone to one store for Pak'nSave-style separate inventory, pricing, riders, and slots.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Postcodes (comma-separated)</label>
          <input type="text" value={form.postcodes} onChange={set('postcodes')} placeholder="SW1A, EC1V, W1B"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono" />
        </div>
        <Field label="Delivery fee (pence)" type="number" value={form.deliveryFeeMinor} onChange={set('deliveryFeeMinor')} min="0" />
        <Field label="Free delivery threshold (pence)" type="number" value={form.freeDeliveryThresholdMinor} onChange={set('freeDeliveryThresholdMinor')} min="0" />
        <Field label="Express surcharge (pence)" type="number" value={form.expressSurchargeMinor} onChange={set('expressSurchargeMinor')} min="0" />
        <Field label="Promise minutes" type="number" value={form.promiseMinutes} onChange={set('promiseMinutes')} min="0" />
      </div>
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700">Cancel</button>
        <button type="submit" disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? 'Saving…' : initial?.id ? 'Save' : 'Add zone'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, ...props }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input {...props} className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function CitiesPanel() {
  const [cities, setCities] = useState([]);
  const [storeLocations, setStoreLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingCity, setEditingCity] = useState(null);
  const [editingZone, setEditingZone] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, locationList] = await Promise.all([
        api('/api/ecom/cities'),
        api('/api/ecom/locations'),
      ]);
      setCities(list.rows || []);
      setStoreLocations(locationList.locations || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function deleteCity(id) {
    if (!window.confirm('Delete this city? Zones will be deleted too.')) return;
    try { await api(`/api/ecom/cities/${id}`, { method: 'DELETE' }); reload(); }
    catch (err) { setError(err.message); }
  }

  async function deleteZone(id) {
    if (!window.confirm('Delete this zone?')) return;
    try { await api(`/api/ecom/zones/${id}`, { method: 'DELETE' }); reload(); }
    catch (err) { setError(err.message); }
  }

  // Coverage metrics across all cities — surfaces footprint at a glance.
  const kpis = useMemo(() => {
    const live = cities.filter((c) => c.status === 'LIVE').length;
    const comingSoon = cities.filter((c) => c.status === 'COMING_SOON').length;
    const totalZones = cities.reduce((s, c) => s + (c.zones?.length || 0), 0);
    const totalPostcodes = cities.reduce(
      (s, c) => s + (c.zones || []).reduce((z, zone) => z + (zone.postcodes?.length || 0), 0),
      0,
    );
    return { live, comingSoon, totalZones, totalPostcodes };
  }, [cities]);
  const storeById = useMemo(
    () => new Map(storeLocations.map((loc) => [loc.id, loc])),
    [storeLocations],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cities & zones"
        subtitle={`${cities.length} cit${cities.length === 1 ? 'y' : 'ies'} · ${kpis.totalZones} delivery zone${kpis.totalZones === 1 ? '' : 's'}`}
        actions={<PrimaryButton onClick={() => setEditingCity({})}>+ Add city</PrimaryButton>}
      />

      {cities.length > 0 && (
        <KpiGrid cols={4}>
          <KpiCard label="Live cities" value={fmtNumber(kpis.live)} tone="success"
            hint={kpis.comingSoon > 0 ? `+${kpis.comingSoon} coming soon` : null} />
          <KpiCard label="Delivery zones" value={fmtNumber(kpis.totalZones)} hint="Across all cities" />
          <KpiCard label="Postcodes covered" value={fmtNumber(kpis.totalPostcodes)} hint="Sum across zones" />
          <KpiCard label="Countries" value={fmtNumber(new Set(cities.map((c) => c.countryCode)).size)} />
        </KpiGrid>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {loading && cities.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">Loading…</div>
      ) : cities.length === 0 ? (
        <EmptyState
          title="No cities configured"
          message="Cities define your service footprint. Each city contains delivery zones (postcode groups) with their own delivery fees and free-delivery thresholds. Start with the city your first store is in."
          action={<PrimaryButton onClick={() => setEditingCity({})}>+ Add your first city</PrimaryButton>}
        />
      ) : (
        cities.map((city) => {
          const statusMeta = STATUSES.find((s) => s.key === city.status) || STATUSES[0];
          return (
            <div key={city.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-semibold text-gray-900">{city.name}</h3>
                    <StatusBadge tone={statusMeta.tone}>{statusMeta.label.toLowerCase()}</StatusBadge>
                    <span className="text-[10px] font-mono text-gray-500">{city.countryCode}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {city.region ? `${city.region} · ` : ''}
                    {city.zones?.length || 0} zones
                    {city.currency ? ` · ${city.currency}` : ''}
                    {city.taxJurisdiction ? ` · ${city.taxJurisdiction}` : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditingZone({ cityId: city.id })}
                    className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 hover:underline">+ Zone</button>
                  <button type="button" onClick={() => setEditingCity(city)}
                    className="text-xs font-semibold text-gray-700 hover:underline">Edit</button>
                  <button type="button" onClick={() => deleteCity(city.id)}
                    className="text-xs font-semibold text-red-700 hover:underline">Delete</button>
                </div>
              </div>
              {(city.zones || []).length === 0 ? (
                <p className="px-6 py-4 text-xs text-gray-400">No delivery zones yet — click <strong>+ Zone</strong> to add one.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {(city.zones || []).map((z) => (
                    <div key={z.id} className="px-6 py-3 flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900">{z.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5 font-mono">
                          {(z.postcodes || []).slice(0, 6).join(', ')}{(z.postcodes?.length || 0) > 6 ? '…' : ''}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          Fee {formatMoney(z.deliveryFeeMinor)}
                          {z.freeDeliveryThresholdMinor > 0 ? ` · free over ${formatMoney(z.freeDeliveryThresholdMinor)}` : ''}
                          {z.promiseMinutes ? ` · ${z.promiseMinutes}min promise` : ''}
                          {z.primaryLocationId ? ` · ${storeById.get(z.primaryLocationId)?.name || 'Pinned store'}` : ' · city pool'}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button type="button" onClick={() => setEditingZone({ ...z, cityId: city.id })}
                          className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 hover:underline">Edit</button>
                        <button type="button" onClick={() => deleteZone(z.id)}
                          className="text-xs font-semibold text-red-700 hover:underline">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}

      {editingCity && (
        <Modal title={editingCity.id ? `Edit ${editingCity.name}` : 'Add city'} onClose={() => setEditingCity(null)}>
          <CityForm initial={editingCity.id ? editingCity : null}
            onCancel={() => setEditingCity(null)}
            onSave={() => { setEditingCity(null); reload(); }} />
        </Modal>
      )}
      {editingZone && (
        <Modal title={editingZone.id ? `Edit zone` : 'Add zone'} onClose={() => setEditingZone(null)}>
          <ZoneForm initial={editingZone.id ? editingZone : null} cityId={editingZone.cityId}
            storeLocations={storeLocations}
            onCancel={() => setEditingZone(null)}
            onSave={() => { setEditingZone(null); reload(); }} />
        </Modal>
      )}
    </div>
  );
}

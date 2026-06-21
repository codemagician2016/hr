'use client';

// Click & Collect — admin panel for managing pickup locations.
// CRUD against /api/ecom/pickup-locations. Activated from the Settings tab
// when paymentFulfillmentSettings.pickupEnabled is true.

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/components/ecom-ui/api';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMPTY_HOUR = { open: '09:00', close: '21:00' };

function defaultHours() {
  const h = {};
  for (let i = 0; i < 7; i++) h[String(i)] = { ...EMPTY_HOUR };
  return h;
}

function PickupForm({ initial, onSave, onCancel, storeLocations = [] }) {
  const [form, setForm] = useState(() => ({
    locationId: initial?.locationId || '',
    name: initial?.name || '',
    addressLine1: initial?.addressLine1 || '',
    addressLine2: initial?.addressLine2 || '',
    city: initial?.city || '',
    region: initial?.region || '',
    postalCode: initial?.postalCode || '',
    countryCode: initial?.countryCode || 'IN',
    latitude: initial?.latitude ?? '',
    longitude: initial?.longitude ?? '',
    contactPhone: initial?.contactPhone || '',
    contactEmail: initial?.contactEmail || '',
    prepTimeMinutes: initial?.prepTimeMinutes ?? 30,
    pickupInstructions: initial?.pickupInstructions || '',
    isActive: initial?.isActive !== false,
    hours: initial?.hours && Object.keys(initial.hours).length ? initial.hours : defaultHours(),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setHour = (day, k, v) => setForm((f) => ({ ...f, hours: { ...f.hours, [day]: { ...(f.hours[day] || EMPTY_HOUR), [k]: v } } }));
  const toggleClosed = (day) => setForm((f) => ({ ...f, hours: { ...f.hours, [day]: f.hours[day] ? null : { ...EMPTY_HOUR } } }));

  async function submit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const payload = {
        ...form,
        latitude: form.latitude === '' ? null : Number(form.latitude),
        longitude: form.longitude === '' ? null : Number(form.longitude),
        prepTimeMinutes: Number(form.prepTimeMinutes) || 0,
      };
      if (initial?.id) {
        await api(`/api/ecom/pickup-locations/${initial.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/ecom/pickup-locations', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSave();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  const inp = "w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500";

  return (
    <form onSubmit={submit} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <h3 className="text-sm font-bold text-gray-900">{initial?.id ? 'Edit pickup location' : 'New pickup location'}</h3>

      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Pickup point name</label>
        <input className={inp} value={form.name} onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Front counter, Drive-thru, Mall kiosk" required />
        <p className="text-[11px] text-gray-400 mt-1">Shown to customers at checkout when they choose pickup.</p>
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Which branch is this at?</label>
        <select className={inp} value={form.locationId} onChange={(e) => set('locationId', e.target.value)}>
          <option value="">Available at all branches</option>
          {storeLocations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.name}{loc.city ? ` — ${loc.city}` : ''}{loc.isPrimary ? ' (main)' : ''}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-gray-400 mt-1">
          {storeLocations.length > 1
            ? 'Customers shopping that branch will see this pickup point. Pick a branch so it only shows there.'
            : 'Links this pickup point to your store.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-gray-700 mb-1">Address line 1</label>
          <input className={inp} value={form.addressLine1} onChange={(e) => set('addressLine1', e.target.value)} required />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-gray-700 mb-1">Address line 2 (optional)</label>
          <input className={inp} value={form.addressLine2} onChange={(e) => set('addressLine2', e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">City</label>
          <input className={inp} value={form.city} onChange={(e) => set('city', e.target.value)} required />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">State / region</label>
          <input className={inp} value={form.region} onChange={(e) => set('region', e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Postal code</label>
          <input className={inp} value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} required />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Country (ISO-2)</label>
          <input className={inp} value={form.countryCode} onChange={(e) => set('countryCode', e.target.value.toUpperCase())} maxLength={2} required />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Latitude (optional)</label>
          <input className={inp} type="number" step="any" value={form.latitude} onChange={(e) => set('latitude', e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Longitude (optional)</label>
          <input className={inp} type="number" step="any" value={form.longitude} onChange={(e) => set('longitude', e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Contact phone</label>
          <input className={inp} value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} placeholder="+91 98765 43210" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Prep time (minutes)</label>
          <input className={inp} type="number" min={0} max={1440} value={form.prepTimeMinutes} onChange={(e) => set('prepTimeMinutes', e.target.value)} />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Pickup instructions (optional)</label>
        <textarea className={inp} rows={2} value={form.pickupInstructions}
          onChange={(e) => set('pickupInstructions', e.target.value)}
          placeholder="Park in B2 · Ask for counter 5" />
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-2">Opening hours</label>
        <div className="grid grid-cols-1 gap-2">
          {DOW.map((day, i) => {
            const v = form.hours[String(i)];
            const closed = v === null;
            return (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-12 font-semibold text-gray-700">{day}</span>
                <label className="flex items-center gap-1 text-gray-600">
                  <input type="checkbox" checked={!closed} onChange={() => toggleClosed(String(i))} /> Open
                </label>
                {!closed && (
                  <>
                    <input type="time" className="px-2 py-1 border border-gray-300 rounded text-xs"
                      value={v?.open || '09:00'} onChange={(e) => setHour(String(i), 'open', e.target.value)} />
                    <span className="text-gray-400">–</span>
                    <input type="time" className="px-2 py-1 border border-gray-300 rounded text-xs"
                      value={v?.close || '21:00'} onChange={(e) => setHour(String(i), 'close', e.target.value)} />
                  </>
                )}
                {closed && <span className="text-gray-400 italic">Closed</span>}
              </div>
            );
          })}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} />
        Active (visible to buyers at checkout)
      </label>

      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50">
          {busy ? 'Saving…' : 'Save location'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-semibold">
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function PickupLocationsPanel() {
  const [locations, setLocations] = useState([]);
  const [storeLocations, setStoreLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null = list view, {} = new, {id…} = edit

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/api/ecom/pickup-locations');
      setLocations(data?.locations || []);
      setStoreLocations(data?.storeLocations || []);
    } catch { /* surface elsewhere */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDelete(id) {
    if (!confirm('Hide this pickup location? Buyers won\'t see it at checkout. Existing orders are unaffected.')) return;
    try {
      await api(`/api/ecom/pickup-locations/${id}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      alert(err.message || 'Could not delete');
    }
  }

  if (editing) {
    return (
      <PickupForm initial={editing.id ? editing : null}
        storeLocations={storeLocations}
        onSave={() => { setEditing(null); refresh(); }}
        onCancel={() => setEditing(null)} />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-gray-900">Pickup locations</h2>
          <p className="text-xs text-gray-500 mt-0.5">Buyers pick from this list when they choose Pickup at checkout.</p>
        </div>
        <button onClick={() => setEditing({})}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">
          + Add location
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
      ) : locations.length === 0 ? (
        <div className="p-8 text-center bg-gray-50 rounded-xl border border-gray-200">
          <p className="text-3xl">🏬</p>
          <p className="mt-2 text-sm font-semibold text-gray-700">No pickup locations yet</p>
          <p className="text-xs text-gray-500 mt-1">Add your first store / counter so buyers can collect their orders.</p>
        </div>
      ) : (
        <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
          {locations.map((loc, i) => (
            <div key={loc.id}
              className={`flex items-start gap-4 p-4 ${i ? 'border-t border-gray-100' : ''} ${loc.isActive ? '' : 'opacity-60'}`}>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-gray-900">
                  {loc.name}
                  {!loc.isActive && <span className="ml-2 text-[10px] font-bold uppercase text-gray-400">Inactive</span>}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {[loc.addressLine1, loc.city, loc.region, loc.postalCode].filter(Boolean).join(', ')}
                </p>
                <p className="text-[11px] text-gray-400 mt-1">
                  {loc.location?.name ? `${loc.location.name} · ` : ''}
                  Ready in ~{loc.prepTimeMinutes} min{loc.contactPhone ? ` · ${loc.contactPhone}` : ''}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => setEditing(loc)} className="px-3 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 rounded">Edit</button>
                <button onClick={() => handleDelete(loc.id)} className="px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 rounded">Hide</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

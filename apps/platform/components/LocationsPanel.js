'use client';

// Multi-location admin panel. Mounted from [slug]/admin/page.js when
// tab='locations'. CRUD against /api/locations. Designate a primary;
// only active locations are exposed to the storefront's location-picker.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useConfirm } from '@/components/ConfirmDialog';
import { useTenant } from '@/components/TenantProvider';
import { resolveVertical } from '@/lib/vertical';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.issues = body.issues;
    throw err;
  }
  return body;
}

const COUNTRIES = [
  { code: 'IN', name: 'India' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
];

function emptyDraft() {
  return {
    id: null,
    name: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    phone: '',
    isPrimary: false,
    isActive: true,
  };
}

function fromLoc(loc) {
  return {
    id: loc.id,
    name: loc.name || '',
    addressLine1: loc.addressLine1 || '',
    addressLine2: loc.addressLine2 || '',
    city: loc.city || '',
    state: loc.state || '',
    postalCode: loc.postalCode || '',
    country: loc.country || '',
    phone: loc.phone || '',
    isPrimary: !!loc.isPrimary,
    isActive: loc.isActive !== false,
  };
}

export default function LocationsPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { tenant } = useTenant();
  const vertical = resolveVertical(tenant?.business?.vertical);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  const view = searchParams.get('view') || '';
  const locationId = searchParams.get('id') || '';
  const copy = useMemo(() => {
    if (vertical === 'ECOMMERCE') {
      return {
        title: 'Locations',
        body: 'Add warehouses, grocery stores, and pickup points. The primary location powers default fulfillment routing.',
        primaryHint: 'default warehouse/store for fulfillment mode',
        emptyHint: 'Add your first location to enable stock, pricing, slots, and order routing by place.',
      };
    }
    if (vertical === 'APPOINTMENT') {
      return {
        title: 'Locations',
        body: 'Add clinics, studios, offices, or service branches that customers may visit or see on your booking website.',
        primaryHint: 'default branch shown first to booking customers',
        emptyHint: 'Add your first branch or office for appointment directions and public contact details.',
      };
    }
    return {
      title: 'Locations',
      body: 'Add public business locations for your website and contact details.',
      primaryHint: 'default location shown first',
      emptyHint: 'Add your first location for your website contact details.',
    };
  }, [vertical]);

  const replaceQuery = useCallback((mutator) => {
    const params = new URLSearchParams(searchParams.toString());
    mutator(params);
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);

  const closeDraft = useCallback(() => {
    replaceQuery((params) => {
      params.delete('view');
      params.delete('id');
    });
  }, [replaceQuery]);

  const openCreate = useCallback(() => {
    setDraft(emptyDraft());
    replaceQuery((params) => {
      params.set('view', 'location-create');
      params.delete('id');
    });
  }, [replaceQuery]);

  const openEdit = useCallback((loc) => {
    setDraft(fromLoc(loc));
    replaceQuery((params) => {
      params.set('view', 'location-edit');
      params.set('id', loc.id);
    });
  }, [replaceQuery]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/locations');
      setItems(data.locations || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (loading) return;
    if (view === 'location-create') {
      setDraft((current) => current || emptyDraft());
      return;
    }
    if (view === 'location-edit' && locationId) {
      const match = items.find((item) => item.id === locationId);
      setDraft(match ? fromLoc(match) : null);
      return;
    }
    setDraft(null);
  }, [items, loading, locationId, view]);

  function setField(k, v) {
    setDraft((d) => d ? { ...d, [k]: v } : d);
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        name: draft.name.trim(),
        addressLine1: draft.addressLine1.trim() || undefined,
        addressLine2: draft.addressLine2.trim() || undefined,
        city: draft.city.trim() || undefined,
        state: draft.state.trim() || undefined,
        postalCode: draft.postalCode.trim() || undefined,
        country: draft.country.trim() || undefined,
        phone: draft.phone.trim() || undefined,
        isPrimary: draft.isPrimary,
        isActive: draft.isActive,
      };
      if (draft.id) {
        await api(`/api/locations/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/locations', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeDraft();
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setSaving(false); }
  }

  async function remove(loc) {
    if (!await confirm(`Delete "${loc.name}"? Bookings already linked to this location keep their record but lose the connection.`, { confirmLabel: 'Delete', tone: 'danger' })) return;
    try {
      await api(`/api/locations/${loc.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function makePrimary(loc) {
    try {
      await api(`/api/locations/${loc.id}`, { method: 'PUT', body: JSON.stringify({ isPrimary: true }) });
      await load();
    } catch (err) { setError(err.message); }
  }

  async function toggleActive(loc) {
    try {
      await api(`/api/locations/${loc.id}`, { method: 'PUT', body: JSON.stringify({ isActive: !loc.isActive }) });
      await load();
    } catch (err) { setError(err.message); }
  }

  if (draft) {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{draft.id ? 'Edit location' : 'New location'}</h2>
          <div className="flex gap-2">
            <button type="button" onClick={closeDraft} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={save} disabled={saving} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:bg-indigo-300">
              {saving ? 'Saving…' : (draft.id ? 'Save changes' : 'Add location')}
            </button>
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input type="text" value={draft.name} onChange={(e) => setField('name', e.target.value)}
              placeholder="Main Branch / Downtown Studio / North Office"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-700 mb-1">Address line 1</label>
            <input type="text" value={draft.addressLine1} onChange={(e) => setField('addressLine1', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-700 mb-1">Address line 2</label>
            <input type="text" value={draft.addressLine2} onChange={(e) => setField('addressLine2', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">City</label>
            <input type="text" value={draft.city} onChange={(e) => setField('city', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">State / region</label>
            <input type="text" value={draft.state} onChange={(e) => setField('state', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Postal / ZIP</label>
            <input type="text" value={draft.postalCode} onChange={(e) => setField('postalCode', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Country</label>
            <select value={draft.country} onChange={(e) => setField('country', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              <option value="">—</option>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Phone</label>
            <input type="tel" value={draft.phone} onChange={(e) => setField('phone', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>

          <div className="sm:col-span-2 flex items-center gap-6 pt-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.isPrimary} onChange={(e) => setField('isPrimary', e.target.checked)} className="w-4 h-4" />
              <span>Primary location <span className="text-gray-400 font-normal">({copy.primaryHint})</span></span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => setField('isActive', e.target.checked)} className="w-4 h-4" />
              <span>Active <span className="text-gray-400 font-normal">(available to admin and storefront routing)</span></span>
            </label>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{copy.title}</h2>
          <p className="text-sm text-gray-500">{copy.body}</p>
        </div>
        <button type="button" onClick={openCreate} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700">+ New location</button>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-gray-300 rounded-2xl">
          <p className="text-3xl">📍</p>
          <p className="mt-3 text-sm font-medium text-gray-900">No locations yet</p>
          <p className="text-xs text-gray-500 mt-1">{copy.emptyHint}</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-2xl overflow-hidden">
          {items.map((loc) => {
            const addr = [loc.addressLine1, loc.city, loc.state, loc.postalCode].filter(Boolean).join(', ');
            return (
              <li key={loc.id} className={`flex items-center gap-4 p-4 ${loc.isActive ? '' : 'bg-gray-50 opacity-70'} hover:bg-gray-50`}>
                <div className="w-12 h-12 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-xl flex-shrink-0">📍</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-gray-900 truncate">{loc.name}</p>
                    {loc.isPrimary && <span className="text-xs bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded-full">Primary</span>}
                    {!loc.isActive && <span className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">Hidden</span>}
                  </div>
                  {addr && <p className="text-xs text-gray-500 truncate">{addr}</p>}
                  {loc.phone && <p className="text-xs text-gray-400">{loc.phone}</p>}
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {!loc.isPrimary && loc.isActive && (
                    <button type="button" onClick={() => makePrimary(loc)} className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-white">Make primary</button>
                  )}
                  <button type="button" onClick={() => toggleActive(loc)} className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-white">
                    {loc.isActive ? 'Hide' : 'Show'}
                  </button>
                  <button type="button" onClick={() => openEdit(loc)} className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-white">Edit</button>
                  <button type="button" onClick={() => remove(loc)} className="px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 text-red-700 hover:bg-red-50">Delete</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

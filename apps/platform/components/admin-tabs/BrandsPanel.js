'use client';

// Brands panel — two-level (Family → Brand) catalog manager.
// Layout: families list on the left, brands of the selected family on the
// right, plus a "Pre-populate brands for [Country]" CTA when the catalog
// is empty AND the tenant's country is in our seed catalog (IN/NZ/AU).
//
// Backend: /api/ecom/brand-families + /api/ecom/brands (CRUD) +
// /api/ecom/brands/seed-country (idempotent country seed).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/components/ecom-ui/api';
import BulkImportModal from '@/components/admin-tabs/BulkImportModal';

const SUPPORTED_COUNTRIES = ['IN', 'NZ', 'AU'];

function FamilyRow({ family, active, onSelect, onEdit }) {
  return (
    <button type="button" onClick={onSelect}
      className={`w-full text-left px-4 py-3 border-l-4 transition-colors ${active ? 'border-indigo-500 bg-indigo-50' : 'border-transparent hover:bg-gray-50'} ${family.isActive ? '' : 'opacity-60'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">
            {family.name}
            {!family.isActive && <span className="ml-2 text-[10px] font-bold uppercase text-gray-400">Hidden</span>}
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {family._count?.brands ?? 0} brand{family._count?.brands === 1 ? '' : 's'}
            {family.countryCode ? ` · ${family.countryCode}` : ''}
          </p>
        </div>
        <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="text-[11px] font-semibold text-indigo-600 hover:underline shrink-0">
          Edit
        </button>
      </div>
    </button>
  );
}

function FamilyForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    name: initial?.name || '',
    countryCode: initial?.countryCode || '',
    description: initial?.description || '',
    isActive: initial?.isActive !== false,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const body = JSON.stringify({
        ...form, countryCode: form.countryCode || null,
      });
      if (initial?.id) await api(`/api/ecom/brand-families/${initial.id}`, { method: 'PUT', body });
      else await api('/api/ecom/brand-families', { method: 'POST', body });
      onSave();
    } catch (err) { setError(err.message || 'Save failed'); }
    finally { setBusy(false); }
  }

  const inp = "w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500";

  return (
    <form onSubmit={submit} className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-bold text-gray-900">{initial?.id ? 'Edit family' : 'New brand family'}</h3>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Name</label>
        <input className={inp} value={form.name} required
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Unilever, Procter & Gamble, Fonterra…" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Country (optional)</label>
        <select className={inp} value={form.countryCode}
          onChange={(e) => setForm({ ...form, countryCode: e.target.value })}>
          <option value="">— Any —</option>
          <option value="IN">India</option>
          <option value="NZ">New Zealand</option>
          <option value="AU">Australia</option>
        </select>
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Description (optional)</label>
        <textarea className={inp} rows={2} value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={form.isActive}
          onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
        Active
      </label>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50">
          {busy ? 'Saving…' : 'Save family'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-semibold">Cancel</button>
      </div>
    </form>
  );
}

function BrandForm({ initial, families, defaultFamilyId, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    name: initial?.name || '',
    brandFamilyId: initial?.brandFamilyId || defaultFamilyId || '',
    countryCode: initial?.countryCode || '',
    description: initial?.description || '',
    isActive: initial?.isActive !== false,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const body = JSON.stringify({
        ...form,
        brandFamilyId: form.brandFamilyId || null,
        countryCode: form.countryCode || null,
      });
      if (initial?.id) await api(`/api/ecom/brands/${initial.id}`, { method: 'PUT', body });
      else await api('/api/ecom/brands', { method: 'POST', body });
      onSave();
    } catch (err) { setError(err.message || 'Save failed'); }
    finally { setBusy(false); }
  }

  const inp = "w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500";

  return (
    <form onSubmit={submit} className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-bold text-gray-900">{initial?.id ? 'Edit brand' : 'New brand'}</h3>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Brand name</label>
        <input className={inp} value={form.name} required
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Surf, Dove, Vegemite…" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Family (optional)</label>
        <select className={inp} value={form.brandFamilyId}
          onChange={(e) => setForm({ ...form, brandFamilyId: e.target.value })}>
          <option value="">— Independent (no family) —</option>
          {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Country (optional)</label>
        <select className={inp} value={form.countryCode}
          onChange={(e) => setForm({ ...form, countryCode: e.target.value })}>
          <option value="">— Any —</option>
          <option value="IN">India</option>
          <option value="NZ">New Zealand</option>
          <option value="AU">Australia</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={form.isActive}
          onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
        Active
      </label>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50">
          {busy ? 'Saving…' : 'Save brand'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-semibold">Cancel</button>
      </div>
    </form>
  );
}

export default function BrandsPanel() {
  const [families, setFamilies] = useState([]);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedFamilyId, setSelectedFamilyId] = useState(null);
  const [editingFamily, setEditingFamily] = useState(null);    // {} = new, {id…} = edit
  const [editingBrand, setEditingBrand] = useState(null);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedMessage, setSeedMessage] = useState('');
  const [country, setCountry] = useState('');
  const [countryFilter, setCountryFilter] = useState('business');
  const [bulkOpen, setBulkOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [famRes, brRes, ctxRes] = await Promise.all([
        api('/api/ecom/brand-families'),
        api('/api/ecom/brands'),
        api('/api/business/me').catch(() => null),
      ]);
      setFamilies(famRes?.families || []);
      setBrands(brRes?.brands || []);
      setCountry((ctxRes?.business?.country || '').toUpperCase());
    } catch { /* swallow — empty UI handles it */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const activeCountryFilter = countryFilter === 'business' ? country : countryFilter;
  const inCountryScope = useCallback((row) => {
    if (activeCountryFilter === 'all') return true;
    if (activeCountryFilter === 'global') return !row.countryCode;
    if (!activeCountryFilter) return true;
    return !row.countryCode || row.countryCode === activeCountryFilter;
  }, [activeCountryFilter]);

  const visibleFamilies = useMemo(() => families.filter(inCountryScope), [families, inCountryScope]);
  const visibleBrands = useMemo(() => brands.filter(inCountryScope), [brands, inCountryScope]);

  // Auto-select first family once loaded so the right pane has content.
  useEffect(() => {
    if (!selectedFamilyId && visibleFamilies.length) setSelectedFamilyId(visibleFamilies[0].id);
    if (selectedFamilyId && selectedFamilyId !== '__independent__' && !visibleFamilies.find((f) => f.id === selectedFamilyId)) {
      setSelectedFamilyId(visibleFamilies[0]?.id || null);
    }
  }, [visibleFamilies, selectedFamilyId]);

  const brandsForFamily = useMemo(() => {
    if (!selectedFamilyId) return [];
    return visibleBrands.filter((b) => b.brandFamilyId === selectedFamilyId);
  }, [visibleBrands, selectedFamilyId]);
  const independentBrands = useMemo(() => visibleBrands.filter((b) => !b.brandFamilyId), [visibleBrands]);

  async function handleSeed() {
    setSeedBusy(true); setSeedMessage('');
    try {
      const r = await api('/api/ecom/brands/seed-country', {
        method: 'POST', body: JSON.stringify({ country: country || undefined }),
      });
      setSeedMessage(`Added ${r.familiesAdded} families + ${r.brandsAdded} brands (${r.country})`);
      refresh();
    } catch (err) {
      setSeedMessage(err.message || 'Seed failed');
    } finally { setSeedBusy(false); }
  }

  async function deleteFamily(id) {
    if (!confirm('Hide this family? Existing brands in it stay (orphaned), but the family disappears from pickers.')) return;
    try { await api(`/api/ecom/brand-families/${id}`, { method: 'DELETE' }); refresh(); }
    catch (err) { alert(err.message || 'Could not delete'); }
  }
  async function deleteBrand(id) {
    if (!confirm('Hide this brand? Products keep their brandId snapshot, but the brand disappears from pickers.')) return;
    try { await api(`/api/ecom/brands/${id}`, { method: 'DELETE' }); refresh(); }
    catch (err) { alert(err.message || 'Could not delete'); }
  }

  if (editingFamily) {
    return <FamilyForm initial={editingFamily.id ? editingFamily : null}
      onSave={() => { setEditingFamily(null); refresh(); }}
      onCancel={() => setEditingFamily(null)} />;
  }
  if (editingBrand) {
    return <BrandForm initial={editingBrand.id ? editingBrand : null}
      families={visibleFamilies}
      defaultFamilyId={selectedFamilyId}
      onSave={() => { setEditingBrand(null); refresh(); }}
      onCancel={() => setEditingBrand(null)} />;
  }

  const showSeedCta = !loading && families.length === 0 && SUPPORTED_COUNTRIES.includes(country);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">Brands</h2>
          <p className="text-xs text-gray-500 mt-0.5">Two-level catalog: company (family) → brand. Drives the product picker + brand-level analytics.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setBulkOpen(true)}
            className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50">
            ⇪ Bulk import
          </button>
          <button onClick={() => setEditingFamily({})}
            className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50">
            + Family
          </button>
          <button onClick={() => setEditingBrand({})}
            className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">
            + Brand
          </button>
        </div>
      </div>

      {bulkOpen && (
        <BulkImportModal
          type="brands"
          onClose={() => setBulkOpen(false)}
          onSuccess={refresh}
        />
      )}

      {showSeedCta && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <p className="text-sm font-semibold text-indigo-900">Pre-populate brands for {country}</p>
          <p className="text-xs text-indigo-700 mt-1">
            We have a curated catalog of popular FMCG families + brands for your country. One click and you'll be ready to tag products.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={handleSeed} disabled={seedBusy}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50">
              {seedBusy ? 'Loading…' : `Pre-populate ${country} brands`}
            </button>
            {seedMessage && <p className="text-xs text-indigo-700">{seedMessage}</p>}
          </div>
        </div>
      )}

      {!showSeedCta && SUPPORTED_COUNTRIES.includes(country) && families.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs text-gray-600">
            Need more {country} brands? You can re-run the catalog seed (existing rows are skipped).
          </p>
          <button onClick={handleSeed} disabled={seedBusy}
            className="px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50">
            {seedBusy ? 'Loading…' : `Re-run ${country} seed`}
          </button>
          {seedMessage && <p className="text-xs text-gray-700 w-full">{seedMessage}</p>}
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Brand country scope</p>
          <p className="text-xs text-gray-500 mt-0.5">Product pickers show the business country plus global brands. Catalogue and inventory remain central.</p>
        </div>
        <select
          value={countryFilter}
          onChange={(e) => setCountryFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm font-semibold text-gray-800 focus:outline-none focus:border-indigo-500"
        >
          <option value="business">Business country{country ? ` (${country})` : ''}</option>
          <option value="all">All countries</option>
          <option value="global">Global only</option>
          {SUPPORTED_COUNTRIES.map((code) => (
            <option key={code} value={code}>{code}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
      ) : families.length === 0 && brands.length === 0 ? (
        <div className="p-8 text-center bg-gray-50 rounded-xl border border-gray-200">
          <p className="text-3xl">🏷️</p>
          <p className="mt-2 text-sm font-semibold text-gray-700">No brands yet</p>
          <p className="text-xs text-gray-500 mt-1">Add a family + brand by hand or pre-populate from your country.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-3">
          {/* Left — families */}
          <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-100 bg-gray-50">
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Families ({visibleFamilies.length})</p>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {visibleFamilies.map((f) => (
                <FamilyRow key={f.id} family={f}
                  active={selectedFamilyId === f.id}
                  onSelect={() => setSelectedFamilyId(f.id)}
                  onEdit={() => setEditingFamily(f)} />
              ))}
              {independentBrands.length > 0 && (
                <button type="button" onClick={() => setSelectedFamilyId('__independent__')}
                  className={`w-full text-left px-4 py-3 border-l-4 transition-colors ${selectedFamilyId === '__independent__' ? 'border-indigo-500 bg-indigo-50' : 'border-transparent hover:bg-gray-50'}`}>
                  <p className="text-sm font-bold text-gray-900">Independent</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">{independentBrands.length} brand{independentBrands.length === 1 ? '' : 's'} with no family</p>
                </button>
              )}
            </div>
          </div>

          {/* Right — brands of selected family */}
          <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                {selectedFamilyId === '__independent__'
                  ? `Independent brands (${independentBrands.length})`
                  : (() => {
                    const f = visibleFamilies.find((x) => x.id === selectedFamilyId);
                    return f ? `${f.name} brands (${brandsForFamily.length})` : 'Select a family';
                  })()}
              </p>
              {selectedFamilyId && selectedFamilyId !== '__independent__' && (
                <button onClick={() => deleteFamily(selectedFamilyId)} className="text-[11px] font-semibold text-red-600 hover:underline">
                  Hide family
                </button>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {(selectedFamilyId === '__independent__' ? independentBrands : brandsForFamily).length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-gray-400">No brands in this family yet.</p>
              ) : (
                (selectedFamilyId === '__independent__' ? independentBrands : brandsForFamily).map((br) => (
                  <div key={br.id} className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 ${br.isActive ? '' : 'opacity-60'}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {br.name}
                        {!br.isActive && <span className="ml-2 text-[10px] font-bold uppercase text-gray-400">Hidden</span>}
                      </p>
                      <p className="text-[11px] text-gray-500">{br._count?.products ?? 0} product{br._count?.products === 1 ? '' : 's'}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => setEditingBrand(br)} className="text-[11px] font-semibold text-indigo-600 hover:underline">Edit</button>
                      <button onClick={() => deleteBrand(br.id)} className="text-[11px] font-semibold text-red-600 hover:underline">Hide</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

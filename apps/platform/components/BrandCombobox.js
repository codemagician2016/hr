'use client';

// Searchable brand picker with inline-create. Shows "Brand · Family" so
// the seller distinguishes Pepsi (PepsiCo) from Pepsi (Asahi). When the
// search query has no exact match, a "+ Create [query]" footer button
// pops up — clicking it opens a 1-step modal to optionally pick the
// family, then POSTs the new brand and selects it.
//
// Used from the product add/edit modal. Drives Product.brandId.

import { useEffect, useMemo, useRef, useState } from 'react';

const GREEN = '#16A34A';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${res.status} ${res.statusText}`);
  return body;
}

export default function BrandCombobox({ value, onChange, placeholder = 'Search brand…', autoFocus = false }) {
  const [families, setFamilies] = useState([]);
  const [brands, setBrands] = useState([]);
  const [country, setCountry] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(null); // null or { name, brandFamilyId }
  const containerRef = useRef(null);

  // Load both lists in parallel; cheap, single-tenant catalogs.
  async function refresh() {
    try {
      const ctx = await api('/api/business/me').catch(() => null);
      const countryCode = (ctx?.business?.country || '').toUpperCase();
      const scope = countryCode ? `?country=${encodeURIComponent(countryCode)}&includeGlobal=true` : '';
      const [famRes, brRes] = await Promise.all([
        api(`/api/ecom/brand-families${scope}`),
        api(`/api/ecom/brands${scope}`),
      ]);
      setCountry(countryCode);
      setFamilies(famRes?.families || []);
      setBrands(brRes?.brands || []);
    } catch { /* swallow — empty UI handles it */ }
    finally { setLoaded(true); }
  }
  useEffect(() => { refresh(); }, []);

  // Close popover on outside click.
  useEffect(() => {
    function onDocClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const selected = useMemo(() => brands.find((b) => b.id === value) || null, [brands, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return brands.slice(0, 50);
    const results = brands.filter((b) => {
      const fam = b.brandFamily?.name || '';
      return b.name.toLowerCase().includes(q) || fam.toLowerCase().includes(q);
    });
    // Sort exact-name-prefix first, then contains.
    results.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp;
    });
    return results.slice(0, 50);
  }, [brands, query]);

  const exactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? brands.some((b) => b.name.toLowerCase() === q) : false;
  }, [brands, query]);

  function selectBrand(b) {
    onChange(b?.id || null);
    setQuery('');
    setOpen(false);
  }

  async function handleCreate(name, brandFamilyId) {
    try {
      const r = await api('/api/ecom/brands', {
        method: 'POST',
        body: JSON.stringify({ name, brandFamilyId: brandFamilyId || null, countryCode: country || null }),
      });
      // Refresh + select the new brand. Preserves any other unsaved
      // form fields because we never closed the parent modal.
      await refresh();
      onChange(r.brand.id);
      setCreating(null);
      setQuery('');
      setOpen(false);
    } catch (err) {
      alert(err.message || 'Could not create brand');
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger / search input */}
      {!selected ? (
        <input type="text" autoFocus={autoFocus}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-green-400" />
      ) : (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-gray-200 bg-white">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{selected.name}</p>
            {selected.brandFamily && (
              <p className="text-[11px] text-gray-500 truncate">{selected.brandFamily.name}</p>
            )}
            {!selected.brandFamily && selected.countryCode && (
              <p className="text-[11px] text-gray-500 truncate">{selected.countryCode}</p>
            )}
          </div>
          <button type="button" onClick={() => onChange(null)}
            className="text-xs font-semibold text-gray-500 hover:text-red-600 shrink-0">
            Clear
          </button>
        </div>
      )}

      {/* Dropdown */}
      {!selected && open && (
        <div className="absolute z-20 left-0 right-0 mt-1 max-h-72 overflow-y-auto border border-gray-200 rounded-xl bg-white shadow-lg">
          {!loaded ? (
            <p className="px-4 py-3 text-xs text-gray-400">Loading brands…</p>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-3 text-xs text-gray-400">No matches.</p>
          ) : (
            filtered.map((b) => (
              <button key={b.id} type="button" onClick={() => selectBrand(b)}
                className="w-full text-left px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 last:border-0">
                <p className="text-sm font-semibold text-gray-900">{b.name}</p>
                {b.brandFamily && (
                  <p className="text-[11px] text-gray-500">{b.brandFamily.name}</p>
                )}
                {!b.brandFamily && b.countryCode && (
                  <p className="text-[11px] text-gray-500">{b.countryCode}</p>
                )}
              </button>
            ))
          )}
          {query.trim() && !exactMatch && (
            <button type="button" onClick={() => setCreating({ name: query.trim(), brandFamilyId: '' })}
              className="w-full text-left px-4 py-2.5 border-t border-gray-200 bg-gray-50 hover:bg-gray-100">
              <p className="text-sm font-semibold" style={{ color: GREEN }}>+ Create &quot;{query.trim()}&quot;</p>
              <p className="text-[11px] text-gray-500">Add this as a {country || 'business'} brand</p>
            </button>
          )}
        </div>
      )}

      {/* Inline-create modal. Single screen — name pre-filled, family
          dropdown optional. Saves + auto-selects in one click. */}
      {creating && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setCreating(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-black text-gray-900 text-base mb-4">Create brand</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">Brand name</label>
                <input type="text" value={creating.name} autoFocus
                  onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-green-400" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">Family (optional)</label>
                <select value={creating.brandFamilyId}
                  onChange={(e) => setCreating({ ...creating, brandFamilyId: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-green-400">
                  <option value="">— Independent (no family) —</option>
                  {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <p className="text-[11px] text-gray-400 mt-1">Pick the company that owns this brand, or leave blank.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button type="button" onClick={() => setCreating(null)}
                className="flex-1 py-2.5 rounded-lg border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
              <button type="button" onClick={() => handleCreate(creating.name, creating.brandFamilyId)}
                disabled={!creating.name.trim()}
                className="flex-1 py-2.5 rounded-lg text-white text-sm font-semibold disabled:opacity-50"
                style={{ background: GREEN }}>
                Create &amp; select
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

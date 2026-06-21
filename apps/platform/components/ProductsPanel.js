'use client';

// E-commerce product CRUD admin UI. Mounted at /<slug>/admin?tab=products
// when Business.vertical === 'ECOMMERCE'.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTenant } from '@/components/TenantProvider';
import { slugify } from '@/lib/slugify';
import { useConfirm } from '@/components/ConfirmDialog';
import BrandCombobox from '@/components/BrandCombobox';
import { DEFAULT_CURRENCY, getDefaultCurrency } from '@/lib/currency';
import AiGenerateButton from '@/components/AiGenerateButton';
import { useAiStatus } from '@/lib/useAiStatus';
import ImageDropZone from '@/components/ImageDropZone';
import BulkImportModal from '@/components/admin-tabs/BulkImportModal';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';

// Category hierarchy helpers — same shape used by CategoriesPanel.
// Build an indented option list ordered top-down by full breadcrumb
// path so the seller can distinguish "Produce › Fresh › Apples" from
// "Snacks › Fresh › Apples" if they happen to share a leaf name.
function categoryOptionsByPath(cats) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  function depthOf(id) {
    let d = 1; let cur = byId.get(id);
    while (cur?.parentId && d < 32) { d += 1; cur = byId.get(cur.parentId); }
    return d;
  }
  function pathOf(id) {
    const out = []; let cur = byId.get(id); let g = 0;
    while (cur && g < 32) { out.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null; g += 1; }
    return out.join(' › ');
  }
  return cats
    .map((c) => ({ id: c.id, name: c.name, depth: depthOf(c.id), path: pathOf(c.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.errors = body.errors || [];
    throw err;
  }
  return body;
}

function formatPrice(minor, currency) {
  if (minor === undefined || minor === null) return '';
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency || DEFAULT_CURRENCY,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${currency || ''} ${minor / 100}`;
  }
}

function productStockStatus(product) {
  if (typeof product.inventoryStockRows === 'number') {
    if (product.inventoryStockRows === 0) {
      return { text: 'Inventory not set', className: 'text-amber-600' };
    }
    const available = Number(product.inventoryAvailable || 0);
    const reserved = Number(product.inventoryReserved || 0);
    if (available <= 0) return { text: 'Out of stock', className: 'text-red-600' };
    return {
      text: reserved > 0 ? `${available} available (${reserved} reserved)` : `${available} available`,
      className: available < 5 ? 'text-amber-600' : '',
    };
  }
  if (product.stockQty != null) {
    return {
      text: product.stockQty === 0 ? 'Out of stock' : `${product.stockQty} in stock`,
      className: product.stockQty === 0 ? 'text-red-600' : product.stockQty < 5 ? 'text-amber-600' : '',
    };
  }
  return null;
}

// Tiny hover/focus tooltip for explaining a tricky field. Pure CSS —
// no portal, no library. Click-toggleable on touch devices via the
// `tabIndex` + focus rule.
function FieldHint({ text }) {
  return (
    <span className="relative inline-block group" tabIndex={0}>
      <span
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-gray-200 text-gray-600 text-[10px] font-bold cursor-help"
        aria-label="What's this?"
      >?</span>
      <span
        role="tooltip"
        className="invisible group-hover:visible group-focus:visible group-focus-within:visible absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-20 w-60 rounded-lg bg-gray-900 text-white text-[11px] leading-snug px-3 py-2 shadow-lg pointer-events-none"
      >
        {text}
      </span>
    </span>
  );
}

function ProductLocationOverridesSection({ product, defaultCurrency = DEFAULT_CURRENCY }) {
  const [locations, setLocations] = useState([]);
  const [overrides, setOverrides] = useState(new Map());
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');

  const currency = product?.currency || defaultCurrency;

  const load = useCallback(async () => {
    if (!product?.id) return;
    setLoading(true);
    setError('');
    try {
      const [locData, overrideData] = await Promise.all([
        api('/api/locations'),
        api(`/api/ecom/products/${product.id}/location-overrides`),
      ]);
      const locs = locData.locations || [];
      const rows = overrideData.overrides || [];
      const byLocation = new Map(rows.map((row) => [row.locationId, row]));
      const nextDrafts = {};
      for (const loc of locs) {
        const row = byLocation.get(loc.id);
        nextDrafts[loc.id] = {
          isAvailable: row?.isAvailable !== false,
          priceMajor: row?.priceMinor == null ? '' : String(row.priceMinor / 100),
          comparePriceMajor: row?.comparePriceMinor == null ? '' : String(row.comparePriceMinor / 100),
        };
      }
      setLocations(locs);
      setOverrides(byLocation);
      setDrafts(nextDrafts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [product?.id]);

  useEffect(() => { load(); }, [load]);

  function setDraft(locationId, key, value) {
    setDrafts((prev) => ({
      ...prev,
      [locationId]: { ...(prev[locationId] || {}), [key]: value },
    }));
  }

  function minorFromMajor(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.round(n * 100);
  }

  async function save(locationId) {
    const draft = drafts[locationId] || {};
    const priceMinor = minorFromMajor(draft.priceMajor);
    const comparePriceMinor = minorFromMajor(draft.comparePriceMajor);
    if (priceMinor === undefined || comparePriceMinor === undefined) {
      setError('Prices must be non-negative numbers.');
      return;
    }
    const effectivePrice = priceMinor ?? product.priceMinor;
    if (comparePriceMinor !== null && comparePriceMinor <= effectivePrice) {
      setError('Compare price must be higher than the selling price.');
      return;
    }
    setSavingId(locationId);
    setError('');
    try {
      await api(`/api/ecom/products/${product.id}/location-overrides/${locationId}`, {
        method: 'PUT',
        body: JSON.stringify({
          isAvailable: draft.isAvailable !== false,
          priceMinor,
          comparePriceMinor,
        }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId('');
    }
  }

  async function reset(locationId) {
    setSavingId(locationId);
    setError('');
    try {
      await api(`/api/ecom/products/${product.id}/location-overrides/${locationId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId('');
    }
  }

  if (!product?.id) return null;

  return (
    <section className="mt-6 border-t border-gray-200 pt-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Store availability & pricing</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Base price: {formatPrice(product.priceMinor, currency)}. Blank store price means inherit base price.
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading}
          className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          Refresh
        </button>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{error}</div>}

      {loading ? (
        <div className="py-6 text-center text-sm text-gray-500">Loading store settings…</div>
      ) : locations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-5 text-center text-sm text-gray-500">
          Add locations first to manage per-store catalogue settings.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200">
          <div className="grid grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_auto] gap-2 px-3 py-2 bg-gray-50 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <span>Store</span>
            <span>Availability</span>
            <span>Price</span>
            <span>Compare</span>
            <span className="text-right">Actions</span>
          </div>
          <div className="divide-y divide-gray-100 bg-white">
            {locations.map((loc) => {
              const draft = drafts[loc.id] || {};
              const existing = overrides.get(loc.id);
              const disabled = savingId === loc.id;
              return (
                <div key={loc.id} className="grid grid-cols-1 sm:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_auto] gap-2 px-3 py-3 items-center">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{loc.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {[loc.city, loc.state].filter(Boolean).join(', ') || (loc.isActive ? 'Active location' : 'Hidden location')}
                      {existing ? ' · custom' : ' · inherits base'}
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={draft.isAvailable !== false}
                      onChange={(e) => setDraft(loc.id, 'isAvailable', e.target.checked)}
                      className="w-4 h-4 rounded text-indigo-600" />
                    Sold here
                  </label>
                  <input type="number" min="0" step="0.01" placeholder={String(product.priceMinor / 100)}
                    value={draft.priceMajor || ''}
                    onChange={(e) => setDraft(loc.id, 'priceMajor', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                  <input type="number" min="0" step="0.01" placeholder={product.comparePriceMinor ? String(product.comparePriceMinor / 100) : 'Optional'}
                    value={draft.comparePriceMajor || ''}
                    onChange={(e) => setDraft(loc.id, 'comparePriceMajor', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => save(loc.id)} disabled={disabled}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50">
                      {disabled ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" onClick={() => reset(loc.id)} disabled={disabled || !existing}
                      className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                      Reset
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function CopyCatalogModal({ onClose }) {
  const [locations, setLocations] = useState([]);
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const data = await api('/api/locations');
        const locs = data.locations || [];
        if (cancelled) return;
        setLocations(locs);
        setFromLocationId(locs[0]?.id || '');
        setToLocationId(locs[1]?.id || '');
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setResult(null);
    setError('');
    if (!fromLocationId || !toLocationId || fromLocationId === toLocationId) {
      setError('Choose two different stores.');
      return;
    }
    setSaving(true);
    try {
      const data = await api('/api/ecom/products/copy-catalog', {
        method: 'POST',
        body: JSON.stringify({ fromLocationId, toLocationId, overwrite }),
      });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Copy store catalogue</h3>
            <p className="text-sm text-gray-500 mt-0.5">Duplicate product availability and price overrides from one store to another.</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-4">
          {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{error}</div>}
          {result && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">
              Copied {result.created + result.updated} override{result.created + result.updated === 1 ? '' : 's'}.
              {' '}Created {result.created}, updated {result.updated}, skipped {result.skipped}.
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center text-sm text-gray-500">Loading stores…</div>
          ) : locations.length < 2 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-5 text-center text-sm text-gray-500">
              Add at least two locations before copying catalogue settings.
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Copy from</label>
                <select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                  {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Copy to</label>
                <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                  {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                </select>
              </div>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded text-indigo-600" />
                <span>Overwrite existing overrides in the destination store</span>
              </label>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50">
              Close
            </button>
            <button type="submit" disabled={saving || loading || locations.length < 2}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Copying…' : 'Copy catalogue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProductForm({ initial, categories, onSave, onCancel, busy, defaultCurrency = DEFAULT_CURRENCY }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [slug, setSlug] = useState(initial?.slug || '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [brand, setBrand] = useState(initial?.brand || '');
  // Structured brandId — drives the combobox + brand-level analytics.
  // The free-text `brand` above is kept as the shelf-label snapshot;
  // backend overwrites it with the picked brand's name on save.
  const [brandId, setBrandId] = useState(initial?.brandId || initial?.productBrand?.id || '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId || '');
  const [shortDescription, setShortDescription] = useState(initial?.shortDescription || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [sku, setSku] = useState(initial?.sku || '');
  const [barcode, setBarcode] = useState(initial?.barcode || '');
  const [qrCode, setQrCode] = useState(initial?.qrCode || '');
  const [priceMajor, setPriceMajor] = useState(initial ? (initial.priceMinor / 100).toString() : '');
  const [comparePriceMajor, setComparePriceMajor] = useState(initial?.comparePriceMinor ? (initial.comparePriceMinor / 100).toString() : '');
  // Product pricing follows the shop currency so admin, checkout, and
  // customer-facing catalog amounts stay aligned.
  const [currency, setCurrency] = useState(defaultCurrency || initial?.currency || DEFAULT_CURRENCY);
  const [weightDisplay, setWeightDisplay] = useState(initial?.weightDisplay || '');
  const [imageUrls, setImageUrls] = useState(initial?.imageUrls || []);
  const [isPublished, setIsPublished] = useState(initial?.isPublished || false);
  const [isFeatured, setIsFeatured] = useState(initial?.isFeatured || false);
  const [discountDisplayMode, setDiscountDisplayMode] = useState(initial?.discountDisplayMode || 'PERCENTAGE');
  const [error, setError] = useState('');
  const { available: aiAvailable } = useAiStatus();

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    const priceN = Number(priceMajor);
    if (!Number.isFinite(priceN) || priceN < 0) { setError('Price must be a non-negative number'); return; }
    const compareN = comparePriceMajor === '' ? null : Number(comparePriceMajor);
    if (compareN !== null && !Number.isFinite(compareN)) { setError('Compare price must be numeric'); return; }
    if (compareN !== null && compareN <= priceN) { setError('Compare price must be higher than current price'); return; }
    try {
      await onSave({
        name,
        slug: slug || slugify(name),
        brand: brand.trim() || null,
        brandId: brandId || null,
        categoryId: categoryId || null,
        shortDescription: shortDescription || null,
        description: description || null,
        sku: sku || null,
        barcode: barcode || null,
        qrCode: qrCode || null,
        priceMinor: Math.round(priceN * 100),
        comparePriceMinor: compareN === null ? null : Math.round(compareN * 100),
        currency: currency.toUpperCase(),
        weightDisplay: weightDisplay || null,
        imageUrls,
        isPublished,
        isFeatured,
        discountDisplayMode,
      });
    } catch (err) {
      setError(err.errors?.length ? `${err.message}: ${err.errors.join(' · ')}` : err.message);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {!initial && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
          <p className="font-semibold">💡 Quick tip</p>
          <p className="mt-0.5 text-xs leading-relaxed">
            Most owners only fill <strong>Name</strong> + <strong>Price</strong> + <strong>1 image URL</strong> for their first product — everything else is optional. You can always edit later.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Wholewheat Bread"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">URL slug *</label>
          <input
            type="text" value={slug}
            onChange={(e) => { setSlug(slugify(e.target.value)); setSlugTouched(true); }}
            placeholder="auto"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Price (in {currency}) *</label>
          <input
            type="number" step="0.01" min="0" value={priceMajor}
            onChange={(e) => setPriceMajor(e.target.value)}
            placeholder="0"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
            Compare price (was)
            <FieldHint text="Shows a strikethrough 'was $X' on the storefront — useful for showing a discount. Leave blank if not on sale." />
          </label>
          <input
            type="number" step="0.01" min="0" value={comparePriceMajor}
            onChange={(e) => setComparePriceMajor(e.target.value)}
            placeholder="for sales"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Currency</label>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            {['INR', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'SGD'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
            Category
            <FieldHint text="Pick any level — top, sub, or sub-sub. The dropdown shows the full path so you can disambiguate sibling names. To move this product to a different category later, just change this field and save." />
          </label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white font-mono">
            <option value="">— Uncategorised —</option>
            {categoryOptionsByPath(categories).map((opt) => (
              <option key={opt.id} value={opt.id}>
                {'  '.repeat(Math.max(0, opt.depth - 1))}{opt.path}
              </option>
            ))}
          </select>
        </div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <p className="font-semibold">Stock is managed in Inventory</p>
          <p className="mt-1 leading-relaxed">Add opening stock, GRNs, transfers, and count corrections from the Inventory tab so every change has an audit trail.</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">SKU</label>
          <input
            type="text" value={sku} onChange={(e) => setSku(e.target.value)}
            placeholder="optional"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Scan codes</p>
            <p className="mt-1 text-xs text-gray-500">
              Optional placeholders for barcode and QR workflows. These values are saved now and can be used by scanners later.
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Barcode / GTIN</label>
            <input
              type="text"
              value={barcode}
              maxLength={180}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="e.g. 8901234567890"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">QR code payload</label>
            <input
              type="text"
              value={qrCode}
              maxLength={2048}
              onChange={(e) => setQrCode(e.target.value)}
              placeholder="URL or text encoded in QR"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
          Brand
          <FieldHint text="Pick a brand from the catalog or type to search; create a new one inline if it's not listed. Drives brand + family sales analytics. The shelf label below the dropdown is auto-filled from the picked brand's name." />
        </label>
        <BrandCombobox
          value={brandId}
          onChange={(id) => setBrandId(id || '')}
          placeholder="Search brand or family…" />
        {/* Shelf-label fallback — typically auto-filled from the picked
            brand by the backend, but admins can override if their shelf
            naming differs from the brand row name. */}
        <input
          type="text" value={brand} maxLength={120}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="Optional shelf label override (auto-filled from brand)"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 mt-2"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Short description (1-2 lines)</label>
        <input
          type="text" value={shortDescription} maxLength={500}
          onChange={(e) => setShortDescription(e.target.value)}
          placeholder="Shown on the product grid card"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <label className="block text-xs font-medium text-gray-700">Full description</label>
          <AiGenerateButton
            available={aiAvailable}
            type="product_description"
            label="Generate with AI"
            disabledReason={name.trim() ? '' : 'Enter a product name first'}
            getInput={() => ({
              name: name.trim(),
              category: categories?.find((c) => c.id === categoryId)?.name || undefined,
              features: shortDescription.trim() ? [shortDescription.trim()] : [],
              tone: 'friendly',
            })}
            onResult={(r) => {
              if (r?.description) setDescription(r.description);
              if (r?.shortDescription && !shortDescription.trim()) setShortDescription(r.shortDescription);
            }}
          />
        </div>
        <textarea
          value={description} onChange={(e) => setDescription(e.target.value)}
          rows={4} maxLength={10000}
          placeholder="Detailed description shown on the product page"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Product images (max 20)</label>
        <ImageDropZone values={imageUrls} onChange={setImageUrls} max={20} scope="product" />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
          Weight / size display
          <FieldHint text="Free-text label shown on the product card. Examples: '500 g pack', '1 L bottle', '6-piece set'. Helps customers know what they're getting before clicking." />
        </label>
        <input
          type="text" value={weightDisplay} maxLength={80}
          onChange={(e) => setWeightDisplay(e.target.value)}
          placeholder="e.g. 500 g pack, 1 L bottle"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
            Discount badge style
            <FieldHint text="How the discount is shown on the product card. '24% OFF' = percentage; '₹23 OFF' = flat amount saved." />
          </label>
          <select
            value={discountDisplayMode}
            onChange={(e) => setDiscountDisplayMode(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
          >
            <option value="PERCENTAGE">Percentage (24% OFF)</option>
            <option value="FLAT">Flat amount (₹23 OFF)</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 pt-3 border-t border-gray-100">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isPublished} onChange={(e) => setIsPublished(e.target.checked)} />
          <span className="text-sm text-gray-700">Published <span className="text-gray-400">(visible on storefront)</span></span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isFeatured} onChange={(e) => setIsFeatured(e.target.checked)} />
          <span className="text-sm text-gray-700 flex items-center gap-1.5">
            Featured <span className="text-gray-400">(promoted on homepage)</span>
            <FieldHint text="Featured products appear in the storefront's homepage strip with a 'Featured' badge. Best for sale items, new arrivals, or your most popular." />
          </span>
        </label>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{error}</div>}

      <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-700">Cancel</button>
        <button type="submit" disabled={busy || !name || !priceMajor} className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-700">
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create product'}
        </button>
      </div>
    </form>
  );
}

// Variant management section — shown in edit mode after product is created.
// Admins add size/weight options (500g, 1kg, etc.) each with their own price.
function VariantsSection({ productId, currency }) {
  const [variants, setVariants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newVariant, setNewVariant] = useState({ label: '', sku: '', priceMinor: '', comparePriceMinor: '', isDefault: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api(`/api/ecom/products/${productId}/variants`);
      setVariants(data.variants || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!newVariant.label || !newVariant.priceMinor) return;
    setAdding(true);
    setError('');
    try {
      const priceN = Math.round(parseFloat(newVariant.priceMinor) * 100);
      const compareN = newVariant.comparePriceMinor ? Math.round(parseFloat(newVariant.comparePriceMinor) * 100) : null;
      await api(`/api/ecom/products/${productId}/variants`, {
        method: 'POST',
        body: JSON.stringify({
          label: newVariant.label,
          sku: newVariant.sku || null,
          priceMinor: priceN,
          comparePriceMinor: compareN,
          stockQty: null,
          isDefault: newVariant.isDefault,
        }),
      });
      setNewVariant({ label: '', sku: '', priceMinor: '', comparePriceMinor: '', isDefault: false });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id) {
    try {
      await api(`/api/ecom/products/${productId}/variants/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSetDefault(id) {
    try {
      await api(`/api/ecom/products/${productId}/variants/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleClearDefault(id) {
    // Letting the admin un-set the default leaves the storefront falling
    // back to whatever variants[0] is by sortOrder — same behaviour as a
    // brand-new product with no chosen default.
    try {
      await api(`/api/ecom/products/${productId}/variants/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: false }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-6 pt-6 border-t border-gray-200">
      <h3 className="text-sm font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
        Size / weight variants
        <FieldHint text="Add variants when this product comes in multiple sizes or weights (e.g. 500g, 1kg). Each variant has its own price. Products with no variants show a single price. Products with 1+ variants show a dropdown picker on the storefront card." />
      </h3>
      <p className="text-xs text-gray-500 mb-3">Leave this empty for a single-price product. Add 2+ variants to enable the picker.</p>

      {loading ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : (
        <>
          {variants.length > 0 && (
            <div className="space-y-2 mb-4">
              {variants.map((v) => (
                <div key={v.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 bg-gray-50">
                  <span className="text-sm font-medium text-gray-800 w-24 shrink-0 truncate">{v.label}</span>
                  <span className="text-sm font-bold text-gray-900">{(v.priceMinor / 100).toFixed(2)} {currency}</span>
                  {v.comparePriceMinor && <span className="text-xs text-gray-400 line-through">{(v.comparePriceMinor / 100).toFixed(2)}</span>}
                  <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!v.isDefault}
                      onChange={(e) => (e.target.checked ? handleSetDefault(v.id) : handleClearDefault(v.id))}
                    />
                    Default
                  </label>
                  <button type="button" onClick={() => handleDelete(v.id)}
                    className="text-[11px] text-red-500 hover:text-red-700">Delete</button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleAdd} className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <input
              type="text" placeholder="Label (e.g. 500g) *" value={newVariant.label}
              onChange={(e) => setNewVariant((s) => ({ ...s, label: e.target.value }))}
              className="col-span-2 sm:col-span-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs"
            />
            <input
              type="number" step="0.01" min="0" placeholder={`Price (${currency}) *`} value={newVariant.priceMinor}
              onChange={(e) => setNewVariant((s) => ({ ...s, priceMinor: e.target.value }))}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs"
            />
            <input
              type="number" step="0.01" min="0" placeholder="Compare price" value={newVariant.comparePriceMinor}
              onChange={(e) => setNewVariant((s) => ({ ...s, comparePriceMinor: e.target.value }))}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs"
            />
            <input
              type="text" placeholder="SKU (optional)" value={newVariant.sku}
              onChange={(e) => setNewVariant((s) => ({ ...s, sku: e.target.value }))}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs font-mono"
            />
            <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" checked={newVariant.isDefault}
                onChange={(e) => setNewVariant((s) => ({ ...s, isDefault: e.target.checked }))} />
              Default
            </label>
            <button type="submit" disabled={adding || !newVariant.label || !newVariant.priceMinor}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-700">
              {adding ? 'Adding…' : '+ Add variant'}
            </button>
          </form>
        </>
      )}
      {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
    </div>
  );
}

export default function ProductsPanel() {
  const { tenant } = useTenant();
  const { active: activeLocation } = useEcommerceLocation();
  const defaultCurrency = getDefaultCurrency({ business: tenant?.business });
  const confirm = useConfirm();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [filter, setFilter] = useState({ q: '', categoryId: '', isPublished: '' });
  // Multi-select for the bulk-move action. Set of product ids — visible
  // when at least one is ticked; cleared after a successful move OR a
  // filter change (since the underlying list shifts).
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTargetCategoryId, setMoveTargetCategoryId] = useState('');

  // Sub-page state lives in the URL: ?view=create | edit, ?id=<productId>.
  // Refresh / back-button / deep-links all preserve context. Admin-shell
  // strips these when switching to a different tab.
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = searchParams.get('view') || '';
  const urlId = searchParams.get('id') || '';
  const urlSearch = searchParams.get('q') || '';

  useEffect(() => {
    setFilter((prev) => (prev.q === urlSearch ? prev : { ...prev, q: urlSearch }));
  }, [urlSearch]);

  const goList = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete('view'); p.delete('id');
    router.replace(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const goCreate = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.set('view', 'create'); p.delete('id');
    router.push(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const goEdit = useCallback((product) => {
    const p = new URLSearchParams(searchParams.toString());
    p.set('view', 'edit'); p.set('id', product.id);
    router.push(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const mode = view === 'create' ? { kind: 'create' }
    : view === 'edit' && urlId
      ? { kind: 'edit', product: products.find((p) => p.id === urlId) || null }
      : { kind: 'list' };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filter.q) params.set('q', filter.q);
      if (filter.categoryId) params.set('categoryId', filter.categoryId);
      if (filter.isPublished !== '') params.set('isPublished', filter.isPublished);
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      const categoryParams = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') categoryParams.set('locationId', activeLocation);
      const [p, c] = await Promise.all([
        api(`/api/ecom/products?${params}`),
        api(`/api/ecom/categories?${categoryParams}`),
      ]);
      setProducts(p.products || []);
      setTotal(p.total || 0);
      setCategories(c.categories || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter.q, filter.categoryId, filter.isPublished, activeLocation]);

  useEffect(() => { load(); }, [load]);

  // Self-heal stale sub-page state. admin-shell switches tabs with
  // window.history.replaceState (not the Next router), which strips ?view/?id
  // from the address bar but does NOT reliably update useSearchParams(). So a
  // panel remounted after a tab round-trip (Products → Fulfilment → Products)
  // can re-open a stale edit form even though the URL bar is clean. On mount,
  // trust the live address bar: if it has no view/id, push the router back to
  // the list so the two agree.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const live = new URLSearchParams(window.location.search);
    if (!live.get('view') && !live.get('id') && (view || urlId)) goList();
    // mount-only: we only want to correct stale state on (re)entry to the tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(payload) {
    setBusy(true);
    try {
      await api('/api/ecom/products', {
        method: 'POST',
        body: JSON.stringify({
          ...payload,
          locationId: activeLocation && activeLocation !== 'ALL' ? activeLocation : undefined,
        }),
      });
      await load();
      goList();
    } finally { setBusy(false); }
  }
  async function update(payload) {
    if (!mode.product) return;
    setBusy(true);
    try {
      await api(`/api/ecom/products/${mode.product.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...payload,
          locationId: activeLocation && activeLocation !== 'ALL' ? activeLocation : undefined,
        }),
      });
      await load();
      goList();
    } finally { setBusy(false); }
  }
  async function remove(p) {
    if (!await confirm(`Delete "${p.name}"?`, { confirmLabel: 'Delete', tone: 'danger' })) return;
    try {
      await api(`/api/ecom/products/${p.id}`, { method: 'DELETE' });
      await load();
    } catch (err) { alert(err.message); }
  }
  async function togglePublish(p) {
    try {
      await api(`/api/ecom/products/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isPublished: !p.isPublished }),
      });
      await load();
    } catch (err) { alert(err.message); }
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllVisible() {
    setSelectedIds(new Set(products.map((p) => p.id)));
  }
  function clearSelection() { setSelectedIds(new Set()); setMoveOpen(false); }

  async function bulkMove() {
    if (selectedIds.size === 0) return;
    setBusy(true);
    try {
      await api('/api/ecom/products/bulk-move', {
        method: 'POST',
        body: JSON.stringify({
          productIds: Array.from(selectedIds),
          categoryId: moveTargetCategoryId || null,
        }),
      });
      clearSelection();
      await load();
    } catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }

  // Clear selection whenever the filter changes — the list underneath is
  // about to shift and stale ids would be confusing.
  useEffect(() => { clearSelection(); }, [filter.q, filter.categoryId, filter.isPublished]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mode.kind === 'edit' && !mode.product) {
    if (loading) {
      // Show a thin loading row while a deep-link to ?view=edit&id=… resolves
      // its product from the list — avoids flicker back to the list.
      return <div className="py-10 text-center text-sm text-gray-500">Loading product…</div>;
    }
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6 max-w-3xl mx-auto">
        <button type="button" onClick={goList}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors">
          <span aria-hidden className="text-base leading-none">←</span> Back to products
        </button>
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          This product no longer exists or is not available for the selected location. Return to the products list to continue.
        </div>
      </div>
    );
  }

  if (mode.kind === 'create' || mode.kind === 'edit') {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6 max-w-3xl mx-auto">
        <button type="button" onClick={goList}
          className="inline-flex items-center gap-1.5 mb-4 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors">
          <span aria-hidden className="text-base leading-none">←</span> Back to products
        </button>
        <nav className="text-xs text-gray-500 mb-3 flex items-center gap-1">
          <button type="button" onClick={goList}
            className="text-indigo-600 hover:underline font-medium">Products</button>
          <span className="text-gray-300">/</span>
          <span className="text-gray-700">
            {mode.kind === 'edit' ? mode.product.name : 'New product'}
          </span>
        </nav>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          {mode.kind === 'edit' ? 'Edit product' : 'New product'}
        </h2>
        <p className="text-sm text-gray-500 mb-5">
          {mode.kind === 'edit' ? mode.product.name : 'Add a product to your shop. Save as draft (unpublished) until ready.'}
        </p>
        <ProductForm
          initial={mode.kind === 'edit' ? mode.product : null}
          categories={categories}
          defaultCurrency={defaultCurrency}
          onSave={mode.kind === 'edit' ? update : create}
          onCancel={goList}
          busy={busy}
        />
        {/* Variant management — only available after product is saved (edit mode) */}
        {mode.kind === 'edit' && mode.product?.id && (
          <VariantsSection productId={mode.product.id} currency={defaultCurrency} />
        )}
        {mode.kind === 'edit' && mode.product?.id && (
          <ProductLocationOverridesSection product={mode.product} defaultCurrency={defaultCurrency} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Products</h2>
          <p className="text-sm text-gray-500 mt-0.5">{total} of 5,000 used.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={async () => {
              if (!window.confirm('Remove the sample data loaded via "Load sample catalog" (its sample products, categories and brands)? Anything you created or edited yourself is kept.')) return;
              try {
                const res = await api('/api/ecom/catalog/remove-samples', { method: 'POST', body: JSON.stringify({}) });
                await load();
                const r = res?.removed || {};
                alert(`Removed ${r.products || 0} sample products, ${r.categories || 0} categories, ${r.brands || 0} brands.`);
              } catch (e) { alert(e.message || 'Could not remove samples'); }
            }}
            className="px-3 py-2 text-sm font-semibold rounded-lg bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
            title="Delete everything that was seeded by Load sample catalog. Your own items stay."
          >
            Remove samples
          </button>
          <button type="button" onClick={() => setCopyOpen(true)}
            className="px-3 py-2 text-sm font-semibold rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50">
            Copy store catalog
          </button>
          <button type="button" onClick={() => setBulkOpen(true)}
            className="px-3 py-2 text-sm font-semibold rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50">
            ⇪ Bulk import
          </button>
          <button type="button" onClick={() => goCreate()} className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
            + New product
          </button>
        </div>
      </div>

      {bulkOpen && (
        <BulkImportModal
          type="products"
          onClose={() => setBulkOpen(false)}
          onSuccess={() => load()}
        />
      )}
      {copyOpen && <CopyCatalogModal onClose={() => setCopyOpen(false)} />}

      <div className="bg-white rounded-2xl border border-gray-200 p-3 flex flex-wrap gap-2 items-center">
        <input
          type="text" placeholder="Search by name or SKU…"
          value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          className="flex-1 min-w-[180px] rounded-lg border border-gray-200 px-3 py-1.5 text-sm"
        />
        <select value={filter.categoryId} onChange={(e) => setFilter({ ...filter, categoryId: e.target.value })}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm bg-white font-mono max-w-xs truncate">
          <option value="">All categories</option>
          {categoryOptionsByPath(categories).map((opt) => (
            <option key={opt.id} value={opt.id}>
              {'  '.repeat(Math.max(0, opt.depth - 1))}{opt.path}
            </option>
          ))}
        </select>
        <select value={filter.isPublished} onChange={(e) => setFilter({ ...filter, isPublished: e.target.value })} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm bg-white">
          <option value="">All statuses</option>
          <option value="true">Published</option>
          <option value="false">Drafts</option>
        </select>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{error}</div>}

      {/* Bulk-move action bar — appears as a sticky strip when one or more
          products are ticked. Lets the seller move 50 products into a new
          category in a single API call (POST /api/ecom/products/bulk-move). */}
      {selectedIds.size > 0 && (
        <div className="sticky top-2 z-10 bg-indigo-600 text-white rounded-xl shadow-lg px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold">
            {selectedIds.size} selected
          </span>
          <button type="button" onClick={selectAllVisible}
            className="text-xs font-mono uppercase tracking-wider opacity-80 hover:opacity-100 underline">
            Select all visible ({products.length})
          </button>
          <span className="text-white/40">·</span>
          {!moveOpen ? (
            <button type="button" onClick={() => setMoveOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-white text-indigo-700 text-xs font-bold hover:bg-indigo-50">
              Move to category…
            </button>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <select value={moveTargetCategoryId}
                onChange={(e) => setMoveTargetCategoryId(e.target.value)}
                className="rounded-lg px-3 py-1.5 text-xs font-mono text-gray-900 max-w-xs">
                <option value="">— Uncategorise —</option>
                {categoryOptionsByPath(categories).map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {'  '.repeat(Math.max(0, opt.depth - 1))}{opt.path}
                  </option>
                ))}
              </select>
              <button type="button" onClick={bulkMove} disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-xs font-bold hover:bg-emerald-400 disabled:opacity-50">
                {busy ? 'Moving…' : `Move ${selectedIds.size}`}
              </button>
              <button type="button" onClick={() => setMoveOpen(false)}
                className="text-xs font-mono uppercase tracking-wider opacity-80 hover:opacity-100">
                Cancel
              </button>
            </div>
          )}
          <button type="button" onClick={clearSelection}
            className="ml-auto text-xs font-mono uppercase tracking-wider opacity-80 hover:opacity-100 underline">
            Clear
          </button>
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center text-sm text-gray-500">Loading products…</div>
      ) : products.length === 0 ? (
        <ProductsEmptyState
          isFiltered={!!(filter.q || filter.categoryId || filter.isPublished)}
          onAddFirst={() => goCreate()}
          onSamplesLoaded={async () => { await load(); }}
        />
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <ul className="divide-y divide-gray-100">
            {products.map((p) => {
              const isSelected = selectedIds.has(p.id);
              // Build the full breadcrumb path for the inline tag — saves
              // the seller from having to remember which "Apples" this is.
              const catPath = p.category ? (() => {
                const opt = categoryOptionsByPath(categories).find((o) => o.id === p.category.id);
                return opt?.path || p.category.name;
              })() : null;
              const stockStatus = productStockStatus(p);
              return (
                <li key={p.id}
                  className={`px-5 py-3 flex items-center gap-3 transition-colors ${
                    isSelected ? 'bg-indigo-50/60' : 'hover:bg-gray-50/60'
                  }`}>
                  <input type="checkbox" checked={isSelected}
                    onChange={() => toggleSelected(p.id)}
                    className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 shrink-0"
                    aria-label={`Select ${p.name}`} />
                  {p.imageUrls?.[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.imageUrls[0]} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-gray-400 shrink-0">📦</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                    <p className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                      <span>{formatPrice(p.priceMinor, defaultCurrency)}</span>
                      {p.comparePriceMinor && (
                        <span className="line-through text-gray-400 text-[11px]">{formatPrice(p.comparePriceMinor, defaultCurrency)}</span>
                      )}
                      {catPath && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span className="font-mono text-[11px]">{catPath}</span>
                        </>
                      )}
                      {stockStatus && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span className={stockStatus.className}>{stockStatus.text}</span>
                        </>
                      )}
                    </p>
                    {(p.sku || p.barcode || p.qrCode) && (
                      <p className="mt-1 text-[11px] text-gray-400 flex flex-wrap items-center gap-2">
                        {p.sku && <span className="font-mono">SKU {p.sku}</span>}
                        {p.barcode && <span className="font-mono">Barcode {p.barcode}</span>}
                        {p.qrCode && <span className="font-mono">QR saved</span>}
                      </p>
                    )}
                  </div>
                  {p.isFeatured && <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">★ Featured</span>}
                  <button onClick={() => togglePublish(p)} className={`text-[11px] font-medium px-2 py-0.5 rounded shrink-0 ${p.isPublished ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {p.isPublished ? '● Published' : '○ Draft'}
                  </button>
                  <button onClick={() => goEdit(p)} className="text-xs font-medium text-indigo-600 hover:underline shrink-0">Edit</button>
                  <button onClick={() => remove(p)} className="text-xs font-medium text-red-600 hover:underline shrink-0">Delete</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// First-run empty state. Shows three CTAs (Add first / Load samples /
// CSV soon) plus a small link to the help guide. After the first
// product exists this whole block disappears and admins see the normal
// list view.
function ProductsEmptyState({ isFiltered, onAddFirst, onSamplesLoaded }) {
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');

  if (isFiltered) {
    // Filter-empty state — different from "shop is empty". Don't pitch
    // the sample-loader; a tightly-filtered view returning zero matches
    // is normal when an admin is searching.
    return (
      <div className="rounded-2xl border-2 border-dashed border-gray-200 p-10 text-center">
        <p className="text-sm text-gray-500">No products match your filters.</p>
        <p className="text-xs text-gray-400 mt-1">Try clearing search + category to see all products.</p>
      </div>
    );
  }

  async function loadSamples() {
    setLoading(true);
    setError('');
    try {
      const res = await api('/api/ecom/catalog/load-starter', { method: 'POST', body: JSON.stringify({}) });
      if (res && res.ok === false) {
        setError('A ready-made sample catalog for your theme is coming soon — you can add products manually for now.');
        return;
      }
      await onSamplesLoaded();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setConfirm(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-8 sm:p-10">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-5xl">🛒</p>
        <h3 className="mt-4 text-xl font-semibold text-gray-900">
          Your shop is ready — let's add some products
        </h3>
        <p className="mt-2 text-sm text-gray-500">
          Most shops launch in under 30 minutes. Pick how you want to start:
        </p>
      </div>

      <div className="mt-7 grid grid-cols-1 md:grid-cols-3 gap-3 max-w-3xl mx-auto">
        {/* Card 1 — Add a product (primary path) */}
        <button
          type="button"
          onClick={onAddFirst}
          className="group rounded-xl border-2 border-indigo-500 bg-indigo-50 p-5 text-left hover:bg-indigo-100 transition-colors"
        >
          <div className="text-2xl">📝</div>
          <p className="mt-3 font-semibold text-gray-900 text-sm">Add my first product</p>
          <p className="mt-1 text-xs text-gray-600 leading-snug">
            Just name + price + 1 image is enough. Everything else is optional.
          </p>
          <p className="mt-3 text-xs font-semibold text-indigo-700 group-hover:text-indigo-800">
            Get started →
          </p>
        </button>

        {/* Card 2 — Load samples */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 hover:border-gray-300 transition-colors">
          <div className="text-2xl">✨</div>
          <p className="mt-3 font-semibold text-gray-900 text-sm">Load a sample catalog</p>
          <p className="mt-1 text-xs text-gray-600 leading-snug">
            A realistic starter set for your theme — categories, brands &amp; products. Edit, keep, or remove any of it.
          </p>
          {!confirm ? (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              disabled={loading}
              className="mt-3 text-xs font-semibold text-gray-900 hover:underline"
            >
              Load samples →
            </button>
          ) : (
            <div className="mt-3 space-y-1.5">
              <p className="text-[11px] text-amber-800 leading-snug">
                Adds sample categories, brands &amp; products tailored to your theme, priced in your currency. Remove them all in one click anytime (the “Remove samples” button).
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={loadSamples}
                  disabled={loading}
                  className="text-xs font-semibold px-3 py-1.5 rounded-md bg-gray-900 text-white hover:bg-black disabled:opacity-50"
                >
                  {loading ? 'Loading…' : 'Yes, load'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirm(false)}
                  disabled={loading}
                  className="text-xs text-gray-500 hover:text-gray-700 px-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Card 3 — CSV import via the real Bulk ops importer */}
        <a
          href="?tab=bulk"
          className="block text-left rounded-xl border border-gray-200 bg-white p-5 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors no-underline"
        >
          <div className="text-2xl">📤</div>
          <p className="mt-3 font-semibold text-gray-900 text-sm">Import from CSV</p>
          <p className="mt-1 text-xs text-gray-600 leading-snug">
            Open Bulk operations to upload products or location stock changes from a spreadsheet.
          </p>
          <p className="mt-3 text-xs font-semibold text-indigo-700">Open importer →</p>
        </a>
      </div>

      {error && (
        <p className="mt-4 text-center text-xs text-red-700">{error}</p>
      )}

      <div className="mt-6 text-center">
        <a
          href="?tab=bulk"
          className="text-xs text-gray-500 hover:text-gray-900 underline-offset-4 hover:underline"
        >
          Import products or stock from spreadsheet →
        </a>
      </div>
    </div>
  );
}

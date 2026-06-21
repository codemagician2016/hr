'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — CmsPanel
// Polish pass 2026-05-08: visual block-type picker + structured forms
// per block type (no more raw JSON for the common cases) + KPI strip.
// Backend: /api/ecom/cms-blocks (Phase 3d).

import { useState, useEffect, useCallback, useMemo } from 'react';
import ImageDropZone from '@/components/ImageDropZone';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
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

// Block-type taxonomy with icon + short description for the visual picker
// + a `fields` schema describing what the structured form should expose.
// `arrays` blocks fall back to JSON because they're rarer + more complex.
// Heroes live in the Banners tab (image carousel + scheduling + click
// analytics), so HERO is intentionally NOT offered here — that kept two
// systems doing the same job. The storefront renderer still draws any legacy
// HERO blocks so nothing breaks.
const BLOCK_TYPES = [
  {
    key: 'FEATURED_COLLECTION', label: 'Featured collection', icon: '⭐',
    desc: 'Curated product carousel — pick which products to feature',
    fields: ['title', 'productIds'],
  },
  {
    key: 'BESTSELLERS_AUTO', label: 'Best-sellers (auto)', icon: '📈',
    desc: 'Auto-pulled best-sellers — set the count, we pick the products',
    fields: ['title', 'count'],
  },
  {
    key: 'EDITORIAL_RICHTEXT', label: 'Editorial / rich text', icon: '📝',
    desc: 'Article-style copy with optional image — for stories, guides',
    fields: ['title', 'body', 'imageUrl'],
  },
  {
    key: 'RECIPE_LINKED', label: 'Recipe with linked products', icon: '🍳',
    desc: 'Recipe card linking to ingredients customers can buy',
    fields: ['title', 'body', 'imageUrl', 'productIds'],
  },
  {
    key: 'CATEGORY_GRID', label: 'Category grid', icon: '🗂',
    desc: 'Grid of category tiles for storefront navigation',
    fields: ['title', 'categoryIds'],
  },
  {
    key: 'COUPON_CALLOUT', label: 'Coupon callout', icon: '🎟',
    desc: 'Promo code highlight — drives redemptions',
    fields: ['headline', 'code', 'subtext'],
  },
  {
    key: 'TESTIMONIAL_STRIP', label: 'Testimonial strip', icon: '💬',
    desc: 'Customer quotes — array editor coming, JSON for now',
    fields: ['__json'],
  },
];
const blockMeta = (key) => BLOCK_TYPES.find((t) => t.key === key) || { key, label: key, icon: '✨', desc: '', fields: ['__json'] };

// Inline help shown in the editor: what each block does + exactly what image
// (size + aspect) to upload, so a non-technical owner isn't guessing.
const BLOCK_GUIDE = {
  FEATURED_COLLECTION: { what: 'A hand-picked product row, shown in the order you select products.', image: 'No image here — each product uses its own photo. Upload 800×800 (square) on the products themselves.' },
  BESTSELLERS_AUTO:    { what: 'Auto-fills a product grid — set a Title and how many products to show (1–50).', image: 'No image here — uses each product’s own photo (1000×1000 square is ideal).' },
  EDITORIAL_RICHTEXT:  { what: 'An article-style card: title + paragraph + an optional side image. Plain text only (typed HTML is not rendered).', image: 'Optional. Upload 1600×900 (16:9 landscape), under ~400KB, with the subject centred — the sides may be cropped.' },
  RECIPE_LINKED:       { what: 'A recipe card (title + story + photo) with a “Shop the ingredients” product row.', image: 'Recommended. 1600×900 (16:9 landscape), min 1280×720, subject centred.' },
  CATEGORY_GRID:       { what: 'A row of tappable category tiles. Pick the categories customers should see first.', image: 'No image here — each category uses its own image (256×256 square, shown in a small circle).' },
  COUPON_CALLOUT:      { what: 'A promo banner with a copyable code. Type the code in UPPERCASE matching a real active coupon.', image: 'No image — it uses a built-in green gradient.' },
  TESTIMONIAL_STRIP:   { what: 'A swipeable row of customer review cards (stars + quote + name).', image: 'No image — stars and text only.' },
  HERO:                { what: 'Full-width homepage banner with a headline + button. Tip: heroes are better managed in the Banners tab.', image: 'Optional. 2560×800 (wide ~3:1), under ~400KB, subject centred behind a dark overlay.' },
};

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500';
function L({ children, hint }) {
  return (
    <label className="block text-xs font-medium text-gray-700 mb-1">
      {children}{hint && <span className="ml-1.5 text-[10px] font-normal text-gray-400">{hint}</span>}
    </label>
  );
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function MultiResourcePicker({ label, hint, value, items = [], onChange, placeholder, emptyText, renderSubtitle }) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(asArray(value)), [value]);
  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.id) || selected.has(item.slug)),
    [items, selected],
  );
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 80);
    return items.filter((item) => {
      const haystack = [item.name, item.sku, item.slug, item.barcode]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    }).slice(0, 80);
  }, [items, query]);

  function toggle(item) {
    const next = new Set(selected);
    const isSelected = next.has(item.id) || next.has(item.slug);
    next.delete(item.id);
    if (item.slug) next.delete(item.slug);
    if (!isSelected) next.add(item.id);
    onChange(Array.from(next));
  }

  function remove(item) {
    const next = new Set(selected);
    next.delete(item.id);
    if (item.slug) next.delete(item.slug);
    onChange(Array.from(next));
  }

  return (
    <div>
      <L hint={hint}>{label}</L>
      <div className="rounded-xl border border-gray-200 bg-white p-3">
        {selectedItems.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {selectedItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => remove(item)}
                className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800"
                title="Remove"
              >
                <span className="max-w-[220px] truncate">{item.name}</span>
                <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        )}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        />
        <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-gray-100">
          {filteredItems.length === 0 ? (
            <p className="px-3 py-4 text-sm text-gray-500">{emptyText}</p>
          ) : filteredItems.map((item) => {
            const checked = selected.has(item.id) || selected.has(item.slug);
            return (
              <label
                key={item.id}
                className="flex cursor-pointer items-start gap-3 border-b border-gray-50 px-3 py-2.5 text-sm last:border-b-0 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(item)}
                  className="mt-0.5 rounded border-gray-300 text-indigo-600"
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-gray-900">{item.name}</span>
                  {renderSubtitle && <span className="block truncate text-xs text-gray-500">{renderSubtitle(item)}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Visual block-type picker — replaces the dropdown when creating a new block
// ---------------------------------------------------------------------------
function BlockTypePicker({ value, onChange }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      {BLOCK_TYPES.map((t) => {
        const isActive = t.key === value;
        return (
          <button key={t.key} type="button" onClick={() => onChange(t.key)}
            className={`text-left p-3 rounded-xl border-2 transition-all ${
              isActive ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:border-indigo-300'
            }`}>
            <div className="flex items-start gap-2">
              <span className="text-2xl leading-none">{t.icon}</span>
              <div className="min-w-0">
                <p className={`text-xs font-bold ${isActive ? 'text-indigo-900' : 'text-gray-900'}`}>{t.label}</p>
                <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-2 leading-tight">{t.desc}</p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structured form — renders only the fields relevant to the picked block
// type. Falls back to a JSON textarea for unsupported types or when the
// seller toggles "Advanced".
// ---------------------------------------------------------------------------
function StructuredFields({ blockType, payload, onChange, products = [], categories = [] }) {
  const meta = blockMeta(blockType);
  const f = (k) => payload[k] ?? '';
  // Coerce numeric fields to a real number so the stored value isn't a string
  // (which the storefront then has to re-parse). `count` is the one numeric field.
  const set = (k) => (e) => {
    const raw = e.target.value;
    const v = k === 'count' ? (raw === '' ? '' : Number(raw)) : raw;
    onChange({ ...payload, [k]: v });
  };
  const setVal = (k) => (v) => onChange({ ...payload, [k]: v });

  // Seed the default count into the payload so it is actually persisted. The
  // input used to *display* 8 (value={f('count')||8}) without ever writing it,
  // so an untouched block saved no count and the storefront fell back to 8 —
  // making the Count field look ignored. (Root cause of "storefront shows 8".)
  useEffect(() => {
    if (meta.fields.includes('count') && (payload.count === undefined || payload.count === '')) {
      onChange({ ...payload, count: 8 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockType]);

  if (meta.fields.includes('__json')) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
        This block type doesn't have a structured form yet — use the Advanced JSON editor below to set its payload.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {meta.fields.includes('title') && (
        <div>
          <L>Title</L>
          <input type="text" value={f('title')} onChange={set('title')} maxLength={200} placeholder="e.g. Today's top deals" className={INPUT_CLS} />
        </div>
      )}
      {meta.fields.includes('headline') && (
        <div>
          <L>Headline *</L>
          <input type="text" value={f('headline')} onChange={set('headline')} maxLength={200} placeholder="e.g. Save 20% this week" className={INPUT_CLS} />
        </div>
      )}
      {meta.fields.includes('subtitle') && (
        <div>
          <L>Subtitle</L>
          <input type="text" value={f('subtitle')} onChange={set('subtitle')} maxLength={300} className={INPUT_CLS} />
        </div>
      )}
      {meta.fields.includes('subtext') && (
        <div>
          <L>Sub-text</L>
          <input type="text" value={f('subtext')} onChange={set('subtext')} maxLength={300}
            placeholder="e.g. Use code at checkout. Min order ₹500." className={INPUT_CLS} />
        </div>
      )}
      {meta.fields.includes('body') && (
        <div>
          <L hint="Plain text or simple HTML">Body</L>
          <textarea value={f('body')} onChange={set('body')} rows={5} maxLength={5000}
            placeholder="Tell the story — what makes this special?" className={INPUT_CLS} />
        </div>
      )}
      {meta.fields.includes('imageUrl') && (
        <div>
          <L>Image</L>
          <ImageDropZone value={f('imageUrl')} onChange={setVal('imageUrl')} scope="cms" frameAspect={16 / 9} />
        </div>
      )}
      {meta.fields.includes('ctaLabel') && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <L>CTA label</L>
            <input type="text" value={f('ctaLabel')} onChange={set('ctaLabel')} maxLength={80}
              placeholder="e.g. Shop now" className={INPUT_CLS} />
          </div>
          <div>
            <L>CTA URL</L>
            <input type="url" value={f('ctaUrl')} onChange={set('ctaUrl')} placeholder="/shop or https://…" className={INPUT_CLS} />
          </div>
        </div>
      )}
      {meta.fields.includes('code') && (
        <div>
          <L hint="Existing coupon code, e.g. WELCOME20">Coupon code</L>
          <input type="text" value={f('code')} onChange={set('code')} maxLength={40}
            className={`${INPUT_CLS} font-mono uppercase`} />
        </div>
      )}
      {meta.fields.includes('count') && (
        <div>
          <L hint="How many products to show">Count</L>
          <input type="number" value={f('count') || 8} onChange={set('count')} min="1" max="50"
            className={`${INPUT_CLS} font-mono w-32`} />
        </div>
      )}
      {meta.fields.includes('productIds') && (
        <MultiResourcePicker
          label="Products"
          hint="Search by name, SKU, barcode"
          value={payload.productIds}
          items={products}
          onChange={(ids) => onChange({ ...payload, productIds: ids })}
          placeholder="Search products to feature"
          emptyText="No products found. Add products first, then come back here."
          renderSubtitle={(product) => [product.sku, product.barcode, product.category?.name].filter(Boolean).join(' · ') || product.slug}
        />
      )}
      {meta.fields.includes('categoryIds') && (
        <MultiResourcePicker
          label="Categories"
          hint="Shown in this order"
          value={payload.categoryIds}
          items={categories}
          onChange={(ids) => onChange({ ...payload, categoryIds: ids })}
          placeholder="Search categories"
          emptyText="No categories found. Create categories first, then come back here."
          renderSubtitle={(category) => category.slug}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main editor — block-type picker → structured form (+ optional JSON view)
// ---------------------------------------------------------------------------
function BlockForm({ initial, locations = [], onSave, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [options, setOptions] = useState({ products: [], categories: [] });
  const [form, setForm] = useState(() => ({
    slotKey: initial?.slotKey || 'home.featured',
    blockType: initial?.blockType || 'FEATURED_COLLECTION',
    sortOrder: initial?.sortOrder ?? 0,
    status: initial?.status || 'PUBLISHED',
    // Default new content to All locations. Branch-only content is powerful,
    // but it should always be an explicit choice because otherwise sellers
    // think a saved block is broken when their cart is on another branch.
    locationId: initial ? (initial.locationId || '') : '',
    payload: initial?.payload || {},
  }));
  const [jsonText, setJsonText] = useState(() => JSON.stringify(initial?.payload || {}, null, 2));
  const [jsonError, setJsonError] = useState('');

  // Sync the payload from JSON text when the user edits raw JSON
  function applyJson() {
    try {
      const parsed = JSON.parse(jsonText || '{}');
      setForm((f) => ({ ...f, payload: parsed }));
      setJsonError('');
    } catch (err) { setJsonError('Invalid JSON: ' + err.message); }
  }

  // Sync JSON text when payload changes via the structured form
  useEffect(() => {
    if (!showAdvanced) setJsonText(JSON.stringify(form.payload, null, 2));
  }, [form.payload, showAdvanced]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api('/api/ecom/products?perPage=200').catch(() => ({ products: [] })),
      api('/api/ecom/categories').catch(() => ({ categories: [] })),
    ]).then(([productsRes, categoriesRes]) => {
      if (!alive) return;
      setOptions({
        products: productsRes.products || [],
        categories: categoriesRes.categories || [],
      });
    });
    return () => { alive = false; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    let payload = form.payload;
    if (showAdvanced) {
      try { payload = JSON.parse(jsonText || '{}'); }
      catch { setError('Payload must be valid JSON'); setBusy(false); return; }
    }
    try {
      const body = {
        slotKey: form.slotKey.trim(),
        blockType: form.blockType,
        sortOrder: Number(form.sortOrder),
        payload,
        locationId: form.locationId || null,
      };
      if (initial?.id) {
        await api(`/api/ecom/cms-blocks/${initial.id}`, { method: 'PUT', body: JSON.stringify(body) });
        if (form.status !== initial.status) {
          await api(`/api/ecom/cms-blocks/${initial.id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status: form.status }),
          });
        }
      } else {
        await api('/api/ecom/cms-blocks', {
          method: 'POST',
          body: JSON.stringify({ ...body, status: form.status }),
        });
      }
      onSave?.();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const meta = blockMeta(form.blockType);

  return (
    <form onSubmit={submit} className="space-y-5">
      {!initial?.id && (
        <div>
          <L>Pick a block type</L>
          <p className="text-[11px] text-gray-400 -mt-1 mb-2">Looking for a hero image? Those live in the <span className="font-semibold text-gray-500">Banners</span> tab (carousel + scheduling + click stats).</p>
          <BlockTypePicker value={form.blockType} onChange={(key) => setForm((f) => ({ ...f, blockType: key }))} />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2 flex items-center gap-3 px-3 py-2 rounded-xl bg-indigo-50 border border-indigo-200">
          <span className="text-2xl leading-none">{meta.icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-indigo-900">{meta.label}</p>
            <p className="text-xs text-indigo-700">{meta.desc}</p>
          </div>
        </div>
        <div>
          <L hint="Where this block renders, e.g. home.hero">Slot key *</L>
          <input type="text" value={form.slotKey} onChange={(e) => setForm((f) => ({ ...f, slotKey: e.target.value }))}
            placeholder="home.featured" className={`${INPUT_CLS} font-mono`} />
        </div>
        <div>
          <L hint="Lower = renders higher on the page">Sort order</L>
          <input type="number" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
            min="0" className={`${INPUT_CLS} font-mono`} />
        </div>
        <div>
          <L hint="Published is visible to customers">Visibility</L>
          <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={INPUT_CLS}>
            <option value="PUBLISHED">Published</option>
            <option value="DRAFT">Draft</option>
            <option value="IN_REVIEW">In review</option>
            {initial?.status === 'ARCHIVED' && <option value="ARCHIVED">Archived</option>}
          </select>
        </div>
        <div className="sm:col-span-2">
          <L hint="All locations = shown to every shopper (recommended for homepage content)">Show on</L>
          <select value={form.locationId} onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value }))} className={INPUT_CLS}>
            <option value="">All locations</option>
            {locations.filter((l) => l.id !== 'ALL').map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.city ? ` — ${l.city}` : ''}{l.isPrimary ? ' (main)' : ''}</option>
            ))}
          </select>
          {form.locationId && (
            <p className="text-[11px] text-amber-700 mt-1">Only shoppers who picked this branch will see it. Use &ldquo;All locations&rdquo; for store-wide content.</p>
          )}
        </div>
      </div>

      {!showAdvanced && (
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-700">Block content</p>
            <button type="button" onClick={() => setShowAdvanced(true)}
              className="text-[11px] font-mono uppercase tracking-wider text-gray-500 hover:text-indigo-700 hover:underline">
              Advanced (JSON)
            </button>
          </div>
          {BLOCK_GUIDE[form.blockType] && (
            <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3 text-xs text-indigo-900 space-y-1">
              <p>{BLOCK_GUIDE[form.blockType].what}</p>
              <p className="text-indigo-700"><span className="font-semibold">📷 Image:</span> {BLOCK_GUIDE[form.blockType].image}</p>
              <p className="text-indigo-500">Appears in the <span className="font-mono">{form.slotKey || 'home.featured'}</span> slot on your storefront home page{form.locationId ? ' — for the selected branch only' : ''}.</p>
            </div>
          )}
          <StructuredFields blockType={form.blockType} payload={form.payload}
            onChange={(p) => setForm((f) => ({ ...f, payload: p }))}
            products={options.products}
            categories={options.categories} />
        </div>
      )}

      {showAdvanced && (
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-700">Raw JSON payload</p>
            <button type="button" onClick={() => { setShowAdvanced(false); setJsonError(''); }}
              className="text-[11px] font-mono uppercase tracking-wider text-gray-500 hover:text-indigo-700 hover:underline">
              ← Back to structured form
            </button>
          </div>
          <textarea value={jsonText}
            onChange={(e) => { setJsonText(e.target.value); setJsonError(''); }}
            onBlur={applyJson} rows={10}
            className={`${INPUT_CLS} text-xs font-mono`} />
          {jsonError && <p className="text-xs text-red-700">{jsonError}</p>}
        </div>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
        <SecondaryButton type="button" onClick={onCancel} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" disabled={busy}>{busy ? 'Saving…' : initial?.id ? 'Save block' : 'Create block'}</PrimaryButton>
      </div>
    </form>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-2 sm:p-6 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-2xl max-w-3xl w-full my-4 max-h-[calc(100vh-2rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none -mt-1">×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
export default function CmsPanel() {
  const { locations } = useEcommerceLocation();
  const [bySlot, setBySlot] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const list = await api('/api/ecom/cms-blocks');
      setBySlot(list.bySlot || {});
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function setStatus(id, status) {
    try {
      await api(`/api/ecom/cms-blocks/${id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      reload();
    }
    catch (err) { setError(err.message); }
  }
  async function archive(id) {
    if (!window.confirm('Archive this block? It will no longer render on the storefront.')) return;
    try {
      await api(`/api/ecom/cms-blocks/${id}`, { method: 'DELETE' });
      reload();
    }
    catch (err) { setError(err.message); }
  }

  const locationName = useCallback((locationId) => {
    if (!locationId) return 'Global';
    return locations.find((location) => location.id === locationId)?.name || 'Store-local';
  }, [locations]);

  const slotKeys = Object.keys(bySlot).sort();
  const allBlocks = useMemo(() => Object.values(bySlot).flat(), [bySlot]);

  // Status counts for the KPI strip
  const kpis = useMemo(() => {
    const c = { total: allBlocks.length, published: 0, draft: 0, inReview: 0, archived: 0 };
    for (const b of allBlocks) {
      if (b.status === 'PUBLISHED') c.published += 1;
      else if (b.status === 'DRAFT') c.draft += 1;
      else if (b.status === 'IN_REVIEW') c.inReview += 1;
      else if (b.status === 'ARCHIVED') c.archived += 1;
    }
    return c;
  }, [allBlocks]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Storefront CMS"
        subtitle={`${slotKeys.length} slot${slotKeys.length === 1 ? '' : 's'} · ${allBlocks.length} block${allBlocks.length === 1 ? '' : 's'} total`}
        actions={<PrimaryButton onClick={() => setEditing({})}>+ New block</PrimaryButton>}
      />

      {allBlocks.length > 0 && (
        <KpiGrid cols={4}>
          <KpiCard label="Live on storefront" value={fmtNumber(kpis.published)} tone="success" />
          <KpiCard label="Drafts" value={fmtNumber(kpis.draft)} tone={kpis.draft > 0 ? 'warning' : null} hint="Not visible to customers" />
          <KpiCard label="In review" value={fmtNumber(kpis.inReview)} hint="Pending approval" />
          <KpiCard label="Archived" value={fmtNumber(kpis.archived)} />
        </KpiGrid>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {loading && slotKeys.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">Loading…</div>
      ) : slotKeys.length === 0 ? (
        <EmptyState
          title="No CMS blocks yet"
          message="CMS blocks are seller-controlled storefront sections: featured collections, recipe spotlights, category rows, editorial stories, and promo callouts."
          action={<PrimaryButton onClick={() => setEditing({})}>+ Create your first block</PrimaryButton>}
        />
      ) : (
        slotKeys.map((slotKey) => (
          <div key={slotKey} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-2">
              <span className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Slot</span>
              <code className="text-sm font-mono font-semibold text-gray-900">{slotKey}</code>
              <span className="text-xs text-gray-400">· {bySlot[slotKey].length} block{bySlot[slotKey].length === 1 ? '' : 's'}</span>
            </div>
            <div className="divide-y divide-gray-100">
              {bySlot[slotKey].map((b) => {
                const meta = blockMeta(b.blockType);
                const tone = b.status === 'PUBLISHED' ? 'success'
                  : b.status === 'IN_REVIEW' ? 'warning'
                  : b.status === 'ARCHIVED' ? 'danger' : 'neutral';
                return (
                  <button key={b.id} type="button" onClick={() => setEditing(b)}
                    className="w-full text-left p-4 flex items-start gap-4 hover:bg-gray-50/60 transition-colors">
                    <span className="text-3xl leading-none shrink-0 mt-0.5">{meta.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-gray-900">{meta.label}</p>
                        <StatusBadge tone={tone}>{b.status.toLowerCase().replace('_', ' ')}</StatusBadge>
                        <span className="text-[10px] font-mono text-gray-400">sort {b.sortOrder}</span>
                        <span className="text-[10px] font-mono text-gray-400">{locationName(b.locationId)}</span>
                      </div>
                      {b.payload?.title && <p className="text-sm text-gray-700 mt-1 truncate">{b.payload.title}</p>}
                      {b.payload?.headline && <p className="text-sm text-gray-700 mt-1 truncate">{b.payload.headline}</p>}
                      {b.publishedAt && <p className="text-[10px] text-gray-400 mt-0.5">Published {new Date(b.publishedAt).toLocaleDateString('en-GB')}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {b.status !== 'PUBLISHED' && (
                        <button type="button" onClick={() => setStatus(b.id, 'PUBLISHED')}
                          className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 hover:underline">Publish</button>
                      )}
                      {b.status === 'PUBLISHED' && (
                        <button type="button" onClick={() => setStatus(b.id, 'DRAFT')}
                          className="text-xs font-semibold text-gray-700 hover:underline">Unpublish</button>
                      )}
                      {b.status !== 'ARCHIVED' && (
                        <button type="button" onClick={() => archive(b.id)}
                          className="text-xs font-semibold text-red-700 hover:underline">Archive</button>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}

      {editing && (
        <Modal title={editing.id ? 'Edit block' : 'New CMS block'} onClose={() => setEditing(null)}>
          <BlockForm initial={editing.id ? editing : null}
            locations={locations}
            onCancel={() => setEditing(null)}
            onSave={() => { setEditing(null); reload(); }} />
        </Modal>
      )}
    </div>
  );
}

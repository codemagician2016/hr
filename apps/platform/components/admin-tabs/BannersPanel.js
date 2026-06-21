'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — BannersPanel
// Polish pass 2026-05-08: KPI strip + side-by-side live preview while
// editing + ecom-ui primitives.
//
// Backend: /api/ecom/banners (Phase 3d).

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import ImageDropZone from '@/components/ImageDropZone';
import {
  KpiCard, KpiGrid,
  StatusBadge, toneForStatus,
  PageHeader, EmptyState, ErrorBanner, PrimaryButton, SecondaryButton,
  fmtNumber, fmtPercent,
} from '@/components/ecom-ui';

// Tight input styles reused across the editor form below.
const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500 disabled:bg-gray-50';
function L({ children }) {
  return <label className="block text-xs font-medium text-gray-700 mb-1">{children}</label>;
}

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

const PLACEMENTS = [
  { key: 'HOMEPAGE_HERO',  label: 'Homepage hero',          icon: '🎯', accent: 'emerald' },
  { key: 'HOMEPAGE_STRIP', label: 'Homepage promo strip',   icon: '📣', accent: 'blue' },
  { key: 'CATEGORY_HERO',  label: 'Category landing hero',  icon: '🗂', accent: 'indigo' },
  { key: 'CART_UPSELL',    label: 'Cart upsell',            icon: '🛒', accent: 'amber' },
  { key: 'ACCOUNT_OFFER',  label: 'Account-page offer',     icon: '👤', accent: 'purple' },
  { key: 'CHECKOUT_BANNER',label: 'Checkout banner',        icon: '💳', accent: 'pink' },
];
const PLACEMENT_KEYS = new Set(PLACEMENTS.map((placement) => placement.key));
const ACCENT_BG = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  blue:    'bg-blue-50 text-blue-700 border-blue-200',
  indigo:  'bg-indigo-50 text-indigo-700 border-indigo-200',
  amber:   'bg-amber-50 text-amber-700 border-amber-200',
  purple:  'bg-purple-50 text-purple-700 border-purple-200',
  pink:    'bg-pink-50 text-pink-700 border-pink-200',
};
const placementMeta = (key) => PLACEMENTS.find((p) => p.key === key) || { label: key, icon: '✨', accent: 'emerald' };

const AUDIENCES = ['ALL', 'GUEST', 'LOGGED_IN', 'NEW', 'RETURNING', 'VIP'];
const LINK_TYPES = ['NONE', 'PRODUCT', 'CATEGORY', 'URL'];

const PLACEMENT_GUIDE = {
  HOMEPAGE_HERO: {
    where: 'Top of the grocery storefront homepage, before categories.',
    shape: 'Large desktop hero with mobile image fallback. Multiple active hero banners become an auto-rotating carousel.',
    cta: 'Best for seasonal campaigns, weekly offers, festival promotions, and new collection launches.',
  },
  HOMEPAGE_STRIP: {
    where: 'Homepage promo strip below product sections.',
    shape: 'Compact horizontal banner.',
    cta: 'Best for delivery promises, app offers, and short-term coupon callouts.',
  },
  CATEGORY_HERO: {
    where: 'Category landing pages above the category product grid.',
    shape: 'Category-specific large hero.',
    cta: 'Best for produce week, dairy deals, bakery collections, or brand-led shelves.',
  },
  CART_UPSELL: {
    where: 'Cart experience near checkout intent.',
    shape: 'Compact promo card.',
    cta: 'Best for free-delivery threshold, add-on offers, and basket-building campaigns.',
  },
  ACCOUNT_OFFER: {
    where: 'Customer account surfaces.',
    shape: 'Account offer card.',
    cta: 'Best for loyalty, repeat-order, and membership campaigns.',
  },
  CHECKOUT_BANNER: {
    where: 'Checkout flow before final payment.',
    shape: 'Slim reassurance or offer banner.',
    cta: 'Best for payment trust, delivery promise, and last-minute notices.',
  },
};

function PlacementGuide({ placement }) {
  const guide = PLACEMENT_GUIDE[placement] || PLACEMENT_GUIDE.HOMEPAGE_HERO;
  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 p-3 text-xs text-indigo-900 leading-relaxed">
      <p className="font-semibold text-indigo-950">Where this appears</p>
      <p className="mt-1">{guide.where}</p>
      <p className="mt-1"><span className="font-semibold">Layout:</span> {guide.shape}</p>
      <p className="mt-1 text-indigo-700">{guide.cta}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live preview tile — mirrors the storefront's BannerCard styling so the
// admin sees exactly what will render on customer-facing pages.
// ---------------------------------------------------------------------------
function BannerPreview({ form, variant = 'hero' }) {
  const isHero = variant === 'hero';
  const imageUrl = form.mobileImageUrl || form.desktopImageUrl;
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-gray-400">Live preview · {isHero ? 'homepage hero / carousel slide' : 'compact strip'}</p>
      <div className={`relative overflow-hidden rounded-2xl bg-gray-900 ${isHero ? 'min-h-[200px]' : 'min-h-[80px]'}`}>
        {form.desktopImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={form.desktopImageUrl} alt={form.altText || form.headline || ''}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500">No image yet — drop one to see the preview</div>
        )}
        {(form.headline || form.ctaLabel || form.subheadline) && (
          <div className="absolute inset-0 bg-gradient-to-r from-black/60 to-transparent flex flex-col justify-center px-6 py-4 gap-1.5">
            {form.headline && <h2 className={`font-bold text-white leading-tight ${isHero ? 'text-xl' : 'text-sm'}`}>{form.headline}</h2>}
            {form.subheadline && <p className="text-xs text-white/80 max-w-md">{form.subheadline}</p>}
            {form.ctaLabel && <span className="mt-1 inline-block px-3 py-1 rounded-full text-xs font-bold bg-white text-gray-900 w-fit">{form.ctaLabel}</span>}
          </div>
        )}
      </div>
      {form.mobileImageUrl && (
        <>
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-gray-400 pt-2">Mobile preview</p>
          <div className="relative overflow-hidden rounded-xl bg-gray-900 aspect-[3/4] max-w-[180px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
            {(form.headline || form.ctaLabel || form.subheadline) && (
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/25 to-transparent flex flex-col justify-end p-4 gap-1">
                {form.headline && <h3 className="text-lg font-black text-white leading-tight">{form.headline}</h3>}
                {form.subheadline && <p className="text-xs text-white/80 line-clamp-2">{form.subheadline}</p>}
                {form.ctaLabel && <span className="mt-1 inline-block px-3 py-1 rounded-full text-xs font-bold bg-white text-gray-900 w-fit">{form.ctaLabel}</span>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor — split panel: form on left, live preview on right (lg+).
// Stacks on smaller screens.
// ---------------------------------------------------------------------------
function BannerEditor({ initial, locations, onSave, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [linkOptions, setLinkOptions] = useState({ products: [], categories: [] });
  const [form, setForm] = useState(() => ({
    placement: initial?.placement || 'HOMEPAGE_HERO',
    sortOrder: initial?.sortOrder ?? 0,
    locationId: initial?.locationId || '',
    audience: initial?.audience || 'ALL',
    desktopImageUrl: initial?.desktopImageUrl || '',
    mobileImageUrl: initial?.mobileImageUrl || '',
    altText: initial?.altText || '',
    headline: initial?.headline || '',
    subheadline: initial?.subheadline || '',
    ctaLabel: initial?.ctaLabel || '',
    linkType: LINK_TYPES.includes(initial?.linkType) ? initial.linkType : 'NONE',
    linkProductId: initial?.linkProductId || '',
    linkCategoryId: initial?.linkCategoryId || '',
    linkUrl: initial?.linkUrl || '',
    isActive: initial?.isActive ?? true,
    startsAt: initial?.startsAt ? initial.startsAt.slice(0, 10) : '',
    endsAt: initial?.endsAt ? initial.endsAt.slice(0, 10) : '',
  }));
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setField = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    let alive = true;
    Promise.all([
      api('/api/ecom/products?perPage=200').catch(() => ({ products: [] })),
      api('/api/ecom/categories').catch(() => ({ categories: [] })),
    ]).then(([productsRes, categoriesRes]) => {
      if (!alive) return;
      setLinkOptions({
        products: productsRes.products || [],
        categories: categoriesRes.categories || [],
      });
    });
    return () => { alive = false; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const payload = {
        placement: form.placement, sortOrder: Number(form.sortOrder),
        audience: form.audience, linkType: form.linkType, isActive: form.isActive,
      };
      ['locationId', 'desktopImageUrl', 'mobileImageUrl', 'altText', 'headline', 'subheadline', 'ctaLabel', 'linkUrl', 'linkProductId', 'linkCategoryId'].forEach((k) => {
        const v = String(form[k] || '').trim();
        payload[k] = v || null;
      });
      if (form.linkType !== 'URL') payload.linkUrl = null;
      if (form.linkType !== 'PRODUCT') payload.linkProductId = null;
      if (form.linkType !== 'CATEGORY') payload.linkCategoryId = null;
      payload.linkPageId = null;
      if (form.startsAt) payload.startsAt = new Date(form.startsAt).toISOString();
      if (form.endsAt)   payload.endsAt   = new Date(form.endsAt).toISOString();

      if (initial?.id) await api(`/api/ecom/banners/${initial.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else             await api('/api/ecom/banners', { method: 'POST', body: JSON.stringify(payload) });
      onSave?.();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const isStripVariant = form.placement === 'HOMEPAGE_STRIP' || form.placement === 'CART_UPSELL' || form.placement === 'CHECKOUT_BANNER';

  return (
    <form onSubmit={submit} className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] gap-6">
      {/* Left: form */}
      <div className="space-y-3 min-w-0">
        <PlacementGuide placement={form.placement} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <L>Placement *</L>
            <select value={form.placement} onChange={set('placement')} className={INPUT_CLS}>
              {PLACEMENTS.map((p) => <option key={p.key} value={p.key}>{p.icon} {p.label}</option>)}
            </select>
          </div>
          <div>
            <L>Audience</L>
            <select value={form.audience} onChange={set('audience')} className={INPUT_CLS}>
              {AUDIENCES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>
        <div>
          <L>Headline</L>
          <input type="text" value={form.headline} onChange={set('headline')} maxLength={200} className={INPUT_CLS} />
        </div>
        <div>
          <L>Sub-headline</L>
          <textarea value={form.subheadline} onChange={set('subheadline')} rows={2} maxLength={500} className={INPUT_CLS} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <L>Desktop image</L>
            <ImageDropZone value={form.desktopImageUrl} onChange={setField('desktopImageUrl')} scope="banner" frameAspect={16 / 9} />
          </div>
          <div>
            <L>Mobile image (optional)</L>
            <ImageDropZone value={form.mobileImageUrl} onChange={setField('mobileImageUrl')} scope="banner" frameAspect={3 / 4} />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <L>Alt text</L>
            <input type="text" value={form.altText} onChange={set('altText')} maxLength={200} className={INPUT_CLS} />
          </div>
          <div>
            <L>CTA label</L>
            <input type="text" value={form.ctaLabel} onChange={set('ctaLabel')} maxLength={80} placeholder="e.g. Shop now" className={INPUT_CLS} />
          </div>
          <div>
            <L>Link type</L>
            <select value={form.linkType} onChange={set('linkType')} className={INPUT_CLS}>
              {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <L>Link URL</L>
            <input
              type="text"
              value={form.linkUrl}
              onChange={set('linkUrl')}
              disabled={form.linkType !== 'URL'}
              placeholder="/shop or https://example.com"
              className={INPUT_CLS}
            />
          </div>
          <div>
            <L>Product</L>
            <select value={form.linkProductId} onChange={set('linkProductId')} disabled={form.linkType !== 'PRODUCT'} className={INPUT_CLS}>
              <option value="">Select product</option>
              {form.linkProductId && !linkOptions.products.some((p) => p.id === form.linkProductId) && (
                <option value={form.linkProductId}>Current product ({form.linkProductId.slice(0, 8)})</option>
              )}
              {linkOptions.products.map((product) => (
                <option key={product.id} value={product.id}>{product.name}{product.sku ? ` · ${product.sku}` : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <L>Category</L>
            <select value={form.linkCategoryId} onChange={set('linkCategoryId')} disabled={form.linkType !== 'CATEGORY'} className={INPUT_CLS}>
              <option value="">Select category</option>
              {form.linkCategoryId && !linkOptions.categories.some((c) => c.id === form.linkCategoryId) && (
                <option value={form.linkCategoryId}>Current category ({form.linkCategoryId.slice(0, 8)})</option>
              )}
              {linkOptions.categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </div>
          <div>
            <L>Location override</L>
            <select value={form.locationId} onChange={set('locationId')} className={INPUT_CLS}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <L>Sort order</L>
            <input type="number" value={form.sortOrder} onChange={set('sortOrder')} min="0" className={`${INPUT_CLS} font-mono`} />
          </div>
          <div>
            <L>Starts</L>
            <input type="date" value={form.startsAt} onChange={set('startsAt')} className={INPUT_CLS} />
          </div>
          <div>
            <L>Ends</L>
            <input type="date" value={form.endsAt} onChange={set('endsAt')} className={INPUT_CLS} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 pt-1">
          <input type="checkbox" checked={form.isActive} onChange={set('isActive')} className="rounded" />
          Active
        </label>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <SecondaryButton type="button" onClick={onCancel} disabled={busy}>Cancel</SecondaryButton>
          <PrimaryButton type="submit" disabled={busy}>{busy ? 'Saving…' : initial?.id ? 'Save banner' : 'Create banner'}</PrimaryButton>
        </div>
      </div>

      {/* Right: sticky live preview */}
      <aside className="lg:sticky lg:top-2 self-start space-y-4">
        <BannerPreview form={form} variant={isStripVariant ? 'strip' : 'hero'} />
        <div className="text-[11px] text-gray-500 leading-relaxed bg-gray-50 rounded-xl border border-gray-200 p-3">
          <p className="font-semibold text-gray-700 mb-1">How hero carousel works</p>
          Add more than one active “Homepage hero” banner and set their sort order. The storefront automatically turns them into a rotating carousel; one active hero stays as a single static hero.
        </div>
      </aside>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Wide modal — fits the form-plus-preview layout on lg+ screens.
// ---------------------------------------------------------------------------
function WideModal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-2 sm:p-6 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-2xl w-full max-w-5xl my-4 max-h-[calc(100vh-2rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
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
export default function BannersPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { locations } = useEcommerceLocation();
  const urlPlacement = searchParams.get('placement') || 'all';
  const urlView = searchParams.get('view') || '';
  const urlId = searchParams.get('id') || '';
  const [rows, setRows] = useState([]);
  const [placementFilter, setPlacementFilterValue] = useState(PLACEMENT_KEYS.has(urlPlacement) ? urlPlacement : 'all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const replaceBannerQuery = useCallback((mutate) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(params.toString() ? `?${params.toString()}` : window.location.pathname, { scroll: false });
  }, [router, searchParams]);

  const setPlacementFilter = useCallback((placement) => {
    const nextPlacement = PLACEMENT_KEYS.has(placement) ? placement : 'all';
    setPlacementFilterValue(nextPlacement);
    replaceBannerQuery((params) => {
      if (nextPlacement === 'all') params.delete('placement');
      else params.set('placement', nextPlacement);
    });
  }, [replaceBannerQuery]);

  const openEditor = useCallback((banner = {}) => {
    setEditing(banner);
    replaceBannerQuery((params) => {
      params.set('view', banner.id ? 'ecom-banner-edit' : 'ecom-banner-create');
      if (banner.id) params.set('id', banner.id);
      else params.delete('id');
    });
  }, [replaceBannerQuery]);

  const closeEditor = useCallback(() => {
    setEditing(null);
    replaceBannerQuery((params) => {
      params.delete('view');
      params.delete('id');
    });
  }, [replaceBannerQuery]);

  useEffect(() => {
    setPlacementFilterValue(PLACEMENT_KEYS.has(urlPlacement) ? urlPlacement : 'all');
  }, [urlPlacement]);

  useEffect(() => {
    if (urlView === 'ecom-banner-create') {
      setEditing({});
      return;
    }
    if (urlView === 'ecom-banner-edit' && urlId) {
      const row = rows.find((banner) => banner.id === urlId);
      if (row) setEditing(row);
      return;
    }
    setEditing(null);
  }, [rows, urlId, urlView]);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (placementFilter !== 'all') params.set('placement', placementFilter);
      const list = await api(`/api/ecom/banners?${params.toString()}`);
      setRows(list.rows || []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [placementFilter]);

  useEffect(() => { reload(); }, [reload]);

  async function deactivate(id) {
    if (!window.confirm('Deactivate this banner?')) return;
    try { await api(`/api/ecom/banners/${id}`, { method: 'DELETE' }); reload(); }
    catch (err) { setError(err.message); }
  }

  // KPIs derived from the loaded rows. Good enough for the grocery
  // owner's at-a-glance — backend has more detailed analytics in
  // EcommerceReportsPanel for deep dives.
  const kpis = useMemo(() => {
    const now = Date.now();
    let active = 0, inactive = 0, scheduled = 0, expired = 0;
    let impressions = 0, clicks = 0;
    for (const b of rows) {
      const startsAtMs = b.startsAt ? new Date(b.startsAt).getTime() : null;
      const endsAtMs   = b.endsAt   ? new Date(b.endsAt).getTime()   : null;
      if (!b.isActive) inactive += 1;
      else if (startsAtMs && startsAtMs > now) scheduled += 1;
      else if (endsAtMs && endsAtMs < now)     expired += 1;
      else active += 1;
      impressions += b.impressions || 0;
      clicks      += b.clicks      || 0;
    }
    const ctr = impressions > 0 ? clicks / impressions : null;
    return { active, inactive, scheduled, expired, impressions, clicks, ctr };
  }, [rows]);

  // Group by placement for the list section
  const byPlacement = useMemo(() => {
    const m = {};
    for (const r of rows) {
      if (!m[r.placement]) m[r.placement] = [];
      m[r.placement].push(r);
    }
    return m;
  }, [rows]);
  const locationName = useCallback((locationId) => {
    if (!locationId) return 'All locations';
    return locations.find((location) => location.id === locationId)?.name || 'Selected location';
  }, [locations]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Banners"
        subtitle={`${rows.length} total · hero images, carousel slides, promo strips, and checkout offers`}
        actions={<PrimaryButton onClick={() => openEditor({})}>+ Create banner</PrimaryButton>}
      />

      <KpiGrid cols={4}>
        <KpiCard label="Active" value={fmtNumber(kpis.active)} tone="success" hint={kpis.scheduled > 0 ? `+${kpis.scheduled} scheduled` : null} />
        <KpiCard label="Inactive" value={fmtNumber(kpis.inactive + kpis.expired)} tone={kpis.inactive > 0 ? 'warning' : null} hint={kpis.expired > 0 ? `${kpis.expired} expired` : null} />
        <KpiCard label="Total impressions" value={fmtNumber(kpis.impressions)} hint={`${fmtNumber(kpis.clicks)} clicks`} />
        <KpiCard label="Click-through rate" value={kpis.ctr == null ? '—' : fmtPercent(kpis.ctr)} tone={kpis.ctr != null && kpis.ctr >= 0.02 ? 'success' : null} hint="Industry avg ~1-2%" />
      </KpiGrid>

      <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 flex items-center gap-3">
        <span className="text-[11px] font-mono tracking-widest uppercase text-gray-500">Filter</span>
        <select value={placementFilter} onChange={(e) => setPlacementFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
          <option value="all">All placements ({rows.length})</option>
          {PLACEMENTS.map((p) => {
            const count = byPlacement[p.key]?.length || 0;
            return <option key={p.key} value={p.key}>{p.icon} {p.label} ({count})</option>;
          })}
        </select>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {loading && rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No banners yet"
          message="Hero banners are the first thing your customers see. Add one to drive attention to a promo, new arrivals, or a seasonal collection."
          action={<PrimaryButton onClick={() => openEditor({})}>+ Create your first banner</PrimaryButton>}
        />
      ) : (
        Object.keys(byPlacement).map((placement) => {
          const meta = placementMeta(placement);
          return (
            <div key={placement} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${ACCENT_BG[meta.accent]}`}>
                  <span>{meta.icon}</span>{meta.label}
                </span>
                <span className="text-xs text-gray-400">· {byPlacement[placement].length} banner{byPlacement[placement].length === 1 ? '' : 's'}</span>
              </div>
              <div className="divide-y divide-gray-100">
                {byPlacement[placement].map((b) => {
                  const startsAtMs = b.startsAt ? new Date(b.startsAt).getTime() : null;
                  const endsAtMs   = b.endsAt   ? new Date(b.endsAt).getTime()   : null;
                  const now = Date.now();
                  const status = !b.isActive ? 'inactive'
                    : startsAtMs && startsAtMs > now ? 'scheduled'
                    : endsAtMs && endsAtMs < now ? 'expired'
                    : 'active';
                  const ctr = b.impressions > 0 ? (b.clicks / b.impressions) : null;
                  return (
                    <button key={b.id} type="button" onClick={() => openEditor(b)}
                      className="w-full p-4 flex items-start gap-4 text-left hover:bg-gray-50/60 transition-colors">
                      {b.desktopImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={b.desktopImageUrl} alt={b.altText || ''}
                          className="w-32 h-20 object-cover rounded-lg border border-gray-200 shrink-0" />
                      ) : (
                        <div className="w-32 h-20 rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400 shrink-0">
                          No image
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <p className="text-sm font-semibold text-gray-900 truncate">{b.headline || '(untitled)'}</p>
                          <StatusBadge tone={toneForStatus(status)}>{status}</StatusBadge>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 bg-gray-50 text-gray-700 border border-gray-200 rounded">{b.audience}</span>
                          {b.ctaLabel && <span className="text-[10px] text-gray-500">CTA: <strong className="text-gray-700">{b.ctaLabel}</strong></span>}
                          <span className="text-[10px] font-mono px-1.5 py-0.5 bg-gray-50 text-gray-500 border border-gray-200 rounded">{locationName(b.locationId)}</span>
                        </div>
                        {b.subheadline && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{b.subheadline}</p>}
                        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-gray-500">
                          <span>{fmtNumber(b.impressions)} impressions</span>
                          <span>·</span>
                          <span>{fmtNumber(b.clicks)} clicks</span>
                          {ctr !== null && (
                            <>
                              <span>·</span>
                              <span className={`font-semibold ${ctr >= 0.02 ? 'text-emerald-700' : 'text-gray-600'}`}>
                                {fmtPercent(ctr)} CTR
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0 text-right">
                        <span className="text-[10px] text-gray-400">Click to edit</span>
                        {b.isActive && (
                          <button type="button" onClick={(e) => { e.stopPropagation(); deactivate(b.id); }}
                            className="text-xs font-semibold text-gray-500 hover:text-red-700 hover:underline">Deactivate</button>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      {editing && (
        <WideModal title={editing.id ? 'Edit banner' : 'New banner'} onClose={closeEditor}>
          <BannerEditor
            initial={editing.id ? editing : null}
            locations={locations}
            onCancel={closeEditor}
            onSave={() => { closeEditor(); reload(); }}
          />
        </WideModal>
      )}
    </div>
  );
}

'use client';

// E-commerce category CRUD admin UI. Mounted at /<slug>/admin?tab=categories
// when Business.vertical === 'ECOMMERCE'.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { slugify } from '@/lib/slugify';
import { useConfirm } from '@/components/ConfirmDialog';
import { useFormSubmit } from '@/lib/useFormSubmit';
import ImageDropZone from '@/components/ImageDropZone';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';

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

const byDisplayOrder = (a, b) => (
  (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0)
) || a.name.localeCompare(b.name);

// ----------------- Tree helpers (N-level support) -----------------
// Mirror of backend/src/core/lib/categoryDepth.js logic — computed
// client-side from the loaded list so the form can disable invalid
// parent options BEFORE the user submits. Backend still re-validates
// every save, this is just UX.

function buildIndex(cats) {
  const byId = new Map(); const byParent = new Map();
  for (const c of cats) byId.set(c.id, c);
  for (const c of cats) {
    if (!c.parentId) continue;
    if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
    byParent.get(c.parentId).push(c);
  }
  byParent.forEach((arr) => arr.sort(byDisplayOrder));
  return { byId, byParent };
}
function depthOf(id, byId) {
  let d = 1; let cur = byId.get(id);
  while (cur?.parentId && d < 32) { d += 1; cur = byId.get(cur.parentId); }
  return d;
}
function descendantIds(id, byParent) {
  const out = []; const stack = [id];
  while (stack.length) {
    const top = stack.pop();
    for (const c of (byParent.get(top) || [])) { out.push(c.id); stack.push(c.id); }
  }
  return out;
}
function subtreeDepth(id, byParent) {
  let level = [id]; let depth = 1;
  while (level.length && depth < 32) {
    const next = [];
    for (const x of level) for (const c of (byParent.get(x) || [])) next.push(c.id);
    if (!next.length) return depth;
    level = next; depth += 1;
  }
  return depth;
}
function pathOf(id, byId) {
  const out = []; let cur = byId.get(id); let g = 0;
  while (cur && g < 32) { out.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null; g += 1; }
  return out.join(' › ');
}

function CategoryForm({ initial, presetParentId, allCategories = [], maxDepth = 2, onSave, onCancel, busy }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [slug, setSlug] = useState(initial?.slug || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl || '');
  const [isPublished, setIsPublished] = useState(initial?.isPublished !== false);
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 0);
  const [parentId, setParentId] = useState(initial?.parentId || presetParentId || '');
  const [slugTouched, setSlugTouched] = useState(isEdit);

  useEffect(() => { if (!slugTouched) setSlug(slugify(name)); }, [name, slugTouched]);

  // Build a depth-aware list of options for the parent dropdown. Rules:
  //   1. Hide self (a category can't be its own parent)
  //   2. Hide all descendants (would create a cycle if we set them as parent)
  //   3. Disable any candidate where (parentDepth + 1 + ourSubtreeDepth - 1) > maxDepth
  //      — i.e. moving us under that parent would push our deepest leaf
  //      past the tier's nesting cap.
  // Each option shows the full breadcrumb path so the seller sees
  // "Produce › Fresh fruit" instead of just "Fresh fruit" (especially
  // important when sibling categories share names).
  const parentChoices = useMemo(() => {
    const { byId, byParent } = buildIndex(allCategories);
    // For an edit, our subtree depth determines headroom available.
    // For a create (no children yet), subtree depth = 1.
    const ourSubtree = isEdit ? subtreeDepth(initial.id, byParent) : 1;
    const blocked = isEdit ? new Set([initial.id, ...descendantIds(initial.id, byParent)]) : new Set();
    // Sort by path so the dropdown reads top-to-bottom in tree order.
    const sorted = [...allCategories].sort((a, b) => pathOf(a.id, byId).localeCompare(pathOf(b.id, byId)));
    return sorted.map((c) => {
      if (blocked.has(c.id)) return null;
      const candDepth = depthOf(c.id, byId);
      // If we placed our subtree under this candidate, deepest leaf would land at
      // (candDepth + ourSubtree). Reject if exceeds maxDepth.
      const projected = candDepth + ourSubtree;
      return {
        id: c.id,
        path: pathOf(c.id, byId),
        depth: candDepth,
        disabled: projected > maxDepth,
        reason: projected > maxDepth
          ? `Would exceed your ${maxDepth}-level limit (lands at depth ${projected})`
          : null,
      };
    }).filter(Boolean);
  }, [allCategories, isEdit, initial?.id, maxDepth]);

  const { submit, error, setError } = useFormSubmit({
    save: () => onSave({
      name,
      slug: slug || slugify(name),
      description: description || null,
      imageUrl: imageUrl || null,
      isPublished,
      sortOrder: Math.max(0, Math.trunc(Number(sortOrder) || 0)),
      parentId: parentId || null,
    }),
    onError: (err) => {
      if (err?.errors?.length) setError(`${err.message}: ${err.errors.join(' · ')}`);
    },
  });

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Produce, Dairy, Bakery"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">URL slug *</label>
          <input type="text" value={slug}
            onChange={(e) => { setSlug(slugify(e.target.value)); setSlugTouched(true); }}
            placeholder="auto"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)}
          rows={2} maxLength={500}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Display order</label>
        <input
          type="number"
          min="0"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          className="w-36 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
        />
        <p className="mt-1 text-[11px] text-gray-500">Lower numbers appear first in the storefront menu and category sections.</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Category image</label>
        <ImageDropZone value={imageUrl} onChange={setImageUrl} scope="category" max={1} />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Parent category</label>
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white font-mono">
          <option value="">— Top-level category —</option>
          {parentChoices.map((p) => (
            <option key={p.id} value={p.id} disabled={p.disabled}
              title={p.reason || ''}>
              {/* Indent to depth so the dropdown visually reads as a tree */}
              {'  '.repeat(Math.max(0, p.depth - 1))}{p.path}
              {p.disabled ? ' · (max depth)' : ''}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-gray-500">
          Your plan supports up to <strong>{maxDepth}</strong>-level nesting.
          {maxDepth > 2 && ' Pick any category as the parent — sub-categories at deeper levels too.'}
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={isPublished} onChange={(e) => setIsPublished(e.target.checked)} />
        <span className="text-sm text-gray-700">Visible on storefront</span>
      </label>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 p-2 text-xs text-red-800">{error}</div>}

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-700">Cancel</button>
        <button type="submit" disabled={busy || !name}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-700">
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create category'}
        </button>
      </div>
    </form>
  );
}

function Chevron({ open }) {
  return (
    <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

function CategoryThumb({ cat, dimmed }) {
  if (cat.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={cat.imageUrl} alt="" className={`w-9 h-9 rounded-lg object-cover ${dimmed ? 'opacity-70' : ''}`}
      onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
  }
  return (
    <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold ${
      dimmed ? 'bg-gray-50 text-gray-400' : 'bg-indigo-50 text-indigo-700'
    }`}>
      {cat.name.charAt(0).toUpperCase()}
    </div>
  );
}

function productScopeLabel(depth, hasChildren) {
  if (!hasChildren) return '';
  return depth === 1 ? ' (across subcategories)' : ' (across leaf categories)';
}

function CategoryRow({ cat, depth, hasChildren, isExpanded, childCount, productCount = 0, canAddChild, onToggle, onEdit, onDelete, onAddChild }) {
  const isChild = depth > 1;
  const isDeepChild = depth > 2; // depth 3+ gets a slightly different treatment
  const productLabel = `${productCount} product${productCount === 1 ? '' : 's'}${productScopeLabel(depth, hasChildren)}`;
  return (
    <li className={`flex items-center gap-3 px-5 py-3 hover:bg-gray-50/60 transition-colors ${
      isDeepChild ? 'bg-gray-50/50' : isChild ? 'bg-gray-50/25' : ''
    }`}>
      <div className="flex items-center gap-1.5 shrink-0" style={{ marginLeft: (depth - 1) * 24 }}>
        {/* Tree branch indicator for non-top-level rows */}
        {isChild && (
          <span className="w-4 h-4 flex items-center justify-center text-gray-300 font-mono text-sm select-none">└</span>
        )}
        {/* Chevron toggle if has children (any depth) */}
        <button type="button" onClick={onToggle}
          disabled={!hasChildren}
          className={`w-5 h-5 flex items-center justify-center rounded ${hasChildren ? 'hover:bg-gray-200' : 'opacity-0 cursor-default'}`}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}>
          <Chevron open={isExpanded} />
        </button>
      </div>

      <CategoryThumb cat={cat} dimmed={isChild} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className={`text-sm font-medium truncate ${isDeepChild ? 'text-gray-600' : isChild ? 'text-gray-700' : 'text-gray-900'}`}>{cat.name}</p>
          {hasChildren && (
            <>
              <span className="text-xs text-gray-300">-</span>
              <span className={`text-xs font-medium ${isChild ? 'text-gray-500' : 'text-indigo-700'}`}>
                {childCount} sub
              </span>
            </>
          )}
          <span className="text-xs text-gray-300">-</span>
          <span className="text-xs font-mono uppercase tracking-wider text-gray-400">L{depth}</span>
          <span className="text-xs text-gray-300">-</span>
          <span className="text-xs font-mono text-gray-400">sort {cat.sortOrder || 0}</span>
          <span className="text-xs text-gray-300">-</span>
          <span className="text-xs text-gray-600">{productLabel}</span>
        </div>
        <p className="text-xs text-gray-500">
          <code className="font-mono text-[11px]">/{cat.slug}</code>
        </p>
      </div>

      <span className={`text-[11px] font-medium px-2 py-0.5 rounded shrink-0 ${cat.isPublished ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
        {cat.isPublished ? '● Visible' : '○ Hidden'}
      </span>

      <div className="flex items-center gap-2 shrink-0">
        {canAddChild && (
          <button type="button" onClick={onAddChild}
            className="text-xs font-medium text-gray-500 hover:text-indigo-600 hover:underline">
            + Subcategory
          </button>
        )}
        <button type="button" onClick={onEdit} className="text-xs font-medium text-indigo-600 hover:underline">Edit</button>
        <button type="button" onClick={onDelete} className="text-xs font-medium text-red-600 hover:underline">Delete</button>
      </div>
    </li>
  );
}

export default function CategoriesPanel() {
  const { active: activeLocation } = useEcommerceLocation();
  const [categories, setCategories] = useState([]);
  const [maxDepth, setMaxDepthState] = useState(2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const confirm = useConfirm();

  // Sub-page state lives in the URL so refresh / back-button / deep-links
  // all preserve context. ?view=create | edit, ?id=<categoryId>,
  // ?parent=<parentId> (create only). Admin-shell setTab strips these
  // when switching to a different tab so they don't leak across panels.
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = searchParams.get('view') || '';
  const urlId = searchParams.get('id') || '';
  const urlParent = searchParams.get('parent') || '';

  const goList = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete('view'); p.delete('id'); p.delete('parent');
    router.replace(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const goCreate = useCallback((parentId) => {
    const p = new URLSearchParams(searchParams.toString());
    p.set('view', 'create'); p.delete('id');
    if (parentId) p.set('parent', parentId); else p.delete('parent');
    router.push(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const goEdit = useCallback((cat) => {
    const p = new URLSearchParams(searchParams.toString());
    p.set('view', 'edit'); p.set('id', cat.id); p.delete('parent');
    router.push(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  // Resolved sub-page mode, derived from URL + loaded data
  const mode = view === 'create' ? { kind: 'create', presetParentId: urlParent || null }
    : view === 'edit' && urlId
      ? { kind: 'edit', cat: categories.find((c) => c.id === urlId) || null }
      : { kind: 'list' };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      const res = await api(`/api/ecom/categories?${params}`);
      setCategories(res.categories || []);
      // Backend returns the tenant's nesting cap so the UI can hide
      // "+ Subcategory" buttons + flag depth-violating moves.
      if (typeof res.categoryMaxDepth === 'number') setMaxDepthState(res.categoryMaxDepth);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [activeLocation]);

  useEffect(() => { load(); }, [load]);

  // Default-expand every parent that has children so the structure is
  // visible on first load. Re-runs only when the category set changes.
  useEffect(() => {
    if (!categories.length) return;
    const parentsWithKids = new Set(categories.filter((c) => c.parentId).map((c) => c.parentId));
    setExpanded(parentsWithKids);
  }, [categories.length]);

  const { tops, childrenOf, byId, rollupProducts } = useMemo(() => {
    const tops = categories.filter((c) => !c.parentId).sort(byDisplayOrder);
    const map = new Map();
    const idMap = new Map();
    for (const c of categories) idMap.set(c.id, c);
    for (const c of categories) {
      if (!c.parentId) continue;
      if (!map.has(c.parentId)) map.set(c.parentId, []);
      map.get(c.parentId).push(c);
    }
    map.forEach((arr) => arr.sort(byDisplayOrder));
    function rollupProducts(id) {
      const self = (idMap.get(id)?._count?.products) || 0;
      return (map.get(id) || []).reduce((sum, c) => sum + rollupProducts(c.id), self);
    }
    return { tops, childrenOf: (id) => map.get(id) || [], byId: idMap, rollupProducts };
  }, [categories]);

  function toggle(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function expandAll() {
    // Expand every node that has at least one child — works at any depth.
    setExpanded(new Set(categories.filter((c) => childrenOf(c.id).length).map((c) => c.id)));
  }
  function collapseAll() { setExpanded(new Set()); }

  // Recursive renderer — emits a CategoryRow for `cat` then (if expanded)
  // recurses into its children. Returns a flat array of <li> elements
  // suitable for the divide-y <ul> wrapper. Depth-aware: passes the
  // computed depth + canAddChild flag (true only when depth < maxDepth)
  // so the "+ Subcategory" button hides at the leaf level.
  function renderRow(cat, depth) {
    const kids = childrenOf(cat.id);
    const open = expanded.has(cat.id);
    const rows = [
      <CategoryRow key={cat.id}
        cat={cat}
        depth={depth}
        hasChildren={kids.length > 0}
        childCount={kids.length}
        productCount={rollupProducts(cat.id)}
        isExpanded={open}
        canAddChild={depth < maxDepth}
        onToggle={() => toggle(cat.id)}
        onEdit={() => goEdit(cat)}
        onDelete={() => remove(cat)}
        onAddChild={() => goCreate(cat.id)}
      />,
    ];
    if (open) {
      for (const child of kids) rows.push(...renderRow(child, depth + 1));
    }
    return rows;
  }

  async function create(payload) {
    setBusy(true);
    try {
      await api('/api/ecom/categories', { method: 'POST', body: JSON.stringify(payload) });
      await load();
      goList();
    } finally { setBusy(false); }
  }

  async function update(payload) {
    if (!mode.cat) return;
    setBusy(true);
    try {
      await api(`/api/ecom/categories/${mode.cat.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      await load();
      goList();
    } finally { setBusy(false); }
  }

  async function remove(cat) {
    const kids = childrenOf(cat.id).length;
    const msg = kids > 0
      ? `Delete "${cat.name}" and its ${kids} subcategor${kids === 1 ? 'y' : 'ies'}? Products will be uncategorised.`
      : `Delete "${cat.name}"? Products in this category will be uncategorised.`;
    if (!await confirm(msg, { confirmLabel: 'Delete', tone: 'danger' })) return;
    try {
      await api(`/api/ecom/categories/${cat.id}`, { method: 'DELETE' });
      await load();
    } catch (err) { alert(err.message); }
  }

  if (loading) return <div className="py-10 text-center text-sm text-gray-500">Loading categories…</div>;

  if (mode.kind === 'edit' && !mode.cat) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6 max-w-2xl mx-auto">
        <button type="button" onClick={goList}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
          <span aria-hidden>←</span> Back to categories
        </button>
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          This category no longer exists or is not available for the selected location. Return to the categories list to continue.
        </div>
      </div>
    );
  }

  if (mode.kind === 'create' || mode.kind === 'edit') {
    const presetParent = mode.kind === 'create' ? mode.presetParentId : null;
    const presetParentName = presetParent ? categories.find((c) => c.id === presetParent)?.name : null;
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6 max-w-2xl mx-auto">
        <button type="button" onClick={goList}
          className="inline-flex items-center gap-1.5 mb-4 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
          <span aria-hidden>←</span> Back to categories
        </button>
        <nav className="text-xs text-gray-500 mb-3 flex items-center gap-1">
          <button type="button" onClick={goList}
            className="text-indigo-600 hover:underline font-medium">Categories</button>
          <span className="text-gray-300">/</span>
          <span className="text-gray-700">
            {mode.kind === 'edit' ? mode.cat.name : presetParentName ? `New subcategory of ${presetParentName}` : 'New category'}
          </span>
        </nav>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          {mode.kind === 'edit' ? 'Edit category' : presetParentName ? `New subcategory of ${presetParentName}` : 'New category'}
        </h2>
        <p className="text-sm text-gray-500 mb-5">Group products together so customers can browse by section.</p>
        <CategoryForm
          initial={mode.kind === 'edit' ? mode.cat : null}
          presetParentId={presetParent}
          allCategories={categories}
          maxDepth={maxDepth}
          onSave={mode.kind === 'edit' ? update : create}
          onCancel={goList}
          busy={busy}
        />
      </div>
    );
  }

  const anyHasKids = tops.some((t) => childrenOf(t.id).length > 0);
  const allExpanded = anyHasKids && tops.every((t) => !childrenOf(t.id).length || expanded.has(t.id));

  // Bump the tenant's nesting cap. Phase E of the 3-level rollout —
  // exposed inline here (rather than buried in Settings) so sellers
  // discover it where they're already managing categories. Lowering
  // the cap never destroys data; deeper categories simply become
  // unreachable in the picker until the cap is raised again.
  async function setMaxDepth(next) {
    if (next < 1 || next > 5 || next === maxDepth) return;
    if (next < maxDepth) {
      const deeperCount = categories.filter((c) => {
        // Compute depth: walk parentId chain
        let d = 1; let cur = c;
        const byId = new Map(categories.map((x) => [x.id, x]));
        while (cur?.parentId && d < 32) { d += 1; cur = byId.get(cur.parentId); }
        return d > next;
      }).length;
      if (deeperCount > 0) {
        const ok = await confirm(
          `Lowering the cap to ${next} level${next === 1 ? '' : 's'} will hide ${deeperCount} categor${deeperCount === 1 ? 'y' : 'ies'} from your picker until you raise it again. Existing products stay assigned and storefront pages keep working. Continue?`,
          { confirmLabel: 'Lower cap', tone: 'danger' },
        );
        if (!ok) return;
      }
    }
    setBusy(true);
    try {
      await api('/api/business/settings', {
        method: 'PATCH',
        body: JSON.stringify({ categoryMaxDepth: next }),
      });
      setMaxDepthState(next);
    } catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Categories</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Group your products. {categories.length} of 200 used · {tops.length} top-level
            {anyHasKids && ` · ${categories.length - tops.length} subcategor${categories.length - tops.length === 1 ? 'y' : 'ies'}`}.
            {' '}<span className="text-[11px] font-mono uppercase tracking-wider text-indigo-700">{maxDepth}-level nesting</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {anyHasKids && (
            <button type="button" onClick={allExpanded ? collapseAll : expandAll}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          <button type="button" onClick={() => goCreate()}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
            + New category
          </button>
        </div>
      </div>

      {/* Nesting-depth control — segmented buttons. Sellers click 1/2/3
          to set how deep their tree can go. Pro / Business tier gate
          will live here in a future commit (right now any tenant can
          flip up to 3; reserved 4-5 for future tiers). */}
      <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-gray-700">Category nesting depth</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            How deep your category tree can go.{' '}
            <strong>1</strong> = flat list, <strong>2</strong> = parent + child (default),{' '}
            <strong>3</strong> = parent + child + sub-child (premium).
          </p>
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {[1, 2, 3].map((d) => (
            <button key={d} type="button" onClick={() => setMaxDepth(d)}
              disabled={busy}
              className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${
                maxDepth === d ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900'
              } disabled:opacity-50`}>
              {d} level{d === 1 ? '' : 's'}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{error}</div>}

      {categories.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-200 p-10 text-center">
          <p className="text-sm text-gray-500">No categories yet.</p>
          <p className="text-xs text-gray-400 mt-1">Create categories like "Produce", "Dairy", "Bakery" to group your products.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <ul className="divide-y divide-gray-100">
            {tops.flatMap((top) => renderRow(top, 1))}
          </ul>
        </div>
      )}
    </div>
  );
}

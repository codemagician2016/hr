'use client';

// Blog category CRUD. Mounts inside BlogPanel as the "Categories"
// sub-tab. Endpoints:
//   GET    /api/blog/categories                  (list with postCount)
//   POST   /api/blog/categories
//   PUT    /api/blog/categories/:id
//   DELETE /api/blog/categories/:id              (cascade SETs NULL on posts)

import { useEffect, useState } from 'react';
import { slugify as rawSlugify } from '@/lib/slugify';
import { useConfirm } from '@/components/ConfirmDialog';

// Category slugs cap at 60 chars (matches the backend route).
const slugify = (s) => rawSlugify(s, 60);

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
    throw err;
  }
  return body;
}


export default function BlogCategoriesTab() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null); // null | { id?, name, slug, sortOrder, slugTouched }
  const confirm = useConfirm();

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/blog/categories');
      setCategories(data.categories || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function startNew() {
    setDraft({ id: null, name: '', slug: '', sortOrder: categories.length, slugTouched: false });
  }
  function startEdit(cat) {
    setDraft({ id: cat.id, name: cat.name, slug: cat.slug, sortOrder: cat.sortOrder, slugTouched: true });
  }
  function setField(key, value) {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, [key]: value };
      if (key === 'name' && !d.slugTouched) next.slug = slugify(value);
      if (key === 'slug') { next.slugTouched = true; next.slug = slugify(value); }
      return next;
    });
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { setError('Name is required.'); return; }
    setError('');
    try {
      const payload = {
        name: draft.name.trim(),
        slug: draft.slug || slugify(draft.name),
        sortOrder: Number(draft.sortOrder) || 0,
      };
      if (draft.id) {
        await api(`/api/blog/categories/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/blog/categories', { method: 'POST', body: JSON.stringify(payload) });
      }
      setDraft(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(cat) {
    const msg = cat.postCount > 0
      ? `Delete "${cat.name}"? ${cat.postCount} post${cat.postCount === 1 ? ' will become' : 's will become'} uncategorised — they won't be deleted.`
      : `Delete "${cat.name}"?`;
    if (!await confirm(msg, { confirmLabel: 'Delete', tone: 'danger' })) return;
    try {
      await api(`/api/blog/categories/${cat.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Categories</h3>
          <p className="text-sm text-gray-500">
            Top-level groupings shown as filter chips on your public blog. Distinct from tags
            (which are searchable keywords on each post).
          </p>
        </div>
        {!draft && (
          <button
            type="button"
            onClick={startNew}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
          >+ New category</button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      {/* Inline editor for create/edit */}
      {draft && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">
              {draft.id ? 'Edit category' : 'New category'}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setDraft(null); setError(''); }}
                className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-white"
              >Cancel</button>
              <button
                type="button"
                onClick={save}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700"
              >{draft.id ? 'Save changes' : 'Create category'}</button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setField('name', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Slug</label>
              <input
                type="text"
                value={draft.slug}
                onChange={(e) => setField('slug', e.target.value)}
                placeholder="auto from name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white font-mono"
              />
              <p className="mt-1 text-xs text-gray-500">/blog?categorySlug={draft.slug || 'your-slug'}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Sort order</label>
              <input
                type="number"
                min={0}
                max={9999}
                value={draft.sortOrder}
                onChange={(e) => setField('sortOrder', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
              />
              <p className="mt-1 text-xs text-gray-500">Lower numbers show first.</p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : categories.length === 0 && !draft ? (
        <div className="text-center py-12 border border-dashed border-gray-300 rounded-2xl">
          <p className="text-3xl">🗂️</p>
          <p className="mt-3 text-sm font-medium text-gray-900">No categories yet</p>
          <p className="text-xs text-gray-500 mt-1">Create one to start organising your posts.</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-2xl overflow-hidden">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center gap-4 p-4 hover:bg-gray-50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900">{c.name}</p>
                <p className="text-xs text-gray-500">
                  /{c.slug} · {c.postCount} post{c.postCount === 1 ? '' : 's'} · sort #{c.sortOrder}
                </p>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => startEdit(c)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-white"
                >Edit</button>
                <button
                  type="button"
                  onClick={() => remove(c)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 text-red-700 hover:bg-red-50"
                >Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

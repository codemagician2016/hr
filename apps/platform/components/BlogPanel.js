'use client';

// Blog admin shell - sub-tabs:
//   Posts     — the existing post CRUD (this file's main contents)
//   Comments  — moderation queue (BlogCommentsTab)
//   Settings  — per-tenant policy / moderation knobs (BlogSettingsTab)
//   SEO       — search previews, sitemap, robots, and tracking tags
//
// Mounted from admin-shell.js when tab='blog'. All sub-tabs scoped to
// the caller's businessId via the existing JWT — no slug in the URL.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import BlogCommentsTab from '@/components/admin-tabs/BlogCommentsTab';
import BlogSettingsTab from '@/components/admin-tabs/BlogSettingsTab';
import BlogCategoriesTab from '@/components/admin-tabs/BlogCategoriesTab';
import SeoCenterPanel from '@/components/admin-tabs/SeoCenterPanel';
import RichTextEditor from '@/components/RichTextEditor';
import ImageEditorModal from '@/components/ImageEditorModal';
import { slugify } from '@/lib/slugify';
import { useConfirm } from '@/components/ConfirmDialog';
import AiGenerateButton from '@/components/AiGenerateButton';
import { useAiStatus } from '@/lib/useAiStatus';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Turn a generated outline { sections:[{heading, points:[]}] } into the HTML
// the TipTap editor understands — h2 headings + bullet lists.
function outlineToHtml(outline) {
  const sections = Array.isArray(outline?.sections) ? outline.sections : [];
  return sections.map((section) => {
    const heading = `<h2>${escapeHtml(section.heading)}</h2>`;
    const points = (Array.isArray(section.points) ? section.points : []).filter(Boolean);
    const list = points.length ? `<ul>${points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : '';
    return heading + list;
  }).join('');
}

const SUB_TABS = [
  { id: 'posts',      label: 'Posts' },
  { id: 'categories', label: 'Categories' },
  { id: 'comments',   label: 'Comments' },
  { id: 'seo',        label: 'SEO' },
  { id: 'settings',   label: 'Settings' },
];

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

function emptyDraft() {
  return {
    id: null,
    title: '',
    slug: '',
    slugTouched: false,
    excerpt: '',
    content: '',
    coverImageUrl: '',
    authorName: '',
    tagsCsv: '',
    categoryId: '',  // '' = uncategorised; controller normalises to null
    isPublished: false,
    metaTitle: '',
    metaDescription: '',
  };
}

function fromPost(p) {
  return {
    id: p.id,
    title: p.title || '',
    slug: p.slug || '',
    slugTouched: true,
    excerpt: p.excerpt || '',
    content: p.content || '',
    coverImageUrl: p.coverImageUrl || '',
    authorName: p.authorName || '',
    tagsCsv: p.tagsCsv || '',
    categoryId: p.categoryId || '',
    isPublished: !!p.isPublished,
    metaTitle: p.metaTitle || '',
    metaDescription: p.metaDescription || '',
  };
}

export default function BlogPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSection = searchParams.get('section') || 'posts';
  const subTab = SUB_TABS.some((tab) => tab.id === requestedSection) ? requestedSection : 'posts';
  const setSubTab = useCallback((nextSubTab) => {
    const safeSubTab = SUB_TABS.some((tab) => tab.id === nextSubTab) ? nextSubTab : 'posts';
    const params = new URLSearchParams(searchParams.toString());
    if (safeSubTab === 'posts') params.delete('section');
    else params.set('section', safeSubTab);
    params.delete('view');
    params.delete('id');
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);

  const setPostView = useCallback((nextView, postId = '') => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('id');
    if (nextView === 'blog-create') {
      params.set('view', 'blog-create');
    } else if (nextView === 'blog-edit' && postId) {
      params.set('view', 'blog-edit');
      params.set('id', postId);
    } else {
      params.delete('view');
    }
    if (params.get('section') && params.get('section') !== 'posts') params.set('section', 'posts');
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);

  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1">
        {SUB_TABS.map((t) => {
          const active = t.id === subTab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`px-4 py-1.5 text-sm font-semibold rounded-lg transition-colors ${
                active ? 'bg-gray-900 text-white' : 'text-gray-600 hover:text-gray-900'
              }`}
            >{t.label}</button>
          );
        })}
      </div>

      {subTab === 'posts' && (
        <BlogPostsTab
          routeView={searchParams.get('view') || ''}
          routeId={searchParams.get('id') || ''}
          setPostView={setPostView}
        />
      )}
      {subTab === 'categories' && <BlogCategoriesTab />}
      {subTab === 'comments' && <BlogCommentsTab />}
      {subTab === 'seo' && <SeoCenterPanel />}
      {subTab === 'settings' && <BlogSettingsTab />}
    </div>
  );
}

function BlogPostsTab({ routeView, routeId, setPostView }) {
  const [posts, setPosts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const confirm = useConfirm();
  const { available: aiAvailable } = useAiStatus();

  async function load() {
    setLoading(true);
    setError('');
    try {
      // Categories powers the dropdown in the editor — fetched alongside
      // posts so opening the editor never has to wait. Failure here isn't
      // fatal: the dropdown shows "(none)" and the post saves uncategorised.
      const [postsData, catsData] = await Promise.all([
        api('/api/blog'),
        api('/api/blog/categories').catch(() => ({ categories: [] })),
      ]);
      setPosts(postsData.posts || []);
      setCategories(catsData.categories || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return posts;
    const q = search.toLowerCase();
    return posts.filter((p) => (p.title || '').toLowerCase().includes(q) || (p.tagsCsv || '').toLowerCase().includes(q));
  }, [posts, search]);

  const closeDraft = useCallback(() => {
    setPostView(null);
  }, [setPostView]);

  function startNew() {
    setPostView('blog-create');
  }
  async function loadDraftForPost(post) {
    setDraft({ ...fromPost(post), content: '__loading__' });
    try {
      const full = await api(`/api/blog/${post.id}`);
      setDraft((prev) => prev && prev.id === post.id ? { ...fromPost(full), id: full.id } : prev);
    } catch (err) {
      setError(err.message);
      setDraft(null);
    }
  }
  function cancel() {
    closeDraft();
  }

  useEffect(() => {
    if (routeView === 'blog-create') {
      setDraft((current) => current?.id ? emptyDraft() : (current || emptyDraft()));
      return;
    }
    if (routeView === 'blog-edit' && routeId) {
      const post = posts.find((item) => item.id === routeId);
      if (post && draft?.id !== routeId) loadDraftForPost(post);
      if (!post && !loading) setDraft(null);
      return;
    }
    setDraft(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, loading, posts, routeId, routeView]);

  function setField(key, value) {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, [key]: value };
      if (key === 'title' && !d.slugTouched) {
        next.slug = slugify(value);
      }
      if (key === 'slug') {
        next.slugTouched = true;
        next.slug = slugify(value);
      }
      return next;
    });
  }

  async function save() {
    if (!draft) return;
    if (!draft.title.trim()) { setError('Title is required'); return; }
    if (!draft.content.trim() || draft.content === '__loading__') { setError('Content is required'); return; }
    setSaving(true);
    setError('');
    try {
      const payload = {
        title: draft.title.trim(),
        slug: draft.slug || slugify(draft.title),
        excerpt: draft.excerpt.trim() || undefined,
        content: draft.content,
        coverImageUrl: draft.coverImageUrl.trim() || null,
        authorName: draft.authorName.trim() || undefined,
        tagsCsv: draft.tagsCsv.trim() || undefined,
        categoryId: draft.categoryId || '',
        isPublished: !!draft.isPublished,
        metaTitle: draft.metaTitle.trim() || undefined,
        metaDescription: draft.metaDescription.trim() || undefined,
      };
      if (draft.id) {
        await api(`/api/blog/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/blog', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeDraft();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish(post) {
    try {
      await api(`/api/blog/${post.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isPublished: !post.isPublished }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(post) {
    if (!await confirm(`Delete "${post.title}"? This can't be undone.`, { confirmLabel: 'Delete', tone: 'danger' })) return;
    try {
      await api(`/api/blog/${post.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (draft) {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">
            {draft.id ? 'Edit post' : 'New post'}
          </h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={cancel}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50"
            >Cancel</button>
            <button
              type="button"
              onClick={save}
              disabled={saving || draft.content === '__loading__'}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:bg-indigo-300"
            >{saving ? 'Saving…' : (draft.id ? 'Save changes' : 'Create post')}</button>
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Title *</label>
              <input
                type="text"
                value={draft.title}
                onChange={(e) => setField('title', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">URL slug</label>
              <input
                type="text"
                value={draft.slug}
                onChange={(e) => setField('slug', e.target.value)}
                placeholder="auto from title"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
              />
              <p className="mt-1 text-xs text-gray-500">/blog/{draft.slug || 'your-post'}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Excerpt <span className="text-gray-400 font-normal">({draft.excerpt.length}/500)</span>
              </label>
              <textarea
                rows={2}
                maxLength={500}
                value={draft.excerpt}
                onChange={(e) => setField('excerpt', e.target.value)}
                placeholder="One-line summary shown on the blog index + meta description fallback."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="block text-xs font-medium text-gray-700">Content *</label>
                <AiGenerateButton
                  available={aiAvailable}
                  type="blog_outline"
                  label="Generate outline with AI"
                  disabledReason={draft.title.trim() ? '' : 'Enter a title first (used as the topic)'}
                  getInput={() => ({
                    topic: draft.title.trim(),
                    keywords: (draft.tagsCsv || '').split(',').map((s) => s.trim()).filter(Boolean),
                  })}
                  onResult={(r) => {
                    const html = outlineToHtml(r);
                    if (!html) return;
                    const base = draft.content && draft.content !== '__loading__' ? draft.content : '';
                    setField('content', base ? `${base}${html}` : html);
                    if (r?.metaDescription && !draft.metaDescription.trim()) setField('metaDescription', r.metaDescription);
                  }}
                />
              </div>
              {draft.content === '__loading__' ? (
                <div className="border border-gray-300 rounded-lg bg-gray-50 px-3 py-3 text-sm text-gray-400" style={{ minHeight: 360 }}>
                  Loading…
                </div>
              ) : (
                <RichTextEditor
                  value={draft.content}
                  onChange={(html) => setField('content', html)}
                  placeholder="Write your post here. Use the toolbar to format — bold, italic, headings, lists, links."
                  minHeight={360}
                />
              )}
              <p className="mt-1 text-xs text-gray-500">
                Output is HTML. Existing Markdown posts continue to render — the storefront detects format automatically.
              </p>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-xl border border-gray-200 p-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isPublished}
                  onChange={(e) => setField('isPublished', e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="font-medium">Published</span>
              </label>
              <p className="mt-1 text-xs text-gray-500">
                {draft.isPublished
                  ? 'Visible on the public blog index.'
                  : 'Saved as a draft — only visible to you.'}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Cover image</label>
              <CoverImageField
                value={draft.coverImageUrl}
                onChange={(v) => setField('coverImageUrl', v)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Author name</label>
              <input
                type="text"
                value={draft.authorName}
                onChange={(e) => setField('authorName', e.target.value)}
                placeholder="Your name (optional)"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
              <select
                value={draft.categoryId || ''}
                onChange={(e) => setField('categoryId', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
              >
                <option value="">— uncategorised —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                Top-level grouping. Manage categories under the Categories sub-tab.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Tags</label>
              <input
                type="text"
                value={draft.tagsCsv}
                onChange={(e) => setField('tagsCsv', e.target.value)}
                placeholder="tip, recipe, news"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-gray-500">Comma-separated keywords (different from category).</p>
            </div>

            <div className="rounded-xl border border-gray-200 p-4 space-y-3">
              <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">SEO overrides</p>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Meta title <span className="text-gray-400 font-normal">({draft.metaTitle.length}/70)</span>
                </label>
                <input
                  type="text"
                  maxLength={70}
                  value={draft.metaTitle}
                  onChange={(e) => setField('metaTitle', e.target.value)}
                  placeholder="Falls back to the title"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Meta description <span className="text-gray-400 font-normal">({draft.metaDescription.length}/160)</span>
                </label>
                <textarea
                  rows={2}
                  maxLength={160}
                  value={draft.metaDescription}
                  onChange={(e) => setField('metaDescription', e.target.value)}
                  placeholder="Falls back to the excerpt"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Blog</h2>
          <p className="text-sm text-gray-500">Write articles for your storefront. Published posts appear at /blog.</p>
        </div>
        <button
          type="button"
          onClick={startNew}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
        >+ New post</button>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by title or tag…"
        className="mb-4 w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-gray-300 rounded-2xl">
          <p className="text-3xl">📝</p>
          <p className="mt-3 text-sm font-medium text-gray-900">No posts yet</p>
          <p className="text-xs text-gray-500 mt-1">Click + New post to write your first article.</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-2xl overflow-hidden">
          {filtered.map((p) => (
            <li key={p.id} className="flex items-center gap-4 p-4 hover:bg-gray-50">
              {p.coverImageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={p.coverImageUrl} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0 border border-gray-200" />
              ) : (
                <div className="w-14 h-14 rounded-lg bg-gray-100 flex items-center justify-center text-2xl flex-shrink-0">📝</div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-gray-900 truncate">{p.title}</p>
                  {p.isPublished
                    ? <span className="text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">Published</span>
                    : <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">Draft</span>}
                </div>
                <p className="text-xs text-gray-500 truncate">/blog/{p.slug}</p>
                {p.tagsCsv && <p className="text-xs text-gray-400 mt-0.5">{p.tagsCsv}</p>}
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => togglePublish(p)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-white"
                  title={p.isPublished ? 'Unpublish' : 'Publish'}
                >{p.isPublished ? 'Unpublish' : 'Publish'}</button>
                <button
                  type="button"
                  onClick={() => setPostView('blog-edit', p.id)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-white"
                >Edit</button>
                <button
                  type="button"
                  onClick={() => remove(p)}
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

// Cover image field — opens the shared ImageEditorModal so admins can
// crop / zoom / rotate before saving. Re-clicking the thumbnail opens
// the modal preloaded with the existing URL.
function CoverImageField({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-2">
      {value ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="block w-full overflow-hidden rounded-lg border border-gray-200 hover:border-indigo-400"
          title="Click to edit"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="" className="block h-48 w-full object-cover" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex h-32 w-full items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-sm font-medium text-gray-600 hover:border-indigo-400 hover:bg-indigo-50/40"
        >
          + Add cover image
        </button>
      )}
      {value && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Edit cover
          </button>
          <button
            type="button"
            onClick={() => onChange('')}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
          >
            Remove
          </button>
        </div>
      )}
      {editing && (
        <ImageEditorModal
          value={value}
          scope="blog-cover"
          frameAspect={16 / 9}
          onSave={(url) => onChange(url)}
          onClose={() => setEditing(false)}
          title="Edit cover image"
        />
      )}
    </div>
  );
}

'use client';

// Storefront legal policies — owner authors named policies (Privacy, Terms,
// Refund, …) with a rich-text editor. Each can show in the storefront footer
// and/or be required for acceptance at customer signup.
// Backend: /api/ecom/policies (CRUD).

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import RichTextEditor from '@/components/RichTextEditor';

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

const STARTERS = [
  { title: 'Privacy Policy', hint: 'How you collect, use and protect customer data.' },
  { title: 'Terms of Service', hint: 'The rules customers agree to when they shop.' },
  { title: 'Refund & Returns Policy', hint: 'When and how customers can return or get refunded.' },
  { title: 'Shipping & Delivery Policy', hint: 'Areas, times and costs for delivery.' },
];

function slugifyTitle(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button
        type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${checked ? 'bg-emerald-600' : 'bg-gray-300'}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">{label}</span>
        {hint && <span className="block text-xs text-gray-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

function PolicyEditor({ initial, onSaved, onCancel }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [content, setContent] = useState(initial?.content || '');
  const [showInFooter, setShowInFooter] = useState(initial?.showInFooter ?? true);
  const [showAtSignup, setShowAtSignup] = useState(initial?.showAtSignup ?? false);
  const [isPublished, setIsPublished] = useState(initial?.isPublished ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!title.trim()) { setError('Give the policy a name'); return; }
    setBusy(true); setError('');
    try {
      const body = { title: title.trim(), content, showInFooter, showAtSignup, isPublished };
      if (initial?.id) await api(`/api/ecom/policies/${initial.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/ecom/policies', { method: 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5 max-w-3xl">
      <button type="button" onClick={onCancel}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
        <span aria-hidden>←</span> Back to policies
      </button>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Policy name</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120}
          placeholder="e.g. Privacy Policy"
          className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        <p className="text-[11px] text-gray-400 mt-1">This is the link text shown in your footer and at signup.</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Content</label>
        <RichTextEditor value={content} onChange={setContent} placeholder="Write the policy here…" minHeight={300} />
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-4">
        <p className="text-xs font-semibold text-gray-700">Where does this policy show?</p>
        <Toggle checked={isPublished} onChange={setIsPublished}
          label="Published" hint="Off = saved as a draft, hidden from customers everywhere." />
        <Toggle checked={showInFooter} onChange={setShowInFooter}
          label="Show in storefront footer" hint="Adds a link in the footer's “Legal” column on every page." />
        <Toggle checked={showAtSignup} onChange={setShowAtSignup}
          label="Require acceptance at signup" hint="Customers must tick “I accept” (with a link to this policy) to create an account." />
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700">Cancel</button>
        <button type="button" onClick={save} disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? 'Saving…' : initial?.id ? 'Save policy' : 'Create policy'}
        </button>
      </div>
    </div>
  );
}

export default function PoliciesPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Sub-view lives in the URL (?view=new|edit & ?id=) — same pattern as
  // Products/Categories. Because admin-shell's setTab strips ?view/?id, simply
  // clicking "Policies" in the sidebar again (or the editor's Back button)
  // returns to the list; a refresh/deep-link also restores context.
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = searchParams.get('view') || '';
  const urlId = searchParams.get('id') || '';

  const goList = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete('view'); p.delete('id');
    router.replace(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);
  const goNew = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.set('view', 'new'); p.delete('id');
    router.push(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);
  const goEdit = useCallback((policy) => {
    const p = new URLSearchParams(searchParams.toString());
    p.set('view', 'edit'); p.set('id', policy.id);
    router.push(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api('/api/ecom/policies');
      setRows(data.rows || []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Self-heal stale sub-view if the address bar was cleaned (e.g. tab switch)
  // but useSearchParams lagged — mirrors ProductsPanel.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const live = new URLSearchParams(window.location.search);
    if (!live.get('view') && !live.get('id') && (view || urlId)) goList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(p) {
    if (!window.confirm(`Delete “${p.title}”? Any footer/signup links to it will disappear.`)) return;
    try { await api(`/api/ecom/policies/${p.id}`, { method: 'DELETE' }); reload(); }
    catch (err) { setError(err.message); }
  }

  async function quickCreate(title) {
    try {
      setError('');
      const created = await api('/api/ecom/policies', { method: 'POST', body: JSON.stringify({ title, content: '', isPublished: false }) });
      setRows((current) => current.some((p) => p.id === created.id) ? current : [...current, created]);
      goEdit(created);
      reload();
    }
    catch (err) { setError(err.message); }
  }

  if (view === 'new' || view === 'edit') {
    const editingPolicy = view === 'edit' ? rows.find((r) => r.id === urlId) : null;
    if (view === 'edit' && !editingPolicy) {
      if (loading) {
        // Deep-link to ?view=edit&id=… before the list has loaded: show a thin
        // loading row rather than flashing back to the list.
        return <div className="py-10 text-center text-sm text-gray-500">Loading policy…</div>;
      }
      return (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 max-w-3xl">
          <button type="button" onClick={goList}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
            <span aria-hidden>←</span> Back to policies
          </button>
          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            This policy no longer exists or is not available in this store. Return to the policies list to continue.
          </div>
        </div>
      );
    }
    return (
      <PolicyEditor
        key={editingPolicy?.id || 'new'}
        initial={editingPolicy}
        onCancel={goList}
        onSaved={() => { goList(); reload(); }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Policies</h2>
          <p className="text-sm text-gray-500 mt-1">
            Privacy, terms, refunds and more — written by you, shown in your storefront footer and at customer signup.
          </p>
        </div>
        <button type="button" onClick={goNew}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">+ New policy</button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">Loading…</div>
      ) : rows.length > 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
          {rows.map((p) => (
            <div key={p.id} className="p-4 flex items-start justify-between gap-4">
              <button type="button" onClick={() => goEdit(p)} className="text-left min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-gray-900">{p.title}</p>
                  {!p.isPublished && <Badge tone="gray">Draft</Badge>}
                  {p.showInFooter && <Badge tone="emerald">Footer</Badge>}
                  {p.showAtSignup && <Badge tone="indigo">Signup</Badge>}
                </div>
                <p className="text-[11px] font-mono text-gray-400 mt-1">/policy/{p.slug}</p>
              </button>
              <div className="flex items-center gap-3 shrink-0">
                <button type="button" onClick={() => goEdit(p)} className="text-xs font-semibold text-indigo-700 hover:underline">Edit</button>
                <button type="button" onClick={() => remove(p)} className="text-xs font-semibold text-red-700 hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <p className="text-sm font-semibold text-gray-900">No policies yet</p>
          <p className="text-sm text-gray-500 mt-1">Start with a common one — we’ll create a draft you can fill in:</p>
        </div>
      )}

      {!loading && (
        <StarterPolicies
          rows={rows}
          onCreate={quickCreate}
          onEdit={goEdit}
        />
      )}
    </div>
  );
}

function StarterPolicies({ rows, onCreate, onEdit }) {
  const findExisting = (starter) => {
    const starterSlug = slugifyTitle(starter.title);
    const starterTitle = starter.title.toLowerCase();
    return rows.find((p) => (
      String(p.slug || '') === starterSlug
      || String(p.title || '').toLowerCase() === starterTitle
    ));
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-8">
      <p className="text-sm font-semibold text-gray-900">Common policy templates</p>
      <p className="text-sm text-gray-500 mt-1">Create or reopen the standard policies from here anytime.</p>
      <div className="mt-4 grid sm:grid-cols-2 gap-3">
        {STARTERS.map((s) => {
          const existing = findExisting(s);
          return (
            <button key={s.title} type="button" onClick={() => existing ? onEdit(existing) : onCreate(s.title)}
              className={`text-left p-4 rounded-xl border transition-colors ${
                existing
                  ? 'border-emerald-200 bg-emerald-50/60 hover:border-emerald-300'
                  : 'border-gray-200 hover:border-indigo-300 hover:bg-indigo-50/40'
              }`}>
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-gray-900">{s.title}</p>
                {existing && <Badge tone={existing.isPublished ? 'emerald' : 'gray'}>{existing.isPublished ? 'Created' : 'Draft'}</Badge>}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{s.hint}</p>
              <p className={`mt-2 text-xs font-semibold ${existing ? 'text-emerald-700' : 'text-indigo-700'}`}>
                {existing ? 'Open policy' : 'Create draft'}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Badge({ tone, children }) {
  const cls = {
    gray: 'bg-gray-100 text-gray-600 border-gray-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  }[tone] || 'bg-gray-100 text-gray-600 border-gray-200';
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}>{children}</span>;
}

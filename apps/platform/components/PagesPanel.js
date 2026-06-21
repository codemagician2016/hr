'use client';

// Sprint 3.3 — Pages CMS v2 admin UI. Three-view shell:
//   1. List view (default) — stat cards + filter tabs + searchable table
//   2. Block editor — Variation B's block-toggle bar + left rail + canvas
//   3. Nav manager — tree on left, live nav preview on right
//
// Add Page is a 3-step wizard modal (Variation B) launched from list view.
// Legacy template pages (info-page / service-detail / team-bio) keep
// rendering through the legacy form so old data stays editable.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ImageEditorModal from '@/components/ImageEditorModal';
import RichTextEditor from '@/components/RichTextEditor';
import { slugify } from '@/lib/slugify';
import { useConfirm } from '@/components/ConfirmDialog';
import { useTenant } from '@/components/TenantProvider';
import { resolveVertical } from '@/lib/vertical';

/* ────────────────────────────────────────────────────────────────────
   API helper + slug helper
   ──────────────────────────────────────────────────────────────────── */

async function apiCall(path, init = {}) {
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


/* ────────────────────────────────────────────────────────────────────
   Constants — system pages, placement options, block templates
   ──────────────────────────────────────────────────────────────────── */

// System pages that exist as homepage sections (not real BusinessPage rows
// today). They show in the list as "Built-in" + are reorderable in the
// nav manager. v1 = visibility toggle only; full editability is a v2 lift.
const SYSTEM_PAGES = [
  { key: 'home',     title: 'Home',     iconKey: 'home',     slug: '/' },
  { key: 'services', title: 'Services', iconKey: 'spark',    slug: '/services' },
  { key: 'about',    title: 'About',    iconKey: 'info',     slug: '/about' },
  { key: 'team',     title: 'Team',     iconKey: 'users',    slug: '/team' },
  { key: 'pricing',  title: 'Pricing',  iconKey: 'card',     slug: '/pricing' },
  { key: 'blog',     title: 'Blog',     iconKey: 'edit-doc', slug: '/blog' },
  { key: 'contact',  title: 'Contact',  iconKey: 'mail',     slug: '/contact' },
];

const PLACEMENT_OPTIONS = [
  { id: 'TOP',      label: 'Top navigation',  desc: 'New menu item alongside Home, Services, etc.', icon: '☰' },
  { id: 'DROPDOWN', label: 'Inside a dropdown', desc: 'Nested under an existing nav item', icon: '▾' },
  { id: 'FOOTER',   label: 'Footer only',     desc: 'Linked from footer, hidden from main nav', icon: '⌐' },
  { id: 'HIDDEN',   label: 'Hidden / direct link', desc: 'Accessible by URL only, not linked anywhere', icon: '⊘' },
];

const PAGE_LAYOUTS = [
  {
    id: 'service-premium',
    name: 'Premium service',
    desc: 'Conversion-led service page with strong hero, proof, process, and CTA.',
    bestFor: 'Services, offers, compliance pages',
  },
  {
    id: 'editorial',
    name: 'Editorial',
    desc: 'Readable long-form page with generous typography and clean section rhythm.',
    bestFor: 'About, guides, resources',
  },
  {
    id: 'visual-story',
    name: 'Visual story',
    desc: 'Media-forward structure for pages that need images to carry trust.',
    bestFor: 'Portfolio, venue, gallery pages',
  },
  {
    id: 'resource-hub',
    name: 'Resource hub',
    desc: 'Card-based layout for links, FAQs, documents, and next-step navigation.',
    bestFor: 'Help centers, document hubs',
  },
  {
    id: 'document',
    name: 'Document',
    desc: 'Focused, text-first layout for policy and legal information.',
    bestFor: 'Privacy, terms, policies',
  },
];

function defaultLayoutPreset({ templateId, parentNav, placement } = {}) {
  if (templateId === 'legal' || placement === 'FOOTER') return 'document';
  if (templateId === 'info') return 'editorial';
  if (templateId === 'blank') return 'editorial';
  if (parentNav === 'about') return 'editorial';
  return 'service-premium';
}

const TEMPLATE_PRESETS = [
  {
    id: 'service',
    name: 'Service detail',
    desc: 'Hero + overview + process + links + CTA',
    layoutPreset: 'service-premium',
    blocks: () => [
      { id: makeId('header'),   type: 'header',   enabled: true, props: { eyebrow: 'Service brief', title: 'New service', subtitle: 'Explain who this is for, what is included, and the outcome visitors can expect.', primaryCtaText: 'Request consultation', primaryCtaLink: '/pages/info/contact' } },
      { id: makeId('richtext'), type: 'richtext', enabled: true, props: { heading: 'Overview', body: 'Use this section for the main explanation. Cover the problem, eligibility, required information, timeline, and what happens after the visitor enquires.' } },
      { id: makeId('features'), type: 'features', enabled: true, props: { heading: 'Why choose this service', intro: 'Highlight the value in plain language.', columns: 3, items: [{ title: 'Clear requirements', desc: 'Tell visitors what you need from them before work starts.' }, { title: 'Managed workflow', desc: 'Show how you reduce confusion and handle the moving parts.' }, { title: 'Final outcome', desc: 'Describe the deliverable, filing, report, booking, or next step.' }] } },
      { id: makeId('steps'),    type: 'steps',    enabled: true, props: { heading: 'How it works', items: [{ title: 'Review', desc: 'Confirm the scope and collect the required details.' }, { title: 'Prepare', desc: 'Complete the work, draft, filing, booking, or plan.' }, { title: 'Deliver', desc: 'Share the result and next-step guidance.' }] } },
      { id: makeId('linklist'), type: 'linklist', enabled: true, props: { heading: 'Useful links', intro: 'Add related pages, documents, forms, or external resources.', links: [{ label: 'Contact us', href: '/pages/info/contact', desc: 'Ask a question before you begin.' }] } },
      { id: makeId('cta'),      type: 'cta',      enabled: true, props: { heading: 'Ready to get started?', body: 'Send a short brief and the team will guide the next step.', buttonText: 'Request consultation', buttonLink: '/pages/info/contact', style: 'primary', background: 'solid' } },
    ],
  },
  {
    id: 'info',
    name: 'Info page',
    desc: 'Header + rich text + CTA',
    layoutPreset: 'editorial',
    blocks: () => [
      { id: makeId('header'),   type: 'header',   enabled: true, props: { eyebrow: 'Guide', title: 'About', subtitle: 'A line that summarises the page' } },
      { id: makeId('richtext'), type: 'richtext', enabled: true, props: { heading: 'Main content', body: 'Tell your story here. Replace this placeholder with your own copy.' } },
      { id: makeId('faq'),      type: 'faq',      enabled: true, props: { heading: 'Common questions', items: [{ q: 'What should visitors know first?', a: 'Replace this with a helpful answer.' }] } },
      { id: makeId('cta'),      type: 'cta',      enabled: true, props: { heading: 'Get in touch', buttonText: 'Contact us', buttonLink: '/contact', style: 'outline', background: 'card' } },
    ],
  },
  {
    id: 'legal',
    name: 'Legal / policy',
    desc: 'Header + long-form text only',
    layoutPreset: 'document',
    blocks: () => [
      { id: makeId('header'),   type: 'header',   enabled: true, props: { title: 'Privacy Policy', subtitle: 'Last updated' } },
      { id: makeId('richtext'), type: 'richtext', enabled: true, props: { heading: '', body: 'Replace this with your full policy text.' } },
    ],
  },
  {
    id: 'blank',
    name: 'Blank page',
    desc: 'Start empty, add blocks one by one',
    layoutPreset: 'editorial',
    blocks: () => [
      { id: makeId('header'), type: 'header', enabled: true, props: { title: 'Untitled page', subtitle: '' } },
    ],
  },
];

let _idCounter = 0;
function makeId(prefix) {
  _idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_idCounter}`;
}

const BLOCK_LIBRARY = [
  { id: 'header',    name: 'Page header',  desc: 'Title + subtitle + breadcrumb' },
  { id: 'richtext',  name: 'Rich text',    desc: 'Long-form content with headings' },
  { id: 'imagetext', name: 'Image + Text', desc: '50/50 split, image left or right' },
  { id: 'features',  name: 'Feature grid', desc: '2/3/4 column cards' },
  { id: 'steps',     name: 'Process steps', desc: 'Timeline for how the work happens' },
  { id: 'gallery',   name: 'Image gallery', desc: 'Upload multiple images with captions' },
  { id: 'linklist',  name: 'Link cards',    desc: 'Documents, related pages, external links' },
  { id: 'faq',       name: 'FAQ',           desc: 'Questions and answers' },
  { id: 'cta',       name: 'CTA strip',    desc: 'Heading + button' },
];

const RICH_TEXT_HTML_PATTERN = /<\/?(p|h[1-6]|ul|ol|li|blockquote|strong|em|a|br|div|span)\b/i;

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function richTextToHtml(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (RICH_TEXT_HTML_PATTERN.test(raw)) return raw;
  return raw
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

function richTextSummary(value = '') {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const RICH_TEXT_RENDER_CLASS = [
  'text-[15px] leading-7 text-gray-700',
  '[&_p]:mb-4 [&_p:last-child]:mb-0',
  '[&_h2]:mb-3 [&_h2]:mt-7 [&_h2:first-child]:mt-0 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-gray-950',
  '[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-gray-900',
  '[&_ul]:mb-4 [&_ul]:ml-5 [&_ul]:list-disc [&_ol]:mb-4 [&_ol]:ml-5 [&_ol]:list-decimal [&_li]:mb-1.5',
  '[&_a]:font-medium [&_a]:text-indigo-700 [&_a]:underline',
  '[&_blockquote]:my-5 [&_blockquote]:border-l-4 [&_blockquote]:border-indigo-200 [&_blockquote]:pl-4 [&_blockquote]:text-gray-600',
].join(' ');

/* ────────────────────────────────────────────────────────────────────
   Top-level shell — routes between list / editor / nav-manager
   ──────────────────────────────────────────────────────────────────── */

export default function PagesPanel({ businessSlug }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { tenant } = useTenant();
  const isEcommerce = resolveVertical(tenant?.business?.vertical) === 'ECOMMERCE';
  const urlView = searchParams.get('view') || '';
  const urlId = searchParams.get('id') || '';
  const view = urlView === 'page-editor' && urlId ? { name: 'editor', pageId: urlId } : { name: 'list' };
  const showAddWizard = urlView === 'page-create';
  const showNavManager = !isEcommerce && urlView === 'page-nav';
  const [pages, setPages] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [parentNavs, setParentNavs] = useState([]);
  const [siteNav, setSiteNav] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const confirm = useConfirm();

  const [presets, setPresets] = useState([]);
  const setPageView = useCallback((nextView, options = {}) => {
    const next = nextView || { name: 'list' };
    const params = new URLSearchParams(searchParams.toString());
    params.delete('id');
    params.delete('parent');
    params.delete('section');
    if (next.name === 'editor' && next.pageId) {
      params.set('view', 'page-editor');
      params.set('id', next.pageId);
    } else if (next.name === 'create') {
      params.set('view', 'page-create');
    } else if (next.name === 'nav' && !isEcommerce) {
      params.set('view', 'page-nav');
    } else {
      params.delete('view');
    }
    const href = params.toString() ? `?${params.toString()}` : '?';
    if (options.replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }, [isEcommerce, router, searchParams]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [pagesRes, navRes, presetsRes] = await Promise.all([
        apiCall('/api/business/pages'),
        apiCall('/api/business/site-nav').catch(() => ({ siteNav: null })),
        apiCall('/api/business/page-presets').catch(() => ({ presets: [] })),
      ]);
      setPages(pagesRes.pages || []);
      setTemplates(pagesRes.templates || []);
      setParentNavs(pagesRes.parentNavs || []);
      setSiteNav(navRes.siteNav || null);
      setPresets(presetsRes.presets || []);
    } catch (e) {
      setError(e.message || 'Failed to load pages');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">Loading pages…</div>
    );
  }
  if (error) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-red-600">{error}</p>
        <button onClick={reload} className="mt-3 text-xs font-medium text-indigo-600 hover:underline">Retry</button>
      </div>
    );
  }

  if (view.name === 'editor') {
    const page = pages.find((p) => p.id === view.pageId);
    if (!page) {
      return <div className="p-6 text-sm text-gray-500">Page not found. <button onClick={() => setPageView({ name: 'list' }, { replace: true })} className="text-indigo-600 hover:underline">Back</button></div>;
    }
    if (page.templateKey === 'block-page') {
      return (
        <BlockPageEditor
          page={page}
          businessSlug={businessSlug}
          onBack={() => { setPageView({ name: 'list' }, { replace: true }); reload(); }}
        />
      );
    }
    return (
      <LegacyPageEditor
        page={page}
        templates={templates}
        parentNavs={parentNavs}
        onBack={() => { setPageView({ name: 'list' }, { replace: true }); reload(); }}
      />
    );
  }

  return (
    <div>
      <PagesListView
        pages={pages}
        siteNav={siteNav}
        presets={presets}
        isEcommerce={isEcommerce}
        onAddPage={() => setPageView({ name: 'create' })}
        onOpenNavManager={() => setPageView({ name: 'nav' })}
        onEditPage={(p) => setPageView({ name: 'editor', pageId: p.id })}
        onAddPreset={async (preset) => {
          try {
            const res = await apiCall('/api/business/pages/from-preset', {
              method: 'POST',
              body: JSON.stringify({ presetId: preset.id }),
            });
            await reload();
            // Jump straight into the editor for the new draft so the
            // admin can replace placeholder copy before publishing.
            if (res?.page?.id) setPageView({ name: 'editor', pageId: res.page.id }, { replace: true });
          } catch (e) {
            alert(e.message || 'Failed to add preset');
          }
        }}
        onTogglePublish={async (p) => {
          await apiCall(`/api/business/pages/${p.id}/publish`, { method: 'PUT', body: JSON.stringify({ isPublished: !p.isPublished }) });
          reload();
        }}
        onDeletePage={async (p) => {
          if (!await confirm(`Delete "${p.title}"? This cannot be undone.`, { confirmLabel: 'Delete', tone: 'danger' })) return;
          await apiCall(`/api/business/pages/${p.id}`, { method: 'DELETE' });
          reload();
        }}
      />
      {showAddWizard && (
        <AddPageWizard
          businessSlug={businessSlug}
          isEcommerce={isEcommerce}
          onClose={() => setPageView({ name: 'list' }, { replace: true })}
          onCreated={(newPage) => {
            reload();
            // Jump straight into editor for block-page; legacy goes back to list
            if (newPage?.templateKey === 'block-page') {
              setPageView({ name: 'editor', pageId: newPage.id }, { replace: true });
            } else {
              setPageView({ name: 'list' }, { replace: true });
            }
          }}
        />
      )}
      {showNavManager && (
        <NavManagerModal
          pages={pages}
          siteNav={siteNav}
          onClose={() => setPageView({ name: 'list' }, { replace: true })}
          onSaved={(next) => { setSiteNav(next); setPageView({ name: 'list' }, { replace: true }); }}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   List view — stat cards + filter tabs + table
   ──────────────────────────────────────────────────────────────────── */

function PagesListView({ pages, siteNav, presets, isEcommerce, onAddPage, onOpenNavManager, onEditPage, onAddPreset, onTogglePublish, onDeletePage }) {
  const [filter, setFilter] = useState('all'); // all / system / custom / drafts
  const [search, setSearch] = useState('');

  // Build the "system pages" rows from the constants — they're synthetic
  // (not in the DB) so the UI shows admins the full nav but only allows
  // them to act on real BusinessPage rows. Clicking a built-in jumps to
  // the Website tab so admins can edit that section in the existing
  // Website Editor.
  const systemRows = isEcommerce ? [] : SYSTEM_PAGES.map((s) => ({
    id: `system:${s.key}`,
    systemKey: s.key,
    title: s.title,
    slug: s.slug,
    type: 'system',
    isPublished: true,
    placement: 'TOP',
    iconKey: s.iconKey,
    parentNav: null,
    blockCount: '—',
    updated: 'Built-in',
  }));
  const customRows = pages.map((p) => ({
    ...p,
    type: 'custom',
    blockCount: p.templateKey === 'block-page' ? (p.content?.blocks?.length ?? 0) : '—',
    updated: p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '',
  }));
  // Custom pages first so the admin's own work surfaces above the
  // built-ins. Within each group we keep the existing order.
  const all = isEcommerce ? customRows : [...customRows, ...systemRows];
  const filtered = all.filter((p) => {
    if (filter === 'system' && p.type !== 'system') return false;
    if (filter === 'custom' && p.type !== 'custom') return false;
    if (filter === 'drafts' && (p.type === 'system' || p.isPublished)) return false;
    if (search && !p.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    all: all.length,
    system: systemRows.length,
    custom: customRows.length,
    drafts: customRows.filter((p) => !p.isPublished).length,
    inDropdown: customRows.filter((p) => p.placement === 'DROPDOWN').length,
    live: customRows.filter((p) => p.isPublished).length,
  };

  const placementLabel = (p) => {
    if (p.type === 'system') return { text: 'Top nav', tone: 'purple' };
    switch (p.placement) {
      case 'TOP':      return { text: 'Top nav', tone: 'purple' };
      case 'DROPDOWN': {
        const sysParent = SYSTEM_PAGES.find((s) => s.key === p.parentNav);
        return { text: sysParent ? `Under ${sysParent.title}` : `Under ${p.parentNav || '—'}`, tone: 'gray' };
      }
      case 'FOOTER':   return { text: 'Footer', tone: 'gray' };
      case 'HIDDEN':   return { text: 'Hidden', tone: 'amber' };
      default:         return { text: '—', tone: 'gray' };
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Pages</h2>
          <p className="mt-1 text-sm text-gray-500">
            {isEcommerce
              ? 'Manage policy, help, and legal pages for your grocery storefront footer and SEO.'
              : 'Manage every page on your website. Add custom pages and choose where they appear in the navigation.'}
          </p>
        </div>
        <div className="flex gap-2">
          {!isEcommerce && (
            <button onClick={onOpenNavManager} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
              Navigation manager
            </button>
          )}
          <button onClick={onAddPage} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
            + Add page
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCardLite label={isEcommerce ? 'Policy pages' : 'Total pages'} value={counts.all} foot={`${counts.live} live · ${counts.drafts} draft`} />
        <StatCardLite label={isEcommerce ? 'Published' : 'Custom pages'} value={isEcommerce ? counts.live : counts.custom} foot={isEcommerce ? 'Visible to shoppers' : "Pages you've added"} />
        {!isEcommerce && <StatCardLite label="In dropdown menus" value={counts.inDropdown} foot="Nested under a parent" />}
        <button onClick={onAddPage} className="rounded-lg border-2 border-dashed border-indigo-200 bg-indigo-50/50 p-4 text-left hover:bg-indigo-50">
          <div className="text-sm font-semibold text-indigo-700">+ Add a new {isEcommerce ? 'policy page' : 'page'}</div>
          <div className="mt-1 text-xs text-indigo-600">{isEcommerce ? 'Footer, SEO, or direct link' : 'Place anywhere in your nav'}</div>
        </button>
      </div>

      {/* Quick add presets — one-tap, pre-filled pages */}
      {presets && presets.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Quick add</h3>
              <p className="text-xs text-gray-500">
                {isEcommerce ? 'Store-safe starter policies — review and customise before publishing.' : 'Pre-filled pages — tap once, then customise the copy.'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {presets.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                onAdd={() => onAddPreset(preset)}
                onEdit={() => onEditPage({ id: preset.existingPageId })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Filter + search bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-2">
        <div className="flex gap-1">
          {(isEcommerce ? [
            ['all',     'All',     counts.all],
            ['custom',  'Policy pages',   counts.custom],
            ['drafts',  'Drafts',   counts.drafts],
          ] : [
            ['all',     'All',     counts.all],
            ['system',  'Built-in', counts.system],
            ['custom',  'Custom',   counts.custom],
            ['drafts',  'Drafts',   counts.drafts],
          ]).map(([id, label, n]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${filter === id ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              {label} <span className={`ml-1 rounded px-1 text-xs ${filter === id ? 'bg-indigo-200 text-indigo-800' : 'bg-gray-200 text-gray-700'}`}>{n}</span>
            </button>
          ))}
        </div>
        <div className="relative">
          <input
            type="text"
            placeholder="Search pages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Page</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">URL</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">{isEcommerce ? 'Placement' : 'Navigation'}</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Blocks</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Updated</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-500">No pages match this filter.</td></tr>
            )}
            {filtered.map((p) => {
              const nav = placementLabel(p);
              return (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{p.title}</span>
                      {p.type === 'custom' && <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700">Custom</span>}
                      {p.type === 'system' && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">Built-in</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3"><code className="rounded bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600">{p.slug}</code></td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${p.isPublished ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${p.isPublished ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                      {p.isPublished ? 'Live' : 'Draft'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${nav.tone === 'purple' ? 'bg-purple-100 text-purple-700' : nav.tone === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-700'}`}>{nav.text}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{p.blockCount}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{p.updated}</td>
                  <td className="px-4 py-3 text-right">
                    {p.type === 'custom' ? (
                      <div className="flex justify-end gap-2">
                        <button onClick={() => onEditPage(p)} className="text-xs font-medium text-indigo-600 hover:underline">Edit</button>
                        <button onClick={() => onTogglePublish(p)} className="text-xs font-medium text-gray-600 hover:underline">
                          {p.isPublished ? 'Unpublish' : 'Publish'}
                        </button>
                        <button onClick={() => onDeletePage(p)} className="text-xs font-medium text-red-600 hover:underline">Delete</button>
                      </div>
                    ) : (
                      // Built-ins live as homepage sections — bridge to the
                      // Website tab so admins can edit the actual content.
                      <span className="text-xs text-gray-400">Built-in</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCardLite({ label, value, foot }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
      <div className="mt-1 text-xs text-gray-500">{foot}</div>
    </div>
  );
}

function PresetCard({ preset, onAdd, onEdit }) {
  const placementChip = preset.defaultPlacement === 'FOOTER'
    ? { label: 'Footer link', tone: 'gray' }
    : preset.defaultPlacement === 'TOP'
    ? { label: 'Top nav', tone: 'purple' }
    : { label: `Under ${preset.defaultParentNav}`, tone: 'gray' };
  return (
    <div className={`rounded-lg border p-3 ${preset.alreadyAdded ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200 bg-white hover:border-indigo-300'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">{preset.title}</span>
            {preset.alreadyAdded && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">✓ Added</span>}
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${placementChip.tone === 'purple' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>
              {placementChip.label}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">{preset.description}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        {preset.alreadyAdded ? (
          <button onClick={onEdit} className="text-xs font-medium text-indigo-600 hover:underline">Edit my version →</button>
        ) : (
          <button
            onClick={onAdd}
            className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
          >
            + Add to my site
          </button>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Add Page Wizard — Variation B (3 steps + live preview)
   ──────────────────────────────────────────────────────────────────── */

function AddPageWizard({ businessSlug, isEcommerce = false, onClose, onCreated }) {
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [seoDesc, setSeoDesc] = useState('');
  const [placement, setPlacement] = useState(isEcommerce ? 'FOOTER' : 'DROPDOWN');
  const [parentNav, setParentNav] = useState(isEcommerce ? 'info' : 'services');
  const [templateId, setTemplateId] = useState(isEcommerce ? 'legal' : 'service');
  const [layoutPreset, setLayoutPreset] = useState(() => defaultLayoutPreset({ templateId: isEcommerce ? 'legal' : 'service', parentNav: isEcommerce ? 'info' : 'services', placement: isEcommerce ? 'FOOTER' : 'DROPDOWN' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!slugTouched) setSlug(title ? `/${slugify(title)}` : '');
  }, [title, slugTouched]);

  useEffect(() => {
    setLayoutPreset(defaultLayoutPreset({ templateId, parentNav, placement }));
  }, [templateId, parentNav, placement]);

  const steps = ['Basics', 'Navigation', 'Template'];
  const canContinue =
    step === 0 ? title.trim() && slug.trim() && /^\/?[a-z0-9](?:[a-z0-9-]){0,79}$/.test(slug.replace(/^\//, '')) :
    step === 1 ? Boolean(placement) && (placement !== 'DROPDOWN' || parentNav) :
    true;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const preset = TEMPLATE_PRESETS.find((t) => t.id === templateId);
      const blocks = preset ? preset.blocks() : [];
      const cleanSlug = slug.replace(/^\//, '').toLowerCase();
      // For DROPDOWN/HIDDEN/FOOTER we still need a parentNav for the
      // existing /pages/<parentNav>/<slug> URL pattern. Default to 'info'
      // when not in dropdown so the URL is /pages/info/<slug>.
      const effectiveParentNav = placement === 'DROPDOWN' && !isEcommerce ? parentNav : 'info';
      const body = {
        parentNav: effectiveParentNav,
        slug: cleanSlug,
        title: title.trim(),
        templateKey: 'block-page',
        content: { layout: { preset: layoutPreset }, blocks },
        placement,
        metaDescription: seoDesc.trim() || null,
      };
      const res = await apiCall('/api/business/pages', { method: 'POST', body: JSON.stringify(body) });
      onCreated(res.page);
    } catch (e) {
      setError(e.message + (e.errors?.length ? ` — ${e.errors.join('; ')}` : ''));
    } finally {
      setBusy(false);
    }
  }

  const parentSystem = SYSTEM_PAGES.find((s) => s.key === parentNav);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="relative flex max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: form */}
        <div className="flex w-1/2 flex-col">
          <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-indigo-600">Add a new page</div>
              <h3 className="mt-1 text-lg font-semibold text-gray-900">{steps[step]}</h3>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
          </div>
          {/* Stepper */}
          <div className="flex gap-2 border-b border-gray-200 px-6 py-3">
            {steps.map((label, i) => (
              <div key={label} className="flex flex-1 items-center gap-2">
                <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${i === step ? 'bg-indigo-600 text-white' : i < step ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-600'}`}>
                  {i < step ? '✓' : i + 1}
                </div>
                <span className={`text-xs font-medium ${i === step ? 'text-indigo-600' : 'text-gray-500'}`}>{label}</span>
              </div>
            ))}
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {step === 0 && (
              <>
                <Field label="Page title">
                  <input
                    autoFocus
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={isEcommerce ? 'e.g. Allergy Information' : 'e.g. Couples Therapy'}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="URL slug">
                  <div className="flex overflow-hidden rounded-lg border border-gray-300">
                    <span className="border-r border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-500">{businessSlug || 'your-site'}.sitepresso.com</span>
                    <input
                      type="text"
                      value={slug}
                      onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
                      placeholder="/your-page"
                      className="flex-1 px-3 py-2 text-sm font-mono"
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-500">Lowercase, dashes only. Auto-filled from the title.</p>
                </Field>
                <Field label="SEO description (optional)">
                  <textarea
                    value={seoDesc}
                    onChange={(e) => setSeoDesc(e.target.value)}
                    rows={3}
                    maxLength={160}
                    placeholder="Brief summary for search engines (max 160 chars)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </Field>
              </>
            )}

            {step === 1 && (
              <>
                <Field label="Where should this page appear?">
                  <div className="space-y-2">
                    {PLACEMENT_OPTIONS.filter((opt) => !isEcommerce || opt.id !== 'DROPDOWN').map((opt) => (
                      <label key={opt.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${placement === opt.id ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                        <input type="radio" name="placement" checked={placement === opt.id} onChange={() => setPlacement(opt.id)} className="mt-1" />
                        <div className="flex-1">
                          <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                          <div className="text-xs text-gray-500">{opt.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </Field>
                {placement === 'DROPDOWN' && !isEcommerce && (
                  <Field label="Parent menu item">
                    <select
                      value={parentNav}
                      onChange={(e) => setParentNav(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    >
                      {SYSTEM_PAGES.filter((s) => s.key !== 'home' && s.key !== 'contact' && s.key !== 'blog').map((s) => (
                        <option key={s.key} value={s.key}>{s.title}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      Will appear as: <strong>{parentSystem?.title || parentNav} ▾ → {title || 'Your page'}</strong>
                    </p>
                  </Field>
                )}
              </>
            )}

            {step === 2 && (
              <Field label="Start from a template">
                <div className="grid grid-cols-2 gap-3">
                  {TEMPLATE_PRESETS.filter((t) => !isEcommerce || ['legal', 'info', 'blank'].includes(t.id)).map((t) => (
                    <label key={t.id} className={`flex cursor-pointer flex-col rounded-lg border p-3 ${templateId === t.id ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                      <input type="radio" name="template" checked={templateId === t.id} onChange={() => { setTemplateId(t.id); setLayoutPreset(t.layoutPreset || defaultLayoutPreset({ templateId: t.id, parentNav, placement })); }} className="hidden" />
                      <div className="text-sm font-semibold text-gray-900">{t.name}</div>
                      <div className="mt-1 text-xs text-gray-500">{t.desc}</div>
                    </label>
                  ))}
                </div>
                <div className="mt-5">
                  <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-gray-600">Public layout</label>
                  <div className="grid gap-2">
                    {PAGE_LAYOUTS.map((layout) => (
                      <button
                        key={layout.id}
                        type="button"
                        onClick={() => setLayoutPreset(layout.id)}
                        className={`rounded-lg border p-3 text-left ${layoutPreset === layout.id ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'}`}
                      >
                        <span className="block text-sm font-semibold text-gray-900">{layout.name}</span>
                        <span className="mt-1 block text-xs leading-5 text-gray-500">{layout.desc}</span>
                        <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-400">{layout.bestFor}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </Field>
            )}

            {error && <div className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</div>}
          </div>

          <div className="flex items-center justify-between border-t border-gray-200 px-6 py-3">
            <button
              onClick={() => (step > 0 ? setStep(step - 1) : onClose())}
              className="text-sm font-medium text-gray-600 hover:text-gray-900"
            >
              {step > 0 ? '← Back' : 'Cancel'}
            </button>
            {step < 2 ? (
              <button
                disabled={!canContinue}
                onClick={() => setStep(step + 1)}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                Continue →
              </button>
            ) : (
              <button
                disabled={busy || !canContinue}
                onClick={submit}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                {busy ? 'Creating…' : 'Create page →'}
              </button>
            )}
          </div>
        </div>

        {/* Right: live preview */}
        <div className="flex w-1/2 flex-col bg-gradient-to-br from-gray-50 to-gray-100 px-6 py-5">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Live preview</div>
          <div className="mt-3 flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-inner">
            <div className="flex items-center gap-1.5 border-b border-gray-200 bg-gray-50 px-3 py-2">
              <span className="h-2 w-2 rounded-full bg-red-300" />
              <span className="h-2 w-2 rounded-full bg-amber-300" />
              <span className="h-2 w-2 rounded-full bg-emerald-300" />
              <span className="ml-2 truncate font-mono text-[10px] text-gray-500">
                {businessSlug || 'your-site'}.sitepresso.com{slug || '/your-page'}
              </span>
            </div>
            {/* Mini nav */}
            <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-2 text-[11px]">
              <span className="font-bold">{businessSlug || 'site'}</span>
              <span className="text-gray-500">Home</span>
              {isEcommerce ? (
                <>
                  <span className="text-gray-500">Shop</span>
                  <span className="text-gray-500">Categories</span>
                  <span className={`text-gray-500 ${placement === 'TOP' ? 'font-bold text-indigo-600' : ''}`}>
                    {placement === 'TOP' ? title || 'Your page' : 'Deals'}
                  </span>
                </>
              ) : (
                <>
                  <span className={`text-gray-500 ${placement === 'DROPDOWN' && parentNav === 'services' ? 'font-bold text-indigo-600' : ''}`}>
                    Services {placement === 'DROPDOWN' && parentNav === 'services' && '▾'}
                  </span>
                  <span className="text-gray-500">About</span>
                  <span className={`text-gray-500 ${placement === 'TOP' ? 'font-bold text-indigo-600' : ''}`}>
                    {placement === 'TOP' ? title || 'Your page' : 'Pricing'}
                  </span>
                  <span className="text-gray-500">Contact</span>
                </>
              )}
            </div>
            {/* Mini page */}
            <div className="space-y-3 px-6 py-5">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-indigo-600">
                <span>{PAGE_LAYOUTS.find((layout) => layout.id === layoutPreset)?.name || 'Premium layout'}</span>
              </div>
              <div className="text-lg font-bold text-gray-900">{title || 'Your page title'}</div>
              <div className="text-xs text-gray-500">{seoDesc || 'A brief subtitle describing this page'}</div>
              {templateId === 'service' && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="h-16 rounded bg-gray-100" />
                  <div className="h-16 rounded bg-gray-100" />
                  <div className="h-16 rounded bg-gray-100" />
                </div>
              )}
              {templateId === 'info' && <div className="h-24 rounded bg-gray-100" />}
              {templateId === 'legal' && (
                <div className="space-y-1">
                  <div className="h-2 w-full rounded bg-gray-100" />
                  <div className="h-2 w-full rounded bg-gray-100" />
                  <div className="h-2 w-3/4 rounded bg-gray-100" />
                </div>
              )}
              {templateId === 'blank' && <div className="rounded border-2 border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">Empty page · add blocks</div>}
            </div>
          </div>
          <div className="mt-3 text-[11px] italic text-gray-500">Theme tokens auto-apply when you publish. Same layout, your active theme.</div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-600">{label}</label>
      {children}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Block-page editor — block toggle bar + left rail + canvas
   ──────────────────────────────────────────────────────────────────── */

function BlockPageEditor({ page, businessSlug, onBack }) {
  const initialBlocks = useMemo(() => Array.isArray(page.content?.blocks) ? page.content.blocks : [], [page]);
  const [blocks, setBlocks] = useState(initialBlocks);
  const [activeId, setActiveId] = useState(initialBlocks[0]?.id || null);
  const [tab, setTab] = useState('editor'); // editor / seo / settings
  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [placement, setPlacement] = useState(page.placement || 'DROPDOWN');
  const [parentNav, setParentNav] = useState(page.parentNav || 'info');
  const [metaTitle, setMetaTitle] = useState(page.metaTitle || '');
  const [metaDescription, setMetaDescription] = useState(page.metaDescription || '');
  const [metaKeywords, setMetaKeywords] = useState(page.metaKeywords || '');
  const [iconKey, setIconKey] = useState(page.iconKey || '');
  const [layoutPreset, setLayoutPreset] = useState(page.content?.layout?.preset || defaultLayoutPreset({ parentNav: page.parentNav, placement: page.placement }));
  const [lastSavedLayoutPreset, setLastSavedLayoutPreset] = useState(page.content?.layout?.preset || defaultLayoutPreset({ parentNav: page.parentNav, placement: page.placement }));
  const [isPublished, setIsPublished] = useState(page.isPublished);
  const [savedAt, setSavedAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [richTextModalId, setRichTextModalId] = useState(null);

  const activeBlock = blocks.find((b) => b.id === activeId);
  const richTextModalBlock = blocks.find((b) => b.id === richTextModalId && b.type === 'richtext');
  const layoutDirty = layoutPreset !== lastSavedLayoutPreset;

  function patchBlock(id, patch) {
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch, props: { ...b.props, ...(patch.props || {}) } } : b)));
  }
  function toggleBlock(id) {
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)));
  }
  function moveBlock(id, dir) {
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      if (i < 0) return bs;
      const j = dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= bs.length) return bs;
      const next = [...bs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function removeBlock(id) {
    setBlocks((bs) => bs.filter((b) => b.id !== id));
    if (activeId === id) setActiveId(null);
  }
  function addBlock(type) {
    const defaults = {
      header:    { eyebrow: '', title: 'New section', subtitle: '', primaryCtaText: '', primaryCtaLink: '' },
      richtext:  { heading: '', body: 'Write something…' },
      imagetext: { imageUrl: '', eyebrow: '', title: 'Image section', body: '', caption: '', position: 'left', buttonText: '', buttonLink: '' },
      features:  { eyebrow: '', heading: '', intro: '', columns: 3, items: [{ title: 'Feature', desc: '' }] },
      steps:     { eyebrow: '', heading: 'How it works', intro: '', items: [{ title: 'Step one', desc: 'Describe the first action.' }, { title: 'Step two', desc: 'Describe what happens next.' }, { title: 'Step three', desc: 'Describe the outcome.' }] },
      gallery:   { eyebrow: '', heading: 'Gallery', intro: '', style: 'mosaic', items: [{ imageUrl: '', title: 'Image title', caption: '' }] },
      linklist:  { eyebrow: '', heading: 'Useful links', intro: '', links: [{ label: 'Contact us', href: '/pages/info/contact', desc: 'Ask a question or send a brief.' }] },
      faq:       { eyebrow: '', heading: 'Common questions', intro: '', items: [{ q: 'What should visitors know?', a: 'Replace this answer with helpful guidance.' }] },
      cta:       { eyebrow: '', heading: 'Ready?', body: '', buttonText: 'Get started', buttonLink: '/', secondaryButtonText: '', secondaryButtonLink: '', style: 'primary', background: 'solid' },
    };
    const id = makeId(type);
    const block = { id, type, enabled: true, props: defaults[type] || {} };
    setBlocks((bs) => [...bs, block]);
    setActiveId(id);
    if (type === 'richtext') setRichTextModalId(id);
  }

  async function save({ publish } = {}) {
    setBusy(true);
    setError('');
    try {
      const cleanSlug = slug.replace(/^\//, '').toLowerCase();
      const body = {
        title: title.trim(),
        slug: cleanSlug,
        parentNav,
        templateKey: 'block-page',
        content: { ...(page.content || {}), layout: { preset: layoutPreset }, blocks },
        placement,
        metaTitle: metaTitle.trim() || null,
        metaDescription: metaDescription.trim() || null,
        metaKeywords: metaKeywords.trim() || null,
        iconKey: iconKey.trim() || null,
        ...(publish !== undefined ? { isPublished: publish } : {}),
      };
      await apiCall(`/api/business/pages/${page.id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (publish !== undefined) setIsPublished(publish);
      setLastSavedLayoutPreset(layoutPreset);
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message + (e.errors?.length ? ` — ${e.errors.join('; ')}` : ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-180px)] min-h-[600px] flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-4 py-2">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-sm text-gray-600 hover:text-gray-900">← Back to Pages</button>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            EDITING <strong className="text-gray-900">{title}</strong>
            <code className="rounded bg-gray-50 px-1.5 py-0.5 text-gray-600">/{slug.replace(/^\//, '')}</code>
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {['editor', 'layout', 'seo', 'settings'].map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded px-2.5 py-1 font-medium ${tab === id ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              {id === 'editor' ? 'Page Editor' : id === 'layout' ? 'Layout' : id === 'seo' ? 'SEO' : 'Settings'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {savedAt && <span className="text-[10px] text-gray-400">Saved {savedAt.toLocaleTimeString()}</span>}
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isPublished ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{isPublished ? 'Live' : 'Draft'}</span>
          <button onClick={() => save()} disabled={busy} className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => save({ publish: !isPublished })}
            disabled={busy}
            className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isPublished ? 'Unpublish' : 'Publish'}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}

      {tab === 'editor' && (
        <>
          {/* Block toggle bar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2">
            {blocks.map((b) => {
              const lib = BLOCK_LIBRARY.find((l) => l.id === b.type);
              return (
                <button
                  key={b.id}
                  onClick={() => setActiveId(b.id)}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${activeId === b.id ? 'bg-white shadow ring-1 ring-indigo-300' : 'bg-white/70 hover:bg-white'} ${!b.enabled ? 'opacity-50' : ''}`}
                >
                  <span className="font-medium text-gray-700">{lib?.name || b.type}</span>
                  <input
                    type="checkbox"
                    checked={!!b.enabled}
                    onChange={() => toggleBlock(b.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-1"
                  />
                </button>
              );
            })}
            <div className="relative">
              <details className="group">
                <summary className="cursor-pointer rounded-md border border-dashed border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-white">+ Add block</summary>
                <div className="absolute z-10 mt-1 w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
                  {BLOCK_LIBRARY.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => addBlock(b.id)}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-gray-100"
                    >
                      <div className="font-medium text-gray-900">{b.name}</div>
                      <div className="text-[10px] text-gray-500">{b.desc}</div>
                    </button>
                  ))}
                </div>
              </details>
            </div>
          </div>

          {/* Two-pane: left rail + preview */}
          <div className="flex flex-1 overflow-hidden">
            <aside className="flex w-80 flex-col overflow-y-auto border-r border-gray-200 bg-white p-4">
              {!activeBlock && <div className="text-sm text-gray-500">Select a block above to edit it.</div>}
              {activeBlock && (
                <BlockFieldEditor
                  block={activeBlock}
                  onPatch={(p) => patchBlock(activeBlock.id, p)}
                  onMoveUp={() => moveBlock(activeBlock.id, 'up')}
                  onMoveDown={() => moveBlock(activeBlock.id, 'down')}
                  onRemove={() => removeBlock(activeBlock.id)}
                  onOpenRichText={() => setRichTextModalId(activeBlock.id)}
                />
              )}
            </aside>
            <main className="flex-1 overflow-y-auto bg-gradient-to-br from-gray-50 to-gray-100 p-6">
              <div className="mx-auto max-w-3xl rounded-lg bg-white shadow">
                <BlockPagePreview blocks={blocks} highlight={activeId} title={title} layoutPreset={layoutPreset} />
              </div>
            </main>
          </div>
          {richTextModalBlock && (
            <RichTextBlockModal
              block={richTextModalBlock}
              onClose={() => setRichTextModalId(null)}
              onSave={(props) => {
                patchBlock(richTextModalBlock.id, { props });
                setRichTextModalId(null);
              }}
            />
          )}
        </>
      )}

      {tab === 'layout' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-4xl">
            <div className="mb-5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Public page layout</p>
                {layoutDirty && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">Unsaved</span>}
              </div>
              <h2 className="mt-1 text-2xl font-semibold text-gray-950">Choose how this page should feel</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
                Layout changes the public composition and rhythm while keeping your blocks, images, links, and SEO intact.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {PAGE_LAYOUTS.map((layout) => (
                <button
                  key={layout.id}
                  type="button"
                  onClick={() => setLayoutPreset(layout.id)}
                  className={`rounded-2xl border p-4 text-left transition ${layoutPreset === layout.id ? 'border-indigo-500 bg-indigo-50 shadow-sm ring-2 ring-indigo-100' : 'border-gray-200 bg-white hover:border-indigo-200 hover:bg-gray-50'}`}
                >
                  <div className="h-24 rounded-xl border border-gray-200 bg-white p-3">
                    <div className={`h-5 rounded ${layout.id === 'document' ? 'w-2/3 bg-gray-800' : 'w-3/4 bg-indigo-600'}`} />
                    <div className="mt-3 space-y-1.5">
                      <div className="h-2 rounded bg-gray-200" />
                      <div className="h-2 w-5/6 rounded bg-gray-200" />
                      <div className="h-2 w-2/3 rounded bg-gray-200" />
                    </div>
                    {layout.id !== 'document' && (
                      <div className="mt-3 grid grid-cols-3 gap-1.5">
                        <div className="h-5 rounded bg-gray-100" />
                        <div className="h-5 rounded bg-gray-100" />
                        <div className="h-5 rounded bg-gray-100" />
                      </div>
                    )}
                  </div>
                  <span className="mt-3 block text-sm font-semibold text-gray-950">{layout.name}</span>
                  <span className="mt-1 block text-xs leading-5 text-gray-500">{layout.desc}</span>
                  <span className="mt-2 block text-[10px] font-semibold uppercase tracking-wider text-gray-400">{layout.bestFor}</span>
                </button>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button onClick={() => save()} disabled={busy || !layoutDirty} className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? 'Saving…' : layoutDirty ? 'Save layout changes' : 'Layout saved'}</button>
              <span className="text-xs text-gray-500">Public page updates after this save and a browser refresh.</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'seo' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl space-y-4">
            <Field label="Meta title (overrides page title in browser tab + search)">
              <input type="text" value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} maxLength={120} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </Field>
            <Field label="Meta description (search snippet, max 160 chars)">
              <textarea value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} rows={3} maxLength={160} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <div className="mt-1 text-[10px] text-gray-500">{metaDescription.length}/160</div>
            </Field>
            <Field label="Meta keywords (comma-separated)">
              <input type="text" value={metaKeywords} onChange={(e) => setMetaKeywords(e.target.value)} maxLength={300} placeholder="tax filing, GST registration, CA certificate" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <div className="mt-1 text-[10px] text-gray-500">Used for the page keywords meta tag and internal SEO defaults.</div>
            </Field>
            <button onClick={() => save()} disabled={busy} className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? 'Saving…' : 'Save SEO'}</button>
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl space-y-4">
            <Field label="Page title">
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </Field>
            <Field label="URL slug">
              <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
            </Field>
            <Field label="Navigation placement">
              <select value={placement} onChange={(e) => setPlacement(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                {PLACEMENT_OPTIONS.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
              </select>
            </Field>
            {placement === 'DROPDOWN' && (
              <Field label="Parent menu item">
                <select value={parentNav} onChange={(e) => setParentNav(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  {SYSTEM_PAGES.filter((s) => s.key !== 'home' && s.key !== 'contact').map((s) => (
                    <option key={s.key} value={s.key}>{s.title}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Icon (optional)">
              <input type="text" value={iconKey} onChange={(e) => setIconKey(e.target.value)} placeholder="e.g. leaf, shield, doc" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </Field>
            <button onClick={() => save()} disabled={busy} className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BlockFieldEditor({ block, onPatch, onMoveUp, onMoveDown, onRemove, onOpenRichText }) {
  const lib = BLOCK_LIBRARY.find((l) => l.id === block.type);
  const set = (k, v) => onPatch({ props: { [k]: v } });
  const bodySummary = richTextSummary(block.props.body || '');

  return (
    <div className="space-y-3">
      <div className="border-b border-gray-200 pb-2">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">EDIT · BLOCK</div>
        <div className="mt-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">{lib?.name || block.type}</h3>
          <div className="flex gap-1">
            <button onClick={onMoveUp} title="Move up" className="rounded px-1.5 py-0.5 text-xs hover:bg-gray-100">↑</button>
            <button onClick={onMoveDown} title="Move down" className="rounded px-1.5 py-0.5 text-xs hover:bg-gray-100">↓</button>
            <button onClick={onRemove} title="Remove" className="rounded px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50">✕</button>
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-500">{lib?.desc}</p>
      </div>

      <div className={`rounded-lg p-2 text-xs ${block.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-50 text-gray-500'}`}>
        {block.enabled ? '👁 Visible on your page' : '⊘ Hidden — toggle on to show'}
      </div>

      {block.type === 'header' && (
        <>
          <SmallField label="Eyebrow" value={block.props.eyebrow || ''} onChange={(v) => set('eyebrow', v)} />
          <SmallField label="Title" value={block.props.title || ''} onChange={(v) => set('title', v)} />
          <SmallField label="Subtitle" value={block.props.subtitle || ''} onChange={(v) => set('subtitle', v)} multiline />
          <SmallField label="Primary CTA text" value={block.props.primaryCtaText || ''} onChange={(v) => set('primaryCtaText', v)} />
          <SmallField label="Primary CTA link" value={block.props.primaryCtaLink || ''} onChange={(v) => set('primaryCtaLink', v)} />
          <SmallField label="Secondary CTA text" value={block.props.secondaryCtaText || ''} onChange={(v) => set('secondaryCtaText', v)} />
          <SmallField label="Secondary CTA link" value={block.props.secondaryCtaLink || ''} onChange={(v) => set('secondaryCtaLink', v)} />
          <CheckRow label="Full-width banner image" checked={!!block.props.fullWidthBanner} onChange={(v) => set('fullWidthBanner', v)} />
          {!!block.props.fullWidthBanner && (
            <ImageField
              label="Banner image"
              value={block.props.bannerImageUrl || ''}
              onChange={(v) => set('bannerImageUrl', v)}
              scope="block-header-banner"
            />
          )}
        </>
      )}
      {block.type === 'richtext' && (
        <>
          <SmallField label="Heading" value={block.props.heading || ''} onChange={(v) => set('heading', v)} />
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">Body</label>
            <button
              type="button"
              onClick={onOpenRichText}
              className="w-full rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-left text-xs font-semibold text-indigo-700 hover:border-indigo-300 hover:bg-indigo-100"
            >
              Open large text editor
            </button>
            <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Content preview</div>
              <p className="mt-1 line-clamp-5 text-xs leading-5 text-gray-700">
                {bodySummary || 'No body text yet.'}
              </p>
              <p className="mt-2 text-[10px] text-gray-400">{bodySummary.length} characters</p>
            </div>
          </div>
          <CheckRow label="Two columns" checked={!!block.props.twoColumns} onChange={(v) => set('twoColumns', v)} />
        </>
      )}
      {block.type === 'imagetext' && (
        <>
          <ImageField
            label="Image"
            value={block.props.imageUrl || ''}
            onChange={(v) => set('imageUrl', v)}
            scope="block-imagetext"
          />
          <SmallField label="Eyebrow" value={block.props.eyebrow || ''} onChange={(v) => set('eyebrow', v)} />
          <SmallField label="Title" value={block.props.title || ''} onChange={(v) => set('title', v)} />
          <SmallField label="Body" value={block.props.body || ''} onChange={(v) => set('body', v)} multiline rows={5} />
          <SmallField label="Caption" value={block.props.caption || ''} onChange={(v) => set('caption', v)} multiline />
          <SmallField label="Button text" value={block.props.buttonText || ''} onChange={(v) => set('buttonText', v)} />
          <SmallField label="Button link" value={block.props.buttonLink || ''} onChange={(v) => set('buttonLink', v)} />
          <RadioGroup label="Image position" value={block.props.position || 'left'} options={[['left', 'Left'], ['right', 'Right']]} onChange={(v) => set('position', v)} />
        </>
      )}
      {block.type === 'features' && (
        <>
          <SmallField label="Eyebrow" value={block.props.eyebrow || ''} onChange={(v) => set('eyebrow', v)} />
          <SmallField label="Heading" value={block.props.heading || ''} onChange={(v) => set('heading', v)} />
          <SmallField label="Intro" value={block.props.intro || ''} onChange={(v) => set('intro', v)} multiline />
          <RadioGroup label="Columns" value={String(block.props.columns ?? 3)} options={[['2', '2'], ['3', '3'], ['4', '4']]} onChange={(v) => set('columns', Number(v))} />
          <div className="space-y-2">
            {(block.props.items || []).map((it, idx) => (
              <div key={idx} className="rounded border border-gray-200 p-2">
                <div className="mb-1 flex items-center justify-between text-[10px] font-semibold text-gray-600">
                  <span>Feature {idx + 1}</span>
                  <button
                    onClick={() => set('items', (block.props.items || []).filter((_, i) => i !== idx))}
                    className="text-red-600 hover:underline"
                  >Remove</button>
                </div>
                <SmallField label="Title" value={it.title || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, title: v } : x)))} />
                <SmallField label="Description" value={it.desc || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, desc: v } : x)))} />
              </div>
            ))}
            <button
              onClick={() => set('items', [...(block.props.items || []), { title: 'New feature', desc: '' }])}
              className="w-full rounded border border-dashed border-gray-300 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >+ Add feature</button>
          </div>
        </>
      )}
      {block.type === 'steps' && (
        <>
          <SmallField label="Eyebrow" value={block.props.eyebrow || ''} onChange={(v) => set('eyebrow', v)} />
          <SmallField label="Heading" value={block.props.heading || ''} onChange={(v) => set('heading', v)} />
          <SmallField label="Intro" value={block.props.intro || ''} onChange={(v) => set('intro', v)} multiline />
          <div className="space-y-2">
            {(block.props.items || []).map((it, idx) => (
              <div key={idx} className="rounded border border-gray-200 p-2">
                <div className="mb-1 flex items-center justify-between text-[10px] font-semibold text-gray-600">
                  <span>Step {idx + 1}</span>
                  <button onClick={() => set('items', (block.props.items || []).filter((_, i) => i !== idx))} className="text-red-600 hover:underline">Remove</button>
                </div>
                <SmallField label="Title" value={it.title || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, title: v } : x)))} />
                <SmallField label="Description" value={it.desc || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, desc: v } : x)))} multiline />
              </div>
            ))}
            <button onClick={() => set('items', [...(block.props.items || []), { title: 'New step', desc: '' }])} className="w-full rounded border border-dashed border-gray-300 py-1.5 text-xs text-gray-600 hover:bg-gray-50">+ Add step</button>
          </div>
        </>
      )}
      {block.type === 'gallery' && (
        <>
          <SmallField label="Eyebrow" value={block.props.eyebrow || ''} onChange={(v) => set('eyebrow', v)} />
          <SmallField label="Heading" value={block.props.heading || ''} onChange={(v) => set('heading', v)} />
          <SmallField label="Intro" value={block.props.intro || ''} onChange={(v) => set('intro', v)} multiline />
          <RadioGroup label="Gallery style" value={block.props.style || 'mosaic'} options={[['mosaic', 'Mosaic'], ['grid', 'Grid'], ['strip', 'Strip']]} onChange={(v) => set('style', v)} />
          <div className="space-y-3">
            {(block.props.items || []).map((it, idx) => (
              <div key={idx} className="rounded border border-gray-200 p-2">
                <div className="mb-2 flex items-center justify-between text-[10px] font-semibold text-gray-600">
                  <span>Image {idx + 1}</span>
                  <button onClick={() => set('items', (block.props.items || []).filter((_, i) => i !== idx))} className="text-red-600 hover:underline">Remove</button>
                </div>
                <ImageField label="Image" value={it.imageUrl || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, imageUrl: v } : x)))} scope={`block-gallery-${block.id}-${idx}`} />
                <SmallField label="Title" value={it.title || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, title: v } : x)))} />
                <SmallField label="Caption" value={it.caption || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, caption: v } : x)))} multiline />
              </div>
            ))}
            <button onClick={() => set('items', [...(block.props.items || []), { imageUrl: '', title: 'Image title', caption: '' }])} className="w-full rounded border border-dashed border-gray-300 py-1.5 text-xs text-gray-600 hover:bg-gray-50">+ Add image</button>
          </div>
        </>
      )}
      {block.type === 'linklist' && (
        <>
          <SmallField label="Eyebrow" value={block.props.eyebrow || ''} onChange={(v) => set('eyebrow', v)} />
          <SmallField label="Heading" value={block.props.heading || ''} onChange={(v) => set('heading', v)} />
          <SmallField label="Intro" value={block.props.intro || ''} onChange={(v) => set('intro', v)} multiline />
          <div className="space-y-2">
            {(block.props.links || []).map((it, idx) => (
              <div key={idx} className="rounded border border-gray-200 p-2">
                <div className="mb-1 flex items-center justify-between text-[10px] font-semibold text-gray-600">
                  <span>Link {idx + 1}</span>
                  <button onClick={() => set('links', (block.props.links || []).filter((_, i) => i !== idx))} className="text-red-600 hover:underline">Remove</button>
                </div>
                <SmallField label="Label" value={it.label || ''} onChange={(v) => set('links', (block.props.links || []).map((x, i) => (i === idx ? { ...x, label: v } : x)))} />
                <SmallField label="URL" value={it.href || ''} onChange={(v) => set('links', (block.props.links || []).map((x, i) => (i === idx ? { ...x, href: v } : x)))} />
                <SmallField label="Description" value={it.desc || ''} onChange={(v) => set('links', (block.props.links || []).map((x, i) => (i === idx ? { ...x, desc: v } : x)))} multiline />
              </div>
            ))}
            <button onClick={() => set('links', [...(block.props.links || []), { label: 'New link', href: '/', desc: '' }])} className="w-full rounded border border-dashed border-gray-300 py-1.5 text-xs text-gray-600 hover:bg-gray-50">+ Add link</button>
          </div>
        </>
      )}
      {block.type === 'faq' && (
        <>
          <SmallField label="Eyebrow" value={block.props.eyebrow || ''} onChange={(v) => set('eyebrow', v)} />
          <SmallField label="Heading" value={block.props.heading || ''} onChange={(v) => set('heading', v)} />
          <SmallField label="Intro" value={block.props.intro || ''} onChange={(v) => set('intro', v)} multiline />
          <div className="space-y-2">
            {(block.props.items || []).map((it, idx) => (
              <div key={idx} className="rounded border border-gray-200 p-2">
                <div className="mb-1 flex items-center justify-between text-[10px] font-semibold text-gray-600">
                  <span>Question {idx + 1}</span>
                  <button onClick={() => set('items', (block.props.items || []).filter((_, i) => i !== idx))} className="text-red-600 hover:underline">Remove</button>
                </div>
                <SmallField label="Question" value={it.q || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, q: v } : x)))} />
                <SmallField label="Answer" value={it.a || ''} onChange={(v) => set('items', (block.props.items || []).map((x, i) => (i === idx ? { ...x, a: v } : x)))} multiline rows={5} />
              </div>
            ))}
            <button onClick={() => set('items', [...(block.props.items || []), { q: 'New question', a: '' }])} className="w-full rounded border border-dashed border-gray-300 py-1.5 text-xs text-gray-600 hover:bg-gray-50">+ Add question</button>
          </div>
        </>
      )}
      {block.type === 'cta' && (
        <>
          <SmallField label="Eyebrow" value={block.props.eyebrow || ''} onChange={(v) => set('eyebrow', v)} />
          <SmallField label="Heading" value={block.props.heading || ''} onChange={(v) => set('heading', v)} />
          <SmallField label="Body" value={block.props.body || ''} onChange={(v) => set('body', v)} multiline />
          <SmallField label="Button text" value={block.props.buttonText || ''} onChange={(v) => set('buttonText', v)} />
          <SmallField label="Button link" value={block.props.buttonLink || ''} onChange={(v) => set('buttonLink', v)} />
          <SmallField label="Secondary button text" value={block.props.secondaryButtonText || ''} onChange={(v) => set('secondaryButtonText', v)} />
          <SmallField label="Secondary button link" value={block.props.secondaryButtonLink || ''} onChange={(v) => set('secondaryButtonLink', v)} />
          <RadioGroup label="Style" value={block.props.style || 'primary'} options={[['primary', 'Primary'], ['outline', 'Outline'], ['secondary', 'Secondary']]} onChange={(v) => set('style', v)} />
          <RadioGroup label="Background" value={block.props.background || 'solid'} options={[['solid', 'Solid'], ['card', 'Card'], ['image', 'Image']]} onChange={(v) => set('background', v)} />
          {block.props.background === 'image' && (
            <ImageField label="Background image" value={block.props.imageUrl || ''} onChange={(v) => set('imageUrl', v)} scope="block-cta-background" />
          )}
        </>
      )}
    </div>
  );
}

function RichTextBlockModal({ block, onSave, onClose }) {
  const [heading, setHeading] = useState(block.props.heading || '');
  const [body, setBody] = useState(() => richTextToHtml(block.props.body || ''));
  const [twoColumns, setTwoColumns] = useState(!!block.props.twoColumns);

  useEffect(() => {
    setHeading(block.props.heading || '');
    setBody(richTextToHtml(block.props.body || ''));
    setTwoColumns(!!block.props.twoColumns);
  }, [block.id, block.props.body, block.props.heading, block.props.twoColumns]);

  const summary = richTextSummary(body);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Rich text editor"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-5 py-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Rich text block</p>
            <h2 className="mt-1 text-lg font-semibold text-gray-950">Edit page content</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-2xl leading-none text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close rich text editor"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="space-y-4">
              <SmallField label="Section heading" value={heading} onChange={setHeading} />
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">Body content</label>
                <RichTextEditor
                  value={body}
                  onChange={setBody}
                  minHeight={420}
                  placeholder="Write clean page copy here. Use H2/H3 for sections, lists for points, and links where needed."
                />
              </div>
            </div>
            <aside className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Layout</p>
              <label className="mt-3 flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
                <span className="text-xs font-medium text-gray-700">Two columns on desktop</span>
                <input type="checkbox" checked={twoColumns} onChange={(e) => setTwoColumns(e.target.checked)} />
              </label>
              <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Summary</p>
                <p className="mt-1 text-xs leading-5 text-gray-600">{summary ? `${summary.length} characters` : 'No body text yet'}</p>
              </div>
            </aside>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave({ heading, body, twoColumns })}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function SmallField({ label, value, onChange, multiline, rows = 3 }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</label>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
      ) : (
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
      )}
    </div>
  );
}

function CheckRow({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5">
      <span className="text-xs text-gray-700">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function RadioGroup({ label, value, options, onChange }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</label>
      <div className="flex gap-1">
        {options.map(([v, l]) => (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`flex-1 rounded px-2 py-1 text-xs ${value === v ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >{l}</button>
        ))}
      </div>
    </div>
  );
}

// Image field — shows a thumbnail with Edit / Remove. Clicking either
// "Add image" or the thumb opens the shared ImageEditorModal so the
// admin can crop / zoom / rotate before save. Re-edit keeps the
// existing URL preloaded in the modal.
function ImageField({ label, value, onChange, scope = 'image' }) {
  const [editing, setEditing] = useState(false);
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</label>
      {value ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="block w-full overflow-hidden rounded border border-gray-200 hover:border-indigo-400"
            title="Click to edit"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt="" className="block h-32 w-full object-cover" />
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium hover:bg-gray-50"
            >
              Edit image
            </button>
            <button
              type="button"
              onClick={() => onChange('')}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex h-24 w-full items-center justify-center rounded border-2 border-dashed border-gray-300 text-xs font-medium text-gray-600 hover:border-indigo-400 hover:bg-indigo-50/40"
        >
          + Add image
        </button>
      )}
      {editing && (
        <ImageEditorModal
          value={value}
          scope={scope}
          onSave={(url) => onChange(url)}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function BlockPagePreview({ blocks, highlight, title, layoutPreset = 'service-premium' }) {
  const isVisual = layoutPreset === 'visual-story';
  const isHub = layoutPreset === 'resource-hub';
  const isEditorial = layoutPreset === 'editorial';
  const isDocument = layoutPreset === 'document';
  return (
    <div className={`overflow-hidden rounded-lg ${isVisual ? 'bg-slate-950 text-white' : isHub ? 'bg-indigo-50' : 'bg-white'}`}>
      <div className={`flex items-center justify-between border-b px-6 py-3 text-sm font-bold ${isVisual ? 'border-white/10' : 'border-gray-100'}`}>
        <span>{title}</span>
        <span className={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${isVisual ? 'bg-white/10 text-white' : 'bg-indigo-50 text-indigo-700'}`}>
          {PAGE_LAYOUTS.find((layout) => layout.id === layoutPreset)?.name || 'Layout'}
        </span>
      </div>
      {blocks.filter((b) => b.enabled).map((b) => (
        <div
          key={b.id}
          className={`border-b px-6 py-5 ${isVisual ? 'border-white/10' : 'border-gray-100'} ${highlight === b.id ? 'ring-2 ring-indigo-300 ring-inset' : ''}`}
        >
          {b.type === 'header' && (
            <div className={`${isHub ? 'rounded-xl border border-indigo-100 bg-white p-4' : ''} ${isEditorial ? 'text-center' : ''}`}>
              {b.props.eyebrow && <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-indigo-600">{b.props.eyebrow}</p>}
              <h1 className={`${isVisual ? 'text-white' : 'text-gray-900'} ${isDocument ? 'text-xl' : 'text-2xl'} font-bold`}>{b.props.title || 'Untitled'}</h1>
              {b.props.subtitle && <p className={`mt-1 text-sm ${isVisual ? 'text-white/70' : 'text-gray-600'}`}>{b.props.subtitle}</p>}
              {(b.props.primaryCtaText || b.props.secondaryCtaText) && (
                <div className={`mt-3 flex gap-2 ${isEditorial ? 'justify-center' : ''}`}>
                  {b.props.primaryCtaText && <span className="rounded bg-indigo-600 px-3 py-1 text-xs font-semibold text-white">{b.props.primaryCtaText}</span>}
                  {b.props.secondaryCtaText && <span className="rounded border border-gray-300 px-3 py-1 text-xs font-semibold text-gray-700">{b.props.secondaryCtaText}</span>}
                </div>
              )}
              {(b.props.fullWidthBanner || b.props.bannerImageUrl || isVisual || layoutPreset === 'service-premium') && !isDocument && (
                <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-gray-100">
                  {b.props.bannerImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={b.props.bannerImageUrl} alt="" className={`${isVisual ? 'h-56' : 'h-48'} w-full object-cover`} />
                  ) : (
                    <div className={`${isVisual ? 'h-56 bg-gradient-to-br from-slate-800 to-indigo-700 text-white/70' : 'h-48 bg-gradient-to-br from-indigo-100 to-purple-100 text-gray-500'} flex items-center justify-center text-xs font-semibold uppercase tracking-widest`}>
                      Banner image
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {b.type === 'richtext' && (
            <div className={`${isHub ? 'rounded-xl border border-indigo-100 bg-white p-4' : ''} ${isDocument ? 'mx-auto max-w-xl' : 'mx-auto max-w-2xl'}`}>
              {b.props.heading && <h2 className={`${isVisual ? 'text-white' : 'text-gray-950'} text-2xl font-semibold tracking-tight`}>{b.props.heading}</h2>}
              <div
                className={`mt-4 ${RICH_TEXT_RENDER_CLASS} ${isVisual ? 'text-white/75' : ''} ${b.props.twoColumns ? 'md:columns-2 md:gap-8 [&>*]:break-inside-avoid' : ''}`}
                dangerouslySetInnerHTML={{ __html: richTextToHtml(b.props.body || '') }}
              />
            </div>
          )}
          {b.type === 'imagetext' && (
            <div className={`grid grid-cols-2 gap-4 ${b.props.position === 'right' ? '' : ''}`}>
              <div className={`flex h-32 items-center justify-center rounded bg-gray-100 text-xs text-gray-400 ${b.props.position === 'right' ? 'order-2' : ''}`}>
                {b.props.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.props.imageUrl} alt="" className="h-full w-full rounded object-cover" />
                ) : 'No image'}
              </div>
              <div className="text-sm text-gray-700">
                {b.props.eyebrow && <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-indigo-600">{b.props.eyebrow}</p>}
                {b.props.title && <p className="font-semibold text-gray-950">{b.props.title}</p>}
                <p className="mt-1">{b.props.body || b.props.caption || 'Caption goes here.'}</p>
              </div>
            </div>
          )}
          {b.type === 'features' && (
            <div>
              {(b.props.heading || b.props.intro) && (
                <div className="mb-3">
                  {b.props.heading && <h3 className={`${isVisual ? 'text-white' : 'text-gray-950'} text-lg font-semibold`}>{b.props.heading}</h3>}
                  {b.props.intro && <p className={`mt-1 text-xs ${isVisual ? 'text-white/60' : 'text-gray-500'}`}>{b.props.intro}</p>}
                </div>
              )}
              <div className={`grid gap-3 ${isHub ? 'grid-cols-2' : b.props.columns === 2 ? 'grid-cols-2' : b.props.columns === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
              {(b.props.items || []).map((it, i) => (
                <div key={i} className={`rounded border p-3 ${isVisual ? 'border-white/10 bg-white/10' : isHub ? 'border-indigo-100 bg-white' : 'border-gray-200'}`}>
                  <div className={`text-sm font-semibold ${isVisual ? 'text-white' : 'text-gray-900'}`}>{it.title}</div>
                  <div className={`mt-1 text-xs ${isVisual ? 'text-white/60' : 'text-gray-500'}`}>{it.desc}</div>
                </div>
              ))}
              </div>
            </div>
          )}
          {b.type === 'steps' && (
            <div>
              {b.props.heading && <h3 className="text-lg font-semibold text-gray-950">{b.props.heading}</h3>}
              <div className="mt-3 space-y-2">
                {(b.props.items || []).map((it, i) => (
                  <div key={i} className="flex gap-3 rounded border border-gray-200 p-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">{i + 1}</span>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{it.title}</p>
                      <p className="mt-1 text-xs text-gray-500">{it.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {b.type === 'gallery' && (
            <div>
              {b.props.heading && <h3 className="text-lg font-semibold text-gray-950">{b.props.heading}</h3>}
              <div className="mt-3 grid grid-cols-3 gap-2">
                {(b.props.items || []).map((it, i) => (
                  <div key={i} className="overflow-hidden rounded border border-gray-200 bg-gray-50">
                    {it.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.imageUrl} alt="" className="h-20 w-full object-cover" />
                    ) : (
                      <div className="flex h-20 items-center justify-center text-[10px] text-gray-400">Image</div>
                    )}
                    {it.title && <p className="truncate px-2 py-1 text-[10px] font-semibold text-gray-700">{it.title}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {b.type === 'linklist' && (
            <div>
              {b.props.heading && <h3 className="text-lg font-semibold text-gray-950">{b.props.heading}</h3>}
              <div className="mt-3 grid grid-cols-2 gap-2">
                {(b.props.links || []).map((it, i) => (
                  <div key={i} className="rounded border border-gray-200 p-3">
                    <p className="text-sm font-semibold text-gray-900">{it.label}</p>
                    <p className="mt-1 text-[10px] text-gray-500">{it.href}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {b.type === 'faq' && (
            <div>
              {b.props.heading && <h3 className="text-lg font-semibold text-gray-950">{b.props.heading}</h3>}
              <div className="mt-3 space-y-2">
                {(b.props.items || []).map((it, i) => (
                  <div key={i} className="rounded border border-gray-200 p-3">
                    <p className="text-sm font-semibold text-gray-900">{it.q}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-gray-500">{it.a}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {b.type === 'cta' && (
            <div className={`rounded-lg px-6 py-5 text-center ${b.props.background === 'card' ? 'bg-gray-50' : b.props.background === 'image' ? 'bg-gradient-to-br from-indigo-100 to-purple-100' : 'bg-indigo-600 text-white'}`}>
              {b.props.eyebrow && <div className={`mb-1 text-[10px] font-semibold uppercase tracking-widest ${b.props.background === 'solid' ? 'text-white/70' : 'text-indigo-600'}`}>{b.props.eyebrow}</div>}
              <div className={`text-lg font-semibold ${b.props.background === 'solid' ? 'text-white' : 'text-gray-900'}`}>{b.props.heading || 'Heading'}</div>
              {b.props.body && <p className={`mx-auto mt-2 max-w-md text-xs ${b.props.background === 'solid' ? 'text-white/75' : 'text-gray-500'}`}>{b.props.body}</p>}
              {b.props.buttonText && (
                <div className="mt-3">
                  <span className={`inline-block rounded-lg px-4 py-2 text-sm font-medium ${b.props.style === 'outline' ? 'border border-current' : b.props.style === 'secondary' ? 'bg-gray-200 text-gray-800' : 'bg-white text-indigo-700'}`}>
                    {b.props.buttonText}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Nav manager modal
   ──────────────────────────────────────────────────────────────────── */

function NavManagerModal({ pages, siteNav, onClose, onSaved }) {
  const confirm = useConfirm();
  // Build tree from siteNav OR fall back to default order
  const initialTree = useMemo(() => {
    if (Array.isArray(siteNav) && siteNav.length > 0) return siteNav;
    // Default: every system page top-level, custom pages nested under their parentNav
    const customByParent = pages.reduce((acc, p) => {
      const k = p.parentNav || 'info';
      acc[k] = acc[k] || [];
      acc[k].push({ kind: 'custom', pageId: p.id });
      return acc;
    }, {});
    return SYSTEM_PAGES.map((s) => ({
      kind: 'system',
      key: s.key,
      ...(customByParent[s.key]?.length ? { children: customByParent[s.key] } : {}),
    }));
  }, [pages, siteNav]);

  const [tree, setTree] = useState(initialTree);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const titleFor = (node) => {
    if (node.kind === 'system') return SYSTEM_PAGES.find((s) => s.key === node.key)?.title || node.key;
    return pages.find((p) => p.id === node.pageId)?.title || '(unknown)';
  };

  function move(fromIdx, dir) {
    const j = dir === 'up' ? fromIdx - 1 : fromIdx + 1;
    if (j < 0 || j >= tree.length) return;
    const next = [...tree];
    [next[fromIdx], next[j]] = [next[j], next[fromIdx]];
    setTree(next);
  }
  function moveChild(parentIdx, fromIdx, dir) {
    const next = [...tree];
    const kids = [...(next[parentIdx].children || [])];
    const j = dir === 'up' ? fromIdx - 1 : fromIdx + 1;
    if (j < 0 || j >= kids.length) return;
    [kids[fromIdx], kids[j]] = [kids[j], kids[fromIdx]];
    next[parentIdx] = { ...next[parentIdx], children: kids };
    setTree(next);
  }
  function promoteChild(parentIdx, childIdx) {
    const next = [...tree];
    const kids = [...(next[parentIdx].children || [])];
    const [removed] = kids.splice(childIdx, 1);
    next[parentIdx] = { ...next[parentIdx], children: kids };
    next.splice(parentIdx + 1, 0, removed);
    setTree(next);
  }
  function demoteToParent(idx, parentIdx) {
    if (parentIdx === idx) return;
    const next = [...tree];
    const node = next[idx];
    if (node.kind !== 'custom') return; // only customs nest
    next.splice(idx, 1);
    const adjustedParent = parentIdx > idx ? parentIdx - 1 : parentIdx;
    const kids = [...(next[adjustedParent].children || []), node];
    next[adjustedParent] = { ...next[adjustedParent], children: kids };
    setTree(next);
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await apiCall('/api/business/site-nav', { method: 'PUT', body: JSON.stringify({ siteNav: tree }) });
      onSaved(tree);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    if (!await confirm('Reset to default navigation order?', { confirmLabel: 'Reset' })) return;
    setBusy(true);
    try {
      await apiCall('/api/business/site-nav', { method: 'PUT', body: JSON.stringify({ siteNav: null }) });
      onSaved(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex w-3/5 flex-col">
          <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-indigo-600">Navigation Manager</div>
              <h3 className="mt-1 text-lg font-semibold text-gray-900">Organize your navbar</h3>
              <p className="mt-1 text-xs text-gray-500">Use the controls to reorder, nest a page under a parent, or promote it back to the top level.</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">NAVBAR STRUCTURE</div>
            <div className="mt-2 space-y-1">
              {tree.map((node, i) => (
                <div key={`${node.kind}:${node.key || node.pageId}`}>
                  <div className="flex items-center gap-2 rounded border border-gray-200 bg-white px-2 py-1.5">
                    <span className="text-xs font-medium text-gray-700">{titleFor(node)}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${node.kind === 'custom' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>
                      {node.kind === 'custom' ? 'Custom' : 'Built-in'}
                    </span>
                    {node.children?.length > 0 && <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-700">{node.children.length} nested</span>}
                    <div className="ml-auto flex gap-1">
                      <button onClick={() => move(i, 'up')} className="text-xs hover:text-indigo-600" disabled={i === 0}>↑</button>
                      <button onClick={() => move(i, 'down')} className="text-xs hover:text-indigo-600" disabled={i === tree.length - 1}>↓</button>
                      {node.kind === 'custom' && (
                        <select
                          value=""
                          onChange={(e) => { const idx = Number(e.target.value); if (!Number.isNaN(idx)) demoteToParent(i, idx); }}
                          className="rounded border border-gray-300 px-1 text-[10px]"
                        >
                          <option value="">Nest under…</option>
                          {tree.map((p, pi) => p.kind === 'system' && <option key={pi} value={pi}>{titleFor(p)}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  {node.children?.length > 0 && (
                    <div className="ml-6 mt-1 space-y-1 border-l-2 border-gray-200 pl-3">
                      {node.children.map((c, ci) => (
                        <div key={`${c.kind}:${c.pageId}-${ci}`} className="flex items-center gap-2 rounded border border-gray-100 bg-gray-50 px-2 py-1">
                          <span className="text-xs text-gray-700">{titleFor(c)}</span>
                          <div className="ml-auto flex gap-1">
                            <button onClick={() => moveChild(i, ci, 'up')} className="text-xs hover:text-indigo-600" disabled={ci === 0}>↑</button>
                            <button onClick={() => moveChild(i, ci, 'down')} className="text-xs hover:text-indigo-600" disabled={ci === node.children.length - 1}>↓</button>
                            <button onClick={() => promoteChild(i, ci)} className="text-xs hover:text-indigo-600" title="Promote to top level">⤴</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          {error && <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}
          <div className="flex justify-between border-t border-gray-200 px-4 py-3">
            <button onClick={reset} disabled={busy} className="text-xs font-medium text-gray-600 hover:text-gray-900">Reset to default</button>
            <div className="flex gap-2">
              <button onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50">Cancel</button>
              <button onClick={save} disabled={busy} className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? 'Saving…' : 'Save navigation'}</button>
            </div>
          </div>
        </div>

        <div className="flex w-2/5 flex-col bg-gradient-to-br from-gray-50 to-gray-100 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">PREVIEW</div>
          <div className="mt-2 flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center gap-3 border-b border-gray-100 px-3 py-2">
              <span className="text-xs font-bold">site</span>
              {tree.map((node, i) => (
                <span key={i} className="text-xs text-gray-600">
                  {titleFor(node)}{node.children?.length > 0 && ' ▾'}
                </span>
              ))}
            </div>
            {/* Show children of first system entry with kids */}
            {tree.find((n) => n.children?.length > 0) && (
              <div className="px-3 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  {titleFor(tree.find((n) => n.children?.length > 0))} ▾ dropdown
                </div>
                <div className="mt-2 space-y-1">
                  {tree.find((n) => n.children?.length > 0).children.map((c, ci) => (
                    <div key={ci} className="rounded bg-gray-50 px-2 py-1 text-xs">{titleFor(c)}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 space-y-1 text-[10px] text-gray-500">
            <div><strong>↑ ↓</strong> &nbsp;Reorder within the same level</div>
            <div><strong>Nest under…</strong> &nbsp;Move a custom page under a parent</div>
            <div><strong>⤴</strong> &nbsp;Promote a child back to top level</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Legacy editor — keeps the old template-form path working for
   info-page / service-detail / team-bio rows already in the DB.
   ──────────────────────────────────────────────────────────────────── */

function LegacyPageEditor({ page, templates, parentNavs, onBack }) {
  const [content, setContent] = useState(page.content || {});
  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [parentNav, setParentNav] = useState(page.parentNav);
  const [isPublished, setIsPublished] = useState(page.isPublished);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState(null);

  const tplDef = templates.find((t) => t.key === page.templateKey)
    || (page.templateKey ? { key: page.templateKey, label: page.templateKey, fields: [] } : null);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await apiCall(`/api/business/pages/${page.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: title.trim(),
          slug: slug.toLowerCase(),
          parentNav,
          templateKey: page.templateKey,
          content,
          isPublished,
        }),
      });
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message + (e.errors?.length ? ` — ${e.errors.join('; ')}` : ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-gray-200 pb-2">
        <button onClick={onBack} className="text-sm text-gray-600 hover:text-gray-900">← Back to Pages</button>
        <div className="flex items-center gap-2">
          {savedAt && <span className="text-[10px] text-gray-400">Saved {savedAt.toLocaleTimeString()}</span>}
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">Legacy template: {tplDef?.label || page.templateKey}</span>
          <button onClick={save} disabled={busy} className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {error && <div className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Title">
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </Field>
        <Field label="URL slug">
          <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
        </Field>
        <Field label="Section">
          <select value={parentNav} onChange={(e) => setParentNav(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {parentNavs.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <label className="flex items-center gap-2 px-1 py-2 text-sm">
            <input type="checkbox" checked={isPublished} onChange={(e) => setIsPublished(e.target.checked)} />
            Published
          </label>
        </Field>
      </div>

      <div className="space-y-3">
        {(tplDef?.fields || []).map((field) => (
          <SmallField
            key={field.key}
            label={field.label}
            value={content[field.key] ?? ''}
            multiline={field.type === 'textarea' || field.type === 'richtext'}
            rows={field.type === 'textarea' ? 5 : 3}
            onChange={(v) => setContent({ ...content, [field.key]: v })}
          />
        ))}
      </div>
    </div>
  );
}

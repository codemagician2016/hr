'use client';

// Settings → Careers page (Careers CMS).
//
// The tenant-owned editor for the PUBLIC careers page rendered at
// /careers/<slug>. One row per tenant; rich-text is SANITISED on the server on
// write (scripts/handlers/dangerous URLs stripped) so the unauthenticated public
// render is safe. Publishing is a separate switch from saving edits: a save
// never changes the published state — only Publish / Unpublish flips it.
//
//   GET  /api/hr/recruitment/careers-page            → { page:{headline,subheadline,
//          aboutHtml,cultureHtml,heroImageUrl,customSections[],socialLinks{},perks[],
//          isPublished,updatedAt} }  (empty default when none exists yet)
//   PUT  /api/hr/recruitment/careers-page             { same fields, minus isPublished }
//          (upsert; server sanitises + caps + drops bad social URLs, echoes the stored row)
//   POST /api/hr/recruitment/careers-page/publish     isPublished = true
//   POST /api/hr/recruitment/careers-page/unpublish   isPublished = false
//
// Reads are gated on canView; writes on canManageHiring / canManageEmployees
// (server is the real boundary). Read-only operators see the banner and disabled
// controls. 4xx bodies are surfaced verbatim.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, Spinner } from '@hr/ui';
import { get, put, post } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';
import { permissionsFromSession, hasAnyPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

// The social links the backend accepts (careersPage.lib SOCIAL_KEYS). Only http(s)
// URLs survive the server's write-time cleaner — anything else is silently dropped.
const SOCIAL_FIELDS = [
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'https://linkedin.com/company/…' },
  { key: 'twitter', label: 'Twitter', placeholder: 'https://twitter.com/…' },
  { key: 'website', label: 'Website', placeholder: 'https://yourcompany.com' },
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/…' },
  { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/@…' },
  { key: 'facebook', label: 'Facebook', placeholder: 'https://facebook.com/…' },
  { key: 'github', label: 'GitHub', placeholder: 'https://github.com/…' },
  { key: 'glassdoor', label: 'Glassdoor', placeholder: 'https://glassdoor.com/…' },
];

const HTML_NOTE = 'Basic HTML is allowed (headings, lists, links, bold/italic, images). Scripts, event handlers and unsafe URLs are stripped on save.';

// A labelled single-line text input (matches the admin form surface).
function Field({ label, tip, value, onChange, placeholder, disabled, type = 'text' }) {
  return (
    <label className="block text-sm">
      <span className="flex items-center font-medium text-gray-700">{label}{tip && <InfoTip text={tip} />}</span>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none disabled:bg-gray-50"
      />
    </label>
  );
}

// A labelled HTML textarea with the "basic HTML allowed; scripts stripped" note.
function HtmlField({ label, tip, value, onChange, disabled, rows = 6 }) {
  return (
    <label className="block text-sm">
      <span className="flex items-center font-medium text-gray-700">{label}{tip && <InfoTip text={tip} />}</span>
      <textarea
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        disabled={disabled}
        placeholder="<p>Tell candidates about your team…</p>"
        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:outline-none disabled:bg-gray-50"
      />
      <span className="mt-1 block text-xs text-gray-400">{HTML_NOTE}</span>
    </label>
  );
}

export default function CareersPageEditor() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [slug, setSlug] = useState('');

  // Editable form state.
  const [headline, setHeadline] = useState('');
  const [subheadline, setSubheadline] = useState('');
  const [heroImageUrl, setHeroImageUrl] = useState('');
  const [aboutHtml, setAboutHtml] = useState('');
  const [cultureHtml, setCultureHtml] = useState('');
  const [sections, setSections] = useState([]); // [{ title, bodyHtml }]
  const [social, setSocial] = useState({}); // { linkedin, twitter, … }
  const [perks, setPerks] = useState([]); // [{ icon, label }]
  const [isPublished, setIsPublished] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  // Hydrate the whole form from a page object (the GET default or a PUT/publish echo).
  const hydrate = useCallback((p) => {
    if (!p) return;
    setHeadline(p.headline || '');
    setSubheadline(p.subheadline || '');
    setHeroImageUrl(p.heroImageUrl || '');
    setAboutHtml(p.aboutHtml || '');
    setCultureHtml(p.cultureHtml || '');
    setSections((p.customSections || []).map((s) => ({ title: s.title || '', bodyHtml: s.bodyHtml || '' })));
    setSocial({ ...(p.socialLinks || {}) });
    setPerks((p.perks || []).map((k) => ({ icon: k.icon || '', label: k.label || '' })));
    setIsPublished(!!p.isPublished);
    setUpdatedAt(p.updatedAt || null);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/recruitment/careers-page')
      .then((res) => hydrate(res?.page))
      .catch((e) => setError(e.data?.message || e.message || 'Could not load your careers page.'))
      .finally(() => setLoading(false));
  }, [hydrate]);

  useEffect(() => {
    load();
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasAnyPermission(permissionsFromSession(session), ['canManageHiring', 'canManageEmployees']));
        // The operator's own tenant slug → the public preview link (/careers/<slug>).
        if (session?.businessSlug) setSlug(session.businessSlug);
      })
      .catch(() => {});
  }, [load]);

  // ── custom-section helpers ──────────────────────────────────────────────────
  const setSection = (i, patch) => setSections((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addSection = () => setSections((rows) => [...rows, { title: '', bodyHtml: '' }]);
  const removeSection = (i) => setSections((rows) => rows.filter((_, idx) => idx !== i));
  const moveSection = (i, dir) => setSections((rows) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return rows;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  // ── perk helpers ────────────────────────────────────────────────────────────
  const setPerk = (i, patch) => setPerks((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addPerk = () => setPerks((rows) => [...rows, { icon: '', label: '' }]);
  const removePerk = (i) => setPerks((rows) => rows.filter((_, idx) => idx !== i));

  // Build the PUT payload from state. `order` is derived from row position, so the
  // reorder arrows fully determine display order (server sorts by it, stable).
  function buildPayload() {
    return {
      headline,
      subheadline,
      heroImageUrl,
      aboutHtml,
      cultureHtml,
      customSections: sections.map((s, idx) => ({ title: s.title, bodyHtml: s.bodyHtml, order: idx })),
      socialLinks: social,
      perks: perks
        .map((p) => ({ icon: (p.icon || '').trim() || undefined, label: (p.label || '').trim() }))
        .filter((p) => p.label),
    };
  }

  async function save() {
    setSaving(true); setError('');
    try {
      const res = await put('/api/hr/recruitment/careers-page', buildPayload());
      hydrate(res?.page); // echo the STORED row (sanitised HTML, dropped bad URLs)
      flash('Careers page saved.');
    } catch (e) {
      setError(e.data?.message || e.message || 'Could not save the careers page.');
    } finally { setSaving(false); }
  }

  async function togglePublish() {
    setPublishing(true); setError('');
    const next = !isPublished;
    try {
      const res = await post(`/api/hr/recruitment/careers-page/${next ? 'publish' : 'unpublish'}`);
      hydrate(res?.page);
      flash(next ? 'Careers page published — it is now live on your public site.' : 'Careers page unpublished — it is now hidden.');
    } catch (e) {
      setError(e.data?.message || e.message || 'Could not change the published state.');
    } finally { setPublishing(false); }
  }

  const previewHref = slug ? `/careers/${slug}` : null;

  if (loading) {
    return <div className="p-6 sm:p-8"><Spinner /></div>;
  }

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Careers page
            <InfoTip text="Your public careers page — the headline, story, perks and links candidates see at /careers/your-company alongside your open roles." />
          </span>
        )}
        subtitle="Design the public careers page candidates see with your open roles."
        actions={previewHref ? (
          <a
            href={previewHref}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Preview →
          </a>
        ) : null}
      />

      <ModuleGuide
        id="settings-careers-page"
        title="Tell your story, not just your job list"
        what="This is the content management for your public careers page at /careers/your-company. Add a headline, an about/culture story, the perks you offer and links to your socials — they render above your open roles. Nothing here is visible to the public until you Publish; a tenant that never sets this up simply shows the default board."
        steps={[
          'Fill in the headline, sub-headline and (optionally) a hero image URL.',
          'Write your About and Culture blurbs — basic HTML is allowed; anything unsafe is stripped on save.',
          'Add custom sections, perks and social links as needed, then click Save.',
          'When you are happy, click Publish to make it live. Use Preview any time to see it — drafts are only visible to you until published.',
        ]}
        example={<>Lead with <b>“Build the future of X with us”</b>, a short culture blurb, chips for <b>Remote-first</b>, <b>Health cover</b> and <b>Learning budget</b>, and a LinkedIn link — then Publish. Candidates see all of it above your roles.</>}
        tips={[
          'Saving edits never changes whether the page is live — only Publish / Unpublish does.',
          'Rich-text is sanitised on save: scripts, on* handlers and javascript:/unsafe URLs are removed.',
          'Social links must be full http(s) URLs — anything else is dropped when you save.',
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Editing the careers page requires the manage-hiring permission.
        </p>
      )}
      {error && <ErrorBanner message={error} />}

      {/* ── Publish state ──────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">Publication</span>
              {isPublished ? (
                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Published</span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">Draft</span>
              )}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Published pages are visible on your public careers site{previewHref ? <> at <code className="rounded bg-gray-100 px-1 py-0.5">/careers/{slug}</code></> : null}. Drafts are only visible to you.
              {updatedAt && <> · Last saved {new Date(updatedAt).toLocaleString()}.</>}
            </p>
          </div>
          {canManage && (
            <button
              type="button"
              onClick={togglePublish}
              disabled={publishing}
              className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${
                isPublished
                  ? 'border border-red-300 text-red-700 hover:bg-red-50'
                  : 'text-white'
              }`}
              style={!isPublished ? { backgroundColor: 'var(--theme-primary, #4f46e5)' } : undefined}
            >
              {publishing ? 'Working…' : isPublished ? 'Unpublish' : 'Publish'}
            </button>
          )}
        </div>
      </section>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle tip="The top of your careers page — the first thing a candidate reads.">Hero</SectionTitle>
        <div className="grid gap-4">
          <Field label="Headline" tip="Your big opening line, e.g. “Come build with us.” Leave blank to use your company name." value={headline} onChange={setHeadline} placeholder="Come build with us" disabled={!canManage} />
          <Field label="Sub-headline" tip="A short supporting line under the headline." value={subheadline} onChange={setSubheadline} placeholder="We're a remote-first team shipping…" disabled={!canManage} />
          <Field label="Hero image URL" tip="An optional banner image shown under the headline. Paste a full https:// image URL." value={heroImageUrl} onChange={setHeroImageUrl} placeholder="https://…/banner.jpg" disabled={!canManage} />
        </div>
      </section>

      {/* ── Story ──────────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle tip="Two rich-text blocks that render under the hero — who you are and what it's like to work there.">Your story</SectionTitle>
        <HtmlField label="About" tip="Who you are, what you do, your mission." value={aboutHtml} onChange={setAboutHtml} disabled={!canManage} />
        <HtmlField label="Culture" tip="What it's like to work with you — values, ways of working, benefits story." value={cultureHtml} onChange={setCultureHtml} disabled={!canManage} />
      </section>

      {/* ── Custom sections ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionTitle tip="Extra titled sections rendered in order below your story — e.g. “How we hire”, “Benefits”.">Custom sections</SectionTitle>
          {canManage && (
            <button type="button" onClick={addSection} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">+ Add section</button>
          )}
        </div>
        {sections.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-4 text-sm text-gray-500">No custom sections. Add one for anything beyond About / Culture.</p>
        ) : (
          <div className="space-y-4">
            {sections.map((s, i) => (
              <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="w-5 text-right text-xs text-gray-400">{i + 1}</span>
                  <input
                    type="text"
                    value={s.title}
                    onChange={(e) => setSection(i, { title: e.target.value })}
                    placeholder="Section title (e.g. How we hire)"
                    disabled={!canManage}
                    className="flex-1 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none disabled:bg-gray-50"
                  />
                  {canManage && (
                    <div className="flex items-center">
                      <button type="button" onClick={() => moveSection(i, -1)} disabled={i === 0} title="Move up" className="px-1.5 py-1 text-gray-500 hover:text-gray-800 disabled:opacity-30">↑</button>
                      <button type="button" onClick={() => moveSection(i, 1)} disabled={i === sections.length - 1} title="Move down" className="px-1.5 py-1 text-gray-500 hover:text-gray-800 disabled:opacity-30">↓</button>
                      <button type="button" onClick={() => removeSection(i)} title="Remove" className="px-1.5 py-1 text-red-500 hover:text-red-700">✕</button>
                    </div>
                  )}
                </div>
                <HtmlField label="Body" value={s.bodyHtml} onChange={(v) => setSection(i, { bodyHtml: v })} disabled={!canManage} rows={4} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Perks ──────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionTitle tip="Short perk chips rendered as a row, e.g. “Remote-first”, “Health cover”. An optional icon/emoji shows before the label.">Perks</SectionTitle>
          {canManage && (
            <button type="button" onClick={addPerk} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">+ Add perk</button>
          )}
        </div>
        {perks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-4 text-sm text-gray-500">No perks yet. Add a few to show what makes working with you great.</p>
        ) : (
          <div className="space-y-2">
            {perks.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={p.icon}
                  onChange={(e) => setPerk(i, { icon: e.target.value })}
                  placeholder="🎯"
                  disabled={!canManage}
                  className="w-16 shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-center text-sm focus:outline-none disabled:bg-gray-50"
                  aria-label="Perk icon (optional)"
                />
                <input
                  type="text"
                  value={p.label}
                  onChange={(e) => setPerk(i, { label: e.target.value })}
                  placeholder="Perk (e.g. Remote-first)"
                  disabled={!canManage}
                  className="flex-1 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none disabled:bg-gray-50"
                  aria-label="Perk label"
                />
                {canManage && (
                  <button type="button" onClick={() => removePerk(i)} title="Remove" className="px-1.5 py-1 text-red-500 hover:text-red-700">✕</button>
                )}
              </div>
            ))}
            <p className="text-xs text-gray-400">The icon is optional — an emoji works well. Empty perks are dropped on save.</p>
          </div>
        )}
      </section>

      {/* ── Social links ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionTitle tip="Links to your socials, rendered in the footer of the careers page. Must be full http(s) URLs.">Social links</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          {SOCIAL_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              value={social[f.key] || ''}
              onChange={(v) => setSocial((s) => ({ ...s, [f.key]: v }))}
              placeholder={f.placeholder}
              disabled={!canManage}
            />
          ))}
        </div>
        <p className="text-xs text-gray-400">Only full http(s) URLs are kept — anything else is dropped when you save.</p>
      </section>

      {/* ── Save ───────────────────────────────────────────────────────────── */}
      {canManage && (
        <div className="flex items-center gap-3 border-t border-gray-100 pt-5">
          <PrimaryButton loading={saving} onClick={save}>Save changes</PrimaryButton>
          <span className="text-xs text-gray-400">Saving does not change whether the page is live — use Publish for that.</span>
        </div>
      )}
    </div>
  );
}

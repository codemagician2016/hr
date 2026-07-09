'use client';

/**
 * Letters → Template library (Feature 9, slice 9D).
 *
 * Two surfaces on one page:
 *  (a) Library grid — every LetterTemplate (system India + tenant custom) as a
 *      card with category · country · version · status (PUBLISHED/DRAFT). System
 *      rows are badged + non-deletable. Filter by category / country / status.
 *  (b) Editor — a slide-over panel with a WYSIWYG body editor that writes ON the
 *      selected letterhead (rich subset: bold/headings/lists; Markdown storage) +
 *      a MERGE-FIELD INSERTER DRAWER (typeahead palette from GET /api/hr/letters/
 *      templates/merge-fields, inserts {{employee.name}} as a chip at the caret),
 *      category +
 *      country/locale toggle (India wording variant), default-letterhead
 *      picker (GET /api/hr/letters/letterheads — degrades gracefully if 9C's
 *      route 404s), requiresSignature toggle, ref-prefix override, and
 *      publish/archive actions.
 *
 *  Live preview: POSTs /api/hr/letters/preview (slice 9E's route). That route may
 *  not exist yet in this worktree — when it 404s/errors we degrade to a
 *  CLIENT-SIDE merged-text preview built from the merge-field catalog (sample
 *  values), with a visible "client preview" notice. "What you place is what you
 *  get" once 9E ships.
 *
 * No nav entry is added here (9E owns the "Letters" nav group). The page is
 * reachable directly at /letters/templates.
 *
 * RBAC: the backend gates every endpoint on canManageLetters; this screen is the
 * self-serve console for it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Spinner, ErrorBanner, Empty, PrimaryButton, TextInput,
} from '@hr/ui';
import { get, post, del, request } from '@/lib/api';

// PUT helper (lib/api exposes get/post/patch/del + request; PUT is the update verb
// per the backend, so we issue it through the generic request wrapper).
const put = (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data ?? {}) });
import { asList, PageHeader, StatusBadge, ActionButton } from '@/lib/ui';
import { InfoTip } from '../lib';
import ModuleGuide from '@/components/ModuleGuide';
import WysiwygEditor from './WysiwygEditor';

const CATEGORIES = [
  ['EXPERIENCE', 'Experience / Service'],
  ['BONAFIDE', 'Bonafide'],
  ['EMPLOYMENT_PROOF', 'Employment proof'],
  ['SALARY_PROOF', 'Salary proof'],
  ['BANK', 'Bank confirmation'],
  ['CONTRACT', 'Contract / Appointment'],
  ['CUSTOM', 'Custom'],
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
const COUNTRIES = [['', 'Any'], ['IN', 'India']];

const TEMPLATES_BASE = '/api/hr/letters/templates';

// Sample merge values for the client-side preview fallback (only used when the
// 9E /preview route is unavailable). Keyed by token; gives realistic-ish text.
const SAMPLE_VALUES = {
  'employee.name': 'Asha Menon', 'employee.firstName': 'Asha', 'employee.lastName': 'Menon',
  'employee.code': 'EMP-1042', 'employee.designation': 'Senior Engineer', 'employee.department': 'Engineering',
  'employee.dateOfJoining': '01/04/2022', 'employee.lastWorkingDay': '31/03/2026', 'employee.tenureYears': '4',
  'employee.employmentType': 'Permanent', 'employee.workLocation': 'Bengaluru', 'employee.email': 'asha@acme.com',
  'employee.phone': '+91 90000 00000', 'employee.pan': 'ABCDE1234F', 'employee.uan': '100200300400',
  'employee.pfNumber': 'KN/BNG/0012345', 'employee.esiNumber': '3100000000', 'employee.bankName': 'HDFC Bank',
  'employee.bankAccountMasked': '••••6789', 'employee.ifsc': 'HDFC0000123', 'employee.bankBranch': 'MG Road',
  'comp.ctcAnnual': '₹18,00,000.00', 'comp.basic': '₹7,20,000.00', 'comp.hra': '₹2,88,000.00',
  'comp.grossMonthly': '₹1,50,000.00', 'comp.netMonthly': '₹1,18,000.00', 'comp.da': '₹0.00', 'comp.specialAllowance': '₹3,00,000.00',
  'company.legalName': 'Acme Technologies Pvt. Ltd.', 'company.tradeName': 'Acme', 'company.addressBlock': '12 Residency Road, Bengaluru 560025',
  'company.registeredAddress': '12 Residency Road, Bengaluru 560025', 'company.cin': 'U72900KA2015PTC000000',
  'company.gstin': '29ABCDE1234F1Z5', 'company.logoUrl': '',
  'company.signatoryName': 'R. Iyer', 'company.signatoryDesignation': 'Head of HR',
  'date.today': '24/06/2026', 'date.issueDate': '24/06/2026', 'date.effectiveDate': '24/06/2026',
  'letter.refNo': 'ACME/HR/2026/0001', 'letter.subject': 'Subject', 'letter.purpose': 'visa application',
  'letter.addressee': 'The Visa Officer', 'authority.name': 'R. Iyer', 'authority.designation': 'Head of HR',
};

// Client-side {{token}} substitution mirroring backend renderMerge: known tokens
// replaced with their sample value; unknown tokens stripped (never echoed raw).
const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;
function clientMerge(body, values) {
  return String(body || '').replace(TOKEN_RE, (_m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : '');
}

function CountryBadge({ code }) {
  if (!code) return <span className="text-xs text-gray-400">—</span>;
  const cls = code === 'IN' ? 'bg-orange-50 text-orange-700 border-orange-200' : 'bg-sky-50 text-sky-700 border-sky-200';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{code}</span>;
}

// ─── Merge-field inserter drawer ─────────────────────────────────────────────
function MergeFieldDrawer({ palette, onInsert }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!palette) return [];
    return palette
      .map((g) => ({
        namespace: g.namespace,
        fields: g.fields.filter((f) =>
          !query || f.token.toLowerCase().includes(query) || g.namespace.toLowerCase().includes(query)),
      }))
      .filter((g) => g.fields.length);
  }, [palette, query]);

  return (
    <div className="border border-gray-200 rounded-xl bg-gray-50 p-3 w-72 shrink-0 flex flex-col" style={{ maxHeight: 460 }}>
      <p className="text-xs font-semibold text-gray-700 mb-2">Merge fields</p>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search fields…"
        className="w-full px-3 py-1.5 mb-2 border border-gray-300 rounded-md text-xs focus:outline-none"
      />
      <div className="overflow-y-auto flex-1 -mr-1 pr-1">
        {!palette ? (
          <div className="py-6 flex justify-center"><Spinner small /></div>
        ) : groups.length === 0 ? (
          <p className="text-xs text-gray-400 py-3">No fields match.</p>
        ) : (
          groups.map((g) => (
            <div key={g.namespace} className="mb-3">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">{g.namespace}</p>
              <div className="flex flex-wrap gap-1">
                {g.fields.map((f) => (
                  <button
                    key={f.token}
                    type="button"
                    onClick={() => onInsert(f.insert || `{{${f.token}}}`)}
                    title={`${f.token}${f.gatedBy ? ` · gated by ${f.gatedBy}` : ''}${f.country ? ` · ${f.country} only` : ''}`}
                    className="px-2 py-0.5 text-[11px] font-mono border border-gray-300 rounded bg-white hover:bg-violet-50 hover:border-violet-300 text-gray-700"
                  >
                    {f.token.split('.')[1]}
                    {f.gatedBy && <span className="ml-1 text-amber-500">🔒</span>}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <p className="text-[10px] text-gray-400 mt-2">🔒 = salary-masked unless you can view compensation.</p>
    </div>
  );
}

// ─── Editor (slide-over) ─────────────────────────────────────────────────────
function TemplateEditor({ template, letterheads, letterheadsAvailable, onClose, onSaved }) {
  const isNew = !template;
  const [form, setForm] = useState(() => ({
    name: template?.name || '',
    code: template?.code || '',
    category: template?.category || 'CUSTOM',
    countryCode: template?.countryCode || '',
    locale: template?.locale || '',
    subject: template?.subject || '',
    bodyMarkdown: template?.bodyMarkdown || '',
    defaultLetterheadId: template?.defaultLetterheadId || '',
    requiresSignature: !!template?.requiresSignature,
    refNoPrefix: template?.refNoPrefix || '',
  }));
  const [palette, setPalette] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState({ open: false, kind: '', text: '', pdfUrl: '', loading: false, note: '' });
  const [selectedLetterhead, setSelectedLetterhead] = useState(null);
  const wysiwygRef = useRef(null);
  const readOnlyMeta = !isNew && template?.isSystem; // system rows: edit body but keep code/category stable

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Load the merge-field palette filtered by the chosen country (re-fetch on toggle).
  useEffect(() => {
    let alive = true;
    setPalette(null);
    get(`${TEMPLATES_BASE}/merge-fields`, form.countryCode ? { country: form.countryCode } : undefined)
      .then((res) => { if (alive) setPalette(res.palette || []); })
      .catch(() => { if (alive) setPalette([]); });
    return () => { alive = false; };
  }, [form.countryCode]);

  // Fetch the FULL selected letterhead (fileUrl + layoutJson) so the WYSIWYG editor
  // can raster it as the backdrop and pin the writing area. The list rows omit the
  // heavy fileUrl, so we fetch the single row on demand.
  useEffect(() => {
    let alive = true;
    const id = form.defaultLetterheadId;
    if (!id) { setSelectedLetterhead(null); return undefined; }
    get(`/api/hr/letters/letterheads/${id}`)
      .then((row) => { if (alive) setSelectedLetterhead(row); })
      .catch(() => { if (alive) setSelectedLetterhead(null); });
    return () => { alive = false; };
  }, [form.defaultLetterheadId]);

  // Insert a merge-field token into the WYSIWYG editor at the caret (as a chip).
  const insertToken = useCallback((token) => {
    wysiwygRef.current?.insertToken(token);
  }, []);

  async function save({ publish } = {}) {
    setError('');
    if (!form.name.trim()) { setError('A template name is required.'); return; }
    if (!form.bodyMarkdown.trim()) { setError('A template body is required.'); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category,
        countryCode: form.countryCode || null,
        locale: form.locale || null,
        subject: form.subject || null,
        bodyMarkdown: form.bodyMarkdown,
        defaultLetterheadId: form.defaultLetterheadId || null,
        requiresSignature: form.requiresSignature,
        refNoPrefix: form.refNoPrefix || null,
      };
      if (isNew && form.code.trim()) payload.code = form.code.trim();
      let saved;
      if (isNew) saved = await post(TEMPLATES_BASE, payload);
      else saved = await put(`${TEMPLATES_BASE}/${template.id}`, payload);
      if (publish && saved?.id) saved = await post(`${TEMPLATES_BASE}/${saved.id}/publish`);
      onSaved(saved);
    } catch (e) {
      setError(e?.data?.unknownMergeFields ? `Unknown merge fields: ${e.data.unknownMergeFields.join(', ')}` : (e.message || 'Save failed.'));
    } finally {
      setSaving(false);
    }
  }

  // Live preview: try 9E's POST /preview; degrade to client-side merged text.
  async function runPreview() {
    setPreview((p) => ({ ...p, open: true, loading: true, note: '' }));
    // The 9E preview route needs a persisted template id + an employee. For the
    // editor we only have an in-progress body, so we attempt the route with the
    // current template id (if saved) and otherwise go straight to client merge.
    try {
      if (!template?.id) throw new Error('unsaved');
      const res = await fetch('/api/hr/letters/preview', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: template.id, overrides: { bodyMarkdown: form.bodyMarkdown } }),
      });
      if (!res.ok) throw new Error(`preview ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPreview({ open: true, kind: 'pdf', pdfUrl: url, text: '', loading: false, note: '' });
    } catch (e) {
      // Graceful degradation — client-side merged text preview from the catalog.
      const merged = clientMerge(form.bodyMarkdown, SAMPLE_VALUES);
      setPreview({
        open: true, kind: 'text', text: merged, pdfUrl: '', loading: false,
        note: 'Server preview (slice 9E) is not available yet — showing a client-side merged-text preview with sample data. Field placement onto the letterhead arrives with the issue/preview engine.',
      });
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} aria-hidden="true" />
      <div className="w-full max-w-5xl bg-white h-full shadow-xl flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{isNew ? 'New template' : template.name}</h2>
            {!isNew && (
              <p className="text-xs text-gray-500 mt-0.5">
                {template.code} · v{template.version} · <StatusBadge status={template.isActive ? 'PUBLISHED' : 'DRAFT'} />
                {template.isSystem && <span className="ml-2 text-violet-600">system</span>}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && <ErrorBanner message={error} />}

          <div className="grid grid-cols-2 gap-3">
            <TextInput label={<>Name <InfoTip text="A friendly name for this template, shown in the Issue dropdown (e.g. 'Experience Certificate')." label="Name" /></>} value={form.name} onChange={(v) => set('name', v)} required />
            {isNew
              ? <TextInput label={<>Code (optional) <InfoTip text="A short unique code. Auto-generated from the name if you leave it blank." label="Code" /></>} value={form.code} onChange={(v) => set('code', v)} hint="Auto-generated if blank" />
              : <TextInput label={<>Code <InfoTip text="The template's unique code. It cannot be changed after creation." label="Code" /></>} value={form.code} onChange={() => {}} hint="Immutable" />}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category<InfoTip text="The kind of letter (Experience, Bonafide, Contract…). Drives which letterhead and document folder it uses." label="Category" /></label>
              <select
                value={form.category}
                onChange={(e) => set('category', e.target.value)}
                disabled={readOnlyMeta}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50 disabled:text-gray-500"
              >
                {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Country / wording<InfoTip text="The market this template's wording targets (India). Tenants only see their own country's templates when issuing." label="Country" /></label>
              <select
                value={form.countryCode}
                onChange={(e) => {
                  const cc = e.target.value;
                  // auto-suggest a locale to pair with the wording variant
                  set('countryCode', cc);
                  if (cc === 'IN' && !form.locale) set('locale', 'en-IN');
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                {COUNTRIES.map(([v, l]) => <option key={v || 'any'} value={v}>{l}</option>)}
              </select>
            </div>
            <TextInput label={<>Locale <InfoTip text="Controls date + currency formatting (e.g. en-IN uses ₹ and dd/mm/yyyy)." label="Locale" /></>} value={form.locale} onChange={(v) => set('locale', v)} hint="e.g. en-IN" />
          </div>

          <TextInput label={<>Subject (optional) <InfoTip text="The letter's subject line. May contain merge fields like {{letter.subject}}." label="Subject" /></>} value={form.subject} onChange={(v) => set('subject', v)} hint="Mergeable, e.g. {{letter.subject}}" />

          {/* body: WYSIWYG on the letterhead + merge-field drawer */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">Body<InfoTip text="Write the letter on the letterhead. Format with the toolbar (bold, headings, lists) and insert merge fields like {{employee.name}} — they fill in automatically at issue. Pick a Default letterhead below to write directly on it." label="Body" /></label>
              <span className="text-xs text-gray-400">Bold · headings · lists. Click a field to insert at the cursor.</span>
            </div>
            <div className="flex gap-3 items-start">
              <WysiwygEditor
                ref={wysiwygRef}
                value={form.bodyMarkdown}
                onChange={(v) => set('bodyMarkdown', v)}
                letterhead={selectedLetterhead}
              />
              <MergeFieldDrawer palette={palette} onInsert={insertToken} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Default letterhead<InfoTip text="The stationery this template prints on. Leave blank to auto-resolve a letterhead by category when issuing." label="Default letterhead" /></label>
              {letterheadsAvailable ? (
                <select
                  value={form.defaultLetterheadId}
                  onChange={(e) => set('defaultLetterheadId', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                >
                  <option value="">Resolve by category at issue</option>
                  {asList(letterheads).map((lh) => <option key={lh.id} value={lh.id}>{lh.name || lh.code}</option>)}
                </select>
              ) : (
                <p className="text-xs text-gray-400 px-1 py-2 border border-dashed border-gray-200 rounded-lg">
                  Letterhead manager (slice 9C) not available yet — letterhead resolves by category at issue.
                </p>
              )}
            </div>
            <TextInput label={<>Ref-no prefix override <InfoTip text="The prefix of the auto-generated reference number (e.g. ACME/HR). Falls back to the tenant default if blank." label="Ref-no prefix" /></>} value={form.refNoPrefix} onChange={(v) => set('refNoPrefix', v)} hint="e.g. ACME/HR (else tenant default)" />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.requiresSignature} onChange={(e) => set('requiresSignature', e.target.checked)} />
            Route through e-sign before issue (recommended for contracts/appointments)
          </label>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-2">
          <ActionButton onClick={runPreview}>Preview</ActionButton>
          <div className="flex items-center gap-2">
            <ActionButton onClick={onClose}>Cancel</ActionButton>
            <ActionButton onClick={() => save({ publish: false })} disabled={saving}>Save draft</ActionButton>
            <PrimaryButton onClick={() => save({ publish: true })} loading={saving}>Save &amp; publish</PrimaryButton>
          </div>
        </div>
      </div>

      {preview.open && (
        <PreviewModal preview={preview} onClose={() => setPreview((p) => ({ ...p, open: false }))} />
      )}
    </div>
  );
}

function PreviewModal({ preview, onClose }) {
  // clean up the object URL when closing a pdf preview
  useEffect(() => () => { if (preview.pdfUrl) URL.revokeObjectURL(preview.pdfUrl); }, [preview.pdfUrl]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Preview</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-auto">
          {preview.loading ? (
            <div className="py-16 flex justify-center"><Spinner /></div>
          ) : preview.kind === 'pdf' ? (
            <iframe title="Letter preview" src={preview.pdfUrl} className="w-full" style={{ height: '70vh' }} />
          ) : (
            <pre className="whitespace-pre-wrap font-serif text-sm text-gray-800 p-8 leading-relaxed">{preview.text}</pre>
          )}
        </div>
        {preview.note && (
          <div className="px-5 py-3 border-t border-gray-100 bg-amber-50 text-xs text-amber-800">{preview.note}</div>
        )}
      </div>
    </div>
  );
}

// ─── Library card ────────────────────────────────────────────────────────────
function TemplateCard({ t, onEdit, onPublish, onArchive, onDelete }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 flex flex-col gap-2 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-gray-900 truncate">{t.name}</p>
          <p className="text-xs text-gray-500 truncate">{CATEGORY_LABEL[t.category] || t.category} · {t.code}</p>
        </div>
        <CountryBadge code={t.countryCode} />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <StatusBadge status={t.isActive ? 'PUBLISHED' : 'DRAFT'} />
        <span className="text-gray-400">v{t.version}</span>
        {t.isSystem && <span className="text-violet-600 font-medium">system</span>}
        {t.requiresSignature && <span className="text-blue-600">e-sign</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-1">
        <ActionButton onClick={() => onEdit(t)}>Edit</ActionButton>
        {t.isActive
          ? <ActionButton onClick={() => onArchive(t)}>Archive</ActionButton>
          : <ActionButton tone="positive" onClick={() => onPublish(t)}>Publish</ActionButton>}
        {!t.isSystem && <ActionButton tone="danger" onClick={() => onDelete(t)}>Delete</ActionButton>}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function TemplatesPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ category: '', country: '', status: '' });
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [letterheads, setLetterheads] = useState([]);
  const [letterheadsAvailable, setLetterheadsAvailable] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params = {};
    if (filters.category) params.category = filters.category;
    if (filters.country) params.country = filters.country;
    if (filters.status) params.status = filters.status;
    get(TEMPLATES_BASE, params)
      .then((res) => setRows(asList(res)))
      .catch((e) => setError(e.message || 'Failed to load templates.'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  // Letterheads (slice 9C) — optional. Degrade gracefully if the route 404s.
  useEffect(() => {
    get('/api/hr/letters/letterheads')
      .then((res) => { setLetterheads(asList(res)); setLetterheadsAvailable(true); })
      .catch(() => { setLetterheadsAvailable(false); });
  }, []);

  const act = async (fn, t, verb) => {
    try { await fn(); load(); } catch (e) { setError(e.message || `Failed to ${verb}.`); }
  };
  const onPublish = (t) => act(() => post(`${TEMPLATES_BASE}/${t.id}/publish`), t, 'publish');
  const onArchive = (t) => act(() => post(`${TEMPLATES_BASE}/${t.id}/archive`), t, 'archive');
  const onDelete = (t) => {
    if (!window.confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
    act(() => del(`${TEMPLATES_BASE}/${t.id}`), t, 'delete');
  };

  const grouped = useMemo(() => {
    const list = rows || [];
    return { system: list.filter((t) => t.isSystem), custom: list.filter((t) => !t.isSystem) };
  }, [rows]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Letter templates"
        subtitle="System (India) and custom letter templates with merge fields, versioning and publish state."
        actions={<PrimaryButton onClick={() => setEditing(null)}>New template</PrimaryButton>}
      />

      <ModuleGuide
        id="letters-templates"
        title="Build reusable HR letter templates with merge fields"
        what="This is your letter library. Each template (an Experience Certificate, Bonafide, Salary Proof, Appointment letter…) holds the body text plus {{merge fields}} that get auto-filled from the employee, their CTC and your company details when the letter is issued. India system templates ship ready-made; you can clone or add your own."
        steps={[
          "Pick a starting point: edit a built-in System (India) template, or click New template to start fresh.",
          "Set the Category (Experience, Bonafide, Salary proof…), Country = India and Locale en-IN so dates show as dd/mm/yyyy and amounts in ₹.",
          "Write the body and click fields in the Merge fields palette to drop tokens like {{employee.name}}, {{date.issueDate}} or {{comp.ctcAnnual}} at the cursor — no HTML.",
          "Use Preview to see the merged text with sample data before going live.",
          "Tick 'Route through e-sign' for contracts/appointments, then Save & publish to make it issuable.",
        ]}
        example={<>For <b>Aarav Sharma</b> (EMP-1042) at <b>Acme India Pvt Ltd</b>, an Experience Certificate body of "This is to certify that {'{{employee.name}}'} was employed as {'{{employee.designation}}'} from {'{{employee.dateOfJoining}}'} to {'{{employee.lastWorkingDay}}'}…" renders as "…employed as <b>Senior Engineer</b> from <b>01/04/2022</b> to <b>31/03/2026</b>…" with a <b>₹18,00,000</b> CTC line when you add {'{{comp.ctcAnnual}}'}.</>}
        tips={[
          "System (India) templates are badged 'system' and cannot be deleted — clone one instead of editing it heavily.",
          "🔒 merge fields (salary/CTC) only resolve for admins who can view compensation; for everyone else they render blank.",
        ]}
      />

      {/* filters */}
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Category</label>
          <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))} className="px-3 py-1.5 border border-gray-300 rounded-md text-sm">
            <option value="">All</option>
            {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Country</label>
          <select value={filters.country} onChange={(e) => setFilters((f) => ({ ...f, country: e.target.value }))} className="px-3 py-1.5 border border-gray-300 rounded-md text-sm">
            {COUNTRIES.map(([v, l]) => <option key={v || 'any'} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Status</label>
          <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="px-3 py-1.5 border border-gray-300 rounded-md text-sm">
            <option value="">All</option>
            <option value="PUBLISHED">Published</option>
            <option value="DRAFT">Draft</option>
          </select>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="py-16 flex justify-center"><Spinner /></div>
      ) : !rows || rows.length === 0 ? (
        <Empty text="No templates yet. Create one, or seed the India system library." />
      ) : (
        <>
          {grouped.system.length > 0 && (
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">System templates</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {grouped.system.map((t) => (
                  <TemplateCard key={t.id} t={t} onEdit={setEditing} onPublish={onPublish} onArchive={onArchive} onDelete={onDelete} />
                ))}
              </div>
            </section>
          )}
          <section>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Custom templates</h2>
            {grouped.custom.length === 0 ? (
              <Empty text="No custom templates. Create one or clone a system template." />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {grouped.custom.map((t) => (
                  <TemplateCard key={t.id} t={t} onEdit={setEditing} onPublish={onPublish} onArchive={onArchive} onDelete={onDelete} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {editing !== undefined && (
        <TemplateEditor
          template={editing}
          letterheads={letterheads}
          letterheadsAvailable={letterheadsAvailable}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
        />
      )}
    </div>
  );
}

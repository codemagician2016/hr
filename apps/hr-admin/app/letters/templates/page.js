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
import { get, post, patch, del, request } from '@/lib/api';

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

// Small pill toggle (mirrors the compliance page's Toggle styling).
function Toggle({ on, onClick, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-5 w-9 items-center rounded-full transition disabled:opacity-50 ${on ? 'bg-emerald-500' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${on ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
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

// Derive a token-safe camelCase key from a human label (letters/numbers only,
// must start with a letter — matches the {{manual.<key>}} grammar).
function slugKey(s) {
  const words = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const camel = words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
  return camel.replace(/^[^a-zA-Z]+/, '');
}

// ─── Feature 39: category combobox (type-to-create) ──────────────────────────
function CategoryPicker({ value, categories, onChange, onCreated }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function create(e) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const row = await post('/api/hr/letters/library/categories', { name: n });
      onCreated();
      onChange(row.id);
      setName(''); setAdding(false);
    } finally { setBusy(false); }
  }
  if (adding) {
    return (
      <div className="flex gap-1">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bank Resolution"
          onKeyDown={(e) => { if (e.key === 'Enter') create(e); }}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <button type="button" onClick={create} disabled={busy} className="px-2 text-xs text-white rounded-lg" style={{ background: 'var(--theme-primary)' }}>{busy ? '…' : 'Add'}</button>
        <button type="button" onClick={() => setAdding(false)} className="px-2 text-xs text-gray-500">Cancel</button>
      </div>
    );
  }
  return (
    <div className="flex gap-1">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
        <option value="">— none —</option>
        {(categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button type="button" onClick={() => setAdding(true)} className="px-2 text-xs underline" style={{ color: 'var(--theme-primary)' }}>+ New</button>
    </div>
  );
}

// ─── Feature 39: reusable SIGNATURE / STAMP picker (tenant library) ──────────
function AssetPicker({ kind, label, assets, value, onChange, onUploaded, onError }) {
  const [busy, setBusy] = useState(false);
  const mine = (assets || []).filter((a) => a.kind === kind);
  const selected = mine.find((a) => a.id === value);
  async function upload(file) {
    if (!file) return;
    if (file.type !== 'image/png') { onError(`The ${label.toLowerCase()} must be a PNG image.`); return; }
    setBusy(true);
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      const row = await post('/api/hr/letters/library/assets', { kind, name: file.name.replace(/\.png$/i, ''), fileBase64: dataUrl });
      onUploaded();
      onChange(row.id);
    } catch (e) { onError(e?.data?.message || e.message || 'Upload failed.'); }
    finally { setBusy(false); }
  }
  return (
    <div>
      <p className="text-xs font-medium text-gray-600 mb-1">{label}</p>
      <div className="flex gap-1 items-center">
        <select value={value} onChange={(e) => onChange(e.target.value)} className="flex-1 px-2 py-1.5 border border-gray-300 rounded-md text-xs bg-white">
          <option value="">— none —</option>
          {mine.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="px-2 py-1.5 text-xs border border-gray-300 rounded-md cursor-pointer hover:bg-gray-50 whitespace-nowrap">
          {busy ? '…' : 'Upload'}
          <input type="file" accept="image/png" className="hidden" onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; upload(f); }} />
        </label>
      </div>
      {selected && <img src={selected.imageUrl} alt={label} className="h-10 mt-1 border border-gray-200 rounded bg-white px-1" />}
    </div>
  );
}

// ─── Manual (at-issue) fields editor ─────────────────────────────────────────
function ManualFieldsPanel({ fields, onChange, onInsert }) {
  const rows = Array.isArray(fields) ? fields : [];
  const update = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const add = () => onChange([...rows, { key: '', label: '', type: 'text', required: false }]);
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i));
  const setLabel = (i, label) => {
    const r = rows[i];
    update(i, { label, key: r._keyEdited ? r.key : slugKey(label) });
  };
  return (
    <div className="rounded-xl border border-gray-200 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-800">Manual fields (filled at issue)<InfoTip text="Values NOT in the employee record that the issuer types when generating a letter (e.g. bonus amount, effective date). Reference them in the body as {{manual.<key>}}." label="Manual fields" /></p>
        <ActionButton onClick={add}>+ Add field</ActionButton>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400">None. Add one to collect a value from the issuer at generation time.</p>
      ) : rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <input value={r.label || ''} onChange={(e) => setLabel(i, e.target.value)} placeholder="Label" className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs" />
          <input value={r.key || ''} onChange={(e) => update(i, { key: e.target.value.replace(/[^a-zA-Z0-9]/g, ''), _keyEdited: true })} placeholder="key" className="w-28 px-2 py-1 border border-gray-300 rounded text-xs font-mono" />
          <select value={r.type || 'text'} onChange={(e) => update(i, { type: e.target.value })} className="px-2 py-1 border border-gray-300 rounded text-xs bg-white">
            <option value="text">Text</option>
            <option value="date">Date</option>
            <option value="number">Number</option>
            <option value="currency">Currency</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-gray-600"><input type="checkbox" checked={!!r.required} onChange={(e) => update(i, { required: e.target.checked })} />Req</label>
          <button type="button" onClick={() => r.key && onInsert(`{{manual.${r.key}}}`)} disabled={!r.key} className="text-xs text-violet-600 hover:underline disabled:text-gray-300" title="Insert {{manual.key}} into the body">Insert</button>
          <button type="button" onClick={() => remove(i)} className="text-xs text-red-500 hover:underline">Remove</button>
        </div>
      ))}
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
    authorityName: template?.authorityName || '',
    authorityDesignation: template?.authorityDesignation || '',
    signatureOnLastPage: template?.signatureOnLastPage !== false,
    manualFields: Array.isArray(template?.manualFieldsJson) ? template.manualFieldsJson : [],
    // Feature 39 — tenant category + reusable signature/stamp assets.
    categoryId: template?.categoryId || '',
    signatureAssetId: template?.signatureAssetId || '',
    stampAssetId: template?.stampAssetId || '',
  }));
  // Feature 39 library: tenant categories + reusable SIGNATURE/STAMP assets.
  const [categories, setCategories] = useState([]);
  const [assets, setAssets] = useState([]);
  const [stampBox, setStampBox] = useState(template?.stampBoxJson || null);
  const [libBusy, setLibBusy] = useState(false);
  const reloadLibrary = useCallback(() => {
    get('/api/hr/letters/library/categories').then((r) => setCategories(asList(r))).catch(() => setCategories([]));
    get('/api/hr/letters/library/assets').then((r) => setAssets(asList(r))).catch(() => setAssets([]));
  }, []);
  useEffect(() => { reloadLibrary(); }, [reloadLibrary]);
  // Static signature (Phase 2): the image is uploaded to a saved template via a
  // dedicated endpoint; its placement box + on-last-page flag save with the form.
  const [sigUrl, setSigUrl] = useState(template?.signatureImageUrl || '');
  const [sigBox, setSigBox] = useState(template?.signatureBoxJson || null);
  const [sigBusy, setSigBusy] = useState(false);
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

  // Upload / remove the static signature image (PNG). Requires a saved template id.
  const onSignatureFile = useCallback(async (file) => {
    if (!file) return;
    if (!template?.id) { setError('Save the template first, then add a signature.'); return; }
    if (file.type !== 'image/png') { setError('The signature must be a PNG image.'); return; }
    setSigBusy(true); setError('');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Could not read the file'));
        r.readAsDataURL(file);
      });
      const row = await post(`${TEMPLATES_BASE}/${template.id}/signature`, { fileBase64: dataUrl });
      setSigUrl(row.signatureImageUrl || dataUrl);
      setSigBox((prev) => prev || row.signatureBoxJson || { x: 0.1, y: 0.76, w: 0.25, h: 0.06 });
    } catch (e) {
      setError(e?.data?.message || e.message || 'Signature upload failed.');
    } finally { setSigBusy(false); }
  }, [template]);

  const onRemoveSignature = useCallback(async () => {
    if (!template?.id) { setSigUrl(''); return; }
    setSigBusy(true); setError('');
    try { await del(`${TEMPLATES_BASE}/${template.id}/signature`); setSigUrl(''); }
    catch (e) { setError(e.message || 'Could not remove the signature.'); }
    finally { setSigBusy(false); }
  }, [template]);

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
        authorityName: form.authorityName || null,
        authorityDesignation: form.authorityDesignation || null,
        signatureOnLastPage: form.signatureOnLastPage,
        ...(sigBox ? { signatureBoxJson: sigBox } : {}),
        manualFieldsJson: (form.manualFields || [])
          .filter((r) => r.key)
          .map(({ key, label, type, required }) => ({ key, label: label || key, type: type || 'text', required: !!required })),
        // Feature 39 — tenant category + reusable signature/stamp assets.
        categoryId: form.categoryId || null,
        signatureAssetId: form.signatureAssetId || null,
        stampAssetId: form.stampAssetId || null,
        ...(stampBox ? { stampBoxJson: stampBox } : {}),
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
            <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
              <label className="block text-sm font-medium text-gray-700">Body<InfoTip text="Write the letter directly on the stationery you picked. Format with the toolbar (bold, headings, lists) and insert merge fields like {{employee.name}} — they fill in automatically at issue." label="Body" /></label>
              {/* Print on — pick the stationery here so the editor shows the real
                  look & feel while you write (switches the backdrop live). */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-600">Print on:</span>
                <select
                  value={form.defaultLetterheadId}
                  onChange={(e) => set('defaultLetterheadId', e.target.value)}
                  className="px-2 py-1.5 border border-gray-300 rounded-md text-xs bg-white"
                >
                  <option value="">Blank / auto-resolve at issue</option>
                  {asList(letterheads).map((lh) => <option key={lh.id} value={lh.id}>{lh.name || lh.code}</option>)}
                </select>
                <InfoTip text="Choose the letterhead you're writing on — the editor renders it live behind your text, so what you type is exactly where it prints. Leave it on 'Blank' to write without a letterhead (one is then auto-resolved by category at issue, or a branded page is generated if none exists)." label="Print on" />
              </div>
            </div>
            <p className="text-xs text-gray-400 mb-1">Bold · headings · lists. Click a merge field to insert it at the cursor.</p>
            <div className="flex gap-3 items-start">
              <WysiwygEditor
                ref={wysiwygRef}
                value={form.bodyMarkdown}
                onChange={(v) => set('bodyMarkdown', v)}
                letterhead={selectedLetterhead}
                signatureUrl={(assets.find((a) => a.id === form.signatureAssetId) || {}).imageUrl || sigUrl}
                signatureBox={sigBox}
                onSignatureBoxChange={setSigBox}
                stampUrl={(assets.find((a) => a.id === form.stampAssetId) || {}).imageUrl || ''}
                stampBox={stampBox}
                onStampBoxChange={setStampBox}
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

          {/* Signatory & static signature (Phase 2) */}
          <div className="rounded-xl border border-gray-200 p-4 space-y-3">
            <p className="text-sm font-semibold text-gray-800">Signatory &amp; signature<InfoTip text="The authorized signatory printed on every issued letter, plus a static signature image auto-stamped on the letterhead. The name fills {{authority.name}} / {{company.signatoryName}}." label="Signatory" /></p>
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="Authority name" value={form.authorityName} onChange={(v) => set('authorityName', v)} hint="e.g. Priya Sharma" />
              <TextInput label="Authority designation" value={form.authorityDesignation} onChange={(v) => set('authorityDesignation', v)} hint="e.g. Head of HR" />
            </div>
            {/* Feature 39 — tenant category + REUSABLE signature/stamp from the library */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category<InfoTip text="Your own grouping name (e.g. 'Bank Resolution') so letters are easy to recognise, filter and search later. Type a new name to create it — it's then reusable on any template." label="Category" /></label>
              <CategoryPicker value={form.categoryId} categories={categories} onChange={(v) => set('categoryId', v)} onCreated={reloadLibrary} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <AssetPicker kind="SIGNATURE" label="Signature" assets={assets} value={form.signatureAssetId} onChange={(v) => set('signatureAssetId', v)} onUploaded={reloadLibrary} onError={setError} />
              <AssetPicker kind="STAMP" label="Stamp / seal" assets={assets} value={form.stampAssetId} onChange={(v) => set('stampAssetId', v)} onUploaded={reloadLibrary} onError={setError} />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={form.signatureOnLastPage} onChange={(e) => set('signatureOnLastPage', e.target.checked)} />
              Place signature/seal on the last page (vs page 1)
            </label>
            <p className="text-[11px] text-gray-400">Signatures and stamps are saved to your library — upload once, then reuse them on every future template.</p>
          </div>

          {/* Manual (at-issue) fields (Phase 3) */}
          <ManualFieldsPanel
            fields={form.manualFields}
            onChange={(v) => set('manualFields', v)}
            onInsert={insertToken}
          />
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
function TemplateCard({ t, onEdit, onPublish, onArchive, onDelete, onToggleSelfServe }) {
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
      {/* Feature 42 — employee self-service visibility: ON ⇒ this template shows
          in the ESS "Request a letter" dropdown (once PUBLISHED). */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-100">
        <span className="text-xs text-gray-600 inline-flex items-center">
          Employee can request
          <InfoTip text="When ON (and the template is published), employees see this letter in their Letters screen and can request it themselves." label="Employee can request" />
        </span>
        <Toggle on={!!t.selfServe} onClick={() => onToggleSelfServe(t, !t.selfServe)} label={`Employee can request ${t.name}`} />
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
  const [filters, setFilters] = useState({ category: '', country: '', status: '', categoryId: '' });
  // Feature 39 — tenant categories drive the list filter ("show me all Bank Resolutions").
  const [pageCategories, setPageCategories] = useState([]);
  useEffect(() => { get('/api/hr/letters/library/categories').then((r) => setPageCategories(asList(r))).catch(() => setPageCategories([])); }, []);
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [letterheads, setLetterheads] = useState([]);
  const [letterheadsAvailable, setLetterheadsAvailable] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params = {};
    if (filters.category) params.category = filters.category;
    if (filters.categoryId) params.categoryId = filters.categoryId;
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

  // Feature 42 — page-level "Allow custom letter requests" switch (tenant flag:
  // whether ESS may submit a free-form "Other" request alongside the selfServe
  // template list). null while loading / when the settings route is unavailable.
  const [reqSettings, setReqSettings] = useState(null);
  const [reqSettingsBusy, setReqSettingsBusy] = useState(false);
  useEffect(() => {
    get(`${TEMPLATES_BASE}/settings`).then(setReqSettings).catch(() => setReqSettings(null));
  }, []);
  const toggleAllowCustom = async () => {
    if (!reqSettings || reqSettingsBusy) return;
    setReqSettingsBusy(true);
    try {
      const next = await patch(`${TEMPLATES_BASE}/settings`, { allowCustomRequests: !reqSettings.allowCustomRequests });
      setReqSettings(next);
    } catch (e) {
      setError(e.message || 'Failed to update the custom-request setting.');
    } finally {
      setReqSettingsBusy(false);
    }
  };

  const act = async (fn, t, verb) => {
    try { await fn(); load(); } catch (e) { setError(e.message || `Failed to ${verb}.`); }
  };
  const onPublish = (t) => act(() => post(`${TEMPLATES_BASE}/${t.id}/publish`), t, 'publish');
  const onArchive = (t) => act(() => post(`${TEMPLATES_BASE}/${t.id}/archive`), t, 'archive');
  // Feature 42 — per-template ESS visibility toggle (PUT accepts a partial body).
  const onToggleSelfServe = (t, next) => act(() => put(`${TEMPLATES_BASE}/${t.id}`, { selfServe: next }), t, 'update');
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

      {/* Feature 42 — employee self-service controls (top toolbar) */}
      <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-800 inline-flex items-center">
            Allow custom letter requests
            <InfoTip text="When ON, employees may also submit a free-form 'Other' request (describing what they need) besides the templates you mark requestable. Turn OFF to restrict requests to the marked templates only." label="Allow custom letter requests" />
          </p>
          <p className="text-xs text-gray-500">
            Employees see published templates with &lsquo;Employee can request&rsquo; ON in their Letters screen.
          </p>
        </div>
        {reqSettings ? (
          <Toggle
            on={!!reqSettings.allowCustomRequests}
            onClick={toggleAllowCustom}
            disabled={reqSettingsBusy}
            label="Allow custom letter requests"
          />
        ) : (
          <span className="text-xs text-gray-400">Unavailable</span>
        )}
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Category</label>
          <select value={filters.categoryId} onChange={(e) => setFilters((f) => ({ ...f, categoryId: e.target.value }))} className="px-3 py-1.5 border border-gray-300 rounded-md text-sm">
            <option value="">All categories</option>
            {pageCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
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
                  <TemplateCard key={t.id} t={t} onEdit={setEditing} onPublish={onPublish} onArchive={onArchive} onDelete={onDelete} onToggleSelfServe={onToggleSelfServe} />
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
                  <TemplateCard key={t.id} t={t} onEdit={setEditing} onPublish={onPublish} onArchive={onArchive} onDelete={onDelete} onToggleSelfServe={onToggleSelfServe} />
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

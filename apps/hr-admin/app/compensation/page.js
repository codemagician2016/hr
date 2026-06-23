'use client';

// Compensation console against /api/hr/compensation/* (reads need
// canViewCompensation, writes canManageCompensation — enforced backend-side).
//  - Components: GET/POST /components — posts the REAL contract (kind/category/
//    calcMethod + wage flags).
//  - Structures: GET/POST /structures — posts entityId/countryCode/currencyCode/
//    basis + nested lines; a live CTC preview panel (POST /structures/preview)
//    renders the waterfall + India 50% chip before save.
//  - Revisions:  GET/POST /employees/:employeeId/revisions — effective-dated,
//    posts revisionReason (NOT reason) + entityId/currencyCode/basis. Reads are
//    masked server-side (RANGE_ONLY shows compa-ratio, ABSOLUTE shows money).
//
// NOTE (follow-up): the full drag-to-reorder builder + cycle worksheet +
// dashboard from docs/05 §5 are deferred; this console posts the correct
// contract and previews CTC live, which unblocks the backend QA criteria.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, TextInput, DateField, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, moneyish } from '@/lib/ui';
// Entities (and their authoritative countryCode) back the structure form's
// country/currency derivation; imported directly via /api/hr/payroll/entities.

const TABS = [
  { key: 'components', label: 'Pay components' },
  { key: 'structures', label: 'Salary structures' },
  { key: 'revisions', label: 'Employee revisions' },
];

const KINDS = ['BASIC', 'DEARNESS_ALLOWANCE', 'HRA', 'SPECIAL_ALLOWANCE', 'CONVEYANCE', 'MEDICAL', 'LTA', 'BONUS'];
const CATEGORIES = ['EARNING', 'DEDUCTION', 'EMPLOYER_COST', 'REIMBURSEMENT'];
const CALC_METHODS = ['FLAT', 'PERCENT_OF', 'BALANCING', 'FORMULA', 'STATUTORY'];

// ── Pay components — real create contract ──
function ComponentsTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ name: '', code: '', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT' });

  const load = useCallback(() => {
    setError('');
    get('/api/hr/compensation/components', { page: 1, pageSize: 100 })
      .then((r) => setRows(asList(r)))
      .catch((e) => { setError(e.message || 'Failed to load components.'); setRows([]); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await post('/api/hr/compensation/components', draft); // kind/category/calcMethod required
      setDraft({ name: '', code: '', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT' });
      load();
    } catch (e) { setError(e.data?.message || e.message || 'Failed to create.'); }
    finally { setSaving(false); }
  }

  const columns = [
    { key: 'name', header: 'Component', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => r.code || '—' },
    { key: 'kind', header: 'Kind', render: (r) => r.kind || '—' },
    { key: 'category', header: 'Category', render: (r) => <StatusBadge status={r.category} /> },
    { key: 'calcMethod', header: 'Calc', render: (r) => r.calcMethod || '—' },
  ];

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        {error && <ErrorBanner message={error} />}
        <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No pay components yet." />
      </div>
      <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
        <h2 className="text-sm font-semibold text-gray-900">Add component</h2>
        <TextInput label="Name" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} required />
        <TextInput label="Code" value={draft.code} onChange={(v) => setDraft((d) => ({ ...d, code: v }))} required />
        <Select label="Kind" value={draft.kind} options={KINDS} onChange={(v) => setDraft((d) => ({ ...d, kind: v }))} />
        <Select label="Category" value={draft.category} options={CATEGORIES} onChange={(v) => setDraft((d) => ({ ...d, category: v }))} />
        <Select label="Calc method" value={draft.calcMethod} options={CALC_METHODS} onChange={(v) => setDraft((d) => ({ ...d, calcMethod: v }))} />
        {draft.calcMethod === 'BALANCING' && (
          <p className="text-xs text-amber-700">Balancing (fills to target) — amount is derived, not entered.</p>
        )}
        <PrimaryButton type="submit" loading={saving}>Save</PrimaryButton>
      </form>
    </div>
  );
}

// ── Salary structures — real create contract + live CTC preview ──
function StructuresTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // countryCode/currencyCode are DERIVED from the chosen entity — never typed and
  // never hardcoded to India. An NZ entity yields NZ + NZD, so the India 50% wage
  // rule is gated off for NZ structures (the engine keys the rule on countryCode).
  const [draft, setDraft] = useState({ name: '', code: '', entityId: '', countryCode: '', currencyCode: '', basis: 'CTC' });
  // Live preview: a target CTC + the structure's lines → /structures/preview.
  const [previewCtc, setPreviewCtc] = useState('1200000');
  const [previewLines, setPreviewLines] = useState([]); // [{ componentId, calcMethod, calcValue }]
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState('');
  const [components, setComponents] = useState([]);
  const [entities, setEntities] = useState([]);

  const load = useCallback(() => {
    setError('');
    get('/api/hr/compensation/structures', { page: 1, pageSize: 100 })
      .then((r) => setRows(asList(r)))
      .catch((e) => { setError(e.message || 'Failed to load structures.'); setRows([]); });
    get('/api/hr/compensation/components', { page: 1, pageSize: 100 })
      .then((r) => setComponents(asList(r))).catch(() => {});
    // Entities carry the authoritative countryCode + payCurrency per market.
    get('/api/hr/payroll/entities')
      .then((r) => setEntities(r?.items || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // When the operator picks an entity, derive its country + currency so the form
  // (and the preview's 50%-rule gating) follow the entity's market automatically.
  function selectEntity(id) {
    const en = entities.find((e) => e.id === id) || null;
    setDraft((d) => ({
      ...d,
      entityId: id,
      countryCode: en ? String(en.countryCode || '').toUpperCase() : '',
      currencyCode: en ? (en.payCurrency || '') : '',
    }));
  }

  // Debounced live preview of the CTC waterfall + 50% chip. Requires a resolved
  // country (from the chosen entity) so the preview's statutory gating matches
  // the entity's market — no India 50% chip before an entity is picked.
  useEffect(() => {
    if (!previewLines.length || !previewCtc || !draft.countryCode) { setPreview(null); return; }
    const h = setTimeout(() => {
      setPreviewErr('');
      post('/api/hr/compensation/structures/preview', {
        basis: draft.basis,
        countryCode: draft.countryCode,
        target: draft.basis === 'CTC' ? { ctcAnnual: previewCtc } : { grossMonthly: previewCtc },
        lines: previewLines,
      })
        .then(setPreview)
        .catch((e) => { setPreview(null); setPreviewErr(e.data?.message || e.message || 'Preview failed.'); });
    }, 350);
    return () => clearTimeout(h);
  }, [previewLines, previewCtc, draft.basis, draft.countryCode]);

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      // entityId/countryCode/currencyCode/basis are required by the API.
      await post('/api/hr/compensation/structures', { ...draft, lines: previewLines });
      setDraft({ name: '', code: '', entityId: '', countryCode: '', currencyCode: '', basis: 'CTC' });
      load();
    } catch (e) { setError(e.data?.message || e.message || 'Failed to create.'); }
    finally { setSaving(false); }
  }

  function addLine() {
    const first = components[0];
    setPreviewLines((ls) => [...ls, { componentId: first?.id || '', calcMethod: first?.calcMethod || 'FLAT', calcValue: '' }]);
  }

  const verdict = preview?.wagesVerdict;
  const columns = [
    { key: 'name', header: 'Structure', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => r.code || '—' },
    { key: 'basis', header: 'Basis', render: (r) => r.basis || '—' },
    { key: 'lines', header: 'Lines', render: (r) => (Array.isArray(r.lines) ? r.lines.length : '—') },
  ];

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        {error && <ErrorBanner message={error} />}
        <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No salary structures yet." />

        {/* Live builder + preview */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Builder + live CTC preview</h2>
          <div className="flex gap-2 items-end">
            <TextInput label={draft.basis === 'CTC' ? 'Target CTC (annual)' : 'Target gross (monthly)'} type="number" value={previewCtc} onChange={setPreviewCtc} />
            <button type="button" onClick={addLine} className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">+ line</button>
          </div>
          {previewLines.map((ln, i) => (
            <div key={i} className="flex gap-2 items-center">
              <select value={ln.componentId} onChange={(e) => setPreviewLines((ls) => ls.map((x, j) => j === i ? { ...x, componentId: e.target.value } : x))} className="px-2 py-1.5 border border-gray-300 rounded text-sm flex-1">
                {components.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
              </select>
              <select value={ln.calcMethod} onChange={(e) => setPreviewLines((ls) => ls.map((x, j) => j === i ? { ...x, calcMethod: e.target.value } : x))} className="px-2 py-1.5 border border-gray-300 rounded text-sm w-32">
                {CALC_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {ln.calcMethod !== 'BALANCING' && (
                <input value={ln.calcValue} onChange={(e) => setPreviewLines((ls) => ls.map((x, j) => j === i ? { ...x, calcValue: e.target.value } : x))} placeholder="value" className="px-2 py-1.5 border border-gray-300 rounded text-sm w-24" />
              )}
              <button type="button" onClick={() => setPreviewLines((ls) => ls.filter((_, j) => j !== i))} className="text-red-500 text-sm">×</button>
            </div>
          ))}
          {previewErr && <p className="text-xs text-red-600">{previewErr}</p>}
          {preview && (
            <div className="rounded-lg bg-gray-50 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-gray-500">Gross (monthly)</span><span className="font-medium">{(preview.waterfall.grossMonthlyMinor / 100).toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Employer cost (monthly)</span><span>{(preview.employerCost.monthlyMinor / 100).toLocaleString()}</span></div>
              {preview.resolved.map((r) => (
                <div key={r.code} className="flex justify-between text-xs text-gray-600"><span>{r.code}{r.isBalancing ? ' (balancing)' : ''}</span><span>{(r.amountMonthlyMinor / 100).toLocaleString()}</span></div>
              ))}
              {verdict && verdict.applies && (
                <div className={`mt-2 inline-block px-2 py-1 rounded text-xs font-medium ${verdict.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                  India 50% rule: {verdict.ok ? 'OK' : 'BREACH'} (Basic+DA {(preview.basicDaMonthlyMinor / 100).toLocaleString()})
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
        <h2 className="text-sm font-semibold text-gray-900">Add structure</h2>
        <TextInput label="Name" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} required />
        <TextInput label="Code" value={draft.code} onChange={(v) => setDraft((d) => ({ ...d, code: v }))} required />
        {/* Entity drives the market: countryCode + currency are derived from it,
            not typed, so an NZ entity can never be saved as an India structure. */}
        <label className="block text-sm">
          <span className="text-gray-700 font-medium">Entity</span>
          <select
            value={draft.entityId}
            onChange={(e) => selectEntity(e.target.value)}
            required
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Select entity…</option>
            {entities.map((en) => (
              <option key={en.id} value={en.id}>{en.code} — {en.legalName} ({en.countryCode})</option>
            ))}
          </select>
        </label>
        <div className="text-xs text-gray-500">
          Country: <span className="font-medium text-gray-700">{draft.countryCode || '—'}</span>
          {' · '}Currency: <span className="font-medium text-gray-700">{draft.currencyCode || '—'}</span>
        </div>
        <Select label="Basis" value={draft.basis} options={['CTC', 'GROSS', 'NET']} onChange={(v) => setDraft((d) => ({ ...d, basis: v }))} />
        {verdict && verdict.applies && !verdict.ok && (
          <p className="text-xs text-red-600">Basic + DA must be ≥ 50% of gross — save is blocked.</p>
        )}
        <PrimaryButton type="submit" loading={saving} disabled={!!(verdict && verdict.applies && !verdict.ok)}>Save</PrimaryButton>
      </form>
    </div>
  );
}

function RevisionsTab() {
  const [employeeId, setEmployeeId] = useState('');
  const [active, setActive] = useState('');
  const [rows, setRows] = useState(null);
  const [visibility, setVisibility] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ effectiveFrom: '', ctcAnnual: '', structureId: '', entityId: '', currencyCode: 'INR', basis: 'CTC', revisionReason: 'ANNUAL_REVISION' });

  const load = useCallback((id) => {
    if (!id) return;
    setLoading(true); setError('');
    get(`/api/hr/compensation/employees/${id}/revisions`)
      .then((r) => { setRows(asList(r)); setVisibility(r.visibility || (r.items?.[0]?.visibility) || null); })
      .catch((e) => { setError(e.message || 'Failed to load revisions.'); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  function onLookup(e) { e.preventDefault(); const id = employeeId.trim(); setActive(id); setRows(null); load(id); }

  async function onCreate(e) {
    e.preventDefault();
    if (!active) return;
    setSaving(true); setError('');
    try {
      // revisionReason (NOT reason), entityId/currencyCode/basis required.
      const payload = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      await post(`/api/hr/compensation/employees/${active}/revisions`, payload);
      setDraft({ effectiveFrom: '', ctcAnnual: '', structureId: '', entityId: '', currencyCode: 'INR', basis: 'CTC', revisionReason: 'ANNUAL_REVISION' });
      load(active);
    } catch (e) { setError(e.data?.message || e.message || 'Failed to create revision.'); }
    finally { setSaving(false); }
  }

  // Masked rows: ABSOLUTE/SELF show money; RANGE_ONLY shows compa-ratio only.
  const columns = [
    { key: 'effectiveFrom', header: 'Effective from', render: (r) => formatAdminDate(r.effectiveFrom) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status || '—'} /> },
    { key: 'ctc', header: 'CTC (annual)', render: (r) => r.absolute ? moneyish(r.absolute.ctcAnnual) : (r.range ? `••• (compa ${r.range.compaRatio ?? '—'})` : '•••') },
    { key: 'visibility', header: 'Visibility', render: (r) => r.visibility || '—' },
  ];

  return (
    <div>
      <form onSubmit={onLookup} className="flex gap-2 mb-4">
        <input value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="Employee ID"
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm w-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]" />
        <button type="submit" className="px-4 py-2.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Load revisions</button>
      </form>

      {error && <ErrorBanner message={error} />}
      {visibility === 'RANGE_ONLY' && <p className="text-xs text-amber-700 mb-2">Range-only view: absolute amounts are hidden (compa-ratio shown).</p>}

      {!active ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-500">
          Enter an employee ID to view and add salary revisions.
        </div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <DataTable columns={columns} rows={rows} loading={loading} emptyText="No revisions for this employee." />
          </div>
          <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
            <h2 className="text-sm font-semibold text-gray-900">New revision</h2>
            <DateField label="Effective from" value={draft.effectiveFrom} onChange={(v) => setDraft((d) => ({ ...d, effectiveFrom: v }))} required />
            <TextInput label="Entity ID" value={draft.entityId} onChange={(v) => setDraft((d) => ({ ...d, entityId: v }))} required />
            <TextInput label="CTC (annual)" type="number" value={draft.ctcAnnual} onChange={(v) => setDraft((d) => ({ ...d, ctcAnnual: v }))} />
            <TextInput label="Currency" value={draft.currencyCode} onChange={(v) => setDraft((d) => ({ ...d, currencyCode: v }))} required />
            <Select label="Basis" value={draft.basis} options={['CTC', 'GROSS', 'NET']} onChange={(v) => setDraft((d) => ({ ...d, basis: v }))} />
            <Select label="Reason" value={draft.revisionReason} options={['ANNUAL_REVISION', 'PROMOTION', 'CORRECTION', 'RESTRUCTURE', 'STATUTORY_ADJUSTMENT']} onChange={(v) => setDraft((d) => ({ ...d, revisionReason: v }))} />
            <TextInput label="Structure ID" value={draft.structureId} onChange={(v) => setDraft((d) => ({ ...d, structureId: v }))} />
            <PrimaryButton type="submit" loading={saving}>Save revision</PrimaryButton>
          </form>
        </div>
      )}
    </div>
  );
}

// Minimal labelled <select> (the design system exposes TextInput/DateField but
// not a Select; this keeps the same look without pulling in a new dependency).
function Select({ label, value, options, onChange }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export default function CompensationPage() {
  const [tab, setTab] = useState('components');
  return (
    <div>
      <PageHeader title="Compensation" subtitle="Pay components, salary structures and revisions" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'components' && <ComponentsTab />}
      {tab === 'structures' && <StructuresTab />}
      {tab === 'revisions' && <RevisionsTab />}
    </div>
  );
}

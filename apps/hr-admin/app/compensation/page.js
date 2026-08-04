'use client';

// Compensation console against /api/hr/compensation/* (reads need
// canViewCompensation, writes canManageCompensation — enforced backend-side).
//  - Components: GET/POST/PATCH /components — the FULL P1.3 authoring surface
//    (kind/category/calcMethod incl. SLAB bands, wage/tax flags, proration,
//    floor/cap clamps, percent/slab bases). derivationPass is server-computed.
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
import { ErrorBanner, PrimaryButton, TextInput, DateField, Modal, ModalActions, formatAdminDate } from '@hr/ui';
import { get, post, patch, del, downloadFile } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, moneyish } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';
// Entities (and their authoritative countryCode) back the structure form's
// country/currency derivation; imported directly via /api/hr/payroll/entities.

const TABS = [
  { key: 'components', label: 'Pay components' },
  { key: 'structures', label: 'Salary structures' },
  { key: 'revisions', label: 'Employee revisions' },
  { key: 'proposals', label: 'Approvals' },
];

// ── P1.3 full component authoring surface ──────────────────────────────────
// All India-relevant kinds, grouped for the <select>. NZ-only kinds
// (KIWISAVER_*, PAYE, STUDENT_LOAN, ESCT, ACC_EMPLOYER) are deliberately NOT
// offered here — likewise the NZ isKiwiSaverable/isPayeable flags stay on
// their server defaults.
const KIND_GROUPS = [
  { label: 'Earnings', options: ['BASIC', 'DEARNESS_ALLOWANCE', 'HRA', 'SPECIAL_ALLOWANCE', 'CONVEYANCE', 'MEDICAL', 'LTA', 'BONUS', 'COMMISSION', 'OVERTIME_PAY', 'ARREAR'] },
  { label: 'Statutory deductions', options: ['PF_EMPLOYEE', 'ESI_EMPLOYEE', 'PT', 'TDS'] },
  { label: 'Employer cost', options: ['PF_EMPLOYER', 'ESI_EMPLOYER', 'EPS', 'EDLI', 'PF_ADMIN', 'GRATUITY_PROVISION'] },
  { label: 'Recoveries / others', options: ['LOAN_REPAYMENT', 'ADVANCE_RECOVERY', 'LEAVE_ENCASHMENT', 'NOTICE_RECOVERY', 'REIMBURSEMENT_FUEL', 'REIMBURSEMENT_PHONE', 'CUSTOM'] },
];
const CATEGORIES = ['EARNING', 'DEDUCTION', 'EMPLOYER_COST', 'REIMBURSEMENT'];
// Structure-line override methods (structures tab builder) — unchanged: SLAB
// is authored at component level, so it is not offered on structure lines.
const CALC_METHODS = ['FLAT', 'PERCENT_OF', 'BALANCING', 'FORMULA', 'STATUTORY'];
const COMPONENT_CALC_METHODS = ['FLAT', 'PERCENT_OF', 'SLAB', 'BALANCING', 'FORMULA', 'STATUTORY'];
// calcBaseScope MULTIPLE exists backend-side but has no multi-base editor yet.
const BASE_SCOPES = [
  { value: 'SINGLE', label: 'Another component' },
  { value: 'GROSS', label: 'Gross (all earnings)' },
  { value: 'CTC', label: 'CTC' },
];
const PRORATION_METHODS = [
  { value: 'CALENDAR_DAYS', label: 'Calendar days' },
  { value: 'WORKING_DAYS', label: 'Working days' },
  { value: 'THIRTY_DAY_STANDARD', label: '30-day standard' },
  { value: 'TWENTYSIX_DAY_STANDARD', label: '26-day (factory) basis' },
  { value: 'NONE', label: 'None (never prorated)' },
];
// Compact chips for the table's Flags column: [field, chip label].
const FLAG_CHIPS = [
  ['isWageForPF', 'PF'], ['isWageForESI', 'ESI'], ['isWageForPT', 'PT'],
  ['isWageForGratuity', 'Grat'], ['isTaxable', 'Tax'],
];
const EMPTY_BAND = { upTo: '', value: '', valueType: 'FLAT' };

function emptyComponentDraft() {
  return {
    name: '', code: '', kind: 'BASIC', category: 'EARNING',
    calcMethod: 'FLAT', calcValue: '', calcBaseScope: 'SINGLE', calcBaseCode: '',
    isWageForPF: false, isWageForESI: false, isWageForPT: false, isWageForGratuity: false,
    isTaxable: true, taxSection: '', minWageFloorApplies: false,
    isRecurring: true, prorationMethod: 'CALENDAR_DAYS',
    floorValue: '', capValue: '', glCode: '', sortOrder: '',
    slabs: [{ ...EMPTY_BAND }], isActive: true,
  };
}

// Row → edit draft (Prisma Decimals arrive JSON-serialized; keep as strings).
function draftFromComponent(c) {
  const s = (v) => (v == null ? '' : String(v));
  return {
    name: c.name || '', code: c.code || '', kind: c.kind || 'BASIC', category: c.category || 'EARNING',
    calcMethod: c.calcMethod || 'FLAT', calcValue: s(c.calcValue),
    calcBaseScope: c.calcBaseScope === 'GROSS' || c.calcBaseScope === 'CTC' ? c.calcBaseScope : 'SINGLE',
    calcBaseCode: c.calcBaseCode || '',
    isWageForPF: !!c.isWageForPF, isWageForESI: !!c.isWageForESI,
    isWageForPT: !!c.isWageForPT, isWageForGratuity: !!c.isWageForGratuity,
    isTaxable: c.isTaxable !== false, taxSection: c.taxSection || '',
    minWageFloorApplies: !!c.minWageFloorApplies,
    isRecurring: c.isRecurring !== false, prorationMethod: c.prorationMethod || 'CALENDAR_DAYS',
    floorValue: s(c.floorValue), capValue: s(c.capValue), glCode: c.glCode || '', sortOrder: s(c.sortOrder),
    slabs: Array.isArray(c.slabsJson) && c.slabsJson.length
      ? c.slabsJson.map((b) => ({
          upTo: b?.upTo == null ? '' : String(b.upTo),
          value: b?.value == null ? '' : String(b.value),
          valueType: b?.valueType === 'PERCENT' ? 'PERCENT' : 'FLAT',
        }))
      : [{ ...EMPTY_BAND }],
    isActive: c.isActive !== false,
  };
}

// Draft → POST/PATCH body. `code` only on create (immutable after). slabsJson
// is only sent when the method is SLAB (stale bands are inert otherwise, and
// a Json column can't take a plain-null clear). derivationPass is NEVER sent
// — the server computes it from calcMethod + base scope.
function buildComponentPayload(draft, { includeCode = false } = {}) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const method = draft.calcMethod;
  const usesBase = method === 'PERCENT_OF' || method === 'SLAB';
  const scope = usesBase ? draft.calcBaseScope : 'SINGLE';
  const payload = {
    name: draft.name, kind: draft.kind, category: draft.category, calcMethod: method,
    calcValue: method === 'FLAT' || method === 'PERCENT_OF' || method === 'FORMULA' ? num(draft.calcValue) : null,
    calcBaseScope: scope,
    calcBaseCode: usesBase && scope === 'SINGLE' ? draft.calcBaseCode || null : null,
    isWageForPF: !!draft.isWageForPF, isWageForESI: !!draft.isWageForESI,
    isWageForPT: !!draft.isWageForPT, isWageForGratuity: !!draft.isWageForGratuity,
    isTaxable: !!draft.isTaxable,
    taxSection: draft.isTaxable && draft.taxSection ? draft.taxSection : null,
    minWageFloorApplies: !!draft.minWageFloorApplies,
    isRecurring: !!draft.isRecurring, prorationMethod: draft.prorationMethod,
    floorValue: num(draft.floorValue), capValue: num(draft.capValue),
    glCode: draft.glCode || null,
    sortOrder: draft.sortOrder === '' ? 0 : Math.trunc(Number(draft.sortOrder)) || 0,
  };
  if (includeCode) payload.code = draft.code;
  if (method === 'SLAB') {
    payload.slabsJson = draft.slabs.map((b) => ({
      upTo: b.upTo === '' || b.upTo == null ? null : Number(b.upTo),
      value: num(b.value),
      valueType: b.valueType === 'PERCENT' ? 'PERCENT' : 'FLAT',
    }));
  }
  return payload;
}

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

// Human sentence for the band editor, e.g. "Base ≤ ₹10,000 → ₹200 ·
// ₹10,001–₹20,000 → ₹400 · above → 2% of base".
function slabHint(bands) {
  const parts = [];
  let prev = null;
  for (const b of bands) {
    const val = b.value === '' ? '?' : b.valueType === 'PERCENT' ? `${b.value}% of base` : inr(b.value);
    if (b.upTo === '' || b.upTo == null) {
      parts.push(`above → ${val}`);
    } else {
      parts.push(prev == null ? `Base ≤ ${inr(b.upTo)} → ${val}` : `${inr(prev + 1)}–${inr(b.upTo)} → ${val}`);
      prev = Number(b.upTo);
    }
  }
  return parts.join(' · ');
}

function SectionHeading({ children }) {
  return <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{children}</p>;
}

function CheckboxField({ label, checked, onChange, tip }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex items-center text-gray-700">{label}{tip && <InfoTip text={tip} />}</span>
    </label>
  );
}

// Base picker for PERCENT_OF / SLAB: Another component (scope SINGLE) | GROSS
// | CTC. SINGLE offers the OTHER components' codes plus a free-text fallback
// for a code that isn't created yet.
function BasePicker({ draft, update, componentOptions }) {
  const known = componentOptions.some((c) => c.code === draft.calcBaseCode);
  const [freeText, setFreeText] = useState(Boolean(draft.calcBaseCode) && !known);
  return (
    <>
      <Select label="Base" tip="What the value applies to: another component's amount, the monthly gross, or the monthly CTC." value={draft.calcBaseScope} options={BASE_SCOPES} onChange={(v) => update('calcBaseScope', v)} />
      {draft.calcBaseScope === 'SINGLE' && (
        <>
          <label className="block">
            <span className="flex items-center text-sm font-medium text-gray-700 mb-1">Base component</span>
            <select
              value={freeText ? '__other__' : draft.calcBaseCode}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__other__') setFreeText(true);
                else { setFreeText(false); update('calcBaseCode', v); }
              }}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]"
            >
              <option value="">Select component…</option>
              {componentOptions.map((c) => <option key={c.id} value={c.code}>{c.code} — {c.name}</option>)}
              <option value="__other__">Other (type a code)…</option>
            </select>
          </label>
          {freeText && (
            <TextInput label="Base component code" value={draft.calcBaseCode} onChange={(v) => update('calcBaseCode', v)} placeholder="e.g. BASIC" required />
          )}
        </>
      )}
    </>
  );
}

// SLAB band editor: bracket-lookup rows over the base. Max 20 bands; only the
// last may be open-ended (Up to left empty).
function SlabEditor({ draft, setDraft }) {
  const bands = draft.slabs;
  const setBand = (i, bandPatch) => setDraft((d) => ({ ...d, slabs: d.slabs.map((b, j) => (j === i ? { ...b, ...bandPatch } : b)) }));
  return (
    <div className="space-y-1.5">
      <span className="flex items-center text-sm font-medium text-gray-700">
        Slab bands
        <InfoTip text="PT-style bracket lookup: the WHOLE base falls into exactly ONE band — bands are not progressive. Leave 'Up to' empty on the last band for 'and above'. Max 20 bands." />
      </span>
      {bands.map((b, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input type="number" min="0" step="any" value={b.upTo} onChange={(e) => setBand(i, { upTo: e.target.value })} placeholder={i === bands.length - 1 ? 'and above' : 'Up to ₹'} className="px-2 py-1.5 border border-gray-300 rounded text-sm w-28" />
          <input type="number" min="0" step="any" required value={b.value} onChange={(e) => setBand(i, { value: e.target.value })} placeholder="Value" className="px-2 py-1.5 border border-gray-300 rounded text-sm flex-1 min-w-0" />
          <select value={b.valueType} onChange={(e) => setBand(i, { valueType: e.target.value })} className="px-2 py-1.5 border border-gray-300 rounded text-sm w-28">
            <option value="FLAT">₹ flat</option>
            <option value="PERCENT">% of base</option>
          </select>
          <button type="button" onClick={() => setDraft((d) => ({ ...d, slabs: d.slabs.filter((_, j) => j !== i) }))} disabled={bands.length === 1} className="text-red-500 text-sm disabled:opacity-30" aria-label={`Remove band ${i + 1}`}>×</button>
        </div>
      ))}
      <button type="button" onClick={() => setDraft((d) => (d.slabs.length >= 20 ? d : { ...d, slabs: [...d.slabs, { ...EMPTY_BAND }] }))} disabled={bands.length >= 20} className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">+ band</button>
      {bands.some((b) => b.value !== '') && <p className="text-xs text-gray-500">{slabHint(bands)}</p>}
    </div>
  );
}

// The FULL P1.3 authoring surface, shared by the create card and the edit
// modal. `componentOptions` feeds the PERCENT_OF/SLAB base picker (the
// component's own code is excluded by the caller); on edit the immutable code
// is display-only and never sent.
function ComponentFormFields({ draft, setDraft, componentOptions, isEdit = false }) {
  const update = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const method = draft.calcMethod;
  return (
    <>
      <SectionHeading>Identity</SectionHeading>
      <TextInput label={<>Name <InfoTip text="A pay component is one line on the salary, e.g. Basic, HRA, Special Allowance. This is its display name on payslips." /></>} value={draft.name} onChange={(v) => update('name', v)} required />
      {isEdit ? (
        <p className="text-xs text-gray-500">Code <span className="font-mono text-gray-700">{draft.code}</span> is immutable.</p>
      ) : (
        <TextInput label={<>Code <InfoTip text="A short unique key (e.g. BASIC, HRA) used by formulas and statutory rules. Cannot be changed once used in a structure." /></>} value={draft.code} onChange={(v) => update('code', v)} required />
      )}
      <Select label="Kind" tip="The statutory nature of this component (Basic, HRA, PF, gratuity provision…). Drives PF/ESI/tax treatment in India." value={draft.kind} groups={KIND_GROUPS} onChange={(v) => update('kind', v)} />
      <Select label="Category" tip="Whether this adds to pay (Earning), reduces it (Deduction), is a cost to the employer, or a reimbursement." value={draft.category} options={CATEGORIES} onChange={(v) => update('category', v)} />

      <SectionHeading>Calculation</SectionHeading>
      <Select label="Calc method" tip="How the amount is worked out: a Flat figure, a Percent of a base, bracketed Slab bands, a Balancing fill-to-target, a Formula, or a Statutory rule." value={method} options={COMPONENT_CALC_METHODS} onChange={(v) => update('calcMethod', v)} />
      {method === 'FLAT' && (
        <TextInput label="Amount (monthly ₹)" type="number" min="0" step="any" value={draft.calcValue} onChange={(v) => update('calcValue', v)} required />
      )}
      {method === 'PERCENT_OF' && (
        <>
          <TextInput label={<>Percent <InfoTip text="0–1000. E.g. 50 = half of the base; values over 100 suit multiplier-style components." /></>} type="number" min="0" max="1000" step="any" value={draft.calcValue} onChange={(v) => update('calcValue', v)} required />
          <BasePicker draft={draft} update={update} componentOptions={componentOptions} />
        </>
      )}
      {method === 'SLAB' && (
        <>
          <BasePicker draft={draft} update={update} componentOptions={componentOptions} />
          <SlabEditor draft={draft} setDraft={setDraft} />
        </>
      )}
      {method === 'BALANCING' && (
        <p className="text-xs text-amber-700">Balancing (fills to target) — the amount is derived so the structure hits its CTC/gross target, not entered. At most one balancing component per structure.</p>
      )}
      {method === 'FORMULA' && (
        <>
          <p className="text-xs text-gray-500">Hours-driven (e.g. overtime): calcValue = rate per hour.</p>
          <TextInput label="Rate per hour (₹)" type="number" min="0" step="any" value={draft.calcValue} onChange={(v) => update('calcValue', v)} />
        </>
      )}
      {method === 'STATUTORY' && (
        <p className="text-xs text-gray-500">Computed by the statutory engine (PF/ESI/PT/TDS) — no inputs here.</p>
      )}

      <SectionHeading>Statutory flags</SectionHeading>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <CheckboxField label="PF wages" checked={draft.isWageForPF} onChange={(v) => update('isWageForPF', v)} tip="Counts toward EPF wages when the engine computes PF contributions." />
        <CheckboxField label="ESI wages" checked={draft.isWageForESI} onChange={(v) => update('isWageForESI', v)} tip="Counts toward ESI wages (and the ESI eligibility gross)." />
        <CheckboxField label="PT wages" checked={draft.isWageForPT} onChange={(v) => update('isWageForPT', v)} tip="Counts toward the professional-tax slab base." />
        <CheckboxField label="Gratuity wages" checked={draft.isWageForGratuity} onChange={(v) => update('isWageForGratuity', v)} tip="Counts toward gratuity wages (typically Basic + DA)." />
      </div>
      <CheckboxField label="Taxable" checked={draft.isTaxable} onChange={(v) => update('isTaxable', v)} tip="Included in income-tax (TDS) computation. Untick for fully exempt components." />
      {draft.isTaxable && (
        <TextInput label={<>Tax section <InfoTip text="Optional India exemption section shown on tax statements, e.g. 10(13A) for HRA." /></>} value={draft.taxSection} onChange={(v) => update('taxSection', v)} placeholder="e.g. 10(13A)" />
      )}
      <CheckboxField label="Counts toward min-wage Basic floor" checked={draft.minWageFloorApplies} onChange={(v) => update('minWageFloorApplies', v)} tip="This component's amount counts when checking the state minimum-wage floor on Basic." />

      <SectionHeading>Behaviour</SectionHeading>
      <CheckboxField label="Recurring (every pay run)" checked={draft.isRecurring} onChange={(v) => update('isRecurring', v)} tip="Untick for one-time lines like a bonus or an arrear." />
      <Select label="Proration" tip="How a partial month (mid-month joining/leaving, LOP) scales this amount." value={draft.prorationMethod} options={PRORATION_METHODS} onChange={(v) => update('prorationMethod', v)} />
      <div className="grid grid-cols-2 gap-2">
        <TextInput label={<>Monthly floor ₹ <InfoTip text="Optional clamp applied after calculation — the monthly amount never drops below this. Floor cannot exceed cap." /></>} type="number" min="0" step="any" value={draft.floorValue} onChange={(v) => update('floorValue', v)} />
        <TextInput label={<>Monthly cap ₹ <InfoTip text="Optional clamp applied after calculation — the monthly amount never exceeds this." /></>} type="number" min="0" step="any" value={draft.capValue} onChange={(v) => update('capValue', v)} />
      </div>
      <TextInput label={<>GL code <InfoTip text="Optional general-ledger account code for finance exports." /></>} value={draft.glCode} onChange={(v) => update('glCode', v)} />
      <TextInput label={<>Sort order <InfoTip text="Lower numbers appear first on payslips and in pickers." /></>} type="number" step="1" value={draft.sortOrder} onChange={(v) => update('sortOrder', v)} />
    </>
  );
}

// ── Edit-component modal (PATCH /components/:id) — the same FULL P1.3 surface
// as the create card; code is immutable (shown read-only, never sent). ──
function EditComponentModal({ component, components, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => draftFromComponent(component));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await patch(`/api/hr/compensation/components/${component.id}`, { ...buildComponentPayload(draft), isActive: draft.isActive });
      onSaved();
    } catch (err) { setError(err.data?.message || err.message || 'Failed to update.'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Edit ${component.code || 'component'}`} size="lg" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <ComponentFormFields draft={draft} setDraft={setDraft} componentOptions={(components || []).filter((c) => c.id !== component.id)} isEdit />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft((d) => ({ ...d, isActive: e.target.checked }))} />
          <span className="text-gray-700">Active</span>
        </label>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>Save changes</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Pay components — P1.3 full authoring: wage/tax flags, proration,
// floor/cap clamps, percent/slab bases and SLAB bands + edit/delete rows ──
function ComponentsTab({ canManage }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [draft, setDraft] = useState(emptyComponentDraft);

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
      // code/name/kind/category/calcMethod required; the rest of the P1.3
      // surface (flags, proration, clamps, bases, slabsJson) rides along.
      await post('/api/hr/compensation/components', buildComponentPayload(draft, { includeCode: true }));
      setDraft(emptyComponentDraft());
      load();
    } catch (e) { setError(e.data?.message || e.message || 'Failed to create.'); }
    finally { setSaving(false); }
  }

  async function onDelete(row) {
    if (!window.confirm(`Deactivate component "${row.name}" (${row.code})? It will be hidden from new structures.`)) return;
    setBusyId(row.id); setError('');
    try { await del(`/api/hr/compensation/components/${row.id}`); load(); }
    catch (e) { setError(e.data?.message || e.message || 'Failed to delete.'); }
    finally { setBusyId(''); }
  }

  const columns = [
    { key: 'name', header: 'Component', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => r.code || '—' },
    { key: 'kind', header: 'Kind', render: (r) => r.kind || '—' },
    { key: 'category', header: 'Category', render: (r) => <StatusBadge status={r.category} /> },
    {
      key: 'calcMethod', header: 'Calc',
      render: (r) => {
        if (r.calcMethod !== 'SLAB') return r.calcMethod || '—';
        const n = Array.isArray(r.slabsJson) ? r.slabsJson.length : 0;
        return `SLAB (${n} ${n === 1 ? 'band' : 'bands'})`;
      },
    },
    {
      key: 'flags', header: 'Flags',
      render: (r) => {
        const chips = FLAG_CHIPS.filter(([field]) => r[field]).map(([, chip]) => chip);
        if (!chips.length) return <span className="text-xs text-gray-400">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <span key={chip} className="px-1.5 py-0.5 rounded bg-gray-100 text-[10px] font-medium text-gray-600">{chip}</span>
            ))}
          </div>
        );
      },
    },
  ];
  if (canManage) {
    columns.push({
      key: 'actions', header: '',
      render: (r) => (
        <div className="flex items-center gap-1.5 justify-end">
          <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
          <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => onDelete(r)}>Delete</ActionButton>
        </div>
      ),
    });
  }

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        {error && <ErrorBanner message={error} />}
        <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No pay components yet." />
      </div>
      {canManage ? (
        <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
          <h2 className="text-sm font-semibold text-gray-900">Add component</h2>
          <ComponentFormFields draft={draft} setDraft={setDraft} componentOptions={(rows || []).filter((c) => c.code !== draft.code)} />
          <PrimaryButton type="submit" loading={saving}>Save</PrimaryButton>
        </form>
      ) : (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500 h-fit">
          You have read-only access to compensation. Editing requires the Manage Compensation permission.
        </div>
      )}
      {editing && <EditComponentModal component={editing} components={rows || []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

// ── Edit-structure modal (PATCH /structures/:id) — finding #27. Lines are set
// at create time; this edits the header fields (name/basis/active). ──
function EditStructureModal({ structure, onClose, onSaved }) {
  const [draft, setDraft] = useState({
    name: structure.name || '', basis: structure.basis || 'CTC', isActive: structure.isActive !== false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await patch(`/api/hr/compensation/structures/${structure.id}`, draft);
      onSaved();
    } catch (err) { setError(err.data?.message || err.message || 'Failed to update.'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Edit ${structure.code || 'structure'}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <p className="text-xs text-gray-500">Code <span className="font-mono text-gray-700">{structure.code}</span> and component lines are fixed at creation.</p>
        <TextInput label="Name" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} required />
        <Select label="Basis" value={draft.basis} options={['CTC', 'GROSS', 'NET']} onChange={(v) => setDraft((d) => ({ ...d, basis: v }))} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft((d) => ({ ...d, isActive: e.target.checked }))} />
          <span className="text-gray-700">Active</span>
        </label>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>Save changes</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Salary structures — real create contract + live CTC preview ──
function StructuresTab({ canManage }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // countryCode/currencyCode are DERIVED from the chosen entity — never typed.
  // An India entity yields IN + INR, so the India Code-on-Wages 50% rule applies
  // (the engine keys the rule on countryCode).
  const [draft, setDraft] = useState({ name: '', code: '', entityId: '', countryCode: '', currencyCode: '', basis: 'CTC' });
  // Live preview: a target CTC + the structure's lines → /structures/preview.
  const [previewCtc, setPreviewCtc] = useState('1200000');
  const [previewLines, setPreviewLines] = useState([]); // [{ componentId, calcMethod, calcValue }]
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState('');
  const [components, setComponents] = useState([]);
  const [entities, setEntities] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState('');

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
    // Mirror the backend rule (#27): a structure must declare at least one line.
    if (!previewLines.length) { setError('Add at least one component line in the builder before saving.'); return; }
    setSaving(true); setError('');
    try {
      // entityId/countryCode/currencyCode/basis are required by the API.
      await post('/api/hr/compensation/structures', { ...draft, lines: previewLines });
      setDraft({ name: '', code: '', entityId: '', countryCode: '', currencyCode: '', basis: 'CTC' });
      setPreviewLines([]);
      load();
    } catch (e) { setError(e.data?.message || e.message || 'Failed to create.'); }
    finally { setSaving(false); }
  }

  async function onDelete(row) {
    if (!window.confirm(`Deactivate structure "${row.name}" (${row.code})?`)) return;
    setBusyId(row.id); setError('');
    try { await del(`/api/hr/compensation/structures/${row.id}`); load(); }
    catch (e) { setError(e.data?.message || e.message || 'Failed to delete.'); }
    finally { setBusyId(''); }
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
    { key: 'active', header: 'Active', render: (r) => (r.isActive === false ? <span className="text-xs text-gray-400">Inactive</span> : <span className="text-xs text-emerald-600">Yes</span>) },
  ];
  if (canManage) {
    columns.push({
      key: 'actions', header: '',
      render: (r) => (
        <div className="flex items-center gap-1.5 justify-end">
          <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
          <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => onDelete(r)}>Delete</ActionButton>
        </div>
      ),
    });
  }

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
        <TextInput label={<>Name <InfoTip text="A salary structure is a reusable template of pay components (Basic, HRA…) that you apply to employees. This is its name." /></>} value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} required />
        <TextInput label={<>Code <InfoTip text="A short unique key for this structure, used when assigning it to employees." /></>} value={draft.code} onChange={(v) => setDraft((d) => ({ ...d, code: v }))} required />
        {/* Entity drives the market: countryCode + currency are derived from it,
            not typed — an India entity yields an India (INR) structure. */}
        <label className="block text-sm">
          <span className="flex items-center text-gray-700 font-medium">Entity<InfoTip text="The legal entity this structure belongs to. The country and pay currency are taken from the entity automatically — you don't pick them." /></span>
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
        <Select label="Basis" tip="What the target figure represents: CTC (annual cost to company), Gross (before deductions) or Net (take-home)." value={draft.basis} options={['CTC', 'GROSS', 'NET']} onChange={(v) => setDraft((d) => ({ ...d, basis: v }))} />
        {verdict && verdict.applies && !verdict.ok && (
          <p className="text-xs text-red-600">Basic + DA must be ≥ 50% of gross — save is blocked.</p>
        )}
        {!previewLines.length && <p className="text-xs text-amber-700">Add at least one component line in the builder.</p>}
        <PrimaryButton type="submit" loading={saving} disabled={!previewLines.length || !!(verdict && verdict.applies && !verdict.ok)}>Save</PrimaryButton>
      </form>
      {editing && <EditStructureModal structure={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function RevisionsTab({ canApprove }) {
  const [employeeId, setEmployeeId] = useState('');
  const [active, setActive] = useState('');
  const [rows, setRows] = useState(null);
  const [visibility, setVisibility] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // A checker (canApprove) may commit directly (EFFECTIVE); a maker without it is
  // always routed through PROPOSED server-side. Default the toggle to "propose".
  const [propose, setPropose] = useState(true);
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

  // Per-revision branded CTC PDF download (blob fetch + loading state). The
  // backend RE-APPLIES the F5 masking: an ABSOLUTE/SELF viewer gets the full
  // waterfall, a RANGE_ONLY viewer gets a BANDED statement (compa-ratio, no
  // absolute pay), a NONE viewer is refused 403 — the button never leaks.
  const [pdfBusyId, setPdfBusyId] = useState('');
  async function onDownloadPdf(row) {
    if (!row?.id) return;
    setPdfBusyId(row.id); setError('');
    try {
      await downloadFile(`/api/hr/compensation/revisions/${row.id}/pdf`);
    } catch (e) {
      setError(e.data?.message || e.message || 'Could not download the compensation statement.');
    } finally {
      setPdfBusyId('');
    }
  }

  async function onCreate(e) {
    e.preventDefault();
    if (!active) return;
    setSaving(true); setError(''); setNotice('');
    try {
      // revisionReason (NOT reason), entityId/currencyCode/basis required.
      const payload = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      // Route through the maker-checker queue unless a checker explicitly opts to
      // commit directly. A maker without canApprove is forced to PROPOSED server-side.
      if (propose || !canApprove) payload.propose = true;
      const res = await post(`/api/hr/compensation/employees/${active}/revisions`, payload);
      setDraft({ effectiveFrom: '', ctcAnnual: '', structureId: '', entityId: '', currencyCode: 'INR', basis: 'CTC', revisionReason: 'ANNUAL_REVISION' });
      setNotice(res?.status === 'PROPOSED'
        ? 'Revision proposed — a different approver must approve it from the Approvals tab.'
        : 'Revision saved as effective.');
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
    {
      key: 'pdf', header: '',
      render: (r) => {
        const noneVisible = r.visibility === 'NONE';
        const banded = r.visibility === 'RANGE_ONLY';
        const tip = noneVisible
          ? 'You do not have permission to view this employee’s compensation.'
          : banded
            ? 'Range-only access: the PDF is a banded statement (compa-ratio, no absolute amounts).'
            : 'Download the branded Compensation Statement (PDF).';
        return (
          <div className="flex justify-end" title={tip}>
            <ActionButton disabled={noneVisible || pdfBusyId === r.id} onClick={() => onDownloadPdf(r)}>
              {pdfBusyId === r.id ? 'Preparing…' : banded ? 'PDF (banded)' : 'PDF'}
            </ActionButton>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <form onSubmit={onLookup} className="flex gap-2 mb-4">
        <input value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="Employee ID"
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm w-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]" />
        <button type="submit" className="px-4 py-2.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Load revisions</button>
      </form>

      {error && <ErrorBanner message={error} />}
      {notice && <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-xs text-emerald-700 mb-2">{notice}</div>}
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
            {canApprove ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={propose} onChange={(e) => setPropose(e.target.checked)} />
                <span className="text-gray-700">Propose for approval (separation of duties)</span>
              </label>
            ) : (
              <p className="text-xs text-gray-500">This revision will be <span className="font-medium">proposed</span> and needs a separate approver.</p>
            )}
            <PrimaryButton type="submit" loading={saving}>{(propose || !canApprove) ? 'Propose revision' : 'Save revision'}</PrimaryButton>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Approvals: maker-checker proposals queue (#28) ──
// Lists PROPOSED revisions awaiting a checker; approve/reject wired to
// /revisions/:id/approve|reject. SoD is enforced server-side (the approver must
// differ from the proposer) AND hinted client-side via row.canApprove.
function ProposalsTab({ canApprove, me }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setError('');
    get('/api/hr/compensation/revisions/proposed')
      .then((r) => setRows(asList(r)))
      .catch((e) => { setError(e.data?.message || e.message || 'Failed to load proposals.'); setRows([]); });
  }, []);
  useEffect(() => { if (canApprove) load(); else setRows([]); }, [load, canApprove]);

  async function act(row, action) {
    setBusyId(`${row.id}:${action}`); setError('');
    try {
      await post(`/api/hr/compensation/revisions/${row.id}/${action}`, {});
      load();
    } catch (e) { setError(e.data?.message || e.message || `Failed to ${action}.`); }
    finally { setBusyId(''); }
  }

  if (!canApprove) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-500">
        The approvals queue is for checkers — it needs the Approve Compensation permission.
      </div>
    );
  }

  const columns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{r.employee?.name || r.employee?.code || r.employeeId}</span> },
    { key: 'effectiveFrom', header: 'Effective from', render: (r) => formatAdminDate(r.effectiveFrom) },
    { key: 'reason', header: 'Reason', render: (r) => r.revisionReason || '—' },
    { key: 'ctc', header: 'CTC (annual)', render: (r) => (r.absolute ? moneyish(r.absolute.ctcAnnual, r.currencyCode) : (r.range ? `••• (compa ${r.range.compaRatio ?? '—'})` : '•••')) },
    { key: 'proposed', header: 'Proposed', render: (r) => <span className="text-xs text-gray-500">{formatAdminDate(r.createdAt)}</span> },
    {
      key: 'actions', header: '',
      render: (r) => {
        const sameActor = me && r.proposedById === me.id;
        return (
          <div className="flex items-center gap-1.5 justify-end">
            {sameActor && <span className="text-[11px] text-amber-600 mr-1">Your proposal</span>}
            <ActionButton tone="positive" disabled={!!busyId || sameActor} onClick={() => act(r, 'approve')}>Approve</ActionButton>
            <ActionButton tone="danger" disabled={!!busyId || sameActor} onClick={() => act(r, 'reject')}>Reject</ActionButton>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} />}
      <p className="text-xs text-gray-500">
        Proposed salary revisions awaiting approval. Separation of duties: you cannot approve a revision you proposed.
      </p>
      <DataTable columns={columns} rows={rows} loading={rows === null} emptyText="No proposals awaiting approval." />
      <p className="text-[11px] text-gray-400">
        Bulk increment cycles (open cycle → propose per-employee → batch approve) are deferred to the merit phase
        (ROADMAP §8). Use the per-employee revision flow above for now — it carries the same maker-checker governance.
      </p>
    </div>
  );
}

// Minimal labelled <select> (the design system exposes TextInput/DateField but
// not a Select; this keeps the same look without pulling in a new dependency).
// Options may be plain strings or { value, label }; `groups` renders
// [{ label, options }] as <optgroup> sections (used by the Kind picker).
function Select({ label, value, options, groups, onChange, tip }) {
  const opt = (o) => (typeof o === 'string'
    ? <option key={o} value={o}>{o}</option>
    : <option key={o.value} value={o.value}>{o.label}</option>);
  return (
    <label className="block">
      <span className="flex items-center text-sm font-medium text-gray-700 mb-1">{label}{tip && <InfoTip text={tip} />}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]">
        {groups
          ? groups.map((g) => <optgroup key={g.label} label={g.label}>{g.options.map(opt)}</optgroup>)
          : options.map(opt)}
      </select>
    </label>
  );
}

export default function CompensationPage() {
  const [tab, setTab] = useState('components');
  const [me, setMe] = useState(null);
  const [perms, setPerms] = useState(null);

  // Honour a ?tab= deep link (the setup guide sends the pay-component step to
  // Components and the "give everyone a salary" step to Revisions). Read the URL
  // directly, matching the settings page, so no Suspense boundary is needed.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted && TABS.some((t) => t.key === wanted)) setTab(wanted);
  }, []);

  useEffect(() => {
    get('/api/auth/me').then((res) => {
      const session = res?.user || res;
      setMe(session);
      setPerms(permissionsFromSession(session));
    }).catch(() => {});
  }, []);

  const canManage = hasPermission(perms, 'canManageCompensation');
  const canApprove = hasPermission(perms, 'canApproveCompensation');

  return (
    <div>
      <PageHeader title="Compensation" subtitle="Pay components, salary structures and revisions" />
      <ModuleGuide
        id="compensation"
        title="Build pay structures and revise salaries"
        what="This is your compensation control room: define reusable pay components (Basic, HRA, Special Allowance), assemble them into India-compliant salary structures with a live CTC preview, and run effective-dated employee salary revisions through a maker-checker approval queue."
        steps={[
          "On Pay components, add each building block (e.g. code BASIC, kind Basic, calc method Percent-of) so payslips and structures can reference it.",
          "On Salary structures, pick the legal entity (country and currency are derived from it), add component lines in the builder, and enter a target CTC to see the live waterfall.",
          "Watch the India 50% chip — Basic + DA must be at least 50% of gross (Code on Wages) or the save is blocked.",
          "On Employee revisions, load an employee ID, set the effective-from date and new CTC, then propose the revision.",
          "On Approvals, a different checker approves or rejects proposed revisions — you cannot approve your own.",
        ]}
        example={<>For <b>Aarav Sharma</b> at <b>Acme India Pvt Ltd</b>, you build a structure on a <b>₹12,00,000 CTC</b> with Basic at <b>50%</b> (₹50,000/mo), HRA at 50% of Basic, and Special Allowance as the balancing line — the 50% chip shows <b>OK</b>. You then raise an <b>ANNUAL_REVISION</b> effective <b>1 June 2026</b> and propose it for approval.</>}
        tips={[
          "Component Code and a structure's component lines are immutable after creation — get them right the first time.",
          "Range-only viewers see compa-ratios instead of absolute amounts, and the PDF statement is banded — masking is enforced server-side.",
        ]}
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'components' && <ComponentsTab canManage={canManage} />}
      {tab === 'structures' && <StructuresTab canManage={canManage} />}
      {tab === 'revisions' && <RevisionsTab canApprove={canApprove} />}
      {tab === 'proposals' && <ProposalsTab canApprove={canApprove} me={me} />}
    </div>
  );
}

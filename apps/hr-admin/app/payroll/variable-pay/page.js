'use client';

// Variable Pay / Incentive schemes console (Feature 46, Phase 4).
//   Schemes are reusable payout RULES; a Cycle is one payout period that seeds a
//   per-employee Award snapshot; awards ride the maker-checker lifecycle and, on
//   approve, OTE-inject onto each employee's entity's OPEN pay run (queued when none).
//
//   API — mounted at /api/hr/variable-pay:
//     Schemes  POST /schemes                 create (canManageCompensation)
//              GET  /schemes                  list (canViewPayrollReports)
//              PATCH/DELETE /schemes/:id      edit / soft-delete (canManageCompensation)
//     Cycles   POST /cycles                   create + seed awards (canManageCompensation)
//              GET  /cycles                   list (paginated)
//              GET  /cycles/:id               header + scheme + awards + totals
//              POST /cycles/:id/compute        DRAFT/COMPUTED → COMPUTED (freeze)
//              POST /cycles/:id/approve        COMPUTED → APPROVED (canApprovePayroll, four-eyes)
//              POST /cycles/:id/cancel         DRAFT/COMPUTED → CANCELLED
//     Awards   GET  /cycles/:id/awards
//              PATCH /cycles/:id/awards/:awardId  { achievementPct } (DRAFT/COMPUTED only)
//
//   Amounts: per-award basis/target/computed are RUPEE decimals (Number); cycle
//   totalsJson carries totalTargetMinor/totalComputedMinor in PAISE (minor units).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, Tabs, ServerPagination } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';

const PAGE_SIZE = 25;

// Per-award amounts are already rupee-major Numbers; cycle totals are paise (minor).
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inrMinor = (minor) => inr(Number(minor || 0) / 100);

const KINDS = ['INCENTIVE', 'COMMISSION', 'BONUS'];
const BASES = ['GROSS', 'BASIC', 'CTC', 'FIXED_AMOUNT'];
const FREQS = ['MONTHLY', 'QUARTERLY', 'ANNUAL'];
const PRORATIONS = ['NONE', 'BY_ATTENDANCE', 'BY_TENURE'];

const KIND_LABEL = { INCENTIVE: 'Incentive', COMMISSION: 'Commission', BONUS: 'Bonus' };
const BASIS_LABEL = { GROSS: 'Monthly gross', BASIC: 'Basic + DA', CTC: 'Annual CTC', FIXED_AMOUNT: 'Fixed amount' };
const FREQ_LABEL = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', ANNUAL: 'Annual' };
const PRORATION_LABEL = { NONE: 'None', BY_ATTENDANCE: 'By attendance', BY_TENURE: 'By tenure' };

const inputCls = 'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm';

export default function VariablePayPage() {
  const [tab, setTab] = useState('schemes');
  return (
    <div>
      <PageHeader title="Variable Pay" subtitle="Incentive / commission schemes — cycles, achievement & maker-checker payout" />
      <ModuleGuide
        id="payroll-variable-pay"
        title="Run an incentive / commission payout"
        what="A Scheme is a reusable payout rule (kind, basis, target, frequency, proration, who is eligible). A Cycle is one payout period: creating it seeds an Award per eligible employee. You edit each award's achievement %, Compute to freeze the amounts, then a different approver Approves — which injects each payout onto that employee's entity's open pay run (or queues it if none is open)."
        steps={[
          'On the Schemes tab, click New scheme: name it, pick the kind (Incentive/Commission/Bonus) and basis (Gross / Basic+DA / CTC / Fixed amount). Enter a target % for a salary-based basis, or a fixed target amount for Fixed amount. Choose payout frequency and proration, and optionally scope eligibility to entities/departments/grades (empty = everyone).',
          'On the Cycles tab, click New cycle: pick the scheme, a period label (e.g. Q1 FY25-26) and the start/end dates. This seeds a DRAFT award for every eligible employee at 100% achievement.',
          'Open the cycle and edit each employee’s Achievement % inline (allowed while DRAFT or COMPUTED). Click Compute to freeze the computed amounts.',
          'Have a DIFFERENT approver click Approve — four-eyes blocks the person who computed it. Approve injects each payout onto the employee’s entity’s open pay run; awards with no open run are marked Queued.',
        ]}
        example={<>A <b>Sales Commission</b> scheme on <b>Monthly gross</b> at a <b>10%</b> target, paid quarterly. For Q1 the cycle seeds an award per sales rep; a rep who hit <b>120%</b> of target gets 1.2× their target payout, injected as a taxable one-time earning on their entity’s open run.</>}
        tips={[
          'Editing any achievement % on a COMPUTED cycle re-opens it to DRAFT — you must Compute again before Approve, preserving maker-checker integrity.',
          'A Queued badge means no open pay run caught the payout yet — open a run for that entity and re-approve, or inject it later.',
          'Fixed amount schemes ignore the salary basis — the target IS the amount, still scaled by achievement % and proration.',
        ]}
      />
      <Tabs
        tabs={[{ key: 'schemes', label: 'Schemes' }, { key: 'cycles', label: 'Cycles' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'schemes' ? <SchemesTab /> : <CyclesTab />}
    </div>
  );
}

// ── Schemes ───────────────────────────────────────────────────────────────────
function schemeTarget(s) {
  if (s.basis === 'FIXED_AMOUNT') return s.targetAmount != null ? inr(s.targetAmount) : '—';
  return s.targetPct != null ? `${s.targetPct}%` : '—';
}

function SchemesTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // 'new' | scheme object | null
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/variable-pay/schemes')
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load schemes.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = data?.items || [];
  const columns = [
    { key: 'name', header: 'Scheme', render: (r) => (
      <div>
        <div className="font-medium text-gray-900">{r.name}</div>
        {r.code ? <div className="text-xs text-gray-400">{r.code}</div> : null}
      </div>
    ) },
    { key: 'kind', header: 'Kind', render: (r) => KIND_LABEL[r.kind] || r.kind },
    { key: 'basis', header: 'Basis · target', render: (r) => (
      <span>{BASIS_LABEL[r.basis] || r.basis} · <span className="font-medium text-gray-900">{schemeTarget(r)}</span></span>
    ) },
    { key: 'freq', header: 'Frequency', render: (r) => FREQ_LABEL[r.payoutFrequency] || r.payoutFrequency },
    { key: 'active', header: 'Active', render: (r) => (r.isActive
      ? <span className="text-emerald-700">Active</span>
      : <span className="text-gray-400">Inactive</span>) },
    { key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right', render: (r) => (
      <div className="flex justify-end gap-2">
        <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
        <ActionButton tone="danger" onClick={() => setDeleting(r)}>Delete</ActionButton>
      </div>
    ) },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">Reusable payout rules. Empty eligibility scope means every current employee is eligible.</p>
        <PrimaryButton onClick={() => setEditing('new')}>New scheme</PrimaryButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No schemes yet — create one to get started." rowKey={(r) => r.id} />
      {editing && (
        <SchemeModal
          scheme={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {deleting && (
        <DeleteSchemeModal scheme={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); load(); }} />
      )}
    </div>
  );
}

function DeleteSchemeModal({ scheme, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await del(`/api/hr/variable-pay/schemes/${scheme.id}`);
      onDeleted();
    } catch (e) {
      setError(e.data?.message || e.message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Delete scheme" onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <p className="text-sm text-gray-600">Delete <strong>{scheme.name}</strong>? It is soft-deleted and hidden from new cycles; existing cycles keep their history.</p>
      <div className="mt-4">
        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">Cancel</button>
          <button type="button" onClick={remove} disabled={busy} className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
            {busy ? 'Deleting…' : 'Delete scheme'}
          </button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// Scheme create/edit. Conditional target field keys off `basis`: FIXED_AMOUNT
// takes a targetAmount (₹); every other basis takes a targetPct (%). Only the
// relevant one is shown and sent, matching the server's validateSchemeShape.
function SchemeModal({ scheme, onClose, onSaved }) {
  const isEdit = !!scheme;
  const [name, setName] = useState(scheme?.name || '');
  const [code, setCode] = useState(scheme?.code || '');
  const [kind, setKind] = useState(scheme?.kind || 'INCENTIVE');
  const [basis, setBasis] = useState(scheme?.basis || 'GROSS');
  const [targetPct, setTargetPct] = useState(scheme?.targetPct != null ? String(scheme.targetPct) : '');
  const [targetAmount, setTargetAmount] = useState(scheme?.targetAmount != null ? String(scheme.targetAmount) : '');
  const [payoutFrequency, setPayoutFrequency] = useState(scheme?.payoutFrequency || 'QUARTERLY');
  const [prorationMethod, setProrationMethod] = useState(scheme?.prorationMethod || 'NONE');
  const [isActive, setIsActive] = useState(scheme?.isActive ?? true);
  const [scope, setScope] = useState(() => normaliseScope(scheme?.eligibilityScope));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isFixed = basis === 'FIXED_AMOUNT';

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        name: name.trim(),
        code: code.trim() || undefined,
        kind,
        basis,
        payoutFrequency,
        prorationMethod,
        eligibilityScope: scopeToPayload(scope),
      };
      if (isFixed) body.targetAmount = Number(targetAmount);
      else body.targetPct = Number(targetPct);
      if (isEdit) {
        body.isActive = isActive;
        await patch(`/api/hr/variable-pay/schemes/${scheme.id}`, body);
      } else {
        await post('/api/hr/variable-pay/schemes', body);
      }
      onSaved();
    } catch (err) {
      setError(err.data?.message || err.message);
      setSaving(false);
    }
  }

  const targetOk = isFixed ? Number(targetAmount) > 0 : Number(targetPct) > 0;
  const valid = name.trim() && targetOk;

  return (
    <Modal title={isEdit ? 'Edit scheme' : 'New scheme'} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Sales Commission" className={inputCls} />
          </label>
          <label className="block text-sm">
            <span className="flex items-center font-medium text-gray-700">Code<InfoTip text="Optional short code, unique per tenant (e.g. SALES-COMM). Leave blank to auto-omit." /></span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="(optional)" className={inputCls} />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="flex items-center font-medium text-gray-700">Basis<InfoTip text="What the target is measured against. Gross = monthly gross; Basic = Basic+DA; CTC = annual CTC; Fixed amount = a flat ₹ target (salary ignored)." /></span>
            <select value={basis} onChange={(e) => setBasis(e.target.value)} className={inputCls}>
              {BASES.map((b) => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}
            </select>
          </label>
          {/* Conditional target: FIXED_AMOUNT → amount (₹); otherwise → percent (%). */}
          {isFixed ? (
            <label className="block text-sm">
              <span className="flex items-center font-medium text-gray-700">Target amount (₹)<InfoTip text="The flat payout target at 100% achievement. Scaled by achievement % and proration per employee." /></span>
              <input type="number" step="0.01" min="0" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} required placeholder="e.g. 25000" className={inputCls} />
            </label>
          ) : (
            <label className="block text-sm">
              <span className="flex items-center font-medium text-gray-700">Target %<InfoTip text="Target payout as a percent of the basis at 100% achievement. e.g. 10 = 10% of monthly gross." /></span>
              <input type="number" step="0.01" min="0" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} required placeholder="e.g. 10" className={inputCls} />
            </label>
          )}
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Payout frequency</span>
            <select value={payoutFrequency} onChange={(e) => setPayoutFrequency(e.target.value)} className={inputCls}>
              {FREQS.map((f) => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="flex items-center font-medium text-gray-700">Proration<InfoTip text="How a mid-period joiner/leaver is scaled. None = full award; By attendance / By tenure = scaled by active days in the period." /></span>
            <select value={prorationMethod} onChange={(e) => setProrationMethod(e.target.value)} className={inputCls}>
              {PRORATIONS.map((p) => <option key={p} value={p}>{PRORATION_LABEL[p]}</option>)}
            </select>
          </label>
          {isEdit && (
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="rounded border-gray-300" />
              <span className="font-medium text-gray-700">Active</span>
            </label>
          )}
        </div>

        <EligibilityScopePicker scope={scope} onChange={setScope} />

        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">Cancel</button>
          <PrimaryButton type="submit" loading={saving} disabled={!valid}>{isEdit ? 'Save changes' : 'Create scheme'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Eligibility scope picker (entities / departments / grades multi-select) ────
// The scheme's eligibilityScope is a Json filter { entityIds, departmentIds,
// gradeIds }; an empty/absent filter means ALL current employees. We load the org
// masters and offer a checklist per dimension (AND across dimensions server-side).
function normaliseScope(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    entityIds: Array.isArray(s.entityIds) ? s.entityIds : [],
    departmentIds: Array.isArray(s.departmentIds) ? s.departmentIds : [],
    gradeIds: Array.isArray(s.gradeIds) ? s.gradeIds : [],
  };
}
function scopeToPayload(scope) {
  const out = {};
  if (scope.entityIds.length) out.entityIds = scope.entityIds;
  if (scope.departmentIds.length) out.departmentIds = scope.departmentIds;
  if (scope.gradeIds.length) out.gradeIds = scope.gradeIds;
  return Object.keys(out).length ? out : null;
}

function EligibilityScopePicker({ scope, onChange }) {
  const [entities, setEntities] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [grades, setGrades] = useState([]);

  useEffect(() => {
    get('/api/hr/org/entities').then((r) => setEntities(r.items || r || [])).catch(() => {});
    get('/api/hr/org/departments').then((r) => setDepartments(r.items || r || [])).catch(() => {});
    get('/api/hr/org/grades').then((r) => setGrades(r.items || r || [])).catch(() => {});
  }, []);

  const toggle = (key, id) => {
    const cur = scope[key];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onChange({ ...scope, [key]: next });
  };

  const anySelected = scope.entityIds.length || scope.departmentIds.length || scope.gradeIds.length;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-2 flex items-center text-sm font-medium text-gray-700">
        Eligibility scope
        <InfoTip text="Which employees this scheme covers. Filters combine (AND) across dimensions. Leave everything unchecked for ALL current employees." />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ScopeColumn label="Entities" items={entities} labelFn={(e) => `${e.code} — ${e.legalName || e.tradeName || ''}`.trim()} selected={scope.entityIds} onToggle={(id) => toggle('entityIds', id)} />
        <ScopeColumn label="Departments" items={departments} labelFn={(d) => d.name || d.code} selected={scope.departmentIds} onToggle={(id) => toggle('departmentIds', id)} />
        <ScopeColumn label="Grades" items={grades} labelFn={(g) => g.name || g.code} selected={scope.gradeIds} onToggle={(id) => toggle('gradeIds', id)} />
      </div>
      <p className="mt-2 text-xs text-gray-500">{anySelected ? 'Only employees matching the checked filters are eligible.' : 'Empty scope — every current employee is eligible.'}</p>
    </div>
  );
}

function ScopeColumn({ label, items, labelFn, selected, onToggle }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="max-h-32 overflow-y-auto rounded-md border border-gray-200 bg-white p-2">
        {items.length === 0 ? (
          <p className="px-1 py-0.5 text-xs text-gray-400">None defined</p>
        ) : items.map((it) => (
          <label key={it.id} className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-xs text-gray-700 hover:bg-gray-50">
            <input type="checkbox" checked={selected.includes(it.id)} onChange={() => onToggle(it.id)} className="rounded border-gray-300" />
            <span className="truncate">{labelFn(it)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Cycles ────────────────────────────────────────────────────────────────────
function CyclesTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/variable-pay/cycles', { page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load cycles.'))
      .finally(() => setLoading(false));
  }, [page]);
  useEffect(() => { load(); }, [load]);

  if (openId) return <CycleDetail id={openId} onBack={() => { setOpenId(null); load(); }} />;

  const items = data?.items || [];
  const columns = [
    { key: 'scheme', header: 'Scheme', render: (r) => (
      <div>
        <div className="font-medium text-gray-900">{r.scheme?.name || '—'}</div>
        {r.scheme?.kind ? <div className="text-xs text-gray-400">{KIND_LABEL[r.scheme.kind] || r.scheme.kind}</div> : null}
      </div>
    ) },
    { key: 'period', header: 'Period', render: (r) => (
      <div>
        <div className="text-gray-900">{r.periodLabel}</div>
        <div className="text-xs text-gray-400">{String(r.periodStart).slice(0, 10)} → {String(r.periodEnd).slice(0, 10)}</div>
      </div>
    ) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'total', header: 'Total computed', render: (r) => (r.totalsJson?.totalComputedMinor != null ? inrMinor(r.totalsJson.totalComputedMinor) : '—') },
    { key: 'open', header: '', className: 'text-right', cellClassName: 'text-right', render: (r) => <ActionButton onClick={() => setOpenId(r.id)}>Open</ActionButton> },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">Each cycle seeds an award per eligible employee, then rides Compute → Approve (maker-checker).</p>
        <PrimaryButton onClick={() => setShowNew(true)}>New cycle</PrimaryButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No cycles yet." rowKey={(r) => r.id} />
      {data && (
        <ServerPagination page={data.page || page} pageSize={data.pageSize || PAGE_SIZE} total={data.total || 0} onPageChange={setPage} noun="cycles" />
      )}
      {showNew && <NewCycleModal onClose={() => setShowNew(false)} onCreated={(c) => { setShowNew(false); if (c?.cycle?.id) setOpenId(c.cycle.id); else load(); }} />}
    </div>
  );
}

function NewCycleModal({ onClose, onCreated }) {
  const [schemes, setSchemes] = useState([]);
  const [schemeId, setSchemeId] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/variable-pay/schemes', { isActive: true })
      .then((r) => setSchemes((r.items || []).filter((s) => s.isActive)))
      .catch((e) => setError(e.data?.message || e.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const out = await post('/api/hr/variable-pay/cycles', { schemeId, periodLabel: periodLabel.trim(), periodStart, periodEnd });
      onCreated(out);
    } catch (err) {
      setError(err.data?.message || err.message);
      setSaving(false);
    }
  }

  const valid = schemeId && periodLabel.trim() && periodStart && periodEnd && periodEnd >= periodStart;

  return (
    <Modal title="New cycle" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Scheme<InfoTip text="Only active schemes can seed a cycle. The scheme's eligibility scope decides who gets an award." /></span>
          <select value={schemeId} onChange={(e) => setSchemeId(e.target.value)} required className={inputCls}>
            <option value="">Select scheme…</option>
            {schemes.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''} — {KIND_LABEL[s.kind] || s.kind}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Period label<InfoTip text="A human label for the payout period, e.g. Q1 FY25-26 or Aug 2025." /></span>
          <input value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} required placeholder="e.g. Q1 FY25-26" className={inputCls} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Period start</span>
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required className={inputCls} />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Period end</span>
            <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required className={inputCls} />
          </label>
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">Cancel</button>
          <PrimaryButton type="submit" loading={saving} disabled={!valid}>Create + seed awards</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function CycleDetail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    get(`/api/hr/variable-pay/cycles/${id}`)
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message))
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(action) {
    setBusy(true);
    setError('');
    try {
      // The lifecycle endpoints return the refreshed { cycle, scheme, awards, totals }.
      const out = await post(`/api/hr/variable-pay/cycles/${id}/${action}`, {});
      if (out && out.cycle) setData(out); else load();
    } catch (e) {
      setError(e.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!data) return <ErrorBanner message={error || 'Not found'} />;

  const { cycle, scheme, awards = [], totals = {} } = data;
  const editable = cycle.status === 'DRAFT' || cycle.status === 'COMPUTED';

  const cols = [
    { key: 'emp', header: 'Employee', render: (a) => `${a.employee?.code || ''} ${a.employee?.firstName || ''} ${a.employee?.lastName || ''}`.trim() || a.employeeId || '—' },
    { key: 'basis', header: 'Basis amount', render: (a) => inr(a.basisAmount) },
    { key: 'target', header: 'Target', render: (a) => inr(a.targetAmount) },
    { key: 'ach', header: 'Achievement %', render: (a) => (
      <AchievementCell cycleId={id} award={a} editable={editable} onSaved={(out) => { if (out && out.cycle) setData(out); else load(); }} onError={setError} />
    ) },
    { key: 'prorate', header: 'Proration', render: (a) => `${(Number(a.prorationFactor) * 100).toFixed(0)}%` },
    { key: 'computed', header: 'Computed', render: (a) => <span className="font-medium text-gray-900">{inr(a.computedAmount)}</span> },
    { key: 'queued', header: '', render: (a) => (a.queued
      ? <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700" title="No open pay run caught this payout yet.">Queued</span>
      : (a.payRunInputItemId ? <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700" title="Injected onto the entity's open pay run.">Injected</span> : null)) },
  ];

  return (
    <div>
      <button onClick={onBack} className="mb-3 text-sm text-gray-500 hover:text-gray-700">← Back to cycles</button>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{scheme?.name || 'Variable pay'} · {cycle.periodLabel}</h2>
          <p className="text-sm text-gray-500">
            {scheme ? `${BASIS_LABEL[scheme.basis] || scheme.basis} · ${schemeTarget(scheme)}` : ''} · <StatusBadge status={cycle.status} /> · {String(cycle.periodStart).slice(0, 10)} → {String(cycle.periodEnd).slice(0, 10)}
          </p>
        </div>
        <div className="flex gap-2">
          {editable && <ActionButton disabled={busy} onClick={() => act('compute')}>Compute</ActionButton>}
          {cycle.status === 'COMPUTED' && <ActionButton tone="positive" disabled={busy} onClick={() => act('approve')}>Approve (inject payout)</ActionButton>}
          {editable && <ActionButton tone="danger" disabled={busy} onClick={() => act('cancel')}>Cancel</ActionButton>}
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {cycle.status === 'COMPUTED' && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
          Maker-checker: a different approver must approve this cycle — you cannot approve a cycle you computed (four-eyes). Editing any achievement % re-opens the cycle to DRAFT.
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-6 text-sm text-gray-600">
        <span>Headcount: <strong>{totals.headcount ?? awards.length}</strong></span>
        <span>Total target: <strong>{totals.totalTargetMinor != null ? inrMinor(totals.totalTargetMinor) : '—'}</strong></span>
        <span>Total computed: <strong>{totals.totalComputedMinor != null ? inrMinor(totals.totalComputedMinor) : '—'}</strong></span>
        {totals.injected != null ? <span>Injected: <strong>{totals.injected}</strong></span> : null}
        {totals.queued != null ? <span>Queued: <strong>{totals.queued}</strong></span> : null}
      </div>
      <DataTable columns={cols} rows={awards} loading={false} emptyText="No awards in this cycle." rowKey={(a) => a.id} />
    </div>
  );
}

// Inline achievement-% editor. Editable only while the cycle is DRAFT/COMPUTED
// (the server enforces the same). Saves on Enter or blur when the value changed;
// PATCH returns the refreshed cycle so the parent re-renders the frozen figures.
function AchievementCell({ cycleId, award, editable, onSaved, onError }) {
  const [val, setVal] = useState(String(award.achievementPct ?? 100));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setVal(String(award.achievementPct ?? 100)); }, [award.achievementPct]);

  if (!editable) return <span>{Number(award.achievementPct)}%</span>;

  async function save() {
    const pct = Number(val);
    if (!Number.isFinite(pct) || pct === Number(award.achievementPct)) { setVal(String(award.achievementPct)); return; }
    setSaving(true);
    try {
      const out = await patch(`/api/hr/variable-pay/cycles/${cycleId}/awards/${award.id}`, { achievementPct: pct });
      onSaved(out);
    } catch (e) {
      onError?.(e.data?.message || e.message);
      setVal(String(award.achievementPct));
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        step="0.01"
        min="0"
        max="1000"
        value={val}
        disabled={saving}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        onBlur={save}
        className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm disabled:opacity-50"
      />
      <span className="text-gray-400">%</span>
    </span>
  );
}

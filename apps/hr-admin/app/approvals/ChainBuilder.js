'use client';

// Feature 10 slice 10d — the Chain canvas.
//
// One Process (module) → its chain of Steps. The admin:
//   1. Starts from a friendly template (or an existing draft/live def).
//   2. Stacks step cards top-to-bottom (= order). Each card asks "Who approves?"
//      and offers an optional "Only if…" rule chip + a "Time limit" chip.
//   3. Drops cards into the SAME row for parallel ("at the same time — any 1 / all").
//   4. Previews the resolved approver NAMES for a sample request.
//   5. Saves a draft, then Publishes to go live.
//
// Data model mapping (kept entirely out of the UI's language):
//   • a "row" = one parallel LEVEL = all steps sharing a stepOrder.
//   • "Who" → approverType (+ approverRefId N-up packing for the manager chain).
//   • "Only if" → conditionJson (conditions.js grammar).
//   • "Time limit" → slaHours + onTimeoutAction.
//
// We edit ONE definition per module — the module default (no scope/entity). If
// none exists we create it on first save. Scope-specific defs are an advanced
// path the spec defers; this keeps the SME flow to "one chain per process".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton } from '@hr/ui';
import { get, post, patch, request } from '@/lib/api';
import {
  InfoTip, FieldLabel, SectionTitle, WHO_OPTIONS, whoKeyForStep, TIMEOUT_LABELS, moduleLabel,
} from '@/lib/widgets';
import { describeChain } from './describe';

let _uid = 0;
const nextUid = () => `r${++_uid}`;

// ─── templates (one click → a working chain) ─────────────────────────────────
const TEMPLATES = [
  { key: 'none', label: 'No approvals', hint: 'Granted the moment it’s filed.', build: () => [] },
  {
    key: 'manager', label: 'Just my manager', hint: 'The reporting manager says yes. The most common setup.',
    build: () => [row(step('MANAGER_1'))],
  },
  {
    key: 'manager-hr', label: 'Manager → HR', hint: 'Manager first, then anyone in HR.',
    build: () => [row(step('MANAGER_1')), row(step('HR'))],
  },
  {
    key: 'manager-finance-amount', label: 'Manager → Finance over an amount', hint: 'Manager always; Finance only when the amount is large.',
    build: () => [row(step('MANAGER_1')), row(step('PAYROLL_MANAGER', { condition: { amount: { '>': 50000 } } }))],
  },
];

// ─── editor model helpers ────────────────────────────────────────────────────
// A "step" in the editor: { uid, whoKey, refId, condition, slaHours, onTimeoutAction }
function step(whoKey, extra = {}) {
  const opt = WHO_OPTIONS.find((o) => o.key === whoKey) || WHO_OPTIONS[0];
  return {
    uid: nextUid(),
    whoKey,
    refId: opt.refId,
    condition: extra.condition || null,
    slaHours: extra.slaHours ?? null,
    onTimeoutAction: extra.onTimeoutAction || 'ESCALATE',
  };
}
// A "row" = a parallel level: { uid, steps: [...], minMode: 'any'|'all' }
function row(...steps) {
  return { uid: nextUid(), steps, minMode: 'all' };
}

// Convert stored WorkflowSteps → editor rows (group by stepOrder).
function rowsFromSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const byOrder = new Map();
  for (const s of steps) {
    if (!byOrder.has(s.stepOrder)) byOrder.set(s.stepOrder, []);
    byOrder.get(s.stepOrder).push(s);
  }
  return [...byOrder.keys()].sort((a, b) => a - b).map((o) => {
    const level = byOrder.get(o);
    const minApprovals = Math.max(...level.map((s) => s.minApprovals || 1));
    return {
      uid: nextUid(),
      minMode: level.length > 1 && minApprovals < level.length ? 'any' : 'all',
      steps: level.map((s) => ({
        uid: nextUid(),
        whoKey: whoKeyForStep(s),
        refId: s.approverType === 'SPECIFIC_ROLE' || s.approverType === 'SPECIFIC_EMPLOYEE'
          ? (s.approverRefId || '')
          : (WHO_OPTIONS.find((o) => o.key === whoKeyForStep(s))?.refId ?? null),
        condition: s.conditionJson || null,
        slaHours: s.slaHours ?? null,
        onTimeoutAction: s.onTimeoutAction || 'ESCALATE',
      })),
    };
  });
}

// Convert editor rows → the API's flat step array (stepOrder = row index+1).
function stepsFromRows(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const stepOrder = i + 1;
    const parallel = r.steps.length > 1;
    const minApprovals = parallel ? (r.minMode === 'any' ? 1 : r.steps.length) : 1;
    r.steps.forEach((s) => {
      const opt = WHO_OPTIONS.find((o) => o.key === s.whoKey) || WHO_OPTIONS[0];
      out.push({
        stepOrder,
        name: opt.label.replace(/…$/, ''),
        approverType: opt.approverType,
        approverRefId:
          opt.approverType === 'REPORTING_MANAGER' ? String(opt.refId)
          : (opt.approverType === 'SPECIFIC_ROLE' || opt.approverType === 'SPECIFIC_EMPLOYEE') ? (s.refId || null)
          : null,
        conditionJson: s.condition || undefined,
        isParallel: parallel,
        minApprovals,
        slaHours: s.slaHours == null ? null : Number(s.slaHours),
        onTimeoutAction: s.onTimeoutAction || 'ESCALATE',
      });
    });
  });
  return out;
}

// Client-side mirror of the server's validation so we fail fast with friendly text.
function validateRows(rows) {
  for (const [i, r] of rows.entries()) {
    for (const s of r.steps) {
      const opt = WHO_OPTIONS.find((o) => o.key === s.whoKey);
      if (!opt) return `Step ${i + 1}: pick who approves.`;
      if ((opt.approverType === 'SPECIFIC_ROLE' || opt.approverType === 'SPECIFIC_EMPLOYEE') && !s.refId) {
        return `Step ${i + 1}: choose the ${opt.approverType === 'SPECIFIC_ROLE' ? 'role' : 'person'}.`;
      }
    }
  }
  return null;
}

// ─── condition editor (the "Only if…" chip popover) ──────────────────────────
const COND_FIELDS = [
  { key: 'amount', label: 'Amount', placeholder: '50000', kind: 'number', prefix: '₹' },
  { key: 'days', label: 'Number of days', placeholder: '5', kind: 'number' },
  { key: 'categoryCode', label: 'Category is one of', placeholder: 'TRAVEL, CLIENT', kind: 'list' },
  { key: 'employeeLevel', label: 'Level is one of', placeholder: 'M1, M2', kind: 'list' },
];
const COND_OPS = [
  { op: '>', label: 'is more than' },
  { op: '>=', label: 'is at least' },
  { op: '<', label: 'is less than' },
  { op: '<=', label: 'is at most' },
];

function readCondition(cond) {
  if (!cond || typeof cond !== 'object') return { field: 'amount', op: '>', value: '' };
  const [field, test] = Object.entries(cond)[0] || ['amount', { '>': '' }];
  if (test && typeof test === 'object') {
    if (Array.isArray(test.in)) return { field, op: 'in', value: test.in.join(', ') };
    const [op, value] = Object.entries(test)[0] || ['>', ''];
    return { field, op, value: String(value) };
  }
  return { field: 'amount', op: '>', value: '' };
}
function buildCondition({ field, op, value }) {
  const fmeta = COND_FIELDS.find((f) => f.key === field);
  if (!value && value !== 0) return null;
  if (fmeta?.kind === 'list' || op === 'in') {
    const arr = String(value).split(',').map((x) => x.trim()).filter(Boolean);
    if (arr.length === 0) return null;
    return { [field]: { in: arr } };
  }
  const num = Number(value);
  return { [field]: { [op]: Number.isFinite(num) ? num : value } };
}

function ConditionChip({ condition, onChange }) {
  const [open, setOpen] = useState(false);
  const c = readCondition(condition);
  const fmeta = COND_FIELDS.find((f) => f.key === c.field) || COND_FIELDS[0];
  const isList = fmeta.kind === 'list';
  const has = !!condition;

  function update(part) {
    const nextC = { ...c, ...part };
    onChange(buildCondition(nextC));
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
          has ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-dashed border-gray-300 text-gray-500 hover:border-gray-400'
        }`}
      >
        {has ? `Only if ${fmeta.label.toLowerCase()} ${COND_OPS.find((o) => o.op === c.op)?.label || c.op} ${c.value}` : '+ Only if…'}
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-30 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">Add a rule</span>
            <InfoTip text="This step only runs when the rule is true — e.g. only add Finance if the amount is over ₹50,000. Leave it off and the step always runs." />
          </div>
          <div className="space-y-2">
            <select
              value={c.field}
              onChange={(e) => update({ field: e.target.value, op: COND_FIELDS.find((f) => f.key === e.target.value)?.kind === 'list' ? 'in' : '>' })}
              className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            >
              {COND_FIELDS.map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
            {!isList && (
              <select value={c.op === 'in' ? '>' : c.op} onChange={(e) => update({ op: e.target.value })} className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
                {COND_OPS.map((o) => (<option key={o.op} value={o.op}>{o.label}</option>))}
              </select>
            )}
            <input
              value={c.value}
              onChange={(e) => update({ value: e.target.value })}
              placeholder={fmeta.placeholder}
              className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            />
            <p className="text-[11px] text-gray-400">{isList ? 'Comma-separate the values.' : fmeta.prefix ? 'Enter a number.' : 'Enter a number.'}</p>
          </div>
          <div className="mt-3 flex justify-between">
            <button type="button" onClick={() => { onChange(null); setOpen(false); }} className="text-xs text-gray-500 hover:text-gray-700 underline">
              Remove rule
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs font-medium text-white" style={{ backgroundColor: 'var(--theme-primary)' }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── time-limit chip ─────────────────────────────────────────────────────────
function TimeLimitChip({ slaHours, onTimeoutAction, onChange }) {
  const [open, setOpen] = useState(false);
  const has = slaHours != null;
  const days = has ? Math.max(1, Math.round(slaHours / 24)) : 2;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
          has ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-dashed border-gray-300 text-gray-500 hover:border-gray-400'
        }`}
      >
        {has ? `${days} day${days > 1 ? 's' : ''}, then ${TIMEOUT_LABELS[onTimeoutAction]?.toLowerCase() || 'escalate'}` : '+ Time limit'}
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-30 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">Time limit</span>
            <InfoTip text="If the approver doesn’t act within this many days, DriftHR can remind them, push it up to their manager, or just auto-decide. Leave it off for no time limit." />
          </div>
          <label className="mb-2 block text-xs text-gray-600">
            Wait
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => onChange({ slaHours: Math.max(1, Number(e.target.value || 1)) * 24, onTimeoutAction })}
              className="mx-1 w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
            />
            day(s), then…
          </label>
          <select
            value={onTimeoutAction}
            onChange={(e) => onChange({ slaHours: has ? slaHours : days * 24, onTimeoutAction: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          >
            {Object.entries(TIMEOUT_LABELS).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
          </select>
          <div className="mt-3 flex justify-between">
            <button type="button" onClick={() => { onChange({ slaHours: null, onTimeoutAction: 'ESCALATE' }); setOpen(false); }} className="text-xs text-gray-500 hover:text-gray-700 underline">
              No time limit
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs font-medium text-white" style={{ backgroundColor: 'var(--theme-primary)' }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── one approver sub-card (inside a row) ────────────────────────────────────
function ApproverCard({ s, roles, employees, onChange, onRemove, canRemove }) {
  const opt = WHO_OPTIONS.find((o) => o.key === s.whoKey) || WHO_OPTIONS[0];
  const needsRole = opt.approverType === 'SPECIFIC_ROLE';
  const needsEmp = opt.approverType === 'SPECIFIC_EMPLOYEE';
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <FieldLabel tip="Pick who should say yes at this step. ‘My manager’ uses your reporting tree; ‘A role’ or ‘A person’ is great if you don’t use a reporting structure.">
            Who approves?
          </FieldLabel>
          <select
            value={s.whoKey}
            onChange={(e) => {
              const o = WHO_OPTIONS.find((x) => x.key === e.target.value);
              onChange({ ...s, whoKey: e.target.value, refId: o ? o.refId : null });
            }}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            {WHO_OPTIONS.map((o) => (<option key={o.key} value={o.key}>{o.label}</option>))}
          </select>
          <p className="mt-1 text-[11px] text-gray-400">{opt.hint}</p>

          {needsRole && (
            <select
              value={s.refId || ''}
              onChange={(e) => onChange({ ...s, refId: e.target.value })}
              className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Choose a role…</option>
              {roles.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
            </select>
          )}
          {needsEmp && (
            <select
              value={s.refId || ''}
              onChange={(e) => onChange({ ...s, refId: e.target.value })}
              className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Choose a person…</option>
              {employees.map((e) => (<option key={e.id} value={e.id}>{e.name}{e.code ? ` (${e.code})` : ''}</option>))}
            </select>
          )}
        </div>
        {canRemove && (
          <button type="button" onClick={onRemove} aria-label="Remove this approver" className="mt-6 text-gray-400 hover:text-red-600">×</button>
        )}
      </div>

      {opt.approverType !== 'AUTO_APPROVE' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <ConditionChip condition={s.condition} onChange={(condition) => onChange({ ...s, condition })} />
          <TimeLimitChip
            slaHours={s.slaHours}
            onTimeoutAction={s.onTimeoutAction}
            onChange={(patch) => onChange({ ...s, ...patch })}
          />
        </div>
      )}
    </div>
  );
}

// ─── one row (a step, possibly parallel) ─────────────────────────────────────
function RowCard({ r, index, total, roles, employees, onChange, onRemove, onMove, onAddParallel }) {
  const parallel = r.steps.length > 1;
  return (
    <li>
      <div className="flex items-stretch gap-3">
        <div className="flex w-7 shrink-0 flex-col items-center pt-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 text-xs font-semibold text-white">{index + 1}</span>
          <div className="mt-1 flex flex-col gap-0.5">
            <button type="button" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Move step up" className="text-gray-400 hover:text-gray-700 disabled:opacity-30">▲</button>
            <button type="button" onClick={() => onMove(1)} disabled={index === total - 1} aria-label="Move step down" className="text-gray-400 hover:text-gray-700 disabled:opacity-30">▼</button>
          </div>
        </div>

        <div className="flex-1 rounded-2xl border border-gray-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center text-xs font-semibold uppercase tracking-wide text-gray-400">
              Step {index + 1}
              {parallel && (
                <span className="ml-2 inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600">
                  at the same time
                  <InfoTip text="These approvers act in parallel — all at once, not one after another." />
                </span>
              )}
            </span>
            <button type="button" onClick={onRemove} className="text-xs font-medium text-red-600 hover:underline">Remove step</button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {r.steps.map((s, si) => (
              <ApproverCard
                key={s.uid}
                s={s}
                roles={roles}
                employees={employees}
                canRemove={r.steps.length > 1}
                onChange={(ns) => onChange({ ...r, steps: r.steps.map((x) => (x.uid === s.uid ? ns : x)) })}
                onRemove={() => onChange({ ...r, steps: r.steps.filter((x) => x.uid !== s.uid) })}
              />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" onClick={onAddParallel} className="text-xs font-medium text-[color:var(--theme-primary)] hover:underline">
              + Add an approver at the same time
            </button>
            {parallel && (
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <span>Need</span>
                <select
                  value={r.minMode}
                  onChange={(e) => onChange({ ...r, minMode: e.target.value })}
                  className="rounded-md border border-gray-300 px-2 py-0.5 text-xs"
                >
                  <option value="any">any 1</option>
                  <option value="all">all {r.steps.length}</option>
                </select>
                <span>to approve</span>
                <InfoTip text="‘Any 1’ completes the step as soon as one of them approves. ‘All’ needs every one of them." />
              </label>
            )}
          </div>
        </div>
      </div>
      {index < total - 1 && <div className="my-1 ml-3.5 h-4 w-px bg-gray-300" aria-hidden="true" />}
    </li>
  );
}

// ─── Preview panel ───────────────────────────────────────────────────────────
function PreviewPanel({ module, rows, defId, userNames }) {
  const [ctx, setCtx] = useState({ amount: '', days: '', categoryCode: '', employeeLevel: '' });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const sampleCtx = {};
      if (ctx.amount) sampleCtx.amount = Number(ctx.amount);
      if (ctx.days) sampleCtx.days = Number(ctx.days);
      if (ctx.categoryCode) sampleCtx.categoryCode = ctx.categoryCode.trim();
      if (ctx.employeeLevel) sampleCtx.employeeLevel = ctx.employeeLevel.trim();
      // Preview the SAVED def (defId) so we resolve real approvers. If unsaved,
      // tell the admin to save a draft first (the engine previews a definition).
      if (!defId) { setError('Save a draft first, then preview the resolved approvers.'); setLoading(false); return; }
      const res = await post(`/api/hr/approvals/workflows/${defId}/preview`, { module, ctx: sampleCtx });
      setResult(res.chain || []);
    } catch (err) {
      setError(err.data?.message || err.message || 'Preview failed.');
    } finally {
      setLoading(false);
    }
  }

  const namesOf = useCallback((ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    return ids.map((id) => userNames[id] || 'someone');
  }, [userNames]);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <SectionTitle tip="Fill in a pretend request and we’ll show you exactly who would be asked to approve it — by name. The best way to be sure your chain does what you expect before publishing.">
        Preview for a sample request
      </SectionTitle>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-xs text-gray-600">
          Amount (₹)
          <input value={ctx.amount} onChange={(e) => setCtx({ ...ctx, amount: e.target.value })} placeholder="60000" className="mt-0.5 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-600">
          Days
          <input value={ctx.days} onChange={(e) => setCtx({ ...ctx, days: e.target.value })} placeholder="3" className="mt-0.5 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-600">
          Category
          <input value={ctx.categoryCode} onChange={(e) => setCtx({ ...ctx, categoryCode: e.target.value })} placeholder="TRAVEL" className="mt-0.5 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-600">
          Level
          <input value={ctx.employeeLevel} onChange={(e) => setCtx({ ...ctx, employeeLevel: e.target.value })} placeholder="M1" className="mt-0.5 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
      </div>
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {loading ? 'Resolving…' : 'Show who would approve'}
      </button>
      {error && <p className="mt-2 text-xs text-amber-700">{error}</p>}
      {result && (
        <ol className="mt-3 space-y-2">
          {result.length === 0 && <li className="text-xs text-gray-500">Auto-approved — nobody needs to act.</li>}
          {result.map((lvl) => (
            <li key={lvl.stepOrder} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs">
              {lvl.skipped ? (
                <span className="text-gray-400">Step {lvl.stepOrder}: skipped (rule not met)</span>
              ) : lvl.autoApprove ? (
                <span className="text-emerald-700">Step {lvl.stepOrder}: auto-approved{lvl.escalationReason ? ` (${lvl.escalationReason})` : ''}</span>
              ) : (
                <span className="text-gray-700">
                  <span className="font-medium">Step {lvl.stepOrder}:</span>{' '}
                  {namesOf(lvl.approverUserIds).join(', ') || 'unresolved'}
                  {lvl.minApprovals > 1 ? ` (need ${lvl.minApprovals})` : ''}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ─── the builder ─────────────────────────────────────────────────────────────
export default function ChainBuilder({ module, defs, onClose, onChanged }) {
  // Pick the module-default def (no scope/entity) to edit, else the first, else none.
  const initialDef = useMemo(
    () => defs.find((d) => !d.entityId && !d.scopeJson) || defs[0] || null,
    [defs],
  );
  const [def, setDef] = useState(initialDef);
  const [rows, setRows] = useState(() => rowsFromSteps(initialDef?.steps || []));
  const [chose, setChose] = useState(!!initialDef && (initialDef.steps?.length || 0) > 0);
  const [roles, setRoles] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [userNames, setUserNames] = useState({});
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Load the pickers: roles (for "A role"), employees (for "A person"), and a
  // userId→name map (to render preview approver names).
  useEffect(() => {
    Promise.all([
      get('/api/hr/rbac/roles').catch(() => ({ items: [] })),
      get('/api/hr/rbac/org-tree').catch(() => ({ nodes: [], orphans: [] })),
      get('/api/business/users').catch(() => ({ users: [] })),
    ]).then(([r, tree, u]) => {
      setRoles(Array.isArray(r?.items) ? r.items : (r?.roles || []));
      const nodes = [...(tree?.nodes || []), ...(tree?.orphans || [])];
      setEmployees(nodes.map((n) => ({ id: n.id, name: n.name, code: n.code })));
      const users = Array.isArray(u?.users) ? u.users : (u?.items || []);
      const map = {};
      for (const usr of users) map[usr.id] = usr.name || usr.email;
      setUserNames(map);
    });
  }, []);

  const dirty = true; // we always allow save; the server is the source of truth

  function applyTemplate(tpl) {
    setRows(tpl.build());
    setChose(true);
  }
  function addStep() {
    setRows((rs) => [...rs, { uid: nextUid(), minMode: 'all', steps: [step('MANAGER_1')] }]);
  }
  function setRow(uid, next) {
    setRows((rs) => rs.map((r) => (r.uid === uid ? next : r)).filter((r) => r.steps.length > 0));
  }
  function removeRow(uid) {
    setRows((rs) => rs.filter((r) => r.uid !== uid));
  }
  function moveRow(idx, delta) {
    setRows((rs) => {
      const next = [...rs];
      const j = idx + delta;
      if (j < 0 || j >= next.length) return rs;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }
  function addParallel(uid) {
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, steps: [...r.steps, step('HR')] } : r)));
  }

  // Ensure a module-default definition exists; return its id.
  async function ensureDef() {
    if (def) return def;
    const created = await post('/api/hr/approvals/workflows', {
      name: `${moduleLabel(module)} approvals`,
      module,
    });
    setDef(created);
    return created;
  }

  async function saveDraft() {
    const v = validateRows(rows);
    if (v) { setError(v); return null; }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const d = await ensureDef();
      const steps = stepsFromRows(rows);
      const fresh = await request(`/api/hr/approvals/workflows/${d.id}/steps`, {
        method: 'PUT',
        body: JSON.stringify({ steps }),
      });
      setDef((prev) => ({ ...(prev || {}), ...fresh }));
      setNotice('Draft saved.');
      onChanged?.();
      return fresh;
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save the chain.');
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setError('');
    setNotice('');
    try {
      const saved = await saveDraft();
      if (!saved) { setPublishing(false); return; }
      await post(`/api/hr/approvals/workflows/${saved.id}/publish`, {});
      setNotice('Published — this chain is now live for new requests.');
      onChanged?.();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to publish.');
    } finally {
      setPublishing(false);
    }
  }

  const oneLiner = describeChain(stepsFromRows(rows));

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <button type="button" onClick={onClose} className="mb-2 text-sm text-gray-500 hover:text-gray-700">← All processes</button>
          <h1 className="flex items-center text-2xl font-semibold text-gray-900">
            {moduleLabel(module)} approval chain
            <InfoTip text="Stack the steps an employee’s request must pass, top to bottom. Drop two approvers into one step to make them happen at the same time. Save a draft any time; publish when you’re ready." />
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">{oneLiner}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {def?.isPublished ? (
            <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">Live</span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">Draft</span>
          )}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {notice && (
        <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</p>
      )}

      {!chose ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
          <SectionTitle tip="Templates are a one-click head start. Pick the closest one — you can change every step afterwards.">
            Start from a template
          </SectionTitle>
          <p className="mt-1 text-sm text-gray-500">Pick the closest setup. You can tweak everything after.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => applyTemplate(t)}
                className="rounded-xl border border-gray-200 p-4 text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2"
                style={{ '--tw-ring-color': 'var(--theme-primary)' }}
              >
                <div className="text-sm font-semibold text-gray-900">{t.label}</div>
                <p className="mt-1 text-xs text-gray-500">{t.hint}</p>
              </button>
            ))}
          </div>
          <button type="button" onClick={() => { setRows([]); setChose(true); }} className="mt-4 text-sm font-medium text-[color:var(--theme-primary)] hover:underline">
            Or build from scratch →
          </button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <ul>
              {rows.map((r, i) => (
                <RowCard
                  key={r.uid}
                  r={r}
                  index={i}
                  total={rows.length}
                  roles={roles}
                  employees={employees}
                  onChange={(next) => setRow(r.uid, next)}
                  onRemove={() => removeRow(r.uid)}
                  onMove={(delta) => moveRow(i, delta)}
                  onAddParallel={() => addParallel(r.uid)}
                />
              ))}
            </ul>

            {rows.length === 0 && (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
                No steps — this process will <span className="font-medium">auto-approve</span> every request.
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={addStep}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                + Add step below
              </button>
              <button type="button" onClick={() => { setChose(false); }} className="text-sm text-gray-500 hover:text-gray-700">
                Use a template instead
              </button>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4">
              <PrimaryButton onClick={saveDraft} loading={saving}>Save draft</PrimaryButton>
              <button
                type="button"
                onClick={publish}
                disabled={publishing}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: 'var(--theme-primary)' }}
              >
                {publishing ? 'Publishing…' : 'Publish — go live'}
              </button>
              <span className="flex items-center text-xs text-gray-400">
                Publishing affects new requests only; in-flight approvals keep their chain.
                <InfoTip text="When you publish, requests filed from now on follow the new chain. Anything already waiting for approval keeps the chain it started with — so the rules never change mid-request." />
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <PreviewPanel module={module} rows={rows} defId={def?.id} userNames={userNames} />
          </div>
        </div>
      )}
    </div>
  );
}

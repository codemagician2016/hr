'use client';

// Payroll console — the GUIDED RUN (Feature 7). Drives the run lifecycle
//   DRAFT → INPUTS_LOCKED → COMPUTED → REVIEW → APPROVED → PAID → FILED → closed
// over the orchestration API:
//   GET    /api/hr/payroll/entities                      entity+calendar pickers
//   GET    /api/hr/payroll/runs                          list (paginated, FNF hidden)
//   POST   /api/hr/payroll/runs                          create DRAFT (picker, not UUID)
//   GET    /api/hr/payroll/runs/:id                      detail + lines + totals + anomalies
//   GET    /api/hr/payroll/runs/:id/inputs-checklist     readiness gates
//   POST   /api/hr/payroll/runs/:id/inputs/one-time      one-time CRUD (DRAFT only)
//   POST   /api/hr/payroll/runs/:id/freeze               freeze attendance + compute
//   POST   /api/hr/payroll/runs/:id/compute              compute (idempotent)
//   POST   /api/hr/payroll/runs/:id/variance             period-over-period variance
//   POST   /api/hr/payroll/runs/:id/submit               maker → REVIEW
//   POST   /api/hr/payroll/runs/:id/send-back            checker → COMPUTED (reason)
//   POST   /api/hr/payroll/runs/:id/approve              checker → APPROVED (maker≠checker)
//   POST   /api/hr/payroll/runs/:id/pay                  → PAID + publish payslips
//   POST   /api/hr/payroll/runs/:id/file                 → FILED + remittances
//   POST   /api/hr/payroll/runs/:id/close                → closed (guarded)
//   POST   /api/hr/payroll/runs/:id/cancel | reopen
//   GET    /api/hr/payroll/runs/:id/files/:kind          country-aware filing exports
//
// State lives in the URL (?run=:id&tab=…) so list⇄detail⇄tab is linkable.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Spinner, ErrorBanner, PrimaryButton, TextInput, DateField, Modal, ModalActions, formatAdminDate } from '@hr/ui';
import { get, post, put, downloadFile } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, employeeLabel, moneyish } from '@/lib/ui';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip, usePagination, Pagination } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';

const PAGE_SIZE = 20;

// Stage stepper — the 6 visible lifecycle dots. CLOSED is FILED+closedAt.
const STAGES = [
  { key: 'DRAFT', label: 'Draft' },
  { key: 'COMPUTED', label: 'Computed' },
  { key: 'REVIEW', label: 'In review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'PAID', label: 'Paid' },
  { key: 'FILED', label: 'Filed' },
];
const STAGE_INDEX = { DRAFT: 0, INPUTS_LOCKED: 0, COMPUTED: 1, REVIEW: 2, APPROVED: 3, PAID: 4, FILED: 5, CANCELLED: -1 };

// Country-aware filing exports. India-only product: only IN filing links surface.
const FILE_KINDS_BY_COUNTRY = {
  IN: [
    { kind: 'ecr', label: 'EPF ECR' },
    { kind: 'esic', label: 'ESIC' },
    { kind: 'form24q', label: 'Form 24Q' },
  ],
};

// Post-approval statuses are immutable (mirror the backend so no surprise 409).
const IMMUTABLE = new Set(['APPROVED', 'PAID', 'FILED', 'CANCELLED']);

function StageStepper({ status, closed }) {
  const idx = status === 'FILED' && closed ? 6 : (STAGE_INDEX[status] ?? -1);
  if (status === 'CANCELLED') {
    return <div className="text-xs font-medium text-red-600">Cancelled</div>;
  }
  return (
    <ol className="flex items-center gap-1 text-[11px]">
      {STAGES.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <li key={s.key} className="flex items-center gap-1">
            <span
              className={`inline-flex items-center justify-center w-5 h-5 rounded-full border text-[10px] font-semibold ${
                done ? 'bg-emerald-500 border-emerald-500 text-white'
                  : active ? 'border-2 text-gray-900' : 'border-gray-300 text-gray-400'
              }`}
              style={active ? { borderColor: 'var(--theme-primary)' } : undefined}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className={active ? 'font-semibold text-gray-900' : 'text-gray-400'}>{s.label}</span>
            {i < STAGES.length - 1 && <span className="text-gray-300 px-0.5">→</span>}
          </li>
        );
      })}
      {idx === 6 && <li className="ml-1 text-emerald-600 font-semibold">· Closed</li>}
    </ol>
  );
}

function DeltaCard({ label, current, previous, currency, kind = 'money' }) {
  const cur = Number(current || 0);
  const prev = previous == null ? null : Number(previous);
  const delta = prev == null ? null : cur - prev;
  const pct = prev ? (delta / Math.abs(prev)) * 100 : null;
  const up = delta != null && delta > 0;
  const fmt = (v) => (kind === 'count' ? String(v) : `${currency || ''} ${(v / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const color = delta == null ? 'text-gray-400' : up ? 'text-emerald-600' : delta < 0 ? 'text-red-600' : 'text-gray-400';
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900 mt-0.5">{fmt(cur)}</div>
      {prev != null && (
        <div className={`text-xs mt-1 ${color}`}>
          {delta === 0 ? 'no change' : `${up ? '▲' : '▼'} ${fmt(Math.abs(delta))}${pct != null ? ` (${pct.toFixed(1)}%)` : ''}`}
        </div>
      )}
    </div>
  );
}

function AnomalyChip({ severity }) {
  const map = {
    BLOCKER: 'bg-red-100 text-red-700 border-red-200',
    WARNING: 'bg-amber-100 text-amber-800 border-amber-200',
    INFO: 'bg-blue-50 text-blue-700 border-blue-200',
  };
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold border ${map[severity] || map.INFO}`}>{severity}</span>;
}

function Drawer({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div className="relative w-full max-w-lg h-full bg-white shadow-xl overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── New-run modal (PICKER-based, not free-text UUIDs) ─────────────────────────
function NewRunModal({ onClose, onCreated }) {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [payCalendarId, setPayCalendarId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/payroll/entities')
      .then((res) => setEntities(res?.items || []))
      .catch((e) => setError(e.message || 'Failed to load entities.'));
  }, []);

  const entity = entities.find((e) => e.id === entityId) || null;
  const calendars = entity?.payCalendars || [];

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const run = await post('/api/hr/payroll/runs', { entityId, payCalendarId, periodStart, periodEnd });
      onCreated(run);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to create pay run.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New pay run" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <label className="block text-sm">
          <span className="flex items-center text-gray-700 font-medium">Entity<InfoTip text="The legal entity you're paying. Its country sets the tax & statutory rules (e.g. India PF/ESI/TDS) for this run." /></span>
          <select
            value={entityId}
            onChange={(e) => { setEntityId(e.target.value); setPayCalendarId(''); }}
            required
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Select entity…</option>
            {entities.map((en) => (
              <option key={en.id} value={en.id}>{en.code} — {en.legalName} ({en.countryCode})</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="flex items-center text-gray-700 font-medium">Pay calendar<InfoTip text="The schedule that defines how often you pay (e.g. Monthly) and the cut-off dates. Pick the entity first to see its calendars." /></span>
          <select
            value={payCalendarId}
            onChange={(e) => setPayCalendarId(e.target.value)}
            required
            disabled={!entityId}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
          >
            <option value="">{entityId ? 'Select calendar…' : 'Pick an entity first'}</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name} ({c.frequency})</option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <DateField label={<>Period start <InfoTip text="First day of the pay period this run covers (e.g. 1st of the month)." /></>} value={periodStart} onChange={setPeriodStart} required />
          <DateField label={<>Period end <InfoTip text="Last day of the pay period (e.g. month-end). Attendance and inputs up to this date are included." /></>} value={periodEnd} onChange={setPeriodEnd} required />
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
            Cancel
          </button>
          <PrimaryButton type="submit" loading={saving} disabled={!entityId || !payCalendarId}>Create draft</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Runs list ────────────────────────────────────────────────────────────────
function RunsList({ onOpen }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/payroll/runs', { page, pageSize: PAGE_SIZE, status: statusFilter || undefined })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load pay runs.'))
      .finally(() => setLoading(false));
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const items = data?.items || [];
  const total = data?.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = [
    {
      key: 'period', header: 'Period',
      render: (r) => (
        <button type="button" onClick={() => onOpen(r.id)} className="font-medium text-gray-900 hover:underline text-left">
          {formatAdminDate(r.periodStart)} – {formatAdminDate(r.periodEnd)}
        </button>
      ),
    },
    { key: 'entity', header: 'Entity', render: (r) => r.entity?.legalName || r.entity?.code || r.entityId || '—' },
    { key: 'employees', header: 'Headcount', render: (r) => r.headcount ?? '—' },
    { key: 'net', header: 'Net pay', render: (r) => moneyish(r.totalNet, r.currencyCode) },
    { key: 'stage', header: 'Stage', render: (r) => <StageStepper status={r.status} closed={!!r.closedAt} /> },
    { key: 'open', header: '', render: (r) => <ActionButton onClick={() => onOpen(r.id)}>Open</ActionButton> },
  ];

  return (
    <div>
      <PageHeader title="Payroll" subtitle="Pay runs" actions={<PrimaryButton onClick={() => setShowNew(true)}>New pay run</PrimaryButton>} />
      <ModuleGuide
        id="payroll"
        title="Run monthly payroll, end to end"
        what="The payroll console drives each pay run through its full lifecycle — Draft → Computed → In review → Approved → Paid → Filed — with maker-checker approval, pre-run health checks, and India statutory filing exports (EPF ECR, ESIC, Form 24Q)."
        steps={[
          'Click New pay run, pick the legal entity and its pay calendar, and set the period (e.g. 1–30 June 2026) to create a Draft.',
          'Open the run and work the inputs checklist: stage one-time items (bonus, arrear, recovery, reimbursement), then Freeze attendance & compute.',
          'Review the variance report and Payroll health — net/gross deltas vs last month, plus blockers, warnings and flagged employees.',
          'Resolve or acknowledge any blockers (an approver can override with a reason), then Submit for approval.',
          'A different reviewer (maker ≠ checker) approves, then Pay to publish payslips, and File to generate EPF/ESIC/24Q exports.',
        ]}
        example={<>For <b>Acme India Pvt Ltd</b>, June 2026, monthly calendar: <b>Aarav Sharma</b> (₹12,00,000 CTC) takes 2 LOP days, so net pay drops ~9% — flagged as a warning, not a blocker. After a checker approves, payslips publish and the <b>Form 24Q</b> + <b>EPF ECR</b> files are ready to download for filing.</>}
        tips={[
          'Compute runs even with warnings, but unresolved BLOCKERs gate Submit and Approve — clear or acknowledge them first.',
          'The person who computes/submits a run cannot approve it; line up a second reviewer to avoid being stuck in review.',
        ]}
      />
      <div className="flex items-center gap-2 mb-3">
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
          <option value="">All statuses</option>
          {['DRAFT', 'INPUTS_LOCKED', 'COMPUTED', 'REVIEW', 'APPROVED', 'PAID', 'FILED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-xs text-gray-400">FnF runs hidden from this list.</span>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No pay runs yet." />
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50">Previous</button>
          <span className="text-gray-500">Page {page} of {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50">Next</button>
        </div>
      )}
      {showNew && (
        <NewRunModal
          onClose={() => setShowNew(false)}
          onCreated={(run) => { setShowNew(false); if (run?.id) onOpen(run.id); else load(); }}
        />
      )}
    </div>
  );
}

// One-time input kinds (mirror the backend PayRunInputKind enum + friendly copy).
const ONE_TIME_KINDS = [
  { value: 'OTE', label: 'One-time earning (bonus, incentive)' },
  { value: 'OTD', label: 'One-time deduction (recovery, fine)' },
  { value: 'ARREAR', label: 'Arrear (back-pay)' },
  { value: 'REIMBURSEMENT', label: 'Reimbursement' },
];
const KIND_LABEL = Object.fromEntries(ONE_TIME_KINDS.map((k) => [k.value, k.label.split(' (')[0]]));

// Compact employee search picker for the one-time editor. Click to browse the
// directory + filter by name/code/email. Thin wrapper over the reusable
// EmployeeSearchSelect; keeps this editor's { selected, onSelect } contract
// (onSelect receives the full employee object, or null on clear).
function MiniEmployeePicker({ selected, onSelect }) {
  return (
    <EmployeeSearchSelect
      value={selected?.id || ''}
      selectedLabel={selected ? employeeLabel(selected) : ''}
      onSelect={(emp) => onSelect(emp || null)}
      placeholder="Search employee by name, code or email…"
    />
  );
}

// ── One-time / ad-hoc inputs editor (DRAFT only) — finding #25 ────────────────
function OneTimeInputsEditor({ runId, items, onChanged }) {
  const [emp, setEmp] = useState(null);
  const [kind, setKind] = useState('OTE');
  const [componentCode, setComponentCode] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState('');
  const [error, setError] = useState('');

  const amountNum = Number(amount);
  const valid = emp && kind && Number.isFinite(amountNum) && amountNum > 0;

  async function add(e) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true); setError('');
    try {
      // amountMinor is integer minor units (paise/cents) — convert the major-unit input.
      await post(`/api/hr/payroll/runs/${runId}/inputs/one-time`, {
        employeeId: emp.id,
        kind,
        componentCode: componentCode.trim() || undefined,
        amountMinor: Math.round(amountNum * 100),
        note: note.trim() || undefined,
      });
      setEmp(null); setAmount(''); setComponentCode(''); setNote(''); setKind('OTE');
      onChanged && onChanged();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to add one-time input.');
    } finally { setSaving(false); }
  }

  async function remove(item) {
    setRemoving(item.id); setError('');
    try {
      await post(`/api/hr/payroll/runs/${runId}/inputs/one-time`, { id: item.id, _delete: true });
      onChanged && onChanged();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to remove item.');
    } finally { setRemoving(''); }
  }

  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} />}
      <form onSubmit={add} className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Employee</label>
            <MiniEmployeePicker selected={emp} onSelect={setEmp} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {ONE_TIME_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Amount</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            {amount !== '' && !(amountNum > 0) && <p className="text-[11px] text-red-600 mt-0.5">Enter a positive amount.</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Component code <span className="text-gray-400">(optional)</span></label>
            <input value={componentCode} onChange={(e) => setComponentCode(e.target.value)} placeholder="e.g. BONUS"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Note <span className="text-gray-400">(optional)</span></label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason / reference"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-gray-400">Editable while the run is in Draft. Items apply at compute.</p>
          <PrimaryButton type="submit" loading={saving} disabled={!valid}>Add input</PrimaryButton>
        </div>
      </form>

      {items.length > 0 ? (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm bg-white">
              <div className="min-w-0">
                <span className="font-medium text-gray-900">{it.employeeName || it.employeeCode || it.employeeId}</span>
                <span className="ml-2 inline-block px-1.5 py-0.5 rounded bg-gray-100 text-[10px] font-semibold text-gray-700">{KIND_LABEL[it.kind] || it.kind}</span>
                {it.componentCode && <span className="ml-2 text-xs text-gray-500">→ {it.componentCode}</span>}
                {it.note && <span className="ml-2 text-xs text-gray-400 truncate">· {it.note}</span>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-semibold text-gray-900">{(it.amountMinor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <button type="button" disabled={removing === it.id} onClick={() => remove(it)} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-40">Remove</button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-400">No one-time items staged yet.</p>
      )}
    </div>
  );
}

// ── Inputs checklist (DRAFT) ──────────────────────────────────────────────────
function InputsChecklist({ runId, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    get(`/api/hr/payroll/runs/${runId}/inputs-checklist`).then(setData).catch((e) => setError(e.message));
  }, [runId]);
  useEffect(() => { load(); }, [load]);

  async function freeze() {
    setBusy('freeze'); setError('');
    try { await post(`/api/hr/payroll/runs/${runId}/freeze`); load(); onChanged && onChanged(); }
    catch (e) { setError(e.data?.message || e.message); }
    finally { setBusy(''); }
  }

  if (!data) return <Spinner />;
  const tone = { OK: 'text-emerald-600', WARN: 'text-amber-600', PARTIAL: 'text-amber-600', INFO: 'text-blue-600' };
  const oneTimeRow = data.rows.find((r) => r.key === 'oneTime');
  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} />}
      {data.rows.filter((r) => r.key !== 'oneTime').map((row) => (
        <div key={row.key} className="rounded-2xl border border-gray-200 bg-white p-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-gray-900">{row.label} <span className={`text-xs font-medium ${tone[row.status] || 'text-gray-400'}`}>· {row.status}</span></div>
            <div className="text-xs text-gray-500 mt-0.5">{row.detail}</div>
          </div>
          {row.key === 'attendance' && (
            <PrimaryButton loading={busy === 'freeze'} onClick={freeze}>Freeze attendance &amp; compute</PrimaryButton>
          )}
        </div>
      ))}

      {/* One-time / ad-hoc inputs — interactive editor (finding #25) */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="text-sm font-semibold text-gray-900">One-time inputs <span className="text-xs font-medium text-gray-400">· {(oneTimeRow?.items || []).length} staged</span></div>
            <div className="text-xs text-gray-500 mt-0.5">Bonuses, one-off deductions, arrears and reimbursements applied to this run only.</div>
          </div>
        </div>
        {oneTimeRow?.editable
          ? <OneTimeInputsEditor runId={runId} items={oneTimeRow.items || []} onChanged={() => { load(); onChanged && onChanged(); }} />
          : (
            <div className="text-xs text-gray-500">
              Inputs are frozen — the run has moved past Draft.
              {(oneTimeRow?.items || []).length > 0 && (
                <ul className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
                  {oneTimeRow.items.map((it) => (
                    <li key={it.id} className="flex items-center justify-between px-3 py-2 bg-white">
                      <span className="font-medium text-gray-900">{it.employeeName || it.employeeId} <span className="ml-1 text-[10px] text-gray-500">{KIND_LABEL[it.kind] || it.kind}</span></span>
                      <span className="font-semibold text-gray-900">{(it.amountMinor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
      </div>

      <p className="text-xs text-gray-400">Compute is enabled even with warnings; blockers from variance disable submit downstream.</p>
    </div>
  );
}

// ── Variance review (3 tiers) ────────────────────────────────────────────────
function VarianceReview({ runId, run, readOnly }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [drawerEmp, setDrawerEmp] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    post(`/api/hr/payroll/runs/${runId}/variance`)
      .then(setReport)
      .catch((e) => setError(e.data?.message || e.message || 'Variance unavailable — showing anomalies only.'))
      .finally(() => setLoading(false));
  }, [runId]);
  useEffect(() => { load(); }, [load]);

  const currency = run?.currencyCode;

  if (loading) return <Spinner />;

  const findings = report?.findings || [];
  const blockers = findings.filter((f) => f.severity === 'BLOCKER');
  const warnings = findings.filter((f) => f.severity === 'WARNING');
  const infos = findings.filter((f) => f.severity === 'INFO');

  // Tier 1 totals — from the variance response (freshest), falling back to the
  // persisted run varianceReport.
  const vt = report?.totals || run?.varianceReport?.totals || null;

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      {!report?.hasBaseline && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-700">
          First run for this entity/calendar — no prior period to compare. Showing absolute totals + absolute checks only.
        </div>
      )}

      {/* Tier 1 — headline deltas */}
      <div className="grid sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <DeltaCard label="Net" current={vt?.current?.net} previous={vt?.previous?.net} currency={currency} />
        <DeltaCard label="Gross" current={vt?.current?.gross} previous={vt?.previous?.gross} currency={currency} />
        <DeltaCard label="Deductions" current={vt?.current?.deductions} previous={vt?.previous?.deductions} currency={currency} />
        <DeltaCard label="Employer cost" current={vt?.current?.employerCost} previous={vt?.previous?.employerCost} currency={currency} />
        <DeltaCard label="Headcount" current={vt?.current?.headcount} previous={vt?.previous?.headcount} kind="count" />
      </div>

      {/* Severity-split anomalies */}
      <div className="grid sm:grid-cols-3 gap-3">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3">
          <div className="text-xs font-semibold text-red-700">Blockers ({blockers.length})</div>
          <ul className="mt-2 space-y-1 text-xs text-red-800">{blockers.map((f, i) => <li key={i}>{f.message}</li>)}{!blockers.length && <li className="text-red-400">None — approval is not gated.</li>}</ul>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <div className="text-xs font-semibold text-amber-800">Warnings ({warnings.length})</div>
          <ul className="mt-2 space-y-1 text-xs text-amber-800">{warnings.slice(0, 8).map((f, i) => <li key={i}>{f.message}</li>)}{warnings.length > 8 && <li>+{warnings.length - 8} more…</li>}</ul>
        </div>
        <div className="rounded-2xl border border-blue-100 bg-blue-50 p-3">
          <div className="text-xs font-semibold text-blue-700">Context ({infos.length})</div>
          <ul className="mt-2 space-y-1 text-xs text-blue-700">{infos.slice(0, 8).map((f, i) => <li key={i}>{f.message}</li>)}{infos.length > 8 && <li>+{infos.length - 8} more…</li>}</ul>
        </div>
      </div>

      {/* Tier 3 — flagged employees (drill into computeTrace) */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Flagged employees</h3>
        <DataTable
          columns={[
            { key: 'emp', header: 'Employee', render: (f) => f.employeeId },
            { key: 'sev', header: '', render: (f) => <AnomalyChip severity={f.severity} /> },
            { key: 'code', header: 'Finding', render: (f) => f.code },
            { key: 'msg', header: 'Detail', render: (f) => <span className="text-xs text-gray-600">{f.message}</span> },
            { key: 'drill', header: '', render: (f) => f.employeeId && <ActionButton onClick={() => setDrawerEmp(f.employeeId)}>Drill</ActionButton> },
          ]}
          rows={findings.filter((f) => f.employeeId && f.severity !== 'INFO')}
          loading={false}
          emptyText="No flagged employees."
        />
      </div>

      {drawerEmp && (
        <EmployeeVarianceDrawer runId={runId} run={run} employeeId={drawerEmp} onClose={() => setDrawerEmp(null)} />
      )}
    </div>
  );
}

function EmployeeVarianceDrawer({ run, employeeId, onClose }) {
  const line = (run?.lines || []).find((l) => l.employeeId === employeeId);
  const trace = line?.computeTrace;
  return (
    <Drawer title={`Employee ${employeeId}`} onClose={onClose}>
      {line ? (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>Gross: <b>{moneyish(line.grossEarnings, run.currencyCode)}</b></div>
            <div>Net: <b>{moneyish(line.netPay, run.currencyCode)}</b></div>
            <div className="flex items-center">Payable days: <b className="ml-1">{String(line.payableDays)}</b><InfoTip text="Days actually paid (present + paid-leave + weekly-off + holidays). Salary is prorated by payable ÷ standard days." /></div>
            <div className="flex items-center">LOP days: <b className="ml-1">{String(line.lopDays)}</b><InfoTip text="Loss-of-Pay days that reduced this salary pro-rata. LOP = approved unpaid leave (LWP) + unauthorised absence. It is shown as a reduction, not a separate deduction." /></div>
          </div>
          {Number(line.lopDays) > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {Number(line.lwpDays) > 0 && (
                <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
                  {line.lwpDays} LWP (approved unpaid)
                </span>
              )}
              {Number(line.lopDays) - Number(line.lwpDays || 0) > 0 && (
                <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-rose-200">
                  {Math.round((Number(line.lopDays) - Number(line.lwpDays || 0)) * 1e4) / 1e4} absent / other
                </span>
              )}
            </div>
          )}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">Components</div>
            <ul className="text-xs space-y-0.5">
              {(line.components || []).map((c) => (
                <li key={c.id} className="flex justify-between"><span>{c.componentName}</span><span>{moneyish(c.amount, run.currencyCode)}</span></li>
              ))}
            </ul>
          </div>
          {Array.isArray(line.errorJson) && line.errorJson.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1">Findings</div>
              <ul className="text-xs space-y-1">{line.errorJson.map((f, i) => <li key={i}><AnomalyChip severity={f.severity} /> {f.message}</li>)}</ul>
            </div>
          )}
          {trace && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-500">Compute trace (explain)</summary>
              <pre className="mt-2 bg-gray-50 p-2 rounded overflow-x-auto text-[10px]">{JSON.stringify(trace, null, 2)}</pre>
            </details>
          )}
        </div>
      ) : <div className="text-sm text-gray-500">No line found.</div>}
    </Drawer>
  );
}

// ── Pre-run Payroll health / checks panel (Feature 7) ────────────────────────
// A readable, grouped review of every pre-run finding with per-employee
// drill-down, the suggestedAction, and an Acknowledge-with-reason override for
// BLOCKERs so a checker can clear the approval gate explicitly + audibly.

// Money formatter for minor units coming back from the variance report.
function minorMoney(minor, currency) {
  const v = Number(minor || 0) / 100;
  return `${currency || ''} ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Deterministic, template-based plain-language summary (NOT an LLM call): turns
// the run-level roll-up into one paragraph a human can read at a glance.
function plainLanguageSummary(report, currency) {
  if (!report) return '';
  const s = report.summary || {};
  const blocker = s.blocker || 0;
  const warning = s.warning || 0;
  const info = s.info || 0;
  const t = report.totals || {};
  const curNet = Number(t?.current?.net || 0);
  const prevNet = t?.previous?.net == null ? null : Number(t.previous.net);
  const swing = prevNet == null ? null : curNet - prevNet;
  const empCount = new Set((report.findings || []).filter((f) => f.employeeId && f.severity !== 'INFO').map((f) => f.employeeId)).size;

  const parts = [];
  if (!blocker && !warning) {
    parts.push('This run is clean — no blockers or warnings were raised.');
  } else {
    parts.push(`This run raised ${blocker} blocker${blocker === 1 ? '' : 's'} and ${warning} warning${warning === 1 ? '' : 's'}${info ? ` (plus ${info} context note${info === 1 ? '' : 's'})` : ''}.`);
  }
  if (swing != null) {
    const dir = swing > 0 ? 'up' : swing < 0 ? 'down' : 'unchanged';
    if (dir === 'unchanged') parts.push('Net pay is unchanged versus the previous period.');
    else parts.push(`Net pay is ${dir} ${minorMoney(Math.abs(swing), currency)} versus the previous period${empCount ? `, across ${empCount} flagged employee${empCount === 1 ? '' : 's'}` : ''}.`);
  }
  if (blocker > 0) parts.push('Approval is blocked until each blocker is resolved or explicitly acknowledged with a reason.');
  return parts.join(' ');
}

function FindingRow({ f, currency, canAck, onAck, ackedKeys }) {
  const key = `${f.code} ${f.employeeId || ''}`;
  const acked = ackedKeys.has(key);
  return (
    <li className="flex flex-wrap items-start gap-2 py-1.5 border-b border-gray-100 last:border-0">
      <AnomalyChip severity={f.severity} />
      <div className="flex-1 min-w-[12rem]">
        <div className="text-xs text-gray-800">
          <span className="font-mono text-[10px] text-gray-400 mr-1">{f.code}</span>
          {f.message}
        </div>
        {f.suggestedAction && <div className="text-[11px] text-gray-500 mt-0.5">→ {f.suggestedAction}</div>}
        {f.employeeId && <div className="text-[10px] text-gray-400 mt-0.5">Employee: {f.employeeId}</div>}
      </div>
      {f.severity === 'BLOCKER' && (
        acked
          ? <span className="text-[10px] font-semibold text-emerald-600 self-center">✓ Acknowledged</span>
          : canAck && <ActionButton tone="neutral" onClick={() => onAck(f)}>Acknowledge</ActionButton>
      )}
    </li>
  );
}

function AcknowledgeModal({ finding, runId, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (!reason.trim()) return;
    setBusy(true); setError('');
    try {
      await post(`/api/hr/payroll/runs/${runId}/anomalies/ack`, { code: finding.code, employeeId: finding.employeeId || null, reason: reason.trim() });
      onDone();
    } catch (e) { setError(e.data?.message || e.message || 'Failed to acknowledge.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal onClose={onClose} title="Acknowledge blocker (audited override)">
      <div className="space-y-3 text-sm">
        <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          <div className="font-semibold">{finding.code}{finding.employeeId ? ` · ${finding.employeeId}` : ''}</div>
          <div className="mt-0.5">{finding.message}</div>
        </div>
        <p className="text-xs text-gray-500">
          Overriding a blocker is recorded against your name with the reason below. The run can then be approved
          even though this blocker is open — use this only when the finding is understood and accepted.
        </p>
        {error && <ErrorBanner message={error} />}
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Reason (required)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. New joiner mid-month; net swing confirmed correct by HR."
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <ModalActions>
          <ActionButton tone="neutral" onClick={onClose}>Cancel</ActionButton>
          <PrimaryButton loading={busy} disabled={!reason.trim()} onClick={submit}>Acknowledge &amp; override</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

function PayrollHealthPanel({ runId, run, perms, readOnly, onChanged }) {
  const [report, setReport] = useState(null);
  const [acks, setAcks] = useState([]);
  const [gate, setGate] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [ackTarget, setAckTarget] = useState(null);
  const [drawerEmp, setDrawerEmp] = useState(null);
  const canAck = !readOnly && hasPermission(perms, 'canApprovePayroll');
  const currency = run?.currencyCode;

  const load = useCallback(() => {
    setLoading(true);
    post(`/api/hr/payroll/runs/${runId}/variance`)
      .then((res) => { setReport(res); setAcks(res.acknowledgements || []); setGate(res.blockerGate || null); })
      .catch((e) => setError(e.data?.message || e.message || 'Checks unavailable.'))
      .finally(() => setLoading(false));
  }, [runId]);
  useEffect(() => { load(); }, [load]);

  const findings = report?.findings || [];
  const blockers = findings.filter((f) => f.severity === 'BLOCKER');
  const warnings = findings.filter((f) => f.severity === 'WARNING');
  const infos = findings.filter((f) => f.severity === 'INFO');
  const ackedKeys = useMemo(() => new Set((acks || []).map((a) => `${a.code} ${a.employeeId || ''}`)), [acks]);
  const empPager = usePagination(findings.filter((f) => f.employeeId && f.severity !== 'INFO'), { initialPageSize: 10 });

  if (loading) return <Spinner />;

  const summaryLine = report
    ? `${report.summary?.blocker || 0} blocker(s), ${report.summary?.warning || 0} warning(s)`
      + (report.totals?.previous?.net != null
        ? `; ${minorMoney((report.totals.current?.net || 0) - report.totals.previous.net, currency)} net-pay swing`
        : '')
      + (gate ? ` · ${gate.remaining} unacknowledged blocker(s) gating approval` : '')
    : '';

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}

      {/* Run-level summary line + plain-language paragraph */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Payroll health</h3>
          <InfoTip text="Pre-run checks compare this run to the previous period and apply absolute sanity rules. Blockers gate approval; a blocker can be explicitly acknowledged with a reason by an approver." />
        </div>
        <div className="text-xs font-medium text-gray-700 mt-1">{summaryLine}</div>
        <p className="text-xs text-gray-500 mt-2">{plainLanguageSummary(report, currency)}</p>
        {!report?.hasBaseline && (
          <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50 p-2 text-[11px] text-blue-700">
            First run for this entity/calendar — no prior period to compare. Absolute checks only.
          </div>
        )}
      </div>

      {/* Severity-grouped findings */}
      <div className="grid lg:grid-cols-3 gap-3">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-red-700">Blockers ({blockers.length})</div>
            {gate && gate.acknowledged > 0 && <span className="text-[10px] text-emerald-700 font-semibold">{gate.acknowledged} acknowledged</span>}
          </div>
          <ul className="mt-1">
            {blockers.length === 0 && <li className="text-xs text-red-400 py-1">None — approval is not gated.</li>}
            {blockers.map((f, i) => <FindingRow key={i} f={f} currency={currency} canAck={canAck} onAck={setAckTarget} ackedKeys={ackedKeys} />)}
          </ul>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <div className="text-xs font-semibold text-amber-800">Warnings ({warnings.length})</div>
          <ul className="mt-1">
            {warnings.length === 0 && <li className="text-xs text-amber-400 py-1">None.</li>}
            {warnings.map((f, i) => <FindingRow key={i} f={f} currency={currency} canAck={false} onAck={() => {}} ackedKeys={ackedKeys} />)}
          </ul>
        </div>
        <div className="rounded-2xl border border-blue-100 bg-blue-50 p-3">
          <div className="text-xs font-semibold text-blue-700">Context ({infos.length})</div>
          <ul className="mt-1">
            {infos.length === 0 && <li className="text-xs text-blue-400 py-1">None.</li>}
            {infos.map((f, i) => <FindingRow key={i} f={f} currency={currency} canAck={false} onAck={() => {}} ackedKeys={ackedKeys} />)}
          </ul>
        </div>
      </div>

      {/* Per-employee drill-down (paginated for 100+ employees) */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Flagged employees</h3>
        <DataTable
          columns={[
            { key: 'emp', header: 'Employee', render: (f) => f.employeeId },
            { key: 'sev', header: '', render: (f) => <AnomalyChip severity={f.severity} /> },
            { key: 'code', header: 'Finding', render: (f) => f.code },
            { key: 'msg', header: 'Detail', render: (f) => <span className="text-xs text-gray-600">{f.message}</span> },
            { key: 'act', header: 'Suggested action', render: (f) => <span className="text-[11px] text-gray-500">{f.suggestedAction || '—'}</span> },
            { key: 'drill', header: '', render: (f) => f.employeeId && <ActionButton onClick={() => setDrawerEmp(f.employeeId)}>Drill</ActionButton> },
          ]}
          rows={empPager.pageItems}
          loading={false}
          emptyText="No flagged employees."
        />
        <Pagination pager={empPager} noun="findings" />
      </div>

      {/* Acknowledgement ledger */}
      {acks.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-3">
          <div className="text-xs font-semibold text-gray-700 mb-1">Acknowledged blockers ({acks.length})</div>
          <ul className="text-xs text-gray-600 space-y-1">
            {acks.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2">
                <span className="font-mono text-[10px] text-gray-400">{a.code}{a.employeeId ? ` · ${a.employeeId}` : ''}</span>
                <span className="italic">"{a.reason}"</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {drawerEmp && (
        <EmployeeVarianceDrawer runId={runId} run={run} employeeId={drawerEmp} onClose={() => setDrawerEmp(null)} />
      )}
      {ackTarget && (
        <AcknowledgeModal
          finding={ackTarget}
          runId={runId}
          onClose={() => setAckTarget(null)}
          onDone={() => { setAckTarget(null); load(); if (onChanged) onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Variance thresholds (tolerances) editor — canRunPayroll ──────────────────
const THRESHOLD_META = {
  softNetPct: { label: 'Net swing — warn at', tip: 'A net-pay change of at least this fraction vs last period raises a WARNING (e.g. 0.25 = 25%).' },
  hardNetPct: { label: 'Net swing — block at', tip: 'A net-pay change of at least this fraction (with no revision/arrear) raises a BLOCKER (e.g. 0.60 = 60%).' },
  grossPct: { label: 'Gross swing — warn at', tip: 'A gross change of at least this fraction vs last period raises a WARNING.' },
  componentPct: { label: 'Component swing — warn at', tip: 'A per-component change of at least this fraction (or a component appearing/vanishing) raises a WARNING.' },
  statutoryRateTolerance: { label: 'Statutory rate drift', tip: 'How far a statutory deduction’s effective rate (amount ÷ gross) may drift before a WARNING (e.g. 0.005 = 0.5%).' },
  statutoryBasePct: { label: 'Statutory base jump — warn at', tip: 'A statutory contribution amount moving by at least this fraction vs last period raises a WARNING (possible wage-base discontinuity).' },
  lopSpikeDays: { label: 'LOP spike (days)', tip: 'Loss-of-pay days jumping by at least this many vs last period raises a WARNING.' },
  absMinFloorMinor: { label: 'Outlier floor (paise)', tip: 'A minimum baseline (in minor units) for the percentage math so a tiny base value can’t blow up the ratio.' },
};

function ThresholdsConfig({ perms }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const canRun = hasPermission(perms, 'canRunPayroll');

  const load = useCallback(() => {
    get('/api/hr/payroll/runs/thresholds')
      .then((res) => { setData(res); setForm({ ...res.effective }); })
      .catch((e) => setError(e.data?.message || e.message || 'Thresholds unavailable.'));
  }, []);
  useEffect(() => { if (open && !data) load(); }, [open, data, load]);

  async function save() {
    setBusy(true); setError(''); setSaved(false);
    try {
      const res = await put('/api/hr/payroll/runs/thresholds', { config: form });
      setData(res); setForm({ ...res.effective }); setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError(e.data?.message || e.message || 'Failed to save thresholds.'); }
    finally { setBusy(false); }
  }
  function resetToDefaults() { if (data) setForm({ ...data.defaults }); }

  const keys = (data?.editableKeys || Object.keys(THRESHOLD_META));

  return (
    <div className="rounded-2xl border border-gray-200 bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between p-4 text-left">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">Variance tolerances</span>
          <InfoTip text="The thresholds the pre-run checks use. Loosening a tolerance means fewer warnings/blockers; tightening means more. Defaults are India-tuned." />
          {data?.isCustomised && <span className="text-[10px] font-semibold text-amber-600">customised</span>}
        </div>
        <span className="text-gray-400 text-xs">{open ? '▲ Hide' : '▼ Edit'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          {error && <ErrorBanner message={error} />}
          {!data ? <Spinner /> : (
            <>
              <div className="grid sm:grid-cols-2 gap-3">
                {keys.map((k) => {
                  const meta = THRESHOLD_META[k] || { label: k, tip: '' };
                  return (
                    <label key={k} className="block">
                      <span className="flex items-center text-xs font-medium text-gray-700">{meta.label}{meta.tip && <InfoTip text={meta.tip} />}</span>
                      <input
                        type="number"
                        step="any"
                        disabled={!canRun}
                        value={form[k] ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
                      />
                      <span className="text-[10px] text-gray-400">default {String(data.defaults[k])}</span>
                    </label>
                  );
                })}
              </div>
              {canRun ? (
                <div className="flex items-center gap-2">
                  <PrimaryButton loading={busy} onClick={save}>Save tolerances</PrimaryButton>
                  <ActionButton tone="neutral" onClick={resetToDefaults}>Reset to defaults</ActionButton>
                  {saved && <span className="text-xs font-semibold text-emerald-600">✓ Saved</span>}
                </div>
              ) : <p className="text-xs text-gray-500">You lack canRunPayroll — tolerances are read-only.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Decision bar (submit / approve / send-back) ──────────────────────────────
function DecisionBar({ run, runId, me, perms, onChanged }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [gate, setGate] = useState(null); // { total, acknowledged, remaining } — the OPERABLE blocker gate
  const status = run?.status;
  const isMaker = me && (run?.computedBy === me.id || run?.lockedBy === me.id || run?.submittedBy === me.id);
  const canApprove = hasPermission(perms, 'canApprovePayroll');
  const canRun = hasPermission(perms, 'canRunPayroll');

  // Keep the gate fresh (an acknowledge in the panel above re-loads the parent,
  // which remounts this) — fetch the operable blocker gate from the variance read.
  useEffect(() => {
    let alive = true;
    post(`/api/hr/payroll/runs/${runId}/variance`)
      .then((res) => { if (alive) setGate(res.blockerGate || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [runId]);

  // Raw blockers (from the loaded run) gate SUBMIT — a maker cannot override.
  const rawBlockers = (run?.anomalies || []).filter((a) => a.severity === 'BLOCKER').length;
  // Unacknowledged blockers gate APPROVE — a checker may acknowledge to proceed.
  const unacked = gate ? gate.remaining : rawBlockers;

  async function act(action, body) {
    setBusy(action); setError('');
    try { await post(`/api/hr/payroll/runs/${runId}/${action}`, body); onChanged(); }
    catch (e) { setError(e.data?.message || e.message || `Failed to ${action}.`); }
    finally { setBusy(''); }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-2">
      {error && <ErrorBanner message={error} />}
      {status === 'COMPUTED' && (
        <div className="flex items-center gap-2">
          <PrimaryButton
            loading={busy === 'submit'}
            disabled={rawBlockers > 0 || !canRun}
            onClick={() => act('submit')}
          >Submit for approval</PrimaryButton>
          {rawBlockers > 0 && <span className="text-xs text-red-600">{rawBlockers} blocker(s) must be resolved or acknowledged first.</span>}
        </div>
      )}
      {status === 'REVIEW' && (
        isMaker ? (
          <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
            You submitted this run — approval requires a different reviewer (maker ≠ checker).
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <ActionButton
                tone="positive"
                disabled={busy === 'approve' || unacked > 0 || !canApprove}
                onClick={() => act('approve', { totalsHash: run?.totalsHash })}
              >Approve</ActionButton>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Send-back reason"
                className="rounded-lg border border-gray-300 px-2 py-1 text-sm flex-1"
              />
              <ActionButton
                tone="neutral"
                disabled={busy === 'send-back' || !reason.trim() || !canApprove}
                onClick={() => act('send-back', { reason })}
              >Send back</ActionButton>
            </div>
            {unacked > 0 && (
              <span className="text-xs text-red-600">
                Approval is gated by {unacked} unacknowledged blocker(s)
                {gate && gate.acknowledged > 0 ? ` (${gate.acknowledged} already acknowledged)` : ''}. Acknowledge each blocker above with a reason to proceed.
              </span>
            )}
            {unacked === 0 && gate && gate.total > 0 && (
              <span className="text-xs text-emerald-600">All {gate.total} blocker(s) acknowledged — approval is allowed.</span>
            )}
            {!canApprove && <span className="text-xs text-gray-500">You lack canApprovePayroll.</span>}
          </div>
        )
      )}
    </div>
  );
}

// ── Disbursement + filing (APPROVED → PAID → FILED → closed) ──────────────────
function DisbursementPanel({ run, runId, perms, onChanged }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [dlBusy, setDlBusy] = useState('');
  const [offenders, setOffenders] = useState(null); // { kind, items } for the 422 banner
  const status = run?.status;
  const country = run?.entity?.countryCode;
  const fileKinds = FILE_KINDS_BY_COUNTRY[country] || [];
  const canApprove = hasPermission(perms, 'canApprovePayroll');
  const canReports = hasPermission(perms, 'canViewPayrollReports');

  async function act(action) {
    setBusy(action); setError('');
    try { await post(`/api/hr/payroll/runs/${runId}/${action}`); onChanged(); }
    catch (e) { setError(e.data?.message || e.message || `Failed to ${action}.`); }
    finally { setBusy(''); }
  }

  // Download a filing export with structured-error handling. A 422
  // MISSING_BANK_DETAILS returns an offender list (which employees to fix) that
  // we render as an actionable banner instead of opening a raw error tab.
  async function downloadExport(f) {
    setDlBusy(f.kind); setError(''); setOffenders(null);
    try {
      await downloadFile(`/api/hr/payroll/runs/${runId}/files/${f.kind}`);
    } catch (e) {
      if (e.status === 422 && Array.isArray(e.data?.offenders)) {
        setOffenders({ label: f.label, items: e.data.offenders, message: e.data.message });
      } else {
        setError(e.data?.message || e.message || `Failed to download ${f.label}.`);
      }
    } finally {
      setDlBusy('');
    }
  }

  const closed = status === 'FILED' && run?.closedAt;
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
      {error && <ErrorBanner message={error} />}
      <div className="flex items-center gap-2 flex-wrap">
        {status === 'APPROVED' && <PrimaryButton loading={busy === 'pay'} disabled={!canApprove} onClick={() => act('pay')}>Mark paid &amp; publish payslips</PrimaryButton>}
        {status === 'PAID' && <PrimaryButton loading={busy === 'file'} disabled={!canReports} onClick={() => act('file')}>File statutory returns</PrimaryButton>}
        {status === 'FILED' && !closed && <ActionButton tone="positive" disabled={busy === 'close' || !canReports} onClick={() => act('close')}>Close run</ActionButton>}
        {closed && <span className="text-xs font-semibold text-emerald-600">Run closed — fully immutable. Downloads only.</span>}
      </div>
      {['APPROVED', 'PAID', 'FILED'].includes(status) && fileKinds.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1">Filing exports ({country})</div>
          <div className="flex flex-wrap gap-2">
            {fileKinds.map((f) => (
              <button
                key={f.kind}
                type="button"
                disabled={dlBusy === f.kind}
                onClick={() => downloadExport(f)}
                className="px-2.5 py-1 text-xs font-medium border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {dlBusy === f.kind && <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />}
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">Bank-file total ties to run net {moneyish(run?.totalNet, run?.currencyCode)}.</p>
          {offenders && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-amber-800">
                  {offenders.label} blocked — {offenders.items.length} employee(s) need attention
                </div>
                <button type="button" onClick={() => setOffenders(null)} className="text-amber-500 hover:text-amber-700 text-xs">Dismiss</button>
              </div>
              <p className="text-[11px] text-amber-700 mt-0.5">{offenders.message || 'Fix the bank details below, then re-export.'}</p>
              <ul className="mt-2 space-y-1 text-xs text-amber-900">
                {offenders.items.map((o, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{o.employee || o.code || `Row ${o.index + 1}`}</span>
                    {o.code && o.employee && <span className="text-amber-500">· {o.code}</span>}
                    <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-[10px] font-semibold">{o.reason}</span>
                    <span className="text-amber-700">{o.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Run detail (guided run) ───────────────────────────────────────────────────
function RunDetail({ runId, onBack, tab, setTab, me, perms }) {
  const [run, setRun] = useState(null);
  const [payslips, setPayslips] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setLoading(true); setError('');
    Promise.all([
      get(`/api/hr/payroll/runs/${runId}`),
      get(`/api/hr/payroll/runs/${runId}/payslips`).catch(() => null),
    ])
      .then(([detail, slips]) => {
        setRun(detail ? { ...(detail.payRun || {}), totals: detail.totals, lines: detail.lines, anomalies: detail.anomalies } : null);
        setPayslips(slips);
      })
      .catch((e) => setError(e.message || 'Failed to load pay run.'))
      .finally(() => setLoading(false));
  }, [runId]);
  useEffect(() => { load(); }, [load]);

  async function runAction(action) {
    setBusy(action); setError('');
    try { await post(`/api/hr/payroll/runs/${runId}/${action}`); load(); }
    catch (e) { setError(e.data?.message || e.message || `Failed to ${action}.`); }
    finally { setBusy(''); }
  }

  const status = String(run?.status || '').toUpperCase();
  const lines = run?.lines || [];
  const totals = run?.totals || {};
  const anomalies = run?.anomalies || [];
  const blockers = anomalies.filter((a) => a.severity === 'BLOCKER');
  const warnings = anomalies.filter((a) => a.severity === 'WARNING');
  const slipRows = useMemo(() => (Array.isArray(payslips) ? payslips : payslips?.items || []), [payslips]);
  const immutable = IMMUTABLE.has(status);

  const lineColumns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r.employee || r)}</span> },
    { key: 'gross', header: 'Gross', render: (r) => moneyish(r.grossEarnings, r.currencyCode || run?.currencyCode) },
    { key: 'deductions', header: 'Deductions', render: (r) => moneyish(r.totalDeductions, r.currencyCode || run?.currencyCode) },
    { key: 'net', header: 'Net', render: (r) => moneyish(r.netPay, r.currencyCode || run?.currencyCode) },
    {
      key: 'flag', header: '',
      render: (r) => {
        const errs = Array.isArray(r.errorJson) ? r.errorJson : [];
        const hasB = errs.some((e) => e.severity === 'BLOCKER');
        const hasW = errs.some((e) => e.severity === 'WARNING');
        return hasB ? <AnomalyChip severity="BLOCKER" /> : hasW ? <AnomalyChip severity="WARNING" /> : null;
      },
    },
  ];

  if (loading) return <div className="py-12 flex justify-center"><Spinner /></div>;

  const tabs = [
    { key: 'inputs', label: 'Inputs' },
    { key: 'summary', label: 'Summary' },
    { key: 'checks', label: 'Checks' },
    { key: 'variance', label: 'Variance' },
    { key: 'approval', label: 'Approval' },
    { key: 'disburse', label: 'Disburse' },
  ];
  const sumNet = lines.reduce((s, l) => s + Number(l.netPay || 0), 0);
  const reconciles = Math.abs(sumNet - Number(totals.totalNet || 0)) < 0.005;

  return (
    <div>
      <button type="button" onClick={onBack} className="text-sm text-gray-500 hover:text-gray-800 mb-3">← Back to pay runs</button>

      <div className="flex items-start justify-between mb-4 gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">{run ? `${formatAdminDate(run.periodStart)} – ${formatAdminDate(run.periodEnd)}` : 'Pay run'}</h1>
            <StatusBadge status={run?.status} />
          </div>
          <p className="text-sm text-gray-500 mt-0.5">
            {run?.entity?.legalName || run?.entityId || ''} · {run?.code}
            {run?.complianceVersionId && <span className="ml-2 font-mono text-xs text-gray-400">inputs #{String(run.complianceVersionId).slice(0, 6)}</span>}
          </p>
          <div className="mt-2"><StageStepper status={run?.status} closed={!!run?.closedAt} /></div>
        </div>
        <div className="flex items-center gap-2">
          {(status === 'DRAFT' || status === 'COMPUTED') && (
            <PrimaryButton loading={busy === 'compute'} onClick={() => runAction('compute')}>{status === 'COMPUTED' ? 'Recompute' : 'Compute'}</PrimaryButton>
          )}
          {(status === 'INPUTS_LOCKED' || status === 'COMPUTED' || status === 'REVIEW') && !immutable && (
            <ActionButton tone="neutral" disabled={busy === 'reopen'} onClick={() => runAction('reopen')}>Reopen</ActionButton>
          )}
          {(status === 'DRAFT' || status === 'INPUTS_LOCKED' || status === 'COMPUTED' || status === 'REVIEW') && (
            <ActionButton tone="danger" disabled={busy === 'cancel'} onClick={() => runAction('cancel')}>Cancel</ActionButton>
          )}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {immutable && <div className="rounded-xl border border-gray-200 bg-gray-50 p-2 text-xs text-gray-500 mb-3">This run is {status} — read-only. Corrections require a CORRECTION run.</div>}

      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {tabs.map((tt) => (
          <button key={tt.key} type="button" onClick={() => setTab(tt.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 ${tab === tt.key ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-700'}`}>{tt.label}</button>
        ))}
      </div>

      {tab === 'inputs' && (
        status === 'DRAFT'
          ? <InputsChecklist runId={runId} onChanged={load} />
          : <div className="text-sm text-gray-500">Inputs are frozen — the run has moved past DRAFT.</div>
      )}

      {tab === 'summary' && (
        <div>
          <div className="grid sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
            <div className="rounded-2xl border border-gray-200 bg-white p-4"><div className="text-xl font-semibold">{moneyish(totals.totalGross, run?.currencyCode)}</div><div className="text-xs text-gray-500 mt-1">Gross</div></div>
            <div className="rounded-2xl border border-gray-200 bg-white p-4"><div className="text-xl font-semibold">{moneyish(totals.totalDeductions, run?.currencyCode)}</div><div className="text-xs text-gray-500 mt-1">Deductions</div></div>
            <div className="rounded-2xl border border-gray-200 bg-white p-4"><div className="text-xl font-semibold">{moneyish(totals.totalNet, run?.currencyCode)}</div><div className="text-xs text-gray-500 mt-1">Net pay</div></div>
            <div className="rounded-2xl border border-gray-200 bg-white p-4"><div className="text-xl font-semibold">{moneyish(totals.totalEmployerCost, run?.currencyCode)}</div><div className="text-xs text-gray-500 mt-1">Employer cost</div></div>
            <div className="rounded-2xl border border-gray-200 bg-white p-4"><div className="text-xl font-semibold">{totals.headcount ?? lines.length}</div><div className="text-xs text-gray-500 mt-1">Headcount</div></div>
          </div>
          {status !== 'DRAFT' && (
            <div className={`mb-3 text-xs font-medium ${reconciles ? 'text-emerald-600' : 'text-red-600'}`}>
              {reconciles ? '✓ Σ line net = run total net' : '✗ Reconciliation mismatch — recompute'}
            </div>
          )}
          {(blockers.length > 0 || warnings.length > 0) && (
            <div className="grid sm:grid-cols-2 gap-3 mb-4">
              <div className="rounded-2xl border border-red-200 bg-red-50 p-3">
                <div className="text-xs font-semibold text-red-700">Blockers ({blockers.length})</div>
                <ul className="mt-1 text-xs text-red-800 space-y-1">{blockers.map((a, i) => <li key={i}>{a.message || a.code}</li>)}</ul>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
                <div className="text-xs font-semibold text-amber-800">Warnings ({warnings.length})</div>
                <ul className="mt-1 text-xs text-amber-800 space-y-1">{warnings.map((a, i) => <li key={i}>{a.message || a.code}</li>)}</ul>
              </div>
            </div>
          )}
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Pay lines</h2>
          <DataTable columns={lineColumns} rows={lines} loading={false} emptyText="No lines — compute the run." />
        </div>
      )}

      {tab === 'checks' && (
        <div className="space-y-4">
          <ThresholdsConfig perms={perms} />
          {status === 'DRAFT'
            ? <div className="text-sm text-gray-500">Compute the run to see pre-run checks.</div>
            : <PayrollHealthPanel runId={runId} run={run} perms={perms} readOnly={immutable} onChanged={load} />}
        </div>
      )}

      {tab === 'variance' && (
        status === 'DRAFT' ? <div className="text-sm text-gray-500">Compute the run to see variance.</div>
          : <VarianceReview runId={runId} run={run} readOnly={immutable} />
      )}

      {tab === 'approval' && (
        <div className="space-y-4">
          {/* The checker reviews + acknowledges blockers here, then decides. */}
          {['COMPUTED', 'REVIEW'].includes(status)
            ? <PayrollHealthPanel runId={runId} run={run} perms={perms} readOnly={immutable} onChanged={load} />
            : <VarianceReview runId={runId} run={run} readOnly />}
          {(status === 'COMPUTED' || status === 'REVIEW') && (
            <DecisionBar run={run} runId={runId} me={me} perms={perms} onChanged={load} />
          )}
          {!['COMPUTED', 'REVIEW'].includes(status) && (
            <div className="text-sm text-gray-500">Approval applies once the run is computed/submitted.</div>
          )}
        </div>
      )}

      {tab === 'disburse' && (
        <div className="space-y-4">
          {['APPROVED', 'PAID', 'FILED'].includes(status) ? (
            <DisbursementPanel run={run} runId={runId} perms={perms} onChanged={load} />
          ) : <div className="text-sm text-gray-500">Disbursement unlocks after approval.</div>}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Payslips {status === 'PAID' || status === 'FILED' ? '(published)' : ''}</h2>
            <DataTable
              columns={[
                { key: 'employee', header: 'Employee', render: (r) => employeeLabel(r.employee || r) },
                { key: 'net', header: 'Net pay', render: (r) => moneyish(r.netPay, r.currencyCode || run?.currencyCode) },
                { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                { key: 'view', header: '', render: (r) => <a href={`/api/hr/payroll/payslips/${r.id}/pdf`} target="_blank" rel="noreferrer" className="text-xs font-medium hover:underline" style={{ color: 'var(--theme-primary)' }}>View PDF</a> },
              ]}
              rows={slipRows} loading={false} emptyText="No payslips — compute the run first." />
          </div>
        </div>
      )}
    </div>
  );
}

function PayrollInner() {
  const router = useRouter();
  const params = useSearchParams();
  const runId = params.get('run') || '';
  const tab = params.get('tab') || 'summary';
  const [me, setMe] = useState(null);
  const [perms, setPerms] = useState(null);

  useEffect(() => {
    get('/api/auth/me').then((res) => {
      const session = res?.user || res;
      setMe(session);
      setPerms(permissionsFromSession(session));
    }).catch(() => {});
  }, []);

  const open = useCallback((id) => router.push(`/payroll?run=${encodeURIComponent(id)}&tab=summary`), [router]);
  const back = useCallback(() => router.push('/payroll'), [router]);
  const setTab = useCallback((t) => router.push(`/payroll?run=${encodeURIComponent(runId)}&tab=${t}`), [router, runId]);

  return runId
    ? <RunDetail runId={runId} onBack={back} tab={tab} setTab={setTab} me={me} perms={perms} />
    : <RunsList onOpen={open} />;
}

export default function PayrollPage() {
  return <Suspense fallback={<Spinner />}><PayrollInner /></Suspense>;
}

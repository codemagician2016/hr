'use client';

// Reports Platform console — four tabs over /api/hr/reports:
//
//   1. Fixed reports  — the legacy read-only analytics (payroll register,
//      statutory summary, headcount) + the previously-unsurfaced leave
//      liability view. Each gains a CSV/XLSX/PDF export split-button over the
//      new GET …/export endpoints, plus a small fail-soft SVG dashboard strip.
//      RBAC: canViewPayrollReports OR canViewReports (server ORs the keys).
//   2. Report builder — dataset registry (GET /datasets) → ordered column
//      pick → per-type filters → optional groupBy + sort → live preview
//      (POST /run-adhoc, paginated, capped-warning) → save (POST/PATCH
//      /definitions) → export. RBAC: canViewReports.
//   3. Saved reports  — GET /definitions (shared + own); run / export / edit
//      (creator-only) / delete (creator-only) / schedule shortcut.
//   4. Schedules      — email delivery of saved definitions (canScheduleReports):
//      GET/POST/PATCH/DELETE /schedules + POST /schedules/:id/run-now.
//
// Tabs live in the URL (?tab=fixed|builder|saved|schedules); the fixed tab's
// sub-view rides ?view= and the selected pay run ?run=. Legacy deep links
// (?tab=register|statutory|headcount) map onto the fixed tab. The server is
// the real enforcement boundary — permission checks here only hide UI.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Spinner, ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post, patch, del, downloadFile, qs } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, Tabs, ActionButton, ServerPagination, moneyish } from '@/lib/ui';
import { permissionsFromSession, hasPermission, hasAnyPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

const FORMATS = ['CSV', 'XLSX', 'PDF'];
const PAGE_SIZES = [25, 50, 100, 200];
// Backend WEEKLY anchor is a day-of-week 0-6, Sunday=0 (see reportBuilder.controller).
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAIN_TABS = [
  { key: 'fixed', label: 'Fixed reports' },
  { key: 'builder', label: 'Report builder' },
  { key: 'saved', label: 'Saved reports' },
  { key: 'schedules', label: 'Schedules' },
];
const FIXED_VIEWS = [
  { key: 'register', label: 'Payroll register' },
  { key: 'statutory', label: 'Statutory summary' },
  { key: 'headcount', label: 'Headcount' },
  { key: 'leave', label: 'Leave liability' },
];

// ── tiny shared bits ─────────────────────────────────────────────────────────

// Render a cell by registry column type. Money renders as a plain 2-dp number
// (datasets are multi-currency per row; a hardcoded symbol would lie).
function fmtCell(v, type) {
  if (v == null || v === '') return '—';
  if (type === 'date') return formatAdminDate(v);
  if (type === 'money') {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
  }
  if (type === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(v);
  }
  return String(v);
}

function TotalCard({ label, value }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function Chip({ children, tone = 'gray', title }) {
  const tones = {
    gray: 'bg-gray-100 text-gray-600',
    indigo: 'bg-indigo-50 text-indigo-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone] || tones.gray}`}>
      {children}
    </span>
  );
}

// Export split-button: CSV / XLSX / PDF over a cookie-authenticated download
// (downloadFile — the registers/disbursement idiom; honours Content-Disposition).
function ExportMenu({ buildPath, disabled, label = 'Export', onError }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');

  async function run(fmt) {
    setOpen(false);
    setBusy(fmt);
    try {
      await downloadFile(buildPath(fmt));
    } catch (e) {
      const msg = e.data?.message || e.message || 'Export failed.';
      if (onError) onError(msg);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !!busy}
        className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? `Exporting ${busy}…` : `${label} ▾`}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 z-20 mt-1 w-28 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => run(f)}
                className="block w-full px-3 py-2 text-left text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                {f}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Run picker (shared by register + statutory) ──────────────────────────────
function RunPicker({ value, onChange }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    get('/api/hr/reports/runs')
      .then((res) => setRuns(res?.items || []))
      .catch((e) => setError(e.message || 'Failed to load pay runs.'))
      .finally(() => setLoading(false));
  }, []);

  // Default-select the first run once loaded if none chosen.
  useEffect(() => {
    if (!value && runs.length > 0) onChange(runs[0].id);
  }, [runs, value, onChange]);

  return (
    <div className="mb-5">
      {error && <ErrorBanner message={error} />}
      <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Pay run</label>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading}
        className="w-full sm:w-96 rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
      >
        {loading && <option>Loading…</option>}
        {!loading && runs.length === 0 && <option value="">No pay runs</option>}
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.code} · {r.entityName || r.countryCode || ''} · {formatAdminDate(r.periodStart)}–{formatAdminDate(r.periodEnd)}
          </option>
        ))}
      </select>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Dashboard strip — three fail-soft hand-rolled SVG/bar cards (surveys idiom).
// ═════════════════════════════════════════════════════════════════════════════
function HBar({ pct, color = 'var(--theme-primary)' }) {
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
      <div className="h-2 rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, background: color }} />
    </div>
  );
}

function MiniBarChart({ buckets, valueKey = 'headcount' }) {
  const top = buckets.slice(0, 6);
  if (!top.length) return null;
  const max = Math.max(1, ...top.map((b) => Number(b[valueKey]) || 0));
  const W = 216;
  const H = 60;
  const gap = 6;
  const bw = (W - gap * (top.length - 1)) / top.length;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Headcount by department">
      {top.map((b, i) => {
        const v = Number(b[valueKey]) || 0;
        const h = Math.max(2, (v / max) * (H - 4));
        return (
          <rect key={b.key || b.label || i} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx="2" fill="var(--theme-primary)" opacity="0.85">
            <title>{`${b.label}: ${v}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function DashCard({ title, children }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</div>
      {children}
    </div>
  );
}

function DashStrip() {
  const [hc, setHc] = useState(null); // headcount by department
  const [reg, setReg] = useState(null); // latest run register totals
  const [ll, setLl] = useState(null); // leave liability

  useEffect(() => {
    const today = new Date();
    const from = `${today.getFullYear()}-01-01`;
    const to = today.toISOString().slice(0, 10);
    // Best-effort: each card is independent and a failure simply hides it.
    get('/api/hr/reports/headcount', { from, to, groupBy: 'department' }).then(setHc).catch(() => {});
    get('/api/hr/reports/runs')
      .then((r) => {
        const run = (r?.items || [])[0];
        if (!run) return null;
        return get(`/api/hr/reports/runs/${run.id}/register`).then((d) => setReg({ ...d, run }));
      })
      .catch(() => {});
    get('/api/hr/reports/leave-liability').then(setLl).catch(() => {});
  }, []);

  if (!hc && !reg && !ll) return null;

  const regRows = reg
    ? [
        { label: 'Gross', v: Number(reg.totals?.gross) || 0 },
        { label: 'Deductions', v: Number(reg.totals?.deductions) || 0 },
        { label: 'Net', v: Number(reg.totals?.net) || 0 },
      ]
    : [];
  const regMax = Math.max(1, ...regRows.map((r) => r.v));
  const llTypes = (ll?.byType || []).slice(0, 3);
  const llMax = Math.max(1, ...llTypes.map((t) => Number(t.value) || 0));

  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      {hc && (
        <DashCard title="Headcount by department">
          <div className="text-2xl font-semibold text-gray-900">{hc.totals?.headcount ?? '—'}</div>
          <div className="mt-2">
            <MiniBarChart buckets={hc.buckets || []} />
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            {(hc.buckets || []).slice(0, 3).map((b) => b.label).join(' · ') || 'No departments yet'}
          </div>
        </DashCard>
      )}
      {reg && (
        <DashCard title={`Latest run — ${reg.run?.code || ''}`}>
          <div className="text-2xl font-semibold text-gray-900">{moneyish(reg.totals?.net, reg.currencyCode)}</div>
          <div className="mb-2 text-[11px] text-gray-400">net pay · {reg.totals?.headcount ?? '—'} employees</div>
          <div className="space-y-1.5">
            {regRows.map((r) => (
              <div key={r.label} className="flex items-center gap-2 text-xs text-gray-600">
                <span className="w-20 shrink-0">{r.label}</span>
                <HBar pct={(r.v / regMax) * 100} />
                <span className="w-24 shrink-0 text-right tabular-nums">{moneyish(r.v, reg.currencyCode)}</span>
              </div>
            ))}
          </div>
        </DashCard>
      )}
      {ll && (
        <DashCard title="Leave liability">
          <div className="text-2xl font-semibold text-gray-900">{moneyish(ll.totalValue, ll.currencyCode)}</div>
          <div className="mb-2 text-[11px] text-gray-400">{fmtCell(ll.totalQuantity, 'number')} days/hours accrued</div>
          <div className="space-y-1.5">
            {llTypes.map((t) => (
              <div key={t.leaveTypeId || t.leaveTypeName || '—'} className="flex items-center gap-2 text-xs text-gray-600">
                <span className="w-20 shrink-0 truncate" title={t.leaveTypeName || '—'}>{t.leaveTypeName || '—'}</span>
                <HBar pct={((Number(t.value) || 0) / llMax) * 100} />
                <span className="w-24 shrink-0 text-right tabular-nums">{moneyish(t.value, ll.currencyCode)}</span>
              </div>
            ))}
            {!llTypes.length && <p className="text-xs text-gray-400">No accrued balances yet.</p>}
          </div>
        </DashCard>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Fixed reports — the legacy sub-views + leave liability, each with export.
// ═════════════════════════════════════════════════════════════════════════════
function RegisterView({ runId, onRun }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    setError('');
    get(`/api/hr/reports/runs/${runId}/register`)
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load register.'))
      .finally(() => setLoading(false));
  }, [runId]);

  const cur = data?.currencyCode;
  const columns = [
    { key: 'employeeCode', header: 'Code', render: (r) => r.employeeCode || '—' },
    { key: 'employeeName', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{r.employeeName || r.employeeId}</span> },
    { key: 'gross', header: 'Gross', render: (r) => moneyish(r.gross, cur) },
    { key: 'deductions', header: 'Deductions', render: (r) => moneyish(r.deductions, cur) },
    { key: 'net', header: 'Net', render: (r) => moneyish(r.net, cur) },
    { key: 'employerCost', header: 'Employer cost', render: (r) => moneyish(r.employerCost, cur) },
  ];
  const t = data?.totals || {};

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grow"><RunPicker value={runId} onChange={onRun} /></div>
        <div className="mb-5">
          <ExportMenu
            disabled={!runId}
            buildPath={(fmt) => `/api/hr/reports/runs/${runId}/register/export${qs({ format: fmt })}`}
            onError={setError}
          />
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {data && (
        <div className="grid sm:grid-cols-4 gap-4 mb-5">
          <TotalCard label="Total gross" value={moneyish(t.gross, cur)} />
          <TotalCard label="Total deductions" value={moneyish(t.deductions, cur)} />
          <TotalCard label="Total net" value={moneyish(t.net, cur)} />
          <TotalCard label="Employer cost" value={moneyish(t.employerCost, cur)} />
        </div>
      )}
      <DataTable columns={columns} rows={data?.rows || []} loading={loading} emptyText="Pick a pay run to view its register." rowKey={(r) => r.lineId || r.employeeId} />
      {data && (
        <p className="text-xs text-gray-500 mt-3">
          {t.headcount} employees · totals reconcile to the pay-run header.
        </p>
      )}
    </div>
  );
}

function StatutoryView({ runId, onRun }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    setError('');
    get(`/api/hr/reports/runs/${runId}/statutory`)
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load statutory summary.'))
      .finally(() => setLoading(false));
  }, [runId]);

  const cur = data?.currencyCode;
  const columns = [
    { key: 'label', header: 'Contribution', render: (r) => <span className="font-medium text-gray-900">{r.label}</span> },
    { key: 'group', header: 'Group', render: (r) => r.group },
    { key: 'amount', header: 'Amount', render: (r) => moneyish(r.amount, cur) },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grow"><RunPicker value={runId} onChange={onRun} /></div>
        <div className="mb-5">
          <ExportMenu
            disabled={!runId}
            buildPath={(fmt) => `/api/hr/reports/runs/${runId}/statutory/export${qs({ format: fmt })}`}
            onError={setError}
          />
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {data && (
        <div className="flex items-center gap-3 mb-5">
          <StatusBadge status={data.countryCode} />
          <span className="text-sm text-gray-500">{data.entityName} · period {data.taxPeriod || '—'}</span>
        </div>
      )}
      {data && (
        <div className="grid sm:grid-cols-2 gap-4 mb-5">
          <TotalCard label="Total statutory" value={moneyish(data.total, cur)} />
          <TotalCard label="Employees" value={data.headcount ?? '—'} />
        </div>
      )}
      <DataTable columns={columns} rows={data?.items || []} loading={loading} emptyText="Pick a pay run to view its statutory totals." rowKey={(r) => r.key} />
    </div>
  );
}

function HeadcountView() {
  const today = new Date();
  const ymd = (d) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.getFullYear()}-01-01`);
  const [to, setTo] = useState(ymd(today));
  const [groupBy, setGroupBy] = useState('department');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/reports/headcount', { from, to, groupBy })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load headcount.'))
      .finally(() => setLoading(false));
  }, [from, to, groupBy]);

  useEffect(() => { load(); }, [load]);

  const columns = [
    { key: 'label', header: groupBy === 'entity' ? 'Entity' : 'Department', render: (r) => <span className="font-medium text-gray-900">{r.label}</span> },
    { key: 'headcount', header: 'Headcount', render: (r) => r.headcount },
    { key: 'active', header: 'Active', render: (r) => r.active },
    { key: 'joined', header: 'Joined', render: (r) => r.joined },
    { key: 'terminated', header: 'Terminated', render: (r) => r.terminated },
  ];
  const t = data?.totals || {};

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Group by</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="department">Department</option>
            <option value="entity">Entity</option>
          </select>
        </div>
        <div className="ml-auto">
          <ExportMenu
            buildPath={(fmt) => `/api/hr/reports/headcount/export${qs({ from, to, groupBy, format: fmt })}`}
            onError={setError}
          />
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {data && (
        <div className="grid sm:grid-cols-4 gap-4 mb-5">
          <TotalCard label="Headcount" value={t.headcount ?? '—'} />
          <TotalCard label="Active" value={t.active ?? '—'} />
          <TotalCard label="Joined" value={t.joined ?? '—'} />
          <TotalCard label={`Attrition (${t.attritionRate ?? 0}%)`} value={t.terminated ?? '—'} />
        </div>
      )}
      <DataTable columns={columns} rows={data?.buckets || []} loading={loading} emptyText="No employees in range." rowKey={(r) => r.key} />
    </div>
  );
}

// NEW — leave liability (GET /leave-liability?periodCode=): accrued balances
// valued at the current day-rate, totals + by-type rollup + per-balance rows.
function LeaveLiabilityView() {
  const [periodCode, setPeriodCode] = useState('');
  const [applied, setApplied] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/reports/leave-liability', applied ? { periodCode: applied } : undefined)
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load leave liability.'))
      .finally(() => setLoading(false));
  }, [applied]);

  useEffect(() => { load(); }, [load]);

  const cur = data?.currencyCode;
  const columns = [
    { key: 'employeeId', header: 'Employee', render: (r) => <span className="font-mono text-xs text-gray-700">{r.employeeId}</span> },
    { key: 'leaveTypeName', header: 'Leave type', render: (r) => <span className="font-medium text-gray-900">{r.leaveTypeName || '—'}</span> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    { key: 'quantity', header: 'Balance', render: (r) => fmtCell(r.quantity, 'number') },
    { key: 'value', header: 'Value', render: (r) => moneyish(r.value, r.currencyCode || cur) },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Period code (optional)</label>
          <input
            value={periodCode}
            onChange={(e) => setPeriodCode(e.target.value)}
            placeholder="e.g. 2026"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => setApplied(periodCode.trim())}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Apply
        </button>
        <div className="ml-auto">
          <ExportMenu
            buildPath={(fmt) => `/api/hr/reports/leave-liability/export${qs({ periodCode: applied || undefined, format: fmt })}`}
            onError={setError}
          />
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {data && (
        <div className="grid sm:grid-cols-3 gap-4 mb-5">
          <TotalCard label="Total accrued quantity" value={fmtCell(data.totalQuantity, 'number')} />
          <TotalCard label="Total liability value" value={moneyish(data.totalValue, cur)} />
          <TotalCard label="Leave types" value={(data.byType || []).length} />
        </div>
      )}
      {data && (data.byType || []).length > 0 && (
        <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">By leave type</div>
          <div className="space-y-1.5">
            {data.byType.map((t) => {
              const max = Math.max(1, ...data.byType.map((x) => Number(x.value) || 0));
              return (
                <div key={t.leaveTypeId || t.leaveTypeName || '—'} className="flex items-center gap-2 text-xs text-gray-600">
                  <span className="w-40 shrink-0 truncate" title={t.leaveTypeName || '—'}>{t.leaveTypeName || '—'}</span>
                  <HBar pct={((Number(t.value) || 0) / max) * 100} />
                  <span className="w-40 shrink-0 text-right tabular-nums">
                    {fmtCell(t.quantity, 'number')} · {moneyish(t.value, cur)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <DataTable
        columns={columns}
        rows={data?.rows || []}
        loading={loading}
        emptyText="No accrued leave balances found."
        rowKey={(r, i) => `${r.employeeId}-${r.leaveTypeId}-${i}`}
      />
    </div>
  );
}

function FixedTab({ view, onView, runId, onRun }) {
  return (
    <div>
      <DashStrip />
      <Tabs tabs={FIXED_VIEWS} active={view} onChange={onView} />
      {view === 'register' && <RegisterView runId={runId} onRun={onRun} />}
      {view === 'statutory' && <StatutoryView runId={runId} onRun={onRun} />}
      {view === 'headcount' && <HeadcountView />}
      {view === 'leave' && <LeaveLiabilityView />}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared run-result panel (builder preview + saved-report run)
// ═════════════════════════════════════════════════════════════════════════════
function RunResultPanel({ result, loading, onPageChange, onPageSizeChange, emptyText = 'No rows matched.' }) {
  if (!result && !loading) return null;
  const cols = (result?.columns || []).map((c) => ({
    key: c.key,
    header: c.label,
    render: (r) => fmtCell(r[c.key], c.type),
  }));
  return (
    <div>
      {result?.capped && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Results are capped at the first 10,000 source rows — totals and groups cover only what was fetched. Narrow the filters for a complete picture.
        </div>
      )}
      <DataTable
        columns={cols.length ? cols : [{ key: '_', header: '' }]}
        rows={result?.rows || []}
        loading={loading}
        emptyText={emptyText}
        rowKey={(r, i) => i}
      />
      {result?.totals && (result.rows || []).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(result.totals).map(([k, v]) => {
            const col = (result.columns || []).find((c) => c.key === k);
            return (
              <span key={k} className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                Σ {col ? col.label : k}: {fmtCell(v, col ? col.type : 'number')}
              </span>
            );
          })}
        </div>
      )}
      {result && (
        <ServerPagination
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          sizes={PAGE_SIZES}
          noun="rows"
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Report builder
// ═════════════════════════════════════════════════════════════════════════════
function emptyBuilderForm() {
  return {
    id: null,
    name: '',
    description: '',
    isShared: false,
    datasetKey: '',
    columns: [],
    filters: {},
    groupBy: '',
    sortKey: '',
    sortDir: 'asc',
  };
}

function formFromDefinition(d) {
  return {
    id: d.id,
    name: d.name || '',
    description: d.description || '',
    isShared: !!d.isShared,
    datasetKey: d.datasetKey || '',
    columns: Array.isArray(d.columns) ? [...d.columns] : [],
    filters: d.filters && typeof d.filters === 'object' ? { ...d.filters } : {},
    groupBy: d.groupBy || '',
    sortKey: d.sort?.key || '',
    sortDir: d.sort?.dir === 'desc' ? 'desc' : 'asc',
  };
}

// The definition-shaped body shared by run-adhoc + save (empty pieces dropped).
function defBodyFromForm(form) {
  const filters = {};
  for (const [k, v] of Object.entries(form.filters || {})) {
    if (v != null && v !== '') filters[k] = v;
  }
  return {
    datasetKey: form.datasetKey,
    columns: form.columns,
    filters,
    groupBy: form.groupBy || null,
    sort: form.sortKey ? { key: form.sortKey, dir: form.sortDir } : null,
  };
}

function BuilderTab({ registry, registryError, editing, onSaved, onReset }) {
  const [form, setForm] = useState(() => (editing ? formFromDefinition(editing) : emptyBuilderForm()));
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  const [error, setError] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedDef, setSavedDef] = useState(null);

  // Re-prefill when the Saved tab hands over a (different) definition to edit.
  useEffect(() => {
    if (editing) {
      setForm(formFromDefinition(editing));
      setPreview(null);
      setSavedDef(null);
      setError('');
    }
  }, [editing]);

  const dataset = useMemo(
    () => (registry || []).find((d) => d.key === form.datasetKey) || null,
    [registry, form.datasetKey]
  );
  const colByKey = useMemo(
    () => new Map((dataset?.columns || []).map((c) => [c.key, c])),
    [dataset]
  );

  function pickDataset(key) {
    const d = (registry || []).find((x) => x.key === key);
    setForm((f) => ({
      ...emptyBuilderForm(),
      id: f.id,
      name: f.name,
      description: f.description,
      isShared: f.isShared,
      datasetKey: key,
      columns: d ? d.columns.map((c) => c.key) : [],
    }));
    setPreview(null);
    setSavedDef(null);
  }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setFilter = (k, v) => setForm((f) => ({ ...f, filters: { ...f.filters, [k]: v } }));
  const removeColumn = (key) => setForm((f) => ({ ...f, columns: f.columns.filter((c) => c !== key) }));
  const addColumn = (key) => setForm((f) => (f.columns.includes(key) ? f : { ...f, columns: [...f.columns, key] }));
  const moveColumn = (idx, dir) => setForm((f) => {
    const to = idx + dir;
    if (to < 0 || to >= f.columns.length) return f;
    const next = [...f.columns];
    const [c] = next.splice(idx, 1);
    next.splice(to, 0, c);
    return { ...f, columns: next };
  });

  // Server-allowed sort keys: grouped → [groupBy, count, …all dataset cols];
  // ungrouped → all dataset cols (see builder.service.js validateDefinition).
  const sortOptions = useMemo(() => {
    if (!dataset) return [];
    const base = dataset.columns.map((c) => ({ key: c.key, label: c.label }));
    if (form.groupBy) {
      const g = colByKey.get(form.groupBy);
      return [
        { key: form.groupBy, label: `${g ? g.label : form.groupBy} (group)` },
        { key: 'count', label: 'Count (group size)' },
        ...base.filter((o) => o.key !== form.groupBy),
      ];
    }
    return base;
  }, [dataset, form.groupBy, colByKey]);

  // A groupBy change can invalidate the chosen sort key — reset quietly.
  useEffect(() => {
    if (form.sortKey && !sortOptions.some((o) => o.key === form.sortKey)) set('sortKey', '');
  }, [sortOptions, form.sortKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const runPreview = useCallback(async (page = 1, ps = pageSize) => {
    if (!form.datasetKey) { setError('Pick a dataset first.'); return; }
    if (!form.columns.length) { setError('Pick at least one column.'); return; }
    setPreviewLoading(true);
    setError('');
    try {
      const res = await post('/api/hr/reports/run-adhoc', { ...defBodyFromForm(form), page, pageSize: ps });
      setPreview(res);
    } catch (e) {
      setError(e.data?.message || e.message || 'Preview failed.');
    } finally {
      setPreviewLoading(false);
    }
  }, [form, pageSize]);

  async function save() {
    if (!form.name.trim()) { setError('Give the report a name.'); return; }
    setSaving(true);
    setError('');
    try {
      const body = {
        ...defBodyFromForm(form),
        name: form.name.trim(),
        description: form.description.trim() ? form.description.trim() : null,
        isShared: !!form.isShared,
      };
      const res = form.id
        ? await patch(`/api/hr/reports/definitions/${form.id}`, body)
        : await post('/api/hr/reports/definitions', body);
      setForm((f) => ({ ...f, id: res.id }));
      setSavedDef(res);
      setSaveOpen(false);
      if (onSaved) onSaved(res);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to save the report.');
    } finally {
      setSaving(false);
    }
  }

  function startFresh() {
    setForm(emptyBuilderForm());
    setPreview(null);
    setSavedDef(null);
    setError('');
    if (onReset) onReset();
  }

  if (registryError) return <ErrorBanner message={registryError} />;
  if (!registry) return <div className="py-12 flex justify-center"><Spinner /></div>;

  const unpicked = dataset ? dataset.columns.filter((c) => !form.columns.includes(c.key)) : [];

  return (
    <div>
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      {savedDef && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span>
            Saved “{savedDef.name}” {savedDef.isShared ? '(shared with all report viewers)' : '(private to you)'}.
          </span>
          <ExportMenu
            buildPath={(fmt) => `/api/hr/reports/definitions/${savedDef.id}/export${qs({ format: fmt })}`}
            onError={setError}
          />
          <button type="button" onClick={startFresh} className="text-xs font-medium underline">
            Start a new report
          </button>
        </div>
      )}

      <div className="space-y-5">
        {/* ── Dataset ── */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            1 · Dataset {form.id && <span className="ml-2 font-normal normal-case text-gray-400">(editing “{form.name || 'Untitled'}”)</span>}
          </h2>
          <select
            value={form.datasetKey}
            onChange={(e) => pickDataset(e.target.value)}
            className="w-full sm:w-96 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Pick a dataset…</option>
            {registry.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
          {dataset && (
            <p className="mt-2 text-xs text-gray-400">
              {dataset.columns.length} columns · {dataset.filters.length} filters · groupable by {dataset.groupable.join(', ') || '—'}
            </p>
          )}
        </section>

        {dataset && (
          <>
            {/* ── Columns (ordered) ── */}
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">2 · Columns (in order)</h2>
              {form.columns.length === 0 && <p className="mb-2 text-sm text-gray-400">No columns picked — add at least one below.</p>}
              <div className="flex flex-wrap gap-2">
                {form.columns.map((key, i) => {
                  const c = colByKey.get(key);
                  return (
                    <span key={key} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                      <span className="text-gray-400">{i + 1}.</span> {c ? c.label : key}
                      <button type="button" onClick={() => moveColumn(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label={`Move ${key} up`}>↑</button>
                      <button type="button" onClick={() => moveColumn(i, 1)} disabled={i === form.columns.length - 1} className="text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label={`Move ${key} down`}>↓</button>
                      <button type="button" onClick={() => removeColumn(key)} className="text-gray-400 hover:text-red-600" aria-label={`Remove ${key}`}>✕</button>
                    </span>
                  );
                })}
              </div>
              {unpicked.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                  <span className="text-xs font-medium text-gray-500">Add:</span>
                  {unpicked.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => addColumn(c.key)}
                      className="rounded-full border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      + {c.label}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* ── Filters ── */}
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">3 · Filters</h2>
              {dataset.filters.length === 0 ? (
                <p className="text-sm text-gray-400">This dataset has no filters.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {dataset.filters.map((f) => (
                    <div key={f.key}>
                      <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">{f.label}</label>
                      {f.type === 'enum' ? (
                        <select
                          value={form.filters[f.key] || ''}
                          onChange={(e) => setFilter(f.key, e.target.value)}
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                        >
                          <option value="">Any</option>
                          {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : f.type === 'date' ? (
                        <input
                          type="date"
                          value={form.filters[f.key] || ''}
                          onChange={(e) => setFilter(f.key, e.target.value)}
                          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                        />
                      ) : (
                        <input
                          value={form.filters[f.key] || ''}
                          onChange={(e) => setFilter(f.key, e.target.value)}
                          placeholder="Any"
                          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ── Group + sort ── */}
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">4 · Group &amp; sort (optional)</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Group by</label>
                  <select
                    value={form.groupBy}
                    onChange={(e) => set('groupBy', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">No grouping (row detail)</option>
                    {dataset.groupable.map((g) => {
                      const c = colByKey.get(g);
                      return <option key={g} value={g}>{c ? c.label : g}</option>;
                    })}
                  </select>
                  {form.groupBy && (
                    <p className="mt-1 text-[11px] text-gray-400">Grouped output: the group value, a count, and sums of the numeric columns.</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Sort by</label>
                  <select
                    value={form.sortKey}
                    onChange={(e) => set('sortKey', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Dataset default</option>
                    {sortOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Direction</label>
                  <select
                    value={form.sortDir}
                    onChange={(e) => set('sortDir', e.target.value)}
                    disabled={!form.sortKey}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-50"
                  >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                </div>
              </div>
            </section>
          </>
        )}
      </div>

      {/* ── Actions ── */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => runPreview(1)}
          disabled={!form.datasetKey || !form.columns.length || previewLoading}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--theme-primary)' }}
        >
          {previewLoading ? 'Running…' : 'Preview'}
        </button>
        <button
          type="button"
          onClick={() => { setSaveOpen(true); setError(''); }}
          disabled={!form.datasetKey || !form.columns.length}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {form.id ? 'Save changes…' : 'Save report…'}
        </button>
        {(form.id || form.datasetKey) && (
          <button type="button" onClick={startFresh} className="ml-auto text-xs font-medium text-gray-500 underline">
            Reset builder
          </button>
        )}
      </div>

      {/* ── Preview ── */}
      {(preview || previewLoading) && (
        <div className="mt-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Preview</h2>
          <RunResultPanel
            result={preview}
            loading={previewLoading}
            onPageChange={(p) => runPreview(p)}
            onPageSizeChange={(s) => { setPageSize(s); runPreview(1, s); }}
          />
        </div>
      )}

      {/* ── Save modal ── */}
      {saveOpen && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="mt-24 w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900">{form.id ? 'Save changes' : 'Save report'}</h2>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Name</label>
                <input
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="e.g. Active headcount by department"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Description (optional)</label>
                <textarea
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.isShared}
                  onChange={(e) => set('isShared', e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  Share with all report viewers
                  <span className="block text-xs text-gray-400">Off = only you can see it. Either way, only you can edit or delete it.</span>
                </span>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSaveOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || !form.name.trim()}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--theme-primary)' }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Saved reports
// ═════════════════════════════════════════════════════════════════════════════
function SavedTab({ registry, onEdit, onSchedule, canSchedule, refreshToken }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [run, setRun] = useState(null); // { def, result, loading }

  const datasetLabel = useCallback(
    (key) => ((registry || []).find((d) => d.key === key) || {}).label || key,
    [registry]
  );

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/reports/definitions')
      .then((r) => setItems(r?.items || []))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load saved reports.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, refreshToken]);

  const runDef = useCallback(async (def, page = 1, pageSize = 50) => {
    setRun((r) => ({ def, result: r && r.def?.id === def.id ? r.result : null, loading: true }));
    try {
      const result = await post(`/api/hr/reports/definitions/${def.id}/run`, { page, pageSize });
      setRun({ def, result, loading: false });
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to run the report.');
      setRun(null);
    }
  }, []);

  async function remove(def) {
    if (!window.confirm(`Delete “${def.name}”? Its schedules stop firing too.`)) return;
    setBusyId(def.id);
    setError('');
    try {
      await del(`/api/hr/reports/definitions/${def.id}`);
      if (run?.def?.id === def.id) setRun(null);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete the report.');
    } finally {
      setBusyId('');
    }
  }

  const columns = [
    {
      key: 'name',
      header: 'Report',
      render: (r) => (
        <div className="min-w-0">
          <div className="font-medium text-gray-900">{r.name}</div>
          {r.description && <div className="max-w-xs truncate text-xs text-gray-400" title={r.description}>{r.description}</div>}
        </div>
      ),
    },
    { key: 'dataset', header: 'Dataset', render: (r) => <Chip tone="indigo">{datasetLabel(r.datasetKey)}</Chip> },
    {
      key: 'sharing',
      header: 'Sharing',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {r.isShared ? <Chip tone="emerald">Shared</Chip> : <Chip>Private</Chip>}
          {r.isMine && <Chip tone="amber" title="You created this report — only you can edit or delete it.">Mine</Chip>}
        </span>
      ),
    },
    { key: 'updatedAt', header: 'Updated', render: (r) => formatAdminDate(r.updatedAt) },
    {
      key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
      render: (r) => (
        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
          <ActionButton onClick={() => runDef(r)} disabled={busyId === r.id}>Run</ActionButton>
          <ExportMenu
            buildPath={(fmt) => `/api/hr/reports/definitions/${r.id}/export${qs({ format: fmt })}`}
            onError={setError}
          />
          {r.isMine && <ActionButton onClick={() => onEdit(r)} disabled={busyId === r.id}>Edit</ActionButton>}
          {canSchedule && <ActionButton onClick={() => onSchedule(r)} disabled={busyId === r.id}>Schedule…</ActionButton>}
          {r.isMine && <ActionButton tone="danger" onClick={() => remove(r)} disabled={busyId === r.id}>Delete</ActionButton>}
        </div>
      ),
    },
  ];

  return (
    <div>
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
      <DataTable
        columns={columns}
        rows={items || []}
        loading={loading}
        emptyText="No saved reports yet — build one in the Report builder tab."
        rowKey={(r) => r.id}
      />
      {run && (
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Results — {run.def.name}</h2>
            <button type="button" onClick={() => setRun(null)} className="text-xs font-medium text-gray-500 underline">Close</button>
          </div>
          <RunResultPanel
            result={run.result}
            loading={run.loading}
            onPageChange={(p) => runDef(run.def, p, run.result?.pageSize || 50)}
            onPageSizeChange={(s) => runDef(run.def, 1, s)}
          />
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Schedules (canScheduleReports)
// ═════════════════════════════════════════════════════════════════════════════
function cadenceSentence(s) {
  const hh = `${String(s.hourUtc ?? 0).padStart(2, '0')}:00 UTC`;
  if (s.cronPreset === 'DAILY') return `Daily at ${hh}`;
  if (s.cronPreset === 'WEEKLY') {
    const a = s.anchor == null ? 1 : Number(s.anchor);
    return `Weekly on ${WEEKDAYS[((a % 7) + 7) % 7]} at ${hh}`;
  }
  const a = s.anchor == null ? 1 : Number(s.anchor);
  return `Monthly on day ${a} at ${hh}`;
}

function emptyScheduleForm(defId) {
  return {
    id: null,
    reportDefinitionId: defId || '',
    cronPreset: 'WEEKLY',
    anchor: 1,
    hourUtc: 9,
    format: 'CSV',
    recipientsText: '',
    isActive: true,
  };
}

function scheduleFormFrom(s) {
  return {
    id: s.id,
    reportDefinitionId: s.reportDefinitionId || '',
    cronPreset: s.cronPreset || 'WEEKLY',
    anchor: s.anchor == null ? 1 : s.anchor,
    hourUtc: s.hourUtc ?? 9,
    format: s.format || 'CSV',
    recipientsText: (s.recipients || []).join(', '),
    isActive: s.isActive !== false,
  };
}

function SchedulesTab({ presetDefId, onPresetConsumed }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [defs, setDefs] = useState([]);
  const [modal, setModal] = useState(null); // schedule form | null
  const [modalError, setModalError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/reports/schedules')
      .then((r) => setItems(r?.items || []))
      .catch((e) => {
        // Fail-soft on 403: the operator lacks canScheduleReports server-side.
        if (e.status === 403) setForbidden(true);
        else setError(e.data?.message || e.message || 'Failed to load schedules.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Definitions for the picker (shared + own — same list the server schedules from).
  useEffect(() => {
    get('/api/hr/reports/definitions').then((r) => setDefs(r?.items || [])).catch(() => {});
  }, []);

  // "Schedule…" shortcut from the Saved tab: open the create modal preselected.
  useEffect(() => {
    if (presetDefId) {
      setModal(emptyScheduleForm(presetDefId));
      setModalError('');
      if (onPresetConsumed) onPresetConsumed();
    }
  }, [presetDefId, onPresetConsumed]);

  const setF = (k, v) => setModal((m) => ({ ...m, [k]: v }));

  async function save() {
    const m = modal;
    if (!m.reportDefinitionId) { setModalError('Pick a saved report to deliver.'); return; }
    const emails = m.recipientsText.split(',').map((s) => s.trim()).filter(Boolean);
    if (!emails.length) { setModalError('Add at least one recipient email (comma-separated).'); return; }
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) { setModalError(`Invalid email(s): ${bad.join(', ')}`); return; }
    const hour = Number(m.hourUtc);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) { setModalError('Hour (UTC) must be 0-23.'); return; }
    const body = {
      reportDefinitionId: m.reportDefinitionId,
      cronPreset: m.cronPreset,
      anchor: m.cronPreset === 'DAILY' ? null : Number(m.anchor),
      hourUtc: hour,
      format: m.format,
      recipients: emails,
      isActive: !!m.isActive,
    };
    setSaving(true);
    setModalError('');
    try {
      if (m.id) await patch(`/api/hr/reports/schedules/${m.id}`, body);
      else await post('/api/hr/reports/schedules', body);
      setModal(null);
      load();
    } catch (e) {
      setModalError(e.data?.message || e.message || 'Failed to save the schedule.');
    } finally {
      setSaving(false);
    }
  }

  async function runNow(s) {
    setBusyId(s.id);
    setError('');
    setNotice('');
    try {
      const res = await post(`/api/hr/reports/schedules/${s.id}/run-now`);
      setNotice(res.ok ? `Delivered — ${res.status} (${res.sent} email${res.sent === 1 ? '' : 's'}).` : `Run finished: ${res.status}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to run the schedule.');
    } finally {
      setBusyId('');
    }
  }

  async function toggleActive(s) {
    setBusyId(s.id);
    setError('');
    try {
      await patch(`/api/hr/reports/schedules/${s.id}`, { isActive: !s.isActive });
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to update the schedule.');
    } finally {
      setBusyId('');
    }
  }

  async function remove(s) {
    if (!window.confirm(`Delete this schedule for “${s.reportName || 'report'}”?`)) return;
    setBusyId(s.id);
    setError('');
    try {
      await del(`/api/hr/reports/schedules/${s.id}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete the schedule.');
    } finally {
      setBusyId('');
    }
  }

  if (forbidden) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
        Scheduling needs the “canScheduleReports” permission — ask an Owner/HR-Admin to grant it under Roles &amp; access.
      </div>
    );
  }

  const columns = [
    {
      key: 'report', header: 'Report',
      render: (r) => <span className="font-medium text-gray-900">{r.reportName || r.reportDefinitionId}</span>,
    },
    { key: 'cadence', header: 'Cadence', render: (r) => <span className="text-gray-700">{cadenceSentence(r)}</span> },
    { key: 'format', header: 'Format', render: (r) => <Chip tone="indigo">{r.format}</Chip> },
    {
      key: 'recipients', header: 'Recipients',
      render: (r) => (
        <span className="block max-w-[220px] truncate text-gray-600" title={(r.recipients || []).join(', ')}>
          {(r.recipients || []).join(', ') || '—'}
        </span>
      ),
    },
    { key: 'active', header: 'Active', render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'PAUSED'} /> },
    {
      key: 'last', header: 'Last run',
      render: (r) => r.lastRunAt ? (
        <span className="text-gray-600" title={r.lastStatus || ''}>
          {formatAdminDate(r.lastRunAt)}
          {r.lastStatus && (
            <span className={`ml-1.5 text-xs ${String(r.lastStatus).startsWith('SENT') ? 'text-emerald-600' : 'text-red-600'}`}>
              {String(r.lastStatus).slice(0, 24)}{String(r.lastStatus).length > 24 ? '…' : ''}
            </span>
          )}
        </span>
      ) : <span className="text-gray-400">Never</span>,
    },
    {
      key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
      render: (r) => (
        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
          <ActionButton onClick={() => runNow(r)} disabled={busyId === r.id}>Run now</ActionButton>
          <ActionButton onClick={() => { setModal(scheduleFormFrom(r)); setModalError(''); }} disabled={busyId === r.id}>Edit</ActionButton>
          <ActionButton onClick={() => toggleActive(r)} disabled={busyId === r.id}>{r.isActive ? 'Pause' : 'Resume'}</ActionButton>
          <ActionButton tone="danger" onClick={() => remove(r)} disabled={busyId === r.id}>Delete</ActionButton>
        </div>
      ),
    },
  ];

  const weekly = modal?.cronPreset === 'WEEKLY';
  const monthly = modal?.cronPreset === 'MONTHLY';

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">Email a saved report on a cadence. Deliveries run under the schedule creator's data scope.</p>
        <button
          type="button"
          onClick={() => { setModal(emptyScheduleForm()); setModalError(''); }}
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-white"
          style={{ background: 'var(--theme-primary)' }}
        >
          + New schedule
        </button>
      </div>
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>
      )}
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
      <DataTable
        columns={columns}
        rows={items || []}
        loading={loading}
        emptyText="No schedules yet — save a report, then schedule its email delivery."
        rowKey={(r) => r.id}
      />

      {modal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="mt-16 w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900">{modal.id ? 'Edit schedule' : 'New schedule'}</h2>
            {modalError && <div className="mt-3"><ErrorBanner message={modalError} /></div>}
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Saved report</label>
                <select
                  value={modal.reportDefinitionId}
                  onChange={(e) => setF('reportDefinitionId', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Pick a saved report…</option>
                  {defs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Cadence</label>
                  <select
                    value={modal.cronPreset}
                    onChange={(e) => {
                      const preset = e.target.value;
                      setModal((m) => ({ ...m, cronPreset: preset, anchor: 1 }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                  </select>
                </div>
                {weekly && (
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Day of week</label>
                    <select
                      value={String(modal.anchor ?? 1)}
                      onChange={(e) => setF('anchor', Number(e.target.value))}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                    >
                      {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  </div>
                )}
                {monthly && (
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Day of month</label>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={modal.anchor ?? 1}
                      onChange={(e) => setF('anchor', e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Hour (UTC)</label>
                  <select
                    value={String(modal.hourUtc)}
                    onChange={(e) => setF('hourUtc', Number(e.target.value))}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Format</label>
                  <select
                    value={modal.format}
                    onChange={(e) => setF('format', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <label className="mt-6 inline-flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={modal.isActive} onChange={(e) => setF('isActive', e.target.checked)} className="h-4 w-4" />
                  Active
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Recipients (comma-separated emails)</label>
                <input
                  value={modal.recipientsText}
                  onChange={(e) => setF('recipientsText', e.target.value)}
                  placeholder="cfo@acme.com, hr@acme.com"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <p className="text-xs font-medium" style={{ color: 'var(--theme-primary)' }}>
                {cadenceSentence({ cronPreset: modal.cronPreset, anchor: modal.anchor, hourUtc: modal.hourUtc })}
                {' · '}{modal.format} attachment
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModal(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--theme-primary)' }}
              >
                {saving ? 'Saving…' : 'Save schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Page shell
// ═════════════════════════════════════════════════════════════════════════════
const LEGACY_TAB_VIEWS = { register: 'register', statutory: 'statutory', headcount: 'headcount' };

function ReportsInner() {
  const router = useRouter();
  const params = useSearchParams();

  const rawTab = params.get('tab') || 'fixed';
  const legacyView = LEGACY_TAB_VIEWS[rawTab];
  const tab = MAIN_TABS.some((t) => t.key === rawTab) ? rawTab : 'fixed';
  const view = params.get('view') || legacyView || 'register';
  const runId = params.get('run') || '';

  // Effective permissions (learning-page idiom). Unresolved (undefined/null) →
  // allow-all posture so the console stays usable before the session resolves;
  // the server is the real boundary (403s are handled fail-soft in each tab).
  const [perms, setPerms] = useState(undefined);
  useEffect(() => {
    get('/api/auth/me')
      .then((me) => setPerms(permissionsFromSession(me?.user || me)))
      .catch(() => setPerms(null));
  }, []);
  const canFixed = hasAnyPermission(perms, ['canViewPayrollReports', 'canViewReports']);
  const canBuild = hasPermission(perms, 'canViewReports');
  const canSchedule = hasPermission(perms, 'canScheduleReports');

  // Cross-tab handoffs (kept in React state, not the URL).
  const [editingDef, setEditingDef] = useState(null); // Saved → Builder prefill
  const [scheduleDefId, setScheduleDefId] = useState(''); // Saved → Schedules preselect
  const [savedRefresh, setSavedRefresh] = useState(0); // bump after a builder save

  // Dataset registry — shared by builder (form) + saved (labels). Fail-soft.
  const [registry, setRegistry] = useState(null);
  const [registryError, setRegistryError] = useState('');
  useEffect(() => {
    if (!canBuild) return;
    get('/api/hr/reports/datasets')
      .then((r) => setRegistry(r?.items || []))
      .catch((e) => {
        if (e.status === 403) setRegistry([]);
        else setRegistryError(e.data?.message || e.message || 'Failed to load the dataset registry.');
      });
  }, [canBuild]);

  const visibleTabs = MAIN_TABS.filter((t) => {
    if (t.key === 'fixed') return canFixed;
    if (t.key === 'schedules') return canSchedule;
    return canBuild; // builder + saved
  });

  const setTab = useCallback(
    (key) => {
      const sp = new URLSearchParams(params.toString());
      sp.set('tab', key);
      router.push(`/reports?${sp.toString()}`);
    },
    [router, params]
  );

  const setView = useCallback(
    (key) => {
      const sp = new URLSearchParams(params.toString());
      sp.set('tab', 'fixed');
      sp.set('view', key);
      router.replace(`/reports?${sp.toString()}`);
    },
    [router, params]
  );

  const setRun = useCallback(
    (id) => {
      const sp = new URLSearchParams(params.toString());
      if (id) sp.set('run', id); else sp.delete('run');
      router.replace(`/reports?${sp.toString()}`);
    },
    [router, params]
  );

  const effectiveTab = visibleTabs.some((t) => t.key === tab) ? tab : (visibleTabs[0]?.key || 'fixed');

  return (
    <div>
      <PageHeader title="Reports" subtitle="Fixed payroll & people reports, a custom report builder, saved reports, and scheduled email delivery" />
      <ModuleGuide
        id="reports"
        title="Run fixed reports, build your own, save and schedule them"
        what="One console for all reporting. Fixed reports cover the payroll register, statutory totals, headcount and leave liability — each exportable to CSV/XLSX/PDF. The Report builder queries any whitelisted dataset (employees, attendance, leave, payroll lines, expenses, loans, assets, helpdesk, recognition) with your own columns, filters and grouping; save a definition to re-run, share, export or email it on a schedule."
        steps={[
          'Fixed reports: pick a sub-view (register / statutory / headcount / leave liability), choose the pay run or date range, and use Export for CSV, XLSX or PDF.',
          'Report builder: pick a dataset, keep the columns you want (reorder with the arrows), set filters, optionally group by a key and sort, then hit Preview.',
          'Happy with the preview? Save report — give it a name and decide whether to share it with all report viewers.',
          'Saved reports: Run any shared or own report inline, export it, edit or delete your own, or jump to Schedule…',
          'Schedules: deliver a saved report by email daily, weekly or monthly at a UTC hour — Run now tests it immediately.',
        ]}
        example={<>HR at <b>Acme India Pvt Ltd</b> builds an <b>Attendance (daily)</b> report filtered to <b>ABSENT</b>, grouped by <b>employee</b>, saves it as <b>“Monthly absentee summary”</b> (shared), and schedules it <b>Monthly on day 1 at 09:00 UTC</b> as an <b>XLSX</b> to <b>hr@acme.com</b>.</>}
        tips={[
          'Everything is scoped to what you are allowed to see — a team manager\'s report only ever covers their reporting sub-tree.',
          'Builder runs cap at the first 10,000 source rows (a warning shows) — narrow the filters for a complete total.',
          'Only the creator can edit or delete a saved report; sharing makes it visible (read/run/export) to every report viewer.',
        ]}
      />
      <Tabs tabs={visibleTabs} active={effectiveTab} onChange={setTab} />
      {effectiveTab === 'fixed' && <FixedTab view={view} onView={setView} runId={runId} onRun={setRun} />}
      {effectiveTab === 'builder' && (
        <BuilderTab
          registry={registry}
          registryError={registryError}
          editing={editingDef}
          onSaved={() => setSavedRefresh((n) => n + 1)}
          onReset={() => setEditingDef(null)}
        />
      )}
      {effectiveTab === 'saved' && (
        <SavedTab
          registry={registry}
          refreshToken={savedRefresh}
          canSchedule={canSchedule}
          onEdit={(def) => { setEditingDef(def); setTab('builder'); }}
          onSchedule={(def) => { setScheduleDefId(def.id); setTab('schedules'); }}
        />
      )}
      {effectiveTab === 'schedules' && (
        <SchedulesTab
          presetDefId={scheduleDefId}
          onPresetConsumed={() => setScheduleDefId('')}
        />
      )}
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ReportsInner />
    </Suspense>
  );
}

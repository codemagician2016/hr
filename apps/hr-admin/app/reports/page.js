'use client';

// Reports console — read-only analytics over the HR REPORTS API:
//   GET /api/hr/reports/runs                 pay-run selector
//   GET /api/hr/reports/runs/:id/register    payroll register (+ column totals)
//   GET /api/hr/reports/runs/:id/statutory   statutory summary (India)
//   GET /api/hr/reports/headcount?from&to&groupBy   headcount & attrition
//
// Tabs live in the URL (?tab=register|statutory|headcount) so views are
// linkable; the selected run rides ?run=:id (shared by register + statutory).
// All gated server-side by canViewPayrollReports.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Spinner, ErrorBanner, formatAdminDate } from '@hr/ui';
import { get } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, Tabs, moneyish } from '@/lib/ui';
import ModuleGuide from '@/components/ModuleGuide';

const TABS = [
  { key: 'register', label: 'Payroll register' },
  { key: 'statutory', label: 'Statutory summary' },
  { key: 'headcount', label: 'Headcount' },
];

// ── Run picker (shared by register + statutory) ───────────────────────────────
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

function TotalCard({ label, value }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
    </div>
  );
}

// ── 1. Payroll register tab ───────────────────────────────────────────────────
function RegisterTab({ runId, onRun }) {
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
      <RunPicker value={runId} onChange={onRun} />
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

// ── 2. Statutory summary tab ──────────────────────────────────────────────────
function StatutoryTab({ runId, onRun }) {
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
      <RunPicker value={runId} onChange={onRun} />
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

// ── 3. Headcount tab ──────────────────────────────────────────────────────────
function HeadcountTab() {
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

function ReportsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get('tab') || 'register';
  const runId = params.get('run') || '';

  const setTab = useCallback(
    (key) => {
      const sp = new URLSearchParams(params.toString());
      sp.set('tab', key);
      router.push(`/reports?${sp.toString()}`);
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

  return (
    <div>
      <PageHeader title="Reports" subtitle="Payroll register, statutory summary, and headcount analytics" />
      <ModuleGuide
        id="reports"
        title="Pull payroll & headcount reports"
        what="A read-only analytics console over your locked pay runs. Use it to reconcile a payroll register, get India statutory totals (EPF/ESI/PT/TDS) for a filing, and track headcount and attrition — without touching live data."
        steps={[
          "Pick the tab you need: Payroll register, Statutory summary, or Headcount.",
          "On Register or Statutory, choose the pay run from the Pay run dropdown (e.g. JUN-2026 · Acme India Pvt Ltd · 01 Jun–30 Jun).",
          "Read the Register to see each employee's gross, deductions, net and employer cost, with column totals up top that reconcile to the pay-run header.",
          "Switch to Statutory summary for the EPF/ESI/PT/TDS contribution breakup for that run before you file your challans.",
          "On Headcount, set From/To dates and Group by Department or Entity to see joiners, exits and the attrition rate.",
        ]}
        example={<>For the <b>JUN-2026</b> run of <b>Acme India Pvt Ltd</b>, the Register shows <b>Aarav Sharma</b> at <b>₹1,00,000</b> gross / <b>₹12,360</b> deductions / <b>₹87,640</b> net, and the Statutory tab totals <b>₹21,600</b> employer EPF and <b>₹2,250</b> ESI across <b>48 employees</b>.</>}
        tips={[
          "The selected pay run and tab live in the URL, so you can bookmark or share a specific view (e.g. ?tab=statutory&run=…).",
          "Reports cover finalised pay runs only — if a run is missing here, lock it on the Payroll screen first.",
        ]}
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'register' && <RegisterTab runId={runId} onRun={setRun} />}
      {tab === 'statutory' && <StatutoryTab runId={runId} onRun={setRun} />}
      {tab === 'headcount' && <HeadcountTab />}
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

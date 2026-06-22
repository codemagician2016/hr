'use client';

// Payroll console — implements the PAYROLL API CONTRACT:
//   GET    /api/hr/payroll/runs                 list (paginated)
//   POST   /api/hr/payroll/runs                 create DRAFT {entityId, payCalendarId, periodStart, periodEnd}
//   GET    /api/hr/payroll/runs/:id             detail + lines + totals + anomalies
//   POST   /api/hr/payroll/runs/:id/compute     -> CALCULATED (canRunPayroll)
//   POST   /api/hr/payroll/runs/:id/approve     -> APPROVED (canApprovePayroll)
//   GET    /api/hr/payroll/runs/:id/payslips    payslips for the run
//   GET    /api/hr/payroll/runs/:id/files/:kind statutory/bank file (ecr|esic|form24q|ei|bank)
//
// The selected run id lives in the URL (?run=:id) so list⇄detail is linkable
// and back/forward works (people/page.js pattern). useSearchParams ⇒ Suspense.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Spinner, ErrorBanner, PrimaryButton, TextInput, DateField, Modal, ModalActions, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, employeeLabel, moneyish } from '@/lib/ui';

const PAGE_SIZE = 20;
const FILE_KINDS = [
  { kind: 'ecr', label: 'EPF ECR' },
  { kind: 'esic', label: 'ESIC' },
  { kind: 'form24q', label: 'Form 24Q' },
  { kind: 'ei', label: 'EI' },
  { kind: 'bank', label: 'Bank file' },
];

// ── New-run modal ────────────────────────────────────────────────────────────
function NewRunModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ entityId: '', payCalendarId: '', periodStart: '', periodEnd: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const run = await post('/api/hr/payroll/runs', form);
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
        <TextInput label="Entity ID" value={form.entityId} onChange={(v) => setForm((f) => ({ ...f, entityId: v }))} required />
        <TextInput label="Pay calendar ID" value={form.payCalendarId} onChange={(v) => setForm((f) => ({ ...f, payCalendarId: v }))} required />
        <div className="grid grid-cols-2 gap-3">
          <DateField label="Period start" value={form.periodStart} onChange={(v) => setForm((f) => ({ ...f, periodStart: v }))} required />
          <DateField label="Period end" value={form.periodEnd} onChange={(v) => setForm((f) => ({ ...f, periodEnd: v }))} required />
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
            Cancel
          </button>
          <PrimaryButton type="submit" loading={saving}>
            Create draft
          </PrimaryButton>
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

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/payroll/runs', { page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load pay runs.'))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const items = data?.items || [];
  const total = data?.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = [
    {
      key: 'period',
      header: 'Period',
      render: (r) => (
        <button type="button" onClick={() => onOpen(r.id)} className="font-medium text-gray-900 hover:underline text-left">
          {formatAdminDate(r.periodStart)} – {formatAdminDate(r.periodEnd)}
        </button>
      ),
    },
    { key: 'entity', header: 'Entity', render: (r) => r.entity?.name || r.entityName || r.entityId || '—' },
    { key: 'employees', header: 'Employees', render: (r) => r.employeeCount ?? r.headcount ?? (Array.isArray(r.lines) ? r.lines.length : '—') },
    { key: 'net', header: 'Net pay', render: (r) => moneyish(r.totals?.netPay ?? r.netPay, r.currencyCode) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'open', header: '', render: (r) => <ActionButton onClick={() => onOpen(r.id)}>Open</ActionButton> },
  ];

  return (
    <div>
      <PageHeader
        title="Payroll"
        subtitle="Pay runs"
        actions={<PrimaryButton onClick={() => setShowNew(true)}>New pay run</PrimaryButton>}
      />

      {error && <ErrorBanner message={error} />}

      <DataTable columns={columns} rows={items} loading={loading} emptyText="No pay runs yet." />

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50">
            Previous
          </button>
          <span className="text-gray-500">Page {page} of {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50">
            Next
          </button>
        </div>
      )}

      {showNew && (
        <NewRunModal
          onClose={() => setShowNew(false)}
          onCreated={(run) => {
            setShowNew(false);
            if (run?.id) onOpen(run.id);
            else load();
          }}
        />
      )}
    </div>
  );
}

// ── Run detail ───────────────────────────────────────────────────────────────
function RunDetail({ runId, onBack }) {
  const [run, setRun] = useState(null);
  const [payslips, setPayslips] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      get(`/api/hr/payroll/runs/${runId}`),
      get(`/api/hr/payroll/runs/${runId}/payslips`).catch(() => null),
    ])
      .then(([detail, slips]) => {
        // API returns { payRun, lines, totals, anomalies }. Flatten payRun to the top
        // so run.currencyCode/status/period* resolve; keep totals/lines/anomalies.
        setRun(detail ? { ...(detail.payRun || {}), totals: detail.totals, lines: detail.lines, anomalies: detail.anomalies } : null);
        setPayslips(slips);
      })
      .catch((e) => setError(e.message || 'Failed to load pay run.'))
      .finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(action) {
    setBusy(action);
    setError('');
    try {
      await post(`/api/hr/payroll/runs/${runId}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action}.`);
    } finally {
      setBusy('');
    }
  }

  const status = String(run?.status || '').toUpperCase();
  const lines = run?.lines || run?.payLines || [];
  const totals = run?.totals || {};
  const anomalies = run?.anomalies || [];
  const slipRows = useMemo(() => (Array.isArray(payslips) ? payslips : payslips?.items || []), [payslips]);

  const lineColumns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
    { key: 'gross', header: 'Gross', render: (r) => moneyish(r.gross ?? r.grossPay, r.currencyCode || run?.currencyCode) },
    { key: 'deductions', header: 'Deductions', render: (r) => moneyish(r.deductions ?? r.totalDeductions, r.currencyCode || run?.currencyCode) },
    { key: 'net', header: 'Net', render: (r) => moneyish(r.net ?? r.netPay, r.currencyCode || run?.currencyCode) },
  ];

  const slipColumns = [
    { key: 'employee', header: 'Employee', render: (r) => employeeLabel(r) },
    { key: 'net', header: 'Net pay', render: (r) => moneyish(r.netPay ?? r.net, r.currencyCode || run?.currencyCode) },
    {
      key: 'view',
      header: '',
      render: (r) => (
        <a
          href={`/api/hr/payroll/payslips/${r.id}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium hover:underline"
          style={{ color: 'var(--theme-primary)' }}
        >
          View payslip
        </a>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="py-12 flex justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <button type="button" onClick={onBack} className="text-sm text-gray-500 hover:text-gray-800 mb-3">
        ← Back to pay runs
      </button>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">
              {run ? `${formatAdminDate(run.periodStart)} – ${formatAdminDate(run.periodEnd)}` : 'Pay run'}
            </h1>
            <StatusBadge status={run?.status} />
          </div>
          <p className="text-sm text-gray-500 mt-0.5">{run?.entity?.name || run?.entityName || run?.entityId || ''}</p>
        </div>
        <div className="flex items-center gap-2">
          {(status === 'DRAFT' || status === 'CALCULATED') && (
            <PrimaryButton loading={busy === 'compute'} onClick={() => runAction('compute')}>
              {status === 'CALCULATED' ? 'Recompute' : 'Compute'}
            </PrimaryButton>
          )}
          {status === 'CALCULATED' && (
            <ActionButton tone="positive" disabled={busy === 'approve'} onClick={() => runAction('approve')}>
              Approve
            </ActionButton>
          )}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="grid sm:grid-cols-3 gap-4 mb-6">
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="text-2xl font-semibold text-gray-900">{moneyish(totals.totalGross ?? totals.gross ?? totals.grossPay, run?.currencyCode)}</div>
          <div className="text-sm text-gray-500 mt-1">Gross</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="text-2xl font-semibold text-gray-900">{moneyish(totals.totalDeductions ?? totals.deductions, run?.currencyCode)}</div>
          <div className="text-sm text-gray-500 mt-1">Deductions</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="text-2xl font-semibold text-gray-900">{moneyish(totals.totalNet ?? totals.netPay ?? totals.net, run?.currencyCode)}</div>
          <div className="text-sm text-gray-500 mt-1">Net pay</div>
        </div>
      </div>

      {anomalies.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 mb-6">
          <h2 className="text-sm font-semibold text-amber-800 mb-2">Anomalies ({anomalies.length})</h2>
          <ul className="text-sm text-amber-800 list-disc pl-5 space-y-1">
            {anomalies.map((a, i) => (
              <li key={i}>{typeof a === 'string' ? a : a.message || a.code || JSON.stringify(a)}</li>
            ))}
          </ul>
        </div>
      )}

      <h2 className="text-sm font-semibold text-gray-900 mb-3">Pay lines</h2>
      <div className="mb-6">
        <DataTable columns={lineColumns} rows={lines} loading={false} emptyText="No lines — compute the run to populate." />
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Payslips</h2>
        {FILE_KINDS.length > 0 && status !== 'DRAFT' && (
          <div className="flex flex-wrap gap-2">
            {FILE_KINDS.map((f) => (
              <a
                key={f.kind}
                href={`/api/hr/payroll/runs/${runId}/files/${f.kind}`}
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1 text-xs font-medium border border-gray-300 rounded-md hover:bg-gray-50"
              >
                {f.label}
              </a>
            ))}
          </div>
        )}
      </div>
      <DataTable columns={slipColumns} rows={slipRows} loading={false} emptyText="No payslips — compute the run first." />
    </div>
  );
}

function PayrollInner() {
  const router = useRouter();
  const params = useSearchParams();
  const runId = params.get('run') || '';

  const open = useCallback((id) => router.push(`/payroll?run=${encodeURIComponent(id)}`), [router]);
  const back = useCallback(() => router.push('/payroll'), [router]);

  return runId ? <RunDetail runId={runId} onBack={back} /> : <RunsList onOpen={open} />;
}

export default function PayrollPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PayrollInner />
    </Suspense>
  );
}

'use client';

// Salary Disbursement (India) — convert a FROZEN/APPROVED pay run into a
// bank-uploadable salary-advice file (+ optional payout-gateway path) with UTR
// reconciliation. Mirrors the registers/arrears sub-pages; does NOT touch the
// shared payroll run console.
//   GET  /api/hr/payroll/runs?status=...                         pick a disbursable run
//   GET  /api/hr/payroll/runs/:id/disbursement                  list a run's batches + bank list
//   POST /api/hr/payroll/runs/:id/disbursement                  create a batch on a bank rail
//   GET  /api/hr/payroll/disbursement/:batchId                  batch + per-employee lines (paged)
//   GET  /api/hr/payroll/disbursement/:batchId/file             download the advice file
//   POST /api/hr/payroll/disbursement/:batchId/reconcile        apply a UTR/status CSV
// create/file/reconcile gated server-side on canRunPayroll; reads on
// canViewPayrollReports. India-only (the server 422s a non-IN run).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton } from '@hr/ui';
import { get, post, downloadFile } from '@/lib/api';
import { PageHeader, StatusBadge } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';

const LINE_PAGE_SIZE = 50;

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(d).slice(0, 16); }
}

export default function DisbursementPage() {
  const [runs, setRuns] = useState([]);
  const [runId, setRunId] = useState('');
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [error, setError] = useState('');
  const [openBatchId, setOpenBatchId] = useState('');

  // Load disbursable runs (frozen/approved/paid/filed). The run console drives
  // the lifecycle; here we just pick a committed run to pay.
  useEffect(() => {
    setLoadingRuns(true);
    get('/api/hr/payroll/runs', { pageSize: 100 })
      .then((r) => {
        const list = (r.items || r.runs || (Array.isArray(r) ? r : [])).filter(
          (x) => ['LOCKED', 'APPROVED', 'PAID', 'FILED'].includes(x.status),
        );
        setRuns(list);
        if (list[0]) setRunId(list[0].id);
      })
      .catch((e) => setError(e.data?.message || e.message || 'Could not load pay runs — you may be missing a payroll permission.'))
      .finally(() => setLoadingRuns(false));
  }, []);

  return (
    <div>
      <PageHeader
        title="Salary Disbursement"
        subtitle="Turn a frozen / approved pay run into a bank salary-advice file (HDFC, ICICI, Axis, Kotak, SBI or generic NEFT/RTGS), then reconcile the bank UTRs back onto each employee."
      />

      {error && <div className="mt-4"><ErrorBanner message={error} /></div>}

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-2xl border border-gray-200 bg-white p-4">
        <label className="flex flex-col text-xs font-medium text-gray-600">
          <span className="flex items-center gap-1">Pay run
            <InfoTip text="Only FROZEN, APPROVED, PAID or FILED runs are disbursable — a run's totals must be committed by the checker before a payout batch can be built. Run the payroll on the Payroll console first." />
          </span>
          <select value={runId} onChange={(e) => { setRunId(e.target.value); setOpenBatchId(''); }}
            className="mt-1 min-w-[22rem] rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {loadingRuns && <option value="">Loading…</option>}
            {!loadingRuns && runs.length === 0 && <option value="">No disbursable runs — freeze/approve a run first</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>{r.code} · {r.status}</option>
            ))}
          </select>
        </label>
      </div>

      {runId && (
        <RunDisbursement
          key={runId}
          runId={runId}
          openBatchId={openBatchId}
          onOpenBatch={setOpenBatchId}
        />
      )}
    </div>
  );
}

// ── A run's batches: create bar + list + drill-in ─────────────────────────────

function RunDisbursement({ runId, openBatchId, onOpenBatch }) {
  const [data, setData] = useState(null); // { batches, banks, gateway, pagination }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Create-batch form.
  const [bank, setBank] = useState('');
  const [debitAccount, setDebitAccount] = useState('');
  const [valueDate, setValueDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [skipped, setSkipped] = useState([]); // flagged employees from the last create

  const load = useCallback(() => {
    setLoading(true); setError('');
    get(`/api/hr/payroll/runs/${runId}/disbursement`)
      .then((r) => { setData(r); if (!bank && r.banks && r.banks[0]) setBank(r.banks[0].value); })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load batches.'))
      .finally(() => setLoading(false));
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  async function createBatch() {
    if (!bank) return;
    setCreating(true); setError(''); setSkipped([]);
    try {
      const batch = await post(`/api/hr/payroll/runs/${runId}/disbursement`, {
        bank,
        debitAccount: debitAccount || undefined,
        valueDate: valueDate || undefined,
      });
      setSkipped(batch.skipped || []);
      onOpenBatch(batch.id);
      load();
    } catch (e) {
      // Surface the structured 422 offender list (no payable employees) if present.
      if (e.data?.offenders) setSkipped(e.data.offenders);
      setError(e.data?.message || e.message || 'Failed to create batch.');
    } finally {
      setCreating(false);
    }
  }

  const banks = (data && data.banks) || [];
  const gateway = (data && data.gateway) || { configured: false };

  return (
    <div className="mt-4 space-y-4">
      {/* Create batch bar */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs font-medium text-gray-600">
            <span className="flex items-center gap-1">Bank
              <InfoTip text="The salary-upload format to render. Each bank's corporate net-banking expects its own column layout; pick the bank you upload the file to. 'Generic NEFT/RTGS' is a self-describing CSV most import wizards map." />
            </span>
            <select value={bank} onChange={(e) => setBank(e.target.value)}
              className="mt-1 min-w-[16rem] rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {banks.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </label>

          <label className="flex flex-col text-xs font-medium text-gray-600">
            <span className="flex items-center gap-1">Debit account
              <InfoTip text="Your company current account the bank debits for the aggregate salary credit. Optional for some banks (they key it off the channel login). Free-text account number." />
            </span>
            <input value={debitAccount} onChange={(e) => setDebitAccount(e.target.value)} placeholder="00060350001234"
              className="mt-1 w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>

          <label className="flex flex-col text-xs font-medium text-gray-600">
            <span className="flex items-center gap-1">Value date
              <InfoTip text="The requested credit date in the bank file. Defaults to the run's pay date when left blank." />
            </span>
            <input type="date" value={valueDate} onChange={(e) => setValueDate(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>

          <PrimaryButton onClick={createBatch} loading={creating} disabled={!bank}>Create batch</PrimaryButton>

          <div className="ml-auto self-center text-xs text-gray-500">
            {gateway.configured
              ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">Gateway: {gateway.provider}</span>
              : <span className="inline-flex items-center gap-1">Bank-file path
                <InfoTip text="No payout gateway is wired in this environment — generate the advice file, upload it to your corporate net-banking, then reconcile with the bank's UTR file. A RazorpayX/Cashfree adapter can be enabled later without any UI change." />
              </span>}
          </div>
        </div>

        {/* Flagged employees (no/invalid bank detail) from the last create. */}
        {skipped.length > 0 && (
          <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs">
            <div className="font-medium text-amber-800">{skipped.length} employee(s) were skipped — fix their bank details, then create another batch:</div>
            <ul className="mt-1 space-y-0.5 text-amber-700">
              {skipped.map((s, i) => (
                <li key={s.employeeId || i}>• {s.name || s.employeeId}{s.code ? ` (${s.code})` : ''} — {s.detail || s.reason}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Batches list */}
      {loading ? <div className="flex justify-center py-8"><Spinner /></div> : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Bank</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Employees</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2">Value date</th>
                <th className="px-4 py-2">File</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(data?.batches || []).map((b) => (
                <tr key={b.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2">{b.bankLabel || b.bank}</td>
                  <td className="px-4 py-2"><StatusBadge status={b.status} /></td>
                  <td className="px-4 py-2 text-right">{b.count}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{b.currencyCode} {b.totalRupees}</td>
                  <td className="px-4 py-2">{b.valueDate || '—'}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{b.fileGeneratedAt ? fmtDate(b.fileGeneratedAt) : 'not generated'}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{fmtDate(b.createdAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => onOpenBatch(openBatchId === b.id ? '' : b.id)}
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-100">
                      {openBatchId === b.id ? 'Hide' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
              {(data?.batches || []).length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">No batches yet — pick a bank and create one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {openBatchId && <BatchDetail batchId={openBatchId} onReconciled={load} />}
    </div>
  );
}

// ── A single batch: download + per-employee lines (paged) + reconcile ─────────

function BatchDetail({ batchId, onReconciled }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dlBusy, setDlBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true); setError('');
    get(`/api/hr/payroll/disbursement/${batchId}`, { page, pageSize: LINE_PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.data?.message || 'Failed to load batch.'))
      .finally(() => setLoading(false));
  }, [batchId, page]);
  useEffect(() => { load(); }, [load]);

  async function download() {
    setDlBusy(true); setError('');
    try { await downloadFile(`/api/hr/payroll/disbursement/${batchId}/file`); }
    catch (e) {
      setError(e.data?.message || 'Download failed.');
    } finally { setDlBusy(false); }
  }

  const pager = data?.pagination || { page: 1, pages: 1, total: 0 };

  return (
    <div className="rounded-2xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-5 py-3">
        <div className="text-sm font-semibold text-gray-900">
          {data?.bankLabel || data?.bank || 'Batch'} · {data ? `${data.currencyCode} ${data.totalRupees}` : ''}
        </div>
        {data && <StatusBadge status={data.status} />}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={download} disabled={dlBusy}
            className="rounded-md border border-gray-300 px-3 py-2 text-xs font-medium hover:bg-gray-50 disabled:opacity-50">
            {dlBusy ? '…' : 'Download advice file'}
          </button>
          <InfoTip text="Downloads the bank salary-upload file for this batch (and stamps it as generated). Upload this file to your corporate net-banking. The per-employee account numbers are in the file only; they're masked in this table." />
        </div>
      </div>

      {error && <div className="px-5 pt-3"><ErrorBanner message={error} /></div>}

      {loading ? <div className="flex justify-center py-8"><Spinner /></div> : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="border-b border-gray-200 bg-gray-50 text-left uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Beneficiary</th>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2">IFSC</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">UTR</th>
                </tr>
              </thead>
              <tbody>
                {(data?.lines || []).map((l) => (
                  <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-1.5">{l.employeeName || l.employeeCode || l.employeeId}{l.employeeCode ? <span className="text-gray-400"> · {l.employeeCode}</span> : null}</td>
                    <td className="px-3 py-1.5">{l.beneficiaryName}</td>
                    <td className="px-3 py-1.5 font-mono">{l.accountNumberMasked}</td>
                    <td className="px-3 py-1.5 font-mono">{l.ifsc}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.amountRupees}</td>
                    <td className="px-3 py-1.5"><StatusBadge status={l.status} /></td>
                    <td className="px-3 py-1.5 font-mono text-gray-600" title={l.failureReason || ''}>{l.utr || (l.failureReason ? <span className="text-red-600">{l.failureReason}</span> : '—')}</td>
                  </tr>
                ))}
                {(data?.lines || []).length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No lines in this batch.</td></tr>}
              </tbody>
            </table>
          </div>

          {pager.pages > 1 && (
            <div className="flex items-center justify-between border-t border-gray-200 px-5 py-2 text-xs text-gray-500">
              <span>Page {pager.page} of {pager.pages} · {pager.total} employees</span>
              <span className="flex gap-1">
                <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded border border-gray-300 px-2 py-1 disabled:opacity-40">Prev</button>
                <button disabled={page >= pager.pages} onClick={() => setPage((p) => p + 1)} className="rounded border border-gray-300 px-2 py-1 disabled:opacity-40">Next</button>
              </span>
            </div>
          )}

          <ReconcilePanel batchId={batchId} onDone={() => { load(); onReconciled && onReconciled(); }} />
        </>
      )}
    </div>
  );
}

// ── Reconcile: paste/upload the bank UTR/status file ──────────────────────────

function ReconcilePanel({ batchId, onDone }) {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function onFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setCsv(await f.text());
  }

  async function reconcile() {
    if (!csv.trim()) { setError('Paste or upload the bank UTR/status CSV first.'); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await post(`/api/hr/payroll/disbursement/${batchId}/reconcile`, { csv });
      setResult(r);
      onDone && onDone();
    } catch (e) {
      setError(e.data?.message || e.message || 'Reconcile failed.');
    } finally { setBusy(false); }
  }

  const matched = result ? result.report.filter((x) => x.matched).length : 0;
  const unmatched = result ? result.report.length - matched : 0;

  return (
    <div className="border-t border-gray-200 px-5 py-4">
      <div className="flex items-center gap-1 text-sm font-medium text-gray-800">
        Reconcile UTRs
        <InfoTip text="Upload the bank's UTR / status export. Columns (any order, case-insensitive): employeeCode or accountNumber to match the line, status (CREDITED / FAILED / RETURNED / PENDING), utr, and failureReason. Each line's status + the batch rollup update; re-runnable (idempotent)." />
      </div>
      <p className="mt-1 text-xs text-gray-500">CSV columns: <span className="font-mono">employeeCode | accountNumber, status, utr, failureReason</span></p>

      <div className="mt-2 flex flex-wrap items-start gap-3">
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={4}
          placeholder={'accountNumber,status,utr\n50100123456789,CREDITED,UTR12345\n00112233445566,FAILED,'}
          className="min-w-[24rem] flex-1 rounded-lg border border-gray-300 p-2 font-mono text-xs" />
        <div className="flex flex-col gap-2">
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-xs" />
          <PrimaryButton onClick={reconcile} loading={busy}>Reconcile</PrimaryButton>
        </div>
      </div>

      {error && <div className="mt-2"><ErrorBanner message={error} /></div>}
      {result && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700">
          Applied — batch is now <StatusBadge status={result.batch.status} />. Matched {matched} row(s){unmatched ? `, ${unmatched} unmatched` : ''}.
        </div>
      )}
    </div>
  );
}

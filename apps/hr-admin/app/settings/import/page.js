'use client';

/**
 * Import / Migrate — the Feature 18 Data Migration / Import Center (hr-admin).
 *
 * Plain-language, premium flow for a non-technical owner switching to DriftHR
 * mid-year: pick what to import → download a template → upload a CSV → preview
 * (dry-run, engine-true, nothing saved) → fix or commit → for payroll history,
 * the system AUTO-GENERATES the payslips through the real payroll engine.
 *
 * Everything is canManageImports-gated server-side; the payroll autogen also
 * needs canRunPayroll. This page is UX only — the server is the boundary.
 *
 * API (all under /api/hr/imports):
 *   GET  /templates/:kind     download the CSV template + data dictionary
 *   POST /                     upload (base64) → ImportJob (UPLOADED/PARSED)
 *   GET  /                     list jobs
 *   GET  /:id                  job detail + rollups + preview
 *   POST /:id/dry-run          simulated commit+autogen → engine-true preview
 *   POST /:id/commit           commit valid rows via the reused engines
 *   GET  /:id/rows?status=     paginated rows for the error grid
 *   GET  /:id/report           annotated CSV (status + reason + targetId)
 */

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@hr/ui';
import { get, post, downloadFile } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';

// The five import kinds, in dependency order, with plain-English descriptions +
// the "what you need first" hint the spec asks for.
const KINDS = [
  { kind: 'EMPLOYEE', title: 'Employees', blurb: 'The people master — names, work email, joining date, PAN/UAN.', needs: 'Nothing — start here.' },
  { kind: 'COMPENSATION', title: 'Salary / CTC', blurb: 'Each employee’s annual CTC. We derive the Basic/HRA/Special breakup for you.', needs: 'Employees imported first.' },
  { kind: 'ATTENDANCE', title: 'Attendance', blurb: 'Back-dated attendance — daily (one row per day) or a monthly summary.', needs: 'Employees imported first.' },
  { kind: 'PAYROLL_HISTORY', title: 'Payroll history', blurb: 'The months to rebuild. Once CTC + attendance exist, payslips auto-prepare through the engine.', needs: 'Employees + CTC + attendance.' },
  { kind: 'REIMBURSEMENT', title: 'Reimbursements', blurb: 'Prior expense claims with their claimed + approved amounts.', needs: 'Employees imported first.' },
];

const STATUS_DOT = { PASS: 'bg-green-500', WARN: 'bg-amber-500', ERROR: 'bg-red-500', COMMITTED: 'bg-green-600', SKIPPED: 'bg-gray-400', FAILED: 'bg-red-600', PARSED: 'bg-gray-300' };

function rupee(n) { return n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

export default function ImportCenterPage() {
  const [kind, setKind] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [job, setJob] = useState(null);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadJobs = useCallback(() => {
    get('/api/hr/imports?pageSize=25')
      .then((r) => setJobs(r.items || []))
      .catch((e) => setError(e.message || 'Failed to load import history.'));
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  const refreshJob = useCallback(async (id) => {
    const detail = await get(`/api/hr/imports/${id}`);
    setJob(detail);
    const rr = await get(`/api/hr/imports/${id}/rows?pageSize=200`);
    setRows(rr.items || []);
    return detail;
  }, []);

  // ── Template download ──────────────────────────────────────────────────────
  async function downloadTemplate(k) {
    try { await downloadFile(`/api/hr/imports/templates/${k}`, { filename: `drifthr-import-${k.toLowerCase()}.csv` }); }
    catch (e) { setError(e.message || 'Template download failed.'); }
  }

  // ── Upload (base64) ────────────────────────────────────────────────────────
  function onFile(e, k) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setError(''); setNotice(''); setBusy(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const created = await post('/api/hr/imports', { kind: k, fileName: file.name, mimeType: file.type || 'text/csv', contentBase64: String(reader.result) });
        setKind(k);
        await refreshJob(created.id);
        loadJobs();
        setNotice(`Uploaded ${file.name} — ${created.rowCount} row(s) detected. Run the preview to see what will happen.`);
      } catch (err) { setError(err.message || 'Upload failed.'); }
      finally { setBusy(false); }
    };
    reader.onerror = () => { setError('Could not read the file.'); setBusy(false); };
    reader.readAsDataURL(file);
  }

  async function runDryRun() {
    if (!job) return;
    setError(''); setNotice(''); setBusy(true);
    try { await post(`/api/hr/imports/${job.id}/dry-run`, {}); await refreshJob(job.id); setNotice('Preview ready. Nothing has been saved yet — review the rows below, then Commit.'); }
    catch (e) { setError(e.message || 'Dry-run failed.'); }
    finally { setBusy(false); }
  }

  async function runCommit() {
    if (!job) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      const res = await post(`/api/hr/imports/${job.id}/commit`, { autoGenerate: true });
      await refreshJob(job.id);
      loadJobs();
      const s = res.commitSummary || {};
      let msg = `Committed ${s.committed || 0} row(s) (${s.skipped || 0} skipped, ${s.failed || 0} failed).`;
      if (res.autogen && res.autogen.periods && res.autogen.periods.length) {
        const ps = res.autogen.periods.reduce((a, p) => a + (p.employees ? p.employees.length : 0), 0);
        msg += ` Auto-generated ${ps} payslip(s) across ${res.autogen.periods.length} month(s) through the payroll engine.`;
      }
      setNotice(msg);
    } catch (e) { setError(e.message || 'Commit failed.'); }
    finally { setBusy(false); }
  }

  async function openJob(j) { setKind(j.kind); setError(''); setNotice(''); await refreshJob(j.id); }

  const preview = job && job.previewJson && job.previewJson.preview;
  const canCommit = job && ['VALIDATED', 'DRY_RUN_OK', 'PARSED'].includes(job.status) && (job.passCount + job.warnCount) > 0;
  const committed = job && job.status === 'COMMITTED';

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader
        title="Import / Migrate data"
        subtitle="Bring your prior-period data into DriftHR. Upload a CSV, preview exactly what will happen (nothing is saved until you commit), then let the engine rebuild payslips and claims."
      />

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      {notice && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{notice}</div>
      )}

      {/* ── 1. Pick what to import ── */}
      <SectionTitle tip="Import in this order: Employees → Salary/CTC → Attendance → Payroll history (auto-generates payslips). Reimbursements can go any time after Employees.">
        1. What do you want to import?
      </SectionTitle>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {KINDS.map((k) => (
          <div key={k.kind} className={`rounded-xl border p-4 transition ${kind === k.kind ? 'border-2 shadow-sm' : 'border-gray-200 hover:border-gray-300'}`} style={kind === k.kind ? { borderColor: 'var(--theme-primary)' } : undefined}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">{k.title}</h3>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-gray-600">{k.blurb}</p>
            <p className="mt-2 text-[11px] font-medium text-gray-500">Needs first: {k.needs}</p>
            <div className="mt-3 flex items-center gap-3">
              <button type="button" onClick={() => downloadTemplate(k.kind)} className="text-xs font-semibold underline" style={{ color: 'var(--theme-primary)' }}>
                Download template
              </button>
              <label className="cursor-pointer text-xs font-semibold text-gray-700 hover:text-gray-900">
                Upload CSV
                <input type="file" accept=".csv,text/csv" className="hidden" disabled={busy} onChange={(e) => onFile(e, k.kind)} />
              </label>
            </div>
          </div>
        ))}
      </div>

      {/* ── 2. The active job: preview + commit ── */}
      {job && (
        <div className="mt-8 rounded-xl border border-gray-200 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle tip="The preview runs the REAL import + payroll engine inside a transaction that is rolled back, so what you see is exactly what a commit would produce — but nothing is saved until you click Commit.">
              2. Preview &amp; commit — {job.kind}
            </SectionTitle>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600">{job.status}</span>
          </div>

          <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-600">
            <span>File: <span className="font-medium text-gray-900">{job.fileName}</span></span>
            <span>Rows: <span className="font-medium text-gray-900">{job.rowCount}</span></span>
            <span className="text-green-700">Pass: {job.passCount}</span>
            <span className="text-amber-700">Warn: {job.warnCount}</span>
            <span className="text-red-700">Error: {job.errorCount}</span>
            {committed && <span className="text-green-700">Committed: {job.committedCount} · Skipped: {job.skippedCount}</span>}
          </div>

          {/* Payroll-history net-pay preview totals */}
          {preview && job.kind === 'PAYROLL_HISTORY' && preview.totals && (
            <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
              <span className="font-semibold">Engine preview:</span> {preview.totals.payslips || 0} payslip(s) across {preview.totals.periods || 0} month(s) · total net {rupee(preview.totals.totalNet)}. These figures come straight from the payroll engine (PF cap, PT slab, TDS as of each period) — compare them to your old payslips.
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!committed && (
              <button type="button" disabled={busy} onClick={runDryRun} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                {busy ? 'Working…' : 'Preview (dry-run)'}
              </button>
            )}
            {!committed && (
              <button type="button" disabled={busy || !canCommit} onClick={runCommit} className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: 'var(--theme-primary)' }}>
                {job.kind === 'PAYROLL_HISTORY' ? 'Commit + generate payslips' : 'Commit'}
              </button>
            )}
            <button type="button" onClick={() => downloadFile(`/api/hr/imports/${job.id}/report`, { filename: `import-report-${job.kind}.csv` })} className="text-xs font-semibold underline" style={{ color: 'var(--theme-primary)' }}>
              Download annotated report
            </button>
          </div>
          {!committed && (
            <p className="mt-2 text-[11px] text-gray-500">Nothing is saved until you commit. Red rows are skipped and listed in the report; fix them in your file and re-upload.</p>
          )}

          {/* ── Per-row results grid ── */}
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Key</th>
                  {job.kind === 'PAYROLL_HISTORY' && <th className="py-2 pr-3">Net pay (engine)</th>}
                  <th className="py-2 pr-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 100).map((r) => {
                  const findings = r.findingsJson || [];
                  const reason = findings.map((f) => f.message).join(' · ');
                  const previewRow = preview && (preview.perRow || []).find((p) => (p.rowNumber === r.rowNumber) || (p.naturalKey && p.naturalKey === r.naturalKey) || (p.employeeCode && r.naturalKey && r.naturalKey.startsWith(p.employeeCode)));
                  return (
                    <tr key={r.id} className="border-b border-gray-100">
                      <td className="py-2 pr-3 text-gray-500">{r.rowNumber}</td>
                      <td className="py-2 pr-3"><span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[r.status] || 'bg-gray-300'}`} /> <span className="ml-1 text-gray-700">{r.status}</span></td>
                      <td className="py-2 pr-3 font-mono text-[11px] text-gray-600">{r.naturalKey && !r.naturalKey.startsWith('__row_') ? r.naturalKey : '—'}</td>
                      {job.kind === 'PAYROLL_HISTORY' && <td className="py-2 pr-3 text-gray-900">{previewRow ? rupee(previewRow.netPay) : '—'}</td>}
                      <td className="py-2 pr-3 text-gray-600">{reason || (r.status === 'PASS' || r.status === 'COMMITTED' ? 'OK' : '')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length > 100 && <p className="mt-2 text-[11px] text-gray-400">Showing first 100 of {rows.length} rows — download the report for all.</p>}
          </div>
        </div>
      )}

      {/* ── 3. History ── */}
      <div className="mt-8">
        <SectionTitle tip="Every import you run, with who, when, counts, and a re-download of the annotated report.">3. Import history</SectionTitle>
        <div className="mt-3 overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-gray-500">
                <th className="px-3 py-2">Kind</th><th className="px-3 py-2">File</th><th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Pass/Warn/Err</th><th className="px-3 py-2">Committed</th><th className="px-3 py-2">When</th><th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No imports yet.</td></tr>}
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-gray-900">{j.kind}</td>
                  <td className="px-3 py-2 text-gray-600">{j.fileName}</td>
                  <td className="px-3 py-2"><span className="rounded-full bg-gray-100 px-2 py-0.5 font-semibold text-gray-600">{j.status}</span></td>
                  <td className="px-3 py-2 text-gray-600">{j.passCount}/{j.warnCount}/{j.errorCount}</td>
                  <td className="px-3 py-2 text-gray-600">{j.committedCount}</td>
                  <td className="px-3 py-2 text-gray-500">{j.uploadedAt ? new Date(j.uploadedAt).toLocaleDateString() : ''}</td>
                  <td className="px-3 py-2"><button type="button" onClick={() => openJob(j)} className="font-semibold underline" style={{ color: 'var(--theme-primary)' }}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

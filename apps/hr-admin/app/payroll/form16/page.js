'use client';

// Year-end → Form 16 (Part A + Part B) + Form 24Q (Feature 24). India-only (the
// server 404s a non-IN tenant). Form 16 rides the existing letters + e-sign engines:
//   POST /api/hr/payroll/form16/batches                    create (entity, FY) — exactly-once
//   GET  /api/hr/payroll/form16/batches                    list (paginated)
//   GET  /api/hr/payroll/form16/batches/:id                batch + certificate register
//   GET  /api/hr/payroll/form16/batches/:id/register?format=csv
//   POST /api/hr/payroll/form16/batches/:id/compute        Part A + Part B + cert no (idempotent)
//   POST /api/hr/payroll/form16/batches/:id/approve        maker-checker SoD
//   POST /api/hr/payroll/form16/batches/:id/issue          bulk-issue → ESS vault (+ optional sign)
//   GET  /api/hr/payroll/form16/certificates/:id/pdf       one certificate PDF
//   GET  /api/hr/payroll/form24q?entityId&financialYear&quarter   FVU file + Q4 Annexure-II

import { useCallback, useEffect, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions } from '@hr/ui';
import { get, post } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, Tabs } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';
import CountryGate from '@/components/CountryGate';

const PAGE_SIZE = 25;
const inr = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const API_BASE = String(process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');

// Open a credentialed file URL in a new tab (CSV / PDF download).
function openFile(path) {
  const url = API_BASE ? `${API_BASE}${path}` : path;
  window.open(url, '_blank', 'noopener');
}

// India-only (Feature 14): the server 404s a non-IN tenant, so guard the page for
// a deep link too. IN tenants render exactly as before (CountryGate fails open).
export default function Form16Page() {
  return (
    <CountryGate label="Form 16 / 24Q">
      <Form16PageInner />
    </CountryGate>
  );
}

function Form16PageInner() {
  const [tab, setTab] = useState('form16');
  return (
    <div>
      <PageHeader title="Year-end → Form 16 / 24Q" subtitle="TDS certificates (§203) + the quarterly e-TDS return. India only." />
      <ModuleGuide
        id="payroll-form16"
        title="Generate & issue Form 16 / 24Q for the financial year"
        what="This is your year-end TDS-on-salary workstation. The Form 16 tab builds each employee's §203 certificate — Part B (the annual tax computation) plus Part A (quarter-wise TDS deposited) — and issues it into their ESS document vault. The Form 24Q tab builds the quarterly e-TDS return (FVU file), with Q4 carrying Annexure-II. India entities only."
        steps={[
          'On the Form 16 tab, click "New Form 16 batch", pick the India legal entity (its PAN/TAN is snapshotted as the deductor) and the financial year (e.g. 2026-27), then Create.',
          'Open the batch and click Generate to compute Part A + Part B and a certificate number for every employee. Review the per-employee taxable, tax, TDS deducted vs deposited, and any anomaly flags.',
          'Get a second person to click Approve (maker-checker: you cannot approve a batch you generated).',
          'Click Issue to bulk-deliver the PDFs into each employee\'s ESS vault; optionally tick "Digitally sign" to route through e-sign.',
          'On the Form 24Q tab, select entity / FY / quarter, click Preview, then Download FVU file for upload to the TRACES utility — and Persist to mark it filed-ready.',
        ]}
        example={<>For FY <b>2026-27</b>, you run a batch for <b>Acme India Pvt Ltd</b> (TAN <b>BLRA01234F</b>). <b>Aarav Sharma</b>'s certificate shows taxable income <b>₹11,40,000</b>, tax <b>₹1,04,000</b>, TDS deducted <b>₹1,04,000</b> and deposited <b>₹1,04,000</b> under the <b>new regime</b> — reconciled, so it issues cleanly.</>}
        tips={[
          'If a quarter shows TDS deducted but not deposited, the batch is "Not reconciled" (§201 exposure) and Issue is blocked — you must tick force-acknowledge to override.',
          'FY ≥ 2026-27 auto-issues the Form 130 successor instead of Form 16; the Form column tells you which one each batch produced.',
        ]}
      />
      <Tabs
        tabs={[{ key: 'form16', label: 'Form 16' }, { key: 'form24q', label: 'Form 24Q' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'form16' ? <Form16Batches /> : <Form24QPanel />}
    </div>
  );
}

// ── Form 16 batches ─────────────────────────────────────────────────────────
function Form16Batches() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/payroll/form16/batches', { page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load Form 16 batches.'))
      .finally(() => setLoading(false));
  }, [page]);
  useEffect(() => { load(); }, [load]);

  const items = data?.items || [];
  if (openId) return <BatchDetail id={openId} onBack={() => { setOpenId(null); load(); }} />;

  const columns = [
    { key: 'fy', header: 'Financial year', render: (r) => r.financialYear },
    { key: 'entity', header: 'Entity', render: (r) => r.entity?.legalName || r.entity?.code || '—' },
    { key: 'form', header: 'Form', render: (r) => (r.formKind === 'IN_FORM130' ? 'Form 130' : 'Form 16') },
    { key: 'count', header: 'Employees', render: (r) => r.headcount ?? 0 },
    { key: 'recon', header: 'Reconciled', render: (r) => (r.status === 'DRAFT' ? '—' : (r.reconciledOk ? <span className="text-green-700">Yes</span> : <span className="text-red-600">No</span>)) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'open', header: '', render: (r) => <ActionButton onClick={() => setOpenId(r.id)}>Open</ActionButton> },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Generate every employee&apos;s Form 16 for a financial year: Part B is the year-end tax computation; Part A is the quarter-wise TDS deposited. Approve under maker-checker, then bulk-issue into each employee&apos;s ESS document vault.
        </p>
        <PrimaryButton onClick={() => setShowNew(true)}>New Form 16 batch</PrimaryButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No Form 16 batches yet." rowKey={(r) => r.id} />
      {showNew && <NewBatchModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
    </div>
  );
}

function NewBatchModal({ onClose, onCreated }) {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [financialYear, setFinancialYear] = useState(defaultFY());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/payroll/entities')
      .then((res) => setEntities((res?.items || []).filter((e) => !e.countryCode || e.countryCode === 'IN')))
      .catch((e) => setError(e.data?.message || e.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await post('/api/hr/payroll/form16/batches', { entityId, financialYear });
      onCreated();
    } catch (err) {
      setError(err.data?.message || err.message);
    } finally {
      setSaving(false);
    }
  }

  const valid = entityId && /^\d{4}-\d{2}$/.test(financialYear);

  return (
    <Modal title="New Form 16 batch" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Entity<InfoTip text="The India legal entity to generate Form 16 for. The deductor PAN/TAN is snapshotted from this entity." /></span>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">Select entity…</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.legalName || en.code}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Financial year<InfoTip text='Apr–Mar, e.g. "2026-27". FY ≥ 2026-27 issues the Form 130 successor automatically.' /></span>
          <input value={financialYear} onChange={(e) => setFinancialYear(e.target.value)} placeholder="2026-27" className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={!valid || saving}>{saving ? 'Creating…' : 'Create batch'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function BatchDetail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showIssue, setShowIssue] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    get(`/api/hr/payroll/form16/batches/${id}`)
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message))
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(action, body = {}) {
    setBusy(true);
    setError('');
    try {
      await post(`/api/hr/payroll/form16/batches/${id}/${action}`, body);
      load();
    } catch (e) {
      setError(e.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!data) return <ErrorBanner message={error || 'Not found'} />;

  const { batch, certificates = [], totals = {} } = data;
  const cols = [
    { key: 'emp', header: 'Employee', render: (c) => `${c.employeeCode || ''} ${c.employeeName || ''}`.trim() || '—' },
    { key: 'cert', header: 'Certificate no', render: (c) => <span className="font-mono text-xs">{c.certificateNo}</span> },
    { key: 'regime', header: 'Regime', render: (c) => c.regime },
    { key: 'taxable', header: 'Taxable', render: (c) => inr(c.totalTaxableMinor) },
    { key: 'tax', header: 'Tax', render: (c) => inr(c.totalTaxMinor) },
    { key: 'tds', header: 'TDS deducted', render: (c) => inr(c.tdsDeductedMinor) },
    { key: 'dep', header: 'Deposited', render: (c) => (c.tdsDepositedMinor >= c.tdsDeductedMinor ? <span className="text-green-700">{inr(c.tdsDepositedMinor)}</span> : <span className="text-red-600" title="TDS gap (§201)">{inr(c.tdsDepositedMinor)}</span>) },
    { key: 'anom', header: '', render: (c) => ((c.anomalies || []).length ? <span title={c.anomalies.map((a) => a.message).join('\n')} className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">{c.anomalies.length} flag{c.anomalies.length > 1 ? 's' : ''}</span> : null) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    { key: 'pdf', header: '', render: (c) => (c.status !== 'PENDING' || certificates.length ? <ActionButton onClick={() => openFile(`/api/hr/payroll/form16/certificates/${c.id}/pdf`)}>PDF</ActionButton> : null) },
  ];

  return (
    <div>
      <button onClick={onBack} className="mb-3 text-sm text-gray-500 hover:text-gray-700">← Back to batches</button>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Form 16 — {batch.financialYear}</h2>
          <p className="text-sm text-gray-500">
            {batch.deductorName || '—'} · TAN {batch.deductorTan || '—'} · <StatusBadge status={batch.status} /> · {batch.headcount ?? 0} employee(s)
          </p>
        </div>
        <div className="flex gap-2">
          {(batch.status === 'DRAFT' || batch.status === 'COMPUTED') && <ActionButton disabled={busy} onClick={() => act('compute')}>Generate</ActionButton>}
          {batch.status === 'COMPUTED' && <ActionButton tone="positive" disabled={busy} onClick={() => act('approve')}>Approve</ActionButton>}
          {(batch.status === 'APPROVED' || batch.status === 'ISSUED') && <ActionButton tone="positive" disabled={busy} onClick={() => setShowIssue(true)}>Issue</ActionButton>}
          {batch.status !== 'DRAFT' && <ActionButton disabled={busy} onClick={() => openFile(`/api/hr/payroll/form16/batches/${id}/register?format=csv`)}>Register CSV</ActionButton>}
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {batch.status === 'COMPUTED' && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
          Maker-checker: a different approver must approve this batch (you cannot approve a batch you generated).
        </p>
      )}
      {batch.status !== 'DRAFT' && !batch.reconciledOk && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          Not reconciled — one or more quarters have deducted TDS without a matching deposited challan (§201 exposure). Issue is blocked unless you force-acknowledge.
        </p>
      )}
      <div className="mb-3 flex gap-6 text-sm text-gray-600">
        <span>Employees: <strong>{totals.headcount ?? 0}</strong></span>
        <span>Total TDS deducted: <strong>{inr(totals.totalTdsDeductedMinor)}</strong></span>
        <span>Total deposited: <strong>{inr(totals.totalTdsDepositedMinor)}</strong></span>
      </div>
      <DataTable columns={cols} rows={certificates} loading={false} emptyText="No certificates yet — click Generate." rowKey={(c) => c.id} />
      {showIssue && (
        <IssueModal
          reconciled={!!batch.reconciledOk}
          busy={busy}
          onClose={() => setShowIssue(false)}
          onIssue={async (opts) => { setShowIssue(false); await act('issue', opts); }}
        />
      )}
    </div>
  );
}

function IssueModal({ reconciled, busy, onClose, onIssue }) {
  const [sign, setSign] = useState(false);
  const [force, setForce] = useState(false);
  return (
    <Modal title="Issue Form 16" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-600">Bulk-issue every pending certificate into each employee&apos;s ESS document vault. The PDF rides the letters engine (ref-no + sha256 + register).</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} /> Digitally sign (route through e-sign)</label>
        {!reconciled && (
          <label className="flex items-center gap-2 text-red-700">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force-acknowledge the deducted-vs-deposited gap (§201) and issue anyway
          </label>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton disabled={busy || (!reconciled && !force)} onClick={() => onIssue({ sign, force })}>{busy ? 'Issuing…' : 'Issue all'}</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ── Form 24Q ─────────────────────────────────────────────────────────────────
function Form24QPanel() {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [financialYear, setFinancialYear] = useState(defaultFY());
  const [quarter, setQuarter] = useState('Q4');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get('/api/hr/payroll/entities')
      .then((res) => setEntities((res?.items || []).filter((e) => !e.countryCode || e.countryCode === 'IN')))
      .catch((e) => setError(e.data?.message || e.message));
  }, []);

  async function preview() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const r = await get('/api/hr/payroll/form24q', { entityId, financialYear, quarter });
      setResult(r);
    } catch (e) {
      setError(e.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  }
  async function persist() {
    setBusy(true);
    setError('');
    try {
      await post('/api/hr/payroll/form24q/persist', { entityId, financialYear, quarter });
      await preview();
    } catch (e) {
      setError(e.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  }
  function downloadFvu() {
    if (!result) return;
    const blob = new Blob([result.content], { type: result.contentType || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = result.fileName || '24Q.fvu';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const valid = entityId && /^\d{4}-\d{2}$/.test(financialYear);
  const lines = result?.meta?.annexureII;
  const isAnnexure = Array.isArray(lines);

  return (
    <div>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Entity</span>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">Select…</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.legalName || en.code}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Financial year</span>
          <input value={financialYear} onChange={(e) => setFinancialYear(e.target.value)} placeholder="2026-27" className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Quarter</span>
          <select value={quarter} onChange={(e) => setQuarter(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {['Q1', 'Q2', 'Q3', 'Q4'].map((q) => <option key={q} value={q}>{q}{q === 'Q4' ? ' (Annexure-II)' : ''}</option>)}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <PrimaryButton disabled={!valid || busy} onClick={preview}>{busy ? 'Building…' : 'Preview'}</PrimaryButton>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {result && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
            <span>TAN <strong>{result.meta?.tan || '—'}</strong></span>
            <span>Deductees <strong>{result.meta?.deducteeCount ?? 0}</strong></span>
            <span>Total TDS <strong>₹{result.meta?.totals?.tdsRupees ?? '0.00'}</strong></span>
            <ActionButton onClick={downloadFvu}>Download FVU file</ActionButton>
            <ActionButton onClick={persist} disabled={busy}>Persist (mark filed-ready)</ActionButton>
          </div>
          {isAnnexure && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-800">Annexure-II — annual salary detail (sourced from Form 16 Part B)</h3>
              <div className="max-h-96 overflow-auto rounded-lg border border-gray-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr><th className="px-2 py-1">PAN</th><th className="px-2 py-1">Name</th><th className="px-2 py-1">Gross</th><th className="px-2 py-1">Total income</th><th className="px-2 py-1">Tax payable</th><th className="px-2 py-1">Total TDS</th><th className="px-2 py-1">Regime</th></tr>
                  </thead>
                  <tbody>
                    {lines.map((r, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-2 py-1 font-mono">{r.pan}</td>
                        <td className="px-2 py-1">{r.name}</td>
                        <td className="px-2 py-1">₹{r.grossSalary}</td>
                        <td className="px-2 py-1">₹{r.totalIncome}</td>
                        <td className="px-2 py-1">₹{r.totalTaxPayable}</td>
                        <td className="px-2 py-1">₹{r.totalTdsDeducted}</td>
                        <td className="px-2 py-1">{r.regime}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {!isAnnexure && (
            <pre className="max-h-72 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">{result.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function defaultFY() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startY = m >= 3 ? y - 1 : y - 2;
  return `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
}

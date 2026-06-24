'use client';

// Auto-Arrear console (Feature 27 — retro salary revision). India-only (server 404s a
// non-IN tenant). The arrear rides the existing PayRun pipeline:
//   GET   /api/hr/arrears/detect?entityId=&period=   list retro revisions w/ un-actioned arrears
//   POST  /api/hr/arrears/cycles                      create a cycle from a compensationRevisionId
//   GET   /api/hr/arrears/cycles?entityId=&status=    list cycles
//   GET   /api/hr/arrears/cycles/:id                  header + per-month diffs + §89(1) datapoint
//   PATCH /api/hr/arrears/cycles/:id                  toggle esiOnArrears / edit notes (DRAFT/COMPUTED)
//   POST  /api/hr/arrears/cycles/:id/compute          recompute diffs (idempotent)
//   POST  /api/hr/arrears/cycles/:id/approve          SoD → INJECT (open run) | MINT (separate run)
//   POST  /api/hr/arrears/cycles/:id/publish          fan out arrears.published (+ §89(1) figure)

import { useCallback, useEffect, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';

const inr = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const thisPeriod = () => new Date().toISOString().slice(0, 7); // "YYYY-MM"

export default function ArrearsPage() {
  const [openId, setOpenId] = useState(null);
  if (openId) return <CycleDetail id={openId} onBack={() => setOpenId(null)} />;
  return (
    <div>
      <PageHeader title="Arrears" subtitle="Auto-arrear engine — back-dated salary revisions paid as current-period income (India)" />
      <DetectBanner onOpenCycle={setOpenId} />
      <ArrearCycles onOpenCycle={setOpenId} />
    </div>
  );
}

// ── Detect banner: retro revisions on the open run ──────────────────────────
function DetectBanner({ onOpenCycle }) {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [period, setPeriod] = useState(thisPeriod());
  const [detected, setDetected] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get('/api/hr/payroll/entities')
      .then((res) => { const items = res?.items || []; setEntities(items); if (items[0]) setEntityId(items[0].id); })
      .catch((e) => setError(e.data?.message || e.message));
  }, []);

  const runDetect = useCallback(() => {
    if (!entityId) return;
    setBusy(true); setError('');
    get('/api/hr/arrears/detect', { entityId, period })
      .then(setDetected)
      .catch((e) => setError(e.data?.message || e.message))
      .finally(() => setBusy(false));
  }, [entityId, period]);
  useEffect(() => { runDetect(); }, [runDetect]);

  async function createCycle(revId) {
    setBusy(true); setError('');
    try {
      const cycle = await post('/api/hr/arrears/cycles', { compensationRevisionId: revId, detectedInPeriod: period });
      onOpenCycle(cycle.id);
    } catch (e) { setError(e.data?.message || e.message); } finally { setBusy(false); }
  }

  const cands = detected?.candidates || [];
  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-amber-900">Detect retro revisions for the open period</span>
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
          {entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.legalName}</option>)}
        </select>
        <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" className="w-28 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        <button onClick={runDetect} disabled={busy} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm">Refresh</button>
      </div>
      {error && <ErrorBanner message={error} />}
      {busy && <Spinner />}
      {!busy && cands.length === 0 && <p className="text-sm text-amber-800">No back-dated salary revisions effective before this period. Nothing to settle.</p>}
      {!busy && cands.length > 0 && (
        <div>
          <p className="mb-2 text-sm text-amber-900">
            {cands.length} employee(s) have a back-dated salary revision effective before {period}. Review and settle the arrears.
          </p>
          <ul className="space-y-1">
            {cands.map((c) => (
              <li key={c.compensationRevisionId} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm">
                <span>
                  <strong>{c.employee ? `${c.employee.firstName || ''} ${c.employee.lastName || ''}`.trim() || c.employee.code : c.employeeId}</strong>
                  {' '}— {c.revisionReason}, effective {c.effectiveFrom} ({c.monthCount} month{c.monthCount > 1 ? 's' : ''}: {c.retroMonths.join(', ')})
                </span>
                <ActionButton onClick={() => createCycle(c.compensationRevisionId)}>Create arrear cycle →</ActionButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Cycles list ─────────────────────────────────────────────────────────────
function ArrearCycles({ onOpenCycle }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true); setError('');
    get('/api/hr/arrears/cycles')
      .then((res) => setRows(Array.isArray(res) ? res : (res?.items || [])))
      .catch((e) => setError(e.data?.message || e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const columns = [
    { key: 'emp', header: 'Employee', render: (r) => r.employee ? (`${r.employee.firstName || ''} ${r.employee.lastName || ''}`.trim() || r.employee.code) : r.employeeId },
    { key: 'reason', header: 'Reason', render: (r) => r.revisionReason },
    { key: 'eff', header: 'Effective', render: (r) => r.effectiveFrom },
    { key: 'gross', header: 'Arrear', render: (r) => <span className={Number(r.grossArrearMinor) < 0 ? 'text-red-600 font-medium' : ''}>{inr(r.grossArrearMinor)}</span> },
    { key: 'relief', header: '§89(1) relief', render: (r) => r.s89ReliefMinor != null ? inr(r.s89ReliefMinor) : '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'open', header: '', render: (r) => <ActionButton onClick={() => onOpenCycle(r.id)}>Open</ActionButton> },
  ];

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-gray-700">Arrear cycles</h3>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={rows} loading={loading} emptyText="No arrear cycles yet." rowKey={(r) => r.id} />
    </div>
  );
}

// ── Cycle detail: per-month diff table + ESI toggle + §89(1) card + actions ──
function CycleDetail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showApprove, setShowApprove] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    get(`/api/hr/arrears/cycles/${id}`).then(setData).catch((e) => setError(e.data?.message || e.message)).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(action, body) {
    setBusy(true); setError('');
    try { await post(`/api/hr/arrears/cycles/${id}/${action}`, body || {}); load(); }
    catch (e) { setError(e.data?.message || e.message); } finally { setBusy(false); }
  }
  async function toggleEsi(next) {
    setBusy(true); setError('');
    try { await patch(`/api/hr/arrears/cycles/${id}`, { esiOnArrears: next }); load(); }
    catch (e) { setError(e.data?.message || e.message); } finally { setBusy(false); }
  }

  if (loading) return <Spinner />;
  if (!data) return <ErrorBanner message={error || 'Not found'} />;

  const c = data;
  const editable = c.status === 'DRAFT' || c.status === 'COMPUTED';
  const negative = Number(c.grossArrearMinor) < 0;
  const s89 = c.s89Datapoint || {};

  return (
    <div>
      <button onClick={onBack} className="mb-3 text-sm text-gray-500 hover:underline">← Back to arrears</button>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {c.employee ? (`${c.employee.firstName || ''} ${c.employee.lastName || ''}`.trim() || c.employee.code) : c.employeeId}
            {' '}<StatusBadge status={c.status} />
          </h2>
          <p className="text-sm text-gray-500">{c.revisionReason} · effective {c.effectiveFrom} · detected {c.detectedInPeriod} · receipt FY {c.taxYear}</p>
        </div>
        <div className="flex gap-2">
          {c.status === 'DRAFT' && <PrimaryButton onClick={() => act('compute')} loading={busy}>Compute diffs</PrimaryButton>}
          {c.status === 'COMPUTED' && <PrimaryButton onClick={() => act('compute')} loading={busy}>Recompute</PrimaryButton>}
          {c.status === 'COMPUTED' && !negative && <PrimaryButton onClick={() => setShowApprove(true)}>Approve & pay</PrimaryButton>}
          {(c.status === 'APPROVED' || c.status === 'PAID') && <PrimaryButton onClick={() => act('publish')} loading={busy}>Publish slip</PrimaryButton>}
        </div>
      </div>
      {error && <ErrorBanner message={error} />}

      {negative && (
        <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          This revision <strong>reduces</strong> past pay by {inr(Math.abs(Number(c.grossArrearMinor)))} — a recovery, not an arrear. It is never auto-deducted;
          recover only via an explicit operator-approved correction run.
        </div>
      )}

      {/* Totals */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Gross arrear" value={inr(c.grossArrearMinor)} />
        <Stat label="PF on arrears (EE)" value={inr(c.pfArrearEeMinor)} />
        <Stat label="ESI on arrears (EE)" value={inr(c.esiArrearEeMinor)} />
        <Stat label="§89(1) relief" value={c.s89ReliefMinor != null ? inr(c.s89ReliefMinor) : '—'} />
      </div>

      {/* ESI-on-arrears toggle */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!c.esiOnArrears} disabled={!editable || busy} onChange={(e) => toggleEsi(e.target.checked)} />
          <span className="font-medium">ESI on arrears</span>
          <InfoTip text="Increment declared late (ANNUAL_REVISION/PROMOTION/CORRECTION) → ESI applies. Wage-revision settlement (RESTRUCTURE/STATUTORY_ADJUSTMENT) → ESI exempt." />
        </label>
        <p className="mt-1 text-xs text-gray-500">
          {c.esiOnArrears ? 'ESI is charged on the arrear (a late increment).' : 'ESI is NOT charged (a retrospective wage-revision settlement).'}
        </p>
      </div>

      {/* Per-month diff table */}
      <h3 className="mb-2 text-sm font-semibold text-gray-700">Per-month diff (recompute at new comp vs frozen paid slip)</h3>
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2">Paid gross</th>
              <th className="px-3 py-2">Revised gross</th>
              <th className="px-3 py-2">Arrear</th>
              <th className="px-3 py-2">PF on arrear</th>
              <th className="px-3 py-2">ESI on arrear</th>
              <th className="px-3 py-2">Components</th>
            </tr>
          </thead>
          <tbody>
            {(c.months || []).map((m) => (
              <tr key={m.sourcePeriod} className="border-t border-gray-100">
                <td className="px-3 py-2 font-medium">{m.sourcePeriod}</td>
                <td className="px-3 py-2">{inr(m.paidGrossMinor)}</td>
                <td className="px-3 py-2">{inr(m.recomputedGrossMinor)}</td>
                <td className="px-3 py-2 font-medium">{inr(m.deltaGrossMinor)}</td>
                <td className="px-3 py-2">{inr(m.pfArrearEeMinor)}</td>
                <td className="px-3 py-2">{inr(m.esiArrearEeMinor)}</td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  {(m.componentDeltas || []).map((d) => `${d.code} ${d.deltaMinor >= 0 ? '+' : ''}${inr(d.deltaMinor)}`).join(', ') || '—'}
                </td>
              </tr>
            ))}
            {(!c.months || c.months.length === 0) && (
              <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">Not yet computed.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* §89(1) relief card */}
      {c.s89ReliefMinor != null && (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <h3 className="text-sm font-semibold text-indigo-900">Section 89(1) relief — {c.reliefFormName || 'Form 10E'}</h3>
          <p className="mt-1 text-sm text-indigo-800">
            Estimated relief: <strong>{inr(c.s89ReliefMinor)}</strong>. Because the arrear relates to earlier months, the employee may pay less tax by
            claiming Section 89(1) relief by filing <strong>{c.reliefFormName || 'Form 10E'}</strong> before their return.
          </p>
          {Array.isArray(s89.sourceSlices) && s89.sourceSlices.length > 0 && (
            <table className="mt-2 text-xs text-indigo-900">
              <thead><tr><th className="pr-4 text-left">Source FY</th><th className="pr-4 text-left">Arrear slice</th><th className="text-left">Tax on slice</th></tr></thead>
              <tbody>
                {s89.sourceSlices.map((sl) => (
                  <tr key={sl.fy}><td className="pr-4">{sl.fy}</td><td className="pr-4">₹{Number(sl.sliceRupees || 0).toLocaleString('en-IN')}</td><td>{inr(sl.sliceTaxMinor)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showApprove && <ApproveModal cycle={c} onClose={() => setShowApprove(false)} onDone={() => { setShowApprove(false); load(); }} />}
    </div>
  );
}

function ApproveModal({ cycle, onClose, onDone }) {
  const [mode, setMode] = useState('INJECT');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try { await post(`/api/hr/arrears/cycles/${cycle.id}/approve`, { targetMode: mode }); onDone(); }
    catch (err) { setError(err.data?.message || err.message); } finally { setSaving(false); }
  }

  return (
    <Modal title="Approve & pay arrears" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <p className="text-sm text-gray-600">You cannot approve a cycle you computed (maker-checker SoD is enforced server-side).</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="mode" checked={mode === 'INJECT'} onChange={() => setMode('INJECT')} className="mt-1" />
          <span><strong>Add to this month's pay run</strong> — injects an arrear earning into the open DRAFT run (taxed as current-period income).</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="mode" checked={mode === 'MINT'} onChange={() => setMode('MINT')} className="mt-1" />
          <span><strong>Pay as a separate arrears run</strong> — mints a standalone PayRun(type=ARREAR) carrying the arrear + PF/ESI.</span>
        </label>
        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>Approve ({inr(cycle.grossArrearMinor)})</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <p className="text-xs uppercase text-gray-400">{label}</p>
      <p className="mt-0.5 text-base font-semibold text-gray-800">{value}</p>
    </div>
  );
}

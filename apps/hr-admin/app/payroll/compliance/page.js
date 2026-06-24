'use client';

// Statutory Compliance Calendar (Feature 23) — per-tenant India due-date tracker.
//   GET  /api/hr/compliance/calendar?from=&to=&entityId=&kind=&status=   the feed
//   GET  /api/hr/compliance/calendar/:remittanceId                       detail drawer
//   POST /api/hr/compliance/remittances/:id/mark-filed                   { challanRef, filedDate, paidDate? }
//   POST /api/hr/compliance/remittances/:id/proof                        { fileBase64 } (≤10 MB, PDF/PNG/JPG)
//   POST /api/hr/compliance/remittances/:id/waive                        { reason }
//   GET  /api/hr/compliance/obligations?entityId=                        the rule schedule
//   PATCH/POST /api/hr/compliance/obligations[/:id]                      toggle / edit / create
//   POST /api/hr/compliance/obligations/seed                            re-derive from registrations
// Read gated on canViewPayrollReports; mutations on canManageStatutory (server is the
// real boundary). India-first; the calendar follows the tenant's StatutoryRegistrations.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { PageHeader, Tabs } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';

const PAGE_SIZE = 50;

// UI status → chip class (grey Upcoming, amber Due soon, blue Due today, red
// Overdue, green Filed, slate Waived).
const CHIP = {
  UPCOMING: { cls: 'bg-gray-100 text-gray-600 border-gray-200', label: 'Upcoming' },
  DUE_SOON: { cls: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Due soon' },
  DUE_TODAY: { cls: 'bg-blue-50 text-blue-700 border-blue-200', label: 'Due today' },
  OVERDUE: { cls: 'bg-red-50 text-red-700 border-red-200', label: 'Overdue' },
  FILED: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Filed' },
  WAIVED: { cls: 'bg-slate-100 text-slate-600 border-slate-300', label: 'Waived' },
};

function Chip({ status }) {
  const c = CHIP[status] || CHIP.UPCOMING;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${c.cls}`}>{c.label}</span>;
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return String(d).slice(0, 10); }
}
function fmtMoney(amount, cc) {
  const n = Number(amount || 0);
  if (!n) return '—';
  return `${cc === 'NZD' ? '$' : '₹'}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function CompliancePage() {
  const [tab, setTab] = useState('calendar');
  return (
    <div>
      <PageHeader
        title="Compliance Calendar"
        subtitle="India statutory due dates — PF · ESI · PT · TDS · Form 24Q/Form 16 · LWF — with reminders + proof of filing"
      />
      <Tabs
        tabs={[{ key: 'calendar', label: 'Calendar' }, { key: 'schedule', label: 'Schedule settings' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'calendar' ? <CalendarView /> : <ScheduleSettings />}
    </div>
  );
}

// ── Calendar / list view ─────────────────────────────────────────────────────
function CalendarView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [entities, setEntities] = useState([]);
  const [filters, setFilters] = useState({ entityId: '', kind: '', status: '', range: '120' });
  const [openId, setOpenId] = useState(null);
  const [fileTarget, setFileTarget] = useState(null);
  const [waiveTarget, setWaiveTarget] = useState(null);

  useEffect(() => {
    get('/api/hr/payroll/entities').then((r) => setEntities(Array.isArray(r) ? r : (r.items || []))).catch((e) => setError(e.data?.message || e.message || 'Could not load entities — you may be missing a payroll permission.'));
  }, []);

  const load = useCallback(() => {
    setLoading(true); setError('');
    const today = new Date();
    const from = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const days = parseInt(filters.range, 10) || 120;
    const to = new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
    get('/api/hr/compliance/calendar', {
      from, to, page, pageSize: PAGE_SIZE,
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load the compliance calendar.'))
      .finally(() => setLoading(false));
  }, [page, filters]);
  useEffect(() => { load(); }, [load]);

  const counts = data?.counts || { dueThisWeek: 0, overdue: 0, upcoming: 0, filed: 0 };
  const items = data?.items || [];

  return (
    <div className="space-y-4">
      {/* Banner */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4">
        <div className="text-sm">
          <span className="font-semibold text-gray-900">{counts.dueThisWeek}</span> <span className="text-gray-600">due this week</span>
          <span className="mx-2 text-gray-300">·</span>
          <button type="button" onClick={() => { setFilters((f) => ({ ...f, status: 'OVERDUE' })); setPage(1); }} className="font-semibold text-red-700 hover:underline">
            {counts.overdue} overdue
          </button>
          <span className="mx-2 text-gray-300">·</span>
          <span className="font-semibold text-emerald-700">{counts.filed}</span> <span className="text-gray-600">filed/waived</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <InfoTip text="Reminders fire daily at T-7 / T-3 / T-1 / due / overdue to users with canManageStatutory. Late PF → 12% p.a. + damages; late TDS → 1.5%/mo interest." />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4">
        <label className="text-xs">
          <span className="block font-medium text-gray-700">Entity</span>
          <select value={filters.entityId} onChange={(e) => { setFilters((f) => ({ ...f, entityId: e.target.value })); setPage(1); }} className="mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">All entities</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.code}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="block font-medium text-gray-700">Form</span>
          <select value={filters.kind} onChange={(e) => { setFilters((f) => ({ ...f, kind: e.target.value })); setPage(1); }} className="mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">All forms</option>
            {['IN_TDS', 'IN_PF', 'IN_ESI', 'IN_PT', 'IN_LWF', 'IN_FORM24Q', 'IN_FORM138', 'IN_FORM16', 'IN_FORM130', 'IN_ESI_RETURN'].map((k) => <option key={k} value={k}>{KIND_LABEL[k] || k}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="block font-medium text-gray-700">Status</span>
          <select value={filters.status} onChange={(e) => { setFilters((f) => ({ ...f, status: e.target.value })); setPage(1); }} className="mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">All statuses</option>
            {['PENDING', 'DUE', 'OVERDUE', 'FILED', 'PAID', 'WAIVED'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="block font-medium text-gray-700">Horizon</span>
          <select value={filters.range} onChange={(e) => { setFilters((f) => ({ ...f, range: e.target.value })); setPage(1); }} className="mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="60">Next 60 days</option>
            <option value="120">Next 120 days</option>
            <option value="365">Next 12 months</option>
          </select>
        </label>
        {(filters.entityId || filters.kind || filters.status) && (
          <button type="button" onClick={() => { setFilters((f) => ({ ...f, entityId: '', kind: '', status: '' })); setPage(1); }} className="text-xs text-gray-500 hover:underline">Clear filters</button>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Form</th>
                <th className="px-4 py-2">State</th>
                <th className="px-4 py-2">Period</th>
                <th className="px-4 py-2">Amount</th>
                <th className="px-4 py-2">Due date</th>
                <th className="px-4 py-2">Days left</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Proof</th>
                <th className="px-4 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => (
                <tr key={r.id || `v-${i}`} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <button type="button" onClick={() => r.id && setOpenId(r.id)} className={`font-medium ${r.id ? 'text-blue-700 hover:underline' : 'text-gray-700 cursor-default'}`}>
                      {r.label || KIND_LABEL[r.kind] || r.kind}
                    </button>
                    {r.supersededBy && <span className="ml-1 text-[10px] text-gray-400">→ {KIND_LABEL[r.supersededBy] || r.supersededBy}</span>}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{r.stateCode || '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{r.taxPeriod}</td>
                  <td className="px-4 py-2 text-gray-700">{fmtMoney(r.amount, r.currencyCode)}</td>
                  <td className="px-4 py-2 text-gray-700">{fmtDate(r.dueDate)}</td>
                  <td className="px-4 py-2 text-gray-500">{r.displayStatus === 'OVERDUE' ? `${Math.abs(r.daysLeft)}d ago` : `${r.daysLeft}d`}</td>
                  <td className="px-4 py-2"><Chip status={r.displayStatus} /></td>
                  <td className="px-4 py-2">{r.hasProof ? <span title="Proof attached" className="text-emerald-600">✓</span> : <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2 text-right">
                    {r.id && !['FILED', 'PAID', 'WAIVED'].includes(r.status) ? (
                      <div className="inline-flex gap-1">
                        <button type="button" onClick={() => setFileTarget(r)} className="rounded-md border border-emerald-300 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50">Mark filed</button>
                        <button type="button" onClick={() => setWaiveTarget(r)} className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">Waive</button>
                      </div>
                    ) : r.id ? (
                      <span className="text-xs text-gray-400">{r.challanRef ? `Ref ${r.challanRef}` : '—'}</span>
                    ) : <span className="text-xs text-gray-400">not yet generated</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">Page {data.page} of {data.totalPages} · {data.total} items</span>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-md border border-gray-300 px-3 py-1 disabled:opacity-40">Prev</button>
            <button type="button" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-md border border-gray-300 px-3 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
      )}

      {openId && <DetailDrawer remittanceId={openId} onClose={() => setOpenId(null)} />}
      {fileTarget && <MarkFiledModal row={fileTarget} onClose={() => setFileTarget(null)} onDone={() => { setFileTarget(null); load(); }} />}
      {waiveTarget && <WaiveModal row={waiveTarget} onClose={() => setWaiveTarget(null)} onDone={() => { setWaiveTarget(null); load(); }} />}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
      <p className="font-medium text-gray-700">No statutory obligations yet.</p>
      <p className="mt-1">Add your EPFO / ESIC / PT / TAN registrations under <span className="font-medium">Entity → Registrations</span>, then use <span className="font-medium">Schedule settings → Re-derive from registrations</span> to populate the calendar.</p>
    </div>
  );
}

// ── Mark filed modal (challan + proof upload) ────────────────────────────────
function MarkFiledModal({ row, onClose, onDone }) {
  const [challanRef, setChallanRef] = useState('');
  const [filedDate, setFiledDate] = useState(new Date().toISOString().slice(0, 10));
  const [paidDate, setPaidDate] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await post(`/api/hr/compliance/remittances/${row.id}/mark-filed`, { challanRef, filedDate, ...(paidDate ? { paidDate } : {}) });
      if (file) {
        const dataUrl = await fileToDataUrl(file);
        await post(`/api/hr/compliance/remittances/${row.id}/proof`, { fileBase64: dataUrl });
      }
      onDone();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to mark as filed.');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Mark filed — ${row.label || row.kind}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-500">{row.taxPeriod} · due {fmtDate(row.dueDate)}</p>
        <label className="block">
          <span className="font-medium text-gray-700">Challan / CRN reference</span>
          <input value={challanRef} onChange={(e) => setChallanRef(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2" placeholder="e.g. CRN24Q..." />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="font-medium text-gray-700">Filed date</span>
            <input type="date" value={filedDate} onChange={(e) => setFiledDate(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2" />
          </label>
          <label className="block">
            <span className="flex items-center font-medium text-gray-700">Paid date<InfoTip text="Optional — set if the amount is also paid; marks the item PAID instead of just FILED." /></span>
            <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2" />
          </label>
        </div>
        <label className="block">
          <span className="flex items-center font-medium text-gray-700">Proof (challan / receipt)<InfoTip text="Optional PDF/PNG/JPG, ≤10 MB. Stored as the filing proof; the reminder for this item stops once filed." /></span>
          <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} className="mt-1 block w-full text-sm" />
        </label>
        {error && <ErrorBanner message={error} />}
      </div>
      <ModalActions>
        <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">Cancel</button>
        <PrimaryButton onClick={submit} loading={busy} disabled={!challanRef || !filedDate}>Mark filed</PrimaryButton>
      </ModalActions>
    </Modal>
  );
}

// ── Waive modal ──────────────────────────────────────────────────────────────
function WaiveModal({ row, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await post(`/api/hr/compliance/remittances/${row.id}/waive`, { reason });
      onDone();
    } catch (e) { setError(e.data?.message || e.message || 'Failed to waive.'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={`Waive — ${row.label || row.kind}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-500">{row.taxPeriod} · marks this period not-applicable / nil. Reminders stop.</p>
        <label className="block">
          <span className="font-medium text-gray-700">Reason</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2" placeholder="e.g. Zero employees this period — nil filing." />
        </label>
        {error && <ErrorBanner message={error} />}
      </div>
      <ModalActions>
        <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">Cancel</button>
        <PrimaryButton onClick={submit} loading={busy} disabled={!reason.trim()}>Waive</PrimaryButton>
      </ModalActions>
    </Modal>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────────────
function DetailDrawer({ remittanceId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    get(`/api/hr/compliance/calendar/${remittanceId}`).then(setData).catch((e) => setError(e.data?.message || e.message || 'Failed to load detail.'));
  }, [remittanceId]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-semibold text-gray-900">{data ? (data.label || data.kind) : 'Loading…'}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        {error && <ErrorBanner message={error} />}
        {!data ? <Spinner /> : (
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex items-center gap-2"><Chip status={data.displayStatus} />{data.hasProof && <span className="text-xs text-emerald-600">✓ proof attached</span>}</div>
            <dl className="grid grid-cols-2 gap-y-2">
              <dt className="text-gray-500">Period</dt><dd className="text-gray-900">{data.taxPeriod}</dd>
              <dt className="text-gray-500">State</dt><dd className="text-gray-900">{data.stateCode || '—'}</dd>
              <dt className="text-gray-500">Amount</dt><dd className="text-gray-900">{fmtMoney(data.amount, data.currencyCode)}</dd>
              <dt className="text-gray-500">Due date</dt><dd className="text-gray-900">{fmtDate(data.dueDate)}</dd>
              <dt className="text-gray-500">Challan ref</dt><dd className="text-gray-900">{data.challanRef || '—'}</dd>
              <dt className="text-gray-500">Filed date</dt><dd className="text-gray-900">{fmtDate(data.filedDate)}</dd>
              {data.payRun && (<><dt className="text-gray-500">Pay run</dt><dd className="text-gray-900">{data.payRun.code}</dd></>)}
            </dl>
            {data.penaltyHint && <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">⚠ {data.penaltyHint}</div>}
            {data.waivedReason && <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">Waived: {data.waivedReason}</div>}
            {data.govtPortalUrl && <a href={data.govtPortalUrl} target="_blank" rel="noreferrer" className="inline-block text-blue-700 hover:underline">Open government portal →</a>}
            {data.proofUrl && <a href={data.proofUrl} target="_blank" rel="noreferrer" className="block text-blue-700 hover:underline">View proof →</a>}
            <div>
              <h4 className="mb-1 font-medium text-gray-700">Audit trail</h4>
              {Array.isArray(data.audit) && data.audit.length ? (
                <ul className="space-y-1 text-xs text-gray-500">
                  {data.audit.map((a, i) => <li key={i}>{a.action} · {fmtDate(a.at)}{a.actorId ? ` · ${a.actorId}` : ''}</li>)}
                </ul>
              ) : <p className="text-xs text-gray-400">No activity yet.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Schedule settings (canManageStatutory) ───────────────────────────────────
function ScheduleSettings() {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [obligations, setObligations] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get('/api/hr/payroll/entities').then((r) => {
      const list = Array.isArray(r) ? r : (r.items || []);
      setEntities(list);
      if (list[0]) setEntityId(list[0].id);
    }).catch((e) => setError(e.data?.message || e.message || 'Could not load entities — you may be missing a payroll permission.'));
  }, []);

  const load = useCallback(() => {
    if (!entityId) return;
    setError('');
    get('/api/hr/compliance/obligations', { entityId }).then((r) => setObligations(r.items || [])).catch((e) => setError(e.data?.message || e.message || 'Failed to load obligations.'));
  }, [entityId]);
  useEffect(() => { load(); }, [load]);

  const rederive = async () => {
    setBusy(true); setError('');
    try { await post('/api/hr/compliance/obligations/seed', { entityId }); load(); }
    catch (e) { setError(e.data?.message || e.message || 'Failed to re-derive.'); }
    finally { setBusy(false); }
  };

  const toggle = async (ob, field) => {
    try { await patch(`/api/hr/compliance/obligations/${ob.id}`, { [field]: !ob[field] }); load(); }
    catch (e) { setError(e.data?.message || e.message || 'Failed to update.'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4">
        <label className="text-xs">
          <span className="block font-medium text-gray-700">Entity</span>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className="mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.legalName}</option>)}
          </select>
        </label>
        <div className="ml-auto">
          <PrimaryButton onClick={rederive} loading={busy} disabled={!entityId}>Re-derive from registrations</PrimaryButton>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2">Form</th>
              <th className="px-4 py-2">State</th>
              <th className="px-4 py-2">Cadence</th>
              <th className="px-4 py-2">Reminder days</th>
              <th className="px-4 py-2">Auto-generate</th>
              <th className="px-4 py-2">Active</th>
            </tr>
          </thead>
          <tbody>
            {obligations.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No obligations — click “Re-derive from registrations”.</td></tr>
            ) : obligations.map((ob) => (
              <tr key={ob.id} className="border-b border-gray-100">
                <td className="px-4 py-2 font-medium text-gray-800">{(ob.meta && ob.meta.label) || KIND_LABEL[ob.kind] || ob.kind}</td>
                <td className="px-4 py-2 text-gray-600">{ob.stateCode || '—'}</td>
                <td className="px-4 py-2 text-gray-600">{ob.cadence}</td>
                <td className="px-4 py-2 text-gray-500">{(ob.reminderDays || []).map((d) => (d === 0 ? 'due' : `T-${d}`)).join(' · ')}</td>
                <td className="px-4 py-2"><Toggle on={ob.autoGenerate} onClick={() => toggle(ob, 'autoGenerate')} /></td>
                <td className="px-4 py-2"><Toggle on={ob.isActive} onClick={() => toggle(ob, 'isActive')} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Toggle({ on, onClick }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex h-5 w-9 items-center rounded-full transition ${on ? 'bg-emerald-500' : 'bg-gray-300'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${on ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

const KIND_LABEL = {
  IN_TDS: 'TDS deposit', IN_PF: 'EPF ECR', IN_ESI: 'ESI', IN_PT: 'Professional Tax',
  IN_LWF: 'Labour Welfare Fund', IN_FORM24Q: 'Form 24Q', IN_FORM138: 'Form 138',
  IN_FORM16: 'Form 16', IN_FORM130: 'Form 130', IN_ESI_RETURN: 'ESI return',
  IN_PF_ANNUAL: 'EPF annual', IN_GRATUITY: 'Gratuity',
};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

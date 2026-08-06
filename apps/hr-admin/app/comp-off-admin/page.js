'use client';

// Comp-off console (Feature 30) against /api/hr/comp-off/*.
//  - Queue:   GET /queue → PENDING earned credits; approve/reject (canApproveLeave).
//  - Ledger:  paginated GET /credits — every credit (earned/used/expiring/lapsed),
//             scoped to the actor's sub-tree (F1).
//  - Grant:   POST /credits — HR manual grant (HR_GRANT, canManageOrg).
//  - Runs:    POST /runs/earn | /runs/expiry — ops triggers (canManageOrg).
// AVAIL is on the Leave console (apply a COMP_OFF leave) — not here.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, TextInput } from '@hr/ui';
import { get, post, put } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel, ServerPagination } from '@/lib/ui';
import ModuleGuide from '@/components/ModuleGuide';

const TABS = [
  { key: 'queue', label: 'Approvals' },
  { key: 'ledger', label: 'Ledger' },
  { key: 'grant', label: 'Grant' },
  { key: 'settings', label: 'Settings' },
];

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return String(d).slice(0, 10); }
}
function num(v) { return v == null ? 0 : Number(v); }

export default function CompOffAdminPage() {
  const [tab, setTab] = useState('queue');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // ── Approvals queue ──
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const loadQueue = useCallback(() => {
    setQueueLoading(true);
    get('/api/hr/comp-off/queue')
      .then((res) => setQueue((res && res.credits) || asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setQueueLoading(false));
  }, []);

  // ── Ledger ──
  const [ledger, setLedger] = useState([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const loadLedger = useCallback(() => {
    setLedgerLoading(true);
    const params = { page, pageSize };
    if (statusFilter) params.status = statusFilter;
    get('/api/hr/comp-off/credits', params)
      .then((res) => { setLedger((res && res.credits) || asList(res) || []); setTotal((res && res.total) || 0); })
      .catch((e) => setError(e.message))
      .finally(() => setLedgerLoading(false));
  }, [page, pageSize, statusFilter]);

  useEffect(() => { if (tab === 'queue') loadQueue(); }, [tab, loadQueue]);
  useEffect(() => { if (tab === 'ledger') loadLedger(); }, [tab, loadLedger]);

  async function decide(id, action, reason) {
    setError(''); setNotice('');
    try {
      await post(`/api/hr/comp-off/credits/${id}/${action}`, action === 'reject' ? { reason: reason || '' } : {});
      setNotice(`Credit ${action === 'approve' ? 'approved' : 'rejected'}.`);
      loadQueue();
    } catch (e) { setError(e.message); }
  }

  async function runJob(which) {
    setError(''); setNotice('');
    try {
      const r = await post(`/api/hr/comp-off/runs/${which}`, {});
      setNotice(`${which === 'earn' ? 'Earn' : 'Expiry'} runner: ${JSON.stringify(r)}`);
      if (tab === 'queue') loadQueue(); else if (tab === 'ledger') loadLedger();
    } catch (e) { setError(e.message); }
  }

  const queueCols = useMemo(() => [
    { key: 'emp', header: 'Employee', render: (r) => employeeLabel(r.employee || {}) },
    { key: 'sourceKind', header: 'Earned for', render: (r) => String(r.sourceKind || '').replace('_', ' ').toLowerCase() },
    { key: 'sourceDate', header: 'Worked on', render: (r) => fmtDate(r.sourceDate) },
    { key: 'quantity', header: 'Days', render: (r) => num(r.quantity) },
    { key: 'expiresOn', header: 'Expires', render: (r) => fmtDate(r.expiresOn) },
    {
      key: 'actions', header: '', render: (r) => (
        <div className="flex gap-2">
          <ActionButton tone="positive" onClick={() => decide(r.id, 'approve')}>Approve</ActionButton>
          <ActionButton tone="danger" onClick={() => { const reason = prompt('Reason for rejection?'); if (reason === null) return; decide(r.id, 'reject', reason || ''); }}>Reject</ActionButton>
        </div>
      ),
    },
  ], []);

  const ledgerCols = useMemo(() => [
    { key: 'emp', header: 'Employee', render: (r) => employeeLabel(r.employee || {}) },
    { key: 'sourceKind', header: 'Source', render: (r) => String(r.sourceKind || '').replace('_', ' ').toLowerCase() },
    { key: 'sourceDate', header: 'Earned', render: (r) => fmtDate(r.sourceDate) },
    { key: 'quantity', header: 'Days', render: (r) => num(r.quantity) },
    { key: 'consumed', header: 'Used', render: (r) => num(r.consumed) },
    { key: 'remaining', header: 'Left', render: (r) => num(r.remaining) },
    { key: 'expiresOn', header: 'Expires', render: (r) => fmtDate(r.expiresOn) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '', render: (r) => (
        r.status === 'ACTIVE'
          ? <ActionButton tone="danger" onClick={() => voidCredit(r.id)}>Void</ActionButton>
          : null
      ),
    },
  ], []);

  async function voidCredit(id) {
    setError(''); setNotice('');
    try {
      await post(`/api/hr/comp-off/credits/${id}/void`, { reason: 'HR void' });
      setNotice('Credit voided.');
      loadLedger();
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Comp-off"
        subtitle="Earned compensatory-off credits — approve, grant, and track expiry. Employees avail comp-off on the Leave console."
        actions={(
          <div className="flex gap-2">
            <PrimaryButton onClick={() => runJob('earn')}>Run earn</PrimaryButton>
            <PrimaryButton onClick={() => runJob('expiry')}>Run expiry</PrimaryButton>
          </div>
        )}
      />

      <ModuleGuide
        id="comp-off-admin"
        title="Approve, grant and expire comp-off credits"
        what="Comp-off is paid time-off employees earn for working on a holiday or weekly off (e.g. weekend on-call). This console is where HR approves earned credits, manually grants them, and watches them expire — employees actually apply for comp-off leave on the Leave console."
        steps={[
          "On the Approvals tab, review each PENDING credit — check the employee, what they were earned for, and the date worked — then Approve or Reject.",
          "Use the Ledger tab to track every credit (earned/used/left/expiring/lapsed); filter by status and Void an ACTIVE credit if it was granted in error.",
          "Use the Grant tab to add a manual credit (HR_GRANT) for off-system work: enter the employee, days, an optional expiry source date, and a reason.",
          "Run earn re-scans worked holidays/weekly-offs to mint new credits; Run expiry lapses credits past their window — trigger these if the nightly job didn't.",
        ]}
        example={<>Aarav Sharma at Acme India Pvt Ltd worked a Republic-Day shift on <b>26 Jan 2026</b>, earning <b>1 day</b> of comp-off. HR approves it in the queue; it now shows ACTIVE in the ledger with <b>1 left</b> and an expiry of <b>26 Apr 2026</b>. If he hasn't availed it on the Leave console by then, Run expiry lapses it to EXPIRED.</>}
        tips={[
          "Comp-off credits expire — approve promptly so employees get the full availment window before lapse.",
          "Dates and the 'Worked on' / 'Expires' columns are in Asia/Kolkata; the en-IN format shows day-month-year.",
        ]}
      />

      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <div className="my-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div> : null}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'queue' && (
        <div className="mt-4">
          <DataTable columns={queueCols} rows={queue} loading={queueLoading} emptyText="No comp-off credits awaiting approval." rowKey={(r) => r.id} />
        </div>
      )}

      {tab === 'ledger' && (
        <div className="mt-4">
          <div className="mb-3 flex items-center gap-2">
            <label className="text-sm text-gray-600">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
            >
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING">Pending</option>
              <option value="EXHAUSTED">Used</option>
              <option value="EXPIRED">Expired</option>
              <option value="VOIDED">Voided</option>
            </select>
          </div>
          <DataTable columns={ledgerCols} rows={ledger} loading={ledgerLoading} emptyText="No comp-off credits in scope." rowKey={(r) => r.id} />
          <ServerPagination
            page={page} pageSize={pageSize} total={total} noun="credits"
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          />
        </div>
      )}

      {tab === 'grant' && <GrantForm onGranted={(msg) => { setNotice(msg); }} onError={setError} />}

      {tab === 'settings' && <SettingsForm onSaved={(msg) => { setNotice(msg); }} onError={setError} />}
    </div>
  );
}

// Comp-off config editor — loads GET /config and PUTs changes. canManageOrg is
// enforced backend-side (the route gates both GET and PUT); this is UX only.
const NUMBER_FIELDS = [
  { key: 'expiryDays', label: 'Expiry window (days)', hint: 'Days after the earned date before an unused credit lapses.' },
  { key: 'minWorkedMinutesForCredit', label: 'Min minutes worked for a credit', hint: 'Below this, a worked off-day earns nothing.' },
  { key: 'fullDayMinutes', label: 'Minutes for a full-day credit', hint: 'At/above this earns 1.0 day; below (but above the minimum) earns 0.5 when half-day is allowed.' },
  { key: 'expiryReminderDays', label: 'Expiry reminder lead (days)', hint: 'How many days ahead to flag a credit as "expiring soon".' },
];
const BOOL_FIELDS = [
  { key: 'requireApproval', label: 'Require approval for earned credits' },
  { key: 'autoEarn', label: 'Auto-earn from worked off-days' },
  { key: 'allowHalfDay', label: 'Allow half-day (0.5) credits' },
  { key: 'earnFromWeeklyOff', label: 'Earn from working a weekly-off' },
  { key: 'earnFromHoliday', label: 'Earn from working a holiday' },
  { key: 'allowEncash', label: 'Allow encashment' },
];

function SettingsForm({ onSaved, onError }) {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/comp-off/config')
      .then((res) => {
        setConfigured(!!(res && res.configured));
        setConfig((res && res.config) || null);
      })
      .catch((e) => onError(e.message))
      .finally(() => setLoading(false));
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  function setField(key, value) { setConfig((c) => ({ ...(c || {}), [key]: value })); }

  async function save(e) {
    e.preventDefault();
    onError(''); setBusy(true);
    try {
      // Send only the editable knobs; the backend merges over stored config.
      const body = {};
      for (const f of NUMBER_FIELDS) if (config[f.key] != null && config[f.key] !== '') body[f.key] = Number(config[f.key]);
      for (const f of BOOL_FIELDS) body[f.key] = config[f.key] === true;
      const res = await put('/api/hr/comp-off/config', body);
      if (res && res.config) setConfig(res.config);
      onSaved('Comp-off settings saved.');
    } catch (err) { onError(err.data?.message || err.message); } finally { setBusy(false); }
  }

  if (loading) return <div className="mt-4"><Spinner /></div>;
  if (!configured || !config) {
    return (
      <div className="mt-4 max-w-lg rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
        No comp-off leave type is configured for this company yet. Grant a comp-off credit (or run earn) to seed it, then return here to tune the knobs.
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mt-4 max-w-2xl rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {NUMBER_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="mb-1 block text-sm font-medium text-gray-700">{f.label}</label>
            <TextInput type="number" min="0" value={config[f.key] == null ? '' : config[f.key]} onChange={(v) => setField(f.key, v)} />
            <p className="mt-1 text-xs text-gray-500">{f.hint}</p>
          </div>
        ))}
      </div>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {BOOL_FIELDS.map((f) => (
          <label key={f.key} className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={config[f.key] === true} onChange={(e) => setField(f.key, e.target.checked)} />
            {f.label}
          </label>
        ))}
      </div>
      <PrimaryButton type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</PrimaryButton>
    </form>
  );
}

// HR manual grant form (HR_GRANT). canManageOrg is enforced backend-side.
function GrantForm({ onGranted, onError }) {
  const [employeeId, setEmployeeId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [sourceDate, setSourceDate] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    onError(''); setBusy(true);
    try {
      const body = { employeeId: employeeId.trim(), quantity: Number(quantity), reason: reason || undefined };
      if (sourceDate) body.sourceDate = sourceDate;
      await post('/api/hr/comp-off/credits', body);
      onGranted('Comp-off granted.');
      setEmployeeId(''); setQuantity('1'); setReason(''); setSourceDate('');
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mt-4 max-w-lg rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3">
        <label className="mb-1 block text-sm font-medium text-gray-700">Employee ID</label>
        <TextInput value={employeeId} onChange={(v) => setEmployeeId(v)} placeholder="employee uuid" />
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Days</label>
          <TextInput type="number" step="0.5" min="0.5" value={quantity} onChange={(v) => setQuantity(v)} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Custom expiry source date (optional)</label>
          <TextInput type="date" value={sourceDate} onChange={(v) => setSourceDate(v)} />
        </div>
      </div>
      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium text-gray-700">Reason</label>
        <TextInput value={reason} onChange={(v) => setReason(v)} placeholder="e.g. off-system weekend support" />
      </div>
      <PrimaryButton type="submit" disabled={busy || !employeeId.trim()}>{busy ? 'Granting…' : 'Grant comp-off'}</PrimaryButton>
    </form>
  );
}

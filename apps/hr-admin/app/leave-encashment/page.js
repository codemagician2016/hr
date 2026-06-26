'use client';

// Leave-encashment console (Feature 31) against /api/hr/leave/encashment/*.
//  - Approvals: GET /leave/encashment?status=PENDING → approve/reject (canApproveLeave).
//    Approve DEBITS the leave balance + queues a FULLY-TAXABLE payout for the next pay run.
//  - Register:  GET /leave/encashment (F1-scoped) — every request (pending/approved/paid/
//    rejected/cancelled) with the computed amount + status, for audit / §89 figures.
// Employees RAISE a request on the ESS (/me/leave/encashment) — not here.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel, moneyish } from '@/lib/ui';
import ModuleGuide from '@/components/ModuleGuide';

const TABS = [
  { key: 'queue', label: 'Approvals' },
  { key: 'register', label: 'Register' },
];

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return String(d).slice(0, 10); }
}
function num(v) { return v == null ? 0 : Number(v); }
// amountMinor (paise) → ₹ display. The amount is snapshotted at APPROVE; null until then.
function rupees(minor) { return minor == null ? '—' : moneyish(Number(minor) / 100, 'INR'); }

export default function LeaveEncashmentAdminPage() {
  const [tab, setTab] = useState('queue');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // ── Approvals queue (PENDING) ──
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const loadQueue = useCallback(() => {
    setQueueLoading(true);
    get('/api/hr/leave/encashment', { status: 'PENDING' })
      .then((res) => setQueue((res && res.items) || asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setQueueLoading(false));
  }, []);

  // ── Register (all statuses) ──
  const [register, setRegister] = useState([]);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const loadRegister = useCallback(() => {
    setRegisterLoading(true);
    const params = {};
    if (statusFilter) params.status = statusFilter;
    get('/api/hr/leave/encashment', params)
      .then((res) => setRegister((res && res.items) || asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setRegisterLoading(false));
  }, [statusFilter]);

  useEffect(() => { if (tab === 'queue') loadQueue(); }, [tab, loadQueue]);
  useEffect(() => { if (tab === 'register') loadRegister(); }, [tab, loadRegister]);

  async function decide(id, action) {
    setError(''); setNotice('');
    try {
      await post(`/api/hr/leave/encashment/${id}/${action}`, action === 'reject' ? { reason: '' } : {});
      setNotice(action === 'approve'
        ? 'Encashment approved — the leave balance is debited and the payout is queued for the next pay run (taxable).'
        : 'Encashment rejected — the leave balance is unchanged.');
      loadQueue();
    } catch (e) { setError(e.message); }
  }

  const queueCols = useMemo(() => [
    { key: 'emp', header: 'Employee', render: (r) => employeeLabel(r.employee || {}) },
    { key: 'type', header: 'Leave type', render: (r) => (r.leaveType && (r.leaveType.code || r.leaveType.name)) || '—' },
    { key: 'days', header: 'Days', render: (r) => num(r.days) },
    { key: 'period', header: 'Period', render: (r) => r.periodCode || '—' },
    { key: 'applied', header: 'Requested', render: (r) => fmtDate(r.appliedAt || r.createdAt) },
    {
      key: 'taxable', header: '', render: () => (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800" title="In-service encashment is fully taxable as salary (§17). TDS applies on payout.">Fully taxable</span>
      ),
    },
    {
      key: 'actions', header: '', render: (r) => (
        <div className="flex gap-2">
          <ActionButton tone="positive" onClick={() => decide(r.id, 'approve')}>Approve</ActionButton>
          <ActionButton tone="danger" onClick={() => decide(r.id, 'reject')}>Reject</ActionButton>
        </div>
      ),
    },
  ], []);

  const registerCols = useMemo(() => [
    { key: 'emp', header: 'Employee', render: (r) => employeeLabel(r.employee || {}) },
    { key: 'type', header: 'Type', render: (r) => (r.leaveType && (r.leaveType.code || r.leaveType.name)) || '—' },
    { key: 'days', header: 'Days', render: (r) => num(r.days) },
    { key: 'amount', header: 'Amount', render: (r) => rupees(r.amountMinor) },
    { key: 'period', header: 'Period', render: (r) => r.periodCode || '—' },
    { key: 'decided', header: 'Decided', render: (r) => fmtDate(r.decidedAt) },
    { key: 'paid', header: 'Paid', render: (r) => (r.status === 'PAID' ? rupees(r.paidAmountMinor) : '—') },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ], []);

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Leave encashment"
        subtitle="In-service leave encashment — approve requests (debits the leave balance and queues a fully-taxable payout on the next pay run) and track the register. Employees raise requests on their portal."
      />

      <ModuleGuide
        id="leave-encashment"
        title="Approve in-service leave encashment"
        what="This is where you clear employee requests to cash out unused leave while still employed. Approving debits the leave balance and queues a fully-taxable payout on the next pay run; the Register tab is your audit trail of every request and computed amount."
        steps={[
          'Open the Approvals tab to see requests awaiting your decision (employees raise these from their ESS portal — not here).',
          'Check the employee, leave type, days and the period before deciding.',
          'Click Approve to debit the leave balance and snapshot the payout amount, or Reject (the balance stays unchanged).',
          'Switch to the Register tab to track approved, paid, rejected and cancelled requests; filter by status for audit or Section 89(1) figures.',
        ]}
        example={<>Aarav Sharma at <b>Acme India Pvt Ltd</b> requests encashment of <b>10 days</b> of earned leave for period <b>JUN-2026</b>. On Approve, the amount is snapshotted (e.g. <b>₹38,460</b>), his leave balance drops by 10 days, and the payout rides the June 2026 pay run as a <b>fully-taxable</b> earning with TDS applied.</>}
        tips={[
          'In-service encashment is fully taxable as salary under §17 — the §10(10AA) exit exemption does NOT apply here.',
          'The amount is null until you approve; it is locked in at approval time, so review days and period carefully first.',
        ]}
      />

      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <div className="my-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div> : null}

      <div className="my-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        In-service leave encashment is <strong>fully taxable as salary</strong> (§17) — unlike the exit (F&amp;F)
        encashment, the §10(10AA) exemption does <strong>not</strong> apply. The payout rides the next pay run as a
        taxable earning; the employee may be eligible for Section 89(1) relief.
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'queue' ? (
        queueLoading ? <Spinner /> : (
          <DataTable columns={queueCols} rows={queue} rowKey="id" emptyText="No encashment requests awaiting approval." />
        )
      ) : null}

      {tab === 'register' ? (
        <>
          <div className="my-2 flex items-center gap-2">
            <label className="text-sm text-slate-600">Status</label>
            <select className="rounded border border-slate-300 px-2 py-1 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="PAID">Paid</option>
              <option value="REJECTED">Rejected</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          {registerLoading ? <Spinner /> : (
            <DataTable columns={registerCols} rows={register} rowKey="id" emptyText="No encashment requests yet." />
          )}
        </>
      ) : null}
    </div>
  );
}

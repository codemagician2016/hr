'use client';

// Employee loans / salary advances against /api/hr/loans (GET '/' paginated
// {items,total}). Lifecycle DRAFT → PENDING → APPROVED → DISBURSED → CLOSED
// with REJECTED/CANCELLED exits; lifecycle transitions POST to /:id/<action>.
// Reads need canViewCompensation, transitions/writes canManageCompensation.
//
// Phase 4 — the loan carries an interestMethod (FLAT / REDUCING_BALANCE / SIMPLE /
// ZERO) snapshotted from its scheme (or set directly) that drives the EMI
// amortization. The create/edit modal lets you pick it; the detail modal shows
// the method + the generated repayment schedule (REDUCING visibly tapers the
// interest component per installment). Server is the RBAC boundary — 4xx bodies
// are surfaced verbatim.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, formatAdminDate, Modal, ModalActions, PrimaryButton, TextInput, TextArea, DateField, Spinner } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, employeeLabel, moneyish, ServerPagination } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';
import ModuleGuide from '@/components/ModuleGuide';

const STATUSES = ['', 'DRAFT', 'PENDING', 'APPROVED', 'DISBURSED', 'CLOSED', 'REJECTED', 'CANCELLED'];
const PAGE_SIZES = [25, 50, 100];
const LOAN_TYPES = ['LOAN', 'ADVANCE'];

// Interest methods (mirrors prisma enum LoanInterestMethod). Each carries a
// one-line, plain-language explainer shown in the picker.
const INTEREST_METHODS = [
  { value: 'FLAT', label: 'Flat', hint: 'Flat interest on the full principal for the whole tenure.' },
  { value: 'REDUCING_BALANCE', label: 'Reducing balance', hint: 'Interest on the outstanding balance, EMI-style — interest falls each installment.' },
  { value: 'SIMPLE', label: 'Simple', hint: 'Same as flat — simple interest on the full principal.' },
  { value: 'ZERO', label: 'Zero (interest-free)', hint: 'No interest regardless of rate — repay only the principal.' },
];
const METHOD_LABEL = Object.fromEntries(INTEREST_METHODS.map((m) => [m.value, m.label]));

// Which transition buttons to show for each lifecycle state.
const NEXT_ACTIONS = {
  DRAFT: [{ action: 'submit', label: 'Submit', tone: 'neutral' }],
  PENDING: [
    { action: 'approve', label: 'Approve', tone: 'positive' },
    { action: 'reject', label: 'Reject', tone: 'danger' },
  ],
  APPROVED: [{ action: 'disburse', label: 'Disburse', tone: 'positive' }],
  DISBURSED: [{ action: 'close', label: 'Close', tone: 'neutral' }],
};

function MethodChip({ method }) {
  if (!method) return <span className="text-gray-400">—</span>;
  return (
    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-600">
      {METHOD_LABEL[method] || method}
    </span>
  );
}

// ─── Create / edit modal ─────────────────────────────────────────────────────
// A loan is only editable while DRAFT/PENDING (server enforces the 409). When a
// loan snapshots its method from a scheme the method is shown read-only.
function LoanFormModal({ loan, onClose, onSaved }) {
  const editing = !!loan;
  const schemeLocked = editing && !!loan.schemeId; // method came from a scheme snapshot

  const [employee, setEmployee] = useState(editing ? { id: loan.employeeId, ...(loan.employee || {}) } : null);
  const [loanType, setLoanType] = useState(loan?.loanType || 'LOAN');
  const [principal, setPrincipal] = useState(loan?.principal != null ? String(loan.principal) : '');
  const [tenureMonths, setTenureMonths] = useState(loan?.tenureMonths != null ? String(loan.tenureMonths) : '');
  const [interestRate, setInterestRate] = useState(loan?.interestRate != null ? String(loan.interestRate) : '');
  const [interestMethod, setInterestMethod] = useState(loan?.interestMethod || 'FLAT');
  const [startDate, setStartDate] = useState(loan?.startDate ? String(loan.startDate).slice(0, 10) : '');
  const [reason, setReason] = useState(loan?.reason || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload = {
      loanType,
      principal,
      tenureMonths,
      startDate,
      interestRate: interestRate === '' ? null : interestRate,
      interestMethod,
      reason: reason || null,
    };
    if (!editing) payload.employeeId = employee?.id || '';
    try {
      if (editing) await patch(`/api/hr/loans/${loan.id}`, payload);
      else await post('/api/hr/loans', payload);
      onSaved(editing ? 'Loan updated.' : 'Loan created as a draft.');
    } catch (err) {
      // 4xx bodies (missing fields, invalid interestMethod/loanType, out-of-state
      // edits) are user-readable — surface verbatim.
      setError(err.data?.message || err.message || 'Failed to save the loan.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? `Edit loan${loan.loanNumber ? ` — ${loan.loanNumber}` : ''}` : 'New loan'} size="lg" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}

        <div>
          <EmployeeSearchSelect
            label="Employee"
            tip="Who the loan / advance is for. Click to browse the directory, then filter by name, code or email."
            value={employee?.id || ''}
            selectedLabel={employee ? employeeLabel({ employee }) : ''}
            onSelect={(emp) => setEmployee(emp || null)}
            disabled={editing}
            required={!editing}
          />
          {editing && <p className="text-xs text-gray-500 mt-1">The borrower cannot be changed after creation.</p>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-sm font-medium text-gray-700 mb-1">Type</span>
            <select
              value={loanType}
              onChange={(e) => setLoanType(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm"
            >
              {LOAN_TYPES.map((t) => (
                <option key={t} value={t}>{t === 'LOAN' ? 'Loan' : 'Salary advance'}</option>
              ))}
            </select>
          </label>
          <TextInput
            label="Principal"
            type="number"
            min="0"
            step="0.01"
            value={principal}
            onChange={setPrincipal}
            required
            hint="Amount lent (before interest)."
          />
          <TextInput
            label="Tenure (months)"
            type="number"
            min="1"
            step="1"
            value={tenureMonths}
            onChange={setTenureMonths}
            required
            hint="Number of monthly installments."
          />
          <TextInput
            label="Interest rate (annual %)"
            type="number"
            min="0"
            step="0.01"
            value={interestRate}
            onChange={setInterestRate}
            hint="Leave blank for 0%. Ignored when the method is Zero."
          />
        </div>

        <DateField
          label="Start date"
          value={startDate}
          onChange={setStartDate}
          required
          hint="First installment falls on this date; later ones are monthly."
        />

        <fieldset>
          <legend className="flex items-center text-sm font-medium text-gray-700 mb-1">
            Interest method
            <InfoTip text="How interest is calculated across the repayment schedule. It is snapshotted onto the loan and drives the EMI amortization generated at approval." />
          </legend>
          <div className="space-y-1.5">
            {INTEREST_METHODS.map((m) => {
              const on = interestMethod === m.value;
              return (
                <label
                  key={m.value}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${schemeLocked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'} ${on ? 'bg-gray-50' : 'border-gray-200'}`}
                  style={on ? { borderColor: 'var(--theme-primary)' } : undefined}
                >
                  <input
                    type="radio"
                    name="interestMethod"
                    value={m.value}
                    checked={on}
                    onChange={() => setInterestMethod(m.value)}
                    disabled={schemeLocked}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900">{m.label}</span>
                    <span className="block text-xs text-gray-500">{m.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {schemeLocked && (
            <p className="text-xs text-gray-500 mt-1">Snapshotted from the loan scheme — change the scheme to change the method.</p>
          )}
        </fieldset>

        <TextArea label="Reason (optional)" value={reason} onChange={setReason} rows={2} maxLength={500} />

        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{editing ? 'Save changes' : 'Create loan'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ─── Detail + schedule modal ─────────────────────────────────────────────────
// Loads the full loan (installments + scheme). Shows the interest method and the
// generated amortization table (only present once the loan is APPROVED+).
function LoanDetailModal({ loanId, onClose }) {
  const [loan, setLoan] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    get(`/api/hr/loans/${loanId}`)
      .then((r) => { if (live) setLoan(r); })
      .catch((e) => { if (live) setError(e.data?.message || e.message || 'Failed to load the loan.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [loanId]);

  const installments = loan?.installments || [];
  const cur = loan?.currencyCode;

  const Field = ({ label, children }) => (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900 mt-0.5">{children}</dd>
    </div>
  );

  return (
    <Modal title={loan ? `Loan ${loan.loanNumber || loan.id.slice(0, 8)}` : 'Loan'} size="lg" onClose={onClose}>
      {loading ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : error ? (
        <ErrorBanner message={error} />
      ) : loan ? (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Field label="Employee">{employeeLabel(loan)}</Field>
            <Field label="Type">{loan.loanType || '—'}</Field>
            <Field label="Status"><StatusBadge status={loan.status} /></Field>
            <Field label="Interest method"><MethodChip method={loan.interestMethod} /></Field>
            <Field label="Interest rate">{loan.interestRate != null ? `${Number(loan.interestRate)}% p.a.` : '—'}</Field>
            <Field label="Tenure">{loan.tenureMonths} month{loan.tenureMonths === 1 ? '' : 's'}</Field>
            <Field label="Principal">{moneyish(loan.principal, cur)}</Field>
            <Field label="Total payable">{moneyish(loan.totalPayable, cur)}</Field>
            <Field label="Outstanding">{moneyish(loan.outstanding, cur)}</Field>
            <Field label="Start date">{formatAdminDate(loan.startDate)}</Field>
          </dl>

          {loan.scheme && (
            <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Interest method &amp; rate snapshotted from scheme <b>{loan.scheme.name || loan.scheme.code}</b>.
            </p>
          )}
          {loan.reason && <Field label="Reason">{loan.reason}</Field>}

          <div>
            <div className="flex items-center mb-2">
              <h4 className="text-sm font-semibold text-gray-900">Repayment schedule</h4>
              <InfoTip text="The per-installment split of principal and interest. With the Reducing balance method the interest component falls each month as the outstanding shrinks; Flat/Simple spread it evenly; Zero has no interest." />
            </div>
            {installments.length === 0 ? (
              <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-4 text-sm text-gray-500">
                The repayment schedule is generated when the loan is approved.
              </p>
            ) : (
              <div className="rounded-xl border border-gray-200 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">Due date</th>
                      <th className="px-3 py-2 font-medium text-right">Principal</th>
                      <th className="px-3 py-2 font-medium text-right">Interest</th>
                      <th className="px-3 py-2 font-medium text-right">Installment</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {installments.map((r) => (
                      <tr key={r.id || r.seq} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-2 text-gray-500">{r.seq}</td>
                        <td className="px-3 py-2 text-gray-700">{formatAdminDate(r.dueDate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">{moneyish(r.principalComponent, cur)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">{moneyish(r.interestComponent, cur)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-900">{moneyish(r.amount, cur)}</td>
                        <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

export default function LoansPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [formLoan, setFormLoan] = useState(undefined); // undefined = closed, null = create, object = edit
  const [detailId, setDetailId] = useState(null);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/loans', { status, page, pageSize })
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load loans.'))
      .finally(() => setLoading(false));
  }, [status, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id, action) {
    setBusyId(id);
    setError('');
    try {
      await post(`/api/hr/loans/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} loan.`);
    } finally {
      setBusyId('');
    }
  }

  const items = data?.items || [];
  const total = data?.total ?? items.length;

  const columns = [
    { key: 'number', header: 'Loan', render: (r) => <span className="font-medium text-gray-900">{r.loanNumber || r.id.slice(0, 8)}</span> },
    { key: 'employee', header: 'Employee', render: (r) => employeeLabel(r) },
    { key: 'type', header: 'Type', render: (r) => r.loanType || '—' },
    { key: 'method', header: 'Method', render: (r) => <MethodChip method={r.interestMethod} /> },
    { key: 'principal', header: 'Principal', render: (r) => moneyish(r.principal, r.currencyCode) },
    { key: 'outstanding', header: 'Outstanding', render: (r) => moneyish(r.outstanding, r.currencyCode) },
    { key: 'emi', header: 'EMI', render: (r) => moneyish(r.emiAmount, r.currencyCode) },
    { key: 'start', header: 'Start', render: (r) => formatAdminDate(r.startDate) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (r) => {
        const st = String(r.status || '').toUpperCase();
        const actions = NEXT_ACTIONS[st] || [];
        const editable = ['DRAFT', 'PENDING'].includes(st);
        return (
          <div className="flex gap-2 justify-end">
            <ActionButton onClick={() => setDetailId(r.id)}>View</ActionButton>
            {editable && <ActionButton onClick={() => setFormLoan(r)}>Edit</ActionButton>}
            {actions.map((a) => (
              <ActionButton key={a.action} tone={a.tone} disabled={busyId === r.id} onClick={() => act(r.id, a.action)}>
                {a.label}
              </ActionButton>
            ))}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Loans"
        subtitle="Employee loans and salary advances"
        actions={<PrimaryButton onClick={() => setFormLoan(null)}>New loan</PrimaryButton>}
      />

      <ModuleGuide
        id="loans"
        title="Track employee loans & salary advances through their lifecycle"
        what="This screen lists every employee loan and salary advance, with its principal, outstanding balance and monthly EMI. You move each one through its lifecycle (Draft → Pending → Approved → Disbursed → Closed) so the EMI is deducted from payroll and the books stay accurate. Each loan carries an interest method that decides how the repayment schedule is amortized."
        steps={[
          'Click New loan, pick the employee, principal, tenure and an interest method, then save it as a draft.',
          'Use the status filter to find the loans you care about — e.g. PENDING to see what needs your approval.',
          'On a PENDING loan, click Approve (or Reject) once you have verified the principal, tenure, rate and method — approval generates the repayment schedule.',
          'Click View on any loan to see the full amortization table; after approval, click Disburse when the money is paid out and Close once fully recovered.',
        ]}
        example={<>Aarav Sharma requests a <b>₹1,20,000</b> personal loan over 12 months on a <b>Reducing balance</b> method. After approval the View screen shows each installment&apos;s interest component <b>tapering</b> as the outstanding shrinks; payroll then deducts the EMI each month until you Close it.</>}
        tips={[
          'The interest method (Flat, Reducing balance, Simple or Zero) is snapshotted onto the loan and drives the schedule. Flat and Simple are identical; Zero ignores the rate entirely.',
          'EMI deductions only flow into payroll once the loan is DISBURSED — an Approved-but-not-disbursed loan deducts nothing.',
          'Creating, editing and actioning loans needs canManageCompensation; canViewCompensation is enough to view this list.',
        ]}
      />

      <div className="flex items-center gap-3 mb-4">
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || 'All statuses'}
            </option>
          ))}
        </select>
      </div>

      {notice && <div className="mb-3 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {error && <ErrorBanner message={error} />}

      <DataTable columns={columns} rows={items} loading={loading} emptyText="No loans match." />

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun="loans"
        onPageChange={setPage}
        onPageSizeChange={(ps) => {
          setPage(1);
          setPageSize(ps);
        }}
      />

      {formLoan !== undefined && (
        <LoanFormModal
          loan={formLoan}
          onClose={() => setFormLoan(undefined)}
          onSaved={(msg) => { setFormLoan(undefined); flash(msg); load(); }}
        />
      )}
      {detailId && <LoanDetailModal loanId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

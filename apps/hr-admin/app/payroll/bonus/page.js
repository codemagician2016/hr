'use client';

// Statutory Bonus console (Feature 22) + Labour Welfare Fund read panel (Feature 21).
//   Bonus rides the existing PayRun(type=BONUS) pipeline:
//     POST /api/hr/bonus/cycles                 create (entity, FY) — exactly-once
//     GET  /api/hr/bonus/cycles                 list (paginated)
//     GET  /api/hr/bonus/cycles/:id             header + awards + totals
//     POST /api/hr/bonus/cycles/:id/compute     eligibility + capped-base (idempotent)
//     POST /api/hr/bonus/cycles/:id/approve     maker-checker → mints PayRun(BONUS)
//     POST /api/hr/bonus/cycles/:id/publish     ESS visibility + notify employees
//     GET  /api/hr/bonus/cycles/:id/register    Form C / Form D summary
//   LWF (read-only): GET /api/hr/payroll/statutory/lwf?stateCode=&asOf=
// India-only (the server 404s a non-IN tenant).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions } from '@hr/ui';
import { get, post } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, Tabs } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';

const PAGE_SIZE = 25;
const inr = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// All states with an LWF Act (the india.js allow-list), for the LWF panel picker.
const LWF_STATES = ['MH', 'KA', 'GJ', 'TN', 'MP', 'CG', 'WB', 'AP', 'TS', 'GA', 'HR', 'PB', 'KL', 'DL', 'OR'];

export default function BonusPage() {
  const [tab, setTab] = useState('cycles');
  return (
    <div>
      <PageHeader title="Statutory Bonus" subtitle="Payment of Bonus Act 1965 — annual cycles + Labour Welfare Fund" />
      <ModuleGuide
        id="payroll-bonus"
        title="Run the annual statutory bonus & check LWF"
        what="This screen runs your Payment of Bonus Act 1965 cycle for a financial year per legal entity, and (on the second tab) shows the read-only Labour Welfare Fund rates for a state. Bonus rides the normal pay-run pipeline — it is computed, maker-checker approved into a PayRun, then published to employee slips."
        steps={[
          'On "Bonus cycles", click New bonus cycle: pick the entity, accounting year (e.g. 2025-26), and declared rate (8.33%–20%); add a monthly minimum wage only if it exceeds ₹7,000.',
          'Open the draft cycle and click Compute — it flags eligibility (Basic+DA ≤ ₹21,000/mo) and the capped base, then computes gross/net bonus per employee.',
          'Have a different approver click Approve (mint pay run) — maker-checker blocks the person who computed it from approving.',
          'Once approved/paid, click Publish slips to show bonus on ESS and notify employees; use Form C register for the statutory Form C / Form D summary.',
          'Switch to the Labour Welfare Fund tab to look up a state’s employee/employer share and deduction months as of a date.',
        ]}
        example={<>Acme India Pvt Ltd declares the minimum <b>8.33%</b> for FY <b>2025-26</b>. Aarav Sharma earns Basic+DA of ₹18,000/mo — under the ₹21,000 ceiling, so he is eligible. His base is capped at <b>₹7,000</b>, giving roughly ₹7,000 × 8.33% × 12 ≈ <b>₹7,000</b> gross bonus for the year, payable by <b>30 Nov 2026</b> (within 8 months of FY close).</>}
        tips={[
          'Bonus is India-only — the server 404s for a non-IN tenant; the calculation base is capped at ₹7,000 (or the state minimum wage, if higher), not the full salary.',
          'For Maharashtra, LWF is only deducted in June & December — check the Deduction months field before expecting it on every payslip.',
        ]}
      />
      <Tabs
        tabs={[{ key: 'cycles', label: 'Bonus cycles' }, { key: 'lwf', label: 'Labour Welfare Fund' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'cycles' ? <BonusCycles /> : <LwfPanel />}
    </div>
  );
}

// ── Bonus cycles ────────────────────────────────────────────────────────────
function BonusCycles() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/bonus/cycles', { page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load bonus cycles.'))
      .finally(() => setLoading(false));
  }, [page]);
  useEffect(() => { load(); }, [load]);

  const items = data?.items || [];

  if (openId) return <CycleDetail id={openId} onBack={() => { setOpenId(null); load(); }} />;

  const columns = [
    { key: 'fy', header: 'Accounting year', render: (r) => r.accountingYear },
    { key: 'entity', header: 'Entity', render: (r) => r.entity?.legalName || r.entity?.code || '—' },
    { key: 'rate', header: 'Rate', render: (r) => `${(r.rateBasisPoints / 100).toFixed(2)}%` },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'due', header: 'Pay by', render: (r) => (r.dueDate ? String(r.dueDate).slice(0, 10) : '—') },
    { key: 'open', header: '', render: (r) => <ActionButton onClick={() => setOpenId(r.id)}>Open</ActionButton> },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Employees earning Basic+DA ≤ ₹21,000/month are eligible; bonus is computed on the lower of their Basic+DA and ₹7,000 (or the minimum wage, if higher).
        </p>
        <PrimaryButton onClick={() => setShowNew(true)}>New bonus cycle</PrimaryButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable columns={columns} rows={items} loading={loading} emptyText="No bonus cycles yet." rowKey={(r) => r.id} />
      {showNew && <NewCycleModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
    </div>
  );
}

function NewCycleModal({ onClose, onCreated }) {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [accountingYear, setAccountingYear] = useState(defaultFY());
  const [ratePct, setRatePct] = useState('8.33');
  const [minWage, setMinWage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/payroll/entities')
      .then((res) => setEntities(res?.items || []))
      .catch((e) => setError(e.data?.message || e.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const rateBasisPoints = Math.round(parseFloat(ratePct) * 100); // 8.33% → 833bp
      const body = { entityId, accountingYear, rateBasisPoints };
      if (minWage) body.minWageMonthlyMinor = Math.round(parseFloat(minWage) * 100);
      await post('/api/hr/bonus/cycles', body);
      onCreated();
    } catch (err) {
      setError(err.data?.message || err.message);
    } finally {
      setSaving(false);
    }
  }

  const rateNum = parseFloat(ratePct);
  const valid = entityId && /^\d{4}-\d{2}$/.test(accountingYear) && rateNum >= 8.33 && rateNum <= 20;

  return (
    <Modal title="New bonus cycle" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Entity<InfoTip text="The legal entity to run statutory bonus for. India-only." /></span>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">Select entity…</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.legalName}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Accounting year<InfoTip text="The financial year, e.g. 2025-26 (Apr–Mar). Bonus is paid within 8 months of FY close." /></span>
          <input value={accountingYear} onChange={(e) => setAccountingYear(e.target.value)} placeholder="2025-26" required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Declared rate (%)<InfoTip text="8.33% minimum (payable even at a loss) to 20% maximum, driven by allocable surplus." /></span>
          <input type="number" step="0.01" min="8.33" max="20" value={ratePct} onChange={(e) => setRatePct(e.target.value)} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Minimum wage / month (₹, optional)<InfoTip text="If the scheduled-employment minimum wage exceeds ₹7,000, it raises the calculation-base cap." /></span>
          <input type="number" step="0.01" min="0" value={minWage} onChange={(e) => setMinWage(e.target.value)} placeholder="(defaults to ₹7,000 cap)" className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">Cancel</button>
          <PrimaryButton type="submit" loading={saving} disabled={!valid}>Create draft</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function CycleDetail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [register, setRegister] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    get(`/api/hr/bonus/cycles/${id}`)
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message))
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(action) {
    setBusy(true);
    setError('');
    try {
      await post(`/api/hr/bonus/cycles/${id}/${action}`, {});
      load();
    } catch (e) {
      setError(e.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  }
  async function loadRegister() {
    setBusy(true);
    try {
      const r = await get(`/api/hr/bonus/cycles/${id}/register`);
      setRegister(r);
    } catch (e) {
      setError(e.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!data) return <ErrorBanner message={error || 'Not found'} />;

  const { cycle, awards = [], totals = {} } = data;
  const cols = [
    { key: 'emp', header: 'Employee', render: (a) => `${a.employee?.code || ''} ${a.employee?.firstName || ''} ${a.employee?.lastName || ''}`.trim() || '—' },
    { key: 'basic', header: 'Basic+DA/mo', render: (a) => inr(a.monthlyBasicDaMinor) },
    { key: 'elig', header: 'Eligible?', render: (a) => (a.eligible ? <span className="text-green-700">Yes</span> : <span className="text-gray-400" title={a.ineligibleReason}>No · {prettyReason(a.ineligibleReason)}</span>) },
    { key: 'base', header: 'Capped base', render: (a) => inr(a.cappedBaseMinor) },
    { key: 'months', header: 'Months', render: (a) => Number(a.eligibleMonths).toFixed(2) },
    { key: 'gross', header: 'Gross bonus', render: (a) => inr(a.grossBonusMinor) },
    { key: 'net', header: 'Net bonus', render: (a) => inr(a.netBonusMinor) },
  ];

  return (
    <div>
      <button onClick={onBack} className="mb-3 text-sm text-gray-500 hover:text-gray-700">← Back to cycles</button>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Statutory Bonus {cycle.accountingYear}</h2>
          <p className="text-sm text-gray-500">
            Rate {(cycle.rateBasisPoints / 100).toFixed(2)}% · <StatusBadge status={cycle.status} /> · pay by {String(cycle.dueDate).slice(0, 10)}
          </p>
        </div>
        <div className="flex gap-2">
          {cycle.status === 'DRAFT' || cycle.status === 'COMPUTED' ? (
            <ActionButton disabled={busy} onClick={() => act('compute')}>Compute</ActionButton>
          ) : null}
          {cycle.status === 'COMPUTED' ? (
            <ActionButton tone="positive" disabled={busy} onClick={() => act('approve')}>Approve (mint pay run)</ActionButton>
          ) : null}
          {['APPROVED', 'PAID', 'FILED'].includes(cycle.status) ? (
            <ActionButton disabled={busy} onClick={() => act('publish')}>Publish slips</ActionButton>
          ) : null}
          <ActionButton disabled={busy} onClick={loadRegister}>Form C register</ActionButton>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {cycle.status === 'COMPUTED' && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
          Maker-checker: a different approver must approve this cycle (you cannot approve a cycle you computed).
        </p>
      )}
      <div className="mb-3 flex gap-6 text-sm text-gray-600">
        <span>Eligible: <strong>{totals.eligibleCount ?? 0}</strong></span>
        <span>Ineligible: <strong>{totals.ineligibleCount ?? 0}</strong></span>
        <span>Total net: <strong>{inr(totals.totalNetMinor)}</strong></span>
        {cycle.payRunId ? <span>Pay run: <strong>{cycle.payRunId.slice(0, 8)}…</strong></span> : null}
      </div>
      <DataTable columns={cols} rows={awards} loading={false} emptyText="No awards yet — run Compute." rowKey={(a) => a.id} />
      {register && <RegisterModal register={register} onClose={() => setRegister(null)} />}
    </div>
  );
}

function RegisterModal({ register, onClose }) {
  const s = register.formDSummary || {};
  return (
    <Modal title={`Form C / Form D — ${s.accountingYear || ''}`} onClose={onClose} size="lg">
      <div className="mb-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Rate" value={s.rate} />
        <Stat label="Eligible" value={s.eligibleCount} />
        <Stat label="Total gross" value={s.totalGross && `₹${s.totalGross}`} />
        <Stat label="Total net" value={s.totalNet && `₹${s.totalNet}`} />
      </div>
      <div className="max-h-80 overflow-auto rounded-lg border border-gray-200">
        <table className="w-full text-left text-xs">
          <thead className="bg-gray-50 text-gray-500">
            <tr><th className="px-2 py-1">Code</th><th className="px-2 py-1">Name</th><th className="px-2 py-1">Capped base</th><th className="px-2 py-1">Months</th><th className="px-2 py-1">Gross</th><th className="px-2 py-1">Net</th></tr>
          </thead>
          <tbody>
            {(register.formC || []).map((r, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="px-2 py-1">{r.employeeCode}</td>
                <td className="px-2 py-1">{r.employeeName}{!r.eligible && <span className="text-gray-400"> · {prettyReason(r.ineligibleReason)}</span>}</td>
                <td className="px-2 py-1">₹{r.cappedBase}</td>
                <td className="px-2 py-1">{r.eligibleMonths}</td>
                <td className="px-2 py-1">₹{r.grossBonus}</td>
                <td className="px-2 py-1">₹{r.netBonus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ── Labour Welfare Fund (read-only) ─────────────────────────────────────────
function LwfPanel() {
  const [stateCode, setStateCode] = useState('MH');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/payroll/statutory/lwf', { stateCode, asOf })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message))
      .finally(() => setLoading(false));
  }, [stateCode, asOf]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-3xl">
      <p className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-800">
        LWF is a flat per-head contribution; amounts are set by the State Welfare Board and only deducted in the prescribed months (e.g. June &amp; December for Maharashtra).
      </p>
      <div className="mb-4 flex gap-3">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">State</span>
          <select value={stateCode} onChange={(e) => setStateCode(e.target.value)} className="mt-1 block rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {LWF_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">As of</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="mt-1 block rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
      </div>
      {error && <ErrorBanner message={error} />}
      {loading ? <Spinner /> : (
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          {data && data.configured ? (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Employee share" value={inr(data.eeMinor)} />
              <Field label="Employer share" value={inr(data.erMinor)} />
              <Field label="Frequency" value={data.frequency} />
              <Field label="Deduction months" value={(data.deductionMonths || []).join(', ')} />
              <Field label="Manager-exclusion ceiling" value={data.mgrExclusionRupees != null ? `₹${data.mgrExclusionRupees}/mo` : 'none'} />
              <Field label="Effective from" value={data.effectiveFrom} />
            </dl>
          ) : (
            <p className="text-sm text-gray-500">No Labour Welfare Fund Act configured for {stateCode} (this state does not levy LWF).</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── small helpers ───────────────────────────────────────────────────────────
function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{value ?? <span className="text-gray-400">—</span>}</dd>
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-sm font-semibold text-gray-900">{value ?? '—'}</div>
    </div>
  );
}
function prettyReason(reason) {
  return ({
    OVER_CEILING: 'Over ₹21,000 ceiling',
    UNDER_30_DAYS: 'Worked < 30 days',
    DISQUALIFIED_S9: 'Disqualified u/s 9',
    NOT_COVERED: 'Not covered',
  })[reason] || reason || '';
}
function defaultFY() {
  // Default to the just-closed FY (Apr–Mar). If we're in Jan–Mar, the closing FY
  // is the one that started last Apr; otherwise it's the one that started this Apr − 1.
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0 = Jan
  const startY = m >= 3 ? y - 1 : y - 2; // the just-closed FY's start year
  return `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
}

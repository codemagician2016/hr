'use client';

// Settings → Payroll (Feature 42 — dynamic configurability).
//
// The tenant-facing SALARY-DAY BASIS console: for each legal entity, choose how
// a month's per-day salary rate is derived (Entity.prorationBasis):
//   CALENDAR_DAYS (default) · WORKING_DAYS · THIRTY_DAY_STANDARD ·
//   TWENTYSIX_DAY_STANDARD (the factory 26-day basis).
// The basis is applied at attendance freeze for each pay run, so changing it
// affects FUTURE runs only. WORKING_DAYS is PER-EMPLOYEE dynamic — the divisor
// comes from each employee's OWN shift weekly-offs + their location's holiday
// calendar. Saves per entity via PATCH /api/hr/org/entities/:id.
// Gated on canManageOrg (the server is the real boundary; others see read-only).
//
// Program Phase-1 additions:
//   • Pay calendars (P1.1) — CRUD over /api/hr/payroll/calendars: frequency +
//     pay-day rule + attendance-cutoff rule per entity. India entities are
//     MONTHLY-only (server 422s otherwise). Delete deactivates (never deletes)
//     once pay runs reference a calendar. canRunPayroll-gated.
//   • Payslip settings (P1.2) — GET/PATCH /api/hr/payroll/payslip-settings:
//     payslipPdfPassword NONE|DOB (DOB = DDMMYYYY, the common Indian
//     convention). canRunPayroll-gated.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, Spinner, Empty, Modal, ModalActions, PrimaryButton, TextInput } from '@hr/ui';
import { get, patch, post, del } from '@/lib/api';
import { asList, PageHeader, DataTable, ActionButton } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

// The four salary-day bases (null/unset on the entity ⇒ CALENDAR_DAYS).
const BASES = [
  {
    value: 'CALENDAR_DAYS',
    label: 'Calendar days',
    tag: '(recommended)',
    desc: 'Divisor = actual days in the month (28–31); weekends are paid; each absent day deducts salary ÷ 30/31.',
  },
  {
    value: 'WORKING_DAYS',
    label: 'Working days',
    tag: '',
    desc: "Divisor = that month's working days from each employee's OWN shift weekly-offs + holiday calendar; an absent day deducts salary ÷ working days; weekends are effectively unpaid when absent.",
  },
  {
    value: 'THIRTY_DAY_STANDARD',
    label: 'Fixed 30',
    tag: '',
    desc: 'Constant divisor of 30 every month, regardless of its length.',
  },
  {
    value: 'TWENTYSIX_DAY_STANDARD',
    label: 'Fixed 26',
    tag: '',
    desc: 'The factory basis; constant divisor of 26 every month.',
  },
];

function EntityBasisCard({ entity, canEdit, onError }) {
  // '' = unset on the entity → treated as CALENDAR_DAYS (default).
  const [value, setValue] = useState(entity.prorationBasis || '');
  const [savedValue, setSavedValue] = useState(entity.prorationBasis || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = value !== savedValue;

  async function save() {
    setSaving(true);
    setSaved(false);
    onError('');
    try {
      const row = await patch(`/api/hr/org/entities/${entity.id}`, {
        prorationBasis: value || 'CALENDAR_DAYS',
      });
      const next = row?.prorationBasis || value || 'CALENDAR_DAYS';
      setValue(next);
      setSavedValue(next);
      setSaved(true);
    } catch (e) {
      onError(e.data?.message || e.message || `Failed to save the basis for ${entity.legalName}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 truncate">{entity.legalName}</h2>
          <p className="text-xs text-gray-500">
            {entity.code}
            {entity.countryCode ? ` · ${entity.countryCode}` : ''}
            {entity.payCurrency ? ` · ${entity.payCurrency}` : ''}
          </p>
        </div>
        {saved && !dirty && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs font-medium text-emerald-700 shrink-0" role="status">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Saved
          </span>
        )}
      </div>

      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="sr-only">Salary calculation basis for {entity.legalName}</legend>
        {BASES.map((b) => {
          const checked = (value || 'CALENDAR_DAYS') === b.value;
          const isDefaultUnset = !value && b.value === 'CALENDAR_DAYS';
          return (
            <label
              key={b.value}
              className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                checked ? 'border-[color:var(--theme-primary)] bg-indigo-50/40' : 'border-gray-200 hover:bg-gray-50'
              } ${!canEdit ? 'cursor-default opacity-70' : ''}`}
            >
              <input
                type="radio"
                name={`basis-${entity.id}`}
                value={b.value}
                checked={checked}
                onChange={() => { setSaved(false); setValue(b.value); }}
                disabled={!canEdit}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900">
                  {b.label}
                  {b.tag && <span className="ml-1 text-xs font-normal text-gray-500">{b.tag}</span>}
                  {isDefaultUnset && <span className="ml-1 text-xs font-normal text-gray-400">(default)</span>}
                </span>
                <span className="block text-xs text-gray-500 mt-0.5">{b.desc}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {canEdit && (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--theme-primary)' }}
          >
            {saving ? 'Saving…' : 'Save basis'}
          </button>
          {dirty && <span className="text-xs text-amber-600">Unsaved change</span>}
        </div>
      )}
    </div>
  );
}

// ── Pay calendars (P1.1) ─────────────────────────────────────────────────────

const FREQUENCIES = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'FORTNIGHTLY', label: 'Fortnightly' },
  { value: 'SEMI_MONTHLY', label: 'Semi-monthly (twice a month)' },
];

const DAY_RULES = [
  { value: 'LAST_WORKING_DAY', label: 'Last working day' },
  { value: 'FIRST_WORKING_DAY', label: 'First working day' },
  { value: 'FIXED_DOM', label: 'Fixed day of month' },
  { value: 'N_DAYS_AFTER_PERIOD_END', label: 'N days after period end' },
];

// Rules that carry a numeric value, with their input bounds (mirror the server).
const RULE_VALUE_BOUNDS = {
  FIXED_DOM: { min: 1, max: 31, label: 'Day of month (1–31)' },
  N_DAYS_AFTER_PERIOD_END: { min: 0, max: 15, label: 'Days after period end (0–15)' },
};

function ruleSummary(rule, value) {
  switch (rule) {
    case 'LAST_WORKING_DAY': return 'Last working day';
    case 'FIRST_WORKING_DAY': return 'First working day';
    case 'FIXED_DOM': return `Day ${value ?? '—'} of the month`;
    case 'N_DAYS_AFTER_PERIOD_END': return `${value ?? '—'} day(s) after period end`;
    default: return rule || '—';
  }
}

// Day-rule select + its conditional numeric value input (FIXED_DOM / N_DAYS).
function DayRuleFields({ label, tip, rule, value, onRule, onValue }) {
  const bounds = RULE_VALUE_BOUNDS[rule];
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="block text-sm">
        <span className="flex items-center text-gray-700 font-medium">{label}<InfoTip text={tip} /></span>
        <select
          value={rule}
          onChange={(e) => { onRule(e.target.value); if (!RULE_VALUE_BOUNDS[e.target.value]) onValue(''); }}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          {DAY_RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </label>
      {bounds && (
        <TextInput
          label={bounds.label}
          type="number"
          min={bounds.min}
          max={bounds.max}
          value={value}
          onChange={onValue}
          required
        />
      )}
    </div>
  );
}

function PayCalendarModal({ entities, calendar, onClose, onSaved }) {
  const editing = !!calendar?.id;
  const [entityId, setEntityId] = useState(calendar?.entityId || '');
  const [code, setCode] = useState(calendar?.code || '');
  const [name, setName] = useState(calendar?.name || '');
  const [frequency, setFrequency] = useState(calendar?.frequency || 'MONTHLY');
  const [payDayRule, setPayDayRule] = useState(calendar?.payDayRule || 'LAST_WORKING_DAY');
  const [payDayValue, setPayDayValue] = useState(calendar?.payDayValue ?? '');
  const [cutoffDayRule, setCutoffDayRule] = useState(calendar?.cutoffDayRule || 'LAST_WORKING_DAY');
  const [cutoffDayValue, setCutoffDayValue] = useState(calendar?.cutoffDayValue ?? '');
  const [isActive, setIsActive] = useState(calendar?.isActive !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const entity = entities.find((e) => e.id === entityId) || calendar?.entity || null;
  const isIndia = entity?.countryCode === 'IN';

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const body = {
      name: name.trim(),
      frequency,
      payDayRule,
      payDayValue: RULE_VALUE_BOUNDS[payDayRule] ? Number(payDayValue) : null,
      cutoffDayRule,
      cutoffDayValue: RULE_VALUE_BOUNDS[cutoffDayRule] ? Number(cutoffDayValue) : null,
    };
    try {
      if (editing) {
        await patch(`/api/hr/payroll/calendars/${calendar.id}`, { ...body, isActive });
      } else {
        await post('/api/hr/payroll/calendars', { ...body, entityId, code: code.trim().toUpperCase() });
      }
      onSaved();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save the pay calendar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? `Edit pay calendar — ${calendar.code}` : 'New pay calendar'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <p className="text-xs text-gray-500">The pay calendar drives run periods: pay day + attendance cutoff.</p>
        <label className="block text-sm">
          <span className="flex items-center text-gray-700 font-medium">Entity<InfoTip text="The legal entity this pay schedule belongs to. Its country sets which frequencies are allowed." /></span>
          <select
            value={entityId}
            onChange={(e) => {
              setEntityId(e.target.value);
              const ent = entities.find((x) => x.id === e.target.value);
              if (ent?.countryCode === 'IN') setFrequency('MONTHLY');
            }}
            required
            disabled={editing}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
          >
            <option value="">Select entity…</option>
            {entities.map((en) => (
              <option key={en.id} value={en.id}>{en.code} — {en.legalName}{en.countryCode ? ` (${en.countryCode})` : ''}</option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label={editing ? 'Code (fixed)' : 'Code'}
            value={code}
            onChange={editing ? () => {} : (v) => setCode(v.toUpperCase())}
            required={!editing}
            placeholder="e.g. MONTHLY-IN"
            hint={editing ? 'The code cannot change once created.' : 'Short unique id, e.g. MONTHLY-IN.'}
          />
          <TextInput label="Name" value={name} onChange={setName} required placeholder="e.g. India monthly payroll" />
        </div>
        <label className="block text-sm">
          <span className="flex items-center text-gray-700 font-medium">Frequency<InfoTip text="How often this calendar pays. India entities support MONTHLY only — weekly/fortnightly unlock with multi-country payroll." /></span>
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value} disabled={isIndia && f.value !== 'MONTHLY'}>
                {f.label}{isIndia && f.value !== 'MONTHLY' ? ' — not available for India' : ''}
              </option>
            ))}
          </select>
          {isIndia && <span className="block text-xs text-gray-500 mt-1">India entities are MONTHLY-only.</span>}
        </label>
        <DayRuleFields
          label="Pay day"
          tip="When salaries are paid for each period — e.g. the last working day of the month, or a fixed date like the 1st."
          rule={payDayRule} value={payDayValue} onRule={setPayDayRule} onValue={setPayDayValue}
        />
        <DayRuleFields
          label="Attendance cutoff"
          tip="The day attendance is frozen for the run — punches/regularisations after this date fall into the NEXT period."
          rule={cutoffDayRule} value={cutoffDayValue} onRule={setCutoffDayRule} onValue={setCutoffDayValue}
        />
        {editing && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
            <InfoTip text="Inactive calendars stay for history but can't be picked for new pay runs." />
          </label>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving} disabled={!editing && (!entityId || !code.trim() || !name.trim())}>
            {editing ? 'Save calendar' : 'Create calendar'}
          </PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function PayCalendarsSection({ entities, canPayroll }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [editing, setEditing] = useState(null); // null | 'new' | calendar row
  const [notice, setNotice] = useState('');

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 5000); };

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/payroll/calendars')
      .then((res) => { setItems(res?.items || []); setRestricted(false); })
      .catch((e) => {
        if (e.status === 403) setRestricted(true);
        else setError(e.data?.message || e.message || 'Failed to load pay calendars.');
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(row) {
    if (!window.confirm(`Delete pay calendar ${row.code}? If pay runs reference it, it is deactivated instead.`)) return;
    setError('');
    try {
      const res = await del(`/api/hr/payroll/calendars/${row.id}`);
      flash(res?.deleted
        ? `Calendar ${row.code} deleted — no pay runs referenced it.`
        : res?.message || `Calendar ${row.code} deactivated — pay runs reference it, so it is kept for history.`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete the pay calendar.');
    }
  }

  const columns = [
    { key: 'entity', header: 'Entity', render: (r) => r.entity ? `${r.entity.code}${r.entity.countryCode ? ` (${r.entity.countryCode})` : ''}` : '—' },
    {
      key: 'calendar', header: 'Calendar',
      render: (r) => (
        <span>
          <span className="font-medium text-gray-900">{r.code}</span>
          <span className="block text-xs text-gray-500">{r.name}</span>
        </span>
      ),
    },
    { key: 'frequency', header: 'Frequency', render: (r) => FREQUENCIES.find((f) => f.value === r.frequency)?.label || r.frequency },
    { key: 'payDay', header: 'Pay day', render: (r) => ruleSummary(r.payDayRule, r.payDayValue) },
    { key: 'cutoff', header: 'Attendance cutoff', render: (r) => ruleSummary(r.cutoffDayRule, r.cutoffDayValue) },
    {
      key: 'active', header: 'Status',
      render: (r) => (
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${r.isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
          {r.isActive ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    ...(canPayroll ? [{
      key: 'actions', header: '',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
          <ActionButton tone="danger" onClick={() => remove(r)}>Delete</ActionButton>
        </span>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionTitle tip="The pay calendar drives run periods: pay day + attendance cutoff. Each pay run is created against one calendar.">
            Pay calendars
          </SectionTitle>
          <p className="text-xs text-gray-500 mt-0.5">When each entity pays and when attendance is cut off for the run.</p>
        </div>
        {canPayroll && !restricted && <PrimaryButton onClick={() => setEditing('new')}>New calendar</PrimaryButton>}
      </div>
      {error && <ErrorBanner message={error} />}
      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {restricted ? (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          Pay calendars require the run-payroll permission.
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={items || []}
          loading={loading}
          emptyText="No pay calendars yet — create one so pay runs know their pay day and attendance cutoff."
        />
      )}
      {editing && (
        <PayCalendarModal
          entities={entities || []}
          calendar={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); flash('Pay calendar saved.'); load(); }}
        />
      )}
    </div>
  );
}

// ── Payslip settings (P1.2) ──────────────────────────────────────────────────

const PDF_PASSWORD_MODES = [
  {
    value: 'NONE',
    label: 'No password',
    desc: 'Payslip PDFs open directly — no password prompt.',
  },
  {
    value: 'DOB',
    label: 'Date of birth (DDMMYYYY)',
    desc: "Payslip PDFs open with the employee's date of birth (DDMMYYYY) — the common Indian convention.",
  },
];

function PayslipSettingsSection({ canPayroll }) {
  const [mode, setMode] = useState(null);
  const [restricted, setRestricted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/payroll/payslip-settings')
      .then((res) => setMode(res?.payslipPdfPassword || 'NONE'))
      .catch((e) => {
        if (e.status === 403) setRestricted(true);
        else setError(e.data?.message || e.message || 'Failed to load payslip settings.');
      });
  }, []);

  async function choose(next) {
    if (next === mode || saving) return;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await patch('/api/hr/payroll/payslip-settings', { payslipPdfPassword: next });
      setMode(res?.payslipPdfPassword || next);
      setSaved(true);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to save payslip settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionTitle tip="DOB = payslip PDFs open with the employee's date of birth (DDMMYYYY) — the common Indian convention. Payslip PDFs now carry your brand colors + logo from Settings → Branding automatically.">
            Payslip settings
          </SectionTitle>
          <p className="text-xs text-gray-500 mt-0.5">PDF password protection for every payslip download (operator + employee).</p>
        </div>
        {saved && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs font-medium text-emerald-700 shrink-0" role="status">Saved</span>
        )}
      </div>
      {error && <ErrorBanner message={error} />}
      {restricted ? (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          Payslip settings require the run-payroll permission.
        </p>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          {mode == null ? (
            <div className="py-4 flex justify-center"><Spinner /></div>
          ) : (
            <fieldset className="space-y-2" disabled={!canPayroll || saving}>
              <legend className="sr-only">Payslip PDF password</legend>
              {PDF_PASSWORD_MODES.map((m) => {
                const checked = mode === m.value;
                return (
                  <label
                    key={m.value}
                    className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                      checked ? 'border-[color:var(--theme-primary)] bg-indigo-50/40' : 'border-gray-200 hover:bg-gray-50'
                    } ${!canPayroll ? 'cursor-default opacity-70' : ''}`}
                  >
                    <input
                      type="radio"
                      name="payslip-pdf-password"
                      value={m.value}
                      checked={checked}
                      onChange={() => choose(m.value)}
                      disabled={!canPayroll || saving}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900">{m.label}</span>
                      <span className="block text-xs text-gray-500 mt-0.5">{m.desc}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <p className="text-xs text-gray-400 mt-3">
            Payslip PDFs carry your brand colors + logo from Settings → Branding automatically.
          </p>
        </div>
      )}
    </div>
  );
}

export default function PayrollSettingsPage() {
  const [entities, setEntities] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canEdit, setCanEdit] = useState(true);
  const [canPayroll, setCanPayroll] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      get('/api/hr/org/entities'),
      get('/api/auth/me').catch(() => null),
    ])
      .then(([res, me]) => {
        setEntities(asList(res));
        const session = me?.user || me;
        const perms = permissionsFromSession(session);
        setCanEdit(hasPermission(perms, 'canManageOrg'));
        setCanPayroll(hasPermission(perms, 'canRunPayroll'));
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load entities.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 sm:p-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Payroll
            <InfoTip text="How a month's per-day salary rate is derived for each legal entity — the divisor used when prorating for absence or a mid-month join/exit." />
          </span>
        )}
        subtitle="Salary calculation basis per legal entity, pay calendars, and payslip settings."
      />

      <ModuleGuide
        id="settings-payroll"
        title="Pick how per-day salary is calculated"
        what="Each legal entity has a salary-day basis: the divisor that converts a monthly salary into a per-day rate for absence deductions and mid-month proration. Calendar days uses the month's real length; Working days uses each employee's own schedule; Fixed 30 / Fixed 26 use a constant divisor."
        steps={[
          'Pick a basis for each legal entity below — Calendar days is the recommended default.',
          "Choose Working days only if unpaid weekends on absence match your policy — the divisor is each employee's OWN monthly working days (shift weekly-offs + holiday calendar).",
          'Choose Fixed 26 for factory / wage-board style payrolls that always divide by 26.',
          'Click Save basis — the change applies when attendance is frozen for FUTURE pay runs.',
        ]}
        example={<>₹30,000 monthly salary, a 30-day month with 22 working days, 4 days absent → <b>Calendar days: ₹26,000</b> (30000 − 4×30000/30) · <b>Working days: ₹24,545</b> (30000 − 4×30000/22) · <b>Fixed 30: ₹26,000</b> · <b>Fixed 26: ₹25,385</b> (30000×(26−4)/26).</>}
        tips={[
          'Working days is per-employee dynamic: a 5-day-week employee and a 6-day-week employee in the same entity get different divisors for the same month.',
          'Changing the basis never rewrites frozen or past runs — it applies from the next attendance freeze onward.',
        ]}
      />

      <div className="max-w-3xl space-y-6 mt-2">
        {!canEdit && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
            You have read-only access. Changing the salary basis requires the manage-org permission.
          </p>
        )}
        {error && <ErrorBanner message={error} />}

        {/* Explainer — when and how the basis applies */}
        <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-indigo-50/60 to-white p-5 text-sm text-gray-700 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">How the basis applies</p>
          <p>
            The basis is applied <b>at attendance freeze</b> for each pay run. <b>Working days</b> is
            per-employee dynamic — the divisor comes from each employee&apos;s own shift weekly-offs
            (5-day / 6-day / any pattern) plus their location&apos;s holiday calendar for that month.
            Changing the basis affects <b>future runs only</b>; frozen and past runs keep the divisor
            they were computed with.
          </p>
        </div>

        {/* Worked example */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">
            Worked example — ₹30,000 salary · 30-day month · 22 working days · 4 days absent
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-xs text-gray-500">Calendar days</p>
              <p className="font-semibold text-gray-900">₹26,000</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Working days</p>
              <p className="font-semibold text-gray-900">₹24,545</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Fixed 30</p>
              <p className="font-semibold text-gray-900">₹26,000</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Fixed 26</p>
              <p className="font-semibold text-gray-900">₹25,385</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Fixed 26 pays 30000 × (26 − 4) / 26 = ₹25,385.</p>
        </div>

        {loading ? (
          <div className="py-16 flex justify-center"><Spinner /></div>
        ) : !entities || entities.length === 0 ? (
          <Empty text="No legal entities yet. Create one under Org first — the salary basis is set per entity." />
        ) : (
          entities.map((e) => (
            <EntityBasisCard key={e.id} entity={e} canEdit={canEdit} onError={setError} />
          ))
        )}
      </div>

      {/* Program P1.1 — pay calendars (pay day + attendance cutoff per entity). */}
      <div className="max-w-5xl mt-10">
        <PayCalendarsSection entities={entities || []} canPayroll={canPayroll} />
      </div>

      {/* Program P1.2 — tenant payslip settings (PDF password). */}
      <div className="max-w-3xl mt-10">
        <PayslipSettingsSection canPayroll={canPayroll} />
      </div>
    </div>
  );
}

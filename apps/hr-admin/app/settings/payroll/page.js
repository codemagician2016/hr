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

import { useEffect, useState } from 'react';
import { ErrorBanner, Spinner, Empty } from '@hr/ui';
import { get, patch } from '@/lib/api';
import { asList, PageHeader } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
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

export default function PayrollSettingsPage() {
  const [entities, setEntities] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canEdit, setCanEdit] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      get('/api/hr/org/entities'),
      get('/api/auth/me').catch(() => null),
    ])
      .then(([res, me]) => {
        setEntities(asList(res));
        const session = me?.user || me;
        setCanEdit(hasPermission(permissionsFromSession(session), 'canManageOrg'));
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
        subtitle="Choose the salary calculation basis (salary-day divisor) per legal entity."
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
    </div>
  );
}

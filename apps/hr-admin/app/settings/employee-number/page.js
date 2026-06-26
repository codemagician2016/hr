'use client';

// Settings → Employee number.
//
// The admin chooses the auto employee-number FORMAT: a prefix (e.g. "EMP-IN-"),
// a padding width (e.g. 4 → 0001), and the next number to issue. When an
// employee is created WITHOUT a typed code, the next number is minted from this
// scheme (atomically). A live preview shows exactly what the next employee will
// get ("Next will be: EMP-0042"). Gated on canManageCompanyProfile; India-first.
//
// Every field carries an ⓘ tooltip (FieldLabel `tip` / InfoTip).

import { useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, Spinner } from '@hr/ui';
import { get, patch } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { FieldLabel, SectionTitle, InfoTip } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

// Client-side preview that mirrors the backend `format(prefix, value, padding)`.
function previewCode(prefix, nextValue, padding) {
  const n = Number.parseInt(nextValue, 10);
  const pad = Number.parseInt(padding, 10);
  if (!Number.isFinite(n) || n < 1) return '—';
  const width = Number.isFinite(pad) && pad >= 1 ? pad : 0;
  return `${prefix || ''}${String(n).padStart(width, '0')}`;
}

export default function EmployeeNumberPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [canEdit, setCanEdit] = useState(true);

  const [prefix, setPrefix] = useState('EMP-');
  const [padding, setPadding] = useState(6);
  const [nextValue, setNextValue] = useState(1);
  const [configured, setConfigured] = useState(false);
  const [defaults, setDefaults] = useState({ prefix: 'EMP-', padding: 6 });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      get('/api/hr/company-profile/employee-number').catch((e) => { throw e; }),
      get('/api/auth/me').catch(() => null),
    ])
      .then(([scheme, me]) => {
        setPrefix(scheme.prefix ?? 'EMP-');
        setPadding(scheme.padding ?? 6);
        setNextValue(scheme.nextValue ?? 1);
        setConfigured(!!scheme.configured);
        if (scheme.defaults) setDefaults(scheme.defaults);
        const session = me?.user || me;
        setCanEdit(hasPermission(permissionsFromSession(session), 'canManageCompanyProfile'));
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load the employee-number format.'))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await patch('/api/hr/company-profile/employee-number', {
        prefix,
        padding: Number.parseInt(padding, 10),
        nextValue: Number.parseInt(nextValue, 10),
      });
      setPrefix(res.prefix);
      setPadding(res.padding);
      setNextValue(res.nextValue);
      setConfigured(!!res.configured);
      setSaved(true);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to save the employee-number format.');
    } finally {
      setSaving(false);
    }
  }

  function resetToDefault() {
    setSaved(false);
    setPrefix(defaults.prefix);
    setPadding(defaults.padding);
  }

  if (loading) {
    return (
      <div className="p-6 sm:p-8"><Spinner /></div>
    );
  }

  const ro = !canEdit;
  const preview = previewCode(prefix, nextValue, padding);

  return (
    <div className="p-6 sm:p-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Employee number
            <InfoTip text="The format used to auto-generate an employee's ID when you create them without typing one." />
          </span>
        )}
        subtitle="Choose how new employee numbers are generated."
      />

      <ModuleGuide
        id="settings-employee-number"
        title="Set your auto employee-number format"
        what="This screen defines the scheme DriftHR uses to mint an employee ID automatically whenever you add a new joiner without typing a code. A prefix, a padding width, and a running counter together produce stable, sortable codes like EMP-000042 — used across payroll, Form 16/24Q, and EPF/ESI records."
        steps={[
          'Set the Prefix — the fixed text at the start of every code (e.g. "EMP-" or "ACME-IN-").',
          'Set the Number length (padding) — how many digits to zero-pad to, so 6 gives 000042 and 4 gives 0042.',
          'Set the Next number — the next counter value to issue; bump it to continue an existing series.',
          'Check the "Next will be" live preview to confirm the exact code the next hire gets.',
          'Click Save format to lock it in (requires the company-profile permission).',
        ]}
        example={<>For <b>Acme India Pvt Ltd</b> joining 50 staff in June 2026, set Prefix <b>EMP-IN-</b>, padding <b>5</b>, Next number <b>1</b>. The first hire, <b>Aarav Sharma</b>, is auto-assigned <b>EMP-IN-00001</b>; the counter advances to 2 for the next employee.</>}
        tips={[
          'You can always type a code by hand when creating an employee to override the auto scheme.',
          'If you migrated from another HRMS and already used up to 41, set Next number to 42 so codes never collide.',
        ]}
      />

      <div className="max-w-2xl space-y-8 mt-2">
        {ro && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
            You have read-only access. Editing the employee-number format requires the company-profile permission.
          </p>
        )}
        {error && <ErrorBanner message={error} />}
        {saved && (
          <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
            Employee-number format saved.
          </p>
        )}

        {/* Live preview */}
        <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-indigo-50/60 to-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 inline-flex items-center">
            Next will be
            <InfoTip text="The exact code the next auto-numbered employee will receive." />
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">{preview}</p>
        </div>

        <section className="space-y-4">
          <SectionTitle tip="These three settings fully describe the format. The default keeps your existing EMP-000001 style.">
            Format
          </SectionTitle>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <FieldLabel tip="The fixed text at the start of every employee number. India-first example: 'EMP-IN-'. Leave it as 'EMP-' for the standard format.">Prefix</FieldLabel>
              <input
                type="text"
                value={prefix}
                onChange={(e) => { setSaved(false); setPrefix(e.target.value); }}
                maxLength={24}
                disabled={ro}
                placeholder="EMP-"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm disabled:bg-gray-50 disabled:text-gray-500"
              />
            </div>
            <div>
              <FieldLabel tip="How many digits to pad the number to. 4 → 0001, 6 → 000001. Padding keeps codes the same length so they sort neatly.">Number length (padding)</FieldLabel>
              <input
                type="number"
                min={1}
                max={12}
                value={padding}
                onChange={(e) => { setSaved(false); setPadding(e.target.value); }}
                disabled={ro}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm disabled:bg-gray-50 disabled:text-gray-500"
              />
            </div>
            <div>
              <FieldLabel tip="The next number to issue. Set this to continue an existing series (e.g. if you've already used up to 41, set it to 42).">Next number</FieldLabel>
              <input
                type="number"
                min={1}
                value={nextValue}
                onChange={(e) => { setSaved(false); setNextValue(e.target.value); }}
                disabled={ro}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm disabled:bg-gray-50 disabled:text-gray-500"
              />
            </div>
          </div>

          <p className="text-xs text-gray-500">
            When you create an employee without typing a code, we use this format and advance the number automatically.
            You can always type a code by hand to override it.
            {configured ? '' : ' This format hasn’t been customised yet — saving will lock it in.'}
          </p>
        </section>

        {!ro && (
          <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
            <PrimaryButton loading={saving} onClick={save}>Save format</PrimaryButton>
            <button
              type="button"
              onClick={resetToDefault}
              className="text-sm font-medium text-gray-600 hover:text-gray-900"
            >
              Reset to default ({defaults.prefix}{'0'.repeat(Math.max(0, (Number.parseInt(defaults.padding, 10) || 1) - 1))}1)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

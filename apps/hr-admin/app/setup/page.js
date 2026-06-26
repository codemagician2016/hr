'use client';

// Setup guide — the first thing a new tenant should open. It probes the live
// state of the workspace (country, entities, people, pay policy, payroll) and
// shows, in order, what's done and what's next — each step with a plain-English
// "what to do", a concrete example, and a deep link straight to the screen.
//
// The completion % is derived, never stored: every load re-checks the same
// endpoints the modules themselves use, so the guide can't drift out of sync.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { get } from '@/lib/api';

function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

// Each step is checked from a real endpoint. `check` receives the loaded probe
// data and returns true when the step is satisfied. Order = the path a tenant
// should follow; earlier steps unblock later ones.
const STEPS = [
  {
    key: 'country',
    title: 'Set your payroll country',
    href: '/settings/company-profile',
    cta: 'Open Company profile',
    what: 'Tells DriftHR which statutory rules to apply (tax, PF/ESI, payslip format). It is set once and locks the workspace to that country.',
    example: <>Pick <b>India 🇮🇳</b> — DriftHR then computes TDS, EPF, ESI, PT and gratuity for you automatically.</>,
    check: (d) => d.countrySet,
  },
  {
    key: 'entity',
    title: 'Add a legal entity & work locations',
    href: '/org',
    cta: 'Open Org structure',
    what: 'The registered company employees are hired under, plus the offices/sites they work at. Payslips, PF/ESI filings and registers are issued per entity.',
    example: <>Entity <b>Acme India Pvt Ltd</b> (code <b>IN-HQ</b>, INR, Asia/Kolkata) with a location <b>Bangalore HQ</b>.</>,
    check: (d) => d.entities > 0,
  },
  {
    key: 'structure',
    title: 'Add departments & designations',
    href: '/org',
    cta: 'Open Org structure',
    what: 'Departments and job titles power the reporting tree, approvals routing and team-scoped access for managers.',
    example: <>Departments like <b>Engineering</b> and <b>Operations</b>; designations like <b>Software Engineer</b>, <b>HR Manager</b>.</>,
    check: (d) => d.departments > 0,
  },
  {
    key: 'people',
    title: 'Add your people',
    href: '/people',
    cta: 'Add employees',
    what: 'Onboard employees with their entity, department, manager and join date. You can add one by one or bulk-import a CSV.',
    example: <>Add <b>Aarav Sharma</b> — Engineering, reports to the CTO, joined 1 Apr 2026 — or import everyone via Settings → Import.</>,
    check: (d) => d.people > 0,
  },
  {
    key: 'ctc',
    title: 'Create a CTC policy',
    href: '/compensation/policies',
    cta: 'Build a CTC policy',
    what: 'A reusable salary template that splits a CTC into Basic, HRA, allowances and statutory employer costs — so onboarding a hire is just "pick a policy + a number".',
    example: <>Start from the <b>India template</b>: Basic 50%, HRA 20%, special allowance balance, with EPF/ESI auto-added.</>,
    check: (d) => d.ctc > 0,
  },
  {
    key: 'payroll',
    title: 'Run your first payroll',
    href: '/payroll',
    cta: 'Go to Payroll',
    what: 'Create a pay run for the month, review the computed payslips (maker), then approve for disbursement (checker). DriftHR handles TDS, PF, ESI and net pay.',
    example: <>Run <b>June 2026</b> payroll for Acme India — review payslips, then Finance approves and disburses.</>,
    check: (d) => d.payrollRuns > 0,
  },
];

export default function SetupGuidePage() {
  const [probe, setProbe] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Every probe is independent and best-effort: a 403 (no permission) or a
    // 409 (country not set) must not blank the whole guide.
    const [ctx, entities, locations, departments, people, ctc, runs] = await Promise.all([
      get('/api/hr/country-context').then(() => true).catch(() => false),
      get('/api/hr/org/entities').then(asList).catch(() => []),
      get('/api/hr/org/locations').then(asList).catch(() => []),
      get('/api/hr/org/departments').then(asList).catch(() => []),
      get('/api/hr/employees', { pageSize: 1 }).catch(() => null),
      get('/api/hr/ctc-policies').then(asList).catch(() => []),
      get('/api/hr/payroll/runs').then(asList).catch(() => []),
    ]);
    const peopleCount = Array.isArray(people) ? people.length
      : (people?.total ?? people?.totalCount ?? asList(people).length);
    setProbe({
      countrySet: ctx === true,
      entities: entities.length,
      locations: locations.length,
      departments: departments.length,
      people: peopleCount || 0,
      ctc: ctc.length,
      payrollRuns: runs.length,
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const data = probe || {};
  const states = STEPS.map((s) => ({ ...s, done: !!(probe && s.check(data)) }));
  const doneCount = states.filter((s) => s.done).length;
  const pct = Math.round((doneCount / STEPS.length) * 100);
  const nextStep = states.find((s) => !s.done);

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Setup guide</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--theme-muted)' }}>
          Get your workspace ready to run HR &amp; payroll. Follow the steps in order — each links straight to where you do it.
        </p>
      </div>

      {/* Progress card */}
      <div className="rounded-2xl border bg-white p-5 mb-6" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="flex items-end justify-between mb-3">
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--theme-muted)' }}>Setup progress</p>
            <p className="text-3xl font-bold mt-0.5" style={{ color: 'var(--theme-text)' }}>
              {loading ? '…' : `${pct}%`}
              <span className="text-base font-medium ml-2" style={{ color: 'var(--theme-muted)' }}>
                {loading ? '' : `${doneCount} of ${STEPS.length} done`}
              </span>
            </p>
          </div>
          {!loading && nextStep && (
            <Link
              href={nextStep.href}
              className="shrink-0 inline-flex items-center px-4 py-2 text-sm font-semibold rounded-lg text-white"
              style={{ backgroundColor: 'var(--theme-primary)' }}
            >
              {pct === 0 ? 'Start setup' : 'Continue'} →
            </Link>
          )}
          {!loading && !nextStep && (
            <span className="shrink-0 inline-flex items-center px-3 py-1.5 text-sm font-semibold rounded-full"
              style={{ backgroundColor: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}>
              🎉 All set
            </span>
          )}
        </div>
        <div className="h-2 w-full rounded-full overflow-hidden" style={{ backgroundColor: 'var(--theme-primary-soft)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${loading ? 0 : pct}%`, backgroundColor: 'var(--theme-primary)' }} />
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {states.map((s, i) => (
          <div
            key={s.key}
            className="rounded-2xl border bg-white p-4 flex gap-4"
            style={{ borderColor: s.done ? 'var(--theme-primary)' : 'var(--theme-border)' }}
          >
            <div
              className="mt-0.5 h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-sm font-bold"
              style={s.done
                ? { backgroundColor: 'var(--theme-primary)', color: '#fff' }
                : { backgroundColor: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}
            >
              {s.done ? '✓' : i + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold" style={{ color: 'var(--theme-text)' }}>{s.title}</h3>
                <Link href={s.href} className="shrink-0 text-sm font-medium hover:underline" style={{ color: 'var(--theme-primary)' }}>
                  {s.done ? 'Review' : s.cta} →
                </Link>
              </div>
              <p className="text-sm mt-1 leading-relaxed" style={{ color: 'var(--theme-muted)' }}>{s.what}</p>
              <div className="mt-2 rounded-lg px-3 py-2 text-sm leading-relaxed" style={{ backgroundColor: 'var(--theme-primary-soft)', color: 'var(--theme-text)' }}>
                <span className="text-[11px] font-bold uppercase tracking-wide mr-2" style={{ color: 'var(--theme-primary)' }}>Example</span>
                {s.example}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

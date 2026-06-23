'use client';

// Feature 17 — Onboard-by-CTC wizard (the new default "Add employee" path). Three
// friendly steps:
//   1. Who       — name/email/phone/DOJ/department/designation/location/manager/code.
//   2. How much  — pick a CTC policy + enter the annual CTC → live CTC statement
//                  preview + the green/red "Basic ≥ 50% of CTC" chip. Next disabled
//                  while red.
//   3. Confirm   — read-only summary + "Create employee & assign pay" →
//                  POST /api/hr/onboard/by-ctc → redirect to people/[id].
//
// The old bare people/new form stays as "Add without pay (advanced)". On success the
// new hire shows live compensation immediately (the revision is created atomically).

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { TextInput, PrimaryButton, ErrorBanner } from '@hr/ui';
import { get, post } from '@/lib/api';
import ManagerPicker from '@/components/ManagerPicker';
import { InfoTip, FieldLabel } from '@/lib/widgets';
import CtcStatement from '../../compensation/policies/CtcStatement';

function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

function SelectField({ label, value, onChange, options, placeholder = 'Unassigned', tip }) {
  return (
    <div>
      <FieldLabel tip={tip}>{label}</FieldLabel>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white">
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name || o.title}</option>)}
      </select>
    </div>
  );
}

function Steps({ step }) {
  const labels = ['Who', 'How much', 'Confirm'];
  return (
    <div className="flex items-center gap-2 mb-6">
      {labels.map((l, i) => (
        <div key={l} className="flex items-center gap-2">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${i === step ? 'bg-[color:var(--theme-primary)] text-white' : i < step ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>{i + 1}</span>
          <span className={`text-sm ${i === step ? 'font-semibold text-gray-900' : 'text-gray-400'}`}>{l}</span>
          {i < labels.length - 1 && <span className="text-gray-300">→</span>}
        </div>
      ))}
    </div>
  );
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

function OnboardInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState(0);
  const [orgs, setOrgs] = useState({ departments: [], designations: [], locations: [] });
  const [policies, setPolicies] = useState([]);
  const [currency, setCurrency] = useState('INR');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [verdictOk, setVerdictOk] = useState(null);

  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', code: '',
    departmentId: '', designationId: '', locationId: '', managerEmployeeId: '',
    dateOfJoining: todayIso(),
    policyId: params.get('policyId') || '', ctcAnnual: '',
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    Promise.all([
      get('/api/hr/org/departments').catch(() => []),
      get('/api/hr/org/designations').catch(() => []),
      get('/api/hr/org/locations').catch(() => []),
      get('/api/hr/ctc-policies', { isActive: true }).catch(() => ({ items: [] })),
      get('/api/hr/country-context').catch(() => null),
    ]).then(([d, des, loc, pol, ctx]) => {
      setOrgs({ departments: asList(d), designations: asList(des), locations: asList(loc) });
      setPolicies(asList(pol));
      if (ctx) setCurrency(ctx.currency || ctx.currencyCode || 'INR');
    });
  }, []);

  const selectedPolicy = policies.find((p) => p.id === form.policyId);
  const ctcNum = Number(form.ctcAnnual);
  const previewBody = form.policyId && ctcNum > 0 ? { ctcAnnual: ctcNum, asOf: form.dateOfJoining } : null;
  const previewPath = form.policyId ? `/api/hr/ctc-policies/${form.policyId}/preview` : null;

  const canStep0 = form.firstName && form.lastName && form.dateOfJoining;
  const canStep1 = form.policyId && ctcNum > 0 && verdictOk !== false;

  async function submit() {
    setError(''); setSaving(true);
    try {
      const person = {
        firstName: form.firstName, lastName: form.lastName,
        email: form.email || undefined, phone: form.phone || undefined, code: form.code || undefined,
        departmentId: form.departmentId || undefined, designationId: form.designationId || undefined,
        locationId: form.locationId || undefined, managerEmployeeId: form.managerEmployeeId || undefined,
      };
      const res = await post('/api/hr/onboard/by-ctc', { person, policyId: form.policyId, ctcAnnual: ctcNum, dateOfJoining: form.dateOfJoining });
      const id = res?.employee?.id;
      router.replace(id ? `/people/${id}` : '/people');
    } catch (e) {
      const code = e.data?.error;
      const msg = code === 'WAGE_RULE'
        ? 'Basic is below 50% of CTC — pick a policy with a higher Basic or raise the CTC.'
        : code === 'STRUCTURE_INFEASIBLE'
          ? 'These components add up to more than the CTC — pick a policy with an Auto-balance line or raise the CTC.'
          : (e.data?.message || e.message || 'Could not onboard this employee.');
      setError(msg); setSaving(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <Link href="/people" className="text-sm text-gray-500 hover:underline">← Back to People</Link>
      <h1 className="text-2xl font-semibold text-gray-900 mt-2 mb-1">Onboard by CTC</h1>
      <p className="text-sm text-gray-500 mb-6">Add a new hire and assign their pay in one go.
        <Link href="/people/new" className="ml-2 text-[color:var(--theme-primary)] hover:underline">Add without pay (advanced) →</Link>
      </p>

      <Steps step={step} />
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      {step === 0 && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <TextInput label={<>First name <InfoTip text="The employee's legal first name." /></>} value={form.firstName} onChange={(v) => set('firstName', v)} required />
            <TextInput label={<>Last name <InfoTip text="The employee's legal surname." /></>} value={form.lastName} onChange={(v) => set('lastName', v)} required />
            <TextInput label={<>Email <InfoTip text="Work email — used for self-service (ESS) login." /></>} type="email" value={form.email} onChange={(v) => set('email', v)} />
            <TextInput label={<>Phone <InfoTip text="Contact mobile number (optional)." /></>} value={form.phone} onChange={(v) => set('phone', v)} />
            <TextInput label={<>Employee code <InfoTip text="Leave blank to auto-generate the next number." /></>} value={form.code} onChange={(v) => set('code', v)} />
            <div>
              <FieldLabel tip="Their first working day; pay is effective from here.">Date of joining</FieldLabel>
              <input type="date" min={todayIso()} value={form.dateOfJoining} onChange={(e) => set('dateOfJoining', e.target.value)} className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <SelectField label="Department" tip="The team this person joins." value={form.departmentId} onChange={(v) => set('departmentId', v)} options={orgs.departments} />
            <SelectField label="Designation" tip="The job title / role." value={form.designationId} onChange={(v) => set('designationId', v)} options={orgs.designations} />
            <SelectField label="Location" tip="The office or site." value={form.locationId} onChange={(v) => set('locationId', v)} options={orgs.locations} />
            <ManagerPicker value={form.managerEmployeeId} onChange={(v) => set('managerEmployeeId', v)} hint="Who this employee reports to." />
          </div>
          <div className="flex justify-end">
            <PrimaryButton onClick={() => setStep(1)} disabled={!canStep0}>Next: How much</PrimaryButton>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <FieldLabel tip="The salary template that decides how the CTC splits into Basic, HRA, allowances and statutory costs.">CTC policy</FieldLabel>
              <select value={form.policyId} onChange={(e) => set('policyId', e.target.value)} className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white">
                <option value="">Pick a policy…</option>
                {policies.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
              </select>
              {policies.length === 0 && <p className="text-xs text-gray-400 mt-1">No policies yet. <Link href="/compensation/policies" className="text-[color:var(--theme-primary)] hover:underline">Create one →</Link></p>}
            </div>
            <div>
              <FieldLabel tip="The total annual cost to company. The policy splits this automatically.">Annual CTC ({currency})</FieldLabel>
              <input type="number" min="0" step="1000" value={form.ctcAnnual} onChange={(e) => set('ctcAnnual', e.target.value)} className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-right" placeholder="e.g. 1800000" />
              {ctcNum > 0 && <p className="text-xs text-gray-400 mt-1">₹{ctcNum.toLocaleString('en-IN')} / year</p>}
            </div>
            <div className="flex justify-between">
              <button onClick={() => setStep(0)} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <PrimaryButton onClick={() => setStep(2)} disabled={!canStep1}>Next: Confirm</PrimaryButton>
            </div>
            {verdictOk === false && <p className="text-xs text-red-600">Basic is below 50% of CTC — pick a policy with a higher Basic or raise the CTC.</p>}
          </div>
          <div>
            <CtcStatement previewPath={previewPath} previewBody={previewBody} currency={currency} onVerdict={(v) => setVerdictOk(v ? v.ok : null)} />
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-2 text-sm">
              <Row k="Name" v={`${form.firstName} ${form.lastName}`} />
              {form.email && <Row k="Email" v={form.email} />}
              <Row k="Date of joining" v={form.dateOfJoining} />
              <Row k="CTC policy" v={selectedPolicy ? `${selectedPolicy.name}` : '—'} />
              <Row k="Annual CTC" v={`₹${ctcNum.toLocaleString('en-IN')}`} />
            </div>
            <div className="flex justify-between">
              <button onClick={() => setStep(1)} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <PrimaryButton onClick={submit} loading={saving} disabled={verdictOk === false}>Create employee &amp; assign pay</PrimaryButton>
            </div>
          </div>
          <div>
            <CtcStatement previewPath={previewPath} previewBody={previewBody} currency={currency} onVerdict={(v) => setVerdictOk(v ? v.ok : null)} />
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{k}</span>
      <span className="font-medium text-gray-900">{v}</span>
    </div>
  );
}

export default function OnboardByCtcPage() {
  return (
    <Suspense fallback={<div className="max-w-4xl text-sm text-gray-400">Loading…</div>}>
      <OnboardInner />
    </Suspense>
  );
}

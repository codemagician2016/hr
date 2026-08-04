'use client';

// Create employee: POST /api/hr/employees with code/firstName/lastName plus
// key employment fields. Department/designation/location options are loaded
// from /api/hr/org/* so the operator picks real records rather than typing
// free text. On success we route to the new employee's detail page.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TextInput, PrimaryButton, ErrorBanner } from '@hr/ui';
import { get, post } from '@/lib/api';
import ManagerPicker from '@/components/ManagerPicker';
import ModuleGuide from '@/components/ModuleGuide';
import { InfoTip, FieldLabel } from '@/lib/widgets';

function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

function SelectField({ label, value, onChange, options, placeholder = 'Unassigned', hint, tip }) {
  return (
    <div>
      <FieldLabel tip={tip}>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)] text-sm bg-white"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          // Designations expose `title`; departments/locations expose `name`.
          <option key={o.id} value={o.id}>
            {o.name || o.title}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

export default function NewEmployeePage() {
  const router = useRouter();
  const [form, setForm] = useState({
    code: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    departmentId: '',
    designationId: '',
    locationId: '',
    managerEmployeeId: '',
    dateOfJoining: '',
  });
  const [orgs, setOrgs] = useState({ departments: [], designations: [], locations: [] });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function set(key, val) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  useEffect(() => {
    let alive = true;
    Promise.all([
      get('/api/hr/org/departments').catch(() => []),
      get('/api/hr/org/designations').catch(() => []),
      get('/api/hr/org/locations').catch(() => []),
    ]).then(([departments, designations, locations]) => {
      if (!alive) return;
      setOrgs({
        departments: asList(departments),
        designations: asList(designations),
        locations: asList(locations),
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      // Drop empty optional fields so the backend applies its own defaults.
      const payload = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
      const created = await post('/api/hr/employees', payload);
      const id = created?.id || created?.employee?.id;
      router.replace(id ? `/people/${id}` : '/people');
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to create employee.');
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <Link href="/people" className="text-sm text-gray-500 hover:underline">
        ← Back to People
      </Link>
      <h1 className="text-2xl font-semibold text-gray-900 mt-2 mb-6">Add employee</h1>

      <ModuleGuide
        id="people-new"
        title="Adding your first employees"
        what="This creates the person's core record — who they are, where they sit in the org, and who they report to. Pay is deliberately NOT set here: you attach a salary separately once the record exists, so hiring someone never depends on their compensation being finalised. If you're bringing over an existing workforce, import a spreadsheet instead of typing everyone in one at a time."
        steps={[
          'Leave Employee code blank to auto-generate the next number in your series — only type one if you are matching codes from your old system.',
          'Enter their legal first and last name exactly as it should appear on payslips and letters.',
          'Add their work email — this becomes their employee self-service (ESS) login, so they can see payslips and apply for leave.',
          'Pick department, designation and location from the dropdowns. If they are empty, set up your org structure first.',
          'Choose their manager — this builds the reporting tree that routes leave and expense approvals.',
          'Set the joining date accurately: leave accrual, probation and payroll all count from it.',
        ]}
        example={<>Adding <b>Aarav Sharma</b>, joining <b>1 Apr 2026</b> as a <b>Software Engineer</b> in <b>Engineering</b> at <b>Bengaluru HQ</b>, reporting to <b>Meera Iyer</b>. Leave the code blank and he becomes <b>EMP-000042</b> automatically. His salary is attached afterwards from his profile.</>}
        tips={[
          'Adding a whole team? Settings → Import takes a CSV and creates everyone in one pass.',
          'The joining date drives leave accrual and the first payroll — a wrong date here shows up as wrong leave balances later.',
          'No departments or designations in the dropdowns yet? Add them under People & Org first, then come back.',
          'You can edit everything here later. The one field worth getting right first time is the employee code, since it appears on payslips and statutory filings.',
        ]}
      />

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <TextInput label={<>Employee code <InfoTip text="A unique ID for this person (e.g. EMP-000123). Leave blank to auto-generate the next number in the series." /></>} value={form.code} onChange={(v) => set('code', v)} required />
          <div />
          <TextInput label={<>First name <InfoTip text="The employee's legal first/given name as it should appear on letters and payslips." /></>} value={form.firstName} onChange={(v) => set('firstName', v)} required />
          <TextInput label={<>Last name <InfoTip text="The employee's legal surname/family name." /></>} value={form.lastName} onChange={(v) => set('lastName', v)} required />
          <TextInput label={<>Email <InfoTip text="Work email — used for the employee's self-service (ESS) login and notifications." /></>} type="email" value={form.email} onChange={(v) => set('email', v)} />
          <TextInput label={<>Phone <InfoTip text="Contact mobile number. Optional, but handy for HR to reach the employee." /></>} value={form.phone} onChange={(v) => set('phone', v)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label="Department"
            tip="The team or function this person joins (e.g. Engineering, Sales). Drives org-chart and reporting rollups."
            value={form.departmentId}
            onChange={(v) => set('departmentId', v)}
            options={orgs.departments}
            hint="Recorded as the employee's starting department."
          />
          <SelectField
            label="Designation"
            tip="The job title / role (e.g. Software Engineer, Accountant)."
            value={form.designationId}
            onChange={(v) => set('designationId', v)}
            options={orgs.designations}
          />
          <SelectField
            label="Location"
            tip="The office or site this employee is based at. Used for holidays and statutory rules."
            value={form.locationId}
            onChange={(v) => set('locationId', v)}
            options={orgs.locations}
          />
          <ManagerPicker
            value={form.managerEmployeeId}
            onChange={(v) => set('managerEmployeeId', v)}
            hint="Who this employee reports to. Leave empty for the top of the chain."
          />
          <div>
            <FieldLabel tip="The employee's first working day. Drives probation, leave accrual and tenure calculations.">Date of joining</FieldLabel>
            <input
              type="date"
              value={form.dateOfJoining}
              onChange={(e) => set('dateOfJoining', e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)] text-sm"
            />
          </div>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="flex gap-2">
          <PrimaryButton type="submit" loading={saving}>
            Create employee
          </PrimaryButton>
          <Link
            href="/people"
            className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

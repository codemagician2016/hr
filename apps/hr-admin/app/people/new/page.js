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

function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)] text-sm bg-white"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
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

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <TextInput label="Employee code" value={form.code} onChange={(v) => set('code', v)} required />
          <div />
          <TextInput label="First name" value={form.firstName} onChange={(v) => set('firstName', v)} required />
          <TextInput label="Last name" value={form.lastName} onChange={(v) => set('lastName', v)} required />
          <TextInput label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} />
          <TextInput label="Phone" value={form.phone} onChange={(v) => set('phone', v)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label="Department"
            value={form.departmentId}
            onChange={(v) => set('departmentId', v)}
            options={orgs.departments}
          />
          <SelectField
            label="Designation"
            value={form.designationId}
            onChange={(v) => set('designationId', v)}
            options={orgs.designations}
          />
          <SelectField
            label="Location"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Date of joining</label>
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

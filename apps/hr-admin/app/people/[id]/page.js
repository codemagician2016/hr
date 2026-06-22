'use client';

// Employee detail: GET /api/hr/employees/:id. Read-only profile view with
// the key HR fields grouped into sections. Edit is wired via PATCH from the
// list/new flows; this page focuses on a clean profile read.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Spinner, ErrorBanner, PrimaryButton, formatAdminDate } from '@hr/ui';
import { get, patch } from '@/lib/api';
import ManagerPicker from '@/components/ManagerPicker';

function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900 mt-0.5">{value || '—'}</dd>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-4">{title}</h2>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">{children}</dl>
    </div>
  );
}

// Editable "reports to" section. PATCHes managerEmployeeId via the existing
// update endpoint. The backend cycle-guard 400 ("reporting loop") surfaces here.
function ManagerSection({ employee }) {
  const [managerId, setManagerId] = useState(employee.managerEmployeeId || '');
  const [managerLabel, setManagerLabel] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // Resolve the current manager's display name for the picker's pre-selection.
  useEffect(() => {
    let alive = true;
    if (employee.managerEmployeeId) {
      get(`/api/hr/employees/${employee.managerEmployeeId}`)
        .then((m) => {
          if (!alive) return;
          const mm = m?.employee || m;
          setManagerLabel([mm.firstName, mm.lastName].filter(Boolean).join(' ') || mm.code || '');
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [employee.managerEmployeeId]);

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await patch(`/api/hr/employees/${employee.id}`, { managerEmployeeId: managerId || null });
      setSaved(true);
      setDirty(false);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to update manager.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-4">Reporting</h2>
      <div className="max-w-md space-y-3">
        <ManagerPicker
          value={managerId}
          selectedLabel={managerLabel}
          excludeId={employee.id}
          onChange={(v) => {
            setManagerId(v);
            setDirty(true);
            setSaved(false);
          }}
          hint="Who this employee reports to. Leave empty for the top of the chain."
        />
        {error && <ErrorBanner message={error} />}
        {saved && <p className="text-sm text-emerald-700">Manager updated.</p>}
        {dirty && (
          <PrimaryButton loading={saving} onClick={save}>
            Save manager
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

export default function EmployeeDetailPage() {
  const { id } = useParams();
  const [emp, setEmp] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    get(`/api/hr/employees/${id}`)
      .then((res) => {
        if (alive) setEmp(res?.employee || res);
      })
      .catch((err) => {
        if (alive) setError(err.message || 'Failed to load employee.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  if (!emp) return null;

  const fullName = [emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/people" className="text-sm text-gray-500 hover:underline">
          ← Back to People
        </Link>
        <div className="flex items-center gap-3 mt-2">
          <span
            className="inline-flex h-12 w-12 items-center justify-center rounded-full text-white text-lg font-semibold"
            style={{ backgroundColor: 'var(--theme-primary)' }}
          >
            {(emp.firstName || emp.code || '?').slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{fullName}</h1>
            <p className="text-sm text-gray-500">
              {emp.code} · {emp.status || 'unknown'}
            </p>
          </div>
        </div>
      </div>

      <Section title="Profile">
        <Field label="First name" value={emp.firstName} />
        <Field label="Last name" value={emp.lastName} />
        <Field label="Employee code" value={emp.code} />
        <Field label="Email" value={emp.email} />
        <Field label="Phone" value={emp.phone} />
        <Field label="Status" value={emp.status} />
      </Section>

      <Section title="Employment">
        <Field label="Department" value={emp.department?.name || emp.departmentName} />
        <Field label="Designation" value={emp.designation?.name || emp.designationName} />
        <Field label="Location" value={emp.location?.name || emp.locationName} />
        <Field label="Grade" value={emp.grade?.name || emp.gradeName} />
        <Field label="Band" value={emp.band?.name || emp.bandName} />
        <Field
          label="Date of joining"
          value={emp.joinedAt || emp.dateOfJoining ? formatAdminDate(emp.joinedAt || emp.dateOfJoining) : null}
        />
      </Section>

      <ManagerSection employee={emp} />
    </div>
  );
}

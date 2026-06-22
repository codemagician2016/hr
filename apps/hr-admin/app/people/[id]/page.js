'use client';

// Employee detail: GET /api/hr/employees/:id. Read-only profile view with
// the key HR fields grouped into sections. Edit is wired via PATCH from the
// list/new flows; this page focuses on a clean profile read.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Spinner, ErrorBanner, formatAdminDate } from '@hr/ui';
import { get } from '@/lib/api';

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
    </div>
  );
}

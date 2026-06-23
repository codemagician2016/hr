'use client';

// Profile — reads the customer session from /api/customer/me (provided by
// AppShell via useSession) and shows the employee's details. Includes a
// sign-out action.

import { useRouter } from 'next/navigation';
import AppShell, { useSession } from '@/components/AppShell';
import { useTenant } from '@/components/TenantProvider';
import { apiPost } from '@/lib/api';

function Field({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-center justify-between border-b py-3 text-sm last:border-b-0"
         style={{ borderColor: 'var(--theme-border)' }}>
      <span style={{ color: 'var(--theme-muted)' }}>{label}</span>
      <span className="font-medium text-right" style={{ color: 'var(--theme-text)' }}>{value}</span>
    </div>
  );
}

function ProfileInner() {
  const router = useRouter();
  const me = useSession();
  const { tenant } = useTenant();
  const emp = me?.employee || me?.customer || me || {};
  const fullName = emp.name || [emp.firstName, emp.lastName].filter(Boolean).join(' ') || 'Employee';

  async function signOut() {
    try { await apiPost('/api/customer/logout', {}); } catch { /* best effort */ }
    router.replace('/login');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Personal Information</h1>

      <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-bold"
               style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
            {fullName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>{fullName}</h2>
            {emp.designation && (
              <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
                {emp.designation?.name || emp.designation}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 border-t pt-1" style={{ borderColor: 'var(--theme-border)' }}>
          <Field label="Employee code" value={emp.employeeCode || emp.code} />
          <Field label="Email" value={emp.email} />
          <Field label="Phone" value={emp.phone || emp.mobile} />
          <Field label="Department" value={emp.department?.name || emp.departmentName || emp.department} />
          <Field label="Designation" value={emp.designation?.name || emp.designationName || emp.designation} />
          <Field label="Location" value={emp.location?.name || emp.locationName || emp.location} />
          <Field label="Date of joining" value={emp.dateOfJoining || emp.joinedAt} />
          <Field label="Company" value={tenant?.business?.name || tenant?.business?.displayName} />
        </div>
      </section>

      <button
        onClick={signOut}
        className="rounded-lg border px-5 py-2.5 text-sm font-semibold"
        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-primary)' }}
      >
        Sign out
      </button>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <AppShell>
      <ProfileInner />
    </AppShell>
  );
}

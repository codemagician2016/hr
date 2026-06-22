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
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-bold"
             style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
          {fullName.charAt(0).toUpperCase()}
        </div>
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>{fullName}</h1>
          {emp.designation && (
            <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>{emp.designation}</p>
          )}
        </div>
      </div>

      <section className="rounded-2xl border bg-white px-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <Field label="Employee code" value={emp.employeeCode || emp.code} />
        <Field label="Email" value={emp.email} />
        <Field label="Phone" value={emp.phone || emp.mobile} />
        <Field label="Department" value={emp.department?.name || emp.departmentName || emp.department} />
        <Field label="Designation" value={emp.designation?.name || emp.designationName || emp.designation} />
        <Field label="Location" value={emp.location?.name || emp.locationName || emp.location} />
        <Field label="Date of joining" value={emp.dateOfJoining || emp.joinedAt} />
        <Field label="Company" value={tenant?.business?.name || tenant?.business?.displayName} />
      </section>

      <button
        onClick={signOut}
        className="w-full rounded-lg border py-2.5 text-sm font-semibold"
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

'use client';

// Profile — the employee's personal information. The bare customer session
// (/api/customer/me) carries only name + email, so the page previously showed
// blanks for code/phone/dept/designation/location/DOJ (audit #58). It now reads
// the rich profile from /api/hr/me/profile (resolved server-side from the
// session) and renders those fields, degrading to the session name/email while
// loading or when no employee record resolves. Includes a sign-out action.

import { useRouter } from 'next/navigation';
import AppShell, { useSession } from '@/components/AppShell';
import { useTenant } from '@/components/TenantProvider';
import { Spinner, Centered } from '@hr/ui';
import { apiPost } from '@/lib/api';
import { useProfile } from '@/lib/useProfile';
import { formatDate } from '@/lib/format';

function Field({ label, value }) {
  const empty = value == null || value === '';
  return (
    <div className="flex items-center justify-between border-b py-3 text-sm last:border-b-0"
         style={{ borderColor: 'var(--theme-border)' }}>
      <span style={{ color: 'var(--theme-muted)' }}>{label}</span>
      <span className="font-medium text-right" style={{ color: empty ? 'var(--theme-muted)' : 'var(--theme-text)' }}>
        {empty ? '—' : value}
      </span>
    </div>
  );
}

function ProfileInner() {
  const router = useRouter();
  const me = useSession();
  const { tenant } = useTenant();
  const { profile, loading } = useProfile();

  // Session is the fallback for name/email so the header renders immediately
  // (before the profile fetch resolves) and even if it cannot be resolved.
  const sessionEmp = me?.employee || me?.customer || me || {};
  const fullName =
    profile?.name ||
    sessionEmp.name ||
    [sessionEmp.firstName, sessionEmp.lastName].filter(Boolean).join(' ') ||
    'Employee';
  const email = profile?.email || sessionEmp.email || null;
  const avatarUrl = profile?.photoUrl || sessionEmp.avatarUrl || null;
  const businessName = tenant?.business?.name || tenant?.business?.displayName;

  async function signOut() {
    try { await apiPost('/api/customer/logout', {}); } catch { /* best effort */ }
    router.replace('/login');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Personal Information</h1>

      <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl text-2xl font-bold"
               style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              fullName.charAt(0).toUpperCase()
            )}
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>{fullName}</h2>
            {profile?.designation && (
              <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>{profile.designation}</p>
            )}
          </div>
        </div>

        {loading && !profile ? (
          <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--theme-border)' }}>
            <Centered><Spinner small /></Centered>
          </div>
        ) : (
          <div className="mt-4 border-t pt-1" style={{ borderColor: 'var(--theme-border)' }}>
            <Field label="Employee code" value={profile?.employeeCode} />
            <Field label="Email" value={email} />
            <Field label="Phone" value={profile?.phone} />
            <Field label="Department" value={profile?.department} />
            <Field label="Designation" value={profile?.designation} />
            <Field label="Location" value={profile?.location} />
            <Field label="Date of joining" value={profile?.dateOfJoining ? formatDate(profile.dateOfJoining) : null} />
            <Field label="Company" value={profile?.entity || businessName} />
          </div>
        )}
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

'use client';

// Employee dashboard — greeting + quick tiles. Wrapped in AppShell (branded
// header, bottom nav, session guard). The greeting reads the customer session
// from /api/customer/me (via AppShell's useSession).

import Link from 'next/link';
import AppShell, { useSession } from '@/components/AppShell';
import { useTenant } from '@/components/TenantProvider';

const TILES = [
  { href: '/payslips', title: 'Payslips', sub: 'View & download', icon: 'M6 2h9l5 5v15H6zM15 2v5h5' },
  { href: '/leave', title: 'Leave', sub: 'Apply & balances', icon: 'M7 3v4M17 3v4M3 9h18M5 5h14v16H5z' },
  { href: '/profile', title: 'Profile', sub: 'Your details', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0' },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function DashboardInner() {
  const me = useSession();
  const { tenant } = useTenant();
  const employee = me?.employee || me?.customer || me || {};
  const firstName = employee.firstName || (employee.name || '').split(' ')[0] || 'there';
  const businessName = tenant?.business?.name || tenant?.business?.displayName;

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>{greeting()},</p>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>
          {firstName}
        </h1>
        {businessName && (
          <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>{businessName}</p>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3">
        {TILES.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="rounded-2xl border bg-white p-4 shadow-sm transition active:scale-[0.98]"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            <div
              className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={t.icon} />
              </svg>
            </div>
            <div className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{t.title}</div>
            <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>{t.sub}</div>
          </Link>
        ))}
      </section>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AppShell>
      <DashboardInner />
    </AppShell>
  );
}

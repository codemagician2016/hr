'use client';

// Employee dashboard — greeting + at-a-glance cards (next payday, leave balance,
// latest payslip, pending tasks) + quick navigation tiles. Wrapped in AppShell
// (branded header, bottom nav, session guard). Reads the customer session via
// useSession and live data from the real endpoints where they exist, degrading
// any not-yet-deployed route (404) to a quiet placeholder so the page always
// renders branded and shippable.

import Link from 'next/link';
import { useMemo } from 'react';
import AppShell, { useSession } from '@/components/AppShell';
import { useTenant } from '@/components/TenantProvider';
import { useApi } from '@/lib/useApi';
import { money, formatPeriod, formatDate, employeeIdOf } from '@/lib/format';

const TILES = [
  { href: '/payslips', title: 'Payslips', sub: 'View & download', icon: 'M6 2h9l5 5v15H6zM15 2v5h5' },
  { href: '/compensation', title: 'Compensation', sub: 'CTC breakup', icon: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6' },
  { href: '/attendance', title: 'Attendance', sub: 'Clock in / out', icon: 'M12 8v4l3 2M12 3a9 9 0 100 18 9 9 0 000-18z' },
  { href: '/leave', title: 'Leave', sub: 'Apply & balances', icon: 'M7 3v4M17 3v4M3 9h18M5 5h14v16H5z' },
  { href: '/tax', title: 'Tax', sub: 'Declaration', icon: 'M9 7h6M9 11h6M9 15h4M6 3h12v18H6z' },
  { href: '/documents', title: 'Documents', sub: 'Your files', icon: 'M6 2h9l5 5v15H6zM15 2v5h5' },
  { href: '/profile', title: 'Profile', sub: 'Your details', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0' },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function StatCard({ label, value, sub, href }) {
  const inner = (
    <div className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>{label}</div>
      {/* Ink, not teal: brand teal on white fails WCAG AA contrast for this size. */}
      <div className="mt-1 text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>{value}</div>
      {sub && <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block active:scale-[0.99]">{inner}</Link> : inner;
}

function DashboardInner() {
  const me = useSession();
  const { tenant } = useTenant();
  const employee = me?.employee || me?.customer || me || {};
  const firstName = employee.firstName || (employee.name || '').split(' ')[0] || 'there';
  const businessName = tenant?.business?.name || tenant?.business?.displayName;
  const empId = employeeIdOf(me);

  // Latest payslip (first item of the employee's own payslips).
  const { data: payslips } = useApi('/api/hr/me/payslips', {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.payslips || []),
  });
  const latest = payslips?.[0];

  // Leave balances.
  const { data: balances } = useApi(
    empId ? `/api/hr/leave/employees/${encodeURIComponent(empId)}/balances` : null,
    { select: (b) => (Array.isArray(b) ? b : b?.items || b?.balances || []) }
  );
  const totalLeave = useMemo(() => {
    if (!balances) return null;
    return balances.reduce((acc, b) => acc + Number(b.available ?? b.balance ?? b.remaining ?? 0), 0);
  }, [balances]);

  // Pending tasks (best-effort; not yet a guaranteed route → silent on 404).
  const { data: tasks } = useApi('/api/hr/me/tasks', {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.tasks || []),
  });
  const pendingCount = Array.isArray(tasks) ? tasks.length : 0;

  // Next payday — prefer an explicit field on the latest payslip / pay calendar.
  const nextPayday =
    latest?.nextPayDate ||
    latest?.period?.payDate ||
    me?.payCalendar?.nextPayDate ||
    null;

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>{greeting()},</p>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>{firstName}</h1>
        {businessName && (
          <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>{businessName}</p>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3">
        <StatCard
          label="Next payday"
          value={nextPayday ? formatDate(nextPayday) : '—'}
          sub={nextPayday ? null : 'When scheduled'}
        />
        <StatCard
          label="Leave balance"
          value={totalLeave != null ? `${totalLeave}` : '—'}
          sub="days available"
          href="/leave"
        />
        <StatCard
          label="Latest payslip"
          value={latest ? money(latest.net ?? latest.netPay ?? latest.netPayable, latest.currency || 'INR') : '—'}
          sub={latest ? formatPeriod(latest.period || latest) : 'No payslips yet'}
          href={latest ? `/payslips/${encodeURIComponent(latest.id)}` : '/payslips'}
        />
        <StatCard
          label="Pending tasks"
          value={pendingCount > 0 ? `${pendingCount}` : '0'}
          sub={pendingCount > 0 ? 'need your action' : 'all caught up'}
        />
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"
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

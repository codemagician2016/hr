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
import { money, formatPeriod, formatDate } from '@/lib/format';
import CelebrationsWidget from '@/components/CelebrationsWidget';

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

  // Latest payslip (first item of the employee's own payslips).
  const { data: payslips } = useApi('/api/hr/me/payslips', {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.payslips || []),
  });
  const latest = payslips?.[0];

  // Leave balances — self-derived (audit #54/#55: the old card hit the operator
  // /api/hr/leave/employees/:id surface with a client-derived id → 401/wrong id).
  const { data: balances } = useApi('/api/hr/me/leave/balances', {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.balances || []),
  });
  const totalLeave = useMemo(() => {
    if (!balances) return null;
    return balances.reduce((acc, b) => acc + Number(b.available ?? b.balance ?? b.remaining ?? 0), 0);
  }, [balances]);

  // Pending self-service tasks (onboarding / unsigned e-sign / asset acks). The
  // real /api/hr/me/tasks feed (audit #56); deep-links to the most relevant task.
  const { data: tasks } = useApi('/api/hr/me/tasks', {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.tasks || []),
  });

  // Unread announcement count for the "News" card badge (Engagement Cycle 1). A
  // not-yet-deployed route (404) degrades to 0 so the card stays clean.
  const { data: unread } = useApi('/api/hr/me/engagement/feed/unread-count', {
    select: (b) => (typeof b?.unread === 'number' ? b.unread : 0),
  });
  const unreadNews = typeof unread === 'number' ? unread : 0;
  const pendingTasks = Array.isArray(tasks) ? tasks : [];
  const pendingCount = pendingTasks.length;
  const onboardingTask = pendingTasks.find((t) => t.kind === 'ONBOARDING') || null;
  const tasksHref = pendingTasks[0]?.href || '/profile';

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

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
          href={pendingCount > 0 ? tasksHref : undefined}
        />
        <StatCard
          label="News"
          value={unreadNews > 0 ? `${unreadNews} new` : 'Up to date'}
          sub={unreadNews > 0 ? 'unread announcements' : 'company feed'}
          href="/feed"
        />
      </section>

      {/* Onboarding call-to-action — only when an onboarding journey is in
          progress for this employee (audit #60: there was no in-app entry point). */}
      {onboardingTask && (
        <Link
          href="/onboarding"
          className="block rounded-2xl border p-4 shadow-sm transition active:scale-[0.99]"
          style={{ borderColor: 'var(--theme-primary)', background: 'var(--theme-primary-soft, #f0fdfa)' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                   stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
                {onboardingTask.title || 'Complete your onboarding'}
              </div>
              <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                {onboardingTask.sub || 'A few steps to get you ready for day one'}
              </div>
            </div>
            <span className="ml-auto text-sm font-medium" style={{ color: 'var(--theme-primary)' }} aria-hidden="true">→</span>
          </div>
        </Link>
      )}

      {/* Pending tasks list — a friendly, deep-linked breakdown (not a dead count). */}
      {pendingCount > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
            Needs your attention
          </h2>
          <ul className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            {pendingTasks.map((t) => (
              <li key={t.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--theme-border)' }}>
                <Link href={t.href || '/profile'} className="flex items-center justify-between px-4 py-3 transition active:scale-[0.99]">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{t.title}</span>
                    {t.sub && <span className="block truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{t.sub}</span>}
                  </span>
                  <span className="ml-3 text-sm" style={{ color: 'var(--theme-primary)' }} aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Celebration feed — upcoming birthdays + work anniversaries (privacy-aware,
          no DOB-year leak; renders nothing when empty). */}
      <CelebrationsWidget windowDays={30} limit={5} />

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          Quick links
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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
        </div>
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

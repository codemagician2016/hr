'use client';

// Left navigation rail for the ESS portal.
//
// Top: a circular avatar + the employee's name (from useSession, tolerant of the
// several session shapes — see lib/format.js) and the tenant business name.
// Below: a vertical nav of icon+label items. Some items are GROUPS that expand
// to sub-items. The active item (or a group containing the active path) is
// highlighted with the tenant brand color (var(--theme-primary)) — NEVER a
// hardcoded colour, so each employer sees their own brand.
//
// Icons are consistent inline line-SVGs (no extra dependency); each item ships a
// single `path` (stroke=currentColor) so it inherits the active/idle colour.
//
// On mobile (<lg) this rail lives inside a drawer rendered by AppShell; `onNavigate`
// closes that drawer after a link is tapped. On desktop it is a fixed column.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/AppShell';
import { useTenant } from '@/components/TenantProvider';
import { useProfile } from '@/lib/useProfile';
import { useApi } from '@/lib/useApi';
import { useCountry } from '@/lib/useCountry';

// ── icon set (single-path line icons, 24x24 viewBox) ─────────────────────────
const ICONS = {
  dashboard: 'M3 11l9-8 9 8M5 10v10h6v-6h2v6h6V10',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  calendar: 'M7 3v4M17 3v4M3 9h18M5 5h14v16H5z',
  clock: 'M12 8v4l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  leaf: 'M5 21c0-9 7-16 16-16 0 9-7 16-16 16zM5 21c4-4 8-6 12-7',
  wallet: 'M3 7h16a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 7V6a2 2 0 012-2h12M17 13h.01',
  receipt: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4',
  coin: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  doc: 'M6 2h9l5 5v15H6zM15 2v5h5M9 13h6M9 17h6',
  letter: 'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM3 7l9 6 9-6',
  tax: 'M9 7h6M9 11h6M9 15h4M6 3h12v18H6z',
  chart: 'M3 17l6-6 4 4 8-8M14 7h7v7',
  exit: 'M16 17l5-5-5-5M21 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4',
  onboarding: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  // Feature 10 — approvals inbox (checklist + tick)
  approvals: 'M4 6h10M4 12h7M4 18h10M16 14l2 2 4-4',
  // Feature 13 — My Team (Manager Self-Service): two figures
  team: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  // Cycle 1 — Helpdesk (lifebuoy)
  support: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8zM5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2',
  // Engagement Cycle 1 — News feed (megaphone)
  news: 'M3 11l14-7v16l-14-7zM3 11v4a2 2 0 002 2h1l1 4',
  // Cycle 1 — Company Directory: an open address-book / contact card
  directory: 'M4 19.5A2.5 2.5 0 016.5 17H20M4 4.5A2.5 2.5 0 016.5 2H20v15H6.5A2.5 2.5 0 004 19.5zM12 7a2 2 0 110 4 2 2 0 010-4zM8.5 14a3.5 3.5 0 017 0',
};

function Icon({ name, className }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"
         stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
         className={className}>
      <path d={ICONS[name] || ICONS.doc} />
    </svg>
  );
}

// ── nav model — the REAL ess routes (this is the employee's own portal) ──────
const NAV = [
  { type: 'item', href: '/', label: 'Dashboard', icon: 'dashboard' },
  // Engagement Cycle 1 — the company news feed (announcements). Carries an unread
  // badge sourced from /api/hr/me/engagement/feed/unread-count.
  { type: 'item', href: '/feed', label: 'News', icon: 'news', badgeKey: 'news' },
  { type: 'item', href: '/profile', label: 'Personal Information', icon: 'user' },
  // Cycle 1 — Company Directory (available to every employee; a tenant-wide,
  // privacy-safe colleague directory).
  { type: 'item', href: '/directory', label: 'Directory', icon: 'directory' },
  {
    type: 'group',
    key: 'attendance-leaves',
    label: 'Attendance & Leaves',
    icon: 'calendar',
    children: [
      { href: '/attendance', label: 'Attendance', icon: 'clock' },
      { href: '/leave', label: 'Leave', icon: 'leaf' },
    ],
  },
  {
    type: 'group',
    key: 'payroll-reimbursement',
    label: 'Payroll & Reimbursement',
    icon: 'wallet',
    children: [
      { href: '/payslips', label: 'Payslips', icon: 'receipt' },
      { href: '/compensation', label: 'Compensation', icon: 'coin' },
      // Feature 11 — claims (reimbursement) + travel/outdoor-duty.
      { href: '/reimbursements', label: 'Reimbursements & Travel', icon: 'wallet' },
      { href: '/tax', label: 'Tax', icon: 'tax' },
      { href: '/documents', label: 'Documents', icon: 'doc' },
      { href: '/letters', label: 'My Letters', icon: 'letter' },
    ],
  },
  { type: 'item', href: '/performance', label: 'Performance', icon: 'chart' },
  // Cycle 1 — HR Helpdesk: raise + track support tickets (self-service).
  { type: 'item', href: '/helpdesk', label: 'Help & Support', icon: 'support' },
  { type: 'item', href: '/separation', label: 'Separation', icon: 'exit' },
];

function pathMatches(pathname, href) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}
function groupActive(pathname, group) {
  return group.children.some((c) => pathMatches(pathname, c.href));
}

// Resolve the employee's display name + initials from the tolerant session shape.
function nameFromSession(me) {
  const emp = me?.employee || me?.customer || me || {};
  return (
    emp.name ||
    [emp.firstName, emp.lastName].filter(Boolean).join(' ') ||
    me?.name ||
    'Employee'
  );
}
function initialsOf(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export default function Sidebar({ onNavigate }) {
  const pathname = usePathname() || '/';
  const me = useSession();
  const { tenant, theme } = useTenant();
  // Rich profile (designation/code) for the subtitle — the bare session carries
  // only name/email (audit #58). Falls back to the session shape while loading.
  const { profile } = useProfile();
  // Outstanding tasks → conditional Onboarding nav entry (audit #60). Best-effort:
  // any error simply omits the entry, never breaks the rail.
  const { data: tasks } = useApi('/api/hr/me/tasks', {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.tasks || []),
  });
  const hasOnboarding = Array.isArray(tasks) && tasks.some((t) => t.kind === 'ONBOARDING');
  // Engagement Cycle 1 — unread announcement count → a small badge on the News item.
  // Best-effort: a 404 / error just omits the badge, never breaks the rail.
  const { data: newsUnread } = useApi('/api/hr/me/engagement/feed/unread-count', {
    select: (b) => (typeof b?.unread === 'number' ? b.unread : 0),
  });
  const newsBadge = typeof newsUnread === 'number' && newsUnread > 0 ? newsUnread : 0;
  // Feature 10: show the Approvals inbox item only to people who actually have
  // something to approve (the tasks feed includes APPROVAL kinds for approvers).
  const hasApprovals = Array.isArray(tasks) && tasks.some((t) => t.kind === 'APPROVAL');
  // FLAG (Feature 13): show "My Team" (Manager Self-Service) ONLY when the employee
  // has reports — the team roster is scoped server-side, so a non-manager gets [].
  // Best-effort: any error omits the entry, never breaks the rail.
  const { data: teamRoster } = useApi('/api/hr/me/team/roster', {
    select: (b) => (Array.isArray(b) ? b : b?.items || []),
  });
  const hasTeam = Array.isArray(teamRoster) && teamRoster.length > 0;
  // FLAG (Feature 15): the India income-tax PROJECTION nav item is country-gated —
  // it only appears for IN employees (the surface 422s for non-IN, and NZ
  // projection is roadmap). Fail-closed: country is null while loading / when
  // unresolved, so the item stays hidden until India is confirmed.
  const { country } = useCountry();
  const showTaxProjection = country === 'IN';

  const fullName = profile?.name || nameFromSession(me);
  const emp = me?.employee || me?.customer || me || {};
  const subtitle =
    profile?.designation || profile?.employeeCode ||
    emp.designation?.name || emp.designation || emp.designationName ||
    emp.employeeCode || emp.code || null;
  const business = tenant?.business || {};
  const businessName = business.name || business.displayName || null;
  const logoUrl = theme?.logoUrl || business.logoUrl || null;
  const avatarUrl = profile?.photoUrl || emp.avatarUrl || emp.photoUrl || emp.photo || null;

  // Inject a conditional "Onboarding" item (top of the rail) only while an
  // onboarding journey is in progress for this employee — otherwise it stays off
  // so the chrome never advertises a flow the employee has already finished.
  const navItems = (() => {
    let items = NAV;
    // FLAG (Feature 15): inject the India-only "Tax projection" item into the
    // payroll group, right after "Tax". Clone the group so NAV stays immutable.
    if (showTaxProjection) {
      items = items.map((n) => {
        if (n.type !== 'group' || n.key !== 'payroll-reimbursement') return n;
        const at = n.children.findIndex((c) => c.href === '/tax');
        const insertAt = at >= 0 ? at + 1 : n.children.length;
        const children = [
          ...n.children.slice(0, insertAt),
          { href: '/tax/projection', label: 'Tax projection', icon: 'chart' },
          // FLAG (Feature 20): India-only "Investment proofs" — the year-end proof
          // upload + Form 12BB. Window-gated server-side; the link is always shown
          // for India (the page explains when the window is open / not configured).
          { href: '/tax/proofs', label: 'Investment proofs', icon: 'doc' },
          ...n.children.slice(insertAt),
        ];
        return { ...n, children };
      });
    }
    if (hasOnboarding) {
      items = [NAV[0], { type: 'item', href: '/onboarding', label: 'Onboarding', icon: 'onboarding' }, ...NAV.slice(1)];
    }
    if (hasApprovals) {
      // Insert "Approvals" right after Dashboard (and after Onboarding if present).
      const at = hasOnboarding ? 2 : 1;
      items = [...items.slice(0, at), { type: 'item', href: '/approvals', label: 'Approvals', icon: 'approvals' }, ...items.slice(at)];
    }
    if (hasTeam) {
      // Insert "My Team" right after Personal Information (managers only).
      const idx = items.findIndex((n) => n.href === '/profile');
      const at = idx >= 0 ? idx + 1 : 1;
      items = [...items.slice(0, at), { type: 'item', href: '/team', label: 'My Team', icon: 'team' }, ...items.slice(at)];
    }
    return items;
  })();

  // Groups start expanded when they contain the active route; the user can toggle.
  const [open, setOpen] = useState(() => {
    const init = {};
    for (const n of NAV) if (n.type === 'group') init[n.key] = groupActive(pathname, n);
    return init;
  });
  // Keep the active group open as the route changes (without collapsing user toggles).
  useEffect(() => {
    setOpen((prev) => {
      const next = { ...prev };
      for (const n of NAV) if (n.type === 'group' && groupActive(pathname, n)) next[n.key] = true;
      return next;
    });
  }, [pathname]);

  const ACTIVE = { color: 'var(--theme-primary)', background: 'var(--theme-primary-soft)' };
  const IDLE = { color: 'var(--theme-text)' };

  return (
    <div className="ess-sidebar ess-scroll">
      {/* Tenant identity (logo / business name) */}
      <div className="ess-sidebar-brand">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={businessName ? `${businessName} logo` : 'Logo'} className="ess-sidebar-logo" />
        ) : businessName ? (
          <span className="ess-sidebar-brandname truncate">{businessName}</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/drifthr-logo.svg" alt="DriftHR" className="ess-sidebar-logo" />
        )}
      </div>

      {/* Employee header — avatar + name */}
      <div className="ess-sidebar-me">
        <div className="ess-avatar" aria-hidden={avatarUrl ? undefined : 'true'}>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="ess-avatar-img" />
          ) : (
            <span>{initialsOf(fullName)}</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="ess-me-name truncate" title={fullName}>{fullName}</div>
          {subtitle && <div className="ess-me-sub truncate">{subtitle}</div>}
        </div>
      </div>

      {/* Navigation */}
      <nav className="ess-nav" aria-label="Primary">
        <ul className="ess-nav-list">
          {navItems.map((n) => {
            if (n.type === 'item') {
              const active = pathMatches(pathname, n.href);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={`ess-nav-link${active ? ' is-active' : ''}`}
                    style={active ? ACTIVE : IDLE}
                  >
                    <Icon name={n.icon} className="ess-nav-icon" />
                    <span className="truncate">{n.label}</span>
                    {n.badgeKey === 'news' && newsBadge > 0 && (
                      <span
                        className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold text-white"
                        style={{ background: 'var(--theme-primary)' }}
                        aria-label={`${newsBadge} unread announcements`}
                      >
                        {newsBadge > 99 ? '99+' : newsBadge}
                      </span>
                    )}
                  </Link>
                </li>
              );
            }
            // group
            const gActive = groupActive(pathname, n);
            const isOpen = !!open[n.key];
            return (
              <li key={n.key}>
                <button
                  type="button"
                  onClick={() => setOpen((p) => ({ ...p, [n.key]: !p[n.key] }))}
                  aria-expanded={isOpen}
                  className={`ess-nav-link ess-nav-group${gActive ? ' is-active' : ''}`}
                  style={gActive ? { color: 'var(--theme-primary)' } : IDLE}
                >
                  <Icon name={n.icon} className="ess-nav-icon" />
                  <span className="truncate flex-1 text-left">{n.label}</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                       className={`ess-chevron${isOpen ? ' is-open' : ''}`}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {isOpen && (
                  <ul className="ess-subnav">
                    {n.children.map((c) => {
                      const active = pathMatches(pathname, c.href);
                      return (
                        <li key={c.href}>
                          <Link
                            href={c.href}
                            onClick={onNavigate}
                            aria-current={active ? 'page' : undefined}
                            className={`ess-nav-link ess-subnav-link${active ? ' is-active' : ''}`}
                            style={active ? ACTIVE : IDLE}
                          >
                            <Icon name={c.icon} className="ess-nav-icon" />
                            <span className="truncate">{c.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

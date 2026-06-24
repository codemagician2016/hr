'use client';

// Left navigation rail for the HR-admin console — the same visual language as
// the ESS portal (brand at top, operator avatar+name+role header, grouped
// collapsible icon nav, brand-coloured active states).
//
// This is a PRESENTATIONAL component: AdminShell already loads the operator
// session (GET /api/auth/me) and the tenant brand once, and computes the
// permission-filtered + grouped nav tree (lib/nav.buildNavTree). We just render
// what we're given. Active state + group expand/collapse are local UI state.
//
// Everything brandable reads var(--theme-*) (never a hardcoded colour) so each
// employer/operator sees their own brand. Icons are zero-dependency inline
// line-SVGs (components/NavIcons) that inherit the active/idle colour.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/NavIcons';

function pathMatches(pathname, href) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
function groupActive(pathname, group) {
  return (group.children || []).some((c) => pathMatches(pathname, c.href));
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

const ACTIVE = { color: 'var(--theme-primary)', background: 'var(--theme-primary-soft)' };
const IDLE = { color: 'var(--theme-text)' };

// A small count badge (e.g. "Letters ②" = 2 pending letter requests). Renders
// nothing for a falsy/zero count; caps the display at 99+.
function NavBadge({ count }) {
  const n = Number(count) || 0;
  if (n <= 0) return null;
  return (
    <span
      className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-xs font-semibold"
      style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}
      aria-label={`${n} pending`}
      title={`${n} pending`}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

export default function Sidebar({ navTree = [], session, brand, theme, badges = {}, onNavigate }) {
  const pathname = usePathname() || '/';

  // Operator identity for the header — name + role (BusinessRole name preferred,
  // falling back to the legacy role enum), avatar = initials.
  const fullName = session?.name || session?.email || 'Operator';
  const role =
    session?.businessRole?.name ||
    (session?.role ? String(session.role).replace(/_/g, ' ') : null) ||
    null;

  // Tenant brand (logo / business name). White-label rule: render the tenant's
  // logo if set, ELSE the tenant's business NAME as a styled wordmark — NEVER the
  // DriftHR vendor mark on a tenant surface.
  const logoUrl = theme?.logoUrl || brand?.logoUrl || brand?.business?.logoUrl || null;
  const businessName = brand?.business?.name || brand?.name || null;

  // Groups start expanded when they contain the active route; user can toggle.
  const groupKeys = navTree.filter((n) => n.type === 'group').map((n) => n.key);
  const [open, setOpen] = useState(() => {
    const init = {};
    for (const n of navTree) if (n.type === 'group') init[n.key] = groupActive(pathname, n);
    return init;
  });
  // Keep the active group open as the route changes (without collapsing user toggles).
  useEffect(() => {
    setOpen((prev) => {
      const next = { ...prev };
      for (const n of navTree) if (n.type === 'group' && groupActive(pathname, n)) next[n.key] = true;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, groupKeys.join('|')]);

  return (
    <div className="dh-sidebar dh-scroll">
      {/* Tenant identity — logo if set, else the business NAME as a styled
          wordmark (var(--theme-primary)). NEVER the DriftHR vendor mark. */}
      <div className="dh-sidebar-brand">
        {logoUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoUrl} alt={businessName ? `${businessName} logo` : 'Logo'} className="dh-sidebar-logo" />
            {businessName && <span className="dh-sidebar-brandname truncate">{businessName}</span>}
          </>
        ) : (
          <span
            className="dh-sidebar-brandname truncate"
            style={{ color: 'var(--theme-primary)', fontWeight: 700, fontSize: '1.05rem' }}
          >
            {businessName || 'HR'}
          </span>
        )}
      </div>

      {/* Operator header — avatar + name + role */}
      <div className="dh-sidebar-me">
        <div className="dh-avatar"><span>{initialsOf(fullName)}</span></div>
        <div className="min-w-0">
          <div className="dh-me-name truncate" title={fullName}>{fullName}</div>
          {role && <div className="dh-me-sub truncate">{role}</div>}
        </div>
      </div>

      {/* Navigation */}
      <nav className="dh-nav" aria-label="Primary">
        <ul className="dh-nav-list">
          {navTree.map((n) => {
            if (n.type === 'item') {
              const active = pathMatches(pathname, n.href);
              return (
                <li key={n.key}>
                  <Link
                    href={n.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={`dh-nav-link${active ? ' is-active' : ''}`}
                    style={active ? ACTIVE : IDLE}
                  >
                    <Icon name={n.icon} className="dh-nav-icon" />
                    <span className="truncate">{n.label}</span>
                    <NavBadge count={badges[n.key]} />
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
                  className={`dh-nav-link dh-nav-group${gActive ? ' is-active' : ''}`}
                  style={gActive ? { color: 'var(--theme-primary)' } : IDLE}
                >
                  <Icon name={n.icon} className="dh-nav-icon" />
                  <span className="truncate flex-1 text-left">{n.label}</span>
                  {/* Collapsed-group badge (e.g. "Letters ②"). Hidden while open so
                      it isn't doubled with the child link's badge below. */}
                  {!isOpen && <NavBadge count={badges[n.key]} />}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                       className={`dh-chevron${isOpen ? ' is-open' : ''}`}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {isOpen && (
                  <ul className="dh-subnav">
                    {n.children.map((c) => {
                      const active = pathMatches(pathname, c.href);
                      return (
                        <li key={c.key}>
                          <Link
                            href={c.href}
                            onClick={onNavigate}
                            aria-current={active ? 'page' : undefined}
                            className={`dh-nav-link dh-subnav-link${active ? ' is-active' : ''}`}
                            style={active ? ACTIVE : IDLE}
                          >
                            <Icon name={c.icon} size={16} className="dh-nav-icon" />
                            <span className="truncate">{c.label}</span>
                            <NavBadge count={badges[c.key]} />
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

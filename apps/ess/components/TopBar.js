'use client';

// Top bar for the ESS portal content area.
//
// Left  : a hamburger that collapses the sidebar (desktop) / opens the drawer
//         (mobile) — wired to the shell via `onToggleSidebar`.
// Centre: a WORKING quick-jump search over the employee's own portal pages
//         (client-side; the ESS has no server-side global search, so we navigate
//         locally instead of advertising an unbacked feature — audit #59).
// Right : two real surfaces + Logout —
//         • Tasks  — the pending-tasks popover backed by /api/hr/me/tasks (onboarding,
//                    e-sign, approvals awaiting me…). Preserved as its own control so
//                    the approvals affordance is never lost.
//         • Bell   — the NOTIFICATION INBOX backed by /api/hr/me/notifications: an
//                    unread badge (…/unread-count) + a dropdown of feed mentions/
//                    comments, each linking to the relevant post, with mark-one-read
//                    on click and a "mark all read" action. Graceful when the employee
//                    has no operator User (unlinked → empty bell).
//         • Logout — POST /api/customer/logout then redirect to /login.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  apiPost, markNotificationRead, markAllNotificationsRead,
} from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { relativeTime } from '@/lib/format';

// The searchable ESS destinations (the same surfaces the sidebar exposes).
const PAGES = [
  { href: '/', label: 'Dashboard', keywords: 'home overview' },
  { href: '/profile', label: 'Personal Information', keywords: 'profile me details' },
  { href: '/attendance', label: 'Attendance', keywords: 'clock punch timesheet shift' },
  { href: '/leave', label: 'Leave', keywords: 'holiday time off balance apply' },
  { href: '/payslips', label: 'Payslips', keywords: 'salary pay slip download' },
  { href: '/compensation', label: 'Compensation', keywords: 'ctc breakup salary' },
  { href: '/tax', label: 'Tax', keywords: 'declaration regime 80c' },
  { href: '/documents', label: 'Documents', keywords: 'files upload' },
  { href: '/letters', label: 'My Letters', keywords: 'letter request hr' },
  { href: '/performance', label: 'Performance', keywords: 'goals review okr' },
  { href: '/separation', label: 'Separation', keywords: 'resign exit full and final' },
];

// Type-aware presentation for a notification row. The backend `title` is already
// human ("X mentioned you"); we fall back to a synthesized label by type so an
// untitled row still reads correctly.
const NOTIF_META = {
  FEED_MENTION: { emoji: '💬', verb: 'mentioned you' },
  FEED_COMMENT: { emoji: '💬', verb: 'commented on your post' },
};
function notifLabel(n) {
  const meta = NOTIF_META[n.type];
  const actor = n && n.dataJson ? n.dataJson.actorName : null;
  const title = n.title || (meta ? `${actor ? `${actor} ` : ''}${meta.verb}` : (n.type || 'Notification'));
  return { emoji: meta ? meta.emoji : '🔔', title, sub: n.body || '' };
}
function notifHref(n) {
  const annId = (n && n.dataJson && n.dataJson.announcementId)
    || (n && n.entityType === 'Announcement' ? n.entityId : null);
  return annId ? `/feed?post=${encodeURIComponent(annId)}` : '/feed';
}

function IconBtn({ label, onClick, children, badge }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="ess-topbar-iconbtn relative">
      {children}
      {badge > 0 && (
        <span
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
          style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          aria-hidden="true"
        >
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

export default function TopBar({ onToggleSidebar }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  // Quick-jump search (client-side, real navigation).
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);

  // Pending-tasks popover (onboarding / e-sign / approvals awaiting me).
  const [tasksOpen, setTasksOpen] = useState(false);
  const tasksRef = useRef(null);
  const { data: tasks } = useApi('/api/hr/me/tasks', {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.tasks || []),
  });
  const pending = Array.isArray(tasks) ? tasks : [];

  // Notification inbox — badge (always loaded) + list (lazy, when the bell opens).
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef(null);
  const { data: unreadData, reload: reloadUnread, setData: setUnreadData } = useApi(
    '/api/hr/me/notifications/unread-count',
    { select: (b) => ({ unread: Number(b?.unread) || 0 }) },
  );
  const unread = unreadData?.unread || 0;
  const {
    data: notif, loading: notifLoading, error: notifError, setData: setNotif,
  } = useApi('/api/hr/me/notifications?page=1&pageSize=15', {
    enabled: bellOpen,
    deps: [bellOpen],
    select: (b) => ({ items: b?.items || [], unlinked: !!b?.unlinked }),
  });
  const notifItems = notif?.items || [];

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return PAGES.filter((p) => p.label.toLowerCase().includes(q) || p.keywords.includes(q)).slice(0, 6);
  }, [query]);

  // Close the popovers on outside-click / Escape.
  useEffect(() => {
    function onDocClick(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
      if (tasksRef.current && !tasksRef.current.contains(e.target)) setTasksOpen(false);
      if (bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') { setSearchOpen(false); setTasksOpen(false); setBellOpen(false); } }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  function go(href) {
    setSearchOpen(false);
    setQuery('');
    router.push(href);
  }

  function onSearchSubmit(e) {
    e.preventDefault();
    if (results[0]) go(results[0].href);
  }

  function openBell() {
    const next = !bellOpen;
    setBellOpen(next);
    setTasksOpen(false);
    if (next) reloadUnread();
  }

  async function openNotification(n) {
    setBellOpen(false);
    if (!n.read) {
      // Optimistic: mark this row read + decrement the badge, then persist (best-effort).
      setNotif((d) => (d ? { ...d, items: d.items.map((x) => (x.id === n.id ? { ...x, read: true } : x)) } : d));
      setUnreadData((u) => ({ unread: Math.max(0, (u?.unread || 0) - 1) }));
      try { await markNotificationRead(n.id); } catch { /* best effort */ }
    }
    router.push(notifHref(n));
  }

  async function markAll() {
    setNotif((d) => (d ? { ...d, items: d.items.map((x) => ({ ...x, read: true })) } : d));
    setUnreadData({ unread: 0 });
    try { await markAllNotificationsRead(); } catch { /* best effort */ }
  }

  async function logout() {
    setLoggingOut(true);
    try { await apiPost('/api/customer/logout', {}); } catch { /* best effort */ }
    router.replace('/login');
  }

  return (
    <header className="ess-topbar">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle navigation"
        className="ess-topbar-iconbtn ess-hamburger"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
             stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Quick-jump search — real client-side navigation over the portal pages */}
      <div className="ess-search relative" ref={searchRef}>
        <form role="search" onSubmit={onSearchSubmit} className="flex w-full items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
               stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            placeholder="Jump to…"
            aria-label="Search portal pages"
            className="ess-search-input"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
          />
        </form>
        {searchOpen && results.length > 0 && (
          <ul
            className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border bg-white shadow-lg"
            style={{ borderColor: 'var(--theme-border)' }}
            role="listbox"
          >
            {results.map((r) => (
              <li key={r.href}>
                <button
                  type="button"
                  onClick={() => go(r.href)}
                  className="flex w-full items-center px-3 py-2 text-left text-sm transition hover:bg-[var(--theme-primary-soft,#f0fdfa)]"
                  style={{ color: 'var(--theme-text)' }}
                >
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ess-topbar-actions">
        {/* Pending tasks (onboarding / e-sign / approvals awaiting me) */}
        <div className="relative" ref={tasksRef}>
          <IconBtn label="Tasks" badge={pending.length} onClick={() => { setTasksOpen((v) => !v); setBellOpen(false); }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                 stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h10M4 12h7M4 18h10M16 14l2 2 4-4" />
            </svg>
          </IconBtn>
          {tasksOpen && (
            <div
              className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-xl border bg-white shadow-lg"
              style={{ borderColor: 'var(--theme-border)' }}
              role="dialog"
              aria-label="Tasks"
            >
              <div className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide"
                   style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                Tasks
              </div>
              {pending.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm" style={{ color: 'var(--theme-muted)' }}>
                  You&apos;re all caught up.
                </p>
              ) : (
                <ul>
                  {pending.map((t) => (
                    <li key={t.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--theme-border)' }}>
                      <Link
                        href={t.href || '/profile'}
                        onClick={() => setTasksOpen(false)}
                        className="block px-4 py-3 transition hover:bg-[var(--theme-primary-soft,#f0fdfa)]"
                      >
                        <span className="block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{t.title}</span>
                        {t.sub && <span className="block truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{t.sub}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Notification inbox */}
        <div className="relative" ref={bellRef}>
          <IconBtn label="Notifications" badge={unread} onClick={openBell}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                 stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />
            </svg>
          </IconBtn>
          {bellOpen && (
            <div
              className="absolute right-0 top-full z-30 mt-1 w-80 max-w-[90vw] overflow-hidden rounded-xl border bg-white shadow-lg"
              style={{ borderColor: 'var(--theme-border)' }}
              role="dialog"
              aria-label="Notifications"
            >
              <div className="flex items-center justify-between border-b px-4 py-2"
                   style={{ borderColor: 'var(--theme-border)' }}>
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
                  Notifications
                </span>
                {notifItems.some((n) => !n.read) && (
                  <button
                    type="button"
                    onClick={markAll}
                    className="text-[11px] font-medium"
                    style={{ color: 'var(--theme-primary)' }}
                  >
                    Mark all read
                  </button>
                )}
              </div>
              {notifLoading ? (
                <p className="px-4 py-6 text-center text-sm" style={{ color: 'var(--theme-muted)' }}>Loading…</p>
              ) : notifError ? (
                <p className="px-4 py-6 text-center text-sm" style={{ color: 'var(--theme-muted)' }}>
                  Could not load notifications.
                </p>
              ) : notifItems.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm" style={{ color: 'var(--theme-muted)' }}>
                  You&apos;re all caught up.
                </p>
              ) : (
                <ul className="max-h-[70vh] overflow-auto">
                  {notifItems.map((n) => {
                    const { emoji, title, sub } = notifLabel(n);
                    return (
                      <li key={n.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--theme-border)' }}>
                        <button
                          type="button"
                          onClick={() => openNotification(n)}
                          className="flex w-full items-start gap-2 px-4 py-3 text-left transition hover:bg-[var(--theme-primary-soft,#f0fdfa)]"
                          style={{ background: n.read ? 'transparent' : 'var(--theme-primary-soft)' }}
                        >
                          <span aria-hidden="true" className="mt-0.5">{emoji}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{title}</span>
                            {sub && <span className="block truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{sub}</span>}
                            <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--theme-muted)' }}>{relativeTime(n.createdAt)}</span>
                          </span>
                          {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--theme-primary)' }} aria-label="Unread" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={logout}
          disabled={loggingOut}
          className="ess-logout-btn"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
               stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 17l5-5-5-5M21 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
          </svg>
          <span className="hidden sm:inline">{loggingOut ? 'Logging out…' : 'Logout'}</span>
        </button>
      </div>
    </header>
  );
}

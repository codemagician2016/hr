'use client';

// Top bar for the HR-admin console content area — same surfaces as the ESS
// portal's top bar.
//
// Left  : a hamburger that collapses the sidebar (desktop) / opens the drawer
//         (mobile) — wired to AdminShell via `onToggleSidebar`.
// Centre: a WORKING "Jump to…" quick-nav (command-palette style) over the
//         operator's OWN visible pages — the same permission-filtered route list
//         the sidebar shows, so it never offers a destination they can't reach.
//         Type a page name → ↑/↓ to highlight → Enter navigates.
// Right : a notification bell (a tasteful popover; the admin console has no
//         notifications feed yet, so it shows a clean "all caught up" state
//         rather than dead chrome), and a Logout action — POST /api/auth/logout
//         then redirect to /login.
//
// Everything brandable reads var(--theme-*).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/NavIcons';

function IconBtn({ label, onClick, children, badge }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="dh-topbar-iconbtn relative">
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

// Flatten the grouped nav tree into a single searchable list of destinations
// (groups contribute their children; standalone items contribute themselves),
// so the quick-jump only ever offers routes the operator can actually open.
function flattenDestinations(navTree) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.href || seen.has(item.href)) return;
    seen.add(item.href);
    out.push({ href: item.href, label: item.label, group: item.groupLabel });
  };
  for (const n of navTree || []) {
    if (n.type === 'group') {
      for (const c of n.children || []) push({ ...c, groupLabel: n.label });
    } else {
      push(n);
    }
  }
  return out;
}

export default function TopBar({ onToggleSidebar, onLogout, navTree = [] }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  const destinations = useMemo(() => flattenDestinations(navTree), [navTree]);

  // Quick-jump search (client-side, real navigation).
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const searchRef = useRef(null);

  // Notifications popover (no admin feed yet → tasteful empty state).
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return destinations
      .filter((d) => d.label.toLowerCase().includes(q) || (d.group || '').toLowerCase().includes(q))
      .slice(0, 7);
  }, [query, destinations]);

  useEffect(() => { setHighlight(0); }, [query]);

  // Close the popovers on outside-click / Escape.
  useEffect(() => {
    function onDocClick(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
      if (bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') { setSearchOpen(false); setBellOpen(false); } }
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

  function onSearchKeyDown(e) {
    if (!searchOpen || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
  }

  function onSearchSubmit(e) {
    e.preventDefault();
    const target = results[highlight] || results[0];
    if (target) go(target.href);
  }

  async function logout() {
    setLoggingOut(true);
    try { await onLogout?.(); } finally { /* AdminShell redirects to /login */ }
  }

  return (
    <header className="dh-topbar">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle navigation"
        className="dh-topbar-iconbtn dh-hamburger"
      >
        <Icon name="menu" size={20} strokeWidth={1.9} />
      </button>

      {/* Quick-jump search — real client-side navigation over the operator's pages */}
      <div className="dh-search relative" ref={searchRef}>
        <form role="search" onSubmit={onSearchSubmit} className="flex w-full items-center gap-2">
          <Icon name="search" size={16} strokeWidth={1.8} />
          <input
            type="search"
            placeholder="Jump to…"
            aria-label="Jump to a page"
            className="dh-search-input"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={onSearchKeyDown}
          />
        </form>
        {searchOpen && results.length > 0 && (
          <ul
            className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border bg-white shadow-lg"
            style={{ borderColor: 'var(--theme-border)' }}
            role="listbox"
          >
            {results.map((r, i) => (
              <li key={r.href}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => go(r.href)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition"
                  style={{
                    color: 'var(--theme-text)',
                    background: i === highlight ? 'var(--theme-primary-soft)' : 'transparent',
                  }}
                >
                  <span className="truncate">{r.label}</span>
                  {r.group && (
                    <span className="shrink-0 text-xs" style={{ color: 'var(--theme-muted)' }}>{r.group}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="dh-topbar-actions">
        <div className="relative" ref={bellRef}>
          <IconBtn label="Notifications" onClick={() => setBellOpen((v) => !v)}>
            <Icon name="bell" size={20} />
          </IconBtn>
          {bellOpen && (
            <div
              className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-xl border bg-white shadow-lg"
              style={{ borderColor: 'var(--theme-border)' }}
              role="dialog"
              aria-label="Notifications"
            >
              <div className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide"
                   style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                Notifications
              </div>
              <p className="px-4 py-6 text-center text-sm" style={{ color: 'var(--theme-muted)' }}>
                You&apos;re all caught up.
              </p>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={logout}
          disabled={loggingOut}
          className="dh-logout-btn"
        >
          <Icon name="exit" size={16} strokeWidth={1.8} />
          <span className="hidden sm:inline">{loggingOut ? 'Logging out…' : 'Logout'}</span>
        </button>
      </div>
    </header>
  );
}

'use client';

// Page chrome for authenticated ESS pages: a left sidebar (avatar + grouped
// nav) + a top bar (search / notifications / logout) + the content area on a
// light canvas. Guards the customer session: if /api/customer/me 401s, redirect
// to /login. Children receive nothing special — pages fetch their own data.
//
// useSession() is exported here and consumed by the Sidebar (employee name) and
// by individual pages — its contract is unchanged. TenantProvider remains the
// root provider (app/layout.js); this shell reads var(--theme-*) only.

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Centered, Spinner } from '@hr/ui';
import { fetchMe } from '@/lib/api';
import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';

const SessionContext = createContext(null);

export function useSession() {
  return useContext(SessionContext);
}

export default function AppShell({ children }) {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [checking, setChecking] = useState(true);

  // Desktop: collapse the rail. Mobile (<lg): the rail is a drawer behind the
  // hamburger; `drawerOpen` controls the overlay. The same toggle drives both —
  // CSS decides which behaviour applies at the current breakpoint.
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    let aborted = false;
    fetchMe()
      .then((data) => { if (!aborted) { setMe(data); setChecking(false); } })
      .catch((e) => {
        if (aborted) return;
        if (e.status === 401) router.replace('/login');
        else setChecking(false);
      });
    return () => { aborted = true; };
  }, [router]);

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  function toggleSidebar() {
    // On small screens the toggle opens/closes the drawer; on large screens it
    // collapses the rail. We flip both — the inactive one is harmless at the
    // current breakpoint (CSS scopes each behaviour).
    setDrawerOpen((v) => !v);
    setCollapsed((v) => !v);
  }
  const closeDrawer = () => setDrawerOpen(false);

  if (checking) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--theme-bg)' }}>
        <Centered><Spinner /></Centered>
      </div>
    );
  }

  return (
    <SessionContext.Provider value={me}>
      <a href="#main-content" className="skip-link">Skip to main content</a>

      <div className={`ess-shell${collapsed ? ' is-collapsed' : ''}${drawerOpen ? ' drawer-open' : ''}`}>
        {/* Mobile drawer backdrop */}
        <div className="ess-drawer-backdrop" onClick={closeDrawer} aria-hidden="true" />

        {/* Sidebar — fixed column on desktop, drawer on mobile */}
        <aside className="ess-sidebar-wrap" aria-label="Sidebar">
          <Sidebar onNavigate={closeDrawer} />
        </aside>

        {/* Content column */}
        <div className="ess-content">
          <TopBar onToggleSidebar={toggleSidebar} />
          <main id="main-content" className="ess-main ess-scroll">
            <div className="ess-main-inner">
              {children}
            </div>
          </main>
        </div>
      </div>

      {/* Polite live region for async toasts/errors raised by pages. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" id="a11y-status" />
    </SessionContext.Provider>
  );
}

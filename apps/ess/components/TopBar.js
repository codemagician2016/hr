'use client';

// Top bar for the ESS portal content area.
//
// Left  : a hamburger that collapses the sidebar (desktop) / opens the drawer
//         (mobile) — wired to the shell via `onToggleSidebar`.
// Centre: a visual search field (placeholder only — wired to a no-op; the ESS
//         has no global search endpoint yet).
// Right : a notification bell, a messages/mail icon (both visual), and a
//         "Logout" action — POST /api/customer/logout then redirect to /login.
//
// Everything brandable reads var(--theme-*); nothing hardcodes the brand colour.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api';

function IconBtn({ label, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="ess-topbar-iconbtn">
      {children}
    </button>
  );
}

export default function TopBar({ onToggleSidebar }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

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

      {/* Search (visual only) */}
      <form className="ess-search" role="search" onSubmit={(e) => e.preventDefault()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
             stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input type="search" placeholder="Search…" aria-label="Search" className="ess-search-input" />
      </form>

      <div className="ess-topbar-actions">
        <IconBtn label="Notifications">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
               stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />
          </svg>
        </IconBtn>
        <IconBtn label="Messages">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
               stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM3 7l9 6 9-6" />
          </svg>
        </IconBtn>
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

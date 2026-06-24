'use client';

// Tenant HR console shell: a polished sidebar + top bar + tenant-branded theme
// tokens, wrapping every authenticated page (matches the ESS portal's chrome).
//
// On mount it loads the operator session (GET /api/auth/me) and the tenant brand
// (GET /api/tenant/resolve) so:
//   • nav items are gated by feature/permission (lib/nav.visibleNavItems) and
//     arranged into collapsible sections (lib/nav.buildNavTree),
//   • the operator's identity (name + role) heads the sidebar,
//   • the full --theme-* variable set is applied on <html> from the resolved
//     brand (lib/themeVars) — so the shell + @hr/ui primitives pick up the
//     tenant's brand, never a hardcoded colour.
//
// Auth gate: a 401 from /api/auth/me redirects to /login. The /login page itself
// renders outside this shell (ShellGate's public prefixes).
//
// Layout: a CSS grid (sidebar | content). The hamburger collapses the rail on
// desktop and opens an off-canvas drawer on mobile (<1024px) — same toggle,
// CSS scopes each behaviour at the current breakpoint.

import { useEffect, useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Spinner, Centered } from '@hr/ui';
import { resolveTenantTheme } from '@hr/theme-engine';
import { get, post } from '@/lib/api';
import { visibleNavItems, buildNavTree } from '@/lib/nav';
import { themeVarsFromResolved } from '@/lib/themeVars';
import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';

// Apply the full --theme-* contract on <html> from the resolved tenant theme,
// mirroring the ESS TenantProvider so branded components read identical vars.
function applyThemeVars(theme) {
  if (typeof document === 'undefined' || !theme) return;
  const vars = themeVarsFromResolved(theme);
  for (const [key, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(key, value);
  }
  if (theme.styleKey) document.documentElement.setAttribute('data-theme', theme.styleKey);
}

export default function AdminShell({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState(null);
  const [brand, setBrand] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | unauth

  // Desktop: collapse the rail. Mobile (<1024px): the rail is a drawer behind the
  // hamburger; `drawerOpen` controls the overlay. The same toggle drives both —
  // CSS decides which behaviour applies at the current breakpoint.
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await get('/api/auth/me');
        if (!alive) return;
        setSession(me?.user || me);
      } catch (err) {
        if (!alive) return;
        if (err.status === 401) {
          setStatus('unauth');
          router.replace(`/login?redirect=${encodeURIComponent(pathname || '/')}`);
          return;
        }
        // Non-auth failure (network/5xx): still render the shell so the
        // page can show its own error rather than trapping the operator.
        setSession(null);
      }
      try {
        const resolved = await get('/api/tenant/resolve');
        if (alive) {
          // Keep the whole resolve payload: `brand` carries the white-label
          // logo/name/colour, while subscription.themeStyle / themeColors carry
          // the style. Merge into one object the Sidebar + theme memo both read.
          const b = resolved?.brand || {};
          const sub = resolved?.subscription || {};
          setBrand({
            ...b,
            // Theme inputs (style + colour) for resolveTenantTheme below.
            themeStyle: sub.themeStyle,
            themeColors: sub.themeColors,
            // Tenant identity for the sidebar wordmark fallback.
            business: { name: b.name || resolved?.business?.name || null, logoUrl: b.logoUrl || null },
            features: resolved?.features,
          });
        }
      } catch {
        // brand is optional — fall back to default tokens.
      }
      if (alive) setStatus('ready');
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const theme = useMemo(() => {
    if (!brand) return null;
    // themeColors is a JSON string on the subscription; the white-label brand
    // exposes primaryColor directly (it wins so saving on the Branding page
    // re-themes the console). Tolerate either source.
    let subPrimary;
    if (typeof brand.themeColors === 'string') {
      try { subPrimary = JSON.parse(brand.themeColors)?.primary; } catch { subPrimary = undefined; }
    } else if (brand.themeColors && typeof brand.themeColors === 'object') {
      subPrimary = brand.themeColors.primary;
    }
    return resolveTenantTheme({
      styleKey: brand.styleKey || brand.themeStyle || brand.theme,
      colorKey: brand.colorKey,
      primary: brand.primaryColor || subPrimary || brand.primary,
      logoUrl: brand.logoUrl,
    });
  }, [brand]);

  useEffect(() => {
    if (theme) applyThemeVars(theme);
  }, [theme]);

  // White-label the browser chrome from the tenant brand: document title = the
  // business name; favicon = the tenant favicon when set. NEVER "DriftHR".
  useEffect(() => {
    if (typeof document === 'undefined' || !brand) return;
    const name = brand.name || brand.business?.name || null;
    if (name) document.title = name;
    const faviconUrl = brand.faviconUrl || null;
    if (faviconUrl) {
      let link = document.querySelector('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = faviconUrl;
    }
  }, [brand]);

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // Permission-filtered flat items → grouped sidebar tree. Gating is unchanged:
  // visibleNavItems hides anything the operator lacks; buildNavTree only arranges
  // what survives into sections (and drops empty sections).
  const navTree = useMemo(() => {
    const items = visibleNavItems({
      features: session?.features || brand?.features,
      // Raw session so nav.js resolves the operator's effective permissions from
      // their assigned BusinessRole (or legacy-role fallback). Server still enforces.
      session,
    });
    return buildNavTree(items);
  }, [session, brand]);

  // ── nav badges: pending letter-request count (Letters ②) ────────────────────
  // Fetch the open ESS letter-request count once the session is ready AND the
  // Letters section is visible to this operator. Keyed by nav item so the Sidebar
  // can render the badge on the Letters group + its Issue link. Cheap, best-effort
  // (a failure just yields no badge).
  const [navBadges, setNavBadges] = useState({});
  const lettersVisible = useMemo(
    () => navTree.some((n) => n.key === 'letters' || (n.children || []).some((c) => c.parent === 'letters' || c.key === 'letters-issue')),
    [navTree]
  );
  useEffect(() => {
    if (status !== 'ready' || !lettersVisible) return undefined;
    let alive = true;
    const loadCount = () => {
      get('/api/hr/letters/requests/count')
        .then((r) => {
          if (!alive) return;
          const count = Number(r && r.count) || 0;
          setNavBadges((prev) => ({ ...prev, letters: count, 'letters-issue': count }));
        })
        .catch(() => { /* best-effort — no badge on failure */ });
    };
    loadCount();
    // Light polling so the badge reflects new requests without a reload.
    const t = setInterval(loadCount, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [status, lettersVisible]);

  async function handleLogout() {
    try {
      await post('/api/auth/logout');
    } catch {
      // ignore — clear client state regardless.
    }
    router.replace('/login');
  }

  function toggleSidebar() {
    // Small screens: open/close the drawer. Large screens: collapse the rail.
    // Flip both — the inactive one is harmless at the current breakpoint.
    setDrawerOpen((v) => !v);
    setCollapsed((v) => !v);
  }
  const closeDrawer = () => setDrawerOpen(false);

  if (status === 'loading') {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <div className={`dh-shell${collapsed ? ' is-collapsed' : ''}${drawerOpen ? ' drawer-open' : ''}`}>
        {/* Mobile drawer backdrop */}
        <div className="dh-drawer-backdrop" onClick={closeDrawer} aria-hidden="true" />

        {/* Sidebar — fixed column on desktop, drawer on mobile */}
        <aside className="dh-sidebar-wrap" aria-label="Sidebar">
          <Sidebar
            navTree={navTree}
            session={session}
            brand={brand}
            theme={theme}
            badges={navBadges}
            onNavigate={closeDrawer}
          />
        </aside>

        {/* Content column */}
        <div className="dh-content">
          <TopBar onToggleSidebar={toggleSidebar} onLogout={handleLogout} navTree={navTree} />
          <main id="main-content" className="dh-main dh-scroll">
            <div className="dh-main-inner">{children}</div>
          </main>
        </div>
      </div>

      {/* Polite live region for async toasts/errors raised by pages. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" id="a11y-status" />
    </>
  );
}

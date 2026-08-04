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
import { useTenantCountries } from '@/lib/useTenantCountries';
import { themeVarsFromResolved } from '@/lib/themeVars';
import { SetupProvider, useSetup, resetSetupStore, setupFullyComplete } from '@/lib/setup';
import Sidebar from '@/components/Sidebar';
import SetupNudge from '@/components/setup/SetupNudge';
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

// Sidebar + the live setup percentage folded into its badge map. The setup
// subscription lives in this wrapper rather than in AdminShell so a checklist
// refresh re-renders the rail only — subscribing in the shell itself would
// re-run the theme + nav-tree work on every setup payload. Everything else
// about the Sidebar contract is unchanged: it stays presentational and still
// receives an already-permission-filtered tree.
//
// The badge is deliberately absent while loading and once the WORKSPACE is
// finished: rendering "0%" before the payload lands would be a lie, and a badge
// on a finished checklist is noise. It is NOT dropped merely because this
// operator's own score reached 100 — `percent` is permission-scoped, so a
// narrow admin can sit at 100% on a tenant that has not started, and clearing
// their last pointer to the guide would hide the outstanding work from the one
// person still looking. The nav ITEM never disappears — at the end it stays,
// unbadged, as the place to review what was configured.
function SidebarWithSetupBadge({ badges = {}, ...rest }) {
  const { data } = useSetup();
  const percent = Number(data?.percent);
  const finished = setupFullyComplete(data);
  const merged = useMemo(() => (
    Number.isFinite(percent) && percent > 0 && !finished
      ? { ...badges, setup: { kind: 'percent', value: Math.round(percent) } }
      : badges
  ), [badges, percent, finished]);
  return <Sidebar badges={merged} {...rest} />;
}

export default function AdminShell({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState(null);
  const [brand, setBrand] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | unauth
  // Feature 14 — the tenant's authoritative HR country (country-context). Gates
  // the India-only statutory nav items (Form 16/24Q, Statutory Registers, tax
  // windows/proofs/regime, FBP) so a non-IN (e.g. NZ) tenant isn't shown dead
  // links. Fail-open while unresolved so an IN tenant sees no nav flash.
  const { country: hrCountry } = useTenantCountries();

  // Desktop: collapse the rail. Mobile (<1024px): the rail is a drawer behind the
  // hamburger; `drawerOpen` controls the overlay. The same toggle drives both —
  // CSS decides which behaviour applies at the current breakpoint.
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // PERF: these two reads are INDEPENDENT (/api/tenant/resolve never uses the
      // /api/auth/me result), so they run in PARALLEL. Awaiting them in sequence
      // cost an extra full round-trip on EVERY page load in the console — the
      // dominant cost on a high-latency link. allSettled keeps the per-call error
      // semantics below (auth 401 redirects; brand is optional and failure-tolerant).
      const [meRes, brandRes] = await Promise.allSettled([
        get('/api/auth/me'),
        get('/api/tenant/resolve'),
      ]);
      if (!alive) return;
      if (meRes.status === 'fulfilled') {
        setSession(meRes.value?.user || meRes.value);
      } else {
        const err = meRes.reason || {};
        if (err.status === 401) {
          // The other end of a session, same hazard as handleLogout: an expired
          // cookie sends us to /login client-side, and whoever signs in next
          // must not inherit the previous session's setup payload.
          resetSetupStore();
          setStatus('unauth');
          router.replace(`/login?redirect=${encodeURIComponent(pathname || '/')}`);
          return;
        }
        // Non-auth failure (network/5xx): still render the shell so the
        // page can show its own error rather than trapping the operator.
        setSession(null);
      }
      {
        const resolved = brandRes.status === 'fulfilled' ? brandRes.value : null;
        if (alive && resolved) {
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
        // brand is optional — a rejected resolve falls back to default tokens.
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
      // Tenant HR country — hides India-only statutory surfaces for a non-IN tenant.
      country: hrCountry,
    });
    return buildNavTree(items);
  }, [session, brand, hrCountry]);

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
    // /login is a client-side navigation, so nothing re-evaluates the modules
    // holding this session's data. Both caches must be dropped by hand or the
    // next person to sign in on this machine — possibly another tenant — sees
    // the last one's numbers. post() already invalidated the API cache; the
    // setup store keeps its own.
    resetSetupStore();
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
    // Setup guide state is fetched ONCE here and shared by every surface that
    // renders it — the nav % badge, the dashboard widget, the post-login nudge
    // and the /setup page itself — so they can never disagree and never issue
    // three copies of the same request. Mounted inside the auth gate so it
    // never races /api/auth/me.
    <SetupProvider>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <div className={`dh-shell${collapsed ? ' is-collapsed' : ''}${drawerOpen ? ' drawer-open' : ''}`}>
        {/* Mobile drawer backdrop */}
        <div className="dh-drawer-backdrop" onClick={closeDrawer} aria-hidden="true" />

        {/* Sidebar — fixed column on desktop, drawer on mobile */}
        <aside className="dh-sidebar-wrap" aria-label="Sidebar">
          <SidebarWithSetupBadge
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

      {/* Setup reminder for a young, unfinished workspace. Not a modal, never
          focus-stealing, and gone for good once dismissed. */}
      <SetupNudge />

      {/* Polite live region for async toasts/errors raised by pages. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" id="a11y-status" />
    </SetupProvider>
  );
}

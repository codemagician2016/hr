'use client';

// Tenant HR console shell: sidebar nav + top bar + tenant-branded theme
// tokens. Wraps every authenticated page. On mount it loads the operator
// session (GET /api/auth/me) and the tenant brand (GET /api/tenant/resolve)
// so nav items can be gated by feature/permission and the @hr/ui primitives
// pick up the tenant's primary color via the --theme-primary CSS var.
//
// Auth gate: a 401 from /api/auth/me redirects to /login. The /login page
// itself renders outside this shell (see app/login/layout-less usage).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Spinner, Centered } from '@hr/ui';
import { resolveTenantTheme } from '@hr/theme-engine';
import { get, post } from '@/lib/api';
import { visibleNavItems } from '@/lib/nav';

function applyThemeVars(theme) {
  if (typeof document === 'undefined' || !theme) return;
  const primary = theme.palette?.primary || '#4f46e5';
  document.documentElement.style.setProperty('--theme-primary', primary);
}

function isActive(pathname, href) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AdminShell({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState(null);
  const [brand, setBrand] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | unauth

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
        if (alive) setBrand(resolved?.brand || resolved?.subscription?.brand || resolved);
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
    return resolveTenantTheme({
      styleKey: brand.styleKey || brand.theme,
      colorKey: brand.colorKey,
      primary: brand.themeColors?.primary || brand.primary,
      logoUrl: brand.logoUrl,
    });
  }, [brand]);

  useEffect(() => {
    if (theme) applyThemeVars(theme);
  }, [theme]);

  const navItems = useMemo(
    () =>
      visibleNavItems({
        features: session?.features || brand?.features,
        permissions: session?.permissions,
      }),
    [session, brand]
  );

  async function handleLogout() {
    try {
      await post('/api/auth/logout');
    } catch {
      // ignore — clear client state regardless.
    }
    router.replace('/login');
  }

  if (status === 'loading') {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }

  const logoUrl = theme?.logoUrl || brand?.logoUrl;
  const tenantName = brand?.business?.name || brand?.name || null;

  return (
    <div className="min-h-screen flex bg-gray-50">
      <aside className="w-60 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="h-16 flex items-center gap-2 px-5 border-b border-gray-100">
          {logoUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl} alt={tenantName || 'DriftHR'} className="h-8 w-auto max-w-[140px] object-contain" />
              {tenantName && (
                <span className="text-sm font-semibold text-gray-900 truncate">{tenantName}</span>
              )}
            </>
          ) : (
            // No tenant logo — fall back to the DriftHR product mark.
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/drifthr-logo.svg" alt="DriftHR" className="h-7 w-auto" />
          )}
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active ? 'text-white' : 'text-gray-700 hover:bg-gray-100'
                }`}
                style={active ? { backgroundColor: 'var(--theme-primary)' } : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-gray-100 p-3">
          <div className="px-2 pb-2 text-xs text-gray-500 truncate">
            {session?.email || session?.name || 'Operator'}
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 text-left"
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <main className="flex-1 min-w-0 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}

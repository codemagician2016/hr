'use client';

// ECOMMERCE Path B Phase 7a (2026-05-01) — sidebar shell for the
// grocery-vertical admin. Replaces the horizontal pill nav for
// ECOMMERCE tenants only — STATIC + APPOINTMENT keep the existing
// flat top nav.
//
// Matches the FreshCart prototype: 264px left sidebar with brand at
// top, 5 nav groups, profile pinned at bottom. Topbar holds the
// location switcher + search + utility icons.
//
// Layout: h-screen + overflow-hidden on the outer flex container so the
// sidebar and main column each scroll independently. Without this the
// whole page scrolls and tall content (Blog/Categories deep lists) drags
// the sidebar off-screen.

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import LogoutButton from '@/components/LogoutButton';
import LanguageSelector from '@/components/LanguageSelector';
import EcommerceLocationSwitcher from '@/components/EcommerceLocationSwitcher';
import AapkaChatActionWidget from '@/components/AapkaChatActionWidget';
import { buildEcommerceAdminSearchResults } from '@/lib/ecommerceAdminSearch';

const COLLAPSE_STORAGE_KEY = 'sitepresso:ecom-admin-sidebar-collapsed';
const LOCATION_SWITCHER_HIDDEN_TABS = new Set([
  'store-setup',
  'subscription',
  'domains',
  'settings',
  'tax',
  'pages',
  'blog',
  'content',
  'policies',
  'roles',
  'ecom-staff',
  'banners',
  'cms',
  'ecom-notifications',
]);

function shouldShowLocationSwitcher({ business, activeKey }) {
  if (LOCATION_SWITCHER_HIDDEN_TABS.has(activeKey)) return false;
  const mode = String(business?.multiStoreMode || 'OFF').toUpperCase();
  // Branch-only. The switcher is a multi-branch control — it scopes every panel
  // to a chosen branch. OFF and FULFILLMENT both run ONE customer-facing store
  // (Shopify-style), so the switcher would be a pointless one-option dropdown.
  // Only the branch modes (CHAIN/REGIONAL/BOTH) get it.
  return ['CHAIN', 'REGIONAL', 'BOTH'].includes(mode);
}

export default function EcommerceAdminShell({
  tenant,
  business,
  me,
  navItems,
  navGroups,
  activeKey,
  setTab,
  notificationsBell,
  onPublish,
  onUnpublish,
  isLive,
  storefrontUrl,
  children,
}) {
  // Sidebar collapse state — hydrate from localStorage so the choice survives
  // navigation. SSR renders expanded by default; client effect flips it.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1') setCollapsed(true);
    } catch {}
  }, []);
  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }

  return (
    <div
      className="h-screen flex overflow-hidden"
      style={{
        background: '#F5F7F5',
        // Grocery-green theme tokens — only applied to ECOMMERCE shell.
        // Override the platform default indigo without affecting STATIC
        // / APPOINTMENT renders elsewhere.
        '--theme-primary': '#16a34a',
        '--theme-primary-dark': '#15803d',
        '--theme-on-primary': '#ffffff',
      }}
    >
      <Sidebar
        business={business}
        me={me}
        logoUrl={tenant?.content?.logoUrl || ''}
        logoAspect={tenant?.content?.logoAspect || 'wide'}
        navItems={navItems}
        navGroups={navGroups}
        activeKey={activeKey}
        setTab={setTab}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          tenant={tenant}
          business={business}
          navItems={navItems}
          activeKey={activeKey}
          setTab={setTab}
          notificationsBell={notificationsBell}
          isLive={isLive}
          onPublish={onPublish}
          onUnpublish={onUnpublish}
          storefrontUrl={storefrontUrl}
        />
        <main className="flex-1 overflow-y-auto px-6 lg:px-10 py-6">
          <AdminBreadcrumbs
            navItems={navItems}
            navGroups={navGroups}
            activeKey={activeKey}
            setTab={setTab}
          />
          {children}
        </main>
        <AapkaChatActionWidget business={business} me={me} context="admin_portal" />
      </div>
    </div>
  );
}

function AdminBreadcrumbs({ navItems, navGroups, activeKey, setTab }) {
  const activeItem = navItems.find((item) => item.key === activeKey);
  if (!activeItem) return null;
  const activeGroup = navGroups.find((group) => group.keys.includes(activeKey));
  return (
    <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-2 text-xs text-gray-500">
      <button
        type="button"
        onClick={() => setTab('overview')}
        className="font-medium text-gray-600 hover:text-emerald-700"
      >
        Dashboard
      </button>
      {activeGroup && (
        <>
          <span aria-hidden className="text-gray-300">/</span>
          <span className="text-gray-500">{activeGroup.label}</span>
        </>
      )}
      <span aria-hidden className="text-gray-300">/</span>
      <span className="font-semibold text-gray-900">{activeItem.label}</span>
    </nav>
  );
}

function Sidebar({ business, me, logoUrl, logoAspect, navItems, navGroups, activeKey, setTab, collapsed, onToggleCollapsed }) {
  return (
    <aside
      className={`${collapsed ? 'w-[72px]' : 'w-[264px]'} shrink-0 flex flex-col border-r transition-[width] duration-200`}
      style={{ background: '#ffffff', borderColor: 'rgba(0,0,0,0.05)' }}
    >
      {/* Brand + collapse toggle */}
      <div className="flex items-center justify-between gap-2 px-3 py-4 border-b" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
        <Link href="/" className={`flex items-center gap-3 min-w-0 ${collapsed ? 'justify-center w-full' : 'pl-2'}`}>
          <EcommerceBusinessLogo business={business} logoUrl={logoUrl} logoAspect={logoAspect} />
          {!collapsed && (
            <div className="min-w-0">
              <div className="font-bold text-gray-900 leading-tight truncate">{business?.name || 'DriftHR'}</div>
              <div className="text-[9px] font-mono tracking-[0.22em] text-gray-500 uppercase mt-0.5">Seller console</div>
            </div>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          className="mx-auto my-2 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* Nav — own scroll, fills remaining height between brand and profile */}
      <nav className="flex-1 overflow-y-auto py-3">
        {navGroups.map((group) => {
          const items = navItems.filter((n) => group.keys.includes(n.key));
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="mb-4">
              {!collapsed && (
                <p className="px-5 text-[10px] font-mono tracking-[0.22em] uppercase text-gray-400 mb-1.5">
                  {group.label}
                </p>
              )}
              <ul>
                {items.map((item) => {
                  const Icon = item.icon;
                  const isActive = item.key === activeKey;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => setTab(item.key)}
                        title={collapsed ? item.label : undefined}
                        className={`w-full flex items-center ${collapsed ? 'justify-center px-3' : 'gap-3 px-5'} py-2 text-sm font-medium transition-all`}
                        style={isActive ? {
                          background: 'rgba(22, 163, 74, 0.1)',
                          color: '#15803d',
                          borderRight: collapsed ? 'none' : '3px solid #16a34a',
                        } : {
                          color: '#4B5563',
                        }}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* Profile pinned at bottom */}
      <div
        className={`${collapsed ? 'px-2 py-3 justify-center' : 'px-5 py-4 gap-3'} border-t flex items-center`}
        style={{ borderColor: 'rgba(0,0,0,0.05)' }}
      >
        <span
          className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #16a34a, #059669)' }}
          title={collapsed ? (me?.name || 'Admin') : undefined}
        >
          {(me?.name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || 'M'}
        </span>
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-gray-900 truncate">{me?.name || 'Admin'}</div>
              <div className="text-[10px] text-gray-500 truncate">
                {me?.role === 'BUSINESS_ADMIN' ? 'Store owner' : me?.role === 'SUPER_ADMIN' ? 'Super admin' : 'Staff'}
              </div>
            </div>
            <LogoutButton />
          </>
        )}
      </div>
    </aside>
  );
}

function logoAspectRatio(value) {
  if (value === 'square') return 1;
  if (value === 'rectangle') return 3;
  return 4;
}

function EcommerceBusinessLogo({ business, logoUrl, logoAspect }) {
  const fallback = (business?.name || 'F').charAt(0).toUpperCase();
  const size = 40;
  const style = logoUrl
    ? { width: Math.min(size * logoAspectRatio(logoAspect), 160), background: '#ffffff', border: '1px solid rgba(0,0,0,0.08)' }
    : { width: size, background: '#16a34a' };
  return (
    <span
      className="flex h-10 shrink-0 items-center justify-center overflow-hidden rounded-xl text-base font-bold text-white shadow-sm"
      style={style}
      aria-hidden
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" className="h-full w-full object-contain p-1" />
      ) : fallback}
    </span>
  );
}

function TopBar({ tenant, business, navItems = [], activeKey, setTab, notificationsBell, isLive, onPublish, onUnpublish, storefrontUrl }) {
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const searchRef = useRef(null);
  const inputRef = useRef(null);
  const canToggleLive = typeof onPublish === 'function' || typeof onUnpublish === 'function';
  const query = search.trim();
  const searchResults = useMemo(
    () => buildEcommerceAdminSearchResults({ navItems, query, activeKey }),
    [activeKey, navItems, query]
  );
  const showLocationSwitcher = shouldShowLocationSwitcher({ business, activeKey });

  useEffect(() => {
    function onPointerDown(event) {
      if (searchRef.current && !searchRef.current.contains(event.target)) setSearchOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      const isCommandSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (!isCommandSearch) return;
      event.preventDefault();
      setSearchOpen(true);
      inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => { setActiveResult(0); }, [query, searchOpen]);

  function runResult(result = searchResults[0]) {
    if (!result) return;
    if (result.type === 'search') setTab(result.key, { q: query });
    else setTab(result.key);
    setSearchOpen(false);
  }

  function submitSearch(event) {
    event.preventDefault();
    if (!query) {
      setSearchOpen(true);
      inputRef.current?.focus();
      return;
    }
    runResult(searchResults[activeResult] || searchResults[0]);
  }

  function handleSearchKeyDown(event) {
    if (!searchOpen && ['ArrowDown', 'ArrowUp'].includes(event.key)) setSearchOpen(true);
    if (event.key === 'Escape') {
      setSearchOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!searchOpen || searchResults.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveResult((index) => (index + 1) % searchResults.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveResult((index) => (index - 1 + searchResults.length) % searchResults.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runResult(searchResults[activeResult] || searchResults[0]);
    }
  }

  async function handleToggleLive() {
    const action = isLive ? onUnpublish : onPublish;
    if (!action || publishing) return;
    setPublishing(true);
    try {
      await action();
    } finally {
      setPublishing(false);
    }
  }
  return (
    <header
      className="sticky top-0 z-20 backdrop-blur-md flex items-center gap-3 px-6 lg:px-10 py-3 border-b"
      style={{
        background: 'rgba(245, 247, 245, 0.85)',
        borderColor: 'rgba(0,0,0,0.05)',
      }}
    >
      {showLocationSwitcher && <EcommerceLocationSwitcher />}

      <form className="flex-1 max-w-2xl mx-auto relative" onSubmit={submitSearch} ref={searchRef}>
        <input
          ref={inputRef}
          type="search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search products, orders, customers…"
          className="w-full pl-10 pr-20 py-2 rounded-xl border text-sm focus:outline-none focus:border-emerald-500"
          style={{
            background: '#ffffff',
            borderColor: 'rgba(0,0,0,0.08)',
          }}
        />
        <button
          type="submit"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-gray-400 hover:text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          aria-label="Search admin"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
          </svg>
        </button>
        {query ? (
          <button
            type="submit"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-700"
          >
            Search
          </button>
        ) : (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">⌘K</span>
        )}
        {searchOpen && (
          <div className="absolute left-0 right-0 top-full mt-2 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
            <div className="border-b border-gray-100 px-4 py-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">
                {query ? `Search admin for "${query}"` : 'Quick admin shortcuts'}
              </p>
            </div>
            <div className="max-h-[360px] overflow-y-auto py-1">
              {searchResults.map((result, index) => (
                <button
                  key={`${result.type}-${result.key}`}
                  type="button"
                  onMouseEnter={() => setActiveResult(index)}
                  onClick={() => runResult(result)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                    index === activeResult ? 'bg-emerald-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-black ${
                    result.type === 'search' ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {result.type === 'search' ? '⌕' : '↗'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-gray-900">{result.label}</span>
                    <span className="mt-0.5 block truncate text-xs text-gray-500">{result.eyebrow} · {result.hint}</span>
                  </span>
                  {result.key === activeKey && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-emerald-700">Current</span>}
                </button>
              ))}
              {searchResults.length === 0 && (
                <div className="px-4 py-5 text-sm text-gray-500">No admin areas match this search.</div>
              )}
            </div>
          </div>
        )}
      </form>

      <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
        <LanguageSelector
          currentLocale={typeof document !== 'undefined' ? (document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1] || 'en') : 'en'}
          compact
        />
        {notificationsBell}
        <span className={`hidden lg:inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-mono tracking-wider ${isLive ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-600'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} /> {isLive ? 'LIVE' : 'OFFLINE'}
        </span>
        {canToggleLive && (
          <button
            type="button"
            onClick={handleToggleLive}
            disabled={publishing}
            className={`hidden xl:inline-flex rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60 ${isLive ? 'border border-red-200 bg-white text-red-600 hover:bg-red-50' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
          >
            {publishing ? (isLive ? 'Taking offline...' : 'Taking online...') : isLive ? 'Take offline' : 'Take online'}
          </button>
        )}
        {storefrontUrl && (
          <a
            href={storefrontUrl}
            target="_blank"
            rel="noopener"
            className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-all hover:shadow-sm"
            style={{ borderColor: 'rgba(0,0,0,0.08)', color: '#374151', background: '#ffffff' }}
          >
            View site <span aria-hidden>↗</span>
          </a>
        )}
      </div>
    </header>
  );
}

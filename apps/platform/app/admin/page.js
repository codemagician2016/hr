'use client';

import { useEffect, useMemo, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import axios from 'axios';
import Link from 'next/link';
import EmailDeliveryHistoryPanel from '@/components/EmailDeliveryHistoryPanel';
import NotificationAccessTab from '@/components/admin/NotificationAccessTab';
import { THEMES } from '@/lib/themes';
import { redirectToLogin } from '@/lib/loginRedirect';
import { getPlatformDomain } from '@/lib/platformDomain';
import { useConfirm } from '@/components/ConfirmDialog';

// ---------------- Nav metadata (shared by sidebar + page header) ----------------

const NAV_ITEMS = [
  { key: 'analytics',     label: 'Analytics',     sub: 'Revenue, MRR & growth trends',  icon: IconChart },
  { key: 'billing',       label: 'Billing',       sub: 'Payments, invoices, and subscription health', icon: IconCreditCard },
  { key: 'emails',        label: 'Emails',        sub: 'Delivery history and failures', icon: IconMail },
  { key: 'overview',      label: 'Overview',      sub: 'Platform at a glance',         icon: IconHome },
  { key: 'businesses',    label: 'Businesses',    sub: 'Every tenant on the platform', icon: IconBuilding },
  { key: 'notifications', label: 'Notifications', sub: 'Banners and broadcasts',       icon: IconBell },
  { key: 'messaging',     label: 'Messaging',     sub: 'SMS + WhatsApp gates and budgets', icon: IconBell },
  { key: 'support',       label: 'Support',       sub: 'Tenant support inbox', icon: IconMail },
  { key: 'pricing',       label: 'Pricing',       sub: 'Tiers, zones, country prices', icon: IconTag },
  { key: 'payments',      label: 'Payments',      sub: 'Buyer payments — integrated vs BYO', icon: IconCreditCard },
  { key: 'coupons',       label: 'Coupons',       sub: 'Subscription discount codes',   icon: IconTicket },
  { key: 'settings',      label: 'Settings',      sub: 'Integrations and your profile', icon: IconCog },
];

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = body;
    throw err;
  }
  return body;
}

async function performLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
  window.location.href = '/login';
}

// ---------------- Shell ----------------

function SuperAdminDashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [me, setMe] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | forbidden | error
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const confirm = useConfirm();

  // Derive active tab from URL — falls back to 'analytics'
  const VALID_KEYS = NAV_ITEMS.map((n) => n.key);
  const tab = VALID_KEYS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'analytics';

  const setTab = useCallback((key) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', key);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const [stats, setStats] = useState(null);
  const [businesses, setBusinesses] = useState([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const meRes = await axios.get('/api/auth/me', { withCredentials: true });
        setMe(meRes.data.user);

        if (meRes.data.user.role !== 'SUPER_ADMIN') {
          setStatus('forbidden');
          return;
        }

        const [s, b] = await Promise.all([
          axios.get('/api/admin/stats', { withCredentials: true }),
          axios.get('/api/admin/businesses', { withCredentials: true }),
        ]);
        setStats(s.data);
        setBusinesses(b.data.businesses);
        setStatus('ready');
      } catch (err) {
        if (err.response?.status === 401) { redirectToLogin(); return; }
        if (err.response?.status === 403) { setStatus('forbidden'); return; }
        setLoadError(err.response?.data?.message || 'Failed to load admin panel');
        setStatus('error');
      }
    }
    load();
  }, []);

  if (status === 'loading') {
    return <StatusScreen><Spinner /></StatusScreen>;
  }

  if (status === 'forbidden') {
    return (
      <StatusScreen>
        <div className="w-full max-w-md text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold shadow-lg"
            style={{ background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)' }}>S</div>
          <h1 className="mt-6 text-2xl font-bold text-gray-900">Super admin only</h1>
          <p className="mt-2 text-sm text-gray-500">
            This area is restricted to platform administrators. If you manage a business, visit your{' '}
            <a href="/dashboard/business" className="text-indigo-600 font-semibold hover:underline">business dashboard</a>.
          </p>
          <button onClick={performLogout}
            className="mt-8 inline-flex items-center justify-center px-5 py-2.5 text-sm font-semibold rounded-xl border border-gray-300 hover:border-gray-900 text-gray-900 transition-colors">
            Sign out
          </button>
        </div>
      </StatusScreen>
    );
  }

  if (status === 'error') {
    return (
      <StatusScreen>
        <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-xl px-5 py-3">{loadError}</p>
      </StatusScreen>
    );
  }

  const active = NAV_ITEMS.find((n) => n.key === tab) || NAV_ITEMS[0];

  return (
    <div className="min-h-screen bg-gray-50 lg:flex">
      {/* Sidebar — lg+ persistent, below-lg slide-in drawer */}
      <Sidebar
        tab={tab}
        onSelect={(k) => { setTab(k); setMobileNavOpen(false); }}
        me={me}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
      />

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar */}
        <header className="lg:hidden sticky top-0 z-30 bg-white border-b border-gray-200 px-4 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <BrandMark />
            <span className="font-semibold text-gray-900">HR Admin</span>
          </Link>
          <button onClick={() => setMobileNavOpen(true)} className="p-2 -mr-2 text-gray-600">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </header>

        {/* Page header */}
        <div className="border-b border-gray-200 bg-white">
          <div className="max-w-7xl mx-auto px-6 lg:px-10 py-7 flex items-end justify-between gap-6 flex-wrap">
            <div className="min-w-0">
              <p className="text-xs font-mono tracking-[0.18em] text-indigo-600 uppercase">{active.label}</p>
              <h1 className="mt-1 text-2xl md:text-3xl font-bold text-gray-900 tracking-tight">{active.sub}</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-[11px] font-mono tracking-wider text-emerald-700">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> LIVE
              </span>
              <a href="/" target="_blank" rel="noopener"
                className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-gray-200 hover:border-gray-900 text-sm text-gray-700 hover:text-gray-900 transition-colors">
                View site ↗
              </a>
            </div>
          </div>
        </div>

        <main className="flex-1 max-w-7xl w-full mx-auto px-6 lg:px-10 py-6 lg:py-8">
          {tab === 'analytics' && <AnalyticsDashboard businesses={businesses} />}
          {tab === 'billing' && <BillingTab businesses={businesses} />}
          {tab === 'emails' && <EmailsTab businesses={businesses} />}
          {tab === 'overview' && <OverviewTab stats={stats} />}
          {tab === 'businesses' && <BusinessesTab businesses={businesses} onReload={async () => {
            try {
              const { data } = await axios.get('/api/admin/businesses', { withCredentials: true });
              setBusinesses(data.businesses);
            } catch {}
          }} />}
          {tab === 'notifications' && <NotificationsTab businesses={businesses} />}
          {tab === 'messaging' && <NotificationAccessTab />}
          {tab === 'support' && <SupportConversationsTab />}
          {tab === 'pricing' && <PricingTab />}
          {tab === 'payments' && <PaymentsTab />}
          {tab === 'coupons' && <CouponsTab />}
          {tab === 'settings' && <SettingsTab me={me} />}
        </main>
      </div>
    </div>
  );
}

function SupportConversationsTab() {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function load({ keepLoading = false } = {}) {
    if (!keepLoading) setLoading(true);
    try {
      const data = await api('/api/admin/support/conversations');
      const rows = data.conversations || [];
      setConversations(rows);
      setSelectedId((current) => current || rows[0]?.id || null);
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to load support conversations');
    } finally {
      if (!keepLoading) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(() => load({ keepLoading: true }), 15000);
    return () => clearInterval(timer);
  }, []);

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) || conversations[0] || null,
    [conversations, selectedId]
  );

  async function sendReply(e) {
    e.preventDefault();
    if (!selected || !reply.trim()) return;
    setSending(true);
    try {
      await api(`/api/admin/support/conversations/${selected.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: reply }),
      });
      setReply('');
      await load({ keepLoading: true });
    } catch (err) {
      setError(err.message || 'Unable to send reply');
    } finally {
      setSending(false);
    }
  }

  if (loading) return <div className="rounded-2xl border border-gray-200 bg-white p-8 text-sm text-gray-500">Loading support conversations...</div>;

  return (
    <div className="grid min-h-[650px] overflow-hidden rounded-2xl border border-gray-200 bg-white lg:grid-cols-[360px,minmax(0,1fr)]">
      <div className="border-r border-gray-200">
        <div className="border-b border-gray-100 p-4">
          <h2 className="text-lg font-semibold text-gray-900">Tenant support</h2>
          <p className="mt-1 text-sm text-gray-500">Reply to businesses from the platform side.</p>
        </div>
        {conversations.length === 0 ? (
          <div className="p-5 text-sm text-gray-500">No support conversations yet.</div>
        ) : conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => setSelectedId(conversation.id)}
            className={`w-full border-b border-gray-100 p-4 text-left transition-colors ${selected?.id === conversation.id ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="truncate text-sm font-semibold text-gray-900">{conversation.business?.name || 'Business'}</p>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">{conversation.status}</span>
            </div>
            <p className="mt-1 truncate text-xs font-medium text-gray-700">{conversation.subject || 'Support request'}</p>
            <p className="mt-1 truncate text-xs text-gray-500">{conversation.messages?.at(-1)?.body || 'No messages'}</p>
          </button>
        ))}
      </div>
      {selected ? (
        <div className="flex min-w-0 flex-col">
          <div className="border-b border-gray-100 p-4">
            <h3 className="text-lg font-semibold text-gray-900">{selected.subject || 'Support request'}</h3>
            <p className="text-sm text-gray-500">{selected.business?.name} · {selected.business?.email || selected.business?.slug}</p>
          </div>
          {error && <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          <div className="flex-1 space-y-3 overflow-y-auto bg-gray-50 p-4">
            {(selected.messages || []).map((message) => {
              const mine = message.senderType === 'PLATFORM_ADMIN';
              return (
                <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[78%] rounded-2xl px-4 py-3 text-sm ${mine ? 'bg-indigo-600 text-white' : 'bg-white text-gray-900 border border-gray-200'}`}>
                    <p className="whitespace-pre-wrap">{message.body}</p>
                    <p className={`mt-2 text-[11px] ${mine ? 'text-indigo-100' : 'text-gray-400'}`}>{message.senderName || (mine ? 'Support' : 'Tenant')}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <form onSubmit={sendReply} className="border-t border-gray-100 p-4">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
              placeholder="Reply as HR support..."
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
            <div className="mt-3 flex justify-end">
              <button disabled={sending || !reply.trim()} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Send reply</button>
            </div>
          </form>
        </div>
      ) : (
        <div className="flex items-center justify-center p-8 text-sm text-gray-500">Select a conversation.</div>
      )}
    </div>
  );
}

// ---------------- Sidebar ----------------

function Sidebar({ tab, onSelect, me, open, onClose }) {
  return (
    <>
      {/* Mobile backdrop */}
      {open && <div className="lg:hidden fixed inset-0 z-40 bg-black/40" onClick={onClose} />}

      <aside
        className={`fixed lg:sticky top-0 z-50 inset-y-0 left-0 w-72 bg-white border-r border-gray-200 flex flex-col
          transition-transform lg:transition-none
          ${open ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 lg:h-screen`}
      >
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark />
            <div>
              <div className="font-semibold text-gray-900 leading-tight">HR Platform</div>
              <div className="text-[10px] font-mono tracking-[0.2em] text-indigo-600 uppercase">Super Admin</div>
            </div>
          </Link>
          <button className="lg:hidden p-1 text-gray-400 hover:text-gray-700" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = item.key === tab;
            return (
              <button
                key={item.key}
                onClick={() => onSelect(item.key)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700 font-semibold'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <Icon className={`w-5 h-5 shrink-0 ${isActive ? 'text-indigo-600' : 'text-gray-400'}`} />
                <span className="truncate">{item.label}</span>
                {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-500" />}
              </button>
            );
          })}
        </nav>

        <div className="px-4 py-4 border-t border-gray-100">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-semibold shrink-0"
              style={{ background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)' }}>
              {(me?.name || 'A').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-900 truncate">{me?.name || 'Admin'}</div>
              <div className="text-xs text-gray-500 truncate">{me?.email}</div>
            </div>
          </div>
          <button
            onClick={performLogout}
            className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-gray-700 hover:bg-red-50 hover:text-red-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}

export default function SuperAdminDashboard() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="w-8 h-8 rounded-full border-2 border-gray-200 border-t-indigo-600 animate-spin" /></div>}>
      <SuperAdminDashboardContent />
    </Suspense>
  );
}

function StatusScreen({ children }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      {children}
    </div>
  );
}

function BrandMark() {
  return (
    <span
      className="inline-flex w-9 h-9 rounded-xl items-center justify-center text-white font-bold text-sm shadow-sm"
      style={{ background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)' }}
      aria-hidden
    >
      A
    </span>
  );
}

// ---------------- Nav icons ----------------

function IconChart({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18M7 15l4-4 4 4 5-7" />
  </svg>);
}
function IconHome({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4a1 1 0 001-1v-5h2v5a1 1 0 001 1h4a1 1 0 001-1V10" />
  </svg>);
}
function IconBuilding({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V7a2 2 0 012-2h10a2 2 0 012 2v14M3 21h14M8 9h2m0 3H8m2 3H8m5-6h2m0 3h-2m2 3h-2M19 21v-8h2v8" />
  </svg>);
}
function IconBell({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>);
}
function IconTag({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5a2 2 0 011.41.59l7 7a2 2 0 010 2.82l-7 7a2 2 0 01-2.82 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
  </svg>);
}
function IconMail({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2zm0 1.5l8 6 8-6" />
  </svg>);
}
function IconCreditCard({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h3" />
  </svg>);
}
function IconCog({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>);
}
function IconTicket({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 5v2m0 4v2m0 4v2M5 5h14a2 2 0 012 2v3a2 2 0 000 4v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3a2 2 0 000-4V7a2 2 0 012-2z" />
  </svg>);
}

// ---------------- Overview ----------------

// ============================================================================
// Analytics Dashboard (graphical)
// ============================================================================
// Dynamic import to avoid SSR issues with Recharts
const LazyCharts = typeof window !== 'undefined' ? require('recharts') : {};
const { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } = LazyCharts;

const CHART_COLORS = ['#4f46e5', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#f97316'];

function AnalyticsDashboard({ businesses }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedBiz, setSelectedBiz] = useState(''); // '' = all
  const [days, setDays] = useState(30);

  useEffect(() => { loadDashboard(); }, [selectedBiz, days]);

  async function loadDashboard() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days });
      if (selectedBiz) params.set('businessId', selectedBiz);
      const { data: d } = await axios.get(`/api/admin/dashboard?${params}`, { withCredentials: true });
      setData(d);
    } catch {} finally { setLoading(false); }
  }

  if (loading && !data) return <div className="py-16 flex justify-center"><Spinner /></div>;
  if (!data) return null;

  const statusData = Object.entries(data.statusDistribution || {}).map(([name, value]) => ({ name, value }));

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 p-4 bg-white rounded-xl border border-gray-200">
        <div>
          <label className="text-xs font-medium text-gray-500 block mb-1">Business</label>
          <select value={selectedBiz} onChange={(e) => setSelectedBiz(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none min-w-[200px]">
            <option value="">All businesses</option>
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 block mb-1">Period</label>
          <div className="flex gap-1">
            {[7, 30, 90, 180].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${days === d ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {d === 7 ? '7D' : d === 30 ? '30D' : d === 90 ? '90D' : '6M'}
              </button>
            ))}
          </div>
        </div>
        {loading && <div className="ml-auto"><Spinner /></div>}
      </div>

      {/* Row 1: Bookings trend + Status pie */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Activity trend</h3>
          {ResponsiveContainer && data.dailyBookings?.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data.dailyBookings}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={v => v.slice(5)} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={v => `Date: ${v}`} />
                <Line type="monotone" dataKey="bookings" stroke="#4f46e5" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[280px] flex items-center justify-center text-sm text-gray-400">No activity data for this period</div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Status distribution</h3>
          {PieChart && statusData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={statusData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                  {statusData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No data</div>
          )}
        </div>
      </div>

      {/* Row 2: Day of week + Hourly distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Activity by day of week</h3>
          {BarChart && data.bookingsByDow?.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.bookingsByDow}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="count" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No data</div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Peak activity hours</h3>
          {BarChart && data.hourlyDistribution?.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.hourlyDistribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="hour" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="count" fill="#06b6d4" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No data</div>
          )}
        </div>
      </div>

      {/* Row 3: Revenue by service + Staff performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Revenue by service</h3>
          {BarChart && data.revenueByService?.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.revenueByService} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `$${v}`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={100} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={v => `$${v}`} />
                <Bar dataKey="revenue" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No revenue data</div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Staff performance</h3>
          {BarChart && data.staffPerformance?.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.staffPerformance} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={100} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="appointments" fill="#8b5cf6" radius={[0, 4, 4, 0]} name="Appointments" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No staff data</div>
          )}
        </div>
      </div>

      {/* Row 4: Customer growth + Session duration */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Customer growth</h3>
          {LineChart && data.customerGrowth?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data.customerGrowth}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Line type="monotone" dataKey="new_customers" stroke="#ec4899" strokeWidth={2} name="New customers" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-sm text-gray-400">No customer data</div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Appointment duration</h3>
          {PieChart && data.bookingDuration?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={data.bookingDuration} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="count" nameKey="duration_bucket">
                  {data.bookingDuration.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-sm text-gray-400">No data</div>
          )}
        </div>
      </div>

      {/* Row 5: Business locations (geo-like grid) */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Business locations & performance</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
              <tr>
                <th className="py-2 text-left pr-4">Business</th>
                <th className="py-2 text-left pr-4">Category</th>
                <th className="py-2 text-left pr-4">Location</th>
                <th className="py-2 text-right pr-4">Customers</th>
                <th className="py-2 text-right pr-4">Bookings</th>
                <th className="py-2 text-right">Domain</th>
              </tr>
            </thead>
            <tbody>
              {(data.businessLocations || []).map(b => (
                <tr key={b.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-2.5 pr-4 font-medium text-gray-900">{b.name}</td>
                  <td className="py-2.5 pr-4">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{b.category || '—'}</span>
                  </td>
                  <td className="py-2.5 pr-4 text-gray-600 text-xs">{b.address || '—'}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{b.customers}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{b.appointments}</td>
                  <td className="py-2.5 text-right">
                    <a href={`https://${b.domain}`} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-indigo-600 hover:underline">{b.domain}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Row 6: Top businesses ranking */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Top tenants by activity</h3>
        {BarChart && data.topBusinesses?.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.topBusinesses}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="bookings" radius={[4, 4, 0, 0]}>
                {data.topBusinesses.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[250px] flex items-center justify-center text-sm text-gray-400">No data</div>
        )}
      </div>
    </div>
  );
}

function OverviewTab({ stats }) {
  if (!stats) return null;

  const cards = [
    { label: 'Total businesses', value: stats.totalBusinesses, tint: 'bg-indigo-50 text-indigo-700' },
    { label: 'Active subscriptions', value: stats.activeSubscriptions, tint: 'bg-emerald-50 text-emerald-700' },
    { label: 'Total staff', value: stats.totalStaff, tint: 'bg-amber-50 text-amber-700' },
    { label: 'Total appointments', value: stats.totalAppointments, tint: 'bg-pink-50 text-pink-700' },
  ];

  // Make sure every canonical tier is represented (even if zero)
  const canonical = ['free', 'starter', 'professional', 'business'];
  const byTier = Object.fromEntries((stats.businessesPerTier || []).map((p) => [p.tierSlug, p]));
  const planRows = canonical.map((slug) => ({
    slug,
    name: byTier[slug]?.tierName || capitalize(slug),
    count: byTier[slug]?.count || 0,
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="bg-white rounded-2xl border border-gray-200 p-5">
            <p className="text-xs uppercase tracking-wide text-gray-500">{c.label}</p>
            <p className={`text-3xl font-bold mt-2 inline-block px-3 py-1 rounded-lg ${c.tint}`}>
              {c.value}
            </p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900">Businesses by plan</h2>
        <p className="text-sm text-gray-500 mt-1 mb-4">Subscription distribution across the 4 plans.</p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {planRows.map((p) => (
            <div key={p.slug} className="border border-gray-200 rounded-xl p-4 text-center">
              <p className="text-xs uppercase tracking-wide text-gray-500">{p.name}</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{p.count}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const BILLING_STATUS_STYLES = {
  COMPLETED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  BILLED: 'bg-blue-100 text-blue-700 border-blue-200',
  READY: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  CHECKOUT_CREATED: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  PAST_DUE: 'bg-amber-100 text-amber-700 border-amber-200',
  PAYMENT_FAILED: 'bg-rose-100 text-rose-700 border-rose-200',
  FAILED: 'bg-rose-100 text-rose-700 border-rose-200',
  CANCELED: 'bg-gray-100 text-gray-600 border-gray-200',
};

function formatCurrencySummary(map, field = 'totalMinor') {
  const entries = Object.entries(map || {}).filter(([, value]) => value?.[field] != null);
  if (!entries.length) return '—';
  return entries
    .slice(0, 2)
    .map(([currency, value]) => formatCurrencyMinor(value[field], currency))
    .join(' · ');
}

// India GST (GSTR-1) export for the platform owner (Paperbyte). Downloads the
// self-billed Razorpay invoices for a period as CSV.
function IndiaGstReportCard() {
  const today = new Date();
  const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const [from, setFrom] = useState(`${fyStartYear}-04-01`);
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  function buildUrl(format) {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (format) p.set('format', format);
    return `/api/admin/gst/india-invoices?${p.toString()}`;
  }
  async function loadPreview() {
    setLoading(true);
    try {
      const res = await axios.get(buildUrl('json'), { withCredentials: true });
      setPreview(res.data);
    } catch { setPreview(null); } finally { setLoading(false); }
  }

  const inputCls = 'mt-1 block rounded-lg border border-gray-300 px-3 py-2 text-sm';
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-900">India GST report (GSTR-1)</h3>
      <p className="text-xs text-gray-500 mt-0.5">
        Self-billed Razorpay invoices (Paperbyte) for a period — B2B + B2C with buyer GSTIN and CGST/SGST/IGST, ready to reconcile against GSTR-1.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-gray-600">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} /></label>
        <label className="text-xs font-medium text-gray-600">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} /></label>
        <button type="button" onClick={loadPreview} disabled={loading} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          {loading ? 'Loading…' : 'Preview'}
        </button>
        <a href={buildUrl('csv')} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800">Download CSV</a>
      </div>
      {preview && (
        <p className="mt-2 text-xs text-gray-600">{preview.count} invoice(s) in range{preview.count ? ` — ${preview.rows.filter((r) => r.type === 'B2B').length} B2B, ${preview.rows.filter((r) => r.type === 'B2C').length} B2C` : ''}.</p>
      )}
    </div>
  );
}

function BillingTab({ businesses }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [invoiceBusy, setInvoiceBusy] = useState('');
  const [filters, setFilters] = useState({ businessId: '', status: 'all' });

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.businessId, filters.status]);

  async function load({ append = false } = {}) {
    if (append) setLoadingMore(true);
    else setLoading(true);
    if (!append) setError('');

    try {
      const params = new URLSearchParams();
      if (filters.businessId) params.set('businessId', filters.businessId);
      if (filters.status && filters.status !== 'all') params.set('status', filters.status);
      if (append && data?.pagination?.nextAfter) params.set('after', data.pagination.nextAfter);
      const query = params.toString();
      const res = await axios.get(`/api/admin/billing${query ? `?${query}` : ''}`, { withCredentials: true });
      const payload = res.data;
      setData((prev) => {
        if (!append) return payload;
        const seen = new Set((prev?.transactions || []).map((txn) => txn.id));
        return {
          ...payload,
          transactions: [
            ...(prev?.transactions || []),
            ...(payload.transactions || []).filter((txn) => !seen.has(txn.id)),
          ],
        };
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load billing activity');
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }

  async function openInvoice(transactionId) {
    setInvoiceBusy(transactionId);
    const previewWindow = typeof window !== 'undefined'
      ? window.open('', '_blank', 'noopener,noreferrer')
      : null;
    try {
      const res = await axios.post(`/api/admin/billing/invoices/${transactionId}`, {}, { withCredentials: true });
      if (res.data?.url) {
        if (previewWindow) previewWindow.location.href = res.data.url;
        else window.location.href = res.data.url;
      } else if (previewWindow) {
        previewWindow.close();
      }
    } catch (err) {
      if (previewWindow) previewWindow.close();
      alert(err.response?.data?.message || 'Could not open invoice PDF');
    } finally {
      setInvoiceBusy('');
    }
  }

  const cards = [
    { label: 'Businesses with Paddle', value: data?.summary?.businessesWithPaddleCustomer ?? '—', tint: 'bg-indigo-50 text-indigo-700' },
    { label: 'Paid subscriptions', value: data?.summary?.paidSubscriptions ?? '—', tint: 'bg-emerald-50 text-emerald-700' },
    { label: 'Past due', value: data?.summary?.pastDueSubscriptions ?? '—', tint: 'bg-amber-50 text-amber-700' },
    { label: 'Scheduled downgrades', value: data?.summary?.scheduledDowngrades ?? '—', tint: 'bg-rose-50 text-rose-700' },
    { label: 'Ledger purchases', value: data?.summary?.ledgerPurchases ?? '—', tint: 'bg-sky-50 text-sky-700' },
    { label: 'Gross collected', value: formatCurrencySummary(data?.summary?.grossByCurrency), tint: 'bg-teal-50 text-teal-700' },
  ];

  return (
    <div className="space-y-6">
      <IndiaGstReportCard />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div key={card.label} className="bg-white rounded-2xl border border-gray-200 p-5">
            <p className="text-xs uppercase tracking-wide text-gray-500">{card.label}</p>
            <p className={`text-3xl font-bold mt-2 inline-block px-3 py-1 rounded-lg ${card.tint}`}>
              {card.value}
            </p>
          </div>
        ))}
      </div>

      {!data?.configured && !loading && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Paddle is not configured, so invoice PDFs cannot be opened. The payment ledger below is still available.
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Recent payments</h2>
            <p className="text-sm text-gray-500">Local payment ledger across plans, domains, mailboxes, messaging top-ups, taxes, and adjustments.</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <select
              value={filters.businessId}
              onChange={(e) => setFilters((prev) => ({ ...prev, businessId: e.target.value }))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All businesses</option>
              {businesses.map((business) => (
                <option key={business.id} value={business.id}>{business.name}</option>
              ))}
            </select>

            <select
              value={filters.status}
              onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value }))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="all">All statuses</option>
              <option value="completed">Completed</option>
              <option value="past_due">Past due</option>
              <option value="ready">Ready</option>
              <option value="billed">Billed</option>
            </select>
          </div>
        </div>

        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">{error}</p>}

        {loading ? (
          <div className="py-10 flex justify-center"><Spinner /></div>
        ) : (data?.transactions || []).length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-xl">
            No billing activity matches these filters yet.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                  <tr>
                    <th className="py-3 pr-4">Date</th>
                    <th className="py-3 pr-4">Business</th>
                    <th className="py-3 pr-4">Plan</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4">Total</th>
                    <th className="py-3 pr-4">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.transactions || []).map((txn) => (
                    <tr key={txn.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                      <td className="py-3 pr-4 text-gray-700 whitespace-nowrap">
                        {formatDateTime(txn.billedAt || txn.createdAt)}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="font-medium text-gray-900">{txn.business?.name || 'Unknown business'}</div>
                        <div className="text-xs text-gray-500">/{txn.business?.slug || 'unknown'}</div>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="font-medium text-gray-900">{txn.plan?.name || 'Plan'}</div>
                        <div className="text-xs text-gray-500">{txn.invoiceNumber || txn.id}</div>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex px-2 py-0.5 rounded-full border text-xs font-semibold ${BILLING_STATUS_STYLES[txn.status] || BILLING_STATUS_STYLES.CANCELED}`}>
                          {txn.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-3 pr-4 font-medium text-gray-900 whitespace-nowrap">
                        {formatCurrencyMinor(txn.totalMinor, txn.currencyCode)}
                      </td>
                      <td className="py-3 pr-4">
                        {txn.hasInvoice ? (
                          <button
                            onClick={() => openInvoice(txn.id)}
                            disabled={invoiceBusy === txn.id}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50"
                          >
                            {invoiceBusy === txn.id && <span className="text-[10px]">…</span>}
                            PDF invoice
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">Not ready yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data?.pagination?.nextAfter && (
              <div className="mt-4 flex justify-center">
                <button
                  onClick={() => load({ append: true })}
                  disabled={loadingMore}
                  className="px-4 py-2 rounded-xl border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EmailsTab({ businesses }) {
  return (
    <EmailDeliveryHistoryPanel
      endpoint="/api/admin/email-deliveries"
      title="Platform email activity"
      description="Review delivery history across all businesses, filter failures, and confirm transactional email coverage."
      businesses={businesses}
      showBusinessColumn
      emptyMessage="No tracked platform email activity yet."
    />
  );
}

// ---------------- Businesses ----------------

const STATUS_STYLES = {
  ACTIVE:    'bg-emerald-100 text-emerald-700 border-emerald-200',
  TRIALING:  'bg-blue-100 text-blue-700 border-blue-200',
  PAST_DUE:  'bg-amber-100 text-amber-700 border-amber-200',
  CANCELLED: 'bg-red-100 text-red-700 border-red-200',
  EXPIRED:   'bg-gray-100 text-gray-500 border-gray-200',
};

// Billing lifecycle stage (from billingAccessState) → label + chip style. This
// is what the STATUS column shows: the tenant's TRUE stage, not the raw gateway
// status (which reads ACTIVE even on a free/lapsed tenant).
const STAGE_STYLES = {
  active:     { label: 'ACTIVE',     cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  grace:      { label: 'GRACE',      cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  expired:    { label: 'EXPIRED',    cls: 'bg-rose-100 text-rose-700 border-rose-200' },
  onboarding: { label: 'ONBOARDING', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
};

const PLATFORM_DOMAIN = getPlatformDomain();

function BusinessesTab({ businesses, onReload }) {
  const [search, setSearch] = useState('');
  const [pendingId, setPendingId] = useState(null);
  const [suspendReason, setSuspendReason] = useState('');
  const [showSuspendModal, setShowSuspendModal] = useState(null);
  const [analyticsId, setAnalyticsId] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteTyped, setDeleteTyped] = useState('');

  async function deleteBusiness(target, typedSlug) {
    if (typedSlug !== target.slug) return;
    setPendingId(target.id);
    try {
      await axios.delete(
        `/api/admin/businesses/${target.id}?confirmSlug=${encodeURIComponent(typedSlug)}`,
        { withCredentials: true },
      );
      setDeleteTarget(null);
      setDeleteTyped('');
      onReload?.();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    } finally { setPendingId(null); }
  }

  async function loadAnalytics(id) {
    setAnalyticsId(id);
    setAnalyticsLoading(true);
    setAnalytics(null);
    try {
      const { data } = await axios.get(`/api/admin/businesses/${id}/analytics`, { withCredentials: true });
      setAnalytics(data);
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to load analytics');
      setAnalyticsId(null);
    } finally { setAnalyticsLoading(false); }
  }

  async function toggleSuspend(id, suspend, reason) {
    setPendingId(id);
    try {
      await axios.put(`/api/admin/businesses/${id}/suspend`, { suspend, reason }, { withCredentials: true });
      setShowSuspendModal(null);
      setSuspendReason('');
      onReload?.();
    } catch (err) {
      alert(err.response?.data?.message || 'Failed');
    } finally { setPendingId(null); }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return businesses;
    return businesses.filter((b) =>
      b.name.toLowerCase().includes(q)
      || b.slug.toLowerCase().includes(q)
      || (b.admin?.email?.toLowerCase().includes(q))
    );
  }, [businesses, search]);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">All businesses</h2>
          <p className="text-sm text-gray-500">{businesses.length} total</p>
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, slug, or admin email..."
          className="w-full sm:w-80 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-gray-500">
          {businesses.length === 0 ? 'No businesses yet.' : 'No matches.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
              <tr>
                <th className="py-3 pr-4">Business</th>
                <th className="py-3 pr-4">Admin email</th>
                <th className="py-3 pr-4">Plan</th>
                <th className="py-3 pr-4">Theme</th>
                <th className="py-3 pr-4">Status</th>
                <th className="py-3 pr-4 text-right">Employees</th>
                <th className="py-3 pr-4 text-right">Records</th>
                <th className="py-3 pr-4">Joined</th>
                <th className="py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((b) => {
                const stage = STAGE_STYLES[b.billingStage] || STAGE_STYLES.expired;
                const bs = b.billing || {};
                let billingNote = null;
                if (bs.promo && bs.lifetime) billingNote = `${bs.promo.label} · no renewal needed`;
                else if (bs.promo) billingNote = `Promo: ${bs.promo.label}${bs.renewsAt ? ` · until ${formatDate(bs.renewsAt)}` : ''}`;
                else if (bs.lifetime && b.billingStage === 'active') billingNote = 'No renewal (lifetime)';
                else if (b.billingStage === 'active' && bs.renewsAt) billingNote = `Renews ${formatDate(bs.renewsAt)}`;
                const theme = b.subscription?.theme || 'default';
                const themeColor = THEMES[theme]?.primaryColor || '#4f46e5';
                const siteUrl = `https://${b.slug}.${PLATFORM_DOMAIN}`;
                const isSuspended = !b.isActive;
                return (
                  <tr key={b.id} className={`border-b border-gray-100 last:border-b-0 hover:bg-gray-50 ${isSuspended ? 'opacity-60' : ''}`}>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <button onClick={() => loadAnalytics(b.id)} className="font-medium text-indigo-600 hover:underline text-left">
                          {b.name}
                        </button>
                        {isSuspended && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">SUSPENDED</span>}
                      </div>
                      <div className="text-xs text-gray-500">/{b.slug}</div>
                      <div className="text-[11px] text-gray-400 font-mono">ID {b.shortId || '—'}</div>
                    </td>
                    <td className="py-3 pr-4 text-gray-700">
                      {b.admin?.email || <span className="text-gray-400 italic">— none —</span>}
                    </td>
                    <td className="py-3 pr-4 text-gray-700">{b.subscription?.tier?.name || '—'}</td>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: themeColor }} />
                        <span className="text-gray-700 capitalize">{theme}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${stage.cls}`}>
                        {stage.label}
                      </span>
                      {billingNote && (
                        <div className="text-[10px] text-gray-500 mt-1" title={bs.promo?.code ? `Coupon ${bs.promo.code}` : undefined}>
                          {bs.promo && <span className="text-emerald-600">★ </span>}{billingNote}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums text-gray-700">{b.staffCount}</td>
                    <td className="py-3 pr-4 text-right tabular-nums text-gray-700">{b.appointmentCount}</td>
                    <td className="py-3 pr-4 text-gray-500 whitespace-nowrap">{formatDate(b.createdAt)}</td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <a href={siteUrl} target="_blank" rel="noopener noreferrer"
                          className="w-7 h-7 rounded-lg flex items-center justify-center border border-gray-200 hover:bg-gray-100 transition-colors"
                          title="Visit website">
                          <svg className="w-3.5 h-3.5 text-gray-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </a>
                        <a href={`/${b.slug}/admin`} target="_blank" rel="noopener noreferrer"
                          className="px-2.5 py-1 text-[10px] font-semibold rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                          title="Open this tenant's admin as an operator (impersonate)">
                          Impersonate
                        </a>
                        {isSuspended ? (
                          <button onClick={() => toggleSuspend(b.id, false)} disabled={pendingId === b.id}
                            className="px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50">
                            {pendingId === b.id ? '...' : 'Resume'}
                          </button>
                        ) : (
                          <button onClick={() => setShowSuspendModal(b.id)} disabled={pendingId === b.id}
                            className="px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50">
                            Pause
                          </button>
                        )}
                        <button onClick={() => { setDeleteTarget(b); setDeleteTyped(''); }} disabled={pendingId === b.id}
                          className="px-2.5 py-1 text-[10px] font-semibold rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
                          title="Permanently delete this tenant and ALL its data">
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Suspend modal with reason */}
      {showSuspendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setShowSuspendModal(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900">Suspend business</h3>
            <p className="text-sm text-gray-500 mt-1">
              This will take their website offline immediately. Customers will see a suspension notice.
            </p>
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Reason (shown to visitors)</label>
              <input type="text" value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)}
                placeholder="e.g. Policy violation, payment issue"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none" />
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowSuspendModal(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              <button onClick={() => toggleSuspend(showSuspendModal, true, suspendReason || 'Suspended by platform admin')}
                disabled={pendingId === showSuspendModal}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50">
                {pendingId === showSuspendModal ? 'Suspending...' : 'Suspend'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal — destructive, requires typing the slug */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900">Delete &ldquo;{deleteTarget.name}&rdquo;?</h3>
            <p className="text-sm text-gray-600 mt-2">
              This permanently deletes the tenant and ALL its data — users, appointments,
              products, pages, orders, customers. <strong className="text-red-700">This cannot be undone.</strong>
            </p>
            <p className="text-sm text-gray-700 mt-4 mb-1">
              Type <code className="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-red-700">{deleteTarget.slug}</code> to confirm:
            </p>
            <input
              type="text"
              value={deleteTyped}
              onChange={(e) => setDeleteTyped(e.target.value)}
              autoFocus
              placeholder={deleteTarget.slug}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              <button
                onClick={() => deleteBusiness(deleteTarget, deleteTyped)}
                disabled={deleteTyped !== deleteTarget.slug || pendingId === deleteTarget.id}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 disabled:cursor-not-allowed">
                {pendingId === deleteTarget.id ? 'Deleting...' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Analytics modal */}
      {analyticsId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setAnalyticsId(null)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            {analyticsLoading ? (
              <div className="py-20 flex justify-center"><Spinner /></div>
            ) : analytics ? (
              <div className="p-6 md:p-8">
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">{analytics.business.name}</h2>
                    <p className="text-xs text-gray-500 mt-0.5">Member since {formatDate(analytics.business.memberSince)} · /{analytics.business.slug}</p>
                  </div>
                  <button onClick={() => setAnalyticsId(null)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-100">✕</button>
                </div>

                {/* Overview cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                  {[
                    { label: 'Customers', value: analytics.overview.totalCustomers, color: 'text-indigo-700 bg-indigo-50' },
                    { label: 'Staff', value: analytics.overview.totalStaff, color: 'text-emerald-700 bg-emerald-50' },
                    { label: 'Total bookings', value: analytics.overview.totalAppointments, color: 'text-amber-700 bg-amber-50' },
                    { label: 'Est. revenue', value: `$${analytics.overview.estimatedRevenue}`, color: 'text-pink-700 bg-pink-50' },
                  ].map((c, i) => (
                    <div key={i} className="rounded-xl border border-gray-100 p-4">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">{c.label}</p>
                      <p className={`text-2xl font-bold mt-1 ${c.color} inline-block px-2 py-0.5 rounded-lg`}>{c.value}</p>
                    </div>
                  ))}
                </div>

                {/* Activity cards */}
                <div className="grid grid-cols-3 gap-3 mb-6">
                  <div className="rounded-xl border border-gray-100 p-4 text-center">
                    <p className="text-2xl font-bold text-gray-900">{analytics.overview.todayAppointments}</p>
                    <p className="text-xs text-gray-500 mt-1">Today</p>
                  </div>
                  <div className="rounded-xl border border-gray-100 p-4 text-center">
                    <p className="text-2xl font-bold text-gray-900">{analytics.overview.weekAppointments}</p>
                    <p className="text-xs text-gray-500 mt-1">This week</p>
                  </div>
                  <div className="rounded-xl border border-gray-100 p-4 text-center">
                    <p className="text-2xl font-bold text-gray-900">{analytics.overview.monthAppointments}</p>
                    <p className="text-xs text-gray-500 mt-1">This month</p>
                    {analytics.overview.growthRate !== 'N/A' && (
                      <p className={`text-xs mt-1 font-semibold ${parseFloat(analytics.overview.growthRate) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {parseFloat(analytics.overview.growthRate) >= 0 ? '↑' : '↓'} {analytics.overview.growthRate} vs last month
                      </p>
                    )}
                  </div>
                </div>

                {/* Status breakdown */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                  <div className="rounded-xl border border-gray-100 p-4">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">Booking status</h3>
                    <div className="space-y-2">
                      {Object.entries(analytics.statusBreakdown || {}).map(([status, count]) => {
                        const colors = { PENDING: 'bg-amber-500', CONFIRMED: 'bg-emerald-500', COMPLETED: 'bg-blue-500', CANCELLED: 'bg-gray-400' };
                        const total = analytics.overview.totalAppointments || 1;
                        return (
                          <div key={status} className="flex items-center gap-3">
                            <span className="text-xs w-20 text-gray-600">{status}</span>
                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${colors[status] || 'bg-gray-300'}`} style={{ width: `${(count / total) * 100}%` }} />
                            </div>
                            <span className="text-xs font-semibold text-gray-700 w-8 text-right">{count}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-100 p-4">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">Popular services</h3>
                    {(analytics.popularServices || []).length === 0 ? (
                      <p className="text-xs text-gray-500">No bookings yet</p>
                    ) : (
                      <div className="space-y-2">
                        {analytics.popularServices.map((s, i) => (
                          <div key={i} className="flex items-center justify-between">
                            <span className="text-sm text-gray-700">{s.name}</span>
                            <span className="text-xs font-semibold text-gray-500">{s.bookings} bookings · ${s.price}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Staff utilization + busiest day */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                  <div className="rounded-xl border border-gray-100 p-4">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">Staff utilization</h3>
                    {(analytics.staffUtilization || []).length === 0 ? (
                      <p className="text-xs text-gray-500">No data</p>
                    ) : (
                      <div className="space-y-2">
                        {analytics.staffUtilization.map((s, i) => (
                          <div key={i} className="flex items-center justify-between">
                            <span className="text-sm text-gray-700">{s.name}</span>
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{s.appointments} appts</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-gray-100 p-4">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">Insights</h3>
                    <div className="space-y-3 text-sm">
                      {analytics.busiestDay && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Busiest day:</span>
                          <span className="text-xs font-semibold text-gray-900">{analytics.busiestDay.day} ({analytics.busiestDay.count} bookings)</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Avg bookings/month:</span>
                        <span className="text-xs font-semibold text-gray-900">
                          {analytics.monthlyTrend?.length > 0 ? Math.round(analytics.monthlyTrend.reduce((s, m) => s + m.count, 0) / analytics.monthlyTrend.length) : 0}
                        </span>
                      </div>
                    </div>

                    {/* Monthly trend mini chart */}
                    {analytics.monthlyTrend?.length > 0 && (
                      <div className="mt-4">
                        <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Monthly trend</p>
                        <div className="flex items-end gap-1 h-16">
                          {analytics.monthlyTrend.map((m, i) => {
                            const max = Math.max(...analytics.monthlyTrend.map(x => x.count), 1);
                            return (
                              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                <div className="w-full bg-indigo-500 rounded-t" style={{ height: `${(m.count / max) * 100}%`, minHeight: 2 }} />
                                <span className="text-[8px] text-gray-400">{m.month.slice(5)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Recent customers */}
                <div className="rounded-xl border border-gray-100 p-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent customers</h3>
                  {(analytics.recentCustomers || []).length === 0 ? (
                    <p className="text-xs text-gray-500">No customers yet</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {analytics.recentCustomers.map((c) => (
                        <div key={c.id} className="flex items-center gap-2 text-sm">
                          <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-600">
                            {c.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-gray-900 truncate">{c.name}</p>
                            <p className="text-[10px] text-gray-500 truncate">{c.email}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Coupons (subscription discount codes) ----------------

function CouponsTab() {
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | coupon object
  const [viewingRedemptions, setViewingRedemptions] = useState(null);
  const [savingId, setSavingId] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/admin/subscription-coupons');
      setCoupons(data.coupons || []);
    } catch (err) {
      setError(err.message || 'Failed to load coupons');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleSave(payload) {
    setSavingId(payload.id || 'new');
    try {
      if (payload.id) {
        await api(`/api/admin/subscription-coupons/${payload.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/admin/subscription-coupons', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setEditing(null);
      await load();
    } catch (err) {
      alert(err.message || 'Save failed');
    } finally {
      setSavingId(null);
    }
  }

  async function handleToggle(coupon) {
    if (!await confirm(`${coupon.isActive ? 'Deactivate' : 'Reactivate'} coupon "${coupon.code}"?`, { confirmLabel: coupon.isActive ? 'Deactivate' : 'Reactivate' })) return;
    try {
      if (coupon.isActive) {
        await api(`/api/admin/subscription-coupons/${coupon.id}`, { method: 'DELETE' });
      } else {
        await api(`/api/admin/subscription-coupons/${coupon.id}`, {
          method: 'PUT',
          body: JSON.stringify({ isActive: true }),
        });
      }
      await load();
    } catch (err) {
      alert(err.message || 'Action failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Subscription coupons</h1>
          <p className="text-sm text-gray-500 mt-1">
            Create subscription credits and Paddle checkout discounts for launch, retention, and account-specific offers.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700"
        >
          + New coupon
        </button>
      </div>

      {loading && <div className="py-8 flex justify-center"><AdminSpinner /></div>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && !error && (
        coupons.length === 0 ? (
          <div className="border border-dashed border-gray-200 rounded-xl py-14 text-center">
            <p className="text-sm font-medium text-gray-900">No coupons yet</p>
            <p className="text-xs text-gray-500 mt-1">Create your first code to offer Paddle discounts, lifetime access, or launch promotions.</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 text-left">
                <tr>
                  <th className="px-4 py-3 font-semibold text-gray-700">Code</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Benefit</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Limits</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Uses</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Status</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-mono font-bold text-gray-900">{c.code}</p>
                      {c.description && <p className="text-xs text-gray-500 mt-0.5 max-w-[220px] truncate">{c.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{describeBenefit(c)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {describeRestrictions(c) || <span className="text-gray-400">No restrictions</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-gray-900">{c.usedCount}</span>
                      {c.maxTotalUses && <span className="text-gray-400"> / {c.maxTotalUses}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {c.isActive ? (
                        <span className="text-[10px] font-semibold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">Active</span>
                      ) : (
                        <span className="text-[10px] font-semibold bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Inactive</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        <button onClick={() => setViewingRedemptions(c)} className="text-xs font-semibold text-gray-600 hover:text-gray-900">Redemptions</button>
                        <button onClick={() => setEditing(c)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">Edit</button>
                        <button onClick={() => handleToggle(c)} className="text-xs font-semibold text-rose-600 hover:text-rose-800">
                          {c.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {editing && (
        <CouponForm
          coupon={editing === 'new' ? null : editing}
          saving={savingId !== null}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      {viewingRedemptions && (
        <RedemptionsDrawer coupon={viewingRedemptions} onClose={() => setViewingRedemptions(null)} />
      )}
    </div>
  );
}

function describeBenefit(c) {
  if (c.benefitType === 'LIFETIME_FREE') return 'Lifetime free';
  if (c.benefitType === 'FREE_PERIOD') {
    const unit = c.benefitUnit === 'MONTHS' ? 'month' : 'day';
    const val = Number(c.benefitValue) || 0;
    return `${val} ${unit}${val === 1 ? '' : 's'} free`;
  }
  if (c.benefitType === 'PERCENT_OFF') return `${c.benefitValue}% off at Paddle checkout`;
  if (c.benefitType === 'FIXED_OFF') return `${c.benefitCurrency || ''} ${c.benefitValue} off at Paddle checkout`;
  return c.benefitType;
}

function describeRestrictions(c) {
  const parts = [];
  if (c.allowedCountries?.length) parts.push(`Countries: ${c.allowedCountries.join(', ')}`);
  if (c.allowedEmails?.length)    parts.push(`Emails: ${c.allowedEmails.length}`);
  if (c.allowedBusinessIds?.length) parts.push(`Businesses: ${c.allowedBusinessIds.length}`);
  if (c.applicableTiers?.length)  parts.push(`Tiers: ${c.applicableTiers.join(', ')}`);
  if (c.firstSubscriptionOnly)    parts.push('First sub only');
  if (c.validUntil) parts.push(`Until ${new Date(c.validUntil).toISOString().slice(0, 10)}`);
  return parts.join(' · ');
}

function CouponForm({ coupon, saving, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    id: coupon?.id || null,
    code: coupon?.code || '',
    description: coupon?.description || '',
    benefitType: coupon?.benefitType || 'FREE_PERIOD',
    benefitValue: coupon?.benefitValue ?? '',
    benefitUnit: coupon?.benefitUnit || 'MONTHS',
    benefitCurrency: coupon?.benefitCurrency || '',
    allowedCountries: coupon?.allowedCountries || [],
    allowedEmails: (coupon?.allowedEmails || []).join(', '),
    allowedBusinessIds: (coupon?.allowedBusinessIds || []).join(', '),
    applicableTiers: coupon?.applicableTiers || [],
    validFrom: coupon?.validFrom ? new Date(coupon.validFrom).toISOString().slice(0, 10) : '',
    validUntil: coupon?.validUntil ? new Date(coupon.validUntil).toISOString().slice(0, 10) : '',
    maxTotalUses: coupon?.maxTotalUses ?? '',
    maxPerUser: coupon?.maxPerUser ?? 1,
    firstSubscriptionOnly: !!coupon?.firstSubscriptionOnly,
  }));

  // Fetch the country + tier catalogues from the same pricing endpoints
  // the super-admin Pricing tab already uses, so there's one source of
  // truth for "which countries exist" and "which plan slugs exist".
  const [countries, setCountries] = useState(null);
  const [tiers, setTiers] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cData, tData] = await Promise.all([
          api('/api/admin/pricing/countries'),
          api('/api/admin/pricing/tiers'),
        ]);
        if (!cancelled) {
          setCountries(cData.countries || []);
          setTiers(tData.tiers || []);
        }
      } catch {
        if (!cancelled) { setCountries([]); setTiers([]); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function setField(key, value) { setForm((f) => ({ ...f, [key]: value })); }

  function handleSubmit(e) {
    e.preventDefault();
    const payload = {
      id: form.id || undefined,
      code: form.code.trim(),
      description: form.description.trim() || null,
      benefitType: form.benefitType,
      benefitValue: form.benefitValue !== '' ? Number(form.benefitValue) : null,
      benefitUnit: ['FREE_PERIOD'].includes(form.benefitType) ? form.benefitUnit : null,
      benefitCurrency: form.benefitType === 'FIXED_OFF' ? form.benefitCurrency : null,
      allowedCountries: Array.isArray(form.allowedCountries) ? form.allowedCountries : [],
      allowedEmails: splitCsv(form.allowedEmails).map((c) => c.toLowerCase()),
      allowedBusinessIds: splitCsv(form.allowedBusinessIds),
      applicableTiers: Array.isArray(form.applicableTiers) ? form.applicableTiers : [],
      validFrom: form.validFrom || null,
      validUntil: form.validUntil || null,
      maxTotalUses: form.maxTotalUses !== '' ? Number(form.maxTotalUses) : null,
      maxPerUser: form.maxPerUser !== '' ? Number(form.maxPerUser) : 1,
      firstSubscriptionOnly: !!form.firstSubscriptionOnly,
    };
    onSave(payload);
  }

  const isFreePeriod = form.benefitType === 'FREE_PERIOD';
  const isFixed = form.benefitType === 'FIXED_OFF';
  const isPercent = form.benefitType === 'PERCENT_OFF';
  const isLifetime = form.benefitType === 'LIFETIME_FREE';
  const needsPaddle = isFixed || isPercent;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{coupon ? 'Edit coupon' : 'New coupon'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <LabeledInput label="Coupon code *" value={form.code} onChange={(v) => setField('code', v.toUpperCase().replace(/\s+/g, ''))} required placeholder="LAUNCH3M" maxLength={50} mono />
            <LabeledInput label="Description" value={form.description} onChange={(v) => setField('description', v)} placeholder="Internal note for your team" maxLength={200} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <LabeledSelect label="Benefit type *" value={form.benefitType} onChange={(v) => setField('benefitType', v)}
              options={[
                { value: 'FREE_PERIOD',   label: 'Free period (X days/months)' },
                { value: 'LIFETIME_FREE', label: 'Lifetime free' },
                { value: 'PERCENT_OFF',   label: 'Percent off at checkout' },
                { value: 'FIXED_OFF',     label: 'Fixed off at checkout' },
              ]}
            />
            {isFreePeriod && (
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <LabeledInput label="Length *" type="number" min="1" value={form.benefitValue} onChange={(v) => setField('benefitValue', v)} required />
                <LabeledSelect label="Unit" value={form.benefitUnit} onChange={(v) => setField('benefitUnit', v)}
                  options={[{ value: 'MONTHS', label: 'Months' }, { value: 'DAYS', label: 'Days' }]}
                />
              </div>
            )}
            {isPercent && (
              <LabeledInput label="Percentage *" type="number" min="0" max="100" step="0.1" value={form.benefitValue} onChange={(v) => setField('benefitValue', v)} required />
            )}
            {isFixed && (
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <LabeledInput label="Amount *" type="number" min="0" step="0.01" value={form.benefitValue} onChange={(v) => setField('benefitValue', v)} required />
                <LabeledInput label="Currency *" value={form.benefitCurrency} onChange={(v) => setField('benefitCurrency', v.toUpperCase().slice(0, 3))} required placeholder="USD" maxLength={3} />
              </div>
            )}
            {isLifetime && (
              <div className="text-sm text-gray-600 flex items-end pb-1">This coupon grants forever-free access.</div>
            )}
          </div>

          {needsPaddle && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
              <strong>Paddle checkout discount:</strong> the first redemption creates or reuses a Paddle discount code, then opens checkout with that discount attached.
            </div>
          )}

          <div className="border-t border-gray-200 pt-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Restrictions (leave blank for none)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <MultiSelectDropdown
                label="Countries"
                placeholder="All countries — pick to restrict"
                loading={countries === null}
                options={(countries || []).map((c) => ({
                  value: c.countryCode,
                  label: `${c.countryName} (${c.countryCode})`,
                  group: c.region || 'Other',
                }))}
                value={form.allowedCountries}
                onChange={(v) => setField('allowedCountries', v)}
              />
              <MultiSelectDropdown
                label="Plans"
                placeholder="All plans — pick to restrict"
                loading={tiers === null}
                options={(tiers || [])
                  .filter((t) => t.slug !== 'free')
                  .map((t) => {
                    const vlabel = { APPOINTMENT: 'Appointments', ECOMMERCE: 'Ecommerce', STATIC: 'Website' }[t.vertical] || t.vertical || 'Other';
                    return { value: t.slug, label: `${t.name} · ${vlabel}`, group: vlabel };
                  })}
                value={form.applicableTiers}
                onChange={(v) => setField('applicableTiers', v)}
              />
              <LabeledInput label="Specific emails (comma separated)" value={form.allowedEmails} onChange={(v) => setField('allowedEmails', v)} placeholder="founder@x.com, beta@y.com" />
              <LabeledInput label="Specific businesses (short codes, comma separated)" value={form.allowedBusinessIds} onChange={(v) => setField('allowedBusinessIds', v)} placeholder="10293847, 56473829" mono />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <LabeledInput label="Valid from" type="date" value={form.validFrom} onChange={(v) => setField('validFrom', v)} />
              <LabeledInput label="Valid until" type="date" value={form.validUntil} onChange={(v) => setField('validUntil', v)} min={form.validFrom || undefined} />
              <LabeledInput label="Max total uses" type="number" min="1" value={form.maxTotalUses} onChange={(v) => setField('maxTotalUses', v)} placeholder="Unlimited" />
              <LabeledInput label="Max uses per business" type="number" min="1" value={form.maxPerUser} onChange={(v) => setField('maxPerUser', v)} />
            </div>
            <label className="flex items-center gap-2 mt-4 cursor-pointer">
              <input type="checkbox" checked={form.firstSubscriptionOnly}
                onChange={(e) => setField('firstSubscriptionOnly', e.target.checked)}
                className="w-4 h-4 rounded accent-indigo-600" />
              <span className="text-sm text-gray-700">Only for a business's first subscription</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-gray-200 pt-4">
            <button type="button" onClick={onClose} disabled={saving}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:border-gray-900 disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Saving…' : coupon ? 'Save changes' : 'Create coupon'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function splitCsv(s) {
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function LabeledInput({ label, value, onChange, type = 'text', required, placeholder, min, max, step, maxLength, mono }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-600 mb-1">{label}</span>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
        className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-indigo-500 ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}

function LabeledSelect({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-600 mb-1">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-indigo-500 bg-white">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

// Searchable multi-select that looks like a chip input. `value` is an array
// of option.value. `options` may include an optional `group` for grouping
// (e.g. by region) in the dropdown list.
function MultiSelectDropdown({ label, placeholder, options, value, onChange, loading }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = Array.isArray(value) ? value : [];
  const selectedSet = new Set(selected);

  const filtered = (options || []).filter((o) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
  });

  // Group options if any have a `group` field
  const hasGroups = (options || []).some((o) => o.group);
  const grouped = hasGroups
    ? filtered.reduce((acc, o) => {
        const g = o.group || 'Other';
        (acc[g] = acc[g] || []).push(o);
        return acc;
      }, {})
    : null;

  function toggle(val) {
    onChange(selectedSet.has(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  }

  const labelForValue = (v) => (options || []).find((o) => o.value === v)?.label || v;

  return (
    <div className="block relative">
      <span className="block text-xs font-semibold text-gray-600 mb-1">{label}</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full min-h-[40px] px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-left focus:outline-none focus:border-indigo-500 flex flex-wrap gap-1 items-center"
      >
        {selected.length === 0 && (
          <span className="text-gray-400">{loading ? 'Loading…' : placeholder}</span>
        )}
        {selected.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded text-xs font-medium border border-indigo-200">
            {labelForValue(v)}
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); toggle(v); }}
              className="text-indigo-500 hover:text-indigo-800 leading-none cursor-pointer"
              aria-label={`Remove ${v}`}
            >
              ×
            </span>
          </span>
        ))}
        <span className="ml-auto text-gray-400">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-72 overflow-hidden flex flex-col">
            <div className="p-2 border-b border-gray-100">
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {filtered.length === 0 && (
                <p className="py-4 text-center text-xs text-gray-400">No matches</p>
              )}
              {hasGroups
                ? Object.keys(grouped).sort().map((g) => (
                    <div key={g}>
                      <p className="px-3 py-1 bg-gray-50 text-[10px] uppercase tracking-wider font-semibold text-gray-500 sticky top-0">{g}</p>
                      {grouped[g].map((o) => (
                        <OptionRow key={o.value} opt={o} selected={selectedSet.has(o.value)} onToggle={toggle} />
                      ))}
                    </div>
                  ))
                : filtered.map((o) => (
                    <OptionRow key={o.value} opt={o} selected={selectedSet.has(o.value)} onToggle={toggle} />
                  ))}
            </div>
            {selected.length > 0 && (
              <div className="border-t border-gray-100 p-2 flex justify-between items-center text-xs">
                <span className="text-gray-500">{selected.length} selected</span>
                <button type="button" onClick={() => onChange([])} className="font-semibold text-gray-700 hover:text-gray-900">Clear all</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function OptionRow({ opt, selected, onToggle }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(opt.value)}
      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-gray-50 ${selected ? 'bg-indigo-50' : ''}`}
    >
      <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${selected ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'}`}>
        {selected && <span className="text-white text-[10px]">✓</span>}
      </span>
      <span className={selected ? 'font-medium text-gray-900' : 'text-gray-700'}>{opt.label}</span>
    </button>
  );
}

function RedemptionsDrawer({ coupon, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api(`/api/admin/subscription-coupons/${coupon.id}/redemptions`);
        if (!cancelled) setRows(data.redemptions || []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load redemptions');
      }
    })();
    return () => { cancelled = true; };
  }, [coupon.id]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div className="bg-white w-full max-w-md h-full overflow-y-auto shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-start justify-between">
          <div>
            <h3 className="font-mono text-lg font-bold text-gray-900">{coupon.code}</h3>
            <p className="text-xs text-gray-500">{describeBenefit(coupon)} · used {coupon.usedCount}×</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
        </div>

        <div className="p-5">
          {!rows && !error && <AdminSpinner />}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {rows?.length === 0 && <p className="text-sm text-gray-500">No redemptions yet.</p>}
          {rows?.length > 0 && (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.id} className="border border-gray-100 rounded-lg px-3 py-2 text-sm">
                  <p className="font-medium text-gray-900">{r.business?.name || '—'}</p>
                  <p className="text-xs text-gray-500">{r.business?.slug} · {new Date(r.createdAt).toISOString().slice(0, 10)}</p>
                  {r.appliedFreeDays != null && (
                    <p className="text-xs text-emerald-700 mt-1">Free days granted: {r.appliedFreeDays}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminSpinner() {
  return (
    <svg className="animate-spin h-6 w-6 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

// ---------------- Settings ----------------

function SettingsTab({ me }) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-5 flex items-start gap-3">
        <div className="w-10 h-10 bg-indigo-600 text-white rounded-xl flex items-center justify-center flex-shrink-0">
          💳
        </div>
        <div>
          <h3 className="font-semibold text-gray-900">Payments</h3>
          <p className="text-sm text-gray-700 mt-1">
            Paddle integration coming soon — all businesses currently have free access during the
            launch period.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900">Your profile</h2>
        <div className="mt-4 divide-y divide-gray-100">
          <ProfileRow label="Name" value={me.name} />
          <ProfileRow label="Email" value={me.email} />
          <ProfileRow label="Role">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
              {me.role}
            </span>
          </ProfileRow>
        </div>
      </div>

      <VercelSettingsCard />
    </div>
  );
}

function VercelSettingsCard() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [formToken, setFormToken] = useState('');
  const [formTeamId, setFormTeamId] = useState('');
  const [formProjectId, setFormProjectId] = useState('');

  useEffect(() => {
    api('/api/admin/settings')
      .then((d) => {
        setSettings(d.settings || {});
        setFormToken(''); // Don't show masked token in input
        setFormTeamId(d.settings?.VERCEL_TEAM_ID || '');
        setFormProjectId(d.settings?.VERCEL_BUSINESS_PROJECT_ID || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function saveSetting(key, value) {
    setSaving(key); setError(''); setSuccess('');
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ key, value }) });
      setSuccess(`${key} updated`);
      // Reload to get masked values
      const d = await api('/api/admin/settings');
      setSettings(d.settings || {});
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) { setError(e.message); } finally { setSaving(null); }
  }

  if (loading) return null;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Vercel Integration</h2>
        <p className="text-sm text-gray-500">Required for automatic custom domain binding. Generate a token at vercel.com/account/tokens</p>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      {success && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">{success}</p>}

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Vercel Token</label>
          <p className="text-xs text-gray-400 mb-1">
            {settings.VERCEL_TOKEN ? `Current: ${settings.VERCEL_TOKEN}` : 'Not set'}
          </p>
          <div className="flex gap-2">
            <input type="password" value={formToken} onChange={(e) => setFormToken(e.target.value)}
              placeholder="vca_..." className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button onClick={() => saveSetting('VERCEL_TOKEN', formToken)} disabled={saving === 'VERCEL_TOKEN' || !formToken}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:bg-gray-300">
              {saving === 'VERCEL_TOKEN' ? '...' : 'Save'}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Team ID</label>
          <div className="flex gap-2">
            <input type="text" value={formTeamId} onChange={(e) => setFormTeamId(e.target.value)}
              placeholder="team_..." className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button onClick={() => saveSetting('VERCEL_TEAM_ID', formTeamId)} disabled={saving === 'VERCEL_TEAM_ID'}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:bg-gray-300">
              {saving === 'VERCEL_TEAM_ID' ? '...' : 'Save'}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Business Project ID</label>
          <div className="flex gap-2">
            <input type="text" value={formProjectId} onChange={(e) => setFormProjectId(e.target.value)}
              placeholder="prj_..." className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button onClick={() => saveSetting('VERCEL_BUSINESS_PROJECT_ID', formProjectId)} disabled={saving === 'VERCEL_BUSINESS_PROJECT_ID'}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:bg-gray-300">
              {saving === 'VERCEL_BUSINESS_PROJECT_ID' ? '...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileRow({ label, value, children }) {
  return (
    <div className="py-3 flex items-start justify-between gap-4">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm text-gray-900 text-right">{children ?? value}</span>
    </div>
  );
}

// ---------------- Utils ----------------

function formatDate(iso) {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

function formatDateTime(iso) {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatCurrencyMinor(minor, currency) {
  if (minor == null || !currency) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(Number(minorToDisplay(minor, currency)));
}

function Spinner() {
  return (
    <svg className="animate-spin h-8 w-8 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

// ============================================================================
// Domains tab
// ============================================================================
// ============================================================================
// Notifications tab
// ============================================================================
const BANNER_TYPES = ['INFO', 'WARNING', 'URGENT', 'MAINTENANCE'];
const BANNER_TARGETS = ['ALL', 'PLATFORM', 'BUSINESSES', 'SPECIFIC'];
const TYPE_COLORS = {
  INFO: 'bg-blue-100 text-blue-700', WARNING: 'bg-amber-100 text-amber-700',
  URGENT: 'bg-red-100 text-red-700', MAINTENANCE: 'bg-gray-100 text-gray-700',
};

function NotificationsTab({ businesses }) {
  const [banners, setBanners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const confirm = useConfirm();
  const [form, setForm] = useState({
    message: '', type: 'INFO', target: 'ALL', businessId: '',
    startTime: new Date().toISOString().slice(0, 16),
    endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
    dismissible: true, linkUrl: '', linkText: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data } = await axios.get('/api/notifications', { withCredentials: true });
      setBanners(data.banners || []);
    } catch {} finally { setLoading(false); }
  }

  async function createBanner(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await axios.post('/api/notifications', {
        message: form.message,
        type: form.type,
        target: form.target,
        businessId: form.target === 'SPECIFIC' ? form.businessId : undefined,
        startTime: new Date(form.startTime).toISOString(),
        endTime: new Date(form.endTime).toISOString(),
        dismissible: form.dismissible,
        linkUrl: form.linkUrl || undefined,
        linkText: form.linkText || undefined,
      }, { withCredentials: true });
      setShowForm(false);
      setForm({ message: '', type: 'INFO', target: 'ALL', businessId: '',
        startTime: new Date().toISOString().slice(0, 16),
        endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
        dismissible: true, linkUrl: '', linkText: '',
      });
      await load();
    } catch (err) { setError(err.response?.data?.message || 'Failed'); }
    finally { setSaving(false); }
  }

  async function toggleActive(id, isActive) {
    try {
      await axios.put(`/api/notifications/${id}`, { isActive: !isActive }, { withCredentials: true });
      await load();
    } catch { alert('Failed'); }
  }

  async function remove(id) {
    if (!await confirm('Delete this notification?', { confirmLabel: 'Delete', tone: 'danger' })) return;
    try {
      await axios.delete(`/api/notifications/${id}`, { withCredentials: true });
      await load();
    } catch { alert('Failed'); }
  }

  const now = Date.now();
  const active = banners.filter(b => b.isActive && new Date(b.endTime) > now);
  const past = banners.filter(b => !b.isActive || new Date(b.endTime) <= now);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Notification banners</h2>
          <p className="text-sm text-gray-500">Show alerts on the platform and/or business websites</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white">
          {showForm ? 'Cancel' : '+ New banner'}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={createBanner} className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Message *</label>
            <input type="text" required value={form.message} onChange={e => setForm({ ...form, message: e.target.value })}
              placeholder="e.g. System maintenance scheduled for tonight 10pm–2am"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Type</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                {BANNER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Show on</label>
              <select value={form.target} onChange={e => setForm({ ...form, target: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                {BANNER_TARGETS.map(t => <option key={t} value={t}>{t === 'ALL' ? 'All sites' : t === 'PLATFORM' ? 'Platform only' : t === 'BUSINESSES' ? 'All businesses' : 'Specific business'}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Start</label>
              <input type="datetime-local" value={form.startTime} onChange={e => setForm({ ...form, startTime: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">End</label>
              <input type="datetime-local" value={form.endTime} onChange={e => setForm({ ...form, endTime: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
            </div>
          </div>
          {form.target === 'SPECIFIC' && (
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Business</label>
              <select value={form.businessId} onChange={e => setForm({ ...form, businessId: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required>
                <option value="">Select a business</option>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          {/* Static vs dismissible + optional link */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-200">
              <input type="checkbox" checked={!form.dismissible}
                onChange={e => setForm({ ...form, dismissible: !e.target.checked })}
                className="w-4 h-4 rounded" style={{ accentColor: '#4f46e5' }} />
              <div>
                <p className="text-sm font-medium text-gray-900">Static (non-closable)</p>
                <p className="text-xs text-gray-500">Users cannot dismiss this banner</p>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Link URL (optional)</label>
              <input type="url" value={form.linkUrl} onChange={e => setForm({ ...form, linkUrl: e.target.value })}
                placeholder="https://example.com/blog/update"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Link text (optional)</label>
              <input type="text" value={form.linkText} onChange={e => setForm({ ...form, linkText: e.target.value })}
                placeholder="Learn more"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={saving}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50">
            {saving ? 'Creating...' : 'Create banner'}
          </button>
        </form>
      )}

      {/* Active banners */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Active ({active.length})</h3>
        {loading ? <div className="py-6 flex justify-center"><Spinner /></div> :
        active.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">No active notifications</p>
        ) : (
          <div className="space-y-2">
            {active.map(b => (
              <div key={b.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-100">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${TYPE_COLORS[b.type]}`}>{b.type}</span>
                  <p className="text-sm text-gray-900 truncate">{b.message}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 text-xs text-gray-500">
                  <span>{new Date(b.startTime).toLocaleDateString()} – {new Date(b.endTime).toLocaleDateString()}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100">{b.target}</span>
                  <button onClick={() => toggleActive(b.id, b.isActive)} className="text-amber-600 hover:underline">Pause</button>
                  <button onClick={() => remove(b.id)} className="text-red-600 hover:underline">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Past/paused */}
      {past.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-500 mb-3">Expired / Paused ({past.length})</h3>
          <div className="space-y-2 opacity-60">
            {past.slice(0, 10).map(b => (
              <div key={b.id} className="flex items-center justify-between gap-3 p-2 text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${TYPE_COLORS[b.type]}`}>{b.type}</span>
                  <span className="truncate text-gray-600">{b.message}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!b.isActive && <button onClick={() => toggleActive(b.id, b.isActive)} className="text-xs text-emerald-600 hover:underline">Resume</button>}
                  <button onClick={() => remove(b.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// ============================================================================
// Pricing tab — backed by the new pricing admin schema (/api/admin/pricing/*)
// ============================================================================

// Format an Int minor-units amount using the currency's normal decimal rules.
// JPY, KRW, VND etc. have no minor units; Arabian Peninsula currencies have 3.
const ZERO_DEC = new Set(['JPY','KRW','VND','CLP','ISK','HUF','COP','IDR','PYG','UGX','RWF','XAF','XOF','KMF','DJF','GNF','BIF']);
const THREE_DEC = new Set(['KWD','BHD','OMR','JOD','TND','IQD','LYD']);
function minorToDisplay(minor, currency) {
  if (minor == null) return '';
  if (ZERO_DEC.has(currency))  return String(minor);
  if (THREE_DEC.has(currency)) return (minor / 1000).toFixed(3);
  return (minor / 100).toFixed(2);
}
function displayToMinor(val, currency) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  if (ZERO_DEC.has(currency))  return Math.round(n);
  if (THREE_DEC.has(currency)) return Math.round(n * 1000);
  return Math.round(n * 100);
}
// Yearly display value derived from a monthly price + an annual-discount %.
// 0% → 12× monthly (no discount); 20% → 12× monthly × 0.8. Rounded to the
// currency's minor precision so gateways still bill a fixed amount.
function yearlyFromDiscount(monthlyDisplay, currency, pct) {
  const m = Number(monthlyDisplay);
  if (!Number.isFinite(m) || m <= 0) return '';
  const p = Math.min(Math.max(Number(pct) || 0, 0), 95);
  return minorToDisplay(displayToMinor(m * 12 * (1 - p / 100), currency), currency);
}

// Approximate USD→currency FX for the "Fill from USD" suggestion. Hand-maintained
// (precision doesn't matter — the result is rounded to a nice number and the admin
// edits it). Only the 5 non-USD billing currencies.
const FX_FROM_USD = { INR: 83, NZD: 1.66, GBP: 0.79, EUR: 0.92, AUD: 1.52 };
// Round a derived price to a sellable-looking number per currency.
function roundNicePrice(amount, code) {
  const a = Math.max(0, Number(amount) || 0);
  if (a === 0) return 0;
  if (code === 'INR') return Math.max(99, Math.round(a / 100) * 100 - 1);   // ₹…99
  if (a < 100) return Math.round(a);                                         // small whole units
  return Math.max(0, Math.round(a / 10) * 10 - 1);                           // …9
}

// Vertical strip — picks which vertical's pricing catalogue we're
// looking at. Tiers + Prices subtabs filter by this; Zones + Countries
// are vertical-agnostic (zone multipliers + country→zone assignments
// apply across all verticals).
const PRICING_VERTICALS = [
  { key: 'APPOINTMENT', label: 'Booking site' },
  { key: 'ECOMMERCE',   label: 'Online shop' },
  { key: 'STATIC',      label: 'Marketing site' },
];

// The 5 billing currencies the platform actually charges in (mirrors
// SUPPORTED_BILLING_CURRENCIES in backend gatewayRouter.js). Each currency maps
// to ONE canonical TierPrice row: USD → the base row (countryCode null), the
// others → a representative country whose gateway presents in that currency.
// This is the whole truth the super-admin needs — the 47 raw country rows live
// under Advanced ▸ Regions & zones for the rare re-mapping case.
const PRICING_CURRENCIES = [
  { code: 'USD', symbol: '$',  countryCode: null, label: 'USD', region: 'Rest of world (Paddle)' },
  { code: 'INR', symbol: '₹',  countryCode: 'IN', label: 'INR', region: 'India (Razorpay)' },
  { code: 'NZD', symbol: 'NZ$', countryCode: 'NZ', label: 'NZD', region: 'New Zealand (Stripe)' },
  { code: 'GBP', symbol: '£',  countryCode: 'GB', label: 'GBP', region: 'United Kingdom (Paddle)' },
  { code: 'EUR', symbol: '€',  countryCode: 'DE', label: 'EUR', region: 'Eurozone (Paddle)' },
  { code: 'AUD', symbol: 'A$', countryCode: 'AU', label: 'AUD', region: 'Australia (Paddle)' },
];

// Pick the canonical TierPrice row for a given currency out of a tier's
// prices[] (which the getTier endpoint already filters to the 5 supported
// currencies). Match by currency first; fall back to the mapped countryCode so
// a legacy row tagged only by country still resolves.
function priceRowForCurrency(prices, spec) {
  const list = Array.isArray(prices) ? prices : [];
  if (spec.countryCode == null) {
    return list.find((p) => !p.countryCode && p.currencyCode === spec.code)
      || list.find((p) => !p.countryCode)
      || null;
  }
  return list.find((p) => p.countryCode === spec.countryCode && p.currencyCode === spec.code)
    || list.find((p) => p.countryCode === spec.countryCode)
    || null;
}

// Map a country to the billing currency its gateway presents in — mirrors the
// backend resolvePresentmentCurrency so the admin preview can default to the
// super-admin's own region (i.e. show exactly what they see on the landing).
const EUROZONE_CC = new Set(['DE','FR','IT','ES','NL','IE','PT','BE','AT','FI','GR','SK','SI','LT','LV','EE','LU','CY','MT','HR']);
function currencyForCountry(cc) {
  const code = String(cc || '').toUpperCase();
  if (code === 'IN') return 'INR';
  if (code === 'NZ') return 'NZD';
  if (code === 'GB') return 'GBP';
  if (['AU', 'CX', 'CC', 'NF', 'KI', 'NR', 'TV'].includes(code)) return 'AUD';
  if (EUROZONE_CC.has(code)) return 'EUR';
  return 'USD';
}

// The dedicated $0 "Free" tier (slug `free`) is a hidden system tier — it drives
// new signups and is the cancel/lapse fallback, but it's intentionally never a
// public card. Hidden from the board by default so every vertical reads the same.
const HIDDEN_TIER_SLUGS = new Set(['free']);

// Real annual saving for a plan: 1 − (yearly ÷ monthly×12), rounded. Computed
// from the stored prices so the "−N%" badge can never drift from what's charged.
function annualDiscountPctForRow(row) {
  const m = Number(row?.amountMonthlyMinor) || 0;
  const y = Number(row?.amountAnnualMinor) || 0;
  if (m <= 0 || y <= 0) return 0;
  return Math.round((1 - y / (m * 12)) * 100);
}

// Which gateway price-id columns matter for a given currency, so we can show a
// subtle "published / not set" dot per currency.
const CURRENCY_GATEWAY_IDS = {
  USD: ['paddlePriceIdMonthly', 'paddlePriceIdAnnual'],
  GBP: ['paddlePriceIdMonthly', 'paddlePriceIdAnnual'],
  EUR: ['paddlePriceIdMonthly', 'paddlePriceIdAnnual'],
  AUD: ['paddlePriceIdMonthly', 'paddlePriceIdAnnual'],
  NZD: ['stripePriceIdMonthly', 'stripePriceIdAnnual'],
  INR: ['razorpayPlanIdMonthly', 'razorpayPlanIdAnnual'],
};
function gatewayIdsSet(row, code) {
  if (!row) return false;
  return (CURRENCY_GATEWAY_IDS[code] || []).some((k) => row[k]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing — plan-centric editor. One screen: pick a vertical, see every plan as
// a card, expand a card to edit its details, its content (features), and its
// prices across the 5 supported currencies. Regions/zones live behind an
// Advanced disclosure. Publish pushes prices to the gateways.
// ─────────────────────────────────────────────────────────────────────────────
function PricingTab() {
  const [vertical, setVertical] = useState('APPOINTMENT');
  const [publishOpen, setPublishOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const verticalLabel = PRICING_VERTICALS.find((v) => v.key === vertical)?.label;

  return (
    <div className="space-y-5">
      {/* Header — vertical scope + Publish + tiny publish preview. */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="inline-flex items-center gap-1 p-1 rounded-full bg-gray-100 border border-gray-200 text-sm">
          {PRICING_VERTICALS.map((v) => (
            <button
              key={v.key}
              onClick={() => setVertical(v.key)}
              className={`px-4 py-1.5 rounded-full font-medium transition-colors ${
                vertical === v.key
                  ? 'bg-gray-900 text-white shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <PublishStatusChip onClick={() => setPublishOpen(true)} />
          <button
            onClick={() => setPublishOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
            title="Recreate the gateway plans at the current prices so the CHARGED price matches what you set here"
          >
            ⚡ Publish to gateways
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Editing the <span className="font-semibold text-gray-700">{verticalLabel}</span> plans. Each plan has its details, its content (feature list) and its prices in the 5 currencies we bill in — INR (Razorpay), NZD (Stripe), GBP / EUR / USD (Paddle). <span className="font-semibold text-gray-700">Publish</span> pushes those prices to the gateways so they become the charged price.
      </p>

      {/* Primary view — plans as cards. */}
      <PlansBoard vertical={vertical} verticalLabel={verticalLabel} />

      {/* Advanced — regions & zones, collapsed. */}
      <div className="rounded-2xl border border-gray-200 bg-white">
        <button
          onClick={() => setAdvancedOpen((o) => !o)}
          className="w-full flex items-center justify-between px-5 py-3 text-left"
        >
          <div>
            <p className="text-sm font-semibold text-gray-900">Advanced ▸ Regions &amp; zones</p>
            <p className="text-xs text-gray-500">Which billing currency each country is charged in, and its <b>pricing zone</b>. Zones are the PPP discount used by <b>“Fill from USD”</b> — move a country to a cheaper zone, then re-Fill that currency. (Zones don’t change an already-saved price until you re-fill &amp; Save.)</p>
          </div>
          <span className="text-gray-400 text-lg">{advancedOpen ? '▾' : '▸'}</span>
        </button>
        {advancedOpen && (
          <div className="border-t border-gray-100 px-5 py-4 space-y-8">
            <section>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Zones</h3>
              <ZonesSubtab />
            </section>
            <section>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Countries</h3>
              <CountriesSubtab />
            </section>
          </div>
        )}
      </div>

      {publishOpen && <PublishModal onClose={() => setPublishOpen(false)} />}
    </div>
  );
}

// Tiny header chip summarising what Publish will do (plans that need a gateway
// sync). Clicking opens the full Publish modal. Stays quiet on error.
function PublishStatusChip({ onClick }) {
  const [pending, setPending] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await axios.get('/api/admin/pricing/publish/preview', { withCredentials: true });
        if (!alive) return;
        const n = (data?.results || []).reduce(
          (sum, g) => sum + (g.configured ? (g.rows || []).filter((r) => r.action === 'create').length : 0),
          0,
        );
        setPending(n);
      } catch { if (alive) setPending(null); }
    })();
    return () => { alive = false; };
  }, []);
  if (pending == null) return null;
  return (
    <button
      onClick={onClick}
      className={`hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${
        pending > 0 ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
      }`}
      title="Preview of what Publish will push to the gateways"
    >
      {pending > 0 ? `⚠ ${pending} price${pending === 1 ? '' : 's'} to publish` : '✓ Gateways in sync'}
    </button>
  );
}

// Plans board — loads the tiers for a vertical, renders each as an expandable
// card in sort order, supports reorder + create. The expanded card is where all
// editing happens (details / content / pricing).
function PlansBoard({ vertical, verticalLabel }) {
  const [tiers, setTiers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [expanded, setExpanded] = useState(null);   // tier id
  const [creating, setCreating] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  // Which currency the collapsed cards preview. Defaults to the super-admin's
  // own region (via /geo) so what they see here == what they see on the landing.
  const [previewCode, setPreviewCode] = useState('USD');
  // Monthly / Yearly — mirrors the landing's billing toggle so the card headline
  // matches whichever period a visitor is viewing on the public page.
  const [billingPeriod, setBillingPeriod] = useState('monthly');
  // Reveal the hidden $0 Free system tier on demand (off by default).
  const [showHidden, setShowHidden] = useState(false);
  const currencySpec = PRICING_CURRENCIES.find((c) => c.code === previewCode) || PRICING_CURRENCIES[0];
  const confirm = useConfirm();

  const hiddenTiers = tiers.filter((t) => HIDDEN_TIER_SLUGS.has(t.slug));
  const displayTiers = showHidden ? tiers : tiers.filter((t) => !HIDDEN_TIER_SLUGS.has(t.slug));
  const realCount = tiers.length - hiddenTiers.length;

  // Board-level annual discount badge = the best real saving across the visible
  // paid plans in the previewed currency. Computed, never hardcoded.
  const annualDiscountPct = displayTiers.reduce((best, t) => {
    if (t.isCustomPriced || HIDDEN_TIER_SLUGS.has(t.slug)) return best;
    const row = priceRowForCurrency(t.prices, currencySpec)
      || (currencySpec.code !== 'USD' ? (t.prices || []).find((p) => p.currencyCode === currencySpec.code) : null);
    return Math.max(best, annualDiscountPctForRow(row));
  }, 0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const geo = await fetch('/geo').then((r) => r.json()).catch(() => null);
        if (alive && geo?.country) setPreviewCode(currencyForCountry(geo.country));
      } catch { /* keep USD default */ }
    })();
    return () => { alive = false; };
  }, []);

  function flash(msg) { setOk(msg); setTimeout(() => setOk(''), 2500); }

  async function load() {
    setLoading(true); setErr('');
    try {
      const { data } = await axios.get(`/api/admin/pricing/tiers?vertical=${encodeURIComponent(vertical)}`, { withCredentials: true });
      setTiers(data.tiers || []);
    } catch (e) { setErr(e.response?.data?.message || 'Failed to load plans'); }
    finally { setLoading(false); }
  }
  useEffect(() => { setExpanded(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [vertical]);

  async function move(i, dir) {
    const target = i + dir;
    if (target < 0 || target >= displayTiers.length) return;
    const reordered = [...displayTiers];
    [reordered[i], reordered[target]] = [reordered[target], reordered[i]];
    // Persist the full order — hidden system tiers stay pinned to the front.
    const fullOrder = showHidden ? reordered : [...hiddenTiers, ...reordered];
    setTiers(fullOrder); // optimistic
    const order = fullOrder.map((t) => t.id);
    try { await axios.put('/api/admin/pricing/tiers/reorder', { order }, { withCredentials: true }); load(); }
    catch (e) { setErr(e.response?.data?.message || 'Reorder failed'); load(); }
  }

  async function toggleActive(t) {
    try {
      await axios.put(`/api/admin/pricing/tiers/${t.id}`, { isActive: !t.isActive }, { withCredentials: true });
      flash(`${t.name} ${!t.isActive ? 'activated' : 'archived'}`);
      load();
    } catch (e) { setErr(e.response?.data?.message || 'Failed'); }
  }

  async function archive(t) {
    if (!await confirm(`Archive “${t.name}”? It stops showing on the pricing page; existing subscribers are unaffected.`, { confirmLabel: 'Archive', tone: 'danger' })) return;
    try { await axios.delete(`/api/admin/pricing/tiers/${t.id}`, { withCredentials: true }); flash('Plan archived'); load(); }
    catch (e) { setErr(e.response?.data?.message || 'Failed'); }
  }

  if (loading) return <div className="py-10 flex justify-center"><Spinner /></div>;

  return (
    <div className="space-y-3">
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{err}</p>}
      {ok && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">{ok}</p>}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-gray-900">{verticalLabel} plans <span className="text-sm font-normal text-gray-400">({realCount})</span></h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowOverview((s) => !s)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            {showOverview ? 'Hide overview' : 'Family overview'}
          </button>
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
          >
            + New plan
          </button>
        </div>
      </div>

      {/* Preview controls — the price each card shows is the LIVE customer-facing
          price in this currency + billing period (exactly what the landing renders
          for that region/toggle). Switch to sanity-check any market or term. */}
      <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-500">Show prices in</span>
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-white border border-gray-200 p-0.5">
            {PRICING_CURRENCIES.map((c) => (
              <button
                key={c.code}
                onClick={() => setPreviewCode(c.code)}
                title={c.region}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                  previewCode === c.code ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {c.symbol} {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500">Billing</span>
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-white border border-gray-200 p-0.5">
            <button
              onClick={() => setBillingPeriod('monthly')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                billingPeriod === 'monthly' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBillingPeriod('yearly')}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                billingPeriod === 'yearly' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              Yearly
              {annualDiscountPct > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${billingPeriod === 'yearly' ? 'bg-emerald-500 text-white' : 'bg-emerald-100 text-emerald-700'}`}>−{annualDiscountPct}%</span>
              )}
            </button>
          </div>
        </div>
        <span className="w-full text-[11px] text-gray-400 sm:w-auto">{currencySpec.region} · {billingPeriod === 'yearly' ? 'annual term' : 'monthly term'} · what customers see &amp; pay</span>
      </div>

      {showOverview && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <CatalogMatrixSubtab />
        </div>
      )}

      {displayTiers.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center text-sm text-gray-500">
          No plans in the {verticalLabel} catalogue yet. Click <span className="font-semibold">+ New plan</span> to create one.
        </div>
      )}

      <div className="space-y-3">
        {displayTiers.map((t, i) => (
          <PlanCard
            key={t.id}
            tier={t}
            vertical={vertical}
            currencySpec={currencySpec}
            billingPeriod={billingPeriod}
            isFirst={i === 0}
            isLast={i === displayTiers.length - 1}
            expanded={expanded === t.id}
            onToggle={() => setExpanded((e) => (e === t.id ? null : t.id))}
            onMove={(dir) => move(i, dir)}
            onToggleActive={() => toggleActive(t)}
            onArchive={() => archive(t)}
            onSaved={(msg) => { flash(msg || 'Saved'); load(); }}
          />
        ))}
      </div>

      {/* The $0 Free system tier is hidden from the board (it never shows on the
          public page either). Reveal it only when you need to edit what free users
          get — it can't be deleted, since new signups land on it. */}
      {hiddenTiers.length > 0 && (
        <button
          onClick={() => setShowHidden((s) => !s)}
          className="text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-1.5"
        >
          <span className="text-gray-300">{showHidden ? '▾' : '▸'}</span>
          {showHidden ? 'Hide' : 'Show'} system tier ({hiddenTiers.map((t) => t.name).join(', ')}) · drives free signups, never a public card
        </button>
      )}

      {creating && (
        <NewPlanModal
          vertical={vertical}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); flash('Plan created'); load(); }}
        />
      )}
    </div>
  );
}

// Publish-to-gateways modal — previews the before/after diff, then recreates the
// Razorpay/Stripe/Paddle plans at the current prices so the CHARGED price matches
// what super-admin set. Backed by /api/admin/pricing/publish[/preview].
// ─── Payments — the single window: gateway-plan sync + integrated/BYO policy ──
function PaymentsTab() {
  const [countries, setCountries] = useState([]);
  const [defaultOn, setDefaultOn] = useState(false);
  const [overrides, setOverrides] = useState({});   // countryCode -> integratedEnabled (explicit rows only)
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [savingCode, setSavingCode] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try {
      const [c, p] = await Promise.all([
        axios.get('/api/admin/pricing/countries', { withCredentials: true }),
        axios.get('/api/admin/pricing/payment-policy', { withCredentials: true }),
      ]);
      setCountries(c.data.countries || []);
      setDefaultOn(!!p.data.defaultIntegratedOn);
      const map = {};
      for (const row of (p.data.countries || [])) map[row.countryCode] = !!row.integratedEnabled;
      setOverrides(map);
    } catch (e) { setErr(e.response?.data?.message || 'Failed to load'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  // Integrated is on for a country if it has an explicit override; otherwise it
  // follows the global default. BYO is ALWAYS available — it's the safe baseline
  // and can't be turned off — so the only real control is this Integrated toggle.
  function integratedFor(code) {
    return Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code] : defaultOn;
  }

  async function toggle(code) {
    const next = !integratedFor(code);
    setSavingCode(code); setErr('');
    setOverrides((m) => ({ ...m, [code]: next }));   // optimistic
    try { await axios.put(`/api/admin/pricing/payment-policy/${code}`, { integratedEnabled: next }, { withCredentials: true }); }
    catch (e) { setErr(e.response?.data?.message || 'Could not update'); setOverrides((m) => ({ ...m, [code]: !next })); }
    finally { setSavingCode(''); }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter((c) => c.countryName.toLowerCase().includes(q) || c.countryCode.toLowerCase().includes(q));
  }, [countries, search]);
  const integratedCount = countries.filter((c) => integratedFor(c.countryCode)).length;

  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <h2 className="text-xl font-bold text-gray-900">Buyer payments</h2>
        <p className="text-sm text-gray-500">How a tenant&apos;s customers pay: through DriftHR&apos;s integrated rails (Stripe Connect / Razorpay Route — platform liability) or the seller&apos;s own gateway (BYO). To push your plan prices to the gateways, use <span className="font-semibold">⚡ Publish to gateways</span> on the Pricing tab.</p>
      </header>
      {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">Buyer-payment policy</h3>
        <p className="text-xs text-gray-500 mb-3">
          <strong>BYO</strong> (the seller&apos;s own gateway) is <strong>always available</strong> — no platform liability. The toggle adds <strong>Integrated</strong> (Stripe Connect / Razorpay Route) on top, which puts DriftHR in the money flow → fraud/KYC/chargeback liability. Default for every country: <span className="font-semibold">{defaultOn ? 'Integrated + BYO' : 'BYO only'}</span>. <span className="text-emerald-700 font-semibold">{integratedCount}</span> countr{integratedCount === 1 ? 'y' : 'ies'} allow integrated.
        </p>

        {loading ? <div className="py-6 flex justify-center"><Spinner /></div> : (
          <>
            <input
              type="search" placeholder="Search country or code…"
              value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full mb-3 px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Country</th>
                    <th className="px-4 py-2.5 text-left">BYO</th>
                    <th className="px-4 py-2.5 text-left">Integrated</th>
                    <th className="px-4 py-2.5 text-left">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, 300).map((c) => {
                    const on = integratedFor(c.countryCode);
                    return (
                      <tr key={c.countryCode} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-4 py-2">
                          <span className="font-mono text-gray-500 mr-2">{c.countryCode}</span>
                          <span className="text-gray-900">{c.countryName}</span>
                        </td>
                        <td className="px-4 py-2"><span className="text-emerald-700 text-xs font-semibold">✓ always</span></td>
                        <td className="px-4 py-2">
                          <button
                            onClick={() => toggle(c.countryCode)} disabled={savingCode === c.countryCode}
                            title={on ? 'Integrated allowed — click to make BYO-only' : 'BYO-only — click to allow integrated'}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-gray-300'} disabled:opacity-50`}
                          >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
                          </button>
                        </td>
                        <td className="px-4 py-2 text-xs font-semibold">
                          {on ? <span className="text-emerald-700">Integrated + BYO</span> : <span className="text-gray-600">BYO only</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {visible.length > 300 && (
                <p className="text-center text-xs text-gray-500 py-3 border-t border-gray-100">Showing first 300 of {visible.length} — search to narrow.</p>
              )}
              {visible.length === 0 && <p className="text-center text-xs text-gray-500 py-4">No countries match “{search}”.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function PublishModal({ onClose }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true); setErr('');
      try {
        const { data } = await axios.get('/api/admin/pricing/publish/preview', { withCredentials: true });
        setPreview(data);
      } catch (e) { setErr(e.response?.data?.message || 'Failed to load preview'); }
      finally { setLoading(false); }
    })();
  }, []);

  async function publish() {
    if (!window.confirm('Publish these prices to the live gateway catalogs? This creates new gateway plans where the price changed; existing subscribers stay on their current plan.')) return;
    setPublishing(true); setErr('');
    try {
      const { data } = await axios.post('/api/admin/pricing/publish', {}, { withCredentials: true });
      setResult(data);
    } catch (e) { setErr(e.response?.data?.message || 'Publish failed'); }
    finally { setPublishing(false); }
  }

  const view = result || preview;
  const counts = view?.summary || {};

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[85vh] overflow-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Publish prices to gateways</h3>
            <p className="text-sm text-gray-500">{result ? 'Done — here is what changed.' : 'Preview: recreates gateway plans where the price changed. Existing subscribers keep their plan.'}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-gray-400 hover:text-gray-600">×</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
          {loading ? <div className="py-8 flex justify-center"><Spinner /></div> : (
            <>
              <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries(counts).map(([k, v]) => (
                  <span key={k} className={`rounded-full px-3 py-1 font-semibold ${
                    k === 'created' ? 'bg-indigo-100 text-indigo-800'
                      : k === 'failed' ? 'bg-red-100 text-red-700'
                        : k === 'skipped' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'
                  }`}>{v} {result ? k : (k === 'pending' ? 'to create' : k)}</span>
                ))}
                {Object.keys(counts).length === 0 && <span className="text-gray-500">Nothing to publish.</span>}
              </div>

              {(view?.results || []).map((r) => (
                <div key={r.gateway} className="rounded-xl border border-gray-200">
                  <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-gray-50">
                    <p className="text-sm font-semibold text-gray-800">{r.gateway}</p>
                    {!r.configured && <span className="text-xs font-semibold text-amber-700">not configured — skipped</span>}
                  </div>
                  {r.configured && (r.rows || []).some((row) => row.period) && (
                    <table className="w-full text-xs">
                      <thead className="text-gray-400">
                        <tr><th className="px-4 py-1.5 text-left">Tier</th><th className="text-left">Cycle</th><th className="text-right">Amount</th><th className="px-3 text-left">Action</th></tr>
                      </thead>
                      <tbody>
                        {(r.rows || []).filter((row) => row.period).map((row, i) => (
                          <tr key={i} className="border-t border-gray-50">
                            <td className="px-4 py-1.5 font-medium text-gray-800">{row.tier} <span className="text-gray-400">· {row.vertical}</span></td>
                            <td className="text-gray-600">{row.period}</td>
                            <td className="text-right font-mono text-gray-700">{row.currency} {Math.round((row.amountMinor || 0) / 100)}</td>
                            <td className="px-3">
                              <span className={`rounded px-2 py-0.5 font-semibold ${
                                row.status === 'created' ? 'bg-indigo-100 text-indigo-700'
                                  : row.status === 'failed' ? 'bg-red-100 text-red-700'
                                    : row.action === 'create' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'
                              }`}>{result ? row.status : (row.action === 'create' ? 'will create' : 'reuse')}</span>
                              {row.error && <span className="ml-2 text-red-600">{row.error}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 px-6 py-4">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700">Close</button>
          {!result && (
            <button onClick={publish} disabled={publishing || loading} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-indigo-700">
              {publishing ? 'Publishing…' : 'Publish now'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CatalogMatrixSubtab() {
  const [matrix, setMatrix] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try {
      const { data } = await axios.get('/api/admin/pricing/catalog-matrix', { withCredentials: true });
      setMatrix(data.matrix || []);
      setSummary(data.summary || null);
    } catch (e) { setErr(e.response?.data?.message || 'Failed to load catalog matrix'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  if (loading) return <div className="py-8 flex justify-center"><Spinner /></div>;

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{err}</p>}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Plan family matrix</h2>
          <p className="text-sm text-gray-500">Canonical families across Booking, Store, and Marketing with base-price and Paddle readiness.</p>
        </div>
        {summary && (
          <div className="flex gap-2 text-xs">
            <span className="rounded-full bg-gray-100 px-3 py-1 font-semibold text-gray-700">{summary.families} families</span>
            <span className="rounded-full bg-amber-100 px-3 py-1 font-semibold text-amber-800">{summary.missingVariants} missing variants</span>
            <span className="rounded-full bg-emerald-100 px-3 py-1 font-semibold text-emerald-800">{summary.selfServeReadyVariants} ready variants</span>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-mono uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Family</th>
              {PRICING_VERTICALS.map((vertical) => (
                <th key={vertical.key} className="px-4 py-3 text-left">{vertical.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row) => (
              <tr key={row.key} className="border-t border-gray-100 align-top">
                <td className="px-4 py-3">
                  <p className="font-semibold text-gray-900">{row.label}</p>
                  <p className="mt-1 text-[11px] font-mono text-gray-400">{row.aliases?.join(', ') || 'No aliases'}</p>
                </td>
                {PRICING_VERTICALS.map((vertical) => {
                  const variant = row.variants?.[vertical.key];
                  const price = variant?.price;
                  const ready = variant?.coverage?.paidSelfServeReady;
                  return (
                    <td key={vertical.key} className="px-4 py-3">
                      {!variant ? (
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-500">Missing</span>
                      ) : (
                        <div className="space-y-1">
                          <p className="font-semibold text-gray-900">{variant.name}</p>
                          <p className="font-mono text-xs text-gray-500">{variant.slug}</p>
                          <p className="text-xs text-gray-600">
                            {variant.isCustomPriced
                              ? 'Custom'
                              : price ? `${price.currencyCode} ${minorToDisplay(price.amountMonthlyMinor, price.currencyCode)}/mo` : 'No base price'}
                          </p>
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            ready ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'
                          }`}>
                            {ready ? 'Ready' : 'Needs config'}
                          </span>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- Plan card (collapsed summary + expanded editor) ----------------

// One plan = one card. Collapsed: name + badge + base monthly price + quick
// status. Expanded: three sections — Plan details, Plan content (features),
// Pricing across the 5 supported currencies.
function PlanCard({ tier, vertical, currencySpec, billingPeriod = 'monthly', isFirst, isLast, expanded, onToggle, onMove, onToggleActive, onArchive, onSaved }) {
  // The list endpoint carries all 5 billing-currency rows + counts. When expanded
  // we fetch the full tier (currency rows + gateway ids + tierFeatures).
  const [full, setFull] = useState(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [section, setSection] = useState('details');

  async function loadFull() {
    setLoadingFull(true);
    try {
      const { data } = await axios.get(`/api/admin/pricing/tiers/${tier.id}`, { withCredentials: true });
      setFull(data.tier);
    } catch { /* surfaced in sub-sections on save */ }
    finally { setLoadingFull(false); }
  }
  useEffect(() => { if (expanded && !full) loadFull(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [expanded]);

  function refresh(msg) { loadFull(); onSaved?.(msg); }

  // Collapsed price = the LIVE price for the currently-previewed currency (the
  // same canonical row the landing resolves), so admin and the public page agree.
  const spec = currencySpec || PRICING_CURRENCIES[0];
  const isFree = String(tier.slug || '').toLowerCase() === 'free';
  // Representative-country row first; fall back to ANY row in this currency so a
  // eurozone plan still previews even if the rep country (DE) has no own row.
  const priceRow = priceRowForCurrency(tier.prices, spec)
    || (spec.code !== 'USD' ? (tier.prices || []).find((p) => p.currencyCode === spec.code) : null)
    || null;
  // Headline follows the Monthly/Yearly toggle, exactly like the landing:
  //  · Monthly → the monthly price, with the annual /mo equivalent as context.
  //  · Yearly  → annual ÷ 12 (Math.round, the EXACT figure the landing shows on
  //              its Yearly toggle), with the full annual total as context.
  const annualTotalTxt = priceRow?.amountAnnualMinor != null ? minorToDisplay(priceRow.amountAnnualMinor, spec.code) : null;
  const annualPerMonth = annualTotalTxt != null ? Math.round(Number(annualTotalTxt) / 12) : null;
  let priceLabel, priceSubLabel;
  if (isFree) {
    priceLabel = 'Free'; priceSubLabel = 'forever';
  } else if (tier.isCustomPriced) {
    priceLabel = 'Custom price'; priceSubLabel = 'contact sales';
  } else if (priceRow) {
    if (billingPeriod === 'yearly') {
      priceLabel = `${spec.symbol}${(annualPerMonth ?? 0).toLocaleString('en-IN')}/mo`;
      priceSubLabel = annualTotalTxt != null ? `${spec.symbol}${Number(annualTotalTxt).toLocaleString('en-IN')}/yr billed yearly` : 'billed yearly';
    } else {
      priceLabel = `${spec.symbol}${minorToDisplay(priceRow.amountMonthlyMinor, spec.code)}/mo`;
      priceSubLabel = annualPerMonth != null ? `${spec.symbol}${annualPerMonth.toLocaleString('en-IN')}/mo if billed yearly` : spec.code;
    }
  } else {
    priceLabel = `No ${spec.code} price`; priceSubLabel = '';
  }
  const featureCount = tier._count?.tierFeatures ?? 0;

  return (
    <div className={`rounded-2xl border bg-white transition-shadow ${expanded ? 'border-indigo-300 shadow-md' : 'border-gray-200 hover:border-gray-300'} ${!tier.isActive ? 'opacity-70' : ''}`}>
      {/* Collapsed header — always visible. */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="flex flex-col">
          <button onClick={() => onMove(-1)} disabled={isFirst} className="leading-none text-gray-300 hover:text-gray-600 disabled:opacity-20" title="Move up">▲</button>
          <button onClick={() => onMove(1)} disabled={isLast} className="leading-none text-gray-300 hover:text-gray-600 disabled:opacity-20" title="Move down">▼</button>
        </div>
        <button onClick={onToggle} className="flex flex-1 items-center gap-3 text-left min-w-0">
          <span className={`shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900 truncate">{tier.name}</span>
              {tier.badge && <span className="rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5">{tier.badge}</span>}
              {tier.highlighted && <span className="rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5">Featured</span>}
              {isFree && <span className="rounded-full bg-slate-100 text-slate-500 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5" title="The default tier new signups land on. It is intentionally not shown as a card on the public pricing page.">Signup default · not a public card</span>}
              {!tier.isActive && <span className="rounded-full bg-gray-200 text-gray-600 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5">Archived</span>}
            </div>
            <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">{tier.slug} · {featureCount} feature{featureCount === 1 ? '' : 's'}{tier.trialDays ? ` · ${tier.trialDays}d trial` : ''}</p>
          </div>
        </button>
        <div className="shrink-0 text-right hidden sm:block">
          <p className="font-semibold text-gray-900">{priceLabel}</p>
          <p className="text-[11px] text-gray-400">{priceSubLabel}</p>
        </div>
        <button
          onClick={onToggleActive}
          className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold ${tier.isActive ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
          title={tier.isActive ? 'Click to archive' : 'Click to activate'}
        >
          {tier.isActive ? 'Active' : 'Archived'}
        </button>
      </div>

      {/* Expanded editor. */}
      {expanded && (
        <div className="border-t border-gray-100">
          {loadingFull && !full ? (
            <div className="py-8 flex justify-center"><Spinner /></div>
          ) : full ? (
            <>
              <div className="flex items-center gap-1 px-4 pt-3">
                {[
                  { key: 'details', label: 'Plan details' },
                  { key: 'content', label: `Content (${full.features?.length || 0})` },
                  { key: 'pricing', label: 'Pricing' },
                ].map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setSection(s.key)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium ${section === s.key ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:text-gray-800'}`}
                  >
                    {s.label}
                  </button>
                ))}
                <button onClick={onArchive} className="ml-auto text-xs text-red-600 hover:underline">Archive plan</button>
              </div>
              <div className="px-4 py-4">
                {section === 'details' && <PlanDetailsSection tier={full} onSaved={refresh} />}
                {section === 'content' && <PlanFeaturesSection tier={full} onSaved={refresh} />}
                {section === 'pricing' && <PlanPricingSection tier={full} onSaved={refresh} />}
              </div>
            </>
          ) : (
            <p className="px-4 py-6 text-sm text-red-600">Couldn’t load this plan. <button onClick={loadFull} className="underline">Retry</button></p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section (a): Plan details — name, badge, tagline, CTA, trial, included
// staff/branches, highlighted, custom-priced. Saves via PUT /tiers/:id.
function PlanDetailsSection({ tier, onSaved }) {
  const placeholders = TIER_PLACEHOLDERS[tier.slug] || {};
  const [form, setForm] = useState({
    name: tier.name || '',
    vertical: tier.vertical || 'APPOINTMENT',
    badge: tier.badge || '',
    tagline: tier.tagline || '',
    description: tier.description || '',
    ctaLabel: tier.ctaLabel || '',
    ctaHref: tier.ctaHref || '',
    highlighted: !!tier.highlighted,
    isCustomPriced: !!tier.isCustomPriced,
    trialEnabled: Number(tier.trialDays) > 0,
    trialDays: tier.trialDays ?? '',
    includedStaff: tier.includedStaff ?? '',
    includedBranches: tier.includedBranches ?? '',
    contactSalesAboveBranches: tier.contactSalesAboveBranches ?? '',
    note: '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setSaving(true); setErr('');
    try {
      await axios.put(`/api/admin/pricing/tiers/${tier.id}`, {
        name: form.name,
        vertical: form.vertical,
        badge: form.badge,
        tagline: form.tagline,
        description: form.description,
        ctaLabel: form.ctaLabel,
        ctaHref: form.ctaHref,
        highlighted: form.highlighted,
        isCustomPriced: form.isCustomPriced,
        trialDays: form.trialEnabled ? Number(form.trialDays || 30) : null,
        includedStaff: form.includedStaff === '' ? null : Number(form.includedStaff),
        includedBranches: form.includedBranches === '' ? null : Number(form.includedBranches),
        contactSalesAboveBranches: form.contactSalesAboveBranches === '' ? null : Number(form.contactSalesAboveBranches),
        note: form.note,
      }, { withCredentials: true });
      onSaved('Plan details saved');
    } catch (e) { setErr(e.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-3">
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Display name" value={form.name} placeholder="Professional" onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
        <Field label="Badge (e.g. Most Popular)" value={form.badge} onChange={(v) => setForm((f) => ({ ...f, badge: v }))} />
      </div>
      <Field label="Tagline (line under the plan name)" value={form.tagline} placeholder={placeholders.tagline || 'For teams ready to scale.'} onChange={(v) => setForm((f) => ({ ...f, tagline: v }))} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="CTA button label" value={form.ctaLabel} placeholder={placeholders.ctaLabel || 'Start trial'} onChange={(v) => setForm((f) => ({ ...f, ctaLabel: v }))} />
        <Field label="CTA link (optional — overrides signup)" value={form.ctaHref} placeholder={placeholders.ctaHref || 'mailto:sales@sitepresso.com'} onChange={(v) => setForm((f) => ({ ...f, ctaHref: v }))} />
      </div>
      <Field label="Internal description (admin lists only, not public)" value={form.description} placeholder="Small clinic / team" onChange={(v) => setForm((f) => ({ ...f, description: v }))} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Included staff (blank = n/a)" value={form.includedStaff} placeholder="10" onChange={(v) => setForm((f) => ({ ...f, includedStaff: v }))} />
        <Field label="Included branches (blank = n/a)" value={form.includedBranches} placeholder="3" onChange={(v) => setForm((f) => ({ ...f, includedBranches: v }))} />
        <Field label="Contact Sales above N branches" value={form.contactSalesAboveBranches} placeholder="3" onChange={(v) => setForm((f) => ({ ...f, contactSalesAboveBranches: v }))} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Vertical (catalogue)</span>
          <select value={form.vertical} onChange={(e) => setForm((f) => ({ ...f, vertical: e.target.value }))}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
            <option value="APPOINTMENT">Booking site</option>
            <option value="ECOMMERCE">Online shop</option>
            <option value="STATIC">Marketing site</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Trial</span>
          <div className="flex items-center gap-2 rounded border border-gray-300 px-2 py-1.5">
            <input type="checkbox" checked={form.trialEnabled}
              onChange={(e) => setForm((f) => ({ ...f, trialEnabled: e.target.checked, trialDays: e.target.checked ? (f.trialDays || 30) : f.trialDays }))} />
            <span className="text-sm text-gray-700">Offer trial</span>
            <input type="number" min="1" max="365" disabled={!form.trialEnabled} value={form.trialDays || ''}
              onChange={(e) => setForm((f) => ({ ...f, trialDays: e.target.value }))}
              placeholder="30"
              className={`ml-auto w-20 px-2 py-1 border border-gray-300 rounded text-sm ${form.trialEnabled ? '' : 'bg-gray-50 text-gray-400'}`} />
            <span className="text-xs text-gray-400">days</span>
          </div>
        </label>
      </div>

      <label className="flex items-start gap-2 text-sm p-2 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50">
        <input type="checkbox" className="mt-0.5" checked={form.highlighted} onChange={(e) => setForm((f) => ({ ...f, highlighted: e.target.checked }))} />
        <span><span className="block font-medium">Highlighted card (“Most Popular” ring)</span><span className="block text-xs text-gray-500">Emphasise this plan on the pricing page. Usually one plan.</span></span>
      </label>
      <label className="flex items-start gap-2 text-sm p-2 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50">
        <input type="checkbox" className="mt-0.5" checked={form.isCustomPriced} onChange={(e) => setForm((f) => ({ ...f, isCustomPriced: e.target.checked }))} />
        <span><span className="block font-medium">Custom-priced</span><span className="block text-xs text-gray-500">Hide the price and show “Contact us” on the public page.</span></span>
      </label>

      <Field label="Reason for change (optional)" value={form.note} onChange={(v) => setForm((f) => ({ ...f, note: v }))} />

      <div className="flex justify-end pt-1">
        <button onClick={save} disabled={saving || !form.name}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:bg-gray-300">
          {saving ? 'Saving…' : 'Save details'}
        </button>
      </div>
    </div>
  );
}

// ── Section (b): Plan content (features). Two things live here:
//   1. Marketing bullets (tier.features string[]) — drive the public card copy.
//   2. Structured tierFeatures rows — add / edit / reorder / remove inline via
//      the feature endpoints. This is the "content in plan" editor.
function PlanFeaturesSection({ tier, onSaved }) {
  const [features, setFeatures] = useState(tier.tierFeatures || []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState({ displayLabel: '', featureKey: '', featureType: 'BOOLEAN', featureValue: '', isHighlighted: false });
  // Marketing bullets edited as a newline textarea (PUT /tiers features).
  const [bullets, setBullets] = useState(Array.isArray(tier.features) ? tier.features.join('\n') : '');
  const [bulletsSaving, setBulletsSaving] = useState(false);
  const placeholders = TIER_PLACEHOLDERS[tier.slug] || {};

  useEffect(() => { setFeatures(tier.tierFeatures || []); }, [tier.tierFeatures]);

  async function saveBullets() {
    setBulletsSaving(true); setErr('');
    try {
      await axios.put(`/api/admin/pricing/tiers/${tier.id}`, { features: bullets }, { withCredentials: true });
      onSaved('Card bullets saved');
    } catch (e) { setErr(e.response?.data?.message || 'Save failed'); }
    finally { setBulletsSaving(false); }
  }

  async function addFeature() {
    if (!newRow.displayLabel.trim()) return;
    setBusy(true); setErr('');
    const key = (newRow.featureKey || newRow.displayLabel).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || `f_${Date.now()}`;
    try {
      await axios.post(`/api/admin/pricing/tiers/${tier.id}/features`, {
        featureKey: key,
        displayLabel: newRow.displayLabel.trim(),
        featureType: newRow.featureType,
        featureValue: newRow.featureValue,
        isHighlighted: newRow.isHighlighted,
        sortOrder: (features[features.length - 1]?.sortOrder ?? features.length) + 1,
      }, { withCredentials: true });
      setNewRow({ displayLabel: '', featureKey: '', featureType: 'BOOLEAN', featureValue: '', isHighlighted: false });
      setAdding(false);
      onSaved('Feature added');
    } catch (e) { setErr(e.response?.data?.message || 'Could not add feature'); }
    finally { setBusy(false); }
  }

  async function updateLabel(f, displayLabel) {
    if (displayLabel === f.displayLabel) return;
    setErr('');
    try { await axios.put(`/api/admin/pricing/features/${f.id}`, { displayLabel }, { withCredentials: true }); onSaved('Feature updated'); }
    catch (e) { setErr(e.response?.data?.message || 'Update failed'); }
  }
  async function toggleHighlight(f) {
    try { await axios.put(`/api/admin/pricing/features/${f.id}`, { isHighlighted: !f.isHighlighted }, { withCredentials: true }); onSaved('Feature updated'); }
    catch (e) { setErr(e.response?.data?.message || 'Update failed'); }
  }
  async function removeFeature(f) {
    setErr('');
    try { await axios.delete(`/api/admin/pricing/features/${f.id}`, { withCredentials: true }); onSaved('Feature removed'); }
    catch (e) { setErr(e.response?.data?.message || 'Delete failed'); }
  }
  async function move(i, dir) {
    const target = i + dir;
    if (target < 0 || target >= features.length) return;
    const order = features.map((f) => f.id);
    [order[i], order[target]] = [order[target], order[i]];
    const next = [...features];
    [next[i], next[target]] = [next[target], next[i]];
    setFeatures(next);
    try { await axios.put(`/api/admin/pricing/tiers/${tier.id}/features/reorder`, { order }, { withCredentials: true }); onSaved('Reordered'); }
    catch (e) { setErr(e.response?.data?.message || 'Reorder failed'); }
  }

  return (
    <div className="space-y-5">
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}

      {/* Structured features (entitlement rows). */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-sm font-semibold text-gray-500">Advanced · structured entitlements (optional)</p>
            <p className="text-xs text-gray-400">Optional access-gating rows. These are NOT the public card copy — the landing &amp; billing cards show the “Plan features” list below. Leave empty unless you gate features by this.</p>
          </div>
          <button onClick={() => setAdding((a) => !a)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50">
            {adding ? 'Cancel' : '+ Add feature'}
          </button>
        </div>

        {adding && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 mb-3 space-y-2">
            <Field label="Label (shown to customers)" value={newRow.displayLabel} placeholder="Up to 10 staff members" onChange={(v) => setNewRow((r) => ({ ...r, displayLabel: v }))} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Field label="Key (auto if blank)" value={newRow.featureKey} placeholder="staff_seats" onChange={(v) => setNewRow((r) => ({ ...r, featureKey: v }))} />
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 mb-1">Type</span>
                <select value={newRow.featureType} onChange={(e) => setNewRow((r) => ({ ...r, featureType: e.target.value }))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
                  <option value="BOOLEAN">Boolean (included / not)</option>
                  <option value="NUMERIC">Numeric (a count/limit)</option>
                  <option value="UNLIMITED">Unlimited</option>
                </select>
              </label>
              <Field label="Value (for numeric)" value={newRow.featureValue} placeholder="10" onChange={(v) => setNewRow((r) => ({ ...r, featureValue: v }))} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={newRow.isHighlighted} onChange={(e) => setNewRow((r) => ({ ...r, isHighlighted: e.target.checked }))} />
              Highlight this feature on the card
            </label>
            <div className="flex justify-end">
              <button onClick={addFeature} disabled={busy || !newRow.displayLabel.trim()}
                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:bg-gray-300">
                {busy ? 'Adding…' : 'Add feature'}
              </button>
            </div>
          </div>
        )}

        {features.length === 0 ? (
          <p className="text-sm text-gray-400 rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center">No structured features yet.</p>
        ) : (
          <div className="rounded-xl border border-gray-200 divide-y divide-gray-100">
            {features.map((f, i) => (
              <div key={f.id} className="flex items-center gap-2 px-3 py-2">
                <div className="flex flex-col">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="leading-none text-gray-300 hover:text-gray-600 disabled:opacity-20">▲</button>
                  <button onClick={() => move(i, 1)} disabled={i === features.length - 1} className="leading-none text-gray-300 hover:text-gray-600 disabled:opacity-20">▼</button>
                </div>
                <input
                  defaultValue={f.displayLabel}
                  onBlur={(e) => updateLabel(f, e.target.value)}
                  className="flex-1 min-w-0 px-2 py-1 border border-transparent rounded text-sm hover:border-gray-200 focus:border-indigo-400 focus:outline-none"
                />
                <span className="shrink-0 text-[10px] font-mono uppercase text-gray-400 px-1.5">{f.featureType}{f.featureType === 'NUMERIC' && f.featureValue ? `·${f.featureValue}` : ''}</span>
                <button onClick={() => toggleHighlight(f)} title="Toggle highlight"
                  className={`shrink-0 text-xs px-1.5 ${f.isHighlighted ? 'text-amber-500' : 'text-gray-300 hover:text-gray-500'}`}>★</button>
                <button onClick={() => removeFeature(f)} className="shrink-0 text-red-500 hover:text-red-700 text-xs px-1.5" title="Remove">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Marketing bullets (tier.features). */}
      <div className="pt-4 border-t border-gray-100">
        <p className="text-sm font-semibold text-gray-900">Plan features — shown on the landing &amp; billing cards</p>
        <p className="text-xs text-gray-500 mb-2">One per line. <b>This is the single source</b> for what customers see on the public pricing page and the in-app billing cards. Up to 20.</p>
        <textarea
          value={bullets}
          onChange={(e) => setBullets(e.target.value)}
          placeholder={placeholders.features || 'Everything in previous plan\nFeature 2\nFeature 3'}
          rows={8}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="flex justify-end mt-2">
          <button onClick={saveBullets} disabled={bulletsSaving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:bg-gray-300">
            {bulletsSaving ? 'Saving…' : 'Save bullets'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section (c): Pricing — the 5 supported currencies × Monthly / Yearly
// (+ per-seat). Each currency maps to one canonical TierPrice row; saving an
// inline edit upserts that row via PUT /prices with the right country+currency.
function PlanPricingSection({ tier, onSaved }) {
  // Build editable rows keyed by currency, seeded from the tier's price rows.
  const seed = useMemo(() => {
    const out = {};
    for (const spec of PRICING_CURRENCIES) {
      const row = priceRowForCurrency(tier.prices, spec);
      out[spec.code] = {
        monthly: row ? minorToDisplay(row.amountMonthlyMinor, spec.code) : '',
        yearly: row ? minorToDisplay(row.amountAnnualMinor, spec.code) : '',
        seat: row && row.overageStaffPriceMinor ? minorToDisplay(row.overageStaffPriceMinor, spec.code) : '',
        published: gatewayIdsSet(row, spec.code),
        exists: !!row,
      };
    }
    return out;
  }, [tier.prices]);

  const [rows, setRows] = useState(seed);
  const [savingCode, setSavingCode] = useState('');
  const [savingAll, setSavingAll] = useState(false);
  const [filling, setFilling] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setRows(seed); }, [seed]);

  // "Fill from USD": derive the other currencies from the USD monthly. Each one =
  // USD × (its region's ZONE multiplier — the PPP discount) × FX, rounded. This
  // is what makes the zone assignment matter: set India to a cheaper zone and the
  // INR fill drops. Stays gateway-safe (one fixed price per currency).
  async function fillFromUsd() {
    const usd = Number(rows.USD?.monthly);
    if (!Number.isFinite(usd) || usd <= 0) { setErr('Set the USD monthly price first, then Fill.'); return; }
    setFilling(true); setErr('');
    try {
      const { data } = await axios.get('/api/admin/pricing/countries', { withCredentials: true });
      const byCode = Object.fromEntries((data.countries || []).map((c) => [c.countryCode, c]));
      setRows((prev) => {
        const next = { ...prev };
        for (const spec of PRICING_CURRENCIES) {
          if (spec.code === 'USD' || !FX_FROM_USD[spec.code]) continue;
          const mult = Number(byCode[spec.countryCode]?.zone?.multiplier || 1);
          const monthly = roundNicePrice(usd * mult * FX_FROM_USD[spec.code], spec.code);
          next[spec.code] = { ...(prev[spec.code] || {}), monthly: String(monthly) };
        }
        return next;
      });
    } catch (e) { setErr('Could not load zones for the fill — try again.'); }
    finally { setFilling(false); }
  }

  // Annual discount drives the yearly price. Inferred on load from the USD base
  // row (so existing plans keep their current saving), editable as one number
  // that applies to every currency. autoYearly off = type each yearly by hand.
  const inferredDiscount = useMemo(() => {
    const pct = annualDiscountPctForRow(priceRowForCurrency(tier.prices, PRICING_CURRENCIES[0]));
    return pct > 0 ? pct : 20;
  }, [tier.prices]);
  const [discountPct, setDiscountPct] = useState(String(inferredDiscount));
  const [autoYearly, setAutoYearly] = useState(true);
  useEffect(() => { setDiscountPct(String(inferredDiscount)); }, [inferredDiscount]);

  function setCell(code, key, value) {
    setRows((r) => ({ ...r, [code]: { ...r[code], [key]: value } }));
  }

  // The yearly amount we actually persist for a row: computed from the discount
  // when auto is on, else the hand-typed value.
  function effectiveYearly(spec) {
    const r = rows[spec.code] || {};
    return autoYearly ? yearlyFromDiscount(r.monthly, spec.code, discountPct) : r.yearly;
  }

  async function persistRow(spec) {
    const r = rows[spec.code];
    const yearlyVal = effectiveYearly(spec);
    if (r.monthly === '' || yearlyVal === '') throw new Error(`Enter a monthly price for ${spec.code}`);
    await axios.put('/api/admin/pricing/prices', {
      tierId: tier.id,
      countryCode: spec.countryCode,        // null for USD base
      currencyCode: spec.code,
      amountMonthlyMinor: displayToMinor(r.monthly, spec.code),
      amountAnnualMinor: displayToMinor(yearlyVal, spec.code),
      overageStaffPriceMinor: r.seat ? displayToMinor(r.seat, spec.code) : 0,
    }, { withCredentials: true });
  }

  async function saveRow(spec) {
    setSavingCode(spec.code); setErr('');
    try { await persistRow(spec); onSaved(`${spec.code} price saved`); }
    catch (e) { setErr(e.response?.data?.message || e.message || 'Save failed'); }
    finally { setSavingCode(''); }
  }

  // Save every currency that has a monthly price — handy after changing the
  // discount, since it re-derives + persists all yearly amounts at once.
  async function saveAll() {
    setSavingAll(true); setErr('');
    try {
      const specs = PRICING_CURRENCIES.filter((s) => (rows[s.code]?.monthly || '') !== '');
      for (const spec of specs) await persistRow(spec);
      onSaved('All currencies saved');
    } catch (e) { setErr(e.response?.data?.message || e.message || 'Save failed'); }
    finally { setSavingAll(false); }
  }

  if (tier.isCustomPriced) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
          This plan is <span className="font-semibold">custom-priced</span> — prices below are informational and don’t show on the public page. Turn off “Custom-priced” in Plan details to sell it self-serve.
        </p>
        {renderGrid()}
      </div>
    );
  }
  return renderGrid();

  function renderGrid() {
    return (
      <div className="space-y-3">
        {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
        <p className="text-xs text-gray-500">
          Set the price in each of the {PRICING_CURRENCIES.length} billing currencies. USD is the base; the others map to the country whose gateway presents in that currency. A subtle dot shows whether the gateway price-id is published.
        </p>

        {/* One USD number → derive the rest. */}
        <div className="flex items-center gap-2 flex-wrap rounded-xl border border-indigo-200 bg-indigo-50/60 px-3 py-2">
          <button onClick={fillFromUsd} disabled={filling}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:bg-gray-300">
            {filling ? 'Filling…' : '↻ Fill from USD'}
          </button>
          <span className="text-[11px] text-gray-500">Type the <b>USD monthly</b>, then Fill — derives every other currency as <b>USD × the region&apos;s zone multiplier (PPP) × FX</b>, rounded. Review/edit, then <b>Save all currencies</b>. Want India cheaper? Move it to a lower zone in <i>Advanced ▸ Regions &amp; zones</i> and re-Fill.</span>
        </div>

        {/* Annual discount drives the Yearly column — type the monthly price and
            the yearly is computed (0% = no discount). Turn off to enter by hand. */}
        <div className="flex items-center gap-3 flex-wrap rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2">
          <span className="text-xs font-semibold text-gray-700">Annual billing</span>
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
            <input type="checkbox" checked={autoYearly} onChange={(e) => setAutoYearly(e.target.checked)} className="accent-indigo-600" />
            Set yearly from a discount
          </label>
          {autoYearly && (
            <span className="inline-flex items-center gap-1">
              <input
                type="text" inputMode="numeric" value={discountPct}
                onChange={(e) => setDiscountPct(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
                className="w-14 rounded border border-gray-300 px-2 py-1 text-right text-sm focus:outline-none focus:border-indigo-400"
              />
              <span className="text-sm text-gray-600">% off</span>
            </span>
          )}
          <span className="text-[11px] text-gray-400">
            {autoYearly
              ? `Yearly = 12× monthly − ${Number(discountPct) || 0}% (applied to every currency, rounded). Set 0 for no discount.`
              : 'Manual mode — type each yearly amount in the grid.'}
          </span>
        </div>
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-mono uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-3 py-2.5 text-left">Currency</th>
                <th className="px-3 py-2.5 text-right">Monthly</th>
                <th className="px-3 py-2.5 text-right">Yearly</th>
                <th className="px-3 py-2.5 text-right">Per extra seat /mo</th>
                <th className="px-3 py-2.5 text-center">Published</th>
                <th className="px-3 py-2.5 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {PRICING_CURRENCIES.map((spec) => {
                const r = rows[spec.code] || {};
                return (
                  <tr key={spec.code} className="border-t border-gray-100">
                    <td className="px-3 py-2">
                      <div className="font-semibold text-gray-900">{spec.symbol} {spec.code}{spec.countryCode == null && <span className="ml-1 text-[10px] font-bold text-indigo-600">BASE</span>}</div>
                      <div className="text-[11px] text-gray-400">{spec.region}</div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyInput symbol={spec.symbol} value={r.monthly} onChange={(v) => setCell(spec.code, 'monthly', v)} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {autoYearly ? (
                        <span className="inline-block w-28 ml-auto text-right text-sm text-gray-500 tabular-nums" title="Computed from monthly × the annual discount">
                          {r.monthly ? `${spec.symbol}${yearlyFromDiscount(r.monthly, spec.code, discountPct)}` : '—'}
                        </span>
                      ) : (
                        <MoneyInput symbol={spec.symbol} value={r.yearly} onChange={(v) => setCell(spec.code, 'yearly', v)} />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyInput symbol={spec.symbol} value={r.seat} onChange={(v) => setCell(spec.code, 'seat', v)} placeholder="—" />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span title={r.published ? 'Gateway price ID is set' : 'Not published to gateway yet — use Publish'}
                        className={`inline-block h-2.5 w-2.5 rounded-full ${r.published ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => saveRow(spec)} disabled={savingCode === spec.code}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:bg-gray-300">
                        {savingCode === spec.code ? '…' : 'Save'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-[11px] text-gray-400">Amounts are in major units (e.g. 19 = {PRICING_CURRENCIES[0].symbol}19.00). After changing prices, hit <span className="font-semibold">Publish to gateways</span> so the charged price matches.</p>
          <button onClick={saveAll} disabled={savingAll}
            className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:bg-gray-300">
            {savingAll ? 'Saving…' : 'Save all currencies'}
          </button>
        </div>
      </div>
    );
  }
}

// Small inline money input with a leading currency symbol.
function MoneyInput({ symbol, value, onChange, placeholder }) {
  return (
    <div className="inline-flex items-center rounded border border-gray-300 px-2 py-1 focus-within:border-indigo-400 w-28 ml-auto">
      <span className="text-xs text-gray-400 mr-1">{symbol}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value || ''}
        placeholder={placeholder || '0'}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        className="w-full bg-transparent text-right text-sm focus:outline-none"
      />
    </div>
  );
}

// ── New-plan modal — minimal: create the tier shell + a base USD price, then
// the super-admin expands the new card to fill in content + the other
// currencies. Backed by POST /tiers.
function NewPlanModal({ vertical, onClose, onSaved }) {
  const [form, setForm] = useState({ slug: '', name: '', baseMonthlyUsd: '', isCustomPriced: false });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setSaving(true); setErr('');
    try {
      await axios.post('/api/admin/pricing/tiers', {
        slug: form.slug,
        name: form.name,
        vertical,
        isCustomPriced: form.isCustomPriced,
        baseMonthlyUsd: form.isCustomPriced ? null : (form.baseMonthlyUsd || 0),
        sortOrder: 999,
      }, { withCredentials: true });
      onSaved();
    } catch (e) { setErr(e.response?.data?.message || 'Create failed'); }
    finally { setSaving(false); }
  }

  return (
    <Modal onClose={onClose} title="New plan">
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2 mb-3">{err}</p>}
      <div className="space-y-3">
        <p className="text-xs text-gray-500">Create the plan shell in the <span className="font-semibold text-gray-700">{PRICING_VERTICALS.find((v) => v.key === vertical)?.label}</span> catalogue. You’ll add content and the other currencies right on its card.</p>
        <Field label="Slug (lowercase, no spaces)" placeholder="professional" value={form.slug}
          onChange={(v) => setForm((f) => ({ ...f, slug: v.toLowerCase().replace(/[^a-z0-9-_]/g, '') }))} />
        <Field label="Display name" placeholder="Professional" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
        {!form.isCustomPriced && (
          <Field label="Base monthly USD" placeholder="19" value={form.baseMonthlyUsd} onChange={(v) => setForm((f) => ({ ...f, baseMonthlyUsd: v.replace(/[^0-9.]/g, '') }))} />
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isCustomPriced} onChange={(e) => setForm((f) => ({ ...f, isCustomPriced: e.target.checked }))} />
          Custom-priced (hide price, show “Contact us”)
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
        <button onClick={save} disabled={saving || !form.slug || !form.name}
          className="px-5 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:bg-gray-300">
          {saving ? 'Creating…' : 'Create plan'}
        </button>
      </div>
    </Modal>
  );
}

// Default landing-page copy shown as placeholders when admins edit blank
// fields. Updated 2026-04-29 to match the 4×3 paid grid (Solo / Starter /
// Professional / Business — no permanent free tier). Slug 'free' is
// preserved internally (signup default + trial-expiry fallback) but its
// display name is now "Solo" with a $9 base price. The defaults below are
// seeded into the database by `prisma/seeds/pricing.seed.js`, so the
// placeholders match the live card content. Placeholders cover APPOINTMENT
// copy; STATIC + ECOMMERCE tiers have their own seeded card content.
const TIER_PLACEHOLDERS = {
  free: {
    tagline: 'Take your first booking by tonight.',
    ctaLabel: 'Start 30-day trial',
    features: [
      '1 staff member',
      '.sitepresso.com subdomain',
      'Platform-managed checkout',
      'Email reminders',
      'Google / Apple calendar sync',
      '"Powered by DriftHR" branding',
    ].join('\n'),
  },
  starter: {
    tagline: 'Look like you paid an agency.',
    ctaLabel: 'Start 30-day trial',
    features: [
      'Everything in Solo',
      'Up to 2 staff members',
      'Custom domain (yours.com)',
      'Branding watermark removed',
      '200 SMS reminders / month',
      'Basic CRM & client notes',
    ].join('\n'),
  },
  professional: {
    tagline: 'Built for teams that convert enquiries to revenue.',
    ctaLabel: 'Start 30-day trial',
    features: [
      'Everything in Starter',
      'Up to 10 staff members',
      'Service & staff routing',
      'Full CRM with tags & segments',
      'Marketing automation',
      'Unlimited SMS reminders',
      'Advanced intake forms',
      'Analytics & reports',
    ].join('\n'),
  },
  business: {
    tagline: 'Multi-location, unlimited staff, priority support.',
    ctaLabel: 'Talk to sales',
    ctaHref: 'mailto:sales@sitepresso.com',
    features: [
      'Everything in Professional',
      'Unlimited staff',
      'Multi-location (coming Q3 2026)',
      'Role-based access control (coming Q3 2026)',
      'API access & webhooks (coming Q3 2026)',
      'Priority support',
      'Dedicated success manager',
    ].join('\n'),
  },
};

// ---------------- Zones subtab ----------------

function ZonesSubtab() {
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [savingId, setSavingId] = useState(null);

  async function load() {
    setLoading(true); setErr('');
    try {
      const { data } = await axios.get('/api/admin/pricing/zones', { withCredentials: true });
      setZones(data.zones || []);
    } catch (e) { setErr(e.response?.data?.message || 'Failed to load zones'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  function setField(id, patch) {
    setZones((zs) => zs.map((z) => z.id === id ? { ...z, ...patch } : z));
  }

  async function save(z) {
    setSavingId(z.id); setErr('');
    try {
      await axios.put(`/api/admin/pricing/zones/${z.id}`, {
        name: z.name, description: z.description, multiplier: z.multiplier,
      }, { withCredentials: true });
      load();
    } catch (e) { setErr(e.response?.data?.message || 'Save failed'); }
    finally { setSavingId(null); }
  }

  if (loading) return <div className="py-8 flex justify-center"><Spinner /></div>;

  return (
    <div className="space-y-3">
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{err}</p>}
      <p className="text-sm text-gray-500">
        Multipliers are applied to base USD prices to generate country prices inside each zone
        (e.g. Zone 4 × $59 = $17.70). Lower multiplier = cheaper prices in that zone.
      </p>
      <div className="space-y-3">
        {zones.map((z) => (
          <div key={z.id} className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex-1">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <Field label="Name" value={z.name} onChange={(v) => setField(z.id, { name: v })} />
                  <Field label="Multiplier (0–1)" value={z.multiplier} onChange={(v) => setField(z.id, { multiplier: v })} />
                  <Field label="Description" value={z.description || ''} onChange={(v) => setField(z.id, { description: v })} />
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  {z._count?.countries ?? 0} countries in this zone
                </p>
              </div>
              <button
                onClick={() => save(z)}
                disabled={savingId === z.id}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:bg-gray-300"
              >
                {savingId === z.id ? '...' : 'Save'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- Countries subtab ----------------

function CountriesSubtab() {
  const [countries, setCountries] = useState([]);
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState('all');
  const [regionFilter, setRegionFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [bulkZone, setBulkZone] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try {
      const [c, z] = await Promise.all([
        axios.get('/api/admin/pricing/countries', { withCredentials: true }),
        axios.get('/api/admin/pricing/zones', { withCredentials: true }),
      ]);
      setCountries(c.data.countries || []);
      setZones(z.data.zones || []);
    } catch (e) { setErr(e.response?.data?.message || 'Failed to load'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    return countries.filter((c) => {
      if (zoneFilter !== 'all' && c.zone?.slug !== zoneFilter) return false;
      if (regionFilter !== 'all' && c.region !== regionFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!c.countryName.toLowerCase().includes(q) && !c.countryCode.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [countries, zoneFilter, regionFilter, search]);

  const regions = useMemo(() => {
    const s = new Set(countries.map((c) => c.region).filter(Boolean));
    return Array.from(s).sort();
  }, [countries]);

  async function changeZone(countryCode, zoneId) {
    try {
      await axios.put(`/api/admin/pricing/countries/${countryCode}`, { zoneId }, { withCredentials: true });
      load();
    } catch (e) { setErr(e.response?.data?.message || 'Update failed'); }
  }

  async function bulkAssign() {
    if (!bulkZone || selected.size === 0) return;
    try {
      await axios.put('/api/admin/pricing/countries/bulk',
        { countryCodes: Array.from(selected), zoneId: bulkZone },
        { withCredentials: true });
      setSelected(new Set()); setBulkZone('');
      load();
    } catch (e) { setErr(e.response?.data?.message || 'Bulk assign failed'); }
  }

  function toggleSelect(code) {
    const next = new Set(selected);
    next.has(code) ? next.delete(code) : next.add(code);
    setSelected(next);
  }
  function selectAllVisible() {
    setSelected(new Set(visible.map((c) => c.countryCode)));
  }

  if (loading) return <div className="py-8 flex justify-center"><Spinner /></div>;

  return (
    <div className="space-y-3">
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{err}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search" placeholder="Search country or code…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm flex-1 min-w-[200px]"
        />
        <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="all">All zones</option>
          {zones.map((z) => <option key={z.id} value={z.slug}>{z.name}</option>)}
        </select>
        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="all">All regions</option>
          {regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <span className="text-xs text-gray-500">{visible.length} / {countries.length}</span>
      </div>

      {selected.size > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm text-indigo-900 font-medium">{selected.size} selected</span>
          <select value={bulkZone} onChange={(e) => setBulkZone(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm">
            <option value="">Assign to zone…</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
          <button onClick={bulkAssign} disabled={!bulkZone}
            className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:bg-gray-300">
            Apply
          </button>
          <button onClick={() => setSelected(new Set())} className="text-sm text-gray-600 hover:text-gray-900">Clear</button>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-mono uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-3 py-2.5 text-left"><button onClick={selectAllVisible} title="Select all visible">☐</button></th>
              <th className="px-3 py-2.5 text-left">Code</th>
              <th className="px-3 py-2.5 text-left">Country</th>
              <th className="px-3 py-2.5 text-left">Region</th>
              <th className="px-3 py-2.5 text-left">Billed in</th>
              <th className="px-3 py-2.5 text-left">Zone</th>
              <th className="px-3 py-2.5 text-left">Override</th>
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, 500).map((c) => (
              <tr key={c.countryCode} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(c.countryCode)} onChange={() => toggleSelect(c.countryCode)} />
                </td>
                <td className="px-3 py-2 font-mono text-gray-600">{c.countryCode}</td>
                <td className="px-3 py-2 text-gray-900">{c.countryName}</td>
                <td className="px-3 py-2 text-gray-500">{c.region || '—'}</td>
                <td className="px-3 py-2 text-gray-700">
                  {(() => {
                    const bill = currencyForCountry(c.countryCode);
                    const sym = PRICING_CURRENCIES.find((x) => x.code === bill)?.symbol || '';
                    const native = (c.currencyCode && c.currencyCode !== bill) ? c.currencyCode : null;
                    return (
                      <span>
                        <span className="font-mono font-semibold">{bill}</span> <span className="text-gray-400">{sym}</span>
                        {native && <span className="ml-1.5 text-[10px] text-gray-300" title="Local currency — not billed in">({native})</span>}
                      </span>
                    );
                  })()}
                </td>
                <td className="px-3 py-2">
                  <select value={c.zone?.id || ''} onChange={(e) => changeZone(c.countryCode, e.target.value)}
                    className="px-2 py-1 border border-gray-300 rounded text-sm">
                    {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">
                  {c.isOverride ? <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-100 text-amber-700">OVERRIDE</span> : <span className="text-gray-300 text-xs">default</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length > 500 && (
          <p className="text-center text-xs text-gray-500 py-3 border-t border-gray-100">
            Showing first 500 of {visible.length} — refine your search to see more.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------- Shared modal + field helpers ----------------

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}


function Field({ label, value, onChange, placeholder, disabled = false }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={`w-full px-2 py-1.5 border border-gray-300 rounded text-sm ${disabled ? 'bg-gray-50 text-gray-400 cursor-not-allowed' : ''}`}
      />
    </label>
  );
}

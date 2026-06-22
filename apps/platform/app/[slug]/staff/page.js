'use client';

import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTenant } from '@/components/TenantProvider';
import LogoutButton from '@/components/LogoutButton';
import LanguageSelector from '@/components/LanguageSelector';
import AppointmentsPanel from '@/components/AppointmentsPanel';
import WalkInsPanel from '@/components/WalkInsPanel';
import NotificationInboxPanel from '@/components/NotificationInboxPanel';
import WeekCalendar from '@/components/WeekCalendar';
import { redirectToLogin } from '@/lib/loginRedirect';
import { useConfirm } from '@/components/ConfirmDialog';
import { useTranslations } from 'next-intl';

// Day value order: Mon→Sun (0=Sun…6=Sat matches Date.getDay())
const DAY_KEYS = [
  { value: 1, key: 'monday' },
  { value: 2, key: 'tuesday' },
  { value: 3, key: 'wednesday' },
  { value: 4, key: 'thursday' },
  { value: 5, key: 'friday' },
  { value: 6, key: 'saturday' },
  { value: 0, key: 'sunday' },
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
    throw err;
  }
  return body;
}

// STAFF_TABS and DAYS are now built inside StaffDashboardContent using translations.

function StaffDashboardContent() {
  const { tenant } = useTenant();
  const t = useTranslations('staff');
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | forbidden
  const [loadError, setLoadError] = useState('');

  const router = useRouter();
  const searchParams = useSearchParams();

  const DAYS = DAY_KEYS.map((d) => ({ value: d.value, label: t(`days.${d.key}`) }));

  const permissions = user?.businessRole?.permissions || {};
  const legacyProvider = user?.role === 'STAFF' && !user?.businessRoleId;
  const canSeeAppointments = legacyProvider ||
    permissions.canViewOwnAppointments ||
    permissions.canManageOwnAppointments ||
    permissions.canViewAllAppointments ||
    permissions.canManageAllAppointments;
  const canManageWalkIns = !!permissions.canManageWalkIns;
  const canEditOwnSchedule = legacyProvider || permissions.canEditOwnSchedule || permissions.canEditSchedules;
  const receivesBookings = legacyProvider || !!permissions.canReceiveAppointments;
  const deskFirst = canManageWalkIns && !receivesBookings;
  const STAFF_TABS = useMemo(() => [
    ...(deskFirst ? [
      { key: 'walkins', label: 'Walk-ins', sub: 'Add front-desk arrivals without changing the main appointment list' },
    ] : []),
    ...(canSeeAppointments ? [
      { key: 'today',        label: t('tabs.today'),        sub: t('tabs.todaySub') },
      { key: 'appointments', label: t('tabs.appointments'), sub: t('tabs.appointmentsSub') },
    ] : []),
    ...(!deskFirst && canManageWalkIns ? [
      { key: 'walkins', label: 'Walk-ins', sub: 'Add front-desk arrivals without changing the main appointment list' },
    ] : []),
    { key: 'notifications', label: t('tabs.notifications'), sub: t('tabs.notificationsSub') },
    ...(canEditOwnSchedule ? [
      { key: 'schedule', label: t('tabs.schedule'), sub: t('tabs.scheduleSub') },
      { key: 'time-off', label: t('tabs.timeOff'), sub: t('tabs.timeOffSub') },
    ] : []),
  ], [canSeeAppointments, canManageWalkIns, canEditOwnSchedule, deskFirst, t]);

  // Derive active tab from URL — falls back to 'today'
  const VALID_KEYS = STAFF_TABS.map((tab) => tab.key);
  const requestedTab = searchParams.get('tab');
  const fallbackTab = STAFF_TABS[0]?.key || 'notifications';
  const tab = VALID_KEYS.includes(requestedTab) ? requestedTab : fallbackTab;

  const setTab = useCallback((key) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('loginCode');
    params.set('tab', key);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const [rows, setRows] = useState(() =>
    DAYS.reduce((acc, d) => {
      acc[d.value] = { enabled: false, startTime: '09:00', endTime: '17:00' };
      return acc;
    }, {})
  );

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const params = new URLSearchParams(window.location.search);
        const loginCode = params.get('loginCode');
        if (loginCode) {
          try {
            await api('/api/auth/exchange-login-code', {
              method: 'POST',
              body: JSON.stringify({ code: loginCode }),
            });
          } catch {
            // Ignore expired/invalid one-time codes and fall through to the
            // normal auth check below.
          }
          params.delete('loginCode');
          const clean = params.toString();
          window.history.replaceState({}, '', window.location.pathname + (clean ? `?${clean}` : ''));
        }

        const { user } = await api('/api/auth/me');
        if (user.role !== 'STAFF') {
          setLoadError(t('errorStaffOnly'));
          setStatus('forbidden');
          return;
        }

        // Tenant guard: resolve by route slug on platform-path URLs
        // (sitepresso.com/<slug>/staff). Prevents staff of business A
        // from loading a different business's staff shell via the URL.
        const routeSlug = typeof window !== 'undefined'
          ? (window.location.pathname.split('/')[1] || '')
          : '';
        const tenantRes = routeSlug
          ? await fetch(`/api/tenant/resolve?slug=${encodeURIComponent(routeSlug)}`, {
              credentials: 'include',
            }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
          : null;
        const tenantBizId = tenantRes?.business?.id;
        if (tenantBizId && user.businessId && tenantBizId !== user.businessId) {
          setLoadError(t('errorDifferentBusiness'));
          setStatus('forbidden');
          return;
        }
        if (String(tenantRes?.business?.vertical || '').toUpperCase() === 'ECOMMERCE') {
          window.location.replace(`/${routeSlug}/staff/manager${window.location.search || ''}`);
          return;
        }

        const { schedule } = await api('/api/schedule').catch((err) => {
          if (err.status === 403) throw err;
          return { schedule: [] };
        });
        setUser(user);
        applyScheduleToRows(schedule);
        setStatus('ready');
      } catch (err) {
        if (err.status === 401) {
          redirectToLogin();
          return;
        }
        if (err.status === 403) {
          setLoadError(t('errorForbidden'));
          setStatus('forbidden');
          return;
        }
        setLoadError(err.message || t('errorGeneric'));
        setStatus('forbidden');
      }
    }
    load();
  }, []);

  function applyScheduleToRows(schedule) {
    setRows((prev) => {
      const next = { ...prev };
      for (const d of DAYS) next[d.value] = { ...next[d.value], enabled: false };
      for (const s of schedule) {
        next[s.dayOfWeek] = { enabled: true, startTime: s.startTime, endTime: s.endTime };
      }
      return next;
    });
  }

  async function saveSchedule() {
    setSaving(true); setSaveMsg(''); setSaveErr('');

    const slots = DAYS
      .filter((d) => rows[d.value].enabled)
      .map((d) => ({
        dayOfWeek: d.value,
        startTime: rows[d.value].startTime,
        endTime: rows[d.value].endTime,
      }));

    try {
      const { schedule } = await api('/api/schedule', { method: 'POST', body: JSON.stringify({ slots }) });
      applyScheduleToRows(schedule);
      setSaveMsg(t('schedule.saved'));
    } catch (err) { setSaveErr(err.message); } finally { setSaving(false); }
  }

  const business = tenant?.business;

  if (status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>;
  }

  if (status === 'forbidden') {
    return (
      <div className="min-h-screen bg-gray-50">
        <TopBar businessName={business?.name} label={t('workspace')} />
        <div className="max-w-lg mx-auto px-6 py-16 text-center">
          <h1 className="text-2xl font-bold text-gray-900">{t('staffOnly')}</h1>
          <p className="mt-2 text-sm text-gray-500">{loadError}</p>
          <Link href="/" className="mt-5 inline-block text-sm font-medium hover:underline" style={{ color: 'var(--theme-primary)' }}>
            {t('backTo', { business: business?.name || 'home' })}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: '#FAF9F7' }}>
      <PremiumHeader businessName={business?.name} userName={user?.name} userEmail={user?.email} />

      <div className="max-w-5xl mx-auto px-6 sm:px-8 py-10 space-y-8">
        <PremiumHero userName={user?.name} />

        <TabNav tabs={STAFF_TABS} active={tab} onChange={setTab} />

        {tab === 'today' && <TodayDashboard canBlockTime={!!canEditOwnSchedule} />}

        {tab === 'walkins' && (
          <PremiumSection title="Walk-ins" subtitle="Create desk appointments and record payment for arrivals, calls, or counter bookings.">
            <WalkInsPanel />
          </PremiumSection>
        )}

        {tab === 'appointments' && (
          <PremiumSection title={t('sections.allAppointments')} subtitle={t('sections.allAppointmentsSub')}>
            <AppointmentsSection schedule={Object.values(rows).some(r => r.enabled) ?
              DAYS.filter(d => rows[d.value].enabled).map(d => ({ dayOfWeek: d.value, startTime: rows[d.value].startTime, endTime: rows[d.value].endTime })) : []} user={user} />
          </PremiumSection>
        )}

        {tab === 'notifications' && (
          <PremiumSection title={t('sections.notifications')} subtitle={t('sections.notificationsSub')}>
            <NotificationInboxPanel
              title="Staff inbox"
              description="This inbox updates when customers book, cancel, or when appointments move."
              compact
            />
          </PremiumSection>
        )}

        {tab === 'time-off' && (
          <PremiumSection title={t('sections.timeOff')} subtitle={t('sections.timeOffSub')}>
            <LeaveSection />
          </PremiumSection>
        )}

        {tab === 'schedule' && (
          <PremiumSection title={t('sections.weeklyAvailability')} subtitle={t('sections.weeklyAvailabilitySub')}>
            <div className="bg-white rounded-2xl border border-gray-200 p-6">

          <div className="space-y-2">
            {DAYS.map((d) => (
              <ScheduleRow
                key={d.value}
                label={d.label}
                row={rows[d.value]}
                onChange={(patch) => setRows((prev) => ({
                  ...prev,
                  [d.value]: { ...prev[d.value], ...patch },
                }))}
              />
            ))}
          </div>

          {saveErr && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
              {saveErr}
            </p>
          )}
          {saveMsg && (
            <p className="mt-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
              {saveMsg}
            </p>
          )}

          <div className="mt-6">
            <button
              onClick={saveSchedule}
              disabled={saving}
              className="px-4 py-2 text-sm font-semibold rounded-lg inline-flex items-center gap-2 transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              {saving && <Spinner small />}
              {saving ? t('schedule.saving') : t('schedule.save')}
            </button>
          </div>
          </div>
          </PremiumSection>
        )}
      </div>
    </div>
  );
}

export default function StaffDashboard() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Spinner /></div>}>
      <StaffDashboardContent />
    </Suspense>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Tab nav — horizontal pill bar with theme-accented active state. Sticks
// below the premium hero. Keyboard-accessible + wraps on mobile.
// ────────────────────────────────────────────────────────────────────────
function TabNav({ tabs, active, onChange }) {
  const current = tabs.find((t) => t.key === active) || tabs[0];
  return (
    <div>
      <div
        className="flex items-center gap-1 p-1 rounded-2xl overflow-x-auto"
        style={{ background: '#FFFFFF', border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}
      >
        {tabs.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              className="px-4 py-2 rounded-xl text-sm font-semibold transition-colors whitespace-nowrap"
              style={isActive
                ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }
                : { color: '#374151', background: 'transparent' }}
              aria-pressed={isActive}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {current.sub && (
        <p className="text-xs text-gray-500 mt-2 pl-2">{current.sub}</p>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Premium shell components — Boulevard-inspired. Cream ambient background,
// typographic hero, card-elevated sections, restrained accent colour.
// ════════════════════════════════════════════════════════════════════════

function PremiumHeader({ businessName, userName, userEmail }) {
  const t = useTranslations('staff');
  const [menuOpen, setMenuOpen] = useState(false);
  const initials = (userName || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <header
      className="sticky top-0 z-30 backdrop-blur-md"
      style={{ background: 'rgba(250, 249, 247, 0.85)', borderBottom: '1px solid rgba(0,0,0,0.06)' }}
    >
      <div className="max-w-5xl mx-auto px-6 sm:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shadow-sm"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {(businessName || '?').charAt(0).toUpperCase()}
          </span>
          <div>
            <p className="text-[15px] font-semibold text-gray-900 leading-tight">{businessName || 'DriftHR'}</p>
            <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500 leading-tight mt-0.5">{t('workspace')}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <LanguageSelector
            currentLocale={typeof document !== 'undefined' ? (document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1] || 'en') : 'en'}
            compact
          />
          <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 pl-1 pr-3 py-1 rounded-full hover:bg-gray-100 transition-colors"
          >
            <span className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
              {initials}
            </span>
            <span className="hidden sm:block text-xs font-semibold text-gray-700">{(userName || '').split(' ')[0]}</span>
            <IconChevron />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-12 w-56 bg-white rounded-xl border border-gray-200 shadow-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="text-sm font-semibold text-gray-900 truncate">{userName}</p>
                <p className="text-xs text-gray-500 truncate">{userEmail}</p>
              </div>
              <LogoutButton />
            </div>
          )}
          </div>
        </div>
      </div>
    </header>
  );
}

function PremiumHero({ userName }) {
  const t = useTranslations('staff');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  const hour = now.getHours();
  const greet = hour < 12 ? t('hero.goodMorning') : hour < 17 ? t('hero.goodAfternoon') : t('hero.goodEvening');
  const first = (userName || 'there').split(' ')[0];
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <section>
      <p className="text-[11px] font-mono tracking-[0.25em] uppercase text-gray-500 mb-2">{dateStr} · {timeStr}</p>
      <h1 className="text-[38px] sm:text-[44px] leading-[1.05] font-bold tracking-tight text-gray-900" style={{ fontFamily: "'DM Serif Display', 'Playfair Display', ui-serif, Georgia, serif" }}>
        {greet}, <span className="italic" style={{ color: 'var(--theme-primary)' }}>{first}</span>.
      </h1>
    </section>
  );
}

function PremiumSection({ title, subtitle, children, actions }) {
  return (
    <section>
      <div className="flex items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[22px] font-bold tracking-tight text-gray-900" style={{ fontFamily: "'DM Serif Display', 'Playfair Display', ui-serif, Georgia, serif" }}>
            {title}
          </h2>
          {subtitle && <p className="text-sm text-gray-500 mt-0.5 max-w-2xl">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

// ─── Inline SVG icon set — small, crisp, consistent stroke weight ──────────
function IconChevron()   { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-gray-500"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IconBookings()  { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M8 3v4M16 3v4M3.5 10h17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>; }
function IconCheck()     { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IconNoShow()    { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5"/><path d="M8 8l8 8M16 8l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>; }
function IconRupee()     { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M7 5h10M7 9h10M17 5c-2 7-5 9-8 9l7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IconClock()     { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5"/><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>; }
function IconBlock()     { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5"/><path d="M5.5 5.5l13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>; }

// ────────────────────────────────────────────────────────────────────────
// Today dashboard — the premium "what do I need to do right now" surface.
// Pulls the staff member's appointments from /api/appointments and surfaces:
//   • today's agenda (in-order list of today's bookings)
//   • next appointment with minute-level countdown
//   • stats: bookings today, completed, no-shows, revenue so far
// ────────────────────────────────────────────────────────────────────────
function TodayDashboard({ canBlockTime = true }) {
  const t = useTranslations('staff');
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockToast, setBlockToast] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/appointments', { credentials: 'include' });
        if (r.ok) {
          const d = await r.json();
          if (!cancelled) setAppointments(d.appointments || []);
        }
      } catch { /* silent */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // Tick once per minute so the "in 45 min" countdown updates.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const todayKey = now.toISOString().slice(0, 10);
  const todays = appointments
    .filter((a) => (a.date || '').slice(0, 10) === todayKey)
    .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

  const stats = {
    total:     todays.length,
    completed: todays.filter((a) => a.status === 'COMPLETED').length,
    noShow:    todays.filter((a) => a.status === 'NO_SHOW').length,
    revenue:   todays.filter((a) => a.status === 'COMPLETED').reduce((s, a) => s + (a.finalPrice ?? a.service?.price ?? 0), 0),
  };

  // Next upcoming: first CONFIRMED/PENDING whose startTime is still ahead.
  const nowHM = now.toTimeString().slice(0, 5);
  const next = todays.find((a) => (a.status === 'PENDING' || a.status === 'CONFIRMED') && (a.startTime || '') >= nowHM);

  function minutesUntil(startTime) {
    if (!startTime) return null;
    const [h, m] = startTime.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    return Math.round((target - now) / 60000);
  }

  return (
    <div>
      {blockToast && (
        <div className="mb-4 text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-2">
          <IconCheck /> {blockToast}
        </div>
      )}

      {blockOpen && (
        <BlockTimeModal
          onClose={() => setBlockOpen(false)}
          onSaved={(msg) => {
            setBlockOpen(false);
            setBlockToast(msg);
            setTimeout(() => setBlockToast(''), 4000);
          }}
        />
      )}

      {/* Next appointment hero card — glass panel with accent ambient glow */}
      <div
        className="relative rounded-3xl p-6 sm:p-8 mb-6 overflow-hidden"
        style={{
          background: 'linear-gradient(140deg, #FFFFFF 0%, #FDFCFA 100%)',
          border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -12px rgba(0,0,0,0.08)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-16 -right-16 w-72 h-72 rounded-full opacity-[0.07] pointer-events-none"
          style={{ background: 'var(--theme-primary)' }}
        />

        <div className="relative flex items-start justify-between gap-4 mb-5">
          <div>
            <p className="text-[10px] font-mono tracking-[0.25em] uppercase text-gray-500 mb-1">{t('today.rightNow')}</p>
            <h2 className="text-[26px] font-bold tracking-tight text-gray-900" style={{ fontFamily: "'DM Serif Display', 'Playfair Display', ui-serif, Georgia, serif" }}>
              {next ? t('today.nextAppointment') : (todays.length > 0 ? t('today.allDone') : t('today.freeUntilTomorrow'))}
            </h2>
          </div>
          {canBlockTime && (
            <button
              onClick={() => setBlockOpen(true)}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-full border transition-all hover:shadow-sm"
              style={{ borderColor: 'rgba(0,0,0,0.12)', color: 'var(--theme-text, #1a1a1a)' }}
            >
              <IconBlock /> {t('today.blockTime')}
            </button>
          )}
        </div>

        {loading ? (
          <div className="py-6"><Spinner small /></div>
        ) : next ? (() => {
          const mins = minutesUntil(next.startTime);
          const whenLabel = mins <= 0 ? t('today.startingNow')
            : mins < 60 ? t('today.inMinutes', { minutes: mins })
            : t('today.atTime', { time: next.startTime });
          const customerName = next.customer?.name || next.user?.name || 'Customer';
          const initials = customerName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
          return (
            <div className="relative flex items-center gap-5">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-lg font-bold flex-shrink-0 shadow-sm"
                style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
              >
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[22px] font-semibold text-gray-900 tracking-tight truncate">{customerName}</p>
                <p className="text-sm text-gray-600 mt-0.5 truncate">{next.service?.name} · {next.startTime}–{next.endTime}</p>
                {next.notes && <p className="text-xs text-gray-500 italic mt-1 truncate">"{next.notes}"</p>}
              </div>
              <div className="hidden sm:flex flex-col items-end flex-shrink-0">
                <span className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">{t('today.starts')}</span>
                <span className="text-xl font-bold tracking-tight" style={{ color: 'var(--theme-primary)' }}>{whenLabel}</span>
              </div>
            </div>
          );
        })() : (
          <p className="text-sm text-gray-500 relative">
            {todays.length > 0 ? t('today.checkedOff') : t('today.noBookings')}
          </p>
        )}
      </div>

      {/* Stat grid with icons */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label={t('today.stat.today')}     value={stats.total}     icon={<IconBookings />} />
        <StatCard label={t('today.stat.completed')} value={stats.completed} icon={<IconCheck />}    tone="emerald" />
        <StatCard label={t('today.stat.noShows')}   value={stats.noShow}    icon={<IconNoShow />}   tone={stats.noShow > 0 ? 'rose' : 'gray'} />
        <StatCard label={t('today.stat.earned')}    value={stats.revenue > 0 ? `₹${stats.revenue.toLocaleString('en-IN')}` : '₹0'} icon={<IconRupee />} tone="indigo" />
      </div>

      {/* Today's agenda — timeline style with time spine on the left */}
      {todays.length > 0 && (
        <div
          className="rounded-2xl overflow-hidden"
          style={{ background: '#FFFFFF', border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}
        >
          <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
            <IconClock />
            <h3 className="text-sm font-semibold text-gray-900">{t('today.agenda.title')}</h3>
            <span className="ml-auto text-xs text-gray-500">{todays.length === 1 ? t('today.agenda.count', { count: todays.length }) : t('today.agenda.countPlural', { count: todays.length })}</span>
          </div>
          <ul className="divide-y" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
            {todays.map((a) => {
              const customerName = a.customer?.name || a.user?.name || 'Customer';
              const past = (a.startTime || '') < nowHM;
              const isNext = next && a.id === next.id;
              const statusPill = {
                PENDING:   { label: t('status.pending'),   cls: 'bg-amber-50 text-amber-700 border-amber-200' },
                CONFIRMED: { label: t('status.confirmed'), cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
                COMPLETED: { label: t('status.done'),      cls: 'bg-blue-50 text-blue-700 border-blue-200' },
                CANCELLED: { label: t('status.cancelled'), cls: 'bg-gray-100 text-gray-500 border-gray-200' },
                NO_SHOW:   { label: t('status.noShow'),    cls: 'bg-rose-50 text-rose-700 border-rose-200' },
              }[a.status] || { label: a.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
              return (
                <li
                  key={a.id}
                  className={`relative flex items-center gap-4 px-5 py-3 transition-colors ${past && !isNext ? 'opacity-60' : ''} ${isNext ? '' : 'hover:bg-gray-50/60'}`}
                  style={isNext ? { background: 'color-mix(in srgb, var(--theme-primary) 7%, transparent)' } : {}}
                >
                  {isNext && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-0 bottom-0 w-[3px]"
                      style={{ background: 'var(--theme-primary)' }}
                    />
                  )}
                  <div className="w-16 flex-shrink-0">
                    <span className="font-mono text-sm font-semibold text-gray-900">{a.startTime}</span>
                    <p className="text-[10px] uppercase tracking-wider text-gray-400">{a.endTime}</p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold truncate ${a.status === 'CANCELLED' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {customerName}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{a.service?.name || '—'}</p>
                  </div>
                  <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border whitespace-nowrap ${statusPill.cls}`}>
                    {statusPill.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Block time modal — quick lunch/break/errand block. Creates an instantly
// auto-approved partial-day StaffLeave. Customers can't book the staff
// member during these minutes; admin doesn't have to approve.
// ────────────────────────────────────────────────────────────────────────
function BlockTimeModal({ onClose, onSaved }) {
  const t = useTranslations('staff');
  const todayStr = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(todayStr);
  const [startTime, setStartTime] = useState('13:00');
  const [endTime, setEndTime] = useState('14:00');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (startTime >= endTime) { setError(t('blockTime.errorEndAfterStart')); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/staff/leave', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, startTime, endTime, isFullDay: false, reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || t('blockTime.errorFailed'));
      const conflicts = body.conflicts?.length || 0;
      onSaved(conflicts > 0
        ? t('blockTime.successWithConflicts', { count: conflicts })
        : t('blockTime.successNoConflicts'));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900">{t('blockTime.title')}</h3>
        <p className="text-xs text-gray-500 mt-1">{t('blockTime.hint')}</p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">{t('blockTime.date')}</label>
            <input type="date" value={date} min={todayStr}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">{t('blockTime.start')}</label>
              <input type="time" value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">{t('blockTime.end')}</label>
              <input type="time" value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">{t('blockTime.reason')}</label>
            <input type="text" value={reason} placeholder={t('blockTime.reasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm" />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="mt-5 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900">{t('blockTime.cancel')}</button>
          <button onClick={submit} disabled={saving}
            className="px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50"
            style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
            {saving ? t('blockTime.blocking') : t('blockTime.block')}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone = 'gray', icon }) {
  const tones = {
    gray:    { bg: '#FFFFFF', fg: '#111111', iconBg: '#F3F4F6', iconFg: '#6B7280' },
    emerald: { bg: '#FFFFFF', fg: '#065F46', iconBg: '#ECFDF5', iconFg: '#059669' },
    rose:    { bg: '#FFFFFF', fg: '#9F1239', iconBg: '#FFF1F2', iconFg: '#E11D48' },
    indigo:  { bg: '#FFFFFF', fg: '#3730A3', iconBg: '#EEF2FF', iconFg: '#4F46E5' },
  };
  const t = tones[tone] || tones.gray;
  return (
    <div
      className="rounded-2xl p-4 flex items-start gap-3"
      style={{ background: t.bg, border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}
    >
      {icon && (
        <span
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: t.iconBg, color: t.iconFg }}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-[0.15em] font-semibold text-gray-500">{label}</p>
        <p className="text-[22px] font-bold leading-tight mt-0.5 tracking-tight" style={{ color: t.fg }}>{value}</p>
      </div>
    </div>
  );
}

function TopBar({ businessName, label }) {
  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3">
      <div className="max-w-3xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold"
            style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
          >
            {(businessName || '?').charAt(0).toUpperCase()}
          </span>
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
              {businessName || 'DriftHR'}
            </p>
            <p className="text-xs text-gray-500">{label}</p>
          </div>
        </div>
        <LogoutButton />
      </div>
    </nav>
  );
}

function ScheduleRow({ label, row, onChange }) {
  const t = useTranslations('staff');
  return (
    <div className="flex items-center gap-4 py-2 border-b border-gray-100 last:border-b-0">
      <label className="flex items-center gap-3 w-40 cursor-pointer">
        <input
          type="checkbox"
          checked={row.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          className="w-4 h-4 rounded"
          style={{ accentColor: 'var(--theme-primary)' }}
        />
        <span className={`text-sm font-medium ${row.enabled ? 'text-gray-900' : 'text-gray-400'}`}>
          {label}
        </span>
      </label>

      {row.enabled ? (
        <div className="flex items-center gap-2 text-sm">
          <TimeInput value={row.startTime} onChange={(v) => onChange({ startTime: v })} />
          <span className="text-gray-400">{t('schedule.to')}</span>
          <TimeInput value={row.endTime} onChange={(v) => onChange({ endTime: v })} />
        </div>
      ) : (
        <span className="text-sm text-gray-400">{t('schedule.off')}</span>
      )}
    </div>
  );
}

function TimeInput({ value, onChange }) {
  return (
    <input
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-2 py-1 border border-gray-300 rounded-md focus:outline-none text-sm"
    />
  );
}

function LeaveSection() {
  const t = useTranslations('staff');
  const [leaves, setLeaves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ date: '', isFullDay: true, startTime: '09:00', endTime: '17:00', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const confirm = useConfirm();

  useEffect(() => { loadLeaves(); }, []);

  async function loadLeaves() {
    setLoading(true);
    try {
      const res = await fetch('/api/staff/leave', { credentials: 'include' });
      if (res.ok) { const data = await res.json(); setLeaves(data.leaves || []); }
    } catch {} finally { setLoading(false); }
  }

  async function submitLeave(e) {
    e.preventDefault();
    setSubmitting(true); setError('');
    try {
      const body = { date: form.date, isFullDay: form.isFullDay, reason: form.reason || undefined };
      if (!form.isFullDay) { body.startTime = form.startTime; body.endTime = form.endTime; }
      const res = await fetch('/api/staff/leave', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message || 'Failed'); }
      const data = await res.json();
      setShowForm(false);
      setForm({ date: '', isFullDay: true, startTime: '09:00', endTime: '17:00', reason: '' });
      await loadLeaves();
      if (data.autoApproved) alert(t('leave.autoApproved'));
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  async function cancelLeave(id) {
    if (!await confirm(t('leave.confirmCancel'), { confirmLabel: t('leave.confirm') || 'Cancel leave', tone: 'danger' })) return;
    try {
      await fetch(`/api/staff/leave/${id}`, { method: 'DELETE', credentials: 'include' });
      await loadLeaves();
    } catch { alert(t('leave.errorFailed')); }
  }

  const upcoming = leaves.filter(l => new Date(l.date) >= new Date(new Date().toDateString()));
  const past = leaves.filter(l => new Date(l.date) < new Date(new Date().toDateString()));

  const STATUS_BADGE = {
    PENDING: { bg: 'bg-amber-100', text: 'text-amber-700' },
    APPROVED: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
    REJECTED: { bg: 'bg-red-100', text: 'text-red-700' },
  };

  return (
    <div className="rounded-2xl border p-6 mb-6" style={{ backgroundColor: 'var(--theme-surface, #fff)', borderColor: 'var(--theme-border)' }}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>{t('leave.title')}</h2>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>{t('leave.subtitle')}</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="text-xs font-medium px-3 py-1.5 rounded-lg" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
          {showForm ? t('leave.cancelForm') : t('leave.requestButton')}
        </button>
      </div>

      {/* Request form */}
      {showForm && (
        <form onSubmit={submitLeave} className="mb-5 p-4 rounded-xl border space-y-3" style={{ borderColor: 'var(--theme-border)', backgroundColor: 'var(--theme-bg)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-text)' }}>{t('leave.date')}</label>
              <input type="date" required min={new Date().toISOString().slice(0, 10)} value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none" style={{ borderColor: 'var(--theme-border)' }} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-text)' }}>{t('leave.type')}</label>
              <select value={form.isFullDay ? 'full' : 'partial'} onChange={(e) => setForm({ ...form, isFullDay: e.target.value === 'full' })}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none" style={{ borderColor: 'var(--theme-border)' }}>
                <option value="full">{t('leave.fullDay')}</option>
                <option value="partial">{t('leave.partialDay')}</option>
              </select>
            </div>
          </div>
          {!form.isFullDay && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-text)' }}>{t('leave.from')}</label>
                <input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-text)' }}>{t('leave.to')}</label>
                <input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
              </div>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-text)' }}>{t('leave.reason')}</label>
            <input type="text" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder={t('leave.reasonPlaceholder')}
              className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button type="submit" disabled={submitting} className="px-4 py-2 text-xs font-semibold rounded-lg disabled:opacity-50"
            style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
            {submitting ? t('leave.submitting') : t('leave.submit')}
          </button>
        </form>
      )}

      {loading ? (
        <div className="py-6 flex justify-center"><Spinner /></div>
      ) : upcoming.length === 0 && past.length === 0 ? (
        <div className="border border-dashed rounded-xl py-8 text-center text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
          {t('leave.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {upcoming.map(l => {
            const badge = STATUS_BADGE[l.status] || STATUS_BADGE.PENDING;
            return (
              <div key={l.id} className="flex items-center justify-between py-2.5 px-3 rounded-lg border" style={{ borderColor: 'var(--theme-border)' }}>
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                    {new Date(l.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    {!l.isFullDay && <span className="text-xs ml-2" style={{ color: 'var(--theme-muted)' }}>{l.startTime}–{l.endTime}</span>}
                  </p>
                  {l.reason && <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>{l.reason}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.bg} ${badge.text}`}>
                    {l.status === 'PENDING' ? t('leave.statusPending') : l.status === 'APPROVED' ? t('leave.statusApproved') : t('leave.statusRejected')}
                  </span>
                  {l.status === 'PENDING' && (
                    <button onClick={() => cancelLeave(l.id)} className="text-[10px] text-red-600 hover:underline">{t('leave.cancelAction')}</button>
                  )}
                </div>
              </div>
            );
          })}
          {past.length > 0 && (
            <p className="text-xs pt-2" style={{ color: 'var(--theme-muted)' }}>{t('leave.pastRequests', { count: past.length })}</p>
          )}
        </div>
      )}
    </div>
  );
}

function AppointmentsSection({ schedule, user }) {
  const t = useTranslations('staff');
  const permissions = user?.businessRole?.permissions || {};
  const canManageAllAppointments = !!permissions.canManageAllAppointments;
  const canManageOwnAppointments = !!permissions.canManageOwnAppointments || (!user?.businessRoleId && user?.role === 'STAFF');
  const canCancelAny = !!permissions.canCancelAppointments || canManageAllAppointments;
  const [view, setView] = useState('calendar'); // 'calendar' | 'list'
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAppt, setSelectedAppt] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState({ date: '', startTime: '', endTime: '' });
  const [rescheduleSaving, setRescheduleSaving] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/appointments', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setAppointments(data.appointments || []);
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    }
    load();
  }, []);

  async function updateStatus(id, status) {
    try {
      const res = await fetch(`/api/appointments/${id}/status`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || 'Failed');
      setAppointments(prev => prev.map(a => a.id === id ? { ...a, status } : a));
      setSelectedAppt(null);
    } catch (err) { alert(err.message || t('appointments.errorFailed')); }
  }

  async function rescheduleSelected() {
    if (!selectedAppt) return;
    setRescheduleSaving(true);
    try {
      const res = await fetch(`/api/appointments/${selectedAppt.id}/reschedule`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rescheduleForm),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || 'Failed');
      setAppointments((prev) => prev.map((item) => (item.id === selectedAppt.id ? { ...item, ...body.appointment } : item)));
      setSelectedAppt(null);
    } catch (err) {
      alert(err.message || t('appointments.errorFailed'));
    } finally {
      setRescheduleSaving(false);
    }
  }

  const canManageSelected = selectedAppt && (
    canManageAllAppointments ||
    (canManageOwnAppointments && selectedAppt.staff?.id === user?.id)
  );
  const canCancelSelected = selectedAppt && (
    canManageSelected ||
    (canCancelAny && (canManageAllAppointments || selectedAppt.staff?.id === user?.id))
  );

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>{t('appointments.title')}</h2>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
            {t('appointments.activeCount', { count: appointments.filter(a => a.status !== 'CANCELLED').length })}
          </p>
        </div>
        <div className="flex p-1 rounded-lg" style={{ backgroundColor: 'var(--theme-bg)' }}>
          <button onClick={() => setView('calendar')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${view === 'calendar' ? 'bg-white shadow-sm' : ''}`}
            style={view === 'calendar' ? { color: 'var(--theme-primary)' } : { color: 'var(--theme-muted)' }}>
            <span className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
              {t('appointments.viewCalendar')}
            </span>
          </button>
          <button onClick={() => setView('list')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${view === 'list' ? 'bg-white shadow-sm' : ''}`}
            style={view === 'list' ? { color: 'var(--theme-primary)' } : { color: 'var(--theme-muted)' }}>
            <span className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
              {t('appointments.viewList')}
            </span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : view === 'calendar' ? (
        <WeekCalendar
          appointments={appointments}
          schedule={schedule}
          onAppointmentClick={(appt) => {
            setSelectedAppt(appt);
            setRescheduleForm({
              date: new Date(appt.date).toISOString().slice(0, 10),
              startTime: appt.startTime || '',
              endTime: appt.endTime || '',
            });
          }}
        />
      ) : (
        <div className="rounded-xl border p-4" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
          <AppointmentsPanel role="STAFF" me={user} />
        </div>
      )}

      {/* Appointment detail modal */}
      {selectedAppt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setSelectedAppt(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold" style={{ fontFamily: 'var(--font-heading)', color: 'var(--theme-text)' }}>
              {selectedAppt.service?.name}
            </h3>
            <div className="mt-3 space-y-2 text-sm" style={{ color: 'var(--theme-muted)' }}>
              <p><strong style={{ color: 'var(--theme-text)' }}>{t('appointments.customer')}</strong> {selectedAppt.customer?.name || selectedAppt.user?.name || 'Unknown'}</p>
              <p><strong style={{ color: 'var(--theme-text)' }}>{t('appointments.date')}</strong> {new Date(selectedAppt.date).toISOString().slice(0, 10)}</p>
              <p><strong style={{ color: 'var(--theme-text)' }}>{t('appointments.time')}</strong> {selectedAppt.startTime} — {selectedAppt.endTime}</p>
              <p><strong style={{ color: 'var(--theme-text)' }}>{t('appointments.status')}</strong> {selectedAppt.status}</p>
              {selectedAppt.notes && <p><strong style={{ color: 'var(--theme-text)' }}>{t('appointments.notes')}</strong> {selectedAppt.notes}</p>}
            </div>
            <div className="mt-5 flex gap-2">
              {canManageSelected && selectedAppt.status === 'PENDING' && (
                <button onClick={() => updateStatus(selectedAppt.id, 'CONFIRMED')}
                  className="px-4 py-2 text-xs font-semibold rounded-lg" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                  {t('appointments.confirm')}
                </button>
              )}
              {canManageSelected && selectedAppt.status === 'CONFIRMED' && (
                <button onClick={() => updateStatus(selectedAppt.id, 'COMPLETED')}
                  className="px-4 py-2 text-xs font-semibold rounded-lg" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                  {t('appointments.complete')}
                </button>
              )}
              {canManageSelected && (selectedAppt.status === 'PENDING' || selectedAppt.status === 'CONFIRMED') && (
                <button onClick={rescheduleSelected}
                  disabled={rescheduleSaving}
                  className="px-4 py-2 text-xs font-semibold rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                  {rescheduleSaving ? t('appointments.saving') : t('appointments.reschedule')}
                </button>
              )}
              {canCancelSelected && (selectedAppt.status === 'PENDING' || selectedAppt.status === 'CONFIRMED') && (
                <button onClick={() => updateStatus(selectedAppt.id, 'CANCELLED')}
                  className="px-4 py-2 text-xs font-semibold rounded-lg text-red-600 border border-red-300 hover:bg-red-50">
                  {t('appointments.cancel')}
                </button>
              )}
              <button onClick={() => setSelectedAppt(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg" style={{ color: 'var(--theme-muted)' }}>
                {t('appointments.close')}
              </button>
            </div>
            {canManageSelected && (selectedAppt.status === 'PENDING' || selectedAppt.status === 'CONFIRMED') && (
              <div className="mt-4 grid grid-cols-3 gap-2">
                <input
                  type="date"
                  value={rescheduleForm.date}
                  onChange={(e) => setRescheduleForm((prev) => ({ ...prev, date: e.target.value }))}
                  className="px-3 py-2 rounded-lg border text-xs"
                />
                <input
                  type="time"
                  value={rescheduleForm.startTime}
                  onChange={(e) => setRescheduleForm((prev) => ({ ...prev, startTime: e.target.value }))}
                  className="px-3 py-2 rounded-lg border text-xs"
                />
                <input
                  type="time"
                  value={rescheduleForm.endTime}
                  onChange={(e) => setRescheduleForm((prev) => ({ ...prev, endTime: e.target.value }))}
                  className="px-3 py-2 rounded-lg border text-xs"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner({ small }) {
  const size = small ? 'h-4 w-4' : 'h-8 w-8';
  return (
    <svg
      className={`animate-spin ${size}`}
      style={{ color: 'var(--theme-primary, #4f46e5)' }}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

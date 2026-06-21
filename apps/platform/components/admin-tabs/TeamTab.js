'use client';

// Team / staff schedules + booking rules. APPOINTMENT vertical owns
// scheduling. STATIC tenants only see "Members" — booking-engine sub-tabs
// (Schedule, Time off, Booking rules) are filtered out per `vertical`.
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, Empty, Modal, ModalActions, PrimaryButton, TextInput, TimeInput } from '@/components/admin-ui';
import StaffTab from './StaffTab';
import LeaveRequestsTab from './LeaveRequestsTab';

const ALL_TEAM_SUB_TABS = [
  { key: 'members',  label: 'Members',       sub: 'Invite staff, update names, roles, and permissions' },
  { key: 'schedule', label: 'Schedule',      sub: 'Weekly schedule per provider incl. lunch breaks',  appointmentOnly: true },
  { key: 'timeoff',  label: 'Time off',      sub: 'Approve staff leave',                              appointmentOnly: true },
  { key: 'rules',    label: 'Booking rules', sub: 'How customers can book with you',                  appointmentOnly: true },
];

function TeamTab({ business, refreshTenant, onStaffChange, vertical, staffLabels }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const TEAM_SUB_TABS = ALL_TEAM_SUB_TABS.filter((t) => !t.appointmentOnly || vertical === 'APPOINTMENT');
  const requestedSection = searchParams.get('section') || 'members';
  const subTab = TEAM_SUB_TABS.some((t) => t.key === requestedSection) ? requestedSection : 'members';
  const setSubTab = useCallback((nextSubTab) => {
    const safeSubTab = TEAM_SUB_TABS.some((t) => t.key === nextSubTab) ? nextSubTab : 'members';
    const params = new URLSearchParams(searchParams.toString());
    if (safeSubTab === 'members') params.delete('section');
    else params.set('section', safeSubTab);
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [TEAM_SUB_TABS, router, searchParams]);
  const activeSub = TEAM_SUB_TABS.find((t) => t.key === subTab) || TEAM_SUB_TABS[0];

  return (
    <div className="space-y-4">
      <div>
        <div
          className="flex items-center gap-1 p-1 rounded-2xl w-fit"
          style={{ background: '#FFFFFF', border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}
        >
          {TEAM_SUB_TABS.map((t) => {
            const isActive = t.key === subTab;
            return (
              <button
                key={t.key}
                onClick={() => setSubTab(t.key)}
                className="px-4 py-2 rounded-xl text-sm font-semibold transition-colors whitespace-nowrap"
                style={isActive
                  ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }
                  : { color: '#374151', background: 'transparent' }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-2 pl-2">{activeSub.sub}</p>
      </div>

      {subTab === 'members'  && <StaffTab onChange={onStaffChange} labels={staffLabels} />}
      {subTab === 'schedule' && <TeamScheduleSubTab />}
      {subTab === 'timeoff'  && <LeaveRequestsTab />}
      {subTab === 'rules'    && <BookingRulesSubTab business={business} refreshTenant={refreshTenant} />}
    </div>
  );
}

// ─── Team sub-tab ──────────────────────────────────────────────────────────
// Shows every service provider (admin + staff with isServiceProvider=true)
// and their weekly schedule. Click any provider card to expand the editor.
// Lunch break is a per-day optional pair.
const WEEK_DAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

function TeamScheduleSubTab() {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  async function load() {
    setLoading(true); setError('');
    try {
      const data = await api('/api/schedule/team');
      setProviders(data.providers || []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  if (loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
  if (error) return <ErrorBanner message={error} />;

  return (
    <div className="space-y-3">
      {providers.length === 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 text-sm text-gray-500 text-center">
          No service providers yet. Invite staff from the Staff tab, or mark yourself as a service provider in your profile.
        </div>
      )}
      {providers.map((p) => (
        <ProviderScheduleCard
          key={p.id}
          provider={p}
          expanded={expandedId === p.id}
          onExpand={() => setExpandedId(expandedId === p.id ? null : p.id)}
          onSaved={load}
        />
      ))}
    </div>
  );
}

function ProviderScheduleCard({ provider, expanded, onExpand, onSaved }) {
  const schedules = Array.isArray(provider?.staffSchedules) ? provider.staffSchedules : [];
  const providerName = typeof provider?.name === 'string' && provider.name.trim() ? provider.name : 'Provider';
  const [rows, setRows] = useState(() =>
    WEEK_DAYS.reduce((acc, d) => {
      const match = schedules.find((s) => s.dayOfWeek === d.value);
      acc[d.value] = match
        ? { enabled: true, startTime: match.startTime, endTime: match.endTime, lunchStart: match.lunchStart || '', lunchEnd: match.lunchEnd || '' }
        : { enabled: false, startTime: '09:00', endTime: '17:00', lunchStart: '', lunchEnd: '' };
      return acc;
    }, {})
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // Summary row (collapsed state) — days the provider works.
  const workingDays = WEEK_DAYS.filter((d) => rows[d.value].enabled);
  const summary = workingDays.length === 0
    ? 'No working days set'
    : workingDays.map((d) => d.label.slice(0, 3)).join(' · ');

  async function save() {
    setSaving(true); setError(''); setSaved(false);
    const slots = WEEK_DAYS
      .filter((d) => rows[d.value].enabled)
      .map((d) => {
        const r = rows[d.value];
        const slot = { dayOfWeek: d.value, startTime: r.startTime, endTime: r.endTime };
        if (r.lunchStart && r.lunchEnd) {
          slot.lunchStart = r.lunchStart;
          slot.lunchEnd = r.lunchEnd;
        }
        return slot;
      });
    try {
      await api(`/api/schedule/staff/${provider.id}`, { method: 'PUT', body: JSON.stringify({ slots }) });
      setSaved(true);
      onSaved?.();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  const initials = providerName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <button
        onClick={onExpand}
        className="w-full flex items-center gap-4 px-5 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <span
          className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
          style={{ background: 'var(--theme-primary)' }}
        >
          {initials}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
          <p className="font-semibold text-gray-900 truncate">{providerName}</p>
            <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
              {provider.role === 'BUSINESS_ADMIN' ? 'Owner' : 'Staff'}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{summary}</p>
        </div>
        <span className="text-xs text-gray-400">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 pt-1 border-t border-gray-100">
          <div className="space-y-2 mt-3">
            {WEEK_DAYS.map((d) => (
              <DayRow
                key={d.value}
                label={d.label}
                row={rows[d.value]}
                onChange={(patch) => setRows((prev) => ({ ...prev, [d.value]: { ...prev[d.value], ...patch } }))}
              />
            ))}
          </div>
          {error && <div className="mt-4"><ErrorBanner message={error} /></div>}
          {saved && (
            <p className="mt-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
              Schedule saved
            </p>
          )}
          <div className="mt-5 flex justify-end">
            <PrimaryButton onClick={save} loading={saving}>Save {providerName.split(' ')[0]}'s schedule</PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

function DayRow({ label, row, onChange }) {
  const hasLunch = !!(row.lunchStart && row.lunchEnd);
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-2 border-b border-gray-100 last:border-0">
      <label className="flex items-center gap-3 w-36 cursor-pointer flex-shrink-0">
        <input
          type="checkbox"
          checked={row.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          className="w-4 h-4 rounded"
          style={{ accentColor: 'var(--theme-primary)' }}
        />
        <span className={`text-sm font-medium ${row.enabled ? 'text-gray-900' : 'text-gray-400'}`}>{label}</span>
      </label>
      {row.enabled ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <TimeInput value={row.startTime} onChange={(v) => onChange({ startTime: v })} />
          <span className="text-gray-500">to</span>
          <TimeInput value={row.endTime} onChange={(v) => onChange({ endTime: v })} />
          <label className="flex items-center gap-1.5 ml-2 cursor-pointer">
            <input
              type="checkbox"
              checked={hasLunch}
              onChange={(e) => onChange(e.target.checked
                ? { lunchStart: '13:00', lunchEnd: '14:00' }
                : { lunchStart: '', lunchEnd: '' })}
              className="w-3.5 h-3.5 rounded"
              style={{ accentColor: 'var(--theme-primary)' }}
            />
            <span className="text-xs text-gray-600">Lunch</span>
          </label>
          {hasLunch && (
            <div className="flex items-center gap-1.5 text-xs">
              <TimeInput value={row.lunchStart} onChange={(v) => onChange({ lunchStart: v })} />
              <span className="text-gray-400">–</span>
              <TimeInput value={row.lunchEnd} onChange={(v) => onChange({ lunchEnd: v })} />
            </div>
          )}
        </div>
      ) : (
        <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-500">Off</span>
      )}
    </div>
  );
}

// ─── Booking rules sub-tab ─────────────────────────────────────────────────
// Currently: booking type (PREPAID / POSTPAID). More knobs land here later
// (advance booking window, buffer between bookings, min notice, etc.).
function BookingRulesSubTab({ business, refreshTenant }) {
  const [bookingType, setBookingType] = useState(business?.bookingType || 'POSTPAID');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setBookingType(business?.bookingType || 'POSTPAID'); }, [business?.bookingType]);

  async function save() {
    setSaving(true); setSaved(false); setError('');
    try {
      await api('/api/business/setup', {
        method: 'POST',
        body: JSON.stringify({
          name: business.name,
          slug: business.slug,
          bookingType,
        }),
      });
      setSaved(true);
      refreshTenant?.();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-gray-900">Booking payment model</h2>
      <p className="text-sm text-gray-500 mt-1 mb-5">
        Controls whether customers pay when they book, or after the service. Applies to every booking.
      </p>

      <div className="space-y-3">
        <RulePickCard
          checked={bookingType === 'POSTPAID'}
          title="Postpaid"
          detail="Customers book free and pay at the salon/clinic. Default for most businesses. Works great for returning clients."
          onSelect={() => setBookingType('POSTPAID')}
        />
        <RulePickCard
          checked={bookingType === 'PREPAID'}
          title="Prepaid"
          detail="Customers pay online when they book. Cuts no-shows. Recommended for premium services or new customer bases."
          onSelect={() => setBookingType('PREPAID')}
        />
      </div>

      {error && <div className="mt-4"><ErrorBanner message={error} /></div>}
      {saved && (
        <p className="mt-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
          Booking rules saved
        </p>
      )}

      <div className="mt-5">
        <PrimaryButton onClick={save} loading={saving} disabled={bookingType === business?.bookingType}>
          Save booking rules
        </PrimaryButton>
      </div>
    </div>
  );
}

function RulePickCard({ checked, title, detail, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left rounded-xl border px-4 py-3 transition-all"
      style={checked
        ? { borderColor: 'var(--theme-primary)', background: 'color-mix(in srgb, var(--theme-primary) 5%, transparent)', boxShadow: '0 0 0 1px var(--theme-primary)' }
        : { borderColor: 'rgba(0,0,0,0.1)', background: '#FFF' }}
    >
      <div className="flex items-start gap-3">
        <span
          className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ border: `2px solid ${checked ? 'var(--theme-primary)' : 'rgba(0,0,0,0.2)'}` }}
        >
          {checked && <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--theme-primary)' }} />}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-gray-900">{title}</p>
          <p className="text-xs text-gray-500 mt-1">{detail}</p>
        </div>
      </div>
    </button>
  );
}


export default TeamTab;

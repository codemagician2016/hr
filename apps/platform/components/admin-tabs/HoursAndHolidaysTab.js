'use client';

// Business hours + holidays editor. Sub-tab inside SettingsTab; also
// directly mountable via ?show=hours or ?show=holidays.
//
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useEffect, useState } from 'react';
import { useConfirm } from '@/components/ConfirmDialog';
import { DateInput, TimeInput } from '@/components/admin-ui';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton } from '@/components/admin-ui';

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function HoursAndHolidaysTab({ show }) {
  // Sub-tab: 'hours' (weekly opening hours) or 'holidays' (date overrides).
  const [subTab, setSubTab] = useState(show || 'hours');
  const confirm = useConfirm();

  // --- Business Hours ---
  const [hours, setHours] = useState(
    Array.from({ length: 7 }, (_, i) => ({
      dayOfWeek: i,
      openTime: '09:00',
      closeTime: '17:00',
      isClosed: i === 0 || i === 6,
    }))
  );
  const [hoursLoading, setHoursLoading] = useState(true);
  const [hoursSaving, setHoursSaving] = useState(false);
  const [hoursSaved, setHoursSaved] = useState(false);
  const [hoursError, setHoursError] = useState('');

  // --- Holidays ---
  const [holidays, setHolidays] = useState([]);
  const [holLoading, setHolLoading] = useState(true);
  const [newHolDate, setNewHolDate] = useState('');
  const [newHolName, setNewHolName] = useState('');
  const [holAdding, setHolAdding] = useState(false);
  const [holError, setHolError] = useState('');

  useEffect(() => {
    loadHours();
    loadHolidays();
  }, []);

  async function loadHours() {
    setHoursLoading(true);
    try {
      const data = await api('/api/business/hours');
      if (data.hours) setHours(data.hours);
    } catch {} finally { setHoursLoading(false); }
  }

  async function saveHours() {
    setHoursSaving(true); setHoursError(''); setHoursSaved(false);
    try {
      const data = await api('/api/business/hours', {
        method: 'PUT',
        body: JSON.stringify({ hours }),
      });
      if (data.hours) setHours(data.hours);
      setHoursSaved(true);
    } catch (err) { setHoursError(err.message); }
    finally { setHoursSaving(false); }
  }

  async function loadHolidays() {
    setHolLoading(true);
    try {
      const data = await api('/api/business/holidays');
      setHolidays(data.holidays || []);
    } catch {} finally { setHolLoading(false); }
  }

  async function addHoliday(e) {
    e.preventDefault();
    if (!newHolDate || !newHolName.trim()) return;
    setHolAdding(true); setHolError('');
    try {
      await api('/api/business/holidays', {
        method: 'POST',
        body: JSON.stringify({ date: newHolDate, name: newHolName.trim() }),
      });
      setNewHolDate(''); setNewHolName('');
      await loadHolidays();
    } catch (err) { setHolError(err.message); }
    finally { setHolAdding(false); }
  }

  async function removeHoliday(id) {
    if (!await confirm('Remove this holiday?', { confirmLabel: 'Remove', tone: 'danger' })) return;
    try {
      await api(`/api/business/holidays/${id}`, { method: 'DELETE' });
      await loadHolidays();
    } catch (err) { alert(err.message); }
  }

  function updateHour(dayOfWeek, field, value) {
    setHoursSaved(false);
    setHours(prev => prev.map(h => h.dayOfWeek === dayOfWeek ? { ...h, [field]: value } : h));
  }

  // Sort hours: Mon(1)..Sat(6), Sun(0) last
  const sortedHours = [...hours].sort((a, b) => {
    const order = [1, 2, 3, 4, 5, 6, 0];
    return order.indexOf(a.dayOfWeek) - order.indexOf(b.dayOfWeek);
  });

  const SUB_TABS = [
    { key: 'hours',    label: 'Opening hours', sub: 'Your weekly schedule' },
    { key: 'holidays', label: 'Holidays',      sub: 'One-off closed dates' },
  ];
  const activeSub = SUB_TABS.find((t) => t.key === subTab) || SUB_TABS[0];

  return (
    <div className="space-y-6">
      {/* Legacy inner pill bar — only shown when no `show` prop is passed. */}
      {!show && (
        <>
          <div
            className="flex items-center gap-1 p-1 rounded-2xl w-fit"
            style={{ background: '#FFFFFF', border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}
          >
            {SUB_TABS.map((t) => {
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
          <p className="text-xs text-gray-500 -mt-4 pl-2">{activeSub.sub}</p>
        </>
      )}

      {/* Business Hours */}
      {subTab === 'hours' && (
      <div className="rounded-2xl border p-6" style={{ backgroundColor: 'var(--theme-surface, #fff)', borderColor: 'var(--theme-border)' }}>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>Business Hours</h2>
        <p className="text-sm mt-1 mb-5" style={{ color: 'var(--theme-muted)' }}>
          Set your operating hours. Customers can only book during these times.
        </p>

        {hoursLoading ? (
          <div className="py-6 flex justify-center"><Spinner /></div>
        ) : (
          <div className="space-y-2">
            {sortedHours.map((h) => (
              <div key={h.dayOfWeek} className="flex items-center gap-4 py-2.5 border-b" style={{ borderColor: 'var(--theme-border)' }}>
                <label className="flex items-center gap-3 w-36 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!h.isClosed}
                    onChange={(e) => updateHour(h.dayOfWeek, 'isClosed', !e.target.checked)}
                    className="w-4 h-4 rounded"
                    style={{ accentColor: 'var(--theme-primary)' }}
                  />
                  <span className={`text-sm font-medium ${h.isClosed ? '' : ''}`}
                    style={{ color: h.isClosed ? 'var(--theme-muted)' : 'var(--theme-text)' }}>
                    {DAY_LABELS[h.dayOfWeek]}
                  </span>
                </label>

                {h.isClosed ? (
                  <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: 'color-mix(in srgb, var(--theme-muted) 15%, transparent)', color: 'var(--theme-muted)' }}>
                    Closed
                  </span>
                ) : (
                  <div className="flex items-center gap-2 text-sm">
                    <TimeInput value={h.openTime} onChange={(v) => updateHour(h.dayOfWeek, 'openTime', v)} />
                    <span style={{ color: 'var(--theme-muted)' }}>to</span>
                    <TimeInput value={h.closeTime} onChange={(v) => updateHour(h.dayOfWeek, 'closeTime', v)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {hoursError && <div className="mt-3"><ErrorBanner message={hoursError} /></div>}
        {hoursSaved && <p className="mt-3 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">Hours saved</p>}

        <div className="mt-5">
          <PrimaryButton onClick={saveHours} loading={hoursSaving}>Save hours</PrimaryButton>
        </div>
      </div>
      )}

      {/* Holidays */}
      {subTab === 'holidays' && (
      <div className="rounded-2xl border p-6" style={{ backgroundColor: 'var(--theme-surface, #fff)', borderColor: 'var(--theme-border)' }}>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>Annual Holidays</h2>
        <p className="text-sm mt-1 mb-5" style={{ color: 'var(--theme-muted)' }}>
          Mark dates when your business is closed. No bookings will be available on these days.
        </p>

        {/* Add holiday form */}
        <form onSubmit={addHoliday} className="flex flex-col sm:flex-row gap-2 mb-5">
          <DateInput
            value={newHolDate}
            onChange={setNewHolDate}
            min={new Date().toISOString().slice(0, 10)}
            required
          />
          <input type="text" value={newHolName} onChange={(e) => setNewHolName(e.target.value)}
            placeholder="Holiday name (e.g. Christmas Day)"
            maxLength={100}
            className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none" style={{ borderColor: 'var(--theme-border)' }}
            required />
          <PrimaryButton type="submit" loading={holAdding}>Add</PrimaryButton>
        </form>

        {holError && <div className="mb-3"><ErrorBanner message={holError} /></div>}

        {holLoading ? (
          <div className="py-6 flex justify-center"><Spinner /></div>
        ) : holidays.length === 0 ? (
          <div className="border border-dashed rounded-xl py-8 text-center text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
            No holidays set. Your business is open every scheduled day.
          </div>
        ) : (
          <div className="space-y-2">
            {holidays.map((h) => {
              const dateStr = new Date(h.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
              const isPast = new Date(h.date) < new Date(new Date().toDateString());
              return (
                <div key={h.id} className="flex items-center justify-between py-2.5 px-3 rounded-lg border"
                  style={{ borderColor: 'var(--theme-border)', opacity: isPast ? 0.5 : 1 }}>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' }}>
                      <svg className="w-4 h-4" style={{ color: 'var(--theme-primary)' }} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{h.name}</p>
                      <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>{dateStr}</p>
                    </div>
                  </div>
                  <button onClick={() => removeHoliday(h.id)}
                    className="text-xs text-red-600 hover:underline">
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
    </div>
  );
}


export default HoursAndHolidaysTab;

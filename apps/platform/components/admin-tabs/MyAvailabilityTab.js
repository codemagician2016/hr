'use client';

// Staff "My availability" tab — own schedule + leave requests.
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useEffect, useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton, TimeInput } from '@/components/admin-ui';

const SCHED_DAYS = [
  { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' }, { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' }, { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

function MyAvailabilityTab() {
  const [rows, setRows] = useState(() =>
    SCHED_DAYS.reduce((acc, d) => {
      acc[d.value] = { enabled: false, startTime: '09:00', endTime: '17:00' };
      return acc;
    }, {})
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const data = await api('/api/schedule');
        const schedule = data.schedule || [];
        setRows(prev => {
          const next = { ...prev };
          for (const d of SCHED_DAYS) next[d.value] = { ...next[d.value], enabled: false };
          for (const s of schedule) {
            next[s.dayOfWeek] = { enabled: true, startTime: s.startTime, endTime: s.endTime };
          }
          return next;
        });
      } catch {} finally { setLoading(false); }
    }
    load();
  }, []);

  async function save() {
    setSaving(true); setError(''); setSaved(false);
    const slots = SCHED_DAYS
      .filter(d => rows[d.value].enabled)
      .map(d => ({ dayOfWeek: d.value, startTime: rows[d.value].startTime, endTime: rows[d.value].endTime }));
    try {
      await api('/api/schedule', { method: 'POST', body: JSON.stringify({ slots }) });
      setSaved(true);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border p-6" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>My availability</h2>
        <p className="text-sm mt-1 mb-5" style={{ color: 'var(--theme-muted)' }}>
          Set your personal working hours. If you have no staff, you'll appear as the bookable service provider for customers.
          If you do have staff, you'll appear alongside them.
        </p>

        {loading ? (
          <div className="py-6 flex justify-center"><Spinner /></div>
        ) : (
          <>
            <div className="space-y-2">
              {SCHED_DAYS.map(d => (
                <div key={d.value} className="flex items-center gap-4 py-2.5 border-b" style={{ borderColor: 'var(--theme-border)' }}>
                  <label className="flex items-center gap-3 w-36 cursor-pointer">
                    <input type="checkbox" checked={rows[d.value].enabled}
                      onChange={e => { setRows(prev => ({ ...prev, [d.value]: { ...prev[d.value], enabled: e.target.checked } })); setSaved(false); }}
                      className="w-4 h-4 rounded" style={{ accentColor: 'var(--theme-primary)' }} />
                    <span className="text-sm font-medium" style={{ color: rows[d.value].enabled ? 'var(--theme-text)' : 'var(--theme-muted)' }}>
                      {d.label}
                    </span>
                  </label>
                  {rows[d.value].enabled ? (
                    <div className="flex items-center gap-2 text-sm">
                      <TimeInput value={rows[d.value].startTime}
                        onChange={(v) => { setRows(prev => ({ ...prev, [d.value]: { ...prev[d.value], startTime: v } })); setSaved(false); }} />
                      <span style={{ color: 'var(--theme-muted)' }}>to</span>
                      <TimeInput value={rows[d.value].endTime}
                        onChange={(v) => { setRows(prev => ({ ...prev, [d.value]: { ...prev[d.value], endTime: v } })); setSaved(false); }} />
                    </div>
                  ) : (
                    <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: 'color-mix(in srgb, var(--theme-muted) 15%, transparent)', color: 'var(--theme-muted)' }}>
                      Off
                    </span>
                  )}
                </div>
              ))}
            </div>

            {error && <div className="mt-3"><ErrorBanner message={error} /></div>}
            {saved && <p className="mt-3 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
              Availability saved. You're now bookable by customers.
            </p>}

            <div className="mt-5">
              <PrimaryButton onClick={save} loading={saving}>Save my availability</PrimaryButton>
            </div>
          </>
        )}
      </div>

      <div className="rounded-2xl border p-5" style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary) 8%, transparent)', borderColor: 'var(--theme-border)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>How it works</h3>
        <ul className="mt-2 space-y-1.5 text-xs" style={{ color: 'var(--theme-muted)' }}>
          <li>• Once you set your availability, you'll appear as a bookable provider on your website</li>
          <li>• Customers will see you in the "Select a staff member" step during booking</li>
          <li>• Your name from your account profile will be shown to customers</li>
          <li>• If you also have staff members, they'll appear alongside you</li>
          <li>• To stop appearing as bookable, uncheck all days and save</li>
        </ul>
      </div>
    </div>
  );
}

export default MyAvailabilityTab;

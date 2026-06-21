'use client';

// Doctor v2 — appointment reminders config. Enable/disable the automatic
// 24h + 2h reminders per business (Business.appointmentReminderConfig).

import { useState, useEffect } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, PrimaryButton } from '@/components/admin-ui';

export default function RemindersTab() {
  const [enabled, setEnabled] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api('/api/business/reminder-config')
      .then(({ config }) => setEnabled(config?.enabled !== false))
      .catch(() => setEnabled(true));
  }, []);

  async function save() {
    setBusy(true);
    try {
      await api('/api/business/reminder-config', { method: 'PUT', body: JSON.stringify({ enabled }) });
      setSaved(true);
    } finally { setBusy(false); }
  }

  if (enabled === null) return <Spinner />;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Appointment reminders</h2>
        <p className="text-sm text-gray-500">
          Automatic reminders go out about 24 hours and 2 hours before each appointment, via WhatsApp / SMS / email
          (whichever channels you have set up). They reduce no-shows.
        </p>
      </div>

      <label className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }}
          className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
        <span className="text-sm font-medium text-gray-900">Send automatic appointment reminders</span>
      </label>

      <div className="flex items-center gap-3">
        <PrimaryButton onClick={save} loading={busy}>Save</PrimaryButton>
        {saved && <span className="text-sm text-emerald-600">Saved ✓</span>}
      </div>
    </div>
  );
}

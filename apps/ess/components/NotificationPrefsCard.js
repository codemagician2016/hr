'use client';

// Notification preferences (Program P1.6) — the ONE unified write surface for
// the employee's notifyPrefs. Customer session, self-only:
//   GET   /api/hr/me/engagement/notification-prefs → { announcementsOptOut, celebrationsOptOut }
//   PATCH /api/hr/me/engagement/notification-prefs { announcementsOptOut? | celebrationsOptOut? }
//
// IMPORTANT inversion: the toggles show the POSITIVE state (on = receiving /
// included) while the API stores opt-OUT booleans — checked = !optOut, and a
// toggle PATCHes { field: !checked }. Each toggle saves on change (single
// field), optimistically, reverting on error, with a small "Saved" indicator.
//
// This card REPLACES the feed page's old celebrations-only opt-out bar (which
// wrote /api/hr/me/engagement/celebrations/preferences) — it is rendered on
// both the Profile page (Notifications section) and the feed, so the control
// lives in one component and writes through the unified endpoint.

import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@hr/ui';
import InfoTip from '@/components/InfoTip';
import { apiGet, apiPatch } from '@/lib/api';

const PREFS_PATH = '/api/hr/me/engagement/notification-prefs';

function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
      style={{ background: checked ? 'var(--theme-primary)' : 'var(--theme-border)' }}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );
}

function PrefRow({ title, description, tip, checked, busy, saved, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
          {title}
          {tip && <InfoTip text={tip} />}
        </div>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--theme-muted)' }}>{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {saved && <span className="text-[11px] font-medium" style={{ color: '#16a34a' }} role="status">Saved</span>}
        {busy && <Spinner small />}
        <Switch checked={checked} disabled={busy} onChange={onChange} label={title} />
      </div>
    </div>
  );
}

export default function NotificationPrefsCard() {
  const [prefs, setPrefs] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [err, setErr] = useState('');
  const [busyField, setBusyField] = useState(null);
  const [savedField, setSavedField] = useState(null);
  const savedTimer = useRef(null);

  useEffect(() => {
    let alive = true;
    apiGet(PREFS_PATH)
      .then((p) => {
        if (alive) setPrefs({ announcementsOptOut: !!p.announcementsOptOut, celebrationsOptOut: !!p.celebrationsOptOut });
      })
      .catch((e) => { if (alive) setLoadErr(e); });
    return () => { alive = false; clearTimeout(savedTimer.current); };
  }, []);

  // checked (positive) → optOut (stored) inversion happens HERE: the switch
  // hands us its next positive state; we PATCH the single opt-out field.
  async function setChecked(field, nextChecked) {
    const nextOptOut = !nextChecked;
    setErr('');
    setSavedField(null);
    setBusyField(field);
    const prev = prefs;
    setPrefs({ ...prefs, [field]: nextOptOut }); // optimistic
    try {
      const r = await apiPatch(PREFS_PATH, { [field]: nextOptOut });
      setPrefs({ announcementsOptOut: !!r.announcementsOptOut, celebrationsOptOut: !!r.celebrationsOptOut });
      setSavedField(field);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedField(null), 2000);
    } catch (e) {
      setPrefs(prev); // revert on error
      setErr(e.message || 'Could not save your preference. Please try again.');
    } finally {
      setBusyField(null);
    }
  }

  // Route not deployed / no employee linked → hide quietly (matches the old
  // feed opt-out bar's behaviour). Other failures show a small inline notice.
  if (loadErr) {
    if (loadErr.status === 404) return null;
    return (
      <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <h2 className="text-base font-semibold" style={{ color: 'var(--theme-text)' }}>Notifications</h2>
        <p className="mt-1 text-xs" style={{ color: '#dc2626' }}>
          {loadErr.message || 'Could not load your notification preferences.'}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <h2 className="flex items-center text-base font-semibold" style={{ color: 'var(--theme-text)' }}>
        Notifications
        <InfoTip text="Choose what you receive. Changes save instantly — flip a toggle off to stop that notification, on to receive it again." />
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: 'var(--theme-muted)' }}>What we send you, and where you appear.</p>
      {err && <p className="mt-2 text-xs" style={{ color: '#dc2626' }} role="alert">{err}</p>}
      {!prefs ? (
        <div className="flex justify-center py-6"><Spinner small /></div>
      ) : (
        <div className="mt-2 divide-y" style={{ borderColor: 'var(--theme-border)' }}>
          <PrefRow
            title="Company announcements"
            description="Email/WhatsApp pushes for announcements — the in-app feed always shows them."
            tip="Turning this off only stops the email/WhatsApp pushes. Announcements always remain visible in your in-app news feed."
            checked={!prefs.announcementsOptOut}
            busy={busyField === 'announcementsOptOut'}
            saved={savedField === 'announcementsOptOut'}
            onChange={(next) => setChecked('announcementsOptOut', next)}
          />
          <PrefRow
            title="Birthday & anniversary wishes"
            description="Include me in the celebrations feed and wishes."
            tip="Celebrations show only the day and month of your birthday (never the year) and your years of service for an anniversary. Turn this off to hide yourself from the celebrations feed and skip the wishes."
            checked={!prefs.celebrationsOptOut}
            busy={busyField === 'celebrationsOptOut'}
            saved={savedField === 'celebrationsOptOut'}
            onChange={(next) => setChecked('celebrationsOptOut', next)}
          />
        </div>
      )}
    </section>
  );
}

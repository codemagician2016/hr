'use client';

import { useEffect, useMemo, useState } from 'react';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
];

const TYPE_STYLES = {
  booking_created: {
    badge: 'bg-indigo-100 text-indigo-700 border-indigo-200',
    iconBg: 'bg-indigo-50 text-indigo-600',
    label: 'New booking',
  },
  appointment_confirmed: {
    badge: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    iconBg: 'bg-emerald-50 text-emerald-600',
    label: 'Confirmed',
  },
  appointment_cancelled: {
    badge: 'bg-red-100 text-red-700 border-red-200',
    iconBg: 'bg-red-50 text-red-600',
    label: 'Cancelled',
  },
  appointment_rescheduled: {
    badge: 'bg-amber-100 text-amber-700 border-amber-200',
    iconBg: 'bg-amber-50 text-amber-600',
    label: 'Rescheduled',
  },
  customer_cancelled: {
    badge: 'bg-rose-100 text-rose-700 border-rose-200',
    iconBg: 'bg-rose-50 text-rose-600',
    label: 'Customer cancelled',
  },
};

function formatDateTime(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en-NZ', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function getCalendarSyncSupport(httpsUrl) {
  if (!httpsUrl) {
    return {
      warning: '',
      supportsGoogle: false,
      limited: false,
    };
  }

  try {
    const url = new URL(httpsUrl);
    const host = url.hostname.toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    const isPrivateIpv4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
    const isHttps = url.protocol === 'https:';
    const limited = !isHttps || isLocalhost || isPrivateIpv4;

    return {
      warning: limited
        ? 'This calendar feed is on a local or non-HTTPS URL. Google Calendar and most remote calendar apps cannot subscribe until you use a live HTTPS domain.'
        : '',
      supportsGoogle: isHttps && !isLocalhost && !isPrivateIpv4,
      limited,
    };
  } catch {
    return {
      warning: 'This calendar feed URL is not valid yet. Refresh the page and try again.',
      supportsGoogle: false,
      limited: true,
    };
  }
}

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

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

export default function NotificationInboxPanel({ title, description, compact = false }) {
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState({ notifications: [], unreadCount: 0 });
  const [calendar, setCalendar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [copyState, setCopyState] = useState('');

  async function load() {
    setError('');
    try {
      const query = filter === 'unread' ? '?filter=unread' : '';
      const [notificationsRes, calendarRes] = await Promise.all([
        api(`/api/inbox${query}`),
        api('/api/inbox/calendar-feed'),
      ]);
      setData(notificationsRes);
      setCalendar(calendarRes.links);
    } catch (err) {
      setError(err.message || 'Could not load notifications.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function markRead(id) {
    setBusyId(id);
    try {
      await api(`/api/inbox/${id}/read`, { method: 'POST', body: '{}' });
      setData((prev) => ({
        ...prev,
        unreadCount: Math.max(0, (prev.unreadCount || 0) - 1),
        notifications: (prev.notifications || []).map((item) => (
          item.id === id ? { ...item, readAt: item.readAt || new Date().toISOString() } : item
        )),
      }));
    } catch (err) {
      setError(err.message || 'Could not mark this notification as read.');
    } finally {
      setBusyId('');
    }
  }

  async function markAllRead() {
    setMarkingAll(true);
    try {
      await api('/api/inbox/read-all', { method: 'POST', body: '{}' });
      setData((prev) => ({
        ...prev,
        unreadCount: 0,
        notifications: (prev.notifications || []).map((item) => ({
          ...item,
          readAt: item.readAt || new Date().toISOString(),
        })),
      }));
    } catch (err) {
      setError(err.message || 'Could not mark all notifications as read.');
    } finally {
      setMarkingAll(false);
    }
  }

  async function copyFeedUrl() {
    if (!calendar?.httpsUrl) return;
    try {
      await navigator.clipboard.writeText(calendar.httpsUrl);
      setCopyState('Copied');
      setTimeout(() => setCopyState(''), 1500);
    } catch {
      setCopyState('Copy failed');
      setTimeout(() => setCopyState(''), 1500);
    }
  }

  const unread = data.unreadCount || 0;
  const rows = data.notifications || [];
  const classes = compact ? 'space-y-4' : 'space-y-6';
  const calendarSupport = getCalendarSyncSupport(calendar?.httpsUrl);

  return (
    <div className={classes}>
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            <p className="text-sm text-gray-500 mt-1">{description}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {FILTERS.map((item) => {
              const active = filter === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setFilter(item.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={markAllRead}
              disabled={markingAll || unread === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 text-gray-700 hover:border-gray-900 disabled:opacity-50"
            >
              {markingAll ? 'Marking…' : 'Mark all read'}
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard label="Unread" value={unread} tint="bg-amber-50 text-amber-700" />
          <StatCard label="Shown" value={rows.length} tint="bg-indigo-50 text-indigo-700" />
          <StatCard label="Calendar sync" value={calendar ? (calendarSupport.limited ? 'Limited' : 'Ready') : '—'} tint="bg-emerald-50 text-emerald-700" />
          <StatCard label="Inbox state" value={loading ? 'Loading' : 'Live'} tint="bg-slate-50 text-slate-700" />
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Calendar sync</h3>
            <p className="text-sm text-gray-500 mt-1">Subscribe once and new bookings, cancellations, and reschedules stay in sync.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {calendar?.webcalUrl && (
              <a
                href={calendar.webcalUrl}
                className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-900"
              >
                Apple Calendar
              </a>
            )}
            {calendar?.googleUrl && calendarSupport.supportsGoogle && (
              <a
                href={calendar.googleUrl}
                target="_blank"
                rel="noreferrer"
                className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-900"
              >
                Google Calendar
              </a>
            )}
            <button
              type="button"
              onClick={copyFeedUrl}
              disabled={!calendar?.httpsUrl}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
            >
              {copyState || 'Copy feed URL'}
            </button>
          </div>
        </div>
        {calendarSupport.warning && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {calendarSupport.warning}
          </div>
        )}
        {calendar?.httpsUrl && (
          <p className="mt-3 text-xs text-gray-500 break-all">{calendar.httpsUrl}</p>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Inbox</h3>
            <p className="text-sm text-gray-500">Updates about bookings, cancellations, confirmations, and reschedules.</p>
          </div>
          {loading && <Spinner />}
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}

        {!loading && rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-xl">
            No notifications yet.
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((item) => {
              const tone = TYPE_STYLES[item.type] || TYPE_STYLES.booking_created;
              const unreadRow = !item.readAt;
              return (
                <div
                  key={item.id}
                  className={`rounded-2xl border px-4 py-4 ${unreadRow ? 'border-indigo-200 bg-indigo-50/40' : 'border-gray-200 bg-white'}`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-semibold text-sm ${tone.iconBg}`}>
                      {tone.label.slice(0, 1)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="font-semibold text-gray-900">{item.title}</p>
                          <p className="mt-1 text-sm text-gray-600 leading-relaxed">{item.body}</p>
                        </div>
                        <div className="flex flex-col items-start sm:items-end gap-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${tone.badge}`}>
                            {tone.label}
                          </span>
                          <span className="text-xs text-gray-400 whitespace-nowrap">{formatDateTime(item.createdAt)}</span>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-3 flex-wrap">
                        {item.appointment && (
                          <span className="text-xs text-gray-500">
                            {item.appointment.business?.name} · {item.appointment.service?.name || 'Appointment'} · {item.appointment.startTime}
                          </span>
                        )}
                        {!item.readAt && (
                          <button
                            type="button"
                            onClick={() => markRead(item.id)}
                            disabled={busyId === item.id}
                            className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
                          >
                            {busyId === item.id ? 'Saving…' : 'Mark as read'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, tint }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`text-2xl font-bold mt-2 inline-block px-3 py-1 rounded-lg ${tint}`}>
        {value}
      </p>
    </div>
  );
}

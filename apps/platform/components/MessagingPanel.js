'use client';

// Messaging panel — customer-side dashboard for SMS + WhatsApp + Email
// notifications. Mounted at /<slug>/admin under Settings → Messaging
// sub-tab.
//
// Two states:
//   1. Managed channels NOT yet enabled by DriftHR — shows "Request access"
//      flow + the Email-only recap.
//   2. Managed channels enabled — shows the dual-counter dashboard,
//      per-event channel grid, quota policy, buy-pack widget, and
//      recent activity stream.

import { useState, useEffect, useCallback } from 'react';

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

// Tiny presentational helper — counter card with progress bar.
function CounterCard({ label, used, total, available, hint }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const remaining = Math.max(0, total - used);
  if (!available) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-2xl p-5">
        <p className="text-xs font-mono uppercase tracking-wider text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-400 mt-2">— Unavailable in your country</p>
        <p className="text-xs text-gray-500 mt-2">{hint}</p>
      </div>
    );
  }
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-mono uppercase tracking-wider text-gray-500">{label}</p>
        <p className="text-xs text-gray-500">{pct}% used</p>
      </div>
      <p className="text-2xl font-bold text-gray-900 mt-1">
        {remaining}<span className="text-base font-medium text-gray-400"> of {total}</span>
      </p>
      <div className="mt-3 h-2 rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full transition-all"
          style={{
            width: `${pct}%`,
            background: 'var(--theme-primary, #6366f1)',
          }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-3">{hint}</p>
    </div>
  );
}

// Per-event channel grid — rows are templates, columns are channels.
function EventChannelGrid({ templates, eventChannels, onToggle, busy }) {
  const channels = ['whatsapp', 'sms', 'email'];
  const labels = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs font-semibold uppercase tracking-wider text-gray-600">
          <tr>
            <th className="text-left p-3 pl-5">Event</th>
            {channels.map((c) => (
              <th key={c} className="text-center p-3 w-24">{labels[c]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {templates.map((t, idx) => {
            const prefs = eventChannels?.[t.key] || {};
            return (
              <tr key={t.key} className={idx % 2 ? 'bg-gray-50/40' : ''}>
                <td className="p-3 pl-5">
                  <p className="font-medium text-gray-900">{t.displayName}</p>
                  <p className="text-xs text-gray-500">{t.category.toLowerCase()}</p>
                </td>
                {channels.map((c) => {
                  const checked = prefs[c] === true;
                  const supported = t.channels[c];
                  return (
                    <td key={c} className="text-center p-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!supported || busy}
                        onChange={() => onToggle(t.key, c, !checked)}
                        className="w-4 h-4 rounded accent-indigo-600"
                        title={!supported ? `Template doesn't support ${labels[c]}` : ''}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Recent-activity stream — last few message deliveries with status pill.
function RecentActivity({ deliveries }) {
  if (!deliveries?.length) {
    return (
      <p className="text-sm text-gray-500 italic">No messages sent yet this cycle.</p>
    );
  }
  const statusColor = {
    DELIVERED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    SENT:      'bg-blue-50 text-blue-700 border-blue-200',
    FAILED:    'bg-rose-50 text-rose-700 border-rose-200',
    BLOCKED_OPTOUT: 'bg-amber-50 text-amber-700 border-amber-200',
    BLOCKED_QUOTA:  'bg-amber-50 text-amber-700 border-amber-200',
    BLOCKED_RATE_LIMIT: 'bg-amber-50 text-amber-700 border-amber-200',
    PENDING:   'bg-gray-50 text-gray-700 border-gray-200',
  };
  return (
    <div className="bg-white border border-gray-200 rounded-2xl">
      <ul className="divide-y divide-gray-100">
        {deliveries.map((d) => (
          <li key={d.id} className="px-5 py-3 flex items-center gap-3 text-sm">
            <span className="font-mono text-xs text-gray-400 w-20 shrink-0">
              {new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="text-gray-700 flex-1 truncate">
              {d.channel} → {d.recipientPhone || d.recipientEmail || '—'}
            </span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${statusColor[d.status] || statusColor.PENDING}`}>
              {d.status.replace('BLOCKED_', '').toLowerCase().replace(/_/g, ' ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MessagingPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestNote, setRequestNote] = useState('');
  const [showRequest, setShowRequest] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await api('/api/notification-config');
      setData(d);
    } catch (err) {
      setError(err.message || 'Failed to load notification config');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const config = data?.config;
  const slots = data?.slotCounts;
  const usage = data?.usage;
  const templates = data?.templates || [];
  const eventChannels = config?.eventChannels || {};
  const managedSmsOn = config?.managedSmsEnabled;
  const managedWaOn = config?.managedWhatsappEnabled;
  const requestStatus = config?.requestAccessStatus || 'NONE';

  async function toggleEventChannel(templateKey, channel, value) {
    setBusy(true); setError('');
    const next = { ...eventChannels, [templateKey]: { ...(eventChannels[templateKey] || {}), [channel]: value } };
    try {
      await api('/api/notification-config/event-channels', {
        method: 'PUT',
        body: JSON.stringify({ eventChannels: next }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  async function submitRequest() {
    if (requestNote.trim().length < 10) { setError('Please describe how you plan to use SMS/WhatsApp (at least 10 characters)'); return; }
    setBusy(true); setError('');
    try {
      await api('/api/notification-config/request-access', {
        method: 'POST',
        body: JSON.stringify({ note: requestNote.trim() }),
      });
      setShowRequest(false);
      setRequestNote('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  async function setQuotaAction(action) {
    setBusy(true); setError('');
    try {
      await api('/api/notification-config/quota-action', {
        method: 'PUT',
        body: JSON.stringify({ quotaExhaustedAction: action }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  async function buyPack(amount) {
    setBusy(true); setError('');
    try {
      const res = await api('/api/notification-config/buy-pack', {
        method: 'POST',
        body: JSON.stringify({ amountUsd: amount }),
      });
      if (res?.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading messaging settings…</p>;
  if (error && !data) return <p className="text-sm text-rose-600">{error}</p>;
  if (!data) return null;

  const noManagedYet = !managedSmsOn && !managedWaOn;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Messaging</h2>
        <p className="text-sm text-gray-500 mt-1">
          SMS and WhatsApp reminders for your customers. Email is always on.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {noManagedYet && requestStatus === 'NONE' && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <p className="text-sm text-gray-700">
            Right now we&apos;re sending email reminders only. Want SMS and WhatsApp too?
            Tell us briefly how you plan to use them and we&apos;ll review your request — usually within 24 hours.
          </p>
          {!showRequest ? (
            <button
              onClick={() => setShowRequest(true)}
              className="mt-4 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
            >
              Request access →
            </button>
          ) : (
            <div className="mt-4 space-y-3">
              <textarea
                value={requestNote}
                onChange={(e) => setRequestNote(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="e.g., I want to send appointment reminders 24 hours before each visit so my customers don't no-show."
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={submitRequest}
                  disabled={busy || requestNote.length < 10}
                  className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
                >
                  Submit request
                </button>
                <button
                  onClick={() => { setShowRequest(false); setRequestNote(''); }}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {requestStatus === 'PENDING' && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
          <p className="text-sm font-semibold text-amber-900">Request under review ⏳</p>
          <p className="text-sm text-amber-800 mt-1">
            We&apos;re looking at your access request. You&apos;ll get an email once it&apos;s approved (usually within 24 hours).
            In the meantime, email reminders continue to work.
          </p>
        </div>
      )}

      {requestStatus === 'REJECTED' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5">
          <p className="text-sm font-semibold text-rose-900">Request not approved</p>
          <p className="text-sm text-rose-800 mt-1">
            Your access request didn&apos;t pass review. Email <a href="mailto:support@sitepresso.com" className="underline">support@sitepresso.com</a> if you&apos;d like to discuss.
          </p>
        </div>
      )}

      {(managedSmsOn || managedWaOn) && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CounterCard
              label="SMS this month"
              used={slots ? slots.smsTotal - slots.sms : 0}
              total={slots?.smsTotal || 0}
              available={slots?.smsAvailable && managedSmsOn}
              hint={managedSmsOn ? `Sending 1 SMS uses budget for fewer WhatsApp messages.` : 'SMS not enabled. Use WhatsApp.'}
            />
            <CounterCard
              label="WhatsApp this month"
              used={slots ? slots.whatsappUtilityTotal - slots.whatsappUtility : 0}
              total={slots?.whatsappUtilityTotal || 0}
              available={slots?.whatsappAvailable && managedWaOn}
              hint={managedWaOn ? `Best engagement rates in your customers' inbox.` : 'WhatsApp not enabled.'}
            />
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-5">
            <p className="text-sm font-semibold text-gray-900 mb-2">Need more this month?</p>
            <p className="text-xs text-gray-500 mb-4">Top-up packs open a secure Paddle checkout and apply after payment confirmation.</p>
            <div className="flex flex-wrap gap-2">
              {[5, 20, 50].map((amt) => (
                <button
                  key={amt}
                  onClick={() => buyPack(amt)}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                >
                  Buy ${amt} pack
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold text-gray-900 mb-1">Per-event channels</p>
            <p className="text-xs text-gray-500 mb-3">
              Pick which channel(s) to use for each notification. Email is always available as a fallback.
            </p>
            <EventChannelGrid
              templates={templates}
              eventChannels={eventChannels}
              onToggle={toggleEventChannel}
              busy={busy}
            />
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-5">
            <p className="text-sm font-semibold text-gray-900 mb-3">When you run out of budget</p>
            <div className="space-y-2">
              {[
                { value: 'PAUSE',     label: 'Pause SMS + WhatsApp',  desc: 'Continue with email only until next cycle. (Default)' },
                { value: 'STOP',      label: 'Hard stop',             desc: 'Don\'t send anything until next cycle.' },
              ].map((opt) => {
                const active = config?.quotaExhaustedAction === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setQuotaAction(opt.value)}
                    disabled={busy}
                    className={`w-full text-left p-3 rounded-xl border transition-colors ${active ? 'border-indigo-500 bg-indigo-50/50' : 'border-gray-200 hover:bg-gray-50'}`}
                  >
                    <p className="text-sm font-semibold text-gray-900">
                      {active && '✓ '}
                      {opt.label}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold text-gray-900 mb-3">Recent activity</p>
            <RecentActivity deliveries={data?.recentDeliveries || []} />
          </div>
        </>
      )}
    </div>
  );
}

'use client';

// Super-admin Messaging tab. Two areas:
//   1. Tier Budget — single global knob: messagingBudgetPercent per tier
//   2. Tenants — per-tenant gates (managedSmsEnabled / managedWhatsappEnabled),
//      pending request queue, drawer with usage + recent deliveries
//
// Default state is "all gates OFF" — DriftHR explicitly enables managed
// channels per tenant (anti-abuse + compliance scoping).

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

function StatusPill({ status }) {
  const map = {
    NONE:     'bg-gray-100 text-gray-700',
    PENDING:  'bg-amber-100 text-amber-800',
    APPROVED: 'bg-emerald-100 text-emerald-800',
    REJECTED: 'bg-rose-100 text-rose-800',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[status] || map.NONE}`}>
      {status.toLowerCase()}
    </span>
  );
}

function GateToggle({ value, onChange, disabled, label }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-emerald-600' : 'bg-gray-200'} disabled:opacity-50`}
      aria-label={label}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${value ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

// ─── Tier budgets (the global knob) ──────────────────────────────────────────
function TierBudgetSection() {
  const [tiers, setTiers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api('/api/admin/notification-access/pricing-tiers');
      setTiers(data.tiers || []);
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(tier) {
    const newPct = edits[tier.id];
    if (newPct == null) return;
    setSavingId(tier.id); setError('');
    try {
      await api(`/api/admin/notification-access/pricing-tiers/${tier.id}/budget`, {
        method: 'PUT',
        body: JSON.stringify({ messagingBudgetPercent: Number(newPct) }),
      });
      setEdits((e) => { const n = { ...e }; delete n[tier.id]; return n; });
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setSavingId(null); }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading tier budgets…</p>;

  // Group by vertical for readability
  const byVertical = tiers.reduce((acc, t) => {
    (acc[t.vertical] = acc[t.vertical] || []).push(t);
    return acc;
  }, {});

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">Tier budget %</h3>
        <p className="text-sm text-gray-500 mt-1">
          Percentage of plan price spent on SMS + WhatsApp each cycle.
          The customer-visible slot count is computed from this and per-country
          provider rates. <strong>Solo tier should stay at 0%</strong> (email only).
        </p>
        {error && <p className="text-sm text-rose-600 mt-2">{error}</p>}
      </div>
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        {Object.entries(byVertical).map(([vertical, list]) => (
          <div key={vertical}>
            <div className="px-5 py-2 bg-gray-50 text-xs font-mono uppercase tracking-wider text-gray-600 border-b border-gray-200">
              {vertical.toLowerCase()}
            </div>
            <table className="w-full text-sm">
              <tbody>
                {list.map((t) => {
                  const editing = edits[t.id] != null;
                  const value = editing ? edits[t.id] : Number(t.messagingBudgetPercent || 0);
                  return (
                    <tr key={t.id} className="border-b border-gray-100 last:border-0">
                      <td className="px-5 py-3 font-medium text-gray-900">{t.name}</td>
                      <td className="px-3 py-3">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.5"
                          value={value}
                          onChange={(e) => setEdits((s) => ({ ...s, [t.id]: e.target.value }))}
                          className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-right"
                        />
                        <span className="ml-1 text-sm text-gray-500">%</span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        {editing && (
                          <button
                            onClick={() => save(t)}
                            disabled={savingId === t.id}
                            className="px-3 py-1 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50"
                          >
                            {savingId === t.id ? 'Saving…' : 'Save'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Per-tenant gates ────────────────────────────────────────────────────────
function TenantsSection() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [drawerId, setDrawerId] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const url = filter ? `/api/admin/notification-access?status=${filter}` : '/api/admin/notification-access';
      const data = await api(url);
      setItems(data.items || []);
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function openDrawer(businessId) {
    setDrawerId(businessId);
    setDrawer(null);
    try {
      const data = await api(`/api/admin/notification-access/${businessId}`);
      setDrawer(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleGate(businessId, field, value) {
    setBusy(true); setError('');
    try {
      await api(`/api/admin/notification-access/${businessId}/gates`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: value }),
      });
      await load();
      if (drawerId === businessId) await openDrawer(businessId);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  async function reviewRequest(businessId, status) {
    setBusy(true); setError('');
    try {
      await api(`/api/admin/notification-access/${businessId}/request-status`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      await load();
      if (drawerId === businessId) await openDrawer(businessId);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Per-tenant gates</h3>
          <p className="text-sm text-gray-500 mt-1">
            Default OFF. Approve a tenant's request or toggle gates manually.
          </p>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-xl bg-white border border-gray-200">
          {['', 'PENDING', 'APPROVED', 'REJECTED'].map((s) => (
            <button
              key={s || 'all'}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${filter === s ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {s ? s.toLowerCase() : 'all'}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading tenants…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500 italic">
          {filter
            ? `No tenants with status "${filter.toLowerCase()}".`
            : 'No tenants have a notification config yet — they\'ll appear here as customers visit Settings → Messaging.'}
        </p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-semibold uppercase tracking-wider text-gray-600">
              <tr>
                <th className="text-left p-3 pl-5">Tenant</th>
                <th className="text-left p-3">Country</th>
                <th className="text-center p-3">Managed SMS</th>
                <th className="text-center p-3">Managed WA</th>
                <th className="text-center p-3">Request</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b border-gray-100 last:border-0">
                  <td className="p-3 pl-5">
                    <p className="font-medium text-gray-900">{it.business?.name || it.business?.slug}</p>
                    <p className="text-xs text-gray-500 font-mono">{it.business?.slug}</p>
                  </td>
                  <td className="p-3 text-gray-700">{it.business?.country || '—'}</td>
                  <td className="p-3 text-center">
                    <GateToggle
                      value={it.managedSmsEnabled}
                      onChange={(v) => toggleGate(it.businessId, 'managedSmsEnabled', v)}
                      disabled={busy}
                      label="managed SMS"
                    />
                  </td>
                  <td className="p-3 text-center">
                    <GateToggle
                      value={it.managedWhatsappEnabled}
                      onChange={(v) => toggleGate(it.businessId, 'managedWhatsappEnabled', v)}
                      disabled={busy}
                      label="managed WhatsApp"
                    />
                  </td>
                  <td className="p-3 text-center">
                    <StatusPill status={it.requestAccessStatus || 'NONE'} />
                  </td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => openDrawer(it.businessId)}
                      className="px-3 py-1 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Detail →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Drawer */}
      {drawerId && (
        <div className="fixed inset-0 z-50 flex" onClick={() => setDrawerId(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="ml-auto w-full max-w-xl bg-white shadow-xl h-full overflow-y-auto p-6 relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setDrawerId(null)}
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-700 text-2xl leading-none"
            >×</button>
            {!drawer ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : (
              <div className="space-y-5">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{drawer.config.business?.name}</h3>
                  <p className="text-sm text-gray-500 font-mono">{drawer.config.business?.slug}</p>
                </div>

                {drawer.config.requestAccessStatus === 'PENDING' && (
                  <div className="p-4 rounded-xl bg-amber-50 border border-amber-200">
                    <p className="text-sm font-semibold text-amber-900">Pending request</p>
                    <p className="text-sm text-amber-800 mt-1 italic">"{drawer.config.requestAccessNote}"</p>
                    <p className="text-xs text-amber-700 mt-2">
                      Submitted: {new Date(drawer.config.requestAccessAt).toLocaleString()}
                    </p>
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => reviewRequest(drawerId, 'APPROVED')}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                      >
                        Approve + enable both gates
                      </button>
                      <button
                        onClick={() => reviewRequest(drawerId, 'REJECTED')}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 text-sm font-semibold hover:bg-rose-50 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-sm font-semibold text-gray-900 mb-2">Slot counts ({drawer.slotCounts?.country || '—'})</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="p-3 rounded-xl bg-gray-50 border border-gray-200">
                      <p className="text-xs text-gray-500">SMS this cycle</p>
                      <p className="font-semibold">{drawer.slotCounts?.sms ?? 0} of {drawer.slotCounts?.smsTotal ?? 0}</p>
                    </div>
                    <div className="p-3 rounded-xl bg-gray-50 border border-gray-200">
                      <p className="text-xs text-gray-500">WhatsApp</p>
                      <p className="font-semibold">{drawer.slotCounts?.whatsappUtility ?? 0} of {drawer.slotCounts?.whatsappUtilityTotal ?? 0}</p>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold text-gray-900 mb-2">Last 6 cycles</p>
                  {drawer.usageHistory.length === 0 ? (
                    <p className="text-xs text-gray-500 italic">No usage yet.</p>
                  ) : (
                    <table className="w-full text-xs border border-gray-200 rounded-xl overflow-hidden">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left p-2">Cycle</th>
                          <th className="text-right p-2">SMS sent</th>
                          <th className="text-right p-2">WA sent</th>
                          <th className="text-right p-2">Spent USD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {drawer.usageHistory.map((u) => (
                          <tr key={u.id} className="border-t border-gray-100">
                            <td className="p-2 font-mono">{u.cycle}</td>
                            <td className="p-2 text-right">{u.smsCount}</td>
                            <td className="p-2 text-right">{u.whatsappCount}</td>
                            <td className="p-2 text-right">${(Number(u.smsSpentUsd) + Number(u.whatsappSpentUsd)).toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  <p className="text-sm font-semibold text-gray-900 mb-2">Recent deliveries</p>
                  {drawer.recentDeliveries.length === 0 ? (
                    <p className="text-xs text-gray-500 italic">No messages yet.</p>
                  ) : (
                    <ul className="text-xs space-y-1">
                      {drawer.recentDeliveries.slice(0, 10).map((d) => (
                        <li key={d.id} className="flex justify-between gap-2 text-gray-700">
                          <span className="font-mono">{new Date(d.createdAt).toLocaleTimeString()}</span>
                          <span className="flex-1 truncate">{d.channel} → {d.recipientPhone || d.recipientEmail || '—'}</span>
                          <span className="text-gray-500">{d.status.toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default function NotificationAccessTab() {
  return (
    <div className="space-y-8">
      <TierBudgetSection />
      <TenantsSection />
    </div>
  );
}

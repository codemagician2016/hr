'use client';

// Marketing automation panel — Settings → Marketing sub-tab. Customer
// toggles each of 6 pre-built campaigns, customizes content/coupon/timing,
// and sees 30-day stats per campaign.

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

function CampaignCard({ camp, stats, onUpdate, busy }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    customSubject: camp.customSubject || camp.defaultSubject,
    customBody:    camp.customBody    || camp.defaultBody,
    customCouponCode: camp.customCouponCode || '',
  });

  async function toggle(value) {
    await onUpdate(camp.key, { isEnabled: value });
  }

  async function save() {
    await onUpdate(camp.key, {
      customSubject:    draft.customSubject === camp.defaultSubject ? null : draft.customSubject,
      customBody:       draft.customBody === camp.defaultBody ? null : draft.customBody,
      customCouponCode: draft.customCouponCode || null,
    });
    setEditing(false);
  }

  async function sendTest() {
    try {
      await api(`/api/marketing-automation/${camp.key}/test`, { method: 'POST' });
      alert('Test email sent. Check your inbox.');
    } catch (err) {
      alert(`Test failed: ${err.message}`);
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h4 className="text-base font-semibold text-gray-900">{camp.displayName}</h4>
            <button
              onClick={() => toggle(!camp.isEnabled)}
              disabled={busy}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${camp.isEnabled ? 'bg-emerald-600' : 'bg-gray-200'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${camp.isEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-1">{camp.description}</p>

          {camp.isEnabled && stats && (
            <div className="mt-3 flex gap-3 text-xs flex-wrap">
              <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                {stats.sent || 0} sent (30d)
              </span>
              {stats.suppressed > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-gray-50 text-gray-700 border border-gray-200">
                  {stats.suppressed} suppressed
                </span>
              )}
              {stats.failed > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                  {stats.failed} failed
                </span>
              )}
              {stats.pending > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  {stats.pending} queued
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {camp.isEnabled && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => setEditing(!editing)}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            {editing ? '← Close editor' : 'Edit content →'}
          </button>
          <button
            onClick={sendTest}
            className="text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            Send test to me →
          </button>
        </div>
      )}

      {editing && (
        <div className="mt-4 space-y-3 pt-4 border-t border-gray-100">
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Subject</label>
            <input
              type="text"
              value={draft.customSubject}
              onChange={(e) => setDraft((d) => ({ ...d, customSubject: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Body</label>
            <textarea
              value={draft.customBody}
              rows={8}
              onChange={(e) => setDraft((d) => ({ ...d, customBody: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">
              Variables you can use: {camp.variables.map((v) => `{${v}}`).join(', ')}
            </p>
          </div>
          {camp.suggestedCoupon && (
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Coupon code (optional)</label>
              <input
                type="text"
                value={draft.customCouponCode}
                onChange={(e) => setDraft((d) => ({ ...d, customCouponCode: e.target.value.toUpperCase() }))}
                placeholder="WELCOME15"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
              />
              <p className="text-xs text-gray-500 mt-1">
                If set, the {`{COUPON_CODE}`} variable in the body renders this code.
              </p>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
            >
              Save changes
            </button>
            <button
              onClick={() => {
                setDraft({
                  customSubject: camp.defaultSubject,
                  customBody:    camp.defaultBody,
                  customCouponCode: '',
                });
              }}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MarketingAutomationPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await api('/api/marketing-automation');
      setData(d);
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleUpdate(campaignKey, body) {
    setBusy(true); setError('');
    try {
      await api(`/api/marketing-automation/${campaignKey}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading marketing campaigns…</p>;
  if (error && !data) return <p className="text-sm text-rose-600">{error}</p>;
  if (!data) return null;

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Marketing automation</h2>
        <p className="text-sm text-gray-500 mt-1">
          Set-and-forget campaigns that bring customers back. All emails include
          a one-click unsubscribe link to stay compliant.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {data.campaigns.map((c) => (
          <CampaignCard
            key={c.key}
            camp={c}
            stats={data.stats?.[c.key]}
            onUpdate={handleUpdate}
            busy={busy}
          />
        ))}
      </div>
    </div>
  );
}

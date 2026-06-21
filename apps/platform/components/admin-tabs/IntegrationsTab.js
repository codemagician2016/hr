'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/adminApi';
import DevelopersPanel from '@/components/admin-tabs/DevelopersPanel';

// The owned apps you can connect in one click. Each speaks AapkaConnect (manifest
// + Bearer key + signed webhooks), so connecting = paste your key; the engine does
// the rest. A tenant gets a key by signing up in the app (the "Get a key" link).
const APPS = [
  {
    key: 'aapkarider', name: 'AapkaRider', category: 'delivery', emoji: 'R', accent: '#22d3a6', recommended: true,
    tagline: 'Send fulfilled orders to rider dispatch and track delivery live.',
    baseUrl: 'https://rider-api.aapkatech.com', getKeyUrl: 'https://rider-api.aapkatech.com',
    whatsNext: ['Hand a fulfilled order to dispatch from the order screen', 'Watch delivery status flow back into Sitepresso'],
    customerNote: 'Your customers get live delivery tracking on their order.',
  },
  {
    key: 'aapkachat', name: 'AapkaChat', category: 'chat', emoji: '💬', accent: '#5b8cff',
    tagline: 'Live chat for your storefront — shared inbox + widget.',
    baseUrl: 'https://chat-api.aapkatech.com', getKeyUrl: 'https://chat-api.aapkatech.com',
    whatsNext: ['The chat widget is now live on your storefront', 'Reply to visitors from the AapkaChat shared inbox'],
    customerNote: 'A chat bubble appears on your storefront so visitors can message you.',
  },
  {
    key: 'aapkawms', name: 'AapkaWMS', category: 'wms', emoji: '📦', accent: '#84cc16',
    tagline: 'Scan-driven warehouse — GRN, stock, picks, dispatch.',
    baseUrl: 'https://wms-api.aapkatech.com', getKeyUrl: 'https://wms.aapkatech.com',
    whatsNext: ['Receive your first stock with a GRN', 'Pick & dispatch orders by scan'],
    customerNote: 'Faster, more accurate fulfilment — fewer wrong or late shipments.',
  },
  {
    key: 'aapkapos', name: 'AapkaPOS', category: 'pos', emoji: '🧾', accent: '#a78bfa',
    tagline: 'Point of sale for every counter — checkout + inventory.',
    baseUrl: 'https://pos-api.aapkatech.com', getKeyUrl: 'https://pos-api.aapkatech.com',
    whatsNext: ['Open a register and ring up your first in-store sale', 'Keep in-store + online stock in sync'],
    customerNote: 'Sell in person; online and store inventory stay as one.',
  },
];

const SECTIONS = [
  { key: 'apps', label: 'Connected apps' },
  { key: 'api', label: 'API & webhooks' },
];

function normalizeSection(value, fallback = 'apps') {
  return SECTIONS.some((section) => section.key === value) ? value : fallback;
}

export default function IntegrationsTab({ initialSection = 'apps' }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [section, setSectionState] = useState(() => normalizeSection(searchParams.get('section'), normalizeSection(initialSection)));
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connectingKey, setConnectingKey] = useState(null); // app.key currently being connected
  const [apiKey, setApiKey] = useState('');
  const [custom, setCustom] = useState({ open: false, category: 'wms', baseUrl: '', apiKey: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testResults, setTestResults] = useState({}); // connectionId -> { ok, message, workspace }
  const [testingId, setTestingId] = useState(null);
  const [webhookBusyId, setWebhookBusyId] = useState(null);

  useEffect(() => {
    const next = normalizeSection(searchParams.get('section'), normalizeSection(initialSection));
    setSectionState(next);
  }, [initialSection, searchParams]);

  function setSection(nextSection) {
    const next = normalizeSection(nextSection);
    setSectionState(next);
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    params.set('tab', 'integrations');
    if (next === 'apps') params.delete('section');
    else params.set('section', next);
    router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
  }

  async function load() {
    setLoading(true);
    try { setConnections((await api('/api/integrations')).connections || []); }
    catch (e) { setError(e.message || 'Could not load connections.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const connectionFor = (category) => connections.find((c) => c.category === category);

  async function connectApp(app, key, baseUrl) {
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await api('/api/integrations', { method: 'POST', body: JSON.stringify({ category: app.category, baseUrl, apiKey: key }) });
      setNotice(`Connected ${res.connection.provider}${res.connection.webhookActive ? ' — events are live.' : '.'}`);
      setConnectingKey(null); setApiKey(''); setCustom({ ...custom, open: false, baseUrl: '', apiKey: '' });
      await load();
    } catch (err) { setError(err.data?.message || err.message || 'Could not connect — check the URL and key.'); }
    finally { setBusy(false); }
  }
  async function disconnect(id) {
    if (!confirm('Disconnect this app?')) return;
    try { await api(`/api/integrations/${id}`, { method: 'DELETE' }); await load(); }
    catch (err) { setError(err.message); }
  }
  // Verify the connection actually works right now (pings the app).
  async function testConnection(conn) {
    setTestingId(conn.id); setError('');
    try {
      const res = await api(`/api/integrations/${conn.id}/test`, { method: 'POST', body: '{}' });
      setTestResults((m) => ({ ...m, [conn.id]: res }));
    } catch (err) {
      setTestResults((m) => ({ ...m, [conn.id]: { ok: false, message: err.data?.message || err.message || 'Test failed.' } }));
    } finally { setTestingId(null); }
  }
  // (Re)register our webhook so the app pushes events back — fixes "events off".
  async function reEnableEvents(conn) {
    setWebhookBusyId(conn.id); setError(''); setNotice('');
    try {
      const res = await api(`/api/integrations/${conn.id}/register-webhook`, { method: 'POST', body: '{}' });
      if (res.ok) { setNotice('Events enabled — the app will now push updates to Sitepresso.'); await load(); }
      else setError(res.message || 'Could not enable events.');
    } catch (err) { setError(err.data?.message || err.message || 'Could not enable events.'); }
    finally { setWebhookBusyId(null); }
  }
  // SSO: open the connected app signed in as this tenant (scoped to its workspace).
  async function openApp(category) {
    // Pre-open the tab inside the click gesture (popup blockers) and KEEP the
    // handle — passing 'noopener' makes window.open return null, stranding a
    // blank tab. Severing w.opener gives the same tabnabbing protection.
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    try {
      const res = await api(`/api/integrations/${category}/sso`, { method: 'POST', body: '{}' });
      if (res.url) { if (w) w.location.href = res.url; else window.open(res.url, '_blank'); }
      else if (w) w.close();
    } catch (err) { if (w) w.close(); setError(err.data?.message || err.message || 'Could not open the app.'); }
  }

  const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900';

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Integrations</h2>
        <p className="text-sm text-gray-500 mt-1">
          Connect delivery, warehouse, chat, POS, and technical systems from one place.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 rounded-2xl border border-gray-200 bg-white p-2">
        {SECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSection(item.key)}
            className={`rounded-xl px-4 py-2 text-sm font-bold transition ${section === item.key ? 'bg-gray-950 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      {section === 'api' ? (
        <DevelopersPanel embedded />
      ) : (
        <>
          <section className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-700">Recommended start</p>
                <h3 className="mt-1 text-lg font-black text-gray-950">Connect the app first, then use API keys only when a custom system needs them.</h3>
                <p className="mt-1 text-sm text-emerald-900">For rider flow, connect AapkaRider here. Fulfilled orders can then be handed to the rider app while Sitepresso keeps the order record.</p>
              </div>
              <button
                type="button"
                onClick={() => setSection('api')}
                className="rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-black text-emerald-800 hover:border-emerald-400"
              >
                Advanced API setup
              </button>
            </div>
          </section>

      {/* App gallery */}
      <div className="grid gap-4 md:grid-cols-2">
        {APPS.map((app) => {
          const conn = connectionFor(app.category);
          const opening = connectingKey === app.key;
          return (
            <div key={app.key} className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl text-2xl" style={{ background: `${app.accent}1f` }}>{app.emoji}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-gray-900">{app.name}</h3>
                    {app.recommended && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">recommended</span>}
                    {app.comingSoon && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">soon</span>}
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Free to start</span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">{app.tagline}</p>
                </div>
              </div>

              {conn ? (
                <div className="mt-4 space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
                  {/* Status row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">✓ Connected</span>
                    {conn.webhookActive ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700" title="The app pushes live updates back to Sitepresso">🟢 Events live</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800" title="The app isn't pushing updates back yet">
                        🟠 Events off
                        <button onClick={() => reEnableEvents(conn)} disabled={webhookBusyId === conn.id} className="underline disabled:opacity-50">{webhookBusyId === conn.id ? '…' : 'Re-enable'}</button>
                      </span>
                    )}
                    <span className="flex-1" />
                    <button onClick={() => testConnection(conn)} disabled={testingId === conn.id} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">{testingId === conn.id ? 'Testing…' : 'Test connection'}</button>
                    <button onClick={() => openApp(app.category)} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800">Open {app.name} ↗</button>
                    <button onClick={() => disconnect(conn.id)} className="text-xs font-semibold text-red-600 hover:underline">Disconnect</button>
                  </div>
                  {/* Test result */}
                  {testResults[conn.id] && (
                    <p className={`text-xs font-medium ${testResults[conn.id].ok ? 'text-emerald-700' : 'text-red-600'}`}>
                      {testResults[conn.id].ok
                        ? `✓ Verified working${testResults[conn.id].workspace?.name ? ` · ${testResults[conn.id].workspace.name}` : ''}`
                        : `✗ ${testResults[conn.id].message}`}
                    </p>
                  )}
                  {/* What's next + how customers see it */}
                  <div className="grid gap-3 sm:grid-cols-2 border-t border-gray-200 pt-3">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">What&apos;s next</p>
                      <ul className="mt-1 space-y-0.5">
                        {app.whatsNext.map((s, i) => <li key={i} className="flex gap-1.5 text-xs text-gray-600"><span className="text-gray-300">→</span>{s}</li>)}
                      </ul>
                    </div>
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">How your customers see it</p>
                      <p className="mt-1 text-xs text-gray-600">{app.customerNote}</p>
                    </div>
                  </div>
                </div>
              ) : opening ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs text-gray-500">Sign up or log in to {app.name}, copy your API key, and paste it here. We&apos;ll verify it before connecting.</p>
                  <input className={inputCls} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste your API key" autoFocus />
                  <div className="flex gap-2 items-center">
                    <button disabled={busy || !apiKey} onClick={() => connectApp(app, apiKey, app.baseUrl)} className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50">{busy ? 'Verifying…' : 'Connect'}</button>
                    <button onClick={() => { setConnectingKey(null); setApiKey(''); }} className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-600">Cancel</button>
                    <a href={app.getKeyUrl} target="_blank" rel="noreferrer" className="ml-auto self-center text-xs font-semibold text-indigo-600 hover:underline">Get your key ↗</a>
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-xs text-gray-600"><span className="font-semibold text-gray-700">For your customers:</span> {app.customerNote}</p>
                  <div className="mt-3 flex items-center gap-3 flex-wrap">
                    <button disabled={app.comingSoon} onClick={() => { setConnectingKey(app.key); setApiKey(''); setError(''); }} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-40">Connect</button>
                    <a href={app.getKeyUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-indigo-600 hover:underline">Create account / get your key ↗</a>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Connect any other (third-party) app */}
      <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-5">
        <button onClick={() => setCustom({ ...custom, open: !custom.open })} className="text-sm font-semibold text-gray-700">
          {custom.open ? '− ' : '+ '}Connect a different app
        </button>
        {custom.open && (
          <form onSubmit={(e) => { e.preventDefault(); connectApp({ category: custom.category }, custom.apiKey, custom.baseUrl); }} className="mt-3 space-y-3">
            <p className="text-xs text-gray-500">Any app that supports the AapkaConnect standard works — paste its address and API key.</p>
            <div className="grid gap-3 md:grid-cols-3">
              <select className={inputCls} value={custom.category} onChange={(e) => setCustom({ ...custom, category: e.target.value })}>
                {['delivery', 'wms', 'chat', 'pos'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input className={inputCls} value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} placeholder="https://app-url" />
              <input className={inputCls} type="password" value={custom.apiKey} onChange={(e) => setCustom({ ...custom, apiKey: e.target.value })} placeholder="API key" />
            </div>
            <button type="submit" disabled={busy || !custom.baseUrl} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50">Connect</button>
          </form>
        )}
      </div>

      {loading && <p className="text-xs text-gray-400">Loading connections…</p>}
        </>
      )}
    </div>
  );
}

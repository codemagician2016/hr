'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';

const DELIVERY_EVENTS = [
  'delivery.created',
  'delivery.ready_for_dispatch',
  'delivery.assigned',
  'delivery.picked_up',
  'delivery.out_for_delivery',
  'delivery.arrived',
  'delivery.delivered',
  'delivery.attempted_failed',
  'delivery.cancelled',
  'delivery.returned',
  'delivery.exception_opened',
  'delivery.exception_escalated',
  'delivery.exception_resolved',
];

const DEFAULT_SCOPES = {
  read: ['orders', 'deliveries'],
  write: ['deliveries'],
};

const SCOPE_RESOURCES = [
  { key: 'orders', label: 'Orders' },
  { key: 'deliveries', label: 'Deliveries' },
  { key: 'products', label: 'Products' },
  { key: 'customers', label: 'Customers' },
];

const KEY_PRESETS = [
  {
    key: 'rider',
    label: 'AapkaRider handoff',
    name: 'AapkaRider handoff key',
    scopes: { read: ['orders', 'deliveries'], write: ['deliveries'] },
    hint: 'Use when a rider app needs fulfilled orders and delivery status updates.',
  },
  {
    key: 'reporting',
    label: 'Read-only reporting',
    name: 'Reporting key',
    scopes: { read: ['orders', 'deliveries', 'products', 'customers'], write: [] },
    hint: 'Use for BI, dashboards, or support tools that must not change store data.',
  },
  {
    key: 'catalog',
    label: 'Catalog sync',
    name: 'Catalog sync key',
    scopes: { read: ['products'], write: [] },
    hint: 'Use for systems that only need product catalogue access.',
  },
];

const QUICK_START_ENDPOINTS = [
  { label: 'Confirm the key works', value: 'GET /api/v1/whoami' },
  { label: 'Read fulfilled orders', value: 'GET /api/v1/orders' },
  { label: 'Create delivery handoff', value: 'POST /api/v1/deliveries' },
  { label: 'Bulk create delivery handoffs', value: 'POST /api/v1/deliveries/bulk' },
  { label: 'Find by order reference', value: 'GET /api/v1/deliveries/lookup?externalRef=ORDER-10042' },
  { label: 'Update delivery status', value: 'POST /api/v1/deliveries/:id/status' },
  { label: 'Delivery API capabilities', value: 'GET /api/v1/deliveries/capabilities' },
  { label: 'OpenAPI spec', value: 'GET /api/v1/deliveries/openapi.json', copy: '/api/v1/deliveries/openapi.json' },
];

const GUIDE_STEPS = [
  ['1', 'Pick a preset', 'Choose the smallest permission set that matches the app.'],
  ['2', 'Create and copy once', 'The full API key or webhook secret is shown only at creation time.'],
  ['3', 'Test before launch', 'Use /api/v1/whoami for API keys and Test for webhook endpoints.'],
];

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function Badge({ children, tone = 'gray' }) {
  const cls = {
    gray: 'border-gray-200 bg-gray-50 text-gray-700',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    red: 'border-red-200 bg-red-50 text-red-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
  }[tone] || 'border-gray-200 bg-gray-50 text-gray-700';
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${cls}`}>{children}</span>;
}

function toggleInList(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export default function DevelopersPanel({ embedded = false }) {
  const [keys, setKeys] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [supportedEvents, setSupportedEvents] = useState(DELIVERY_EVENTS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [createdKey, setCreatedKey] = useState(null);
  const [createdWebhookSecret, setCreatedWebhookSecret] = useState(null);
  const [keyForm, setKeyForm] = useState({ name: 'AapkaRider handoff key', scopes: DEFAULT_SCOPES });
  const [webhookForm, setWebhookForm] = useState({ url: '', events: DELIVERY_EVENTS });

  const webhookEvents = useMemo(() => {
    const set = new Set([...(supportedEvents || []), ...DELIVERY_EVENTS]);
    return Array.from(set);
  }, [supportedEvents]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [keyData, webhookData, deliveryData] = await Promise.all([
        api('/api/public-api/keys'),
        api('/api/public-api/webhooks'),
        api('/api/public-api/webhooks/deliveries'),
      ]);
      setKeys(keyData.keys || []);
      setSubscriptions(webhookData.subscriptions || []);
      setSupportedEvents(webhookData.supportedEvents || DELIVERY_EVENTS);
      setDeliveries(deliveryData.deliveries || []);
    } catch (err) {
      setError(err.message || 'Could not load API and webhook settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function setScope(action, resource) {
    setKeyForm((current) => ({
      ...current,
      scopes: {
        ...current.scopes,
        [action]: toggleInList(current.scopes?.[action] || [], resource),
      },
    }));
  }

  function setWebhookEvent(event) {
    setWebhookForm((current) => ({ ...current, events: toggleInList(current.events || [], event) }));
  }

  function applyPreset(preset) {
    setKeyForm({ name: preset.name, scopes: preset.scopes });
    setNotice(`${preset.label} preset selected.`);
    setError('');
  }

  function selectedScopeCount(scopes = keyForm.scopes) {
    return ['read', 'write'].reduce((total, action) => total + (scopes?.[action] || []).length, 0);
  }

  async function createKey(event) {
    event.preventDefault();
    setBusy('key');
    setError('');
    setNotice('');
    setCreatedKey(null);
    setCreatedWebhookSecret(null);
    try {
      const data = await api('/api/public-api/keys', {
        method: 'POST',
        body: JSON.stringify(keyForm),
      });
      setCreatedKey(data);
      setNotice('API key created. Copy it now; it will not be shown again.');
      setKeyForm((current) => ({ ...current, name: 'AapkaRider handoff key' }));
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create API key');
    } finally {
      setBusy('');
    }
  }

  async function revokeKey(id) {
    if (!window.confirm('Revoke this API key? Existing integrations using it will stop working.')) return;
    setBusy(id);
    setError('');
    try {
      await api(`/api/public-api/keys/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message || 'Could not revoke API key');
    } finally {
      setBusy('');
    }
  }

  async function createWebhook(event) {
    event.preventDefault();
    setBusy('webhook');
    setError('');
    setNotice('');
    setCreatedKey(null);
    setCreatedWebhookSecret(null);
    try {
      const data = await api('/api/public-api/webhooks', {
        method: 'POST',
        body: JSON.stringify(webhookForm),
      });
      setCreatedWebhookSecret(data);
      setNotice('Webhook endpoint created. Copy the signing secret now; it will not be shown again.');
      setWebhookForm((current) => ({ ...current, url: '' }));
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not create webhook');
    } finally {
      setBusy('');
    }
  }

  async function deleteWebhook(id) {
    if (!window.confirm('Delete this webhook endpoint?')) return;
    setBusy(id);
    setError('');
    try {
      await api(`/api/public-api/webhooks/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message || 'Could not delete webhook');
    } finally {
      setBusy('');
    }
  }

  async function testWebhook(id) {
    setBusy(`test:${id}`);
    setError('');
    setNotice('');
    try {
      const data = await api(`/api/public-api/webhooks/${id}/test`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(`Test webhook ${String(data.delivery?.status || 'queued').toLowerCase()}.`);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not send test webhook');
    } finally {
      setBusy('');
    }
  }

  async function replayWebhookDelivery(id) {
    setBusy(`replay:${id}`);
    setError('');
    setNotice('');
    try {
      const data = await api(`/api/public-api/webhooks/deliveries/${id}/replay`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(`Webhook replay ${String(data.delivery?.status || 'queued').toLowerCase()}.`);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not replay webhook');
    } finally {
      setBusy('');
    }
  }

  async function copy(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
    } catch {
      setError('Could not copy to clipboard');
    }
  }

  const inputCls = 'w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-gray-950 focus:outline-none';
  const canCreateKey = keyForm.name.trim() && selectedScopeCount() > 0;

  return (
    <div className="space-y-6">
      <section className={`rounded-2xl border bg-white p-5 ${embedded ? 'border-indigo-100' : 'border-gray-200'}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-600">Advanced integrations</p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-gray-950">API keys and webhooks</h2>
            <p className="mt-1 max-w-3xl text-sm text-gray-500">
              Use this when a custom system needs direct API access or webhook events. For AapkaRider, AapkaWMS, AapkaPOS, or AapkaChat, connect the app first from Connected apps.
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-xl border border-gray-300 px-3 py-2 text-sm font-bold text-gray-700 hover:border-gray-950 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {GUIDE_STEPS.map(([number, title, body]) => (
          <div key={number} className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-950 text-sm font-black text-white">{number}</div>
            <h3 className="mt-3 text-sm font-black text-gray-950">{title}</h3>
            <p className="mt-1 text-xs leading-5 text-gray-500">{body}</p>
          </div>
        ))}
      </section>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-black text-gray-950">API keys</h3>
              <p className="mt-1 text-sm text-gray-500">Create one key per app so access can be revoked without breaking everything else.</p>
            </div>
          </div>

          {createdKey?.key && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold text-amber-900">Copy this API key now</p>
                  <p className="mt-1 text-xs text-amber-800">It is shown once. Store it in the connected app or password manager before leaving this page.</p>
                </div>
                <button type="button" onClick={() => setCreatedKey(null)} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-bold text-amber-900 hover:bg-amber-100">I copied it</button>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-white px-3 py-2 font-mono text-xs leading-5 text-gray-900">{createdKey.key}</code>
                <button type="button" onClick={() => copy(createdKey.key, 'API key copied.')} className="shrink-0 rounded-lg bg-gray-950 px-3 py-2 text-xs font-bold text-white">Copy key</button>
              </div>
            </div>
          )}

          <form onSubmit={createKey} className="mt-5 rounded-xl border border-gray-100 bg-gray-50 p-4">
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-gray-500">Choose a setup</p>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {KEY_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className="rounded-xl border border-gray-200 bg-white p-3 text-left hover:border-gray-950"
                  >
                    <span className="block text-sm font-black text-gray-950">{preset.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-gray-500">{preset.hint}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <label>
                <span className="mb-1 mt-4 block text-xs font-bold text-gray-600">Key name</span>
                <input className={inputCls} value={keyForm.name} onChange={(event) => setKeyForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <button type="submit" disabled={busy === 'key' || !canCreateKey} className="rounded-xl bg-gray-950 px-4 py-2 text-sm font-black text-white hover:bg-gray-800 disabled:opacity-40">
                {busy === 'key' ? 'Creating...' : 'Create key'}
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {['read', 'write'].map((action) => (
                <div key={action}>
                  <p className="mb-2 text-xs font-black uppercase text-gray-500">{action} scopes</p>
                  <div className="flex flex-wrap gap-2">
                    {SCOPE_RESOURCES.map((resource) => {
                      const active = (keyForm.scopes?.[action] || []).includes(resource.key);
                      return (
                        <button
                          key={`${action}:${resource.key}`}
                          type="button"
                          onClick={() => setScope(action, resource.key)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${active ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white text-gray-700'}`}
                        >
                          {resource.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {!selectedScopeCount() && <p className="mt-3 text-xs font-semibold text-red-600">Select at least one permission before creating a key.</p>}
          </form>

          <div className="mt-5 overflow-hidden rounded-xl border border-gray-200">
            {loading ? (
              <p className="p-8 text-center text-sm text-gray-500">Loading API keys...</p>
            ) : keys.length === 0 ? (
              <p className="p-8 text-center text-sm text-gray-500">No API keys yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Scopes</th>
                    <th className="px-4 py-3">Last used</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {keys.map((key) => (
                    <tr key={key.id}>
                      <td className="px-4 py-3">
                        <p className="font-bold text-gray-950">{key.name}</p>
                        <p className="font-mono text-xs text-gray-500">...{key.keyLast4}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(key.scopes || {}).flatMap(([action, resources]) => (
                            (resources || []).map((resource) => <Badge key={`${key.id}:${action}:${resource}`} tone={resource === 'deliveries' ? 'blue' : 'gray'}>{action}:{resource}</Badge>)
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{formatDate(key.lastUsedAt)}</td>
                      <td className="px-4 py-3 text-right">
                        {key.isActive ? (
                          <button type="button" disabled={busy === key.id} onClick={() => revokeKey(key.id)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50">
                            Revoke
                          </button>
                        ) : (
                          <Badge>Revoked</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h3 className="text-base font-black text-gray-950">API quick start</h3>
          <p className="mt-1 text-sm text-gray-500">Use Bearer authentication with the key you create here.</p>
          <div className="mt-4 space-y-3 text-sm">
            {QUICK_START_ENDPOINTS.map((endpoint) => (
              <div key={endpoint.value} className="rounded-xl border border-gray-200 p-3">
                <p className="text-xs font-black text-gray-500">{endpoint.label}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-lg bg-gray-950 px-3 py-2 text-xs text-white">{endpoint.value}</code>
                  {endpoint.copy && (
                    <button
                      type="button"
                      onClick={() => copy(endpoint.copy, 'Endpoint copied.')}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700 hover:border-gray-950"
                    >
                      Copy
                    </button>
                  )}
                </div>
              </div>
            ))}
            <div className="rounded-xl border border-gray-200 p-3">
              <p className="text-xs font-black text-gray-500">Recommended handoff scopes</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge tone="blue">write:deliveries</Badge>
                <Badge tone="blue">read:deliveries</Badge>
                <Badge>read:orders</Badge>
              </div>
            </div>
            <pre className="overflow-x-auto rounded-xl bg-gray-950 p-4 text-xs leading-6 text-gray-100">{`{
  "externalRef": "ORDER-10042",
  "locationId": "optional-branch-id",
  "customerName": "Priya Sharma",
  "customerPhone": "+91 90000 00000",
  "dropoff": {
    "line1": "12 Market Road",
    "city": "Delhi",
    "postalCode": "110001",
    "country": "IN"
  },
  "paymentMethod": "cod",
  "cashToCollectMinor": 49900
}`}</pre>
            <p className="text-xs text-gray-500">externalRef is idempotent for API delivery handoffs. If locationId is omitted, postalCode or dropoff coordinates resolve through delivery areas. The response includes trackingToken, trackingPath, and trackingUrl.</p>
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-black text-gray-950">Webhooks</h3>
            <p className="mt-1 text-sm text-gray-500">Send order and delivery events to another system when something changes.</p>
          </div>
        </div>

        <form onSubmit={createWebhook} className="mt-5 rounded-xl border border-gray-100 bg-gray-50 p-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <label>
              <span className="mb-1 block text-xs font-bold text-gray-600">Endpoint URL</span>
              <input className={inputCls} type="url" value={webhookForm.url} onChange={(event) => setWebhookForm((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/aapkarider/webhooks" />
            </label>
            <button type="submit" disabled={busy === 'webhook' || !webhookForm.url.trim() || webhookForm.events.length === 0} className="rounded-xl bg-gray-950 px-4 py-2 text-sm font-black text-white hover:bg-gray-800 disabled:opacity-40">
              {busy === 'webhook' ? 'Adding...' : 'Add endpoint'}
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {webhookEvents.map((event) => {
              const active = webhookForm.events.includes(event);
              return (
                <button
                  key={event}
                  type="button"
                  onClick={() => setWebhookEvent(event)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${active ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white text-gray-700'}`}
                >
                  {event}
                </button>
              );
            })}
          </div>
        </form>

        {createdWebhookSecret?.secret && (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-amber-900">Copy this webhook signing secret now</p>
                <p className="mt-1 text-xs text-amber-800">Your receiver uses this secret to verify that events really came from Sitepresso.</p>
              </div>
              <button type="button" onClick={() => setCreatedWebhookSecret(null)} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-bold text-amber-900 hover:bg-amber-100">I copied it</button>
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-white px-3 py-2 font-mono text-xs leading-5 text-gray-900">{createdWebhookSecret.secret}</code>
              <button type="button" onClick={() => copy(createdWebhookSecret.secret, 'Webhook signing secret copied.')} className="shrink-0 rounded-lg bg-gray-950 px-3 py-2 text-xs font-bold text-white">Copy secret</button>
            </div>
          </div>
        )}

        <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-black uppercase text-gray-500">Verify webhook signatures</p>
          <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
            <code className="block rounded-lg bg-gray-950 px-3 py-2 text-gray-100">X-Sitepresso-Signature-V2: t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>
            <code className="block rounded-lg bg-gray-950 px-3 py-2 text-gray-100">X-Sitepresso-Delivery-Id: &lt;delivery_attempt_id&gt;</code>
            <code className="block rounded-lg bg-gray-950 px-3 py-2 text-gray-100">X-Sitepresso-Timestamp: &lt;unix&gt;</code>
            <code className="block rounded-lg bg-gray-950 px-3 py-2 text-gray-100">base string: t.raw_body</code>
          </div>
          <p className="mt-3 text-xs text-gray-500">The older X-Sitepresso-Signature sha256 header is still sent for existing receivers.</p>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 text-xs font-black uppercase text-gray-500">Endpoints</div>
            {subscriptions.length === 0 ? (
              <p className="p-6 text-sm text-gray-500">No webhook endpoints yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {subscriptions.map((sub) => (
                  <div key={sub.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs font-bold text-gray-950">{sub.url}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(sub.events || []).map((event) => <Badge key={`${sub.id}:${event}`} tone={event.startsWith('delivery.') ? 'blue' : 'gray'}>{event}</Badge>)}
                        </div>
                        <p className="mt-2 text-xs text-gray-500">{sub._count?.deliveries || 0} webhook attempts</p>
                      </div>
                      <div className="flex shrink-0 flex-col gap-2">
                        <button type="button" disabled={busy === `test:${sub.id}`} onClick={() => testWebhook(sub.id)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                          {busy === `test:${sub.id}` ? 'Testing...' : 'Test'}
                        </button>
                        <button type="button" disabled={busy === sub.id} onClick={() => deleteWebhook(sub.id)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50">
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-gray-200">
            <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 text-xs font-black uppercase text-gray-500">Recent webhook attempts</div>
            {deliveries.length === 0 ? (
              <p className="p-6 text-sm text-gray-500">No webhook attempts yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {deliveries.slice(0, 12).map((delivery) => {
                  const status = String(delivery.status || '').toUpperCase();
                  const ok = status === 'SENT';
                  return (
                    <div key={delivery.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-gray-950">{delivery.event}</p>
                        <p className="text-xs text-gray-500">{formatDate(delivery.createdAt)} - {delivery.attempts || 0} attempts</p>
                        {delivery.subscriptionUrl && <p className="truncate font-mono text-[11px] text-gray-400">{delivery.subscriptionUrl}</p>}
                        {delivery.responseBody && <p className="mt-1 line-clamp-2 text-xs text-gray-500">{delivery.responseBody}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge tone={ok ? 'green' : 'red'}>{delivery.responseStatus || delivery.status}</Badge>
                        <button type="button" disabled={busy === `replay:${delivery.id}`} onClick={() => replayWebhookDelivery(delivery.id)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                          {busy === `replay:${delivery.id}` ? 'Replaying...' : 'Replay'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

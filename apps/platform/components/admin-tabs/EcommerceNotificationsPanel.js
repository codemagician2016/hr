'use client';

// Ecommerce notification centre.
//
// Store admins can see every platform-managed email/SMS/WhatsApp message
// that may be sent for their grocery store, and can enable/disable channels
// per event. Template wording is intentionally read-only: Sitepresso owns
// compliance copy and provider approvals.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  KpiCard, KpiGrid,
  StatusBadge, toneForStatus,
  PageHeader, EmptyState, ErrorBanner,
  fmtNumber,
} from '@/components/ecom-ui';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${res.status}`);
  return body;
}

const SAMPLE_VALUES = {
  ID: 'GR-2401',
  BIZ: 'FreshCart',
  AMT: 'GBP 42.80',
  LINK: 'https://shop.example/track/GR-2401',
  TIME: 'Today 5-7 PM',
  PRODUCT: 'Organic berries',
  ITEMS: '3 items',
  OFFER: '20% off fresh produce',
  CODE: 'FRESH20',
  EXPIRY: 'Sunday',
  DATE: 'Friday',
  EVENT: 'Weekend grocery offer',
  OTP: '123456',
  MIN: '10',
};

const CHANNELS = [
  { key: 'email', label: 'Email', db: 'emailEnabled' },
  { key: 'sms', label: 'SMS', db: 'smsEnabled' },
  { key: 'whatsapp', label: 'WhatsApp', db: 'whatsappEnabled' },
];
const NOTIFICATION_TABS = new Set(['templates', 'credits', 'deliveries']);

function fillSample(body) {
  return String(body || '').replace(/\{(\w+)\}/g, (_, key) => (
    SAMPLE_VALUES[key] !== undefined ? SAMPLE_VALUES[key] : `{${key}}`
  ));
}

function moneyUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function isChannelSupported(template, channel) {
  if (channel.db) return template[channel.db] === true;
  return false;
}

function channelEnabled(eventChannels, templateKey, channelKey) {
  const prefs = eventChannels?.[templateKey];
  if (!prefs || typeof prefs[channelKey] !== 'boolean') return true;
  return prefs[channelKey] === true;
}

function ChannelToggle({ label, checked, disabled, hint, onChange }) {
  return (
    <label className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${disabled ? 'border-gray-200 bg-gray-50 text-gray-400' : 'border-gray-200 bg-white text-gray-800'}`}>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{label}</span>
        {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded accent-emerald-600"
      />
    </label>
  );
}

function TemplateCard({ template, config, eventChannels, busyKey, onToggle }) {
  const preview = fillSample(template.body);
  const smsUnavailable = !config?.managedSmsEnabled;
  const whatsappUnavailable = !config?.managedWhatsappEnabled;
  const locked = template.category === 'AUTHENTICATION';

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900">{template.displayName}</h3>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-gray-500">
              {template.category}
            </span>
            {locked && <StatusBadge tone="success">required</StatusBadge>}
          </div>
          <p className="mt-1 text-xs font-mono text-gray-400">{template.templateKey}</p>
        </div>
        {busyKey === template.templateKey && (
          <span className="text-xs font-semibold text-indigo-600">Saving...</span>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
        <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-gray-500">Read-only message preview</p>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-800">{preview}</p>
      </div>

      {template.variables?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {template.variables.map((variable) => (
            <span key={variable} className="rounded-md bg-gray-100 px-2 py-1 text-[11px] font-mono text-gray-600">
              {`{${variable}}`}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-2 md:grid-cols-3">
        {CHANNELS.map((channel) => {
          const supported = isChannelSupported(template, channel);
          const enabled = supported && channelEnabled(eventChannels, template.templateKey, channel.key);
          const providerUnavailable =
            (channel.key === 'sms' && smsUnavailable) ||
            (channel.key === 'whatsapp' && whatsappUnavailable);
          const hint = !supported
            ? 'Not supported'
            : locked
              ? 'Required security message'
            : providerUnavailable
              ? 'Service not active yet'
              : enabled ? 'On for this event' : 'Off for this event';
          return (
            <ChannelToggle
              key={channel.key}
              label={channel.label}
              checked={enabled}
              disabled={locked || !supported || busyKey === template.templateKey}
              hint={hint}
              onChange={(value) => onToggle(template.templateKey, channel.key, value)}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function EcommerceNotificationsPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlSection = searchParams.get('section') || 'templates';
  const [tab, setTabValue] = useState(NOTIFICATION_TABS.has(urlSection) ? urlSection : 'templates');
  const [templates, setTemplates] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [summary, setSummary] = useState(null);
  const [credits, setCredits] = useState(null);
  const [configData, setConfigData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [buyingPack, setBuyingPack] = useState(0);
  const [error, setError] = useState('');

  const setTab = useCallback((nextTab) => {
    const safeTab = NOTIFICATION_TABS.has(nextTab) ? nextTab : 'templates';
    setTabValue(safeTab);
    const params = new URLSearchParams(searchParams.toString());
    if (safeTab === 'templates') params.delete('section');
    else params.set('section', safeTab);
    router.replace(params.toString() ? `?${params.toString()}` : window.location.pathname, { scroll: false });
  }, [router, searchParams]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [tplRes, delRes, sumRes, cfgRes, creditRes] = await Promise.all([
        api('/api/ecom/notifications/templates'),
        api('/api/ecom/notifications/deliveries?pageSize=50'),
        api('/api/ecom/notifications/summary'),
        api('/api/notification-config'),
        api('/api/ecom/notifications/credits'),
      ]);
      setTemplates(tplRes.rows || []);
      setDeliveries(delRes.rows || []);
      setSummary(sumRes);
      setConfigData(cfgRes);
      setCredits(creditRes);
    } catch (err) {
      setError(err.message || 'Could not load notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    setTabValue(NOTIFICATION_TABS.has(urlSection) ? urlSection : 'templates');
  }, [urlSection]);

  const config = configData?.config || null;
  const eventChannels = config?.eventChannels || {};

  const grouped = useMemo(() => templates.reduce((acc, template) => {
    const key = template.category || 'OTHER';
    if (!acc[key]) acc[key] = [];
    acc[key].push(template);
    return acc;
  }, {}), [templates]);

  const deliveryRatePct = summary?.deliveryRate7d != null ? Math.round(summary.deliveryRate7d * 100) : null;

  async function toggleChannel(templateKey, channel, value) {
    const next = {
      ...eventChannels,
      [templateKey]: {
        ...(eventChannels?.[templateKey] || {}),
        [channel]: value,
      },
    };
    setBusyKey(templateKey);
    setError('');
    try {
      await api('/api/notification-config/event-channels', {
        method: 'PUT',
        body: JSON.stringify({ eventChannels: next }),
      });
      await reload();
    } catch (err) {
      setError(err.message || 'Could not update notification preference');
    } finally {
      setBusyKey('');
    }
  }

  async function buyCreditPack(amountUsd) {
    setBuyingPack(amountUsd);
    setError('');
    try {
      const res = await api('/api/notification-config/buy-pack', {
        method: 'POST',
        body: JSON.stringify({ amountUsd }),
      });
      if (res?.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      await reload();
      setTab('credits');
    } catch (err) {
      setError(err.message || 'Could not buy credit pack');
    } finally {
      setBuyingPack(0);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        subtitle="View platform-managed email, SMS, and WhatsApp messages. Store admins can control channels, not edit compliance copy."
      />

      <KpiGrid cols={4}>
        <KpiCard label="Sent · 24h" value={fmtNumber(summary?.sent24h)} />
        <KpiCard label="Sent · 7d" value={fmtNumber(summary?.sent7d)} />
        <KpiCard label="Authentication · 7d" value={fmtNumber(summary?.authentication7d)} hint="OTP + verification/security" />
        <KpiCard label="Credit left" value={moneyUsd(credits?.balance?.remainingUsd)} hint={`${fmtNumber(credits?.balance?.smsRemaining)} SMS or ${fmtNumber(credits?.balance?.whatsappRemaining)} WhatsApp left`} />
        <KpiCard
          label="Delivery rate · 7d"
          value={deliveryRatePct != null ? `${deliveryRatePct}%` : '-'}
          tone={deliveryRatePct != null && deliveryRatePct >= 95 ? 'success' : deliveryRatePct != null && deliveryRatePct < 80 ? 'warning' : null}
        />
        <KpiCard label="Failed · 7d" value={fmtNumber(summary?.failedCount7d)} tone={summary?.failedCount7d > 0 ? 'warning' : null} />
      </KpiGrid>

      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-900">Channel access</p>
            <p className="text-xs text-gray-500">Email is available now. SMS and WhatsApp can be enabled by Sitepresso after compliance setup.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="success">Email active</StatusBadge>
            <StatusBadge tone={config?.managedSmsEnabled ? 'success' : 'warning'}>SMS {config?.managedSmsEnabled ? 'active' : 'not active'}</StatusBadge>
            <StatusBadge tone={config?.managedWhatsappEnabled ? 'success' : 'warning'}>WhatsApp {config?.managedWhatsappEnabled ? 'active' : 'not active'}</StatusBadge>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3">
        <span className="text-[11px] font-mono uppercase tracking-widest text-gray-500">View</span>
        <div className="flex gap-1 rounded-lg bg-gray-100 p-0.5">
          {[
            { key: 'templates', label: 'Messages' },
            { key: 'credits', label: 'Credits & expense' },
            { key: 'deliveries', label: 'Send history' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`rounded-md px-4 py-1.5 text-sm font-semibold transition-colors ${tab === item.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {tab === 'credits' && (
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <p className="text-[11px] font-mono uppercase tracking-widest text-gray-500">Monthly credit</p>
              <p className="mt-2 text-3xl font-bold text-gray-900">{moneyUsd(credits?.balance?.budgetUsd)}</p>
              <p className="mt-1 text-xs text-gray-500">Plan allowance plus purchased top-ups</p>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <p className="text-[11px] font-mono uppercase tracking-widest text-gray-500">Spent</p>
              <p className="mt-2 text-3xl font-bold text-gray-900">{moneyUsd(credits?.balance?.spentUsd)}</p>
              <p className="mt-1 text-xs text-gray-500">SMS and WhatsApp provider cost</p>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <p className="text-[11px] font-mono uppercase tracking-widest text-gray-500">Remaining</p>
              <p className="mt-2 text-3xl font-bold text-emerald-700">{moneyUsd(credits?.balance?.remainingUsd)}</p>
              <p className="mt-1 text-xs text-gray-500">Current cycle {credits?.currentCycle || '-'}</p>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <p className="text-[11px] font-mono uppercase tracking-widest text-gray-500">Top-ups bought</p>
              <p className="mt-2 text-3xl font-bold text-gray-900">{moneyUsd(credits?.balance?.overagePurchasedUsd)}</p>
              <p className="mt-1 text-xs text-gray-500">Added to this month</p>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Buy more messaging credit</h3>
                <p className="mt-1 text-sm text-gray-500">Credit is used only for paid SMS and WhatsApp sends. It applies after secure Paddle checkout confirms payment.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {[5, 20, 50].map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    onClick={() => buyCreditPack(amount)}
                    disabled={buyingPack > 0}
                    className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {buyingPack === amount ? 'Buying...' : `Buy $${amount}`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-5 py-4">
                <h3 className="text-base font-semibold text-gray-900">Monthly expense history</h3>
                <p className="mt-1 text-xs text-gray-500">One row per billing cycle.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-left text-[10px] font-mono uppercase tracking-[0.18em] text-gray-500">
                      <th className="px-4 py-3">Cycle</th>
                      <th className="px-4 py-3">Messages</th>
                      <th className="px-4 py-3">Spent</th>
                      <th className="px-4 py-3">Top-up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(credits?.cycles || []).map((cycle) => (
                      <tr key={cycle.cycle} className="border-t border-gray-100">
                        <td className="px-4 py-3 font-semibold text-gray-900">{cycle.cycle}</td>
                        <td className="px-4 py-3 text-gray-600">{fmtNumber(cycle.messageCount)}</td>
                        <td className="px-4 py-3 text-gray-900">{moneyUsd(cycle.spentUsd)}</td>
                        <td className="px-4 py-3 text-gray-600">{moneyUsd(cycle.overagePurchasedUsd)}</td>
                      </tr>
                    ))}
                    {(!credits?.cycles || credits.cycles.length === 0) && (
                      <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">No credit usage yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-5 py-4">
                <h3 className="text-base font-semibold text-gray-900">Credit ledger</h3>
                <p className="mt-1 text-xs text-gray-500">Recent paid sends and purchased credit.</p>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {(credits?.transactions || []).map((entry) => (
                  <div key={entry.id} className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900">
                        {entry.type === 'CREDIT_TOPUP' ? 'Credit top-up' : (entry.template?.displayName || entry.channel)}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {entry.type === 'CREDIT_TOPUP'
                          ? `Cycle ${entry.cycle}`
                          : `${entry.channel} · ${entry.provider || 'provider'} · ${entry.triggeredBy || 'send'}`}
                      </p>
                      <p className="mt-0.5 text-[11px] text-gray-400">{entry.createdAt ? new Date(entry.createdAt).toLocaleString('en-GB') : '-'}</p>
                    </div>
                    <p className={`shrink-0 text-sm font-bold ${entry.type === 'CREDIT_TOPUP' ? 'text-emerald-700' : 'text-gray-900'}`}>
                      {entry.type === 'CREDIT_TOPUP' ? '+' : '-'}{moneyUsd(entry.amountUsd)}
                    </p>
                  </div>
                ))}
                {(!credits?.transactions || credits.transactions.length === 0) && (
                  <div className="px-5 py-10 text-center text-sm text-gray-500">No credit ledger entries yet.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'templates' && (
        loading && templates.length === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">Loading...</div>
        ) : templates.length === 0 ? (
          <EmptyState title="No messages yet" message="Message templates are seeded by the backend on startup." />
        ) : (
          Object.keys(grouped).sort().map((category) => (
            <section key={category} className="space-y-3">
              <h2 className="text-[11px] font-mono uppercase tracking-[0.22em] text-gray-500">{category.replace(/_/g, ' ')}</h2>
              <div className="grid gap-4">
                {grouped[category].map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    config={config}
                    eventChannels={eventChannels}
                    busyKey={busyKey}
                    onToggle={toggleChannel}
                  />
                ))}
              </div>
            </section>
          ))
        )
      )}

      {tab === 'deliveries' && (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          {loading && deliveries.length === 0 ? (
            <div className="p-12 text-center text-sm text-gray-500">Loading...</div>
          ) : deliveries.length === 0 ? (
            <EmptyState title="No deliveries yet" message="Send history appears after customer messages start flowing." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-left text-[10px] font-mono uppercase tracking-[0.18em] text-gray-500">
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Channel</th>
                    <th className="px-4 py-3">Recipient</th>
                    <th className="px-4 py-3">Message</th>
                    <th className="px-4 py-3">Trigger</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => (
                    <tr key={delivery.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 text-xs text-gray-500">{new Date(delivery.createdAt).toLocaleString('en-GB')}</td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-700">{delivery.channel}</td>
                      <td className="px-4 py-3 text-xs">{delivery.recipientPhone || delivery.recipientEmail || '-'}</td>
                      <td className="px-4 py-3 text-xs">{delivery.template?.displayName || delivery.template?.templateKey || '-'}</td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-500">{delivery.triggeredBy}</td>
                      <td className="px-4 py-3"><StatusBadge tone={toneForStatus(delivery.status)}>{delivery.status.toLowerCase().replace(/_/g, ' ')}</StatusBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

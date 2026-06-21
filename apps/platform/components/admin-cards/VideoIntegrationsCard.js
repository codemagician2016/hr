'use client';

// Video meeting integrations card (Settings → Video meetings sub-tab).
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useEffect, useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner } from '@/components/admin-ui';

function VideoIntegrationsCard() {
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState(null);

  async function load() {
    try {
      const { providers: data } = await api('/api/business/integrations');
      setProviders(data);
    } catch (e) {
      setError(e?.data?.message || e.message);
    }
  }
  useEffect(() => { load(); }, []);

  // After the OAuth callback we redirect the user back to /__connect/done
  // (a static helper page) which posts back here via window.opener — for
  // now we just refresh on focus so the new "connected" state appears
  // when the user returns to this tab.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  async function connect(key) {
    setBusyKey(key);
    setError('');
    try {
      const { url } = await api(`/api/business/integrations/${key}/connect`, { method: 'POST' });
      // Open in a new window so the admin can continue using the app
      // while they grant permission. Provider redirects back to our
      // backend callback which redirects to /__connect/done.
      window.open(url, '_blank', 'width=600,height=720');
    } catch (e) {
      setError(e?.data?.message || e.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function disconnect(key) {
    if (!window.confirm('Disconnect this provider? Future bookings won’t auto-create meeting links until you reconnect.')) return;
    setBusyKey(key);
    setError('');
    try {
      await api(`/api/business/integrations/${key}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e?.data?.message || e.message);
    } finally {
      setBusyKey(null);
    }
  }

  if (!providers) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <p className="text-sm text-gray-500">Loading integrations…</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Video meetings</h2>
        <p className="text-sm text-gray-500 mt-1">
          Connect a provider so virtual appointments auto-create a meeting link. Customers see the link in booking emails and their dashboard. Connect more than one if different staff use different tools.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {providers.map((p) => {
          const connected = p.connection?.status === 'ACTIVE';
          const expired = p.connection?.status === 'EXPIRED';
          const enabled = p.isConfigured;
          const busy = busyKey === p.key;
          return (
            <div
              key={p.key}
              className="rounded-xl border border-gray-200 p-4 flex flex-col gap-3"
              style={{ borderTopColor: p.brandColor, borderTopWidth: 3 }}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-gray-900">{p.displayName}</p>
                {connected && <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">Connected</span>}
                {expired && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Expired</span>}
              </div>
              {connected && p.connection?.externalAccountEmail && (
                <p className="text-[12px] text-gray-500 truncate" title={p.connection.externalAccountEmail}>
                  {p.connection.externalAccountEmail}
                </p>
              )}
              {!connected && (
                <p className="text-[12px] text-gray-500 leading-snug">
                  {enabled
                    ? 'Click Connect to authorise meetings on your behalf.'
                    : 'Not yet enabled on this server. Coming soon.'}
                </p>
              )}
              <div className="mt-auto pt-2">
                {connected ? (
                  <button
                    type="button"
                    onClick={() => disconnect(p.key)}
                    disabled={busy}
                    className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
                  >
                    {busy ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => connect(p.key)}
                    disabled={!enabled || busy}
                    className="w-full px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: enabled ? p.brandColor : '#9ca3af' }}
                  >
                    {busy ? 'Opening…' : enabled ? 'Connect' : 'Not enabled'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


export default VideoIntegrationsCard;

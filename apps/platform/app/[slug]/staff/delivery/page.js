'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

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

function money(minor, currency = 'USD') {
  if (minor == null) return '-';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(minor) / 100);
  } catch {
    return `${currency} ${(Number(minor) / 100).toFixed(2)}`;
  }
}

function addressFor(stop) {
  const orderAddress = stop.order?.shippingAddress || {};
  return [
    stop.addressLine1 || orderAddress.line1,
    stop.addressLine2 || orderAddress.line2,
    stop.city || orderAddress.city,
    stop.postalCode || orderAddress.postalCode,
  ].filter(Boolean).join(', ');
}

function statusTone(status) {
  if (status === 'DELIVERED') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (status === 'ARRIVED') return 'border-blue-200 bg-blue-50 text-blue-800';
  if (status === 'ATTEMPTED_FAILED' || status === 'SKIPPED') return 'border-amber-200 bg-amber-50 text-amber-800';
  return 'border-gray-200 bg-gray-50 text-gray-700';
}

function cashSummaryFromRoutes(routes = []) {
  return routes.reduce((summary, route) => {
    const cash = route.cashSummary || {};
    summary.routes += 1;
    summary.stops += cash.stopCount || route.stops?.length || 0;
    summary.delivered += cash.deliveredStops || 0;
    summary.closedStops += cash.closedStops || 0;
    summary.codStops += cash.codStops || 0;
    summary.onlineStops += cash.onlineStops || 0;
    summary.toCollectMinor += cash.cashToCollectMinor || route.cashToCollectMinor || 0;
    summary.collectedMinor += cash.cashCollectedMinor || route.cashCollectedMinor || 0;
    summary.receivedMinor += cash.cashReceivedMinor || 0;
    summary.changeDueMinor += cash.cashChangeDueMinor || 0;
    summary.pendingCashMinor += cash.pendingCashMinor || 0;
    return summary;
  }, {
    routes: 0,
    stops: 0,
    delivered: 0,
    closedStops: 0,
    codStops: 0,
    onlineStops: 0,
    toCollectMinor: 0,
    collectedMinor: 0,
    receivedMinor: 0,
    changeDueMinor: 0,
    pendingCashMinor: 0,
  });
}

function CashStat({ label, value, hint, tone = 'gray' }) {
  const toneClass = tone === 'green' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : 'text-gray-950';
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p className="text-xs font-bold text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-black ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] font-medium text-gray-500">{hint}</p>}
    </div>
  );
}

function AccessState({ title, message }) {
  return (
    <main className="min-h-screen bg-[#f6f7f4] px-5 py-10">
      <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <p className="text-lg font-bold text-gray-950">{title}</p>
        <p className="mt-2 text-sm text-gray-500">{message}</p>
      </div>
    </main>
  );
}

function Header({ businessName, rider, mobileHref, onLogout }) {
  const initials = (rider?.fullName || rider?.name || 'R').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return (
    <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-sm font-black text-white">{initials}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-gray-950">{businessName || 'Store delivery'}</p>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-700">Rider workspace</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href={mobileHref} className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700 hover:border-emerald-300 hover:text-emerald-700">
            Mobile view
          </a>
          <button type="button" onClick={onLogout} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-100">
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function StopCard({ stop, index, busy, onAction }) {
  const [showProof, setShowProof] = useState(false);
  const [notes, setNotes] = useState(stop.notes || '');
  const [proofPhotoUrl, setProofPhotoUrl] = useState(stop.proofPhotoUrl || '');
  const [proofSignatureUrl, setProofSignatureUrl] = useState(stop.proofSignatureUrl || '');
  const [cashReceived, setCashReceived] = useState(stop.cashReceivedMinor ? String((stop.cashReceivedMinor / 100).toFixed(2)) : '');
  const [cashChange, setCashChange] = useState(stop.cashChangeDueMinor ? String((stop.cashChangeDueMinor / 100).toFixed(2)) : '');
  const [paymentReference, setPaymentReference] = useState(stop.paymentReference || stop.order?.paymentRef || '');
  const [paymentNote, setPaymentNote] = useState(stop.paymentNote || '');
  const [localError, setLocalError] = useState('');
  const addr = addressFor(stop);
  const tel = stop.order?.customerPhone ? `tel:${String(stop.order.customerPhone).replace(/\s+/g, '')}` : null;
  const maps = addr ? `https://www.google.com/maps/search/${encodeURIComponent(addr)}` : null;
  const delivered = stop.status === 'DELIVERED';
  const closed = delivered || stop.status === 'ATTEMPTED_FAILED' || stop.status === 'SKIPPED';
  const needsCashCollection = stop.order?.paymentMethod === 'cod' && !stop.order?.paidAt;
  const orderTotalMinor = Number(stop.order?.totalMinor || 0);
  const currency = stop.order?.currency || 'USD';
  const cashReceivedMinor = Math.max(0, Math.round(Number(cashReceived || 0) * 100));
  const cashChangeDueMinor = Math.max(0, Math.round(Number(cashChange || 0) * 100));
  const impliedChangeMinor = needsCashCollection && cashReceivedMinor > orderTotalMinor
    ? cashReceivedMinor - orderTotalMinor
    : 0;
  const netCashMinor = needsCashCollection
    ? Math.max(0, (cashReceivedMinor || orderTotalMinor) - (cashChangeDueMinor || impliedChangeMinor))
    : 0;
  const proofPayload = {
    notes: notes.trim() || undefined,
    proofPhotoUrl: proofPhotoUrl.trim() || undefined,
    proofSignatureUrl: proofSignatureUrl.trim() || undefined,
    paymentReference: paymentReference.trim() || undefined,
    paymentNote: paymentNote.trim() || undefined,
  };

  function markDelivered() {
    setLocalError('');
    if (needsCashCollection && cashReceivedMinor > 0 && netCashMinor < orderTotalMinor) {
      setLocalError(`Net cash after change must be at least ${money(orderTotalMinor, currency)}.`);
      setShowProof(true);
      return;
    }
    onAction(stop, 'DELIVERED', {
      ...(needsCashCollection ? {
        cashReceivedMinor: cashReceivedMinor || orderTotalMinor,
        cashChangeDueMinor: cashChangeDueMinor || impliedChangeMinor,
        cashCollectedMinor: cashReceivedMinor ? netCashMinor : orderTotalMinor,
      } : {}),
      ...proofPayload,
    });
  }

  function markFailed() {
    if (!notes.trim()) {
      setLocalError('Add a reason before marking the attempt failed.');
      setShowProof(true);
      return;
    }
    setLocalError('');
    onAction(stop, 'ATTEMPTED_FAILED', proofPayload);
  }

  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-950 text-sm font-black text-white">{index + 1}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-gray-950">{stop.order?.customerName || 'Customer'}</p>
            <p className="mt-0.5 text-xs text-gray-500">{addr || 'Address not available'}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${statusTone(stop.status)}`}>
          {String(stop.status || 'PENDING').replace(/_/g, ' ')}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-xl bg-gray-50 p-3">
          <p className="font-semibold text-gray-500">Items</p>
          <p className="mt-1 font-black text-gray-950">{stop.order?.items?.length || 0}</p>
        </div>
        <div className="rounded-xl bg-gray-50 p-3">
          <p className="font-semibold text-gray-500">Total</p>
          <p className="mt-1 font-black text-gray-950">{money(stop.order?.totalMinor, stop.order?.currency)}</p>
        </div>
        <div className="rounded-xl bg-gray-50 p-3">
          <p className="font-semibold text-gray-500">Payment</p>
          <p className="mt-1 font-black text-gray-950">{needsCashCollection ? 'COD due' : 'Paid online'}</p>
        </div>
      </div>

      {needsCashCollection ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700">Cash collection</p>
              <p className="mt-1 text-sm font-black text-amber-950">Collect {money(orderTotalMinor, currency)}</p>
            </div>
            <p className="rounded-full bg-white px-3 py-1 text-xs font-black text-amber-800">
              In hand {money(netCashMinor || stop.cashCollectedMinor || 0, currency)}
            </p>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="text-xs font-bold text-amber-900">
              Cash received
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashReceived}
                onChange={(e) => {
                  setCashReceived(e.target.value);
                  const receivedMinor = Math.max(0, Math.round(Number(e.target.value || 0) * 100));
                  if (receivedMinor > orderTotalMinor) setCashChange(((receivedMinor - orderTotalMinor) / 100).toFixed(2));
                }}
                disabled={closed || busy}
                placeholder={(orderTotalMinor / 100).toFixed(2)}
                className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm font-bold text-gray-950 focus:border-amber-500 focus:outline-none disabled:bg-amber-100/60"
              />
            </label>
            <label className="text-xs font-bold text-amber-900">
              Change returned
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashChange}
                onChange={(e) => setCashChange(e.target.value)}
                disabled={closed || busy}
                placeholder={impliedChangeMinor ? (impliedChangeMinor / 100).toFixed(2) : '0.00'}
                className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm font-bold text-gray-950 focus:border-amber-500 focus:outline-none disabled:bg-amber-100/60"
              />
            </label>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-700">Online payment</p>
          <p className="mt-1 text-sm font-semibold text-emerald-950">
            {stop.order?.paymentProvider || 'Gateway'} {stop.order?.paymentRef ? `· ${stop.order.paymentRef}` : 'paid before delivery'}
          </p>
          {!closed && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-bold text-emerald-900">
                Transaction/reference
                <input
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  disabled={busy}
                  placeholder="UPI/card/ref shown by customer"
                  className="mt-1 w-full rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-gray-950 focus:border-emerald-500 focus:outline-none"
                />
              </label>
              <label className="text-xs font-bold text-emerald-900">
                Payment note
                <input
                  value={paymentNote}
                  onChange={(e) => setPaymentNote(e.target.value)}
                  disabled={busy}
                  placeholder="Any payment exception or note"
                  className="mt-1 w-full rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-gray-950 focus:border-emerald-500 focus:outline-none"
                />
              </label>
            </div>
          )}
        </div>
      )}

      {stop.order?.items?.length > 0 && (
        <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50 p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-500">Bags</p>
          <p className="mt-1 text-xs text-gray-700">
            {stop.order.items.slice(0, 4).map((item) => `${item.quantity}x ${item.name}`).join(' | ')}
          </p>
        </div>
      )}

      {(showProof || closed) && (
        <div className="mt-3 rounded-xl border border-gray-100 bg-white p-3">
          <div className="grid gap-2">
            <label className="text-xs font-bold text-gray-700">
              Delivery note
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={closed || busy}
                rows={2}
                placeholder="Door code, left with reception, customer refused, no answer..."
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-900 focus:border-emerald-500 focus:outline-none disabled:bg-gray-50"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-bold text-gray-700">
                Photo proof URL
                <input
                  value={proofPhotoUrl}
                  onChange={(e) => setProofPhotoUrl(e.target.value)}
                  disabled={closed || busy}
                  placeholder="https://..."
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-900 focus:border-emerald-500 focus:outline-none disabled:bg-gray-50"
                />
              </label>
              <label className="text-xs font-bold text-gray-700">
                Signature URL
                <input
                  value={proofSignatureUrl}
                  onChange={(e) => setProofSignatureUrl(e.target.value)}
                  disabled={closed || busy}
                  placeholder="https://..."
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-900 focus:border-emerald-500 focus:outline-none disabled:bg-gray-50"
                />
              </label>
            </div>
          </div>
          {localError && <p className="mt-2 text-xs font-bold text-red-700">{localError}</p>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {tel && <a className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-bold text-gray-800" href={tel}>Call</a>}
        {maps && <a className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-bold text-gray-800" href={maps} target="_blank" rel="noreferrer">Maps</a>}
        {!closed && (
          <button type="button" onClick={() => setShowProof((v) => !v)}
            className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-bold text-gray-800">
            {showProof ? 'Hide proof' : 'Proof / note'}
          </button>
        )}
        {!closed && stop.status !== 'ARRIVED' && (
          <button type="button" disabled={busy} onClick={() => onAction(stop, 'ARRIVED')}
            className="ml-auto rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-800 disabled:opacity-50">
            Arrived
          </button>
        )}
        {!closed && (
          <button
            type="button"
            disabled={busy}
            onClick={markDelivered}
            className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
            {needsCashCollection ? `Collect ${money(orderTotalMinor, currency)} & deliver` : 'Delivered'}
          </button>
        )}
        {!closed && (
          <button type="button" disabled={busy} onClick={markFailed}
            className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 disabled:opacity-50">
            Attempt failed
          </button>
        )}
      </div>
    </article>
  );
}

export default function RiderDeliveryPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params?.slug;
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [tenant, setTenant] = useState(null);
  const [rider, setRider] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [busyStopId, setBusyStopId] = useState(null);

  const mobileHref = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    return `/${slug}/staff/delivery?mode=mobile`;
  }, [slug]);

  const load = useCallback(async () => {
    try {
      const [{ user }, tenantRes, riderRes, routesRes] = await Promise.all([
        api('/api/auth/me'),
        api(`/api/tenant/resolve?slug=${encodeURIComponent(slug)}`),
        api('/api/ecom/rider/me'),
        api('/api/ecom/rider/routes?includeCompleted=true'),
      ]);
      if (!['STAFF', 'BUSINESS_ADMIN'].includes(user?.role)) {
        setError('Delivery rider access is required.');
        setStatus('forbidden');
        return;
      }
      if (tenantRes?.business?.id && user.businessId && tenantRes.business.id !== user.businessId) {
        setError('This rider account belongs to a different business.');
        setStatus('forbidden');
        return;
      }
      setTenant(tenantRes);
      setRider(riderRes.rider);
      setRoutes(routesRes.routes || []);
      setStatus('ready');
    } catch (err) {
      if (err.status === 401) {
        router.replace(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      setError(err.message || 'Unable to load rider workspace.');
      setStatus('forbidden');
    }
  }, [router, slug]);

  useEffect(() => {
    if (slug) load();
  }, [load, slug]);

  const activeRoute = routes.find((route) => route.status !== 'COMPLETED') || routes[0] || null;
  const stops = activeRoute?.stops || [];
  const deliveredCount = stops.filter((stop) => stop.status === 'DELIVERED').length;
  const remainingCount = Math.max(0, stops.length - deliveredCount);
  const routeSummary = activeRoute?.cashSummary || cashSummaryFromRoutes(activeRoute ? [activeRoute] : []);
  const daySummary = cashSummaryFromRoutes(routes);
  const currency = stops.find((stop) => stop.order?.currency)?.order?.currency || 'USD';

  async function updateStop(stop, nextStatus, extra = {}) {
    if (!activeRoute) return;
    setBusyStopId(stop.id);
    setError('');
    try {
      await api(`/api/ecom/rider/routes/${activeRoute.id}/stops/${stop.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: nextStatus, ...extra }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Failed to update stop');
    } finally {
      setBusyStopId(null);
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // If the session already expired, still take the rider back to login.
    }
    router.replace(`/login?redirect=${encodeURIComponent(`/${slug}/staff/delivery`)}`);
  }

  if (status === 'loading') return <AccessState title="Loading rider workspace" message="Checking your shift, routes, and assigned stops." />;
  if (status === 'forbidden') return <AccessState title="Delivery access needed" message={error} />;

  return (
    <div className="min-h-screen bg-[#f6f7f4]">
      <Header businessName={tenant?.business?.name} rider={rider} mobileHref={mobileHref} onLogout={logout} />
      <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
        <section className="rounded-3xl bg-gray-950 p-6 text-white shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-300">Today route</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">Hi {rider?.fullName?.split(' ')[0] || 'Rider'}, {remainingCount} stop{remainingCount === 1 ? '' : 's'} left.</h1>
          <p className="mt-2 text-sm text-gray-300">
            {activeRoute ? `${activeRoute.code} from ${activeRoute.location?.name || 'dispatch'}${routeSummary.cashToCollectMinor ? ` | ${money(routeSummary.cashToCollectMinor, currency)} COD` : ''}` : 'No route assigned yet.'}
          </p>
        </section>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{error}</div>}

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <CashStat label="Stops" value={stops.length} hint={`${remainingCount} left`} />
          <CashStat label="Delivered" value={deliveredCount} tone="green" hint={`${routeSummary.closedStops || deliveredCount} closed`} />
          <CashStat label="COD due" value={money(routeSummary.pendingCashMinor || routeSummary.cashToCollectMinor || 0, currency)} tone="amber" hint={`${routeSummary.codStops || 0} COD stops`} />
          <CashStat label="Cash in hand" value={money(daySummary.collectedMinor || daySummary.receivedMinor - daySummary.changeDueMinor || 0, currency)} tone="green" hint={`Change ${money(daySummary.changeDueMinor || 0, currency)}`} />
          <CashStat label="Online paid" value={routeSummary.onlineStops || 0} hint="Stops with no cash due" />
        </section>

        {!activeRoute ? (
          <section className="rounded-2xl border border-gray-200 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-bold text-gray-950">No assigned delivery route</p>
            <p className="mt-2 text-sm text-gray-500">When dispatch assigns a route to you, the stop list will appear here automatically.</p>
          </section>
        ) : (
          <section className="space-y-3">
            {stops.map((stop, index) => (
              <StopCard key={stop.id} stop={stop} index={index} busy={busyStopId === stop.id} onAction={updateStop} />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

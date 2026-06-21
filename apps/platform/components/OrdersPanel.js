'use client';

// E-commerce admin Orders panel.
// Mounted at /<slug>/admin?tab=orders when Business.vertical === 'ECOMMERCE'.
// Lets the admin: list orders, filter by status, view detail, transition
// status (PENDING → PAID → PACKING → OUT_FOR_DELIVERY → DELIVERED).

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { DEFAULT_CURRENCY } from '@/lib/currency';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import { useEcomAccess } from '@/components/EcomAccessContext';

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
    err.allowedTransitions = body.allowedTransitions;
    throw err;
  }
  return body;
}

const STATUS_BADGE = {
  PENDING: 'bg-amber-100 text-amber-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  PACKING: 'bg-blue-100 text-blue-800',
  OUT_FOR_DELIVERY: 'bg-indigo-100 text-indigo-800',
  READY_FOR_PICKUP: 'bg-emerald-100 text-emerald-800',
  DELIVERED: 'bg-emerald-100 text-emerald-800',
  PICKED_UP: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-200 text-gray-700',
  REFUNDED: 'bg-purple-100 text-purple-800',
  FAILED: 'bg-red-100 text-red-800',
};

function formatPrice(minor, currency) {
  if (minor === undefined || minor === null) return '';
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency || DEFAULT_CURRENCY,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${currency || ''} ${minor / 100}`;
  }
}

function isCheckedInRider(rider) {
  return Array.isArray(rider?.shifts) && rider.shifts.some((shift) => String(shift?.status || '').toUpperCase() === 'OPEN');
}

function formatDate(dt) {
  if (!dt) return '';
  try {
    return new Date(dt).toLocaleString();
  } catch {
    return '';
  }
}

function formatRefreshTime(dt) {
  if (!dt) return '';
  try {
    return new Date(dt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function minutesSince(dt) {
  if (!dt) return null;
  const time = new Date(dt).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 60000));
}

function compactAge(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function toTitleCase(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function PaymentBadge({ method, status, paidAt }) {
  if (!method) return null;
  const isCod = method === 'cod';
  const paid = isCod
    ? !!paidAt || ['PAID', 'REFUNDED'].includes(status)
    : ['PAID', 'PACKING', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'DELIVERED', 'PICKED_UP', 'REFUNDED'].includes(status);
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
      isCod
        ? paid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
        : 'bg-blue-100 text-blue-800'
    }`}>
      {isCod ? `COD${paid ? ' · paid' : ' · collect'}` : 'Online'}
    </span>
  );
}

function FulfillmentBadge({ type }) {
  const isPickup = type === 'PICKUP';
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${isPickup ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-700'}`}>
      {isPickup ? '🏬 Pickup' : '🚚 Delivery'}
    </span>
  );
}

function OrderDetail({ order, onClose, onChange, canEdit }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [allowed, setAllowed] = useState([]);
  const [events, setEvents] = useState(null); // null = loading, [] = empty
  const [picklist, setPicklist] = useState(null);
  const [pickBusy, setPickBusy] = useState(false);
  const [scanCode, setScanCode] = useState('');
  const [pickupCodeInput, setPickupCodeInput] = useState('');
  const [nextPickStatus, setNextPickStatus] = useState(null);
  const [weightDrafts, setWeightDrafts] = useState({}); // orderItemId -> grams string
  const [subDraft, setSubDraft] = useState(null); // { itemId, name, price, qty } | null
  const [proofPhotoUrl, setProofPhotoUrl] = useState('');
  const [proofNote, setProofNote] = useState('');
  const [proofUploading, setProofUploading] = useState(false);

  const STATUS_LABELS = {
    PENDING: 'Pending', PAID: 'Mark paid', PACKING: 'Start packing',
    OUT_FOR_DELIVERY: 'Send out for delivery', DELIVERED: 'Mark delivered',
    READY_FOR_PICKUP: 'Mark ready for pickup', PICKED_UP: 'Mark picked up',
    CANCELLED: 'Cancel', REFUNDED: 'Mark refunded', FAILED: 'Mark failed',
  };

  async function transition(next) {
    if (next === 'CANCELLED' && !window.confirm(`Cancel order ${order.code || order.id.slice(0, 8)}? This releases reserved stock and cannot be undone from this screen.`)) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await api(`/api/ecom/orders/${order.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({
          status: next,
          locationId: order.locationId || null,
          ...(next === 'PICKED_UP' && pickupCodeInput.trim() ? { pickupCode: pickupCodeInput.trim() } : {}),
          ...(['DELIVERED', 'PICKED_UP'].includes(next) && (proofPhotoUrl || proofNote.trim())
            ? { proofPhotoUrl: proofPhotoUrl || undefined, proofNote: proofNote.trim() || undefined }
            : {}),
        }),
      });
      onChange?.(data.order);
      setAllowed([]);
    } catch (err) {
      setError(err.message);
      if (err.allowedTransitions) setAllowed(err.allowedTransitions);
    } finally {
      setBusy(false);
    }
  }

  // Capture a proof-of-delivery photo: read the file as a data URL and upload
  // it via the shared image endpoint, storing the returned CDN URL. If image
  // hosting isn't configured (501) we fall back to a note-only proof.
  async function handleProofFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setProofUploading(true);
    setError('');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/upload/image', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, scope: 'pod' }),
      });
      if (res.status === 501) {
        setError('Photo hosting is off on this server — add a note instead.');
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) throw new Error(body.message || 'Upload failed');
      setProofPhotoUrl(body.url);
    } catch (err) {
      setError(err.message || 'Could not upload the photo');
    } finally {
      setProofUploading(false);
    }
  }

  // Fetch events on mount; reset when the order changes.
  useEffect(() => {
    setAllowed([]);
    setEvents(null);
    const qs = order.locationId ? `?locationId=${encodeURIComponent(order.locationId)}` : '';
    api(`/api/ecom/orders/${order.id}/events${qs}`)
      .then((data) => setEvents(data.events || []))
      .catch(() => setEvents([]));
    api(`/api/ecom/orders/${order.id}/picklist${qs}`)
      .then((data) => {
        setPicklist(data.picklist || null);
        setNextPickStatus(data.nextStatus || null);
      })
      .catch(() => {
        setPicklist(null);
        setNextPickStatus(null);
      });
  }, [order.id, order.locationId, order.updatedAt]);

  const addr = order.shippingAddress || {};
  const canPickPaidOrder = order.status === 'PAID' && order.paymentMethod !== 'cod';
  const showPicklist = canEdit && (['PENDING', 'PACKING'].includes(order.status) || canPickPaidOrder);
  const showConfirmPicked = showPicklist && picklist?.complete && !picklist?.confirmed;
  const needsPickupCode = order.fulfillmentType === 'PICKUP' && order.status === 'READY_FOR_PICKUP' && order.pickupCode;
  const pickupCodeMatches = !needsPickupCode
    || pickupCodeInput.trim().toUpperCase() === String(order.pickupCode || '').trim().toUpperCase();
  const canHandoffPickup = canEdit && order.fulfillmentType === 'PICKUP' && order.status === 'READY_FOR_PICKUP' && pickupCodeMatches;

  async function pickItem(item, quantity = 1) {
    if (!item || pickBusy) return;
    setPickBusy(true);
    setError('');
    try {
      const data = await api(`/api/ecom/orders/${order.id}/pick`, {
        method: 'POST',
        body: JSON.stringify({ orderItemId: item.id, quantity, locationId: order.locationId || null }),
      });
      setPicklist(data.picklist || null);
      setNextPickStatus(data.nextStatus || null);
      if (data.order) onChange?.(data.order);
    } catch (err) {
      setError(err.message);
    } finally {
      setPickBusy(false);
    }
  }

  async function submitScan(e) {
    e?.preventDefault?.();
    if (!scanCode.trim() || pickBusy) return;
    setPickBusy(true);
    setError('');
    try {
      const data = await api(`/api/ecom/orders/${order.id}/pick`, {
        method: 'POST',
        body: JSON.stringify({ code: scanCode.trim(), quantity: 1, locationId: order.locationId || null }),
      });
      setScanCode('');
      setPicklist(data.picklist || null);
      setNextPickStatus(data.nextStatus || null);
      if (data.order) onChange?.(data.order);
    } catch (err) {
      setError(err.message);
    } finally {
      setPickBusy(false);
    }
  }

  async function completePicklist() {
    if (pickBusy) return;
    setPickBusy(true);
    setError('');
    try {
      const data = await api(`/api/ecom/orders/${order.id}/pick/complete`, {
        method: 'POST',
        body: JSON.stringify({ locationId: order.locationId || null }),
      });
      setPicklist(data.picklist || null);
      setNextPickStatus(data.nextStatus || null);
      if (data.order) onChange?.(data.order);
    } catch (err) {
      setError(err.message);
    } finally {
      setPickBusy(false);
    }
  }

  // Shared POST for the pick-exception endpoints (weigh / substitute / short /
  // resolve). Each returns { order, picklist, nextStatus }.
  async function pickException(path, body) {
    if (pickBusy) return;
    setPickBusy(true);
    setError('');
    try {
      const data = await api(`/api/ecom/orders/${order.id}/items/${path}`, {
        method: 'POST',
        body: JSON.stringify({ locationId: order.locationId || null, ...body }),
      });
      setPicklist(data.picklist || null);
      setNextPickStatus(data.nextStatus || null);
      if (data.order) onChange?.(data.order);
    } catch (err) {
      setError(err.message);
    } finally {
      setPickBusy(false);
    }
  }

  function weighItem(item) {
    const grams = Math.round(Number(weightDrafts[item.id]));
    if (!Number.isFinite(grams) || grams <= 0) {
      setError('Enter a weight in grams');
      return;
    }
    pickException(`${item.id}/weight`, { weightGrams: grams });
  }

  function shortLineItem(item) {
    pickException(`${item.id}/short`, { reason: 'OUT_OF_STOCK' });
  }

  function submitSubstitute() {
    if (!subDraft) return;
    const price = Math.round(Number(subDraft.price) * 100); // major → minor
    if (!subDraft.name?.trim() || !Number.isFinite(price) || price < 0) {
      setError('Enter a substitute name and price');
      return;
    }
    pickException(`${subDraft.itemId}/substitute`, {
      substituteProductName: subDraft.name.trim(),
      substitutePriceMinor: price,
      substituteQuantity: Math.max(1, Math.trunc(Number(subDraft.qty) || 1)),
      reason: 'OUT_OF_STOCK',
    }).then(() => setSubDraft(null));
  }

  function resolveSub(item, decision) {
    pickException(`${item.id}/substitution`, { decision });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-end sm:justify-center">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative w-full sm:max-w-2xl bg-white sm:rounded-2xl shadow-xl flex flex-col max-h-screen overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-gray-900">
              Order #{order.id.slice(0, 8)}
            </h3>
            <p className="text-xs text-gray-500">{formatDate(order.placedAt)}</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            <FulfillmentBadge type={order.fulfillmentType} />
            <PaymentBadge method={order.paymentMethod} status={order.status} paidAt={order.paidAt} />
            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_BADGE[order.status] || ''}`}>
              {order.status}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-2 text-gray-400 hover:text-gray-700 text-2xl leading-none"
          >×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {order.paymentMethod === 'cod' && !['PAID', 'CANCELLED', 'REFUNDED', 'FAILED'].includes(order.status) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <strong>Cash on delivery</strong> — start packing now, then collect cash when the order
              {order.fulfillmentType === 'PICKUP' ? ' is picked up' : ' is delivered'}. Click
              <span className="mx-1 px-1.5 py-0.5 bg-amber-200 text-amber-900 rounded text-xs font-mono">Mark paid</span>
              once cash is in hand.
            </div>
          )}

          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Customer</h4>
            <p className="text-sm text-gray-900">{order.customerName}</p>
            <p className="text-sm text-gray-600">{order.customerEmail}</p>
            {order.customerPhone && <p className="text-sm text-gray-600">{order.customerPhone}</p>}
          </section>

          {order.location && (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Fulfilling store</h4>
              <p className="text-sm text-gray-900">{order.location.name}</p>
              <p className="text-xs text-gray-500">{[order.location.city, order.location.state].filter(Boolean).join(', ')}</p>
            </section>
          )}

          {order.fulfillmentType === 'PICKUP' ? (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Pickup</h4>
              {order.pickupLocation && (
                <p className="text-sm text-gray-700 leading-relaxed">
                  <strong>{order.pickupLocation.name}</strong><br />
                  {order.pickupLocation.addressLine1}{order.pickupLocation.city ? `, ${order.pickupLocation.city}` : ''}
                </p>
              )}
              {order.pickupCode && (
                <p className="mt-2 text-sm text-gray-700">
                  Pickup code: <span className="font-mono text-base font-bold text-gray-900">{order.pickupCode}</span>
                  <span className="ml-2 text-xs text-gray-500">(verify before handing over)</span>
                </p>
              )}
            </section>
          ) : (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Ship to</h4>
              <p className="text-sm text-gray-700 leading-relaxed">
                {addr.line1}{addr.line2 ? <><br />{addr.line2}</> : null}<br />
                {addr.city}{addr.state ? `, ${addr.state}` : ''} {addr.postalCode}<br />
                {addr.country}
              </p>
              {(addr.deliveryZoneName || order.deliverySlotLabel) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {addr.deliveryZoneName && (
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-700">
                      Zone: {addr.deliveryZoneName}
                    </span>
                  )}
                  {order.deliverySlotLabel && (
                    <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">
                      Slot: {order.deliverySlotLabel}
                    </span>
                  )}
                </div>
              )}
            </section>
          )}

          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Items</h4>
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {order.items.map((item) => (
                <li key={item.id} className="px-3 py-2 flex justify-between text-sm">
                  <div>
                    <p className="font-medium text-gray-900">{item.productName}</p>
                    <p className="text-xs text-gray-500">{formatPrice(item.priceMinor, order.currency)} × {item.quantity}</p>
                  </div>
                  <div className="font-semibold text-gray-900">
                    {formatPrice(item.lineTotalMinor, order.currency)}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {showPicklist && (
            <section className="rounded-xl border border-blue-100 bg-blue-50/50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-blue-700">Picklist</h4>
                  <p className="mt-1 text-xs text-blue-700">
                    {picklist
                      ? `${picklist.pickedQuantity} of ${picklist.totalQuantity} units picked`
                      : 'Loading picklist...'}
                    {picklist?.complete && nextPickStatus ? ` · ready for ${nextPickStatus === 'READY_FOR_PICKUP' ? 'pickup handoff' : 'dispatch'}` : ''}
                  </p>
                  {picklist?.awaitingApproval && (
                    <p className="mt-1 text-xs font-semibold text-amber-700">
                      Waiting on the customer to approve a substitution before this order can move on.
                    </p>
                  )}
                </div>
                {showConfirmPicked && (
                  <button
                    type="button"
                    onClick={completePicklist}
                    disabled={pickBusy}
                    className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Confirm picked
                  </button>
                )}
              </div>
              {picklist?.confirmed && (
                <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                  Picklist confirmed. {order.fulfillmentType === 'PICKUP' ? 'Move this order to ready for pickup when it reaches the pickup area.' : 'Move this order through Dispatch when it is handed to delivery.'}
                </p>
              )}

              <form onSubmit={submitScan} className="mt-3 flex gap-2">
                <input
                  value={scanCode}
                  onChange={(e) => setScanCode(e.target.value)}
                  placeholder="Scan or enter barcode / QR / SKU"
                  className="min-w-0 flex-1 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
                <button
                  type="submit"
                  disabled={pickBusy || !scanCode.trim()}
                  className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                >
                  Pick
                </button>
              </form>

              {picklist?.items?.length > 0 && (
                <ul className="mt-3 divide-y divide-blue-100 rounded-lg border border-blue-100 bg-white">
                  {picklist.items.map((item) => {
                    const isShorted = item.fulfillmentStatus === 'SHORTED';
                    const isSubbed = item.fulfillmentStatus === 'SUBSTITUTED';
                    const isProposed = item.substitutionStatus === 'PROPOSED';
                    const settledException = isShorted || (isSubbed && !isProposed);
                    const showPickPlus = !item.soldByWeight && !settledException && !isProposed && item.remainingQuantity > 0;
                    return (
                    <li key={item.id} className="px-3 py-2 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-gray-900">{item.productName}</p>
                          <p className="text-xs text-gray-500">
                            {item.barcode
                              ? <span className="font-mono">{item.barcode}</span>
                              : item.sku
                                ? <span className="font-mono">{item.sku}</span>
                                : item.productSlug || 'No scan code'}
                            <span className="mx-1">·</span>
                            {item.soldByWeight
                              ? <>~{item.orderedWeightGrams ?? '?'} g est</>
                              : <>picked {item.pickedQuantity}/{item.quantity}</>}
                          </p>
                          {item.soldByWeight && item.pickedWeightGrams != null && (
                            <p className="mt-1 text-xs font-semibold text-emerald-700">
                              Weighed {item.pickedWeightGrams} g · {formatPrice(item.effectiveLineTotalMinor, order.currency)}
                            </p>
                          )}
                          {isSubbed && (
                            <p className={`mt-1 text-xs font-semibold ${isProposed ? 'text-amber-700' : item.substitutionStatus === 'REJECTED' ? 'text-red-700' : 'text-purple-700'}`}>
                              → {item.substituteProductName}
                              {item.substitutePriceMinor != null ? ` (${formatPrice(item.substitutePriceMinor, order.currency)})` : ''}
                              {isProposed ? ' · awaiting customer' : item.substitutionStatus === 'REJECTED' ? ' · rejected, shorted' : ' · accepted'}
                            </p>
                          )}
                          {isShorted && !isSubbed && (
                            <p className="mt-1 text-xs font-semibold text-red-700">
                              Out of stock — shorted {item.shortedQuantity} · refunded
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          {item.soldByWeight && !settledException && (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min="1"
                                value={weightDrafts[item.id] ?? ''}
                                onChange={(e) => setWeightDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
                                placeholder="grams"
                                className="w-20 rounded-lg border border-blue-200 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                              />
                              <button
                                type="button"
                                disabled={pickBusy}
                                onClick={() => weighItem(item)}
                                className="rounded-lg border border-blue-200 bg-white px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                              >
                                Weigh
                              </button>
                            </div>
                          )}
                          {showPickPlus && (
                            <button
                              type="button"
                              disabled={pickBusy}
                              onClick={() => pickItem(item, 1)}
                              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:border-blue-300 hover:text-blue-700 disabled:opacity-40"
                            >
                              +1
                            </button>
                          )}
                          {isProposed ? (
                            <div className="flex gap-1">
                              <button type="button" disabled={pickBusy} onClick={() => resolveSub(item, 'ACCEPT')}
                                className="rounded-lg border border-emerald-200 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">Accept</button>
                              <button type="button" disabled={pickBusy} onClick={() => resolveSub(item, 'REJECT')}
                                className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">Reject</button>
                            </div>
                          ) : !settledException && (
                            <div className="flex gap-1">
                              <button type="button" disabled={pickBusy} onClick={() => shortLineItem(item)}
                                className="rounded-lg border border-red-100 px-2 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50">Out of stock</button>
                              <button type="button" disabled={pickBusy}
                                onClick={() => setSubDraft({ itemId: item.id, name: '', price: '', qty: item.quantity })}
                                className="rounded-lg border border-purple-200 px-2 py-1 text-[11px] font-semibold text-purple-700 hover:bg-purple-50 disabled:opacity-50">Substitute…</button>
                            </div>
                          )}
                        </div>
                      </div>
                      {subDraft?.itemId === item.id && (
                        <div className="mt-2 space-y-2 rounded-lg border border-purple-200 bg-purple-50 p-2">
                          <input
                            value={subDraft.name}
                            onChange={(e) => setSubDraft((d) => ({ ...d, name: e.target.value }))}
                            placeholder="Replacement product name"
                            className="w-full rounded-lg border border-purple-200 px-2 py-1.5 text-xs focus:border-purple-500 focus:outline-none"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="number" min="0" step="0.01" value={subDraft.price}
                              onChange={(e) => setSubDraft((d) => ({ ...d, price: e.target.value }))}
                              placeholder="Price each"
                              className="w-24 rounded-lg border border-purple-200 px-2 py-1.5 text-xs focus:border-purple-500 focus:outline-none"
                            />
                            <input
                              type="number" min="1" value={subDraft.qty}
                              onChange={(e) => setSubDraft((d) => ({ ...d, qty: e.target.value }))}
                              placeholder="Qty"
                              className="w-16 rounded-lg border border-purple-200 px-2 py-1.5 text-xs focus:border-purple-500 focus:outline-none"
                            />
                            <button type="button" disabled={pickBusy} onClick={submitSubstitute}
                              className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50">Save substitute</button>
                            <button type="button" onClick={() => setSubDraft(null)}
                              className="px-2 py-1.5 text-xs font-semibold text-gray-500 hover:text-gray-800">Cancel</button>
                          </div>
                        </div>
                      )}
                    </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {order.fulfillmentType === 'PICKUP' && order.status === 'READY_FOR_PICKUP' && (
            <section className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Pickup handoff</h4>
                  <p className="mt-1 text-xs text-emerald-700">
                    Verify the customer code before handing over the order.
                    {order.paymentMethod === 'cod' ? ' Collect cash at the counter, then mark paid.' : ''}
                  </p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-emerald-700">
                  Counter handoff
                </span>
              </div>
              {needsPickupCode && (
                <label className="mt-3 block text-xs font-semibold text-gray-700">
                  Customer pickup code
                  <input
                    value={pickupCodeInput}
                    onChange={(e) => setPickupCodeInput(e.target.value)}
                    disabled={!canEdit || busy}
                    placeholder="Enter code shown by customer"
                    className="mt-1 w-full rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm font-mono uppercase tracking-wide focus:border-emerald-500 focus:outline-none disabled:bg-gray-50"
                  />
                </label>
              )}
              {needsPickupCode && pickupCodeInput && !pickupCodeMatches && (
                <p className="mt-2 text-xs font-semibold text-red-700">Pickup code does not match.</p>
              )}
              <button
                type="button"
                disabled={!canHandoffPickup || busy}
                onClick={() => transition('PICKED_UP')}
                className="mt-3 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? 'Completing handoff...' : 'Verify and mark picked up'}
              </button>
            </section>
          )}

          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Totals</h4>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between text-gray-600"><span>Subtotal</span><span className="text-gray-900">{formatPrice(order.subtotalMinor, order.currency)}</span></div>
              {order.shippingMinor > 0 && <div className="flex justify-between text-gray-600"><span>Shipping</span><span className="text-gray-900">{formatPrice(order.shippingMinor, order.currency)}</span></div>}
              {order.taxMinor > 0 && <div className="flex justify-between text-gray-600"><span>Tax</span><span className="text-gray-900">{formatPrice(order.taxMinor, order.currency)}</span></div>}
              {order.discountMinor > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>Discount {order.couponCode ? <span className="text-xs font-mono text-emerald-600">({order.couponCode})</span> : null}</span>
                  <span>−{formatPrice(order.discountMinor, order.currency)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-semibold text-gray-900 pt-2 border-t border-gray-100">
                <span>{order.adjustedTotalMinor != null && order.adjustedTotalMinor !== order.totalMinor ? 'Originally charged' : 'Total'}</span>
                <span className={order.adjustedTotalMinor != null && order.adjustedTotalMinor !== order.totalMinor ? 'text-gray-400 line-through' : ''}>
                  {formatPrice(order.totalMinor, order.currency)}
                </span>
              </div>
              {order.adjustedTotalMinor != null && order.adjustedTotalMinor !== order.totalMinor && (
                <div className="flex justify-between text-base font-black text-gray-950">
                  <span>Adjusted total</span><span>{formatPrice(order.adjustedTotalMinor, order.currency)}</span>
                </div>
              )}
              {order.refundedMinor > 0 && (
                <div className="flex justify-between text-sm font-semibold text-purple-700">
                  <span>Refunded</span><span>−{formatPrice(order.refundedMinor, order.currency)}</span>
                </div>
              )}
            </div>
            {order.adjustedTotalMinor != null && order.adjustedTotalMinor !== order.totalMinor && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {order.paymentMethod === 'cod'
                  ? `Order changed during picking — collect ${formatPrice(order.adjustedTotalMinor, order.currency)} ${order.fulfillmentType === 'PICKUP' ? 'at pickup' : 'on delivery'}.`
                  : order.refundedMinor > 0
                    ? `Order changed during picking — ${formatPrice(order.refundedMinor, order.currency)} refunded to the customer.`
                    : 'Order changed during picking. Totals updated.'}
              </p>
            )}
          </section>

          {order.notes && (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Customer note</h4>
              <p className="text-sm text-gray-700 whitespace-pre-line">{order.notes}</p>
            </section>
          )}

          {canEdit && (allowed.length ? allowed : defaultNextActions(order.status, order.fulfillmentType, order.paymentMethod)).some((s) => ['DELIVERED', 'PICKED_UP'].includes(s)) && (
            <section className="rounded-xl border border-gray-200 bg-gray-50 p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Proof of {order.fulfillmentType === 'PICKUP' ? 'pickup' : 'delivery'} (optional)</h4>
              <p className="mb-3 text-xs text-gray-500">Attach a photo and/or note — saved when you mark this order {order.fulfillmentType === 'PICKUP' ? 'picked up' : 'delivered'}.</p>
              {proofPhotoUrl ? (
                <div className="mb-2 flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={proofPhotoUrl} alt="Proof" className="h-16 w-16 rounded-lg border border-gray-200 object-cover" />
                  <button type="button" onClick={() => setProofPhotoUrl('')} className="text-xs font-semibold text-red-600 hover:text-red-800">Remove photo</button>
                </div>
              ) : (
                <label className="mb-2 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">
                  {proofUploading ? 'Uploading…' : '📷 Add photo'}
                  <input type="file" accept="image/*" capture="environment" className="hidden" disabled={proofUploading} onChange={handleProofFile} />
                </label>
              )}
              <textarea
                value={proofNote}
                onChange={(e) => setProofNote(e.target.value)}
                placeholder="e.g. Left with neighbour at #12 / handed to customer"
                rows={2}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </section>
          )}

          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Timeline</h4>
            <div className="overflow-y-auto" style={{ maxHeight: '240px' }}>
              {events === null ? (
                <p className="text-xs text-gray-400">Loading events…</p>
              ) : events.length === 0 ? (
                <p className="text-xs text-gray-400">No events recorded yet.</p>
              ) : (
                <ol className="relative border-l border-gray-200 ml-2 space-y-3">
                  {events.map((ev) => (
                    <li key={ev.id} className="pl-4">
                      <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-white bg-indigo-400" />
                      <p className="font-medium text-gray-800 text-xs leading-tight">
                        {toTitleCase(ev.kind)}
                      </p>
                      {ev.message && (
                        <p className="text-xs text-gray-500 mt-0.5">{ev.message}</p>
                      )}
                      {ev.payload?.proofPhotoUrl && (
                        <a href={ev.payload.proofPhotoUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={ev.payload.proofPhotoUrl} alt="Proof of delivery" className="h-20 w-20 rounded-lg border border-gray-200 object-cover" />
                        </a>
                      )}
                      <time className="font-mono text-[10px] text-gray-400 block">
                        {formatDate(ev.createdAt)}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>

        <footer className="px-5 py-4 border-t border-gray-200 bg-gray-50 space-y-2">
          {error && (
            <p className="text-xs text-red-700">{error}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {canEdit ? (
              (allowed.length === 0 ? defaultNextActions(order.status, order.fulfillmentType, order.paymentMethod) : allowed).map((next) => (
                <button
                  key={next}
                  type="button"
                  disabled={busy || (next === 'PICKED_UP' && needsPickupCode && !pickupCodeMatches)}
                  onClick={() => transition(next)}
                  className={`text-sm font-medium px-3 py-2 rounded-lg border transition-colors ${
                    next === 'CANCELLED' || next === 'FAILED'
                      ? 'border-red-200 text-red-700 hover:bg-red-50'
                      : 'border-indigo-200 text-indigo-700 hover:bg-indigo-50'
                  } disabled:opacity-50`}
                >
                  {STATUS_LABELS[next] || next}
                </button>
              ))
            ) : (
              <p className="text-xs font-semibold text-gray-500">View-only access. Ask an owner to grant order edit permission for fulfillment actions.</p>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ml-auto text-sm text-gray-500 hover:text-gray-900 px-3 py-2"
            >Close</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// What we suggest as next-step buttons before we ask the server. The
// PACKING fork shows delivery vs pickup paths based on order's fulfillmentType.
// COD orders skip the "Mark paid" step at PENDING — admin packs first, then
// flips PAID after cash is collected on delivery / pickup.
function defaultNextActions(status, fulfillmentType, paymentMethod) {
  const isPickup = fulfillmentType === 'PICKUP';
  const isCod = paymentMethod === 'cod';
  switch (status) {
    case 'PENDING': return isCod ? ['PACKING', 'CANCELLED'] : ['PAID', 'CANCELLED'];
    // For COD: PAID is the FINAL state (cash was collected after delivery).
    // For online: PAID is the INITIAL state (payment received before fulfillment).
    case 'PAID': return isCod ? ['REFUNDED'] : ['PACKING', 'CANCELLED', 'REFUNDED'];
    case 'PACKING': return isPickup
      ? ['READY_FOR_PICKUP', 'CANCELLED']
      : ['OUT_FOR_DELIVERY', 'CANCELLED'];
    case 'OUT_FOR_DELIVERY': return isCod ? ['DELIVERED', 'PAID', 'CANCELLED'] : ['DELIVERED', 'CANCELLED'];
    case 'READY_FOR_PICKUP': return isCod ? ['PICKED_UP', 'PAID', 'CANCELLED'] : ['PICKED_UP', 'CANCELLED'];
    case 'DELIVERED': return isCod ? ['PAID', 'REFUNDED'] : ['REFUNDED'];
    case 'PICKED_UP': return isCod ? ['PAID', 'REFUNDED'] : ['REFUNDED'];
    case 'FAILED': return ['PENDING'];
    default: return [];
  }
}

const FULFILLMENT_FILTERS = [
  { key: 'all', label: 'All orders' },
  { key: 'DELIVERY', label: 'Delivery' },
  { key: 'PICKUP', label: 'Click & Collect' },
];
const FULFILLMENT_FILTER_KEYS = new Set(FULFILLMENT_FILTERS.map((filter) => filter.key));

const FULFILLMENT_AUTO_REFRESH_MS = 10000;

const FULFILLMENT_LANES = [
  { key: 'new', title: 'New', hint: 'Paid or COD orders waiting to start' },
  { key: 'packing', title: 'Picking / packing', hint: 'Items being picked before handoff' },
  { key: 'ready_dispatch', title: 'Ready for dispatch', hint: 'Delivery orders fully picked' },
  { key: 'out_delivery', title: 'Out for delivery', hint: 'Assigned to a route or rider' },
  { key: 'ready_pickup', title: 'Ready for pickup', hint: 'Click & Collect handoff counter' },
  { key: 'completed', title: 'Completed', hint: 'Delivered or collected' },
  { key: 'issues', title: 'Issues', hint: 'Cancelled, failed, or refunded' },
];

function shortOrder(id) {
  return String(id || '').slice(0, 8);
}

function orderQuantity(order) {
  return (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

function orderLocationId(order) {
  return order?.locationId || order?.location?.id || '';
}

function addLocationOption(map, loc) {
  if (!loc?.id || loc.id === 'ALL' || map.has(loc.id)) return;
  map.set(loc.id, {
    ...loc,
    name: loc.name || [loc.city, loc.state].filter(Boolean).join(', ') || `Location ${shortOrder(loc.id)}`,
  });
}

function orderLane(order, readyDispatchIds) {
  if (['CANCELLED', 'FAILED', 'REFUNDED'].includes(order.status)) return 'issues';
  if (['DELIVERED', 'PICKED_UP'].includes(order.status) || order.deliveredAt || order.pickedUpAt) return 'completed';
  if (order.status === 'READY_FOR_PICKUP') return 'ready_pickup';
  if (order.status === 'OUT_FOR_DELIVERY') return 'out_delivery';
  if (order.fulfillmentType === 'DELIVERY' && readyDispatchIds.has(order.id)) return 'ready_dispatch';
  if (order.status === 'PACKING') return 'packing';
  if (['PENDING', 'PAID'].includes(order.status)) return 'new';
  return 'issues';
}

function primaryCardAction(order) {
  if (order.status === 'PENDING' && order.paymentMethod === 'cod') return { status: 'PACKING', label: 'Start picking' };
  if (order.status === 'PAID' && order.paymentMethod !== 'cod' && !order.deliveredAt && !order.pickedUpAt) return { status: 'PACKING', label: 'Start picking' };
  if (order.status === 'READY_FOR_PICKUP') return { open: true, label: 'Verify pickup' };
  if (order.status === 'DELIVERED' && order.paymentMethod === 'cod' && !order.paidAt) return { status: 'PAID', label: 'Mark cash paid' };
  if (order.status === 'PICKED_UP' && order.paymentMethod === 'cod' && !order.paidAt) return { status: 'PAID', label: 'Mark cash paid' };
  return null;
}

function canStartPickingOrder(order) {
  return primaryCardAction(order)?.status === 'PACKING';
}

function orderAgeSignal(order) {
  const status = order.status;
  let minutes = null;
  let label = '';
  let warnAt = 45;
  let dangerAt = 90;
  if (['PENDING', 'PAID'].includes(status)) {
    minutes = minutesSince(order.placedAt || order.createdAt);
    label = 'New';
    warnAt = 30;
    dangerAt = 60;
  } else if (status === 'PACKING') {
    minutes = minutesSince(order.updatedAt || order.placedAt);
    label = 'Picking';
    warnAt = 45;
    dangerAt = 90;
  } else if (status === 'READY_FOR_PICKUP') {
    minutes = minutesSince(order.pickupReadyAt || order.updatedAt);
    label = 'Pickup wait';
    warnAt = 120;
    dangerAt = 240;
  } else if (status === 'OUT_FOR_DELIVERY') {
    minutes = minutesSince(order.updatedAt || order.placedAt);
    label = 'On road';
    warnAt = 90;
    dangerAt = 180;
  }
  if (minutes === null) return null;
  const level = minutes >= dangerAt ? 'danger' : minutes >= warnAt ? 'warn' : 'ok';
  return { label, minutes, level };
}

// SLA promise signal — when a fulfilment promise time (promisedAt) is set and
// the order is still active, show the cutoff and flag if it has slipped.
function promiseSignal(order) {
  if (!order?.promisedAt) return null;
  if (['DELIVERED', 'PICKED_UP', 'CANCELLED', 'REFUNDED', 'FAILED'].includes(order.status)) return null;
  const due = new Date(order.promisedAt).getTime();
  if (!Number.isFinite(due)) return null;
  const late = Date.now() > due;
  let label;
  try {
    label = new Date(due).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
  return { label, late };
}

function OrderCard({ order, onOpen, selected, onSelect, selectable, canEdit, onQuickAction, busy }) {
  const isPickup = order.fulfillmentType === 'PICKUP';
  const addr = order.shippingAddress || {};
  const locationLabel = isPickup
    ? order.pickupLocation?.name || 'Pickup counter'
    : [addr.city, addr.postalCode].filter(Boolean).join(', ') || order.location?.name || 'Delivery address';
  const action = canEdit ? primaryCardAction(order) : null;
  const age = orderAgeSignal(order);
  const promise = promiseSignal(order);
  const ageClass = age?.level === 'danger'
    ? 'bg-red-50 text-red-700 border-red-200'
    : age?.level === 'warn'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-gray-50 text-gray-600 border-gray-200';
  return (
    <article className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm transition hover:border-indigo-200 hover:shadow-md">
      <div className="flex items-start gap-3">
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect?.(order.id)}
            className="mt-1 h-4 w-4 rounded border-gray-300"
            aria-label={`Select order ${shortOrder(order.id)}`}
          />
        )}
        <button type="button" onClick={() => onOpen(order)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs font-bold text-gray-950">#{shortOrder(order.id)}</span>
            <FulfillmentBadge type={order.fulfillmentType} />
            <PaymentBadge method={order.paymentMethod} status={order.status} paidAt={order.paidAt} />
          </div>
          <p className="mt-2 truncate text-sm font-semibold text-gray-950">{order.customerName || 'Customer'}</p>
          <p className="mt-0.5 truncate text-xs text-gray-500">{locationLabel}</p>
          {isPickup && order.pickupCode && (
            <p className="mt-2 text-xs text-purple-700">
              Pickup code <span className="font-mono font-black">{order.pickupCode}</span>
            </p>
          )}
          {order.deliverySlotLabel && !isPickup && (
            <p className="mt-2 text-xs font-semibold text-indigo-700">{order.deliverySlotLabel}</p>
          )}
          {(age || promise) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {age && (
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${ageClass}`}>
                  {age.label} · {compactAge(age.minutes)}
                </span>
              )}
              {promise && (
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${promise.late ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                  {promise.late ? `Late · due ${promise.label}` : `Due ${promise.label}`}
                </span>
              )}
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-3 text-xs">
            <span className="text-gray-500">{orderQuantity(order)} unit{orderQuantity(order) === 1 ? '' : 's'}</span>
            <span className="font-bold text-gray-950">{formatPrice(order.totalMinor, order.currency)}</span>
          </div>
        </button>
      </div>
      {action && (
        <button
          type="button"
          disabled={busy}
          onClick={() => action.open ? onOpen(order) : onQuickAction?.(order, action.status)}
          className="mt-3 w-full rounded-lg border border-indigo-200 px-3 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
        >
          {busy ? 'Working...' : action.label}
        </button>
      )}
    </article>
  );
}

function LaneColumn({ lane, orders, onOpen, selectedIds, onSelect, onSelectAll, canEdit, onQuickAction, busyOrderId }) {
  const selectable = canEdit && (lane.key === 'ready_dispatch' || lane.key === 'new');
  const allSelected = selectable && orders.length > 0 && orders.every((order) => selectedIds.includes(order.id));
  return (
    <section className="flex min-h-[260px] min-w-0 flex-col rounded-2xl border border-gray-200 bg-gray-50">
      <div className="border-b border-gray-200 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-black text-gray-950">{lane.title}</h3>
            <p className="mt-1 truncate text-xs text-gray-500">{lane.hint}</p>
            {selectable && orders.length > 0 && (
              <button
                type="button"
                onClick={() => onSelectAll?.(orders.map((order) => order.id), !allSelected)}
                className="mt-2 text-[11px] font-bold text-indigo-700 hover:text-indigo-900"
              >
                {allSelected ? 'Clear lane' : 'Select all'}
              </button>
            )}
          </div>
          <span className="rounded-full bg-white px-2 py-1 text-xs font-bold text-gray-700 shadow-sm">{orders.length}</span>
        </div>
      </div>
      <div className="max-h-[520px] flex-1 space-y-3 overflow-y-auto p-3">
        {orders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-200 bg-white p-4 text-center text-xs text-gray-400">No orders here.</p>
        ) : orders.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            onOpen={onOpen}
            selectable={selectable}
            selected={selectedIds.includes(order.id)}
            onSelect={onSelect}
            canEdit={canEdit}
            onQuickAction={onQuickAction}
            busy={busyOrderId === order.id}
          />
        ))}
      </div>
    </section>
  );
}

function CompletedOrderRow({ order, onOpen }) {
  const isPickup = order.fulfillmentType === 'PICKUP';
  return (
    <button
      type="button"
      onClick={() => onOpen(order)}
      className="flex w-full items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 text-left last:border-b-0 hover:bg-gray-50"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-black text-gray-950">#{shortOrder(order.id)}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isPickup ? 'bg-purple-50 text-purple-700' : 'bg-emerald-50 text-emerald-700'}`}>
            {isPickup ? 'Pickup complete' : 'Delivered'}
          </span>
          {order.paymentMethod === 'cod' && !order.paidAt && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">Cash pending</span>
          )}
        </div>
        <p className="mt-1 truncate text-sm font-semibold text-gray-900">{order.customerName || 'Customer'}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-black text-gray-950">{formatPrice(order.totalMinor, order.currency)}</p>
        <p className="mt-1 text-xs text-gray-500">{orderQuantity(order)} unit{orderQuantity(order) === 1 ? '' : 's'}</p>
      </div>
    </button>
  );
}

function KpiCard({ label, value, hint }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-black text-gray-950">{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

// ─── Worklist redesign ─────────────────────────────────────────────────────
// Replaces the 7-column Kanban + detached dispatch panel with an action-
// oriented queue: a glance bar, focus tabs, and one row per order carrying its
// single next action in plain language. Dispatch happens contextually (tick
// rows → bottom bar) instead of a separate "create route" control.

const WORKLIST_TABS = [
  { key: 'needs', label: 'Needs you' },
  { key: 'picking', label: 'Picking' },
  { key: 'delivery', label: 'Out for delivery' },
  { key: 'pickup', label: 'Ready for pickup' },
  { key: 'completed', label: 'Completed' },
  { key: 'issues', label: 'Issues' },
];

// Plain-language next action for a worklist row. `dispatchable` rows (fully
// picked delivery orders) are handled via selection + the bottom bar, so they
// return a 'select' kind rather than a button.
function worklistAction(order, dispatchable) {
  if (dispatchable) return { kind: 'select', label: 'Send to driver' };
  const base = primaryCardAction(order);
  if (!base) return null;
  if (base.open) return { kind: 'open', label: 'Hand to customer' };
  if (base.status === 'PACKING') return { kind: 'transition', status: 'PACKING', label: 'Start picking' };
  if (base.status === 'PAID') return { kind: 'transition', status: 'PAID', label: 'Mark cash collected' };
  return { kind: 'transition', status: base.status, label: base.label };
}

// Lower = more urgent. Late orders first, then by soonest promise / longest wait.
function worklistUrgencyKey(order) {
  const promise = promiseSignal(order);
  if (promise?.late) return -1e15 + new Date(order.promisedAt).getTime();
  if (order.promisedAt) return new Date(order.promisedAt).getTime();
  const age = orderAgeSignal(order);
  // No promise time → sort oldest-waiting first (most minutes = smaller key).
  return Date.now() - (age?.minutes || 0) * 60000;
}

function GlanceStat({ label, value, tone }) {
  const toneCls = tone === 'indigo'
    ? 'border-indigo-200 bg-indigo-50'
    : tone === 'amber'
      ? 'border-amber-200 bg-amber-50'
      : 'border-gray-200 bg-white';
  return (
    <div className={`rounded-2xl border p-3 ${toneCls}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-black text-gray-950">{value}</p>
    </div>
  );
}

function WorklistRow({ order, dispatchable, selected, onSelect, onOpen, onQuickAction, canEdit, busy }) {
  const isPickup = order.fulfillmentType === 'PICKUP';
  const addr = order.shippingAddress || {};
  const where = isPickup
    ? (order.pickupLocation?.name || 'Pickup counter')
    : [addr.city, addr.postalCode].filter(Boolean).join(', ') || order.location?.name || 'Delivery';
  const age = orderAgeSignal(order);
  const promise = promiseSignal(order);
  const action = canEdit ? worklistAction(order, dispatchable) : null;
  // Left urgency stripe colour.
  const stripe = promise?.late || age?.level === 'danger'
    ? 'bg-red-500'
    : age?.level === 'warn'
      ? 'bg-amber-400'
      : 'bg-emerald-400';
  const units = orderQuantity(order);
  return (
    <li className="flex items-stretch overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm transition hover:border-indigo-200 hover:shadow-md">
      <span className={`w-1.5 shrink-0 ${stripe}`} aria-hidden />
      {dispatchable && (
        <label className="flex items-center pl-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect?.(order.id)}
            className="h-4 w-4 rounded border-gray-300"
            aria-label={`Select order ${shortOrder(order.id)} to send`}
          />
        </label>
      )}
      <button type="button" onClick={() => onOpen(order)} className="min-w-0 flex-1 px-4 py-3 text-left">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs font-bold text-gray-950">#{shortOrder(order.id)}</span>
          <FulfillmentBadge type={order.fulfillmentType} />
          <PaymentBadge method={order.paymentMethod} status={order.status} paidAt={order.paidAt} />
          {promise && (
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${promise.late ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
              {promise.late ? `Late · due ${promise.label}` : `Due ${promise.label}`}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="truncate text-sm font-bold text-gray-950">{order.customerName || 'Customer'}</span>
          <span className="truncate text-xs text-gray-500">{where}</span>
          {order.deliverySlotLabel && !isPickup && (
            <span className="text-xs font-semibold text-indigo-600">{order.deliverySlotLabel}</span>
          )}
          {isPickup && order.pickupCode && (
            <span className="text-xs text-purple-700">code <span className="font-mono font-black">{order.pickupCode}</span></span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-gray-500">{units} unit{units === 1 ? '' : 's'} · {formatPrice(order.totalMinor, order.currency)}{order.adjustedTotalMinor != null && order.adjustedTotalMinor !== order.totalMinor ? ` → ${formatPrice(order.adjustedTotalMinor, order.currency)}` : ''}</p>
      </button>
      <div className="flex items-center pr-3">
        {action?.kind === 'transition' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onQuickAction?.(order, action.status)}
            className="rounded-lg bg-gray-950 px-3 py-2 text-xs font-black text-white hover:bg-gray-800 disabled:opacity-40"
          >
            {busy ? 'Working…' : action.label}
          </button>
        )}
        {action?.kind === 'open' && (
          <button
            type="button"
            onClick={() => onOpen(order)}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700"
          >
            {action.label}
          </button>
        )}
        {action?.kind === 'select' && (
          <button
            type="button"
            onClick={() => onSelect?.(order.id)}
            className={`rounded-lg px-3 py-2 text-xs font-black ${selected ? 'bg-indigo-600 text-white' : 'border border-indigo-200 text-indigo-700 hover:bg-indigo-50'}`}
          >
            {selected ? 'Selected ✓' : action.label}
          </button>
        )}
        {!action && (
          <span className="text-[11px] font-semibold text-gray-400">
            {order.status === 'OUT_FOR_DELIVERY' ? 'On the way' : order.picklist?.awaitingApproval ? 'Awaiting customer' : toTitleCase(order.status)}
          </span>
        )}
      </div>
    </li>
  );
}

// Sticky bottom bar for sending selected delivery orders to a driver. Replaces
// the old "Create delivery route" panel — same action, contextual + plain.
function DispatchBar({ count, codMinor, riders, riderId, onRider, onSend, busy, onClear }) {
  const hasRiders = riders.length > 0;
  return (
    <div className="sticky bottom-4 z-30 mx-auto max-w-3xl rounded-2xl border border-indigo-200 bg-white p-3 shadow-xl">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <p className="text-sm font-black text-gray-950">{count} order{count === 1 ? '' : 's'} to send</p>
          {codMinor > 0 && <p className="text-xs font-semibold text-amber-700">Cash to collect {formatPrice(codMinor)}</p>}
        </div>
        <select
          value={riderId}
          onChange={(e) => onRider(e.target.value)}
          className="min-w-0 flex-1 rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        >
          <option value="">{hasRiders ? 'Choose a checked-in driver…' : 'No checked-in drivers'}</option>
          {riders.map((r) => (
            <option key={r.id} value={r.id}>{r.fullName} · {r.vehicleType}{r.shifts?.[0]?.startedAt ? ` · since ${formatClock(r.shifts[0].startedAt)}` : ''}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !riderId || !hasRiders}
          onClick={onSend}
          className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-black text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Send out for delivery'}
        </button>
        <button type="button" onClick={onClear} className="px-2 text-xs font-bold text-gray-400 hover:text-gray-700">Clear</button>
      </div>
    </div>
  );
}

function formatDistance(meters) {
  if (meters == null || Number.isNaN(Number(meters))) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
}

function formatClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function DispatchRecommendationCard({ recommendation, onApply }) {
  const group = recommendation?.groups?.[0] || null;
  if (!group) return null;
  const distance = formatDistance(group.metrics?.maxDistanceMeters);
  return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">Suggested route</p>
          <h3 className="mt-1 text-base font-black text-gray-950">{group.reason}</h3>
          <p className="mt-1 text-xs font-semibold text-gray-700">
            {group.stopCount} stop{group.stopCount === 1 ? '' : 's'}
            {group.rider?.fullName ? ` · ${group.rider.fullName}` : ''}
            {!group.rider ? ' · no checked-in rider' : ''}
            {group.rider?.activeLoad ? ` · ${group.rider.activeLoad} active` : ''}
            {group.rider?.capacityStatus === 'NEAR_CAPACITY' ? ' · near capacity' : ''}
            {group.rider?.capacityStatus === 'OVER_CAPACITY' ? ' · over capacity' : ''}
            {group.dueAt ? ` · due ${formatClock(group.dueAt)}` : ''}
            {distance ? ` · within ${distance}` : ''}
            {group.cashToCollectMinor > 0 ? ` · COD ${formatPrice(group.cashToCollectMinor)}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onApply(group)}
          className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-black text-white hover:bg-emerald-800"
        >
          Apply suggestion
        </button>
      </div>
    </section>
  );
}

export default function OrdersPanel({ initialFulfillmentFilter = 'all' } = {}) {
  const { active: activeLocation, locations } = useEcommerceLocation();
  const access = useEcomAccess();
  const canEditOrders = access.has('orders.edit');
  const [orders, setOrders] = useState([]);
  const [dispatchQueue, setDispatchQueue] = useState([]);
  const [dispatchRecommendations, setDispatchRecommendations] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [riders, setRiders] = useState([]);
  const [total, setTotal] = useState(0);
  const [selectedPickIds, setSelectedPickIds] = useState([]);
  const [selectedDispatchIds, setSelectedDispatchIds] = useState([]);
  const [riderId, setRiderId] = useState('');
  const [dispatchLocationId, setDispatchLocationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyOrderId, setBusyOrderId] = useState('');
  const [error, setError] = useState('');
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [activeTab, setActiveTab] = useState('needs');
  const refreshInFlightRef = useRef(false);

  const router = useRouter();
  const searchParams = useSearchParams();
  const urlId = searchParams.get('id') || '';
  const urlFulfillment = searchParams.get('fulfillment') || '';
  const urlSearch = searchParams.get('q') || '';
  const defaultFulfillmentFilter = FULFILLMENT_FILTER_KEYS.has(initialFulfillmentFilter) ? initialFulfillmentFilter : 'all';
  const [fulfillmentFilter, setFulfillmentFilterValue] = useState(
    FULFILLMENT_FILTER_KEYS.has(urlFulfillment) ? urlFulfillment : defaultFulfillmentFilter,
  );
  const [search, setSearchValue] = useState(urlSearch);

  const replaceOrderQuery = useCallback((mutate) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(params.toString() ? `?${params.toString()}` : window.location.pathname, { scroll: false });
  }, [router, searchParams]);

  const setFulfillmentFilter = useCallback((filter) => {
    const nextFilter = FULFILLMENT_FILTER_KEYS.has(filter) ? filter : defaultFulfillmentFilter;
    setFulfillmentFilterValue(nextFilter);
    replaceOrderQuery((params) => {
      if (nextFilter === defaultFulfillmentFilter) params.delete('fulfillment');
      else params.set('fulfillment', nextFilter);
    });
  }, [defaultFulfillmentFilter, replaceOrderQuery]);

  const setSearch = useCallback((value) => {
    setSearchValue(value);
    replaceOrderQuery((params) => {
      const trimmed = value.trim();
      if (trimmed) params.set('q', trimmed);
      else params.delete('q');
    });
  }, [replaceOrderQuery]);

  useEffect(() => {
    setFulfillmentFilterValue(FULFILLMENT_FILTER_KEYS.has(urlFulfillment) ? urlFulfillment : defaultFulfillmentFilter);
    setSearchValue(urlSearch);
  }, [defaultFulfillmentFilter, urlFulfillment, urlSearch]);

  const readyDispatchIds = useMemo(() => new Set(dispatchQueue.map((order) => order.id)), [dispatchQueue]);
  const checkedInRiders = useMemo(() => riders.filter(isCheckedInRider), [riders]);

  useEffect(() => {
    if (riderId && !checkedInRiders.some((rider) => rider.id === riderId)) setRiderId('');
  }, [checkedInRiders, riderId]);

  const dispatchLocations = useMemo(() => {
    const map = new Map();
    locations.forEach((loc) => addLocationOption(map, loc));
    dispatchQueue.forEach((order) => addLocationOption(map, order.location || (order.locationId ? { id: order.locationId } : null)));
    routes.forEach((route) => addLocationOption(map, route.location || (route.locationId ? { id: route.locationId } : null)));
    return Array.from(map.values());
  }, [locations, dispatchQueue, routes]);

  useEffect(() => {
    if (activeLocation && activeLocation !== 'ALL') {
      if (dispatchLocationId !== activeLocation) setDispatchLocationId(activeLocation);
      return;
    }
    const selectedLocationIds = Array.from(new Set(
      dispatchQueue.filter((order) => selectedDispatchIds.includes(order.id)).map(orderLocationId).filter(Boolean)
    ));
    if (selectedLocationIds.length === 1 && dispatchLocationId !== selectedLocationIds[0]) {
      setDispatchLocationId(selectedLocationIds[0]);
      return;
    }
    if (!dispatchLocationId && dispatchLocations.length === 1) setDispatchLocationId(dispatchLocations[0].id);
  }, [activeLocation, dispatchLocationId, dispatchLocations, dispatchQueue, selectedDispatchIds]);

  const goOpen = useCallback((order) => {
    const p = new URLSearchParams(searchParams.toString());
    p.set('view', 'detail'); p.set('id', order.id);
    router.push(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const goClose = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete('view'); p.delete('id');
    router.replace(`?${p.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const openOrder = urlId
    ? [...orders, ...dispatchQueue].find((o) => o.id === urlId) || null
    : null;

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent && refreshInFlightRef.current) return;
    if (silent) {
      refreshInFlightRef.current = true;
      setRefreshing(true);
    } else {
      setLoading(true);
      setError('');
    }
    try {
      const orderQs = new URLSearchParams({ perPage: '200' });
      if (search.trim()) orderQs.set('q', search.trim());
      if (activeLocation && activeLocation !== 'ALL') orderQs.set('locationId', activeLocation);

      const dispatchQs = new URLSearchParams();
      const routeLocation = dispatchLocationId || (activeLocation && activeLocation !== 'ALL' ? activeLocation : '');
      if (routeLocation && routeLocation !== 'ALL') dispatchQs.set('locationId', routeLocation);
      const dispatchQuery = dispatchQs.toString();
      const riderQuery = new URLSearchParams({ status: 'ACTIVE', pageSize: '100' });
      if (routeLocation && routeLocation !== 'ALL') riderQuery.set('locationId', routeLocation);

      const [orderData, queueData, routesData, ridersData] = await Promise.all([
        api(`/api/ecom/orders?${orderQs.toString()}`),
        api(`/api/ecom/dispatch/queue?${dispatchQuery}`),
        api(`/api/ecom/dispatch/routes?${dispatchQuery}`),
        api(`/api/ecom/riders?${riderQuery.toString()}`),
      ]);
      setOrders(orderData.orders || []);
      setTotal(orderData.total || 0);
      setDispatchQueue(queueData.orders || []);
      setDispatchRecommendations(queueData.recommendations || null);
      setRoutes(routesData.routes || []);
      setRiders(ridersData.rows || []);
      setLastSyncedAt(new Date());
      setSelectedPickIds((ids) => ids.filter((id) => (orderData.orders || []).some((order) => order.id === id && canStartPickingOrder(order))));
      setSelectedDispatchIds((ids) => ids.filter((id) => (queueData.orders || []).some((order) => order.id === id)));
    } catch (err) {
      if (!silent) setError(err.message);
    } finally {
      if (silent) {
        refreshInFlightRef.current = false;
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [activeLocation, dispatchLocationId, search]);

  useEffect(() => {
    const t = setTimeout(() => load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const refreshIfVisible = () => {
      if (document.hidden || loading || busy || busyOrderId) return;
      load({ silent: true });
    };

    const interval = window.setInterval(refreshIfVisible, FULFILLMENT_AUTO_REFRESH_MS);
    const handleVisibility = () => {
      if (!document.hidden) refreshIfVisible();
    };
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [busy, busyOrderId, load, loading]);

  function handleOrderUpdated(updated) {
    setOrders((list) => list.map((o) => (o.id === updated.id ? updated : o)));
    setDispatchQueue((list) => list.map((o) => (o.id === updated.id ? updated : o)));
  }

  async function quickTransition(order, nextStatus) {
    if (!canEditOrders || !order?.id || !nextStatus) return;
    if (nextStatus === 'CANCELLED' && !window.confirm(`Cancel order ${order.code || order.id.slice(0, 8)}? This releases reserved stock and cannot be undone from this screen.`)) {
      return;
    }
    setBusyOrderId(order.id);
    setError('');
    try {
      const data = await api(`/api/ecom/orders/${order.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus, locationId: order.locationId || null }),
      });
      if (data.order) handleOrderUpdated(data.order);
      await load();
    } catch (err) {
      setError(err.message || 'Failed to update order');
    } finally {
      setBusyOrderId('');
    }
  }

  function toggleDispatchOrder(id) {
    setSelectedDispatchIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }

  function applyDispatchRecommendation(group) {
    if (!group?.orderIds?.length) return;
    setSelectedDispatchIds(group.orderIds);
    if (group.locationId) setDispatchLocationId(group.locationId);
    if (group.rider?.id) setRiderId(group.rider.id);
  }

  function togglePickOrder(id) {
    setSelectedPickIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }

  function setLaneSelection(kind, ids, selected) {
    const setter = kind === 'new' ? setSelectedPickIds : setSelectedDispatchIds;
    setter((current) => {
      const idSet = new Set(current);
      ids.forEach((id) => {
        if (selected) idSet.add(id);
        else idSet.delete(id);
      });
      return Array.from(idSet);
    });
  }

  async function bulkStartPicking() {
    const ids = selectedPickIds.filter((id) => orders.some((order) => order.id === id && canStartPickingOrder(order)));
    if (ids.length === 0) {
      setError('Select at least one new order to start picking');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const results = await Promise.allSettled(ids.map((id) => {
        const order = orders.find((row) => row.id === id);
        return api(`/api/ecom/orders/${id}/status`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'PACKING', locationId: order?.locationId || null }),
        });
      }));
      const failed = results.filter((result) => result.status === 'rejected');
      setSelectedPickIds([]);
      await load();
      if (failed.length > 0) {
        setError(`${failed.length} order${failed.length === 1 ? '' : 's'} could not be moved to picking. Refresh and try those again.`);
      }
    } catch (err) {
      setError(err.message || 'Failed to start picking');
    } finally {
      setBusy(false);
    }
  }

  async function createRoute() {
    const selectedLocationIds = Array.from(new Set(
      dispatchQueue.filter((order) => selectedDispatchIds.includes(order.id)).map(orderLocationId).filter(Boolean)
    ));
    const routeLocationId = dispatchLocationId || (selectedLocationIds.length === 1 ? selectedLocationIds[0] : '');
    if (!routeLocationId || routeLocationId === 'ALL') {
      setError('Choose a dispatch location first');
      return;
    }
    if (selectedDispatchIds.length === 0) {
      setError('Select at least one ready delivery order');
      return;
    }
    if (!riderId) {
      setError('Choose a rider before dispatching the route');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/ecom/dispatch/routes', {
        method: 'POST',
        body: JSON.stringify({ locationId: routeLocationId, riderId, orderIds: selectedDispatchIds }),
      });
      setSelectedDispatchIds([]);
      await load();
    } catch (err) {
      setError(err.message || 'Failed to dispatch route');
    } finally {
      setBusy(false);
    }
  }

  async function completeRoute(route) {
    if (!window.confirm(`Complete route ${route.code} and mark all stops delivered?`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/dispatch/routes/${route.id}/complete`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (err) {
      setError(err.message || 'Failed to complete route');
    } finally {
      setBusy(false);
    }
  }

  async function reassignRoute(route, nextRiderId) {
    if (!nextRiderId || nextRiderId === route.riderId) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/dispatch/routes/${route.id}`, {
        method: 'PUT',
        body: JSON.stringify({ riderId: nextRiderId }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Failed to reassign route');
    } finally {
      setBusy(false);
    }
  }

  async function cancelRoute(route) {
    const reason = window.prompt(`Cancel route ${route.code}? Orders that are not delivered will return to the dispatch queue. Add a reason:`);
    if (reason === null) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/dispatch/routes/${route.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Failed to cancel route');
    } finally {
      setBusy(false);
    }
  }

  const visibleOrders = useMemo(() => {
    if (fulfillmentFilter === 'all') return orders;
    return orders.filter((order) => order.fulfillmentType === fulfillmentFilter);
  }, [orders, fulfillmentFilter]);

  const laneOrders = useMemo(() => {
    const map = Object.fromEntries(FULFILLMENT_LANES.map((lane) => [lane.key, []]));
    for (const order of visibleOrders) {
      const lane = orderLane(order, readyDispatchIds);
      if (lane !== 'ready_dispatch') map[lane].push(order);
    }
    if (fulfillmentFilter !== 'PICKUP') {
      map.ready_dispatch = dispatchQueue.filter((order) => (
        fulfillmentFilter === 'all' || order.fulfillmentType === fulfillmentFilter
      ));
    }
    return map;
  }, [dispatchQueue, fulfillmentFilter, readyDispatchIds, visibleOrders]);

  const activeLanes = useMemo(() => FULFILLMENT_LANES.filter((lane) => !['completed', 'issues'].includes(lane.key)), []);
  const completedOrders = laneOrders.completed || [];
  const visibleCompletedOrders = showAllCompleted ? completedOrders.slice(0, 50) : completedOrders.slice(0, 6);

  const kpis = useMemo(() => {
    const newOrders = orders.filter((order) => orderLane(order, readyDispatchIds) === 'new').length;
    const deliveryReady = dispatchQueue.length;
    const pickupReady = orders.filter((order) => order.fulfillmentType === 'PICKUP' && order.status === 'READY_FOR_PICKUP').length;
    const activeRoutes = routes.filter((route) => route.status === 'DISPATCHED').length;
    const codMinor = dispatchQueue
      .filter((order) => selectedDispatchIds.includes(order.id))
      .reduce((sum, order) => sum + (order.paymentMethod === 'cod' && !order.paidAt ? order.totalMinor : 0), 0);
    return { newOrders, deliveryReady, pickupReady, activeRoutes, codMinor };
  }, [dispatchQueue, orders, readyDispatchIds, routes, selectedDispatchIds]);

  // Worklist: "Needs you" = everything actionable, sorted by urgency. Other
  // tabs map to a single stage.
  const needsOrders = useMemo(() => {
    const list = [
      ...(laneOrders.new || []),
      ...(laneOrders.ready_dispatch || []),
      ...(laneOrders.ready_pickup || []),
      ...(laneOrders.completed || []).filter((o) => o.paymentMethod === 'cod' && !o.paidAt),
    ];
    const seen = new Set();
    return list
      .filter((o) => (seen.has(o.id) ? false : seen.add(o.id)))
      .sort((a, b) => worklistUrgencyKey(a) - worklistUrgencyKey(b));
  }, [laneOrders]);

  const tabCounts = {
    needs: needsOrders.length,
    picking: (laneOrders.packing || []).length,
    delivery: (laneOrders.out_delivery || []).length,
    pickup: (laneOrders.ready_pickup || []).length,
    completed: (laneOrders.completed || []).length,
    issues: (laneOrders.issues || []).length,
  };
  const tabOrders = {
    needs: needsOrders,
    picking: laneOrders.packing || [],
    delivery: laneOrders.out_delivery || [],
    pickup: laneOrders.ready_pickup || [],
    completed: completedOrders,
    issues: laneOrders.issues || [],
  }[activeTab] || needsOrders;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-600">Fulfillment</p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-gray-950">Orders, dispatch, and pickup handoff</h2>
            <p className="mt-1 text-sm text-gray-500">
              {total} order{total === 1 ? '' : 's'}
              {activeLocation && activeLocation !== 'ALL'
                ? ` · ${locations.find((l) => l.id === activeLocation)?.name || 'Selected location'}`
                : ' · all locations'}
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[360px]">
            <input
              type="search"
              placeholder="Search customer, email, or order ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <div className="flex flex-wrap gap-2">
              {FULFILLMENT_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFulfillmentFilter(f.key)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${
                    fulfillmentFilter === f.key
                      ? 'border-gray-950 bg-gray-950 text-white'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => load()}
                disabled={loading || refreshing}
                className="rounded-full border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-700 hover:border-gray-300 disabled:opacity-50"
              >
                {refreshing ? 'Updating...' : 'Refresh'}
              </button>
              {lastSyncedAt && (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
                  Updated {formatRefreshTime(lastSyncedAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {canEditOrders && activeTab === 'needs' && dispatchQueue.length > 0 && (
        <DispatchRecommendationCard
          recommendation={dispatchRecommendations}
          onApply={applyDispatchRecommendation}
        />
      )}

      {/* Glance pulse — live store counts */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <GlanceStat label="Needs you" value={tabCounts.needs} tone="indigo" />
        <GlanceStat label="Picking" value={tabCounts.picking} />
        <GlanceStat label="Out for delivery" value={tabCounts.delivery} />
        <GlanceStat label="Ready for pickup" value={tabCounts.pickup} />
        <GlanceStat label="Active drivers" value={kpis.activeRoutes} />
      </div>

      {/* Focus tabs */}
      <div className="flex flex-wrap gap-1 border-b border-gray-200">
        {WORKLIST_TABS.filter((t) => t.key !== 'issues' || tabCounts.issues > 0).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-bold transition-colors ${
              activeTab === t.key
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {t.label}
            <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-black ${activeTab === t.key ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500'}`}>
              {tabCounts[t.key]}
            </span>
          </button>
        ))}
      </div>

      {/* Worklist — one row per order, with its single next action */}
      {loading ? (
        <p className="rounded-2xl border border-gray-200 bg-white py-12 text-center text-sm text-gray-500">Loading orders…</p>
      ) : tabOrders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center">
          <p className="text-4xl">{activeTab === 'needs' ? '✅' : '📦'}</p>
          <h3 className="mt-3 text-base font-semibold text-gray-900">{activeTab === 'needs' ? 'All caught up' : 'Nothing here'}</h3>
          <p className="mt-1 text-sm text-gray-500">
            {activeTab === 'needs'
              ? 'No orders need your attention right now.'
              : search ? 'Try a different search.' : 'Orders show here as they reach this stage.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {tabOrders.map((order) => (
            <WorklistRow
              key={order.id}
              order={order}
              dispatchable={readyDispatchIds.has(order.id)}
              selected={selectedDispatchIds.includes(order.id)}
              onSelect={toggleDispatchOrder}
              onOpen={goOpen}
              onQuickAction={quickTransition}
              canEdit={canEditOrders}
              busy={busyOrderId === order.id}
            />
          ))}
        </ul>
      )}

      {/* Send-to-driver bar — appears only when delivery orders are ticked */}
      {canEditOrders && selectedDispatchIds.length > 0 && (
        <DispatchBar
          count={selectedDispatchIds.length}
          codMinor={kpis.codMinor}
          riders={checkedInRiders}
          riderId={riderId}
          onRider={setRiderId}
          onSend={createRoute}
          busy={busy}
          onClear={() => setSelectedDispatchIds([])}
        />
      )}

      <section className="rounded-2xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 p-4">
          <h3 className="text-base font-black text-gray-950">Recent routes</h3>
        </div>
        <div className="divide-y divide-gray-100">
          {routes.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">No routes yet.</p>
          ) : routes.slice(0, 8).map((route) => (
            <div key={route.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-mono text-xs font-bold text-gray-950">{route.code}</p>
                <p className="mt-1 text-sm text-gray-700">{route.rider?.fullName || 'No rider'} · {route.totalStops} stops · {route.status}</p>
              </div>
              {['PENDING', 'DISPATCHED'].includes(route.status) && (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={route.riderId || ''}
                    disabled={!canEditOrders || busy}
                    onChange={(e) => reassignRoute(route, e.target.value)}
                    className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700 focus:border-indigo-500 focus:outline-none"
                    aria-label={`Reassign route ${route.code}`}
                  >
                    <option value="">No rider</option>
                    {checkedInRiders.map((rider) => (
                      <option key={rider.id} value={rider.id}>{rider.fullName}</option>
                    ))}
                  </select>
                  {route.status === 'DISPATCHED' && (
                    <button
                      type="button"
                      disabled={!canEditOrders || busy}
                      onClick={() => completeRoute(route)}
                      className="rounded-xl border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50"
                    >
                      Complete
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!canEditOrders || busy}
                    onClick={() => cancelRoute(route)}
                    className="rounded-xl border border-red-200 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>


      {openOrder && (
        <OrderDetail
          order={openOrder}
          onClose={goClose}
          onChange={handleOrderUpdated}
          canEdit={canEditOrders}
        />
      )}
    </div>
  );
}

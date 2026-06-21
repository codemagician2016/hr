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

function shortId(id) {
  return String(id || '').slice(0, 8);
}

function units(order) {
  return (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

function pickable(order) {
  if (order.status === 'PACKING') return true;
  if (order.paymentMethod === 'cod' && order.status === 'PENDING') return true;
  return order.paymentMethod !== 'cod' && order.status === 'PAID';
}

function AccessState({ title, message }) {
  return (
    <main className="min-h-screen bg-[#f7f8f5] px-5 py-10">
      <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <p className="text-lg font-black text-gray-950">{title}</p>
        <p className="mt-2 text-sm text-gray-500">{message}</p>
      </div>
    </main>
  );
}

export default function PickerWorkspace() {
  const params = useParams();
  const router = useRouter();
  const slug = params?.slug;
  const [status, setStatus] = useState('loading');
  const [tenant, setTenant] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [picklist, setPicklist] = useState(null);
  const [nextStatus, setNextStatus] = useState('');
  const [scanCode, setScanCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === selectedId) || orders[0] || null,
    [orders, selectedId],
  );

  const load = useCallback(async () => {
    setError('');
    try {
      const [{ user }, tenantRes, accessRes, orderRes] = await Promise.all([
        api('/api/auth/me'),
        api(`/api/tenant/resolve?slug=${encodeURIComponent(slug)}`),
        api('/api/ecom/access'),
        api('/api/ecom/orders?perPage=200'),
      ]);
      if (!['STAFF', 'BUSINESS_ADMIN'].includes(user?.role)) {
        setStatus('forbidden');
        setError('Store staff access is required.');
        return;
      }
      if (tenantRes?.business?.id && user.businessId && tenantRes.business.id !== user.businessId) {
        setStatus('forbidden');
        setError('This staff account belongs to a different business.');
        return;
      }
      const permissions = new Set(accessRes.permissions || []);
      if (!accessRes.isOwner && (!permissions.has('orders.view') || !permissions.has('orders.edit'))) {
        setStatus('forbidden');
        setError('Order picking access has not been assigned to this staff account.');
        return;
      }
      const rows = (orderRes.orders || []).filter(pickable);
      setTenant(tenantRes);
      setOrders(rows);
      setSelectedId((current) => rows.some((order) => order.id === current) ? current : rows[0]?.id || '');
      setStatus('ready');
    } catch (err) {
      if (err.status === 401) {
        router.replace(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      setStatus('forbidden');
      setError(err.message || 'Unable to load picker workspace.');
    }
  }, [router, slug]);

  useEffect(() => {
    if (slug) load();
  }, [load, slug]);

  useEffect(() => {
    if (!selectedOrder) {
      setPicklist(null);
      return;
    }
    const qs = selectedOrder.locationId ? `?locationId=${encodeURIComponent(selectedOrder.locationId)}` : '';
    api(`/api/ecom/orders/${selectedOrder.id}/picklist${qs}`)
      .then((data) => {
        setPicklist(data.picklist || null);
        setNextStatus(data.nextStatus || '');
      })
      .catch((err) => setError(err.message || 'Unable to load picklist.'));
  }, [selectedOrder]);

  async function startPicking(order) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/orders/${order.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'PACKING', locationId: order.locationId || null }),
      }).catch((err) => {
        if (!String(err.message || '').includes('Cannot transition')) throw err;
      });
      await load();
    } catch (err) {
      setError(err.message || 'Unable to start picking.');
    } finally {
      setBusy(false);
    }
  }

  async function pick(payload) {
    if (!selectedOrder) return;
    setBusy(true);
    setError('');
    try {
      const data = await api(`/api/ecom/orders/${selectedOrder.id}/pick`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, locationId: selectedOrder.locationId || null }),
      });
      setPicklist(data.picklist || null);
      setNextStatus(data.nextStatus || '');
      setScanCode('');
    } catch (err) {
      setError(err.message || 'Unable to pick item.');
    } finally {
      setBusy(false);
    }
  }

  async function completePick() {
    if (!selectedOrder) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/orders/${selectedOrder.id}/pick/complete`, {
        method: 'POST',
        body: JSON.stringify({ locationId: selectedOrder.locationId || null }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Unable to complete picklist.');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    router.replace(`/login?redirect=${encodeURIComponent(`/${slug}/staff/picker`)}`);
  }

  if (status === 'loading') return <AccessState title="Loading picker workspace" message="Preparing the pick queue." />;
  if (status === 'forbidden') return <AccessState title="Picker access needed" message={error} />;

  return (
    <main className="min-h-screen bg-[#f7f8f5]">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-black text-gray-950">{tenant?.business?.name || 'Store'} picking</p>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-700">Scan, pick, confirm</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={load} className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700">Refresh</button>
            <button type="button" onClick={logout} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700">Sign out</button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-5 px-4 py-6 lg:grid-cols-[320px_1fr]">
        <aside className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-gray-500">Pick queue</p>
            <h1 className="mt-1 text-2xl font-black text-gray-950">{orders.length} order{orders.length === 1 ? '' : 's'}</h1>
          </div>
          <div className="max-h-[calc(100vh-170px)] overflow-y-auto p-3">
            {orders.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-200 p-5 text-center text-sm text-gray-500">No orders waiting to pick.</p>
            ) : orders.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => setSelectedId(order.id)}
                className={`mb-2 w-full rounded-xl border p-3 text-left transition ${
                  selectedOrder?.id === order.id
                    ? 'border-emerald-300 bg-emerald-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <p className="font-mono text-xs font-black text-gray-950">#{shortId(order.id)}</p>
                <p className="mt-1 truncate text-sm font-bold text-gray-900">{order.customerName || 'Customer'}</p>
                <p className="mt-1 text-xs text-gray-500">{units(order)} units · {order.fulfillmentType === 'PICKUP' ? 'Pickup' : 'Delivery'}</p>
              </button>
            ))}
          </div>
        </aside>

        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          {!selectedOrder ? (
            <p className="py-20 text-center text-sm text-gray-500">Select an order to start picking.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 pb-4">
                <div>
                  <p className="font-mono text-xs font-black text-emerald-700">#{shortId(selectedOrder.id)}</p>
                  <h2 className="mt-1 text-2xl font-black text-gray-950">{selectedOrder.customerName || 'Customer'}</h2>
                  <p className="mt-1 text-sm text-gray-500">{selectedOrder.status} · {selectedOrder.fulfillmentType === 'PICKUP' ? 'Click & Collect' : 'Delivery'}</p>
                </div>
                <button
                  type="button"
                  disabled={busy || selectedOrder.status === 'PACKING'}
                  onClick={() => startPicking(selectedOrder)}
                  className="rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40"
                >
                  Start picking
                </button>
              </div>

              {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{error}</div>}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (scanCode.trim()) pick({ code: scanCode.trim(), quantity: 1 });
                }}
                className="mt-5 flex gap-2"
              >
                <input
                  value={scanCode}
                  onChange={(e) => setScanCode(e.target.value)}
                  placeholder="Scan or enter barcode / QR / SKU"
                  className="min-w-0 flex-1 rounded-xl border border-gray-300 px-4 py-3 text-base font-semibold focus:border-emerald-500 focus:outline-none"
                  autoFocus
                />
                <button type="submit" disabled={busy || !scanCode.trim()} className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-black text-white disabled:opacity-40">
                  Pick
                </button>
              </form>

              <div className="mt-5 rounded-2xl border border-gray-100 bg-gray-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-black text-gray-950">
                      {picklist ? `${picklist.pickedQuantity}/${picklist.totalQuantity} units picked` : 'Loading picklist...'}
                    </p>
                    {nextStatus && <p className="mt-1 text-xs font-semibold text-gray-500">Next: {nextStatus.replace(/_/g, ' ')}</p>}
                  </div>
                  <button
                    type="button"
                    disabled={busy || !picklist?.complete || picklist?.confirmed}
                    onClick={completePick}
                    className="rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-black text-emerald-700 disabled:opacity-40"
                  >
                    Confirm picked
                  </button>
                </div>
              </div>

              <div className="mt-5 divide-y divide-gray-100 rounded-2xl border border-gray-100">
                {(picklist?.items || selectedOrder.items || []).map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-gray-950">{item.productName}</p>
                      <p className="mt-1 text-xs text-gray-500">
                        {(item.barcode || item.sku || item.productSlug) && <span className="font-mono">{item.barcode || item.sku || item.productSlug}</span>}
                        <span className="mx-1">·</span>
                        picked {item.pickedQuantity || 0}/{item.quantity}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy || item.remainingQuantity <= 0}
                      onClick={() => pick({ orderItemId: item.id, quantity: 1 })}
                      className="shrink-0 rounded-xl border border-gray-200 px-4 py-2 text-sm font-black text-gray-800 disabled:opacity-40"
                    >
                      +1
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

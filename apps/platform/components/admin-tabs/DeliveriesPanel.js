'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import { useEcomAccess } from '@/components/EcomAccessContext';
import { useTenant } from '@/components/TenantProvider';
import { getTenantStorefrontUrl } from '@/lib/platformDomain';

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
    err.issues = body.issues || [];
    throw err;
  }
  return body;
}

const STATUSES = [
  'PENDING',
  'READY_FOR_DISPATCH',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'ARRIVED',
  'DELIVERED',
  'ATTEMPTED_FAILED',
  'CANCELLED',
  'RETURNED',
];

const STATUS_TONE = {
  PENDING: 'bg-amber-50 text-amber-800 border-amber-200',
  READY_FOR_DISPATCH: 'bg-blue-50 text-blue-800 border-blue-200',
  ASSIGNED: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  PICKED_UP: 'bg-cyan-50 text-cyan-800 border-cyan-200',
  OUT_FOR_DELIVERY: 'bg-sky-50 text-sky-800 border-sky-200',
  ARRIVED: 'bg-violet-50 text-violet-800 border-violet-200',
  DELIVERED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  ATTEMPTED_FAILED: 'bg-red-50 text-red-800 border-red-200',
  CANCELLED: 'bg-gray-100 text-gray-700 border-gray-200',
  RETURNED: 'bg-orange-50 text-orange-800 border-orange-200',
  DISPATCHED: 'bg-sky-50 text-sky-800 border-sky-200',
  COMPLETED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  SETTLED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  VOID: 'bg-gray-100 text-gray-700 border-gray-200',
};

const SLA_TONE = {
  BREACHED: 'bg-red-50 text-red-800 border-red-200',
  AT_RISK: 'bg-orange-50 text-orange-800 border-orange-200',
  DUE_SOON: 'bg-amber-50 text-amber-800 border-amber-200',
  ON_TRACK: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  UNCOMMITTED: 'bg-gray-50 text-gray-700 border-gray-200',
  EXCEPTION: 'bg-red-50 text-red-800 border-red-200',
  COMPLETE: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  CLOSED: 'bg-gray-100 text-gray-700 border-gray-200',
};

const EXCEPTION_OPTIONS = [
  { value: 'CUSTOMER_UNREACHABLE', label: 'Customer unreachable' },
  { value: 'ADDRESS_ISSUE', label: 'Address issue' },
  { value: 'CUSTOMER_REFUSED', label: 'Customer refused' },
  { value: 'PAYMENT_ISSUE', label: 'Payment issue' },
  { value: 'RIDER_DELAY', label: 'Rider delay' },
  { value: 'VEHICLE_ISSUE', label: 'Vehicle issue' },
  { value: 'WEATHER_DELAY', label: 'Weather delay' },
  { value: 'DAMAGED_PACKAGE', label: 'Damaged package' },
  { value: 'OTHER', label: 'Other issue' },
];

function title(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function money(minor, currency = 'INR') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(minor || 0) / 100);
  } catch {
    return `${currency} ${(Number(minor || 0) / 100).toFixed(2)}`;
  }
}

function mapsHrefForLocation(location) {
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return null;
  return `https://www.google.com/maps/search/${encodeURIComponent(`${location.lat},${location.lng}`)}`;
}

function formatClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatShortDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDateTimeLocalValue(value) {
  const fallback = new Date(Date.now() + 60 * 60 * 1000);
  const date = value ? new Date(value) : fallback;
  const safeDate = Number.isNaN(date.getTime()) ? fallback : date;
  return new Date(safeDate.getTime() - safeDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function formatMinutes(value) {
  if (value == null || Number.isNaN(Number(value))) return '';
  const minutes = Math.round(Number(value));
  if (minutes < 0) return `${Math.abs(minutes)}m late`;
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m left` : `${hours}h left`;
}

function formatDuration(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  const minutes = Math.max(0, Math.round(Number(value)));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)}%`;
}

function formatRating(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)}/5`;
}

function isCheckedInRider(rider) {
  return Array.isArray(rider?.shifts) && rider.shifts.some((shift) => String(shift?.status || '').toUpperCase() === 'OPEN');
}

function routeProgress(route) {
  const stops = route?.stops || [];
  const closed = stops.filter((stop) => ['DELIVERED', 'ATTEMPTED_FAILED', 'SKIPPED'].includes(stop.status)).length;
  const delivered = stops.filter((stop) => stop.status === 'DELIVERED').length;
  const failed = stops.filter((stop) => stop.status === 'ATTEMPTED_FAILED').length;
  const skipped = stops.filter((stop) => stop.status === 'SKIPPED').length;
  return {
    total: stops.length || Number(route?.totalStops || 0),
    closed,
    delivered,
    failed,
    skipped,
    active: Math.max(0, (stops.length || Number(route?.totalStops || 0)) - closed),
  };
}

function nextStatus(row) {
  if (row.status === 'PENDING' && row.riderId) return 'ASSIGNED';
  if (row.status === 'READY_FOR_DISPATCH' && row.riderId) return 'ASSIGNED';
  if (row.status === 'ASSIGNED') return 'PICKED_UP';
  if (row.status === 'PICKED_UP') return 'OUT_FOR_DELIVERY';
  if (row.status === 'OUT_FOR_DELIVERY') return 'ARRIVED';
  if (row.status === 'ARRIVED') return 'DELIVERED';
  return null;
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_TONE[status] || STATUS_TONE.PENDING}`}>
      {title(status)}
    </span>
  );
}

function SlaBadge({ dispatch }) {
  const status = dispatch?.slaStatus || 'UNCOMMITTED';
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${SLA_TONE[status] || SLA_TONE.UNCOMMITTED}`}>
      {title(status)}
    </span>
  );
}

function DeliveryForm({ locations, riders, activeLocation, onCreated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    locationId: activeLocation && activeLocation !== 'ALL' ? activeLocation : '',
    riderId: '',
    sourceRef: '',
    priority: 'NORMAL',
    deliverySlotLabel: '',
    promisedAt: '',
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    packageNote: '',
    paymentMethod: 'online',
    cashToCollect: '',
    notes: '',
  });

  useEffect(() => {
    if (activeLocation && activeLocation !== 'ALL') {
      setForm((current) => ({ ...current, locationId: activeLocation }));
    }
  }, [activeLocation]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const cash = form.paymentMethod === 'cod'
        ? Math.max(0, Math.round(Number(form.cashToCollect || 0) * 100))
        : 0;
      const promisedAt = form.promisedAt ? new Date(form.promisedAt) : null;
      const result = await api('/api/ecom/deliveries', {
        method: 'POST',
        body: JSON.stringify({
          sourceRef: form.sourceRef.trim() || undefined,
          locationId: form.locationId || undefined,
          riderId: form.riderId || undefined,
          priority: form.priority || 'NORMAL',
          customerName: form.customerName,
          customerPhone: form.customerPhone || undefined,
          customerEmail: form.customerEmail || undefined,
          dropoff: {
            line1: form.line1,
            line2: form.line2 || undefined,
            city: form.city || undefined,
            state: form.state || undefined,
            postalCode: form.postalCode || undefined,
            country: form.country || undefined,
          },
          packageNote: form.packageNote || undefined,
          deliverySlotLabel: form.deliverySlotLabel || undefined,
          promisedAt: promisedAt && !Number.isNaN(promisedAt.getTime()) ? promisedAt.toISOString() : undefined,
          paymentMethod: form.paymentMethod,
          cashToCollectMinor: cash,
          notes: form.notes || undefined,
        }),
      });
      setForm((current) => ({
        ...current,
        riderId: '',
        sourceRef: '',
        priority: 'NORMAL',
        deliverySlotLabel: '',
        promisedAt: '',
        customerName: '',
        customerPhone: '',
        customerEmail: '',
        line1: '',
        line2: '',
        city: '',
        state: '',
        postalCode: '',
        packageNote: '',
        cashToCollect: '',
        notes: '',
      }));
      onCreated?.(result.delivery || result);
    } catch (err) {
      setError(err.message || 'Could not create delivery');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-black text-gray-950">Create manual delivery</h3>
          <p className="mt-1 text-sm text-gray-500">For phone, WhatsApp, counter, or offline requests.</p>
        </div>
        <button
          type="submit"
          disabled={busy || !form.customerName.trim() || !form.line1.trim()}
          className="rounded-xl bg-gray-950 px-4 py-2 text-sm font-black text-white hover:bg-gray-800 disabled:opacity-40"
        >
          {busy ? 'Creating...' : 'Create delivery'}
        </button>
      </div>
      {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <Field label="Order / request ref" value={form.sourceRef} onChange={set('sourceRef')} placeholder="ORDER-10042" />
        <Select label="Priority" value={form.priority} onChange={set('priority')}>
          <option value="NORMAL">Normal</option>
          <option value="URGENT">Urgent</option>
          <option value="LOW">Low</option>
        </Select>
        <Field label="Promised by" type="datetime-local" value={form.promisedAt} onChange={set('promisedAt')} />
        <Field label="Customer name" value={form.customerName} onChange={set('customerName')} required />
        <Field label="Phone" value={form.customerPhone} onChange={set('customerPhone')} />
        <Field label="Email" type="email" value={form.customerEmail} onChange={set('customerEmail')} />
        <Select label="Branch" value={form.locationId} onChange={set('locationId')}>
          <option value="">Default branch</option>
          {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
        </Select>
        <Select label="Rider" value={form.riderId} onChange={set('riderId')}>
          <option value="">Assign later</option>
          {riders.map((rider) => <option key={rider.id} value={rider.id}>{rider.fullName} - {rider.vehicleType}</option>)}
        </Select>
        <Select label="Payment" value={form.paymentMethod} onChange={set('paymentMethod')}>
          <option value="online">Prepaid / no cash</option>
          <option value="cod">Cash on delivery</option>
          <option value="manual">Manual settlement</option>
        </Select>
        <Field label="Dropoff line 1" value={form.line1} onChange={set('line1')} required />
        <Field label="Dropoff line 2" value={form.line2} onChange={set('line2')} />
        <Field label="City" value={form.city} onChange={set('city')} />
        <Field label="State" value={form.state} onChange={set('state')} />
        <Field label="Postal code" value={form.postalCode} onChange={set('postalCode')} />
        <Field label="Country" value={form.country} onChange={set('country')} placeholder="IN" />
        {form.paymentMethod === 'cod' && (
          <Field label="Cash to collect" type="number" min="0" step="0.01" value={form.cashToCollect} onChange={set('cashToCollect')} />
        )}
        <Field label="Slot label" value={form.deliverySlotLabel} onChange={set('deliverySlotLabel')} placeholder="Lunch 12-2 PM" />
        <div className="md:col-span-3 grid gap-3 md:grid-cols-2">
          <Textarea label="Package / item summary" value={form.packageNote} onChange={set('packageNote')} />
          <Textarea label="Internal notes" value={form.notes} onChange={set('notes')} />
        </div>
      </div>
    </form>
  );
}

function Field({ label, ...props }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-gray-600">{label}</span>
      <input
        {...props}
        className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-gray-950 focus:outline-none"
      />
    </label>
  );
}

function Select({ label, children, ...props }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-gray-600">{label}</span>
      <select
        {...props}
        className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-gray-950 focus:outline-none"
      >
        {children}
      </select>
    </label>
  );
}

function Textarea({ label, ...props }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-gray-600">{label}</span>
      <textarea
        {...props}
        rows={3}
        className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-gray-950 focus:outline-none"
      />
    </label>
  );
}

function OperationsReport({ analytics, days, onDaysChange, currency = 'INR' }) {
  const totals = analytics?.totals || {};
  const cash = analytics?.cash || {};
  const sla = analytics?.sla || {};
  const exceptions = analytics?.exceptions || {};
  const riders = analytics?.riderPerformance || [];
  const slaRows = [
    { key: 'BREACHED', label: 'Breached', bar: 'bg-red-500' },
    { key: 'AT_RISK', label: 'At risk', bar: 'bg-orange-500' },
    { key: 'DUE_SOON', label: 'Due soon', bar: 'bg-amber-500' },
    { key: 'EXCEPTION', label: 'Exception', bar: 'bg-rose-500' },
    { key: 'ON_TRACK', label: 'On track', bar: 'bg-emerald-500' },
  ];
  const maxSla = Math.max(...slaRows.map((row) => Number(sla[row.key] || 0)), 1);
  const exceptionRows = Object.entries(exceptions.breakdown || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5);

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-black text-gray-950">Operations report</h3>
          <p className="mt-1 text-sm text-gray-500">
            {analytics ? `Last ${analytics.window?.days || days} days of delivery performance` : 'Loading delivery performance...'}
          </p>
        </div>
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
          {[7, 30, 90].map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onDaysChange(item)}
              className={`rounded-lg px-3 py-1.5 text-xs font-black ${days === item ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}
            >
              {item}d
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-5">
        <div className="rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-bold text-gray-500">On-time rate</p>
          <p className="mt-1 text-2xl font-black text-gray-950">{formatPercent(totals.onTimePercent)}</p>
          <p className="text-xs text-gray-500">{totals.withPromisedAt || 0} SLA-measured deliveries</p>
        </div>
        <div className="rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-bold text-gray-500">Avg delivery time</p>
          <p className="mt-1 text-2xl font-black text-gray-950">{formatDuration(totals.avgDeliveryMinutes)}</p>
          <p className="text-xs text-gray-500">Pickup avg {formatDuration(totals.avgPickupMinutes)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-bold text-gray-500">COD outstanding</p>
          <p className="mt-1 text-2xl font-black text-gray-950">{money(cash.outstandingFromCustomersMinor || 0, currency)}</p>
          <p className="text-xs text-gray-500">{cash.codDeliveries || 0} cash delivery jobs</p>
        </div>
        <div className="rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-bold text-gray-500">Open exceptions</p>
          <p className="mt-1 text-2xl font-black text-gray-950">{(totals.openExceptions || 0) + (totals.escalatedExceptions || 0)}</p>
          <p className="text-xs text-gray-500">{totals.escalatedExceptions || 0} escalated</p>
        </div>
        <div className="rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-bold text-gray-500">Customer rating</p>
          <p className="mt-1 text-2xl font-black text-gray-950">{formatRating(totals.avgCustomerRating)}</p>
          <p className="text-xs text-gray-500">{totals.ratedDeliveries || 0} rated deliveries</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.4fr_1fr]">
        <div className="rounded-xl border border-gray-200 p-4">
          <h4 className="text-sm font-black text-gray-950">SLA health</h4>
          <div className="mt-3 space-y-3">
            {slaRows.map((row) => {
              const value = Number(sla[row.key] || 0);
              return (
                <div key={row.key}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-bold text-gray-600">{row.label}</span>
                    <span className="font-mono text-gray-500">{value}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                    <div className={`h-full ${row.bar}`} style={{ width: value ? `${Math.max(4, (value / maxSla) * 100)}%` : '0%' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-gray-200">
          <div className="border-b border-gray-100 px-4 py-3">
            <h4 className="text-sm font-black text-gray-950">Rider performance</h4>
          </div>
          {riders.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">No rider activity in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-[10px] font-bold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Rider</th>
                  <th className="px-4 py-2 text-right">Done</th>
                  <th className="px-4 py-2 text-right">Active</th>
                  <th className="px-4 py-2 text-right">On-time</th>
                  <th className="px-4 py-2 text-right">Cash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {riders.slice(0, 6).map((rider) => (
                  <tr key={rider.id || rider.fullName}>
                    <td className="px-4 py-2">
                      <p className="font-bold text-gray-950">{rider.fullName}</p>
                      <p className="text-xs text-gray-500">{rider.vehicleType || 'Rider'}{rider.status ? ` - ${title(rider.status)}` : ''}</p>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{rider.delivered || 0}</td>
                    <td className="px-4 py-2 text-right font-mono">{rider.active || 0}</td>
                    <td className="px-4 py-2 text-right font-mono">{formatPercent(rider.onTimePercent)}</td>
                    <td className="px-4 py-2 text-right font-mono">{money(rider.cashCollectedMinor || 0, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 p-4">
          <h4 className="text-sm font-black text-gray-950">Exception mix</h4>
          {exceptionRows.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No classified exceptions in this window.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {exceptionRows.map(([key, value]) => (
                <div key={key} className="flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2 text-sm">
                  <span className="font-bold text-gray-700">{title(key)}</span>
                  <span className="font-mono text-gray-500">{value}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
            Collected by riders: <span className="font-mono font-bold text-gray-900">{money(cash.collectedByRidersMinor || 0, currency)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function CashSettlementPanel({ ledger, currency = 'INR', canSettle, busyId, onSettle, onVoid }) {
  const pending = ledger?.pending || [];
  const settlements = ledger?.settlements || [];
  const totals = ledger?.totals || {};

  return (
    <section className="grid gap-4 xl:grid-cols-[1.1fr_1.4fr]">
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div>
            <h3 className="text-base font-black text-gray-950">Cash handovers</h3>
            <p className="mt-1 text-sm text-gray-500">{money(totals.pendingCashMinor || 0, currency)} pending from {totals.pendingRiderCount || 0} riders</p>
          </div>
        </div>
        {pending.length === 0 ? (
          <p className="p-5 text-sm text-gray-500">No unsettled rider cash in this window.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {pending.map((group) => (
              <div key={group.riderId || 'unassigned'} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-black text-gray-950">{group.rider?.fullName || 'Unassigned rider'}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {group.deliveryCount} deliveries
                      {group.firstDeliveredAt && group.lastDeliveredAt ? ` - ${formatShortDateTime(group.firstDeliveredAt)} to ${formatShortDateTime(group.lastDeliveredAt)}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-lg font-black text-gray-950">{money(group.expectedCashMinor || 0, group.currency || currency)}</p>
                    {canSettle && group.riderId && (
                      <button
                        type="button"
                        disabled={busyId === group.riderId}
                        onClick={() => onSettle(group)}
                        className="mt-2 rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                      >
                        {busyId === group.riderId ? 'Settling...' : 'Settle'}
                      </button>
                    )}
                  </div>
                </div>
                {Array.isArray(group.deliveries) && group.deliveries.length > 0 && (
                  <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-left font-bold uppercase tracking-wide text-gray-500">
                        <tr>
                          <th className="px-3 py-2">Delivery</th>
                          <th className="px-3 py-2">Delivered</th>
                          <th className="px-3 py-2 text-right">Received</th>
                          <th className="px-3 py-2 text-right">Change</th>
                          <th className="px-3 py-2 text-right">Net</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {group.deliveries.slice(0, 10).map((delivery) => (
                          <tr key={delivery.id}>
                            <td className="px-3 py-2">
                              <p className="font-bold text-gray-900">{delivery.sourceRef || `#${String(delivery.id).slice(-6).toUpperCase()}`}</p>
                              <p className="text-gray-500">{delivery.customerName || title(delivery.source || 'delivery')}</p>
                            </td>
                            <td className="px-3 py-2 text-gray-500">{formatShortDateTime(delivery.deliveredAt)}</td>
                            <td className="px-3 py-2 text-right font-mono">{money(delivery.cashReceivedMinor || delivery.cashCollectedMinor || 0, delivery.currency || group.currency || currency)}</td>
                            <td className="px-3 py-2 text-right font-mono">{money(delivery.cashChangeDueMinor || 0, delivery.currency || group.currency || currency)}</td>
                            <td className="px-3 py-2 text-right font-mono font-bold text-gray-950">{money(delivery.cashCollectedMinor || 0, delivery.currency || group.currency || currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {group.deliveries.length > 10 && (
                      <p className="border-t border-gray-100 px-3 py-2 text-xs font-semibold text-gray-500">
                        +{group.deliveries.length - 10} more deliveries
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-5 py-4">
          <h3 className="text-base font-black text-gray-950">Settlement ledger</h3>
          <p className="mt-1 text-sm text-gray-500">
            {money(totals.settledCashMinor || 0, currency)} settled
            {totals.varianceMinor ? ` - ${money(totals.varianceMinor, currency)} variance` : ''}
          </p>
        </div>
        {settlements.length === 0 ? (
          <p className="p-5 text-sm text-gray-500">No settlements recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-[10px] font-bold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Rider</th>
                  <th className="px-4 py-2 text-right">Expected</th>
                  <th className="px-4 py-2 text-right">Counted</th>
                  <th className="px-4 py-2 text-right">Variance</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {settlements.slice(0, 8).map((settlement) => (
                  <tr key={settlement.id}>
                    <td className="px-4 py-2">
                      <p className="font-bold text-gray-950">{settlement.rider?.fullName || 'Rider'}</p>
                      <p className="text-xs text-gray-500">{formatShortDateTime(settlement.settlementDate)} - {settlement.deliveryCount} deliveries</p>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{money(settlement.expectedCashMinor, settlement.currency || currency)}</td>
                    <td className="px-4 py-2 text-right font-mono">{money(settlement.countedCashMinor, settlement.currency || currency)}</td>
                    <td className={`px-4 py-2 text-right font-mono font-bold ${settlement.varianceMinor < 0 ? 'text-red-700' : settlement.varianceMinor > 0 ? 'text-emerald-700' : 'text-gray-700'}`}>
                      {money(settlement.varianceMinor || 0, settlement.currency || currency)}
                    </td>
                    <td className="px-4 py-2"><StatusBadge status={settlement.status} /></td>
                    <td className="px-4 py-2 text-right">
                      {canSettle && settlement.status !== 'VOID' && (
                        <button
                          type="button"
                          disabled={busyId === settlement.id}
                          onClick={() => onVoid(settlement)}
                          className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          {busyId === settlement.id ? 'Voiding...' : 'Void'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function DispatchRecommendationsPanel({
  recommendations,
  locations,
  riders,
  currency = 'INR',
  canEdit,
  busyId,
  selectedRiders,
  onSelectRider,
  onCreateRoute,
}) {
  const groups = recommendations?.groups || [];
  const locationById = useMemo(() => new Map((locations || []).map((location) => [location.id, location])), [locations]);

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div>
          <h3 className="text-base font-black text-gray-950">Dispatch recommendations</h3>
          <p className="mt-1 text-sm text-gray-500">Ready picked orders grouped into route-sized rider work.</p>
        </div>
        <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-black text-blue-700">
          {groups.length} route groups
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="p-5 text-sm text-gray-500">No fully picked delivery orders are waiting for route dispatch.</p>
      ) : (
        <div className="grid gap-4 p-5 xl:grid-cols-2">
          {groups.slice(0, 6).map((group) => {
            const location = group.locationId ? locationById.get(group.locationId) : null;
            const selectedRiderId = selectedRiders[group.id] || group.rider?.id || '';
            const selectedRider = riders.find((rider) => rider.id === selectedRiderId) || group.rider || null;
            const canDispatch = canEdit && group.locationId && selectedRiderId && group.orderIds?.length;
            return (
              <div key={group.id} className="rounded-xl border border-gray-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-black text-gray-950">{group.reason || `${group.stopCount} stops`}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {group.stopCount || 0} stops
                      {location?.name ? ` - ${location.name}` : group.city ? ` - ${title(group.city)}` : ''}
                      {group.dueAt ? ` - due ${formatClock(group.dueAt)}` : ''}
                    </p>
                  </div>
                  <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-black text-gray-700">
                    Score {group.score || 0}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="font-bold text-gray-500">Cash</p>
                    <p className="font-mono font-black text-gray-950">{money(group.cashToCollectMinor || 0, currency)}</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="font-bold text-gray-500">COD</p>
                    <p className="font-mono font-black text-gray-950">{group.metrics?.codOrders || 0}</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="font-bold text-gray-500">Window</p>
                    <p className="font-mono font-black text-gray-950">{group.metrics?.dueWindowMinutes || 0}m</p>
                  </div>
                </div>

                {group.rider ? (
                  <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                    <p className="font-black">Recommended: {group.rider.fullName}</p>
                    <p className="mt-0.5">
                      {group.rider.vehicleType || 'Rider'} - {group.rider.capacityStatus ? title(group.rider.capacityStatus) : 'Available'}
                      {group.rider.activeLoad != null ? ` - ${group.rider.activeLoad} active stops/jobs` : ''}
                    </p>
                  </div>
                ) : (
                  <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                    No checked-in rider available for this group.
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
                  <label className="min-w-[220px] flex-1">
                    <span className="mb-1 block text-xs font-bold text-gray-600">Rider</span>
                    <select
                      value={selectedRiderId}
                      onChange={(event) => onSelectRider(group.id, event.target.value)}
                      disabled={!canEdit}
                      className="w-full rounded-lg border border-gray-300 px-2 py-2 text-xs focus:border-gray-950 focus:outline-none disabled:opacity-50"
                    >
                      <option value="">Choose checked-in rider</option>
                      {riders.map((rider) => (
                        <option key={rider.id} value={rider.id}>{rider.fullName} - {rider.vehicleType}</option>
                      ))}
                    </select>
                    {selectedRider && (
                      <span className="mt-1 block text-[11px] text-gray-500">
                        {selectedRider.fullName || 'Selected rider'}
                      </span>
                    )}
                  </label>
                  <button
                    type="button"
                    disabled={!canDispatch || busyId === group.id}
                    onClick={() => onCreateRoute(group, selectedRiderId)}
                    className="rounded-xl bg-gray-950 px-4 py-2 text-xs font-black text-white hover:bg-gray-800 disabled:opacity-40"
                  >
                    {busyId === group.id ? 'Dispatching...' : 'Dispatch route'}
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap gap-1">
                  {(group.orderIds || []).slice(0, 8).map((id) => (
                    <span key={id} className="rounded bg-gray-100 px-2 py-1 font-mono text-[10px] font-bold text-gray-600">
                      {id.slice(0, 8)}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ActiveRoutesPanel({
  routes,
  riders,
  currency = 'INR',
  canEdit,
  busyId,
  selectedRiders,
  onSelectRider,
  onReassign,
  onComplete,
  onCancel,
}) {
  const activeRoutes = (routes || []).filter((route) => !['COMPLETED', 'CANCELLED'].includes(String(route.status || '').toUpperCase()));
  const recentRoutes = (routes || []).filter((route) => ['COMPLETED', 'CANCELLED'].includes(String(route.status || '').toUpperCase())).slice(0, 4);
  const rows = activeRoutes.length ? activeRoutes : recentRoutes;

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div>
          <h3 className="text-base font-black text-gray-950">Active routes</h3>
          <p className="mt-1 text-sm text-gray-500">Monitor dispatched rider routes, reassign work, or close exceptions.</p>
        </div>
        <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-black text-sky-700">
          {activeRoutes.length} active
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="p-5 text-sm text-gray-500">No dispatched routes yet.</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {rows.map((route) => {
            const progress = routeProgress(route);
            const closed = ['COMPLETED', 'CANCELLED'].includes(String(route.status || '').toUpperCase());
            const selectedRiderId = selectedRiders[route.id] || route.riderId || '';
            const busy = busyId === `route:${route.id}`;
            return (
              <div key={route.id} className="p-5">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
                  <div>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-mono text-sm font-black text-gray-950">{route.code}</p>
                          <StatusBadge status={route.status} />
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                          {route.location?.name || 'Dispatch location'}
                          {route.dispatchedAt ? ` - dispatched ${formatShortDateTime(route.dispatchedAt)}` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-sm font-black text-gray-950">{progress.closed}/{progress.total} closed</p>
                        <p className="text-xs text-gray-500">{progress.delivered} delivered, {progress.failed + progress.skipped} returned/failed</p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-2 md:grid-cols-4">
                      <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs">
                        <p className="font-bold text-gray-500">Rider</p>
                        <p className="font-bold text-gray-950">{route.rider?.fullName || 'Unassigned'}</p>
                      </div>
                      <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs">
                        <p className="font-bold text-gray-500">Cash due</p>
                        <p className="font-mono font-black text-gray-950">{money(route.cashToCollectMinor || 0, currency)}</p>
                      </div>
                      <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs">
                        <p className="font-bold text-gray-500">Cash collected</p>
                        <p className="font-mono font-black text-gray-950">{money(route.cashCollectedMinor || 0, currency)}</p>
                      </div>
                      <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs">
                        <p className="font-bold text-gray-500">Open stops</p>
                        <p className="font-mono font-black text-gray-950">{progress.active}</p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1">
                      {(route.stops || []).slice(0, 12).map((stop) => (
                        <span
                          key={stop.id}
                          className={`rounded px-2 py-1 font-mono text-[10px] font-bold ${
                            stop.status === 'DELIVERED'
                              ? 'bg-emerald-50 text-emerald-700'
                              : ['ATTEMPTED_FAILED', 'SKIPPED'].includes(stop.status)
                                ? 'bg-red-50 text-red-700'
                                : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {stop.sequence}:{title(stop.status)}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-gray-600">Assigned rider</span>
                      <select
                        value={selectedRiderId}
                        onChange={(event) => onSelectRider(route.id, event.target.value)}
                        disabled={!canEdit || closed}
                        className="w-full rounded-lg border border-gray-300 px-2 py-2 text-xs focus:border-gray-950 focus:outline-none disabled:opacity-50"
                      >
                        <option value="">Choose checked-in rider</option>
                        {riders.map((rider) => (
                          <option key={rider.id} value={rider.id}>{rider.fullName} - {rider.vehicleType}</option>
                        ))}
                      </select>
                    </label>
                    {canEdit && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy || closed || !selectedRiderId || selectedRiderId === route.riderId}
                          onClick={() => onReassign(route, selectedRiderId)}
                          className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                        >
                          {busy ? 'Saving...' : 'Reassign'}
                        </button>
                        <button
                          type="button"
                          disabled={busy || closed || progress.active > 0}
                          onClick={() => onComplete(route)}
                          className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                        >
                          {progress.active > 0 ? 'Close stops first' : 'Complete'}
                        </button>
                        <button
                          type="button"
                          disabled={busy || closed}
                          onClick={() => onCancel(route)}
                          className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function DeliveriesPanel() {
  const { tenant } = useTenant();
  const { active: activeLocation, locations } = useEcommerceLocation();
  const { has } = useEcomAccess();
  const canEdit = has('orders.edit');
  const canSettle = has('finance.settle');
  const businessCurrency = tenant?.business?.defaultCurrency || 'INR';
  const [rows, setRows] = useState([]);
  const [riders, setRiders] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [settlementLedger, setSettlementLedger] = useState(null);
  const [dispatchRecommendations, setDispatchRecommendations] = useState(null);
  const [deliveryRoutes, setDeliveryRoutes] = useState([]);
  const [analyticsDays, setAnalyticsDays] = useState(30);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [settlementBusyId, setSettlementBusyId] = useState('');
  const [routeBusyId, setRouteBusyId] = useState('');
  const [assignments, setAssignments] = useState({});
  const [dispatchRiders, setDispatchRiders] = useState({});
  const [routeAssignments, setRouteAssignments] = useState({});
  const [error, setError] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams({ pageSize: '100' });
    if (status !== 'all') params.set('status', status);
    if (search.trim()) params.set('q', search.trim());
    if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
    return params.toString();
  }, [activeLocation, search, status]);

  const analyticsQuery = useMemo(() => {
    const params = new URLSearchParams({ days: String(analyticsDays) });
    if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
    return params.toString();
  }, [activeLocation, analyticsDays]);

  const dispatchQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
    return params.toString();
  }, [activeLocation]);

  const stats = useMemo(() => {
    const terminal = new Set(['DELIVERED', 'CANCELLED', 'RETURNED']);
    return {
      active: rows.filter((row) => !terminal.has(row.status)).length,
      unassigned: rows.filter((row) => !row.riderId && !terminal.has(row.status)).length,
      atRisk: rows.filter((row) => ['BREACHED', 'AT_RISK', 'DUE_SOON'].includes(row.dispatch?.slaStatus)).length,
      cod: rows.reduce((sum, row) => terminal.has(row.status) ? sum : sum + Number(row.cashToCollectMinor || 0), 0),
      exceptions: rows.filter((row) => ['ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED'].includes(row.status) || ['OPEN', 'ESCALATED'].includes(row.exceptionStatus)).length,
    };
  }, [rows]);
  const checkedInRiders = useMemo(() => riders.filter(isCheckedInRider), [riders]);

  const trackingBase = useMemo(() => {
    const business = tenant?.business || {};
    const activeCustomDomain = String(business.customDomainStatus || '').toUpperCase() === 'ACTIVE'
      ? business.customDomain
      : null;
    return { slug: business.slug, activeCustomDomain };
  }, [tenant?.business]);

  const trackingHref = useCallback((row) => {
    if (row.trackingUrl) return row.trackingUrl;
    if (!row.trackingToken) return null;
    return getTenantStorefrontUrl(
      trackingBase.slug,
      `/delivery/${encodeURIComponent(row.trackingToken)}`,
      trackingBase.activeCustomDomain
    );
  }, [trackingBase]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const riderQuery = new URLSearchParams({ status: 'ACTIVE', pageSize: '100' });
      if (activeLocation && activeLocation !== 'ALL') riderQuery.set('locationId', activeLocation);
      const [deliveryData, riderData, analyticsData, settlementData, dispatchData, routeData] = await Promise.all([
        api(`/api/ecom/deliveries?${query}&sort=dispatch`),
        api(`/api/ecom/riders?${riderQuery.toString()}`),
        api(`/api/ecom/deliveries/analytics?${analyticsQuery}`),
        api(`/api/ecom/deliveries/settlements?${analyticsQuery}`),
        api(`/api/ecom/dispatch/recommendations${dispatchQuery ? `?${dispatchQuery}` : ''}`).catch(() => ({ recommendations: null })),
        api(`/api/ecom/dispatch/routes${dispatchQuery ? `?${dispatchQuery}` : ''}`).catch(() => ({ routes: [] })),
      ]);
      setRows(deliveryData.rows || []);
      setRiders(riderData.rows || []);
      setAnalytics(analyticsData || null);
      setSettlementLedger(settlementData || null);
      setDispatchRecommendations(dispatchData.recommendations || null);
      setDeliveryRoutes(routeData.routes || []);
    } catch (err) {
      setError(err.message || 'Could not load deliveries');
    } finally {
      setLoading(false);
    }
  }, [activeLocation, analyticsQuery, dispatchQuery, query]);

  useEffect(() => { load(); }, [load]);

  async function advance(row) {
    const next = nextStatus(row);
    if (!next) return;
    setBusyId(row.id);
    setError('');
    try {
      const payload = { status: next };
      if (next === 'DELIVERED' && row.paymentMethod === 'cod' && row.cashToCollectMinor > 0) {
        payload.cashReceivedMinor = row.cashToCollectMinor;
        payload.cashCollectedMinor = row.cashToCollectMinor;
      }
      await api(`/api/ecom/deliveries/${row.id}/status`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not update delivery');
    } finally {
      setBusyId('');
    }
  }

  async function cancel(row) {
    if (!window.confirm(`Cancel delivery for ${row.customerName}?`)) return;
    setBusyId(row.id);
    setError('');
    try {
      await api(`/api/ecom/deliveries/${row.id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (err) {
      setError(err.message || 'Could not cancel delivery');
    } finally {
      setBusyId('');
    }
  }

  async function retryNow(row) {
    setBusyId(row.id);
    setError('');
    try {
      await api(`/api/ecom/deliveries/${row.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'READY_FOR_DISPATCH', riderId: null, nextAttemptAt: null }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not retry delivery');
    } finally {
      setBusyId('');
    }
  }

  function scheduleRetry(row) {
    const value = window.prompt('Schedule next attempt:', formatDateTimeLocalValue(row.nextAttemptAt));
    if (value === null) return;
    const retryAt = new Date(value);
    if (!value || Number.isNaN(retryAt.getTime())) {
      setError('Enter a valid retry date and time');
      return;
    }
    updateException(row, {
      exceptionCode: row.exceptionCode || 'OTHER',
      exceptionStatus: row.exceptionStatus === 'ESCALATED' ? 'ESCALATED' : 'OPEN',
      exceptionNote: row.exceptionNote || row.failureReason || 'Retry scheduled',
      nextAttemptAt: retryAt.toISOString(),
    });
  }

  async function updateException(row, payload) {
    setBusyId(row.id);
    setError('');
    try {
      await api(`/api/ecom/deliveries/${row.id}/exception`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not update exception');
    } finally {
      setBusyId('');
    }
  }

  function classifyException(row, exceptionCode) {
    if (!exceptionCode) return;
    updateException(row, {
      exceptionCode,
      exceptionStatus: row.exceptionStatus === 'ESCALATED' ? 'ESCALATED' : 'OPEN',
      exceptionNote: row.failureReason || row.exceptionNote || EXCEPTION_OPTIONS.find((item) => item.value === exceptionCode)?.label || 'Delivery exception',
    });
  }

  function escalateException(row) {
    const note = window.prompt(`Escalate delivery for ${row.customerName}? Add a note:`, row.exceptionNote || row.failureReason || '');
    if (note === null) return;
    updateException(row, {
      exceptionCode: row.exceptionCode || 'OTHER',
      exceptionStatus: 'ESCALATED',
      exceptionNote: note || row.exceptionNote || row.failureReason || 'Escalated by dispatcher',
    });
  }

  function resolveException(row) {
    const note = window.prompt(`Resolve exception for ${row.customerName}? Add resolution note:`, row.exceptionResolutionNote || '');
    if (note === null) return;
    updateException(row, {
      exceptionCode: row.exceptionCode || 'OTHER',
      exceptionStatus: 'RESOLVED',
      exceptionResolutionNote: note || 'Resolved by dispatcher',
    });
  }

  async function assign(row) {
    const riderId = assignments[row.id] || '';
    if (!riderId) return;
    setBusyId(row.id);
    setError('');
    try {
      await api(`/api/ecom/deliveries/${row.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'ASSIGNED', riderId }),
      });
      setAssignments((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not assign rider');
    } finally {
      setBusyId('');
    }
  }

  async function settleCash(group) {
    if (!group?.riderId) return;
    const defaultAmount = (Number(group.expectedCashMinor || 0) / 100).toFixed(2);
    const counted = window.prompt(`Cash counted for ${group.rider?.fullName || 'rider'}:`, defaultAmount);
    if (counted === null) return;
    const countedMajor = Number(counted);
    if (!Number.isFinite(countedMajor) || countedMajor < 0) {
      setError('Enter a valid counted cash amount');
      return;
    }
    setSettlementBusyId(group.riderId);
    setError('');
    try {
      await api('/api/ecom/deliveries/settlements', {
        method: 'POST',
        body: JSON.stringify({
          riderId: group.riderId,
          locationId: group.locationId || undefined,
          currency: group.currency || businessCurrency,
          countedCashMinor: Math.round(countedMajor * 100),
          deliveryIds: group.deliveryIds || [],
          fromAt: group.firstDeliveredAt || undefined,
          toAt: group.lastDeliveredAt || undefined,
          notes: 'End-of-shift rider cash handover',
        }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not settle rider cash');
    } finally {
      setSettlementBusyId('');
    }
  }

  async function voidSettlement(settlement) {
    const reason = window.prompt(`Void settlement for ${settlement.rider?.fullName || 'rider'}? Add a reason:`, '');
    if (reason === null) return;
    setSettlementBusyId(settlement.id);
    setError('');
    try {
      await api(`/api/ecom/deliveries/settlements/${settlement.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not void cash settlement');
    } finally {
      setSettlementBusyId('');
    }
  }

  function selectDispatchRider(groupId, riderId) {
    setDispatchRiders((current) => ({ ...current, [groupId]: riderId }));
  }

  function selectRouteRider(routeId, riderId) {
    setRouteAssignments((current) => ({ ...current, [routeId]: riderId }));
  }

  async function createRecommendedRoute(group, riderId) {
    if (!group?.orderIds?.length || !riderId) return;
    if (!group.locationId || group.locationId === 'ALL') {
      setError('Choose a specific location before dispatching this route');
      return;
    }
    setRouteBusyId(group.id);
    setError('');
    try {
      await api('/api/ecom/dispatch/routes', {
        method: 'POST',
        body: JSON.stringify({
          locationId: group.locationId,
          riderId,
          orderIds: group.orderIds,
          notes: group.reason || undefined,
        }),
      });
      setDispatchRiders((current) => {
        const next = { ...current };
        delete next[group.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not dispatch route');
    } finally {
      setRouteBusyId('');
    }
  }

  async function reassignRoute(route, riderId) {
    if (!route?.id || !riderId || riderId === route.riderId) return;
    setRouteBusyId(`route:${route.id}`);
    setError('');
    try {
      await api(`/api/ecom/dispatch/routes/${route.id}`, {
        method: 'PUT',
        body: JSON.stringify({ riderId }),
      });
      setRouteAssignments((current) => {
        const next = { ...current };
        delete next[route.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not reassign route');
    } finally {
      setRouteBusyId('');
    }
  }

  async function completeRoute(route) {
    if (!route?.id) return;
    if (!window.confirm(`Mark route ${route.code} complete?`)) return;
    setRouteBusyId(`route:${route.id}`);
    setError('');
    try {
      await api(`/api/ecom/dispatch/routes/${route.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not complete route');
    } finally {
      setRouteBusyId('');
    }
  }

  async function cancelRoute(route) {
    if (!route?.id) return;
    const reason = window.prompt(`Cancel route ${route.code}? Orders return to dispatch queue.`, route.notes || '');
    if (reason === null) return;
    setRouteBusyId(`route:${route.id}`);
    setError('');
    try {
      await api(`/api/ecom/dispatch/routes/${route.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not cancel route');
    } finally {
      setRouteBusyId('');
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-600">AapkaRider</p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-gray-950">Delivery requests</h2>
            <p className="mt-1 text-sm text-gray-500">Manual, API, and DriftHR delivery jobs in one queue.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search customer, phone, or external ref"
              className="min-w-[260px] rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-gray-950 focus:outline-none"
            />
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-gray-950 focus:outline-none"
            >
              <option value="all">All statuses</option>
              {STATUSES.map((item) => <option key={item} value={item}>{title(item)}</option>)}
            </select>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm font-bold text-gray-700 hover:border-gray-950 disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>
      </section>

      {canEdit && (
        <DeliveryForm
          locations={locations}
          riders={checkedInRiders}
          activeLocation={activeLocation}
          onCreated={load}
        />
      )}

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <section className="grid gap-3 md:grid-cols-5">
        {[
          { label: 'Active', value: stats.active },
          { label: 'Unassigned', value: stats.unassigned },
          { label: 'At risk', value: stats.atRisk },
          { label: 'COD due', value: money(stats.cod) },
          { label: 'Exceptions', value: stats.exceptions },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="text-xs font-bold text-gray-500">{item.label}</p>
            <p className="mt-1 text-2xl font-black text-gray-950">{item.value}</p>
          </div>
        ))}
      </section>

      <OperationsReport
        analytics={analytics}
        days={analyticsDays}
        onDaysChange={setAnalyticsDays}
        currency={businessCurrency}
      />

      <DispatchRecommendationsPanel
        recommendations={dispatchRecommendations}
        locations={locations}
        riders={checkedInRiders}
        currency={businessCurrency}
        canEdit={canEdit}
        busyId={routeBusyId}
        selectedRiders={dispatchRiders}
        onSelectRider={selectDispatchRider}
        onCreateRoute={createRecommendedRoute}
      />

      <ActiveRoutesPanel
        routes={deliveryRoutes}
        riders={checkedInRiders}
        currency={businessCurrency}
        canEdit={canEdit}
        busyId={routeBusyId}
        selectedRiders={routeAssignments}
        onSelectRider={selectRouteRider}
        onReassign={reassignRoute}
        onComplete={completeRoute}
        onCancel={cancelRoute}
      />

      <CashSettlementPanel
        ledger={settlementLedger}
        currency={businessCurrency}
        canSettle={canSettle}
        busyId={settlementBusyId}
        onSettle={settleCash}
        onVoid={voidSettlement}
      />

      <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 p-4">
          <h3 className="text-base font-black text-gray-950">Delivery queue</h3>
        </div>
        {loading ? (
          <p className="p-10 text-center text-sm text-gray-500">Loading deliveries...</p>
        ) : rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-gray-500">No delivery requests yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3">Delivery</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Dropoff</th>
                  <th className="px-4 py-3">Rider</th>
                  <th className="px-4 py-3">SLA</th>
                  <th className="px-4 py-3">Cash</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => {
                  const next = nextStatus(row);
                  const dropoff = [row.dropoffAddress1, row.dropoffCity, row.dropoffPostalCode].filter(Boolean).join(', ');
                  const riderMapHref = mapsHrefForLocation(row.latestLocation);
                  return (
                    <tr key={row.id} className="align-top hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-bold text-gray-950">{row.sourceRef || row.id.slice(0, 8)}</p>
                        <p className="mt-1 text-xs text-gray-500">{title(row.source)} {row.channel ? `- ${row.channel}` : ''}</p>
                        {(trackingHref(row) || riderMapHref) && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {trackingHref(row) && (
                              <a
                                href={trackingHref(row)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex rounded-lg border border-gray-200 px-2 py-1 text-xs font-bold text-gray-700 no-underline hover:border-gray-950"
                              >
                                Track
                              </a>
                            )}
                            {riderMapHref && (
                              <a
                                href={riderMapHref}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex rounded-lg border border-emerald-200 px-2 py-1 text-xs font-bold text-emerald-700 no-underline hover:bg-emerald-50"
                              >
                                Rider map
                              </a>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-bold text-gray-950">{row.customerName}</p>
                        <p className="text-xs text-gray-500">{row.customerPhone || row.customerEmail || 'No contact'}</p>
                        {row.customerRating && (
                          <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                            <span className="font-black">{formatRating(row.customerRating)}</span>
                            {row.customerFeedback && <p className="mt-1 line-clamp-2 text-emerald-700">{row.customerFeedback}</p>}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 max-w-xs text-gray-700">{dropoff || 'No address'}</td>
                      <td className="px-4 py-3 text-gray-700">
                        {row.rider?.fullName ? (
                          <span>{row.rider.fullName}</span>
                        ) : canEdit && !['DELIVERED', 'CANCELLED', 'RETURNED'].includes(row.status) ? (
                          <div className="min-w-[180px] space-y-2">
                            <select
                              value={assignments[row.id] || ''}
                              onChange={(event) => setAssignments((current) => ({ ...current, [row.id]: event.target.value }))}
                              className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs focus:border-gray-950 focus:outline-none"
                            >
                              <option value="">Assign rider</option>
                              {checkedInRiders.map((rider) => <option key={rider.id} value={rider.id}>{rider.fullName}</option>)}
                            </select>
                            <button
                              type="button"
                              disabled={busyId === row.id || !assignments[row.id]}
                              onClick={() => assign(row)}
                              className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                            >
                              {busyId === row.id ? 'Assigning...' : 'Assign'}
                            </button>
                          </div>
                        ) : (
                          <span>Unassigned</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        <SlaBadge dispatch={row.dispatch} />
                        <p className="mt-1 text-xs font-semibold text-gray-900">{row.dispatch?.recommendedAction || 'Monitor delivery'}</p>
                        {row.dispatch?.dueAt && (
                          <p className="text-xs text-gray-500">
                            Due {formatClock(row.dispatch.dueAt)}
                            {row.dispatch.minutesUntilDue != null ? ` - ${formatMinutes(row.dispatch.minutesUntilDue)}` : ''}
                          </p>
                        )}
                        {row.dispatch?.eta?.estimatedArrivalAt && (
                          <p className="text-xs text-gray-500">ETA {formatClock(row.dispatch.eta.estimatedArrivalAt)}</p>
                        )}
                        {row.attemptCount > 0 && (
                          <p className="text-xs text-gray-500">Attempt {row.attemptCount}</p>
                        )}
                        {row.nextAttemptAt && (
                          <p className={`text-xs ${row.dispatch?.retry?.isDue ? 'font-bold text-orange-700' : 'text-gray-500'}`}>
                            {row.dispatch?.retry?.isDue ? 'Retry due' : 'Retry'} {formatShortDateTime(row.nextAttemptAt)}
                          </p>
                        )}
                        {row.exceptionStatus && (
                          <p className={`mt-1 text-xs font-bold ${row.exceptionStatus === 'ESCALATED' ? 'text-red-700' : row.exceptionStatus === 'RESOLVED' ? 'text-emerald-700' : 'text-orange-700'}`}>
                            {title(row.exceptionStatus)}{row.exceptionCode ? ` - ${title(row.exceptionCode)}` : ''}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-gray-950">
                        {row.cashToCollectMinor ? money(row.cashToCollectMinor, row.currency) : '-'}
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                      <td className="px-4 py-3 text-right">
                        {row.proofPhotoUrl && (
                          <a
                            href={row.proofPhotoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mb-2 inline-flex rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-bold text-emerald-700 no-underline hover:bg-emerald-50"
                          >
                            Proof
                          </a>
                        )}
                        {row.proofSignatureUrl && (
                          <a
                            href={row.proofSignatureUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mb-2 ml-2 inline-flex rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-700 no-underline hover:bg-indigo-50"
                          >
                            Signature
                          </a>
                        )}
                        {canEdit && (
                          <div className="flex justify-end gap-2">
                            {(row.status === 'ATTEMPTED_FAILED' || ['OPEN', 'ESCALATED'].includes(row.exceptionStatus)) && (
                              <div className="flex max-w-[260px] flex-wrap justify-end gap-2">
                                <select
                                  value={row.exceptionCode || ''}
                                  onChange={(event) => classifyException(row, event.target.value)}
                                  disabled={busyId === row.id}
                                  className="rounded-lg border border-orange-200 px-2 py-1.5 text-xs font-semibold text-orange-800 focus:border-orange-500 focus:outline-none disabled:opacity-50"
                                >
                                  <option value="">Classify</option>
                                  {EXCEPTION_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                                </select>
                                {row.exceptionStatus !== 'ESCALATED' && (
                                  <button
                                    type="button"
                                    disabled={busyId === row.id}
                                    onClick={() => escalateException(row)}
                                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
                                  >
                                    Escalate
                                  </button>
                                )}
                                {row.exceptionStatus && row.exceptionStatus !== 'RESOLVED' && (
                                  <button
                                    type="button"
                                    disabled={busyId === row.id}
                                    onClick={() => resolveException(row)}
                                    className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                                  >
                                    Resolve
                                  </button>
                                )}
                              </div>
                            )}
                            {row.status === 'ATTEMPTED_FAILED' && (
                              <>
                                <button
                                  type="button"
                                  disabled={busyId === row.id}
                                  onClick={() => scheduleRetry(row)}
                                  className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                                >
                                  Schedule
                                </button>
                                <button
                                  type="button"
                                  disabled={busyId === row.id}
                                  onClick={() => retryNow(row)}
                                  className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                                >
                                  {busyId === row.id ? 'Saving...' : 'Retry now'}
                                </button>
                              </>
                            )}
                            {next && (
                              <button
                                type="button"
                                disabled={busyId === row.id}
                                onClick={() => advance(row)}
                                className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                              >
                                {busyId === row.id ? 'Saving...' : title(next)}
                              </button>
                            )}
                            {!['DELIVERED', 'CANCELLED', 'RETURNED'].includes(row.status) && (
                              <button
                                type="button"
                                disabled={busyId === row.id}
                                onClick={() => cancel(row)}
                                className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

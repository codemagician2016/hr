'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — real SlotsPanel.
// Backend: /api/ecom/slots + /api/ecom/slots/availability (Phase 3c).

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import {
  KpiCard, KpiGrid,
  PageHeader, EmptyState, ErrorBanner, PrimaryButton,
  fmtNumber,
} from '@/components/ecom-ui';

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

const SLOT_TYPES = [
  { key: 'STANDARD', label: 'Standard' },
  { key: 'EXPRESS',  label: 'Express (60-min)' },
  { key: 'SAME_DAY', label: 'Same-day' },
  { key: 'NEXT_DAY', label: 'Next-day' },
  { key: 'SCHEDULED', label: 'Scheduled' },
];

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatMoney(minor) {
  if (!minor) return '—';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: 'GBP', maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `£${(minor / 100).toFixed(2)}`;
  }
}

function SlotForm({ initial, locations, defaultLocationId, onSave, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => ({
    locationId: initial?.locationId || defaultLocationId || '',
    mode: initial?.specificDate ? 'oneoff' : 'recurring',
    dayOfWeek: initial?.dayOfWeek ?? 1,
    specificDate: initial?.specificDate ? initial.specificDate.slice(0, 10) : '',
    startTime: initial?.startTime || '08:00',
    endTime: initial?.endTime || '10:00',
    capacity: initial?.capacity || 20,
    surchargeMinor: initial?.surchargeMinor || 0,
    slotType: initial?.slotType || 'STANDARD',
    freeDeliveryThresholdMinor: initial?.freeDeliveryThresholdMinor || 0,
    notes: initial?.notes || '',
  }));

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.locationId) { setError('Pick a location'); return; }
    if (form.startTime >= form.endTime) { setError('End time must be after start time'); return; }
    if (form.mode === 'oneoff' && !form.specificDate) { setError('Pick a date for one-off slot'); return; }

    setBusy(true);
    setError('');
    try {
      const payload = {
        locationId: form.locationId,
        startTime: form.startTime,
        endTime: form.endTime,
        capacity: Number(form.capacity),
        surchargeMinor: Number(form.surchargeMinor),
        slotType: form.slotType,
        freeDeliveryThresholdMinor: Number(form.freeDeliveryThresholdMinor),
      };
      if (form.notes.trim()) payload.notes = form.notes.trim();
      if (form.mode === 'recurring') {
        payload.dayOfWeek = Number(form.dayOfWeek);
      } else {
        payload.specificDate = new Date(form.specificDate).toISOString();
      }

      if (initial?.id) {
        // PUT supports a partial — strip locationId since it's immutable
        // server-side via the route definition.
        const { locationId, ...putPayload } = payload;
        await api(`/api/ecom/slots/${initial.id}`, { method: 'PUT', body: JSON.stringify(putPayload) });
      } else {
        await api('/api/ecom/slots', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSave?.();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Location *</label>
          <select value={form.locationId} onChange={set('locationId')} disabled={!!initial?.id}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500 disabled:bg-gray-50 disabled:text-gray-500">
            <option value="">— Pick location —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Slot mode</label>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            {[
              { key: 'recurring', label: 'Recurring (weekly)' },
              { key: 'oneoff',    label: 'One-off (specific date)' },
            ].map((m) => (
              <button key={m.key} type="button" onClick={() => setForm((f) => ({ ...f, mode: m.key }))}
                className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  form.mode === m.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}>{m.label}</button>
            ))}
          </div>
        </div>
        {form.mode === 'recurring' ? (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Day of week *</label>
            <select value={form.dayOfWeek} onChange={set('dayOfWeek')}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
              {DOW_LABELS.map((label, i) => <option key={i} value={i}>{label}</option>)}
            </select>
          </div>
        ) : (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Date *</label>
            <input type="date" value={form.specificDate} onChange={set('specificDate')}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Slot type</label>
          <select value={form.slotType} onChange={set('slotType')}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
            {SLOT_TYPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Start *</label>
          <input type="time" value={form.startTime} onChange={set('startTime')}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">End *</label>
          <input type="time" value={form.endTime} onChange={set('endTime')}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Capacity (orders)</label>
          <input type="number" value={form.capacity} onChange={set('capacity')} min="1" max="10000"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Surcharge (pence)</label>
          <input type="number" value={form.surchargeMinor} onChange={set('surchargeMinor')} min="0"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Free delivery threshold (pence) — 0 = inherit from location</label>
          <input type="number" value={form.freeDeliveryThresholdMinor} onChange={set('freeDeliveryThresholdMinor')} min="0"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
        </div>
      </div>
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400">Cancel</button>
        <button type="submit" disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? 'Saving…' : initial?.id ? 'Save changes' : 'Add slot'}
        </button>
      </div>
    </form>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-2xl w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function SlotsPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { active: activeLocation, locations } = useEcommerceLocation();
  const urlView = searchParams.get('view') || '';
  const urlId = searchParams.get('id') || '';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const replaceSlotQuery = useCallback((mutate) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(params.toString() ? `?${params.toString()}` : window.location.pathname, { scroll: false });
  }, [router, searchParams]);

  const openEditor = useCallback((slot = {}) => {
    setEditing(slot);
    replaceSlotQuery((params) => {
      params.set('view', slot.id ? 'ecom-slot-edit' : 'ecom-slot-create');
      if (slot.id) params.set('id', slot.id);
      else params.delete('id');
    });
  }, [replaceSlotQuery]);

  const closeEditor = useCallback(() => {
    setEditing(null);
    replaceSlotQuery((params) => {
      params.delete('view');
      params.delete('id');
    });
  }, [replaceSlotQuery]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      params.set('pageSize', '100');
      const list = await api(`/api/ecom/slots?${params.toString()}`);
      setRows(list.rows || []);
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [activeLocation]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (urlView === 'ecom-slot-create') {
      setEditing({});
      return;
    }
    if (urlView === 'ecom-slot-edit' && urlId) {
      const row = rows.find((slot) => slot.id === urlId);
      if (row) setEditing(row);
      return;
    }
    setEditing(null);
  }, [rows, urlId, urlView]);

  async function deactivate(slot) {
    if (!window.confirm(`Deactivate this ${slot.startTime}–${slot.endTime} slot? Existing bookings stay queryable.`)) return;
    try {
      await api(`/api/ecom/slots/${slot.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  // Group by day-of-week for the recurring grid; one-off slots get their own section.
  const byDay = useMemo(() => {
    const days = Array.from({ length: 7 }, () => []);
    const oneOff = [];
    for (const s of rows) {
      if (s.specificDate) oneOff.push(s);
      else if (typeof s.dayOfWeek === 'number') days[s.dayOfWeek].push(s);
    }
    days.forEach((d) => d.sort((a, b) => a.startTime.localeCompare(b.startTime)));
    oneOff.sort((a, b) => (a.specificDate || '').localeCompare(b.specificDate || ''));
    return { days, oneOff };
  }, [rows]);

  // KPIs derived from the loaded slot definitions. Owner sees coverage at
  // a glance (which day has zero capacity, how many express slots, etc.)
  // before drilling into the grid.
  const kpis = useMemo(() => {
    const active = rows.filter((s) => s.isActive);
    const weeklyCapacity = byDay.days.reduce(
      (sum, day) => sum + day.filter((s) => s.isActive).reduce((d, s) => d + (s.capacity || 0), 0),
      0,
    );
    const byType = {};
    for (const s of active) byType[s.slotType] = (byType[s.slotType] || 0) + 1;
    const daysWithNoSlots = byDay.days.filter((d) => d.filter((s) => s.isActive).length === 0).length;
    return {
      active: active.length,
      inactive: rows.length - active.length,
      weeklyCapacity,
      express: byType.EXPRESS || 0,
      sameDay: byType.SAME_DAY || 0,
      oneOff: byDay.oneOff.length,
      daysWithNoSlots,
    };
  }, [rows, byDay]);

  const showLocationPicker = activeLocation === 'ALL';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Delivery slots"
        subtitle={
          showLocationPicker
            ? `${rows.length} slots across ${locations.length} locations · recurring + one-offs`
            : `${rows.length} slots configured · recurring + one-offs`
        }
        actions={
          <PrimaryButton onClick={() => openEditor({})} disabled={locations.length === 0}>
            + Add slot
          </PrimaryButton>
        }
      />

      {locations.length === 0 ? (
        <EmptyState
          title="Set up a location first"
          message="Delivery slots are scoped to a specific store/warehouse location. Open the Locations tab to add your first one, then come back here."
        />
      ) : rows.length > 0 && (
        <KpiGrid cols={4}>
          <KpiCard label="Active slots" value={fmtNumber(kpis.active)} tone="success"
            hint={kpis.inactive > 0 ? `${kpis.inactive} inactive` : null} />
          <KpiCard label="Weekly capacity" value={fmtNumber(kpis.weeklyCapacity)}
            hint="Total order slots / week"
            tone={kpis.daysWithNoSlots > 0 ? 'warning' : 'success'} />
          <KpiCard label="Express + same-day" value={fmtNumber(kpis.express + kpis.sameDay)}
            hint={`${kpis.express} express · ${kpis.sameDay} same-day`} />
          <KpiCard label="One-off overrides" value={fmtNumber(kpis.oneOff)}
            hint="Holiday hours, peak days" />
        </KpiGrid>
      )}

      {kpis.daysWithNoSlots > 0 && rows.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800 flex items-center gap-2">
          <span className="text-base">⚠</span>
          <span>{kpis.daysWithNoSlots} day{kpis.daysWithNoSlots === 1 ? ' has' : 's have'} no active slots — customers can't book deliveries on those days.</span>
        </div>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Weekly grid */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Recurring (weekly)</h3>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-7 divide-y lg:divide-y-0 lg:divide-x divide-gray-100">
          {DOW_LABELS.map((label, i) => (
            <div key={i} className="p-4 min-h-[140px]">
              <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500 mb-3">{label}</p>
              {byDay.days[i].length === 0 ? (
                <p className="text-xs text-gray-400">No slots</p>
              ) : (
                <div className="space-y-2">
                  {byDay.days[i].map((s) => (
                    <SlotChip key={s.id} slot={s} onEdit={() => openEditor(s)} onDeactivate={() => deactivate(s)} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* One-offs */}
      {byDay.oneOff.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">One-off slots</h3>
            <p className="text-xs text-gray-500 mt-0.5">Specific-date overrides — peak days, holiday hours, etc.</p>
          </div>
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {byDay.oneOff.map((s) => (
              <div key={s.id} className="border border-gray-200 rounded-xl p-3">
                <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">
                  {new Date(s.specificDate).toDateString()}
                </p>
                <SlotChip slot={s} onEdit={() => openEditor(s)} onDeactivate={() => deactivate(s)} compact />
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">
          Loading slots…
        </div>
      )}

      {!loading && rows.length === 0 && locations.length > 0 && (
        <EmptyState
          title="No delivery slots yet"
          message="Slots define when customers can pick a delivery window at checkout. Start with a recurring weekly grid (e.g. Mon-Sat 9am-1pm) and add one-off overrides for holidays."
          action={<PrimaryButton onClick={() => openEditor({})}>+ Add your first slot</PrimaryButton>}
        />
      )}

      {editing && (
        <Modal title={editing.id ? 'Edit slot' : 'Add new slot'} onClose={closeEditor}>
          <SlotForm
            initial={editing.id ? editing : null}
            locations={locations}
            defaultLocationId={activeLocation !== 'ALL' ? activeLocation : null}
            onCancel={closeEditor}
            onSave={() => { closeEditor(); reload(); }}
          />
        </Modal>
      )}
    </div>
  );
}

function SlotChip({ slot, onEdit, onDeactivate, compact }) {
  const typeColor = {
    EXPRESS:  'bg-purple-50 text-purple-700 border-purple-200',
    SAME_DAY: 'bg-amber-50 text-amber-700 border-amber-200',
    NEXT_DAY: 'bg-blue-50 text-blue-700 border-blue-200',
    SCHEDULED:'bg-indigo-50 text-indigo-700 border-indigo-200',
    STANDARD: 'bg-gray-50 text-gray-700 border-gray-200',
  };
  return (
    <div className={`rounded-lg border ${slot.isActive ? 'border-gray-200' : 'border-gray-200 opacity-60'} p-2.5`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-mono font-bold text-gray-900">{slot.startTime}–{slot.endTime}</p>
          <p className="text-xs text-gray-500">Cap {slot.capacity}{slot.surchargeMinor > 0 ? ` · +${formatMoney(slot.surchargeMinor)}` : ''}</p>
        </div>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${typeColor[slot.slotType] || typeColor.STANDARD}`}>
          {slot.slotType.replace('_', ' ')}
        </span>
      </div>
      {!compact && slot.location?.name && (
        <p className="text-[10px] text-gray-400 mt-1 truncate">{slot.location.name}</p>
      )}
      <div className="flex gap-2 mt-2">
        <button type="button" onClick={onEdit}
          className="text-[11px] font-semibold text-indigo-700 hover:text-indigo-900 hover:underline">Edit</button>
        {slot.isActive && (
          <button type="button" onClick={onDeactivate}
            className="text-[11px] font-semibold text-gray-500 hover:text-red-700 hover:underline">Deactivate</button>
        )}
        {!slot.isActive && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">INACTIVE</span>
        )}
      </div>
    </div>
  );
}

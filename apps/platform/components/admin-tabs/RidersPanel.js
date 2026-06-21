'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — real RidersPanel.
// Backend: /api/ecom/riders + /api/ecom/riders/summary (Phase 3c).

import { useState, useEffect, useCallback, useMemo } from 'react';
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
    err.issues = body.issues || [];
    throw err;
  }
  return body;
}

const STATUSES = [
  { key: 'ACTIVE', label: 'Active', tone: 'success' },
  { key: 'OFF_SHIFT', label: 'Off shift', tone: 'neutral' },
  { key: 'ON_LEAVE', label: 'On leave', tone: 'neutral' },
  { key: 'SUSPENDED', label: 'Suspended', tone: 'warning' },
  { key: 'DEPARTED', label: 'Departed', tone: 'danger' },
];

const VEHICLE_TYPES = [
  { key: 'BIKE', label: 'Bike' },
  { key: 'EBIKE', label: 'E-bike' },
  { key: 'VAN', label: 'Van' },
  { key: 'CYCLE', label: 'Cycle' },
  { key: 'WALKING', label: 'Walking' },
];

const TONE_CLASSES = {
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger: 'bg-red-50 text-red-700 border-red-200',
  neutral: 'bg-gray-50 text-gray-700 border-gray-200',
};

function StatusBadge({ status }) {
  const meta = STATUSES.find((s) => s.key === status) || STATUSES[0];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono tracking-wider border ${TONE_CLASSES[meta.tone]}`}>
      {meta.label.toUpperCase()}
    </span>
  );
}

function ShiftBadge({ shift }) {
  if (!shift) {
    return (
      <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-mono tracking-wider text-gray-500">
        NOT CHECKED IN
      </span>
    );
  }
  const startedAt = shift.startedAt ? new Date(shift.startedAt) : null;
  const label = startedAt && !Number.isNaN(startedAt.getTime())
    ? `SINCE ${startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'ON SHIFT';
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-mono tracking-wider text-emerald-700">
      {label}
    </span>
  );
}

function RiderForm({ initial, locations, onSave, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => ({
    fullName: initial?.fullName || '',
    phone: initial?.phone || '',
    email: initial?.email || '',
    vehicleType: initial?.vehicleType || 'BIKE',
    vehicleReg: initial?.vehicleReg || '',
    licenseNo: initial?.licenseNo || '',
    licenseExpiresAt: initial?.licenseExpiresAt ? initial.licenseExpiresAt.slice(0, 10) : '',
    insuranceExpiresAt: initial?.insuranceExpiresAt ? initial.insuranceExpiresAt.slice(0, 10) : '',
    homeLocationId: initial?.homeLocationId || '',
    notes: initial?.notes || '',
  }));

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.fullName.trim() || !form.phone.trim()) {
      setError('Name and phone are required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = {
        fullName: form.fullName.trim(),
        phone: form.phone.trim(),
        vehicleType: form.vehicleType,
      };
      if (form.email.trim()) payload.email = form.email.trim();
      if (form.vehicleReg.trim()) payload.vehicleReg = form.vehicleReg.trim();
      if (form.licenseNo.trim()) payload.licenseNo = form.licenseNo.trim();
      if (form.licenseExpiresAt) payload.licenseExpiresAt = new Date(form.licenseExpiresAt).toISOString();
      if (form.insuranceExpiresAt) payload.insuranceExpiresAt = new Date(form.insuranceExpiresAt).toISOString();
      if (form.homeLocationId) payload.homeLocationId = form.homeLocationId;
      if (form.notes.trim()) payload.notes = form.notes.trim();

      if (initial?.id) {
        const result = await api(`/api/ecom/riders/${initial.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        onSave?.(result);
      } else {
        const result = await api('/api/ecom/riders', { method: 'POST', body: JSON.stringify(payload) });
        onSave?.(result);
      }
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Full name *" value={form.fullName} onChange={set('fullName')} autoFocus />
        <Field label="Phone *" value={form.phone} onChange={set('phone')} placeholder="+44 7900 000000" />
        <Field label="Email" value={form.email} onChange={set('email')} type="email" />
        <SelectField label="Vehicle type *" value={form.vehicleType} onChange={set('vehicleType')} options={VEHICLE_TYPES} />
        <Field label="Vehicle reg" value={form.vehicleReg} onChange={set('vehicleReg')} />
        <Field label="License number" value={form.licenseNo} onChange={set('licenseNo')} />
        <Field label="License expires" type="date" value={form.licenseExpiresAt} onChange={set('licenseExpiresAt')} />
        <Field label="Insurance expires" type="date" value={form.insuranceExpiresAt} onChange={set('insuranceExpiresAt')} />
        <SelectField
          label="Home location"
          value={form.homeLocationId}
          onChange={set('homeLocationId')}
          options={[{ key: '', label: '— None —' }, ...locations.map((l) => ({ key: l.id, label: l.name }))]}
          fullWidth
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
        <textarea value={form.notes} onChange={set('notes')} rows={2} maxLength={2000}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
      </div>
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400">Cancel</button>
        <button type="submit" disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? 'Saving…' : initial?.id ? 'Save changes' : 'Add rider'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, ...props }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input {...props}
        className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
    </div>
  );
}

function SelectField({ label, value, onChange, options, fullWidth }) {
  return (
    <div className={fullWidth ? 'sm:col-span-2' : ''}>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <select value={value} onChange={onChange}
        className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
        {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
    </div>
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

export default function RidersPanel() {
  const { active: activeLocation, locations } = useEcommerceLocation();
  const { has } = useEcomAccess();
  const canEditRiders = has('orders.edit');
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (search.trim()) params.set('search', search.trim());
      params.set('pageSize', '100');

      const summaryParams = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') summaryParams.set('locationId', activeLocation);

      const [list, sum] = await Promise.all([
        api(`/api/ecom/riders?${params.toString()}`),
        api(`/api/ecom/riders/summary?${summaryParams.toString()}`),
      ]);
      setRows(list.rows || []);
      setSummary(sum);
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [activeLocation, statusFilter, search]);

  useEffect(() => { reload(); }, [reload]);

  async function changeStatus(rider, newStatus) {
    if (rider.status === newStatus) return;
    try {
      await api(`/api/ecom/riders/${rider.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus }),
      });
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function resendInvite(rider) {
    setError('');
    setNotice('');
    try {
      await api(`/api/ecom/riders/${rider.id}/invite`, { method: 'POST' });
      setNotice(`Invite resent to ${rider.email}`);
    } catch (err) {
      setError(err.message || 'Failed to resend invite');
    }
  }

  function handleSaved(result) {
    setEditing(null);
    if (result?.inviteSent) {
      setNotice(`Invite sent to ${result.email}`);
    } else if (result?.inviteSent === false && result?.inviteMessage) {
      setNotice(result.inviteMessage);
    }
    reload();
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Delivery riders</h2>
            <p className="text-sm text-gray-500 mt-1">
              {summary
                ? `${summary.total} total · ${summary.onShiftCount || 0} checked in${summary.expiringSoonCount ? ` · ${summary.expiringSoonCount} license/insurance expiring soon` : ''}`
                : 'Loading…'}
            </p>
          </div>
          {canEditRiders ? (
            <button type="button" onClick={() => setEditing({})}
              className="px-4 py-2 text-sm font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">
              + Invite rider
            </button>
          ) : (
            <span className="px-3 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-xs font-semibold text-gray-500">
              Read-only
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="Checked in" value={summary?.onShiftCount} hint="On shift now" />
        <KpiCard label="Active roster" value={summary?.counts?.ACTIVE} hint="Available riders" />
        <KpiCard label="Off shift" value={summary?.counts?.OFF_SHIFT} hint="Available later" />
        <KpiCard
          label="Avg on-time"
          value={summary?.avgOnTimeRate != null ? `${Math.round(summary.avgOnTimeRate * 100)}%` : null}
          hint="Across active"
        />
        <KpiCard
          label="Avg rating"
          value={summary?.avgRating != null ? summary.avgRating.toFixed(2) : null}
          hint="Out of 5"
        />
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-center gap-2">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, phone, email, or vehicle reg…"
          className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {notice && <div className="p-4 text-sm text-emerald-800 bg-emerald-50 border-b border-emerald-200">{notice}</div>}
        {error && <div className="p-4 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading && rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">Loading riders…</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-semibold text-gray-900">No riders yet</p>
            <p className="text-xs text-gray-500 mt-1">Click <strong>+ Invite rider</strong> to add the first one.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-[10px] font-mono tracking-[0.18em] uppercase text-gray-500">
                  <th className="px-4 py-3">Rider</th>
                  <th className="px-4 py-3">Vehicle</th>
                  <th className="px-4 py-3">Home location</th>
                  <th className="px-4 py-3">Shift</th>
                  <th className="px-4 py-3 text-right">Deliveries</th>
                  <th className="px-4 py-3 text-right">On-time</th>
                  <th className="px-4 py-3 text-right">Rating</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-900">{r.fullName}</p>
                      <p className="text-xs text-gray-500">{r.phone}</p>
                      {r.email && <p className="text-xs text-gray-500">{r.email}</p>}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {VEHICLE_TYPES.find((v) => v.key === r.vehicleType)?.label || r.vehicleType}
                      {r.vehicleReg && <p className="text-xs text-gray-500 font-mono">{r.vehicleReg}</p>}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{r.homeLocation?.name || '—'}</td>
                    <td className="px-4 py-3"><ShiftBadge shift={r.shifts?.[0]} /></td>
                    <td className="px-4 py-3 text-right font-mono text-gray-900">{r.totalDeliveries}</td>
                    <td className="px-4 py-3 text-right font-mono text-gray-900">{Math.round(r.onTimeRate * 100)}%</td>
                    <td className="px-4 py-3 text-right font-mono text-gray-900">{r.avgRating?.toFixed(2) || '—'}</td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3 text-right">
                      {canEditRiders && (
                        <div className="flex justify-end gap-3">
                          <button type="button" onClick={() => setEditing(r)}
                            className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 hover:underline">Edit</button>
                          {r.email && (
                            <button type="button" onClick={() => resendInvite(r)}
                              className="text-xs font-semibold text-sky-700 hover:text-sky-900 hover:underline">Resend invite</button>
                          )}
                          {r.status === 'ACTIVE' && (
                            <button type="button" onClick={() => changeStatus(r, 'OFF_SHIFT')}
                              className="text-xs font-semibold text-gray-600 hover:text-gray-900 hover:underline">Off shift</button>
                          )}
                          {r.status === 'OFF_SHIFT' && (
                            <button type="button" onClick={() => changeStatus(r, 'ACTIVE')}
                              className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 hover:underline">Activate</button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <Modal title={editing.id ? 'Edit rider' : 'Invite new rider'} onClose={() => setEditing(null)}>
          <RiderForm
            initial={editing.id ? editing : null}
            locations={locations}
            onCancel={() => setEditing(null)}
            onSave={handleSaved}
          />
        </Modal>
      )}
    </div>
  );
}

function KpiCard({ label, value, hint }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-[11px] font-mono tracking-[0.18em] uppercase text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-gray-900">{value === null || value === undefined ? '—' : value}</p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

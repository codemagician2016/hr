'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/adminApi';
import { RX } from './restaurant/theme';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHAPES = ['ROUND', 'SQUARE', 'RECTANGLE', 'BOOTH', 'BAR'];

function blankSettings() {
  return {
    slotIntervalMinutes: 15,
    defaultTurnMinutes: 90,
    minAdvanceMinutes: 60,
    maxPartySizeOnline: 12,
    graceMinutes: 15,
    holdMinutes: 10,
    onlineBookingEnabled: true,
    depositMode: 'NONE',
    depositRequired: false,
    depositAmount: '',
    minimumSpendEnabled: false,
    minimumSpendAmount: '',
    minimumSpendPerPerson: false,
    prepaidEnabled: false,
    prepaidAmount: '',
    cancellationFeeAmount: '',
    noShowFeeAmount: '',
    policyText: '',
    preorderEnabled: false,
  };
}

function blankArea() {
  return { name: '', isActive: true, onlineBookable: true };
}

function blankTable(areaId = '') {
  return {
    label: '',
    areaId,
    minCovers: 1,
    maxCovers: 2,
    shape: 'ROUND',
    isActive: true,
    onlineBookable: true,
  };
}

function tableMutationPayload(table, patch = {}) {
  const next = { ...table, ...patch };
  return {
    label: next.label,
    areaId: next.areaId,
    minCovers: next.minCovers,
    maxCovers: next.maxCovers,
    shape: next.shape,
    x: next.x,
    y: next.y,
    width: next.width,
    height: next.height,
    rotation: next.rotation,
    sortOrder: next.sortOrder,
    isActive: next.isActive,
    onlineBookable: next.onlineBookable,
  };
}

function blankPeriod() {
  return {
    name: 'Dinner',
    dayOfWeek: 5,
    applyAllDays: false,
    startTime: '18:00',
    endTime: '22:00',
    slotIntervalMinutes: 15,
    turnMinutes: 90,
    areaId: '',
    flowCoverLimit: '',
    onlineInventoryPercent: 100,
    isActive: true,
  };
}

export default function RestaurantTablesPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(blankSettings());
  const [areaDraft, setAreaDraft] = useState(blankArea());
  const [tableDraft, setTableDraft] = useState(blankTable());
  const [periodDraft, setPeriodDraft] = useState(blankPeriod());

  const areas = data?.areas || [];
  const tables = data?.tables || [];
  const periods = data?.servicePeriods || [];
  const stats = data?.stats || {};

  // --- Floor-plan drag editor (styling + optimistic position state only) ---
  const GRID = 16;
  const canvasRef = useRef(null);
  const [positions, setPositions] = useState({});
  const dragRef = useRef(null);

  const tableGeometry = useMemo(() => {
    const map = {};
    tables.forEach((table, index) => {
      const fallbackX = 36 + (index % 5) * 120;
      const fallbackY = 36 + Math.floor(index / 5) * 104;
      const x = Number.isFinite(Number(table.x)) && Number(table.x) !== 0 ? Number(table.x) : fallbackX;
      const y = Number.isFinite(Number(table.y)) && Number(table.y) !== 0 ? Number(table.y) : fallbackY;
      const width = Number(table.width || (table.shape === 'RECTANGLE' || table.shape === 'BOOTH' ? 104 : 82));
      const height = Number(table.height || (table.shape === 'BAR' ? 56 : 82));
      map[table.id] = { x, y, width, height };
    });
    return map;
  }, [tables]);

  // Seed local optimistic positions from persisted table geometry.
  useEffect(() => {
    setPositions((current) => {
      const next = { ...current };
      for (const table of tables) {
        const geo = tableGeometry[table.id];
        if (geo && !next[table.id]) next[table.id] = { x: geo.x, y: geo.y };
      }
      // Drop positions for tables that no longer exist.
      for (const id of Object.keys(next)) {
        if (!tableGeometry[id]) delete next[id];
      }
      return next;
    });
  }, [tableGeometry, tables]);

  function snap(value) {
    return Math.round(value / GRID) * GRID;
  }

  function handleTablePointerDown(event, table) {
    if (event.button != null && event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    const geo = tableGeometry[table.id] || { x: 0, y: 0, width: 82, height: 82 };
    const start = positions[table.id] || { x: geo.x, y: geo.y };
    const rect = canvas.getBoundingClientRect();
    dragRef.current = {
      table,
      width: geo.width,
      height: geo.height,
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      originX: start.x,
      originY: start.y,
      canvasWidth: canvas.scrollWidth,
      canvasHeight: rect.height,
      moved: false,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* noop */ }
  }

  function handleTablePointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    const dx = event.clientX - drag.pointerStartX;
    const dy = event.clientY - drag.pointerStartY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    const maxX = Math.max(0, (drag.canvasWidth || 0) - drag.width);
    const maxY = Math.max(0, (drag.canvasHeight || 0) - drag.height);
    const x = Math.min(maxX, Math.max(0, snap(drag.originX + dx)));
    const y = Math.min(maxY, Math.max(0, snap(drag.originY + dy)));
    setPositions((current) => ({ ...current, [drag.table.id]: { x, y } }));
  }

  function handleTablePointerUp(event) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
    if (!drag.moved) return;
    const pos = positions[drag.table.id];
    if (!pos) return;
    updateTable(drag.table, { x: pos.x, y: pos.y });
  }

  const tablesByArea = useMemo(() => {
    const grouped = new Map();
    for (const table of tables) {
      const key = table.areaId || 'unassigned';
      grouped.set(key, [...(grouped.get(key) || []), table]);
    }
    return grouped;
  }, [tables]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const next = await api('/api/restaurant/admin');
      setData(next);
      setSettings({ ...blankSettings(), ...(next.settings || {}) });
      const firstArea = (next.areas || [])[0]?.id || '';
      setTableDraft((current) => ({ ...current, areaId: current.areaId || firstArea }));
    } catch (err) {
      setError(err.message || 'Could not load restaurant setup');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function saveSettings() {
    setSaving('settings');
    setError('');
    try {
      await api('/api/restaurant/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...settings,
          depositAmount: settings.depositAmount === '' ? null : Number(settings.depositAmount),
          minimumSpendAmount: settings.minimumSpendAmount === '' ? null : Number(settings.minimumSpendAmount),
          prepaidAmount: settings.prepaidAmount === '' ? null : Number(settings.prepaidAmount),
          cancellationFeeAmount: settings.cancellationFeeAmount === '' ? null : Number(settings.cancellationFeeAmount),
          noShowFeeAmount: settings.noShowFeeAmount === '' ? null : Number(settings.noShowFeeAmount),
        }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function addArea() {
    if (!areaDraft.name.trim()) return;
    setSaving('area');
    setError('');
    try {
      await api('/api/restaurant/admin/areas', { method: 'POST', body: JSON.stringify(areaDraft) });
      setAreaDraft(blankArea());
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function updateArea(area, patch) {
    setSaving(`area-${area.id}`);
    setError('');
    try {
      await api(`/api/restaurant/admin/areas/${area.id}`, { method: 'PUT', body: JSON.stringify({ ...area, ...patch }) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function removeArea(area) {
    if (!window.confirm(`Delete ${area.name}? Tables in this area will also be removed.`)) return;
    setSaving(`area-${area.id}`);
    setError('');
    try {
      await api(`/api/restaurant/admin/areas/${area.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function addTable() {
    if (!tableDraft.label.trim() || !tableDraft.areaId) return;
    setSaving('table');
    setError('');
    try {
      await api('/api/restaurant/admin/tables', { method: 'POST', body: JSON.stringify(tableDraft) });
      setTableDraft(blankTable(tableDraft.areaId));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function updateTable(table, patch) {
    setSaving(`table-${table.id}`);
    setError('');
    try {
      await api(`/api/restaurant/admin/tables/${table.id}`, { method: 'PUT', body: JSON.stringify(tableMutationPayload(table, patch)) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function autoArrangeFloorPlan() {
    if (!tables.length) return;
    setSaving('floor-plan');
    setError('');
    try {
      await Promise.all(tables.map((table, index) => {
        const col = index % 5;
        const row = Math.floor(index / 5);
        return api(`/api/restaurant/admin/tables/${table.id}`, {
          method: 'PUT',
          body: JSON.stringify(tableMutationPayload(table, {
            x: 36 + col * 120,
            y: 36 + row * 104,
            width: table.shape === 'RECTANGLE' || table.shape === 'BOOTH' ? 104 : 82,
            height: table.shape === 'BAR' ? 56 : 82,
            rotation: 0,
          })),
        });
      }));
      await load();
    } catch (err) {
      setError(err.message || 'Could not arrange floor plan');
    } finally {
      setSaving('');
    }
  }

  async function removeTable(table) {
    if (!window.confirm(`Delete table ${table.label}?`)) return;
    setSaving(`table-${table.id}`);
    setError('');
    try {
      await api(`/api/restaurant/admin/tables/${table.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function addPeriod() {
    setSaving('period');
    setError('');
    try {
      const days = periodDraft.applyAllDays ? DAYS.map((_, index) => index) : [Number(periodDraft.dayOfWeek)];
      await Promise.all(days.map((dayOfWeek) => api('/api/restaurant/admin/service-periods', {
        method: 'POST',
        body: JSON.stringify({ ...periodDraft, dayOfWeek, applyAllDays: undefined }),
      })));
      setPeriodDraft(blankPeriod());
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function updatePeriod(period, patch) {
    setSaving(`period-${period.id}`);
    setError('');
    try {
      await api(`/api/restaurant/admin/service-periods/${period.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...period, ...patch }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function removePeriod(period) {
    if (!window.confirm(`Delete ${period.name} on ${DAYS[period.dayOfWeek]}?`)) return;
    setSaving(`period-${period.id}`);
    setError('');
    try {
      await api(`/api/restaurant/admin/service-periods/${period.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border bg-white p-8" style={{ borderColor: RX.line }}>
        <div className="h-6 w-48 rounded animate-pulse" style={{ background: RX.lineSoft }} />
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-xl animate-pulse" style={{ background: RX.lineSoft }} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="Reservations today" value={stats.reservationsToday || 0} />
        <Metric label="Covers today" value={stats.coversToday || 0} />
        <Metric label="Online tables" value={stats.onlineTables || 0} />
      </div>

      <section className="rounded-2xl border bg-white p-6" style={{ borderColor: RX.line }}>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Reservation Rules</p>
            <h2 className="mt-1 text-xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Online booking controls</h2>
          </div>
          <button
            type="button"
            onClick={saveSettings}
            disabled={saving === 'settings'}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: RX.wine }}
          >
            {saving === 'settings' ? 'Saving...' : 'Save rules'}
          </button>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <NumberField label="Slot interval" value={settings.slotIntervalMinutes} onChange={(v) => setSettings((s) => ({ ...s, slotIntervalMinutes: v }))} suffix="min" />
          <NumberField label="Default table turn" value={settings.defaultTurnMinutes} onChange={(v) => setSettings((s) => ({ ...s, defaultTurnMinutes: v }))} suffix="min" />
          <NumberField label="Advance notice" value={settings.minAdvanceMinutes} onChange={(v) => setSettings((s) => ({ ...s, minAdvanceMinutes: v }))} suffix="min" />
          <NumberField label="Max online party" value={settings.maxPartySizeOnline} onChange={(v) => setSettings((s) => ({ ...s, maxPartySizeOnline: v }))} suffix="guests" />
          <NumberField label="Table hold time" value={settings.holdMinutes} onChange={(v) => setSettings((s) => ({ ...s, holdMinutes: v }))} suffix="min" />
          <NumberField label="Late grace time" value={settings.graceMinutes} onChange={(v) => setSettings((s) => ({ ...s, graceMinutes: v }))} suffix="min" />
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Toggle label="Accept online reservations" checked={settings.onlineBookingEnabled !== false} onChange={(v) => setSettings((s) => ({ ...s, onlineBookingEnabled: v }))} />
          <Toggle label="Allow pre-order notes" checked={settings.preorderEnabled === true} onChange={(v) => setSettings((s) => ({ ...s, preorderEnabled: v }))} />
        </div>
        <div className="mt-5 rounded-2xl border p-4" style={{ borderColor: RX.line, background: RX.wineSoft }}>
          <div className="grid gap-4 lg:grid-cols-[0.8fr_0.8fr_1fr_1fr]">
            <Field label="Payment rule">
              <select
                value={settings.depositMode || 'NONE'}
                onChange={(e) => setSettings((s) => ({
                  ...s,
                  depositMode: e.target.value,
                  depositRequired: e.target.value === 'REQUIRED',
                  prepaidEnabled: e.target.value === 'PREPAID' ? true : s.prepaidEnabled,
                }))}
                className="input"
              >
                <option value="NONE">No deposit</option>
                <option value="OPTIONAL">Optional deposit</option>
                <option value="REQUIRED">Required deposit</option>
                <option value="PREPAID">Prepaid reservation</option>
              </select>
            </Field>
            <NumberField label="Deposit amount" value={settings.depositAmount || ''} onChange={(v) => setSettings((s) => ({ ...s, depositAmount: v }))} />
            <NumberField label="Prepaid amount" value={settings.prepaidAmount || ''} onChange={(v) => setSettings((s) => ({ ...s, prepaidAmount: v, prepaidEnabled: v !== '' }))} />
            <Toggle label="Minimum spend" checked={settings.minimumSpendEnabled === true} onChange={(v) => setSettings((s) => ({ ...s, minimumSpendEnabled: v }))} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-4">
            <NumberField label="Minimum spend amount" value={settings.minimumSpendAmount || ''} onChange={(v) => setSettings((s) => ({ ...s, minimumSpendAmount: v }))} />
            <Toggle label="Per guest minimum" checked={settings.minimumSpendPerPerson === true} onChange={(v) => setSettings((s) => ({ ...s, minimumSpendPerPerson: v }))} />
            <NumberField label="Cancellation fee" value={settings.cancellationFeeAmount || ''} onChange={(v) => setSettings((s) => ({ ...s, cancellationFeeAmount: v }))} />
            <NumberField label="No-show fee" value={settings.noShowFeeAmount || ''} onChange={(v) => setSettings((s) => ({ ...s, noShowFeeAmount: v }))} />
          </div>
          <label className="mt-4 block">
            <span className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: RX.gold }}>Guest policy shown before confirmation</span>
            <textarea
              value={settings.policyText || ''}
              onChange={(e) => setSettings((s) => ({ ...s, policyText: e.target.value }))}
              rows={3}
              className="input mt-2 resize-none"
              placeholder="Example: Tables are held for 10 minutes. Minimum spend applies to peak dinner bookings. Deposits are credited to your bill."
            />
          </label>
          <div className="mt-4 rounded-xl bg-white/70 p-3 text-sm" style={{ color: RX.ink }}>
            <p className="font-semibold">Guest checkout preview</p>
            <p className="mt-1">
              {settings.depositMode === 'PREPAID'
                ? `Guest sees prepaid reservation value ${settings.prepaidAmount || 0}, paid before arrival.`
                : settings.depositMode === 'REQUIRED'
                  ? `Guest sees required deposit ${settings.depositAmount || 0}, credited to the final bill.`
                  : 'Guest can reserve without a deposit.'}
              {settings.minimumSpendEnabled ? ` Minimum spend ${settings.minimumSpendAmount || 0}${settings.minimumSpendPerPerson ? ' per guest' : ' per booking'} is disclosed as a dining commitment, not an automatic charge.` : ''}
              {` Tables are held for ${settings.holdMinutes || 10} minutes with ${settings.graceMinutes || 15} minutes of late-arrival grace shown to guests.`}
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <section className="rounded-2xl border bg-white p-6" style={{ borderColor: RX.line }}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Dining Room</p>
              <h2 className="mt-1 text-xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Areas and tables</h2>
            </div>
            <div className="grid gap-2 sm:grid-cols-[180px_auto]">
              <input
                value={areaDraft.name}
                onChange={(e) => setAreaDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Patio, Main room"
                className="input"
              />
              <button type="button" onClick={addArea} disabled={saving === 'area'} className="rounded-xl border px-3 py-2 text-sm font-semibold hover:bg-[#FAF6EC] disabled:opacity-60" style={{ borderColor: RX.line, color: RX.ink }}>
                Add area
              </button>
            </div>
          </div>

          {areas.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed p-8 text-center" style={{ borderColor: RX.line, background: RX.cream }}>
              <p className="text-sm font-semibold" style={{ color: RX.ink }}>Create your first dining area</p>
              <p className="mt-1 text-sm" style={{ color: RX.muted }}>After that, add tables with min/max covers so online reservations can assign capacity correctly.</p>
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {areas.map((area) => (
                <div key={area.id} className="rounded-2xl border p-4" style={{ borderColor: RX.line }}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-base font-semibold" style={{ color: RX.ink }}>{area.name}</p>
                      <p className="text-xs" style={{ color: RX.muted }}>{(tablesByArea.get(area.id) || []).length} tables</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => updateArea(area, { onlineBookable: !area.onlineBookable })}
                        className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                        style={area.onlineBookable
                          ? { borderColor: RX.teal, background: RX.tealSoft, color: RX.teal }
                          : { borderColor: RX.line, color: RX.muted }}
                      >
                        {area.onlineBookable ? 'Online' : 'Offline'}
                      </button>
                      <button type="button" onClick={() => removeArea(area)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700">
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {(tablesByArea.get(area.id) || []).map((table) => (
                      <div key={table.id} className="rounded-xl border p-3" style={{ borderColor: RX.line, background: RX.cream }}>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold" style={{ color: RX.ink }}>{table.label}</p>
                            <p className="text-xs" style={{ color: RX.muted }}>{table.minCovers}-{table.maxCovers} covers · {table.shape.toLowerCase()}</p>
                          </div>
                          <button type="button" onClick={() => removeTable(table)} className="text-xs font-semibold text-red-700">Delete</button>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            onClick={() => updateTable(table, { onlineBookable: !table.onlineBookable })}
                            className="rounded-lg border px-2.5 py-1 text-xs font-semibold"
                            style={table.onlineBookable
                              ? { borderColor: RX.teal, background: RX.tealSoft, color: RX.teal }
                              : { borderColor: RX.line, color: RX.muted, background: RX.panel }}
                          >
                            {table.onlineBookable ? 'Online' : 'Offline'}
                          </button>
                          <button
                            type="button"
                            onClick={() => updateTable(table, { isActive: !table.isActive })}
                            className="rounded-lg border px-2.5 py-1 text-xs font-semibold"
                            style={table.isActive
                              ? { borderColor: RX.teal, background: RX.tealSoft, color: RX.teal }
                              : { borderColor: RX.line, color: RX.muted, background: RX.panel }}
                          >
                            {table.isActive ? 'Active' : 'Inactive'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border bg-white p-6" style={{ borderColor: RX.line }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Add Table</p>
          <h2 className="mt-1 text-xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Table capacity</h2>
          <div className="mt-5 grid gap-3">
            <Field label="Table label">
              <input value={tableDraft.label} onChange={(e) => setTableDraft((d) => ({ ...d, label: e.target.value }))} placeholder="T1, Booth 4" className="input" />
            </Field>
            <Field label="Dining area">
              <select value={tableDraft.areaId} onChange={(e) => setTableDraft((d) => ({ ...d, areaId: e.target.value }))} className="input">
                <option value="">Select area</option>
                {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Min covers" value={tableDraft.minCovers} onChange={(v) => setTableDraft((d) => ({ ...d, minCovers: v }))} />
              <NumberField label="Max covers" value={tableDraft.maxCovers} onChange={(v) => setTableDraft((d) => ({ ...d, maxCovers: v }))} />
            </div>
            <Field label="Shape">
              <select value={tableDraft.shape} onChange={(e) => setTableDraft((d) => ({ ...d, shape: e.target.value }))} className="input">
                {SHAPES.map((shape) => <option key={shape} value={shape}>{shape}</option>)}
              </select>
            </Field>
            <button type="button" onClick={addTable} disabled={saving === 'table' || !areas.length} className="mt-1 rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" style={{ background: RX.wine }}>
              {saving === 'table' ? 'Adding...' : 'Add table'}
            </button>
          </div>
        </section>
      </div>

      <section className="rounded-2xl border bg-white p-6" style={{ borderColor: RX.line }}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Floor Plan</p>
            <h2 className="mt-1 text-xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Visual table map</h2>
            <p className="mt-1 text-sm" style={{ color: RX.muted }}>This uses the same table inventory that online reservations and Host Stand use.</p>
          </div>
          <button
            type="button"
            onClick={autoArrangeFloorPlan}
            disabled={saving === 'floor-plan' || !tables.length}
            className="rounded-xl border px-4 py-2 text-sm font-semibold hover:bg-[#FAF6EC] disabled:opacity-60"
            style={{ borderColor: RX.line, color: RX.ink }}
          >
            {saving === 'floor-plan' ? 'Arranging...' : 'Auto arrange'}
          </button>
        </div>
        {tables.length > 0 && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold" style={{ background: RX.cream, color: RX.inkSoft, border: `1px solid ${RX.line}` }}>
            <span aria-hidden style={{ color: RX.gold }}>⠿</span>
            Drag tables to arrange your room — changes save as you drop.
          </p>
        )}
        <div
          ref={canvasRef}
          className="mt-4 h-[360px] touch-none select-none overflow-x-auto overflow-y-hidden rounded-2xl border"
          style={{
            borderColor: RX.line,
            background: RX.cream,
            backgroundImage: `linear-gradient(90deg, ${RX.line}55 1px, transparent 1px), linear-gradient(${RX.line}55 1px, transparent 1px)`,
            backgroundSize: '16px 16px',
          }}
        >
          <div className="relative h-full min-w-[680px]">
            {tables.length === 0 ? (
              <p className="absolute left-6 top-6 rounded-xl bg-white px-4 py-3 text-sm font-semibold shadow-sm" style={{ color: RX.muted }}>Add tables to preview the dining room.</p>
            ) : tables.map((table) => {
              const geo = tableGeometry[table.id] || { x: 36, y: 36, width: 82, height: 82 };
              const pos = positions[table.id] || { x: geo.x, y: geo.y };
              const live = table.isActive && table.onlineBookable;
              const isDragging = dragRef.current?.table?.id === table.id;
              return (
                <div
                  key={table.id}
                  role="button"
                  tabIndex={0}
                  onPointerDown={(e) => handleTablePointerDown(e, table)}
                  onPointerMove={handleTablePointerMove}
                  onPointerUp={handleTablePointerUp}
                  className={`absolute flex select-none flex-col items-center justify-center border-2 text-center text-xs font-black shadow-sm transition-shadow ${table.shape === 'ROUND' ? 'rounded-full' : table.shape === 'BOOTH' ? 'rounded-2xl' : table.shape === 'BAR' ? 'rounded-lg' : 'rounded-xl'}`}
                  style={{
                    left: pos.x,
                    top: pos.y,
                    width: geo.width,
                    height: geo.height,
                    transform: `rotate(${Number(table.rotation || 0)}deg)${isDragging ? ' scale(1.04)' : ''}`,
                    cursor: isDragging ? 'grabbing' : 'grab',
                    touchAction: 'none',
                    zIndex: isDragging ? 20 : 1,
                    borderColor: live ? RX.teal : RX.line,
                    background: live ? RX.tealSoft : '#F3EEE4',
                    color: live ? RX.teal : RX.muted,
                    boxShadow: isDragging ? '0 12px 28px rgba(36,27,23,0.18)' : '0 1px 2px rgba(36,27,23,0.06)',
                  }}
                >
                  <span>{table.label}</span>
                  <span className="mt-0.5 text-[10px] opacity-70">{table.minCovers}-{table.maxCovers}</span>
                  {!table.onlineBookable && <span className="mt-0.5 text-[9px] uppercase tracking-wide opacity-70">offline</span>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border bg-white p-6" style={{ borderColor: RX.line }}>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Service Periods</p>
            <h2 className="mt-1 text-xl" style={{ fontFamily: RX.serif, color: RX.ink }}>When guests can reserve</h2>
          </div>
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-[1.1fr_0.8fr_0.7fr_0.7fr_0.6fr_0.7fr_0.7fr_auto]">
          <input value={periodDraft.name} onChange={(e) => setPeriodDraft((d) => ({ ...d, name: e.target.value }))} className="input" placeholder="Dinner" />
          <select value={periodDraft.dayOfWeek} onChange={(e) => setPeriodDraft((d) => ({ ...d, dayOfWeek: Number(e.target.value) }))} className="input">
            {DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
          <input type="time" value={periodDraft.startTime} onChange={(e) => setPeriodDraft((d) => ({ ...d, startTime: e.target.value }))} className="input" />
          <input type="time" value={periodDraft.endTime} onChange={(e) => setPeriodDraft((d) => ({ ...d, endTime: e.target.value }))} className="input" />
          <input type="number" value={periodDraft.turnMinutes} onChange={(e) => setPeriodDraft((d) => ({ ...d, turnMinutes: e.target.value }))} className="input" placeholder="Turn min" />
          <input type="number" value={periodDraft.flowCoverLimit} onChange={(e) => setPeriodDraft((d) => ({ ...d, flowCoverLimit: e.target.value }))} className="input" placeholder="Cover cap" />
          <input type="number" value={periodDraft.onlineInventoryPercent} onChange={(e) => setPeriodDraft((d) => ({ ...d, onlineInventoryPercent: e.target.value }))} className="input" placeholder="Online %" />
          <button type="button" onClick={addPeriod} disabled={saving === 'period'} className="rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ background: RX.wine }}>
            {periodDraft.applyAllDays ? 'Add week' : 'Add'}
          </button>
        </div>
        <div className="mt-3 max-w-sm">
          <select value={periodDraft.areaId} onChange={(e) => setPeriodDraft((d) => ({ ...d, areaId: e.target.value }))} className="input">
            <option value="">All online areas</option>
            {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
          </select>
        </div>
        <div className="mt-3">
          <Toggle
            label="Create this service period for every day"
            checked={periodDraft.applyAllDays === true}
            onChange={(v) => setPeriodDraft((d) => ({ ...d, applyAllDays: v }))}
          />
        </div>
        <div className="mt-5 overflow-hidden rounded-2xl border" style={{ borderColor: RX.line }}>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide" style={{ background: RX.cream, color: RX.muted }}>
              <tr>
                <th className="px-4 py-3">Session</th>
                <th className="px-4 py-3">Day</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Turn</th>
                <th className="px-4 py-3">Area</th>
                <th className="px-4 py-3">Pacing</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: RX.line }}>
              {periods.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-6 text-center" style={{ color: RX.muted }}>Default lunch and dinner windows will be used until you add custom periods.</td></tr>
              ) : periods.map((period) => (
                <tr key={period.id} style={{ borderColor: RX.line }}>
                  <td className="px-4 py-3 font-semibold" style={{ color: RX.ink }}>{period.name}</td>
                  <td className="px-4 py-3" style={{ color: RX.inkSoft }}>{DAYS[period.dayOfWeek]}</td>
                  <td className="px-4 py-3" style={{ color: RX.inkSoft }}>{period.startTime} - {period.endTime}</td>
                  <td className="px-4 py-3" style={{ color: RX.inkSoft }}>{period.turnMinutes} min</td>
                  <td className="px-4 py-3" style={{ color: RX.inkSoft }}>{areas.find((area) => area.id === period.areaId)?.name || 'All areas'}</td>
                  <td className="px-4 py-3" style={{ color: RX.inkSoft }}>
                    {period.flowCoverLimit ? `${period.flowCoverLimit} covers` : 'No cap'} · {period.onlineInventoryPercent ?? 100}% online
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => updatePeriod(period, { isActive: !period.isActive })}
                      className="rounded-lg border px-2.5 py-1 text-xs font-semibold"
                      style={period.isActive
                        ? { borderColor: RX.teal, background: RX.tealSoft, color: RX.teal }
                        : { borderColor: RX.line, color: RX.muted }}
                    >
                      {period.isActive ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => removePeriod(period)} className="text-xs font-semibold text-red-700">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <style jsx>{`
        .input {
          width: 100%;
          border-radius: 0.75rem;
          border: 1px solid ${RX.line};
          padding: 0.625rem 0.75rem;
          font-size: 0.875rem;
          color: ${RX.ink};
          outline: none;
          background: white;
        }
        .input:focus { border-color: ${RX.wine}; }
      `}</style>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-2xl border bg-white p-5" style={{ borderColor: RX.line }}>
      <p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: RX.gold }}>{label}</p>
      <p className="mt-2 text-3xl" style={{ fontFamily: RX.serif, color: RX.ink }}>{value}</p>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: RX.muted }}>{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function NumberField({ label, value, onChange, suffix }) {
  return (
    <Field label={label}>
      <div className="input flex items-stretch p-0" style={{ paddingTop: 0, paddingBottom: 0 }}>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 rounded-xl border-0 bg-transparent px-3 py-2 text-sm outline-none"
          style={{ color: RX.ink }}
        />
        {suffix && <span className="flex items-center px-3 text-xs font-semibold" style={{ color: RX.muted }}>{suffix}</span>}
      </div>
    </Field>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between rounded-xl border px-4 py-3 text-left text-sm font-semibold"
      style={checked
        ? { borderColor: RX.teal, background: RX.tealSoft, color: RX.teal }
        : { borderColor: RX.line, background: RX.cream, color: RX.inkSoft }}
    >
      <span>{label}</span>
      <span className="ml-3 h-5 w-9 rounded-full p-0.5 transition" style={{ background: checked ? RX.teal : '#D6CCBA' }}>
        <span className={`block h-4 w-4 rounded-full bg-white transition ${checked ? 'translate-x-4' : ''}`} />
      </span>
    </button>
  );
}

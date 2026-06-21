'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { RX } from './restaurant/theme';

const RESERVATION_TYPES = [
  { value: 'STANDARD', label: 'Table' },
  { value: 'CHEF_COUNTER', label: 'Chef counter' },
  { value: 'PRIVATE_DINING', label: 'Private dining' },
  { value: 'CELEBRATION', label: 'Celebration' },
  { value: 'WALK_IN', label: 'Walk-in' },
];

const STATUS_STEPS = [
  { value: 'RESERVED', label: 'Reserved' },
  { value: 'ARRIVED', label: 'Arrived' },
  { value: 'SEATED', label: 'Seated' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'NO_SHOW', label: 'No-show' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function currentTime() {
  const d = new Date();
  const mins = Math.ceil(d.getMinutes() / 15) * 15;
  d.setMinutes(mins, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function blankDraft() {
  return {
    guestName: '',
    guestPhone: '',
    guestEmail: '',
    partySize: 2,
    date: todayIso(),
    startTime: currentTime(),
    source: 'WALK_IN',
    reservationType: 'WALK_IN',
    tableId: '',
    seatingPreference: '',
    occasion: '',
    dietaryNotes: '',
    notes: '',
    quotedWaitMinutes: '',
    finalPrice: '',
    paymentStatus: 'UNPAID',
    paidAmount: '',
    paymentMethod: 'CASH',
  };
}

function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function RestaurantHostStandPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [date, setDate] = useState(todayIso());
  const [setup, setSetup] = useState(null);
  const [board, setBoard] = useState(null);
  const [waitlistRows, setWaitlistRows] = useState([]);
  const [draft, setDraft] = useState(blankDraft());
  const [paymentDraft, setPaymentDraft] = useState(null);

  const tables = setup?.tables || [];
  const settings = setup?.settings || {};
  const reservations = board?.reservations || [];
  const activeTables = tables.filter((table) => table.isActive);

  const grouped = useMemo(() => {
    const base = Object.fromEntries(STATUS_STEPS.map((step) => [step.value, []]));
    for (const item of reservations) {
      const key = base[item.arrivalStatus] ? item.arrivalStatus : 'RESERVED';
      base[key].push(item);
    }
    return base;
  }, [reservations]);

  const tableStatusMap = useMemo(() => {
    const map = new Map();
    for (const item of reservations) {
      if (['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(item.arrivalStatus)) continue;
      for (const table of item.tables || []) {
        if (!table?.id) continue;
        const priority = item.arrivalStatus === 'SEATED' ? 3 : item.arrivalStatus === 'ARRIVED' ? 2 : 1;
        const existing = map.get(table.id);
        if (!existing || priority > existing.priority) {
          map.set(table.id, { ...item, priority });
        }
      }
    }
    return map;
  }, [reservations]);

  async function load(nextDate = date) {
    setLoading(true);
    setError('');
    try {
      const [setupRes, boardRes] = await Promise.all([
        api('/api/restaurant/admin'),
        api(`/api/restaurant/admin/reservations?date=${encodeURIComponent(nextDate)}`),
      ]);
      const waitlistRes = await api('/api/business/waitlist?status=PENDING').catch(() => ({ waitlist: [] }));
      setSetup(setupRes);
      setBoard(boardRes);
      setWaitlistRows(waitlistRes.waitlist || []);
      const firstTable = (setupRes.tables || []).find((table) => table.isActive)?.id || '';
      setDraft((current) => ({ ...current, date: nextDate, tableId: current.tableId || firstTable }));
    } catch (err) {
      setError(err.message || 'Could not load host stand');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(date); }, []);

  function updateDraft(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function addReservation() {
    if (!draft.startTime || !draft.partySize) return;
    setSaving('create');
    setError('');
    try {
      await api('/api/restaurant/admin/reservations', {
        method: 'POST',
        body: JSON.stringify({
          ...draft,
          guestName: draft.guestName || 'Walk-in guest',
          partySize: Number(draft.partySize),
          finalPrice: draft.finalPrice === '' ? null : Number(draft.finalPrice),
          paidAmount: draft.paidAmount === '' ? 0 : Number(draft.paidAmount),
          quotedWaitMinutes: draft.quotedWaitMinutes === '' ? null : Number(draft.quotedWaitMinutes),
          policyAccepted: true,
        }),
      });
      setDraft((current) => ({ ...blankDraft(), date: current.date, startTime: current.startTime, tableId: current.tableId }));
      await load(date);
    } catch (err) {
      setError(err.message || 'Could not add reservation');
    } finally {
      setSaving('');
    }
  }

  async function updateStatus(item, patch) {
    setSaving(item.id);
    setError('');
    try {
      await api(`/api/restaurant/admin/reservations/${item.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({
          arrivalStatus: item.arrivalStatus,
          paymentStatus: item.paymentStatus,
          paidAmount: item.paidAmount || 0,
          ...patch,
        }),
      });
      await load(date);
    } catch (err) {
      setError(err.message || 'Could not update reservation');
    } finally {
      setSaving('');
    }
  }

  function openPayment(item, { completeAfterPayment = false } = {}) {
    const finalPrice = Number(item.finalPrice || 0);
    const paidAmount = Number(item.paidAmount || 0);
    const balanceDue = Math.max(0, finalPrice - paidAmount);
    setPaymentDraft({
      item,
      completeAfterPayment,
      finalPrice: finalPrice || '',
      paidAmount: balanceDue > 0 ? finalPrice : paidAmount || '',
      paymentStatus: balanceDue > 0 ? 'PAID' : item.paymentStatus || 'UNPAID',
      paymentMethod: item.paymentMethod || 'CARD',
      paymentReference: item.paymentReference || '',
      paymentNote: item.paymentNote || '',
    });
  }

  async function savePayment() {
    if (!paymentDraft?.item) return;
    const finalPrice = paymentDraft.finalPrice === '' ? 0 : Number(paymentDraft.finalPrice);
    const paidAmount = paymentDraft.paidAmount === '' ? 0 : Number(paymentDraft.paidAmount);
    const paymentStatus = paidAmount >= finalPrice && finalPrice > 0
      ? 'PAID'
      : paidAmount > 0
        ? 'PARTIAL'
        : paymentDraft.paymentStatus;
    await updateStatus(paymentDraft.item, {
      ...(paymentDraft.completeAfterPayment ? { arrivalStatus: 'COMPLETED' } : {}),
      finalPrice,
      paidAmount,
      paymentStatus,
      paymentMethod: paymentDraft.paymentMethod,
      paymentReference: paymentDraft.paymentReference,
      paymentNote: paymentDraft.paymentNote,
    });
    setPaymentDraft(null);
  }

  async function changeDate(nextDate) {
    setDate(nextDate);
    setDraft((current) => ({ ...current, date: nextDate }));
    await load(nextDate);
  }

  if (loading) {
    return (
      <div className="rounded-2xl border bg-white p-8" style={{ borderColor: RX.line }}>
        <div className="h-6 w-56 animate-pulse rounded" style={{ background: RX.lineSoft }} />
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl" style={{ background: RX.lineSoft }} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      <section className="overflow-hidden rounded-2xl border text-white" style={{ borderColor: RX.wineDark, background: RX.wine }}>
        <div className="grid gap-6 p-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em]" style={{ color: RX.gold }}>Host stand</p>
            <h2 className="mt-2 text-4xl" style={{ fontFamily: RX.serif }}>Reservations, walk-ins, and table flow</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/75">
              Add walk-in parties, assign tables, track arrivals, seat guests, and close payment from one restaurant-specific board.
            </p>
          </div>
          <label className="block">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-white/60">Service date</span>
            <input
              type="date"
              value={date}
              onChange={(event) => changeDate(event.target.value)}
              className="mt-2 rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-sm font-bold text-white outline-none"
            />
          </label>
        </div>
        <div className="grid border-t border-white/10 sm:grid-cols-5">
          <HeroMetric label="Parties" value={board?.stats?.total || 0} />
          <HeroMetric label="Covers" value={board?.stats?.covers || 0} />
          <HeroMetric label="Waitlist" value={waitlistRows.length || 0} />
          <HeroMetric label="Collected" value={money(board?.stats?.paidRevenue || 0)} />
          <HeroMetric label="Open balance" value={money(board?.stats?.balanceDue || 0)} />
        </div>
      </section>

      {waitlistRows.length > 0 && (
        <section className="rounded-2xl border p-4" style={{ borderColor: RX.line, background: RX.wineSoft }}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Demand recovery</p>
              <h3 className="mt-1 text-lg font-black" style={{ fontFamily: RX.serif, color: RX.ink }}>
                {waitlistRows.length} guest{waitlistRows.length === 1 ? '' : 's'} waiting for a table
              </h3>
              <p className="mt-1 text-sm font-semibold" style={{ color: RX.inkSoft }}>
                New cancellations and no-shows notify matching waitlist guests automatically.
              </p>
            </div>
            <a href="?tab=waitlist" className="inline-flex justify-center rounded-xl px-4 py-2 text-sm font-black text-white shadow-sm" style={{ background: RX.wine }}>
              Open waitlist
            </a>
          </div>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        <InsightCard
          label="CRM capture"
          value={`${board?.stats?.knownGuestContacts || 0}/${board?.stats?.active || 0}`}
          detail="Active parties with phone or email saved to customer history."
        />
        <InsightCard
          label="Revenue per cover"
          value={money(board?.stats?.revenuePerCover || 0)}
          detail={`${board?.stats?.paymentDue || 0} open balance${board?.stats?.paymentDue === 1 ? '' : 's'} on the board.`}
        />
        <InsightCard
          label="Guest readiness"
          value={board?.stats?.guestNotesCaptured || 0}
          detail="Parties with occasion, dietary, seating, host, or pre-order notes."
        />
      </section>

      <section className="rounded-2xl border bg-white p-6" style={{ borderColor: RX.line }}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Dining room pulse</p>
            <h3 className="mt-1 text-2xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Tables and service health</h3>
          </div>
          <p className="text-sm font-bold" style={{ color: RX.muted }}>
            {board?.stats?.seatedTableCount || 0}/{board?.stats?.activeTableCount || activeTables.length} tables in use
            {board?.stats?.tableUtilization ? ` · ${board.stats.tableUtilization}% utilization` : ''}
          </p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {activeTables.slice(0, 18).map((table) => (
            <TablePulse key={table.id} table={table} reservation={tableStatusMap.get(table.id)} />
          ))}
          {!activeTables.length && (
            <p className="rounded-xl border border-dashed p-4 text-sm font-semibold" style={{ borderColor: RX.line, color: RX.muted }}>
              Add active tables in Restaurant setup to start live table flow.
            </p>
          )}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
        <section className="rounded-2xl border bg-white p-6" style={{ borderColor: RX.line }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Front of house</p>
              <h3 className="mt-1 text-2xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Add party</h3>
            </div>
            <span className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: RX.tealSoft, color: RX.teal }}>
              {activeTables.length} tables active
            </span>
          </div>

          <div className="mt-5 grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Guest name" value={draft.guestName} onChange={(v) => updateDraft('guestName', v)} placeholder="Walk-in guest" />
              <Input label="Phone" value={draft.guestPhone} onChange={(v) => updateDraft('guestPhone', v)} />
              <Input label="Email" type="email" value={draft.guestEmail} onChange={(v) => updateDraft('guestEmail', v)} />
              <Input label="Party size" type="number" value={draft.partySize} onChange={(v) => updateDraft('partySize', v)} />
              <Input label="Time" type="time" value={draft.startTime} onChange={(v) => updateDraft('startTime', v)} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Type" value={draft.reservationType} onChange={(v) => updateDraft('reservationType', v)}>
                {RESERVATION_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </Select>
              <Select label="Table" value={draft.tableId} onChange={(v) => updateDraft('tableId', v)}>
                <option value="">Auto assign</option>
                {activeTables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.area?.name ? `${table.area.name} - ` : ''}{table.label} ({table.minCovers}-{table.maxCovers})
                  </option>
                ))}
              </Select>
              <Input label="Quoted wait" type="number" value={draft.quotedWaitMinutes} onChange={(v) => updateDraft('quotedWaitMinutes', v)} placeholder="minutes" />
              <Input label="Bill / charge" type="number" value={draft.finalPrice} onChange={(v) => updateDraft('finalPrice', v)} />
              <Input label="Paid now" type="number" value={draft.paidAmount} onChange={(v) => updateDraft('paidAmount', v)} />
              <Select label="Payment" value={draft.paymentStatus} onChange={(v) => updateDraft('paymentStatus', v)}>
                <option value="UNPAID">Unpaid</option>
                <option value="PARTIAL">Partial</option>
                <option value="PAID">Paid</option>
              </Select>
              <Select label="Method" value={draft.paymentMethod} onChange={(v) => updateDraft('paymentMethod', v)}>
                <option value="CASH">Cash</option>
                <option value="CARD">Card</option>
                <option value="UPI">UPI</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="OTHER">Other</option>
              </Select>
            </div>

            <Input label="Occasion" value={draft.occasion} onChange={(v) => updateDraft('occasion', v)} placeholder="Birthday, date night, business meal" />
            <TextArea label="Dietary, seating, or host notes" value={draft.notes} onChange={(v) => updateDraft('notes', v)} />

            {(settings.depositRequired || settings.minimumSpendEnabled || settings.prepaidEnabled) && (
              <div className="rounded-xl border p-4 text-sm" style={{ borderColor: RX.line, background: RX.wineSoft, color: RX.ink }}>
                <p className="font-black">Commercial rules active</p>
                <p className="mt-1 leading-6">
                  {settings.depositRequired ? `Deposit ${money(settings.depositAmount)}. ` : ''}
                  {settings.prepaidEnabled ? `Prepaid ${money(settings.prepaidAmount)}. ` : ''}
                  {settings.minimumSpendEnabled ? `Minimum spend ${money(settings.minimumSpendAmount)} ${settings.minimumSpendPerPerson ? 'per guest' : 'per booking'}.` : ''}
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={addReservation}
              disabled={saving === 'create' || !activeTables.length}
              className="rounded-xl px-4 py-3 text-sm font-black text-white disabled:opacity-50"
              style={{ background: RX.wine }}
            >
              {saving === 'create' ? 'Adding...' : 'Add to host stand'}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border bg-white p-6" style={{ borderColor: RX.line }}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Service board</p>
              <h3 className="mt-1 text-2xl" style={{ fontFamily: RX.serif, color: RX.ink }}>Today&apos;s table flow</h3>
            </div>
            <button type="button" onClick={() => load(date)} className="rounded-xl border px-4 py-2 text-sm font-bold hover:bg-[#FAF6EC]" style={{ borderColor: RX.line, color: RX.ink }}>
              Refresh
            </button>
          </div>

          <div className="mt-5 grid gap-4 2xl:grid-cols-2">
            {STATUS_STEPS.slice(0, 4).map((step) => (
              <StatusLane
                key={step.value}
                step={step}
                items={grouped[step.value] || []}
                saving={saving}
                onStatus={updateStatus}
                onPayment={openPayment}
                tables={activeTables}
              />
            ))}
          </div>

          {(grouped.NO_SHOW.length > 0 || grouped.CANCELLED.length > 0) && (
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {STATUS_STEPS.slice(4).map((step) => (
                <StatusLane
                  key={step.value}
                  step={step}
                  items={grouped[step.value] || []}
                  saving={saving}
                  onStatus={updateStatus}
                  onPayment={openPayment}
                  tables={activeTables}
                  compact
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {paymentDraft && (
        <PaymentDialog
          draft={paymentDraft}
          saving={Boolean(saving)}
          onChange={(patch) => setPaymentDraft((current) => ({ ...current, ...patch }))}
          onCancel={() => setPaymentDraft(null)}
          onSave={savePayment}
        />
      )}
      <style jsx global>{`
        .rx-field:focus { border-color: ${RX.wine} !important; }
      `}</style>
    </div>
  );
}

function HeroMetric({ label, value }) {
  return (
    <div className="border-t border-white/10 p-5 sm:border-l sm:border-t-0 first:sm:border-l-0">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-white/55">{label}</p>
      <p className="mt-2 text-3xl text-white" style={{ fontFamily: RX.serif }}>{value}</p>
    </div>
  );
}

function InsightCard({ label, value, detail }) {
  return (
    <div className="rounded-2xl border bg-white p-5" style={{ borderColor: RX.line }}>
      <p className="text-[11px] font-black uppercase tracking-[0.16em]" style={{ color: RX.gold }}>{label}</p>
      <p className="mt-2 text-2xl" style={{ fontFamily: RX.serif, color: RX.ink }}>{value}</p>
      <p className="mt-1 text-sm font-semibold leading-6" style={{ color: RX.muted }}>{detail}</p>
    </div>
  );
}

function TablePulse({ table, reservation }) {
  const status = reservation?.arrivalStatus || 'FREE';
  const style = status === 'SEATED'
    ? { borderColor: RX.teal, background: RX.tealSoft, color: RX.teal }
    : status === 'ARRIVED'
      ? { borderColor: RX.gold, background: '#FBF5E8', color: '#8A6A2E' }
      : status === 'RESERVED'
        ? { borderColor: RX.line, background: RX.wineSoft, color: RX.wine }
        : { borderColor: RX.line, background: RX.cream, color: RX.inkSoft };
  return (
    <div className="rounded-xl border p-3" style={style}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-black">{table.label}</p>
          <p className="mt-0.5 text-[11px] font-bold uppercase opacity-70">
            {table.area?.name || 'Dining'} · {table.minCovers}-{table.maxCovers}
          </p>
        </div>
        <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-black uppercase">
          {status.replace(/_/g, ' ')}
        </span>
      </div>
      {reservation && (
        <p className="mt-2 truncate text-xs font-bold">
          {reservation.startTime} · {reservation.guestName} · {reservation.partySize}
        </p>
      )}
    </div>
  );
}

function StatusLane({ step, items, saving, onStatus, onPayment, tables = [], compact = false }) {
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: RX.line, background: RX.cream }}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-black uppercase tracking-[0.14em]" style={{ color: RX.inkSoft }}>{step.label}</h4>
        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black" style={{ color: RX.ink }}>{items.length}</span>
      </div>
      <div className="mt-3 space-y-3">
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-white p-4 text-sm font-semibold" style={{ borderColor: RX.line, color: RX.muted }}>
            No parties here.
          </p>
        ) : items.map((item) => (
          <ReservationCard key={item.id} item={item} saving={saving === item.id} onStatus={onStatus} onPayment={onPayment} tables={tables} compact={compact} />
        ))}
      </div>
    </div>
  );
}

function ReservationCard({ item, saving, onStatus, onPayment, tables, compact }) {
  const balanceDue = Math.max(0, Number(item.finalPrice || 0) - Number(item.paidAmount || 0));
  const tableLabel = item.tables?.length ? item.tables.map((table) => `${table.areaName ? `${table.areaName} ` : ''}${table.label}`).join(', ') : 'Auto table';
  const currentTableId = item.tables?.[0]?.id || '';
  const assignableTables = (tables || []).filter((table) => table.maxCovers >= item.partySize);
  const contactLines = [
    item.guestPhone ? `Phone: ${item.guestPhone}` : '',
    item.guestEmail ? `Email: ${item.guestEmail}` : '',
  ].filter(Boolean);
  const preorderItems = Array.isArray(item.preorderItems) ? item.preorderItems : [];
  return (
    <article className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: RX.line }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-black" style={{ color: RX.ink }}>{item.startTime} · {item.partySize} guests</p>
          <p className="mt-1 text-sm font-semibold" style={{ color: RX.inkSoft }}>{item.guestName}</p>
          <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em]" style={{ color: RX.muted }}>{tableLabel}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="rounded-full px-2.5 py-1 text-[11px] font-black uppercase" style={{ background: RX.cream, color: RX.inkSoft }}>
            {item.source}
          </span>
          {item.reservationType && (
            <span className="rounded-full px-2.5 py-1 text-[11px] font-black uppercase" style={{ background: RX.wineSoft, color: RX.wine }}>
              {item.reservationType.replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </div>
      {!compact && (
        <div className="mt-3 grid gap-2 text-xs font-semibold" style={{ color: RX.inkSoft }}>
          {contactLines.map((line) => <p key={line}>{line}</p>)}
          {item.quotedWaitMinutes != null && <p>Quoted wait: {item.quotedWaitMinutes} minutes</p>}
          <p>
            Payment: {item.paymentStatus || 'UNPAID'} · Bill {money(item.finalPrice || 0)} · Paid {money(item.paidAmount || 0)}
            {item.paymentMethod ? ` · ${item.paymentMethod.replace(/_/g, ' ')}` : ''}
          </p>
          {item.paymentReference && <p>Payment ref: {item.paymentReference}</p>}
          {assignableTables.length > 0 && (
            <label className="block rounded-lg border p-2" style={{ borderColor: RX.line, background: RX.cream }}>
              <span className="block text-[11px] font-black uppercase tracking-[0.12em]" style={{ color: RX.muted }}>Assigned table</span>
              <select
                value={currentTableId}
                disabled={saving}
                onChange={(event) => onStatus(item, { tableId: event.target.value })}
                className="mt-1 w-full rounded-md border bg-white px-2 py-1.5 text-xs font-bold outline-none disabled:opacity-60"
                style={{ borderColor: RX.line, color: RX.ink }}
              >
                <option value="">Auto table</option>
                {assignableTables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.area?.name ? `${table.area.name} - ` : ''}{table.label} ({table.minCovers}-{table.maxCovers})
                  </option>
                ))}
              </select>
            </label>
          )}
          {item.occasion && <p>Occasion: {item.occasion}</p>}
          {item.seatingPreference && <p>Seating: {item.seatingPreference}</p>}
          {item.dietaryNotes && <p>Dietary: {item.dietaryNotes}</p>}
          {item.notes && <p className="rounded-lg p-2" style={{ background: RX.cream, color: RX.inkSoft }}>Host notes: {item.notes}</p>}
          {preorderItems.length > 0 && (
            <p>Pre-order: {preorderItems.map((entry) => entry?.name || entry).filter(Boolean).join(', ')}</p>
          )}
          {item.minimumSpendAmount != null && <p>Minimum spend: {money(item.minimumSpendAmount)} {item.minimumSpendPerPerson ? 'per guest' : 'per booking'}</p>}
          {item.depositAmount != null && <p>Deposit due: {money(item.depositAmount)}</p>}
          {item.prepaidAmount != null && <p>Prepaid value: {money(item.prepaidAmount)}</p>}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {item.arrivalStatus === 'RESERVED' && <Action label="Arrived" disabled={saving} onClick={() => onStatus(item, { arrivalStatus: 'ARRIVED' })} />}
        {['RESERVED', 'ARRIVED'].includes(item.arrivalStatus) && <Action label="Seat" disabled={saving} onClick={() => onStatus(item, { arrivalStatus: 'SEATED' })} />}
        {item.arrivalStatus !== 'COMPLETED' && (
          <Action
            label="Complete"
            disabled={saving}
            onClick={() => balanceDue > 0 ? onPayment(item, { completeAfterPayment: true }) : onStatus(item, { arrivalStatus: 'COMPLETED' })}
          />
        )}
        <Action label="Update payment" disabled={saving} muted onClick={() => onPayment(item)} />
        {balanceDue > 0 && (
          <Action
            label={`Collect ${money(balanceDue)}`}
            disabled={saving}
            onClick={() => onPayment(item)}
          />
        )}
        {!['COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(item.arrivalStatus) && (
          <>
            <Action label="No-show" disabled={saving} muted onClick={() => onStatus(item, { arrivalStatus: 'NO_SHOW' })} />
            <Action label="Cancel" disabled={saving} danger onClick={() => onStatus(item, { arrivalStatus: 'CANCELLED' })} />
          </>
        )}
      </div>
    </article>
  );
}

function PaymentDialog({ draft, saving, onChange, onCancel, onSave }) {
  const item = draft.item;
  const finalPrice = Number(draft.finalPrice || 0);
  const paidAmount = Number(draft.paidAmount || 0);
  const balance = Math.max(0, finalPrice - paidAmount);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(36,27,23,0.55)' }}>
      <section className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em]" style={{ color: RX.gold }}>Payment collection</p>
            <h3 className="mt-1 text-2xl" style={{ fontFamily: RX.serif, color: RX.ink }}>{item.guestName}</h3>
            <p className="mt-1 text-sm font-semibold" style={{ color: RX.inkSoft }}>{item.startTime} · {item.partySize} guests</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-lg border px-3 py-1.5 text-xs font-black" style={{ borderColor: RX.line, color: RX.inkSoft }}>
            Close
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Input label="Final bill" type="number" value={draft.finalPrice} onChange={(v) => onChange({ finalPrice: v })} />
          <Input label="Amount paid" type="number" value={draft.paidAmount} onChange={(v) => onChange({ paidAmount: v })} />
          <Select label="Status" value={draft.paymentStatus} onChange={(v) => onChange({ paymentStatus: v })}>
            <option value="UNPAID">Unpaid</option>
            <option value="PARTIAL">Partial</option>
            <option value="PAID">Paid</option>
          </Select>
          <Select label="Method" value={draft.paymentMethod} onChange={(v) => onChange({ paymentMethod: v })}>
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="UPI">UPI</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="OTHER">Other</option>
          </Select>
        </div>
        <div className="mt-3 grid gap-3">
          <Input label="Reference" value={draft.paymentReference} onChange={(v) => onChange({ paymentReference: v })} placeholder="Receipt, terminal, UPI, or transfer ref" />
          <TextArea label="Payment note" value={draft.paymentNote} onChange={(v) => onChange({ paymentNote: v })} />
        </div>

        <div className="mt-4 rounded-xl p-4 text-sm font-semibold" style={{ background: RX.cream, color: RX.inkSoft }}>
          Balance after payment: <span className="font-black" style={{ color: RX.ink }}>{money(balance)}</span>
          {draft.completeAfterPayment && <span className="block pt-1 text-xs" style={{ color: RX.muted }}>Saving will also mark this party as completed.</span>}
        </div>

        <button
          type="button"
          disabled={saving}
          onClick={onSave}
          className="mt-4 w-full rounded-xl px-4 py-3 text-sm font-black text-white disabled:opacity-50"
          style={{ background: RX.wine }}
        >
          {saving ? 'Saving...' : 'Save payment'}
        </button>
      </section>
    </div>
  );
}

function Action({ label, onClick, disabled, danger = false, muted = false }) {
  const style = danger
    ? { borderColor: '#FCA5A5', background: '#FEF2F2', color: '#B91C1C' }
    : muted
      ? { borderColor: RX.line, background: RX.panel, color: RX.inkSoft }
      : { borderColor: RX.teal, background: RX.tealSoft, color: RX.teal };
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded-lg border px-3 py-1.5 text-xs font-black disabled:opacity-50" style={style}>
      {label}
    </button>
  );
}

function Input({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <label className="block">
      <span className="text-xs font-black uppercase tracking-[0.14em]" style={{ color: RX.muted }}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="rx-field mt-1 w-full rounded-xl border px-3 py-2.5 text-sm outline-none"
        style={{ borderColor: RX.line, color: RX.ink }}
      />
    </label>
  );
}

function Select({ label, value, onChange, children }) {
  return (
    <label className="block">
      <span className="text-xs font-black uppercase tracking-[0.14em]" style={{ color: RX.muted }}>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="rx-field mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-semibold outline-none" style={{ borderColor: RX.line, color: RX.ink }}>
        {children}
      </select>
    </label>
  );
}

function TextArea({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-xs font-black uppercase tracking-[0.14em]" style={{ color: RX.muted }}>{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        className="rx-field mt-1 w-full resize-none rounded-xl border px-3 py-2.5 text-sm outline-none"
        style={{ borderColor: RX.line, color: RX.ink }}
      />
    </label>
  );
}

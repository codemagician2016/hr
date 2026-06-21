'use client';

import { useEffect, useRef, useState } from 'react';
import { fromMinutes, snapDropMinutes } from '@/lib/timeSlots';

const HOUR_HEIGHT = 60; // px per hour
const START_HOUR = 7;   // calendar starts at 7am
const END_HOUR = 21;    // calendar ends at 9pm
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
const SNAP_MIN = 15;    // drag-drop snaps to 15-min increments

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Drag-to-reschedule is allowed only for live appointments. Past /
// cancelled / completed bookings stay anchored.
const DRAGGABLE_STATUSES = new Set(['PENDING', 'CONFIRMED']);

const STATUS_COLORS = {
  PENDING:   { bg: 'rgba(245, 158, 11, 0.15)', border: 'rgb(245, 158, 11)', text: 'rgb(180, 83, 9)' },
  CONFIRMED: { bg: 'rgba(16, 185, 129, 0.15)', border: 'rgb(16, 185, 129)', text: 'rgb(6, 95, 70)' },
  COMPLETED: { bg: 'rgba(59, 130, 246, 0.12)', border: 'rgb(59, 130, 246)', text: 'rgb(30, 64, 175)' },
  NO_SHOW:   { bg: 'rgba(244, 63, 94, 0.12)',  border: 'rgb(244, 63, 94)',  text: 'rgb(159, 18, 57)' },
  CANCELLED: { bg: 'rgba(156, 163, 175, 0.12)', border: 'rgb(156, 163, 175)', text: 'rgb(107, 114, 128)' },
};

// Split a day's appointments into overlap-safe columns so concurrent
// bookings render side-by-side instead of stacking invisibly.
function layoutDay(appts) {
  const sorted = [...appts].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  const columns = []; // each column: { endMin, items: [...] }
  for (const a of sorted) {
    const start = toMinutes(a.startTime);
    const end = toMinutes(a.endTime);
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i].endMin <= start) {
        columns[i].items.push({ appt: a, col: i });
        columns[i].endMin = end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push({ endMin: end, items: [{ appt: a, col: columns.length }] });
    }
  }
  const total = Math.max(columns.length, 1);
  const flat = [];
  for (const col of columns) for (const it of col.items) flat.push({ ...it, total });
  return flat;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function getWeekDates(baseDate) {
  const d = new Date(baseDate);
  const day = d.getDay(); // 0=Sun
  const start = new Date(d);
  start.setDate(d.getDate() - day + 1); // Monday
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return date;
  });
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Weekly calendar view. Used by both the staff dashboard (one person's
 * week) and the business-admin appointments tab (whole team's week).
 *
 * Props:
 * - appointments: array of appointment objects from /api/appointments
 * - schedule: array of StaffSchedule objects. Optional — admin usage passes [].
 * - onAppointmentClick(appointment): callback when clicking an appointment
 * - showStaff: when true, appointment blocks include the staff name so the
 *   admin can tell at a glance who's booked. Staff dashboard omits this.
 * - staffOptions: [{ id, name }] — optional list of staff to render as
 *   columns when the admin toggles to "Day · per staff" view. When
 *   empty/omitted the per-staff toggle is hidden.
 * - onDragReschedule(appointment, { date, startTime, endTime }): callback
 *   fired when the admin drag-and-drops an appointment to a new slot.
 *   Receives the absolute new date (YYYY-MM-DD) + new start/end times
 *   (HH:MM, end preserves duration). Caller wires to the existing
 *   PUT /api/appointments/:id/reschedule endpoint. When omitted, drag
 *   is disabled — e.g. the staff dashboard which is read-only.
 */
export default function WeekCalendar({ appointments = [], schedule = [], onAppointmentClick, showStaff = false, staffOptions = [], onDragReschedule }) {
  // 'week' (default): 7-day grid, all staff merged per day.
  // 'staff-day': single-day view, one column per staff member.
  const [viewMode, setViewMode] = useState('week');
  const [staffDay, setStaffDay] = useState(() => new Date());
  const [weekStart, setWeekStart] = useState(() => {
    const now = new Date();
    return getWeekDates(now);
  });

  // Drag state — what's being moved + where the cursor is hovering.
  // Stored in refs (not state) for the dragstart/dragover phase to
  // avoid re-renders on every mousemove; the live ghost preview uses
  // a separate state slice that updates only when the snapped slot
  // actually changes.
  const dragRef = useRef(null); // { id, durationMin, originalDate, originalStartMin }
  const [hover, setHover] = useState(null); // { dateKey, startMin } — drives ghost block

  const dragEnabled = typeof onDragReschedule === 'function';
  const today = formatDateKey(new Date());

  function prevWeek() {
    const d = new Date(weekStart[0]);
    d.setDate(d.getDate() - 7);
    setWeekStart(getWeekDates(d));
  }

  function nextWeek() {
    const d = new Date(weekStart[0]);
    d.setDate(d.getDate() + 7);
    setWeekStart(getWeekDates(d));
  }

  function goToday() {
    setWeekStart(getWeekDates(new Date()));
  }

  // Group appointments by date
  const apptsByDate = {};
  for (const a of appointments) {
    if (a.status === 'CANCELLED') continue;
    const key = new Date(a.date).toISOString().slice(0, 10);
    if (!apptsByDate[key]) apptsByDate[key] = [];
    apptsByDate[key].push(a);
  }

  // Schedule by day of week
  const scheduleByDow = {};
  for (const s of schedule) {
    scheduleByDow[s.dayOfWeek] = s;
  }

  const weekLabel = `${MONTH_NAMES[weekStart[0].getMonth()]} ${weekStart[0].getDate()} – ${MONTH_NAMES[weekStart[6].getMonth()]} ${weekStart[6].getDate()}, ${weekStart[6].getFullYear()}`;
  const staffDayLabel = `${DAY_NAMES[staffDay.getDay()]}, ${MONTH_NAMES[staffDay.getMonth()]} ${staffDay.getDate()}`;

  // Per-staff swimlane: hide unless we have at least 2 staff to show.
  // For solo businesses the toggle adds clutter without value.
  const canPerStaff = Array.isArray(staffOptions) && staffOptions.length >= 2;

  function prevStaffDay() {
    const d = new Date(staffDay); d.setDate(d.getDate() - 1); setStaffDay(d);
  }
  function nextStaffDay() {
    const d = new Date(staffDay); d.setDate(d.getDate() + 1); setStaffDay(d);
  }
  function goStaffToday() {
    setStaffDay(new Date());
  }

  return (
    <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b gap-3 flex-wrap" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="flex items-center gap-2">
          {viewMode === 'week' ? (
            <>
              <button onClick={prevWeek} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors hover:opacity-80"
                style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                ‹
              </button>
              <button onClick={nextWeek} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors hover:opacity-80"
                style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                ›
              </button>
              <button onClick={goToday} className="px-3 py-1 text-xs font-medium rounded-lg border transition-colors hover:opacity-80"
                style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                Today
              </button>
            </>
          ) : (
            <>
              <button onClick={prevStaffDay} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors hover:opacity-80"
                style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                ‹
              </button>
              <button onClick={nextStaffDay} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors hover:opacity-80"
                style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                ›
              </button>
              <button onClick={goStaffToday} className="px-3 py-1 text-xs font-medium rounded-lg border transition-colors hover:opacity-80"
                style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                Today
              </button>
            </>
          )}
        </div>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>
          {viewMode === 'week' ? weekLabel : staffDayLabel}
        </h3>
        {canPerStaff && (
          <div className="inline-flex items-center rounded-lg p-0.5" style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary) 6%, transparent)' }}>
            {[
              { k: 'week', label: 'Week' },
              { k: 'staff-day', label: 'Day · per staff' },
            ].map((t) => {
              const active = viewMode === t.k;
              return (
                <button key={t.k} onClick={() => setViewMode(t.k)}
                  className="px-3 py-1 text-[11px] font-medium rounded-md transition-colors"
                  style={{
                    backgroundColor: active ? 'var(--theme-bg)' : 'transparent',
                    color: active ? 'var(--theme-text)' : 'var(--theme-muted)',
                    boxShadow: active ? '0 1px 2px rgba(11,11,20,.08)' : 'none',
                  }}>
                  {t.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Per-staff swimlane body — early-return so the rest of the
          file stays focused on the week-grid layout. */}
      {viewMode === 'staff-day' && canPerStaff ? (
        <StaffDayBody
          staffDay={staffDay}
          today={today}
          appointments={appointments}
          staffOptions={staffOptions}
          onAppointmentClick={onAppointmentClick}
          dragEnabled={dragEnabled}
          dragRef={dragRef}
          hover={hover}
          setHover={setHover}
          onDragReschedule={onDragReschedule}
        />
      ) : (
      <>

      {/* Day headers */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="p-2" />
        {weekStart.map((date, i) => {
          const key = formatDateKey(date);
          const isToday = key === today;
          const dow = date.getDay();
          const hasSchedule = scheduleByDow[dow];
          return (
            <div key={i} className="p-2 text-center border-l" style={{ borderColor: 'var(--theme-border)', backgroundColor: isToday ? 'color-mix(in srgb, var(--theme-primary) 8%, transparent)' : undefined }}>
              <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
                {DAY_NAMES[dow]}
              </p>
              <p className={`text-lg font-bold ${isToday ? '' : ''}`}
                style={{ color: isToday ? 'var(--theme-primary)' : 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>
                {date.getDate()}
              </p>
              {!hasSchedule && (
                <p className="text-[9px]" style={{ color: 'var(--theme-muted)' }}>Off</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Time grid — hour rows render as a backdrop; appointments render as
          absolute-positioned blocks on top of the whole day column so side-
          by-side overlapping bookings can both be visible. */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] overflow-y-auto relative" style={{ maxHeight: 520 }}>
        {/* Hour label column */}
        <div className="flex flex-col" style={{ height: HOURS.length * HOUR_HEIGHT }}>
          {HOURS.map((hour) => (
            <div key={hour} className="flex items-start justify-end pr-2 pt-0.5 border-b border-r"
              style={{ height: HOUR_HEIGHT, borderColor: 'var(--theme-border)' }}>
              <span className="text-[10px]" style={{ color: 'var(--theme-muted)' }}>
                {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
              </span>
            </div>
          ))}
        </div>

        {/* One column per weekday */}
        {weekStart.map((date, di) => {
          const key = formatDateKey(date);
          const isToday = key === today;
          const dow = date.getDay();
          const sched = scheduleByDow[dow];
          const dayAppts = layoutDay(
            (apptsByDate[key] || []).filter((a) => {
              const s = toMinutes(a.startTime);
              return s >= START_HOUR * 60 && s < END_HOUR * 60;
            })
          );
          const dayHeight = HOURS.length * HOUR_HEIGHT;

          // Drop-target handlers. Computes the snapped target slot from
          // the cursor's Y position relative to the column top, then
          // updates the hover ghost. On drop, calls the parent's
          // reschedule callback with the new date + start/end.
          function dropHandlers() {
            if (!dragEnabled) return {};
            return {
              onDragOver: (e) => {
                if (!dragRef.current) return;
                e.preventDefault(); // required to allow drop
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const snapped = snapDropMinutes({
                  yPx: e.clientY - rect.top,
                  hourHeight: HOUR_HEIGHT,
                  startHour: START_HOUR,
                  endHour: END_HOUR,
                  durationMin: dragRef.current.durationMin,
                  snapMin: SNAP_MIN,
                });
                if (!hover || hover.dateKey !== key || hover.startMin !== snapped) {
                  setHover({ dateKey: key, startMin: snapped });
                }
              },
              onDragLeave: (e) => {
                // Only clear when leaving the column entirely. A leave fired
                // because the cursor is on a child element should be
                // ignored (relatedTarget stays inside the column).
                if (e.currentTarget.contains(e.relatedTarget)) return;
                if (hover && hover.dateKey === key) setHover(null);
              },
              onDrop: (e) => {
                e.preventDefault();
                const drag = dragRef.current;
                if (!drag || !hover || hover.dateKey !== key) return;
                const newStartMin = hover.startMin;
                const newEndMin = newStartMin + drag.durationMin;
                // Skip the API call if nothing actually changed.
                const sameSlot = drag.originalDate === key && drag.originalStartMin === newStartMin;
                dragRef.current = null;
                setHover(null);
                if (sameSlot) return;
                const appt = appointments.find((a) => a.id === drag.id);
                if (!appt) return;
                onDragReschedule(appt, {
                  date: key,
                  startTime: fromMinutes(newStartMin),
                  endTime: fromMinutes(newEndMin),
                });
              },
            };
          }
          const dh = dropHandlers();

          return (
            <div
              key={di}
              className="relative border-l"
              style={{ height: dayHeight, borderColor: 'var(--theme-border)' }}
              {...dh}
            >
              {/* Hour grid lines + scheduled-hours tint */}
              {HOURS.map((hour) => {
                const inSchedule = sched && hour >= parseInt(sched.startTime) && hour < parseInt(sched.endTime);
                return (
                  <div key={hour} className="border-b"
                    style={{
                      height: HOUR_HEIGHT,
                      borderColor: 'var(--theme-border)',
                      backgroundColor: isToday
                        ? 'color-mix(in srgb, var(--theme-primary) 4%, transparent)'
                        : inSchedule
                          ? 'color-mix(in srgb, var(--theme-primary) 3%, transparent)'
                          : undefined,
                    }}
                  />
                );
              })}

              {/* Appointment blocks — positioned over the hour grid */}
              {dayAppts.map(({ appt: a, col, total }) => {
                const startMin = toMinutes(a.startTime);
                const endMin = toMinutes(a.endTime);
                const duration = endMin - startMin;
                const top = ((startMin - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                const height = Math.max((duration / 60) * HOUR_HEIGHT, 22);
                const colors = STATUS_COLORS[a.status] || STATUS_COLORS.PENDING;
                // Split the column horizontally among overlapping items.
                const widthPct = 100 / total;
                const leftPct = col * widthPct;
                const customerName = a.customer?.name || a.user?.name || 'Customer';
                const canDrag = dragEnabled && DRAGGABLE_STATUSES.has(a.status);
                const isDragging = dragRef.current?.id === a.id && hover !== null;

                return (
                  <button
                    key={a.id}
                    onClick={() => onAppointmentClick?.(a)}
                    draggable={canDrag}
                    onDragStart={canDrag ? (e) => {
                      dragRef.current = {
                        id: a.id,
                        durationMin: duration,
                        originalDate: key,
                        originalStartMin: startMin,
                      };
                      // Required for Firefox to actually start the drag.
                      try { e.dataTransfer.setData('text/plain', a.id); } catch {}
                      e.dataTransfer.effectAllowed = 'move';
                    } : undefined}
                    onDragEnd={canDrag ? () => {
                      dragRef.current = null;
                      setHover(null);
                    } : undefined}
                    className={`absolute rounded-md px-1.5 py-0.5 overflow-hidden text-left transition-opacity hover:opacity-80 ${canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${isDragging ? 'opacity-30' : ''}`}
                    style={{
                      top,
                      height,
                      left: `calc(${leftPct}% + 2px)`,
                      width: `calc(${widthPct}% - 4px)`,
                      backgroundColor: colors.bg,
                      borderLeft: `3px solid ${colors.border}`,
                      zIndex: 10,
                    }}
                    title={`${a.startTime}–${a.endTime} · ${a.service?.name || ''} · ${customerName}${showStaff && a.staff?.name ? ' · ' + a.staff.name : ''}${canDrag ? ' · drag to reschedule' : ''}`}
                  >
                    <p className="text-[10px] font-semibold truncate" style={{ color: colors.text }}>
                      {a.startTime} {a.service?.name || 'Appt'}
                    </p>
                    {height > 30 && (
                      <p className="text-[9px] truncate" style={{ color: colors.text, opacity: 0.8 }}>
                        {customerName}
                        {showStaff && a.staff?.name && ` · ${a.staff.name}`}
                      </p>
                    )}
                  </button>
                );
              })}

              {/* Ghost preview — shows where the dragged appointment will
                  land if dropped here. Snapped to 15 min, sized to the
                  dragged appointment's duration. */}
              {dragRef.current && hover && hover.dateKey === key && (
                <div
                  className="absolute rounded-md pointer-events-none"
                  style={{
                    top: ((hover.startMin - START_HOUR * 60) / 60) * HOUR_HEIGHT,
                    height: Math.max((dragRef.current.durationMin / 60) * HOUR_HEIGHT, 22),
                    left: 2,
                    right: 2,
                    backgroundColor: 'color-mix(in srgb, var(--theme-primary) 18%, transparent)',
                    border: '2px dashed var(--theme-primary)',
                    zIndex: 9,
                  }}
                >
                  <p className="text-[10px] font-semibold px-1.5 pt-0.5" style={{ color: 'var(--theme-primary)' }}>
                    Drop → {fromMinutes(hover.startMin)}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      </>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 px-4 py-2.5 border-t text-[10px]" style={{ borderColor: 'var(--theme-border)' }}>
        {Object.entries(STATUS_COLORS).filter(([k]) => k !== 'CANCELLED').map(([status, colors]) => (
          <div key={status} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colors.border }} />
            <span style={{ color: 'var(--theme-muted)' }}>
              {status === 'NO_SHOW' ? 'No-show' : status.charAt(0) + status.slice(1).toLowerCase()}
            </span>
          </div>
        ))}
        {dragEnabled && (
          <div className="ml-auto flex items-center gap-1.5">
            <span aria-hidden="true">⇕</span>
            <span style={{ color: 'var(--theme-muted)' }}>
              Drag pending / confirmed bookings to reschedule
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Per-staff swimlane (single day, one column per staff) ─────────────
//
// Uses the same hour-rail and STATUS_COLORS as the week grid so the
// visual language stays consistent. Each staff column shows ONLY that
// person's appointments for the chosen day, so within a column there
// are no overlapping bookings to lay out side-by-side. Drag-and-drop
// reschedule still works: dragging onto a column = same staff, drop
// to another column would require a staff switch (not yet supported,
// so cross-column drops fall back to keeping the original staff).
function StaffDayBody({ staffDay, today, appointments, staffOptions, onAppointmentClick, dragEnabled, dragRef, hover, setHover, onDragReschedule }) {
  const dayKey = staffDay.toISOString().slice(0, 10);
  const isToday = dayKey === today;
  const dayAppts = appointments.filter((a) => {
    if (a.status === 'CANCELLED') return false;
    return new Date(a.date).toISOString().slice(0, 10) === dayKey;
  });
  const dayHeight = HOURS.length * HOUR_HEIGHT;
  const colWidth = `repeat(${staffOptions.length}, minmax(140px, 1fr))`;

  return (
    <>
      {/* Staff header row */}
      <div className="grid border-b overflow-x-auto" style={{ gridTemplateColumns: `60px ${colWidth}`, borderColor: 'var(--theme-border)' }}>
        <div className="p-2" />
        {staffOptions.map((s) => (
          <div key={s.id} className="p-2 text-center border-l truncate" style={{ borderColor: 'var(--theme-border)', backgroundColor: isToday ? 'color-mix(in srgb, var(--theme-primary) 8%, transparent)' : undefined }}>
            <p className="text-xs font-bold truncate" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>
              {s.name}
            </p>
            <p className="text-[10px]" style={{ color: 'var(--theme-muted)' }}>
              {dayAppts.filter((a) => a.staffId === s.id).length} booking{dayAppts.filter((a) => a.staffId === s.id).length === 1 ? '' : 's'}
            </p>
          </div>
        ))}
      </div>

      {/* Time grid */}
      <div className="grid overflow-y-auto overflow-x-auto relative" style={{ gridTemplateColumns: `60px ${colWidth}`, maxHeight: 520 }}>
        {/* Hour label column */}
        <div className="flex flex-col" style={{ height: dayHeight }}>
          {HOURS.map((hour) => (
            <div key={hour} className="flex items-start justify-end pr-2 pt-0.5 border-b border-r"
              style={{ height: HOUR_HEIGHT, borderColor: 'var(--theme-border)' }}>
              <span className="text-[10px]" style={{ color: 'var(--theme-muted)' }}>
                {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
              </span>
            </div>
          ))}
        </div>

        {/* One column per staff */}
        {staffOptions.map((staff) => {
          const colAppts = dayAppts.filter((a) => a.staffId === staff.id);

          function dropHandlers() {
            if (!dragEnabled) return {};
            return {
              onDragOver: (e) => {
                if (!dragRef.current) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const snapped = snapDropMinutes({
                  yPx: e.clientY - rect.top,
                  hourHeight: HOUR_HEIGHT,
                  startHour: START_HOUR,
                  endHour: END_HOUR,
                  durationMin: dragRef.current.durationMin,
                  snapMin: 15,
                });
                if (!hover || hover.dateKey !== `${dayKey}#${staff.id}` || hover.startMin !== snapped) {
                  setHover({ dateKey: `${dayKey}#${staff.id}`, startMin: snapped });
                }
              },
              onDragLeave: (e) => {
                if (e.currentTarget.contains(e.relatedTarget)) return;
                if (hover && hover.dateKey === `${dayKey}#${staff.id}`) setHover(null);
              },
              onDrop: (e) => {
                e.preventDefault();
                const drag = dragRef.current;
                if (!drag || !hover || hover.dateKey !== `${dayKey}#${staff.id}`) return;
                const newStartMin = hover.startMin;
                const newEndMin = newStartMin + drag.durationMin;
                const sameSlot = drag.originalDate === dayKey && drag.originalStartMin === newStartMin;
                dragRef.current = null;
                setHover(null);
                if (sameSlot) return;
                const appt = appointments.find((a) => a.id === drag.id);
                if (!appt) return;
                onDragReschedule(appt, {
                  date: dayKey,
                  startTime: fromMinutes(newStartMin),
                  endTime: fromMinutes(newEndMin),
                });
              },
            };
          }
          const dh = dropHandlers();

          return (
            <div key={staff.id} className="relative border-l" style={{ height: dayHeight, borderColor: 'var(--theme-border)' }} {...dh}>
              {/* Hour grid lines */}
              {HOURS.map((hour) => (
                <div key={hour} className="border-b" style={{ height: HOUR_HEIGHT, borderColor: 'var(--theme-border)', backgroundColor: isToday ? 'color-mix(in srgb, var(--theme-primary) 4%, transparent)' : undefined }} />
              ))}

              {/* Appointment blocks for this staff */}
              {colAppts.map((a) => {
                const startMin = (() => { const [h, m] = a.startTime.split(':').map(Number); return h * 60 + m; })();
                const endMin = (() => { const [h, m] = a.endTime.split(':').map(Number); return h * 60 + m; })();
                const duration = endMin - startMin;
                const top = ((startMin - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                const height = Math.max((duration / 60) * HOUR_HEIGHT, 22);
                const colors = STATUS_COLORS[a.status] || STATUS_COLORS.PENDING;
                const customerName = a.customer?.name || a.user?.name || 'Customer';
                const canDrag = dragEnabled && DRAGGABLE_STATUSES.has(a.status);
                const isDragging = dragRef.current?.id === a.id && hover !== null;

                return (
                  <button
                    key={a.id}
                    onClick={() => onAppointmentClick?.(a)}
                    draggable={canDrag}
                    onDragStart={canDrag ? (e) => {
                      dragRef.current = {
                        id: a.id,
                        durationMin: duration,
                        originalDate: dayKey,
                        originalStartMin: startMin,
                      };
                      try { e.dataTransfer.setData('text/plain', a.id); } catch {}
                      e.dataTransfer.effectAllowed = 'move';
                    } : undefined}
                    onDragEnd={canDrag ? () => { dragRef.current = null; setHover(null); } : undefined}
                    className={`absolute rounded-md px-1.5 py-0.5 overflow-hidden text-left transition-opacity hover:opacity-80 ${canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${isDragging ? 'opacity-30' : ''}`}
                    style={{
                      top, height, left: 4, right: 4,
                      backgroundColor: colors.bg,
                      borderLeft: `3px solid ${colors.border}`,
                      zIndex: 10,
                    }}
                    title={`${a.startTime}–${a.endTime} · ${a.service?.name || ''} · ${customerName}${canDrag ? ' · drag to reschedule' : ''}`}
                  >
                    <p className="text-[10px] font-semibold truncate" style={{ color: colors.text }}>
                      {a.startTime} {a.service?.name || 'Appt'}
                    </p>
                    {height > 30 && (
                      <p className="text-[9px] truncate" style={{ color: colors.text, opacity: 0.8 }}>
                        {customerName}
                      </p>
                    )}
                  </button>
                );
              })}

              {/* Ghost preview for drag-target */}
              {dragRef.current && hover && hover.dateKey === `${dayKey}#${staff.id}` && (
                <div
                  className="absolute rounded-md pointer-events-none"
                  style={{
                    top: ((hover.startMin - START_HOUR * 60) / 60) * HOUR_HEIGHT,
                    height: Math.max((dragRef.current.durationMin / 60) * HOUR_HEIGHT, 22),
                    left: 4, right: 4,
                    backgroundColor: 'color-mix(in srgb, var(--theme-primary) 18%, transparent)',
                    border: '2px dashed var(--theme-primary)',
                    zIndex: 9,
                  }}
                >
                  <p className="text-[10px] font-semibold px-1.5 pt-0.5" style={{ color: 'var(--theme-primary)' }}>
                    Drop → {fromMinutes(hover.startMin)}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

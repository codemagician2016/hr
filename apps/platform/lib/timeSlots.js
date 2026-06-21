// Pure helpers for calendar slot math. Used by WeekCalendar's drag-and-
// drop reschedule (cursor Y → snapped HH:MM in the local day) but pure
// enough that the same module powers the same conversion anywhere else
// we render time slots in the future.
//
// All times are minutes-since-midnight integers internally; "HH:MM"
// strings are produced only at the boundary.

// Convert "HH:MM" → minutes since midnight.
export function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return NaN;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Inverse — minutes back to "HH:MM" with leading zeros.
export function fromMinutes(min) {
  const safe = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Given a cursor Y (px) inside a day-column whose top maps to startHour,
// return the snapped start-minute that the dragged appointment should
// land on. Clamps so the appointment never overflows the visible window
// (startHour ≤ start && start + durationMin ≤ endHour).
//
//   yPx        — cursor offset from column top
//   hourHeight — px per hour (60 in the current calendar)
//   startHour  — the hour shown at y=0 (e.g. 7)
//   endHour    — the hour just after the last visible row (e.g. 21)
//   durationMin — how long the dragged appointment is
//   snapMin    — snap interval (15 min in the calendar)
export function snapDropMinutes({ yPx, hourHeight, startHour, endHour, durationMin, snapMin = 15 }) {
  const rawMin = (yPx / hourHeight) * 60 + startHour * 60;
  const snapped = Math.round(rawMin / snapMin) * snapMin;
  const min = Math.max(
    startHour * 60,
    Math.min(endHour * 60 - durationMin, snapped)
  );
  return min;
}

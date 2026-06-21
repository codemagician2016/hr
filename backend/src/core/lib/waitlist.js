// Pure helpers for the customer waitlist. The matcher decides whether
// a given freed slot (cancelled / no-show / rescheduled-away
// appointment) matches a waitlist row's preferences. Kept pure so
// the controller can unit-test it with fixtures and so we can change
// the matching rule without touching DB code.

const ACTIVE_WAITLIST_STATUSES = new Set(['PENDING', 'NOTIFIED']);

// Day-only comparison: a Date or ISO string → "YYYY-MM-DD" in UTC.
function dayKey(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

// "HH:MM" → minutes since midnight. NaN on bad input so the matcher
// can fail-safe (treat unparseable times as "doesn't match").
function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return NaN;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Does this waitlist row want this newly-freed slot?
//
// freed   — { businessId, serviceId, staffId, date, startTime } (the
//            cancelled / rescheduled-away appointment)
// row     — Waitlist record (status, expiresAt, preferredDate,
//            preferredStartTime, preferredEndTime, serviceId, staffId)
// now     — current time (Date), defaults to new Date(); pass a fixed
//            value in tests to make expiry deterministic
function matchesFreedSlot(freed, row, now = new Date()) {
  if (!freed || !row) return false;
  if (row.businessId !== freed.businessId) return false;
  if (!ACTIVE_WAITLIST_STATUSES.has(row.status)) return false;
  if (row.expiresAt && new Date(row.expiresAt) < now) return false;
  if (dayKey(row.preferredDate) !== dayKey(freed.date)) return false;
  // Service preference: null on the row = "any service", else must match.
  if (row.serviceId && row.serviceId !== freed.serviceId) return false;
  // Staff preference: null = "anyone", else must match.
  if (row.staffId && row.staffId !== freed.staffId) return false;

  // Time window. Each bound is optional. We test against the freed
  // appointment's *start time*. If both bounds are null the customer
  // is happy with any time on that day.
  const freedStart = toMinutes(freed.startTime);
  if (Number.isNaN(freedStart)) return false;
  if (row.preferredStartTime) {
    const lo = toMinutes(row.preferredStartTime);
    if (Number.isNaN(lo) || freedStart < lo) return false;
  }
  if (row.preferredEndTime) {
    const hi = toMinutes(row.preferredEndTime);
    if (Number.isNaN(hi) || freedStart > hi) return false;
  }
  return true;
}

module.exports = { matchesFreedSlot, ACTIVE_WAITLIST_STATUSES };

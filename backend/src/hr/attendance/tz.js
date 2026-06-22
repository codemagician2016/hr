'use strict';

/**
 * tz.js — minimal IANA-timezone helpers for attendance (Feature 2).
 *
 * Built ENTIRELY on the JS built-in `Intl.DateTimeFormat` (no luxon / no
 * moment-timezone / no extra npm dep). The derivation core (derive.js) stays a
 * PURE function of UTC instants; this module lives in the DB-facing caller so it
 * can turn the LOCAL shift wall-clock ('HH:MM') into the correct UTC instant for
 * a civil day, and bucket a true-UTC punch into the employee's LOCAL civil day.
 *
 * Why this matters (the bug these fix):
 *   - Shift startTime/endTime are stored as LOCAL 'HH:MM' (location wall-clock),
 *     but a punch's punchAt is a true UTC instant. Comparing the two as if the
 *     shift were UTC wall-time makes LATE_IN / EARLY_OUT mis-fire by the tz
 *     offset (5.5h for IN, 12/13h for NZ).
 *   - Keying a punch's civil day off its UTC date (utcDay) buckets an evening
 *     NZ punch (which is the next UTC day) onto the wrong local day.
 */

// Country → default IANA zone fallback when no row carries an explicit timezone.
const COUNTRY_TZ = Object.freeze({
  IN: 'Asia/Kolkata',
  NZ: 'Pacific/Auckland',
});

const DEFAULT_TZ = 'UTC';

/**
 * resolveTimezone(employee, { location, entity, business }) → IANA zone string.
 * Precedence: location.timezone → entity.timezone → business.timezone →
 * countryCode fallback (employee/entity/location countryCode) → 'UTC'.
 * Never throws; always returns a usable zone string.
 */
function resolveTimezone(employee, ctx = {}) {
  const { location, entity, business } = ctx;
  if (location && location.timezone) return location.timezone;
  if (entity && entity.timezone) return entity.timezone;
  if (business && business.timezone) return business.timezone;
  const cc =
    (employee && employee.countryCode) ||
    (location && location.countryCode) ||
    (entity && entity.countryCode) ||
    null;
  if (cc && COUNTRY_TZ[String(cc).toUpperCase()]) return COUNTRY_TZ[String(cc).toUpperCase()];
  return DEFAULT_TZ;
}

// Cache one Intl.DateTimeFormat per zone (constructing them is comparatively
// expensive and we call these per-day in a tight loop).
const _civilFmtCache = new Map();
function _civilFmt(tz) {
  let f = _civilFmtCache.get(tz);
  if (!f) {
    // 'en-CA' renders an ISO-ish YYYY-MM-DD date; the timeZone re-keys the wall clock.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    _civilFmtCache.set(tz, f);
  }
  return f;
}

const _partsFmtCache = new Map();
function _partsFmt(tz) {
  let f = _partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    _partsFmtCache.set(tz, f);
  }
  return f;
}

/**
 * civilDateInTz(instant, tz) → 'YYYY-MM-DD' — the LOCAL civil date of a UTC
 * instant in the given zone. `instant` may be a Date, ms number, or ISO string.
 */
function civilDateInTz(instant, tz) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (!tz || tz === 'UTC') {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
      .toISOString().slice(0, 10);
  }
  // en-CA → "YYYY-MM-DD".
  return _civilFmt(tz).format(d);
}

/**
 * tzOffsetMs(utcMs, tz) → offset in ms (localWallClock − UTC) for the instant.
 * Positive east of UTC (IST +5.5h → +19800000). Uses the formatToParts trick:
 * render the instant as a wall clock in `tz`, read it back as if it were UTC,
 * and diff against the true UTC ms.
 */
function tzOffsetMs(utcMs, tz) {
  if (!tz || tz === 'UTC') return 0;
  const parts = _partsFmt(tz).formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  // Intl renders midnight as hour '24' in some engines; normalise to 0.
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    hour, Number(map.minute), Number(map.second),
  );
  return asUtc - utcMs;
}

/**
 * zonedWallTimeToUtc(dateStr, 'HH:MM', tz) → Date (the UTC instant of that LOCAL
 * wall-clock time on that LOCAL civil date in `tz`).
 *
 * Strategy: guess the UTC ms as if the wall time were UTC, subtract the zone's
 * offset at that guess, then REFINE once (the offset can shift across the guess
 * near a DST boundary). One refinement is enough for all real zones.
 */
function zonedWallTimeToUtc(dateStr, hhmm, tz) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  const tmRaw = /^(\d{1,2}):(\d{2})/.exec(String(hhmm == null ? '' : hhmm));
  if (!dm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]) - 1;
  const da = Number(dm[3]);
  const hh = tmRaw ? Number(tmRaw[1]) : 0;
  const mi = tmRaw ? Number(tmRaw[2]) : 0;
  if (!tz || tz === 'UTC') return new Date(Date.UTC(y, mo, da, hh, mi));

  const guess = Date.UTC(y, mo, da, hh, mi);
  let utcMs = guess - tzOffsetMs(guess, tz);
  // Refine: re-read the offset at the candidate instant and correct once.
  const off2 = tzOffsetMs(utcMs, tz);
  utcMs = guess - off2;
  return new Date(utcMs);
}

module.exports = {
  COUNTRY_TZ,
  resolveTimezone,
  civilDateInTz,
  tzOffsetMs,
  zonedWallTimeToUtc,
};

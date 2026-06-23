'use strict';

/**
 * calendar.js — Working-day leave day-counting (Feature 6).
 *
 * PURE: no DB. It REUSES the exact pure resolvers from `attendance/derive.js`
 * (`isWeeklyOff`, `isHoliday`, `daysBetweenInclusive`) so leave and attendance
 * can NEVER disagree about what a working day is (docs/features/06 §4.6).
 *
 * Replaces the controller's naive `spanDays`, which charged weekends/holidays
 * inside a range. Computes per-day fractions with sandwich-policy + half-day
 * semantics and returns a structured breakdown for the ESS "computed days" hint
 * and the audit trail.
 *
 *   computeLeaveUnits(req, ctx) -> { units, dayBreakdown[] }
 *     for each civil day D in [startDate, endDate]:
 *       weekoff = isWeeklyOff(D, shift.weeklyOffDays)
 *       holiday = isHoliday(emp, D, holidays, optedRestricted)
 *       leading/trailing weekoff|holiday → skip (0 units)
 *       interior weekoff|holiday → sandwich==INCLUSIVE ? 1 : 0
 *       working day → fraction = (boundary half) ? 0.5 : 1.0
 *     units = Σ fractions
 *
 * Sandwich (§4.6): IN EL = INCLUSIVE (interior holidays debited); NZ = EXCLUSIVE
 * (a public holiday inside an annual-leave block is paid as a public holiday,
 * never debited — Holidays Act). Derived from the optional `sandwichPolicy`
 * column, else from countryCode (NZ ⇒ EXCLUSIVE).
 */

const { isWeeklyOff, isHoliday, daysBetweenInclusive } = require('../attendance/derive');
// Feature 14: the sandwich policy is sourced from the country CAPABILITY matrix
// (the single source of truth) rather than an inline `NZ ? EXCLUSIVE : INCLUSIVE`
// ternary. countryCapabilities is a pure sync read, so calendar.js stays PURE.
const { countryCapabilities } = require('../tenant/countryContext');

function utcDayMs(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}
function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * resolveSandwich(leaveType, employee) — INCLUSIVE | EXCLUSIVE.
 * Explicit `leaveType.sandwichPolicy` wins; else the policy comes from the
 * country capability matrix (IN=INCLUSIVE for EL; NZ=EXCLUSIVE per Holidays Act).
 * The leaveType/employee countryCode is the per-row signal; default INCLUSIVE.
 */
function resolveSandwich(leaveType, employee) {
  const t = leaveType || {};
  if (t.sandwichPolicy === 'INCLUSIVE' || t.sandwichPolicy === 'EXCLUSIVE') return t.sandwichPolicy;
  const cc = t.countryCode || (employee && employee.countryCode) || null;
  const caps = countryCapabilities(cc);
  return (caps && caps.leaveSandwich) || 'INCLUSIVE';
}

/**
 * computeLeaveUnits(req, ctx)
 *   req = { startDate, endDate, startHalf?, endHalf? }
 *   ctx = {
 *     employee,                       // { entityId, locationId, countryCode }
 *     leaveType,                      // { countryCode, sandwichPolicy? }
 *     weeklyOffDays,                  // CSV/array ISO weekday (from the shift)
 *     holidays,                       // [{ date, entityId, locationId, isRestricted, ... }]
 *     optedRestrictedDates?,          // Set of ISO date strings the emp opted into
 *     grain?,                         // half-day grain; informational
 *   }
 * Returns { units, dayBreakdown:[{ date, kind, fraction }], workingDays,
 *           holidayDays, weekoffDays }. `kind` ∈ WORKING|HALF|WEEKOFF|HOLIDAY|
 *           WEEKOFF_DEBITED|HOLIDAY_DEBITED.
 */
function computeLeaveUnits(req, ctx = {}) {
  const r = req || {};
  if (!r.startDate || !r.endDate) return { units: 0, dayBreakdown: [], workingDays: 0, holidayDays: 0, weekoffDays: 0 };

  const startMs = utcDayMs(r.startDate);
  const endMs = utcDayMs(r.endDate);
  if (endMs < startMs) return { units: null, dayBreakdown: [], workingDays: 0, holidayDays: 0, weekoffDays: 0 };

  const total = daysBetweenInclusive(startMs, endMs);
  const sandwich = resolveSandwich(ctx.leaveType, ctx.employee);
  const inclusive = sandwich === 'INCLUSIVE';
  const opted = ctx.optedRestrictedDates instanceof Set
    ? ctx.optedRestrictedDates
    : new Set(ctx.optedRestrictedDates || []);

  // First pass: classify each day as working / non-working.
  const days = [];
  for (let i = 0; i < total; i += 1) {
    const ms = startMs + i * 86400000;
    const iso = isoDay(ms);
    const weekoff = isWeeklyOff(ms, ctx.weeklyOffDays);
    const holiday = !!isHoliday(ctx.employee || {}, ms, ctx.holidays, opted);
    days.push({ ms, iso, weekoff, holiday, working: !weekoff && !holiday });
  }

  // Find the first/last WORKING day → leading/trailing non-working are skipped.
  let firstWork = -1; let lastWork = -1;
  for (let i = 0; i < days.length; i += 1) {
    if (days[i].working) { if (firstWork === -1) firstWork = i; lastWork = i; }
  }

  const breakdown = [];
  let unitsMilli = 0; // integer thousandths
  let workingDays = 0; let holidayDays = 0; let weekoffDays = 0;

  for (let i = 0; i < days.length; i += 1) {
    const d = days[i];
    const isLeading = firstWork === -1 || i < firstWork;
    const isTrailing = firstWork === -1 || i > lastWork;
    let kind; let fraction = 0;

    if (d.working) {
      // Half-day lands on the actually-charged BOUNDARY working day, not the raw
      // request endpoint. When the request starts/ends on a leading/trailing
      // non-working day (a weekoff/holiday), the first/last WORKING day
      // (firstWork/lastWork) is the charged boundary — tying the half to
      // startMs/endMs would silently no-op and over-charge a full day (finding #6).
      const startHalf = i === firstWork && !!r.startHalf;
      const endHalf = i === lastWork && !!r.endHalf;
      // A single-day (firstWork === lastWork) request is half whenever EITHER half
      // is set (incl. both-halves), so it stays 0.5 rather than 1.0.
      fraction = (startHalf || endHalf) ? 0.5 : 1.0;
      kind = fraction === 0.5 ? 'HALF' : 'WORKING';
      workingDays += fraction === 0.5 ? 0.5 : 1;
    } else if (isLeading || isTrailing) {
      kind = d.holiday ? 'HOLIDAY' : 'WEEKOFF';
      fraction = 0; // leading/trailing non-working never debited
    } else {
      // interior weekoff/holiday — sandwich rule decides
      if (inclusive) {
        fraction = 1;
        kind = d.holiday ? 'HOLIDAY_DEBITED' : 'WEEKOFF_DEBITED';
      } else {
        fraction = 0;
        kind = d.holiday ? 'HOLIDAY' : 'WEEKOFF';
      }
    }

    if (d.holiday) holidayDays += 1; else if (d.weekoff) weekoffDays += 1;
    unitsMilli += Math.round(fraction * 1000);
    breakdown.push({ date: d.iso, kind, fraction });
  }

  return {
    units: Math.round((unitsMilli / 1000) * 1e4) / 1e4,
    dayBreakdown: breakdown,
    workingDays,
    holidayDays,
    weekoffDays,
    sandwich,
  };
}

/**
 * consecutiveCalendarDays(req) — raw inclusive calendar span (for the
 * `maxConsecutive` gate, which in IN counts calendar days incl. sandwiched
 * holidays, not netted working days).
 */
function consecutiveCalendarDays(req) {
  const r = req || {};
  if (!r.startDate || !r.endDate) return 0;
  return daysBetweenInclusive(utcDayMs(r.startDate), utcDayMs(r.endDate));
}

module.exports = {
  computeLeaveUnits,
  resolveSandwich,
  consecutiveCalendarDays,
};

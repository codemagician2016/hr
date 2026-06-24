'use strict';

/**
 * service.js — Attendance DERIVATION ORCHESTRATOR (Feature 2, Phase 3).
 *
 * Bridges the PURE derivation core (./derive.js) to Prisma. This is the DB-facing
 * half of the pipeline:
 *
 *   AttendancePunch ┐
 *   LeaveTransaction├─► derive(ctx) ─► Attendance (1/emp/day, upsert)
 *   Holiday         ┤
 *   Schedule        ┘
 *
 * `recompute(businessId, employeeId, fromDate, toDate, tx?)` walks each CIVIL day
 * in [fromDate, toDate], gathers the inputs the pure engine needs, calls derive(),
 * and UPSERTs the canonical daily Attendance row — but NEVER overwrites a row that
 * is `isLocked = true` (frozen by period-close / freeze). Idempotent: re-running
 * with the same DB state yields the same rows.
 *
 * Tenant scope: every query is filtered by businessId. derive.js itself is PURE and
 * is consumed unchanged.
 */

const prisma = require('../../core/lib/prisma');
const {
  derive,
  resolveSchedule,
  isHoliday,
  isWeeklyOff,
} = require('./derive');
const { resolveTimezone, civilDateInTz, zonedWallTimeToUtc } = require('./tz');
const { tenantCountry } = require('../tenant/countryContext');
const { evaluatePunchGeofence } = require('./geo');

// Resolve the tenant-wide geofence-enforce default from Business.featureFlags
// (attendance.geofenceEnforce). Falls back to false (WARN ONLY). A per-location
// Location.geofenceEnforce always overrides this (see geo.evaluatePunchGeofence).
function tenantGeofenceEnforce(business) {
  const ff = business && business.featureFlags;
  if (!ff || typeof ff !== 'object') return false;
  const att = ff.attendance;
  return !!(att && typeof att === 'object' && att.geofenceEnforce);
}

// A @db.Date column is stored at UTC midnight. Build the civil-day key the same
// way everywhere so the unique (businessId, employeeId, date) lines up. The civil
// day itself is computed in the EMPLOYEE timezone (see civilDateInTz); this only
// pins a 'YYYY-MM-DD' to the @db.Date storage convention.
function utcDay(d) {
  const t = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
// A 'YYYY-MM-DD' string → its @db.Date midnight-UTC Date.
function dayKeyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) return utcDay(new Date(key));
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
function addDays(day, n) {
  return new Date(day.getTime() + n * 86400000);
}
function dayKey(d) {
  return utcDay(d).toISOString().slice(0, 10);
}

// Enumerate civil days [from, to] inclusive as UTC-midnight Dates.
function eachDay(fromDate, toDate) {
  const start = utcDay(fromDate);
  const end = utcDay(toDate);
  const out = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) out.push(d);
  return out;
}

// "HH:MM" LOCAL clock on a civil day (key 'YYYY-MM-DD') → the true UTC instant,
// resolved in the employee timezone (C2). Used by derive for LATE_IN / EARLY_OUT
// comparison against punchAt (which is a true UTC instant). A night shift whose
// endTime <= startTime rolls the end onto the next civil day before resolving.
function clockInstant(dayKeyStr, hhmm, tz) {
  if (!hhmm) return null;
  return zonedWallTimeToUtc(dayKeyStr, hhmm, tz) || null;
}

/**
 * isCrossMidnightShift(schedule) — the ONE canonical cross-midnight test, used by
 * BOTH the punch-filter window (shiftInstantWindow) AND the scheduledEnd civil-day
 * roll (endKey in recompute). Keeping a single predicate is the whole fix: when the
 * two halves disagreed, a shift's worked span and its scheduledEnd landed on
 * different civil days, mis-pairing the IN/OUT and firing a bogus EARLY_OUT.
 *
 * Source of truth = the WALL CLOCK: a shift crosses midnight iff endTime is at/before
 * startTime (e.g. 22:00→06:00 ⇒ '06:00' <= '22:00'). This is necessary AND sufficient
 * — a real overnight span always has end-clock <= start-clock, and any shift whose
 * end-clock is strictly AFTER its start-clock finishes the SAME civil day (no >24h
 * shift exists). The boolean flags (crossesMidnight / isNightShift) only matter when
 * they AGREE with the clock; honouring a flag set on a same-day clock (end > start)
 * is exactly what produced the bug — the window leaked into the next day and/or
 * scheduledEnd rolled a day, yielding a false EARLY_OUT. So the clock decides; a flag
 * can confirm a genuine overnight (end <= start) but can never override a same-day
 * clock into a cross-midnight one.
 */
function isCrossMidnightShift(schedule) {
  if (!schedule || !schedule.startTime || !schedule.endTime) return false;
  // Clock is authoritative: end-of-shift at/before start-of-shift ⇒ crosses midnight.
  return schedule.endTime <= schedule.startTime;
}

/**
 * Compute the shift's working INSTANT window for one civil day D (in the employee
 * timezone), as a half-open [start, end) of UTC instants used to FILTER punches
 * before they reach derive (C1):
 *   - cross-midnight shift (isCrossMidnightShift ⇒ endTime <= startTime, e.g.
 *     22:00→06:00): the worked span runs from D's local startTime up to (but not
 *     including) D+1's local startTime, so the OUT after midnight — even one exactly
 *     at the nominal end time — pairs with D, while D+1's own window (starting at
 *     D+1's startTime) cannot re-pull it. This stops day D's post-midnight OUT being
 *     double-counted on D+1. The SAME predicate drives scheduledEnd's day-roll in
 *     recompute, so the window and scheduledEnd never disagree (no false EARLY_OUT).
 *   - day / flexi shift: the civil day [D 00:00 local, D+1 00:00 local).
 *   - no schedule (open attendance): the civil day [D 00:00 local, D+1 00:00 local).
 * Returns { gte, lt } as UTC Date instants (half-open [gte, lt)).
 */
function shiftInstantWindow(dayKeyStr, schedule, tz) {
  const nextKey = civilDateInTz(addDays(dayKeyToDate(dayKeyStr), 1), tz);
  const isNight = isCrossMidnightShift(schedule);
  if (isNight) {
    const gte = zonedWallTimeToUtc(dayKeyStr, schedule.startTime, tz);
    // Run up to the NEXT day's local startTime (exclusive). This captures a
    // post-midnight OUT (including one exactly at the nominal end time) for D, and
    // is exactly where D+1's own window begins — so there is no overlap / re-pull.
    const lt = zonedWallTimeToUtc(nextKey, schedule.startTime, tz);
    if (gte && lt && lt.getTime() > gte.getTime()) return { gte, lt };
    // Fallback (degenerate times): civil day window.
  }
  const gte = zonedWallTimeToUtc(dayKeyStr, '00:00', tz);
  const lt = zonedWallTimeToUtc(nextKey, '00:00', tz);
  return { gte, lt };
}

/**
 * Resolve the {fraction, affectsLOP, half} leave context for a civil day from the
 * employee's APPROVED/AVAILED LeaveTransaction APPLICATION rows covering the day.
 * Returns null when no leave covers the day.
 *
 * M5: AGGREGATE every covering txn (not just the first). Two half-day leaves on
 * the same day (e.g. FIRST_HALF + SECOND_HALF, or two back-to-back applications)
 * sum to a full day; affectsLOP is the OR across covering txns; the per-day
 * fraction is capped at 1. The collapsed `half` is set only when a single half is
 * involved (informational).
 */
function resolveLeaveForDay(day, leaveTxns) {
  const key = typeof day === 'string' ? day : dayKey(day);
  let fraction = 0;
  let affectsLOP = false;
  const halves = new Set();
  let covered = false;

  for (const lt of leaveTxns || []) {
    if (!lt.startDate || !lt.endDate) continue;
    const s = dayKey(lt.startDate);
    const e = dayKey(lt.endDate);
    if (key < s || key > e) continue;
    covered = true;

    // This txn's contribution to the day: a startHalf on its first day or an
    // endHalf on its last day makes that boundary a half-day; otherwise full.
    let f = 1;
    let half = null;
    if (key === s && lt.startHalf) { f = 0.5; half = lt.startHalf; }
    if (key === e && lt.endHalf) { f = 0.5; half = lt.endHalf; }
    // A single-day half application (start === end) with both halves stays 0.5.

    fraction += f;
    if (half) halves.add(half);
    if (lt.leaveType && lt.leaveType.affectsLOP) affectsLOP = true;
  }

  if (!covered) return null;
  // Two distinct halves (FIRST_HALF + SECOND_HALF) collapse to a full day.
  if (fraction > 1) fraction = 1;
  const half = halves.size === 1 ? [...halves][0] : null;
  return { fraction, affectsLOP, half };
}

/**
 * Resolve approved WFH / On-Duty presence for a civil day from
 * AttendanceRegularizationRequest rows (kind=WFH|ON_DUTY, status=APPROVED).
 */
function resolvePresenceForDay(day, regs) {
  const key = dayKey(day);
  const out = { wfh: false, onDuty: false };
  for (const r of regs || []) {
    if (r.status !== 'APPROVED') continue;
    if (dayKey(r.date) !== key) continue;
    if (r.kind === 'WFH') out.wfh = true;
    if (r.kind === 'ON_DUTY') out.onDuty = true;
  }
  return out;
}

/** Pick the most-specific active OvertimeRule for an employee (entity/location). */
function resolveOtRule(employee, rules) {
  const emp = employee || {};
  const matches = (rules || []).filter((r) => {
    if (r.entityId && r.entityId !== emp.entityId) return false;
    if (r.locationId && r.locationId !== emp.locationId) return false;
    return true;
  });
  if (!matches.length) return null;
  const rank = (r) => (r.entityId ? 2 : 0) + (r.locationId ? 1 : 0);
  matches.sort((a, b) => rank(b) - rank(a));
  return matches[0];
}

/**
 * evaluateDayGeofence(punches, location, tenantEnforce) — Cycle 0 geofence check.
 *
 * Runs the PURE Haversine check (geo.evaluatePunchGeofence) over a day's WORK
 * punches (IN/OUT — break punches don't gate presence) and collapses to:
 *   - outOfGeofence: true when ANY evaluated work punch fell outside the radius
 *   - maxDistanceM:  the farthest out-of-geofence distance (board detail)
 *   - enforce:       the resolved enforce mode (per-location overrides tenant)
 *   - markerUpdates: per-punch { id, outOfGeofence, geoDistanceM } to persist,
 *                    ONLY for punches whose stored marker actually changed (so a
 *                    re-run doesn't churn writes — idempotent).
 *
 * GRACEFUL: no location geofence, or no punch coords → every punch evaluates to
 * evaluated:false → outOfGeofence:false, no marker updates, nothing thrown.
 */
function evaluateDayGeofence(punches, location, tenantEnforce) {
  const out = { outOfGeofence: false, maxDistanceM: null, enforce: false, markerUpdates: [] };
  for (const p of punches || []) {
    // Only IN/OUT gate presence; BREAK punches are ignored for the geofence verdict.
    if (p.punchType !== 'IN' && p.punchType !== 'OUT') continue;
    const v = evaluatePunchGeofence(p, location, { tenantEnforce });
    if (!v.evaluated) continue;
    out.enforce = v.enforce;
    if (v.outOfGeofence) {
      out.outOfGeofence = true;
      if (out.maxDistanceM == null || v.distanceM > out.maxDistanceM) out.maxDistanceM = v.distanceM;
    }
    // Persist the marker only when it changed (idempotent re-run discipline).
    const newDist = v.distanceM == null ? null : v.distanceM;
    if (p.outOfGeofence !== v.outOfGeofence || p.geoDistanceM !== newDist) {
      out.markerUpdates.push({ id: p.id, outOfGeofence: v.outOfGeofence, geoDistanceM: newDist });
    }
  }
  return out;
}

/**
 * recompute(businessId, employeeId, fromDate, toDate, tx?)
 *
 * Re-derive + upsert the daily Attendance rollup for one employee across a civil
 * date range. Skips locked rows (never retro-mutates a frozen day). Returns a
 * summary { employeeId, days, written, skippedLocked }.
 */
async function recompute(businessId, employeeId, fromDate, toDate, tx) {
  const db = tx || prisma;
  if (!businessId || !employeeId) throw new Error('recompute requires businessId and employeeId');

  const from = utcDay(fromDate);
  const to = utcDay(toDate);
  if (to.getTime() < from.getTime()) return { employeeId, days: 0, written: 0, skippedLocked: 0 };

  const empRow = await db.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true },
  });
  if (!empRow) return { employeeId, days: 0, written: 0, skippedLocked: 0, notFound: true };

  // Employee entity/location live on the CURRENT EmploymentRecord (there is no
  // entityId/locationId column on Employee). Resolve them so holiday-scope
  // matching, OT-rule resolution, and TIMEZONE resolution can key off them.
  const employment = await db.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: {
      entityId: true, locationId: true,
      entity: { select: { timezone: true, countryCode: true } },
      // Geofence config travels with the assigned Location (geoLat/geoLng/geofenceM
      // + the per-location enforce lever). Pulled here so the per-day loop can flag
      // out-of-geofence punches without a per-day round-trip.
      location: {
        select: {
          timezone: true, countryCode: true,
          geoLat: true, geoLng: true, geofenceM: true, geofenceEnforce: true,
        },
      },
    },
  });
  const [empMeta, business] = await Promise.all([
    db.employee.findFirst({ where: { id: employeeId, businessId }, select: { countryCode: true } }),
    db.business.findFirst({ where: { id: businessId }, select: { timezone: true, featureFlags: true } }),
  ]);
  // Geofence: the assigned-location geofence config + the tenant-wide enforce
  // default (per-location enforce overrides). When the location has no geofence
  // this resolves to a no-op (evaluatePunchGeofence returns evaluated:false).
  const geofenceLocation = employment ? employment.location : null;
  const tenantEnforce = tenantGeofenceEnforce(business);
  const employee = {
    id: employeeId,
    entityId: employment ? employment.entityId : null,
    locationId: employment ? employment.locationId : null,
    countryCode: empMeta ? empMeta.countryCode : null,
  };
  // C2/H5 — the employee's IANA zone: location → entity → business → countryCode.
  const tz = resolveTimezone(employee, {
    location: employment ? employment.location : null,
    entity: employment ? employment.entity : null,
    business: business || null,
  });

  // F14 — pin the holiday read to the TENANT country (fail-closed). The holiday
  // calendar feeds isHoliday → derive → attendance status / overtimeMinutes /
  // lopFraction and persists holidayId; an off-country row (bad backfill / legacy
  // / import-guard regression) must NOT mark an India working day as a holiday.
  // Mirror leaveContext.js:106. tenantCountry throws fail-closed on a missing /
  // ambiguous tenant rather than widening the read.
  const holidayCountry = await tenantCountry(businessId);

  // Window-load once for the whole range (cheaper than per-day round-trips), with a
  // small pad so a cross-midnight night shift on the final day still pairs.
  const winStart = from;
  const winEnd = addDays(to, 2);

  // M4 — never let entityId become `undefined` (Prisma drops an undefined filter,
  // which would match EVERY entity's default pattern). Build the OR conditionally.
  const defaultPatternWhere = employee.entityId
    ? { OR: [{ entityId: employee.entityId }, { entityId: null }] }
    : { entityId: null };

  const [assignments, defaultPatterns, leaveTxns, regs, holidays, otRules, lockedRows, rosterRows] = await Promise.all([
    db.shiftAssignment.findMany({
      where: { businessId, employeeId, effectiveFrom: { lt: winEnd } },
      include: { shiftPattern: true },
      orderBy: { effectiveFrom: 'desc' },
    }),
    // Entity/location default pattern fallback (active, scoped to the employee's entity or global).
    db.shiftPattern.findMany({
      where: {
        businessId, deletedAt: null, isActive: true,
        ...defaultPatternWhere,
      },
      orderBy: { createdAt: 'asc' },
    }),
    db.leaveTransaction.findMany({
      where: {
        businessId, employeeId, txnType: 'APPLICATION',
        status: { in: ['APPROVED', 'AVAILED'] },
        startDate: { lte: winEnd }, endDate: { gte: winStart },
      },
      include: { leaveType: { select: { affectsLOP: true, isPaid: true } } },
    }),
    db.attendanceRegularizationRequest.findMany({
      where: {
        businessId, employeeId, status: 'APPROVED',
        kind: { in: ['WFH', 'ON_DUTY'] },
        date: { gte: winStart, lt: winEnd },
      },
    }),
    db.holiday.findMany({
      where: { businessId, countryCode: holidayCountry, date: { gte: winStart, lt: winEnd } },
    }),
    db.overtimeRule.findMany({ where: { businessId, isActive: true } }),
    db.attendance.findMany({
      where: { businessId, employeeId, date: { gte: from, lte: to }, isLocked: true },
      select: { date: true },
    }),
    // Feature 29 — the per-day roster cells for this window. ONLY PUBLISHED rows
    // reach derive (a DRAFT plan never affects attendance/pay — invariant I4); a day
    // with no PUBLISHED cell resolves to undefined below and falls back to the
    // ShiftAssignment/default exactly as today (byte-identical for a no-roster tenant).
    db.rosterDay.findMany({
      where: { businessId, employeeId, status: 'PUBLISHED', date: { gte: from, lte: to } },
      include: { shiftPattern: true },
    }),
  ]);

  const lockedKeys = new Set(lockedRows.map((r) => dayKey(r.date)));
  // Index the PUBLISHED roster cells by civil-day key so the per-day loop hands the
  // matching cell (or undefined) to resolveSchedule. A WORK cell drives the day's
  // shift; an OFF cell surfaces as weeklyOff (the existing WEEKLY_OFF path).
  const rosterByDay = new Map((rosterRows || []).map((r) => [dayKey(r.date), r]));
  // The entity/location default = first matching active pattern (prefer entity-specific).
  const defaultPattern = defaultPatterns.sort((a, b) => {
    const rank = (p) => (p.entityId === employee.entityId ? 1 : 0);
    return rank(b) - rank(a);
  })[0] || null;
  const otRule = resolveOtRule(employee, otRules);

  let written = 0;
  let skippedLocked = 0;
  const days = eachDay(from, to);

  for (const day of days) {
    const key = dayKey(day);
    if (lockedKeys.has(key)) { skippedLocked += 1; continue; }

    // Feature 29 — a PUBLISHED roster cell for THIS day wins (precedence over the
    // covering ShiftAssignment). resolveSchedule returns the { __off:true } sentinel
    // for an OFF cell; we collapse it to schedule=null + rosterOff=true so the day
    // flows through the EXISTING isWeeklyOff → WEEKLY_OFF path. When no roster cell
    // exists, rosterDay is undefined and resolveSchedule is byte-identical to v1.
    const rosterDay = rosterByDay.get(key);
    const resolved = resolveSchedule(day, assignments, defaultPattern, rosterDay);
    const rosterOff = !!(resolved && resolved.__off);
    const schedule = rosterOff ? null : resolved;
    // C1 — the shift's working INSTANT window for THIS day, in the employee tz.
    // A night shift's window runs up to the NEXT day's local startTime so its
    // post-midnight OUT pairs with THIS day and is excluded from D+1's window.
    const win = shiftInstantWindow(key, schedule, tz);
    const punches = await db.attendancePunch.findMany({
      where: {
        businessId, employeeId,
        punchAt: { gte: win.gte, lt: win.lt },
        // Pending manual (regularization) punches don't count until approved
        // materialises real source=MANUAL rows; here we include all stored punches
        // except those still flagged isManual + pending (regularizationRequestId set
        // but not yet materialised). Approved regularization writes isManual=false.
        OR: [{ isManual: false }, { isManual: true, regularizationRequestId: null }],
      },
      orderBy: { punchAt: 'asc' },
      // id + geo coords are needed for the geofence evaluation (and to persist the
      // per-punch out-of-geofence marker). outOfGeofence is read to skip a redundant
      // re-write when the stored marker already matches.
      select: {
        id: true, punchType: true, punchAt: true,
        geoLat: true, geoLng: true, outOfGeofence: true, geoDistanceM: true,
      },
    });

    // Geofence (Cycle 0). For each punch carrying coords, Haversine-compare against
    // the assigned Location's geofence; if ANY work punch (IN/OUT) lands outside the
    // radius, set ctx.flags.outOfGeofence so derive.js surfaces the OUT_OF_GEOFENCE
    // exception. Persist the per-punch marker (idempotent — only when it changed).
    // Graceful: no location geofence or no punch coords → evaluated:false → no flag.
    const geo = evaluateDayGeofence(punches, geofenceLocation, tenantEnforce);
    if (geo.markerUpdates.length) {
      for (const u of geo.markerUpdates) {
        await db.attendancePunch.update({
          where: { id: u.id },
          data: { outOfGeofence: u.outOfGeofence, geoDistanceM: u.geoDistanceM },
        });
      }
    }

    const holiday = isHoliday(employee, day, holidays, null);
    // A roster OFF cell is a weekly-off for THIS day (rotating weekly-off, F29);
    // otherwise fall back to the pattern's weekly-off CSV exactly as before.
    const weeklyOff = rosterOff || (schedule ? isWeeklyOff(day, schedule.weeklyOffDays) : false);
    const leave = resolveLeaveForDay(key, leaveTxns);
    const presence = resolvePresenceForDay(day, regs);

    // C2 — scheduledStart/End are the LOCAL shift wall-clock resolved to UTC
    // instants in the employee tz. The night-shift end rolls to the next civil day.
    // Use the SAME isCrossMidnightShift predicate that shiftInstantWindow uses, so
    // the punch-filter window and scheduledEnd agree: an overnight shift's OUT lands
    // inside D's window AND scheduledEnd sits on D+1, so no false EARLY_OUT fires.
    const nextKey = civilDateInTz(addDays(dayKeyToDate(key), 1), tz);
    const endKey = isCrossMidnightShift(schedule) ? nextKey : key;
    const ctx = {
      date: key,
      schedule,
      scheduledStart: schedule ? clockInstant(key, schedule.startTime, tz) : null,
      scheduledEnd: schedule ? clockInstant(endKey, schedule.endTime, tz) : null,
      punches,
      leave,
      presence,
      holiday: !!holiday,
      weeklyOff,
      otRule,
      // Geofence flag → derive.js Step C surfaces OUT_OF_GEOFENCE when set. WARN vs
      // ENFORCE does NOT change whether we flag (we always flag); enforce is carried
      // for a future hard-block path and recorded on the day for the board.
      flags: geo.outOfGeofence ? { outOfGeofence: true } : {},
    };

    const d = derive(ctx);

    // Open-attendance day with no punches and no schedule → derive returns
    // status=null; we skip writing a row for it (nothing to record).
    if (d.status == null) continue;

    const data = {
      shiftPatternId: schedule ? schedule.id || null : null,
      firstIn: d.firstIn ? new Date(d.firstIn) : null,
      lastOut: d.lastOut ? new Date(d.lastOut) : null,
      workedMinutes: d.workedMinutes || 0,
      breakMinutes: d.breakMinutes || 0,
      overtimeMinutes: d.overtimeMinutes || 0,
      status: d.status,
      lopFraction: d.lopFraction || 0,
      exceptionsJson: {
        ...(d.exceptions && d.exceptions.length ? { flags: d.exceptions } : {}),
        otEquivalentHours: d.otEquivalentHours,
        holidayId: holiday ? holiday.id : null,
        // Geofence detail for the team/attendance board (read-only). Only present
        // when the day had an out-of-geofence punch: max distance + enforce mode.
        ...(geo.outOfGeofence
          ? { geofence: { outOfGeofence: true, distanceM: geo.maxDistanceM, enforce: geo.enforce } }
          : {}),
      },
    };

    // L3 — TOCTOU-safe write. A plain upsert(update) would overwrite a row that
    // got locked AFTER the pre-scan (freeze races recompute). Instead update only
    // when isLocked=false; if no row matched, either it doesn't exist (create) or
    // it was locked mid-flight (leave it — monotonic freeze).
    const dateAt = utcDay(day);
    const upd = await db.attendance.updateMany({
      where: { businessId, employeeId, date: dateAt, isLocked: false },
      data,
    });
    if (upd.count === 0) {
      try {
        await db.attendance.create({ data: { businessId, employeeId, date: dateAt, ...data } });
      } catch (e) {
        // P2002: a row appeared between updateMany and create (it must be locked,
        // since an unlocked row would have been updated) — skip, don't clobber.
        if (e.code !== 'P2002') throw e;
        skippedLocked += 1;
        continue;
      }
    }
    written += 1;
  }

  return { employeeId, days: days.length, written, skippedLocked };
}

module.exports = {
  recompute,
  // exposed for tests / freeze rollup reuse
  _internals: {
    resolveLeaveForDay, resolvePresenceForDay, resolveOtRule, eachDay, utcDay, dayKey,
    shiftInstantWindow, isCrossMidnightShift, clockInstant, dayKeyToDate,
    evaluateDayGeofence, tenantGeofenceEnforce,
  },
};

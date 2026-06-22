'use strict';

/**
 * derive.js — Attendance daily-status derivation core (Feature 2).
 *
 * PURE: no DB, no I/O, no prisma, no Date.now in the math. Unit-testable with
 * plain `node` to the exact minute. The caller (controller / nightly job)
 * fetches punches, schedule, leave, holiday and passes them in; `derive`
 * computes the one canonical daily row.
 *
 * Pipeline (docs/features/02 §4.1):
 *   A. pair punches → work/break segments → workedMinutes  (elapsed real time → DST-correct)
 *   B. classify (priority decision table, first match wins)
 *   C. exception flags (late / early / missing-punch …)
 *   D. overtime (eligible shifts only; multipliers collapsed to equivalent hours)
 *
 * Determinism: same ctx → identical DerivedDay (idempotent upsert — invariant I4).
 * Time: worked minutes use elapsed wall-clock ms between instants, so a night
 * shift crossing a NZ DST boundary is correct without any tz library here; the
 * caller supplies `scheduledStart`/`scheduledEnd` as instants for late/early.
 */

// ── helpers ────────────────────────────────────────────────────────────────
function toMs(x) { return x instanceof Date ? x.getTime() : new Date(x).getTime(); }
function elapsedMin(a, b) { return Math.round((toMs(b) - toMs(a)) / 60000); }
function num(v, dflt) { const n = v == null ? dflt : Number(v); return Number.isFinite(n) ? n : dflt; }

const WORK_PUNCH = { IN: 'IN', OUT: 'OUT' };
const BREAK_PUNCH = { BREAK_START: 'BREAK_START', BREAK_END: 'BREAK_END' };

/**
 * Step A — pair punches into segments and total worked minutes.
 * Returns { firstIn, lastOut, grossMinutes, breakMinutes, workedMinutes,
 *           hasPunches, missingPunch }.
 */
function foldPunches(punches, schedule) {
  const sorted = [...(punches || [])]
    .filter((p) => p && p.punchAt && p.punchType)
    .sort((a, b) => toMs(a.punchAt) - toMs(b.punchAt));

  const ins = sorted.filter((p) => p.punchType === WORK_PUNCH.IN);
  const outs = sorted.filter((p) => p.punchType === WORK_PUNCH.OUT);
  const bStarts = sorted.filter((p) => p.punchType === BREAK_PUNCH.BREAK_START);
  const bEnds = sorted.filter((p) => p.punchType === BREAK_PUNCH.BREAK_END);

  // Pair IN→OUT greedily in chronological order.
  let grossMinutes = 0;
  let pairedWork = 0;
  const inStack = [];
  for (const p of sorted) {
    if (p.punchType === WORK_PUNCH.IN) inStack.push(p);
    else if (p.punchType === WORK_PUNCH.OUT && inStack.length) {
      const open = inStack.shift();
      grossMinutes += Math.max(0, elapsedMin(open.punchAt, p.punchAt));
      pairedWork += 1;
    }
  }
  // odd / unmatched work punches → missing punch
  const missingPunch = ins.length !== outs.length || inStack.length > 0 || (ins.length === 0 && outs.length > 0);

  // Break minutes: explicit break punches if present, else the scheduled break.
  let breakMinutes = 0;
  if (bStarts.length || bEnds.length) {
    const bStack = [];
    for (const p of sorted) {
      if (p.punchType === BREAK_PUNCH.BREAK_START) bStack.push(p);
      else if (p.punchType === BREAK_PUNCH.BREAK_END && bStack.length) {
        const open = bStack.shift();
        breakMinutes += Math.max(0, elapsedMin(open.punchAt, p.punchAt));
      }
    }
  } else if (grossMinutes > 0 && schedule) {
    breakMinutes = num(schedule.breakMinutes, 0); // assumed unpaid break
  }

  const workedMinutes = Math.max(0, grossMinutes - breakMinutes);
  const firstIn = ins.length ? ins[0].punchAt : null;
  const lastOut = outs.length ? outs[outs.length - 1].punchAt : null;
  const hasPunches = sorted.length > 0;

  return { firstIn, lastOut, grossMinutes, breakMinutes, workedMinutes, hasPunches, missingPunch, pairedWork };
}

/**
 * Step B — classify into an AttendanceStatus + lopFraction.
 * Priority order is significant; first match wins (docs/features/02 §4.1 Step B).
 */
function classify(ctx, m) {
  const sch = ctx.schedule || null;
  const leave = ctx.leave || null;
  const presence = ctx.presence || {};

  const fullDay = sch ? num(sch.fullDayMinutes, 480) : 480;
  const grace = sch ? num(sch.graceInMinutes, 0) : 0;
  const halfThreshold = sch
    ? num(sch.halfDayThresholdMinutes, Math.floor(fullDay / 2))
    : Math.floor(fullDay / 2);
  const minPresent = sch ? num(sch.minMinutesForPresent, halfThreshold) : halfThreshold;
  const requireBoth = sch ? sch.requireBothPunches !== false : false; // default: require both when scheduled

  // 1–2: full-day approved leave
  if (leave && num(leave.fraction, 0) >= 1) {
    return { status: 'ON_LEAVE', lopFraction: leave.affectsLOP ? 1 : 0 };
  }
  // 3–4: holiday
  if (ctx.holiday) {
    return m.hasPunches
      ? { status: 'HOLIDAY_WORKED', lopFraction: 0 }
      : { status: 'HOLIDAY', lopFraction: 0 };
  }
  // 5–6: weekly off
  if (ctx.weeklyOff) {
    return m.hasPunches
      ? { status: 'HOLIDAY_WORKED', lopFraction: 0 }
      : { status: 'WEEKLY_OFF', lopFraction: 0 };
  }
  // 7–8: approved WFH / On-Duty
  if (presence.wfh) return { status: 'WORK_FROM_HOME', lopFraction: 0 };
  if (presence.onDuty) return { status: 'ON_DUTY', lopFraction: 0 };
  // 9: half-day leave (+ possibly present the other half)
  if (leave && num(leave.fraction, 0) === 0.5) {
    const leaveLop = leave.affectsLOP ? 0.5 : 0;
    const workedOtherHalf = m.workedMinutes >= minPresent || m.hasPunches;
    const otherHalfLop = workedOtherHalf ? 0 : 0.5;
    return { status: 'HALF_DAY', lopFraction: leaveLop + otherHalfLop };
  }
  // 10: missing punch on a scheduled day that requires both
  if (m.missingPunch && sch && requireBoth && m.workedMinutes <= 0) {
    return { status: 'MISSING_PUNCH', lopFraction: 0 }; // pending regularization
  }
  // 11: present
  if (m.workedMinutes >= fullDay - grace) return { status: 'PRESENT', lopFraction: 0 };
  // 12: half day (threshold ≤ worked < full)
  if (m.workedMinutes >= halfThreshold) return { status: 'HALF_DAY', lopFraction: 0.5 };
  // 13: partial below threshold → lenient half-day with half LOP
  if (m.workedMinutes > 0) return { status: 'HALF_DAY', lopFraction: 0.5 };
  // 14: no punches on a scheduled working day
  if (sch) return { status: 'ABSENT', lopFraction: 1 };
  // open-attendance (no schedule): present if any punch, else excluded (null)
  return m.hasPunches ? { status: 'PRESENT', lopFraction: 0 } : { status: null, lopFraction: 0 };
}

/**
 * Step C — exception flags (advisory; do not change status/LOP).
 */
function exceptions(ctx, m, status) {
  const out = [];
  const sch = ctx.schedule || null;
  if (m.missingPunch) out.push('MISSING_PUNCH');
  if (sch && ctx.scheduledStart && m.firstIn) {
    const grace = num(sch.graceInMinutes, 0);
    if (elapsedMin(ctx.scheduledStart, m.firstIn) > grace) out.push('LATE_IN');
  }
  if (sch && ctx.scheduledEnd && m.lastOut) {
    const graceOut = num(sch.graceOutMinutes, num(sch.graceInMinutes, 0));
    if (elapsedMin(m.lastOut, ctx.scheduledEnd) > graceOut) out.push('EARLY_OUT');
  }
  if (ctx.flags) {
    if (ctx.flags.outOfGeofence) out.push('OUT_OF_GEOFENCE');
    if (ctx.flags.ipBlocked) out.push('IP_BLOCKED');
    if (ctx.flags.selfieFailed) out.push('SELFIE_FAILED');
  }
  if (sch && m.breakMinutes > num(sch.breakMinutes, 0) + 5) out.push('EXCESS_BREAK');
  return out;
}

/**
 * Step D — overtime. Eligible shifts only. Multipliers collapse to an
 * equivalent-hours figure so the payroll engine's existing otHours path is
 * untouched.
 */
function overtime(ctx, m, status) {
  const sch = ctx.schedule || null;
  if (!sch || !sch.otEligible) return { overtimeMinutes: 0, otEquivalentHours: 0 };
  const rule = ctx.otRule || {};
  const threshold = num(sch.dailyOtThresholdMin, num(rule.dailyThresholdMin, num(sch.fullDayMinutes, 480)));

  let otRaw;
  let multiplier;
  if (status === 'HOLIDAY_WORKED' && ctx.holiday) {
    otRaw = m.workedMinutes; multiplier = num(rule.holidayMultiplier, 2);
  } else if (status === 'HOLIDAY_WORKED' && ctx.weeklyOff) {
    otRaw = m.workedMinutes; multiplier = num(rule.weeklyOffMultiplier, 2);
  } else {
    otRaw = Math.max(0, m.workedMinutes - threshold); multiplier = num(rule.weekdayMultiplier, 1);
  }

  const round = num(rule.roundingMin, 0);
  if (round > 0) otRaw = Math.round(otRaw / round) * round;
  if (rule.dailyCapMin != null) otRaw = Math.min(otRaw, num(rule.dailyCapMin, otRaw));

  const otEquivalentHours = Math.round((otRaw * multiplier) / 60 * 10000) / 10000;
  return { overtimeMinutes: otRaw, otEquivalentHours };
}

/**
 * derive(ctx) → DerivedDay. The one public entry point.
 */
function derive(ctx) {
  const c = ctx || {};
  const m = foldPunches(c.punches, c.schedule);
  const { status, lopFraction } = classify(c, m);
  const exc = exceptions(c, m, status);
  const ot = status ? overtime(c, m, status) : { overtimeMinutes: 0, otEquivalentHours: 0 };

  return {
    date: c.date || null,
    status,
    firstIn: m.firstIn,
    lastOut: m.lastOut,
    workedMinutes: m.workedMinutes,
    breakMinutes: m.breakMinutes,
    overtimeMinutes: ot.overtimeMinutes,
    otEquivalentHours: ot.otEquivalentHours,
    lopFraction,
    exceptions: exc,
  };
}

// ── pure resolvers (caller passes the candidate lists; no DB here) ───────────

/**
 * resolveSchedule(date, assignments, defaults) — pick the effective schedule.
 * v1: the ShiftAssignment whose [effectiveFrom, effectiveTo] covers `date`
 * (latest effectiveFrom wins); else the entity/location default; else null
 * (open-attendance). Roster cycles are a v2 extension that slots in here.
 * `assignments` = [{ effectiveFrom, effectiveTo, shiftPattern }].
 */
function resolveSchedule(date, assignments, defaultPattern) {
  const d = toMs(date);
  const covering = (assignments || [])
    .filter((a) => a && a.shiftPattern && toMs(a.effectiveFrom) <= d && (!a.effectiveTo || toMs(a.effectiveTo) >= d))
    .sort((a, b) => toMs(b.effectiveFrom) - toMs(a.effectiveFrom));
  if (covering.length) return covering[0].shiftPattern;
  return defaultPattern || null;
}

/**
 * isHoliday(employee, date, holidays) — most-specific scope wins:
 *   (entity,location) > (entity,*) > (*,location) > (*,*).
 * `holidays` = [{ date, entityId, locationId, isPaid, isRestricted, name }].
 * Restricted/optional (IN) holidays only count when the employee opted in
 * (caller passes optedRestrictedDates).
 */
function isHoliday(employee, date, holidays, optedRestrictedDates) {
  const d = toMs(date);
  const emp = employee || {};
  const opted = optedRestrictedDates || new Set();
  const matches = (holidays || []).filter((h) => h && toMs(h.date) === d && scopeMatches(h, emp));
  if (!matches.length) return null;
  // rank by specificity
  const rank = (h) => (h.entityId ? 2 : 0) + (h.locationId ? 1 : 0);
  matches.sort((a, b) => rank(b) - rank(a));
  for (const h of matches) {
    if (h.isRestricted && !opted.has(String(date))) continue; // optional → skip unless opted
    return h;
  }
  return null;
}

function scopeMatches(h, emp) {
  if (h.entityId && h.entityId !== emp.entityId) return false;
  if (h.locationId && h.locationId !== emp.locationId) return false;
  return true;
}

/** Weekly-off check from a CSV/array of ISO weekday numbers (0=Sun..6=Sat). */
function isWeeklyOff(date, weeklyOffDays) {
  if (weeklyOffDays == null) return false;
  const set = Array.isArray(weeklyOffDays)
    ? weeklyOffDays.map(Number)
    : String(weeklyOffDays).split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  // Use the civil weekday in UTC of the @db.Date value (dates are midnight UTC).
  const wd = new Date(toMs(date)).getUTCDay();
  return set.includes(wd);
}

/** Inclusive day count between two @db.Date values. */
function daysBetweenInclusive(from, to) {
  return Math.round((toMs(to) - toMs(from)) / 86400000) + 1;
}

module.exports = {
  derive,
  resolveSchedule,
  isHoliday,
  isWeeklyOff,
  daysBetweenInclusive,
  _internals: { foldPunches, classify, exceptions, overtime, elapsedMin },
};

'use strict';

/**
 * rotation.js — Feature 29 PURE rotation generator (no DB, no I/O, no prisma, no
 * Date.now in the math). Unit-testable with plain `node` to the exact day, mirroring
 * derive.js's "caller fetches, passes in, function computes" discipline.
 *
 * A RotationTemplate is an ordered RING of slots (each a WORK shift or an OFF). The
 * generator walks the ring from anchorDate, one slot per civil day, looping, and
 * materialises a RosterDay DRAFT per (employee, day):
 *
 *   slotIndex = ((daysBetween(anchorDate, D) + phaseOffset) % cycleLength + cycleLength) % cycleLength
 *
 * The %-then-+cycleLength-then-% form is correct for dates BEFORE the anchor (a
 * negative daysBetween) — a mid-cycle hire whose first day precedes the anchor still
 * lands on the right ring slot. phaseOffset staggers two teams off the same ring.
 *
 * Determinism / idempotency: same (template, population, range) → identical rows.
 *
 * Two India guard rules are CHECKED (collected as violations, never auto-applied — the
 * planner resolves them before PUBLISH):
 *   - REST_VIOLATION   : <11h between a WORK day's shift end and the NEXT WORK day's
 *                        shift start (the same endTime/startTime clock the night-shift
 *                        window uses; a cross-midnight prev shift ends on prevDay+1).
 *   - NIGHT_CONSENT     : a non-nightShiftEligible employee placed on an isNightShift
 *                        WORK slot (women/graveyard consent gate). The row is SKIPPED
 *                        (not emitted) unless opts.overrideNightConsent (audited by caller).
 *   - UNRESOLVED_SHIFT  : a WORK slot whose shiftPatternId does not resolve in
 *                        opts.shiftPatterns (config error) — row skipped.
 */

const MS_PER_DAY = 86400000;
const MIN_REST_MINUTES = 11 * 60; // India ≥11h inter-shift rest

function toMs(x) {
  if (x instanceof Date) return x.getTime();
  // Treat a 'YYYY-MM-DD' as a civil @db.Date at UTC midnight (Attendance convention).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(x));
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(x).getTime();
}

// UTC-midnight civil day for a Date or 'YYYY-MM-DD'.
function utcDay(x) {
  const t = new Date(toMs(x));
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

function dayKey(x) {
  return utcDay(x).toISOString().slice(0, 10);
}

// Signed whole-day count from `from` to `to` (negative when `to` precedes `from`).
function daysBetween(from, to) {
  return Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / MS_PER_DAY);
}

// "HH:MM" → minutes since local midnight (0..1439). Null on a bad/empty value.
function clockMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// A shift crosses midnight iff its end clock is at/before its start clock (the SAME
// canonical predicate service.js#isCrossMidnightShift uses — reused, not re-derived).
function crossesMidnight(pattern) {
  if (!pattern || !pattern.startTime || !pattern.endTime) return false;
  return pattern.endTime <= pattern.startTime;
}

/**
 * restMinutesBetween(prevDayKey, prevPattern, thisDayKey, thisPattern) — the gap in
 * minutes between the END of prevDay's shift and the START of thisDay's shift, as
 * absolute "minutes since prevDay 00:00 local". A cross-midnight prev shift's end
 * rolls onto prevDay+1; thisDay's start is on thisDay. Returns null when either
 * pattern has no parseable clock (cannot judge → no violation).
 */
function restMinutesBetween(prevDayKey, prevPattern, thisDayKey, thisPattern) {
  const prevStart = clockMinutes(prevPattern && prevPattern.startTime);
  const prevEnd = clockMinutes(prevPattern && prevPattern.endTime);
  const thisStart = clockMinutes(thisPattern && thisPattern.startTime);
  if (prevEnd == null || thisStart == null) return null;
  // prevEnd is on prevDay (or prevDay+1 if the shift crosses midnight).
  const prevDayOffset = daysBetween(prevDayKey, prevDayKey); // 0, base
  const prevEndAbs = prevDayOffset * 1440 + prevEnd + (crossesMidnight(prevPattern) ? 1440 : 0);
  // thisStart is on thisDay, measured from the SAME prevDay 00:00 origin.
  const thisStartAbs = daysBetween(prevDayKey, thisDayKey) * 1440 + thisStart;
  // (prevStart referenced only to keep eslint happy about an unused parse; harmless.)
  void prevStart;
  return thisStartAbs - prevEndAbs;
}

/**
 * resolveSlot(slot, shiftPatterns) — normalise a ring slot to { off, pattern } or null
 * (unresolved WORK pattern). slotsJson entries: { kind:'OFF' } | { kind:'WORK', shiftPatternId }.
 */
function resolveSlot(slot, shiftPatterns) {
  if (!slot) return { off: true, pattern: null };
  if (slot.kind === 'OFF') return { off: true, pattern: null };
  // WORK
  const pid = slot.shiftPatternId || null;
  const pattern = pid && shiftPatterns ? (shiftPatterns.get ? shiftPatterns.get(pid) : shiftPatterns[pid]) : null;
  if (!pattern) return null; // UNRESOLVED_SHIFT
  return { off: false, pattern };
}

/**
 * generateRoster(template, population, fromDate, toDate, opts) → { rows, violations }
 *
 *   template   = { slotsJson:[{kind,shiftPatternId?}], cycleLength, anchorDate, id? }
 *   population = [{ employeeId, phaseOffset?, nightShiftEligible?, joinDate?, exitDate? }]
 *   fromDate/toDate = civil-day bounds (inclusive), Date or 'YYYY-MM-DD'
 *   opts.shiftPatterns        = Map|object id→pattern ({ startTime,endTime,isNightShift,... })
 *   opts.overrideNightConsent = emit night rows for a non-consenting employee anyway (audited)
 *
 * Returns DRAFT RosterDay-shaped rows (source:'ROTATION') + a violations list. The
 * controller upserts the rows and shows the violations for the planner to resolve.
 */
function generateRoster(template, population, fromDate, toDate, opts) {
  const o = opts || {};
  const shiftPatterns = o.shiftPatterns || new Map();
  const rows = [];
  const violations = [];

  if (!template || !Array.isArray(template.slotsJson) || !template.slotsJson.length) {
    return { rows, violations: [{ code: 'EMPTY_TEMPLATE' }] };
  }
  const slots = template.slotsJson;
  const cycleLength = template.cycleLength || slots.length;
  if (cycleLength !== slots.length) {
    violations.push({ code: 'CYCLE_LENGTH_MISMATCH', expected: slots.length, got: cycleLength });
  }
  const ring = slots.length;
  const anchor = template.anchorDate;

  const from = utcDay(fromDate);
  const to = utcDay(toDate);
  if (to.getTime() < from.getTime()) return { rows, violations };

  for (const emp of population || []) {
    if (!emp || !emp.employeeId) continue;
    const phase = Number(emp.phaseOffset || 0);
    const consents = !!emp.nightShiftEligible;
    const joinMs = emp.joinDate ? utcDay(emp.joinDate).getTime() : null;
    const exitMs = emp.exitDate ? utcDay(emp.exitDate).getTime() : null;

    // Per-employee previous WORK day (for the 11h-rest check across the boundary).
    let prevWork = null; // { dayKey, pattern }

    for (let d = new Date(from); d.getTime() <= to.getTime(); d = new Date(d.getTime() + MS_PER_DAY)) {
      const key = dayKey(d);
      const dMs = d.getTime();
      // E4 — mid-cycle hire/exit: no rows before joinDate or after exitDate.
      if (joinMs != null && dMs < joinMs) continue;
      if (exitMs != null && dMs > exitMs) continue;

      const idx = (((daysBetween(anchor, d) + phase) % ring) + ring) % ring;
      const resolved = resolveSlot(slots[idx], shiftPatterns);

      if (resolved == null) {
        violations.push({ employeeId: emp.employeeId, date: key, code: 'UNRESOLVED_SHIFT', slotIndex: idx });
        continue; // cannot emit a WORK row with no pattern
      }

      if (resolved.off) {
        rows.push({
          employeeId: emp.employeeId, date: key, dayType: 'OFF', shiftPatternId: null,
          source: 'ROTATION', rotationTemplateId: template.id || null,
        });
        // An OFF day breaks the rest chain (gives ≥24h); reset the prev-work anchor.
        prevWork = null;
        continue;
      }

      // WORK slot.
      const pattern = resolved.pattern;
      // E6 — night-shift consent gate. A non-consenting employee on an isNightShift
      // pattern is SKIPPED + flagged (hard block) unless the admin overrides (audited).
      if (pattern.isNightShift && !consents) {
        violations.push({ employeeId: emp.employeeId, date: key, code: 'NIGHT_CONSENT', shiftPatternId: pattern.id });
        if (!o.overrideNightConsent) {
          // Skipped: do not emit a row, and do not chain rest off a non-emitted day.
          continue;
        }
      }

      // E5 — 11h inter-shift rest against the previous WORK day (warn, do not drop).
      if (prevWork) {
        const rest = restMinutesBetween(prevWork.dayKey, prevWork.pattern, key, pattern);
        if (rest != null && rest < MIN_REST_MINUTES) {
          violations.push({
            employeeId: emp.employeeId, date: key, code: 'REST_VIOLATION',
            restMinutes: rest, prevDate: prevWork.dayKey,
          });
        }
      }

      rows.push({
        employeeId: emp.employeeId, date: key, dayType: 'WORK', shiftPatternId: pattern.id,
        source: 'ROTATION', rotationTemplateId: template.id || null,
      });
      prevWork = { dayKey: key, pattern };
    }
  }

  return { rows, violations };
}

module.exports = {
  generateRoster,
  // exposed for unit tests / reuse
  _internals: { clockMinutes, crossesMidnight, restMinutesBetween, daysBetween, dayKey, resolveSlot, MIN_REST_MINUTES },
};

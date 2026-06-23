'use strict';

/**
 * proration.js — Feature 8 §5.5 / QA9: pure tenure proration for mid-cycle
 * joiners/transfers. The factor scales an instance's compositeScore so a person
 * who was only in the role for part of the cycle is rated on that fraction.
 *
 *   proRationFactor = clamp(daysInRole / cyclePeriodDays, 0, 1), to 4 dp.
 *
 * daysInRole = overlap of [max(hireDate, periodStart), periodEnd] with the cycle.
 * A full-cycle tenant → 1.0000. Hired after periodEnd → 0 (caller defers/cancels).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toUTCDate(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Inclusive whole-day count between two date-only values (b−a)+1, min 0.
function inclusiveDays(a, b) {
  const ad = toUTCDate(a);
  const bd = toUTCDate(b);
  if (!ad || !bd) return 0;
  const diff = Math.round((bd.getTime() - ad.getTime()) / MS_PER_DAY) + 1;
  return diff > 0 ? diff : 0;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * @param {Object} p
 * @param {Date|string}  p.periodStart  cycle start (date)
 * @param {Date|string}  p.periodEnd    cycle end (date)
 * @param {Date|string=} p.hireDate     subject's role-start (hire or transfer-in)
 * @returns {{ factor:number, daysInRole:number, cycleDays:number, deferred:boolean }}
 */
function computeProrationFactor({ periodStart, periodEnd, hireDate }) {
  const cycleDays = inclusiveDays(periodStart, periodEnd);
  if (cycleDays === 0) return { factor: 1, daysInRole: 0, cycleDays: 0, deferred: false };

  const start = toUTCDate(periodStart);
  const end = toUTCDate(periodEnd);
  const hd = toUTCDate(hireDate);

  // No hire date or hired on/before the cycle start → full cycle.
  if (!hd || hd.getTime() <= start.getTime()) {
    return { factor: 1, daysInRole: cycleDays, cycleDays, deferred: false };
  }
  // Hired after the cycle ended → not in role at all (caller defers/cancels).
  if (hd.getTime() > end.getTime()) {
    return { factor: 0, daysInRole: 0, cycleDays, deferred: true };
  }
  const daysInRole = inclusiveDays(hd, end);
  const factor = round4(daysInRole / cycleDays);
  return { factor: Math.min(1, factor), daysInRole, cycleDays, deferred: false };
}

module.exports = { computeProrationFactor, inclusiveDays, round4 };

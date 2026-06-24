'use strict';

/**
 * celebrations.js — DERIVED celebration feed (no heavy new model).
 *
 * Upcoming birthdays (Employee.dateOfBirth) + work anniversaries (Employee.hireDate →
 * years of service) within a forward window (default 30 days, configurable 7/30/…).
 * Pure derivation over the existing employee master — NOTHING is persisted.
 *
 * Privacy (owner's requirement):
 *   - Opt-out: an employee with notifyPrefs.celebrationsOptOut === true is NEVER
 *     surfaced (their birthday/anniversary is hidden from everyone).
 *   - No DOB-YEAR leak: a birthday returns ONLY the day + month (no year, no age).
 *     An anniversary may show YEARS OF SERVICE (that's the point of the milestone)
 *     but never the birth year.
 *   - Scope-aware: the caller passes the in-scope employee id-set (e.g. an ESS reader
 *     gets their tenant — celebrations are intentionally company-wide warmth — while a
 *     manager surface could pass their sub-tree). Tenant isolation is the businessId.
 *
 * Window math is calendar-day based in the tenant's civil sense (we compare month/day,
 * not absolute timestamps), so a Feb-29 birthday lands on Feb-29 in leap years and is
 * skipped in common years (standard, matches greytHR/Keka behaviour).
 */

const prisma = require('../../core/lib/prisma');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function celebrationsOptedOut(notifyPrefs) {
  if (!notifyPrefs || typeof notifyPrefs !== 'object') return false;
  return notifyPrefs.celebrationsOptOut === true;
}

function displayName(e) {
  return e.preferredName || [e.firstName, e.lastName].filter(Boolean).join(' ').trim() || e.code || 'Employee';
}

// UTC-normalised month/day of a @db.Date column. Prisma returns a Date at UTC midnight
// for a DATE, so reading the UTC parts gives the civil month/day the HR team entered.
function monthDay(d) {
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Days from `today` (a civil date, time-stripped) until the NEXT occurrence of
 * (month, day), inclusive of today (0) and wrapping to next year. Feb-29 only matches
 * in a year that has it; otherwise returns null (skip in common years).
 */
function daysUntilNextOccurrence(today, month, day) {
  const y = today.getUTCFullYear();
  const candidate = (year) => {
    // Reject an invalid civil date (e.g. Feb-29 in a non-leap year): JS rolls it to
    // Mar-1, which we detect by the month/day mismatch and treat as "no occurrence".
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) return null;
    return dt;
  };
  let next = candidate(y);
  if (!next || next.getTime() < today.getTime()) {
    next = candidate(y + 1) || candidate(y + 4); // jump to the next leap year for Feb-29
  }
  if (!next) return null;
  const diff = Math.round((next.getTime() - today.getTime()) / MS_PER_DAY);
  return diff < 0 ? null : { days: diff, date: next };
}

function todayUtcDateOnly(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Build the celebration feed.
 *
 * @param {object} args
 *   businessId   — tenant (required)
 *   windowDays   — forward window, default 30 (clamped 1..366)
 *   employeeIds  — optional id allow-list (scope). undefined = whole active tenant.
 *   now          — injectable clock (tests)
 *   limit        — max items returned (default 100)
 * @returns {Promise<{ birthdays: Item[], anniversaries: Item[], windowDays }>}
 *   Item: { employeeId, name, photoUrl, month, day, inDays, date, type, years? }
 */
async function buildCelebrations({ businessId, windowDays = 30, employeeIds, now = new Date(), limit = 100 } = {}) {
  const win = Math.max(1, Math.min(366, Number(windowDays) || 30));
  const today = todayUtcDateOnly(now);

  const where = { businessId, deletedAt: null, isActive: true, status: 'ACTIVE' };
  if (Array.isArray(employeeIds)) {
    if (employeeIds.length === 0) return { birthdays: [], anniversaries: [], windowDays: win };
    where.id = { in: employeeIds };
  }
  // Only rows that COULD celebrate (have a DOB or a hireDate) — keeps the scan tight.
  where.OR = [{ dateOfBirth: { not: null } }, { hireDate: { not: null } }];

  const rows = await prisma.employee.findMany({
    where,
    select: {
      id: true, code: true, firstName: true, lastName: true, preferredName: true,
      photoUrl: true, dateOfBirth: true, hireDate: true, notifyPrefs: true,
    },
    take: 5000,
  });

  const birthdays = [];
  const anniversaries = [];

  for (const e of rows) {
    if (celebrationsOptedOut(e.notifyPrefs)) continue; // privacy opt-out — hide entirely

    if (e.dateOfBirth) {
      const { month, day } = monthDay(e.dateOfBirth);
      const occ = daysUntilNextOccurrence(today, month, day);
      if (occ && occ.days <= win) {
        // NO year, NO age — day/month only (no DOB-year leak).
        birthdays.push({
          employeeId: e.id, name: displayName(e), photoUrl: e.photoUrl || null,
          type: 'BIRTHDAY', month, day, inDays: occ.days, date: occ.date.toISOString().slice(0, 10),
        });
      }
    }

    if (e.hireDate) {
      const { month, day } = monthDay(e.hireDate);
      const occ = daysUntilNextOccurrence(today, month, day);
      if (occ && occ.days <= win) {
        // Years of service AT the upcoming anniversary (the milestone number). Only
        // surface a real milestone (>= 1 year); the hire-year is NOT a birth year, so
        // showing years is privacy-safe and is the whole point of an anniversary.
        const years = occ.date.getUTCFullYear() - e.hireDate.getUTCFullYear();
        if (years >= 1) {
          anniversaries.push({
            employeeId: e.id, name: displayName(e), photoUrl: e.photoUrl || null,
            type: 'ANNIVERSARY', month, day, inDays: occ.days, years,
            date: occ.date.toISOString().slice(0, 10),
          });
        }
      }
    }
  }

  const bySoonest = (a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name);
  birthdays.sort(bySoonest);
  anniversaries.sort(bySoonest);

  return {
    birthdays: birthdays.slice(0, limit),
    anniversaries: anniversaries.slice(0, limit),
    windowDays: win,
  };
}

module.exports = { buildCelebrations, celebrationsOptedOut, daysUntilNextOccurrence, todayUtcDateOnly };

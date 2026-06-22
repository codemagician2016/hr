'use strict';

/**
 * holidays.controller.js — Holiday calendar CRUD + statutory import (Feature 2).
 *
 * The `Holiday` model (prisma) is tenant-scoped and scope-resolved by a `scopeKey`
 * = coalesce(entityId,'*') || ':' || coalesce(locationId,'*'), which collapses the
 * two nullable scope columns into a NOT-NULL key so the unique
 * @@unique([businessId, scopeKey, date, name]) fires for GLOBAL holidays too
 * (Postgres treats NULL as distinct, so without scopeKey a global holiday could be
 * imported twice). Import is idempotent via that unique.
 *
 * Reads are open to any operator (a holiday calendar is not employee-PII); writes
 * and the statutory import require canManageAttendance (gated in the routes).
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');

const HOLIDAY_TYPES = ['PUBLIC', 'NATIONAL', 'REGIONAL', 'COMPANY', 'RESTRICTED_OPTIONAL'];

// scopeKey = coalesce(entityId,'*') || ':' || coalesce(locationId,'*').
function scopeKeyFor(entityId, locationId) {
  return `${entityId || '*'}:${locationId || '*'}`;
}

function utcDate(value) {
  if (value == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

// GET /holidays?countryCode&entityId&locationId&year
async function listHolidays(req, res, next) {
  try {
    const { businessId } = req.user;
    const { countryCode, entityId, locationId, year } = req.query;
    const where = { businessId };
    if (countryCode) where.countryCode = countryCode;
    if (entityId) where.entityId = entityId;
    if (locationId) where.locationId = locationId;
    if (year) {
      const y = parseInt(year, 10);
      if (Number.isFinite(y)) {
        where.date = { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) };
      }
    }
    const items = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// POST /holidays  { date, name, type, countryCode, entityId?, locationId?, isPaid?, isRestricted? }
async function createHoliday(req, res, next) {
  try {
    const { businessId } = req.user;
    const { date, name, type, countryCode } = req.body;
    if (!date || !name || !type || !countryCode) {
      return res.status(400).json({ message: 'date, name, type and countryCode are required' });
    }
    if (!HOLIDAY_TYPES.includes(type)) {
      return res.status(400).json({ message: `type must be one of ${HOLIDAY_TYPES.join(', ')}` });
    }
    const d = utcDate(date);
    if (!d) return res.status(400).json({ message: 'date is not a valid YYYY-MM-DD' });

    const entityId = req.body.entityId || null;
    const locationId = req.body.locationId || null;
    if (entityId) {
      const ent = await prisma.entity.findFirst({ where: { id: entityId, businessId, deletedAt: null } });
      if (!ent) return res.status(400).json({ message: 'entityId does not belong to this business' });
    }
    try {
      const item = await prisma.holiday.create({
        data: {
          businessId, entityId, locationId, date: d, name, type,
          countryCode: String(countryCode).toUpperCase().slice(0, 2),
          isPaid: req.body.isPaid !== false,
          isRestricted: type === 'RESTRICTED_OPTIONAL' ? true : !!req.body.isRestricted,
          scopeKey: scopeKeyFor(entityId, locationId),
        },
      });
      res.status(201).json(item);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ message: 'A holiday with that name already exists on that date in this scope' });
      throw e;
    }
  } catch (e) { next(e); }
}

// PATCH /holidays/:id
async function updateHoliday(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.holiday.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Holiday not found' });

    const data = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.type !== undefined) {
      if (!HOLIDAY_TYPES.includes(req.body.type)) {
        return res.status(400).json({ message: `type must be one of ${HOLIDAY_TYPES.join(', ')}` });
      }
      data.type = req.body.type;
    }
    if (req.body.date !== undefined) {
      const d = utcDate(req.body.date);
      if (!d) return res.status(400).json({ message: 'date is not a valid YYYY-MM-DD' });
      data.date = d;
    }
    if (req.body.isPaid !== undefined) data.isPaid = !!req.body.isPaid;
    if (req.body.isRestricted !== undefined) data.isRestricted = !!req.body.isRestricted;
    if (req.body.entityId !== undefined || req.body.locationId !== undefined) {
      const entityId = req.body.entityId !== undefined ? (req.body.entityId || null) : existing.entityId;
      const locationId = req.body.locationId !== undefined ? (req.body.locationId || null) : existing.locationId;
      data.entityId = entityId;
      data.locationId = locationId;
      data.scopeKey = scopeKeyFor(entityId, locationId);
    }
    try {
      const item = await prisma.holiday.update({ where: { id: existing.id }, data });
      res.json(item);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ message: 'A holiday with that name already exists on that date in this scope' });
      throw e;
    }
  } catch (e) { next(e); }
}

// DELETE /holidays/:id  (hard delete — Holiday has no soft-delete column)
async function removeHoliday(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.holiday.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Holiday not found' });
    await prisma.holiday.delete({ where: { id: existing.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Statutory import                                                    */
/* ------------------------------------------------------------------ */

// Mondayisation (NZ Holidays Act 2003): when a public holiday falls on a Sat/Sun
// AND the day is not normally worked, the observed holiday transfers to the next
// available working day (Mon, or Tue if Mon is also an observed holiday). Standard
// rule: Saturday → Monday, Sunday → Monday. Christmas/Boxing Day and New Year's/
// 2 Jan get SEQUENTIAL Mon/Tue when both fall on a weekend — H4 handles the
// back-to-back collision (two weekend holidays whose naive Monday targets coincide).
function weekday(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); } // 0=Sun..6=Sat

// Naive transfer: the FIRST candidate working day for a Sat/Sun holiday (Sat→Mon,
// Sun→Mon). Returns null for a weekday (no transfer). Collision-bumping is done by
// the caller against the set of already-claimed observed dates.
function mondayisedObserved(y, m, d) {
  const wd = weekday(y, m, d);
  if (wd === 6) return addCivil({ y, m, d }, 2); // Sat → Mon
  if (wd === 0) return addCivil({ y, m, d }, 1); // Sun → Mon
  return null;
}

// Next working day (Mon..Fri) on/after the given civil date that is not already in
// `claimed` (a Set of 'YYYY-MM-DD' observed dates). Used to bump an observed
// holiday past one already produced (H4) AND past the weekend.
function nextFreeWorkingDay(date, claimed) {
  let cur = { ...date };
  for (let i = 0; i < 14; i++) {
    const wd = weekday(cur.y, cur.m, cur.d);
    const key = `${cur.y}-${String(cur.m).padStart(2, '0')}-${String(cur.d).padStart(2, '0')}`;
    if (wd !== 0 && wd !== 6 && !claimed.has(key)) return cur;
    cur = addCivil(cur, 1);
  }
  return cur; // pathological fallback
}

// The standard NZ national public-holiday set (fixed-date subset) for a year.
// Easter (Good Friday / Easter Monday) and Matariki are date-varying; we include
// a small Matariki table and compute Easter via the anonymous Gregorian algorithm.
function nzNationalSet(year) {
  const fixed = [
    { m: 1, d: 1, name: "New Year's Day", mondayise: true },
    { m: 1, d: 2, name: 'Day after New Year', mondayise: true },
    { m: 2, d: 6, name: 'Waitangi Day', mondayise: true },
    { m: 4, d: 25, name: 'ANZAC Day', mondayise: true },
    { m: 12, d: 25, name: 'Christmas Day', mondayise: true },
    { m: 12, d: 26, name: 'Boxing Day', mondayise: true },
  ];
  const out = [];
  // H4 — process the mondayisable set in DATE ORDER, tracking the observed dates
  // already claimed. When a holiday's naive Monday target collides with one already
  // produced (Christmas+Boxing both → Mon; New Year+Day-after both → Mon), bump the
  // later one to the next free working day (Tue), per the Holidays Act.
  const claimed = new Set(); // 'YYYY-MM-DD' of every actual + observed date emitted
  const claim = (y, m, d) => claimed.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  const ordered = [...fixed].sort((a, b) => (a.m - b.m) || (a.d - b.d));
  for (const h of ordered) {
    out.push({ year, month: h.m, day: h.d, name: h.name, type: 'PUBLIC' });
    claim(year, h.m, h.d);
    if (h.mondayise) {
      const naive = mondayisedObserved(year, h.m, h.d);
      if (naive) {
        // Bump past any already-claimed observed date (and the weekend).
        const obs = nextFreeWorkingDay(naive, claimed);
        out.push({ year: obs.y, month: obs.m, day: obs.d, name: `${h.name} (observed)`, type: 'PUBLIC' });
        claim(obs.y, obs.m, obs.d);
      }
    }
  }
  // Easter — Good Friday + Easter Monday (never mondayised).
  const easter = computeEaster(year);
  const gf = addCivil(easter, -2);
  const em = addCivil(easter, 1);
  out.push({ year: gf.y, month: gf.m, day: gf.d, name: 'Good Friday', type: 'PUBLIC' });
  out.push({ year: em.y, month: em.m, day: em.d, name: 'Easter Monday', type: 'PUBLIC' });
  // Matariki (Friday public holiday) — official dates table.
  const matariki = { 2024: [6, 28], 2025: [6, 20], 2026: [7, 10], 2027: [6, 25], 2028: [7, 14] }[year];
  if (matariki) out.push({ year, month: matariki[0], day: matariki[1], name: 'Matariki', type: 'PUBLIC' });
  // Sovereign's Birthday (first Monday of June) + Labour Day (fourth Monday of October).
  const kb = nthWeekdayOfMonth(year, 6, 1, 1); // Monday(1), 1st
  out.push({ year, month: 6, day: kb, name: "King's Birthday", type: 'PUBLIC' });
  const labour = nthWeekdayOfMonth(year, 10, 1, 4);
  out.push({ year, month: 10, day: labour, name: 'Labour Day', type: 'PUBLIC' });
  return out;
}

// Provincial anniversary days (REGIONAL; not national). Auckland anniversary =
// Monday nearest 29 Jan; Wellington anniversary = Monday nearest 22 Jan. v1 uses
// "Monday nearest" = the Monday in the same week. locationId is left null here
// (region by name); operators may re-scope to a Location after import.
function nzProvincialSet(year) {
  return [
    { year, ...mondayNearest(year, 1, 29), name: 'Auckland Anniversary Day', type: 'REGIONAL' },
    { year, ...mondayNearest(year, 1, 22), name: 'Wellington Anniversary Day', type: 'REGIONAL' },
  ];
}

// The Indian national-holiday set (NATIONAL flagged) + a couple RESTRICTED_OPTIONAL.
function inNationalSet(year) {
  return [
    { year, month: 1, day: 26, name: 'Republic Day', type: 'NATIONAL', isRestricted: false },
    { year, month: 8, day: 15, name: 'Independence Day', type: 'NATIONAL', isRestricted: false },
    { year, month: 10, day: 2, name: 'Gandhi Jayanti', type: 'NATIONAL', isRestricted: false },
    // Restricted / optional holidays (employee opts in).
    { year, month: 1, day: 14, name: 'Makar Sankranti / Pongal', type: 'RESTRICTED_OPTIONAL', isRestricted: true },
    { year, month: 4, day: 14, name: 'Dr. Ambedkar Jayanti', type: 'RESTRICTED_OPTIONAL', isRestricted: true },
  ];
}

// --- date helpers for the statutory tables ---
function computeEaster(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y: year, m: month, d: day };
}
function addCivil({ y, m, d }, n) {
  const base = new Date(Date.UTC(y, m - 1, d + n));
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}
function nthWeekdayOfMonth(year, month, weekdayNum, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = ((weekdayNum - first + 7) % 7) + (nth - 1) * 7;
  return 1 + offset;
}
function mondayNearest(year, month, day) {
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  // distance to Monday(1): pick the closest Monday (ties go forward).
  let delta = (1 - wd + 7) % 7; // forward to Monday
  if (delta > 3) delta -= 7; // closer going back
  const r = addCivil({ y: year, m: month, d: day }, delta);
  return { month: r.m, day: r.d };
}

// POST /holidays/import  { countryCode, year, entityId? }
async function importHolidays(req, res, next) {
  try {
    const { businessId } = req.user;
    const { countryCode, year, entityId } = req.body;
    const cc = String(countryCode || '').toUpperCase();
    const y = parseInt(year, 10);
    if (!cc || !Number.isFinite(y)) {
      return res.status(400).json({ message: 'countryCode and year are required' });
    }
    // L4 — bound the year so a typo/overflow can't generate a runaway statutory set.
    if (y < 2000 || y > 2100) {
      return res.status(400).json({ message: 'year must be between 2000 and 2100' });
    }
    if (entityId) {
      const ent = await prisma.entity.findFirst({ where: { id: entityId, businessId, deletedAt: null } });
      if (!ent) return res.status(400).json({ message: 'entityId does not belong to this business' });
    }

    let set;
    const warnings = [];
    if (cc === 'NZ') {
      set = [...nzNationalSet(y), ...nzProvincialSet(y)];
      // L4 — Matariki is a date-varying holiday from a small official table; warn
      // when the requested year falls outside it so the gap isn't silent.
      if (!set.some((h) => h.name === 'Matariki')) {
        warnings.push({ code: 'MATARIKI_MISSING', message: `No Matariki date is tabulated for ${y}; import that holiday manually once the official date is published.` });
      }
    } else if (cc === 'IN') set = inNationalSet(y);
    else return res.status(400).json({ message: `No statutory set for countryCode ${cc} (supported: NZ, IN)` });

    const scopeEntityId = entityId || null;
    const scopeKey = scopeKeyFor(scopeEntityId, null);

    let created = 0;
    let updated = 0;
    for (const h of set) {
      const d = new Date(Date.UTC(h.year, h.month - 1, h.day));
      const result = await prisma.holiday.upsert({
        where: {
          businessId_scopeKey_date_name: { businessId, scopeKey, date: d, name: h.name },
        },
        update: {
          type: h.type,
          isRestricted: h.type === 'RESTRICTED_OPTIONAL' ? true : !!h.isRestricted,
          isPaid: true,
          countryCode: cc,
        },
        create: {
          businessId, entityId: scopeEntityId, locationId: null,
          date: d, name: h.name, type: h.type, countryCode: cc,
          isPaid: true,
          isRestricted: h.type === 'RESTRICTED_OPTIONAL' ? true : !!h.isRestricted,
          scopeKey,
        },
        select: { createdAt: true, updatedAt: true },
      });
      // A fresh create has createdAt === updatedAt; treat re-upserts as updates.
      if (result.createdAt.getTime() === result.updatedAt.getTime()) created += 1;
      else updated += 1;
    }

    await writeAudit({
      businessId, actorId: req.user.id, action: 'holiday.import',
      entityType: 'Holiday', entityId: null,
      meta: { countryCode: cc, year: y, entityId: scopeEntityId, count: set.length },
    });

    res.status(201).json({ countryCode: cc, year: y, entityId: scopeEntityId, total: set.length, created, updated, warnings });
  } catch (e) { next(e); }
}

module.exports = {
  listHolidays,
  createHoliday,
  updateHoliday,
  removeHoliday,
  importHolidays,
  _internals: { scopeKeyFor, mondayisedObserved, nextFreeWorkingDay, nzNationalSet, nzProvincialSet, inNationalSet, computeEaster },
};

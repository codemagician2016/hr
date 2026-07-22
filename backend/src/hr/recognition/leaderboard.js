'use strict';

/**
 * leaderboard.js — Feature 35 §4.6. PURE derivation over the points ledger +
 * recognition rows; v1 computes live with a take/pagination cap (no snapshot table).
 *
 * Pure (unit-tested, no DB):
 *   windowRange(period, now)         — thisMonth | quarter | allTime → { start, end }
 *   rankEarners(entries)             — Σ positive RECOGNITION/AWARD points per employee
 *   rankGivers(recognitions)         — recognition COUNT (given) per giver
 *   valueTally(recognitions)         — most-celebrated value counts
 *
 * DB wrappers: earnersBoard / giversBoard / valuesBoard — query then rank, joined
 * to the employee directory (safe fields only), optionally narrowed to an F1
 * team/department segment via employeeIds.
 */

/** PURE — the [start, end) window for a leaderboard period. allTime → open start. */
function windowRange(period, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === 'quarter') {
    const qStart = Math.floor(m / 3) * 3;
    return { start: new Date(y, qStart, 1), end: new Date(y, qStart + 3, 1) };
  }
  if (period === 'allTime' || period === 'all') {
    return { start: null, end: null };
  }
  // 'month' (default)
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
}

/**
 * PURE — rank earners from ledger entries: ONLY earned points count (+points with
 * reason RECOGNITION or AWARD — adjustments/reversals/expiry never move the board).
 * Returns [{ employeeId, points, rank }] sorted desc; standard competition ranking
 * (ties share a rank, next rank skips).
 */
function rankEarners(entries) {
  const totals = new Map();
  for (const e of entries || []) {
    if (!e || !e.employeeId) continue;
    const pts = Number(e.points);
    if (!Number.isInteger(pts) || pts <= 0) continue;
    if (e.reason !== 'RECOGNITION' && e.reason !== 'AWARD') continue;
    totals.set(e.employeeId, (totals.get(e.employeeId) || 0) + pts);
  }
  return applyRanks([...totals.entries()].map(([employeeId, points]) => ({ employeeId, points })), 'points');
}

/**
 * PURE — rank givers: number of POSTED recognitions given (recognition is two-sided;
 * celebrating generosity, not points). Returns [{ employeeId, count, rank }].
 */
function rankGivers(recognitions) {
  const totals = new Map();
  for (const r of recognitions || []) {
    if (!r || !r.giverEmployeeId) continue;
    if (r.status && r.status !== 'POSTED') continue;
    totals.set(r.giverEmployeeId, (totals.get(r.giverEmployeeId) || 0) + 1);
  }
  return applyRanks([...totals.entries()].map(([employeeId, count]) => ({ employeeId, count })), 'count');
}

/** PURE — most-celebrated value: counts of POSTED recognitions per valueId. */
function valueTally(recognitions) {
  const totals = new Map();
  for (const r of recognitions || []) {
    if (!r || !r.valueId) continue;
    if (r.status && r.status !== 'POSTED') continue;
    totals.set(r.valueId, (totals.get(r.valueId) || 0) + 1);
  }
  return applyRanks([...totals.entries()].map(([valueId, count]) => ({ valueId, count })), 'count');
}

// Standard competition ranking: sort desc by `key`, ties share a rank, next skips.
function applyRanks(rows, key) {
  const sorted = [...rows].sort((a, b) => (b[key] - a[key]));
  let lastValue = null;
  let lastRank = 0;
  return sorted.map((row, i) => {
    const rank = row[key] === lastValue ? lastRank : i + 1;
    lastValue = row[key];
    lastRank = rank;
    return { ...row, rank };
  });
}

// ── DB wrappers ──────────────────────────────────────────────────────────────

const DIRECTORY_SELECT = { id: true, code: true, firstName: true, lastName: true };

async function directoryFor(db, businessId, employeeIds) {
  if (!employeeIds.length) return new Map();
  const emps = await db.employee.findMany({
    where: { businessId, id: { in: employeeIds } },
    select: DIRECTORY_SELECT,
  });
  return new Map(emps.map((e) => [e.id, {
    employeeId: e.id,
    code: e.code,
    name: [e.firstName, e.lastName].filter(Boolean).join(' '),
  }]));
}

/** Employee ids for a department narrow (current segment), or null for no narrow. */
async function segmentEmployeeIds(db, businessId, { departmentId }) {
  if (!departmentId) return null;
  const recs = await db.employmentRecord.findMany({
    where: { businessId, isCurrent: true, departmentId },
    select: { employeeId: true },
  });
  return [...new Set(recs.map((r) => r.employeeId))];
}

/** Top earners over a window (earned-only ledger derivation), directory-joined. */
async function earnersBoard(db, { businessId, period = 'month', departmentId = null, take = 50, now = new Date() }) {
  const { start, end } = windowRange(period, now);
  const narrow = await segmentEmployeeIds(db, businessId, { departmentId });
  const where = {
    businessId,
    points: { gt: 0 },
    reason: { in: ['RECOGNITION', 'AWARD'] },
    ...(start ? { createdAt: { gte: start, lt: end } } : {}),
    ...(narrow ? { employeeId: { in: narrow } } : {}),
  };
  const entries = await db.pointsLedgerEntry.findMany({
    where,
    select: { employeeId: true, points: true, reason: true },
    take: 50000, // hard cap — a v2 LeaderboardSnapshot covers bigger tenants
  });
  const ranked = rankEarners(entries).slice(0, take);
  const dir = await directoryFor(db, businessId, ranked.map((r) => r.employeeId));
  return ranked.map((r) => ({ ...r, ...(dir.get(r.employeeId) || {}) }));
}

/** Top givers over a window (POSTED recognitions given), directory-joined. */
async function giversBoard(db, { businessId, period = 'month', departmentId = null, take = 50, now = new Date() }) {
  const { start, end } = windowRange(period, now);
  const narrow = await segmentEmployeeIds(db, businessId, { departmentId });
  const where = {
    businessId,
    status: 'POSTED',
    ...(start ? { postedAt: { gte: start, lt: end } } : {}),
    ...(narrow ? { giverEmployeeId: { in: narrow } } : {}),
  };
  const rows = await db.recognition.findMany({
    where,
    select: { giverEmployeeId: true, status: true },
    take: 50000,
  });
  const ranked = rankGivers(rows).slice(0, take);
  const dir = await directoryFor(db, businessId, ranked.map((r) => r.employeeId));
  return ranked.map((r) => ({ ...r, ...(dir.get(r.employeeId) || {}) }));
}

/** Most-celebrated values over a window, joined to the value names. */
async function valuesBoard(db, { businessId, period = 'month', take = 20, now = new Date() }) {
  const { start, end } = windowRange(period, now);
  const rows = await db.recognition.findMany({
    where: {
      businessId,
      status: 'POSTED',
      valueId: { not: null },
      ...(start ? { postedAt: { gte: start, lt: end } } : {}),
    },
    select: { valueId: true, status: true },
    take: 50000,
  });
  const ranked = valueTally(rows).slice(0, take);
  const ids = ranked.map((r) => r.valueId);
  const values = ids.length
    ? await db.recognitionValue.findMany({ where: { businessId, id: { in: ids } }, select: { id: true, name: true, icon: true, colorHex: true } })
    : [];
  const byId = new Map(values.map((v) => [v.id, v]));
  return ranked.map((r) => ({ ...r, value: byId.get(r.valueId) || null }));
}

module.exports = {
  windowRange,
  rankEarners,
  rankGivers,
  valueTally,
  earnersBoard,
  giversBoard,
  valuesBoard,
  _internals: { applyRanks },
};

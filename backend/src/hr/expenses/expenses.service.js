'use strict';

/**
 * expenses.service.js — Feature 11 orchestrator. The impure seam around the pure
 * policyEngine: it loads the active policy + the employee's level + the city tier,
 * runs the engine per line, snapshots the matched rules onto the claim (immutability),
 * mints the atomic EXP-/TRV- codes, opens the F10 ApprovalRequest, and settles.
 *
 * Reuses (does NOT duplicate):
 *   - allocateCode (codes.js)          — atomic EXP-/TRV- minting inside a tx
 *   - engine.openRequest (approvals)   — the F10 chain (EXPENSE / TRAVEL modules)
 *   - policyEngine.evaluateLine        — the pure validator
 *   - Grade.rank                       — the employee LEVEL for hotel/transport
 *   - CityTier                         — destination → tier resolution
 */

const prisma = require('../../core/lib/prisma');
const { format, SCOPE_DEFAULTS } = require('../lifecycle/lib/codes');
const engine = require('../approvals/engine');
const { evaluateLine, rollupVerdict } = require('./policyEngine');
// Self-register the EXPENSE + TRAVEL consumer bundles (idempotent) so any entrypoint
// that loads the service wires the chain-completion callbacks.
require('../approvals/consumers.expense');
require('../approvals/consumers.travel');

// ── code minting (atomic, race-safe) ────────────────────────────────────────
// Mint a per-tenant sequential human code (EXP-####, TRV-####) inside the caller's tx.
// The lifecycle allocateCode does a plain findFirst+increment, which two concurrent
// transactions can read-modify-write onto the SAME nextValue and re-collide (caught only
// by the new @@unique([businessId, claimNumber]) + a P2002 retry). To make minting
// genuinely atomic — not merely backstopped — we row-LOCK the NumberSequence row
// (SELECT … FOR UPDATE, the letters.service pattern) so concurrent minters serialize on
// the lock and each reads a fresh value. The row is created on first use (P2002-safe via
// the @@unique([businessId, entityId, scope, periodKey])); a creation race is re-thrown
// for the caller's retry, after which the lock path takes over.
async function mintCode(tx, businessId, scope) {
  const dflt = SCOPE_DEFAULTS[scope] || {};
  const prefix = dflt.prefix != null ? dflt.prefix : `${scope}-`;
  const padding = dflt.padding != null ? dflt.padding : 6;

  // Lock the existing tenant-wide (entityId NULL, periodKey NULL) sequence row.
  const locked = await tx.$queryRaw`
    SELECT "id", "nextValue", "prefix", "padding" FROM "NumberSequence"
    WHERE "businessId" = ${businessId}
      AND "entityId" IS NULL
      AND "scope" = ${scope}
      AND "periodKey" IS NULL
    FOR UPDATE`;

  if (Array.isArray(locked) && locked.length) {
    const row = locked[0];
    const value = Number(row.nextValue);
    await tx.numberSequence.update({ where: { id: row.id }, data: { nextValue: value + 1 } });
    return format(row.prefix || prefix, value, row.padding || padding);
  }

  // No row yet → create it at nextValue:2 and use 1 (a concurrent create races on the
  // @@unique → P2002, which we let propagate so the caller retries onto the lock path).
  await tx.numberSequence.create({
    data: { businessId, entityId: null, scope, prefix, padding, nextValue: 2, periodKey: null },
  });
  return format(prefix, 1, padding);
}

async function mintClaimNumber(tx, businessId) {
  return mintCode(tx, businessId, 'EXP');
}
async function mintTravelNumber(tx, businessId) {
  return mintCode(tx, businessId, 'TRV');
}

// ── employee level (Grade.rank) ─────────────────────────────────────────────
// The level lives on the employee's CURRENT EmploymentRecord (gradeId); fall back to
// the designation's anchored grade if the record carries no explicit grade. null when
// the employee has no graded record → the engine treats it as the all-levels rules.
async function gradeRankOf(businessId, employeeId) {
  if (!employeeId) return null;
  const rec = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
    select: { gradeId: true, designation: { select: { gradeId: true } } },
  });
  const gradeId = rec ? (rec.gradeId || (rec.designation && rec.designation.gradeId)) : null;
  if (!gradeId) return null;
  const grade = await prisma.grade.findFirst({ where: { id: gradeId, businessId }, select: { rank: true } });
  return grade ? grade.rank : null;
}

// ── city → tier resolution ──────────────────────────────────────────────────
// Normalize a city to the lower-cased match key CityTier stores.
function cityKey(city) {
  return String(city || '').trim().toLowerCase();
}

async function resolveCityTier(businessId, city, countryCode, defaultTier) {
  const key = cityKey(city);
  if (!key) return defaultTier || 'TIER_3';
  const where = { businessId, city: key, deletedAt: null };
  if (countryCode) where.countryCode = countryCode;
  const row = await prisma.cityTier.findFirst({ where, select: { tier: true } });
  return row ? row.tier : (defaultTier || 'TIER_3');
}

// ── active policy load (with its rule tables) ───────────────────────────────
// The most recent active policy for the tenant (optionally entity-scoped), with all
// three rule tables eagerly loaded for the pure engine.
async function loadActivePolicy(businessId, { entityId = null, countryCode = null } = {}) {
  const where = { businessId, isActive: true, deletedAt: null };
  if (entityId) where.entityId = entityId;
  if (countryCode) where.countryCode = countryCode;
  const policy = await prisma.travelPolicy.findFirst({
    where,
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    include: { perDiemRules: true, hotelRules: true, transportRules: true },
  });
  return policy || null;
}

// ── per-category ExpensePolicy load (folded rules) ──────────────────────────
async function loadCategoryPolicy(businessId, categoryId) {
  if (!categoryId) return null;
  return prisma.expensePolicy.findFirst({
    where: { businessId, categoryId, isActive: true, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

// month-to-date approved+submitted+reimbursed spend for a category (for the monthly cap).
async function monthToDateForCategory(businessId, employeeId, categoryId, when = new Date()) {
  if (!categoryId) return 0;
  const start = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), 1));
  const end = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth() + 1, 1));
  const rows = await prisma.expenseClaimLine.findMany({
    where: {
      businessId, categoryId,
      claim: { employeeId, status: { in: ['SUBMITTED', 'APPROVED', 'REIMBURSED'] }, deletedAt: null },
      expenseDate: { gte: start, lt: end },
    },
    select: { amount: true },
  });
  return rows.reduce((acc, r) => acc + Number(r.amount || 0), 0);
}

// ── duration band from a span of hours ──────────────────────────────────────
function bandFromHours(hours) {
  const h = Number(hours);
  if (Number.isNaN(h)) return null;
  if (h >= 24) return 'FULL_24H';
  if (h >= 12) return 'HALF_12H';
  return 'HALF_DAY';
}

// Per-diem bands ordered by allowance SIZE (FULL_24H is the most generous). A claimant
// must never get a band MORE generous than the trip's real duration justifies, so we
// rank them and reject a band whose rank exceeds the trip's server-derived band.
const BAND_RANK = Object.freeze({ HALF_DAY: 0, HALF_12H: 1, FULL_24H: 2 });

// A self-drive line can never sanely exceed this distance for a single bill. Bounds the
// SELF_CAR mileage cap (perKmRate × distanceKm) so it cannot be inflated without limit.
// (A real cross-country leg is well under this; it is a guard-rail, not a policy figure.)
const MAX_DISTANCE_KM = 5000;

// ── trip-dimension sanitiser (THE server-side HARD invariant for F11 §8) ─────
// nights / distanceKm / durationBand arrive on each bill line from the CLIENT and feed
// straight into the policy caps (hotel = nightlyCap × nights, mileage = perKmRate ×
// distanceKm, per-diem cap selected BY band). Left untrusted they let a claimant inflate
// a dimension until an over-cap bill reads "within policy" and slips past the HARD submit
// block. This derives/bounds every cap-driving dimension from the TRIP itself:
//
//   • durationBand — bounded by the trip's real duration (bandFromHours); a band more
//       generous than the trip justifies is REJECTED ({ ok:false }). With no trip we fall
//       back to the trip-less max (HALF_DAY) so a standalone claim cannot pick FULL_24H.
//   • nights       — clamped to ceil(durationHours / 24) (a trip spanning N hours can bill
//       at most that many hotel nights). Defaults to 1 with no trip.
//   • distanceKm   — clamped to [0, MAX_DISTANCE_KM]; negatives → 0, NaN → null.
//
// Returns { ok, value?, reason? }. ok:false means the line must be REJECTED (400) — the
// caller never persists or evaluates it. ok:true returns the SANITISED dimensions to use
// in place of the client's. Pure (no I/O), so it runs identically on add + on submit.
function tripDurationHours(trip) {
  if (!trip) return null;
  if (trip.durationHours != null && !Number.isNaN(Number(trip.durationHours))) return Math.max(1, Number(trip.durationHours));
  if (trip.startAt && trip.endAt) {
    const ms = new Date(trip.endAt) - new Date(trip.startAt);
    if (!Number.isNaN(ms) && ms >= 0) return Math.max(1, Math.round(ms / 3600000));
  }
  return null;
}

function sanitizeTripDimensions(raw, trip) {
  const out = {};
  const hours = tripDurationHours(trip); // null for a standalone (trip-less) reimbursement

  // durationBand — derive the trip's max-justifiable band; reject a more generous pick.
  const maxBand = hours != null ? bandFromHours(hours) : 'HALF_DAY';
  if (raw.durationBand != null && raw.durationBand !== '') {
    if (!(raw.durationBand in BAND_RANK)) {
      return { ok: false, reason: `Unknown per-diem band ${raw.durationBand}` };
    }
    if (BAND_RANK[raw.durationBand] > BAND_RANK[maxBand]) {
      return {
        ok: false,
        reason: hours != null
          ? `Per-diem band ${raw.durationBand} exceeds the trip's ${hours}h duration (max ${maxBand})`
          : `Per-diem band ${raw.durationBand} is not allowed on a standalone claim (max ${maxBand})`,
      };
    }
    out.durationBand = raw.durationBand;
  } else {
    out.durationBand = null;
  }

  // nights — bound by ceil(durationHours / 24); default 1 night, 0/neg rejected upstream.
  if (raw.nights != null && raw.nights !== '') {
    const n = Math.floor(Number(raw.nights));
    if (Number.isNaN(n) || n < 0) return { ok: false, reason: 'nights must be a non-negative integer' };
    const maxNights = hours != null ? Math.max(1, Math.ceil(hours / 24)) : 1;
    if (n > maxNights) {
      return {
        ok: false,
        reason: hours != null
          ? `nights ${n} exceeds the trip's duration (max ${maxNights} night(s) for ${hours}h)`
          : `nights ${n} is not allowed on a standalone claim (max ${maxNights})`,
      };
    }
    out.nights = n;
  } else {
    out.nights = null;
  }

  // distanceKm — clamp to a sane maximum; reject a non-numeric / negative value.
  if (raw.distanceKm != null && raw.distanceKm !== '') {
    const d = Number(raw.distanceKm);
    if (Number.isNaN(d) || d < 0) return { ok: false, reason: 'distanceKm must be a non-negative number' };
    if (d > MAX_DISTANCE_KM) {
      return { ok: false, reason: `distanceKm ${d} exceeds the maximum allowed ${MAX_DISTANCE_KM}km for a single line` };
    }
    out.distanceKm = d;
  } else {
    out.distanceKm = null;
  }

  return { ok: true, value: out };
}

// ── evaluate one line against the policy, building the ctx the engine needs ──
// `opts` carries the resolved dimensions so the caller can reuse them across lines.
async function evaluateOneLine(businessId, employeeId, line, opts) {
  const { policy, gradeRank, cityTier, currencyCode, journeyHours } = opts;
  const categoryPolicy = await loadCategoryPolicy(businessId, line.categoryId);
  const monthToDate = categoryPolicy && categoryPolicy.maxPerMonth != null
    ? await monthToDateForCategory(businessId, employeeId, line.categoryId, line.expenseDate ? new Date(line.expenseDate) : new Date())
    : 0;
  const ctx = { policy, categoryPolicy, gradeRank, cityTier, currencyCode, journeyHours, monthToDate };
  const verdict = evaluateLine(line, ctx);
  return verdict;
}

// Build the immutable snapshot stored on the claim at submit time.
function buildPolicySnapshot(policy, evaluatedLines) {
  return {
    policyId: policy ? policy.id : null,
    policyName: policy ? policy.name : null,
    enforcement: policy ? policy.enforcement : null,
    capturedAt: new Date().toISOString(),
    rules: policy ? {
      perDiem: policy.perDiemRules || [],
      hotel: policy.hotelRules || [],
      transport: policy.transportRules || [],
    } : null,
    lineVerdicts: evaluatedLines.map((l) => ({ lineId: l.lineId || null, verdict: l.verdict, appliedCap: l.appliedCap != null ? String(l.appliedCap) : null, reason: l.reason })),
  };
}

// ── open the F10 approval request for a claim (EXPENSE module) ──────────────
async function openClaimApproval(tx, { businessId, claim }) {
  const result = await engine.openRequest({
    businessId,
    module: 'EXPENSE',
    entityType: 'ExpenseClaim',
    entityId: claim.id,
    requesterEmployeeId: claim.employeeId,
    payload: {
      amount: claim.amount != null ? String(claim.amount) : null,
      claimNumber: claim.claimNumber || null,
      claimType: claim.claimType,
      policyVerdict: claim.policyVerdict,
    },
    ctx: {
      entityId: claim.id,
      amount: Number(claim.amount),
      categoryCode: null,
      departmentId: null,
    },
  }, tx);
  return result;
}

// ── open the F10 approval request for a trip (TRAVEL module) ────────────────
async function openTripApproval(tx, { businessId, trip, estimateAmount }) {
  const result = await engine.openRequest({
    businessId,
    module: 'TRAVEL',
    entityType: 'TravelRequest',
    entityId: trip.id,
    requesterEmployeeId: trip.employeeId,
    payload: {
      travelNumber: trip.travelNumber || null,
      purpose: trip.purpose,
      amount: estimateAmount != null ? String(estimateAmount) : null,
    },
    ctx: {
      entityId: trip.id,
      amount: Number(estimateAmount || trip.advanceAmount || 0),
      departmentId: null,
    },
  }, tx);
  return result;
}

module.exports = {
  mintClaimNumber,
  mintTravelNumber,
  gradeRankOf,
  resolveCityTier,
  cityKey,
  loadActivePolicy,
  loadCategoryPolicy,
  monthToDateForCategory,
  bandFromHours,
  sanitizeTripDimensions,
  tripDurationHours,
  evaluateOneLine,
  buildPolicySnapshot,
  openClaimApproval,
  openTripApproval,
  MAX_DISTANCE_KM,
  BAND_RANK,
};

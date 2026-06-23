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
const { allocateCode } = require('../lifecycle/lib/codes');
const engine = require('../approvals/engine');
const { evaluateLine, rollupVerdict } = require('./policyEngine');
// Self-register the EXPENSE + TRAVEL consumer bundles (idempotent) so any entrypoint
// that loads the service wires the chain-completion callbacks.
require('../approvals/consumers.expense');
require('../approvals/consumers.travel');

// ── code minting (atomic, race-safe) ────────────────────────────────────────
async function mintClaimNumber(tx, businessId) {
  return allocateCode(tx, { businessId, scope: 'EXP' });
}
async function mintTravelNumber(tx, businessId) {
  return allocateCode(tx, { businessId, scope: 'TRV' });
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
  evaluateOneLine,
  buildPolicySnapshot,
  openClaimApproval,
  openTripApproval,
};

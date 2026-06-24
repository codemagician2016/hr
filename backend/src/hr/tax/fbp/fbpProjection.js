'use strict';

/**
 * fbpProjection.js — Feature 25, the THIN impure loader that the projectionAssembler
 * calls to get the single FBP-exempt total (paise) to subtract from
 * otherAllowancesMinor. It LOADS the current FbpAllocation + its plan heads + the
 * FBP proofs + the FBP_ALLOCATION window, then defers ALL math to the PURE
 * fbpAggregator.computeFbpExempt. Read-only; never writes (computes on every read so
 * it can never go stale — same discipline as the rest of the assembler).
 *
 * The result drops into ONE line in projectionAssembler:
 *   annualEarnings.otherAllowancesMinor =
 *     Math.max(0, annualEarnings.otherAllowancesMinor - fbp.totalExemptMinor);
 * so the monthly TDS run + the ESS projection both inherit it atomically (both
 * reconcile through buildTaxProjection — golden parity holds).
 */

const prisma = require('../../../core/lib/prisma');
const { resolveWindow } = require('../investmentProof/windowResolver');
const { computeFbpExempt } = require('./fbpAggregator');

// Decimal|string|number → integer paise.
function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// Map an FbpPlanHead row → the pure aggregator's `head` shape (caps → paise).
function headToPure(h) {
  return {
    id: h.id,
    headType: h.headType,
    label: h.label,
    taxSection: h.taxSection || null,
    claimType: h.claimType || null,
    annualCapMinor: h.annualCapRupees != null ? rupeesToMinor(h.annualCapRupees) : null,
    monthlyCapMinor: h.monthlyCapRupees != null ? rupeesToMinor(h.monthlyCapRupees) : null,
    minAllocMinor: h.minAllocRupees != null ? rupeesToMinor(h.minAllocRupees) : null,
    proofRequired: h.proofRequired !== false,
    exemptOldRegimeOnly: h.exemptOldRegimeOnly !== false,
    payCadence: h.payCadence || 'MONTHLY',
  };
}

/**
 * Resolve the FBP-exempt total + per-head breakdown for an employee, as-of a date.
 *
 * @param {object} args
 * @param {string} args.businessId
 * @param {string} args.employeeId
 * @param {string} args.financialYear  "YYYY-YY"
 * @param {string} args.asOf           'YYYY-MM-DD' (drives the declared→verified flip)
 * @param {string} args.regime         'OLD' | 'NEW'
 * @param {object} [args.db]           prisma client / tx
 * @returns { totalExemptMinor, basis, lines:[…], hasAllocation:boolean }
 */
async function resolveFbpExempt({ businessId, employeeId, financialYear, asOf, regime, db = prisma } = {}) {
  const EMPTY = { totalExemptMinor: 0, basis: 'DECLARED', lines: [], hasAllocation: false };
  if (!businessId || !employeeId || !financialYear) return EMPTY;

  // The CURRENT (latest, non-superseded, non-deleted) allocation for this FY.
  const allocation = await db.fbpAllocation.findFirst({
    where: {
      businessId, employeeId, financialYear, deletedAt: null,
      status: { in: ['SUBMITTED', 'LOCKED'] },
    },
    orderBy: { version: 'desc' },
    include: {
      lines: true,
      plan: { include: { heads: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!allocation || !allocation.plan) return EMPTY;

  const heads = (allocation.plan.heads || []).map(headToPure);
  const pureAllocation = (allocation.lines || []).map((l) => ({
    headId: l.headId,
    annualAmountMinor: rupeesToMinor(l.annualAmountRupees),
  }));

  // The FBP window (purpose discriminator) drives the declared→verified deadline.
  const window = await resolveWindow({ businessId, financialYear, purpose: 'FBP_ALLOCATION', db });

  // FBP proofs (the bill-backed heads) for this employee+FY — the verified truth.
  const proofs = await db.investmentProof.findMany({
    where: {
      businessId, employeeId, financialYear, deletedAt: null, status: 'ACCEPTED',
      claimType: { in: ['FBP_LTA', 'FBP_FUEL', 'FBP_TELEPHONE', 'FBP_BOOKS', 'FBP_PROF_DEV', 'FBP_UNIFORM'] },
    },
    select: { claimType: true, verifiedAmount: true, status: true, deletedAt: true },
  });

  const result = computeFbpExempt({ heads, allocation: pureAllocation, proofs, window, asOf, regime });
  return { ...result, hasAllocation: true };
}

module.exports = { resolveFbpExempt, _internal: { headToPure, rupeesToMinor } };

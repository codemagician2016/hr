'use strict';

/**
 * proofAggregator.js — Feature 20, the PURE (DB-free) verified-amount engine.
 *
 * Given the employee's DECLARED column (minor units) and their list of proofs for a
 * claim type, returns the amount the TDS engine should use. The §201 rule:
 *
 *   useVerified === false (pre-deadline)  → declared (today's behaviour, provisional)
 *   useVerified === true  (on/after deadline) → min(declared, Σ ACCEPTED verifiedAmount)
 *
 * PENDING / REJECTED / soft-deleted proofs contribute ZERO. The verified Σ can never
 * EXCEED the declared aggregate (a fat-fingered over-verify can't inflate relief); the
 * statutory section caps (80C ₹1.5L, 24b ₹2L) are applied AFTER, by the existing engine
 * chapterVIADeductions — proofs only ever REDUCE below the declaration.
 *
 * Edge case 5 (PF auto-80C): the assembler derives employee PF from our own payslips
 * (derivePfAnnualMinor); that derived PF is ALWAYS "verified" (it's in our payslips, no
 * proof needed). Only the DECLARED-OVER-PF 80C portion needs a proof. The caller passes
 * `alwaysVerifiedMinor` (the derived PF for SEC_80C; 0 otherwise) and we floor the
 * verified Σ at it, so PF never drops out for want of an upload.
 *
 * All amounts are integer paise. No rounding drift — pure integer math.
 */

const { CLAIM_TYPE_META } = require('./claimTypes');

// Decimal|string|number → integer paise. Mirrors projectionAssembler.rupeesToMinor.
function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// A proof "counts" toward the verified Σ only when ACCEPTED, not soft-deleted, and it
// carries a non-null verifiedAmount.
function isCountable(p) {
  return p
    && p.status === 'ACCEPTED'
    && (p.deletedAt == null)
    && p.verifiedAmount != null;
}

/**
 * Σ ACCEPTED verifiedAmount (paise) for one claim type. PENDING/REJECTED/deleted → 0.
 * @param {Array} proofs   InvestmentProof rows (any claim type; we filter)
 * @param {string} claimType
 * @returns integer paise
 */
function sumAcceptedVerifiedMinor(proofs, claimType) {
  if (!Array.isArray(proofs)) return 0;
  let sum = 0;
  for (const p of proofs) {
    if (p && p.claimType === claimType && isCountable(p)) {
      sum += rupeesToMinor(p.verifiedAmount);
    }
  }
  return sum;
}

/**
 * The amount the engine should use for ONE section, given the switch.
 *
 * @param {object} args
 * @param {number} args.declaredMinor       the StatutoryProfile declared aggregate (paise)
 * @param {Array}  args.proofs              the employee's proofs (any type)
 * @param {string} args.claimType           SEC_80C | SEC_24B_HOME_LOAN | HRA_RENT | …
 * @param {boolean} args.useVerified        true on/after the proof deadline
 * @param {number} [args.alwaysVerifiedMinor=0]  auto-verified floor (e.g. derived PF for 80C)
 * @returns { usedMinor, declaredMinor, verifiedMinor, basis }
 */
function amountForSection({ declaredMinor, proofs, claimType, useVerified, alwaysVerifiedMinor = 0 }) {
  const declared = Math.max(0, Math.round(declaredMinor || 0));
  const floor = Math.max(0, Math.round(alwaysVerifiedMinor || 0));

  if (!useVerified) {
    // Pre-deadline: provisional. Used == declared; we still surface the verified Σ
    // (for the "X of declared is unverified" nudge) but it does NOT drive TDS yet.
    const verified = Math.min(declared, sumAcceptedVerifiedMinor(proofs, claimType) + floor);
    return { usedMinor: declared, declaredMinor: declared, verifiedMinor: verified, basis: 'DECLARED' };
  }

  // Post-deadline: verified-only. Σ ACCEPTED + auto-verified floor (PF), capped at declared.
  const rawVerified = sumAcceptedVerifiedMinor(proofs, claimType) + floor;
  const verified = Math.min(declared, rawVerified);
  return { usedMinor: verified, declaredMinor: declared, verifiedMinor: verified, basis: 'VERIFIED' };
}

/**
 * Whether the TDS engine should consume VERIFIED amounts as-of a date. True when a
 * window exists AND asOf >= its proofDeadline. No window → false (fail-open-provisional,
 * edge case 7 — a tenant that never set a window behaves exactly like today).
 *
 * @param {object|null} window  InvestmentDeclarationWindow row (or null)
 * @param {string} asOfIso      'YYYY-MM-DD'
 */
function shouldUseVerified(window, asOfIso) {
  if (!window || !window.proofDeadline) return false;
  const deadline = (window.proofDeadline instanceof Date)
    ? window.proofDeadline.toISOString().slice(0, 10)
    : String(window.proofDeadline).slice(0, 10);
  return String(asOfIso).slice(0, 10) >= deadline;
}

module.exports = {
  rupeesToMinor,
  isCountable,
  sumAcceptedVerifiedMinor,
  amountForSection,
  shouldUseVerified,
  _internals: { CLAIM_TYPE_META },
};

'use strict';

/**
 * fbpAggregator.js — Feature 25, the PURE (DB-free, integer-paise) FBP engine.
 * The twin of investmentProof/proofAggregator.js for the Flexi Benefit Plan basket.
 *
 * Two pure functions:
 *
 *   computeFbpSplit({ envelopeMinor, heads, allocation })
 *     → the ALLOCATION view: per-head { allocatedMinor, capMinor, exemptCeilingMinor }
 *       + the unallocated balance. Enforces the per-head statutory cap and the
 *       envelope ceiling (Σ allocation ≤ envelope). Used by the ESS slider preview
 *       and the over-allocation guard. (No proofs, no regime — pure shape.)
 *
 *   computeFbpExempt({ heads, allocation, proofs, window, asOf, regime })
 *     → the TAX view: { totalExemptMinor, basis, lines:[…] }. The exempt portion of
 *       each head = min(allocation, statutory cap, verified|declared spend), summed.
 *       This is the SINGLE number projectionAssembler subtracts from
 *       otherAllowancesMinor. The declared→verified flip is date-authoritative,
 *       identical to proofAggregator.amountForSection / shouldUseVerified:
 *         asOf <  proofDeadline → exempt on the DECLARED allocation (provisional)
 *         asOf >= proofDeadline → exempt only on Σ ACCEPTED verified bills
 *       Meal card (proofRequired:false) is ALWAYS verified (the card is the control)
 *       — passed through as the alwaysVerified floor exactly as PF auto-80C is in F20.
 *
 *   NEW regime → totalExemptMinor: 0 (§115BAC withdraws every special-allowance
 *   exemption; the basket still PAYS but is fully taxable). This mirrors the engine
 *   structurally zeroing Chapter VI-A under NEW.
 *
 * Caps come from the FbpPlanHead rows (data), NEVER hard-coded — a rule revision is
 * a data change. All amounts are integer paise; no rounding drift.
 *
 * `heads` shape (one per FbpPlanHead, from the plan):
 *   { id, headType, label, taxSection, claimType,
 *     annualCapMinor|null, monthlyCapMinor|null, minAllocMinor|null,
 *     proofRequired, exemptOldRegimeOnly, payCadence }
 * `allocation` shape: [{ headId, annualAmountMinor }]  (the employee's choices)
 * `proofs` shape: InvestmentProof-like rows [{ claimType, status, verifiedAmount, deletedAt }]
 */

// Decimal|string|number → integer paise. Mirrors proofAggregator.rupeesToMinor.
function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// The annual statutory ceiling for one head, in paise. A head may carry an annual
// cap and/or a monthly cap (the monthly cap × 12 is its annual equivalent); the
// EFFECTIVE annual cap is the tighter of the two. NULL/absent caps = no statutory
// ceiling (exempt only bounded by the allocation + actual spend).
function headAnnualCapMinor(head) {
  const annual = head.annualCapMinor != null ? Math.max(0, Math.round(head.annualCapMinor)) : null;
  const monthly = head.monthlyCapMinor != null ? Math.max(0, Math.round(head.monthlyCapMinor)) * 12 : null;
  if (annual == null && monthly == null) return null;
  if (annual == null) return monthly;
  if (monthly == null) return annual;
  return Math.min(annual, monthly);
}

// A proof "counts" toward the verified Σ only when ACCEPTED, not soft-deleted, with a
// non-null verifiedAmount. Identical predicate to proofAggregator.isCountable.
function isCountable(p) {
  return p
    && p.status === 'ACCEPTED'
    && (p.deletedAt == null)
    && p.verifiedAmount != null;
}

// Σ ACCEPTED verifiedAmount (paise) for one FBP claim type. PENDING/REJECTED/deleted → 0.
function sumAcceptedVerifiedMinor(proofs, claimType) {
  if (!Array.isArray(proofs) || !claimType) return 0;
  let sum = 0;
  for (const p of proofs) {
    if (p && p.claimType === claimType && isCountable(p)) {
      sum += rupeesToMinor(p.verifiedAmount);
    }
  }
  return sum;
}

/**
 * The ALLOCATION view — per-head ceilings + the over/under-allocation accounting.
 * Pure shape; no proofs, no regime. Drives the ESS slider preview + the server-side
 * over-allocation guard.
 *
 * @returns {
 *   envelopeMinor, allocatedTotalMinor, unallocatedMinor, overAllocated:boolean,
 *   lines: [{ headId, headType, label, taxSection,
 *             allocatedMinor, capMinor|null, exemptCeilingMinor,  // min(alloc, cap)
 *             overCapMinor }]   // alloc beyond the cap (pays but never exempt)
 * }
 */
function computeFbpSplit({ envelopeMinor = 0, heads = [], allocation = [] } = {}) {
  const envelope = Math.max(0, Math.round(envelopeMinor || 0));
  const byHead = new Map();
  for (const a of allocation || []) {
    if (!a || !a.headId) continue;
    const amt = Math.max(0, Math.round(a.annualAmountMinor || 0));
    byHead.set(a.headId, (byHead.get(a.headId) || 0) + amt);
  }

  let allocatedTotalMinor = 0;
  const lines = [];
  for (const head of heads || []) {
    const allocatedMinor = byHead.get(head.id) || 0;
    allocatedTotalMinor += allocatedMinor;
    const capMinor = headAnnualCapMinor(head);
    // The exempt CEILING (before proofs/regime) = min(allocation, statutory cap).
    const exemptCeilingMinor = capMinor == null ? allocatedMinor : Math.min(allocatedMinor, capMinor);
    const overCapMinor = Math.max(0, allocatedMinor - exemptCeilingMinor);
    lines.push({
      headId: head.id,
      headType: head.headType,
      label: head.label,
      taxSection: head.taxSection || null,
      allocatedMinor,
      capMinor,
      exemptCeilingMinor,
      overCapMinor,
    });
  }

  const unallocatedMinor = envelope - allocatedTotalMinor;
  return {
    envelopeMinor: envelope,
    allocatedTotalMinor,
    unallocatedMinor, // may be negative iff over-allocated
    overAllocated: allocatedTotalMinor > envelope,
    lines,
  };
}

/**
 * Whether the exemption should use VERIFIED bills as-of a date. True when a window
 * exists AND asOf >= its proofDeadline. No window → false (fail-open-provisional,
 * edge case 12 — a tenant with no FBP window behaves as DECLARED). Re-implemented
 * here (not imported) to keep this module DB- and dependency-free; byte-identical
 * to proofAggregator.shouldUseVerified.
 */
function shouldUseVerified(window, asOfIso) {
  if (!window || !window.proofDeadline) return false;
  const deadline = (window.proofDeadline instanceof Date)
    ? window.proofDeadline.toISOString().slice(0, 10)
    : String(window.proofDeadline).slice(0, 10);
  return String(asOfIso).slice(0, 10) >= deadline;
}

/**
 * The TAX view — the single exempt total + the per-head breakdown.
 *
 * @param {object} args
 * @param {Array}  args.heads        FbpPlanHead-derived rows (see file header)
 * @param {Array}  args.allocation   [{ headId, annualAmountMinor }]
 * @param {Array}  args.proofs       InvestmentProof-like FBP rows (any claim type; we filter)
 * @param {object|null} args.window  the FBP_ALLOCATION window (or null)
 * @param {string} args.asOf         'YYYY-MM-DD'
 * @param {string} args.regime       'OLD' | 'NEW'
 * @returns { totalExemptMinor, basis:'DECLARED'|'VERIFIED', lines:[
 *   { headId, headType, label, taxSection, claimType,
 *     allocatedMinor, capMinor, declaredMinor, verifiedMinor, exemptMinor,
 *     basis, proofRequired, unverifiedMinor } ]
 * }
 */
function computeFbpExempt({ heads = [], allocation = [], proofs = [], window = null, asOf, regime = 'OLD' } = {}) {
  const useVerified = shouldUseVerified(window, asOf);
  const basis = useVerified ? 'VERIFIED' : 'DECLARED';
  const isOld = String(regime || '').toUpperCase() === 'OLD';

  const byHead = new Map();
  for (const a of allocation || []) {
    if (!a || !a.headId) continue;
    const amt = Math.max(0, Math.round(a.annualAmountMinor || 0));
    byHead.set(a.headId, (byHead.get(a.headId) || 0) + amt);
  }

  let totalExemptMinor = 0;
  const lines = [];
  for (const head of heads || []) {
    const allocatedMinor = byHead.get(head.id) || 0;
    const capMinor = headAnnualCapMinor(head);
    // The declared ceiling = min(allocation, statutory cap). This is the most that
    // can ever be exempt for this head (before proofs).
    const declaredCeilingMinor = capMinor == null ? allocatedMinor : Math.min(allocatedMinor, capMinor);

    // The verified figure. The MEAL_CARD head (proofRequired:false) is the ONLY head
    // ALWAYS verified up to its declared ceiling — the card itself IS the control, so
    // no bills are needed (exactly the PF auto-80C treatment in F20). This floor MUST be
    // gated to MEAL_CARD: any OTHER proofRequired:false head (e.g. a FUEL_CAR authored
    // proof-free) would otherwise be fully exempt with ZERO uploaded bills AND survive the
    // post-deadline §192(2D)/§201 freeze (verifiedMinor would inherit the floor). All other
    // heads — proof-required or proof-free — earn their verified figure from Σ ACCEPTED bills
    // only, so the deadline control bites. validatePlan separately rejects proofRequired:false
    // on a non-MEAL_CARD head, but the engine fails safe regardless of how the head was authored.
    const alwaysVerifiedMinor =
      (head.proofRequired === false && head.headType === 'MEAL_CARD') ? declaredCeilingMinor : 0;
    const rawVerifiedMinor = sumAcceptedVerifiedMinor(proofs, head.claimType) + alwaysVerifiedMinor;
    // Verified can never exceed the declared ceiling (a double-uploaded bill can't
    // inflate relief): min(declaredCeiling, Σverified). Edge case 8.
    const verifiedMinor = Math.min(declaredCeilingMinor, rawVerifiedMinor);

    // The exempt figure for THIS head:
    //   NEW regime → 0 (§115BAC withdraws the exemption; the head still pays).
    //   OLD + pre-deadline  → the declared ceiling (provisional).
    //   OLD + on/after deadline → the verified figure only (§192(2D)/§201 control).
    let exemptMinor = 0;
    if (isOld) {
      exemptMinor = useVerified ? verifiedMinor : declaredCeilingMinor;
    }
    totalExemptMinor += exemptMinor;

    lines.push({
      headId: head.id,
      headType: head.headType,
      label: head.label,
      taxSection: head.taxSection || null,
      claimType: head.claimType || null,
      allocatedMinor,
      capMinor,
      declaredMinor: declaredCeilingMinor,
      verifiedMinor,
      exemptMinor,
      basis,
      proofRequired: head.proofRequired !== false,
      // The portion that is declared-but-unverified and so EXCLUDED post-deadline
      // (drives the loud anomaly + March-TDS-spike warning on the statement).
      unverifiedMinor: Math.max(0, declaredCeilingMinor - verifiedMinor),
    });
  }

  return { totalExemptMinor, basis, lines };
}

module.exports = {
  rupeesToMinor,
  headAnnualCapMinor,
  isCountable,
  sumAcceptedVerifiedMinor,
  shouldUseVerified,
  computeFbpSplit,
  computeFbpExempt,
};

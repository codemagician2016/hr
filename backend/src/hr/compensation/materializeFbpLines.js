'use strict';

/**
 * materializeFbpLines.js — Feature 25, Seam A. Explodes one resolved FBP ENVELOPE
 * (a single CTC earning line — the basket allowance) into N per-head monthly payslip
 * lines + a residual line, such that the Σ of the exploded lines === the envelope to
 * the PAISE. This is the same residual-reconciliation discipline deriveBreakup's
 * BALANCING line enforces, applied at the basket level (spec §6 Seam A / edge case 14).
 *
 * It is PURE + DB-free (integer paise). It does NOT call deriveBreakup or the engine;
 * it consumes the ALREADY-resolved envelope monthly amount (deriveBreakup is the
 * authority that produced it) and re-labels it into head components the run already
 * knows how to pay. engine.computePayslip is UNCHANGED — it just sees concrete lines
 * honouring isTaxable / category / proration per head.
 *
 * Critical invariants:
 *   1. Σ(head monthly minor) + residual monthly minor === envelope monthly minor.
 *      (Gross before == gross after explosion — golden-tested.)
 *   2. The envelope component itself is REPLACED by the heads + residual, so the
 *      assembler never sees the envelope AND the heads (no double-count).
 *   3. LTA (payCadence ON_CLAIM) emits NO monthly earning — it pays as a reimbursement
 *      on a verified travel claim. Its allocation stays in the residual? NO — an
 *      ON_CLAIM head's allocation is simply NOT materialized as a monthly line and
 *      is carved OUT of the envelope-to-explode so it is not double-paid; it pays
 *      on claim. The residual is the leftover after the MONTHLY heads only.
 *   4. Each head allocation is clamped to the envelope: if Σ alloc > envelope (a CTC
 *      cut shrank the envelope), heads are clamped pro-rata so the residual ≥ 0
 *      (edge case 11). Under-allocation → the unallocated balance is the residual
 *      (fully-taxable special pay), never lost (edge case 2).
 *
 * @param {object} args
 * @param {number} args.envelopeMonthlyMinor   the resolved monthly amount of the
 *                                              envelope component (paise)
 * @param {Array}  args.heads   plan heads, each:
 *   { id, componentId, headType, isTaxable, taxSection, category,
 *     payCadence:'MONTHLY'|'ON_CLAIM', sortOrder }
 * @param {Array}  args.allocation  [{ headId, annualAmountMinor }] (the employee's choice)
 * @param {object} args.envelopeComponent  { id, category, isTaxable }  — the residual
 *                                          pays back as THIS component (the special pay)
 * @returns {{
 *   lines: Array<{ componentId, headId|null, headType|null,
 *                  monthlyMinor, annualMinor, isTaxable, taxSection,
 *                  category, payCadence, isResidual, sortOrder }>,
 *   sumMonthlyMinor, envelopeMonthlyMinor, residualMonthlyMinor,
 *   onClaimMonthlyMinor   // the Σ of ON_CLAIM heads carved out (paid on claim, not monthly)
 * }}
 */
function materializeFbpLines({ envelopeMonthlyMinor = 0, heads = [], allocation = [], envelopeComponent = {} } = {}) {
  const envMonthly = Math.max(0, Math.round(envelopeMonthlyMinor || 0));

  // Allocation by head (annual paise → monthly paise via integer division; the
  // 12-month rounding remainder is absorbed into the residual so Σ is exact).
  const allocByHead = new Map();
  for (const a of allocation || []) {
    if (!a || !a.headId) continue;
    allocByHead.set(a.headId, Math.max(0, Math.round(a.annualAmountMinor || 0)));
  }

  // First pass: monthly minor per head (floor), split MONTHLY vs ON_CLAIM. We only
  // materialize MONTHLY heads as earning lines; ON_CLAIM heads (LTA) are carved out.
  const monthlyHeads = [];
  let monthlyAllocSumMinor = 0; // Σ monthly-cadence head MONTHLY amounts
  let onClaimMonthlyMinor = 0;  // Σ on-claim head MONTHLY equivalents (carved out)
  for (const head of heads || []) {
    const annualMinor = allocByHead.get(head.id) || 0;
    if (annualMinor <= 0) continue;
    // Monthly = floor(annual / 12); the remainder rides the residual (exact Σ).
    const monthlyMinor = Math.floor(annualMinor / 12);
    if (head.payCadence === 'ON_CLAIM') {
      onClaimMonthlyMinor += monthlyMinor;
      continue; // LTA-on-claim: no monthly earning line
    }
    monthlyHeads.push({ head, monthlyMinor });
    monthlyAllocSumMinor += monthlyMinor;
  }

  // The pool the MONTHLY heads draw from = envelope minus the on-claim carve-out
  // (on-claim pays separately on a verified claim, not from the monthly envelope).
  const monthlyPoolMinor = Math.max(0, envMonthly - onClaimMonthlyMinor);

  // Clamp: if the MONTHLY heads sum to more than the monthly pool (a CTC cut shrank
  // the envelope below an existing allocation, edge case 11), clamp each head
  // pro-rata so the residual never goes negative. Largest-remainder keeps Σ exact.
  let scaledHeads = monthlyHeads;
  if (monthlyAllocSumMinor > monthlyPoolMinor && monthlyAllocSumMinor > 0) {
    const scaled = monthlyHeads.map((h) => {
      const exact = (h.monthlyMinor * monthlyPoolMinor) / monthlyAllocSumMinor;
      const floorMinor = Math.floor(exact);
      return { head: h.head, monthlyMinor: floorMinor, frac: exact - floorMinor };
    });
    let distributed = scaled.reduce((s, h) => s + h.monthlyMinor, 0);
    let remainder = monthlyPoolMinor - distributed; // ≥ 0 paise to hand out
    const order = [...scaled].sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < order.length && remainder > 0; i += 1) {
      order[i].monthlyMinor += 1;
      remainder -= 1;
    }
    scaledHeads = scaled;
    monthlyAllocSumMinor = monthlyPoolMinor;
  }

  // Build the head lines.
  const lines = [];
  for (const { head, monthlyMinor } of scaledHeads) {
    if (monthlyMinor <= 0) continue;
    lines.push({
      componentId: head.componentId,
      headId: head.id,
      headType: head.headType,
      monthlyMinor,
      annualMinor: monthlyMinor * 12,
      isTaxable: head.isTaxable !== false,
      taxSection: head.taxSection || null,
      category: head.category || 'EARNING',
      payCadence: head.payCadence || 'MONTHLY',
      isResidual: false,
      sortOrder: head.sortOrder != null ? head.sortOrder : 0,
    });
  }

  // The residual = monthly pool minus the materialized monthly heads. This is the
  // unallocated balance (fully-taxable special pay) PLUS the 12-month rounding
  // remainders — so Σ(head monthly) + residual === monthly pool, and
  // Σ(head monthly) + residual + onClaim === envelope monthly. Exact to the paise.
  const residualMonthlyMinor = Math.max(0, monthlyPoolMinor - monthlyAllocSumMinor);
  if (residualMonthlyMinor > 0) {
    lines.push({
      componentId: envelopeComponent.id || null,
      headId: null,
      headType: null,
      monthlyMinor: residualMonthlyMinor,
      annualMinor: residualMonthlyMinor * 12,
      // The residual is the leftover special-pay envelope — taxable like any allowance.
      isTaxable: envelopeComponent.isTaxable !== false,
      taxSection: null,
      category: envelopeComponent.category || 'EARNING',
      payCadence: 'MONTHLY',
      isResidual: true,
      sortOrder: 9999,
    });
  }

  const sumMonthlyMinor = lines
    .filter((l) => (l.payCadence || 'MONTHLY') === 'MONTHLY')
    .reduce((s, l) => s + l.monthlyMinor, 0);

  return {
    lines,
    sumMonthlyMinor,             // Σ of materialized MONTHLY lines (heads + residual)
    envelopeMonthlyMinor: envMonthly,
    residualMonthlyMinor,
    onClaimMonthlyMinor,
  };
}

module.exports = { materializeFbpLines };

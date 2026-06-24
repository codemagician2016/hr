'use strict';

/**
 * fbpPlan.js — Feature 25, the FBP PLAN definition logic (pure): the India template
 * seed (the standard seven basket heads + default statutory caps) and validatePlan
 * (one envelope, head↔component, no duplicate headType, caps ≥ 0). CTC-agnostic —
 * it defines RULES (caps/sections/proof), never a person's allocation. India-only.
 *
 * ALL caps are stored as plan-head DATA (never hard-coded in the engine), so a CBDT
 * rule revision is a data change. The template below is the convenient default a HR
 * admin starts from and can override per head.
 */

// The seven standard India FBP heads with their statutory hook + default cap +
// proof requirement (spec §1 table). Caps in ₹ (annual unless `monthlyCapRupees`).
// `claimType` is the F20 proof claim type the head's bills upload as (null = no proof).
const IN_FBP_HEAD_TEMPLATE = Object.freeze([
  {
    headType: 'LTA',
    label: 'Leave Travel Allowance (LTA)',
    taxSection: '10(5)',
    annualCapRupees: null, // bounded by actual fare + the allocation; block-of-4 advisory
    monthlyCapRupees: null,
    proofRequired: true,
    payCadence: 'ON_CLAIM', // LTA pays on a verified travel claim, not monthly
    claimType: 'FBP_LTA',
    sortOrder: 0,
    tooltip: 'Tax-free against travel bills, twice in the 2022–2025 block (air-economy / AC-1st-rail, domestic, self + family).',
  },
  {
    headType: 'MEAL_CARD',
    label: 'Meal Card (Sodexo / Zaggle)',
    taxSection: '3(7)(iii)',
    annualCapRupees: 26400, // ₹2,200/mo × 12
    monthlyCapRupees: 2200, // ₹50/meal × 2 meals × 22 working days
    proofRequired: false, // the card IS the control — always "verified"
    payCadence: 'MONTHLY',
    claimType: null,
    sortOrder: 1,
    tooltip: '₹2,200/month is tax-free (₹50 per meal, ~2 meals × 22 days). The card itself is the proof.',
  },
  {
    headType: 'FUEL_CAR',
    label: 'Fuel + Car / Driver',
    taxSection: '3(2)',
    annualCapRupees: null,
    monthlyCapRupees: 2700, // Rule 3(2) slab: ₹1,800 (≤1.6L) + ₹900 driver (configurable to ₹2,400 for >1.6L)
    proofRequired: true,
    payCadence: 'MONTHLY',
    claimType: 'FBP_FUEL',
    sortOrder: 2,
    tooltip: 'Exempt to the Rule 3(2) slab (₹1,800/₹2,400 by engine size + ₹900 driver) against fuel bills + a logbook of official use.',
  },
  {
    headType: 'TELEPHONE_INTERNET',
    label: 'Telephone & Internet',
    taxSection: '3(7)(ix)',
    annualCapRupees: null,
    monthlyCapRupees: null, // exempt to actual reasonable, against bills
    proofRequired: true,
    payCadence: 'MONTHLY',
    claimType: 'FBP_TELEPHONE',
    sortOrder: 3,
    tooltip: 'Reimbursement of mobile + broadband for official use is tax-free against bills in your name.',
  },
  {
    headType: 'BOOKS_PERIODICALS',
    label: 'Books & Periodicals',
    taxSection: '10(14)',
    annualCapRupees: null,
    monthlyCapRupees: null,
    proofRequired: true,
    payCadence: 'MONTHLY',
    claimType: 'FBP_BOOKS',
    sortOrder: 4,
    tooltip: 'Reimbursement of books / journals for official use is exempt to actual expenditure, against purchase bills.',
  },
  {
    headType: 'PROF_DEV',
    label: 'Professional Development',
    taxSection: '10(14)',
    annualCapRupees: null,
    monthlyCapRupees: null,
    proofRequired: true,
    payCadence: 'MONTHLY',
    claimType: 'FBP_PROF_DEV',
    sortOrder: 5,
    tooltip: 'Course / certification fees relevant to your role are exempt to actual, against the invoice.',
  },
  {
    headType: 'UNIFORM',
    label: 'Uniform Allowance',
    taxSection: '10(14)',
    annualCapRupees: null,
    monthlyCapRupees: null,
    proofRequired: true,
    payCadence: 'MONTHLY',
    claimType: 'FBP_UNIFORM',
    sortOrder: 6,
    tooltip: 'Allowance for purchase / upkeep of on-duty uniform is exempt to actual expenditure, against bills.',
  },
]);

// The set of headTypes that may carry a bill claim type (proof-required heads).
const FBP_HEAD_TYPES = Object.freeze([
  'LTA', 'MEAL_CARD', 'FUEL_CAR', 'TELEPHONE_INTERNET',
  'BOOKS_PERIODICALS', 'PROF_DEV', 'UNIFORM', 'OTHER',
]);

/**
 * The India template for the plan builder's "Start from India template" button.
 * Returns the standard heads (the caller binds each headType to a SalaryComponent).
 */
function indiaFbpHeadTemplate() {
  return IN_FBP_HEAD_TEMPLATE.map((h) => ({ ...h }));
}

/**
 * validatePlan — pure structural validation of a plan-create/replace payload.
 * Enforces: exactly one envelope component; every head bound to a component; no
 * duplicate headType; caps ≥ 0; a proof-free head with a claim type is rejected;
 * ONLY MEAL_CARD may be proof-free (the card is its own control); and every
 * proof-free head MUST carry a finite statutory cap (it is exempt without bills, so
 * the cap is the only bound). Returns { ok:true } or { ok:false, code, message }.
 *
 * @param {object} plan
 *   { envelopeComponentId, heads:[{ headType, componentId, annualCapRupees?,
 *     monthlyCapRupees?, minAllocRupees?, proofRequired?, payCadence?, claimType? }] }
 */
function validatePlan(plan = {}) {
  if (!plan.envelopeComponentId) {
    return { ok: false, code: 'FBP_NO_ENVELOPE', message: 'A plan must have exactly one envelope component (the CTC line that funds the basket).' };
  }
  const heads = Array.isArray(plan.heads) ? plan.heads : [];
  if (heads.length === 0) {
    return { ok: false, code: 'FBP_NO_HEADS', message: 'A plan must have at least one basket head.' };
  }

  const seen = new Set();
  for (const h of heads) {
    if (!h || !h.headType || !FBP_HEAD_TYPES.includes(h.headType)) {
      return { ok: false, code: 'FBP_BAD_HEAD_TYPE', message: `Unknown FBP head type: ${h && h.headType}.` };
    }
    if (h.headType !== 'OTHER' && seen.has(h.headType)) {
      return { ok: false, code: 'FBP_DUP_HEAD', message: `Duplicate head type ${h.headType}; each statutory head may appear once.` };
    }
    seen.add(h.headType);

    if (!h.componentId) {
      return { ok: false, code: 'FBP_HEAD_NO_COMPONENT', message: `Head ${h.headType} must be bound to a pay component.` };
    }
    // The envelope must not also be a head (it would double-count — it's replaced by
    // the heads + residual at materialization, edge case 14).
    if (h.componentId === plan.envelopeComponentId) {
      return { ok: false, code: 'FBP_HEAD_IS_ENVELOPE', message: `Head ${h.headType} cannot use the envelope component itself.` };
    }

    for (const capKey of ['annualCapRupees', 'monthlyCapRupees', 'minAllocRupees']) {
      const v = h[capKey];
      if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
        return { ok: false, code: 'FBP_BAD_CAP', message: `Head ${h.headType} has an invalid ${capKey} (must be ≥ 0).` };
      }
    }
    if (h.payCadence && !['MONTHLY', 'ON_CLAIM'].includes(h.payCadence)) {
      return { ok: false, code: 'FBP_BAD_CADENCE', message: `Head ${h.headType} has an invalid pay cadence.` };
    }
    // A proof-required head SHOULD carry a claim type so bills can upload; meal card
    // (proofRequired:false) must NOT (the card is the control). Soft constraint:
    // proof-required + no claimType is allowed (HR may verify out-of-band), but a
    // proof-free head with a claimType is a contradiction.
    if (h.proofRequired === false && h.claimType) {
      return { ok: false, code: 'FBP_PROOFFREE_WITH_CLAIM', message: `Head ${h.headType} is proof-free but has a bill claim type.` };
    }
    // A proof-free head is exempt with NO uploaded bills (the engine's alwaysVerified
    // floor), so MEAL_CARD is the only head allowed to be proof-free — the card itself is
    // the §17(2)/3(7)(iii) control. Any OTHER head authored proofRequired:false would be
    // fully exempt with zero substantiation and survive the §201 deadline. Reject it.
    if (h.proofRequired === false && h.headType !== 'MEAL_CARD') {
      return { ok: false, code: 'FBP_PROOFFREE_NOT_MEAL', message: `Head ${h.headType} cannot be proof-free; only the meal card is its own control.` };
    }
    // A proof-free (exempt-without-bills) head MUST carry a finite statutory cap — its
    // exemption is bounded ONLY by the cap (there are no bills to cap it). Without one the
    // declared ceiling is the full allocation and the head becomes an uncapped, proof-free,
    // fully-exempt allowance (the ₹2,200/mo meal cap is silently droppable by omission).
    // Require a finite annual OR monthly cap on every proof-free head.
    const annualCapNum = h.annualCapRupees != null ? Number(h.annualCapRupees) : null;
    const monthlyCapNum = h.monthlyCapRupees != null ? Number(h.monthlyCapRupees) : null;
    const hasFiniteCap =
      (annualCapNum != null && Number.isFinite(annualCapNum) && annualCapNum > 0) ||
      (monthlyCapNum != null && Number.isFinite(monthlyCapNum) && monthlyCapNum > 0);
    if (h.proofRequired === false && !hasFiniteCap) {
      return { ok: false, code: 'FBP_PROOFFREE_NO_CAP', message: `Head ${h.headType} is proof-free and must carry a statutory cap (annual or monthly).` };
    }
  }
  return { ok: true };
}

module.exports = {
  IN_FBP_HEAD_TEMPLATE,
  FBP_HEAD_TYPES,
  indiaFbpHeadTemplate,
  validatePlan,
};

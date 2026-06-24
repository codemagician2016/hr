'use strict';

/**
 * claimTypes.js — Feature 20. The single source of truth that maps a proof's
 * ProofClaimType (the enum on InvestmentProof) ↔ the StatutoryProfile DECLARED
 * column it backs ↔ the engine's chapterVIA/HRA input field. This is the spine the
 * window-aware assembler (slice 20d) reconciles `min(declared, Σverified)` against.
 *
 * Every claim type is OLD-regime only (NEW structurally zeroes deductions/HRA — the
 * proof step is skipped under NEW, mirroring saveDeclaration's isOld gate). HRA_RENT
 * is the rent paid (drives §10(13A)); SEC_24B_HOME_LOAN drives §24(b); the 80x types
 * drive chapterVIA. OTHER_VIA is the extensible escape hatch (matches
 * StatutoryProfile.otherChapterVIADeclared) and is NOT yet consumed by the engine.
 */

// The ProofClaimType enum values (mirror prisma — writing a value outside this set
// makes Prisma 500; controllers reject with 422 instead).
const PROOF_CLAIM_TYPES = Object.freeze([
  'SEC_80C',
  'SEC_80D',
  'SEC_80CCD1B',
  'SEC_80TTA',
  'SEC_24B_HOME_LOAN',
  'HRA_RENT',
  'OTHER_VIA',
  // Feature 25 — FBP bill-backed heads. They ride the SAME upload/verify/SoD/cron
  // pipeline; the difference is they're consumed by fbpAggregator (against the
  // FbpAllocationLine), not by chapterVIA. Meal card is proof-free (no claim type).
  'FBP_LTA',
  'FBP_FUEL',
  'FBP_TELEPHONE',
  'FBP_BOOKS',
  'FBP_PROF_DEV',
  'FBP_UNIFORM',
]);

// Feature 25 — the FBP claim types (subset of the enum). Used to branch the proof
// controllers (FBP bills back an FbpAllocationLine head, not a StatutoryProfile
// column) and to filter the verified-spend rollup.
const FBP_CLAIM_TYPES = Object.freeze([
  'FBP_LTA',
  'FBP_FUEL',
  'FBP_TELEPHONE',
  'FBP_BOOKS',
  'FBP_PROF_DEV',
  'FBP_UNIFORM',
]);

const PROOF_STATUSES = Object.freeze(['PENDING', 'ACCEPTED', 'REJECTED']);
const WINDOW_STATUSES = Object.freeze(['DRAFT', 'OPEN', 'CLOSED', 'LOCKED']);

// claimType → { the StatutoryProfile declared column, a human label, whether the
// engine consumes it today }. `spField` is the DECLARED aggregate the verified Σ is
// capped against; `engineConsumed:false` types are retained but don't move TDS yet.
const CLAIM_TYPE_META = Object.freeze({
  SEC_80C: { spField: 'section80CDeclared', label: '80C investments (LIC/PPF/ELSS/principal…)', engineConsumed: true },
  SEC_80D: { spField: 'sec80DDeclared', label: '80D medical insurance premium', engineConsumed: true },
  SEC_80CCD1B: { spField: 'sec80CCD1BDeclared', label: '80CCD(1B) NPS additional', engineConsumed: true },
  SEC_80TTA: { spField: 'sec80TTADeclared', label: '80TTA savings-account interest', engineConsumed: true },
  SEC_24B_HOME_LOAN: { spField: 'sec24BHomeLoanInterest', label: '24(b) home-loan interest', engineConsumed: true },
  HRA_RENT: { spField: 'hraAnnualRentPaid', label: 'HRA — annual rent paid', engineConsumed: true },
  OTHER_VIA: { spField: 'otherChapterVIADeclared', label: 'Other Chapter VI-A', engineConsumed: false },
  // Feature 25 — FBP bill-backed heads. `fbp:true` routes them through fbpAggregator
  // (they back an FbpAllocationLine via its FbpPlanHead.headType, NOT a StatutoryProfile
  // column, so `spField` is null). `engineConsumed:true` — they DO move TDS (OLD-regime)
  // via the single computeFbpExempt subtraction in projectionAssembler. The verified Σ
  // is capped at the allocation + statutory cap (min(alloc, cap, Σverified)).
  FBP_LTA: { spField: null, label: 'FBP — LTA / travel (§10(5))', engineConsumed: true, fbp: true, headType: 'LTA' },
  FBP_FUEL: { spField: null, label: 'FBP — fuel + car / driver (Rule 3(2))', engineConsumed: true, fbp: true, headType: 'FUEL_CAR' },
  FBP_TELEPHONE: { spField: null, label: 'FBP — telephone & internet (Rule 3(7)(ix))', engineConsumed: true, fbp: true, headType: 'TELEPHONE_INTERNET' },
  FBP_BOOKS: { spField: null, label: 'FBP — books & periodicals (§10(14))', engineConsumed: true, fbp: true, headType: 'BOOKS_PERIODICALS' },
  FBP_PROF_DEV: { spField: null, label: 'FBP — professional development (§10(14))', engineConsumed: true, fbp: true, headType: 'PROF_DEV' },
  FBP_UNIFORM: { spField: null, label: 'FBP — uniform (§10(14)(i)/Rule 2BB)', engineConsumed: true, fbp: true, headType: 'UNIFORM' },
});

// Feature 25 — FbpHeadType → its bill claim type (the inverse of CLAIM_TYPE_META.headType).
// MEAL_CARD + OTHER are intentionally absent (meal card is proof-free; OTHER has no
// statutory bill convention in v1). Used by the ESS upload UI + the verified rollup.
const HEAD_TYPE_TO_CLAIM_TYPE = Object.freeze({
  LTA: 'FBP_LTA',
  FUEL_CAR: 'FBP_FUEL',
  TELEPHONE_INTERNET: 'FBP_TELEPHONE',
  BOOKS_PERIODICALS: 'FBP_BOOKS',
  PROF_DEV: 'FBP_PROF_DEV',
  UNIFORM: 'FBP_UNIFORM',
});

function isFbpClaimType(v) {
  return typeof v === 'string' && FBP_CLAIM_TYPES.includes(v);
}

// Rule 26C — landlord PAN is mandatory when the ANNUAL rent claimed exceeds ₹1,00,000.
const HRA_LANDLORD_PAN_THRESHOLD_RUPEES = 100000;

// Loose PAN format (5 letters + 4 digits + 1 letter). India PAN is case-insensitive
// on entry; we upper-case before storing.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function isValidClaimType(v) {
  return typeof v === 'string' && PROOF_CLAIM_TYPES.includes(v);
}

module.exports = {
  PROOF_CLAIM_TYPES,
  FBP_CLAIM_TYPES,
  PROOF_STATUSES,
  WINDOW_STATUSES,
  CLAIM_TYPE_META,
  HEAD_TYPE_TO_CLAIM_TYPE,
  HRA_LANDLORD_PAN_THRESHOLD_RUPEES,
  PAN_RE,
  isValidClaimType,
  isFbpClaimType,
};

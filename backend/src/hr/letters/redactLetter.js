'use strict';

/**
 * redactLetter.js — READ-path compensation re-masking for issued letters.
 *
 * THE PROBLEM (Feature 9 review finding): a letter's persisted snapshot
 * (`mergeDataJson` = the resolved {{token}} values, `renderedBody` = the merged
 * letter text) is minted ONCE, at issue time, with the *issuer's* permissions.
 * When a comp-privileged HR-Admin issues a SALARY_PROOF / CONTRACT letter, those
 * columns carry the subject's ABSOLUTE salary in cleartext (₹12,00,000.00, basic,
 * gross, net …). mergeFields masks comp.* only at WRITE time; there is NO
 * re-masking on read. So a lower-privilege `canGenerateLetters`-only operator
 * (no canViewCompensation, e.g. a RANGE_ONLY Manager-band role) who reads the
 * snapshot back inherits the issuer's view and sees the exact figures.
 *
 * THE FIX: re-mask at the serialization boundary on EVERY read that surfaces the
 * snapshot. We never mutate the stored columns (they remain an immutable audit
 * record) — we redact a COPY just before responding.
 *
 * Authorization is driven off `effectiveCompVisibility(user)` (core/lib/rbac.js),
 * NOT the raw `canViewCompensation` boolean: only ABSOLUTE may see absolute money.
 * A RANGE_ONLY / SELF_ONLY / NONE viewer is redacted — the letters module offers
 * no banded rendering, so the only safe state for a non-ABSOLUTE viewer is masked.
 *
 * The comp-gated key set is derived READ-ONLY from mergeFields.CATALOG (the keys
 * whose spec.gatedBy === 'canViewCompensation'); the mask token is mergeFields.MASK.
 */

const { CATALOG, MASK } = require('./mergeFields');
const { effectiveCompVisibility } = require('../../core/lib/rbac');

// The comp-bearing catalog keys (comp.ctcAnnual, comp.basic, comp.hra,
// comp.grossMonthly, comp.netMonthly, comp.da, comp.specialAllowance, …).
// Computed once from the catalog — stays in lock-step with mergeFields.js without
// touching its exports/signature.
const COMP_GATED_KEYS = Object.freeze(
  Object.entries(CATALOG)
    .filter(([, spec]) => spec && spec.gatedBy === 'canViewCompensation')
    .map(([key]) => key)
);

// A viewer may see absolute money only at ABSOLUTE comp-visibility. RANGE_ONLY,
// SELF_ONLY and NONE are all redacted (a RANGE_ONLY actor must never resolve to
// absolute figures on any path — including this read-back).
function viewerSeesAbsoluteComp(user) {
  return effectiveCompVisibility(user) === 'ABSOLUTE';
}

// Mask every comp-gated key present in a mergeDataJson object → MASK. Returns a
// NEW object (never mutates the persisted snapshot). Non-object input passes
// through unchanged.
function redactMergeData(mergeDataJson) {
  if (!mergeDataJson || typeof mergeDataJson !== 'object') return mergeDataJson;
  const out = { ...mergeDataJson };
  for (const key of COMP_GATED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = MASK;
  }
  return out;
}

/**
 * Redact an IssuedLetter row for a given viewer, returning a SHALLOW COPY safe to
 * serialize. When the viewer is NOT comp-authorized (effectiveCompVisibility !==
 * ABSOLUTE):
 *   (a) every comp.* key in `mergeDataJson` is replaced with the mask, and
 *   (b) `renderedBody` is OMITTED entirely — the merged letter text bakes the same
 *       absolute figures into prose, and there is no cheap way to mask them in a
 *       free-text body. The actual letter remains available via the rendered PDF
 *       at /download (which was masked-at-render only if the issuer lacked view —
 *       /download is intentionally left as-is).
 * An ABSOLUTE viewer gets the row untouched.
 *
 * @param {Object} row   an IssuedLetter row (may include relations/snapshot)
 * @param {Object} user  req.user (drives effectiveCompVisibility)
 * @returns {Object} a copy of `row`, redacted as needed
 */
function redactLetterForViewer(row, user) {
  if (!row || typeof row !== 'object') return row;
  if (viewerSeesAbsoluteComp(user)) return row;

  const redacted = { ...row };
  if ('mergeDataJson' in redacted) {
    redacted.mergeDataJson = redactMergeData(redacted.mergeDataJson);
  }
  // Omit the resolved body — it carries the absolute figures in prose.
  if ('renderedBody' in redacted) delete redacted.renderedBody;
  return redacted;
}

module.exports = {
  redactLetterForViewer,
  redactMergeData,
  viewerSeesAbsoluteComp,
  COMP_GATED_KEYS,
};

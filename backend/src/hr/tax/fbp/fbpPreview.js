'use strict';

/**
 * fbpPreview.js — Feature 25, the PURE "tax you save" preview (the killer feature).
 * Given an envelope, the plan heads, and a candidate allocation, it returns the
 * per-head split (computeFbpSplit) PLUS the annual tax WITH vs WITHOUT the FBP
 * exemption — by calling the SAME projectAnnualIncomeTax engine twice, so the
 * preview matches the real projection to the paise. No persist; drives both the
 * ESS slider live impact and the admin plan preview.
 *
 * It needs a small salary CONTEXT (the rest of the employee's annual earnings) to
 * compute a meaningful tax delta. The caller supplies it from the resolved comp /
 * the projection statement; we keep this module DB-free and engine-pure.
 */

const IN = require('../../payroll/compliance/india.js');
const { computeFbpSplit } = require('./fbpAggregator');

const { projectAnnualIncomeTax } = IN._internals;

function toRupees(minor) { return Math.round(minor) / 100; }

/**
 * @param {object} args
 * @param {number} args.envelopeMinor
 * @param {Array}  args.heads          pure head shape (with caps in paise)
 * @param {Array}  args.allocation     [{ headId, annualAmountMinor }]
 * @param {string} args.regime         'OLD' | 'NEW'
 * @param {object} args.salaryContext  the rest-of-salary engine input for the WITH/
 *   WITHOUT comparison. Shape mirrors projectAnnualIncomeTax input:
 *   { basicDaMinor, hraReceivedMinor, otherAllowancesMinor, residualChoicePayMinor,
 *     hraInput?, chapterVIAInput?, perquisitesInput?, prevEmployer?, hasPan? }
 *   The FBP envelope is assumed already inside otherAllowancesMinor (it pays as the
 *   special allowance pre-explosion), so WITHOUT-FBP = full otherAllowances and
 *   WITH-FBP = otherAllowances − Σ exempt. This matches the assembler seam exactly.
 * @returns {
 *   split, exemptMinor, taxWithoutMinor, taxWithMinor, taxSavedMinor,
 *   taxWithout, taxWith, taxSaved   // rupees
 * }
 */
function previewFbp({ envelopeMinor = 0, heads = [], allocation = [], regime = 'OLD', salaryContext = {} } = {}) {
  const split = computeFbpSplit({ envelopeMinor, heads, allocation });

  // The exempt total for the preview = Σ per-head exempt CEILING (declared basis —
  // the provisional "what you'd save if you allocate this"), regime-gated. NEW → 0.
  const isOld = String(regime || '').toUpperCase() === 'OLD';
  const exemptMinor = isOld ? split.lines.reduce((s, l) => s + l.exemptCeilingMinor, 0) : 0;

  const sc = salaryContext || {};
  const baseEarnings = {
    basicDaMinor: Math.max(0, Math.round(sc.basicDaMinor || 0)),
    hraReceivedMinor: Math.max(0, Math.round(sc.hraReceivedMinor || 0)),
    otherAllowancesMinor: Math.max(0, Math.round(sc.otherAllowancesMinor || 0)),
    residualChoicePayMinor: Math.max(0, Math.round(sc.residualChoicePayMinor || 0)),
  };

  function taxFor(otherAllowancesMinor) {
    const r = projectAnnualIncomeTax({
      regime: isOld ? 'OLD' : 'NEW',
      annualEarnings: { ...baseEarnings, otherAllowancesMinor },
      perquisitesInput: sc.perquisitesInput || null,
      hraInput: isOld ? (sc.hraInput || null) : null,
      chapterVIAInput: isOld ? (sc.chapterVIAInput || null) : null,
      prevEmployer: sc.prevEmployer || {},
      hasPan: sc.hasPan !== false,
    });
    return r.totalAnnualTaxMinor;
  }

  const taxWithoutMinor = taxFor(baseEarnings.otherAllowancesMinor);
  const taxWithMinor = taxFor(Math.max(0, baseEarnings.otherAllowancesMinor - exemptMinor));
  const taxSavedMinor = Math.max(0, taxWithoutMinor - taxWithMinor);

  return {
    split,
    exemptMinor,
    exempt: toRupees(exemptMinor),
    taxWithoutMinor, taxWithMinor, taxSavedMinor,
    taxWithout: toRupees(taxWithoutMinor),
    taxWith: toRupees(taxWithMinor),
    taxSaved: toRupees(taxSavedMinor),
  };
}

module.exports = { previewFbp };

'use strict';

/**
 * filing — PURE statutory file generators (no DB, no I/O).
 *
 * Each generator takes a pay-run aggregate (per-employee statutory amounts in
 * integer minor units) and returns { fileName, contentType, meta, content }.
 *
 *   India  (docs/05-compliance-india.md §4.6/§5/§7.4/§12.4):
 *     generateEcr   — EPFO ECR (#~# pipe-delimited member lines)
 *     generateEsic  — ESIC monthly contribution CSV
 *     generate24Q   — Form 24Q/138 quarterly TDS (FVU-oriented flat file)
 *
 *   New Zealand (docs/06-compliance-newzealand.md §3.2; docs/18 §3.3):
 *     generateEmploymentInformation — IRD payday-filing EI dataset (CSV)
 *     generateBankBatch             — NZ direct-credit bank batch (CSV + control)
 */

const india = require('./india');
const newzealand = require('./newzealand');

module.exports = {
  india,
  newzealand,

  // India
  generateEcr: india.generateEcr,
  generateEsic: india.generateEsic,
  generate24Q: india.generate24Q,

  // New Zealand
  generateEmploymentInformation: newzealand.generateEmploymentInformation,
  generateBankBatch: newzealand.generateBankBatch,
};

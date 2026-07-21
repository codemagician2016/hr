'use strict';

/**
 * meta.routes.js — Program P1.7: ONE enum-vocabulary endpoint for every HR
 * dropdown, so frontends stop hardcoding (and drifting from) Prisma enums —
 * the recruitment page had TEMPORARY (not in the schema) and was missing three
 * real employment types. Values mirror backend/prisma/schema.prisma; when an
 * enum changes there, change it HERE in the same commit.
 *
 *   GET /api/hr/meta          (operator session)
 *   GET /api/hr/me/meta       (ESS customer session — same payload)
 */

const express = require('express');
const { protect, requireCustomer } = require('../../core/middleware/auth.middleware');

// ── the vocabulary (schema.prisma is the source of truth) ────────────────────
const META = Object.freeze({
  genders: ['MALE', 'FEMALE', 'NON_BINARY', 'UNDISCLOSED', 'OTHER'],
  maritalStatuses: ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED', 'CIVIL_UNION', 'UNDISCLOSED'],
  employmentTypes: ['FULL_TIME', 'PART_TIME', 'FIXED_TERM', 'CONTRACT', 'INTERN', 'APPRENTICE', 'CASUAL', 'CONSULTANT'],
  dependantRelations: ['SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER'],
  educationLevels: ['SCHOOL', 'DIPLOMA', 'BACHELORS', 'MASTERS', 'DOCTORATE', 'CERTIFICATION', 'OTHER'],
  separationTypes: ['RESIGNATION', 'TERMINATION_FOR_CAUSE', 'RETRENCHMENT', 'REDUNDANCY', 'END_OF_CONTRACT', 'RETIREMENT', 'DEATH', 'ABSCONDING', 'PROBATION_FAILURE', 'MUTUAL_SEPARATION'],
  documentCategories: ['ID_PROOF', 'ADDRESS_PROOF', 'PAN', 'AADHAAR', 'PASSPORT', 'VISA', 'WORK_PERMIT', 'EDUCATION', 'EXPERIENCE', 'OFFER_LETTER', 'CONTRACT', 'PAYSLIP_COPY', 'TAX_DECLARATION', 'FORM16', 'BANK_PROOF', 'MEDICAL', 'POLICY_ACK', 'OTHER'],
  holidayTypes: ['PUBLIC', 'NATIONAL', 'REGIONAL', 'COMPANY', 'RESTRICTED_OPTIONAL'],
  payoutBanks: ['HDFC', 'ICICI', 'AXIS', 'KOTAK', 'SBI', 'NEFT_RTGS'],
  addressTypes: ['CORRESPONDENCE', 'PERMANENT', 'OFFICE'],
});

function serveMeta(_req, res) {
  res.json(META);
}

const router = express.Router();
router.get('/meta', protect, serveMeta);
router.get('/me/meta', requireCustomer, serveMeta);

module.exports = { router, META };

'use strict';

/**
 * windowResolver.js — Feature 20. THE single helper that loads the
 * InvestmentDeclarationWindow for a tenant+FY (India). Used by the ESS upload gate,
 * the HR console, the assembler (the TDS switch), and the scheduler — one place so
 * "is the window open?" / "are we past the deadline?" can never diverge.
 *
 * Returns the window row or null (no window → fail-open-provisional, edge case 7).
 *
 * Feature 25 — `purpose` discriminator. Defaults to INVESTMENT_PROOF so EVERY
 * existing F20 caller resolves exactly the proof window as before; the FBP window
 * (purpose=FBP_ALLOCATION) is loaded by passing purpose explicitly.
 */

const prisma = require('../../../core/lib/prisma');

// Load the window for businessId+FY+purpose (IN). `db` threads a tx/test client.
async function resolveWindow({ businessId, financialYear, countryCode = 'IN', purpose = 'INVESTMENT_PROOF', db = prisma } = {}) {
  if (!businessId || !financialYear) return null;
  return db.investmentDeclarationWindow.findFirst({
    where: { businessId, financialYear, countryCode, purpose },
  });
}

module.exports = { resolveWindow };

'use strict';

/*
 * gradeRules.unit.test.js — Feature 45: per-JOB-LEVEL reimbursement caps in
 * policyEngine.evalCategory (via evaluateLine). Precedence: exact gradeRank
 * rule > all-levels (null-rank) rule > flat policy caps; null fields on the
 * winning rule fall back to the flat cap (partial overrides compose).
 *
 * Plain-node:  node backend/src/hr/expenses/__tests__/gradeRules.unit.test.js
 */

const assert = require('assert');
const { evaluateLine } = require('../policyEngine');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

const basePolicy = {
  maxPerClaim: 1000, maxPerMonth: 5000, dailyCap: null,
  requireReceipt: false, enforcement: 'HARD',
  gradeRules: [
    { gradeRank: null, maxPerClaim: 2000, maxPerMonth: null, dailyCap: null }, // all levels
    { gradeRank: 5, maxPerClaim: 8000, maxPerMonth: 20000, dailyCap: null }, // senior band
  ],
};
const line = (amount) => ({ amount, receiptUrl: 'r.jpg', expenseDate: '2026-08-01' });
const ctx = (gradeRank, extra = {}) => ({ categoryPolicy: basePolicy, gradeRank, monthToDate: 0, currencyCode: 'INR', ...extra });

/* junior (rank 2): all-levels rule (2000) overrides flat 1000 */
{
  const okV = evaluateLine(line(1500), ctx(2));
  ok('rank 2 @1500 under all-levels 2000 → OK', okV.verdict === 'OK');
  const over = evaluateLine(line(2500), ctx(2));
  ok('rank 2 @2500 over 2000 → AUTO_REJECTED (HARD)', over.verdict === 'AUTO_REJECTED' && over.appliedCap === 2000);
}

/* senior (rank 5): exact rule 8000 beats all-levels 2000 */
{
  const okV = evaluateLine(line(7000), ctx(5));
  ok('rank 5 @7000 under exact 8000 → OK', okV.verdict === 'OK');
  const over = evaluateLine(line(9000), ctx(5));
  ok('rank 5 @9000 over 8000 → rejected', over.verdict === 'AUTO_REJECTED' && over.appliedCap === 8000);
}

/* monthly: senior rule sets 20000; junior falls back to flat 5000 */
{
  const seniorMonthly = evaluateLine(line(1000), ctx(5, { monthToDate: 19500 }));
  ok('rank 5 monthly 19500+1000 > 20000 → rejected on monthly', seniorMonthly.verdict === 'AUTO_REJECTED' && seniorMonthly.appliedCap === 20000);
  const juniorMonthly = evaluateLine(line(100), ctx(2, { monthToDate: 4950 }));
  ok('rank 2 monthly falls back to FLAT 5000 (all-levels rule has null monthly)', juniorMonthly.verdict === 'AUTO_REJECTED' && juniorMonthly.appliedCap === 5000);
}

/* unknown grade (no rank): all-levels rule applies */
{
  const v = evaluateLine(line(2500), ctx(null));
  ok('no gradeRank → all-levels rule 2000 applies', v.verdict === 'AUTO_REJECTED' && v.appliedCap === 2000);
}

/* no grade rules at all → flat policy behaviour unchanged */
{
  const flat = { ...basePolicy, gradeRules: [] };
  const v = evaluateLine(line(1500), { categoryPolicy: flat, gradeRank: 5, monthToDate: 0 });
  ok('no rules → flat 1000 cap governs', v.verdict === 'AUTO_REJECTED' && v.appliedCap === 1000);
}

/* FLAG enforcement still soft with grade rules */
{
  const soft = { ...basePolicy, enforcement: 'FLAG' };
  const v = evaluateLine(line(2500), { categoryPolicy: soft, gradeRank: 2, monthToDate: 0, policy: { enforcement: 'FLAG' } });
  ok('FLAG enforcement → FLAGGED not rejected', v.verdict === 'FLAGGED');
}

console.log(`gradeRules.unit: ${passed} checks passed`);

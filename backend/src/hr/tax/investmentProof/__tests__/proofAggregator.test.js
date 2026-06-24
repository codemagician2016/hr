'use strict';

/*
 * proofAggregator.test.js — Feature 20 PURE (DB-free) unit test for the
 * verified-amount engine. Plain-node assert (no jest, no DB):
 *   node backend/src/hr/tax/investmentProof/__tests__/proofAggregator.test.js
 *
 * Covers the §201 switch math the whole feature hinges on:
 *   • pre-deadline  → used == declared (provisional)
 *   • post-deadline → used == min(declared, Σ ACCEPTED verifiedAmount)
 *   • PENDING / REJECTED / soft-deleted proofs → 0
 *   • verified can never exceed declared (fat-finger guard)
 *   • PF auto-80C floor is always "verified" (no proof needed)
 *   • shouldUseVerified: no window → false (fail-open-provisional); date boundary
 *
 * MONEY: integer paise. ₹1 = 100 paise.
 */

const assert = require('assert');
const {
  sumAcceptedVerifiedMinor, amountForSection, shouldUseVerified,
} = require('../proofAggregator');

const P = 100;
const R = (r) => r * P;

let passed = 0; let failed = 0;
const fails = [];
function eq(name, expected, actual) {
  try { assert.strictEqual(actual, expected); passed += 1; }
  catch (_e) { failed += 1; const m = `${name}: expected ${expected} got ${actual}`; fails.push(m); console.error(`FAIL ${m}`); }
}

// A proof factory.
const proof = (claimType, status, verifiedRupees, extra = {}) => ({
  claimType, status,
  verifiedAmount: verifiedRupees == null ? null : verifiedRupees, // rupees (Decimal-like)
  deletedAt: null,
  ...extra,
});

// ── 1. sumAcceptedVerifiedMinor — only ACCEPTED, non-deleted, non-null count ──
{
  const proofs = [
    proof('SEC_80C', 'ACCEPTED', 50000),
    proof('SEC_80C', 'ACCEPTED', 40000),
    proof('SEC_80C', 'PENDING', 30000),                 // ignored
    proof('SEC_80C', 'REJECTED', 20000),                // ignored
    proof('SEC_80C', 'ACCEPTED', 10000, { deletedAt: new Date() }), // soft-deleted → ignored
    proof('SEC_80C', 'ACCEPTED', null),                 // null verifiedAmount → ignored
    proof('SEC_80D', 'ACCEPTED', 99999),                // wrong claim type → ignored
  ];
  eq('Σ ACCEPTED 80C = 90k', R(90000), sumAcceptedVerifiedMinor(proofs, 'SEC_80C'));
  eq('Σ ACCEPTED 80D = 99,999', R(99999), sumAcceptedVerifiedMinor(proofs, 'SEC_80D'));
  eq('Σ ACCEPTED HRA = 0', 0, sumAcceptedVerifiedMinor(proofs, 'HRA_RENT'));
}

// ── 2. amountForSection — pre-deadline = DECLARED (provisional) ───────────────
{
  const proofs = [proof('SEC_80C', 'ACCEPTED', 90000)];
  const r = amountForSection({ declaredMinor: R(150000), proofs, claimType: 'SEC_80C', useVerified: false });
  eq('pre-deadline used == declared', R(150000), r.usedMinor);
  eq('pre-deadline basis DECLARED', 'DECLARED', r.basis);
  // verified Σ still surfaced (for the "X unverified" nudge) but not driving TDS.
  eq('pre-deadline verified surfaced', R(90000), r.verifiedMinor);
}

// ── 3. amountForSection — post-deadline = min(declared, Σ ACCEPTED) ───────────
{
  // declared 1.5L, only 90k verified → used 90k (the §201 control: 60k excluded).
  const proofs = [proof('SEC_80C', 'ACCEPTED', 90000)];
  const r = amountForSection({ declaredMinor: R(150000), proofs, claimType: 'SEC_80C', useVerified: true });
  eq('post-deadline used == 90k', R(90000), r.usedMinor);
  eq('post-deadline basis VERIFIED', 'VERIFIED', r.basis);
}

// ── 4. verified can NEVER exceed declared (fat-finger / double-count guard) ────
{
  const proofs = [proof('SEC_80C', 'ACCEPTED', 90000), proof('SEC_80C', 'ACCEPTED', 90000)]; // Σ=1.8L
  const r = amountForSection({ declaredMinor: R(150000), proofs, claimType: 'SEC_80C', useVerified: true });
  eq('post-deadline capped at declared', R(150000), r.usedMinor);
}

// ── 5. a REJECTED proof drops its amount entirely ─────────────────────────────
{
  const proofs = [proof('SEC_24B_HOME_LOAN', 'REJECTED', 200000)];
  const r = amountForSection({ declaredMinor: R(200000), proofs, claimType: 'SEC_24B_HOME_LOAN', useVerified: true });
  eq('rejected 24b → 0 used', 0, r.usedMinor);
}

// ── 6. PF auto-80C floor is always verified (no proof needed) ─────────────────
{
  // declared 1.5L, NO proofs, but PF 21,600 derived → post-deadline used == PF floor.
  const pf = R(21600);
  const r = amountForSection({ declaredMinor: R(150000), proofs: [], claimType: 'SEC_80C', useVerified: true, alwaysVerifiedMinor: pf });
  eq('post-deadline PF floor used', pf, r.usedMinor);
  // With proof on top: PF + verified, capped at declared.
  const r2 = amountForSection({ declaredMinor: R(150000), proofs: [proof('SEC_80C', 'ACCEPTED', 100000)], claimType: 'SEC_80C', useVerified: true, alwaysVerifiedMinor: pf });
  eq('post-deadline PF + 1L verified', R(121600), r2.usedMinor);
  // PF floor + big proof still capped at declared.
  const r3 = amountForSection({ declaredMinor: R(150000), proofs: [proof('SEC_80C', 'ACCEPTED', 150000)], claimType: 'SEC_80C', useVerified: true, alwaysVerifiedMinor: pf });
  eq('post-deadline capped even with PF floor', R(150000), r3.usedMinor);
}

// ── 7. shouldUseVerified — no window → false (fail-open-provisional) ──────────
{
  eq('no window → DECLARED', false, shouldUseVerified(null, '2027-03-01'));
  eq('window no deadline → DECLARED', false, shouldUseVerified({}, '2027-03-01'));
  const win = { proofDeadline: '2027-02-15' };
  eq('before deadline → DECLARED', false, shouldUseVerified(win, '2027-02-14'));
  eq('on deadline → VERIFIED', true, shouldUseVerified(win, '2027-02-15'));
  eq('after deadline → VERIFIED', true, shouldUseVerified(win, '2027-03-01'));
  // Date object proofDeadline (as Prisma returns).
  eq('Date deadline boundary', true, shouldUseVerified({ proofDeadline: new Date('2027-02-15T00:00:00Z') }, '2027-02-15'));
}

console.log(`\nFeature 20 proofAggregator test: ${passed} passed, ${failed} failed.`);
if (failed > 0) { console.error('Discrepancies:\n' + fails.join('\n')); process.exit(1); }

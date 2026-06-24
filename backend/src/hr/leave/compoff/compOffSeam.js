'use strict';

/**
 * compOffSeam.js — the comp-off lot side of the leave engine's ONE category-gated
 * seam (Feature 30 §4.3). The leave engine + ledger are byte-unchanged for every
 * other leave type; comp-off adds:
 *   - on the APPROVED transition of a COMP_OFF leave APPLICATION → debit the FIFO
 *     lots (oldest-expiry-first) so per-credit expiry stays honest.
 *   - on WITHDRAW of an approved COMP_OFF leave → re-credit the lots (un-burn),
 *     only for lots not yet expired (an expired lot's residual must never become
 *     spendable again — invariant 6).
 *
 * Both run INSIDE the caller's tx so the lot move commits atomically with the
 * balance move. The actual FIFO/LIFO math lives in the PURE compOffLots.js; this is
 * the thin persistence wrapper (load ACTIVE lots → allocate → version-locked update
 * → flip EXHAUSTED).
 */

const { allocateFromLots, reCreditToLots } = require('./compOffLots');

/**
 * isCompOffCategory(category) — the single gate. Everything below is a no-op unless
 * the leave type is COMP_OFF, so the seam is inert for all other types.
 */
function isCompOffCategory(category) {
  return category === 'COMP_OFF';
}

/**
 * debitLotsOnApprove(tx, { businessId, employeeId, units }) — burn `units` from the
 * employee's ACTIVE comp-off lots FIFO. Called on the COMP_OFF onApprove AFTER the
 * standard balance move. Each lot update is version-locked; a lot fully consumed
 * flips EXHAUSTED. Throws INSUFFICIENT_COMP_OFF when lots can't cover (the apply-time
 * validator + aggregate available() gate already prevent this; the throw is the belt).
 * Returns { allocations }.
 */
async function debitLotsOnApprove(tx, { businessId, employeeId, units }) {
  const u = Number(units);
  if (!(u > 0)) return { allocations: [] };
  const lots = await tx.compOffCredit.findMany({
    where: { businessId, employeeId, status: 'ACTIVE' },
    select: { id: true, quantity: true, consumed: true, earnedOn: true, expiresOn: true, version: true },
  });
  const { allocations } = allocateFromLots(lots, u);
  const byId = new Map(lots.map((l) => [l.id, l]));
  for (const a of allocations) {
    const lot = byId.get(a.lotId);
    await tx.compOffCredit.update({
      where: { id: a.lotId, version: lot.version },
      data: {
        consumed: a.newConsumed,
        ...(a.exhausts ? { status: 'EXHAUSTED' } : {}),
        version: { increment: 1 },
      },
    });
  }
  return { allocations };
}

/**
 * reCreditLotsOnWithdraw(tx, { businessId, employeeId, units, asOf }) — return
 * `units` to the lots they came from (un-burn) on WITHDRAW of an approved comp-off
 * leave (edge case 8). Only un-expired lots are eligible; a lot flipped back below
 * its quantity returns to ACTIVE (from EXHAUSTED). `forfeited` units (all candidate
 * lots expired) are dropped per the conservative default. Returns { allocations,
 * forfeited }.
 */
async function reCreditLotsOnWithdraw(tx, { businessId, employeeId, units, asOf = new Date() }) {
  const u = Number(units);
  if (!(u > 0)) return { allocations: [], forfeited: 0 };
  // Candidate lots: ones that were consumed and are still spendable (not EXPIRED/VOIDED).
  const lots = await tx.compOffCredit.findMany({
    where: { businessId, employeeId, status: { in: ['ACTIVE', 'EXHAUSTED'] }, consumed: { gt: 0 } },
    select: { id: true, quantity: true, consumed: true, earnedOn: true, expiresOn: true, version: true },
  });
  const { allocations, forfeited } = reCreditToLots(lots, u, { asOf });
  const byId = new Map(lots.map((l) => [l.id, l]));
  for (const a of allocations) {
    const lot = byId.get(a.lotId);
    await tx.compOffCredit.update({
      where: { id: a.lotId, version: lot.version },
      data: {
        consumed: a.newConsumed,
        // re-credited below quantity → it's spendable again → ACTIVE.
        status: 'ACTIVE',
        version: { increment: 1 },
      },
    });
  }
  return { allocations, forfeited };
}

module.exports = { isCompOffCategory, debitLotsOnApprove, reCreditLotsOnWithdraw };

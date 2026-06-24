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

const { allocateFromLots, reCreditAllocations } = require('./compOffLots');

/**
 * isCompOffCategory(category) — the single gate. Everything below is a no-op unless
 * the leave type is COMP_OFF, so the seam is inert for all other types.
 */
function isCompOffCategory(category) {
  return category === 'COMP_OFF';
}

/**
 * debitLotsOnApprove(tx, { businessId, employeeId, units, leaveTransactionId }) — burn
 * `units` from the employee's ACTIVE comp-off lots FIFO. Called on the COMP_OFF
 * onApprove AFTER the standard balance move. Each lot update is version-locked; a lot
 * fully consumed flips EXHAUSTED. Throws INSUFFICIENT_COMP_OFF when lots can't cover
 * (the apply-time validator + aggregate available() gate already prevent this; the
 * throw is the belt).
 *
 * Finding #5: PERSIST which lots this APPLICATION debited as CompOffConsumption rows
 * (keyed by leaveTransactionId) so withdraw can re-credit EXACTLY these lots — not
 * arbitrary reverse-FIFO ones. Returns { allocations }.
 */
async function debitLotsOnApprove(tx, { businessId, employeeId, units, leaveTransactionId = null }) {
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
    // Persist the per-application allocation (finding #5). Upsert keeps it idempotent
    // if onApprove is ever re-fired for the same (application, lot).
    if (leaveTransactionId) {
      await tx.compOffConsumption.upsert({
        where: { leaveTransactionId_compOffCreditId: { leaveTransactionId, compOffCreditId: a.lotId } },
        update: { units: a.take, reversedAt: null },
        create: { businessId, leaveTransactionId, compOffCreditId: a.lotId, units: a.take },
      });
    }
  }
  return { allocations };
}

/**
 * reCreditLotsOnWithdraw(tx, { businessId, leaveTransactionId, asOf }) — on WITHDRAW of
 * an approved comp-off leave (edge case 8), return the units this leave debited to the
 * EXACT lots it took them from (finding #5), reading the persisted CompOffConsumption
 * allocation. Only un-expired lots are eligible; a lot flipped back below its quantity
 * returns to ACTIVE (from EXHAUSTED). Units whose source lot has since expired are
 * `forfeited` — NOT re-credited to any lot (invariant 6) AND signalled back so the
 * caller drops them from the aggregate too (finding #1 — closing must never exceed
 * Σ active-lot remaining). Idempotent: an already-reversed row (reversedAt set) is
 * skipped, so a double-withdraw can't double-restore.
 *
 * Returns { moves, forfeited, applied } where `applied` is the units actually returned
 * to lots (= debited − forfeited − already-reversed).
 */
async function reCreditLotsOnWithdraw(tx, { businessId, leaveTransactionId, asOf = new Date() }) {
  if (!leaveTransactionId) return { moves: [], forfeited: 0, applied: 0 };
  // The lots THIS leave actually debited (and not yet reversed).
  const rows = await tx.compOffConsumption.findMany({
    where: { businessId, leaveTransactionId, reversedAt: null },
    select: { id: true, compOffCreditId: true, units: true },
  });
  if (!rows.length) return { moves: [], forfeited: 0, applied: 0 };

  const lotIds = rows.map((r) => r.compOffCreditId);
  const lots = await tx.compOffCredit.findMany({
    where: { id: { in: lotIds } },
    select: { id: true, quantity: true, consumed: true, expiresOn: true, version: true },
  });
  const lotsById = new Map(lots.map((l) => [l.id, l]));
  const allocations = rows.map((r) => ({ lotId: r.compOffCreditId, units: Number(r.units) }));

  const { moves, forfeited } = reCreditAllocations(allocations, lotsById, { asOf });
  const byMoveLot = new Map(moves.map((m) => [m.lotId, m]));
  for (const m of moves) {
    const lot = lotsById.get(m.lotId);
    await tx.compOffCredit.update({
      where: { id: m.lotId, version: lot.version },
      data: {
        consumed: m.newConsumed,
        // Dropped below quantity → spendable again → ACTIVE. (A lot that was ACTIVE
        // and partially consumed stays ACTIVE; this only resurrects an EXHAUSTED one.)
        ...(m.reactivates ? { status: 'ACTIVE' } : {}),
        version: { increment: 1 },
      },
    });
  }
  // Stamp every consumption row reversed (incl. forfeited/already-full ones) so a
  // re-withdraw is a no-op. The `give` we actually applied is recorded for the trail.
  let appliedMilli = 0;
  for (const r of rows) {
    const m = byMoveLot.get(r.compOffCreditId);
    if (m) appliedMilli += Math.round(m.give * 1000);
    await tx.compOffConsumption.update({ where: { id: r.id }, data: { reversedAt: new Date() } });
  }
  return { moves, forfeited, applied: Math.round(appliedMilli) / 1000 };
}

module.exports = { isCompOffCategory, debitLotsOnApprove, reCreditLotsOnWithdraw };

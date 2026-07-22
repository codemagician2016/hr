'use strict';

/**
 * pointsLedger.js — Feature 35 §4.3. THE single chokepoint that moves points.
 * Modelled EXACTLY on the proven CustomerWallet/WalletLedgerEntry pair (HR-scoped):
 * an append-only signed PointsLedgerEntry is the source of truth; PointsWallet is
 * the version-locked cached balance (closing identity: balance == Σ entries.points).
 *
 *   credit(tx, { businessId, employeeId, points, reason, refType?, refId?, note?,
 *                expiresAt?, createdByUserId? })  -> { entry, wallet }
 *   debit(tx,  { ...same, points > 0 })           -> { entry, wallet }   (entry.points is negative)
 *
 * Both REQUIRE a transaction client (they are called inside domain/engine txs) and
 * post ONE ledger row + ONE version-locked wallet update:
 *     updateMany({ where: { id, version }, data: { balance ± points, version+1 } })
 * A lost race re-resolves the wallet and retries (bounded); debit FAIL-CLOSES when
 * balance < points (INSUFFICIENT_POINTS) so a negative balance is impossible.
 *
 * Every function takes the prisma-like client as its first arg (injectable), so the
 * ledger math + retry/fail-close behaviour is unit-testable with a fake tx (no DB).
 */

const MAX_RETRIES = 3;

const VALID_REASONS = new Set(['RECOGNITION', 'AWARD', 'REDEMPTION', 'EXPIRY', 'ADJUSTMENT', 'REVERSAL']);

function err(code, message, status) {
  const e = new Error(message || code);
  e.code = code;
  if (status) e.statusCode = status;
  return e;
}

/** PURE — the ledger identity: balance is always reconstructible as Σ entries. */
function sumEntries(entries) {
  let total = 0;
  for (const e of entries || []) {
    const n = Number(e && e.points);
    if (Number.isInteger(n)) total += n;
  }
  return total;
}

/**
 * PURE — how many points to lapse for one employee tonight (FIFO expiry, §8).
 * Spends consume the OLDEST earnings first, so the lapse amount is what remains of
 * the already-expired earnings after all spends + previous expiries ate into them:
 *   toExpire = max(0, earnedPastExpiry − totalSpent − alreadyExpired), capped at balance.
 * Never edits earned rows — the runner writes ONE negative EXPIRY entry for this.
 */
function computeExpiryAmount({ earnedPastExpiry, totalSpent, alreadyExpired, balance }) {
  const past = Math.max(0, Number(earnedPastExpiry) || 0);
  const spent = Math.max(0, Number(totalSpent) || 0);
  const expired = Math.max(0, Number(alreadyExpired) || 0);
  const bal = Math.max(0, Number(balance) || 0);
  return Math.min(Math.max(0, past - spent - expired), bal);
}

function assertArgs({ businessId, employeeId, points, reason }) {
  if (!businessId || !employeeId) throw err('BAD_REQUEST', 'pointsLedger requires businessId + employeeId', 400);
  if (!Number.isInteger(points) || points <= 0) throw err('BAD_POINTS', 'points must be a positive integer', 400);
  if (!VALID_REASONS.has(reason)) throw err('BAD_REASON', `reason must be one of ${[...VALID_REASONS].join('/')}`, 400);
}

/** Find-or-create the employee's wallet (inside the caller's tx). */
async function ensureWallet(tx, businessId, employeeId) {
  const existing = await tx.pointsWallet.findFirst({ where: { businessId, employeeId } });
  if (existing) return existing;
  try {
    return await tx.pointsWallet.create({ data: { businessId, employeeId, balance: 0, lifetimeEarned: 0 } });
  } catch (_e) {
    // Unique race on (businessId, employeeId) — another writer created it; re-read.
    const won = await tx.pointsWallet.findFirst({ where: { businessId, employeeId } });
    if (won) return won;
    throw _e;
  }
}

// Version-locked wallet apply with bounded retry. `delta` is signed; `earnDelta`
// bumps lifetimeEarned (credits only). Debits re-check balance on EVERY attempt so
// two concurrent redemptions can never overspend (§8 invariant).
async function applyToWallet(tx, { businessId, employeeId, delta, earnDelta }) {
  let wallet = await ensureWallet(tx, businessId, employeeId);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (delta < 0 && wallet.balance + delta < 0) {
      throw err('INSUFFICIENT_POINTS', `Balance ${wallet.balance} is less than ${-delta} points`, 409);
    }
    const flip = await tx.pointsWallet.updateMany({
      where: { id: wallet.id, version: wallet.version },
      data: {
        balance: { increment: delta },
        ...(earnDelta ? { lifetimeEarned: { increment: earnDelta } } : {}),
        version: { increment: 1 },
      },
    });
    if (flip.count > 0) {
      return tx.pointsWallet.findFirst({ where: { id: wallet.id } });
    }
    // Lost the optimistic race — re-resolve and retry.
    wallet = await tx.pointsWallet.findFirst({ where: { id: wallet.id } });
    if (!wallet) throw err('WALLET_GONE', 'Points wallet disappeared mid-update', 409);
  }
  throw err('CONCURRENT_UPDATE', 'Points wallet changed concurrently — retry', 409);
}

/**
 * credit — mint `points` (positive) into the employee's wallet. Appends ONE +points
 * ledger row then bumps balance + lifetimeEarned under a version lock.
 */
async function credit(tx, args) {
  const { businessId, employeeId, points, reason, refType = null, refId = null, note = null, expiresAt = null, createdByUserId = null } = args || {};
  assertArgs({ businessId, employeeId, points, reason });
  const entry = await tx.pointsLedgerEntry.create({
    data: { businessId, employeeId, points, reason, refType, refId, note, expiresAt, createdByUserId },
  });
  const wallet = await applyToWallet(tx, { businessId, employeeId, delta: points, earnDelta: points });
  return { entry, wallet };
}

/**
 * debit — spend/lapse `points` (positive; stored as a NEGATIVE row). FAIL-CLOSES on
 * insufficient balance BEFORE any write, and the wallet apply re-checks per attempt.
 */
async function debit(tx, args) {
  const { businessId, employeeId, points, reason, refType = null, refId = null, note = null, createdByUserId = null } = args || {};
  assertArgs({ businessId, employeeId, points, reason });
  // Pre-check (fail fast, no orphan ledger row on an obviously-short balance).
  const wallet = await ensureWallet(tx, businessId, employeeId);
  if (wallet.balance < points) {
    throw err('INSUFFICIENT_POINTS', `Balance ${wallet.balance} is less than ${points} points`, 409);
  }
  const entry = await tx.pointsLedgerEntry.create({
    data: { businessId, employeeId, points: -points, reason, refType, refId, note, createdByUserId },
  });
  const updated = await applyToWallet(tx, { businessId, employeeId, delta: -points, earnDelta: 0 });
  return { entry, wallet: updated };
}

module.exports = {
  credit,
  debit,
  ensureWallet,
  // pure helpers (unit-tested without a DB)
  sumEntries,
  computeExpiryAmount,
  _internals: { applyToWallet, MAX_RETRIES },
};

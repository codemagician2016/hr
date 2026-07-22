'use strict';

/**
 * pointsExpiryRunner.js — Feature 35 §8 FIFO points expiry (nightly, optional).
 *
 * OFF by default (config.pointsExpiryMonths = null → the tenant is skipped). Earned
 * ledger rows carry a per-entry expiresAt (stamped at credit time); spends consume
 * the OLDEST earnings first, so tonight's lapse per employee is the PURE
 * computeExpiryAmount identity:
 *     toExpire = max(0, Σ earnedPastExpiry − Σ spends − Σ prior expiries), ≤ balance
 * The lapse is ONE negative EXPIRY ledger row (append-only — earned rows are never
 * edited) + the version-locked wallet debit, per employee, each in its own tx so a
 * single failure never strands the sweep. Naturally idempotent: a re-run recomputes
 * toExpire including the row it just wrote → 0.
 */

const prisma = require('../../core/lib/prisma');
const pointsLedger = require('./pointsLedger');
const { getConfig } = require('./config');

async function runPointsExpiry({ asOf = new Date() } = {}) {
  const out = { tenants: 0, employees: 0, lapsedPoints: 0, errors: 0 };

  // Tenants with anything past-expiry (cheap distinct probe).
  const candidates = await prisma.pointsLedgerEntry.groupBy({
    by: ['businessId'],
    where: { points: { gt: 0 }, expiresAt: { not: null, lte: asOf } },
  });

  for (const { businessId } of candidates) {
    let config;
    try {
      config = await getConfig(businessId);
    } catch (_e) { continue; }
    // Expiry only runs for tenants whose CURRENT program has an expiry window.
    if (!config.pointsEnabled || !config.pointsExpiryMonths) continue;
    out.tenants += 1;

    const byEmployee = await prisma.pointsLedgerEntry.groupBy({
      by: ['employeeId'],
      where: { businessId, points: { gt: 0 }, expiresAt: { not: null, lte: asOf } },
      _sum: { points: true },
    });

    for (const row of byEmployee) {
      const employeeId = row.employeeId;
      try {
        const [spentAgg, expiredAgg, wallet] = await Promise.all([
          prisma.pointsLedgerEntry.aggregate({
            where: { businessId, employeeId, points: { lt: 0 }, reason: { not: 'EXPIRY' } },
            _sum: { points: true },
          }),
          prisma.pointsLedgerEntry.aggregate({
            where: { businessId, employeeId, reason: 'EXPIRY' },
            _sum: { points: true },
          }),
          prisma.pointsWallet.findFirst({ where: { businessId, employeeId } }),
        ]);
        const toExpire = pointsLedger.computeExpiryAmount({
          earnedPastExpiry: (row._sum && row._sum.points) || 0,
          totalSpent: Math.abs((spentAgg._sum && spentAgg._sum.points) || 0),
          alreadyExpired: Math.abs((expiredAgg._sum && expiredAgg._sum.points) || 0),
          balance: wallet ? wallet.balance : 0,
        });
        if (toExpire <= 0) continue;
        await prisma.$transaction((tx) => pointsLedger.debit(tx, {
          businessId,
          employeeId,
          points: toExpire,
          reason: 'EXPIRY',
          note: `Points expiry sweep ${asOf.toISOString().slice(0, 10)}`,
        }));
        out.employees += 1;
        out.lapsedPoints += toExpire;
      } catch (e) {
        out.errors += 1;
        console.error('[points expiry] employee sweep failed', businessId, employeeId, e.message);
      }
    }
  }
  return out;
}

module.exports = { runPointsExpiry };

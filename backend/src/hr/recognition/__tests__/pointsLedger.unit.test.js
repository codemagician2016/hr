'use strict';

/*
 * pointsLedger.unit.test.js — Feature 35 pure ledger math + version-locked posting
 * (§4.3, §8). Plain-node, NO DB: the tx is a fake in-memory prisma surface, so the
 * append-only identity (balance == Σ entries), the fail-closed debit, and the
 * optimistic-lock retry/conflict paths are all exercised without a database.
 *   node backend/src/hr/recognition/__tests__/pointsLedger.unit.test.js
 */

const assert = require('assert');
const ledger = require('../pointsLedger');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

// ── fake prisma tx (pointsWallet + pointsLedgerEntry only) ──────────────────
function makeFakeTx() {
  const wallets = new Map();
  const entries = [];
  let seq = 1;
  const matchWallet = (w, where) => {
    if (where.id !== undefined && w.id !== where.id) return false;
    if (where.businessId !== undefined && w.businessId !== where.businessId) return false;
    if (where.employeeId !== undefined && w.employeeId !== where.employeeId) return false;
    if (where.version !== undefined && w.version !== where.version) return false;
    return true;
  };
  const tx = {
    pointsWallet: {
      async findFirst({ where }) {
        for (const w of wallets.values()) if (matchWallet(w, where)) return { ...w };
        return null;
      },
      async create({ data }) {
        const row = { id: `w${seq++}`, version: 0, balance: 0, lifetimeEarned: 0, ...data };
        wallets.set(row.id, row);
        return { ...row };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const w of wallets.values()) {
          if (!matchWallet(w, where)) continue;
          if (data.balance && data.balance.increment != null) w.balance += data.balance.increment;
          if (data.lifetimeEarned && data.lifetimeEarned.increment != null) w.lifetimeEarned += data.lifetimeEarned.increment;
          if (data.version && data.version.increment != null) w.version += data.version.increment;
          count += 1;
        }
        return { count };
      },
    },
    pointsLedgerEntry: {
      async create({ data }) {
        const row = { id: `e${seq++}`, createdAt: new Date(), ...data };
        entries.push(row);
        return { ...row };
      },
    },
    _wallets: wallets,
    _entries: entries,
  };
  return tx;
}

const BASE = { businessId: 'biz1', employeeId: 'emp1' };

async function main() {
  /* ── credit: entry + wallet + lifetime ── */
  {
    const tx = makeFakeTx();
    const r = await ledger.credit(tx, { ...BASE, points: 100, reason: 'RECOGNITION', refType: 'Recognition', refId: 'r1' });
    ok('credit returns the +entry', r.entry.points === 100 && r.entry.reason === 'RECOGNITION');
    ok('credit bumps balance', r.wallet.balance === 100);
    ok('credit bumps lifetimeEarned', r.wallet.lifetimeEarned === 100);
    ok('credit bumps version', r.wallet.version === 1);
  }

  /* ── the closing identity: balance == Σ entries across mixed ops ── */
  {
    const tx = makeFakeTx();
    await ledger.credit(tx, { ...BASE, points: 100, reason: 'RECOGNITION' });
    await ledger.credit(tx, { ...BASE, points: 50, reason: 'AWARD' });
    await ledger.debit(tx, { ...BASE, points: 30, reason: 'REDEMPTION' });
    await ledger.credit(tx, { ...BASE, points: 7, reason: 'ADJUSTMENT' });
    await ledger.debit(tx, { ...BASE, points: 20, reason: 'EXPIRY' });
    const wallet = await tx.pointsWallet.findFirst({ where: { ...BASE } });
    ok('balance == Σ entries', wallet.balance === ledger.sumEntries(tx._entries));
    ok('balance value', wallet.balance === 107);
    ok('lifetime counts ONLY credits', wallet.lifetimeEarned === 157);
    ok('debit rows are stored negative', tx._entries.filter((e) => e.points < 0).length === 2);
    ok('append-only: one row per op', tx._entries.length === 5);
  }

  /* ── debit fail-closes (INSUFFICIENT_POINTS) with NO orphan entry ── */
  {
    const tx = makeFakeTx();
    await ledger.credit(tx, { ...BASE, points: 40, reason: 'RECOGNITION' });
    let threw = null;
    try { await ledger.debit(tx, { ...BASE, points: 41, reason: 'REDEMPTION' }); } catch (e) { threw = e; }
    ok('debit over balance throws INSUFFICIENT_POINTS', threw && threw.code === 'INSUFFICIENT_POINTS');
    ok('failed debit appended NO entry', tx._entries.length === 1);
    const wallet = await tx.pointsWallet.findFirst({ where: { ...BASE } });
    ok('failed debit left balance intact', wallet.balance === 40);
    ok('exact-balance debit succeeds', (await ledger.debit(tx, { ...BASE, points: 40, reason: 'REDEMPTION' })).wallet.balance === 0);
  }

  /* ── debit against a missing wallet fail-closes at 0 ── */
  {
    const tx = makeFakeTx();
    let threw = null;
    try { await ledger.debit(tx, { ...BASE, points: 1, reason: 'REDEMPTION' }); } catch (e) { threw = e; }
    ok('no-wallet debit throws INSUFFICIENT_POINTS', threw && threw.code === 'INSUFFICIENT_POINTS');
  }

  /* ── argument fail-closes ── */
  {
    const tx = makeFakeTx();
    for (const bad of [0, -5, 2.5, '10', NaN]) {
      let threw = null;
      try { await ledger.credit(tx, { ...BASE, points: bad, reason: 'RECOGNITION' }); } catch (e) { threw = e; }
      ok(`non-positive-integer points rejected (${bad})`, threw && threw.code === 'BAD_POINTS');
    }
    let threw = null;
    try { await ledger.credit(tx, { ...BASE, points: 5, reason: 'GIFT' }); } catch (e) { threw = e; }
    ok('unknown reason rejected', threw && threw.code === 'BAD_REASON');
    threw = null;
    try { await ledger.credit(tx, { businessId: null, employeeId: 'e', points: 5, reason: 'AWARD' }); } catch (e) { threw = e; }
    ok('missing businessId rejected', threw && threw.code === 'BAD_REQUEST');
  }

  /* ── version conflict: one lost race → re-resolve + retry succeeds ── */
  {
    const tx = makeFakeTx();
    await ledger.credit(tx, { ...BASE, points: 100, reason: 'RECOGNITION' });
    const real = tx.pointsWallet.updateMany.bind(tx.pointsWallet);
    let raced = false;
    tx.pointsWallet.updateMany = async (args) => {
      if (!raced) {
        raced = true;
        // Simulate a concurrent writer bumping the version JUST before our write.
        for (const w of tx._wallets.values()) w.version += 1;
        return { count: 0 }; // our version-locked write loses
      }
      return real(args);
    };
    const r = await ledger.credit(tx, { ...BASE, points: 10, reason: 'AWARD' });
    ok('lost race retries and lands', r.wallet.balance === 110);
    ok('balance == Σ entries after retry', r.wallet.balance === ledger.sumEntries(tx._entries));
  }

  /* ── version conflict: persistent race → CONCURRENT_UPDATE after retries ── */
  {
    const tx = makeFakeTx();
    await ledger.credit(tx, { ...BASE, points: 100, reason: 'RECOGNITION' });
    tx.pointsWallet.updateMany = async () => {
      for (const w of tx._wallets.values()) w.version += 1; // always racing
      return { count: 0 };
    };
    let threw = null;
    try { await ledger.credit(tx, { ...BASE, points: 10, reason: 'AWARD' }); } catch (e) { threw = e; }
    ok('exhausted retries throw CONCURRENT_UPDATE', threw && threw.code === 'CONCURRENT_UPDATE');
  }

  /* ── debit race re-checks the balance per attempt (no overspend, §8) ── */
  {
    const tx = makeFakeTx();
    await ledger.credit(tx, { ...BASE, points: 100, reason: 'RECOGNITION' });
    const real = tx.pointsWallet.updateMany.bind(tx.pointsWallet);
    let raced = false;
    tx.pointsWallet.updateMany = async (args) => {
      if (!raced && args.data.balance && args.data.balance.increment < 0) {
        raced = true;
        // A concurrent redemption drains 80 points and bumps the version.
        for (const w of tx._wallets.values()) { w.balance -= 80; w.version += 1; }
        return { count: 0 };
      }
      return real(args);
    };
    let threw = null;
    try { await ledger.debit(tx, { ...BASE, points: 50, reason: 'REDEMPTION' }); } catch (e) { threw = e; }
    ok('retry re-check refuses the overspend', threw && threw.code === 'INSUFFICIENT_POINTS');
    const wallet = await tx.pointsWallet.findFirst({ where: { ...BASE } });
    ok('balance never went negative', wallet.balance >= 0 && wallet.balance === 20);
  }

  /* ── sumEntries: signed + non-integers filtered ── */
  {
    ok('sumEntries sums signed deltas', ledger.sumEntries([{ points: 10 }, { points: -3 }, { points: 5 }]) === 12);
    ok('sumEntries ignores junk', ledger.sumEntries([{ points: 'x' }, { points: 2.5 }, null, { points: 4 }]) === 4);
    ok('sumEntries empty → 0', ledger.sumEntries([]) === 0);
  }

  /* ── computeExpiryAmount (FIFO lapse identity, §8) ── */
  {
    const c = ledger.computeExpiryAmount;
    ok('nothing spent → whole expired tranche lapses', c({ earnedPastExpiry: 100, totalSpent: 0, alreadyExpired: 0, balance: 100 }) === 100);
    ok('spends eat the oldest first', c({ earnedPastExpiry: 100, totalSpent: 60, alreadyExpired: 0, balance: 40 }) === 40);
    ok('fully spent → nothing lapses', c({ earnedPastExpiry: 100, totalSpent: 120, alreadyExpired: 0, balance: 30 }) === 0);
    ok('prior expiries are not re-lapsed (idempotent)', c({ earnedPastExpiry: 100, totalSpent: 20, alreadyExpired: 80, balance: 50 }) === 0);
    ok('capped at balance', c({ earnedPastExpiry: 100, totalSpent: 0, alreadyExpired: 0, balance: 70 }) === 70);
    ok('zero floor', c({ earnedPastExpiry: 0, totalSpent: 50, alreadyExpired: 0, balance: 100 }) === 0);
    ok('junk inputs clamp to 0', c({ earnedPastExpiry: 'x', totalSpent: null, alreadyExpired: -5, balance: 10 }) === 0);
    // Re-run identity: after writing the lapse row, spent' or expired' grows → 0.
    const first = c({ earnedPastExpiry: 100, totalSpent: 30, alreadyExpired: 0, balance: 90 });
    ok('first sweep lapses the remainder', first === 70);
    ok('second sweep is a no-op', c({ earnedPastExpiry: 100, totalSpent: 30, alreadyExpired: first, balance: 90 - first }) === 0);
  }

  console.log(`pointsLedger.unit: ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });

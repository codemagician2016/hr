'use strict';

/**
 * accrualRunner.js — cron orchestrator + year-end carry-forward driver
 * (Feature 6 §4.4). The MATH is pure (accrual.js / ledger.js); this loads the
 * context, calls the engines, and writes the append-only ledger rows inside a
 * `$transaction` with optimistic locking. Two entry points:
 *
 *   runNightlyAccrual({ businessId?, asOf?, dryRun? })
 *     For each active employee × assigned policy, if a tick is due
 *     (lastAccrualAt < tickStart), accrueForPeriod → post ACCRUAL, bump
 *     accrued/closing, stamp lastAccrualAt. Idempotent: the lastAccrualAt guard
 *     makes a re-run for the same window a no-op (QA 11).
 *
 *   runCarryForward({ businessId, periodCode, leaveTypeId?, dryRun, actorId })
 *     yearEndRoll → LAPSE the overflow, mint the next-period OPENING_BALANCE with
 *     carried units folded into `opening`. dryRun writes nothing. Backs both the
 *     cron roll job and the POST /runs/carry-forward endpoint.
 */

const prisma = require('../../core/lib/prisma');
const accrual = require('./accrual');
const { resolvePolicy } = require('./policyResolver');

function utcDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

// Month boundary for monthly-tick idempotency: the first instant of `asOf`'s month.
function monthStart(asOf) {
  const d = utcDay(asOf);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Next period code after a YYYY-YY (financial-year) or YYYY-ANNIV code.
function nextPeriodCode(periodCode) {
  const m = String(periodCode).match(/^(\d{4})-(\d{2}|ANNIV)$/);
  if (!m) return `${periodCode}-next`;
  const startY = Number(m[1]);
  if (m[2] === 'ANNIV') return `${startY + 1}-ANNIV`;
  const ny = startY + 1;
  return `${ny}-${String((ny + 1) % 100).padStart(2, '0')}`;
}

// ── nightly accrual ───────────────────────────────────────────────────────────
/**
 * runNightlyAccrual(opts) — sweep due accrual ticks. Returns
 * { scanned, accrued, skipped, errors }.
 */
async function runNightlyAccrual({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const tickStart = monthStart(asOf); // monthly tick boundary (candidate superset)
  const summary = { scanned: 0, accrued: 0, skipped: 0, errors: 0 };

  // Leave-audit — the tick boundary honours the POLICY's accrualFrequency (it was
  // monthly for everyone): MONTHLY/PER_PAY_PERIOD tick at the month boundary;
  // QUARTERLY at Jan/Apr/Jul/Oct; ANNUAL once a year at the IN fiscal start
  // (1 April — the same gate the year-end roll uses). The candidate query stays
  // on the monthly superset; the per-policy boundary decides below.
  const d = new Date(asOf);
  const q = Math.floor(d.getUTCMonth() / 3) * 3;
  const quarterStart = new Date(Date.UTC(d.getUTCFullYear(), q, 1));
  const fyStart = d.getUTCMonth() >= 3
    ? new Date(Date.UTC(d.getUTCFullYear(), 3, 1))
    : new Date(Date.UTC(d.getUTCFullYear() - 1, 3, 1));
  const boundaryFor = (freq) => (freq === 'QUARTERLY' ? quarterStart : freq === 'ANNUAL' ? fyStart : tickStart);

  // Candidate balances: a tick is due when lastAccrualAt is null or before the
  // current month boundary. We accrue against the persisted current-period balance.
  const where = {
    ...(businessId ? { businessId } : {}),
    OR: [{ lastAccrualAt: null }, { lastAccrualAt: { lt: tickStart } }],
  };
  const balances = await prisma.leaveBalance.findMany({
    where,
    include: {
      employee: {
        select: {
          id: true, businessId: true, hireDate: true, deletedAt: true,
          employmentRecords: { where: { isCurrent: true }, take: 1, select: { entityId: true, departmentId: true, gradeId: true, employmentType: true } },
        },
      },
      leaveType: { select: { id: true } },
    },
    take: 5000,
  });

  for (const bal of balances) {
    summary.scanned += 1;
    const emp = bal.employee;
    if (!emp || emp.deletedAt) { summary.skipped += 1; continue; }
    const er = (emp.employmentRecords && emp.employmentRecords[0]) || {};
    const empCtx = { ...emp, businessId: bal.businessId, entityId: er.entityId || null, departmentId: er.departmentId || null, gradeId: er.gradeId || null, employmentType: er.employmentType || null };
    try {
      const resolved = await resolvePolicy(empCtx, bal.leaveTypeId, asOf);
      if (!resolved || !resolved.policy) { summary.skipped += 1; continue; }
      const policy = resolved.policy;
      // Feature 16 — NONE-accrual types (LWP / no-balance) NEVER accrue a balance.
      // (An LWP type has no LeaveBalance row at all, so it should never be scanned;
      // this guard is belt-and-braces so a mis-seeded balance can't grow one.)
      if (policy.accrualMethod === 'NONE') { summary.skipped += 1; continue; }
      // UPFRONT policies grant at the opening, not per-tick — skip the nightly accrual.
      if (policy.accrualMethod === 'UPFRONT_ANNUAL' || policy.accrualMethod === 'ANNIVERSARY_GRANT') {
        summary.skipped += 1; continue;
      }
      // Leave-audit — honour the policy's own tick boundary (frequency).
      const policyTickStart = boundaryFor(policy.accrualFrequency);
      if (bal.lastAccrualAt && new Date(bal.lastAccrualAt) >= policyTickStart) { summary.skipped += 1; continue; }

      const tenureMonths = emp.hireDate ? accrual.tenureMonthsBetween(emp.hireDate, asOf) : 0;

      // Leave-audit — JOIN-MONTH PRORATION finally wired: on a balance's FIRST-ever
      // tick where the employee joined inside the current tick window, the grant is
      // prorataOnJoin (join-cutoff-day rule for monthly; day-proration otherwise)
      // instead of a full-period rate — a 28th-of-month joiner no longer gets a
      // full month's accrual.
      let units = null;
      const hire = emp.hireDate ? new Date(emp.hireDate) : null;
      const firstTick = !bal.lastAccrualAt;
      if (firstTick && hire && hire >= policyTickStart && hire <= asOf) {
        const windowEnd = new Date(Date.UTC(
          policyTickStart.getUTCFullYear(),
          policyTickStart.getUTCMonth() + (policy.accrualFrequency === 'QUARTERLY' ? 3 : policy.accrualFrequency === 'ANNUAL' ? 12 : 1),
          0,
        ));
        units = accrual.prorataOnJoin(policy, hire, policyTickStart, windowEnd, {
          grain: policy.accrualMethod === 'CONTINUOUS_NZ' ? 0.0001 : 0.5,
        });
      }
      const grant = units != null
        ? { units }
        : accrual.accrueForPeriod(policy, resolved.accrualRules, {
          tenureMonths,
          currentClosing: Number(bal.closing),
          grain: policy.accrualMethod === 'CONTINUOUS_NZ' ? 0.0001 : 0.5,
          workedWeeks: 1, // monthly proxy; a per-pay-period runner would pass the real count
        });
      if (grant.units <= 0) { summary.skipped += 1; continue; }
      if (dryRun) { summary.accrued += 1; continue; }

      await prisma.$transaction(async (tx) => {
        // re-guard inside the tx: only accrue if still due (idempotent on re-run)
        const fresh = await tx.leaveBalance.findUnique({ where: { id: bal.id }, select: { lastAccrualAt: true, version: true } });
        if (fresh && fresh.lastAccrualAt && new Date(fresh.lastAccrualAt) >= policyTickStart) return; // already ticked this window
        await tx.leaveTransaction.create({
          data: {
            businessId: bal.businessId, employeeId: emp.id, leaveTypeId: bal.leaveTypeId,
            leaveBalanceId: bal.id, txnType: 'ACCRUAL', unit: bal.unit, quantity: grant.units,
            status: 'APPROVED', appliedAt: asOf, decidedAt: asOf,
          },
        });
        await tx.leaveBalance.update({
          where: { id: bal.id, version: fresh ? fresh.version : bal.version },
          data: {
            accrued: { increment: grant.units },
            closing: { increment: grant.units },
            lastAccrualAt: asOf,
            version: { increment: 1 },
          },
        });
      });
      summary.accrued += 1;
    } catch (e) {
      summary.errors += 1;
      // P2025 = optimistic-lock race; another runner ticked it — safe to ignore.
      if (e && e.code !== 'P2025') console.error('[leave accrual] balance', bal.id, e.message);
    }
  }
  return summary;
}

// ── year-end carry-forward / lapse ────────────────────────────────────────────
/**
 * runCarryForward(opts) — roll one period into the next, IDEMPOTENTLY.
 *   For each not-yet-rolled balance in `periodCode` (optionally one leaveType):
 *     { carried, lapsed } = yearEndRoll(policy, closing)
 *     post LAPSE (−lapsed) on the closing period (when > 0)
 *     mint/extend next-period OPENING_BALANCE (+carried), carried folded into opening
 *     STAMP carriedForwardAt on the source balance (the idempotency marker)
 * dryRun writes nothing; returns the line-by-line preview either way.
 *
 * Idempotency (finding #1): the source balance carries a `carriedForwardAt`
 * marker. We exclude already-stamped rows from the candidate set, AND re-guard
 * inside the tx (re-read carriedForwardAt + version) before posting — so a re-run,
 * an operator double-click, or a double-fired cron is a no-op for any balance
 * already rolled. Mirrors runNightlyAccrual's in-tx re-read + version-lock.
 */
async function runCarryForward({ businessId, periodCode, leaveTypeId = null, dryRun = true, actorId = null } = {}) {
  if (!businessId || !periodCode) throw new Error('runCarryForward requires businessId and periodCode');
  const nextCode = nextPeriodCode(periodCode);
  const asOf = new Date();

  // Only roll balances that have NOT already been carried forward (idempotent set).
  // Feature 30 — COMP_OFF is EXCLUDED from the period roll: its expiry is PER-CREDIT
  // (each lot carries its own `expiresOn`, driven by compOffExpiryRunner), not
  // period-based. Folding a comp-off closing into the next period's opening would
  // double-count credits against their lots (the §7 reconcile invariant). The lots
  // survive a period roll on their own clock.
  const where = { businessId, periodCode, carriedForwardAt: null, leaveType: { is: { category: { not: 'COMP_OFF' } } } };
  if (leaveTypeId) where.leaveTypeId = leaveTypeId;
  const balances = await prisma.leaveBalance.findMany({
    where,
    include: {
      employee: {
        select: {
          id: true, businessId: true, deletedAt: true,
          employmentRecords: { where: { isCurrent: true }, take: 1, select: { entityId: true, departmentId: true, gradeId: true, employmentType: true } },
        },
      },
      leaveType: { select: { id: true, unit: true, category: true } },
    },
    take: 10000,
  });

  const lines = [];
  let carriedTotal = 0; let lapsedTotal = 0; let rolled = 0; let skipped = 0;

  for (const bal of balances) {
    const emp = bal.employee;
    if (!emp || emp.deletedAt) continue;
    const er = (emp.employmentRecords && emp.employmentRecords[0]) || {};
    const empCtx = { id: emp.id, businessId, entityId: er.entityId || null, departmentId: er.departmentId || null, gradeId: er.gradeId || null, employmentType: er.employmentType || null };
    const resolved = await resolvePolicy(empCtx, bal.leaveTypeId, asOf);
    const policy = resolved ? resolved.policy : null;
    const grain = policy && policy.accrualMethod === 'CONTINUOUS_NZ' ? 0.0001 : 0.5;
    const { carried, lapsed } = accrual.yearEndRoll(policy || {}, Number(bal.closing), { grain });
    carriedTotal += carried; lapsedTotal += lapsed;
    lines.push({
      employeeId: emp.id, leaveTypeId: bal.leaveTypeId, fromPeriod: periodCode,
      toPeriod: nextCode, closing: Number(bal.closing), carried, lapsed,
    });

    if (dryRun) continue;

    try {
      await prisma.$transaction(async (tx) => {
        // In-tx re-guard (mirrors runNightlyAccrual): only roll if STILL un-rolled.
        // A concurrent/duplicate run that already stamped this balance short-circuits.
        const fresh = await tx.leaveBalance.findUnique({
          where: { id: bal.id },
          select: { carriedForwardAt: true, version: true, closing: true },
        });
        if (!fresh || fresh.carriedForwardAt) { skipped += 1; return; } // already rolled this period
        if (lapsed > 0) {
          await tx.leaveTransaction.create({
            data: {
              businessId, employeeId: emp.id, leaveTypeId: bal.leaveTypeId, leaveBalanceId: bal.id,
              txnType: 'LAPSE', unit: bal.unit, quantity: -lapsed,
              status: 'APPROVED', appliedAt: asOf, decidedAt: asOf, decidedBy: actorId,
              reason: `Year-end lapse ${periodCode}`,
            },
          });
        }
        if (carried > 0) {
          // mint (or extend) the next-period balance with the carried units in `opening`.
          const next = await tx.leaveBalance.upsert({
            where: { businessId_employeeId_leaveTypeId_periodCode: { businessId, employeeId: emp.id, leaveTypeId: bal.leaveTypeId, periodCode: nextCode } },
            update: {},
            create: { businessId, employeeId: emp.id, leaveTypeId: bal.leaveTypeId, periodCode: nextCode, unit: bal.unit },
          });
          await tx.leaveTransaction.create({
            data: {
              businessId, employeeId: emp.id, leaveTypeId: bal.leaveTypeId, leaveBalanceId: next.id,
              txnType: 'OPENING_BALANCE', unit: bal.unit, quantity: carried,
              status: 'APPROVED', appliedAt: asOf, decidedAt: asOf, decidedBy: actorId,
              reason: `Carry-forward from ${periodCode}`,
            },
          });
          await tx.leaveBalance.update({
            where: { id: next.id },
            data: { opening: { increment: carried }, closing: { increment: carried }, version: { increment: 1 } },
          });
        }
        // Stamp the source balance + (when lapsing) move closing→lapsed UNDER the
        // version lock. A racing run that ticked it first fails the version match
        // (P2025) and its whole tx rolls back — no double-lapse/double-carry. The
        // stamp is always set so a re-run is a true no-op even when carried===lapsed===0.
        await tx.leaveBalance.update({
          where: { id: bal.id, version: fresh.version },
          data: {
            ...(lapsed > 0 ? { lapsed: { increment: lapsed }, closing: { decrement: lapsed } } : {}),
            carriedForwardAt: asOf,
            version: { increment: 1 },
          },
        });
        rolled += 1;
      });
    } catch (e) {
      // P2025 = a concurrent run rolled this balance first; safe to ignore (idempotent).
      if (e && e.code === 'P2025') { skipped += 1; continue; }
      throw e;
    }
  }

  return {
    businessId, periodCode, nextPeriodCode: nextCode, dryRun,
    lineCount: lines.length, rolled, skipped,
    carriedTotal: Math.round(carriedTotal * 1e4) / 1e4,
    lapsedTotal: Math.round(lapsedTotal * 1e4) / 1e4, lines,
  };
}

// ── carried-lot expiry (leave-audit) ──────────────────────────────────────────
/**
 * runCarriedLotExpiry({ businessId?, asOf, dryRun }) — enforce
 * `carryForwardExpiryMonths` for ORDINARY leave (comp-off has its own runner;
 * the pure carriedLotExpiry existed since F6 but no runner ever called it).
 *
 * A "lot" is the OPENING_BALANCE row runCarryForward writes (reason
 * "Carry-forward from <period>") — openedAt = its appliedAt. Consumption is
 * carried-first (FIFO): remaining = max(0, carried − (taken + encashed)),
 * additionally capped by the live closing. Past expiry, the remainder lapses
 * with a marked LAPSE row; the marker ("Carried-forward leave expired") is the
 * idempotency guard — one expiry event per lot, re-runs are no-ops.
 */
async function runCarriedLotExpiry({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const summary = { scanned: 0, lapsed: 0, skipped: 0, errors: 0 };
  const EXPIRY_MARK = 'Carried-forward leave expired';

  const carryTxns = await prisma.leaveTransaction.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      txnType: 'OPENING_BALANCE',
      reason: { startsWith: 'Carry-forward from' },
    },
    select: { id: true, businessId: true, employeeId: true, leaveTypeId: true, leaveBalanceId: true, quantity: true, unit: true, appliedAt: true, createdAt: true },
    take: 5000,
  });

  for (const t of carryTxns) {
    summary.scanned += 1;
    try {
      if (!t.leaveBalanceId) { summary.skipped += 1; continue; }
      const bal = await prisma.leaveBalance.findUnique({ where: { id: t.leaveBalanceId } });
      if (!bal) { summary.skipped += 1; continue; }

      // Already expired once → no-op (the marker row is the guard).
      const already = await prisma.leaveTransaction.findFirst({
        where: { businessId: t.businessId, leaveBalanceId: bal.id, txnType: 'LAPSE', reason: { startsWith: EXPIRY_MARK } },
        select: { id: true },
      });
      if (already) { summary.skipped += 1; continue; }

      const emp = await prisma.employee.findFirst({
        where: { id: t.employeeId, businessId: t.businessId, deletedAt: null },
        select: {
          id: true, hireDate: true,
          employmentRecords: { where: { isCurrent: true }, take: 1, select: { entityId: true, departmentId: true, gradeId: true, employmentType: true } },
        },
      });
      if (!emp) { summary.skipped += 1; continue; }
      const er = (emp.employmentRecords && emp.employmentRecords[0]) || {};
      const resolved = await resolvePolicy(
        { ...emp, businessId: t.businessId, entityId: er.entityId || null, departmentId: er.departmentId || null, gradeId: er.gradeId || null, employmentType: er.employmentType || null },
        t.leaveTypeId,
        asOf,
      );
      const months = resolved && resolved.policy ? resolved.policy.carryForwardExpiryMonths : null;
      if (months == null) { summary.skipped += 1; continue; }

      const carried = Math.abs(Number(t.quantity));
      const consumed = Number(bal.taken) + Number(bal.encashed);
      const remaining = Math.min(Math.max(0, carried - consumed), Math.max(0, Number(bal.closing)));
      const verdict = accrual.carriedLotExpiry(
        [{ openedAt: t.appliedAt || t.createdAt, remaining }],
        asOf,
        months,
      );
      if (verdict.lapsed <= 0) { summary.skipped += 1; continue; }
      if (dryRun) { summary.lapsed += 1; continue; }

      await prisma.$transaction(async (tx) => {
        const fresh = await tx.leaveBalance.findUnique({ where: { id: bal.id }, select: { version: true } });
        await tx.leaveTransaction.create({
          data: {
            businessId: t.businessId, employeeId: t.employeeId, leaveTypeId: t.leaveTypeId,
            leaveBalanceId: bal.id, txnType: 'LAPSE', unit: t.unit, quantity: -verdict.lapsed,
            reason: `${EXPIRY_MARK} (${months} months)`,
            status: 'APPROVED', appliedAt: asOf, decidedAt: asOf,
          },
        });
        const flip = await tx.leaveBalance.updateMany({
          where: { id: bal.id, version: fresh.version },
          data: { lapsed: { increment: verdict.lapsed }, closing: { decrement: verdict.lapsed }, version: { increment: 1 } },
        });
        if (flip.count === 0) throw Object.assign(new Error('race'), { code: 'P2025' });
      });
      summary.lapsed += 1;
    } catch (e) {
      summary.errors += 1;
      if (e && e.code !== 'P2025') console.error('[leave lot-expiry] txn', t.id, e.message);
    }
  }
  return summary;
}

module.exports = { runNightlyAccrual, runCarryForward, runCarriedLotExpiry, nextPeriodCode, _internals: { monthStart } };

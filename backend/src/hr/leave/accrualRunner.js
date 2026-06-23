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
  const tickStart = monthStart(asOf); // monthly tick boundary
  const summary = { scanned: 0, accrued: 0, skipped: 0, errors: 0 };

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
      // UPFRONT policies grant at the opening, not per-tick — skip the nightly accrual.
      if (policy.accrualMethod === 'UPFRONT_ANNUAL' || policy.accrualMethod === 'ANNIVERSARY_GRANT') {
        summary.skipped += 1; continue;
      }
      const tenureMonths = emp.hireDate ? accrual.tenureMonthsBetween(emp.hireDate, asOf) : 0;
      const grant = accrual.accrueForPeriod(policy, resolved.accrualRules, {
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
        if (fresh && fresh.lastAccrualAt && new Date(fresh.lastAccrualAt) >= tickStart) return; // already ticked this window
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
 * runCarryForward(opts) — roll one period into the next.
 *   For each balance in `periodCode` (optionally one leaveType):
 *     { carried, lapsed } = yearEndRoll(policy, closing)
 *     post LAPSE (−lapsed) on the closing period (when > 0)
 *     mint/extend next-period OPENING_BALANCE (+carried), carried folded into opening
 * dryRun writes nothing; returns the line-by-line preview either way.
 */
async function runCarryForward({ businessId, periodCode, leaveTypeId = null, dryRun = true, actorId = null } = {}) {
  if (!businessId || !periodCode) throw new Error('runCarryForward requires businessId and periodCode');
  const nextCode = nextPeriodCode(periodCode);
  const asOf = new Date();

  const where = { businessId, periodCode };
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
      leaveType: { select: { id: true, unit: true } },
    },
    take: 10000,
  });

  const lines = [];
  let carriedTotal = 0; let lapsedTotal = 0;

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

    await prisma.$transaction(async (tx) => {
      if (lapsed > 0) {
        await tx.leaveTransaction.create({
          data: {
            businessId, employeeId: emp.id, leaveTypeId: bal.leaveTypeId, leaveBalanceId: bal.id,
            txnType: 'LAPSE', unit: bal.unit, quantity: -lapsed,
            status: 'APPROVED', appliedAt: asOf, decidedAt: asOf, decidedBy: actorId,
            reason: `Year-end lapse ${periodCode}`,
          },
        });
        await tx.leaveBalance.update({
          where: { id: bal.id },
          data: { lapsed: { increment: lapsed }, closing: { decrement: lapsed }, version: { increment: 1 } },
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
    });
  }

  return {
    businessId, periodCode, nextPeriodCode: nextCode, dryRun,
    lineCount: lines.length, carriedTotal: Math.round(carriedTotal * 1e4) / 1e4,
    lapsedTotal: Math.round(lapsedTotal * 1e4) / 1e4, lines,
  };
}

module.exports = { runNightlyAccrual, runCarryForward, nextPeriodCode, _internals: { monthStart } };

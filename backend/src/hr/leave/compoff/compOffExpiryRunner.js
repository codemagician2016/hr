'use strict';

/**
 * compOffExpiryRunner.js — per-credit comp-off LAPSE + expiring-soon reminder
 * (Feature 30 §4.4). Modelled on accrualRunner#runCarryForward: scan, pure check,
 * append-only LAPSE, version-locked stamp.
 *
 *   runCompOffExpiry({ businessId?, asOf?, dryRun? }):
 *     for each CompOffCredit ACTIVE with expiresOn < asOf AND remaining > 0:
 *       in $transaction (version-locked, in-tx re-guard):
 *         append LeaveTransaction{ LAPSE, -lapsed, APPROVED }
 *         LeaveBalance.update: lapsed += lapsed, closing -= lapsed, version++
 *         CompOffCredit.update: status='EXPIRED', version++
 *       notify employee (comp-off.lapsed)
 *     PLUS a reminder pass: ACTIVE credits expiring within expiryReminderDays →
 *       notify (comp-off.expiring-soon), encourage use.
 *
 * Idempotent: a lot already EXPIRED is excluded; the in-tx re-read of status+version
 * short-circuits a double-run (mirrors runCarryForward's carriedForwardAt guard). A
 * PENDING credit whose expiresOn passed is also expired here (edge case 10 — you
 * can't approve a dead credit; its open approval is best-effort cancelled).
 *
 * CLI: node src/hr/leave/compoff/compOffExpiryRunner.js [--business=<id>] [--asOf=<iso>] [--dry]
 */

const prisma = require('../../../core/lib/prisma');
const { resolveCompOffType } = require('./compOffConfig');
const { notifyHrEvent } = require('../../integrations/notifications');

function utcDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}
function addDays(d, n) { return new Date(utcDay(d).getTime() + n * 86400000); }
function isoDay(d) { return utcDay(d).toISOString().slice(0, 10); }
function emailOf(emp) { return emp ? (emp.workEmail || emp.personalEmail || null) : null; }
function daysBetween(a, b) { return Math.round((utcDay(b).getTime() - utcDay(a).getTime()) / 86400000); }

/**
 * runCompOffExpiry(opts) — lapse expired comp-off lots + remind on expiring-soon.
 * Returns { scanned, lapsed, lapsedUnits, remindersSent, skipped, errors, tenants }.
 */
async function runCompOffExpiry({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const now = utcDay(asOf);
  const summary = { scanned: 0, lapsed: 0, lapsedUnits: 0, remindersSent: 0, skipped: 0, errors: 0, tenants: 0 };

  const tenantIds = businessId
    ? [businessId]
    : (await prisma.business.findMany({ select: { id: true }, take: 10000 })).map((b) => b.id);

  for (const bId of tenantIds) {
    summary.tenants += 1;
    let typeCtx = null;
    try { typeCtx = await resolveCompOffType(bId); } catch (_e) { /* config read; keep going for lapse */ }
    const leaveTypeId = typeCtx && typeCtx.leaveType ? typeCtx.leaveType.id : null;
    const reminderDays = (typeCtx && typeCtx.config && typeCtx.config.expiryReminderDays) || 7;

    // ── LAPSE pass — expiresOn strictly before today (usable THROUGH the expiry day).
    const expired = await prisma.compOffCredit.findMany({
      where: { businessId: bId, status: { in: ['ACTIVE', 'PENDING'] }, expiresOn: { lt: now } },
      select: {
        id: true, employeeId: true, quantity: true, consumed: true, expiresOn: true,
        leaveBalanceId: true, status: true, approvalRequestId: true, sourceKind: true,
      },
      take: 20000,
    });

    for (const lot of expired) {
      summary.scanned += 1;
      const lapsedQty = Math.max(0, Number(lot.quantity) - Number(lot.consumed));
      try {
        if (dryRun) { if (lapsedQty > 0) { summary.lapsed += 1; summary.lapsedUnits += lapsedQty; } continue; }

        await prisma.$transaction(async (tx) => {
          // In-tx re-guard: only act on a lot still in a lapsable state (idempotent).
          const fresh = await tx.compOffCredit.findUnique({
            where: { id: lot.id },
            select: { status: true, version: true, quantity: true, consumed: true, leaveBalanceId: true },
          });
          if (!fresh || (fresh.status !== 'ACTIVE' && fresh.status !== 'PENDING')) return;
          const rem = Math.max(0, Number(fresh.quantity) - Number(fresh.consumed));

          // Flip the lot EXPIRED under the version lock.
          await tx.compOffCredit.update({
            where: { id: lot.id, version: fresh.version },
            data: { status: 'EXPIRED', version: { increment: 1 } },
          });

          // Only an ACTIVE lot ever bumped the aggregate balance, so only it lapses on
          // the ledger. A PENDING (never-finalized) lot just flips EXPIRED — no balance.
          if (fresh.status === 'ACTIVE' && rem > 0 && fresh.leaveBalanceId) {
            const bal = await tx.leaveBalance.findUnique({
              where: { id: fresh.leaveBalanceId }, select: { id: true, version: true, leaveTypeId: true },
            });
            if (bal) {
              await tx.leaveTransaction.create({
                data: {
                  businessId: bId, employeeId: lot.employeeId, leaveTypeId: leaveTypeId || bal.leaveTypeId,
                  leaveBalanceId: bal.id, txnType: 'LAPSE', unit: 'DAYS', quantity: -rem,
                  status: 'APPROVED', appliedAt: new Date(), decidedAt: new Date(),
                  reason: 'Comp-off expiry',
                },
              });
              await tx.leaveBalance.update({
                where: { id: bal.id, version: bal.version },
                data: { lapsed: { increment: rem }, closing: { decrement: rem }, version: { increment: 1 } },
              });
            }
          }
        });

        // A PENDING credit that expired can't be approved — best-effort cancel its
        // open approval request (edge case 10), OUTSIDE the lapse tx.
        if (lot.status === 'PENDING' && lot.approvalRequestId) {
          try {
            const engine = require('../../approvals/engine');
            await engine.cancel({ approvalRequestId: lot.approvalRequestId, actorUserId: 'SYSTEM', comment: 'Comp-off credit expired before approval' });
          } catch (_e) { /* best-effort */ }
        }

        if (lapsedQty > 0) { summary.lapsed += 1; summary.lapsedUnits += lapsedQty; }

        if (lot.status === 'ACTIVE' && lapsedQty > 0) {
          const emp = await prisma.employee.findFirst({
            where: { id: lot.employeeId, businessId: bId }, select: { firstName: true, workEmail: true, personalEmail: true },
          });
          const email = emailOf(emp);
          if (email) {
            notifyHrEvent({
              businessId: bId, event: 'comp-off.lapsed', recipientEmail: email,
              variables: { NAME: (emp && emp.firstName) || 'there', DAYS: String(lapsedQty), EXPIRES: isoDay(lot.expiresOn), BIZ: '' },
              triggeredBy: 'COMP_OFF_LAPSED',
            }).catch(() => {});
          }
        }
      } catch (e) {
        if (e && e.code === 'P2025') { summary.skipped += 1; continue; } // raced; idempotent
        summary.errors += 1;
        console.error('[comp-off expiry] lot', lot.id, e && e.message);
      }
    }

    // ── REMINDER pass — ACTIVE lots expiring within reminderDays, remaining > 0.
    if (!dryRun && reminderDays > 0) {
      const horizon = addDays(now, reminderDays);
      const soon = await prisma.compOffCredit.findMany({
        where: { businessId: bId, status: 'ACTIVE', expiresOn: { gte: now, lte: horizon } },
        select: { id: true, employeeId: true, quantity: true, consumed: true, expiresOn: true },
        take: 20000,
      });
      // De-dupe one reminder per employee per run (the soonest-expiring lot drives it).
      const byEmp = new Map();
      for (const lot of soon) {
        const rem = Math.max(0, Number(lot.quantity) - Number(lot.consumed));
        if (rem <= 0) continue;
        const cur = byEmp.get(lot.employeeId);
        if (!cur || utcDay(lot.expiresOn) < utcDay(cur.expiresOn)) byEmp.set(lot.employeeId, { expiresOn: lot.expiresOn, days: rem });
        else if (utcDay(lot.expiresOn).getTime() === utcDay(cur.expiresOn).getTime()) cur.days += rem;
      }
      for (const [employeeId, info] of byEmp) {
        try {
          const emp = await prisma.employee.findFirst({
            where: { id: employeeId, businessId: bId }, select: { firstName: true, workEmail: true, personalEmail: true },
          });
          const email = emailOf(emp);
          if (!email) continue;
          await notifyHrEvent({
            businessId: bId, event: 'comp-off.expiring-soon', recipientEmail: email,
            variables: { NAME: (emp && emp.firstName) || 'there', DAYS: String(info.days), EXPIRES: isoDay(info.expiresOn), LEFT: String(daysBetween(now, info.expiresOn)), BIZ: '' },
            triggeredBy: 'COMP_OFF_EXPIRING_SOON',
          });
          summary.remindersSent += 1;
        } catch (_e) { /* best-effort */ }
      }
    }
  }
  summary.lapsedUnits = Math.round(summary.lapsedUnits * 1e4) / 1e4;
  return summary;
}

// ── CLI entry ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (p) => { const a = args.find((x) => x.startsWith(p)); return a ? a.split('=')[1] : null; };
  const businessId = get('--business=');
  const asOf = get('--asOf=') ? new Date(get('--asOf=')) : new Date();
  const dryRun = args.includes('--dry');
  runCompOffExpiry({ businessId, asOf, dryRun })
    .then((s) => { console.log('[comp-off expiry] summary', JSON.stringify(s)); return prisma.$disconnect(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[comp-off expiry] fatal', e); process.exit(1); });
}

module.exports = { runCompOffExpiry, _internals: { utcDay, addDays, isoDay, daysBetween } };

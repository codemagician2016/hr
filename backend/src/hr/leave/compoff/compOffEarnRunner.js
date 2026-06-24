'use strict';

/**
 * compOffEarnRunner.js — comp-off EARN orchestrator (Feature 30 §4.1). A nightly
 * runner modelled on `attendanceSweep.js` + `accrualRunner.js`: a tenant loop that
 * scans the persisted `HOLIDAY_WORKED` Attendance rows (the canonical EARN signal
 * `derive.js#classify` emits for a punched weekly-off / holiday, materialised by
 * `attendanceSweep`) and mints a CompOffCredit per worked rest-day.
 *
 * Why a runner, not a hook in derive.js: derive.js is PURE (no DB). The earn
 * side-effect belongs in an orchestrator reading the persisted row — the exact
 * layering attendanceSweep/accrualRunner already use. It also handles late /
 * regularized punches: a WEEKLY_OFF day later flipped to HOLIDAY_WORKED is picked
 * up by the next pass (and a reversal is voided — §6 edge case 3).
 *
 * Idempotency (finding #2): keyed on the IMMUTABLE attendanceId, NOT the runtime-
 * derived sourceKind. The @@unique(businessId, employeeId, attendanceId) makes a re-run
 * a no-op (a duplicate create throws P2002, which we swallow), so a holiday/weekly-off
 * classification FLIP between passes can never mint a second credit for the same worked
 * day; finalize is conditional-flip guarded; running twice over the same window mints
 * each credit exactly once (invariant 4).
 *
 * Tenant-isolated: every read/write is businessId-scoped. Per-employee/row failure
 * is logged + skipped — one bad row never aborts the tenant or the sweep.
 *
 * CLI: node src/hr/leave/compoff/compOffEarnRunner.js [--business=<id>] [--asOf=<iso>] [--lookback=<days>] [--dry]
 */

const prisma = require('../../../core/lib/prisma');
const { resolveCompOffType, creditQuantityForMinutes } = require('./compOffConfig');
const { finalizeCredit } = require('./finalizeCredit');
const { notifyHrEvent } = require('../../integrations/notifications');

const DEFAULT_LOOKBACK_DAYS = 3; // covers late punches / regularizations landing after the off-day

function utcDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}
function addDays(d, n) { return new Date(utcDay(d).getTime() + n * 86400000); }
function isoDay(d) { return utcDay(d).toISOString().slice(0, 10); }
function emailOf(emp) { return emp ? (emp.workEmail || emp.personalEmail || null) : null; }

/**
 * runCompOffEarn({ businessId?, asOf?, lookbackDays?, dryRun? }) — mint credits for
 * HOLIDAY_WORKED days in [asOf − lookback, asOf]. Returns
 * { scanned, minted, autoFinalized, pending, skipped, errors, tenants }.
 */
async function runCompOffEarn({ businessId = null, asOf = new Date(), lookbackDays = DEFAULT_LOOKBACK_DAYS, dryRun = false } = {}) {
  const now = utcDay(asOf);
  const from = addDays(now, -Math.abs(lookbackDays));
  const to = now; // inclusive: yesterday's sweep already materialised the row
  const summary = { scanned: 0, minted: 0, autoFinalized: 0, pending: 0, skipped: 0, errors: 0, tenants: 0 };

  const tenantIds = businessId
    ? [businessId]
    : (await prisma.business.findMany({ select: { id: true }, take: 10000 })).map((b) => b.id);

  for (const bId of tenantIds) {
    summary.tenants += 1;
    // Resolve the tenant's COMP_OFF type + config ONCE. No type seeded → skip tenant.
    let typeCtx;
    try {
      typeCtx = await resolveCompOffType(bId);
    } catch (e) {
      summary.errors += 1; continue;
    }
    if (!typeCtx || !typeCtx.leaveType) { continue; }
    const config = typeCtx.config;
    if (config.autoEarn === false) { continue; } // tenant opted out of auto-earn

    const rows = await prisma.attendance.findMany({
      where: { businessId: bId, status: 'HOLIDAY_WORKED', date: { gte: from, lte: to } },
      select: { id: true, employeeId: true, date: true, workedMinutes: true },
      take: 20000,
    });

    for (const row of rows) {
      summary.scanned += 1;
      try {
        const qty = creditQuantityForMinutes(row.workedMinutes, config);
        if (qty <= 0) { summary.skipped += 1; continue; } // didn't work enough → no credit

        // STABLE-KEY idempotency (finding #2): key on the IMMUTABLE attendance row, NOT
        // the runtime-derived sourceKind. A worked rest-day maps to exactly one
        // Attendance row; if its holiday/weekly-off classification flips between passes,
        // we must STILL mint only once. (The @@unique(businessId, employeeId,
        // attendanceId) is the belt; this is the early skip.)
        const exists = await prisma.compOffCredit.findFirst({
          where: { businessId: bId, employeeId: row.employeeId, attendanceId: row.id },
          select: { id: true },
        });
        if (exists) { summary.skipped += 1; continue; }

        // Resolve the employee + current employment (entity/location) ONCE — needed both
        // for the SCOPED holiday lookup (finding #3) and the mint metadata.
        const emp = await prisma.employee.findFirst({
          where: { id: row.employeeId, businessId: bId, deletedAt: null },
          select: { id: true, firstName: true, workEmail: true, personalEmail: true, managerEmployeeId: true },
        });
        if (!emp) { summary.skipped += 1; continue; }
        const employment = await prisma.employmentRecord.findFirst({
          where: { businessId: bId, employeeId: row.employeeId, isCurrent: true },
          select: { entityId: true, locationId: true, entity: { select: { taxYearStartMonth: true } } },
        });
        const taxYearStartMonth = (employment && employment.entity && employment.entity.taxYearStartMonth) || 4;
        const empEntityId = employment ? employment.entityId : null;
        const empLocationId = employment ? employment.locationId : null;

        // Source kind: a Holiday on that date that APPLIES TO THIS EMPLOYEE'S scope →
        // HOLIDAY, else WEEKLY_OFF (finding #3). An out-of-scope holiday (another
        // location's regional holiday) must NOT flip sourceKind or mis-route the
        // earnFrom opt-outs. Mirror derive.js scopeMatches: a holiday row matches when
        // its entity/location are null (tenant-wide) OR equal the employee's.
        const holidayCandidates = await prisma.holiday.findMany({
          where: { businessId: bId, date: row.date },
          select: { id: true, entityId: true, locationId: true },
        });
        const scopedHolidays = holidayCandidates.filter((h) =>
          (!h.entityId || h.entityId === empEntityId) && (!h.locationId || h.locationId === empLocationId));
        const sourceKind = scopedHolidays.length ? 'HOLIDAY' : 'WEEKLY_OFF';
        if (sourceKind === 'HOLIDAY' && config.earnFromHoliday === false) { summary.skipped += 1; continue; }
        if (sourceKind === 'WEEKLY_OFF' && config.earnFromWeeklyOff === false) { summary.skipped += 1; continue; }

        if (dryRun) { summary.minted += 1; continue; }

        const earnedOn = utcDay(row.date);
        const expiresOn = addDays(earnedOn, Number(config.expiryDays) || 60);
        const requireApproval = config.requireApproval !== false;

        const credit = await prisma.$transaction(async (tx) => {
          // Create the lot PENDING. The @@unique guard makes a concurrent double-mint
          // throw P2002 → the whole tx rolls back and we treat it as already-minted.
          const c = await tx.compOffCredit.create({
            data: {
              businessId: bId, employeeId: row.employeeId,
              sourceDate: earnedOn, sourceKind, attendanceId: row.id,
              quantity: qty, earnedOn, expiresOn, status: 'PENDING',
            },
          });
          if (!requireApproval) {
            await finalizeCredit(tx, { credit: c, leaveTypeId: typeCtx.leaveType.id, taxYearStartMonth });
          }
          return c;
        });

        summary.minted += 1;

        if (requireApproval) {
          // Open the earn-approval request OUTSIDE the mint tx (the engine owns its own
          // tx). Routed through the COMP_OFF WorkflowModule → its own consumer bundle.
          try {
            const engine = require('../../approvals/engine');
            const ar = await engine.openRequest({
              businessId: bId, module: 'COMP_OFF',
              entityType: 'CompOffCredit', entityId: credit.id,
              requesterEmployeeId: row.employeeId,
              payload: { sourceKind, sourceDate: isoDay(earnedOn), days: qty, expiresOn: isoDay(expiresOn) },
              ctx: { entityId: credit.id, days: qty },
            });
            const arId = (ar && ar.approvalRequest && ar.approvalRequest.id) || (ar && ar.id) || null;
            if (arId) await prisma.compOffCredit.update({ where: { id: credit.id }, data: { approvalRequestId: arId } });
          } catch (e) {
            // If the engine immediately auto-approved (tiny tenant / collapsed chain),
            // the COMP_OFF consumer already finalized the credit. A real failure is logged.
            if (e && e.code !== 'P2025') console.error('[comp-off earn] openRequest', credit.id, e.message);
          }
          summary.pending += 1;
          // Notify the manager that a credit awaits approval (best-effort).
          if (emp.managerEmployeeId) {
            const mgr = await prisma.employee.findFirst({
              where: { id: emp.managerEmployeeId, businessId: bId }, select: { workEmail: true, personalEmail: true },
            });
            const mgrEmail = emailOf(mgr);
            if (mgrEmail) {
              notifyHrEvent({
                businessId: bId, event: 'comp-off.earn-pending', recipientEmail: mgrEmail,
                variables: { BIZ: '', EMP: emp.firstName || 'An employee', SOURCE: sourceKind.replace('_', ' ').toLowerCase(), DATE: isoDay(earnedOn), DAYS: String(qty), LINK: '' },
                triggeredBy: 'COMP_OFF_EARN_PENDING',
              }).catch(() => {});
            }
          }
        } else {
          summary.autoFinalized += 1;
          const email = emailOf(emp);
          if (email) {
            notifyHrEvent({
              businessId: bId, event: 'comp-off.earned', recipientEmail: email,
              variables: { NAME: emp.firstName || 'there', DAYS: String(qty), SOURCE: sourceKind.replace('_', ' ').toLowerCase(), DATE: isoDay(earnedOn), EXPIRES: isoDay(expiresOn), BIZ: '' },
              triggeredBy: 'COMP_OFF_EARNED',
            }).catch(() => {});
          }
        }
      } catch (e) {
        // P2002 = the @@unique guard fired on a concurrent mint → idempotent no-op.
        if (e && e.code === 'P2002') { summary.skipped += 1; continue; }
        summary.errors += 1;
        console.error('[comp-off earn] row', row.id, e && e.message);
      }
    }
  }
  return summary;
}

// ── CLI entry (mirrors accrualRunner / attendanceSweep usage) ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (p) => { const a = args.find((x) => x.startsWith(p)); return a ? a.split('=')[1] : null; };
  const businessId = get('--business=');
  const asOf = get('--asOf=') ? new Date(get('--asOf=')) : new Date();
  const lookbackDays = get('--lookback=') ? Number(get('--lookback=')) : DEFAULT_LOOKBACK_DAYS;
  const dryRun = args.includes('--dry');
  runCompOffEarn({ businessId, asOf, lookbackDays, dryRun })
    .then((s) => { console.log('[comp-off earn] summary', JSON.stringify(s)); return prisma.$disconnect(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[comp-off earn] fatal', e); process.exit(1); });
}

module.exports = { runCompOffEarn, _internals: { utcDay, addDays, isoDay } };

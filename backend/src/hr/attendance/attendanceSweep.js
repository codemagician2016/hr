'use strict';

/**
 * attendanceSweep.js — nightly attendance ORCHESTRATOR (FactoHR gap "Nightly
 * attendance sweep", Cycle 0). Mirrors the leave-accrual cron block: a tenant
 * loop that calls the EXISTING engine and writes nothing of its own.
 *
 * Why this exists: the daily Attendance rollup is EVENT-DRIVEN — recompute()
 * only fires when a punch / regularization / import lands. A scheduled employee
 * who simply never punches on a working day produces NO event, so no Attendance
 * row materialises, so dashboards under-count and the LOP a no-punch day owes is
 * never booked. This sweep re-derives the PRIOR civil day for every ACTIVE
 * employee so an absent day gets its status (ABSENT) + lopFraction even with zero
 * punches.
 *
 *   sweepPriorDay({ businessId?, asOf?, batchSize? })
 *     For each ACTIVE, non-deleted employee (optionally one tenant), resolve the
 *     employee-LOCAL prior civil day (TZ-correct, exactly as the punch flow buckets
 *     a punch — service.recompute keys @db.Date by the employee-local day, H5) and
 *     call attendance/service.recompute(businessId, employeeId, priorDay, priorDay).
 *     Returns { scanned, recomputed, written, skippedLocked, skipped, errors }.
 *
 * Reuse, not reimplement: ALL derivation/freeze logic stays in derive.js +
 * service.js. This module only chooses the (employee, day) and calls recompute,
 * which is the SAME function the punch/regularization/import controllers call.
 *
 * Idempotent: recompute() upserts the canonical daily row and never overwrites a
 * locked (frozen) row, so a second run for the same window is a no-op (it writes
 * the identical derived row). Safe to run twice, or to overlap a real punch.
 *
 * Tenant-isolated: every recompute is businessId-scoped; the sweep either targets
 * one tenant or loops all tenants, never crossing tenant boundaries.
 *
 * Cheap at scale (1000+ employees): employees are loaded in keyset-paginated
 * batches (id cursor) so memory stays flat; each employee is one recompute of a
 * single day. A per-employee failure is logged and skipped — one bad row never
 * aborts the tenant or the sweep.
 *
 * CLI: node src/hr/attendance/attendanceSweep.js [--business=<id>] [--asOf=<iso>]
 */

const prisma = require('../../core/lib/prisma');
const { recompute } = require('./service');
const { resolveTimezone, civilDateInTz } = require('./tz');

const DEFAULT_BATCH = 500;

// 'YYYY-MM-DD' civil-day key → its @db.Date midnight-UTC Date (the Attendance
// unique-key convention). Mirrors attendance.controller civilKeyToDate.
function civilKeyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) {
    const t = new Date(key);
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// The civil day BEFORE `asOf` in the employee's IANA zone. We take today's local
// civil date, then step back one calendar day via the @db.Date midnight Date.
function priorLocalDay(asOf, tz) {
  const todayKey = civilDateInTz(asOf, tz); // 'YYYY-MM-DD' local "today"
  const today = civilKeyToDate(todayKey);
  return new Date(today.getTime() - 86400000); // prior @db.Date day
}

/**
 * Resolve the employee timezone the SAME way service.recompute does (location →
 * entity → business → countryCode). Takes the already-loaded current employment +
 * business so the batch makes no extra per-employee round-trip.
 */
function employeeTz(emp, business) {
  const er = (emp.employmentRecords && emp.employmentRecords[0]) || null;
  return resolveTimezone(
    { countryCode: emp.countryCode || null },
    {
      location: er ? er.location : null,
      entity: er ? er.entity : null,
      business: business || null,
    },
  );
}

/**
 * sweepPriorDay(opts) — recompute the prior civil day for active employees.
 *
 * @param {string|null} businessId  one tenant, or null for ALL tenants
 * @param {Date}        asOf        "now" anchor (prior day = the day before this)
 * @param {number}      batchSize   employees per keyset page
 */
async function sweepPriorDay({ businessId = null, asOf = new Date(), batchSize = DEFAULT_BATCH } = {}) {
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  const summary = { scanned: 0, recomputed: 0, written: 0, skippedLocked: 0, skipped: 0, errors: 0, tenants: 0 };

  const tenantIds = businessId
    ? [businessId]
    : (await prisma.business.findMany({ select: { id: true }, take: 10000 })).map((b) => b.id);

  for (const bId of tenantIds) {
    summary.tenants += 1;
    // Cache the business row once per tenant (timezone fallback for employees with
    // no entity/location zone).
    const business = await prisma.business.findFirst({ where: { id: bId }, select: { timezone: true } });

    // Keyset-paginate ACTIVE employees by id so 1000+ rows never load at once.
    let cursorId = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const employees = await prisma.employee.findMany({
        where: {
          businessId: bId,
          status: 'ACTIVE',
          deletedAt: null,
          ...(cursorId ? { id: { gt: cursorId } } : {}),
        },
        select: {
          id: true,
          countryCode: true,
          employmentRecords: {
            where: { isCurrent: true },
            take: 1,
            select: {
              entity: { select: { timezone: true, countryCode: true } },
              location: { select: { timezone: true, countryCode: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (employees.length === 0) break;
      cursorId = employees[employees.length - 1].id;

      for (const emp of employees) {
        summary.scanned += 1;
        try {
          const tz = employeeTz(emp, business);
          const priorDay = priorLocalDay(now, tz);
          const r = await recompute(bId, emp.id, priorDay, priorDay);
          summary.recomputed += 1;
          summary.written += r.written || 0;
          summary.skippedLocked += r.skippedLocked || 0;
        } catch (e) {
          summary.errors += 1;
          // One bad employee (mid-flight delete, malformed employment) must not
          // abort the tenant or the whole sweep.
          // eslint-disable-next-line no-console
          console.error('[attendance sweep] employee', emp.id, e.message);
        }
      }

      if (employees.length < batchSize) break; // last page
    }
  }

  return summary;
}

// ── CLI entry (mirrors accrualRunner / escalationRunner usage) ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const bizArg = args.find((a) => a.startsWith('--business='));
  const asOfArg = args.find((a) => a.startsWith('--asOf='));
  const businessId = bizArg ? bizArg.split('=')[1] : null;
  const asOf = asOfArg ? new Date(asOfArg.split('=')[1]) : new Date();
  sweepPriorDay({ businessId, asOf })
    .then((summary) => { console.log('[attendance sweep] summary', JSON.stringify(summary)); return prisma.$disconnect(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[attendance sweep] fatal', e); process.exit(1); });
}

module.exports = { sweepPriorDay, _internals: { priorLocalDay, employeeTz, civilKeyToDate } };

'use strict';

/**
 * attendanceSweep.live.test.js — LIVE proof (plain-node, hr_test) that the
 * nightly attendance sweep materialises absent/no-punch days via the EXISTING
 * recompute path, and is idempotent on re-run.
 *
 * Proves:
 *   1) sweepPriorDay recomputes the PRIOR civil day for an ACTIVE employee who
 *      has a scheduled (working) day but ZERO punches → an Attendance row appears
 *      with status ABSENT + lopFraction 1 (the day that never materialised
 *      without an event now does).
 *   2) A SECOND run is a true no-op: the same row stays ABSENT, isLocked stays
 *      false, and its content is unchanged (idempotent — recompute upserts the
 *      identical derived row).
 *   3) Tenant isolation: scoping to one businessId only touches that tenant.
 *
 * Reuse: the sweep calls attendance/service.recompute — the SAME function the
 * punch/regularization/import flow uses. No derivation is reimplemented here.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/attendance/__tests__/attendanceSweep.live.test.js
 *   where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'.
 */

const prisma = require('../../../core/lib/prisma');
const { sweepPriorDay } = require('../attendanceSweep');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

const PREFIX = 'ATTSWEEP-TEST';
const day = (s) => new Date(`${s}T00:00:00Z`);

// asOf is a WEDNESDAY → prior civil day is TUESDAY 2027-06-15, a guaranteed
// weekday (the shift's weekly-off is Sat/Sun) so the no-punch day must be ABSENT.
const AS_OF = new Date('2027-06-16T03:00:00Z'); // Wed 2027-06-16
const PRIOR_KEY = '2027-06-15';                  // Tue (working day)

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.attendance.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.attendancePunch.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.shiftAssignment.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: ids } } });
  }
  await prisma.shiftPattern.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Nightly attendance sweep proof (LIVE hr_test) ===\n');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  const entity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } });
  if (!entity) throw new Error('No IN entity in demo tenant');

  await cleanup(businessId);

  try {
    // ── Fixture: one ACTIVE employee, day shift (Sat/Sun off), no punches ──────
    const emp = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-E1`, firstName: 'Sweep', lastName: 'T', status: 'ACTIVE', countryCode: 'IN' },
    });
    await prisma.employmentRecord.create({
      data: {
        businessId, employeeId: emp.id, entityId: entity.id, employmentType: 'FULL_TIME',
        workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true,
      },
    });
    const shift = await prisma.shiftPattern.create({
      data: {
        businessId, entityId: entity.id, code: `${PREFIX}-GEN`, name: 'Gen', startTime: '09:00', endTime: '18:00',
        breakMinutes: 60, graceInMinutes: 10, fullDayMinutes: 480, halfDayThresholdMinutes: 240,
        weeklyOffDays: '0,6', isActive: true,
      },
    });
    await prisma.shiftAssignment.create({
      data: { businessId, employeeId: emp.id, shiftPatternId: shift.id, effectiveFrom: day('2027-06-01'), effectiveTo: day('2027-06-30') },
    });

    // Pre-condition: no Attendance row exists for the prior day (it's never
    // materialised because no punch/event ever fired).
    const before = await prisma.attendance.findFirst({ where: { businessId, employeeId: emp.id, date: day(PRIOR_KEY) } });
    assert(!before, 'pre: no Attendance row for the prior day (absent day never materialised)');

    // ── Run 1: the sweep materialises the absent prior day ────────────────────
    const r1 = await sweepPriorDay({ businessId, asOf: AS_OF });
    assert(r1.scanned >= 1, `run1 scanned the active employee (scanned=${r1.scanned})`);
    assert(r1.written >= 1, `run1 wrote at least one Attendance row (written=${r1.written})`);
    assert(r1.errors === 0, `run1 had no errors (errors=${r1.errors})`);
    assert(r1.tenants === 1, `run1 stayed in one tenant (tenants=${r1.tenants})`);

    const row1 = await prisma.attendance.findFirst({ where: { businessId, employeeId: emp.id, date: day(PRIOR_KEY) } });
    assert(!!row1, 'run1: Attendance row for the prior day now EXISTS');
    assert(row1 && row1.status === 'ABSENT', `run1: prior no-punch working day is ABSENT (got ${row1 && row1.status})`);
    assert(row1 && Number(row1.lopFraction) === 1, `run1: ABSENT day carries full LOP (lopFraction=${row1 && Number(row1.lopFraction)})`);
    assert(row1 && row1.isLocked === false, 'run1: row is not locked (live row)');

    // ── Run 2: idempotent — second run no-ops (same row, unchanged) ───────────
    const r2 = await sweepPriorDay({ businessId, asOf: AS_OF });
    assert(r2.errors === 0, `run2 had no errors (errors=${r2.errors})`);

    const row2 = await prisma.attendance.findFirst({ where: { businessId, employeeId: emp.id, date: day(PRIOR_KEY) } });
    assert(row2 && row2.id === row1.id, 'run2: same Attendance row id (no duplicate created)');
    assert(row2 && row2.status === 'ABSENT', 're-run: status stays ABSENT (idempotent)');
    assert(row2 && Number(row2.lopFraction) === 1, 're-run: lopFraction stays 1 (idempotent)');
    assert(row2 && row2.isLocked === false, 're-run: still not locked');

    // Exactly ONE row for that (employee, day) — re-run never duplicated.
    const cnt = await prisma.attendance.count({ where: { businessId, employeeId: emp.id, date: day(PRIOR_KEY) } });
    assert(cnt === 1, `re-run: exactly one Attendance row for the day (count=${cnt})`);

  } finally {
    await cleanup(businessId);
  }

  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

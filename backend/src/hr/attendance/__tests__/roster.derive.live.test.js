'use strict';

/**
 * roster.derive.live.test.js — Feature 29 PROOF that service.recompute consults the
 * PUBLISHED roster (precedence over ShiftAssignment), and IGNORES a DRAFT cell, against
 * LIVE hr_test. Plain-node harness.
 *
 * Asserts:
 *   (1) A PUBLISHED WORK roster cell drives the day's shift (Attendance.shiftPatternId
 *       == the roster pattern, not the covering assignment).
 *   (2) A PUBLISHED OFF roster cell → WEEKLY_OFF (no punches).
 *   (3) A DRAFT roster cell is NOT read: derivation falls back to the assignment.
 *   (4) A night PUBLISHED cell with a 22:00→06:00 span: no false EARLY_OUT.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/attendance/__tests__/roster.derive.live.test.js
 */

const prisma = require('../../../core/lib/prisma');
const { recompute } = require('../service');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'ROSTERDERIVE-TEST';
function utcDay(s) { const d = new Date(s); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }

async function cleanup(businessId) {
  await prisma.rosterDay.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.attendance.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.attendancePunch.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.shiftAssignment.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.shiftPattern.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } });
}

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) { log('SKIP — no demo business in hr_test'); return; }
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    const user = await prisma.user.create({ data: { businessId, email: `${PREFIX.toLowerCase()}-${Date.now()}@t.test`, password: 'x', name: 'R', role: 'USER', isActive: true } });
    const emp = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-1`, firstName: 'R', lastName: 'T', status: 'ACTIVE', userId: user.id, hireDate: new Date('2020-01-01') } });

    const dayShift = await prisma.shiftPattern.create({ data: { businessId, code: `${PREFIX}-DAY`, name: 'Day', startTime: '09:00', endTime: '18:00', fullDayMinutes: 480, weeklyOffDays: '0' } });
    const nightShift = await prisma.shiftPattern.create({ data: { businessId, code: `${PREFIX}-NIGHT`, name: 'Night', startTime: '22:00', endTime: '06:00', fullDayMinutes: 420, isNightShift: true, crossesMidnight: true, weeklyOffDays: '0' } });

    // Covering assignment uses the DAY shift for the whole window (the v1 fallback).
    await prisma.shiftAssignment.create({ data: { businessId, employeeId: emp.id, shiftPatternId: dayShift.id, effectiveFrom: utcDay('2026-09-01'), effectiveTo: null } });

    // ── 1: a PUBLISHED WORK roster cell (NIGHT) overrides the DAY assignment ───
    const D1 = '2026-09-10';
    await prisma.rosterDay.create({ data: { businessId, employeeId: emp.id, date: utcDay(D1), dayType: 'WORK', shiftPatternId: nightShift.id, status: 'PUBLISHED', source: 'MANUAL' } });
    // A night span punch pair (22:00 → 06:00 next day, UTC for the demo tz simplicity).
    await prisma.attendancePunch.create({ data: { businessId, employeeId: emp.id, punchType: 'IN', punchAt: new Date('2026-09-10T22:00:00Z'), source: 'WEB' } });
    await prisma.attendancePunch.create({ data: { businessId, employeeId: emp.id, punchType: 'OUT', punchAt: new Date('2026-09-11T06:00:00Z'), source: 'WEB' } });

    // ── 2: a PUBLISHED OFF roster cell → WEEKLY_OFF (no punches; clear of the
    //      night span's post-midnight OUT, which would otherwise mark it worked) ─
    const D2 = '2026-09-13';
    await prisma.rosterDay.create({ data: { businessId, employeeId: emp.id, date: utcDay(D2), dayType: 'OFF', status: 'PUBLISHED', source: 'ROTATION' } });

    // ── 3: a DRAFT roster cell (NIGHT) must be IGNORED → falls back to DAY ─────
    const D3 = '2026-09-15';
    await prisma.rosterDay.create({ data: { businessId, employeeId: emp.id, date: utcDay(D3), dayType: 'WORK', shiftPatternId: nightShift.id, status: 'DRAFT', source: 'MANUAL' } });

    await recompute(businessId, emp.id, utcDay(D1), utcDay(D3));

    const att1 = await prisma.attendance.findFirst({ where: { businessId, employeeId: emp.id, date: utcDay(D1) } });
    const att2 = await prisma.attendance.findFirst({ where: { businessId, employeeId: emp.id, date: utcDay(D2) } });
    const att3 = await prisma.attendance.findFirst({ where: { businessId, employeeId: emp.id, date: utcDay(D3) } });

    assert(att1 && att1.shiftPatternId === nightShift.id, '(1) PUBLISHED WORK cell drives the NIGHT shift (overrides DAY assignment)');
    const flags1 = (att1 && att1.exceptionsJson && att1.exceptionsJson.flags) || [];
    assert(att1 && !flags1.includes('EARLY_OUT'), '(4) night roster cell → no false EARLY_OUT');
    assert(att2 && att2.status === 'WEEKLY_OFF', '(2) PUBLISHED OFF cell → WEEKLY_OFF');
    assert(att3 && att3.shiftPatternId === dayShift.id, '(3) DRAFT cell IGNORED → falls back to DAY assignment');
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\nroster derive: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

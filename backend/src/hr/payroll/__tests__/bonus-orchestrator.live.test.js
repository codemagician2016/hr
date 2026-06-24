'use strict';

/*
 * bonus-orchestrator.live.test.js — LIVE (hr_test) proof of the three CONFIRMED
 * Statutory-Bonus orchestrator fixes in payroll/bonus.service.js (Feature 22):
 *
 *   FIX-1 (HIGH) — concurrent approveBonusCycle double-mints PayRun(BONUS):
 *       two concurrent approves must yield EXACTLY ONE PayRun(BONUS); the loser is
 *       a no-op (the atomic conditional updateMany inside the mint transaction).
 *   FIX-2 (HIGH) — worked-days fallback clobbers a legitimate ZERO:
 *       a full-year LWP/AWOL employee (attendance frozen, payableDays sum = 0) must
 *       FAIL the §8 ≥30-day gate (UNDER_30_DAYS, gross ₹0) — NOT silently paid as if
 *       present all year. A salaried employee with NO attendance frozen still pays.
 *   FIX-3 (MED) — §13 eligibleMonths from worked/deemed days, not the calendar window:
 *       LWP reduces eligibleMonths (and the payout); the proration is driven by the
 *       summed payableDays, capped at the active employment window.
 *
 * Plain-node (built-in assert, NO jest), mirrors run-orchestration.live.test.js.
 *
 * Run (DATABASE_URL must target the hr_test schema):
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/__tests__/bonus-orchestrator.live.test.js
 * where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'. Uses the seed
 * 'demo' tenant IN-HQ entity/calendar. Every row written is torn down at the end.
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const bonus = require('../bonus.service');
const indiaCore = require('../bonus'); // pure core, to derive expecteds by hand

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
function eq(actual, expected, msg) { ok(actual === expected, `${msg} (got ${actual}, expected ${expected})`); }

const PREFIX = 'F22BON';
const MAKER = 'maker-actor-f22';
const CHECKER = 'checker-actor-f22';
const ACCOUNTING_YEAR = '2025-26';
const FY_START = new Date(Date.UTC(2025, 3, 1));   // 2025-04-01
const FY_END = new Date(Date.UTC(2026, 2, 31));    // 2026-03-31
const FY_DAYS = Math.round((FY_END - FY_START) / 86400000) + 1; // 365

function d(y, m, day) { return new Date(Date.UTC(y, m - 1, day)); }

async function cleanup(businessId, entityId) {
  // Bonus cycles (+ awards cascade) and any minted bonus PayRuns for our prefix.
  const cycles = await prisma.bonusCycle.findMany({ where: { businessId, entityId, accountingYear: ACCOUNTING_YEAR, notes: { contains: PREFIX } }, select: { id: true, payRunId: true } });
  // Also catch cycles we created without notes match (defensive): by our test employees below.
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const empIds = emps.map((e) => e.id);

  // Any PayRun(BONUS) minted for this entity/FY whose code starts with BON- and headcount touches our emps — clear via cycle payRunId + any stray.
  const cyclePayRunIds = cycles.map((c) => c.payRunId).filter(Boolean);
  const bonusRuns = await prisma.payRun.findMany({ where: { businessId, entityId, type: 'BONUS', taxYear: ACCOUNTING_YEAR }, select: { id: true } });
  const allRunIds = [...new Set([...cyclePayRunIds, ...bonusRuns.map((r) => r.id)])];
  if (allRunIds.length) {
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: allRunIds } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: allRunIds } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: allRunIds } } });
    await prisma.payRun.deleteMany({ where: { id: { in: allRunIds } } });
  }
  await prisma.bonusAward.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
  await prisma.bonusCycle.deleteMany({ where: { businessId, entityId, accountingYear: ACCOUNTING_YEAR } });
  // Attendance + dummy attendance PayRuns + comp + employment + employees.
  await prisma.attendancePayInput.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
  const attRuns = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const attRunIds = attRuns.map((r) => r.id);
  if (attRunIds.length) {
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: attRunIds } } });
    await prisma.payRun.deleteMany({ where: { id: { in: attRunIds } } });
  }
  await prisma.salaryComponentLine.deleteMany({ where: { businessId, compensation: { employeeId: { in: empIds } } } });
  // Detach currentCompensationId before deleting comp revisions.
  await prisma.employee.updateMany({ where: { id: { in: empIds } }, data: { currentCompensationId: null } });
  await prisma.compensationRevision.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
  await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
}

async function mkEmployee(businessId, entityId, code, basicRupees) {
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'Test', isActive: true },
  });
  await prisma.employmentRecord.create({
    data: {
      businessId, employeeId: emp.id, entityId,
      employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE',
      effectiveFrom: FY_START, effectiveTo: null, isCurrent: true,
    },
  });
  const comp = await prisma.compensationRevision.create({
    data: {
      businessId, employeeId: emp.id, entityId,
      currencyCode: 'INR', basis: 'CTC', revisionReason: 'HIRE',
      effectiveFrom: FY_START, effectiveTo: null, isCurrent: true,
    },
  });
  await prisma.salaryComponentLine.create({
    data: {
      businessId, compensationId: comp.id, componentId: BASIC_COMPONENT_ID,
      calcMethod: 'FLAT', amountMonthly: basicRupees.toFixed(2), sortOrder: 0,
    },
  });
  await prisma.employee.update({ where: { id: emp.id }, data: { currentCompensationId: comp.id } });
  return emp;
}

/** Freeze attendance for an employee across the FY summing to `payableDays` total
 *  (one dummy DRAFT PayRun owns the AttendancePayInput rows). */
async function freezeAttendance(businessId, entityId, calId, employeeId, payableDaysTotal, suffix) {
  const dummy = await prisma.payRun.create({
    data: {
      businessId, entityId, payCalendarId: calId,
      code: `${PREFIX}-ATT-${suffix}`,
      periodStart: FY_START, periodEnd: FY_END, payDate: FY_END,
      sequenceInYear: 0, taxYear: ACCOUNTING_YEAR, currencyCode: 'INR', status: 'DRAFT',
    },
  });
  await prisma.attendancePayInput.create({
    data: {
      businessId, payRunId: dummy.id, employeeId,
      periodStart: FY_START, periodEnd: FY_END,
      calendarDays: FY_DAYS, payableDays: payableDaysTotal,
      lwpDays: Math.max(0, FY_DAYS - payableDaysTotal), absentDays: 0,
    },
  });
  return dummy.id;
}

let BASIC_COMPONENT_ID = null;

async function main() {
  log('\n=== Feature 22 bonus-orchestrator proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } });
  if (!inEntity) throw new Error('Seed IN-HQ entity not found');
  const cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id, isActive: true } });
  if (!cal) throw new Error('Seed IN-HQ pay calendar not found');
  const basic = await prisma.salaryComponent.findFirst({ where: { businessId, kind: 'BASIC' } });
  if (!basic) throw new Error('Seed BASIC component not found');
  BASIC_COMPONENT_ID = basic.id;

  await cleanup(businessId, inEntity.id);

  // ── Seed 3 employees, all Basic ₹10,000 (≤ ₹21k ceiling; capped to ₹7k calc base).
  //   EMP-F: salaried, NO attendance frozen        → full year, 12 months, ₹6,997.
  //   EMP-Z: attendance frozen, payableDays SUM = 0 → full-year LWP, §8 FAIL.
  //   EMP-P: attendance frozen, payableDays = 180   → §13 prorated payout.
  const BASIC = 10000;
  const empF = await mkEmployee(businessId, inEntity.id, 'F', BASIC);
  const empZ = await mkEmployee(businessId, inEntity.id, 'Z', BASIC);
  const empP = await mkEmployee(businessId, inEntity.id, 'P', BASIC);
  await freezeAttendance(businessId, inEntity.id, cal.id, empZ.id, 0, 'Z');   // genuine 0
  const PWORKED = 180;
  await freezeAttendance(businessId, inEntity.id, cal.id, empP.id, PWORKED, 'P');

  // ── Create + compute the cycle. ──
  const created = await bonus.createBonusCycle({
    businessId, actorId: MAKER, entityId: inEntity.id, accountingYear: ACCOUNTING_YEAR,
    notes: `${PREFIX} concurrency + zero-worked + s13 proof`,
  });
  const cycleId = created.id;
  const computed = await bonus.computeBonusCycle({ businessId, actorId: MAKER, bonusCycleId: cycleId });
  const byEmp = Object.fromEntries(computed.awards.map((a) => [a.employeeId, a]));
  const aF = byEmp[empF.id];
  const aZ = byEmp[empZ.id];
  const aP = byEmp[empP.id];

  // ── Hand-derived expecteds via the PURE core (same arithmetic the orchestrator feeds).
  //   Capped base = min(10,000, 7,000) = ₹7,000.
  const fullAward = indiaCore.computeBonusCycle(
    { accountingYearEnd: '2026-03-31', rateBasisPoints: 833 },
    [{ employeeId: 'x', monthlyBasicDaMinor: 1000000, eligibleMonths: 12, workedDays: 365 }],
  ).awards[0];
  const pMonths = Math.round((PWORKED / FY_DAYS) * 12 * 100) / 100; // 2dp, the orchestrator's formula
  const prorAward = indiaCore.computeBonusCycle(
    { accountingYearEnd: '2026-03-31', rateBasisPoints: 833 },
    [{ employeeId: 'x', monthlyBasicDaMinor: 1000000, eligibleMonths: pMonths, workedDays: PWORKED }],
  ).awards[0];

  // ── FIX-2: EMP-Z (full-year LWP, payableDays sum 0) is INELIGIBLE under §8. ──
  eq(aZ.eligible, false, 'FIX-2 EMP-Z (0 worked days) is INELIGIBLE');
  eq(aZ.ineligibleReason, 'UNDER_30_DAYS', 'FIX-2 EMP-Z reason = UNDER_30_DAYS (§8)');
  eq(aZ.grossBonusMinor, 0, 'FIX-2 EMP-Z gross bonus = ₹0 (not wrongly paid)');
  eq(aZ.workedDays, 0, 'FIX-2 EMP-Z workedDays stays 0 (no clobber to active window)');

  // ── FIX-2 (other half): EMP-F (NO attendance frozen) is paid the full year. ──
  eq(aF.eligible, true, 'FIX-2 EMP-F (no attendance) is ELIGIBLE (salaried default)');
  eq(aF.eligibleMonths, 12, 'FIX-2 EMP-F eligibleMonths = 12 (full year)');
  eq(aF.grossBonusMinor, fullAward.grossBonusMinor, `FIX-2 EMP-F gross = ₹${fullAward.grossBonusMinor / 100} (full-year)`);

  // ── FIX-3: EMP-P §13 proration reflects worked days, NOT the calendar window. ──
  eq(aP.eligible, true, 'FIX-3 EMP-P (180 worked days) is ELIGIBLE (>30)');
  eq(aP.eligibleMonths, pMonths, `FIX-3 EMP-P eligibleMonths = ${pMonths} (from worked days, not 12)`);
  ok(aP.eligibleMonths < 12, 'FIX-3 EMP-P eligibleMonths reduced below the calendar 12 by LWP');
  eq(aP.grossBonusMinor, prorAward.grossBonusMinor, `FIX-3 EMP-P gross = ₹${prorAward.grossBonusMinor / 100} (prorated < full-year)`);
  ok(aP.grossBonusMinor < fullAward.grossBonusMinor, 'FIX-3 EMP-P payout strictly less than the full-year payout');

  // ── FIX-1: CONCURRENT approve must mint EXACTLY ONE PayRun(BONUS). ──
  // Maker computed; CHECKER ≠ MAKER approves (maker-checker SoD). Fire two approves
  // concurrently; one wins, one must be a no-op (ALREADY_MINTED) — never two PayRuns.
  const results = await Promise.allSettled([
    bonus.approveBonusCycle({ businessId, actorId: CHECKER, bonusCycleId: cycleId }),
    bonus.approveBonusCycle({ businessId, actorId: CHECKER, bonusCycleId: cycleId }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  ok(fulfilled.length >= 1, `FIX-1 at least one approve succeeds (${fulfilled.length} fulfilled)`);

  // The decisive assertion: exactly ONE PayRun(BONUS) exists for this cycle/FY.
  const finalCycle = await prisma.bonusCycle.findUnique({ where: { id: cycleId } });
  const bonusRuns = await prisma.payRun.findMany({
    where: { businessId, entityId: inEntity.id, type: 'BONUS', taxYear: ACCOUNTING_YEAR },
    select: { id: true, totalNet: true, headcount: true },
  });
  eq(bonusRuns.length, 1, 'FIX-1 EXACTLY ONE PayRun(BONUS) minted (no double-mint)');
  ok(finalCycle.status === 'APPROVED' && finalCycle.payRunId === bonusRuns[0].id, 'FIX-1 cycle bound to the single minted PayRun');
  eq(bonusRuns[0].headcount, 2, 'FIX-1 minted run headcount = 2 (only F + P eligible; Z excluded)');
  // The loser is a benign conflict (ALREADY_MINTED), never a second mint.
  ok(rejected.length === 0 || rejected.every((r) => r.reason && (r.reason.code === 'ALREADY_MINTED' || r.reason.reason === 'ALREADY_MINTED')),
    `FIX-1 concurrent loser (if any) is ALREADY_MINTED no-op (${rejected.length} rejected)`);

  // Net of the single run = F + P eligible nets (Z paid nothing).
  const expectedNet = (fullAward.netBonusMinor + prorAward.netBonusMinor) / 100;
  eq(Number(bonusRuns[0].totalNet), expectedNet, `FIX-1 single-run net = ₹${expectedNet} (F + P only)`);

  await cleanup(businessId, inEntity.id);

  log('');
  if (failures === 0) {
    log('bonus-orchestrator LIVE: ALL PASS');
  } else {
    log(`bonus-orchestrator LIVE: ${failures} FAILURE(S)`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });

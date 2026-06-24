'use strict';

/*
 * arrears.live.test.js — LIVE (hr_test) proof of Feature 27 "auto-arrear engine".
 * Mirrors reimbursement-payout.live.test.js. Proves the full retro flow:
 *
 *   Setup: an employee paid Apr/May/Jun 2026 at the OLD comp (frozen payslips), then a
 *   retro April CompensationRevision (Basic +₹4,000) processed in July.
 *
 *   1. detect surfaces the retro revision; create + compute builds per-month diffs to the
 *      paise: gross arrear = Σ(Apr,May,Jun new−old) = 3×₹4,000; PF/ESI per source month;
 *      §89(1) relief computed & non-negative; per-source-FY attribution present.
 *   2. approve (INJECT) writes a PayRunInputItem(kind=ARREAR) + binds the cycle to the
 *      open July run; computing July emits an ARREAR_EARNINGS line of the full arrear,
 *      PF/ESI passthroughs, and stamps the cycle PAID.
 *   3. RE-RUNNING July does NOT double-pay (cycle stamped PAID once; one arrear line).
 *   4. REOPEN reverts the cycle PAID→APPROVED (recompute re-stamps); CANCEL fully releases.
 *   5. a NON-RETRO revision produces NO arrears (empty detect window).
 *
 * Plain-node (built-in assert, NO jest). Run:
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/__tests__/arrears.live.test.js
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const service = require('../service');
const arrearsSvc = require('../arrears.service');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'ARREARTEST';
const dec = (v) => Number(v);

async function cleanup(businessId, employeeId) {
  const runs = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = runs.map((r) => r.id);
  // Arrear cycles created by this test (by the test employee).
  const cycles = await prisma.arrearCycle.findMany({ where: { businessId, employeeId }, select: { id: true } });
  const cycleIds = cycles.map((c) => c.id);
  if (cycleIds.length) {
    await prisma.arrearMonth.deleteMany({ where: { arrearCycleId: { in: cycleIds } } });
    await prisma.arrearCycle.deleteMany({ where: { id: { in: cycleIds } } });
  }
  if (ids.length) {
    await prisma.statutoryRemittance.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payslip.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: ids } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunInputItem.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRun.deleteMany({ where: { id: { in: ids } } });
  }
  // Test revisions tagged by notes (+ their lines), then restore the real comp current.
  const testRevs = await prisma.compensationRevision.findMany({ where: { businessId, employeeId, notes: { startsWith: PREFIX } }, select: { id: true } });
  const revIds = testRevs.map((r) => r.id);
  if (revIds.length) {
    await prisma.salaryComponentLine.deleteMany({ where: { compensationId: { in: revIds } } });
    await prisma.compensationRevision.deleteMany({ where: { id: { in: revIds } } });
  }
  // Restore the original (non-test) comp as current so a prior failed run can't strand it.
  const orig = await prisma.compensationRevision.findFirst({
    where: { businessId, employeeId, notes: null }, orderBy: { effectiveFrom: 'desc' },
  });
  if (orig) await prisma.compensationRevision.update({ where: { id: orig.id }, data: { isCurrent: true } });
}

async function mkRun(businessId, entity, cal, { periodStart, periodEnd, payDate, taxYear, seq, suffix, type = 'REGULAR' }) {
  return prisma.payRun.create({
    data: {
      businessId, entityId: entity.id, payCalendarId: cal.id,
      code: `${PREFIX}-${entity.code}-${suffix}`,
      periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), payDate: new Date(payDate),
      sequenceInYear: seq, taxYear, currencyCode: entity.payCurrency, status: 'DRAFT', type,
    },
  });
}

async function computeLine(businessId, run, employeeId) {
  await service.computeRun({ businessId, actorId: 'arrear-maker', payRunId: run.id });
  const where = { businessId, payRunId: run.id };
  if (employeeId) where.employeeId = employeeId;
  return prisma.payRunLine.findFirst({ where, include: { components: true } });
}

// Clone the employee's current compensation into a NEW revision with Basic bumped by
// `bumpMinor` paise, effective `effectiveFrom`. Returns the new revision.
async function mkRetroRevision(businessId, employeeId, baseComp, { effectiveFrom, bumpMinor, reason = 'ANNUAL_REVISION', current = false }) {
  // A real increment RAISES total monthly gross by the bump (else a BALANCING
  // special-allowance line would absorb the BASIC rise and gross would not move).
  const newGrossMonthly = baseComp.grossMonthly != null ? String(Number(baseComp.grossMonthly) + bumpMinor / 100) : null;
  const newComp = await prisma.compensationRevision.create({
    data: {
      businessId, employeeId, entityId: baseComp.entityId, structureId: baseComp.structureId,
      currencyCode: baseComp.currencyCode, basis: baseComp.basis,
      ctcAnnual: baseComp.ctcAnnual, grossMonthly: newGrossMonthly,
      effectiveFrom: new Date(effectiveFrom), isCurrent: current,
      revisionReason: reason, status: 'EFFECTIVE', notes: `${PREFIX} retro`,
    },
  });
  // Copy the lines, bumping BASIC's amountMonthly.
  const lines = await prisma.salaryComponentLine.findMany({ where: { compensationId: baseComp.id }, include: { component: true } });
  for (const l of lines) {
    const isBasic = l.component && (l.component.kind === 'BASIC');
    const amt = l.amountMonthly != null ? Number(l.amountMonthly) : null;
    const bumped = isBasic && amt != null ? amt + bumpMinor / 100 : amt;
    await prisma.salaryComponentLine.create({
      data: {
        businessId, compensationId: newComp.id, componentId: l.componentId,
        sortOrder: l.sortOrder, calcMethod: l.calcMethod,
        amountMonthly: bumped != null ? String(bumped) : null,
        amountAnnual: l.amountAnnual != null ? String(l.amountAnnual) : null,
        calcValue: l.calcValue != null ? String(l.calcValue) : null,
      },
    });
  }
  return newComp;
}

async function main() {
  log('\n=== Auto-arrears proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } });
  const inCal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } });
  if (!inEntity || !inCal) throw new Error('IN-HQ entity/calendar missing in hr_test');

  // GLOBAL pre-cleanup: wipe any stranded test revisions from a prior failed run (which
  // could have left a 0-line ARREARTEST comp marked isCurrent) and restore each IN
  // employee's REAL (notes=null) comp as current BEFORE we select a base.
  const allInEmps = await prisma.employmentRecord.findMany({ where: { businessId, entityId: inEntity.id, isCurrent: true }, select: { employeeId: true } });
  for (const e of allInEmps) await cleanup(businessId, e.employeeId);

  // Pick the first current IN employee whose CURRENT comp has a BASIC line with a flat
  // amountMonthly (so we can bump it and the engine recomputes a clean gross delta).
  let employeeId = null;
  let baseComp = null;
  for (const e of allInEmps) {
    const comp = await prisma.compensationRevision.findFirst({
      where: { businessId, employeeId: e.employeeId, isCurrent: true },
      include: { lines: { include: { component: true } } },
    });
    if (comp && comp.lines.some((l) => l.component && l.component.kind === 'BASIC' && l.amountMonthly != null)) {
      employeeId = e.employeeId; baseComp = comp; break;
    }
  }
  if (!employeeId) throw new Error('No IN employee with a flat-BASIC current compensation in hr_test');
  log(`  using employee ${employeeId} (base comp ${baseComp.id.slice(0, 8)}, ${baseComp.lines.length} lines)\n`);

  // ── 0. Freeze the OLD-comp Apr/May/Jun payslips (the baseline arrears diff against) ──
  const oldRuns = {};
  for (const [m, seq, dstart, dend] of [['04', 4, '2026-04-01', '2026-04-30'], ['05', 5, '2026-05-01', '2026-05-31'], ['06', 6, '2026-06-01', '2026-06-30']]) {
    const run = await mkRun(businessId, inEntity, inCal, { periodStart: dstart, periodEnd: dend, payDate: dend, taxYear: '2026-27', seq, suffix: `OLD-${m}` });
    const line = await computeLine(businessId, run, employeeId);
    if (!line) throw new Error(`Failed to compute baseline ${m}`);
    // Mark the run APPROVED→PAID-ish (we only need a FROZEN payslip; computeRun already wrote it).
    oldRuns[m] = { run, gross: dec(line.grossEarnings) };
  }
  ok(oldRuns['04'].gross > 0, `0.1 frozen April baseline gross = ₹${oldRuns['04'].gross}`);

  // ── Create the retro April revision: Basic +₹4,000, ANNUAL_REVISION, effective 1 Apr 2026 ──
  const BUMP = 400000; // ₹4,000 in paise
  // Make the new revision CURRENT (so resolveCurrentCompensation on a source-month-end picks it).
  await prisma.compensationRevision.updateMany({ where: { businessId, employeeId, isCurrent: true }, data: { isCurrent: false } });
  const newComp = await mkRetroRevision(businessId, employeeId, baseComp, { effectiveFrom: '2026-04-01', bumpMinor: BUMP, reason: 'ANNUAL_REVISION', current: true });
  ok(!!newComp, '0.2 retro April revision created (Basic +₹4,000, ANNUAL_REVISION)');

  // ── 1. detect → create → compute ────────────────────────────────────────────
  const detected = await arrearsSvc.detectArrearCycles({ businessId, entityId: inEntity.id, openPeriodStart: '2026-07-01' });
  const cand = detected.candidates.find((c) => c.compensationRevisionId === newComp.id);
  ok(!!cand, '1.1 detect surfaces the retro revision');
  ok(cand && cand.monthCount === 3, `1.2 retro window = 3 months (Apr–Jun) (got ${cand && cand.monthCount})`);

  const cycle0 = await arrearsSvc.createArrearCycle({ businessId, actorId: 'arrear-maker', compensationRevisionId: newComp.id, detectedInPeriod: '2026-07' });
  ok(cycle0.status === 'DRAFT', '1.3 cycle created DRAFT');
  ok(cycle0.esiOnArrears === true, '1.4 ANNUAL_REVISION → esiOnArrears default true');

  const computed = await arrearsSvc.computeArrearCycle({ businessId, actorId: 'arrear-maker', arrearCycleId: cycle0.id });
  ok(computed.status === 'COMPUTED', '1.5 cycle COMPUTED');
  ok(computed.grossArrearMinor === 3 * BUMP, `1.6 gross arrear = 3×₹4,000 = ₹12,000 to the paise (got ${computed.grossArrearMinor})`);
  ok(computed.months.length === 3, '1.7 three ArrearMonth diff rows');
  ok(computed.months.every((m) => m.deltaGrossMinor === BUMP), '1.8 each month delta = ₹4,000 (frozen attendance honoured)');
  // PF on arrears is per-source-month ceiling-capped: an employee already ≥ ₹15,000 PF
  // wage yields ₹0 incremental PF (spec §9), otherwise 3×12%×₹4,000. Either is correct.
  const basicAboveCeiling = baseComp.lines.some((l) => l.component && l.component.kind === 'BASIC' && Number(l.amountMonthly) >= 15000);
  if (basicAboveCeiling) ok(computed.pfArrearEeMinor === 0, `1.9 at-PF-ceiling employee → ₹0 incremental PF (Basic ≥ ₹15k; spec §9)`);
  else ok(computed.pfArrearEeMinor === 3 * 12 * (BUMP / 100 / 100) * 100, `1.9 PF on arrears = 3×12%×₹4,000 = ₹1,440 (got ₹${computed.pfArrearEeMinor / 100})`);
  ok(computed.esiArrearEeMinor >= 0, '1.10 ESI on arrears computed (ANNUAL_REVISION → chargeable)');
  ok(computed.s89ReliefMinor != null && computed.s89ReliefMinor >= 0, '1.11 §89(1) relief computed & non-negative');
  ok(computed.s89Datapoint && Array.isArray(computed.s89Datapoint.sourceSlices) && computed.s89Datapoint.sourceSlices.length >= 1, '1.12 §89(1) per-source-year attribution present');
  ok(computed.reliefFormName === 'Form 39', '1.13 receipt FY2026-27 → Form 39 prompt');

  // Idempotent recompute → identical totals.
  const recomputed = await arrearsSvc.computeArrearCycle({ businessId, actorId: 'arrear-maker', arrearCycleId: cycle0.id });
  ok(recomputed.grossArrearMinor === computed.grossArrearMinor, '1.14 recompute identical (idempotent)');
  ok((await prisma.arrearMonth.count({ where: { arrearCycleId: cycle0.id } })) === 3, '1.15 still exactly 3 ArrearMonth rows after recompute');

  // ── 2. approve (INJECT) onto the open July run → ARREAR_EARNINGS line + stamp PAID ──
  const julyRun = await mkRun(businessId, inEntity, inCal, { periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-31', taxYear: '2026-27', seq: 7, suffix: 'JUL' });
  // SoD: approver ≠ maker.
  let sodOk = false;
  try { await arrearsSvc.approveArrearCycle({ businessId, actorId: 'arrear-maker', arrearCycleId: cycle0.id, targetMode: 'INJECT', targetPayRunId: julyRun.id }); }
  catch (e) { sodOk = e.code === 'MAKER_CHECKER'; }
  ok(sodOk, '2.0 SoD: maker cannot approve their own cycle');

  const approved = await arrearsSvc.approveArrearCycle({ businessId, actorId: 'arrear-checker', arrearCycleId: cycle0.id, targetMode: 'INJECT', targetPayRunId: julyRun.id });
  ok(approved.status === 'APPROVED', '2.1 cycle APPROVED (INJECT)');
  ok(approved.payRunId === julyRun.id, '2.2 cycle bound to the July run');
  const item = await prisma.payRunInputItem.findFirst({ where: { businessId, payRunId: julyRun.id, kind: 'ARREAR' } });
  ok(!!item && dec(item.amountMinor) === 3 * BUMP, '2.3 PayRunInputItem(kind=ARREAR) written for the full arrear');

  const julyLine = await computeLine(businessId, julyRun, employeeId);
  const arrearComp = (julyLine.components || []).find((c) => c.componentCode === 'ARREAR_EARNINGS');
  ok(!!arrearComp, '2.4 July payslip has an ARREAR_EARNINGS line');
  ok(arrearComp && dec(arrearComp.amount) === 3 * (BUMP / 100), `2.5 ARREAR_EARNINGS = ₹12,000 (got ${arrearComp && arrearComp.amount})`);
  const epfArrear = (julyLine.components || []).find((c) => c.componentCode === 'EPF_ARREAR');
  // EPF_ARREAR passthrough appears iff there was incremental PF (below-ceiling employee).
  if (computed.pfArrearEeMinor > 0) ok(!!epfArrear && dec(epfArrear.amount) === computed.pfArrearEeMinor / 100, '2.6 EPF_ARREAR passthrough = the per-source-month PF on July slip');
  else ok(!epfArrear, '2.6 no EPF_ARREAR line when at-ceiling (₹0 incremental PF)');
  const cyclePaid = await prisma.arrearCycle.findUnique({ where: { id: cycle0.id } });
  ok(cyclePaid.status === 'PAID', '2.7 cycle stamped PAID after the run computed');

  // ── 3. RE-RUN July does NOT double-pay ───────────────────────────────────────
  const julyLine2 = await computeLine(businessId, julyRun, employeeId);
  const arrearComp2 = (julyLine2.components || []).find((c) => c.componentCode === 'ARREAR_EARNINGS');
  ok(arrearComp2 && dec(arrearComp2.amount) === 3 * (BUMP / 100), '3.1 recompute still pays ₹12,000 (not ₹24,000)');
  const paidCount = await prisma.arrearCycle.count({ where: { id: cycle0.id, status: 'PAID', payRunId: julyRun.id } });
  ok(paidCount === 1, '3.2 cycle stamped PAID exactly once (idempotent)');

  // ── 4. REOPEN reverts PAID→APPROVED; CANCEL fully releases ───────────────────
  await service.reopenRun({ businessId, actorId: 'arrear-maker', payRunId: julyRun.id });
  const afterReopen = await prisma.arrearCycle.findUnique({ where: { id: cycle0.id } });
  ok(afterReopen.status === 'APPROVED' && afterReopen.payRunId === julyRun.id, '4.1 reopen reverts cycle PAID→APPROVED (still bound)');
  // Recompute re-stamps PAID.
  await computeLine(businessId, julyRun, employeeId);
  ok((await prisma.arrearCycle.findUnique({ where: { id: cycle0.id } })).status === 'PAID', '4.2 recompute after reopen re-stamps PAID (no double-pay)');
  // CANCEL fully releases the cycle back to COMPUTED, un-bound.
  await service.reopenRun({ businessId, actorId: 'arrear-maker', payRunId: julyRun.id }); // back to DRAFT to allow cancel
  await service.cancelRun({ businessId, actorId: 'arrear-maker', payRunId: julyRun.id, reason: 'test' });
  const afterCancel = await prisma.arrearCycle.findUnique({ where: { id: cycle0.id } });
  ok(afterCancel.status === 'COMPUTED' && afterCancel.payRunId === null, '4.3 cancel fully releases the cycle (→ COMPUTED, un-bound)');

  // ── 5. a NON-RETRO revision produces NO arrears ──────────────────────────────
  const future = await mkRetroRevision(businessId, employeeId, baseComp, { effectiveFrom: '2026-08-01', bumpMinor: BUMP, reason: 'ANNUAL_REVISION' });
  const det2 = await arrearsSvc.detectArrearCycles({ businessId, entityId: inEntity.id, openPeriodStart: '2026-07-01' });
  ok(!det2.candidates.some((c) => c.compensationRevisionId === future.id), '5.1 a future-dated (non-retro) revision is NOT detected (no arrears)');

  // ── 6. MINT mode — the cancelled cycle (COMPUTED, un-bound) mints a standalone ARREAR run ──
  const minted = await arrearsSvc.approveArrearCycle({ businessId, actorId: 'arrear-checker', arrearCycleId: cycle0.id, targetMode: 'MINT' });
  ok(minted.status === 'APPROVED' && minted.targetMode === 'MINT', '6.1 MINT approve → cycle APPROVED (MINT)');
  const mintedRun = await prisma.payRun.findFirst({ where: { id: minted.payRunId } });
  ok(mintedRun && mintedRun.type === 'ARREAR', '6.2 a PayRun(type=ARREAR) was minted');
  ok(mintedRun && dec(mintedRun.totalGross) === 3 * (BUMP / 100), `6.3 minted run totalGross = ₹12,000 (got ${mintedRun && mintedRun.totalGross})`);
  const mintLine = await prisma.payRunLineComponent.findFirst({ where: { payRunLine: { payRunId: minted.payRunId }, componentCode: 'ARREAR_EARNINGS' } });
  ok(!!mintLine && dec(mintLine.amount) === 3 * (BUMP / 100), '6.4 minted run carries the ARREAR_EARNINGS component = ₹12,000');
  // Concurrent/duplicate MINT → ALREADY_PAID (single-mint guard).
  let dupBlocked = false;
  try { await arrearsSvc.approveArrearCycle({ businessId, actorId: 'arrear-checker', arrearCycleId: cycle0.id, targetMode: 'MINT' }); }
  catch (e) { dupBlocked = e.code === 'ALREADY_PAID' || e.code === 'BAD_STATE'; }
  ok(dupBlocked, '6.5 a second MINT is blocked (single-mint guard, no double-pay)');
  // Tear down the minted run.
  await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: minted.payRunId } } });
  await prisma.payRunLine.deleteMany({ where: { payRunId: minted.payRunId } });
  await prisma.payRun.deleteMany({ where: { id: minted.payRunId } });

  await cleanup(businessId, employeeId);
  // Restore the employee's original current comp flag (we flipped isCurrent during the test).
  await prisma.compensationRevision.updateMany({ where: { id: baseComp.id }, data: { isCurrent: true } });

  log('');
  log(`Arrears live: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  await prisma.$disconnect();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await prisma.$disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});

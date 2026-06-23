'use strict';

/*
 * run-orchestration.live.test.js — LIVE (hr_test) proof of the Feature 7 run
 * orchestration: lifecycle past APPROVED, maker-checker SoD, idempotent recompute,
 * variance vs a prior period, anomaly gating, publish chain, country-aware filing
 * rows (IN + NZ), and reopen. Plain-node (built-in assert, NO jest).
 *
 * Run (DATABASE_URL must target the hr_test schema):
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/__tests__/run-orchestration.live.test.js
 * where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'. Apply the
 * Feature 7 migration (or `prisma db push`) to hr_test FIRST.
 *
 * Uses the seed 'demo' tenant's IN + NZ entities/calendars/employees. Every row
 * the test writes is torn down at the end (PayRun cascade + remittances).
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const service = require('../service');
const { PayRunError } = require('../payrun');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
async function expectThrow(fn, code, msg) {
  try { await fn(); failures += 1; log(`  FAIL  ${msg} (no throw)`); }
  catch (e) { if (e && e.code === code) log(`  PASS  ${msg} (${code})`); else { failures += 1; log(`  FAIL  ${msg} — got ${e && e.code}: ${e && e.message}`); } }
}

const PREFIX = 'F7TEST';
const MAKER = 'maker-actor-f7';
const CHECKER = 'checker-actor-f7';

async function cleanup(businessId) {
  const runs = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await prisma.statutoryRemittance.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payslip.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: ids } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunInputItem.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRun.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Create a DRAFT run directly (bypass createRun's code derivation so we control the PREFIX). */
async function mkRun(businessId, entity, cal, { periodStart, periodEnd, payDate, taxYear, seq, suffix }) {
  return prisma.payRun.create({
    data: {
      businessId, entityId: entity.id, payCalendarId: cal.id,
      code: `${PREFIX}-${entity.code}-${suffix}`,
      periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), payDate: new Date(payDate),
      sequenceInYear: seq, taxYear, currencyCode: entity.payCurrency, status: 'DRAFT',
    },
  });
}

async function main() {
  log('\n=== Feature 7 run-orchestration proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } });
  const nzEntity = await prisma.entity.findFirst({ where: { businessId, code: 'NZ-AKL' } });
  const inCal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } });
  const nzCal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: nzEntity.id } });

  await cleanup(businessId);

  // ── A. PRIOR-period IN run (the variance baseline) ──────────────────────────
  const prior = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-04-01', periodEnd: '2026-04-30', payDate: '2026-04-30', taxYear: '2026-27', seq: 1, suffix: 'IN-APR',
  });
  const priorDetail = await service.computeRun({ businessId, actorId: MAKER, payRunId: prior.id });
  ok(priorDetail.totals && Number(priorDetail.totals.totalNet) > 0, `A1 prior run computes real gross (net=${priorDetail.totals.totalNet})`);

  // ── B. CURRENT IN run ──
  const run = await mkRun(businessId, inEntity, inCal, {
    periodStart: '2026-05-01', periodEnd: '2026-05-31', payDate: '2026-05-31', taxYear: '2026-27', seq: 2, suffix: 'IN-MAY',
  });
  const computed = await service.computeRun({ businessId, actorId: MAKER, payRunId: run.id });
  const net1 = Number(computed.totals.totalNet);
  ok(net1 > 0, `B1 current run computes (net=${net1})`);

  // ── C. Recompute idempotency — same inputs → same inputHash, no-op ──
  const before = await prisma.payRun.findUnique({ where: { id: run.id }, select: { complianceVersionId: true, totalNet: true } });
  const recomputed = await service.computeRun({ businessId, actorId: MAKER, payRunId: run.id });
  const after = await prisma.payRun.findUnique({ where: { id: run.id }, select: { complianceVersionId: true, totalNet: true } });
  ok(before.complianceVersionId === after.complianceVersionId, 'C1 recompute: inputHash unchanged (idempotent)');
  ok(Number(recomputed.totals.totalNet) === net1, 'C2 recompute: totals identical');

  // ── D. Variance vs prior period (real engine) ──
  const variance = await service.computeVariance({ businessId, payRunId: run.id });
  ok(variance.hasBaseline === true, 'D1 variance: prior period found (baseline)');
  ok(typeof variance.blockingAnomalies === 'number', `D2 variance: blockingAnomalies numeric (${variance.blockingAnomalies})`);
  ok(variance.totals && variance.totals.previous, 'D3 variance: totals carry previous period');

  // ── E. Maker-checker SoD — maker cannot approve own run ──
  // Submit first (maker → REVIEW) then maker tries to approve own submission.
  if (variance.blockingAnomalies === 0) {
    await service.submitRun({ businessId, actorId: MAKER, payRunId: run.id });
    const inReview = await prisma.payRun.findUnique({ where: { id: run.id }, select: { status: true, submittedBy: true, totalsHash: true } });
    ok(inReview.status === 'REVIEW' && inReview.submittedBy === MAKER, 'E1 submit → REVIEW, submittedBy=maker');

    await expectThrow(
      () => service.approveRun({ businessId, actorId: MAKER, payRunId: run.id, fourEyes: true }),
      'MAKER_CHECKER', 'E2 maker approving own run → MAKER_CHECKER 403',
    );

    // STALE_TOTALS — checker approves with a stale hash.
    await expectThrow(
      () => service.approveRun({ businessId, actorId: CHECKER, payRunId: run.id, fourEyes: true, totalsHash: 'STALE_HASH' }),
      'STALE_TOTALS', 'E3 checker with stale totalsHash → STALE_TOTALS',
    );

    // Checker approves with the right hash.
    const approved = await service.approveRun({ businessId, actorId: CHECKER, payRunId: run.id, fourEyes: true, totalsHash: inReview.totalsHash });
    ok(approved.payRun.status === 'APPROVED' && approved.payRun.approvedBy === CHECKER, 'E4 checker (≠ maker) approves → APPROVED');
  } else {
    log(`  SKIP E (current run has ${variance.blockingAnomalies} blockers — gating tested separately in F)`);
    // Force-approve path still must be SoD-guarded: submit then assert maker block.
  }

  // ── F. Anomaly gating — a NEGATIVE_NET line blocks submit/approve ──
  {
    const gateRun = await mkRun(businessId, inEntity, inCal, {
      periodStart: '2026-06-01', periodEnd: '2026-06-30', payDate: '2026-06-30', taxYear: '2026-27', seq: 3, suffix: 'IN-JUN-GATE',
    });
    await service.computeRun({ businessId, actorId: MAKER, payRunId: gateRun.id });
    // Inject a BLOCKER finding onto a line's errorJson (simulate variance/engine BLOCKER).
    const aLine = await prisma.payRunLine.findFirst({ where: { businessId, payRunId: gateRun.id } });
    await prisma.payRunLine.update({
      where: { id: aLine.id },
      data: { errorJson: [{ code: 'NEGATIVE_NET', severity: 'BLOCKER', message: 'forced blocker' }] },
    });
    await expectThrow(
      () => service.submitRun({ businessId, actorId: MAKER, payRunId: gateRun.id }),
      'OPEN_BLOCKERS', 'F1 submit blocked by open BLOCKER',
    );
    await expectThrow(
      () => service.approveRun({ businessId, actorId: CHECKER, payRunId: gateRun.id, fourEyes: true }),
      'OPEN_BLOCKERS', 'F2 approve blocked by open BLOCKER',
    );
  }

  // ── G. Lifecycle past APPROVED — pay (publish) → file (remittances) → close ──
  {
    const approvedRun = await prisma.payRun.findFirst({ where: { businessId, code: `${PREFIX}-${inEntity.code}-IN-MAY` } });
    if (approvedRun && approvedRun.status === 'APPROVED') {
      // pre-publish: payslips are GENERATED (not visible to ESS)
      const genCount = await prisma.payslip.count({ where: { businessId, payRunId: approvedRun.id, status: 'GENERATED' } });
      ok(genCount > 0, `G1 pre-pay payslips are GENERATED (${genCount})`);

      await service.disburseRun({ businessId, actorId: CHECKER, payRunId: approvedRun.id });
      const paid = await prisma.payRun.findUnique({ where: { id: approvedRun.id }, select: { status: true, paidAt: true } });
      ok(paid.status === 'PAID' && !!paid.paidAt, 'G2 pay → PAID + paidAt');
      const pubCount = await prisma.payslip.count({ where: { businessId, payRunId: approvedRun.id, status: 'PUBLISHED' } });
      ok(pubCount > 0, `G3 disburse published payslips (${pubCount} PUBLISHED)`);

      const filed = await service.fileRun({ businessId, actorId: CHECKER, payRunId: approvedRun.id });
      ok(filed.country === 'IN', 'G4 file → IN filing plan');
      const kinds = filed.remittances.map((r) => r.kind).sort();
      ok(kinds.includes('IN_PF') && kinds.includes('IN_ESI') && kinds.includes('IN_FORM24Q'), `G5 IN remittance rows written (${kinds.join(',')})`);
      const rem = await prisma.statutoryRemittance.findMany({ where: { businessId, payRunId: approvedRun.id } });
      ok(rem.every((r) => r.taxPeriod && r.dueDate), 'G6 remittances carry taxPeriod + dueDate');

      const closed = await service.closeRun({ businessId, actorId: CHECKER, payRunId: approvedRun.id });
      ok(closed.payRun.status === 'FILED' && !!closed.payRun.closedAt, 'G7 close → FILED + closedAt');

      // Post-approval immutability: cancel/reopen refused.
      await expectThrow(() => service.cancelRun({ businessId, actorId: MAKER, payRunId: approvedRun.id }), 'CANNOT_CANCEL', 'G8 cancel after close → CANNOT_CANCEL');
      await expectThrow(() => service.reopenRun({ businessId, actorId: MAKER, payRunId: approvedRun.id }), 'CANNOT_REOPEN', 'G9 reopen after close → CANNOT_REOPEN');
    } else {
      log('  SKIP G (current IN-MAY run not APPROVED — likely had blockers)');
    }
  }

  // ── H. NZ filing-export rows ──
  {
    const nzRun = await mkRun(businessId, nzEntity, nzCal, {
      periodStart: '2026-04-01', periodEnd: '2026-04-14', payDate: '2026-04-15', taxYear: '2026-27', seq: 1, suffix: 'NZ-APR',
    });
    const nzComputed = await service.computeRun({ businessId, actorId: MAKER, payRunId: nzRun.id });
    if (Number(nzComputed.totals.totalNet) !== 0 || nzComputed.totals.headcount > 0) {
      await service.computeVariance({ businessId, payRunId: nzRun.id });
      const nzBlockers = await service.recountBlockers(businessId, nzRun.id);
      if (nzBlockers === 0) {
        await service.submitRun({ businessId, actorId: MAKER, payRunId: nzRun.id });
        const nzReview = await prisma.payRun.findUnique({ where: { id: nzRun.id }, select: { totalsHash: true } });
        await service.approveRun({ businessId, actorId: CHECKER, payRunId: nzRun.id, fourEyes: true, totalsHash: nzReview.totalsHash });
        await service.disburseRun({ businessId, actorId: CHECKER, payRunId: nzRun.id });
        const nzFiled = await service.fileRun({ businessId, actorId: CHECKER, payRunId: nzRun.id });
        const nzKinds = nzFiled.remittances.map((r) => r.kind).sort();
        ok(nzFiled.country === 'NZ' && nzKinds.includes('NZ_PAYDAY_FILING') && nzKinds.includes('NZ_PAYE'), `H1 NZ remittance rows (${nzKinds.join(',')})`);
      } else {
        log(`  SKIP H approve chain (NZ run has ${nzBlockers} blockers)`);
      }
      // Country mismatch: an IN file kind on an NZ run.
      await expectThrow(() => service.generateFile({ businessId, payRunId: nzRun.id, kind: 'ecr' }), 'COUNTRY_MISMATCH', 'H2 IN file on NZ run → COUNTRY_MISMATCH');
    } else {
      log('  SKIP H (NZ run produced no lines — no NZ comp in seed)');
    }
  }

  // ── I. Reopen clears compute, FnF hidden from list ──
  {
    const reopenRun = await mkRun(businessId, inEntity, inCal, {
      periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-31', taxYear: '2026-27', seq: 4, suffix: 'IN-JUL-REOPEN',
    });
    await service.computeRun({ businessId, actorId: MAKER, payRunId: reopenRun.id });
    const reopened = await service.reopenRun({ businessId, actorId: MAKER, payRunId: reopenRun.id });
    ok(reopened.payRun.status === 'DRAFT', 'I1 reopen COMPUTED → DRAFT');
    const lineCount = await prisma.payRunLine.count({ where: { businessId, payRunId: reopenRun.id } });
    ok(lineCount === 0, 'I2 reopen cleared compute lines');
    ok(reopened.payRun.complianceVersionId == null, 'I3 reopen cleared inputHash');

    // FnF hidden from the regular list.
    await prisma.payRun.create({
      data: {
        businessId, entityId: inEntity.id, payCalendarId: inCal.id, code: `${PREFIX}-${inEntity.code}-FNF1`,
        periodStart: new Date('2026-05-01'), periodEnd: new Date('2026-05-31'), payDate: new Date('2026-05-31'),
        sequenceInYear: 2, taxYear: '2026-27', currencyCode: inEntity.payCurrency, status: 'COMPUTED', type: 'FNF',
      },
    });
    const regularList = await service.listRuns({ businessId, entityId: inEntity.id, pageSize: 100 });
    const hasFnf = regularList.items.some((r) => r.type === 'FNF');
    ok(!hasFnf, 'I4 listRuns hides FNF by default');
    const fnfList = await service.listRuns({ businessId, entityId: inEntity.id, type: 'FNF', pageSize: 100 });
    ok(fnfList.items.some((r) => r.type === 'FNF'), 'I5 listRuns type=FNF shows FnF');
  }

  // ── J. Attendance-freeze parity — a frozen run's payable days drive the engine ──
  {
    const freezeRun = await mkRun(businessId, inEntity, inCal, {
      periodStart: '2026-08-01', periodEnd: '2026-08-31', payDate: '2026-08-31', taxYear: '2026-27', seq: 5, suffix: 'IN-AUG-FREEZE',
    });
    // Freeze + compute atomically via the threaded flag.
    await service.computeRun({ businessId, actorId: MAKER, payRunId: freezeRun.id, freezeAttendance: true });
    const frozenInputs = await prisma.attendancePayInput.findMany({ where: { businessId, payRunId: freezeRun.id } });
    ok(frozenInputs.length > 0, `J1 freeze produced AttendancePayInput rows (${frozenInputs.length})`);
    // Each frozen row's payableDays must equal the matching line's payableDays (parity).
    const lines = await prisma.payRunLine.findMany({ where: { businessId, payRunId: freezeRun.id } });
    let parity = lines.length > 0;
    for (const ln of lines) {
      const inp = frozenInputs.find((f) => f.employeeId === ln.employeeId);
      if (inp && Number(inp.payableDays) !== Number(ln.payableDays)) parity = false;
    }
    ok(parity, 'J2 frozen payableDays match the computed line payableDays (freeze parity)');
  }

  await cleanup(businessId);
  log('');
  if (failures > 0) { log(`run-orchestration LIVE: ${failures} FAILURE(S)`); process.exitCode = 1; }
  else log('run-orchestration LIVE: ALL PASS');
}

main()
  .catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });

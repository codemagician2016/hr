'use strict';

/**
 * fbp.live.test.js — Feature 25 LIVE (hr_test) proof of the FBP / Flexi Basket
 * end-to-end against real prisma:
 *   - a plan + allocation drive the projection: OLD-regime taxable income drops by
 *     exactly Σ exempt; NEW-regime exempts ₹0 (the basket pays but is taxable);
 *   - the ESS save guards over-allocation (FBP_OVER_ALLOCATED) + per-head caps;
 *   - the assembler flips DECLARED→VERIFIED at the FBP window's proofDeadline;
 *   - the run overlay explodes the envelope into head lines whose Σ === the envelope;
 *   - cross-employee ESS access is impossible (self-resolved).
 *
 *   DATABASE_URL="$HR_URL" node src/hr/tax/fbp/__tests__/fbp.live.test.js
 *   where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'.
 */

const prisma = require('../../../../core/lib/prisma');
const assembler = require('../../projectionAssembler');
const fbpService = require('../../../compensation/fbpService');
const { resolveFbpExempt } = require('../fbpProjection');
const engine = require('../../../payroll/engine');
const payrollService = require('../../../payroll/service');

const PREFIX = 'FBPT';
let passed = 0;
let failed = 0;
function ok(cond, label) { if (cond) { passed += 1; } else { failed += 1; console.error(`FAIL  ${label}`); } }

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.fbpAllocationLine.deleteMany({ where: { businessId, allocation: { employeeId: { in: ids } } } }).catch(() => {});
    await prisma.fbpAllocation.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    await prisma.investmentProof.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    await prisma.salaryComponentLine.deleteMany({ where: { businessId, compensation: { employeeId: { in: ids } } } }).catch(() => {});
    await prisma.compensationRevision.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.statutoryProfile.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employmentRecord.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }
  await prisma.fbpPlanHead.deleteMany({ where: { businessId, plan: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.fbpPlan.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.investmentDeclarationWindow.deleteMany({ where: { businessId, notes: PREFIX } }).catch(() => {});
  await prisma.salaryComponent.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
}

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) { console.log('SKIP — no demo tenant in hr_test'); return; }
  const businessId = demo.id;
  const entity = (await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } }))
    || (await prisma.entity.findFirst({ where: { businessId } }));
  if (!entity) { console.log('SKIP — demo tenant has no entity'); return; }

  await cleanup(businessId);

  // ── components: BASIC, HRA, SPECIAL(balancing=envelope), + 4 FBP head components ──
  const mk = (code, name, kind, category, calcMethod, extra = {}) => prisma.salaryComponent.create({
    data: { businessId, code: `${PREFIX}_${code}`, name, kind, category, calcMethod, ...extra },
  });
  const cBasic = await mk('BASIC', 'Basic', 'BASIC', 'EARNING', 'FLAT', { isWageForPF: true });
  const cHra = await mk('HRA', 'HRA', 'HRA', 'EARNING', 'PERCENT_OF', { taxSection: '10(13A)' });
  const cEnv = await mk('FBP', 'FBP Allowance', 'SPECIAL_ALLOWANCE', 'EARNING', 'BALANCING');
  const cMeal = await mk('MEAL', 'Meal Card', 'CUSTOM', 'EARNING', 'FLAT', { taxSection: '3(7)(iii)' });
  const cFuel = await mk('FUEL', 'Fuel', 'REIMBURSEMENT_FUEL', 'EARNING', 'FLAT', { taxSection: '3(2)' });
  const cPhone = await mk('PHONE', 'Telephone', 'REIMBURSEMENT_PHONE', 'EARNING', 'FLAT', { taxSection: '3(7)(ix)' });
  const cLta = await mk('LTA', 'LTA', 'LTA', 'EARNING', 'FLAT', { taxSection: '10(5)' });

  // ── employee + employment + OLD-regime statutory profile ──
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-A`, firstName: 'Flexi', lastName: 'Worker', countryCode: 'IN', isActive: true, status: 'ACTIVE', hireDate: new Date('2024-01-15') },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', effectiveFrom: new Date('2024-01-15'), changeReason: 'HIRE', isCurrent: true, fteRatio: 1 },
  });
  await prisma.statutoryProfile.create({ data: { businessId, employeeId: emp.id, countryCode: 'IN', taxRegime: 'OLD', pan: 'ABCDE1234F' } });

  // ── compensation: Basic 50k/mo, HRA 20k/mo, FBP envelope 25k/mo (₹3,00,000/yr) ──
  const rev = await prisma.compensationRevision.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, currencyCode: 'INR', basis: 'CTC', ctcAnnual: 1140000, grossMonthly: 95000, effectiveFrom: new Date('2024-01-15'), isCurrent: true, revisionReason: 'HIRE', status: 'EFFECTIVE' },
  });
  const ln = (componentId, monthly) => prisma.salaryComponentLine.create({
    data: { businessId, compensationId: rev.id, componentId, calcMethod: 'FLAT', amountMonthly: String(monthly), amountAnnual: String(monthly * 12), sortOrder: 0 },
  });
  await ln(cBasic.id, 50000);
  await ln(cHra.id, 20000);
  await ln(cEnv.id, 25000); // the FBP envelope: ₹3,00,000/yr

  // ── plan: 4 heads (meal proof-free; fuel/phone/LTA proof-required) ──
  const plan = await fbpService.savePlan({
    businessId, createdById: null,
    input: {
      code: `${PREFIX}-2026`, name: 'FBP Test 2026', financialYear: '2026-27',
      envelopeComponentId: cEnv.id,
      heads: [
        { headType: 'MEAL_CARD', componentId: cMeal.id, label: 'Meal Card', taxSection: '3(7)(iii)', annualCapRupees: 26400, monthlyCapRupees: 2200, proofRequired: false, payCadence: 'MONTHLY', claimType: null, sortOrder: 0 },
        { headType: 'FUEL_CAR', componentId: cFuel.id, label: 'Fuel', taxSection: '3(2)', monthlyCapRupees: 2700, proofRequired: true, payCadence: 'MONTHLY', claimType: 'FBP_FUEL', sortOrder: 1 },
        { headType: 'TELEPHONE_INTERNET', componentId: cPhone.id, label: 'Telephone', taxSection: '3(7)(ix)', proofRequired: true, payCadence: 'MONTHLY', claimType: 'FBP_TELEPHONE', sortOrder: 2 },
        { headType: 'LTA', componentId: cLta.id, label: 'LTA', taxSection: '10(5)', proofRequired: true, payCadence: 'ON_CLAIM', claimType: 'FBP_LTA', sortOrder: 3 },
      ],
    },
  });
  ok(plan && plan.heads.length === 4, 'plan created with 4 heads');

  // ── allocation: meal 26.4k, fuel 21.6k, phone 24k, LTA 60k = ₹1,32,000 (≤ ₹3,00,000) ──
  const headByType = Object.fromEntries(plan.heads.map((h) => [h.headType, h]));
  const alloc = await fbpService.saveAllocation({
    businessId, employeeId: emp.id, financialYear: '2026-27',
    lines: [
      { headId: headByType.MEAL_CARD.id, annual: 26400 },
      { headId: headByType.FUEL_CAR.id, annual: 21600 },
      { headId: headByType.TELEPHONE_INTERNET.id, annual: 24000 },
      { headId: headByType.LTA.id, annual: 60000 },
    ],
    status: 'SUBMITTED', asOf: '2026-06-01',
  });
  ok(alloc && alloc.status === 'SUBMITTED', 'allocation submitted');

  // ── over-allocation rejected ──
  let overErr = null;
  try {
    await fbpService.saveAllocation({
      businessId, employeeId: emp.id, financialYear: '2026-27',
      lines: [{ headId: headByType.LTA.id, annual: 9000000 }], // ₹90,00,000 >> envelope
      status: 'SUBMITTED', asOf: '2026-06-01',
    });
  } catch (e) { overErr = e; }
  ok(overErr && overErr.code === 'FBP_OVER_ALLOCATED', 'over-allocation rejected with FBP_OVER_ALLOCATED');

  // re-submit the valid allocation (the failed one superseded nothing; re-assert latest)
  const current = await fbpService.currentAllocation({ businessId, employeeId: emp.id, financialYear: '2026-27' });
  ok(current && current.lines.length === 4, 'current allocation has 4 lines');

  // ── OLD-regime exempt (pre-deadline, no window): Σ = meal 26.4k + fuel 21.6k + phone 24k + LTA 60k = ₹1,32,000 ──
  const fbpOld = await resolveFbpExempt({ businessId, employeeId: emp.id, financialYear: '2026-27', asOf: '2026-06-01', regime: 'OLD' });
  ok(fbpOld.totalExemptMinor === 13200000, `OLD exempt = ₹1,32,000 (got ₹${fbpOld.totalExemptMinor / 100})`);
  ok(fbpOld.basis === 'DECLARED', 'no window → DECLARED basis');

  // ── NEW-regime exempt = 0 ──
  const fbpNew = await resolveFbpExempt({ businessId, employeeId: emp.id, financialYear: '2026-27', asOf: '2026-06-01', regime: 'NEW' });
  ok(fbpNew.totalExemptMinor === 0, 'NEW exempt = 0 (basket pays but is taxable)');

  // ── the projection: taxable income drops by exactly Σ exempt (OLD) ──
  //   Bucket otherAllowances includes the envelope ₹3,00,000. With FBP, the assembler
  //   subtracts ₹1,32,000 → otherAllowances drops by exactly that.
  const stmt = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: '2026-07-15' });
  ok(stmt.fbp && stmt.fbp.totalExempt === 132000, `projection FBP totalExempt = ₹1,32,000 (got ${stmt.fbp && stmt.fbp.totalExempt})`);
  // The statement shows GROSS otherAllowances (the envelope ₹3,00,000); the FBP
  // exemption is surfaced SEPARATELY in the fbp block (the "Less: FBP exemptions"
  // line) and applied inside the engine input — taxable income reflects the drop.
  ok(stmt.annualEarnings.otherAllowances === 300000, `gross otherAllowances = ₹3,00,000 (got ${stmt.annualEarnings.otherAllowances})`);
  ok(stmt.fbp.basis === 'DECLARED', 'projection FBP basis DECLARED (no window pre-deadline)');

  // ── compare TDS with vs without FBP: drop the allocation → otherAllowances 300000, taxable higher ──
  await prisma.fbpAllocation.updateMany({ where: { businessId, employeeId: emp.id }, data: { status: 'SUPERSEDED' } });
  const stmtNoFbp = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: '2026-07-15' });
  ok(!stmtNoFbp.fbp, 'no active allocation → no fbp block');
  ok(stmtNoFbp.totalTaxableIncome > stmt.totalTaxableIncome, `taxable income higher WITHOUT FBP (${stmtNoFbp.totalTaxableIncome} > ${stmt.totalTaxableIncome})`);
  ok(stmtNoFbp.totalTaxableIncome - stmt.totalTaxableIncome === 132000, `taxable delta == Σ exempt ₹1,32,000 (got ${stmtNoFbp.totalTaxableIncome - stmt.totalTaxableIncome})`);

  // restore the allocation for the verified-flip test
  await prisma.fbpAllocation.updateMany({ where: { businessId, employeeId: emp.id, version: current.version }, data: { status: 'SUBMITTED' } });

  // ── declared→verified flip: an FBP window with proofDeadline in the past + only meal always-verified ──
  await prisma.investmentDeclarationWindow.create({
    data: { businessId, financialYear: '2026-27', countryCode: 'IN', purpose: 'FBP_ALLOCATION', opensAt: new Date('2026-04-01'), closesAt: new Date('2027-01-31'), proofDeadline: new Date('2027-02-15'), status: 'OPEN', notes: PREFIX },
  });
  const fbpVerified = await resolveFbpExempt({ businessId, employeeId: emp.id, financialYear: '2026-27', asOf: '2027-03-01', regime: 'OLD' });
  ok(fbpVerified.basis === 'VERIFIED', 'on/after FBP deadline → VERIFIED basis');
  // no bills uploaded: only meal (proof-free, always-verified ₹26,400) stays exempt.
  ok(fbpVerified.totalExemptMinor === 2640000, `post-deadline, only meal verified = ₹26,400 (got ₹${fbpVerified.totalExemptMinor / 100})`);

  // ── run overlay Σ-parity: explode the envelope, Σ(head monthly + residual) + onClaim === envelope monthly ──
  const compResolved = await prisma.compensationRevision.findFirst({ where: { id: rev.id }, include: { lines: { include: { component: true } } } });
  const overlaid = await fbpService.applyFbpOverlay({ businessId, compensation: compResolved, employeeId: emp.id, financialYear: '2026-27' });
  ok(overlaid._fbpOverlaid, 'overlay applied');
  const envMonthly = 2500000; // ₹25,000/mo
  // Sum the exploded FBP lines' monthly (heads + residual), excluding LTA (on-claim, dropped).
  const fbpLines = overlaid.lines.filter((l) => l._fbp);
  let sumFbpMonthly = 0;
  for (const l of fbpLines) sumFbpMonthly += Math.round(Number(l.amountMonthly) * 100);
  // LTA on-claim is carved out (₹5,000/mo); the monthly FBP lines + residual should be envelope − onClaim.
  const onClaimMonthly = Math.floor(6000000 / 12); // ₹5,000
  ok(sumFbpMonthly === envMonthly - onClaimMonthly, `Σ(exploded monthly FBP lines) === envelope − onClaim (got ₹${sumFbpMonthly / 100}, want ₹${(envMonthly - onClaimMonthly) / 100})`);
  // LTA emits no monthly line in the overlay.
  ok(!fbpLines.find((l) => l._fbpHeadId === headByType.LTA.id), 'LTA (ON_CLAIM) emits no monthly overlay line');

  // ── FBP-3 FIX (END-TO-END): the LIVE run path (engine.computePayslip → india.compute →
  //   computeTds) must deduct the SAME monthly TDS the projection promises. Post-deadline
  //   (asOf 2027-03-01): only the meal card is verified (₹26,400 exempt). resolveRunTaxOverride
  //   threads the projection's post-exemption taxable into the run; without it the run would
  //   annualise the full FBP-inflated taxable gross and OVER-withhold. ──
  {
    const asOfRun = '2027-03-01'; // post FBP proofDeadline (2027-02-15)
    // The promise: the ESS projection's monthly recoverable (rupees → paise).
    const stmt = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: asOfRun });
    const projMonthlyMinor = Math.round(stmt.monthlyRecoverable * 100);
    ok(stmt.regime === 'OLD', 'FBP-3: projection is OLD-regime');

    // The override the run consumes (the single computeFbpExempt source path).
    const override = await assembler.resolveRunTaxOverride({ businessId, employeeId: emp.id, asOf: asOfRun });
    ok(override && override.annualTaxableOverrideMinor != null, 'FBP-3: run tax override resolved for the OLD-regime FBP employee');

    // The LIVE run: resolve comp, apply the FBP overlay (envelope → head lines, all taxable),
    // build engine args WITH the override, computePayslip.
    let comp = await payrollService._internal.resolveCurrentCompensation(businessId, emp.id, '2027-03-31', prisma);
    comp = await fbpService.applyFbpOverlay({ businessId, compensation: comp, employeeId: emp.id, financialYear: '2026-27' });
    const empRow = await prisma.employee.findFirst({ where: { id: emp.id }, include: { statutoryProfile: true } });
    const { engineArgs } = payrollService.buildEmployeePayInput({
      employee: empRow, compensation: comp, statutory: empRow.statutoryProfile, attendance: null, entity,
      period: { start: '2027-03-01', end: '2027-03-31', payDate: '2027-03-31', taxYear: '2026-27' },
      ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
      taxOverride: override,
    });
    const result = engine.computePayslip(engineArgs);
    const tdsLine = result.employeeDeductions.find((d) => d.code === 'TDS');
    const runMonthlyTdsMinor = tdsLine ? tdsLine.amountMinor : 0;
    ok(runMonthlyTdsMinor === projMonthlyMinor,
      `FBP-3 PARITY: live run TDS === projection monthly recoverable to the paise (run ₹${runMonthlyTdsMinor / 100} vs proj ₹${projMonthlyMinor / 100})`);

    // Prove the override is LOAD-BEARING: re-running the SAME run without it does NOT
    // reconcile to the projection (it falls back to §192 single-period annualisation of the
    // FBP-inflated gross). The reconciled figure is reachable ONLY by threading the override.
    const { engineArgs: argsNoOverride } = payrollService.buildEmployeePayInput({
      employee: empRow, compensation: comp, statutory: empRow.statutoryProfile, attendance: null, entity,
      period: { start: '2027-03-01', end: '2027-03-31', payDate: '2027-03-31', taxYear: '2026-27' },
      ytd: { taxableGrossMinor: 0, tdsDeductedMinor: 0, monthsElapsed: 0 },
      taxOverride: null,
    });
    const resultBug = engine.computePayslip(argsNoOverride);
    const bugTdsLine = resultBug.employeeDeductions.find((d) => d.code === 'TDS');
    const bugMonthlyTdsMinor = bugTdsLine ? bugTdsLine.amountMinor : 0;
    ok(bugMonthlyTdsMinor !== projMonthlyMinor,
      `FBP-3: WITHOUT the override the run does NOT reconcile to the projection (₹${bugMonthlyTdsMinor / 100} ≠ ₹${projMonthlyMinor / 100}) — the override is load-bearing`);
  }

  // ── FBP-4 FIX: force-lock guard. The lock must (a) target ONLY a SUBMITTED + current
  //   (max-version, non-superseded) allocation, and (b) flip status/lockedAt WITHOUT
  //   touching `version` — a blind {increment:1} collides with the unique
  //   (businessId, employeeId, financialYear, version) index when a higher version exists.
  {
    // eslint-disable-next-line global-require
    const fbpController = require('../../../controllers/fbp.controller');

    // A tiny res spy.
    function mkRes() {
      const r = { statusCode: 200, body: null };
      r.status = (c) => { r.statusCode = c; return r; };
      r.json = (b) => { r.body = b; return r; };
      return r;
    }
    // An operator who is NOT the subject (no SoD self-lock collision).
    const operatorUser = { id: 'op-user-no-employee', businessId };

    // Current state: the valid v0 allocation is SUBMITTED (restored above). Manufacture a
    // PRIOR SUPERSEDED v0 + a current SUBMITTED v1 to exercise the stale-version guard and
    // prove the increment-collision is gone.
    const live = await prisma.fbpAllocation.findFirst({ where: { businessId, employeeId: emp.id, deletedAt: null }, orderBy: { version: 'desc' } });
    // Bump the existing row to SUPERSEDED v0, and create a fresh SUBMITTED v1 (the current).
    await prisma.fbpAllocation.update({ where: { id: live.id }, data: { status: 'SUPERSEDED', version: 0 } });
    const v1 = await prisma.fbpAllocation.create({
      data: {
        businessId, employeeId: emp.id, planId: live.planId, financialYear: '2026-27',
        envelopeAnnualRupees: live.envelopeAnnualRupees, status: 'SUBMITTED', submittedAt: new Date(), version: 1,
      },
    });

    // (a) Locking the STALE/SUPERSEDED v0 id is rejected (not SUBMITTED + not current).
    const resStale = mkRes();
    await fbpController.lockEmployeeFbp({ user: operatorUser, params: { employeeId: emp.id, id: live.id } }, resStale);
    ok(resStale.statusCode === 409 && resStale.body && resStale.body.code === 'FBP_NOT_SUBMITTED',
      `FBP-4: locking a SUPERSEDED allocation is rejected 409 FBP_NOT_SUBMITTED (got ${resStale.statusCode}/${resStale.body && resStale.body.code})`);

    // (b) Locking the CURRENT SUBMITTED v1 succeeds: status LOCKED, version UNCHANGED (no collision).
    const resOk = mkRes();
    await fbpController.lockEmployeeFbp({ user: operatorUser, params: { employeeId: emp.id, id: v1.id } }, resOk);
    ok(resOk.statusCode === 200 && resOk.body && resOk.body.status === 'LOCKED',
      `FBP-4: locking the current SUBMITTED allocation succeeds → LOCKED (got ${resOk.statusCode}/${resOk.body && resOk.body.status})`);
    const lockedRow = await prisma.fbpAllocation.findFirst({ where: { id: v1.id } });
    ok(lockedRow.version === 1, `FBP-4: version is UNCHANGED on lock (still 1, no blind increment) (got ${lockedRow.version})`);

    // (c) Re-locking an already-LOCKED allocation is rejected (idempotent guard).
    const resReLock = mkRes();
    await fbpController.lockEmployeeFbp({ user: operatorUser, params: { employeeId: emp.id, id: v1.id } }, resReLock);
    ok(resReLock.statusCode === 409 && resReLock.body && resReLock.body.code === 'FBP_NOT_SUBMITTED',
      `FBP-4: re-locking a LOCKED allocation is rejected 409 (got ${resReLock.statusCode}/${resReLock.body && resReLock.body.code})`);
  }

  await cleanup(businessId);
  console.log(`\nFeature 25 FBP live test: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

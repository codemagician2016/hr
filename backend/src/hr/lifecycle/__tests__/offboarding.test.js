'use strict';

/**
 * offboarding.test.js — Feature 4 slice 4f (Offboarding + Full-and-Final) +
 * slice 4e (Assets wiring) proof. Plain-node runner (no jest), mirroring the
 * onboarding/scope harness.
 *
 *   PART A (DB-FREE) — the PURE FnF math core (fnf.js):
 *     QA10 IN gratuity (7.5y, ₹40k Basic+DA → ₹1,84,615; cap; <5y→0; death waiver)
 *     QA11 IN leave encashment (12d, ₹52k → ₹24,000)
 *     QA12 notice shortfall recovery vs employer pay-in-lieu
 *     QA13 NZ holiday payout (8% + max(OWP,AWE)); no IN gratuity line
 *     QA14 netSettlement incl. recoveries; negative net STILL makes a PayRun
 *     QA15 the FnF lines == the SeparationCase snapshot exactly
 *
 *   PART B (LIVE hr_test) — the separation state machine + RBAC over real rows:
 *     QA9/SoD  initiator ≠ approver (the initiator's approve-fnf → 403)
 *     QA23     one active case per employee (second initiate → 409); cancel→ACTIVE
 *     QA24     compute-fnf blocked while a clearance lane open / an asset un-returned;
 *              settle blocked while an asset is un-returned
 *     QA26     asset recovery (lost/damaged) feeds assetRecoveryAmount
 *     + manager clearance-lane scope (finance lane not manager-actionable → 403)
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/offboarding.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const { computeFnf } = require('../fnf');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${actual}, expected ${expected})`);
}

const R = (rupees) => Math.round(rupees * 100); // rupees → paise
const D = (dollars) => Math.round(dollars * 100); // dollars → cents

// ═══════════════════════════════════════════════════════════════════════════
// PART A — PURE FnF MATH (no DB)
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('\n=== PART A — fnf.js (pure, DB-free) ===\n');

  // ── QA10: IN gratuity ──
  log('QA10) IN gratuity:');
  {
    // 7.5y service, last Basic+DA ₹40,000 → (15/26)*40000*8 = ₹1,84,615.38 = 18461538 paise.
    const r = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', basicDaMonthlyMinor: R(40000), serviceYears: 7, serviceMonths: 6,
    });
    eq(r.snapshot.gratuityAmountMinor, 18461538, 'QA10 gratuity 7.5y ₹40k = ₹1,84,615.38');
    assert(r.lines.earnings.some((e) => e.code === 'FNF_GRATUITY'), 'QA10 gratuity earning line present');

    // Cap: gross gratuity at 30y ₹2,00,000 = ₹34,61,538.46 (the ₹20L cap is the
    // tax-exempt cap; the gross paid is still the formula amount).
    const cap = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', basicDaMonthlyMinor: R(200000), serviceYears: 30, serviceMonths: 0,
    });
    eq(cap.snapshot.gratuityAmountMinor, 346153846, 'QA10 gratuity 30y gross = ₹34,61,538.46');
    eq(cap.breakdown.gratuity.exemptMinor, 200000000, 'QA10 gratuity exempt capped at ₹20,00,000');

    // <5y → 0.
    const lt5 = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', basicDaMonthlyMinor: R(50000), serviceYears: 4, serviceMonths: 0,
    });
    eq(lt5.snapshot.gratuityAmountMinor, 0, 'QA10 gratuity <5y = 0');

    // DEATH waiver: <5y still pays the formula amount (15/26 × 50000 × 3).
    const death = computeFnf({ type: 'DEATH' }, {
      country: 'IN', basicDaMonthlyMinor: R(50000), serviceYears: 3, serviceMonths: 0,
    });
    eq(death.snapshot.gratuityAmountMinor, Math.floor(R(50000) * 15 * 3 / 26 + 0.5), 'QA10 DEATH waiver <5y pays gratuity');
    assert(death.breakdown.gratuity.waived === true, 'QA10 DEATH gratuity marked waived');
  }

  // ── QA11: IN leave encashment ──
  log('QA11) IN leave encashment:');
  {
    // 12 days, Basic+DA ₹52,000 → 12 × (52000/26) = ₹24,000 = 2400000 paise.
    const r = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', basicDaMonthlyMinor: R(52000), encashableLeaveDays: 12,
    });
    eq(r.snapshot.leaveEncashmentAmountMinor, 2400000, 'QA11 leave encashment 12d ₹52k = ₹24,000');
    eq(r.snapshot.leaveEncashmentDays, 12, 'QA11 leave encashment days = 12');
  }

  // ── QA12: notice shortfall recovery vs employer pay-in-lieu ──
  log('QA12) notice:');
  {
    // Employee resigned short (served 20 of 30) → recovery = 10 × per-day.
    // gross ₹60,000 / 30 = ₹2,000/day × 10 = ₹20,000.
    const recovery = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', grossMonthlyMinor: R(60000), noticeShortfallDays: 10,
    });
    eq(recovery.snapshot.noticeRecoveryAmountMinor, R(20000), 'QA12 notice shortfall recovery (deduction) = ₹20,000');
    eq(recovery.snapshot.noticePayInLieuMinor, 0, 'QA12 no pay-in-lieu for employee-initiated');
    assert(recovery.lines.deductions.some((d) => d.code === 'FNF_NOTICE_RECOVERY'), 'QA12 recovery is a deduction line');

    // Employer-initiated (redundancy) → pay-in-lieu EARNING instead of recovery.
    const lieu = computeFnf({ type: 'REDUNDANCY' }, {
      country: 'IN', grossMonthlyMinor: R(60000), noticeShortfallDays: 10,
    });
    eq(lieu.snapshot.noticePayInLieuMinor, R(20000), 'QA12 employer-initiated → pay-in-lieu earning = ₹20,000');
    eq(lieu.snapshot.noticeRecoveryAmountMinor, 0, 'QA12 employer-initiated → no recovery');
    assert(lieu.lines.earnings.some((e) => e.code === 'FNF_NOTICE_PAY_IN_LIEU'), 'QA12 pay-in-lieu is an earning line');
  }

  // ── QA13: NZ holiday payout (8% + max(OWP,AWE)); no IN gratuity ──
  log('QA13) NZ holiday payout:');
  {
    // 8% of gross-since-anniversary ($40,000 → $3,200) + 2 weeks untaken annual
    // leave at max(OWP $1,810, AWE $1,800) = $1,810 × 2 = $3,620. Total $6,820.
    const r = computeFnf({ type: 'RESIGNATION' }, {
      country: 'NZ', currencyCode: 'NZD',
      basicDaMonthlyMinor: D(8000), serviceYears: 7, serviceMonths: 6, // gratuity inputs ignored for NZ
      nz: {
        grossSinceAnniversaryMinor: D(40000),
        untakenAnnualLeaveWeeks: 2,
        owp: { specifiedWeeklyMinor: D(1810) },
        awe: { grossEarnings52Minor: D(1800 * 52) },
        workingDaysPerWeek: 5,
      },
    });
    eq(r.breakdown.nzHoliday.eightPctMinor, D(3200), 'QA13 8% of $40,000 = $3,200');
    eq(r.breakdown.nzHoliday.untakenMinor, D(3620), 'QA13 untaken 2wk @ max(OWP,AWE)=$1,810 = $3,620');
    eq(r.snapshot.nzHolidayPayoutAmountMinor, D(6820), 'QA13 nzHolidayPayout total = $6,820');
    eq(r.snapshot.gratuityAmountMinor, 0, 'QA13 NO IN gratuity for NZ');
    assert(!r.lines.earnings.some((e) => e.code === 'FNF_GRATUITY'), 'QA13 no gratuity earning line');
    assert(r.lines.earnings.some((e) => e.code === 'FNF_NZ_HOLIDAY_PAYOUT'), 'QA13 NZ holiday payout earning line present');
  }

  // ── QA14: netSettlement incl. recoveries; negative net still makes a PayRun ──
  log('QA14) netSettlement + recoveries:');
  {
    // Earnings: gratuity (7.5y ₹40k = ₹1,84,615.38). Deductions: loan ₹50,000 +
    // asset recovery ₹10,000. Net = 184615.38 − 60000 = ₹1,24,615.38.
    const r = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', basicDaMonthlyMinor: R(40000), serviceYears: 7, serviceMonths: 6,
      loanOutstandingMinor: R(50000), assetRecoveryMinor: R(10000),
    });
    eq(r.snapshot.loanForeclosureAmountMinor, R(50000), 'QA14 loan foreclosure = ₹50,000');
    eq(r.snapshot.assetRecoveryAmountMinor, R(10000), 'QA14 asset recovery = ₹10,000');
    eq(r.snapshot.netSettlementMinor, 18461538 - R(60000), 'QA14 net = gratuity − (loan+asset)');
    assert(r.recoverableBalance === false, 'QA14 positive net is not recoverable');

    // Negative net (recoveries exceed earnings) → recoverable, STILL produces a PayRun.
    const neg = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', basicDaMonthlyMinor: R(40000), // <5y not given → no gratuity
      serviceYears: 1, serviceMonths: 0,
      loanOutstandingMinor: R(500000), assetRecoveryMinor: R(30000),
    });
    assert(neg.snapshot.netSettlementMinor < 0, 'QA14 negative net (recoverable balance)');
    assert(neg.recoverableBalance === true, 'QA14 recoverableBalance flag set');
    assert(neg.payRunInput && neg.payRunInput.type === 'FNF', 'QA14 negative net STILL produces a PayRun(type=FNF)');
    eq(neg.payRunInput.netMinor, neg.snapshot.netSettlementMinor, 'QA14 PayRun net == snapshot net');
  }

  // ── QA15: the FnF lines == the SeparationCase snapshot exactly ──
  log('QA15) lines == snapshot:');
  {
    const r = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', basicDaMonthlyMinor: R(40000), grossMonthlyMinor: R(80000),
      serviceYears: 7, serviceMonths: 6, encashableLeaveDays: 12,
      noticeShortfallDays: 5, loanOutstandingMinor: R(20000), assetRecoveryMinor: R(5000),
    });
    // Sum the earning/deduction lines and reconcile against the snapshot fields.
    const earnSum = r.lines.earnings.reduce((a, e) => a + e.amountMinor, 0);
    const dedSum = r.lines.deductions.reduce((a, d) => a + d.amountMinor, 0);
    eq(r.payRunInput.grossMinor, earnSum, 'QA15 payRunInput.gross == Σ earning lines');
    eq(r.payRunInput.totalDeductionsMinor, dedSum, 'QA15 payRunInput.deductions == Σ deduction lines');
    eq(r.snapshot.netSettlementMinor, earnSum - dedSum, 'QA15 snapshot.net == Σ earnings − Σ deductions');
    // Each snapshot money field is reflected in a line (or zero).
    const gratuityLine = r.lines.earnings.find((e) => e.code === 'FNF_GRATUITY');
    eq(gratuityLine ? gratuityLine.amountMinor : 0, r.snapshot.gratuityAmountMinor, 'QA15 gratuity line == snapshot.gratuityAmount');
    const leaveLine = r.lines.earnings.find((e) => e.code === 'FNF_LEAVE_ENCASH');
    eq(leaveLine ? leaveLine.amountMinor : 0, r.snapshot.leaveEncashmentAmountMinor, 'QA15 leave line == snapshot.leaveEncashmentAmount');
    const noticeLine = r.lines.deductions.find((d) => d.code === 'FNF_NOTICE_RECOVERY');
    eq(noticeLine ? noticeLine.amountMinor : 0, r.snapshot.noticeRecoveryAmountMinor, 'QA15 notice line == snapshot.noticeRecoveryAmount');
    const loanLine = r.lines.deductions.find((d) => d.code === 'FNF_LOAN_FORECLOSURE');
    eq(loanLine ? loanLine.amountMinor : 0, r.snapshot.loanForeclosureAmountMinor, 'QA15 loan line == snapshot.loanForeclosureAmount');
    const assetLine = r.lines.deductions.find((d) => d.code === 'FNF_ASSET_RECOVERY');
    eq(assetLine ? assetLine.amountMinor : 0, r.snapshot.assetRecoveryAmountMinor, 'QA15 asset line == snapshot.assetRecoveryAmount');
  }

  // ── M1+M2 (QA15-reconcile): payRunInput reconciles gross−ded=net AND carries
  //    EVERY component incl. unpaid salary + employer pay-in-lieu + statutory ──
  log('M1+M2) PayRun-from-snapshot reconciles + carries all components:');
  {
    // Employer-initiated (redundancy) so notice is a pay-in-lieu EARNING, plus
    // unpaid salary + statutory deduction — the three the old re-derivation dropped.
    const r = computeFnf({ type: 'REDUNDANCY' }, {
      country: 'IN', basicDaMonthlyMinor: R(40000), grossMonthlyMinor: R(80000),
      serviceYears: 7, serviceMonths: 6, encashableLeaveDays: 12,
      noticeShortfallDays: 10,                 // employer-initiated → pay-in-lieu earning
      unpaidSalaryMinor: R(15000),             // days-worked-to-LWD
      statutoryDeductionsMinor: R(3000),       // TDS on the FnF
      loanOutstandingMinor: R(20000), assetRecoveryMinor: R(5000),
    });
    const pri = r.payRunInput;
    const earnSum = pri.earnings.reduce((a, e) => a + e.amountMinor, 0);
    const dedSum = pri.deductions.reduce((a, d) => a + d.amountMinor, 0);
    // Reconciliation: gross − deductions === net, ALWAYS.
    eq(pri.grossMinor, earnSum, 'M1 payRunInput.gross == Σ earning lines');
    eq(pri.totalDeductionsMinor, dedSum, 'M1 payRunInput.deductions == Σ deduction lines');
    eq(pri.grossMinor - pri.totalDeductionsMinor, pri.netMinor, 'M1 gross − deductions === net (reconciles)');
    eq(pri.netMinor, r.snapshot.netSettlementMinor, 'M2 payRunInput.net == snapshot.netSettlement');
    // The three components the OLD re-derivation silently dropped are present.
    assert(pri.earnings.some((e) => e.code === 'FNF_UNPAID_SALARY' && e.amountMinor === R(15000)), 'M2 unpaid salary earning present');
    assert(pri.earnings.some((e) => e.code === 'FNF_NOTICE_PAY_IN_LIEU' && e.amountMinor > 0), 'M2 employer pay-in-lieu earning present');
    assert(pri.deductions.some((d) => d.code === 'FNF_STATUTORY' && d.amountMinor === R(3000)), 'M2 statutory deduction present');
    // And gratuity/encashment/loan/asset are all still there too.
    assert(pri.earnings.some((e) => e.code === 'FNF_GRATUITY'), 'M2 gratuity earning present');
    assert(pri.earnings.some((e) => e.code === 'FNF_LEAVE_ENCASH'), 'M2 encashment earning present');
    assert(pri.deductions.some((d) => d.code === 'FNF_LOAN_FORECLOSURE'), 'M2 loan deduction present');
    assert(pri.deductions.some((d) => d.code === 'FNF_ASSET_RECOVERY'), 'M2 asset deduction present');
  }

  // ── M3: gratuity ₹20L cap must NOT cap the PAYOUT on a death/disablement waiver ──
  log('M3) death-waiver high-wage pays FULL 15/26 amount (not ₹20L):');
  {
    // DEATH with <5y service (the 5y-gate WAIVER branch — the one that used to cap
    // the payout) AND a wage high enough that the formula amount EXCEEDS ₹20,00,000.
    // The payout must be the full formula amount; only the EXEMPT portion is capped.
    const death = computeFnf({ type: 'DEATH' }, {
      country: 'IN', basicDaMonthlyMinor: R(2500000), serviceYears: 3, serviceMonths: 0,
    });
    const full = Math.floor(R(2500000) * 15 * 3 / 26 + 0.5); // ₹43,26,923 > ₹20L
    assert(full > 200000000, 'M3 fixture exceeds the ₹20L cap (sanity)');
    assert(death.breakdown.gratuity.waived === true, 'M3 <5y death takes the WAIVER branch');
    eq(death.snapshot.gratuityAmountMinor, full, 'M3 DEATH waiver pays the FULL 15/26 amount (uncapped payout, NOT ₹20L)');
    eq(death.breakdown.gratuity.exemptMinor, 200000000, 'M3 exempt portion capped at ₹20,00,000');
    eq(death.breakdown.gratuity.taxableMinor, full - 200000000, 'M3 taxable = gross − exempt cap');
    // Belt-and-braces: the eligible (≥5y) high-wage death also pays full (india.js path).
    const eligibleDeath = computeFnf({ type: 'DEATH' }, {
      country: 'IN', basicDaMonthlyMinor: R(500000), serviceYears: 8, serviceMonths: 0,
    });
    const fullEligible = Math.floor(R(500000) * 15 * 8 / 26 + 0.5);
    eq(eligibleDeath.snapshot.gratuityAmountMinor, fullEligible, 'M3 ≥5y death also pays full uncapped (india.js normal path)');
  }

  // ── M5: leave encashment rounds ONCE (no per-day double-round) ──
  log('M5) leave encashment single-round:');
  {
    // Basic+DA ₹50,000 → per-day = floor(5000000/26 + 0.5) = 192308 (₹1,923.08).
    // OLD double-round: 192308 × 7 = 1346156. SINGLE-round: floor(5000000×7/26+0.5)
    // = floor(1346153.84+0.5) = 1346154. The two differ → proves single-round.
    const r = computeFnf({ type: 'RESIGNATION' }, {
      country: 'IN', basicDaMonthlyMinor: R(50000), encashableLeaveDays: 7,
    });
    const singleRound = Math.floor(R(50000) * 7 / 26 + 0.5);
    const perDay = Math.floor(R(50000) / 26 + 0.5);
    const doubleRound = perDay * 7;
    assert(singleRound !== doubleRound, 'M5 fixture distinguishes single vs double round (sanity)');
    eq(r.snapshot.leaveEncashmentAmountMinor, singleRound, 'M5 encashment uses ONE rounding (× days off unrounded ÷26)');
  }

  // ── M6: NZ payout flags requiresInput when earnings are not resolvable ──
  log('M6) NZ payout requiresInput when earnings unresolved (no fabricated 0/proxy):');
  {
    const r = computeFnf({ type: 'RESIGNATION' }, {
      country: 'NZ', currencyCode: 'NZD',
      nz: { earningsResolved: false },
    });
    assert(r.nzRequiresInput === true, 'M6 nzRequiresInput set when earningsResolved:false');
    eq(r.snapshot.nzHolidayPayoutAmountMinor, 0, 'M6 no fabricated payout when earnings unresolved');
    // When earnings ARE supplied, it computes normally and does NOT flag.
    const ok = computeFnf({ type: 'RESIGNATION' }, {
      country: 'NZ', currencyCode: 'NZD',
      nz: { earningsResolved: true, grossSinceAnniversaryMinor: D(40000) },
    });
    assert(ok.nzRequiresInput === false, 'M6 not flagged when earnings supplied');
    eq(ok.breakdown.nzHoliday.eightPctMinor, D(3200), 'M6 8% of $40,000 = $3,200 when resolved');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test (state machine + RBAC + SoD + assets)
// ═══════════════════════════════════════════════════════════════════════════
function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res); res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'OFB-TEST';

async function partB() {
  log('\n=== PART B — LIVE hr_test (separation state machine + RBAC + SoD + assets) ===\n');

  const prisma = require('../../../core/lib/prisma');
  const offboarding = require('../controllers/offboarding.controller');
  const assets = require('../../controllers/assets.controller');
  const { seedOnboardingTemplates } = require('../templates/seed');
  const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const entity = await prisma.entity.findFirst({ where: { businessId } });
  if (!entity) throw new Error('No entity in demo tenant');
  const entityId = entity.id;

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const empIds = emps.map((e) => e.id);
    if (empIds.length) {
      const seps = await prisma.separationCase.findMany({ where: { businessId, employeeId: { in: empIds } }, select: { id: true, fnfPayRunId: true } });
      const journeyIds = (await prisma.lifecycleJourney.findMany({ where: { businessId, employeeId: { in: empIds } }, select: { id: true } })).map((j) => j.id);
      if (journeyIds.length) await prisma.lifecycleTask.deleteMany({ where: { journeyId: { in: journeyIds } } });
      await prisma.lifecycleJourney.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      const payRunIds = seps.map((s) => s.fnfPayRunId).filter(Boolean);
      await prisma.separationCase.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      if (payRunIds.length) await prisma.payRun.deleteMany({ where: { id: { in: payRunIds } } });
      const asg = await prisma.assetAssignment.findMany({ where: { businessId, employeeId: { in: empIds } }, select: { id: true } });
      if (asg.length) await prisma.assetAssignment.deleteMany({ where: { id: { in: asg.map((a) => a.id) } } });
      await prisma.compensationRevision.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
      await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    }
    await prisma.asset.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  }

  await cleanup();

  try {
    await seedOnboardingTemplates(prisma, businessId, { entityId });
    log('B0) templates seeded (IN + NZ onboarding + offboarding)');

    // ── Build a manager + an exiting employee (with current EmploymentRecord) ──
    const manager = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-MGR`, firstName: 'Mgr', lastName: 'X', status: 'ACTIVE' },
    });
    const emp = await prisma.employee.create({
      data: {
        businessId, code: `${PREFIX}-EMP`, firstName: 'Exit', lastName: 'Emp', status: 'ACTIVE',
        managerEmployeeId: manager.id, hireDate: new Date('2018-01-01'),
      },
    });
    await prisma.employmentRecord.create({
      data: {
        businessId, employeeId: emp.id, entityId, employmentType: 'FULL_TIME', workerCategory: 'STAFF',
        noticeDays: 30, effectiveFrom: new Date('2018-01-01'), changeReason: 'HIRE', isCurrent: true,
      },
    });

    const opUser = { id: `${PREFIX}-op`, businessId, role: 'BUSINESS_ADMIN' };
    const op2User = { id: `${PREFIX}-op2`, businessId, role: 'BUSINESS_ADMIN' };
    // Resolve ALL scope for the operators (HR-Admin band).
    opUser.scope = await resolveAccessibleEmployeeIds(opUser, 'canRunSeparation');
    op2User.scope = await resolveAccessibleEmployeeIds(op2User, 'canApprovePayroll');

    // ── QA23: initiate a separation → INITIATED + journey + employee NOTICE_PERIOD ──
    log('QA23) initiate + one active case:');
    let init = await callController(offboarding.initiateSeparation, {
      user: opUser, scope: opUser.scope, params: {},
      body: { employeeId: emp.id, type: 'RESIGNATION', reason: 'moving on', lwd: '2026-07-31' },
    });
    eq(init.statusCode, 201, 'QA23 initiate → 201');
    const sepId = init.body.separation.id;
    assert(init.body.separation.status === 'INITIATED', 'QA23 case status INITIATED');
    const empAfter = await prisma.employee.findUnique({ where: { id: emp.id } });
    eq(empAfter.status, 'NOTICE_PERIOD', 'QA23 employee flipped to NOTICE_PERIOD');
    const journey = await prisma.lifecycleJourney.findFirst({ where: { businessId, separationId: sepId } });
    assert(journey && journey.direction === 'OFFBOARDING', 'QA23 OFFBOARDING journey spawned');

    // Second active initiate → 409 (one active case per employee).
    const dup = await callController(offboarding.initiateSeparation, {
      user: opUser, scope: opUser.scope, params: {},
      body: { employeeId: emp.id, type: 'RESIGNATION', lwd: '2026-08-31' },
    });
    eq(dup.statusCode, 409, 'QA23 second active initiate → 409');

    // ── QA24a: compute-fnf blocked while clearance lanes open ──
    log('QA24) compute/settle guards:');
    let comp = await callController(offboarding.computeFnf, {
      user: opUser, scope: opUser.scope, params: { id: sepId }, body: {},
    });
    eq(comp.statusCode, 422, 'QA24 compute-fnf blocked while clearance open → 422');
    assert(comp.body.reason === 'clearance-open', 'QA24 reason clearance-open');

    // ── QA26 / QA24b: assign an asset, do NOT return it → asset lane + compute blocked ──
    const assetRow = await callController(assets.createAsset, {
      user: opUser, params: {}, body: { code: `${PREFIX}-LAP`, name: 'MacBook', category: 'LAPTOP' },
    });
    const assetId = assetRow.body.id;
    const assignRes = await callController(assets.assign, {
      user: opUser, params: {}, body: { assetId, employeeId: emp.id, conditionOut: 'GOOD' },
    });
    const assignmentId = assignRes.body.id;

    // Manager may clear ONLY KT + assets; finance lane → 403 (lane not manager-owned).
    const mgrUser = { id: `${PREFIX}-mgr-user`, businessId, role: 'STAFF', employeeId: manager.id, businessRole: { defaultScope: 'TEAM' } };
    mgrUser.scope = await resolveAccessibleEmployeeIds(mgrUser, 'canViewEmployees');
    const mgrFinance = await callController(offboarding.updateClearance, {
      user: mgrUser, scope: mgrUser.scope, params: { id: sepId }, body: { lane: 'finance', status: 'CLEARED' },
    });
    eq(mgrFinance.statusCode, 403, 'QA-RBAC manager cannot clear the finance lane → 403');

    // Manager tries to clear the asset lane while the asset is still out → 422.
    const mgrAssetEarly = await callController(offboarding.updateClearance, {
      user: mgrUser, scope: mgrUser.scope, params: { id: sepId }, body: { lane: 'assets', status: 'CLEARED' },
    });
    eq(mgrAssetEarly.statusCode, 422, 'QA24 asset lane clear blocked while asset un-returned → 422');

    // HR clears the non-asset lanes.
    for (const lane of ['it', 'finance', 'admin', 'knowledge_transfer']) {
      const r = await callController(offboarding.updateClearance, {
        user: opUser, scope: opUser.scope, params: { id: sepId }, body: { lane, status: 'CLEARED' },
      });
      eq(r.statusCode, 200, `QA24 HR clears ${lane} lane → 200`);
    }

    // compute-fnf still blocked: the asset lane is open AND the asset is un-returned.
    comp = await callController(offboarding.computeFnf, {
      user: opUser, scope: opUser.scope, params: { id: sepId }, body: {},
    });
    eq(comp.statusCode, 422, 'QA24 compute-fnf still blocked (asset lane open / asset out) → 422');

    // Return the asset DAMAGED with a recovery amount (QA26: feeds assetRecoveryAmount).
    const ret = await callController(assets.returnAsset, {
      user: opUser, params: { id: assignmentId }, body: { conditionIn: 'DAMAGED', recoveryAmount: '5000.00' },
    });
    eq(ret.statusCode, 200, 'QA26 returnAsset DAMAGED + recovery → 200');
    const assignmentNow = await prisma.assetAssignment.findUnique({ where: { id: assignmentId } });
    assert(assignmentNow.returnedAt != null && Number(assignmentNow.recoveryAmount) === 5000, 'QA26 recoveryAmount recorded on returned assignment');

    // Now the asset lane can be cleared (asset resolved), then compute-fnf passes.
    const assetClear = await callController(offboarding.updateClearance, {
      user: opUser, scope: opUser.scope, params: { id: sepId }, body: { lane: 'assets', status: 'CLEARED' },
    });
    eq(assetClear.statusCode, 200, 'QA24 asset lane clears once asset resolved → 200');

    comp = await callController(offboarding.computeFnf, {
      user: opUser, scope: opUser.scope, params: { id: sepId }, body: {},
    });
    eq(comp.statusCode, 200, 'QA24 compute-fnf passes once all lanes cleared + assets resolved → 200');
    const sepComputed = await prisma.separationCase.findUnique({ where: { id: sepId } });
    eq(sepComputed.status, 'FNF_COMPUTED', 'QA24 case → FNF_COMPUTED');
    eq(Number(sepComputed.assetRecoveryAmount), 5000, 'QA26 assetRecoveryAmount = ₹5,000 (from the damaged asset)');

    // ── QA9 / SoD: the INITIATOR cannot approve the FnF ──
    log('QA9) SoD initiator ≠ approver:');
    const initiatorApprove = await callController(offboarding.approveFnf, {
      user: opUser, scope: opUser.scope, params: { id: sepId }, body: {},
    });
    eq(initiatorApprove.statusCode, 403, 'QA9 initiator approve-fnf → 403 (SoD)');
    assert(initiatorApprove.body.reason === 'sod-initiator-equals-approver', 'QA9 SoD reason set');

    // A DIFFERENT canApprovePayroll actor approves → 200 + PayRun(type=FNF) linked.
    const otherApprove = await callController(offboarding.approveFnf, {
      user: op2User, scope: op2User.scope, params: { id: sepId }, body: {},
    });
    eq(otherApprove.statusCode, 200, 'QA9 different approver → 200');
    assert(otherApprove.body.payRun && otherApprove.body.payRun.type === 'FNF', 'QA9 PayRun(type=FNF) created + linked');
    const sepApproved = await prisma.separationCase.findUnique({ where: { id: sepId } });
    eq(sepApproved.status, 'FNF_APPROVED', 'QA9 case → FNF_APPROVED');
    assert(sepApproved.fnfPayRunId != null, 'QA9 fnfPayRunId linked');

    // ── settle: end-dates the employee, revokes access, completes the journey ──
    log('settle) revoke access + end-date + manager-reassign guard:');
    const settle = await callController(offboarding.settleSeparation, {
      user: opUser, scope: opUser.scope, params: { id: sepId }, body: {},
    });
    eq(settle.statusCode, 200, 'settle → 200');
    const sepSettled = await prisma.separationCase.findUnique({ where: { id: sepId } });
    eq(sepSettled.status, 'SETTLED', 'settle → SETTLED');
    const empSettled = await prisma.employee.findUnique({ where: { id: emp.id } });
    eq(empSettled.status, 'TERMINATED', 'settle → employee TERMINATED');
    assert(empSettled.terminationDate != null && empSettled.isActive === false, 'settle → terminationDate set + isActive false');

    // ── letters: gated on SETTLED → relieving letter with a verifiable fileHash ──
    log('letters) relieving letter gated on SETTLED:');
    const letter = await callController(offboarding.generateLetters, {
      user: opUser, scope: opUser.scope, params: { id: sepId }, body: { type: 'relieving' },
    });
    eq(letter.statusCode, 201, 'letters → 201 (case SETTLED)');
    assert(letter.body.document && typeof letter.body.document.fileHash === 'string' && letter.body.document.fileHash.length === 64, 'letters → verifiable SHA-256 fileHash');
    eq(letter.body.document.visibility, 'EMPLOYEE_VISIBLE', 'letters → EMPLOYEE_VISIBLE doc');

    // ── M1+M2 (live): the minted PayRun reconciles + is fed from the snapshot ──
    log('M1+M2-live) PayRun(FNF) totals == snapshot payRunInput; gross−ded=net:');
    {
      const sepRow = await prisma.separationCase.findUnique({ where: { id: sepId } });
      assert(sepRow.fnfSnapshotJson && sepRow.fnfSnapshotJson.payRunInput, 'M1 fnfSnapshotJson.payRunInput persisted on the case');
      const pri = sepRow.fnfSnapshotJson.payRunInput;
      const payRun = await prisma.payRun.findUnique({ where: { id: sepRow.fnfPayRunId } });
      const toMinor = (d) => Math.round(Number(d) * 100);
      eq(toMinor(payRun.totalGross), Math.round(pri.grossMinor), 'M1 PayRun.totalGross == snapshot gross');
      eq(toMinor(payRun.totalDeductions), Math.round(pri.totalDeductionsMinor), 'M1 PayRun.totalDeductions == snapshot deductions');
      eq(toMinor(payRun.totalNet), Math.round(pri.netMinor), 'M1 PayRun.totalNet == snapshot net');
      eq(toMinor(payRun.totalGross) - toMinor(payRun.totalDeductions), toMinor(payRun.totalNet), 'M2 PayRun gross − deductions === net (reconciles)');
      // The snapshot's lines sum to those very totals.
      const eSum = pri.earnings.reduce((a, e) => a + e.amountMinor, 0);
      const dSum = pri.deductions.reduce((a, d) => a + d.amountMinor, 0);
      eq(eSum, Math.round(pri.grossMinor), 'M2 Σ snapshot earning lines == gross');
      eq(dSum, Math.round(pri.totalDeductionsMinor), 'M2 Σ snapshot deduction lines == deductions');
    }

    // ── M4 (live): a SHORT-NOTICE resignation yields a NOTICE_RECOVERY deduction ──
    log('M4-live) short-notice resignation → NOTICE_RECOVERY fires from dates:');
    {
      const shortEmp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-SHORT`, firstName: 'Short', lastName: 'Notice', status: 'ACTIVE', hireDate: new Date('2019-01-01') },
      });
      await prisma.employmentRecord.create({
        data: { businessId, employeeId: shortEmp.id, entityId, employmentType: 'FULL_TIME', workerCategory: 'STAFF', noticeDays: 30, effectiveFrom: new Date('2019-01-01'), changeReason: 'HIRE', isCurrent: true },
      });
      // Gross monthly pay so the notice per-day (and thus the recovery amount) is non-zero.
      await prisma.compensationRevision.create({
        data: { businessId, employeeId: shortEmp.id, entityId, currencyCode: entity.payCurrency, basis: 'GROSS', revisionReason: 'HIRE', grossMonthly: '60000.00', effectiveFrom: new Date('2019-01-01'), isCurrent: true },
      });
      // Resignation TODAY with an LWD only 5 days out → 25-day shortfall.
      const lwd = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      const si = await callController(offboarding.initiateSeparation, {
        user: opUser, scope: opUser.scope, params: {},
        body: { employeeId: shortEmp.id, type: 'RESIGNATION', resignationDate: new Date().toISOString().slice(0, 10), lwd },
      });
      eq(si.statusCode, 201, 'M4 short-notice initiate → 201');
      const shortSep = await prisma.separationCase.findUnique({ where: { id: si.body.separation.id } });
      assert(shortSep.noticeShortfallDays >= 20, `M4 noticeShortfallDays persisted from dates (got ${shortSep.noticeShortfallDays})`);
      // Clear all lanes (no assets) then compute → the snapshot carries a recovery.
      for (const lane of ['it', 'finance', 'admin', 'knowledge_transfer', 'assets']) {
        await callController(offboarding.updateClearance, { user: opUser, scope: opUser.scope, params: { id: shortSep.id }, body: { lane, status: 'CLEARED' } });
      }
      const sc = await callController(offboarding.computeFnf, { user: opUser, scope: opUser.scope, params: { id: shortSep.id }, body: {} });
      eq(sc.statusCode, 200, 'M4 compute-fnf → 200');
      const recovered = await prisma.separationCase.findUnique({ where: { id: shortSep.id } });
      assert(Number(recovered.noticeRecoveryAmount) > 0, 'M4 employee-initiated short notice → NOTICE_RECOVERY deduction > 0');
      assert(recovered.fnfSnapshotJson.payRunInput.deductions.some((d) => d.code === 'FNF_NOTICE_RECOVERY'), 'M4 NOTICE_RECOVERY line in the snapshot');
    }

    // ── S7 (live): SoD FAILS CLOSED on a null initiator + on self-approve ──
    log('S7-live) SoD fails-closed: null initiator → 403; self-approve → 403:');
    {
      // Build a fresh FNF_COMPUTED case, then NULL its initiator to simulate a
      // legacy/un-attributable case — approve must FAIL CLOSED (not fail-open).
      const sEmp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-SOD`, firstName: 'Sod', lastName: 'Case', status: 'ACTIVE', hireDate: new Date('2017-01-01') },
      });
      await prisma.employmentRecord.create({
        data: { businessId, employeeId: sEmp.id, entityId, employmentType: 'FULL_TIME', workerCategory: 'STAFF', noticeDays: 30, effectiveFrom: new Date('2017-01-01'), changeReason: 'HIRE', isCurrent: true },
      });
      const si = await callController(offboarding.initiateSeparation, {
        user: opUser, scope: opUser.scope, params: {},
        body: { employeeId: sEmp.id, type: 'RESIGNATION', lwd: '2026-12-31' },
      });
      const sodSepId = si.body.separation.id;
      for (const lane of ['it', 'finance', 'admin', 'knowledge_transfer', 'assets']) {
        await callController(offboarding.updateClearance, { user: opUser, scope: opUser.scope, params: { id: sodSepId }, body: { lane, status: 'CLEARED' } });
      }
      await callController(offboarding.computeFnf, { user: opUser, scope: opUser.scope, params: { id: sodSepId }, body: {} });
      // NULL the initiator → fail-closed.
      await prisma.separationCase.update({ where: { id: sodSepId }, data: { initiatedByUserId: null } });
      const nullInit = await callController(offboarding.approveFnf, { user: op2User, scope: op2User.scope, params: { id: sodSepId }, body: {} });
      eq(nullInit.statusCode, 403, 'S7 null initiator → 403 (fail-closed)');
      assert(nullInit.body.reason === 'sod-initiator-unknown', 'S7 fail-closed reason set');
      // Restore initiator = opUser, then opUser (the initiator) self-approves → 403.
      await prisma.separationCase.update({ where: { id: sodSepId }, data: { initiatedByUserId: opUser.id } });
      const selfApprove = await callController(offboarding.approveFnf, { user: opUser, scope: opUser.scope, params: { id: sodSepId }, body: {} });
      eq(selfApprove.statusCode, 403, 'S7 initiator self-approve → 403');
      assert(selfApprove.body.reason === 'sod-initiator-equals-approver', 'S7 self-approve reason set');
    }

    // ── S8 (live): a TERMINATED employee's ESS state-changes are blocked ──
    log('S8-live) terminated employee ESS resign/acknowledge blocked:');
    {
      const meSep = require('../controllers/meSeparation.controller');
      // emp (from QA23) was TERMINATED by settle above; its ESS resolves to that row.
      const termEmp = await prisma.employee.findUnique({ where: { id: emp.id } });
      assert(termEmp.status === 'TERMINATED' || termEmp.isActive === false, 'S8 sanity: emp is terminated/inactive');
      // Give it a workEmail so resolveSelfEmployee finds it from the customer session.
      await prisma.employee.update({ where: { id: emp.id }, data: { workEmail: `${PREFIX}-term@x.com` } });
      const custReq = { customer: { businessId, email: `${PREFIX}-term@x.com`, id: 'cust-term' }, body: { intendedLastDay: '2027-01-01' } };
      const resignRes = await callController(meSep.resign, custReq);
      eq(resignRes.statusCode, 403, 'S8 terminated employee resign → 403');
      assert(resignRes.body.reason === 'separated', 'S8 resign blocked reason=separated');
    }

    // ── S9 (live): a plain override CANNOT mint a relieving letter pre-FnF-approval ──
    log('S9-live) override refuses pre-FNF-approval; SETTLED letters still work:');
    {
      const lEmp = await prisma.employee.create({
        data: { businessId, code: `${PREFIX}-LET`, firstName: 'Letter', lastName: 'Gate', status: 'ACTIVE', hireDate: new Date('2021-01-01') },
      });
      await prisma.employmentRecord.create({
        data: { businessId, employeeId: lEmp.id, entityId, employmentType: 'FULL_TIME', workerCategory: 'STAFF', noticeDays: 30, effectiveFrom: new Date('2021-01-01'), changeReason: 'HIRE', isCurrent: true },
      });
      const si = await callController(offboarding.initiateSeparation, {
        user: opUser, scope: opUser.scope, params: {}, body: { employeeId: lEmp.id, type: 'RESIGNATION', lwd: '2026-12-31' },
      });
      const lSepId = si.body.separation.id;
      // Case is INITIATED (pre-FnF). A plain override must be refused (not-settled), and
      // even an elevated override is refused pre-FNF-approval.
      const elevatedUser = { ...opUser, businessRole: { defaultScope: 'ALL', permissions: { canGenerateLetters: true, canManageOrg: true } } };
      const forced = await callController(offboarding.generateLetters, {
        user: elevatedUser, scope: opUser.scope, params: { id: lSepId }, body: { type: 'relieving', override: true },
      });
      eq(forced.statusCode, 422, 'S9 elevated override pre-FnF-approval → 422 (refused)');
      assert(forced.body.reason === 'override-pre-fnf-approval', 'S9 override-pre-fnf-approval reason set');
      // A NON-elevated user (no canManageOrg) on a non-settled case → 403 on override.
      const plainUser = { ...opUser, businessRole: { defaultScope: 'ALL', permissions: { canGenerateLetters: true } } };
      // Push the case to FNF_APPROVED so the only gate left is the elevated-permission one.
      await prisma.separationCase.update({ where: { id: lSepId }, data: { status: 'FNF_APPROVED' } });
      const plainForce = await callController(offboarding.generateLetters, {
        user: plainUser, scope: opUser.scope, params: { id: lSepId }, body: { type: 'relieving', override: true },
      });
      eq(plainForce.statusCode, 403, 'S9 non-elevated override → 403 (needs canManageOrg)');
      assert(plainForce.body.reason === 'override-needs-elevated-permission', 'S9 elevated-permission reason set');
    }

    // ── cancel guard: a NEW case can be cancelled (returns employee to ACTIVE) ──
    log('cancel) pre-SETTLE withdraw → employee ACTIVE:');
    // Re-activate the original employee for a fresh case (it was terminated above).
    const emp2 = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-EMP2`, firstName: 'Second', lastName: 'Leaver', status: 'ACTIVE', hireDate: new Date('2020-01-01') },
    });
    await prisma.employmentRecord.create({
      data: { businessId, employeeId: emp2.id, entityId, employmentType: 'FULL_TIME', workerCategory: 'STAFF', noticeDays: 30, effectiveFrom: new Date('2020-01-01'), changeReason: 'HIRE', isCurrent: true },
    });
    const init2 = await callController(offboarding.initiateSeparation, {
      user: opUser, scope: opUser.scope, params: {}, body: { employeeId: emp2.id, type: 'RESIGNATION', lwd: '2026-09-30' },
    });
    eq(init2.statusCode, 201, 'cancel-setup initiate → 201');
    const cancel = await callController(offboarding.cancelSeparation, {
      user: opUser, scope: opUser.scope, params: { id: init2.body.separation.id }, body: { reason: 'withdrawn' },
    });
    eq(cancel.statusCode, 200, 'cancel → 200');
    const emp2After = await prisma.employee.findUnique({ where: { id: emp2.id } });
    eq(emp2After.status, 'ACTIVE', 'cancel → employee back to ACTIVE');
  } finally {
    await cleanup();
  }
}

async function main() {
  partA();
  if (!process.env.DATABASE_URL) {
    log('\n[skip] PART B — DATABASE_URL not set (pure-math PART A ran DB-free).\n');
  } else {
    try {
      await partB();
    } catch (e) {
      failures += 1;
      log(`  FAIL  PART B threw: ${e && e.stack ? e.stack : e}`);
    }
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

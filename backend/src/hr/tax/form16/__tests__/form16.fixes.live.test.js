'use strict';

/*
 * form16.fixes.live.test.js — Feature 24 regression proof for the 5 CONFIRMED
 * review findings (cycle 3). Plain-node test (built-in assert, real prisma against
 * hr_test), same harness as form16.live.test.js:
 *
 *   DATABASE_URL="$HR_URL" node src/hr/tax/form16/__tests__/form16.fixes.live.test.js
 *
 * Proves, per finding:
 *   1. Part A challan is PER-EMPLOYEE (no entity-pool leak onto a cert) + the §201
 *      gap is computed at the entity/batch level (a real short-deposit fails it) +
 *      the batch deposited roll-up is the entity pool, not a quadratic over-count.
 *   2. Part B FOOTS to F15 to the paise (gross-total − ChVI-A == F15 taxable income),
 *      with PT disclosed as a §16(iii) memo and NOT netted into the certified income.
 *   3. 24Q Q4 Annexure-II includes EVERY salaried employee for the FY — including a
 *      NIL-TDS one — even when a TDS certificate already exists.
 *   4. regenerate SUPERSEDES (old row immutable + SUPERSEDED + back-linked; a NEW
 *      PENDING row carries the fresh figures) — it never mutates a frozen cert.
 *   5. issue does NOT flip the batch to ISSUED when zero certs actually issued.
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const svc = require('../form16.service');
const form24q = require('../form24q.service');
const letters = require('../../../letters/letters.service');
const { buildTaxProjection } = require('../../projectionAssembler');

const PREFIX = 'F24FIX';
let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; } else { failed += 1; console.error(`FAIL  ${label}`); }
}

const MAKER = 'fix-maker-1';
const CHECKER = 'fix-checker-2';

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  const batches = await prisma.form16Batch.findMany({ where: { businessId, entity: { code: { startsWith: PREFIX } } }, select: { id: true } }).catch(() => []);
  await prisma.form16Certificate.deleteMany({ where: { businessId, OR: [{ employeeId: { in: ids } }, { batchId: { in: batches.map((b) => b.id) } }] } }).catch(() => {});
  await prisma.form16Batch.deleteMany({ where: { businessId, entity: { code: { startsWith: PREFIX } } } }).catch(() => {});
  if (ids.length) {
    await prisma.issuedLetter.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    const docs = await prisma.employeeDocument.findMany({ where: { businessId, employeeId: { in: ids } }, select: { id: true } }).catch(() => []);
    const docIds = docs.map((d) => d.id);
    if (docIds.length) {
      const envs = await prisma.signatureEnvelope.findMany({ where: { businessId, employeeDocumentId: { in: docIds } }, select: { id: true } }).catch(() => []);
      const envIds = envs.map((e) => e.id);
      if (envIds.length) await prisma.signatureSigner.deleteMany({ where: { envelopeId: { in: envIds } } }).catch(() => {});
      await prisma.signatureEnvelope.deleteMany({ where: { businessId, employeeDocumentId: { in: docIds } } }).catch(() => {});
    }
    await prisma.employeeDocument.deleteMany({ where: { businessId, employeeId: { in: ids } } }).catch(() => {});
    await prisma.payslip.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.payRunLine.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.salaryComponentLine.deleteMany({ where: { businessId, compensation: { employeeId: { in: ids } } } }).catch(() => {});
    await prisma.compensationRevision.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.statutoryProfile.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employmentRecord.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }
  await prisma.statutoryRemittance.deleteMany({ where: { businessId, entity: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.payRun.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.salaryComponent.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.payCalendar.deleteMany({ where: { businessId, entity: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.entity.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
}

// Mint an India entity + monthly calendar.
async function mkEntity(businessId, suffix, { pan, tan }) {
  const entity = await prisma.entity.create({
    data: {
      businessId, code: `${PREFIX}-${suffix}`, legalName: `Fix ${suffix} India Pvt Ltd`, countryCode: 'IN',
      payCurrency: 'INR', timezone: 'Asia/Kolkata', taxYearStartMonth: 4, status: 'ACTIVE', activeFrom: new Date('2020-01-01'),
      pan, tan, addressLine1: '1 MG Road', city: 'Bengaluru', stateCode: 'KA', postalCode: '560001',
    },
  });
  const cal = await prisma.payCalendar.create({
    data: { businessId, entityId: entity.id, code: `${PREFIX}-CAL-${suffix}`, name: 'Monthly', frequency: 'MONTHLY', payDayRule: 'LAST_WORKING_DAY', cutoffDayRule: 'LAST_WORKING_DAY', isActive: true },
  });
  return { entity, cal };
}

// Create an employee + 12 monthly published payslips with the given per-month TDS/PT.
async function mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, code, { pan, tdsPerMonth, ptPerMonth = 200 }) {
  const emp = await prisma.employee.create({
    data: {
      businessId, code, firstName: code, lastName: 'Test', countryCode: 'IN', isActive: true, status: 'ACTIVE',
      hireDate: new Date(`${startYear}-04-01`), addressLine1: '22 Park St', city: 'Bengaluru', stateCode: 'KA', postalCode: '560001',
    },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', effectiveFrom: new Date(`${startYear}-04-01`), changeReason: 'HIRE', isCurrent: true, fteRatio: 1 },
  });
  await prisma.statutoryProfile.create({ data: { businessId, employeeId: emp.id, countryCode: 'IN', pan, taxRegime: 'NEW' } });
  for (let m = 0; m < 12; m += 1) {
    const monthIdx = (3 + m) % 12;
    const y = monthIdx >= 3 ? startYear : startYear + 1;
    const periodStart = new Date(Date.UTC(y, monthIdx, 1));
    const periodEnd = new Date(Date.UTC(y, monthIdx + 1, 0));
    const run = await prisma.payRun.create({
      data: { businessId, entityId: entity.id, payCalendarId: cal.id, code: `${PREFIX}-RUN-${code}-${m}`, periodStart, periodEnd, payDate: periodEnd, sequenceInYear: m + 1, taxYear, currencyCode: 'INR', status: 'PAID' },
    });
    const totalDed = tdsPerMonth + ptPerMonth;
    const line = await prisma.payRunLine.create({
      data: { businessId, payRunId: run.id, employeeId: emp.id, compensationId: '', payableDays: 30, grossEarnings: 87500, totalDeductions: totalDed, netPay: 87500 - totalDed, tds: tdsPerMonth, currencyCode: 'INR' },
    });
    const ded = [{ code: 'PT', label: 'Professional Tax', amount: `${ptPerMonth}.00`, statutory: true }];
    if (tdsPerMonth > 0) ded.unshift({ code: 'TDS', label: 'Income Tax (TDS)', amount: `${tdsPerMonth}.00`, statutory: true });
    await prisma.payslip.create({
      data: {
        businessId, payRunId: run.id, payRunLineId: line.id, employeeId: emp.id, code: `${PREFIX}-PS-${code}-${m}`,
        periodStart, periodEnd, payDate: periodEnd, currencyCode: 'INR', grossEarnings: 87500, totalDeductions: totalDed, netPay: 87500 - totalDed,
        status: 'PUBLISHED', publishedAt: new Date(),
        snapshotJson: {
          currencyCode: 'INR',
          earnings: [{ code: 'BASIC', label: 'Basic', amount: '50000.00' }, { code: 'HRA', label: 'HRA', amount: '20000.00' }, { code: 'SPECIAL', label: 'Special', amount: '17500.00' }],
          employeeDeductions: ded,
        },
      },
    });
  }
  return emp;
}

async function mkChallan(businessId, entity, taxPeriod, amount, q) {
  await prisma.statutoryRemittance.create({
    data: { businessId, entityId: entity.id, kind: 'IN_TDS', taxPeriod, amount, currencyCode: 'INR', dueDate: new Date(`${taxPeriod}-07`), paidDate: new Date(`${taxPeriod}-05`), challanRef: `051030${q}${taxPeriod.slice(-2)}`, status: 'PAID' },
  }).catch(() => {});
}

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) { console.log('SKIP — no demo tenant in hr_test (run prisma/seed-hr.js first)'); return; }
  const businessId = demo.id;
  await cleanup(businessId);

  const taxYear = require('../../../payroll/service')._internal.taxYearFor(new Date().toISOString().slice(0, 10), 4);
  const startYear = Number(taxYear.slice(0, 4));
  const qPeriods = {
    Q1: [`${startYear}-04`, `${startYear}-05`, `${startYear}-06`],
    Q2: [`${startYear}-07`, `${startYear}-08`, `${startYear}-09`],
    Q3: [`${startYear}-10`, `${startYear}-11`, `${startYear}-12`],
    Q4: [`${startYear + 1}-01`, `${startYear + 1}-02`, `${startYear + 1}-03`],
  };

  // ════════════════════════════════════════════════════════════════════════════
  // FINDING 1 — Part A per-employee challan + entity-level §201 gap.
  //   3 employees, each deducts ₹2,000/mo (₹24,000/yr each, ₹72,000 entity total).
  //   Entity deposits only ₹16,000 (one ₹4,000 challan/quarter ×4 = a real ₹56,000
  //   short-deposit), yet every quarter HAS a challan row — so only an entity-level
  //   Σdeducted-vs-Σdeposited comparison can catch the §201 gap.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const { entity, cal } = await mkEntity(businessId, 'E1', { pan: 'AAACA1111A', tan: 'BLRX11111A' });
    const empA = await mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, `${PREFIX}-A`, { pan: 'AAAAA1111A', tdsPerMonth: 2000 });
    await mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, `${PREFIX}-B`, { pan: 'BBBBB1111B', tdsPerMonth: 2000 });
    await mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, `${PREFIX}-C`, { pan: 'CCCCC1111C', tdsPerMonth: 2000 });
    // Entity deposits only ₹4,000 in EACH quarter (the entity deducted ₹18,000/qtr
    // across 3 employees → a real short-deposit, but every quarter HAS a challan row).
    for (const [q, periods] of Object.entries(qPeriods)) {
      await mkChallan(businessId, entity, periods[0], 4000, q); // one ₹4,000 challan / qtr
    }
    const batch = await svc.createForm16Batch({ businessId, actorId: MAKER, entityId: entity.id, financialYear: taxYear });
    await svc.computeForm16Batch({ businessId, actorId: MAKER, batchId: batch.id });
    const after = await svc.getForm16Batch({ businessId, batchId: batch.id });

    ok(after.batch.headcount === 3, `F1: 3 certs minted (got ${after.batch.headcount})`);
    // No cert leaks the entity pool: each cert's deposited ≤ its own deducted (₹24,000).
    const leak = after.certificates.find((c) => c.tdsDepositedMinor > c.tdsDeductedMinor);
    ok(!leak, 'F1: no cert shows deposited > its own deducted (no entity-pool leak)');
    after.certificates.forEach((c) => {
      ok(c.tdsDeductedMinor === 24000 * 100, `F1: cert ${c.employeeCode} deducted = ₹24,000`);
      // A covering challan exists in every quarter → per-employee deposited = own deducted.
      ok(c.tdsDepositedMinor === 24000 * 100, `F1: cert ${c.employeeCode} deposited = own ₹24,000 (not the pool)`);
    });
    // No cert carries the entity-wide pool (₹16,000 deposited or ₹72,000 deducted).
    const poolLeak = after.certificates.find((c) => c.tdsDepositedMinor === 16000 * 100 || c.tdsDepositedMinor === 72000 * 100);
    ok(!poolLeak, 'F1: no cert carries the entity-wide deposited pool (16k/72k)');
    // Part A JSON challan rows do NOT surface a per-employee deposited amount field.
    const certA = after.certificates.find((c) => c.employeeCode === empA.code);
    const someChallan = (certA.partA.quarters || []).flatMap((q) => q.challans || [])[0];
    ok(someChallan && !('amountMinor' in someChallan), 'F1: challan detail no longer carries a per-employee amountMinor (entityDepositedMinor only)');
    // Entity-level §201: pool ₹48,000 < deducted ₹72,000 → batch NOT reconciled.
    ok(after.batch.reconciledOk === false, 'F1: entity short-deposit → batch reconciledOk = false (§201 gap)');
    ok(Number(after.totals.totalTdsDeductedMinor) === 72000 * 100, `F1: batch Σdeducted = ₹72,000 (3×24k, not quadratic) got ₹${Number(after.totals.totalTdsDeductedMinor) / 100}`);
    ok(Number(after.totals.totalTdsDepositedMinor) === 16000 * 100, `F1: batch Σdeposited = entity pool ₹16,000 (not headcount×pool) got ₹${Number(after.totals.totalTdsDepositedMinor) / 100}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FINDING 2 — Part B foots to F15 to the paise; PT disclosed, not netted.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const { entity, cal } = await mkEntity(businessId, 'E2', { pan: 'AAACA2222A', tan: 'BLRX22222A' });
    const emp = await mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, `${PREFIX}-D`, { pan: 'DDDDD2222D', tdsPerMonth: 2000, ptPerMonth: 200 });
    for (const [q, periods] of Object.entries(qPeriods)) for (const p of periods) await mkChallan(businessId, entity, p, 2000, q);
    const batch = await svc.createForm16Batch({ businessId, actorId: MAKER, entityId: entity.id, financialYear: taxYear });
    await svc.computeForm16Batch({ businessId, actorId: MAKER, batchId: batch.id });
    const after = await svc.getForm16Batch({ businessId, batchId: batch.id });
    const B = after.certificates[0].partB;

    const f15 = await buildTaxProjection({ businessId, employeeId: emp.id, asOf: `${startYear + 1}-03-31` });
    const f15TaxableExactMinor = Math.round(f15.totalTaxableIncome * 100);

    // PT is disclosed as a §16(iii) memo (₹2,400) but NOT netted into the chain.
    ok(B.professionalTax_section16iii === 2400 * 100, `F2: PT disclosed as §16(iii) memo = ₹2,400 (got ₹${B.professionalTax_section16iii / 100})`);
    // incomeUnderHeadSalaries = net − standard deduction ONLY (PT not subtracted).
    ok(B.incomeUnderHeadSalaries === Math.max(0, B.netSalary - B.standardDeduction_section16ia),
      'F2: income under Salaries = net − §16(ia) only (PT not netted)');
    // THE footing: gross-total − ChVI-A == F15 exact taxable income, to the paise.
    const chainMinor = Math.max(0, B.incomeUnderHeadSalaries - (B.chapterVIA.totalDeductible || 0)) + (B.previousEmployerIncome || 0);
    ok(chainMinor === f15TaxableExactMinor, `F2: displayed chain foots to F15 taxable income to the paise (${chainMinor} vs ${f15TaxableExactMinor})`);
    ok(Math.abs(B.grossTotalIncome - (B.chapterVIA.totalDeductible || 0) - f15TaxableExactMinor) <= 100,
      'F2: grossTotalIncome − ChVI-A reconciles to certified F15 income (≤ ₹1)');
    // Certified totalIncome is the §288A-rounded presentation of the same figure.
    ok(Math.abs(B.totalIncome - f15TaxableExactMinor) <= 1000, 'F2: certified totalIncome = §288A-rounded F15 income (≤ ₹10)');
    // The certified tax is still F15's, to the paise (zero new tax math).
    ok(B.netTaxPayable === Math.round(f15.totalTax * 100), 'F2: netTaxPayable === F15 totalTax to the paise');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FINDING 3 — 24Q Annexure-II includes a NIL-TDS employee even when a TDS cert
  //   already exists for the batch.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const { entity, cal } = await mkEntity(businessId, 'E3', { pan: 'AAACA3333A', tan: 'BLRX33333A' });
    const tdsEmp = await mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, `${PREFIX}-TDS`, { pan: 'EEEEE3333E', tdsPerMonth: 2000 });
    const nilEmp = await mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, `${PREFIX}-NIL`, { pan: 'FFFFF3333F', tdsPerMonth: 0 });
    for (const [q, periods] of Object.entries(qPeriods)) for (const p of periods) await mkChallan(businessId, entity, p, 2000, q);
    // Compute the batch with the DEFAULT (no issueZeroTds) → only the TDS employee
    // gets a certificate; the nil-TDS employee gets NONE.
    const batch = await svc.createForm16Batch({ businessId, actorId: MAKER, entityId: entity.id, financialYear: taxYear });
    await svc.computeForm16Batch({ businessId, actorId: MAKER, batchId: batch.id });
    const after = await svc.getForm16Batch({ businessId, batchId: batch.id });
    ok(after.batch.headcount === 1, `F3: only the TDS employee got a cert (headcount ${after.batch.headcount})`);

    // Annexure-II (Q4) must still list BOTH the TDS and the nil-TDS employee.
    const q4 = await form24q.export24Q({ businessId, actorId: CHECKER, entityId: entity.id, financialYear: taxYear, quarter: 'Q4' });
    const anx = q4.meta.annexureII || [];
    ok(anx.some((r) => r.code === tdsEmp.code), 'F3: Annexure-II contains the TDS employee (from the cert)');
    ok(anx.some((r) => r.code === nilEmp.code), 'F3: Annexure-II contains the NIL-TDS employee (fallback, despite a cert existing)');
    const nilRow = anx.find((r) => r.code === nilEmp.code);
    ok(nilRow && Number(nilRow.totalTdsDeducted) === 0, 'F3: nil-TDS Annexure-II row reports ₹0 TDS');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FINDING 4 — regenerate SUPERSEDES (immutable old row) rather than mutating it.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const { entity, cal } = await mkEntity(businessId, 'E4', { pan: 'AAACA4444A', tan: 'BLRX44444A' });
    const emp = await mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, `${PREFIX}-RG`, { pan: 'GGGGG4444G', tdsPerMonth: 2000 });
    for (const [q, periods] of Object.entries(qPeriods)) for (const p of periods) await mkChallan(businessId, entity, p, 2000, q);
    const batch = await svc.createForm16Batch({ businessId, actorId: MAKER, entityId: entity.id, financialYear: taxYear });
    await svc.computeForm16Batch({ businessId, actorId: MAKER, batchId: batch.id });
    await svc.approveForm16Batch({ businessId, actorId: CHECKER, batchId: batch.id });
    await svc.issueForm16Batch({ businessId, actorId: CHECKER, batchId: batch.id });

    const oldCert = await prisma.form16Certificate.findFirst({ where: { businessId, batchId: batch.id, employeeId: emp.id } });
    const oldId = oldCert.id;
    const oldCertNo = oldCert.certificateNo;
    const oldPartB = JSON.stringify(oldCert.partBJson);
    ok(oldCert.status === 'ISSUED', 'F4: pre-regen cert is ISSUED');

    const fresh = await svc.regenerateForm16Certificate({ businessId, actorId: CHECKER, batchId: batch.id, employeeId: emp.id, reason: 'correction' });

    // OLD row is immutable + SUPERSEDED + back-linked. partBJson is BYTE-identical.
    const oldAfter = await prisma.form16Certificate.findUnique({ where: { id: oldId } });
    ok(oldAfter.status === 'SUPERSEDED', `F4: old cert is SUPERSEDED (got ${oldAfter.status})`);
    ok(oldAfter.certificateNo === oldCertNo, 'F4: old cert number unchanged (not re-minted in place)');
    ok(JSON.stringify(oldAfter.partBJson) === oldPartB, 'F4: old cert partBJson is byte-identical (NOT mutated)');
    ok(oldAfter.supersededByCertId === fresh.id, 'F4: old cert back-links supersededByCertId → new cert');

    // NEW row is a distinct PENDING cert with a fresh number, linked to its source.
    ok(fresh.id !== oldId, 'F4: regenerate created a NEW cert row (different id)');
    const newAfter = await prisma.form16Certificate.findUnique({ where: { id: fresh.id } });
    ok(newAfter.status === 'PENDING', `F4: new cert is PENDING, ready for re-issue (got ${newAfter.status})`);
    ok(newAfter.certificateNo !== oldCertNo, 'F4: new cert has a fresh (burned) number');
    ok(newAfter.supersedesCertId === oldId, 'F4: new cert links supersedesCertId → old cert');

    // The active-cert partial unique allows the SUPERSEDED + PENDING pair to coexist.
    const all = await prisma.form16Certificate.findMany({ where: { businessId, batchId: batch.id, employeeId: emp.id } });
    ok(all.length === 2, `F4: both the superseded + replacement rows coexist (got ${all.length})`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FINDING 5 — issue does NOT flip the batch to ISSUED when 0 certs issued.
  //   We force the letters engine to throw for EVERY cert (storage/e-sign down).
  // ════════════════════════════════════════════════════════════════════════════
  {
    const { entity, cal } = await mkEntity(businessId, 'E5', { pan: 'AAACA5555A', tan: 'BLRX55555A' });
    const emp = await mkEmployeeWithPayslips(businessId, entity, cal, startYear, taxYear, `${PREFIX}-FAIL`, { pan: 'HHHHH5555H', tdsPerMonth: 2000 });
    for (const [q, periods] of Object.entries(qPeriods)) for (const p of periods) await mkChallan(businessId, entity, p, 2000, q);
    const batch = await svc.createForm16Batch({ businessId, actorId: MAKER, entityId: entity.id, financialYear: taxYear });
    await svc.computeForm16Batch({ businessId, actorId: MAKER, batchId: batch.id });
    await svc.approveForm16Batch({ businessId, actorId: CHECKER, batchId: batch.id });

    const orig = letters.issueRenderedDocument;
    letters.issueRenderedDocument = async () => { throw new Error('simulated storage/e-sign outage'); };
    let out;
    try {
      out = await svc.issueForm16Batch({ businessId, actorId: CHECKER, batchId: batch.id });
    } finally {
      letters.issueRenderedDocument = orig;
    }
    ok(out.issued === 0 && out.failed === 1, `F5: every cert failed (issued ${out.issued}, failed ${out.failed})`);
    const batchAfter = await svc.getForm16Batch({ businessId, batchId: batch.id });
    ok(batchAfter.batch.status === 'APPROVED', `F5: batch stays APPROVED (not ISSUED) on a 0-issued run (got ${batchAfter.batch.status})`);
    ok(!batchAfter.batch.issuedAt, 'F5: batch issuedAt not stamped on a 0-issued run');
    ok(out.batchStatus === 'APPROVED', 'F5: issue response reports batchStatus APPROVED');

    // A subsequent successful issue (engine restored) DOES flip it to ISSUED.
    const out2 = await svc.issueForm16Batch({ businessId, actorId: CHECKER, batchId: batch.id });
    ok(out2.issued === 1, 'F5: re-driven issue succeeds once the engine recovers');
    const batchFinal = await svc.getForm16Batch({ businessId, batchId: batch.id });
    ok(batchFinal.batch.status === 'ISSUED', 'F5: batch flips to ISSUED only after a cert actually issued');
    // keep emp referenced for lint
    void emp;
  }

  await cleanup(businessId);

  console.log('');
  console.log(`Feature 24 Form-16 fixes (cycle 3) live test: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

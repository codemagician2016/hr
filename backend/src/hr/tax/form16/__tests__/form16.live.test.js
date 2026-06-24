'use strict';

/*
 * form16.live.test.js — Feature 24 LIVE (hr_test) proof of the Form-16 / 24Q
 * orchestrator + assembler against a real DB.
 *
 * Plain-node test (built-in assert, real prisma against hr_test):
 *   DATABASE_URL="$HR_URL" node src/hr/tax/form16/__tests__/form16.live.test.js
 * where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'.
 *
 * Proves:
 *   - Part B reconciles to the F15 projection at FY-end (netTaxPayable === F15 totalTax,
 *     to the paise) — zero new tax math;
 *   - Part A quarter-wise TDS sums to the FY total TDS on the published payslips;
 *   - the maker-checker SoD blocks a self-approve (maker === checker → 403);
 *   - a COMPUTED batch freezes partAJson/partBJson immutably (recompute rewrites only
 *     not-yet-issued certs; an APPROVED batch is immutable);
 *   - bulk-issue lands a per-employee EMPLOYEE_VISIBLE EmployeeDocument (the ESS vault);
 *   - 24Q Q4 Annexure-II is sourced from the SAME Part B (totals agree);
 *   - the non-reconciled batch blocks issue unless force-acknowledged.
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const svc = require('../form16.service');
const form24q = require('../form24q.service');
const assembler = require('../form16Assembler');
const { buildTaxProjection } = require('../../projectionAssembler');

const PREFIX = 'F24FORM16';
const EMAIL = `${PREFIX.toLowerCase()}.in@test.local`;

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; } else { failed += 1; console.error(`FAIL  ${label}`); }
}

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  // batches/certs first (cert → employee Restrict).
  const batches = await prisma.form16Batch.findMany({ where: { businessId, financialYear: { startsWith: '2026' }, entity: { code: { startsWith: PREFIX } } }, select: { id: true } }).catch(() => []);
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

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) { console.log('SKIP — no demo tenant in hr_test (run prisma/seed-hr.js first)'); return; }
  const businessId = demo.id;

  await cleanup(businessId);

  // Dedicated India entity for an isolated batch (PAN/TAN deductor identity).
  const entity = await prisma.entity.create({
    data: {
      businessId, code: `${PREFIX}-ENT`, legalName: 'Form16 Test India Pvt Ltd', countryCode: 'IN',
      payCurrency: 'INR', timezone: 'Asia/Kolkata', taxYearStartMonth: 4, status: 'ACTIVE', activeFrom: new Date('2020-01-01'),
      pan: 'AAACA1234A', tan: 'BLRX12345A', addressLine1: '1 MG Road', city: 'Bengaluru', stateCode: 'KA', postalCode: '560001',
    },
  });
  const cal = await prisma.payCalendar.create({
    data: { businessId, entityId: entity.id, code: `${PREFIX}-CAL`, name: 'Monthly', frequency: 'MONTHLY', payDayRule: 'LAST_WORKING_DAY', cutoffDayRule: 'LAST_WORKING_DAY', isActive: true },
  });

  // FY = the current FY (so the F15 projection's FY window matches the seeded payslips).
  const taxYear = require('../../../payroll/service')._internal.taxYearFor(new Date().toISOString().slice(0, 10), 4);
  const startYear = Number(taxYear.slice(0, 4));

  // ── employee + comp (Basic 50k/mo, HRA 20k/mo, Special 17.5k/mo → 1,050,000/yr) ──
  const emp = await prisma.employee.create({
    data: {
      businessId, code: `${PREFIX}-A`, firstName: 'Asha', lastName: 'Rao', workEmail: EMAIL,
      countryCode: 'IN', isActive: true, status: 'ACTIVE', hireDate: new Date(`${startYear}-04-01`),
      addressLine1: '22 Park St', city: 'Bengaluru', stateCode: 'KA', postalCode: '560001',
    },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', effectiveFrom: new Date(`${startYear}-04-01`), changeReason: 'HIRE', isCurrent: true, fteRatio: 1 },
  });
  const cBasic = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_BASIC`, name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: true } });
  const cHra = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_HRA`, name: 'HRA', kind: 'HRA', category: 'EARNING', calcMethod: 'PERCENT_OF', taxSection: '10(13A)' } });
  const cSpecial = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_SPECIAL`, name: 'Special', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING' } });
  const rev = await prisma.compensationRevision.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, currencyCode: 'INR', basis: 'CTC', ctcAnnual: 1050000, grossMonthly: 87500, effectiveFrom: new Date(`${startYear}-04-01`), isCurrent: true, revisionReason: 'HIRE', status: 'EFFECTIVE' },
  });
  await prisma.salaryComponentLine.createMany({
    data: [
      { businessId, compensationId: rev.id, componentId: cBasic.id, calcMethod: 'FLAT', amountMonthly: 50000, amountAnnual: 600000, sortOrder: 1 },
      { businessId, compensationId: rev.id, componentId: cHra.id, calcMethod: 'PERCENT_OF', amountMonthly: 20000, amountAnnual: 240000, sortOrder: 2 },
      { businessId, compensationId: rev.id, componentId: cSpecial.id, calcMethod: 'BALANCING', amountMonthly: 17500, amountAnnual: 210000, sortOrder: 3 },
    ],
  });
  await prisma.employee.update({ where: { id: emp.id }, data: { currentCompensationId: rev.id } });
  await prisma.statutoryProfile.create({
    data: { businessId, employeeId: emp.id, countryCode: 'IN', pan: 'ABCDE1234F', taxRegime: 'OLD', section80CDeclared: 180000, sec80DDeclared: 28000, sec80CCD1BDeclared: 50000, hraAnnualRentPaid: 300000, hraMetroCity: true, hraExemptionClaimed: true },
  });

  // ── 12 published payslips across the FY (₹2,000 TDS + ₹200 PT each) → 24,000 TDS ──
  const TDS_PER = 2000;
  for (let m = 0; m < 12; m += 1) {
    const monthIdx = (3 + m) % 12; // Apr=3 .. Mar=2
    const y = monthIdx >= 3 ? startYear : startYear + 1;
    const periodStart = new Date(Date.UTC(y, monthIdx, 1));
    const periodEnd = new Date(Date.UTC(y, monthIdx + 1, 0));
    const run = await prisma.payRun.create({
      data: { businessId, entityId: entity.id, payCalendarId: cal.id, code: `${PREFIX}-RUN-${m}`, periodStart, periodEnd, payDate: periodEnd, sequenceInYear: m + 1, taxYear, currencyCode: 'INR', status: 'PAID' },
    });
    const line = await prisma.payRunLine.create({
      data: { businessId, payRunId: run.id, employeeId: emp.id, compensationId: rev.id, payableDays: 30, grossEarnings: 87500, totalDeductions: TDS_PER + 200, netPay: 87500 - TDS_PER - 200, tds: TDS_PER, currencyCode: 'INR' },
    });
    await prisma.payslip.create({
      data: {
        businessId, payRunId: run.id, payRunLineId: line.id, employeeId: emp.id, code: `${PREFIX}-PS-${m}`,
        periodStart, periodEnd, payDate: periodEnd, currencyCode: 'INR', grossEarnings: 87500, totalDeductions: TDS_PER + 200, netPay: 87500 - TDS_PER - 200,
        status: 'PUBLISHED', publishedAt: new Date(),
        snapshotJson: {
          currencyCode: 'INR',
          earnings: [{ code: 'BASIC', label: 'Basic', amount: '50000.00' }, { code: 'HRA', label: 'HRA', amount: '20000.00' }, { code: 'SPECIAL', label: 'Special', amount: '17500.00' }],
          employeeDeductions: [{ code: 'TDS', label: 'Income Tax (TDS)', amount: `${TDS_PER}.00`, statutory: true }, { code: 'PT', label: 'Professional Tax', amount: '200.00', statutory: true }],
        },
      },
    });
  }
  const totalTds = TDS_PER * 12; // 24,000

  // ── challan rows (IN_TDS) for each quarter so Part A reconciles ──
  const quarterPeriods = { Q1: [`${startYear}-04`, `${startYear}-05`, `${startYear}-06`], Q2: [`${startYear}-07`, `${startYear}-08`, `${startYear}-09`], Q3: [`${startYear}-10`, `${startYear}-11`, `${startYear}-12`], Q4: [`${startYear + 1}-01`, `${startYear + 1}-02`, `${startYear + 1}-03`] };
  for (const [q, periods] of Object.entries(quarterPeriods)) {
    for (const p of periods) {
      await prisma.statutoryRemittance.create({
        data: { businessId, entityId: entity.id, kind: 'IN_TDS', taxPeriod: p, amount: TDS_PER, currencyCode: 'INR', dueDate: new Date(`${p}-07`), paidDate: new Date(`${p}-05`), challanRef: `051030${q}${p.slice(-2)}`, status: 'PAID' },
      }).catch(() => {});
    }
  }

  const MAKER = 'maker-user-1';
  const CHECKER = 'checker-user-2';

  // ── 1) create batch ──
  const created = await svc.createForm16Batch({ businessId, actorId: MAKER, entityId: entity.id, financialYear: taxYear });
  ok(created.status === 'DRAFT', '1) batch created DRAFT');
  ok(created.deductorTan === 'BLRX12345A' && created.deductorPan === 'AAACA1234A', '1) deductor PAN/TAN snapshotted');
  const batchId = created.id;

  // ── 2) duplicate create → 409 ──
  let dupErr = null;
  try { await svc.createForm16Batch({ businessId, actorId: MAKER, entityId: entity.id, financialYear: taxYear }); }
  catch (e) { dupErr = e; }
  ok(dupErr && dupErr.code === 'BATCH_EXISTS' && dupErr.status === 409, '2) duplicate batch → 409 BATCH_EXISTS');

  // ── 3) compute ──
  await svc.computeForm16Batch({ businessId, actorId: MAKER, batchId });
  const afterCompute = await svc.getForm16Batch({ businessId, batchId });
  ok(afterCompute.batch.status === 'COMPUTED', '3) batch COMPUTED');
  ok(afterCompute.batch.headcount === 1, `3) headcount = 1 (got ${afterCompute.batch.headcount})`);
  const cert = afterCompute.certificates[0];
  ok(!!cert, '3) a certificate row was minted');
  ok(/^FORM16\/BLRX12345A\//.test(cert.certificateNo), `3) certificate number is TAN-derived (got ${cert.certificateNo})`);

  // ── 4) Part B reconciles to F15 to the paise ──
  const fyEndIso = `${startYear + 1}-03-31`;
  const f15 = await buildTaxProjection({ businessId, employeeId: emp.id, asOf: fyEndIso });
  const partB = cert.partB;
  const f15TotalTaxMinor = Math.round(f15.totalTax * 100);
  ok(partB.netTaxPayable === f15TotalTaxMinor, `4) Part B netTaxPayable === F15 totalTax to the paise (${partB.netTaxPayable} vs ${f15TotalTaxMinor})`);
  ok(partB.grossSalary.section17_1 === Math.round(f15.annualEarnings.grossSalary * 100), '4) §17(1) === F15 grossSalary');
  ok(partB.regime === 'OLD', '4) regime OLD');
  ok(partB.standardDeduction_section16ia === Math.round(f15.standardDeduction * 100), '4) §16(ia) std deduction === F15');
  ok(partB.professionalTax_section16iii === 240000, `4) §16(iii) PT = ₹2,400 from payslips (got ${partB.professionalTax_section16iii})`);

  // ── 5) Part A quarter sums === FY total TDS on payslips ──
  const partA = cert.partA;
  const partAsum = partA.quarters.reduce((s, q) => s + q.tdsDeductedMinor, 0);
  ok(partAsum === totalTds * 100, `5) Part A quarter sum === Σ payslip TDS (${partAsum} vs ${totalTds * 100})`);
  ok(partA.quarters.every((q) => q.tdsDeductedMinor === 6000 * 100), '5) each quarter deducted ₹6,000 (3×₹2,000)');
  ok(partA.totalTdsDepositedMinor === totalTds * 100, '5) Part A deposited === deducted (challans matched)');
  ok(partA.reconciledOk === true, '5) Part A reconciledOk = true');
  ok(cert.tdsDepositedMinor === totalTds * 100, '5) cert tdsDeposited roll-up correct');

  // ── 6) maker-checker SoD blocks a self-approve ──
  let sodErr = null;
  try { await svc.approveForm16Batch({ businessId, actorId: MAKER, batchId }); }
  catch (e) { sodErr = e; }
  ok(sodErr && sodErr.code === 'MAKER_CHECKER' && sodErr.status === 403, '6) self-approve blocked (maker === checker → 403)');

  // ── 7) checker approves ──
  const approved = await svc.approveForm16Batch({ businessId, actorId: CHECKER, batchId });
  ok(approved.batch.status === 'APPROVED', '7) checker approves → APPROVED');

  // ── 8) freeze immutability: an APPROVED batch refuses recompute ──
  let immErr = null;
  try { await svc.computeForm16Batch({ businessId, actorId: MAKER, batchId }); }
  catch (e) { immErr = e; }
  ok(immErr && immErr.code === 'IMMUTABLE_BATCH', '8) APPROVED batch refuses recompute (frozen)');

  // ── 9) bulk-issue lands a per-employee EMPLOYEE_VISIBLE ESS doc ──
  const issueOut = await svc.issueForm16Batch({ businessId, actorId: CHECKER, batchId });
  ok(issueOut.issued === 1 && issueOut.failed === 0, `9) bulk-issue: 1 issued, 0 failed (got ${issueOut.issued}/${issueOut.failed})`);
  const certAfterIssue = await prisma.form16Certificate.findFirst({ where: { businessId, batchId, employeeId: emp.id } });
  ok(certAfterIssue.status === 'ISSUED' && !!certAfterIssue.issuedLetterId && !!certAfterIssue.employeeDocumentId, '9) cert ISSUED + linked to IssuedLetter + EmployeeDocument');
  ok(!!certAfterIssue.fileHash, '9) cert carries the issued PDF sha256');
  const essDoc = await prisma.employeeDocument.findFirst({ where: { id: certAfterIssue.employeeDocumentId } });
  ok(essDoc && essDoc.visibility === 'EMPLOYEE_VISIBLE' && essDoc.category === 'FORM16', '9) ESS vault doc is EMPLOYEE_VISIBLE + category FORM16');
  const issuedLetter = await prisma.issuedLetter.findFirst({ where: { id: certAfterIssue.issuedLetterId } });
  ok(issuedLetter && issuedLetter.status === 'ISSUED' && issuedLetter.fileHash === certAfterIssue.fileHash, '9) IssuedLetter ISSUED, hash matches the cert');

  // ── 10) 24Q Q4 Annexure-II sourced from the SAME Part B ──
  const q4 = await form24q.export24Q({ businessId, actorId: CHECKER, entityId: entity.id, financialYear: taxYear, quarter: 'Q4' });
  ok(Array.isArray(q4.meta.annexureII), '10) Q4 export carries an annexureII array');
  const anx = (q4.meta.annexureII || []).find((r) => r.code === emp.code);
  ok(!!anx, '10) annexure-II row for our employee present');
  ok(anx && Number(anx.totalTaxPayable) === f15.totalTax, `10) annexure-II totalTaxPayable === F15 totalTax (${anx && anx.totalTaxPayable} vs ${f15.totalTax})`);
  ok(anx && Number(anx.totalTdsDeducted) * 100 === partB.tdsDeducted, '10) annexure-II totalTdsDeducted === Part B tdsDeducted');

  // ── 11) cross-check: Σ four quarters' 24Q tdsMinor === batch totalTdsDeducted ──
  let q4sumMinor = 0;
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
    const agg = await form24q.build24QAggregate({ businessId, entityId: entity.id, financialYear: taxYear, quarter: q });
    q4sumMinor += agg.lines.reduce((s, l) => s + l.tdsMinor, 0);
  }
  ok(q4sumMinor === totalTds * 100, `11) Σ four quarters' 24Q TDS === Σ payslip TDS (${q4sumMinor} vs ${totalTds * 100})`);

  // ── 12) the FVU file is well-formed (FH/BH/CD/DD records) ──
  const q1 = await form24q.export24Q({ businessId, actorId: CHECKER, entityId: entity.id, financialYear: taxYear, quarter: 'Q1' });
  ok(q1.content.startsWith('FH^'), '12) 24Q FVU file starts with the FH header record');
  ok(q1.content.includes('BH^BLRX12345A^24Q'), '12) 24Q BH record carries the TAN + form 24Q');
  ok(q1.meta.deducteeCount === 1, '12) 24Q Q1 has 1 deductee line');

  // ── 13) non-reconciled batch blocks issue unless forced ──
  // Mint a SECOND entity+batch with a deducted-but-undeposited quarter.
  const ent2 = await prisma.entity.create({
    data: { businessId, code: `${PREFIX}-ENT2`, legalName: 'Form16 Gap India', countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata', taxYearStartMonth: 4, status: 'ACTIVE', activeFrom: new Date('2020-01-01'), pan: 'AAACA9999A', tan: 'BLRX99999A' },
  });
  const cal2 = await prisma.payCalendar.create({ data: { businessId, entityId: ent2.id, code: `${PREFIX}-CAL2`, name: 'Monthly', frequency: 'MONTHLY', payDayRule: 'LAST_WORKING_DAY', cutoffDayRule: 'LAST_WORKING_DAY', isActive: true } });
  const emp2 = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-B`, firstName: 'Gap', lastName: 'Emp', countryCode: 'IN', isActive: true, status: 'ACTIVE', hireDate: new Date(`${startYear}-04-01`) } });
  await prisma.employmentRecord.create({ data: { businessId, employeeId: emp2.id, entityId: ent2.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', effectiveFrom: new Date(`${startYear}-04-01`), changeReason: 'HIRE', isCurrent: true, fteRatio: 1 } });
  await prisma.statutoryProfile.create({ data: { businessId, employeeId: emp2.id, countryCode: 'IN', pan: 'ZZZZZ9999Z', taxRegime: 'NEW' } });
  const run2 = await prisma.payRun.create({ data: { businessId, entityId: ent2.id, payCalendarId: cal2.id, code: `${PREFIX}-GRUN`, periodStart: new Date(`${startYear}-04-01`), periodEnd: new Date(`${startYear}-04-30`), payDate: new Date(`${startYear}-04-30`), sequenceInYear: 1, taxYear, currencyCode: 'INR', status: 'PAID' } });
  const gline = await prisma.payRunLine.create({ data: { businessId, payRunId: run2.id, employeeId: emp2.id, compensationId: '', payableDays: 30, grossEarnings: 100000, totalDeductions: 5000, netPay: 95000, tds: 5000, currencyCode: 'INR' } });
  await prisma.payslip.create({ data: { businessId, payRunId: run2.id, payRunLineId: gline.id, employeeId: emp2.id, code: `${PREFIX}-GPS`, periodStart: new Date(`${startYear}-04-01`), periodEnd: new Date(`${startYear}-04-30`), payDate: new Date(`${startYear}-04-30`), currencyCode: 'INR', grossEarnings: 100000, totalDeductions: 5000, netPay: 95000, status: 'PUBLISHED', publishedAt: new Date(), snapshotJson: { earnings: [{ code: 'BASIC', amount: '100000.00' }], employeeDeductions: [{ code: 'TDS', amount: '5000.00' }] } } });
  // NO challan row → deducted ₹5,000 but deposited ₹0 → not reconciled.
  const gapBatch = await svc.createForm16Batch({ businessId, actorId: MAKER, entityId: ent2.id, financialYear: taxYear });
  await svc.computeForm16Batch({ businessId, actorId: MAKER, batchId: gapBatch.id });
  const gapAfter = await svc.getForm16Batch({ businessId, batchId: gapBatch.id });
  ok(gapAfter.batch.reconciledOk === false, '13) deducted-but-undeposited batch reconciledOk = false');
  await svc.approveForm16Batch({ businessId, actorId: CHECKER, batchId: gapBatch.id });
  let gapIssueErr = null;
  try { await svc.issueForm16Batch({ businessId, actorId: CHECKER, batchId: gapBatch.id }); }
  catch (e) { gapIssueErr = e; }
  ok(gapIssueErr && gapIssueErr.code === 'NOT_RECONCILED' && gapIssueErr.status === 409, '13) non-reconciled batch blocks issue (§201) until forced');
  const forced = await svc.issueForm16Batch({ businessId, actorId: CHECKER, batchId: gapBatch.id, force: true });
  ok(forced.issued === 1, '13) force-acknowledge issues the non-reconciled batch (audited)');

  await cleanup(businessId);

  console.log('');
  console.log(`Feature 24 Form-16 / 24Q live test: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

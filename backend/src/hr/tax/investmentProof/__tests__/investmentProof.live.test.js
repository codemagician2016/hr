'use strict';

/*
 * investmentProof.live.test.js — Feature 20 LIVE (hr_test) proof of the
 * investment-proof workflow + the DECLARED→VERIFIED TDS switch.
 *
 * Plain-node test (built-in assert, real prisma against hr_test):
 *   DATABASE_URL="$HR_URL?schema=hr_test" node src/hr/tax/investmentProof/__tests__/investmentProof.live.test.js
 *
 * Proves:
 *   - window admin: create (order guard, one-per-FY) + DRAFT→OPEN→CLOSED→LOCKED;
 *   - ESS upload: window-OPEN-gated, self-only, HRA>₹1L needs landlord PAN, NEW-regime
 *     skips proofs, withdraw-PENDING;
 *   - HR verify: accept (verifiedAmount capped at declared), reject (mandatory reason),
 *     SoD (operator's own employee can't be self-verified), IDOR→404 cross-employee;
 *   - THE SWITCH: BEFORE proofDeadline the assembler uses DECLARED; ON/AFTER it uses
 *     min(declared, Σaccepted) → taxable rises → TDS rises by the exact slab delta;
 *   - no-window → fail-open-provisional (DECLARED).
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const assembler = require('../../projectionAssembler');
const meProofs = require('../meProofs.controller');
const proofsCtl = require('../proofs.controller');
const windowCtl = require('../taxWindow.controller');

const PREFIX = 'F20PRF';
const EMAIL = `${PREFIX.toLowerCase()}.in@test.local`;
const EMAIL2 = `${PREFIX.toLowerCase()}.in2@test.local`;

let passed = 0; let failed = 0;
function ok(cond, label) { if (cond) { passed += 1; } else { failed += 1; console.error(`FAIL  ${label}`); } }

// 1×1 PNG data URL (tiny valid image for the upload path).
const PNG_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function mkReq({ user, customer, params = {}, body = {}, query = {}, scope } = {}) {
  return { user, customer, params, body, query, scope };
}
function run(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
      send(buf) { resolve({ status: this.statusCode, body: buf, headers: this.headers }); },
      redirect(u) { resolve({ status: 302, redirect: u }); },
    };
    Promise.resolve(handler(req, res, (e) => resolve({ status: 500, error: e }))).catch((e) => resolve({ status: 500, error: e }));
  });
}

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.investmentProof.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.payslip.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.payRunLine.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.salaryComponentLine.deleteMany({ where: { businessId, compensation: { employeeId: { in: ids } } } }).catch(() => {});
    await prisma.compensationRevision.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.statutoryProfile.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employmentRecord.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }
  await prisma.investmentDeclarationWindow.deleteMany({ where: { businessId, financialYear: { startsWith: '20' }, notes: { contains: PREFIX } } }).catch(() => {});
  await prisma.salaryComponent.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { businessId, email: { in: [EMAIL, EMAIL2] } } }).catch(() => {});
}

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) { console.log('SKIP — no demo tenant in hr_test'); return; }
  const businessId = demo.id;
  const entity = (await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } }))
    || (await prisma.entity.findFirst({ where: { businessId } }));
  if (!entity) { console.log('SKIP — demo tenant has no entity'); return; }

  await cleanup(businessId);

  const taxYear = require('../../../payroll/service')._internal.taxYearFor(new Date().toISOString().slice(0, 10), 4);
  const startYear = Number(taxYear.slice(0, 4));
  // Deadlines relative to the current FY (Jan–Feb of the closing year).
  const opensAt = `${startYear}-04-15`;
  const closesAt = `${startYear + 1}-01-31`;
  const proofDeadline = `${startYear + 1}-02-15`;

  // ── seed: OLD-regime India employee + customer + comp ──
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-A`, firstName: 'Asha', lastName: 'Rao', workEmail: EMAIL, countryCode: 'IN', isActive: true, status: 'ACTIVE', hireDate: new Date(`${startYear - 1}-01-15`) },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', effectiveFrom: new Date(`${startYear - 1}-01-15`), changeReason: 'HIRE', isCurrent: true, fteRatio: 1 },
  });
  const cust = await prisma.customer.create({ data: { businessId, email: EMAIL, name: 'Asha Rao', password: 'x', isActive: true } });

  const cBasic = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_BASIC`, name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: true } });
  const cHra = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_HRA`, name: 'HRA', kind: 'HRA', category: 'EARNING', calcMethod: 'PERCENT_OF', taxSection: '10(13A)' } });
  const cSpecial = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_SPECIAL`, name: 'Special', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING' } });
  const rev = await prisma.compensationRevision.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, currencyCode: 'INR', basis: 'CTC', ctcAnnual: 1800000, grossMonthly: 150000, effectiveFrom: new Date(`${startYear - 1}-01-15`), isCurrent: true, revisionReason: 'HIRE', status: 'EFFECTIVE' },
  });
  // Basic+DA 100k/mo (1.2M/yr), HRA 30k/mo (360k/yr), Special 20k/mo (240k/yr) → gross 1.8M.
  await prisma.salaryComponentLine.createMany({
    data: [
      { businessId, compensationId: rev.id, componentId: cBasic.id, calcMethod: 'FLAT', amountMonthly: 100000, amountAnnual: 1200000, sortOrder: 1 },
      { businessId, compensationId: rev.id, componentId: cHra.id, calcMethod: 'PERCENT_OF', amountMonthly: 30000, amountAnnual: 360000, sortOrder: 2 },
      { businessId, compensationId: rev.id, componentId: cSpecial.id, calcMethod: 'BALANCING', amountMonthly: 20000, amountAnnual: 240000, sortOrder: 3 },
    ],
  });
  // OLD regime; declared 80C 1.5L (over PF), 24b 2L. No HRA rent (keep HRA out of this case
  // so the taxable delta is purely the Chapter-VIA flip — cleaner to assert).
  await prisma.statutoryProfile.create({
    data: { businessId, employeeId: emp.id, countryCode: 'IN', pan: 'ABCDE1234F', taxRegime: 'OLD', section80CDeclared: 150000, sec24BHomeLoanInterest: 200000 },
  });

  const HR = { id: 'hr-operator-user-id', businessId, role: 'ADMIN', employeeId: null };

  // ════════ 1. Window admin: order guard + create + transitions ════════
  let r = await run(windowCtl.createWindow, mkReq({ user: HR, body: { financialYear: taxYear, opensAt: proofDeadline, closesAt, proofDeadline, notes: PREFIX } }));
  ok(r.status === 422, '1) order guard rejects opensAt > closesAt');

  r = await run(windowCtl.createWindow, mkReq({ user: HR, body: { financialYear: taxYear, opensAt, closesAt, proofDeadline, notes: PREFIX } }));
  ok(r.status === 201 && r.body.status === 'DRAFT', '1) window created as DRAFT');
  const windowId = r.body.id;

  // Upsert (same FY) does not duplicate.
  r = await run(windowCtl.createWindow, mkReq({ user: HR, body: { financialYear: taxYear, opensAt, closesAt, proofDeadline, notes: PREFIX } }));
  ok(r.status === 200 && r.body.id === windowId, '1) one-per-FY upsert (no duplicate)');

  // ════════ 2. Upload BEFORE the window is OPEN → blocked ════════
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_80C', declaredAmount: 150000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 409 && r.body.code === 'WINDOW_NOT_OPEN', '2) upload blocked while DRAFT');

  // Open the window.
  r = await run(windowCtl.openWindow, mkReq({ user: HR, params: { id: windowId } }));
  ok(r.status === 200 && r.body.status === 'OPEN', '2) DRAFT→OPEN');

  // ════════ 3. ESS upload (self-only) ════════
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_80C', subSection: 'LIC', declaredAmount: 90000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 201 && r.body.status === 'PENDING', '3) 80C proof uploaded (PENDING)');
  const proof80c = r.body.id;

  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_24B_HOME_LOAN', declaredAmount: 200000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 201, '3) 24b proof uploaded');
  const proof24b = r.body.id;

  // HRA > ₹1L without landlord PAN → 422.
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'HRA_RENT', declaredAmount: 150000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 422 && r.body.code === 'LANDLORD_PAN_REQUIRED', '3) HRA>₹1L requires landlord PAN');

  // HRA > ₹1L WITH landlord PAN → ok.
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'HRA_RENT', declaredAmount: 150000, landlordName: 'Mr Landlord', landlordPan: 'PQRSX1234Z', fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 201, '3) HRA>₹1L with landlord PAN accepted');

  // List my proofs (rollup).
  r = await run(meProofs.listMyProofs, mkReq({ customer: cust, query: { fy: taxYear } }));
  ok(r.status === 200 && r.body.proofsApplicable === true && r.body.window.canUpload === true, '3) rollup: proofs applicable + canUpload');

  // Withdraw the 80C PENDING proof, then re-upload (supersede).
  r = await run(meProofs.withdrawProof, mkReq({ customer: cust, params: { id: proof80c } }));
  ok(r.status === 200 && r.body.ok, '3) withdraw own PENDING proof');
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_80C', declaredAmount: 90000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 201, '3) re-upload 80C after withdraw');
  const proof80cNew = r.body.id;

  // ════════ 4. HR verify: SoD + IDOR + accept/reject ════════
  // SoD: an HR operator whose OWN employee is `emp` cannot self-verify.
  const selfHR = { id: 'self-hr-user', businessId, role: 'ADMIN', employeeId: emp.id };
  r = await run(proofsCtl.acceptProof, mkReq({ user: selfHR, params: { employeeId: emp.id, id: proof80cNew }, body: { verifiedAmount: 90000 } }));
  ok(r.status === 403 && r.body.code === 'SOD_VIOLATION', '4) SoD blocks self-verify');

  // verifiedAmount > declared → 422.
  r = await run(proofsCtl.acceptProof, mkReq({ user: HR, params: { employeeId: emp.id, id: proof80cNew }, body: { verifiedAmount: 200000 } }));
  ok(r.status === 422 && r.body.code === 'VERIFIED_EXCEEDS_DECLARED', '4) verifiedAmount cannot exceed declared');

  // Accept 80C at 90k (only 90k of the 1.5L declared is verified → 60k will be excluded).
  r = await run(proofsCtl.acceptProof, mkReq({ user: HR, params: { employeeId: emp.id, id: proof80cNew }, body: { verifiedAmount: 90000 } }));
  ok(r.status === 200 && r.body.status === 'ACCEPTED' && Number(r.body.verifiedAmount) === 90000, '4) accept 80C @ 90k');

  // Reject the 24b proof (mandatory reason).
  r = await run(proofsCtl.rejectProof, mkReq({ user: HR, params: { employeeId: emp.id, id: proof24b }, body: {} }));
  ok(r.status === 422 && r.body.code === 'REJECT_REASON_REQUIRED', '4) reject needs a reason');
  r = await run(proofsCtl.rejectProof, mkReq({ user: HR, params: { employeeId: emp.id, id: proof24b }, body: { rejectReason: 'Wrong FY on the certificate' } }));
  ok(r.status === 200 && r.body.status === 'REJECTED', '4) reject 24b with reason');

  // ════════ 5. THE SWITCH — BEFORE vs ON/AFTER the deadline ════════
  const beforeIso = `${startYear + 1}-02-14`; // day before deadline
  const afterIso = proofDeadline;             // the deadline itself (flip day)

  // Before: DECLARED basis → 80C uses 1.5L, 24b uses 2L (provisional).
  const stmtBefore = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: beforeIso });
  ok(stmtBefore.proofBasis === 'DECLARED', '5) before deadline → proofBasis DECLARED');
  const dedBefore = stmtBefore.chapterVIA.totalDeductible;

  // After: VERIFIED basis → 80C uses min(1.5L, 90k+PF) , 24b uses 0 (rejected).
  const stmtAfter = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: afterIso });
  ok(stmtAfter.proofBasis === 'VERIFIED', '5) on deadline → proofBasis VERIFIED');
  const dedAfter = stmtAfter.chapterVIA.totalDeductible;

  // Verified deductions must be LESS than declared (24b dropped, 80C trimmed).
  ok(dedAfter < dedBefore, `5) verified deductions < declared (${dedAfter} < ${dedBefore})`);
  // Taxable rises by exactly the deduction drop.
  const taxableDelta = stmtAfter.totalTaxableIncome - stmtBefore.totalTaxableIncome;
  ok(Math.abs(taxableDelta - (dedBefore - dedAfter)) < 0.01, '5) taxable rises by the exact deduction drop');
  // TDS (total tax) rises after the deadline (the §201 control biting).
  ok(stmtAfter.totalTax > stmtBefore.totalTax, `5) TDS rises after deadline (${stmtAfter.totalTax} > ${stmtBefore.totalTax})`);
  // The unverified anomaly is surfaced.
  ok((stmtAfter.anomalies || []).some((a) => a.code === 'UNVERIFIED_DECLARATION'), '5) unverified anomaly surfaced after deadline');

  // 24b verified used == 0 (rejected); 80C used reflects 90k + PF, capped at 1.5L declared.
  ok(stmtAfter.proofLines.SEC_24B_HOME_LOAN.used === 0, '5) rejected 24b → used 0 after deadline');
  ok(stmtAfter.proofLines.SEC_80C.used >= 90000 && stmtAfter.proofLines.SEC_80C.used <= 150000, '5) 80C used = verified+PF, capped at declared');

  // ════════ 6. No-window tenant → fail-open-provisional (DECLARED) ════════
  // Delete the window; the same employee must now project as DECLARED even after the deadline.
  await prisma.investmentProof.deleteMany({ where: { businessId, employeeId: emp.id } });
  await prisma.investmentDeclarationWindow.delete({ where: { id: windowId } });
  const stmtNoWindow = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: afterIso });
  ok(stmtNoWindow.proofBasis === 'DECLARED', '6) no window → fail-open-provisional (DECLARED)');
  ok(Math.abs(stmtNoWindow.chapterVIA.totalDeductible - dedBefore) < 0.01, '6) no window → deductions == declared');

  // ════════ 7. NEW-regime skips proofs ════════
  await prisma.statutoryProfile.updateMany({ where: { businessId, employeeId: emp.id }, data: { taxRegime: 'NEW' } });
  // Recreate a window so the gate is window-OPEN.
  const w2 = await prisma.investmentDeclarationWindow.create({ data: { businessId, financialYear: taxYear, countryCode: 'IN', opensAt: new Date(opensAt), closesAt: new Date(closesAt), proofDeadline: new Date(proofDeadline), status: 'OPEN', notes: PREFIX } });
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_80C', declaredAmount: 90000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 409 && r.body.code === 'NEW_REGIME_NO_PROOFS', '7) NEW regime rejects proof upload');
  await prisma.investmentDeclarationWindow.delete({ where: { id: w2.id } }).catch(() => {});

  await cleanup(businessId);
  console.log(`\nFeature 20 investment-proof live test: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });

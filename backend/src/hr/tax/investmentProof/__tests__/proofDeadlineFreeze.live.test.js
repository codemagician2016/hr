'use strict';

/*
 * proofDeadlineFreeze.live.test.js — Feature 20 §201 DATE-AUTHORITATIVE FREEZE.
 *
 * The review finding (HIGH): upload/accept gated ONLY on window.status==OPEN. If the
 * lifecycle cron misses its tick the window stays OPEN past the proofDeadline, so a
 * post-deadline proof could still be uploaded + accepted and CUT the already-frozen
 * VERIFIED TDS — defeating the §201 control. The fix gates BOTH upload and accept on
 * the actual DATE vs proofDeadline (shouldUseVerified), NOT on the cron-driven status.
 *
 * Plain-node test (built-in assert, real prisma against hr_test):
 *   DATABASE_URL="$HR_URL?schema=hr_test" \
 *     node src/hr/tax/investmentProof/__tests__/proofDeadlineFreeze.live.test.js
 *
 * DETERMINISTIC (clock-independent): the window.proofDeadline is a plain date column, so
 * we pin it relative to the real wall clock — a PAST deadline models "cron missed, window
 * still OPEN, but the date has frozen the math"; a FUTURE deadline models the live window.
 * Every controller-guard assertion fires the same on any run date.
 *
 * Proves (each finding gets an assertion):
 *   FIX 1 (§201 date guard) — window LEFT OPEN with a PAST proofDeadline (cron missed):
 *     • upload AFTER the deadline → 409 PROOF_DEADLINE_PASSED (no new proof enters);
 *     • accept AFTER the deadline → 409 PROOF_DEADLINE_PASSED (frozen TDS not cut);
 *     • the assembler's post-deadline VERIFIED TDS is UNCHANGED by the blocked attempt;
 *     • with a FUTURE deadline (live window) upload + accept STILL work — the freeze is
 *       date-bounded, not a blanket lockout;
 *     • the status flag is advisory: OPEN + past-date → still FROZEN.
 *   FIX 2 (caps + exclusions) — verifiedAmount capped to min(declared, Σaccepted), then
 *     the engine's 80C ₹1.5L statutory cap; a REJECTED proof contributes 0 to the Σ.
 *   FIX 3 (SoD) — an operator cannot verify/reject a proof for their own employee record.
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const assembler = require('../../projectionAssembler');
const meProofs = require('../meProofs.controller');
const proofsCtl = require('../proofs.controller');
const { shouldUseVerified } = require('../proofAggregator');

const PREFIX = 'F20FRZ';
const EMAIL = `${PREFIX.toLowerCase()}.in@test.local`;

let passed = 0; let failed = 0;
function ok(cond, label) { if (cond) { passed += 1; } else { failed += 1; console.error(`FAIL  ${label}`); } }

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

// Pin the window's deadline (and a coherent opens/closes triple) relative to a chosen
// date. `daysFromNow` < 0 → a PAST deadline (frozen); > 0 → a FUTURE deadline (live).
async function setWindowDeadline(winId, daysFromNow) {
  const dl = new Date(Date.now() + daysFromNow * 86400000);
  const opens = new Date(dl.getTime() - 60 * 86400000);  // opensAt 60d before
  const closes = new Date(dl.getTime() - 5 * 86400000);  // closesAt 5d before
  await prisma.investmentDeclarationWindow.update({
    where: { id: winId },
    data: { opensAt: opens, closesAt: closes, proofDeadline: dl, status: 'OPEN' },
  });
  return dl.toISOString().slice(0, 10);
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
  await prisma.customer.deleteMany({ where: { businessId, email: EMAIL } }).catch(() => {});
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

  // ── seed: OLD-regime India employee + customer + comp (1.8M gross) ──
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-A`, firstName: 'Frieda', lastName: 'Zen', workEmail: EMAIL, countryCode: 'IN', isActive: true, status: 'ACTIVE', hireDate: new Date(`${startYear - 1}-01-15`) },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', effectiveFrom: new Date(`${startYear - 1}-01-15`), changeReason: 'HIRE', isCurrent: true, fteRatio: 1 },
  });
  const cust = await prisma.customer.create({ data: { businessId, email: EMAIL, name: 'Frieda Zen', password: 'x', isActive: true } });

  const cBasic = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_BASIC`, name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: true } });
  const cHra = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_HRA`, name: 'HRA', kind: 'HRA', category: 'EARNING', calcMethod: 'PERCENT_OF', taxSection: '10(13A)' } });
  const cSpecial = await prisma.salaryComponent.create({ data: { businessId, code: `${PREFIX}_SPECIAL`, name: 'Special', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING' } });
  const rev = await prisma.compensationRevision.create({
    data: { businessId, employeeId: emp.id, entityId: entity.id, currencyCode: 'INR', basis: 'CTC', ctcAnnual: 1800000, grossMonthly: 150000, effectiveFrom: new Date(`${startYear - 1}-01-15`), isCurrent: true, revisionReason: 'HIRE', status: 'EFFECTIVE' },
  });
  await prisma.salaryComponentLine.createMany({
    data: [
      { businessId, compensationId: rev.id, componentId: cBasic.id, calcMethod: 'FLAT', amountMonthly: 100000, amountAnnual: 1200000, sortOrder: 1 },
      { businessId, compensationId: rev.id, componentId: cHra.id, calcMethod: 'PERCENT_OF', amountMonthly: 30000, amountAnnual: 360000, sortOrder: 2 },
      { businessId, compensationId: rev.id, componentId: cSpecial.id, calcMethod: 'BALANCING', amountMonthly: 20000, amountAnnual: 240000, sortOrder: 3 },
    ],
  });
  // OLD regime; declared 80C 1.5L, 24b 2L. No HRA rent (keeps the delta = the Chapter-VIA flip).
  await prisma.statutoryProfile.create({
    data: { businessId, employeeId: emp.id, countryCode: 'IN', pan: 'ABCDE1234F', taxRegime: 'OLD', section80CDeclared: 150000, sec24BHomeLoanInterest: 200000 },
  });

  const HR = { id: 'hr-operator-frz', businessId, role: 'ADMIN', employeeId: null };

  // The window is created and OPENED — and DELIBERATELY left OPEN throughout (we never
  // close/lock it), simulating a MISSED lifecycle cron tick. The status flag therefore
  // LIES; only the proofDeadline DATE is authoritative.
  const win = await prisma.investmentDeclarationWindow.create({
    data: {
      businessId, financialYear: taxYear, countryCode: 'IN',
      opensAt: new Date(`${startYear}-04-15`), closesAt: new Date(`${startYear + 1}-01-31`), proofDeadline: new Date(`${startYear + 1}-02-15`),
      status: 'OPEN', notes: PREFIX,
    },
  });
  ok(win.status === 'OPEN', 'setup) window is OPEN (and stays OPEN — cron missed)');

  // ════════ FIX 1a — LIVE window (FUTURE deadline): upload + accept WORK ════════
  // Pin the deadline 30 days into the FUTURE → the date guard allows everything.
  const futureDl = await setWindowDeadline(win.id, +30);
  ok(shouldUseVerified({ proofDeadline: futureDl }, new Date().toISOString().slice(0, 10)) === false, 'FIX1) future deadline → not frozen (uploads allowed)');

  let r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_80C', subSection: 'LIC', declaredAmount: 90000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 201 && r.body.status === 'PENDING', 'FIX1) pre-deadline upload WORKS (201 PENDING)');
  const proof80c = r.body.id;

  r = await run(proofsCtl.acceptProof, mkReq({ user: HR, params: { employeeId: emp.id, id: proof80c }, body: { verifiedAmount: 90000 } }));
  ok(r.status === 200 && r.body.status === 'ACCEPTED' && Number(r.body.verifiedAmount) === 90000, 'FIX1) pre-deadline accept WORKS (90k)');

  // Snapshot the FROZEN figure the §201 control will protect: read the assembler AS-OF a
  // date on/after the (now future) deadline so it uses VERIFIED. 80C verified = 90k+PF.
  const frozen = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: futureDl });
  ok(frozen.proofBasis === 'VERIFIED', 'FIX1) assembler at/after deadline → basis VERIFIED');
  const frozenTax = frozen.totalTax;
  const frozen24bUsed = frozen.proofLines.SEC_24B_HOME_LOAN.used;
  ok(frozen24bUsed === 0, 'FIX1) baseline: 24b not yet proven → 0 used in the frozen figure');

  // ════════ FIX 1b — FROZEN window (PAST deadline, still OPEN): upload BLOCKED ════════
  // Pin the deadline 20 days into the PAST → cron-missed but the date froze the math.
  const pastDl = await setWindowDeadline(win.id, -20);
  const live = await prisma.investmentDeclarationWindow.findUnique({ where: { id: win.id } });
  ok(live.status === 'OPEN', 'FIX1) window STILL flagged OPEN past the deadline (cron missed)');
  ok(shouldUseVerified(live, new Date().toISOString().slice(0, 10)) === true, 'FIX1) date primitive: past deadline → FROZEN despite OPEN status');

  // The §201 attack: a late 24b upload would, if accepted, cut the frozen TDS. BLOCKED.
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_24B_HOME_LOAN', declaredAmount: 200000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 409 && r.body.code === 'PROOF_DEADLINE_PASSED', 'FIX1) post-deadline UPLOAD blocked (409 PROOF_DEADLINE_PASSED)');

  // Now model the worst case: a proof slipped into the queue (PENDING) before the freeze
  // and HR tries to ACCEPT it after the deadline. That accept must be refused — otherwise
  // it raises the verified Σ and CUTS the frozen TDS.
  const latePending = await prisma.investmentProof.create({
    data: {
      businessId, employeeId: emp.id, windowId: win.id, financialYear: taxYear,
      claimType: 'SEC_24B_HOME_LOAN', declaredAmount: 200000, fileUrl: PNG_DATAURL,
      fileHash: 'x'.repeat(64), mimeType: 'image/png', sizeBytes: 70, status: 'PENDING',
    },
  });
  r = await run(proofsCtl.acceptProof, mkReq({ user: HR, params: { employeeId: emp.id, id: latePending.id }, body: { verifiedAmount: 200000 } }));
  ok(r.status === 409 && r.body.code === 'PROOF_DEADLINE_PASSED', 'FIX1) post-deadline ACCEPT blocked (409 PROOF_DEADLINE_PASSED)');

  // §201 PROOF — the frozen TDS is UNCHANGED by the blocked accept; the late 24b never
  // entered the figure. Read the assembler as-of a date past the (past) deadline.
  const stillFrozen = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: new Date().toISOString().slice(0, 10) });
  ok(stillFrozen.proofBasis === 'VERIFIED', 'FIX1) §201: assembler still VERIFIED past the deadline');
  ok(Math.abs(stillFrozen.totalTax - frozenTax) < 0.01, `FIX1) §201 PROOF — frozen TDS unchanged by blocked accept (${stillFrozen.totalTax} == ${frozenTax})`);
  ok(stillFrozen.proofLines.SEC_24B_HOME_LOAN.used === 0, 'FIX1) §201 PROOF — the blocked late 24b is NOT in the frozen figure (used 0)');
  // Confirm the proof remained PENDING (the accept truly did nothing).
  const latestill = await prisma.investmentProof.findUnique({ where: { id: latePending.id } });
  ok(latestill.status === 'PENDING' && latestill.verifiedAmount == null, 'FIX1) §201 PROOF — blocked proof stayed PENDING (no write happened)');

  // ════════ FIX 2 — verifiedAmount cap (min(declared,Σ)) + 80C ₹1.5L cap + rejected=0 ═══
  // Re-open the window date-wise (future deadline) so we test the cap path, not the freeze.
  const futureDl2 = await setWindowDeadline(win.id, +30);

  // 2a) accept verifiedAmount > declared → 422 (the per-proof cap = declaredAmount).
  r = await run(proofsCtl.acceptProof, mkReq({ user: HR, params: { employeeId: emp.id, id: latePending.id }, body: { verifiedAmount: 999999 } }));
  ok(r.status === 422 && r.body.code === 'VERIFIED_EXCEEDS_DECLARED', 'FIX2) verifiedAmount > declared → 422 (per-proof cap)');

  // 2b) REJECT the 24b proof → it contributes 0 to the verified Σ.
  r = await run(proofsCtl.rejectProof, mkReq({ user: HR, params: { employeeId: emp.id, id: latePending.id }, body: { rejectReason: 'Wrong FY on the certificate' } }));
  ok(r.status === 200 && r.body.status === 'REJECTED', 'FIX2) reject 24b (mandatory reason)');

  // 2c) over-declare 80C to ₹3L, upload + accept the FULL ₹3L, and prove the engine STILL
  // caps the 80C deduction at the statutory ₹1,50,000 (Σaccepted exceeds declared cap too,
  // but here we show the STATUTORY cap biting on a fully-verified over-declaration).
  await prisma.statutoryProfile.updateMany({ where: { businessId, employeeId: emp.id }, data: { section80CDeclared: 300000 } });
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_80C', declaredAmount: 300000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 201, 'FIX2) upload a ₹3L 80C proof (future deadline → window date-OPEN)');
  const big80c = r.body.id;
  r = await run(proofsCtl.acceptProof, mkReq({ user: HR, params: { employeeId: emp.id, id: big80c }, body: { verifiedAmount: 300000 } }));
  ok(r.status === 200, 'FIX2) accept the ₹3L 80C proof');

  // Read VERIFIED (asOf the future deadline) → 80C deductible capped at ₹1.5L despite ₹3.9L
  // verified (90k + 3L + PF). The min(declared,Σ) cap holds the section input at declared
  // (₹3L) and the engine's statutory ₹1.5L cap holds the DEDUCTION at ₹1.5L.
  const capped = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf: futureDl2 });
  const c80 = (capped.chapterVIA.lines || []).find((l) => l.section === '80C');
  ok(c80 && c80.deductible <= 150000, `FIX2) 80C deductible capped at ₹1.5L despite ₹3L verified (got ${c80 ? c80.deductible : 'n/a'})`);
  ok(capped.proofLines.SEC_80C.used <= 300000, 'FIX2) 80C used = min(declared ₹3L, Σaccepted) — never above declared');
  ok(capped.proofLines.SEC_24B_HOME_LOAN.used === 0, 'FIX2) rejected 24b → 0 used (excluded from verified Σ)');

  // ════════ FIX 3 — SoD: an operator cannot verify/reject their OWN employee's proof ════
  r = await run(meProofs.uploadProof, mkReq({ customer: cust, body: { claimType: 'SEC_80D', declaredAmount: 25000, fileBase64: PNG_DATAURL, financialYear: taxYear } }));
  ok(r.status === 201, 'FIX3) upload an 80D proof for the SoD case');
  const sodProof = r.body.id;
  const selfHR = { id: 'self-hr-frz', businessId, role: 'ADMIN', employeeId: emp.id }; // operator IS this employee
  r = await run(proofsCtl.acceptProof, mkReq({ user: selfHR, params: { employeeId: emp.id, id: sodProof }, body: { verifiedAmount: 25000 } }));
  ok(r.status === 403 && r.body.code === 'SOD_VIOLATION', 'FIX3) SoD blocks self-ACCEPT (403)');
  r = await run(proofsCtl.rejectProof, mkReq({ user: selfHR, params: { employeeId: emp.id, id: sodProof }, body: { rejectReason: 'self' } }));
  ok(r.status === 403 && r.body.code === 'SOD_VIOLATION', 'FIX3) SoD blocks self-REJECT (403)');
  // And a non-self operator CAN verify it (the SoD guard is per-operator, not a lockout).
  r = await run(proofsCtl.acceptProof, mkReq({ user: HR, params: { employeeId: emp.id, id: sodProof }, body: { verifiedAmount: 25000 } }));
  ok(r.status === 200 && r.body.status === 'ACCEPTED', 'FIX3) a different operator CAN verify (SoD is per-operator)');

  await cleanup(businessId);
  console.log(`\nFeature 20 §201 proof-deadline-freeze live test: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });

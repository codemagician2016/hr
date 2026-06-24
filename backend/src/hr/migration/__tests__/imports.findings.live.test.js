'use strict';

/*
 * imports.findings.live.test.js — LIVE (hr_test) proof that the 8 confirmed
 * Wave-B F18 review findings are CLOSED. Plain-node (built-in assert, NO jest).
 *
 * Run (DATABASE_URL must target the hr_test schema):
 *   DATABASE_URL="$HR_URL" node src/hr/migration/__tests__/imports.findings.live.test.js
 *
 * Proves, one block per finding:
 *   H1  autogen scopes the MIGRATED run to ONLY the imported employees (not the
 *       whole active entity workforce).
 *   H2  CSV read keeps +91 phones / negative money VERBATIM; export escapes them.
 *   M1  a duplicate natural key within a file → a row-level DUPLICATE_IN_FILE
 *       finding, NEVER a P2002 500.
 *   M2  a quarantined (hrCountryAmbiguous) tenant is BLOCKED at import entry.
 *   M3  two same-country entities get DISTINCT migrated runs (entity-keyed code).
 *   M4  an imported reimbursement is NEVER maker==checker (a non-human migration
 *       actor / prior approver is the checker, never the operator or employee).
 *   L1  a foreign / unknown entityId is REJECTED at createJob (not silently kept).
 *   L2  a PAYROLL_HISTORY dry-run persists NOTHING (no orphan migrated run).
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const service = require('../imports.service');
const autogen = require('../autogen.service');
const csv = require('../parsers/csv');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const ACTOR = 'f18-findings-actor';
const EMP_A = 'EMP-F18F-A';
const EMP_B = 'EMP-F18F-B';
const PERIOD = '2025-11';

function b64(text) { return Buffer.from(text, 'utf8').toString('base64'); }

async function cleanupEmp(businessId, code) {
  const emp = await prisma.employee.findFirst({ where: { businessId, code } });
  if (!emp) return;
  await prisma.attendance.deleteMany({ where: { businessId, employeeId: emp.id } });
  await prisma.expenseClaimLine.deleteMany({ where: { claim: { employeeId: emp.id } } });
  await prisma.expenseClaim.deleteMany({ where: { businessId, employeeId: emp.id } });
  await prisma.salaryComponentLine.deleteMany({ where: { compensation: { employeeId: emp.id } } });
  await prisma.compensationRevision.deleteMany({ where: { businessId, employeeId: emp.id } });
  await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: emp.id } });
  await prisma.statutoryProfile.deleteMany({ where: { employeeId: emp.id } });
  await prisma.employee.update({ where: { id: emp.id }, data: { currentEmploymentRecordId: null, userId: null } });
  await prisma.employee.deleteMany({ where: { id: emp.id } });
}

async function cleanup(businessId) {
  const jobs = await prisma.importJob.findMany({ where: { businessId, uploadedBy: ACTOR }, select: { id: true } });
  const jobIds = jobs.map((j) => j.id);
  const runs = await prisma.payRun.findMany({ where: { businessId, importJobId: { in: jobIds.length ? jobIds : ['_none_'] } }, select: { id: true } });
  const runIds = runs.map((r) => r.id);
  if (runIds.length) {
    await prisma.payslip.deleteMany({ where: { payRunId: { in: runIds } } });
    await prisma.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: runIds } } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: runIds } } });
    await prisma.attendancePayInput.deleteMany({ where: { payRunId: { in: runIds } } });
    await prisma.payRun.deleteMany({ where: { id: { in: runIds } } });
  }
  await cleanupEmp(businessId, EMP_A);
  await cleanupEmp(businessId, EMP_B);
  if (jobIds.length) await prisma.importJob.deleteMany({ where: { id: { in: jobIds } } });
}

async function makeEmployeeWithCtc(businessId, entity, code, periodMonth) {
  // Seed an imported employee + CTC so autogen can compute a real payslip.
  const empCsv = [
    'code,firstName,lastName,workEmail,gender,dateOfBirth,dateOfJoining,entityCode,pan',
    `${code},Test,${code.slice(-1)},${code.toLowerCase()}@acme.in,FEMALE,1992-01-01,2024-04-01,${entity.code},ABCDE1234X`,
  ].join('\r\n');
  const ej = await service.createJob({ businessId, actorId: ACTOR, kind: 'EMPLOYEE', entityId: entity.id, fileName: `f18f-emp-${code}.csv`, contentBase64: b64(empCsv) });
  await service.commit({ businessId, actorId: ACTOR, jobId: ej.id });
  const cCsv = ['employeeCode,effectiveFrom,ctcAnnual,structureCode', `${code},2024-04-01,1200000,IN-STAFF-CTC`].join('\r\n');
  const cj = await service.createJob({ businessId, actorId: ACTOR, kind: 'COMPENSATION', entityId: entity.id, fileName: `f18f-comp-${code}.csv`, contentBase64: b64(cCsv) });
  await service.commit({ businessId, actorId: ACTOR, jobId: cj.id });
  return prisma.employee.findFirst({ where: { businessId, code } });
}

async function main() {
  log('\n=== F18 Wave-B findings proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } });
  assert(inEntity, 'IN-HQ entity present');

  await cleanup(businessId);

  // ── H2 (HIGH) — CSV read is verbatim; export escapes (pure, run first/no DB) ──
  {
    const { rows } = csv.parseCsv('phone,claimedAmount\n+919876543210,-500\n');
    ok(rows[0].phone === '+919876543210', `H2a +91 phone preserved verbatim on read (got "${rows[0].phone}")`);
    ok(rows[0].claimedAmount === '-500', `H2b negative money preserved verbatim on read (got "${rows[0].claimedAmount}")`);
    const wrote = csv.toCsv(['phone'], [{ phone: '+919876543210' }]);
    ok(wrote.includes("'+919876543210"), 'H2c export ESCAPES the formula-leading +91 phone (write-side guard intact)');
  }

  // Seed the active-workforce baseline count (the entity already has seed staff).
  const activeBefore = await prisma.employmentRecord.count({ where: { businessId, entityId: inEntity.id, isCurrent: true } });
  ok(activeBefore >= 1, `setup: IN-HQ has ${activeBefore} active employment record(s) (over-generation baseline)`);

  const empA = await makeEmployeeWithCtc(businessId, inEntity, EMP_A, PERIOD);
  ok(!!empA, 'setup: imported employee A created with CTC');

  // ── H1 (HIGH) — autogen scopes the run to ONLY the imported subset ───────────
  {
    const payCsv = ['employeeCode,periodMonth', `${EMP_A},${PERIOD}`].join('\r\n');
    const pj = await service.createJob({ businessId, actorId: ACTOR, kind: 'PAYROLL_HISTORY', entityId: inEntity.id, fileName: 'f18f-pay.csv', contentBase64: b64(payCsv), options: { payrollMode: 'GENERATE' } });
    const commit = await service.commit({ businessId, actorId: ACTOR, jobId: pj.id });
    const run = await prisma.payRun.findFirst({ where: { businessId, importJobId: pj.id }, include: { lines: true, payslips: true } });
    ok(!!run, 'H1a a MIGRATED run was generated');
    ok(run.lines.length === 1, `H1b run has EXACTLY 1 line (imported subset), not the whole ${activeBefore + 1}-person workforce (got ${run.lines.length})`);
    ok(run.payslips.length === 1, `H1c run minted EXACTLY 1 payslip (got ${run.payslips.length})`);
    ok(run.lines[0].employeeId === empA.id, 'H1d the only line belongs to the imported employee');
    ok(commit.autogen && commit.autogen.periods[0] && commit.autogen.periods[0].headcount === 1, `H1e autogen reports headcount=1 (got ${commit.autogen && commit.autogen.periods[0] && commit.autogen.periods[0].headcount})`);
  }

  // ── M1 (MED) — duplicate natural key in a file → row finding, NOT a 500 ──────
  {
    // Two COMPENSATION rows for the SAME (employeeCode|effectiveFrom) natural key.
    const dupCsv = [
      'employeeCode,effectiveFrom,ctcAnnual,structureCode',
      `${EMP_A},2025-01-01,1300000,IN-STAFF-CTC`,
      `${EMP_A},2025-01-01,1400000,IN-STAFF-CTC`,
    ].join('\r\n');
    const dj = await service.createJob({ businessId, actorId: ACTOR, kind: 'COMPENSATION', entityId: inEntity.id, fileName: 'f18f-dup.csv', contentBase64: b64(dupCsv) });
    let threw = null;
    let res = null;
    try { res = await service.validate({ businessId, actorId: ACTOR, jobId: dj.id }); } catch (e) { threw = e; }
    ok(threw === null, `M1a validate did NOT throw (no P2002 500) — got ${threw ? threw.code || threw.message : 'no throw'}`);
    const rows = await prisma.importRow.findMany({ where: { importJobId: dj.id }, orderBy: { rowNumber: 'asc' } });
    const dupRow = rows.find((r) => (r.findingsJson || []).some((f) => f.code === 'DUPLICATE_IN_FILE'));
    ok(!!dupRow, 'M1b the second row carries a DUPLICATE_IN_FILE finding');
    ok(dupRow && dupRow.naturalKey === `__row_${dupRow.rowNumber}`, `M1c the colliding row keeps a row-unique sentinel key (got "${dupRow && dupRow.naturalKey}")`);
    ok(res && res.errorCount >= 1, `M1d validate reported the dup as an ERROR row (errorCount=${res && res.errorCount})`);
  }

  // ── L1 (LOW) — a foreign/unknown entityId is REJECTED at createJob ───────────
  {
    let threw = null;
    try {
      await service.createJob({ businessId, actorId: ACTOR, kind: 'EMPLOYEE', entityId: '00000000-0000-0000-0000-000000000000', fileName: 'f18f-bad-ent.csv', contentBase64: b64('code,firstName\nX,Y\n') });
    } catch (e) { threw = e; }
    ok(threw && threw.code === 'UNKNOWN_ENTITY', `L1 unknown entityId rejected with UNKNOWN_ENTITY (got ${threw ? threw.code : 'no throw'})`);
  }

  // ── L2 (LOW) — PAYROLL_HISTORY dry-run persists NOTHING (no orphan run) ──────
  {
    const payCsv = ['employeeCode,periodMonth', `${EMP_A},2025-10`].join('\r\n');
    const pj = await service.createJob({ businessId, actorId: ACTOR, kind: 'PAYROLL_HISTORY', entityId: inEntity.id, fileName: 'f18f-dry.csv', contentBase64: b64(payCsv), options: { payrollMode: 'GENERATE' } });
    const dry = await service.dryRun({ businessId, actorId: ACTOR, jobId: pj.id });
    const net = dry.preview && dry.preview.perRow[0] ? dry.preview.perRow[0].netPay : null;
    ok(net != null && net > 0, `L2a dry-run shows engine-true net (₹${net})`);
    const leftover = await prisma.payRun.count({ where: { businessId, importJobId: pj.id } });
    ok(leftover === 0, `L2b dry-run persisted NO migrated run (count=${leftover})`);
    // even sweeping for preview-tagged orphans finds none
    const swept = await autogen.sweepPreviewRuns(businessId, pj.id);
    ok(swept === 0, `L2c no preview orphan to sweep after a clean dry-run (swept=${swept})`);

    // L2d — simulate a CRASHED dry-run that orphaned a COMPUTED preview run, then
    // run the real commit: it must SWEEP the orphan and NOT adopt it as the real
    // run (the orphan could otherwise be silently approved).
    const cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } });
    const orphan = await prisma.payRun.create({
      data: {
        businessId, entityId: inEntity.id, payCalendarId: cal.id,
        code: autogen.migratedRunCode({ code: inEntity.code, countryCode: inEntity.countryCode }, '2025-10'),
        periodStart: new Date('2025-10-01'), periodEnd: new Date('2025-10-31'), payDate: new Date('2025-10-31'),
        sequenceInYear: 7, taxYear: '2025-26', currencyCode: inEntity.payCurrency, status: 'COMPUTED',
        type: 'MIGRATED', importJobId: pj.id, notes: `${autogen.PREVIEW_TAG} orphaned preview`,
      },
    });
    const commit = await service.commit({ businessId, actorId: ACTOR, jobId: pj.id });
    const orphanGone = await prisma.payRun.findUnique({ where: { id: orphan.id } });
    ok(orphanGone === null, 'L2d the crashed-dry-run preview orphan was swept (never adopted/approved)');
    const realRun = await prisma.payRun.findFirst({ where: { businessId, importJobId: pj.id } });
    ok(realRun && !(realRun.notes || '').includes(autogen.PREVIEW_TAG) && realRun.id !== orphan.id, 'L2e the real commit created a FRESH authoritative run (not the preview orphan)');
    ok(commit.autogen && commit.autogen.periods.length === 1, 'L2f real commit still autogenerated the period');
  }

  // ── M3 (MED) — two same-country entities get DISTINCT migrated runs ──────────
  {
    // Find/seed a SECOND IN entity. The demo tenant may only have one IN entity;
    // if so we still prove the run-code is entity-keyed (no countryCode collision).
    const inEntities = await prisma.entity.findMany({ where: { businessId, countryCode: 'IN', deletedAt: null } });
    const codeA = autogen.migratedRunCode({ code: 'IN-HQ', countryCode: 'IN' }, PERIOD);
    const codeB = autogen.migratedRunCode({ code: 'IN-BLR', countryCode: 'IN' }, PERIOD);
    ok(codeA !== codeB, `M3a two same-country entities yield DISTINCT run codes (${codeA} != ${codeB})`);
    ok(codeA.includes('IN-HQ') && codeB.includes('IN-BLR'), 'M3b run code is keyed on entity.code, not countryCode');
    ok(inEntities.length >= 1, `M3c (info) tenant has ${inEntities.length} IN entity(ies)`);
  }

  // ── M4 (MED) — imported reimbursement is NEVER maker==checker ────────────────
  {
    const reimbCsv = [
      'employeeCode,expenseDate,claimedAmount,status,description',
      `${EMP_A},2025-09-10,9000,APPROVED,Imported claim no approver`,
      `${EMP_A},2025-09-11,4000,REIMBURSED,Imported claim self-as-approver`,
    ].join('\r\n');
    // Note: the second row would (pre-fix) stamp decidedBy = the operator (maker).
    const rj = await service.createJob({ businessId, actorId: ACTOR, kind: 'REIMBURSEMENT', entityId: inEntity.id, fileName: 'f18f-reimb.csv', contentBase64: b64(reimbCsv) });
    await service.commit({ businessId, actorId: ACTOR, jobId: rj.id });
    const claims = await prisma.expenseClaim.findMany({ where: { businessId, employeeId: empA.id, importJobId: rj.id }, orderBy: { expenseDate: 'asc' } });
    ok(claims.length === 2, `M4a 2 imported claims created (got ${claims.length})`);
    for (const c of claims) {
      ok(c.decidedBy && c.decidedBy !== ACTOR, `M4b decidedBy is NOT the importing operator (got "${c.decidedBy}")`);
      ok(c.decidedBy !== empA.id && c.decidedBy !== empA.code, 'M4c decidedBy is NOT the claimant employee (maker≠checker)');
      ok(c.decidedBy === 'SYSTEM:MIGRATION', `M4d checker is the dedicated SYSTEM:MIGRATION actor (got "${c.decidedBy}")`);
      const prov = (c.policySnapshotJson || {}).__migration;
      ok(prov && prov.migrated === true && prov.importJobId === rj.id, 'M4e MIGRATED provenance recorded on the claim snapshot');
      if (c.status === 'REIMBURSED') ok(c.reimbursedBy === 'SYSTEM:MIGRATION', `M4f reimbursedBy is the migration actor too (got "${c.reimbursedBy}")`);
    }
    // a prior-system approver from the file is honoured (when not the employee)
    const reimbCsv2 = ['employeeCode,expenseDate,claimedAmount,status,approvedBy,description', `${EMP_A},2025-08-01,2500,APPROVED,mgr-jane,Prior approver`].join('\r\n');
    const rj2 = await service.createJob({ businessId, actorId: ACTOR, kind: 'REIMBURSEMENT', entityId: inEntity.id, fileName: 'f18f-reimb2.csv', contentBase64: b64(reimbCsv2) });
    await service.commit({ businessId, actorId: ACTOR, jobId: rj2.id });
    const c3 = await prisma.expenseClaim.findFirst({ where: { businessId, employeeId: empA.id, importJobId: rj2.id } });
    ok(c3 && c3.decidedBy === 'mgr-jane', `M4g prior-system approver honoured as checker (got "${c3 && c3.decidedBy}")`);
  }

  // ── M2 (MED) — a quarantined tenant is BLOCKED at import entry ───────────────
  {
    // Flip the demo tenant to ambiguous (quarantined) in a SAVEPOINT-style guard:
    // set it, attempt an import (must 409), then restore — no matter what.
    const before = await prisma.business.findUnique({ where: { id: businessId }, select: { hrCountryAmbiguous: true } });
    await prisma.business.update({ where: { id: businessId }, data: { hrCountryAmbiguous: true } });
    let threw = null;
    try {
      await service.createJob({ businessId, actorId: ACTOR, kind: 'EMPLOYEE', fileName: 'f18f-quar.csv', contentBase64: b64('code,firstName\nX,Y\n') });
    } catch (e) { threw = e; }
    await prisma.business.update({ where: { id: businessId }, data: { hrCountryAmbiguous: before.hrCountryAmbiguous } });
    ok(threw && (threw.code === 'HR_COUNTRY_AMBIGUOUS' || threw.status === 409), `M2 quarantined tenant blocked at import entry (got ${threw ? (threw.code || threw.status) : 'no throw'})`);
  }

  await cleanup(businessId);
  log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

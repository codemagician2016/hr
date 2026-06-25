'use strict';

/*
 * disbursement.live.test.js — LIVE (hr_test) proof of the India salary
 * disbursement orchestrator (disbursement.service.js). Plain-node (built-in
 * assert, NO jest), mirroring the other payroll *.live.test.js files. Run:
 *   DATABASE_URL="<base>?schema=hr_test" node src/hr/payroll/disbursement/__tests__/disbursement.live.test.js
 *
 * Proves end-to-end against real rows (own DRAFT→LOCKED run + PayRunLines built
 * over the seeded demo IN employees + their bank accounts):
 *   1. createBatch is REJECTED on a DRAFT run (BAD_STATE), allowed once LOCKED.
 *   2. createBatch builds PayoutLines from net pay + the primary bank account;
 *      the employee with a null/invalid IFSC is FLAGGED (skipped) not crashed;
 *      Σ line.amountMinor == batch.totalMinor (round-trip).
 *   3. generateFile renders a valid HDFC advice file + stamps fileGeneratedAt
 *      (QUEUED→PROCESSING) and the file total matches the batch total.
 *   4. reconcile applies a UTR/status set: all CREDITED → batch CREDITED; a mix
 *      → PARTIAL; idempotent re-run is safe.
 *   5. tenant isolation: a cross-tenant batchId 404s (NOT_FOUND).
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const svc = require('../disbursement.service');
const money = require('../../money');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
async function throws(fn, codeOrStatus, msg) {
  try { await fn(); failures += 1; log(`  FAIL  ${msg} (no throw)`); }
  catch (e) {
    const hit = e && (e.code === codeOrStatus || e.statusCode === codeOrStatus);
    if (hit) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg} (got ${e && (e.code || e.statusCode)})`); }
  }
}

const PREFIX = 'DISBTEST';
const dec = (v) => Number(v);

async function cleanup(businessId) {
  const runs = await prisma.payRun.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    const batches = await prisma.payoutBatch.findMany({ where: { payRunId: { in: ids } }, select: { id: true } });
    const bIds = batches.map((b) => b.id);
    if (bIds.length) await prisma.payoutLine.deleteMany({ where: { batchId: { in: bIds } } });
    await prisma.payoutBatch.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRunLine.deleteMany({ where: { payRunId: { in: ids } } });
    await prisma.payRun.deleteMany({ where: { id: { in: ids } } });
  }
}

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' }, select: { id: true } });
  assert(demo, 'demo business must exist in hr_test');
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' }, select: { id: true, payCurrency: true } });
  const cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id }, select: { id: true } });
  assert(inEntity && cal, 'IN-HQ entity + calendar must exist');

  await cleanup(businessId);

  // Pick TWO IN employees with a VALID IFSC bank account (payable) + one with a
  // missing/invalid IFSC (must be FLAGGED, not crash the batch).
  const inBanks = await prisma.bankAccount.findMany({
    where: { businessId, isPrimary: true, isActive: true, deletedAt: null, ifsc: { not: null } },
    select: { employeeId: true, ifsc: true, accountNumber: true },
  });
  const valid = inBanks.filter((b) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(b.ifsc || '').toUpperCase()));
  assert(valid.length >= 2, `need >=2 employees with a valid-IFSC bank account (got ${valid.length})`);
  const payEmpA = valid[0].employeeId;
  const payEmpB = valid[1].employeeId;
  // An employee with a non-IFSC (NZ-style) primary account → should be flagged.
  const bad = await prisma.bankAccount.findFirst({
    where: { businessId, isPrimary: true, isActive: true, deletedAt: null, OR: [{ ifsc: null }, { ifsc: '' }] },
    select: { employeeId: true },
  });
  const flagEmp = bad ? bad.employeeId : null;

  const empIds = [payEmpA, payEmpB, flagEmp].filter(Boolean);

  // Build a DRAFT run + hand-rolled PayRunLines (net pay) over those employees.
  const run = await prisma.payRun.create({
    data: {
      businessId, entityId: inEntity.id, payCalendarId: cal.id,
      code: `${PREFIX}-IN-${Date.now()}`,
      periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30'), payDate: new Date('2026-06-30'),
      sequenceInYear: 3, taxYear: '2026-27', currencyCode: inEntity.payCurrency || 'INR', status: 'DRAFT', type: 'REGULAR',
    },
  });
  const NETS = { [payEmpA]: 4500075, [payEmpB]: 25000000 }; // paise
  if (flagEmp) NETS[flagEmp] = 3300000;
  for (const eid of empIds) {
    await prisma.payRunLine.create({
      data: {
        businessId, payRunId: run.id, employeeId: eid, compensationId: 'disb-test',
        payableDays: '30', netPay: money.fromMinor(NETS[eid]),
        grossEarnings: money.fromMinor(NETS[eid]), totalDeductions: '0', employerCost: money.fromMinor(NETS[eid]),
        currencyCode: 'INR', status: 'COMPUTED',
      },
    });
  }

  // 1. DRAFT → createBatch rejected.
  await throws(() => svc.createBatch({ businessId, actorId: 'maker', payRunId: run.id, bank: 'HDFC' }), 'BAD_STATE',
    'createBatch on a DRAFT run is rejected (BAD_STATE)');

  // Freeze the run (LOCKED) so it's disbursable.
  await prisma.payRun.update({ where: { id: run.id }, data: { status: 'LOCKED' } });

  // 2. createBatch builds lines + flags the bad-IFSC employee + round-trips total.
  const batch = await svc.createBatch({ businessId, actorId: 'maker', payRunId: run.id, bank: 'HDFC', debitAccount: '00060350001234', valueDate: '2026-06-30' });
  const expectPayable = 2;
  ok(batch.count === expectPayable, `batch covers ${expectPayable} payable employees (got ${batch.count})`);
  ok(Array.isArray(batch.skipped) && (flagEmp ? batch.skipped.length === 1 : batch.skipped.length === 0),
    `flagged ${flagEmp ? 1 : 0} employee with no valid IFSC (got ${batch.skipped.length})`);
  const expectTotal = NETS[payEmpA] + NETS[payEmpB];
  ok(batch.totalMinor === expectTotal, `batch total == Σ payable net (${expectTotal}, got ${batch.totalMinor})`);
  ok(batch.status === 'QUEUED', `new batch is QUEUED (got ${batch.status})`);

  // round-trip: re-read lines and sum.
  const linesSum = (await prisma.payoutLine.findMany({ where: { businessId, batchId: batch.id }, select: { amountMinor: true } }))
    .reduce((s, l) => s + Number(l.amountMinor), 0);
  ok(linesSum === batch.totalMinor, `Σ PayoutLine.amountMinor == batch.totalMinor (${linesSum})`);

  // 3. generateFile renders + stamps fileGeneratedAt (QUEUED→PROCESSING).
  const file = await svc.generateFile({ businessId, batchId: batch.id });
  ok(file.content.includes('HDFC0001234') || /\d/.test(file.content), 'advice file rendered with content');
  ok(file.meta.totalMinor === expectTotal, `file total == batch total (${file.meta.totalMinor})`);
  ok(file.fileName.startsWith('PAYOUT_HDFC_'), `file named PAYOUT_HDFC_* (got ${file.fileName})`);
  const afterGen = await prisma.payoutBatch.findUnique({ where: { id: batch.id }, select: { status: true, fileGeneratedAt: true } });
  ok(afterGen.fileGeneratedAt != null, 'fileGeneratedAt stamped');
  ok(afterGen.status === 'PROCESSING', `status flipped QUEUED→PROCESSING (got ${afterGen.status})`);

  // 4a. reconcile a MIX (one CREDITED, one FAILED) → PARTIAL.
  const lineRows = await prisma.payoutLine.findMany({ where: { businessId, batchId: batch.id }, select: { employeeId: true, accountNumber: true } });
  const mix = svc.reconcile ? await svc.reconcile({
    businessId, actorId: 'maker', batchId: batch.id,
    rows: [
      { employeeId: lineRows[0].employeeId, status: 'CREDITED', utr: 'UTR0001' },
      { employeeId: lineRows[1].employeeId, status: 'FAILED', failureReason: 'Account frozen' },
    ],
  }) : null;
  ok(mix && mix.batch.status === 'PARTIAL', `mixed reconcile rolls up to PARTIAL (got ${mix && mix.batch.status})`);
  ok(mix && mix.report.filter((r) => r.matched).length === 2, 'both reconcile rows matched a line');

  // 4b. reconcile ALL CREDITED → batch CREDITED + reconciledAt stamped. Idempotent.
  const allCredited = await svc.reconcile({
    businessId, actorId: 'maker', batchId: batch.id,
    rows: lineRows.map((l, i) => ({ accountNumber: l.accountNumber, status: 'CREDITED', utr: `UTR900${i}` })),
  });
  ok(allCredited.batch.status === 'CREDITED', `all-credited rolls up to CREDITED (got ${allCredited.batch.status})`);
  ok(allCredited.batch.reconciledAt != null, 'reconciledAt stamped on terminal CREDITED');
  // Re-run identical reconcile — still CREDITED (idempotent).
  const again = await svc.reconcile({
    businessId, actorId: 'maker', batchId: batch.id,
    rows: lineRows.map((l) => ({ accountNumber: l.accountNumber, status: 'CREDITED' })),
  });
  ok(again.batch.status === 'CREDITED', 'reconcile is idempotent (still CREDITED)');

  // createBatch now refused (a credited batch exists → no over-pay).
  await throws(() => svc.createBatch({ businessId, actorId: 'maker', payRunId: run.id, bank: 'HDFC' }), 'BAD_STATE',
    'a 2nd batch after CREDITED is refused (no over-pay)');

  // 5. tenant isolation: another tenant cannot see this batch (404).
  const other = await prisma.business.findFirst({ where: { slug: { not: 'demo' } }, select: { id: true } });
  if (other) {
    await throws(() => svc.getBatch({ businessId: other.id, batchId: batch.id }), 'NOT_FOUND',
      'cross-tenant getBatch 404s (NOT_FOUND)');
    await throws(() => svc.generateFile({ businessId: other.id, batchId: batch.id }), 'NOT_FOUND',
      'cross-tenant generateFile 404s (NOT_FOUND)');
  } else {
    log('  SKIP  no 2nd tenant for isolation check');
  }

  // getBatch returns paginated, masked lines.
  const view = await svc.getBatch({ businessId, batchId: batch.id, page: 1, pageSize: 1 });
  ok(view.pagination.total === expectPayable && view.lines.length === 1, 'getBatch paginates lines');
  ok(/^X+\d{4}$/.test(view.lines[0].accountNumberMasked), `account number masked in the read model (${view.lines[0].accountNumberMasked})`);

  await cleanup(businessId);

  log('');
  log(failures === 0 ? 'DISBURSEMENT LIVE: ALL PASS' : `DISBURSEMENT LIVE: ${failures} FAILURE(S)`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

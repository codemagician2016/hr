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

  // 3b. HIGH double-pay window: batch is now PROCESSING (file OUT, money in flight)
  // but NOT yet reconciled/CREDITED. A 2nd createBatch in this window MUST be
  // refused — the OLD CREDITED-only guard let it through and double-paid everyone.
  await throws(() => svc.createBatch({ businessId, actorId: 'maker', payRunId: run.id, bank: 'HDFC' }), 'BAD_STATE',
    'HIGH: 2nd batch blocked while a PROCESSING (in-flight) batch exists (no double-pay)');
  // generateFile on a NEW (hypothetical) sibling is also guarded — proven below via
  // the force path; here we assert the in-flight batch still re-renders idempotently.
  const reRender = await svc.generateFile({ businessId, batchId: batch.id });
  ok(reRender.meta.totalMinor === expectTotal, 'in-flight batch re-renders its own file idempotently');

  // 3c. An explicit audited `force` re-issues over the in-flight batch (allowed).
  const forced = await svc.createBatch({ businessId, actorId: 'maker', payRunId: run.id, bank: 'HDFC', force: true });
  ok(forced && forced.id && forced.id !== batch.id, 'HIGH: force=true re-issues a NEW batch over an in-flight one (audited)');
  // The forced sibling's file is blocked while the original is still in flight (no 2 live files).
  await throws(() => svc.generateFile({ businessId, batchId: forced.id }), 'BAD_STATE',
    'HIGH: generateFile refuses a 2nd live file while a sibling batch is in flight');
  // Clean up the forced sibling so the rest of the scenario (single batch) is unaffected.
  await prisma.payoutLine.deleteMany({ where: { batchId: forced.id } });
  await prisma.payoutBatch.delete({ where: { id: forced.id } });

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
  // Re-run identical reconcile — still CREDITED (idempotent) AND must NOT wipe UTR.
  const again = await svc.reconcile({
    businessId, actorId: 'maker', batchId: batch.id,
    rows: lineRows.map((l) => ({ accountNumber: l.accountNumber, status: 'CREDITED' })),
  });
  ok(again.batch.status === 'CREDITED', 'reconcile is idempotent (still CREDITED)');
  const utrsAfterIdem = (await prisma.payoutLine.findMany({ where: { businessId, batchId: batch.id }, select: { utr: true } })).map((l) => l.utr);
  ok(utrsAfterIdem.every((u) => u && /^UTR900\d$/.test(u)), `LOW5: stale CREDITED re-apply (no utr in row) PRESERVES utr (${utrsAfterIdem.join(',')})`);

  // createBatch refused while the batch is CREDITED (non-terminal-for-reissue → no over-pay).
  await throws(() => svc.createBatch({ businessId, actorId: 'maker', payRunId: run.id, bank: 'HDFC' }), 'BAD_STATE',
    'a 2nd batch after CREDITED is refused (no over-pay)');

  // 4c. LOW 5 — RETURNED after CREDITED must PRESERVE the original credit UTR (proof
  // money left) and NOT null it. Reconcile ONE line as RETURNED with NO utr in the row.
  const firstLine = await prisma.payoutLine.findFirst({ where: { businessId, batchId: batch.id }, orderBy: { createdAt: 'asc' }, select: { id: true, accountNumber: true, utr: true } });
  const origUtr = firstLine.utr;
  ok(!!origUtr, `a credited line has a UTR before clawback (${origUtr})`);
  const ret = await svc.reconcile({
    businessId, actorId: 'maker', batchId: batch.id,
    rows: [{ accountNumber: firstLine.accountNumber, status: 'RETURNED', failureReason: 'Beneficiary returned' }],
  });
  const retLine = await prisma.payoutLine.findUnique({ where: { id: firstLine.id }, select: { status: true, utr: true, failureReason: true } });
  ok(retLine.status === 'RETURNED', `line flips to RETURNED (got ${retLine.status})`);
  ok(retLine.utr === origUtr, `LOW5: RETURNED-after-CREDITED KEEPS the original UTR ${origUtr} (got ${retLine.utr})`);
  ok(retLine.failureReason === 'Beneficiary returned', 'RETURNED captures the failure reason');
  ok(ret.report.some((r) => r.matched && r.clawedBack === true), 'LOW5: report flags credited-then-returned as clawedBack');
  ok(ret.breakdown && ret.breakdown.returned === 1 && ret.breakdown.failed === 0, `LOW5: rollup breakdown counts RETURNED separately from FAILED (${JSON.stringify(ret.breakdown)})`);
  // Re-credit it so the batch returns to a clean CREDITED for the rest of the scenario.
  await svc.reconcile({ businessId, actorId: 'maker', batchId: batch.id, rows: [{ accountNumber: firstLine.accountNumber, status: 'CREDITED', utr: origUtr }] });

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

  // 6. MEDIUM 3 — an INVALID account number is FLAGGED (skipped), never shipped to
  // the bank file where the fixed-width formatter would truncate/corrupt it.
  // Build a SECOND fresh run with a single line for payEmpA, temporarily set that
  // employee's PRIMARY account to a too-long number, and assert createBatch skips it.
  const acctRow = await prisma.bankAccount.findFirst({
    where: { businessId, employeeId: payEmpA, isPrimary: true, isActive: true, deletedAt: null },
    select: { id: true, accountNumber: true },
  });
  if (acctRow) {
    const run2 = await prisma.payRun.create({
      data: {
        businessId, entityId: inEntity.id, payCalendarId: cal.id,
        code: `${PREFIX}-INVACC-${Date.now()}`,
        periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30'), payDate: new Date('2026-06-30'),
        sequenceInYear: 4, taxYear: '2026-27', currencyCode: inEntity.payCurrency || 'INR', status: 'LOCKED', type: 'REGULAR',
      },
    });
    await prisma.payRunLine.create({
      data: {
        businessId, payRunId: run2.id, employeeId: payEmpA, compensationId: 'disb-test',
        payableDays: '30', netPay: money.fromMinor(4500075), grossEarnings: money.fromMinor(4500075),
        totalDeductions: '0', employerCost: money.fromMinor(4500075), currencyCode: 'INR', status: 'COMPUTED',
      },
    });
    const origAcct = acctRow.accountNumber;
    try {
      // 19 digits → exceeds the 6..18 rule AND the SBI 17-wide column → must be flagged.
      await prisma.bankAccount.update({ where: { id: acctRow.id }, data: { accountNumber: '1234567890123456789' } });
      await throws(() => svc.createBatch({ businessId, actorId: 'maker', payRunId: run2.id, bank: 'HDFC' }), 'MISSING_BANK_DETAILS',
        'MEDIUM3: an invalid (too-long) account number yields no payable lines (422)');
      // The offender carries the INVALID_ACCOUNT reason (not shipped to the file).
      let offReason = null;
      try { await svc.createBatch({ businessId, actorId: 'maker', payRunId: run2.id, bank: 'HDFC' }); }
      catch (e) { offReason = (e.offenders || []).map((o) => o.reason); }
      ok(Array.isArray(offReason) && offReason.includes('INVALID_ACCOUNT'),
        `MEDIUM3: offender flagged INVALID_ACCOUNT (got ${JSON.stringify(offReason)})`);
    } finally {
      await prisma.bankAccount.update({ where: { id: acctRow.id }, data: { accountNumber: origAcct } });
      await prisma.payRunLine.deleteMany({ where: { payRunId: run2.id } });
      await prisma.payRun.delete({ where: { id: run2.id } });
    }
  } else {
    log('  SKIP  no primary account for payEmpA to test INVALID_ACCOUNT');
  }

  await cleanup(businessId);

  log('');
  log(failures === 0 ? 'DISBURSEMENT LIVE: ALL PASS' : `DISBURSEMENT LIVE: ${failures} FAILURE(S)`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });

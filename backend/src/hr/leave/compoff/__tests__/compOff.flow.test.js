'use strict';

/**
 * compOff.flow.test.js — LIVE (hr_test) integration proof for Feature 30 comp-off.
 * Same plain-node harness + isolated hr_test schema as leave.flow.test.js. Drives the
 * REAL runners + controllers + DB (no mocks).
 *
 * Covers, end to end:
 *   (1) EARN — a HOLIDAY_WORKED day → runCompOffEarn mints an ACTIVE credit with a
 *       60-day expiry + the aggregate COMP_OFF LeaveBalance closing == Σ lot remaining
 *       (invariant 1). requireApproval is OFF for the test policy → auto-finalize.
 *   (2) IDEMPOTENT EARN — a second runner pass over the same window mints nothing
 *       (invariant 4).
 *   (3) AVAIL — applying a COMP_OFF leave via createRequest → approveRequest debits
 *       the LOTS FIFO (not the regular balance); the aggregate ↔ lots reconcile holds
 *       (invariants 2,5); the regular balance is the comp-off balance (no EL touched).
 *   (4) EXPIRY — an already-expired credit lapses via runCompOffExpiry (LAPSE txn +
 *       closing drop + lot EXPIRED), and a COMP_OFF avail dated after the credit's
 *       expiry is blocked by the validator (COMP_OFF_WOULD_BE_EXPIRED) (invariant 6).
 *   (5) TENANT ISOLATION — the runner for tenant A never sees tenant B's rows.
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/leave/compoff/__tests__/compOff.flow.test.js
 */

const prisma = require('../../../../core/lib/prisma');
const leaveController = require('../../../controllers/leave.controller');
const ledger = require('../../ledger');
const { runCompOffEarn } = require('../compOffEarnRunner');
const { runCompOffExpiry } = require('../compOffExpiryRunner');
const { sumActiveRemaining } = require('../compOffLots');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

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
    const oj = res.json.bind(res); res.json = (p) => { const r = oj(p); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'COMPOFF-TEST';
const ALL_SCOPE = { kind: 'ALL' };
function dUTC(s) { return new Date(`${s}T00:00:00.000Z`); }
function isoDay(d) { const x = new Date(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())).toISOString().slice(0, 10); }

async function cleanup(businessId) {
  await prisma.compOffCredit.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.approvalRequest.deleteMany({ where: { businessId, OR: [{ module: 'COMP_OFF' }, { entityType: 'CompOffCredit' }], requesterEmployee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.leaveTransaction.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.leaveBalance.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.attendance.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.leavePolicy.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

// Reconcile: aggregate COMP_OFF balance closing == Σ remaining over ACTIVE lots, AND
// the ledger reconstruction matches the persisted closing (the two §7 invariants).
async function assertReconciles(businessId, balanceId, employeeId, label) {
  const bal = await prisma.leaveBalance.findUnique({ where: { id: balanceId } });
  const txns = await prisma.leaveTransaction.findMany({ where: { businessId, leaveBalanceId: balanceId } });
  assert(ledger.reconciles({ closing: Number(bal.closing) }, txns), `${label}: ledger reconstruction == persisted closing ${Number(bal.closing)}`);
  const activeLots = await prisma.compOffCredit.findMany({ where: { businessId, employeeId, status: 'ACTIVE' }, select: { quantity: true, consumed: true } });
  const lotSum = sumActiveRemaining(activeLots);
  assert(Math.abs(lotSum - Number(bal.closing)) < 1e-4, `${label}: aggregate closing ${Number(bal.closing)} == Σ active-lot remaining ${lotSum}`);
}

async function setupTenant(businessId, suffix, { requireApproval = false } = {}) {
  // A COMP_OFF leave type + a NONE-accrual policy with the test config.
  const type = await prisma.leaveType.create({
    data: { businessId, code: `${PREFIX}-COMPOFF-${suffix}`, name: 'Test Comp-off', category: 'COMP_OFF', unit: 'DAYS', isPaid: true, affectsLOP: false },
  });
  await prisma.leavePolicy.create({
    data: {
      businessId, leaveTypeId: type.id, code: `${PREFIX}-COMPOFF-POL-${suffix}`, name: 'Test Comp-off Policy',
      accrualMethod: 'NONE', accrualProrateOnJoin: false, isActive: true,
      compOffConfig: { expiryDays: 60, requireApproval, autoEarn: true, minWorkedMinutesForCredit: 240, fullDayMinutes: 480, allowHalfDay: true, earnFromWeeklyOff: true, earnFromHoliday: true, expiryReminderDays: 7 },
    },
  });
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-E-${suffix}`, firstName: 'Cee', lastName: 'O', status: 'ACTIVE', hireDate: new Date('2020-01-01') },
  });
  return { type, emp };
}

async function main() {
  log('\n=== Comp-off flow proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  // A SECOND tenant for the isolation check.
  const other = await prisma.business.findFirst({ where: { slug: { not: 'demo' } } });
  const otherBusinessId = other ? other.id : null;

  await cleanup(businessId);
  if (otherBusinessId) await cleanup(otherBusinessId);

  const apiUser = { id: 'op-1', businessId, employeeId: null };

  try {
    const { type, emp } = await setupTenant(businessId, 'A');

    // ── (1) EARN: a HOLIDAY_WORKED day (full shift) → an ACTIVE credit ─────────
    log('(1) EARN from a HOLIDAY_WORKED day:');
    const workedDate = '2026-06-14'; // a Sunday (weekly off)
    await prisma.attendance.create({
      data: { businessId, employeeId: emp.id, date: dUTC(workedDate), status: 'HOLIDAY_WORKED', workedMinutes: 480, lopFraction: 0 },
    });
    {
      const r = await runCompOffEarn({ businessId, asOf: dUTC('2026-06-15'), lookbackDays: 5 });
      assert(r.minted === 1, `earn minted 1 credit (got ${r.minted})`);
      const credit = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(credit && credit.status === 'ACTIVE', `credit is ACTIVE (auto-finalized; got ${credit && credit.status})`);
      assert(credit && Number(credit.quantity) === 1, `credit quantity 1.0 (full shift; got ${credit && Number(credit.quantity)})`);
      assert(credit && credit.sourceKind === 'WEEKLY_OFF', `sourceKind WEEKLY_OFF (no holiday row; got ${credit && credit.sourceKind})`);
      assert(credit && isoDay(credit.expiresOn) === '2026-08-13', `expiresOn = earnedOn + 60d = 2026-08-13 (got ${credit && isoDay(credit.expiresOn)})`);
      const bal = await prisma.leaveBalance.findFirst({ where: { businessId, employeeId: emp.id, leaveTypeId: type.id } });
      assert(bal && Number(bal.closing) === 1, `aggregate COMP_OFF closing = 1 (got ${bal && Number(bal.closing)})`);
      assert(bal && Number(bal.accrued) === 1, `aggregate accrued = 1 (ACCRUAL bridge posted; got ${bal && Number(bal.accrued)})`);
      await assertReconciles(businessId, bal.id, emp.id, 'after earn');
      global.__balId = bal.id;
    }

    // ── (2) IDEMPOTENT EARN: a second pass mints nothing ──────────────────────
    log('(2) IDEMPOTENT earn (second pass):');
    {
      const r = await runCompOffEarn({ businessId, asOf: dUTC('2026-06-15'), lookbackDays: 5 });
      assert(r.minted === 0, `second pass mints 0 (idempotent; got ${r.minted})`);
      const count = await prisma.compOffCredit.count({ where: { businessId, employeeId: emp.id } });
      assert(count === 1, `still exactly 1 credit (got ${count})`);
      const bal = await prisma.leaveBalance.findUnique({ where: { id: global.__balId } });
      assert(Number(bal.closing) === 1, `closing unchanged at 1 (got ${Number(bal.closing)})`);
    }

    // ── (3) AVAIL: a COMP_OFF leave application → approve → lots FIFO-debited ──
    log('(3) AVAIL a comp-off leave (apply → approve → lot debit):');
    {
      // Apply for a single working day WELL BEFORE the credit's expiry (2026-08-13).
      const req = { user: apiUser, body: { employeeId: emp.id, leaveTypeId: type.id, startDate: '2026-07-01', endDate: '2026-07-01' } };
      const res = await callController(leaveController.createRequest, req);
      assert(res.statusCode === 201, `comp-off apply → 201 (got ${res.statusCode}: ${JSON.stringify(res.body && res.body.message)})`);
      assert(res.body && Math.abs(Number(res.body.quantity)) === 1, `nets to 1 working day (got ${res.body && res.body.quantity})`);
      const appId = res.body.id;

      // Before approve: lots untouched (consumed stays 0 — only the aggregate hold moved).
      const lotBefore = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(Number(lotBefore.consumed) === 0, `lot consumed still 0 before approve (soft-hold only; got ${Number(lotBefore.consumed)})`);

      const apr = await callController(leaveController.approveRequest, { user: apiUser, scope: ALL_SCOPE, params: { id: appId } });
      assert(apr.statusCode === 200, `approve → 200 (got ${apr.statusCode})`);

      const lotAfter = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(Number(lotAfter.consumed) === 1, `lot consumed = 1 after approve (FIFO debit; got ${Number(lotAfter.consumed)})`);
      assert(lotAfter.status === 'EXHAUSTED', `lot flips EXHAUSTED (fully consumed; got ${lotAfter.status})`);
      const bal = await prisma.leaveBalance.findUnique({ where: { id: global.__balId } });
      assert(Number(bal.closing) === 0, `aggregate closing → 0 after avail (got ${Number(bal.closing)})`);
      assert(Number(bal.taken) === 1, `aggregate taken = 1 (got ${Number(bal.taken)})`);
      await assertReconciles(businessId, global.__balId, emp.id, 'after avail');
    }

    // ── (4) EXPIRY: an already-expired ACTIVE credit lapses + gate blocks avail ─
    // Kept WITHIN FY 2026-27 (same aggregate balance as step 3) so the per-credit
    // expiry is tested independently of FY-period scoping. earnedOn 2026-04-05 →
    // expires 2026-06-04; the avail-after-expiry is dated 2026-06-20 (same FY).
    log('(4) EXPIRY lapse + COMP_OFF_WOULD_BE_EXPIRED gate:');
    {
      const oldWorked = '2026-04-05'; // Sunday in FY 2026-27
      await prisma.attendance.create({
        data: { businessId, employeeId: emp.id, date: dUTC(oldWorked), status: 'HOLIDAY_WORKED', workedMinutes: 480, lopFraction: 0 },
      });
      const r1 = await runCompOffEarn({ businessId, asOf: dUTC('2026-04-06'), lookbackDays: 5 });
      assert(r1.minted === 1, `earn minted the old credit (got ${r1.minted})`);
      const old = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id, sourceDate: dUTC(oldWorked) } });
      assert(old && isoDay(old.expiresOn) === '2026-06-04', `old credit expires 2026-06-04 (got ${old && isoDay(old.expiresOn)})`);
      const balBeforeLapse = await prisma.leaveBalance.findUnique({ where: { id: global.__balId } });
      assert(Number(balBeforeLapse.closing) === 1, `closing = 1 from the old credit (got ${Number(balBeforeLapse.closing)})`);

      // GATE: a COMP_OFF avail dated 2026-06-20 (after the 06-04 expiry, same FY) →
      // blocked by the validator BEFORE the lot lapses (the credit is still ACTIVE,
      // available() still sees closing 1, so the expiry gate — not balance — fires).
      const gateRes = await callController(leaveController.createRequest, {
        user: apiUser, body: { employeeId: emp.id, leaveTypeId: type.id, startDate: '2026-06-20', endDate: '2026-06-20' },
      });
      assert(gateRes.statusCode === 400 || gateRes.statusCode === 409, `avail-after-expiry blocked (got ${gateRes.statusCode})`);
      assert(gateRes.body && gateRes.body.reason === 'COMP_OFF_WOULD_BE_EXPIRED', `reason COMP_OFF_WOULD_BE_EXPIRED (got ${gateRes.body && gateRes.body.reason})`);

      // LAPSE: run expiry with asOf past the expiry → the credit lapses.
      const ex = await runCompOffExpiry({ businessId, asOf: dUTC('2026-06-10') });
      assert(ex.lapsed === 1, `expiry lapsed 1 credit (got ${ex.lapsed})`);
      const lapsedCredit = await prisma.compOffCredit.findUnique({ where: { id: old.id } });
      assert(lapsedCredit.status === 'EXPIRED', `credit flips EXPIRED (got ${lapsedCredit.status})`);
      const balAfter = await prisma.leaveBalance.findUnique({ where: { id: global.__balId } });
      assert(Number(balAfter.closing) === 0, `closing → 0 after lapse (got ${Number(balAfter.closing)})`);
      assert(Number(balAfter.lapsed) === 1, `lapsed bucket = 1 (got ${Number(balAfter.lapsed)})`);
      await assertReconciles(businessId, global.__balId, emp.id, 'after lapse');

      // Idempotent expiry: a second run lapses nothing more.
      const ex2 = await runCompOffExpiry({ businessId, asOf: dUTC('2026-06-10') });
      assert(ex2.lapsed === 0, `second expiry pass lapses 0 (idempotent; got ${ex2.lapsed})`);
    }

    // ── (5) TENANT ISOLATION ──────────────────────────────────────────────────
    log('(5) TENANT ISOLATION:');
    if (otherBusinessId) {
      const { emp: empB } = await setupTenant(otherBusinessId, 'B');
      await prisma.attendance.create({
        data: { businessId: otherBusinessId, employeeId: empB.id, date: dUTC('2026-06-14'), status: 'HOLIDAY_WORKED', workedMinutes: 480, lopFraction: 0 },
      });
      // Run the earn runner SCOPED to tenant A only — tenant B must mint nothing.
      const rA = await runCompOffEarn({ businessId, asOf: dUTC('2026-06-15'), lookbackDays: 5 });
      const bCount = await prisma.compOffCredit.count({ where: { businessId: otherBusinessId, employeeId: empB.id } });
      assert(bCount === 0, `tenant-A run minted nothing for tenant B (got ${bCount})`);
      assert(rA.minted === 0, `tenant-A re-run mints 0 (its only day already earned; got ${rA.minted})`);
      // And the tenant-B run mints exactly B's credit.
      const rB = await runCompOffEarn({ businessId: otherBusinessId, asOf: dUTC('2026-06-15'), lookbackDays: 5 });
      assert(rB.minted === 1, `tenant-B run mints B's 1 credit (got ${rB.minted})`);
    } else {
      log('  SKIP  no second tenant in hr_test for isolation check');
    }
  } finally {
    await cleanup(businessId);
    if (otherBusinessId) await cleanup(otherBusinessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL COMP-OFF FLOW CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

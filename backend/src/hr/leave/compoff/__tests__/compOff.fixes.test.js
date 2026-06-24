'use strict';

/**
 * compOff.fixes.test.js — LIVE (hr_test) proof for the cycle4 comp-off ledger-
 * correctness fixes (Feature 30 findings #1–#6). Same plain-node harness + isolated
 * hr_test schema + REAL runners/controllers/DB (no mocks) as compOff.flow.test.js.
 *
 * One assertion block per finding:
 *   #1 Withdraw after a lot expires forfeits the expired units → aggregate closing
 *      never exceeds Σ active-lot remaining (no phantom spendable comp-off).
 *   #2 Double-EARN is impossible: a holiday/weekly-off classification FLIP between
 *      runner passes mints exactly ONE credit (stable attendanceId key).
 *   #3 Earn holiday lookup is entity/location-scoped: a Chennai-only holiday does not
 *      flip a Mumbai employee's sourceKind nor drop their weekly-off credit.
 *   #4 COMP_OFF_WOULD_BE_EXPIRED gates the END/per-day, not just START: a multi-day
 *      span that ends after a lot expires mid-span is blocked.
 *   #5 Withdraw re-credits EXACTLY the lots this leave debited (not arbitrary lots).
 *   #6 Void route is F1-scoped: an out-of-subtree void → 404 (no balance burn).
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/leave/compoff/__tests__/compOff.fixes.test.js
 */

const prisma = require('../../../../core/lib/prisma');
const leaveController = require('../../../controllers/leave.controller');
const compOffController = require('../../../controllers/compOff.controller');
const ledger = require('../../ledger');
const { runCompOffEarn } = require('../compOffEarnRunner');
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

const PREFIX = 'COMPOFF-FIX';
const ALL_SCOPE = { kind: 'ALL' };
function dUTC(s) { return new Date(`${s}T00:00:00.000Z`); }
function isoDay(d) { const x = new Date(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())).toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(dUTC(isoDay(d)).getTime() + n * 86400000); }

async function cleanup(businessId) {
  await prisma.compOffConsumption.deleteMany({ where: { businessId, leaveTransaction: { employee: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  await prisma.compOffCredit.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.approvalRequest.deleteMany({ where: { businessId, OR: [{ module: 'COMP_OFF' }, { entityType: 'CompOffCredit' }], requesterEmployee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.leaveTransaction.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.leaveBalance.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.attendance.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.holiday.deleteMany({ where: { businessId, name: { startsWith: PREFIX } } });
  await prisma.employmentRecord.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.leavePolicy.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.location.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function setupType(businessId, suffix, cfg = {}) {
  // Each finding uses its OWN COMP_OFF type. The runner/controllers resolve the tenant's
  // OLDEST active COMP_OFF type (resolveCompOffType, createdAt asc), so deactivate prior
  // test types first — keeping the CURRENT finding's type the single resolved one.
  await prisma.leaveType.updateMany({ where: { businessId, code: { startsWith: PREFIX }, category: 'COMP_OFF' }, data: { isActive: false } });
  const type = await prisma.leaveType.create({
    data: { businessId, code: `${PREFIX}-T-${suffix}`, name: 'Fix Comp-off', category: 'COMP_OFF', unit: 'DAYS', isPaid: true, affectsLOP: false },
  });
  await prisma.leavePolicy.create({
    data: {
      businessId, leaveTypeId: type.id, code: `${PREFIX}-P-${suffix}`, name: 'Fix Comp-off Policy',
      accrualMethod: 'NONE', accrualProrateOnJoin: false, isActive: true,
      compOffConfig: {
        expiryDays: 60, requireApproval: false, autoEarn: true, minWorkedMinutesForCredit: 240,
        fullDayMinutes: 480, allowHalfDay: true, earnFromWeeklyOff: true, earnFromHoliday: true,
        expiryReminderDays: 7, ...cfg,
      },
    },
  });
  return type;
}

async function mkEmployee(businessId, suffix, { entityId, locationId } = {}) {
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-E-${suffix}`, firstName: 'Cee', lastName: suffix, status: 'ACTIVE', hireDate: new Date('2020-01-01') },
  });
  if (entityId) {
    await prisma.employmentRecord.create({
      data: {
        businessId, employeeId: emp.id, entityId, locationId: locationId || null,
        employmentType: 'FULL_TIME', workerCategory: 'STAFF',
        effectiveFrom: new Date('2020-01-01'), changeReason: 'HIRE', isCurrent: true,
      },
    });
  }
  return emp;
}

// The aggregate COMP_OFF balance for this employee. We resolve it through the credit's
// actual leaveBalanceId (the runner finalizes against the tenant's OLDEST COMP_OFF
// type via resolveCompOffType, which may differ from a per-finding `type`), so the
// lookup is robust to multiple COMP_OFF types existing across findings.
async function balanceFor(businessId, employeeId /* , leaveTypeId */) {
  const credit = await prisma.compOffCredit.findFirst({
    where: { businessId, employeeId, leaveBalanceId: { not: null } },
    orderBy: { createdAt: 'desc' }, select: { leaveBalanceId: true },
  });
  if (credit && credit.leaveBalanceId) return prisma.leaveBalance.findUnique({ where: { id: credit.leaveBalanceId } });
  // Fallback: the only COMP_OFF balance row for the employee.
  return prisma.leaveBalance.findFirst({ where: { businessId, employeeId, leaveType: { category: 'COMP_OFF' } } });
}
async function activeLotSum(businessId, employeeId) {
  const lots = await prisma.compOffCredit.findMany({ where: { businessId, employeeId, status: 'ACTIVE' }, select: { quantity: true, consumed: true } });
  return sumActiveRemaining(lots);
}

async function earnFor(businessId, employeeId, dateIso, { workedMinutes = 480, asOf, lookbackDays = 5 } = {}) {
  await prisma.attendance.create({
    data: { businessId, employeeId, date: dUTC(dateIso), status: 'HOLIDAY_WORKED', workedMinutes, lopFraction: 0 },
  });
  return runCompOffEarn({ businessId, asOf: asOf ? dUTC(asOf) : addDays(dUTC(dateIso), 1), lookbackDays });
}

async function availAndApprove(businessId, employeeId, leaveTypeId, startIso, endIso) {
  const apiUser = { id: 'op-1', businessId, employeeId: null };
  const res = await callController(leaveController.createRequest, { user: apiUser, body: { employeeId, leaveTypeId, startDate: startIso, endDate: endIso } });
  if (res.statusCode !== 201) return { res, appId: null };
  const appId = res.body.id;
  const apr = await callController(leaveController.approveRequest, { user: apiUser, scope: ALL_SCOPE, params: { id: appId } });
  return { res, apr, appId };
}

async function main() {
  log('\n=== Comp-off FIXES proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const entity = await prisma.entity.findFirst({ where: { businessId } });
  if (!entity) throw new Error('No seeded entity in hr_test');

  await cleanup(businessId);
  const apiUser = { id: 'op-1', businessId, employeeId: null };

  try {
    // ════════════════════════════════════════════════════════════════════════════
    // #1 — Withdraw after the source lot expired forfeits, no phantom balance.
    // ════════════════════════════════════════════════════════════════════════════
    log('(#1) Withdraw forfeits expired-lot units (no phantom spendable comp-off):');
    {
      const type = await setupType(businessId, '1');
      const emp = await mkEmployee(businessId, '1', { entityId: entity.id });
      // Earn a credit on 2026-04-05 → expires 2026-06-04.
      await earnFor(businessId, emp.id, '2026-04-05', { asOf: '2026-04-06' });
      const credit = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(credit && isoDay(credit.expiresOn) === '2026-06-04', `credit expires 2026-06-04 (got ${credit && isoDay(credit.expiresOn)})`);

      // Avail+approve a day BEFORE expiry → lot EXHAUSTED, closing 0/taken 1.
      const { apr } = await availAndApprove(businessId, emp.id, type.id, '2026-05-01', '2026-05-01');
      assert(apr.statusCode === 200, `avail+approve → 200 (got ${apr.statusCode})`);
      const lotAfter = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(lotAfter.status === 'EXHAUSTED' && Number(lotAfter.consumed) === 1, `lot EXHAUSTED, consumed 1 (got ${lotAfter.status}/${Number(lotAfter.consumed)})`);
      const app = await prisma.leaveTransaction.findFirst({ where: { businessId, employeeId: emp.id, txnType: 'APPLICATION' } });

      // Expire the lot by hand (simulating asOf past 06-04 — the runner hasn't lapsed it yet).
      // Now WITHDRAW the approved leave. Forfeit must kick in (lot expiresOn < now).
      const withdrawAsOf = new Date('2026-07-01T00:00:00.000Z'); // 6 set by Date.now in controller
      // The controller uses asOf = new Date() inside the seam; the lot 06-04 < today (2026+),
      // so it IS expired relative to the real clock → forfeit path exercised.
      const wr = await callController(leaveController.withdrawRequest, { user: apiUser, scope: ALL_SCOPE, params: { id: app.id } });
      assert(wr.statusCode === 200, `withdraw → 200 (got ${wr.statusCode}: ${JSON.stringify(wr.body && wr.body.message)})`);

      const bal = await balanceFor(businessId, emp.id, type.id);
      const lotSum = await activeLotSum(businessId, emp.id);
      assert(Number(bal.closing) === lotSum, `aggregate closing ${Number(bal.closing)} == Σ active-lot remaining ${lotSum} (NO phantom)`);
      assert(Number(bal.closing) === 0, `closing stays 0 (forfeited, not re-credited; got ${Number(bal.closing)})`);
      assert(Number(bal.lapsed) === 1, `forfeited 1.0 booked to lapsed (got ${Number(bal.lapsed)})`);
      const lotFinal = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(lotFinal.status === 'EXHAUSTED', `expired lot NOT resurrected to ACTIVE (got ${lotFinal.status})`);
      const txns = await prisma.leaveTransaction.findMany({ where: { businessId, leaveBalanceId: bal.id } });
      assert(ledger.reconciles({ closing: Number(bal.closing) }, txns), 'ledger reconstruction == persisted closing after forfeiting withdraw');
      void withdrawAsOf;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // #2 — Double-EARN impossible across a sourceKind FLIP (stable attendanceId key).
    // ════════════════════════════════════════════════════════════════════════════
    log('(#2) Double-earn impossible when holiday classification flips between passes:');
    {
      const type = await setupType(businessId, '2');
      const emp = await mkEmployee(businessId, '2', { entityId: entity.id });
      const worked = '2026-06-14'; // Sunday (weekly off), no holiday yet
      const r1 = await earnFor(businessId, emp.id, worked, { asOf: '2026-06-15' });
      assert(r1.minted === 1, `pass 1 mints 1 (WEEKLY_OFF; got ${r1.minted})`);
      const c1 = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(c1.sourceKind === 'WEEKLY_OFF', `pass-1 sourceKind WEEKLY_OFF (got ${c1.sourceKind})`);

      // HR imports a public holiday on 2026-06-14 AFTER pass 1 (classification flips).
      await prisma.holiday.create({
        data: { businessId, date: dUTC(worked), name: `${PREFIX} Late Holiday`, type: 'PUBLIC', countryCode: 'IN', scopeKey: '*:*' },
      });
      // Pass 2 (same window) — under the OLD (sourceDate,sourceKind) key this would mint a
      // SECOND credit (HOLIDAY). With the stable attendanceId key it must be a no-op.
      const r2 = await runCompOffEarn({ businessId, asOf: dUTC('2026-06-15'), lookbackDays: 5 });
      assert(r2.minted === 0, `pass 2 mints 0 despite the flip (got ${r2.minted})`);
      const count = await prisma.compOffCredit.count({ where: { businessId, employeeId: emp.id } });
      assert(count === 1, `still exactly 1 credit for the worked Sunday (got ${count})`);
      const bal = await balanceFor(businessId, emp.id, type.id);
      assert(Number(bal.closing) === 1, `closing stays 1 (no double-bump; got ${Number(bal.closing)})`);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // #3 — Earn holiday lookup is entity/location-scoped.
    //   Tenant: earnFromHoliday=false, earnFromWeeklyOff=true. A Chennai-only holiday
    //   on the date must NOT flip a Mumbai employee's sourceKind (which would drop the
    //   weekly-off credit they earned).
    // ════════════════════════════════════════════════════════════════════════════
    log('(#3) Earn holiday lookup scoped to the employee entity/location:');
    {
      const type = await setupType(businessId, '3', { earnFromHoliday: false, earnFromWeeklyOff: true });
      const mumbai = await prisma.location.create({ data: { businessId, entityId: entity.id, code: `${PREFIX}-MUM`, name: 'Mumbai', countryCode: 'IN', timezone: 'Asia/Kolkata' } });
      const chennai = await prisma.location.create({ data: { businessId, entityId: entity.id, code: `${PREFIX}-CHN`, name: 'Chennai', countryCode: 'IN', timezone: 'Asia/Kolkata' } });
      const emp = await mkEmployee(businessId, '3', { entityId: entity.id, locationId: mumbai.id });
      const worked = '2026-08-16'; // Sunday — Mumbai weekly off, no Mumbai holiday
      // A regional holiday for CHENNAI only on that date.
      await prisma.holiday.create({
        data: { businessId, date: dUTC(worked), name: `${PREFIX} Chennai Regional`, type: 'REGIONAL', countryCode: 'IN', entityId: entity.id, locationId: chennai.id, scopeKey: `${entity.id}:${chennai.id}` },
      });
      const r = await earnFor(businessId, emp.id, worked, { asOf: '2026-08-17' });
      // Unscoped lookup would have returned the Chennai holiday → HOLIDAY → earnFromHoliday=false → DROPPED.
      assert(r.minted === 1, `Mumbai weekly-off credit minted despite a Chennai-only holiday (got ${r.minted})`);
      const c = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(c && c.sourceKind === 'WEEKLY_OFF', `sourceKind WEEKLY_OFF (out-of-scope holiday ignored; got ${c && c.sourceKind})`);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // #4 — COMP_OFF_WOULD_BE_EXPIRED checks END / per-day, not just START.
    // ════════════════════════════════════════════════════════════════════════════
    log('(#4) Span ending after a lot expires mid-span is blocked:');
    {
      const type = await setupType(businessId, '4');
      const emp = await mkEmployee(businessId, '4', { entityId: entity.id });
      // A single 2.0-unit lot expiring Fri 2026-08-14 (HR grant, skipApproval → ACTIVE).
      const grant = await callController(compOffController.grantCredit, {
        user: apiUser,
        body: { employeeId: emp.id, quantity: 2, sourceDate: '2026-06-15', expiresOn: '2026-08-14', skipApproval: true, reason: `${PREFIX} grant` },
      });
      assert(grant.statusCode === 201, `2.0-unit grant → 201 (got ${grant.statusCode}: ${JSON.stringify(grant.body && grant.body.message)})`);
      const lot = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id } });
      assert(lot && lot.status === 'ACTIVE' && Number(lot.quantity) === 2 && isoDay(lot.expiresOn) === '2026-08-14', `ACTIVE 2.0 lot expiring 2026-08-14 (got ${lot && lot.status}/${lot && Number(lot.quantity)}/${lot && isoDay(lot.expiresOn)})`);

      // Span 2026-08-14 .. 2026-08-15 — 2 working days needing EXACTLY the 2.0 balance
      // (so INSUFFICIENT_BALANCE can't pre-empt the expiry gate). The START 08-14 ==
      // expiry (FINE — the old START-only gate PASSES this), but the SECOND charged day
      // 08-15 falls AFTER the 08-14 expiry → the per-day gate must block it (finding #4).
      const gate = await callController(leaveController.createRequest, {
        user: apiUser, body: { employeeId: emp.id, leaveTypeId: type.id, startDate: '2026-08-14', endDate: '2026-08-15' },
      });
      assert(gate.statusCode === 400 || gate.statusCode === 409, `span ending past expiry blocked (got ${gate.statusCode})`);
      assert(gate.body && gate.body.reason === 'COMP_OFF_WOULD_BE_EXPIRED', `reason COMP_OFF_WOULD_BE_EXPIRED (got ${gate.body && gate.body.reason})`);
      const gateErr = gate.body && gate.body.errors && gate.body.errors.find((e) => e.code === 'COMP_OFF_WOULD_BE_EXPIRED');
      assert(gateErr && gateErr.firstExpiredDay === '2026-08-15', `flags the first past-expiry day 08-15 (got ${gateErr && gateErr.firstExpiredDay})`);

      // Sanity: a span fully on/before expiry (08-13 .. 08-14, 2 working days, both <= 08-14) is allowed.
      const okRes = await callController(leaveController.createRequest, {
        user: apiUser, body: { employeeId: emp.id, leaveTypeId: type.id, startDate: '2026-08-13', endDate: '2026-08-14' },
      });
      assert(okRes.statusCode === 201, `span finishing on/before expiry allowed (got ${okRes.statusCode}: ${JSON.stringify(okRes.body && okRes.body.reason)})`);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // #5 — Withdraw re-credits EXACTLY the lots this leave debited.
    //   Two lots L1 (soon) + L2 (later). Avail A burns L1; avail B burns L2. Withdraw A
    //   must restore L1 (not L2), leaving B's lot L2 untouched.
    // ════════════════════════════════════════════════════════════════════════════
    log('(#5) Withdraw re-credits the EXACT debited lots:');
    {
      const type = await setupType(businessId, '5');
      const emp = await mkEmployee(businessId, '5', { entityId: entity.id });
      // L1 earned 2026-06-13 (Sat) → expires 2026-08-12 (soonest).
      await earnFor(businessId, emp.id, '2026-06-13', { asOf: '2026-06-14' });
      // L2 earned 2026-06-14 (Sun) → expires 2026-08-13 (later).
      await earnFor(businessId, emp.id, '2026-06-14', { asOf: '2026-06-15' });
      const L1 = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id, sourceDate: dUTC('2026-06-13') } });
      const L2 = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id, sourceDate: dUTC('2026-06-14') } });

      // Avail A (1 working day) → FIFO burns the SOONEST lot = L1.
      const A = await availAndApprove(businessId, emp.id, type.id, '2026-07-06', '2026-07-06');
      assert(A.apr.statusCode === 200, `avail A approve → 200 (got ${A.apr.statusCode})`);
      // Avail B (1 working day) → FIFO now burns L2 (L1 exhausted).
      const B = await availAndApprove(businessId, emp.id, type.id, '2026-07-07', '2026-07-07');
      assert(B.apr.statusCode === 200, `avail B approve → 200 (got ${B.apr.statusCode})`);

      const allocA = await prisma.compOffConsumption.findMany({ where: { businessId, leaveTransactionId: A.appId } });
      const allocB = await prisma.compOffConsumption.findMany({ where: { businessId, leaveTransactionId: B.appId } });
      assert(allocA.length === 1 && allocA[0].compOffCreditId === L1.id, `A's allocation persisted → L1 (got ${allocA.map((x) => x.compOffCreditId)})`);
      assert(allocB.length === 1 && allocB[0].compOffCreditId === L2.id, `B's allocation persisted → L2 (got ${allocB.map((x) => x.compOffCreditId)})`);

      // Withdraw A → must restore L1 (the lot A took), NOT L2 (B's lot).
      const wr = await callController(leaveController.withdrawRequest, { user: apiUser, scope: ALL_SCOPE, params: { id: A.appId } });
      assert(wr.statusCode === 200, `withdraw A → 200 (got ${wr.statusCode})`);
      const L1after = await prisma.compOffCredit.findUnique({ where: { id: L1.id } });
      const L2after = await prisma.compOffCredit.findUnique({ where: { id: L2.id } });
      assert(L1after.status === 'ACTIVE' && Number(L1after.consumed) === 0, `L1 restored to ACTIVE/consumed 0 (got ${L1after.status}/${Number(L1after.consumed)})`);
      assert(L2after.status === 'EXHAUSTED' && Number(L2after.consumed) === 1, `L2 (B's lot) UNTOUCHED — still EXHAUSTED/consumed 1 (got ${L2after.status}/${Number(L2after.consumed)})`);
      const bal = await balanceFor(businessId, emp.id, type.id);
      assert(Number(bal.closing) === (await activeLotSum(businessId, emp.id)), `closing == Σ active-lot remaining after exact re-credit (closing ${Number(bal.closing)})`);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // #6 — Void route respects F1 sub-tree scope (out-of-subtree → 404).
    // ════════════════════════════════════════════════════════════════════════════
    log('(#6) Void is F1-scoped (out-of-scope credit → 404, no burn):');
    {
      const type = await setupType(businessId, '6');
      const emp = await mkEmployee(businessId, '6', { entityId: entity.id });
      await earnFor(businessId, emp.id, '2026-06-14', { asOf: '2026-06-15' });
      const credit = await prisma.compOffCredit.findFirst({ where: { businessId, employeeId: emp.id, status: 'ACTIVE' } });
      assert(!!credit, 'an ACTIVE credit exists to void');

      // An operator whose scope EXCLUDES this employee → req.scope is an explicit IDS
      // set NOT containing emp.id. The controller's scopeAllows guard must 404.
      const outOfScope = { kind: 'IDS', ids: new Set(['someone-else']) };
      const denied = await callController(compOffController.voidActiveCredit, {
        user: apiUser, scope: outOfScope, params: { id: credit.id }, body: {},
      });
      assert(denied.statusCode === 404, `out-of-scope void → 404 (got ${denied.statusCode})`);
      const stillActive = await prisma.compOffCredit.findUnique({ where: { id: credit.id } });
      assert(stillActive.status === 'ACTIVE', `credit NOT burned by the denied void (got ${stillActive.status})`);
      const balBefore = await balanceFor(businessId, emp.id, type.id);
      assert(Number(balBefore.closing) === 1, `balance untouched (closing 1; got ${Number(balBefore.closing)})`);

      // In-scope void (ALL) → succeeds, burns the credit (proves the guard isn't a hard block).
      const allowed = await callController(compOffController.voidActiveCredit, {
        user: apiUser, scope: ALL_SCOPE, params: { id: credit.id }, body: { reason: 'fix-test' },
      });
      assert(allowed.statusCode === 200, `in-scope void → 200 (got ${allowed.statusCode}: ${JSON.stringify(allowed.body && allowed.body.message)})`);
      const voided = await prisma.compOffCredit.findUnique({ where: { id: credit.id } });
      assert(voided.status === 'VOIDED', `in-scope void burns the credit → VOIDED (got ${voided.status})`);
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL COMP-OFF FIX CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

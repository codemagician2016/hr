'use strict';

/*
 * lwp.flow.test.js — LIVE (hr_test) proof of Feature 16 (LWP + attendance-driven
 * proration), the §9 vertical:
 *
 *   - LWP applies with a ZERO balance (no LeaveBalance row, no soft-hold).
 *   - On APPROVAL, the eager leave→attendance bridge stamps ON_LEAVE rows with
 *     lopFraction=1 (LWP) → freeze rolls them into lopDays/lwpDays (NOT a balance
 *     debit, NOT flagged AWOL).
 *   - A PAID leave approval stamps ON_LEAVE rows with lopFraction=0 → NO LOP.
 *   - A retro LWP day on a LOCKED attendance row is NOT mutated (RETRO_LWP_DEFERRED).
 *   - freeze.rollupEmployee reconciles payable + lop = standard for the month.
 *
 * Plain-node (built-in assert, NO jest). Requires DATABASE_URL → hr_test:
 *   DATABASE_URL="$HR_URL" node src/hr/leave/__tests__/lwp.flow.test.js
 */

const assert = require('assert');
const prisma = require('../../../core/lib/prisma');
const leaveController = require('../../controllers/leave.controller');
const { freezeAttendance } = require('../../attendance/freeze');

const PREFIX = 'LWPFLOW-TEST';
const ALL_SCOPE = { kind: 'ALL' };
function log(s) { console.log(s); }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { this.body = this.body ?? null; return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const oj = res.json.bind(res); res.json = (p) => { const r = oj(p); done(); return r; };
    const oe = res.end.bind(res); res.end = () => { const r = oe(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

async function cleanup(businessId, empIds) {
  await prisma.attendance.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
  await prisma.leaveTransaction.deleteMany({ where: { businessId, leaveType: { code: { startsWith: PREFIX } } } });
  await prisma.leaveBalance.deleteMany({ where: { businessId, leaveType: { code: { startsWith: PREFIX } } } });
  await prisma.leavePolicy.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; log(`  PASS  ${name}`); }
  else { fail += 1; log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function main() {
  log('\n=== LWP flow proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  // Fixtures: an employee, an LWP (UNPAID, affectsLOP, NONE-accrual) type, and a
  // PAID type. No shift assignment → open-attendance (every span day is a working
  // day, so the bridge stamps each calendar day in the span). Clean any prior run
  // first (PREFIX-scoped), then build fresh.
  await cleanup(businessId, []);
  const empRow = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-E1`, firstName: 'Lop', lastName: 'Won', status: 'ACTIVE', hireDate: new Date('2020-01-01') },
  });
  const lwpType = await prisma.leaveType.create({
    data: { businessId, code: `${PREFIX}-LWP`, name: 'Flow LWP', category: 'UNPAID', unit: 'DAYS', isPaid: false, affectsLOP: true, sandwichPolicy: 'EXCLUSIVE' },
  });
  const paidType = await prisma.leaveType.create({
    data: { businessId, code: `${PREFIX}-PAID`, name: 'Flow Paid', category: 'CASUAL', unit: 'DAYS', isPaid: true, affectsLOP: false },
  });
  // A balance for the PAID type so it can be drawn; LWP gets NONE.
  const paidBal = await prisma.leaveBalance.create({
    data: { businessId, employeeId: empRow.id, leaveTypeId: paidType.id, periodCode: '2026-27', unit: 'DAYS', opening: '10.0000', accrued: '0', taken: '0', closing: '10.0000' },
  });

  const apiUser = { id: 'op-1', businessId, employeeId: null };

  try {
    // ── (1) LWP applies with NO balance + NO soft-hold ──────────────────────
    log('(1) LWP apply with zero balance:');
    let lwpAppId;
    {
      const req = { user: apiUser, body: { employeeId: empRow.id, leaveTypeId: lwpType.id, startDate: '2026-07-06', endDate: '2026-07-08', reason: `${PREFIX} lwp` } };
      const res = await callController(leaveController.createRequest, req);
      check('LWP apply → 201', res.statusCode === 201, `got ${res.statusCode}: ${JSON.stringify(res.body && res.body.message)}`);
      check('LWP txn carries NO leaveBalanceId', res.body && res.body.leaveBalanceId == null, `got ${res.body && res.body.leaveBalanceId}`);
      lwpAppId = res.body && res.body.id;
      // No LeaveBalance row exists for the LWP type at all.
      const lwpBalCount = await prisma.leaveBalance.count({ where: { businessId, employeeId: empRow.id, leaveTypeId: lwpType.id } });
      check('no LeaveBalance row for LWP type', lwpBalCount === 0, `got ${lwpBalCount}`);
    }

    // ── (2) approve LWP → eager bridge stamps ON_LEAVE lopFraction 1 ────────
    log('(2) approve LWP → ON_LEAVE LOP days materialised:');
    {
      const req = { user: apiUser, scope: ALL_SCOPE, params: { id: lwpAppId } };
      const res = await callController(leaveController.approveRequest, req);
      check('LWP approve → 200', res.statusCode === 200, `got ${res.statusCode}`);
      const att = await prisma.attendance.findMany({
        where: { businessId, employeeId: empRow.id, date: { gte: new Date('2026-07-06'), lte: new Date('2026-07-08') } },
        orderBy: { date: 'asc' },
      });
      check('3 ON_LEAVE attendance rows stamped', att.length === 3 && att.every((a) => a.status === 'ON_LEAVE'), `got ${att.length}`);
      check('each LWP day lopFraction = 1', att.every((a) => Number(a.lopFraction) === 1));
      // LWP is NOT an AWOL absence (status is ON_LEAVE, carries the approval audit).
      check('LWP days are NOT status ABSENT', att.every((a) => a.status !== 'ABSENT'));
      // No LeaveBalance was debited (still none exists).
      const lwpBalCount = await prisma.leaveBalance.count({ where: { businessId, employeeId: empRow.id, leaveTypeId: lwpType.id } });
      check('LWP approval did NOT create/debit a balance', lwpBalCount === 0, `got ${lwpBalCount}`);
    }

    // ── (3) PAID leave approval → ON_LEAVE lopFraction 0 (no LOP) ───────────
    log('(3) approve a PAID leave → NO LOP:');
    {
      const apply = { user: apiUser, body: { employeeId: empRow.id, leaveTypeId: paidType.id, startDate: '2026-07-20', endDate: '2026-07-21', reason: `${PREFIX} paid` } };
      const aRes = await callController(leaveController.createRequest, apply);
      check('paid apply → 201', aRes.statusCode === 201, `got ${aRes.statusCode}: ${JSON.stringify(aRes.body && aRes.body.message)}`);
      const appId = aRes.body && aRes.body.id;
      const appr = { user: apiUser, scope: ALL_SCOPE, params: { id: appId } };
      const apRes = await callController(leaveController.approveRequest, appr);
      check('paid approve → 200', apRes.statusCode === 200, `got ${apRes.statusCode}`);
      const att = await prisma.attendance.findMany({
        where: { businessId, employeeId: empRow.id, date: { gte: new Date('2026-07-20'), lte: new Date('2026-07-21') } },
      });
      check('paid leave stamped ON_LEAVE with lopFraction 0', att.length === 2 && att.every((a) => a.status === 'ON_LEAVE' && Number(a.lopFraction) === 0), `got ${JSON.stringify(att.map((a) => [a.status, Number(a.lopFraction)]))}`);
      // Paid balance WAS debited (closing 10 → 8).
      const fresh = await prisma.leaveBalance.findUnique({ where: { id: paidBal.id } });
      check('paid leave debited the balance (closing 8)', Number(fresh.closing) === 8, `got ${Number(fresh.closing)}`);
    }

    // ── (4) retro LWP onto a LOCKED day is NOT mutated (RETRO_LWP_DEFERRED) ──
    log('(4) retro LWP onto a frozen day is deferred:');
    {
      // Pre-create a LOCKED (frozen) PRESENT day on 2026-08-10.
      await prisma.attendance.create({
        data: { businessId, employeeId: empRow.id, date: new Date('2026-08-10'), status: 'PRESENT', lopFraction: 0, isLocked: true },
      });
      const apply = { user: apiUser, body: { employeeId: empRow.id, leaveTypeId: lwpType.id, startDate: '2026-08-10', endDate: '2026-08-10', reason: `${PREFIX} retro` } };
      const aRes = await callController(leaveController.createRequest, apply);
      const appId = aRes.body && aRes.body.id;
      const apr = { user: apiUser, scope: ALL_SCOPE, params: { id: appId } };
      await callController(leaveController.approveRequest, apr);
      const frozen = await prisma.attendance.findFirst({ where: { businessId, employeeId: empRow.id, date: new Date('2026-08-10') } });
      check('frozen day untouched (still PRESENT, lopFraction 0, locked)', frozen.status === 'PRESENT' && Number(frozen.lopFraction) === 0 && frozen.isLocked === true,
        `got ${frozen.status}/${Number(frozen.lopFraction)}/${frozen.isLocked}`);
    }

    // ── (5) freeze rollup reconciles payable + lop = standard ───────────────
    log('(5) freeze rollup reconciles the LWP LOP into the pay input:');
    {
      // Build a July run window; we already have 3 LWP LOP days + 2 paid (lop 0).
      const payRun = await prisma.payRun.findFirst({ where: { businessId } });
      // Use a throwaway payRunId reference via an existing run row to satisfy FK; if
      // none exists, skip the persistence and just assert the pure rollup.
      const rows = await prisma.attendance.findMany({
        where: { businessId, employeeId: empRow.id, date: { gte: new Date('2026-07-01'), lte: new Date('2026-07-31') } },
        select: { id: true, status: true, lopFraction: true, exceptionsJson: true },
      });
      const { _internals } = require('../../attendance/freeze');
      const roll = _internals.rollupEmployee(rows, '2026-07-01', '2026-07-31', { prorationBasis: 'CALENDAR_DAYS' });
      check('rollup lopDays = 3 (LWP only; paid leave is lop 0)', roll.lopDays === 3, `got ${roll.lopDays}`);
      check('rollup lwpDays = 3', roll.lwpDays === 3, `got ${roll.lwpDays}`);
      check('rollup absentDays = 0 (none AWOL)', roll.absentDays === 0, `got ${roll.absentDays}`);
      check('rollup standardDays = 31 (July)', roll.standardDays === 31, `got ${roll.standardDays}`);
      check('reconcile payable + lop = standard', roll.payableDays + roll.lopDays === roll.standardDays, `${roll.payableDays}+${roll.lopDays} vs ${roll.standardDays}`);
      void payRun; void freezeAttendance;
    }

    // ── (6) config gates: coherence + statutory floor + LWP no-entitlement ──
    log('(6) leave-config coherence + India statutory-floor gates:');
    {
      // (a) A PAID type that also affects LOP is incoherent.
      const bad = { user: apiUser, body: { code: `${PREFIX}-BAD`, name: 'Bad', category: 'CASUAL', isPaid: true, affectsLOP: true } };
      const r1 = await callController(leaveController.leaveTypes.create, bad);
      check('paid + affectsLOP type → 422 INCOHERENT_LEAVE_TYPE', r1.statusCode === 422 && r1.body && r1.body.reason === 'INCOHERENT_LEAVE_TYPE', `got ${r1.statusCode}/${r1.body && r1.body.reason}`);

      // (b) UNPAID type is server-forced isPaid=false + affectsLOP=true.
      const unpaid = { user: apiUser, body: { code: `${PREFIX}-U`, name: 'Unpaid', category: 'UNPAID', isPaid: true, affectsLOP: false } };
      const r2 = await callController(leaveController.leaveTypes.create, unpaid);
      check('UNPAID type created with forced flags', r2.statusCode === 201 && r2.body.isPaid === false && r2.body.affectsLOP === true, `got ${r2.statusCode}/${r2.body && r2.body.isPaid}/${r2.body && r2.body.affectsLOP}`);

      // (c) An EL policy below the KA floor (EL ≥ 18) on the IN entity is rejected.
      const inEntity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' }, select: { id: true, stateCode: true } });
      const elType = await prisma.leaveType.create({ data: { businessId, code: `${PREFIX}-EL`, name: 'Floor EL', category: 'ANNUAL', unit: 'DAYS', isPaid: true } });
      const floor = require('../../payroll/compliance/india').resolveLeaveFloor(inEntity && inEntity.stateCode, 'EL', new Date().toISOString().slice(0, 10));
      const below = { user: apiUser, body: { leaveTypeId: elType.id, entityId: inEntity && inEntity.id, code: `${PREFIX}-ELP`, name: 'EL below floor', accrualMethod: 'MONTHLY_ACCRUAL', entitlementPerYear: Math.max(0, (floor || 18) - 5) } };
      const r3 = await callController(leaveController.leavePolicies.create, below);
      check(`EL policy below floor (${floor}) → 422 LEAVE_BELOW_STATUTORY_FLOOR`, r3.statusCode === 422 && r3.body && r3.body.reason === 'LEAVE_BELOW_STATUTORY_FLOOR', `got ${r3.statusCode}/${r3.body && r3.body.reason}`);

      // (d) An EL policy AT/above the floor is accepted + stamps the floor.
      const atFloor = { user: apiUser, body: { leaveTypeId: elType.id, entityId: inEntity && inEntity.id, code: `${PREFIX}-ELP2`, name: 'EL at floor', accrualMethod: 'MONTHLY_ACCRUAL', entitlementPerYear: (floor || 18) + 2 } };
      const r4 = await callController(leaveController.leavePolicies.create, atFloor);
      check('EL policy above floor → 201 + floor stamped', r4.statusCode === 201 && Number(r4.body.statutoryFloorPerYear) === Number(floor), `got ${r4.statusCode}/${r4.body && r4.body.statutoryFloorPerYear}`);

      // (e) An LWP policy WITH an entitlement is rejected (LWP_NO_ENTITLEMENT).
      const lwpPol = { user: apiUser, body: { leaveTypeId: lwpType.id, code: `${PREFIX}-LWPP`, name: 'LWP pol', accrualMethod: 'NONE', entitlementPerYear: 5 } };
      const r5 = await callController(leaveController.leavePolicies.create, lwpPol);
      check('LWP policy with entitlement → 422 LWP_NO_ENTITLEMENT', r5.statusCode === 422 && r5.body && r5.body.reason === 'LWP_NO_ENTITLEMENT', `got ${r5.statusCode}/${r5.body && r5.body.reason}`);

      // (f) statutory-framework read endpoint returns resolved floors.
      const r6 = await callController(leaveController.getStatutoryFramework, { user: apiUser, query: { stateCode: 'MH' } });
      check('GET statutory-framework MH → EL 21', r6.statusCode === 200 && r6.body && r6.body.floors && r6.body.floors.EL === 21, `got ${r6.statusCode}/${r6.body && JSON.stringify(r6.body.floors)}`);
    }

    log(`\nlwp.flow: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
    log('=== ALL LWP-FLOW CHECKS PASSED ===');
  } finally {
    await cleanup(businessId, [empRow.id]);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

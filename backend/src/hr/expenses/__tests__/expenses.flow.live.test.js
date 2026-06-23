'use strict';

/**
 * expenses.flow.live.test.js — Feature 11 integration proof against LIVE hr_test.
 * Plain-node + fake-res harness (same as expense.engine.test.js). Drives the REAL
 * controllers (ESS meExpenses + operator claims/trips/policy + the F13 me/team decide)
 * to prove the owner's must-haves end-to-end:
 *
 *   (A) A claim mints a human EXP-#### claim id and routes through the F10 EXPENSE
 *       chain: a small claim → manager-only; a manager (the team's manager) approves
 *       via the F13 /me/team decide → claim APPROVED. An over-threshold claim adds the
 *       HR/finance step (manager approve does NOT terminate; HR approve does).
 *   (B) SoD: the requester can never approve their own claim (403 from the engine).
 *   (C) A travel request mints a TRV-#### travel id; a bill links to it (claimType
 *       TRAVEL, travelRequestId set).
 *   (D) Policy auto-validation: with an active policy, a hotel bill over the level×tier
 *       cap is FLAGGED on add (FLAG mode); a flight under the min journey hours is
 *       AUTO_REJECTED and BLOCKS submit under HARD enforcement.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/expenses/__tests__/expenses.flow.live.test.js
 */

const prisma = require('../../../core/lib/prisma');
const me = require('../meExpenses.controller');
const claimsC = require('../claims.controller');
const policyC = require('../policy.controller');
const meTeam = require('../../profile/meTeam.controller');
require('../../approvals/registerConsumers');
const { EXPENSE_HR_THRESHOLD } = require('../../approvals/workflowResolver');
const { usersWithPermission } = require('../../approvals/approverResolver');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { this.body = this.body || {}; return this; },
  };
}
function call(handler, req) {
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

const PREFIX = 'F11FLOW';

async function cleanup(businessId) {
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { entityType: { in: ['ExpenseClaim', 'TravelRequest'] }, requester: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  await prisma.approvalRequest.deleteMany({ where: { businessId, requester: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.expenseClaimLine.deleteMany({ where: { businessId, claim: { employee: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  await prisma.expenseClaim.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelRequest.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelTransportRule.deleteMany({ where: { businessId, policy: { name: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelHotelRule.deleteMany({ where: { businessId, policy: { name: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelPerDiemRule.deleteMany({ where: { businessId, policy: { name: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelPolicy.deleteMany({ where: { businessId, name: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.expenseCategory.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.grade.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.numberSequence.deleteMany({ where: { businessId, scope: { in: ['EXP', 'TRV'] }, prefix: { in: ['EXP-', 'TRV-'] }, entityId: null, periodKey: null } }).catch(() => {});
  await prisma.employmentRecord.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null, currentEmploymentRecordId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.user.updateMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } }, data: { businessRoleId: null } });
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } });
  await prisma.businessRole.deleteMany({ where: { businessId, name: { startsWith: PREFIX } } }).catch(() => {});
}

let seq = 0;
let ENTITY_ID = null;
async function mkUserEmp(businessId, name, { managerEmployeeId = null, gradeId = null } = {}) {
  seq += 1;
  const email = `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`;
  const user = await prisma.user.create({ data: { businessId, email, password: 'x', name, role: 'USER', isActive: true } });
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status: 'ACTIVE', isActive: true, userId: user.id, managerEmployeeId, workEmail: email, hireDate: new Date('2020-01-01') },
  });
  // The employee LEVEL lives on the current EmploymentRecord (gradeId) — create one
  // so the policy engine can resolve the hotel/transport level for this person.
  if (gradeId) {
    await prisma.employmentRecord.create({
      data: {
        business: { connect: { id: businessId } },
        entity: { connect: { id: ENTITY_ID } },
        employee: { connect: { id: emp.id } },
        gradeId,
        isCurrent: true, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: new Date('2020-01-01'),
      },
    });
  }
  return { user, emp, email };
}

async function main() {
  log('\n=== Feature 11 reimbursement/travel flow proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const ent = await prisma.entity.findFirst({ where: { businessId }, select: { id: true } });
  ENTITY_ID = ent ? ent.id : null;
  await cleanup(businessId);

  const hrUsers = await usersWithPermission(businessId, 'canApproveLeave');
  if (hrUsers.length === 0) throw new Error('demo tenant has no HR approver (canApproveLeave)');

  try {
    const grade = await prisma.grade.create({ data: { businessId, code: `${PREFIX}-G3`, name: 'L3', rank: 3 } });
    // A Manager businessRole with the TEAM band so the F13 /me/team path resolves the
    // manager's reporting sub-tree (exactly the production Manager preset).
    const mgrRole = await prisma.businessRole.create({
      data: { businessId, name: `${PREFIX}-Manager`, defaultScope: 'TEAM', permissions: { canViewEmployees: true, canApproveLeave: true, canApproveExpense: true } },
    });
    const mgr = await mkUserEmp(businessId, 'Mgr');
    await prisma.user.update({ where: { id: mgr.user.id }, data: { businessRoleId: mgrRole.id } });
    const ic = await mkUserEmp(businessId, 'Ic', { managerEmployeeId: mgr.emp.id, gradeId: grade.id });
    const cat = await prisma.expenseCategory.create({ data: { businessId, code: `${PREFIX}-TRV`, name: 'Travel' } });

    const icCustomer = { customer: { businessId, email: ic.email }, body: {}, query: {}, params: {} };
    const mgrTeamReq = (body, params) => ({ customer: { businessId, email: mgr.email }, body, params });

    // ── (A) standalone claim mints EXP-#### + routes through the manager chain ──
    log('(A) standalone reimbursement → EXP id + F10 chain (manager approves via /me/team):');
    {
      const created = await call(me.createClaim, { ...icCustomer, body: { categoryId: cat.id, description: 'Cab to airport' } });
      assert(created.statusCode === 201, `create claim → 201 (got ${created.statusCode})`);
      const claimId = created.body.id;
      assert(/^EXP-\d{4,}$/.test(created.body.claimNumber), `minted a human EXP-#### claim id (got ${created.body.claimNumber})`);

      const lineRes = await call(me.addLine, { ...icCustomer, body: { amount: 800, categoryId: cat.id, description: 'Cab' }, params: { id: claimId } });
      assert(lineRes.statusCode === 201, `add bill line → 201 (got ${lineRes.statusCode})`);

      const sub = await call(me.submitClaim, { ...icCustomer, params: { id: claimId } });
      assert(sub.statusCode === 200 && sub.body.status === 'SUBMITTED', `submit → SUBMITTED (got ${sub.statusCode}/${sub.body && sub.body.status})`);

      const ar = await prisma.approvalRequest.findFirst({ where: { businessId, module: 'EXPENSE', entityType: 'ExpenseClaim', entityId: claimId } });
      assert(ar && ar.status === 'PENDING', `F10 EXPENSE request opened PENDING (got ${ar && ar.status})`);
      const active = ar && ar.payloadJson && ar.payloadJson._active;
      assert(active && active.approverUserIds.includes(mgr.user.id), `routed to the team manager (active=${JSON.stringify(active && active.approverUserIds)})`);

      // the claim appears in the manager's F13 /me/team reimbursements/pending
      const pending = await call(meTeam.reimbursementsPending, mgrTeamReq({}, {}));
      const inPending = (pending.body.items || []).some((i) => i.id === claimId);
      assert(inPending, 'claim appears in the manager F13 /me/team reimbursements/pending');

      // manager approves via F13 decide → drives the engine → claim APPROVED
      const dec = await call(meTeam.reimbursementDecide, mgrTeamReq({ decision: 'approve' }, { id: claimId }));
      assert(dec.statusCode === 200 && dec.body.status === 'APPROVED', `manager approve via /me/team → APPROVED (got ${dec.statusCode}/${dec.body && dec.body.status})`);
      const arDone = await prisma.approvalRequest.findFirst({ where: { businessId, entityId: claimId } });
      assert(arDone.status === 'APPROVED', `F10 request APPROVED after the single manager step (got ${arDone.status})`);
    }

    // ── (A2) over-threshold claim adds the finance/HR step ──
    log(`(A2) over-threshold claim (> ${EXPENSE_HR_THRESHOLD}) → manager THEN HR:`);
    {
      const created = await call(me.createClaim, { ...icCustomer, body: { categoryId: cat.id } });
      const claimId = created.body.id;
      await call(me.addLine, { ...icCustomer, body: { amount: EXPENSE_HR_THRESHOLD + 10000, categoryId: cat.id }, params: { id: claimId } });
      await call(me.submitClaim, { ...icCustomer, params: { id: claimId } });

      // manager approves → chain advances to HR, claim NOT yet approved
      const dec1 = await call(meTeam.reimbursementDecide, mgrTeamReq({ decision: 'approve' }, { id: claimId }));
      const c1 = await prisma.expenseClaim.findUnique({ where: { id: claimId } });
      assert(c1.status === 'SUBMITTED', `claim still SUBMITTED after manager (chain advanced to HR; got ${c1.status})`);
      const arMid = await prisma.approvalRequest.findFirst({ where: { businessId, entityId: claimId } });
      assert(arMid.status === 'PENDING' && arMid.currentStepOrder === 2, `F10 request advanced to the HR step (status ${arMid.status}, step ${arMid.currentStepOrder})`);

      // HR approves (operator path) → claim APPROVED
      const hrActor = { user: { id: hrUsers[0], businessId, employeeId: null, role: 'BUSINESS_ADMIN' }, params: { id: claimId }, body: {} };
      const appr2 = await call(claimsC.approve, hrActor);
      assert(appr2.statusCode === 200 && appr2.body.status === 'APPROVED', `HR approve → claim APPROVED (got ${appr2.statusCode}/${appr2.body && appr2.body.status})`);
    }

    // ── (B) SoD: the requester cannot approve their own claim ──
    log('(B) SoD: requester cannot approve their own claim:');
    {
      const created = await call(me.createClaim, { ...icCustomer, body: { categoryId: cat.id } });
      const claimId = created.body.id;
      await call(me.addLine, { ...icCustomer, body: { amount: 500, categoryId: cat.id }, params: { id: claimId } });
      await call(me.submitClaim, { ...icCustomer, params: { id: claimId } });
      // The IC (requester) tries to approve as an operator → engine SoD 403.
      const icActor = { user: { id: ic.user.id, businessId, employeeId: ic.emp.id, role: 'USER', businessRole: { permissions: { canApproveExpense: true, canViewEmployees: true }, defaultScope: 'ALL' } }, params: { id: claimId }, body: {} };
      const selfAppr = await call(claimsC.approve, icActor);
      assert(selfAppr.statusCode === 403, `requester self-approve → 403 (got ${selfAppr.statusCode}: ${selfAppr.body && selfAppr.body.message})`);
      // cancel to clean up the open request
      await call(me.cancelClaim, { ...icCustomer, params: { id: claimId } });
    }

    // ── (C) travel id minted + bills link to it ──
    log('(C) travel request mints TRV-#### + a bill links to it:');
    {
      const trip = await call(me.createTrip, { ...icCustomer, body: { purpose: 'Client visit Mumbai', destCity: 'Mumbai', startAt: '2026-07-01T09:00:00Z', endAt: '2026-07-03T18:00:00Z', isOutdoorDuty: false } });
      assert(trip.statusCode === 201, `create trip → 201 (got ${trip.statusCode})`);
      assert(/^TRV-\d{4,}$/.test(trip.body.travelNumber), `minted a human TRV-#### travel id (got ${trip.body.travelNumber})`);
      const tripId = trip.body.id;

      const subTrip = await call(me.submitTrip, { ...icCustomer, params: { id: tripId } });
      assert(subTrip.statusCode === 200 && subTrip.body.status === 'SUBMITTED', `submit trip → SUBMITTED (got ${subTrip.statusCode}/${subTrip.body && subTrip.body.status})`);
      const tar = await prisma.approvalRequest.findFirst({ where: { businessId, module: 'TRAVEL', entityType: 'TravelRequest', entityId: tripId } });
      assert(tar && tar.status === 'PENDING', `F10 TRAVEL request opened PENDING (got ${tar && tar.status})`);

      // a bill booked against the travel id
      const billClaim = await call(me.createClaim, { ...icCustomer, body: { travelRequestId: tripId, categoryId: cat.id } });
      assert(billClaim.statusCode === 201 && billClaim.body.claimType === 'TRAVEL' && billClaim.body.travelRequestId === tripId,
        `bill claim linked to the travel id (type=${billClaim.body.claimType}, travelRequestId=${billClaim.body.travelRequestId === tripId})`);
    }

    // ── (D) policy auto-validation: hotel over budget FLAGGED; flight <minHrs HARD-blocks submit ──
    log('(D) policy auto-validation (hotel over level×tier cap → FLAGGED; flight < min hours under HARD → blocked):');
    {
      // FLAG policy: hotel L3 TIER_1 cap 7000/night.
      const policy = await prisma.travelPolicy.create({
        data: { businessId, name: `${PREFIX} IN policy`, countryCode: 'IN', currencyCode: 'INR', isActive: true, effectiveFrom: new Date('2026-01-01'), defaultTier: 'TIER_3', enforcement: 'FLAG',
          hotelRules: { create: [{ businessId, gradeRank: 3, cityTier: 'TIER_1', nightlyCap: '7000' }] },
          transportRules: { create: [{ businessId, mode: 'FLIGHT', gradeRank: 3, allowed: true, fareCap: '15000', minJourneyHrs: 12 }] },
        },
      });
      await prisma.cityTier.upsert({ where: { businessId_countryCode_city: { businessId, countryCode: 'IN', city: 'mumbai' } }, update: { tier: 'TIER_1' }, create: { businessId, countryCode: 'IN', city: 'mumbai', tier: 'TIER_1' } });

      // a trip to Mumbai (TIER_1), short 4h journey
      const trip = await call(me.createTrip, { ...icCustomer, body: { purpose: 'Mumbai', destCity: 'Mumbai', startAt: '2026-08-01T09:00:00Z', endAt: '2026-08-01T13:00:00Z' } });
      const tripId = trip.body.id;
      const tripRow = await prisma.travelRequest.findUnique({ where: { id: tripId } });
      assert(tripRow.destTier === 'TIER_1', `trip resolved Mumbai → TIER_1 (got ${tripRow.destTier})`);

      const billClaim = await call(me.createClaim, { ...icCustomer, body: { travelRequestId: tripId } });
      const claimId = billClaim.body.id;

      // hotel 9000/night × 1 > 7000 cap → FLAGGED on add
      const hotelLine = await call(me.addLine, { ...icCustomer, body: { amount: 9000, nights: 1, description: 'Hotel' }, params: { id: claimId } });
      assert(hotelLine.body.verdict.verdict === 'FLAGGED', `hotel over level×tier cap → FLAGGED on add (got ${hotelLine.body.verdict.verdict}: ${hotelLine.body.verdict.reason})`);

      // flight on a 4h journey (< 12h min) → AUTO_REJECTED on add
      const flightLine = await call(me.addLine, { ...icCustomer, body: { amount: 6000, transportMode: 'FLIGHT', description: 'Flight' }, params: { id: claimId } });
      assert(flightLine.body.verdict.verdict === 'AUTO_REJECTED', `flight under min journey hours → AUTO_REJECTED (got ${flightLine.body.verdict.verdict}: ${flightLine.body.verdict.reason})`);

      // Under FLAG enforcement, submit SUCCEEDS (the flagged + auto-rejected lines surface to the approver),
      // BUT switch to HARD and submit must be blocked.
      await prisma.travelPolicy.update({ where: { id: policy.id }, data: { enforcement: 'HARD' } });
      const subHard = await call(me.submitClaim, { ...icCustomer, params: { id: claimId } });
      assert(subHard.statusCode === 400 && subHard.body.reason === 'POLICY_HARD_BLOCK', `HARD enforcement blocks submit of an over-hard-cap bill (got ${subHard.statusCode}/${subHard.body && subHard.body.reason})`);
      assert((subHard.body.blockers || []).length >= 1, `the block lists the offending line(s) (got ${(subHard.body.blockers || []).length})`);
    }

    // ── (E) operator policy preview (dry-run engine) ──
    log('(E) operator policy preview dry-run:');
    {
      const operator = { user: { id: hrUsers[0], businessId, role: 'BUSINESS_ADMIN' }, body: { destCity: 'Mumbai', countryCode: 'IN', gradeRank: 3, lines: [{ amount: 9000, nights: 1 }] } };
      const prev = await call(policyC.preview, operator);
      assert(prev.statusCode === 200 && prev.body.cityTier === 'TIER_1', `preview resolved Mumbai → TIER_1 (got ${prev.body && prev.body.cityTier})`);
      assert(prev.body.lines[0].verdict !== 'OK', `preview flags the over-cap hotel line (got ${prev.body.lines[0].verdict})`);
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL FEATURE-11 FLOW CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

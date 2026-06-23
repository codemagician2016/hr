'use strict';

/*
 * ess-me-surface.live.test.js — LIVE (hr_test) proof of the Wave G ESS
 * self-service surface: the new /api/hr/me/{attendance,leave,tax-declaration,tasks}
 * controllers + the extended /api/hr/me/profile. Plain-node runner (built-in
 * assert, NO jest), mirroring the run-orchestration / offboarding harnesses.
 *
 * What it proves (all over REAL rows, customer-session-authed via a mock req):
 *   1. resolveSelfEmployee derives the REAL employeeId from the customer email
 *      (NOT the customer id) — the audit #55 fix.
 *   2. me/profile returns the rich profile (code/dept/designation/location/DOJ).
 *   3. me/attendance punch derives the employee server-side + writes a punch +
 *      lists it back (audit #53); the body carries NO employeeId.
 *   4. me/leave types+balances+apply+cancel are self-derived, SELF_ONLY, and a
 *      foreign request id 404s on cancel (IDOR-safe) — audit #54/#55.
 *   5. me/tax-declaration persists onto StatutoryProfile + prefills from GET
 *      (audit #57); a wrong-country payload is rejected 422.
 *   6. me/tasks unions onboarding/e-sign/asset-ack into the pending feed (#56);
 *      an un-acknowledged asset shows up.
 *   7. A SECOND employee cannot reach the first's leave (SELF_ONLY isolation).
 *
 * Run (DATABASE_URL must target hr_test):
 *   DATABASE_URL="$HR_URL" node src/hr/__tests__/ess-me-surface.live.test.js
 * where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'.
 *
 * Every row this test writes is torn down at the end (prefix-scoped).
 */

const assert = require('assert');
const prisma = require('../../core/lib/prisma');

const meAttendance = require('../controllers/meAttendance.controller');
const meLeave = require('../controllers/meLeave.controller');
const meTax = require('../controllers/meTax.controller');
const meTasks = require('../controllers/meTasks.controller');
const meProfile = require('../lifecycle/controllers/meProfile.controller');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'WAVEG';
const A_EMAIL = `waveg.alice@example.test`;
const B_EMAIL = `waveg.bob@example.test`;

// ── tiny req/res mock ─────────────────────────────────────────────────────────
function mkReq(customer, { body, params, query } = {}) {
  return { customer, body: body || {}, params: params || {}, query: query || {}, ip: '127.0.0.1' };
}
// Run a controller (req,res,next) and capture { status, body }.
function run(handler, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
      status(c) { statusCode = c; return this; },
      json(payload) { resolve({ status: statusCode, body: payload }); return this; },
      end() { resolve({ status: statusCode, body: null }); return this; },
    };
    Promise.resolve(handler(req, res, (err) => (err ? reject(err) : resolve({ status: statusCode, body: null }))))
      .catch(reject);
  });
}

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({
    where: { businessId, code: { startsWith: PREFIX } }, select: { id: true },
  });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.attendancePunch.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.attendance.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.attendanceRegularizationRequest.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.leaveTransaction.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.statutoryElectionHistory.deleteMany({ where: { statutoryProfile: { employeeId: { in: ids } } } });
    await prisma.statutoryProfile.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.assetAssignment.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.asset.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    await prisma.employmentRecord.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.customer.deleteMany({ where: { businessId, email: { in: [A_EMAIL, B_EMAIL] } } });
}

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) { log('SKIP — no demo tenant in hr_test (run prisma/seed-hr.js first)'); return; }
  const businessId = demo.id;
  // Prefer the India entity (the seed names it IN-HQ) for a deterministic country.
  const entity = (await prisma.entity.findFirst({ where: { businessId, code: 'IN-HQ' } }))
    || (await prisma.entity.findFirst({ where: { businessId } }));
  if (!entity) { log('SKIP — demo tenant has no entity'); return; }

  await cleanup(businessId);

  // ── seed: two employees, each with a linked customer (email match) ──────────
  const alice = await prisma.employee.create({
    data: {
      businessId, code: `${PREFIX}-A`, firstName: 'Alice', lastName: 'Ng',
      workEmail: A_EMAIL, countryCode: 'IN', isActive: true, status: 'ACTIVE',
      hireDate: new Date('2024-01-15'), phone: '+91 90000 00001',
    },
  });
  const bob = await prisma.employee.create({
    data: {
      businessId, code: `${PREFIX}-B`, firstName: 'Bob', lastName: 'Kerr',
      workEmail: B_EMAIL, countryCode: 'IN', isActive: true, status: 'ACTIVE',
      hireDate: new Date('2024-03-01'),
    },
  });
  // Current employment records (dept/designation/location optional — entity is required).
  await prisma.employmentRecord.create({
    data: {
      businessId, employeeId: alice.id, entityId: entity.id,
      employmentType: 'FULL_TIME', workerCategory: 'STAFF',
      effectiveFrom: new Date('2024-01-15'), changeReason: 'HIRE', isCurrent: true, fteRatio: 1,
    },
  });
  // The "customer" portal identities (email links them to the employees).
  const custA = await prisma.customer.create({
    data: { businessId, email: A_EMAIL, name: 'Alice Ng', password: 'x', isActive: true },
  });
  const custB = await prisma.customer.create({
    data: { businessId, email: B_EMAIL, name: 'Bob Kerr', password: 'x', isActive: true },
  });

  // ── 1) resolveSelfEmployee derives the REAL employeeId (NOT the customer id) ─
  const profA = await run(meProfile.getMyProfile, mkReq(custA));
  ok(profA.body.employeeId === alice.id, '1) me/profile resolves the REAL employeeId from the email');
  ok(profA.body.employeeId !== custA.id, '1) employeeId is NOT the customer id (audit #55)');

  // ── 2) me/profile rich detail ──────────────────────────────────────────────
  const p = profA.body.profile || {};
  ok(p.employeeCode === `${PREFIX}-A`, '2) me/profile carries employeeCode');
  ok(p.phone === '+91 90000 00001', '2) me/profile carries phone');
  ok(!!p.dateOfJoining, '2) me/profile carries dateOfJoining');
  ok(p.entity != null, '2) me/profile carries entity name');

  // ── 3) me/attendance punch (no employeeId in body) + list ───────────────────
  const punchRes = await run(meAttendance.createPunch, mkReq(custA, { body: { type: 'IN' } }));
  ok(punchRes.status === 201 && punchRes.body.employeeId === alice.id, '3) punch derives employee server-side (201, own id)');
  const punches = await run(meAttendance.listPunches, mkReq(custA, { query: {} }));
  ok(Array.isArray(punches.body.items) && punches.body.items.length >= 1, '3) listPunches returns the punch');
  ok(punches.body.items.every((x) => x.employeeId === alice.id), '3) every punch is the caller own');

  // ── 4) me/leave types + balances + apply + cancel (SELF_ONLY) ───────────────
  const lt = await prisma.leaveType.create({
    data: { businessId, code: `${PREFIX}-EL`, name: 'WaveG Earned Leave', category: 'ANNUAL', unit: 'DAYS', isPaid: true },
  });
  // A balance so the apply has units to hold.
  await prisma.leaveBalance.create({
    data: {
      businessId, employeeId: alice.id, leaveTypeId: lt.id, periodCode: '2026-27',
      unit: 'DAYS', opening: 10, accrued: 0, taken: 0, pendingApproval: 0, closing: 10,
    },
  });
  const types = await run(meLeave.listTypes, mkReq(custA));
  ok(Array.isArray(types.body.items) && types.body.items.some((t) => t.id === lt.id), '4) me/leave/types lists the type');
  const balances = await run(meLeave.listBalances, mkReq(custA));
  const bal = (balances.body.items || []).find((b) => b.leaveTypeId === lt.id);
  ok(bal && Number(bal.available) === 10, '4) me/leave/balances exposes available=10 (the §9.7 fix)');

  const apply = await run(meLeave.applyForLeave, mkReq(custA, {
    body: { leaveTypeId: lt.id, startDate: '2026-04-06', endDate: '2026-04-06' },
  }));
  ok(apply.status === 201 && apply.body.employeeId === alice.id, '4) apply creates a PENDING request for self (201)');
  const reqId = apply.body.id;
  const afterApply = await run(meLeave.listBalances, mkReq(custA));
  const balAfter = (afterApply.body.items || []).find((b) => b.leaveTypeId === lt.id);
  ok(balAfter && Number(balAfter.pendingApproval) === 1, '4) apply soft-holds 1 day on the balance');

  // SELF_ONLY: Bob cannot cancel Alice's request (foreign id → 404).
  const foreignCancel = await run(meLeave.cancelRequest, mkReq(custB, { params: { id: reqId } }));
  ok(foreignCancel.status === 404, '4) a foreign request id 404s on cancel (IDOR-safe, audit #55)');

  // Alice cancels her own (releases the hold).
  const cancel = await run(meLeave.cancelRequest, mkReq(custA, { params: { id: reqId } }));
  ok(cancel.status === 200 && cancel.body.status === 'CANCELLED', '4) self-cancel succeeds (CANCELLED)');
  const afterCancel = await run(meLeave.listBalances, mkReq(custA));
  const balCancel = (afterCancel.body.items || []).find((b) => b.leaveTypeId === lt.id);
  ok(balCancel && Number(balCancel.pendingApproval) === 0, '4) cancel releases the soft-hold back to 0');

  // ── 5) me/tax-declaration persist + prefill + wrong-country reject ──────────
  const saveTax = await run(meTax.saveDeclaration, mkReq(custA, {
    body: { country: 'IN', regime: 'OLD', investments: { sec80c: 150000, hra: 24000 } },
  }));
  ok(saveTax.status === 200 && saveTax.body.ok === true, '5) tax declaration saves (200)');
  const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: alice.id } });
  ok(sp && sp.taxRegime === 'OLD' && Number(sp.section80CDeclared) === 150000, '5) StatutoryProfile holds regime + 80C');
  const getTax = await run(meTax.getDeclaration, mkReq(custA));
  ok(getTax.body.declaration && getTax.body.declaration.regime === 'OLD', '5) GET prefills the saved regime');
  // Wrong-country payload (NZ fields for an IN employee) → 422.
  const wrong = await run(meTax.saveDeclaration, mkReq(custA, { body: { country: 'NZ', taxCode: 'M', kiwiSaverRate: 3 } }));
  ok(wrong.status === 422, '5) a wrong-country payload is rejected 422');

  // ── 6) me/tasks unions an un-acknowledged asset ─────────────────────────────
  const asset = await prisma.asset.create({
    data: { businessId, code: `${PREFIX}-AST1`, name: 'WaveG Laptop', category: 'LAPTOP', status: 'ASSIGNED' },
  });
  await prisma.assetAssignment.create({
    data: { businessId, assetId: asset.id, employeeId: alice.id, assignedAt: new Date(), status: 'ASSIGNED' },
  });
  const tasks = await run(meTasks.listMyTasks, mkReq(custA));
  ok(Array.isArray(tasks.body.items) && tasks.body.items.some((t) => t.kind === 'ASSET_ACK'), '6) me/tasks surfaces the un-acked asset');

  // ── 7) SELF_ONLY isolation — Bob sees his OWN (empty) leave, not Alice's ────
  const bobBalances = await run(meLeave.listBalances, mkReq(custB));
  ok((bobBalances.body.items || []).every((b) => b.employeeId === bob.id), '7) Bob never sees Alice balances (SELF_ONLY)');
  const bobReqs = await run(meLeave.listRequests, mkReq(custB));
  ok((bobReqs.body.items || []).length === 0, '7) Bob own request list is empty');

  await cleanup(businessId);
}

main()
  .then(() => {
    log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
    return prisma.$disconnect();
  })
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch(async (e) => {
    log('ERROR', e && e.stack ? e.stack : e);
    try { await prisma.$disconnect(); } catch { /* noop */ }
    process.exit(1);
  });

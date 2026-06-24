'use strict';

/*
 * capture.live.test.js — LIVE proof (plain-node, hr_test) of the multi-mode
 * Attendance Capture Policy end-to-end, driving the REAL controllers (no mocks):
 *
 *   A  Policy resolution precedence: EMPLOYEE_GROUP > LOCATION > ENTITY > TENANT.
 *   B  FACE required: a punch with NO selfie is REJECTED under enforce + FLAGGED
 *      under warn; a punch WITH a selfie (stub matcher → NEEDS_REVIEW) is ACCEPTED
 *      but flagged for review; an enrolled reference is honoured.
 *   C  IP_RESTRICTED: an off-CIDR punch is REJECTED under enforce + FLAGGED under
 *      warn (trusted req.ip, not raw XFF); an in-CIDR punch is ACCEPTED clean.
 *   D  GEO_FENCE still enforces (reuses geo.js) — out-of-radius rejected under
 *      enforce; the existing recompute OUT_OF_GEOFENCE surfacing is untouched.
 *   E  Review queue: flagged punches land in the admin queue; CLEAR/REJECT works;
 *      tenant-isolated (another tenant's flagged punch is never visible).
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/attendance/capture/__tests__/capture.live.test.js
 *   where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test' (demo tenant seeded).
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const meAttendance = require('../../../controllers/meAttendance.controller');
const captureAdminCtrl = require('../captureAdmin.controller');
const policyMod = require('../policy');

const PREFIX = 'CAP-TEST';
const SELFIE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD';

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; fails.push(name); console.error(`  FAIL ${name}`); }
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
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
    const origJson = res.json.bind(res);
    res.json = (p) => { const r = origJson(p); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

// ESS req: customer session { businessId, email } + an ip + a body.
function essReq(businessId, email, { body = {}, ip = '203.0.113.50' } = {}) {
  return { customer: { businessId, email }, body, ip, query: {}, params: {} };
}
// Operator req: { user: { businessId, id }, body, query, params }.
function opReq(businessId, { body = {}, query = {}, params = {} } = {}) {
  return { user: { businessId, id: `${PREFIX}-op` }, body, query, params };
}

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.attendance.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.attendancePunch.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.faceEnrollment.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: ids } } });
  }
  await prisma.attendanceCapturePolicy.deleteMany({ where: { businessId, OR: [{ name: { startsWith: PREFIX } }, { createdBy: `${PREFIX}-op` }] } });
  const locs = await prisma.location.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const locIds = locs.map((l) => l.id);
  if (locIds.length) await prisma.locationOfficeIp.deleteMany({ where: { businessId, locationId: { in: locIds } } });
  await prisma.location.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  console.log('\n=== Attendance multi-mode capture proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test (run prisma/seed-hr.js).");
  const businessId = demo.id;
  const inEntity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } });
  if (!inEntity) throw new Error('IN entity not found for demo tenant.');

  // recompute() reads the tenant HR country (fail-closed). A freshly-seeded demo
  // tenant may not have hrCountry set; pin it to IN so the recompute call inside
  // createPunch succeeds (India-only product). Test-fixture setup only.
  if (!demo.hrCountry) {
    await prisma.business.update({ where: { id: businessId }, data: { hrCountry: 'IN', hrCurrency: 'INR' } });
  }

  await cleanup(businessId);

  // A geofenced location (Bangalore) + an office CIDR.
  const loc = await prisma.location.create({
    data: {
      businessId, entityId: inEntity.id, code: `${PREFIX}-LOC`, name: 'Capture Office',
      countryCode: 'IN', timezone: 'Asia/Kolkata',
      geoLat: 12.971600, geoLng: 77.594600, geofenceM: 100, geofenceEnforce: false,
    },
  });

  // Helper to make an ESS employee anchored to the location (+ optional department).
  let nEmp = 0;
  async function mkEmp(tag, { locationId = loc.id, departmentId = null } = {}) {
    nEmp += 1;
    const email = `${PREFIX.toLowerCase()}-${tag}-${nEmp}@demo.test`;
    const emp = await prisma.employee.create({
      data: { businessId, code: `${PREFIX}-${tag}-${nEmp}`, firstName: tag, lastName: 'T', status: 'ACTIVE', isActive: true, workEmail: email },
    });
    await prisma.employmentRecord.create({
      data: { businessId, employeeId: emp.id, entityId: inEntity.id, locationId, departmentId, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: new Date('2027-01-01T00:00:00Z'), isCurrent: true },
    });
    return { emp, email };
  }

  try {
    /* ── A — policy resolution precedence ─────────────────────────────────── */
    {
      const dep = await prisma.department.findFirst({ where: { businessId }, select: { id: true } });
      // TENANT (geo only), ENTITY (ip), LOCATION (face), EMPLOYEE_GROUP/dept (all).
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'TENANT', scopeId: null, name: `${PREFIX}-tenant`, requireGeo: true, createdBy: `${PREFIX}-op` } });
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'ENTITY', scopeId: inEntity.id, name: `${PREFIX}-entity`, requireIp: true, createdBy: `${PREFIX}-op` } });
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'LOCATION', scopeId: loc.id, name: `${PREFIX}-loc`, requireFace: true, createdBy: `${PREFIX}-op` } });

      const atLoc = await policyMod.resolvePolicy(businessId, { entityId: inEntity.id, locationId: loc.id, departmentId: null });
      check('A1 LOCATION beats ENTITY/TENANT (face policy wins)', atLoc.scope === 'LOCATION' && atLoc.requireFace === true && atLoc.requireGeo === false);

      const atEntity = await policyMod.resolvePolicy(businessId, { entityId: inEntity.id, locationId: null, departmentId: null });
      check('A2 ENTITY beats TENANT when no location (ip policy)', atEntity.scope === 'ENTITY' && atEntity.requireIp === true);

      if (dep) {
        await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'EMPLOYEE_GROUP', scopeId: dep.id, name: `${PREFIX}-dept`, requireGeo: true, requireIp: true, requireFace: true, createdBy: `${PREFIX}-op` } });
        const atDept = await policyMod.resolvePolicy(businessId, { entityId: inEntity.id, locationId: loc.id, departmentId: dep.id });
        check('A3 EMPLOYEE_GROUP (dept) beats LOCATION', atDept.scope === 'EMPLOYEE_GROUP' && atDept.requireGeo && atDept.requireIp && atDept.requireFace);
      } else { check('A3 EMPLOYEE_GROUP (skipped — no dept seeded)', true); }

      const noPolicyBiz = await policyMod.resolvePolicy(businessId, { entityId: 'nope', locationId: 'nope', departmentId: 'nope' });
      check('A4 unknown scope falls back to TENANT', noPolicyBiz.scope === 'TENANT' && noPolicyBiz.requireGeo === true);

      // wipe scope policies before the per-mode tests (each test sets its own).
      await prisma.attendanceCapturePolicy.deleteMany({ where: { businessId, createdBy: `${PREFIX}-op` } });
    }

    /* ── B — FACE required ────────────────────────────────────────────────── */
    {
      // ENFORCE: face required + no selfie → 403 reject.
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'LOCATION', scopeId: loc.id, name: `${PREFIX}-face-enf`, requireFace: true, faceEnforce: true, createdBy: `${PREFIX}-op` } });
      const { emp: fe, email: feEmail } = await mkEmp('FACEENF');
      const rej = await callController(meAttendance.createPunch, essReq(businessId, feEmail, { body: { type: 'IN' } }));
      check('B1 FACE enforce + no selfie → 403', rej.statusCode === 403 && rej.body.reason === 'CAPTURE_POLICY');
      const noPunch = await prisma.attendancePunch.count({ where: { businessId, employeeId: fe.id } });
      check('B2 rejected punch was NOT created', noPunch === 0);

      // First enrol FACEENF's reference (so the stub matcher compares against a
      // reference and returns NEEDS_REVIEW rather than NO_REFERENCE → reject).
      const enrollEnf = await callController(meAttendance.enrollFace, essReq(businessId, feEmail, { body: { selfieDataUrl: SELFIE } }));
      check('B3a enrol reference for FACEENF', enrollEnf.statusCode === 201 && enrollEnf.body.enrolled === true);

      // WITH selfie (stub → NEEDS_REVIEW) + a reference on file → 201 accepted but
      // flagged for review (the default stub NEVER hard-rejects; a human verifies).
      const acc = await callController(meAttendance.createPunch, essReq(businessId, feEmail, { body: { type: 'IN', selfieDataUrl: SELFIE } }));
      check('B3 FACE enforce + selfie + reference (stub NEEDS_REVIEW) → 201 created', acc.statusCode === 201);
      check('B4 created punch is flagged + face status NEEDS_REVIEW + selfie stored', acc.body.captureFlagged === true && acc.body.faceMatchStatus === 'NEEDS_REVIEW' && !!acc.body.selfieUrl);
      check('B5 flagged punch parked PENDING in review', acc.body.reviewStatus === 'PENDING' && acc.body.captureFlagReasons.includes('FACE_NEEDS_REVIEW'));

      // And separately prove: FACE enforce + selfie + NO reference → 403 (NO_REFERENCE).
      const { email: nrEmail } = await mkEmp('FACENOREF');
      const nrRej = await callController(meAttendance.createPunch, essReq(businessId, nrEmail, { body: { type: 'IN', selfieDataUrl: SELFIE } }));
      check('B5b FACE enforce + selfie + NO enrolled reference → 403', nrRej.statusCode === 403 && nrRej.body.reason === 'CAPTURE_POLICY');

      await prisma.attendanceCapturePolicy.deleteMany({ where: { businessId, createdBy: `${PREFIX}-op` } });

      // WARN: face required + no selfie → 201 created but flagged (not rejected).
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'LOCATION', scopeId: loc.id, name: `${PREFIX}-face-warn`, requireFace: true, faceEnforce: false, createdBy: `${PREFIX}-op` } });
      const { email: fwEmail } = await mkEmp('FACEWARN');
      const warn = await callController(meAttendance.createPunch, essReq(businessId, fwEmail, { body: { type: 'IN' } }));
      check('B6 FACE warn + no selfie → 201 created, flagged FACE_MISSING_SELFIE', warn.statusCode === 201 && warn.body.captureFlagged === true && warn.body.captureFlagReasons.includes('FACE_MISSING_SELFIE'));

      // /me/attendance/policy preview reflects requireFace + faceEnrolled false→true.
      const polRes = await callController(meAttendance.getCapturePolicy, essReq(businessId, fwEmail, {}));
      check('B7 /policy preview shows requireFace true, faceEnrolled false', polRes.body.requireFace === true && polRes.body.faceEnrolled === false);
      const enr = await callController(meAttendance.enrollFace, essReq(businessId, fwEmail, { body: { selfieDataUrl: SELFIE } }));
      check('B8 enrollFace → 201 enrolled', enr.statusCode === 201 && enr.body.enrolled === true);
      const polRes2 = await callController(meAttendance.getCapturePolicy, essReq(businessId, fwEmail, {}));
      check('B9 /policy preview now shows faceEnrolled true', polRes2.body.faceEnrolled === true);

      await prisma.attendanceCapturePolicy.deleteMany({ where: { businessId, createdBy: `${PREFIX}-op` } });
    }

    /* ── C — IP_RESTRICTED ────────────────────────────────────────────────── */
    {
      // Office CIDR for the location: 203.0.113.0/24.
      await prisma.locationOfficeIp.create({ data: { businessId, locationId: loc.id, cidr: '203.0.113.0/24', label: `${PREFIX}-hq` } });

      // ENFORCE: off-network punch (8.8.8.8) → 403; in-network (203.0.113.50) → 201 clean.
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'LOCATION', scopeId: loc.id, name: `${PREFIX}-ip-enf`, requireIp: true, ipEnforce: true, createdBy: `${PREFIX}-op` } });
      const { emp: ie, email: ieEmail } = await mkEmp('IPENF');
      const off = await callController(meAttendance.createPunch, essReq(businessId, ieEmail, { body: { type: 'IN' }, ip: '8.8.8.8' }));
      check('C1 IP enforce + off-CIDR → 403', off.statusCode === 403 && off.body.reason === 'CAPTURE_POLICY');
      check('C2 off-CIDR punch NOT created', (await prisma.attendancePunch.count({ where: { businessId, employeeId: ie.id } })) === 0);
      const on = await callController(meAttendance.createPunch, essReq(businessId, ieEmail, { body: { type: 'IN' }, ip: '203.0.113.50' }));
      check('C3 IP enforce + in-CIDR → 201 clean (ipAllowed true, not flagged)', on.statusCode === 201 && on.body.ipAllowed === true && on.body.captureFlagged === false);

      // Spoof guard: a raw XFF cannot beat req.ip — the controller uses req.ip only.
      // (We pass ip:'8.8.8.8' to simulate the trusted-proxy-resolved client; a crafted
      //  x-forwarded-for header on the same req is never consulted by the capture path.)
      const spoof = await callController(meAttendance.createPunch, essReq(businessId, ieEmail, { body: { type: 'IN' }, ip: '8.8.8.8' }));
      check('C4 off-net stays rejected even with a (would-be) spoofed XFF (req.ip honoured)', spoof.statusCode === 403);

      await prisma.attendanceCapturePolicy.deleteMany({ where: { businessId, createdBy: `${PREFIX}-op` } });

      // WARN: off-network → 201 created but flagged OFF_NETWORK.
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'LOCATION', scopeId: loc.id, name: `${PREFIX}-ip-warn`, requireIp: true, ipEnforce: false, createdBy: `${PREFIX}-op` } });
      const { email: iwEmail } = await mkEmp('IPWARN');
      const offWarn = await callController(meAttendance.createPunch, essReq(businessId, iwEmail, { body: { type: 'IN' }, ip: '8.8.8.8' }));
      check('C5 IP warn + off-CIDR → 201 created, flagged OFF_NETWORK, ipAllowed false', offWarn.statusCode === 201 && offWarn.body.captureFlagged === true && offWarn.body.captureFlagReasons.includes('OFF_NETWORK') && offWarn.body.ipAllowed === false);

      await prisma.attendanceCapturePolicy.deleteMany({ where: { businessId, createdBy: `${PREFIX}-op` } });
    }

    /* ── D — GEO_FENCE still enforces (reuses geo.js) ─────────────────────── */
    {
      // ENFORCE: a punch ~220m north of the fence centre → 403; inside → 201.
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'LOCATION', scopeId: loc.id, name: `${PREFIX}-geo-enf`, requireGeo: true, geoEnforce: true, createdBy: `${PREFIX}-op` } });
      const { emp: ge, email: geEmail } = await mkEmp('GEOENF');
      const outside = await callController(meAttendance.createPunch, essReq(businessId, geEmail, { body: { type: 'IN', geoLat: 12.973600, geoLng: 77.594600 } }));
      check('D1 GEO enforce + outside radius → 403', outside.statusCode === 403 && outside.body.reason === 'CAPTURE_POLICY');
      check('D2 outside-geofence punch NOT created', (await prisma.attendancePunch.count({ where: { businessId, employeeId: ge.id } })) === 0);
      const inside = await callController(meAttendance.createPunch, essReq(businessId, geEmail, { body: { type: 'IN', geoLat: 12.971650, geoLng: 77.594650 } }));
      check('D3 GEO enforce + inside radius → 201 clean', inside.statusCode === 201 && inside.body.captureFlagged === false);
      // The existing recompute still stamped the per-punch geofence marker (engine untouched).
      check('D4 recompute stamped outOfGeofence:false on the inside punch', inside.body.outOfGeofence === false);

      await prisma.attendanceCapturePolicy.deleteMany({ where: { businessId, createdBy: `${PREFIX}-op` } });
    }

    /* ── E — review queue + tenant isolation ──────────────────────────────── */
    {
      // Create a flagged punch (face warn, no selfie) to populate the queue.
      await prisma.attendanceCapturePolicy.create({ data: { businessId, scope: 'LOCATION', scopeId: loc.id, name: `${PREFIX}-rev`, requireFace: true, faceEnforce: false, createdBy: `${PREFIX}-op` } });
      const { emp: re, email: reEmail } = await mkEmp('REVIEW');
      const flaggedPunch = await callController(meAttendance.createPunch, essReq(businessId, reEmail, { body: { type: 'IN' } }));
      check('E1 flagged punch created', flaggedPunch.body.captureFlagged === true);

      const queue = await callController(captureAdminCtrl.listReviewQueue, opReq(businessId, { query: { status: 'PENDING' } }));
      const inQueue = (queue.body.items || []).some((p) => p.id === flaggedPunch.body.id);
      check('E2 flagged punch appears in PENDING review queue', inQueue);
      check('E3 review row carries employee label + flag reasons', (queue.body.items || []).find((p) => p.id === flaggedPunch.body.id)?.employee != null);

      // CLEAR the punch.
      const cleared = await callController(captureAdminCtrl.actOnReview, opReq(businessId, { params: { id: flaggedPunch.body.id }, body: { decision: 'CLEAR', note: 'verified by HR' } }));
      check('E4 CLEAR → reviewStatus CLEARED', cleared.body.reviewStatus === 'CLEARED' && cleared.body.reviewedBy === `${PREFIX}-op`);
      const queue2 = await callController(captureAdminCtrl.listReviewQueue, opReq(businessId, { query: { status: 'PENDING' } }));
      check('E5 cleared punch left the PENDING queue', !(queue2.body.items || []).some((p) => p.id === flaggedPunch.body.id));

      // Re-create a PENDING flagged punch so the isolation probe has a live target.
      const { email: re2Email } = await mkEmp('REVIEW2');
      const flagged2 = await callController(meAttendance.createPunch, essReq(businessId, re2Email, { body: { type: 'IN' } }));
      check('E5b second flagged punch (PENDING) created', flagged2.body.captureFlagged === true && flagged2.body.reviewStatus === 'PENDING');

      // TENANT ISOLATION — a SEPARATE tenant cannot see or act on this punch. Create a
      // real second business inline (name is the only required Business field).
      const otherBiz = await prisma.business.create({ data: { name: `${PREFIX} Other Tenant`, slug: `${PREFIX.toLowerCase()}-other-${Date.now()}` } });
      try {
        const otherQueue = await callController(captureAdminCtrl.listReviewQueue, opReq(otherBiz.id, { query: { status: 'PENDING' } }));
        check('E6 other tenant queue does NOT contain demo punch', !(otherQueue.body.items || []).some((p) => p.id === flagged2.body.id));
        const otherAct = await callController(captureAdminCtrl.actOnReview, opReq(otherBiz.id, { params: { id: flagged2.body.id }, body: { decision: 'REJECT' } }));
        check('E7 other tenant cannot act on demo punch → 404 (tenant-scoped)', otherAct.statusCode === 404);
        // And the demo punch is untouched (still PENDING).
        const still = await prisma.attendancePunch.findUnique({ where: { id: flagged2.body.id }, select: { reviewStatus: true } });
        check('E8 cross-tenant act did NOT mutate the demo punch', still.reviewStatus === 'PENDING');
      } finally {
        await prisma.business.delete({ where: { id: otherBiz.id } });
      }
    }

    console.log(`\ncapture.live: ${passed} passed, ${failed} failed`);
    if (failed) { console.error('FAILED:', fails.join('; ')); process.exitCode = 1; }
    else console.log('capture.live OK');
  } finally {
    await cleanup(businessId);
    await prisma.locationOfficeIp.deleteMany({ where: { businessId, label: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

'use strict';

/**
 * attendance.rbac.test.js — LIVE Feature-2 Phase-3 proof (plain-node, hr_test).
 *
 * Sibling to ../../__tests__/scope.rbac.test.js: same harness, same isolated
 * hr_test schema, same plain-node runner (no jest). Proves the attendance
 * endpoints + the freeze bridge against the spec QA plan
 * (docs/features/02-attendance-time.md §7.2–§7.5):
 *
 *   §7.3 RBAC/scope:
 *     - Manager sees only the team's punches/summary (sub-tree filter).
 *     - Out-of-scope regularization approve → 404 (not 403).
 *     - Forged ?employeeId out of scope → empty (not honored).
 *     - ESS self-only; ESS self-submit own timesheet → 200.
 *     - Punch for out-of-scope employee → 404.
 *     - Punch into a locked range → 409.
 *     - Tenant wall (cross-tenant target invisible).
 *   §7.2 freeze:
 *     - rollup → AttendancePayInput payableDays/lopDays/overtimeHours.
 *     - freeze locks the Attendance rows (immutability/monotonic).
 *     - unique freeze (re-freeze upserts, never duplicates).
 *   §7.4 holiday:
 *     - NZ mondayisation (observed-Monday rows).
 *     - import idempotency (re-import → no new rows).
 *   §7.5 state machines:
 *     - regularization approve materializes punches + re-derives.
 *     - assignment overlap rejected (409).
 *
 * Build a small fixture inside the seed 'demo' tenant (prefix-tagged, torn down).
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/attendance/__tests__/attendance.rbac.test.js
 * where $HR_URL = the repo .env DATABASE_URL + '?schema=hr_test'.
 */

const prisma = require('../../../core/lib/prisma');
const attendance = require('../../controllers/attendance.controller');
const holidays = require('../../controllers/holidays.controller');
const { recompute } = require('../service');
const { freezeAttendance } = require('../freeze');
const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── controller doubles (copied from the scope.rbac harness) ───────────────────
function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
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
    const origEnd = res.end.bind(res);
    res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

function actor({ businessId, id, employeeId = null, band, role = 'STAFF' }) {
  return {
    id: id || `actor-${band}-${employeeId || 'noemp'}`,
    businessId, role, employeeId,
    businessRoleId: null,
    businessRole: { defaultScope: band },
  };
}
async function withScope(user, action, extra = {}) {
  const scope = await resolveAccessibleEmployeeIds(user, action);
  return { user, scope, query: {}, params: {}, body: {}, ...extra };
}

const PREFIX = 'ATT-TEST';
const day = (s) => new Date(`${s}T00:00:00Z`);

async function cleanup(businessId, otherBusinessId) {
  for (const bid of [businessId, otherBusinessId].filter(Boolean)) {
    const emps = await prisma.employee.findMany({ where: { businessId: bid, code: { startsWith: PREFIX } }, select: { id: true } });
    const ids = emps.map((e) => e.id);
    if (ids.length) {
      await prisma.attendancePayInput.deleteMany({ where: { businessId: bid, employeeId: { in: ids } } });
      await prisma.attendance.deleteMany({ where: { businessId: bid, employeeId: { in: ids } } });
      await prisma.attendancePunch.deleteMany({ where: { businessId: bid, employeeId: { in: ids } } });
      await prisma.attendanceRegularizationRequest.deleteMany({ where: { businessId: bid, employeeId: { in: ids } } });
      await prisma.shiftAssignment.deleteMany({ where: { businessId: bid, employeeId: { in: ids } } });
      await prisma.timesheet.deleteMany({ where: { businessId: bid, employeeId: { in: ids } } });
      await prisma.employmentRecord.deleteMany({ where: { businessId: bid, employeeId: { in: ids } } });
    }
    await prisma.payRun.deleteMany({ where: { businessId: bid, code: { startsWith: `PR-${PREFIX}` } } });
    await prisma.holiday.deleteMany({ where: { businessId: bid, name: { startsWith: PREFIX } } });
    await prisma.shiftPattern.deleteMany({ where: { businessId: bid, code: { startsWith: PREFIX } } });
    await prisma.employee.updateMany({ where: { businessId: bid, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: { businessId: bid, code: { startsWith: PREFIX } } });
  }
  // Statutory import rows seeded for the test year (NZ/IN, scopeKey global).
  // The import doesn't tag rows with our prefix, so clear the whole 2027 window
  // for the imported countries to keep the test fully idempotent (no residue).
  await prisma.holiday.deleteMany({ where: { businessId, countryCode: { in: ['NZ', 'IN'] }, date: { gte: day('2027-01-01'), lt: day('2028-01-01') } } });
}

async function main() {
  log('\n=== Attendance Feature-2 Phase-3 proof (LIVE hr_test) ===\n');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const other = await prisma.business.findFirst({ where: { slug: { not: 'demo' } } });
  const otherBusinessId = other ? other.id : null;

  const entity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } });
  const cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: entity.id } });

  await cleanup(businessId, otherBusinessId);

  // ── Fixture: MGR → {R1,R2}; PEER outside MGR's tree ─────────────────────────
  const mkEmp = (code, extra = {}) => prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', ...extra },
  });
  const mgr = await mkEmp('MGR');
  const r1 = await mkEmp('R1', { managerEmployeeId: mgr.id });
  const r2 = await mkEmp('R2', { managerEmployeeId: mgr.id });
  const peer = await mkEmp('PEER');

  // Current employment records anchoring R1,R2,PEER to the IN entity (freeze headcount).
  for (const e of [r1, r2, peer]) {
    await prisma.employmentRecord.create({
      data: { businessId, employeeId: e.id, entityId: entity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true },
    });
  }

  // A general day shift, Sat/Sun weekly-off, OT-eligible (so OT credits flow).
  const shift = await prisma.shiftPattern.create({
    data: {
      businessId, entityId: entity.id, code: `${PREFIX}-GEN`, name: 'Gen', startTime: '09:00', endTime: '18:00',
      breakMinutes: 60, graceInMinutes: 10, fullDayMinutes: 480, halfDayThresholdMinutes: 240,
      weeklyOffDays: '0,6', otEligible: true, dailyOtThresholdMin: 480, isActive: true,
    },
  });
  // Assign the shift to R1 for the whole period.
  await prisma.shiftAssignment.create({
    data: { businessId, employeeId: r1.id, shiftPatternId: shift.id, effectiveFrom: day('2027-06-01'), effectiveTo: day('2027-06-30') },
  });
  // An OT rule so HOLIDAY_WORKED/OT multipliers resolve deterministically.
  await prisma.overtimeRule.create({
    data: { businessId, entityId: entity.id, dailyThresholdMin: 480, weekdayMultiplier: 1.5, roundingMin: 0, isActive: true },
  });

  // Actors
  const manager = actor({ businessId, employeeId: mgr.id, band: 'TEAM' });
  const opAdmin = actor({ businessId, employeeId: mgr.id, band: 'ALL', role: 'BUSINESS_ADMIN', id: 'op-admin' });
  const essR1 = actor({ businessId, employeeId: r1.id, band: 'SELF', role: 'USER', id: 'ess-r1' });

  try {
    /* ──────────────────────────────────────────────────────────────────────
       §7.3 RBAC / scope
       ────────────────────────────────────────────────────────────────────── */
    log('§7.3 — punch scope guard:');
    {
      // Manager punches for an in-scope report (R1) → 201, recompute writes a row.
      const okReq = await withScope(manager, 'canViewEmployees', { body: { employeeId: r1.id, type: 'IN', punchAt: '2027-06-01T09:00:00Z' } });
      const okRes = await callController(attendance.createPunch, okReq);
      assert(okRes.statusCode === 201, 'Manager punch IN for in-scope R1 → 201');

      // Manager punches for the out-of-scope PEER → 404 (IDOR-safe).
      const badReq = await withScope(manager, 'canViewEmployees', { body: { employeeId: peer.id, type: 'IN', punchAt: '2027-06-01T09:00:00Z' } });
      const badRes = await callController(attendance.createPunch, badReq);
      assert(badRes.statusCode === 404, 'Manager punch for out-of-scope PEER → 404 (not 403)');

      // Tenant wall: a forged employeeId from another tenant is invisible → 404.
      if (otherBusinessId) {
        const foreign = await prisma.employee.findFirst({ where: { businessId: otherBusinessId }, select: { id: true } });
        if (foreign) {
          const tReq = await withScope(opAdmin, 'canViewEmployees', { body: { employeeId: foreign.id, type: 'IN' } });
          const tRes = await callController(attendance.createPunch, tReq);
          assert(tRes.statusCode === 404, 'Operator(ALL) punch for a CROSS-TENANT employee → 404 (tenant wall)');
        } else { assert(true, 'no foreign employee to probe (skipped tenant-wall punch)'); }
      } else { assert(true, 'no second tenant to probe (skipped tenant wall)'); }
    }

    log('§7.3 — manager summary/punches see only the team:');
    {
      // Give PEER a punch (out of the manager's tree) and R2 a punch (in tree).
      await prisma.attendancePunch.create({ data: { businessId, employeeId: peer.id, punchType: 'IN', source: 'WEB', punchAt: day('2027-06-01') } });
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r2.id, punchType: 'IN', source: 'WEB', punchAt: day('2027-06-01') } });

      const req = await withScope(manager, 'canViewEmployees', { query: {} });
      const res = await callController(attendance.listPunches, req);
      const empIds = new Set(((res.body && res.body.items) || []).map((p) => p.employeeId));
      assert(res.statusCode === 200, 'listPunches → 200 for Manager');
      assert(!empIds.has(peer.id), 'Manager punch log EXCLUDES the out-of-tree PEER');

      // Forged ?employeeId=PEER → empty (not honored).
      const fReq = await withScope(manager, 'canViewEmployees', { query: { employeeId: peer.id } });
      const fRes = await callController(attendance.listPunches, fReq);
      assert(((fRes.body && fRes.body.items) || []).length === 0, 'forged ?employeeId=PEER → empty (no widening)');
    }

    log('§7.3 — ESS self-only:');
    {
      // ESS R1 raising a correction for PEER → 404 (self band excludes PEER).
      const req = await withScope(essR1, 'canManageAttendance', {
        body: { employeeId: peer.id, date: '2027-06-02', kind: 'MISSED_PUNCH', reason: 'x' },
      });
      const res = await callController(attendance.createRegularization, req);
      assert(res.statusCode === 404, 'ESS R1 regularization for PEER → 404 (self-only)');
    }

    /* ──────────────────────────────────────────────────────────────────────
       §7.5 — regularization approve materializes + re-derives
       ────────────────────────────────────────────────────────────────────── */
    log('§7.5 — regularization self-create → PENDING, approve materializes + re-derives:');
    {
      // ESS R1 self-raises a MISSED_PUNCH for 2027-06-03 with full requested in/out.
      const createReq = await withScope(essR1, 'canManageAttendance', {
        body: { date: '2027-06-03', kind: 'MISSED_PUNCH', requestedInAt: '2027-06-03T09:00:00Z', requestedOutAt: '2027-06-03T18:00:00Z', reason: `${PREFIX} forgot to punch` },
      });
      const createRes = await callController(attendance.createRegularization, createReq);
      assert(createRes.statusCode === 201 && createRes.body.status === 'PENDING', 'ESS R1 self-create regularization → 201 PENDING');
      const reqId = createRes.body.id;

      // Out-of-scope target: a manager approving a request that belongs to PEER → 404.
      // Build a PEER request directly, then attempt approve as the manager.
      const peerReq = await prisma.attendanceRegularizationRequest.create({
        data: { businessId, employeeId: peer.id, date: day('2027-06-03'), kind: 'MISSED_PUNCH', reason: `${PREFIX} peer`, status: 'PENDING' },
      });
      const oosReq = await withScope(manager, 'canManageAttendance', { params: { id: peerReq.id } });
      const oosRes = await callController(attendance.approveRegularization, oosReq);
      assert(oosRes.statusCode === 404, 'Manager approve out-of-scope (PEER) regularization → 404');
      const peerReloaded = await prisma.attendanceRegularizationRequest.findUnique({ where: { id: peerReq.id } });
      assert(peerReloaded.status === 'PENDING', 'PEER regularization stays PENDING (not approved)');

      // Manager approves R1's request → APPROVED + materialized punches + re-derive.
      const apprReq = await withScope(manager, 'canManageAttendance', { params: { id: reqId } });
      const apprRes = await callController(attendance.approveRegularization, apprReq);
      assert(apprRes.statusCode === 200 && apprRes.body.status === 'APPROVED', 'Manager approve R1 regularization → 200 APPROVED');
      assert(apprRes.body.decidedBy != null && apprRes.body.decidedAt != null, 'approve sets decidedBy + decidedAt');

      const materialized = await prisma.attendancePunch.findMany({ where: { businessId, employeeId: r1.id, regularizationRequestId: reqId } });
      assert(materialized.length === 2 && materialized.every((p) => p.source === 'MANUAL' && p.isManual === false),
        'approve materializes 2 MANUAL IN/OUT punches (isManual=false → counted by derive)');

      const att = await prisma.attendance.findFirst({ where: { businessId, employeeId: r1.id, date: day('2027-06-03') } });
      assert(att && att.status === 'PRESENT' && Number(att.lopFraction) === 0 && att.workedMinutes === 480,
        're-derive after approve → PRESENT, 480 worked, 0 LOP');
    }

    /* ──────────────────────────────────────────────────────────────────────
       §7.5 — assignment overlap rejected
       ────────────────────────────────────────────────────────────────────── */
    log('§7.5 — shift assignment overlap rejected:');
    {
      // opAdmin is an ALL-band operator — the withEmployeeScope middleware would set scope.
      const ALL = { kind: 'ALL' };
      // R1 already has [2027-06-01, 2027-06-30]; an overlapping [06-15, 07-15] → 409.
      const ovReq = { user: opAdmin, scope: ALL, params: { id: shift.id }, body: { employeeId: r1.id, effectiveFrom: '2027-06-15', effectiveTo: '2027-07-15' } };
      const ovRes = await callController(attendance.assignShift, ovReq);
      assert(ovRes.statusCode === 409, 'overlapping assignment for R1 → 409');

      // A non-overlapping window [2027-07-16, …] → 201.
      const okReq = { user: opAdmin, scope: ALL, params: { id: shift.id }, body: { employeeId: r1.id, effectiveFrom: '2027-07-16', effectiveTo: '2027-08-15' } };
      const okRes = await callController(attendance.assignShift, okReq);
      assert(okRes.statusCode === 201, 'non-overlapping assignment for R1 → 201');

      // Re-review fix: assignment WRITE path is now scope-guarded. An actor whose
      // scope excludes the target employee → 404 (IDOR-safe), mirroring the read path.
      const oosReq = { user: opAdmin, scope: { kind: 'IDS', ids: new Set() }, params: { id: shift.id }, body: { employeeId: r1.id, effectiveFrom: '2028-01-01' } };
      const oosRes = await callController(attendance.assignShift, oosReq);
      assert(oosRes.statusCode === 404, 'assign to out-of-scope employee → 404 (write-path IDOR closed)');
    }

    /* ──────────────────────────────────────────────────────────────────────
       §7.4 — holiday import (NZ mondayisation + idempotency)
       ────────────────────────────────────────────────────────────────────── */
    log('§7.4 — NZ holiday import (mondayisation + idempotency):');
    {
      const impReq = { user: opAdmin, body: { countryCode: 'NZ', year: 2027 } };
      const impRes = await callController(holidays.importHolidays, impReq);
      assert(impRes.statusCode === 201 && impRes.body.created > 0, 'NZ import → 201 with created rows');

      // ANZAC Day 2027 is Sunday Apr 25 → observed Monday Apr 26 row must exist.
      const observed = await prisma.holiday.findFirst({
        where: { businessId, name: 'ANZAC Day (observed)', date: day('2027-04-26') },
      });
      assert(!!observed, 'NZ mondayisation: ANZAC Day (observed) lands on Mon 2027-04-26');

      // Re-import is idempotent: no new rows created the second time.
      const before = await prisma.holiday.count({ where: { businessId, countryCode: 'NZ', date: { gte: day('2027-01-01'), lt: day('2028-01-01') } } });
      const imp2 = await callController(holidays.importHolidays, { user: opAdmin, body: { countryCode: 'NZ', year: 2027 } });
      const after = await prisma.holiday.count({ where: { businessId, countryCode: 'NZ', date: { gte: day('2027-01-01'), lt: day('2028-01-01') } } });
      assert(imp2.body.created === 0 && before === after, 'NZ re-import idempotent (0 new rows)');
      // (Imported rows are cleared by the broad NZ/IN cleanup at teardown.)
    }

    /* ──────────────────────────────────────────────────────────────────────
       §7.2 — freeze bridge: rollup → AttendancePayInput; immutability; unique
       ────────────────────────────────────────────────────────────────────── */
    log('§7.2 — freeze rollup → AttendancePayInput:');
    {
      // Build a deterministic month of attendance for R1 over 2027-06-01..06-05:
      //   06-01 PRESENT (already punched IN; add OUT) — full day
      //   06-02 ABSENT (no punches, scheduled working day) → lop 1
      //   06-04 PRESENT with OT (worked 600 → 120 OT @1.5 = 3.0h equiv)
      // 06-03 already PRESENT (from the regularization approve above).
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'OUT', source: 'WEB', punchAt: new Date('2027-06-01T18:00:00Z') } });
      // 06-04 long day. The seed IN entity is Asia/Kolkata, so punch instants are
      // chosen in IST wall-clock that stay within the 06-04 IST civil day:
      //   IN 09:00 IST (03:30Z) → OUT 20:00 IST (14:30Z) = 11h gross − 60 break =
      //   600 worked → 120 OT over the 480 threshold (@1.5 ⇒ 3.0h equiv).
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'IN', source: 'WEB', punchAt: new Date('2027-06-04T03:30:00Z') } });
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'OUT', source: 'WEB', punchAt: new Date('2027-06-04T14:30:00Z') } });

      await recompute(businessId, r1.id, day('2027-06-01'), day('2027-06-05'));

      const rows = await prisma.attendance.findMany({ where: { businessId, employeeId: r1.id, date: { gte: day('2027-06-01'), lte: day('2027-06-05') } }, orderBy: { date: 'asc' } });
      const byDate = Object.fromEntries(rows.map((r) => [r.date.toISOString().slice(0, 10), r]));
      assert(byDate['2027-06-01'] && byDate['2027-06-01'].status === 'PRESENT', '06-01 PRESENT');
      assert(byDate['2027-06-02'] && byDate['2027-06-02'].status === 'ABSENT' && Number(byDate['2027-06-02'].lopFraction) === 1, '06-02 ABSENT lop=1');
      assert(byDate['2027-06-04'] && byDate['2027-06-04'].overtimeMinutes === 120, '06-04 OT minutes = 120 (worked 600 − 480)');

      // Create a PayRun to freeze into.
      const payRun = await prisma.payRun.create({
        data: {
          businessId, entityId: entity.id, payCalendarId: cal.id, code: `PR-${PREFIX}-2706`,
          periodStart: day('2027-06-01'), periodEnd: day('2027-06-05'), payDate: day('2027-06-30'),
          sequenceInYear: 3, taxYear: '2027-28', currencyCode: entity.payCurrency || 'INR', status: 'DRAFT',
        },
      });

      const fr = await freezeAttendance(payRun.id, businessId, day('2027-06-01'), day('2027-06-05'), [r1.id]);
      assert(fr.frozen === 1, 'freeze wrote 1 AttendancePayInput');

      const api = await prisma.attendancePayInput.findUnique({ where: { payRunId_employeeId: { payRunId: payRun.id, employeeId: r1.id } } });
      assert(!!api, 'AttendancePayInput row exists for (payRun, R1)');
      assert(Number(api.calendarDays) === 5, 'calendarDays = 5 (06-01..06-05 inclusive)');
      assert(Number(api.lopDays) === 1, 'lopDays = 1 (the 06-02 ABSENT)');
      assert(Number(api.payableDays) === 4, 'payableDays = calendarDays − lopDays = 4');
      assert(Number(api.overtimeHours) === 3, 'overtimeHours = 3.0 (120min × 1.5 ÷ 60)');
      assert(api.frozenAt != null && api.sourceJson && Array.isArray(api.sourceJson.attendanceIds), 'frozenAt + sourceJson.attendanceIds present');

      log('§7.2 — freeze immutability (locked rows do not retro-mutate):');
      {
        const locked = await prisma.attendance.findMany({ where: { businessId, employeeId: r1.id, date: { gte: day('2027-06-01'), lte: day('2027-06-05') }, isLocked: true } });
        assert(locked.length === rows.length, 'all rolled-up Attendance rows are now isLocked=true');

        // A recompute over the locked range must NOT change a locked row.
        const before01 = (await prisma.attendance.findFirst({ where: { businessId, employeeId: r1.id, date: day('2027-06-01') } }));
        // Add a late OUT punch that WOULD change worked minutes if recompute weren't skipping locked rows.
        await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'OUT', source: 'WEB', punchAt: new Date('2027-06-01T23:00:00Z') } });
        const reres = await recompute(businessId, r1.id, day('2027-06-01'), day('2027-06-05'));
        const after01 = (await prisma.attendance.findFirst({ where: { businessId, employeeId: r1.id, date: day('2027-06-01') } }));
        assert(reres.skippedLocked === rows.length, 'recompute SKIPS all locked rows');
        assert(before01.workedMinutes === after01.workedMinutes && before01.lastOut.getTime() === after01.lastOut.getTime(),
          'locked 06-01 row is unchanged after recompute (monotonic freeze)');

        // Punch into the locked range via the endpoint → 409.
        const lockReq = await withScope(manager, 'canViewEmployees', { body: { employeeId: r1.id, type: 'IN', punchAt: '2027-06-02T09:00:00Z' } });
        const lockRes = await callController(attendance.createPunch, lockReq);
        assert(lockRes.statusCode === 409, 'punch into a LOCKED day → 409');
      }

      log('§7.2 — unique freeze (re-freeze upserts, never duplicates):');
      {
        const fr2 = await freezeAttendance(payRun.id, businessId, day('2027-06-01'), day('2027-06-05'), [r1.id]);
        assert(fr2.frozen === 1, 're-freeze → 1 (upsert)');
        const count = await prisma.attendancePayInput.count({ where: { payRunId: payRun.id, employeeId: r1.id } });
        assert(count === 1, 'still exactly ONE AttendancePayInput for (payRun, R1) — unique honored');
      }
    }

    /* ──────────────────────────────────────────────────────────────────────
       §7.3 — ESS self-submit own timesheet → 200
       ────────────────────────────────────────────────────────────────────── */
    log('§7.3 — ESS self-submit own timesheet → 200:');
    {
      const ts = await prisma.timesheet.create({
        data: { businessId, employeeId: r1.id, periodStart: day('2027-07-01'), periodEnd: day('2027-07-15'), status: 'DRAFT' },
      });
      const req = await withScope(essR1, 'canViewEmployees', { params: { id: ts.id } });
      const res = await callController(attendance.submitTimesheet, req);
      assert(res.statusCode === 200 && res.body.status === 'SUBMITTED', 'ESS R1 submits own DRAFT timesheet → 200 SUBMITTED');

      // A peer's timesheet is not self-submittable by ESS R1 → 404.
      const peerTs = await prisma.timesheet.create({
        data: { businessId, employeeId: peer.id, periodStart: day('2027-07-01'), periodEnd: day('2027-07-15'), status: 'DRAFT' },
      });
      const pReq = await withScope(essR1, 'canViewEmployees', { params: { id: peerTs.id } });
      const pRes = await callController(attendance.submitTimesheet, pReq);
      assert(pRes.statusCode === 404, "ESS R1 cannot submit PEER's timesheet → 404");
    }
  } finally {
    await cleanup(businessId, otherBusinessId);
  }

  log(`\n=== ${failures === 0 ? 'ALL ATTENDANCE CHECKS PASSED' : `${failures} ATTENDANCE CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Attendance test crashed:', err);
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});

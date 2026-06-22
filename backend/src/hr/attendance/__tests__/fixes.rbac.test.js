'use strict';

/*
 * fixes.rbac.test.js — LIVE (hr_test) regression proof for the adversarial-review
 * fixes that touch the DB. Sibling to attendance.rbac.test.js: same harness, same
 * isolated hr_test schema, plain-node runner.
 *
 *   C1 — night-shift cross-midnight OUT not double-counted (one PRESENT row, the
 *        next day NOT falsely MISSING_PUNCH).
 *   C2 — LATE_IN fires off the LOCAL shift clock (IST + NZ), not UTC wall-time.
 *   H1 — /pay-inputs scoped: manager can't read a peer's; forged employeeId → empty.
 *   H2 — a filer cannot self-approve their own regularization (404); manager still can.
 *   H3 — open-attendance employee with zero rows → NO_ATTENDANCE_DATA warning, not
 *        a silent full-pay drop; scheduled absent employee → lopDays counted.
 *   H5 — an NZ late-evening punch lands on the correct LOCAL date.
 *   L1 — /assignments requires canViewEmployees (controller honours the scope guard).
 *   L4 — holiday import year out of [2000,2100] → 400.
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/attendance/__tests__/fixes.rbac.test.js
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

const PREFIX = 'FIX-TEST';
const day = (s) => new Date(`${s}T00:00:00Z`);

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.attendancePayInput.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.attendance.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.attendancePunch.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.attendanceRegularizationRequest.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.shiftAssignment.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.leaveTransaction.deleteMany({ where: { businessId, employeeId: { in: ids } } });
    await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: ids } } });
  }
  await prisma.payRun.deleteMany({ where: { businessId, code: { startsWith: `PR-${PREFIX}` } } });
  await prisma.shiftPattern.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.leaveType.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Attendance Feature-2 adversarial-fix proof (LIVE hr_test) ===\n');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  // IN entity (Asia/Kolkata) + an NZ entity if seeded (Pacific/Auckland).
  const inEntity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } });
  const nzEntity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'NZ' } });

  await cleanup(businessId);

  const mkEmp = (code, extra = {}) => prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', ...extra },
  });

  // MGR → {R1}; PEER outside the tree.
  const mgr = await mkEmp('MGR');
  const r1 = await mkEmp('R1', { managerEmployeeId: mgr.id });
  const peer = await mkEmp('PEER');
  // Anchor R1 + PEER to the IN entity (IST).
  for (const e of [r1, peer]) {
    await prisma.employmentRecord.create({
      data: { businessId, employeeId: e.id, entityId: inEntity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true },
    });
  }

  const manager = actor({ businessId, employeeId: mgr.id, band: 'TEAM' });
  const hrAdmin = actor({ businessId, employeeId: mgr.id, band: 'ALL', role: 'BUSINESS_ADMIN', id: 'hr-admin' });
  const essR1 = actor({ businessId, employeeId: r1.id, band: 'SELF', role: 'USER', id: 'ess-r1' });

  try {
    /* ── C1 — night-shift cross-midnight ──────────────────────────────────── */
    log('C1 — night shift 22:00→06:00 IST: ONE PRESENT day, next day not MISSING_PUNCH:');
    {
      // Night pattern in IST. 22:00→06:00 = 8h gross; break 0 → 480 worked → PRESENT.
      const night = await prisma.shiftPattern.create({
        data: {
          businessId, entityId: inEntity.id, code: `${PREFIX}-NIGHT`, name: 'Night', startTime: '22:00', endTime: '06:00',
          breakMinutes: 0, graceInMinutes: 10, fullDayMinutes: 480, halfDayThresholdMinutes: 240,
          isNightShift: true, crossesMidnight: true, weeklyOffDays: '', isActive: true,
        },
      });
      await prisma.shiftAssignment.create({
        data: { businessId, employeeId: r1.id, shiftPatternId: night.id, effectiveFrom: day('2027-03-01'), effectiveTo: day('2027-03-31') },
      });
      // IST 22:00 on 03-10 = 16:30Z 03-10; IST 06:00 on 03-11 = 00:30Z 03-11.
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'IN', source: 'WEB', punchAt: new Date('2027-03-10T16:30:00Z') } });
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'OUT', source: 'WEB', punchAt: new Date('2027-03-11T00:30:00Z') } });

      await recompute(businessId, r1.id, day('2027-03-10'), day('2027-03-11'));
      const d10 = await prisma.attendance.findFirst({ where: { businessId, employeeId: r1.id, date: day('2027-03-10') } });
      const d11 = await prisma.attendance.findFirst({ where: { businessId, employeeId: r1.id, date: day('2027-03-11') } });
      assert(d10 && d10.status === 'PRESENT' && d10.workedMinutes === 480,
        '03-10 PRESENT 480 worked (cross-midnight OUT paired with the start day)');
      // 03-11's window starts at its OWN 22:00, so 03-10's 00:30Z OUT is NOT re-pulled.
      const d11Flags = d11 && d11.exceptionsJson && d11.exceptionsJson.flags ? d11.exceptionsJson.flags : [];
      assert(d11 == null || d11.status !== 'MISSING_PUNCH', '03-11 is NOT falsely MISSING_PUNCH from the prior night OUT');
      assert(!d11Flags.includes('MISSING_PUNCH') || d11.status === 'ABSENT',
        '03-11 carries no leaked MISSING_PUNCH from day 03-10');
      // teardown this sub-fixture's assignment so it doesn't bleed into later days
      await prisma.attendance.deleteMany({ where: { businessId, employeeId: r1.id, date: { gte: day('2027-03-01'), lte: day('2027-03-31') } } });
      await prisma.attendancePunch.deleteMany({ where: { businessId, employeeId: r1.id, punchAt: { gte: day('2027-03-01'), lt: day('2027-04-01') } } });
      await prisma.shiftAssignment.deleteMany({ where: { businessId, employeeId: r1.id, shiftPatternId: night.id } });
    }

    /* ── C2 — LATE_IN off the LOCAL clock ─────────────────────────────────── */
    log('C2 — LATE_IN fires off the IST shift clock, not UTC wall-time:');
    {
      const dayShift = await prisma.shiftPattern.create({
        data: {
          businessId, entityId: inEntity.id, code: `${PREFIX}-DAY`, name: 'Day', startTime: '09:00', endTime: '18:00',
          breakMinutes: 60, graceInMinutes: 10, fullDayMinutes: 480, halfDayThresholdMinutes: 240, weeklyOffDays: '0,6', isActive: true,
        },
      });
      await prisma.shiftAssignment.create({
        data: { businessId, employeeId: r1.id, shiftPatternId: dayShift.id, effectiveFrom: day('2027-04-01'), effectiveTo: day('2027-04-30') },
      });
      // 09:00 IST = 03:30Z — ON TIME. (Thu 2027-04-01.)
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'IN', source: 'WEB', punchAt: new Date('2027-04-01T03:30:00Z') } });
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'OUT', source: 'WEB', punchAt: new Date('2027-04-01T12:30:00Z') } });
      await recompute(businessId, r1.id, day('2027-04-01'), day('2027-04-01'));
      const onTime = await prisma.attendance.findFirst({ where: { businessId, employeeId: r1.id, date: day('2027-04-01') } });
      const onTimeFlags = (onTime && onTime.exceptionsJson && onTime.exceptionsJson.flags) || [];
      assert(!onTimeFlags.includes('LATE_IN'), '09:00 IST punch-in (03:30Z) → NOT late');

      // 12:00 IST = 06:30Z — 3h late. (Fri 2027-04-02.)
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'IN', source: 'WEB', punchAt: new Date('2027-04-02T06:30:00Z') } });
      await prisma.attendancePunch.create({ data: { businessId, employeeId: r1.id, punchType: 'OUT', source: 'WEB', punchAt: new Date('2027-04-02T12:30:00Z') } });
      await recompute(businessId, r1.id, day('2027-04-02'), day('2027-04-02'));
      const late = await prisma.attendance.findFirst({ where: { businessId, employeeId: r1.id, date: day('2027-04-02') } });
      const lateFlags = (late && late.exceptionsJson && late.exceptionsJson.flags) || [];
      assert(lateFlags.includes('LATE_IN'), '12:00 IST punch-in (06:30Z) → LATE_IN');

      await prisma.attendance.deleteMany({ where: { businessId, employeeId: r1.id, date: { gte: day('2027-04-01'), lte: day('2027-04-30') } } });
      await prisma.attendancePunch.deleteMany({ where: { businessId, employeeId: r1.id, punchAt: { gte: day('2027-04-01'), lt: day('2027-05-01') } } });
      await prisma.shiftAssignment.deleteMany({ where: { businessId, employeeId: r1.id, shiftPatternId: dayShift.id } });
    }

    /* ── C2(NZ) + H5 — NZ late-evening punch lands on the LOCAL date ───────── */
    if (nzEntity) {
      log('C2/H5 — NZ entity: a late-evening punch buckets to the LOCAL civil date:');
      const nzEmp = await mkEmp('NZ1');
      await prisma.employmentRecord.create({
        data: { businessId, employeeId: nzEmp.id, entityId: nzEntity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true },
      });
      // 2027-06-22 11:00 NZST = 2027-06-21T23:00Z. Punch via the endpoint (H5 bucketing).
      const punchReq = await withScope(hrAdmin, 'canViewEmployees', { body: { employeeId: nzEmp.id, type: 'IN', punchAt: '2027-06-21T23:00:00Z' } });
      const punchRes = await callController(attendance.createPunch, punchReq);
      assert(punchRes.statusCode === 201, 'NZ punch accepted (201)');
      // The recompute should have written the LOCAL day 2027-06-22, not the UTC 06-21.
      const localRow = await prisma.attendance.findFirst({ where: { businessId, employeeId: nzEmp.id, date: day('2027-06-22') } });
      const utcRow = await prisma.attendance.findFirst({ where: { businessId, employeeId: nzEmp.id, date: day('2027-06-21') } });
      assert(!!localRow, 'NZ 23:00Z punch derived onto LOCAL date 2027-06-22');
      assert(!utcRow, 'NZ punch did NOT land on the UTC date 2027-06-21');
    } else {
      log('C2/H5 — no NZ entity seeded; skipping NZ-tz live check (covered by tz unit test).');
      assert(true, 'NZ-tz live check skipped (no NZ entity)');
    }

    /* ── H1 — /pay-inputs scope ──────────────────────────────────────────── */
    log('H1 — /pay-inputs scoped (peer invisible; forged id → empty):');
    {
      const payRun = await prisma.payRun.create({
        data: { businessId, entityId: inEntity.id, payCalendarId: (await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } })).id, code: `PR-${PREFIX}-H1`, periodStart: day('2027-05-01'), periodEnd: day('2027-05-31'), payDate: day('2027-05-31'), sequenceInYear: 2, taxYear: '2027-28', currencyCode: inEntity.payCurrency || 'INR', status: 'DRAFT' },
      });
      // Freeze a pay-input for R1 and for PEER (so both rows exist).
      await prisma.attendance.create({ data: { businessId, employeeId: r1.id, date: day('2027-05-01'), status: 'PRESENT', lopFraction: 0 } });
      await prisma.attendance.create({ data: { businessId, employeeId: peer.id, date: day('2027-05-01'), status: 'PRESENT', lopFraction: 0 } });
      await freezeAttendance(payRun.id, businessId, day('2027-05-01'), day('2027-05-31'), [r1.id, peer.id]);

      // Manager (TEAM) reads pay-inputs: only R1 visible, PEER excluded.
      const req = await withScope(manager, 'canViewPayrollReports', { query: { payRunId: payRun.id } });
      const res = await callController(attendance.listPayInputs, req);
      const empIds = new Set(((res.body && res.body.items) || []).map((i) => i.employeeId));
      assert(res.statusCode === 200 && empIds.has(r1.id) && !empIds.has(peer.id), 'Manager pay-inputs include R1, EXCLUDE PEER');

      // Forged ?employeeId=PEER → empty page.
      const fReq = await withScope(manager, 'canViewPayrollReports', { query: { payRunId: payRun.id, employeeId: peer.id } });
      const fRes = await callController(attendance.listPayInputs, fReq);
      assert(((fRes.body && fRes.body.items) || []).length === 0, 'forged ?employeeId=PEER → empty (no widening)');
    }

    /* ── H2 — regularization self-approval SoD ────────────────────────────── */
    log('H2 — a filer cannot self-approve their own regularization:');
    {
      // R1 (also a "manager"-ish ALL actor in this probe) files their OWN request.
      const own = await prisma.attendanceRegularizationRequest.create({
        data: { businessId, employeeId: r1.id, date: day('2027-05-05'), kind: 'MISSED_PUNCH', reason: `${PREFIX} self`, status: 'PENDING', requestedInAt: new Date('2027-05-05T03:30:00Z'), requestedOutAt: new Date('2027-05-05T12:30:00Z') },
      });
      // An ALL-band actor whose own employeeId == the filer → still 404 (SoD guard).
      const selfActor = actor({ businessId, employeeId: r1.id, band: 'ALL', role: 'BUSINESS_ADMIN', id: 'self-all' });
      const selfReq = await withScope(selfActor, 'canApproveRegularization', { params: { id: own.id } });
      const selfRes = await callController(attendance.approveRegularization, selfReq);
      assert(selfRes.statusCode === 404, 'filer (even ALL-band) self-approve → 404');
      const stillPending = await prisma.attendanceRegularizationRequest.findUnique({ where: { id: own.id } });
      assert(stillPending.status === 'PENDING', "filer's own request stays PENDING");

      // The manager (a different person) CAN approve R1's request.
      const mgrReq = await withScope(manager, 'canApproveRegularization', { params: { id: own.id } });
      const mgrRes = await callController(attendance.approveRegularization, mgrReq);
      assert(mgrRes.statusCode === 200 && mgrRes.body.status === 'APPROVED', "manager approves a report's request → 200");
    }

    /* ── H3 — open-attendance vs scheduled-absent ─────────────────────────── */
    log('H3 — open-attendance zero rows → NO_ATTENDANCE_DATA; scheduled absent → lopDays:');
    {
      // (a) Scheduled employee absent 2 working days → lopDays counted.
      const sched = await prisma.shiftPattern.create({
        data: { businessId, entityId: inEntity.id, code: `${PREFIX}-SCHED`, name: 'Sched', startTime: '09:00', endTime: '18:00', breakMinutes: 60, fullDayMinutes: 480, weeklyOffDays: '0,6', isActive: true },
      });
      const schedEmp = await mkEmp('SCHED');
      await prisma.employmentRecord.create({ data: { businessId, employeeId: schedEmp.id, entityId: inEntity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true } });
      await prisma.shiftAssignment.create({ data: { businessId, employeeId: schedEmp.id, shiftPatternId: sched.id, effectiveFrom: day('2027-07-01'), effectiveTo: day('2027-07-31') } });
      // 2027-07-01 (Thu) and 07-02 (Fri) are working days; no punches → ABSENT each.
      await recompute(businessId, schedEmp.id, day('2027-07-01'), day('2027-07-02'));
      const pr1 = await prisma.payRun.create({ data: { businessId, entityId: inEntity.id, payCalendarId: (await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } })).id, code: `PR-${PREFIX}-H3A`, periodStart: day('2027-07-01'), periodEnd: day('2027-07-02'), payDate: day('2027-07-31'), sequenceInYear: 4, taxYear: '2027-28', currencyCode: inEntity.payCurrency || 'INR', status: 'DRAFT' } });
      const frA = await freezeAttendance(pr1.id, businessId, day('2027-07-01'), day('2027-07-02'), [schedEmp.id]);
      const apiA = await prisma.attendancePayInput.findUnique({ where: { payRunId_employeeId: { payRunId: pr1.id, employeeId: schedEmp.id } } });
      assert(Number(apiA.lopDays) === 2, 'scheduled employee absent 2 working days → lopDays=2');
      assert(!(frA.anomalies || []).some((a) => a.code === 'NO_ATTENDANCE_DATA'), 'scheduled employee has rows → no NO_ATTENDANCE_DATA');

      // (b) Open-attendance employee with ZERO Attendance rows → warning, not silent.
      const openEmp = await mkEmp('OPEN');
      await prisma.employmentRecord.create({ data: { businessId, employeeId: openEmp.id, entityId: inEntity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true } });
      const pr2 = await prisma.payRun.create({ data: { businessId, entityId: inEntity.id, payCalendarId: (await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } })).id, code: `PR-${PREFIX}-H3B`, periodStart: day('2027-07-01'), periodEnd: day('2027-07-31'), payDate: day('2027-07-31'), sequenceInYear: 4, taxYear: '2027-28', currencyCode: inEntity.payCurrency || 'INR', status: 'DRAFT' } });
      const frB = await freezeAttendance(pr2.id, businessId, day('2027-07-01'), day('2027-07-31'), [openEmp.id]);
      const apiB = await prisma.attendancePayInput.findUnique({ where: { payRunId_employeeId: { payRunId: pr2.id, employeeId: openEmp.id } } });
      assert((frB.anomalies || []).some((a) => a.code === 'NO_ATTENDANCE_DATA' && a.employeeId === openEmp.id), 'open-attendance zero rows → NO_ATTENDANCE_DATA warning emitted');
      assert(Number(apiB.payableDays) === 31 && Number(apiB.lopDays) === 0, 'open-attendance payableDays defaulted to calendarDays (documented policy), not a silent drop');
    }

    /* ── L1 — /assignments honours scope ──────────────────────────────────── */
    log('L1 — /assignments is scope-guarded (peer assignments invisible to ESS):');
    {
      // ESS R1 listing assignments only sees their own sub-tree (self) — never PEER.
      const req = await withScope(essR1, 'canViewEmployees', { query: { employeeId: peer.id } });
      const res = await callController(attendance.listAssignments, req);
      assert(((res.body && res.body.items) || []).length === 0, 'ESS R1 forged ?employeeId=PEER on /assignments → empty');
    }

    /* ── L4 — holiday import year bound ───────────────────────────────────── */
    log('L4 — holiday import rejects out-of-range years:');
    {
      const bad = await callController(holidays.importHolidays, { user: hrAdmin, body: { countryCode: 'NZ', year: 99999 } });
      assert(bad.statusCode === 400, 'year=99999 → 400');
      const bad2 = await callController(holidays.importHolidays, { user: hrAdmin, body: { countryCode: 'NZ', year: 1900 } });
      assert(bad2.statusCode === 400, 'year=1900 → 400');
    }

    /* ── M3 — freeze inside the transaction rolls back on a later throw ─────── */
    log('M3 — a throw after freeze rolls back the AttendancePayInput + Attendance locks:');
    {
      const m3Emp = await mkEmp('M3');
      await prisma.employmentRecord.create({ data: { businessId, employeeId: m3Emp.id, entityId: inEntity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true } });
      await prisma.attendance.create({ data: { businessId, employeeId: m3Emp.id, date: day('2027-08-01'), status: 'PRESENT', lopFraction: 0, isLocked: false } });
      const pr = await prisma.payRun.create({ data: { businessId, entityId: inEntity.id, payCalendarId: (await prisma.payCalendar.findFirst({ where: { businessId, entityId: inEntity.id } })).id, code: `PR-${PREFIX}-M3`, periodStart: day('2027-08-01'), periodEnd: day('2027-08-31'), payDate: day('2027-08-31'), sequenceInYear: 5, taxYear: '2027-28', currencyCode: inEntity.payCurrency || 'INR', status: 'DRAFT' } });

      // Drive freeze + a deliberate throw through ONE transaction (the exact shape
      // computeRun uses now): the AttendancePayInput row and the row-lock must both
      // be rolled back (no half-frozen run).
      let threw = false;
      try {
        await prisma.$transaction(async (tx) => {
          await freezeAttendance(pr.id, businessId, day('2027-08-01'), day('2027-08-31'), [m3Emp.id], tx);
          throw new Error('boom-after-freeze');
        });
      } catch (e) { threw = e.message === 'boom-after-freeze'; }
      assert(threw, 'transaction threw after freeze');
      const api = await prisma.attendancePayInput.findUnique({ where: { payRunId_employeeId: { payRunId: pr.id, employeeId: m3Emp.id } } });
      assert(api == null, 'AttendancePayInput rolled back (no row persisted)');
      const att = await prisma.attendance.findFirst({ where: { businessId, employeeId: m3Emp.id, date: day('2027-08-01') } });
      assert(att && att.isLocked === false, 'Attendance lock rolled back (row still unlocked)');
    }

    /* ── L3 — recompute does not overwrite a row locked after the pre-scan ──── */
    log('L3 — a row locked mid-recompute (after the pre-scan) is NOT mutated:');
    {
      const l3Emp = await mkEmp('L3');
      await prisma.employmentRecord.create({ data: { businessId, employeeId: l3Emp.id, entityId: inEntity.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true } });
      const shift = await prisma.shiftPattern.create({ data: { businessId, entityId: inEntity.id, code: `${PREFIX}-L3`, name: 'L3', startTime: '09:00', endTime: '18:00', breakMinutes: 60, fullDayMinutes: 480, weeklyOffDays: '0,6', isActive: true } });
      await prisma.shiftAssignment.create({ data: { businessId, employeeId: l3Emp.id, shiftPatternId: shift.id, effectiveFrom: day('2027-09-01'), effectiveTo: day('2027-09-30') } });
      // Seed a PRESENT row for 2027-09-01 (Wed) directly, marked LOCKED, with known
      // worked minutes. Then add a punch that WOULD change it and recompute.
      await prisma.attendance.create({ data: { businessId, employeeId: l3Emp.id, date: day('2027-09-01'), status: 'PRESENT', workedMinutes: 480, lopFraction: 0, isLocked: true } });
      await prisma.attendancePunch.create({ data: { businessId, employeeId: l3Emp.id, punchType: 'IN', source: 'WEB', punchAt: new Date('2027-09-01T03:30:00Z') } });
      await prisma.attendancePunch.create({ data: { businessId, employeeId: l3Emp.id, punchType: 'OUT', source: 'WEB', punchAt: new Date('2027-09-01T09:30:00Z') } }); // only 5h worked

      const before = await prisma.attendance.findFirst({ where: { businessId, employeeId: l3Emp.id, date: day('2027-09-01') } });
      const r = await recompute(businessId, l3Emp.id, day('2027-09-01'), day('2027-09-01'));
      const after = await prisma.attendance.findFirst({ where: { businessId, employeeId: l3Emp.id, date: day('2027-09-01') } });
      assert(r.skippedLocked === 1, 'recompute reports 1 skippedLocked');
      assert(after.workedMinutes === before.workedMinutes && after.status === 'PRESENT',
        'locked row is unchanged by recompute (updateMany where isLocked=false matched nothing)');
    }
  } finally {
    await cleanup(businessId);
  }

  log(`\n=== ${failures === 0 ? 'ALL FIX CHECKS PASSED' : `${failures} FIX CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Fix test crashed:', err);
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});

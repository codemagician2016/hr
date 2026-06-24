'use strict';

/**
 * engagement.reviewFixes.test.js — LIVE proof of the Cycle-1 engagement REVIEW FIXES
 * against the isolated hr_test schema (plain-node runner, no jest), mirroring
 * engagement.announcements.test.js.
 *
 * Fixes proven (the owner's verify list):
 *   (1) RE-PUBLISH IDEMPOTENCY — a re-publish of an already-PUBLISHED announcement does
 *       NOT re-notify (the fan-out fires only on the first DRAFT→PUBLISHED transition).
 *   (2) TERMINATED ESS LOCKOUT — a terminated/inactive employee is blocked (403) from
 *       feed / unread-count / mark-read / mark-all / celebrations.
 *   (3) DIRECTORY CALLER LOCKOUT — a terminated/inactive caller is blocked (403) from the
 *       directory list / filters / detail (no active-roster + work-email phishing list).
 *   (4) CELEBRATION OPT-OUT WRITE — the self-service opt-out is settable AND then honored
 *       (the employee disappears from the company celebration feed after setting it).
 *   (5) MARK-READ ANOTHER'S ANNOUNCEMENT — an out-of-audience mark-read still 404s
 *       (no cross-audience read receipt). [regression guard]
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/__tests__/engagement.reviewFixes.test.js
 *   where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const prisma = require('../../core/lib/prisma');
const adminCtl = require('../engagement/controllers/announcementsAdmin.controller');
const meCtl = require('../engagement/controllers/meEngagement.controller');
const dirCtl = require('../profile/meDirectory.controller');
const annSvc = require('../engagement/announcements.service');
const notifications = require('../integrations/notifications');

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

const PREFIX = 'ENG-RFX';
function operatorReq(businessId, extra = {}) {
  return { user: { id: `${PREFIX}-op`, businessId, name: 'HR Admin', role: 'BUSINESS_ADMIN' }, params: {}, query: {}, body: {}, ...extra };
}
function essReq(businessId, email, extra = {}) {
  return { customer: { id: `${PREFIX}-cust`, businessId, email }, params: {}, query: {}, body: {}, ...extra };
}

async function cleanup(businessId) {
  await prisma.announcementRead.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.announcement.deleteMany({ where: { businessId, title: { startsWith: PREFIX } } });
  await prisma.employmentRecord.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true, userId: true } });
  const userIds = emps.map((e) => e.userId).filter(Boolean);
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.department.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.entity.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Engagement REVIEW FIXES (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  // Spy on the multi-channel fan-out (notifyHrEvent) so we can COUNT pushes per publish.
  const sent = [];
  const origNotify = notifications.notifyHrEvent;
  notifications.notifyHrEvent = async (args) => { sent.push(args); return { ok: true, spied: true }; };

  const entity = await prisma.entity.create({
    data: { businessId, code: `${PREFIX}-E`, legalName: `${PREFIX} Entity`, countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata', activeFrom: new Date('2020-01-01') },
  });
  const dept = await prisma.department.create({ data: { businessId, code: `${PREFIX}-D1`, name: `${PREFIX} Eng` } });

  const today = new Date();
  const plusDaysDate = (n) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + n));

  async function mkEmployee(tag, email, opts = {}) {
    const user = await prisma.user.create({ data: { email, name: `${PREFIX} ${tag}`, role: 'USER', businessId, password: 'x' } });
    const emp = await prisma.employee.create({
      data: {
        businessId, code: `${PREFIX}-${tag}`, firstName: tag, lastName: 'T',
        status: opts.status || 'ACTIVE', isActive: opts.isActive !== undefined ? opts.isActive : true,
        workEmail: email, userId: user.id,
        dateOfBirth: opts.dateOfBirth || null, hireDate: opts.hireDate || null,
        notifyPrefs: opts.notifyPrefs || null,
      },
    });
    await prisma.employmentRecord.create({
      data: {
        businessId, employeeId: emp.id, entityId: entity.id, departmentId: dept.id,
        employmentType: 'FULL_TIME', workerCategory: 'STAFF',
        effectiveFrom: new Date('2020-01-01'), isCurrent: true, changeReason: 'HIRE',
      },
    });
    return emp;
  }

  const bdayTomorrow = plusDaysDate(1);
  // ACTIVE employees A,B (in audience) — celebrations: both have a birthday tomorrow.
  const A = await mkEmployee('A', `${PREFIX.toLowerCase()}-a@x.test`, {
    dateOfBirth: new Date(Date.UTC(1990, bdayTomorrow.getUTCMonth(), bdayTomorrow.getUTCDate())),
  });
  const B = await mkEmployee('B', `${PREFIX.toLowerCase()}-b@x.test`, {
    dateOfBirth: new Date(Date.UTC(1992, bdayTomorrow.getUTCMonth(), bdayTomorrow.getUTCDate())),
  });
  // TERMINATED employee T (was in audience) — must be locked out of every ESS surface.
  const T = await mkEmployee('T', `${PREFIX.toLowerCase()}-t@x.test`, { status: 'TERMINATED', isActive: false });
  // INACTIVE (isActive=false but ACTIVE status) employee I — also locked out.
  const I = await mkEmployee('I', `${PREFIX.toLowerCase()}-i@x.test`, { status: 'ACTIVE', isActive: false });

  try {
    // ════════════════════════════════════════════════════════════════════════
    // (1) RE-PUBLISH IDEMPOTENCY
    // ════════════════════════════════════════════════════════════════════════
    log('(1) Re-publish does NOT re-blast the audience:');
    let res = await call(adminCtl.create, operatorReq(businessId, {
      body: { title: `${PREFIX} All hands`, bodyRichText: 'Company news', audienceScope: 'ALL' },
    }));
    assert(res.statusCode === 201, 'create DRAFT → 201');
    const annId = res.body.announcement.id;

    sent.length = 0;
    const pub1 = await call(adminCtl.publish, operatorReq(businessId, { params: { id: annId } }));
    assert(pub1.statusCode === 200 && pub1.body.announcement.status === 'PUBLISHED', 'first publish → PUBLISHED');
    const firstNotified = pub1.body.notified;
    const firstPushes = sent.length;
    assert(firstNotified > 0, `first publish fans out (notified=${firstNotified})`);
    const stamped = await prisma.announcement.findUnique({ where: { id: annId }, select: { notifiedAt: true } });
    assert(stamped.notifiedAt != null, 'notifiedAt stamped on first publish');

    // Re-publish the SAME (already-PUBLISHED) announcement — must NOT re-notify.
    sent.length = 0;
    const pub2 = await call(adminCtl.publish, operatorReq(businessId, { params: { id: annId } }));
    assert(pub2.statusCode === 200, 're-publish still 200');
    assert(pub2.body.notified === 0, `re-publish notified=0 (was ${firstNotified}) — no re-blast`);
    assert(sent.length === 0, `re-publish fired 0 multi-channel pushes (first fired ${firstPushes})`);
    // No duplicate in-app notifications were written either.
    const inappCount = await prisma.notification.count({ where: { businessId, entityType: 'Announcement', entityId: annId } });
    assert(inappCount === firstNotified, `in-app notifications NOT duplicated (=${inappCount}, first=${firstNotified})`);

    // Archive then re-publish: notifiedAt already set + prior status not first-publish → still no re-blast.
    await call(adminCtl.archive, operatorReq(businessId, { params: { id: annId } }));
    sent.length = 0;
    const pub3 = await call(adminCtl.publish, operatorReq(businessId, { params: { id: annId } }));
    assert(pub3.body.notified === 0 && sent.length === 0, 'archive→re-publish does NOT re-blast (notifiedAt guard holds)');

    // ════════════════════════════════════════════════════════════════════════
    // (2) TERMINATED / INACTIVE ESS ENGAGEMENT LOCKOUT
    // ════════════════════════════════════════════════════════════════════════
    log('(2) Terminated/inactive employee is locked out of engagement:');
    // Active A can read the feed (baseline).
    const feedA = await call(meCtl.feed, essReq(businessId, A.workEmail));
    assert(feedA.statusCode === 200, 'ACTIVE employee A reads the feed (200)');

    for (const [label, emp] of [['TERMINATED', T], ['INACTIVE', I]]) {
      const fFeed = await call(meCtl.feed, essReq(businessId, emp.workEmail));
      assert(fFeed.statusCode === 403, `${label} employee feed → 403`);
      const fUnread = await call(meCtl.unreadCount, essReq(businessId, emp.workEmail));
      assert(fUnread.statusCode === 403, `${label} employee unread-count → 403`);
      const fCeleb = await call(meCtl.celebrations, essReq(businessId, emp.workEmail));
      assert(fCeleb.statusCode === 403, `${label} employee celebrations → 403`);
      const fMark = await call(meCtl.markRead, essReq(businessId, emp.workEmail, { params: { id: annId } }));
      assert(fMark.statusCode === 403, `${label} employee mark-read → 403`);
      const fAll = await call(meCtl.markAllRead, essReq(businessId, emp.workEmail));
      assert(fAll.statusCode === 403, `${label} employee mark-all-read → 403`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // (3) DIRECTORY CALLER LOCKOUT (terminated/inactive caller)
    // ════════════════════════════════════════════════════════════════════════
    log('(3) Terminated/inactive caller is blocked from the directory:');
    const dirA = await call(dirCtl.list, essReq(businessId, A.workEmail));
    assert(dirA.statusCode === 200, 'ACTIVE caller A gets the directory (200)');

    for (const [label, emp] of [['TERMINATED', T], ['INACTIVE', I]]) {
      const dList = await call(dirCtl.list, essReq(businessId, emp.workEmail));
      assert(dList.statusCode === 403, `${label} caller directory list → 403 (no roster/email phishing list)`);
      const dFilters = await call(dirCtl.filters, essReq(businessId, emp.workEmail));
      assert(dFilters.statusCode === 403, `${label} caller directory filters → 403`);
      const dDetail = await call(dirCtl.detail, essReq(businessId, emp.workEmail, { params: { id: A.id } }));
      assert(dDetail.statusCode === 403, `${label} caller directory detail → 403`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // (4) CELEBRATION OPT-OUT WRITE PATH (settable + then honored)
    // ════════════════════════════════════════════════════════════════════════
    log('(4) Celebration opt-out is settable and then honored:');
    // Before opt-out: B appears in A's celebration feed.
    const before = await call(meCtl.celebrations, essReq(businessId, A.workEmail, { query: { windowDays: 7 } }));
    const seesB = (r) => (r.body.birthdays || []).some((x) => x.employeeId === B.id);
    assert(seesB(before), 'B is visible in the celebration feed before opt-out');

    // B reads their own pref (default false).
    const prefGet = await call(meCtl.getCelebrationPreferences, essReq(businessId, B.workEmail));
    assert(prefGet.statusCode === 200 && prefGet.body.celebrationsOptOut === false, 'GET preferences → optOut:false by default');

    // Bad input rejected.
    const badSet = await call(meCtl.updateCelebrationPreferences, essReq(businessId, B.workEmail, { body: { celebrationsOptOut: 'yes' } }));
    assert(badSet.statusCode === 400, 'non-boolean opt-out → 400');

    // B opts OUT (the WRITE path).
    const setOut = await call(meCtl.updateCelebrationPreferences, essReq(businessId, B.workEmail, { body: { celebrationsOptOut: true } }));
    assert(setOut.statusCode === 200 && setOut.body.celebrationsOptOut === true, 'PATCH opt-out:true → 200');
    // Persisted into notifyPrefs.celebrationsOptOut.
    const bRow = await prisma.employee.findUnique({ where: { id: B.id }, select: { notifyPrefs: true } });
    assert(bRow.notifyPrefs && bRow.notifyPrefs.celebrationsOptOut === true, 'notifyPrefs.celebrationsOptOut persisted true');
    // Read-back reflects it.
    const prefGet2 = await call(meCtl.getCelebrationPreferences, essReq(businessId, B.workEmail));
    assert(prefGet2.body.celebrationsOptOut === true, 'GET preferences now → optOut:true');

    // HONORED: B now hidden from A's celebration feed.
    const after = await call(meCtl.celebrations, essReq(businessId, A.workEmail, { query: { windowDays: 7 } }));
    assert(!seesB(after), 'B is HIDDEN from the celebration feed after opt-out (honored)');
    // A (not opted out) still appears.
    assert((after.body.birthdays || []).some((x) => x.employeeId === A.id), 'A (not opted out) still appears');

    // Toggle back ON — opt-out is fully settable both ways; sibling keys survive.
    await prisma.employee.update({ where: { id: B.id }, data: { notifyPrefs: { celebrationsOptOut: true, optOut: true } } });
    const setBack = await call(meCtl.updateCelebrationPreferences, essReq(businessId, B.workEmail, { body: { celebrationsOptOut: false } }));
    assert(setBack.body.celebrationsOptOut === false, 'PATCH opt-out:false → 200 (settable both ways)');
    const bRow2 = await prisma.employee.findUnique({ where: { id: B.id }, select: { notifyPrefs: true } });
    assert(bRow2.notifyPrefs.optOut === true, 'sibling notifyPrefs key (optOut) preserved through the merge');

    // ════════════════════════════════════════════════════════════════════════
    // (5) MARK-READ ANOTHER'S ANNOUNCEMENT (regression guard)
    // ════════════════════════════════════════════════════════════════════════
    log('(5) An employee cannot mark-read an out-of-audience announcement:');
    // Department-scoped announcement to a DIFFERENT department (none here) → A not in audience.
    const dres = await call(adminCtl.create, operatorReq(businessId, {
      body: { title: `${PREFIX} Other dept`, bodyRichText: 'x', audienceScope: 'SPECIFIC', audienceEmployeeIds: [B.id] },
    }));
    const specificId = dres.body.announcement.id;
    await call(adminCtl.publish, operatorReq(businessId, { params: { id: specificId } }));
    const aMark = await call(meCtl.markRead, essReq(businessId, A.workEmail, { params: { id: specificId } }));
    assert(aMark.statusCode === 404, "A marking B-only announcement → 404 (no cross-audience receipt)");
  } finally {
    notifications.notifyHrEvent = origNotify;
    await cleanup(businessId);
  }

  log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1); });

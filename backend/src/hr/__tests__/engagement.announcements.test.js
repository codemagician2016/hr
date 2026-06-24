'use strict';

/**
 * engagement.announcements.test.js — LIVE proof of the Cycle-1 engagement surfaces
 * (announcements news feed + celebration feed) against the isolated hr_test schema,
 * plain-node runner (no jest), mirroring scope.rbac.test.js / tenant-isolation.idor.
 *
 * Fixture (one teardown, inside the seed 'demo' tenant):
 *   Two departments D1, D2 under one entity E.
 *   Three employees, each with a portal Customer + linked User + a CURRENT
 *   EmploymentRecord:
 *       A → dept D1   (workEmail a@…)
 *       B → dept D2   (workEmail b@…)
 *       C → dept D1   (workEmail c@…), DOB tomorrow, hireDate 3y-ago-tomorrow,
 *                       and a SECOND employee O that OPTED OUT of celebrations.
 *
 * Cases (owner's verify list):
 *   (1) admin publishes a DEPARTMENT-scoped (D1) announcement → A & C see it, B does NOT.
 *   (2) an ALL announcement → everyone sees it.
 *   (3) pinned-first + expiry honored (an expired one is absent; a pinned one leads).
 *   (4) mark-as-read flips read state + drops the unread count by one.
 *   (5) celebration feed returns upcoming birthday/anniversary within the window,
 *       respects opt-out (O absent), and leaks NO DOB year (only month/day).
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/__tests__/engagement.announcements.test.js
 *   where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const prisma = require('../../core/lib/prisma');
const adminCtl = require('../engagement/controllers/announcementsAdmin.controller');
const meCtl = require('../engagement/controllers/meEngagement.controller');

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
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'ENG-TEST';
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
  log('\n=== Engagement: announcements + celebrations (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  // ── Fixture ────────────────────────────────────────────────────────────────
  const entity = await prisma.entity.create({
    data: { businessId, code: `${PREFIX}-E`, legalName: `${PREFIX} Entity`, countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata', activeFrom: new Date('2020-01-01') },
  });
  const d1 = await prisma.department.create({ data: { businessId, code: `${PREFIX}-D1`, name: `${PREFIX} Eng` } });
  const d2 = await prisma.department.create({ data: { businessId, code: `${PREFIX}-D2`, name: `${PREFIX} Sales` } });

  // Helper: civil DATE for a month/day offset from today (UTC), year-agnostic anchor.
  const today = new Date();
  const plusDaysDate = (n) => { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + n)); return d; };

  async function mkEmployee(tag, deptId, email, opts = {}) {
    const user = await prisma.user.create({
      data: { email, name: `${PREFIX} ${tag}`, role: 'USER', businessId, password: 'x' },
    });
    const emp = await prisma.employee.create({
      data: {
        businessId, code: `${PREFIX}-${tag}`, firstName: tag, lastName: 'T', status: 'ACTIVE', isActive: true,
        workEmail: email, userId: user.id,
        dateOfBirth: opts.dateOfBirth || null,
        hireDate: opts.hireDate || null,
        notifyPrefs: opts.notifyPrefs || null,
      },
    });
    await prisma.employmentRecord.create({
      data: {
        businessId, employeeId: emp.id, entityId: entity.id, departmentId: deptId,
        employmentType: 'FULL_TIME', workerCategory: 'STAFF',
        effectiveFrom: new Date('2020-01-01'), isCurrent: true, changeReason: 'HIRE',
      },
    });
    return emp;
  }

  const bdayTomorrow = plusDaysDate(1);          // birthday in 1 day (in window)
  const annivTomorrow = plusDaysDate(1);         // anniversary in 1 day
  const A = await mkEmployee('A', d1.id, `${PREFIX.toLowerCase()}-a@x.test`);
  const B = await mkEmployee('B', d2.id, `${PREFIX.toLowerCase()}-b@x.test`);
  const C = await mkEmployee('C', d1.id, `${PREFIX.toLowerCase()}-c@x.test`, {
    // DOB three decades ago on tomorrow's month/day (year must NOT leak); anniversary 3y.
    dateOfBirth: new Date(Date.UTC(1990, bdayTomorrow.getUTCMonth(), bdayTomorrow.getUTCDate())),
    hireDate: new Date(Date.UTC(today.getUTCFullYear() - 3, annivTomorrow.getUTCMonth(), annivTomorrow.getUTCDate())),
  });
  // Opted-out employee with a birthday tomorrow — must be hidden everywhere.
  const O = await mkEmployee('O', d1.id, `${PREFIX.toLowerCase()}-o@x.test`, {
    dateOfBirth: new Date(Date.UTC(1985, bdayTomorrow.getUTCMonth(), bdayTomorrow.getUTCDate())),
    notifyPrefs: { celebrationsOptOut: true },
  });

  try {
    // ── (1) DEPARTMENT-scoped publish → only D1 (A,C) see it; D2 (B) does not ──
    log('(1) Department-scoped announcement reaches only that department:');
    let res = await call(adminCtl.create, operatorReq(businessId, {
      body: { title: `${PREFIX} D1 only`, bodyRichText: 'Eng team note', category: 'NEWS',
              audienceScope: 'DEPARTMENT', audienceDeptIds: [d1.id] },
    }));
    assert(res.statusCode === 201, 'admin create DRAFT → 201');
    const deptAnnId = res.body.announcement.id;
    res = await call(adminCtl.publish, operatorReq(businessId, { params: { id: deptAnnId } }));
    assert(res.statusCode === 200 && res.body.announcement.status === 'PUBLISHED', 'publish → PUBLISHED');

    const feedA = await call(meCtl.feed, essReq(businessId, A.workEmail));
    const feedB = await call(meCtl.feed, essReq(businessId, B.workEmail));
    const feedC = await call(meCtl.feed, essReq(businessId, C.workEmail));
    const has = (f, id) => (f.body.items || []).some((x) => x.id === id);
    assert(has(feedA, deptAnnId), 'A (D1) SEES the D1 announcement');
    assert(has(feedC, deptAnnId), 'C (D1) SEES the D1 announcement');
    assert(!has(feedB, deptAnnId), 'B (D2) does NOT see the D1 announcement (out-of-audience)');

    // ── (2) ALL announcement → everyone ─────────────────────────────────────────
    log('(2) ALL-scoped announcement reaches everyone:');
    res = await call(adminCtl.create, operatorReq(businessId, {
      body: { title: `${PREFIX} All hands`, bodyRichText: 'Company news', audienceScope: 'ALL' },
    }));
    const allAnnId = res.body.announcement.id;
    await call(adminCtl.publish, operatorReq(businessId, { params: { id: allAnnId } }));
    const feedB2 = await call(meCtl.feed, essReq(businessId, B.workEmail));
    assert(has(feedB2, allAnnId), 'B sees the ALL announcement');

    // ── (3) pinned-first + expiry honored ───────────────────────────────────────
    log('(3) pinned-first ordering + expiry honored:');
    // An expired ALL announcement (publishedAt past, expiresAt past) → absent.
    res = await call(adminCtl.create, operatorReq(businessId, {
      body: { title: `${PREFIX} Expired`, bodyRichText: 'old', audienceScope: 'ALL',
              publishedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
              expiresAt: new Date(Date.now() - 86400000).toISOString() },
    }));
    const expiredId = res.body.announcement.id;
    await call(adminCtl.publish, operatorReq(businessId, { params: { id: expiredId } }));
    // A pinned ALL announcement → should lead the feed.
    res = await call(adminCtl.create, operatorReq(businessId, {
      body: { title: `${PREFIX} Pinned`, bodyRichText: 'important', audienceScope: 'ALL', pinned: true },
    }));
    const pinnedId = res.body.announcement.id;
    await call(adminCtl.publish, operatorReq(businessId, { params: { id: pinnedId } }));

    const feedAFull = await call(meCtl.feed, essReq(businessId, A.workEmail, { query: { pageSize: 50 } }));
    const items = feedAFull.body.items || [];
    assert(!items.some((x) => x.id === expiredId), 'expired announcement is ABSENT from the feed');
    assert(items.length > 0 && items[0].id === pinnedId, 'pinned announcement leads the feed (pinned-first)');

    // ── (4) mark-as-read + unread count ─────────────────────────────────────────
    log('(4) mark-as-read flips read state + drops unread count:');
    const before = await call(meCtl.unreadCount, essReq(businessId, A.workEmail));
    const unreadBefore = before.body.unread;
    assert(unreadBefore > 0, `A has unread announcements before (=${unreadBefore})`);
    const mr = await call(meCtl.markRead, essReq(businessId, A.workEmail, { params: { id: pinnedId } }));
    assert(mr.statusCode === 200 && mr.body.read === true, 'markRead → 200 read:true');
    const after = await call(meCtl.unreadCount, essReq(businessId, A.workEmail));
    assert(after.body.unread === unreadBefore - 1, `unread count dropped by one (=${after.body.unread})`);
    // idempotent re-read
    await call(meCtl.markRead, essReq(businessId, A.workEmail, { params: { id: pinnedId } }));
    const after2 = await call(meCtl.unreadCount, essReq(businessId, A.workEmail));
    assert(after2.body.unread === after.body.unread, 're-marking the same announcement is idempotent');
    // out-of-audience mark → 404 (B cannot read the D1-only announcement)
    const badMark = await call(meCtl.markRead, essReq(businessId, B.workEmail, { params: { id: deptAnnId } }));
    assert(badMark.statusCode === 404, 'B marking the D1-only announcement → 404 (no cross-audience receipt)');

    // ── (5) celebration feed: window + opt-out + no DOB-year leak ────────────────
    log('(5) celebration feed (window, opt-out, no DOB-year leak):');
    const cel = await call(meCtl.celebrations, essReq(businessId, A.workEmail, { query: { windowDays: 7 } }));
    const bdays = cel.body.birthdays || [];
    const annivs = cel.body.anniversaries || [];
    const cBday = bdays.find((x) => x.employeeId === C.id);
    assert(!!cBday, 'C\'s upcoming birthday is within the 7-day window');
    assert(cBday && cBday.inDays === 1, 'birthday inDays === 1 (tomorrow)');
    assert(cBday && cBday.year === undefined && !('age' in cBday), 'birthday item leaks NO year/age (day/month only)');
    assert(cBday && typeof cBday.month === 'number' && typeof cBday.day === 'number', 'birthday exposes month + day only');
    assert(!bdays.some((x) => x.employeeId === O.id), 'opted-out employee O is HIDDEN from the celebration feed');
    const cAnniv = annivs.find((x) => x.employeeId === C.id);
    assert(!!cAnniv && cAnniv.years === 3, 'C\'s 3-year work anniversary is surfaced with years of service');

  } finally {
    await cleanup(businessId);
  }

  log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1); });

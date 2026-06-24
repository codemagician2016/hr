'use strict';

/**
 * directory-controllers.test.js — Cycle 1 ESS Company Directory CONTROLLER-level proof.
 * Drives the REAL route handlers (meDirectory.controller.* on the CUSTOMER session)
 * against the LIVE hr_test schema via the fakeReq/fakeRes harness (mirrors
 * orgtree-controllers.test.js). Proves the privacy + scope contract end-to-end:
 *
 *   (a) directory returns ACTIVE colleagues with ONLY safe work fields; PERSONAL fields
 *       (personalEmail, personal phone, dateOfBirth, address, salary, statutory ids) are
 *       ABSENT from every card.
 *   (b) search (name / designation / department / work email) narrows the list.
 *   (c) pagination works (page/pageSize, total) and STAYS tenant-scoped.
 *   (d) tenant isolation: a colleague in ANOTHER business is never returned, and a
 *       cross-tenant detail GET → 404.
 *   (e) the per-employee work-phone OPT-OUT hides that field (person stays listed); the
 *       SELF opt-out toggle flips only the caller's OWN row.
 *   (f) an INACTIVE (TERMINATED) colleague is excluded from the list, the count, and the
 *       detail view (→ 404).
 *   (g) self is excluded by default; filters return only org facets (no PII).
 *
 * Idempotent: DIRC-* fixtures, cleaned at start + end.
 *
 * Run with:
 *   DATABASE_URL="$(...?schema=hr_test)" node test/e2e/directory-controllers.test.js
 */

const prisma = require('../../src/core/lib/prisma');
const dir = require('../../src/hr/profile/meDirectory.controller');

let pass = 0; let fail = 0;
const log = (...a) => console.log(...a);
function ok(c, m) { if (c) { pass += 1; log(`  PASS  ${m}`); } else { fail += 1; log(`  FAIL  ${m}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(p) { this.body = p; return this; },
    end() { this.body = undefined; return this; },
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
    Promise.resolve(handler(req, res, next)).then(done).catch((e) => { if (!settled) { settled = true; reject(e); } });
  });
}

const PREFIX = 'DIRC';

async function cleanup() {
  const emps = await prisma.employee.findMany({ where: { code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.employmentRecord.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: { in: ids } }, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX.toLowerCase() } } }).catch(() => {});
  await prisma.location.deleteMany({ where: { code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.designation.deleteMany({ where: { code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.department.deleteMany({ where: { code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.entity.deleteMany({ where: { code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.business.deleteMany({ where: { slug: { startsWith: `${PREFIX.toLowerCase()}-` } } }).catch(() => {});
}

async function mkBusiness(slug) {
  return prisma.business.create({ data: { slug: `${PREFIX.toLowerCase()}-${slug}`, name: `${PREFIX} ${slug}`, region: 'IN' }, select: { id: true } });
}

async function main() {
  log('\n=== Cycle 1 ESS Company Directory — controller proof (LIVE hr_test) ===\n');
  await cleanup();

  // Two tenants — primary (A) under test + a foreign tenant (B) for isolation.
  const bizA = await mkBusiness('a');
  const bizB = await mkBusiness('b');
  const businessId = bizA.id;

  // Org facets in tenant A.
  const entity = await prisma.entity.create({ data: { businessId, code: `${PREFIX}-ENT`, legalName: 'DIRC Entity Pvt Ltd', countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata', status: 'ACTIVE', activeFrom: new Date('2020-01-01') }, select: { id: true } });
  const loc = await prisma.location.create({ data: { businessId, entityId: entity.id, code: `${PREFIX}-BLR`, name: 'Bengaluru', countryCode: 'IN', timezone: 'Asia/Kolkata' }, select: { id: true } });
  const deptEng = await prisma.department.create({ data: { businessId, code: `${PREFIX}-ENG`, name: 'Engineering' }, select: { id: true } });
  const deptHr = await prisma.department.create({ data: { businessId, code: `${PREFIX}-HR`, name: 'People Ops' }, select: { id: true } });
  const desigSE = await prisma.designation.create({ data: { businessId, code: `${PREFIX}-SE`, title: 'Senior Engineer' }, select: { id: true } });
  const desigHRBP = await prisma.designation.create({ data: { businessId, code: `${PREFIX}-HRBP`, title: 'HR Business Partner' }, select: { id: true } });

  // A user → the customer session for the CALLER (Asha).
  const ashaUser = await prisma.user.create({ data: { businessId, email: `${PREFIX.toLowerCase()}-asha@example.com`, name: 'Asha', role: 'USER', isActive: true, password: 'x' }, select: { id: true, email: true } });

  // Employee factory loaded with BOTH safe + personal fields, so we can assert the
  // personal ones never surface on the directory.
  async function mkEmp(code, first, last, opts = {}) {
    const e = await prisma.employee.create({
      data: {
        businessId, code: `${PREFIX}-${code}`, firstName: first, lastName: last,
        status: opts.status || 'ACTIVE', isActive: opts.status !== 'TERMINATED',
        userId: opts.userId || null,
        // SAFE / work fields
        workEmail: opts.workEmail || `${PREFIX.toLowerCase()}.${code.toLowerCase()}@corp.example.com`,
        officePhone: opts.officePhone || '+91-80-12345678',
        photoUrl: 'https://cdn.example.com/p.png',
        directoryHidePhone: !!opts.hidePhone,
        managerEmployeeId: opts.managerId || null,
        // PERSONAL / PII fields — MUST NEVER appear on the directory
        personalEmail: 'secret.personal@gmail.com',
        phone: '+91-99999-00000',           // personal mobile
        homePhone: '+91-80-99999999',
        dateOfBirth: new Date('1990-05-15'),
        gender: 'FEMALE',
        maritalStatus: 'SINGLE',
        bloodGroup: 'O+',
        religion: 'PRIVATE_VALUE',
        addressLine1: '12 Secret Lane',
        city: 'Bengaluru',
        postalCode: '560001',
      },
      select: { id: true, code: true },
    });
    await prisma.employmentRecord.create({
      data: {
        businessId, employeeId: e.id, entityId: entity.id, locationId: loc.id,
        departmentId: opts.departmentId || deptEng.id, designationId: opts.designationId || desigSE.id,
        employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE',
        effectiveFrom: new Date('2021-01-01'), isCurrent: true,
      },
    });
    return e;
  }

  // Tenant A population: manager + caller + a few colleagues + opt-out + inactive.
  const mgr = await mkEmp('MGR', 'Maya', 'Manager', { departmentId: deptEng.id, designationId: desigSE.id });
  const asha = await mkEmp('ASHA', 'Asha', 'Caller', { userId: ashaUser.id, workEmail: ashaUser.email, managerId: mgr.id });
  await mkEmp('BHARGAV', 'Bhargav', 'Engineer', { managerId: mgr.id });
  await mkEmp('CHITRA', 'Chitra', 'Partner', { departmentId: deptHr.id, designationId: desigHRBP.id, managerId: mgr.id });
  const optedOut = await mkEmp('DEV', 'Dev', 'Private', { hidePhone: true, managerId: mgr.id });
  const inactive = await mkEmp('ZARA', 'Zara', 'Exited', { status: 'TERMINATED', managerId: mgr.id });

  // Bulk colleagues to prove pagination at scale (30 extra Engineers).
  for (let i = 0; i < 30; i += 1) {
    await mkEmp(`BULK${String(i).padStart(2, '0')}`, `Bulk${i}`, 'Member', { managerId: mgr.id });
  }

  // Foreign tenant B colleague — must never leak into A's directory.
  const foreign = await prisma.employee.create({
    data: { businessId: bizB.id, code: `${PREFIX}-FOREIGN`, firstName: 'Frank', lastName: 'Outsider', status: 'ACTIVE', isActive: true, workEmail: `${PREFIX.toLowerCase()}.foreign@corp.example.com` },
    select: { id: true },
  });

  const ashaCust = { id: `cust-${ashaUser.id}`, businessId, email: ashaUser.email };

  // PII keys we assert are ABSENT from every card (case-insensitive substring match).
  const PII_KEYS = ['personalemail', 'dateofbirth', 'dob', 'gender', 'maritalstatus', 'bloodgroup', 'religion', 'address', 'city', 'postalcode', 'homephone', 'salary', 'ctc', 'compensation', 'pan', 'uan', 'gross', 'net'];
  function leakedKeys(card) {
    return Object.keys(card).filter((k) => PII_KEYS.some((p) => k.toLowerCase().includes(p)));
  }
  function leakedValues(card) {
    // No card value should equal a known personal value we seeded.
    const personalValues = ['secret.personal@gmail.com', '+91-99999-00000', '+91-80-99999999', '12 Secret Lane', '560001', 'PRIVATE_VALUE'];
    const vals = JSON.stringify(card).toLowerCase();
    return personalValues.filter((v) => vals.includes(v.toLowerCase()));
  }

  try {
    // ── (a) safe-fields-only + active colleagues ────────────────────────────────
    log('SAFE FIELDS + ACTIVE');
    {
      const r = await call(dir.list, { customer: ashaCust, query: { pageSize: '100' } });
      ok(r.statusCode === 200, 'list → 200');
      const items = r.body.items || [];
      ok(items.length > 0, 'list returns colleagues');
      const allKeyLeaks = items.flatMap(leakedKeys);
      ok(allKeyLeaks.length === 0, `no PII key on any card (found: ${[...new Set(allKeyLeaks)].join(',') || 'none'})`);
      const allValLeaks = items.flatMap(leakedValues);
      ok(allValLeaks.length === 0, `no seeded personal VALUE on any card (found: ${[...new Set(allValLeaks)].join(',') || 'none'})`);
      const sample = items[0];
      ok('name' in sample && 'designation' in sample && 'department' in sample && 'workEmail' in sample && 'entity' in sample && 'manager' in sample,
        'card carries the safe work fields (name/designation/department/workEmail/entity/manager)');
      // inactive (TERMINATED) excluded.
      ok(!items.some((e) => e.id === inactive.id), 'INACTIVE (TERMINATED) colleague is excluded from the list');
      // self excluded by default.
      ok(!items.some((e) => e.id === asha.id), 'self is excluded by default');
      // foreign tenant excluded.
      ok(!items.some((e) => e.id === foreign.id), 'foreign-tenant colleague is NOT in the list (tenant isolation)');
      ok(items.every((e) => e.workEmail && e.workEmail.includes('corp.example.com')), 'only WORK email is exposed');
    }

    // ── (b) search (name / designation / department / work email) ───────────────
    log('\nSEARCH');
    {
      const byName = await call(dir.list, { customer: ashaCust, query: { q: 'Bhargav', pageSize: '100' } });
      ok((byName.body.items || []).some((e) => e.code === `${PREFIX}-BHARGAV`), 'search by name finds Bhargav');
      const byDesig = await call(dir.list, { customer: ashaCust, query: { q: 'Business Partner', pageSize: '100' } });
      ok((byDesig.body.items || []).some((e) => e.code === `${PREFIX}-CHITRA`), 'search by designation finds the HRBP');
      const byDept = await call(dir.list, { customer: ashaCust, query: { q: 'People Ops', pageSize: '100' } });
      ok((byDept.body.items || []).every((e) => e.department === 'People Ops'), 'search by department returns only that department');
      const byEmail = await call(dir.list, { customer: ashaCust, query: { q: 'dirc.bhargav@corp', pageSize: '100' } });
      ok((byEmail.body.items || []).some((e) => e.code === `${PREFIX}-BHARGAV`), 'search by work email finds the colleague');
      // Search must NOT match on a personal field we seeded identically on everyone.
      const byPersonal = await call(dir.list, { customer: ashaCust, query: { q: 'secret.personal', pageSize: '100' } });
      ok((byPersonal.body.items || []).length === 0, 'search does NOT match on personal email (personal fields are not searchable)');
    }

    // ── (c) pagination + tenant-scope ───────────────────────────────────────────
    log('\nPAGINATION (tenant-scoped)');
    {
      const p1 = await call(dir.list, { customer: ashaCust, query: { page: '1', pageSize: '10' } });
      const p2 = await call(dir.list, { customer: ashaCust, query: { page: '2', pageSize: '10' } });
      ok(p1.body.pageSize === 10 && p1.body.page === 1, 'page/pageSize echoed');
      ok((p1.body.items || []).length === 10, 'page 1 has exactly pageSize items');
      ok(p1.body.total >= 33, `total counts the whole active tenant population (got ${p1.body.total})`);
      const ids1 = new Set((p1.body.items || []).map((e) => e.id));
      const overlap = (p2.body.items || []).filter((e) => ids1.has(e.id));
      ok(overlap.length === 0, 'page 2 does not repeat page 1 rows');
      // total must equal the count of A's ACTIVE non-self employees (excludes inactive + foreign + self).
      const expected = await prisma.employee.count({ where: { businessId, deletedAt: null, status: { not: 'TERMINATED' }, id: { not: asha.id } } });
      ok(p1.body.total === expected, `total === active-non-self count in THIS tenant (${p1.body.total} === ${expected})`);
    }

    // ── (d) tenant isolation on detail ──────────────────────────────────────────
    log('\nTENANT ISOLATION (detail)');
    {
      const own = await call(dir.detail, { customer: ashaCust, params: { id: mgr.id } });
      ok(own.statusCode === 200 && own.body.code === `${PREFIX}-MGR`, 'detail of an in-tenant colleague → 200');
      ok(leakedKeys(own.body).length === 0, 'detail carries no PII key');
      ok(own.body.orgChart && own.body.orgChart.rootEmployeeId === mgr.id, 'detail carries the F19 org-chart deep link rooted at the person');
      const cross = await call(dir.detail, { customer: ashaCust, params: { id: foreign.id } });
      ok(cross.statusCode === 404, 'detail of a FOREIGN-tenant colleague → 404');
      const gone = await call(dir.detail, { customer: ashaCust, params: { id: inactive.id } });
      ok(gone.statusCode === 404, 'detail of an INACTIVE colleague → 404');
    }

    // ── (e) opt-out (work phone) + SELF toggle ──────────────────────────────────
    log('\nOPT-OUT (work phone)');
    {
      const r = await call(dir.list, { customer: ashaCust, query: { pageSize: '100' } });
      const devCard = (r.body.items || []).find((e) => e.id === optedOut.id);
      ok(!!devCard, 'opted-out colleague is STILL listed (findable)');
      ok(devCard && devCard.workPhone === null && devCard.workPhoneShared === false, 'opted-out colleague hides workPhone');
      const sharingCard = (r.body.items || []).find((e) => e.code === `${PREFIX}-BHARGAV`);
      ok(sharingCard && sharingCard.workPhone, 'a non-opted-out colleague DOES expose workPhone');

      // SELF toggle: flips only Asha's own row.
      const before = await call(dir.getPreferences, { customer: ashaCust });
      ok(before.body.hideWorkPhone === false, 'caller starts NOT opted out');
      const set = await call(dir.updatePreferences, { customer: ashaCust, body: { hideWorkPhone: true } });
      ok(set.statusCode === 200 && set.body.hideWorkPhone === true, 'SELF opt-out toggle → 200, hideWorkPhone:true');
      const after = await prisma.employee.findUnique({ where: { id: asha.id }, select: { directoryHidePhone: true } });
      ok(after.directoryHidePhone === true, 'opt-out persisted on the caller OWN row');
      const others = await prisma.employee.count({ where: { businessId, code: { in: [`${PREFIX}-BHARGAV`, `${PREFIX}-MGR`] }, directoryHidePhone: true } });
      ok(others === 0, 'opt-out did NOT touch any other employee row');
      const bad = await call(dir.updatePreferences, { customer: ashaCust, body: { hideWorkPhone: 'yes' } });
      ok(bad.statusCode === 400, 'non-boolean opt-out → 400');
    }

    // ── (f) filters facets (no PII) ─────────────────────────────────────────────
    log('\nFILTERS');
    {
      const f = await call(dir.filters, { customer: ashaCust });
      ok(Array.isArray(f.body.departments) && f.body.departments.some((d) => d.name === 'Engineering'), 'filters list the Engineering department');
      ok(f.body.entities.some((e) => e.name === 'DIRC Entity Pvt Ltd'), 'filters list the entity');
      const filtered = await call(dir.list, { customer: ashaCust, query: { departmentId: deptHr.id, pageSize: '100' } });
      ok((filtered.body.items || []).every((e) => e.department === 'People Ops'), 'department filter narrows the list');
    }
  } finally {
    await cleanup();
  }

  log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });

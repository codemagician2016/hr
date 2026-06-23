'use strict';

/**
 * employeeOrgWaveA.test.js — WAVE A (Employee/Org backend) proof.
 *
 * Covers the audit-finding fixes in employee.controller + org.controller:
 *   #1 create() maps the admin form (email→workEmail, dateOfJoining→hireDate) and
 *      creates the initial HIRE EmploymentRecord with department/designation/location.
 *   #2 list() returns the joined current-employment Department/Designation/Location
 *      + workEmail/hireDate (the directory columns).
 *   #3 get() surfaces a flat `employment` block (department/designation/location/
 *      grade/band) + workEmail/hireDate.
 *   #4 org.entities.create() accepts the full allow-list (legalName/code/country/
 *      currency/timezone) and rejects a bare {name} the way the buggy UI sent.
 *   #5 update() rejects self-manager + circular manager chains (reporting loop).
 *   #6 update() edits employment (department) by appending a new EmploymentRecord.
 *
 * Plain node runner (no jest), same harness as provision.test.js, against an
 * isolated hr_test schema.
 *
 * Run (needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/__tests__/employeeOrgWaveA.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

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
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res); res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'WAVEA-TEST';

async function main() {
  log('\n=== WAVE A — employee/org controller fixes (create/list/get/update + entity form) ===\n');

  if (!process.env.DATABASE_URL) {
    log('[skip] DATABASE_URL not set — needs the live hr_test schema.\n');
    return;
  }

  const prisma = require('../../core/lib/prisma');
  const empCtrl = require('../controllers/employee.controller');
  const orgCtrl = require('../controllers/org.controller');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  // No employee scope filtering — operate as a full-access admin.
  const user = { id: 'wavea-op', businessId, role: 'BUSINESS_ADMIN' };
  const scope = { kind: 'ALL' };

  const entity = await prisma.entity.findFirst({ where: { businessId, deletedAt: null } });
  if (!entity) throw new Error('No entity in hr_test demo tenant');

  // Pick a real department + designation + location to assign.
  const dept = await prisma.department.findFirst({ where: { businessId, deletedAt: null } });
  const desig = await prisma.designation.findFirst({ where: { businessId, deletedAt: null } });
  const loc = await prisma.location.findFirst({ where: { businessId, deletedAt: null } });

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const ids = emps.map((e) => e.id);
    if (ids.length) {
      await prisma.employee.updateMany({ where: { id: { in: ids } }, data: { currentEmploymentRecordId: null, managerEmployeeId: null } });
      await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.department.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    await prisma.entity.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  }

  await cleanup();

  let createdId = null;
  let mgrAId = null;
  let mgrBId = null;

  try {
    // ════════════════════════════════════════════════════════════════════════
    // #1 create() — maps email→workEmail, dateOfJoining→hireDate, and creates the
    //    initial HIRE EmploymentRecord with department/designation/location.
    // ════════════════════════════════════════════════════════════════════════
    log('#1) create maps admin fields + creates the initial EmploymentRecord:');
    {
      const r = await callController(empCtrl.create, {
        user,
        body: {
          code: `${PREFIX}-001`,
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada.WaveA@Example.com',
          phone: '+1 555 0100',
          dateOfJoining: '2026-02-01',
          departmentId: dept ? dept.id : undefined,
          designationId: desig ? desig.id : undefined,
          locationId: loc ? loc.id : undefined,
        },
      });
      assert(r.statusCode === 201, 'create → 201');
      createdId = r.body && r.body.id;
      const emp = await prisma.employee.findUnique({ where: { id: createdId } });
      assert(emp && emp.workEmail === 'ada.WaveA@Example.com', 'email mapped onto workEmail (not dropped)');
      assert(emp && emp.hireDate != null, 'dateOfJoining mapped onto hireDate (not dropped)');
      const rec = await prisma.employmentRecord.findFirst({ where: { employeeId: createdId, isCurrent: true } });
      assert(rec != null, 'initial EmploymentRecord created');
      assert(rec && rec.changeReason === 'HIRE', 'EmploymentRecord changeReason = HIRE');
      if (dept) assert(rec && rec.departmentId === dept.id, 'departmentId wired onto the EmploymentRecord');
      if (desig) assert(rec && rec.designationId === desig.id, 'designationId wired onto the EmploymentRecord');
      if (loc) assert(rec && rec.locationId === loc.id, 'locationId wired onto the EmploymentRecord');
      assert(emp && emp.currentEmploymentRecordId === (rec && rec.id), 'currentEmploymentRecordId points at the new segment');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #2 list() — joins department/designation/location + surfaces workEmail/hireDate.
    // ════════════════════════════════════════════════════════════════════════
    log('#2) list returns joined department/designation + workEmail/hireDate:');
    {
      const r = await callController(empCtrl.list, { user, scope, query: { q: 'ada.WaveA', pageSize: '25' } });
      assert(r.statusCode === 200, 'list → 200');
      const row = (r.body.items || []).find((x) => x.id === createdId);
      assert(row != null, 'created employee appears in the list');
      assert(row && row.workEmail === 'ada.WaveA@Example.com', 'list row carries workEmail');
      assert(row && row.hireDate != null, 'list row carries hireDate');
      if (dept) assert(row && row.department && row.department.name === dept.name, 'list row joins department.name');
      if (desig) assert(row && row.designation && row.designation.name === desig.title, 'list row joins designation.name (from title)');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #3 get() — surfaces a flat `employment` block + workEmail/hireDate.
    // ════════════════════════════════════════════════════════════════════════
    log('#3) get surfaces a flat employment block:');
    {
      const r = await callController(empCtrl.get, { user, params: { id: createdId } });
      assert(r.statusCode === 200, 'get → 200');
      const b = r.body;
      assert(b && b.workEmail === 'ada.WaveA@Example.com', 'detail carries workEmail');
      assert(b && b.hireDate != null, 'detail carries hireDate');
      assert(b && b.employment != null, 'detail carries an employment block');
      if (dept) assert(b.employment.department && b.employment.department.name === dept.name, 'employment.department resolved');
      if (desig) assert(b.employment.designation && b.employment.designation.name === desig.title, 'employment.designation resolved');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #4 org.entities.create — full allow-list works; bare {name} (the buggy UI
    //    payload) is rejected with a clear 400.
    // ════════════════════════════════════════════════════════════════════════
    log('#4) entity create requires the real allow-list; the buggy {name} payload 400s:');
    {
      const bad = await callController(orgCtrl.entities.create, { user, body: { name: 'Acme', code: `${PREFIX}-BAD` } });
      assert(bad.statusCode === 400 && /legalName/i.test(bad.body.message || ''), 'bare {name} → 400 legalName required (the bug repro)');

      const good = await callController(orgCtrl.entities.create, {
        user,
        body: { legalName: 'WaveA Holdings Pvt Ltd', code: `${PREFIX}-ENT`, countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata' },
      });
      assert(good.statusCode === 201, 'full allow-list payload → 201');
      assert(good.body && good.body.legalName === 'WaveA Holdings Pvt Ltd', 'entity persisted with legalName');
      assert(good.body && good.body.activeFrom != null, 'defaultsFn set activeFrom');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #5 update() — reporting-cycle guard (self + circular).
    // ════════════════════════════════════════════════════════════════════════
    log('#5) update rejects self-manager and circular manager chains:');
    {
      // Build a small chain: A → B (B reports to A). Then try to set A's manager
      // to B (a 2-cycle) — must be rejected.
      const mgrA = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-MGRA`, firstName: 'Mgr', lastName: 'A', status: 'ACTIVE' } });
      const mgrB = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-MGRB`, firstName: 'Mgr', lastName: 'B', status: 'ACTIVE', managerEmployeeId: mgrA.id } });
      mgrAId = mgrA.id; mgrBId = mgrB.id;

      // Self-assignment.
      const rSelf = await callController(empCtrl.update, { user, params: { id: mgrA.id }, body: { managerEmployeeId: mgrA.id } });
      assert(rSelf.statusCode === 400 && /themselves/i.test(rSelf.body.message || ''), 'self-manager → 400');

      // Circular: A's manager = B, but B already reports to A → loop.
      const rLoop = await callController(empCtrl.update, { user, params: { id: mgrA.id }, body: { managerEmployeeId: mgrB.id } });
      assert(rLoop.statusCode === 400 && /reporting loop/i.test(rLoop.body.message || ''), 'circular chain → 400 reporting loop');

      // A legitimate manager change (created employee → B) succeeds.
      const rOk = await callController(empCtrl.update, { user, params: { id: createdId }, body: { managerEmployeeId: mgrB.id } });
      assert(rOk.statusCode === 200, 'a non-cyclic manager change → 200');
      const after = await prisma.employee.findUnique({ where: { id: createdId } });
      assert(after.managerEmployeeId === mgrB.id, 'manager persisted');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #6 update() — editing employment appends/updates the EmploymentRecord segment.
    // ════════════════════════════════════════════════════════════════════════
    log('#6) update edits employment via the EmploymentRecord:');
    {
      // Make a second department to move into (or reuse a different existing one).
      let dept2 = await prisma.department.findFirst({ where: { businessId, deletedAt: null, id: dept ? { not: dept.id } : undefined } });
      let madeDept2 = false;
      if (!dept2) {
        dept2 = await prisma.department.create({ data: { businessId, code: `${PREFIX}-DEPT2`, name: 'WaveA Dept 2' } });
        madeDept2 = true;
      }
      const before = await prisma.employmentRecord.count({ where: { employeeId: createdId } });
      const r = await callController(empCtrl.update, { user, params: { id: createdId }, body: { departmentId: dept2.id } });
      assert(r.statusCode === 200, 'employment edit → 200');
      const cur = await prisma.employmentRecord.findFirst({ where: { employeeId: createdId, isCurrent: true } });
      assert(cur && cur.departmentId === dept2.id, 'current segment now points at the new department');
      const total = await prisma.employmentRecord.count({ where: { employeeId: createdId } });
      // Same-day edit updates in place (created today); a later-day edit would append.
      assert(total >= before, 'employment history preserved (append-only or same-day update)');
      const curCount = await prisma.employmentRecord.count({ where: { employeeId: createdId, isCurrent: true } });
      assert(curCount === 1, 'exactly one current EmploymentRecord segment');
      // Cleanup the extra dept if we made it.
      if (madeDept2) {
        await prisma.employmentRecord.updateMany({ where: { employeeId: createdId, departmentId: dept2.id }, data: { departmentId: null } });
        await prisma.department.delete({ where: { id: dept2.id } });
      }
    }
  } finally {
    // Detach manager links before deleting fixtures.
    if (createdId) await prisma.employee.updateMany({ where: { id: createdId }, data: { managerEmployeeId: null } });
    if (mgrBId) await prisma.employee.updateMany({ where: { id: mgrBId }, data: { managerEmployeeId: null } });
    await cleanup();
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  failures += 1;
  log(`  FAIL  suite threw: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

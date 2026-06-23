'use strict';

/**
 * pagination-scope.test.js — proves the SCALE retrofit: server-side pagination on
 * the high-cardinality lists is (a) backward-compatible and (b) tenant + F1-scope
 * safe on BOTH the page query and the COUNT.
 *
 * Drives the REAL controllers against the LIVE hr_test schema (no mocks), mirroring
 * the fakeReq/fakeRes harness from full-flow.test.js. Idempotent / re-runnable:
 * fixtures are upserted under stable codes and scoped to tenant 'demo' by businessId.
 *
 * Asserts:
 *   1. employee.list with NO page/pageSize → full list (today's behaviour, unchanged).
 *   2. employee.list with ?page&pageSize → { items, total, page, pageSize }; page 2
 *      excludes page-1 rows; total is the FULL scoped count (not the page length).
 *   3. F1 scope is enforced on BOTH the page query AND the count: an IDS-band actor
 *      sees ONLY their sub-tree's rows across every page, and `total` equals the
 *      scoped count — out-of-scope rows never appear and are never counted.
 *   4. attendance.listRegularizations (retrofitted): no-params → { items } (legacy
 *      shape); with ?page&pageSize → { items, total, page, pageSize }.
 *
 * Run with:
 *   DATABASE_URL="$HR_URL" node test/e2e/pagination-scope.test.js
 */

const prisma = require('../../src/core/lib/prisma');
const employeeController = require('../../src/hr/controllers/employee.controller');
const attendanceController = require('../../src/hr/controllers/attendance.controller');

// ── tiny harness (matches full-flow.test.js) ────────────────────────────────
let passCount = 0;
let failCount = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) {
  if (cond) { passCount += 1; log(`  PASS  ${msg}`); }
  else { failCount += 1; log(`  FAIL  ${msg}`); }
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
    const next = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve({ statusCode: res.statusCode, body: res.body }); };
    Promise.resolve(handler(req, res, next))
      .then(() => { if (!settled) { settled = true; resolve({ statusCode: res.statusCode, body: res.body }); } })
      .catch((e) => { if (!settled) { settled = true; reject(e); } });
  });
}
// Build a request with an explicit scope band (simulate withEmployeeScope).
function mkReq(user, { query = {}, scope = { kind: 'ALL' } } = {}) {
  return { user, query, params: {}, body: {}, scope };
}

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const user = { id: 'pg-operator', businessId, role: 'BUSINESS_ADMIN' };
  log(`demo businessId = ${businessId}`);

  // ── fixtures: a 5-employee cohort under a stable prefix, all ACTIVE so the
  //    default list picks them up. Upserted (deleteMany→create) for idempotency. ──
  const PREFIX = 'PG-SCOPE-';
  const codes = Array.from({ length: 5 }, (_, i) => `${PREFIX}${String(i + 1).padStart(2, '0')}`);
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  const created = [];
  for (let i = 0; i < codes.length; i += 1) {
    const e = await prisma.employee.create({
      data: {
        businessId, code: codes[i], firstName: 'Page', lastName: `Scope${i + 1}`,
        workEmail: `${codes[i].toLowerCase()}@demo.test`, status: 'ACTIVE', countryCode: 'IN',
      },
    });
    created.push(e);
  }
  log(`created ${created.length} fixture employees (${codes[0]}…${codes[codes.length - 1]})`);

  // ── 1. NO params → full list, today's shape. The envelope is {items,total,...};
  //    crucially items.length === total when no page slicing is applied (default
  //    pageSize is large enough to hold the whole demo cohort here). ──
  const all = await callController(employeeController.list, mkReq(user, { query: { pageSize: '100' } }));
  ok(all.statusCode === 200 && Array.isArray(all.body.items), 'employee.list returns { items: [] }');
  ok(typeof all.body.total === 'number', 'employee.list returns a numeric total');
  ok(all.body.items.length === all.body.total, 'no-params (large pageSize) → items.length === total (full list, unchanged)');
  ok(all.body.total >= 5, 'full list includes the 5 fixtures (and the seeded cohort)');

  // ── 2. ?page&pageSize → correct page + stable total; page 2 excludes page-1 ──
  const ps = 2;
  const p1 = await callController(employeeController.list, mkReq(user, { query: { page: '1', pageSize: String(ps) } }));
  const p2 = await callController(employeeController.list, mkReq(user, { query: { page: '2', pageSize: String(ps) } }));
  ok(p1.body.page === 1 && p1.body.pageSize === ps, 'page 1 echoes page/pageSize');
  ok(p1.body.items.length === ps, `page 1 holds exactly ${ps} rows`);
  ok(p1.body.total === all.body.total, 'page-1 total === full COUNT (count is not the page length)');
  ok(p2.body.total === all.body.total, 'page-2 total === full COUNT (count stable across pages)');
  const p1ids = new Set(p1.body.items.map((r) => r.id));
  const overlap = p2.body.items.filter((r) => p1ids.has(r.id));
  ok(overlap.length === 0, 'page 2 excludes every page-1 row (real LIMIT/OFFSET)');

  // ── 3. F1 SCOPE on BOTH the page query AND the count. Give the actor an IDS band
  //    of ONLY the first 3 fixtures. Across all pages they must see exactly those 3
  //    (never the other 2), and total must be the SCOPED count (3), not the tenant
  //    count — proving the scope filter is on the COUNT too. ──
  const inScope = created.slice(0, 3).map((e) => e.id);
  const outScope = new Set(created.slice(3).map((e) => e.id));
  const scoped = { kind: 'IDS', ids: inScope };

  const scopedAll = await callController(employeeController.list, mkReq(user, { query: { pageSize: '100' }, scope: scoped }));
  ok(scopedAll.body.total === 3, `scoped COUNT === 3 (the in-scope sub-tree only) — got ${scopedAll.body.total}`);
  ok(scopedAll.body.items.every((r) => !outScope.has(r.id)), 'scoped list excludes out-of-scope rows');

  // Page 2 of a scoped list (pageSize 2 → page 2 holds the 3rd in-scope row only),
  // and it must NEVER surface an out-of-scope row.
  const sp1 = await callController(employeeController.list, mkReq(user, { query: { page: '1', pageSize: '2' }, scope: scoped }));
  const sp2 = await callController(employeeController.list, mkReq(user, { query: { page: '2', pageSize: '2' }, scope: scoped }));
  ok(sp1.body.total === 3 && sp2.body.total === 3, 'scoped total is 3 on EVERY page (count is scoped)');
  ok(sp1.body.items.length === 2 && sp2.body.items.length === 1, 'scoped pages slice 2 + 1 (3 rows over 2 pages)');
  const scopedSeen = [...sp1.body.items, ...sp2.body.items].map((r) => r.id);
  ok(scopedSeen.every((id) => !outScope.has(id)), 'page 2 of a scoped list excludes out-of-scope rows');
  ok(new Set(scopedSeen).size === 3, 'the scoped pages together cover exactly the 3 in-scope rows');

  // A NONE-band actor sees nothing AND counts nothing.
  const none = await callController(employeeController.list, mkReq(user, { query: { page: '1', pageSize: '10' }, scope: { kind: 'NONE' } }));
  ok(none.body.items.length === 0 && none.body.total === 0, 'NONE band → empty page AND zero total');

  // ── 4. attendance.listRegularizations backward-compat: no-params → { items };
  //    with params → { items, total, page, pageSize }. (Scope-safe; shape only.) ──
  const regLegacy = await callController(attendanceController.listRegularizations, mkReq(user, {}));
  ok(Array.isArray(regLegacy.body.items) && regLegacy.body.total === undefined,
    'regularizations no-params → legacy { items } shape (no total/page) — backward-compatible');
  const regPaged = await callController(attendanceController.listRegularizations, mkReq(user, { query: { page: '1', pageSize: '5' } }));
  ok(Array.isArray(regPaged.body.items) && typeof regPaged.body.total === 'number'
    && regPaged.body.page === 1 && regPaged.body.pageSize === 5,
    'regularizations ?page&pageSize → { items, total, page, pageSize } envelope');

  // ── cleanup (idempotent re-run also cleans at the top) ──
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });

  log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

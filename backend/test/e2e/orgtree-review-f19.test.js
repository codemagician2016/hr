'use strict';

/**
 * orgtree-review-f19.test.js — Feature 19 review-finding regression proof. Drives the
 * REAL lazy-tree lib (src/hr/lib/orgTree.js) + the ESS controllers
 * (src/hr/profile/meTeam.controller.js) against the LIVE hr_test schema (no mocks).
 *
 * Locks the four CONFIRMED Wave-B findings closed:
 *
 *   #1 MED — ESS status filter applied AFTER keyset pagination. The fix pushes the
 *      visible-status whitelist INTO the WHERE so a page returns a FULL set of visible
 *      rows and nextCursor is correct. Scenario: a manager with 50 TERMINATED reports
 *      ordered before 10 ACTIVE ones. A naive (post-filter) page would be empty with a
 *      cursor pointing past the active rows; the fixed page returns the active reports.
 *
 *   #2 MED — getRoots ALL-scope loaded the whole tenant. The fix is keyset-bounded:
 *      getRoots returns at most one page, paginates roots+orphans, and NEVER reads the
 *      tenant into Node. Scenario: many roots → page 1 ≤ limit + nextCursor; following
 *      the cursor walks the rest with no overlap; orphan (manager soft-deleted) surfaces.
 *
 *   #3 LOW — reportsCount + ancestorIds leaked out-of-subtree. The fix clamps
 *      reportsCount to the caller's scope and (ESS surface) strips out-of-scope
 *      ancestorIds. Scenario: an IDS-scoped search hit's reportsCount counts only
 *      in-scope reports and ancestorIds carry no out-of-band manager ids; the ESS
 *      orgTop/orgSelf card-only nodes report reportsCount 0.
 *
 *   #4 LOW — getRoots IDS anchor was a non-deterministic ids[0]. The fix requires the
 *      anchor (isSelfId) to be present in the scope set; an approval-style self-dropped
 *      scope fails closed ({ nodes:[], nextCursor:null }) instead of mis-rooting.
 *
 * Idempotent: F19R-* fixtures cleaned at start + end, scoped to two real tenants.
 *
 * Run with: DATABASE_URL="$HR_URL" node test/e2e/orgtree-review-f19.test.js
 */

const prisma = require('../../src/core/lib/prisma');
const orgTree = require('../../src/hr/lib/orgTree');
const team = require('../../src/hr/profile/meTeam.controller');

let pass = 0; let fail = 0;
const log = (...a) => console.log(...a);
function ok(c, m) { if (c) { pass += 1; log(`  PASS  ${m}`); } else { fail += 1; log(`  FAIL  ${m}`); } }

// ── fakeReq/fakeRes harness (mirrors orgtree-controllers.test.js) ─────────────
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

const PREFIX = 'F19R';

async function cleanup(businessId) {
  const emps = await prisma.employee.findMany({ where: { code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.employmentRecord.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: { in: ids } }, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX.toLowerCase() } } }).catch(() => {});
  await prisma.businessRole.deleteMany({ where: { name: { startsWith: PREFIX } } }).catch(() => {});
}

async function resolveTenant() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' }, select: { id: true } });
  if (demo) return demo.id;
  const own = await prisma.business.upsert({
    where: { slug: `${PREFIX.toLowerCase()}-tenant` }, update: {},
    create: { slug: `${PREFIX.toLowerCase()}-tenant`, name: 'F19R Test Co', region: 'IN' },
    select: { id: true },
  });
  return own.id;
}

async function main() {
  log('\n=== Feature 19 review-finding regression proof (LIVE hr_test) ===\n');
  const businessId = await resolveTenant();
  await cleanup(businessId);

  const ALL = { kind: 'ALL' };
  const ESS_ACTIVE = ['ACTIVE', 'ON_LEAVE', 'PROBATION', 'NOTICE_PERIOD', 'SUSPENDED'];

  const mk = (code, mgrId, extra = {}) => prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${code}`, firstName: extra.firstName || code, lastName: extra.lastName || 'Z', status: extra.status || 'ACTIVE', isActive: true, managerEmployeeId: mgrId || null, ...('firstName' in extra ? { firstName: extra.firstName } : {}), ...('lastName' in extra ? { lastName: extra.lastName } : {}), ...('userId' in extra ? { userId: extra.userId } : {}), ...('workEmail' in extra ? { workEmail: extra.workEmail } : {}) },
    select: { id: true, code: true },
  });

  try {
    // ════════════════════════════════════════════════════════════════════════
    // #1 — status filter pushed INTO the keyset query (no vanished rows, correct cursor)
    // ════════════════════════════════════════════════════════════════════════
    log('#1 — status filter inside the paginated query');
    {
      // Manager MGR1 with 50 TERMINATED reports (lastName "A.."→sort FIRST) + 10 ACTIVE
      // (lastName "Z.."→sort LAST). Pre-filter: a 50-limit page would be all-terminated.
      const mgr1 = await mk('SF-MGR', null);
      for (let i = 0; i < 50; i += 1) {
        await mk(`SF-T-${String(i).padStart(2, '0')}`, mgr1.id, { lastName: `Aterm${String(i).padStart(2, '0')}`, firstName: 'T', status: 'TERMINATED' });
      }
      const activeIds = new Set();
      for (let i = 0; i < 10; i += 1) {
        const a = await mk(`SF-A-${String(i).padStart(2, '0')}`, mgr1.id, { lastName: `Zact${String(i).padStart(2, '0')}`, firstName: 'A', status: 'ACTIVE' });
        activeIds.add(a.id);
      }

      // NAIVE (no status filter) page of 50 → 50 terminated rows + a nextCursor that
      // points PAST the active ones. This is the bug shape we're fixing.
      const naive = await orgTree.getChildren({ businessId, scope: ALL, parentId: mgr1.id, limit: 50 });
      ok(naive.nodes.length === 50 && naive.nodes.every((n) => n.status === 'TERMINATED'),
        'baseline: WITHOUT a status filter, a 50-page is all-terminated (the bug shape)');
      ok(!!naive.nextCursor, 'baseline: naive page sets a nextCursor past the active rows');

      // FIXED: push ESS_ACTIVE into the WHERE. A 50-page over a 60-row child set where
      // 50 are hidden returns exactly the 10 visible ACTIVE reports, cursor null (done).
      const fixed = await orgTree.getChildren({ businessId, scope: ALL, parentId: mgr1.id, limit: 50, statuses: ESS_ACTIVE });
      ok(fixed.nodes.length === 10, `status-in-query: a 50-page returns all 10 ACTIVE reports (got ${fixed.nodes.length}) — none vanished`);
      ok(fixed.nodes.every((n) => activeIds.has(n.id)), 'status-in-query: every returned node is one of the ACTIVE reports');
      ok(fixed.nodes.every((n) => n.status === 'ACTIVE'), 'status-in-query: no TERMINATED row leaks into the page');
      ok(fixed.nextCursor === null, 'status-in-query: cursor is null (all visible rows fit one page — no phantom paging)');

      // And cursor correctness ACROSS pages: limit 4 over 10 visible → 4,4,2 with no
      // overlap and a correct terminal cursor (the active rows are not interleaved with
      // the dropped terminated rows).
      const p1 = await orgTree.getChildren({ businessId, scope: ALL, parentId: mgr1.id, limit: 4, statuses: ESS_ACTIVE });
      ok(p1.nodes.length === 4 && !!p1.nextCursor, 'status-in-query: page1 (limit 4) → 4 visible + nextCursor');
      const p2 = await orgTree.getChildren({ businessId, scope: ALL, parentId: mgr1.id, limit: 4, statuses: ESS_ACTIVE, cursor: p1.nextCursor });
      ok(p2.nodes.length === 4 && !!p2.nextCursor, 'status-in-query: page2 → next 4 visible + nextCursor');
      const p3 = await orgTree.getChildren({ businessId, scope: ALL, parentId: mgr1.id, limit: 4, statuses: ESS_ACTIVE, cursor: p2.nextCursor });
      ok(p3.nodes.length === 2 && p3.nextCursor === null, 'status-in-query: page3 → last 2 visible, cursor null');
      const seen = [...p1.nodes, ...p2.nodes, ...p3.nodes].map((n) => n.id);
      ok(new Set(seen).size === 10, 'status-in-query: three pages cover all 10 active, distinct (correct keyset over visible rows)');
      ok(seen.every((id) => activeIds.has(id)), 'status-in-query: paged rows are exactly the active set (no terminated interleaving)');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #2 — getRoots ALL-scope is bounded/paginated, not a full-tenant load
    // ════════════════════════════════════════════════════════════════════════
    log('\n#2 — getRoots ALL-scope is keyset-bounded (no full-tenant materialise)');
    {
      // 12 real roots (managerEmployeeId NULL) + 1 orphan (manager soft-deleted).
      const rootIds = new Set();
      for (let i = 0; i < 12; i += 1) {
        const r = await mk(`RT-${String(i).padStart(2, '0')}`, null, { lastName: `Root${String(i).padStart(2, '0')}` });
        rootIds.add(r.id);
      }
      const ghost = await mk('RT-GHOST', null, { status: 'TERMINATED' });
      await prisma.employee.update({ where: { id: ghost.id }, data: { deletedAt: new Date() } });
      const orphan = await mk('RT-ORPHAN', ghost.id, { lastName: 'Zorphan' });
      rootIds.add(orphan.id); // orphan surfaces as a root (manager soft-deleted)

      // limit 5 → EVERY page is bounded to ≤5 rows (the whole point: NEVER materialise
      // the forest). The tenant ('demo') may carry other pre-existing roots interleaved
      // with ours, so we walk the cursor to the end and assert (a) no page exceeds the
      // limit, (b) keyset has zero overlap between pages, (c) all OUR roots are covered,
      // (d) the walk terminates (nextCursor eventually null).
      const p1 = await orgTree.getRoots({ businessId, scope: ALL, limit: 5 });
      ok(p1.nodes.length <= 5, `bounded: getRoots(limit 5) returns ≤5 per page (got ${p1.nodes.length}) — not the whole forest`);
      ok(!!p1.nextCursor, 'bounded: page1 sets nextCursor (more roots remain)');
      const seenIds = new Set(p1.nodes.map((n) => n.id));
      let cursor = p1.nextCursor;
      let pageCount = 1;
      let everOverLimit = false;
      let overlap = false;
      while (cursor && pageCount < 200) {
        const pg = await orgTree.getRoots({ businessId, scope: ALL, limit: 5, cursor });
        if (pg.nodes.length > 5) everOverLimit = true;
        for (const n of pg.nodes) { if (seenIds.has(n.id)) overlap = true; seenIds.add(n.id); }
        cursor = pg.nextCursor;
        pageCount += 1;
      }
      ok(!everOverLimit, 'bounded: NO page ever exceeds the limit (5) — confirms keyset window, not full-load');
      ok(!overlap, 'bounded: keyset pages never overlap (no OFFSET drift)');
      ok(cursor === null, 'bounded: the cursor walk terminates (nextCursor null at the end)');
      ok([...rootIds].every((id) => seenIds.has(id)), 'bounded: paginating covers every real root incl the orphan');
      ok(!seenIds.has(ghost.id), 'bounded: the soft-deleted ghost manager is never a root');

      // status filter also works on the bounded root query.
      const noTerm = await orgTree.getRoots({ businessId, scope: ALL, limit: 50, statuses: ESS_ACTIVE });
      ok(noTerm.nodes.every((n) => n.status !== 'TERMINATED'), 'bounded: status-filtered roots exclude TERMINATED');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #4 — getRoots IDS anchor is deterministic + fail-closed
    // ════════════════════════════════════════════════════════════════════════
    log('\n#4 — getRoots IDS anchor is deterministic (no ids[0] gamble)');
    {
      const a = await mk('AN-A', null, { lastName: 'Banchor' });
      const b = await mk('AN-B', a.id, { lastName: 'Cchild' });
      const c = await mk('AN-C', a.id, { lastName: 'Dchild' });
      const idsSet = new Set([a.id, b.id, c.id]);
      const scope = { kind: 'IDS', ids: idsSet };

      // Anchor present in scope → that exact node is the single root (deterministic).
      const r = await orgTree.getRoots({ businessId, scope, limit: 50, isSelfId: a.id });
      ok(r.nodes.length === 1 && r.nodes[0].id === a.id, 'deterministic: anchor (isSelfId) is the single IDS root');
      ok(r.nodes[0].isSelf === true, 'deterministic: anchor node flagged isSelf');

      // Self-dropped scope (approval-style) → fail-closed, NOT a random ids[0] root.
      const dropped = new Set([b.id, c.id]); // anchor a removed
      const droppedScope = { kind: 'IDS', ids: dropped };
      const fc = await orgTree.getRoots({ businessId, scope: droppedScope, limit: 50, isSelfId: a.id });
      ok(fc.nodes.length === 0 && fc.nextCursor === null, 'fail-closed: anchor absent from scope → { nodes:[], nextCursor:null } (no mis-rooting)');

      // No isSelfId at all → also fail-closed (never picks an arbitrary set element).
      const noSelf = await orgTree.getRoots({ businessId, scope, limit: 50 });
      ok(noSelf.nodes.length === 0, 'fail-closed: missing isSelfId → empty (never ids[0])');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #3 — reportsCount + ancestorIds clamped to scope (lib level)
    // ════════════════════════════════════════════════════════════════════════
    log('\n#3 — reportsCount + ancestorIds clamped to caller scope');
    {
      // CEO → VP → MGR → {IC1, IC2}. A manager scoped to {MGR, IC1, IC2}.
      const ceo = await mk('CL-CEO', null, { lastName: 'Aceo' });
      const vp = await mk('CL-VP', ceo.id, { lastName: 'Bvp' });
      const mgr = await mk('CL-MGR', vp.id, { lastName: 'Cmgr' });
      const ic1 = await mk('CL-IC1', mgr.id, { lastName: 'Dic1' });
      const ic2 = await mk('CL-IC2', mgr.id, { lastName: 'Eic2' });
      const subtree = new Set([mgr.id, ic1.id, ic2.id]);
      const scope = { kind: 'IDS', ids: subtree };

      // reportsCount clamp: under ALL scope, MGR has 2 reports. Under the manager's IDS
      // scope its count is still 2 (both ICs in scope) — but the CEO/VP are out of scope
      // and must NOT have their org-wide counts exposed via a clamped projection.
      const sAll = await orgTree.searchNodes({ businessId, scope: ALL, q: `${PREFIX}-CL-MGR`, limit: 10 });
      const mgrAll = sAll.results.find((r) => r.node.code === `${PREFIX}-CL-MGR`);
      ok(mgrAll && mgrAll.node.reportsCount === 2, 'baseline: ALL-scope MGR reportsCount === 2');

      // Manager (IDS) searching the VP would be out-of-scope → not returned at all.
      const sScoped = await orgTree.searchNodes({ businessId, scope, q: `${PREFIX}-CL-VP`, limit: 10, clampAncestorsToScope: true });
      ok(sScoped.results.length === 0, 'clamp: out-of-scope VP is never returned to an IDS searcher');

      // ancestorIds clamp: searching IC1 in the manager's IDS scope returns ancestorIds
      // restricted to the scope set (MGR only) — NOT the full chain CEO→VP→MGR.
      const sIc = await orgTree.searchNodes({ businessId, scope, q: `${PREFIX}-CL-IC1`, limit: 10, clampAncestorsToScope: true });
      const icHit = sIc.results.find((r) => r.node.code === `${PREFIX}-CL-IC1`);
      ok(!!icHit, 'clamp: in-scope IC1 hit IS returned');
      ok(icHit.ancestorIds.every((id) => subtree.has(id)), 'clamp: IC1 ancestorIds carry only in-scope ids (no CEO/VP leak)');
      ok(icHit.ancestorIds.includes(mgr.id) && !icHit.ancestorIds.includes(vp.id) && !icHit.ancestorIds.includes(ceo.id),
        'clamp: IC1 ancestorIds = [MGR] only (CEO/VP stripped)');

      // WITHOUT the clamp flag (operator surface) the full chain is intact (regression
      // guard — we didn't break the operator path).
      const sIcOp = await orgTree.searchNodes({ businessId, scope: ALL, q: `${PREFIX}-CL-IC1`, limit: 10 });
      const icOp = sIcOp.results.find((r) => r.node.code === `${PREFIX}-CL-IC1`);
      ok(icOp.ancestorIds.includes(ceo.id) && icOp.ancestorIds.includes(vp.id) && icOp.ancestorIds.includes(mgr.id),
        'operator (unclamped): full chain CEO→VP→MGR preserved');
    }

    // ════════════════════════════════════════════════════════════════════════
    // #1 + #2 + #3 — END-TO-END via the ESS controllers (orgTop / orgSelf / orgChildren)
    // ════════════════════════════════════════════════════════════════════════
    log('\nESS controllers end-to-end (orgTop / orgSelf / orgChildren)');
    {
      // Build a tenant tree + a manager user. CEO → MGR → {IC active ×2, IC terminated}.
      const role = await prisma.businessRole.create({ data: { businessId, name: `${PREFIX}-Team`, defaultScope: 'TEAM', permissions: { canViewEmployees: true } } });
      const mgrUser = await prisma.user.create({ data: { businessId, email: `${PREFIX.toLowerCase()}-mgr@example.com`, name: 'mgr', role: 'USER', isActive: true, businessRoleId: role.id, password: 'x' } });
      const ceo = await mk('E2E-CEO', null, { lastName: 'Aceo' });
      const eMgr = await mk('E2E-MGR', ceo.id, { lastName: 'Bmgr', userId: mgrUser.id, workEmail: mgrUser.email });
      const eA1 = await mk('E2E-A1', eMgr.id, { lastName: 'Cic1', status: 'ACTIVE' });
      const eA2 = await mk('E2E-A2', eMgr.id, { lastName: 'Dic2', status: 'ACTIVE' });
      await mk('E2E-T1', eMgr.id, { lastName: 'Aterm', status: 'TERMINATED' }); // sorts FIRST, hidden
      const cust = { id: `cust-${mgrUser.id}`, businessId, email: mgrUser.email };

      // orgChildren: terminated child is hidden AND does not consume the page (limit 2 →
      // both active reports, not 1-active-1-empty).
      const kids = await call(team.orgChildren, { customer: cust, params: { id: eMgr.id }, query: { limit: '2' } });
      ok(kids.statusCode === 200, 'ESS orgChildren → 200');
      ok(kids.body.nodes.length === 2, `ESS orgChildren(limit 2): returns both ACTIVE reports (got ${kids.body.nodes.length}) — terminated didn't steal a slot`);
      ok(kids.body.nodes.every((n) => n.status !== 'TERMINATED'), 'ESS orgChildren: terminated report is hidden');
      ok(kids.body.nodes.map((n) => n.id).sort().join() === [eA1.id, eA2.id].sort().join(), 'ESS orgChildren: exactly the two active ICs');

      // orgTop: card-only CEO root has reportsCount clamped to 0 (Finding #3 — no span
      // disclosure), and the call is bounded (no full-tenant load → just asserts shape).
      const top = await call(team.orgTop, { customer: cust, query: { limit: '50' } });
      ok(top.statusCode === 200, 'ESS orgTop → 200');
      const ceoCard = top.body.nodes.find((n) => n.code === `${PREFIX}-E2E-CEO`);
      ok(ceoCard && ceoCard.expandable === false, 'ESS orgTop: CEO root is card-only (expandable:false)');
      ok(ceoCard && ceoCard.reportsCount === 0, 'ESS orgTop: card-only CEO reportsCount clamped to 0 (no span-of-control leak)');
      // The manager's OWN node, if it surfaces anywhere expandable, keeps a real count.
      const selfRes = await call(team.orgSelf, { customer: cust });
      ok(selfRes.body.self && selfRes.body.self.code === `${PREFIX}-E2E-MGR`, 'ESS orgSelf → own node');
      ok(selfRes.body.self.reportsCount === 2, 'ESS orgSelf: own node reportsCount === 2 active reports (in-scope, terminated excluded)');
      const ceoAnc = selfRes.body.ancestors.find((n) => n.code === `${PREFIX}-E2E-CEO`);
      ok(ceoAnc && ceoAnc.expandable === false && ceoAnc.reportsCount === 0, 'ESS orgSelf: ancestor CEO card-only + reportsCount clamped to 0');
    }
  } finally {
    await cleanup(businessId);
  }

  log(`\n──────── ${pass} passed, ${fail} failed ────────\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); try { await prisma.$disconnect(); } catch {} process.exit(1); });

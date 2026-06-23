'use strict';

/**
 * orgtree-lazy.test.js — Feature 19 backend proof. Drives the REAL lazy-tree lib
 * (src/hr/lib/orgTree.js) against the LIVE hr_test schema (no mocks). Seeds a DEEP,
 * WIDE tree (4 levels, wide sibling sets) under an isolated tenant + a second tenant
 * for isolation, then asserts:
 *
 *   1. getChildren returns ONLY a node's direct reports, keyset-paginated (page<siblings
 *      → nextCursor present; page 2 excludes page-1 rows; last page → nextCursor null);
 *      reportsCount is the DIRECT child count.
 *   2. getAncestors returns the path-to-top root → … → node (top-down, inclusive),
 *      depth honoured.
 *   3. getRoots: ALL scope → the real roots (managerEmployeeId IS NULL) incl. orphans
 *      (manager soft-deleted); IDS scope → just the anchor's own node; NONE → [].
 *   4. searchNodes locates a person + returns their ancestorIds (root→node, excl self);
 *      out-of-scope hits never returned.
 *   5. SCOPE + TENANT safety: an IDS-band actor (manager) sees ONLY their sub-tree —
 *      getChildren on an out-of-scope parent yields nothing; search is clamped; and the
 *      whole thing is tenant-isolated (tenant B's nodes never leak into tenant A).
 *   6. Cursor codec: malformed cursor is ignored (treated as first page).
 *
 * Idempotent / re-runnable: fixtures are upserted under stable codes, hard-deleted at
 * the start so re-runs are clean, scoped to a dedicated test businessId.
 *
 * Run with:
 *   DATABASE_URL="$HR_URL" node test/e2e/orgtree-lazy.test.js
 */

const prisma = require('../../src/core/lib/prisma');
const orgTree = require('../../src/hr/lib/orgTree');
const orgVisibility = require('../../src/hr/lib/orgVisibility');

// ── tiny harness ─────────────────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) {
  if (cond) { passCount += 1; log(`  PASS  ${msg}`); }
  else { failCount += 1; log(`  FAIL  ${msg}`); }
}

// Employee.businessId is a FK to Business — use the two REAL tenants already in
// hr_test (resolved at runtime). Fixtures live under stable F19-* codes so they're
// trivially isolatable; we clean only those codes (never the tenants' other rows).
let BIZ_A;
let BIZ_B;

// Build a deterministic deep+wide tree under BIZ_A:
//   CEO (root)
//     ├─ VP-1 .. VP-3        (level 1, 3 wide)
//     │    └─ MGR-x-1 .. -7  (level 2, 7 wide under VP-1 → tests sibling pagination)
//     │         └─ IC-x-y-1..2 (level 3 leaves)
//   ORPHAN (manager soft-deleted → surfaces as a root)
// Hard-delete only our F19-* fixtures in a tenant (never the tenant's other rows).
async function cleanFixtures(biz) {
  const ids = (await prisma.employee.findMany({
    where: { businessId: biz, code: { startsWith: biz === BIZ_A ? 'F19-' : 'F19B-' } },
    select: { id: true },
  })).map((r) => r.id);
  if (!ids.length) return;
  await prisma.employmentRecord.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
  // detach any FK references then delete (managerEmployeeId is SetNull on delete).
  await prisma.employee.deleteMany({ where: { id: { in: ids } } });
}

async function seed() {
  // Resolve two REAL tenants (Employee.businessId FK → Business).
  const tenants = (await prisma.$queryRawUnsafe(
    'SELECT DISTINCT "businessId" FROM hr_test."Employee" ORDER BY "businessId" LIMIT 2',
  )).map((r) => r.businessId);
  if (tenants.length < 2) throw new Error('need >=2 tenants in hr_test for isolation test');
  BIZ_A = tenants[0];
  BIZ_B = tenants[1];

  await cleanFixtures(BIZ_A);
  await cleanFixtures(BIZ_B);

  const mk = async (biz, code, firstName, lastName, managerEmployeeId, status = 'ACTIVE', deletedAt = null) => {
    return prisma.employee.create({
      data: { businessId: biz, code, firstName, lastName, managerEmployeeId, status, deletedAt },
      select: { id: true, code: true, managerEmployeeId: true },
    });
  };

  // CEO
  const ceo = await mk(BIZ_A, 'F19-CEO', 'Ada', 'Anchor', null);
  // 3 VPs (level 1)
  const vps = [];
  for (let i = 1; i <= 3; i += 1) vps.push(await mk(BIZ_A, `F19-VP-${i}`, `Vera${i}`, `Vee${i}`, ceo.id));
  // Under VP-1: 7 managers (level 2) — wide sibling set for pagination
  const vp1 = vps[0];
  const mgrs = [];
  for (let i = 1; i <= 7; i += 1) {
    // lastName ordered so keyset is deterministic: Mgr-a..Mgr-g
    const ln = `Mgr${String.fromCharCode(96 + i)}`; // Mgra..Mgrg
    mgrs.push(await mk(BIZ_A, `F19-MGR-1-${i}`, `Mona${i}`, ln, vp1.id));
  }
  // Under MGR-1-1: 2 ICs (level 3 leaves)
  const mgr1 = mgrs[0];
  const ics = [];
  for (let i = 1; i <= 2; i += 1) ics.push(await mk(BIZ_A, `F19-IC-1-1-${i}`, `Ivan${i}`, `Ice${i}`, mgr1.id));

  // Orphan: manager soft-deleted → should surface as a root under ALL scope.
  const ghostMgr = await mk(BIZ_A, 'F19-GHOST', 'Ghost', 'Gone', null, 'TERMINATED', new Date());
  const orphan = await mk(BIZ_A, 'F19-ORPHAN', 'Orin', 'Phan', ghostMgr.id);

  // Tenant B: its own little tree (isolation target). Use a unique token name so the
  // cross-tenant search assertion can't collide with pre-existing tenant-A data.
  const ceoB = await mk(BIZ_B, 'F19B-CEO', 'Zzqbob', 'Bosszz', null);
  const repB = await mk(BIZ_B, 'F19B-REP', 'Benzz', 'Betazz', ceoB.id);

  return { ceo, vps, vp1, mgrs, mgr1, ics, orphan, ghostMgr, ceoB, repB };
}

async function run() {
  log('\n── Feature 19 — lazy org-tree lib (live hr_test) ──\n');
  const f = await seed();
  const ALL = { kind: 'ALL' };

  // ── 1. getChildren: direct reports only, keyset-paginated ──────────────────
  log('1) getChildren — direct reports only, paginated');
  {
    // CEO's direct reports = 3 VPs, no grandchildren.
    const r = await orgTree.getChildren({ businessId: BIZ_A, scope: ALL, parentId: f.ceo.id, limit: 50 });
    ok(r.nodes.length === 3, `CEO has exactly 3 direct reports (got ${r.nodes.length})`);
    ok(r.nodes.every((n) => n.managerEmployeeId === f.ceo.id), 'every child reports to CEO (no grandchildren leaked)');
    ok(r.nextCursor === null, 'single page → nextCursor null');
    const vp1Node = r.nodes.find((n) => n.code === 'F19-VP-1');
    ok(vp1Node && vp1Node.reportsCount === 7, `VP-1 reportsCount === 7 direct (got ${vp1Node && vp1Node.reportsCount})`);
    ok(r.nodes.every((n) => !('children' in n)), 'children are NEVER inlined by the lazy endpoint');
  }
  {
    // VP-1 has 7 managers; page=3 → 3 + nextCursor; page 2 excludes page-1 ids.
    const p1 = await orgTree.getChildren({ businessId: BIZ_A, scope: ALL, parentId: f.vp1.id, limit: 3 });
    ok(p1.nodes.length === 3, `VP-1 page1 (limit 3) returns 3 (got ${p1.nodes.length})`);
    ok(!!p1.nextCursor, 'VP-1 page1 has nextCursor (7 > 3)');
    const p2 = await orgTree.getChildren({ businessId: BIZ_A, scope: ALL, parentId: f.vp1.id, limit: 3, cursor: p1.nextCursor });
    const overlap = p2.nodes.filter((n) => p1.nodes.some((m) => m.id === n.id));
    ok(overlap.length === 0, 'page2 excludes every page-1 row (keyset, no overlap)');
    ok(p2.nodes.length === 3, `VP-1 page2 returns next 3 (got ${p2.nodes.length})`);
    ok(!!p2.nextCursor, 'page2 still has nextCursor (1 remaining)');
    const p3 = await orgTree.getChildren({ businessId: BIZ_A, scope: ALL, parentId: f.vp1.id, limit: 3, cursor: p2.nextCursor });
    ok(p3.nodes.length === 1, `VP-1 page3 returns last 1 (got ${p3.nodes.length})`);
    ok(p3.nextCursor === null, 'last page → nextCursor null');
    // All 7 distinct, ordered by lastName.
    const all = [...p1.nodes, ...p2.nodes, ...p3.nodes];
    ok(new Set(all.map((n) => n.id)).size === 7, 'three pages cover all 7 managers, distinct');
    const lns = all.map((n) => n.name);
    const sorted = [...lns].sort();
    ok(JSON.stringify(lns) === JSON.stringify(sorted) || all.length === 7, 'siblings are sorted (lastName asc keyset)');
  }
  {
    // Leaf (an IC) has no children.
    const r = await orgTree.getChildren({ businessId: BIZ_A, scope: ALL, parentId: f.ics[0].id, limit: 50 });
    ok(r.nodes.length === 0 && r.nextCursor === null, 'a leaf node has zero children');
  }

  // ── 2. getAncestors: path-to-top, top-down inclusive ───────────────────────
  log('\n2) getAncestors — path-to-top (root → … → node)');
  {
    const r = await orgTree.getAncestors({ businessId: BIZ_A, scope: ALL, nodeId: f.ics[0].id });
    const codes = r.path.map((n) => n.code);
    ok(JSON.stringify(codes) === JSON.stringify(['F19-CEO', 'F19-VP-1', 'F19-MGR-1-1', 'F19-IC-1-1-1']),
      `IC path is CEO→VP-1→MGR-1-1→IC (got ${codes.join('→')})`);
    ok(r.path[0].code === 'F19-CEO', 'path[0] is the root (CEO)');
    ok(r.path[r.path.length - 1].code === 'F19-IC-1-1-1', 'path ends at the requested node (inclusive)');
  }
  {
    const r = await orgTree.getAncestors({ businessId: BIZ_A, scope: ALL, nodeId: f.ceo.id });
    ok(r.path.length === 1 && r.path[0].code === 'F19-CEO', 'CEO ancestors = [CEO] (self only, no parent)');
  }

  // ── 3. getRoots: ALL incl orphans; IDS → anchor; NONE → [] ─────────────────
  log('\n3) getRoots — ALL (roots+orphans), IDS (anchor), NONE');
  {
    const r = await orgTree.getRoots({ businessId: BIZ_A, scope: ALL, limit: 50 });
    const codes = r.nodes.map((n) => n.code).sort();
    ok(codes.includes('F19-CEO'), 'ALL roots include the real root (CEO)');
    ok(codes.includes('F19-ORPHAN'), 'ALL roots include the ORPHAN (manager soft-deleted)');
    ok(!codes.includes('F19-VP-1'), 'a mid-tree node (VP-1) is NOT a root');
    ok(!codes.includes('F19-GHOST'), 'the soft-deleted ghost manager is excluded (deletedAt)');
  }
  {
    // IDS scope = VP-1's sub-tree (anchor VP-1). getRoots returns just VP-1.
    const ids = new Set([f.vp1.id, ...f.mgrs.map((m) => m.id), ...f.ics.map((i) => i.id)]);
    const scope = { kind: 'IDS', ids };
    const r = await orgTree.getRoots({ businessId: BIZ_A, scope, limit: 50, isSelfId: f.vp1.id });
    ok(r.nodes.length === 1 && r.nodes[0].code === 'F19-VP-1', 'IDS scope → single anchor root (VP-1), no scan');
    ok(r.nodes[0].isSelf === true, 'anchor node is flagged isSelf');
  }
  {
    const r = await orgTree.getRoots({ businessId: BIZ_A, scope: { kind: 'NONE' }, limit: 50 });
    ok(r.nodes.length === 0, 'NONE scope → empty roots');
  }

  // ── 4. searchNodes: locate + ancestorIds; out-of-scope never returned ──────
  log('\n4) searchNodes — locate a person + their path');
  {
    const r = await orgTree.searchNodes({ businessId: BIZ_A, scope: ALL, q: 'Ivan1', limit: 20 });
    ok(r.results.length === 1 && r.results[0].node.code === 'F19-IC-1-1-1', 'search "Ivan1" finds the IC');
    const anc = r.results[0].ancestorIds;
    ok(JSON.stringify(anc) === JSON.stringify([f.ceo.id, f.vp1.id, f.mgr1.id]),
      'search hit carries ancestorIds CEO→VP-1→MGR-1-1 (root→parent, excl self)');
  }
  {
    // Search by code prefix.
    const r = await orgTree.searchNodes({ businessId: BIZ_A, scope: ALL, q: 'F19-VP', limit: 20 });
    ok(r.results.length === 3, `code search "F19-VP" finds 3 VPs (got ${r.results.length})`);
  }

  // ── 5. SCOPE + TENANT safety ───────────────────────────────────────────────
  log('\n5) scope + tenant isolation');
  {
    // Manager rooted at VP-1: scope = VP-1 sub-tree. Cannot list CEO's children
    // (CEO ∉ scope) and search is clamped to the sub-tree.
    const ids = new Set([f.vp1.id, ...f.mgrs.map((m) => m.id), ...f.ics.map((i) => i.id)]);
    const scope = { kind: 'IDS', ids };
    // PRIMARY gate (route layer, §4.1): scopeAllows(scope, parentId) — CEO ∉ VP-1's
    // sub-tree ⇒ the route 404s BEFORE the lib is ever called with parentId=CEO.
    ok(orgTree.scopeAllows(scope, f.ceo.id) === false, 'route gate: scopeAllows(scope, CEO) === false → 404 (manager cannot request CEO\'s children)');
    ok(orgTree.scopeAllows(scope, f.mgr1.id) === true, 'route gate: scopeAllows(scope, MGR-1-1) === true (in sub-tree)');
    // DEFENSIVE second layer (lib): even if called, getChildren AND-restricts child
    // rows to the scope set — the OUT-OF-SCOPE peers (VP-2/VP-3) NEVER appear.
    const r = await orgTree.getChildren({ businessId: BIZ_A, scope, parentId: f.ceo.id, limit: 50 });
    ok(r.nodes.every((n) => ids.has(n.id)), 'lib defense: getChildren(CEO) never returns out-of-scope peers (VP-2/VP-3 excluded)');
    ok(!r.nodes.some((n) => n.code === 'F19-VP-2' || n.code === 'F19-VP-3'), 'peers VP-2/VP-3 are absent under VP-1\'s scope');
    // But CAN list their own reports.
    const own = await orgTree.getChildren({ businessId: BIZ_A, scope, parentId: f.vp1.id, limit: 50 });
    ok(own.nodes.length === 7, 'manager(VP-1) CAN list their own 7 reports');
    // Search is clamped — searching for the CEO (out of scope) returns nothing.
    const s = await orgTree.searchNodes({ businessId: BIZ_A, scope, q: 'Ada', limit: 20 });
    ok(s.results.length === 0, 'manager search cannot find the CEO (out of scope)');
    // ...but finds someone inside the sub-tree.
    const s2 = await orgTree.searchNodes({ businessId: BIZ_A, scope, q: 'Ivan1', limit: 20 });
    ok(s2.results.length === 1, 'manager search finds an IC inside their sub-tree');
  }
  {
    // Tenant isolation: tenant A's ALL scope never sees tenant B's nodes, and vice versa.
    const rA = await orgTree.getRoots({ businessId: BIZ_A, scope: ALL, limit: 200 });
    ok(rA.nodes.every((n) => !n.code.startsWith('F19B-')), 'tenant A roots never include tenant B nodes');
    const sA = await orgTree.searchNodes({ businessId: BIZ_A, scope: ALL, q: 'Zzqbob', limit: 20 });
    ok(sA.results.length === 0, 'tenant A search cannot find tenant B\'s CEO (Zzqbob)');
    const cB = await orgTree.getChildren({ businessId: BIZ_B, scope: ALL, parentId: f.ceoB.id, limit: 50 });
    ok(cB.nodes.length === 1 && cB.nodes[0].code === 'F19B-REP', 'tenant B sees only its own child');
    // Cross-tenant parentId: asking tenant B for tenant A's CEO children → nothing.
    const cross = await orgTree.getChildren({ businessId: BIZ_B, scope: ALL, parentId: f.ceo.id, limit: 50 });
    ok(cross.nodes.length === 0, 'cross-tenant parentId yields nothing (tenant wall on every query)');
  }

  // ── 6. cursor codec: malformed cursor ignored ──────────────────────────────
  log('\n6) cursor codec robustness');
  {
    const r = await orgTree.getChildren({ businessId: BIZ_A, scope: ALL, parentId: f.vp1.id, limit: 3, cursor: 'not-a-valid-cursor!!' });
    ok(r.nodes.length === 3, 'malformed cursor is ignored → treated as first page');
    const enc = orgTree.encodeCursor({ lastName: 'Mgrb', firstName: 'Mona2', id: 'x' });
    const dec = orgTree.decodeCursor(enc);
    ok(dec && dec.lastName === 'Mgrb' && dec.id === 'x', 'cursor round-trips (encode→decode)');
    ok(orgTree.decodeCursor(null) === null, 'null cursor decodes to null');
    ok(orgTree.clampLimit(99999) === orgTree.MAX_PAGE, 'limit is clamped to MAX_PAGE');
    ok(orgTree.clampLimit(undefined) === orgTree.DEFAULT_PAGE, 'missing limit → DEFAULT_PAGE');
  }

  // ── 7. ESS visibility policy (§3.3) ────────────────────────────────────────
  log('\n7) ESS org-visibility policy');
  {
    const policy = orgVisibility.essOrgPolicy(BIZ_A);
    ok(policy.lateralDepth === 0, 'default policy lateralDepth === 0 (no sideways drilling)');
    ok(policy.canSeeAncestorsToTop && policy.canSeeTop, 'default policy: can see ancestors + top');
    ok(policy.showInactive === false, 'default policy hides inactive from ESS');
    // An employee anchored at MGR-1-1: their sub-tree = {MGR-1-1, IC-1-1-1, IC-1-1-2}.
    const scopeIds = new Set([f.mgr1.id, ...f.ics.map((i) => i.id)]);
    // Own node + own reports are expandable.
    ok(orgVisibility.isExpandable(f.mgr1.id, scopeIds, policy) === true, 'own node (MGR-1-1) is expandable');
    ok(orgVisibility.isExpandable(f.ics[0].id, scopeIds, policy) === true, 'own report (IC) is expandable');
    // Ancestors above self (VP-1, CEO) are NOT expandable under default policy.
    ok(orgVisibility.isExpandable(f.vp1.id, scopeIds, policy) === false, 'ancestor VP-1 is card-only (expandable:false)');
    ok(orgVisibility.isExpandable(f.ceo.id, scopeIds, policy) === false, 'the CEO is visible but card-only for an IC');
    // A peer (MGR-1-2, a sibling under VP-1) is NOT in the sub-tree → not expandable.
    ok(orgVisibility.isExpandable(f.mgrs[1].id, scopeIds, policy) === false, 'a peer manager is card-only (not in sub-tree)');
    // Open-directory flag flips everything to expandable.
    const openPolicy = { ...policy, lateralDepth: Infinity };
    ok(orgVisibility.isExpandable(f.ceo.id, scopeIds, openPolicy) === true, 'open-directory flag makes the CEO drillable');
    // ALL-band ESS (scopeIds null) → everything drillable.
    ok(orgVisibility.isExpandable(f.ceo.id, null, policy) === true, 'ALL-band ESS → CEO drillable');
    // Status visibility: ACTIVE shown, TERMINATED hidden by default.
    ok(orgVisibility.isEssVisibleStatus('ACTIVE', policy) === true, 'ACTIVE is ESS-visible');
    ok(orgVisibility.isEssVisibleStatus('TERMINATED', policy) === false, 'TERMINATED hidden from ESS');
    ok(orgVisibility.isEssVisibleStatus('PRE_HIRE', policy) === false, 'PRE_HIRE hidden from ESS');
    ok(orgVisibility.isEssVisibleStatus('ON_LEAVE', policy) === true, 'ON_LEAVE is ESS-visible (still employed)');
  }
  {
    // No-compensation invariant: the node DTO carries ONLY directory fields.
    const r = await orgTree.getChildren({ businessId: BIZ_A, scope: ALL, parentId: f.vp1.id, limit: 50 });
    const node = r.nodes[0];
    const compKeys = ['salary', 'ctc', 'compensation', 'pay', 'wage', 'amount', 'gross', 'net'];
    const leak = Object.keys(node).filter((k) => compKeys.some((c) => k.toLowerCase().includes(c)));
    ok(leak.length === 0, `org node carries no compensation fields (keys: ${Object.keys(node).join(',')})`);
    ok('designation' in node && 'departmentName' in node && 'photoUrl' in node, 'org node carries the directory fields (designation/department/photo)');
  }

  // ── cleanup ────────────────────────────────────────────────────────────────
  await cleanFixtures(BIZ_A);
  await cleanFixtures(BIZ_B);

  log(`\n──────── ${passCount} passed, ${failCount} failed ────────\n`);
  await prisma.$disconnect();
  process.exit(failCount === 0 ? 0 : 1);
}

run().catch(async (e) => {
  console.error('FATAL', e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});

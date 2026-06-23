'use strict';

/**
 * orgTree.js — Feature 19: the shared, session-agnostic lazy-tree query lib.
 *
 * THE one engine behind both org-chart perspectives (hr-admin operator + ESS
 * customer). It replaces "fetch the whole tenant tree and build the forest in
 * memory" with PER-NODE lazy loading so the chart stays O(visible) at 1000+ /
 * 10+ levels:
 *
 *   getRoots({ businessId, scope, cursor, limit })           -> { nodes, nextCursor }
 *   getChildren({ businessId, scope, parentId, cursor, limit }) -> { nodes, nextCursor }
 *   getAncestors({ businessId, scope, nodeId })              -> { path }   // root → … → node
 *   searchNodes({ businessId, scope, q, limit })             -> { results: [{ node, ancestorIds }] }
 *
 * Scope authority is NEVER re-implemented here. The caller resolves the F1 band
 * (operator → resolveAccessibleEmployeeIds; customer → resolveCustomerScope) and
 * hands us the resulting `scope` ({ kind:'ALL' } | { kind:'IDS', ids:Set } |
 * { kind:'NONE' }). Every query AND-restricts to the tenant wall (businessId) AND
 * the scope id-set. The CTEs are lifts of the existing F1 recursive-CTE shape
 * (scopeResolver.js / customerScope.js / rbac.controller orgTree) — the down-CTE
 * for the sub-tree, its mirror walking UP for ancestors, depth-capped at 64.
 *
 * The node DTO is the F13 OrgTree-compatible shape, extended with lazy metadata:
 *   { id, code, name, photoUrl, designation, departmentName,
 *     managerEmployeeId, reportsCount, status }
 * children are NEVER inlined — they are fetched on expand.
 */

const { Prisma } = require('@prisma/client');
const prisma = require('../../core/lib/prisma');
const { scopeAllows } = require('./scopeResolver');

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const DEPTH_CAP = 64; // mirrors rbac.controller orgTree depth guard (cycle/runaway)

// ── keyset cursor codec ──────────────────────────────────────────────────────
// The cursor is an OPAQUE base64url-encoded (lastName, firstName, id) tuple. The
// server validates/decodes and silently ignores a malformed cursor (treats it as
// the first page) — no SQL-injectable raw offset, no OFFSET drift on concurrent
// re-org. Sort key is (lastName, firstName, id) ASC: stable + index-served.
function encodeCursor(row) {
  if (!row) return null;
  const payload = JSON.stringify([row.lastName || '', row.firstName || '', row.id]);
  return Buffer.from(payload, 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const arr = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(arr) || arr.length !== 3) return null;
    const [lastName, firstName, id] = arr;
    if (typeof id !== 'string' || !id) return null;
    return { lastName: String(lastName ?? ''), firstName: String(firstName ?? ''), id };
  } catch {
    return null; // malformed → first page
  }
}

function clampLimit(limit) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

// Normalize a scope to either null (ALL → no in-list) or an array of ids. NONE →
// an empty array (matches nothing). An IDS set is materialized once.
function scopeIdList(scope) {
  if (!scope || scope.kind === 'ALL') return null; // fast path: tenant wall only
  if (scope.kind === 'NONE') return []; // matches nothing
  return [...scope.ids];
}

// ── node projector ───────────────────────────────────────────────────────────
// Hydrate a set of bare employee rows into the OrgNode DTO. designation/department
// come from a SINGLE follow-up employmentRecord fetch keyed by the page's ids
// (the same current-segment join the legacy readers use, but bounded to ≤200 rows,
// never the tenant). reportsCount is filled by a single grouped sub-count over the
// page's ids — not an N+1.
async function projectNodes(businessId, rows, { isSelfId = null } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  // Direct-report counts for THIS page's nodes, in one grouped query.
  const counts = await prisma.employee.groupBy({
    by: ['managerEmployeeId'],
    where: { businessId, deletedAt: null, managerEmployeeId: { in: ids } },
    _count: { _all: true },
  });
  const countByMgr = new Map(counts.map((c) => [c.managerEmployeeId, c._count._all]));

  // Current designation/department for this page's nodes, in one query.
  const recs = await prisma.employmentRecord.findMany({
    where: { businessId, employeeId: { in: ids }, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      employeeId: true,
      designation: { select: { title: true } },
      department: { select: { name: true } },
    },
  });
  const recByEmp = new Map();
  for (const r of recs) if (!recByEmp.has(r.employeeId)) recByEmp.set(r.employeeId, r); // first (latest) wins

  return rows.map((e) => {
    const rec = recByEmp.get(e.id);
    const name = [e.firstName, e.lastName].filter(Boolean).join(' ') || e.code;
    const node = {
      id: e.id,
      code: e.code,
      name,
      photoUrl: e.photoUrl || null,
      designation: rec && rec.designation ? rec.designation.title : null,
      departmentName: rec && rec.department ? rec.department.name : null,
      managerEmployeeId: e.managerEmployeeId || null,
      reportsCount: Number(countByMgr.get(e.id) || 0),
      status: e.status,
    };
    if (isSelfId && e.id === isSelfId) node.isSelf = true;
    return node;
  });
}

const PAGE_SELECT = {
  id: true, code: true, firstName: true, lastName: true,
  photoUrl: true, managerEmployeeId: true, status: true,
};

// Apply the keyset predicate (lastName, firstName, id) > cursor as a Prisma OR.
function keysetWhere(cursor) {
  if (!cursor) return {};
  return {
    OR: [
      { lastName: { gt: cursor.lastName } },
      { lastName: cursor.lastName, firstName: { gt: cursor.firstName } },
      { lastName: cursor.lastName, firstName: cursor.firstName, id: { gt: cursor.id } },
    ],
  };
}

const ORDER = [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }];

// Run a keyset-paginated page query and split off nextCursor (the +1 probe row).
async function pageQuery(where, cursor, limit, { isSelfId = null, businessId } = {}) {
  const take = limit + 1;
  const rows = await prisma.employee.findMany({
    where: { ...where, ...keysetWhere(cursor) },
    orderBy: ORDER,
    take,
    select: PAGE_SELECT,
  });
  let nextCursor = null;
  let pageRows = rows;
  if (rows.length > limit) {
    pageRows = rows.slice(0, limit);
    nextCursor = encodeCursor(pageRows[pageRows.length - 1]);
  }
  const nodes = await projectNodes(businessId, pageRows, { isSelfId });
  return { nodes, nextCursor };
}

// ── getChildren ──────────────────────────────────────────────────────────────
// Direct reports of `parentId`, keyset-paginated, scope-clamped. Caller is
// expected to have already validated `parentId ∈ scope` (scopeAllows) at the
// route — but we defensively AND-restrict the child rows to the scope id-set too
// (a manager can only ever see in-scope children).
async function getChildren({ businessId, scope, parentId, cursor, limit, isSelfId = null }) {
  const lim = clampLimit(limit);
  const ids = scopeIdList(scope);
  if (ids && ids.length === 0) return { nodes: [], nextCursor: null }; // NONE
  const where = { businessId, deletedAt: null, managerEmployeeId: parentId };
  if (ids) where.id = { in: ids };
  return pageQuery(where, decodeCursor(cursor), lim, { isSelfId, businessId });
}

// ── getRoots ─────────────────────────────────────────────────────────────────
// For an ALL scope: roots = employees with managerEmployeeId IS NULL, PLUS
// "orphans" whose manager is soft-deleted / out-of-tenant (mirrors org.controller
// orphan logic). For an IDS scope (manager operator / ESS): the single root is the
// scope anchor's own node (?root=me semantics) — no scan. An explicit in-scope
// rootId re-roots the viewport at that node (validated by the caller via
// scopeAllows).
async function getRoots({ businessId, scope, cursor, limit, rootId = null, isSelfId = null }) {
  const lim = clampLimit(limit);
  const ids = scopeIdList(scope);
  if (ids && ids.length === 0) return { nodes: [], nextCursor: null }; // NONE

  // Explicit re-root (admin ?root=<id>): return just that node as the single root.
  if (rootId) {
    const rows = await prisma.employee.findMany({
      where: { businessId, deletedAt: null, id: rootId },
      select: PAGE_SELECT, take: 1,
    });
    const nodes = await projectNodes(businessId, rows, { isSelfId });
    return { nodes, nextCursor: null };
  }

  // IDS scope (manager/ESS): the sole root is the anchor's own node.
  if (ids) {
    // The scope anchor is the actor's own employee id; for a TEAM band it is the
    // smallest "covering root" — but resolveAccessibleEmployeeIds always seeds the
    // set WITH selfId, and the caller passes isSelfId = the anchor. Return the
    // anchor node as the single root.
    const anchorId = isSelfId && ids.includes(isSelfId) ? isSelfId : ids[0];
    const rows = await prisma.employee.findMany({
      where: { businessId, deletedAt: null, id: anchorId },
      select: PAGE_SELECT, take: 1,
    });
    const nodes = await projectNodes(businessId, rows, { isSelfId });
    return { nodes, nextCursor: null };
  }

  // ALL scope: real roots = managerEmployeeId IS NULL ∪ orphans (manager not in the
  // live tenant set). Compute the orphan set once, then keyset-paginate the union.
  // The orphan manager-ids are bounded by distinct managers; in practice tiny.
  const liveIds = new Set(
    (await prisma.employee.findMany({ where: { businessId, deletedAt: null }, select: { id: true } })).map((r) => r.id),
  );
  const orphanManagerRows = await prisma.employee.findMany({
    where: { businessId, deletedAt: null, managerEmployeeId: { not: null } },
    select: { id: true, managerEmployeeId: true },
  });
  const orphanIds = orphanManagerRows.filter((r) => !liveIds.has(r.managerEmployeeId)).map((r) => r.id);

  const where = {
    businessId, deletedAt: null,
    OR: [{ managerEmployeeId: null }, { id: { in: orphanIds } }],
  };
  return pageQuery(where, decodeCursor(cursor), lim, { isSelfId, businessId });
}

// ── getAncestors ─────────────────────────────────────────────────────────────
// Recursive CTE walking UP managerEmployeeId from nodeId to the root (the inverse
// of the F1 down-CTE), depth-capped at 64. Returns the path root → … → node
// (top-down, inclusive). The hydrated path is projected through the same node
// projector. Scope/policy flagging (expandable:false above self) is layered by the
// caller (ESS), not here — this lib returns the raw path; the caller decides what
// to expose. For an IDS scope we still return the full chain to the root so the
// breadcrumb can render, but the route gates which nodes are drillable.
async function getAncestors({ businessId, scope, nodeId, isSelfId = null }) {
  // The up-CTE is intentionally NOT scope-filtered (ancestors above an IDS actor
  // legitimately live outside their sub-tree — that is the point of "path to top").
  // The route must independently confirm nodeId itself is in scope before calling.
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE up AS (
      SELECT e.id, e."managerEmployeeId", 0 AS lvl
        FROM "Employee" e
        WHERE e.id = ${nodeId} AND e."businessId" = ${businessId} AND e."deletedAt" IS NULL
      UNION ALL
      SELECT e.id, e."managerEmployeeId", up.lvl + 1
        FROM "Employee" e
        JOIN up ON e.id = up."managerEmployeeId"
        WHERE e."businessId" = ${businessId} AND e."deletedAt" IS NULL AND up.lvl < ${DEPTH_CAP}
    )
    SELECT id, lvl FROM up ORDER BY lvl DESC`; // root → … → node
  if (!rows.length) return { path: [] };

  const order = rows.map((r) => r.id); // already root→node
  const lvlById = new Map(rows.map((r) => [r.id, Number(r.lvl)]));
  const emps = await prisma.employee.findMany({
    where: { businessId, deletedAt: null, id: { in: order } },
    select: PAGE_SELECT,
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  const nodes = await projectNodes(businessId, ordered, { isSelfId });
  // Re-sort defensively by CTE level (root→node) and tag depth.
  nodes.sort((a, b) => (lvlById.get(b.id) || 0) - (lvlById.get(a.id) || 0));
  return { path: nodes };
}

// ── searchNodes ──────────────────────────────────────────────────────────────
// ILIKE prefix/contains over firstName/lastName/code within tenant + scope, then
// one batched getAncestors per hit to attach ancestorIds (so the client expands
// exactly the branches to reveal a result — never the whole tree). Out-of-scope
// rows are never returned.
async function searchNodes({ businessId, scope, q, limit, isSelfId = null }) {
  const term = String(q || '').trim();
  if (term.length < 1) return { results: [] };
  const lim = clampLimit(limit || 20);
  const ids = scopeIdList(scope);
  if (ids && ids.length === 0) return { results: [] }; // NONE

  const like = { contains: term, mode: 'insensitive' };
  const where = {
    businessId, deletedAt: null,
    OR: [{ firstName: like }, { lastName: like }, { code: like }],
  };
  if (ids) where.id = { in: ids };

  const rows = await prisma.employee.findMany({
    where, orderBy: ORDER, take: lim, select: PAGE_SELECT,
  });
  if (!rows.length) return { results: [] };

  const nodes = await projectNodes(businessId, rows, { isSelfId });

  // Batched ancestor-ids per hit, in a single recursive CTE seeded with all hit ids.
  const hitIds = rows.map((r) => r.id);
  const ancRows = await prisma.$queryRaw`
    WITH RECURSIVE up AS (
      SELECT e.id AS seed, e.id, e."managerEmployeeId", 0 AS lvl
        FROM "Employee" e
        WHERE e.id IN (${Prisma.join(hitIds)}) AND e."businessId" = ${businessId} AND e."deletedAt" IS NULL
      UNION ALL
      SELECT up.seed, e.id, e."managerEmployeeId", up.lvl + 1
        FROM "Employee" e
        JOIN up ON e.id = up."managerEmployeeId"
        WHERE e."businessId" = ${businessId} AND e."deletedAt" IS NULL AND up.lvl < ${DEPTH_CAP}
    )
    SELECT seed, id, lvl FROM up ORDER BY seed, lvl DESC`;
  // Group ancestor ids per seed (root→node, EXCLUDING the seed itself).
  const ancBySeed = new Map();
  for (const r of ancRows) {
    if (r.id === r.seed) continue; // exclude the hit node itself
    if (!ancBySeed.has(r.seed)) ancBySeed.set(r.seed, []);
    ancBySeed.get(r.seed).push({ id: r.id, lvl: Number(r.lvl) });
  }

  const results = nodes.map((node) => {
    const anc = (ancBySeed.get(node.id) || []).sort((a, b) => b.lvl - a.lvl).map((a) => a.id);
    return { node, ancestorIds: anc };
  });
  return { results };
}

module.exports = {
  getRoots,
  getChildren,
  getAncestors,
  searchNodes,
  // exported for tests + route-layer reuse
  projectNodes,
  encodeCursor,
  decodeCursor,
  clampLimit,
  scopeIdList,
  scopeAllows,
  DEFAULT_PAGE,
  MAX_PAGE,
  DEPTH_CAP,
};

# Feature 19 — Scalable Org Chart (1000+ employees, multi-level hierarchy, two perspectives)

> **Status:** spec / dev contract · **Module:** extends `backend/src/hr/controllers/org.controller.js` + `backend/src/hr/controllers/rbac.controller.js` + `backend/src/hr/profile/meTeam.controller.js`; new `backend/src/hr/lib/orgTree.js` (shared lazy-tree query lib) · **Apps:** `apps/hr-admin/app/org/chart`, `apps/ess` (`OrgTree.js` redesign)
> **Markets:** India + New Zealand (org chart is country-agnostic — it carries **no** payroll/tax/statutory surface; the strict single-country-per-tenant rule is irrelevant here because nothing on this screen branches on `Entity.countryCode`). · **Builds on:** F1 RBAC/hierarchy (`scopeResolver.js` recursive CTE over `Employee.managerEmployeeId`, `scope.middleware.js`, `rbac.js`), the F13 ESS `/api/hr/me/team/*` customer surface + `OrgTree.js` component, and the existing `GET /api/hr/org/tree`, `GET /api/hr/rbac/org-tree`, `GET /api/hr/me/team/org` reads.
> **Author note:** every schema field / RBAC key / file path / line range below was verified against the live tree on 2026-06-24. No new Prisma model is required; the **only** schema change is two additive covering indexes on `Employee` (§3). Everything else is query-shape + API + UX.

---

## 1. Summary & goals

Today DriftHR renders the org hierarchy three different ways and **all three eagerly fetch every employee in the tenant and build the whole forest in memory**, then ship it as one nested JSON blob:

- `org.controller.js tree()` (lines 85–157) — admin `GET /api/hr/org/tree` — `prisma.employee.findMany({ where:{ businessId, deletedAt:null } })` over the **entire tenant**, links children to parents in a `Map`, returns the full nested forest (`items: roots`), or the single self-rooted node for `?root=me`.
- `rbac.controller.js orgTree()` (lines 281–320) — `GET /api/hr/rbac/org-tree` — a recursive CTE that returns **every** node as a *flat* depth-tagged array (plus orphans + `flatMode`), again whole-tenant.
- `meTeam.controller.js org()` (lines 302–342) — ESS `GET /api/hr/me/team/org` — fetches the scope-filtered set (`scope.kind==='IDS'` → self + sub-tree) and nests it in memory.

At ~34 people this is fine. At **1000+** with deep multi-level hierarchy it is not: the admin tree ships a multi-megabyte JSON of every employee + their current `EmploymentRecord`/designation/department join, the browser mounts thousands of DOM nodes (the current `apps/hr-admin/app/org/chart/page.js` recurses the whole forest and `countNodes` walks all of it), and the ESS "Focus" drill re-roots a tree it already downloaded in full. There is no pagination of wide sibling sets (a CEO with 200 direct reports renders 200 cards), search is client-side over the already-downloaded blob, and there is no first-class "path to the top" breadcrumb beyond the local drill stack.

This feature **redesigns the org chart for scale** without changing the underlying data model. The hierarchy stays exactly `Employee.managerEmployeeId` (self-relation `EmpManager`, schema line 6613–6615). We replace "fetch the whole tree" with **per-node lazy loading**: the client fetches only the roots (or its self-node), then fetches a node's children **on expand**, paginating wide sibling sets, and fetches a node's **ancestor path** to draw the breadcrumb-to-top. Search hits the server (indexed, scoped) and returns matches **with their ancestor path** so the UI can expand exactly the branches needed to reveal a result — never the whole tree.

Two **perspectives**, one engine:

1. **Admin perspective** (operator session, hr-admin): the full forest from any root. An Owner/HR-Admin lands on the tenant roots, lazily drills any branch, can search the whole tenant, and can **re-root** the viewport at any node (deep-link `?root=<id>`). Manager operators are **scope-clamped** to their own sub-tree by the F1 band (the lazy endpoints reuse `resolveAccessibleEmployeeIds`, so a manager's "roots" are their own node and they can never expand outside their sub-tree).
2. **Employee / ESS perspective** (customer session): an **employee-centric** view. The employee sees **themselves**, can expand **down** through their subordinates to the leaves, sees their **path UP to the top** (ancestor chain CEO → … → my manager → me) as a breadcrumb, and can **jump to the top of the org** to browse down from the CEO (read-only directory-card depth — no compensation, identical masking to the F13 `/me/team/directory`). Whether an ESS user may see *above* their own manager and *across* to siblings is a **tenant visibility policy** (default: can see the ancestor chain + the top, but lateral/peer sub-trees are collapsed to card-only) — see §3.3 and §9.

**Goals (v1)**
- An org chart that opens in <300 ms and stays responsive at 1000+ / 10+ levels because **the client never holds more than the visible+expanded nodes**.
- Per-node lazy children API with **cursor pagination** of wide sibling sets (default page 50).
- **Ancestors API** → breadcrumb path-to-top for any node in one round trip.
- **Server search** (indexed, scope-filtered) that returns each match **plus its ancestor id-path**, so "search-to-locate" auto-expands precisely the branches to reveal the hit.
- The **two perspectives** share one query lib (`orgTree.js`) and the **same F1 scope chokepoint** — zero new scope logic.
- Backward-compatible: the legacy whole-tree endpoints keep working for small tenants and as a fallback (§7 slice 6); the redesigned client prefers the lazy endpoints.

**Non-goals (v1)**: dotted-line / matrix (secondary) reporting (the data model is strictly one manager per employee — `managerEmployeeId` is a single nullable FK; a future `EmployeeReportingLine` join is roadmap, §10); org-chart **export/print** to PDF/PNG (roadmap); drag-and-drop re-org on the chart (re-parent already exists via `PATCH /api/hr/rbac/employees/:id`, gated `canManageHierarchy` — we link to it, we do not build a DnD canvas); historical / as-of-date org snapshots (we render the *current* hierarchy only); headcount roll-ups / span-of-control analytics (roadmap).

---

## 2. Scope

### In scope (reuse-first)
- **Reuse as-is:** the recursive-CTE pattern over `Employee.managerEmployeeId` (lifted verbatim from `scopeResolver.js` lines 82–96 and `customerScope.js reportingSubtreeIds` lines 105–123); `resolveAccessibleEmployeeIds` / `scopeWhere` / `scopeAllows` (operator session) and `resolveCustomerScope` (customer session) as the **only** authorities for who-can-see-whom; `attachSelfEmployee` (`scope.middleware.js`) for `?root=me`; `requirePermission('canViewEmployees')` / `requireCustomer`; the F13 `OrgTree.js` node-card shape `{ id, code, name, photoUrl, designation, departmentName, reportsCount, children }`; the current-`EmploymentRecord` designation/department join already used in all three readers.
- **Add (new):** `backend/src/hr/lib/orgTree.js` — a small, session-agnostic lib of four scope-aware queries (`getRoots`, `getChildren`, `getAncestors`, `searchNodes`) + the shared node projector; three thin lazy endpoints per surface that call it; the redesigned virtualized client tree (lazy expand, sibling pagination, breadcrumb, server search) in both apps.
- **Two additive `Employee` indexes** (§3.1) so child-listing, counting, and search are index-only at 1000+.

### Out of scope (v1)
Secondary/matrix reporting, export/print, drag-drop re-org, historical snapshots, span-of-control analytics, a configurable per-tenant org-visibility policy **UI** (we ship a sensible default in code; tenant override is a flag).

---

## 3. Data model

**No new model.** The hierarchy is the existing self-relation:

```prisma
// Employee (schema.prisma line 6550) — UNCHANGED, shown for reference:
//   managerEmployeeId String?
//   manager   Employee?  @relation("EmpManager", fields:[managerEmployeeId], references:[id], onDelete: SetNull)
//   reports   Employee[] @relation("EmpManager")
//   status    EmployeeStatus @default(PRE_HIRE)
//   deletedAt DateTime?   // soft delete — every org query filters deletedAt IS NULL
```

### 3.1 Two additive covering indexes (the only migration)

The current `Employee` indexes are `@@unique([businessId, code])`, `@@index([businessId, status])`, `@@index([businessId, managerEmployeeId])`, `@@index([businessId, workEmail])` (schema lines 6662–6665). `(businessId, managerEmployeeId)` already serves child-listing and the recursive CTE join. We add two to keep the lazy API index-only at scale:

```prisma
// inside model Employee, alongside the existing @@index lines:
@@index([businessId, managerEmployeeId, lastName, firstName]) // ordered child pages (sibling sort) without a sort step
@@index([businessId, lastName, firstName])                    // tenant-wide name sort + search prefix
```

Both are additive (index-only) → **zero data migration risk**, deploy-safe per `DEPLOY_POLICY.md`. Name search uses a case-insensitive `ILIKE` prefix/contains over `firstName`/`lastName`/`code`; if a tenant ever exceeds ~50k employees, a `pg_trgm` GIN index on `lower(firstName||' '||lastName)` is the documented next step (flagged, not built — at 1000s the b-tree prefix is ample).

### 3.2 The node DTO (one shape, everywhere)

Every endpoint returns nodes in the F13 `OrgTree.js`-compatible shape, extended with lazy metadata:

```ts
type OrgNode = {
  id: string;
  code: string;                 // EMP-000142
  name: string;                 // "First Last" || code
  photoUrl: string | null;
  designation: string | null;   // current EmploymentRecord.designation.title
  departmentName: string | null;// current EmploymentRecord.department.name
  managerEmployeeId: string | null;
  reportsCount: number;         // DIRECT reports (for the "N reports" pill + "hasChildren")
  status: 'ACTIVE' | 'ON_LEAVE' | 'PRE_HIRE' | 'TERMINATED' | ...; // EmployeeStatus (admin shows inactive dimmed; ESS hides non-active by default)
  isSelf?: boolean;             // marks the viewer's own node (ESS)
  // children are NEVER inlined by the lazy endpoints — fetched on expand.
};
```

`reportsCount` is the **direct** child count (computed by the lazy `getChildren`/`getRoots` query, not a per-row N+1). `reportsCount > 0` ⇒ the node renders an expand chevron. This replaces the old reader habit of nesting `children: [...]` eagerly.

### 3.3 Org-visibility policy (code default, tenant override = flag)

A tiny code map governs how far an **ESS** user may traverse (operators are governed purely by the F1 band). Default:

```js
// orgVisibility.js (new, ~15 lines) — sensible default; tenant override deferred (flag).
const DEFAULT_ESS_ORG_POLICY = {
  canSeeAncestorsToTop: true,   // breadcrumb CEO → … → me (read-only cards)
  canSeeTop: true,              // "Go to top" → browse down from the root(s), card-only
  lateralDepth: 0,              // peers / cousins shown as cards but NOT expandable (0 = no drilling sideways)
  showInactive: false,          // ESS hides TERMINATED/PRE_HIRE; admin shows them dimmed
};
```

`lateralDepth: 0` means: when an ESS user navigates **up** or to the **top**, nodes **outside their own reporting sub-tree** are visible as cards (name/photo/designation/department — the same fields the F13 directory already exposes tenant-wide) but their **expand chevron is disabled** — you can *see* that the CFO exists and who the CFO reports to, but you cannot drill into the CFO's private sub-tree. Inside your **own** sub-tree you expand freely to the leaves. This is the safe default; a tenant that wants a fully-open directory sets `lateralDepth: Infinity` (flag).

---

## 4. API surface (with RBAC)

One lib (`orgTree.js`), surfaced on the **two existing route stacks** so each session type keeps its own auth/scope wiring. All paths are additive; legacy whole-tree endpoints remain (§7 slice 6 deprecation note).

### 4.0 Shared lib — `backend/src/hr/lib/orgTree.js`

```
getRoots({ businessId, scope, page })        -> { nodes: OrgNode[], nextCursor }
getChildren({ businessId, scope, parentId, page }) -> { nodes: OrgNode[], nextCursor }
getAncestors({ businessId, scope, nodeId })  -> { path: OrgNode[] }   // root → … → node (inclusive), top-down
searchNodes({ businessId, scope, q, limit }) -> { results: Array<{ node: OrgNode, ancestorIds: string[] }> }
```

- **`scope`** is the result of `resolveAccessibleEmployeeIds(actor, 'canViewEmployees')` (operator) or `resolveCustomerScope(customer,'canViewEmployees').scope` (customer). Every query AND-restricts to the tenant wall **and** the scope id-set via the existing `scopeWhere(scope,'id')` semantics. `kind:'ALL'` → no in-list (fast path). `kind:'IDS'` → child rows further filtered to the set. `kind:'NONE'` → empty.
- **Roots under a scope:** for `ALL`, roots = employees with `managerEmployeeId IS NULL` **plus** "orphans" whose manager is soft-deleted/out-of-tenant (mirrors `org.controller` lines 137–146). For an `IDS` scope (manager operator / ESS), the single root = the actor's own node (`?root=me` semantics); their sub-tree is everything reachable below it — so `getRoots` for an `IDS` scope returns just `[selfNode]`.
- **Pagination:** keyset cursor on `(lastName, firstName, id)` (covered by the new index 3.1) — `nextCursor` is the opaque encoded last tuple; absent ⇒ last page. Default `page=50`, max `200`. This is what tames a 200-direct-report manager.
- **`getChildren` count:** each returned child's `reportsCount` is filled by a single grouped sub-count (`GROUP BY managerEmployeeId`) over that page's ids — **not** N+1.
- **`getAncestors`:** a recursive CTE walking **up** `managerEmployeeId` from `nodeId` to the root (the inverse of the existing down-CTE), capped at depth 64 (matches the `t.depth < 64` guard in `rbac.controller` line 294). For an `IDS` scope (ESS), the returned path is **truncated to what policy allows**: by default the full chain to the top is returned (cards), but ancestors above the actor are flagged `expandable:false` per §3.3.
- **`searchNodes`:** `ILIKE` over `firstName`/`lastName`/`code` within tenant + scope, `LIMIT` (default 20). For each hit, one `getAncestors` (batched) yields `ancestorIds` so the client expands the path. Out-of-scope hits are never returned (a manager searching only finds their own sub-tree; an ESS user finds their sub-tree + ancestor chain + top-level names per policy).

### 4.1 HR-admin — operator session (`protect` + `canViewEmployees`), on `org.routes.js`

| Method & path | Permission | Returns |
|---|---|---|
| `GET /api/hr/org/tree/roots?cursor&limit` | `canViewEmployees` | `{ nodes, nextCursor }` — tenant roots (scope-clamped: a manager gets their own node) |
| `GET /api/hr/org/tree/nodes/:id/children?cursor&limit` | `canViewEmployees` | `{ nodes, nextCursor }` — direct reports of `:id`, paginated; 404 if `:id` ∉ scope (`scopeAllows`) |
| `GET /api/hr/org/tree/nodes/:id/ancestors` | `canViewEmployees` | `{ path }` — root→`:id` chain; 404 if `:id` ∉ scope |
| `GET /api/hr/org/tree/search?q&limit` | `canViewEmployees` | `{ results:[{ node, ancestorIds }] }` — scope-filtered |

`:id` is **always** re-scoped with `scopeAllows(scope, id)` → out-of-scope ⇒ 404 (identical to the F1 `withEmployeeScope` single-row pattern). `?root=me` is implicit for an `IDS` scope; an admin may pass `?root=<id>` to `/roots` to re-root the viewport at any in-scope node (validated by `scopeAllows`).

### 4.2 ESS — customer session (`requireCustomer`), on `meTeam.routes.js`

| Method & path | Scope | Returns |
|---|---|---|
| `GET /api/hr/me/team/org/self` | self anchor | `{ self, ancestors }` — the viewer's node **plus** its ancestor path to the top (one call → renders the breadcrumb + the focused node immediately) |
| `GET /api/hr/me/team/org/nodes/:id/children?cursor&limit` | TEAM band | direct reports of `:id`, paginated; **expand gate**: `:id` must be in the actor's sub-tree (or be a policy-allowed ancestor with `lateralDepth>0`) else 404 |
| `GET /api/hr/me/team/org/nodes/:id/ancestors` | TEAM band + policy | root→`:id` chain (top-down), ancestors above self flagged `expandable:false` |
| `GET /api/hr/me/team/org/top?cursor&limit` | policy `canSeeTop` | the tenant **roots** as cards (so an employee can "see the top of the org"); each non-own-subtree root is `expandable:false` by default |
| `GET /api/hr/me/team/org/search?q&limit` | TEAM band + policy | scope+policy-filtered matches with `ancestorIds` |

The ESS endpoints reuse `resolveCustomerScope(req.customer,'canViewEmployees')` exactly as `meTeam.controller.org()` does today (lines 305–306). `canViewEmployees` is a **non-approval** action, so the ALL-band SoD narrowing in `customerScope.js` (lines 92–96) does **not** fire — a rare ALL-band ESS user legitimately sees the whole tenant; the common SELF/TEAM band gets self+sub-tree. Policy (§3.3) layers on top for the ancestor/top traversals.

### 4.3 Backward-compat (kept, deprecated for large tenants)

`GET /api/hr/org/tree`, `GET /api/hr/rbac/org-tree`, `GET /api/hr/me/team/org` are **unchanged** and continue to serve small tenants and the existing `flatMode`/orphan/`reparent` builder logic. The redesigned clients call the lazy endpoints; the whole-tree readers gain a soft cap (if `total > 500`, respond `{ truncated:true, hint:'use /tree/roots' }` for `org/tree` so an old client degrades gracefully instead of OOMing). Re-parent (`PATCH /api/hr/rbac/employees/:id`, `canManageHierarchy`) and its cycle guard are untouched and remain the org-edit path.

---

## 5. Query shapes (the heart of the redesign)

### 5.1 Children of a node — keyset-paginated, scope-clamped, count-joined
```sql
-- getChildren(parentId, cursor=(lastName,firstName,id), limit)
SELECT e.id, e.code, e."firstName", e."lastName", e."photoUrl", e."managerEmployeeId", e.status,
       (SELECT count(*) FROM "Employee" c
          WHERE c."managerEmployeeId" = e.id AND c."businessId" = $biz AND c."deletedAt" IS NULL) AS reports_count
  FROM "Employee" e
 WHERE e."businessId" = $biz AND e."deletedAt" IS NULL
   AND e."managerEmployeeId" = $parentId
   AND ($cursor IS NULL OR (e."lastName", e."firstName", e.id) > $cursor)   -- keyset
 ORDER BY e."lastName" ASC, e."firstName" ASC, e.id ASC
 LIMIT $limit + 1;   -- +1 row probes for nextCursor
```
The correlated `reports_count` sub-select is index-served by `(businessId, managerEmployeeId)`; the ORDER BY is index-served by the new `(businessId, managerEmployeeId, lastName, firstName)`. Designation/department for the page come from a **single** follow-up `employmentRecord` fetch keyed by the page's employee ids (`where:{ employeeId:{ in: pageIds }, isCurrent:true }`) — same join the current readers use, but bounded to ≤200 rows, not the tenant.

### 5.2 Ancestors of a node — recursive CTE walking UP
```sql
WITH RECURSIVE up AS (
  SELECT id, "managerEmployeeId", 0 AS lvl FROM "Employee"
   WHERE id = $nodeId AND "businessId" = $biz AND "deletedAt" IS NULL
  UNION ALL
  SELECT e.id, e."managerEmployeeId", up.lvl + 1 FROM "Employee" e
   JOIN up ON e.id = up."managerEmployeeId"
   WHERE e."businessId" = $biz AND e."deletedAt" IS NULL AND up.lvl < 64
)
SELECT id, "managerEmployeeId", lvl FROM up ORDER BY lvl DESC;  -- root → … → node
```
Reverse of the existing down-CTE; the `lvl < 64` cap mirrors `rbac.controller` line 294 (cycle/runaway guard). Result hydrated through the same node projector.

### 5.3 Roots under a scope
- `ALL`: `WHERE managerEmployeeId IS NULL` (+ orphans: manager id not in the tenant's live set — computed once, mirrors `org.controller` orphan logic) → keyset-paginated like children.
- `IDS` (manager/ESS): roots = `[scope anchor self node]` (single row); no scan.

### 5.4 Search
```sql
SELECT ... FROM "Employee" e
 WHERE e."businessId" = $biz AND e."deletedAt" IS NULL
   AND ( e."firstName" ILIKE $q OR e."lastName" ILIKE $q OR e.code ILIKE $q )
   AND ($scopeIds IS NULL OR e.id = ANY($scopeIds))   -- scopeWhere applied
 ORDER BY e."lastName", e."firstName" LIMIT $limit;
```
then `getAncestors` (batched by a single CTE seeded with all hit ids) to attach `ancestorIds` per result.

---

## 6. UX (plain language)

### 6.1 HR-admin — `apps/hr-admin/app/org/chart/page.js` (redesign)
- **First paint:** call `/org/tree/roots` → render the top-level cards (CEO + any orphans), each with a "N reports" pill and an expand chevron when `reportsCount>0`. Nothing below the roots is fetched yet.
- **Expand:** clicking a chevron calls `/nodes/:id/children?limit=50`; the returned page mounts under the node. If `nextCursor` is present, a **"Show 50 more reports"** row at the bottom of that sibling group fetches the next page (sibling pagination — a 200-report manager shows 50 + a load-more, never 200 cards).
- **Virtualization:** the rendered tree is windowed — only cards in/near the viewport mount (react-window-style row virtualization over the flattened visible-node list; a node is "visible" only if all its ancestors are expanded). Collapsing a node unmounts its descendants. This keeps the DOM at hundreds of nodes regardless of tenant size, fixing the current `countNodes`/full-recurse mount.
- **Search-to-locate:** typing in the search box (debounced) calls `/org/tree/search`; results drop into a list. Picking a result calls nothing extra — the client already has each hit's `ancestorIds`, so it **expands exactly that path** (lazily fetching any children pages along the way) and scrolls the match into view, highlighted (reusing the current `isMatch` ring styling).
- **Re-root / breadcrumb:** a node's "Focus" button re-roots the viewport (deep-link `?root=<id>`, `/roots` validates scope); a **breadcrumb** built from `/nodes/:id/ancestors` shows root → … → focused node, each segment clickable to re-root upward (replaces the in-memory drill stack). "Back to full org" clears `?root`.
- **Collapse/expand all** is bounded: "expand all" only auto-expands the **currently loaded** branches (it will not eagerly fetch the whole tenant); a tooltip says so.
- Inactive employees (`status` ≠ ACTIVE) render dimmed with a status chip (admin sees them; the re-parent link stays available for org cleanup).

### 6.2 ESS — `apps/ess` "My Org" (redesign of `OrgTree.js` + its page)
- **Self-rooted landing:** call `/me/team/org/self` → one response gives **(a)** the breadcrumb **path to the top** (CEO → … → my manager → **me**, the ancestors `expandable:false` by default) and **(b)** my own node expanded to show my direct reports' count. The viewer's card is badged "You" (`isSelf`).
- **Drill down:** expanding my node (or any node in **my** sub-tree) calls `/me/team/org/nodes/:id/children` — same lazy + paginate + virtualize as admin — all the way to the leaves.
- **Path up + see the top:** the breadcrumb is always visible (path-to-top). A **"Go to top of org"** action calls `/me/team/org/top` to list the tenant root(s) as cards; from there the employee can read down the org as cards, but branches **outside their own sub-tree are card-only** (chevron disabled) under the default policy — they can *see* the org's shape and names, not drill private sub-trees. (A fully-open-directory tenant flips `lateralDepth`.)
- **Search:** ESS search returns only what policy allows (own sub-tree + ancestor chain + top-level names); picking a result in your own sub-tree expands the path and scrolls to it.
- Card content is the F13 directory contract — Photo | Name | Designation · Department — **no compensation, ever** (matches the masked `/me/team/directory`).

### 6.3 Shared component
`OrgTree.js` is refactored from "render a fully-nested `nodes` forest" to a **lazy controlled tree**: it takes `loadChildren(id, cursor)`, `loadAncestors(id)`, `search(q)` callbacks (so hr-admin and ESS inject their own scoped API client), tracks expanded-node + per-node child-pages + cursor state, and virtualizes the visible rows. The presentational card (photo/name/designation/department/reports-pill/Focus) is preserved; the data-loading becomes incremental.

---

## 7. Build plan (5 slices)

### Slice 19a — Shared lazy-tree lib + indexes (backend foundation)
`backend/src/hr/lib/orgTree.js` with `getRoots/getChildren/getAncestors/searchNodes` + the node projector + keyset cursor codec; the two additive `Employee` indexes (§3.1) via a Prisma migration; unit tests for each query (pagination edges, depth cap, orphan roots, scope `ALL`/`IDS`/`NONE`).

### Slice 19b — HR-admin lazy endpoints (operator session)
Wire `/org/tree/roots|/nodes/:id/children|/nodes/:id/ancestors|/search` on `org.routes.js`, all `canViewEmployees`, all `scopeAllows`-gated, reusing `resolveAccessibleEmployeeIds`. Soft-cap the legacy `org/tree` (`truncated` hint > 500). RBAC + scope tests (manager clamped to sub-tree; out-of-scope `:id` → 404; tenant isolation).

### Slice 19c — ESS lazy endpoints (customer session)
Wire `/me/team/org/self|/top|/nodes/:id/children|/nodes/:id/ancestors|/search` on `meTeam.routes.js` via `resolveCustomerScope`; add `orgVisibility.js` policy + the ancestor/top `expandable` flagging. Tests: self-anchor, ancestor chain, top-of-org card-only, lateral non-expandable, no-compensation projection, SELF-band employee with no reports (self only).

### Slice 19d — Component redesign (virtualized lazy `OrgTree.js`)
Refactor `apps/ess/components/OrgTree.js` to the controlled lazy/virtualized tree (callbacks, expanded state, sibling pagination "show more", breadcrumb, search-to-locate path-expansion). Keep the presentational card. Make it injectable so both apps share it.

### Slice 19e — Wire both pages + search/breadcrumb UX
Redesign `apps/hr-admin/app/org/chart/page.js` (roots-first, lazy expand, server search, re-root via `?root`, breadcrumb) and the ESS "My Org" page (self-landing, path-to-top, go-to-top, drill-down). Loading/empty/error states; `flatMode` banner preserved; "expand all" bounded-to-loaded warning. Manual + light e2e at a seeded 1000-employee/10-level tenant to confirm first-paint and expand are O(visible), not O(tenant).

*(Optional slice 19f — perf hardening: add the `pg_trgm` GIN search index behind a size flag; add `Cache-Control: private, max-age=30` to children/ancestors reads; only if the seeded-scale test shows search/sort hot. Deferred unless needed.)*

---

## 8. Reuse & refactors
- **One scope authority, untouched:** operator reads → `resolveAccessibleEmployeeIds`+`scopeWhere`+`scopeAllows`; customer reads → `resolveCustomerScope`. No new scope code; the lazy lib only *consumes* a resolved `scope`.
- **The CTEs are lifts, not inventions:** down-CTE = `scopeResolver.js` 82–96 / `reportingSubtreeIds`; up-CTE = its mirror; depth cap = `rbac.controller` line 294. Re-parent + cycle guard (`rbac.controller` 322–360) are the unchanged edit path.
- **Hoist the node projector** (`{id,code,name,photoUrl,designation,departmentName,reportsCount,status}` from a current-`EmploymentRecord` join) once in `orgTree.js`; `org.controller.tree()`, `rbac.controller.orgTree()`, `meTeam.controller.org()` are refactored to call the projector (removing three near-duplicate node builders), while keeping their legacy response shapes.

## 9. Security, privacy & edge cases
- **Tenant wall + scope on every query** — `businessId` AND `scopeWhere`; `:id` re-validated by `scopeAllows` → 404 out-of-scope (a manager cannot list a peer's children; an ESS user cannot expand a private sub-tree by guessing an id). Search never returns out-of-scope rows.
- **No compensation on either surface** — the org node carries only directory fields; ESS reuses the masked `/me/team` projection.
- **ESS upward/lateral visibility is policy-gated** (§3.3): default exposes the ancestor chain + top-level **names** (already tenant-wide via the directory) but **not** drill-down into others' sub-trees; ancestors/peers are `expandable:false`. A tenant opting into an open directory sets the flag.
- **Cycles / runaway depth** — both CTEs cap at depth 64; the existing `detectReportingCycle` keeps the data acyclic on re-parent, so a cycle can't be persisted in the first place.
- **Orphans & soft-deletes** — a node whose manager is soft-deleted/out-of-tenant surfaces as a root (mirrors current logic); `deletedAt IS NULL` everywhere; terminated employees are hidden from ESS by default, dimmed for admin.
- **Keyset cursor integrity** — cursor is an opaque encoded `(lastName,firstName,id)`; the server validates/decodes and ignores a malformed cursor (treats as first page) — no SQL-injectable raw offset, no `OFFSET` drift on concurrent re-org.
- **Performance invariant** — first paint and each expand are **O(visible nodes)**, never O(tenant); the client holds only expanded+visible nodes; this is the acceptance bar at the seeded 1000/10-level tenant.
- **Backward compatibility** — legacy whole-tree endpoints unchanged for small tenants; `flatMode`/orphan/builder semantics preserved; redesigned clients prefer the lazy API.

## 10. Acceptance (per slice, abbreviated)
- **19a:** lib returns correctly paged/keyset children, top-down ancestors (root→node), correct roots for ALL/IDS/NONE, depth cap honoured, orphan roots included; indexes present.
- **19b:** admin first-paint hits only `/roots`; expand hits only that node's `/children`; out-of-scope `:id` → 404; manager clamped to own sub-tree; legacy `org/tree` soft-cap fires > 500.
- **19c:** ESS `/self` returns self + ancestor path; drill-down stays in sub-tree; `/top` lists roots card-only; lateral non-expandable under default policy; zero compensation fields.
- **19d:** component lazy-loads children on expand, paginates wide siblings, expands a search hit's path without fetching the whole tree, virtualizes (DOM node count ≪ tenant size).
- **19e:** both pages open <300 ms and stay responsive at a seeded 1000-employee/10-level tenant; search-to-locate, breadcrumb-to-top, and re-root all work in both perspectives.

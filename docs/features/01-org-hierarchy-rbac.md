All facts confirmed: `USER_SELECT` has no `employeeId` anchor, `requirePermission` is a resource-blind boolean gate, `EmploymentRecord` is effective-dated and append-only. The three research outputs are accurate and consistent with the live code. Here is the synthesized contract.

---

# DriftHR — Feature 1: Org Structure, Employee Hierarchy & Hierarchical RBAC
### Build-Ready Feature Specification (the dev-phase contract)

**Status:** Approved for build · **Owner:** Lead Architect · **Date:** 2026-06-22
**Codebase:** `/Users/kp/hr` (Node/Express/Prisma backend; Next.js apps `hr-admin`, `ess`, `platform`)
**Markets:** India + New Zealand, white-label · **Surfaces:** `app.hr.com` (HR console), `tenant.com` (ESS), platform super-admin

Legend used throughout: `[EXISTS]` already built · `[EXTEND]` file exists, needs work · `[NEW]` must be created.

---

## 1. Summary & Goals

DriftHR already enforces **tenant isolation** (every HR row carries `businessId`; proven by the live IDOR test `backend/src/hr/__tests__/tenant-isolation.idor.test.js`) and a **flat action-permission layer** (15 boolean keys in `backend/src/core/lib/rbac.js`, gated per-route by `requirePermission()` in `backend/src/core/middleware/auth.middleware.js`). What it does **not** have is any notion of *who reports to whom* at the authorization layer.

**The owner's requirement, restated as the design invariant:**
> *A Manager of an HR department manages only their own employees; everything works per the employee hierarchy.*

In RBAC terms: **possessing an action permission is necessary but not sufficient. Every action also resolves a DATA SCOPE derived from the reporting tree, and the two are ANDed on every query.**

**The gap this feature closes (confirmed against live code):**
- `req.user` carries **no employee identity** — `USER_SELECT` (`auth.middleware.js:18-33`) selects `id, email, role, businessId, businessRoleId, businessRole{…}` and **no `employeeId`**. A manager session has no `self` anchor to scope against.
- `requirePermission` (`auth.middleware.js:315-326`) is a **pure boolean gate** — it never inspects the target resource's owner/manager/department.
- Every HR `where`-clause keys on `businessId` only. `employee.controller.js:38` builds `{ businessId, deletedAt: null }`; `leave.controller.listRequests` is `{ businessId, txnType:'APPLICATION' }` + optional **client-supplied** `employeeId`. A `Manager` today sees and (for leave/attendance) acts on the **entire tenant**.
- `managerEmployeeId` appears only in output projections (`employee.controller.js:11,20`), **never as a filter**.
- The scaffolded relational scope table `HrRolePermissionGrant` (`schema.prisma:9003-9017`) has an `entityId` scope but **no hierarchy/sub-tree axis**, and **zero code references it**.

**Goals (acceptance at the feature level):**
1. **G1 — Self anchor:** every operator session resolves its own `Employee` (`employeeId`, `managerEmployeeId`, current `departmentId`) so scope can be computed.
2. **G2 — One scope resolver:** a single `resolveAccessibleEmployeeIds(actor, action)` is the only place that knows the hierarchy; every HR read/write filters by it.
3. **G3 — Manager = sub-tree:** a Manager sees/acts on only their reporting sub-tree (direct + indirect via `Employee.managerEmployeeId`), depth-configurable.
4. **G4 — Fail-closed & IDOR-safe:** out-of-scope single-row access returns **404** (don't reveal existence); lists **filter** (never 403); client-supplied ids are never trusted.
5. **G5 — Org structure complete:** all six org masters editable; a reporting-tree builder and org-chart exist; managers are assignable with cycle guards.
6. **G6 — RBAC self-serve:** roles and per-user role assignment are manageable from the UI.
7. **G7 — No regressions:** tenant isolation and the existing action-permission gates remain intact; defaults keep existing tenants behaving as today.

---

## 2. Scope of THIS Feature (in / out — keep it shippable)

### In scope
- **Data-scope axis** added to the existing two-layer model: `none ⊂ self ⊂ team ⊂ department ⊂ all`, stored per `(role, permission)`.
- **Session `self`-employee anchor** on `req.user`.
- **`resolveAccessibleEmployeeIds()` resolver** (Postgres recursive-CTE implementation over `managerEmployeeId`) + **`withEmployeeScope(key)` middleware**.
- **Wiring the chokepoint** into the high-value controllers: `employee`, `leave`, `attendance`, `org` reads, and `reports/aggregations.js`. (Compensation/loans/expenses/documents/assets get scope-wired in the same pass where a one-line `where` change applies; see §5.)
- **Org masters**: extend `org/page.js` to all six resources (Entities, Locations, Departments, Designations, Grades, Bands); add `GET /api/hr/org/tree`; add an **org-chart** page.
- **Manager assignment** on employee create/edit with cycle guard; **bulk reassign-reports**; **terminate-with-reports prompt**.
- **RBAC UI**: roles & permissions matrix + per-user role assignment; `PATCH /api/business/users/:id/role`; "last Owner" guard.
- **ESS**: `GET /api/hr/me/manager` "My manager" card; confirm self-only scoping on every ESS read.
- **Single approval-routing resolver** (`approvalRouting.js`) consumed by leave (and reused by expense/regularization): route to applicant's `managerEmployeeId`, escalate up non-null ancestors, HR-Admin tenant-wide as terminal fallback.
- **Tests**: extend the IDOR suite with intra-tenant scope cases.

### Out of scope (deliberately deferred — interface stays stable so we can add later)
- **Dotted-line / matrix `ReportingLine` model** and **`ScopeDelegation`** (acting-manager): designed in §4 as additive models, but **not built in v1**. The resolver is written so unioning these in later is a pure internal change, callers untouched.
- **Materialized `reportingPath` (ltree/closure table)** optimization — v1 ships the CTE; swap later behind the same function.
- **Field-level masking framework** beyond what action-permissions already give us. v1 relies on the fact that **Manager has no `canViewCompensation`** (salary simply never serializes for Manager-scoped payloads); a general per-field serializer-redaction layer is a follow-up.
- **ESS-side approvals UI** (managers approve in `hr-admin`, not ESS).
- **`as-of`/temporal scope resolution** for historical audits — the resolver accepts an optional `asOf` param in its signature but v1 only implements "current segment".

---

## 3. Role + Permission + Data-Scope Model (final matrix)

### 3.1 The two orthogonal axes
> **A permission is a pair `(action, scope)`. Authorization = `hasAction(role, A) AND target ∈ resolveScope(user, A) AND target.businessId === user.businessId`.**

**Axis A — ACTION (the verb).** The existing 15 keys in `rbac.js` `PERMISSIONS` (unchanged):
`canViewEmployees, canManageEmployees, canViewCompensation, canManageCompensation, canApproveLeave, canManageAttendance, canRunPayroll, canApprovePayroll, canViewPayrollReports, canManageStatutory, canFileReturns, canManageOrg, canEditBilling, canEditDomain, canEditBranding`.

**Axis B — DATA SCOPE (over whom).** An ordered band (wider ⊇ narrower):

| Scope | Resolves to the set of employee IDs… |
|---|---|
| `none` | ∅ — action exists, no rows. |
| `self` | `{ myEmployeeId }`. |
| `team` | My reporting sub-tree (direct + indirect via `managerEmployeeId`), bounded by `managerScopeDepth` (default ∞). |
| `department` | Employees whose **current** `EmploymentRecord.departmentId` ∈ the department sub-tree (`Department.parentId` closure) under any dept where `headEmployeeId = me`. Unioned with the person sub-tree. |
| `all` | Every non-deleted employee in `businessId` (still tenant-bounded; `all` ≠ cross-tenant). |

**Why both are mandatory:** "Manager can approve leave" with no scope = a manager approving the CEO's leave. "Touch your sub-tree" with no verb says nothing about view-vs-terminate-vs-see-salary. Orthogonal → the matrix is the cross-product; a custom role is a chosen row × a chosen band.

### 3.2 The five system roles (seeded `BusinessRole`, `isSystem=true`, upserted by `ensureDefaultHrRole()`)

| Role | Backing | Default home scope | One-line purpose |
|---|---|---|---|
| **Owner** | `BusinessRole "Owner"` (all 15 true) | `all` | Tenant superuser; only role that transfers ownership, edits billing/domain, approves payroll. |
| **HR-Admin** | `BusinessRole "HR-Admin"` (all except `canEditBilling`, `canEditDomain`, `canApprovePayroll`) | `all` | Runs HR org-wide; can *run* but not *approve disbursement of* payroll. |
| **Manager** | `BusinessRole "Manager"` (`canViewEmployees`, `canApproveLeave`, `canManageAttendance`) | **`team`** | Line manager — defined purely by the hierarchy. **The owner's requirement.** |
| **Finance** | `BusinessRole "Finance"` (run+approve payroll, view comp, statutory, file returns, billing) | `all` (financial) | Money not people; cannot edit employee master or approve leave. |
| **Employee (ESS)** | `User.role=USER` linked via `Employee.userId`; **customer session** for the portal | hard-`self` | Self-service; scope is server-derived from session, never from request body. |

Plus **Super-Admin** (`User.role=SUPER_ADMIN`) — platform, bypasses every gate, provisions tenants. **Custom roles** (`isSystem=false`): any subset of action permissions × a chosen default scope band; `validatePermissions()` rejects unknown keys; never exceed Owner.

### 3.3 Final permission × scope matrix (the contract)

`—` = no access · `self` · `team` (reporting sub-tree) · `dept` · `all`. `view`/`manage` = read/write capability.

| Capability (key) | Super-Admin | Owner | HR-Admin | Manager | Finance | Employee |
|---|---|---|---|---|---|---|
| View directory (`canViewEmployees`) | all | manage@all | manage@all | **view@team** | — | view@self |
| Manage employees (`canManageEmployees`) | ✓ all | ✓ all | ✓ all | — | — | — |
| View comp (`canViewCompensation`) | ✓ | view@all | view@all | **—** ¹ | view@all ² | view@self |
| Manage comp (`canManageCompensation`) | ✓ | ✓ all | ✓ all | — | — | — |
| Approve leave (`canApproveLeave`) | ✓ | manage@all | manage@all | **approve@team** ³ | — | request@self |
| Manage attendance (`canManageAttendance`) | ✓ | manage@all | manage@all | **manage@team** ³ | — | view+submit@self |
| Run payroll (`canRunPayroll`) | ✓ | ✓ all | ✓ all | — | ✓ all | — |
| Approve payroll (`canApprovePayroll`) | ✓ | ✓ all | **✗** ⁴ | — | ✓ all | — |
| View payroll reports (`canViewPayrollReports`) | ✓ | all | all (HR/cost) | **team-only** ⁵ | financial@all | own@self |
| Manage statutory (`canManageStatutory`) | ✓ | ✓ | ✓ | — | ✓ | — |
| File returns (`canFileReturns`) | ✓ | ✓ | ✓ | — | ✓ | — |
| Manage org (`canManageOrg`) | ✓ | ✓ all | ✓ all | — | — | — |
| Edit billing (`canEditBilling`) | ✓ | ✓ | ✗ | — | ✓ | — |
| Edit domain (`canEditDomain`) | ✓ | ✓ | ✗ | — | — | — |
| Edit branding (`canEditBranding`) | ✓ | ✓ | ✓ | — | — | — |

**Footnotes (where security lives):**
1. **Manager has NO compensation access by default** — `canViewCompensation` is absent from the `Manager` preset (`rbac.js:62-66`). The #1 HRMS leak is a line manager seeing a report's salary; comp-for-managers is an explicit, audited opt-in grant (`canViewCompensation@team`), never a default.
2. Finance sees comp `all` because they run payroll.
3. **The owner's headline requirement.** Manager approve-leave / manage-attendance is `team`, resolved from `managerEmployeeId`. A manager literally cannot load a peer's request — it's filtered out of the queue.
4. **Separation of duties on money:** HR-Admin can prepare/run a pay run but cannot approve it for disbursement.
5. Reports honour scope by construction — every aggregation in `reports/aggregations.js` is parameterised by the resolver's ID set.

**Global AC:** for every "—" cell the nav item is hidden AND the API returns `403 {missingPermission}`; for every "team" the API returns only sub-tree rows and `404` (not 403) for out-of-scope ids.

---

## 4. Data Model Changes (Prisma) — minimal, additive

All changes are **additive**; defaults keep existing tenants at `ALL` so nothing breaks. Citations are to `/Users/kp/hr/backend/prisma/schema.prisma`.

### 4.1 Extend `HrRolePermissionGrant` (the dead-but-scaffolded table at `:9003-9017`)
Today it has `roleId, permissionKey, entityId?, expiresAt?` and **no hierarchy axis** and **zero code references**. Add the scope band:

```prisma
// extend model HrRolePermissionGrant
  scope        ScopeBand @default(ALL)   // NONE|SELF|TEAM|DEPARTMENT|ALL
  scopeDepth   Int?                       // null = ∞; overrides tenant managerScopeDepth for this grant

enum ScopeBand { NONE SELF TEAM DEPARTMENT ALL }
```
**Backward compatible:** existing rows (there are none in use) and un-migrated tenants resolve via the JSON `permissions` path in `effectivePermissions()` and default to `ALL`.

### 4.2 No new column needed for the session anchor — resolve via existing link
`Employee.userId` (`@unique`, `onDelete: SetNull`, `:6493`) already links operator `User`→`Employee`. We **resolve and attach** the self-employee in middleware (§5.2); no schema change. (Decision: avoid denormalizing `employeeId` onto `User` to prevent a second source of truth.)

### 4.3 Tenant setting `managerScopeDepth`
Add to the tenant settings store (the existing `Business`-level settings JSON / settings model used elsewhere) `managerScopeDepth: Int? (null = ∞, 1 = direct-reports-only)`. Read by the resolver; per-grant `scopeDepth` overrides it.

### 4.4 Already present — confirmed, no change needed (cite as the foundation)
- `Employee.managerEmployeeId` self-relation `EmpManager`, indexed `@@index([businessId, managerEmployeeId])` (`:6529-6531, :6569`). `onDelete: SetNull` (`:6530`) → terminated manager's reports fall out of all team scopes (fail-closed).
- `Department.parentId` self-tree `DeptTree` + `headEmployeeId` (`:6401-6404`), indexed `@@index([businessId, parentId])` (`:6415`).
- `EmploymentRecord` effective-dated, append-only, with current `departmentId/locationId/designationId/managerEmployeeId` (`:6602-6625`) — scope reads the **current** segment.
- `ApprovalAction.delegatedFromUserId` exists for future delegation stamping (no resolver in v1).

### 4.5 Deferred models (designed, NOT built in v1 — listed so the migration story is known)
`ReportingLine{kind SOLID|DOTTED, scopeActions[]}` (dotted-line / matrix) and `ScopeDelegation{fromEmployeeId, toEmployeeId, actions[], startAt, endAt, status}` (acting-manager). The resolver's union step (§5.1 step 5) is stubbed so these slot in without touching callers.

---

## 5. Backend Work

### 5.1 The single chokepoint — `resolveAccessibleEmployeeIds()` `[NEW]`
File: `/Users/kp/hr/backend/src/hr/lib/scopeResolver.js`. The **only** place that knows the hierarchy; every HR read/write filters by it.

```ts
// Returns the employeeIds the actor may touch FOR A GIVEN ACTION.
async function resolveAccessibleEmployeeIds(actor, action, { asOf } = {}) : Promise<ScopeResult>
type ScopeResult =
  | { kind: 'ALL' }                    // skip the IN-list, just filter businessId (fast path)
  | { kind: 'IDS', ids: Set<string> }  // explicit set (self/team/dept unions)
  | { kind: 'NONE' };                  // ∅ → list returns [], single-row → 404
```

**Algorithm:**
1. **Tenant wall first** — everything is `WHERE businessId = actor.businessId` (already proven).
2. Resolve the band for `(actor.businessRoleId, action)` from `HrRolePermissionGrant.scope` (fallback: system-role default / `ALL`). `all` → `{kind:'ALL'}` (no closure).
3. `self` → `{ids:[actor.employeeId]}`. If actor has **no** linked `Employee` and band requires one → `{kind:'NONE'}` (fail-closed).
4. `team`/`department` → **recursive CTE** (`prisma.$queryRaw … WITH RECURSIVE`) over `managerEmployeeId` rooted at `actor.employeeId` (and, for dept-heads, the `Department.parentId` closure under their `headEmployeeId` depts), bounded by `scopeDepth ?? managerScopeDepth ?? ∞`.
5. **Union step (v1 no-op stub):** dotted-line / delegation sub-trees — left empty until those models ship.
6. **Subtract separation-of-duties exclusions** — drop `actor.employeeId` for approval actions (`canApproveLeave`) so a manager cannot approve their own request.
7. **Memoize per request** on `(actorId, action, asOf)` (mirrors the lazy `req._ecomPerms` pattern in `auth.middleware.js`).

Each controller becomes a one-line `where` AND-in:
```ts
const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewEmployees');
if (scope.kind === 'NONE') return res.json({ items: [], total: 0 });
const where = { businessId, deletedAt: null,
  ...(scope.kind === 'IDS' ? { id: { in: [...scope.ids] } } : {}) };
```

**Performance:** v1 = recursive CTE (sub-trees are tens–hundreds of rows; memoized per request; optional Redis per-actor cache TTL ~60s invalidated on any `EmploymentRecord` write for the tenant). Materialized `reportingPath` is a later internal swap behind this same function.

### 5.2 Middleware `[NEW]`
- **`attachSelfEmployee`** — after `protect`/auth, resolve `Employee` by `Employee.userId === req.user.id` within `businessId`; attach `req.user.employeeId`, `req.user.managerEmployeeId`, `req.user.departmentId`. (Closes the **G1** gap: `USER_SELECT` carries no employee identity today.) Cache on session.
- **`withEmployeeScope(key)`** — calls the resolver, attaches `req.scope = ScopeResult`. For single-row routes, asserts `:id ∈ scope` else **404**.

Layering on the existing stack:
```
protect → attachSelfEmployee → requirePermission(key)  [Axis A, 403 if missing]
                              → withEmployeeScope(key)  [Axis B, attaches req.scope; 404 on single-row miss]
```

### 5.3 API contract — 403 vs 404 vs filter
- **Lists / reports → FILTER, never 403.** Return only in-scope rows. (A 403 here would leak existence and break dashboards.)
- **Single-resource `GET/PUT/DELETE /:id`** → lacks the **action** → `403 {missingPermission}`; has action but `:id` out of scope (row exists in another scope of same tenant) → **`404`** (matches the proven IDOR posture).
- **Writes to a scoped child** (e.g. approve leave for `:employeeId`) → re-resolve server-side; **never trust client-supplied `employeeId`/`managerId`** (the IDOR class flagged in the audit, where `leave.controller.listRequests` accepts a caller-supplied `employeeId`).

### 5.4 Endpoints to ADD / MODIFY (the exact list)

**Modify (AND-in scope to the existing `where`):**
| Endpoint | File | Change |
|---|---|---|
| `GET /api/hr/employees` (list) | `hr/controllers/employee.controller.js:38` | AND `req.scope` ids into `{businessId, deletedAt:null}` |
| `GET /api/hr/employees/:id` | `employee.controller.js:65-66` | `withEmployeeScope` → 404 if out of scope |
| `PATCH/POST /api/hr/employees/:id` (update/terminate) | `employee.controller.js:96-113` | scope-guard the target; **cycle guard** on `managerEmployeeId` |
| `GET /api/hr/leave/requests`, `/:id` | `hr/controllers/leave.controller.js:217-220` | replace client-`employeeId` trust with scope filter |
| `POST /api/hr/leave/requests/:id/approve` `/reject` | `leave.controller.js` (`loadPendingApplication :244-246`) | guard: applicant's `managerEmployeeId` ∈ caller chain OR HR-wide; approver ≠ requester |
| `GET /api/hr/attendance…`, regularization decisions | `hr/controllers/attendance.controller.js:96,132` | scope filter + sub-tree guard on decisions |
| `GET /api/hr/org/*` reads | `hr/controllers/org.controller.js` | currently **no permission** on reads (`org.routes.js:12-13`) → add `protect`+scope-aware read; add `canViewEmployees` floor |
| reports aggregations | `hr/reports/aggregations.js:206` | parameterise every aggregate by the resolver ID set |

**Add `[NEW]`:**
| Endpoint | Purpose |
|---|---|
| `GET /api/hr/org/tree` (optional `?root=me`) | server-nested manager→reports structure for the org-chart (avoids N client round-trips) |
| `POST /api/hr/employees/:id/invite` | create/link `User(role=USER)`, set `Employee.userId`, email activation; idempotent (re-invite re-sends) |
| `GET /api/hr/me` / `GET /api/hr/me/manager` | ESS self record + directory-safe manager card (name/designation/photo only — no comp/PII) |
| `PATCH /api/business/users/:id/role` | assign `businessRoleId`; "last Owner" guard (409) |
| `PATCH /api/hr/org/reassign-reports {fromManagerId, toManagerId}` | transactional bulk re-parent on manager termination |
| `backend/src/hr/lib/approvalRouting.js` | single resolver: approver = applicant's `managerEmployeeId`, escalate up non-null ancestors, HR-Admin tenant-wide terminal fallback. Consumed by leave (reused by expense/regularization). |

**Seeding:** extend `ensureDefaultHrRole()` (`auth.middleware.js:144-165`) to seed scoped grants for system roles (Manager→`TEAM`, Employee→`SELF`, others→`ALL`). Idempotent (`businessId_name` unique).

---

## 6. Frontend Work

### 6.1 hr-admin (`/Users/kp/hr/apps/hr-admin/app/*`)
| Screen | State | Work |
|---|---|---|
| `org/page.js` | `[EXTEND]` | Today exposes only Entities + Departments. Extend to all six as tabs/accordions reusing `OrgSection` (`get`/`post` to `/api/hr/org/{resource}`, `asList`, `Empty`, `ErrorBanner`). Field sets per `org.controller.js` allow-lists (Entities: code/legalName/countryCode/payCurrency/timezone + IN PAN/TAN/GSTIN, NZ NZBN/IRD; Locations: entityId/code/name/geofence/ptRegistrationId/accClassUnit; Departments: code/name/parentId/headEmployeeId/costCenter; Designations: code/title/gradeId; Grades; Bands). |
| `org/chart/page.js` | `[NEW]` | Org-chart from `GET /api/hr/org/tree`. Node card = photo/name/designation/dept/#reports; collapse/expand; search-to-focus; HR/Owner = drag-to-reparent (PATCH); Manager = read-only rooted at self. |
| `people/new/page.js`, `people/[id]/page.js` | `[EXTEND]` | Add **Manager picker** (`managerEmployeeId`, same-tenant search); "Invite to portal" action. |
| `settings/roles/page.js` | `[NEW]` | (a) Roles & permissions matrix (15-key grid) from `GET /api/business/roles` + `GET /api/business/permissions`; system roles read-only/duplicatable. (b) People→role assignment table writing `businessRoleId`. |
| `page.js` (dashboard) | `[EXTEND]` | "My team" widget when `req.scope` is team-bounded: headcount, on-leave-today, pending-approvals badge. |
| `people/page.js`, `leave/page.js`, `attendance/page.js` | `[EXTEND]` | Lists pre-filtered to scope (server-enforced); approval inboxes show only sub-tree. |

**Empty/denied states (hr-admin):**
- Manager with no reports → "You don't manage anyone yet. Ask HR to set your team's reporting lines." (not an error).
- Finance/Manager hitting org create → read-only banner "You can view the org structure but not edit it."; create forms hidden.
- Manager direct-navigating a non-report `:id` → page renders 404 "Not found" (not 403 — IDOR-safe).
- Deleting a role still assigned → 409 "Reassign N users before deleting this role."
- Cycle on manager assign → 400 "That assignment would create a reporting loop."

### 6.2 ESS (`/Users/kp/hr/apps/ess/app/*`)
| Screen | State | Work |
|---|---|---|
| `profile/page.js` | `[EXTEND]` | "My manager" card from `GET /api/hr/me/manager` (directory-safe fields only); "My team" mini-roster only if this employee has reports. |
| `leave/page.js` | `[EXISTS]` | Confirm self-scoped; routing to `managerEmployeeId` (Journey 5.2). |
| `payslips`, `tax`, `attendance`, `documents` | `[EXISTS]` | Confirm every list self-only; forged `:id` → 404. |

**Empty/denied (ESS):** no manager assigned → "No manager assigned yet — contact HR." Any cross-employee read → 403/404 (session bound to `Employee.userId`).

### 6.3 `/auth/me` scope summary + UI hide/disable
`/auth/me` returns `{ action: { granted, band } }`. UI **hides** never-permitted actions (no `canRunPayroll` → no Payroll nav); **disables with tooltip** out-of-scope actions ("You can only approve leave for your team"). **The UI is never the enforcement boundary** — the server re-checks every call.

---

## 7. End-to-End Experience per Role (concise journeys + AC)

### 7.1 Super-Admin (platform) — `User.role=SUPER_ADMIN`
- **Provision tenant:** `POST /api/business` → first login seeds 4 system `BusinessRole`s; first `User`=`BUSINESS_ADMIN`+Owner role.
  - **AC-SA1** New tenant has exactly the system `BusinessRole` rows, permissions byte-equal to `SYSTEM_ROLES`. **AC-SA2** Seeding idempotent (`businessId_name` unique). **AC-SA3** Impersonation start/stop writes an `AuditLog` row; cross-tenant data never leaks.

### 7.2 Owner / HR-Admin (tenant)
- **Build org skeleton** (entities→locations→departments→designations/grades/bands), **build reporting tree** (assign managers, org-chart drag-reparent), **invite to ESS**, **assign roles**.
  - **AC-HR1** Department `parentId` cannot self-reference or cycle → 400. **AC-HR2** Re-parent persists `managerEmployeeId`, chart reflows; server rejects any assignment making an employee their own transitive manager. **AC-HR3** Setting `manager=null` (CEO) allowed. **AC-HR4** Terminating a manager with reports is **blocked-with-prompt** ("re-assign N people first"), never silently orphaned. **AC-HR5** HR-Admin leave/attendance lists are **not** team-filtered (HR-wide). **AC-HR6** HR-Admin's "Approve for disbursement" is disabled (`canApprovePayroll` ✗). **AC-HR7** Cannot strip the last Owner of admin → 409. **AC-HR8** Editing a custom role takes effect on the user's **next** request (live via `effectivePermissions`, no re-login).

### 7.3 Manager — `BusinessRole "Manager"` (the security-critical surface)
- **My team landing / directory** filtered to sub-tree; **approve direct-report leave** (routes up the chain); **team attendance/regularization**; **cannot** see comp/payroll.
  - **AC-MGR1** `GET /api/hr/employees` returns **only** sub-tree; total == sub-tree size. **AC-MGR2** Guessing a peer/non-report `:id` → **404**. **AC-MGR3** Compensation fields **absent** from any Manager payload. **AC-MGR4** Approving a request from outside the sub-tree → **403** "You can only act on your team's requests" even though they hold `canApproveLeave`. **AC-MGR5** Manager **cannot** approve their **own** leave (resolver subtracts self; escalates to next manager up). **AC-MGR6** Manager nav excludes Compensation, Payroll, Reports(payroll), Settings→Roles.

### 7.4 Finance — `BusinessRole "Finance"`
- **Comp & pay runs** (run+approve), **payroll reports**, **billing**; **cannot** manage people/org or approve leave.
  - **AC-FIN1** Only `canApprovePayroll` holders move a locked run to APPROVED; HR-Admin → 403. **AC-FIN2** Finance sees comp tenant-wide. **AC-FIN3** Finance cannot create/terminate employees or edit org (403). **AC-FIN4** HR-Admin/Manager hitting billing → 403; nav hides it.

### 7.5 Employee (ESS) — `User.role=USER` via `Employee.userId`
- **Self profile + manager card**, **apply leave (routes to my manager)**, **self-service reads**.
  - **AC-ESS1** ESS session resolves exactly one `Employee` via `userId`; all reads filtered to it. **AC-ESS2** Manager card exposes only directory-safe fields (no salary/DOB/bank). **AC-ESS3** Leave appears in **exactly** the manager-chain inbox; if no manager, escalates to HR-Admin tenant-wide. **AC-ESS4** Forged `:id` for another's payslip → 404. **AC-ESS5** Employee can cancel only while PENDING (releases the soft-hold).

---

## 8. QA Plan (concrete test cases — extend `tenant-isolation.idor.test.js` with intra-tenant scope)

**Scope resolver / Manager sub-tree (the keystone)**
1. Manager A (reports: B, C; B reports: D) → `GET /api/hr/employees` returns exactly {B,C,D}; total==3; A's peer E absent.
2. Manager A `GET /api/hr/employees/:E` (peer, same tenant) → **404** (not 403).
3. Manager A `GET /api/hr/employees/:F` where F is in another tenant → **404** (tenant wall, existing IDOR).
4. `managerScopeDepth=1` → A sees only {B,C} (D excluded); depth=∞ → {B,C,D}.
5. Re-parent D from B to peer-of-A → D leaves A's scope on the **next** request (current-segment, no nightly job).
6. Terminate Manager B (reports D) → D's `managerEmployeeId` becomes null (`SetNull`); D falls out of A's team scope; "re-org needed" surfaces D.

**Leave approval routing & separation of duties**
7. Employee B (manager A) applies → request appears **only** in A's inbox (and ancestors), nowhere else.
8. Manager A approves B's request → 200, atomic ($transaction): balance `pendingApproval→taken`, status APPROVED together.
9. Manager A approves **E's** request (E outside A's sub-tree) → **403** "You can only act on your team's requests" — even though A holds `canApproveLeave`.
10. Manager A approves A's **own** leave → blocked (approver≠requester); escalates to A's manager.
11. Client-supplied `employeeId` in `GET /leave/requests?employeeId=E` (E out of scope) → ignored/empty, not honored (closes the audited IDOR).
12. Applicant with **no** manager → request escalates to HR-Admin tenant-wide inbox.
13. Decide an already-APPROVED request (race) → 409.

**Compensation / field exposure**
14. Manager A `GET` employee B's profile → **no** salary/CTC fields serialized (Manager lacks `canViewCompensation`).
15. Manager A hits any `/api/hr/compensation/*` → **403 {missingPermission:"canViewCompensation"}**; comp nav hidden.
16. Finance `GET /api/hr/compensation/*` → 200, tenant-wide.

**ESS self-scoping**
17. Employee `GET /api/hr/me/payslips/:id` for **another** employee's payslip id → **404**.
18. Employee `GET /api/hr/me/manager` → returns directory-safe card only (no salary/DOB/bank).
19. Employee tampers `employeeId` in a leave request body → ignored; self-scoped from session.

**Org structure & cycle guards**
20. Department `parentId` = itself → 400 "Department cannot be its own ancestor."
21. Assign `managerEmployeeId` creating a loop (X→descendant of X) → 400 "reporting loop."
22. Designation created against a `gradeId` from another tenant → 400/404 (no leak).
23. Location without same-tenant `entityId` → 400.
24. `GET /api/hr/org/*` reads as an unauthenticated/no-permission session → denied (closes the "org reads had no permission" gap from the audit).

**RBAC management**
25. Non-Owner edits a role to add a permission they don't hold → rejected (no privilege amplification).
26. `validatePermissions` rejects unknown key / non-boolean → 400.
27. Delete a role still assigned to N users → 409.
28. Strip the last Owner of admin → 409.
29. Custom role permission change → enforced on the user's **next** request (no re-login).
30. System (`isSystem`) role edit attempt by non-Owner → rejected/immutable.

**Permission-matrix sweep (one assertion per "—" and "team" cell in §3.3)**
31. For every "—" cell: nav item hidden AND API returns 403 `{missingPermission}`.
32. For every "team" cell: API returns only sub-tree rows; out-of-scope `:id` → 404.

**Regression / no-break**
33. Existing IDOR suite (cross-tenant) still green.
34. Un-migrated tenant (no `HrRolePermissionGrant` rows) → defaults to `ALL`; behaves exactly as today.
35. Super-Admin bypasses every gate; sees any tenant; no cross-tenant leak.

---

## 9. Build Sequence (one focused pass: data model → resolver → endpoints → UI → QA)

**Phase A — Data model (additive migration)**
1. Add `ScopeBand` enum + `scope`/`scopeDepth` to `HrRolePermissionGrant`; add tenant setting `managerScopeDepth`. Migrate (defaults `ALL` → no behavior change).
2. Seed scoped grants in `ensureDefaultHrRole()` (Manager→`TEAM`, Employee→`SELF`, others→`ALL`).

**Phase B — Scope resolver + middleware (the keystone)**
3. `backend/src/hr/lib/scopeResolver.js` — `resolveAccessibleEmployeeIds()` (recursive CTE; per-request memoization; SoD self-exclusion; union-stub for future dotted-line/delegation).
4. `attachSelfEmployee` middleware (resolve `Employee.userId`→session anchor) + `withEmployeeScope(key)` middleware (attach `req.scope`, 404 on single-row miss).
5. `backend/src/hr/lib/approvalRouting.js` — single approver resolver (manager → ancestors → HR-Admin fallback).
6. Cycle/closure guard for `managerEmployeeId` (mirror `categoryDepth.js`).

**Phase C — Wire endpoints**
7. AND `req.scope` into `employee` (list/get/update/terminate), `leave` (list/get/approve/reject — replace client-`employeeId` trust + SoD), `attendance`, `org` reads, `reports/aggregations.js`. (Mostly one-line `where` changes.)
8. Add `GET /api/hr/org/tree`, `POST /api/hr/employees/:id/invite`, `GET /api/hr/me` + `/me/manager`, `PATCH /api/business/users/:id/role` (+ last-Owner guard), `PATCH /api/hr/org/reassign-reports`.
9. Extend `/auth/me` with the `{action:{granted,band}}` scope summary.

**Phase D — UI**
10. hr-admin: extend `org/page.js` to six resources; add `org/chart/page.js`; add Manager picker to `people/new` + `people/[id]`; add `settings/roles/page.js`; "My team" dashboard widget; scope-aware nav hide/disable.
11. ESS: `profile` "My manager" card; confirm self-only lists.

**Phase E — QA & fix**
12. Extend `tenant-isolation.idor.test.js` with the §8 intra-tenant scope cases (sub-tree, peer-404, self-approval-blocked, comp-masked-in-scope, ESS-self-only, cycle guards, RBAC guards, matrix sweep).
13. Run the full HR suite (incl. existing filing/golden tests) — fix to green.

**Net:** the action axis and tenant wall already exist and are proven. This feature adds the **missing scope axis** and the **single resolver** that makes "a manager manages only their own employees, per the hierarchy" true **by construction** — not by remembering to add a `WHERE` in each controller.

---

**Primary files (all absolute):**
- Schema: `/Users/kp/hr/backend/prisma/schema.prisma` (`HrRolePermissionGrant` :9003, `Employee.managerEmployeeId` :6529, `Department` :6401/:6404, `EmploymentRecord` :6602, `BusinessRole` :3612, `ApprovalAction.delegatedFromUserId`)
- RBAC: `/Users/kp/hr/backend/src/core/lib/rbac.js`; gate `/Users/kp/hr/backend/src/core/middleware/auth.middleware.js`
- Controllers to wire: `/Users/kp/hr/backend/src/hr/controllers/{employee,leave,attendance,org}.controller.js`, `/Users/kp/hr/backend/src/hr/reports/aggregations.js`
- RBAC mgmt: `/Users/kp/hr/backend/src/core/controllers/businessRoles.controller.js`, `/Users/kp/hr/backend/src/core/controllers/business.controller.js`
- Test: `/Users/kp/hr/backend/src/hr/__tests__/tenant-isolation.idor.test.js`
- **New backend:** `/Users/kp/hr/backend/src/hr/lib/scopeResolver.js`, `/Users/kp/hr/backend/src/hr/lib/approvalRouting.js`, `attachSelfEmployee` + `withEmployeeScope` middleware
- **Frontend:** `/Users/kp/hr/apps/hr-admin/app/{org,org/chart,people,people/new,people/[id],settings/roles,leave,attendance,page}.js`, `/Users/kp/hr/apps/ess/app/{profile,leave,payslips,tax,attendance,documents}/page.js`
# Feature 10 — Configurable Approval-Workflow Engine + User-Friendly RBAC / Hierarchy

**Status:** Build-ready spec. Single source of truth for the approval-engine + RBAC vertical.
**Owner:** HR platform. **Date:** 2026-06-24. **Branch base:** `development`.
**Countries:** India (IN) + New Zealand (NZ) — country-agnostic engine; no statutory logic here.

This feature is the **FOUNDATION** every other module consumes for "who approves this, in what
order, and what happens if nobody acts." It also makes RBAC/hierarchy **drag-simple** for a
3-person tenant and **fully granular** for a 100+-person one. Every cited path was verified
against the live tree on 2026-06-24.

> Owner's words: *"make RBAC a powerful user-friendly tool because our customer may have 3
> employees or 100 — user must easily make process or hierarchy or no hierarchy for approvals,
> reimbursement etc."*

---

## 1. Summary & Goals

DriftHR **already scaffolds the entire approval data model** — `WorkflowDefinition`,
`WorkflowStep`, `ApprovalRequest`, `ApprovalAction`, and the enums `WorkflowModule`,
`ApproverType`, `TimeoutAction`, `ApprovalStatus`, `ApprovalDecision`
(`backend/prisma/schema.prisma:9813-9939`). It is **inert**: there is no engine that reads a
`WorkflowDefinition`, instantiates an `ApprovalRequest`, walks steps, escalates on timeout, or
honours delegation. Today every consumer flips its own status with a bespoke router:

- **Leave** routes via `approvalRouting.js#resolveApprover` (manager → escalate up the chain →
  any HR-Admin fallback — **single step only**) and flips `LeaveTransaction.status` directly
  (`leave.controller.js#approveRequest`, `:395`), guarded by F1 scope SoD.
- **Expense** has **no router at all** — `expenses.controller.js#approve` just checks
  `canManageEmployees` at the route and flips `ExpenseClaim.status`.

So we have a parking lot but no car. Feature 10 builds **the engine** that turns the scaffold
into a live, reusable, visually-configurable system, then **migrates leave + expense onto it**
(the proof) and exposes the seam for travel/comp/loan/profile-change/regularization/separation.

**Goals**

1. **One workflow engine** (`backend/src/hr/approvals/engine.js`) — pure-where-possible state
   machine: `open()` an `ApprovalRequest` from the resolved `WorkflowDefinition`, resolve each
   step's approvers (manager N-up / role / named / auto), evaluate **conditional routing**
   (amount/category/department/level), run **sequential or parallel** steps with `minApprovals`,
   record each `ApprovalAction`, advance/complete/reject, all idempotent + version-locked.
2. **Approver resolution** (`backend/src/hr/approvals/approverResolver.js`) — generalises
   `approvalRouting.js`: given a step + the requester's Employee, return the concrete approver
   user-set, applying **delegation** (out-of-office) and **SoD** (maker ≠ checker, reuse F1
   `APPROVAL_ACTIONS` self-exclusion).
3. **Timeout / escalation runner** (`backend/src/hr/approvals/escalationRunner.js`) — cron-style
   sweep over `slaDueAt`, applying each step's `onTimeoutAction` (ESCALATE / AUTO_APPROVE /
   AUTO_REJECT / REMIND). Mirrors the leave `accrualRunner.js` cron pattern.
4. **Visual workflow builder** (hr-admin) — a non-technical admin drags steps onto a chain per
   process, with **starter templates** (so a 3-person tenant clicks "No approvals" or "Just my
   manager" once and is done) and an **advanced** mode (conditions, parallel, SLA, escalation).
5. **User-friendly RBAC + hierarchy** — (a) **preset picker** (Owner/HR/Manager/Finance/Employee)
   for small tenants; (b) a **granular role builder** over the existing `rbac.js` permission
   catalog + `HrRolePermissionGrant` relational grants for big ones; (c) an **org-chart editor**
   that visually sets `Employee.managerEmployeeId` (the reporting tree F1 already walks), with a
   **"flat / no hierarchy" mode** that routes everything to a named approver or a role.
6. **Unified ESS + hr-admin inbox** — every pending approval, across all modules, in one
   "Approvals" feed (extend `meTasks.controller.js`), with delegate-while-away self-service.

**Non-goals (deferred):** graphical DAG with arbitrary branch/merge (we ship linear steps +
per-step conditional skip, which covers ~all SME needs); cross-tenant shared templates;
ML-suggested approvers; mobile-native builder (mobile gets the **inbox + act**, not the builder).

---

## 2. Scope — In / Out

### 2.1 REUSE as-is (do NOT rebuild — verified present)

| Asset | Path | What it gives us |
|---|---|---|
| Workflow + approval **schema** (4 models, 5 enums) | `schema.prisma:9813-9939` | `WorkflowDefinition`/`WorkflowStep`/`ApprovalRequest`/`ApprovalAction` + `ApproverType`, `TimeoutAction`, `ApprovalStatus`, `ApprovalDecision`, `WorkflowModule` — the engine reads/writes these |
| F1 scope chokepoint | `backend/src/hr/lib/scopeResolver.js` | `resolveAccessibleEmployeeIds`, `scopeWhere`, `scopeAllows`, **`APPROVAL_ACTIONS` self-exclusion (SoD)** |
| F1 approval router (single-step) | `backend/src/hr/lib/approvalRouting.js` | `resolveApprover` (manager → escalate → HR fallback) — **generalised, not replaced**, by `approverResolver.js` |
| RBAC catalog + presets | `backend/src/core/lib/rbac.js` | `PERMISSIONS`, `SYSTEM_ROLES`, `SYSTEM_ROLE_SCOPES`, `effectivePermissions`, `effectiveScope`, `hasPermission`, `validatePermissions` |
| Relational HR grants | `HrRolePermissionGrant` (`schema.prisma:10038`) | entity-scoped, **time-bound** permission grants (`expiresAt`) — the granular-role builder writes these |
| Role model | `BusinessRole` (`schema.prisma:3643`) | `permissions` JSON + `defaultScope` (`ScopeBand`) + `compVisibility` + `isSystem`; `@@unique([businessId,name])` |
| Reporting tree | `Employee.managerEmployeeId` + recursive CTE in `scopeResolver.js` | the hierarchy the org-chart editor mutates and the engine resolves N-up over |
| Notifications | `Notification` model (`schema.prisma:9947`) + `NotificationType`/`NotificationChannel`/`DeliveryStatus` | engine emits "you have an approval", "approved", "escalated to you" |
| ESS task feed | `backend/src/hr/controllers/meTasks.controller.js` | the pattern + mount (`/api/hr/me/tasks`) we extend with the approvals feed |
| Cron runner pattern | `backend/src/hr/leave/accrualRunner.js` | idempotent, tenant-loop, dry-run — copied for `escalationRunner.js` |
| Auth/scope middleware | `backend/src/hr/middleware/` (`protect`, `attachSelfEmployee`, scope mw) | route guards reused verbatim |

### 2.2 BUILD (the real work)

- **`approvals/engine.js`** — `openRequest`, `recordDecision`, `advance`, `cancel`, `withdraw`,
  `previewChain` (pure). The state machine.
- **`approvals/approverResolver.js`** — step → concrete approver user-set, with delegation + SoD.
- **`approvals/conditions.js`** — pure evaluator for `WorkflowStep.conditionJson`
  (`{amount:{">":50000}}`, category/department/level matchers). `node --test`-able.
- **`approvals/escalationRunner.js`** — SLA sweep + `onTimeoutAction`. Cron driver.
- **`approvals/workflowResolver.js`** — pick the right `WorkflowDefinition` for
  `(businessId, module, entityId?)`; fall back to a **built-in default chain** when none exists.
- **2 new Prisma models** — `ApprovalDelegation` (out-of-office) and `WorkflowDefinition.scopeJson`
  /trigger refinements (additive columns only — see §4). **No model is dropped.**
- **Engine REST surface** — `/api/hr/approvals/*` (admin config CRUD + inbox + act) and the ESS
  delegate self-service. ~14 endpoints.
- **Migrate leave + expense** onto the engine (status flips become engine callbacks). Backward
  compatible: the leave ledger soft-hold and SoD are preserved.
- **hr-admin UIs** — Workflow Builder, Role Manager (preset + granular), Org-Chart editor.
- **ESS UIs** — unified Approvals inbox, "Delegate while I'm away".

### 2.3 OUT (deferred)

- Arbitrary DAG / branch-merge; multi-tenant template marketplace; per-field approval (approve
  line 3 of a claim but not line 4 — we approve the whole entity); approval analytics dashboard
  (counts/SLA-breach trends) beyond a basic list.

---

## 3. The mental model (plain language — for the non-technical admin)

A **Process** is a thing employees ask for: *Leave, Reimbursement, Travel, Salary change, Loan,
Profile edit, Attendance fix, Exit.* (These are the `WorkflowModule` values.)

For each Process you draw a **Chain** of **Steps**. Each Step answers **"who says yes?"**:

- **My manager** (1-up), **my manager's manager** (2-up), or **everyone up to the top**.
- **A specific person** (e.g. "Asha in Finance").
- **A role** (e.g. "anyone who is HR" or "anyone who is Finance").
- **Nobody — auto-approve** (the request is granted the moment it's filed).

You decide **order**: Steps run **one after another** (manager first, then Finance) or **at the
same time** (HR and Finance both, in parallel — "need 2 of 2" or "any 1 of 2").

You add **rules** so the chain bends by the request: *"if the amount is over ₹50,000, add a
Finance step"*, *"travel to another country also needs the Country Head"*, *"Sales department
claims also go to the Sales Director."*

You set **time limits**: *"if the manager doesn't act in 2 days, remind them"*, or *"…escalate to
their manager"*, or *"…auto-approve."* And **cover for absences**: *"while I'm on leave, Ravi
approves on my behalf."* The system **never lets you approve your own request** (maker ≠ checker).

That is the whole feature. The builder is the UI that draws this; the engine is the code that
runs it.

---

## 4. Data model (Prisma sketches — additive, extends `schema.prisma:9813-9939`)

The four core models already exist. We **add two models** and **a few columns**. Money stays
`Decimal`; every model carries `businessId` (tenant wall) + `@@index([businessId, …])`.

### 4.1 Extend `WorkflowDefinition` (additive columns)

```prisma
model WorkflowDefinition {
  // …existing: id, businessId, code, name, module, entityId, isActive, version, steps
  description   String?
  // Selector refinement: which requests this definition applies to. NULL = the
  // module-wide default. Multiple defs per module are disambiguated by specificity
  // (see workflowResolver.js §6.1): entityId/scope match > scopeJson match > default.
  scopeJson     Json?     // {"departmentIds":[...],"employeeLevels":["IC","M1"],"locationIds":[...]}
  priority      Int       @default(100)  // lower = evaluated first when multiple match
  // Behaviour when the resolver finds NO step (empty chain) → AUTO_APPROVE (the
  // explicit "no hierarchy / no approvals" tenant choice).
  isPublished   Boolean   @default(false) // draft vs live; only published defs route real requests
  createdBy     String?
  updatedBy     String?
  @@index([businessId, module, isActive, isPublished])
}
```

### 4.2 `WorkflowStep` — already complete; we only **document the field semantics** the engine reads

```
stepOrder        Int           // 1,2,3… ; same number = same parallel "level"  ← NOTE
approverType     ApproverType  // REPORTING_MANAGER | DEPARTMENT_HEAD | HR | PAYROLL_MANAGER
                               //                  | SPECIFIC_ROLE | SPECIFIC_EMPLOYEE | AUTO_APPROVE
approverRefId    String?       // SPECIFIC_ROLE→BusinessRole.id ; SPECIFIC_EMPLOYEE→Employee.id ;
                               // REPORTING_MANAGER→ "N" (levels up, default "1") packed as text
conditionJson    Json?         // skip this step unless condition matches (conditions.js)
isParallel       Boolean       // when true, this step shares a "level" with adjacent steps of
                               // equal stepOrder → engine activates them together
minApprovals     Int           // for a parallel level, how many YESes complete it (1=any, n=all)
slaHours         Int?          // escalation clock; NULL = no timeout
onTimeoutAction  TimeoutAction // ESCALATE | AUTO_APPROVE | AUTO_REJECT | REMIND
```

> **Parallel encoding decision:** rather than overload `stepOrder`, the engine treats steps that
> share a `stepOrder` value as one **parallel level** (and ignores `isParallel` as redundant, but
> keeps writing it for the builder's convenience). `minApprovals` then governs that level.
> `currentStepOrder` on `ApprovalRequest` points at the active level.

### 4.3 NEW — `ApprovalDelegation` (out-of-office / "approve on my behalf")

```prisma
model ApprovalDelegation {
  id              String   @id @default(uuid())
  businessId      String
  business        Business @relation(fields:[businessId], references:[id], onDelete: Cascade)
  // Who is delegating their approval authority (the absent approver) …
  fromUserId      String
  fromUser        User     @relation("DelegationFrom", fields:[fromUserId], references:[id], onDelete: Cascade)
  // …to whom (the stand-in). Must be a real, active user in the same tenant.
  toUserId        String
  toUser          User     @relation("DelegationTo",   fields:[toUserId],   references:[id], onDelete: Cascade)
  // Optional narrowing: only these modules delegate (NULL = all).
  modules         WorkflowModule[]  @default([])
  startsAt        DateTime
  endsAt          DateTime
  reason          String?
  isActive        Boolean  @default(true)   // can be revoked early
  createdBy       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([businessId, fromUserId, isActive])
  @@index([businessId, toUserId, isActive])
  @@index([businessId, startsAt, endsAt])
}
```

> **Delegation, not abdication:** a delegation **adds** `toUser` to the approver set for the
> window; it does not remove `fromUser`. Either may act. Every `ApprovalAction` taken by the
> stand-in records `delegatedFromUserId` (the column already exists, `:9928`) so the audit shows
> "Ravi approved on behalf of Asha." SoD still applies to the **original requester**: a stand-in
> who is also the requester is excluded (§7.4).

### 4.4 `ApprovalRequest` / `ApprovalAction` — already complete (`:9881-9933`)

We use them as-is. `ApprovalRequest.workflowDefinitionId` (already nullable) is set by the engine;
`payloadJson` carries the snapshot the approver sees (amount, dates, reason) so the inbox needs no
join back to the source entity. `currentStepOrder` is the active level; `slaDueAt` drives the
escalation runner; `actions[]` is the append-only decision log.

### 4.5 New enum value (additive) — none required

`WorkflowModule` already covers LEAVE/EXPENSE/LOAN/COMPENSATION/OFFER/PROFILE_CHANGE/TIMESHEET/
ATTENDANCE_REGULARIZATION/SEPARATION/ASSET/DOCUMENT_SIGN/PAYRUN. **Travel** is filed under
`EXPENSE` with a `category=TRAVEL` condition, OR we add `TRAVEL` to the enum in slice 1 (one-line,
additive). Spec assumes we add `TRAVEL` for clarity.

### 4.6 Migration plan

One additive migration: extend `WorkflowDefinition`, add `ApprovalDelegation`, add `TRAVEL` to
`WorkflowModule`, add the two `User` back-relations + `Business` relations. **No drops, no
renames, no data backfill** (existing tenants simply have zero `WorkflowDefinition` rows → the
resolver's built-in default chain runs, preserving today's leave/expense behaviour exactly).

---

## 5. The engine (server design)

All under `backend/src/hr/approvals/`. The engine is the **single chokepoint** for "instantiate
and advance an approval," mirroring how `scopeResolver.js` is the single chokepoint for data scope.

### 5.1 `workflowResolver.js` — pick the chain

```
resolveDefinition(businessId, module, ctx) -> WorkflowDefinition | BUILT_IN_DEFAULT
  ctx = { entityId?, departmentId?, employeeLevel?, locationId? }
```
1. Published defs for `(businessId, module)` ordered by `priority` asc.
2. First whose `entityId` matches (most specific) or whose `scopeJson` matches `ctx`.
3. Else the module's **default** def (`scopeJson = null`).
4. Else **BUILT_IN_DEFAULT** — a code constant per module that reproduces today's behaviour
   (e.g. LEAVE = `[{REPORTING_MANAGER, escalate@48h}]`; EXPENSE = `[{REPORTING_MANAGER},{HR if
   amount>threshold}]`). This guarantees **zero-config tenants still work**.

### 5.2 `conditions.js` — pure condition evaluator (`node --test`-able)

```
matches(conditionJson, ctx) -> boolean
  ctx = { amount, currencyCode, categoryCode, departmentId, employeeLevel, locationId, days }
```
Supported operators (small, auditable grammar):
`{amount:{">":50000}}`, `{categoryCode:{in:["TRAVEL","CLIENT"]}}`,
`{departmentId:{in:[...]}}`, `{employeeLevel:{in:["M1","M2"]}}`, `{days:{">=":5}}`,
combined with implicit AND across keys, optional `{"any":[…]}` for OR. No code-eval, no regex
injection — fixed key whitelist; unknown key ⇒ condition fails closed (step is skipped *in*, i.e.
treated as not-applicable safely — see §7.6).

### 5.3 `approverResolver.js` — step → concrete approver user-set

Generalises `approvalRouting.js#resolveApprover`. Given `(step, requesterEmployee, businessId)`:

| `approverType` | Resolution |
|---|---|
| `REPORTING_MANAGER` | Walk `managerEmployeeId` **N** levels up (`approverRefId` = "1"/"2"/…; "ALL" = whole chain ⇒ expands to one sequential sub-step per ancestor). Cycle-guarded + depth-capped (reuse `nearestManager` logic). |
| `DEPARTMENT_HEAD` | The head of the requester's department (Employee flagged head / department.headEmployeeId). |
| `HR` | Any active user holding `canApproveLeave`/HR grant in tenant (reuse `hrAdminFallback`). |
| `PAYROLL_MANAGER` | Any user with `canApprovePayroll`. |
| `SPECIFIC_ROLE` | All active users whose `businessRoleId = approverRefId`. |
| `SPECIFIC_EMPLOYEE` | The single Employee/user `approverRefId`. |
| `AUTO_APPROVE` | Empty set ⇒ engine auto-completes the step. |

Then **post-processing on the resolved set**:
- **Delegation expansion** — for each approver user, if an active `ApprovalDelegation` covers
  `(fromUser=approver, module, now ∈ [startsAt,endsAt])`, **add** `toUser` to the set (record the
  link for the eventual action).
- **SoD exclusion** — remove the **requester's own user** from the set (maker ≠ checker). If the
  set becomes empty *because of SoD* (e.g. requester is their own manager — a 3-person tenant
  founder), **escalate one level up**; if still empty, fall to the module's HR/role fallback;
  if still empty, **auto-approve with an audit note** (a sole-owner tenant cannot approve their
  own leave forever). This is the F1 `APPROVAL_ACTIONS` philosophy made concrete for tiny tenants.
- **Dedup + active-only** — drop inactive/terminated/soft-deleted users.

Returns `{ userIds: string[], minApprovals, autoApprove: boolean, escalationReason? }`.

### 5.4 `engine.js` — the state machine

```
openRequest({ businessId, module, entityType, entityId, requesterEmployeeId, payload, ctx }, tx)
   → creates ApprovalRequest(status=PENDING, currentStepOrder=firstLevel),
     resolves + activates the first level, sets slaDueAt, emits Notifications,
     returns { approvalRequest, terminal? }   // terminal=APPROVED immediately if whole chain auto

recordDecision({ approvalRequestId, actorUserId, decision, comment }, tx)
   → validates actor ∈ active approver set for currentStepOrder (else 403),
     SoD re-check (actor ≠ requester),
     appends ApprovalAction (incl. delegatedFromUserId if stand-in),
     evaluates level completion:
        REJECTED            → request REJECTED (terminal), fire onReject callback
        REQUESTED_CHANGES   → request back to requester (status stays PENDING, level reset),
        APPROVED & level minApprovals met → advance() to next applicable level,
        APPROVED & not yet met            → stay, await remaining parallel approvers
   → version-locked updateMany (optimistic concurrency, same pattern as leave decideTerminal)

advance(request, tx)
   → find next level whose steps' conditionJson matches ctx (skip non-matching),
     if none remain → request APPROVED (terminal), fire onApprove callback,
     else activate that level (resolve approvers, set slaDueAt, notify)

cancel / withdraw  → requester-initiated terminal transitions (status CANCELLED/WITHDRAWN),
                     fire onCancel callback (release leave soft-hold etc.)

previewChain({ module, ctx, definition? }) -> [ { stepOrder, label, approverNames[], sla } ]
   → PURE, no writes. Powers the builder's "Preview for a sample request" and the ESS
     "who will approve this?" hint before submit.
```

**Callbacks (the consumer contract).** The engine never knows leave-balance or expense
semantics. Each consumer registers `{ onApprove, onReject, onCancel }(approvalRequest, tx)`:
- **Leave:** `onApprove` = the existing `decideTerminal(...,'APPROVED', balanceMove)` body;
  `onReject`/`onCancel` = release the `pendingApproval` soft-hold. The current
  `approveRequest`/`rejectRequest` logic moves wholesale into these callbacks — **zero behaviour
  change**, the engine just decides *when* they fire.
- **Expense:** `onApprove` = flip `ExpenseClaim.status=APPROVED` + stamp `decidedBy/decidedAt`;
  similar for reject. Replaces the bare `canManageEmployees` flip with a real chain.

**Idempotency + concurrency.** Every transition is a `version`-locked `updateMany(where:{id,
status:from, version})`; a lost race ⇒ `409 CONCURRENT_UPDATE` (identical to
`leave.controller.js#isDecisionRace`). Double-approve of the same level by the same user is a
no-op (unique-ish guard on `(approvalRequestId, stepOrder, approverUserId)` — enforce in code +
add a partial unique later if needed).

### 5.5 `escalationRunner.js` — the SLA sweep (cron)

Copy `accrualRunner.js`: tenant loop, `--dry-run`, idempotent. For each `ApprovalRequest` with
`status=PENDING` and `slaDueAt < now`, load the active level's `onTimeoutAction`:
- `REMIND` → emit a reminder `Notification` to the current approver set; push `slaDueAt` forward
  one SLA window (so it nags, doesn't spam).
- `ESCALATE` → re-resolve the step as `REPORTING_MANAGER` **one level above** the timed-out
  approver, reassign, notify, set `status=ESCALATED` provenance on the action log, reset
  `slaDueAt`. If no higher manager → HR fallback.
- `AUTO_APPROVE` / `AUTO_REJECT` → call `recordDecision` as a **system actor** with a
  `comment="SLA timeout auto-decision"`; fires the same consumer callbacks. The auto-actor is
  exempt from SoD (it is not the requester).

Scheduled every 15 min via the existing cron harness (same place `accrualRunner` is wired);
guarded so two overlapping runs can't double-escalate (version lock).

---

## 6. RBAC + hierarchy (the user-friendly side)

This is **not** a new permission system — it's a **friendlier surface over the existing
`rbac.js`** catalog + `BusinessRole` + `HrRolePermissionGrant` + `Employee.managerEmployeeId`.

### 6.1 Two modes, one model — "Simple" vs "Advanced"

**Simple (default, for 3–20 people).** The admin sees **five preset role cards** straight from
`SYSTEM_ROLES` (`rbac.js`): **Owner, HR-Admin, Manager, Finance, Employee**. Assigning a person a
card sets their `BusinessRole` (with its `permissions` JSON + `defaultScope` + `compVisibility`)
— no checkboxes. A "What can they do?" plain-English summary is rendered from
`PERMISSIONS[key].description`. This is the entire RBAC UI a tiny tenant ever needs.

**Advanced (toggle, for 20–100+).** A **granular role builder**:
- Clone a preset → rename → tick/untick individual `PERMISSION_KEYS` (validated by
  `validatePermissions`).
- Set the role's `defaultScope` band (ALL / DEPARTMENT / TEAM / SELF) — explained in words
  ("This person sees **their own team only**" = TEAM).
- Optionally attach **entity-scoped, time-bound grants** via `HrRolePermissionGrant`
  (e.g. "Acting Finance approver for Location-Mumbai until 31-Aug") — the relational path already
  exists; the builder just writes rows.
- `compVisibility` picker (ABSOLUTE / RANGE_ONLY / SELF_ONLY) reused from Feature 5.

Both modes write the **same** `BusinessRole`/grant rows. No fork.

### 6.2 The org-chart / hierarchy editor — and "no hierarchy" mode

A **visual tree** of the tenant rendered from the recursive CTE (`scopeResolver.js`), nodes =
employees, edges = `managerEmployeeId`. The admin **drags a person under a new manager** → a
single `PATCH /employees/:id { managerEmployeeId }` (reuses the existing employee controller;
cycle-guarded server-side — you cannot make someone their own ancestor). Changes here instantly
change **who the engine routes `REPORTING_MANAGER` steps to** — one tree, every module benefits.

**"No hierarchy" / flat mode** (the owner's explicit ask): a tenant may choose, per process, to
**not use the manager chain at all**. The builder simply offers, as the first step, **"A specific
person" or "A role"** instead of "My manager." A 3-person agency with no real org chart picks
*Reimbursement → approver = "Priya (Owner)"* and never touches `managerEmployeeId`. The engine's
`REPORTING_MANAGER` resolver is only ever invoked if the admin chose a manager step.

### 6.3 Where RBAC meets the engine (the authorization boundary)

- **Who may configure workflows / roles / the tree?** New permission keys (additive to `rbac.js`
  `PERMISSIONS`, no migration — JSON):
  `canManageApprovalWorkflows` ("Build approval chains"), `canManageRoles`
  ("Create/edit roles & permissions"), `canManageHierarchy` ("Edit the reporting tree").
  Seeded **true for Owner + HR-Admin** in `SYSTEM_ROLES`; everyone else false. The Workflow
  Builder / Role Manager / Org editor routes are gated on these.
- **Who may act on a given approval?** **NOT** a static permission — it's the engine's resolved
  approver set for the active step (§5.3), which already bakes in F1 SoD. So a Manager can approve
  leave **only** for their own sub-tree because that's who routes to them; the F1 scope band is the
  backstop (`canApproveLeave` excludes self). The engine is the *router*; F1 scope is the *fence*.

---

## 7. API surface (RBAC-gated)

Mounted under `/api/hr/approvals/*` and `/api/hr/rbac/*`; all behind `protect`; admin routes add
the permission gate; ESS routes use `attachSelfEmployee` + SELF_ONLY.

### 7.1 Workflow config (admin — `canManageApprovalWorkflows`)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/approvals/workflows?module=` | List definitions (incl. which is the live default). |
| `POST` | `/approvals/workflows` | Create a definition (draft). Body: name, module, scopeJson, priority. |
| `GET`  | `/approvals/workflows/:id` | Definition + ordered steps. |
| `PUT`  | `/approvals/workflows/:id` | Update meta/scope; version-locked. |
| `PUT`  | `/approvals/workflows/:id/steps` | **Replace the whole step array** (the builder saves the canvas atomically). Validates: ≥0 steps, no duplicate non-parallel order, conditions well-formed, `minApprovals ≤ level size`. |
| `POST` | `/approvals/workflows/:id/publish` | Draft → published (becomes live for routing). |
| `POST` | `/approvals/workflows/:id/preview` | **Pure** `previewChain` for a sample ctx — "Show me who'd approve a ₹60k travel claim from Sales." |
| `DELETE` | `/approvals/workflows/:id` | Soft-disable (`isActive=false`); never hard-delete with history. |

### 7.2 Inbox + act (any approver)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/approvals/inbox?module=&status=` | **Unified** pending-on-me feed across all modules. Rows where caller ∈ active approver set (incl. delegated-to-me). Returns `payloadJson` so no source join needed. |
| `GET`  | `/approvals/:id` | One request: chain visualization, who's acted, what's pending, the payload. Scope-checked. |
| `POST` | `/approvals/:id/decide` | `{ decision: APPROVED|REJECTED|REQUESTED_CHANGES, comment }`. The single act endpoint; engine `recordDecision`. SoD + active-step + version checks. |
| `POST` | `/approvals/:id/reassign` | (admin) Manually reassign the active step to another approver (e.g. someone left). Audited. |

### 7.3 Delegation (ESS self-service + admin)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/me/delegations` | My active/upcoming delegations (out + in). |
| `POST` | `/me/delegations` | "While I'm away, **X** approves for me" — `{ toUserId, startsAt, endsAt, modules?, reason }`. Validates X ≠ me, X active, window sane. |
| `DELETE` | `/me/delegations/:id` | Revoke early. |
| `GET`  | `/approvals/delegations` | (admin) Tenant-wide view of all delegations. |

### 7.4 RBAC + hierarchy

| Method | Path | Gate | Purpose |
|---|---|---|---|
| `GET`  | `/rbac/permissions` | `canManageRoles` | The catalog (`PERMISSIONS`) + descriptions, for the builder. |
| `GET`/`POST`/`PUT`/`DELETE` | `/rbac/roles[/:id]` | `canManageRoles` | Role CRUD over `BusinessRole` + grants. `validatePermissions` enforced; `isSystem` roles are clone-only, not editable in place. |
| `POST` | `/rbac/roles/:id/grants` | `canManageRoles` | Add entity-scoped/time-bound `HrRolePermissionGrant`. |
| `GET`  | `/rbac/org-tree` | `canViewEmployees` | The reporting tree (CTE) for the chart. |
| `PATCH` | `/employees/:id` `{managerEmployeeId}` | `canManageHierarchy` | Re-parent in the tree (existing controller; cycle-guarded). |
| `POST` | `/employees/:id/assign-role` | `canManageRoles` | Set a person's `businessRoleId`. |

### 7.5 Consumer integration (the seam other features call — internal, not HTTP)

Each module calls the engine in-process inside its own transaction:
```js
const { openRequest } = require('../approvals/engine');
// in leave.createRequest, after the soft-hold:
await openRequest({ businessId, module:'LEAVE', entityType:'LeaveTransaction',
  entityId: txn.id, requesterEmployeeId: txn.employeeId,
  payload:{ leaveType, startDate, endDate, days, reason },
  ctx:{ days, departmentId, employeeLevel } }, tx);
```
The module's `onApprove/onReject/onCancel` callbacks (registered once at boot in a small
`approvals/consumers.js` registry keyed by `module`) carry the domain effect. **Leave + expense
ship wired in this feature; travel/loan/comp/profile-change/regularization/separation get the
one-line `openRequest` call when their feature lands.**

---

## 8. hr-admin + ESS UX flows (plain language)

### 8.1 hr-admin — Workflow Builder (`apps/hr-admin`)

**Landing:** a grid of **Process cards** — Leave, Reimbursement, Travel, Salary change, Loan,
Profile edit, Attendance fix, Exit — each showing its current chain in one line ("Manager →
Finance if > ₹50k") and a status pill (Default / Custom / Off).

**Pick a Process → the Chain canvas:**
1. A friendly **"Start from a template"** prompt the first time: **[No approvals]** ·
   **[Just my manager]** · **[Manager → HR]** · **[Manager → Finance over an amount]**. One click
   builds the steps; the admin can stop right there.
2. The canvas shows steps as **stacked cards** top-to-bottom (= order). Each card:
   *"Who approves?"* dropdown (My manager / 2-up / Whole chain / A person / A role / Auto-approve),
   an optional **"Only if…"** rule chip (amount/category/department/level), and an optional
   **time-limit** chip ("2 days, then escalate"). **"+ Add step below"** and drag-to-reorder.
3. **Parallel:** an admin drops two cards into the **same row** ("at the same time") and picks
   *"need any 1"* / *"need all."*
4. **Preview** button: "Show me for a sample request" → fills amount/dept/level → renders the
   exact resolved approver names (calls `/preview`). This is the trust-builder for non-technical
   users — they *see* the outcome before publishing.
5. **Save draft** (safe) → **Publish** (goes live). Published changes only affect **new** requests;
   in-flight approvals keep their chain (snapshotted via `workflowDefinitionId`).

**Tone:** zero jargon. "Step", "Who approves?", "Only if", "Time limit", "At the same time."
No "node", "DAG", "predicate".

### 8.2 hr-admin — Role Manager

- **Simple view:** five preset cards; click a person → assign a card; a sentence summarises their
  powers. Done.
- **Advanced toggle:** "Make a custom role" → clone a preset, rename, a **grouped checkbox list**
  (People / Time & Leave / Payroll / Settings / Lifecycle / Performance — grouped from
  `PERMISSIONS`), a **scope picker** ("Sees: Everyone / Their department / Their team / Only
  themselves"), a comp-visibility picker, and optional **temporary grants** ("until a date").
- Guardrails: you cannot remove your own `canManageRoles` (lockout guard); `isSystem` roles are
  clone-to-edit; every change is audited.

### 8.3 hr-admin — Org-Chart editor

- A pannable tree; search a person; **drag** them onto a new manager. A confirm toast: "Asha now
  reports to Ravi. This changes who approves Asha's requests." (because it does).
- **Flat-mode banner** when a tenant has no managers set: "You haven't set up a reporting
  structure. That's fine — your approval chains can point to specific people or roles instead."

### 8.4 ESS — unified Approvals inbox (`apps/ess`)

- A single **"Approvals"** tab listing everything awaiting *me*, any module, newest first: type
  icon, requester, one-line payload ("₹4,200 taxi — client visit"), age, SLA countdown. **Approve
  / Decline / Ask for changes** inline with an optional note. Delegated items show "On behalf of
  Asha."
- Extends `meTasks.controller.js` so the dashboard "Pending tasks" count includes approvals.

### 8.5 ESS — "Delegate while I'm away"

- On the profile/leave screens: **"Going on leave? Let someone approve for you."** Pick a person +
  dates (pre-filled from an approved leave if one exists) + optionally limit to certain request
  types. A clear summary: "Ravi will approve Leave & Reimbursement for you, 10–18 Jul." Revocable.

### 8.6 ESS — "who will approve this?" hint

- On any submit form (leave/expense/…), a small line: **"This will go to: Ravi (your manager),
  then Finance."** — a `previewChain` call. Sets expectations before the user clicks submit.

---

## 9. Security, SoD & edge cases

1. **Tenant isolation.** Every query filters `businessId`; `WorkflowStep.approverRefId`,
   delegation `toUserId`, reassign targets are all re-validated to belong to the same tenant
   (a cross-tenant id ⇒ 404, never leaks).
2. **Maker ≠ checker (SoD).** Enforced **twice**: (a) `approverResolver` removes the requester's
   user from every step's set; (b) `recordDecision` re-checks `actorUserId ≠ requesterUser` and
   403s. The auto/SLA system-actor and a delegated stand-in are *not* the requester, so they pass —
   but a stand-in who *is* the requester is still excluded (a founder can't self-approve via a
   delegation loophole).
3. **Self-approval collapse on tiny tenants.** If SoD empties a step (requester is their own
   manager), the resolver escalates → HR fallback → **explicit auto-approve with an audit note**.
   Never silently grants without a trail; never deadlocks a 1-person approval chain.
4. **Cycle / depth guards.** `REPORTING_MANAGER` N-up reuses the visited-set + depth-cap from
   `nearestManager` (corrupt chains can't loop). The org-editor rejects any re-parent that would
   create a cycle (server-side ancestor check).
5. **Concurrency.** All transitions are `version`-locked `updateMany`; lost races ⇒ 409. Two
   parallel approvers acting simultaneously each append their `ApprovalAction`; the level completes
   exactly once (`minApprovals` checked under the lock). The escalation runner is idempotent and
   version-guarded so it can't double-escalate the same request.
6. **Condition fail-closed.** A malformed/unknown `conditionJson` makes the step **not apply**
   (skipped) rather than block forever — but the builder validates conditions at save, so this is
   a defence-in-depth backstop, logged.
7. **In-flight immutability.** Publishing a new chain does **not** retro-mutate open
   `ApprovalRequest`s (they carry `workflowDefinitionId` + the steps they started with). Prevents
   "the rules changed under me" disputes.
8. **Delegation abuse.** A delegation cannot grant authority the delegator never had (the engine
   resolves the *step's* approver set; delegation only **forwards** an existing membership). Window
   bounds enforced; overlapping delegations both apply (union); revocation is immediate.
9. **Permission lockout.** Cannot remove the last `canManageRoles`/Owner; cannot delete the role
   you're using to make the change; `isSystem` roles are immutable (clone-to-edit).
10. **Audit everywhere.** `ApprovalAction` is append-only; reassignment, escalation, delegation
    use, and auto-decisions all write actions/notifications with provenance
    (`delegatedFromUserId`, system-actor marker, escalation reason). Role/hierarchy edits write to
    the existing HR audit trail.
11. **Privacy.** `payloadJson` carries only what the approver needs to decide (amount/dates/
    reason); sensitive reasons (sick/bereavement leave) follow the same `@pii:sensitive` handling
    as the leave ledger — the inbox shows "Sick leave" not the medical detail unless policy allows.
12. **Notification storms.** Reminders push `slaDueAt` forward instead of re-sending each sweep;
    parallel-level activation sends one notification per approver, deduped.

---

## 10. Build plan (5 slices)

Each slice is independently shippable and leaves the tree green (`node --test`). Slices 1–2 are
backend-only and **change no live behaviour** (the built-in defaults reproduce today); the risk is
back-loaded into the migration of real consumers in slice 3.

### Slice 10a — Engine core (pure + state machine, no consumers yet)
Additive migration (extend `WorkflowDefinition`, add `ApprovalDelegation`, `TRAVEL` enum).
Build `conditions.js` (pure, fully unit-tested), `approverResolver.js` (generalises
`approvalRouting.js`, with delegation + SoD), `workflowResolver.js` (+ BUILT_IN_DEFAULT per
module), `engine.js` (`openRequest`/`recordDecision`/`advance`/`cancel`/`previewChain`). Unit
tests for sequential, parallel/`minApprovals`, conditional skip, SoD collapse, auto-approve.
**No HTTP, no consumer wiring** — proven in isolation.

### Slice 10b — Config + inbox API + escalation runner
The `/api/hr/approvals/*` admin CRUD, `/inbox`, `/:id/decide`, delegation endpoints; RBAC gates +
new permission keys (`canManageApprovalWorkflows`/`canManageRoles`/`canManageHierarchy`) seeded
into `SYSTEM_ROLES`. `escalationRunner.js` + its cron wiring (REMIND/ESCALATE/AUTO_*). Integration
tests against the engine. Still no live consumer — operable via API/Postman.

### Slice 10c — Migrate Leave + Expense onto the engine (the proof)
Refactor `leave.controller.js` so approve/reject become engine **callbacks** (soft-hold + SoD +
ledger preserved, behaviour-identical, regression-tested against existing leave tests). Wire
`expenses.controller.js#submit` to `openRequest` and replace the bare flip with engine callbacks
(now expense gets a real, configurable chain). Backfill: zero-config tenants keep BUILT_IN_DEFAULT
behaviour. This slice is where the green-tree guarantee is most load-bearing.

### Slice 10d — Workflow Builder UI (hr-admin)
Process grid → Chain canvas (templates, step cards, "Only if" rules, time limits, parallel rows,
drag-reorder), Preview, Save-draft/Publish. The single highest-value, owner-facing UI. Plain
language throughout (§8.1).

### Slice 10e — RBAC + Hierarchy UIs + ESS (inbox & delegation)
hr-admin Role Manager (simple presets + advanced builder + grants) and Org-Chart editor
(drag-to-reparent, flat-mode). ESS unified Approvals inbox (extend `meTasks`), "Delegate while
away," and the "who will approve this?" submit hint. Closes the loop end-to-end.

*(Optional 10f if scope grows: wire the remaining consumers — Travel/Loan/Comp/Profile-change/
Regularization/Separation — each a one-line `openRequest` + callbacks; and a basic approval
analytics list. Most of this lands incrementally with each owning feature.)*

---

## 11. Acceptance (definition of done)

- A non-technical admin can, in < 2 minutes and with no jargon, set Reimbursement to "Manager,
  then Finance over ₹50k," **preview** the resolved approvers, publish, and see a real claim route
  exactly that way — including escalation when the manager sits on it.
- A 3-person tenant with **no org chart** can route everything to "the Owner" (a named person) and
  it just works; nobody can approve their own request.
- Leave + Expense run **through the engine** with byte-identical outcomes to today for zero-config
  tenants (existing tests stay green).
- Delegation, parallel "need 2 of 2," amount-tiered routing, and SLA auto-approve each have a
  passing test and a visible audit trail.
- Granular role builder + org-chart editor write the same `BusinessRole`/grant/`managerEmployeeId`
  rows the rest of the platform already reads — no parallel RBAC.

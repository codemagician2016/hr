# Feature 08 — Performance & Goals

> **Status:** spec / dev contract · **Module:** `backend/src/hr/talent/` (extend) + new `backend/src/hr/talent/performance/` lib · **Apps:** `apps/hr-admin`, `apps/ess`, `packages/ui`
> **Market:** country-agnostic (the only country touch-point is the optional merit hand-off into F5 `CompensationRevision`, which already carries `currencyCode`/`entityId`)
> **Builds on:** F1 RBAC/hierarchy (`rbac.js`, `scopeResolver.js`, `scope.middleware.js`), F4 Lifecycle (separation event seam, ESS lockout), F5 Compensation (`CompensationRevision` merit hand-off)
> **Author note:** every schema field / RBAC key / file path / line number below was verified against the live tree on 2026-06-23. Where existing code is wrong, it is flagged as a **bug to fix**, not reused. (Note: design inputs referred to this work as "Feature 6" — that was an input mislabel; the canonical number is **08**, per `docs/features/` ordering and the save path.)

---

## 1. Summary & goals

The performance domain is **half-built and headless**. The schema carries real, well-shaped, multi-tenant models under `// ── §14 Performance ──` (`schema.prisma:8741–8864`): `ReviewCycle` (`8742`, with inline `ratingScaleJson` and the `ReviewCycleStatus` machine), `PerformanceReview` (`8778`, self/manager/final ratings `Decimal(4,2)`, `outcomeJson`, `linkedCompensationId`, `version`, the `ReviewStatus` machine), `Goal` (`8813`, `weight`/`progress` `Decimal(5,2)`, `parentGoalId`, `GoalCategory`, `GoalStatus`), and `EmployeeSkill` (`8852`, free-text). There is **working CRUD + a correct status machine** at `talent/controllers/performance.controller.js` (279 lines), mounted at `/api/hr/performance` via `hr/routes/index.js:32`.

**What is broken or missing** clusters in four places:

1. **SECURITY BUG (highest value): no data-scope on any route.** Every route in `performance.routes.js` is gated only by binary `requirePermission('canViewEmployees'|'canManageEmployees')` (`performance.routes.js:11–13`). It does **not** apply `attachSelfEmployee` / `withEmployeeScope`, and the controller never calls `scopeWhere`/`scopeAllows`. Result: **any `canViewEmployees` holder reads every employee's review and goal tenant-wide, and any `canManageEmployees` holder writes them** — the Manager `TEAM` band (`rbac.js:82`) is silently ignored. The reusable chokepoint exists and is battle-tested in lifecycle/attendance (`scopeResolver.js:101`) but is **unwired** here.

2. **CORRECTNESS BUG: optimistic-lock column is dead.** `PerformanceReview.version` (`schema.prisma:8835` region) and `Goal.version` (`8830` region) both exist with `@default(0)`, but the controller **never reads or bumps them** — every transition is a blind `update` (`performance.controller.js:148,166,185,199,255`). Concurrent self/manager/calibrate writes silently clobber. Spec requires `WHERE id=… AND version=:expected` + `version: { increment: 1 }` on every mutation.

3. **NO SoD and NO actor-identity binding.** `createReview` validates reviewer/reviewee for tenant membership only (`performance.controller.js:121–126`) — **reviewer == reviewee (self-review-of-self) is allowed**; there is no "reviewee reportsTo reviewer" check. `submitSelfReview` does not check the caller IS the reviewee; `submitManagerReview` does not check the caller IS the reviewer (both gated by `canManageEmployees`, an HR-admin permission, so today they are admin-operated, not self-service). And `APPROVAL_ACTIONS` (`scopeResolver.js:25`) contains **no** performance action, so the fail-closed self-exclusion that protects leave/payroll does not protect reviews.

4. **NO frontend anywhere, NO ESS surface, NO merit write-back.** Neither `apps/hr-admin/app/` nor `apps/ess/app/` has a performance/goals/reviews dir; the API is reachable only by direct HTTP. There is no self-scoped ESS router (employees cannot see/submit their own reviews or update goal progress). `linkedCompensationId` is a loose `String?` (`schema.prisma:8795` region) — nothing validates it or creates the merit `CompensationRevision`; `parentGoalId` is never read (no OKR cascade/rollup); `EmployeeSkill` has zero API surface.

**Goals (v1 — see §3 scope):** wire the existing scope chokepoint into every performance route; add reviewer≠reviewee SoD via `APPROVAL_ACTIONS`; make `version` real; ship goals/OKRs (weights + check-in ledger + cascade rollup), a review cycle (self → manager → calibrate → sign-off → acknowledge), basic calibration (HR + skip-level), 1:1 notes, an ESS self-service surface, and the F5 merit hand-off **as a recommendation only** (Performance never writes `CompensationRevision` directly). Defer 360 analytics dashboards and advanced calibration matrices (9-box scoring engine, forced-distribution auto-clamp).

---

## 2. Existing assets — reuse verbatim

| Asset | Location | Reuse |
|---|---|---|
| Scope resolver | `scopeResolver.js:30,87,94` — `resolveAccessibleEmployeeIds(actor, action)` (TEAM = recursive reporting subtree), `scopeWhere(scope, field)`, `scopeAllows(scope, id)` | AND into every list/single-row perf query |
| SoD set | `scopeResolver.js:25,101` — `APPROVAL_ACTIONS` (exported; removes `selfId` from resolved ids) | **add** perf actions to it (§5.3) |
| Scope middleware | `scope.middleware.js:15,33,50` — `attachSelfEmployee`, `withEmployeeScope(action,{idParam})` (IDOR-safe 404 on out-of-scope `:id`) | add to perf routes |
| RBAC scope band | `rbac.js:82,95` — `effectiveScope(user)` → `ALL\|DEPARTMENT\|TEAM\|SELF\|NONE`; Manager→TEAM, ESS `USER`→SELF | the spine of all per-role scoping |
| Permissions registry | `rbac.js:11` `PERMISSIONS` (frozen, **additive — new keys need no migration**) | add 3 keys (§5.1) |
| Hierarchy data | `Employee.managerEmployeeId` (`schema.prisma:6548`, self-rel `EmpManager`, index `6589`); `EmploymentRecord.managerEmployeeId` (`6637`) | reviewer resolution + as-of snapshots |
| Merit target | `CompensationRevision` (`schema.prisma:6925`); `CompRevisionReason` has `ANNUAL_REVISION` (`6958`) + `PROMOTION` (`6959`); effective-dating + `approvalRequestId` | F5 consumes `MeritRecommendation` → creates revision |
| Separation seam | F4 separation event + terminated-employee ESS lockout (commit `66c33d2`) | mid-cycle `cancel` + ESS gate |
| AuditLog | existing row shape (`{action, entityType, entityId, meta}`) | every transition + calibration adjust + merit recommend |
| Frontend kit | hr-admin `@hr/ui` + `lib/ui.js` (`PageHeader`, `DataTable`, `Tabs`, `StatusBadge`, `ActionButton`, `asList`, `employeeLabel`), `lib/api.js` (`get/post/patch/del`, throws `err.status`/`err.data`), `lib/nav.js`; ESS `lib/api.js` (`apiGet/apiPost/apiPatch`), `useApi.js`, `AppShell`+`BottomNav` | build UI on these |

---

## 3. Scope (in / out)

**IN (v1):**
- **Goals / OKRs:** `Objective` + `KeyResult` + append-only `GoalCheckIn` ledger + `ObjectiveAlignment` cascade edge; weighted progress rollup; weight invariants (Σ=100); manager-chain alignment guard. (Reuse existing `Goal` for the flat-goal path; the OKR models are additive on top.)
- **Review cycle:** config (`ReviewCycle` + new `ReviewTemplate` + `RatingScale`), per-employee `ReviewInstance` minting with **snapshot-on-freeze**, and the state machine self → manager → calibrate → sign-off → acknowledge → close.
- **Ratings + basic calibration:** rating roll-up to composite score; HR + skip-level calibration with append-only adjustment ledger; distribution **warning** (not forcing).
- **1:1 notes** (`OneOnOne`, shared agenda + private manager notes).
- **F1 data-scope wired everywhere + reviewer≠reviewee SoD + peer-feedback confidentiality** (serializer-level).
- **F5 merit hand-off hook** — emit `MeritRecommendation` on review close (Performance never writes the revision).
- **ESS self-service** (own goals/check-ins, self-review, give/request feedback, view released rating + acknowledge).

**OUT (defer):** 360 analytics dashboards / trend BI; advanced 9-box scoring engine + forced-distribution auto-clamp (v1 ships soft warning only); `Skill`/`Competency` catalog (EmployeeSkill stays free-text; no API in v1); PIP as a first-class entity (stays in `outcomeJson`); skip-level *review* questionnaires (only skip-level *calibration*); cross-cycle compensation analytics.

---

## 4. Data model — additive Prisma

All new models live in `backend/prisma/schema.prisma` under §14, tenant-scoped on `businessId`, FK to `Employee` (`6506`). Optimistic `version Int @default(0)` on every mutable model (matches `PayRun`/`Employee`/existing `PerformanceReview` convention). Append-only ledgers carry no `version` (immutable rows).

### 4.1 Reuse existing models (no change to columns; fix the controller, not the schema)
- `ReviewCycle` (`8742`) — keep. **Add** `templateId String?`, `ratingScaleId String?`, `releasedAt DateTime?` (see gap below), `goalWeightPct`/`competencyWeightPct Decimal(5,2)`.
- `PerformanceReview` (`8778`) — this is the **`ReviewInstance`** of the design. Keep the model and the `ReviewStatus` enum; **add** `subjectSnapshot Json?`, `proRationFactor Decimal(5,4) @default(1)`, `compositeScore Decimal(6,3)?`, `meritEligible Boolean @default(false)`, `releasedAt DateTime?`, `calibratedRating Decimal(4,2)?`. Make `linkedCompensationId` a real relation to `CompensationRevision` (today a loose `String?` — **bug**).
- `Goal` (`8813`) — keep for the flat/individual-goal path. OKR models below are additive; `Goal.parentGoalId` is the legacy cascade hook (currently unread).

### 4.2 New models (additive)

```prisma
// ── OKRs ──
model Objective {
  id String @id @default(cuid())
  businessId String
  ownerEmployeeId String
  level ObjectiveLevel            // ORG | TEAM | INDIVIDUAL
  parentObjectiveId String?       // alignment edge (child → parent)
  cycleId String?                 // optional bind to ReviewCycle
  title String; description String?
  category GoalCategory           // reuse existing enum (8835)
  weight Decimal(5,2)             // Σ within (owner, cycle) enforced = 100
  startDate DateTime? @db.Date
  dueDate DateTime  @db.Date
  status GoalStatus               // reuse existing enum (8842)
  progress Decimal(5,2) @default(0)   // ROLLED UP from KRs — never authored directly
  visibility GoalVisibility @default(PUBLIC)  // PUBLIC | MANAGER_CHAIN | PRIVATE
  version Int @default(0)
  @@index([businessId, ownerEmployeeId, status])
}
model KeyResult {
  id String @id @default(cuid())
  businessId String; objectiveId String
  title String
  metricType KrMetricType         // PERCENT|NUMERIC|CURRENCY|BOOLEAN|MILESTONE
  startValue Decimal(18,4); targetValue Decimal(18,4); currentValue Decimal(18,4)
  unit String?
  direction KrDirection           // INCREASE|DECREASE|MAINTAIN
  weight Decimal(5,2)             // Σ within objective enforced = 100
  confidence RagStatus            // ON_TRACK|AT_RISK|OFF_TRACK
  status GoalStatus
  version Int @default(0)
}
model GoalCheckIn {              // append-only progress ledger (no version)
  id String @id @default(cuid())
  businessId String; keyResultId String; authorEmployeeId String
  previousValue Decimal(18,4); newValue Decimal(18,4)
  confidence RagStatus; note String?
  createdAt DateTime @default(now())
}
model ObjectiveAlignment {        // denormalized cascade edge for the tree view
  id String @id @default(cuid())
  businessId String; childObjectiveId String; parentObjectiveId String
  alignmentWeight Decimal(5,2)
}

// ── Review config ──
model ReviewTemplate {
  id String @id @default(cuid())
  businessId String; name String
  ratingScaleId String?
  sectionsJson Json   // [{key:'competencies',items:[{competency,weight,anchors[]}]},{key:'goals',sourcedFrom:'OKR'},{key:'narrative',prompts[]}]
  version Int @default(0)
}
model RatingScale {
  id String @id @default(cuid())
  businessId String; name String
  pointsJson Json   // [{value:5,label:'Exceptional',numeric:5.0,anchor:'...'}]
  allowsHalfPoints Boolean @default(true)
  forcedDistributionJson Json?   // optional target curve, used as soft guardrail only
}

// ── Review responses / 360 ──
model ReviewResponse {           // answers per template item; self vs manager are separate rows
  id String @id @default(cuid())
  businessId String; reviewInstanceId String
  perspective ReviewPerspective  // SELF|MANAGER|PEER|SKIP_LEVEL|PRIOR_MANAGER
  sectionKey String; itemKey String
  ratingValue Decimal(4,2)?; comment String?
  authorEmployeeId String
  visibility ResponseVisibility @default(SHARED)  // SHARED|MANAGER_ONLY|HR_ONLY
}
model PeerFeedbackRequest {
  id String @id @default(cuid())
  businessId String; reviewInstanceId String
  requestedByEmployeeId String; raterEmployeeId String
  status FeedbackStatus; dueDate DateTime? @db.Date
}
model PeerFeedbackResponse {
  id String @id @default(cuid())
  businessId String; requestId String
  ratingsJson Json?; narrative String?
  isAnonymous Boolean @default(true)   // raterEmployeeId NEVER serialized to subject when true
  submittedAt DateTime?
}

// ── Calibration ──
model CalibrationSession {
  id String @id @default(cuid())
  businessId String; cycleId String
  skipLevelEmployeeId String        // group root (reviewer's manager)
  status CalibrationStatus; version Int @default(0)
}
model CalibrationAdjustment {       // append-only (no version)
  id String @id @default(cuid())
  businessId String; sessionId String; reviewInstanceId String
  fromRating Decimal(4,2)?; toRating Decimal(4,2)
  reason String; byEmployeeId String
  createdAt DateTime @default(now())
}

// ── 1:1 ──
model OneOnOne {
  id String @id @default(cuid())
  businessId String; managerEmployeeId String; employeeEmployeeId String
  scheduledAt DateTime
  agendaJson Json?; sharedNotes String?
  privateNotes String?              // NEVER returned to the employee's ESS
  actionItemsJson Json?
  version Int @default(0)
}

// ── Merit hand-off (this module's OUTPUT; F5 owns the decision) ──
model MeritRecommendation {
  id String @id @default(cuid())
  businessId String; reviewInstanceId String; subjectEmployeeId String; cycleId String
  finalRating Decimal(4,2); compositeScore Decimal(6,3); proRationFactor Decimal(5,4)
  recommendedPct Decimal(5,2)       // from cycle's rating→merit matrix (config)
  status MeritStatus @default(PENDING)   // PENDING|APPROVED|APPLIED|REJECTED
  compensationRevisionId String?    // set by F5 when applied
  version Int @default(0)
}
```

New enums: `ObjectiveLevel`, `KrMetricType`, `KrDirection`, `RagStatus`, `GoalVisibility`, `ReviewPerspective`, `ResponseVisibility`, `FeedbackStatus`, `CalibrationStatus`, `MeritStatus`. Add `Business` + `Employee` back-relations alongside the existing perf ones (`schema.prisma:6574–6577`, `494–497`).

### 4.3 Schema-level fixes flagged
- `PerformanceReview.linkedCompensationId` → real FK relation to `CompensationRevision` (today loose `String?`, **bug**).
- Add `ReviewCycle.releasedAt` (no release gate exists today — `CALIBRATED` jumps straight to employee-visible).
- `Goal.version` / `PerformanceReview.version` exist but are **dead** — the fix is in the controller (§5.4), not the schema.

---

## 5. Backend — services, scoping, SoD, hand-off

Module layout mirrors `backend/src/hr/lifecycle`:

```
backend/src/hr/talent/
  routes/performance.routes.js        # extend: add scope middleware to every route
  routes/ess-performance.routes.js    # NEW — self-scoped /api/hr/ess/performance/*
  controllers/performance.controller.js   # extend (scope + version + SoD)
  controllers/essPerformance.controller.js # NEW — derive employeeId from session
  performance/
    reviewStateMachine.js   # transition table + applyTransition(tx, instance, event, actor)
    goalRollup.js           # KR→Objective→parent weighted progress (pure, unit-tested)
    calibration.js          # skip-level group CTE + distribution stats
    proration.js            # joiner/transfer factor
    meritHandoff.js         # emit MeritRecommendation on review.closed
    managerChain.js         # resolveManagerChainEmployeeIds(actor) — walk UP managerEmployeeId
  __tests__/                # state guards, SoD exclusion, scope 404, weight Σ, anon floor
```

### 5.1 New permission keys (additive to `PERMISSIONS`, `rbac.js:11` — no migration)
```
canManagePerformanceCycle : 'Create/configure review cycles, templates, scales; reopen/calibrate'
canCalibrateRatings       : 'Participate in calibration sessions for own org sub-tree'
canViewTeamPerformance    : "View reports' goals + reviews (TEAM band)"
```
Preset wiring: **HR-Admin** → all three; **Manager** → `canViewTeamPerformance` (TEAM scope implies the subtree); **Finance** → read on `MeritRecommendation` only; **ESS `USER`** → implicit self-access (own goals + own review when released).

### 5.2 Scope enforcement — wire the existing chokepoint (fixes BUG #1)
Routes follow the shipped pattern: `protect` → `requirePermission(key)` → `attachSelfEmployee` → `withEmployeeScope(action,{idParam})`; controllers AND `scopeWhere(req.scope,'employeeId')` (reviews) / `'ownerEmployeeId'` (objectives) into every list, and `scopeAllows(req.scope, …)` on single-row routes (out-of-scope `:id` → **404**, never leak existence).

| Action | Resolver | Effect |
|---|---|---|
| Manager lists team reviews | `resolveAccessibleEmployeeIds(actor,'canViewTeamPerformance')` → TEAM ids | `WHERE subjectEmployeeId IN ids`; out-of-team `:id` → 404 |
| Manager opens an instance | `scopeAllows(scope, subjectEmployeeId)` | reviewer touches own reports only |
| Employee views own | TEAM/SELF includes `selfId` | own goals always; own review **only when `releasedAt != null`** |
| Calibration / skip-level | TEAM rooted at skip-level employee | sees the manager-group; HR has ALL |
| Objective alignment | `resolveManagerChainEmployeeIds(actor)` (NEW — same CTE, walks **up**) | IC may align only to a parent owned within own manager chain |

### 5.3 Separation of duties (reviewer ≠ reviewee) — fixes BUG #3
Add `'review.submitMgr'`, `'review.calibrate'`, `'review.signOff'` to **`APPROVAL_ACTIONS`** (`scopeResolver.js:25`). That set already *removes `selfId`* from the resolved id-set (`scopeResolver.js:56,80`), so a manager who is somehow their own subject is structurally excluded from rating themselves — fail-closed, identical to "a manager cannot approve their own leave." Manager review of one's own instance becomes impossible by construction, not by a rot-prone `if`.

**Edge — top-of-tree / self-managed:** if `reviewerEmployeeId == subjectEmployeeId` after snapshot (CEO, manager vacancy), `open` escalates `reviewerEmployeeId` to the **skip-level** (parent's manager); if none exists (true root), the instance routes to an **HR-designated reviewer** on the cycle — never self-resolves.

### 5.4 Optimistic concurrency — fixes BUG #2
Every mutation runs inside a tx with `WHERE id=:id AND version=:expected` and `data: { …, version: { increment: 1 } }`. A repeated `submitSelf` / stale-`version` write → **409** ("updated elsewhere, reload"), never a double-effect. Apply to: `submitSelfReview` (`controller.js:148`), `submitManagerReview` (`:166`), `calibrateReview` (`:185`), `acknowledgeReview` (`:199`), `updateGoal` (`:255`), and all new KR/check-in/calibration writes.

### 5.5 Review state machine (pure transition table, mirrors `SeparationStatus`)
`performance/reviewStateMachine.js` holds `{from, event, to, guard, sideEffects, actorRole}`. Keep the existing `ReviewStatus` enum values; the machine adds release/sign-off as explicit steps. Every transition writes `AuditLog {action:'review.transition', entityType:'PerformanceReview', meta:{from,to,actorId}}`.

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| NOT_STARTED | `open` | NOT_STARTED (minted) | cycle ACTIVE; subject eligible | freeze `subjectSnapshot`, compute `proRationFactor`, mint peer requests |
| NOT_STARTED | `submitSelf` | SELF_SUBMITTED | **actor = subject**; required self items answered; cycle ∈ SELF_REVIEW/ACTIVE; respect `ratingScaleJson.selfRequired` | lock self responses read-only-for-subject; notify reviewer |
| NOT_STARTED / SELF_SUBMITTED | `submitMgr` | MANAGER_SUBMITTED | **actor = reviewer ≠ subject (SoD)**; mgr rating + comments set; peer gate satisfied | snapshot managerRating |
| MANAGER_SUBMITTED | `calibrate` | CALIBRATED | actor ∈ {HR, skip-level}; cycle ∈ CALIBRATION | record `calibratedRating` + delta + justification (`CalibrationAdjustment`) |
| CALIBRATED | `signOff` | CALIBRATED (locked) + `releasedAt` set on release | actor = reviewer **or** skip-level; `finalRating` set | lock `finalRating`; compute `compositeScore`×`proRationFactor`; set `meritEligible` |
| CALIBRATED (released) | `acknowledge` | ACKNOWLEDGED | **actor = subject** | record ack + optional rebuttal note |
| ACKNOWLEDGED | `close` | CLOSED | rebuttal window elapsed or ack received | emit `review.closed` → merit hand-off (§5.7) |
| CALIBRATED | `reopen` | MANAGER_SUBMITTED | actor = HR (`canManagePerformanceCycle`) | audit reason; prior ratings preserved as history |
| any non-terminal | `cancel` | CANCELLED | actor = HR; or subject separation (F4) triggers it | unfreeze merit eligibility |

> **Note on existing controller deltas:** today `submitManagerReview` allows `NOT_STARTED → MANAGER_SUBMITTED` with no self-required check (`controller.js:160`) and `calibrateReview` accepts `linkedCompensationId` but writes nothing real (`:184`). The machine above supersedes both. **Release gate** is new: ESS must gate `finalRating`/`managerComments` on `releasedAt != null` (today `CALIBRATED` is immediately employee-visible — a confidentiality bug).

**Idempotency:** transitions are tx + `WHERE state=:from AND version=:expected` (per §5.4).

### 5.6 Goals/OKR service (`goalRollup.js`, pure)
```
KR.progress       = clamp((current−start)/(target−start), 0, 1) × 100   // DECREASE inverts numerator
Objective.progress= Σ(KR.progress × KR.weight) / Σ(KR.weight)            // weighted mean
Parent rollup     = Σ(child.progress × alignmentWeight)                  // read-model only
```
Progress is **never** directly writable on an Objective — only via a `GoalCheckIn` on a KR (always a ledger entry explaining a number change). **Weight invariants (422 on violation):** Σ(KR.weight)/objective = 100; Σ(Objective.weight)/(owner,cycle) = 100. Validated transactionally with `version`. **Alignment guard:** an INDIVIDUAL objective may align only to a parent owned within `resolveManagerChainEmployeeIds(actor)` (the inverse of TEAM).

### 5.7 Calibration + merit hand-off (loose coupling to F5)
- **Calibration group** = `ReviewInstance`s whose subjects roll up to a common **skip-level** manager — resolved by the TEAM CTE rooted at the skip-level employee (no new tree). A `CalibrationSession` locks members into the calibrate step; HR + skip-level adjust `calibratedRating`; every change is an append-only `CalibrationAdjustment`. `forcedDistributionJson` drives a **live actual-vs-target warning histogram** — the system warns, never auto-clamps (v1).
- **Merit hand-off:** on `review.closed`, instances with `meritEligible && finalRating` enqueue a `MeritRecommendation` (rating→% from the cycle matrix). Performance **only emits the recommendation**; F5 consumes it, applies its own `canManageCompensation` + SoD, and on apply creates a `CompensationRevision(reason: ANNUAL_REVISION|PROMOTION)` (`CompRevisionReason`, `schema.prisma:6958–6959`) and back-links `compensationRevisionId`. Country-specific comp logic stays entirely in F5; Performance stays country-agnostic.

### 5.8 Confidentiality (serializer-level, not just route-level)
- **Peer/360:** `isAnonymous=true` → `raterEmployeeId` + identifying narrative stripped from every serializer path resolving for subject or subject's manager. Only HR sees rater identity (audited read). Aggregates shown with an **n≥3 floor** to prevent de-anonymization.
- **Calibration deltas:** `CalibrationAdjustment` + `MANAGER_ONLY`/`HR_ONLY` responses never serialize to the subject (they see `finalRating` + shared narrative, not "you were moved 4→3").
- **`ReviewResponse.visibility`** column gate keyed on requester's relationship (self / manager-chain / HR), computed from the same scope resolver.

---

## 6. Frontend

### 6.1 HR-Admin (`apps/hr-admin/app/performance/` — NEW)
Nav (`lib/nav.js`): `{ key:'performance', label:'Performance', href:'/performance', feature:'hr', permission:'canViewEmployees' }` (config CTAs hidden when session lacks `canManagePerformanceCycle` via `hasPermission`).
- `page.js` — Cycles list (`PageHeader`+`Tabs`+`DataTable`+`StatusBadge`; per-row completion via `GET /cycles/:id/stats`, **not** N+1).
- `cycles/[id]/page.js` — workspace tabs **Overview · Reviews · Goals · Calibration · Publish**. Launch = `POST /cycles/:id/launch` (bulk-mint reviews, auto-assign `reviewerId=managerEmployeeId`, idempotent, reports `skipped:[{employeeId,reason:'no_manager'}]`) — **new endpoint** (today `createReview` is one-at-a-time, `controller.js:114`).
- `templates/page.js` — `ReviewTemplate` builder (sections/items/weights); cycle with no template falls back to the legacy flat self/manager form (non-blocking).
- `settings/page.js` — `RatingScale` library; editing a scale bound to an ACTIVE cycle is blocked ("clone to edit").
- Calibration tab — roster + distribution histogram with target overlay; per change `POST /reviews/:id/calibrate` (only `MANAGER_SUBMITTED` calibratable; greys-out not-yet-submitted with tooltip). Never overwrites `managerRating`/`selfRating`.
- Publish tab — checklist → `POST /cycles/:id/release` (stamps `releasedAt`, notifies); merit `POST /reviews/:id/link-compensation` (idempotent; requires `canManageCompensation`); close → `PATCH /cycles/:id {status:'CLOSED'}`.

### 6.2 Manager (same hr-admin app, scope=TEAM)
Page detects scope from `/api/auth/me`; renders the manager surface (no Templates/Settings/Launch/org-wide-publish). Team home (`reviews?reviewerId=me`, **server-scoped**, not query-trusted); Team goals (set/approve reports' `DRAFT→ACTIVE`, cascade via `parentObjectiveId`); Manager review editor `reviews/[id]` (read-only self pane + manager `<RatingScale>` + comments → `POST /reviews/:id/manager`) — **unreachable for the manager's own review** (`review.employeeId===me` → 403/redirect, server-enforced); group calibration (propose-only, own subtree, HR holds the lock); 1:1s (`OneOnOne`, `privateNotes` never sent to ESS).

### 6.3 Employee (`apps/ess/app/performance/` — NEW, all via self-scoped router)
Mobile-first (`AppShell`+`BottomNav`, add "Growth" tab). Hub (`GET /ess/performance/overview` → `{cycle, myReviewStatus, goalStats, pendingFeedback, ratingReleased}`); My Goals + check-ins (`GET/POST/PATCH /ess/performance/goals`, `POST .../goals/:id/check-ins`, self-scoped, cross-employee id → 404); Self-review (template/flat form, `selfRequired` gate, `POST /ess/performance/review/self`, read-only after submit); Peer feedback (give/request; requester sees status only, declines silent, summary anonymized); My rating + history — **entire screen gated on `cycle.releasedAt`**; pre-release the API returns `finalRating:null`/`managerComments:null` (never client-hidden); acknowledge `POST /ess/performance/review/acknowledge`. Terminated employees: F4 ESS lockout already enforced.

### 6.4 Shared UI (`packages/ui/index.js` — extend)
`<RatingScale value editable scale onChange />` (labelled segmented control, read-only chip mode) driven by `ratingScaleJson` so "4 — Exceeds" looks identical in all three apps; `<GoalCard>` (progress ring + status pill + due date). Status vocab via shared `<StatusBadge>` (cycle/review/goal palettes per §1.2 of the experience input).

---

## 7. End-to-end per role + acceptance

**HR-Admin** configures cycle/template/scale → launches (bulk-mint, reports skips) → tracks completion → runs calibration (HR + skip-level) → releases → links merit → closes. **AC:** dup `code` → field error not lost form; non-`canManagePerformanceCycle` sees cycles read-only; release gate holds (`finalRating` absent from ESS payloads pre-`releasedAt`); merit link idempotent + requires `canManageCompensation`; closed cycle fully read-only.

**Manager (TEAM)** sees only reports — every list/detail **server-filtered** to the reporting subtree (out-of-scope → 404); sets/approves reports' goals; reviews reports only; **cannot** review own instance (SoD); proposes calibration within own group; keeps 1:1s. **AC:** zero access to cycle config/launch/templates/org-wide calibration/release/merit (CTAs absent + endpoints 403); `reviews?reviewerId=me` enforced server-side, never trusted from the param.

**Employee (SELF)** touches only own goals/self-review/acknowledgement; gives/requests peer feedback; views released rating. **AC:** cross-employee id → 404; pre-release rating absent from payload; peer feedback about others never readable; self-review locks after submit (409 on re-submit).

**Calibration** is HR + skip-level only; a manager never sees cards outside their subtree; cross-group totals hidden.

---

## 8. QA plan (numbered)

1. **Cycle/review state machine** — every legal transition succeeds; every illegal one 409s with a clear message; `reopen` preserves prior ratings; `cancel` on F4 separation works; release stamps `releasedAt`.
2. **Goal cascade + weights** — Σ(KR.weight)=100 and Σ(Objective.weight)/(owner,cycle)=100 enforced (422); alignment to an out-of-manager-chain parent rejected; `parentObjectiveId` rollup matches the weighted formula.
3. **Rating roll-up + calibration** — `compositeScore = goal×goalWeight + comp×compWeight`, scaled by `proRationFactor`; calibrate writes `calibratedRating`/`CalibrationAdjustment` only, never clobbers self/manager ratings; distribution warning fires, never auto-clamps.
4. **RBAC: reviewer≠reviewee + scope** — manager cannot open/submit a review where subject ∉ subtree (404); manager cannot rate self (SoD via `APPROVAL_ACTIONS` excludes `selfId`); ESS cross-employee read/write → 404; `canViewEmployees`-only operator cannot see other teams' reviews (regression test for BUG #1).
5. **Peer-feedback confidentiality** — anonymous rater identity never serialized to subject/manager; aggregates suppressed below n=3; requester sees status not content; decline is silent.
6. **Release gate** — `finalRating`/`managerComments` **absent from the payload** (not merely hidden) before `releasedAt`; present after.
7. **Optimistic concurrency** — stale `version` on self/manager/calibrate/ack/goal/KR → 409; no double-effect on repeated submit (regression test for BUG #2).
8. **Mid-cycle transfer** — `subjectSnapshot.managerId` frozen at `open`; `reassignReviewer` preserves outgoing draft as `PRIOR_MANAGER` `MANAGER_ONLY` response; new manager (only) can act; pro-ration splits by tenure.
9. **New-joiner pro-ration** — post-cutoff hire either deferred (`CANCELLED`) or included with `proRationFactor = daysInRole / cyclePeriodDays`; composite scaled + labelled.
10. **Merit hand-off** — `review.closed` emits exactly one `MeritRecommendation`; Performance creates **no** `CompensationRevision` directly; F5 apply back-links `compensationRevisionId`; re-run idempotent.
11. **Audit** — every transition + calibration adjustment + merit recommend writes an `AuditLog` row with before/after.
12. **Launch idempotency** — re-launch skips employees with an existing review (`@@unique([businessId,reviewCycleId,employeeId])`), reports no-manager skips, never double-mints.

---

## 9. Build sequence (one pass)

- **8a — Security/scope retrofit (do first):** wire `attachSelfEmployee`+`withEmployeeScope` into `performance.routes.js`; AND `scopeWhere`/`scopeAllows` into the controller; add the 3 permission keys; add perf actions to `APPROVAL_ACTIONS`; make `version` real. *Closes BUGs #1–#3 on the already-shipped CRUD — ship even before new models.*
- **8b — Goals/OKR:** `Objective`/`KeyResult`/`GoalCheckIn`/`ObjectiveAlignment` + `goalRollup.js` + weight invariants + `managerChain.js` alignment guard.
- **8c — Cycle/template/scale + minting:** `ReviewTemplate`/`RatingScale` + `ReviewCycle` extensions; bulk `launch` with snapshot + pro-ration.
- **8d — Review state machine:** self→manager→calibrate→signOff→acknowledge→close in `reviewStateMachine.js`; SoD; release gate; confidentiality serializer.
- **8e — Calibration:** `CalibrationSession`/`CalibrationAdjustment` + distribution stats + sign-off.
- **8f — ESS surface:** `ess-performance.routes.js` + `essPerformance.controller.js` (self-scoped) + `apps/ess` screens; `<RatingScale>`/`<GoalCard>` in `packages/ui`.
- **8g — Merit hand-off + 1:1:** `meritHandoff.js` → `MeritRecommendation`; `OneOnOne`; F5 `link-compensation` contract.

---

**Relevant files:**
- Backend domain: `/Users/kp/hr/backend/src/hr/talent/controllers/performance.controller.js`, `/Users/kp/hr/backend/src/hr/talent/routes/performance.routes.js`, `/Users/kp/hr/backend/src/hr/talent/routes/index.js`, mount `/Users/kp/hr/backend/src/hr/routes/index.js:31–32`
- Models: `/Users/kp/hr/backend/prisma/schema.prisma:8741–8864` (+ Employee back-rels `6574–6577`, Business `494–497`, `CompensationRevision` `6925`/`CompRevisionReason` `6956–6959`, `Employee.managerEmployeeId` `6548`)
- RBAC/scope reuse: `/Users/kp/hr/backend/src/core/lib/rbac.js:11,82,95`, `/Users/kp/hr/backend/src/hr/lib/scopeResolver.js:25,30,87,94,101`, `/Users/kp/hr/backend/src/hr/middleware/scope.middleware.js:15,33,50`, `/Users/kp/hr/backend/src/hr/lib/approvalRouting.js:30`
- Frontend to extend: `/Users/kp/hr/apps/hr-admin/app/performance/` (new), `/Users/kp/hr/apps/hr-admin/lib/{nav,api,ui}.js`; `/Users/kp/hr/apps/ess/app/performance/` (new), `/Users/kp/hr/apps/ess/lib/api.js`, `/Users/kp/hr/apps/ess/components/{AppShell,BottomNav}.js`; `/Users/kp/hr/packages/ui/index.js`

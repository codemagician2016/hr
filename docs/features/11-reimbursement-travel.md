# Feature 11 — Reimbursement / Claims + Travel & Outdoor-duty (custom policy engine)

> **Status:** spec / dev contract · **Module:** `backend/src/hr/expenses/` (promoted from the single `controllers/expenses.controller.js`) · **Apps:** `apps/hr-admin`, `apps/ess`
> **Markets:** India + New Zealand · **Builds on:** F1 RBAC/hierarchy/scope (`scopeResolver.js`, `approvalRouting.js`, `rbac.js`), the **approval engine** (`WorkflowDefinition`/`WorkflowStep`/`ApprovalRequest`/`ApprovalAction` — the prompt's "Feature-10 approval engine", already in `schema.prisma:9813-9934` with `WorkflowModule.EXPENSE`/`LOAN`), F4 Lifecycle (`NumberSequence` + `codes.js allocateCode`, `validateDocDataUrl`, built-in maker-checker SoD), F5 Compensation (`Grade.rank` = employee LEVEL), existing Expenses (`expenses.controller.js`, `ExpenseClaim`/`ExpenseCategory`/`ExpensePolicy`/`ExpenseClaimLine`).
> **Author note:** every schema field / RBAC key / file path / helper claim below was verified against the live tree on 2026-06-24. Helpers that exist are flagged **reuse** with an anchor; net-new is flagged **build-new**. This file is the single source of truth for the build.

---

## 1. Summary & goals

DriftHR already has a *minimal* expense module: an `ExpenseClaim` walks a hard-coded `DRAFT → SUBMITTED → APPROVED/REJECTED → REIMBURSED` state machine (`expenses.controller.js:33-44`), claims get a sequential `EXP-####` reference (`nextClaimNumber`, line 49), categories + a thin `ExpensePolicy` (`maxPerClaim`/`maxPerMonth`/`requireReceipt`) exist in the schema but are **unused by the controller**, the approve/reject/reimburse actions are gated only by `canManageEmployees` at the route (`expenses.routes.js:25-29`) with **no F1 scope check and no approval chain**, there is **no ESS surface** (no `meExpenses.routes.js`), and there is **no travel / outdoor-duty concept at all**.

This feature turns it into an **industry-best claims + travel engine** with three pillars:

1. **Claims with a real approval chain.** Every claim keeps its **claim ID** (`EXP-####`) and is routed through the **admin-configured approval engine** (`WorkflowDefinition` for `module: EXPENSE`) — manager → finance, amount-tiered, parallel, SLA-escalated — instead of the single hard-coded hop. The maker (requester) can never be a checker (SoD). A manager sees + approves only their **F1 reporting sub-tree**'s claims.

2. **Outdoor / official duty + travel.** An employee **applies for outdoor duty / a trip** → a **travel ID** (`TRV-####`) is generated → the trip itself is approved (pre-trip) → the employee submits **bills against that travel ID**, each a line on a travel-linked claim.

3. **A fully custom Travel & Expense POLICY the admin builds**, with **auto-validation of every submitted bill**:
   - **Per-diem caps by trip duration** — 24h full / 12h / half day, split food + incidentals.
   - **Hotel budget by employee LEVEL × city TIER** (a matrix the admin fills).
   - **Allowed transport modes** (public transport, self-car @ per-km, flight, train) with **fare/eligibility conditions** (flight only if journey > N hours; train class by level) and **per-km / cap rules**.
   - The engine **auto-validates** each bill on submit: within limit → `OK`; over limit → `FLAGGED` (approver sees the breach) or `AUTO_REJECTED` (hard cap), per the policy's enforcement mode.

**Goals (v1):**
1. **Configure once.** HR builds a `TravelPolicy` (versioned): per-diem table, hotel matrix (`Grade.rank` level × `CityTier`), transport-mode rules, and per-category limits — folding the existing `ExpensePolicy` into the same engine. Plain-language wizard; sensible IN/NZ defaults seeded.
2. **Apply for a trip.** ESS: employee requests outdoor duty / travel → `TRV-####` minted → routed through the `EXPENSE` (sub-type `TRAVEL`) workflow for **pre-trip approval** (estimate validated against policy).
3. **Claim against the trip (or standalone).** ESS: add bill lines (category, amount, date, receipt upload), each **auto-validated against policy** with a live verdict. Submit → routed through the approval chain. A standalone (non-travel) reimbursement uses the same form without a travel ID.
4. **Approve in scope.** Manager/Finance inbox shows pending claims/trips **within their F1 scope**, the policy verdict per line, receipt thumbnails, one-click approve/reject/return-for-changes with comment — driven by the approval engine, not the route guard.
5. **Settle.** Finance marks `REIMBURSED` with a payment ref, or pushes the net into payroll via `payRunId` (reuses the existing `ExpenseClaim.payRunId` hook + the loans `LOAN_REPAYMENT`-style component pattern).
6. **RBAC-correct.** Reuse F1 scope on every read/write; add `canApproveExpense` / `canManageExpensePolicy` keys (additive to the `permissions` JSON — no migration). Tenant isolation + maker-checker SoD enforced everywhere.

**Non-goals (v1):** corporate-card / bank-feed reconciliation; OCR receipt auto-extraction (we store + hash the file, fields stay manual — `receiptOcrJson` reserved for forward-compat); multi-currency FX conversion inside a single claim (each line carries its own `currencyCode`, settlement is single-currency per claim); GST/input-tax-credit extraction; mileage via GPS; advances *against a trip* tied to the `Loan` ledger (the trip-advance amount is recorded on the trip and netted at settlement, but the formal advance-recovery schedule stays in F-loans); travel **booking** (we govern reimbursement, not a GDS/booking integration).

---

## 2. Scope

### In scope (v1 — reuse-first)

**Reuse as-is (no change):**
- **F1 RBAC + scope chokepoint** — `resolveAccessibleEmployeeIds(actor, action)` + `scopeWhere`/`scopeAllows` (`scopeResolver.js`). Out-of-scope subject ⇒ list excludes / single-row 404 (never 403 leak), exactly as leave/attendance. `expenses.controller.js` today has **none** of this — adding it is the single biggest correctness fix.
- **Approval-routing resolver** — `resolveApprover(employee)` (`approvalRouting.js`) for the manager→escalate→HR fallback when a workflow step is `REPORTING_MANAGER`.
- **Approval engine models** — `WorkflowDefinition`/`WorkflowStep` (`schema.prisma:9813-9863`) with `conditionJson` amount-tiered routing, `approverType` (`REPORTING_MANAGER`/`HR`/`SPECIFIC_ROLE`/…), `isParallel`/`minApprovals`/`slaHours`/`onTimeoutAction`; `ApprovalRequest`/`ApprovalAction` (`:9881-9929`) with `ApprovalStatus`/`ApprovalDecision`. `WorkflowModule.EXPENSE` and `LOAN` already exist (`:9830`).
- **`Grade`** (`schema.prisma:6478`, `rank Int` "ordering for comparisons/approvals") = the employee **LEVEL** for hotel/transport matrices. `Employee.gradeId` (`:6663`) links the person to it.
- **`Location`** (`schema.prisma:6400`, `city`/`stateCode`/`countryCode`) + `Employee.locationId`/`Employee.city` — the basis for **city-tier** classification.
- **`validateDocDataUrl`** (`documents.controller.js:80`) — 10MB cap + MIME allow-list (PDF/PNG/JPG) + server-side `sha256(buffer)`, no client-trusted mime/size. The receipt-upload validator, reused verbatim.
- **`s3.uploadDataUrl`** (`s3.js:85`, `ALLOWED_EXT` includes `application/pdf`) + inline-data-URL fallback when no bucket; `deleteByUrl`; `isOurUrl` SSRF allow-list.
- **`NumberSequence`** (`schema.prisma:9995`) + **`allocateCode`** (`codes.js:44`) — the atomic per-tenant code allocator (must run inside the parent insert's `$transaction`). Today the existing `nextClaimNumber` (`expenses.controller.js:49`) does a **non-atomic read-max-and-retry** — we migrate `EXP-` onto `allocateCode` and add a `TRV-` scope so both are race-safe.
- **`ExpenseClaim.payRunId`** (`schema.prisma:8160`) — the already-present payroll-settlement hook.

**Reuse with extension:**
- **`expenses.controller.js`** → **split** into `backend/src/hr/expenses/` (`claims.controller.js`, `trips.controller.js`, `policy.controller.js`, `categories.controller.js`, `meExpenses.controller.js`, `policyEngine.js`, `expenses.service.js`). The current `TRANSITIONS` state machine is **kept as the claim lifecycle** but `SUBMITTED → APPROVED/REJECTED` is now **driven by the approval engine** (the chain completing flips the status), not a direct `canManageEmployees` POST.
- **`ExpensePolicy`** (`schema.prisma:8118`) — **fold into** the new policy engine: keep `maxPerClaim`/`maxPerMonth`/`requireReceipt` as the **per-category** rule, add `dailyCap` + `monthlyCap` + `enforcement` (FLAG vs HARD). The new `TravelPolicy` references categories the same way.
- **`ExpenseClaim`** — add `travelRequestId` (nullable FK), `claimType` (`REIMBURSEMENT`/`TRAVEL`), `approvalRequestId`, `policyVerdict` (rollup), and **per-line policy verdict** on `ExpenseClaimLine` (`policyStatus`/`policyReason`/`appliedCap`). `claimNumber` migrates from the local generator to `allocateCode(scope:'EXP')`.
- **`ExpenseClaimLine`** (`schema.prisma:8172`) — add `categoryId`, `policyStatus`, `policyReason`, `appliedCap`, `transportMode`, `distanceKm`, `fileHash`, `mimeType`. Each bill is a line; the claim total is the sum of `OK`+`FLAGGED` lines.
- **`expenses.routes.js`** — keep the path shape; **swap `canManageEmployees` → scoped `canApproveExpense`** on approve/reject/reimburse, add the trip + policy routes, and add a `meExpenses.routes.js` ESS surface.

**Build net-new:**
- 3 Prisma models + 4 enums + field additions (§3): `TravelRequest`, `TravelPolicy` (+ embedded JSON sub-tables for per-diem/hotel/transport, or normalized `TravelPolicyRule` rows), `CityTier`; enums `TravelStatus`, `ClaimType`, `PolicyVerdict`, `TransportMode`.
- `backend/src/hr/expenses/policyEngine.js` (**build-new, pure**) — the validator: given a line + the employee's level + trip context + active policy, returns `{ verdict, appliedCap, reason }`. No I/O, fully unit-testable.
- `expenses.service.js` (**build-new**) — orchestrator: mint code (atomic), open the `ApprovalRequest`, evaluate policy, advance the lifecycle on chain completion, settle.
- hr-admin UX: **Travel & Expense Policy builder** (per-diem table, hotel matrix, transport rules, city-tier map), claims/trips register, approval inbox, settlement. ESS UX: **Apply for trip**, **My claims / submit bills**, live policy verdict.
- RBAC keys `canApproveExpense`, `canManageExpensePolicy` (additive JSON).

### Out of scope (deferred — explicit)
- Corporate-card feeds, OCR, FX, GST/ITC, GPS mileage, GDS booking, trip-advance tied to the loan ledger (see §1 non-goals). Model carries `receiptOcrJson`, `advanceAmount` for forward-compat; no engine in v1.

---

## 3. Data model (Prisma — additive, no breaking migration)

Insert near the existing expense block (`schema.prisma:~8195`). Conventions matched exactly: uuid PK; `businessId` + `business Business @relation(onDelete: Cascade)`; `entityId String?` where statutory; `createdAt`/`updatedAt`; `version Int @default(0)`; `deletedAt DateTime?` **on config models only** (`TravelPolicy`, `CityTier`). Claims/trips are financial records — **never soft-deleted past CANCELLED**; money is `Decimal(15,2)`, distances `Decimal(8,2)`.

### 3.1 Enums

```prisma
enum ClaimType {
  REIMBURSEMENT       // standalone out-of-pocket (no trip)
  TRAVEL              // bills booked against a TravelRequest (travel ID)
}

enum TravelStatus {
  DRAFT               // employee drafting the trip request
  SUBMITTED           // routed for pre-trip approval
  APPROVED            // trip green-lit; employee may add bills
  REJECTED
  IN_PROGRESS         // travel dates active (optional, derived)
  COMPLETED           // trip dates passed; claims may still settle
  CANCELLED
}

enum TransportMode {
  PUBLIC_TRANSPORT    // bus/metro/auto — receipt, cap
  SELF_CAR            // own vehicle — per-km × distance
  TAXI_CAB            // cab/ride-hail — receipt, cap
  TRAIN               // class gated by level
  FLIGHT              // gated by journey-duration / level
  OTHER
}

enum PolicyVerdict {
  OK                  // within policy
  FLAGGED             // over a soft limit — approver must decide
  AUTO_REJECTED       // over a hard cap — engine blocks
  NO_POLICY           // no active policy matched — passes, advisory note
}
```
(Existing `ExpenseClaimStatus` is **unchanged**.)

### 3.2 City-tier classification (config)

```prisma
model CityTier {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  tier        String   // "TIER_1" | "TIER_2" | "TIER_3" | tenant-custom label
  city        String   // normalized lower-cased match key
  stateCode   String?
  countryCode String   @db.Char(2)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  @@unique([businessId, countryCode, city])   // one tier per (tenant, country, city)
  @@index([businessId, tier])
}
```
Resolution: a trip's destination city (or the employee's `Location.city`) → `CityTier.tier`; unmatched cities fall to a policy `defaultTier`. IN seed: metros (Mumbai/Delhi/Bengaluru/Chennai/Kolkata/Hyderabad/Pune) = TIER_1, etc.

### 3.3 Travel & Expense policy (the custom engine config)

```prisma
model TravelPolicy {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId      String?                                  // optional per-legal-entity policy
  name          String
  countryCode   String   @db.Char(2)                     // IN / NZ — currency + defaults
  currencyCode  String   @db.Char(3)
  isActive      Boolean  @default(true)
  effectiveFrom DateTime @db.Date
  defaultTier   String   @default("TIER_3")              // fallback when city unmatched
  enforcement   PolicyEnforcement @default(FLAG)         // FLAG (soft) vs HARD (auto-reject over cap)
  // The three custom tables. Normalized child rows (preferred) so the admin
  // builder edits cells without JSON surgery; a denormalized snapshotJson is
  // also stored on each claim/line at validation time for audit immutability.
  perDiemRules  TravelPerDiemRule[]
  hotelRules    TravelHotelRule[]
  transportRules TravelTransportRule[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  version       Int      @default(0)
  @@index([businessId, isActive])
  @@index([businessId, entityId, countryCode])
}

// Per-diem caps by trip-duration band (24h full / 12h / half), food + incidentals,
// optionally varied by level (gradeRank) and city tier.
model TravelPerDiemRule {
  id            String   @id @default(uuid())
  businessId    String
  policyId      String
  policy        TravelPolicy @relation(fields: [policyId], references: [id], onDelete: Cascade)
  durationBand  PerDiemBand                              // FULL_24H | HALF_12H | HALF_DAY
  gradeRank     Int?                                     // null = applies to all levels
  cityTier      String?                                  // null = all tiers
  foodCap       Decimal  @db.Decimal(15, 2)
  incidentalCap Decimal  @db.Decimal(15, 2)
  @@index([businessId, policyId])
}

// Hotel budget by employee LEVEL (gradeRank) × city TIER — the core matrix.
model TravelHotelRule {
  id            String   @id @default(uuid())
  businessId    String
  policyId      String
  policy        TravelPolicy @relation(fields: [policyId], references: [id], onDelete: Cascade)
  gradeRank     Int                                      // employee level
  cityTier      String
  nightlyCap    Decimal  @db.Decimal(15, 2)
  @@unique([policyId, gradeRank, cityTier])
  @@index([businessId, policyId])
}

// Allowed transport modes + fare/eligibility conditions per level.
model TravelTransportRule {
  id            String   @id @default(uuid())
  businessId    String
  policyId      String
  policy        TravelPolicy @relation(fields: [policyId], references: [id], onDelete: Cascade)
  mode          TransportMode
  gradeRank     Int?                                     // null = all levels
  allowed       Boolean  @default(true)
  perKmRate     Decimal? @db.Decimal(8, 2)               // SELF_CAR: reimbursable per-km
  fareCap       Decimal? @db.Decimal(15, 2)              // per-journey ceiling (taxi/flight)
  travelClass   String?                                  // TRAIN: "AC_2T"/"AC_3T"; FLIGHT: "ECONOMY"
  minJourneyHrs Int?                                     // FLIGHT allowed only if journey >= N hrs
  conditionJson Json?                                    // extensible: {"minDistanceKm":250}
  @@unique([policyId, mode, gradeRank])
  @@index([businessId, policyId])
}

enum PolicyEnforcement { FLAG  HARD }
enum PerDiemBand { FULL_24H  HALF_12H  HALF_DAY }
```

### 3.4 Travel request (the trip / outdoor-duty record)

```prisma
model TravelRequest {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  travelNumber  String                                   // TRV-#### — the "travel ID"
  purpose       String
  isOutdoorDuty Boolean  @default(false)                 // local outdoor/official duty vs out-station travel
  originCity    String?
  destCity      String?
  destTier      String?                                  // snapshot of resolved CityTier at submit
  startAt       DateTime
  endAt         DateTime
  durationHours Int?                                     // derived → per-diem band
  estimateJson  Json?                                    // per-diem + hotel + transport estimate vs policy
  advanceAmount Decimal? @db.Decimal(15, 2)              // requested trip advance (netted at settlement)
  currencyCode  String   @db.Char(3)
  policyId      String?                                  // active TravelPolicy applied
  status        TravelStatus @default(DRAFT)
  approvalRequestId String?                              // pre-trip approval (EXPENSE workflow)
  submittedAt   DateTime?
  decidedAt     DateTime?
  decidedBy     String?
  rejectReason  String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)
  claims        ExpenseClaim[]
  @@unique([businessId, travelNumber])
  @@index([businessId, employeeId])
  @@index([businessId, status])
}
```

### 3.5 Field additions to existing models

```prisma
// ExpenseClaim — ADD:
  claimType         ClaimType @default(REIMBURSEMENT)
  travelRequestId   String?                              // links bills to the travel ID
  travelRequest     TravelRequest? @relation(fields: [travelRequestId], references: [id], onDelete: SetNull)
  approvalRequestId String?                              // the EXPENSE ApprovalRequest driving the chain
  policyVerdict     PolicyVerdict @default(NO_POLICY)    // rollup of the worst line verdict
  policyId          String?                              // active policy snapshot ref
  policySnapshotJson Json?                               // immutable copy of the rules applied at submit

// ExpenseClaimLine — ADD:
  categoryId        String?                              // per-line category (claim header categoryId stays optional)
  policyStatus      PolicyVerdict @default(NO_POLICY)
  policyReason      String?                              // human reason: "Hotel ₹6,500 > TIER_2 L3 cap ₹5,000"
  appliedCap        Decimal? @db.Decimal(15, 2)          // the cap the engine checked against
  transportMode     TransportMode?
  distanceKm        Decimal? @db.Decimal(8, 2)           // SELF_CAR
  fileHash          String?                              // sha256(receipt) — integrity anchor
  mimeType          String?
  receiptOcrJson    Json?                                // reserved (OCR deferred)

// ExpensePolicy (per-category) — ADD:
  dailyCap          Decimal? @db.Decimal(15, 2)
  enforcement       PolicyEnforcement @default(FLAG)
```
All additive — nullable / defaulted — so the migration is non-breaking and existing `EXP-` claims keep working (`claimType` defaults `REIMBURSEMENT`, `policyVerdict` defaults `NO_POLICY`).

### 3.6 Code scopes (`codes.js`)

Add to `SCOPE_DEFAULTS`: `EXP: { prefix: 'EXP-', padding: 4 }`, `TRV: { prefix: 'TRV-', padding: 4 }`. Migrate `create()` in `claims.controller.js` from the local `nextClaimNumber` read-max loop onto `allocateCode(tx, { businessId, scope: 'EXP' })` inside the create transaction (atomic, race-safe, drops the bespoke retry).

---

## 4. The policy engine (`policyEngine.js` — pure, build-new)

A single pure function — no DB, fully unit-testable — mirroring the `scopeResolver`/`approvalRouting` chokepoint pattern:

```
evaluateLine(line, ctx) -> { verdict, appliedCap, reason }
  ctx = { policy (with rules), gradeRank, cityTier, durationBand, journeyHours, distanceKm }
```

Rules, in order, by category/kind of the line:

- **Per-diem (food / incidentals):** pick the `TravelPerDiemRule` matching `(durationBand, gradeRank?, cityTier?)` — most specific wins; sum `foodCap`+`incidentalCap` for the band. Over → `FLAGGED`/`AUTO_REJECTED` per `policy.enforcement`.
- **Hotel:** look up `TravelHotelRule[gradeRank][cityTier]` → `nightlyCap × nights`. `appliedCap` = that product; over → flag/reject.
- **Transport:**
  - `SELF_CAR`: reimbursable = `perKmRate × distanceKm`; claimed over computed → flag.
  - `FLIGHT`: if `journeyHours < minJourneyHrs` (or `allowed:false` for the level) → `AUTO_REJECTED` ("flight not permitted for a <N h journey at level L<rank>"); else cap at `fareCap`.
  - `TRAIN`: class above the level's `travelClass` → flag; cap at `fareCap`.
  - `PUBLIC_TRANSPORT`/`TAXI_CAB`: cap at `fareCap` when set.
  - `allowed:false` → `AUTO_REJECTED` regardless.
- **Per-category** (the folded `ExpensePolicy`): `maxPerClaim`/`dailyCap`/`maxPerMonth` (monthly needs the running sum — computed in the service, passed in via `ctx.monthToDateByCategory`). `requireReceipt` with no `receiptUrl` → `FLAGGED` ("receipt required").
- **No matching rule** → `NO_POLICY` (passes; advisory). **`appliedCap`/`reason` always populated** so the approver and the employee see *why*.

The **claim rollup** `policyVerdict` = worst line verdict (`AUTO_REJECTED` > `FLAGGED` > `OK` > `NO_POLICY`). On submit, the service snapshots the matched rules into `policySnapshotJson`/per-line so a later policy edit can never retroactively change a settled claim's verdict (immutability, like the FnF `fnfSnapshotJson` pattern).

**Enforcement coupling:** `HARD` → an `AUTO_REJECTED` line blocks `submit` (400 with the reason) so over-cap bills never reach an approver. `FLAG` → submit succeeds, but the approver inbox surfaces every `FLAGGED`/`AUTO_REJECTED` line in red and the approver must explicitly acknowledge to approve.

---

## 5. API surface (RBAC + scope)

All under `/api/hr/expenses` (operator) and `/api/hr/me/expenses` (ESS). `protect` everywhere. **Scope is applied on every operator read/write** via `resolveAccessibleEmployeeIds` + `scopeWhere('employeeId')` — the gap the current controller has.

### 5.1 Operator — policy & config (`canManageExpensePolicy`)
| Method | Path | Purpose |
|---|---|---|
| GET/POST/PATCH/DELETE | `/policies` , `/policies/:id` | CRUD `TravelPolicy` (+ nested per-diem/hotel/transport rules) |
| PUT | `/policies/:id/perdiem` · `/hotel` · `/transport` | bulk-replace a rule table (the matrix editor saves the whole grid) |
| GET/POST/PATCH/DELETE | `/city-tiers` | `CityTier` map CRUD + CSV import |
| GET/POST/PATCH/DELETE | `/categories` | existing category CRUD (**reuse**, now `canManageExpensePolicy`) |
| GET/POST | `/workflows?module=EXPENSE` | bind/list the `WorkflowDefinition` chain for claims/trips (the approval engine) |

### 5.2 Operator — claims & trips
| Method | Path | RBAC | Scope |
|---|---|---|---|
| GET | `/claims` , `/claims/:id` | `canViewEmployees` | `scopeWhere('employeeId')` |
| GET | `/trips` , `/trips/:id` | `canViewEmployees` | scoped |
| POST | `/claims/:id/approve` · `/reject` · `/return` | `canApproveExpense` | `scopeAllows` + **SoD: approver ≠ requester** + must be the current step's approver |
| POST | `/trips/:id/approve` · `/reject` | `canApproveExpense` | scoped + SoD |
| POST | `/claims/:id/reimburse` | `canApproveExpense` (Finance) | scoped; sets `paymentRef`/`payRunId` |
| GET | `/inbox` | `canApproveExpense` | pending `ApprovalRequest`s where the actor is the current-step approver, in scope |

Approve/reject **do not** flip status directly: they record an `ApprovalAction`; the **engine** advances `currentStepOrder` and, when the terminal step approves, the service flips the `ExpenseClaim`/`TravelRequest` status (`SUBMITTED → APPROVED`). A `REJECTED` action short-circuits to `REJECTED`. `return` = `REQUESTED_CHANGES` → back to `DRAFT` for the employee to fix bills.

### 5.3 ESS — self-service (`apps/ess`, USER session, SELF band — `meExpenses.routes.js`, build-new)
| Method | Path | Purpose |
|---|---|---|
| GET/POST/PATCH | `/me/expenses/claims` , `/:id` | list/create/edit own DRAFT claims |
| POST | `/me/expenses/claims/:id/lines` | add a bill line (+ receipt data URL) — **returns the live policy verdict** |
| DELETE | `/me/expenses/claims/:id/lines/:lineId` | remove a DRAFT line |
| POST | `/me/expenses/claims/:id/submit` | submit → opens the `ApprovalRequest` (blocked if HARD + over-cap line) |
| POST | `/me/expenses/claims/:id/cancel` | withdraw |
| GET/POST | `/me/expenses/trips` | list / **apply for outdoor duty / travel** → mints `TRV-####` |
| POST | `/me/expenses/trips/:id/submit` | route the trip for pre-trip approval |
| GET | `/me/expenses/policy/preview` | dry-run the engine for a draft line (live "within / over budget" badge) |

**ESS hard rule (verified pattern):** every `/me/*` handler resolves the subject from the **session's `employeeId`**, never a body/param id (self-only) — and a terminated employee is locked out (the F4 ESS-lockout pattern). A USER may only ever see/act on their own claims and trips.

---

## 6. hr-admin + ESS UX (plain language)

### 6.1 hr-admin — "Travel & Expense Policy" builder (the centerpiece)
A non-technical admin opens **Settings → Travel & Expense Policy** and sees four tabs, each a plain table:

1. **Per-diem** — rows for *Full day (24h)*, *Half (12h)*, *Half-day*; columns *Food cap* and *Incidentals cap*. Optional "vary by level / city tier" toggle reveals extra columns. "These are the daily allowances for meals and small expenses while travelling."
2. **Hotel budget** — a grid: rows = **employee levels** (pulled from `Grade`, shown by name + rank), columns = **city tiers** (Tier 1 / 2 / 3). Each cell = nightly cap. "How much per night each level can spend in each kind of city."
3. **Transport** — a card per mode (Public transport, Self car, Taxi, Train, Flight). Each: *Allowed?* toggle, *per-km rate* (self-car), *fare cap*, *class* (train/flight), and the eligibility line *"Flight allowed only if the journey is at least ___ hours"* / *"Train class by level."*
4. **City tiers** — assign cities to Tier 1/2/3 (search + CSV import); set the default tier for anything unlisted.

A final **Enforcement** switch: *"Flag over-budget bills for the approver to decide"* (FLAG) vs *"Automatically reject bills over the hard cap"* (HARD). Plus an **Approval chain** picker that maps to the `WorkflowDefinition` (e.g. *Manager → Finance*, with *"Finance only above ₹25,000"* as the amount condition). Seeded IN + NZ defaults so a 3-person tenant is productive in minutes.

### 6.2 hr-admin — approvals & register
- **Approvals inbox:** cards of pending trips/claims **in the manager's F1 sub-tree**, each showing claim/travel ID, employee, total, and a **policy banner** (green "Within policy" / amber "2 lines over budget"). Expanding shows each line with receipt thumbnail, claimed vs cap, and the reason. Buttons: *Approve* / *Reject (reason)* / *Return for changes*. Approve is disabled until flagged lines are acknowledged.
- **Register:** filterable table (status, employee, type, date, policy verdict). Finance can bulk **Mark reimbursed** (payment ref) or **Push to payroll** (sets `payRunId`).

### 6.3 ESS — apply & claim
- **Apply for outdoor duty / travel:** purpose, dates, from/to city, "local outdoor duty?" toggle, optional advance. On submit the app shows the **travel ID (TRV-####)** and an **estimate vs policy** ("Hotel 2 nights in Mumbai (Tier 1), your level: within budget"). Routed for approval.
- **My claims → add bills:** pick the trip (or "no trip — standalone reimbursement"), then per bill: category, amount, date, transport mode/distance if travel, upload receipt. The moment a line is added, a **live badge** says *Within budget* / *Over by ₹X — will be flagged* / *Not allowed (hard cap)*. Submit is blocked on a hard-cap line with a clear message.
- **Status timeline:** Draft → Submitted → (Manager approved) → (Finance approved) → Reimbursed, with who/when and any return-for-changes note — same visual language as the leave/letters timelines.

---

## 7. Build plan (5 slices)

**Slice 11a — Module split + scope/SoD hardening + atomic codes (no new feature, pure correctness).**
Promote `expenses.controller.js` → `backend/src/hr/expenses/` (claims/categories controllers + `expenses.service.js`). Add F1 scope (`resolveAccessibleEmployeeIds` + `scopeWhere('employeeId')`) to every list/get/action; out-of-scope ⇒ 404. Add `canApproveExpense`/`canManageExpensePolicy` to `rbac.js` (HR-Admin gets policy; Finance + Manager get approve; Manager approve is **TEAM-scoped + SoD** so a manager can't approve their own). Migrate `EXP-` to `allocateCode`. Tests: scope leak, SoD self-approval block, atomic-code race.

**Slice 11b — Approval-engine wiring.**
Replace the direct `approve/reject` status flips with `ApprovalRequest`/`ApprovalAction` for `module: EXPENSE`. Build `expenses.service.openApproval()` (resolve chain from `WorkflowDefinition` + `resolveApprover`, honour `conditionJson` amount tiers, `isParallel`/`minApprovals`/SLA) and `recordDecision()` (advance step, flip claim status on terminal approve/any reject). `/inbox` endpoint. Tests: 2-step manager→finance, amount-tiered skip, parallel min-approvals, reject short-circuit, SLA escalate.

**Slice 11c — Policy data model + `policyEngine.js`.**
Add the `TravelPolicy`/per-diem/hotel/transport/`CityTier` models + enums + `ExpenseClaim`/`Line` field additions (migration). Build the pure `policyEngine.evaluateLine` + claim rollup + snapshot-on-submit. Policy CRUD controllers (`canManageExpensePolicy`) + the bulk grid-save endpoints. Seed IN/NZ defaults. Tests: each rule path (per-diem band, hotel level×tier, flight min-hours reject, self-car per-km, monthly cap), FLAG vs HARD, snapshot immutability.

**Slice 11d — Travel requests (trip + bills against travel ID).**
`TravelRequest` CRUD + `TRV-` code + pre-trip approval (reuses 11b engine, sub-type TRAVEL) + estimate computation. Link `ExpenseClaimLine` bills to a `travelRequestId`; line-level receipt upload via `validateDocDataUrl` + `s3.uploadDataUrl` (inline fallback) with server-side `fileHash`. Tests: trip→travel ID→approve→add bills→policy-validated, terminated-employee lockout, receipt MIME/size guards.

**Slice 11e — ESS surface + live verdict.**
`meExpenses.routes.js` + `meExpenses.controller.js` (self-only, terminated-lockout). Apply-for-trip, my-claims, add-line-with-live-verdict, `/policy/preview` dry-run, submit (HARD block). `apps/ess` pages. Tests: self-only enforcement (no cross-employee id), live verdict matches engine, HARD submit block.

**Slice 11f — hr-admin UX + settlement.**
Policy builder (4 tabs + enforcement + chain picker), approvals inbox with policy banner, register, Finance **Mark reimbursed / Push to payroll** (`payRunId`, reuse the loan-recovery component pattern). `apps/hr-admin` pages. End-to-end + RBAC matrix tests.

*(11a+11b can land together as the "correctness + engine" half; 11c–11f are the feature build. 5–6 slices total.)*

---

## 8. Security, edge cases & invariants

- **Tenant isolation:** every query carries `businessId` (already the controller norm); every FK (`travelRequestId`, `categoryId`, `policyId`) is re-validated as belonging to the tenant before use, exactly as `create()` re-checks `employeeId`/`categoryId` today.
- **F1 scope is the headline fix:** today approve/reject/reimburse are *only* `canManageEmployees` with no scope — any operator can action any tenant claim. v1 enforces `scopeWhere('employeeId')` on reads and `scopeAllows` on `/:id` actions; out-of-scope ⇒ 404 (no existence leak).
- **Maker-checker SoD:** the requester (`employeeId`'s user) can never be a checker on their own claim/trip; a manager who is the subject is dropped from the approval scope (the `APPROVAL_ACTIONS` self-exclusion pattern). Approve fails closed when the actor isn't the current step's resolved approver.
- **Policy immutability:** rules are snapshotted onto the claim/line at submit (`policySnapshotJson`); editing or deactivating a `TravelPolicy` never retroactively changes an in-flight or settled claim's verdict.
- **HARD enforcement is server-side:** the `AUTO_REJECTED` submit block is enforced in `expenses.service.submit`, not the UI — a crafted API call still can't push an over-hard-cap bill into the chain.
- **Receipt uploads:** `validateDocDataUrl` (10MB cap, PDF/PNG/JPG only, server-computed `sha256`, no client-trusted mime/size); `s3.isOurUrl` SSRF allow-list on any stored URL; inline-data-URL fallback when no bucket (`receiptUrl` already nullable). `requireReceipt` policy flags missing receipts.
- **Money:** all amounts stay Prisma `Decimal` and are passed through untouched (the existing "never parse money" rule); policy math is done on `Decimal`, comparisons explicit. Per-line `currencyCode`; a claim is single-currency (mixed → 400 on submit).
- **Race safety:** codes via `allocateCode` inside the insert tx (atomic) — replaces the read-max `nextClaimNumber` loop; concurrent approvals on the same step guarded by `version` optimistic-lock + the `WorkflowStep` `@@unique(stepOrder)`.
- **Edge cases:** trip with no matching policy → `NO_POLICY` (passes, advisory, never silently blocks); city unmatched → `defaultTier`; employee with no `gradeId` → policy falls to the all-levels (`gradeRank: null`) rules or `NO_POLICY`; trip cancelled with attached claims → claims revert to standalone `REIMBURSEMENT` (FK `SetNull`) rather than orphan; reject/return mid-chain → claim back to `DRAFT`, lines editable again; monthly cap straddling a settled+draft claim uses month-to-date sum at submit time.
- **Audit:** every state change + approval action writes through the existing audit path; `ApprovalAction` rows are the immutable decision log (who/when/comment/decision), retained on the request.

---

## 9. Reuse ledger (anchors)

| Need | Reuse | Anchor |
|---|---|---|
| Claim lifecycle + `EXP-####` | extend `expenses.controller.js` | `:33-57`, `:233-281` |
| Per-category policy seed | fold `ExpensePolicy` | `schema.prisma:8118` |
| Approval engine (Feature-10) | `WorkflowDefinition`/`Step` + `ApprovalRequest`/`Action` | `schema.prisma:9813-9934` |
| Manager→escalate→HR routing | `resolveApprover` | `approvalRouting.js:66` |
| F1 data scope | `resolveAccessibleEmployeeIds`/`scopeWhere`/`scopeAllows` | `scopeResolver.js:39,96,103` |
| Employee LEVEL | `Grade.rank` + `Employee.gradeId` | `schema.prisma:6484,6663` |
| City tier basis | `Location.city`/`Employee.city` | `schema.prisma:6409,6550` |
| Receipt validate + hash | `validateDocDataUrl` | `documents.controller.js:80` |
| Receipt store | `s3.uploadDataUrl`/`isOurUrl` | `s3.js:85,118` |
| Atomic codes | `allocateCode` + `SCOPE_DEFAULTS` | `codes.js:19,44` |
| Payroll settlement hook | `ExpenseClaim.payRunId` | `schema.prisma:8160` |
| RBAC keys/presets | `rbac.js` `PERMISSIONS`/`SYSTEM_ROLES` | `rbac.js:11,57` |
```

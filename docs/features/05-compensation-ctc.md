# Feature 05 — Compensation & CTC

> **Status:** spec / dev contract · **Module:** `backend/src/hr/compensation/` (new lib) + `backend/src/hr/controllers/compensation.controller.js` (harden) · **Apps:** `apps/hr-admin`, `apps/ess`
> **Markets:** India + New Zealand · **Builds on:** F1 RBAC/hierarchy (`rbac.js`, `scopeResolver.js`, `scope.middleware.js`), Payroll engine (`payroll/engine.js`, `payroll/money.js`, `payroll/service.js`), F4 Lifecycle (provisioning `provision.js`, built-in e-sign `lifecycle/esign/builtin.js`)
> **Author note:** every schema field / RBAC key / file path / line number below was verified against the live tree on 2026-06-23. Where the existing code is wrong, it is flagged as a **bug to fix**, not reused.

---

## 1. Summary & goals

The compensation domain is **already deeply modeled and wired into payroll**. The schema carries every noun — `SalaryComponent` (pay-head master with the full statutory flag set), `SalaryStructure` + `SalaryComponentLine` (reusable templates), `CompensationRevision` (append-only, effective-dated assigned pay) — at `schema.prisma:6764–6963`. The payroll engine consumes them through a **pure mapping layer** (`service.js:128/233/565`) into `engine.computePayslip` (`engine.js:109`), and the engine already implements the **BALANCING residual** (`evalBalancing`, `engine.js:538`) in integer minor units via `payroll/money.js`. Three of the four wage-rule guards (offer, provisioning, FnF) already reuse the canonical engine-backed `computeStatutoryWages`.

**What is broken or missing** clusters in three places:

1. **CORRECTNESS BUG (highest value):** provisioning creates a `CompensationRevision(HIRE)` with a `structureId` but **zero `SalaryComponentLine` children** (`provision.js:542–554`; grep confirms **no** `salaryComponentLine.create` anywhere in `lifecycle/`). The engine reads `compensation.lines` → finds none → `componentsForEngine=[]` → **every provisioned hire computes zero gross**; and `offboarding.resolveLastDrawnPay` reads the same empty `lines` → **Basic+DA=0 → gratuity/encashment=0**. There is no structure→revision **materializer**.
2. **Frontend is non-functional for writes:** `apps/hr-admin/app/compensation/page.js` posts the wrong field shapes (revision draft sends `reason`, API requires `revisionReason` — `page.js:90` vs `compensation.controller.js:274`; components/structures forms omit required `kind`/`category`/`calcMethod` / `entityId`/`countryCode`/`currencyCode`/`basis`) and has **no nested-line editor** anywhere — so even a successful create carries zero lines. Reads work; writes 400 or persist empty.
3. **No CTC/cost surface, no derivation, no workflow:** there is no target-CTC → component-amounts reverse-derivation, no CTC/total-cost view, no revision approval (the `approvalRequestId` field is unused), no field-level salary masking (visibility is all-or-nothing by permission), and `validateWages50` (`compensation.controller.js:54`) is a **4th, inconsistent** guard implementation (fail-open, float math) vs the engine-backed fail-closed one used everywhere else.

**Goals (v1):**
1. **Make provisioned/assigned pay actually compute.** Ship a pure `materializeRevisionLines(structure, target) → SalaryComponentLine[]` so revisions carry resolved lines; wire it into `provision.js` STEP 8 and every assignment path.
2. **One pure CTC-derivation engine** (`deriveBreakup`) — target (CTC | gross | net) → per-component monthly/annual amounts incl. the BALANCING special allowance, India-50%-floor-aware, employer-cost fixed point for IN CTC-basis — testable like the payroll engine and **golden-tested to equal `engine.computePayslip` to the paise**.
3. **Structure builder + nested-line editor + live CTC↔gross↔net preview** in hr-admin (the centerpiece), backed by a pure **`POST /structures/preview`** endpoint that wraps the engine.
4. **Revision/increment workflow:** effective-dated, **maker-checker SoD** (reuse the fail-closed pattern), reverse-derive from a target, arrears → next payroll via `ComponentKind.ARREAR`, increment letters via the F4 e-sign chain.
5. **Field-level salary masking on every comp read:** the intersection of permission (`canViewCompensation`) + F1 scope band (ALL/TEAM/SELF) + a visibility level — a manager without the grant gets **`200` with a `RANGE` envelope**, never a 403; absolute money is **omitted server-side**, not blurred client-side. ESS sees self only.
6. **Consolidate the 50% guard** onto the engine-backed `computeStatutoryWages` (fail-closed, integer paise, effective-dated) and add a minimum-wage Basic floor.

**Non-goals (v1):** multi-currency comp conversion (each entity runs in its own `currencyCode`; group roll-up converts at a snapshotted "indicative" rate only); advanced banding analytics beyond compa-ratio / range-penetration; net→gross gross-up for expat net-guarantees (spec'd, deferred); the FORMULA/SLAB calc methods on custom components (engine drops them today — keep declaring, don't build the editor); row-level scope on payroll reports (comp is the scoped surface this feature ships).

---

## 2. Scope

### In scope (v1 — pragmatic, reuse-first)

- **Reuse as-is (production-grade, do not rebuild):**
  - **Schema models** `SalaryComponent` / `SalaryStructure` / `SalaryComponentLine` / `CompensationRevision` and all comp enums — `ComponentKind` (incl. **`ARREAR`**, verified present, `schema.prisma:6814`), `ComponentCategory`, `ComponentCalcMethod` (FLAT/PERCENT_OF/FORMULA/SLAB/STATUTORY/**BALANCING**), `ComponentBaseScope` (SINGLE/MULTIPLE/GROSS/CTC), `ProrationMethod`, `StructureBasis` (CTC/GROSS/NET), `CompRevisionReason`.
  - **The engine consumption contract:** `resolveCurrentCompensation` (`service.js:565`) → `buildEmployeePayInput(rows)` (`service.js:233`) → `mapComponentLine` (`service.js:128`) → `computePayslip` (`engine.js:109`), with `resolveBalancingTarget` (`service.js:202`) and `evalBalancing` (`engine.js:538`). The derivation lib **feeds** this contract and is golden-tested against it.
  - **Integer-minor-unit money** (`payroll/money.js` — `toMinor`/`fromMinor`/`sumMinor`/`clampMinor`/residual allocator). Never `parseInt` a Decimal (the controller already honors this, `compensation.controller.js:34`).
  - **F1 access:** `requirePermission`, `effectiveScope` (ALL/TEAM/SELF bands, `scopeResolver.js`), `withEmployeeScope(action,{idParam})` and `attachSelfEmployee` (`backend/src/hr/middleware/scope.middleware.js:33/15`, exports line 50) — the IDOR-safe 404 guard, reused verbatim on per-employee comp routes.
  - **F4 built-in e-sign** `createEnvelope(input, prisma)` (`lifecycle/esign/builtin.js:167`, exported 445) for increment letters — same SHA-256 audit-chain / sequential-signer / HMAC-cert path as offer/FnF letters. No new e-sign code.
  - **Audit** `writeAudit` (already called on comp write, `compensation.controller.js`).
- **Fix-before-reuse (real bugs / inconsistencies, verified):**
  - **`provision.js` STEP 8** writes `compensationRevision.create` with **no `lines`** (`provision.js:542–554`) → engine sees empty `lines` → **zero gross for every hire** + FnF gratuity=0. **Fix:** materialize lines from `offer.structureId` (the offer lines are already read at `provision.js:163` for the Basic+DA check — reuse that read) into the revision in the same transaction.
  - **`validateWages50`** (`compensation.controller.js:54–70`) is **fail-open** (line 68: no earnings / gross≤0 → `ok:true`) and uses **float** `gross*0.5`, inconsistent with the engine-backed `computeStatutoryWages` (fail-closed, integer paise, effective-dated) used by `offerWageCheck` / `provision.resolveBasicDaMonthly` / FnF. **Replace** with the canonical guard + a min-wage Basic floor.
  - **`apps/hr-admin/app/compensation/page.js`** posts wrong field shapes and has no line editor (§1.2 above). **Rebuild** the console; the revisions API already accepts nested `lines` (`compensation.controller.js:288+`), so revisions are a pure UI gap.
- **Build net-new:**
  - `backend/src/hr/compensation/deriveBreakup.js` — pure CTC/gross/net derivation + employer-cost fixed point + materializer (the single highest-value piece).
  - `POST /structures/preview` (pure, no persistence), `/me/compensation` (self), grades/bands assignment, increment cycles, revision approval + letters endpoints.
  - `compVisibility` on the role + the `maskCompensation` response shaper + `compensation.read` audit.
  - hr-admin structure builder / revision drawer / cycle worksheet / comp dashboard; ESS `compensation` page (CTC breakup waterfall + history + letters).

### Out of scope (deferred, explicitly)

- Multi-currency comp conversion in payroll (each entity is single-currency; a revision **cannot** change currency in place — that corrupts arrears math; currency change = new structure assignment / rehire-style transition). Group CTC roll-up shows an "indicative" snapshotted rate only.
- Net→gross gross-up solver (basis=NET) — model the field, defer the marginal-rate inversion.
- FORMULA/SLAB **custom** component editor (engine drops `STATUTORY`/`SLAB` lines today — statutory pay-heads stay owned by `payroll/compliance/india.js` + `newzealand.js`).
- Manager-sees-team on **payroll** reports (`payroll.routes.js` stays all-or-nothing by `canViewPayrollReports`); only the comp surface gets row-scope this feature.
- Vendor e-sign adapters (inherited deferral from F4).

---

## 3. Data model changes (Prisma — minimal, additive)

All money stays `Decimal(15,2)`; days `Decimal(8,4)`. Nothing below renames or drops an existing column; historical pay runs replay identically.

### 3.1 Existing models — reuse + small additive fields

**`SalaryComponent`** (`schema.prisma:6764`) — already carries `kind`/`category`/`calcMethod`/`calcBaseCode`/`calcBaseScope`, the full statutory flag set (`isWageForPF/ESI/PT/Gratuity`, `isTaxable`, `taxSection`, `isKiwiSaverable`, `isPayeable`), `prorationMethod`, `isRecurring`, `@@unique([businessId, code])`. **Add (all optional, additive):**

| Field | Type | Purpose |
|---|---|---|
| `derivationPass` | `Int @default(0)` | Explicit topo pass (0=FLAT, 1=PERCENT_OF literal base, 2=PERCENT_OF GROSS/CTC, 3=BALANCING) — mirrors the engine's 3 passes; lets the derivation lib order without a graph solve and rejects cycles at save time. |
| `floorValue` / `capValue` | `Decimal? @db.Decimal(15,2)` | Per-component clamp → engine `floorMinor/capMinor` (`money.clampMinor`). |
| `minWageFloorApplies` | `Boolean @default(false)` | This component counts toward the IN state minimum-wage / NZ minimum-wage Basic floor. |

(`frequency`/`roundingRule`/`dependsOnCodes` from the design are **deferred** — `isRecurring` + `sortOrder` cover v1; revisit when LTA/bonus cadence ships.)

**`SalaryStructure`** (`schema.prisma:6871`) — `entityId`, `countryCode`, `currencyCode`, `basis`, `lines[]`, `@@unique([businessId, entityId, code])`. **No change.** Assignment-by-grade is deferred to a thin rule (below) — v1 assigns a structure to an employee by writing a revision, not a template rule.

**`SalaryComponentLine`** (`schema.prisma:6899`) — dual-parent (`structureId` **or** `compensationId`), `calcMethod` override, `calcValue`, `amountMonthly`, `amountAnnual`, `sortOrder`. **No change** — the materializer writes these onto the revision.

**`CompensationRevision`** (`schema.prisma:6925`) — append-only, `basis`/`ctcAnnual`/`grossMonthly`/`effectiveFrom`/`effectiveTo`/`isCurrent`/`revisionReason`/`approvalRequestId`/`structureId`/`lines[]`, `@@unique([employeeId, effectiveFrom])`. **Add (additive):**

| Field | Type | Purpose |
|---|---|---|
| `status` | `enum CompRevisionStatus @default(EFFECTIVE)` | `DRAFT \| PROPOSED \| APPROVED \| EFFECTIVE \| REJECTED \| WITHDRAWN`. Default `EFFECTIVE` keeps the existing direct-write path (provisioning HIRE, programmatic) valid; the UI maker-checker path uses PROPOSED→APPROVED→EFFECTIVE. |
| `proposedById` / `approvedById` | `String?` | SoD: `approvedById != proposedById` enforced in the commit transaction. |
| `approvedAt` | `DateTime?` | Audit. |
| `letterEnvelopeId` | `String?` | FK to the F4 `SignatureEnvelope` for the increment letter. |
| `cycleId` | `String?` | Links a revision committed via a bulk cycle. |
| `sourcePeriodCode` | `String?` | For ARREAR provenance when the revision is back-dated. |

**`Grade`** (`schema.prisma:6458`) already has `minSalary`/`maxSalary`/`currencyCode`/`bandId`/`rank`; **`Band`** (`schema.prisma:6482`) and **`Designation.gradeId`** (`schema.prisma:6438`) exist but **no guard consumes the range** today. v1 **consumes the existing `Grade.minSalary/maxSalary`** for compa-ratio / range-penetration / out-of-band flags — **no new PayGrade model** (reuse what's there; add a `midSalary Decimal?` to `Grade` if mid is wanted for compa-ratio, else derive mid=(min+max)/2).

### 3.2 New models (thin)

```prisma
enum CompRevisionStatus { DRAFT PROPOSED APPROVED EFFECTIVE REJECTED WITHDRAWN }

model IncrementCycle {
  id            String   @id @default(uuid())
  businessId    String
  name          String
  type          IncrementCycleType         // MERIT | PROMOTION | MARKET | COLA
  effectiveDate DateTime @db.Date
  budgetMinor   BigInt?                     // optional pool, integer minor units
  status        IncrementCycleStatus @default(OPEN)  // OPEN | LOCKED | CLOSED
  createdById   String
  createdAt     DateTime @default(now())
  proposals     IncrementProposal[]
  @@index([businessId, status])
}

model IncrementProposal {
  id               String   @id @default(uuid())
  businessId       String
  cycleId          String
  employeeId       String
  proposedById     String
  currentCtcMinor  BigInt?
  proposedCtcMinor BigInt?
  pctHike          Decimal? @db.Decimal(8,4)
  justification    String?
  status           ProposalStatus @default(DRAFT)   // DRAFT | SUBMITTED | APPROVED | REJECTED
  revisionId       String?                          // set on commit
  @@unique([cycleId, employeeId])
  @@index([businessId, cycleId])
}

enum IncrementCycleType   { MERIT PROMOTION MARKET COLA }
enum IncrementCycleStatus { OPEN LOCKED CLOSED }
enum ProposalStatus       { DRAFT SUBMITTED APPROVED REJECTED }
```

A `StructureAssignmentRule` (grade/designation → structure auto-resolution) is **deferred** — v1 assigns explicitly per employee. One migration under `backend/prisma/migrations/`; all additions nullable/defaulted so it is a non-breaking deploy.

### 3.3 RBAC additions (`backend/src/core/lib/rbac.js`)

Existing keys confirmed at `rbac.js:15–16` (`canViewCompensation` "View salary/CTC of others", `canManageCompensation` "Edit pay structures + revisions"). Owner/HR-Admin have both; Finance has view; **Manager preset has neither** (verified). **Add:**

| Key | Meaning | Presets |
|---|---|---|
| `canProposeCompensation` | Draft increment proposals for own team (maker, manager-level) | Manager: **on**; HR-Admin/Owner: on |
| `canApproveCompensation` | Checker for revisions/cycles (distinct from maker `canManageCompensation`) | Finance: on; Owner: on; HR-Admin: **off by default** so SoD holds |

Plus a **`compVisibility`** enum field on the BusinessRole: `ABSOLUTE | RANGE_ONLY | SELF_ONLY | NONE`. Manager-with-grant defaults `RANGE_ONLY`; HR/Finance/Owner `ABSOLUTE`; Employee `SELF_ONLY`; Manager-no-grant `NONE`. **SoD invariant (fail-closed):** the approve endpoint rejects `approver.id === revision.proposedById` → `409 SOD_SELF_APPROVAL`, mirroring the F4 lifecycle pattern.

---

## 4. Backend

### 4.1 The pure CTC-derivation lib — `backend/src/hr/compensation/deriveBreakup.js` (NEW)

Pure, no DB/IO, all arithmetic in **integer minor units** via `payroll/money.js`. Mirrors and is golden-tested against `engine.evalBalancing`.

**`deriveBreakup({ target, basis, lines, ctx }) → { resolved[], gross, net, employerCost, wagesVerdict }`**

```
// target & lines in minor units; lines ordered by derivationPass then sortOrder
1. Split target → targetGrossMinor:
   basis=CTC (IN): targetGross = CTC − employerCost      // employerCost via §4.2 fixed point
   basis=GROSS (NZ): targetGross = grossMonthly*12 (or as given)
   basis=NET: invert deductions via engine (DEFERRED in v1 → reject UNSUPPORTED_NET_BASIS)
2. Pass 0 — FLAT earnings:        resolved[code] = clamp(calcValue, floor, cap)
3. Pass 1 — PERCENT_OF literal:   base = resolved[calcBaseCode];   amt = pct/100 * base
   (Basic itself: PERCENT_OF CTC per tenant policy, resolved here once CTC known)
4. Pass 2 — PERCENT_OF GROSS/CTC: base = (scope==GROSS ? targetGross : CTC)
5. Pass 3 — BALANCING (exactly one): special = max(0, targetGross − Σ(other earnings))
6. Residual distribution: drift = targetGross − Σ(earnings);
   if drift!=0 && special>0: special += drift     // money.js residual allocator → Σ==target to the paise
7. If Σ(non-balancing earnings) > targetGross → reject STRUCTURE_INFEASIBLE (never silently zero)
8. wagesVerdict = computeStatutoryWages(resolved, effectiveDate)   // §4.4, country-gated
```

**`materializeRevisionLines(structure, target, ctx) → SalaryComponentLineCreate[]`** — runs `deriveBreakup` and emits line `create` rows (`calcMethod`, `calcValue`, `amountMonthly`, `amountAnnual`, `sortOrder`, `componentId`) ready to nest under a `CompensationRevision`. **This is wired into `provision.js` STEP 8** (the bug fix) and every assignment/revision/cycle-commit path. Rounds **once per component**; the BALANCING line absorbs the residual so the structure reconciles exactly.

**Acceptance:** quoting a structure via `deriveBreakup` and then replaying that revision through `engine.computePayslip` must produce **identical** earnings/gross/net/employer-cost (golden test `deriveBreakup ⇆ engine` parity).

### 4.2 Employer-cost fixed point (IN CTC-basis)

For IN, employer PF (~13% incl. EPS/EDLI/admin) is a function of PF-wages → Basic → CTC, and gross = CTC − employerCost. Bounded fixed-point iteration (≤3 passes; PF ceiling bounds it):

```
employerCost₀ = 0
repeat:
  targetGross = CTC − employerCostₙ
  basic       = max(policyPct × CTC, 0.50 × statutoryWageBase, minWageFloor)   // §4.4
  // the ENGINE owns the actual statutory amounts (₹15,000 PF ceiling, ₹1,800 EE cap) —
  // this loop only QUOTES employer cost for the breakup; runtime defers to engine.
  employerCostₙ₊₁ = employerPF(basic) + ESIer + gratuityProvision(basic)
until |Δ| < 1 minor unit
```

The engine remains the runtime authority; the fixed point is quote-time only and is validated by the §4.1 replay parity. NZ (basis=GROSS) needs no fixed point — KiwiSaver-er 3% + ESCT are reported **on top** of the gross, never folded into the headline.

### 4.3 Revision / increment service (harden `compensation.controller.js` + new endpoints)

- **`revisions.create`** stays append-only (supersede prior: close `effectiveTo` to day-before, flip `isCurrent`) but gains the **status machine + SoD**. The maker writes `status=PROPOSED` (`proposedById`); a `canApproveCompensation` checker calls **approve** (rejects self → `409 SOD_SELF_APPROVAL`) → commit flips to `EFFECTIVE`/`isCurrent`. The existing direct-write path (provisioning) writes `status=EFFECTIVE` directly (default), so nothing regresses.
- **Arrears (back-dated revision):** when `effectiveFrom < today` over closed periods, for each closed period replay `engine.computePayslip(newRevision, P)` vs the immutable persisted payslip snapshot → `arrearMinor[P] = newNet − oldNet`; inject the total as an **`ComponentKind.ARREAR`** earning into the **next open** pay run (taxed/PF'd on receipt — statutory-correct). Each arrear line carries `sourcePeriodCode` + source revision id. **Never** mutate a closed payslip.
- **Increment cycles:** `POST /cycles`, `GET /cycles/:id/worksheet` (visibility-wrapped per row), `POST /cycles/:id/lines/:empId/propose`, `/submit`, `/approve` (SoD), `/commit` (fan out to N `CompensationRevision` rows in **one `$transaction`**; one bad line → whole commit fails with a per-row error map; each line independently wage-validated). Budget: Σ(new−old) ≤ `budgetMinor` enforced at LOCK/submit.
- **Letters:** on APPROVED→EFFECTIVE, render the increment letter from the revision snapshot → `createEnvelope({ businessId, employeeDocumentId|documentTemplateId, subject, signers:[employee], sequential })` (`lifecycle/esign/builtin.js:167`); store `letterEnvelopeId` on the revision. Pure reuse.
- **`POST /structures/preview`** — pure: body = lines + target (CTC|gross) → calls `deriveBreakup` then a single `engine.computePayslip` → returns the full waterfall (CTC → −employerCost → gross → −deductions → net), the BALANCING readout, resolved statutory line items, and the 50% verdict. No persistence. Backs the live builder preview (debounced).

### 4.4 Consolidated wage guard

Replace `validateWages50` (`compensation.controller.js:54`) with the engine-backed **`computeStatutoryWages`** (the one `offerWageCheck` uses, `india.js`): **fail-closed** (INR earnings without a resolvable Basic+DA split → `{ok:false, WAGES_50_RULE}`), integer paise, effective-dated (50% add-back effective 2025-11-21). Run it on **derived** amounts at revision-create / preview / cycle-commit (not only when the caller supplies them). **Country-gate it** (skip for NZ — no "Basic 50%" concept). Add the **minimum-wage Basic floor**: `MIN_WAGE_FLOOR` when Basic < state/award minimum (minimum wage floors Basic, not gross).

### 4.5 Field-level salary masking — `maskCompensation(payload, viewer)` shaper

Runs on **every** comp read before serialization. Access = intersection of three gates, all reused: (1) `requirePermission('canViewCompensation')`, (2) `effectiveScope(viewer)` band + `withEmployeeScope('compensation',{idParam:'employeeId'})` (IDOR-safe 404 for out-of-subtree — `scope.middleware.js:33`), (3) the `compVisibility` level.

```jsonc
// the visibility envelope the client renders off — no client-side permission math
{ "visibility": "ABSOLUTE|RANGE_ONLY|SELF_ONLY|NONE",
  "absolute": { "ctcAnnual":1800000, "grossMonthly":125000, "netMonthly":98500 },  // ONLY if ABSOLUTE/SELF
  "range":    { "bandId":"L4","min":1500000,"mid":2000000,"max":2600000,
                "compaRatio":0.90,"rangePenetration":0.27 },                       // RANGE_ONLY + ABSOLUTE
  "delta":    { "pct":12.5 } }                                                     // delta.absolute ONLY if ABSOLUTE
```

- `ABSOLUTE` → pass-through. `RANGE_ONLY` → **drop** `amountMonthly/amountAnnual/ctcAnnual/grossMonthly` and per-line amounts; emit band + compa-ratio + range-penetration from the employee's `Grade.minSalary/maxSalary`. Component **names** may show; **numbers never**. `SELF_ONLY` → only when `viewer.employeeId === target.employeeId`; full own breakup, others → 404. `NONE` → no team comp.
- **Anti-leak rule (explicit):** masking is **server-side field omission**, not a CSS blur — a RANGE row's JSON contains **no** `ctcAnnual/grossMonthly/netMonthly` key. The `•••` is a render of an absent field. A 403 is reserved for true ownership/scope boundaries (non-report employee) and its body carries zero salary data.
- **`GET /me/compensation`** is gated by `attachSelfEmployee` + `SELF_ONLY` (bypasses `canViewCompensation` — you can always see your own pay); terminated-employee ESS lockout (commit 855ed53) applies.

### 4.6 Audit

Keep `writeAudit('compensation.change', {before/after})` on writes (append-only → diff = new revision vs superseded). **Add** `compensation.read` audit on every comp read (`{viewerScope, visibility, fields}`) — high-volume so batch/async, but **never drop** (DPDP / NZ Privacy Act access trail). Super-admin reads are bypassed for auth but still audited (recommend a break-glass flag).

### 4.7 Routes (`backend/src/hr/routes/compensation.routes.js`)

Keep existing `/components`, `/structures`, `/employees/:employeeId/revisions` (reads `canViewCompensation`, writes `canManageCompensation`). **Add** `withEmployeeScope('compensation',{idParam:'employeeId'})` to per-employee routes; add `POST /structures/preview`, `GET/POST /grades` + `/grades/:id/assign-structure`, the `/cycles/*` set (proposal vs approve gated separately), `POST /revisions/:id/approve|reject|letter|letter/esign`, and `GET /me/compensation` (self, behind `attachSelfEmployee`).

---

## 5. Frontend

### 5.1 hr-admin — rebuild `apps/hr-admin/app/compensation/page.js`

Replace the 3-flat-tab shell (and the raw "enter employee ID" box) with a left-rail workspace:

```
Compensation
├─ Dashboard       (compa-ratio histogram · range-penetration by grade · total cost)  [canViewCompensationCost*]
├─ Component library                                                                  [view / manage]
├─ Structures      (builder + live preview — the centerpiece)                         [view / manage]
├─ Grades & bands  (Grade.min/max ranges, assign structure → employee = a revision)   [manage]
├─ Revisions       (single increment, target-CTC reverse-derive, maker-checker)       [manage + approve]
└─ Cycles          (bulk increment, budget, manager worksheet, maker-checker)         [manage + approve]
```

- **Component library:** DataTable + add/edit form posting the **real** contract (`kind`, `category`, `calcMethod`, wage flags). A `calcMethod=BALANCING` row shows "Balancing (fills to target)" and disables the amount field. Soft-delete via existing `deletedAt`.
- **Structure builder (centerpiece):** two-pane. Left = drag-to-reorder line editor (component picker, `calcMethod`, value, base selector for PERCENT_OF; **≤1 BALANCING line** enforced) + header (`name`/`code`/`entityId`/`countryCode`/`currencyCode`/`basis` + Target toggle CTC-annual | gross-monthly). Right = sticky **live waterfall** (`CTC → −employer cost → gross → −deductions → net`), BALANCING readout (amber if floored at 0 → over-allocation), and the **India 50% guard chip** (green/red with exact wages/gross). Right pane = debounced `POST /structures/preview`. **Save disabled client-side AND re-validated server-side** when Basic+DA < 50% (defense in depth). View-only operators get a read-only builder with live preview and no Save — **no 403**.
- **Revisions:** employee picker → current-CTC card (compa-ratio, range-penetration) → "Raise revision" drawer: enter new CTC **or** %hike (auto-fills) **or** new gross → drawer calls `/structures/preview` to show the resulting breakup + 50% chip **before** commit → save as `PROPOSED` → checker approves (SoD).
- **Cycles:** wizard (define + budget) → worksheet grid (per-row current CTC, compa-ratio, suggested %, new CTC, running budget bar) → submit → approve → atomic commit. Manager slices merge here.

### 5.2 hr-admin — Manager (TEAM, comp-restricted) — the masking-critical journey

Manager = operator with `TEAM` scope + `canProposeCompensation`, **no** `canViewCompensation`. Sees only **Cycles** + a read-only team comp view (other rail items hidden). The team worksheet renders per-report: compa-ratio, range-penetration, **band label**, manager's **%hike** input, **budget consumed in % terms** — and **never** an absolute CTC (cells show `••• (in band L4)`). The proposed new CTC echoes back as a **delta % + new compa-ratio**, never an absolute. A report's comp → `200 RANGE_ONLY` (absolute omitted server-side); a **non-report** → `403 OUT_OF_SCOPE` (true boundary, no salary in body); **own** comp → `SELF_ONLY` full. Granting `canViewCompensation` swaps the **same** grid to `ABSOLUTE` with zero layout change. Submit → `SUBMITTED` → routes to HR (`canApproveCompensation`); manager never sees the approver's absolute-cost view.

### 5.3 ESS — new `apps/ess/app/compensation/page.js`

Add "Compensation" to the ESS nav. `GET /api/hr/me/compensation` → `{ current:{visibility:'SELF_ONLY', absolute, lines, breakup}, history[], letters[] }`. Always self — **no `:id` path exists**, so cross-employee leakage is structurally impossible.

- **CTC breakup waterfall** (annual/monthly toggle), **reusing the existing payslip `Section`/`Row` grammar** from `apps/ess/app/payslips/[id]/page.js`: three sections — Earnings (Basic / HRA / Special-allowance-balancing / …), Employee deductions (EPF-EE / PT / TDS …), and **Employer contributions** clearly labelled "cost to company, not paid to you" (EPF-ER / EPS / EDLI / gratuity provision IN; KiwiSaver-ER / ESCT NZ). Numbers come from the assigned structure run through `engine.computePayslip` so the breakup matches actual payslips.
- **Revision history:** timeline of `CompensationRevision` (effective date, reason, old→new CTC, %hike, status); tap → breakup + letter.
- **Increment letters:** download PDF + e-sign status; "Review & e-sign" CTA opens the existing F4 sequential-signer flow.
- **Empty/terminated states:** no current revision → "contact HR" (no fabricated numbers); undefined variable/bonus branch hidden (not ₹0); terminated → existing ESS lockout → FnF statement path.

---

## 6. End-to-end per role + acceptance criteria

| Actor / band | Own | Direct report | Team/skip-level | Other employee | Propose | Approve | Define structures |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Employee** (SELF_ONLY) | full breakup + history + letters | — | — | 404 | — | — | — |
| **Manager, no grant** (NONE) | full (self) | 404 | 404 | 404 | — | — | — |
| **Manager, granted** (RANGE_ONLY + TEAM) | full (self) | range + compa-ratio + %hike, **no absolute** | range (within subtree) | 403 | ✓ within budget, blind to peer absolutes | — (SoD) | — |
| **HR / Comp-admin** (ABSOLUTE + ALL) | full | full | full | full | ✓ | ✓ if not proposer | ✓ |
| **Finance** (ABSOLUTE + ALL) | full | full | full | full | — | ✓ | view-only |
| **Owner** | full | full | full | full | ✓ | ✓ | ✓ |

**Acceptance criteria (cross-cutting):**
1. **Provisioned hire computes non-zero gross** — after the materializer wires into `provision.js` STEP 8, a hired employee's `CompensationRevision` carries `lines` and `computePayslip` returns the structured gross/net; FnF gratuity/encashment ≠ 0.
2. **No 403 leak** — every comp read returns `200` + a `visibility` envelope; a manager-without-`canViewCompensation` JSON for a report row has **no** `ctcAnnual`/`grossMonthly`/`netMonthly` key (snapshot test); 403 bodies carry zero salary data.
3. **Single source of math** — preview, revisions, cycle commit, ESS breakup, and payslips all reconcile to the one `engine.computePayslip` to the paise.
4. **50% guard everywhere** — inline in the builder (client) + `/preview` (server) + `revisions.create`/`cycles.commit` (consolidated `computeStatutoryWages`, fail-closed); country-gated off for NZ.
5. **Maker-checker SoD** — self-approve → `409 SOD_SELF_APPROVAL`; every approval/commit writes `compensation.change`; every read writes `compensation.read`.
6. **Append-only** — all changes create new revisions (supersede via `isCurrent`/`effectiveTo`); ESS history + letters always reconstructable.
7. **E-sign reuse** — increment letter amounts equal the committed revision; signed letter lands in ESS docs with a verifiable audit chain.

---

## 7. QA plan (numbered)

1. **CTC derivation / balancing (IN):** CTC ₹12,00,000, Basic 50%×CTC, HRA 50%×Basic, Conveyance flat, LTA, Special=BALANCING → assert Special = (CTC−employerCost) − Σ(other earnings), Σ(earnings)==targetGross to the paise; STRUCTURE_INFEASIBLE when fixed+percent already exceed target.
2. **Employer-cost fixed point (IN):** converges ≤3 iterations; quoted employer cost == engine runtime employer cost (replay parity).
3. **NZ gross-basis:** gross NZ$90,000, no balancing plug, KiwiSaver-ER 3% + ESCT reported on top, net == `nz.golden`; 50% validator **skipped** (country-gated).
4. **India 50% floor:** Basic+DA < 50% gross rejected fail-closed at preview AND revision-create AND cycle-commit; min-wage Basic floor → `MIN_WAGE_FLOOR`.
5. **Engine-consumption parity:** a structure built in the UI → revision → `computePayslip` produces the same payslip the preview showed (the golden contract).
6. **Provisioning bug fix:** provision a hire → revision has materialized `lines` → non-zero gross; offboard → `resolveLastDrawnPay` reads Basic+DA > 0 → gratuity correct.
7. **Revision SoD + arrears:** maker cannot approve own revision (`409`); a back-dated revision over a closed period produces an `ARREAR` line in the next open run equal to per-period net delta; closed payslip never mutated.
8. **Salary masking RBAC:** manager-no-grant on a report → `200 RANGE_ONLY`, JSON asserts no absolute money keys; on a non-report → `403`, no salary in body; employee on `/me` → full; employee crafting another id → 404 (no path exists).
9. **Cycle atomicity:** Σ(new−old) > budget blocks submit; commit is all-or-none; one wage-invalid line → whole commit fails with per-row error map.
10. **Letters + e-sign:** generated letter amounts == committed revision; e-signed letter in ESS docs; audit chain verifies.
11. **Audit:** every comp read and write emits an audit row (read events not dropped under load).
12. **Frontend field shape:** component/structure/revision creates post the real contract (`kind`/`category`/`calcMethod`; `entityId`/`countryCode`/`currencyCode`/`basis`; `revisionReason`+nested `lines`) and persist non-empty lines.

---

## 8. Build sequence (smallest shippable slices)

1. **`deriveBreakup.js` + `materializeRevisionLines` (pure) + golden parity tests** vs `engine.evalBalancing`. Wire the materializer into **`provision.js` STEP 8** — fixes the zero-gross bug. *(Highest value; unblocks payroll correctness for every hire.)*
2. **Consolidate the wage guard** — replace `validateWages50` with engine-backed `computeStatutoryWages` + min-wage floor; country-gate.
3. **`POST /structures/preview`** (pure, wraps engine) + reverse-derive (target → amounts).
4. **`compVisibility` + RBAC keys** (`canProposeCompensation`/`canApproveCompensation`) + **`maskCompensation` shaper** + `withEmployeeScope` on per-employee routes + `compensation.read` audit. *(Foundation for every read.)*
5. **hr-admin structure builder** (line editor + live preview + 50% chip) — rebuild `compensation/page.js`.
6. **Single revision** — status machine + SoD + reverse-derive drawer; `/me/compensation`.
7. **ESS `compensation/page.js`** (breakup waterfall + history + letters) — reuse payslip components.
8. **Cycles** (bulk + budget + manager restricted worksheet) + **increment letters + e-sign** + **comp dashboard**.

**Key file touchpoints:** new `backend/src/hr/compensation/deriveBreakup.js`; harden `backend/src/hr/controllers/compensation.controller.js` (+preview/cycles/letters/visibility/SoD, replace `validateWages50`); `backend/src/hr/routes/compensation.routes.js` (+scope guard, preview, /me, cycles, approve/letter routes); fix `backend/src/hr/lifecycle/provision.js:542` (materialize lines); `backend/src/core/lib/rbac.js` (+2 keys + `compVisibility`); `backend/prisma/schema.prisma` (+revision status/SoD/letter fields, +`IncrementCycle`/`IncrementProposal`, +`Grade.midSalary?`); reuse `backend/src/hr/payroll/{engine,money,service}.js`, `backend/src/hr/middleware/scope.middleware.js`, `backend/src/hr/lifecycle/esign/builtin.js`; rebuild `apps/hr-admin/app/compensation/page.js`, new `apps/ess/app/compensation/page.js`.

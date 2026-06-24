# Feature 17 — CTC Policy + Statement Builder, and Onboard-by-CTC

> **Status:** spec / dev contract · **Country:** **INDIA ONLY** (strict single-country-per-tenant — NZ never surfaces) · **Module:** `backend/src/hr/compensation/` (extend) + new `ctcPolicy.controller.js` · **Apps:** `apps/hr-admin` (builder + onboard wizard), `apps/ess` (statement view)
> **Builds on (verified live, 2026-06-24):**
> - Pure derivation lib `backend/src/hr/compensation/deriveBreakup.js` — `deriveBreakup()`, `materializeRevisionLines()`, `employerCostFixedPoint()` (already golden-tested ⇆ `engine.computePayslip`).
> - Statement PDF `backend/src/hr/compensation/ctcPdf.js`; masking `maskCompensation.js`.
> - Schema: `SalaryComponent` (`schema.prisma:6900` — has `derivationPass`/`floorValue`/`capValue`/`minWageFloorApplies`), `SalaryStructure` (`:7015`), `SalaryComponentLine` (`:7043`), `CompensationRevision` (`:7069`, has status machine + SoD), `Offer` (`:10065`), `Grade` (`:6501`), enums `ComponentKind`/`ComponentCategory`/`ComponentCalcMethod`/`ComponentBaseScope`/`StructureBasis`/`CompRevisionReason`.
> - Controller/routes `compensation.controller.js` + `compensation.routes.js` — already has `components`, `structures`, **`POST /structures/preview`** (pure), `revisions`, maker-checker approve/reject, `getRevisionPdf`.
> - Provisioning `backend/src/hr/lifecycle/provision.js` STEP 8 (`:563–647`) already calls `materializeRevisionLines` from `offer.structureId` + `offer.ctcAnnual` at `joinDate`.
> - Direct-hire UI `apps/hr-admin/app/people/new/page.js` → `POST /api/hr/employees` (creates a bare Employee, **no compensation today** — the gap this feature fills).
> - F1 RBAC `requirePermission`, `attachSelfEmployee`, `withEmployeeScope` (`scope.middleware.js`); maker-checker SoD pattern (commit 855ed53).

---

## 1. Summary & goals

Feature 05 already shipped the *engineering* of compensation — a pure target-CTC→breakup derivation, a `SalaryStructure` template model, a live `/structures/preview` waterfall, masking, and the provisioning bug-fix that materializes lines onto the hire revision. **What it did not ship is the layman-friendly authoring + onboarding journey the owner is asking for.** Today an admin must hand-craft a `SalaryStructure` with raw `SalaryComponentLine` rows (component picker, `calcMethod`, `calcValue`, `calcBaseScope`, `derivationPass`…), and the only path to attach pay to a person is either the full ATS offer→accept→provision flow or a per-employee revision drawer. The direct-hire form (`people/new`) creates an Employee with **zero compensation**.

Feature 17 adds three friendly surfaces **on top of the existing engine — no new math**:

1. **CTC Policy builder** — a reusable, *parameterized* template (`CtcPolicy`) that an admin authors once with **sliders / percentages / flat amounts** ("Basic = 50% of CTC", "HRA = 50% of Basic", "PF = statutory", "Special allowance = balancing"), India-first with the **50%-of-CTC Basic wage-floor** baked into the builder as a live guard. This is distinct from `SalaryStructure`: a policy is **CTC-agnostic** (rules only, no resolved amounts); a structure/revision is the **resolved** package at a specific CTC. A policy *compiles to* a `SalaryStructure` line-set on demand — it is the friendly front-door, the structure is the engine input.
2. **CTC Statement preview** — a one-screen, layman waterfall (CTC → −employer cost → gross → −deductions → net-in-hand) rendered from `deriveBreakup` at any sample CTC, plus the **PDF statement** (reuse `ctcPdf.js`). Available standalone (preview a policy at ₹X), inside the onboard wizard, and to the employee in ESS once hired.
3. **Onboard-by-CTC** — a 3-step wizard on the direct-hire path: **(1) who** (name/email/DOJ/department), **(2) how much** (pick a CTC Policy + enter target CTC → live statement preview + 50% chip), **(3) confirm** → one transaction creates the Employee **and** a `CompensationRevision(HIRE)` with materialized lines effective at the date of joining. This reuses `materializeRevisionLines` + the exact STEP 8 logic that `provision.js` uses, so a direct hire and an ATS hire produce **identical** pay math.

**Goals (v1):**
1. A `CtcPolicy` model + friendly builder: define component rules as %/flat/balancing/statutory, reorder, live-preview at a sample CTC, **save-blocked when Basic < 50% of CTC** (client + server, fail-closed via the existing `wagesVerdict`).
2. "Compile policy → structure": a pure `compilePolicyToStructureLines(policy, ctx)` that emits the `SalaryComponentLine` shape `deriveBreakup`/`materializeRevisionLines` already consume — **zero new derivation code**.
3. A standalone **CTC statement preview + PDF** for any policy at any CTC (reuse `/structures/preview` + `ctcPdf.js`).
4. **Onboard-by-CTC**: `POST /api/hr/onboard/by-ctc` that, in one `$transaction`, creates the Employee + `CompensationRevision(HIRE)` from `{ policyId, ctcAnnual, dateOfJoining }`, reusing provision STEP 8's materializer + 50% fail-closed guard.
5. hr-admin: a "CTC Policies" workspace (list/builder/preview) and a 3-step "Onboard by CTC" wizard replacing the bare `people/new` form (old form stays as "advanced / no-pay" fallback). ESS: a friendly "My CTC" statement tab.

**Non-goals (v1):** NZ anything (strict single-country — a policy's `countryCode` is always the tenant's, the builder never renders KiwiSaver/PAYE); editing a *resolved* revision in place (append-only stays); net→gross (basis=NET still rejected); FORMULA/SLAB custom rules in the friendly builder (the engine drops them — keep them out of the layman UI; advanced structure editor from F05 can still declare them); bulk onboard / CSV import (roadmap); policy versioning history beyond `version`+soft-delete.

---

## 2. Scope

### Reuse as-is (do **not** rebuild)
- `deriveBreakup()` / `materializeRevisionLines()` / `employerCostFixedPoint()` — the **only** place CTC→amounts is computed. The policy builder produces line shapes; it never does arithmetic.
- `POST /structures/preview` (`compensation.controller.js:741`) — the pure quote endpoint. The policy preview compiles policy→lines then calls the **same** `deriveBreakup` the preview wraps (or posts to preview directly).
- `ctcPdf.js` — the branded statement PDF. The standalone policy statement and the onboard "preview & confirm" reuse it (feed it the materialized lines + breakup).
- `maskCompensation.js` + `withEmployeeScope` + `attachSelfEmployee` — every read of a *person's* CTC stays masked; **policy templates carry no person's money** so they are visible to `canManageCompensation` without per-employee scoping.
- `provision.js` STEP 8 materializer + the derived-Basic 50% re-check (`provision.js:599–611`) — onboard-by-CTC **calls the same code path** (extract the STEP-8 block into a shared helper so ATS-provision and direct-onboard cannot drift).
- F1 RBAC keys `canManageCompensation` (author policies, onboard), `canViewCompensation` (preview/statement), maker-checker `canApproveCompensation` (unchanged); SoD self-approval guard pattern.
- `CompRevisionReason.HIRE`, `CompRevisionStatus.EFFECTIVE` (direct-write path, default) for the onboard revision.

### Fix-before-reuse
- **Extract provision STEP 8 → shared helper.** Today the materialize-from-CTC + 50% re-check logic lives inline in `provision.js:575–627`. Lift it to `backend/src/hr/compensation/hireComp.js` → `buildHireRevisionLines({ tx, businessId, countryCode, structureId, ctcAnnual, grossMonthly, joinDate }) → { lineCreates, breakup }`. Re-point `provision.js` STEP 8 at it (no behavior change; golden test asserts byte-identical output) and call it from onboard-by-CTC. **Prevents the two hire paths from diverging.**
- **`people/new` form** creates pay-less employees silently. v1 keeps it as an explicit "Add without pay (advanced)" link; the default CTA becomes the onboard-by-CTC wizard.

### Build net-new
- `CtcPolicy` + `CtcPolicyLine` models (thin; rules-only, CTC-agnostic).
- `backend/src/hr/compensation/ctcPolicy.js` (pure) — `compilePolicyToStructureLines(policy, ctx)`, `policyDefaults(countryCode)` (the India starter template), `validatePolicy(policy)` (≤1 balancing, exactly one BASIC, base-code references resolve, 50% Basic-of-CTC advisory).
- `ctcPolicy.controller.js` + routes: CRUD policies, `POST /ctc-policies/:id/preview` (compile→deriveBreakup→waterfall), `POST /ctc-policies/:id/statement.pdf`.
- `onboard.controller.js` `byCtc` + route `POST /api/hr/onboard/by-ctc` (reuses `buildHireRevisionLines`).
- hr-admin: `app/compensation/policies/*` (list + builder + preview) and `app/people/onboard/page.js` (3-step wizard). ESS: "My CTC" tab on the existing compensation page.

### Out of scope
NZ surfaces; CSV bulk onboard; policy approval/maker-checker (policies are templates, not pay — author with `canManageCompensation`, no SoD); offer-letter generation (that's F12/ATS); editing a live revision; per-component tax-projection (F05/payroll owns TDS).

---

## 3. Data model (Prisma — additive, one migration)

A **CtcPolicy is a reusable rule template, not a resolved package.** It holds *how* to split a CTC (percent/flat/balancing/statutory rules), never a person's amounts. It compiles to the `SalaryComponentLine` shape on demand. All money rules stored as the rule inputs (`pct` / `flatMinor`), not resolved amounts.

```prisma
/// A reusable, CTC-agnostic salary template authored in the friendly builder.
/// Compiles to SalaryComponentLine[] (→ deriveBreakup) at a chosen target CTC.
model CtcPolicy {
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId     String?                         // NULL = all entities of the tenant
  code         String                          // "STAFF-2026"
  name         String                          // "Staff CTC Policy 2026"
  countryCode  String   @db.Char(2)            // ALWAYS the tenant country (IN). Never user-chosen cross-country.
  currencyCode String   @db.Char(3)
  basis        StructureBasis @default(CTC)    // CTC for IN; reserved for future
  // Quote-time employer-cost knobs (drive deriveBreakup ctx; do NOT change runtime engine):
  esiApplicable   Boolean @default(false)      // include employer ESI in the CTC fixed point
  capPfAtCeiling  Boolean @default(true)       // cap PF at ₹15,000 wage ceiling in the quote
  isActive     Boolean  @default(true)
  lines        CtcPolicyLine[]
  createdById  String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  deletedAt    DateTime?
  version      Int      @default(0)
  @@unique([businessId, code])
  @@index([businessId, entityId, isActive])
}

/// One rule row in a policy. Maps 1:1 onto a SalaryComponentLine at compile time.
model CtcPolicyLine {
  id            String   @id @default(uuid())
  businessId    String
  policyId      String
  policy        CtcPolicy @relation(fields: [policyId], references: [id], onDelete: Cascade)
  componentId   String                          // FK SalaryComponent (the pay-head master)
  component     SalaryComponent @relation(fields: [componentId], references: [id], onDelete: Restrict)
  // The friendly rule (mirrors ComponentCalcMethod; the layman UI exposes only these):
  calcMethod    ComponentCalcMethod             // PERCENT_OF | FLAT | BALANCING | STATUTORY
  pct           Decimal? @db.Decimal(8,4)       // for PERCENT_OF (e.g. 50.0000)
  flatMonthly   Decimal? @db.Decimal(15,2)      // for FLAT (monthly amount)
  baseCode      String?                         // PERCENT_OF base: "CTC" | "GROSS" | a component code ("BASIC")
  sortOrder     Int      @default(0)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([businessId, policyId])
}
```

`SalaryComponent` needs a back-relation `ctcPolicyLines CtcPolicyLine[]` (additive). No other schema changes — `CompensationRevision`/`SalaryComponentLine`/`Offer`/`Grade` are reused verbatim. **The onboard revision is a normal `CompensationRevision(HIRE, EFFECTIVE)`** with materialized lines — indistinguishable downstream from an ATS hire.

**Compile mapping** (`compilePolicyToStructureLines`): each `CtcPolicyLine` → the line shape `materializeRevisionLines` consumes —
`{ component: {...the joined SalaryComponent incl. derivationPass/calcBaseScope/floorValue/capValue/kind}, calcMethod, calcValue: (pct ?? flatMonthly), sortOrder }`. `baseCode` resolves onto `component.calcBaseScope` (CTC/GROSS) or `calcBaseCode` (named component). Pass order is then taken from the component's stored `derivationPass` exactly as `deriveBreakup.passFor` already does — **the policy never re-implements pass logic.**

---

## 4. Backend

### 4.1 Pure policy lib — `backend/src/hr/compensation/ctcPolicy.js` (NEW, no DB/IO)
- `compilePolicyToStructureLines(policy, { components }) → { lines, basis }` — joins each policy line to its `SalaryComponent` (passed in, tenant-scoped by the caller) and emits the deriveBreakup line shape. Pure; unit-testable with plain `node`.
- `validatePolicy(policy, { components }) → { ok, errors[] }` — exactly one BASIC earning; ≤1 BALANCING; every `baseCode` resolves to CTC/GROSS or an earlier component; advises (not blocks) when Basic %-of-CTC < 50.
- `policyDefaults('IN') → CtcPolicy draft` — the **India starter policy** the builder seeds: Basic=50% of CTC, HRA=50% of Basic, Conveyance=₹1,600/mo flat, Special Allowance=BALANCING, plus statutory PF/ESI/Gratuity-provision employer lines (STATUTORY — owned by the engine at runtime, declared here for the cost view). Tenant edits from there. **NZ tenants never reach this** (country-gated; their roadmap default differs).

### 4.2 `backend/src/hr/compensation/hireComp.js` (NEW — extracted from provision STEP 8)
`buildHireRevisionLines({ tx, businessId, countryCode, structureId?, policyId?, ctcAnnual, grossMonthly?, joinDate }) → { lineCreates, breakup }`:
1. Resolve lines: from `structureId` (ATS path) **or** by compiling `policyId` (onboard path) → the deriveBreakup line shape.
2. `materializeRevisionLines({ lines, basis }, { target:{ctcAnnualMinor}, basis, countryCode, asOf: joinDate, esiApplicable })`.
3. **Fail-closed 50% re-check** on the *derived* Basic+DA: `if (breakup.wagesVerdict.applies && !breakup.wagesVerdict.ok) throw` (verbatim from `provision.js:606`).
4. Return `lineCreates` (each `{...l, businessId}`) + `breakup`.
`provision.js` STEP 8 is re-pointed at this; onboard-by-CTC calls it inside its own transaction. **One source of hire-pay math.**

### 4.3 Policy controller + routes — `ctcPolicy.controller.js`, mounted under existing comp router
| Method | Path | RBAC | Notes |
|---|---|---|---|
| GET | `/api/hr/ctc-policies` | `canViewCompensation` | list active policies (no person money → not masked) |
| GET | `/api/hr/ctc-policies/:id` | `canViewCompensation` | policy + lines (+ joined component labels) |
| POST | `/api/hr/ctc-policies` | `canManageCompensation` | create; `validatePolicy` fail-closed; `countryCode` forced = tenant country (ignore client value) |
| PATCH | `/api/hr/ctc-policies/:id` | `canManageCompensation` | replace lines atomically; re-validate |
| DELETE | `/api/hr/ctc-policies/:id` | `canManageCompensation` | soft-delete (`deletedAt`) |
| POST | `/api/hr/ctc-policies/:id/preview` | `canViewCompensation` | body `{ ctcAnnual }` → compile → `deriveBreakup` → waterfall + line items + employer-cost + **50% verdict**. Pure, no persist. Debounced from the builder/wizard. |
| POST | `/api/hr/ctc-policies/:id/statement.pdf` | `canViewCompensation` | same compile→breakup → `ctcPdf.js`; downloadable sample statement (watermarked "SAMPLE — not an offer"). |

All tenant-scoped on `businessId`; entity filter honoured. `countryCode` is **server-stamped from the tenant**, never trusted from the body (single-country invariant). Audit `compensation.change` on policy writes; `compensation.read` on preview/statement.

### 4.4 Onboard-by-CTC — `onboard.controller.js` `byCtc`, route `POST /api/hr/onboard/by-ctc`
RBAC: `canManageCompensation` **AND** the existing employee-create permission (`canManageEmployees`/equiv). Body:
```jsonc
{ "person": { "firstName","lastName","email","phone","code?",
              "departmentId?","designationId?","locationId?","managerEmployeeId?",
              "entityId" },
  "policyId": "…", "ctcAnnual": 1800000, "dateOfJoining": "2026-07-01" }
```
Logic (one `$transaction`):
1. Load policy (tenant-scoped, active) + its components.
2. `compilePolicyToStructureLines` → lines; `basis='CTC'` (IN).
3. `buildHireRevisionLines({ tx, businessId, countryCode, policyId, ctcAnnual, joinDate })` — **same** materializer + 50% fail-closed guard as provision. On breach → `422 WAGE_RULE` (no rows written).
4. Create `Employee` (reuse the `POST /employees` create service so org/number-sequence/defaults match) with `dateOfJoining`.
5. Create `CompensationRevision(HIRE, EFFECTIVE, isCurrent)` at `effectiveFrom = dateOfJoining`, `ctcAnnual`, nested `lines: { create: lineCreates }`; set `employee.currentCompensationId`.
6. Seed leave balances (reuse provision STEP 10 helper) so a direct hire matches an ATS hire.
7. Audit `employee.create` + `compensation.change`.
Returns `{ employee, revisionId, breakup }`. **Idempotency:** require an `Idempotency-Key`-style client token or dedupe on `(businessId,email,dateOfJoining)` to avoid double-create on retry. The 50% guard, employer-cost fixed point, and line math are **identical to ATS provisioning** because they call the same helper.

### 4.5 Security / invariants
- **Single-country:** policy `countryCode`/`currencyCode` derived from the tenant's entity, never the request body; the builder API rejects a country mismatch `409 COUNTRY_MISMATCH`. NZ components/rules never enumerated for an IN tenant.
- **50% wage floor fail-closed** at: builder save, policy preview, **and** onboard commit (on derived amounts) — three gates, all via the existing `wagesVerdict`.
- **Tenant isolation:** every query `where:{ businessId }`; component FKs validated in-tenant before compile (an out-of-tenant `componentId` → `400`).
- **No person-money leak in policies:** policies hold rules only; previews of a *sample* CTC are not a person's pay, so they need only `canViewCompensation`, not per-employee scope. The moment a CTC is attached to a person (onboard / revision), masking + scope apply.
- **Append-only:** onboard writes a fresh revision; never edits. Re-onboarding the same person is a new hire/revision, not a mutation.

---

## 5. Frontend (plain-language UX)

### 5.1 hr-admin — CTC Policies workspace (`app/compensation/policies/`)
- **List:** cards per policy (name, code, "Basic 50% • HRA 50% of Basic • Special = balancing", active toggle, "Preview", "Duplicate", "Edit"). Empty state → "Create your first CTC policy" with a one-click "Start from India template" (`policyDefaults('IN')`).
- **Builder (the friendly centerpiece):** two-pane, no jargon.
  - **Left = rule rows.** Each row: pick a component (friendly names — "Basic Pay", "House Rent Allowance", "Special Allowance"), choose **how it's set** via a segmented control: **"% of …"** (slider 0–100 + base dropdown CTC/Basic/Gross) · **"Fixed ₹/month"** (number) · **"Auto-balance (fills the rest)"** (the balancing residual; ≤1 allowed, amount field disabled with ⓘ "this soaks up whatever's left so the total equals the CTC") · **"Statutory (auto by law)"** (PF/ESI/Gratuity — read-only, ⓘ "calculated by Indian law, you don't set this"). Drag to reorder. Each control has an ⓘ tooltip in plain English.
  - **Right = sticky live preview** at a **sample CTC** (default ₹12,00,000, editable slider): the **waterfall** CTC → −Employer cost (PF/ESI/Gratuity, labelled "company's cost, not paid to employee") → **Gross** → −Employee deductions → **Net in hand**, with each component's monthly+annual. A **green/red "Basic ≥ 50% of CTC" chip** (India compliance) updates live; **Save is disabled (client) and rejected (server) when red.** Debounced `POST /ctc-policies/preview` (or `/structures/preview` with compiled lines).
  - Header: name/code/entity (country/currency shown read-only = tenant's, with ⓘ "your company is registered in India; all pay follows Indian rules").
  - "Download sample statement (PDF)" → `…/statement.pdf`.

### 5.2 hr-admin — Onboard-by-CTC wizard (`app/people/onboard/page.js`, new default "Add employee" CTA)
Three steps, a progress header, Back/Next:
1. **Who** — first/last name, email, phone, **date of joining** (DateField, ⓘ "their first working day; pay is effective from here"), department/designation/location/manager, employee code (blank = auto). Reuses the org dropdowns already in `people/new`.
2. **How much** — pick a **CTC Policy** (dropdown of active policies, with a one-line summary), enter **Annual CTC** (₹ input, thousands-formatted). → **live CTC statement preview** (the §5.1 right-pane waterfall) + the **50% chip**. Next is disabled while the chip is red, with the friendly reason ("Basic is below 50% of CTC — pick a policy with a higher Basic or raise the CTC").
3. **Confirm** — read-only summary (person + "Annual CTC ₹18,00,000 → ₹1,12,500 net/month" + effective date) + "Download statement". **"Create employee & assign pay"** → `POST /onboard/by-ctc` → success → redirect to `people/[id]` showing the new hire with live compensation. Errors (422 wage-rule, infeasible structure) surface inline with the same plain-English copy.
The old `people/new` form is kept behind "Add without pay (advanced) →".

### 5.3 ESS — "My CTC" statement (extend `apps/ess/app/compensation/page.js`)
A friendly **CTC statement** tab beside the existing payslip-grammar breakup: the same waterfall (annual/monthly toggle), three labelled sections (Earnings / My deductions / Company contributions — "cost to company, not paid to you"), sourced from the employee's current `CompensationRevision` via the masked `/me/compensation`. "Download my CTC statement (PDF)" → the masked `ctcPdf`. Always self; terminated-employee lockout applies (commit 855ed53). No fabricated ₹0 lines — absent components are hidden.

---

## 6. Build plan (5 slices, smallest shippable)

1. **Slice 17a — Policy model + pure lib.** Add `CtcPolicy`/`CtcPolicyLine` (+ migration, + `SalaryComponent` back-relation). Write `ctcPolicy.js` (`compilePolicyToStructureLines`, `validatePolicy`, `policyDefaults('IN')`) **pure**, unit-tested. Golden test: a compiled policy → `deriveBreakup` equals a hand-built structure to the paise.
2. **Slice 17b — Extract `hireComp.js` + re-point provision.** Lift provision STEP 8 into `buildHireRevisionLines`; re-point `provision.js` at it; golden test asserts byte-identical hire lines before/after. *(De-risks the shared path before onboard depends on it.)*
3. **Slice 17c — Policy CRUD + preview + statement API.** `ctcPolicy.controller.js` + routes (country-stamped, validated, audited); `/preview` (compile→deriveBreakup→waterfall + 50% verdict); `/statement.pdf` (reuse `ctcPdf.js`).
4. **Slice 17d — Onboard-by-CTC API.** `POST /onboard/by-ctc` reusing `buildHireRevisionLines` + the employee-create service + leave seeding, fail-closed 50%, idempotent.
5. **Slice 17e — hr-admin policy builder + onboard wizard + ESS My-CTC.** The friendly two-pane policy builder (sliders/%/balancing + live waterfall + 50% chip), the 3-step onboard wizard, and the ESS statement tab. Reuses the F05 preview/waterfall components.

**Acceptance:** (1) a policy authored with sliders previews a correct CTC→net waterfall reconciling to `engine.computePayslip` to the paise; (2) save/onboard blocked fail-closed when Basic < 50% of CTC, client + server; (3) onboard-by-CTC produces a hire whose `CompensationRevision` lines are **byte-identical** to the same person hired via ATS-provision (same `buildHireRevisionLines`); (4) the new hire shows live compensation + a downloadable CTC statement in ESS; (5) no NZ surface ever renders for the IN tenant; (6) policy/onboard writes audited; tenant-isolated.

---

## 7. Edge cases & QA
- **Infeasible policy** (fixed+percent earnings already exceed CTC, no balancing line) → `STRUCTURE_INFEASIBLE` surfaced as "These components add up to more than the CTC — add an Auto-balance line or lower a percentage."
- **Employer cost > CTC** (tiny CTC) → `deriveBreakup` throws negative-gross → wizard blocks with "CTC too low to cover statutory employer costs."
- **Basic 50% breach** after employer-cost subtraction shrinks gross (the subtle case provision.js:602 already documents) — the re-check on *derived* Basic catches it even when the *nominal* policy looked compliant.
- **Back-dated DOJ** → revision `effectiveFrom` in the past; v1 onboard restricts DOJ to today-or-future (arrears on hire are out of scope; ATS path unaffected); a past DOJ within the current open period is allowed, earlier → `400` with guidance to use the F05 revision/arrears flow.
- **Duplicate onboard** (retry) → idempotency token / `(email,DOJ)` dedupe → `409` returning the existing employee.
- **Policy edited after hires exist** → no retroactive effect (revisions snapshot resolved lines); the policy is a template, not a live link.
- **NZ tenant** → policies API country-stamps NZ; the IN-specific builder copy/50%-chip is gated off; NZ default policy + GROSS basis is the roadmap (this spec ships IN only).
- **QA scripts:** policy→structure parity vs hand-built; onboard-vs-ATS hire byte-parity; 50% fail-closed at builder/preview/onboard; infeasible + negative-gross errors; idempotent double-onboard; masking unchanged on the resulting person's reads; audit rows on every write/read; tenant-isolation (cross-tenant `componentId`/`policyId` → 400/404).

# Feature 16 — Attendance-Driven Payroll Proration + Leave Without Pay (LWP) — India

> Owner brief: *"salary calculated as per per-day present; if absent salary zero or
> prorata basis."* Monthly salary is prorated by **payable days** (present + paid-leave
> + weekly-off + holidays) against the period's standard days. Unauthorised absence
> becomes **LOP** (loss of pay) → proportional deduction. **LWP** is a *leave type*
> (`paid=false`) employees can **apply** for; on **approval** it produces LOP days in
> payroll — an **authorised** unpaid absence (not AWOL, not a balance deduction).
>
> **STRICT SINGLE-COUNTRY-PER-TENANT.** This feature ships **India only**. NZ
> Holidays-Act unpaid-leave / proration nuances are flagged to the roadmap (§11) and
> never surface for an India tenant. The tenant's `Entity.countryCode` remains the
> single source of truth that selects payroll/tax/leave/statutory behaviour.

---

## 0. TL;DR — what this feature actually is

**90% of this vertical already exists and is correct.** This is primarily a
**wiring + hardening + statutory-framework** feature, not a green-field build. The
existing pieces:

| Concern | Where it lives today | Status |
|---|---|---|
| Per-day LOP derivation | `attendance/derive.js#classify` → `{status, lopFraction}` | DONE — `ABSENT→lopFraction 1`, `ON_LEAVE→lopFraction = affectsLOP?1:0`, `HALF_DAY→0.5` |
| Leave→attendance leave context | `attendance/service.js#resolveLeaveForDay` → `{fraction, affectsLOP, half}` | DONE — aggregates covering APPROVED/AVAILED txns, ORs `affectsLOP` |
| Period roll-up to pay input | `attendance/freeze.js#rollupEmployee` → `AttendancePayInput{calendarDays,payableDays,lopDays,paidLeaveDays,...}` | DONE — `payableDays = calendarDays − Σ lopFraction` |
| Frozen input → engine | `payroll/service.js#buildEmployeePayInput` → `inputs{calendarDays,payableDays,lopDays,otHours}` | DONE — gates on `!= null` so a frozen ZERO reaches the engine (M1) |
| Proration math | `payroll/engine.js#resolveProration`/`applyProration` | DONE — `prorated = full × payableDays/standardDays`, `LOP_BEHAVIOR`, `PRORATION.*` |
| Statutory recompute on prorated gross | `payroll/compliance/india.js#compute` | DONE — PF/ESI/PT/TDS all key off the **prorated** `periodGrossMinor` |
| LWP definition (conceptual) | Feature 6 §4.10 — "LWP = `UNPAID` type, `affectsLOP=true`, no balance" | DECLARED, NOT SEEDED |

**The real work (the gaps this spec closes):**

1. **Seed + admin-manage the India statutory leave framework** (EL/SL/CL) **and the
   LWP leave type** as first-class, govt-rule-compliant config (§2, §3).
2. **Materialise `Attendance` `ON_LEAVE` rows at leave approval** so an approved LWP
   day reliably becomes a frozen LOP day even when no punch/derivation job runs for
   that employee (today the leave→attendance bridge only fires during the nightly
   derive/recompute; an approval must eagerly stamp the days). (§4, slice 16c)
3. **Fix the no-balance LWP apply path** — `validators.js` already exempts
   `category==='UNPAID'` / `affectsLOP===true` from `INSUFFICIENT_BALANCE`, but the
   apply controller writes a `LeaveTransaction` with `leaveBalanceId` and a balance
   soft-hold; LWP must apply with **no balance row, no hold, quantity carried for
   audit only**. (§4, slice 16c)
4. **Make LOP visible & explainable** on the payslip + run review: a first-class
   `LOP` informational line (days × per-day rate) and an `AttendancePayInput`
   provenance block so an employee/auditor sees *why* pay dropped. (§4, slice 16d)
5. **Standard-days policy hardening** — define exactly what `standardDays` an India
   tenant prorates against (calendar vs fixed-30 vs working) and make it a
   tenant/entity policy, not an implicit per-component default. (§5, slice 16b)
6. **Edge cases**: mid-month join/exit, full-LOP month (zero pay but statutory floors),
   sandwiched LWP, LWP overlapping paid leave, negative-net guard, frozen-day
   immutability, retro leave into a CLOSED run. (§7)

---

## 1. Code I studied (cite-first; reuse, don't duplicate)

- `backend/src/hr/attendance/derive.js` — PURE daily derivation. `classify()` is the
  LOP source of truth: decision table, first-match-wins. LWP rides the existing
  `ON_LEAVE` branch (`leave.affectsLOP ? 1 : 0`) — **no new status needed**.
- `backend/src/hr/attendance/service.js` — `resolveLeaveForDay(day, leaveTxns)` builds
  the `{fraction, affectsLOP, half}` ctx from APPROVED/AVAILED APPLICATION rows; the
  nightly recompute upserts one `Attendance` row/emp/day.
- `backend/src/hr/attendance/freeze.js` — `rollupEmployee(rows)` →
  `AttendancePayInput`. `payableDays = calendarDays − Σ lopFraction`; H3 NO_ATTENDANCE_DATA
  guard; locks rows on freeze (monotonic).
- `backend/src/hr/payroll/engine.js` — `resolveProration`/`applyProration`:
  `payableDays` precedence = explicit > `standardDays − lopDays`; clamps `payable≥standard`
  and `payable≤0`; exact integer-rational proration; `LOP_BEHAVIOR.FIXED_REGARDLESS`
  exempts components (statutory-floor allowances). **Untouched** by this feature except
  the new LOP informational line.
- `backend/src/hr/payroll/compliance/india.js` — `compute(ctx)`. Already operates on
  the **prorated** `periodGrossMinor`/`basicMinor`, so LOP automatically reduces PF/ESI
  bases and TDS projection. **Untouched**.
- `backend/src/hr/payroll/service.js` — `buildEmployeePayInput` (PURE mapping;
  M1 `!= null` gate is load-bearing), `computeRun` (freeze+compute+persist atomic path).
- `backend/src/hr/leave/validators.js` — already exempts UNPAID/affectsLOP from balance
  checks (lines 115-118). `calendar.js#computeLeaveUnits` — working-day netting + sandwich.
  `ledger.js`, `policyResolver.js`, `accrual.js`.
- `backend/src/hr/controllers/leave.controller.js` — `apply` (soft-hold + approval-engine
  open), `approve`/`withdraw` (balance moves). **No `Attendance` write at approval today.**
- `prisma/schema.prisma` — `LeaveType{category,isPaid,affectsLOP,sandwichPolicy}`,
  `LeavePolicy`, `Attendance{status,lopFraction}`, `AttendancePayInput{...}`,
  `LeaveCategory` (has `UNPAID`), `AttendanceStatus` (has `ON_LEAVE`).
- `prisma/seed-hr.js:491-542` — seeds EL/SL/NZ-ANNUAL + policies. **No CL, no LWP.**
- `docs/features/06-leave-management.md` — the leave engine spec (this feature extends,
  never forks, it). `docs/05-compliance-india.md` — statutory rate source of truth.

**Reuse decisions (no duplication):**
- LWP is **not** a new attendance status or a new engine code-path. It is a *seeded
  LeaveType* that flows through the **existing** `affectsLOP` → `lopFraction=1` seam.
- Proration is **not** re-implemented; we only (a) make `standardDays` an explicit
  policy and (b) ensure approval eagerly materialises the `ON_LEAVE` days.
- LOP "deduction" is **not** a `DEDUCTION` component — LOP works by *reducing earnings*
  via proration (the engine's design), so net never double-counts. The payslip `LOP`
  line is **informational only** (`amountMinor` shown, not summed into deductions).

---

## 2. India statutory leave framework (govt-rule-compliant) — the policy layer

India has **no single central leave statute**; entitlements come from the
**state Shops & Establishments Acts** and the **Factories Act, 1948** (factory workers).
A defensible SaaS default mirrors what factoHR / greytHR / Keka ship: three earned/sick/
casual buckets plus LWP. We encode **statutory minimums as policy floors**, tenant-
configurable upward only (a tenant may grant *more*, never less than the floor for the
applicable Act). The Act/state mapping lives in a new effective-dated rules table
(`leaveStatutoryFramework` in `india.js`, mirroring its `professionalTax.states` shape)
so the floor is *resolved*, never hard-coded in the UI.

### 2.1 The four India leave types (seeded per tenant on India-entity creation)

| Code | Name | `category` | `isPaid` | `affectsLOP` | Statutory basis (floor) | Default policy |
|---|---|---|---|---|---|---|
| **EL** | Earned / Privilege Leave | `ANNUAL` | true | false | Factories Act §79: 1 day per 20 days worked (~12–18/yr); S&E Acts 12–21/yr | 18/yr, **MONTHLY_ACCRUAL**, carry-forward cap 30–45, **encashable** |
| **SL** | Sick Leave | `SICK` | true | false | S&E Acts ~7–12/yr (state-varying); ESI sickness benefit overlay | 12/yr, **UPFRONT_ANNUAL**, no/limited carry, not encashable |
| **CL** | Casual Leave | `CASUAL` | true | false | S&E Acts ~7–12/yr; **lapses** at year-end (use-it-or-lose-it) | 12/yr, UPFRONT_ANNUAL, **carryForwardCap=0** (lapses), max 3 consecutive |
| **LWP** | Leave Without Pay | `UNPAID` | **false** | **true** | None (contractual; an *authorised* unpaid absence) | **No entitlement, no accrual, no balance**; produces LOP on approval |

> **Floors are resolved per state** via `Entity.stateCode` against
> `india.leaveStatutoryFramework`. Admin UI shows the floor and **blocks saving a policy
> below it** (`LEAVE_BELOW_STATUTORY_FLOOR` validation). Granting *above* the floor is
> always allowed. Maternity (26w, Maternity Benefit Act 1961) / Paternity / Bereavement
> already have `LeaveCategory` members and are **out of scope here** (Feature 6 owns them);
> we only add CL + LWP and the floor resolver.

### 2.2 Why LWP is `UNPAID` + `affectsLOP=true` (not a new mechanism)

- `category = UNPAID` → `validators.js` skips the `INSUFFICIENT_BALANCE` gate (it is the
  one type you can take with a **zero balance** and no advance) — *this is the owner's
  "if absent salary zero" made into an authorised, approvable flow*.
- `affectsLOP = true` → `resolveLeaveForDay` ORs it true → `derive.classify` returns
  `ON_LEAVE` with `lopFraction = 1` → `freeze.rollupEmployee` adds it to `lopDays` (NOT
  `paidLeaveDays`) → `payableDays` drops → engine prorates pay down. **End to end with
  zero new math.**
- It is **authorised** (an approval exists) so it is distinct from `ABSENT` (AWOL): both
  yield `lopFraction=1`, but `ON_LEAVE` carries the approval audit trail and never trips
  the "unexplained absence" exception flags / disciplinary reports.

---

## 3. Data model (Prisma sketches)

Almost everything exists. Only **additive, backward-compatible** changes:

### 3.1 `LeaveType` — no schema change; new seeded row

```prisma
// SEEDED (not a migration). LWP row, per India tenant:
// LeaveType { code:"LWP", name:"Leave Without Pay", countryCode:"IN",
//   category:UNPAID, unit:DAYS, isPaid:false, isStatutory:false,
//   affectsLOP:true, isEncashable:false, requiresReason:true,
//   sandwichPolicy:EXCLUSIVE,  // an unpaid block should NOT debit interior holidays
//   color:"#9CA3AF" }
// CL row: { code:"CL", category:CASUAL, isPaid:true, affectsLOP:false, ... }
```

> **Sandwich for LWP = EXCLUSIVE.** A public holiday/weekly-off *inside* an LWP block is
> already non-working and is **paid as a holiday** (it is a payable day, not LOP). If LWP
> were INCLUSIVE it would wrongly convert a paid holiday into an unpaid day. `calendar.js`
> already supports this via `sandwichPolicy`; we set it explicitly on the LWP type so it
> never defaults INCLUSIVE from `countryCode='IN'`.

### 3.2 `LeavePolicy` — add a statutory-floor stamp (1 nullable column)

```prisma
model LeavePolicy {
  // ...existing...
  statutoryFloorPerYear Decimal? @db.Decimal(8,4) // resolved floor at author time (audit;
  // the live gate re-resolves from india.leaveStatutoryFramework so a floor change re-validates)
}
```

LWP gets a policy too (so it is assignable/scopeable + carries `requiresReason`,
`maxConsecutive`, `minNoticeDays`, `workflowDefinitionId` for its approval chain) but
with `accrualMethod` = a new no-op tier and **no `entitlementPerYear`**:

```prisma
enum AccrualMethod {
  // ...existing...
  NONE // LWP / no-accrual types — never grants a balance row (Feature 16)
}
```

`accrual.js` / `accrualRunner.js` **skip** `NONE` policies (one guard:
`if (policy.accrualMethod === 'NONE') return { skipped:true }`), so LWP never creates a
`LeaveBalance` and never appears in carry-forward/lapse.

### 3.3 `AttendancePayInput` — add LWP visibility (2 nullable columns)

```prisma
model AttendancePayInput {
  // ...existing calendarDays/payableDays/lopDays/paidLeaveDays...
  lwpDays      Decimal @db.Decimal(8,4) @default(0) // approved unpaid-leave days (subset of lopDays)
  absentDays   Decimal @db.Decimal(8,4) @default(0) // AWOL/unauthorised LOP days (lopDays − lwpDays − halfLop)
}
```

`rollupEmployee` splits the LOP it already computes: a day whose `Attendance.status==='ON_LEAVE'`
**and** whose covering leave type `affectsLOP` → `lwpDays`; `status==='ABSENT'` →
`absentDays`. **`payableDays`/`lopDays` math is unchanged** — these are pure provenance so
the run review can say "12 payable, 3 LWP, 1 absent" instead of an opaque "4 LOP".

### 3.4 `PayRunLine` — already carries `payableDays`, `lopDays`. Add `lwpDays` (nullable) for the same provenance. No other change.

---

## 4. API + RBAC

All endpoints are tenant-scoped (`businessId` from JWT), F1 reporting-subtree scoped
where employee-specific, and maker-checker (SoD) where they mutate money/approvals.
Reuse the **existing** leave + payroll controllers/routes; add the thin pieces below.

### 4.1 Leave config (hr-admin) — extends existing `leave.controller.js`

| Method + path | Purpose | RBAC | Notes |
|---|---|---|---|
| `POST /hr/leave/types` | Create LWP / CL (and any custom type) | `canManageLeaveConfig` | Validates `category/isPaid/affectsLOP` coherence: `UNPAID ⇒ isPaid=false ∧ affectsLOP=true` (server-forced); blocks a *paid* type with `affectsLOP=true` (`INCOHERENT_LEAVE_TYPE`). |
| `POST /hr/leave/policies` | Author a policy | `canManageLeaveConfig` | **Floor gate**: re-resolves `india.leaveStatutoryFramework[stateCode][category]`; rejects `entitlementPerYear < floor` with `LEAVE_BELOW_STATUTORY_FLOOR{floor, given}`. LWP policy must have `accrualMethod=NONE` + no `entitlementPerYear` (`LWP_NO_ENTITLEMENT`). |
| `GET /hr/leave/statutory-framework?stateCode=` | Read the resolved floors for the admin UI | `canManageLeaveConfig` | Pure read from `india.js`; India-only (404 for NZ tenants). |

### 4.2 Leave apply/approve (ESS + manager) — extends existing flow

The **existing** `POST /me/leave/requests` (ESS) and approval-engine path are reused. LWP
changes are *inside* `apply`/`approve`, not new endpoints:

- **`apply`** detects an LWP/`UNPAID` type and takes the **no-balance branch**:
  - `leaveBalanceId = null`, **no `pendingApproval` soft-hold** (there is no balance to
    hold), `quantity = -units` retained for audit/reporting only.
  - `validators.validateRequest` already passes (UNPAID exempt from balance). We add a
    server assertion that an `UNPAID` apply never touches a `LeaveBalance`.
  - The approval chain still opens via `engine.openRequest` (manager → escalate@48h),
    identical routing — LWP is **approvable**, not auto-granted.
- **`approve`** (the new eager-materialisation, slice 16c §4.3): on the APPROVED
  transition, **stamp `Attendance` `ON_LEAVE` rows** for each working day in the leave
  span (sandwich-netted), with `lopFraction` from the type (`affectsLOP?1:0`, `0.5` on a
  half-day boundary). Idempotent upsert on `@@unique([businessId,employeeId,date])`,
  **never overwriting a `isLocked` row** (a frozen day stays frozen → §7 edge).

### 4.3 The leave→attendance eager bridge (the core new server logic — PURE + thin)

A new pure helper `leave/leaveToAttendance.js#materialiseLeaveDays(txn, ctx)`:

```
materialiseLeaveDays(txn, ctx) -> [{ date, status:'ON_LEAVE', lopFraction, source }]
  reuse calendar.computeLeaveUnits(req, ctx).dayBreakdown   // working-day + sandwich netting
  for each breakdown day with fraction > 0:
    lopFraction = ctx.leaveType.affectsLOP ? fraction : 0   // LWP→fraction, paid→0
    emit { date, status:'ON_LEAVE', lopFraction }
  // weekoff/holiday days (fraction 0) are NOT emitted → they stay payable
```

Thin DB writer (in the approve tx): `upsert` each emitted day, `where isLocked=false`.
This guarantees an approved LWP day is a frozen-eligible LOP day **regardless of whether
the nightly derivation ran** — closing the "approval before derive" race. The nightly
`recompute` remains the reconciler (it re-derives the same rows deterministically;
idempotent upsert means no drift).

### 4.4 Payroll — no new endpoints

`computeRun` (freeze path) already rolls `AttendancePayInput` and prorates. The only
additions: the `lwpDays`/`absentDays` split in `rollupEmployee` and the informational
`LOP` payslip line (slice 16d). Run-review surfaces an `LWP_LOP_APPLIED` *INFO* anomaly
per employee with LOP so the checker sees it (not a blocker).

---

## 5. Proration policy — what India prorates against (the "standardDays" decision)

The owner says *"per-day present … prorata basis."* The ambiguity is **the denominator**.
Indian payroll uses one of three conventions; we make it an explicit **entity policy**
(`Entity.prorationBasis`, new enum, default `CALENDAR_DAYS` for India) rather than the
component-level implicit default:

| Basis | `standardDays` | Per-day value | When used | factoHR/greytHR norm |
|---|---|---|---|---|
| **CALENDAR_DAYS** (default IN) | days in the month (28–31) | gross ÷ calendarDays | Most common; "30-day" feel varies by month | greytHR default |
| **FIXED_30** | always 30 | gross ÷ 30 | Uniform per-day value across months; favoured for hourly-feel parity | factoHR option |
| **WORKING_DAYS** | calendar − weeklyoffs − holidays | gross ÷ workingDays | "pay only for working days" model | less common |

The engine **already supports all three** (`PRORATION.CALENDAR_DAYS/FIXED_30/WORKING_DAYS`).
This feature:
1. Adds `Entity.prorationBasis` (enum) + maps it in `buildEmployeePayInput` so every
   `REDUCES_WITH_LOP` earning inherits the **entity** policy (a component may still
   override to `NONE`/`FIXED_REGARDLESS` for a statutory-floor allowance).
2. Sets `inputs.standardDays` from the chosen basis at freeze time so the proration
   denominator is **frozen with the inputs** (auditable, immutable, part of `inputHash`).

> **Critical invariant (preserved):** `payableDays + lopDays = standardDays` for the chosen
> basis. `freeze.rollupEmployee` computes `payableDays = calendarDays − lopDays`; if the
> basis is FIXED_30/WORKING_DAYS, the engine recomputes `payable = standard − lopDays`
> internally (it already does — `applyProration` line ~452), so the *fraction* is correct
> for any basis. We assert this in a golden test.

---

## 6. hr-admin + ESS UX (plain language)

### hr-admin (HR / payroll operator)

- **Leave → Types & Policies**: a "Statutory framework" panel per state shows EL/SL/CL
  floors (e.g. "Maharashtra S&E: EL ≥ 18/yr"). Creating/editing a policy below the floor
  shows a red blocker. An **"Add Leave Without Pay"** one-click sets up the LWP type +
  policy with the right flags (the admin can't accidentally make it paid).
- **Pay run → Review**: each employee row shows **Payable / LWP / Absent / Paid-leave /
  WeekOff+Holiday** day chips and the proration basis. Hovering a reduced-net row reveals
  *"₹X gross × 27/31 payable days = ₹Y; 4 days LOP (3 LWP-approved, 1 absent)."* A run
  with any LWP shows an INFO badge (not a blocker). Full-LOP (zero-net) employees are
  highlighted amber with the NO_ATTENDANCE_DATA / full-LOP reason.
- **Attendance → Monthly**: existing grid already shows daily status; LWP days render with
  the LWP chip colour and an "approved unpaid" tooltip distinct from red ABSENT.

### ESS (employee)

- **Apply for leave**: LWP appears in the leave-type dropdown with a clear banner —
  *"Leave Without Pay reduces your salary for these days. You do not need a leave balance."*
  The computed-days hint reuses `computeLeaveUnits` to show *"3 working days — your pay
  will reduce by approximately ₹Z (estimate)."* (estimate from current gross ÷ standardDays;
  labelled an estimate, the payslip is authoritative).
- **Payslip**: a **LOP** line under earnings (informational): *"Loss of Pay — 4 days
  (3 LWP, 1 absent): −₹Y"* with the per-day rate. The net already reflects the reduction;
  the line *explains* it. The provenance block shows payable/standard days.
- **Leave history**: an LWP row shows "Unpaid — approved" with no balance impact.

---

## 7. Security, edge cases & invariants

1. **Frozen-day immutability (monotonic).** The approve-time `Attendance` upsert filters
   `isLocked=false`. A retro LWP approval landing on a day already frozen into a CLOSED/PAID
   run **does not mutate** it; the effect defers to the next open period (mirrors Feature 6
   §4.10 "retro into CLOSED run → next-period settlement"). Surfaced as `RETRO_LWP_DEFERRED`.
2. **Full-LOP month (zero net, statutory floors).** If `payableDays ≤ 0`, every
   `REDUCES_WITH_LOP` earning prorates to 0 → gross 0 → net 0. **Statutory floors still
   fire**: PF admin ₹500 establishment floor and PT can still be non-zero on a tiny gross;
   the engine's `NEGATIVE_NET` BLOCKER catches a case where a fixed statutory-floor
   deduction exceeds zero earnings — the run gates at VALIDATED until HR resolves
   (e.g., suppress PT for a zero-gross month per state rule). Documented, tested.
3. **LWP overlapping paid leave.** `resolveLeaveForDay` aggregates covering txns and
   **ORs `affectsLOP`**; fraction caps at 1. A day with 0.5 paid SL + 0.5 LWP →
   `fraction=1, affectsLOP=true` → `ON_LEAVE lopFraction=0.5` (only the LWP half is LOP;
   the SL half is paid leave). The eager bridge must emit the **per-half** LOP, not a full
   day — `materialiseLeaveDays` reads the netted half-day fraction, so this is correct by
   construction. Golden-tested.
4. **No-balance apply never holds a balance.** Server asserts an `UNPAID` apply writes
   `leaveBalanceId=null` and performs **no** `pendingApproval` increment. A bug that held a
   non-existent balance would throw; we assert it can't.
5. **AWOL vs authorised-unpaid both LOP, but distinct.** `ABSENT` (no approval) and
   `ON_LEAVE`+LWP (approved) both yield `lopFraction=1` and identical pay reduction, but
   only `ABSENT` trips absence-exception reports. The `absentDays`/`lwpDays` split makes the
   distinction auditable. **Owner's "salary zero" is satisfied either way**; LWP just adds
   the approval/authorisation layer.
6. **Idempotency & immutability of the run.** All LOP flows through frozen
   `AttendancePayInput`, which is part of `inputHash`. Recompute with the same frozen
   inputs is a no-op; a CLOSED run refuses a different `inputHash` (existing guard).
7. **Tenant isolation + single-country.** Floor resolver, LWP seed, proration basis are all
   keyed on `Entity.countryCode='IN'` / `stateCode`. NZ types/bases are never resolved for
   an India tenant (the registry + `resolveModule` already enforce this).
8. **SoD on config.** Creating/editing leave types/policies is `canManageLeaveConfig`; it
   does **not** let the same actor both author a policy and approve the pay run that
   consumes it (those are different permissions/flows; maker-checker on the run is intact).
9. **Half-day LOP precision.** Days carried as Decimal(8,4); engine scales days ×10000 for
   exact rational proration. A 0.5-day LWP reduces pay by exactly `gross × 0.5/standard`.
10. **Negative entitlement / advance does not apply to LWP.** `allowNegative` is irrelevant
    for `NONE`-accrual LWP; the apply path never reads a negative cap for it.

---

## 8. Build plan (slices — each independently shippable, test-gated)

### Slice 16a — India statutory leave framework + LWP/CL seed (config foundation)
- Add `india.leaveStatutoryFramework` (effective-dated, per-state EL/SL/CL floors;
  Factories Act §79 + S&E Acts), exported like `professionalTax.states`.
- Seed `LWP` + `CL` `LeaveType` rows (correct flags) and their policies (LWP =
  `accrualMethod:NONE`) per India tenant in `seed-hr.js`.
- Add `AccrualMethod.NONE`; guard `accrual.js`/`accrualRunner.js` to skip it.
- **Tests:** floor resolver golden (MH/KA/TN), `NONE` accrual never grants a balance,
  LWP type coherence (`UNPAID⇒isPaid=false∧affectsLOP=true`).

### Slice 16b — Proration basis as entity policy + frozen standardDays
- Add `Entity.prorationBasis` enum (default `CALENDAR_DAYS`); map it in
  `buildEmployeePayInput` so every `REDUCES_WITH_LOP` earning inherits it; freeze
  `inputs.standardDays` into `AttendancePayInput` provenance + `inputHash`.
- **Tests:** golden per basis (CALENDAR_DAYS 31-day month, FIXED_30, WORKING_DAYS) asserting
  `payableDays+lopDays=standardDays` and the prorated amount to the paise.

### Slice 16c — Leave→attendance eager materialisation + no-balance LWP apply
- `leave/leaveToAttendance.js#materialiseLeaveDays` (PURE, reuses `computeLeaveUnits`).
- Wire into `approve` (and the SoD-collapse auto-approve) inside the existing tx: upsert
  `ON_LEAVE` rows `where isLocked=false`; emit `RETRO_LWP_DEFERRED` for locked days.
- Fix `apply` LWP branch: no `leaveBalanceId`, no soft-hold; assert `UNPAID` never touches a
  balance.
- **Tests:** LWP apply with zero balance succeeds; approval stamps the right `ON_LEAVE`
  days with `lopFraction=1`; half-day LWP → 0.5; LWP over paid-leave → only LWP-half LOP;
  retro into locked day defers; idempotent re-approve.

### Slice 16d — LOP roll-up split + payslip/run-review visibility
- `rollupEmployee`: split `lwpDays`/`absentDays`; persist to `AttendancePayInput` +
  `PayRunLine`.
- Engine: emit an informational `LOP` line (`days × per-day rate`, `showOnPayslip`, **not**
  summed into deductions/net). Payslip snapshot + PDF render it + the provenance block.
- Run-review: per-employee day chips + `LWP_LOP_APPLIED` INFO anomaly.
- **Tests:** payslip snapshot has the LOP line and net unchanged by it; provenance days
  reconcile (`payable+lwp+absent+halfLop+weekoff+holiday = calendar`).

### Slice 16e — End-to-end golden + edge cases + ESS estimate
- Full vertical golden: India employee, 31-day month, 3 LWP + 1 ABSENT → exact prorated
  gross, PF/ESI/PT/TDS recomputed on prorated gross, net to the paise.
- Edge: full-LOP month (zero net, statutory floor handling); mid-month join/exit; sandwiched
  LWP; negative-net gate.
- ESS apply-time pay-reduction estimate (labelled estimate).
- **Tests:** the golden + each edge as a named case; RBAC tests for the new config endpoints.

### Slice 16f (optional, roadmap-adjacent) — NZ Holidays-Act flag-off
- Ensure NZ tenants never see LWP-IN config or IN proration basis; document the NZ
  unpaid-leave / Holidays-Act path as roadmap (§11). Mostly assertions + UI gating; no NZ
  build.

---

## 9. Test matrix (golden, paise-exact, PURE where possible)

- **Floor resolver** — EL/SL/CL floors per state + effective date; below-floor policy rejected.
- **LWP type coherence** — forced `isPaid=false`/`affectsLOP=true`; paid+affectsLOP rejected.
- **`materialiseLeaveDays`** — full LWP, half-day boundary, sandwiched holiday EXCLUSIVE,
  LWP-over-paid-leave per-half, weekoff skipped.
- **`rollupEmployee`** — LWP→`lwpDays`+`lopDays`; ABSENT→`absentDays`+`lopDays`; reconcile
  identity `payable+lop = standard`.
- **`buildEmployeePayInput`** — frozen ZERO payableDays reaches the engine (M1 regression);
  proration basis mapping.
- **Engine proration** — each basis to the paise; `FIXED_REGARDLESS` allowance unreduced;
  full-LOP → 0 earnings; negative-net BLOCKER.
- **`india.compute` on prorated gross** — PF/ESI/PT/TDS all shrink with LOP; PF admin ₹500
  floor + PT behaviour on zero/near-zero gross.
- **Approval idempotency / retro-into-locked** — frozen day untouched, `RETRO_LWP_DEFERRED`.
- **RBAC** — config endpoints gated; ESS apply self-only; run approve maker≠checker.

---

## 10. Why this is the right design (architectural notes)

- **LOP = reduced earnings, never a deduction.** The engine prorates earnings down; PF/ESI/
  TDS then key off the *already-reduced* gross. Modelling LOP as a deduction line would
  double-count (reduce gross AND deduct) and would tax/PF on the wrong base. The
  informational `LOP` line preserves explainability without touching the money graph.
- **LWP rides the existing `affectsLOP` seam** — one seeded type, zero new code-paths in the
  hot loop; the only genuinely new code is the *eager* approval→attendance bridge, which
  removes a real race (approval can precede the nightly derive).
- **`standardDays` is frozen into `inputHash`** so the proration denominator is immutable
  and auditable — a month-length or basis change can never silently re-value a closed run.
- **Statutory floors are *resolved*, not hard-coded in the UI**, exactly like
  `india.professionalTax.states`, so they are effective-dated and testable.

---

## 11. Roadmap (NZ — explicitly out of scope, never surfaced for IN tenants)

- **NZ Holidays Act 2003** unpaid-leave & leave-without-pay interactions: an extended LWP
  period (>1 week) can affect the **12-month anniversary** for annual-holiday entitlement
  and the **AWE/OWP averaging windows** — NZ proration is hourly/holidays-based, not
  monthly-calendar. This needs the NZ module's RDP/ADP/AWE machinery, not IN calendar
  proration. Roadmap only.
- NZ does not use the EL/SL/CL/PF/PT framework at all; the single-country invariant keeps
  every IN artefact in this feature invisible to NZ tenants and vice-versa.

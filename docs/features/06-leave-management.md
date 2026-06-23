# Feature 6 — Leave Management (DriftHR · IN + NZ)

**Status:** Build-ready spec. Single source of truth for the leave-management vertical.
**Owner:** HR platform. **Date:** 2026-06-23. **Branch base:** `development`.
**Countries:** India (IN) + New Zealand (NZ, Holidays Act 2003).

This spec synthesises three research passes (machinery audit, engine design, per-role UX)
into one shippable developer contract. It **extends shipped schema and code** — no rebuild.
Every cited path was verified against the live tree on 2026-06-23 (see §9 corrections).

---

## 1. Summary & Goals

DriftHR already ships a production-grade **leave ledger, request state-machine, F1 RBAC
scoping, and the attendance/FnF bridges**. The schema (`LeaveType`, `LeavePolicy`,
`AccrualRule`, `LeavePolicyAssignment`, `LeaveBalance`, `LeaveTransaction`, `Holiday`) is
complete and well-modelled. What is missing is the **entitlement lifecycle** and the **usable
UIs**. Feature 6 builds exactly that, reusing every existing seam.

**Goals:**

1. **One pure accrual engine** (`backend/src/hr/leave/accrual.js`) — monthly/upfront/anniversary/
   worked-hours/NZ-continuous accrual, carry-forward, lapse, tenure-tiered rates. Pure, DB-free,
   `node --test`-able like `attendance/derive.js` and `payroll/compliance/holidaysAct.js`.
2. **Harden apply→approve** in the existing controller — working-day-aware day count (holiday/
   weekoff netting), policy gates (notice/consecutive/tenure/gender/balance/negative-cap),
   overlap detection, post-approval withdraw, all preserving the append-only ledger and SoD.
3. **Close the three integration gaps** the audit found: (a) no accrual/lapse cron writer,
   (b) encashment never writes back to the leave ledger on FnF settle, (c) the LOP→payroll
   bridge is correct and is reused as-is.
4. **Build the config + self-service UIs** — hr-admin type/policy config, calendar, year-end
   run, balance adjust; ESS apply/balances/history/calendar. Fix the two live frontend bugs
   (ESS balance renders 0; admin config tabs are 2-field stubs).

**Non-goals (deferred):** advanced multi-branch approval-workflow *designer* UI (the
`workflowDefinitionId` chain is honoured server-side but configured via JSON, not a visual
builder); leave-forecasting/what-if; mobile parity beyond keeping `hr-mobile/LeaveScreen.js`
functional against the corrected payload.

---

## 2. Scope — In / Out

### 2.1 REUSE as-is (do not rebuild — verified production-grade)

| Asset | Path | What it gives us |
|---|---|---|
| All 7 Prisma models + `Holiday` | `backend/prisma/schema.prisma:7416-7720`, `:7722` | ledger, balance projection, policy/accrual config, holiday calendar |
| Request flow + soft-hold + SoD | `backend/src/hr/controllers/leave.controller.js` | `createRequest`/`approve`/`reject`/`cancel`, `pendingApproval` hold, `resolveApprover`, append-only |
| F1 scoping | `backend/src/hr/lib/scopeResolver.js`, `backend/src/hr/middleware/scope.middleware.js` | `scopeWhere`/`scopeAllows`, `withEmployeeScope`, `canApproveLeave` self-exclusion (SoD), IDOR-safe 404 |
| Routes | `backend/src/hr/routes/leave.routes.js` → mounted `backend/src/hr/routes/index.js` → `/api/hr/leave/*` | `protect`+`attachSelfEmployee` global |
| Attendance leave bridge | `backend/src/hr/attendance/service.js:114,252`, `attendance/derive.js:90-125` | `resolveLeaveForDay → {fraction, affectsLOP, half}` → `ON_LEAVE`/`HALF_DAY`, holiday precedence — **complete & correct** |
| Pure resolvers | `backend/src/hr/attendance/derive.js` (`isWeeklyOff`, `isHoliday`, `daysBetweenInclusive`) | leave & attendance must agree on "what is a working day" |
| NZ valuation | `backend/src/hr/payroll/compliance/holidaysAct.js#valueLeave` | OWP/AWE/RDP/ADP four-rate engine, integer micro-cents |
| FnF encashment math | `backend/src/hr/lifecycle/fnf.js:102` `computeLeaveEncashment`, `:222-238` NZ payout | IN `days×(Basic+DA)/26`, NZ `max(OWP,AWE)`+8% |
| Provisioning seed | `backend/src/hr/lifecycle/provision.js:560-584` | seeds zero `LeaveBalance` per applicable type at hire |
| LOP→payroll | `backend/src/hr/payroll/engine.js` `LOP_BEHAVIOR`, `payrun.js` `lopDays` | money is entirely the engine's job; leave only sets `ON_LEAVE` vs LWP |
| Seed data | `backend/prisma/seed-hr.js:455-504,730` | EL/SL/NZ-ANNUAL types + policies + opening balances |

### 2.2 BUILD (the real work)

- **ONE accrual engine** + its cron driver + carry-forward/lapse year-end run.
- **Apply-time hardening** (working-day netting, policy gates, overlap, withdraw).
- **Encashment write-back** into the leave ledger on FnF settle.
- **6 new endpoints** (calendar, carry-forward run, balance adjust, reports, request history,
  ESS self-list) — all reusing `scopeWhere`/`scopeAllows`.
- **Config + ESS UIs** (replace stubs, fix the two payload bugs).

### 2.3 OUT (deferred)

Visual approval-workflow designer; leave forecasting; `autoApproveLeave` auto-approval path
(column exists but stays unwired this feature — fail-closed remains the default; see §9).

---

## 3. Data Model (additive only — no breaking changes)

**No new tables.** The scaffold is complete. The following are the authoritative shapes
(verified in `backend/prisma/schema.prisma`). Optional additive columns are flagged; ship
them only if the implementing engineer needs them — they are not required for v1.

### 3.1 Existing models (cite, do not recreate)

- **`LeaveType`** `:7416` — `countryCode CHAR(2)?` (NULL=both), `code`, `name`, `category`
  (`LeaveCategory` enum `:7445`), `unit` (`LeaveUnit` DAYS/HOURS/WEEKS `:7462`), `isPaid`,
  `isStatutory`, **`nzPayBasis`** (`NZLeavePayBasis` RDP/ADP/AWE_8PCT/OWP `:7467`),
  `requiresReason`, `affectsLOP`, `isEncashable`, `color`, `isActive`, soft-delete, `version`.
  `@@unique([businessId, code])`.
- **`LeavePolicy`** `:7474` — `leaveTypeId`, `entityId?`, `accrualMethod` (`AccrualMethod`
  UPFRONT_ANNUAL/MONTHLY_ACCRUAL/ANNIVERSARY_GRANT/WORKED_HOURS_RATIO/CONTINUOUS_NZ),
  `entitlementPerYear`, `accrualFrequency`, `accrualProrateOnJoin`, `carryForwardCap`,
  `carryForwardExpiryMonths`, `maxBalanceCap`, `maxConsecutive`, `minNoticeDays`,
  `allowNegative`+`negativeCap`, `minTenureMonths`, `appliesToEmploymentTypes` (CSV),
  `genderRestriction`, `encashOnExit`, `encashFormula`, `workflowDefinitionId`.
- **`AccrualRule`** `:7532` — `(leavePolicyId, minTenureMonths, maxTenureMonths?, ratePerPeriod)`
  tenure-tiered accrual. **`LeavePolicyAssignment`** `:7546` — `scope` (`AssignmentScope`
  ENTITY/DEPARTMENT/GRADE/EMPLOYMENT_TYPE/EMPLOYEE), `scopeRefId`, `effectiveFrom/To`.
- **`LeaveBalance`** `:7572` — one per `(businessId, employeeId, leaveTypeId, periodCode)`,
  `@@unique`. Buckets `Decimal(10,4)`: `opening`, `accrued`, `taken`, `pendingApproval`,
  `encashed`, `lapsed`, `adjusted`, `closing`. Plus `nzAccruedGrossEarnings Decimal(15,2)?`,
  `lastAccrualAt`, `version`.
  **⚠ There is NO `carryForward` column** — carried-in units are folded into `opening` by the
  year-end run (see §9 correction 1). Do not reference `balance.carryForward` in code/UI.
- **`LeaveTransaction`** `:7603` — append-only ledger. `txnType` (`LeaveTxnType` ACCRUAL/
  APPLICATION/CANCELLATION/ENCASHMENT/LAPSE/ADJUSTMENT/OPENING_BALANCE), `unit`, signed
  `quantity`, `leaveBalanceId?`, `startDate/endDate`, `startHalf/endHalf` (`DayHalf`),
  `reason` (`@pii:sensitive`), `nzPayBasisUsed`, `paidAmount`, `status` (`LeaveTxnStatus`
  DRAFT/PENDING/APPROVED/REJECTED/CANCELLED/WITHDRAWN/AVAILED), `approvalRequestId`,
  `appliedAt`, `decidedAt`, `decidedBy`, `payRunId`, `version`.
- **`Holiday`** (F2) `:7722` — `date`, `name`, `HolidayType`, `countryCode`, `isPaid`,
  `isRestricted`, `scopeKey` (most-specific entity:location). NZ Mondayisation in
  `holidays.controller.js:151-171`.

### 3.2 Optional additive columns (ship only if needed; both nullable, default-safe)

- `LeaveType.sandwichPolicy` enum `{INCLUSIVE, EXCLUSIVE}` default per-country (IN EL=INCLUSIVE,
  NZ=EXCLUSIVE). If omitted, derive sandwich behaviour from `countryCode` (NZ⇒EXCLUSIVE).
- `LeavePolicy.maxEncashCap Decimal(8,4)?` — cap encashable units (else unbounded).
- A carried-lot expiry tag for §4.5 FIFO lapse: either a nullable `LeaveTransaction.expiresAt`
  on the `OPENING_BALANCE` row, or compute expiry as `periodRoll + carryForwardExpiryMonths`
  at lapse time (no column needed). **Prefer the compute-at-lapse approach for v1** (zero
  migration).

> Any migration here is **additive, nullable, default-safe**. No column is renamed or dropped.

---

## 4. Backend

### 4.1 Module layout (pure engines + thin orchestration)

```
backend/src/hr/leave/
  accrual.js     # PURE: prorataOnJoin, accrueForPeriod, tieredRate, yearEndRoll, encashableUnits
  ledger.js      # PURE: closing identity, signed-quantity reducer, available-to-apply
  calendar.js    # PURE: computeLeaveUnits (working-day/sandwich day-count, half-day fractions)
  validators.js  # PURE: policy gates → structured reason codes
  policyResolver.js # resolve LeavePolicyAssignment most-specific-wins (DB read, thin)
  accrualRunner.js  # cron orchestrator: loads ctx, calls accrual.js, writes ledger in $txn
  __tests__/     # node --test golden + reconcile + rbac + calendar
```

Controller (`backend/src/hr/controllers/leave.controller.js`) orchestrates DB + `$transaction`;
all math lives in the pure modules. This mirrors the payroll house style (pure `engine.js` +
orchestrating controller) and `derive.js`.

### 4.2 The balance ledger — the core invariant (`ledger.js`)

`LeaveBalance` is a **persisted projection** of the append-only `LeaveTransaction` ledger.
The persisted `closing` exists for fast ESS reads but **must always equal** the signed
reduction over the ledger. This is the single most important correctness property.

**Closing identity (must hold after every transaction):**

```
closing = opening + accrued − taken − encashed − lapsed + adjusted
```

(Carried-in units live in `opening`; there is no separate `carryForward` bucket.)

**Available-to-apply (what the apply flow checks):**

```
available = closing − pendingApproval + (allowNegative ? negativeCap : 0)
```

**Ledger-reconstruction invariant (audited by `leave.reconcile.test.js`):**

```
closing == Σ signedQuantity over all ledger rows for that balance lot, where:
  OPENING_BALANCE → +q
  ACCRUAL         → +q
  APPLICATION     → −|q|   (only when status ∈ {APPROVED, AVAILED})
  ENCASHMENT      → −|q|
  LAPSE           → −|q|
  ADJUSTMENT      → ±q     (signed)
pendingApproval is a soft-hold (PENDING applications) and is NOT part of closing.
```

**Precision:** hold day/week math as **integer thousandths (×1000)** internally to avoid
1/12-accrual float drift; round to the policy grain (typically 0.5) only at the period
boundary — the "scale-internally, round-at-boundary" discipline of `holidaysAct.js`
(micro-cents) and the payroll engine (minor units). Persisted columns are `Decimal(10,4)`,
exact.

### 4.3 Accrual engine (`accrual.js`, pure)

```
prorataOnJoin(policy, joinDate, periodStart, periodEnd) -> units
  UPFRONT_ANNUAL : entitlement × (remainingDays / totalDays)
  MONTHLY_ACCRUAL: 0 on join unless joinDay ≤ cutoff (IN convention: ≤15th ⇒ month counts)

accrueForPeriod(policy, accrualRules, ctx) -> units
  rate = tieredRate(accrualRules, ctx.tenureMonths) ?? entitlementPerYear / periodsPerYear
  raw  = rate × eligibilityFactor          // LWP months may zero a tick
  // WORKED_HOURS_RATIO (IN factory §79 = 1 per 20 worked days): raw = workedDays/20
  // CONTINUOUS_NZ annual: accrue notional 4/52 week per week; DOES NOT vest before 12 mo
  return capToBalance(raw, policy.maxBalanceCap, currentClosing)

tieredRate(rules, tenureMonths) -> rate     // AccrualRule whose [min,max] covers tenure (most-specific)

yearEndRoll(policy, closing) -> { carried, lapsed }
  carried = min(closing, policy.carryForwardCap ?? closing)   // null cap = unbounded (NZ annual)
  lapsed  = closing − carried

encashableUnits(policy, balance) -> units
  = policy.isEncashable ? min(balance.closing, policy.maxEncashCap ?? ∞) : 0
```

**Accrual state machine** (drives the cron; emits append-only `OPENING_BALANCE`/`ACCRUAL`/`LAPSE`):

```
INITIALISED → ACCURING → PERIOD_END → ROLLED → (EXPIRING)
  ↑ employee joins / period rolls   ↑ each tick    ↑ year-end roll    ↑ carried-lot expiry
  posts OPENING_BALANCE             posts ACCRUAL   splits carried/    posts LAPSE
  (prorataOnJoin / carry-in)        stamps          lapsed → LAPSE     (FIFO oldest lot)
                                    lastAccrualAt    new period opening
  employee exits → FROZEN: no more accrual; encashableUnits feeds FnF; balance archived.
```

**Idempotency (the cron invariant):** every accrual tick is keyed on `lastAccrualAt` +
`periodCode`. Re-running the nightly job for the same window is a no-op (no duplicate ACCRUAL
row) — identical to `derive`'s "same ctx → identical DerivedDay" and the payrun idempotency
key. Implementation: `WHERE lastAccrualAt < tickPeriodStart` guards the increment inside the
`$transaction`; the insert carries a deterministic dedupe tuple
`(employeeId, leaveTypeId, periodCode, ACCRUAL, tickSeq)`.

**NZ money valuation:** `nzAccruedGrossEarnings` on `LeaveBalance` accumulates gross earnings
so AWE/8% is available without re-querying payroll history; `valueLeave('ANNUAL_HOLIDAY_VESTED', …)`
consumes it at payout.

### 4.4 Accrual runner (cron, `accrualRunner.js`)

Register in `initScheduler()` at **`backend/src/core/lib/scheduler.js`** (the file required at
`backend/src/index.js:48`; existing jobs at `scheduler.js:898-922` — there are **no** leave
jobs today; `node-cron` is already a dependency). Two jobs:

- **Nightly accrual** (`0 1 * * *`): for each active employee×assigned-policy, if a tick is
  due (`lastAccrualAt < tickStart`), `accrueForPeriod` → write ACCRUAL + bump `accrued`/`closing`,
  stamp `lastAccrualAt`, all in one `$transaction` with `version` optimistic lock.
- **Year-end / anniversary roll** (`0 2 * * *`, gated to roll dates): `yearEndRoll` → write
  LAPSE for overflow, mint next-period `OPENING_BALANCE` with carried units folded into
  `opening`. Also runs carried-lot FIFO expiry (§4.5). This same logic backs the manual
  `POST /runs/carry-forward` endpoint (§4.8) so admins can preview (`dryRun`) and trigger.

Per-tenant, per-country period codes: IN financial year `"2026-27"`; NZ anniversary
`"2026-ANNIV"` keyed off the employee's start-date anniversary.

### 4.5 Lapse semantics

Two LAPSE triggers: (1) **year-end cap overflow** `closing − carryForwardCap`; (2)
**carry-forward expiry** — a carried lot unused within `carryForwardExpiryMonths` lapses,
tracked FIFO (oldest opening lot consumed first; expiry tested on the residual). CL typically
`carryForwardCap=0` ⇒ all closing lapses yearly. **NZ annual leave never lapses** (Holidays
Act has no use-it-or-lose-it on the 4-week minimum) — enforce with `carryForwardCap=null`.

### 4.6 Apply → approve service (harden `leave.controller.js`)

The two-phase soft-hold already exists. Add the pre-apply guard and post-approval withdraw;
keep everything append-only.

```
APPLY    (createRequest): compute units via calendar.js (NOT naive spanDays);
         run validators.js; guard available ≥ units (else 409 unless allowNegative & ≤negativeCap);
         create APPLICATION (status=PENDING, quantity=−units); pendingApproval += units.
APPROVE  (approveRequest): PENDING→APPROVED; pendingApproval −= units; taken += units; closing −= units.
REJECT   (rejectRequest):  PENDING→REJECTED; pendingApproval −= units (no consumption); persist reason.
CANCEL   (pre-decision):   PENDING→CANCELLED; pendingApproval −= units.
WITHDRAW (post-approval, NEW): APPROVED→WITHDRAWN; emit reversing ADJUSTMENT +units;
         taken −= units; closing += units — ONLY if the covered day is not in a CLOSED pay run /
         frozen attendance; else block and settle as a next-period credit.
```

**Day-counting (`calendar.js`) replaces naive `spanDays`** (`leave.controller.js:119` counts
raw calendar days, charging weekends/holidays inside a range):

```
computeLeaveUnits(req, ctx) -> { units, dayBreakdown[] }
  for each civil day D in [startDate, endDate]:
    weekoff = isWeeklyOff(D, shift.weeklyOffDays)             // reuse derive.js
    holiday = isHoliday(emp, D, holidays, optedRestricted)    // reuse derive.js
    if leading/trailing weekoff|holiday → skip (0 units)
    else if interior weekoff|holiday → sandwich==INCLUSIVE ? debit 1 : debit 0
    else workingDay → fraction = (D==start&&startHalf)||(D==end&&endHalf) ? 0.5 : 1.0
  units = Σ fractions
```

Reuse the exported `isWeeklyOff`/`isHoliday`/`daysBetweenInclusive` from `derive.js` so leave
and attendance can never disagree about a working day. **Sandwich:** IN EL = INCLUSIVE
(interior holidays debited); NZ = EXCLUSIVE (a public holiday inside an annual-leave block is
paid as a public holiday, never debited — Holidays Act requirement).

**Pre-apply validators (`validators.js`)** — house style from `lifecycle/validators.js`,
return structured reason codes:

| Check | Source | Fail code |
|---|---|---|
| `minNoticeDays` (back-date only SICK/BEREAVEMENT/FV or HR override) | policy | `NOTICE_TOO_SHORT` |
| `maxConsecutive` | policy | `EXCEEDS_MAX_CONSECUTIVE` |
| `available ≥ units` (unless advance) | ledger | `INSUFFICIENT_BALANCE` |
| `negativeCap` | policy | `NEGATIVE_CAP_EXCEEDED` |
| `minTenureMonths` (NZ annual 12mo / sick 6mo) | policy+join | `NOT_VESTED` |
| `genderRestriction` | policy+employee | `GENDER_INELIGIBLE` |
| `appliesToEmploymentTypes` | policy | `TYPE_INELIGIBLE` |
| `requiresReason` | type | `REASON_REQUIRED` |
| overlap with existing PENDING/APPROVED leave | ledger | `OVERLAPPING_LEAVE` |

**Approval routing + SoD (already wired — keep):** `resolveApprover(applicant)` → MANAGER →
ESCALATED ancestor → HR_ADMIN → NONE drives the inbox/notification. The authoritative gate is
`scopeWhere`/`scopeAllows` with `canApproveLeave` **excluding self**; out-of-scope/self →
**404** (IDOR-safe). **Fail-closed:** no resolvable approver and no HR-Admin ⇒ request cannot
be approved (no auto-approve this feature). `workflowDefinitionId` enables N-step chains
(e.g. manager→dept-head for >10 consecutive days), each step routed via `resolveApprover` ascent.

**Back-dated & LWP:** back-date permitted for SICK/BEREAVEMENT/FV and HR adjustments; blocked
for ANNUAL beyond a grace window. If a covered day is already in a **CLOSED pay run / frozen
attendance**, apply succeeds but the financial effect defers to the next open period (arrears)
— never rewriting closed payroll (`payrun.js` "Closed runs are immutable"; monotonic
attendance freeze). **LWP** = a `UNPAID` type with `affectsLOP=true`, **no balance**: applying
records an APPLICATION row; LOP is realised in attendance derivation → payroll (§4.10).

### 4.7 Policy resolution (`policyResolver.js`)

`LeavePolicyAssignment` is unused by the request flow today. Resolve most-specific-wins
(mirrors `isHoliday` scope ranking), reusing `scopeResolver.js` patterns:

```
rank = EMPLOYEE(4) > GRADE(3) > DEPARTMENT(2) > EMPLOYMENT_TYPE(1) > ENTITY(0)
resolvePolicy(emp, leaveTypeId, asOf) =
  highest-rank assignment whose [effectiveFrom, effectiveTo] covers asOf,
  for a LeavePolicy of that leaveTypeId; tie-break = latest effectiveFrom.
```

This feeds both accrual rates (with `AccrualRule` tiers) and apply-time gates.

### 4.8 New endpoints (all reuse `scopeWhere`/`scopeAllows`; lists use `{items,total,page,pageSize}`)

| Endpoint | Purpose | Gate |
|---|---|---|
| `GET /api/hr/leave/calendar?from&to&entityId&leaveTypeId&includePending` | Org/team leave calendar (approved+pending), scope-filtered server-side | `withEmployeeScope('canViewEmployees')` |
| `GET /api/hr/leave/me/requests?status&page&pageSize` | **ESS self-list** — own requests; `employeeId` from `attachSelfEmployee`, no `canViewEmployees` widening | self |
| `POST /api/hr/leave/runs/carry-forward {periodCode, leaveTypeId?, dryRun}` | Year-end run → carries/lapses per cap+expiry, append-only ledger rows | `requirePermission('canManageOrg')` |
| `GET /api/hr/leave/runs/carry-forward/:id` | Run status + line results | `canManageOrg` |
| `POST /api/hr/leave/balances/adjust {employeeId, leaveTypeId, periodCode, delta, reason}` | Audited manual adjustment → ADJUSTMENT row + `adjusted`/`closing` | `canManageOrg` (new `canAdjustLeaveBalance` preferred) |
| `GET /api/hr/leave/reports/summary?from&to&entityId&groupBy` | Aggregate (by type/dept/month: taken, pending, balance, LOP) | `canViewReports`/`canManageOrg` |
| `GET /api/hr/leave/requests/:id/history` | Per-request audit trail | `withEmployeeScope('canViewEmployees')` (scope) |

Carry-forward and adjust **write append-only ledger rows** (never edit). `dryRun` writes
nothing.

### 4.9 Zod validation — fix the stale schema

`backend/src/core/lib/schemas/leave.schema.js` validates a booking-era single-`date` shape
(`requestLeaveSchema`), is **not imported by the route**, and does **not** match the
`{startDate, endDate, leaveTypeId, startHalf?, endHalf?}` the controller accepts. Replace it
with a `createLeaveRequestSchema` matching the live shape and wire it into `POST /requests`.

### 4.10 LOP → payroll (reuse — no money written here)

Seam is correct and stays: `service.js#resolveLeaveForDay → {fraction, affectsLOP, half}` →
`derive.js#classify` → `ON_LEAVE` (`lopFraction = affectsLOP ? 1 : 0`) / `HALF_DAY`. Only
**APPROVED/AVAILED** APPLICATION rows feed `derive` (pending holds must not suppress an
absence). `affectsLOP` is the OR across covering txns, fraction capped at 1
(`service.js:143`). `derive` emits `lopFraction` → attendance aggregates `lopDays` → payrun
line `lopDays` (`payrun.js:387`) → engine `LOP` op (`engine.js:384-407`,
`LOP_BEHAVIOR.REDUCES_WITH_LOP`). **Leave Management writes no money for in-period leave.** NZ
public-holiday / annual-leave *payment* is valued by `holidaysAct.js#valueLeave` at run time
and snapshotted onto the txn (`nzPayBasisUsed`, `paidAmount`), surfaced as a payslip earning.

### 4.11 Encashment → FnF write-back (CLOSE THE GAP)

**Gap (verified):** `backend/src/hr/lifecycle/controllers/offboarding.controller.js`
`settleSeparation` (`:766`) reads `encashableLeaveDays` (`resolveEncashableLeaveDays:231`) and
mints FnF PayRun lines (`:518,573`) but **never writes an `ENCASHMENT` LeaveTransaction nor
updates `LeaveBalance.encashed`/`closing`** — the balance is left stale after settlement
(ledger/payroll divergence).

**Fix:** inside the `settleSeparation` `$transaction` (after FnF approval, alongside
`settleEmployeeTermination` at `:813`), for each encashable balance post an `ENCASHMENT` txn
(`quantity = −encashedUnits`, `payRunId` stamped) and bump `encashed` / decrement `closing`
(via the `encashed` bucket, **never** `taken`). Then the §4.2 ledger identity still closes
after the payout. IN: `computeLeaveEncashment` = `encashableLeaveDays × (Basic+DA)/26`. NZ:
`computeNzHolidayPayout` = untaken **vested** annual leave at `max(OWP,AWE)` + 8% PAYG on the
pre-entitlement slice. The FnF run posts `FNF_LEAVE_ENCASH` / `FNF_NZ_HOLIDAY_PAYOUT` earnings;
the reconciler asserts no day is both `taken` and `encashed`.

---

## 5. Frontend

### 5.1 hr-admin — `apps/hr-admin/app/leave/page.js` (3 tabs → 5)

Reuse `PageHeader`, `Tabs`, `DataTable`, `StatusBadge`, `ActionButton`, `Spinner`,
`ErrorBanner`, `PrimaryButton`, `TextInput`, `formatAdminDate` from `@/lib/ui` + `@hr/ui`.
Tabs: **`[ Requests | Calendar | Leave types | Policies | Year-end & adjustments ]`**.
Manager band (TEAM scope, no `canManageOrg`) sees only **`[ Requests | Team calendar ]`**;
hide `canManageOrg` tabs when the session lacks the permission.

- **Requests** (extend existing — approve/reject already wired): add leave-type filter,
  employee search, a **detail drawer** (`GET /requests/:id` + `/history`) with reason,
  half-day flags, timestamps, decider, balance-impact preview. Reject opens a reason textarea.
  Fix the columns that read non-existent fallback fields (`r.days`/`r.numDays`) — the API
  returns `quantity`; render `Math.abs(quantity)`.
- **Calendar** (new): month grid, chips coloured by `leaveType.color`, "who's out" rail,
  include-pending toggle. `GET /calendar` (ALL for admin, sub-tree for manager).
- **Leave types** (replace 2-field stub `ConfigTab:136`): full allow-list form — `name, code,
  category, unit, isPaid, isStatutory, requiresReason, affectsLOP, isEncashable, color,
  countryCode, nzPayBasis`. Validate IN×`unit=WEEKS` and `nzPayBasis` on IN as errors. P2002→
  inline `code` field error.
- **Policies** (replace stub): sectioned form — Entitlement & accrual / Carry-forward / Request
  rules / Eligibility / Exit. `leaveTypeId` is a select fed by `/types`. These values are what
  ESS apply reads for hints + pre-validation.
- **Year-end & adjustments** (new, highest-trust): carry-forward runner with **dry-run default
  ON** + confirm modal + result table; audited balance-adjust form (mandatory reason, before/
  after preview, adjustment history). `POST /runs/carry-forward`, `POST /balances/adjust`.

### 5.2 ESS — `apps/ess/app/leave/page.js` (rebuild to 4 tabs)

Reuse `AppShell`, `useSession`, `useApi`, `apiPost`, `@hr/ui` (`ErrorBanner`, `Empty`,
`Spinner`, `Centered`), `@/lib/format`. Tabs: **`[ Apply | My balances | My requests | Calendar ]`**.

- **Apply** (enhance): live balance strip for selected type, policy hints (notice/consecutive/
  paid/requiresReason), date range **+ half-day controls** (`startHalf`/`endHalf` — already
  server-side, just expose), live computed days, reason (required when `requiresReason`),
  advisory client pre-validation (server authoritative).
- **My balances** (FIX THE BUG): the card reads `b.available ?? b.balance ?? b.remaining`
  (`apps/ess/app/leave/page.js:88`) — the API returns **none** of those keys, so balances
  render `0`. Compute **`available = closing − pendingApproval`** from the real payload and
  show the breakdown (`opening`, `accrued`, `taken`, `pendingApproval`, `lapsed`). There is no
  `carryForward` field — carried units are in `opening`.
- **My requests** (new): `GET /me/requests`; PENDING rows show Withdraw → `POST /requests/:id/
  cancel` → refetch + reload balances; rejected rows show reason.
- **Calendar** (new): own approved (solid) / pending (muted) + public holidays (distinct, don't
  count against balance) + half-day half-chips.

### 5.3 mobile — `apps/hr-mobile/src/screens/LeaveScreen.js`

Keep functional against the corrected `{startDate,endDate,startHalf?,endHalf?}` payload and
the real balance keys (`closing`/`pendingApproval`). Same two bug-fixes as ESS apply when it
shares the booking-era shape.

---

## 6. End-to-End per role + acceptance

### Employee (ESS)
Apply/cancel own, see own balances+history+calendar. **Own request never self-approves**
(routes up-chain). Acceptance: (1) apply creates PENDING and Available drops by held amount
immediately; (2) half-day yields correct fractional `quantity`; (3) `requiresReason` blocks
submit client+server; (4) withdraw moves PENDING→CANCELLED and releases the hold; (5) balances
show `closing − pendingApproval`, never raw closing.

### Manager (F1 TEAM band, in hr-admin)
`canApproveLeave` + `canViewEmployees` at TEAM scope (recursive reporting sub-tree). Sees the
**same page**, server-narrowed; **excluded from approving self** (SoD). Acceptance: (1) sees
direct **and** indirect reports' requests; (2) cannot approve own (button absent, direct POST
404s); (3) approving a report decrements that report's balance + clears hold; (4) two
overlapping-scope approvers — second gets `409` "already actioned"; (5) team calendar/balances
are sub-tree only; out-of-sub-tree `employeeId` → 404.

### HR-Admin (ALL scope)
Every request/balance/config. Acceptance: (1) pending-count badge = `total` for
`status=PENDING`; (2) type/policy config writes persist with full allow-list; (3) carry-forward
**dry-run writes nothing**, live run carries `min(closing, cap)` into next `opening`, lapses the
rest, append-only, idempotent/blocked on re-run; (4) balance adjust requires reason (client+
server `400`), appears as a new ADJUSTMENT row with actor; (5) soft-deleted type disappears
from lists/dropdowns but historic requests keep its name.

---

## 7. QA Plan (numbered; matches repo golden-test posture)

Pure `node --test`, no DB, like `derive.js`/`holidaysAct.js`:

1. **Accrual golden** (`leave/__tests__/accrual.golden.test.js`) — pro-rata join; 12-month
   monthly accrual sums to entitlement; tiered `AccrualRule` switch at tenure boundary; UPFRONT
   vs MONTHLY; `maxBalanceCap` clamp.
2. **Carry-forward / lapse math** — `yearEndRoll` carries `min(closing, cap)`, lapses remainder;
   `carryForwardCap=null` (NZ annual) never lapses; CL `cap=0` lapses all; FIFO carried-lot
   expiry.
3. **NZ continuous** — `CONTINUOUS_NZ` accrues but **does not vest before 12 months**;
   `nzAccruedGrossEarnings` accumulates; `valueLeave` consumes it.
4. **Balance ledger integrity** (`leave.reconcile.test.js`) — for every balance, recompute
   `closing` from the ledger signed-quantity reducer and assert the §4.2 identity (leave
   analogue of payroll golden + GL-balanced checks).
5. **Half-day + holiday-spanning** (`calendar.test.js`) — leading/trailing weekoff skipped;
   interior INCLUSIVE debited / EXCLUSIVE not; half-day 0.5 fractions; NZ public holiday inside
   an annual-leave block not debited.
6. **Approval SoD / RBAC scope** (`leave.rbac.test.js`) — self-approval 404; out-of-scope read
   404; manager list = sub-tree only; fail-closed when no approver+no HR-Admin (mirrors
   `attendance.rbac.test.js`).
7. **Negative-balance guard** — `INSUFFICIENT_BALANCE` when `available < units`; advance allowed
   only within `negativeCap`; `NEGATIVE_CAP_EXCEEDED` beyond.
8. **Overlap + notice + eligibility** — `OVERLAPPING_LEAVE`, `NOTICE_TOO_SHORT`,
   `EXCEEDS_MAX_CONSECUTIVE`, `NOT_VESTED`, `GENDER_INELIGIBLE`, `TYPE_INELIGIBLE`,
   `REASON_REQUIRED` each fire on their boundary.
9. **LOP → payroll parity** — `derive` golden gains `ON_LEAVE` (paid ⇒ 0 LOP) / `HALF_DAY` /
   LWP (`affectsLOP` ⇒ `lopFraction=1`) rows; assert `lopDays` flows to the engine `LOP` op.
10. **Encashment ↔ FnF reconcile** — settle posts an `ENCASHMENT` ledger txn that reconciles
    against `FNF_LEAVE_ENCASH`/`FNF_NZ_HOLIDAY_PAYOUT`; `closing→0` via `encashed`, never
    `taken`; reconciler asserts no day both taken and encashed.
11. **Cron idempotency** — re-running nightly accrual for the same window writes no duplicate
    ACCRUAL row (`lastAccrualAt` guard); concurrent applications race the `version` optimistic
    lock; second sees reduced `available`.
12. **Back-dated into CLOSED run** — apply succeeds, financial effect deferred to next open
    period; closed run untouched.

---

## 8. Build Sequence (one pass)

1. **Pure engines + tests first:** `ledger.js`, `accrual.js`, `calendar.js`, `validators.js` +
   QA 1–8 (no DB; fast feedback, like payroll engine).
2. **Policy resolution:** `policyResolver.js` over `LeavePolicyAssignment`.
3. **Controller hardening:** wire `calendar.js`+`validators.js` into `createRequest`; add the
   available-balance guard, advance/negative support, post-approval withdraw; replace stale
   Zod schema (§4.9). QA 7,8.
4. **Cron + year-end:** `accrualRunner.js` + register in `scheduler.js initScheduler()`;
   `POST /runs/carry-forward` (dryRun) shares the roll logic. QA 2,3,11.
5. **Encashment write-back:** in `offboarding.controller.js settleSeparation` `$transaction`.
   QA 10.
6. **New endpoints:** calendar, `/me/requests`, balances/adjust, reports/summary,
   requests/:id/history — all `scopeWhere`/`scopeAllows`. QA 4,6.
7. **Frontend:** ESS balance-key + half-day fixes → ESS 4 tabs → hr-admin 5 tabs (type/policy
   full forms, calendar, year-end). QA 9 (derive golden) alongside.
8. **Reconcile + RBAC test sweep** (QA 4,6,12) green before merge.

---

## 9. Corrections vs the live tree (verified 2026-06-23)

1. **No `LeaveBalance.carryForward` column.** One research input's `closing` formula and ESS
   balance breakdown referenced a `carryForward` bucket; the real schema
   (`schema.prisma:7572`) has only `opening/accrued/taken/pendingApproval/encashed/lapsed/
   adjusted/closing`. **Carried units fold into `opening`.** This spec uses
   `closing = opening + accrued − taken − encashed − lapsed + adjusted` and tells the UI not to
   read `carryForward`.
2. **Scheduler path is `backend/src/core/lib/scheduler.js`** (required at
   `backend/src/index.js:48`; `initScheduler` called at `:380`), not a top-level `scheduler.js`.
   Existing cron jobs are at `scheduler.js:898-922`; **none are leave-related** (the
   `leave`/`lapse` grep hits are the English words). New accrual/roll jobs register here.
3. **Offboarding controller is `backend/src/hr/lifecycle/controllers/offboarding.controller.js`**
   (there is also an unrelated thin file directly under `lifecycle/` — ignore it). The real
   `settleSeparation` is at `:766`, `resolveEncashableLeaveDays` at `:231`,
   `encashableLeaveDays` consumed at `:518,573`. **Confirmed gap:** zero `ENCASHMENT` /
   `leaveTransaction` / `.encashed` writes in this file — the encashment write-back of §4.11 is
   genuinely missing.
4. **`autoApproveLeave` is unwired** — the column exists (Employee/Business) but has **0
   references in `backend/src` or `apps`** (only Prisma client artefacts in node_modules). This
   feature keeps it unwired; fail-closed approval remains the default.
5. **`nzPayBasis` is a real `LeaveType` column** (`schema.prisma:7426`) — it must be in the
   admin type-config allow-list; one input omitted it.
6. **Stale Zod schema confirmed:** `backend/src/core/lib/schemas/leave.schema.js` is the
   booking-era single-`date` `requestLeaveSchema`, not imported by `leave.routes.js`, and does
   not match the controller's `{startDate,endDate,...}` shape. Replace + wire (§4.9).
7. **ESS balance bug confirmed** at `apps/ess/app/leave/page.js:88`
   (`b.available ?? b.balance ?? b.remaining ?? 0`) — none of those keys exist on the
   `/balances` payload, so every card renders `0`. Fix: compute `closing − pendingApproval`.

---

## 10. Reused vs New (one-line ledger)

**Reused as-is:** all 7 Prisma models + `Holiday`; `resolveApprover`; `scopeResolver` SoD;
`derive.js` resolvers + `ON_LEAVE`/`HALF_DAY`; `holidaysAct.js#valueLeave`; `fnf.js`
encashment math; payroll `lopDays`/`LOP_BEHAVIOR`. **New (pure, testable):** `leave/accrual.js`,
`leave/ledger.js`, `leave/calendar.js`, `leave/validators.js`, `leave/policyResolver.js`,
`leave/accrualRunner.js` (+ cron registration) + controller hardening + encashment write-back +
6 endpoints + config/ESS UIs + Zod fix. **Schema:** none required; optional additive nullable
columns only (§3.2).

**Cited files:** `backend/prisma/schema.prisma` (`:7416-7720`, `:7722`),
`backend/src/hr/controllers/leave.controller.js`, `backend/src/hr/routes/leave.routes.js`,
`backend/src/hr/attendance/derive.js`, `backend/src/hr/attendance/service.js`,
`backend/src/hr/lib/scopeResolver.js`, `backend/src/hr/middleware/scope.middleware.js`,
`backend/src/hr/lib/approvalRouting.js`, `backend/src/hr/payroll/compliance/holidaysAct.js`,
`backend/src/hr/payroll/engine.js`, `backend/src/hr/payroll/payrun.js`,
`backend/src/hr/lifecycle/fnf.js`,
`backend/src/hr/lifecycle/controllers/offboarding.controller.js`,
`backend/src/hr/lifecycle/provision.js`, `backend/src/core/lib/scheduler.js`,
`backend/src/core/lib/schemas/leave.schema.js`, `backend/prisma/seed-hr.js`,
`apps/hr-admin/app/leave/page.js`, `apps/ess/app/leave/page.js`,
`apps/hr-mobile/src/screens/LeaveScreen.js`.

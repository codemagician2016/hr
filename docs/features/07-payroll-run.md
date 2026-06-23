# Feature 7 — Payroll Run Experience (India + New Zealand)

**Status:** spec / build-ready
**Owners:** Payroll squad
**Depends on:** F1 (RBAC), F2 (Attendance freeze), F4 (Lifecycle / FnF), F5 (Compensation)
**Last synthesized:** 2026-06-23

> One-line: the compute **engine, state machine, persistence, filing generators, and FnF mint are already built and tested**. Feature 7 is the **operator-workflow shell** around them — the lifecycle past `APPROVED`, a pure **variance/exception engine**, payslip **publish**, country-aware **filing exports**, and the **guided-run UI** (maker → checker → finance) plus ESS payslips.

---

## 1. Summary & goals

DriftHR can compute a payslip to the cent and persist a full per-line explain trace, but an operator cannot actually *run* payroll end-to-end: the run gets stuck at `APPROVED` (no `pay`/`file`/`close`), employees can never see a payslip (nothing flips `GENERATED → PUBLISHED`), there is no variance review, and `NewRunModal` asks operators to type raw UUIDs. Feature 7 closes that gap.

**Goals**
1. Make the run lifecycle reachable end-to-end: `DRAFT → INPUTS_LOCKED → COMPUTED → REVIEW → APPROVED → PAID → FILED → closed`, plus `CANCELLED` (pre-approval) and reject-back edges.
2. Add a **pure variance/exception engine** (`payroll/variance.js`) — period-over-period deltas, anomaly roll-up, BLOCKER/WARNING/INFO severities — feeding the existing `blockingAnomalies` approve guard.
3. **Publish payslips** to ESS (fire the pre-wired webhook + notification) on the disbursement boundary.
4. A **guided-run UI**: entity/calendar pickers → inputs checklist → compute → variance review → maker-checker approve → publish → country-aware filing exports.
5. Enforce SoD (maker ≠ checker), immutability post-approval, idempotent recompute — by mirroring the backend guards in the UI so a user never hits a surprise 409.

**Non-goals (see §3 scope-out):** payment-gateway / direct bank-API integration, Form 16 PDF rendering, a multi-entity "company payroll" rollup, retro-engine for arrears beyond a single linked `ARREAR`/`CORRECTION` run.

---

## 2. Definitions & the lifecycle this UI drives

The engine state names (`payrun.js STATE`) and the Prisma enum (`PayRunStatus`) differ — the UI speaks **schema strings** (what the API returns). Mapping is `STATE_TO_PRISMA` (`payrun.js:61`).

| Engine `STATE` | Prisma `PayRunStatus` | UI label | Actor | Permission |
|---|---|---|---|---|
| `DRAFT` | `DRAFT` | Draft | Maker | `canRunPayroll` |
| `INPUTS_LOCKED` | `INPUTS_LOCKED` | Inputs locked | Maker | `canRunPayroll` |
| `CALCULATED` | `COMPUTED` | Computed | Maker | `canRunPayroll` |
| `CALCULATED` + review flag | `REVIEW` *(net-new use)* | In review | Maker submits / Checker reviews | `canRunPayroll` / `canApprovePayroll` |
| `APPROVED` | `APPROVED` (`LOCKED` sub-flag on publish) | Approved / Locked | Checker | `canApprovePayroll` |
| `PAID` | `PAID` | Paid | Finance | `canApprovePayroll` |
| `FILED` | `FILED` | Filed | Finance | `canViewPayrollReports` (+ filing) |
| `CLOSED` | `FILED` + `closedAt` | Closed | Finance | `canViewPayrollReports` |
| `CANCELLED` | `CANCELLED` | Cancelled | Maker (pre-approval only) | `canRunPayroll` |

> **Correction vs. design drafts (verified against the live tree):**
> - The schema enum is `DRAFT INPUTS_LOCKED COMPUTING COMPUTED REVIEW LOCKED APPROVED PAID FILED CANCELLED` (`schema.prisma:7189`) — there is **no `CLOSED` member**. CLOSED is `FILED` + a `closedAt` flag (already how `STATE_TO_PRISMA` maps it, `payrun.js:67`). `COMPUTING`/`REVIEW`/`LOCKED` exist but are currently **unused** by the engine.
> - The engine `STATE` uses **`CALCULATED`**, not `IN_REVIEW`. There is **no `IN_REVIEW`/`REVIEW` state in `payrun.js TRANSITIONS` today** — inserting the review gate is genuinely net-new (we implement it as the reserved `REVIEW` Prisma value + a `submittedBy`/`reviewedBy` field set, *not* a new engine `STATE` edge unless schema migration is taken; see §4.1).
> - `payDate`, `sequenceInYear`, `taxYear`, `type`, `parentPayRunId`, `complianceVersionId`, `version`, and actor columns (`computedBy/lockedBy/approvedBy/paidAt`) **already exist** on `PayRun` (`schema.prisma:7128–7170`).
> - `StatutoryRemittance` + `RemittanceKind` **already exist** with `taxPeriod`, `dueDate`, `filedDate`, `challanRef`, `fileUrl`, `meta`, `status` (`schema.prisma:7359/7386`) — filing artifacts need **no new model**, only writes.

**Hard rules (backend enforces; UI mirrors):**
- **No state-skipping** — render only `nextStates(from)` buttons (`payrun.js:89`).
- **Maker ≠ checker** — approve 409s `MAKER_CHECKER` when `actorId === computedBy/lockedBy` (`payrun.js:136`). Disable Approve for the maker *before* the click.
- **Blocking anomalies gate approval** — `OPEN_BLOCKERS` 409 (`payrun.js:143`). Disable Approve while `blockingAnomalies > 0`.
- **Idempotency** — recompute with an unchanged `inputHash` is a cached no-op (`computeInputHash` / `assertIdempotentCompute`, `payrun.js:273/283`). Safe to retry.
- **Immutability** — `APPROVED/PAID/FILED/closed` reject recompute/re-open (`IMMUTABLE_RUN_VIOLATION`). UI shows read-only.

---

## 3. Scope

### In scope — REUSE (do not rebuild; consume only)
- **Compute engine** `backend/src/hr/payroll/engine.js` — `computePayslip` (`:109`), 3-pass earnings, statutory-base flags (`:203`), `complianceModule.compute()` seam (`:234`), per-op `computeTrace`, anomalies (`NEGATIVE_NET` BLOCKER `:353`, `RECOVERY_CAPPED_TO_NET` WARNING `:302`).
- **State machine** `backend/src/hr/payroll/payrun.js` — `STATE`/`TRANSITIONS`/`STATE_TO_PRISMA` (`:31/46/61`), guards (`:109–185`), `computeInputHash`/`assertIdempotentCompute` (`:273/283`), and the **currently-unused** `persistTransition`/`persistComputeResult` (`:315/359`) — wire the new endpoints over `persistTransition`, don't re-inline `updateMany`s.
- **Orchestrator** `backend/src/hr/payroll/service.js` — `createRun` (`:429`), `computeRun` (`:592`, already accepts `freezeAttendance`), `persistComputedRun` (`:713`, writes lines+components+rollups+payslip snapshot), `approveRun` (`:888`), list/get/payslip/file fns, `buildFilingAggregate` (`:1113`).
- **Filing generators** `backend/src/hr/payroll/filing/{india.js,newzealand.js}` — IN `generateEcr`/`generateEsic`/`generate24Q`; NZ `generateEmploymentInformation`/`generateBankBatch`. Pure, tested (`filing/__tests__/filing.test.js`).
- **Attendance freeze** `backend/src/hr/attendance/freeze.js` — `freezeAttendance` (`:122`) → `AttendancePayInput`.
- **FnF** `backend/src/hr/lifecycle/fnf.js` — `computeFnf` (`:230`) returns a `PayRun(type=FNF)` `payRunInput`; minted by `offboarding.controller.js:643 approveFnf`.
- **Existing UI** `apps/hr-admin/app/payroll/page.js` (runs list, NewRunModal, RunDetail), `apps/ess/app/payslips/{page.js,[id]/page.js}`.
- **RBAC keys** `backend/src/core/lib/rbac.js:21–23` — `canRunPayroll`, `canApprovePayroll`, `canViewPayrollReports`.

### In scope — BUILD (net-new)
1. **`backend/src/hr/payroll/variance.js`** — pure variance/exception engine (§5.1) + `__tests__/variance.golden.test.js`.
2. **Run-orchestration endpoints** (§5.2) — `inputs-checklist`, `one-time` inputs CRUD, `submit`, `send-back`, `variance`, `publish`, `pay`, `file`, `close`, `cancel`, `reopen` — thin wrappers over `transition`/`persistTransition`; thread `freezeAttendance` through the controller.
3. **Payslip publish** — `GENERATED → PUBLISHED`, fire `webhooks.js payslipPublishedPayload` + `notifications.js HR_PAYSLIP_PUBLISHED`.
4. **Guided-run UI** (§6) in `apps/hr-admin/app/payroll` + ESS refinements (incl. the security fix).
5. Three additive tables (§4.2): `PayRunInputItem` (one-time items), `PayRunVarianceReport` (or reuse `PayRunLine.errorJson` + a run-level Json), `VarianceThreshold` (per-tenant config).

### Out of scope (defer)
- Payment-gateway / direct bank-API disbursement (we generate the **bank file**; treasury uploads it).
- Form 16 / Form 16A **PDF rendering** (we persist the `IN_FORM16` remittance + 24Q Annexure data).
- Multi-entity "company payroll" rollup (each `PayRun.entityId` is single — N entity runs).
- Full retro/arrears engine beyond a single `parentPayRunId`-linked `ARREAR`/`CORRECTION` run.

---

## 4. Data model

### 4.1 Reuse as-is (verified)
`PayRun` (`schema.prisma:7128`) — has `payDate`, `sequenceInYear`, `taxYear`, `type` (`PayRunType`), `status` (`PayRunStatus`), `parentPayRunId`, `complianceVersionId`, `totalGross/Deductions/Net/EmployerCost`, all actor columns, `version`, `@@unique([businessId, code])`. `PayRunLine` (`:7234`, with `computeTrace`/`errorJson`/`bases`/statutory rollup columns), `PayRunLineComponent` (`:7292`), `Payslip` (`:7315`, `snapshotJson` + `status` GENERATED/PUBLISHED/VIEWED), `StatutoryRemittance` (`:7359`) + `RemittanceKind` (`:7386`).

**Review-gate fields:** add to `PayRun` (additive, nullable) — `submittedBy String?`, `submittedAt DateTime?`, `reviewedBy String?`, `sendBackReason String?`, `closedAt DateTime?`, `totalsHash String?`. Use the reserved `REVIEW`/`LOCKED` enum members for the submitted/locked sub-states; no `STATE`-graph migration required if review is modeled as `status = COMPUTED→REVIEW` with these flags (preferred — smallest blast radius). If a strict engine edge is wanted, insert `CALCULATED → IN_REVIEW → APPROVED` into `payrun.js TRANSITIONS` and map `IN_REVIEW → 'REVIEW'`.

### 4.2 Net-new tables (additive migrations)

```prisma
/// One-time / ad-hoc inputs for a run (bonus, ad-hoc deduction, arrear, reimbursement).
/// Editable only while the run is DRAFT; frozen into inputHash at INPUTS_LOCKED.
model PayRunInputItem {
  id          String   @id @default(uuid())
  businessId  String
  payRunId    String
  employeeId  String
  kind        PayRunInputKind        // OTE | OTD | ARREAR | REIMBURSEMENT
  componentCode String?              // target component (null = ad-hoc line)
  amountMinor BigInt                 // integer minor units (paise/cents)
  sourcePeriod String?               // "YYYY-MM" for arrears
  taxable     Boolean  @default(true)
  note        String?
  createdBy   String
  createdAt   DateTime @default(now())
  version     Int      @default(0)
  @@index([businessId, payRunId, employeeId])
}
enum PayRunInputKind { OTE OTD ARREAR REIMBURSEMENT }

/// Per-tenant variance tolerances (overrides DEFAULT_THRESHOLDS in variance.js).
model VarianceThreshold {
  id          String  @id @default(uuid())
  businessId  String  @unique
  config      Json    // { softNetPct, hardNetPct, grossPct, componentPct, lopSpikeDays, absMinFloorMinor, statutoryRateTolerance }
  updatedAt   DateTime @updatedAt
}
```

The **variance report** itself rides existing channels: per-line findings → `PayRunLine.errorJson` (the array `approveRun` already re-reads for `blockingAnomalies`, `service.js:893`); the run-level roll-up → a `varianceReport Json?` column added to `PayRun` (or a thin `PayRunVarianceReport` row keyed by `(payRunId, baselineRunId)`). No change to compute. Filing artifacts → `StatutoryRemittance` rows (already modeled).

---

## 5. Backend

### 5.1 The variance/exception engine — `backend/src/hr/payroll/variance.js` (PURE)

Same discipline as `engine.js`/`compliance/*`: **no DB, no `Date.now`, integer minor units in → sorted structured findings out.** Golden-testable like `india.golden.test.js`.

```js
// PURE. Deterministic. No I/O.
runVarianceChecks({
  current:  { runId, type, lines:[Line], totalsMinor },   // Line = { employeeId, status, grossMinor, netMinor,
  previous: { runId, lines:[Line] } | null,               //   components:[{code, amountMinor}], payableDays, lopDays,
  thresholds,                                             //   isNewJoiner, isLeaver, hasBankDetail }
}) -> {
  findings: [Finding],     // sorted: severity desc, then employeeId, then code
  summary:  { blocker, warning, info, byCode },
  blockingAnomalies,       // count of BLOCKER — feeds the APPROVED guard
}
// Finding = { code, severity:'BLOCKER'|'WARNING'|'INFO', employeeId|null, scope:'EMPLOYEE'|'RUN',
//             metric, baseline, observed, deltaMinor, deltaPct, message, suggestedAction }
```

**Check catalogue**

*BLOCKER (gates approval):* `NEGATIVE_NET` (net<0, except `type===FNF` which legitimately allows recoverable negative per `fnf.js`), `ZERO_NET_UNEXPECTED` (net=0 while gross>0), `MISSING_INPUT` (active employee, no frozen attendance + no exclusion), `NO_COMPENSATION` (null resolved comp), `DEDUCTION_EXCEEDS_GROSS`, `STATUTORY_DROP_TO_ZERO` (a statutory component >0 last period, 0 now, no leaver/exemption), `DUPLICATE_EMPLOYEE`, `NET_PCT_OUTLIER_HARD` (|Δ%(net)| ≥ `hardNetPct`, continuing employee, no revision/arrear reason), `RECONCILIATION_MISMATCH` (`Σ lines.net ≠ run.totalNet`).

*WARNING (must be acknowledged, not blocked):* `NET_PCT_OUTLIER` (`softNetPct ≤ |Δ%| < hardNetPct`), `GROSS_PCT_OUTLIER`, `COMPONENT_DELTA` (per-component |Δ%| ≥ `componentPct` **or** a component appeared/vanished), `LOP_SPIKE` (`lopDays` jump ≥ `lopSpikeDays`), `OT_HOURS_UNCONSUMED` (already emitted by `service.js:338`), `STATUTORY_RATE_DRIFT` (effective rate outside `statutoryRateTolerance`), `BANK_DETAIL_MISSING` (net>0, no valid payee — NZ `BB-bbbb-AAAAAAA-SSS` / IN IFSC+account), `ARREAR_UNEXPLAINED`.

*INFO (context, suppress noise):* `NEW_JOINER`, `LEAVER`, `COMP_REVISION_APPLIED`, `ARREAR_BOOKED` — each **downgrades** the matching EMPLOYEE-scope outlier to INFO so reviewers see real surprises only.

**Outlier math (no float drift):** `deltaPct = (observed − baseline) / max(|baseline|, absMinFloorMinor)` on integer minor units; the floor stops a ₹10→₹40 line screaming "+300%".

```js
const DEFAULT_THRESHOLDS = {
  softNetPct: 0.25, hardNetPct: 0.60, grossPct: 0.25, componentPct: 0.30,
  lopSpikeDays: 5, absMinFloorMinor: 50_00, statutoryRateTolerance: 0.005,
  newJoinerSuppressesOutliers: true, leaverSuppressesOutliers: true,
};
```

Orchestrator's only job: fetch `previous` (prior `sequenceInYear` for same `entity+payCalendar+type`, joined by `employeeId`), call the pure fn, persist findings to `PayRunLine.errorJson` + run `varianceReport`.

### 5.2 New endpoints (all mounted in `payroll.routes.js`, F1/RBAC-gated)

| Method / path | Service fn | Transition / effect | RBAC |
|---|---|---|---|
| `GET /runs/:id/inputs-checklist` | `getInputsChecklist` | read-only readiness gates (§6.2) | `canRunPayroll` |
| `POST /runs/:id/inputs/one-time` | `upsertOneTimeInput` | `PayRunInputItem` CRUD; **DRAFT only** (else `BAD_STATE`) | `canRunPayroll` |
| `POST /runs/:id/freeze` *(or thread `?freeze=1` into compute)* | `computeRun({freezeAttendance:true})` | `freezeAttendance` atomically; **seam #1 fix** — controller must pass the flag | `canRunPayroll` |
| `POST /runs/:id/variance` (or `GET ?vs=previous`) | `computeVariance` | run `variance.js`, persist findings | `canViewPayrollReports` |
| `POST /runs/:id/submit` | `submitRun` | `COMPUTED → REVIEW`; set `submittedBy/At`; guard `OPEN_BLOCKERS` | `canRunPayroll` |
| `POST /runs/:id/send-back` | `sendBackRun` | `REVIEW → COMPUTED`(editable); required `sendBackReason`; audit | `canApprovePayroll` |
| `POST /runs/:id/approve` *(exists)* | `approveRun` | `REVIEW/COMPUTED → APPROVED`; maker≠checker; `STALE_TOTALS` guard | `canApprovePayroll` |
| `POST /runs/:id/payslips/publish` | `publishRun` | Payslip `GENERATED → PUBLISHED`; fire webhook + notification | `canApprovePayroll` |
| `POST /runs/:id/pay` | `disburseRun` | `APPROVED → PAID`; `persistTransition`; publish payslips; set `paidAt` | `canApprovePayroll` |
| `POST /runs/:id/file` | `fileRun` | `PAID → FILED`; write `StatutoryRemittance` rows | `canViewPayrollReports` |
| `POST /runs/:id/close` | `closeRun` | `FILED → FILED+closedAt`; guard all due remittances exist | `canViewPayrollReports` |
| `POST /runs/:id/cancel` | `cancelRun` | `→ CANCELLED` (pre-approval only; else `CANNOT_CANCEL`) | `canRunPayroll` |
| `POST /runs/:id/reopen` | `reopenRun` | `INPUTS_LOCKED/COMPUTED/REVIEW → DRAFT`; clears `inputHash`/compute | `canRunPayroll` |

**Net-new guards** added to `payrun.js`: `STALE_TOTALS` — approve must carry the `totalsHash` the reviewer saw (`ctx.totalsHash === run.totalsHash`), closing the approve-after-silent-recompute hole; `NOT_REVIEWED`, `CANNOT_CANCEL`, `CANNOT_REOPEN`. All thin and pure, throwing `PayRunError`.

**Integration seams (wire here):**
1. `freezeAttendance` is dead from HTTP — `computeRun` accepts it (`service.js:592`) but the controller (`payroll.controller.js:56`) never passes it. Fix: thread `req.body.freezeAttendance` / add `POST /runs/:id/freeze`.
2. Use `persistTransition` (`payrun.js:315`) for pay/file/close/cancel/reopen — it already does optimistic concurrency + the prisma-enum mapping. Don't re-inline.
3. **FnF parity:** `offboarding.controller.js:643 approveFnf` mints `PayRun(type=FNF)` inline (sets `approvedAt` directly, writes no `Payslip`/`computeTrace`); settle pokes `status='PAID'` directly (`:852`), bypassing the state machine. The new `publish`/`pay`/`file` path must either handle FNF runs or `listRuns` must filter `type` (see §7-G).
4. **Publish chain is pre-wired but unfired:** `integrations/webhooks.js:49 payslipPublishedPayload` + `notifications.js:31 HR_PAYSLIP_PUBLISHED` exist; `publishRun` fires them. ESS `getMyPayslip` already flips `PUBLISHED → VIEWED` (`service.js:1065`).
5. `listRuns`/`getRun` don't filter `type` (`service.js:943`) — add a `type` filter so FNF runs don't leak into the regular list.

### 5.3 Filing specifics (IN + NZ) & edge cases

Generators are pure → `{fileName, contentType, meta, content}`; `buildFilingAggregate` (`service.js:1113`) branches on `entity.countryCode`. `fileRun` persists each as a `StatutoryRemittance` (`kind`, `taxPeriod`, `dueDate`, `fileUrl`, `meta`, `status`).

**India:** EPF **ECR** (`generateEcr`, whole-rupee EPFO rounding, `ncpDays=lopDays`, EPS capped ₹15k wage, monthly by 15th); **ESI** (`generateEsic`, `esiCovered` only, ₹21k ceiling, once-in→contribute-to-period-end); **PT** (state slab via `ptStateCode`); **TDS 24Q** (`generate24Q`, **quarterly**, Q4 carries Annexure II → Form 16). Edges: mid-month joiner → pro-rated PF/ESI wage + NCP; mid-month leaver → FnF feeds the month's ECR/ESIC with exit reason; retro arrear → booked into current ECR with arrear period flagged, TDS re-projected; multi-entity → each files under its own establishment/TAN (run is entity-scoped → automatic).

**New Zealand:** **Payday filing (EI)** (`generateEmploymentInformation`, **per payday**, within 2 working days of `payDate`, joiners carry `startDate` / leavers `endDate`); **PAYE/IR348** (monthly remittance from EI totals, 20th); **direct-credit bank batch** (`generateBankBatch`, validates `BB-bbbb-AAAAAAA-SSS`, rejects net≤0, CTRL hash-total). Edges: every run (incl. off-cycle, FnF) files its own EI; leaver FnF carries holiday-pay (8% + untaken annual leave at greater-of-OWP/AWE per `holidaysAct.js`); ESCT on employer KiwiSaver netted into the EI.

**Cross-cutting:** no cross-entity run (`PayRun.entityId` single). Corrections → IN ECR arrear/revision; NZ **amended EI** for the original `paydayDate` (CORRECTION run regenerates EI with the same payday). `close` blocked until every due `StatutoryRemittance` for the period exists.

### 5.4 Off-cycle / FnF / supplementary / reversals

All run `types` (`REGULAR/OFF_CYCLE/BONUS/ARREAR/FNF/CORRECTION/SUPPLEMENTARY`) share the **same** state machine, idempotency, SoD, and variance engine — only input-gathering and the variance baseline differ. A paid run is **never mutated**: to reverse, create a `CORRECTION` run with `parentPayRunId = original.id` carrying sign-flipped lines; same `inputHash` ⇒ retried reversal is a cached no-op (`assertIdempotentCompute`). FnF allows `NEGATIVE_NET` (recoverable).

---

## 6. Frontend — the guided run (`apps/hr-admin/app/payroll`)

A wizard with a left-rail **`StageStepper`** (6 dots DRAFT→closed) driven by `nextStates()`. URL-addressable (`/payroll?run=:id&tab=…`, matching today's `?run=` pattern). Build on `@hr/ui` (`Modal`, `PrimaryButton`, `DateField`, `ErrorBanner`, `Spinner`, `Empty`) and `lib/ui` (`DataTable`, `PageHeader`, `StatusBadge`, `ActionButton`, `moneyish`, `employeeLabel`); new shared bits: `StageStepper`, `DeltaCard`, `AnomalyChip`, `Drawer`.

### 6.1 Runs list — `/payroll`
Existing `RunsList`, plus: filter bar (Entity / Status / Tax year → `listRuns({entityId,status,...})`); a 6-dot stage mini-stepper column; **FNF filter** (default hide FNF). **Replace free-text UUID inputs in `NewRunModal` with selects** (Entity → its Pay calendars → period auto-filled from the calendar) — the single biggest UX fix. Creating a run for an existing `(businessId, code)` returns the existing DRAFT → navigate to it, don't error/dupe.

### 6.2 Inputs checklist — `?tab=inputs` (DRAFT)
`InputsChecklist` ← `GET /runs/:id/inputs-checklist`, four `ChecklistRow`s: **Attendance freeze** (OK/WARN with a `Freeze attendance` button → `POST /runs/:id/freeze`; WARN `NO_ATTENDANCE_DATA` = "paid full calendar days"), **Leave/LOP** (drawer), **Pending comp revisions** (effective-in-period, not yet current), **One-time inputs** (`OneTimeInputsTable` CRUD, DRAFT only). Compute is **enabled** with WARNs (a confirm modal lists them); BLOCKERs from variance disable submit downstream.

### 6.3 Compute & summary — `?tab=summary`
`RunHeader` (period, entity, `StatusBadge`, `StageStepper`, **inputHash fingerprint** `inputs #a3f9c1` so maker & checker confirm the same set) + StatCards (Gross/Deductions/Net/Employer cost/Headcount) + `Compute`/`Recompute` + `PayLinesTable` with a per-line flag chip (red=BLOCKER, amber=WARNING from `errorJson`). Anomalies panel **split by severity** (red BLOCKER vs amber WARNING) — today it's a flat amber list (`page.js:283`). Recompute with unchanged inputs → "No changes — inputs identical." Reconciliation badge: `Σ lines.net = run.totalNet`.

### 6.4 Variance review — `?tab=variance` (the centerpiece)
`VarianceReview` ← `GET /runs/:id/variance?vs=previous`, three tiers: **Tier 1** headline `DeltaCard`s (Net/Gross/Deductions/Employer/Headcount, signed + colour-coded + sparkline, joiner/leaver chips). **Tier 2** `ComponentVarianceTable` (per component: prev/curr/Δabs/Δ%/#changed, sorted by |Δ| desc, threshold borders). **Tier 3** `FlaggedAnomaliesTable` + `EmployeeVarianceDrawer` (prev↔curr payslip diff component-by-component + the line's `computeTrace`/explain + LOP/payable-days inputs). The drill data already exists (`computeTrace` persisted per line, returned by `getRun` `service.js:962`). **First run ever** (no baseline) → absolute totals only. Endpoint 404 → degrade to anomalies-only from `getRun.anomalies`. Flagged items can be **acknowledged** (maker); acks persist + show to checker.

### 6.5 Submit → approve → disburse
- **Submit** (`SubmitForApprovalButton` → `POST /submit`) — disabled while `blockingAnomalies > 0` (tooltip lists them, mirroring `OPEN_BLOCKERS`); records `submittedBy`; maker then read-only.
- **Approve** (checker, `?tab=approval`) — read-only `VarianceReview` + `DecisionBar`: **Approve** (`POST /approve`) disabled if maker / blockers / lacks perm; **Send back** (`POST /send-back`, required reason). Maker viewing own run → both hidden, banner "You computed this run — approval requires a different reviewer."
- **Disburse** (`DisbursementPanel`, APPROVED): `Mark paid` (`POST /pay`) → publishes payslips → `Download bank file`; `FilingExportsPanel` (existing `FILE_KINDS`, **country-filtered** by `run.entity.countryCode` so an IN run never shows NZ EI/Bank links that 404 `COUNTRY_MISMATCH`); `File` (`POST /file`) → `Close` (`POST /close`). Bank-file total reconciliation shown before download.

### 6.6 ESS — `apps/ess/app/payslips`
Existing list + detail (server-scoped to `PUBLISHED`/`VIEWED`, first view flips to `VIEWED`). **Security fix:** the current "Download payroll file" link points at the run-level **bank/statutory file** (`runFileHref`) — an employee must never access that. Replace with the employee's own payslip **PDF** (`GET /api/hr/me/payslips/:id/pdf`). Add YTD strip (from `snapshotJson` if present), Published/Viewed status semantics. Employees see a payslip **only after publish** (i.e. after PAID).

---

## 7. E2E per role + acceptance

**Maker (`canRunPayroll`):** create (picker, not UUID) → freeze → compute → review variance → fix/recompute (idempotent) → submit. AC: cannot self-approve (button hidden + server guard); submit blocked while blockers > 0; submitted run read-only until checker acts.

**Checker (`canApprovePayroll`):** approval queue → read-only variance → Approve (maker≠checker, blockers=0, `totalsHash` matches) or Send-back (reason required, audited). AC: maker can never approve own run by any path; approve writes `payrun.approve` audit with `preparerId/fourEyes` (+ extend `reviewerId/totalsHash`).

**Finance (`canApprovePayroll`/`canViewPayrollReports`):** Pay → publish (payslips visible in ESS) → country-aware filing exports → File → Close. AC: payslips visible **only after publish**; a closed run is fully immutable (downloads only); bank-file total ties to `totalNet`.

**Employee (ESS):** sees only PUBLISHED/VIEWED own payslips; download is own PDF, never the run file; net on list = detail = `PayRunLine.net`.

**Error taxonomy (server `code` → UI):** `MAKER_CHECKER`→disable+banner; `OPEN_BLOCKERS`→disable Approve + link to blockers; `STALE_TOTALS`/`STALE_TRANSITION`/`IMMUTABLE_RUN_VIOLATION`→"changed since you opened" + refresh; `BAD_STATE`→re-fetch; `COUNTRY_MISMATCH`→pre-filter so it never fires; 5xx→`ErrorBanner` + Retry (compute/files idempotent).

---

## 8. QA plan (numbered)

1. **Variance math vs prior period** — golden test (`variance.golden.test.js`): two fixed line-sets → exact sorted finding list + severity buckets + `blockingAnomalies`; `deltaPct` floor math (₹10→₹40 not flagged); joiner/leaver/revision/arrear downgrade outliers to INFO.
2. **SoD maker-checker** — approve as `computedBy` → 409 `MAKER_CHECKER`; approve as a third actor with `fourEyes=true` → ok; SoD context unresolved → **fail-closed reject** (matches commit `855ed53`).
3. **Recompute idempotency** — recompute unchanged inputs → same `inputHash`, no-op, identical totals; changed inputs on a COMPUTED run → new hash; on APPROVED/PAID → `IMMUTABLE_RUN_VIOLATION`.
4. **Attendance-freeze parity** — `freezeAttendance:true` via the new route produces the same `AttendancePayInput` rows as the engine inputs; failed freeze rolls back (tx) and checklist re-fetch shows unchanged state; `NO_ATTENDANCE_DATA` WARNING surfaces.
5. **Negative-net / anomaly gating** — `NEGATIVE_NET` BLOCKER blocks submit & approve; FNF run allows recoverable negative; `RECONCILIATION_MISMATCH` (Σlines ≠ totals) is a BLOCKER.
6. **Filing-export correctness (IN)** — ECR whole-rupee rounding, `ncpDays=lopDays`, EPS ₹15k cap; ESI ₹21k ceiling/once-in; 24Q quarterly aggregation; mid-month joiner/leaver edges; `COUNTRY_MISMATCH` on a wrong-country kind.
7. **Filing-export correctness (NZ)** — EI per-payday within 2 working days, joiner `startDate`/leaver `endDate`; bank batch rejects net≤0 + CTRL hash-total; ESCT netting; FnF holiday-pay (greater-of-OWP/AWE).
8. **Publish chain** — `publishRun` flips `GENERATED→PUBLISHED`, fires webhook + `HR_PAYSLIP_PUBLISHED`; ESS now lists it; first ESS read flips to `VIEWED`; pre-publish ESS list excludes it.
9. **Lifecycle past APPROVED** — `pay`/`file`/`close`/`cancel`/`reopen` each enforce the legal edge via `persistTransition` (optimistic `updateMany` on `from`); illegal edge → `Illegal transition`; cancel post-approval → `CANNOT_CANCEL`; reopen post-approval → `CANNOT_REOPEN`.
10. **STALE_TOTALS** — approve with a stale `totalsHash` after a concurrent recompute → reject (forces re-review).
11. **RBAC** — every new route gated (`canRunPayroll`/`canApprovePayroll`/`canViewPayrollReports`); ESS cross-employee access impossible (server scopes `employeeId` + status).
12. **FnF leakage** — `listRuns` with FNF filter hides FnF from the regular list; an FnF run opened directly renders without crashing (no `computeTrace`/Payslip).

---

## 9. Build sequence (one pass)

1. **Schema migration** — add `PayRunInputItem`, `VarianceThreshold`, `PayRun.{submittedBy,submittedAt,reviewedBy,sendBackReason,closedAt,totalsHash,varianceReport}` (all additive/nullable).
2. **`payrun.js`** — add guards `STALE_TOTALS`/`NOT_REVIEWED`/`CANNOT_CANCEL`/`CANNOT_REOPEN`; model the review sub-state (reserved `REVIEW`/`LOCKED`).
3. **`variance.js`** (pure) + `__tests__/variance.golden.test.js`.
4. **`service.js`** — `getInputsChecklist`, `upsertOneTimeInput`, `computeVariance`, `submitRun`, `sendBackRun`, `publishRun`, `disburseRun`, `fileRun`, `closeRun`, `cancelRun`, `reopenRun` (over `persistTransition`); add `type` filter to `listRuns`; thread `freezeAttendance` in the controller.
5. **`payroll.controller.js` + `payroll.routes.js`** — wire the new routes with RBAC gates; thread `freezeAttendance`; add the ESS payslip-PDF route.
6. **Publish chain** — fire `payslipPublishedPayload` webhook + `HR_PAYSLIP_PUBLISHED` notification from `publishRun`.
7. **hr-admin UI** — `StageStepper`, picker-based `NewRunModal`, `InputsChecklist`, severity-split anomalies, `VarianceReview` (3 tiers + drawer), `DecisionBar`, `DisbursementPanel` (country-aware filing).
8. **ESS UI** — security-fix the download (own PDF, not run file); YTD strip; Published/Viewed semantics.
9. **FnF parity pass** — route FnF mint/settle through the state machine (or explicitly exclude + filter).

---

## 10. Key files

- State machine / guards / idempotency: `backend/src/hr/payroll/payrun.js` (`STATE`/`TRANSITIONS`/`STATE_TO_PRISMA` `:31/46/61`, guards `:109`, `computeInputHash` `:273`, `persistTransition`/`persistComputeResult` `:315/359`).
- Orchestrator: `backend/src/hr/payroll/service.js` (`computeRun` `:592`, `persistComputedRun` `:713`, `approveRun` `:888`, `listRuns` `:943`, `buildFilingAggregate` `:1113`).
- Controller / routes: `backend/src/hr/payroll/payroll.controller.js` (`:53/64/109`), `backend/src/hr/payroll/payroll.routes.js`.
- Compute cores (consume, don't edit): `engine.js`, `compliance/india.js`, `compliance/newzealand.js`, `compliance/holidaysAct.js`.
- Filing: `backend/src/hr/payroll/filing/{india.js,newzealand.js}`.
- FnF: `backend/src/hr/lifecycle/fnf.js` (`computeFnf` `:230`), `offboarding.controller.js` (`approveFnf` `:643`).
- Freeze: `backend/src/hr/attendance/freeze.js` (`:122`).
- RBAC: `backend/src/core/lib/rbac.js` (`:21–23`).
- Schema: `backend/prisma/schema.prisma` (`PayRun` `:7128`, enums `:7180/7189`, `PayRunLine` `:7234`, `Payslip` `:7315`, `StatutoryRemittance`/`RemittanceKind` `:7359/7386`).
- UI: `apps/hr-admin/app/payroll/page.js`; `apps/ess/app/payslips/{page.js,[id]/page.js}`.
- New: `backend/src/hr/payroll/variance.js` (+ `__tests__/variance.golden.test.js`).

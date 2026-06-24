# Feature 18 — Data Migration / Bulk Import (CSV-Excel) + Back-dated Auto-Generation (India-first)

**Status:** spec / build-ready
**Owners:** Platform / Payroll squad
**Depends on:** F1 (RBAC + tenant scope), F2 (Attendance derive/freeze), F4 (Lifecycle / provisioning), F5 (Compensation / `deriveBreakup`), F6 (Leave), F7 (Payroll run), F11 (Reimbursement/Claims)
**Last synthesized:** 2026-06-24

> One-line: a **tenant-scoped, idempotent, dry-runnable import subsystem** that ingests CSV/Excel (or a manual grid) for **employees, CTC structures, back-dated attendance, back-dated payslips/payroll, and reimbursement claims** — validating every row against the same statutory/policy rules the live app uses — and then **drives the existing engines** (attendance `recompute`→`freezeAttendance`, payroll `computeRun`, `deriveBreakup`, expenses `createClaim`) so a migrated employee's history (attendance → CTC → payslips, claims → claimed/approved amounts) is **auto-generated**, never hand-stitched or bypassed.

---

## 1. Summary & goals

When a business switches to DriftHR mid-year, the owner needs **prior-period data visible on day one**: an employee's payslips for the last six months, their attendance, their reimbursement history. The owner's framing: *"when attendance entered + CTC set, payslips auto-prepare; same for reimbursement (claim/approved amounts) for back-dated employees; testing manually OR upload Excel/CSV."*

The naïve approach — let an admin paste numbers straight into `Payslip`/`PayRunLine` — would create payslips that **disagree with the engine** (wrong PF cap, wrong PT slab, no audit trace, no `inputHash`), poison variance comparisons, and break filing. This feature does the opposite: **import is an input-staging layer, generation is the existing engine**. We stage validated facts (employee master, CTC target, attendance days, claim amounts), then **feed them into the same `computeRun`/`recompute`/`createClaim` paths a live tenant uses**, only with the period dates set in the past.

**Goals**

1. **One import subsystem, many entity kinds.** A single `ImportJob` pipeline (upload → parse → map → dry-run → commit → report) parameterised by an `ImportKind`: `EMPLOYEE`, `COMPENSATION`, `ATTENDANCE`, `PAYROLL_HISTORY`, `REIMBURSEMENT`.
2. **A template per kind** (downloadable `.xlsx`/`.csv` with header row + example row + a hidden data-dictionary sheet), and a **column-mapping step** so a customer's own export still imports.
3. **Dry-run preview + error report** before anything is written: per-row PASS/WARN/ERROR with a human reason and a downloadable annotated file. **Commit is a separate explicit action.**
4. **Idempotent + tenant-scoped + audited.** Re-uploading the same file (same content hash, same natural keys) never double-creates. Every job and every committed row is `businessId`-scoped and audit-logged.
5. **Auto-generation triggers.** Once attendance + CTC exist for a back-dated period, a **PayRun is created, frozen, computed, and published** through `payroll/service.js` — not synthesised. Reimbursement rows create real `ExpenseClaim`s with claimed + approved amounts through `expenses.service.js`.
6. **India-first, country-true.** The tenant's `Entity.countryCode` selects validators (PAN/UAN/IFSC/PF/ESI/PT), the CTC breakup derivation, and the payroll engine — exactly as the live app does. NZ is roadmap (§12).

**Non-goals (see §3 scope-out):** OCR of scanned payslips; auto-mapping via ML; live bank-statement reconciliation; importing *future-dated* runs (import is for history + opening balances, the live run owns the current/future period); a generic "import any table" admin tool (only the 5 kinds above).

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **ImportJob** | One upload + its lifecycle (`UPLOADED → PARSED → VALIDATED → DRY_RUN_OK → COMMITTING → COMMITTED` / `FAILED` / `CANCELLED`). Tenant-scoped, kind-typed. |
| **ImportRow** | One staged source row with its parsed JSON, resolved natural key, per-row status + findings. The unit of idempotency. |
| **Template** | The canonical column set for a kind (download). Drives parse + the default mapping. |
| **Mapping** | `{ sourceHeader → canonicalField }` saved on the job, so a customer's own headers map to our fields. |
| **Dry-run** | A full validate + *simulated* commit that writes **nothing** (or writes only to staging), producing the same findings a real commit would, plus a preview of the generated artifacts (e.g. computed net pay). |
| **Natural key** | The tenant-unique business key used for idempotent upsert (e.g. employee `code` or `workEmail`; for attendance `(employeeCode, date)`; for payroll-history `(employeeCode, periodMonth)`). |
| **Back-dated period** | A `[periodStart, periodEnd]` whose end is **before today**. Drives a real but historically-dated PayRun (`type = MIGRATED`). |
| **Auto-generation** | Deriving downstream artifacts from staged facts by **calling the live engines**: attendance days → `AttendancePayInput`; CTC target → component lines via `deriveBreakup`; both → `computeRun` → `Payslip`; claim rows → `ExpenseClaim`. |

---

## 3. Scope

### In scope — REUSE (consume; do **not** rebuild)

These are the load-bearing engines this feature **feeds**. The import layer must never reimplement their math or bypass their guards:

- **Payroll orchestrator** — `backend/src/hr/payroll/service.js`: `createRun`, `computeRun({ freezeAttendance })`, `approveRun`, publish path. The pure mapping `buildEmployeePayInput(rows)` and the engine `computePayslip` are the single source of payslip truth. Import calls `computeRun`; it does **not** write `Payslip`/`PayRunLine` directly.
- **Pay-run state machine** — `backend/src/hr/payroll/payrun.js`: `STATE`, `transition`, `computeInputHash`, `persistTransition`, `persistComputeResult`. Idempotency + immutability come for free.
- **Attendance freeze bridge** — `backend/src/hr/attendance/freeze.js`: `freezeAttendance(payRunId, businessId, periodStart, periodEnd, employeeIds, tx)` and `rollupEmployee(rows…)`. Produces the immutable `AttendancePayInput` the engine reads.
- **Attendance derive orchestrator** — `backend/src/hr/attendance/service.js`: `recompute(businessId, employeeId, fromDate, toDate, tx?)` and the pure `derive.js`. Import seeds `AttendancePunch`/daily `Attendance` rows (or directly stages day-counts) then lets recompute + freeze roll them up.
- **CTC reverse-derivation** — `backend/src/hr/compensation/deriveBreakup.js`: target CTC/gross → per-component monthly amounts (incl. BALANCING residual). Used to materialise `CompensationRevision` + `SalaryComponentLine` from an imported CTC number.
- **Expenses orchestrator** — `backend/src/hr/expenses/expenses.service.js`: `createClaim` + the pure `policyEngine`. Import creates real claims; back-dated approved amounts settle through the claim's status machine, not a raw `UPDATE`.
- **Lifecycle provisioning** — `backend/src/hr/lifecycle/provision.js` + `onboarding.service.js`: atomic, idempotent `provisionEmployee` (SoD, FOR-UPDATE serialization, full rollback). The EMPLOYEE import reuses this rather than inserting `Employee` rows by hand.
- **Code minting** — `backend/src/hr/lifecycle/lib/codes.js` `allocateCode` + the `NumberSequence` FOR-UPDATE pattern (`expenses.service.js` `mintCode`). For employee/claim codes and a new `IMPORT` scope.
- **RBAC scope** — `backend/src/hr/middleware/scope.middleware.js` (`withEmployeeScope`) + the `can*` permission gates. Import is an admin-only, tenant-scoped operation.
- **Audit** — `backend/src/core/lib/audit.js` `writeAudit`. Every commit is logged.
- **Money** — `backend/src/hr/payroll/money.js`: integer minor units everywhere; never float.

### In scope — BUILD (net-new)

- `ImportJob` + `ImportRow` Prisma models (+ enums) and migration.
- A pure **parse + validate** core per kind (`backend/src/hr/imports/parsers/*.js`, `validators/*.js`) — no DB, unit-testable.
- A **commit orchestrator** `backend/src/hr/imports/imports.service.js` that upserts staged rows via the reused engines, inside one transaction per row-batch, idempotent on natural key.
- An **auto-generation driver** `backend/src/hr/imports/autogen.service.js` that, post-commit, walks back-dated periods and calls `recompute`→`freezeAttendance`→`computeRun` and `createClaim`.
- **Templates** (generated `.xlsx`/`.csv`) + a template/sample endpoint.
- Routes + controllers (`backend/src/hr/imports/imports.routes.js`, `imports.controller.js`), an admin **Import Center** in hr-admin, and a read-only **"imported"** badge surfaced in ESS history.
- A new `PayRunType.MIGRATED` (or reuse an existing additive `type`) + a `source = 'IMPORT'` provenance flag on generated artifacts.

### Out of scope (this feature)

OCR; ML auto-mapping; future-dated runs; bank reconciliation; a generic table importer; NZ-specific validators (roadmap §12).

---

## 4. The pipeline (one shape, five kinds)

```
            ┌──────────── ImportJob (businessId, kind, status) ───────────┐
upload  ─►  │  1 UPLOAD     store file (≤10MB, MIME allow-list), hash      │
            │  2 PARSE      xlsx/csv → rows[] (canonical via mapping)      │  ImportRow[]  (raw + parsed JSON, naturalKey, status)
            │  3 MAP        sourceHeader→canonicalField (default+override) │
            │  4 VALIDATE   pure per-kind validators → PASS/WARN/ERROR     │  per-row findings
            │  5 DRY-RUN    simulate commit (engines in tx, ROLLBACK)      │  preview totals (e.g. net pay), annotated error file
            │  ── explicit "Commit" by an admin (separate action) ──       │
            │  6 COMMIT     upsert via reused engines, per-row idempotent  │  real rows + provenance(source=IMPORT)
            │  7 AUTOGEN    recompute→freeze→computeRun ; createClaim      │  Payslips / Claims
            │  8 REPORT     per-row result, downloadable report            │
            └─────────────────────────────────────────────────────────────┘
```

Every step is **resumable** and **idempotent**: re-running PARSE replaces rows for the same `ImportJob`; re-running COMMIT skips rows already `COMMITTED` for the same natural key (matched by content hash). A second upload of the same file (same `fileHash`) on the same kind returns the existing job (exactly-once, mirrors `createRun`'s `(businessId, code)` guard).

### 4.1 Parse

- **Formats:** `.xlsx`, `.xls`, `.csv` (UTF-8 + BOM tolerated). Library: `exceljs` (xlsx) + `papaparse`/`fast-csv` (csv) — add to `backend/package.json` (none present today). Streamed, capped at **10MB** and **20,000 rows/job** (above that, the operator splits the file); MIME allow-list reuses the lifecycle PDF-upload caps pattern.
- Trim, normalise blank → null, coerce nothing yet (validators own coercion). Each source row → one `ImportRow { rowNumber, rawJson, parsedJson, naturalKey:null, status:PARSED }`.
- A **header reconcile**: detected headers vs the kind's template; unknown headers surface as a job-level WARNING (kept, not dropped — they may be mapped).

### 4.2 Map

`mappingJson` on the job: `{ "Emp Code": "code", "DOJ": "dateOfJoining", … }`. Defaults are identity-mapped from the template; the admin overrides in the UI. Re-validate after a mapping change. A required canonical field left unmapped is a **job-level ERROR** (blocks dry-run).

### 4.3 Validate (PURE, per kind)

Validators live in `backend/src/hr/imports/validators/<kind>.js`, take a parsed row + a `ctx` the orchestrator pre-loads (existing employee codes, entity country, active CTC structures, pay calendars), and return `{ status: PASS|WARN|ERROR, findings:[{ code, severity, field?, message }], normalized }`. **No DB, no I/O** — the orchestrator hands them the lookup sets. India validators (see §6) reject a bad PAN/UAN/IFSC/PF-wage-floor at this step, **with the same rules the live forms use** (reuse the statutory validators from F4 self-onboarding where they already exist).

Severity policy:
- **ERROR** → row excluded from commit (must be fixed + re-uploaded, or overridden where allowed).
- **WARN** → row commits but is flagged (e.g. `NO_ATTENDANCE_DATA`, a gross that doesn't reconcile to CTC within tolerance).
- **PASS** → clean.

### 4.4 Dry-run

The differentiator. Dry-run runs the **real commit + autogen path inside a transaction that is rolled back** (the `computeRun` freeze path already proves engines run safely inside a tx callback — `service.js` `loadAndCompute(tx)`), so the preview shows **engine-true outputs**: for PAYROLL_HISTORY it shows the computed **net pay per employee** (so the admin can eyeball it against the prior provider's payslip), the statutory splits, and any anomalies. Nothing persists. Output: a summary (`{ pass, warn, error }` counts, preview totals) + a downloadable **annotated copy of the source file** with a `__status` and `__reason` column appended.

> Implementation note: dry-run uses the same `imports.service.commitRow(tx, …)` as the real commit, called inside `prisma.$transaction(async tx => { … throw ROLLBACK })`. A sentinel rollback error keeps the code path identical to a real commit — the strongest possible guarantee the preview matches reality.

### 4.5 Commit + 4.6 Autogen — see §7 (per-kind generation).

### 4.7 Report

Per-row outcome persisted on `ImportRow.resultJson` (`{ created|updated|skipped, targetType, targetId }`) + a job rollup. Downloadable report = source file + status/reason/targetId columns. Audit: one `import.commit` event per job with `{ kind, counts, fileHash }`, and `import.row` is **not** logged per-row (volume) — the `ImportRow` table *is* the per-row audit.

---

## 5. Data model (Prisma sketches)

Additive only; nothing existing changes shape. Two new models + enums, plus one additive provenance field on the generated artifacts.

```prisma
enum ImportKind {
  EMPLOYEE
  COMPENSATION
  ATTENDANCE
  PAYROLL_HISTORY
  REIMBURSEMENT
}

enum ImportStatus {
  UPLOADED
  PARSED
  VALIDATED
  DRY_RUN_OK
  COMMITTING
  COMMITTED
  FAILED
  CANCELLED
}

enum ImportRowStatus {
  PARSED
  PASS
  WARN
  ERROR        // validation error — excluded from commit
  COMMITTED
  SKIPPED      // idempotent no-op (already committed for this natural key)
  FAILED       // commit-time failure (engine threw) — row-isolated
}

/// One bulk-import upload + its lifecycle. Tenant-scoped, admin-driven, audited.
model ImportJob {
  id            String       @id @default(uuid())
  businessId    String
  business      Business     @relation(fields: [businessId], references: [id], onDelete: Cascade)
  // Optional scoping: an import can be pinned to one entity (its country drives
  // validators + the payroll engine). NULL = tenant default entity resolved at commit.
  entityId      String?
  entity        Entity?      @relation(fields: [entityId], references: [id], onDelete: SetNull)
  kind          ImportKind
  status        ImportStatus @default(UPLOADED)
  // Source file (object-store key; never the bytes in the DB). hash = idempotency.
  fileName      String
  fileKey       String       // storage key (R2/S3/local)
  fileHash      String       // sha256(bytes) — exactly-once guard per (businessId, kind)
  mimeType      String?
  rowCount      Int          @default(0)
  mappingJson   Json?        // { sourceHeader -> canonicalField }
  optionsJson   Json?        // kind options: e.g. { autoGenerate:true, autoApproveClaims:true, periodMonths:["2025-12",...] }
  // Rollups (filled by validate/commit)
  passCount     Int          @default(0)
  warnCount     Int          @default(0)
  errorCount    Int          @default(0)
  committedCount Int         @default(0)
  skippedCount  Int          @default(0)
  previewJson   Json?        // dry-run preview (e.g. per-employee net pay)
  // Actor + SoD: the maker who uploads ≠ the (optional) approver who commits.
  uploadedBy    String
  committedBy   String?
  // Lifecycle stamps
  uploadedAt    DateTime     @default(now())
  validatedAt   DateTime?
  committedAt   DateTime?
  failedReason  String?
  rows          ImportRow[]
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt
  deletedAt     DateTime?
  version       Int          @default(0)

  // Exactly-once: a re-upload of identical bytes for the same kind returns the
  // existing job rather than a second one.
  @@unique([businessId, kind, fileHash])
  @@index([businessId, kind, status])
  @@index([businessId, status])
}

/// One staged source row. The unit of idempotency + the per-row audit trail.
model ImportRow {
  id            String          @id @default(uuid())
  businessId    String
  business      Business        @relation(fields: [businessId], references: [id], onDelete: Cascade)
  importJobId   String
  importJob     ImportJob       @relation(fields: [importJobId], references: [id], onDelete: Cascade)
  rowNumber     Int             // 1-based source row (for the error report)
  rawJson       Json            // original parsed cells (pre-mapping)
  parsedJson    Json            // canonical fields (post-mapping, pre-coercion)
  naturalKey    String?         // e.g. "EMP-000142" | "EMP-000142|2025-12" | "EMP|2025-12-04"
  status        ImportRowStatus @default(PARSED)
  findingsJson  Json?           // [{ code, severity, field?, message }]
  resultJson    Json?           // { action: created|updated|skipped, targetType, targetId }
  // Provenance of what this row produced (for unwind / report). e.g. payRunId.
  targetType    String?
  targetId      String?
  createdAt     DateTime        @default(now())

  // Idempotency within a job: one row per natural key (a re-parse replaces).
  @@unique([importJobId, naturalKey])
  @@index([businessId, importJobId, status])
}
```

**Provenance on generated artifacts (additive):**

- `PayRun.type` gains a `MIGRATED` member (the `listRuns` default already filters by `type`, e.g. it hides `FNF`; `MIGRATED` runs are shown but badged). `PayRun.importJobId String?` (nullable FK) links a generated run back to its job.
- `Attendance` / `AttendancePayInput` / `ExpenseClaim` gain `importJobId String?` (nullable) so imported rows are filterable and the badge can render. Existing rows stay NULL. No behaviour change.

> These are the **only** edits to existing models — single nullable columns. The math models (`PayRunLine`, `Payslip`, `PayRunLineComponent`) are written **only** by `computeRun`, never by import, so they need no import-specific column.

---

## 6. File formats, templates & mapping (India-first)

Each kind ships a template: **row 1 = headers**, **row 2 = a filled example**, **a hidden `Data Dictionary` sheet** (field, required?, type, rule, example). `GET /api/imports/templates/:kind?format=xlsx|csv` streams it.

Money columns are **major units** in the file (₹), converted to minor units via `money.toMinor` on import (never float). Dates are `YYYY-MM-DD`. Booleans `Y/N`.

### 6.1 EMPLOYEE (`employee` kind)

Natural key: `code` (if provided) else `workEmail`.

| Column | Req | Type | Rule (India) |
|---|---|---|---|
| `code` | optional | string | If blank, minted via `allocateCode(EMPLOYEE)`. If present + exists → **update**. |
| `firstName`, `lastName` | yes | string | |
| `workEmail` | yes | email | Tenant-unique (reuse F4 email-reuse fail-fast). |
| `personalEmail`, `phone` | no | | |
| `gender` | for IN | enum | drives engine gender flags. |
| `dateOfBirth`, `dateOfJoining` | yes | date | DOJ in the past for migration. |
| `entityCode`, `locationCode`, `departmentCode`, `designationCode`, `gradeCode` | yes/opt | string | resolved to ids; unknown → ERROR. |
| `managerCode` | no | string | resolves `managerEmployeeId`. |
| `pan` | for IN | PAN | `^[A-Z]{5}[0-9]{4}[A-Z]$`; invalid → ERROR. |
| `uan`, `pfMemberId` | no | string | 12-digit UAN; presence flips `pfApplicable`. |
| `esiApplicable`, `esiNumber` | no | Y/N + str | |
| `ptStateCode` | for IN | string | PT slab state. |
| `bankAccount`, `ifsc` | no | str | IFSC `^[A-Z]{4}0[A-Z0-9]{6}$`. |

Commit → reuse `lifecycle/provision.provisionEmployee` (atomic, idempotent, SoD). Update path patches the existing `Employee` + `StatutoryProfile`.

### 6.2 COMPENSATION (`compensation` kind)

Natural key: `(employeeCode, effectiveFrom)`.

| Column | Req | Type | Rule |
|---|---|---|---|
| `employeeCode` | yes | string | must resolve to an Employee in the entity. |
| `effectiveFrom` | yes | date | back-dated allowed; window must not overlap an existing revision (else ERROR or supersede per option). |
| `ctcAnnual` **or** `grossMonthly` | one req | money | the **target** fed to `deriveBreakup`. |
| `structureCode` | no | string | which `SalaryStructure` template to derive against; else the entity default. |
| component override columns (`BASIC`, `HRA`, …) | no | money | optional explicit per-component monthly amounts; if present they **seed** the lines and `deriveBreakup` reconciles BALANCING to the target. |

Commit → run `deriveBreakup({ target, lines })` to produce monthly component amounts, then create a `CompensationRevision` + `SalaryComponentLine`s (the same shape `resolveCurrentCompensation` reads). **Validate that the derived gross reconciles to the target within ±₹1** (WARN on mismatch). India: enforce the **Basic+DA ≥ statutory PF wage floor** check that F4 provisioning already does — reuse it.

### 6.3 ATTENDANCE (`attendance` kind)

Two acceptable shapes (operator picks via `optionsJson.attendanceMode`):

- **DAILY** — one row per `(employeeCode, date, status)` (`PRESENT|ABSENT|HALF_DAY|ON_LEAVE|WEEKLY_OFF|HOLIDAY|WFH|ON_DUTY`, optional `firstIn`,`lastOut`,`otHours`). Commit upserts daily `Attendance` rows **directly** (bypassing punch-derivation, since historical punch data rarely exists), respecting `isLocked` (never clobber a frozen day).
- **SUMMARY** — one row per `(employeeCode, periodMonth)` with `payableDays`, `lopDays`, `paidLeaveDays`, `otHours`. Commit writes the `AttendancePayInput` rollup fields directly for that period (still via the freeze model's shape) — the fastest migration path when the prior provider only has monthly summaries.

Either way the **payroll engine reads `AttendancePayInput`** (`buildEmployeePayInput` gates on `!= null` so a frozen ZERO is honoured — §M1). DAILY rows additionally let `recompute` re-derive if punches are later added. Natural key: `(employeeCode, date)` or `(employeeCode, periodMonth)`.

### 6.4 PAYROLL_HISTORY (`payroll_history` kind)

This is the **auto-generation** kind. Two sub-modes via `optionsJson.payrollMode`:

- **`GENERATE`** (recommended): the file carries only `(employeeCode, periodMonth)` (+ optional `payableDays`,`lopDays`,`otHours` if no separate attendance import). Commit + autogen **creates a MIGRATED PayRun for that period and runs `computeRun`** — the engine derives every component, PF/ESI/PT/TDS, net pay. The payslip is engine-true. Requires CTC (§6.2) + attendance (§6.3 or inline) to exist for the period.
- **`RECONCILE`**: the file carries the **prior provider's** gross/net/PF/ESI/PT/TDS per employee per month. We still **generate** via the engine, then **compare** engine output to the imported figures and emit per-line variance findings (`IMPORT_MISMATCH_NET`, `…_PF`, …) so the admin sees where DriftHR's computation differs from the legacy payslip. We **never** overwrite the engine's number with the imported one — the imported figure is a *check*, surfaced as a WARN. (A `tolerance` option sets the WARN threshold; default ₹1.)

Natural key: `(employeeCode, periodMonth)`. Idempotent: a MIGRATED run for a period already `APPROVED`/`PAID` is immutable (`computeRun` returns the existing detail).

### 6.5 REIMBURSEMENT (`reimbursement` kind)

Natural key: `(employeeCode, claimNumber)` if `claimNumber` given, else `(employeeCode, expenseDate, amount, description-hash)`.

| Column | Req | Type | Rule |
|---|---|---|---|
| `employeeCode` | yes | string | |
| `claimNumber` | no | string | if blank, minted via `allocateCode(EXP)`. |
| `categoryCode` | no | string | resolves `categoryId`. |
| `expenseDate` | yes | date | back-dated allowed. |
| `claimedAmount` | yes | money | the employee-claimed figure. |
| `approvedAmount` | no | money | the back-dated approved figure; if blank, defaults to `claimedAmount`. |
| `status` | no | enum | target end-state: `APPROVED` (default for history) or `REIMBURSED`. |
| `description`, `receiptUrl` | no | | |
| `paymentRef`, `reimbursedAt` | for REIMBURSED | | settlement provenance. |

Commit → `expenses.service.createClaim` to mint a real `ExpenseClaim`/`ExpenseClaimLine` with `claimedAmount`, then drive its status machine to the target end-state with `approvedAmount` (back-dated `decidedAt`/`reimbursedAt` stamps). The policy engine runs but for **migrated** history we **do not block** on a cap breach — we record the verdict as a WARN (`policyVerdict` is stored either way). This gives the owner exactly the "claim/approved amounts for back-dated employees" they asked for.

---

## 7. Auto-generation triggers (the heart of the feature)

The owner's rule — *"when attendance entered + CTC set, payslips auto-prepare"* — is implemented as an explicit **autogen pass** that runs after COMMIT (or on demand), reusing the engines. It is **never** a hidden side-effect of a single row write; it is an orchestrated walk over `(employee, period)` pairs.

### 7.1 Payslip autogen (`autogen.service.generatePayrollForPeriod`)

Pre-conditions per `(entity, periodMonth)` — checked, and missing pre-conditions surface as findings rather than silent skips:

1. Each in-scope employee has a `CompensationRevision` effective on `periodEnd` (`resolveCurrentCompensation`). Missing → `NO_CTC` ERROR (employee excluded from the run, not the whole run).
2. Each has attendance for the period — either daily `Attendance` rows or a staged `AttendancePayInput`. Missing → handled by freeze's `NO_ATTENDANCE_DATA` WARN (pays calendar days) **or** excluded per option.

Then, **per period**, in one logical job:

```
createRun({ businessId, entityId, payCalendarId, periodStart, periodEnd })   // type=MIGRATED, importJobId set
  → (for DAILY attendance) recompute(...) per employee to materialise Attendance rows
  → computeRun({ businessId, payRunId, freezeAttendance:true })              // freeze → AttendancePayInput → engine → Payslip
  → optionally approveRun(...) + publish                                      // gated by option + SoD
```

- `createRun` is reused as-is; we set `type:'MIGRATED'` and `importJobId`. Its `(businessId, code)` exactly-once guard makes re-running safe. (Code collides with a live run? Migrated runs use a distinct code suffix, e.g. `PR-2025-12-IN-MIG`, so a migration never shadows a real run for the same month.)
- `computeRun({ freezeAttendance:true })` does the **freeze + compute + persist atomically** — exactly the live path. For SUMMARY attendance we pre-write the `AttendancePayInput` so freeze's rollup is a no-op (it upserts the same period; we set `optionsJson.skipReFreeze` to keep the staged figures authoritative).
- **Publish** for migrated runs is **optional and SoD-gated**: by default migrated payslips are generated + approved by the importer but **not** auto-published to ESS until an admin reviews (avoids surprising employees with historical payslips). `optionsJson.publish:true` publishes through the existing webhook/notification path.
- **RECONCILE** mode: after `computeRun`, the autogen compares each `PayRunLine.netPay`/statutory rollups to the imported figures and writes `IMPORT_MISMATCH_*` to `ImportRow.findingsJson` + the run's anomaly list (reusing the variance surface).

### 7.2 Reimbursement autogen

Per REIMBURSEMENT row, commit **is** the generation: `createClaim` → status-drive to target. No separate pass. The "claimed vs approved" amounts the owner wants are the claim's `amount` (claimed) and the approved decision amount. Back-dated `decidedAt`/`reimbursedAt` come from the file; `paymentRef` carries the legacy payout reference.

### 7.3 Ordering & dependencies

The Import Center enforces the dependency order (and the API rejects out-of-order autogen):

```
EMPLOYEE  →  COMPENSATION  →  ATTENDANCE  →  PAYROLL_HISTORY (autogen payslips)
                                            REIMBURSEMENT (autogen claims)
```

A combined **"Migration wizard"** can chain these from a single multi-sheet workbook (one sheet per kind), running each kind's commit then the autogen, stopping on the first kind with blocking ERRORs.

---

## 8. API (all admin, tenant-scoped, RBAC-gated)

Mount under `/api/imports`. Permission: a new `canManageImports` capability (granted to the Owner/HR-Admin roles in F1's seed), plus the **existing** per-kind permission for the side-effect (e.g. autogen-payroll additionally requires `canRunPayroll`; auto-publish requires `canApprovePayroll` — SoD is **not** weakened by going through import).

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /imports/templates/:kind` | `canManageImports` | Download the `.xlsx`/`.csv` template (+ data dictionary). |
| `POST /imports` (multipart) | `canManageImports` | Upload a file → create `ImportJob` (UPLOADED); returns job + detected headers. Exactly-once on `fileHash`. |
| `GET /imports` | `canManageImports` | List jobs (filter by kind/status), tenant-scoped, paginated. |
| `GET /imports/:id` | `canManageImports` | Job detail + rollups + preview. |
| `PATCH /imports/:id/mapping` | `canManageImports` | Save `mappingJson`; re-parse + re-validate. |
| `POST /imports/:id/validate` | `canManageImports` | Run parse + validate; returns counts + findings. |
| `POST /imports/:id/dry-run` | `canManageImports` (+ kind perm) | Simulated commit+autogen in a rolled-back tx; returns engine-true preview + annotated-file link. |
| `POST /imports/:id/commit` | `canManageImports` (+ kind perm) | Commit valid rows via the reused engines. SoD: `committedBy` recorded; for payroll autogen, maker≠checker on approve still holds. |
| `POST /imports/:id/autogen` | `canRunPayroll` | Trigger §7 generation for the committed period(s). |
| `GET /imports/:id/report` | `canManageImports` | Download the annotated result file. |
| `GET /imports/:id/rows?status=ERROR` | `canManageImports` | Paginated rows for the error grid. |
| `POST /imports/:id/cancel` | `canManageImports` | Cancel a non-committed job. |

Routes use `withEmployeeScope` only where a row targets a single employee read; the import operations themselves are business-scoped (the operator must hold `canManageImports`, which is org-wide, not row-scoped). Controllers are thin; all logic in `imports.service.js` / `autogen.service.js`.

---

## 9. hr-admin & ESS UX (plain language)

### hr-admin — "Import Center" (new nav item under Settings → Data)

1. **Pick what to import** — five big cards (Employees, Salary/CTC, Attendance, Payroll History, Reimbursements) each with a "Download template" link and a one-line description of what it does and what it needs first (dependency hint).
2. **Upload** — drag a file in. We show detected sheet(s) + the first 10 rows so the admin sees we read it correctly.
3. **Map columns** — a two-column mapper: our field ← your column. Auto-matched fields are pre-filled and green; unmapped required fields glow red. The admin fixes the few that didn't auto-match.
4. **Preview (dry-run)** — a results table: every row with a green/amber/red dot and a plain-English reason ("PAN ABCDE1234X is invalid", "Hotel ₹6,500 exceeds the Tier-2 L3 cap — will import as a flagged over-policy claim"). For payroll history we additionally show a **computed net-pay column** so the admin can compare against the old payslips, plus the totals. A "Download annotated file" button. **Nothing is saved yet** — a banner says so.
5. **Fix & re-upload or Commit** — the admin either downloads the annotated file, fixes reds in Excel, re-uploads (same job, replaces rows), or clicks **Commit** to write the green/amber rows. Reds are skipped and listed.
6. **Auto-generate** — after committing CTC + attendance, a prominent "Generate payslips for these months" button runs the autogen; a progress view streams per-period status. After committing reimbursements, claims appear immediately with their claimed/approved amounts.
7. **History** — every job listed with kind, who, when, counts, and a re-download of the report. A "View generated payslips" deep-links into the payroll console (runs badged **Migrated**).

The whole flow mirrors the live app's guard-rails so the admin never hits a surprise: the Commit button is disabled while required fields are unmapped or while a dry-run hasn't run; the auto-publish toggle is disabled for a user lacking `canApprovePayroll`.

### ESS — read-only

- Migrated payslips appear in the employee's payslip history **only after an admin explicitly publishes** them, with a small **"Imported"** tag so the employee knows it's historical/migrated data.
- Migrated reimbursement claims show in the employee's claim history with their original dates and an "Imported" tag; they are read-only (no edit/withdraw on a historical claim).

---

## 10. Build plan (5 slices)

**Slice 18a — Import scaffold + EMPLOYEE kind (upload→parse→map→validate→dry-run→commit).**
`ImportJob`/`ImportRow` models + migration; `imports.service.js` pipeline; `exceljs`/`papaparse` parse; pure `validators/employee.js`; EMPLOYEE template; routes + controller + `canManageImports`; commit via `provisionEmployee`. Idempotency (fileHash exactly-once, naturalKey upsert) + audit. hr-admin Import Center shell with the EMPLOYEE flow end-to-end. Tests: parse fixtures, validator goldens, idempotent re-commit.

**Slice 18b — COMPENSATION + ATTENDANCE kinds.**
`deriveBreakup`-backed CTC commit (target → revision + lines, reconcile tolerance, PF-floor reuse); ATTENDANCE DAILY + SUMMARY commit (upsert `Attendance` / stage `AttendancePayInput`, respect `isLocked`). Templates + validators. UI cards. Tests: derived-gross-reconciles golden, locked-day-not-clobbered, summary→AttendancePayInput shape.

**Slice 18c — PAYROLL_HISTORY autogen (the core).**
`autogen.service.generatePayrollForPeriod` reusing `createRun`(`type:MIGRATED`)→`computeRun({freezeAttendance:true})`; `GENERATE` mode end-to-end; dry-run shows engine-true net pay; per-employee `NO_CTC`/`NO_ATTENDANCE_DATA` findings; MIGRATED run code suffix + immutability/idempotency. UI: per-period progress + "Migrated" badge in payroll console. Tests: back-dated run computes a correct India payslip (PF cap, PT slab, TDS) golden; re-run is a no-op.

**Slice 18d — RECONCILE mode + REIMBURSEMENT kind.**
RECONCILE compare (engine vs imported, `IMPORT_MISMATCH_*` WARNs, tolerance); REIMBURSEMENT commit via `createClaim` + back-dated status-drive (claimed/approved/reimbursed, legacy paymentRef); policy-verdict-as-WARN for migrated. UI: mismatch column, claim history with Imported tag. Tests: mismatch surfacing, back-dated claim settlement, claimNumber mint + idempotency.

**Slice 18e — Migration wizard, ESS surfacing, hardening & report.**
Multi-sheet workbook wizard chaining the kinds in dependency order; optional SoD-gated auto-publish of migrated payslips; ESS "Imported" tags (payslips + claims, read-only, publish-gated); annotated-report download; cancel/cleanup; full audit; row-isolation on commit (one bad row never aborts the batch); 10MB/20k-row caps. End-to-end test: empty tenant → workbook → employees+CTC+attendance+6 months of payslips+claims visible.

---

## 11. Security, isolation & edge cases

- **Tenant isolation:** every query carries `businessId`; `fileKey` is namespaced per tenant; the `(businessId, kind, fileHash)` unique never matches across tenants. An `employeeCode` resolved during commit is re-checked against `businessId` (a row referencing another tenant's code resolves to nothing → ERROR).
- **RBAC / SoD:** import is `canManageImports`-gated; the side-effects keep their own permission (autogen-payroll needs `canRunPayroll`; auto-publish needs `canApprovePayroll`). **Maker-checker is not bypassed:** a migrated run's `approveRun` still enforces `MAKER_CHECKER` (approver ≠ computedBy) — if the importer both commits and approves with auto-publish, the engine 409s unless a second actor approves. The default migrated flow leaves runs at `COMPUTED`/`APPROVED` un-published precisely so SoD is preserved.
- **Idempotency (three layers):** (1) job-level exactly-once on `fileHash`; (2) row-level upsert on `naturalKey`; (3) engine-level — `computeRun` idempotent on `inputHash`, `createRun` on `(businessId, code)`, `freezeAttendance` upserts on `(payRunId, employeeId)`, `createClaim` on `(businessId, claimNumber)`. Re-running any step is safe.
- **Immutability:** import can **never** mutate an `APPROVED`/`PAID`/`FILED` run or a locked `Attendance` day — the engines reject it (`IMMUTABLE_RUN_VIOLATION`, monotonic freeze). A migration that overlaps a real run is refused at validate (period-overlap finding) so history can't rewrite a live payslip.
- **Row isolation on commit:** each row commits in its own nested operation; an engine throw on one row marks that `ImportRow.FAILED` and continues (the batch isn't aborted). Dry-run, by contrast, rolls back the *whole* simulation.
- **Money/precision:** file ₹ → `money.toMinor`; all engine math in minor units; reconcile tolerances are integer-paise comparisons. No float ever reaches a payslip.
- **Back-dated correctness:** the engine resolves the **rule version as-of the period end** (`resolveModule(country, period.end)`), so a payslip generated for 2025-08 uses the PF/PT/TDS rules in force then — not today's. This is why we *generate* rather than copy: the legacy provider's figures may have used different (older) rules, which is exactly what RECONCILE surfaces.
- **Validation traps:** duplicate natural keys within one file (two rows, same employee+month) → second is an ERROR (`DUPLICATE_IN_FILE`); unmapped required field → job ERROR; a CTC whose derived gross can't reconcile (BALANCING would go negative) → ERROR (`CTC_UNRECONCILABLE`); an attendance row whose `payableDays > calendarDays` → ERROR; a claim with `approvedAmount > claimedAmount` → WARN (allowed but flagged).
- **File safety:** MIME allow-list (`xlsx`/`xls`/`csv`), 10MB cap, 20k-row cap, streamed parse (no whole-file-in-memory blow-up), formula-injection guard on CSV (cells starting `=,+,-,@` are quoted/neutralised on both import-read and report-write).
- **Country lock (OWNER PRINCIPLE):** validators + engine + breakup are selected by `Entity.countryCode` only. An IN tenant's templates show IN columns (PAN/UAN/PT) and never NZ fields; the importer cannot create a payslip under another country's rules. Single-country-per-tenant is preserved end to end.
- **GDPR / retention:** the raw uploaded file is retained per the tenant's data-retention policy and is soft-deletable; `ImportRow.rawJson` may carry PII (PAN/bank) → it inherits the same `@retain:statutory`/soft-delete treatment as the lifecycle PII it mirrors, and is purged with the job.
- **Cleanup / unwind:** a committed job is **not** auto-reversible (it produced real, possibly-approved artifacts), but the `ImportRow.targetType/targetId` provenance + `importJobId` on the artifacts make a *targeted* admin unwind of a not-yet-approved migrated run possible (delete DRAFT/COMPUTED runs by `importJobId`); approved/published artifacts follow the normal correction/reissue path, never a hard delete.

---

## 12. Roadmap / NZ note

NZ migration is a roadmap item: the same pipeline, with NZ validators (IRD number, tax code, KiwiSaver status, bank account format) and the NZ compliance module selected by `Entity.countryCode='NZ'`. Because the pipeline is country-parameterised and the engines are already country-true, NZ is **new validators + a template set**, not a new pipeline. Per the owner principle, an NZ tenant only ever sees NZ templates/fields; nothing about IN surfaces. Deferred until the India migration path is in production.

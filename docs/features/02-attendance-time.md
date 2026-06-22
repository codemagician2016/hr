# DriftHR — Feature Spec: Attendance & Time (v1)

**Status:** Build-ready dev contract • **Markets:** India 🇮🇳 + New Zealand 🇳🇿 • **Surfaces:** HR console + ESS

This spec synthesizes the implementation audit, the production design, and the per-role experience into one shippable contract. It binds **only** to already-shipped interfaces and is deliberately additive to the schema.

---

## 1. Summary & Goals

The attendance subsystem today is a **capture shell with a dead derivation core**. Punches can be recorded and listed; shift patterns and assignments have CRUD; timesheets have a read + state machine; and the frozen payroll feed (`AttendancePayInput`) is consumed correctly by the payroll engine. But the **middle of the pipeline does not exist**: punches are never aggregated into the daily `Attendance` rollup, no derivation logic sets status/LOP/OT, holidays and leave never touch attendance, and the only thing that populates the payroll feed is the seed.

**Goal of v1:** make the pipeline real and deterministic —

```
AttendancePunch ┐
LeaveTransaction├─► derive(E,D) ─► Attendance ─► period roll-up ─► freeze ─► AttendancePayInput ─► engine.inputs
Holiday         ┤   (pure fn)      (1/emp/day)    (Timesheet)      (immutable)        (shipped)
Schedule        ┘
```

**Success = five guarantees:**
1. A punch, once derived, produces exactly one `Attendance` row per `(employee, day)` with correct `status`/`lopFraction`.
2. A leave day is `ON_LEAVE`, never `ABSENT`.
3. `lopDays = Σ lopFraction` and `overtimeHours` flow into `AttendancePayInput` and reconcile with the payroll engine's proration.
4. Freeze is immutable and monotonic: locked rows never retro-mutate.
5. Every read is tenant- + scope-filtered via the shipped `scopeWhere`; out-of-scope single-row target → **404, not 403**.

---

## 2. Scope — In / Out (pragmatic v1)

### In scope
- Derivation engine `derive(E, D)` — pure, golden-tested (mirrors the payroll engine).
- Daily `Attendance` rollup — write on punch, recompute nightly. Add the missing `employee` relation.
- Holiday calendar — CRUD + statutory import for the existing `Holiday` model.
- Leave ↔ attendance bridge — read `LeaveTransaction` (APPROVED/AVAILED) in derivation.
- Regularization repointed onto the real `AttendanceRegularizationRequest` model with real `status`, `decidedBy/At`, and a non-no-op approve.
- Freeze bridge `freezeAttendance(payRunId, …)` → writes `AttendancePayInput` from the rollup.
- Period-close + lock guard — bulk `Attendance.isLocked`, lock check in `createPunch`/`createRegularization`.
- Org dashboard / summary endpoint — aggregate `Attendance` by status/date.
- ESS self-service — self-submit timesheet, self-raise regularization.
- Bulk punch import — CSV / biometric feed (`source: IMPORT|BIOMETRIC|KIOSK`).
- Shift-assignment overlap validation.
- Frontend: hr-admin shifts (full fields), assignment, holiday calendar, dashboard, period-close; ESS clock, my-timesheet, regularization, my-schedule.

### Out of scope (deferred, design-stubbed)
- Biometric vendor integrations — design the contract, accept `source=BIOMETRIC`, store selfie as opaque URL only.
- Rotating-roster engine + `WeekOffRule` — v1 ships static `ShiftPattern.weeklyOffDays` + effective-dated `ShiftAssignment`; resolver is roster-extensible.
- Separate `OnDutyRequest`/`OvertimeRequest` models — v1 folds WFH/On-Duty into a `kind` discriminator; OT auto-computed (no pre-approval).
- NZ Holidays Act leave **valuation** at runtime — `holidaysAct.js` stays a pure library; attendance only marks `ON_LEAVE`/`HOLIDAY` and emits the Alternative-Day accrual hook.
- Geofence/IP hard-block — accept + flag as exception only.

---

## 3. Data Model Changes (Prisma — minimal, additive)

### 3.1 `Attendance` — add the missing `employee` relation
```prisma
  employee   Employee @relation("EmployeeAttendances", fields: [employeeId], references: [id], onDelete: Cascade)
// and on Employee:
  attendances Attendance[] @relation("EmployeeAttendances")
```

### 3.2 `ShiftPattern` — derivation config columns
```prisma
  graceOutMinutes      Int?
  minMinutesForPresent Int?
  isFlexi              Boolean  @default(false)
  otEligible           Boolean  @default(false)
  dailyOtThresholdMin  Int?
  @@index([businessId, isActive])
```

### 3.3 `AttendanceRegularizationRequest` — `kind` discriminator
```prisma
  kind RegularizationKind @default(MISSED_PUNCH)
enum RegularizationKind { MISSED_PUNCH LATE_WAIVER EARLY_OUT_WAIVER WFH ON_DUTY }
```
Relations already exist; the work is repointing the controller.

### 3.4 `OvertimeRule` — new, optional, entity/location-scoped
```prisma
model OvertimeRule {
  id String @id @default(uuid())
  businessId String
  entityId   String?
  locationId String?
  dailyThresholdMin  Int    @default(480)
  weekdayMultiplier   Decimal @db.Decimal(4,2) @default(1.0)
  weeklyOffMultiplier Decimal @db.Decimal(4,2) @default(2.0)
  holidayMultiplier   Decimal @db.Decimal(4,2) @default(2.0)
  dailyCapMin Int?
  roundingMin Int @default(15)
  isActive Boolean @default(true)
  @@index([businessId, entityId, locationId])
}
```
No rule → derivation defaults (no OT unless `ShiftPattern.otEligible`).

### 3.5 Reuse as-is
`AttendancePunch`, `Holiday`(+`HolidayType`), `ShiftAssignment`, `Timesheet`/`TimesheetEntry`(+`TimesheetStatus`), `AttendancePayInput` (`@@unique([payRunId, employeeId])`), `RequestStatus`, `AttendanceStatus` (already has `WORK_FROM_HOME`/`ON_DUTY`/`HOLIDAY_WORKED`/`MISSING_PUNCH`/`WEEKLY_OFF`/`HOLIDAY`).

---

## 4. Backend

### 4.1 Derivation engine — pure (`backend/src/hr/attendance/derive.js`)
No DB access inside `derive` — caller fetches, `derive` computes.
```js
// derive(ctx) -> DerivedDay (pure, deterministic, idempotent)
// ctx = { date, tz, schedule, punches[], leaveTxns[], holiday, weeklyOff, otRule }
// returns { status, firstIn, lastOut, workedMinutes, breakMinutes,
//           overtimeMinutes, lopFraction, exceptions[] }
```
**Step A — pair punches → segments → minutes:** sort by `punchAt`; fold `IN→OUT` into work segments, `BREAK_START→BREAK_END` into break segments; `workedMinutes = Σwork − ΣunpaidBreak`; `missingPunch` = odd IN/OUT count. Use **elapsed UTC minutes** (NZ DST night-shift correct).

**Step B — classify (priority decision table, first match wins):**

| # | Condition | status | lopFraction |
|---|---|---|---|
| 1 | full-day leave, `affectsLOP=false` | `ON_LEAVE` | 0 |
| 2 | full-day leave, `affectsLOP=true` | `ON_LEAVE` | 1.0 |
| 3 | holiday + punches | `HOLIDAY_WORKED` | 0 |
| 4 | holiday, no punches | `HOLIDAY` | 0 |
| 5 | weekly-off + punches | `HOLIDAY_WORKED` | 0 |
| 6 | weekly-off, no punches | `WEEKLY_OFF` | 0 |
| 7 | approved WFH | `WORK_FROM_HOME` | 0 |
| 8 | approved On-Duty | `ON_DUTY` | 0 |
| 9 | half-day leave + present other half | `HALF_DAY` | 0.5 if leave-half unpaid else 0 |
| 10 | missingPunch + require-both | `MISSING_PUNCH` | 0 (pending) |
| 11 | `worked ≥ fullDay − grace` | `PRESENT` | 0 |
| 12 | `halfDayThreshold ≤ worked < fullDay` | `HALF_DAY` | 0.5 |
| 13 | `0 < worked < halfDayThreshold` | `ABSENT`/`HALF_DAY` per policy | 1.0/0.5 |
| 14 | no punches, scheduled working day | `ABSENT` | 1.0 |
| — | no schedule (open-attendance) | `PRESENT` if any punch else null | 0 |

**Step C — exceptions:** `LATE_IN`, `EARLY_OUT`, `OUT_OF_GEOFENCE`, `IP_BLOCKED`, `SELFIE_FAILED`, `MISSING_PUNCH`, `EXCESS_BREAK`, `UNDERTIME`.

**Step D — OT:** `otMinutes_raw = max(0, worked − dailyOtThresholdMin)`; full `worked` on HOLIDAY_WORKED/weekly-off-worked. Collapse multipliers: `otEquivalentHours = Σ(otMinutes_d × multiplier_d)/60` → feeds engine's existing `inputs.otHours`.

**`resolveSchedule(E, D)`:** (1) `ShiftAssignment` effective-dated; (2) entity/location default; (3) none → open-attendance. Roster reserved for v2.
**`isHoliday(E,D)`:** most-specific scope wins `(entity,location) > (entity,*) > (*,location) > (*,*)`.

### 4.2 Endpoints (all via the Feature-1 resolver)
- `POST /punch` **MODIFY** — add `withEmployeeScope('canViewEmployees')` + period-lock check; on success enqueue `derive`.
- `POST /punches/import` **NEW** `canManageAttendance` — CSV/biometric, per-row validate, dedupe, all-or-nothing + error report.
- `GET /summary` **NEW** `canViewEmployees`+scope — `?from=&to=&groupBy=status|date`. Powers the dashboard.
- `POST /derive` **NEW** internal — idempotent recompute `(E, range)`; nightly cron + on-punch.
- `GET/POST/PATCH/DELETE /holidays` **NEW** — CRUD; `POST /holidays/import` seeds statutory set (NZ mondayised + provincial; IN restricted/optional).
- `POST /period/close` **NEW** `canManageAttendance` — bulk lock; blocks further writes in range.
- `POST /shifts/:id/assign` **MODIFY** — overlap validation.
- `POST /timesheets/:id/submit` **MODIFY** — allow owning employee (self).
- `POST /regularizations` **REPOINT** — self-create allowed; write `AttendanceRegularizationRequest` (PENDING) + route via `resolveApprover` → MANAGER.
- `POST /regularizations/:id/approve` **REPOINT** — `status=APPROVED`, materialize MANUAL punches, re-run `derive`.
- `POST /regularizations/:id/reject` **REPOINT** — `status=REJECTED` (no hard-delete).
- `GET /regularizations` **REPOINT** — read the dedicated model.

### 4.3 Timesheet state machine (reuse)
`DRAFT → SUBMITTED → {APPROVED → LOCKED | REJECTED → SUBMITTED}`. v1: submit self-allowed; LOCKED set by freeze; approve routes via `resolveApprover`.

### 4.4 Payroll bridge — `freezeAttendance(payRunId, …)` (`backend/src/hr/attendance/freeze.js`)
Called from PayRun compute. One `AttendancePayInput` per employee:
```
calendarDays  = daysBetweenInclusive(periodStart, periodEnd)
weeklyOffDays = count(WEEKLY_OFF);  holidayDays = count(HOLIDAY|HOLIDAY_WORKED)
paidLeaveDays = Σ leaveDays where affectsLOP=false
lopDays       = Σ Attendance.lopFraction
overtimeHours = Σ otEquivalentHours
payableDays   = calendarDays − lopDays
sourceJson    = { attendanceIds, leaveTxnIds, otRuleId, basis }
frozenAt      = now()
```
Maps 1:1 onto engine `inputs`. Then lock `Attendance` + transition timesheets to LOCKED. Post-freeze corrections → next-period arrears, never retro-mutation.

---

## 5. Frontend

### 5.1 hr-admin (`apps/hr-admin/app/attendance/page.js`)
- **Shifts** extend — expose `breakMinutes`, `graceInMinutes`, `fullDayMinutes`, `halfDayThresholdMinutes`, `weeklyOffDays`, `isNightShift`, `crossesMidnight`, `entityId`, `isActive`; dup code → 409.
- **Assignments** extend — multi-picker `effectiveFrom/To` + overlap warning.
- **Holidays** NEW tab — year grid; filters; add-form + "Import statutory set".
- **Dashboard** NEW — today counts by status; present% trend; exceptions list. Manager sees sub-tree only.
- **Period Close** NEW — Reconcile (blockers) → lock → freeze via PayRun compute. Steps hidden by permission.
- **Regularizations** repoint UI — real status/decidedBy; `:requestId`.
- **Import** NEW — CSV upload → mapping → preview → commit → report.

### 5.2 ESS (`apps/ess/app/attendance/page.js`)
- **Clock in/out + breaks** EXISTS — keep; mobile sends `source:'MOBILE_APP'` + geo + selfie.
- **My timesheet** NEW — period list + status + Submit CTA (self-allowed).
- **Request correction** NEW — date, requested-in/out, kind, reason → self-create → routes to manager.
- **My schedule + holidays** NEW.
- **Period summary** EXISTS — authoritative payable = frozen `AttendancePayInput`.

---

## 6. End-to-End per Role + Acceptance Criteria

**Cross-cutting:** every list filters by `scopeWhere`; every single-row/target write checks `scopeAllows` → 404 not 403; `punchAt` UTC, rendered in location TZ; LOCKED/`frozenAt` immutable.

**HR-Admin (ALL):** AC-HA1 create shift; AC-HA2 NZ import mondayised + provincial, IN restricted; AC-HA3 dashboard reconciles to rows; AC-HA4 close blocks on exceptions then locks; AC-HA5 compute → one AttendancePayInput per (payRun,employee) with frozenAt + sourceJson.
**Manager (TEAM):** AC-MG1 sub-tree only; AC-MG2 out-of-scope decide → 404; AC-MG3 today board + absentee; AC-MG4 master tabs hidden.
**Employee (SELF):** AC-ES1 double-clock prevented; AC-ES2 self-submit own timesheet; AC-ES3 self-raise correction → manager; AC-ES4 my-schedule + holidays.

---

## 7. QA Plan — 37 numbered cases

### 7.1 Derivation goldens (`derive.golden.test.js`)
1 PRESENT full day · 2 LATE_IN flag · 3 HALF_DAY threshold · 4 ABSENT · 5 leave≠absent paid · 6 leave≠absent unpaid · 7 HOLIDAY no punches · 8 HOLIDAY_WORKED · 9 WEEKLY_OFF · 10 weekly-off worked · 11 night shift over midnight · 12 NZ DST night shift (elapsed UTC) · 13 half-day leave + present half · 14 MISSING_PUNCH then regularize · 15 OT daily threshold · 16 no-schedule open-attendance · 17 WFH/On-Duty · 18 idempotency.
### 7.2 Freeze / payroll bridge
19 rollup → AttendancePayInput · 20 OT to engine · 21 freeze immutability · 22 unique freeze.
### 7.3 RBAC / scope
23 manager sees only team · 24 out-of-scope target → 404 · 25 out-of-scope query → silent empty · 26 ESS self-only · 27 ESS self-submit allowed · 28 punch scope guard · 29 period-lock guard → 409 · 30 tenant wall.
### 7.4 Holiday / import
31 NZ mondayisation · 32 IN restricted optional · 33 holiday scope resolution · 34 import idempotency.
### 7.5 State machines / overlap
35 timesheet illegal transition → 409 · 36 regularization approve materializes + re-derives · 37 assignment overlap rejected.

---

## 8. Build Sequence (one focused pass)

1. **Data model** — Attendance.employee relation + Employee.attendances; ShiftPattern config + index; RegularizationKind/kind; OvertimeRule. One additive migration.
2. **Status engine + goldens** — `derive.js` + `resolveSchedule`/`isHoliday` + 18 goldens. Build before endpoints (load-bearing core, highest risk).
3. **Endpoints** — recompute/derive → summary → holidays CRUD+import → repoint regularization → period/close + lock guards → punch scope guard + import → freeze bridge into PayRun compute. Each scoped. Freeze + RBAC tests here.
4. **UI** — hr-admin: shift fields → assignment overlap → holidays tab → dashboard → period-close. ESS: my-timesheet → regularization → my-schedule.
5. **QA** — all 37 cases; goldens + RBAC-scope are the merge gate.

### Key existing files
- Schema: `backend/prisma/schema.prisma` — `Attendance`, `AttendancePayInput`, `ShiftPattern`, `AttendanceRegularizationRequest`, `Holiday`.
- Controller: `backend/src/hr/controllers/attendance.controller.js` (`TIMESHEET_TRANSITIONS`; regularization no-op; stale SCHEMA NOTE).
- Routes: `backend/src/hr/routes/attendance.routes.js`.
- RBAC: `backend/src/core/lib/rbac.js`; `backend/src/hr/lib/scopeResolver.js`; `backend/src/hr/lib/approvalRouting.js`; `backend/src/hr/middleware/scope.middleware.js`.
- Payroll bridge: `backend/src/hr/payroll/engine.js` (`resolveProration`/`applyProration`), `service.js`, `compliance/holidaysAct.js`.
- New files: `backend/src/hr/attendance/derive.js`, `…/freeze.js`, `…/__tests__/derive.golden.test.js`, holidays controller/routes.

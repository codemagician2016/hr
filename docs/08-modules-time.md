# 08 — Module: Time & Attendance (Leave, Attendance, Timesheets → Payroll Feed)

> **Status:** Production design (v1). **NOT an MVP.**
> **Author role:** Senior HR Domain Analyst — Time & Attendance.
> **Markets:** India (IN, INR) and New Zealand (NZ, NZD). Tax/leave year **Apr–Mar in both**.
> **Last reviewed against 2026 compliance facts:** 2026-06-22.
> **Surfaces touched:** Tenant Admin (HR console, `app.hr.com`) and Employee Self-Service (white-label, `tenant.com`). Super Admin owns the *rule tables* this module reads (rates/limits/holiday calendars) but does not run attendance.
>
> **Sibling docs** (the architecture doc names some files `0x-…`; this module set uses the `0x-modules-*` convention — both naming schemes refer to the same logical docs, cross-referenced by topic below):
> - `02-system-architecture.md` — monorepo, tenant resolution, BullMQ pay-run queue, region pinning.
> - `03-data-model.md` / `02-data-model-hr-core.md` — canonical Prisma schema (Employee, Business, Department, Location, etc.).
> - `04-payroll-engine-design.md` — the calculation engine and pay-run state machine that **consumes** this module's `AttendancePayInput` feed (§14).
> - `05-compliance-IN.md` / `06-compliance-NZ.md` — versioned rule tables: EPF/ESI/PT thresholds, Holidays Act parameters, public-holiday calendars, OT multipliers.
> - `09-modules-leave-holidays-act.md` is **this** doc's deeper NZ companion where one exists; the Holidays Act engine spec (§6) is authoritative here.
> - `10-ess-and-mobile.md` — ESS shell, mobile clock-in UX wrapping the APIs in §11/§13.
> - `08-notifications-i18n-and-theming.md` — notification channels used by approval workflows.

---

## 0. Design tenets (opinionated, non-negotiable)

1. **Time is the *source of truth* for pay variability.** Everything in this module exists to produce two clean, provable numbers per employee per pay period: **payable days/hours** and **adjustments** (LOP, OT, leave-without-pay, leave encashment days). The payroll engine treats this module as an *upstream snapshot provider* (§14). It never recomputes attendance.
2. **Two fundamentally different worlds: salaried vs. waged.** IN salaried staff are paid a monthly fixed amount with *deductions for absence* (LOP-down model). NZ (and IN waged/contract) staff are paid *for hours worked* (build-up model), and leave is measured/paid under the **Holidays Act 2003** in **weeks**, not days. The data model must natively represent both; we never coerce NZ weeks into IN days.
3. **The Holidays Act is the hardest, highest-value calculation we own.** NZ annual leave is in **weeks**, paid at the **greater of Ordinary Weekly Pay (OWP) and Average Weekly Earnings (AWE)**; daily leaves (public holiday, sick, bereavement, family violence) pay **Relevant Daily Pay (RDP)** or, where it can't be determined / pay varies, **Average Daily Pay (ADP)**. Every cent must be explainable to an auditor and reproducible against a pinned rule version. (§6) ([Employment NZ — pay for sick/bereavement/family violence](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/leave-and-holiday-pay/pay-for-sick-bereavement-and-family-violence-leave), [Holidays Act 2003 s.16](https://www.legislation.govt.nz/act/public/2003/0129/latest/DLM236874.html))
4. **Compliance is *data*, owned by Super Admin.** Statutory leave minimums, OT multipliers, weekly-hour caps, public-holiday calendars, mandatory register formats — all are **versioned rule-table rows** resolved by `(country, region, effectiveDate)`. Tenants *configure within* the statutory floor; they cannot author below it. (Mirrors `04-payroll-engine-design.md` tenet 7.)
5. **Every attendance event is immutable and explainable.** Raw punches are append-only. Corrections are *new events* (regularizations) that reference the original, never silent edits. The "why is my pay docked one day?" question is answerable to the punch, forever. This mirrors Sitepresso's append-only ledger discipline (`AdjustmentLedger`, `backend/prisma/schema.prisma`).
6. **Geo/biometric data is sensitive PII, region-pinned.** Selfie images, GPS coordinates and biometric template references inherit the platform's data-residency posture (`02-system-architecture.md` §9): IN tenant biometric/geo PII stays in-region, NZ likewise. We store **template references and hashes**, never raw biometric vectors we can re-identify off-device where avoidable.
7. **Configure, don't build.** Per the platform principle, tenants pick from **pre-built leave types, shift patterns, OT policies and geofence modes**. No formula builder, no custom-field designer for time. They toggle, set numbers within bounds, and assign. (Mirrors `02-system-architecture.md` North Star 2.)

---

## 1. Where this sits in the platform (reuse map)

| Concern | Reuse from Sitepresso (READ-ONLY base at `/Users/kp/sitepresso`) | New in HR |
|---|---|---|
| Tenant isolation (row-level `businessId`) | `backend/src/core/middleware/requireBusiness.js`; every model carries `businessId` (`backend/prisma/schema.prisma`) | All time/leave models carry `businessId` + `employeeId` |
| Weekly working-hours grid | `backend/src/booking/controllers/hours.controller.js` (`BusinessHours { dayOfWeek, openTime, closeTime, isClosed }`, 7-day fill) | Generalized into `WorkPattern` / `ShiftTemplate` (§7) |
| Per-staff schedule slots w/ lunch break | `backend/src/booking/controllers/schedule.controller.js` (`{ dayOfWeek, startTime, endTime, lunchStart, lunchEnd }`, `toMinutes`, slot-overlap validation) | Reused verbatim as the shift-slot validator for rosters |
| Leave request + approve/auto-approve + email notify | `backend/src/booking/controllers/leave.controller.js` (`requestLeave`, `staffLeave` unique `staffId_date`, auto-approve toggle, `sendLeaveRequestAdminEmail` / `sendLeaveStatusStaffEmail`) | Generalized to typed leave with accrual, balances, multi-step approval (§5) |
| Background jobs (reminders, auto-cancel patterns) | `backend/src/core/lib/scheduler.js` (`processBookingReminders`, `processAutoCancellations`, `nowInTimezone`); `backend/src/scheduler-worker.js` | `accrual-worker`, `roster-worker`, `timesheet-lock-worker` on BullMQ (per `02-system-architecture.md` §7) |
| Notifications (in-app + email + webhook) | `backend/src/core/lib/notifications/`, `backend/src/core/controllers/notification.controller.js` | Approval/escalation/clock-reminder events routed through it |
| i18n | `backend/src/i18n/translator.js` (en/hi) | Leave/attendance copy localized en, hi; NZ en |
| RBAC / auth | `backend/src/core/middleware/auth.middleware.js`, `backend/src/core/lib/rbac.js` (`effectivePermissions`, `hasPermission`) | Adds `TIME_MANAGER`, `ROSTER_PLANNER`, `LEAVE_APPROVER` permissions (§12) |
| Money discipline | `amountMinor Int` convention across billing models | Leave-encashment & OT amounts in minor units |

**Module boundary:** backend lives at `backend/src/hr/time/` (attendance, shifts, rosters, timesheets) and `backend/src/hr/leave/` (leave types, accrual, balances, Holidays Act engine `backend/src/hr/leave/holidays-act/`). The Holidays Act engine is a **pure-compute package** with zero HTTP/Prisma imports in its core (same discipline as the payroll engine), fed snapshots and rule versions.

---

## 2. Domain vocabulary

| Term | Definition |
|---|---|
| **Work pattern** | The expected working week for an employee/pay-group: which weekdays are working days, expected start/end, break, expected daily hours. Drives "otherwise working day" tests and expected-vs-actual. |
| **Shift** | A concrete dated working window (`date`, `start`, `end`, `breaks[]`, `location`), possibly from a roster. |
| **Roster** | A published schedule of shifts for a team/location over a date range. |
| **Punch / clock event** | An immutable timestamped IN/OUT/BREAK event with source, location, selfie/biometric proof. |
| **Attendance day** | The derived per-employee-per-date record summarizing punches → status, worked minutes, OT minutes, late/early, exceptions. |
| **Regularization** | An employee-raised, approver-confirmed correction to an attendance day (missed punch, wrong shift, WFH) producing a *new* corrective event. |
| **Timesheet** | A period-scoped collection of worked hours for **waged** staff, submitted → approved → fed to payroll as payable hours. |
| **Leave type** | A pre-built category (annual, sick, casual, etc.) with country-aware accrual, paid/unpaid, unit (day/half-day/hour, or **week** for NZ annual), rules. |
| **Accrual** | The scheduled granting of leave balance (monthly, anniversary, per-hour-worked, lump). |
| **LOP (Loss of Pay)** | Unpaid absence reducing payable days (IN salaried model). |
| **OWD (Otherwise Working Day)** | NZ test: would the employee normally have worked this day? Gates public-holiday pay, alternative days, and sick/bereavement entitlement on that day. |
| **OWP / AWE** | NZ **Ordinary Weekly Pay** / **Average Weekly Earnings** — annual-leave is paid at the **greater** of the two. |
| **RDP / ADP** | NZ **Relevant Daily Pay** / **Average Daily Pay** — for daily leaves (public holiday, sick, bereavement, family violence). |
| **Alternative day (lieu day)** | NZ: an extra whole paid day off earned for working *any part* of a public holiday that is an OWD. |

---

## 3. High-level data model (Prisma-style)

All models carry `id` (cuid), `businessId`, `createdAt`, `updatedAt`, and are soft-deleted via `deletedAt` where mutable. Money is `amountMinor Int` + `currency`. Times are stored UTC + the resolving `timezone` (tenant/location), because IN is a single zone (IST) but NZ has DST (NZST/NZDT) which materially affects shift boundaries and "which day a punch belongs to".

```prisma
// ---------- Work patterns & shifts ----------
model WorkPattern {
  id          String  @id @default(cuid())
  businessId  String
  name        String                  // "IN-Mon-Fri-9h", "NZ-Roster-Variable"
  country     String                  // "IN" | "NZ"
  cycleDays   Int      @default(7)    // supports n-week rotating patterns
  days        WorkPatternDay[]
  expectedWeeklyHours Decimal @db.Decimal(6,2)
  isDefault   Boolean  @default(false)
  @@index([businessId, country])
}
model WorkPatternDay {
  id            String @id @default(cuid())
  workPatternId String
  cycleIndex    Int                    // 0..(cycleDays-1)
  dayOfWeek     Int                    // 0=Sun..6=Sat  (reuses booking convention)
  isWorking     Boolean
  startTime     String?                // "HH:MM"
  endTime       String?
  breakMinutes  Int     @default(0)
  expectedMinutes Int                  // authoritative expected work for the day
  @@unique([workPatternId, cycleIndex, dayOfWeek])
}

model ShiftTemplate {
  id           String @id @default(cuid())
  businessId   String
  name         String
  startTime    String                  // "HH:MM"
  endTime      String                  // may cross midnight (endTime<startTime ⇒ +1 day)
  breaks       Json                    // [{start,end,paid}]
  graceInMin   Int    @default(10)     // late grace
  graceOutMin  Int    @default(10)
  isNight      Boolean @default(false)
  colorHint    String?                 // UI only (within 5-style theme)
  @@index([businessId])
}

model RosterShift {
  id           String @id @default(cuid())
  businessId   String
  employeeId   String
  date         DateTime @db.Date
  shiftTemplateId String?
  startAt      DateTime                // resolved UTC
  endAt        DateTime
  locationId   String?
  status       RosterShiftStatus       // DRAFT|PUBLISHED|SWAP_REQUESTED|CANCELLED
  publishedAt  DateTime?
  @@unique([businessId, employeeId, date, startAt])
  @@index([businessId, date])
}
enum RosterShiftStatus { DRAFT PUBLISHED SWAP_REQUESTED CANCELLED }

// ---------- Punches & attendance ----------
model ClockEvent {
  id           String @id @default(cuid())
  businessId   String
  employeeId   String
  kind         ClockKind              // IN|OUT|BREAK_START|BREAK_END
  occurredAt   DateTime               // device/server-reconciled UTC
  source       ClockSource            // WEB|MOBILE|KIOSK|BIOMETRIC|API|MANUAL
  lat          Decimal? @db.Decimal(9,6)
  lng          Decimal? @db.Decimal(9,6)
  accuracyM    Int?                   // GPS accuracy metres
  selfieKey    String?                // object-store key (region-pinned)
  selfieMatchScore Decimal? @db.Decimal(5,4) // 0..1 if face-match enabled
  biometricRef String?                // device/template reference, not raw vector
  ipAddress    String?
  deviceId     String?
  withinFence  Boolean?               // evaluated at capture
  fenceId      String?
  rawMeta      Json                   // device os, app version, mock-location flag
  supersededById String?              // regularization linkage (immutable)
  createdAt    DateTime @default(now())
  @@index([businessId, employeeId, occurredAt])
}
enum ClockKind { IN OUT BREAK_START BREAK_END }
enum ClockSource { WEB MOBILE KIOSK BIOMETRIC API MANUAL }

model AttendanceDay {
  id            String @id @default(cuid())
  businessId    String
  employeeId    String
  date          DateTime @db.Date
  timezone      String
  rosterShiftId String?
  firstInAt     DateTime?
  lastOutAt     DateTime?
  workedMinutes Int     @default(0)
  breakMinutes  Int     @default(0)
  expectedMinutes Int   @default(0)
  otMinutes     Int     @default(0)
  status        AttendanceStatus
  lateMinutes   Int     @default(0)
  earlyOutMinutes Int   @default(0)
  exceptions    Json                   // ["MISSING_OUT","OUTSIDE_FENCE","MOCK_LOCATION"]
  lopFraction   Decimal @db.Decimal(4,3) @default(0) // 0,0.5,1 → payroll feed
  isLocked      Boolean @default(false) // locked when period frozen for payroll
  @@unique([businessId, employeeId, date])
  @@index([businessId, date, status])
}
enum AttendanceStatus {
  PRESENT HALF_DAY ABSENT ON_LEAVE WEEKLY_OFF HOLIDAY
  WFH ON_DUTY HOLIDAY_WORKED PENDING_REGULARIZATION
}

model Regularization {
  id           String @id @default(cuid())
  businessId   String
  employeeId   String
  attendanceDayId String
  type         RegType                // MISSED_IN|MISSED_OUT|WRONG_SHIFT|WFH|ON_DUTY|FORGOT
  requestedInAt  DateTime?
  requestedOutAt DateTime?
  reason       String
  status       ApprovalStatus
  approverId   String?
  decidedAt    DateTime?
  decisionNote String?
  @@index([businessId, status])
}
enum RegType { MISSED_IN MISSED_OUT WRONG_SHIFT WFH ON_DUTY FORGOT }

// ---------- Geofencing ----------
model Geofence {
  id          String @id @default(cuid())
  businessId  String
  locationId  String?
  name        String
  mode        FenceMode               // GPS_RADIUS|IP_CIDR|GPS_AND_IP|GPS_OR_IP|NONE
  centerLat   Decimal? @db.Decimal(9,6)
  centerLng   Decimal? @db.Decimal(9,6)
  radiusM     Int?
  ipCidrs     String[]                // ["203.0.113.0/24"]
  enforcement FenceEnforcement        // BLOCK|WARN|FLAG_ONLY
  @@index([businessId])
}
enum FenceMode { GPS_RADIUS IP_CIDR GPS_AND_IP GPS_OR_IP NONE }
enum FenceEnforcement { BLOCK WARN FLAG_ONLY }

// ---------- Timesheets (waged) ----------
model Timesheet {
  id          String @id @default(cuid())
  businessId  String
  employeeId  String
  periodStart DateTime @db.Date
  periodEnd   DateTime @db.Date
  status      TimesheetStatus
  totalMinutes Int @default(0)
  otMinutes    Int @default(0)
  submittedAt DateTime?
  approverId  String?
  approvedAt  DateTime?
  @@unique([businessId, employeeId, periodStart, periodEnd])
}
enum TimesheetStatus { OPEN SUBMITTED APPROVED REJECTED LOCKED }
model TimesheetEntry {
  id          String @id @default(cuid())
  timesheetId String
  date        DateTime @db.Date
  projectCode String?
  costCenter  String?
  minutes     Int
  isOvertime  Boolean @default(false)
  note        String?
}
```

Leave models are in §4.3.

---

## 4. Leave Management

### 4.1 Pre-built leave types

Tenants enable/configure from this fixed catalogue (no custom-type builder; they may *rename for display* and *set numbers within statutory bounds*). The `unit` column is the load-bearing IN/NZ split.

#### India (IN)

| Code | Display default | Paid | Unit | Default accrual | Statutory anchor | Notes |
|---|---|---|---|---|---|---|
| `EL`/`PL` | Earned / Privileged Leave | Yes | day / half-day | ~1.25–1.75/mo (configurable, ≥ Factories/S&E Act floor) | Shops & Establishment Act (state) / Factories Act | Carry-forward + encashment apply |
| `CL` | Casual Leave | Yes | day / half-day | lump or monthly | State S&E Act | Usually no carry-forward |
| `SL` | Sick Leave | Yes | day / half-day | lump/monthly | State S&E Act / ESI for covered | May require medical cert > N days |
| `ML` | Maternity Leave | Yes | day | 26 weeks (lump entitlement) | Maternity Benefit Act 1961 (26 weeks, 2 children) | Statutory; not accrued |
| `PL_PAT` | Paternity Leave | Policy | day | lump | Employer policy (no central statute) | Configurable |
| `LWP`/`LOP` | Leave Without Pay | No | day / half-day | n/a | — | Feeds LOP to payroll |
| `COMP_OFF` | Compensatory Off | Yes | day | earned by holiday/weekly-off work | — | Expiry window configurable |
| `BL` | Bereavement | Policy | day | lump per event | Employer policy | |
| `MARRIAGE` | Marriage Leave | Policy | day | lump | Employer policy | |

> **Floor enforcement:** state Shops & Establishment Acts set minimum EL/SL/CL; the Super Admin rule table `leaveStatutoryFloorIN(state, effectiveDate)` provides the minimum the tenant cannot configure below. The new Labour Codes (live **21 Nov 2025**, central rules expected ~1 Apr 2026) also reduce the EL **carry-forward/encashment eligibility threshold** (annual leave eligibility after fewer working days — commonly cited as 180 days rather than 240); the engine reads the threshold from the rule table, not hard-code. ([India Labour Codes in force 21 Nov 2025 — BDO](https://www.bdo.in/en-gb/insights/alerts-updates/alert-implementation-of-labour-codes-key-provisions-notified-effective-21-november-2025), [Labour Codes FAQs 16.03.2026](https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf))

#### New Zealand (NZ) — Holidays Act 2003

| Code | Display | Paid | Unit | Entitlement | Statutory anchor | Pay basis |
|---|---|---|---|---|---|---|
| `ANNUAL` | Annual Holidays | Yes | **WEEKS** | **4 weeks** after each 12 months continuous employment | Holidays Act 2003 s.16 | **greater(OWP, AWE)** |
| `SICK` | Sick Leave | Yes | day | **10 days/yr** after 6 months; carries up to **20 days** cap | Holidays Act 2003 | **RDP or ADP** |
| `BEREAVE` | Bereavement | Yes | day | **3 days** per immediate-family bereavement; **1 day** other | Holidays Act 2003 | **RDP or ADP** |
| `FVL` | Family Violence Leave | Yes | day | **10 days/yr**, no carryover | Domestic Violence—Victims' Protection / Holidays Act | **RDP or ADP** |
| `PUBHOL` | Public Holiday (taken) | Yes | day | 12 national + regional anniversary | Holidays Act 2003 | **RDP or ADP**; +alternative day if worked on an OWD |
| `ALT` | Alternative (lieu) Day | Yes | day | earned by working a public holiday that is an OWD | Holidays Act 2003 | **RDP or ADP** |
| `UNPAID` | Leave Without Pay | No | day | — | — | affects continuity/accrual after 1 wk |
| `PARENTAL` | Parental Leave | Govt-paid | weeks | up to 26 wks (govt-funded) | Parental Leave and Employment Protection Act | payroll passive |

> **2026 status:** The **Holidays Act 2003 remains the governing framework throughout 2026.** The **Employment Leave Bill 2026** proposes a successor regime (sick leave accruing at **0.0385 hrs per standard hour** to a **160 hr cap**; new OWD test = worked/paid-leave ≥50% of same weekday over preceding **13 weeks**; alternative leave accruing **1 hr per hour worked on a public holiday**) but is **proposed to take effect ~2028**. We model it as a **future rule-table version** (effectiveDate-gated), not today's behaviour. ([Employment Leave Bill 2026 — Employment NZ](https://www.employment.govt.nz/news-and-updates/employment-leave-bill-2026), [DLA Piper — leaving the Holidays Act behind](https://www.dlapiper.com/en-us/insights/publications/2026/03/leaving-the-holidays-act-behind))

### 4.2 Accrual rules (engine)

Accrual is computed by the `accrual-worker` BullMQ job (reuses the scheduler pattern from `backend/src/core/lib/scheduler.js`). Each leave type carries an `AccrualPolicy`:

| Method | Applies to | Behaviour |
|---|---|---|
| `LUMP_ANNIVERSARY` | NZ `ANNUAL` (4 weeks granted on each completed 12-month anniversary) | On anniversary, grant 4 weeks; before anniversary, accrued-not-yet-entitled "pay-as-you-go on 8% gross" model for the *current* incomplete year (for FnF / casuals). |
| `MONTHLY` | IN `EL`/`SL`/`CL` | Grant `monthlyRate` on the accrual day (e.g. 1st), pro-rated for mid-month joiners by joining-date fraction. |
| `PER_HOUR_WORKED` | NZ Employment Leave Bill future sick model | accrue `0.0385 × workedHours` capped at 160h (effectiveDate-gated). |
| `LUMP_ON_ELIGIBILITY` | NZ `SICK` (10 days after 6 months), `FVL` (10 days after 6 months) | Grant lump once tenure crosses threshold; reset annually. |
| `EARNED_EVENT` | `COMP_OFF`, NZ `ALT` | Granted when the triggering work (holiday/weekly-off work) is approved. |

**Edge cases handled:** mid-period joiners (pro-rata first accrual), mid-period leavers (FnF clawback of over-granted leave — configurable allow/deny), unpaid-leave suppression of accrual (NZ: >1 week LWOP can shift the anniversary date — modeled via `continuityAdjustmentDays`), maternity/parental periods (accrual continues or pauses per policy), negative-balance allowance (a per-type `allowNegativeUpTo` cap).

### 4.3 Leave data model

```prisma
model LeaveType {
  id            String @id @default(cuid())
  businessId    String
  country       String                 // "IN" | "NZ"
  code          String                 // EL, SICK, ANNUAL...
  displayName   String
  paid          Boolean
  unit          LeaveUnit              // DAY | HALF_DAY | HOUR | WEEK
  payBasis      PayBasis?              // null(IN day) | OWP_OR_AWE | RDP_OR_ADP
  accrualPolicy Json                   // {method, rate, cap, eligibilityMonths}
  carryForward  Json                   // {enabled, maxCap, expiryMonths}
  encashable    Boolean @default(false)
  encashFormula Json?                  // {basis:"BASIC+DA", capDays}
  allowNegativeUpTo Decimal @db.Decimal(5,2) @default(0)
  requiresDocOverDays Int?             // medical cert threshold
  minNoticeDays Int @default(0)
  maxConsecutive Int?
  approvalChainId String?
  isActive      Boolean @default(true)
  @@unique([businessId, code])
}
enum LeaveUnit { DAY HALF_DAY HOUR WEEK }
enum PayBasis { OWP_OR_AWE RDP_OR_ADP }

model LeaveBalance {
  id          String @id @default(cuid())
  businessId  String
  employeeId  String
  leaveTypeId String
  asOf        DateTime @db.Date        // snapshot date (leave year basis)
  openingUnits Decimal @db.Decimal(7,3)
  accruedUnits Decimal @db.Decimal(7,3)
  usedUnits    Decimal @db.Decimal(7,3)
  encashedUnits Decimal @db.Decimal(7,3)
  carriedInUnits Decimal @db.Decimal(7,3)
  lapsedUnits  Decimal @db.Decimal(7,3)
  closingUnits Decimal @db.Decimal(7,3) // computed, persisted for audit
  unit         LeaveUnit
  @@unique([businessId, employeeId, leaveTypeId, asOf])
  @@index([businessId, employeeId])
}

model LeaveLedger {           // append-only — every balance change is an event
  id          String @id @default(cuid())
  businessId  String
  employeeId  String
  leaveTypeId String
  event       LeaveLedgerEvent  // ACCRUE|TAKE|CANCEL|ENCASH|CARRY_FWD|LAPSE|ADJUST|OPENING
  units       Decimal @db.Decimal(7,3)  // signed
  unit        LeaveUnit
  sourceId    String?           // LeaveRequest.id / accrual run id
  note        String?
  createdAt   DateTime @default(now())
  @@index([businessId, employeeId, leaveTypeId, createdAt])
}
enum LeaveLedgerEvent { OPENING ACCRUE TAKE CANCEL ENCASH CARRY_FWD LAPSE ADJUST }

model LeaveRequest {
  id          String @id @default(cuid())
  businessId  String
  employeeId  String
  leaveTypeId String
  unit        LeaveUnit
  startDate   DateTime @db.Date
  endDate     DateTime @db.Date
  // weeks unit ⇒ stored as date range + computed weeks; day unit ⇒ day list
  dayParts    Json                 // [{date, portion: 1|0.5, halfWhich:"AM"|"PM"}]
  weeksRequested Decimal? @db.Decimal(5,3) // NZ ANNUAL
  reason      String?
  attachmentKey String?            // medical cert
  status      ApprovalStatus       // §5 state machine
  currentStep Int @default(0)
  approverTrail Json               // [{step,approverId,decision,at,note}]
  payImpactPreview Json            // {payable, lop, payBasisResolved, amountMinor?}
  cancelRequestedAt DateTime?
  createdAt   DateTime @default(now())
  @@index([businessId, employeeId, status])
  @@index([businessId, startDate, endDate])
}
enum ApprovalStatus { DRAFT PENDING APPROVED REJECTED CANCELLED WITHDRAWN ESCALATED }

model HolidayCalendar {           // public holidays, per country/region, versioned by SuperAdmin
  id          String @id @default(cuid())
  country     String
  region      String?              // NZ anniversary regions; IN state festivals
  date        DateTime @db.Date
  name        String
  isOptional  Boolean @default(false) // IN restricted/optional holidays
  mandatory   Boolean @default(true)
  ruleVersion String                // pinned at pay-run time
  @@unique([country, region, date, name])
}
```

### 4.4 Carry-forward, encashment, lapse

- **Carry-forward:** on leave-year rollover (1 Apr both markets), the rollover job moves `min(closingUnits, maxCap)` into next year's `carriedInUnits` (`LeaveLedger: CARRY_FWD`), and lapses the excess (`LAPSE`). Expiry windows (e.g. carried EL must be used within N months) are tracked as dated tranches in the ledger.
- **Encashment:** only `encashable` types. Encashment amount = `units × dailyRate`, where `dailyRate` is derived per `encashFormula` (IN: typically `(BASIC+DA)/26`; NZ annual leave **cannot be cashed below 1 week/yr**, and only the portion above the entitled 4 weeks may be cashed up on request — gated by rule table). Produces a `LeaveLedger: ENCASH` event and an **earning component** handed to payroll (`04-payroll-engine-design.md` §6 arrears/adjustments).
- **NZ guardrail:** Holidays Act forbids cashing up the core 4-week entitlement; only up to **1 week per year** may be cashed up *on the employee's written request* and *if the agreement allows*. The engine blocks non-compliant encashment at validation time.

### 4.5 Approval workflows

`ApprovalChain` is a pre-built, configurable N-step chain (no visual builder; tenant picks steps from {Reporting Manager, Dept Head, HR, Custom Role}). Each step has `approverResolver` (manager-of, named-user, role), `slaHours`, `onTimeout` (escalate / auto-approve / hold), and `quorum` (any/all for parallel approvers).

```
DRAFT ──submit──▶ PENDING(step0)
PENDING ──approve(step k<last)──▶ PENDING(step k+1)
PENDING ──approve(last step)────▶ APPROVED ──▶ debit LeaveLedger(TAKE), mark AttendanceDay ON_LEAVE
PENDING ──reject──▶ REJECTED
PENDING ──sla timeout──▶ ESCALATED ──▶ (escalation approver) | auto-APPROVED if policy
APPROVED/PENDING ──employee withdraw (future-dated)──▶ WITHDRAWN/CANCELLED ──▶ credit LeaveLedger(CANCEL)
APPROVED (past/started) ──HR cancel──▶ requires reason + reverses pay impact in next run
```

Reuses Sitepresso's auto-approve toggle and notify pattern (`backend/src/booking/controllers/leave.controller.js`: `sendLeaveRequestAdminEmail`, `sendLeaveStatusStaffEmail`) and notification routing (`backend/src/core/lib/notifications/`).

### 4.6 Team calendar & balances UX

- **Team Calendar:** month/week/list views; filter by department/location; shows leaves (color by type within the 5-style theme), public holidays from `HolidayCalendar`, WFH, and *clash detection* (configurable max-% of team on leave per day → blocks/warns at request time).
- **Balance widget:** per type — opening, accrued, used, available, pending, encashable; "as-of" date picker; projected balance at a future date (accrual forecast). NZ annual shown in **weeks** with the equivalent days *for reference only* (never used for pay).

---

## 5. Approval state machine (shared)

`ApprovalStatus` (above) governs leave, regularization, timesheet, roster-swap, and comp-off requests with the same transitions and guards:

| From | Event | Guard | To | Side effects |
|---|---|---|---|---|
| DRAFT | submit | passes validation (§ per-flow) | PENDING | notify step-0 approver; SLA timer armed |
| PENDING | approve | actor == current approver; not period-locked | PENDING(next)/APPROVED | advance step / commit ledger |
| PENDING | reject | actor == current approver | REJECTED | notify requester; release any tentative hold |
| PENDING | escalate (SLA) | timer elapsed | ESCALATED | route to escalation approver; notify |
| PENDING/APPROVED | withdraw | actor == requester; start>now | WITHDRAWN | reverse tentative ledger |
| APPROVED | cancel | actor ∈ HR/approver; reason | CANCELLED | reversing ledger event + payroll arrears note |

**Invariant:** no state transition is allowed on a record whose pay period `isLocked` for payroll — those flow as *next-period adjustments* (§14.4), matching the engine's "inputs are snapshotted, never retro-altered" tenet (`04-payroll-engine-design.md` tenet 5).

---

## 6. NZ Holidays Act calculation engine (flagship)

This is the highest-value, hardest-to-get-right component. It is a **pure-compute package** `backend/src/hr/leave/holidays-act/` fed an immutable **earnings history snapshot** and a pinned **rule version**. Output is a fully-traced `LeavePayResult` (mirrors the payroll engine's `calc_explain`).

### 6.1 The four pay bases (exact definitions)

| Basis | When used | Definition (Holidays Act 2003) |
|---|---|---|
| **OWP — Ordinary Weekly Pay** | Annual holidays (component A of greater-of) | The amount the employee receives **for an ordinary working week** (regular wages + regular allowances + regular productivity/incentive + regular OT), excluding irregular/discretionary. If not determinable, use the **4-week formula**: `(gross over last 4 weeks − irregular payments) ÷ 4`. |
| **AWE — Average Weekly Earnings** | Annual holidays (component B of greater-of) | `gross earnings over the last 52 weeks ÷ 52`. **Annual leave pays the GREATER of OWP and AWE.** |
| **RDP — Relevant Daily Pay** | Public holiday worked/not-worked, sick, bereavement, FVL, alternative day | What the employee **would have earned had they worked that day** (incl. regular components, productivity/incentive, the right portion of OT *if they would have worked OT that day*). |
| **ADP — Average Daily Pay** | Fallback when RDP **cannot be determined** OR pay varies day-to-day | `gross earnings over last 52 weeks ÷ number of whole-or-part days worked (incl. paid leave) in that period`. |

([Holidays Act 2003 s.16 annual holidays](https://www.legislation.govt.nz/act/public/2003/0129/latest/DLM236874.html); [Employment NZ — RDP/ADP & sick/bereavement/FVL pay](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/leave-and-holiday-pay/pay-for-sick-bereavement-and-family-violence-leave); cross-checked against [Boundless — annual leave NZ 2026](https://boundlesshq.com/blog/annual-leave-new-zealand/))

### 6.2 "Gross earnings" composition (52-week window)

Included: all taxable wages/salary, OT, commission, regular incentives/productivity bonuses, most allowances, payment for annual/public/sick/bereavement leave already taken, cashed-up leave.
**Excluded:** discretionary (truly discretionary) payments, weekly ACC compensation, reimbursements (actual expenses), and employer KiwiSaver contributions.

```ts
interface EarningsSnapshot {
  employeeId: string;
  asOf: string;                 // calc date
  weeks52: WeekEarning[];       // [{weekStart, gross, ordinaryComponent, irregularComponent, daysPaid}]
  weeks4: WeekEarning[];        // last 4 for OWP fallback
  ordinaryWeekPay?: Money;      // if OWP directly determinable from agreement
  ruleVersionNZ: string;        // pinned
}
interface LeavePayResult {
  basisUsed: "OWP" | "AWE" | "RDP" | "ADP";
  amountMinor: bigint;
  currency: "NZD";
  trace: CalcNode[];            // greater-of comparison, inputs, exclusions applied
}
```

### 6.3 Otherwise Working Day (OWD) test

Gate for public-holiday pay, alternative days, and whether sick/bereavement is *payable* on that day. If the agreement specifies the days of work → use them. Else apply the practical test (work pattern over preceding weeks, rosters, mutual expectation). The **Employment Leave Bill 2026 future version** codifies "≥50% of the same weekday over preceding 13 weeks" — stored as an effectiveDate-gated rule, **not** today's default. Result is cached on `AttendanceDay.isOWD`.

### 6.4 Public-holiday logic (state table)

| Scenario | Worked? | OWD? | Pay | Alternative day |
|---|---|---|---|---|
| Public holiday, employee doesn't work | No | Yes | **RDP/ADP** for the day (paid) | No |
| Public holiday, employee doesn't work | No | No | Nil | No |
| Public holiday, employee works | Yes | Yes | **time-and-a-half** on the hours worked (RDP-based) | **+1 alternative day** |
| Public holiday, employee works | Yes | No | time-and-a-half on hours worked | No alternative day |
| Public holiday falls on weekend (Mondayisation) | — | — | apply Mondayisation rule per holiday (Waitangi/ANZAC/Christmas/NY set) | per OWD |

"Mondayisation" applies to a defined subset (e.g., Christmas Day, Boxing Day, New Year, Waitangi, ANZAC) — the `HolidayCalendar` rows carry `mondayisable` and the engine shifts observance.

### 6.5 Worked examples (must be reproducible)

- **Annual leave, salaried + commission:** OWP = base weekly salary $1,500; AWE = (52-wk gross incl. commission $98,000)/52 = $1,884.62 → **pay greater = $1,884.62/week**. Trace records both values and the greater-of selection.
- **Sick day, variable-hours casual:** RDP indeterminable (varies) → ADP = (52-wk gross $41,600)/(208 days paid) = **$200.00/day**.
- **Public holiday worked, OWD:** 8h × $30 × 1.5 = **$360** + **1 alternative day** credited (`LeaveLedger ALT +1`).

---

## 7. Shifts & Rosters

### 7.1 Shift templates & work patterns
Reuses the booking slot validator (`backend/src/booking/controllers/schedule.controller.js`: `{dayOfWeek,startTime,endTime,lunchStart,lunchEnd}`, `toMinutes`, overlap check) generalized to `ShiftTemplate.breaks[]` and cross-midnight handling (`endTime<startTime ⇒ next day`). Night shifts set `isNight` (drives NZ night allowance / IN OT-night rules where applicable).

### 7.2 Rostering
- Planner builds a **DRAFT** roster (drag shifts onto employee×date grid), validates: no overlapping shifts, respects max weekly hours (IN **48 h/week** cap, daily **8–9 h** + spread-over **≤12 h**; NZ rest-break/hours per agreement), min rest between shifts (configurable, default 11h), and roster-coverage minimums per location.
- **PUBLISH** notifies affected employees (notification routing). Published shifts feed expected-minutes into `AttendanceDay`.
- **Shift swap:** employee A requests swap → B accepts → manager approves (`RosterShiftStatus.SWAP_REQUESTED → PUBLISHED`), audited.
- **Open shifts / shift bidding:** unassigned shifts published to a pool; employees claim; planner confirms.

IN weekly-hours/OT thresholds (48 h/week; OT ≥ **2× normal wage**) and NZ hours are read from rule tables. ([Overtime under new Labour Codes — PocketHRMS](https://www.pockethrms.com/blog/overtime-rules-under-new-labour-codes-2025/), [KPMG — four Labour Codes implementation](https://kpmg.com/xx/en/our-insights/gms-flash-alert/flash-alert-2025-267.html))

---

## 8. Attendance & Time capture

> **Implementation status:** multi-mode capture (geo/IP/face policies, WARN/ENFORCE,
> review queue) shipped as Feature 2; device ingestion as Feature 28; **real face
> recognition (server-side ArcFace/ONNX), HR-approved face enrolment, polygon
> geofences (office or per-employee) and per-employee policy scope shipped as
> Feature 39 — see `docs/features/39-face-geo-attendance-controls.md`** (the
> as-built spec supersedes the sketches below where they differ).

### 8.1 Clock-in channels
| Channel | Proof captured | Typical use |
|---|---|---|
| **Web** (`app.hr.com` / ESS) | IP, optional WebRTC selfie, browser geoloc | Office desk staff |
| **Mobile** (PWA/native) | GPS+accuracy, selfie (liveness), device id, mock-location flag | Field/remote staff |
| **Kiosk** (shared tablet) | Kiosk device id, PIN/QR, selfie | Shop floor / site |
| **Biometric device** | template ref + device id via push/pull integration | Factories/offices with hardware |
| **API** | partner/HRIS punch import | Integrations |
| **Manual** (admin) | admin id + reason (audited) | Backfill/corrections |

### 8.2 GPS + selfie + liveness
On mobile clock-in: capture `lat/lng/accuracyM`, evaluate geofence (§9), capture selfie → optional **face-match** against enrolled photo (`selfieMatchScore`), detect **mock-location** (Android dev-options / GPS spoof) → flag exception `MOCK_LOCATION`. Selfie stored in region-pinned object store (key only in DB). Face vectors processed on-device or in-region; we persist a score + image key, not a re-usable biometric vector, per tenet 6.

### 8.3 Biometric hardware integration
Adapter pattern: `BiometricAdapter` per vendor family (ESSL/eSSL, ZKTeco, Suprema common in IN). Pull (poll device API) or push (device webhook → dedup ledger reusing Sitepresso's exactly-once webhook pattern, e.g. `RazorpayWebhookEvent` dedup-on-id in `backend/prisma/schema.prisma`). Maps device user-id → `employeeId`; raw template stays on device. Clock skew reconciled to server time with a tolerance window.

### 8.4 Punch → AttendanceDay derivation (algorithm)
1. Collect ordered `ClockEvent`s for `(employee, businessDate)` resolved in the location timezone (cross-midnight shift assigns punches to the shift's *business date*).
2. Pair IN/OUT, subtract unpaid breaks → `workedMinutes`.
3. Compare to `expectedMinutes` (roster or work pattern) with grace windows → `lateMinutes`, `earlyOutMinutes`.
4. Classify `status`: full present / `HALF_DAY` (worked < half-day threshold) / `ABSENT` (no punch on working day) / `WEEKLY_OFF` / `HOLIDAY` / `ON_LEAVE` (leave approved) / `WFH` / `HOLIDAY_WORKED`.
5. Compute `otMinutes` per OT policy (§10).
6. Raise `exceptions[]` (`MISSING_OUT`, `OUTSIDE_FENCE`, `LOW_FACE_MATCH`, `MOCK_LOCATION`, `OVER_MAX_HOURS`).
7. Derive `lopFraction` (0 / 0.5 / 1) for the payroll feed.

Derivation runs incrementally on each punch and is finalized by a nightly `attendance-finalize` job; both are idempotent.

---

## 9. Geo/IP fencing

`Geofence.mode` ∈ {GPS_RADIUS, IP_CIDR, GPS_AND_IP, GPS_OR_IP, NONE}; `enforcement` ∈ {BLOCK, WARN, FLAG_ONLY}. Evaluation at capture:
- **GPS_RADIUS:** haversine(center, punch) ≤ `radiusM` (with `accuracyM` tolerance buffer). If accuracy worse than threshold → treat as `WARN` (can't prove inside).
- **IP_CIDR:** client IP ∈ any `ipCidrs` (for office-WiFi enforcement).
- **BLOCK** rejects the punch (employee sees "you're outside an allowed location"); **WARN** allows but flags; **FLAG_ONLY** records `withinFence=false` for HR review without blocking. Per-location and per-employee overrides (field staff exempt from GPS fence).

---

## 10. Overtime rules & engine

OT policy is pre-built and configured (no formula builder). `OvertimePolicy { trigger, thresholds, multipliers, capPerDay, capPerWeek, requiresPreApproval, roundingMin }`.

| Trigger | IN (Labour Codes, 2025+) | NZ |
|---|---|---|
| Daily threshold | hours > **8–9/day** (per code/rules); spread-over **≤12 h/day** | per employment agreement (no statutory daily OT minimum) |
| Weekly threshold | hours > **48/week** | per agreement |
| Multiplier | **≥ 2× ordinary wage** (statutory minimum) | per agreement (commonly 1.5×); public-holiday work = **time-and-a-half** (statutory, §6.4) |
| Consent | OT must be **consent-based** | per agreement |

OT minutes from `AttendanceDay`/`Timesheet` → OT amount in payroll. The multiplier and thresholds are **rule-table values**, pinned per pay run. ([Overtime under Labour Codes — PocketHRMS](https://www.pockethrms.com/blog/overtime-rules-under-new-labour-codes-2025/)) Pre-approval gating: if `requiresPreApproval`, only **approved** OT (via an OT request flow sharing the §5 state machine) is paid; unapproved overage is recorded but not paid.

---

## 11. Timesheets (waged staff)

For waged/hourly/contract staff (and NZ variable-hours), pay is *built up* from worked hours, not docked from a salary.
- Weekly/fortnightly `Timesheet` auto-seeded from `AttendanceDay` (or manual entry where no clock device). Employee adds project/cost-center splits (`TimesheetEntry`).
- **Submit → approve** (manager) via §5 state machine; approver sees variance vs. roster.
- On **APPROVE**, `totalMinutes` + `otMinutes` flow to payroll as **payable hours** (build-up model). `LOCKED` when the pay period freezes.
- Validations: no entry on a future date beyond today; sum of daily minutes ≤ 24h; OT split must reconcile to the day's worked minutes; project codes must be active.

---

## 12. RBAC (additions)

Extends Sitepresso RBAC (`backend/src/core/lib/rbac.js`). New permissions: `time.roster.manage`, `time.attendance.view_team`, `time.regularize.approve`, `leave.approve`, `leave.config`, `timesheet.approve`, `attendance.manual_punch`, `time.config`. Roles: **TIME_MANAGER** (rosters, attendance, regularization), **LEAVE_APPROVER**, **ROSTER_PLANNER**, **PAYROLL_PREPARER** (read-only attendance/leave feed). Employees self-serve only their own records; managers scoped to their reportees/department/location.

---

## 13. API surface (selected)

All routes tenant-scoped via `requireBusiness` middleware; employee routes via ESS auth. JSON, idempotency-key on mutating clock/leave calls.

| Method & path | Purpose | Key validations |
|---|---|---|
| `POST /api/time/clock` | record punch `{kind,lat,lng,accuracyM,selfie,deviceId}` | geofence eval, dup-window (no double-IN < 60s), shift exists/open, mock-location flag |
| `GET /api/time/attendance?from&to&employeeId` | attendance days | scope check (self/team) |
| `POST /api/time/regularization` | raise correction | date within open period; reason required; max N/month |
| `PATCH /api/time/regularization/:id/decision` | approve/reject | actor is current approver; not locked |
| `GET /api/time/roster?from&to` | roster grid | planner/self scope |
| `POST /api/time/roster` / `POST /api/time/roster/publish` | draft/publish | overlap, max-hours, min-rest |
| `POST /api/time/roster/:id/swap` | request/accept swap | both employees eligible |
| `POST /api/timesheets/:id/submit` / `/approve` | timesheet lifecycle | sums reconcile; not future |
| `GET /api/leave/types` | enabled leave types + balances | — |
| `POST /api/leave/requests` | request leave | balance ≥ requested (or negative-cap), notice, max-consecutive, clash %, doc if required |
| `PATCH /api/leave/requests/:id/decision` | approve/reject/escalate | current approver; not locked |
| `POST /api/leave/requests/:id/cancel` | cancel/withdraw | timing rules; reverses ledger |
| `GET /api/leave/balance?employeeId&asOf` | balances incl. forecast | scope |
| `GET /api/leave/calendar?from&to&dept` | team calendar | scope |
| `POST /api/admin/leave/accrual/run` | trigger accrual (idempotent) | admin only |
| `GET /api/holidays?country&region&year` | public holiday calendar | reads `HolidayCalendar` |
| `POST /api/admin/geofence` | configure fence | valid CIDR/radius |
| `GET /api/time/payroll-feed?payGroupId&period` | **the §14 feed** | period not yet locked twice |

---

## 14. Attendance → Payroll feed (the contract)

This is the seam to `04-payroll-engine-design.md`. The engine **pulls a frozen snapshot**; it never queries live attendance.

### 14.1 `AttendancePayInput` (per employee per pay period)

```ts
interface AttendancePayInput {
  employeeId: string;
  payGroupId: string;
  periodStart: string; periodEnd: string;
  payableDays?: number;        // IN salaried: derived = calendarPayDays − lopDays
  lopDays: number;             // 0.5 increments
  lopReasonTrace: LopLine[];   // [{date, fraction, cause:"ABSENT"|"LWOP"|"LATE_DEDUCT"}]
  payableMinutes?: number;     // NZ/waged build-up model
  otLines: OtLine[];           // [{date, minutes, multiplier, ruleVersion}]
  leaveTaken: LeaveLine[];     // [{leaveTypeId, unit, qty, paid, payBasis, amountMinor?}]
  leaveEncashment: EncashLine[];
  altDaysEarned: number;       // NZ
  publicHolidayWorked: PHLine[];
  snapshotHash: string;        // content hash — engine keys idempotency on this
  ruleVersions: { attendance: string; holidaysActNZ?: string; otIN?: string };
}
```

### 14.2 LOP computation (IN salaried)
`lopDays = Σ AttendanceDay.lopFraction over period` for unpaid causes (`ABSENT` without leave, `LWOP`, partial late-deduction if policy enables). The engine converts LOP days → money using its configured **paid-days basis** (calendar-days vs fixed-26 vs actual-working-days) — that policy lives in payroll, *we only supply the day count and its trace*, keeping the boundary clean.

### 14.3 OT & holiday-worked feed
`otLines` carry minutes × multiplier (rule-pinned). `publicHolidayWorked` (NZ) carries the time-and-a-half hours and triggers `altDaysEarned`. Leave **paid via OWP/AWE/RDP/ADP** is computed *here* (§6) and passed as `amountMinor` so the payslip and our calc agree to the cent.

### 14.4 Freeze, lock & late corrections
On pay-run **freeze**, the feed endpoint marks `AttendanceDay.isLocked` and `Timesheet.status=LOCKED` for the period and returns the snapshot. Post-lock corrections (approved late regularizations, retro leave) **cannot** mutate the locked period; they emit **next-period adjustment lines** (arrears/clawback) consumed by the engine's off-cycle/arrears path (`04-payroll-engine-design.md` §6.4). This preserves the engine's determinism/idempotency guarantees.

### 14.5 Edge cases enumerated
Mid-period join/exit (pro-rata payable days); employee in two pay groups in one month (split feed); leave spanning month boundary (split across periods at the date boundary); negative LOP correction (over-deducted last month → credit arrears); public holiday during annual leave (NZ: the public holiday is **not** counted as annual leave and is paid separately — engine must split); sandwich-leave policy (IN: weekly-off between two leave days counted as leave — configurable, defaults OFF and **must be disclosed**); DST shift night (NZ Apr/Sep) altering worked minutes — resolved by storing UTC + timezone.

---

## 15. Mandatory registers & compliance outputs

- **IN:** Labour Codes mandate **digital wage & attendance registers** and digital payslips. We generate the attendance register (per state format from rule table) and overtime register as period outputs. ([Labour Codes — payroll teams must act, payroll.org](https://payroll.org/news-resources/news/news-detail/2025/12/17/india-s-new-labour-codes-are-in-force-payroll-teams-must-act))
- **NZ:** Holidays Act / Wages Protection require **accurate holiday & leave records** and time/wage records retained (6 years). Every leave payment carries its OWP/AWE/RDP/ADP trace for audit (§6). This is our provable-correctness moat.

---

## 16. Notifications (events)
Clock-in reminder (shift start, no punch), missed-OUT reminder, leave submitted/decided/escalated, low balance, accrual posted, roster published, shift-swap request/decision, regularization decided, timesheet due/overdue, period-lock imminent. Routed via `backend/src/core/lib/notifications/` (in-app + email + webhook), localized via `backend/src/i18n/translator.js`.

---

## 17. Validation rules (consolidated, non-exhaustive)
- No punch when no shift/work-pattern day and policy forbids (configurable).
- Double-IN within 60s rejected (debounce); IN without prior OUT auto-closes previous open punch with exception.
- Leave request: `balance − pending ≥ requested` unless `allowNegativeUpTo`; respect `minNoticeDays`, `maxConsecutive`, `requiresDocOverDays`; clash% guard; cannot overlap an existing approved leave; cannot request on locked period.
- NZ encashment blocked below statutory 4-week core; ≤1 week/yr cash-up only.
- Regularization limited to open (unlocked) periods and capped per month.
- Roster: no overlap, max weekly hours (IN 48), min rest (default 11h).

---

## 18. Open items requiring Founder/Legal sign-off
See StructuredOutput `openQuestions`.

---

*End of 08-modules-time.md.*

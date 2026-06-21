# 03 — Data Model (HR & Payroll)

> **Doc owner:** Senior Backend Architect
> **Status:** Production design — authoritative for `backend/src/hr` Prisma schema
> **Surfaces touched:** Tenant Admin (`app.hr.com`), Employee Self-Service (`tenant.com`), Super Admin (`admin.hr.com`)
> **Launch markets:** India (IN), New Zealand (NZ). Currencies INR, NZD. Tax year **Apr–Mar** in both.
> **Sibling docs:** `01-architecture.md` (services, deploy), `02-tenancy-rbac.md` (isolation, roles, impersonation), `04-payroll-engine.md` (calc graph, compliance rule tables), `05-compliance-IN.md`, `06-compliance-NZ.md`, `07-leave-attendance.md`, `08-ess-mobile.md`, `09-api-surface.md`, `10-superadmin-billing.md`.

---

## 0. Reading guide & reuse posture

This document is the **single source of truth for the persisted HR/payroll domain**. It defines every Prisma model, its enums, indexes, country-specific extension fields, the state machines that govern mutable rows, and the validation/uniqueness rules the service layer must enforce on top of the database constraints.

### 0.1 What we fork from Sitepresso (grounded, read-only)

The fork keeps the platform substrate and replaces the vertical. Concrete anchors verified in `/Users/kp/sitepresso`:

| Concern | Sitepresso anchor (real path) | How we reuse it for HRMS |
|---|---|---|
| Tenant root | `backend/prisma/schema.prisma` → `model Business` (line 108) | Becomes the **tenant** root. We graft HR relations onto it and add an `Entity` child for legal payroll entities. |
| Row-level isolation | `businessId String` + `business Business @relation(... onDelete: Cascade)` repeated **421×** across the schema; e.g. `BusinessPage` (line 432), `Product` (line 553) | **Every** HR table carries `businessId` with a cascade FK and a composite index leading with `businessId`. Same Prisma middleware injects the tenant filter (see `02-tenancy-rbac.md`). |
| Auth identity | `model User` (line 18): `email @unique`, `password`, `role Role`, `passwordChangedAt`, `emailVerified`, GDPR `pendingDeletionAt`/`anonymisedAt` | `User` stays the **login principal**. A new `Employee` row is the HR record; `Employee.userId?` links to `User` only when the person has portal access. Not every employee logs in. |
| Custom RBAC | `model BusinessRole` (line 3609): `permissions Json`, relational `EcomRolePermissionGrant`, `@@unique([businessId, name])` | Reused verbatim for HR roles (HR Admin, Payroll Manager, Approver, Employee). HR permission catalog replaces ecommerce grants. |
| Multi-location | `model BusinessLocation` (line 3636) | Generalized: a tenant has `Entity` (legal/tax) **and** `Location` (physical/work-site). Sitepresso conflated them; HR/payroll needs both because PT/ESI/PF registration is per legal entity while attendance is per work-site. |
| Money type | `Decimal @db.Decimal(...)` throughout — `amountUsd Decimal @db.Decimal(10,2)` (line 1832), `providerCostUsd Decimal @db.Decimal(10,6)` (line 2829), `multiplier Decimal @db.Decimal(5,4)` (line 2702) | We adopt **`Decimal` everywhere money appears**. No `Float` for money. Rates use `Decimal(9,6)`. See §1.3. |
| Audit | `model PricingAuditLog` (line 2780) + `enum AuditAction { CREATED UPDATED DELETED SYNCED }` (line 2795) | Pattern generalized into `AuditLog` (§19) with `before/after Json`, actor, IP, and impersonation context. |
| Billing/subscription | `model Subscription` (line 1500), `PricingTier` (line 2645), `TierFeature` (line 2757), webhook tables (lines 1622/1649/1671) | Untouched by this doc — owned by `10-superadmin-billing.md`. HR feature-gating reads `Business.featureFlags Json` (line 160) + `TierFeature`. |
| Currency convention | `country String // ISO-3166-1 alpha-2` (line 123), `currencyCode String // ISO 4217` (line 636), `timezone String // IANA` (line 124) | Same ISO conventions. `Entity.countryCode` drives which compliance module loads. |

> **Note on `Float`:** Sitepresso still has legacy `Float` money columns (`consultationFee Float?` on `User` line 59, `depositAmount Float?` line 3698). These are a known wart we **do not** carry into payroll. Every monetary or rate column in this doc is `Decimal`. A migration lint (CI grep for `Float` in `backend/src/hr` schema) blocks regressions.

### 0.2 What we delete (so the model stays clean)

Per the brief: website/page builder, verticals `apps/{web,shop,booking}` + `backend/src/{web,shop,booking}`, the 60+ profession themes, and domain/mailbox resale. Therefore the ecommerce/appointment/restaurant/law-firm models in `backend/prisma/schema.prisma` (Product, Cart, Order, Appointment, RestaurantReservation, Matter, etc.) are **dropped** from the HR fork's schema. The HR schema is a fresh `backend/src/hr/prisma/schema.prisma` that imports only the platform substrate models.

### 0.3 Surface ownership of writes

| Writer | Tables it owns (creates/mutates) |
|---|---|
| Super Admin | `ComplianceRuleSet`, `ComplianceRuleVersion`, plan/feature gating (external doc) |
| Tenant Admin (HR console) | `Entity`, `Location`, `Department`, `Designation`, `Grade`, `Employee`, `EmploymentRecord`, `SalaryStructure`, `CompensationRevision`, `LeavePolicy`, `ShiftPattern`, `PayRun` (create/lock/approve), policy config for expense/loan/asset/perf/recruitment/helpdesk |
| Employee (ESS) | `LeaveTransaction` (request), `AttendancePunch`, `Timesheet`, `ExpenseClaim`, `LoanApplication`, `DocumentRequest`, `HelpdeskTicket`, profile change requests (→ `ApprovalRequest`) |
| System (engine/cron) | `PayRunLine`, `Payslip`, `LeaveBalance` accrual, `LoanInstallment` schedule, `StatutoryRemittance`, `AuditLog`, `Notification` |

---

## 1. Global conventions (apply to every model)

### 1.1 Primary keys & identifiers

- **PK:** `id String @id @default(uuid())` (UUID v4) on every table — matches Sitepresso (`User.id` line 19, `Business.id` line 109).
- **Human code:** Mirroring Sitepresso's `Business.shortId` (line 116), every employee-facing row that humans quote (Employee, PayRun, ExpenseClaim, HelpdeskTicket, LoanApplication) carries a tenant-scoped, human-readable sequence: `code String` unique per `(businessId)` or per `(entityId)`. Generated by a Postgres advisory-lock sequence helper (`lib/sequence.ts`), never by `serial` (multi-tenant collision risk). Format examples: `EMP-000142`, `PR-2026-04-IN`, `EXP-000087`.
- **External keys:** statutory identifiers (PAN, UAN, IRD number) live on `StatutoryProfile`, never as the PK.

### 1.2 Tenant scoping (non-negotiable)

Every table below **except** the platform-owned `User`, `Business`, `ComplianceRuleSet`, `ComplianceRuleVersion` (which are cross-tenant by design) carries:

```prisma
businessId String
business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
```

and the **leading index** `@@index([businessId, ...])`. **The `business` relation is mandatory, not optional** — a bare `businessId String` column without the FK is a schema bug: it gives Prisma `validate` nothing to enforce and lets a child row's `businessId` drift from its parent's. This applies even to **child-of-child / line tables** (e.g. `PayRunLineComponent`, `LoanInstallment`, `ExpenseLine`, `TimesheetEntry`, `HelpdeskMessage`, `ApprovalAction`, `WorkflowStep`, `AccrualRule`, `EmployeeSkill`, `JobStage`, `Interview`, `Offer`, `StatutoryElectionHistory`): although the parent already cascades on delete, the line table **still declares the `business` relation** so (a) the FK guarantees `child.businessId == parent.businessId`, (b) the tenant-filter middleware can scope it directly without a join, and (c) the CI "no `businessId` without FK" lint passes. Code blocks elsewhere in this doc that show only `businessId String` on a line table are abbreviated; the `business Business @relation(...)` field is implied and **must** be emitted in the generated schema.

Two deliberate exceptions to the FK rule:
- **`AuditLog.businessId` is nullable** (`String?`, no FK relation) because platform-level/super-admin actions have no tenant. It is *not* cascade-deleted with the tenant — audit must survive tenant offboarding for legal defence (see §19.1). Filtered application-side.
- **`Notification` and `NumberSequence`** *do* carry the mandatory `business` relation (they are tenant-owned and may be cascade-purged with the tenant).

Tenant filter injection is enforced by Prisma middleware (reused pattern from `02-tenancy-rbac.md`); the DB FK + index is the defense-in-depth backstop. A query that forgets `businessId` is a Sev-1 bug; we add a CI rule that rejects any HR `findMany` without a `where.businessId` unless explicitly allow-listed (cross-tenant super-admin reads), **and a second lint that rejects any model with a `businessId` column but no `business` relation** (except the `AuditLog` allow-list entry).

Most HR rows are **also** scoped to an `Entity` (the legal payroll entity), because statutory registration, pay calendars, and compliance rules differ per entity. Where that is true the row carries both `businessId` and `entityId`, and the composite unique/index leads with `businessId` (cheap tenant cut) then `entityId`.

### 1.3 Money, rates, currency

| Use | Type | Rationale |
|---|---|---|
| Monetary amount | `Decimal @db.Decimal(15, 2)` | Up to ₹9,999,999,999,999.99 — covers org-level gross. Cents/paise precision. |
| Per-unit / micro amounts (FX, provider cost) | `Decimal @db.Decimal(18, 6)` | Matches Sitepresso `providerCostUsd Decimal(10,6)`. |
| Rate / percentage | `Decimal @db.Decimal(9, 6)` | e.g. `0.120000` for EPF 12%, `0.016700`→`0.017500` ACC. Stored as a fraction, not "12". |
| Hours | `Decimal @db.Decimal(8, 2)` | timesheet/attendance. |
| Days (leave) | `Decimal @db.Decimal(8, 4)` | half-days, hourly leave, NZ weeks-based accrual fractions. |
| Currency code | `String @db.Char(3)` ISO 4217 | `INR`, `NZD`. |
| Country code | `String @db.Char(2)` ISO 3166-1 alpha-2 | `IN`, `NZ`. |

**Currency rule:** Each `Entity` has exactly one `payCurrency`. We do **not** mix currencies within a payslip. Cross-entity reporting converts via a dated FX table (out of scope here; see `04-payroll-engine.md`). Every monetary column that could be ambiguous carries an adjacent `currencyCode` snapshot (same pattern as Sitepresso `ProductPrice.currencyCode` line 636), so historical payslips never re-interpret amounts if the entity currency ever changes.

### 1.4 Timestamps, soft-delete, optimistic locking

Every table:

```prisma
createdAt DateTime  @default(now())
updatedAt DateTime  @updatedAt
deletedAt DateTime?              // soft delete; NULL = live
version   Int       @default(0)  // optimistic concurrency (engine + ESS race control)
```

- **Soft delete** (`deletedAt`) for anything legally retained (Employee, Payslip, PayRun, statutory rows, documents). Hard delete only for transient drafts. Aligns with Sitepresso's GDPR soft-delete on `User` (`pendingDeletionAt`/`anonymisedAt`, lines 44–45).
- **Optimistic lock:** `version` is bumped on every update; the engine and ESS both pass the expected version, and a mismatch → `409 Conflict`. Critical for payslip locking and concurrent leave approvals.
- **Effective-dating:** HR is temporal. Anything that "changes over time and we must reconstruct the past" (compensation, employment status, statutory rate, designation) is modeled as **append-only revisions** with `effectiveFrom`/`effectiveTo` (`effectiveTo NULL` = current), never an in-place update. See §5 (compensation) and §17 (compliance versions).

### 1.5 Retention & PII tags

Each PII-bearing column is tagged in code comments with a retention class so the GDPR/DPDP purge cron (forked from Sitepresso's anonymise job) knows what to scrub:

- `@pii:identity` — name, DOB, PAN/IRD, bank.
- `@pii:contact` — email, phone, address.
- `@pii:sensitive` — health (sick-leave reason), disability, biometric attendance template.
- `@retain:statutory` — must survive employee deletion for the statutory retention window (IN: 8 yrs for wage registers under Code on Wages rules; NZ: **7 years** Holidays Act / IRD records). Anonymisation nulls `@pii` but keeps `@retain:statutory` aggregates and the immutable `AuditLog`.

### 1.6 Enum strategy

Domain-stable enums (status machines, types) are **Prisma `enum`s** (DB-enforced). Configurable, tenant-extensible vocabularies (leave type, expense category, salary component) are **rows** in catalog tables so a tenant can configure without a migration — but they pick *behavior* from a fixed enum (`ComponentKind`, `LeaveUnit`), preserving "configure, not build."

---

## 2. Entity-relationship overview

```
Business (tenant root, reused)
 ├─ Entity (legal payroll entity; 1..N)         ── countryCode drives compliance module
 │   ├─ Location (work-site; 1..N)              ── attendance, PT state, ACC site
 │   ├─ PayCalendar (1..N)                      ── monthly/fortnightly cycles
 │   ├─ StatutoryRegistration (PF/ESI/PT/IRD)   ── per-entity registration numbers
 │   └─ PayRun (N) ─ PayRunLine (N) ─ Payslip (1:1 line)
 ├─ Department (tree)   Designation   Grade   Band
 ├─ Employee (1..N)
 │   ├─ EmploymentRecord (history; append-only)
 │   ├─ StatutoryProfile (IN ext / NZ ext)
 │   ├─ CompensationRevision (append-only) ─ SalaryStructure ─ SalaryComponentLine
 │   ├─ BankAccount   EmergencyContact   Dependant
 │   ├─ LeaveBalance (per type/period) ─ LeaveTransaction
 │   ├─ AttendancePunch   ShiftAssignment   Timesheet ─ TimesheetEntry
 │   ├─ ExpenseClaim ─ ExpenseLine          Loan ─ LoanInstallment
 │   ├─ EmployeeDocument   AssetAssignment
 │   ├─ PerformanceReview   Goal             EmployeeSkill
 │   └─ Payslip (N, via PayRunLine)
 ├─ LeaveType ─ LeavePolicy ─ LeavePolicyAssignment ─ AccrualRule
 ├─ ShiftPattern   Holiday(public)   WeekOffPattern
 ├─ ExpenseCategory   ExpensePolicy
 ├─ LoanScheme
 ├─ Job (req) ─ JobStage ─ Candidate ─ Application ─ Interview ─ Offer
 ├─ HelpdeskCategory ─ HelpdeskTicket ─ HelpdeskMessage
 ├─ WorkflowDefinition ─ WorkflowStep ─ ApprovalRequest ─ ApprovalAction
 └─ AuditLog   Notification   NumberSequence

Super-admin owned (cross-tenant):
 ComplianceRuleSet ─ ComplianceRuleVersion (versioned IN/NZ rate tables)
```

---

## 3. Organization models

### 3.1 `Entity` — legal payroll entity

The unit of statutory registration and the pay-currency boundary. A tenant operating in both IN and NZ has ≥2 entities. This is the single most important new model: nearly everything statutory hangs off `entityId`.

```prisma
model Entity {
  id              String   @id @default(uuid())
  businessId      String
  business        Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code            String                       // human: "IN-HQ", "NZ-AKL"
  legalName       String                       // @pii:identity — registered legal name
  tradeName       String?
  countryCode     String   @db.Char(2)         // "IN" | "NZ" — selects compliance module
  payCurrency     String   @db.Char(3)         // "INR" | "NZD"
  timezone        String                       // IANA, e.g. "Asia/Kolkata", "Pacific/Auckland"
  taxYearStartMonth Int    @default(4)         // Apr in both markets
  // Registered address (statutory) — distinct from work-site Location
  addressLine1    String?
  addressLine2    String?
  city            String?
  stateCode       String?                      // IN state (drives PT slab) / NZ region
  postalCode      String?
  // IN extensions (NULL for NZ)
  pan             String?  @db.Char(10)        // entity PAN (employer) @pii:identity
  tan             String?  @db.Char(10)        // TDS deduction account no. (Form 24Q)
  gstin           String?  @db.VarChar(15)
  cin             String?                       // company identification no.
  // NZ extensions (NULL for IN)
  nzbn            String?                       // NZ Business Number
  irdEntityNumber String?  @db.VarChar(11)     // employer IRD number @pii:identity
  // Lifecycle
  status          EntityStatus @default(ACTIVE)
  activeFrom      DateTime
  activeTo        DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  deletedAt       DateTime?
  version         Int      @default(0)

  locations       Location[]
  registrations   StatutoryRegistration[]
  payCalendars    PayCalendar[]
  employments     EmploymentRecord[]
  payRuns         PayRun[]
  remittances     StatutoryRemittance[]

  @@unique([businessId, code])
  @@index([businessId, countryCode, status])
}

enum EntityStatus { ACTIVE SUSPENDED CLOSED }
```

**Validation:** if `countryCode='IN'` → `pan` required, `payCurrency='INR'`, `timezone` must be `Asia/Kolkata`. If `countryCode='NZ'` → `irdEntityNumber` required, `payCurrency='NZD'`. A tenant cannot create an entity for a country its plan doesn't license (feature flag check).

### 3.2 `Location` — physical work-site

Generalizes Sitepresso `BusinessLocation` (line 3636) but bound to an `Entity` and carrying the fields HR needs (PT state, ACC classification, geofence for punch-in).

```prisma
model Location {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId      String
  entity        Entity   @relation(fields: [entityId], references: [id], onDelete: Cascade)
  code          String
  name          String                        // "Bengaluru HQ", "Auckland Warehouse"
  addressLine1  String?
  city          String?
  stateCode     String?                       // IN: drives Professional Tax slab selection
  postalCode    String?
  countryCode   String   @db.Char(2)
  timezone      String                        // may differ from entity (e.g. multi-region NZ)
  // Attendance support
  geoLat        Decimal? @db.Decimal(9,6)
  geoLng        Decimal? @db.Decimal(9,6)
  geofenceM     Int?                          // allowed punch radius, metres
  // IN: PT registration is per state; this links the location to the right PT reg
  ptRegistrationId String?
  // NZ: ACC classification unit (CU) code for levy categorization
  accClassUnit  String?
  isPrimary     Boolean  @default(false)
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  version       Int      @default(0)

  employments   EmploymentRecord[]

  @@unique([businessId, entityId, code])
  @@index([businessId, entityId, isActive])
}
```

### 3.3 `Department`, `Designation`, `Grade`, `Band`

Org structuring. `Department` is a **tree** (self-referential) like Sitepresso's `ProductCategory` (line 722, `parentId` + depth cap).

```prisma
model Department {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code        String
  name        String
  parentId    String?
  parent      Department?  @relation("DeptTree", fields: [parentId], references: [id], onDelete: SetNull)
  children    Department[] @relation("DeptTree")
  headEmployeeId String?                       // department head (manager-of-record fallback)
  costCenter  String?
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)

  employments EmploymentRecord[]

  @@unique([businessId, code])
  @@index([businessId, parentId])
}

model Designation {                            // job title
  id         String   @id @default(uuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code       String
  title      String                            // "Senior Engineer"
  gradeId    String?
  grade      Grade?   @relation(fields: [gradeId], references: [id], onDelete: SetNull)
  isActive   Boolean  @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  deletedAt  DateTime?
  version    Int      @default(0)
  employments EmploymentRecord[]
  @@unique([businessId, code])
  @@index([businessId, gradeId])
}

model Grade {                                  // seniority grade (L1..L8) — pay band anchor
  id         String   @id @default(uuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code       String
  name       String
  rank       Int                               // ordering for comparisons / approvals
  bandId     String?
  band       Band?    @relation(fields: [bandId], references: [id], onDelete: SetNull)
  minSalary  Decimal? @db.Decimal(15,2)
  maxSalary  Decimal? @db.Decimal(15,2)
  currencyCode String? @db.Char(3)
  designations Designation[]
  isActive   Boolean  @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  deletedAt  DateTime?
  version    Int      @default(0)
  @@unique([businessId, code])
  @@index([businessId, rank])
}

model Band {                                   // broad compensation band grouping grades
  id         String   @id @default(uuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code       String
  name       String
  grades     Grade[]
  isActive   Boolean  @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  deletedAt  DateTime?
  version    Int      @default(0)
  @@unique([businessId, code])
}
```

---

## 4. Employee & employment

### 4.1 `Employee` — the HR master record (≠ login)

`Employee` holds person + HR-relationship data. Portal login is **optional** and lives on `User` (reused). A factory worker who never logs in still has a full `Employee` row and gets payslips.

```prisma
model Employee {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code          String                          // human EMP-000142, tenant-unique
  // Optional portal identity (reused User model)
  userId        String?  @unique
  user          User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  // Person — @pii:identity
  firstName     String
  middleName    String?
  lastName      String
  preferredName String?
  dateOfBirth   DateTime?  @db.Date
  gender        Gender?
  maritalStatus MaritalStatus?
  nationality   String?
  // Contact — @pii:contact
  personalEmail String?
  workEmail     String?
  phone         String?
  addressLine1  String?
  addressLine2  String?
  city          String?
  stateCode     String?
  postalCode    String?
  countryCode   String?  @db.Char(2)
  photoUrl      String?  @db.Text
  // Sensitive — @pii:sensitive (consent-gated, optional, country-config driven)
  disabilityStatus String?
  bloodGroup    String?
  // Lifecycle (denormalized current values; authoritative history in EmploymentRecord)
  status        EmployeeStatus @default(PRE_HIRE)
  hireDate      DateTime? @db.Date             // first joining date (tenure anchor)
  probationEndDate DateTime? @db.Date
  terminationDate  DateTime? @db.Date
  // Pointers to current records (maintained by service layer on each revision)
  currentEmploymentRecordId String? @unique
  currentCompensationId     String? @unique
  managerEmployeeId String?                     // dotted-line resolved via EmploymentRecord
  manager       Employee?  @relation("EmpManager", fields: [managerEmployeeId], references: [id], onDelete: SetNull)
  reports       Employee[] @relation("EmpManager")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?                        // soft; anonymise PII but keep statutory
  anonymisedAt  DateTime?                        // mirrors User.anonymisedAt pattern
  version       Int      @default(0)

  employmentRecords EmploymentRecord[]
  statutoryProfile  StatutoryProfile?
  compensations     CompensationRevision[]
  bankAccounts      BankAccount[]
  emergencyContacts EmergencyContact[]
  dependants        Dependant[]
  leaveBalances     LeaveBalance[]
  leaveTxns         LeaveTransaction[]
  punches           AttendancePunch[]
  shiftAssignments  ShiftAssignment[]
  timesheets        Timesheet[]
  expenseClaims     ExpenseClaim[]
  loans             Loan[]
  documents         EmployeeDocument[]
  assets            AssetAssignment[]
  reviews           PerformanceReview[]   @relation("RevieweeReviews")
  reviewsGiven      PerformanceReview[]   @relation("ReviewerReviews")
  goals             Goal[]
  skills            EmployeeSkill[]
  payslips          Payslip[]
  helpdeskTickets   HelpdeskTicket[]
  approvalRequests  ApprovalRequest[]     @relation("RequesterApprovals")

  @@unique([businessId, code])
  @@index([businessId, status])
  @@index([businessId, managerEmployeeId])
  @@index([businessId, workEmail])
}

enum Gender        { MALE FEMALE NON_BINARY UNDISCLOSED OTHER }
enum MaritalStatus { SINGLE MARRIED DIVORCED WIDOWED SEPARATED CIVIL_UNION UNDISCLOSED }
enum EmployeeStatus {
  PRE_HIRE      // offer accepted, not joined (onboarding tasks open)
  PROBATION
  ACTIVE
  ON_LEAVE      // long leave (maternity, sabbatical) — still employed
  NOTICE_PERIOD // resigned/terminated, serving notice
  SUSPENDED     // disciplinary; payroll may be held
  TERMINATED    // separated; FNF pending or done
  RETIRED
}
```

#### Employee status state machine

```
PRE_HIRE ─join──────────────► PROBATION ─confirm──► ACTIVE
PRE_HIRE ─rescind──► TERMINATED
PROBATION ─extend──► PROBATION
PROBATION ─fail────► NOTICE_PERIOD / TERMINATED
ACTIVE ◄──return─── ON_LEAVE ◄─longLeave── ACTIVE
ACTIVE ─resign/terminate──► NOTICE_PERIOD ─lastWorkingDay──► TERMINATED
ACTIVE ─suspend──► SUSPENDED ─reinstate──► ACTIVE
SUSPENDED ─dismiss──► NOTICE_PERIOD / TERMINATED
ACTIVE/NOTICE_PERIOD ─retire──► RETIRED
TERMINATED ─rehire──► PRE_HIRE (new EmploymentRecord; same Employee, new tenure segment)
```

**Guards:** cannot move to `TERMINATED` while an open, locked PayRun references the employee without an FNF settlement (`Loan` outstanding, leave encashment, gratuity) being resolved or explicitly waived. Cannot delete an Employee with any `Payslip` (statutory retention) — only soft-delete + anonymise.

### 4.2 `EmploymentRecord` — append-only employment history

The authoritative temporal record. A rehire or an internal transfer creates a **new** record; we never lose history. `Employee` keeps a denormalized pointer for fast reads.

```prisma
model EmploymentRecord {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  entityId      String                          // which legal entity employs them now
  entity        Entity   @relation(fields: [entityId], references: [id], onDelete: Restrict)
  locationId    String?
  location      Location? @relation(fields: [locationId], references: [id], onDelete: SetNull)
  departmentId  String?
  department    Department? @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  designationId String?
  designation   Designation? @relation(fields: [designationId], references: [id], onDelete: SetNull)
  gradeId       String?
  managerEmployeeId String?
  // Employment terms
  employmentType EmploymentType
  workerCategory WorkerCategory                  // staff/worker — affects IN code applicability
  payCalendarId String?                          // monthly vs fortnightly
  noticeDays    Int?
  fteRatio      Decimal  @db.Decimal(5,4) @default(1.0000) // part-time proration
  // Temporal validity (effective-dated, append-only)
  effectiveFrom DateTime @db.Date
  effectiveTo   DateTime? @db.Date              // NULL = current segment
  changeReason  EmploymentChangeReason
  isCurrent     Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)

  @@unique([employeeId, effectiveFrom])
  @@index([businessId, entityId, isCurrent])
  @@index([businessId, employeeId, effectiveFrom])
  @@index([businessId, departmentId])
}

enum EmploymentType { FULL_TIME PART_TIME FIXED_TERM CONTRACT INTERN APPRENTICE CASUAL CONSULTANT }
enum WorkerCategory { STAFF WORKER }            // IN Industrial Relations Code distinction
enum EmploymentChangeReason {
  HIRE PROMOTION TRANSFER_LOCATION TRANSFER_DEPARTMENT
  REORG MANAGER_CHANGE TYPE_CHANGE FTE_CHANGE PROBATION_CONFIRM REHIRE
}
```

> **Why `WorkerCategory`:** under the IN Industrial Relations Code (live 21 Nov 2025), "worker" vs "staff" governs notice/retrenchment, standing orders, and some leave entitlements. NZ ignores it. Carrying the flag at the employment level lets the compliance module branch without polluting the engine.

### 4.3 Supporting person records

```prisma
model BankAccount {                              // @pii:identity — salary disbursement
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  accountName String
  accountNumber String
  // IN
  ifsc        String?  @db.Char(11)
  // NZ — 16-digit BB-bbbb-AAAAAAA-SS format
  nzBankAccount String?
  bankName    String?
  currencyCode String  @db.Char(3)
  isPrimary   Boolean  @default(true)            // primary = salary credit target
  splitPercent Decimal? @db.Decimal(5,2)         // optional multi-account split
  verifiedAt  DateTime?
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  @@index([businessId, employeeId, isPrimary])
}

model EmergencyContact {
  id         String   @id @default(uuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId String
  employee   Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  name       String
  relationship String
  phone      String
  email      String?
  isPrimary  Boolean  @default(false)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@index([businessId, employeeId])
}

model Dependant {                                // @pii:identity — ESI/insurance/nominee
  id         String   @id @default(uuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId String
  employee   Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  name       String
  relationship DependantRelation
  dateOfBirth DateTime? @db.Date
  isNominee  Boolean  @default(false)            // PF/gratuity nominee
  nomineePercent Decimal? @db.Decimal(5,2)
  isInsured  Boolean  @default(false)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@index([businessId, employeeId])
}

enum DependantRelation { SPOUSE CHILD PARENT SIBLING OTHER }
```

---

## 5. Compensation & salary structures

This is where IN's Code-on-Wages 50% rule and NZ's gross-pay model both land. The design separates the **template** (`SalaryStructure` + `SalaryComponent`) from the **assignment** (`CompensationRevision` + `SalaryComponentLine`), and makes assignment **append-only effective-dated** so payroll can be re-run for any past period with the rates that applied then.

### 5.1 `SalaryComponent` — the configurable building block

Tenants *configure* components from a fixed set of **kinds** (behavior is code, not tenant-designed). This honors "configure, not build": a tenant can create a "Travel Allowance" component but it must be one of the fixed `ComponentKind` behaviors.

```prisma
model SalaryComponent {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?                            // NULL = available to all entities
  code        String                             // "BASIC","HRA","DA","SPECIAL","PF_EE"...
  name        String
  kind        ComponentKind                      // FIXED behavior selector
  category    ComponentCategory                  // EARNING | DEDUCTION | EMPLOYER_COST | REIMBURSEMENT
  // Calculation
  calcMethod  ComponentCalcMethod
  calcValue   Decimal? @db.Decimal(15,4)         // flat amount OR percentage OR factor
  calcBaseCode String?                           // for PERCENT_OF: which component(s)
  calcBaseScope ComponentBaseScope @default(SINGLE)
  // Statutory flags — drive the compliance engine
  isWageForPF   Boolean @default(false)          // counts toward EPF "wages"
  isWageForESI  Boolean @default(false)
  isWageForPT   Boolean @default(false)
  isWageForGratuity Boolean @default(false)
  isTaxable     Boolean @default(true)
  taxSection    String?                          // IN exemption section e.g. "10(13A)" HRA
  isKiwiSaverable Boolean @default(false)        // NZ: part of gross for KS calc
  isPayeable    Boolean @default(true)           // NZ: subject to PAYE
  // Behavior
  isRecurring   Boolean @default(true)
  prorationMethod ProrationMethod @default(CALENDAR_DAYS)
  glCode        String?
  sortOrder     Int     @default(0)
  isActive      Boolean @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  version       Int     @default(0)

  structureLines SalaryComponentLine[]

  @@unique([businessId, code])
  @@index([businessId, entityId, category])
}

enum ComponentKind {
  BASIC DEARNESS_ALLOWANCE HRA SPECIAL_ALLOWANCE CONVEYANCE
  MEDICAL LTA BONUS COMMISSION OVERTIME_PAY ARREAR
  // statutory deductions
  PF_EMPLOYEE ESI_EMPLOYEE PT TDS KIWISAVER_EMPLOYEE PAYE STUDENT_LOAN
  // employer cost (not deducted from employee, shown on cost-to-company)
  PF_EMPLOYER ESI_EMPLOYER EPS EDLI PF_ADMIN GRATUITY_PROVISION
  KIWISAVER_EMPLOYER ESCT ACC_EMPLOYER
  // recoveries / others
  LOAN_REPAYMENT ADVANCE_RECOVERY LEAVE_ENCASHMENT NOTICE_RECOVERY
  REIMBURSEMENT_FUEL REIMBURSEMENT_PHONE CUSTOM
}
enum ComponentCategory   { EARNING DEDUCTION EMPLOYER_COST REIMBURSEMENT }
enum ComponentCalcMethod { FLAT PERCENT_OF FORMULA SLAB STATUTORY BALANCING }
enum ComponentBaseScope  { SINGLE MULTIPLE GROSS CTC }
enum ProrationMethod     { CALENDAR_DAYS WORKING_DAYS THIRTY_DAY_STANDARD NONE }
```

- `STATUTORY` calc → the value is computed by the country compliance module (EPF, ESI, PAYE, KiwiSaver, ESCT, ACC), not by `calcValue`. The row exists so it appears on the payslip and in GL.
- `BALANCING` calc → "Special Allowance" pattern: fills the gap so the sum equals target CTC/gross. Critical for the IN 50% rule (see §5.4).

### 5.2 `SalaryStructure` — reusable template (per grade/entity)

```prisma
model SalaryStructure {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String
  code        String
  name        String                             // "IN Staff CTC 2026", "NZ Salaried"
  countryCode String   @db.Char(2)
  currencyCode String  @db.Char(3)
  basis       StructureBasis                     // CTC (IN) | GROSS (NZ) | NET
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  lines       SalaryComponentLine[]
  @@unique([businessId, entityId, code])
  @@index([businessId, entityId, isActive])
}

enum StructureBasis { CTC GROSS NET }

model SalaryComponentLine {                       // a component within a structure
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  structureId  String?
  structure    SalaryStructure? @relation(fields: [structureId], references: [id], onDelete: Cascade)
  compensationId String?                          // when attached to an assigned revision
  compensation CompensationRevision? @relation(fields: [compensationId], references: [id], onDelete: Cascade)
  componentId  String
  component    SalaryComponent @relation(fields: [componentId], references: [id], onDelete: Restrict)
  calcMethod   ComponentCalcMethod                // can override component default
  calcValue    Decimal? @db.Decimal(15,4)
  amountMonthly Decimal? @db.Decimal(15,2)        // resolved monthly amount (snapshot)
  amountAnnual  Decimal? @db.Decimal(15,2)
  sortOrder    Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  version      Int      @default(0)
  @@index([businessId, structureId])
  @@index([businessId, compensationId])
}
```

### 5.3 `CompensationRevision` — append-only assigned pay

Each pay change (hike, restructure, promotion) creates a new revision with `effectiveFrom`. Payroll for a period reads the revision whose `[effectiveFrom, effectiveTo]` covers the period. **Never edited in place.**

```prisma
model CompensationRevision {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  entityId      String
  structureId   String?                           // structure this was derived from
  currencyCode  String   @db.Char(3)
  basis         StructureBasis
  ctcAnnual     Decimal? @db.Decimal(15,2)
  grossMonthly  Decimal? @db.Decimal(15,2)
  // Effective dating
  effectiveFrom DateTime @db.Date
  effectiveTo   DateTime? @db.Date                // NULL = current
  isCurrent     Boolean  @default(true)
  revisionReason CompRevisionReason
  approvalRequestId String?                        // links to workflow approval
  notes         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)

  lines         SalaryComponentLine[]

  @@unique([employeeId, effectiveFrom])
  @@index([businessId, employeeId, isCurrent])
  @@index([businessId, entityId, effectiveFrom])
}

enum CompRevisionReason { HIRE ANNUAL_REVISION PROMOTION CORRECTION RESTRUCTURE STATUTORY_ADJUSTMENT }
```

### 5.4 Validation rules baked into compensation (with exact 2026 figures)

These run in the service layer at assignment time **and** are re-asserted by the payroll engine:

**IN — Code on Wages 50% rule (effective 21 Nov 2025).** The uniform "wages" definition requires that *excluded* allowances not exceed 50% of total remuneration; equivalently **Basic + DA must be ≥ 50% of total wages**. On structure save for an IN entity:
- Compute `wages = Σ(components where kind ∈ {BASIC, DEARNESS_ALLOWANCE})`.
- Compute `excluded = Σ(allowances excludable under the Code)`.
- If `excluded > 0.5 × totalRemuneration`, the excess is **deemed wages**: the engine re-attributes it into the PF/gratuity wage base and the validation surfaces a warning. Hard-block on structure activation if Basic+DA < 50% unless HR explicitly accepts the auto-reattribution. Cascades into EPF and gratuity bases.

**IN — EPF (mandatory at 20+ employees in the entity).** Employee 12% + employer 12% of PF wages. Employer 12% splits: **EPS 8.33% capped at ₹15,000 wage (≤ ₹1,250/mo)**, **EPF 3.67%**, plus **EDLI 0.50%** and **PF admin 0.50%** (employer). Statutory wage ceiling ₹15,000/mo unless employee opts for contribution on actual.

**IN — ESI (mandatory at 10 employees).** Employee **0.75%** + employer **3.25%** of gross, only while **gross ≤ ₹21,000/mo**. Contribution-period stickiness: if an employee crosses ₹21,000 mid-period, ESI continues to the end of the contribution period (Apr–Sep / Oct–Mar).

**IN — Professional Tax.** State-specific slabs, statutory annual cap **₹2,500/yr**. Selected by `Location.stateCode`. Stored as slab rows in the compliance rule set (§17).

**IN — Gratuity.** Provision = **15/26 × last-drawn wages × completed years** (≥5 yrs; pro-rata for fixed-term/deceased under Social Security Code). `GRATUITY_PROVISION` is an `EMPLOYER_COST` component accrued monthly.

**IN — TDS (income tax).** New regime is **default** (old regime opt-in stored on `StatutoryProfile.taxRegime`). FY 2025-26 new-regime slabs: 0–4L nil, 4–8L 5%, 8–12L 10%, 12–16L 15%, 16–20L 20%, 20–24L 25%, >24L 30%; **§87A rebate makes tax nil up to ₹12L taxable**; **standard deduction ₹75,000** (salaried) → effectively nil tax up to ₹12.75L gross.

**NZ — KiwiSaver (from 1 Apr 2026).** Default minimum **3.5%** employee + **3.5%** employer (was 3%; rises to 4% in 2028). **16–17-year-olds become eligible for employer contributions** from 1 Apr 2026 — the engine must check `dateOfBirth`. Employer KiwiSaver is taxed via **ESCT** (brackets below).

**NZ — ESCT brackets (2026/27, unchanged from 1 Apr 2025).** On prior-year (salary + employer cash contributions): ≤ $16,800 → 10.5%; $16,801–57,600 → 17.5%; $57,601–84,000 → 30%; $84,001–216,000 → 33%; ≥ $216,001 → 39%.

**NZ — ACC earners' levy (from 1 Apr 2026).** **1.75%** (up from 1.67%) on earnings up to **$156,641**; max levy **$2,741.22**. Deducted via PAYE.

**NZ — minimum wage (from 1 Apr 2026).** Adult **$23.95/hr**; starting-out & training **$19.16/hr** (80%). Structure save warns if implied hourly < applicable minimum.

**NZ — student loan.** 12% of earnings above the pay-period repayment threshold (annual $24,128 for 2026/27) when tax code ends in `SL`.

---

## 6. Statutory profiles

`StatutoryProfile` is 1:1 with `Employee` and holds the per-person statutory identity and elections. Country-specific fields are nullable extensions on the same row (sparse but simple; avoids a join on the hot payroll path). Where a field is an *election that changes over time* (e.g. tax regime, KiwiSaver rate) we keep the current value here and the history in `StatutoryElectionHistory`.

```prisma
model StatutoryProfile {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId    String   @unique
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  countryCode   String   @db.Char(2)

  // ── INDIA (@pii:identity, @retain:statutory) ──
  pan           String?  @db.Char(10)            // income tax PAN
  uan           String?  @db.VarChar(12)         // Universal Account Number (EPFO)
  pfMemberId    String?                          // member ID at current establishment
  pfOptIn       Boolean? // for >₹15k wage: contribute on actual vs ceiling
  pfJoinDate    DateTime? @db.Date
  esicIp        String?                          // ESI Insurance Person number
  esiApplicable Boolean? @default(false)
  ptStateCode   String?                          // overrides location if employee works remote
  aadhaarVerified Boolean? @default(false)       // store verification flag, NOT the number
  taxRegime     INTaxRegime? @default(NEW)       // NEW is statutory default
  section80CDeclared Decimal? @db.Decimal(15,2)  // old-regime declarations
  hraExemptionClaimed Boolean? @default(false)
  abryEligible  Boolean? @default(false)
  // ── NEW ZEALAND (@pii:identity, @retain:statutory) ──
  irdNumber     String?  @db.VarChar(11)         // employee IRD number
  taxCode       String?  @db.VarChar(8)          // "M","ME","M SL","S","SH","ST","SA","WT","ND"...
  kiwiSaverStatus KiwiSaverStatus? @default(NOT_ENROLLED)
  kiwiSaverEmployeeRate Decimal? @db.Decimal(5,4) // 0.035 default from 1 Apr 2026; 3/4/6/8/10%
  kiwiSaverOptOutDate DateTime? @db.Date
  kiwiSaverSavingsSuspension Boolean? @default(false) // formerly "contributions holiday"
  esctRate      Decimal? @db.Decimal(5,4)        // resolved annually from prior-year earnings
  studentLoan   Boolean? @default(false)         // tax code ends in SL
  studentLoanExtraDeduction Decimal? @db.Decimal(5,2)
  hasSpecialTaxCode Boolean? @default(false)     // IRD-issued tailored tax rate
  specialTaxRate Decimal? @db.Decimal(5,4)
  accExempt     Boolean? @default(false)         // rare; e.g. some shareholder-employees

  electionHistory StatutoryElectionHistory[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)

  @@index([businessId, countryCode])
  @@index([businessId, uan])
  @@index([businessId, irdNumber])
}

enum INTaxRegime    { NEW OLD }
enum KiwiSaverStatus { NOT_ENROLLED ACTIVE OPTED_OUT SAVINGS_SUSPENSION CASUAL_AGRICULTURAL }

model StatutoryElectionHistory {                 // audit of regime/rate elections
  id            String   @id @default(uuid())
  businessId    String
  statutoryProfileId String
  statutoryProfile StatutoryProfile @relation(fields: [statutoryProfileId], references: [id], onDelete: Cascade)
  field         String                            // "taxRegime","kiwiSaverEmployeeRate","taxCode"
  oldValue      String?
  newValue      String
  effectiveFrom DateTime @db.Date
  changedBy     String
  createdAt     DateTime @default(now())
  @@index([businessId, statutoryProfileId, field])
}
```

`StatutoryRegistration` (per-entity employer registrations) is distinct from the per-employee profile:

```prisma
model StatutoryRegistration {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String
  entity      Entity   @relation(fields: [entityId], references: [id], onDelete: Cascade)
  kind        RegistrationKind
  number      String                              // EPFO estab code, ESIC code, PT reg, TAN…
  stateCode   String?                             // for PT (per state)
  effectiveFrom DateTime @db.Date
  effectiveTo DateTime? @db.Date
  isActive    Boolean  @default(true)
  meta        Json?                                // scheme-specific (e.g. PT periodicity)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  @@unique([businessId, entityId, kind, stateCode])
  @@index([businessId, entityId, kind])
}

enum RegistrationKind { EPF ESI PT_STATE TAN LWF SHOPS_ESTABLISHMENT IRD_PAYE ACC }
```

---

## 7. Pay calendar, pay run, pay run line, payslip

The payroll execution core. `PayRun` is the period batch (per entity, per cycle); `PayRunLine` is one employee's computation; `Payslip` is the immutable employee-facing artifact. The **computation graph** lives in `04-payroll-engine.md`; here we model persistence and the locking state machine.

### 7.1 `PayCalendar`

```prisma
model PayCalendar {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String
  entity      Entity   @relation(fields: [entityId], references: [id], onDelete: Cascade)
  code        String
  name        String
  frequency   PayFrequency                        // MONTHLY (IN) | FORTNIGHTLY/WEEKLY (NZ common)
  payDayRule  PayDayRule                           // LAST_WORKING_DAY | FIXED_DOM | N_DAYS_AFTER
  payDayValue Int?
  cutoffDayRule PayDayRule
  cutoffDayValue Int?
  prorationMethod ProrationMethod @default(CALENDAR_DAYS)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  payRuns     PayRun[]
  @@unique([businessId, entityId, code])
  @@index([businessId, entityId, isActive])
}

enum PayFrequency { WEEKLY FORTNIGHTLY SEMI_MONTHLY MONTHLY }
enum PayDayRule   { LAST_WORKING_DAY FIRST_WORKING_DAY FIXED_DOM N_DAYS_AFTER_PERIOD_END }
```

### 7.2 `PayRun`

```prisma
model PayRun {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId      String
  entity        Entity   @relation(fields: [entityId], references: [id], onDelete: Restrict)
  payCalendarId String
  payCalendar   PayCalendar @relation(fields: [payCalendarId], references: [id], onDelete: Restrict)
  code          String                             // PR-2026-04-IN
  periodStart   DateTime @db.Date
  periodEnd     DateTime @db.Date
  payDate       DateTime @db.Date
  sequenceInYear Int                                // 1..12 (monthly) / 1..26 (fortnightly)
  taxYear       String                              // "2026-27"
  type          PayRunType @default(REGULAR)
  status        PayRunStatus @default(DRAFT)
  currencyCode  String   @db.Char(3)
  // Compliance snapshot — which rule version this run computed against (immutability)
  complianceVersionId String?
  // Totals (filled at compute; immutable once LOCKED)
  headcount     Int      @default(0)
  totalGross    Decimal  @db.Decimal(18,2) @default(0)
  totalDeductions Decimal @db.Decimal(18,2) @default(0)
  totalNet      Decimal  @db.Decimal(18,2) @default(0)
  totalEmployerCost Decimal @db.Decimal(18,2) @default(0)
  // Lifecycle actors
  computedAt    DateTime?
  computedBy    String?
  lockedAt      DateTime?
  lockedBy      String?
  approvedAt    DateTime?
  approvedBy    String?
  paidAt        DateTime?
  approvalRequestId String?
  parentPayRunId String?                            // for OFF_CYCLE/CORRECTION linked to a regular run
  notes         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  version       Int      @default(0)

  lines         PayRunLine[]
  payslips      Payslip[]
  remittances   StatutoryRemittance[]

  @@unique([businessId, entityId, payCalendarId, periodStart, type])
  @@index([businessId, entityId, status])
  @@index([businessId, taxYear])
}

enum PayRunType   { REGULAR OFF_CYCLE BONUS ARREAR FNF CORRECTION SUPPLEMENTARY }
enum PayRunStatus {
  DRAFT            // created, inputs being gathered
  INPUTS_LOCKED    // attendance/leave/variable inputs frozen for the period
  COMPUTING        // engine running (async)
  COMPUTED         // lines produced, under review
  REVIEW           // pending approval workflow
  LOCKED           // numbers frozen, payslips generated, immutable
  APPROVED         // signed off for disbursement + filing
  PAID             // bank file processed / disbursed
  FILED            // statutory returns generated/submitted
  CANCELLED        // voided before payment (DRAFT/COMPUTED only)
}
```

#### PayRun state machine

```
DRAFT ─lockInputs──► INPUTS_LOCKED ─compute──► COMPUTING ─done──► COMPUTED
COMPUTED ─reopen──► DRAFT        (discards lines; allowed only pre-LOCKED)
COMPUTED ─submit──► REVIEW ─reject──► COMPUTED
REVIEW ─approve──► LOCKED  (payslips generated, immutable snapshot taken)
LOCKED ─approve(disburse)──► APPROVED ─disburse──► PAID ─file──► FILED
DRAFT/COMPUTED ─cancel──► CANCELLED
LOCKED+ ─correct──► spawn child PayRun(type=CORRECTION) (never mutate the locked run)
```

**Invariants:**
- Once `LOCKED`, `PayRunLine` and `Payslip` rows are read-only; corrections create a `CORRECTION` child run with delta lines. Mirrors how Sitepresso freezes invoices (`InvoiceCounter` line 1877, `AdjustmentLedger` line 1883 for post-facto deltas).
- `complianceVersionId` is stamped at `COMPUTING` start so re-runs and audits reproduce the exact rates used, even if Super Admin later publishes a new `ComplianceRuleVersion`.
- A regular run cannot be `LOCKED` if the entity has an earlier regular run in the same tax year still in `DRAFT`/`COMPUTED` (no period gaps/overlaps); enforced by the `@@unique` + a service-layer sequence check.

### 7.3 `PayRunLine` — per-employee computation

```prisma
model PayRunLine {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  payRunId      String
  payRun        PayRun   @relation(fields: [payRunId], references: [id], onDelete: Cascade)
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Restrict)
  compensationId String                            // revision used
  // Period attendance inputs (snapshot)
  payableDays   Decimal  @db.Decimal(8,4)
  lopDays       Decimal  @db.Decimal(8,4) @default(0)  // loss-of-pay
  overtimeHours Decimal  @db.Decimal(8,2) @default(0)
  // Totals
  grossEarnings Decimal  @db.Decimal(15,2) @default(0)
  totalDeductions Decimal @db.Decimal(15,2) @default(0)
  netPay        Decimal  @db.Decimal(15,2) @default(0)
  employerCost  Decimal  @db.Decimal(15,2) @default(0)
  currencyCode  String   @db.Char(3)
  // Country statutory rollups (snapshot for fast reporting + filing)
  pfEmployee    Decimal? @db.Decimal(15,2)
  pfEmployer    Decimal? @db.Decimal(15,2)
  esiEmployee   Decimal? @db.Decimal(15,2)
  esiEmployer   Decimal? @db.Decimal(15,2)
  pt            Decimal? @db.Decimal(15,2)
  tds           Decimal? @db.Decimal(15,2)
  paye          Decimal? @db.Decimal(15,2)
  kiwiSaverEmployee Decimal? @db.Decimal(15,2)
  kiwiSaverEmployer Decimal? @db.Decimal(15,2)
  esct          Decimal? @db.Decimal(15,2)
  accLevy       Decimal? @db.Decimal(15,2)
  studentLoan   Decimal? @db.Decimal(15,2)
  // Status
  status        PayRunLineStatus @default(PENDING)
  errorJson     Json?                              // validation/compute errors for this employee
  computeTrace  Json?                              // optional engine trace (debug; not on hot path)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)

  components    PayRunLineComponent[]
  payslip       Payslip?

  @@unique([payRunId, employeeId])
  @@index([businessId, employeeId])
  @@index([businessId, payRunId, status])
}

enum PayRunLineStatus { PENDING COMPUTED ON_HOLD ERROR EXCLUDED FINALIZED }

model PayRunLineComponent {                        // every component amount on the line (audit-grade)
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  payRunLineId String
  payRunLine   PayRunLine @relation(fields: [payRunLineId], references: [id], onDelete: Cascade)
  createdAt    DateTime @default(now())
  componentId  String
  componentCode String
  componentName String
  category     ComponentCategory
  amount       Decimal  @db.Decimal(15,2)
  baseAmount   Decimal? @db.Decimal(15,2)          // base the calc ran on
  rateApplied  Decimal? @db.Decimal(9,6)
  isStatutory  Boolean  @default(false)
  sortOrder    Int      @default(0)
  @@index([businessId, payRunLineId])
  @@index([businessId, componentCode])
}
```

### 7.4 `Payslip` — immutable artifact

```prisma
model Payslip {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  payRunId      String
  payRun        PayRun   @relation(fields: [payRunId], references: [id], onDelete: Restrict)
  payRunLineId  String   @unique
  payRunLine    PayRunLine @relation(fields: [payRunLineId], references: [id], onDelete: Restrict)
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Restrict)
  code          String                             // PS-2026-04-EMP000142
  periodStart   DateTime @db.Date
  periodEnd     DateTime @db.Date
  payDate       DateTime @db.Date
  currencyCode  String   @db.Char(3)
  grossEarnings Decimal  @db.Decimal(15,2)
  totalDeductions Decimal @db.Decimal(15,2)
  netPay        Decimal  @db.Decimal(15,2)
  // Immutability + delivery
  snapshotJson  Json                                // full rendered payslip data, frozen
  pdfUrl        String?  @db.Text
  pdfHash       String?                             // SHA-256 of generated PDF (tamper evidence)
  yptdJson      Json?                                // year-to-date figures snapshot
  publishedAt   DateTime?                            // visible in ESS
  viewedAt      DateTime?
  emailedAt     DateTime?
  status        PayslipStatus @default(GENERATED)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?                            // soft only; @retain:statutory
  version       Int      @default(0)

  @@unique([businessId, payRunId, employeeId])
  @@index([businessId, employeeId, payDate])
}

enum PayslipStatus { GENERATED PUBLISHED VIEWED SUPERSEDED }
```

> **Why `snapshotJson`:** the IN Code on Wages and NZ Holidays Act both require **provable** historical payslips. We freeze the fully-rendered data so a payslip never changes even if components, names, or rates are later edited. `pdfHash` gives tamper evidence; a `SUPERSEDED` status (never delete) handles reissues.

### 7.5 `StatutoryRemittance` — what we owe and when

Tracks the employer's filing/payment obligations generated from a pay run, with the **exact statutory due dates** so the scheduler can dun.

```prisma
model StatutoryRemittance {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String
  entity      Entity   @relation(fields: [entityId], references: [id], onDelete: Restrict)
  payRunId    String?
  payRun      PayRun?  @relation(fields: [payRunId], references: [id], onDelete: SetNull)
  kind        RemittanceKind
  taxPeriod   String                               // "2026-04" or "2026-Q1"
  amount      Decimal  @db.Decimal(18,2)
  currencyCode String  @db.Char(3)
  dueDate     DateTime @db.Date
  filedDate   DateTime?
  paidDate    DateTime?
  challanRef  String?                              // CRN/challan/IRD ref
  status      RemittanceStatus @default(PENDING)
  fileUrl     String?  @db.Text                    // ECR txt / Form 24Q / payday CSV
  meta        Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  @@index([businessId, entityId, kind, taxPeriod])
  @@index([businessId, status, dueDate])
}

enum RemittanceKind {
  IN_TDS IN_PF IN_ESI IN_PT IN_LWF IN_FORM24Q IN_FORM16
  NZ_PAYE NZ_PAYDAY_FILING NZ_KIWISAVER NZ_ESCT NZ_STUDENT_LOAN NZ_ACC
}
enum RemittanceStatus { PENDING DUE FILED PAID OVERDUE WAIVED }
```

**Due-date seeds (engine sets these on remittance creation):**

| Obligation | Market | Statutory due | Notes |
|---|---|---|---|
| TDS deposit | IN | 7th of next month | challan via TRACES |
| PF (ECR) | IN | 15th of next month | EPFO Unified portal |
| ESIC | IN | 15th of next month | half-yearly contribution periods Apr–Sep / Oct–Mar |
| Professional Tax | IN | per state (monthly/annual) | cap ₹2,500/yr |
| Form 24Q (quarterly TDS) | IN | Q1 31 Jul, Q2 31 Oct, Q3 31 Jan, Q4 31 May | |
| Form 16 (annual TDS cert) | IN | 15 Jun after FY | *2026 sources mention rename to "Form 130" under Income Tax Act 2025 — VERIFY before GA (open question O-3).* |
| PAYE | NZ | by payday + payment to IRD (20th typical for monthly filers) | |
| Payday filing | NZ | **within 2 working days of each payday** | electronic filing to IRD |
| KiwiSaver / ESCT / SL / ACC | NZ | with PAYE | reported on each payday |

---

## 8. Leave

NZ's Holidays Act 2003 makes this the **highest-value, hardest** subsystem. The model must support both IN's accrual/balance paradigm (CL/SL/EL in days) and NZ's **weeks-based** annual leave with **relevant-daily-pay (RDP) vs average-daily-pay (ADP)**, alternative/lieu days, and the four leave types with distinct rules. We model leave as **type → policy → assignment → balance → transaction**, with NZ extension fields for the weeks/pay machinery. Deep calc lives in `07-leave-attendance.md`; here is the persistence + state machine.

### 8.1 `LeaveType` & `LeavePolicy`

```prisma
model LeaveType {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  countryCode String?  @db.Char(2)                 // NULL = both
  code        String                                // "EL","SL","CL","ANNUAL","SICK","BEREAVEMENT","PUBLIC","ALT"
  name        String
  category    LeaveCategory
  unit        LeaveUnit @default(DAYS)              // NZ ANNUAL = WEEKS
  isPaid      Boolean  @default(true)
  isStatutory Boolean  @default(false)
  // NZ Holidays Act semantics
  nzPayBasis  NZLeavePayBasis?                      // RDP | ADP | AWE_8PCT | OWP_ADP
  requiresReason Boolean @default(false)            // sick/bereavement may need note
  affectsLOP  Boolean  @default(false)              // unpaid → loss of pay on payroll
  isEncashable Boolean @default(false)
  color       String?                                // ESS calendar chip (one of fixed palette)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  policies    LeavePolicy[]
  balances    LeaveBalance[]
  txns        LeaveTransaction[]
  @@unique([businessId, code])
  @@index([businessId, countryCode, category])
}

enum LeaveCategory {
  ANNUAL CASUAL SICK MATERNITY PATERNITY BEREAVEMENT
  PUBLIC_HOLIDAY ALTERNATIVE_DAY COMP_OFF UNPAID SABBATICAL
  MARRIAGE ADOPTION FAMILY_VIOLENCE OTHER
}
enum LeaveUnit { DAYS HOURS WEEKS }
enum NZLeavePayBasis {
  RDP            // Relevant Daily Pay (Holidays Act s9) — what they'd have earned
  ADP            // Average Daily Pay (s9A) — when RDP not practicable
  AWE_8PCT       // Annual holiday pay: greater of Ordinary Weekly Pay & Avg Weekly Earnings
  OWP            // Ordinary Weekly Pay
}

model LeavePolicy {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  leaveTypeId String
  leaveType   LeaveType @relation(fields: [leaveTypeId], references: [id], onDelete: Cascade)
  entityId    String?
  code        String
  name        String
  // Entitlement
  accrualMethod AccrualMethod
  entitlementPerYear Decimal? @db.Decimal(8,4)      // e.g. 18 EL days, or 4 weeks (NZ)
  accrualFrequency AccrualFrequency @default(MONTHLY)
  accrualProrateOnJoin Boolean @default(true)
  // Carry-forward & expiry
  carryForwardCap Decimal? @db.Decimal(8,4)
  carryForwardExpiryMonths Int?
  // Limits
  maxBalanceCap  Decimal? @db.Decimal(8,4)
  maxConsecutive Int?
  minNoticeDays  Int?
  allowNegative  Boolean @default(false)            // advance leave
  negativeCap    Decimal? @db.Decimal(8,4)
  // Eligibility gates
  minTenureMonths Int @default(0)                   // e.g. NZ annual leave vests at 12 months
  appliesToEmploymentTypes String?                  // CSV of EmploymentType
  genderRestriction Gender?                          // maternity/paternity
  // Encashment
  encashOnExit  Boolean @default(false)
  encashFormula String?
  // Approval
  workflowDefinitionId String?
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  assignments LeavePolicyAssignment[]
  accrualRules AccrualRule[]
  @@unique([businessId, code])
  @@index([businessId, leaveTypeId, entityId])
}

enum AccrualMethod    { UPFRONT_ANNUAL MONTHLY_ACCRUAL ANNIVERSARY_GRANT WORKED_HOURS_RATIO CONTINUOUS_NZ }
enum AccrualFrequency { MONTHLY QUARTERLY ANNUAL PER_PAY_PERIOD }

model AccrualRule {                                  // tenure-tiered accrual (e.g. more EL after 5 yrs)
  id           String   @id @default(uuid())
  businessId   String
  leavePolicyId String
  leavePolicy  LeavePolicy @relation(fields: [leavePolicyId], references: [id], onDelete: Cascade)
  minTenureMonths Int
  maxTenureMonths Int?
  ratePerPeriod Decimal @db.Decimal(8,4)
  createdAt    DateTime @default(now())
  @@index([businessId, leavePolicyId, minTenureMonths])
}

model LeavePolicyAssignment {                        // which employees/groups get which policy
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  leavePolicyId String
  leavePolicy  LeavePolicy @relation(fields: [leavePolicyId], references: [id], onDelete: Cascade)
  scope        AssignmentScope
  scopeRefId   String?                               // entity/dept/grade/employee id
  effectiveFrom DateTime @db.Date
  effectiveTo  DateTime? @db.Date
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@index([businessId, leavePolicyId, scope, scopeRefId])
}

enum AssignmentScope { ENTITY DEPARTMENT GRADE EMPLOYMENT_TYPE EMPLOYEE }
```

### 8.2 `LeaveBalance` & `LeaveTransaction`

`LeaveBalance` is the running balance per `(employee, leaveType, period)`. `LeaveTransaction` is the **ledger** — every accrual, application, approval, cancellation, encashment, lapse is a row, so the balance is always reconstructable (event-sourced; mirrors Sitepresso's `AdjustmentLedger` line 1883 + `BudgetUsage` deduction pattern line 2993).

```prisma
model LeaveBalance {
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId   String
  employee     Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  leaveTypeId  String
  leaveType    LeaveType @relation(fields: [leaveTypeId], references: [id], onDelete: Restrict)
  periodCode   String                                // "2026-27" or NZ anniversary "2026-ANNIV"
  unit         LeaveUnit
  opening      Decimal  @db.Decimal(10,4) @default(0)
  accrued      Decimal  @db.Decimal(10,4) @default(0)
  taken        Decimal  @db.Decimal(10,4) @default(0)
  pendingApproval Decimal @db.Decimal(10,4) @default(0)  // soft-hold for in-flight requests
  encashed     Decimal  @db.Decimal(10,4) @default(0)
  lapsed       Decimal  @db.Decimal(10,4) @default(0)
  adjusted     Decimal  @db.Decimal(10,4) @default(0)
  closing      Decimal  @db.Decimal(10,4) @default(0)  // derived; persisted for fast reads
  // NZ annual leave money valuation (weeks → $ via 8% / AWE)
  nzAccruedGrossEarnings Decimal? @db.Decimal(15,2)     // running gross since anniversary (for 8%)
  lastAccrualAt DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  version      Int      @default(0)
  @@unique([businessId, employeeId, leaveTypeId, periodCode])
  @@index([businessId, employeeId])
}

model LeaveTransaction {
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId   String
  employee     Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  leaveTypeId  String
  leaveType    LeaveType @relation(fields: [leaveTypeId], references: [id], onDelete: Restrict)
  leaveBalanceId String?
  txnType      LeaveTxnType
  unit         LeaveUnit
  quantity     Decimal  @db.Decimal(10,4)            // +accrual / -taken (signed)
  // Application-specific (NULL for accrual/lapse rows)
  startDate    DateTime? @db.Date
  endDate      DateTime? @db.Date
  startHalf    DayHalf?                              // FIRST_HALF/SECOND_HALF for half-days
  endHalf      DayHalf?
  reason       String?                               // @pii:sensitive for sick/bereavement
  // NZ pay valuation snapshot at approval
  nzPayBasisUsed NZLeavePayBasis?
  paidAmount   Decimal? @db.Decimal(15,2)
  // Workflow
  status       LeaveTxnStatus @default(DRAFT)
  approvalRequestId String?
  appliedAt    DateTime?
  decidedAt    DateTime?
  decidedBy    String?
  payRunId     String?                               // when consumed by payroll (LOP/paid)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  version      Int      @default(0)
  @@index([businessId, employeeId, leaveTypeId])
  @@index([businessId, status])
  @@index([businessId, startDate, endDate])
}

enum LeaveTxnType   { ACCRUAL APPLICATION CANCELLATION ENCASHMENT LAPSE ADJUSTMENT OPENING_BALANCE }
enum LeaveTxnStatus { DRAFT PENDING APPROVED REJECTED CANCELLED WITHDRAWN AVAILED }
enum DayHalf        { FIRST_HALF SECOND_HALF }
```

#### Leave application state machine

```
DRAFT ─submit──► PENDING ─approve──► APPROVED ─periodReached──► AVAILED
PENDING ─reject──► REJECTED
PENDING ─withdraw(employee)──► WITHDRAWN
APPROVED ─cancel(before start, approver)──► CANCELLED (reverses balance hold→taken)
APPROVED ─cancel(after start)──► requires ADJUSTMENT txn (partial reversal)
```

**Balance arithmetic invariant:** `closing = opening + accrued − taken − encashed − lapsed + adjusted`, and `pendingApproval` is a soft hold (not in `closing`) so two overlapping requests can't both clear. On approve: `pendingApproval -= q; taken += q`. All under the row `version` optimistic lock to prevent double-spend.

### 8.3 NZ Holidays Act specifics carried in the model

| Holidays Act concept | Where modeled | Rule (2026) |
|---|---|---|
| Annual holidays in **weeks** | `LeaveType.unit = WEEKS`, `LeavePolicy.entitlementPerYear` (e.g. 4) | 4 weeks after 12 months continuous employment; `minTenureMonths=12`, `AccrualMethod=CONTINUOUS_NZ`. |
| Annual holiday **pay rate** | `LeaveType.nzPayBasis = AWE_8PCT` | Greater of Ordinary Weekly Pay and Average Weekly Earnings (12-month gross ÷ 52). `nzAccruedGrossEarnings` feeds the 8% / AWE calc. |
| **8% pay-as-you-go** (casual/fixed-term) | `AccrualMethod=WORKED_HOURS_RATIO`, component `kind=LEAVE_ENCASHMENT` | 8% of gross each pay where genuinely casual. |
| Sick leave | `LeaveType code=SICK`, `nzPayBasis=RDP/ADP` | 10 days/year after 6 months; up to 20 days max balance. |
| Bereavement | `LeaveType code=BEREAVEMENT` | 3 days (immediate family) / 1 day; RDP. |
| Family violence leave | `LeaveCategory=FAMILY_VIOLENCE` | 10 days/year. |
| Public holidays | `Holiday` table (§9) + `LeaveType code=PUBLIC` | paid at RDP if otherwise-working day; **time-and-a-half + alternative day** if worked. |
| Alternative (lieu) day | `LeaveType code=ALT`, `LeaveCategory=ALTERNATIVE_DAY` | granted when a public holiday worked; tracked as a balance with no expiry. |
| RDP vs ADP choice | `LeaveTransaction.nzPayBasisUsed` snapshot | engine picks RDP; falls back to ADP only when RDP "not possible or practicable." |

---

## 9. Attendance, shifts, timesheets

### 9.1 `ShiftPattern`, `ShiftAssignment`, `WeekOffPattern`, `Holiday`

```prisma
model ShiftPattern {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?
  code        String
  name        String                                // "General 9-6", "Night A"
  startTime   String                                // "09:00" local
  endTime     String                                // "18:00"
  breakMinutes Int     @default(60)
  graceInMinutes Int   @default(10)
  halfDayThresholdMinutes Int?
  fullDayMinutes Int   @default(480)
  isNightShift Boolean @default(false)
  crossesMidnight Boolean @default(false)
  weeklyOffDays String  @default("0")               // CSV ISO weekday (0=Sun)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  assignments ShiftAssignment[]
  @@unique([businessId, code])
}

model ShiftAssignment {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  shiftPatternId String
  shiftPattern ShiftPattern @relation(fields: [shiftPatternId], references: [id], onDelete: Restrict)
  effectiveFrom DateTime @db.Date
  effectiveTo DateTime? @db.Date
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([businessId, employeeId, effectiveFrom])
}

model Holiday {                                       // public/company holiday calendar
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?
  locationId  String?                                // region-specific (NZ provincial anniversary)
  date        DateTime @db.Date
  name        String
  type        HolidayType
  countryCode String   @db.Char(2)
  isPaid      Boolean  @default(true)
  isRestricted Boolean @default(false)               // IN optional/restricted holiday
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([businessId, entityId, locationId, date, name])
  @@index([businessId, countryCode, date])
}

enum HolidayType { PUBLIC NATIONAL REGIONAL COMPANY RESTRICTED_OPTIONAL }
```

> NZ public holidays are **Mondayised** (if they fall on a weekend, observed Monday) and provincial anniversary days vary by region — hence `locationId` on `Holiday` and `countryCode`-aware seeding. The mover that knows the 2026 NZ public-holiday set lives in `06-compliance-NZ.md`.

### 9.2 `AttendancePunch` & daily `Attendance`

```prisma
model AttendancePunch {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  locationId  String?
  punchType   PunchType
  punchAt     DateTime                                // stored UTC; rendered in location TZ
  source      PunchSource
  geoLat      Decimal? @db.Decimal(9,6)
  geoLng      Decimal? @db.Decimal(9,6)
  ipAddress   String?
  deviceId    String?
  selfieUrl   String?  @db.Text                       // @pii:sensitive (optional)
  isManual    Boolean  @default(false)                // regularization
  regularizationRequestId String?
  createdAt   DateTime @default(now())
  @@index([businessId, employeeId, punchAt])
  @@index([businessId, locationId, punchAt])
}

enum PunchType   { IN OUT BREAK_START BREAK_END }
enum PunchSource { WEB MOBILE_APP BIOMETRIC KIOSK GEO_FENCE API IMPORT MANUAL }

model Attendance {                                    // derived daily summary (one per emp/day)
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  date        DateTime @db.Date
  shiftPatternId String?
  firstIn     DateTime?
  lastOut     DateTime?
  workedMinutes Int     @default(0)
  breakMinutes Int      @default(0)
  overtimeMinutes Int   @default(0)
  status      AttendanceStatus
  lopFraction Decimal  @db.Decimal(5,4) @default(0)   // 0/0.5/1 LOP for payroll
  isLocked    Boolean  @default(false)                // frozen once period inputs lock
  exceptionsJson Json?                                 // late, early-out, missing-punch flags
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  @@unique([businessId, employeeId, date])
  @@index([businessId, date, status])
}

enum AttendanceStatus {
  PRESENT ABSENT HALF_DAY ON_LEAVE WEEKLY_OFF HOLIDAY
  WORK_FROM_HOME ON_DUTY HOLIDAY_WORKED MISSING_PUNCH
}
```

### 9.3 `Timesheet` & `TimesheetEntry` (project/client time, OT, billable)

```prisma
model Timesheet {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  periodStart DateTime @db.Date
  periodEnd   DateTime @db.Date
  totalHours  Decimal  @db.Decimal(8,2) @default(0)
  billableHours Decimal @db.Decimal(8,2) @default(0)
  overtimeHours Decimal @db.Decimal(8,2) @default(0)
  status      TimesheetStatus @default(DRAFT)
  approvalRequestId String?
  submittedAt DateTime?
  decidedAt   DateTime?
  decidedBy   String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  entries     TimesheetEntry[]
  @@unique([businessId, employeeId, periodStart])
  @@index([businessId, status])
}

enum TimesheetStatus { DRAFT SUBMITTED APPROVED REJECTED LOCKED }

model TimesheetEntry {
  id          String   @id @default(uuid())
  businessId  String
  timesheetId String
  timesheet   Timesheet @relation(fields: [timesheetId], references: [id], onDelete: Cascade)
  date        DateTime @db.Date
  projectCode String?
  taskCode    String?
  hours       Decimal  @db.Decimal(6,2)
  isBillable  Boolean  @default(false)
  isOvertime  Boolean  @default(false)
  notes       String?
  createdAt   DateTime @default(now())
  @@index([businessId, timesheetId, date])
}
```

---

## 10. Expense & reimbursement

```prisma
model ExpenseCategory {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code        String
  name        String
  glCode      String?
  isTaxable   Boolean  @default(false)                // affects payroll if reimbursed via payslip
  perDiem     Decimal? @db.Decimal(15,2)
  dailyCap    Decimal? @db.Decimal(15,2)
  requiresReceipt Boolean @default(true)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([businessId, code])
}

model ExpensePolicy {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code        String
  name        String
  scope       AssignmentScope
  scopeRefId  String?
  monthlyCap  Decimal? @db.Decimal(15,2)
  workflowDefinitionId String?
  reimburseVia ReimburseChannel @default(PAYROLL)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([businessId, code])
}

enum ReimburseChannel { PAYROLL BANK_TRANSFER PETTY_CASH }

model ExpenseClaim {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  code        String                                  // EXP-000087
  title       String
  currencyCode String  @db.Char(3)
  totalAmount Decimal  @db.Decimal(15,2) @default(0)
  approvedAmount Decimal? @db.Decimal(15,2)
  status      ExpenseStatus @default(DRAFT)
  approvalRequestId String?
  reimburseVia ReimburseChannel @default(PAYROLL)
  payRunId    String?                                 // when paid through payroll
  paidAt      DateTime?
  submittedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  lines       ExpenseLine[]
  @@unique([businessId, code])
  @@index([businessId, employeeId, status])
}

enum ExpenseStatus { DRAFT SUBMITTED PARTIALLY_APPROVED APPROVED REJECTED REIMBURSED CANCELLED }

model ExpenseLine {
  id          String   @id @default(uuid())
  businessId  String
  expenseClaimId String
  expenseClaim ExpenseClaim @relation(fields: [expenseClaimId], references: [id], onDelete: Cascade)
  categoryId  String
  expenseDate DateTime @db.Date
  amount      Decimal  @db.Decimal(15,2)
  taxAmount   Decimal? @db.Decimal(15,2)              // GST/IN input, NZ GST
  approvedAmount Decimal? @db.Decimal(15,2)
  merchant    String?
  receiptUrl  String?  @db.Text
  notes       String?
  isReimbursable Boolean @default(true)
  createdAt   DateTime @default(now())
  @@index([businessId, expenseClaimId])
}
```

**Expense state machine:** `DRAFT → SUBMITTED → (PARTIALLY_APPROVED | APPROVED | REJECTED) → REIMBURSED`; `REIMBURSED` is terminal. If `reimburseVia=PAYROLL`, approval sets `payRunId` candidacy and a `REIMBURSEMENT` component line is injected into the next open run for that employee.

---

## 11. Loan & advance

```prisma
model LoanScheme {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code        String
  name        String
  type        LoanType
  maxPrincipal Decimal @db.Decimal(15,2)
  maxTenureMonths Int
  interestRate Decimal @db.Decimal(9,6) @default(0)   // annual; 0 = interest-free advance
  interestMethod InterestMethod @default(FLAT)
  perquisiteTaxable Boolean @default(false)           // IN: concessional-rate loan perquisite
  eligibilityMinTenureMonths Int @default(0)
  workflowDefinitionId String?
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([businessId, code])
}

enum LoanType       { SALARY_ADVANCE PERSONAL_LOAN EMERGENCY FESTIVAL VEHICLE HOUSING }
enum InterestMethod { FLAT REDUCING_BALANCE ZERO }

model Loan {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  loanSchemeId String?
  code        String                                  // LN-000031
  type        LoanType
  principal   Decimal  @db.Decimal(15,2)
  interestRate Decimal @db.Decimal(9,6) @default(0)
  interestMethod InterestMethod @default(FLAT)
  tenureMonths Int
  emiAmount   Decimal  @db.Decimal(15,2)
  currencyCode String  @db.Char(3)
  disbursedAmount Decimal? @db.Decimal(15,2)
  outstandingPrincipal Decimal @db.Decimal(15,2) @default(0)
  startPeriod String?                                  // "2026-05" first deduction period
  status      LoanStatus @default(REQUESTED)
  approvalRequestId String?
  disbursedAt DateTime?
  closedAt    DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  installments LoanInstallment[]
  @@unique([businessId, code])
  @@index([businessId, employeeId, status])
}

enum LoanStatus { REQUESTED APPROVED REJECTED DISBURSED ACTIVE ON_HOLD CLOSED FORECLOSED WRITTEN_OFF }

model LoanInstallment {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  loanId      String
  loan        Loan     @relation(fields: [loanId], references: [id], onDelete: Cascade)
  installmentNo Int
  duetPeriod  String                                   // "2026-05"
  principalComponent Decimal @db.Decimal(15,2)
  interestComponent  Decimal @db.Decimal(15,2) @default(0)
  amount      Decimal  @db.Decimal(15,2)
  balanceAfter Decimal @db.Decimal(15,2)
  status      InstallmentStatus @default(SCHEDULED)
  payRunId    String?                                  // run that recovered it
  recoveredAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  @@unique([businessId, loanId, installmentNo])
  @@index([businessId, loanId, duetPeriod])
  @@index([businessId, status, duetPeriod])
}

enum InstallmentStatus { SCHEDULED DUE RECOVERED SKIPPED WAIVED BOUNCED }
```

**Loan lifecycle:** approval generates the full `LoanInstallment` schedule (amortized for `REDUCING_BALANCE`). Each open pay run pulls the `DUE` installment for the period, injects a `LOAN_REPAYMENT` deduction component, marks the installment `RECOVERED` with `payRunId`, and decrements `outstandingPrincipal`. **LOP/insufficient-net guard:** if net pay < installment, the run either skips (`SKIPPED`, extends tenure) or part-recovers per scheme config. On separation, FNF run forecloses the outstanding from final settlement (`NOTICE_RECOVERY`/balance).

---

## 12. Documents

```prisma
model EmployeeDocument {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  category    DocumentCategory
  name        String
  fileUrl     String   @db.Text                       // object storage key (R2/S3)
  fileHash    String?                                  // SHA-256 integrity
  mimeType    String?
  sizeBytes   Int?
  // KYC/verification
  documentNumber String?                              // @pii:identity (masked at rest)
  expiresAt   DateTime? @db.Date                       // visa/permit/license expiry → reminders
  verifiedAt  DateTime?
  verifiedBy  String?
  visibility  DocumentVisibility @default(HR_ONLY)
  isEmployeeUploaded Boolean @default(false)
  signatureStatus SignatureStatus?                     // for offer letters / policy ack
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  @@index([businessId, employeeId, category])
  @@index([businessId, expiresAt])
}

enum DocumentCategory {
  ID_PROOF ADDRESS_PROOF PAN AADHAAR PASSPORT VISA WORK_PERMIT
  EDUCATION EXPERIENCE OFFER_LETTER CONTRACT PAYSLIP_COPY
  TAX_DECLARATION FORM16 BANK_PROOF MEDICAL POLICY_ACK OTHER
}
enum DocumentVisibility { HR_ONLY MANAGER_AND_HR EMPLOYEE_VISIBLE }
enum SignatureStatus    { NOT_REQUIRED PENDING SIGNED DECLINED EXPIRED }
```

Document templates (offer letters, contracts) are **system templates with merge fields**, not tenant-built layouts — honoring "configure, not build." A `DocumentTemplate` table (entity-scoped, picks one of N fixed layouts, fills logo/brand color/merge fields) backs generated PDFs; storage and signing reuse Sitepresso's signature plumbing (`User.signatureUrl`/`stampUrl`, lines 37–38).

---

## 13. Asset management

```prisma
model Asset {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?
  code        String                                  // AST-000045
  name        String
  category    AssetCategory
  serialNumber String?
  purchaseDate DateTime? @db.Date
  purchaseCost Decimal? @db.Decimal(15,2)
  currencyCode String?  @db.Char(3)
  condition   AssetCondition @default(GOOD)
  status      AssetStatus @default(AVAILABLE)
  warrantyExpiry DateTime? @db.Date
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  assignments AssetAssignment[]
  @@unique([businessId, code])
  @@index([businessId, status, category])
}

enum AssetCategory  { LAPTOP DESKTOP MOBILE MONITOR ACCESSORY SIM VEHICLE FURNITURE ID_CARD ACCESS_CARD SOFTWARE_LICENSE OTHER }
enum AssetCondition { NEW GOOD FAIR DAMAGED RETIRED }
enum AssetStatus    { AVAILABLE ASSIGNED IN_REPAIR LOST RETIRED }

model AssetAssignment {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  assetId     String
  asset       Asset    @relation(fields: [assetId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  assignedAt  DateTime @db.Date
  returnedAt  DateTime? @db.Date
  conditionOut AssetCondition?
  conditionIn AssetCondition?
  acknowledgmentSignedAt DateTime?
  recoveryAmount Decimal? @db.Decimal(15,2)            // if lost/damaged → payroll recovery
  notes       String?
  status      AssetAssignmentStatus @default(ASSIGNED)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([businessId, employeeId, status])
  @@index([businessId, assetId])
}

enum AssetAssignmentStatus { ASSIGNED RETURNED LOST DAMAGED PENDING_RECOVERY }
```

Asset return is a checklist item on **offboarding** (separation workflow); unreturned/damaged assets create a `NOTICE_RECOVERY` line in the FNF pay run.

---

## 14. Performance

```prisma
model ReviewCycle {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?
  code        String
  name        String                                  // "FY2026 Annual", "H1 2026"
  type        ReviewCycleType
  periodStart DateTime @db.Date
  periodEnd   DateTime @db.Date
  status      ReviewCycleStatus @default(DRAFT)
  ratingScaleJson Json                                 // fixed scale options (1-5 / labels)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  reviews     PerformanceReview[]
  @@unique([businessId, code])
}

enum ReviewCycleType   { ANNUAL HALF_YEARLY QUARTERLY PROBATION PROJECT CONTINUOUS }
enum ReviewCycleStatus { DRAFT ACTIVE SELF_REVIEW MANAGER_REVIEW CALIBRATION CLOSED }

model PerformanceReview {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  reviewCycleId String
  reviewCycle ReviewCycle @relation(fields: [reviewCycleId], references: [id], onDelete: Cascade)
  employeeId  String                                  // reviewee
  employee    Employee @relation("RevieweeReviews", fields: [employeeId], references: [id], onDelete: Cascade)
  reviewerId  String                                  // manager
  reviewer    Employee @relation("ReviewerReviews", fields: [reviewerId], references: [id], onDelete: Restrict)
  selfRating  Decimal? @db.Decimal(4,2)
  managerRating Decimal? @db.Decimal(4,2)
  finalRating Decimal? @db.Decimal(4,2)               // post-calibration
  selfComments String?
  managerComments String?
  status      ReviewStatus @default(NOT_STARTED)
  outcomeJson Json?                                    // promotion/PIP/hike recommendation
  linkedCompensationId String?                          // hike → CompensationRevision
  submittedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  @@unique([businessId, reviewCycleId, employeeId])
  @@index([businessId, reviewerId, status])
}

enum ReviewStatus { NOT_STARTED SELF_SUBMITTED MANAGER_SUBMITTED CALIBRATED ACKNOWLEDGED CLOSED }

model Goal {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  reviewCycleId String?
  title       String
  description String?
  category    GoalCategory @default(INDIVIDUAL)
  weight      Decimal? @db.Decimal(5,2)
  target      String?
  progress    Decimal  @db.Decimal(5,2) @default(0)
  status      GoalStatus @default(DRAFT)
  dueDate     DateTime? @db.Date
  parentGoalId String?                                 // cascade from org/dept OKR
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  @@index([businessId, employeeId, status])
}

enum GoalCategory { ORGANIZATION DEPARTMENT TEAM INDIVIDUAL DEVELOPMENT }
enum GoalStatus   { DRAFT ACTIVE ON_TRACK AT_RISK ACHIEVED MISSED CANCELLED }

model EmployeeSkill {
  id          String   @id @default(uuid())
  businessId  String
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  skillName   String
  proficiency Int                                      // 1-5
  isPrimary   Boolean  @default(false)
  endorsedBy  String?
  createdAt   DateTime @default(now())
  @@index([businessId, employeeId])
}
```

---

## 15. Recruitment (ATS)

```prisma
model Job {                                            // requisition
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?
  code        String                                  // JOB-000012
  title       String
  departmentId String?
  designationId String?
  locationId  String?
  countryCode String   @db.Char(2)
  employmentType EmploymentType
  openings    Int      @default(1)
  description String?  @db.Text
  minSalary   Decimal? @db.Decimal(15,2)
  maxSalary   Decimal? @db.Decimal(15,2)
  currencyCode String? @db.Char(3)
  hiringManagerId String?
  status      JobStatus @default(DRAFT)
  publishedAt DateTime?
  closedAt    DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  stages      JobStage[]
  applications Application[]
  @@unique([businessId, code])
  @@index([businessId, status])
}

enum JobStatus { DRAFT OPEN ON_HOLD CLOSED CANCELLED FILLED }

model JobStage {                                       // configurable pipeline (fixed stage kinds)
  id          String   @id @default(uuid())
  businessId  String
  jobId       String
  job         Job      @relation(fields: [jobId], references: [id], onDelete: Cascade)
  name        String
  kind        StageKind
  sortOrder   Int
  createdAt   DateTime @default(now())
  @@unique([businessId, jobId, sortOrder])
}

enum StageKind { SOURCED SCREENING INTERVIEW ASSESSMENT OFFER HIRED REJECTED WITHDRAWN }

model Candidate {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  firstName   String                                  // @pii:identity
  lastName    String
  email       String                                  // @pii:contact
  phone       String?
  resumeUrl   String?  @db.Text
  source      String?                                 // referral/job-board/agency
  linkedinUrl String?
  consentAt   DateTime?                                // candidate data-processing consent
  consentExpiresAt DateTime?                            // auto-purge after retention window
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  applications Application[]
  @@unique([businessId, email])
  @@index([businessId, email])
}

model Application {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  jobId       String
  job         Job      @relation(fields: [jobId], references: [id], onDelete: Cascade)
  candidateId String
  candidate   Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)
  currentStageId String?
  status      ApplicationStatus @default(APPLIED)
  rating      Decimal? @db.Decimal(4,2)
  rejectReason String?
  convertedEmployeeId String?                           // set on hire → onboarding
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  interviews  Interview[]
  offers      Offer[]
  @@unique([businessId, jobId, candidateId])
  @@index([businessId, status])
}

enum ApplicationStatus { APPLIED SCREENING INTERVIEWING ASSESSMENT OFFERED HIRED REJECTED WITHDRAWN ON_HOLD }

model Interview {
  id          String   @id @default(uuid())
  businessId  String
  applicationId String
  application Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  round       Int
  scheduledAt DateTime?
  mode        InterviewMode
  interviewerIds String                                // CSV employee ids
  feedbackJson Json?
  recommendation InterviewRecommendation?
  status      InterviewStatus @default(SCHEDULED)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([businessId, applicationId])
}

enum InterviewMode           { ONSITE VIDEO PHONE }
enum InterviewRecommendation { STRONG_YES YES NEUTRAL NO STRONG_NO }
enum InterviewStatus         { SCHEDULED COMPLETED NO_SHOW CANCELLED RESCHEDULED }

model Offer {
  id          String   @id @default(uuid())
  businessId  String
  applicationId String
  application Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  ctcAnnual   Decimal? @db.Decimal(15,2)
  grossMonthly Decimal? @db.Decimal(15,2)
  currencyCode String  @db.Char(3)
  joiningDate DateTime? @db.Date
  structureId String?                                  // proposed SalaryStructure
  status      OfferStatus @default(DRAFT)
  letterUrl   String?  @db.Text
  sentAt      DateTime?
  respondedAt DateTime?
  expiresAt   DateTime?
  approvalRequestId String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  @@index([businessId, applicationId, status])
}

enum OfferStatus { DRAFT PENDING_APPROVAL APPROVED SENT ACCEPTED DECLINED EXPIRED REVOKED }
```

**Hire → onboarding bridge:** `Offer.ACCEPTED` triggers creation of an `Employee` (`status=PRE_HIRE`) + initial `EmploymentRecord` + `CompensationRevision` from the offer's structure, and `Application.convertedEmployeeId` is set. No data re-keying.

---

## 16. Helpdesk (HR case management)

```prisma
model HelpdeskCategory {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  name        String
  slaHours    Int?
  defaultAssigneeId String?
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  @@unique([businessId, name])
}

model HelpdeskTicket {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code        String                                  // HD-000219
  employeeId  String                                  // raiser
  employee    Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  categoryId  String?
  subject     String
  description String?  @db.Text
  priority    TicketPriority @default(NORMAL)
  status      TicketStatus @default(OPEN)
  assigneeId  String?
  slaDueAt    DateTime?
  resolvedAt  DateTime?
  closedAt    DateTime?
  satisfactionRating Int?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  version     Int      @default(0)
  messages    HelpdeskMessage[]
  @@unique([businessId, code])
  @@index([businessId, status, priority])
  @@index([businessId, assigneeId, status])
}

enum TicketPriority { LOW NORMAL HIGH URGENT }
enum TicketStatus   { OPEN IN_PROGRESS WAITING_ON_EMPLOYEE RESOLVED CLOSED REOPENED CANCELLED }

model HelpdeskMessage {
  id          String   @id @default(uuid())
  businessId  String
  ticketId    String
  ticket      HelpdeskTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  authorUserId String
  body        String   @db.Text
  isInternal  Boolean  @default(false)                // internal HR note vs employee-visible
  attachmentsJson Json?
  createdAt   DateTime @default(now())
  @@index([businessId, ticketId])
}
```

This reuses Sitepresso's support pattern (`SupportConversation` line 2423, `SupportMessage` line 2458) almost verbatim — internal-note flag, threaded messages — repointed from "tenant↔platform support" to "employee↔HR."

---

## 17. Compliance rule tables (Super-Admin owned, versioned)

The **flagship correctness mechanism**: country statutory rates/slabs/thresholds are **not** hard-coded in the engine. They live in versioned rule sets that Super Admin publishes with effective dates, so a new EPF ceiling or NZ KiwiSaver step doesn't need a code deploy, and every historical pay run reproduces exactly via the `complianceVersionId` it stamped (§7.2).

```prisma
model ComplianceRuleSet {
  id          String   @id @default(uuid())
  countryCode String   @db.Char(2)                     // "IN" | "NZ"
  domain      ComplianceDomain                          // PF/ESI/PT/TDS/PAYE/KIWISAVER/ESCT/ACC/MIN_WAGE/HOLIDAYS
  code        String                                    // "IN_EPF","NZ_KIWISAVER","NZ_ACC_EARNER"
  name        String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  versions    ComplianceRuleVersion[]
  @@unique([countryCode, domain, code])
}

enum ComplianceDomain {
  PF ESI PROFESSIONAL_TAX GRATUITY TDS LWF                   // IN
  PAYE KIWISAVER ESCT ACC_EARNER STUDENT_LOAN MIN_WAGE HOLIDAYS_ACT  // NZ
}

model ComplianceRuleVersion {
  id          String   @id @default(uuid())
  ruleSetId   String
  ruleSet     ComplianceRuleSet @relation(fields: [ruleSetId], references: [id], onDelete: Cascade)
  version     Int                                        // monotonic per ruleSet
  effectiveFrom DateTime @db.Date                        // e.g. 2026-04-01, 2025-11-21
  effectiveTo DateTime? @db.Date
  status      RuleVersionStatus @default(DRAFT)
  // The actual rates/slabs/thresholds — strongly-shaped JSON validated by a per-domain JSON Schema
  rulesJson   Json
  sourceUrl   String?                                    // citation (IRD/EPFO/gazette)
  notes       String?
  publishedBy String?
  publishedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([ruleSetId, version])
  @@index([ruleSetId, effectiveFrom])
}

enum RuleVersionStatus { DRAFT PUBLISHED SUPERSEDED ARCHIVED }
```

### 17.1 Seed payload examples (2026-accurate, with effective dates)

**`NZ_KIWISAVER` v(effectiveFrom 2026-04-01):**
```json
{ "defaultEmployeeRate": 0.035, "employeeRateOptions": [0.03,0.035,0.04,0.06,0.08,0.10],
  "employerRate": 0.035, "minAgeEmployerContrib": 16, "maxAgeEmployerContrib": 65,
  "govtContribMaxAnnual": 260.72, "note": "Default min 3% -> 3.5% from 1 Apr 2026; 16-17yo now employer-eligible; rises to 4% in 2028" }
```

**`NZ_ACC_EARNER` v(2026-04-01):**
```json
{ "rate": 0.0175, "maxLiableEarnings": 156641, "maxLevy": 2741.22, "prevRate": 0.0167 }
```

**`NZ_ESCT` v(2026-04-01, unchanged from 2025-04-01):**
```json
{ "brackets": [
  {"upTo": 16800, "rate": 0.105},
  {"upTo": 57600, "rate": 0.175},
  {"upTo": 84000, "rate": 0.30},
  {"upTo": 216000, "rate": 0.33},
  {"upTo": null,  "rate": 0.39} ] }
```

**`NZ_MIN_WAGE` v(2026-04-01):** `{ "adult": 23.95, "startingOut": 19.16, "training": 19.16, "unit": "per_hour" }`

**`NZ_STUDENT_LOAN` v(2026-04-01):** `{ "rate": 0.12, "annualThreshold": 24128, "applyWhenTaxCodeEndsWith": "SL" }`

**`IN_EPF` v(2025-11-21, post Labour Codes):**
```json
{ "employeeRate": 0.12, "employerRate": 0.12, "epsRate": 0.0833, "epsWageCeiling": 15000,
  "epsMaxMonthly": 1250, "epfEmployerRate": 0.0367, "edliRate": 0.005, "adminRate": 0.005,
  "wageCeiling": 15000, "mandatoryHeadcount": 20, "basicDaMinPctOfTotal": 0.50,
  "note": "Code on Wages 50% rule cascades into PF wage base from 21 Nov 2025" }
```

**`IN_ESI` v(2026-04-01):**
```json
{ "employeeRate": 0.0075, "employerRate": 0.0325, "grossCeiling": 21000, "mandatoryHeadcount": 10,
  "contributionPeriods": [{"from":"04-01","to":"09-30"},{"from":"10-01","to":"03-31"}] }
```

**`IN_TDS` v(FY2025-26, new regime default):**
```json
{ "regime": "NEW", "isDefault": true, "standardDeduction": 75000, "rebate87aTaxableUpTo": 1200000,
  "slabs": [
    {"from":0,"to":400000,"rate":0.00},
    {"from":400000,"to":800000,"rate":0.05},
    {"from":800000,"to":1200000,"rate":0.10},
    {"from":1200000,"to":1600000,"rate":0.15},
    {"from":1600000,"to":2000000,"rate":0.20},
    {"from":2000000,"to":2400000,"rate":0.25},
    {"from":2400000,"to":null,"rate":0.30} ],
  "cessRate": 0.04 }
```

**`IN_PROFESSIONAL_TAX`** — one rule version *per state* (selected by `Location.stateCode`), `rulesJson` carries the state's monthly slab array and the statutory annual cap `2500`. **`IN_GRATUITY`:** `{ "formulaNumerator": 15, "formulaDenominator": 26, "minYears": 5, "proRataFixedTerm": true }`.

> All figures above are verified against 2026 sources (IRD, MBIE, EPFO, CBDT, Code on Wages). The engine never inlines them — it resolves `ComplianceRuleVersion` by `(countryCode, domain, effectiveFrom ≤ payDate)`. Full per-domain schemas and the IN PT state matrix live in `05-compliance-IN.md` / `06-compliance-NZ.md`.

---

## 18. Workflow & approval

A generic, configurable (not buildable) approval engine used by leave, expense, loan, compensation, offer, profile-change, FNF. Tenants pick from fixed step types and assign approvers; they do not script logic.

```prisma
model WorkflowDefinition {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  code        String
  name        String
  module      WorkflowModule
  entityId    String?
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  steps       WorkflowStep[]
  @@unique([businessId, code])
  @@index([businessId, module, isActive])
}

enum WorkflowModule {
  LEAVE EXPENSE LOAN COMPENSATION OFFER PROFILE_CHANGE
  TIMESHEET ATTENDANCE_REGULARIZATION SEPARATION ASSET DOCUMENT_SIGN PAYRUN
}

model WorkflowStep {
  id          String   @id @default(uuid())
  businessId  String
  workflowDefinitionId String
  workflow    WorkflowDefinition @relation(fields: [workflowDefinitionId], references: [id], onDelete: Cascade)
  stepOrder   Int
  name        String
  approverType ApproverType
  approverRefId String?                                 // role id / employee id (for SPECIFIC)
  conditionJson Json?                                   // e.g. {"amount":{">":50000}} amount-tiered routing
  isParallel  Boolean  @default(false)                  // all approvers at this level
  minApprovals Int     @default(1)
  slaHours    Int?
  onTimeoutAction TimeoutAction @default(ESCALATE)
  createdAt   DateTime @default(now())
  @@unique([businessId, workflowDefinitionId, stepOrder])
}

enum ApproverType   { REPORTING_MANAGER DEPARTMENT_HEAD HR PAYROLL_MANAGER SPECIFIC_ROLE SPECIFIC_EMPLOYEE AUTO_APPROVE }
enum TimeoutAction  { ESCALATE AUTO_APPROVE AUTO_REJECT REMIND }

model ApprovalRequest {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  workflowDefinitionId String?
  module      WorkflowModule
  entityType  String                                    // "LeaveTransaction","ExpenseClaim"...
  entityId    String                                    // the row under approval
  requesterEmployeeId String?
  requester   Employee? @relation("RequesterApprovals", fields: [requesterEmployeeId], references: [id], onDelete: SetNull)
  currentStepOrder Int   @default(1)
  status      ApprovalStatus @default(PENDING)
  payloadJson Json?                                     // snapshot of request for approver view
  slaDueAt    DateTime?
  completedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  version     Int      @default(0)
  actions     ApprovalAction[]
  @@index([businessId, module, status])
  @@index([businessId, entityType, entityId])
}

enum ApprovalStatus { PENDING APPROVED REJECTED CANCELLED ESCALATED EXPIRED WITHDRAWN }

model ApprovalAction {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  approvalRequestId String
  approvalRequest ApprovalRequest @relation(fields: [approvalRequestId], references: [id], onDelete: Cascade)
  stepOrder   Int
  approverUserId String
  decision    ApprovalDecision
  comment     String?
  actedAt     DateTime @default(now())
  createdAt   DateTime @default(now())
  delegatedFromUserId String?                           // approval delegation
  @@index([businessId, approvalRequestId])
}

enum ApprovalDecision { APPROVED REJECTED REQUESTED_CHANGES DELEGATED ABSTAINED }
```

**Approval flow:** the originating row (e.g. `LeaveTransaction`) creates an `ApprovalRequest`; each `WorkflowStep` resolves approvers (manager via `EmploymentRecord.managerEmployeeId`, dept head, role membership). Parallel steps need `minApprovals`. On final approval the engine calls back the source module (state → `APPROVED`) and releases the balance hold / injects the payroll component. SLA breach triggers `TimeoutAction`. Amount-tiered routing (`conditionJson`) lets a ₹100k expense need an extra VP step without a new workflow.

---

## 19. Audit, notifications, sequences

### 19.1 `AuditLog` — immutable, append-only

Generalizes Sitepresso's `PricingAuditLog` (line 2780) with actor, IP, impersonation, and before/after. **Never** soft-deletable; survives employee anonymisation (legal-defence proof, same rationale as the Sitepresso GDPR comment at lines 39–43).

```prisma
model AuditLog {
  id          String   @id @default(uuid())
  businessId  String?                                   // NULL for platform-level actions
  actorUserId String?
  actorType   ActorType
  impersonatorUserId String?                            // super-admin impersonation (reused pattern)
  action      AuditActionType
  entityType  String
  entityId    String
  before      Json?
  after       Json?
  diffJson    Json?
  ipAddress   String?
  userAgent   String?
  requestId   String?                                   // trace correlation
  reason      String?                                   // for sensitive ops (salary view, payslip reissue)
  createdAt   DateTime @default(now())
  @@index([businessId, entityType, entityId])
  @@index([businessId, actorUserId, createdAt])
  @@index([businessId, action, createdAt])
}

enum ActorType { EMPLOYEE HR_ADMIN PAYROLL_MANAGER SUPER_ADMIN SYSTEM API_CLIENT }
enum AuditActionType {
  CREATE UPDATE DELETE VIEW_SENSITIVE EXPORT
  LOGIN IMPERSONATE_START IMPERSONATE_END
  PAYRUN_LOCK PAYRUN_APPROVE PAYSLIP_PUBLISH PAYSLIP_REISSUE
  APPROVE REJECT STATUTORY_FILE RULE_PUBLISH COMP_REVISE
}
```

We log **VIEW_SENSITIVE** on salary/PII reads and **EXPORT** on data extracts — required for both IN wage-register audit trails and NZ privacy obligations.

### 19.2 `Notification`

Reuses Sitepresso's notification substrate (`InboxNotification` line 2397, `NotificationConfig` line 2848, `MessageTemplate` line 2899, `MessageDelivery` line 2943). HR adds event types.

```prisma
model Notification {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  recipientUserId String
  type        NotificationType
  channel     NotificationChannel
  title       String
  body        String?  @db.Text
  dataJson    Json?
  entityType  String?
  entityId    String?
  readAt      DateTime?
  sentAt      DateTime?
  status      DeliveryStatus @default(QUEUED)
  createdAt   DateTime @default(now())
  @@index([businessId, recipientUserId, readAt])
  @@index([businessId, type, createdAt])
}

enum NotificationType {
  PAYSLIP_PUBLISHED LEAVE_REQUESTED LEAVE_APPROVED LEAVE_REJECTED
  EXPENSE_SUBMITTED EXPENSE_APPROVED LOAN_APPROVED APPROVAL_PENDING
  DOC_EXPIRING BIRTHDAY ANNIVERSARY REVIEW_DUE TIMESHEET_DUE
  STATUTORY_DUE ONBOARDING_TASK OFFBOARDING_TASK ASSET_RETURN_DUE
}
enum NotificationChannel { IN_APP EMAIL SMS WHATSAPP PUSH }
enum DeliveryStatus      { QUEUED SENT DELIVERED FAILED READ }
```

### 19.3 `NumberSequence` — tenant-safe human codes

Backs every `code` field. Per-tenant (or per-entity) counters under advisory lock; mirrors Sitepresso's `InvoiceCounter` (line 1877) but generalized.

```prisma
model NumberSequence {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?
  scope       String                                    // "EMPLOYEE","PAYRUN","EXPENSE","LOAN"...
  prefix      String                                    // "EMP-","PR-"
  nextValue   Int      @default(1)
  padding     Int      @default(6)
  periodKey   String?                                   // optional yearly reset "2026-27"
  updatedAt   DateTime @updatedAt
  @@unique([businessId, entityId, scope, periodKey])
}
```

---

## 20. Indexing, partitioning & performance strategy

| Concern | Strategy |
|---|---|
| Tenant cut | Every index **leads with `businessId`** (then `entityId` where applicable). Matches Sitepresso convention (`@@index([businessId, ...])` throughout). |
| Hot payroll path | `PayRunLine @@unique([payRunId, employeeId])`; `PayRunLineComponent @@index([businessId, payRunLineId])`. Compute writes are bulk `createMany` inside one transaction per pay run. |
| Time-series growth | `AttendancePunch`, `LeaveTransaction`, `AuditLog`, `PayRunLineComponent`, `Notification` are the high-volume tables. Plan **monthly range partitioning** by `createdAt`/`punchAt`/`payDate` at scale (Postgres declarative partitioning); Prisma sees the parent table. Until then, BRIN indexes on the timestamp columns. |
| Effective-date lookups | Partial/covering indexes on `isCurrent = true` for `EmploymentRecord`, `CompensationRevision`; `@@index([... effectiveFrom])` for range scans. |
| Statutory dunning | `StatutoryRemittance @@index([businessId, status, dueDate])` powers the "what's overdue" cron. |
| Reporting | `PayRunLine` carries denormalized statutory rollups (pf/esi/tds/paye/kiwisaver…) so monthly compliance reports avoid re-aggregating components. |
| Read replicas | Reporting/analytics queries hit a replica (reuse Sitepresso's DB topology, see `01-architecture.md`). Payroll compute is primary-only. |
| Soft-delete filtering | Prisma middleware appends `deletedAt: null` by default; explicit opt-in for historical/statutory reads. |

---

## 21. Cross-cutting validation & integrity rules (summary)

1. **Tenant isolation:** no HR query without `businessId`; FK cascade + middleware + CI lint (three layers).
2. **Currency consistency:** a `PayRunLine`'s `currencyCode` must equal its `Entity.payCurrency`; no mixed-currency payslip.
3. **Effective-date non-overlap:** for `EmploymentRecord` and `CompensationRevision`, exactly one `isCurrent` per employee; ranges must not overlap (service-layer assert + `@@unique([employeeId, effectiveFrom])`).
4. **Locked immutability:** `PayRun ≥ LOCKED` ⇒ child lines/payslips read-only; corrections via `CORRECTION` child run only.
5. **Compliance reproducibility:** every computed `PayRun` stamps `complianceVersionId`; reruns must resolve the same version.
6. **Leave balance conservation:** `closing = opening + accrued − taken − encashed − lapsed + adjusted`; `pendingApproval` never double-spent (optimistic `version`).
7. **IN 50% rule:** structure activation blocked unless Basic+DA ≥ 50% of total or auto-reattribution accepted.
8. **NZ minimum wage:** structure save warns if implied hourly < $23.95 (adult) / $19.16 (starting-out/training) from 1 Apr 2026.
9. **KiwiSaver age gate:** employer contribution requires age ∈ [16, 65] from 1 Apr 2026 (engine reads `dateOfBirth`).
10. **Statutory retention:** Employee/Payslip/statutory rows are soft-delete only; anonymise PII, keep `@retain:statutory` (IN wage registers; NZ 7-year IRD/Holidays Act records).
11. **Separation gating:** cannot finalize `TERMINATED` with open loans/leave-encashment/asset recovery unresolved without an FNF run or explicit waiver.
12. **Audit completeness:** salary views, exports, payslip reissues, rule publishes, and impersonation all emit `AuditLog` rows.

---

## 22. Open questions for the founder (data-model scope)

- **O-1 (entity vs business cardinality):** Confirm a single tenant (`Business`) can hold multiple `Entity` rows across IN **and** NZ under one plan, vs forcing one tenant per country. The model assumes multi-entity, multi-country per tenant. Affects billing seat counting (`10-superadmin-billing.md`).
- **O-2 (biometric/selfie attendance):** Do we store biometric templates / punch selfies (`AttendancePunch.selfieUrl`) at all? IN DPDP + NZ Privacy Act make this `@pii:sensitive` with consent. Recommend off-by-default, plan-gated.
- **O-3 (Form 16 vs Form 130):** 2026 sources suggest IN Form 16 may be renamed/restructured ("Form 130") under the Income Tax Act 2025. `RemittanceKind.IN_FORM16` is a placeholder; confirm final nomenclature before GA filing module ships.
- **O-4 (NZ payroll frequency):** Many NZ employers pay fortnightly/weekly; IN is monthly. Confirm we support per-entity `PayFrequency` at launch (modeled yes) including fortnightly payday filing within 2 working days.
- **O-5 (multi-account salary split):** Keep `BankAccount.splitPercent` for split disbursement at launch, or defer? Modeled but optional.
- **O-6 (retention windows):** Confirm exact statutory retention per artifact — IN wage/attendance registers under Code on Wages rules vs NZ 7-year — to parameterize the anonymisation cron precisely.
- **O-7 (gratuity provisioning):** Accrue `GRATUITY_PROVISION` monthly as employer cost (modeled) vs compute only at exit? Monthly provisioning is the premium choice but adds GL volume.

---

## 23. Dependencies on sibling docs

- `01-architecture.md` — service boundaries, DB topology (primary/replica), object storage for documents/payslip PDFs, async compute queue for `PayRun`.
- `02-tenancy-rbac.md` — Prisma tenant-filter middleware, `BusinessRole`/permission catalog the HR roles bind to, impersonation context that `AuditLog.impersonatorUserId` records.
- `04-payroll-engine.md` — the computation graph that reads this schema (compensation → components → statutory) and writes `PayRunLine`/`PayRunLineComponent`/`Payslip`; consumes `ComplianceRuleVersion`.
- `05-compliance-IN.md` / `06-compliance-NZ.md` — full per-domain `rulesJson` schemas, IN PT state matrix, NZ Holidays Act RDP/ADP/AWE algorithms, filing file formats (ECR, Form 24Q, payday CSV).
- `07-leave-attendance.md` — accrual cron logic, NZ weeks↔money valuation, attendance derivation rules.
- `09-api-surface.md` — REST/GraphQL surface over these models, including ESS write endpoints and validation.
- `10-superadmin-billing.md` — plan/feature gating (`Business.featureFlags`, `TierFeature`) that toggles HR modules; seat counting per `Employee`/`Entity`.

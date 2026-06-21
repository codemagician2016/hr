# 07 — Core HR Module (Organization, Employee Master, Lifecycle, Documents, Bulk I/O)

**Product:** Multi-tenant, white-label HRMS & Payroll SaaS ("the platform").
**Author role:** Senior HR Domain Analyst.
**Status:** Production-grade functional specification (NOT an MVP). Forks the live Sitepresso platform at `/Users/kp/sitepresso` (READ-ONLY base).
**Launch markets:** India (IN, INR) and New Zealand (NZ, NZD). Tax year **Apr–Mar** in both.
**Last reviewed against 2026 compliance facts:** 2026-06-22.

> **Cross-references (sibling docs, same `/Users/kp/docs` folder):**
> - `00-vision-and-principles.md` — "pre-built system, not a builder" constitution.
> - `01-product-requirements.md` — surfaces, personas, plan tiers, feature flags.
> - `02-system-architecture.md` — monorepo layout, tenant resolution, RBAC, queues, residency.
> - `04-payroll-engine-design.md` — pay-run state machine, component/base model, compliance rule tables.
> - `05-attendance-leave-and-holidays-act.md` *(planned)* — attendance, leave ledger, NZ Holidays Act calc.
> - `05-compliance-IN.md` / `06-compliance-NZ.md` *(planned)* — versioned statutory rule tables.
> - `08-security-and-audit.md` *(planned)* — audit log, impersonation, data residency.
> - `09-onboarding-wizard.md` / `10-ess-and-mobile.md` *(planned)* — company setup, ESS.
>
> **This doc is the Core HR functional spec.** It owns the entities every other module reads:
> the org structure, the employee master, the lifecycle state machine, the document vault, and bulk I/O.
> Payroll (`04`), attendance/leave (`05`), and ESS (`10`) all *consume* the records defined here.

---

## 0. Scope, stance, and non-negotiables

This module is the **system of record for "who works here, in what shape, and in what state."** Everything downstream — a pay run, a leave accrual, a payslip, a statutory return, an offer letter — resolves against the entities defined here. If this layer is sloppy (mutable history, ambiguous effective dates, free-text designations), every downstream number becomes unprovable. So this spec is deliberately strict.

**Design tenets (binding; deviate only with an ADR):**

1. **Configure, never build.** Per the platform constitution (`00-vision-and-principles.md`), tenants configure *data + settings + plan flags*. There is no field designer, no custom-object builder, no layout editor. The employee profile shape is **fixed by us**; tenants toggle which sections are visible/required via plan flags and a small set of org-policy switches, and may add a bounded set of **custom fields** from a *typed, pre-defined catalogue* (see §3.7) — not an open schema.
2. **History is append-only; the "current" view is a projection.** Comp, designation, grade, department, location, manager, and employment status are **effective-dated records**, never overwritten columns. "What was this person's CTC on 2025-09-01?" must be answerable forever. A `currentXxx` denormalized pointer exists only as a read cache, rebuilt from history.
3. **Effective dates are first-class and timezone-anchored.** Every lifecycle event carries an `effectiveDate` (a calendar date in the **employee's work location timezone**, not the server's). Payroll, leave, and tenure derive from these dates. We store dates as `DATE` (no time) for HR events; instants (`createdAt`) are separate audit metadata.
4. **Tenant isolation by `businessId`, inherited verbatim from Sitepresso.** Every HR row carries `businessId`; every query is filtered by the ambient tenant. Grounded in `backend/src/core/middleware/requireBusiness.js` and the `businessId`-on-every-model pattern in `backend/prisma/schema.prisma` (e.g. `model BusinessLocation`, `model BusinessRole`). We do **not** spin a DB per tenant.
5. **Multi-entity from day one.** A tenant ("Business" in the inherited schema) may operate **multiple legal entities** (e.g. an Indian Pvt Ltd + an NZ Limited company). The legal entity — not the tenant — is the unit of statutory registration (PF/ESI/PAN/TAN in IN; IRD number in NZ) and the unit of a pay run. This is the single biggest structural addition over Sitepresso, whose `Business` is a single legal unit.
6. **Soft-delete + restore + purge, mirroring Sitepresso's account-audit pattern.** No hard deletes of an employee with payroll history. We mirror `AccountAuditLog`'s `*_DELETE_REQUESTED → *_DELETE_UNDONE → *_PURGED` lifecycle (`backend/prisma/schema.prisma`, `model AccountAuditLog`) so a wrongly-terminated record can be undone, and a genuine GDPR/Privacy-Act erasure leaves a forensic stub.
7. **Every mutation is audited.** Reuse the audit-log discipline already in the base (`AccountAuditLog`, `PricingAuditLog`). Every create/update/state-transition on org or employee data writes an `HrAuditLog` row with before/after diff, actor, IP, and reason.

**Out of scope here (owned elsewhere):** payroll computation & components (`04`), attendance/shifts/leave ledger & Holidays Act math (`05`), statutory rule tables & rates (`05-compliance-IN`/`06-compliance-NZ`), billing/seats/plans (`07-billing` per `02`'s numbering), notifications transport (`08`). This doc *references* those; it does not define them.

---

## 1. Reuse map (real Sitepresso paths)

| Concern | Reuse from Sitepresso (`/Users/kp/sitepresso`, READ-ONLY) | New / changed for HR |
|---|---|---|
| Tenant row-isolation | `backend/src/core/middleware/requireBusiness.js`; `requireVertical.js`; every model has `businessId` in `backend/prisma/schema.prisma` | Every HR model carries `businessId`; add `legalEntityId` for statutory scoping |
| Locations | `model BusinessLocation` (`backend/prisma/schema.prisma`, ~L3636) — name/address/`isPrimary`/`isActive`, `@@index([businessId, isActive])` | Extended into `WorkLocation` with timezone, statutory registration links, holiday-calendar binding |
| Roles / RBAC | `model BusinessRole` (`schema.prisma` ~L3609) `isSystem` pre-seeded roles + relational grants; `backend/src/core/middleware/auth.middleware.js` (JWT) | HR roles: `HR_ADMIN`, `HR_MANAGER`, `RECRUITER`, `PAYROLL_PREPARER`, `PAYROLL_APPROVER`, `MANAGER` (line manager), `EMPLOYEE`; field-level visibility scopes |
| Audit log | `model AccountAuditLog` (`schema.prisma` ~L5757) — event/target snapshot, IP/UA, soft-delete lifecycle; `model PricingAuditLog` | `HrAuditLog` (before/after JSON diff, reason, actor) |
| File storage | `backend/src/core/lib/s3.js` (S3/R2-compatible, CloudFront/R2 public base, `ap-south-1` default); `backend/src/core/controllers/upload.controller.js` + `routes/upload.routes.js` | Document vault: **private** bucket, presigned GET, server-side encryption, virus scan, expiry index |
| Bulk import | `backend/src/shop/controllers/ecomBulk.controller.js` — CSV-as-JSON, row-cap, job rows, Zod validation, `productBrandImport` resolver | `EmployeeImportJob` (async, BullMQ per `02` §7), dry-run + commit, per-row error report |
| Data export | `backend/src/core/controllers/dataExport.controller.js` — GDPR Art.20 / NZ Privacy IPP6 portable JSON, parallel reads, excludes other tenants | Employee data export (per-employee subject-access + tenant-wide export) |
| Sequence counters | `model InvoiceCounter { series @id, lastValue }` (`schema.prisma`) | `EmployeeCodeCounter` per (legalEntity, series) for collision-free employee numbers |
| Admin shell / tables | `packages/admin-core`, `packages/ui` | HR console (`apps/hr-admin`) screens reuse table/filter/drawer primitives |
| Notifications | `backend/src/core/controllers/notification*.controller.js`, `notificationConfig` | Document-expiry reminders, probation-end nudges, lifecycle emails |
| i18n | `backend/src/i18n/translator.js` (en/hi) | Field labels, lifecycle copy localized (en, hi; NZ en) |

**Database stance:** new HR models live in the same `backend/prisma/schema.prisma` (single schema, single migration stream) under a clearly-commented `// ====== HR CORE ======` band, exactly as Sitepresso bands its verticals (`// ── ECOMMERCE Path B …`). They reuse `Business` (= tenant) as the isolation root and add a `LegalEntity` layer beneath it.

---

## 2. Organization setup

The org structure is a **layered, effective-dated hierarchy**. A tenant configures it once during onboarding (`09-onboarding-wizard.md`) and maintains it thereafter. Order of dependency (each requires the prior): **Tenant → Legal Entity → Work Location → Department → Designation → Grade → Cost Center**, with the **Org Chart** as a derived projection and **Holiday Calendars** bound per location.

### 2.1 Entity-relationship overview

```
Business (tenant, inherited)
└─ LegalEntity (1..N)            ── PAN/TAN/PF/ESI code (IN) | IRD/NZBN (NZ), base currency, statutory year
   ├─ WorkLocation (1..N)        ── address, timezone, holiday calendar, PF/ESI sub-code, state (for IN PT)
   ├─ Department (tree, 1..N)    ── parent/child, head (employee), cost-center default
   ├─ Designation (1..N)         ── job title, mapped to a Grade
   ├─ Grade / Band (1..N)        ── level, comp band (min/mid/max), leave policy default
   ├─ CostCenter (1..N)          ── code, GL mapping, owner
   └─ HolidayCalendar (1..N)     ── per location/region; public + restricted holidays, year-scoped
Employee (1..N, belongs to exactly one LegalEntity at a time; assignment is effective-dated)
```

### 2.2 Legal Entity

The legal entity is the **statutory and payroll unit**. A tenant with offices in Bengaluru and Auckland has **two** legal entities (IN + NZ) under one `businessId`; a pay run, a Form 24Q, an IRD EI return, a PF ECR, and a bank-advice file are all scoped to **one** legal entity.

| Field | Type | Req | Notes / validation |
|---|---|---|---|
| `id` | uuid | auto | PK |
| `businessId` | uuid | yes | tenant FK (isolation root) |
| `legalName` | string(200) | yes | registered name |
| `displayName` | string(120) | yes | shown in UI/payslip |
| `country` | enum `IN`/`NZ` | yes | drives compliance module & currency; immutable after first pay run |
| `baseCurrency` | enum `INR`/`NZD` | yes | derived from country, locked |
| `statutoryYearStartMonth` | int | yes | fixed **4** (Apr) for both markets; stored for future markets |
| `registrationNumbers` | JSON | cond | **IN:** `pan`, `tan`, `cin`, `gstin?`, `pfEstablishmentCode?`, `esiCode?`, `ptRegistrationByState{}`, `lwfByState?`. **NZ:** `irdNumber`, `nzbn?`, `accClassificationUnit?` (CU code for ACC levy). Validated by country-specific format rules (§2.2.1). |
| `registeredAddress` | JSON | yes | line1/2/city/state/postal/country |
| `signatory` | JSON | yes | authorised signatory name/designation (for Form 16/payslip/offer letters) |
| `logoAssetId` | uuid? | no | overrides tenant brand for this entity's letters/payslips |
| `status` | enum | yes | `ACTIVE` / `SUSPENDED` / `CLOSED` |
| `createdAt`/`updatedAt` | datetime | auto | |

**2.2.1 Registration-number validation (hard rules):**

- **IN PAN:** `^[A-Z]{5}[0-9]{4}[A-Z]$`, 4th char must be `C` (company) / `P` / `H` / `F` etc.; reject if 4th char inconsistent with entity type.
- **IN TAN:** `^[A-Z]{4}[0-9]{5}[A-Z]$`.
- **IN GSTIN:** `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`; first two digits = state code, cross-checked against `registeredAddress.state`.
- **IN PF code:** region/office/establishment/extension format (e.g. `KN/BNG/0012345/000`); free-form but length-bounded; required before first PF-bearing pay run (enforced by payroll, not here).
- **NZ IRD number:** 8–9 digits, validated by the **IRD modulus-11 checksum** (weighting `[3,2,7,6,5,4,3,2]`, with secondary weighting if first check fails). Reject invalid checksums at save.
- **NZ NZBN:** 13 digits, GS1 GTIN-13 checksum.

> **Edge case — country immutability:** once any pay run exists for the entity, `country`/`baseCurrency` are locked. A tenant that "set up the wrong country" with no pay runs may switch; otherwise they must create a new entity and migrate employees (a guided transfer flow, §5.4).

### 2.3 Work Location

Forks `model BusinessLocation` (`backend/prisma/schema.prisma`) and extends it for HR/payroll needs. The key additions over the inherited model are **timezone** (every effective date and attendance punch is anchored here), **statutory sub-registration** (PF/ESI region, IN state for Professional Tax), and **holiday-calendar binding**.

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | auto | |
| `businessId` / `legalEntityId` | uuid | yes | isolation + statutory scope |
| `name` | string(120) | yes | "Bengaluru HQ", "Auckland CBD" |
| `code` | string(20) | yes | unique per entity; used in employee code prefixes |
| `addressLine1/2`, `city`, `state`, `postalCode`, `country` | string | yes | reused shape from `BusinessLocation` |
| `timezone` | IANA TZ | yes | e.g. `Asia/Kolkata`, `Pacific/Auckland`; **drives all date anchoring** |
| `inState` | enum (IN states) | cond | required when `country=IN`; drives **Professional Tax** slab & **LWF** applicability |
| `pfSubCode` / `esiSubCode` | string? | no | sub-establishment codes if location files separately |
| `accClassificationUnit` | string? | no | NZ ACC CU at location granularity if differs |
| `holidayCalendarId` | uuid | yes | FK → HolidayCalendar (§2.8) |
| `isPrimary` | bool | yes | one per entity; reused from base |
| `isActive` | bool | yes | reused; inactive locations reject new assignments |
| `geofence` | JSON? | no | lat/lng/radius for attendance (consumed by `05`) |

**Validation:** exactly one `isPrimary` per legal entity; `inState` mandatory for IN; cannot deactivate a location with active employees assigned (must transfer them first).

### 2.4 Department (tree)

Departments form a **closure-table-backed tree** (not adjacency-only) so "all employees under Engineering incl. sub-teams" is a single indexed query.

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | auto | |
| `businessId`/`legalEntityId` | uuid | yes | |
| `name` | string(120) | yes | unique among siblings under same parent |
| `code` | string(20) | yes | unique per entity |
| `parentId` | uuid? | no | null = top-level; cycle-detection on save |
| `headEmployeeId` | uuid? | no | department head; must be an active employee in same entity |
| `defaultCostCenterId` | uuid? | no | inherited by new hires unless overridden |
| `isActive` | bool | yes | |

A separate `DepartmentClosure { ancestorId, descendantId, depth }` table maintains transitive paths; rebuilt on reparent. **Edge cases:** reparenting recomputes closure for the whole subtree; deleting a department with descendants or assigned employees is blocked (must reassign first); a department head who leaves triggers a "head vacant" task, not a cascade.

### 2.5 Designation

Job titles. Each designation **maps to exactly one Grade** (so comp banding and policy defaults flow through). Designations are *not* free text — they are a configured list; an employee's title must be a designation row.

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | auto | |
| `businessId`/`legalEntityId` | uuid | yes | |
| `title` | string(120) | yes | "Senior Software Engineer" |
| `code` | string(20) | yes | unique per entity |
| `gradeId` | uuid | yes | FK → Grade |
| `isPeopleManager` | bool | yes | gates manager-dashboard access for holders |
| `isActive` | bool | yes | inactive → not selectable for new assignments, existing keep it |

### 2.6 Grade / Band

The comp & policy spine. Grades carry a **compensation band** (min/mid/max, per currency) used to validate salary offers/revisions (§5.5), and **default leave/benefit policy** pointers.

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | auto | |
| `businessId`/`legalEntityId` | uuid | yes | |
| `name` | string(60) | yes | "L4", "Band C", "Manager-II" |
| `level` | int | yes | ordinal for ranking/approval routing |
| `bandMinMinor` / `bandMidMinor` / `bandMaxMinor` | bigint | no | minor units (paise/cents) per `04` money discipline; `min<=mid<=max` |
| `currencyCode` | enum | yes | must equal entity base currency |
| `defaultLeavePolicyId` | uuid? | no | consumed by `05` |
| `defaultSalaryStructureId` | uuid? | no | consumed by `04` |
| `noticePeriodDays` | int | yes | default notice for this grade (overridable on employee) |
| `probationMonths` | int | yes | default probation length |
| `isActive` | bool | yes | |

### 2.7 Cost Center

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | auto | |
| `businessId`/`legalEntityId` | uuid | yes | |
| `name` | string(120) | yes | |
| `code` | string(20) | yes | unique per entity; appears on payroll GL postings |
| `glAccountCode` | string(40)? | no | maps to tenant's accounting system (consumed by `04` GL export) |
| `ownerEmployeeId` | uuid? | no | budget owner |
| `isActive` | bool | yes | |

An employee's cost center is **effective-dated** (a transfer can move their cost allocation mid-year; payroll splits the month by effective date). Future-proofing: a `CostCenterAllocation` join supports **split allocation** (e.g. 60/40 across two CCs) — modeled now, enforced when finance needs it.

### 2.8 Holiday Calendar (per location/region)

Public-holiday sets differ by **country, state/region, and year**. NZ has national + regional anniversary days; India has central + state + optional "restricted" holidays (employee picks N of M). Calendars are **year-scoped** and **versioned** so historical pay runs reproduce the holidays they actually used.

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | auto | |
| `businessId`/`legalEntityId` | uuid | yes | |
| `name` | string(120) | yes | "NZ — Auckland 2026", "IN — Karnataka FY2026-27" |
| `country` | enum | yes | |
| `region` | string? | cond | NZ region (for anniversary day) / IN state |
| `year` | int | yes | statutory year start (Apr); a calendar spans Apr–Mar |
| `status` | enum | yes | `DRAFT` / `PUBLISHED` / `ARCHIVED` |

`HolidayEntry` rows: `{ calendarId, date, name, type: PUBLIC|REGIONAL_ANNIVERSARY|RESTRICTED_OPTIONAL|COMPANY, isMandatory, restrictedQuota? }`.

**Seeding:** Super Admin maintains **country master holiday templates** (versioned, in the compliance rule space per `05-compliance-IN`/`06-compliance-NZ`); a tenant clones a template into a tenant-owned calendar and edits company-specific days. **Restricted-holiday logic (IN):** an employee may select up to `restrictedQuota` (e.g. 2) optional holidays per year; selections live on the employee, consumed by `05`. **NZ Mondayisation:** when a public holiday (e.g. Waitangi Day 6 Feb, ANZAC Day 25 Apr, Christmas/Boxing/New Year) falls on a weekend, the observed day shifts to the following Monday/Tuesday per the Holidays Act 2003 — the seed template encodes both the **actual** and **observed** dates; payroll/leave (`05`) use the observed date for public-holiday pay.

### 2.9 Org Chart (derived projection)

The org chart is **not stored as its own structure** — it is a *projection* over two independent hierarchies:

1. **Reporting hierarchy** — `Employee.currentManagerId` chains (the "who do I report to" graph; can differ from department tree, e.g. a matrix/dotted-line manager via `secondaryManagerId`).
2. **Department hierarchy** — the `Department` tree (§2.4).

The chart screen renders the reporting graph with department/designation overlays. **Cycle prevention:** assigning a manager runs a path check (A cannot report to someone in A's own reporting subtree). **Vacancy nodes:** open positions (from headcount/requisition, future module) render as ghost nodes. **Export:** PNG/SVG + CSV (`employeeCode, name, designation, managerCode, department`). API: `GET /api/hr/org-chart?rootEmployeeId=&depth=&asOf=YYYY-MM-DD` returns the chart **as of a date** (using effective-dated manager history).

---

## 3. Employee management & rich profile

### 3.1 The Employee aggregate

The `Employee` is the central aggregate. Its **identity columns are stable**; its **mutable attributes are effective-dated assignments** (§3.4). A denormalized `current*` snapshot is maintained for list/search performance and rebuilt from assignment history on any change.

**Identity & core (stable):**

| Field | Type | Req | Notes / validation |
|---|---|---|---|
| `id` | uuid | auto | internal PK |
| `businessId` | uuid | yes | tenant isolation |
| `legalEntityId` | uuid | yes | current entity (effective-dated history in `EmploymentAssignment`) |
| `employeeCode` | string(20) | yes | human-facing ID; unique per legal entity; generated via `EmployeeCodeCounter` (reuses `InvoiceCounter` pattern) or manual; immutable once a pay run references it |
| `userId` | uuid? | no | FK → inherited `User` for ESS login; null until invited |
| `firstName` / `middleName?` / `lastName` | string | yes/no/yes | unicode; trimmed; ESS display name = derived |
| `preferredName` | string? | no | |
| `dateOfBirth` | date | yes | must be ≥ 14y before `dateOfJoining` (IN child-labour floor); warn if <18 (minor-employment rules) |
| `gender` | enum | yes | `MALE`/`FEMALE`/`OTHER`/`UNDISCLOSED` (statutory returns require it) |
| `personalEmail` | email | cond | required to send ESS invite if no work email |
| `workEmail` | email | no | unique per tenant if present |
| `mobile` | E.164 | yes | country-validated; primary for OTP (reuses `otp.controller.js`) |
| `photoAssetId` | uuid? | no | private bucket |
| `nationality` | ISO-3166 | yes | drives NZ visa-requirement logic (§6.4) |
| `bloodGroup` | enum? | no | optional (emergency) |
| `maritalStatus` | enum? | no | |

**Employment core (current snapshot; history in §3.4):**

| Field | Type | Req | Notes |
|---|---|---|---|
| `dateOfJoining` | date | yes | tenure & gratuity/leave anchor; immutable after first pay run |
| `employmentType` | enum | yes | `PERMANENT` / `FIXED_TERM` / `PROBATION` / `INTERN` / `CONTRACTOR` / `PART_TIME` / `CASUAL` (NZ) |
| `workerCategory` | enum | yes | `WORKER` / `EMPLOYEE` (IN labour-code "worker" vs "employee" distinction matters for OSH/IR coverage) |
| `currentDesignationId` / `currentGradeId` / `currentDepartmentId` / `currentWorkLocationId` / `currentCostCenterId` | uuid | yes | denormalized pointers |
| `currentManagerId` | uuid? | no | reporting line |
| `secondaryManagerId` | uuid? | no | dotted-line/matrix |
| `currentStatus` | enum | yes | lifecycle state (§4) |
| `confirmationDueDate` | date? | cond | = join + grade.probationMonths if PROBATION |
| `noticePeriodDays` | int | yes | default from grade; overridable |
| `lastWorkingDate` | date? | cond | set on resignation/termination |

**Country-specific statutory profile (typed sub-records, not free JSON):**

- **IN (`EmployeeStatutoryIN`):** `pan` (validated, masked at rest), `aadhaarRef` (tokenised — store last-4 + vault token, **never** plaintext Aadhaar; UIDAI compliance), `uan` (12-digit PF Universal Account Number; checksum), `pfNumber`, `esiNumber?`, `pfOptOut` (allowed only if first joined with wages > ₹15,000 and never previously a member), `ptState` (derived from work location), `npsPran?`.
- **NZ (`EmployeeStatutoryNZ`):** `irdNumber` (modulus-11 validated), `taxCode` (enum: `M`, `ME`, `M SL`, `S`, `SH`, `ST`, `SA`, `WT`, `ND` etc.), `kiwiSaverStatus` (`OPTED_IN`/`OPTED_OUT`/`NOT_ELIGIBLE`/`SAVINGS_SUSPENSION`), `kiwiSaverRate` (3% / 4% / 6% / 8% / 10% employee — **default 3%; min rises to 3.5% from 1 Apr 2026**), `esctRate?` (derived, not stored), `studentLoan` (bool + special deduction rate), `accLevyApplicable` (bool).

> **2026 KiwiSaver note (verify in `06-compliance-NZ.md`):** from **1 Apr 2026** the default employee + compulsory employer minimum rises **3% → 3.5%** (then **4% from 1 Apr 2028**), and **16–17-year-olds become eligible for compulsory employer contributions**. The profile stores the *employee's chosen* rate; the *employer compulsory* rate and ESCT are computed by `04`/`06`.

### 3.2 Contact, banking, emergency, dependents (sub-records)

- **Addresses** (`EmployeeAddress`): `type` (`CURRENT`/`PERMANENT`), full address, `isSameAsCurrent` flag. IN HRA computation (`04`) reads metro/non-metro from current address city.
- **Bank accounts** (`EmployeeBankAccount`, effective-dated): **IN:** `accountHolderName`, `accountNumber` (masked), `ifsc` (`^[A-Z]{4}0[A-Z0-9]{6}$`, validated against IFSC master), `bankName` (auto-from-IFSC). **NZ:** NZ account format `BB-bbbb-AAAAAAA-SS` (bank-branch-account-suffix), validated by NZ bank-account modulus check. `isPrimaryDisbursement` (one active). **Edge case:** changing bank details after a pay run is *frozen* but before *disbursement* requires re-approval and re-generation of the bank-advice file (`04`).
- **Emergency contacts** (`EmergencyContact`, 1..N): name, relationship, phones, address.
- **Dependents** (`EmployeeDependent`, 0..N): name, relationship, DOB, `isNominee` (PF/gratuity/insurance nominee), `nominationSharePct` (must sum to 100% per benefit). Drives IN insurance/ESI dependent coverage and gratuity nomination (Form F).
- **Education & experience** (`EmployeeQualification`, `EmployeeExperience`): institution/degree/year; prior employer/title/from-to (prior-service can affect gratuity continuity in transfers — flagged, not auto-computed).

### 3.3 Compensation (effective-dated; owned jointly with `04`)

The **current CTC/salary structure** lives as an effective-dated `CompensationRecord` (the *structure* — components, amounts, currency — is defined by `04`'s salary-structure model; Core HR owns the *assignment timeline* and the *revision history*). See §5.5 for the revision flow. Core HR never computes payroll numbers; it stores the agreed structure and its effective windows.

### 3.4 Effective-dated assignment model (the spine)

Every "current" employment attribute is the *latest non-future* row of an `EmploymentAssignment`:

```
EmploymentAssignment {
  id, businessId, employeeId,
  effectiveFrom (date), effectiveTo (date|null = open),
  legalEntityId, designationId, gradeId, departmentId,
  workLocationId, costCenterId, managerId, secondaryManagerId?,
  employmentType, reason (enum: HIRE|TRANSFER|PROMOTION|DEMOTION|
    REORG|MANAGER_CHANGE|LOCATION_CHANGE|CONVERSION|CORRECTION),
  sourceEventId (FK → lifecycle event that produced it),
  createdBy, createdAt
}
```

- **Invariant:** assignments for one employee are **contiguous and non-overlapping**; closing one opens the next. A future-dated assignment (e.g. promotion effective next month) coexists but is not "current" until its date arrives — a nightly job (BullMQ, `02` §7) promotes future rows and rebuilds `current*` pointers.
- **Corrections vs. changes:** a `CORRECTION` reason rewrites an existing window (audited, requires `HR_ADMIN` + reason); all other reasons create a new window. Payroll already locked against a superseded window is **never** silently altered — corrections flow as arrears (`04` §6.4).

### 3.5 Profile screen (Tenant Admin, `apps/hr-admin`)

Reuses `packages/admin-core` table/drawer/tabs primitives and `packages/ui`. Layout — a fixed, pre-built page (no builder):

- **Header band:** photo, name, employee code, designation, department, status pill, quick actions (Edit, Initiate Transfer/Promotion/Revision/Exit, Send ESS Invite, Impersonate-in-ESS [gated]).
- **Tabs:** Overview · Job & Org · Compensation · Statutory (IN/NZ section by entity) · Bank · Personal · Documents · Lifecycle Timeline · Audit.
- **Lifecycle Timeline:** vertical, effective-dated event feed (hire → confirmation → revisions → transfers → exit) rendered from `EmploymentAssignment` + lifecycle events; each node links to its source record and audit diff.
- **Field-level RBAC:** comp & statutory tabs gated to `HR_ADMIN`/`PAYROLL_*`; line managers (`MANAGER`) see Overview/Job/Org of their reports only (scoped query by reporting subtree). Visibility scopes stored per role (extends `BusinessRole.permissions` JSON pattern).

### 3.6 Search, filter, list

`GET /api/hr/employees` — server-side paginated, filterable by: status, entity, department (incl. subtree via closure), location, designation, grade, manager, employmentType, joining-date range, document-expiry-window, free-text (name/code/email). Sort by code/name/join/tenure. Saved filters per user (reuses admin-core filter-chip pattern). Bulk-select actions: export, bulk transfer, bulk document-request, bulk ESS-invite, bulk status change (gated).

### 3.7 Custom fields (bounded, NOT a builder)

To honor "configure, not build": tenants may add up to **N custom fields** (plan-flag-capped, e.g. 10/25/unlimited by tier) from a **typed catalogue**: `TEXT`, `NUMBER`, `DATE`, `SINGLE_SELECT(options)`, `MULTI_SELECT`, `BOOLEAN`, `EMPLOYEE_REF`, `FILE`. Each definition: `{ key, label, type, options?, required?, section (PERSONAL|JOB|CUSTOM), visibleToEmployee, editableByEmployee, isPII }`. Values stored in a typed `EmployeeCustomFieldValue` table (one row per field, typed columns by type — **not** a free JSON blob, so they're queryable/exportable/validatable). No layout control; custom fields render in a fixed "Additional Information" section. This is the *only* schema extensibility, and it's tightly bounded.

---

## 4. Employee lifecycle state machine

`Employee.currentStatus` is a guarded state machine. Transitions are role-gated, audited (`HrAuditLog`), and many produce an `EmploymentAssignment` row and/or downstream tasks. Lifecycle events are persisted as typed records (`LifecycleEvent { type, effectiveDate, payload, approvals[], status }`) so the timeline and audit are reconstructable.

### 4.1 States

| State | Meaning | Payroll-eligible? | ESS access |
|---|---|---|---|
| `DRAFT` | Created, not yet invited/activated (data entry / pre-boarding) | No | No |
| `PRE_ONBOARDING` | Offer accepted, joining date future; pre-board tasks active | No | Limited (pre-board portal) |
| `ACTIVE_PROBATION` | Joined, on probation | Yes | Yes |
| `ACTIVE_CONFIRMED` | Confirmed permanent | Yes | Yes |
| `ON_LEAVE_LONG` | Long leave (maternity/sabbatical) — still employed | Conditional (per leave type, `05`) | Yes |
| `SUSPENDED` | Disciplinary suspension | Conditional | Restricted |
| `NOTICE_PERIOD` | Resignation/termination accepted; serving notice | Yes | Yes |
| `EXITED` | Last working day passed; FnF pending/in-progress | Final run only | Read-only |
| `FNF_SETTLED` | Full & final completed | No | Read-only (docs) |
| `ARCHIVED` | Retention window active; PII minimization scheduled | No | No |
| `DELETE_REQUESTED` | Soft-delete pending (undo window) | No | No |
| `PURGED` | PII erased; forensic stub only | No | No |

### 4.2 Transition diagram (allowed edges)

```
DRAFT ─────────────────► PRE_ONBOARDING ──► ACTIVE_PROBATION ──► ACTIVE_CONFIRMED
  │                            │                   │  ▲                 │
  │ (direct active hire)       │ (no-show: ABANDON)│  │(extend/fail)    │
  └───────────────────────────┴──────────────────►│  │                 │
                                                   │  └─────────────────┘
ACTIVE_* ──► ON_LEAVE_LONG ──► ACTIVE_*           │
ACTIVE_* ──► SUSPENDED ──► ACTIVE_* | NOTICE_PERIOD│
ACTIVE_* ──► NOTICE_PERIOD ──► EXITED ──► FNF_SETTLED ──► ARCHIVED
                                  │
                  (rehire) EXITED/FNF_SETTLED ──► DRAFT (new tenure, prior-service linked)
ARCHIVED ──► DELETE_REQUESTED ──(undo)──► ARCHIVED
DELETE_REQUESTED ──(purge job, after window)──► PURGED
```

**Guards (selected):** cannot enter `EXITED` with an **open, unapproved leave** or **unreturned company asset** unless overridden with reason; cannot `FNF_SETTLED` until the **final pay run is approved & disbursed** (`04`); cannot `PURGE` while **statutory retention** is unexpired (§7.4) or a **legal hold** is set; `ACTIVE_CONFIRMED` requires a confirmation event.

### 4.3 Onboarding wizard (DRAFT → ACTIVE)

Distinct from the *company* onboarding wizard (`09-onboarding-wizard.md`); this is **per-employee onboarding**. A guided, resumable, multi-step flow (state persisted, like Sitepresso's launch flow `backend/src/core/controllers/launch.controller.js`).

**Steps & gates:**

1. **Identity & job** — names, DOB, contact, entity/location/department/designation/grade, manager, join date, employment type. *Validations:* join date not absurdly past/future (configurable window); designation∈entity; manager not in own reporting subtree.
2. **Compensation** — pick/clone salary structure (from grade default or template, defined in `04`); **IN guard:** validate **Basic+DA ≥ 50% of total remuneration** per the new wage definition (effective **21 Nov 2025**) — block or warn (config) if violated, because it cascades into PF & gratuity bases. **NZ guard:** ≥ adult minimum wage **NZD $23.95/hr** (from 1 Apr 2026) for the contracted hours.
3. **Statutory** — IN: PAN/UAN/Aadhaar-token, PF/ESI applicability (auto: ESI if gross ≤ ₹21,000 & entity has ≥10 employees; PF if wages logic & ≥20 employees), PT state, opt-outs. NZ: IRD number, **tax code**, KiwiSaver enrolment (auto-enrol with opt-out window unless `NOT_ELIGIBLE`), student loan.
4. **Bank** — disbursement account (validated per §3.2).
5. **Documents** — request/upload mandatory docs (offer letter signed, ID proof, prior-relieving letter; **NZ: work-visa evidence if non-citizen/non-resident** — see §6.4 VisaView check).
6. **Pre-board tasks & ESS invite** — assign checklist (IT asset, induction), send ESS invite (reuses invite/OTP flow). Some steps delegable to the employee via the pre-board portal.
7. **Review & activate** — supervisor/HR sign-off → transition to `ACTIVE_PROBATION` (or `ACTIVE_CONFIRMED` if no probation) on the join date.

**Edge cases:** *No-show / offer-declined* → `ABANDONED` terminal sub-state (audited, never billed a seat). *Backdated join* (already worked some days) → allowed with `HR_ADMIN` + reason; flags payroll for arrears in first run. *Future join* → stays `PRE_ONBOARDING`; auto-activates by scheduled job on join date.

### 4.4 Confirmation (probation → confirmed)

- `confirmationDueDate` = join + `grade.probationMonths` (default; overridable). A scheduled reminder (T-30/T-7/T-0) notifies the manager + HR.
- **Confirmation event:** `CONFIRM` (→ `ACTIVE_CONFIRMED`), `EXTEND_PROBATION` (new due date, reason, optional max-extensions cap), or `TERMINATE_PROBATION` (→ `NOTICE_PERIOD`/`EXITED` per probation notice terms).
- Confirmation may carry a **salary revision** (post-probation hike) — runs the revision sub-flow (§5.5) atomically.
- **Edge case:** *auto-confirm policy* — tenants may set "auto-confirm if no action by due date + grace" (config); the job records an `AUTO_CONFIRMED` event with system actor.

### 4.5 Transfer

Changes one or more of: location, department, manager, cost center, **or legal entity** (cross-entity = the hard case). Produces a new `EmploymentAssignment` window from `effectiveFrom`.

| Transfer kind | Statutory impact |
|---|---|
| Intra-entity, same country | Cost-center/manager/dept update; PT state may change if location crosses IN states (PT recomputed by `04`) |
| Inter-state (IN) | New **Professional Tax** state slab; possibly new PF/ESI sub-code; LWF applicability change |
| **Inter-entity, same country** | New `employeeCode` series? (config: keep or reissue); **continuity of service preserved** (gratuity/leave tenure carries) via `priorServiceLink`; statutory IDs (UAN) port |
| **Cross-country (IN↔NZ)** | Treated as **exit from entity A + hire into entity B** with linked tenure; comp re-struck in new currency; new tax identity; old statutory wind-down (FnF-lite). Guided dual-flow (§5.4) |

**Flow:** initiate (HR/manager) → effective date + new assignment fields → approval (target manager + HR) → on effective date, close old window, open new, rebuild `current*`, fire notifications (employee, both managers, IT for asset move). **Edge cases:** future-dated transfer respected by payroll (month split by effective date); transfer during an open pay-run period blocked until run frozen/closed.

### 4.6 Promotion

A promotion changes `designationId` and usually `gradeId` (up a level), often with a salary revision. Modeled as an `EmploymentAssignment` (reason `PROMOTION`) + optional `CompensationRecord` (reason `PROMOTION`). Guards: target designation's grade.level ≥ current; comp (if changed) within new grade band (§5.5). Approval chain: manager → skip-level/HR → (optional) finance for budget. Produces a **promotion letter** (document template, §6.5) and timeline entry.

### 4.7 Salary revision (with full history)

See §5.5 — the canonical revision flow. Promotions, confirmations, and annual cycles all route through it.

### 4.8 Offboarding (exit → clearance → FnF → relieving)

The most consequential lifecycle path; money and statutory finality. Sub-states tracked on an `ExitCase` aggregate.

**4.8.1 Initiation:** `RESIGNATION` (employee-initiated via ESS or HR-entered), `TERMINATION` (employer, with reason category + cause record), `RETIREMENT` (superannuation), `END_OF_FIXED_TERM`, `DEATH`/`DISABLEMENT` (special: IN gratuity payable regardless of 5-yr rule; NZ holiday-pay-on-death rules), `ABSCONDING`. Captures: `resignationDate`, `requestedLastWorkingDate`, `noticePeriodDays`, computed `lastWorkingDate` (= resignation + notice, adjustable with notice buy-out/waiver), reason.

**4.8.2 Notice-period management:** `NOTICE_PERIOD` state. Supports **notice buy-out** (employee pays shortfall — recovery line in FnF) and **notice waiver** (employer waives). Leave-during-notice policy configurable (some tenants disallow consuming leave in notice). Garden leave flag.

**4.8.3 Clearance / exit checklist:** a `ClearanceChecklist` of items by department owner (IT: laptop/access revocation; Finance: advances/loans/expense settlement; Admin: ID card/keys; Manager: handover/knowledge transfer; HR: docs). Each item: `{ owner, status: PENDING|CLEARED|RECOVERY_FLAGGED, recoveryAmountMinor?, note }`. **Asset recovery** flagged items feed FnF as deductions. Gate: cannot move to `EXITED` with non-cleared **blocking** items unless `HR_ADMIN` overrides with reason.

**4.8.4 Full & Final settlement (FnF):** a special **final pay run** in `04`, but Core HR owns the *case* and the *non-payroll inputs*:

- **Earnings:** unpaid salary up to LWD, pending arrears, **leave encashment** (unused leave balance × rule, computed by `05`), pro-rated bonus (per policy), **gratuity** if eligible.
- **Deductions/recoveries:** notice-period shortfall, asset recovery, salary advances/loans outstanding, excess leave taken, statutory dues.
- **IN gratuity:** `= (15/26) × last-drawn-monthly-wages × completed-years` (≥6 months rounds up). Eligibility: **5 years continuous service** for permanent employees (**unchanged** under the new codes); **fixed-term employees now eligible after 1 year** of continuous service (Social Security Code, effective **21 Nov 2025**); waived on death/disablement. "Wages" base uses the new ≥50% definition (effective 21 Nov 2025) — typically larger than legacy basic. Tax-exemption cap & rules per `05-compliance-IN.md`.
- **NZ final pay:** all owed wages + **annual holiday pay** under the Holidays Act 2003 (8% of gross since last anniversary for the current incomplete year, plus any untaken entitled weeks at the greater of ordinary/average weekly pay), alternative (lieu) days payout, and final PAYE/KiwiSaver/ESCT/student-loan via the final payday filing. (Holidays Act math owned by `05`/`06`.)
- **Approval:** preparer → approver (`PAYROLL_APPROVER`) → (optional) head-of-HR sign-off for large settlements. Produces FnF statement (employee-visible), bank advice, and statutory final-period entries.

**4.8.5 Relieving & experience documents:** on `FNF_SETTLED`, auto-generate **relieving letter**, **experience/service certificate**, **Form 16/Form 130** (IN annual TDS cert — *naming verify in `05-compliance-IN.md`*), and **NZ final-pay summary**; deliver to employee (ESS read-only + email). Revoke all access except the read-only document locker.

**4.8.6 Exit interview (optional):** structured questionnaire (fixed templates, not a form builder) feeding attrition analytics; never blocks settlement.

### 4.9 Rehire

`EXITED`/`FNF_SETTLED` → new `Employee` tenure (`DRAFT`) with `priorEmployeeId` link. **Continuity decision** is explicit: *fresh* (new tenure, gratuity/leave clock resets) vs *continuous* (prior service counts — e.g. re-employment after short break; rare, requires `HR_ADMIN` justification). Statutory IDs (UAN/IRD) reused. Re-eligibility checks (blacklist/do-not-rehire flag) enforced.

---

## 5. Compensation & assignment change flows (detail)

### 5.1 Common change-request envelope

All effective-dated changes (transfer/promotion/revision/manager-change) share an envelope: `ChangeRequest { type, employeeId, effectiveFrom, payload, status: DRAFT→PENDING_APPROVAL→APPROVED→APPLIED | REJECTED | CANCELLED, approvals[], appliedAssignmentId? }`. Approvals are a configurable chain (by amount/grade/type). Application is **idempotent** and either immediate (past/today effective) or **deferred** to the effective date by the nightly promoter job.

### 5.2 Approval routing

Routing rules (tenant-configured, bounded — pick from preset chains, not a workflow builder): e.g. *Revision > 20% or above-band* → manager + HR + Finance; *standard transfer* → both managers + HR. Reuses notification + task patterns. SLA reminders escalate.

### 5.3 Manager change & reorg

Bulk manager reassignment (e.g. a team moves under a new lead) is a **batch ChangeRequest** producing N assignment windows in one transaction, with cycle-checks across the batch. Org-chart `asOf` queries reflect history.

### 5.4 Cross-entity / cross-country transfer (guided dual-flow)

Wizard: choose target entity → continuity decision → new comp (new currency, re-struck via `04` template) → new statutory identity → schedule effective date → on date: wind-down source statutory period (mini-FnF if cross-country), open target assignment, port linked tenure. Two `LegalEntity` records, one human, linked timeline.

### 5.5 Salary revision with full history (canonical)

| Field (`CompensationRecord`) | Notes |
|---|---|
| `id`, `businessId`, `employeeId` | |
| `effectiveFrom` / `effectiveTo` | non-overlapping windows (mirror assignment invariant) |
| `salaryStructureId` | FK → `04` structure (components + amounts) |
| `currencyCode` | = entity base currency |
| `ctcAnnualMinor` / `grossMonthlyMinor` | denormalized for reporting |
| `reason` | `HIRE`/`ANNUAL_REVISION`/`PROMOTION`/`CONFIRMATION`/`MARKET_CORRECTION`/`DEMOTION`/`CORRECTION` |
| `revisionLetterAssetId?` | generated document |
| `arrearsFromDate?` | if backdated → first run computes arrears (`04`) |
| `approvedBy`, `approvedAt`, `changeRequestId` | provenance |

**Validations:** new comp within grade band (warn/block above max per config); **IN Basic+DA ≥ 50%** re-checked every revision (it can drift); **NZ ≥ minimum wage**; effective date not inside a *locked/disbursed* pay period (else applies next period + arrears). **History view:** a comp timeline on the profile shows every window, % change, reason, approver, and a diff of the structure. Nothing is ever overwritten — superseded windows get `effectiveTo` set; corrections are explicit `CORRECTION` rows.

---

## 6. Document vault & expiry management

### 6.1 Storage architecture

Reuses `backend/src/core/lib/s3.js` (S3/R2-compatible; supports Cloudflare R2 via `S3_ENDPOINT`, CloudFront/R2 public base) and the upload controller pattern (`backend/src/core/controllers/upload.controller.js`, `routes/upload.routes.js`) — **hardened for HR PII**:

- **Private bucket** (no public URL base; vault objects are never world-readable, unlike the storefront image bucket). Access only via **short-TTL presigned GET** (e.g. 60s), issued after RBAC check.
- **Server-side encryption** (SSE-KMS); **per-tenant key prefix**; object key namespaced `hr/{businessId}/{employeeId}/{docId}`.
- **Region pinning** by entity country (IN → `ap-south-1`/Mumbai; NZ → `ap-southeast-2`/Sydney or NZ region) for data-residency (`02` §residency).
- **Virus/malware scan** on upload (async; quarantine until clean).
- **Content-type allowlist** (PDF/JPG/PNG/DOCX), size cap (e.g. 25 MB), checksum (SHA-256) stored for integrity.
- **Versioning:** new upload to same `DocumentType` creates a new `DocumentVersion`; prior versions retained (audit), current pointer updated.

### 6.2 Document model

```
EmployeeDocument {
  id, businessId, employeeId, legalEntityId,
  documentTypeId (FK → DocumentTypeCatalogue),
  title, fileAssetKey, mimeType, sizeBytes, sha256,
  issuedDate?, expiryDate?, issuingAuthority?, referenceNumber?,
  status: PENDING_UPLOAD | UPLOADED | VERIFIED | REJECTED | EXPIRED | SUPERSEDED,
  verifiedBy?, verifiedAt?, rejectionReason?,
  visibleToEmployee (bool), isStatutoryMandatory (bool),
  uploadedBy, source: HR | EMPLOYEE | SYSTEM_GENERATED,
  createdAt, updatedAt
}
DocumentVersion { id, documentId, fileAssetKey, sha256, uploadedBy, createdAt }
```

### 6.3 Document type catalogue (configured, not built)

Super Admin seeds **country master document types**; tenants enable/disable and mark mandatory. Examples:

| Country | Type | Expiry-bearing | Mandatory default |
|---|---|---|---|
| Both | Signed offer/employment agreement | no | yes |
| Both | Photo ID proof | sometimes | yes |
| Both | Address proof | no | yes |
| Both | Education certificates | no | no |
| Both | Prior relieving/experience letter | no | conditional |
| IN | PAN card | no | yes |
| IN | Aadhaar (tokenised reference only) | no | yes |
| IN | UAN/PF allotment | no | conditional |
| IN | Form F (gratuity nomination) | no | yes |
| IN | Investment proofs (80C/HRA rent) | yes (FY-bound) | seasonal |
| **NZ** | **Work visa / work permit** | **yes (critical)** | **yes (if non-citizen/PR)** |
| NZ | Passport / proof of right to work | yes | yes |
| NZ | IRD number confirmation | no | yes |
| NZ | KiwiSaver opt-out (KS10) | no | conditional |

### 6.4 Expiry reminders — and the NZ work-visa compliance loop (high-value)

Every `expiryDate`-bearing document feeds a **reminder engine** (BullMQ scheduled, `02` §7): reminders at **T-90, T-60, T-30, T-14, T-7, T-1, and T+1 (overdue)** to employee, line manager, and HR (channels per `08-notifications`). A dashboard widget "Documents expiring in 90 days" with filters; bulk re-request action.

**NZ work-visa loop (flagship compliance feature):**

- An employee whose `nationality` ≠ NZ and who is not a permanent resident/citizen **must** have a valid `Work visa` document with an `expiryDate`. The system **blocks activation** (or warns hard, per policy) without it.
- **Verified employer obligation (Immigration Act 2009):** before employing, the employer must check the person can legally work and the **work-related conditions** of their visa (job type, hours, employer). We surface a **VisaView check record** field (`visaViewCheckRef`, `visaViewCheckedAt`, `visaViewResult`) — INZ's VisaView enquiries are **saved as evidence of compliance**; we prompt HR to attach the enquiry reference.
- **Penalties we are protecting tenants from (verified, 2026):** an **infringement notice** of **NZD $1,000 (individual) / $3,000 (body corporate) per breach** for employing someone not entitled to work or outside their visa conditions; serious exploitation carries up to **7 years' imprisonment or NZD $100,000 fine**; offenders can be placed on the **employer stand-down list** (barred from supporting migrant visas for 6+ months). In the scheme's first 2 years (1 Apr 2024–30 Apr 2026), **314 infringement notices** and **>NZD $1,000,000** in penalties were issued — concrete proof this matters.
- **Visa-expiry escalation is stricter:** on visa expiry, the employee's right-to-work lapses; at T-30 the case escalates to HR with a hard task, and on expiry (if unrenewed) the system flags the employee `WORK_RIGHTS_LAPSED`, blocks them from being included in a *new* pay period start, and requires explicit HR override (audited) — preventing the tenant from unknowingly committing an offence.

> *Sources for NZ visa facts:* Immigration NZ VisaView & employer-obligations pages; Immigration Employment Infringement Scheme. (See `06-compliance-NZ.md` for the canonical rule rows.)

**IN parallel:** investment-proof windows (Jan–Mar proof-submission for the Apr–Mar FY) drive seasonal reminders that feed `04`'s tax computation; expiry of contractor agreements (fixed-term) drives renewal/conversion tasks.

### 6.5 System-generated documents (templates, not a builder)

Offer letter, appointment letter, confirmation letter, promotion letter, revision letter, transfer letter, relieving letter, experience certificate, FnF statement, Form 16/130 (IN), NZ final-pay summary. Each is a **fixed, pre-built template** with **merge tokens** (employee/entity/comp fields) + the tenant's brand (logo + one color + one of 5 styles, via slimmed `packages/theme-engine`). Tenants edit **text content of allowed blocks** and signatory — they do **not** design layout. Generated as PDF (server-side), stored as `SYSTEM_GENERATED` documents, e-sign optional (integration hook).

### 6.6 Document APIs

- `POST /api/hr/employees/:id/documents` → returns presigned PUT + creates `PENDING_UPLOAD` record; client uploads direct-to-bucket; `POST .../documents/:docId/complete` finalizes (checksum verify, scan enqueue).
- `GET /api/hr/employees/:id/documents` (filter by type/status/expiry).
- `GET /api/hr/documents/:docId/download` → RBAC check → short-TTL presigned GET.
- `POST /api/hr/documents/:docId/verify` | `/reject` (HR).
- `POST /api/hr/documents/:docId/version` (new version).
- `GET /api/hr/documents/expiring?withinDays=90`.

---

## 7. Data lifecycle: soft-delete, restore, purge, retention

Mirrors Sitepresso's `AccountAuditLog` soft-delete lifecycle (`*_DELETE_REQUESTED → *_DELETE_UNDONE → *_PURGED`, `backend/prisma/schema.prisma`).

### 7.1 Soft-delete & restore
`ARCHIVED → DELETE_REQUESTED` sets a `deleteScheduledAt` (undo window, e.g. 30 days). During the window, `DELETE_UNDONE` restores. Employees with **active payroll history are never hard-deleted** — only PII-minimized at purge.

### 7.2 Purge (PII erasure)
After window + retention clearance + no legal hold, a purge job erases/anonymizes direct PII (name→hash stub, contact nulled, documents shredded) but **retains statutory-required financial/payroll skeletons** (`employeeCode`, entity, pay-run line references, statutory IDs hashed) so historical returns remain valid. Writes an `HrAuditLog`/`AccountAuditLog`-style forensic stub (`originalEmailHash`, `targetSlug`, reason) — reusing the inherited subpoena-response pattern.

### 7.3 Subject access / portability
Per-employee export (NZ Privacy Act IPP6 / IN DPDP Act 2023 / GDPR Art.20 analog) via the `dataExport.controller.js` pattern: portable JSON + document bundle of everything held on that individual.

### 7.4 Statutory retention floors (block purge until expired)
- **IN:** payroll & wage/attendance registers and payslips retained **per state Shops & Establishments rules + the new labour-code digital-register mandate** (commonly 3–8 years; PF/ESI records longer). TDS/Form 24Q & Form 16/130 retained ≥ the assessment-period limitation.
- **NZ:** Holidays Act / Employment Relations Act **wage-and-time and holiday-and-leave records must be kept 6 years**; IRD payroll/PAYE records **7 years**; KiwiSaver records per IRD.
- Exact retention rows live in `05-compliance-IN.md`/`06-compliance-NZ.md`; this module **enforces** them as purge guards.

---

## 8. Bulk import / export

### 8.1 Import (async, validated, reversible)

Forks the bulk pattern in `backend/src/shop/controllers/ecomBulk.controller.js` (CSV→JSON, row-caps, Zod validation, job rows) but **upgrades to a real async job** (BullMQ per `02` §7) given employee-import volume and the cost of a bad row in payroll.

**Flow:** upload CSV/XLSX → **map columns** to fields (saved mappings) → **dry-run validation** (every row checked: required fields, FK existence [entity/dept/designation/grade/location by code], format rules [PAN/IRD/IFSC/email], duplicate detection [by code/email], cross-field rules [IN Basic+DA≥50%, NZ≥min wage]) → **validation report** (downloadable: row#, field, error/warning) → **commit** (only valid rows; partial-commit option) → per-row outcome ledger → **undo** (within window, reverses created rows that have no downstream payroll).

```
EmployeeImportJob {
  id, businessId, legalEntityId, fileAssetKey, columnMapping (JSON),
  status: UPLOADED|VALIDATING|VALIDATED|COMMITTING|COMPLETED|FAILED|UNDONE,
  totalRows, validRows, errorRows, warningRows,
  reportAssetKey, createdBy, createdAt, completedAt
}
ImportRowResult { jobId, rowNumber, status: OK|ERROR|SKIPPED, employeeId?, messages[] }
```

**Caps:** validate up to 50k rows; commit batched in chunks of 500 in transactions. **Templates:** downloadable per-country CSV template with example row + data-dictionary. **Idempotency:** re-uploading the same file (content hash) warns of likely duplicates.

**Importable entities (each with its own template):** organization setup (locations/departments/designations/grades/cost-centers), employees (master + statutory + bank), and bulk salary-revision (effective-dated comp changes), bulk leave-balance opening (handoff to `05`).

### 8.2 Export

Reuses `dataExport.controller.js` parallel-read pattern. **Tenant-wide exports** (employee master, org structure, comp register, document index, statutory-ID register) as CSV/XLSX; **column selection** + **saved views**; **PII-masking option** for non-privileged exporters; every export **audited** (who/what/when/row-count) and large exports delivered async via a download link (presigned, short TTL). Scheduled recurring exports (e.g. monthly headcount to finance) supported via cron pattern (`backend/src/core/lib/scheduler.js` style).

---

## 9. API surface (consolidated)

> All under `/api/hr`, tenant-scoped by ambient `businessId` (`requireBusiness.js`), entity-scoped by `legalEntityId` query/body, RBAC-gated (`auth.middleware.js` + HR role scopes). JSON; cursor pagination; `If-Match`/optimistic-concurrency on mutations; every mutation audited.

**Org setup:** `…/legal-entities` (CRUD), `…/work-locations`, `…/departments` (+ `/reparent`), `…/designations`, `…/grades`, `…/cost-centers`, `…/holiday-calendars` (+ `/entries`, `/publish`, `/clone-template`), `GET …/org-chart`.

**Employee master:** `GET/POST …/employees`, `GET/PATCH …/employees/:id`, sub-resources `/addresses` `/bank-accounts` `/emergency-contacts` `/dependents` `/qualifications` `/statutory-in` `/statutory-nz` `/custom-fields`.

**Lifecycle:** `POST …/employees/:id/onboarding` (+ step PATCHes), `…/confirm`, `…/extend-probation`, `…/transfers`, `…/promotions`, `…/salary-revisions`, `…/exit` (+ `/clearance`, `/fnf-preview`, `/fnf-finalize`), `…/rehire`, `POST …/employees/:id/status` (guarded transition), `GET …/employees/:id/timeline`, `GET …/employees/:id/audit`.

**Change requests:** `GET/POST …/change-requests`, `…/:id/approve|reject|cancel`.

**Documents:** as §6.6. **Bulk:** `POST …/imports` (+ `/validate`, `/commit`, `/undo`, `GET …/imports/:id/report`), `POST …/exports`, `GET …/exports/:id`.

**Read-models for other modules:** `GET …/employees/:id/as-of?date=` (effective-dated snapshot for `04`/`05`), `GET …/payroll-roster?entity=&period=` (active payroll-eligible employees with current comp pointers).

---

## 10. Edge cases & validation catalogue (consolidated)

| # | Scenario | Handling |
|---|---|---|
| 1 | Backdated join after pay run | Allowed (HR_ADMIN+reason); flags arrears in next run (`04`), never silently mutates locked runs |
| 2 | Future-dated promotion/transfer/revision | Stored, not current; nightly promoter applies on effective date; payroll splits month |
| 3 | Manager cycle | Path-check blocks assigning manager within own reporting subtree |
| 4 | Department reparent with subtree | Closure table recomputed transactionally |
| 5 | IN Basic+DA < 50% of remuneration | Block/warn (config) at hire & every revision (effective 21 Nov 2025 wage definition) |
| 6 | NZ pay < $23.95/hr min wage (from 1 Apr 2026) | Block at hire/revision |
| 7 | NZ work visa missing/expired | Block activation / flag `WORK_RIGHTS_LAPSED`; require VisaView ref; prevent inclusion in new pay period |
| 8 | Duplicate employee (code/email/PAN/IRD) | Detected at import & single-create; configurable allow-with-warning |
| 9 | Bank change after freeze, before disburse | Re-approval + regenerate bank advice |
| 10 | Exit with open leave / unreturned asset | Blocked unless HR override (reason); recovery flows to FnF |
| 11 | Gratuity edge: death/disablement | Payable regardless of 5-yr rule; auto-flagged |
| 12 | Fixed-term ≥1yr (post-21-Nov-2025) | Gratuity-eligible; eligibility engine updated |
| 13 | Cross-country transfer | Dual-entity flow; tenure linked; currency re-struck; statutory wind-down |
| 14 | Purge while retention unexpired / legal hold | Blocked by guard (IN registers; NZ 6-yr/7-yr floors) |
| 15 | Rehire continuity | Explicit fresh-vs-continuous decision; UAN/IRD reused |
| 16 | Minor (<18) employment | Warn + restrict hazardous-work designations (OSH code) |
| 17 | Deactivate location/dept with assignees | Blocked; must transfer first |
| 18 | Confirmation due, no action | Reminder cascade; optional auto-confirm with system actor |
| 19 | Aadhaar/PAN at rest | Aadhaar tokenised (never plaintext); PAN masked + access-audited |
| 20 | Concurrent edits to same profile | Optimistic concurrency (`If-Match`/version); last-writer-with-version-check wins, others 409 |

---

## 11. Open questions (for the founder) — see StructuredOutput
## 12. Cross-document dependencies — see StructuredOutput
## 13. Risks — see StructuredOutput

---

*Compliance figures in this document were verified against 2026 sources on 2026-06-22: India new Labour Codes effective 21 Nov 2025 (wage definition Basic+DA ≥ 50%; gratuity 5-yr permanent / 1-yr fixed-term; formula 15/26); NZ KiwiSaver default 3%→3.5% from 1 Apr 2026; NZ adult minimum wage $23.95/hr; NZ Holidays Act 2003 4-weeks/8% (with the Employment Leave Bill reform introduced Mar 2026, ~24-month runway — tracked in `06-compliance-NZ.md`); Immigration NZ employer obligations & VisaView penalties (NZD $1,000/$3,000 infringements; 7yr/$100k exploitation; 314 notices & >$1m in 1 Apr 2024–30 Apr 2026). Canonical rate/threshold rows live in the compliance docs, not here.*

# Feature 04 — Onboarding & Employee Lifecycle

> **Status:** spec / dev contract · **Module:** `backend/src/hr/lifecycle/` (new) · **Apps:** `apps/hr-admin`, `apps/ess`
> **Markets:** India + New Zealand · **Builds on:** F1 RBAC/hierarchy, F2 Attendance, Payroll engine, Recruitment (Offers/ATS)
> **Author note:** every schema field / RBAC key / file path below was verified against the live tree on 2026-06-23. Where the existing code is wrong, it is flagged as a **bug to fix**, not reused.

---

## 1. Summary & goals

DriftHR can hire (`Offer`/`Application` exist; `acceptOffer` flips `Offer→ACCEPTED`, `Application→HIRED`) and can crudely terminate (`POST /employees/:id/terminate` flips a status flag). **Everything between those two points is missing.** There is no onboarding, no provisioning (accepting an offer creates no `Employee`/`User`/role/comp), no separation/FnF logic, no e-sign, and the documents/assets controllers are written against fields that do not exist in the schema (they throw at runtime).

The schema, however, already carries the **nouns**: `SeparationCase` (with every FnF money field), `Offer`, `EmployeeDocument`, `DocumentTemplate`, `Asset`/`AssetAssignment`, `EmploymentRecord`, `EmployeeStatus` (`PRE_HIRE→…→TERMINATED`), `SeparationStatus`/`SeparationType` machines, `PayRunType.FNF`, `NumberSequence`. This feature **adds the verbs**: the onboarding template/instance + checklist layer, an atomic provisioning service, the separation→FnF orchestration, and a simple built-in e-sign.

**Goals (v1):**
1. **Hire → onboard → active** as a tracked pipeline: accept offer → onboarding journey with a checklist → one-click atomic provisioning (`Employee` + portal `User` + `BusinessRole` + manager + compensation + leave) → probation → active.
2. **New-hire self-onboarding (ESS)** before day one: personal/statutory/bank details + document upload + e-sign, scoped strictly to self.
3. **Separate → settle:** initiate separation → exit clearance checklist → compute FnF (gratuity IN / holiday payout NZ / leave encashment / notice recovery / loan & asset recovery) → approve (SoD) → pay via `PayRun(type=FNF)` → relieving/experience letters.
4. **RBAC-correct throughout:** HR manages; managers see **only their reports'** lifecycle tasks (F1 `TEAM` band); a new hire / exiting employee sees **only themselves**.
5. **Simple built-in e-sign** (typed/drawn signature + audit stamp) good enough for offer/contract/policy/letters; vendor envelopes deferred.

**Non-goals (v1):** vendor e-sign adapters (DocuSign/Zoho/Digio); ATS sourcing UX; performance/probation analytics; multi-template-per-stage branching; cross-entity transfer settlement; background-check integrations.

---

## 2. Scope

### In scope (v1 — pragmatic, reuse-first)
- **Reuse as-is:** F1 RBAC (`rbac.js` `PERMISSIONS`/`SYSTEM_ROLES`, `scopeResolver.js`, `scope.middleware.js`), recruitment offer flow (`createOffer`/`sendOffer`/`acceptOffer`, the 50%-wage `offerWageCheck`), payroll engine for the FnF `PayRun`, `NumberSequence` allocator, `Notification` (enum already has `ONBOARDING_TASK`/`OFFBOARDING_TASK`/`ASSET_RETURN_DUE`/`DOC_EXPIRING`), the `WorkflowDefinition/ApprovalRequest` engine for the FnF-approve gate, and all the **existing schema models** (they are production-grade).
- **Fix-before-reuse (real bugs, verified):**
  - `assets.controller.js` references `asset.assetTag` (lines 16/43/77/121) but the schema field is **`Asset.code`** (schema L8362) → Prisma throws `Unknown field assetTag`. Rename throughout.
  - `assets.controller.js` `returnAsset` writes `data.condition` but the fields are `conditionIn`/`conditionOut` (schema L8420-8421); also no `recoveryAmount`/recovery seam. Fix.
  - `documents.controller.js` is written against a **fabricated schema** (`type`/`url`/`fileName`/`fileSize`/`uploadedById`, status `IN_PROGRESS`/`FULFILLED`) — none of those exist. Real `EmployeeDocument` = `category`/`fileUrl`/`name`/`mimeType`/`sizeBytes`/`fileHash`/`documentNumber`/`visibility`/`signatureStatus` (schema L8168-8193). **Rewrite the controller** against the real model; routes/RBAC shape are reusable.
- **Build net-new:** onboarding template/instance + checklist task models (6 models); `provisionEmployee()` orchestrator; separation/FnF service + routes; built-in e-sign (signature capture + audit stamp + PDF re-stamp); ESS self-onboarding wizard, my-tasks, resignation, FnF view; hr-admin pipeline board, template config, provision drawer, separation wizard, letter generator; document upload endpoint writing real `EmployeeDocument` rows.

### Out of scope (deferred, explicitly)
- **Vendor e-sign envelopes** — v1 ships `BUILTIN` only; the `SignatureEnvelope.provider` enum reserves `DOCUSIGN`/`ZOHO_SIGN`/`DIGIO`/etc. for a later additive adapter pass.
- **Presigned-PUT large uploads** — `s3.js` currently exposes only `{ isConfigured, uploadDataUrl, deleteByUrl, parseDataUrl, getPublicUrlPrefix, isOurUrl }` (no presign). v1 uses the existing **base64 data-URL** upload path (≤10 MB cap) via `uploadDataUrl`; `s3.presignPut` is a deferred additive enhancement, not a v1 blocker.
- **Multiple concurrent templates / template versioning UI**, cross-entity transfers, background checks, performance-linked probation scoring.

---

## 3. Data model changes (Prisma — minimal, additive)

> All new models follow the house conventions verified in-schema: denormalized `businessId` (+ `entityId?`) for the scope resolver, `version Int @default(0)`, soft-delete where mutable, `@@unique([businessId, code])` for human codes via `NumberSequence`. **No changes to existing models' columns** except the one already-present hook `Application.convertedEmployeeId` (schema L8664) which we finally start writing.

### 3.1 What already exists (do NOT recreate)
| Concern | Existing model / enum | Schema |
|---|---|---|
| Offer | `Offer` (`status OfferStatus`, `joiningDate`, `grossMonthly`, `currencyCode`, `structureId`, `applicationId`) | L8724 |
| ATS link | `Application.convertedEmployeeId` (NULL today) | L8664 |
| Employee + history | `Employee` (`status EmployeeStatus`, `hireDate`, `probationEndDate`, `terminationDate`, `userId @unique`, `managerEmployeeId`, `currentEmploymentRecordId`, `currentCompensationId`), `EmploymentRecord` (`changeReason EmploymentChangeReason` incl. `HIRE`/`PROBATION_CONFIRM`/`REHIRE`) | L6502, L6618 |
| Separation + FnF | `SeparationCase` (all money fields: `gratuityAmount`, `leaveEncashmentDays/Amount`, `nzHolidayPayoutAmount`, `noticeRecoveryAmount`, `loanForeclosureAmount`, `assetRecoveryAmount`, `netSettlement`, `fnfPayRunId`, `clearanceJson`, `exitInterviewJson`), `SeparationStatus`, `SeparationType` | L8101 |
| Documents | `EmployeeDocument` (`category`, `fileUrl`, `fileHash`, `mimeType`, `sizeBytes`, `documentNumber`, `visibility`, `signatureStatus`, `expiresAt`, `verifiedAt/By`), `DocumentTemplate` (`kind TemplateKind` incl. `OFFER_LETTER`/`RELIEVING_LETTER`/`EXPERIENCE_LETTER`/`FNF_STATEMENT`/`POLICY_ACK`), `DocumentCategory`, `SignatureStatus` (`NOT_REQUIRED`/`PENDING`/`SIGNED`/`DECLINED`/`EXPIRED`) | L8168, L8228 |
| Assets | `Asset` (`code`, `category`, `condition`, `status`), `AssetAssignment` (`conditionOut`/`conditionIn`, `acknowledgmentSignedAt`, `recoveryAmount`, `status`) | L8357, L8410 |
| Payroll | `PayRunType.FNF` | L7176 |
| Codes | `NumberSequence` (`scope`, `prefix`, `nextValue`, `padding`) | L9012 |
| Notifications | `NotificationType.{ONBOARDING_TASK, OFFBOARDING_TASK, ASSET_RETURN_DUE, DOC_EXPIRING}` | — |

### 3.2 New models (the gap)

```prisma
// ── F4 §A — configurable onboarding/offboarding checklist templates ──
enum LifecycleDirection { ONBOARDING  OFFBOARDING }

model LifecycleTemplate {                 // one starter template per direction in v1
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?
  code        String                                  // ONBT-… / OFBT-… (NumberSequence)
  name        String
  direction   LifecycleDirection
  countryCode String?  @db.Char(2)                    // IN / NZ variant
  // Applicability selectors (most-specific wins; NULLs are wildcards)
  departmentId  String?
  designationId String?
  isDefault   Boolean  @default(true)                 // v1: exactly one default per (business,direction)
  isActive    Boolean  @default(true)
  version     Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  taskDefs    LifecycleTaskDef[]
  @@unique([businessId, code])
  @@index([businessId, direction, isActive])
}

model LifecycleTaskDef {                   // the blueprint task (template-level)
  id          String   @id @default(uuid())
  businessId  String
  templateId  String
  template    LifecycleTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  stageKey    LifecycleStage
  taskKey     LifecycleTaskKey?                        // NULL = manual/custom; non-NULL = system-actioned
  title       String
  description String?  @db.Text
  ownerRole   TaskOwner
  taskOrder   Int      @default(0)
  dueOffsetDays Int    @default(0)                     // relative to dueAnchor
  dueAnchor   DueAnchor @default(JOIN_DATE)
  isBlocking  Boolean  @default(true)                  // blocks card→Active / settlement
  isMandatory Boolean  @default(true)
  documentCategory DocumentCategory?                   // upload/verify tasks
  esignTemplateKind TemplateKind?                      // e-sign tasks (offer/contract/policy)
  assetCategory AssetCategory?                         // asset assign/return tasks
  @@index([businessId, templateId, stageKey])
}

enum LifecycleStage {
  // onboarding
  PRE_JOIN  SELF_ONBOARDING  DOCS_ESIGN  PROVISIONING  DAY_ONE  WEEK_ONE  PROBATION
  // offboarding
  SEPARATION_INITIATED  NOTICE  CLEARANCE  ASSET_RETURN  FNF  EXIT_DOCS  POST_EXIT
}

enum TaskOwner { NEW_HIRE  EMPLOYEE  MANAGER  HR  IT  FINANCE  ADMIN }

enum DueAnchor { OFFER_ACCEPT  JOIN_DATE  NOTICE_START  LWD  RELIEVING }

enum LifecycleTaskKey {                     // system-actioned (code knows how to action/verify)
  // onboarding
  COLLECT_PERSONAL  COLLECT_STATUTORY  COLLECT_BANK  COLLECT_EMERGENCY
  UPLOAD_DOCS  ESIGN_OFFER  ESIGN_CONTRACT  ESIGN_POLICIES
  PROVISION_EMPLOYEE  ASSIGN_ASSET  VERIFY_DOCS  PROBATION_REVIEW
  // offboarding
  ACCEPT_RESIGNATION  KNOWLEDGE_TRANSFER  RETURN_ASSET  CLEARANCE_IT
  CLEARANCE_FINANCE  CLEARANCE_ADMIN  COMPUTE_FNF  GENERATE_RELIEVING
  GENERATE_EXPERIENCE  EXIT_INTERVIEW  REVOKE_ACCESS  CUSTOM
}

// ── F4 §B — runtime instance (one per hire / leaver) ──
model LifecycleJourney {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId    String?
  code        String                                  // ONB-000123 / OFB-000045 (NumberSequence)
  direction   LifecycleDirection
  templateId  String?                                 // provenance; tasks are snapshotted in
  // Subject: pre-hire is offer-anchored; post-provision/offboarding is employee-anchored
  offerId      String?  @unique                       // onboarding seeded from accepted Offer
  employeeId   String?                                // set on provision (onboarding) / always (offboarding)
  separationId String?  @unique                       // offboarding ↔ SeparationCase 1:1
  // Anchors for due-date math
  offerAcceptedAt DateTime?
  joinDate        DateTime? @db.Date
  noticeStartDate DateTime? @db.Date
  lastWorkingDay  DateTime? @db.Date
  relievingDate   DateTime? @db.Date
  currentStage    LifecycleStage
  status          JourneyStatus @default(NOT_STARTED)
  // ESS pre-join self-onboarding bucket (staged until provisioning promotes it)
  selfServiceJson Json?                               // {personal,statutory,bank,emergency, completeness:{...}}
  preJoinTokenHash String?                            // hashed magic-link (no portal User yet)
  preJoinTokenExpiresAt DateTime?
  meta        Json?
  version     Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  tasks       LifecycleTask[]
  @@unique([businessId, code])
  @@index([businessId, direction, status])
  @@index([businessId, employeeId])
}

enum JourneyStatus { NOT_STARTED  IN_PROGRESS  BLOCKED  ON_HOLD  COMPLETED  CANCELLED  RESCINDED  NO_SHOW }

model LifecycleTask {                       // materialized per-journey task
  id          String   @id @default(uuid())
  businessId  String
  journeyId   String
  journey     LifecycleJourney @relation(fields: [journeyId], references: [id], onDelete: Cascade)
  taskDefId   String?                                 // provenance (NULL = ad-hoc)
  stageKey    LifecycleStage
  taskKey     LifecycleTaskKey?
  title       String
  ownerRole   TaskOwner
  assigneeEmployeeId String?                          // RESOLVED owner (the actual person)
  assigneeUserId     String?                          // IT/admin who are Users not Employees
  dueDate     DateTime? @db.Date
  isBlocking  Boolean  @default(true)
  isMandatory Boolean  @default(true)
  status      TaskStatus @default(PENDING)
  // bindings to produced/consumed artifacts (audit + dedup)
  employeeDocumentId  String?
  signatureEnvelopeId String?
  assetAssignmentId   String?
  approvalRequestId   String?
  resultJson  Json?
  completedAt DateTime?
  completedByUserId String?
  skippedReason String?
  version     Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([businessId, journeyId, stageKey])
  @@index([businessId, assigneeEmployeeId, status])
  @@index([businessId, status, dueDate])
}

enum TaskStatus { PENDING  IN_PROGRESS  WAITING_APPROVAL  BLOCKED  DONE  SKIPPED  NOT_APPLICABLE  OVERDUE  FAILED }

// ── F4 §C — built-in e-sign (provider-agnostic envelope; v1 = BUILTIN only) ──
model SignatureEnvelope {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeDocumentId String?                          // the doc the signed PDF lands on
  documentTemplateId String?                          // generated-on-the-fly source
  provider    EsignProvider @default(BUILTIN)
  providerEnvelopeId String?                          // external id (vendor adapters; idempotency)
  subject     String
  status      EnvelopeStatus @default(DRAFT)
  finalFileUrl   String? @db.Text                     // re-stamped signed PDF (object storage key)
  certificateUrl String? @db.Text                     // audit certificate
  sequential  Boolean  @default(false)
  expiresAt   DateTime?
  sentAt      DateTime?
  completedAt DateTime?
  voidedReason String?
  webhookSecret String?                               // reserved for vendor webhooks (HMAC)
  version     Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  signers     SignatureSigner[]
  @@index([businessId, status])
}

enum EsignProvider { BUILTIN  DOCUSIGN  ZOHO_SIGN  ADOBE_SIGN  DIGIO  LEEGALITY }
enum EnvelopeStatus { DRAFT  SENT  DELIVERED  PARTIALLY_SIGNED  COMPLETED  DECLINED  VOIDED  EXPIRED  ERROR }

model SignatureSigner {
  id          String   @id @default(uuid())
  businessId  String
  envelopeId  String
  envelope    SignatureEnvelope @relation(fields: [envelopeId], references: [id], onDelete: Cascade)
  signerOrder Int      @default(1)
  role        SignerRole
  name        String
  email       String
  employeeId  String?
  userId      String?
  status      SignerStatus @default(PENDING)
  accessTokenHash String?                             // BUILTIN: hashed magic-link to the sign page
  tokenExpiresAt DateTime?
  // tamper evidence captured at sign time
  signedAt    DateTime?
  declinedReason String?
  ipAddress   String?
  userAgent   String?
  consentAt   DateTime?                               // explicit intent-to-sign consent
  signatureImageUrl String?                           // drawn/typed signature artifact
  signatureHash String?                               // SHA-256 over (docHash + signer + ts)
  @@unique([businessId, envelopeId, signerOrder])
  @@index([businessId, envelopeId, status])
}

enum SignerRole { EMPLOYEE  EMPLOYER  WITNESS  APPROVER }
enum SignerStatus { PENDING  SENT  VIEWED  SIGNED  DECLINED  EXPIRED }
```

### 3.3 Migration / index notes
- New `NumberSequence` scopes: `ONBOARD` (`ONB-`), `OFFBOARD` (`OFB-`); reuse existing `SEP` (`SEP-`), `EMPLOYEE` (`EMP-`), `ASSET` (`AST-`). Codes allocated **inside the same `$transaction`** as the parent insert (existing `nextValue` increment pattern).
- Partial uniques to forbid concurrent journeys (raw SQL in migration, Prisma can't express partial unique):
  - `CREATE UNIQUE INDEX onb_one_active_per_offer ON "LifecycleJourney"(business_id, offer_id) WHERE direction='ONBOARDING' AND deleted_at IS NULL;`
  - one active offboarding per employee mirrors the existing `SeparationCase @@unique([businessId, employeeId, initiatedAt])` (schema L8139).
- Every new table carries `businessId` so `scopeWhere(scope, 'assigneeEmployeeId')` / `scopeWhere(scope, 'employeeId')` work directly with F1.
- `Application.convertedEmployeeId` is finally written by `provisionEmployee()` — no schema change, just usage.

---

## 4. Backend

New module `backend/src/hr/lifecycle/` (sibling to `attendance/`, `payroll/`, `talent/`):
```
lifecycle/
  journeyEngine.js          // pure state machine: task→stage→journey transitions
  provision.js              // provisionEmployee() orchestrator (transactional, idempotent)
  fnf.js                    // computeFnf() → payroll engine inputs
  templates/seed.js         // IN + NZ default templates
  esign/builtin.js          // BUILTIN provider (signature capture, PDF re-stamp, audit cert)
  esign/provider.js         // the EsignProvider interface (vendor adapters later)
  controllers/{onboarding,offboarding,esign,documents}.controller.js
  routes/{onboarding,offboarding,esign}.routes.js
```
Mounted in `backend/src/hr/routes/index.js` alongside the existing lines (L9-43):
`router.use('/onboarding', …)`, `router.use('/separations', …)`, `router.use('/esign', …)`. ESS routes mount under the existing `/me/*` area (today only `/me/payslips` exists at L30) → add `/me/onboarding`, `/me/separation`, `/me/documents`.

### 4.1 Onboarding state machine (pure / testable — `journeyEngine.js`)

`advanceJourney(journey, tasks)` is a **pure function**: given the journey + its tasks, returns the next `{ currentStage, status }` and the set of side-effects to emit (notifications, stage spawns). No DB inside; the controller wraps it in a tx. This is the testable core (mirrors F2's `derive()`).

```
Offer[SENT] --acceptOffer hook--> Journey(NOT_STARTED)
   seedJourney(): copy template→tasks, stamp offerAcceptedAt + joinDate=offer.joiningDate, mint pre-join token
   --first task touched / cron--> IN_PROGRESS
PRE_JOIN -> SELF_ONBOARDING -> DOCS_ESIGN -> PROVISIONING -> DAY_ONE -> WEEK_ONE -> PROBATION -> COMPLETED
   a stage advances only when all its blocking+mandatory tasks ∈ {DONE, SKIPPED, NOT_APPLICABLE}
   any blocking task OVERDUE/FAILED -> BLOCKED (+notify HR)
   pre-provision rescindOffer -> RESCINDED (Offer→DECLINED, purge pre-join token + staged PII)
   pre-join no-show (now > joinDate + grace, unprovisioned) -> NO_SHOW (Offer→EXPIRED)
   HR cancel -> CANCELLED ; HR pause -> ON_HOLD
```

**Transition guards:**
| From | Event | Guard | Effect |
|---|---|---|---|
| `Offer.SENT` | `acceptOffer` (hook) | offer not expired/revoked | `Journey(NOT_STARTED)`, snapshot tasks, set anchors, mint token, notify candidate |
| `PROVISIONING` | `PROVISION_EMPLOYEE` | self-onboarding blocking tasks DONE **or** HR override(reason); `ESIGN_CONTRACT` envelope `COMPLETED` | run `provisionEmployee()` atomically → stage `DAY_ONE` |
| `PROBATION` | `PROBATION_REVIEW` = confirmed | review outcome confirmed | `Employee.status PROBATION→ACTIVE`; `EmploymentRecord(changeReason=PROBATION_CONFIRM)`; journey `COMPLETED` |
| `*` pre-provision | `rescindOffer` | not yet provisioned | journey `RESCINDED`; purge token + `selfServiceJson` PII |

### 4.2 `provisionEmployee()` — the orchestrator (`provision.js`, ONE `$transaction`, idempotent)

Invoked by the `PROVISION_EMPLOYEE` task (HR clicks "Provision" in `<ProvisionDrawer>`). **Idempotent on `journeyId`**: each sub-step records its produced id in `task.resultJson.<step>`; a re-run sees the ledger and no-ops → second call returns **409 "already provisioned"**. Row-locks the Journey + Offer. Any failure → full rollback → task `FAILED` → journey `BLOCKED` (no partial employee).

```
provisionEmployee(journeyId):
  preconditions: direction=ONBOARDING; currentStage=PROVISIONING; Offer=ACCEPTED;
                 blocking SELF_ONBOARDING tasks DONE (or HR override); ESIGN_CONTRACT COMPLETED
  steps (resultJson.<k>=id each, for idempotency), all in tx:
   1. Employee: promote PRE_HIRE → real row from Offer + selfServiceJson
        code = NumberSequence('EMPLOYEE').next            // EMP-000xxx
        status = probationDays>0 ? PROBATION : ACTIVE
        hireDate = joinDate; probationEndDate = joinDate + probationDays
   2. EmploymentRecord(changeReason=HIRE, effectiveFrom=joinDate, isCurrent=true,
        entityId, departmentId, designationId, employmentType, noticeDays)
        → Employee.currentEmploymentRecordId
   3. managerEmployeeId = offer/template manager           ← F1 hierarchy anchor
   4. Portal identity: create User, link Employee.userId, send invite      ← reuse the User/customer-auth pattern
   5. Assign BusinessRole (defaultScope drives F1 band: Employee=SELF, Managers=TEAM)
   6. StatutoryProfile from selfServiceJson
        IN: pan, uan, pfOptIn, taxRegime(default NEW), esiApplicable(wage ≤ ₹21,000)
        NZ: irdNumber, taxCode, kiwiSaverStatus, employeeRate(default 3% — confirm current floor in F4f)
   7. BankAccount(isPrimary) + EmergencyContact[] + Dependant[] (nominees)
   8. CompensationRevision(reason=HIRE, effectiveFrom=joinDate, isCurrent, structureId from Offer)
        + component lines → Employee.currentCompensationId
        → re-runs offerWageCheck (IN Basic+DA ≥ 50%)        ← reuse recruitment.controller offerWageCheck
   9. ShiftAssignment(default pattern, from joinDate)        ← F2 Attendance
  10. LeaveBalance per applicable LeaveType, opening pro-rated to joinDate
  11. promote staged pre-join uploads → EmployeeDocument rows (move from selfServiceJson)
  12. Application.convertedEmployeeId = employee.id           (closes the ATS loop, schema L8664)
  13. Notification(ONBOARDING_TASK) to manager + employee; advance stage → DAY_ONE
  on any failure: rollback → task FAILED → journey BLOCKED
```

**Probation:** `Employee.probationEndDate` + `EmployeeStatus.PROBATION`; cron `probation-due` fires `PROBATION_REVIEW` at T-15. Outcomes: Confirm (`EmploymentRecord(PROBATION_CONFIRM)`, →ACTIVE), Extend (push `probationEndDate`), Exit (open `SeparationCase(type=PROBATION_FAILURE)` → offboarding journey).

### 4.3 Separation state machine + FnF (`offboarding.controller.js` + `fnf.js`)

State machine over the existing `SeparationStatus` enum (schema-verified), wired to an offboarding `LifecycleJourney`:
```
initiateSeparation(type, reason)  -> SeparationCase(INITIATED), Employee.status=NOTICE_PERIOD, spawn OFFBOARDING journey
  INITIATED --acceptResignation, set LWD, compute noticeShortfallDays--> NOTICE_SERVING
  NOTICE_SERVING --LWD reached / clearance starts--> CLEARANCE_PENDING
  CLEARANCE_PENDING --all blocking clearance lanes CLEARED (clearanceJson filled)--> FNF_PENDING
  FNF_PENDING --computeFnf()--> FNF_COMPUTED
  FNF_COMPUTED --ApprovalRequest(SEPARATION) approved (SoD: approver≠initiator)--> FNF_APPROVED
  FNF_APPROVED --post PayRun(type=FNF), pay--> SETTLED
     -> Employee.status=TERMINATED (or RETIRED), terminationDate set, revoke access, generate letters
  any pre-SETTLE --withdraw/HR cancel--> CANCELLED (Employee → ACTIVE)
```
`employee.terminate` (existing, `employee.controller.js:112`) is **demoted to an internal helper** invoked by `settle` — never the user-facing exit path (the audit confirmed it does no SeparationCase/FnF work today).

**`computeFnf(separationCase)` → payroll engine.** Builds the FnF input set and posts a single-employee **`PayRun(type=FNF)`** for the final partial period to LWD; snapshots results onto the existing `SeparationCase` money fields, then `PayRunLine`/`Payslip`.

| Component | India | New Zealand |
|---|---|---|
| Unpaid salary | days worked to LWD (freeze attendance via F2 `AttendancePayInput`) | same |
| Leave encashment | encashable `LeaveBalance.closing` × (Basic+DA ÷ 26) → `leaveEncashmentDays/Amount` | **8% holiday pay on gross since last anniversary + untaken annual leave** valued at **greater of OWP / AWE** → `nzHolidayPayoutAmount`; plus owed alt/public-holiday days |
| Gratuity | Payment of Gratuity Act 1972: eligible **≥5 yrs** (waived on death/disablement); `(15÷26) × last-drawn (Basic+DA) × completed yrs (>6 mo rounds up)`, cap ₹20L → `gratuityAmount` | n/a |
| Notice | shortfall × per-day pay → `noticeRecoveryAmount` (deduction) **or** employer pay-in-lieu (earning) | pay-in-lieu per agreement; **no unlawful deduction** without written consent |
| Deductions | `loanForeclosureAmount` (loans residual), `assetRecoveryAmount` (lost/damaged), excess leave, TDS | student loan, KiwiSaver, PAYE; deductions only if lawfully authorised |
| Net | `netSettlement = Σ earnings − Σ deductions` | same |

```
computeFnf(sep):
  pre: status=FNF_PENDING; all blocking clearance lanes done; zero un-returned assets (or HR waiver→recovery)
  1. freeze attendance to LWD → AttendancePayInput                     ← F2
  2. unpaidSalary = prorate(currentComp, periodStart..LWD)
  3. leaveEncash  = encashable(LeaveBalance) × perDayBasis             ← Leave module
  4. gratuity (IN, ≥5yr) = (15/26)*lastDrawnBasicDA*completedYears
  5. notice = shortfall>0 ? recovery : (payInLieu if employer-initiated)
  6. deductions = loans + assetRecovery + excessLeave + statutory
  7. snapshot → SeparationCase.{gratuityAmount, leaveEncashment*, nzHolidayPayoutAmount,
                  noticeRecoveryAmount, loanForeclosureAmount, assetRecoveryAmount, netSettlement}
  8. PayRun(type=FNF, single employee) + lines ; status → FNF_COMPUTED
  9. raise ApprovalRequest(module=SEPARATION)
  on approve: FNF_APPROVED ; on PayRun PAID: SETTLED, set fnfPayRunId
```

**Access revocation (`REVOKE_ACCESS`, system task, reuse F1):** on settle — `Employee.isActive=false`; detach `BusinessRole`; `User.isActive=false`; **if leaver is a manager, force-reassign `reports[].managerEmployeeId`** before settlement (else the `scopeResolver` recursive CTE orphans the sub-tree).

### 4.4 Documents + built-in e-sign (`documents.controller.js` rewrite + `esign/builtin.js`)

**Document upload** (`POST /onboarding/documents` and ESS `POST /me/documents`): body `{ category, name, mimeType, sizeBytes, fileHash, fileBase64 }` → store via existing `s3.uploadDataUrl` (≤10 MB), write a **real** `EmployeeDocument` row (`fileUrl`=key, `fileHash`, `visibility` default `HR_ONLY`, employee-facing letters `EMPLOYEE_VISIBLE`). **This replaces the broken controller** that writes non-existent fields.

**Document lifecycle:** `REQUESTED → UPLOADED → VERIFIED` (`verifiedAt/By`) / `REJECTED`; template-generated letters `GENERATED`; `expiresAt` (visa/permit/passport) → `DOC_EXPIRING` notification at T-30/T-7 → renewal = new row (`meta.supersedesId`, old soft-deleted).

**Built-in e-sign (`BUILTIN`) — the only provider in v1:**
```
createEnvelope({ subject, documentTemplateId|employeeDocumentId, signers[] })
  -> SignatureEnvelope(DRAFT) + SignatureSigner[] ; mint per-signer hashed magic link ; status SENT
GET /esign/sign/:token (public, token-auth)
  -> render merged DocumentTemplate / doc PDF in iframe
  -> "I have read and agree" consent + typed-name + drawn-signature canvas
  -> POST: capture consentAt + ipAddress + userAgent + signatureImageUrl
           signatureHash = SHA-256(docHash + signerEmail + ISO-ts)
           signer.status=SIGNED ; on all signed -> envelope COMPLETED
on COMPLETED: re-stamp flattened PDF with an audit footer (signer identities, UTC ts, doc SHA-256,
              consent record) -> finalFileUrl + certificateUrl
              -> EmployeeDocument.signatureStatus=SIGNED, fileUrl=finalFileUrl, fileHash=SHA-256(finalPdf)
              -> complete the bound LifecycleTask, advance journey
```
Sequential envelopes (dual-signer contracts) release signer N+1's link only after signer N `SIGNED`. **Legal basis:** IN IT Act 2000 §10A (electronic contracts), NZ Contract & Commercial Law Act 2017 Part 4 (electronic signatures) — non-PKI e-sign valid where intent + attribution + integrity are demonstrable; the audit cert captures all three. Vendor (`DOCUSIGN`/etc.) adapters + HMAC webhooks are a later additive pass against the same `SignatureEnvelope`/`SignatureSigner` tables.

### 4.5 RBAC posture (additive to `rbac.js` — no migration; `permissions` is a JSON column)

Add to `PERMISSIONS`:
| Key | Grants |
|---|---|
| `canManageOnboarding` | onboarding templates + run pipeline + provision |
| `canRunSeparation` | initiate/run separation (distinct from raw `canManageEmployees` terminate) |
| `canGenerateLetters` | offer/relieving/experience letter generation |

Seed into `SYSTEM_ROLES`: **Owner**=all (auto, it's `Object.fromEntries(PERMISSION_KEYS…)`). **HR-Admin**=all three true. **Finance**=`canRunSeparation` false, participates in FnF via existing `canApprovePayroll`. **Manager**=none of the three — acts only through **scoped task endpoints**.

**Every lifecycle read/write passes `withEmployeeScope(action, {idParam})`** (verified F1 chokepoint). Scope keys per route:
- HR pipeline / template / provision / separation init+compute: `canManageOnboarding` / `canRunSeparation` (HR-Admin = `ALL` band).
- Manager task lists: `withEmployeeScope('canViewEmployees')` → `scopeWhere(req.scope, 'assigneeEmployeeId')`; out-of-team subject → **404** (`scopeAllows` → not-found, never 403, matches F1 IDOR posture).
- FnF approve: `withEmployeeScope('canApprovePayroll')` — `APPROVAL_ACTIONS` strips self (SoD); plus an explicit `approver ≠ initiator` guard in the controller.
- ESS endpoints: **no `:id` in the path** — subject derived from session via `attachSelfEmployee` (`Employee.userId`); a new hire pre-join uses the journey magic-link token. Cross-employee writes are structurally impossible.

### 4.6 Endpoint surface
```
HR-Admin (apps/hr-admin):
  POST   /api/hr/recruitment/offers/:id/accept        (existing) + hook seedOnboardingJourney
  GET/POST/PATCH/DELETE /api/hr/onboarding/templates(/:id)        canManageOnboarding
  GET    /api/hr/onboarding/pipeline?stage=                        scoped
  POST   /api/hr/onboarding/provision/:journeyId                   canManageOnboarding (atomic, idempotent)
  POST   /api/hr/onboarding/:journeyId/rescind                     canManageOnboarding
  GET    /api/hr/onboarding/tasks?owner=me                         withEmployeeScope (manager view)
  POST   /api/hr/onboarding/tasks/:id/complete|skip|reassign       scoped (idParam → 404 if out of scope)
  POST   /api/hr/separations                                       canRunSeparation
  PATCH  /api/hr/separations/:id/clearance                         scoped (per-lane owner)
  POST   /api/hr/separations/:id/compute-fnf                       canRunSeparation
  POST   /api/hr/separations/:id/approve-fnf                       canApprovePayroll + approver≠initiator
  POST   /api/hr/separations/:id/settle                            canRunSeparation
  POST   /api/hr/letters {employeeId,type,separationCaseId?}       canGenerateLetters
  POST   /api/hr/onboarding/documents ; POST /api/hr/esign/envelopes
  POST   /api/hr/assets/:id/assign ; POST /api/hr/assets/assignments/:id/return   (after bug fixes)
ESS (apps/ess, session/token self-scoped):
  GET    /api/hr/me/onboarding ; PATCH /me/onboarding/details|statutory ; POST /me/onboarding/submit
  POST   /api/hr/me/onboarding/documents ; POST /me/onboarding/esign/:docId
  POST   /api/hr/me/separation/resign ; GET /me/separation ; GET /me/separation/fnf
  GET    /api/hr/me/documents ; GET /me/documents/:id/download
Public (token):
  GET    /api/hr/onboarding/prejoin/:token ; PATCH …/self-service
  GET    /api/hr/esign/sign/:token ; POST …
Crons: lifecycle-task-due, probation-due, no-show-sweep, doc-expiry
```

---

## 5. Frontend

### 5.1 hr-admin (`apps/hr-admin/app/`) — new areas
Nav gated by `lib/nav.js` permission keys (hidden when the key is absent). New dirs: `onboarding/`, `separations/`, plus `settings/onboarding/`.
- **`onboarding/pipeline`** — `<PipelineBoard>` Kanban: **Offer Sent → Accepted → Onboarding (PRE_HIRE) → Active**. Card = name, designation, join date, task progress ring, blocking-task badge. `GET /onboarding/pipeline` (scoped). Card cannot reach **Active** while a `blocking` task is open or a required+eSign doc is unsigned. Drag = optimistic, rollback on 409.
- **`onboarding/provision` (`<ProvisionDrawer>`)** on the Accepted card — review identity/comp/manager → "Provision employee" → `POST /onboarding/provision/:journeyId`. Partial failure shows the failed step; whole tx rolled back. Re-click = 409 no-op.
- **`settings/onboarding` (`<TemplateBuilder>`)** — v1: edit the single starter template per direction (stages → tasks: `title, ownerRole, dueOffsetDays, isBlocking`, doc requirements, e-sign requirements). "Changes apply to new journeys only" (existing journeys are snapshots). `canManageOnboarding`.
- **`people/[id]` → "Initiate separation" (`<SeparationWizard>`)** — type/reason/dates/notice-shortfall/LWD/relieving → `POST /separations`. Then **`separations/[id]`** runner: 3 panes — clearance checklist (`clearanceJson` lanes: assets/it/finance/knowledge_transfer), FnF preview, `SeparationStatus` timeline. Compute/approve/settle wired (approve disabled for the initiator).
- **`people/[id]` → Documents → `<LetterGenerator>`** — pick `DocumentTemplate(kind)`, preview merged PDF, generate → `EmployeeDocument(category)` with `fileHash`; relieving gated on `SETTLED` (override audited). Reuses tenant branding from `settings/branding` (F3).
- **Shared `packages/ui`:** `<DocumentDropzone>` (SHA-256 client-side, status chips, `documentNumber` masked `XXXX-…-1234`), `<ESignPanel>` (iframe PDF → consent → typed/drawn signature → green "Signed on …" banner, read-only after).

### 5.2 ESS (`apps/ess/app/`) — new areas
- **`onboarding/` (`<OnboardingWizard>`)** — pre-join (magic-link token) or post-join (session): (1) personal, (2) statutory — IN PAN/Aadhaar(masked)/UAN/PF/tax-regime, NZ IRD/tax-code/KiwiSaver, (3) documents via `<DocumentDropzone>`, (4) e-sign via `<ESignPanel>`, (5) review+submit. `GET /me/onboarding` (self-derived, no IDs in path). Submit blocked until required docs uploaded + e-sign docs signed.
- **`onboarding` home `<FirstDayChecklist>`** — new-hire-owned tasks + progress bar; HR/manager tasks shown as read-only pips.
- **`separation/` (`<ResignationForm>`)** — intended last day (validated vs notice), reason, notice-terms ack → `POST /me/separation/resign` (creates one draft `SeparationCase(RESIGNATION, INITIATED)` on the session employee; short-notice amber warning). Second submit rejected.
- **`separation` `<ExitTracker>` + `<FnFStatement>`** — `GET /me/separation` (status timeline + lanes + own pending actions), `GET /me/separation/fnf` (snapshot once `FNF_COMPUTED`). Figures match HR snapshot exactly.
- **`documents/` (existing page)** gains a **"Separation"** section listing relieving/experience `EmployeeDocument(category in {RELIEVING_LETTER…})`; `GET /me/documents` (self-scoped, finally mounted), download via signed URL with hash-verify badge.

### 5.3 Universal states
Loading = skeletons (via `useApi`). Empty = illustration + cause + CTA. No-permission = nav item hidden + centered "no access" card (never raw 403). Out-of-scope (manager hits another team) = 404. One allowed celebratory affordance: "You're all set for Day-1" on full onboarding completion.

---

## 6. End-to-end per role + acceptance criteria

**HR-Admin / Owner**
1. Create offer (50% wage floor enforced server-side by `offerWageCheck`; UI blocks submit) → send → accept.
   - *AC:* offer below floor cannot be created; accept transitions `Application→HIRED` and creates exactly **one** journey (idempotent on `offerId`).
2. New hire self-onboards; HR reviews → clicks **Provision**.
   - *AC:* provisioning is **atomic** (Employee+User+role+manager+comp+leave+shift all-or-nothing); on success the employee appears in the directory under the assigned manager's `TEAM` scope; re-invoking is a **409 no-op**.
3. Confirm probation → ACTIVE.
4. Initiate separation → clearance → compute FnF → approve → settle.
   - *AC:* FnF **cannot be approved by the initiator** (SoD, server-enforced); settle is gated on all clearance lanes CLEARED + FnF approved + zero un-returned assets; produces exactly one `PayRun(type=FNF)`; sets `Employee.status=TERMINATED`, removed from active directory + manager TEAM scopes, retained for reports.
5. Generate relieving/experience letters (gated on `SETTLED`; override audited).
   - *AC:* PDF carries tenant branding, correct tenure dates, verifiable `fileHash`.

**Manager (F1 `TEAM` band, no admin keys)**
6. Sees onboarding tasks only for incoming reports in their sub-tree (`/onboarding/tasks?owner=me`); completes manager-owned blocking tasks (buddy/Day-1).
   - *AC:* out-of-team subjects are invisible; completing a manager blocking task contributes to the hire's Active gate.
7. Sees offboarding tasks for departing reports; can clear **only** KT + asset lanes; asset sign-off rejected while any `Asset` assigned to the employee is un-returned.
   - *AC:* finance/IT lanes are not actionable by a manager; out-of-team report → 404.

**New hire (pre-join token + ESS)**
8. Completes the wizard before Day-1 via magic-link; data lands on **their own** record only (session/token-derived).
   - *AC:* submit blocked until required docs uploaded + e-sign signed; no cross-employee/cross-tenant write possible.

**Exiting employee (ESS)**
9. Resigns for self (session-derived; no `employeeId` from client); tracks exit; views FnF after compute; downloads letters post-settle.
   - *AC:* exactly one active `SeparationCase` per employee (second submit rejected); FnF figures match HR snapshot; letters downloadable only after generation, with integrity hash, and remain available while the account is read-only post-exit.

---

## 7. QA plan (numbered)

**Provisioning atomicity & idempotency**
1. Force step-8 (comp) to throw mid-provision → assert **no** `Employee`/`User`/`EmploymentRecord`/`LeaveBalance` rows persist (full rollback); task `FAILED`, journey `BLOCKED`.
2. Call `POST /onboarding/provision/:journeyId` twice concurrently → exactly one Employee; second returns **409**; `resultJson` ledger unchanged.
3. After provision, `Employee.userId` linked, `currentEmploymentRecordId`/`currentCompensationId` set, `Application.convertedEmployeeId` written.

**RBAC scope (the owner's hard requirement)**
4. Manager A lists `/onboarding/tasks?owner=me` → sees only sub-tree hires' manager-owned tasks; Manager B's reports absent.
5. Manager A `POST /onboarding/tasks/:id/complete` for a task whose subject is **outside** A's sub-tree → **404** (not 403; via `scopeAllows`).
6. Manager attempts `PATCH /separations/:id/clearance` finance lane → rejected (lane not manager-owned).
7. ESS new hire `GET /me/onboarding` returns only own journey; crafting a request with another employeeId has no effect (subject is session-derived, ignored from body).
8. Exiting employee `GET /me/separation/fnf` for another's case → 404.
9. FnF approve by the **initiator** → 403/422 (SoD); by a different `canApprovePayroll` actor → ok.

**FnF math**
10. IN gratuity: 7.5 yrs service, last Basic+DA ₹40,000 → `(15/26)*40000*8` (7.5→8, >6mo rounds up) = ₹1,84,615; capped at ₹20L; <5 yrs → 0 (except DEATH/disablement waiver).
11. IN leave encashment: 12 days EL, Basic+DA ₹52,000 → `12*(52000/26)` = ₹24,000.
12. IN notice shortfall: served 20 of 30 days → `noticeRecoveryAmount = 10 * perDayPay` (deduction); employer-initiated → pay-in-lieu earning instead.
13. NZ holiday payout: 8% of gross-since-anniversary + untaken annual leave at **max(OWP, AWE)** → populates `nzHolidayPayoutAmount`; no IN gratuity line.
14. `netSettlement` = Σ earnings − Σ (loanForeclosure + assetRecovery + notice + statutory); negative net surfaces "recoverable balance" and still produces a `PayRun(type=FNF)`.
15. ESS `<FnFStatement>` line items equal the `SeparationCase` snapshot exactly.

**E-sign audit integrity**
16. Sign a single-signer offer → `signatureHash = SHA-256(docHash+signer+ts)`; `finalFileUrl` PDF footer lists signer/UTC/docHash/consent; `EmployeeDocument.signatureStatus=SIGNED`, `fileHash` = hash of final PDF.
17. Sequential dual-signer contract: signer 2's `/esign/sign/:token` is inert until signer 1 `SIGNED`.
18. Tamper check: altering the stored PDF makes `fileHash` mismatch → integrity badge fails.
19. Expired magic-link token → "invite expired", no signature recorded.

**Document access control**
20. `visibility=HR_ONLY` doc not returned by `GET /me/documents`; `EMPLOYEE_VISIBLE` letter is.
21. Manager cannot fetch an out-of-scope employee's documents (404).
22. Upload writes a **real** `EmployeeDocument` (regression guard against the old controller's fabricated fields) — assert row has `category`/`fileUrl`/`fileHash`, not `type`/`url`.

**State-machine guards**
23. Card→Active blocked while any blocking onboarding task open.
24. compute-FnF blocked while any clearance lane un-CLEARED; settle blocked while any asset un-returned (or HR waiver→recovery recorded).
25. rescindOffer post-provision → rejected (only pre-provision); no-show cron flips unprovisioned past-grace journeys to `NO_SHOW` + Offer→EXPIRED.

**Asset bug regressions (must fix first)**
26. `GET /assets` and `assign`/`returnAsset` succeed (no `Unknown field assetTag` — uses `Asset.code`); `returnAsset` writes `conditionIn` and, when lost/damaged, sets `recoveryAmount` feeding `assetRecoveryAmount`.

---

## 8. Build sequence (one focused pass each)

**4a — Onboarding core.** Migration (6 models + enums); `journeyEngine.js` (pure, fully unit-tested); `acceptOffer` hook → `seedOnboardingJourney`; IN+NZ default templates (`templates/seed.js`); pipeline board + advance guard. *Fixes the assets controller bugs as a pre-req (assetTag→code, condition→conditionIn).*
**4b — Self-onboarding ESS.** Pre-join token wizard; statutory validators (PAN/Aadhaar-checksum/UAN; IRD mod-11/tax-code/KiwiSaver); `selfServiceJson` staging + completeness vector; `/me/onboarding` endpoints.
**4c — Provisioning.** `provisionEmployee()` (atomic, idempotent; reuses F1 RBAC + comp/leave/attendance seeders); `<ProvisionDrawer>`; probation cron + review.
**4d — Documents + built-in e-sign.** Rewrite `documents.controller.js` against the real `EmployeeDocument`; upload endpoint via `s3.uploadDataUrl`; `SignatureEnvelope/Signer`; `esign/builtin.js` (signature capture + PDF re-stamp + audit cert); `<DocumentDropzone>` + `<ESignPanel>`.
**4e — Assets wiring.** Catalog + assign/return tasks bound to checklist; ESS asset acknowledgment.
**4f — Offboarding + FnF.** Separation routes + `<SeparationWizard>`; exit checklist; `computeFnf()` → `PayRun(type=FNF)`; SoD-gated approve; RBAC access revocation + manager-reassign guard; relieving/experience letters; ESS resign/tracker/FnF.

Each slice ships through the standard **2 adversarial-review rounds** (the loop that caught F1's IDOR/F2's overpay bugs). Review focus: provisioning rollback/idempotency, FnF deduction math (gratuity rounding, NZ OWP/AWE), e-sign hash integrity, pre-join token scope, SoD on provision-vs-offer-approve and FnF-compute-vs-approve.

---

## 9. Files (absolute)

**Reuse / hook:**
- `/Users/kp/hr/backend/src/core/lib/rbac.js` — add `canManageOnboarding`/`canRunSeparation`/`canGenerateLetters` to `PERMISSIONS` + seed `SYSTEM_ROLES` (JSON, no migration).
- `/Users/kp/hr/backend/src/hr/lib/scopeResolver.js`, `/Users/kp/hr/backend/src/hr/middleware/scope.middleware.js` — `withEmployeeScope`/`scopeWhere`/`scopeAllows` for every lifecycle route (verified signatures).
- `/Users/kp/hr/backend/src/hr/talent/controllers/recruitment.controller.js` — `acceptOffer` (L521) add `seedOnboardingJourney`; reuse `offerWageCheck` (L406) in provisioning comp step.
- `/Users/kp/hr/backend/src/hr/controllers/employee.controller.js` — `terminate` (L112) demoted to internal `settle` helper.
- `/Users/kp/hr/backend/src/core/lib/s3.js` — `uploadDataUrl` for v1 document upload (no presign exists; presign deferred).
- `/Users/kp/hr/backend/src/hr/payroll/` — engine target for the FnF `PayRun(type=FNF)`.
- `/Users/kp/hr/backend/src/hr/routes/index.js` — mount `/onboarding`, `/separations`, `/esign`, `/me/onboarding`, `/me/separation`, `/me/documents`.

**Fix-before-reuse (verified bugs):**
- `/Users/kp/hr/backend/src/hr/controllers/assets.controller.js` — `assetTag`→`code` (L16/43/77/121); `data.condition`→`conditionIn`; add `recoveryAmount`/recovery seam.
- `/Users/kp/hr/backend/src/hr/controllers/documents.controller.js` — full rewrite against real `EmployeeDocument`.

**Create:**
- `/Users/kp/hr/backend/src/hr/lifecycle/` (module per §4).
- Schema additions: `/Users/kp/hr/backend/prisma/schema.prisma` (§3.2 models near existing `SeparationCase` L8101 / `Offer` L8724 / `EmployeeDocument` L8168).
- Frontend: `/Users/kp/hr/apps/hr-admin/app/{onboarding,separations,settings/onboarding}/`, `/Users/kp/hr/apps/ess/app/{onboarding,separation}/`, shared `packages/ui/{DocumentDropzone,ESignPanel}`.

**Schema anchors (verified L-numbers):** `Employee` L6502 (`status` L6537, `userId` L6508, `hireDate` L6538, `probationEndDate` L6539, `terminationDate` L6540, `managerEmployeeId` L6544), `EmploymentRecord` L6618, `SeparationCase` L8101, `EmployeeDocument` L8168, `DocumentTemplate` L8228, `Asset` L8357 (`code` L8362), `AssetAssignment` L8410 (`conditionOut/In` L8420-8421, `recoveryAmount` L8423), `Offer` L8724, `Application.convertedEmployeeId` L8664, `NumberSequence` L9012, `PayRunType.FNF` L7181.

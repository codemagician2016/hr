# Feature 13 — Rich Employee Profile + Field Governance, Manager Self-Service, Org/Reporting Tree

> **Status:** spec / dev contract · **Module:** `backend/src/hr/profile/` (new) + extends `backend/src/hr/controllers/org.controller.js`, `backend/src/hr/lifecycle/controllers/meProfile.controller.js` · **Apps:** `apps/ess`, `apps/hr-admin`
> **Markets:** India + New Zealand · **Builds on:** F1 RBAC/hierarchy (`scopeResolver.js`, `scope.middleware.js`, `rbac.js`), the ESS `/api/hr/me/*` customer-session surface, and the **already-present-but-unbuilt** maker-checker substrate (`ProfileChangeRequest`, `ApprovalRequest`, `WorkflowModule.PROFILE_CHANGE`).
> **Author note:** every schema field / RBAC key / file path below was verified against the live tree on 2026-06-24. Where existing schema nouns have zero code, they are flagged for wiring (not re-modelling).

---

## 1. Summary & goals

DriftHR can *render* an employee profile two ways today: the operator detail page reads the full `Employee` row + current `EmploymentRecord` + `statutoryProfile` (`employee.controller.js get()`, lines 91–150), and the ESS shows a **read-only** self card (`meProfile.controller.js getMyProfile`, lines 89–159). **An employee cannot change anything about themselves**, there is **no governance** over which fields are self-serviceable vs HR-gated, a **manager logging into ESS sees only their own self card** (the team is invisible on the employee portal), and the org chart (`org.controller.js tree()`, lines 85–155) exists but is operator-only and not wired into ESS.

This feature ships three tightly-related capabilities on top of that substrate:

1. **Rich, sectioned employee profile** (owner's Figma) editable by the employee — Personal, Contact, Address (with "same as" toggle), Family, Bank, Education, Professional, Nomination, Photo ID — plus Bonafide-letter and Separation-request shortcuts (which simply deep-link the *already-built* `/api/hr/me/letters` request flow and `/api/hr/me/separation/resign`).
2. **Per-field governance**: every editable field carries a policy — `self-edit` (commits immediately), `hr-approval` (routes a **change request → HR decision** before it touches the row), or `read-only` (display only). The approval path **consumes the existing `ProfileChangeRequest` + `ApprovalRequest` models** (currently zero code references) rather than inventing a new one.
3. **Manager Self-Service (MSS)**: a manager on ESS sees their **reporting sub-tree** — team roster, team attendance, team leave/reimbursement approval queues, team directory — via new `/api/hr/me/team/*` endpoints that enforce the **F1 TEAM band on the customer session** (the band that until now only existed on the operator session).
4. **Org/Reporting tree** ("Organization Relationship") surfaced in **both** apps: a clean Photo | Name | Position card tree with drill up/down, rooted at `?root=me` for ESS and the full forest for HR-admin.

**Goals (v1)**
- An employee updates their own contact/address/emergency/education/family in one or two clicks; gated fields (name, DOB, bank, statutory IDs) generate a **change request HR must approve**, with a clear "pending approval" state in the UI.
- A manager opens ESS and immediately sees and acts on their team — **no operator console needed** for the day-to-day "approve my report's leave / see who's in today" loop.
- Everyone (operator + employee) can see who-reports-to-whom and drill the hierarchy.
- **Zero new scope logic**: every read/write reuses `resolveAccessibleEmployeeIds` / `scopeWhere`. Tenant isolation and SoD are unchanged.

**Non-goals (v1)**: configurable per-tenant field-policy editor UI (we ship a **sensible default policy map in code**, tenant override deferred); multi-step approval chains for profile changes (single HR step — `WorkflowStep` chaining is a later refinement); document-verified ID changes (Aadhaar/IRD verification stays a flag, never the number — schema already enforces this, `StatutoryProfile.aadhaarVerified`); org-chart export/print.

---

## 2. Scope

### In scope (reuse-first)
- **Reuse as-is:** `scopeResolver.js` (`resolveAccessibleEmployeeIds`, `scopeWhere`, `scopeAllows`, `APPROVAL_ACTIONS`), `scope.middleware.js` (`attachSelfEmployee`, `withEmployeeScope`), `rbac.js` (`effectiveScope`, `PERMISSIONS`, `SYSTEM_ROLES`), the `requireCustomer` ESS middleware, the `resolveSelfEmployee(businessId, customer)` helper pattern (duplicated identically in `meProfile`, `meSeparation`, `meDocuments` — **we will hoist it once**, see §8), `org.controller.tree()`, and the **existing schema nouns**: `Employee`, `EmploymentRecord`, `BankAccount`, `EmergencyContact`, `Dependant`, `StatutoryProfile`, `ProfileChangeRequest`, `ApprovalRequest`/`ApprovalAction`, `WorkflowModule.PROFILE_CHANGE`, `WorkflowDefinition`/`WorkflowStep`.
- **Wire the unbuilt nouns:** `ProfileChangeRequest` and the `PROFILE_CHANGE` approval module have schema but **no controller/route**. This feature is their first consumer.
- **Add (new):** the field-policy map (`profileFieldPolicy.js`), the ESS profile read/write controller (`meProfile` extended to **sectioned** read + per-field write), the change-request → HR-approval controllers, the manager `/me/team/*` controllers, the ESS org-tree view, and 4 new sub-models (Education, professional-info extensions, address-type rows) — see §3.

### Out of scope (v1)
Tenant-editable policy UI, multi-approver profile chains, ID-document OCR/verification, profile field-level audit *export* (we still **audit** every change via `writeAudit`, used in `meSeparation`).

---

## 3. Data model (Prisma sketches)

The profile is *mostly* already modelled. We add the few sections that have no home (Education, the richer Personal/Professional fields, multi-type Address) and a small set of columns on `Employee`. **Personal fields from the Figma that don't yet exist go on `Employee`** (denormalized identity, consistent with how `bloodGroup`/`disabilityStatus` already live there).

### 3.1 Extend `Employee` (additive columns — no migration risk; all nullable / optional)

```prisma
model Employee {
  // ... existing columns unchanged ...

  // ── Feature 13: rich Personal Information (Figma §Personal) ──
  religion         String?
  community        String?
  motherTongue     String?
  placeOfBirth     String?
  stateOfBirthCode String?   @db.Char(2)   // ISO-3166-2 subdivision suffix or free state code
  identificationMark String?               // "ID mark" on the Figma
  heightCm         Decimal?  @db.Decimal(5,1)
  weightKg         Decimal?  @db.Decimal(5,1)
  fatherName       String?
  motherName       String?
  // Contact (Figma §Contact — official vs personal split + landlines)
  homePhone        String?
  officePhone      String?
  // officialEmail == existing workEmail; personalEmail already exists; personalPhone == existing phone

  // back-relations for the new sub-models
  educations       EmployeeEducation[]
  addresses        EmployeeAddress[]
}
```

> **Why on `Employee` and not a side table:** `religion`/`community`/`motherTongue` are 1:1 identity attributes read on every profile render; co-locating them with `bloodGroup`/`gender` (already on `Employee`) keeps the self-card a single row read (the `meProfile` getter already selects the row). They are **sensitive PII** → tagged `@pii:sensitive` in the section comment and only ever returned on the SELF (or in-scope operator) read.

### 3.2 New: `EmployeeEducation` (Figma §Education)

```prisma
model EmployeeEducation {
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId   String
  employee     Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  level        EducationLevel            // SCHOOL / DIPLOMA / BACHELORS / MASTERS / DOCTORATE / CERTIFICATION / OTHER
  institution  String
  fieldOfStudy String?
  startYear    Int?
  endYear      Int?
  grade        String?                   // GPA / % / class
  isHighest    Boolean  @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@index([businessId, employeeId])
}
enum EducationLevel { SCHOOL DIPLOMA BACHELORS MASTERS DOCTORATE CERTIFICATION OTHER }
```

### 3.3 New: `EmployeeAddress` (Figma §Address — correspondence / permanent / office + "same as")

We model address as **typed rows** rather than the three flat `addressLine*` columns on `Employee` (which become the *correspondence* address for back-compat). The `sameAsType` pointer encodes the "same as" toggle without duplicating data.

```prisma
model EmployeeAddress {
  id           String   @id @default(uuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId   String
  employee     Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  type         AddressType                 // CORRESPONDENCE / PERMANENT / OFFICE
  sameAsType   AddressType?                // when set, this address mirrors another (UI "same as" toggle)
  line1        String?
  line2        String?
  city         String?
  stateCode    String?
  postalCode   String?
  countryCode  String?  @db.Char(2)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@unique([businessId, employeeId, type])
  @@index([businessId, employeeId])
}
enum AddressType { CORRESPONDENCE PERMANENT OFFICE }
```

> **Family / Bank / Nomination / Photo-ID reuse existing models — do NOT duplicate:**
> - **Family** = `Dependant` (lines 6756–6772: `name`, `relationship`, `dateOfBirth`, `isNominee`, `nomineePercent`, `isInsured`) **+** `EmergencyContact` (lines 6738–6753). The Figma "Family" section reads `Dependant`; "2 emergency contacts" reads `EmergencyContact`.
> - **Bank** = `BankAccount` (lines 6714–6736; IN `ifsc` + NZ `nzBankAccount` already split).
> - **Nomination** = the `isNominee`/`nomineePercent` flags on `Dependant` (PF/gratuity nominee). No new model.
> - **Photo ID** = `Employee.photoUrl` (upload via the existing document-upload path used by lifecycle, `EmployeeDocument`). Statutory **ID numbers** = `StatutoryProfile` (PAN/UAN/Aadhaar-flag/IRD).
> - **Professional Info** = current `EmploymentRecord` (designation/department/grade/type/DOJ) — **read-only** on ESS (changing it is a transfer/promotion, an HR/lifecycle action, not a profile edit).

### 3.4 Field-policy: code, not schema

The per-field policy is a **frozen map in code** (`profileFieldPolicy.js`), keyed by a stable `fieldKey`. No table — adding/retuning a field never needs a migration (same philosophy as `rbac.js PERMISSIONS`). The `ProfileChangeRequest.field` column already stores the `fieldKey` string ("phone","addressLine1","bankAccount"…, per its schema comment).

```js
// backend/src/hr/profile/profileFieldPolicy.js
// policy ∈ 'self-edit' | 'hr-approval' | 'read-only'
// model  = which Prisma model the commit writes to (employee | bankAccount | statutoryProfile | address | dependant | emergencyContact | education)
const POLICY = Object.freeze({
  // ── FIXED → HR approval (identity / statutory / money) ──
  firstName:      { policy: 'hr-approval', model: 'employee', sensitive: true },
  lastName:       { policy: 'hr-approval', model: 'employee', sensitive: true },
  dateOfBirth:    { policy: 'hr-approval', model: 'employee' },
  'bank.accountNumber': { policy: 'hr-approval', model: 'bankAccount' },
  'bank.ifsc':          { policy: 'hr-approval', model: 'bankAccount' },
  'bank.nzBankAccount': { policy: 'hr-approval', model: 'bankAccount' },
  'statutory.pan':       { policy: 'hr-approval', model: 'statutoryProfile' },
  'statutory.uan':       { policy: 'hr-approval', model: 'statutoryProfile' },
  'statutory.irdNumber': { policy: 'hr-approval', model: 'statutoryProfile' },
  // ── FREE self-service ──
  phone:        { policy: 'self-edit', model: 'employee' },
  homePhone:    { policy: 'self-edit', model: 'employee' },
  officePhone:  { policy: 'self-edit', model: 'employee' },
  personalEmail:{ policy: 'self-edit', model: 'employee' },
  'address.*':  { policy: 'self-edit', model: 'address' },       // correspondence/permanent/office
  'emergency.*':{ policy: 'self-edit', model: 'emergencyContact' },
  'education.*':{ policy: 'self-edit', model: 'education' },
  // ── OPTIONAL self-service ("user may fill or not") ──
  religion:     { policy: 'self-edit', model: 'employee', optional: true, sensitive: true },
  community:    { policy: 'self-edit', model: 'employee', optional: true, sensitive: true },
  motherTongue: { policy: 'self-edit', model: 'employee', optional: true },
  bloodGroup:   { policy: 'self-edit', model: 'employee', optional: true, sensitive: true },
  heightCm:     { policy: 'self-edit', model: 'employee', optional: true },
  weightKg:     { policy: 'self-edit', model: 'employee', optional: true },
  identificationMark: { policy: 'self-edit', model: 'employee', optional: true },
  // ── READ-ONLY (HR/lifecycle owns; ESS displays) ──
  code:         { policy: 'read-only' },
  workEmail:    { policy: 'read-only' },                          // official email = login identity
  'employment.designation': { policy: 'read-only' },
  'employment.department':   { policy: 'read-only' },
  'employment.dateOfJoining':{ policy: 'read-only' },
  manager:      { policy: 'read-only' },
  // 'work' phone duplicates officePhone above; statutory ID *flags* (aadhaarVerified) stay HR-only read-only
});
```

`fieldPolicy(fieldKey)` resolves exact key → wildcard (`address.*`) → default `read-only` (**fail-closed**: an unknown field can never be self-edited or even requested). A `sensitive:true` field is masked for in-scope **operator** viewers who lack `canViewEmployees`-level detail and is consent-gated on render (reuses the existing `@pii:sensitive` convention).

### 3.5 Consuming `ProfileChangeRequest` / `ApprovalRequest`

`ProfileChangeRequest` (lines 8929–8946) is used **verbatim** — `field`, `oldValue`, `newValue`, `status` (`RequestStatus`), `approvalRequestId`, `decidedBy`/`decidedAt`. On a gated edit we create one row **per changed field** (so HR can approve a phone but reject a name in the same submission) and, optionally, a parent `ApprovalRequest(module=PROFILE_CHANGE, entityType='ProfileChangeRequest', entityId=<pcr.id>, requesterEmployeeId=self)` that drives the SLA/escalation machinery already present (`WorkflowStep.slaHours`, `onTimeoutAction`). v1 routes to a single HR step (`ApproverType.HR`); the chain is data-driven for later.

---

## 4. API surface (with RBAC)

### 4.1 ESS — Rich self profile (customer session, `requireCustomer`, SELF_ONLY)

Mounted by **extending** `/api/hr/me/profile` (`meProfile.routes.js`). **No `:id` in any path** — subject resolved from the session (the existing `resolveSelfEmployee` invariant; cross-employee read/write structurally impossible).

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/hr/me/profile` | (unchanged country/currency gate) | back-compat keys preserved |
| `GET /api/hr/me/profile/full` | **Sectioned** profile: `{ personal, contact, addresses, family, emergencyContacts, bank, education, professional, nomination, statutory, photo, policy }` | each field carries its `policy` so the client renders edit/lock/approval badges with **no client-side policy guesswork** |
| `PATCH /api/hr/me/profile/personal` | self-edit Personal fields | server splits body by policy (see §5.1) |
| `PATCH /api/hr/me/profile/contact` | self-edit contact/phones/personal email | |
| `PUT  /api/hr/me/profile/addresses/:type` | upsert one typed address; `{ sameAsType }` honoured | `type ∈ CORRESPONDENCE/PERMANENT/OFFICE` |
| `POST/PATCH/DELETE /api/hr/me/profile/emergency[/:id]` | manage emergency contacts (max 2 enforced) | |
| `POST/PATCH/DELETE /api/hr/me/profile/education[/:id]` | manage education rows | |
| `POST/PATCH/DELETE /api/hr/me/profile/family[/:id]` | manage dependants (incl. nominee %) | nominee % sum ≤ 100 enforced |
| `POST /api/hr/me/profile/photo` | upload/replace photo ID | reuses lifecycle upload (10MB/MIME caps already enforced there) |
| `GET  /api/hr/me/profile/change-requests` | the caller's own pending/decided change requests | self-scoped list |
| `POST /api/hr/me/profile/change-requests` | submit gated-field change(s) → `ProfileChangeRequest`(PENDING) + `ApprovalRequest` | **the hr-approval path**; body = `{ changes: [{field, newValue}] }`, each validated against policy + statutory format |
| **Shortcuts** | | |
| `POST /api/hr/me/letters` (existing) | "Bonafide letter" tile → `DocumentRequest(BONAFIDE/SALARY_CERTIFICATE)` | **already built** — profile page just deep-links it |
| `POST /api/hr/me/separation/resign` (existing) | "Separation request" tile | **already built** |

### 4.2 ESS — Manager Self-Service (customer session, **TEAM band on the customer**)

New router `/api/hr/me/team/*` (`meTeam.routes.js`). The customer session must be resolved to its `Employee` and given a **scope band** identical to the operator path. Crucially: the **subject is the session employee**; we build the scope from *their* `businessRole.defaultScope` (or fail-closed to SELF). A non-manager (SELF band) hitting these endpoints gets an empty team (their sub-tree minus self = ∅) → 200 with `[]`, never an error and never another person's data.

| Method & path | Purpose | RBAC / scope |
|---|---|---|
| `GET /api/hr/me/team/roster` | direct + indirect reports (Photo, Name, Position, status, location) | TEAM sub-tree via `resolveAccessibleEmployeeIds(sessionActor,'canViewEmployees')` |
| `GET /api/hr/me/team/attendance?date=` | today's team attendance board (in/out/leave/absent) | `scopeWhere(scope,'employeeId')` over `Attendance` |
| `GET /api/hr/me/team/leave/pending` | leave requests awaiting **this manager's** decision | reuses `meLeave`/leave approval read, scoped, **self excluded** (`APPROVAL_ACTIONS`) |
| `POST /api/hr/me/team/leave/:id/decide` | approve/decline a report's leave | `canApproveLeave` *capability check on the session's effective perms* + scope + SoD |
| `GET /api/hr/me/team/reimbursements/pending` | team expense claims awaiting decision | scoped over `ExpenseClaim` |
| `POST /api/hr/me/team/reimbursements/:id/decide` | approve/decline | scope + SoD |
| `GET /api/hr/me/team/directory` | searchable team directory (contact card) | scoped, **masks** comp/sensitive PII via `effectiveCompVisibility` (Manager → RANGE_ONLY) |
| `GET /api/hr/me/team/org?root=me` | the reporting tree rooted at the manager | reuses `org.controller.tree` logic, scope-filtered |

> **The one genuinely new primitive** is `resolveCustomerScope(req.customer)` (§8): today scope is only ever resolved for an **operator** `req.user`. We give the customer session the same band by loading the linked `Employee` + its `User.businessRole.defaultScope`, then calling the *existing* `resolveAccessibleEmployeeIds` with a synthesized actor `{ businessId, role, employeeId, businessRole }`. **No new scope math** — it is the same recursive-CTE chokepoint.

### 4.3 HR-admin — Change-request approval queue (operator session, `protect` + RBAC)

| Method & path | Purpose | RBAC |
|---|---|---|
| `GET /api/hr/profile/change-requests?status=PENDING` | HR queue of all profile change requests, scoped | `canManageEmployees` + `withEmployeeScope('canViewEmployees')` (manager sees only their sub-tree's requests) |
| `POST /api/hr/profile/change-requests/:id/approve` | apply `newValue` to the real model (atomic) + close `ApprovalRequest` | `canManageEmployees`; **SoD: approver ≠ requester** (the requester is an employee, the approver an operator — distinct identities, plus a guard that an operator cannot approve a request for *their own* linked employee) |
| `POST /api/hr/profile/change-requests/:id/reject` | reject with comment, no row change | `canManageEmployees` |

### 4.4 Org tree (both apps)

`GET /api/hr/org/tree?root=me` already exists (operator). We add the customer-session equivalent **inside** the MSS router (`/api/hr/me/team/org`) so ESS reuses the same node shape `{ id, code, name, designation, departmentName, reportsCount, children, photoUrl }`. **Add `photoUrl` to the `tree()` select** (a one-line addition — the Figma card is Photo | Name | Position).

---

## 5. Governance flow (the heart of the feature)

### 5.1 Server-side policy split (single write entry-point)

Every ESS profile write goes through one resolver so the client can **never** smuggle a gated field through a self-edit endpoint:

```
PATCH /me/profile/* with body fields
  → for each field: pol = fieldPolicy(fieldKey)
      'read-only'   → 400 "{field} cannot be changed here"
      'self-edit'   → stage into the immediate-commit bucket (validated)
      'hr-approval' → stage into the change-request bucket
  → commit self-edit bucket in one tx (writeAudit PROFILE_SELF_EDIT)
  → for hr-approval bucket: create ProfileChangeRequest(PENDING) per field
       + one ApprovalRequest(PROFILE_CHANGE) ; notify HR (Notification.PROFILE_CHANGE_*)
  → response: { applied: [...], pending: [...] }  // UI shows "saved" vs "sent for approval"
```

This means even `PATCH /me/profile/personal` is safe if the client mistakenly includes `dateOfBirth` — the server routes it to approval, never an immediate write.

### 5.2 HR approval commit (atomic, by model)

`approve` reads the `ProfileChangeRequest`, switches on `fieldPolicy(field).model`, and writes the typed value into the correct model **in a transaction** with the requester's current value as `oldValue` snapshot (optimistic-concurrency: re-check `Employee.version`/`BankAccount.version` to avoid clobbering a concurrent HR edit, mirroring how comp revisions guard `version`). Statutory IDs re-run their format validators (PAN regex, IRD mod-11, IFSC) at commit, not just at submit. Then `ProfileChangeRequest.status=APPROVED`, `ApprovalRequest.status=APPROVED`, `decidedBy`/`decidedAt` set, `writeAudit`, and `Notification` to the employee ("your bank update was approved").

---

## 6. UX flows (plain language)

### 6.1 Employee profile (ESS `apps/ess/app/profile`)
A left rail lists the Figma sections (Personal · Contact · Address · Family · Bank · Education · Professional · Nomination · Photo ID). Each field shows one of three affordances, computed from the `policy` the API returns:
- **Pencil (green)** — *self-edit*: click, type, **Save** → toast "Saved". (contact, address, emergency, education, optional personal fields)
- **Lock + "Request change" (amber)** — *hr-approval*: editing opens a small panel "This change needs HR approval", shows old → new, **Send request** → the field now shows a **"Pending HR approval"** chip and is read-only until decided. (name, DOB, bank, PAN/UAN/IRD)
- **Grey, no pencil** — *read-only*: designation, department, DOJ, employee code, official email, manager.

The Address section has a **"Permanent same as Correspondence"** checkbox (writes `sameAsType=CORRESPONDENCE`, greys the permanent fields). "Optional" fields are visually marked *"Optional — you may leave this blank."* Two tiles at the top — **Request Bonafide Letter** and **Raise Separation Request** — deep-link the already-built ESS letter-request and resignation flows. A **My Requests** strip shows the status of any pending change requests.

### 6.2 Manager Self-Service (ESS — a new **My Team** top-nav item, visible only when the session band ≠ SELF)
Tabs: **Roster** (cards: photo, name, position, today's status), **Attendance** (a single board — who's in / on leave / absent today), **Approvals** (one merged inbox: pending leave + reimbursements with Approve/Decline inline; self-requests never appear — SoD), **Directory** (search, contact cards, comp masked to ranges), **Org** (the tree rooted at the manager). The manager never leaves ESS for the daily loop. A manager who is *also* an approver sees an approvals badge count in the nav.

### 6.3 Org / Reporting tree (both apps)
A horizontally-scrolling node tree: each node is **Photo | Name | Position**, with a count chip ("4 reports") and expand/collapse. Click a node to **drill down** (re-root) or breadcrumb **up**. HR-admin (`apps/hr-admin/app/org/chart`, already scaffolded) shows the full forest + search; ESS shows it rooted at the signed-in employee (`?root=me`), letting any employee see their chain up to the top and their peers/reports.

---

## 7. Build plan (5 slices)

- **Slice 13a — Field-policy + sectioned read.** Add `profileFieldPolicy.js`; extend `meProfile` with `GET /me/profile/full` returning every section + per-field policy. Add the additive `Employee` columns + `EmployeeEducation`/`EmployeeAddress` models + migration. Hoist `resolveSelfEmployee` into one shared lib. **Ship value:** the rich profile renders read-only with correct lock/edit badges.
- **Slice 13b — Self-edit writes.** The policy-split write resolver + `PATCH/PUT/POST/DELETE` for self-edit fields (contact, address w/ same-as, emergency ≤2, education, optional personal, family/nominee with ≤100% guard, photo upload). Audit + validation. **Ship value:** employees can edit the free/optional fields.
- **Slice 13c — Gated change-request → HR approval.** Wire `ProfileChangeRequest` + `ApprovalRequest(PROFILE_CHANGE)`: ESS submit, HR queue (`/api/hr/profile/change-requests`), approve (atomic per-model commit w/ version guard + statutory re-validation + SoD) / reject, notifications. ESS "pending approval" chips. **Ship value:** governed fields are safe + auditable.
- **Slice 13d — Manager Self-Service `/me/team/*`.** `resolveCustomerScope` (give the customer session the F1 band) + roster/attendance/directory/org reads (scoped, masked) and the merged leave+reimbursement approval inbox (capability + scope + SoD). **Ship value:** managers run their team from ESS.
- **Slice 13e — Org tree everywhere + polish.** Add `photoUrl` to `org.tree`, the ESS org view (`?root=me`), drill up/down in both apps, search, the two profile shortcut tiles, empty/loading/error states, a11y. **Ship value:** the Organization-Relationship view + the full Figma profile shipped end-to-end.

*(Optional 13f if scope grows: tenant-editable field-policy + multi-step `WorkflowStep` chains for profile approvals.)*

---

## 8. Reuse, refactors, and the one shared helper

`resolveSelfEmployee(businessId, customer)` is **copy-pasted three times** today (`meProfile.controller.js:29`, `meSeparation.controller.js:50`, `documents.controller`). Slice 13a hoists it to `backend/src/hr/lib/resolveSelfEmployee.js` (select superset, callers narrow) — **not a behaviour change**, a de-dup. `resolveCustomerScope` (13d) is the only new scope primitive and it **delegates to the existing `resolveAccessibleEmployeeIds`** — no second hierarchy walker. Everything else (CRUD factory pattern from `org.controller`, the `meLeave` route shape, `writeAudit`, `Notification`) is reused as-is.

---

## 9. Security, privacy & edge cases

- **Tenant wall:** every query carries `businessId` (from `req.customer`/`req.user`, never the body). New sub-models (`EmployeeEducation`/`EmployeeAddress`) carry `businessId` + the `@@index` and are written only via the session-resolved employee.
- **SELF_ONLY invariant preserved:** no ESS profile path accepts an `employeeId` (param or body) — the subject is always the session employee. A body `employeeId` is ignored, mirroring the existing `meSeparation`/`meLeave` guarantee.
- **Governance cannot be bypassed:** the *server* classifies every field by policy; a malicious client cannot self-edit a gated field (it is routed to approval) nor request-change a `read-only` field (400). Unknown `fieldKey` → fail-closed `read-only`.
- **SoD on approval:** the operator approving a `ProfileChangeRequest` must not be the request's own linked employee; reuses the `APPROVAL_ACTIONS` "drop self from scope" pattern so an HR operator can't approve their own gated change.
- **MSS scope = TEAM, self-excluded for approvals:** `/me/team/leave|reimbursement/decide` resolve with an `APPROVAL_ACTIONS` action, so a manager can never approve their own request even though it's "their team"; and a SELF-band employee hitting `/me/team/*` gets `[]` (their sub-tree minus self), never an error or another's data.
- **PII minimisation & masking:** new sensitive Personal fields (religion/community/blood group/height/weight/ID mark) are `@pii:sensitive`, returned only on the self read or to an in-scope operator; the team **directory** masks compensation via the existing `effectiveCompVisibility` (Manager → RANGE_ONLY) and hides sensitive personal PII. Statutory **numbers** are never echoed back in change-request lists for IDs we only flag (`aadhaarVerified`); we store the flag, not the number (schema already enforces).
- **Optimistic concurrency:** approve commits re-check the target row's `version` (Employee/BankAccount/StatutoryProfile all have it) and 409 on a concurrent operator edit, so an approval can't silently clobber a newer HR change.
- **Format validation twice:** statutory IDs (PAN/IFSC/IRD/NZ bank) validate at ESS submit *and* at HR commit; address/postal/phone are length+charset checked; nominee percentages must sum ≤100.
- **Terminated/inactive lockout:** the existing `isSeparatedEmployee` guard (`meSeparation.controller.js:35`) is reused — a separated employee's profile is read-only (no self-edit, no new change requests), matching the ESS lockout already shipped.
- **"Same as" integrity:** when an address has `sameAsType`, the writer stores the pointer (not a copy); the reader resolves it, so a later edit to the source address propagates and we never persist drift.
- **Idempotency:** address upsert is keyed `@@unique([businessId, employeeId, type])`; duplicate change requests for the same field while one is PENDING are collapsed (the latest supersedes, older auto-WITHDRAWN) to keep the HR queue clean.

---

## 10. Acceptance (per slice, abbreviated)
- 13a: `GET /me/profile/full` returns all sections with a `policy` on every field; an unknown field key resolves `read-only`; new models migrate clean.
- 13b: a self-edit to `phone` commits + audits; `address` "same as" toggles persist a pointer; emergency contacts cap at 2; nominee % > 100 rejected.
- 13c: editing `dateOfBirth` on ESS creates a `ProfileChangeRequest(PENDING)` + `ApprovalRequest(PROFILE_CHANGE)`, shows a pending chip; HR approve writes the value atomically + notifies; an operator can't approve their own; reject leaves the row untouched.
- 13d: a Manager session sees their sub-tree roster/attendance/approvals; a SELF employee gets `[]`; a manager cannot approve their own leave via `/me/team`; comp is range-masked in the directory.
- 13e: org tree renders Photo|Name|Position with drill up/down in both apps; profile shortcut tiles deep-link the existing letter/resignation flows.

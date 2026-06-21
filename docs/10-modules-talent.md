# 10 — Talent Modules: Performance Management & Recruitment (ATS)

> **Doc owner:** Senior Talent Systems Analyst
> **Status:** Production design (planned to production; phased — see §0.3). Authoritative functional + data spec for the **Performance** and **Recruitment/ATS** verticals of the HR console (`app.hr.com`) and their Employee Self-Service (ESS) surfaces (`tenant.com` / careers subdomain).
> **Surfaces:** Tenant Admin (HR console), Employee Self-Service (ESS), **public Careers page** (white-labelled, new surface variant), Super Admin (feature-flag + plan gating only).
> **Markets:** India (IN, INR) and New Zealand (NZ, NZD). Tax year **Apr–Mar** in both. Talent modules are **largely country-agnostic**; the country-sensitive seams are (a) appraisal→compensation linkage colliding with the IN Code-on-Wages "50% wages" rule, and (b) candidate/applicant data-protection (DPDP 2023/Rules 2025 in IN; Privacy Act 2020 in NZ). Those seams are called out explicitly.
> **Sibling docs (real files in `/Users/kp/docs`):** `00-vision-and-principles.md`, `01-product-requirements.md`, `02-system-architecture.md`, `03-data-model.md`, `04-payroll-engine-design.md`, `05-compliance-india.md`. **Forward-referenced siblings (planned):** `06-compliance-nz.md`, `07-leave-attendance.md`, `08-ess-mobile.md`, `09-api-surface.md`, `11-onboarding-lifecycle.md`, `12-superadmin-billing.md`, `13-notifications-i18n.md`. Where a planned sibling owns a concept, this doc references it rather than re-specifying.

---

## 0. Reading guide, reuse posture & phasing

### 0.1 What this document is

A **deep functional + data + API spec** for two modules that bracket the employee lifecycle:

1. **Recruitment / ATS** — *before* an employee exists: requisitions → sourcing → public careers page → candidate pipeline → interview scheduling → offer management → **onboarding handoff** (which mints the `Employee` row owned by `03-data-model.md`).
2. **Performance Management** — *during* employment: goals/OKRs → continuous feedback & 1:1s → review cycles (self / manager / peer / 360°) → calibration & ratings → **appraisal → compensation linkage** (which writes a `CompensationRevision` consumed by `04-payroll-engine-design.md`).

They are documented together because they share three substrates: (a) a **flexible, configured-not-built form/criteria model** (the platform's "pre-built system, not a builder" principle — tenants pick from fixed templates and toggle fields, they do **not** design layouts), (b) a **multi-actor approval + state-machine engine**, and (c) the **same audit/notification/RBAC plumbing** forked from Sitepresso.

### 0.2 Reuse posture (grounded in `/Users/kp/sitepresso`, read-only)

| Concern | Sitepresso anchor (verified real path) | Reuse for Talent modules |
|---|---|---|
| Tenant isolation | `businessId` + cascade FK repeated across `backend/prisma/schema.prisma` (e.g. `Product` line 551, `Appointment` line 2049); middleware referenced by `03-data-model.md` §1.2 | **Every** talent table carries `businessId` + composite index leading with `businessId`. Careers-page public reads scope by resolved tenant (router). |
| Custom RBAC | `backend/src/core/lib/rbac.js` `PERMISSIONS` registry (frozen object, JSON-stored on role, "never requires a schema migration"); `backend/src/core/lib/roles.js` `ROLES` | We **extend** the `PERMISSIONS` registry with a Talent permission block (§14). New roles: **Recruiter**, **Hiring Manager**, **Interviewer**, **Reviewer/Manager**, **HR Admin**, **Comp Admin**. No new role *table* — reuses `BusinessRole.permissions Json`. |
| Approval pattern | `StaffLeave` (line 2339) approve/reject lifecycle; `ConsentRecord` (line 2158) | Generalized into the shared `ApprovalRequest` (owned by `03-data-model.md`). Offer approvals, comp-change approvals, requisition approvals all route through it. |
| Scheduler / cron | `backend/src/scheduler-worker.js` + `backend/src/core/lib/scheduler.js` (`node-cron`, `nowInTimezone`, reminder sweeps like `processBookingReminders`) | Review-cycle phase transitions, nudge reminders, interview reminders, offer-expiry sweeps, candidate auto-purge (DPDP/Privacy-Act retention) all register as cron jobs here. |
| Notifications | `backend/src/core/lib/notifications/{router,templates,providers,countryRouting,budgetEngine}.js`; `EMAIL_EVENTS` in `emailEvents.js`; `InboxNotification` model (line 2397) | Talent events (interview invite, offer issued, review assigned, 1:1 scheduled) emit through the **same** router; templates added to the catalog; country routing (email/SMS/WhatsApp IN, email/SMS NZ) reused. |
| Document storage | `backend/src/core/lib/s3.js`; `AppointmentDocument` (line 2268), `EmailDelivery` (line 2480) | Résumés, offer PDFs, signed-offer artifacts, review exports stored via the same S3 helper with tenant-prefixed keys + signed URLs. |
| Sequence numbers | `InvoiceCounter { series @id, lastValue }` (line 1877) | `RequisitionCounter`, `CandidateCounter`, `OfferCounter`, `ReviewCycleCounter` — same advisory-lock sequence helper (`lib/sequence.ts`, see `03-data-model.md` §1.1). Human codes: `REQ-2026-0007`, `CAND-000412`, `OFF-2026-0031`. |
| Admin shell | `packages/admin-core` (`index.js`/`index.d.ts`); platform app `apps/platform/app/(unified-admin)` | Talent screens mount as HR-console modules inside the same unified-admin shell + `packages/ui` components (tables, drawers, kanban primitives). No new design system. |
| Public white-label surface | `apps/router/cloudflare-worker.js` tenant resolution; theming via `packages/theme-engine` (slimmed to 5 styles) | **Careers page** is a new public surface variant resolved by the router under the tenant's bound domain (`careers.tenant.com` or `tenant.com/careers`), themed by the tenant's one logo + one brand colour + one of 5 styles. **Configured, never built.** |
| i18n | `apps/platform/i18n`, `messages/`; existing en/hi | Careers page + ESS performance surfaces localized en/hi (IN) and en (NZ). Job-post *content* is tenant-authored free text, not translated by us. |

> **Anti-pattern guard (from the brief):** No page/form/layout builder. Tenants **configure** review templates, competency libraries, rating scales, interview kits, and careers branding by **selecting from fixed, versioned platform templates and toggling fields**. They cannot add arbitrary fields with arbitrary widgets, reposition sections, or inject HTML/CSS. The only "designable" thing on the careers page is the same 5-style/logo/colour set as the rest of the white-label.

### 0.3 Phasing (planned-to-production, not MVP-shortcut)

Both modules are **designed in full here** but ship in phases. Phasing is about *sequence*, not *scope reduction* — every state machine, schema, and edge case below is built eventually; nothing is "TBD".

| Phase | Window | Talent scope |
|---|---|---|
| **P1 (Core HR + Payroll)** | Launch | Neither module ships. The **onboarding handoff contract** (§7) and **CompensationRevision** write-path (§13) are *built and frozen* so later modules plug in without migration. |
| **P2 (Recruitment/ATS)** | Launch + 1 quarter | Requisitions, careers page, pipeline, scheduling, offers, onboarding handoff. Full §3–§7. |
| **P3 (Performance)** | Launch + 2 quarters | Goals/OKRs, continuous feedback/1:1, review cycles, calibration, appraisal→comp. Full §8–§13. |
| **P3.1** | +1 quarter | 360° external raters, 9-box, succession signals, competency analytics. |

This doc is the contract P2/P3 build against; P1 must not violate the handoff/comp-write interfaces in §7 and §13.

---

# PART A — RECRUITMENT / APPLICANT TRACKING SYSTEM (ATS)

## 1. Domain overview & actors

The ATS spans from "we have a hiring need" to "this person is now an employee". It deliberately **stops at the boundary** of the HR core: the moment an offer is accepted, the ATS emits an **onboarding handoff** event; the actual `Employee`/`EmploymentRecord`/`SalaryStructure` creation is owned by `03-data-model.md` + `11-onboarding-lifecycle.md`. This keeps a single source of truth for the employee record and avoids a "candidate becomes a ghost employee" dual-write hazard.

### 1.1 Actors & RBAC mapping

| Actor | Role (extends `roles.js`/`rbac.js`) | Primary capability |
|---|---|---|
| **Recruiter** | `RECRUITER` | Owns requisitions end-to-end, manages pipeline, schedules, drafts offers. |
| **Hiring Manager** | `HIRING_MANAGER` | Raises/approves requisitions, reviews shortlists, requests interviews, approves/declines offers within budget. |
| **Interviewer** | `INTERVIEWER` (often an existing `Employee` with no broader HR access) | Receives interview kit, submits scorecard. Sees **only** assigned candidates, **only** their own scorecard until panel reveal (§5.5). |
| **HR Admin** | `HR_ADMIN` | Configures pipelines, templates, careers branding, EEO/diversity settings, retention policy. Final offer approval gate. |
| **Comp Admin / Finance** | `COMP_ADMIN` | Approves offers exceeding salary band / requisition budget. |
| **Candidate** | external, no platform account | Applies via careers page; receives status emails; self-schedules where enabled; e-signs offer. Identified by token-link, not login. |
| **Agency / Referrer** | `AGENCY` (scoped) or any `Employee` (referral) | Submits candidates to specific reqs; sees only own-submitted candidates' high-level status. |

> **Interviewer least-privilege** is a hard requirement: an interviewer who is otherwise a regular employee must **not** gain visibility into salary, other candidates, or other roles. Enforced by row-level scoping on `InterviewAssignment` + a dedicated `canSubmitScorecard` permission, never by broad `canViewCandidates`.

### 1.2 Top-level entity map

```
Requisition ──< CandidateApplication >── Candidate
     │                   │                    │
     │                   │                    └──< CandidateConsent (DPDP/Privacy)
     │                   ├──< PipelineStageHistory
     │                   ├──< InterviewSchedule ──< InterviewAssignment ──< Scorecard
     │                   └──< Offer ──< OfferApproval (→ ApprovalRequest)
     │                                   └──> OnboardingHandoff (event → HR core)
     ├── JobPosting (public careers surface, 0..1 published version)
     └── RequisitionApproval (→ ApprovalRequest)
```

`Candidate` is **per-tenant** and **deduplicated within tenant** (a person can apply to many reqs). `CandidateApplication` is the junction carrying the per-req pipeline state. This separation is essential: GDPR/DPDP "right to erasure" and retention purge operate on `Candidate`; pipeline analytics operate on `CandidateApplication`.

---

## 2. Requisition

A **requisition** is the authorized hiring need: *what* role, *how many* heads, *which* budget, *which* approval chain, *which* pipeline template. It is the unit of authorization and the parent of all candidate activity.

### 2.1 Data model (`Requisition`)

```prisma
model Requisition {
  id              String   @id @default(uuid())
  businessId      String
  entityId        String              // legal entity the hire belongs to (PF/PT/ESI registration differs per entity)
  code            String              // REQ-2026-0007, tenant-scoped sequence
  title           String              // internal title (may differ from public JobPosting.title)
  status          ReqStatus @default(DRAFT)
  departmentId    String?
  designationId   String?             // links to HR core Designation (band → salary range)
  gradeId         String?             // links to Grade → salary band (drives offer guardrails §6.3)
  locationId      String?             // work-site; null ⇒ remote
  workMode        WorkMode            // ONSITE | HYBRID | REMOTE
  employmentType  EmploymentType      // FULL_TIME | PART_TIME | FIXED_TERM | CONTRACT | INTERN
  headcount       Int      @default(1)
  filledCount     Int      @default(0)
  priority        ReqPriority @default(NORMAL)
  // Budget guardrail (minor units + currency, per money discipline 04-payroll-engine §0)
  budgetMinAnnual BigInt?
  budgetMaxAnnual BigInt?
  currencyCode    String              // INR | NZD
  // Workflow config
  pipelineTemplateId String           // which stage set governs candidates here
  approvalChainId    String?          // resolved ApprovalRequest chain
  hiringManagerId    String           // Employee.id
  recruiterId        String?          // Employee.id (assigned owner)
  // Justification & metadata
  reason          ReqReason           // NEW_HEADCOUNT | BACKFILL | CONVERSION | SEASONAL
  backfillForEmployeeId String?       // if BACKFILL
  targetStartDate DateTime?
  openedAt        DateTime?
  closedAt        DateTime?
  closeReason     ReqCloseReason?
  confidential    Boolean  @default(false)  // hides from internal job board / interviewer titles
  createdById     String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([businessId, code])
  @@index([businessId, status])
  @@index([businessId, entityId, status])
  @@index([businessId, hiringManagerId])
}

enum ReqStatus { DRAFT PENDING_APPROVAL APPROVED OPEN ON_HOLD FILLED CLOSED CANCELLED REJECTED }
enum WorkMode { ONSITE HYBRID REMOTE }
enum EmploymentType { FULL_TIME PART_TIME FIXED_TERM CONTRACT INTERN }
enum ReqPriority { LOW NORMAL HIGH URGENT }
enum ReqReason { NEW_HEADCOUNT BACKFILL CONVERSION SEASONAL }
enum ReqCloseReason { FILLED CANCELLED FROZEN DUPLICATE NO_LONGER_NEEDED BUDGET_PULLED }
```

### 2.2 Requisition state machine

```
DRAFT ──submit──► PENDING_APPROVAL ──approve──► APPROVED ──publish/open──► OPEN
  │                     │ reject                                  │
  │                     ▼                                         ├─ hold ─► ON_HOLD ─resume─► OPEN
  │                  REJECTED ──edit/resubmit──► PENDING_APPROVAL │
  │                                                               ├─ filledCount==headcount ─► FILLED
  └── cancel ──► CANCELLED  (terminal)                            └─ close ─► CLOSED (with reason)
```

Guards & rules:
- **DRAFT → PENDING_APPROVAL** requires: title, entityId, headcount ≥ 1, employmentType, pipelineTemplateId, hiringManagerId. If `budgetMaxAnnual` exceeds the grade band ceiling, approval chain auto-escalates to `COMP_ADMIN`.
- **Approval** uses the shared `ApprovalRequest` engine (`03-data-model.md`). Chain resolved from a per-tenant `ReqApprovalPolicy` (e.g. *HM → Dept Head → Finance if > band, → HR Admin*). Parallel vs sequential approvals supported.
- **APPROVED → OPEN** may auto-publish a linked `JobPosting` (if configured) and start sourcing. `openedAt` stamped.
- **ON_HOLD** freezes new applications but retains pipeline; existing candidates can still progress (configurable).
- **FILLED** auto-set when `filledCount == headcount` (driven by accepted offers + handoff). Cannot accept further offers without re-opening/raising headcount (audited).
- **CANCELLED/CLOSED** require open candidates to be dispositioned first (or bulk-rejected with a templated reason → triggers DPDP/Privacy retention clocks §4.5).

### 2.3 Validation rules

| Rule | Enforcement |
|---|---|
| `headcount ≥ 1`; `filledCount ≤ headcount` | DB check + service. Over-fill needs explicit headcount increase (audited). |
| Budget currency must match `entity.currencyCode` | Service; cross-currency reqs disallowed (one req = one entity = one currency). |
| `budgetMin ≤ budgetMax` and both within grade band (warn, not block, for HIGH/URGENT) | Service; out-of-band reqs flag `requiresCompApproval`. |
| `backfillForEmployeeId` required iff `reason == BACKFILL` | Service. |
| `confidential` reqs excluded from internal job board, careers feed optional, and **mask title** in interviewer-facing views | Query-layer scoping. |
| Closing with open candidates | Blocked until dispositioned; bulk action available. |

---

## 3. Job posting & the white-label Careers page

A **`JobPosting`** is the *public* face of a requisition. One requisition has 0..1 *published* posting (plus version history). Posting content is tenant-authored text within a **fixed template** — title, location, description (rich-but-constrained: headings/lists/bold, no script/iframe), responsibilities, requirements, comp-display policy. **No layout building.**

### 3.1 Data model (`JobPosting`)

```prisma
model JobPosting {
  id            String   @id @default(uuid())
  businessId    String
  requisitionId String
  slug          String              // careers URL slug, unique per tenant
  status        PostingStatus @default(DRAFT)
  title         String              // public title
  descriptionRich Json              // sanitized rich text (allowlist nodes only)
  responsibilities String[]
  requirements     String[]
  niceToHave       String[]
  locationLabel  String             // "Bengaluru, IN" / "Auckland, NZ" / "Remote (NZ)"
  workMode       WorkMode
  employmentType EmploymentType
  // Compensation transparency (jurisdiction-aware default, see §3.4)
  compDisplay    CompDisplayMode @default(HIDDEN)
  compMinMinor   BigInt?
  compMaxMinor   BigInt?
  currencyCode   String?
  // Screening
  screeningQuestionSetId String?    // configured question set (knockout/scored)
  applyMode      ApplyMode @default(FORM)   // FORM | EXTERNAL_URL | EMAIL
  externalApplyUrl String?
  // Distribution
  postToInternalBoard Boolean @default(true)
  postToPublicCareers Boolean @default(true)
  jobBoardSyndication String[]     // ["LINKEDIN","NAUKRI","SEEK","INDEED"] (P2.1 connectors)
  // SEO (bounded — no arbitrary head injection)
  seoTitle       String?
  seoDescription String?
  publishedAt    DateTime?
  expiresAt      DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([businessId, slug])
  @@index([businessId, status])
}

enum PostingStatus { DRAFT PENDING_REVIEW PUBLISHED PAUSED EXPIRED ARCHIVED }
enum CompDisplayMode { HIDDEN RANGE EXACT FROM }
enum ApplyMode { FORM EXTERNAL_URL EMAIL }
```

### 3.2 Careers page — surface, theming, screens

- **Resolution:** served by the existing router (`apps/router/cloudflare-worker.js`) for the tenant's bound domain at `/<careers-path>` (default `/careers`) or a `careers.` subdomain. White-labelled via `packages/theme-engine` (logo + one brand colour + one of 5 fixed styles). The platform's "Powered by" is **off** by default for paid tiers (plan-gated via `Business.featureFlags`).
- **Public screens (read-only, SSR, indexable):**
  1. **Job list** — published postings, filter by department/location/work-mode/type. Confidential reqs excluded.
  2. **Job detail** — description, responsibilities, requirements, comp display per policy, "Apply" CTA, structured-data (`JobPosting` schema.org) for SEO.
  3. **Apply form** — fixed field set (§3.3) + résumé upload + configured screening questions + **explicit consent checkbox** (§4.4). No CAPTCHA-free submit (bot guard via Turnstile, reusing Cloudflare).
  4. **Application confirmation** — reference code (`CAND-…/REQ-…`), what-happens-next, link to candidate self-service portal (token-based).
  5. **Candidate portal (token link, no password)** — view application status (coarse-grained, recruiter-controlled labels), upload requested docs, self-schedule interview (§5.4), accept/decline & e-sign offer (§6.6), exercise data rights (§4.6).

### 3.3 Apply form — fixed, configurable field set

The form is **template-driven**: a base set always present, plus toggles HR enables. HR cannot add arbitrary widgets.

| Field | Type | Default | Configurable |
|---|---|---|---|
| Full name | text | required | — |
| Email | email | required | — |
| Phone | tel (+country) | required | optional toggle |
| Résumé/CV | file (pdf/doc/docx ≤ 10MB) | required | parser auto-extracts (§4.2) |
| Cover letter | textarea / file | off | toggle |
| LinkedIn URL | url | off | toggle |
| Portfolio URL | url | off | toggle |
| Current location | text | off | toggle |
| Notice period | enum | off | toggle (IN-relevant) |
| Current/expected CTC | money | off | toggle; **suppressible** where pay-history asks are sensitive |
| Work eligibility / visa | enum | off | toggle (NZ: visa status; IN: n/a usually) |
| Screening questions | from `ScreeningQuestionSet` | per posting | knockout or scored |
| Source / "how did you hear" | enum | on | — |
| **Consent** | checkbox + notice link | **required** | notice text per jurisdiction (§4.4) |
| EEO/diversity (voluntary) | enum | off | toggle; **stored separately, never in hiring view** (§3.5) |

### 3.4 Compensation-transparency display policy (jurisdiction defaults)

| Jurisdiction | Default `compDisplay` | Rationale |
|---|---|---|
| IN | `HIDDEN` (tenant may opt to `RANGE`) | No statutory pay-range posting mandate as of 2026; cultural norm to negotiate. |
| NZ | `RANGE` recommended (tenant default `HIDDEN`, nudge to `RANGE`) | Growing pay-transparency expectation; not yet a hard statutory mandate in 2026, so we *nudge* not *force*. |

We surface the choice with guidance text but **do not** legally mandate; if NZ pay-transparency legislation lands we flip the default via a Super-Admin compliance flag (no code change).

### 3.5 EEO / diversity data — strict firewall

Voluntary diversity fields (gender, ethnicity, disability) are stored in a **separate `CandidateDiversity` row keyed by candidate**, encrypted at rest, **never joined into any hiring-decision view, scorecard, or recruiter list**. Visible only as aggregate analytics (k-anonymity ≥ 5 buckets) to HR Admin. This is a privacy-by-design control and a defensibility feature, not an afterthought.

---

## 4. Candidate, application, consent & retention

### 4.1 Data model (`Candidate`, `CandidateApplication`)

```prisma
model Candidate {
  id            String   @id @default(uuid())
  businessId    String
  code          String              // CAND-000412
  fullName      String
  email         String              // dedup key within tenant (normalized lower)
  phone         String?
  resumeKey     String?             // S3 key (tenant-prefixed)
  parsedProfile Json?               // structured parse (skills, exp, education)
  linkedinUrl   String?
  portfolioUrl  String?
  source        CandidateSource
  sourceDetail  String?             // referrer employeeId / agency / campaign
  tags          String[]
  // Lifecycle / privacy
  status        CandidateStatus @default(ACTIVE)   // ACTIVE | ARCHIVED | ERASURE_REQUESTED | ERASED | ANONYMISED
  consentState  ConsentState @default(GRANTED)
  retentionUntil DateTime?          // computed purge date (§4.5)
  lastActivityAt DateTime @default(now())
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([businessId, email])     // dedup within tenant
  @@unique([businessId, code])
  @@index([businessId, status])
  @@index([businessId, retentionUntil])
}

model CandidateApplication {
  id            String   @id @default(uuid())
  businessId    String
  candidateId   String
  requisitionId String
  jobPostingId  String?
  stageId       String              // current PipelineStage
  stageEnteredAt DateTime @default(now())
  status        AppStatus @default(ACTIVE)  // ACTIVE | HIRED | REJECTED | WITHDRAWN | ON_HOLD
  rejectReasonId String?
  rejectReasonNote String?
  screeningScore Int?
  knockoutFailed Boolean @default(false)
  rating        Int?                // 1..5 overall recruiter rating
  referredById  String?
  appliedAt     DateTime @default(now())
  decidedAt     DateTime?
  source        CandidateSource
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([businessId, candidateId, requisitionId])  // one application per candidate per req
  @@index([businessId, requisitionId, stageId])
  @@index([businessId, candidateId])
  @@index([businessId, status])
}

enum CandidateSource { CAREERS_PAGE REFERRAL AGENCY JOB_BOARD SOURCED IMPORT INTERNAL_TRANSFER REHIRE }
enum CandidateStatus { ACTIVE ARCHIVED ERASURE_REQUESTED ERASED ANONYMISED }
enum ConsentState { GRANTED WITHDRAWN EXPIRED }
enum AppStatus { ACTIVE HIRED REJECTED WITHDRAWN ON_HOLD }
```

### 4.2 Résumé parsing

On upload, an async job (registered on the scheduler-worker) extracts text and produces `parsedProfile` (name, emails, phones, skills, experiences, education, total-years). Parser is a pluggable provider (self-hosted or 3rd-party). Parsing **never auto-rejects**; it only pre-fills and powers search. Re-parse on demand. Parser failures degrade gracefully (manual entry).

### 4.3 Deduplication & merge

- Dedup key: `(businessId, lower(email))`. Secondary signal: phone + fuzzy name.
- A returning applicant gets a **new `CandidateApplication`** against the existing `Candidate`. Recruiter sees full prior history ("applied 2024, rejected at Onsite").
- **Merge** UI for accidental duplicates (different emails, same person): merges applications, résumés, notes; preserves audit; cannot merge across tenants.

### 4.4 Consent capture (DPDP IN / Privacy Act NZ)

Every careers submission requires an explicit, unbundled consent tied to a **versioned privacy notice**:

```prisma
model CandidateConsent {
  id            String   @id @default(uuid())
  businessId    String
  candidateId   String
  noticeVersion String              // version of the privacy notice shown
  purpose       String[]            // ["recruitment_this_role","talent_pool","background_check"]
  jurisdiction  String              // "IN" | "NZ"
  channel       String              // "careers_form" | "import" | "agency"
  ipAddress     String?
  userAgent     String?
  grantedAt     DateTime @default(now())
  withdrawnAt   DateTime?
  createdAt     DateTime @default(now())

  @@index([businessId, candidateId])
}
```

- **IN (DPDP Act 2023 + DPDP Rules 2025):** consent must be **free, specific, informed, unconditional, by clear affirmative action**; itemized notice; purpose-bound; withdrawable as easily as granted. Talent-pool retention (keeping a rejected candidate for future roles) is a **separate purpose** requiring its own opt-in checkbox. The DPDP **Rules were notified 13 Nov 2025**, with the consent/notice/rights provisions coming into force **13 May 2027** (consent-manager provisions 13 Nov 2026) — so we **build to the standard now** and gate enforcement strictness by a Super-Admin effective-date flag. Consent records carry long retention (the rules contemplate multi-year consent-record retention). [Sources §16.]
- **NZ (Privacy Act 2020):** collection must be for a lawful purpose connected to the role and limited to what's necessary (IPP1–4); openness/notice (IPP3); **retention no longer than required** (IPP9). Pre-employment checks (criminal, reference, drug/alcohol) only where **relevant to safe/proper performance** of the role. [Sources §16.]

### 4.5 Retention & auto-purge (the compliance-critical sweep)

```prisma
model RetentionPolicy {
  id                 String @id @default(uuid())
  businessId         String
  jurisdiction       String              // "IN" | "NZ" | "DEFAULT"
  rejectedRetainDays Int                 // default NZ 365 (min), IN configurable
  talentPoolRetainDays Int               // only if talent-pool consent granted
  hiredArchiveDays   Int                 // candidate record retained post-hire then anonymised
  autoPurge          Boolean @default(true)
  updatedAt          DateTime @updatedAt
  @@unique([businessId, jurisdiction])
}
```

Defaults (effective-dated, Super-Admin overridable):

| Jurisdiction | Rejected applicant retention | Basis |
|---|---|---|
| **NZ** | **≥ 365 days**, then secure destroy unless talent-pool consent | Privacy Act IPP9 + Employment NZ guidance: unsuccessful applicant info kept **at least 12 months**, then securely destroyed. |
| **IN** | Purpose-bound; default **180 days** rejected (configurable up to talent-pool window), consent records retained long-term | DPDP purpose-limitation + Rules' prescriptive retention/erasure posture. |

- A nightly cron (registered like `processBookingReminders` in `scheduler.js`) computes `retentionUntil` per candidate from policy + `lastActivityAt`/disposition, then **anonymises** (strips PII, keeps aggregate funnel metrics) or **hard-deletes** per policy.
- **Erasure request** (DPDP right / NZ access+correction): candidate self-serves from the portal → sets `status = ERASURE_REQUESTED` → SLA-bound recruiter review (legal-hold check) → `ERASED`/`ANONYMISED`. Audited end-to-end.
- **Legal hold** flag pins a candidate against purge (active dispute/claim).

### 4.6 Candidate data-subject rights flows

| Right | IN | NZ | Implementation |
|---|---|---|---|
| Access (copy of data) | ✔ | ✔ (IPP6) | Portal "Download my data" → signed export bundle. |
| Correction | ✔ | ✔ (IPP7) | Portal edit request → recruiter review. |
| Erasure / destruction | ✔ (DPDP) | ✔ (via IPP9 retention) | §4.5 flow. |
| Withdraw consent | ✔ (as easy as grant) | n/a (notice model) | One-click; sets `consentState=WITHDRAWN`, triggers purge eval. |
| Grievance / nominee | ✔ (DPDP grievance + nominee) | Privacy Commissioner complaint | Tenant's configured DPO/contact surfaced in notice. |

---

## 5. Pipeline, interviews & scorecards

### 5.1 Pipeline template (configured, not built)

A **`PipelineTemplate`** is an ordered list of stages selected/toggled from a platform catalog. Tenants reorder/enable/disable stages and rename labels; they do **not** invent stage *behaviours*. Each stage has a **type** that governs its mechanics.

```prisma
model PipelineTemplate {
  id          String  @id @default(uuid())
  businessId  String
  name        String
  isDefault   Boolean @default(false)
  archived    Boolean @default(false)
  @@unique([businessId, name])
}

model PipelineStage {
  id          String  @id @default(uuid())
  businessId  String
  templateId  String
  order       Int
  label       String              // tenant label e.g. "Tech Screen"
  type        StageType           // governs mechanics + automations
  slaHours    Int?                // stage-age SLA → nudges
  autoReject  Boolean @default(false)  // e.g. knockout failures
  requiresScorecard Boolean @default(false)
  @@unique([businessId, templateId, order])
  @@index([businessId, templateId])
}

enum StageType {
  APPLIED SCREEN SHORTLIST ASSESSMENT PHONE_SCREEN
  INTERVIEW PANEL REFERENCE_CHECK BACKGROUND_CHECK
  OFFER_PENDING OFFER_EXTENDED HIRED REJECTED WITHDRAWN
}
```

Default templates ship per common shape (e.g. *Applied → Screen → Phone Screen → Onsite/Panel → Reference → Offer → Hired*). A "rejected" and "withdrawn" terminal exist parallel to every active stage (Kanban "reject from anywhere").

### 5.2 Pipeline UI (HR console)

- **Kanban board** per requisition: columns = stages; cards = `CandidateApplication`. Drag to advance/reject. Card shows photo-optional, name, rating, days-in-stage (SLA colour), source, flags (knockout, referral, internal).
- **List/table view** with bulk actions (advance, reject-with-reason, email, tag, assign interviewer).
- **Candidate profile drawer:** timeline (stage history, emails, notes, interviews, scorecards), résumé preview, parsed profile, all applications across reqs, consent/retention status.
- **Stage transition** writes `PipelineStageHistory` (immutable), fires notifications + automations (templated candidate email, interviewer assignment prompt, offer trigger).

```prisma
model PipelineStageHistory {
  id            String   @id @default(uuid())
  businessId    String
  applicationId String
  fromStageId   String?
  toStageId     String
  movedById     String
  reason        String?
  movedAt       DateTime @default(now())
  @@index([businessId, applicationId, movedAt])
}
```

### 5.3 Interview scheduling

```prisma
model InterviewSchedule {
  id            String   @id @default(uuid())
  businessId    String
  applicationId String
  stageId       String
  title         String              // "Technical Panel — System Design"
  mode          InterviewMode       // ONSITE | VIDEO | PHONE
  location      String?             // room / address / video link
  startAt       DateTime
  endAt         DateTime
  timezone      String              // IANA, candidate-facing
  status        InterviewStatus @default(SCHEDULED)
  interviewKitId String?            // questions/competencies to assess
  schedulingMode SchedulingMode @default(MANUAL)  // MANUAL | SELF_SCHEDULE
  rescheduleOfId String?
  cancelReason   String?
  createdById    String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([businessId, applicationId])
  @@index([businessId, startAt])
}

model InterviewAssignment {
  id            String   @id @default(uuid())
  businessId    String
  interviewId   String
  interviewerId String              // Employee.id
  role          PanelRole           // LEAD | PANELIST | SHADOW
  responseStatus InviteResponse @default(PENDING)  // ACCEPTED | DECLINED | TENTATIVE
  scorecardId   String?
  @@unique([businessId, interviewId, interviewerId])
  @@index([businessId, interviewerId])
}

enum InterviewMode { ONSITE VIDEO PHONE }
enum InterviewStatus { SCHEDULED RESCHEDULED COMPLETED NO_SHOW CANCELLED }
enum SchedulingMode { MANUAL SELF_SCHEDULE }
enum PanelRole { LEAD PANELIST SHADOW }
enum InviteResponse { PENDING ACCEPTED DECLINED TENTATIVE }
```

Mechanics:
- **Availability:** interviewer availability read from calendar integration (Google/Microsoft via OAuth — P2.1) or from the HR-core shift/working-hours model (`07-leave-attendance.md`). Conflict detection against existing interviews + leave.
- **Self-schedule:** recruiter publishes a slot set; candidate picks via token portal; books atomically (Redis lock to prevent double-book, reusing the booking-lock pattern from Sitepresso's appointment engine).
- **Notifications:** calendar invites (.ics) + email/SMS via the shared router; reminders T-24h/T-1h (cron). Candidate reschedule/cancel allowed within a window.
- **Video:** generate meeting link via provider (Zoom/Meet/Teams — P2.1) or paste manual link.

### 5.4 Interview kit & scorecard (structured, bias-reduced)

An **interview kit** binds a stage to a set of **competencies** + suggested questions (from the shared competency library, §9). The **scorecard** is the structured output — per-competency rating + overall recommendation + notes. Scorecards are **private until panel reveal** to reduce anchoring.

```prisma
model Scorecard {
  id            String   @id @default(uuid())
  businessId    String
  interviewId   String
  applicationId String
  interviewerId String
  overall       HireRecommendation   // STRONG_YES | YES | NO | STRONG_NO
  competencyScores Json               // [{competencyId, rating 1-4, note}]
  strengths     String?
  concerns      String?
  privateNotes  String?              // visible to recruiter/HM only, not panel
  submittedAt   DateTime?
  status        ScorecardStatus @default(DRAFT)  // DRAFT | SUBMITTED
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@unique([businessId, interviewId, interviewerId])
  @@index([businessId, applicationId])
}

enum HireRecommendation { STRONG_YES YES NO STRONG_NO }
enum ScorecardStatus { DRAFT SUBMITTED }
```

- **Reveal rule:** an interviewer cannot see peers' scorecards until they submit their own **or** the recruiter force-reveals. Prevents groupthink.
- **Aggregation:** panel view shows distribution per competency, overall recommendation tally, divergence flags.

### 5.5 Disposition / rejection

- **Reject reasons** are a configured, analytics-friendly taxonomy (`RejectReason` table: e.g. *Skills gap, Comp mismatch, Failed assessment, Position filled, Withdrew, Better candidate*). Free-text note optional.
- Rejection fires a **templated, jurisdiction-appropriate candidate email** (configurable delay, optional "feedback offered" mode). Bulk reject on req close.
- Disposition sets `decidedAt`, starts the retention clock (§4.5).

---

## 6. Offer management

The offer is the highest-stakes ATS artifact: it crosses into **compensation** (so it must respect salary bands and, in IN, the Code-on-Wages 50% structure), requires **multi-party approval**, becomes a **legal document**, and triggers the **onboarding handoff**.

### 6.1 Data model (`Offer`)

```prisma
model Offer {
  id            String   @id @default(uuid())
  businessId    String
  entityId      String
  applicationId String
  candidateId   String
  requisitionId String
  code          String              // OFF-2026-0031
  status        OfferStatus @default(DRAFT)
  // Position
  designationId String
  gradeId       String?
  departmentId  String?
  locationId    String?
  workMode      WorkMode
  employmentType EmploymentType
  managerId     String?             // future reporting manager (Employee.id)
  proposedStartDate DateTime
  probationMonths Int?
  // Compensation (structured so IN 50% rule + payroll can validate)
  currencyCode  String
  ctcAnnualMinor BigInt             // total cost-to-company / total remuneration
  compComponents Json               // [{code:"BASIC", annualMinor, kind:"WAGE"|"ALLOWANCE"|"VARIABLE"|"EMPLOYER_STAT"}]
  variablePayMinor BigInt?
  signOnBonusMinor BigInt?
  // Versioning
  version       Int      @default(1)
  supersedesOfferId String?
  // Approval & delivery
  approvalRequestId String?
  letterTemplateId  String?
  letterPdfKey      String?         // generated, immutable per version
  // Candidate response
  sentAt        DateTime?
  expiresAt     DateTime?
  respondedAt   DateTime?
  declineReason String?
  signatureKey  String?             // e-sign artifact
  signedAt      DateTime?
  createdById   String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([businessId, code])
  @@index([businessId, applicationId])
  @@index([businessId, status, expiresAt])
}

enum OfferStatus {
  DRAFT PENDING_APPROVAL APPROVED SENT
  NEGOTIATING REVISED ACCEPTED DECLINED
  EXPIRED RESCINDED HANDED_OFF
}
```

### 6.2 Offer state machine

```
DRAFT ──submit──► PENDING_APPROVAL ──approve──► APPROVED ──send──► SENT
  ▲                    │ reject                                      │
  │                    ▼                                             ├─ candidate accepts ─► ACCEPTED ─► HANDED_OFF (→ onboarding)
  │                 (back to DRAFT)                                  ├─ candidate declines ─► DECLINED (terminal)
  └── revise (new version) ◄── NEGOTIATING ◄── candidate counters ──┤
                                  │                                  ├─ expiry passes ─► EXPIRED
        REVISED ──re-approve──► (SENT again)                         └─ employer pulls ─► RESCINDED (terminal, audited, reason req.)
```

Guards:
- **DRAFT → PENDING_APPROVAL:** comp validated (§6.3). Out-of-band or over-budget ⇒ chain escalates to `COMP_ADMIN`.
- **APPROVED → SENT:** generates immutable letter PDF (§6.5) for that version; stamps `expiresAt` (default 7 days, configurable).
- **NEGOTIATING/REVISED:** a counter creates a **new version** (`version+1`, `supersedesOfferId`), re-enters approval. Prior versions retained, never mutated.
- **ACCEPTED → HANDED_OFF:** emits onboarding handoff (§7); increments `Requisition.filledCount`; locks the offer.
- **RESCINDED:** allowed pre-acceptance with reason; post-acceptance rescission is a serious action — requires HR Admin + legal-ack, heavily audited (potential liability), surfaces a warning re: IN/NZ wrongful-withdrawal exposure.

### 6.3 Compensation validation — the country-sensitive seam

The offer's `compComponents` must pass a **pre-flight against the payroll engine** (`04-payroll-engine-design.md`) *before* approval, so an offer can never produce a non-compliant or non-payable structure:

| Check | IN | NZ |
|---|---|---|
| **Wage-floor 50% rule (Code on Wages, live 21 Nov 2025; fully operational 1 Apr 2026)** | `Σ(WAGE-kind components: Basic + DA + retaining allowance) ≥ 50% of total remuneration`. If excluded items (HRA, conveyance, etc.) exceed 50%, the **excess is added back to wages** — the offer builder warns and auto-suggests a compliant split. This cascades into PF (12% on wages) & gratuity. [Sources §16.] | n/a |
| **Minimum wage** | ≥ applicable state/scheduled-employment minimum (e.g. Apr-2026 central VDA revision; Delhi unskilled ₹18,456/mo per 2025 notification — engine reads live rule table, not hard-coded). | ≥ **adult minimum wage NZ$23.95/hr from 1 Apr 2026** (for the implied hourly of the role). [Sources §16.] |
| **Salary band** | within `gradeId` band (warn/escalate if not). | same. |
| **Statutory employer cost preview** | PF/EPS/EDLI/ESI (if gross ≤ ₹21,000)/gratuity accrual shown as informational employer cost. | KiwiSaver **employer min 3.5% from 1 Apr 2026** (→4% in 2028; 16–17yo now eligible), ESCT, ACC earner levy **1.75% on first NZ$156,641 from 1 Apr 2026**. [Sources §16.] |
| **Net-pay illustration** | new tax regime default; §87A nil tax to ~₹12L taxable; ₹75k standard deduction; PT (state, ≤ ₹2,500/yr). | PAYE, KiwiSaver, ESCT, student loan if applicable. |

This pre-flight reuses the engine's *calculate-but-don't-disburse* design (`04-payroll-engine-design.md` §0) to produce an **offer net-pay illustration** the candidate can see, without creating any payroll artifact.

### 6.4 Offer approval chain

Resolved from `OfferApprovalPolicy` (per tenant/entity). Typical: *Recruiter drafts → HM approves → Finance/Comp approves if over band/budget → HR Admin final*. Uses shared `ApprovalRequest`. Parallel approvals + delegation + reminders + auto-escalation on SLA breach (cron).

### 6.5 Offer letter generation (white-label, template-bound)

- Letter is rendered from a **fixed, versioned template** (header = tenant logo/brand colour; body = merge fields: name, designation, comp table, start date, probation, statutory annexure). HR selects a template + edits **allowed merge/clause toggles only** — no free layout. Country-specific clause packs (IN appointment-letter conventions incl. Code-on-Wages-compliant comp annexure; NZ employment-agreement essentials per Employment NZ, incl. mandatory written agreement, 90-day trial only if lawfully applicable).
- Rendered to **immutable PDF per version**, stored via `s3.js`, hash-stamped for tamper evidence.

### 6.6 Candidate offer experience & e-sign

- Candidate views offer in token portal: comp breakdown, start date, letter PDF, accept/decline/counter (if negotiation enabled).
- **E-sign:** lightweight in-portal signature (typed/drawn) + audit trail (IP, timestamp, UA, OTP-verified email/phone). For jurisdictions/tenants needing stronger e-sign, pluggable provider (DocuSign/Aadhaar e-Sign IN — P2.1). Signature artifact stored immutably.
- Acceptance is atomic with handoff emission (§7) inside one transaction.

---

## 7. Onboarding handoff — the ATS↔HR-core contract (built in P1, frozen)

The single most important integration boundary. On `Offer.ACCEPTED`, the ATS emits an **`OnboardingHandoff`** — a typed, idempotent event consumed by the HR core (`03-data-model.md`) + onboarding module (`11-onboarding-lifecycle.md`). The ATS **does not** create the `Employee`.

```prisma
model OnboardingHandoff {
  id            String   @id @default(uuid())
  businessId    String
  entityId      String
  offerId       String   @unique         // exactly one handoff per accepted offer
  candidateId   String
  status        HandoffStatus @default(EMITTED)  // EMITTED | CONSUMED | EMPLOYEE_CREATED | FAILED
  payload       Json                     // frozen snapshot: identity, designation, grade, comp components, start date, manager, location, entity
  employeeId    String?                  // back-filled by HR core when Employee minted
  idempotencyKey String  @unique         // = offerId:version (replay-safe)
  emittedAt     DateTime @default(now())
  consumedAt    DateTime?
  error         String?
  @@index([businessId, status])
}

enum HandoffStatus { EMITTED CONSUMED EMPLOYEE_CREATED FAILED }
```

Contract rules:
- **Idempotent:** keyed by `offerId:version`. Replays are no-ops (mirrors Sitepresso's webhook-dedup ledgers `PaddleWebhookEvent`/`StripeWebhookEvent`, `schema.prisma:1622–1690`).
- **Snapshot, not reference:** payload copies the accepted comp + position so later candidate-record edits never retro-alter the new employee (same discipline as `04-payroll-engine-design.md` §0 "inputs are snapshotted").
- **Mapping:** HR core maps `candidate → Employee` (creating `User` only if portal access granted), `compComponents → SalaryStructure`, `designation/grade/manager/location/entity → EmploymentRecord`. The **same comp components that passed offer pre-flight (§6.3)** become the salary structure — guaranteeing offer↔payroll consistency.
- **Pre-boarding window:** between accept and start date, the candidate can be invited to a **pre-boarding** ESS flow (document collection: PAN/Aadhaar/bank for IN; IRD number/KiwiSaver election/bank for NZ) owned by `11-onboarding-lifecycle.md`; the ATS just hands the baton.
- **Failure handling:** if employee creation fails (validation, duplicate), handoff goes `FAILED` with error; HR Admin alerted; offer remains `HANDED_OFF` but flagged; ret riable.

### 7.1 ATS analytics (funnel & quality-of-hire)

| Metric | Definition |
|---|---|
| Time-to-fill | req `openedAt` → offer `ACCEPTED`. |
| Time-to-hire | candidate `appliedAt` → offer `ACCEPTED`. |
| Stage conversion | per-stage advance rate; bottleneck heatmap. |
| Source effectiveness | hires & quality by `CandidateSource`. |
| Offer accept rate | accepted / sent. |
| Interview load | scorecards & hours per interviewer (avoid overload). |
| Pipeline aging | apps breaching stage SLA. |
| Diversity funnel | aggregate-only, k-anon ≥ 5 (§3.5). |
| Quality-of-hire | joins to performance (§13): new-hire 90-day rating, first-cycle rating — closes the talent loop. |

---

# PART B — PERFORMANCE MANAGEMENT

## 8. Domain overview & actors

Performance management is **continuous + cyclical**: an always-on layer (goals, feedback, 1:1s) and a periodic layer (review cycles). The output of a cycle can **link to compensation** — the second country-sensitive seam (IN 50% wage rule on increments).

### 8.1 Actors

| Actor | Role | Capability |
|---|---|---|
| **Employee** | `EMPLOYEE` (ESS) | Sets/updates own goals (per policy), self-assessment, requests/gives feedback, schedules 1:1s, views own ratings/comp letter. |
| **Manager** | `MANAGER` | Goal approval, manager assessment, calibration input, 1:1s, proposes increments (within guardrails). |
| **Reviewer (peer/360)** | scoped per-cycle | Submits peer/upward/external review only for assigned subjects. |
| **HR Admin** | `HR_ADMIN` | Configures competency library, rating scales, cycle templates, launches cycles, runs calibration, publishes results. |
| **Comp Admin** | `COMP_ADMIN` | Owns increment budget pools, approves merit matrix, finalizes `CompensationRevision`. |
| **Skip-level / Dept Head** | derived from org tree | Calibration committee membership, second-level approvals. |

---

## 9. Goals / OKRs

### 9.1 Data model

```prisma
model Goal {
  id            String   @id @default(uuid())
  businessId    String
  ownerEmployeeId String
  cycleId       String?              // optional binding to a review cycle / OKR period
  parentGoalId  String?              // alignment (cascade up to team/company)
  type          GoalType             // OKR_OBJECTIVE | OKR_KEYRESULT | SMART_GOAL | COMPETENCY_GOAL
  title         String
  description   String?
  category      GoalCategory         // BUSINESS | DEVELOPMENT | BEHAVIOURAL | PROJECT
  weight        Int      @default(0) // % weight within owner's goal set (Σ ≤ 100, validated)
  // Measurement
  metricType    MetricType           // PERCENT | NUMERIC | CURRENCY | MILESTONE | BOOLEAN
  startValue    Decimal? @db.Decimal(18,4)
  targetValue   Decimal? @db.Decimal(18,4)
  currentValue  Decimal? @db.Decimal(18,4)
  unit          String?
  // Lifecycle
  status        GoalStatus @default(DRAFT)
  progressPct   Int      @default(0)  // computed or manual
  confidence    GoalConfidence?       // ON_TRACK | AT_RISK | OFF_TRACK (OKR check-ins)
  visibility    GoalVisibility @default(MANAGER)  // PRIVATE | MANAGER | TEAM | COMPANY
  startDate     DateTime?
  dueDate       DateTime?
  closedAt      DateTime?
  finalScore    Decimal? @db.Decimal(5,4)  // 0..1 OKR grading at close
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([businessId, ownerEmployeeId, status])
  @@index([businessId, cycleId])
  @@index([businessId, parentGoalId])
}

enum GoalType { OKR_OBJECTIVE OKR_KEYRESULT SMART_GOAL COMPETENCY_GOAL }
enum GoalCategory { BUSINESS DEVELOPMENT BEHAVIOURAL PROJECT }
enum MetricType { PERCENT NUMERIC CURRENCY MILESTONE BOOLEAN }
enum GoalStatus { DRAFT ACTIVE ON_HOLD ACHIEVED PARTIALLY_ACHIEVED MISSED CANCELLED }
enum GoalConfidence { ON_TRACK AT_RISK OFF_TRACK }
enum GoalVisibility { PRIVATE MANAGER TEAM COMPANY }

model GoalCheckin {
  id        String   @id @default(uuid())
  businessId String
  goalId    String
  byEmployeeId String
  value     Decimal? @db.Decimal(18,4)
  progressPct Int?
  confidence GoalConfidence?
  note      String?
  createdAt DateTime @default(now())
  @@index([businessId, goalId, createdAt])
}
```

### 9.2 OKR mechanics & rules

- **Alignment tree:** `parentGoalId` lets a key result roll up to an objective, an objective to a team/company objective. UI renders an alignment graph. Cascade is *advisory*, not enforced.
- **Weighting:** within an employee's goal set bound to a cycle, weights validate to ≤ 100% (or auto-normalize, configurable). Powers weighted goal score in reviews (§11.4).
- **Scoring:** OKR grade 0.0–1.0 at close; SMART goals use the rating scale. `progressPct` either manual or computed from `currentValue` vs `start/target`.
- **Check-in cadence:** scheduler nudges owners to check in (weekly/fortnightly per policy), reusing the reminder-sweep pattern.
- **Goal locking:** once a cycle's self/manager assessment opens, goals can be **frozen** so scope doesn't shift mid-review (audited; unfreeze requires manager).
- **Visibility:** `PRIVATE` (self only), `MANAGER`, `TEAM`, `COMPANY`. Company-visible goals power the transparency board (plan-gated).

---

## 10. Continuous feedback & 1:1s

### 10.1 Continuous feedback

```prisma
model Feedback {
  id            String   @id @default(uuid())
  businessId    String
  fromEmployeeId String
  toEmployeeId  String
  type          FeedbackType         // PRAISE | CONSTRUCTIVE | REQUESTED | UPWARD
  visibility    FeedbackVisibility   // PRIVATE_TO_RECEIVER | RECEIVER_AND_MANAGER | PUBLIC_PRAISE
  body          String
  competencyTags String[]            // links to competency library (§11.1)
  goalId        String?              // optional goal reference
  requestId     String?              // if responding to a feedback request
  anonymous     Boolean  @default(false)  // only for UPWARD/360, policy-gated
  createdAt     DateTime @default(now())
  @@index([businessId, toEmployeeId, createdAt])
  @@index([businessId, fromEmployeeId])
}

model FeedbackRequest {
  id        String  @id @default(uuid())
  businessId String
  requesterId String              // who wants feedback (self or manager-on-behalf)
  subjectId String                // about whom
  responderId String              // who is asked
  prompt    String?
  dueAt     DateTime?
  status    ReqFeedbackStatus @default(PENDING)  // PENDING | SUBMITTED | DECLINED | EXPIRED
  feedbackId String?
  createdAt DateTime @default(now())
  @@index([businessId, responderId, status])
}
```

Rules:
- **Anonymity** allowed only for `UPWARD`/360 paths and only when policy enables; even then, HR can de-anonymize **only** under a documented investigation flag (audited) — we state this in the privacy notice so employees know the boundary.
- **Praise** can be `PUBLIC_PRAISE` (kudos wall, plan-gated). Constructive feedback defaults `PRIVATE_TO_RECEIVER` or `RECEIVER_AND_MANAGER`.
- Feedback **feeds the review** (§11): a reviewer/manager sees the feedback timeline for the subject during assessment, reducing recency bias.

### 10.2 1:1 meetings

```prisma
model OneOnOne {
  id          String   @id @default(uuid())
  businessId  String
  managerId   String
  employeeId  String
  scheduledAt DateTime
  status      OneOnOneStatus @default(SCHEDULED)  // SCHEDULED | COMPLETED | CANCELLED | MISSED
  agendaItems Json              // [{by, text, done}]  — shared, collaboratively edited
  sharedNotes String?
  managerPrivateNotes String?   // not visible to employee
  actionItems Json              // [{text, ownerId, dueAt, done}]
  recurrenceRule String?        // RRULE (weekly/biweekly)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([businessId, managerId, scheduledAt])
  @@index([businessId, employeeId, scheduledAt])
}
enum OneOnOneStatus { SCHEDULED COMPLETED CANCELLED MISSED }
```

- Shared agenda (both add items pre-meeting), private manager notes, action items that **carry forward** until closed and surface in the next 1:1.
- Calendar sync + reminders (cron). Recurrence via RRULE.
- 1:1 history feeds the review timeline (talking-points continuity).

---

## 11. Review cycles (self / manager / peer / 360°)

The cyclical core. A **cycle** orchestrates which employees are reviewed, by whom, against which template, in which time-boxed phases, producing ratings that may link to comp.

### 11.1 Competency library & rating scales (configured, versioned)

```prisma
model Competency {
  id          String  @id @default(uuid())
  businessId  String
  name        String              // "Communication", "Ownership"
  description String?
  category    String?             // CORE | LEADERSHIP | FUNCTIONAL
  appliesToGradeIds String[]      // role/grade scoping
  behaviourAnchors Json           // [{level, descriptor}] for anchored rating
  archived    Boolean @default(false)
  @@unique([businessId, name])
}

model RatingScale {
  id        String  @id @default(uuid())
  businessId String
  name      String                // "5-point", "3-point", "9-box axis"
  points    Json                  // [{value, label, descriptor, color}]
  isDefault Boolean @default(false)
  @@unique([businessId, name])
}
```

Tenants assemble cycles from these libraries + fixed template shapes; they do not build form layouts. Anchored scales (behaviour descriptors per level) are encouraged for rater reliability.

### 11.2 Cycle & participation models

```prisma
model ReviewCycle {
  id          String   @id @default(uuid())
  businessId  String
  code        String              // PERF-2026-H1
  name        String
  type        CycleType            // ANNUAL | HALF_YEARLY | QUARTERLY | PROBATION | PROJECT | AD_HOC
  templateId  String               // ReviewTemplate (sections, competencies, scale, weighting)
  ratingScaleId String
  status      CycleStatus @default(DRAFT)
  // Phase windows
  phases      Json                 // ordered [{phase, opensAt, closesAt}]
  currentPhase ReviewPhase @default(SETUP)
  // Scope
  populationFilter Json            // dept/entity/grade/tenure filters → eligible employees
  enableSelf   Boolean @default(true)
  enableManager Boolean @default(true)
  enablePeer   Boolean @default(false)
  enableUpward Boolean @default(false)
  enable360External Boolean @default(false)  // P3.1
  peerSelectionMode PeerMode @default(EMPLOYEE_NOMINATES_MANAGER_APPROVES)
  peerCountMin Int @default(3)
  peerCountMax Int @default(6)
  calibrationEnabled Boolean @default(true)
  compLinkEnabled Boolean @default(false)    // gates §13
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([businessId, code])
  @@index([businessId, status])
}

model ReviewParticipant {
  id          String   @id @default(uuid())
  businessId  String
  cycleId     String
  subjectEmployeeId String           // person being reviewed
  managerId   String
  status      ParticipantStatus @default(PENDING)
  selfReviewId String?
  managerReviewId String?
  finalRating String?                // from scale, post-calibration
  calibratedRating String?
  normalizedRating String?
  createdAt   DateTime @default(now())
  @@unique([businessId, cycleId, subjectEmployeeId])
  @@index([businessId, cycleId, managerId])
}

model ReviewSubmission {
  id          String   @id @default(uuid())
  businessId  String
  cycleId     String
  subjectEmployeeId String
  reviewerEmployeeId String?         // null for external 360 (token-based)
  reviewerType ReviewerType          // SELF | MANAGER | PEER | UPWARD | EXTERNAL | SKIP_LEVEL
  status      SubmissionStatus @default(NOT_STARTED)
  responses   Json                   // [{sectionId, competencyId?, rating?, text?, goalScores?}]
  overallRating String?
  overallComment String?
  weightedScore Decimal? @db.Decimal(6,4)
  isAnonymous Boolean @default(false)
  submittedAt DateTime?
  dueAt       DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([businessId, cycleId, subjectEmployeeId, reviewerEmployeeId, reviewerType])
  @@index([businessId, cycleId, reviewerEmployeeId, status])
}

enum CycleType { ANNUAL HALF_YEARLY QUARTERLY PROBATION PROJECT AD_HOC }
enum CycleStatus { DRAFT SETUP ACTIVE CALIBRATION FINALIZING PUBLISHED CLOSED ARCHIVED }
enum ReviewPhase { SETUP GOAL_LOCK SELF MANAGER PEER UPWARD CALIBRATION SIGNOFF PUBLISH CLOSED }
enum PeerMode { EMPLOYEE_NOMINATES_MANAGER_APPROVES MANAGER_ASSIGNS HR_ASSIGNS }
enum ParticipantStatus { PENDING IN_PROGRESS SUBMITTED CALIBRATED PUBLISHED ACKED }
enum ReviewerType { SELF MANAGER PEER UPWARD EXTERNAL SKIP_LEVEL }
enum SubmissionStatus { NOT_STARTED IN_PROGRESS SUBMITTED DECLINED REOPENED }
```

### 11.3 Cycle state machine (phase orchestration)

```
DRAFT ─configure─► SETUP ─launch─► ACTIVE
                                     │  (phases advance by date OR manual)
   GOAL_LOCK → SELF → PEER (parallel) → MANAGER → UPWARD
                                     ▼
                                CALIBRATION ─► FINALIZING ─► SIGNOFF
                                     │                          │
                              (committee adjusts)        (manager+employee ack)
                                     ▼                          ▼
                                  PUBLISHED ──────────────► CLOSED ─► ARCHIVED
                                     │
                          (comp link fires §13 if enabled)
```

Phase rules & edge cases:
- **Phase windows** auto-advance via the scheduler at `closesAt`, or HR advances manually. Late submissions configurable (block / grace / HR-reopen).
- **Self before manager:** manager assessment can be gated to open only after self submits (configurable). Manager **cannot see self-rating** before submitting own (anti-anchoring) if policy set.
- **Peer selection:** employee nominates `peerCountMin..Max`; manager approves/swaps; HR can assign. Peer reviews can be anonymous (aggregated, min-n threshold to show).
- **Mid-cycle changes:** transfers (new manager mid-cycle) → dual-manager review or manager-of-record snapshot; terminations → cycle exit with disposition; leave/long-absence → auto-defer/exempt with reason.
- **New joiner / probation overlap:** tenure filter excludes <X-day joiners or routes them to a `PROBATION` cycle instead.
- **Reopen:** post-submission reopen requires HR Admin + reason; audited; notifies parties.

### 11.4 Scoring & rollup

- **Per-section** scores from rating scale; **competency** scores anchored; **goal score** = weighted Σ(goal weight × goal outcome).
- **Overall** = configured blend (e.g. 60% goals + 40% competencies; or manager-overall-with-inputs). Blend is a **template setting**, not free formula building.
- **Source weighting** for multi-rater: manager X%, self Y% (often 0 toward final), peer Z% (advisory), per template.
- Output: `ReviewParticipant.finalRating` (raw) → `calibratedRating` (committee) → `normalizedRating` (distribution-fit, optional).

### 11.5 Calibration

```prisma
model CalibrationSession {
  id          String   @id @default(uuid())
  businessId  String
  cycleId     String
  scope       Json                 // dept/grade group under calibration
  facilitatorId String
  status      CalibrationStatus @default(SCHEDULED)  // SCHEDULED | IN_PROGRESS | LOCKED
  distributionTarget Json?         // optional guidance curve (not forced)
  notes       String?
  lockedAt    DateTime?
  @@index([businessId, cycleId])
}

model CalibrationAdjustment {
  id          String   @id @default(uuid())
  businessId  String
  sessionId   String
  participantId String
  fromRating  String?
  toRating    String
  rationale   String              // required — every change is justified
  byEmployeeId String
  createdAt   DateTime @default(now())
  @@index([businessId, sessionId])
}
```

- Calibration grid / **9-box** (performance × potential) view; committee adjusts with **mandatory rationale** per change (audit + fairness).
- Distribution guidance is **advisory** by default (we resist forced ranking; configurable if a tenant insists, with a warning re: legal/morale risk).
- Locking a session freezes ratings → `FINALIZING`.

### 11.6 Sign-off & publish

- **Sign-off:** manager finalizes; **employee acknowledges** (ack ≠ agreement). Employee may add a **rebuttal/comment**, optionally trigger a grievance (helpdesk module).
- **Publish:** results visible to employee per template (some sections manager-only). Generates a **review summary PDF** (white-label, via `s3.js`).
- Publish for a comp-linked cycle **arms** the appraisal→comp flow (§13) but does not auto-apply money.

---

## 12. Performance review screens (HR console + ESS)

### 12.1 HR console

| Screen | Contents |
|---|---|
| **Cycle dashboard** | per-cycle completion funnel (self/manager/peer submission %), overdue list, phase countdown, nudge-all. |
| **Cycle builder (configure)** | pick template, scale, population filter, toggles, phase dates, comp-link gate. No layout building. |
| **Calibration board** | grid/9-box, drag-adjust with rationale, distribution overlay. |
| **Comp planning** | merit matrix (rating × position-in-band → suggested %), budget pool tracking, per-manager rollups (§13). |
| **Analytics** | rating distribution, manager leniency/severity, goal completion, competency heatmap, attrition-risk overlay. |

### 12.2 ESS (employee + manager)

| Screen | Contents |
|---|---|
| **My goals/OKRs** | create/check-in, alignment view, progress. |
| **My reviews** | self-assessment form, status of my cycle, published results, ack/rebuttal, history. |
| **Feedback** | give/request feedback, my received feedback timeline. |
| **1:1s** | upcoming/past, shared agenda, action items. |
| **Manager hub** | team review queue, write manager assessments, approve peer nominations, 1:1s, team goal alignment, propose increments (within guardrails). |
| **Comp letter** | published increment letter (post §13), white-label PDF. |

---

## 13. Appraisal → compensation linkage (the second country-sensitive seam)

The defensible, high-stakes bridge from performance to pay. Reuses the engine's comp model and **must respect IN Code-on-Wages structure**.

### 13.1 Merit matrix & budget pools

```prisma
model MeritMatrix {
  id          String   @id @default(uuid())
  businessId  String
  cycleId     String
  axes        Json                 // rows = rating, cols = position-in-band (Q1..Q4), cell = suggested %
  effectiveDate DateTime
  @@index([businessId, cycleId])
}

model CompPlanningPool {
  id          String   @id @default(uuid())
  businessId  String
  cycleId     String
  scope       Json                 // dept/entity
  currencyCode String
  budgetMinor BigInt               // total increment budget
  allocatedMinor BigInt @default(0)
  status      PoolStatus @default(OPEN)  // OPEN | LOCKED
  @@index([businessId, cycleId])
}

model CompProposal {
  id          String   @id @default(uuid())
  businessId  String
  cycleId     String
  employeeId  String
  managerId   String
  currentCtcMinor BigInt
  proposedCtcMinor BigInt
  incrementPct Decimal @db.Decimal(6,3)
  proposedComponents Json          // new component split (validated vs IN 50% rule)
  promotion   Boolean @default(false)
  newDesignationId String?
  newGradeId  String?
  variablePayMinor BigInt?
  oneTimeBonusMinor BigInt?
  effectiveDate DateTime
  status      CompProposalStatus @default(DRAFT)
  approvalRequestId String?
  letterPdfKey String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([businessId, cycleId, employeeId])
  @@index([businessId, cycleId, status])
}

enum PoolStatus { OPEN LOCKED }
enum CompProposalStatus { DRAFT SUBMITTED PENDING_APPROVAL APPROVED REJECTED APPLIED LETTER_SENT ACKED }
```

### 13.2 Flow

```
PUBLISHED cycle (compLinkEnabled) ─► generate CompProposal drafts from MeritMatrix(rating × band-position)
   ► manager adjusts within budget pool & guardrails
   ► validate (§13.3) ► submit ► approval chain (Comp Admin/Finance) ► APPROVED
   ► APPLIED: writes CompensationRevision to HR core (effective-dated) ► payroll picks up next run
   ► LETTER_SENT (white-label increment letter) ► employee ACKED
```

### 13.3 Validation guardrails

| Guard | Rule |
|---|---|
| **Budget** | Σ proposals in a pool ≤ `budgetMinor`. Over-budget blocks submit (or escalates). |
| **Band** | `proposedCtc` within grade band (warn/escalate if promotion crosses bands). |
| **IN Code-on-Wages 50% rule** | New component split must keep `Basic+DA+retaining ≥ 50%` of total remuneration; the builder **auto-suggests** a compliant re-split when an increment would breach it (e.g. inflating HRA only). Cascades into PF/gratuity recompute preview. [Sources §16.] |
| **IN minimum wage** | post-increment wages ≥ applicable minimum. |
| **NZ minimum wage** | implied hourly ≥ NZ$23.95 (1 Apr 2026). [Sources §16.] |
| **Effective date** | aligns to pay-period boundary; arrears handled by engine (`04-payroll-engine-design.md` §6.4) if effective mid-period. |
| **Net-pay preview** | engine computes before/after net for the employee (IN new-regime default; NZ PAYE/KiwiSaver/ESCT). |

### 13.4 The write (interface owned by HR core / payroll)

On `APPLIED`, the proposal emits an effective-dated **`CompensationRevision`** (model owned by `03-data-model.md`) — **never** mutating the current `SalaryStructure` in place (snapshot discipline). Payroll consumes it on the next run on/after `effectiveDate`. This mirrors the offer→handoff→salary-structure path (§7), so **both** entry points to compensation (new hire and increment) flow through the **same validated, snapshotted, audited channel**. The performance module **proposes**; the payroll engine **disposes**.

---

## 14. RBAC additions (extend `rbac.js` PERMISSIONS registry)

Added to the frozen `PERMISSIONS` object in `backend/src/core/lib/rbac.js` (JSON-stored on `BusinessRole`, **no migration** needed — the registry's design property):

```
// Recruitment / ATS
canManageRequisitions    'Create, approve, open/close requisitions'
canApproveRequisitions   'Approve requisitions in chain'
canManageCandidates      'View/move/disposition candidates'
canViewCandidateComp     'See candidate expected/offered comp'
canScheduleInterviews    'Create/edit interviews'
canSubmitScorecard       'Submit interview scorecard (interviewer least-priv)'
canManageOffers          'Draft/send offers'
canApproveOffers         'Approve offers in chain'
canManageCareersPage     'Edit careers branding + postings'
canManageCandidateData   'Erasure/retention/export (privacy ops)'
// Performance
canManagePerfCycles      'Configure/launch review cycles'
canCalibrate             'Participate in calibration'
canViewTeamPerformance   'Manager: see team ratings/goals'
canManageCompPlanning    'Merit matrix, budget pools'
canApproveCompChanges    'Approve increment proposals'
canConfigureCompetencies 'Edit competency library + scales'
```

Interviewer least-privilege, EEO firewall, candidate-comp visibility, and anonymity de-anonymization are all enforced at the **query/row-scoping layer**, not just by permission keys.

---

## 15. API surface (selected; full surface in `09-api-surface.md`)

REST under `/api/hr/...`, tenant-scoped by middleware (forked from Sitepresso's `requireBusiness`). Public careers under `/api/public/careers/...` (tenant resolved by router). All mutations audited; idempotency keys on offer/handoff/comp-apply.

### 15.1 Recruitment

| Method & path | Purpose |
|---|---|
| `POST /api/hr/requisitions` | create (DRAFT) |
| `POST /api/hr/requisitions/:id/submit` / `/approve` / `/reject` / `/open` / `/hold` / `/close` | state transitions |
| `GET /api/hr/requisitions?status=&dept=` | list/filter |
| `POST /api/hr/requisitions/:id/postings` | create job posting |
| `POST /api/hr/postings/:id/publish` / `/pause` / `/expire` | posting lifecycle |
| `GET /api/public/careers/:tenant/jobs` / `/jobs/:slug` | public list/detail (SSR) |
| `POST /api/public/careers/:tenant/jobs/:slug/apply` | candidate apply (consent required, Turnstile-guarded) |
| `GET /api/hr/applications?reqId=&stage=` | pipeline |
| `POST /api/hr/applications/:id/move` | stage transition (+history) |
| `POST /api/hr/applications/:id/reject` | disposition (+ retention clock) |
| `POST /api/hr/applications/:id/interviews` | schedule |
| `POST /api/hr/interviews/:id/assignments` | assign panel |
| `POST /api/public/schedule/:token/book` | candidate self-schedule (locked) |
| `POST /api/hr/interviews/:id/scorecard` | submit scorecard (reveal-gated) |
| `POST /api/hr/applications/:id/offers` | draft offer (comp pre-flight) |
| `POST /api/hr/offers/:id/submit` / `/approve` / `/send` / `/rescind` | offer lifecycle |
| `POST /api/public/offers/:token/accept` / `/decline` / `/counter` / `/sign` | candidate offer response |
| `POST /api/hr/candidates/:id/erasure` / `GET /export` | privacy rights |
| `GET /api/hr/recruitment/analytics` | funnel metrics |

### 15.2 Performance

| Method & path | Purpose |
|---|---|
| `POST /api/hr/goals` / `PATCH /:id` / `POST /:id/checkin` | goals/OKRs |
| `POST /api/hr/feedback` / `POST /feedback/requests` | continuous feedback |
| `POST /api/hr/oneonones` / `PATCH /:id` | 1:1s |
| `POST /api/hr/perf/cycles` / `:id/launch` / `:id/advance-phase` / `:id/close` | cycle lifecycle |
| `GET /api/hr/perf/cycles/:id/participants` | roster/status |
| `POST /api/hr/perf/submissions/:id` (self/manager/peer) | submit review |
| `POST /api/hr/perf/cycles/:id/calibration` / `adjustments` | calibration |
| `POST /api/hr/perf/cycles/:id/publish` | publish results |
| `POST /api/hr/comp/proposals` / `:id/submit` / `/approve` / `/apply` | appraisal→comp |
| `GET /api/hr/perf/analytics` | distribution/leniency/etc. |

---

## 16. Compliance & data-protection sources (verified, 2026)

- **IN — New Labour Codes / Code on Wages (live 21 Nov 2025; fully operational 1 Apr 2026); 50% wages rule; salary by 7th; F&F within 48h; minimum-wage VDA Apr-2026 revision:** EY/labour-code analyses and govt FAQ — Compport "India Labour Code 2025"; Labour Law Reporter "Salary Structure under New Labour Codes"; Ministry of Labour FAQ (16.03.2026); India-Briefing minimum-wage guide. (https://www.compport.com/blog/india-labour-code-2025), (https://labourlawreporter.com/salarystructure.asp), (https://www.labour.gov.in/), (https://www.india-briefing.com/news/guide-minimum-wage-india-19406.html/)
- **IN — DPDP Act 2023 + DPDP Rules 2025 (notified 13 Nov 2025; consent-manager provisions 13 Nov 2026; consent/notice/rights 13 May 2027; consent must be free/specific/informed/unconditional; purpose-bound retention; 72h breach notice):** EY "DPDP Rules 2025"; Fisher Phillips "India's New Data Privacy Rules"; Hogan Lovells consent-management rules; Lexology employer guidance. (https://www.ey.com/en_in/insights/cybersecurity/transforming-data-privacy-digital-personal-data-protection-rules-2025), (https://www.fisherphillips.com/en/insights/insights/indias-new-data-privacy-rules), (https://www.hoganlovells.com/en/publications/india-publishes-consent-management-rules-under-digital-personal-data-protection-act)
- **NZ — minimum wage NZ$23.95/hr (1 Apr 2026); KiwiSaver employer min 3.5% (1 Apr 2026 → 4% 2028), 16–17yo eligibility; ACC earner levy 1.75% on first NZ$156,641 (1 Apr 2026):** per the platform compliance brief (cross-checked against Employment NZ + IRD); detailed in `06-compliance-nz.md`.
- **NZ — Privacy Act 2020 (IPP1–9; unsuccessful-applicant info kept ≥ 12 months then securely destroyed; checks must be relevant to safe/proper performance):** Employment NZ "Employee privacy" & "Tests and checks"; Office of the Privacy Commissioner "Principle 9 — Retention" & "Privacy in recruitment". (https://www.employment.govt.nz/fair-work-practices/employee-privacy), (https://www.employment.govt.nz/starting-employment/hiring/tests-and-checks), (https://www.privacy.org.nz/privacy-principles/9/), (https://www.privacy.org.nz/blog/privacy-in-recruitment/)

> Effective-dated compliance values (minimum wages, KiwiSaver %, ACC levy, retention windows, DPDP enforcement dates) are **not hard-coded** here — they live in Super-Admin versioned rule tables (`05-compliance-india.md`, `06-compliance-nz.md`, and the engine's rule tables in `04-payroll-engine-design.md`). This doc references them so offer/comp validation reads live values.

---

## 17. Cross-cutting concerns

- **Audit:** every state transition, comp number, calibration adjustment, scorecard submission, and privacy action writes an `AuditLog` row (before/after, actor, IP, impersonation context) per `03-data-model.md` §19.
- **Notifications:** all candidate/employee/interviewer comms route through `backend/src/core/lib/notifications/router.js` with country routing (email/SMS/WhatsApp IN; email/SMS NZ) and the templated catalog; new templates registered in `templates.js`/`emailEvents.js`.
- **Impersonation/support:** Super-Admin impersonation (forked from `apps/platform/app/superadmin`) can view ATS/perf for support, but **candidate-comp and EEO data are masked** even under impersonation unless an explicit, audited support-elevation is granted.
- **i18n:** ESS perf + careers UI localized en/hi (IN), en (NZ). Tenant-authored job/letter content not machine-translated.
- **Feature gating:** modules gated by plan via `Business.featureFlags` + `TierFeature` (Super-Admin owned). E.g. 360°, succession, public kudos wall, job-board syndication are higher-tier.

---

## 18. Edge-case register (consolidated)

| # | Edge case | Handling |
|---|---|---|
| E1 | Candidate applies to same req twice | Dedup → blocks 2nd active app per `@@unique(candidate,req)`; surfaces existing. |
| E2 | Internal employee applies (internal mobility) | `source=INTERNAL_TRANSFER`; manager-visibility & confidentiality rules; current-comp pulled from HR core (with consent). |
| E3 | Offer accepted but candidate ghosts before start | Pre-boarding no-show flow; handoff `FAILED`/withdraw; req re-opens. |
| E4 | Post-acceptance offer rescission | HR Admin + legal-ack + reason; heavy audit; warns on IN/NZ wrongful-withdrawal exposure. |
| E5 | Two offers accepted > headcount | `filledCount` guard blocks; explicit headcount bump audited. |
| E6 | IN comp split breaches 50% wage rule | Builder auto-suggests compliant split; blocks approval until compliant. |
| E7 | Increment effective mid-pay-period | Engine arrears (`04` §6.4); no silent mutation of locked runs. |
| E8 | Reviewer leaves mid-cycle | Submission reassigned/exempted; audited; min-n anonymity preserved. |
| E9 | Manager change mid-cycle | Manager-of-record snapshot or dual review per policy. |
| E10 | Peer pool < min-n for anonymity | Aggregate hidden until threshold; HR notified. |
| E11 | Candidate erasure during active pipeline | Legal-hold check; if held, defer; else anonymize + withdraw apps. |
| E12 | Retention purge vs active dispute | Legal-hold pins record against cron purge. |
| E13 | Forced-ranking pressure | Distribution advisory by default; warning if tenant enables forced curve. |
| E14 | Scorecard anchoring | Reveal-gated until own submission. |
| E15 | NZ unsuccessful applicant < 12-month destroy | Retention policy enforces ≥365d before destroy. |
| E16 | Confidential req leaking via interviewer | Title masked; row-scoped visibility; comp hidden. |

---

## 19. Open questions for the founder (surfaced, not assumed)

See StructuredOutput — these gate P2/P3 build decisions (e-sign provider depth, job-board connector scope, forced-distribution stance, talent-pool default retention windows, external-360 raters in P3 vs P3.1, and whether NZ pay-range display should default ON ahead of any mandate).

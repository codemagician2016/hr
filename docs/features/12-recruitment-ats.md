# Feature 12 — Recruitment / ATS (configurable scoring + merit list)

> **Status:** spec / dev contract · **Module:** `backend/src/hr/talent/` (extend the existing recruitment controller/routes) + new `backend/src/hr/talent/recruitment/` lib · **Apps:** `apps/hr-admin`, `apps/ess`, plus a **public careers** surface
> **Market:** country-agnostic pipeline; the only country touch-points are (a) the India Code-on-Wages 50% offer pre-flight (already reused from the payroll engine) and (b) the IN/NZ onboarding template the Hired hand-off seeds.
> **Builds on:** F1 RBAC/hierarchy (`core/lib/rbac.js`, `lib/scopeResolver.js`, `middleware/scope.middleware.js`), F4 Lifecycle (`lifecycle/onboarding.service.js` `seedOnboardingJourney`, built-in e-sign `lifecycle/esign/builtin.js`), F5 Compensation (`SalaryStructure` + the 50% wage check), F9 Letters (`letters/letters.service.js` `issueLetter` for the offer letter PDF).
> **Author note:** every schema field, RBAC key, file path and line number below was verified against the live tree on 2026-06-24. The existing recruitment slice (`talent/controllers/recruitment.controller.js`, 589 lines; `talent/routes/recruitment.routes.js`, 55 lines; Prisma `Job`/`JobStage`/`Candidate`/`Application`/`Interview`/`Offer` at `schema.prisma:9549–9739`) is **reused verbatim** — this feature is *additive* on top of it. Where the existing code is thin (no scoring, no scheduling, no public apply, no scope), it is flagged as **a gap to fill**, not rewritten.

---

## 1. Summary & goals

We already have a **working linear ATS spine**: jobs (`DRAFT→OPEN→ON_HOLD→CLOSED`), a configurable `JobStage` pipeline (fixed `StageKind`s `SOURCED→SCREENING→INTERVIEW→ASSESSMENT→OFFER→HIRED/REJECTED/WITHDRAWN`), candidates, applications that move stage-by-stage (`moveApplication` keeps `Application.status` in lock-step with the stage kind via `STAGE_KIND_TO_STATUS`), interviews (a single `feedbackJson` blob + a `recommendation` enum), and offers with the **India 50% wage pre-flight reusing the payroll engine** (`offerWageCheck` → `computeStatutoryWages`) and the **atomic Hired→onboarding hand-off** (`acceptOffer` seeds a `LifecycleJourney` via `seedOnboardingJourney` inside one transaction). That spine stays.

**What is missing is exactly the owner's headline ask — _configurable, objective scoring that auto-produces a ranked merit list_:**

1. **No application scoring.** A candidate applies (today only HR can create the `Application` via `canManageEmployees`; there is no public apply). There are **no screening questions**, no auto-score, no knockout, no qualification points. `Application.rating` is a single loose `Decimal(4,2)` an HR types by hand.
2. **No interview scorecards.** `Interview.feedbackJson` is an opaque JSON blob and `recommendation` is a 5-point enum. There is **no pre-defined skill set rated 1–10**, no per-interviewer rows, no weighting, no aggregation across interviewers. A busy HR cannot judge objectively or remember each candidate.
3. **No merit list.** Nothing combines application score + interview score into one ranked list. The owner's core deliverable — "candidates auto-ranked by combined application + interview marks" — does not exist.
4. **No interview scheduling / invitations / public application.** `createInterview` stores a row but sends nothing; candidates have no portal; there is no email invite for "you're shortlisted / here's your interview slot."
5. **No data-scope and weak SoD.** Every route is gated only by binary `canManageEmployees`; an interviewer is not bound to *their own* scorecard, and the same person can score and approve.

**Goals (v1 — see §3 scope):** add a **three-part configurable scoring engine** — (a) **screening questions** that auto-score on apply (knockout + qualification points), (b) **interview scorecards** (HR defines N weighted skills rated 1–10 *before* interviews; each interviewer fills their own card), (c) a **merit list** that auto-ranks by a transparent, configurable blend of application + interview score; plus a **public careers/apply** surface, **interview scheduling + email invitations**, **multi-interviewer aggregation**, an **interviewer ESS surface** (fill my scorecards), and the **Hired→onboarding** hand-off (already built — we only widen it to optional **e-signed offer letters** via the built-in e-sign provider). Keep tenant isolation, F1 scope, and maker-checker SoD throughout.

**Non-negotiable design value:** a non-technical admin must understand the whole flow. The merit score is **never a black box** — every candidate's row expands to show "Application 38/50 (CS degree +20, Master's +6, 3 knockouts passed) + Interview 81/100 (weighted across 2 interviewers) = **74.2 weighted**", with the exact formula printed on screen.

---

## 2. Existing assets — reuse verbatim

| Asset | Location | Reuse |
|---|---|---|
| Recruitment controller (jobs/candidates/applications/interviews/offers + 50% pre-flight + Hired hand-off) | `talent/controllers/recruitment.controller.js:1–589` | **Extend** in place; add scoring/scheduling/merit handlers. Keep `picker`, `toMinor`, `STAGE_KIND_TO_STATUS`, `offerWageCheck`, `acceptOffer`. |
| Recruitment routes | `talent/routes/recruitment.routes.js:1–55`, mounted `hr/routes/index.js:40` (`/api/hr/recruitment`) | Add the new sub-routers (config, screening, scorecards, scheduling, merit, public) under the same mount. |
| Prisma ATS models | `schema.prisma:9549–9739` — `Job`, `JobStage`, `Candidate`, `Application`, `Interview`, `Offer` + enums | Reuse unchanged; add columns + new models (§4) additively. |
| **Payroll wage check** | `payroll/compliance/india.js` `_internals.computeStatutoryWages`; wired via `offerWageCheck` (`recruitment.controller.js:408–445`) | Already reused — the offer flow stays as-is. |
| **Onboarding hand-off** | `lifecycle/onboarding.service.js` `seedOnboardingJourney(offer, tx)`; called inside `acceptOffer` (`recruitment.controller.js:527–555`) | The Hired→provision seam — **reuse verbatim**; idempotent, transactional, seeds IN/NZ journey. |
| **Built-in e-sign** | `lifecycle/esign/builtin.js` `createEnvelope` / `sign` / `getStatus` (SHA-256 audit chain, sequential signers, HMAC cert, expiry) | Offer-letter e-signature (candidate countersigns) — `Offer.signatureEnvelopeId`. |
| **Letters render** | `letters/letters.service.js` `issueLetter` (renders a template → PDF, letterhead, ref scheme, watermark, stores via `storePdf`) | Render the offer-letter PDF from a Letters template → `Offer.letterUrl`. |
| Scope resolver | `lib/scopeResolver.js:39,96,103,110` — `resolveAccessibleEmployeeIds(actor, action)` (TEAM = recursive reporting subtree), `scopeWhere`, `scopeAllows`, `APPROVAL_ACTIONS` | Scope hiring-manager/interviewer reads to their reqs/panels; **add** recruitment actions to `APPROVAL_ACTIONS` for SoD (§9). |
| Scope middleware | `middleware/scope.middleware.js:15,33,50` — `attachSelfEmployee`, `withEmployeeScope(action,{idParam})` (IDOR-safe 404) | Bind interviewer routes to the caller's own Employee; gate hiring-manager req lists. |
| RBAC registry | `core/lib/rbac.js:11` `PERMISSIONS` (frozen, **additive — new keys need no migration**); `SYSTEM_ROLES:57` | Add 3 keys (§9.1); grant to HR_ADMIN + a new RECRUITER scope. |
| Auth middleware | `core/middleware/auth.middleware.js:289,321` — `protect`, `requirePermission(key)` | Gate all admin writes. |
| Number sequences | `lifecycle/lib/codes.js` `allocateCode(tx, {businessId, entityId, scope})` (used for `JOB-`/`ONBOARD-` codes) | Allocate `Application` ref + offer letter ref. |
| Frontend kit | hr-admin `@hr/ui` + `lib/ui.js` (`PageHeader`, `DataTable`, `Tabs`, `StatusBadge`, `ActionButton`, `asList`), `lib/api.js`; ESS `lib/api.js`, `useApi.js`, `AppShell`+`BottomNav` | Build all UI on these. |
| AuditLog | existing `{action, entityType, entityId, meta}` shape | Every stage move, score recompute, scorecard submit, offer transition. |

**Reuse rule:** scoring math lives in a **pure lib** `backend/src/hr/talent/recruitment/scoring.js` (no Prisma, integer-safe, unit-tested) exactly like `payroll/compliance/india.js` and `talent/performance/`. The controller calls the pure functions and persists the result snapshot — it never inlines arithmetic.

---

## 3. Scope (in / out)

**IN (v1):**
- **Screening questions** per job: typed questions (`BOOLEAN`, `SINGLE_CHOICE`, `MULTI_CHOICE`, `NUMBER`, `TEXT`), each option/answer carries `points`; `isKnockout` + `knockoutValue` auto-reject; a **qualification-points** helper (degree level → points map: e.g. Master=6, Bachelor=4, plus a named-degree bonus "CS engineering +20"). Answers captured on apply → `Application.screeningScore` + a per-answer audit snapshot.
- **Interview scorecards (templates):** HR defines a `ScorecardTemplate` of N `ScorecardSkill`s (each `weight` + `1–10` scale) **before** interviews. Each interviewer fills one `Scorecard` (their own row) with a `ScorecardRating` per skill → weighted per-interviewer total → **aggregated** (mean/trimmed-mean, configurable) into `Application.interviewScore`.
- **Merit list:** pure `computeMeritScore(application, weights)` → `Application.meritScore` (configurable blend `applicationWeightPct` + `interviewWeightPct`, default 40/60), with a ranked, explainable list per job.
- **Public careers + apply:** a tenant-branded public job board + apply form (resume upload + screening answers + consent), **unauthenticated**, rate-limited, that creates `Candidate`+`Application` and runs screening auto-score. Dedupe by `(businessId, email)`.
- **Interview scheduling + invitations:** schedule an `Interview` with panel (`interviewerIds`), send an **email invitation** to candidate (slot/mode/location/video link) and a panel notification; reschedule/cancel; ICS attachment.
- **Multi-interviewer aggregation** + **interviewer ESS surface** (an interviewer who is an Employee sees only *their* assigned interviews and fills only *their* scorecard).
- **Offer e-sign (optional):** render offer letter via Letters → optional candidate e-signature via built-in e-sign → accept seeds onboarding (existing).
- **F1 data-scope + recruitment SoD** wired on every route (interviewer ≠ approver; scorer is bound to self).

**OUT (defer):** resume parsing / CV keyword AI ranking; job-board syndication (LinkedIn/Indeed feeds) beyond a generic JSON/XML export; agency/vendor portals; candidate self-scheduling against interviewer calendars (v1 = HR picks the slot); offer approval *workflow chains* beyond the existing single `approvalRequestId` hook; background-check integrations; DEI/blind-screening masking (v1 ships the data model `hideCandidatePiiUntilStage` flag but only a single mask point); video-interview recording.

---

## 4. Data model — additive Prisma

All new models live in `backend/prisma/schema.prisma` next to the existing ATS block (`9549–9739`), tenant-scoped on `businessId`, soft-deleted where mutable, `version Int @default(0)` on mutable rows (matches `Application`/`Offer` convention). Answer/rating snapshots are **append-only ledgers** (no `version`).

### 4.1 Columns added to existing models (additive, nullable — no backfill needed)

```prisma
// Application — carry the three score components + their explainable snapshots.
model Application {
  // … existing …
  screeningScore   Decimal? @db.Decimal(7,2)   // auto from screening answers
  screeningMaxScore Decimal? @db.Decimal(7,2)  // denominator for the % display
  knockedOut       Boolean  @default(false)    // failed a knockout question → auto-REJECTED
  interviewScore   Decimal? @db.Decimal(7,2)   // aggregated weighted interview total (0–100)
  meritScore       Decimal? @db.Decimal(7,2)   // blended rank score (the merit-list sort key)
  scoreSnapshot    Json?                        // frozen breakdown for the "why" panel (audit)
  appliedSource    ApplicationSource @default(MANUAL) // PUBLIC | REFERRAL | AGENCY | MANUAL
  // (existing convertedEmployeeId is the Hired→onboarding back-reference)
}
enum ApplicationSource { PUBLIC REFERRAL AGENCY MANUAL IMPORT }

// Job — public posting + scoring config knobs.
model Job {
  // … existing …
  publicSlug        String?                     // careers URL token; unique per business when set
  isPublic          Boolean  @default(false)    // appears on the public board
  applicationWeightPct Decimal @db.Decimal(5,2) @default(40)
  interviewWeightPct   Decimal @db.Decimal(5,2) @default(60)  // app+interview must sum to 100 (validated)
  scorecardTemplateId String?                   // default interview scorecard for this job
  hideCandidatePiiUntilStage StageKind?         // optional blind-screening mask point
  @@unique([businessId, publicSlug])
}

// Interview — link to its scorecard template + per-interview slot details for invites.
model Interview {
  // … existing: round, scheduledAt, mode, interviewerIds(CSV), feedbackJson, recommendation, status …
  scorecardTemplateId String?                   // which skill set this round uses
  durationMins      Int?     @default(45)
  locationText      String?                      // room / address (ONSITE)
  videoUrl          String?                      // meeting link (VIDEO)
  candidateInviteSentAt DateTime?
  panelInviteSentAt DateTime?
  scorecards        Scorecard[]
}

// Offer — optional e-signature envelope (reuse built-in e-sign).
model Offer {
  // … existing …
  signatureEnvelopeId String?                   // FK-by-id to SignatureEnvelope (built-in e-sign)
}
```

### 4.2 New models — screening

```prisma
model ScreeningQuestion {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  jobId       String
  job         Job      @relation(fields: [jobId], references: [id], onDelete: Cascade)
  prompt      String                              // "Do you have a CS engineering degree?"
  kind        ScreeningKind                       // BOOLEAN | SINGLE_CHOICE | MULTI_CHOICE | NUMBER | TEXT | QUALIFICATION
  required    Boolean  @default(true)
  isKnockout  Boolean  @default(false)            // a failing answer auto-rejects
  knockoutValue Json?                             // the value(s) that PASS (knockout fails if not matched)
  maxPoints   Decimal? @db.Decimal(7,2)           // cap for NUMBER/QUALIFICATION
  sortOrder   Int
  options     ScreeningOption[]                   // for *_CHOICE / QUALIFICATION (degree levels)
  createdAt   DateTime @default(now())
  deletedAt   DateTime?
  @@unique([businessId, jobId, sortOrder])
  @@index([businessId, jobId])
}
enum ScreeningKind { BOOLEAN SINGLE_CHOICE MULTI_CHOICE NUMBER TEXT QUALIFICATION }

model ScreeningOption {
  id          String   @id @default(uuid())
  businessId  String
  questionId  String
  question    ScreeningQuestion @relation(fields: [questionId], references: [id], onDelete: Cascade)
  label       String                              // "Master's degree" / "Yes" / "B.Tech Computer Science"
  value       String                              // canonical value matched against answers / knockoutValue
  points      Decimal  @db.Decimal(7,2) @default(0) // Master=6, Bachelor=4, "CS engineering"=20
  sortOrder   Int
  @@index([businessId, questionId])
}

// Append-only: what the candidate actually answered + the points it earned (audit).
model ScreeningAnswer {
  id            String   @id @default(uuid())
  businessId    String
  applicationId String
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  questionId    String
  questionPrompt String                            // snapshot (question may be edited later)
  answerValue   Json                               // bool / chosen value(s) / number / text
  pointsAwarded Decimal  @db.Decimal(7,2) @default(0)
  knockoutFailed Boolean @default(false)
  createdAt     DateTime @default(now())
  @@index([businessId, applicationId])
}
```

### 4.3 New models — interview scorecards

```prisma
// HR defines this ONCE per skill set (reusable across jobs/rounds).
model ScorecardTemplate {
  id          String   @id @default(uuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  name        String                              // "Backend Engineer — Tech Round"
  description String?
  aggregation ScorecardAggregation @default(MEAN) // how multi-interviewer rows combine
  isActive    Boolean  @default(true)
  skills      ScorecardSkill[]
  createdAt   DateTime @default(now())
  deletedAt   DateTime?
  version     Int      @default(0)
  @@unique([businessId, name])
  @@index([businessId, isActive])
}
enum ScorecardAggregation { MEAN TRIMMED_MEAN MAX MEDIAN }

model ScorecardSkill {
  id          String   @id @default(uuid())
  businessId  String
  templateId  String
  template    ScorecardTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  name        String                              // "Data Structures", "System Design", "Communication"
  description String?
  weight      Decimal  @db.Decimal(5,2) @default(1) // relative weight; Σ normalised at compute time
  scaleMin    Int      @default(1)
  scaleMax    Int      @default(10)
  sortOrder   Int
  @@unique([businessId, templateId, sortOrder])
  @@index([businessId, templateId])
}

// One row per interviewer per interview (the "remember each candidate" card).
model Scorecard {
  id            String   @id @default(uuid())
  businessId    String
  interviewId   String
  interview     Interview @relation(fields: [interviewId], references: [id], onDelete: Cascade)
  interviewerEmployeeId String                    // bound to the caller's own Employee (SoD)
  templateId    String                            // snapshot of which template was used
  status        ScorecardStatus @default(DRAFT)   // DRAFT | SUBMITTED
  weightedTotal Decimal? @db.Decimal(7,2)         // this interviewer's normalised 0–100
  recommendation InterviewRecommendation?         // reuse existing enum
  notes         String?  @db.Text
  submittedAt   DateTime?
  ratings       ScorecardRating[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)
  @@unique([businessId, interviewId, interviewerEmployeeId]) // one card per interviewer per interview
  @@index([businessId, interviewId])
}
enum ScorecardStatus { DRAFT SUBMITTED }

model ScorecardRating {
  id          String   @id @default(uuid())
  businessId  String
  scorecardId String
  scorecard   Scorecard @relation(fields: [scorecardId], references: [id], onDelete: Cascade)
  skillId     String                              // FK-by-id to ScorecardSkill (snapshot below)
  skillName   String                              // snapshot
  weight      Decimal  @db.Decimal(5,2)           // snapshot of the skill weight at submit
  score       Int                                 // the 1–10 mark
  comment     String?
  @@unique([businessId, scorecardId, skillId])
  @@index([businessId, scorecardId])
}
```

### 4.4 Scoring config snapshot

The merit blend lives on `Job` (`applicationWeightPct`/`interviewWeightPct`); the per-application **frozen** breakdown lives in `Application.scoreSnapshot` (JSON), e.g.:
```json
{
  "formula": "merit = app% * (screening/screeningMax*100) + iv% * interviewScore",
  "applicationWeightPct": 40, "interviewWeightPct": 60,
  "screening": { "score": 38, "max": 50, "pct": 76,
    "lines": [{"q":"CS degree?","awarded":20},{"q":"Highest qualification","awarded":6,"label":"Master's"}],
    "knockouts": {"passed": 3, "failed": 0} },
  "interview": { "score": 81.0, "interviewers": 2, "aggregation": "MEAN",
    "perInterviewer": [{"who":"E-102","total":78},{"who":"E-118","total":84}] },
  "merit": 74.2
}
```
This snapshot is what the UI's **"Why this rank?"** drawer renders — no recomputation on read, fully auditable.

---

## 5. Scoring engine — pure lib (`talent/recruitment/scoring.js`)

Mirrors the `payroll/compliance/india.js` pattern: **pure, deterministic, integer/decimal-safe, unit-tested, zero Prisma.** Three functions + one orchestrator.

**`scoreScreening(questions, answers)` → `{ score, max, knockedOut, lines }`**
- For each answered question: resolve `pointsAwarded` from the matched `ScreeningOption.points` (CHOICE/QUALIFICATION), from a `NUMBER`→points band, or `0` for `TEXT`. Cap at `maxPoints`.
- `max` = Σ of the best-possible points per question (the denominator for the % display).
- **Knockout:** if `isKnockout` and the answer does not match `knockoutValue` → `knockedOut = true`. A knockout sets the application's terminal path (auto-`REJECTED`) regardless of other points.

**`scoreInterview(scorecards, { aggregation })` → `{ score, perInterviewer }`**
- Per submitted `Scorecard`: `weightedTotal = Σ(score_i * weight_i) / Σ(weight_i) normalised to 0–100` over its `ScorecardRating`s (weights normalised so Σ→1, score on the skill's `scaleMin..scaleMax` rescaled to 0–100).
- Aggregate across interviewers per `aggregation` (`MEAN` default; `TRIMMED_MEAN` drops top+bottom when ≥4 cards; `MEDIAN`; `MAX`). Only `SUBMITTED` cards count.

**`computeMeritScore({ screeningScore, screeningMax, interviewScore }, { applicationWeightPct, interviewWeightPct })` → `{ merit, breakdown }`**
- `appPct = screeningMax>0 ? screeningScore/screeningMax*100 : 0`
- `merit = applicationWeightPct/100 * appPct + interviewWeightPct/100 * interviewScore`
- If `knockedOut` → `merit = 0` and breakdown flags the knockout (never silently buried).

**`recomputeApplicationScore(application, questions, answers, scorecards, job)`** — orchestrator that produces the full `scoreSnapshot` JSON and the three persisted decimals. The controller calls this and writes the result in one update; it is invoked on (i) apply, (ii) every scorecard submit, (iii) any screening-answer edit, (iv) a manual "recompute" button. **Pure → trivially testable, the merit number is always reproducible.**

**Edge math:** all weights normalise defensively (Σweight=0 → equal weights, never divide-by-zero); a job with no screening questions → `appPct` contributes 0 and the blend auto-renormalises to interview-only (and the UI says so); a candidate with zero submitted scorecards → `interviewScore=null`, merit shows "interview pending" and ranks below scored candidates.

---

## 6. API surface (with RBAC)

All under the existing `/api/hr/recruitment` mount (`hr/routes/index.js:40`). Admin writes gated by `requirePermission('canManageHiring')` (new) or the existing `canManageEmployees` (super-set). Reads gated by `canViewEmployees` **+ F1 scope** (a hiring manager / interviewer sees only their reqs/panels). Interviewer self-service routes use `attachSelfEmployee` + bind to the caller's own Employee.

### 6.1 Existing (reused, unchanged)
`GET/POST/PATCH/DELETE /jobs`, `/jobs/:id/publish|close`, `/jobs/:jobId/stages`, `/candidates*`, `/applications`, `/applications/:id`, `/applications/:id/move`, `/interviews*`, `/offers*` + `/offers/:id/send|accept|decline`.

### 6.2 New — screening config & answers
| Method · Path | Permission | Notes |
|---|---|---|
| `GET/POST /jobs/:jobId/screening-questions` | view / `canManageHiring` | CRUD the question set + options |
| `PATCH/DELETE /screening-questions/:id` | `canManageHiring` | soft-delete; reorder via `sortOrder` |
| `POST /applications/:id/screening-answers` | `canManageHiring` (admin) **or** public token (public apply) | persist answers (append-only), run `scoreScreening`, set `screeningScore`/`knockedOut`, recompute merit. Knockout → auto-move to a `REJECTED`-kind stage |

### 6.3 New — scorecard templates
| Method · Path | Permission | Notes |
|---|---|---|
| `GET/POST /scorecard-templates` | view / `canManageHiring` | reusable skill sets |
| `PATCH/DELETE /scorecard-templates/:id` | `canManageHiring` | edit skills/weights; soft-delete (blocked if referenced by a scheduled future interview → 409) |
| `GET/POST /scorecard-templates/:id/skills`, `PATCH/DELETE /skills/:sid` | `canManageHiring` | manage `ScorecardSkill`s |

### 6.4 New — scheduling & invitations
| Method · Path | Permission | Notes |
|---|---|---|
| `POST /interviews` (extended) | `canManageHiring` | now accepts `scorecardTemplateId`, slot fields; creates one empty `Scorecard` (DRAFT) per interviewer |
| `POST /interviews/:id/invite` | `canManageHiring` | send candidate email (slot/mode/link + ICS) + panel notification; stamps `candidateInviteSentAt` |
| `POST /interviews/:id/reschedule` · `/cancel` | `canManageHiring` | new slot → re-invite; cancel → notify + void DRAFT scorecards |

### 6.5 New — interviewer self-service (ESS-style, scope-bound)
Mounted at `/api/hr/recruitment/me/*`, `protect` + `attachSelfEmployee`; the caller may only touch interviews where their own `employeeId ∈ interviewerIds`.
| Method · Path | Notes |
|---|---|
| `GET /me/interviews` | my upcoming/past panels only |
| `GET /me/scorecards/:interviewId` | my (and only my) scorecard for that interview |
| `PATCH /me/scorecards/:id` | save ratings (DRAFT); `version`-checked |
| `POST /me/scorecards/:id/submit` | DRAFT→SUBMITTED, computes `weightedTotal`, recomputes the application's `interviewScore`+merit. **SoD: the interviewer cannot also be the application's approver** (see §9) |

### 6.6 New — merit list & offer e-sign
| Method · Path | Permission | Notes |
|---|---|---|
| `GET /jobs/:jobId/merit-list` | view + scope | applications ranked by `meritScore` desc, with `scoreSnapshot`; `knockedOut`/`pending` segregated |
| `POST /applications/:id/recompute-score` | `canManageHiring` | idempotent recompute (after config edits) |
| `POST /offers/:id/render-letter` | `canManageHiring` | render offer PDF via `letters.service.issueLetter` → `letterUrl` |
| `POST /offers/:id/request-signature` | `canManageHiring` | create built-in e-sign envelope (candidate signer) → `signatureEnvelopeId` |

### 6.7 New — public careers (unauthenticated, rate-limited)
Mounted at `/api/public/careers/*` (separate router, **no `protect`**, strict rate-limit + size/MIME caps reusing the pre-join upload caps from F4):
| Method · Path | Notes |
|---|---|
| `GET /careers/:businessSlug` | published `isPublic` jobs list (tenant-resolved from slug) |
| `GET /careers/:businessSlug/jobs/:publicSlug` | job detail + its screening questions (no points/knockout values leaked) |
| `POST /careers/:businessSlug/jobs/:publicSlug/apply` | create/dedupe `Candidate` by email, create `Application` (`appliedSource=PUBLIC`), accept resume upload + screening answers + **consent**, run `scoreScreening`. Returns a thank-you (never the score). |

---

## 7. hr-admin UX flows (plain language)

**A. Post a job (owner/recruiter).** Jobs list → "New job" → fill title/department/location/openings/salary band/country. Tab **Pipeline** shows the default stages (Applied→Screened→Shortlisted→Interview→Offer→Hired/Rejected) — editable. Tab **Screening questions**: add questions; for each, pick a type and, for choice/qualification types, list options with **points** ("Master's degree → 6", "B.Tech Computer Science → 20") and tick **Knockout** if a wrong answer should auto-reject ("Must be eligible to work in NZ → Yes"). Tab **Interview scorecard**: pick or create a scorecard template (the skill set, each 1–10, with weights). Tab **Merit weighting**: two sliders, *Application %* and *Interview %* (must total 100; default 40/60) with a live preview sentence. **Publish** flips it `OPEN` and (if `isPublic`) puts it on the careers page with a shareable link.

**B. Candidates flow in.** The pipeline board (Kanban by stage) shows each application card with the candidate name, **screening score badge** (e.g. "38/50") and a red **KO** chip if knocked out. Drag a card between stages, or open it for the full profile: resume, the **screening answers with per-line points**, and a "Why this score?" panel. Reject/shortlist are stage moves; a knockout pre-rejects automatically (HR can override).

**C. Shortlist → invite to interview.** On a shortlisted application → "Schedule interview": pick round, date/time, mode (onsite/video/phone), panel (one or more employees), and the **scorecard template** for the round. Hitting "Send invitation" emails the candidate (slot + map/meeting link + ICS) and notifies each interviewer. The system pre-creates one blank scorecard per interviewer.

**D. Interview + marking.** Each interviewer (in ESS — see §8) rates each skill 1–10 with optional notes and a recommendation, then submits. HR watches the interview detail fill in: per-interviewer weighted totals, the aggregated interview score, and submission status ("2 of 3 cards in"). HR never has to remember candidates by memory — the scorecards are the record.

**E. Merit list.** A job's **Merit list** tab shows all applicants ranked by combined score: rank, name, *Application %*, *Interview score*, **Merit (weighted)**, and a one-click drawer printing the exact formula and every contributing line (degree points, knockouts passed, each interviewer's total). Knocked-out and not-yet-interviewed candidates sit in clearly labelled sections below the ranked list. From here HR clicks the top candidate → **Make offer**.

**F. Offer → hire.** "Make offer" opens the offer form (CTC/gross, joining date, salary structure). The **India 50% wage check runs before save** (existing) — a breach is blocked with a plain-language fix ("Increase Basic+DA to ≥ ₹X"). Optionally **render the offer letter** (Letters template → PDF) and **request candidate e-signature** (built-in e-sign). When the candidate accepts, the application flips **Hired** and the **onboarding journey is seeded automatically** (existing `acceptOffer`→`seedOnboardingJourney`) — the new hire appears in Lifecycle with their pre-join link. The loop closes.

---

## 8. ESS UX flows (plain language)

**Interviewer (an employee on a panel).** ESS → **My interviews**: a list of upcoming/past panels with candidate (PII honoring the job's blind-screening mask if set), role, time, and "Score" button. Tapping opens **my scorecard**: the skill set for the round, each a 1–10 slider with a comment box, an overall recommendation, and free-text notes. Save keeps it as a draft; **Submit** locks it (you cannot edit a submitted card without HR reopening it) and contributes to the candidate's interview score. An interviewer sees **only their own** card and **only their** assigned interviews — never other interviewers' marks (until HR aggregates) and never candidates they aren't interviewing.

**Candidate (public, no account).** On the careers page they browse open roles, open one, and **Apply**: name/email/phone, resume upload, the screening questions (rendered without revealing points or which are knockouts), and a **consent checkbox** (data-processing + retention). On submit they see a thank-you — never their score. If invited to interview they get an email with the slot and a link; offer letters arrive by email and (optionally) are e-signed in the browser via the built-in e-sign signer page.

---

## 9. Security, RBAC & SoD

**9.1 Permissions (additive to `core/lib/rbac.js:11` — frozen registry, no migration):**
```js
canManageHiring:  'Create/configure jobs, screening, scorecards, schedule interviews, manage offers',
canViewHiring:    'View jobs, candidates, applications, merit lists (TEAM/req-scoped)',
canScoreInterview:'Submit interview scorecards for assigned panels (interviewer self-service)',
```
Granted: HR_ADMIN gets all three; a new **RECRUITER** preset gets `canManageHiring`+`canViewHiring`; any employee on a panel implicitly gets `canScoreInterview` for *their* interviews via `attachSelfEmployee` (scope-bound, not a tenant-wide grant). `canManageEmployees` remains a super-set (back-compat with the existing routes).

**9.2 Tenant isolation.** Every query keeps `where: { businessId }` (the existing controller convention). The public careers router resolves `businessId` from `:businessSlug` and **hard-scopes** all reads/writes to it; a public apply can never reference another tenant's job.

**9.3 F1 data-scope.** Admin list/read routes AND into `scopeWhere(req.scope)` so a hiring manager / recruiter with a `TEAM`/`DEPARTMENT` band sees only their requisitions and the candidates in them; `withEmployeeScope` gives IDOR-safe 404s on out-of-scope `:id`. Interviewer routes bind to `attachSelfEmployee` and filter `interviewerIds.includes(self.employeeId)`.

**9.4 Maker-checker SoD** (reuse `APPROVAL_ACTIONS` in `scopeResolver.js:31`): **add** recruitment actions so the fail-closed self-exclusion applies —
- An interviewer **cannot approve/extend the offer** for a candidate they scored (offer approval excludes anyone with a SUBMITTED scorecard on that application).
- The **hiring manager who creates the requisition** is not the sole offer approver if `approvalRequestId` requires a checker (reuse the existing single-approver hook; SoD = creator ≠ approver).
- An interviewer can only submit **their own** scorecard (`@@unique(businessId, interviewId, interviewerEmployeeId)` + the self-binding) — they cannot fill another panellist's card.

**9.5 Public-surface hardening:** the apply endpoint is unauthenticated → **rate-limit** per IP+email, **resume upload caps** (reuse F4's 10 MB + MIME allow-list from the pre-join upload), **no score/knockout disclosure** in any public response, mandatory **consent** capture (`Candidate.consentAt`/`consentExpiresAt` already exist → auto-purge after retention), and CAPTCHA hook. Screening **points and knockout values are never serialized** to the public job-detail response (only prompts + option labels).

**9.6 Optimistic locking + audit.** `Scorecard`/`Offer`/`Application`/`ScorecardTemplate` carry `version`; every mutation is `WHERE id=… AND version=:expected` + `version:{increment:1}` (matches the F8 fix). Every stage move, screening recompute, scorecard submit, invite, and offer transition writes an `AuditLog` row.

**9.7 Edge cases:** re-scoring after a config edit never mutates **submitted** answers/ratings (append-only ledgers) — it only re-derives the rollup decimals + snapshot; a knockout flips merit to 0 but keeps the candidate visible (auditable, overridable); deleting a scorecard template referenced by a future interview is a 409; a candidate applying twice to the same job is the existing `(businessId, jobId, candidateId)` 409; an interviewer removed from a panel keeps their already-submitted card (it counted at submit time) unless HR voids it; offer e-sign expiry/HMAC is the built-in provider's existing behavior.

---

## 10. Build plan (5 slices)

**Slice 12a — Screening engine + public apply (the auto-score foundation).**
Pure `scoring.js#scoreScreening`; Prisma `ScreeningQuestion`/`ScreeningOption`/`ScreeningAnswer` + `Application` score columns; admin screening-config CRUD; the public careers router (`GET` board/detail + `POST apply` with dedupe, consent, upload caps, rate-limit) wiring screening auto-score + knockout→auto-reject; `Application.screeningScore`/`scoreSnapshot`. Tests: knockout, qualification points, missing-screening → 0, public dedupe, no-points-leak.

**Slice 12b — Interview scorecards + interviewer ESS.**
Pure `scoring.js#scoreInterview`; Prisma `ScorecardTemplate`/`ScorecardSkill`/`Scorecard`/`ScorecardRating` + `Interview` columns; admin template CRUD; the `me/*` interviewer router (self-bound, scope-checked) to fill/submit cards; `weightedTotal` + `Application.interviewScore` recompute on submit; SoD self-binding. Tests: weight normalisation, multi-interviewer aggregation modes, self-binding 403, submit-locks-card.

**Slice 12c — Scheduling + invitations.**
Extend `createInterview` (template + slot + pre-create blank cards); `/invite`, `/reschedule`, `/cancel`; candidate email + ICS + panel notify (reuse the letters/notify seam); blind-PII mask point. Tests: invite stamps, reschedule re-invites, cancel voids DRAFT cards.

**Slice 12d — Merit list + scoring orchestrator.**
`scoring.js#computeMeritScore` + `recomputeApplicationScore`; `Job` merit-weight columns + 100% validation; `GET /jobs/:jobId/merit-list` (ranked + snapshot, KO/pending segregated); `/recompute-score`; the hr-admin Merit-list tab + "Why this rank?" drawer. Tests: blend math, renormalise on missing component, ranking order, KO→0.

**Slice 12e — Offer letters + e-sign + Hired hand-off polish.**
`/offers/:id/render-letter` (Letters `issueLetter`→`letterUrl`); `/offers/:id/request-signature` (built-in e-sign envelope, candidate signer, `signatureEnvelopeId`); confirm the existing `acceptOffer`→`seedOnboardingJourney` seam (e-signed accept path), offer-approval SoD via `APPROVAL_ACTIONS`. Tests: render artifact, e-sign accept seeds journey idempotently, SoD blocks scorer-as-approver.

*(Optional 12f — hr-admin polish: Kanban pipeline board, careers-page theming, RECRUITER role preset, audit/exports — splits out if 12a–12e run long.)*

---

## 11. Acceptance criteria (the owner's flow, end to end)

1. Owner posts a job with screening questions (one knockout, one qualification-points), an interview scorecard (3 skills, weighted), and a 40/60 merit blend → publishes to a shareable careers link.
2. A candidate applies publicly → screening auto-scores; a knockout answer auto-rejects with no score leaked; a passing candidate lands in **Screened** with a visible score badge.
3. HR shortlists → schedules an interview with a 2-person panel → candidate gets an email invite (slot + ICS); each interviewer gets a notification.
4. Each interviewer (ESS) rates each skill 1–10 and submits **their own** card; HR sees per-interviewer totals + the aggregated interview score; no interviewer sees another's card or an unassigned candidate.
5. The **Merit list** ranks candidates by combined application+interview score; the "Why this rank?" drawer prints the exact formula and every contributing line.
6. HR offers the top candidate (India 50% check enforced), optionally e-signs the letter; on accept the application flips **Hired** and an **onboarding journey is seeded automatically** — the candidate becomes a pre-join new hire in Lifecycle.
7. Throughout: tenant isolation holds, hiring-manager/interviewer reads are scope-limited, a scorer cannot approve their own candidate's offer, and every transition is audited.

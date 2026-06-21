# 11 — Employee Self-Service (ESS) & Mobile

**Owner:** Senior Product Designer (Employee Experience)
**Status:** Production design spec (not MVP)
**Surfaces covered:** Employee Self-Service web portal (`tenant.com` / `tenant.hr.com`) + native mobile apps (iOS/Android) + installable PWA.
**Last verified:** 2026-06-22 (compliance figures verified against IRD/CBDT sources cited inline).

> Cross-references:
> `00-vision-and-principles.md` (white-label principle), `01-product-requirements.md` (feature-flag matrix), `02-system-architecture.md` (router/tenant resolution, theming), `03-data-model.md` (Employee/Leave/Payslip/etc. schemas), `04-payroll-engine-design.md` (payslip & YTD figures), `05-compliance-india.md` (Form 16/130, IT declarations, PT/PF/ESI), `06-compliance-newzealand.md` (KiwiSaver, tax code, Holidays Act leave), `07-tenant-admin-hr-console.md` (the HR side of every ESS workflow — approvals), `08-leave-and-attendance.md`, `09-notifications.md`, `12-design-system-and-theming.md`.

---

## 0. Design Thesis & Non-Negotiables

The ESS is the surface **99% of all platform humans actually touch** — every employee of every tenant, every month, forever. It is the product's reputation. Three non-negotiable principles:

1. **It is NOT a builder, it is a fixed, opinionated product.** Per `00-vision-and-principles.md`, tenants configure and use; they do not design. The employee never sees a layout that the HR admin "built". The ESS is a single, pre-designed application that is *themed* (logo + one brand color + one of 5 fixed styles + bound custom domain) and *gated* (plan feature flags + tenant config decide which tiles appear). See §13.
2. **Mobile-first, mobile-equal.** The majority of ESS sessions in IN/NZ blue-and-grey-collar workforces are mobile. Every flow below is designed for a 360px viewport first, then enhanced. The native apps and PWA share ~95% of UI via React Native Web / shared design tokens (§12).
3. **Payslip correctness is sacred, and the employee is the auditor.** The payslip and tax documents are legally significant (IN: mandatory digital payslips under the 2025 Labour Codes; NZ: Holidays Act leave balances). Every figure an employee sees must be reproducible, explainable ("why is my PF this?"), and version-pinned to the compliance rule set that produced it (`05`/`06`).

### What the employee can DO (capability inventory)
Dashboard · Profile & documents · Payslips & YTD · Annual tax docs (Form 16/130 IN, IR income summary NZ) · Tax declarations (IN regime + investment proofs; NZ tax code + KiwiSaver) · Leave (apply/cancel/balances/calendar) · Attendance & geo clock-in/out · Regularization · Reimbursements/expense claims · Salary advances & loans · Performance (goals, check-ins, reviews, feedback) · Directory & org chart · Announcements & feed · Holiday calendar · Helpdesk/tickets · Notification preferences · Multi-org switcher.

### What the employee can NEVER do
Change their own CTC/comp, approve their own anything, see others' salaries, edit locked profile fields (legal name, PAN/IRD number, bank — these go through a *verification request* workflow, §3.4), alter leave balances, or see any super-admin/tenant-admin surface.

---

## 1. Surface, Routing & White-Label Resolution

### 1.1 How an employee arrives
The ESS is served at the tenant's **bound custom domain** (`people.acme.com`, `acme.hr.com`, or the fallback `acme.hr.com` subdomain). Resolution reuses Sitepresso's edge tenant-resolution worker:

- `/Users/kp/sitepresso/apps/router/cloudflare-worker.js` — maps inbound `Host` → `businessId` (here renamed conceptually `tenantId`), via Cloudflare-for-SaaS custom hostnames. Reuse verbatim; the lookup key changes from "site" to "tenant ESS app".
- `/Users/kp/sitepresso/apps/router/index.js` + `wrangler.toml` — origin routing config.
- Custom-domain + SSL issuance (Cloudflare-for-SaaS + OpenProvider) is reused from the platform; see `OPENPROVIDER_HANDOVER.md` and `02-system-architecture.md`.

The worker injects a resolved-tenant header (`x-tenant-id`, `x-tenant-style`, `x-tenant-locale`, `x-tenant-region`) so the Next.js ESS app can theme on the **first byte** (no flash of unstyled/unbranded content — critical for white-label trust). Theme tokens are resolved server-side at the edge from a KV cache keyed by tenant (mirrors how Sitepresso resolves `Subscription.themeColors`).

### 1.2 Region & locale
`x-tenant-region ∈ {IN, NZ}` drives compliance-specific UI (tax declaration screens, leave types, statutory fields). Locale: reuse i18n `en`/`hi` from `/Users/kp/sitepresso/backend/src/i18n/translator.js` and `apps/*` i18n; add `en-NZ` formatting (date `dd/mm/yyyy`, currency NZD, week-based leave). Employee can override locale within the tenant-allowed set.

### 1.3 App shell & navigation
Bottom tab bar (mobile) / left rail (desktop), max 5 primary tabs, overflow into "More":

| Tab | Contents | Feature-flag gate |
|---|---|---|
| Home | Dashboard, feed, quick actions | always on |
| Pay | Payslips, YTD, tax docs, declarations | `payroll` |
| Time | Leave, attendance, holidays, regularization | `leave` / `attendance` |
| Me | Profile, documents, reimbursements, loans, performance | always on (sub-items gated) |
| More | Directory, org chart, helpdesk, settings, switch org | per-flag |

Tabs/tiles render only if (a) plan feature-flag enabled AND (b) tenant module enabled AND (c) RBAC allows. The shell reuses `packages/admin-core` patterns for nav/RBAC gating (`/Users/kp/sitepresso/packages/admin-core`) and `packages/ui` (`/Users/kp/sitepresso/packages/ui/src/index.js`) for primitives.

---

## 2. Dashboard (Home)

### 2.1 Composition
The dashboard is a **fixed grid of pre-built cards** rendered conditionally by data + flags. No drag-drop, no widget builder. Card order is product-decided (priority below), not tenant-configurable beyond hide/show via module flags.

| # | Card | Data source | Empty/edge state |
|---|---|---|---|
| 1 | Greeting + next payday countdown | payroll calendar | "First payslip on <date>" pre-first-run |
| 2 | Latest payslip summary (net pay, click→detail) | latest finalized Payslip | hidden until first finalized run |
| 3 | Leave balances (mini, per type) | leave ledger | "No leave policy assigned yet" |
| 4 | Clock in/out (live, if attendance on) | attendance session | shows shift if rostered |
| 5 | Pending actions (approvals you owe, declarations due, missing proofs) | aggregated tasks | hidden if empty |
| 6 | Announcements (top 2) | announcement feed | hidden if none |
| 7 | Upcoming holidays / who's out today | holiday cal + team leave | — |
| 8 | Open requests status (leave/reimb/loan) | request engines | hidden if none |

### 2.2 "Pending actions" engine
A unified, ranked task inbox. Each task has `{type, dueDate, severity, deeplink, dismissible}`. Severity ranks **statutory-deadline > approval-owed > expiring-proof > informational**. Examples: "IT declaration window closes in 5 days" (IN, §6), "Confirm your KiwiSaver rate change effective 1 Apr 2026" (NZ, §6), "Upload rent receipts for HRA — Rs 1,02,000 claimed unproved", "Regularize 12 Jun missed punch", "3 leave requests await your approval (manager)".

API: `GET /ess/v1/dashboard` returns the full assembled payload in one round-trip (mobile data-cost sensitive). Cards are server-assembled to avoid N calls. ETag-cached; `stale-while-revalidate`.

---

## 3. Profile & Documents

### 3.1 Profile sections (read-mostly)
Personal · Contact · Emergency contacts · Bank · Statutory IDs · Employment (read-only) · Family/dependents · Education/experience · Skills.

### 3.2 Field editability classification
Every field carries an editability class enforced both client and server side:

| Class | Examples | Behavior |
|---|---|---|
| `SELF_EDIT` | phone, personal email, address, emergency contact, photo, dietary/T-shirt | edit inline, audit-logged, optional re-verify |
| `VERIFY_REQUIRED` | legal name, DOB, gender, **PAN (IN)**, **IRD number (NZ)**, **bank account/IFSC or NZ bank acct**, **PF/UAN**, **KiwiSaver scheme** | submit a *change request* → HR approves → field updates (state machine §3.4) |
| `HR_ONLY` (read) | employee code, DOJ, designation, department, CTC, manager, location, employment type | display only |
| `SYSTEM` (hidden) | tenantId, internal IDs, payroll group | never shown |

Statutory ID validation runs client-side then server-revalidates:
- **PAN** regex `^[A-Z]{5}[0-9]{4}[A-Z]$`; 4th char must be `P` (individual) else warn. Stored masked (`ABCDE1234F` → `ABCXX1234F` on display).
- **Aadhaar** (optional, IN): 12 digits, Verhoeff checksum; stored encrypted, masked to last 4. Never shown in full.
- **IRD number** (NZ): 8–9 digits with IRD modulus-11 check digit validation.
- **UAN** (IN PF): 12 digits.
- **Bank**: IN IFSC `^[A-Z]{4}0[A-Z0-9]{6}$` + account; NZ bank account `BB-bbbb-AAAAAAA-SS` (bank-branch-account-suffix) format validation.

### 3.3 Documents vault
Two buckets:
- **Issued-to-me** (HR/payroll → employee, read-only download): payslips (also under Pay), Form 16/130, appointment/relieving/experience letters, increment letters, tax computation sheets, KiwiSaver enrolment confirmations.
- **My-uploads** (employee → HR, for verification): ID proofs, address proof, education certs, prior Form 16, investment proofs (also under Declarations), reimbursement bills.

Storage reuses Sitepresso's S3/R2 abstraction: `/Users/kp/sitepresso/backend/src/core/lib/s3.js` (`isConfigured()` graceful fallback; R2 via custom endpoint; CloudFront/CDN public URL). **Employee documents are PRIVATE** — not public-URL'd. Access via short-lived signed URLs (≤120s) scoped to `tenantId+employeeId`; signing endpoint authorizes via RBAC before issuing. Upload via `/Users/kp/sitepresso/backend/src/core/controllers/upload.controller.js` pattern, extended with: virus scan hook, MIME/type allowlist (`pdf,jpg,png,heic`), max 10MB/file, EXIF strip on images, server-side thumbnail.

Document object schema (see `03-data-model.md`):
```
EmployeeDocument {
  id, tenantId, employeeId,
  category: enum(PAYSLIP|FORM16|FORM130|TAX_PROOF|ID_PROOF|LETTER|REIMBURSEMENT|KIWISAVER|OTHER),
  visibility: enum(EMPLOYEE_PRIVATE|HR_SHARED),
  source: enum(SYSTEM_GENERATED|EMPLOYEE_UPLOAD|HR_UPLOAD),
  storageKey, mime, sizeBytes, sha256, originalName,
  taxYear?, periodMonth?,            // for payslips/tax docs
  verificationStatus?: enum(NA|PENDING|VERIFIED|REJECTED),
  uploadedBy, uploadedAt, expiresAt?, deletedAt? (soft)
}
```

### 3.4 Profile change-request state machine (`VERIFY_REQUIRED` fields)
```
DRAFT → SUBMITTED → (HR) UNDER_REVIEW → APPROVED → APPLIED
                                      ↘ REJECTED (reason) → (employee) RESUBMIT → SUBMITTED
SUBMITTED → WITHDRAWN (by employee, before review)
```
- On `APPLIED`, the field updates, prior value snapshotted to history, employee + HR notified, audit row written.
- Bank/PAN/IRD changes that affect payroll are **blocked during an active pay run lock** (run in `LOCKED` state per `04-payroll-engine-design.md`); request queues and applies next cycle, with a clear banner: "Bank change will take effect from the <Aug 2026> payslip."
- Edge: a change request for a field also touched by an HR bulk-import → conflict detection; latest-by-timestamp wins, both parties notified.

API surface (representative):
```
GET    /ess/v1/profile
PATCH  /ess/v1/profile            # SELF_EDIT fields only; rejects others
POST   /ess/v1/profile/change-requests        {field, newValue, attachmentId?}
GET    /ess/v1/profile/change-requests
POST   /ess/v1/profile/change-requests/:id/withdraw
GET    /ess/v1/documents?category=&taxYear=
POST   /ess/v1/documents          # presigned upload init → confirm
GET    /ess/v1/documents/:id/download   # 302 to signed URL
```

---

## 4. Payslips & YTD

### 4.1 Payslip list & detail
List groups by tax year (Apr–Mar in both IN & NZ). Each row: period, pay date, gross, deductions, **net pay**, status badge. Only **finalized/published** payslips appear (draft runs invisible to employees). Detail view is a faithful, reproducible breakdown sourced from the locked payroll run (`04-payroll-engine-design.md`), version-pinned to the compliance ruleset id that computed it.

**Payslip detail structure:**
- Header: tenant logo (white-label), employee name/code/designation, period, pay date, payment mode/ref (masked bank), days paid/LOP.
- **Earnings**: line items (Basic, DA, HRA, allowances, OT, bonus, arrears…). IN: shows Basic+DA and a subtle "wages ≥ 50%" compliance indicator per 2025 Labour Codes uniform-wage definition (see `05-compliance-india.md`).
- **Deductions**: IN — PF (employee 12%), ESI (employee 0.75% if gross ≤ ₹21,000), PT (state slab, ≤ ₹2,500/yr cap), TDS, loan EMIs, advances. NZ — PAYE, KiwiSaver employee, student loan, ESCT shown on employer side.
- **Employer contributions** (informational, IN): EPF 3.67%, EPS 8.33% (capped at ₹15,000 wage), EDLI, admin charges; NZ: employer KiwiSaver, ESCT.
- **Net pay** + amount in words.
- **YTD strip**: gross, tax, PF/KiwiSaver, net — cumulative for the tax year.
- **"Explain this" affordance**: tapping any computed line opens a derivation panel ("PF = 12% × ₹stat-wage ₹15,000 = ₹1,800; capped at statutory wage ceiling"). This is the trust feature; values come from the engine's stored calc-trace, not recomputed client-side.

### 4.2 PDF & delivery
- Server-rendered PDF (same template as emailed payslip), white-labeled, with tenant footer/registration numbers. Generated once at finalize, stored as `EmployeeDocument(category=PAYSLIP, visibility=EMPLOYEE_PRIVATE)`, hash-pinned.
- **IN statutory**: digital payslip is mandatory under 2025 Labour Codes — we always generate & retain. Password-protect option (PAN-based, `ABCDE1234` first 5 letters of name + DOB) configurable by tenant.
- Download single / bulk (zip a tax year). Email-to-self. Mobile: native share sheet / save to Files.

### 4.3 Annual tax documents
| Region | Document | Availability | Notes (verified 2026-06-22) |
|---|---|---|---|
| IN | **Form 16** (Part A + B) | by **15 Jun** following FY | For **FY 2025-26**, employer issues **Form 16** (not Form 130). Form 16 still applies for income earned before 1 Apr 2026. |
| IN | **Form 130** (Parts A, B, **C**) | from **FY 2026-27** onward | Income Tax Act 2025 renumbers the salary TDS certificate to **Form 130**, effective **Tax Year 2026-27** (1 Apr 2026 onward); Part C is new. The ESS must show the *correct* document name based on tax year. |
| IN | Annual tax computation sheet | with Form 16/130 | our generated reconciliation |
| NZ | **Income summary** (myIR-aligned) | continuous; year-end after 31 Mar | NZ uses **payday filing** — gross/PAYE/ESCT/KiwiSaver/student-loan filed to IRD within **2 working days** of each payday; IRD auto-assesses most wage earners from ~May. We provide a downloadable annual income summary mirroring IRD figures (we do not issue the IRD assessment itself). |

**Implementation:** Form 16/130 documents are generated by the payroll/compliance pipeline (`05-compliance-india.md` owns the TRACES/24Q linkage and the Form 16 vs 130 switch logic by tax year) and surfaced read-only here. The ESS only *displays the right name and structure for the right tax year* and warns: NZ income summary is "for your records; IRD issues the official assessment in myIR."

API:
```
GET /ess/v1/payslips?taxYear=2025-26
GET /ess/v1/payslips/:id            # full breakdown + calc-trace
GET /ess/v1/payslips/:id/pdf
GET /ess/v1/tax-documents?taxYear=  # returns Form16|Form130|NZ income summary as appropriate
```

---

## 5. (reserved — merged into §4 & §6)

---

## 6. Tax Declarations

This is the highest-stakes employee-facing compliance flow. Two completely different region modules behind `x-tenant-region`.

### 6.1 India — Income Tax declaration (regime + investment proofs)

**Regime selection (verified 2026):**
- **New tax regime is the DEFAULT** for FY 2025-26 (AY 2026-27); old regime is opt-in.
- New regime: standard deduction **₹75,000**; Section **87A rebate up to ₹60,000** giving **nil tax up to ₹12L taxable** (₹12.75L gross with std deduction). 80C/HRA/most chapter-VI-A deductions **not** available.
- Old regime: standard deduction ₹50,000; 87A rebate ₹12,500 up to ₹5L; 80C/HRA/80D/home-loan etc. **available**.

**Flow / state machine:**
```
DECLARATION (per employee, per FY) states:
NOT_STARTED → DRAFT → SUBMITTED → (HR/payroll) LOCKED_FOR_PERIOD
  → (proof window) PROOF_PENDING → PROOF_SUBMITTED → PROOF_VERIFIED / PROOF_REJECTED
  → FINALIZED (year-end, feeds Form 16/130)
Employee may edit while DRAFT or during open declaration windows; regime switch allowed until first locked run or per tenant policy.
```

**Two-phase model (matches Indian payroll reality):**
1. **Projected declaration** (start of FY / on joining): employee picks regime, enters *intended* investments → payroll uses these to project annual tax → spreads TDS across months. Includes a built-in **old-vs-new comparator** (see §6.1.1).
2. **Proof submission window** (typically Dec–Feb, tenant-configurable): employee uploads proofs for what they actually invested. Unproved declared amounts are reversed → TDS recalculated for remaining months (the dreaded "Jan/Feb tax spike" — we surface this *before* the deadline as a Pending Action with the projected impact).

**Declaration sections (old regime):** 80C (PF, ELSS, LIC, PPF, tuition, principal repayment — cap ₹1.5L), 80CCD(1B) NPS (₹50k), 80D health insurance (self/parents, with senior-citizen sub-limits), 80E education loan interest, **HRA** (rent + landlord PAN if annual rent > ₹1,00,000), home-loan interest (Sec 24, ₹2L self-occupied), 80TTA/TTB, 80G donations, LTA, savings-on-disability, etc. Each row: `declaredAmount`, `proofRequired:bool`, `proofStatus`, `attachment[]`, `verifierNote`.

**Validation rules (representative):**
- 80C total capped at ₹1,50,000; UI shows live remaining headroom.
- HRA: if `annualRent > 100000` and `landlordPan` empty → block proof verification (statutory requirement), warn at declaration.
- Rent receipts: month coverage check (12 months or join-prorated); flag gaps.
- New regime selected → investment sections collapse/disable with explainer "Not applicable under the new regime."
- Proof file: image/PDF, OCR-assisted amount pre-fill (assist only, HR verifies), per-proof ≤10MB.

#### 6.1.1 Old-vs-New regime comparator (flagship clarity feature)
Inline calculator (computed server-side from the IN tax module in `05-compliance-india.md`, never hardcoded client-side):
- Inputs: projected gross, declared deductions.
- Output table: taxable income, tax, surcharge, cess, **net take-home** under each regime, and a recommendation badge ("New regime saves you ~₹X/yr"). Shows the 87A nil-tax-up-to-₹12L line for new regime explicitly.
- Disclaimer: "Indicative. Final liability depends on actuals; consult your tax advisor."
- The chosen regime writes to the payroll run input and is **immutable mid-year only if a finalized run exists** (else editable per tenant policy / IT rules on switching).

### 6.2 New Zealand — Tax code & KiwiSaver elections

**Tax code (IR330):** employee selects/confirms tax code (M, M SL, ME, S, SH, ST, SB, secondary codes, and special tax codes). Validation: a primary code required; student-loan suffix `SL` toggles student-loan deductions; non-notified default to `ND` (no-declaration, highest rate) with a strong warning. Feeds PAYE in `06-compliance-newzealand.md`.

**KiwiSaver elections (verified 2026-06-22 against IRD):**
- **From 1 Apr 2026, default minimum employee + employer rate rises 3% → 3.5%** (then **4% from 1 Apr 2028**).
- Employee contribution rate selectable: **3% (opt-down), 3.5% (new default), 4%, 6%, 8%, 10%**.
- **16–17 year-olds are now eligible for compulsory employer contributions from 1 Apr 2026** — ESS must surface enrolment for this cohort (DOB-driven).
- **Temporary rate-reduction:** from **1 Feb 2026**, an employee can apply to IRD to stay at 3% after the April increase; if they do, the employer may also contribute only 3%. ESS captures the *intent*/status and links to the IRD application, but the authoritative reduction is granted by IRD — we record `kiwiSaverTempReduction: {status, effectiveFrom, expiry}`.
- Opt-in / opt-out / savings-suspension (formerly "contributions holiday") states with effective dates; opt-out only valid within the statutory 2–8 week window for auto-enrolled new employees.
- ESCT (employer superannuation contribution tax) is computed on the employer KiwiSaver contribution — shown informationally on the payslip, owned by `06`.

**Flow:** `CONFIRM_TAX_CODE → ELECT_KIWISAVER_RATE → (if change) EFFECTIVE_FROM next pay period → notify`. A pre-1-Apr-2026 banner prompted every eligible employee to acknowledge the new 3.5% default or apply to stay at 3% — this acknowledgement is logged for the employer's audit trail.

**API:**
```
GET  /ess/v1/declarations/in?taxYear=2025-26
PUT  /ess/v1/declarations/in/regime           {regime: NEW|OLD}
PUT  /ess/v1/declarations/in/sections         {sectionCode, declaredAmount}
POST /ess/v1/declarations/in/proofs           {sectionCode, amount, attachmentId}
GET  /ess/v1/declarations/in/comparator       {projectedGross} -> regime comparison
GET  /ess/v1/declarations/nz
PUT  /ess/v1/declarations/nz/tax-code         {code, studentLoan:bool}
PUT  /ess/v1/declarations/nz/kiwisaver        {rate, status, tempReduction?}
```

---

## 7. Leave

(HR-side policy/approval engine is owned by `08-leave-and-attendance.md`; this is the employee surface.)

### 7.1 Region-aware leave model
- **IN:** day-based — Earned/Privilege (EL), Casual (CL), Sick (SL), maternity/paternity, comp-off, LWP. Carry-forward, encashment, accrual rules per tenant policy.
- **NZ (Holidays Act 2003):** **annual leave measured in WEEKS** (4 weeks/yr min), sick leave (10 days/yr after 6 months), bereavement, **alternative (lieu) days** for working public holidays, public holidays, family violence leave. Balances display in **weeks AND days** (the Act's hardest area — owned by `06-compliance-newzealand.md`; the ESS must display weeks correctly and never silently convert to days). Leave *value* uses Relevant Daily Pay vs Average Daily Pay — the employee sees the resulting paid amount, computed by the payroll/leave engine, never by the client.

### 7.2 Apply-leave flow & state machine
```
DRAFT → SUBMITTED → PENDING_APPROVAL(L1)[→ PENDING_APPROVAL(L2)] → APPROVED → (taken) CONSUMED
SUBMITTED/PENDING → CANCELLED_BY_EMPLOYEE
PENDING → REJECTED(reason)
APPROVED → CANCELLATION_REQUESTED → CANCELLED (HR/mgr) | CANCEL_DENIED
APPROVED (future) → auto-CONSUMED on/after dates; past-approved cancellation needs HR
```
**Apply form:** leave type (only types with balance/eligibility shown), date range with half-day/quarter-day toggles (IN), **week selection** for NZ annual leave, reason, attachment (medical cert for SL > N days), contact-while-away, optional handover note + delegate.

**Validation (client + server):**
- Live balance check incl. *projected accrual* to leave date; block if insufficient unless policy allows negative/LWP.
- Overlap detection with existing leave/holidays/weekly-offs; sandwich-policy preview (whether intervening holidays are counted).
- Min-notice & max-consecutive policy enforcement; blackout periods.
- Manager-on-leave fallback to alternate approver (delegation chain).
- Backdated leave allowed only within policy window; flagged.

**Calendar views:** my calendar, team calendar (who's out — respects privacy: shows "on leave", not the type/reason unless policy permits), holiday overlay. Mobile: month + agenda.

**API:**
```
GET  /ess/v1/leave/balances
GET  /ess/v1/leave/types          # eligible types only
POST /ess/v1/leave/requests        {type, from, to, units, reason, attachmentId?, delegateId?}
POST /ess/v1/leave/requests/:id/cancel
GET  /ess/v1/leave/calendar?scope=me|team&month=
GET  /ess/v1/leave/holidays?year=  # see §11
# manager:
GET  /ess/v1/approvals?type=leave
POST /ess/v1/approvals/:id/decision {decision: APPROVE|REJECT, note}
```

---

## 8. Attendance & Clock-in/out

### 8.1 Modes (tenant-configured)
Web/app punch · **Geofenced** clock-in (GPS + radius) · selfie/face-check (optional) · kiosk/QR · biometric/integration import. ESS owns self-service punch + regularization.

### 8.2 Clock-in flow
```
SHIFT_SCHEDULED → CLOCKED_IN(geo, ts, photo?) → [BREAK_START/END]* → CLOCKED_OUT → COMPUTED(hours, OT, late, early)
Missed punch → REQUIRES_REGULARIZATION
```
- On clock-in: capture timestamp (server-trusted), GPS lat/long + accuracy, geofence pass/fail, optional selfie (stored private), device id. **If outside geofence:** soft-block with reason capture ("client site", "WFH") → flagged for manager; tenant policy may hard-block.
- Live elapsed timer on dashboard; running hours today/this week.
- **Anti-spoofing:** server trusts server clock; detects mock-location flags (Android `isFromMockProvider`), impossible-travel between consecutive punches, and clock-drift. Suspicious punches flagged, not silently dropped.

### 8.3 Offline clock-in (critical for field/manufacturing)
Clock events are **queued locally** when offline (IndexedDB / native secure store) with the **device-captured timestamp + GPS**, then synced when connectivity returns. Server records both `capturedAt` (device) and `syncedAt` (server) and trusts `capturedAt` for the worked-hours calc but flags large skews. Conflict resolution: idempotency key per punch prevents duplicates. See §12.4 for the offline sync engine.

### 8.4 Regularization (missed/incorrect punch)
```
RAISED → PENDING_APPROVAL → APPROVED (attendance corrected) | REJECTED
```
Form: date, expected in/out, actual reason, evidence. Affects payroll LOP/OT — so corrections after a run lock queue to next cycle with banner.

**API:**
```
POST /ess/v1/attendance/punch        {type:IN|OUT|BREAK_IN|BREAK_OUT, capturedAt, lat, lng, accuracy, photoId?, idempotencyKey}
GET  /ess/v1/attendance/today
GET  /ess/v1/attendance/timesheet?month=
POST /ess/v1/attendance/regularize   {date, expectedIn, expectedOut, reason, evidenceId?}
```

---

## 9. Reimbursements / Expense Claims

### 9.1 Model
Claim (header) → multiple line items (each with category, amount, currency, date, GST/tax fields IN, receipt). Multi-currency aware (INR/NZD), policy-cap aware, per-category eligibility.

### 9.2 State machine
```
DRAFT → SUBMITTED → MANAGER_APPROVAL → FINANCE_APPROVAL → APPROVED → SCHEDULED_FOR_PAYOUT → PAID
any → REJECTED(reason) → (resubmit) DRAFT
APPROVED → ON_HOLD / QUERY_RAISED → (employee responds) → back to review
PAID → reflected on payslip (if paid via payroll) or marked off-cycle
```
**Validation:** per-category caps & daily/monthly limits; duplicate-receipt detection (hash of image + amount+date); receipt mandatory above threshold; GST number capture for input-credit (IN); date within claim-period policy; mileage claims compute from distance × rate.

**Payout:** via payroll (appears as a non-taxable/taxable line per category) or off-cycle bank transfer — tenant choice; status mirrored back to ESS. OCR pre-fills amount/date/vendor (assistive).

**API:** `POST /ess/v1/reimbursements`, `GET .../:id`, `POST .../:id/submit`, `GET /ess/v1/reimbursements?status=`.

---

## 10. Salary Advances & Loans

### 10.1 Model
Loan types: salary advance, personal loan, festival advance, emergency. Fields: principal, tenure (months), interest method (flat/reducing/0%), start month. Perquisite tax (IN: interest-free/concessional loan perquisite valuation) computed by payroll module.

### 10.2 State machine
```
REQUESTED → MANAGER_APPROVAL → FINANCE_APPROVAL → APPROVED → DISBURSED
  → REPAYING (EMI auto-deducted on payslip each month) → CLOSED
APPROVED → CANCELLED (pre-disbursement)
REPAYING → FORECLOSURE_REQUESTED → FORECLOSED (lump settle) | PART_PREPAID
REPAYING → PAUSED (e.g., LOP month, policy) → resumes
employee exit → SETTLED_VIA_FNF (outstanding recovered in full-and-final)
```
ESS surfaces: request, amortization schedule (each EMI, principal/interest split, balance), EMI shown on every payslip deduction line, outstanding balance card, foreclosure request, downloadable statement. Eligibility guardrails: max outstanding = N× salary, one active loan per type, min tenure served — enforced server-side.

**API:** `POST /ess/v1/loans`, `GET /ess/v1/loans`, `GET /ess/v1/loans/:id/schedule`, `POST /ess/v1/loans/:id/foreclose`.

---

## 11. Performance

(Cycle config/calibration owned by tenant-admin `07`/performance doc; ESS is the participant surface.)

ESS capabilities, gated by `performance` flag and active cycle:
- **Goals/OKRs:** view assigned, propose, update progress %, comment, link evidence.
- **Check-ins / 1:1s:** scheduled notes, shared agenda.
- **Self-assessment:** rating + narrative against goals/competencies during open window.
- **Peer/360 feedback:** give (requested or open) and receive (manager-mediated visibility).
- **Review:** see manager review when released, acknowledge, add rebuttal; final rating + (optionally) revised comp letter delivered to Documents.
- **Continuous feedback/praise:** lightweight kudos (ties into feed §12 announcements).

State machine per participant per cycle:
```
NOT_STARTED → SELF_ASSESSMENT_OPEN → SELF_SUBMITTED → MANAGER_REVIEW → CALIBRATION(HR) → RELEASED → ACKNOWLEDGED
RELEASED → REBUTTAL_RAISED → REBUTTAL_RESOLVED → ACKNOWLEDGED
```
Privacy: peer feedback anonymity per tenant policy; salary outcomes never shown to peers.

**API:** `GET /ess/v1/performance/cycle`, `.../goals`, `POST .../self-assessment`, `POST .../feedback`, `POST .../reviews/:id/acknowledge`.

---

## 12. Directory, Org Chart, Announcements & Holidays

### 12.1 Directory
Searchable people directory: name, photo, designation, department, work email/phone (per field-visibility policy — personal contact hidden by default), location. Privacy controls: employee can hide personal mobile; HR sets org-wide field visibility. No salary, no DOB-year, no statutory IDs ever.

### 12.2 Org chart
Interactive reporting tree (zoom/pan on web, vertical scroll on mobile), rooted at viewer with up/down navigation, dotted-line managers supported, vacant-position placeholders. Built from `managerId` graph; cycle-detection guard.

### 12.3 Announcements & feed
Read-only feed of HR/admin posts: company news, policy updates, events, birthdays/anniversaries/new-joiners (per privacy opt-in), kudos. Post types: announcement (optional acknowledgement-required → tracked), event (RSVP), poll (optional). Targeting: all / department / location / custom segment (employee only *sees* what's targeted to them). Rich text + image + attachment; no builder — fixed render. Mandatory-acknowledgement posts create a Pending Action and block dismissal until acknowledged (compliance-grade, e.g., updated leave policy).

### 12.4 Holidays
Region/location-aware holiday calendar: IN (national + state-specific + optional/restricted holidays where employee picks N from a list), NZ (national + **regional anniversary days** — Holidays Act public holidays drive alternative-day entitlements). List + calendar; "optional holiday" selection flow (IN) with limit enforcement. Sourced from versioned compliance/holiday tables (super-admin maintained per `05`/`06`).

**API:** `GET /ess/v1/directory?q=`, `GET /ess/v1/org-chart?root=`, `GET /ess/v1/feed`, `POST /ess/v1/feed/:id/acknowledge`, `GET /ess/v1/holidays?year=&location=`, `POST /ess/v1/holidays/optional` (IN).

---

## 13. Helpdesk / Tickets

Employee → HR/IT/Payroll ticketing.
- **Categories** (tenant-configurable, default set): Payroll query, Leave/attendance, IT/access, Document request, Facilities, Grievance (confidential), Other.
- **Ticket state machine:**
```
OPEN → ASSIGNED → IN_PROGRESS → (need info) WAITING_ON_EMPLOYEE → IN_PROGRESS → RESOLVED → CLOSED
RESOLVED → REOPENED (employee, within N days)
any → ESCALATED (SLA breach / employee escalate)
```
- SLA timers per category, threaded replies, attachments, satisfaction rating on close. **Grievance** category supports confidential routing (bypasses line manager) — important for harassment/whistleblower compliance.
- Payroll-query tickets can deep-link to the specific payslip line in question (carries `payslipId`+`lineCode`).

**API:** `POST /ess/v1/tickets`, `GET /ess/v1/tickets`, `POST /ess/v1/tickets/:id/reply`, `POST /ess/v1/tickets/:id/reopen`.

---

## 14. Mobile Apps & PWA

### 14.1 Architecture decision
Three clients, one design system, one API:
1. **Responsive web ESS** (Next.js 14 + Tailwind, reusing `packages/ui`) — the canonical surface.
2. **Installable PWA** — same web app + manifest + service worker; covers most needs cheaply, gets push on Android/desktop and iOS 16.4+ (web push). Reuse the PWA scaffolding pattern from `/Users/kp/sitepresso/apps/chat-mobile/web/manifest.json` + `index.html`.
3. **Native apps (iOS/Android)** for App/Play Store presence + reliable push + biometric unlock + background geofence clock-in + offline. **Recommendation: React Native (Expo)** sharing TypeScript domain logic & design tokens with the web app, rather than Flutter — Sitepresso's existing front-end is React/Tailwind and the `chat-mobile` Flutter scaffold (`/Users/kp/sitepresso/apps/chat-mobile`, `pubspec.yaml`) was a minimal web-agent stub, not a reuse asset for a rich ESS. React Native maximizes code/skill reuse. (Open question for founder — §17.)

> White-label note: native apps cannot be re-skinned per tenant in the stores. Strategy: **one branded "Workspace by <Platform>" app** that themes to the employee's tenant on login (logo + brand color + style), with optional **per-tenant white-label app builds** as a premium add-on (separate bundle id, store listing, push certs) for enterprise plans. The web/PWA at `tenant.com` is fully white-label out of the box.

### 14.2 Mobile-first flow principles
- Thumb-reachable primary actions (bottom sheet CTAs), single-column, 44px tap targets, progressive disclosure (declaration sections collapse).
- Heavy actions (declarations, claims with receipts) optimized for *capture-now, complete-later* (snap receipt → draft).
- Biometric app-lock (Face/Touch ID) gating Pay/Profile sections.
- Data-frugal: dashboard one-shot endpoint (§2.2), thumbnails, lazy PDF fetch, image compression on upload.

### 14.3 Offline considerations
| Capability | Offline behavior |
|---|---|
| Clock-in/out | **Queued offline** with device timestamp+GPS, idempotent sync (§8.3) — must-have for field staff |
| View last payslip/profile | Cached (encrypted) read-only |
| Draft leave/claim/declaration | Saved locally, sync on reconnect |
| Submit/approve | Requires connectivity; queued submits replay with idempotency keys; user sees "will send when online" |
| Documents | Last-downloaded cached encrypted; re-fetch needs network |
Sync engine: outbox pattern with idempotency keys + server-side dedupe; conflict policy: server authoritative for balances/approvals, last-write for drafts. Local store encrypted (SQLCipher/secure-store); cache purged on logout/role change.

### 14.4 Push notifications
Reuse Sitepresso's multi-channel notification spine: smart router `/Users/kp/sitepresso/backend/src/core/lib/notifications/router.js`, provider adapters `.../providers.js` (Twilio SMS/WhatsApp, MSG91, SES email), templates `.../templates.js`, country routing `.../countryRouting.js`, budget engine `.../budgetEngine.js`, config controllers `/Users/kp/sitepresso/backend/src/core/controllers/notification*.controller.js`. **Add a PUSH channel adapter** (FCM Android, APNs iOS, Web Push) to `providers.js` following the existing `send()→{ok,providerMessageId}` contract.

The deferred `PushNotification` tool / FCM-APNs is the runtime; the *routing, preferences, opt-out, budget, and country logic already exist* and are reused. Channel cascade per event: PUSH → (fallback) SMS/WhatsApp → email (always-on fallback, as documented in `router.js`).

**Notification event catalog (employee):** payslip published; salary credited; leave approved/rejected; approval owed (manager); declaration window open/closing (T-7,T-2,T-0); proof missing/rejected; KiwiSaver 3.5% default acknowledgement (NZ, pre-1-Apr-2026); reimbursement approved/paid; loan EMI/closure; regularization needed (missed punch same-day); ticket update; mandatory announcement; document issued (Form 16/130 ready); birthday/anniversary.

**Preferences:** per-event × per-channel matrix in ESS settings, honoring universal opt-out (`SmsOptOut`, TRAI/TCPA) already enforced by the router. Quiet hours + per-region default channel (IN leans WhatsApp/SMS; NZ leans push/email).

### 14.5 White-label theming application (mobile + web)
Theming reuses the platform's theme engine, **slimmed to 5 fixed styles** per `00`/`12`:
- `/Users/kp/sitepresso/packages/theme-engine/index.js` (deep-merge + normalize) and `theme-colors.mjs` (per-tenant `{primary, accent, surface, bg, text}` overrides stored as `Subscription.themeColors`). For HR, the tenant supplies **logo + ONE brand color + ONE of 5 styles + bound domain** — nothing else designable (enforced; the 60+ profession themes and the page/layout builder are DELETED per project scope).
- Edge-injected tokens (§1.1) give zero-flash branding; tokens map to CSS variables consumed by `packages/ui`; the same token JSON feeds React Native via a shared theme provider. Dark mode derived from the 5-style + color (not a separate tenant choice). Accessibility: enforce min contrast on the brand color against text/surfaces — if a tenant's single brand color fails WCAG AA on a style, auto-derive an accessible on-color rather than letting them break legibility (guardrail, not a builder).

---

## 15. Cross-Cutting: Security, Privacy, Accessibility, Audit

- **Auth/RBAC:** reuse `/Users/kp/sitepresso/backend/src/core/middleware/auth.middleware.js`, `lib/rbac.js`, `controllers/auth.controller.js`; JWT + row-level `tenantId` isolation (employee can only read own data; manager scope = direct/indirect reports; HR scope = tenant). Every ESS endpoint asserts `tenantId` from token == resource tenant. Magic-link/OTP login for low-friction mobile + optional SSO (tenant IdP) on higher plans.
- **PII protection:** statutory IDs masked & encrypted at rest; documents private + signed-URL; field-level audit on every PII change.
- **Audit:** every state transition (declarations, profile changes, leave, loans, punches) writes an immutable audit row (actor, before/after, ts, ip, device) — reuses platform audit pattern; surfaced to tenant-admin (`07`) and super-admin (impersonation logged).
- **Impersonation:** super-admin support impersonation (from `apps/platform`) is **logged and banner-flagged** in the ESS ("Viewing as <employee> — support session"); read-or-act scope per policy.
- **Accessibility:** WCAG 2.2 AA, full keyboard nav, screen-reader labels, dynamic type, prefers-reduced-motion; mandatory because workforce-wide.
- **Data residency:** IN tenant data in `ap-south-1`; NZ tenant in AU/NZ region (R2/S3 endpoint per tenant region) — matches `s3.js` region config; addressed fully in `02-system-architecture.md`.

---

## 16. API Surface Summary (`/ess/v1`)

| Domain | Key endpoints |
|---|---|
| Dashboard | `GET /dashboard` |
| Profile | `GET/PATCH /profile`, `*/change-requests` |
| Documents | `GET /documents`, `POST /documents`, `GET /documents/:id/download` |
| Pay | `GET /payslips`, `/payslips/:id(/pdf)`, `GET /tax-documents` |
| Declarations | `/declarations/in/*`, `/declarations/nz/*`, `GET /declarations/in/comparator` |
| Leave | `/leave/balances|types|requests|calendar|holidays` |
| Attendance | `/attendance/punch|today|timesheet|regularize` |
| Reimbursements | `/reimbursements*` |
| Loans | `/loans*`, `/loans/:id/schedule|foreclose` |
| Performance | `/performance/*` |
| Directory/Feed | `/directory`, `/org-chart`, `/feed`, `/holidays` |
| Helpdesk | `/tickets*` |
| Approvals (mgr) | `/approvals`, `/approvals/:id/decision` |
| Settings | `/notification-preferences`, `/locale`, `/orgs` (switcher) |

All list endpoints: cursor-paginated, ETag, `?since=` for incremental mobile sync. All mutating endpoints: idempotency-key header. Versioned `/v1`; deprecation policy per `02`.

---

## 17. Open Questions for the Founder
1. **Native stack:** React Native (Expo) for code reuse with the React/Tailwind web — confirm vs Flutter (the existing `chat-mobile` Flutter stub is not a real reuse asset). My strong recommendation: React Native.
2. **Per-tenant white-label native app builds** (separate store listings, bundle ids, push certs) — premium add-on, or universal "Workspace" app that themes on login for all? Cost/ops tradeoff.
3. **NZ KiwiSaver temp-reduction UX:** do we just *record intent + link to IRD*, or pursue deeper IRD integration to reflect granted reductions automatically? (Authoritative grant is IRD's.)
4. **IT declaration proof OCR:** assistive auto-fill only, or invest in verification automation to cut HR load? (Liability implications.)
5. **Geofence hard-block vs soft-flag** default for clock-in outside radius — per-tenant policy default?
6. **Helpdesk:** build native ticketing or integrate (Freshdesk/Zoho) for tenants who already have one? Affects grievance-confidentiality guarantees.
7. **Form 16 vs Form 130 transition** display: confirm we show Form 16 for FY2025-26 and switch to Form 130 from FY2026-27 — verified, but want sign-off on the year-keyed switch owned by `05`.

---

## 18. Cross-Document Dependencies
- `03-data-model.md` — Employee, Payslip, LeaveLedger, EmployeeDocument, Declaration, Loan, Reimbursement, Ticket schemas.
- `04-payroll-engine-design.md` — payslip line items, calc-trace ("Explain this"), YTD, EMI deduction, regime input.
- `05-compliance-india.md` — Form 16/130 switch, IT declaration sections/caps, regime comparator math, PT/PF/ESI, optional-holiday rules.
- `06-compliance-newzealand.md` — tax codes, KiwiSaver rates/eligibility (3.5% from 1 Apr 2026), Holidays Act leave-in-weeks, RDP/ADP, payday-filing-derived income summary.
- `07-tenant-admin-hr-console.md` — the approval/config counterpart of every ESS workflow.
- `08-leave-and-attendance.md` — policy engine behind §7–§8.
- `09-notifications.md` / `02-system-architecture.md` — notification spine, routing, edge tenant resolution.
- `12-design-system-and-theming.md` — the 5 styles, tokens, white-label guardrails.

---

## 19. Compliance Figures Used (verified 2026-06-22)
| Figure | Value | Effective | Source |
|---|---|---|---|
| KiwiSaver default min rate | 3% → **3.5%** | 1 Apr 2026 | IRD / Business.govt.nz |
| KiwiSaver next step | 3.5% → **4%** | 1 Apr 2028 | IRD |
| 16–17 yr-olds employer contributions | newly eligible | 1 Apr 2026 | IRD |
| KiwiSaver temp 3% reduction application | available | from 1 Feb 2026 | IRD |
| IN new regime | **default** (old opt-in) | FY 2025-26 | CBDT / ClearTax |
| Std deduction (new regime) | **₹75,000** | FY 2025-26 | ClearTax |
| 87A rebate (new) | up to **₹60,000**, nil tax to **₹12L** taxable (₹12.75L gross) | FY 2025-26 | Tax2win/ClearTax |
| Form 16 | issue by **15 Jun 2026** | FY 2025-26 | CBDT |
| Form 130 (replaces Form 16) | new salary TDS certificate, Parts A/B/**C** | from **FY 2026-27** | Income Tax Act 2025 |
| NZ PAYE payday filing | within **2 working days** of payday | ongoing | IRD |
| ESI employee/threshold | 0.75% employee, gross ≤ **₹21,000** | current | EPFO/ESIC (per `05`) |
| PF employee | **12%**; EPS 8.33% capped at ₹15,000 wage | current | EPFO (per `05`) |
| PT cap | **₹2,500/yr**, state slabs | current | (per `05`) |

> Note: PF/ESI/PT detailed mechanics are authoritative in `05-compliance-india.md`; this doc consumes them for display/"Explain this".

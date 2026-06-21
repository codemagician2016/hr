# 01 — Product Requirements Document (PRD)

**Product:** Multi-tenant, white-label HRMS & Payroll SaaS ("the platform")
**Codename / fork base:** Sitepresso (`/Users/kp/sitepresso`)
**Author:** Senior Product Manager
**Status:** Production design — not an MVP. Every module is planned to ship.
**Last updated:** 2026-06-22
**Launch markets:** India (IN, INR) · New Zealand (NZ, NZD). Tax year Apr–Mar in both.

> This is the **spine document**. Sibling docs hang off it:
> - `02-system-architecture.md` — services, deploy topology, tenant routing.
> - `03-data-model.md` — full Prisma schema for the HR domain.
> - `04-payroll-engine.md` — calculation graph, run state machine, idempotency.
> - `05-compliance-india.md` — Labour Codes, EPF/ESI/PT/TDS, statutory filings.
> - `06-compliance-newzealand.md` — Holidays Act 2003, PAYE/KiwiSaver/ACC, payday filing.
> - `07-billing-and-plans.md` — gateway integration, metering, dunning (expands §15 here).
> - `08-ess-and-mobile.md` — employee self-service + mobile spec.
> - `09-security-privacy-compliance.md` — DPDP Act (IN), Privacy Act 2020 (NZ), RBAC, audit.
> - `10-super-admin.md` — SaaS operator console + versioned compliance rule tables.
> Cross-references use these filenames inline.

---

## Table of Contents

1. Product vision, principles & non-goals
2. Personas & surfaces
3. Tenancy, identity & isolation model
4. Reuse map (what we fork from Sitepresso, with file paths)
5. Glossary & domain ubiquitous language
6. Module catalogue (the complete product)
   - 6.1 Marketing & Onboarding (hr.com)
   - 6.2 Company Setup Wizard
   - 6.3 Org, People & Positions (HRIS core)
   - 6.4 Employment Lifecycle (onboarding → offboarding)
   - 6.5 Time, Attendance & Scheduling
   - 6.6 Leave & Absence
   - 6.7 Payroll Engine (cross-country core)
   - 6.8 India Statutory & Compliance
   - 6.9 New Zealand Statutory & Compliance
   - 6.10 Compensation, Benefits & Reimbursements
   - 6.11 Documents, e-Sign & Letters
   - 6.12 Performance, Goals & Reviews
   - 6.13 Expenses & Claims
   - 6.14 Assets & Inventory
   - 6.15 Helpdesk / Cases
   - 6.16 Analytics, Reports & Registers
   - 6.17 Notifications & Comms
   - 6.18 Employee Self-Service (ESS) & Mobile
   - 6.19 Super Admin (SaaS operator)
   - 6.20 Branding & White-Label
   - 6.21 Integrations & Public API
7. Cross-cutting requirements (i18n, a11y, audit, data residency)
8. Plans, packaging & feature-flag matrix
9. Per-seat pricing model (IN / NZ)
10. Global acceptance criteria & launch gates
11. Open questions for the founder
12. Verified 2026 compliance fact base (with sources)

---

## 1. Product vision, principles & non-goals

### 1.1 One-line vision
A **pre-built, opinionated HRMS + Payroll** that an Indian or New Zealand employer can stand up in under 30 minutes, run a provably-correct first payroll within one cycle, and white-label to their own domain — without writing a line of config code or "building" anything.

### 1.2 Product principles (non-negotiable)

| # | Principle | What it means in practice |
|---|-----------|---------------------------|
| P1 | **Pre-built system, NOT a builder** | No page/form/layout/workflow builder. Tenants *configure* (data + settings + plan flags) and *use*. Every screen ships fixed. |
| P2 | **Compliance is the product** | Statutory correctness (IN Labour Codes, NZ Holidays Act) is the flagship value, not a checkbox. We own the rule tables and version them centrally (see `10-super-admin.md`). |
| P3 | **Provable correctness** | Every payroll number is explainable: each line item carries a calculation trace (`inputs → rule version → formula → output`). Auditors and employees can drill down. |
| P4 | **Versioned rules, never hard-coded** | Rates/thresholds/slabs live in **effective-dated** compliance tables, never in code. A rate change is a data migration + new version row, not a redeploy. |
| P5 | **Multi-tenant isolation by construction** | Every row carries `businessId`. Reuses Sitepresso's row-level isolation + `requireBusiness` guard (§3). |
| P6 | **Minimal but total branding** | Logo + ONE brand color + ONE of 5 fixed styles + bound custom domain. Nothing else is designable (P1). |
| P7 | **Money-grade engineering** | Integer minor units for currency, deterministic rounding rules per jurisdiction, idempotent payroll runs, immutable audit, double-entry-style adjustment ledger. |

### 1.3 Non-goals (explicit)
- No website/storefront/e-commerce/booking (those Sitepresso verticals are **deleted** — see §4).
- No arbitrary report builder, no formula language exposed to tenants, no custom field *types* beyond a fixed catalogue.
- No third-country payroll at launch (RoW is **sellable** as HRIS-only; **payroll** is IN + NZ only). RoW billing uses Paddle.
- No employee-built workflows; approval chains are *configured from fixed templates*, not authored.

---

## 2. Personas & surfaces

### 2.1 Surfaces

| Surface | Host | Audience | App (new) | Reuse base |
|---|---|---|---|---|
| **Marketing + Onboarding** | `hr.com` | Prospects, buyers | `apps/hr-marketing` | `apps/platform` marketing/signup/onboarding routes |
| **Super Admin** | `admin.hr.com` | We (SaaS operator) | `apps/platform` (kept, reskinned) | `apps/platform/app/superadmin`, `backend/src/superadmin` |
| **Tenant Admin (HR console)** | `app.hr.com` | Employer HR/Finance/Admins | `apps/hr` (admin shell) | `packages/admin-core`, `packages/ui` |
| **Employee Self-Service** | `tenant.com` / `tenant.hr.com` | Employees, managers | `apps/hr` (ESS shell) + mobile | tenant routing in `apps/router` |

### 2.2 Personas

| Persona | Surface | Goals | Key permissions |
|---|---|---|---|
| **SaaS Operator (us)** | Super Admin | Manage tenants, plans, pricing, promos, compliance rule versions, support/impersonate | Platform-global |
| **Tenant Owner** | HR console | Own the account, billing, plan, domain, full config | Tenant-global (super-role) |
| **HR Admin** | HR console | Run people ops, leave, attendance, documents | Most HR modules, no billing |
| **Payroll Admin / Finance** | HR console | Run payroll, statutory filings, bank files, GL export | Payroll + reports; gated by maker-checker |
| **Line Manager** | HR console (scoped) + ESS | Approve leave/timesheets/expenses for direct reports | Team-scoped approvals only |
| **Employee** | ESS / mobile | View payslip, apply leave, clock in/out, claim expense, update profile, e-sign docs | Self-scoped |
| **Auditor (read-only)** | HR console | Inspect registers, payroll traces, audit log | Read-only, all tenant data |
| **Implementation/Support (us)** | Super Admin → impersonate | Help a tenant configure | Time-boxed impersonation, fully audited |

---

## 3. Tenancy, identity & isolation model

### 3.1 Tenant = `Business`
We reuse the Sitepresso `Business` model as the **tenant root** (`backend/prisma/schema.prisma:108`). Every HR-domain row carries `businessId` (FK, `onDelete: Cascade`), exactly as existing models do. Country (`Business.country`, ISO-3166-1 alpha-2) and `timezone` (IANA) already exist and drive jurisdiction selection.

> **Decision:** A tenant operates **one primary payroll country** (IN or NZ) per `Business`. A multi-country employer (e.g. an entity in both IN and NZ) provisions **two tenants** under one billing parent (`BillingGroup`, new — see §15). This keeps statutory rule resolution unambiguous and isolation clean. Cross-tenant consolidated reporting is a Super-Admin / Enterprise feature.

### 3.2 Identity
- **Operators (HR/Admin/Manager)** authenticate as `User` (reuse `User` model, `schema.prisma:18`) with JWT cookies. Auth middleware reused from `backend/src/core/middleware/auth.middleware.js` (token-revocation-on-password-change, operator vs customer cookie split already implemented).
- **Employees** are the new first-class **`Employee`** record (HR domain) but log into ESS via a `User`-linked or `Customer`-linked credential. **Decision:** employees authenticate as **`User` with role `EMPLOYEE`** (new role) so ESS reuses the same hardened auth path; `Employee` holds HR data and links 1:1 to a `User` for login. This avoids the weaker `Customer` path and gives employees MFA, password revocation, and audit parity.
- **RBAC** reuses `BusinessRole` (`schema.prisma:3609`) + `backend/src/core/lib/rbac.js` `effectivePermissions()`. We extend the permission catalogue with HR scopes (`payroll.run`, `leave.approve`, `employee.read.all`, `employee.read.team`, etc.) and add **maker-checker** as a permission modifier on sensitive actions.

### 3.3 Isolation guarantees
1. **Row-level:** every query is `businessId`-scoped at the service layer; `requireBusiness` guard (`backend/src/core/middleware/requireBusiness.js`) blocks un-onboarded/cross-tenant access.
2. **Impersonation:** Super-Admin impersonation is time-boxed, reason-logged, and every action is tagged `actingAs` in the audit log (see `10-super-admin.md`).
3. **Data residency:** see §7.4 and `09-security-privacy-compliance.md` — IN tenant PII stored in an India region; NZ tenant PII in an AU/NZ region. Enforced at the storage layer, surfaced as a tenant attribute.

### 3.4 Tenant lifecycle state machine
```
PROVISIONING ──▶ TRIAL ──▶ ACTIVE ──▶ PAST_DUE ──▶ SUSPENDED ──▶ CANCELLED ──▶ PURGED
     │             │          │            │            │
     │             └──────────┴────────────┴────────────┘ (reactivation paths)
     └─▶ FAILED (provisioning error; auto-retry, then ops alert)
```
- **TRIAL → ACTIVE:** first successful charge or manual conversion.
- **ACTIVE → PAST_DUE:** dunning after failed renewal (reuse Sitepresso dunning, `Subscription` model `schema.prisma:1500`).
- **SUSPENDED:** read-only ESS, payroll blocked, exports allowed (legal obligation to give employees their data).
- **CANCELLED → PURGED:** 90-day retention grace (configurable, but never below statutory record-retention minimums — IN wage registers, NZ holding records), then PII purge with audit tombstone (mirrors existing GDPR soft-delete pattern, `User.pendingDeletionAt`/`anonymisedAt`, `schema.prisma:44`).

---

## 4. Reuse map (forked from Sitepresso)

Real paths verified read-only in `/Users/kp/sitepresso`.

### 4.1 REUSE (keep, adapt)

| Capability | Sitepresso source | Adaptation |
|---|---|---|
| Tenant resolution / subdomain + custom domain routing | `apps/router/cloudflare-worker.js`, `apps/router/wrangler.toml` | Re-map vertical routes to `hr` (admin/ess); drop booking/shop/web targets |
| Super-admin shell & operator console | `apps/platform/app/superadmin`, `apps/platform/app/(unified-admin)` | Reskin; add compliance-rules + tenants views |
| Super-admin API | `backend/src/superadmin/controllers/admin.controller.js`, `routes/admin.routes.js` | Extend with HR plan/compliance endpoints |
| Auth + RBAC + tenant guards | `backend/src/core/middleware/{auth,requireBusiness,apiKey}.middleware.js`, `core/lib/rbac.js` | Add `EMPLOYEE` role + HR permission scopes + maker-checker |
| Billing — multi-gateway | `backend/src/domains/*`, `Subscription`/`PaddleBillingSubscription`/`BillingPurchase` (`schema.prisma:1500,1761,1792`), `SITEPRESSO_PAYMENT_INTEGRATION_MASTER_PLAN.md` | Razorpay (IN), Stripe (NZ), Paddle (RoW) already wired |
| Pricing tiers / per-seat / zones | `PricingTier`,`TierPrice`,`PricingZone`,`CountryZoneAssignment`,`TierFeature` (`schema.prisma:2645–2778`) | Reuse `overageStaffPriceMinor` as **per-seat** mechanism (§9) |
| Promo / coupons | `Coupon`,`AdminCoupon`,`CouponRedemption` (`schema.prisma:2521–2625`) | Reuse as-is |
| Custom domain + SSL | Cloudflare-for-SaaS + OpenProvider (`OPENPROVIDER_HANDOVER.md`, `backend/src/domains/`) | Reuse for tenant ESS domains |
| Design system | `packages/ui` (`index.js`,`admin.js`) | Reuse; add HR components (payslip, org chart, calendar grid) |
| Admin shell | `packages/admin-core` (`index.js`,`index.d.ts`) | Reuse nav/layout/table primitives |
| Theming (slim to 5 styles) | `packages/theme-engine` (`profession-styles.mjs`,`theme-colors.mjs`,`layout-presets.cjs`) | Keep token engine; **delete 60+ profession themes**, expose exactly 5 fixed styles |
| Notifications | `NotificationConfig`,`MessageTemplate`,`MessageDelivery`,`EmailDelivery` (`schema.prisma:2848–2993,2480`) | Reuse; add HR templates (payslip ready, leave approved, etc.) |
| i18n | `backend/src/i18n`, `apps/platform/i18n`, `apps/platform/messages` | Reuse en/hi; add NZ-English nuances; extend keys |
| Audit primitives | `PricingAuditLog`/`AuditAction` (`schema.prisma:2780–2795`) | Generalise into HR `AuditLog` (see `09-...`) |
| Webhooks / Public API | `ApiKey`,`WebhookSubscription`,`WebhookDelivery` (`schema.prisma:3537–3608`), `core/routes/publicV1.routes.js` | Reuse; publish HR API surface (§6.21) |
| Deploy tooling | `ecosystem.config.js`, `turbo.json`, `DEPLOY_POLICY.md` | Reuse PM2/Turbo/Vercel topology |

### 4.2 DELETE (out of scope for HRMS)
- Website/page builder: `apps/web`, `backend/src/web`, `apps/platform/app/website-builder`.
- E-commerce: `apps/shop`, `backend/src/shop` and `Product*`,`Cart*`,`Order*` models.
- Booking: `apps/booking`, `backend/src/booking` and `Appointment*`,`Service`,`StaffSchedule`,`Waitlist` (we build HR-native scheduling instead).
- Chat verticals: `apps/chat-*`, `packages/chat-*` (replaced by Helpdesk §6.15, scoped).
- The 60+ profession themes in `theme-engine`.
- Domain/mailbox resale (`Mailbox` model, OpenProvider resale flows) — but keep custom-domain binding for tenant ESS.

### 4.3 BUILD NEW
- `apps/hr` (admin + employee shells), `backend/src/hr` (HR domain services).
- HR data models (`03-data-model.md`).
- Payroll engine + IN/NZ compliance modules (`04`,`05`,`06`).
- ESS + mobile (`08-ess-and-mobile.md`).

---

## 5. Glossary (ubiquitous language)

| Term | Definition |
|---|---|
| **Tenant / Business** | An employer account. One primary payroll country. |
| **Employee** | A person employed by the tenant; HR record + ESS login. |
| **Position** | A seat in the org (reports-to, department, location, grade). An employee *holds* a position. |
| **Pay group** | A set of employees sharing a pay calendar + pay frequency + country rules. |
| **Pay run** | One execution of payroll for one pay group for one pay period. |
| **Pay component** | An earning, deduction, or contribution line (e.g. Basic, HRA, EPF, PAYE). |
| **Compliance rule version** | An effective-dated row defining a rate/threshold/slab (e.g. ESI 0.75% from 2026-04-01). Owned by Super Admin. |
| **Maker-checker** | A two-person control: one user submits, another approves, before a sensitive action commits. |
| **Seat (billable)** | An *active* employee in a pay period (definition in §9.3). |
| **RDP / ADP (NZ)** | Relevant Daily Pay / Average Daily Pay (Holidays Act 2003). |
| **CTC (IN)** | Cost to Company; structured per Labour-Code wage definition (Basic+DA ≥ 50%). |

---

## 6. Module catalogue

> Each module below states: **Purpose · Surfaces · User stories · Functional requirements · States · API surface · Edge cases · Acceptance criteria.**
> Notation: states in `MONOSPACE`; permissions in `dotted.scopes`.

---

### 6.1 Module: Marketing & Onboarding (hr.com)

**Purpose.** Sell the product, capture signups, route the buyer into the guided Company Setup Wizard. White-labelled employee portals do NOT live here.

**Surfaces.** `hr.com` (public). Reuses `apps/platform` marketing/signup/auth routes (`app/signup`, `app/login`, `app/forgot-password`, `app/legal/*`).

**User stories.**
- As a prospect, I see country-correct pricing (INR if IN, NZD if NZ) auto-detected by geo, with a manual switch.
- As a buyer, I can start a free trial without a card, choose IN or NZ, and land in the setup wizard.
- As a buyer, I can book a demo / contact sales for Enterprise.

**Functional requirements.**
1. Geo-aware pricing page driven by `PricingZone`/`CountryZoneAssignment` + `TierPrice` (reuse `core/routes/publicPricing.routes.js`).
2. Signup creates `User(role=OWNER)` + `Business(status=PROVISIONING)`; emits `tenant.created`.
3. Plan selection deferred-allowed: trial starts on the default plan for the chosen country.
4. Localised legal pages: IN (DPDP Act), NZ (Privacy Act 2020), DPA, sub-processors — reuse `app/legal/*`.
5. SEO/marketing content is **operator-managed** (Super Admin), not tenant-editable (P1).

**States.** Lead → SignedUp → TrialStarted (hands off to §6.2).

**Acceptance criteria.**
- AC1: Visitor from an Indian IP sees INR pricing by default; from NZ sees NZD; switchable.
- AC2: Trial signup provisions a tenant and redirects to the wizard in < 5s p95.
- AC3: No card required for trial; card capture only at conversion.

---

### 6.2 Module: Company Setup Wizard

**Purpose.** A guided, **fixed** (non-builder) flow that turns a blank tenant into a payroll-ready org. This is the single most important onboarding asset — first-run correctness drives retention.

**Surfaces.** `app.hr.com` post-signup. New (`apps/hr`).

**Wizard steps (fixed order, resumable, each independently valid).**

| Step | Collects | Validates | Blocks payroll if missing |
|---|---|---|---|
| 1. Company profile | Legal name, country (locked to signup choice), entity type, registered address, timezone, financial year start (Apr) | Country-specific entity fields | Yes |
| 2. Statutory IDs | **IN:** PAN, TAN, PF estab. code, ESI code, GSTIN (opt), PT registration (state-wise), LWF. **NZ:** IRD number, ACC classification unit, employer KiwiSaver status | Format + checksum (PAN regex, IRD mod-11) | Yes (for relevant statutory components) |
| 3. Locations & departments | Work locations (state for IN PT), departments, cost centres | At least one location | Yes |
| 4. Pay groups & calendar | Frequency (monthly default IN; weekly/fortnightly/monthly NZ), pay day, cut-off, first period | Calendar consistency | Yes |
| 5. Salary structure templates | Pick from **pre-built** templates (IN: Basic≥50%, HRA, special allowance, …; NZ: ordinary pay, allowances). Tenant sets *values*, not structure shape | IN: Basic+DA ≥ 50% of gross (hard rule) | Yes |
| 6. Leave policies | Pick fixed policy templates; set quotas/accrual; IN earned/casual/sick; NZ 4 weeks annual + sick + bereavement + public holidays | NZ: ≥ 4 weeks annual; ≥ 10 days sick (statutory floor) | No (defaults applied) |
| 7. Bank & payment file | Employer bank account, payout method (IN: NEFT/IMPS bulk file or gateway; NZ: bank batch / direct credit) | IFSC (IN) / NZ bank account format | For payouts only |
| 8. Add employees | Manual, CSV import, or invite-to-self-onboard | Required-field completeness per country | Per-employee |
| 9. Branding | Logo, brand color, 1 of 5 styles, custom domain bind | Color contrast (a11y), domain DNS | No |
| 10. Review & go-live | Run a **dry-run payroll** on sample data; show statutory summary | All "Yes" blockers cleared | — |

**Functional requirements.**
- Wizard is **idempotent & resumable**: progress persisted on a `CompanySetup` record with per-step `status` (`NOT_STARTED|IN_PROGRESS|COMPLETE|SKIPPED`).
- A persistent **readiness checklist** (derived) tells the admin exactly what blocks the first payroll.
- Templates come from operator-managed catalogues; tenant cannot create new structure shapes (P1).
- Step 5 enforces the **Labour-Code wage rule** at config time, not just at run time (fail fast).

**Acceptance criteria.**
- AC1: A new IN tenant can reach "go-live" with 1 employee and pass a dry-run within the trial.
- AC2: Saving a salary template where Basic+DA < 50% of gross is rejected with a specific, fixable error.
- AC3: Wizard state survives logout/login and partial completion.

---

### 6.3 Module: Org, People & Positions (HRIS core)

**Purpose.** The system of record for people, positions, reporting lines, departments, locations, cost centres.

**User stories.**
- As HR, I maintain an employee's personal, job, compensation, statutory, and bank data with full history.
- As a manager, I see my team and org chart (scoped).
- As HR, I reorganise reporting lines and the org chart updates.

**Functional requirements.**
1. **Employee record** with sectioned data: Personal, Contact, Identity/Statutory (country-specific), Job (position, manager, department, location, grade, employment type), Compensation (salary structure instance), Bank, Documents, Dependents/Emergency, Tax declarations.
2. **Effective-dated history** on every mutable HR attribute (salary, position, manager, location). No destructive edits — corrections create new effective rows; "as-of" queries supported.
3. **Position model** distinct from person: a position can be vacant, filled, or in transition; supports reorg.
4. **Custom fields** from a **fixed type catalogue** only (text, number, date, single-select from operator list, boolean, file). No tenant-defined types (P1).
5. **Employment types:** Permanent, Fixed-term, Probation, Contractor (IN), Casual (NZ), Intern. Type drives leave/payroll eligibility.
6. CSV import with dry-run validation + row-level error report; export with field-level permission masking.

**States (employee).**
```
INVITED ─▶ ONBOARDING ─▶ ACTIVE ─▶ ON_LEAVE ─▶ ACTIVE
                          │
                          ├─▶ SUSPENDED ─▶ ACTIVE
                          └─▶ NOTICE_PERIOD ─▶ OFFBOARDING ─▶ TERMINATED ─▶ ALUMNI
```

**API surface (illustrative; full in `03-data-model.md`).**
`GET/POST /v1/employees`, `GET/PATCH /v1/employees/:id`, `GET /v1/employees/:id/history?asOf=`, `POST /v1/employees/import`, `GET /v1/positions`, `GET /v1/org-chart`.

**Edge cases.** Manager cycles (A→B→A) rejected; terminating a manager forces reassignment of reports; rehire of an ALUMNI links to prior record (continuity of service for IN gratuity / NZ leave).

**Acceptance criteria.**
- AC1: Changing salary effective 2026-07-01 leaves June payroll unaffected and applies from July.
- AC2: "As-of" query returns the record state for any past date.
- AC3: An employee with no `EMPLOYEE` login still exists as an HR record (login optional).

---

### 6.4 Module: Employment Lifecycle (onboarding → offboarding)

**Purpose.** Orchestrate joiners, movers, leavers with fixed, configurable checklists.

**User stories.**
- As HR, I send an offer letter, collect documents, and the new hire self-onboards before day 1.
- As HR, I run an exit checklist that gates final settlement (FnF).

**Functional requirements.**
1. **Pre-boarding / self-onboarding:** invited employee completes profile, uploads ID docs, e-signs policies (§6.11), submits bank + tax declarations.
2. **Onboarding checklist:** fixed task templates (IT asset, induction, statutory enrolment) assignable to roles; progress tracked.
3. **Probation tracking** with confirmation workflow + reminders.
4. **Movers:** promotion, transfer (location → may change PT state in IN), manager change — all effective-dated (§6.3).
5. **Offboarding:** resignation/termination → notice period → exit checklist → **Full & Final settlement** computed by payroll (IN: gratuity if ≥ 5 yrs, leave encashment, recovery; NZ: holiday pay on termination per Holidays Act, final pay). FnF gates on checklist completion + asset return (§6.14).
6. **Document retention** post-exit per statutory minima (§3.4).

**States (offboarding):** `INITIATED → NOTICE → CLEARANCE → FNF_PENDING → FNF_APPROVED → SETTLED → ALUMNI`.

**Acceptance criteria.**
- AC1: IN employee with 5+ years gets gratuity auto-computed in FnF (15/26 × last drawn × completed years).
- AC2: NZ termination computes holiday pay on termination (8% of gross since last anniversary not yet taken, plus accrued entitlement) per `06-compliance-newzealand.md`.
- AC3: FnF cannot be marked SETTLED while assets are outstanding unless explicitly waived (audited).

---

### 6.5 Module: Time, Attendance & Scheduling

**Purpose.** Capture worked time accurately enough to drive pay (overtime, NZ daily-pay, IN OT) and statutory registers (IN mandatory attendance register).

**User stories.**
- As an employee, I clock in/out (web/mobile/geo/kiosk) or submit a timesheet.
- As a manager, I approve timesheets and regularise missed punches.
- As payroll, I get period totals (regular, OT, night, leave) feeding the pay run.

**Functional requirements.**
1. **Capture modes** (plan-gated): manual timesheet, web clock, mobile clock with geofence, biometric/kiosk integration, import.
2. **Shifts & rosters:** assign fixed shift patterns; rotating rosters; per-day expected hours (critical input to NZ daily-pay calcs).
3. **Overtime rules** (configurable from templates): IN — OT at statutory multiple on hours beyond limit; NZ — per employment agreement.
4. **Regularisation** workflow for missed/incorrect punches (maker-checker by manager).
5. **Attendance register** export — **IN mandatory digital register** (§6.8).
6. **Public-holiday awareness** (NZ) — worked public holidays trigger 1.5× + alternative (lieu) day; integrates with leave (§6.6) and payroll (§6.9).

**States (timesheet):** `OPEN → SUBMITTED → APPROVED → LOCKED(→ payroll) | REJECTED`.

**Edge cases.** Overnight shifts crossing midnight; DST transition (NZ Pacific/Auckland) — store UTC, compute in tenant tz; clock-in without clock-out auto-flagged.

**Acceptance criteria.**
- AC1: A NZ employee working a public holiday generates 1.5× pay + an alternative holiday credit.
- AC2: Locked timesheets cannot change without an audited unlock (maker-checker).
- AC3: IN attendance register export matches statutory format and the pay-period totals exactly.

---

### 6.6 Module: Leave & Absence

**Purpose.** Manage entitlements, accrual, balances, requests, approvals — and feed payroll/Holidays-Act calcs.

**User stories.**
- As an employee, I see balances and apply for leave; I see the impact on pay.
- As a manager, I approve/reject with calendar visibility of team coverage.
- As HR, I configure policies from fixed templates and run year-end carry-forward.

**Functional requirements.**
1. **Leave types** (country defaults, template-driven):
   - **IN:** Earned/Privilege Leave (accrual + encashment), Casual, Sick, Maternity (26 weeks under Maternity Benefit Act), Paternity (policy), Comp-off, LWP (loss of pay).
   - **NZ:** Annual holidays (**4 weeks/year, measured in weeks** — Holidays Act 2003), Sick leave (**10 days/year** statutory), Bereavement, Family violence leave, Public holidays, Alternative (lieu) days, Parental leave.
2. **Accrual engines:** anniversary-based, calendar-based, pro-rata for joiners/leavers; NZ annual holidays accrue and become *entitled* on each anniversary (12 months) — system tracks both accrued-and-entitled vs accrued-not-yet-entitled.
3. **Balances** with future-dated bookings reserved; negative-balance policy (block / allow to limit).
4. **Approval chains** from fixed templates (1-step / 2-step / manager+HR); delegation when approver on leave.
5. **Holiday calendars** per location (IN state public holidays; NZ national + regional anniversary days).
6. **Carry-forward / lapse / encashment** at FY end (Apr–Mar) per policy.
7. **Half-day / hourly leave** support (drives NZ daily-pay precision).

**States (request):** `DRAFT → SUBMITTED → APPROVED → TAKEN | CANCELLED | REJECTED`; post-approval cancellation re-credits balance.

**Edge cases.** Leave spanning a public holiday (not deducted); sandwich-leave policy (configurable); leave during notice period; NZ "leave in advance" before entitlement.

**Acceptance criteria.**
- AC1: NZ annual leave shows in **weeks** and pays at the greater of ordinary weekly pay vs average weekly earnings (per `06-...`).
- AC2: IN earned-leave encashment computes on the correct wage base.
- AC3: Approving leave reduces available balance and blocks double-booking.

---

### 6.7 Module: Payroll Engine (cross-country core)

> Deep spec in `04-payroll-engine.md`. This section is the PRD contract.

**Purpose.** Deterministically compute net pay, employer costs, statutory contributions, and produce payslips, bank files, GL, and statutory outputs — **with a verifiable trace per number**.

**User stories.**
- As payroll admin, I run a pay group for a period; I review variances vs last period; I get sign-off via maker-checker; I publish payslips and generate the bank file.
- As an employee, I receive an explainable payslip.
- As finance, I export a GL journal and reconcile.

**Architecture (engine).**
1. **Inputs resolver:** for each employee in the pay group, gather salary structure instance, attendance/LOP, leave, one-time inputs (bonus, arrears), reimbursements, tax declarations, prior-period adjustments.
2. **Calculation graph:** pay components computed as a **DAG** (e.g. Basic → HRA depends on Basic; PF depends on Basic+DA; ESI depends on gross; PAYE depends on taxable). Topologically ordered; no cycles. Each node records `{inputs, ruleVersionId, formula, output}` → the **trace**.
3. **Rule resolution:** every statutory node binds to the **effective-dated compliance rule version** for the period's country + date (see `05`/`06`, `10`). Never hard-coded.
4. **Rounding:** per-jurisdiction rounding policy applied at defined points (IN rounds tax/components per IT rules; NZ PAYE per IRD tables). Currency stored in **integer minor units**.
5. **Determinism & idempotency:** a run is keyed `(payGroupId, periodId, runSeq)`; re-running with identical inputs yields identical outputs; inputs snapshotted at lock.

**Pay-run state machine.**
```
DRAFT ─▶ INPUTS_LOCKED ─▶ CALCULATED ─▶ IN_REVIEW ─▶ APPROVED ─▶ PUBLISHED ─▶ PAID ─▶ CLOSED
  │            │               │            │
  └─ recalc ◀──┴───────────────┘            └─▶ REJECTED ─▶ DRAFT (with reason)
                                            
PUBLISHED/PAID ─▶ (correction) ─▶ OFF_CYCLE_ADJUSTMENT run (never edit a closed run)
```
- **Maker-checker** mandatory between `IN_REVIEW` and `APPROVED` (configurable to require Finance + HR).
- **Closed runs are immutable.** Corrections happen via **off-cycle / supplementary** runs and the **adjustment ledger** (reuse pattern of `AdjustmentLedger`, `schema.prisma:1883`).

**Outputs.**
- Payslips (PDF + ESS) with full breakup + YTD.
- Bank disbursement file (IN: NEFT/bulk format or gateway payout; NZ: bank batch).
- Statutory outputs (§6.8 / §6.9).
- **GL journal export** (mapped to tenant chart-of-accounts; CSV + accounting integrations §6.21).
- **Variance report** (this run vs prior) for review.

**Functional requirements.**
1. Off-cycle runs (bonus, FnF, corrections) with the same engine and traceability.
2. Arrears handling (retro salary change) — recompute affected prior periods, post delta in current run, never mutate closed runs.
3. Multi-currency display in tenant currency; FX not needed intra-tenant (single country).
4. **Pay register** and **YTD ledgers** per employee.
5. Sandbox **dry-run** (no side effects) — used by wizard go-live (§6.2) and by admins pre-run.

**Edge cases.** Mid-period joiner/leaver pro-ration; LOP affecting PF/ESI wage base; negative net pay (recoveries) — block + route to off-cycle; salary structure change crossing 50%-rule mid-year (IN); employee crossing ESI ₹21,000 ceiling mid-contribution-period (IN rule: continues to period end).

**Acceptance criteria.**
- AC1: Re-running an unchanged period produces byte-identical outputs (idempotency proof).
- AC2: Every payslip line links to its calculation trace (rule version + formula + inputs).
- AC3: A closed run can never be edited; corrections appear as a separate audited off-cycle run.
- AC4: Bank file totals equal the sum of net pays equal the GL net-pay credit.

---

### 6.8 Module: India Statutory & Compliance

> Authoritative spec: `05-compliance-india.md`. Figures here are **verified 2026** (see §12).

**Purpose.** Make IN payroll legally correct and filing-ready under the **New Labour Codes (in force 21 Nov 2025)** and the Income-tax Act 2025.

**Functional requirements (each backed by a versioned rule table).**

1. **Wage definition (Labour Codes):** enforce **Basic + DA ≥ 50% of total remuneration**; if excluded allowances exceed 50%, the excess is deemed "wages" and added to the wage base (cascades into PF & gratuity). Enforced at config (§6.2 step 5) and at run.
2. **EPF/EPS/EDLI:** Employee 12% + Employer 12% of Basic+DA. Employer split: **EPS 8.33% capped at ₹1,250 (₹15,000 wage ceiling)**, balance to **EPF 3.67%**; **EDLI 0.5%** (₹75 cap on ₹15k) + admin charges. Mandatory at **20+ employees**. Generate **ECR** file.
3. **ESI:** Employee **0.75%** + Employer **3.25%** on gross where **gross ≤ ₹21,000** (₹25,000 for persons with disability). Mandatory at **10 employees**. Mid-period crossing rule: continue to contribution-period end.
4. **Professional Tax (PT):** **state-specific slabs**, capped at **₹2,500/year**; resolved by employee work-location state. Maintain per-state slab versions.
5. **TDS (income tax):** Compute under **New Regime as default** (old regime opt-in). New-regime slabs FY 2025-26 (0/5/10/15/20/30 across the ₹3L–₹15L+ bands); **standard deduction ₹75,000**; **§87A rebate → nil tax up to ₹12L taxable** (₹60,000 rebate) → salaried zero-tax up to ₹12.75L. Old regime supported with its deductions for opt-in employees. Investment-declaration + proof workflow; perquisite valuation.
6. **Gratuity:** **15/26 × last drawn wages × completed years** (Payment of Gratuity / Code on Social Security). Accrual provisioning + payout at FnF (≥ 5 years, with statutory exceptions).
7. **LWF** (state Labour Welfare Fund) where applicable.
8. **Statutory deposits & filings (calendar + reminders):**
   - **TDS deposit by 7th** of next month.
   - **PF & ESIC by 15th** of next month.
   - **Form 24Q quarterly** — Q1 31 Jul, Q2 31 Oct, Q3 31 Jan, Q4 31 May.
   - **Annual salary TDS certificate:** **Form 16 for FY 2025-26** (issue by 15 Jun 2026); **Form 130 for FY 2026-27 onward** under the Income-tax Act 2025 (issue by 15 Jun 2027). System emits the correct form per tax year (see §12 — verified).
9. **Mandatory digital registers & payslips:** wage register, attendance register, and digital payslips (Labour-Code requirement).

**Outputs.** ECR (PF), ESI return file, PT challans per state, Form 24Q (FVU-ready), Form 16/130 PDFs, gratuity statements, digital registers.

**Acceptance criteria.**
- AC1: A salary structure violating Basic+DA ≥ 50% is blocked at config and at run.
- AC2: EPS contribution is correctly capped at ₹1,250 when Basic+DA > ₹15,000.
- AC3: An employee with taxable income ₹12.5L (salaried, ₹75k std deduction) shows **nil tax** under the new regime via §87A.
- AC4: The system issues **Form 16** for FY 2025-26 and **Form 130** for FY 2026-27; a "Form 16" for FY 2026-27 is never produced.
- AC5: Statutory due-date reminders fire for 7th/15th/quarterly deadlines.

---

### 6.9 Module: New Zealand Statutory & Compliance

> Authoritative spec: `06-compliance-newzealand.md`. **Holidays Act 2003 correctness is our flagship NZ feature.** Figures verified 2026 (§12).

**Purpose.** Correct PAYE, KiwiSaver, ACC, student-loan, and — above all — **Holidays Act 2003 leave/pay** calculations, with **payday filing** to IRD.

**Functional requirements.**

1. **PAYE:** income tax + ACC earner levy deducted per IRD tables by tax code (M, ME, SB, S, SH, ST, etc.) and secondary-income codes. **ACC earners' levy 1.75%** on earnings up to **$156,641** (max levy **$2,741.22**) **from 1 Apr 2026** (was 1.67%). Verified §12.
2. **KiwiSaver:** default **employee + employer minimum 3.5% from 1 Apr 2026** (rises to 4% on 1 Apr 2028); employee rates 3/4/6/8/10%. **16–17-year-olds become eligible for employer contributions from 1 Apr 2026.** **ESCT** on employer contributions by ESCT rate threshold. Temporary savings-suspension and rate-reduction (down to 3%) supported.
3. **Student loan** deductions (12% above the pay-period threshold) with SL codes; voluntary extra deductions.
4. **Minimum wage** validation: **adult $23.95/hr from 1 Apr 2026** (plus starting-out/training rates) — block configs below floor.
5. **Holidays Act 2003 (flagship):**
   - **Annual holidays in WEEKS** (4 weeks/yr; entitled at each 12-month anniversary). Pay = **greater of Ordinary Weekly Pay (OWP) and Average Weekly Earnings (AWE, 52-week)**.
   - **Public holidays:** if otherwise-working-day → paid at **Relevant Daily Pay (RDP)** or **Average Daily Pay (ADP)** when RDP not practicable; if **worked** → time-and-a-half **plus an alternative (lieu) day**.
   - **Sick (10 days)/Bereavement/Family-violence:** paid at RDP/ADP.
   - **Alternative holidays** ("days in lieu") tracked, takeable, paid at RDP, cashable after 12 months (by agreement).
   - **8% pay-as-you-go** holiday pay for genuinely fixed-term (<12 months)/casual where lawful; **holiday pay on termination** = 8% of gross earnings since last anniversary (for entitlement not yet taken) + value of entitled-but-untaken leave.
   - **Gross earnings, OWP, AWE, RDP, ADP** each computed from a **clearly-defined earnings inclusion set** — the calculation engine stores the inputs and the chosen method per event (provable correctness; this is the audit centrepiece).
6. **Payday filing:** file employment-income information to IRD **within 2 working days of each payday** (Employment Information / EI return), including new/departing employees. Verified §12.
7. **Records:** holiday & leave records and wage/time records retained per the Act (≥ 6 years / current holdings).

**Outputs.** Payday-filing EI file (IRD-ready), KiwiSaver employment details, payslips with leave balances in weeks, Holidays-Act leave records, ACC/ESCT summaries.

**Edge cases.** Variable-hours employees (AWE-dominant); changing work patterns mid-year; closedown periods; employee with <12 months at a public holiday (otherwise-working-day test); cashing-up up to 1 week annual leave per year by request.

**Acceptance criteria.**
- AC1: Annual-leave pay uses **greater of OWP and AWE**; the chosen basis and both figures are stored on the payslip event.
- AC2: A worked public holiday yields **1.5× + 1 alternative day**; a not-worked otherwise-working-day public holiday pays **RDP** (or ADP with documented reason).
- AC3: KiwiSaver employer + employee compute at **3.5%** for pay dates on/after 1 Apr 2026; a 16-year-old now receives employer contributions.
- AC4: ACC earner levy computes at **1.75%** capped at **$2,741.22** for 2026-27.
- AC5: Payday filing output is generated and due-date-tracked within **2 working days** of pay date.
- AC6: A config setting adult wage below **$23.95/hr** (post 1 Apr 2026) is blocked.

---

### 6.10 Module: Compensation, Benefits & Reimbursements

**Purpose.** Structure pay, manage benefits, and handle tax-relevant reimbursements/allowances.

**Functional requirements.**
1. **Salary structures** as instances of operator-provided templates (no shape-building, P1). Components flagged: taxable/non-taxable, statutory-base inclusion, proratable, recurring/one-time.
2. **Benefits:** IN — flexi-benefit/FBP allocation (HRA, LTA, food, etc.) within tax rules; NZ — benefits typically taxable/FBT-flagged (FBT computation noted as a finance report, not full FBT filing at launch — see open questions).
3. **Reimbursements:** claim → approve → pay via payroll or off-cycle; tax treatment per component.
4. **Compensation revisions:** effective-dated increments, bulk revision cycles, arrears auto-handled by §6.7.
5. **Bonus/variable pay** runs (off-cycle).

**Acceptance criteria.**
- AC1: Switching an employee's HRA changes IN tax exemption and reflects in the next run only.
- AC2: A reimbursement approved this period is paid and correctly tax-treated.

---

### 6.11 Module: Documents, e-Sign & Letters

**Purpose.** Generate, store, and e-sign HR documents from **fixed templates**.

**Functional requirements.**
1. **Template library** (operator + tenant-selectable, merge-field driven — NOT a builder): offer letter, appointment letter, confirmation, increment, relieving/experience letter, payslip, Form 16/130, leave policy, NDA.
2. **Merge fields** from employee + payroll data; preview; PDF generation.
3. **e-Sign:** in-platform signature capture (reuse `User.signatureUrl`/`stampUrl`, `schema.prisma:37`) + audit trail (who/when/IP/hash). Optional external e-sign provider integration (§6.21).
4. **Document vault** per employee with access control + retention; expiry reminders (e.g. visa/work-permit).
5. **Bulk generation** (e.g. all increment letters for a cycle).

**Acceptance criteria.**
- AC1: An offer letter merges correct salary breakup and is e-signable with a tamper-evident audit record.
- AC2: Documents inherit tenant branding (logo/color/style) automatically.

---

### 6.12 Module: Performance, Goals & Reviews

**Purpose.** Lightweight, configurable (not built) performance management.

**Functional requirements.**
1. Review cycles (fixed templates: annual/half-yearly/quarterly/probation).
2. Goals/OKRs/KRAs with weightage; self + manager + optional peer/skip-level review.
3. Rating scales (operator-provided options); calibration view for HR.
4. Outcomes link to compensation cycles (§6.10) — read-only suggestion, not auto-applied.
5. Continuous feedback / 1:1 notes (optional).

**States (review):** `NOT_STARTED → SELF → MANAGER → CALIBRATION → SHARED → CLOSED`.

**Acceptance criteria.**
- AC1: A cycle can run end-to-end with self+manager stages and produce a shareable summary.
- AC2: Ratings feed a comp-cycle suggestion without auto-changing salary.

---

### 6.13 Module: Expenses & Claims

**Purpose.** Out-of-pocket and travel expense claims with policy controls.

**Functional requirements.**
1. Claim with categories, receipts (OCR optional), per-category limits/policies (template-driven).
2. Multi-stage approval (manager → finance) with maker-checker on payout.
3. Reimburse via payroll or off-cycle; tax treatment per category (IN); GST capture (IN, optional).
4. Mileage (NZ/IN rates), per-diem.

**States:** `DRAFT → SUBMITTED → APPROVED → REIMBURSED | REJECTED`.

**Acceptance criteria.** A claim exceeding policy limit is flagged and requires higher approval; reimbursement reconciles to payroll/GL.

---

### 6.14 Module: Assets & Inventory

**Purpose.** Track assets assigned to employees; gate offboarding clearance.

**Functional requirements.** Asset catalogue, assignment/return, condition, depreciation note (informational), integration with offboarding clearance (§6.4).
**States:** `AVAILABLE → ASSIGNED → IN_REPAIR → RETURNED → RETIRED`.
**Acceptance criteria.** FnF blocks while assets are `ASSIGNED` unless waived (audited).

---

### 6.15 Module: Helpdesk / Cases (HR service desk)

**Purpose.** Employees raise HR/payroll queries; HR resolves with SLAs. Reuses Sitepresso support primitives (`SupportConversation`/`SupportMessage`, `schema.prisma:2423`).

**Functional requirements.** Categories (payroll, leave, IT, general), assignment, SLA timers, internal notes, knowledge-base articles (operator/tenant curated, not built), satisfaction rating.
**States:** `OPEN → IN_PROGRESS → WAITING_EMPLOYEE → RESOLVED → CLOSED`.
**Acceptance criteria.** A payroll query routes to payroll admins; SLA breach escalates.

---

### 6.16 Module: Analytics, Reports & Registers

**Purpose.** Pre-built dashboards + a **fixed report catalogue** (not a report builder, P1).

**Functional requirements.**
1. **Dashboards:** headcount, attrition, gender/diversity, payroll cost, leave liability, statutory liability.
2. **Report catalogue** (filter/group within fixed shapes only): payroll register, component-wise, statutory (PF/ESI/PT/TDS; PAYE/KiwiSaver/ACC), variance, headcount, attrition, leave balance/liability, attendance/OT.
3. **Statutory registers:** IN digital wage + attendance registers; NZ holiday & wage-time records.
4. **Scheduled exports** (CSV/XLSX/PDF) and API access (§6.21).
5. **Saved filters** (not new report shapes).

**Acceptance criteria.** Every statutory report matches the underlying pay-run numbers exactly and exports in the required regulator format.

---

### 6.17 Module: Notifications & Comms

**Purpose.** Timely, branded, multi-channel comms. Reuses `NotificationConfig`/`MessageTemplate`/`MessageDelivery`/`EmailDelivery` (`schema.prisma:2848–2993,2480`).

**Functional requirements.** Channels: email (always), in-app inbox (reuse `InboxNotification`, `schema.prisma:2397`), SMS/WhatsApp (plan-metered, reuse Sitepresso messaging budget mechanism), push (mobile §6.18). Event catalogue: payslip ready, leave approved/rejected, timesheet due, statutory due-date, document to sign, review due, birthday/anniversary. Quiet hours, locale-aware templates, per-tenant branding.
**Acceptance criteria.** "Payslip ready" fires on publish to all paid employees via their preferred channel, branded per tenant.

---

### 6.18 Module: Employee Self-Service (ESS) & Mobile

> Deep spec: `08-ess-and-mobile.md`.

**Purpose.** The white-labelled employee portal at `tenant.com` / `tenant.hr.com` and mobile app.

**Functional requirements.**
1. **Profile** view/edit (gated fields), bank/tax declaration updates (with approval where statutory).
2. **Payslips & tax docs** (Form 16/130 IN; NZ payslip + leave-in-weeks), YTD, downloadable.
3. **Leave**: balances, apply, calendar, team availability (managers).
4. **Attendance**: clock in/out (geo), timesheets, regularisation.
5. **Expenses & claims** submission.
6. **Documents**: view/e-sign, vault.
7. **Approvals inbox** for managers (leave/timesheet/expense).
8. **Helpdesk** raise/track.
9. **Mobile**: native-grade PWA + optional native wrapper; push notifications; offline-tolerant clock-in; biometric unlock.
10. **White-label**: tenant logo/color/style/domain applied; "powered by" only on lower tiers (plan-gated, §8).

**Acceptance criteria.**
- AC1: An employee on `tenant.com` sees only tenant branding (no platform brand on paid tiers).
- AC2: Manager approvals work on mobile with push.
- AC3: ESS enforces self-scope: an employee can never see another employee's pay data.

---

### 6.19 Module: Super Admin (SaaS operator)

> Deep spec: `10-super-admin.md`. Reuses `apps/platform/app/superadmin` + `backend/src/superadmin`.

**Purpose.** Run the SaaS.

**Functional requirements.**
1. **Tenants:** list, inspect, lifecycle actions (§3.4), data-residency region, usage.
2. **Plans & pricing:** manage `PricingTier`/`TierPrice`/`PricingZone` (reuse); per-seat overage config (§9); plan feature flags (§8).
3. **Promo codes:** reuse `AdminCoupon` (`schema.prisma:2579`).
4. **Billing ops:** gateway routing (Razorpay IN / Stripe NZ / Paddle RoW), invoices, refunds, dunning, revenue.
5. **Compliance rule tables (CRITICAL):** versioned, effective-dated, **per-country** editors for every rate/threshold/slab (EPF/ESI/PT/TDS; PAYE/KiwiSaver/ACC/minimum-wage/Holidays-Act parameters). Publish workflow with effective dates, preview, and rollout to all tenants without redeploy. **This is the operational heart of compliance (P4).**
6. **Feature flags by plan** and per-tenant overrides.
7. **Platform analytics:** MRR/ARR, churn, activation (time-to-first-payroll), usage by module.
8. **Support & impersonation:** time-boxed, reason-logged, fully audited.
9. **Audit:** global, immutable.

**Acceptance criteria.**
- AC1: Publishing a new ESI rate effective 2026-04-01 changes all IN tenants' April runs with **no deploy** and **no impact on pre-April closed runs**.
- AC2: Impersonation is fully audited and time-boxed.
- AC3: A plan flag toggle hides/shows the module across the relevant tenants within one cache cycle.

---

### 6.20 Module: Branding & White-Label

**Purpose.** Enforce P6: minimal but total branding.

**Functional requirements (the ONLY designable surface).**
1. **Logo** (upload, constraints).
2. **ONE brand color** (with auto-derived accessible palette via `theme-engine/theme-colors.mjs`; a11y contrast enforced).
3. **ONE of exactly 5 fixed styles** (slimmed from `theme-engine`; the 60+ profession themes are deleted, §4).
4. **Bound custom domain** + SSL via Cloudflare-for-SaaS (reuse `apps/router` + domains pipeline).
5. Email/document/payslip branding inherits automatically.
**Non-goals:** no layout/section/font/CSS editing, no page builder (P1).
**Acceptance criteria.** Choosing a color + style + logo + domain rebrands ESS, emails, and PDFs consistently; nothing else is editable.

---

### 6.21 Module: Integrations & Public API

**Purpose.** Connect to accounting, banking, identity, e-sign, and let tenants/partners build on us. Reuses `ApiKey`/`WebhookSubscription`/`WebhookDelivery` (`schema.prisma:3537–3608`) and `core/routes/publicV1.routes.js`.

**Functional requirements.**
1. **Public REST API v1** (HR domain): employees, leave, attendance, payroll (read), documents — key-auth, tenant-scoped, rate-limited.
2. **Webhooks:** `employee.*`, `payrun.published`, `leave.approved`, etc., with signed delivery + retries (reuse delivery model).
3. **Accounting:** GL export + integrations (Tally/Zoho IN; Xero/MYOB NZ) — at least file-based at launch, API where available.
4. **Banking:** bulk payment file generation per country; gateway payout (Razorpay/Stripe) optional.
5. **Identity/SSO:** Google + SAML/OIDC for Enterprise.
6. **e-Sign:** optional external provider.
7. **Biometric/attendance devices:** import adapters.
**Acceptance criteria.** A tenant can pull employees and push a `payrun.published` webhook to their endpoint with signature verification; GL export imports cleanly into Xero (NZ) / Tally (IN).

---

## 7. Cross-cutting requirements

### 7.1 Internationalisation & localisation
- Reuse `backend/src/i18n` + `apps/platform/messages`. Locales: `en`, `hi` (existing), plus NZ-English conventions. Currency/number/date formatting per locale; INR (₹) and NZD ($) with correct grouping; tax-year labels Apr–Mar.

### 7.2 Accessibility
- WCAG 2.2 AA across HR console + ESS; brand-color contrast enforced at config time (§6.20).

### 7.3 Audit & immutability
- Generalised `AuditLog` (from `PricingAuditLog` pattern) records actor, `actingAs` (impersonation), entity, before/after, IP, timestamp. Payroll runs, comp changes, statutory configs, and FnF are always audited. Closed pay runs and published statutory outputs are immutable.

### 7.4 Data residency & privacy
- IN tenants: PII stored in an India region; **DPDP Act 2023** controls. NZ tenants: AU/NZ region; **Privacy Act 2020** controls. Reuse GDPR-style soft-delete/anonymise (`User.pendingDeletionAt`/`anonymisedAt`). Full spec in `09-security-privacy-compliance.md`.

### 7.5 Performance & reliability targets
- HR console p95 < 400ms server; payroll run for 500 employees < 60s; ESS payslip load < 1s. 99.9% uptime target; payroll is the highest-criticality path.

### 7.6 Money correctness
- Integer minor units everywhere; jurisdiction rounding policies; reconciliation invariants (bank file = Σ net = GL). No floats in money math.

---

## 8. Plans, packaging & feature-flag matrix

### 8.1 Plan tiers
Four self-serve tiers + Enterprise (quote). Mechanism reuses `PricingTier`/`TierFeature` (`schema.prisma:2645,2757`) with `vertical='HR'`.

| Tier | Slug | Positioning | Target |
|---|---|---|---|
| **Starter** | `hr-starter` | HRIS + leave + ESS, no payroll | ≤ 25 emp, getting organised |
| **Payroll** | `hr-payroll` | Adds full statutory payroll (IN/NZ) | SMB running payroll in-house |
| **Growth** | `hr-growth` | Adds performance, expenses, advanced reports, API, white-label domain | Scaling 50–250 |
| **Enterprise** | `hr-enterprise` | SSO/SAML, multi-entity/billing group, data-residency choice, audit exports, SLA, dedicated support | 250+, multi-country |

### 8.2 Feature-flag-by-plan matrix
`✓` included · `△` add-on/metered · `—` not available. Flags resolved via `TierFeature` + per-tenant overrides (§6.19).

| Capability | Starter | Payroll | Growth | Enterprise |
|---|:--:|:--:|:--:|:--:|
| HRIS core, org, positions (§6.3) | ✓ | ✓ | ✓ | ✓ |
| Employment lifecycle (§6.4) | ✓ | ✓ | ✓ | ✓ |
| Leave & absence (§6.6) | ✓ | ✓ | ✓ | ✓ |
| Time & attendance (§6.5) | basic | ✓ | ✓ | ✓ |
| Geofence / kiosk / biometric (§6.5) | — | △ | ✓ | ✓ |
| **Payroll engine (§6.7)** | — | ✓ | ✓ | ✓ |
| **IN statutory (§6.8)** | — | ✓ | ✓ | ✓ |
| **NZ statutory + Holidays Act (§6.9)** | — | ✓ | ✓ | ✓ |
| Off-cycle / FnF / arrears | — | ✓ | ✓ | ✓ |
| Documents & e-sign (§6.11) | basic | ✓ | ✓ | ✓ |
| Performance (§6.12) | — | — | ✓ | ✓ |
| Expenses & claims (§6.13) | — | △ | ✓ | ✓ |
| Assets (§6.14) | — | ✓ | ✓ | ✓ |
| Helpdesk (§6.15) | — | ✓ | ✓ | ✓ |
| Reports catalogue (§6.16) | basic | standard | advanced | advanced+exports |
| ESS web (§6.18) | ✓ | ✓ | ✓ | ✓ |
| Mobile app + push (§6.18) | — | ✓ | ✓ | ✓ |
| White-label custom domain (§6.20) | — | — | ✓ | ✓ |
| Remove "powered by" | — | — | ✓ | ✓ |
| Public API + webhooks (§6.21) | — | — | ✓ | ✓ |
| Accounting integrations (§6.21) | — | △ | ✓ | ✓ |
| SSO / SAML | — | — | — | ✓ |
| Multi-entity / billing group | — | — | — | ✓ |
| Data-residency choice | — | — | — | ✓ |
| Maker-checker on payroll | — | optional | ✓ | ✓ (enforced) |
| SLA + dedicated support | — | — | priority | ✓ |
| SMS / WhatsApp comms (§6.17) | — | △ | △ | △ |

> **Decision:** Statutory correctness (IN/NZ) is **never** behind a higher tier than the Payroll tier — selling payroll without compliance would be negligent. Compliance rules are global; only *modules* are gated.

---

## 9. Per-seat pricing model (IN / NZ)

### 9.1 Model
**Platform base fee (per tier) + per-active-seat overage beyond the included seat count.** Mechanism reuses `PricingTier.includedStaff` + `TierPrice.overageStaffPriceMinor` (`schema.prisma:2668,2736`) — already a working per-seat overage in Sitepresso. Currency resolved via `PricingZone`/`CountryZoneAssignment`; IN→INR via Razorpay, NZ→NZD via Stripe.

### 9.2 Indicative price points (launch; operator-tunable in Super Admin)
> These are **planning defaults**, fully editable per `TierPrice`. Annual = ~10× monthly (2 months free). Figures are list prices ex-tax (GST IN / GST NZ added per `07-billing-and-plans.md`).

**India (INR / month):**

| Tier | Base (incl. seats) | Included seats | Per extra active seat / mo |
|---|---:|---:|---:|
| Starter | ₹1,499 | 10 | ₹49 |
| Payroll | ₹3,999 | 15 | ₹99 |
| Growth | ₹9,999 | 30 | ₹149 |
| Enterprise | Quote | Negotiated | Negotiated |

**New Zealand (NZD / month):**

| Tier | Base (incl. seats) | Included seats | Per extra active seat / mo |
|---|---:|---:|---:|
| Starter | NZ$49 | 10 | NZ$3 |
| Payroll | NZ$99 | 15 | NZ$6 |
| Growth | NZ$199 | 30 | NZ$9 |
| Enterprise | Quote | Negotiated | Negotiated |

> NZ payroll buyers benchmark per-employee/month; the base-plus-seat model maps cleanly. IN buyers are base-fee sensitive; hence a low base + low per-seat. **Open question O5** revisits exact numbers vs market (Keka/RazorpayX IN; PayHero/Smartly NZ).

### 9.3 Billable-seat definition (avoids disputes)
A seat is billable in a billing month if the employee was **`ACTIVE` (or `ON_LEAVE`) for ≥ 1 day** **and** appeared in **≥ 1 pay run** in that month (Payroll+ tiers) **or** had an ESS login OR HR record edit (Starter). `INVITED`-only, `ALUMNI`, and never-activated records are **not** billable. Seat count is computed at period close; mid-month joiners/leavers are **pro-rated** by days active.

### 9.4 Billing mechanics
- Monthly true-up: overage = `max(0, peakBillableSeats − includedSeats) × overagePrice`, pro-rated.
- Annual plans: included seats apply; overage billed monthly in arrears.
- Promo codes via `AdminCoupon`. Dunning/PAST_DUE per §3.4. Full integration in `07-billing-and-plans.md`.

### 9.5 Currency & gateway routing
| Country | Currency | Gateway | Tax |
|---|---|---|---|
| IN | INR | Razorpay | GST 18% (display + invoice) |
| NZ | NZD | Stripe | GST 15% |
| RoW (HRIS-only) | local | Paddle (MoR) | handled by Paddle |

---

## 10. Global acceptance criteria & launch gates

A market (IN or NZ) is **launch-ready** only when:
1. A new tenant can self-onboard and reach a passing **dry-run payroll** within the trial (§6.2).
2. **Payroll idempotency** proven: re-run = identical output (§6.7 AC1).
3. **Every statutory number is traceable** to a versioned rule + formula (§6.7 AC2).
4. **IN:** Basic+DA ≥ 50% enforced; EPF/EPS cap correct; ESI ceiling correct; PT per state; new-regime TDS with §87A nil-to-₹12L; Form 16 (FY25-26)/Form 130 (FY26-27 onward) issuance; due-date reminders (§6.8 AC1–5).
5. **NZ:** Holidays-Act annual leave in weeks at greater-of-OWP/AWE; public-holiday 1.5×+lieu; KiwiSaver 3.5% incl. 16–17yo; ACC 1.75%/$2,741.22 cap; min wage $23.95 floor; **payday filing within 2 working days** (§6.9 AC1–6).
6. **Closed runs immutable**; corrections only via audited off-cycle (§6.7 AC3).
7. **White-label** ESS on custom domain with tenant-only branding (§6.18 AC1).
8. **Isolation**: cross-tenant access impossible; impersonation audited (§3, §6.19).
9. **A11y** WCAG 2.2 AA; **money invariants** hold (bank=Σnet=GL).
10. **Compliance rule change with no deploy** demonstrated end-to-end (§6.19 AC1).

---

## 11. Open questions for the founder

- **O1 — Multi-country entity:** Confirm the "one payroll country per tenant; two tenants under a billing group for IN+NZ employers" decision (§3.1). Alternative: single tenant, multi-country pay groups (more complex rule resolution).
- **O2 — Employee identity:** Confirm employees authenticate as `User(role=EMPLOYEE)` (stronger auth) vs reusing the lighter `Customer` path (§3.2). Recommend `User`.
- **O3 — NZ FBT scope:** At launch, do we compute and file **Fringe Benefit Tax** (NZ) and **perquisite/FBT-equivalents** fully, or provide finance-report data only? (§6.10). Recommend report-only at GA, full FBT in a fast-follow.
- **O4 — Form 16 vs Form 130 cutover:** Verified that Form 16 applies for FY 2025-26 (issue by 15 Jun 2026) and Form 130 from FY 2026-27 (issue by 15 Jun 2027). Confirm we ship **both** generators and switch by tax year (§6.8 AC4). Also confirm whether to track the rumoured TRACES download dependency.
- **O5 — Pricing:** Approve indicative price points (§9.2) or set against named competitors (Keka/RazorpayX IN; Smartly/PayHero NZ). Confirm seat definition (§9.3).
- **O6 — Payout rails:** Do we disburse salaries (gateway payout / bank-file) at GA, or only generate bank files for the tenant to upload? Recommend bank-file at GA, gateway payout fast-follow.
- **O7 — IN PF/ESI applicability automation:** Auto-enrol statutory components once headcount crosses 20 (PF) / 10 (ESI), or require explicit admin confirmation? Recommend prompt + confirm (legal sign-off).
- **O8 — Data residency hosting:** Confirm region choices (IN region for IN tenants; AU/NZ for NZ) and provider — impacts `02-system-architecture.md`.
- **O9 — RoW HRIS-only:** Confirm we sell HRIS (no payroll) to RoW via Paddle at launch, or hold RoW until a third payroll country is built.
- **O10 — Pending IN state rules:** Central/State Labour-Code *rules* were still being finalised as of Mar 2026 (FAQ dated 16.03.2026). Confirm our policy for states whose detailed rules lag the 21-Nov-2025 commencement (we default to Code provisions + per-state versioned overrides).

---

## 12. Verified 2026 compliance fact base (sources)

All figures below were verified via web search on 2026-06-22 and underpin §6.8/§6.9 acceptance criteria. Authoritative detail lives in `05-compliance-india.md` and `06-compliance-newzealand.md`.

### India (verified)
- **New Labour Codes in force 21 Nov 2025** (Code on Wages 2019; Social Security 2020; Industrial Relations 2020; OSH 2020); detailed Central/State rules still being finalised (Ministry FAQ 16.03.2026).
- **Wage definition:** Basic+DA (and retaining allowance) must be **≥ 50% of total remuneration**; excess exclusions over 50% are deemed wages.
- **EPF:** 12% employee + 12% employer on Basic+DA; **EPS 8.33% capped at ₹1,250 (₹15,000 ceiling)**, EPF 3.67% balance; mandatory **20+** employees.
- **ESI:** **0.75% employee + 3.25% employer** on gross **≤ ₹21,000** (₹25,000 disability); mandatory **10** employees.
- **Professional Tax:** state-specific, capped **₹2,500/yr**.
- **New tax regime is default**; slabs FY 2025-26 0/5/10/15/20/30; **standard deduction ₹75,000**; **§87A rebate → nil tax to ₹12L taxable** (₹60,000), salaried zero-tax to ₹12.75L; old regime opt-in.
- **TDS deposit 7th; PF & ESIC 15th; Form 24Q** Q1 31 Jul / Q2 31 Oct / Q3 31 Jan / Q4 31 May.
- **Form 16 → Form 130:** Form 16 issued for FY 2025-26 (by 15 Jun 2026); **Form 130** under Income-tax Act 2025 for FY 2026-27 onward (by 15 Jun 2027). A "Form 16" for income after 1 Apr 2026 is non-compliant.
- **Gratuity:** 15/26 × last drawn × completed years.

Sources: [PayrollOrg — Labour Codes in force](https://payroll.org/news-resources/news/news-detail/2025/12/17/india-s-new-labour-codes-are-in-force-payroll-teams-must-act) · [Ministry of Labour FAQ 16.03.2026 (PDF)](https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf) · [Cyril Amarchand — Guide to Labour Codes (PDF)](https://www.cyrilshroff.com/wp-content/uploads/2025/12/Guide-to-the-Labour-Codes.pdf) · [EPFO contribution rates (PDF)](https://www.epfindia.gov.in/site_docs/PDFs/MiscPDFs/ContributionRate.pdf) · [Tally — ESI rate 2026](https://tallysolutions.com/business-guides/esi-contribution-rate-2026-current-percentage-for-employer-employee/) · [ClearTax — income tax slabs FY 2025-26](https://cleartax.in/s/income-tax-slabs) · [ClearTax — §87A rebate](https://cleartax.in/s/income-tax-rebate-us-87a) · [BusinessToday — Form 130 successor to Form 16](https://www.businesstoday.in/personal-finance/tax/story/what-is-form-130-the-successor-to-form-16-under-the-new-income-tax-act-2025-522899-2026-03-28) · [Fincash — Professional Tax slabs FY 26-27](https://www.fincash.com/l/professional-tax-in-india)

### New Zealand (verified)
- **KiwiSaver:** default min **3% → 3.5% from 1 Apr 2026** (→ 4% on 1 Apr 2028); **16–17-year-olds eligible for employer contributions from 1 Apr 2026**; temporary rate reduction to 3% available.
- **ACC earners' levy:** **1.67% → 1.75% from 1 Apr 2026**, max liable earnings **$156,641**, **max levy $2,741.22**.
- **Adult minimum wage $23.95/hr** from 1 Apr 2026.
- **PAYE + payday filing within 2 working days** of each payday to IRD; **ESCT** on employer KiwiSaver; student-loan deductions.
- **Holidays Act 2003:** annual leave in **weeks** (4/yr), greater of OWP vs AWE; public-holiday RDP/ADP, worked = 1.5× + alternative day; sick **10 days**; bereavement; alternative/lieu days.

Sources: [Generate — KiwiSaver 3.5% in 2026](https://www.generatewealth.co.nz/article/kiwisaver-minimum-contributions-rising-to-35-in-2026/) · [IRD — KiwiSaver changes](https://www.ird.govt.nz/kiwisaver-changes) · [Budget 2025 — KiwiSaver](https://www.budget.govt.nz/budget/2025/at-a-glance/kiwisaver.htm) · [NZTaxTools — ACC earner levy 2026-27 (1.75% / $156,641)](https://nztax.tools/tax-insights/acc-earner-levy-2026-27/) · [IRD — ACC earners' levy rates](https://www.ird.govt.nz/income-tax/income-tax-for-individuals/acc-clients-and-carers/acc-earners-levy-rates) · [Mercans — NZ ACC levy changes 1 Apr 2026](https://mercans.com/resources/statutory-alerts/tnew-zealand-changes-in-acc-levy-rates-1st-april-2026/) · [TAEL — 2026 payroll/ACC/KiwiSaver changes](https://www.taelsolutions.nz/news/major-payroll-levy-changes-coming-in-2026-what-small-businesses-need-to-know)

---

*End of `01-product-requirements.md`. Next: `02-system-architecture.md`.*

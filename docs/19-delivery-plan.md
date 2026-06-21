# 19 — Delivery Plan (Production-Grade, Full Product)

**Document owner:** Senior Delivery Lead / Program Manager
**Status:** Authoritative program plan. Consolidates and supersedes the inline phasing in `README.md` §3 and the per-module phasing scattered across docs 01–18.
**Scope:** The **full** product — not an MVP. Every phase is planned to production quality. "Phased" here means *correctness-gated sequencing*, not feature triage; nothing in the 21-module catalogue is dropped, only ordered.
**Markets at launch:** India (INR, Razorpay, `ap-south-1`) and New Zealand (NZD, Stripe, `ap-southeast-2`). Tax year Apr–Mar in both.
**Fork base (READ-ONLY):** Sitepresso at `/Users/kp/sitepresso`.
**Last reviewed against 2026 compliance facts:** 2026-06-22.

> **Cross-references:** `00`–`18` (full suite). Load-bearing inputs for this plan: `01-product-requirements.md` (21-module catalogue, plan/feature matrix, launch gates §10), `02-system-architecture.md` (pay-run state machine §7.3, isolation §5, queue tier §7), `15-qa-test-strategy.md` (golden-dataset gate §3, compliance regression §4, CI gates §11), `16-devops-delivery.md` (deploy↔payroll interlock §6.4, expand/contract §6.2, golden-case health gate §5.3), `17-reuse-map.md` (REUSE/ADAPT/DELETE/BUILD-NEW + fork-and-strip runbook §10).

---

## 0. How to read this document

This plan is organised as: **(1)** the delivery thesis and how we sequence on correctness, **(2)** a complete **epic breakdown** mapped to the 21 modules, **(3)** six **phases P0–P5** each with scope / exit criteria / QA gates, **(4)** the **multi-agent parallelization** model (what fans out, what must be sequential), **(5)** the **risk register**, **(6)** the ordered **Sprint 0** task list with real Sitepresso paths, and **(7)** program governance (cadence, RACI, definition-of-done, founder-decision interlocks).

Three program-level invariants govern everything below:

1. **Correctness gates, not calendar, advance a phase.** A phase exits only when its QA gate is green. The golden-dataset harness (`15` §3) and the compliance-regression pipeline (`15` §4) are the load-bearing gates; a paise/cent diff blocks the phase.
2. **Rule sets ship ahead of effective dates.** IN Labour Codes are live (21 Nov 2025); NZ changes land 1 Apr 2026. Any market's payroll launch requires its published, golden-tested rule version to exist *before* the first real `payDate` it governs (`02` §8, `16` §11).
3. **Substrate is reused, the vertical is built.** ~70% of plumbing (auth, tenancy, billing, routing, admin shell, i18n) is forked from Sitepresso; ~100% of the *vertical value* (payroll + IN/NZ compliance + ESS + talent) is new (`17` §11). The plan front-loads the reuse hardening (P0/P1) so the new build (P2+) stands on a proven base.

---

## 1. Delivery thesis & sequencing logic

### 1.1 Why this order

The product's defensibility is **provable payroll correctness on two jurisdictions, on a white-label multi-tenant substrate**. That dictates the critical path:

- **You cannot test payroll correctness without the data it consumes.** Payroll reads the employee master, compensation structures, the statutory profile, and *frozen* attendance/leave inputs. Therefore Core HR + Time + Leave (P1) must precede the payroll engine (P2/P3).
- **You cannot prove isolation after the fact.** Payroll is the most sensitive HR data on shared infrastructure; the three-layer isolation (`02` §5, `14`) must be re-hardened in P0/P1 *before* any payroll row exists, then continuously regression-tested.
- **India and New Zealand are deliberately split into two phases (P2 then P3).** They share the country-agnostic `payroll-core` but diverge entirely in compliance. Shipping IN first (the larger, demand-event market, Labour Codes already live) proves the engine + golden harness end-to-end; NZ then reuses the *machine* and adds the hardest single calculation in the product — the **Holidays Act 2003** leave engine — with the harness already in place to catch it.
- **Employee surface and talent follow the money path.** ESS (P4) renders frozen payslip snapshots; it is meaningless before payroll produces them. Talent/AI (P5) is the highest-tier upsell and the least correctness-critical, so it ships last without ever blocking compliance.

### 1.2 The six phases at a glance

| Phase | Theme | One-line exit criteria |
|---|---|---|
| **P0 — Foundation (Fork & Strip)** | Substrate | `turbo build` green on the stripped fork; verticals/builder/profession-themes deleted; tenancy/auth/billing/white-label/router rewired to HR; isolation property tests pass. |
| **P1 — Core HR + Time + ESS shell** | System of record | Effective-dated org + employee master + leave ledger + frozen `AttendancePayInput` live; isolation CI gates + rule-table console with 4-eyes publish green; white-label ESS shell renders per-tenant. |
| **P2 — India Payroll + Compliance** | The money path (IN) | IN ~220-case golden harness green to the paise; pay-run state machine + exactly-once `PayRun` constraint + 4-eyes approval live; ECR/ESIC/24Q + bank-file generators produced; compliance-regression pipeline operational. |
| **P3 — NZ Payroll + Holidays Act** | The flagship (NZ) | NZ ~200-case golden harness green to the cent incl. the full Holidays Act suite; payday-filing pipeline (≤2 working days) with reconcile; engine == oracle == hand-computed three-way agreement on Holidays Act. |
| **P4 — Polish / Mobile / Reports / Integrations** | Employee surface + last mile | WCAG 2.2 AA on all four surfaces; mobile clients + offline clock-in idempotency green; expenses/loans/assets/helpdesk live; accounting + bank + SSO + webhook integrations contract-tested. |
| **P5 — Talent / Recruitment / Performance / AI** | Growth tier | Recruitment (req→offer→onboarding handoff) + Performance (goals→review→calibration→comp link) live with the offer pre-flight sharing the *exact* 50%-wage engine code; AI assists gated, audited, no autonomous payroll mutation. |

### 1.3 What "full product, not MVP" means for phasing

Every phase ships its slice to production quality — not a stub to be revisited. We do **not** cut: off-cycle/FnF/arrears (ships *with* the engine in P2, not "later"), the full Holidays Act edge set (ships *with* NZ in P3, not a subset), maker-checker SoD, the versioned rule console, or the white-label custom domain. The deliberate v1 *boundaries* documented in the founder decisions (report-only FBT, bank-file-before-payout, upload-before-IRD-gateway) are **scope edges, not quality cuts** — each is a complete, tested capability at its chosen depth, with the deeper variant as a planned fast-follow, never a TODO.

---

## 2. Epic breakdown (all modules)

Epics are the unit of program tracking. Each maps to one or more of the 21 PRD modules (`01` §6), names its build verdict (`17`), its owning workstream, and the phase that *delivers it to production*. "Reuse" = forked from Sitepresso and hardened; "New" = built from `03`–`11`.

### 2.1 Substrate epics (foundation — reused, hardened)

| Epic | Modules | Verdict | Phase | Key deliverable |
|---|---|---|---|---|
| **E0.1 Fork & strip** | — | ADAPT/DELETE | P0 | Stripped Turborepo: verticals/builder/themes gone, `@hr/*` scope, `turbo build` green (`17` §10). |
| **E0.2 Tenant resolution & router** | §6.1 | ADAPT | P0 | `apps/router` port table + routing tree rewired to 4 HR surfaces; custom-domain lookup re-enabled (`17` §3). |
| **E0.3 Auth, session & RBAC** | §3, §6.19 | ADAPT | P0 | Operator/customer sessions → Tenant-Admin/Employee; HR permission catalogue + presets; `ensureDefaultHrRole` (`17` §2.1–2.2). |
| **E0.4 Three-layer tenant isolation** | §3.3 | NEW over fork | P0/P1 | Server-derived `businessId` → mandatory Prisma scoping `$extends` → Postgres FORCE RLS with `SET LOCAL` in `$transaction`; custom-domain uniqueness index; IDOR property tests (`02` §5, `14`, `15` §9.2). |
| **E0.5 Billing, subscriptions, promo, per-seat** | §6.19, §8, §9 | REUSE | P0/P1 | SaaS-subscription half of `gatewayRouter.js`; IN→Razorpay/INR, NZ→Stripe/NZD, RoW→Paddle; re-seed `PricingTier`/`TierFeature` as HR plans; billable-seat true-up (`17` §2.3, `01` §9). |
| **E0.6 White-label / theming / branding** | §6.20 | ADAPT (slim) | P0/P1 | Theme-engine slimmed to 5 fixed styles; `StoreBrand`→`TenantBrand` (logo + 1 color + style + domain); "no builder" invariants asserted (`17` §8, `15` §6.3). |
| **E0.7 Feature flags & plan gating** | §6.19, §8.2 | ADAPT | P0/P1 | `featuresCatalog.js` re-keyed to HR features; `admin-core` panel registry drives per-plan nav; country-conditioned `statutoryIN`/`statutoryNZ` (`17` §6). |
| **E0.8 Notifications & i18n** | §6.17 | REUSE | P0/P1 | Email/SMS/WhatsApp transports + templates; en/hi; payslip/letter locale negotiation (`17` §9). |
| **E0.9 DevOps substrate** | §7.5 | ADAPT | P0→all | Containerized OCI artifacts (ECR), CI as gate-not-deployer, region-split data planes, expand/contract migrations, deploy↔payroll interlock (`16`). |

### 2.2 Core HR epics (new)

| Epic | Modules | Phase | Key deliverable |
|---|---|---|---|
| **E1.1 Org & legal entity** | §6.3 | P1 | Multi-legal-entity org, departments, positions, work locations (per-state for IN statutory registration); effective-dated. |
| **E1.2 Employee master & lifecycle** | §6.3, §6.4 | P1 | New `Employee` model (auth columns only from `Customer`); effective-dated master; lifecycle state machine (INVITED→ACTIVE→ON_LEAVE→ALUMNI); NZ visa loop. |
| **E1.3 Compensation structures** | §6.7, §6.10 | P1 | Pay components, CTC structures, revisions (effective-dated); the 50%-wage rule primitive shared with payroll + offer engine. |
| **E1.4 Document vault & e-sign / letters** | §6.11 | P1 (vault) / P4 (e-sign) | S3-backed document vault (`17` §2.5); letter templates via `RichTextEditor`; e-sign integration in P4. |
| **E1.5 Bulk I/O** | §6.3 | P1 | CSV import/export for employees, comp, attendance; validation-first ("configure, not build"). |

### 2.3 Time & Attendance epics (new)

| Epic | Modules | Phase | Key deliverable |
|---|---|---|---|
| **E2.1 Leave & absence** | §6.6 | P1 | Append-only `LeaveLedger`; IN day-based vs NZ week-based balances; leave request state machine (mined from booking `StaffLeave`, `17` §5.1). |
| **E2.2 Attendance & scheduling** | §6.5 | P1 | Multi-channel clock-in, shifts/rosters, OT; **frozen `AttendancePayInput`** feeding payroll (the payroll↔time contract). |
| **E2.3 NZ Holidays Act leave engine** | §6.9 | P1 (model) / P3 (compute) | Leave-in-weeks model, work-pattern with effective dates, public-holiday calendar (mined from `BusinessHoliday`); OWP/AWE/RDP/ADP/OWD compute lands in P3 with NZ payroll. |
| **E2.4 Public-holiday & working-day calendars** | §6.5, §6.9 | P1 | Versioned per-country holiday calendars (incl. NZ regional anniversary + mondayisation); drives leave + NZ payday-filing deadline math (`02` §7.5). |

### 2.4 Payroll & compliance epics (new — the core)

| Epic | Modules | Phase | Key deliverable |
|---|---|---|---|
| **E3.1 Payroll core (country-agnostic)** | §6.7 | P2 | Pure, I/O-free `payroll-core`: compute pipeline, proration, YTD ledger, `calc_explain` trace, money in BigInt minor units. |
| **E3.2 Pay-run state machine & orchestration** | §6.7 | P2 | DRAFT→…→CLOSED state machine; exactly-once `@@unique([businessId,periodId,sequence])` `PayRun` row; BullMQ worker tier; idempotency/resume (`02` §7.3). |
| **E3.3 IN compliance module** | §6.8 | P2 | Income tax (new default + old opt-in, §87A + marginal relief), TDS §192 averaging, EPF/EPS/EDLI, ESI (period-lock), PT per state, gratuity, bonus, LWF, 50%-wage cascade. |
| **E3.4 IN statutory file generators** | §6.8 | P2 | ECR (EPFO), ESIC contribution file, Form 24Q/138 (FVU-valid), Form 16/130 issuance (year-keyed switch), challan/due-date clocks. |
| **E3.5 Bank advice / disbursement files** | §6.7, §6.10 | P2 (IN) / P3 (NZ) | NEFT/RTGS CSV per bank (IN), direct-credit/IB4B/ABA batch (NZ); `payout` module distinct from SaaS billing (`17` §2.3.4). |
| **E3.6 NZ compliance module** | §6.9 | P3 | PAYE (annualised periodic), KiwiSaver 3.5% + ESCT, ACC levy 1.75%/$156,641 cap, student loan, minimum-wage floor, deduction priority/net protection. |
| **E3.7 NZ Holidays Act compute engine** | §6.9 | P3 | OWP/AWE greater-of, RDP vs ADP, OWD function, alternative/lieu days, mondayisation, 8% PAYG, termination paths — the flagship moat, three-way verified. |
| **E3.8 NZ payday-filing pipeline** | §6.9 | P3 | EI dataset build + submit (myIR upload v1, gateway fast-follow), ≤2-working-day clock, reconcile cron, FilingReceipt ledger (`02` §7.5). |
| **E3.9 Off-cycle / FnF / arrears / reversal** | §6.7 | P2 (IN) / P3 (NZ) | Off-cycle runs, F&F settlement, arrears spanning rule-version boundaries, compensating-run reversal; closed runs immutable (`02` §7.4). |
| **E3.10 Compliance rule-table console & versioning** | §6.19 | P1 (console) / P2–P3 (seeds) | Super-Admin versioned rule tables, DRAFT→VALIDATED→REGRESSION_GREEN→PUBLISHED with 4-eyes; effective-date pinning; correction path (`15` §4, `02` §8). |
| **E3.11 Payslip generation** | §6.7, §6.11 | P2 (IN) / P3 (NZ) | Frozen snapshot payslip, white-labeled, tamper-hash, bilingual explainer ("EPF 12% of ₹50,000 = ₹6,000"); content-hash stable (`09`). |

### 2.5 Pay-adjacent epics (new)

| Epic | Modules | Phase | Key deliverable |
|---|---|---|---|
| **E4.1 Expenses & claims** | §6.13 | P4 | Claim lifecycle, policy limits, reimbursement into payroll/off-cycle. |
| **E4.2 Loans & advances** | §6.10 | P4 | Auto-EMI schedule, net-pay floor protection, payroll deduction integration. |
| **E4.3 Assets & inventory** | §6.14 | P4 | IT-asset lifecycle (assign→return), offboarding checklist link. |
| **E4.4 Helpdesk / HR cases** | §6.15 | P4 | HR service desk (reuses Sitepresso support/conversation shell). |
| **E4.5 Analytics, reports & registers** | §6.16 | P4 | Payroll registers, statutory registers (mandatory digital), cost reports, headcount/attrition; reuses `exporters.js`. |

### 2.6 Employee surface epics (new)

| Epic | Modules | Phase | Key deliverable |
|---|---|---|---|
| **E5.1 ESS web (white-label)** | §6.18 | P1 (shell) / P2–P3 (payslip/tax) | Payslip viewer + explainer, leave request/balance (weeks for NZ), tax declarations (IN regime choice), documents, profile; host-keyed theming. |
| **E5.2 Mobile (React Native / Expo)** | §6.18 | P4 | Themed universal app: payslips, leave, offline geo clock-in (idempotent), reimbursements, push, helpdesk. |

### 2.7 Talent epics (new)

| Epic | Modules | Phase | Key deliverable |
|---|---|---|---|
| **E6.1 Recruitment / ATS** | §6.12-adjacent (§10 doc) | P5 | Requisition→careers→pipeline→offer→onboarding handoff; **offer pre-flight shares the exact 50%-wage engine code** (`10`, hard contract with `04`/`05`). |
| **E6.2 Performance & goals** | §6.12 | P5 | Goals/OKR→feedback→reviews→calibration→comp-revision linkage. |
| **E6.3 AI assists** | §6.18-adjacent | P5 | Bounded, audited AI (payslip-explainer NL, leave-policy Q&A, anomaly summarisation); **no autonomous payroll mutation**, every output traceable. |

### 2.8 Super Admin & integrations epics

| Epic | Modules | Phase | Key deliverable |
|---|---|---|---|
| **E7.1 Super-Admin tenant lifecycle** | §6.19 | P0/P1 | Tenant CRUD/suspend/impersonate (reuse `admin.routes.js`); platform analytics (MRR/ARR/seat/churn replacing GST report). |
| **E7.2 Super-Admin compliance & billing ops** | §6.19 | P1–P3 | Rule-table publish console (E3.10), dunning/grace, promo codes, filing-deadline board. |
| **E8.1 Accounting integrations** | §6.21 | P4 | Xero (NZ), Tally/Zoho Books (IN) — GL journal export. |
| **E8.2 Bank & govt filing transport** | §6.21 | P2–P4 | Per-bank file templates (data), IRD payday-filing gateway (fast-follow), EPFO/ESIC/TRACES upload conformance. |
| **E8.3 SSO / SAML + public API + webhooks** | §6.21 | P4 | Enterprise SSO with white-label cookie-origin bridge; `ApiKey`/`WebhookSubscription` (reuse schema). |
| **E8.4 Biometric / device integrations** | §6.5 | P4 | Biometric attendance device ingestion. |

---

## 3. Phased plan — scope, exit criteria, QA gates

Each phase below specifies: **scope** (what ships), **dependencies** (what must precede), **QA gates** (the blocking checks), **exit criteria** (the one-line gate to advance), and **founder-decision interlocks** (`README` §4 decisions that must resolve in or before this phase).

---

### Phase 0 — Foundation (Fork & Strip)

**Goal:** A clean, type-checking, HR-shaped fork of Sitepresso with the SaaS substrate (auth/tenancy/billing/router/white-label) rewired and re-hardened, and *zero* dead vertical code.

**Scope (epics E0.1–E0.9, E7.1):**
- Fork the repo; rename `@sitepresso/*` → `@hr/*`; re-point `PLATFORM_DOMAIN=hr.com` (`17` §10 Phase 0).
- **Mine-then-delete** the verticals: copy schema *shapes* from booking (`StaffLeave`, `BusinessHoliday`, `StaffSchedule`, `BusinessHours`) and shop (`EcomRolePermissionGrant`, `BusinessLocation`) into `03`'s HR models *before* `rm` (`17` §5). Then delete `apps/{web,shop,booking,chat-*,aapkarider-*,qa-portal}` (keep `qa-portal` shell as the QA command centre — see note below), `backend/src/{web,shop,booking,chat,qa}`, `packages/{blog-ui,ecom-ui,chat-*,aapkarider-shared}`, the 60+ profession theme registry, buyer-side billing, and `apps/platform/app/{website-builder,blog}`.
- Rewire `apps/router` port table + routing tree to the four HR surfaces; **re-enable custom-domain lookup** (retired 2026-05-10 in Sitepresso — must be un-retired) (`17` §3.3).
- Strip vertical auto-role provisioning from `auth.middleware.js`; add `ensureDefaultHrRole`; replace `rbac.js` catalogue + presets with the HR permission set (`17` §2.1–2.2).
- Trim `gatewayRouter.js` to the SaaS-subscription half; confirm IN→Razorpay/INR, NZ→Stripe/NZD, RoW→Paddle survive; re-seed `PricingTier`/`TierFeature` as the 4 HR tiers (`17` §2.3, `01` §8).
- Slim `theme-engine` to 5 fixed styles; rename `StoreBrand`→`TenantBrand`.
- Stand up the **DevOps substrate**: ECR images, GitHub Actions CI as gate-not-deployer, region-split data-plane scaffolding, expand/contract migration discipline (`16` §3, §5, §6).
- Super-Admin tenant lifecycle reuse (E7.1): list/suspend/impersonate working against the HR `Business`.

> **Note on `qa-portal`:** `17` §1.1 lists it under DELETE as a *product*, but `15` §1.1 reuses it as the **QA command centre** (coverage, flake dashboard, release sign-off). Resolution: **keep the `apps/qa-portal` shell, delete its unrelated product logic** — it becomes the internal QA console, not a tenant-facing surface.

**Dependencies:** None (this is the start). Blocks everything.

**QA gates (P0):**
- `turbo build` type-checks the **surviving** graph — zero dangling `@sitepresso/(shop|booking|web|chat)` imports (`rg` sweep until clean, `17` §10 step 10). *This is R10's mitigation gate.*
- **Isolation property tests** pass: a customer session on `acme.hr.com` resolves `businessId=acme` and is rejected (403) on `globex` data (reuse `auth.middleware.js` cross-tenant guard + `backend/test/customerOrUser-vertical-isolation.test.js` shape).
- **Billing routing test:** `country=IN`→Razorpay/INR, `country=NZ`→Stripe/NZD, `country=AU`→Paddle/AUD (`17` §10 step 22).
- **Custom-domain re-enable verified:** a bound test domain resolves to the right tenant's ESS with a valid cert (Cloudflare-for-SaaS path proven live, not dormant).
- CI pipeline green end-to-end (lint/typecheck/unit/migration-shadow-apply) — `16` §3.

**Exit criteria:** `turbo build` green on the stripped fork; tenant-isolation property tests pass; billing gateway routing correct for IN/NZ/RoW; custom-domain binding re-verified live.

**Founder-decision interlocks:** #4 (multi-entity per tenant), #5 (new `Employee` model — recommend new, reuse auth columns only), #6 (regions — pin `region` column day one so the split is config not migration). These three **must** resolve in P0 because they shape the schema and data-plane topology.

---

### Phase 1 — Core HR + Time + ESS shell

**Goal:** The system of record. Effective-dated org + employee master + compensation + leave ledger + frozen attendance feed, on the hardened isolation base, with the rule-table console live and the white-label ESS shell rendering — everything payroll will consume in P2.

**Scope (epics E1.x, E2.1–E2.4, E0.4 completion, E0.6/E0.7 completion, E3.10 console, E5.1 shell, E7.1/E7.2):**
- **Data model migrations** (`03`): 74 Prisma models / 79+ enums with FK discipline, effective-dated, `Decimal`/`bigint` money (never 32-bit `Int`). New Prisma scoping `$extends` at the singleton; Postgres FORCE RLS with `SET LOCAL` inside `$transaction` (the RLS pooling hazard fix, `02`/`14`).
- **Org & entity** (E1.1): multi-legal-entity, departments, positions, per-state work locations.
- **Employee master & lifecycle** (E1.2): new `Employee` model; effective-dated; lifecycle state machine; NZ visa loop; bulk I/O (E1.5).
- **Compensation** (E1.3): pay components, CTC structures, effective-dated revisions; **the 50%-wage primitive built once** here and shared by payroll (P2) and the offer engine (P5).
- **Leave & attendance** (E2.1–E2.2): append-only `LeaveLedger`; IN day-based / NZ week-based; multi-channel clock-in; shifts/OT; the **frozen `AttendancePayInput`** contract that feeds payroll.
- **NZ Holidays Act model** (E2.3): leave-in-weeks data model + work-pattern-with-effective-dates + public-holiday calendar (compute deferred to P3, but the *model* and *calendars* land now so P3 only adds maths).
- **Versioned compliance rule-table console** (E3.10): Super-Admin DRAFT→VALIDATED→REGRESSION_GREEN→PUBLISHED with 4-eyes; effective-date pinning; seed IN/NZ **2026** rule sets (the seeds are validated in P2/P3 by golden tests).
- **Document vault** (E1.4): S3-backed.
- **White-label ESS shell** (E5.1 shell): host-keyed theming, customer login, notification inbox, profile, leave request/balance — payslip/tax surfaces stubbed for P2/P3.
- **Super-Admin** (E7.2): platform analytics, billing/dunning, promo, rule-publish console wiring.

**Dependencies:** P0 (substrate). E2.2 frozen attendance and E1.3 comp are hard prerequisites for P2 payroll.

**QA gates (P1):**
- **Isolation CI gates** promoted to blocking: IDOR sweep (`15` §9.2) across every HR endpoint returns 404/403 for the adversary tenant; RLS `SET LOCAL` enforced under PgBouncer transaction-pooling (no session-var leak).
- **Effective-dating property tests:** querying a record "as of" any date returns the row valid then; no overlap/gap in effective ranges (org, comp, work-pattern).
- **Leave-ledger invariants:** append-only (no in-place mutation), balance = Σ ledger; week-based vs day-based correct per country.
- **Rule-version publish dry-run:** a DRAFT version passes schema/invariant validation (brackets monotonic, caps positive, effective dates contiguous) and the 4-eyes gate before PUBLISHED (`15` §4.3).
- **Custom-domain uniqueness:** new partial unique index on `TenantDomain` + app-layer + Cloudflare check — no two tenants bind the same host (`02` §5, README §5.2).
- ESS white-label: 5 styles × brand color × logo render correctly; **no builder routes reachable** (negative test, `15` §6.3).

**Exit criteria:** Effective-dated org/employee/comp + append-only leave ledger + frozen `AttendancePayInput` live; isolation CI gates green; rule-table console publishes a dry-run version with 4-eyes; white-label ESS shell renders per-tenant with no builder surface.

**Founder-decision interlocks:** #8 (Aadhaar tokenisation — avoid full storage by default; shapes the employee statutory-ID model), #9 (50%-wage grace window — super-admin flag), #11 (PF/ESI auto-enrol vs prompt — prompt + confirm). #7 (KMS/HSM choice) must resolve here because per-tenant envelope encryption (`14`) wraps the PII landing in this phase.

---

### Phase 2 — India Payroll + Compliance + Golden-Dataset QA

**Goal:** The money path, proven for India. The country-agnostic engine + IN compliance module + pay-run state machine + statutory file generators + bank advice + payslips, gated by the IN golden-dataset harness to the paise, with the compliance-regression pipeline operational.

**Scope (epics E3.1, E3.2, E3.3, E3.4, E3.5-IN, E3.9-IN, E3.11-IN, E5.1 payslip/tax surfaces):**
- **Payroll core** (E3.1): pure, I/O-free `payroll-core` + `compliance-in`; compute pipeline; proration (each method); per-employee `YtdLedger` with `FOR UPDATE` + `ytdVersion` revalidation; `calc_explain` trace; money in BigInt minor units with IN rounding (nearest rupee for PF).
- **Pay-run state machine** (E3.2): DRAFT→INPUTS_LOCKED→CALCULATING→CALCULATED→APPROVED→READY_TO_PAY→PAID→FILING→CLOSED with all guards; **exactly-once `@@unique([businessId,periodId,sequence])` `PayRun` row created before enqueue in a transaction** (the DB, not BullMQ, is the source of exactly-once, `02` §7.3); BullMQ worker tier (`hr-payroll-workers`, `hr-filing-workers`); idempotent resume; immutable closed runs; **maker≠checker 4-eyes** approval.
- **IN compliance** (E3.3): income tax (new default + old opt-in, §87A nil-to-₹12L + marginal relief, surcharge bands, ₹75k std deduction), TDS §192 averaging (annual projection − YTD), EPF 12%+12% / EPS 8.33% capped ₹15k / EDLI / admin charges, ESI 0.75%+3.25% on gross ≤₹21k with **period-lock** (mid-period cross-out continues to period end, base-shift effective 21 Nov 2025), PT per state (MH/KA/TN/GJ/WB at launch), gratuity 15/26, bonus, LWF, and the **WAGES_50_RULE** blocking anomaly (Basic+DA ≥ 50% cascade into PF & gratuity).
- **IN statutory file generators** (E3.4): ECR (EPFO), ESIC contribution file, Form 24Q/138 (FVU-valid), Form 16/130 issuance via **year-keyed template switch** (Form 16 for FY25-26, Form 130 from TY26-27; engine is form-id-agnostic), challan + due-date clocks (TDS 7th, PF/ESI 15th, 24Q quarterly).
- **Bank advice** (E3.5-IN): NEFT/RTGS CSV per bank (templates as *data* — onboarding a bank is a fixture, not code).
- **Off-cycle / FnF / arrears** (E3.9-IN): off-cycle runs, F&F, arrears spanning a rule-version boundary (recompute uses source-period's pinned version), compensating-run reversal.
- **Payslips** (E3.11-IN): frozen snapshot, white-labeled, tamper-hash, bilingual explainer; published to ESS.
- **Compliance-regression pipeline** (completes E3.10): replay-all-golden-against-new-version, declared-delta assertion, boundary re-derivation, effective-date pinning test, correction-path test (`15` §4).

**Dependencies:** P1 (employee master, comp, frozen attendance, leave ledger, rule-table console, IN rule seed). The 50%-wage primitive from E1.3 is reused, not re-implemented.

**QA gates (P2) — the flagship gate engages:**
- **IN golden-dataset harness green to the paise** (`15` §3): ~220 scenarios across uniform-wages-50%, EPF/EPS/EDLI, ESI period-lock, PT per state, TDS §192 (incl. §87A marginal-relief band, surcharge, mid-year joiner projection), gratuity, proration/LOP/arrears, multi-entity. Expecteds **triple-derived** (hand-computed from `05` worked examples + govt calculator + independent oracle for §192/ESI); a ₹0.01 diff fails the build; expected files **CODEOWNED by @qa + @compliance**.
- **Pure-function micro-golden** (`15` §3.6): `epfSplit`, `esiContribution`, `tds192`, `proRate`, `round`/`balanceRounding` — 100% line+branch on the calc core (non-negotiable, `15` §11.2).
- **Determinism & idempotency** (`15` §3.7): same `inputHash` ⇒ byte-identical result + artifacts; second enqueue with same `(payRunId,inputHash)` returns cached, no recompute; `LOCKED` run + different input ⇒ `IMMUTABLE_RUN_VIOLATION`.
- **Property/metamorphic** (`15` §3.8): conservation (Σearnings−Σdeductions−Σstatutory==net), TDS monotonicity, cap respect (EPS ≤ 8.33%×₹15k, PT ≤ ₹2,500/yr), proration metamorphic.
- **Pay-run state-machine integration** (`15` §5.1): every guard tested; 4-eyes enforced (preparer≠approver); YTD committed in **one transaction** (no half-commit under simulated crash); exactly-once across double-click/retry/BullMQ re-add.
- **Anomaly engine** (`15` §5.2): positive+negative test for each code (`WAGES_50_RULE`, `NEGATIVE_NET`, `TDS_SWING`, `YTD_DRIFT`, `RULE_VERSION_DRIFT`, `ROUNDING_UNBALANCED`…); BLOCKERs block, WARNINGs require ack audit row.
- **Contract tests** (`15` §7): ECR byte-level fixture round-trip, ESIC file layout, 24Q FVU-validity, per-bank NEFT CSV golden.
- **Compliance-regression pipeline live** (`15` §4): a candidate rule version cannot PUBLISH without REGRESSION_GREEN + dual sign-off.
- **Deploy↔payroll interlock** (`16` §6.4) and **golden-case health gate** (`16` §5.3, `/internal/health/payroll-dryrun`) wired.
- **Pay-run perf SLO** (`15` §8): 10k employees computed+validated+locked+payslips ≤ 5 min p95.

**Exit criteria:** IN ~220-case golden harness green to the paise with triple-derived expecteds; pay-run state machine + exactly-once `PayRun` constraint + 4-eyes live; ECR/ESIC/24Q + bank-file + Form 16/130 generators FVU/format-valid; compliance-regression pipeline blocks an undeclared-delta publish.

**Founder-decision interlocks:** #10 (default PF policy — cap at ₹15k with cost-preview toggle), #12 (Form 16→130 cutover — ship both, year-keyed switch), #15 (bank disbursement — bank-file at GA), #16 (maker-checker threshold — mandatory above headcount 25, tenant cannot disable below), #19 (launch-priority IN states — MH/KA/TN/GJ/WB full PT/LWF), #20 (pay-run perf SLO ratification).

---

### Phase 3 — NZ Payroll + Holidays Act

**Goal:** The flagship. Reuse the P2 engine *machine* and golden harness; add the NZ compliance module and the hardest single calculation in the product — the Holidays Act 2003 leave engine — proven three independent ways, plus the payday-filing pipeline.

**Scope (epics E3.6, E3.7, E3.8, E3.5-NZ, E3.9-NZ, E3.11-NZ, E2.3 compute):**
- **NZ compliance** (E3.6): PAYE (annualised periodic method, every bracket boundary, M/ME/S/SH/ST codes, secondary income, extra-pay/bonus method), KiwiSaver **3.5% from 1 Apr 2026** (rate pinned by `payDate`; opt-out window; savings suspension; 16–17yo now employer-contrib eligible; `KS_RATE_MISMATCH` warning), ESCT (tier by prior-year remuneration), ACC earners' levy **1.75% on first $156,641** ($2,741.22 max, YTD cap tracking), student loan (12% above $24,128), minimum-wage floor ($23.95, `MINWAGE_FLOOR` blocker; starting-out $19.16), deduction priority / net-pay protection.
- **Holidays Act compute engine** (E3.7, E2.3 compute) — the moat:
  - OWP/AWE **greater-of**; OWP s 8(2) formula `(a−b)/4` with correct `b` exclusion of irregular bonuses.
  - **Leave-in-weeks** (a 4-day-week employee taking "1 week" = 4 days at weeklyRate÷4, *not* 5 days); changing work pattern mid-year.
  - RDP vs **ADP** (when pay varies, ADP = gross52wk ÷ paid-days, denominator includes paid leave days).
  - The **OWD function** (`isOtherwiseWorkingDay`) — the single most unit-tested function in the codebase; gates four entitlements; returns confidence and flags low-confidence to HR for an audited decision.
  - Public-holiday matrix: OWD-worked (1.5× + alt day), OWD-not-worked (RDP paid day off), not-OWD-worked (1.5× only), not-OWD-not-worked (nothing); **mondayisation** (Christmas/Boxing/ANZAC Sat/Sun → observed Monday, never double).
  - Alternative/lieu days (taken = RDP for the day; cash-up = RDP; cap 1 week/entitlement year).
  - 8% PAYG (genuine fixed-term <12mo only; **forbidden for permanent staff — validation BLOCKER**).
  - Termination paths (pre-anniversary = 8% of gross − advances; post-anniversary = vested at greater-of-OWP/AWE + accrued at 8%, never mixed); closedown.
- **NZ payday-filing pipeline** (E3.8): EI dataset build (per-employee lines, field-by-field), submit (myIR file-upload v1, IRD gateway fast-follow), **≤2-working-day** deadline clock driven by the NZ working-day calendar, retry with backoff capped before deadline, escalation, reconcile cron (mirrors `processStripeWebhookRetries`), immutable `FilingReceipt` ledger.
- **NZ bank advice** (E3.5-NZ): direct-credit / IB4B / ABA batch; NZ PAYE rounds to cents.
- **Off-cycle / FnF / payslips** (E3.9-NZ, E3.11-NZ): NZ termination FnF, payslips with leave balances **in weeks**.

**Dependencies:** P2 (the entire engine machine, state machine, golden harness, compliance-regression pipeline, payslip generator). E2.3 model + E2.4 calendars from P1.

**QA gates (P3):**
- **NZ golden-dataset harness green to the cent** (`15` §3.3–3.4): ~200 scenarios, Holidays Act the bulk (the ~23 dedicated cases in `15` §3.4 covering OWP/AWE greater-of, weeks-not-days, every public-holiday quadrant, mondayisation, RDP-vs-ADP, alt-day taken/cash-up, 8% PAYG allowed/forbidden, both termination paths, OWD-confidence, closedown).
- **Three-way agreement on Holidays Act** (`15` §3.2): engine == independent oracle == hand-computed; divergence between any two **halts release**. The oracle is written by a *different engineer* from the engine author and reviewed line-by-line against the statute (authorship separation enforced, R12 mitigation).
- **OWD micro-golden** (`15` §3.6): 50+ rows across pattern/roster/history with confidence levels; `mondayise` for every 2026 public holiday × Sat/Sun fall; 100% branch coverage on OWD.
- **NZ statutory micro-golden:** `paye`, `esctTier`, ACC cap tracking, student-loan threshold — every bracket boundary ±$1.
- **Metamorphic (Holidays Act):** OWP/AWE order-independent of how earnings lines are entered.
- **Payday-filing pipeline integration** (`15` §5.1, §7): EI field-set contract test against IRD schema; 2-working-day window logic; sandbox submission smoke; reconcile converges SUBMITTED-without-ACK.
- **Cross-year pinning** (`15` §4.4): a run paying 28 Mar 2026 pins the old rule version, 4 Apr 2026 pins the new — the canonical rate-roll test.
- **Compliance-regression on the NZ 2026 rate roll** (`15` §4.5): KiwiSaver 3%→3.5%, ACC 1.67%→1.75%, min wage →$23.95 are the *only* declared deltas; any unexpected drift is a BLOCKER.

**Exit criteria:** NZ ~200-case golden harness green to the cent incl. the full Holidays Act suite; engine==oracle==hand-computed three-way agreement; payday-filing pipeline submits + reconciles within ≤2 working days; cross-year rule pinning proven.

**Founder-decision interlocks:** #13 (NZ payday-filing transport — myIR upload first, IRD gateway fast-follow), #14 (NZ FBT — report-only at GA). Legal sign-off on Holidays Act section citations is a **hard launch gate** for NZ (README §3).

---

### Phase 4 — Polish / Mobile / Reports / Integrations

**Goal:** Complete the employee surface and the last-mile integrations; harden to GA quality across accessibility, mobile, reporting, and external connectors.

**Scope (epics E4.x, E5.2, E8.1–E8.4, E1.4 e-sign):**
- **Mobile** (E5.2): React Native / Expo themed universal app — payslips, leave, **offline geo clock-in (idempotent)**, reimbursements, push, helpdesk.
- **Expenses & claims** (E4.1), **loans & advances** (E4.2, auto-EMI + net-pay floor), **assets** (E4.3), **helpdesk** (E4.4).
- **Analytics, reports & registers** (E4.5): mandatory digital wage/attendance registers, payroll registers, cost/headcount/attrition reports, statutory exports.
- **Accounting integrations** (E8.1): Xero (NZ), Tally/Zoho Books (IN) GL journal export.
- **Bank & govt transport depth** (E8.2): IRD payday-filing gateway (the fast-follow from P3), EPFO/ESIC/TRACES upload conformance harness.
- **SSO/SAML + public API + webhooks** (E8.3): Enterprise SSO with the white-label cookie-origin bridge (the Redis auth-code bridge across tenant custom domains — single point of failure, tested across all tenant domains); `ApiKey`/`WebhookSubscription`.
- **Biometric/device** (E8.4) attendance ingestion.
- **e-Sign** (E1.4): offer letters, policy acknowledgements.

**Dependencies:** P2/P3 (payslips, filings, payroll data to report on and integrate).

**QA gates (P4):**
- **WCAG 2.2 AA** automated (axe-core) on all four surfaces + manual screen-reader pass on ESS payslip (`15` §6.6) — a hard launch gate.
- **Offline clock-in idempotency** tests: a clock-in queued offline and replayed N times records once.
- **Integration contract + cassette tests** (`15` §7): Xero/Zoho/Tally GL shape, IRD gateway, bank templates, biometric device; nightly provider-sandbox drift alarm.
- **SSO/cookie-bridge** tested across every tenant custom domain (the SPOF).
- **Visual-regression matrix** stable (5 styles × colors × logo) including mobile.
- **Load/perf** (`15` §8): ESS payday spike (thousands opening payslips within minutes of PUBLISHED) — microcache hit-rate, p95 < 2000ms; 50k-employee run no memory leak.

**Exit criteria:** WCAG 2.2 AA on all surfaces; mobile + offline clock-in idempotency green; expenses/loans/assets/helpdesk live; accounting/bank/govt/SSO/webhook integrations contract-tested with nightly drift alarm.

**Founder-decision interlocks:** #15 (payout depth — gateway payout fast-follow), #17 (mobile — React Native themed universal app), #18 (launch-blocking accounting integrations — Xero + Tally/Zoho).

---

### Phase 5 — Talent / Recruitment / Performance / AI

**Goal:** The Growth/Enterprise upsell suite. Never blocks compliance; ships last.

**Scope (epics E6.1–E6.3):**
- **Recruitment / ATS** (E6.1): requisition → careers page → pipeline → offer → onboarding handoff. **The offer pre-flight shares the *exact* 50%-wage engine code** (not a copy) — a hard contract with `04`/`05`; any divergence produces non-compliant or non-payable comp (R2).
- **Performance & goals** (E6.2): goals/OKR → continuous feedback → review cycles → calibration → comp-revision linkage (feeds back into E1.3 effective-dated comp).
- **AI assists** (E6.3): bounded, audited — payslip-explainer NL generation, leave-policy Q&A, anomaly-summary for HR. **No autonomous payroll mutation**; every AI output is traceable and human-confirmed before any statutory or money effect. AI sits *beside* the deterministic engine, never inside the calc path.

**Dependencies:** P1 (comp model), P2 (the 50%-wage engine code for the offer pre-flight). Performance comp-linkage depends on P1's effective-dated revisions.

**QA gates (P5):**
- **Offer pre-flight shares engine code** (asserted by shared-module wiring, not a copy): an offer that violates Basic+DA ≥ 50% is blocked by the *same* `WAGES_50_RULE` the engine enforces (`15` cross-doc, R2 mitigation).
- **AI safety:** no AI path can mutate a `LOCKED`/`CLOSED` run or a statutory figure; every AI suggestion is audited; prompt-injection / data-leak tests on the AI surface (no cross-tenant context bleed).
- **Recruitment isolation:** candidate PII scoped per tenant; careers page white-label.
- Standard regression: all prior golden/compliance/isolation gates remain green (the set only grows, `15` §0).

**Exit criteria:** Recruitment req→offer→onboarding handoff live with the offer pre-flight sharing the exact 50%-wage engine code; performance goals→review→calibration→comp-link live; AI assists gated, audited, with no autonomous payroll mutation.

**Founder-decision interlocks:** #2 (channel/partner program for bureaus/CA firms reselling — relevant to recruitment white-label and GTM).

---

## 4. Hard launch gates (any market)

A market (IN or NZ) is GA-ready only when **all** of the following hold (consolidating `01` §10 + README §3):

1. The market's rule sets are **published ahead of effective dates** and golden-tested.
2. The market's **golden suite is green** (paise/cent), expecteds CODEOWNED by @qa + @compliance.
3. **Isolation tests green** (IDOR sweep, RLS `SET LOCAL`, custom-domain uniqueness, exactly-once `PayRun`).
4. **4-eyes enforced** on pay-run finalize + bank-detail edits above the headcount threshold.
5. A new tenant can **self-onboard to a passing dry-run payroll within trial**.
6. **Payroll idempotency** proven (re-run = identical output); **money invariants** hold (bank = Σnet = GL).
7. **Closed runs immutable**; corrections only via audited off-cycle.
8. **White-label ESS on a custom domain** with tenant-only branding; **no builder surface**.
9. **WCAG 2.2 AA**.
10. **Compliance rule change with no code deploy** demonstrated end-to-end.
11. **Breach runbook + on-call rotation live**; external pen-test passed.
12. **Legal sign-off** on Holidays Act section citations (NZ) and IN Labour-Code interpretation.

---

## 5. Multi-agent parallelization model

The build is large and the agentic workforce is the throughput lever. The governing principle: **fan out independent, schema-stable work; serialize anything that touches the calc core, the shared schema, or a correctness gate.** The golden-dataset and compliance-regression gates are the synchronization barriers that make parallel work safe.

### 5.1 What MUST be sequential (the critical path)

These are barriers — work downstream of them cannot start until they are green:

1. **P0 fork-and-strip → everything.** Until `turbo build` is green on the stripped graph, no parallel feature work can compile. One agent (or a tight pair) owns the strip; others wait. (R10.)
2. **The Prisma schema is a single shared artifact.** Schema changes serialize through one **schema-owner agent** with expand/contract discipline (`16` §6.2). Parallel agents *consume* the schema; they do not each mutate it. A migration merge is a barrier.
3. **`payroll-core` compute pipeline → all compliance modules.** The country-agnostic core (E3.1) and the pay-run state machine (E3.2) must stabilize before IN (E3.3) or NZ (E3.6) modules plug in. One agent owns the core contract.
4. **The independent oracle author ≠ the engine author.** For Holidays Act and §192/ESI, the oracle is deliberately written by a *different* agent, in isolation, against the statute — enforced authorship separation is a *correctness* requirement, not a convenience (R12). These two agents must **not** share intermediate reasoning.
5. **Golden expecteds are derived before the engine is trusted.** QA-role agents transcribe hand-computed expecteds from `05`/`06` worked examples *independently* of the engineering agents; the harness asserts agreement. Expected files are CODEOWNED — an engineering agent cannot edit them.
6. **Rule-version publish → dependent golden runs.** A new rule version must pass compliance regression before downstream golden suites pin it.

### 5.2 What CAN fan out (parallel workstreams)

Once the schema and core contracts are stable, these run concurrently as independent agent swarms with clear interface contracts:

| Parallel swarm | Owns | Safe to parallelize because |
|---|---|---|
| **Substrate-hardening swarm** (P0/P1) | router rewire, auth/RBAC catalogue, billing trim, theme slim, feature flags | each touches a distinct reused subsystem; integration is the `turbo build` barrier |
| **Core-HR swarm** (P1) | org, employee master, lifecycle, document vault, bulk I/O | distinct model clusters behind the schema contract |
| **Time swarm** (P1) | leave ledger, attendance, scheduling, holiday calendars | feeds payroll via the frozen `AttendancePayInput` *contract*, not shared code |
| **IN-compliance swarm** (P2) | income tax, EPF/EPS, ESI, PT, gratuity, file generators | each statutory component is an isolated pure function behind the engine's component interface |
| **NZ-compliance swarm** (P3) | PAYE, KiwiSaver/ESCT, ACC, student loan, payday filing | same isolation; Holidays Act is its own sub-swarm (engine vs oracle separated) |
| **QA/golden swarm** (P2–P3) | golden datasets, oracle, property tests, contract tests | deliberately independent of engineering swarms (the whole point) |
| **Surface swarm** (P1/P4) | ESS shell, hr-admin panels, mobile | UI behind the API contract; visual-regression is the barrier |
| **Integrations swarm** (P4) | Xero/Zoho/Tally, bank templates, IRD gateway, SSO, webhooks | each connector is contract-tested in isolation (Pact + cassettes) |
| **DevOps swarm** (P0→all) | CI gates, ECR, region split, migration scanner, deploy interlock | infra-as-code, parallel to feature work |
| **Talent swarm** (P5) | recruitment, performance, AI | downstream; only the offer pre-flight has a hard upstream contract (50%-wage code) |

### 5.3 The fan-out/fan-in cadence

- **Fan-out:** a phase's independent epics are dispatched to parallel agents the moment the phase's prerequisite barrier (schema + core contract) is green.
- **Fan-in:** every epic's merge runs the relevant CI gate (`16` §3.4). Payroll/compliance merges additionally run the golden + compliance-regression gates (`15` §3.9, §4). A red gate blocks the merge — the gate *is* the fan-in synchronization.
- **Noisy investigation is delegated, findings come back terse:** broad grep/log/source-mining sweeps (e.g. dangling-import sweeps in P0, schema-shape mining from the verticals) run as subagents that return only the findings, keeping the main thread on the build.

---

## 6. Risk register

Consolidated from README §6 with delivery-specific mitigations and phase ownership. Ordered by severity × likelihood.

| # | Risk | Impact | Mitigation | Owned in |
|---|---|---|---|---|
| **R1** | **NZ Holidays Act mis-calculation** (OWP/AWE, RDP/ADP, OWD, weeks-not-days). Industry-wide failure with billions in remediation. | Legal/back-pay liability; destroys flagship claim; lead churn event. | Pure-compute engine; ~23 dedicated golden cases + property/metamorphic with **triple-derived expecteds**; **independent oracle by a different agent**; legal review of section citations before GA. | P3 |
| **R2** | **IN 50%-wage cascade** into PF/gratuity/ESI under uniform wages (live 21 Nov 2025). | Employer penalties; non-payable comp if offer engine diverges. | `WAGES_50_RULE` blocking anomaly + dedicated trace node; **offer pre-flight shares the exact engine code** (not a copy); golden tests across edge comp structures. | P1 (primitive), P2 (engine), P5 (offer) |
| **R3** | **Tenant-isolation breach across `businessId`.** Payroll is the most sensitive HR data; reused isolation must be re-hardened, not assumed. | Catastrophic cross-tenant leak; existential. | Three-layer isolation (server-derived id → mandatory Prisma `$extends` → FORCE RLS with `SET LOCAL`); CI IDOR + property tests; custom-domain uniqueness index; exactly-once `PayRun`. **All NEW work, front-loaded.** | P0/P1 |
| **R4** | **Regulatory drift on fixed effective dates** (1 Apr 2026; pending ESI ₹30k ceiling, PF ₹15k→₹21k/25k SC directive). | Tenants compute wrong pay if rule sets lag. | Versioned effective-dated rule tables resolved as-of period-end (never `Date.now()`); 4-eyes publish + dry-run preview; **rule-set publish lead time is an operational SLA**; compliance-regression blocks undeclared deltas; **Feb rate-roll rehearsal**. | P1 (console), P2/P3 (seeds), ongoing |
| **R5** | **Money correctness under concurrency & edge cases** (YTD lost-update race; arrears/mid-year regime switch; `payDate` mutation invalidating the rule-version pin across an FY boundary). | Wrong tax/contribution; employee year-end shortfalls. | Per-employee `YtdLedger FOR UPDATE` + `ytdVersion` revalidation (`YTD_DRIFT`); block `payDate` mutation post-lock (`PAYDATE_PIN_STALE`); arrear recompute uses source-period's pinned version; **DB-unique exactly-once**; immutable closed runs; bank=Σnet=GL invariant. | P2 |
| **R6** | **Form renumbering cutover** (16→130, 24Q→138, TY 2026-27). Issuing "Form 16" for post-1-Apr-2026 income is non-compliant. | Wrong-named statutory certificates. | Engine is form-id-agnostic; **year-keyed template switch** owned by `05`; correct distinct-form mapping propagated to 04/09/11/12/15/16/18; legal source lock once forms publish. | P2 |
| **R7** | **Data residency** (IN DPDP / NZ Privacy Act). Single-region fork cannot transparently region-switch. | CERT-In/RBI localisation unmet; ₹250 cr DPDP max penalty. | **Deploy-per-region fleets**; **pin `region` column day one** (split is config, not migration); region-pinned connectors/exports/object-store; DR snapshots stay in-region. **Founder must confirm regions in P0.** | P0 (schema), P4 (DR drills) |
| **R8** | **Govt filing reliability & format drift** (IRD payday 2 working days; EPFO/ESIC/TRACES file-upload; per-bank specs; schema versions). | Missed-deadline penalties; broken filings. | Versioned file templates as data + format-version stamping; FVU validation gate; **golden-file regression + nightly sandbox contract tests**; retry/reconcile + early-escalation alerting; on-call rotation owned. | P2 (IN), P3 (NZ), P4 (depth) |
| **R9** | **Sensitive PII concentration** (Aadhaar/PAN/UAN/IRD/bank/visa/biometric/selfie/sick-reasons). | DPDP/Privacy exposure; CERT-In 6h breach clock. | KMS-backed per-tenant envelope encryption decoupled from `JWT_SECRET` (crypto-shred); masking-at-rest; consent-gated sensitive fields off-by-default; `VIEW_SENSITIVE` audit; time-boxed support grants; breach runbook + tabletop drills. **Avoid full Aadhaar.** | P1 (encryption), ongoing |
| **R10** | **Fork excision fallout** (deleting verticals/builder/themes; slimming theme-engine 10→5). `vertical` threads through theme-engine/admin-core/`requireVertical`/`requireEcomPermission`. | Dangling `@sitepresso/*` imports stall P0; broken feature-gating contracts. | 4-phase fork-and-strip runbook; **sweep until `turbo build` type-checks**; keep `vertical` column constrained to `'HR'` (cheaper than excising); verify no shared path depends on removed styles before deletion. | P0 |
| **R11** | **Scope creep** toward full-suite HCM or a "builder," diluting the wedge. | Loses differentiator; weakens correctness focus. | Ten explicit non-goals defended; "configure, not build" enforced by tests (no-builder negative test); deliberate v1 boundaries (report-only FBT, bank-file disbursement, upload-before-gateway). | All phases |
| **R12** | **Golden-dataset / oracle decay.** ~420 dual-derived expecteds expensive to maintain across annual rate rolls; oracle can drift toward sharing engine assumptions (circular agreement). | The correctness gate silently loses value. | Incident→golden loop; **Feb rate-roll rehearsal**; **enforced authorship separation** between engine and oracle agents; periodic independence audit; compliance officer co-signs expecteds + rule-version publish. **Staffing must be real.** | P2/P3, ongoing |
| **R13** *(delivery-specific)* | **Pre-domain phase blocks live promotion.** Until prod domains are registered/DNS-delegated, `staging`/`main` have no live target; over-investing in deploy before then is wasted. | Schedule risk; false sense of "shippable". | Work lands on `development`; "staging" = ephemeral preview from a `development` SHA on `*.preview.internal` via Cloudflare Tunnel (`16` §1.1); one-time bootstrap (`16` §10.1) the instant domains arrive. **Founder must provide domains before any GA.** | P0→GA |
| **R14** *(delivery-specific)* | **Founder-decision latency.** 20 open decisions (README §4); several block schema/topology (regions, identity, multi-entity, KMS). | Phases stall waiting on calls. | Each decision is interlocked to the earliest phase that needs it (§3 above); defaults/recommendations exist for all; **escalate the four P0-blocking decisions (#4, #5, #6, #7) first**. | P0/P1 |

---

## 7. Sprint 0 — concrete, ordered fork-and-scaffold task list

This is the immediately-actionable runbook to begin the fork. Commands are illustrative; **never run against `/Users/kp/sitepresso`** (READ-ONLY). All paths are real and verified in-repo (2026-06-22). Ordered so each step unblocks the next; the `turbo build` barrier (step 14) ends Sprint 0.

> **Pre-flight (founder, parallel to S0-1):** resolve the four P0-blocking decisions — #4 multi-entity, #5 `Employee` model (recommend new), #6 regions (`ap-south-1`/`ap-southeast-2`), #7 KMS (recommend AWS KMS). These shape the schema and topology committed below.

**S0-1 — Fork & baseline the monorepo.**
- `git clone` Sitepresso into a fresh repo `hr-platform` with a new remote; keep `turbo.json`, `.nvmrc`, `.github/`, CI workflow files.
- Rename npm scope `@sitepresso/*` → `@hr/*` across all `packages/*/package.json` and every import (`packages/{ui,admin-core,theme-engine,types}`).
- Re-point env: `PLATFORM_DOMAIN=hr.com`, `NEXT_PUBLIC_PLATFORM_DOMAIN=hr.com`.

**S0-2 — Mine the verticals before deletion** (`17` §5; do this *before* any `rm`).
- Copy schema *shapes* (not controllers) into `03-data-model.md`'s HR models:
  - From booking: `StaffSchedule`→`WorkSchedule`, `StaffLeave`→`LeaveRequest`, `BusinessHours`→per-location work hours, `BusinessHoliday`→`PublicHolidayCalendar` (load-bearing for NZ Holidays Act).
  - From shop: `EcomRolePermissionGrant`→`HrRolePermissionGrant(roleId,permissionKey,scopeType,scopeId)`, `BusinessLocation`→HR work locations.
- Source: `backend/prisma/schema.prisma` models `StaffLeave`, `BusinessHoliday`, `StaffSchedule`, `BusinessHours`, `EcomRolePermissionGrant`, `BusinessLocation`, `StoreBrand`.

**S0-3 — Delete the verticals & dead code** (`17` §10 Phase 1).
- `rm -rf apps/{web,shop,booking,chat-*,aapkarider-*}` (keep `apps/qa-portal` shell as the QA console — see §3 P0 note).
- `rm -rf backend/src/{web,shop,booking,chat}` (keep `backend/src/qa` only if QA-portal needs it; else remove).
- `rm -rf packages/{blog-ui,ecom-ui,chat-*,aapkarider-shared}`.
- Delete `apps/platform/app/{website-builder,blog,answers}` (page/SEO/builder surfaces — core-principle violation).
- Delete vertical `core/lib` files (`17` §2.5 DELETE rows): `cart.js`, `productPricing.js`, `orderReconcile.js`, `ecom*`, `whatsappCatalog.js`, `aapka*`, `intakeForms.js`, `pageTemplates.js`, `seoHelpers.js`, `categoryTheme.js`, `starterCatalog.js`, `mailboxProvisioning.js`, and buyer-side billing (`backend/src/core/lib/billing/buyerGateways/`, `stripeConnect.js`, `tenantPaymentReadiness.js`).
- Drop the 60+ profession theme registry: `packages/theme-engine/profession-styles.mjs`, `profession-registry.mjs`, `profession-registry.test.mjs`, and profession entries in `backend/src/core/generated/themeManifest.json`.

**S0-4 — Import sweep until clean.**
- `rg "@sitepresso/(shop|booking|web|chat|blog-ui|ecom-ui)"` and `rg "require\('.*\/(shop|booking|web|chat)\/"` across the surviving graph; fix every dangling import.
- Repeat until `rg` returns zero hits in surviving code. (R10 mitigation.)

**S0-5 — Rewire the router** (`apps/router/index.js`, `cloudflare-worker.js`, `wrangler.toml`).
- Replace the per-vertical port table (`PUBLIC_PORTS`/`SUB_APP_PORTS`) with: `PLATFORM_PORT=3000` (hr.com + admin.hr.com + onboarding), `HR_ADMIN_PORT=3010` (app.hr.com), `ESS_PORT=3020` (tenant.com / *.hr.com).
- Replace the routing tree with the 4-surface decision (`17` §3.2): `admin.hr.com`→platform/`/superadmin`, `app.hr.com`→hr-admin/`/dashboard`, `hr.com`→marketing+signup+onboarding, `<slug>.hr.com` OR bound custom domain→ESS.
- Add `hr` to the reserved-subdomain set (`www,api,admin,app,mail,platform,m,test,hr`).
- **Re-enable custom-domain lookup** in `resolveTenantBusinessId` to consult `routableCustomDomainWhere` (retired 2026-05-10; un-retire it) — source: `backend/src/core/lib/customDomainRouting.js`, `backend/src/domains/`.

**S0-6 — Adapt auth & RBAC** (`backend/src/core/middleware/auth.middleware.js`, `backend/src/core/lib/rbac.js`).
- Keep verbatim: `tokenPredatesPasswordChange`, access/refresh split, customer cross-tenant guard (`tenantBusinessId !== customer.businessId → 403`), `requirePermission`.
- Strip vertical auto-role provisioning (`ensureDefaultEcomStaffRole`, `ensureAppointmentSystemRole`, `ensureDefaultAppointmentStaffRole`); add `ensureDefaultHrRole` seeding Owner/HR-Admin/Finance/Manager/Employee.
- Replace `rbac.js` `PERMISSIONS` catalogue + `SYSTEM_ROLES` presets with the HR set (`17` §2.2): `canViewEmployees`, `canManageEmployees`, `canViewCompensation`, `canManageCompensation`, `canApproveLeave`, `canManageAttendance`, `canRunPayroll`, `canApprovePayroll`, `canViewPayrollReports`, `canManageStatutory`, `canFileReturns`, `canManageOrg`, `canEditBilling`, `canEditDomain`, `canEditBranding`.

**S0-7 — Trim billing to the SaaS half** (`backend/src/core/lib/billing/gatewayRouter.js`).
- Keep `resolveGateway`/`resolveBilling`/`resolveGatewayForChange`; confirm `COUNTRY_GATEWAY.IN=RAZORPAY/INR`, `NZ=STRIPE/NZD`, default→PADDLE survive (lines 29–38 — they already do).
- Remove buyer-side routing (`resolveTenantPaymentGateway`, Stripe Connect / Razorpay Route) and the `BusinessPaymentAccount` model.
- Keep `AdminCoupon`/`AdminCouponRedemption` (promo), `PricingTier`/`PricingZone`/`CountryZoneAssignment`/`TierPrice`/`TierFeature`, webhook-ledger models (`RazorpayWebhookEvent`/`StripeWebhookEvent`/`PaddleWebhookEvent`).

**S0-8 — Re-seed plans & features.**
- Re-seed `PricingTier`/`TierFeature` (`schema.prisma:2645,2757`) as the 4 HR tiers (Starter/Payroll/Growth/Enterprise) with `vertical='HR'` and the `01` §9 indicative price points.
- Replace `featuresCatalog.js` entries with the HR feature keys (`17` §6.4); keep the resolution rule `effective = rollout && tierDefault && (businessFlag !== false)`; make `statutoryIN`/`statutoryNZ` country-conditioned.

**S0-9 — Slim the theme engine** (`packages/theme-engine/index.js`).
- Keep `normalizeThemeConfig`, `composeTheme`, `createThemeRegistry`, `validateThemeContract`, `resolveThemeSlots`, `buildThemeManifest`.
- Reduce to a 5-entry registry (`slate`, `indigo`, `emerald`, `rose`, `mono`); collapse `VERTICAL_ALIASES` to single `HR`.
- Rename `StoreBrand`→`TenantBrand` (`logoUrl`, `primaryColor`, `styleKey`, `customDomain`).

**S0-10 — Adapt the tenant model** (`backend/prisma/schema.prisma` model `Business`).
- Keep `id`, `slug @unique`, `shortId @unique`, `country`, `timezone`, `vertical` (constrain to `'HR'`), `isActive`, `featureFlags Json?`, `subscription`, `defaultLanguage`, GDPR soft-delete fields.
- Add HR fields (`03`): `legalName`, `taxIdentifiers Json` (PAN/TAN/GSTIN/PF/ESIC for IN; IRD/ACC for NZ), `payCalendarConfig`, `taxYearStart` (Apr), `statutoryProfile` FK, **`region`** (pinned day one for residency — R7).
- Add the **custom-domain partial unique index** on the tenant domain (NEW control, README §5.2).

**S0-11 — Scaffold the new apps** (from existing shells).
- `apps/hr-admin` ← fork `apps/platform/app/(unified-admin)` shell (sidebar nav, `admin-ui.js`, `admin-pickers.js`, `NotificationInboxPanel.js`, `TrialBanner.js`); drive nav with `admin-core` panel registry.
- `apps/ess` ← fork the customer sub-app shell + customer JWT session (white-label theming, login, notification inbox, `assetPrefix` routing).
- `apps/hr-mobile` ← new React Native / Expo scaffold (reuse customer-auth + notification packages only).
- Keep `apps/platform` for marketing + onboarding + super-admin; fork the onboarding wizard shell (`apps/platform/app/onboarding`) for the company-setup wizard (new steps).

**S0-12 — Stand up the HR backend skeleton.**
- Create `backend/src/hr/**` with empty module folders matching the epic map: `org/`, `employees/`, `attendance/`, `leave/`, `payroll/`, `compliance-in/`, `compliance-nz/`, `filing/`, `documents/`, `talent/`, `payout/`.
- Create pure-compute packages: `packages/payroll-core/`, `packages/compliance-in/`, `packages/compliance-nz/` (I/O-free, BigInt minor-unit money).

**S0-13 — Wire the DevOps substrate** (`16`).
- Re-enable GitHub Actions CI as a **gate-not-deployer** (reuse `node --check` syntax sweep, `check-admin-architecture.js`, `prisma validate`; add `migration-check` shadow-apply + drift + destructive-change scanner; add `compliance-golden` job stub).
- Provision ECR repos (reuse `scripts/setup-ecr.sh`); keep `scripts/{ship.sh,deploy.sh,smoke.sh,watchdog.sh}` patterns; plan the region-split data planes.
- Establish the branch discipline (`development` only until domains; `staging`/`main` as ephemeral-preview targets) — `16` §1.

**S0-14 — The Sprint 0 exit barrier.**
- `turbo build` type-checks the surviving graph (zero dangling imports).
- Isolation property test green (customer session cross-tenant 403).
- Billing routing test green (IN→Razorpay/INR, NZ→Stripe/NZD, AU→Paddle/AUD).
- Custom-domain binding re-verified live on a test domain.
- CI pipeline green. **→ This is the P0 exit; P1 fan-out begins.**

---

## 8. Program governance

### 8.1 Cadence & ceremonies
- **Phase as the planning unit; weekly demo + golden-coverage review.** Each phase opens with a fan-out planning session (dispatch parallel epics) and closes on its QA gate. No phase closes on a date — it closes on green.
- **Feb rate-roll rehearsal** is a fixed annual ceremony (`15` §4.4): author next-year rule versions, run compliance regression, cut a cross-year run, compliance-officer signs the "ready for 1 April" checklist.
- **Incident→golden loop:** every production payroll/compliance incident becomes a permanent golden scenario tagged with the incident id, *before* the fix merges (`15` §0, §12). The golden set only grows.

### 8.2 RACI (condensed)
| Function | Owns |
|---|---|
| Delivery Lead / PM | phase sequencing, fan-out/fan-in, founder-decision interlock tracking, this doc |
| Lead Architect | schema ownership, core contracts, expand/contract discipline, region split |
| Payroll Eng Lead | `payroll-core` + state machine + IN/NZ modules (engine half) |
| QA Lead | golden datasets, compliance regression, CI gates; **CODEOWNER of expecteds** |
| Compliance Officer | rule-version sign-off, legal citations, oracle review; **co-CODEOWNER of expecteds + rule seeds** |
| SRE/DevOps | CI/ECR/region planes, deploy↔payroll interlock, DR drills, on-call |
| Security Lead | three-layer isolation, envelope encryption, pen-test, breach runbook |

### 8.3 Definition of Done (per epic)
An epic is done when: code merged on `development` behind a feature flag; unit ≥ threshold (100% on calc core, ≥85% other HR backend, ≥70% frontends); relevant golden/compliance/isolation gates green; effective-dated where applicable; audit-logged where it touches money/PII; docs cross-refs reconciled (the canonical 00–18 naming, no broken links — README §5.1).

### 8.4 Definition of Done (per release / market GA)
The 12 hard launch gates in §4, plus: all CI green on `main`; perf within budget; no open critical/high security issue; compliance-officer sign-off recorded; full E2E matrix green; rate-roll rehearsal done if a tax-year boundary is near (`15` §11.5).

---

*Prepared by the Senior Delivery Lead / Program Manager. All compliance figures effective-dated and web-verified 2026-06-22; all Sitepresso reuse claims cite real, read-only-verified paths (`apps/router`, `backend/src/core/{middleware/auth.middleware.js,lib/rbac.js,lib/billing/gatewayRouter.js,lib/featuresCatalog.js}`, `packages/{admin-core,theme-engine,ui}`, `backend/prisma/schema.prisma`, `scripts/{ship.sh,deploy.sh,smoke.sh,setup-ecr.sh,watchdog.sh}`, `ecosystem.config.js`, `turbo.json`). This doc consolidates and supersedes the inline phasing in README §3.*

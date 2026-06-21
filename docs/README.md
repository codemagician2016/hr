# HRMS & Payroll SaaS — Master Plan Index & Executive Summary

**Multi-tenant, white-label HRMS & Payroll SaaS for India (IN) and New Zealand (NZ).**
Forked from the production platform **Sitepresso** (`/Users/kp/sitepresso`, read-only).

| | |
|---|---|
| **Status** | Planning suite complete (19 docs, 00–18) + 6 adversarial reviews applied. Pre-build. |
| **Markets at launch** | India (INR, Razorpay), New Zealand (NZD, Stripe); RoW HRIS-only via Paddle later. |
| **Tax year** | Apr–Mar in **both** jurisdictions. |
| **Compliance baseline** | IN Labour Codes live **21 Nov 2025**; NZ changes live **1 Apr 2026**. All figures effective-dated and web-verified on **2026-06-22**. |
| **Core principle** | "Pre-built system you **configure**, not a builder." No page/form/layout builder. Branding = logo + 1 brand color + 1-of-5 fixed styles + 1 bound custom domain. |
| **Flagship moat** | Provably-correct **NZ Holidays Act 2003** leave engine + versioned, golden-tested **IN/NZ compliance rule tables**. |

This README is the canonical entry point. Every doc below is production-grade, effective-dated, and grounded in real Sitepresso file paths. The reviews in `reviews/` were applied **in place** to docs 02, 03, 04, 05, 06, 14.

---

## 1. Document Index

All paths are under `/Users/kp/hr/docs/`.

| # | Doc | One-line purpose |
|---|---|---|
| 00 | [`00-vision-and-principles.md`](./00-vision-and-principles.md) | Thesis, market timing, four surfaces/personas, JTBD, positioning, eight product principles, ten non-goals, north-star metric. |
| 01 | [`01-product-requirements.md`](./01-product-requirements.md) | Spine PRD: all 21 modules across four surfaces, tenancy/isolation model, packaging (4 tiers + Enterprise), per-seat pricing, launch gates. |
| 02 | [`02-system-architecture.md`](./02-system-architecture.md) | Turborepo layout, host routing, tenant resolution, custom-domain+SSL state machine, `businessId` isolation, BullMQ payroll/filing tier, versioned rule tables. *(reviewed)* |
| 03 | [`03-data-model.md`](./03-data-model.md) | 74 Prisma models / 79+ enums: org, employee, compensation, pay run, statutory profiles, leave ledger, attendance, FNF/Separation, audit. Effective-dated, Decimal money. *(reviewed)* |
| 04 | [`04-payroll-engine-design.md`](./04-payroll-engine-design.md) | Country-agnostic compute core + pluggable `ComplianceModule`, guarded pay-run state machine, idempotency/YTD-concurrency, `calc_explain` trace, output generators. *(reviewed)* |
| 05 | [`05-compliance-india.md`](./05-compliance-india.md) | CA-level IN spec: income tax (new/old regime, §87A + marginal relief), TDS, EPF/EPS/EDLI, ESI, PT per state, gratuity, bonus, LWF, 50%-wage rule, deadline/penalty matrix. *(reviewed)* |
| 06 | [`06-compliance-newzealand.md`](./06-compliance-newzealand.md) | NZ spec: PAYE, payday filing, KiwiSaver/ESCT, ACC levy, student loan, minimum wage, and the deep **Holidays Act 2003** OWP/AWE/RDP/ADP engine. *(reviewed)* |
| 07 | [`07-modules-core-hr.md`](./07-modules-core-hr.md) | Core HR system-of-record: multi-legal-entity org, effective-dated employee master, lifecycle state machine, document vault, NZ visa loop, bulk I/O. |
| 08 | [`08-modules-time.md`](./08-modules-time.md) | Time & Attendance: leave (IN day-based / NZ week-based), append-only LeaveLedger, multi-channel clock-in, shifts/rosters, OT, frozen attendance→payroll feed. |
| 09 | [`09-modules-pay-adjacent.md`](./09-modules-pay-adjacent.md) | Expenses/reimbursements, loans/advances (auto-EMI + net-pay floor), payslip design (frozen snapshot, white-label, tamper hash), IT-asset lifecycle. |
| 10 | [`10-modules-talent.md`](./10-modules-talent.md) | Recruitment/ATS (requisition→careers→pipeline→offer→onboarding handoff) and Performance (goals/OKR→feedback→reviews→calibration→comp linkage). |
| 11 | [`11-ess-and-mobile.md`](./11-ess-and-mobile.md) | White-labeled Employee Self-Service portal + iOS/Android/PWA: payslips, tax docs, declarations, leave, offline geo clock-in, reimbursements, helpdesk. |
| 12 | [`12-admin-consoles.md`](./12-admin-consoles.md) | Super Admin (tenants, pricing, promo, feature flags, billing/dunning, **versioned compliance rules console** w/ 4-eyes) + Tenant Admin HR console. |
| 13 | [`13-ux-ia-designsystem.md`](./13-ux-ia-designsystem.md) | IA/site maps for all four surfaces, the 5 fixed styles as one token contract, white-label injection, four end-to-end flows, WCAG 2.2 AA launch gate. |
| 14 | [`14-security-privacy.md`](./14-security-privacy.md) | Dual-scope JWT + MFA/step-up, six-role RBAC + SoD, three-layer tenant isolation, per-tenant envelope encryption, audit hash-chain, DPDP/NZ Privacy Act, breach runbook. *(reviewed)* |
| 15 | [`15-qa-test-strategy.md`](./15-qa-test-strategy.md) | Payroll **golden-dataset harness** (~420 IN/NZ scenarios, triple-derived expecteds), compliance-regression pipeline, test pyramid, isolation security tests, CI gates. |
| 16 | [`16-devops-delivery.md`](./16-devops-delivery.md) | Git-as-ledger + manual deploy, containerized immutable artifacts, CI compliance gates, expand/contract migrations, deploy↔payroll interlock, DR drills, region split. |
| 17 | [`17-reuse-map.md`](./17-reuse-map.md) | REUSE / ADAPT / DELETE / BUILD-NEW map: Sitepresso substrate (~70% reuse) vs HR vertical (~5%, schema-mining only); 4-phase fork-and-strip runbook. |
| 18 | [`18-integrations.md`](./18-integrations.md) | Five-mode connector taxonomy: accounting (Xero/Zoho/Tally), bank files, govt filing (IRD API vs IN file-upload), biometric, SSO, notifications, webhooks/public API. |
| — | [`reviews/`](./reviews/) | Six adversarial review notes (architecture, data-model, payroll, india, nz, security). Findings applied in place to the target docs. |
| — | **§7 below** | **Delivery / phasing plan** (no standalone doc yet — phasing lives inline in each module doc and is consolidated here). |

---

## 2. Executive Summary (~1 page)

**What we are building.** The only HRMS+Payroll SaaS that is simultaneously (a) **white-label** down to the tenant's own bound custom domain, (b) **natively and provably compliant for both India and New Zealand**, and (c) a **pre-built system you configure, not a builder**. Tenants configure data + settings + plan feature flags and *use*; they never design layouts. We sell into a 2025–26 demand event: India's new Labour Codes (live 21 Nov 2025, with the Basic+DA ≥ 50% "wages" rule cascading into PF and gratuity) and New Zealand's 1 Apr 2026 changes (KiwiSaver 3.5%, ACC 1.75%, minimum wage \$23.95, payday filing within two working days). Incumbents are single-country: IN (Keka/greytHR/Darwinbox/Zoho) and NZ (Employment Hero/PayHero/Smartly/Xero). Nobody owns both with provable correctness — that is the wedge.

**How it is built.** We fork **Sitepresso**, which already solves the entire SaaS substrate we do *not* want to rebuild: dual operator/employee JWT auth with row-level `businessId` tenant isolation, a country-routed multi-gateway billing engine that *already hardcodes IN→Razorpay/INR and NZ→Stripe/NZD*, per-seat subscriptions, JSON-permission RBAC, feature-flag/plan gating, the admin-core panel shell, theme-engine, notifications, i18n, and Cloudflare-for-SaaS custom domains + SSL. We **delete** the website/page builder and the `web`/`shop`/`booking`/`chat` verticals, slim theming to 5 fixed styles, and **build new** only the HR vertical: org + employee master + compensation + the payroll engine + IN/NZ compliance modules + time/leave + talent + ESS + mobile. Net reuse: ~70% of plumbing, ~5% of the HR domain (schema-shape mining only).

**The architecture in one breath.** Four host surfaces (`hr.com` marketing/onboarding, `admin.hr.com` super-admin, `app.hr.com` tenant HR console, `tenant.com`/`tenant.hr.com` white-label ESS) resolve via a Host-header Cloudflare worker + node router. Payroll calculation lives in **deterministic, I/O-free packages** (`payroll-core` + `compliance-in`/`compliance-nz`) driven by **versioned, Super-Admin-owned compliance rule tables** — a pay run pins its rule-set version so any past run reproduces exactly. Money is integer minor-units / `bigint` (a deliberate divergence from Sitepresso's 32-bit `Int`, which overflows YTD/filing aggregates). Pay runs and statutory filings execute on a **new BullMQ tier** (Sitepresso had no queue) behind an idempotent, resumable `PayRun` state machine with DB-unique exactly-once guards. IN and NZ are split onto region-local data planes for residency.

**Why it is defensible.** The **NZ Holidays Act 2003** engine (OWP/AWE greater-of, RDP vs ADP, the otherwise-working-day test, alternative/lieu days, leave-in-weeks) is the single hardest, highest-liability calculation in NZ payroll — multi-million-dollar remediations are an industry norm — and provable correctness here is the flagship moat. Correctness is enforced by a **golden-dataset harness** (~420 IN/NZ scenarios with expecteds derived three independent ways) that gates every payroll merge on a paise/cent diff, plus a compliance-regression pipeline that blocks any rule-version publish with an undeclared delta.

**Status & risk posture.** All 19 docs are written, exhaustive, and cross-referenced; six were adversarially reviewed and corrected. The dominant risks are *correctness* (a wrong IN PF/gratuity or NZ Holidays Act figure causes employer penalties/back-pay and is the leading churn/reputation threat) and *isolation* (payroll is the most sensitive HR data; the reused isolation must be re-hardened, not assumed). The plan's mitigations — versioned rule tables, golden tests, three-layer isolation, effective-dated everything — are designed precisely around these. The remaining blockers are founder decisions (pricing, residency regions, identity model, filing-transport depth) listed in §4.

---

## 3. Delivery / Phasing Plan (consolidated)

There is no standalone delivery doc; phasing is specified per-module and consolidated here. Phases are gated on correctness, not calendar.

| Phase | Theme | Scope (must-ship) | Gate to exit |
|---|---|---|---|
| **P0 — Fork & strip** | Substrate | Fork Sitepresso; delete web/shop/booking/chat verticals + builder + profession themes; slim theme-engine to 5 styles; sweep dangling `@sitepresso/*` imports until `turbo build` type-checks; add `HR` to `Business.vertical`. Re-audit tenant isolation. | `turbo build` green; isolation property tests pass; custom-domain re-enable verified. |
| **P1 — Foundations** | Data + auth + rules | Data model (03) migrations w/ FK discipline + RLS; new Prisma scoping extension at the singleton; compliance rule-tables console (12) with 4-eyes publish; super-admin tenant lifecycle + billing reuse. | Isolation CI gates; rule-version publish dry-run; seed IN/NZ 2026 rule sets. |
| **P2 — Core HR + Time** | System of record | Org/entity (07), employee master + lifecycle, document vault, leave + attendance (08) with frozen `AttendancePayInput`, NZ Holidays Act leave engine. | Holidays Act golden suite green; effective-dating property tests. |
| **P3 — Payroll engine** | The money path | Payroll core (04) + IN module (05) + NZ module (06); pay-run state machine, idempotency/YTD concurrency, payslips (09), bank-advice + statutory file generators (calculate-and-file-first). | ~420-case golden harness at paise/cent; compliance-regression pipeline live; 4-eyes pay-run approval. |
| **P4 — ESS + Mobile + Talent** | Employee surface | White-label ESS (11), mobile clients, expenses/loans/assets (09), recruitment + performance (10). | WCAG 2.2 AA; offline clock-in idempotency tests. |
| **P5 — Integrations + GA hardening** | Last mile | Accounting (Xero/Zoho/Tally), bank file formats, NZ IRD payday-filing transport, biometric, SSO, webhooks (18); DR drills, observability SLOs tied to filing deadlines (16); security/pen-test. | Filing deadline alerting live; external pen-test; legal sign-off on each rule set. |

**Hard launch gates (any market):** rule sets published *ahead* of effective dates; golden suite green; isolation tests green; 4-eyes on pay-run finalize + bank-detail edits; breach runbook + on-call rotation live; legal sign-off on Holidays Act citations and IN Labour-Code interpretation.

---

## 4. Open Decisions for the Founder

These need a founder call before or during the phases noted. Defaults/recommendations from the docs are given; "→" marks the recommendation.

**Pricing & GTM**
1. **Exact per-seat tiers and price points** in INR (Razorpay) and NZD (Stripe), plan boundaries, and per-seat/per-branch overage amounts — only placeholders exist (01, 12, 17). Confirm the dispute-proof **billable-seat definition** ("active employee in a finalized run this month"). *Blocks billing config.*
2. **Channel/partner program** terms (revenue share/margin for bureaus, CA firms, franchisors reselling under their brand) — define before GTM (00).
3. **Branding styles per tier** — all 5 styles on every plan, or gate Starter/Growth lower? → all 5 (cheap differentiation) (12, 13).

**Tenancy & identity**
4. **Multi-entity / multi-country per tenant**: one `Business` may hold IN + NZ entities under one plan vs one tenant per country. → multi-entity per tenant; resolve seat-counting impact (01-O1, 03-O1, 17).
5. **Employee identity model**: new `Employee` model reusing only auth columns vs extend Sitepresso `Customer`. → **new `Employee` model** (avoid dragging storefront/marketing fields) (01-O2, 17).

**Data residency & hosting**
6. **Cloud provider + regions per residency zone** (e.g. AWS `ap-south-1` for IN, `ap-southeast-2`/AU for NZ) and DR targets that satisfy IN+NZ law. → **deploy-per-region fleets** (the fork is a single global Prisma singleton; in-process region switching is *not* available). Pin the `region` column day one so the split is config, not migration (02, 14, 16). *Blocks 02/14/16 finalization.*
7. **KMS/HSM** choice for root key + per-tenant DEKs (AWS KMS vs Vault vs cloud-HSM) — drives encryption impl and SOC 2 scope (14).
8. **Aadhaar policy**: tokenisation vault (store last-4 + reference, never plaintext) vs full storage (triggers UIDAI/Aadhaar Act obligations beyond DPDP). → **avoid full storage by default** (07, 14).

**Compliance scope & posture**
9. **IN 50%-wage rule enforcement at launch**: hard-block vs 90-day per-tenant grace window for the migrating installed base. → **grace window** (super-admin flag) (05, 07).
10. **Default PF policy** for new tenants: cap at ₹15,000 vs contribute on full wage. → **cap with a one-click cost-preview toggle** (05).
11. **PF auto-enrol at 20 / ESI at 10 headcount** vs prompt-and-confirm. → **prompt + legal sign-off** (01-O7).
12. **Form 16 → Form 130 cutover**: ship both generators switched by tax year (Form 16 for FY25-26; Form 130 for FY26-27 onward). Confirm and track the TRACES dependency (01-O4, 03-O3, 05, 09, 11, 15). *Pure label/template switch in the engine; confirm the legal source lock.*
13. **NZ payday-filing transport** at v1: myIR file-upload + manual confirm vs direct IRD gateway API (requires IRD software-developer registration + digital certs, a lead-time risk). → **upload first, gateway fast-follow** (06, 18).
14. **NZ FBT at GA**: full compute/file vs finance-report-only. → **report-only at GA** (01-O3).
15. **Bank disbursement depth at GA**: generate bank files for manual upload (IN NEFT/RTGS, NZ direct-credit IB4B/ABA) vs direct bank-API payout. → **bank-file at GA, payout fast-follow** (01-O6, 18).

**Product & ops**
16. **Maker-checker / 4-eyes on pay-run approval**: mandatory for all tenants vs Enterprise-gated; and whether two-person-payroll SoD defaults ON above a headcount (proposed >25). → **mandatory above threshold; tenant cannot disable below it** (02, 04, 14).
17. **Mobile**: native (React Native/Expo recommended) vs PWA for the deskless IN workforce, and per-tenant white-label native builds vs one themed Workspace app. → React Native; **themed universal app** unless premium demand justifies per-tenant builds (11, 13).
18. **Launch-blocking accounting integrations**: Xero (NZ) + Tally/Zoho Books (IN) vs fast-follow (18).
19. **Launch-priority IN states** for full PT/LWF/minimum-wage coverage (proposed MH/KA/TN/GJ/WB) — confirm against the actual sales pipeline; rest of India ships PT-nil/flag-for-config (05, 18).
20. **Pay-run performance SLO** (proposed: 10k employees computed+locked+payslips in ≤5 min p95) — ratify, and confirm whether enterprise needs 50k+ at GA (15).

---

## 5. Cross-Document Consistency & Gap Analysis

The reviews fixed in-place defects within docs. The items below are **cross-document** conflicts and gaps that the synthesis surfaces — things one doc must align with another.

### 5.1 Conflicts to reconcile
- **Doc-naming convention mismatch.** `02-system-architecture.md` (and some sibling cross-refs) reference attendance/Holidays-Act content by an old name (e.g. `05-attendance-leave-and-holidays-act.md`) while the delivered file is `08-modules-time.md`; the NZ engine itself is in `06-compliance-newzealand.md`. **All cross-doc links must be reconciled to this canonical 00–18 index** or they break. *(Flagged by review-nz/datamodel; not yet swept across all docs.)*
- **Money type must propagate.** `04-payroll-engine-design.md` was corrected to **`bigint`** (Sitepresso's `Int` overflows at ~₹2.14 cr for YTD/filing aggregates). `03-data-model.md` uses `Decimal` for money and must **not** copy Sitepresso's `Int`; the two docs must agree that payroll aggregates are `bigint`/`Decimal`, never 32-bit `Int`. Confirm rounding utility is *not* shared blindly between SaaS billing and payroll (IN PF nearest rupee, NZ PAYE to cents) (04, 03, 17-O4).
- **Form renumbering must be stated identically everywhere.** The verified mapping is **distinct forms**: 16→130, 16A→131, 24Q→138, 27D→133, 26AS→168, TDS-on-salary s.192→392, effective **TY 2026-27** (FY25-26 still "Form 16"). Several docs earlier wrote "16→130/138" as if 130/138 were aliases of one form. 04 and 05 are corrected; **09, 11, 12, 15, 16, 18 must use the same mapping and the year-keyed switch** owned by 05.
- **ESI base-shift date.** Now **confirmed effective 21 Nov 2025** (ESIC notifications 10 & 11 Dec 2025) in 04; 05 and the rule-table seed (12) must carry the same `esiBaseMode effectiveFrom=2025-11-21` and not re-hedge it.
- **Offer/increment 50%-rule code sharing.** `10-modules-talent.md` requires the offer pre-flight to share the payroll engine's **exact** 50%-wage rule code, not a copy — any divergence produces non-compliant or non-payable comp. This is a hard contract between 10 and 04/05, currently asserted but not yet enforced by shared-module wiring.
- **NZ retention years.** 14 was corrected to **6 years** (Employment Relations Act 2000 + Holidays Act 2003) vs **7 years** (IRD/tax); the data-model anonymisation cron (03) and DevOps retention config (16) must use the same two clocks (standardise NZ payroll retention to 7 to envelope both, but cite the statutes correctly).
- **DPDP commencement dates.** 14 corrected to **14 Nov 2025 / 14 Nov 2026 / 14 May 2027**; any other doc referencing DPDP phasing must match the 14th, not the 13th.

### 5.2 Gaps (missing or under-specified pieces)
- **No standalone delivery/roadmap doc.** Phasing is distributed across module docs; this README's §3 is the only consolidated view. If a formal program plan is needed, it should become `19-delivery-plan.md`.
- **Audit permission keys not reconciled.** 14's RBAC matrix grants scoped `audit.read` variants (HR-people / Finance-payroll) that are not yet distinct keys in the §4.2 permission catalogue or in 03's data model — reconcile in 03.
- **Custom-domain uniqueness is a *new* control, not inherited.** `Subscription.customDomain` has no DB uniqueness in the fork; a NEW partial unique index on `TenantDomain` + app-layer + Cloudflare checks must be built. Top pre-launch isolation workstream (02).
- **Exactly-once pay run depends on a NEW DB constraint.** BullMQ `jobId` does not guarantee exactly-once after job completion; the authoritative guard is a DB unique constraint on `PayRun` created before enqueue in a transaction. Must be built (02, 03).
- **RLS pooling hazard requires `SET LOCAL`.** Session-level `SET app.current_business_id` leaks across the shared pool and is forbidden under PgBouncer transaction-pooling; must use `SET LOCAL` inside `prisma.$transaction`. None of `$extends`/RLS/session-var exists in the fork yet — all NEW (02, 14).
- **Minimum-wage dataset (IN) is asserted, not enumerated.** Hundreds of rows, twice-yearly VDA revisions per state/employment/skill/zone — a staffed ops cadence, not a one-time build (05). Confirm the update cadence.
- **Statutory retention windows per artifact** not yet pinned to exact values (IN registers ~8 yr under Code-on-Wages vs NZ 6/7 yr) — the DPDP/Privacy-Act anonymise-but-retain cron needs precise parameters (02, 03, 14).
- **Govt filing has no stable public API on the IN side.** EPFO/ESIC/TRACES are file-upload-and-portal (Mode B); v1 produces upload files, shifting the last-mile submit to the tenant. Format/spec drift is an ongoing liability needing a conformance test harness (05, 18).
- **Custom-domain re-enable is unproven.** Cloudflare-for-SaaS BYO-domain path was retired 2026-05-10 in Sitepresso and is dormant; white-label ESS on tenant domains needs a dedicated verification pass (17, 02).
- **SSO white-label cookie-origin bridge** (Redis auth-code bridge across tenant custom domains) is a single point of failure that must be tested across all tenant domains (18).

---

## 6. Top Risks Register

| # | Risk | Impact | Mitigation (where) |
|---|---|---|---|
| R1 | **NZ Holidays Act 2003 mis-calculation** (OWP/AWE greater-of, RDP vs ADP, otherwise-working-day test, leave-in-weeks). Industry-wide failure mode with billions in remediation. | Legal/back-pay liability; destroys flagship correctness claim; leading churn/reputation event. | Pure-compute engine (06/08); ~23 dedicated golden cases + property/metamorphic tests with triple-derived expecteds (15); independent oracle implementation; legal review of section citations before GA. |
| R2 | **IN 50%-wage rule cascade** into PF, gratuity, ESI under the uniform-wages definition (live 21 Nov 2025). Mishandling understates statutory liability. | Employer penalties; non-compliant payslips; non-payable comp if offer engine diverges. | `WAGES_50_RULE` blocking anomaly + dedicated trace node (04/05); offer pre-flight must share the *exact* engine rule code, not a copy (10); golden tests across edge structures (15). |
| R3 | **Tenant-isolation breach across `businessId`.** Payroll is the most sensitive HR data; reused isolation must be re-hardened, not assumed. | Catastrophic cross-tenant PII/payroll leak; regulatory + existential. | Three-layer isolation: server-derived id → mandatory Prisma scoping extension → Postgres FORCE RLS with `SET LOCAL` in `$transaction` (02/14); CI isolation property + IDOR tests (15); custom-domain uniqueness index + exactly-once `PayRun` constraint (02). All NEW work in P0/P1. |
| R4 | **Regulatory drift on fixed effective dates** (1 Apr 2026, TY 2026-27; pending ESI ₹30k ceiling, PF ₹15k→₹21k/25k Supreme Court directive). Operator must publish new rule sets *ahead* of each date. | Tenants compute wrong pay if rule sets lag. | Versioned, effective-dated Super-Admin rule tables resolved as-of period-end (never `Date.now()`); 4-eyes publish + dry-run impact preview (12); rule-set publish lead time is an operational SLA (16); compliance-regression pipeline blocks undeclared deltas (15). |
| R5 | **Money correctness under concurrency & edge cases** (YTD lost-update race between REGULAR + off-cycle runs; arrears/back-pay/mid-year regime switch; `payDate` mutation invalidating the rule-version pin across a FY boundary). | Wrong tax/contribution figures (not benign duplicates); employee year-end shortfalls. | Per-employee `YtdLedger FOR UPDATE` at LOCK + `ytdVersion` revalidation (`YTD_DRIFT` blocker); block `payDate` mutation post-lock (`PAYDATE_PIN_STALE`); arrear recompute uses source-period's pinned rule version; DB-unique exactly-once; immutable closed runs; bank=Σnet=GL invariant (04). |
| R6 | **Form renumbering cutover** (16→130, 24Q→138, etc., TY 2026-27). Issuing a "Form 16" for post-1-Apr-2026 income, or treating 130/138 as aliases, is non-compliant. | Wrong-named statutory certificates; compliance defect. | Engine is form-id-agnostic; year-keyed template switch owned by 05; correct distinct-form mapping propagated to 04/09/11/12/15/16/18; legal source lock once forms officially publish (R-pending). |
| R7 | **Data residency (IN DPDP / NZ Privacy Act).** Single-region fork cannot transparently region-switch; getting the split wrong is costly to unwind. | CERT-In in-India log localisation + RBI payment-data localisation not actually met; legal exposure (₹250 cr DPDP max penalty). | Deploy-per-region fleets; pin `region` column day one; region-pinned connectors/exports/object-store prefixes; DR snapshot copies must not cross regions (02/14/16). Founder must confirm regions (decision #6). |
| R8 | **Govt filing reliability & format drift** (IRD payday filing 2 working days; EPFO/ESIC/TRACES by 7th/15th; per-bank file specs; IRD/EPFO schema versions). | Missed-deadline penalties; broken filings between releases. | Versioned file templates as data + format-version stamping; FVU validation gate; golden-file regression + nightly sandbox contract tests; retry/reconcile + early-escalation alerting; on-call rotation owned, not best-effort (15/16/18). |
| R9 | **Sensitive PII concentration** (Aadhaar/PAN/UAN/IRD/bank/visa/biometric/selfie/sick-reasons). | DPDP/Privacy-Act exposure; breach-clock execution (CERT-In 6h is the binding IN clock). | KMS-backed per-tenant envelope encryption decoupled from `JWT_SECRET` (crypto-shred); masking-at-rest; consent-gated sensitive fields off-by-default; `VIEW_SENSITIVE` audit; time-boxed super-admin support grants; breach runbook + pre-staged templates + tabletop drills (14). Avoid full Aadhaar (decision #8). |
| R10 | **Fork excision fallout** (deleting web/shop/booking/chat verticals + builder + profession themes; slimming theme-engine 10→5 styles). `vertical` threads through theme-engine/admin-core/`requireVertical`/`requireEcomPermission`. | Dangling `@sitepresso/*` imports stall P0; broken surviving feature-gating contracts. | 4-phase fork-and-strip runbook; sweep until `turbo build` type-checks; clean delete pass on theme-engine dead paths; verify no shared code paths depend on removed styles before deletion (17, P0 gate). |
| R11 | **Scope creep** toward full-suite HCM or a "builder," diluting the wedge and breaking the compliance guarantee. | Loses the differentiator; weakens correctness focus. | Ten explicit non-goals (00) defended; "configure, not build" enforced throughout (13); deliberate v1 boundaries (calculate-and-file-first, report-only FBT, bank-file disbursement). |
| R12 | **Golden-dataset / oracle decay.** ~420 dual-derived expecteds are expensive to maintain across annual rate rolls; the independent oracle can drift toward sharing engine assumptions (circular agreement). | The correctness gate silently loses value. | Incident→golden loop; Feb rate-roll rehearsal; enforced authorship separation between engine and oracle; periodic independence audit; compliance officer co-signs expecteds + rule-version publish (15). Staffing must be real. |

---

*Synthesis prepared by the Lead Architect / Program Lead. All compliance figures effective-dated and web-verified 2026-06-22; all Sitepresso reuse claims cite real, read-only-verified paths. Reviews applied in place to docs 02, 03, 04, 05, 06, 14.*

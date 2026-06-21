# 00 — Vision & Principles

> **Document status:** Foundational / canonical. Every other doc in `/Users/kp/docs` inherits the positioning, personas, principles, and non-goals defined here. When a downstream doc (`10-architecture.md`, `20-data-model.md`, `30-payroll-engine.md`, `31-compliance-IN.md`, `32-compliance-NZ.md`, `40-tenant-admin.md`, `50-employee-ess.md`, `60-super-admin.md`, `70-billing.md`, `80-onboarding.md`) contradicts this file, **this file wins** until explicitly amended.
>
> **Audience:** Experienced technical founder. Opinionated, exhaustive, production-grade. No MVP shortcuts.
>
> **Last verified against live sources:** 2026-06-22 (compliance figures carry effective dates inline).

---

## 1. The One-Sentence Thesis

> **We are building the only HRMS + Payroll SaaS that is simultaneously (a) white-label down to the bound custom domain, (b) natively, provably correct for *both* India and New Zealand statutory payroll, and (c) a "pre-built system you configure," not a "builder you assemble" — sold to mid-market employers and the accountants/payroll-bureaus/franchisors who resell under their own brand.**

Three competitors each own one of those three axes. **Nobody owns all three.** That intersection is the wedge.

---

## 2. Why This, Why Now (Market & Timing)

### 2.1 The regulatory "reset" is the demand event

Payroll software is a grudge purchase until the rules change underneath the buyer. **2025–2026 is the largest simultaneous compliance discontinuity in both launch markets in a generation**, which manufactures a switching event:

| Market | Discontinuity | Effective date | Why it forces a software decision |
|---|---|---|---|
| **IN** | Four Labour Codes go live (Code on Wages, Social Security, Industrial Relations, OSH) — consolidating 29 laws | **21 Nov 2025** | Uniform "wages" definition forces salary-structure restructuring across the entire employee base |
| **IN** | "Wages" = Basic + DA + Retaining Allowance must be **≥ 50%** of total remuneration; excess exclusions over 50% are deemed wages | **21 Nov 2025** | Cascades into PF, gratuity, leave encashment, retrenchment, bonus — every legacy CTC structure is now non-compliant |
| **IN** | Form 16 → **Form 130**; Form 24Q → **Form 138** (Income Tax Act 2025) | **Tax Year 2026-27**; first Form 130 issued by **15 Jun 2027** | Year-end statutory artefacts change format; old templates break |
| **IN** | New tax regime is **default**; §87A ⇒ nil tax up to ₹12L taxable; ₹75,000 standard deduction | FY 2025-26 onward | Default-regime logic and rebate edge cases must be re-implemented |
| **NZ** | KiwiSaver default minimum **3% → 3.5%** (employee & employer); → 4% in 2028; 16–17 yr-olds become eligible for *employer* contributions | **1 Apr 2026** | Every NZ employer's deduction config is wrong on 1 April; mid-year rate-relief applications (3–12 months, from Feb 2026) add state |
| **NZ** | ACC earners' levy **1.67% → 1.75%** on first **$156,641** | **1 Apr 2026** | PAYE-side calc changes for every NZ payslip |
| **NZ** | Adult minimum wage **$23.50 → $23.95/hr** (training/starting-out → $19.16, = 80%) | **1 Apr 2026** | ~122,500 workers affected; minimum-wage compliance checks must update |

Both markets share an **April–March tax year**, which is the single most important architectural gift: one fiscal-period model, two rule sets. (See `31-compliance-IN.md` and `32-compliance-NZ.md` for the full rule tables.)

> **Founder's-eye view:** We are not asking buyers to switch for features. We are arriving at the exact moment their existing setup became non-compliant and selling correctness with their own logo on it. The compliance calendar *is* the go-to-market calendar.

### 2.2 The white-label demand is structural, not cosmetic

In both markets, the *actual* payroll buyer is frequently an intermediary:

- **IN:** CA firms, payroll-outsourcing bureaus, PEO/staffing companies, and franchise networks run payroll for dozens-to-hundreds of downstream entities. They want **their** brand in front of **their** client's employees.
- **NZ:** Accounting practices (the Xero ecosystem) and bookkeeping firms deliver payroll as a productized service. Employment Hero already proved channel/partner distribution works here; PayHero/Smartly are bureau-friendly.

A multi-tenant, white-label platform turns every one of these intermediaries into a **distribution channel** rather than a competitor — they resell our engine, we never touch their client relationship, and per-seat economics compound across their book of business.

### 2.3 The "provable NZ Holidays Act" moat

The **Holidays Act 2003** is the single hardest, highest-liability calculation in either market: annual leave measured in **weeks** (not days/hours), four parallel pay-rate methods (Ordinary Weekly Pay, Average Weekly Earnings, Relevant Daily Pay, Average Daily Pay), alternative/lieu days, and "otherwise working day" determinations. Holidays Act **remediation** has cost NZ employers (incl. government) hundreds of millions in back-pay. **A payroll engine that is provably correct here — with an auditable, reproducible calculation trail — is a category-defining trust asset.** This is our flagship NZ feature and is specified in depth in `32-compliance-NZ.md`.

---

## 3. Competitive Landscape

### 3.1 India

| Vendor | What they are | Strength | Where we beat them |
|---|---|---|---|
| **Keka** | Mid-market HRMS + payroll, strong UX | Best-in-class IN UX, performance/OKR modules | No white-label; single-country (IN); not a reseller platform |
| **greytHR** | SMB payroll/compliance workhorse | Deep IN statutory compliance, huge install base | Dated UX; no white-label tenant brand; IN-only; bureau features bolted on |
| **Darwinbox** | Enterprise HCM (large-cap, APAC) | Enterprise depth, mobile | Up-market, expensive, long implementations; not for the mid-market white-label reseller |
| **Zoho Payroll / People** | Suite play inside Zoho ecosystem | Price, ecosystem lock-in | Zoho-branded only; multi-country but shallow NZ; configurable but suite-constrained |

**IN gap we exploit:** none of these is a *true multi-tenant white-label platform with a super-admin operator console* that also does NZ payroll natively. greytHR owns compliance depth but not brand-resale or NZ; Keka owns UX but not white-label or NZ.

### 3.2 New Zealand

| Vendor | What they are | Strength | Where we beat them |
|---|---|---|---|
| **Employment Hero** | AU/NZ HR + payroll super-app | Channel/partner muscle, breadth, brand | AU-first; no IN payroll; white-label limited; "everything app" sprawl vs our focused fit |
| **PayHero** | NZ payroll specialist (FlexiTime) | Genuinely good Holidays Act handling, time/rostering | NZ-only; not white-label; no HRMS breadth; no IN |
| **Smartly** | NZ payroll bureau/SaaS | Bureau heritage, NZ compliance | NZ-only; not a self-serve white-label platform; no IN |
| **Xero Payroll** | Payroll inside Xero accounting | Ubiquity in NZ SMB, accountant channel | Shallow HR; Holidays Act has been a known pain point; not white-label; no IN |

**NZ gap we exploit:** the credible NZ-payroll players are all single-country and non-white-label. An accounting practice that wants to resell branded payroll has no multi-country, brandable option — and IN-diaspora-owned NZ businesses (and trans-Tasman/IN-NZ corridors) get *zero* unified IN+NZ vendor.

### 3.3 The honest competitive truth (founder note)

We will **not** win on raw feature count against Darwinbox or breadth against Employment Hero on day one. We win on a **specific, defensible intersection**: *white-label + IN-and-NZ-native + pre-built-not-builder*, sold through intermediaries, anchored by provable Holidays Act + Labour Code correctness. Every roadmap decision is scored against whether it deepens that intersection (see §7 principles and §8 metrics).

---

## 4. Personas & Surfaces

We ship **four surfaces** (see `10-architecture.md` for the apps mapping). Each persona lives primarily on one surface.

| # | Surface | Host | Who | We reuse |
|---|---|---|---|---|
| 1 | **Marketing + Onboarding** | `hr.com` | Prospects, signups, setup wizard | Marketing patterns from `apps/web` (then deleted), onboarding wizard pattern |
| 2 | **Super Admin (operator console)** | `admin.hr.com` | **Us** — the SaaS operator | `apps/platform`, `packages/admin-core` |
| 3 | **Tenant Admin (HR console)** | `app.hr.com` | Employer's HR/Finance/Manager | New `apps/hr` (admin) on `packages/ui` + `admin-core` |
| 4 | **Employee Self-Service (ESS)** | `tenant.com` / `tenant.hr.com` | Employees (white-labeled) | New `apps/hr` (employee) + `packages/theme-engine` |

### 4.1 Super Admin (operator) — *us*

- **Goal:** Run a profitable, compliant, multi-tenant SaaS.
- **Responsibilities:** tenant lifecycle (provision/suspend/offboard), plans & per-seat pricing, promo codes, multi-gateway billing (Razorpay IN / Stripe NZ / Paddle RoW), feature-flags-by-plan, **versioned per-country compliance rule tables**, platform analytics, support **impersonation**, full audit.
- **JTBD:** "When a labour rule changes, I publish a new *versioned* rule set effective on a date, and every tenant's payroll picks it up correctly without me touching tenant data." → see `60-super-admin.md`, `31/32-compliance-*.md`.

### 4.2 Tenant Admin — HR / Finance

- **Goal:** Run accurate payroll on time, every cycle, with zero statutory penalties, while their employees self-serve.
- **JTBD (HR):** onboard an employee in <5 min with a compliant salary structure; approve leave; close a pay run; file statutory returns.
- **JTBD (Finance):** reconcile payroll to the GL; produce the bank/NEFT or NZ direct-credit file; verify PF/ESI/TDS (IN) or PAYE/KiwiSaver/ESCT (NZ) liabilities before deposit deadlines.
- **Hard constraint:** they **configure**, they do not **build**. → see `40-tenant-admin.md`.

### 4.3 Manager (line manager)

- **Goal:** Approve/deny their team's leave, timesheets, regularizations, and reimbursements; see team attendance; never touch payroll money.
- **JTBD:** "Clear my approval queue from my phone in under a minute, with enough context to decide." → ESS + manager scope, `50-employee-ess.md`.

### 4.4 Employee

- **Goal:** Trust their pay, get their payslip/Form 16/130 or IRD-aligned summary, request leave, update details, see KiwiSaver/PF balances — all under **their employer's brand**, never ours.
- **JTBD:** "Tell me exactly why my net pay is what it is, and let me request leave without emailing HR." → `50-employee-ess.md`.

> **White-label invariant:** On surface #4, the employee must **never** see our brand. Branding is the tenant's logo, one brand color, one of ~5 fixed styles, on a bound custom domain. (See §7.2.)

---

## 5. Jobs-To-Be-Done (consolidated)

| JTBD | Persona | Success looks like | Doc |
|---|---|---|---|
| Sign up and stand up a compliant company in one sitting | Prospect → HR | Guided wizard ends with a runnable first pay cycle | `80-onboarding.md` |
| Onboard an employee with a *legally valid* salary structure | HR | Basic+DA ≥ 50% (IN) enforced at entry; no invalid structure can be saved | `30-payroll-engine.md`, `31-compliance-IN.md` |
| Close a pay run with provable correctness | HR/Finance | Deterministic, re-runnable calc with full line-item trace; locked & versioned | `30-payroll-engine.md` |
| Pay statutory dues before the deadline | Finance | System surfaces TDS-by-7th, PF/ESI-by-15th (IN); PAYE/ESCT monthly-by-20th + payday-filing within 2 working days (NZ) | `31/32-compliance-*.md` |
| Pay holiday/leave correctly (NZ) | HR | Higher-of OWP/AWE for annual leave; RDP/ADP for sick/bereavement/public holidays; alternative days tracked | `32-compliance-NZ.md` |
| Self-serve as an employee under employer's brand | Employee | Payslip, leave, details, balances — zero our-brand leakage | `50-employee-ess.md` |
| Resell payroll under my own brand | Channel/partner | Custom domain + SSL bound; their logo; per-seat billing rolls up | `70-billing.md`, custom-domain reuse |
| Roll a compliance rule change across all tenants | Operator (us) | Publish versioned rule set with effective date; tenants inherit; nothing breaks | `60-super-admin.md` |

---

## 6. Positioning & The Wedge

### 6.1 Positioning statement

> For **mid-market employers and the accountants, payroll bureaus, PEOs, and franchisors who serve them in India and New Zealand**, who are **forced to re-platform by the 2025–26 Labour Code / Holidays Act / KiwiSaver changes**, **[the platform]** is a **white-label HRMS & Payroll SaaS** that **is provably compliant in both IN and NZ out of the box and runs entirely under your brand** — unlike **Keka/greytHR/Zoho (IN-only, vendor-branded) or PayHero/Smartly/Xero (NZ-only, vendor-branded)**, we are the **only IN+NZ-native, white-label, configure-don't-build platform**.

### 6.2 The three-part wedge

1. **White-label to the domain.** Reuse Sitepresso's Cloudflare-for-SaaS custom-domain + SSL pipeline and `packages/theme-engine` (slimmed to 5 styles). The employee portal is the tenant's product.
2. **IN + NZ native, not "international-ish."** Two first-class compliance modules with versioned rule tables, not a generic engine with a tax plugin. Shared Apr–Mar fiscal model; divergent statutory logic.
3. **Pre-built system, not a builder.** Tenants get a finished product they configure. We carry the compliance burden centrally; they never assemble a payslip template or a leave-rule DSL.

### 6.3 Land-and-expand

**Land** on the compliance switching event (one country, one pain). **Expand** to (a) the second country for trans-Tasman/diaspora employers, (b) deeper HR modules (performance, attendance, expenses), and (c) **channel** — each bureau/franchisor multiplies seats. Per-seat pricing makes expansion automatic as the tenant grows headcount.

---

## 7. Product Principles (opinionated, enforced)

### 7.1 Compliance is a **versioned data asset**, not code

Statutory rates, thresholds, and slabs (PF 12%/EPS 8.33% capped at ₹15,000 wage/EPF 3.67%; ESI 0.75%+3.25% on gross ≤ ₹21,000; PT capped ₹2,500/yr; gratuity 15/26; new-regime slabs + ₹75k SD + §87A; KiwiSaver 3.5%, ACC 1.75% on $156,641, ESCT, student loan, min wage $23.95) live in **operator-managed, versioned, effective-dated rule tables** — never hardcoded in the engine. A pay run binds to the rule-set version effective for its period, so **historical re-runs are reproducible** and future changes are publishable without a deploy. → `31/32-compliance-*.md`, `60-super-admin.md`.

### 7.2 Pre-built, not a builder (the cardinal rule)

Tenants **CONFIGURE** (data + settings + plan feature flags) and **USE**. They do **not** design or build anything. **No page builder, no form builder, no layout builder, no rule-DSL.** Branding is exactly: **logo + ONE brand color + ONE of ~5 fixed styles + ONE bound custom domain.** Nothing else is designable. This is what lets us guarantee compliance and own the surface area. (Contrast: Sitepresso *was* a website/page builder — we are deleting `apps/{web,shop,booking}` and the builder precisely because the HR product must be the opposite.)

### 7.3 Determinism & auditability over cleverness

Every payroll number must be **explainable and reproducible**: given the same inputs + same rule-set version, the engine produces byte-identical output with a full line-item derivation trace. No floating-point ambiguity in money (integer minor units; documented rounding per statute). This underwrites the NZ Holidays Act "provable correctness" claim.

### 7.4 Tenant isolation is non-negotiable

Reuse Sitepresso's row-level `businessId` isolation (the production Prisma schema carries `businessId` on **421** model references) plus JWT auth + RBAC (`backend/src/core/middleware/auth.middleware.js`, `backend/src/core/lib/rbac.js`, `roles.js`). Payroll data is the most sensitive data a company holds; cross-tenant leakage is an extinction-level event. Operator **impersonation** is the *only* sanctioned cross-tenant path, and it is fully audited.

### 7.5 Mobile-first for employees, desk-first for HR

ESS is consumed primarily on phones (esp. IN deskless workforces). HR/Finance pay-run operation is desk-first (reconciliation needs screen real estate). Build accordingly.

### 7.6 Reuse the platform, rebuild the vertical

We fork proven infrastructure and build only the HR domain. **Concrete reuse (real paths, read-only-verified 2026-06-22):**

| Capability | Sitepresso source | Disposition |
|---|---|---|
| Tenant resolution / routing | `apps/router/index.js`, `apps/router/cloudflare-worker.js` | **Reuse** |
| Super-admin shell | `apps/platform/` (Next.js, `app/`, `lib/`, `middleware.js`) | **Reuse** |
| Admin panel framework | `packages/admin-core/` (`createPanelDefinition`, `filterPanelsForFeatures`) | **Reuse** |
| Design system | `packages/ui/` | **Reuse** |
| Theming | `packages/theme-engine/` | **Reuse, slim to 5 styles** |
| Auth / RBAC | `backend/src/core/middleware/auth.middleware.js`, `core/lib/rbac.js`, `roles.js` | **Reuse** |
| Tenant isolation | `businessId` row-level (Prisma schema, 421 refs) | **Reuse** |
| Billing (multi-gateway) | `core/lib/paddle.js`, `razorpayRoute.js`, `stripeConnect.js`, `subscriptionBilling.js`, `billingLedger.js`, `planCatalog.js`, `entitlements.js` | **Reuse** |
| Promo / trial | `core/lib/trial.js`, promo in billing | **Reuse** |
| Custom domain + SSL | `core/lib/customDomainRouting.js`, `cloudflareDns.js`, `domains/` (OpenProvider adapters) | **Reuse** |
| Notifications (multi-channel, country-routed) | `core/lib/notifications/` (`router.js`, `templates.js`, `countryRouting.js`, `providers.js`), `sms.js` | **Reuse** |
| i18n | `backend/src/i18n/` (`en.json`, `hi.json`, …), `apps/platform/messages/` | **Reuse en/hi; add NZ-en** |
| Feature flags by plan | `core/lib/entitlements.js`, `featuresCatalog.js`, `planCatalog.js` | **Reuse** |

**Delete:** website/page builder, verticals `apps/{web,shop,booking}` + `backend/src/{web,shop,booking}`, the 60+ profession themes, domain/mailbox resale. **Build new:** `apps/hr` (admin+employee), `backend/src/hr`, HR data models, payroll engine + IN/NZ compliance modules, ESS, mobile. → `10-architecture.md`.

### 7.7 Correct-by-construction inputs

Invalid states should be **unrepresentable** at data entry, not caught at pay-run time. Example: an IN salary structure where Basic+DA < 50% of total cannot be *saved* (validated server-side against the active rule set), so no pay run can ever consume an illegal structure.

### 7.8 Country is a first-class dimension, not a setting

A tenant (and often an employee/entity) has a **country of operation** that selects the entire statutory stack: tax year boundaries are shared (Apr–Mar) but rule tables, payslip layouts, statutory artefacts (Form 16/130 vs IR-aligned summaries), deposit calendars, and payment-file formats (NEFT/bank advice vs NZ direct credit) all branch on it.

---

## 8. Success Metrics

### 8.1 North-star

> **Net statutory-correct seats under management** — the count of active employees being paid each month through the platform with **zero statutory exceptions** in that cycle. It captures growth (seats), value (payroll actually run, not shelfware), and quality (correctness) in one number.

### 8.2 Acquisition / activation

| Metric | Target signal |
|---|---|
| Time-to-first-pay-run (signup → first closed cycle) | < 1 working day (self-serve) |
| Onboarding-wizard completion rate | > 70% of signups reach a runnable company |
| Channel/partner-originated tenants | trending up as % of new tenants (validates the wedge) |

### 8.3 Correctness (the moat metrics)

| Metric | Target |
|---|---|
| Statutory-exception rate per pay run | → 0 (any PF/ESI/TDS or PAYE/KiwiSaver/ESCT mismatch is a Sev-2) |
| NZ Holidays Act recalculation discrepancy vs reference cases | 0 (golden-test suite must pass 100%) |
| On-time statutory deposit/filing assists | 100% of deadlines surfaced before due date |
| Pay-run re-run determinism | 100% byte-identical on same inputs+version |

### 8.4 Retention / expansion

| Metric | Target signal |
|---|---|
| Net revenue retention | > 110% (per-seat expansion + second-country attach) |
| Logo churn (tenants) | < monthly threshold; correctness incidents are the leading churn predictor |
| Second-country attach rate | meaningful share of multi-entity tenants enable both IN & NZ |
| Seats per tenant over time | rising (headcount growth drives per-seat revenue) |

### 8.5 Operator (platform) health

Tenant provisioning success rate; impersonation usage fully audited; rule-set publish lead time before each effective date; gateway settlement reconciliation (Razorpay/Stripe/Paddle).

---

## 9. Explicit Non-Goals

These are **deliberate exclusions**. Saying no here is what makes the product shippable and the compliance promise keepable.

1. **No builder of any kind.** No page/form/layout/report/rule-DSL builder. Configuration only. (§7.2)
2. **No unbounded branding.** Beyond logo + one color + one of ~5 styles + one custom domain, nothing is designable.
3. **No third launch market (yet).** RoW is billing-only (Paddle) for incidental use; **we do not claim compliance outside IN/NZ.** No US/UK/AU statutory payroll at launch.
4. **No full-suite HCM sprawl at launch.** Recruiting/ATS, LMS, advanced OKR/performance, and travel/T&E desk are **post-core**; we win on payroll correctness + white-label first, not breadth.
5. **No domain/mailbox resale.** Deleted with the Sitepresso heritage; we are not an email/hosting reseller.
6. **No tenant-authored compliance logic.** Tenants never write tax/leave rules. Rules are operator-managed, versioned, effective-dated. (§7.1)
7. **No accounting/GL replacement.** We **integrate/export** to accounting (Xero in NZ, Tally/Zoho Books in IN) — we are not the ledger of record.
8. **No employer-of-record / PEO-of-record service.** We are software the employer (or their bureau) operates; we do not become the legal employer or hold client funds beyond billing.
9. **No our-brand leakage on the employee surface.** Ever. (§4, §7.2)
10. **No hardcoded statutory constants in engine code.** Any rate/threshold/slab not in a versioned rule table is a bug. (§7.1, §7.3)

---

## 10. Cross-Document Map

| Doc | Owns |
|---|---|
| `00-vision-and-principles.md` *(this)* | Vision, market, competition, personas, JTBD, positioning, principles, metrics, non-goals |
| `10-architecture.md` | Surfaces→apps mapping, fork/delete/build plan, reuse wiring, tenancy & routing |
| `20-data-model.md` | HR data models, `businessId` isolation, entities/relationships |
| `30-payroll-engine.md` | Deterministic calc core, pay-run state machine, rounding, traceability |
| `31-compliance-IN.md` | Labour Codes, wages-50%, PF/ESI/PT/TDS/gratuity, Form 130/138, deposit calendar |
| `32-compliance-NZ.md` | Holidays Act 2003 (OWP/AWE/RDP/ADP, lieu days), KiwiSaver/ESCT/ACC/student loan, payday filing |
| `40-tenant-admin.md` | HR console configuration & operation |
| `50-employee-ess.md` | White-labeled employee/manager self-service + mobile |
| `60-super-admin.md` | Operator console, versioned rule tables, impersonation, audit |
| `70-billing.md` | Plans, per-seat pricing, promo, Razorpay/Stripe/Paddle |
| `80-onboarding.md` | Marketing + guided company-setup wizard |

---

## Appendix A — Verified 2026 Compliance Facts (with sources)

**India**
- Four Labour Codes live **21 Nov 2025**; "wages" (Basic+DA+Retaining Allowance) must be **≥ 50%** of total remuneration; excess exclusions over 50% deemed wages. Sources: [labour.gov.in FAQ (16.03.2026)](https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf), [taxguru.in](https://taxguru.in/corporate-law/labour-code.html), [PwC India](https://www.pwc.in/tax-knowledge-hub/new-labour-codes.html), [weekmate 50% rule](https://weekmate.in/blog/50-wage-rule-in-new-labour-codes-impact-on-salary-pf-gratuity/).
- EPF mandatory at **20+** employees; ESI mandatory at **10** with gross ≤ **₹21,000**; new-regime §87A nil tax to **₹12,00,000** taxable; standard deduction **₹75,000**. Source: [SalaryBox 2026 compliance guide](https://salarybox.in/complete-guide-to-statutory-compliance-for-indian-businesses-2026-pf-esi-tds-professional-tax-labour-codes/), [ClearTax new regime FAQ](https://cleartax.in/s/new-tax-regime-frequently-asked-questions).
- Form 16 → **Form 130** (Income Tax Act 2025), effective **Tax Year 2026-27**, first issued by **15 Jun 2027**; Form 24Q → **Form 138**. Sources: [CAclubindia](https://www.caclubindia.com/articles/form-130-replaces-form-16-new-salary-tds-certificate-for-fy-2026-27--55768.asp), [BusinessToday](https://www.businesstoday.in/personal-finance/news/story/form-16-to-form-130-new-income-tax-act-brings-in-new-forms-from-april-1-522253-2026-03-25), [taxguru.in](https://taxguru.in/income-tax/form-130-tds-certificate-salary-replacing-form-16.html).

**New Zealand**
- KiwiSaver default min **3% → 3.5%** (employee & employer) from **1 Apr 2026** → 4% in 2028; 16–17 yr-olds eligible for employer contributions; temporary rate-relief applications (3–12 months) from **Feb 2026**. Sources: [IRD KiwiSaver changes](https://www.ird.govt.nz/kiwisaver-changes), [Generate Wealth](https://www.generatewealth.co.nz/article/kiwisaver-minimum-contributions-rising-to-35-in-2026/), [MAS](https://www.mas.co.nz/hub/kiwisaver-changes-2026-increased-contribution-rate-of-35/).
- Adult minimum wage **$23.50 → $23.95/hr** from **1 Apr 2026**; training/starting-out → **$19.16** (80%). Sources: [MBIE](https://www.mbie.govt.nz/about/news/minimum-wage-set-for-2026), [Employment NZ](https://www.employment.govt.nz/news-and-updates/minimum-wage-is-increasing-on-1-april-2026).
- Payday filing **within 2 working days** of each payday (electronic); PAYE+ESCT monthly by the **20th** if gross annual < $500,000; ESCT on employer KiwiSaver; student-loan deductions; Holidays Act 2003 methods **OWP/AWE/RDP/ADP**. Sources: [IRD payday filing](https://www.ird.govt.nz/employing-staff/payday-filing), [IRD paying deductions](https://www.ird.govt.nz/employing-staff/payday-filing/paying-deductions-to-inland-revenue).
- ACC earners' levy **1.67% → 1.75%** on first **$156,641** from 1 Apr 2026 *(verify final cap figure against the ACC 2026/27 levy notice before locking the NZ rule set in `32-compliance-NZ.md`).*

*All figures above are effective-dated and belong in operator-managed, versioned rule tables (§7.1), not in engine code.*

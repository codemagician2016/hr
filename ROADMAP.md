# HRMS & Payroll Platform — Roadmap

> Multi-tenant, white-label HR & Payroll SaaS. Tenants buy a ready-built HR system,
> brand it (logo + color + domain), and run their company on it. Employees self-serve
> on the tenant's branded domain. Launch markets: **India 🇮🇳 + New Zealand 🇳🇿**.
> Built by reusing the **Sitepresso** platform layer (tenancy, billing, routing,
> white-label, auth) and building the HR & payroll product on top.

_Last updated: 2026-06-22_

---

## 1. Product shape — 4 surfaces

| # | Surface | Domain | Who | Purpose |
|---|---|---|---|---|
| 1 | Marketing + Onboarding | `hr.com` | Prospects | Sell, sign up, set up |
| 2 | Super Admin | `admin.hr.com` | Us | Run the SaaS business |
| 3 | Tenant Admin (HR console) | `app.hr.com` | Employer HR/Finance | Configure & run HR + payroll |
| 4 | Employee Self-Service | `tenant.com` / `tenant.hr.com` | Employees | Self-serve, white-labeled |

**Principle: pre-built system, NOT a builder.** No page/form/layout builder for tenants.
The tenant *configures* (data + settings + plan feature flags) and *uses*. Branding = logo +
1 brand color + 1 of ~5 fixed styles + custom domain. Nothing else is designable.

---

## 2. Reuse strategy (from Sitepresso `/Users/kp/sitepresso`)

**♻️ REUSE (platform plumbing — already production-tested):**
- Multi-tenant routing + tenant resolution (`apps/router`)
- Super-admin / tenant provisioning (`apps/platform`)
- Custom-domain binding + SSL (Cloudflare-for-SaaS / Let's Encrypt) + OpenProvider
- Billing: subscriptions, plans, **per-seat pricing**, promo codes — **Razorpay (IN) / Stripe (NZ) / Paddle (RoW)**
- Auth + JWT + RBAC + row-level `businessId` tenant isolation (`backend/src/core`)
- UI component library (`packages/ui`), admin shell (`packages/admin-core`)
- White-label theming (`packages/theme-engine`) — **slimmed to ~5 fixed styles**
- Notifications (email/SMS/WhatsApp), i18n (en-IN, en-NZ, Hindi), caching, deploy tooling

**🗑️ DELETE (website/commerce — not needed):**
- Website/page builder + verticals: `apps/web`, `apps/shop`, `apps/booking`
- `backend/src/{web,shop,booking}`, the 60+ profession themes, domain/mailbox **resale**

**🆕 BUILD (the HR product):**
- New vertical `apps/hr` (admin + employee sub-apps) + `backend/src/hr`
- HR data models, payroll engine core, **India + NZ compliance modules**, ESS, mobile

---

## 3. Phased roadmap

### Phase 0 — Foundation _(fork & wire the plumbing)_
- Fork Sitepresso → this repo; strip website/commerce verticals.
- Keep + verify: router, platform/super-admin, billing, auth/RBAC, tenancy, UI, theme (5 styles).
- Scaffold the HR vertical: `vertical = 'HR'`, `apps/hr/{admin,employee}`, `backend/src/hr`, router ports.
- Wire: signup → company setup wizard → branded tenant + `tenant.com` employee portal (empty shell that routes & themes correctly).
- **Exit:** a tenant can sign up, get branded portal at a domain, log in as admin + employee — no HR features yet.

### Phase 1 — Core HR + ESS
- Org structure (entities, locations, departments, designations, holiday calendars).
- Employee management + lifecycle (onboarding → offboarding), document vault.
- Leave management (types, accrual, approval, calendar, balances).
- Attendance & time (clock-in/out, regularization, timesheets, shifts).
- ESS: dashboard, profile, leave, attendance, directory, org chart, announcements, documents.
- **Exit:** a company can run day-to-day HR (people, leave, attendance) — no payroll yet.

### Phase 2 — India Payroll engine + compliance ◄ MVP core
- Payroll core: salary structure/CTC builder, pay-run workflow, payslips, off-cycle, F&F.
- **India compliance module:** TDS (new regime default, §87A), EPF (12%+12%), ESI, Professional Tax (state-aware), Gratuity, **new Labour-Code wage rule (Basic ≥ 50% CTC)**, Form 24Q, Form 16/130, bank advice files.
- Expenses/reimbursements + loans/advances (payroll integration).
- **Golden-dataset payroll test harness** (non-negotiable QA).
- **Exit → MVP: India launch.** Core HR + Payroll + white-label + ESS.

### Phase 3 — New Zealand Payroll + compliance _(multi-country proof)_
- NZ compliance module: PAYE + **payday filing**, **KiwiSaver (3.5% from 1 Apr 2026)**, **ACC (1.75%)**, student loan, ESCT.
- **Holidays Act 2003** leave/pay engine (relevant vs average daily pay, lieu days) — flagship NZ feature.
- **Exit:** NZ launch; architecture proven multi-country.

### Phase 4 — Polish & scale
- Billing/white-label/dunning hardening, mobile ESS apps, notifications, reports & analytics, super-admin compliance-rule console, integrations (Tally/Zoho/Xero, biometric, Slack/Teams).

### Phase 5 — Strategic modules
- Performance management, Recruitment/ATS, AI assist (payroll anomaly detection, policy chatbot, attrition), country #3.

**MVP = Phase 0 + 1 + 2 (India).** Then Phase 3 (NZ).

---

## 4. Sprint 0 (current) — Foundation tasks
1. [ ] Fork reusable Sitepresso layers into this repo (exclude `node_modules`, `.git`, `.next`, generated).
2. [ ] Remove website/commerce verticals + builder + profession-theme catalog.
3. [ ] Add `HR` to the vertical enum (backend + platform + business libs).
4. [ ] Reduce theming to ~5 fixed styles; lock white-label to logo + color + domain.
5. [ ] Scaffold `apps/hr/{admin,employee}` + `backend/src/hr` + router port mappings.
6. [ ] Prisma: add HR base models (Employee, EmploymentRecord, …) scoped by `businessId`.
7. [ ] Wire signup → HR company-setup wizard → branded portal smoke test.
8. [ ] Rebrand platform/super-admin copy (Sitepresso → HRMS).

---

## 5. Tech stack (inherited from Sitepresso)
- **Frontend:** Next.js 14 + React 18 + Tailwind, Turborepo monorepo (npm workspaces).
- **Backend:** Node.js + Express + Prisma ORM + PostgreSQL.
- **Auth:** JWT (operator + employee cookie scopes), row-level `businessId` isolation.
- **Billing:** Razorpay (IN) / Stripe (NZ) / Paddle (RoW), multi-currency (INR/NZD/USD).
- **Infra:** Cloudflare-for-SaaS (custom domains + SSL), Redis cache, AWS SES, EC2/PM2, Vercel.

---

## 6. Open decisions
- **D1 — Code home:** standalone fork in this repo (recommended; clean separate product) vs new vertical inside the Sitepresso monorepo (one codebase, coupled). _Default: fork._
- **D2 — Money movement:** MVP = calculate + generate bank/statutory files (low regulatory weight); actual disbursement/e-filing later. _Default: calculate-first._
- **D3 — Build cadence:** solo (sequential, full control) vs multi-agent orchestration (parallel, faster, higher token cost; opt-in via "ultracode"/"use a workflow").

---

## 7. Compliance watch (super-admin updates these — versioned, dated)
- 🇮🇳 New Labour Codes live **21 Nov 2025**; Basic ≥ 50% CTC; new tax regime default; Form 16 → Form 130 (track final notification).
- 🇳🇿 From **1 Apr 2026**: KiwiSaver 3%→3.5%, ACC 1.67%→1.75% (cap $156,641), min wage $23.95/hr, 16–17yo KiwiSaver eligibility.

---

## 8. Scope decisions — explicitly deferred (with rationale)
These features have schema and/or backend hooks but are **deliberately deferred** to
a later phase. They are NOT half-built dead ends in the UI — the supported
alternative is wired and signposted in-product.

- **Compensation — bulk increment-cycle worksheet (audit #26).** The `IncrementCycle`
  / cycle-line bulk merit worksheet (open cycle → propose %/amount per employee →
  HR approve → batch-commit revisions) is deferred to **Phase 5 (Performance + merit)**.
  Rationale: the per-employee **revision maker-checker** flow already delivers the
  governance contract end-to-end (propose → distinct-checker approve/reject, SoD
  fail-closed, India 50% guard, comp masking). Bulk cycles are an efficiency layer
  on top of that primitive, best built alongside performance merit hand-off. The
  Compensation console signposts this on the Approvals tab; no increment-cycle tab
  is shown so there is no dead action.
- **Performance — advanced admin surfaces (audit #39).** Cycle config, rating scales,
  review templates, calibration sessions, goals/OKRs and 1:1s have backend routes
  but the admin console ships the **review-operations** surfaces first (My Team
  Reviews + cycle list/launch/release/stats). Goals/OKR authoring, calibration-session
  management, template/scale editors and merit review are deferred to **Phase 5**
  polish. The Performance page lists these as "available via API / coming to the
  console" rather than rendering empty tabs.

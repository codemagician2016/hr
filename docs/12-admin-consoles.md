# 12 — Admin Consoles (Super Admin + Tenant Admin)

> **Status:** Production design spec — not an MVP scope.
> **Author role:** Senior Product Designer (Admin surfaces).
> **Scope:** (a) **Super Admin** at `admin.hr.com` — *we* run the SaaS; (b) **Tenant Admin / HR console** at `app.hr.com` — the employer's HR/Finance team configures and runs HR + payroll.
> **Out of scope here:** Employee Self-Service (`tenant.com`) → see `13-ess-and-mobile.md`; marketing + onboarding wizard (`hr.com`) → see `11-marketing-and-onboarding.md`; payroll math → `04-payroll-engine-design.md`; compliance specifics → `05-compliance-india.md`, `06-compliance-newzealand.md`; data model → `03-data-model.md`; architecture → `02-system-architecture.md`.

---

## 0. Design principles for both consoles

1. **Pre-built system, not a builder.** Neither console exposes a page/form/layout/workflow *designer*. Super Admin configures the *platform*; Tenant Admin configures *their company's data + settings + which plan features are on*. Everything is structured config behind validated forms — never freeform canvas.
2. **Two distinct trust boundaries.** Super Admin operates above the tenant isolation line (`businessId`-scoped row-level security, see Sitepresso `backend/src/core/middleware/auth.middleware.js` → `requireSuperAdmin`). Tenant Admin operates strictly *inside* one `businessId`. Crossing that line (impersonation) is a privileged, fully-audited event.
3. **Effective-dated everything that touches money or law.** Plans, prices, promo codes, feature flags, and *especially* compliance rule tables are **versioned with `effectiveFrom` / `effectiveTo`** so a payroll run dated in March uses March's rules even if edited in June. No destructive edits to anything a past payslip depended on.
4. **RBAC-gated views, not just RBAC-gated APIs.** Every nav item, button, and column is gated by a permission key. The API re-checks; the UI never relies on the client for enforcement, only for hiding affordances.
5. **Reuse the Sitepresso admin shell.** Both consoles are built on `packages/admin-core` (panel registry + feature-flag filtering) and `packages/ui`. We fork, we do not greenfield.

---

## 1. Reuse map (grounded in Sitepresso, read-only)

| Capability | Sitepresso source (real path) | What we keep / change |
|---|---|---|
| Super-admin REST surface | `backend/src/superadmin/routes/admin.routes.js`, `backend/src/superadmin/controllers/admin.controller.js` (902 LOC) | Keep `listBusinesses`, `stats`, `dashboardAnalytics`, `businessAnalytics`, `toggleSuspend`, `deleteBusiness`, `getSettings`, `updateSetting`, `billingActivity`, `billingInvoice`. Rename "business" → "tenant" in UI copy. Add HR-specific endpoints (compliance console, seat metering). |
| Super-admin auth gate | `backend/src/core/middleware/auth.middleware.js` → `requireSuperAdmin = requireAnyRole([ROLES.SUPER_ADMIN])` | Reuse verbatim. Add `requireSupportAgent` sub-role (read-only + impersonate-with-reason). |
| Roles enum | `backend/src/core/lib/roles.js` (`SUPER_ADMIN / BUSINESS_ADMIN / STAFF / USER`) | Extend with platform sub-roles (§3.1) and tenant custom roles (§12). |
| Admin shell / panel registry | `packages/admin-core/index.d.ts` (`createPanelRegistry`, `filterPanelsForFeatures`, `requiredFeatures`) | Reuse as the nav + feature-flag engine for *both* consoles. Each screen = a `PanelDefinition` with `requiredFeatures`. |
| Plans / per-seat pricing | `schema.prisma` → `PricingTier`, `TierPrice` (`overageStaffPriceMinor`, `overageBranchPriceMinor`, per-gateway price IDs), `TierFeature`, `PricingZone`, `CountryZoneAssignment` | Reuse the entire pricing catalog model. `overageStaffPriceMinor` *is* our per-seat overage. Map zones → IN/NZ launch + RoW. |
| Promo codes | `schema.prisma` → `AdminCoupon`, `AdminCouponRedemption` (FREE_PERIOD / LIFETIME_FREE / PERCENT_OFF / FIXED_OFF; `allowedCountries`, `applicableTiers`, `maxTotalUses`, `maxPerUser`, `firstSubscriptionOnly`) | Reuse verbatim. This already covers our promo needs. |
| Pricing audit | `schema.prisma` → `PricingAuditLog` (`entityType`, `action ∈ {CREATED,UPDATED,DELETED,SYNCED}`, `oldValue`/`newValue` JSON) | Generalize into a platform-wide `AdminAuditLog` (§8). |
| Multi-gateway billing | `backend/src/core/lib/billing/gatewayRouter.js`, `billing/gateways/{stripeGateway,razorpayGateway,paddleGateway}.js`, `subscriptionInvoice.js`, `billingLedger.js`, `subscriptionMaterializer.js`, `billingPlanChangePolicy.js`, `billingChangePreview.js` | Reuse. Gateway routing by country: Razorpay (IN) / Stripe (NZ) / Paddle (RoW). |
| Webhook ledgers | `schema.prisma` → `PaddleWebhookEvent`, `StripeWebhookEvent`, `RazorpayWebhookEvent` | Reuse for idempotent gateway event handling + dunning triggers. |
| Feature catalog / entitlements | `backend/src/core/lib/featuresCatalog.js`, `entitlements.js`, `billingAccess.js` | Reuse; redefine the catalog with HR feature keys (§7). |
| Theming (slim to 5 styles) | `packages/theme-engine/profession-styles.mjs` (10 `STYLES`: light/dark/prestige/elegant/matte/minimal/bold/soft/editorial/tech), `theme-colors.mjs`, `layout-presets.cjs` | **Cut to exactly 5 fixed styles.** Recommend keeping `light, dark, elegant, bold, minimal`; delete the rest + all 60+ profession registries (`profession-registry.mjs`). Tenant branding = logo + 1 color + 1-of-5 + domain (§11). |
| Custom domain + SSL | `apps/router/cloudflare-worker.js`, `apps/router/index.js`, Cloudflare-for-SaaS | Reuse for white-label ESS domain binding (§11.4). |
| Impersonation seed | `backend/src/core/controllers/tenant.controller.js` (existing "impersonate one" admin path) | Harden into the full impersonation state machine (§4). |
| Support inbox | `support.controller.js` → `listPlatformForSuperadmin`, `replyPlatformForSuperadmin` (wired in `admin.routes.js`) | Reuse for platform support console (§9). |
| Admin UI app | `apps/platform/app/superadmin`, `app/(unified-admin)`, `components/admin-tabs`, `components/admin-modals` | Fork into the new `apps/hr` admin surface; reuse the unified-admin layout shell. |

---

# PART A — SUPER ADMIN (`admin.hr.com`)

The console *we* operate. Single global view across all tenants, all countries. Never `businessId`-scoped.

## 2. Information architecture (top-level nav)

| # | Section | Primary jobs | Min platform role |
|---|---|---|---|
| 1 | **Overview** | Platform KPIs, MRR/ARR, churn, active tenants, payroll-runs-this-cycle, system health | Analyst |
| 2 | **Tenants** | List/search, tenant 360, lifecycle (trial→active→past_due→suspended→churned), seat usage, impersonate | Support |
| 3 | **Plans & Pricing** | Tiers, per-seat + per-branch overage, INR/NZD/RoW prices, gateway price-ID sync | Billing Admin |
| 4 | **Promo Codes** | Create/lifecycle promo codes, redemption analytics | Billing Admin |
| 5 | **Billing & Revenue** | Invoices, ledger, dunning queue, refunds, gateway reconciliation, revenue reports | Billing Admin |
| 6 | **Gateways** | Razorpay/Stripe/Paddle credentials, routing rules, webhook health, MoR config | Owner |
| 7 | **Feature Flags** | Per-plan entitlements + per-tenant overrides + global kill-switches | Billing Admin (overrides: Owner) |
| 8 | **Compliance Rules** | Versioned per-country statutory tables (tax slabs, PF, ESI, PT, KiwiSaver, ACC, leave) | **Compliance Editor** (4-eyes publish) |
| 9 | **Analytics** | Cohorts, funnel, feature adoption, payroll volume, compliance-filing health | Analyst |
| 10 | **Support** | Platform support inbox, tenant notes, impersonation log | Support |
| 11 | **Audit** | Immutable platform audit trail (every privileged action) | Auditor (read), Owner |
| 12 | **Platform Settings** | Email/SMS senders, default locales, system banners, maintenance windows | Owner |

### 2.1 RBAC for the Super Admin console

Platform sub-roles layered on `ROLES.SUPER_ADMIN`. A platform user has exactly one platform role; permissions are additive by rank.

| Platform role | Can read | Can write | Can do privileged |
|---|---|---|---|
| **Owner** | all | all | gateway secrets, delete tenant, publish compliance, change platform roles |
| **Billing Admin** | all billing/pricing | plans, prices, promos, refunds ≤ cap, flags | issue refund up to per-role cap |
| **Compliance Editor** | compliance + tenants | draft/edit compliance versions | **propose** publish (needs Owner/2nd Editor approval) |
| **Support** | tenants, support, billing read | tenant notes, support replies | **impersonate (reason required, time-boxed)** |
| **Analyst** | analytics, overview | saved views only | — |
| **Auditor** | audit log, all read | nothing | export audit (watermarked) |

Every API enforces with `requireSuperAdmin` **plus** a fine-grained `requirePlatformPermission('compliance.publish')` middleware (new), checked against a `PlatformRolePermission` grant table (mirrors Sitepresso's `EcomRolePermissionGrant` pattern referenced in `auth.middleware.js`).

---

## 3. Tenants

### 3.1 Tenant list

- **Source:** fork of `listBusinesses` (`admin.controller.js:146`). Server-side pagination (`parsePageSize`, default 20, max 30 — we raise max to 100 for ops).
- **Columns:** Tenant name · country (IN/NZ flag) · plan tier · lifecycle status · seats (used / included / overage) · MRR (local + normalized to USD) · last payroll run · created · health badge.
- **Filters:** country, plan, status, gateway, "trial ending in N days", "past_due", "no payroll in 35 days" (churn-risk), "seats > 90% of included".
- **Bulk actions:** export CSV, send broadcast (via notifications), tag.
- **Search:** name, custom domain, owner email, tenant ID, GSTIN (IN) / NZBN (NZ).

### 3.2 Tenant lifecycle state machine

```
                 signup (wizard complete)
                          │
                          ▼
   ┌──────────┐  card added / first invoice paid  ┌─────────┐
   │  TRIAL   │ ────────────────────────────────► │ ACTIVE  │
   └────┬─────┘                                    └────┬────┘
        │ trial expires, no payment                     │ invoice fails (after retries)
        ▼                                                ▼
   ┌──────────┐                                    ┌──────────┐
   │ EXPIRED  │ ◄──── reactivate (pay) ──────────► │ PAST_DUE │
   └────┬─────┘                                    └────┬─────┘
        │ 30d no action                                 │ dunning exhausted
        ▼                                                ▼
   ┌───────────┐   manual / abuse        ┌────────────────────┐
   │  CHURNED  │ ◄────────────────────── │ SUSPENDED (locked) │ ◄── Owner/Support manual suspend
   └───────────┘                         └────────────────────┘
        │ 90d                                   │ reinstate (Owner)
        ▼                                       ▼ ACTIVE
   ┌────────────────────────┐
   │ PURGE_SCHEDULED → PURGED │  (GDPR/DPDP erase; payroll records retained per statutory minimum)
   └────────────────────────┘
```

**Critical edge case — payroll data retention vs. erase.** When a tenant churns/purges, *statutory payroll registers and payslips must be retained* (IN: digital wage/attendance registers + Form 16/24Q lineage; NZ: Holidays Act / IRD records min 7 years). So "purge" anonymizes marketing/PII not legally required, **but quarantines and retains** the statutory payroll dataset in cold storage with access locked to Owner + Auditor. This is a hard rule — never a soft "delete everything." Cross-ref `03-data-model.md` retention policy and `05/06-compliance-*` retention tables.

- Suspend/unsuspend reuses `toggleSuspend` (`admin.controller.js:772`). Delete reuses `deleteBusiness` (`:798`) but is rewired to *PURGE_SCHEDULED*, never immediate hard-delete.

### 3.3 Tenant 360 (drill-down)

Tabs: **Profile** (legal name, country, GSTIN/NZBN, registered address, IRD/EPFO/ESIC numbers), **Subscription** (tier, seats, billing cycle, next invoice, gateway), **Usage** (employees, payroll runs/mo, storage, API calls, SMS/WA — reuse `businessAnalytics` `:622`), **Billing** (invoices, ledger, refunds), **Feature overrides** (§7.3), **Compliance posture** (which IN/NZ modules enabled, last filing dates, overdue filings), **Support** (notes, tickets), **Audit** (tenant-scoped slice), **Danger zone** (suspend / impersonate / purge).

---

## 4. Impersonation (support access) — state machine + audit

Hardened from the existing `tenant.controller.js` impersonation seed.

### 4.1 Rules

- Only **Support / Owner** may impersonate. **Reason text is mandatory** (free text + category: `billing_issue / payroll_bug / onboarding_help / data_correction / abuse_review`).
- **Time-boxed:** session token TTL = 30 min, max 2h with re-justify. Auto-revoke on idle 10 min.
- **Scoped:** impersonation token carries `actAs: businessId`, `actor: platformUserId`, `mode ∈ {read_only, read_write}`. Default = `read_only`. `read_write` requires Owner approval *and* is blocked from: changing bank/payout details, running/finalizing payroll, exporting bulk PII, deleting employees.
- **Visible:** persistent red banner in the impersonated console: "⚠ Support session — {agent} acting as {tenant}. Reason: {x}. Ends {time}." Tenant Admins see an entry in *their* audit log too.
- Every action during impersonation is double-logged (platform audit + tenant audit) with `viaImpersonation: true`.

### 4.2 State machine

```
REQUESTED ──approve(reason,mode)──► ACTIVE ──action(s)──► ACTIVE
   │  (read_write needs Owner)          │  idle 10m / TTL / manual end
   │                                     ▼
   └── denied ──► CLOSED            ENDED ──(immutable session record)──► ARCHIVED
```

### 4.3 Data

```prisma
model ImpersonationSession {
  id            String   @id @default(uuid())
  actorUserId   String   // platform user
  businessId    String   // tenant impersonated
  mode          ImpersonationMode @default(READ_ONLY)
  reasonCategory String
  reasonText    String
  approvedById  String?  // for READ_WRITE
  startedAt     DateTime @default(now())
  endedAt       DateTime?
  endReason     String?  // MANUAL / TTL / IDLE / REVOKED
  actionCount   Int      @default(0)
  ipAddress     String?
  @@index([businessId, startedAt])
  @@index([actorUserId, startedAt])
}
enum ImpersonationMode { READ_ONLY READ_WRITE }
```

---

## 5. Plans & per-seat pricing

Built directly on the Sitepresso pricing catalog (`PricingTier`, `TierPrice`, `TierFeature`, `PricingZone`, `CountryZoneAssignment`, `PricingAuditLog`).

### 5.1 Tiers (launch proposal — founder to confirm numbers)

| Tier (slug) | Target | Included seats | Per-seat overage | Included branches | Key gating |
|---|---|---|---|---|---|
| `starter` | <25 emp, single entity | 10 | yes | 1 | core payroll, ESS, 1 country |
| `growth` | 25–150 emp | 25 | yes | 3 | + approval chains, integrations, multi-branch |
| `business` | 150–500 emp | 100 | yes | 10 | + advanced analytics, API, SSO |
| `enterprise` | 500+ / custom | custom | negotiated | unlimited | + dedicated, custom roles, audit export, SLA |

> **Pricing model = per active employee/seat.** `TierPrice.overageStaffPriceMinor` is the per-seat overage charge; `overageBranchPriceMinor` the per-branch overage. "Active seat" = employee in `ACTIVE`/`ON_LEAVE` status who appears in at least one finalized payroll run in the billing month (definition lives in `04-payroll-engine-design.md`; metering job emits monthly `SeatUsage` rows).

### 5.2 Currency / zone mapping

- `PricingZone` + `CountryZoneAssignment`: IN → INR zone, NZ → NZD zone, everyone else → RoW (USD via Paddle).
- `TierPrice` is `(tierId, countryCode)` scoped with `amountMonthlyMinor`, `amountAnnualMinor`, `overageStaffPriceMinor`, per-gateway price IDs (`razorpayPlanIdMonthly/Annual`, `stripePriceIdMonthly/Annual`, `paddlePriceIdMonthly/Annual`).
- **Annual discount** modeled as a distinct `amountAnnualMinor` (not a runtime %), so invoices are exact.

### 5.3 Plan editor flow + gateway sync

```
Edit price (draft) ──validate──► Preview impact (current subs on this tier/country)
   ──► Save (writes PricingAuditLog: UPDATED, old/new) ──► "Sync to gateways"
   ──► push to Razorpay/Stripe/Paddle, set lastSyncedToPaddleAt + per-gateway IDs
   ──► PricingAuditLog: SYNCED
```

**Edge cases:** (a) price change **never** retroactively re-bills existing subscribers — it applies at next renewal (policy from `billingPlanChangePolicy.js`); (b) lowering included seats can't strand a tenant — overage simply starts higher; we warn and require confirm; (c) deleting a tier is soft (`isActive=false`) and blocked if any active sub references it.

### 5.4 Seat metering & proration

- Monthly job computes peak/average active seats per tenant; overage = `max(0, seats − includedSeats) × overageStaffPriceMinor`.
- Mid-cycle seat adds are prorated to renewal via `billingChangePreview.js`. Removals never refund within cycle (credited next cycle).
- Validation: seat count can't drop below "employees with unfinalized current-cycle payroll" — protects in-flight runs.

---

## 6. Promo codes

Reuse `AdminCoupon` / `AdminCouponRedemption` **verbatim** — the schema already models everything we need.

### 6.1 Capabilities (from existing model)

| Field | Use |
|---|---|
| `benefitType` | `FREE_PERIOD` (N days/months free), `LIFETIME_FREE`, `PERCENT_OFF`, `FIXED_OFF` |
| `benefitValue` + `benefitUnit` (`DAYS/MONTHS/CYCLES`) + `benefitCurrency` | benefit magnitude |
| `allowedCountries[]` | restrict to IN / NZ |
| `applicableTiers[]` | restrict to specific `PricingTier.slug`s |
| `allowedEmails[]`, `allowedBusinessIds[]` | targeted/private codes |
| `validFrom`/`validUntil`, `maxTotalUses`, `maxPerUser`, `firstSubscriptionOnly` | lifecycle + abuse limits |
| `paddleDiscountId`/`paddleDiscountStatus` | gateway-side discount object (PERCENT/FIXED need gateway) |
| `AdminCouponRedemption.benefitSnapshot` | immutable snapshot at redemption (audit-safe) |

### 6.2 Promo lifecycle

```
DRAFT ──activate──► ACTIVE ──(redemptions, usedCount++)──► ACTIVE
  │                    │ validUntil passed / maxTotalUses hit
  │                    ▼
  └── never published   EXPIRED / EXHAUSTED  ──(read-only, redemptions preserved)
ACTIVE ──pause(isActive=false)──► PAUSED ──resume──► ACTIVE
```

**Validation at redemption:** country ∈ allowed, tier ∈ applicable, email/businessId allowed, within window, `usedCount < maxTotalUses`, per-user `@@unique([couponId, businessId])` enforces `maxPerUser=1` default, `firstSubscriptionOnly` ⇒ tenant has no prior paid sub. PERCENT/FIXED require a synced `paddleDiscountId` before activation.

### 6.3 Analytics

Redemptions by code/country/tier, conversion (redeemed→paid retained at 30/90d), revenue impact (discount given vs. LTV), abuse flags (same card/IP across business IDs).

---

## 7. Feature flags by plan

Built on `featuresCatalog.js` + `entitlements.js` + `TierFeature` (BOOLEAN / NUMERIC / UNLIMITED) + `admin-core` `requiredFeatures` panel filtering.

### 7.1 HR feature catalog (proposed keys)

| Key | Type | Meaning |
|---|---|---|
| `payroll.core` | BOOLEAN | run payroll |
| `payroll.multi_country` | BOOLEAN | IN + NZ in one tenant |
| `payroll.india.module` / `payroll.nz.module` | BOOLEAN | enable country compliance engine |
| `hr.approval_chains` | BOOLEAN | configurable approval workflows |
| `hr.org_branches` | NUMERIC | max branches/entities |
| `hr.custom_roles` | BOOLEAN | tenant-defined roles |
| `ess.mobile` | BOOLEAN | mobile ESS |
| `integrations.accounting` | BOOLEAN | Xero/Tally/QuickBooks |
| `integrations.sso` | BOOLEAN | SAML/OIDC |
| `analytics.advanced` | BOOLEAN | cohort/headcount analytics |
| `api.access` | BOOLEAN | public API + webhooks |
| `whitelabel.domain` | BOOLEAN | custom ESS domain |
| `branding.styles` | NUMERIC | # of the 5 styles available (default all 5) |
| `audit.export` | BOOLEAN | tenant audit export |
| `limits.employees` | NUMERIC/UNLIMITED | hard cap |
| `limits.api_calls_month` | NUMERIC | rate budget |

### 7.2 Three-layer resolution

```
Effective(feature) =
   tenant_override  (if set, not expired)        ← per-tenant
   else plan_default (TierFeature for tenant tier)← per-plan
   else catalog_default (featuresCatalog)         ← global
   AND global_killswitch == on                    ← platform-wide override (incident control)
```

`entitlements.js` resolves at request time; `admin-core.filterPanelsForFeatures` hides nav for off features. Compliance/statutory features (IN/NZ modules) **cannot** be flag-disabled mid-cycle if a payroll run depends on them — guarded.

### 7.3 Per-tenant override editor

Table of every feature key × {plan default, override, expiry, reason}. Used for sales exceptions ("give this enterprise lead SSO for 30 days"). Writes audit. Overrides require Owner for `limits.*` and statutory modules.

### 7.4 Global kill-switch

Platform-wide on/off per feature for incident response (e.g., disable `integrations.accounting` if Xero API breaks). Banner notifies affected tenants. Owner-only, audited, time-boxed.

---

## 8. Compliance Rules console (FLAGSHIP — versioned per-country statutory tables)

This is the highest-stakes Super Admin surface. It is the **single source of truth** for every statutory number the payroll engine reads. Wrong data here = wrong pay for every tenant in that country. Design accordingly: **versioned, effective-dated, 4-eyes published, fully audited, never destructive.**

### 8.1 Core model — versioned rule sets

```prisma
model ComplianceRuleSet {
  id            String   @id @default(uuid())
  country       String   // "IN" | "NZ"
  domain        ComplianceDomain   // INCOME_TAX | PF | ESI | PT | KIWISAVER | ACC | LEAVE | GRATUITY | MIN_WAGE | ESCT | STUDENT_LOAN
  region        String?  // state code for PT (e.g. "MH","KA"); null = national
  version       Int      // monotonic per (country,domain,region)
  effectiveFrom DateTime // statutory effective date (e.g. 2026-04-01)
  effectiveTo   DateTime? // null = open-ended; set when superseded
  status        RuleStatus @default(DRAFT) // DRAFT | IN_REVIEW | PUBLISHED | SUPERSEDED | ARCHIVED
  payload       Json     // the actual slabs/rates (typed per domain, schema-validated)
  sourceUrl     String?  // statutory citation (IRD/EPFO/CBDT/gazette)
  notes         String?
  createdById   String
  reviewedById  String?  // 4-eyes
  publishedById String?
  publishedAt   DateTime?
  createdAt     DateTime @default(now())
  @@unique([country, domain, region, version])
  @@index([country, domain, region, status, effectiveFrom])
}
enum ComplianceDomain { INCOME_TAX PF ESI PT KIWISAVER ACC LEAVE GRATUITY MIN_WAGE ESCT STUDENT_LOAN EDLI }
enum RuleStatus { DRAFT IN_REVIEW PUBLISHED SUPERSEDED ARCHIVED }
```

**Resolution at payroll time:** for a payslip dated `D`, the engine selects the row where `status=PUBLISHED AND effectiveFrom <= D AND (effectiveTo IS NULL OR effectiveTo > D)` for each `(country, domain, region)`. This guarantees a March run uses March rules even after a June edit. Every payslip stamps the `ComplianceRuleSet.id`s it consumed (lineage), so a payslip is always reproducible. Cross-ref `04-payroll-engine-design.md` §"rule resolution".

### 8.2 Publish state machine (4-eyes)

```
DRAFT ──submit──► IN_REVIEW ──reject──► DRAFT
                      │ approve (different user; Owner or 2nd Compliance Editor)
                      ▼
                  PUBLISHED  ──(auto: set effectiveTo on prior version)──► (prior) SUPERSEDED
PUBLISHED ──supersede by newer version──► SUPERSEDED ──retain forever──► ARCHIVED (view-only)
```

- **No edits to PUBLISHED rows.** A correction = new version with a new `effectiveFrom` (or a back-dated version + flagged "correction" if a published rule was wrong — triggers an impact report of affected payslips). Never mutate history.
- **4-eyes:** `createdById != reviewedById`. Publish writes `AdminAuditLog`.
- **Dry-run diff:** before publish, show a diff of `payload` vs current published, and "tenants/employees affected" + sample recomputed payslips.

### 8.3 Domain payloads with **2026-accurate** seed values

All figures verified via WebSearch June 2026 (sources in §13). These ship as the initial PUBLISHED versions.

#### India (`country=IN`), tax year Apr–Mar

**`INCOME_TAX` — New regime (DEFAULT), FY 2026-27 (effectiveFrom 2026-04-01).** No slab change vs FY2025-26.
| Slab (taxable ₹) | Rate |
|---|---|
| 0 – 4,00,000 | 0% |
| 4,00,001 – 8,00,000 | 5% |
| 8,00,001 – 12,00,000 | 10% |
| 12,00,001 – 16,00,000 | 15% |
| 16,00,001 – 20,00,000 | 20% |
| 20,00,001 – 24,00,000 | 25% |
| > 24,00,000 | 30% |

- **Standard deduction:** ₹75,000 (salaried, new regime).
- **§87A rebate:** up to ₹60,000 ⇒ **nil tax for taxable income ≤ ₹12,00,000**; combined with standard deduction ⇒ effective tax-free gross ≈ **₹12,75,000** for salaried.
- **Old regime:** opt-in only; 87A rebate threshold ₹5,00,000 (₹12,500). Payload carries both regimes + `cess` 4% (Health & Education) + surcharge table.

**`PF` (EPFO).** Employee 12% + employer 12% of "PF wages"; employer split: **EPS 8.33%** (capped at ₹15,000 wage ⇒ max ₹1,250), **EPF 3.67%**, plus **EDLI** + admin charges. Mandatory at **20+ employees**. *Labour Codes (live 21 Nov 2025):* uniform "wages" definition ⇒ **Basic+DA ≥ 50% of total remuneration** — payload includes the wage-recharacterization rule that cascades into PF & gratuity. (Engine logic in `04-...`; numbers live here.)

**`ESI` (ESIC).** Employee **0.75%** + employer **3.25%** of gross, when gross ≤ **₹21,000/month**. Mandatory at **10 employees** (state-variant thresholds in `region`).

**`PT` (Professional Tax) — STATE-specific, `region` per state**, annual cap **₹2,500**. Seed Maharashtra/Karnataka/WB/TN etc. as separate region rule sets (e.g., MH: ₹200/mo, ₹300 in Feb).

**`GRATUITY`.** `15/26 × last-drawn-wages × completed years`; "wages" per Labour Code uniform definition.

#### New Zealand (`country=NZ`), tax year Apr–Mar

**`KIWISAVER` (effectiveFrom 2026-04-01).** Default minimum **3.5%** employee + **3.5%** employer (up from 3%); rising to 4% in 2028 (future version pre-staged with effectiveFrom 2028-04-01). **16–17-year-olds now eligible for employer contributions** at 3.5% from 1 Apr 2026. Payload includes opt-out, contribution-holiday/temporary-rate-reduction (3–12 months) flags.

**`ACC` earners' levy (effectiveFrom 2026-04-01).** Rate **1.75%** (was 1.67%) on liable earnings up to **$156,641** (was $152,790) ⇒ **max levy $2,741.22**.

**`MIN_WAGE` (effectiveFrom 2026-04-01).** Adult **$23.95/hr** (was $23.50); starting-out & training **$19.16/hr** (80%).

**`ESCT`.** Tiered employer-contribution tax on employer KiwiSaver contributions (rate by employee's prior-year total remuneration). Bands stored in payload.

**`STUDENT_LOAN`.** Standard deduction rate 12% above the pay-period repayment threshold; threshold in payload.

**`LEAVE` (Holidays Act 2003) — the hardest, highest-value NZ calc (flagship).** This payload encodes the *parameters* (not the algorithm — algorithm in `06-compliance-newzealand.md`): annual leave **4 weeks measured in weeks**, the Relevant-Daily-Pay (RDP) vs Average-Daily-Pay (ADP) selection rule, 8% pay-as-you-go for casuals, alternative/lieu days for public holidays worked on an otherwise-working-day, sick leave (10 days), bereavement, public-holiday list (with regional anniversary days via `region`). Public-holiday dates are themselves effective-dated rule rows.

### 8.4 Editor UX

- **Per (country, domain, region)** timeline view: a horizontal band of versions colored by status; click to inspect/diff.
- **Typed forms per domain** (slab grid for tax, rate inputs for PF/ESI/KiwiSaver/ACC, holiday calendar editor for LEAVE). JSON Schema validation rejects malformed payloads (e.g., overlapping slabs, gaps, rate >100%).
- **Mandatory `sourceUrl`** (statutory citation) + `effectiveFrom` (must be ≥ today unless flagged "back-dated correction" → Owner approval + impact report).
- **Overlap guard:** publishing a version auto-closes the prior version's `effectiveTo`; the system forbids two PUBLISHED rows whose date ranges overlap for the same key.
- **Impact preview:** "X tenants, Y employees, Z draft runs affected" + sample recomputed payslips before publish.

---

## 9. Billing, revenue & dunning

Reuse `subscriptionInvoice.js`, `billingLedger.js`, `subscriptionMaterializer.js`, `billingActivity`/`billingInvoice` controllers, webhook ledgers.

- **Invoices & ledger:** searchable across tenants; per-invoice gateway, status, taxes (IN GST self-billed via `gstReport.controller.js` → GSTR-1 export already exists; reuse for our own MoR invoices).
- **Dunning queue:** tenants in `PAST_DUE`. Retry schedule (e.g., day 1/3/5/7), dunning emails (notifications service), then auto-`SUSPENDED`. Gateway webhook events (`*WebhookEvent` tables) drive transitions idempotently.
- **Refunds:** role-capped; writes ledger + audit; partial/full; reason required.
- **Reconciliation:** match gateway payouts vs ledger; surface mismatches.
- **Revenue reports:** MRR/ARR, by tier/country/gateway, expansion (seat growth) vs contraction, net revenue retention, churn $.

---

## 10. Analytics & 11/12 (Audit, Platform Settings)

### Analytics
Forks `dashboardAnalytics` (`:472`) + `businessAnalytics` (`:622`). Boards: growth (signups→trial→paid funnel), retention cohorts, **payroll volume** (runs, employees paid, $ disbursed by country), **compliance health** (overdue IN 24Q/TDS/PF/ESIC filings, NZ payday-filing lateness), feature adoption, support load.

---

## 8/11. Audit (platform-wide, immutable)

Generalize `PricingAuditLog` into one append-only `AdminAuditLog`.

```prisma
model AdminAuditLog {
  id          String   @id @default(uuid())
  actorUserId String?  // platform user; null for system
  actorRole   String?
  businessId  String?  // tenant context if any
  category    String   // TENANT|PRICING|PROMO|FLAG|COMPLIANCE|BILLING|IMPERSONATION|GATEWAY|AUTH|SETTINGS
  action      String   // CREATED|UPDATED|DELETED|PUBLISHED|SYNCED|SUSPENDED|REFUNDED|IMPERSONATE_START...
  entityType  String
  entityId    String?
  oldValue    Json?
  newValue    Json?
  reason      String?
  viaImpersonation Boolean @default(false)
  ipAddress   String?
  createdAt   DateTime @default(now())
  @@index([category, createdAt])
  @@index([businessId, createdAt])
  @@index([actorUserId, createdAt])
}
```

Append-only (no update/delete; enforced at DB grant + app layer). Auditor role can export watermarked CSV/JSON. Every privileged action in §3–9, 12 writes here.

### Platform Settings
Email/SMS senders, default locales (en/hi reused from i18n; add en-NZ), system banners, maintenance windows, gateway routing defaults, data-residency notes (IN data in-region). Owner-only.

---

# PART B — TENANT ADMIN / HR CONSOLE (`app.hr.com`)

The employer's HR/Finance team configures and runs HR + payroll, strictly within one `businessId`. Built on the same `admin-core` shell; nav filtered by plan feature flags (§7).

## 13. HR console — information architecture

| Group | Screens | Gating feature |
|---|---|---|
| **Dashboard** | Headcount, payroll-run status, pending approvals, compliance calendar (next filing due), alerts | core |
| **People** | Employees (list/profile/lifecycle), onboarding, offboarding, org chart, branches/entities, departments, job grades | core / `hr.org_branches` |
| **Time & Attendance** | Attendance, shifts/rosters, leave types, leave balances & requests, holiday calendars (IN/NZ) | core |
| **Payroll** | Pay schedules, run wizard, components (earnings/deductions), payslips, statutory outputs (PF/ESI/PT/TDS · KiwiSaver/PAYE/ACC), bank/payout files | `payroll.core`, country modules |
| **Compliance** | IN: Form 24Q, Form 16, PF/ESIC challans, PT returns · NZ: payday filing, IR348-equivalent, KiwiSaver schedules — *read/generate only; rates come from Super Admin §8* | country modules |
| **Finance** | Reimbursements, loans/advances, accounting export (Xero/Tally/QuickBooks) | `integrations.accounting` |
| **Reports** | Registers (digital wage/attendance — IN statutory), headcount, cost-to-company, leave liability (NZ Holidays Act), custom saved views | core / `analytics.advanced` |
| **Settings** | Company profile, branding, roles & permissions, approval chains, pay-cycle config, integrations, ESS/domain, notifications, audit | core (sub-gated) |

The nav is a set of `admin-core` `PanelDefinition`s with `requiredFeatures`; `filterPanelsForFeatures` hides what the plan/overrides don't grant. Statutory screens for a country only appear if that country module is enabled and the tenant operates there.

## 14. Tenant settings — Branding (CORE PRINCIPLE enforced)

Branding is **deliberately minimal — configure, never design.** Exactly four controls:

| Control | Allowed | Stored | Backed by |
|---|---|---|---|
| **Logo** | one image (PNG/SVG, size/dimension validated) | `business.logoUrl` | existing asset pipeline |
| **Brand color** | **one** hex color (contrast-checked for accessibility) | `business.brandColor` | `theme-engine/theme-colors.mjs` derives the palette |
| **Style** | **1 of exactly 5 fixed styles** (`light, dark, elegant, bold, minimal`) | `business.styleId` | slimmed `theme-engine/profession-styles.mjs` (cut from 10→5; delete prestige/matte/soft/editorial/tech + all profession registries) |
| **Custom domain** | **one** bound ESS domain | `business.customDomain` | `apps/router/cloudflare-worker.js` + Cloudflare-for-SaaS SSL |

No fonts, layouts, components, CSS, page sections, or per-screen theming are exposed. The 5 styles are the *entire* visual surface. Live preview of the ESS portal with chosen logo/color/style. Branding edits are gated `whitelabel.domain` for the domain piece; logo+color+style available to all tiers (`branding.styles` may limit count below 5 for low tiers — founder decision).

### 14.4 Custom domain binding flow

```
Enter domain ──► system creates CNAME/TXT target ──► tenant adds DNS
   ──► poll Cloudflare-for-SaaS hostname status ──► SSL issued ──► VERIFIED/LIVE
   (states: PENDING_DNS → VERIFYING → SSL_PENDING → LIVE → ERROR(retry))
```
Reuses the exact Sitepresso custom-domain machinery. ESS then serves at `tenant.com` / `tenant.hr.com`.

## 15. Tenant settings — Roles & permissions UI

Reuses Sitepresso's per-tenant custom-role pattern (`EcomRolePermissionGrant` referenced in `auth.middleware.js:312-361`), generalized to HR.

- **System roles (always present):** `Owner` (full), `HR Admin`, `Payroll Admin`, `Manager` (team-scoped approvals), `Employee` (ESS only), `Read-Only/Auditor`.
- **Custom roles** (gated `hr.custom_roles`): name + a permission matrix over keys grouped by module — `people.*`, `payroll.run`, `payroll.finalize`, `payroll.view_salary`, `leave.approve`, `reports.view`, `settings.branding`, `settings.roles`, `integrations.manage`, `compliance.generate`, `audit.view`.
- **Scoping:** permissions can be `all | own_branch | own_team` (data-scope dimension), so a Manager sees only their team. Enforced server-side per `businessId` + scope (mirrors Sitepresso's role-grant resolution).
- **Guardrails:** can't remove the last Owner; `payroll.finalize` and bank-detail edit are "sensitive" (optionally require 2FA step-up); a role can't grant a permission the grantor lacks.
- **UI:** matrix grid (role × permission), inline scope dropdowns, "compare roles" view, audit on every change.

## 16. Tenant settings — Approval-chain config (gated `hr.approval_chains`)

Configurable (not buildable) approval workflows for: **leave requests, payroll run finalization, reimbursement claims, salary revisions, employee offboarding, loan/advance**.

```prisma
model ApprovalChain {
  id          String  @id @default(uuid())
  businessId  String
  type        ApprovalType  // LEAVE|PAYROLL_RUN|REIMBURSEMENT|SALARY_CHANGE|OFFBOARDING|LOAN
  name        String
  isActive    Boolean @default(true)
  steps       ApprovalStep[]
  @@index([businessId, type])
}
model ApprovalStep {
  id            String  @id @default(uuid())
  chainId       String
  order         Int
  approverType  ApproverType  // REPORTING_MANAGER | ROLE | SPECIFIC_USER | ANY_OF
  roleId        String?
  userId        String?
  condition     Json?   // e.g. {amount: {gt: 50000}} or {leaveDays: {gt: 5}}
  slaHours      Int?
  onTimeout     String? // ESCALATE | AUTO_APPROVE | AUTO_REJECT
  @@unique([chainId, order])
}
enum ApprovalType { LEAVE PAYROLL_RUN REIMBURSEMENT SALARY_CHANGE OFFBOARDING LOAN }
enum ApproverType { REPORTING_MANAGER ROLE SPECIFIC_USER ANY_OF }
```

- **Sequential or parallel** steps; conditional routing (e.g., reimbursement > ₹50,000 / NZ$1,000 adds a Finance step).
- **State machine per request:** `SUBMITTED → STEP_n_PENDING → (APPROVED|REJECTED|ESCALATED|AUTO_*) → FINAL_APPROVED|REJECTED → applied`.
- **Edge cases:** approver is the requester (auto-skip or block), approver inactive (escalate to manager), SLA breach (escalate/auto per `onTimeout`), chain edited mid-flight (in-flight requests pinned to the chain version they started on — versioned like compliance), circular reporting line (cycle detection).
- **Payroll finalize gate:** PAYROLL_RUN chain blocks finalization until approved; ties into `04-payroll-engine-design.md` run state machine.

## 17. Tenant settings — Integrations

| Integration | Type | Gating |
|---|---|---|
| **Accounting** — Xero (NZ), Tally/QuickBooks (IN) | journal/payroll export, chart-of-accounts mapping | `integrations.accounting` |
| **SSO** — SAML 2.0 / OIDC (Google, Microsoft Entra) | tenant IdP for HR users + ESS | `integrations.sso` |
| **Bank/payout files** | IN: NEFT/RTGS/bank-format; NZ: bank batch file | core |
| **Statutory portals** | IN: EPFO/ESIC/TRACES challan formats; NZ: IRD payday-filing (within **2 working days** of payday) | country modules |
| **Public API + webhooks** | REST + signed webhooks for HRIS sync | `api.access` |
| **Notifications** | email/SMS/WhatsApp sender identity | core (reuses Sitepresso multi-channel) |

Each integration: connect (OAuth/credentials) → field mapping → test → enable; status + last-sync surfaced; credential changes audited. Integrations never expose raw config beyond mapping — configure, not build.

## 18. Tenant audit & RBAC-gated views

- **Tenant audit log** (gated `audit.view`, export gated `audit.export`): every config change, payroll finalize, approval decision, role change, impersonation-by-support entry. Same append-only `AdminAuditLog` model, filtered to `businessId`.
- **RBAC gating is end-to-end:** nav (admin-core feature+permission filter), screen (route guard), component (button/column visibility), API (`requireBusiness` + permission grant + data scope). A Manager opening Payroll sees their team's costs but not the run wizard; an Auditor sees everything read-only with no mutating affordances rendered.

---

## 19. Cross-cutting: API surface (representative)

| Method | Path | Console | Guard |
|---|---|---|---|
| GET | `/api/admin/tenants` | Super | `requireSuperAdmin` + `tenant.read` |
| PUT | `/api/admin/tenants/:id/suspend` | Super | `tenant.suspend` |
| POST | `/api/admin/tenants/:id/impersonate` | Super | `tenant.impersonate` (+reason) |
| GET/PUT | `/api/admin/pricing/tiers[/:id]` | Super | `pricing.write` |
| POST | `/api/admin/pricing/:id/sync` | Super | `pricing.sync` |
| GET/POST | `/api/admin/promos` | Super | `promo.write` |
| GET/PUT | `/api/admin/flags` | Super | `flags.write` |
| GET/POST | `/api/admin/compliance/rulesets` | Super | `compliance.edit` |
| POST | `/api/admin/compliance/rulesets/:id/publish` | Super | `compliance.publish` (4-eyes) |
| GET | `/api/admin/billing/invoices` | Super | `billing.read` |
| POST | `/api/admin/billing/refunds` | Super | `billing.refund` (capped) |
| GET | `/api/admin/audit` | Super | `audit.read` |
| GET/PUT | `/api/hr/settings/branding` | Tenant | `requireBusiness` + `settings.branding` |
| GET/PUT | `/api/hr/settings/roles` | Tenant | `settings.roles` |
| GET/POST | `/api/hr/settings/approval-chains` | Tenant | `settings.approvals` |
| GET/POST | `/api/hr/settings/integrations` | Tenant | `integrations.manage` |

All tenant routes carry `businessId` row-level isolation (JWT-derived, never client-supplied) per `auth.middleware.js`.

---

## 20. Open questions for the founder

See StructuredOutput. Key ones: exact launch prices per tier (INR/NZD), whether `branding.styles` count is gated by tier, refund caps per platform role, and whether `payroll.finalize` requires mandatory 2FA step-up.

---

## 13. Sources (compliance verification, June 2026)

- KiwiSaver 3%→3.5% from 1 Apr 2026; employer match for 16–17 yo — [IRD KiwiSaver changes](https://www.ird.govt.nz/kiwisaver-changes), [Booster](https://www.booster.co.nz/blog/kiwisaver-contribution-rates), [Generate Wealth](https://www.generatewealth.co.nz/article/kiwisaver-changes-for-16-and-17-year-olds-what-it-means-from-april-2026/)
- ACC earners' levy 1.75%, cap $156,641, max $2,741.22 (from 1.67%/$152,790) — [IRD ACC levy rates](https://www.ird.govt.nz/income-tax/income-tax-for-individuals/acc-clients-and-carers/acc-earners-levy-rates), [NZTaxTools](https://nztax.tools/tax-insights/acc-earner-levy-2026-27/), [Calculate.co.nz](https://www.calculate.co.nz/reference/nz-acc-levy-rates.php)
- NZ adult minimum wage $23.95/hr, starting-out/training $19.16, from 1 Apr 2026 — [MBIE](https://www.mbie.govt.nz/about/news/minimum-wage-set-for-2026), [Employment NZ](https://www.employment.govt.nz/news-and-updates/minimum-wage-is-increasing-on-1-april-2026)
- IN new regime default FY2026-27, no slab change, §87A rebate up to ₹60,000 (nil ≤ ₹12L taxable), ₹75,000 standard deduction (≈₹12.75L effective) — [ClearTax slabs](https://cleartax.in/s/income-tax-slabs), [CAclubindia FY26-27 deductions](https://www.caclubindia.com/articles/deductions-allowed-to-salaried-individuals-under-new-tax-regime-for-fy-202627-54941.asp), [Income Tax Dept](https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1)
- IN EPF/ESI/PT/gratuity rates & Labour Code wage definition (Basic+DA ≥ 50%) per project brief KEY 2026 COMPLIANCE FACTS; engine detail in `05-compliance-india.md`.

# 17 — Reuse Map: Sitepresso → HRMS Platform

**Document owner:** Senior Architect (Reuse)
**Status:** Production design — definitive fork-and-strip plan
**Last updated:** 2026-06-22
**Source base (READ-ONLY):** `/Users/kp/sitepresso` (Turborepo · Next.js 14 · Node/Express · Prisma/PostgreSQL · Redis · Cloudflare-for-SaaS)
**Cross-references:** `02-system-architecture.md`, `03-data-model.md`, `04-payroll-engine-design.md`, `05-compliance-india.md`, `06-compliance-newzealand.md`, `12-admin-consoles.md`

---

## 0. How to read this document

Every Sitepresso component carries one of four verdicts:

| Verdict | Meaning | Effort signature |
|---|---|---|
| **REUSE-AS-IS** | Copy the file/package essentially verbatim; rename strings only. | Hours. |
| **ADAPT** | Fork the file, keep its shape and contracts, rewire the domain logic. | Days. |
| **DELETE** | Remove entirely; no HR analogue. | Minutes (rm + import sweep). |
| **BUILD-NEW** | No usable source; design from `03`–`11`. | Weeks. The bulk of the project. |

The platform's load-bearing reuse thesis is correct and grounded: Sitepresso already ships **(a)** a multi-tenant row-level isolation model (`businessId` on every model), **(b)** a dual operator/customer JWT auth stack that maps 1:1 onto Tenant-Admin/Employee surfaces, **(c)** a country-routed multi-gateway billing engine that *already hardcodes IN→Razorpay/INR and NZ→Stripe/NZD*, **(d)** a feature-flag + plan-tier + per-seat subscription system, **(e)** a tenant-resolution reverse proxy with Cloudflare custom-domain + SSL, and **(f)** a panel-registry admin shell with feature-gated navigation. The HR build reuses all six and replaces only the **vertical domain** (booking/shop/web → HR/payroll).

> **The single most important reuse fact**, grounded in `backend/src/core/lib/billing/gatewayRouter.js` lines 29–38:
> ```js
> const COUNTRY_GATEWAY = Object.freeze({ IN: GATEWAYS.RAZORPAY, NZ: GATEWAYS.STRIPE });
> const GATEWAY_FIXED_CURRENCY = Object.freeze({ [RAZORPAY]: 'INR', [STRIPE]: 'NZD' });
> ```
> Our two launch markets are *already the two special-cased countries* in the existing billing router. This is the strongest single argument for forking Sitepresso rather than greenfielding.

---

## 1. Repo-level map (Turborepo)

### 1.1 `apps/` verdicts

| App | Path | Verdict | Notes |
|---|---|---|---|
| `router` | `apps/router/index.js` (838 LOC), `cloudflare-worker.js` (483 LOC) | **ADAPT** | Tenant-resolution reverse proxy. Reuse host→tenant lookup, microcache, asset-prefix routing, reserved-subdomain set. Re-map vertical port table to HR sub-apps. §3. |
| `platform` | `apps/platform/**` | **ADAPT (split)** | This single Next.js app currently hosts *four* logical surfaces (marketing, signup/onboarding, super-admin `/superadmin`, unified tenant admin `(unified-admin)`). We keep marketing + onboarding + super-admin here (becomes `hr.com` + `admin.hr.com`), and extract tenant-admin into the new `apps/hr-admin`. §4. |
| `web` | `apps/web` + `backend/src/web` | **DELETE** | Website/page-builder vertical. No HR analogue. |
| `shop` | `apps/shop` + `backend/src/shop` | **DELETE** | E-commerce vertical. *Mine before deleting* — its EcomRolePermissionGrant relational-RBAC pattern is the template for HR's granular permissions (§6.3). |
| `booking` | `apps/booking` + `backend/src/booking` | **DELETE** | Appointment vertical. *Mine before deleting* — `StaffSchedule`, `StaffLeave`, `BusinessHours`, `BusinessHoliday` models are direct ancestors of HR work-schedule/leave/holiday-calendar (§5.4). |
| `chat-*`, `aapkarider-*`, `qa-portal` | `apps/chat-*`, `apps/aapkarider-*`, `apps/qa-portal` | **DELETE** | Unrelated products (live chat, rider logistics, QA tooling). |
| **(new)** `hr-admin` | `apps/hr-admin` | **BUILD-NEW** | Tenant HR/Finance console (`app.hr.com`). Forks the `(unified-admin)` shell + admin-core panel registry. §4.3. |
| **(new)** `ess` | `apps/ess` | **BUILD-NEW** | White-labeled Employee Self-Service (`tenant.com` / `tenant.hr.com`). Forks the booking `customer` sub-app shell + customer JWT session. §4.4. |
| **(new)** `hr-mobile` | `apps/hr-mobile` | **BUILD-NEW** | React-Native/Expo ESS app. See `11-ess-and-mobile.md`. Reuses the customer-auth + notification packages only. |

### 1.2 `packages/` verdicts

| Package | Path | Verdict | Notes |
|---|---|---|---|
| `ui` | `packages/ui/{index.js,admin.js}` | **REUSE-AS-IS** | Design system (`@sitepresso/ui` → `@hr/ui`). Buttons, inputs, modal, table, combobox, toasts. §7.1. |
| `admin-core` | `packages/admin-core/index.js` (76 LOC) | **REUSE-AS-IS** | Panel registry + feature-flag filter (`filterPanelsForFeatures`, `createPanelRegistry`). The exact mechanism we need for plan-gated HR nav. §6.1. |
| `theme-engine` | `packages/theme-engine/**` | **ADAPT (slim)** | Theme contract/compose/registry is reusable; *delete* the 60+ profession registry (`profession-styles.mjs`, `profession-registry.mjs`) and reduce to 5 fixed styles. §8. |
| `types` | `packages/types/{index.js,index.d.ts}` | **ADAPT** | `VERTICALS`, `THEME_MODES`, `SLOT_GROUPS` enums. Replace vertical enum with HR-only; keep theme contract types. |
| `blog-ui`, `ecom-ui`, `chat-*`, `aapkarider-shared` | `packages/{blog-ui,ecom-ui,chat-*,aapkarider-shared}` | **DELETE** | Vertical-specific UI. |

### 1.3 `backend/src/` verdicts

| Module | Path | Verdict | Notes |
|---|---|---|---|
| `core` | `backend/src/core/**` | **ADAPT (keep ~70%)** | Auth, RBAC, billing, subscriptions, notifications, uploads, i18n, prisma client, support/impersonate. The keep/cut breakdown is §2 + §5. |
| `superadmin` | `backend/src/superadmin/**` | **ADAPT** | Super-admin controller/routes (`admin.routes.js`). Keep tenant CRUD/suspend/stats/billing/impersonate; replace `gstReport.controller.js` with HR-specific platform reports. §6.2. |
| `domains` | `backend/src/domains/**` | **ADAPT** | Custom-domain provisioning (Cloudflare-for-SaaS). Reuse hostname binding + SSL; drop domain *resale* (OpenProvider purchase flow). §3.3. |
| `i18n` | `backend/src/i18n/**` | **REUSE-AS-IS** | `en`/`hi` message loading. Add locale negotiation hooks for payslip/letter rendering. §9. |
| `web`, `shop`, `booking`, `chat`, `qa` | `backend/src/{web,shop,booking,chat,qa}` | **DELETE** (mine first) | Vertical backends. §1.1 notes. |
| **(new)** `hr` | `backend/src/hr/**` | **BUILD-NEW** | All HR domain: employees, org, attendance, leave, payroll engine, IN/NZ compliance modules, statutory filing, documents, talent. See `03`–`10`. |

---

## 2. Backend `core` — surgical keep/cut

`backend/src/core` is the heart of the reuse. Below is the file-by-file verdict for the load-bearing pieces (grounded by reading each).

### 2.1 Auth & session — **REUSE-AS-IS / ADAPT (rename only)**

**File:** `backend/src/core/middleware/auth.middleware.js` (464 LOC) — read in full.

This is the crown jewel. It already implements **two parallel session types** that map perfectly onto our two human-facing surfaces:

| Sitepresso concept | File symbol | HR mapping |
|---|---|---|
| **Operator** session (staff/admin) | `authenticateOperator`, `readOperatorToken`, cookie `ae_operator*` | **Tenant Admin / HR / Finance / Manager** (employer-side users). |
| **Customer** session (storefront buyer) | `authenticateCustomer`, `readCustomerToken`, cookie scoped by `businessId` | **Employee** (ESS portal user), white-labeled, tenant-scoped. |

Critical reusable mechanisms, verbatim:
- **`tokenPredatesPasswordChange`** (lines 53–56): JWT issued before last password change is revoked with a 5s skew buffer. Keep — HR needs forced re-auth on password reset.
- **Access/refresh token split** with `tokenUse` assertion (`assertAccessToken`/`assertRefreshToken`, lines 68–90). Keep.
- **Customer session cross-tenant guard** (lines 244–247): `if (tenantBusinessId !== customer.businessId) throw 403`. This is *exactly* the isolation an employee on `acme.hr.com` must not see `globex` data. Keep verbatim.
- **`requirePermission(key)`** (lines 295–306) — JSON-permission check via `effectivePermissions(user)`. Keep; the permission *catalog* changes (§6.3), the mechanism doesn't.

**Adaptation needed:**
1. Rename cookie prefixes `ae_operator`/customer → `hr_admin`/`hr_employee` (or keep `ae_` to avoid churn; cosmetic).
2. **Strip the vertical-role auto-provisioning** (lines 156–203): `ensureDefaultEcomStaffRole`, `ensureAppointmentSystemRole`, `ensureDefaultAppointmentStaffRole`. Replace with a single `ensureDefaultHrRole` that seeds HR system roles (Owner/HR-Admin/Finance/Manager/Employee) on first login.
3. `resolveTenantBusinessId` (lines 92–123) resolves a host → `businessId` via `business.slug`. Keep; this is our tenant resolver for the ESS white-label host. Re-point `PLATFORM_DOMAIN` to `hr.com`.

### 2.2 RBAC registry — **ADAPT (replace catalog, keep engine)**

**File:** `backend/src/core/lib/rbac.js` (133 LOC) — read in full.

The *engine* is perfect and reusable as-is:
- `PERMISSIONS` is a flat `Object.freeze({ key: 'human description' })` map. Adding a permission "never requires a schema migration — the `BusinessRole.permissions` JSON just acquires new keys" (file comment, lines 8–10). **Keep this design.**
- `SYSTEM_ROLES` seeds presets on business creation; `validatePermissions`, `hasPermission`, `effectivePermissions` are domain-agnostic. **Keep.**
- `LEGACY_ROLE_PERMS` maps the coarse `User.role` enum (SUPER_ADMIN/BUSINESS_ADMIN/STAFF/USER) to permission sets. **Keep the enum; remap presets.**

**Adaptation:** replace the booking/ecom permission keys (`canManageCustomers`, `canReceiveAppointments`, `canEditServices`, …) with the HR catalog. Concrete replacement (full set in §6.3):

```js
const PERMISSIONS = Object.freeze({
  // People
  canViewEmployees: 'View employee directory + profiles',
  canManageEmployees: 'Create/edit/terminate employees',
  canViewCompensation: 'View salary/CTC of others',
  canManageCompensation: 'Edit pay structures + revisions',
  // Time & leave
  canApproveLeave: 'Approve/decline leave requests',
  canManageAttendance: 'Edit attendance + regularisations',
  // Payroll
  canRunPayroll: 'Initiate + lock a pay run',
  canApprovePayroll: 'Approve a locked run for disbursement',
  canViewPayrollReports: 'View payroll registers + cost reports',
  // Statutory / filing
  canManageStatutory: 'Edit PF/ESI/PT/KiwiSaver/PAYE config',
  canFileReturns: 'Generate + mark statutory filings (24Q, payday-filing)',
  // Settings
  canManageOrg: 'Edit org structure, departments, locations',
  canEditBilling: 'Manage subscription + payment method',
  canEditDomain: 'Connect/change white-label domain',
  canEditBranding: 'Logo, brand color, style, domain binding',
});
```

System-role presets:
- **Owner** — all true.
- **HR-Admin** — everything except `canEditBilling`, `canEditDomain`, `canApprovePayroll`.
- **Finance** — `canRunPayroll`, `canApprovePayroll`, `canViewPayrollReports`, `canViewCompensation`, `canManageStatutory`, `canFileReturns`, `canEditBilling`.
- **Manager** — `canViewEmployees`, `canApproveLeave`, `canManageAttendance` (scoped to direct reports — see §6.3 for the location/team-scoped grant pattern lifted from `EcomRolePermissionGrant`).
- **Employee** — handled by the *customer* session, not a `BusinessRole`; ESS permissions are implicit.

### 2.3 Billing & subscriptions — **REUSE-AS-IS (the strategic win)**

**Files:**
- `backend/src/core/lib/billing/gatewayRouter.js` (238 LOC) — read in full. **REUSE-AS-IS.**
- `backend/src/core/lib/billing/gateways/{razorpayGateway.js, stripeGateway.js, PaymentGateway.js}` — **REUSE-AS-IS** (abstract `PaymentGateway` + concrete adapters).
- `backend/src/core/lib/billing/gateways/` Paddle adapter — **REUSE-AS-IS** (RoW fallback, already wired).
- `backend/src/core/lib/{subscriptionMaterializer.js, subscriptionBilling.js, subscriptionInvoice.js, billingLedger.js, billingChangePreview.js, billingPlanChangePolicy.js, billingAccess.js}` — **REUSE-AS-IS / light ADAPT.**
- `backend/src/core/controllers/{subscription.controller.js, razorpay.controller.js, stripe.controller.js, paddle.controller.js}` — **REUSE-AS-IS.**
- `backend/src/core/routes/subscription.routes.js` — **REUSE-AS-IS.**

Why this is a near-zero-effort reuse for our markets:

| Requirement (this project) | Already implemented in `gatewayRouter.js` |
|---|---|
| India bills in INR via Razorpay | `COUNTRY_GATEWAY.IN = RAZORPAY`, `GATEWAY_FIXED_CURRENCY[RAZORPAY] = 'INR'` (lines 30, 36). |
| NZ bills in NZD via Stripe | `COUNTRY_GATEWAY.NZ = STRIPE`, `GATEWAY_FIXED_CURRENCY[STRIPE] = 'NZD'` (lines 31, 37). |
| RoW via Paddle (MoR) | `resolveGateway()` default branch (line 78) → `PADDLE`; presentment GBP/EUR/USD/AUD (lines 90–94). |
| Per-seat pricing | `Subscription.seatsUsed Int @default(1)` (schema line 1508) + `tierId` FK to `PricingTier`. |
| Plan changes never migrate gateway accidentally | `resolveGatewayForChange()` (lines 196–198) — active gateway wins over country routing. |
| Charge-at-will (Razorpay token/mandate) | `Subscription.gateway`, token-sub columns (schema lines 51–56) + `chargeDueTokenSubscriptions` cron. |
| Webhook idempotency per gateway | `PaddleWebhookEvent`, `StripeWebhookEvent`, `RazorpayWebhookEvent` models (schema lines 1622–1691). |

**Adaptation (small):**
1. **Promo codes** live in `AdminCoupon`/`AdminCouponRedemption` (schema lines 2579–2644) + `backend/src/core/routes/adminCoupon.routes.js`. **REUSE-AS-IS** for super-admin promo codes.
2. The **pricing catalog** (`PricingTier`, `PricingZone`, `CountryZoneAssignment`, `TierPrice`, `TierFeature`, schema lines 2645–2779) is a full PPP-zone pricing engine. **REUSE-AS-IS**; re-seed tiers as HR plans (Starter / Growth / Enterprise) and re-seed `TierFeature` rows from the HR feature catalog (§6.4).
3. **Mine and discard** the *buyer-side* tenant payment routing (`resolveTenantPaymentGateway`, Stripe Connect / Razorpay Route, lines 107–170). HR has **no buyer checkout** — employees don't pay the tenant. Keep only the *SaaS-subscription* half (`resolveGateway` / `resolveBilling`). This deletes `backend/src/core/lib/{stripeConnect.js, billing/buyerGateways/*}` and the `BusinessPaymentAccount` model.
4. **Salary disbursement is NOT this billing engine.** Paying employees (NEFT/bank file in IN, direct-credit/bank batch in NZ) is a *new* payout module (`backend/src/hr/payout/**`, see `04-payroll-engine-design.md`), not Razorpay/Stripe subscriptions. Do not conflate.

> **Verified compliance anchor for billing currency design:** our two markets' statutory rules and currencies are fixed and current as of 2026 — IN labour codes in force 21 Nov 2025 (Code on Wages/Social Security/IR/OSH), NZ KiwiSaver min 3.5% from 1 Apr 2026, ACC earners' levy 1.75% on first $156,641, adult minimum wage $23.95/hr. These belong to the payroll engine (`04`–`06`), but they validate that INR/NZD are the only two billing currencies we must perfect at launch.

### 2.4 Tenant model & isolation — **ADAPT (rename `Business`→`Tenant`/`Company`, keep shape)**

**File:** `backend/prisma/schema.prisma`, `model Business` (lines 108–430) — read.

The `Business` model is the tenant root. Reusable fields, verbatim semantics:
- `id`, `slug @unique`, `shortId @unique` (human code), `country` (ISO-3166 alpha-2), `timezone` (IANA, e.g. `Pacific/Auckland`), `vertical` (default `APPOINTMENT`), `isActive`, `suspendedReason`, `suspendedAt`, `pendingDeletionAt`, `anonymisedAt` (GDPR soft-delete, lines 166–170).
- **`featureFlags Json?`** (lines 153–160) — per-tenant opt-out/opt-in over plan entitlement. *Exactly* the HR plan-gating floor/ceiling model. Keep verbatim; merge rule already documented in `featuresCatalog.js`.
- `subscription Subscription?` 1:1 relation (line 183).
- `defaultLanguage` (lines 209–214) — house language for fallback. Keep for payslip/letter locale.

**Adaptation:**
1. Set `vertical` default to `"HR"` (single vertical now) or drop the column once the booking/shop/web verticals are deleted. Recommend: **keep the column** but constrain to `'HR'` — it lets the panel registry and theme engine keep their vertical-filter contracts without rewrites (`admin-core.filterPanelsForFeatures`, `theme-engine.byVertical`).
2. **Add HR-tenant fields** (specified in `03-data-model.md`): `legalName`, `taxIdentifiers Json` (PAN/TAN/GSTIN/PF-code/ESIC-code for IN; IRD number/ACC-classification for NZ), `payCalendarConfig`, `taxYearStart` (Apr–Mar both markets), `statutoryProfile` (FK to versioned compliance rule table — see `05`/`06`).
3. Keep the storefront address fields but repurpose as **registered office / work locations** (the multi-location `BusinessLocation` model, schema line 3636, becomes HR work locations — §5.4).

### 2.5 Other `core/lib` files — quick verdicts

| File | Verdict | Note |
|---|---|---|
| `prisma.js` | **REUSE-AS-IS** | Singleton client. |
| `currency.js` | **REUSE-AS-IS** | INR/NZD formatting + rounding. Critical for payslips. |
| `s3.js` | **REUSE-AS-IS** | Document storage (payslips, Form 16, contracts). |
| `email.js`, `sms.js`, `zohoMail.js` | **REUSE-AS-IS** | Notification transports. §9. |
| `inputValidation.js` | **REUSE-AS-IS** | Shared validators. |
| `slugify.js`, `businessShortId.js` | **REUSE-AS-IS** | Tenant slug/code generation. |
| `rbac.js`, `roles.js` | **ADAPT** | §2.2. |
| `trial.js` | **REUSE-AS-IS** | Trial-period state. |
| `accountDeletion.js` | **REUSE-AS-IS** | GDPR/data-retention sweep. Adapt retention window to statutory (IN: wage registers 3 yrs; NZ: Holidays Act 7 yrs / 6 yrs records). |
| `exporters.js` | **ADAPT** | CSV/PDF export — reuse for payroll registers, statutory files. |
| `featuresCatalog.js` | **ADAPT** | Replace catalog entries with HR features (§6.4). Keep resolution rule (lines 8–14). |
| `findOwned.js` | **REUSE-AS-IS** | `businessId`-scoped fetch helper — the isolation primitive. |
| `scheduler.js` | **ADAPT** | Cron registry. Add payroll/filing/leave-accrual jobs. |
| `legal.js`, `invoiceConfig.js`, `subscriptionInvoice.js` | **REUSE-AS-IS** | SaaS invoicing to tenants. |
| `cart.js`, `productPricing.js`, `orderReconcile.js`, `ecom*`, `whatsappCatalog.js`, `aapka*`, `intakeForms.js`, `pageTemplates.js`, `seoHelpers.js`, `themeCopyHeal*`, `categoryTheme.js`, `starterCatalog.js`, `mailboxProvisioning.js` | **DELETE** | Vertical/storefront/SEO/mailbox-resale logic. No HR analogue. |
| `stripeConnect.js`, `gatewayCatalogService.js` (buyer side) | **DELETE** | Buyer checkout, §2.3.4. |

---

## 3. Tenant-resolution router — **ADAPT**

**Files:** `apps/router/index.js` (838 LOC), `apps/router/cloudflare-worker.js` (483 LOC) — read.

### 3.1 What's reusable verbatim
- **Reverse-proxy core** (`http-proxy` + keep-alive agent, lines 1–101): connection pooling, 502 handler, proxy timeouts.
- **Public micro-cache** (lines 78–120+): Redis-backed, `hasPrivateCookie` bypass (line 103 — never caches a logged-in response), locale-keyed (`microcacheLocaleKey`). Reuse for the **ESS public login page** and **white-label marketing splash**; private (authed) ESS/admin always bypass.
- **Reserved-subdomain set** (line 81): `www, api, admin, app, mail, platform, m, test`. Keep + add `hr`. These can never be a tenant slug.
- **Asset-prefix routing** (lines 60–73, `ASSET_PREFIX_SUBAPP`): the mechanism that makes a sub-app's `/_next/*` chunks load under a prefix. Reuse for the ESS sub-app served under a custom domain.
- **`TENANT_ADMIN_PATH_RE`** + the canonical "tenant admin lives on `app.<domain>/dashboard`" rule (lines 28–31, 80) — reuse exactly; tenant admin → `app.hr.com/dashboard`.

### 3.2 What to rewire
The port tables encode the deleted verticals. Replace:

```js
// BEFORE (Sitepresso) — apps/router/index.js lines 22–46
const PUBLIC_PORTS = { booking: 3001, shop: 3002, web: 3003 };
const SUB_APP_PORTS = { booking: {...}, shop: {...}, web: {...} };

// AFTER (HR)
const PLATFORM_PORT = 3000;   // hr.com marketing + admin.hr.com super-admin + onboarding
const HR_ADMIN_PORT = 3010;   // app.hr.com tenant HR console
const ESS_PORT       = 3020;   // tenant.com / *.hr.com white-label employee portal
```

Routing decision tree (replaces the per-vertical fan-out):

```
host = admin.hr.com           → PLATFORM_PORT, /superadmin/* only (else → /login)   [middleware.js guard reused]
host = app.hr.com             → HR_ADMIN_PORT, JWT-scoped /dashboard                 [operator session]
host = hr.com / www.hr.com    → PLATFORM_PORT, marketing + /signup + /onboarding
host = <slug>.hr.com OR bound custom domain → ESS_PORT  [resolveTenantBusinessId → businessId; customer session]
```

### 3.3 Custom domain + SSL — **ADAPT**
`apps/router/cloudflare-worker.js` + `backend/src/domains/**` + `backend/src/core/lib/customDomainRouting.js` (read: `routableCustomDomainWhere`, `customDomainLookupHosts`).
- **Reuse:** Cloudflare-for-SaaS custom-hostname binding, SSL issuance, `customDomainVerified`/`customDomainStatus` gating (only `ROUTABLE_CUSTOM_DOMAIN_STATUSES` resolve), apex-vs-subdomain detection.
- **Delete:** domain *purchase/resale* via OpenProvider (`OPENPROVIDER_HANDOVER.md` flows, `DomainPricing` model, mailbox provisioning). Tenants **bind** an existing domain for the white-label ESS; we never sell them domains.
- Note (lines 120–122 of `auth.middleware.js`): Sitepresso *retired* BYO custom-domain lookup on 2026-05-10 in favour of platform subdomains. **For HR we must re-enable it** — white-label ESS on the tenant's own domain (`careers.acme.com`) is a core requirement (`11-ess-and-mobile.md`). The Cloudflare-for-SaaS plumbing still exists; we re-wire `resolveTenantBusinessId` to consult `routableCustomDomainWhere` before falling through.

---

## 4. Frontend surfaces — split & build

### 4.1 Marketing + Onboarding (`hr.com`) — **ADAPT**
`apps/platform/app/{page.js, signup, onboarding, legal, pricing, geo}`.
- Reuse the Next.js 14 app-router shell, `middleware.js` (locale + host guards, read in full), `AuthShell.js`, `LanguageSelector.js`, signup flow, geo-IP currency/locale detection.
- **Rebuild content**: replace storefront/profession copy with HR product marketing.
- **Onboarding wizard** (`apps/platform/app/onboarding`) → fork into the **guided company-setup wizard** (`01-product-requirements.md`): legal entity → country (IN/NZ) → tax identifiers → pay calendar → first employees → statutory profile. The *wizard shell + step state machine* is reusable; the *steps* are new.

### 4.2 Super Admin (`admin.hr.com`) — **ADAPT**
`apps/platform/app/superadmin/**` + `backend/src/superadmin/**` (`admin.routes.js` read).
- **Reuse-as-is handlers:** `listBusinesses`, `stats`, `dashboardAnalytics`, `businessAnalytics`, `toggleSuspend`, `deleteBusiness`, `getSettings`/`updateSetting`, `billingActivity`, `billingInvoice`, support conversation list/reply.
- **Impersonation:** the operator-session + support tooling supports support/impersonate; reuse for "log in as tenant HR admin."
- **Replace:** `gstReport.controller.js` (Sitepresso's India GST report) → HR platform reports (MRR/ARR by plan, seat utilisation, tenant churn, payroll-volume processed). The *report-controller pattern* is the template.
- **Add:** versioned **per-country COMPLIANCE RULE tables** admin (the IN/ NZ rate tables from `05`/`06` — effective-dated, super-admin-editable, with a publish workflow). This is BUILD-NEW but slots into the existing `superadmin` route file + admin-core panel registry.

### 4.3 Tenant HR Admin (`app.hr.com`) — **BUILD-NEW (fork shell)**
Extract `apps/platform/app/(unified-admin)` into `apps/hr-admin`.
- **Fork the shell:** sidebar nav, `admin-ui.js`, `admin-pickers.js`, `NotificationInboxPanel.js`, `TrialBanner.js`, panel layout. These are vertical-agnostic.
- **Drive nav with `admin-core` panel registry** (§6.1) + HR feature flags. Panels are all BUILD-NEW (`07`–`10`): People, Org, Attendance, Leave, Payroll, Compliance/Filing, Documents, Reports, Talent, Settings/Branding/Billing.
- **Reuse `RichTextEditor.js`, `ImageEditorModal.js`** for letter templates / logo upload.

### 4.4 Employee Self-Service (`tenant.com`) — **BUILD-NEW (fork customer shell)**
Fork the booking/shop **`customer` sub-app** shell + the **customer JWT session** (§2.1).
- Reuse: white-label theming (logo/brand-color/style from `StoreBrand`-equivalent, §8), customer login/forgot-password, notification inbox, `assetPrefix` sub-app routing (§3.1).
- Build new: payslip viewer, leave request/balance, attendance/clock, tax declarations (IN regime choice), documents, profile. See `11-ess-and-mobile.md`.

---

## 5. Mining the verticals before deletion

Three deleted backends contain models that are **direct HR ancestors**. Migrate the schema patterns (not the controllers) before `rm`.

### 5.1 From `booking` — schedule, leave, holidays
| Sitepresso model (schema) | Reuse for | HR target (see `03`, `08`) |
|---|---|---|
| `StaffSchedule` (1967) | Weekly working pattern | `WorkSchedule` / shift pattern |
| `StaffLeave` (2339) | Leave request lifecycle | `LeaveRequest` (state machine: REQUESTED→APPROVED/DECLINED→CANCELLED) |
| `BusinessHours` (1058) | Operating hours | Per-location work hours, overtime baseline |
| `BusinessHoliday` (1070) | Closure days | **Public-holiday calendar** — load-bearing for NZ Holidays Act (alternative/lieu days) and IN regional holidays. |
| `Appointment` reminder config (Business line 161) | Channel/offset reminder model | Leave-approval & payslip notifications. |

### 5.2 From `shop` — relational RBAC & multi-location
| Sitepresso model | Reuse for | HR target |
|---|---|---|
| `EcomPermission` (3975) + `EcomRolePermissionGrant` (3996) | **Location/team-scoped permission grants** | Manager-scoped approvals (approve leave only for *my* department/location). §6.3. |
| `BusinessLocation` (3636) | Multi-store | **Work locations / branches** (PF/ESIC/PT registration is per-state in IN, per-location). |
| `InventoryStock`/`ProductLocationOverride` patterns | Per-location config override | Per-location statutory config (state PT slab, location holiday calendar). |

### 5.3 From `web` — nothing structural
Delete outright; only the `BusinessContent`/page-template machinery, which we do **not** want (no page builder — core principle).

### 5.4 The pattern, not the code
Copy these as **schema templates into `03-data-model.md`'s HR models**; do **not** import the controllers — they carry booking/shop domain logic. The reuse is the *shape* (state columns, `businessId` scoping, JSON config columns, soft-delete fields), which keeps Prisma migration ergonomics and isolation guarantees consistent with the surviving `core`.

---

## 6. Admin shell, feature flags & plan gating

### 6.1 Panel registry — **REUSE-AS-IS**
`packages/admin-core/index.js` (read in full). The whole package is 76 LOC and domain-agnostic:
- `createPanelRegistry(panels)` → `{ get, keys, list({vertical,group}), forFeatures(features) }`.
- `filterPanelsForFeatures(panels, features)` — drops any panel whose `requiredFeatures` aren't all truthy in the tenant's resolved flags.
- `createPanelDefinition` defaults `{ vertical:'shared', group:'Main', requiredFeatures:[] }`.

**HR usage:** define one panel per HR module with `requiredFeatures` keyed to the plan-tier flags. Example:
```js
createPanelDefinition({ key:'payroll', group:'Pay', vertical:'HR', requiredFeatures:['payrollEngine'] });
createPanelDefinition({ key:'talent-recruiting', group:'Talent', vertical:'HR', requiredFeatures:['recruiting'] }); // Enterprise-only
```
Then `registry.forFeatures(resolvedFlags)` yields the exact nav for that tenant's plan. Zero new mechanism.

### 6.2 Super-admin surface — **ADAPT** (§4.2).

### 6.3 Granular RBAC with scope — **ADAPT** (engine reuse)
For **manager-scoped approvals**, fork the relational grant model from shop:
- Sitepresso's `requireEcomPermission` (auth.middleware lines 337–417, read) loads `EcomRolePermissionGrant` rows for `(roleId, key)` where a **null `locationId` = tenant-wide** grant and a **concrete `locationId` = scoped** grant; the request's location is matched against the grant (`ecomRequestedLocationId`).
- **HR mapping:** `HrRolePermissionGrant(roleId, permissionKey, scopeType, scopeId)` where `scopeType ∈ {TENANT, LOCATION, DEPARTMENT, DIRECT_REPORTS}`. A Manager gets `canApproveLeave` scoped to `DEPARTMENT:eng` or `DIRECT_REPORTS`. The middleware is a near-verbatim fork of `requireEcomPermission`; only the scope resolver (`ecomRequestedLocationId` → `hrRequestedScope`) changes.
- For simple tenant-wide roles (HR-Admin, Finance, Owner), the **JSON `BusinessRole.permissions`** path (§2.2) is sufficient — keep both, exactly as Sitepresso runs both side by side.

### 6.4 Feature catalog — **ADAPT**
`backend/src/core/lib/featuresCatalog.js` (read). Keep the resolution rule verbatim:
```
effective = rollout && tierDefault && (businessFlag !== false)
```
Replace catalog entries with HR features, each tagged `planRequired`, `rolloutStatus`, `category`:

| Feature key | Plan | Category | Drives panel |
|---|---|---|---|
| `coreHr` | Starter | people | People, Org |
| `attendance` | Starter | time | Attendance |
| `leaveManagement` | Starter | time | Leave |
| `payrollEngine` | Growth | pay | Payroll |
| `statutoryIN` / `statutoryNZ` | Growth | compliance | Compliance/Filing (gated by tenant country) |
| `documents` | Growth | docs | Documents |
| `essPortal` | Starter | ess | (enables employee surface) |
| `whiteLabelDomain` | Growth | branding | Settings → Branding |
| `recruiting` / `performance` / `lms` | Enterprise | talent | Talent suite |
| `apiAccess` / `webhooks` | Enterprise | integrations | reuse `ApiKey`/`WebhookSubscription` models (schema 3537–3608). |

`statutoryIN`/`statutoryNZ` are **country-conditioned**: resolved true only when `business.country` matches, regardless of plan — compliance is not an upsell, it's correctness.

---

## 7. Design system & shared UI

### 7.1 `packages/ui` — **REUSE-AS-IS**
`packages/ui/{index.js, admin.js}`. Tailwind-based primitives. Rename package `@sitepresso/ui` → `@hr/ui`. The admin-specific exports (`admin.js`) back the admin shell; the index backs ESS. Reusable components confirmed in `apps/platform/components`: `BrandCombobox`, `CountryAddressFields`, `NotificationBanner/Inbox`, `RichTextEditor`, `WeekCalendar` (→ attendance/leave calendar), `ImageEditorModal` (logo upload).

### 7.2 `apps/platform/components` worth forking
`WeekCalendar.js` → attendance/leave week view. `CountryAddressFields.js` → IN (state/PIN) vs NZ (region/postcode) address forms. `NotificationInboxPanel.js` → in-app notifications. `LanguageSelector.js` → en/hi (+ future) toggle.

---

## 8. Theme engine — **ADAPT (slim to 5 styles)**

**Files:** `packages/theme-engine/index.js` (312 LOC, read), `profession-styles.mjs`, `profession-registry.mjs`, `theme-colors.mjs`, `layout-presets.cjs`.

**Keep (engine):** `normalizeThemeConfig`, `composeTheme`, `createThemeRegistry`, `validateThemeContract`, `resolveThemeSlots`, palette/vocab normalisation, `buildThemeManifest`. This gives us: a tenant picks **one of 5 fixed styles + one brand color + logo + domain** — and the engine composes the runtime theme. The `palette.primary` single-color model (lines 87–95) maps exactly to "ONE brand color." The `mode` inference (GENERIC/MIXED/BESPOKE) is irrelevant for us — all HR themes are `GENERIC` + one accent.

**Delete:** the **60+ profession registry** (`profession-styles.mjs`, `profession-registry.mjs`, `profession-registry.test.mjs`) and `backend/src/core/generated/themeManifest.json` profession entries. The `VERTICAL_ALIASES` (index lines 9–21) collapse to a single `HR` vertical.

**Result:** a 5-entry theme registry (e.g. `slate`, `indigo`, `emerald`, `rose`, `mono`) each a `normalizeThemeConfig` seed; tenant override is `{ palette.primary, logoUrl }`. No slots, no panels override, no per-page builder — enforcing the "configure, not build" core principle at the type level.

The tenant brand record reuses the `StoreBrand` model shape (schema 3426) renamed `TenantBrand` (`logoUrl`, `primaryColor`, `styleKey`, `customDomain`).

---

## 9. i18n & notifications — **REUSE-AS-IS**

- **i18n:** `backend/src/i18n/**` + per-app `messages/{en,hi,...}.json` + `apps/platform/middleware.js` locale negotiation (read: geo-IP → Accept-Language → default, sticky `NEXT_LOCALE` cookie). Launch locales **en + hi**; the framework already ships 7 locale files we ignore. Payslip/letter rendering consults `Business.defaultLanguage` + employee `preferredLanguage` (already on `Customer`, schema 1088+).
- **Notifications:** `NotificationConfig` (2848), `MessageTemplate` (2899), `MessageDelivery` (2943), `EmailDelivery` (2480), `InboxNotification` (2397) + transports `email.js`/`sms.js`/`zohoMail.js` + WhatsApp. **REUSE-AS-IS**; add HR templates (payslip-published, leave-approved, run-locked, filing-due). The `BudgetUsage`/`SmsOptOut` guards reuse unchanged.

---

## 10. Concrete fork-and-strip procedure

A repeatable, ordered runbook. (Commands illustrative — adapt to the new repo location; do not run against `/Users/kp/sitepresso`, which is READ-ONLY.)

**Phase 0 — Fork & baseline**
1. `git clone sitepresso hr-platform` (fresh repo, new remote). Keep Turborepo, `turbo.json`, `.nvmrc`, CI.
2. Rename npm scope `@sitepresso/*` → `@hr/*` across `packages/*/package.json` + imports.
3. Re-point env: `PLATFORM_DOMAIN=hr.com`, `NEXT_PUBLIC_PLATFORM_DOMAIN=hr.com`.

**Phase 1 — Delete verticals (mine first)**
4. Copy schema patterns from §5 into `03-data-model.md`'s HR models *before* deleting.
5. `rm -rf apps/{web,shop,booking,chat-*,aapkarider-*,qa-portal}`.
6. `rm -rf backend/src/{web,shop,booking,chat,qa}`.
7. `rm -rf packages/{blog-ui,ecom-ui,chat-*,aapkarider-shared}`.
8. Delete vertical `core/lib` files (§2.5 DELETE rows) + buyer-side billing (§2.3.4).
9. Drop the 60+ profession theme registry (§8).
10. Run an import-sweep (`rg "@sitepresso/(shop|booking|web|chat)"`, `rg "require\('.*\/(shop|booking|web)\/"`) and fix dangling imports until `turbo build` type-checks the surviving graph.

**Phase 2 — Adapt the survivors**
11. Rewrite `apps/router` port table + routing tree (§3.2); re-enable custom-domain lookup (§3.3).
12. Strip vertical auto-role provisioning from `auth.middleware.js`; add `ensureDefaultHrRole` (§2.1).
13. Replace `rbac.js` catalog + presets (§2.2); replace `featuresCatalog.js` entries (§6.4).
14. Trim `gatewayRouter.js` to the SaaS-subscription half (delete buyer routing); confirm IN→Razorpay/INR, NZ→Stripe/NZD, RoW→Paddle survive (they already do).
15. Re-seed `PricingTier`/`TierFeature` as HR plans; wire `admin-core` panel registry to HR panels.
16. Slim `theme-engine` to 5 styles; rename `StoreBrand`→`TenantBrand`.
17. Replace `superadmin` GST report with HR platform reports; add versioned compliance-rule-table admin.

**Phase 3 — Build new**
18. Scaffold `apps/{hr-admin,ess,hr-mobile}` from the `(unified-admin)` + customer-sub-app shells.
19. Build `backend/src/hr/**`: people/org → attendance/leave → payroll engine → IN/NZ compliance → statutory filing → documents → talent (per `03`–`10`).
20. Add HR prisma models; migrate.

**Phase 4 — Verify**
21. Isolation test: an employee session on `acme.hr.com` resolves `businessId=acme` and is rejected (403) on `globex` data — reuse the `auth.middleware.js` cross-tenant guard test.
22. Billing test: a tenant with `country=IN` routes to Razorpay/INR; `country=NZ` to Stripe/NZD; `country=AU` to Paddle/AUD — assert on `resolveBilling()`.

---

## 11. Reuse scorecard (effort estimate)

| Layer | Verdict mix | % of HR platform code reused from Sitepresso |
|---|---|---|
| Auth / session / isolation | REUSE-AS-IS + rename | ~90% |
| Billing / subscriptions / promo / pricing | REUSE-AS-IS (SaaS half) | ~85% |
| Tenant model + feature flags + plan gating | ADAPT | ~75% |
| Tenant-resolution router + custom domain/SSL | ADAPT | ~70% |
| Admin shell + panel registry + design system + UI | REUSE/ADAPT | ~70% |
| i18n + notifications | REUSE-AS-IS | ~90% |
| Theme engine | ADAPT (slim) | ~50% |
| **HR domain** (people/org/time/leave/payroll/compliance/talent/ESS) | **BUILD-NEW** | **~5%** (schema-shape mining only) |

Net: **the entire SaaS substrate (auth, tenancy, billing, routing, admin shell, i18n) is reused; ~100% of the *vertical value* — payroll + IN/NZ compliance + ESS — is new.** This is the correct fork target: Sitepresso solves "multi-tenant white-label SaaS plumbing," which is precisely the part we don't want to rebuild, and it already special-cases our two launch countries in billing.

---

## 12. Open risks & coupling notes

1. **Vertical column entanglement.** `vertical` threads through theme-engine, admin-core, `requireVertical.js`, `requireEcomPermission`. Keeping it (constrained to `'HR'`) is cheaper than excising it; revisit post-launch.
2. **`Customer` model reuse for Employee.** The customer session/model is generous (addresses, identities, marketing opt-outs). Forking it as `Employee` risks dragging marketing fields. Decision needed: extend `Customer` vs new `Employee` model linked to a thin `Customer` auth row. (Recommend new `Employee` model; reuse only the *auth* columns — `passwordChangedAt`, `preferredLanguage`, `isActive`, `anonymisedAt`.)
3. **Custom-domain re-enable.** Sitepresso retired BYO domains 2026-05-10; we must un-retire the Cloudflare-for-SaaS path for white-label ESS. Plumbing exists but is dormant — needs a verification pass.
4. **Disbursement vs SaaS billing confusion.** Hard architectural boundary: the reused billing engine charges *tenants for the subscription*; paying *employees* is a separate payout module. Mislabelling will leak Razorpay/Stripe into payroll.
5. **Compliance currency vs presentment.** Billing is INR/NZD; payroll currency is also INR/NZD but governed by statutory rounding (`04`). Don't share the `currency.js` rounding for both without confirming statutory rules (IN PF rounds to nearest rupee; NZ PAYE to cents).

---

## 13. Citations (grounding & verified facts)

**Sitepresso source (read for this doc):** `apps/router/index.js`; `apps/platform/middleware.js`; `apps/platform/app/**`; `backend/src/core/middleware/auth.middleware.js`; `backend/src/core/lib/rbac.js`; `backend/src/core/lib/billing/gatewayRouter.js`; `backend/src/core/lib/featuresCatalog.js`; `packages/admin-core/index.js`; `packages/theme-engine/index.js`; `backend/src/superadmin/routes/admin.routes.js`; `backend/prisma/schema.prisma` (models `Business` 108, `Subscription` 1500, `BusinessRole` 3609, `EcomRolePermissionGrant` 3996, `BusinessLocation` 3636, `StaffLeave` 2339, `StoreBrand` 3426, pricing 2645–2779).

**2026 compliance facts (verified via web search 2026-06):**
- NZ KiwiSaver minimum employer/employee contribution **3% → 3.5% from 1 Apr 2026** (then 4% in two stages by 2028); 16–17-year-olds become eligible. — [IRD](https://www.ird.govt.nz/kiwisaver-changes), [MAS](https://www.mas.co.nz/hub/kiwisaver-changes-2026-increased-contribution-rate-of-35/)
- NZ adult minimum wage **$23.95/hr** (training/starting-out **$19.16/hr**) from 1 Apr 2026. — [IRD/nztax.tools](https://nztax.tools/calculators/minimum-wage-calculator/)
- NZ ACC earners' levy **1.67% → 1.75%** on first **$156,641** (max levy $2,741.22) from 1 Apr 2026. — [IRD ACC levy rates](https://www.ird.govt.nz/income-tax/income-tax-for-individuals/acc-clients-and-carers/acc-earners-levy-rates)
- IN New Labour Codes (Code on Wages / Social Security / IR / OSH) **in force 21 Nov 2025**; uniform "wages" = Basic+DA+retaining allowance must be **≥ 50%** of total remuneration, cascading into PF, gratuity, bonus. — [PayrollOrg](https://payroll.org/news-resources/news/news-detail/2025/12/17/india-s-new-labour-codes-are-in-force-payroll-teams-must-act), [DLA Piper](https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2025/government-of-india-notifies-the-labour-codes-ushers-a-new-era-of-compliances)

(Detailed statutory rates, thresholds, filing deadlines, and effective dates live in `05-compliance-india.md` and `06-compliance-newzealand.md`.)

# 02 — System Architecture

**Product:** Multi-tenant, white-label HRMS & Payroll SaaS ("the platform")
**Author:** Senior Software Architect
**Status:** Production-grade design (NOT an MVP). Forks the live Sitepresso platform at `/Users/kp/sitepresso`.
**Launch markets:** India (IN) and New Zealand (NZ). Currencies INR + NZD. Tax year Apr–Mar in both.
**Last reviewed against 2026 compliance facts:** 2026-06-22.

> Cross-references (sibling docs, same `/Users/kp/docs` folder):
> - `01-product-overview.md` — surfaces, personas, plan tiers.
> - `03-data-model.md` — full Prisma schema for HR/payroll entities.
> - `04-payroll-engine.md` — calculation pipeline internals & rounding rules.
> - `05-compliance-IN.md` / `06-compliance-NZ.md` — versioned rule tables & exact figures.
> - `07-billing-and-plans.md` — Razorpay/Stripe/Paddle, per-seat pricing, promo, feature flags.
> - `08-security-and-audit.md` — RBAC matrix, impersonation, audit log, data residency.
> - `09-onboarding-wizard.md`, `10-ess-and-mobile.md`.

This document is the **end-to-end architecture**: monorepo layout, the three routing surfaces, tenant resolution by `Host` header, custom-domain binding + SSL, multi-tenant data isolation, service boundaries, payroll-engine placement, caching, background jobs/queues for pay runs and payday filing, scalability & data residency, and the precise Sitepresso reuse map with real file paths.

---

## 0. Architectural North Stars (opinionated)

These principles bind every decision below. They are the "constitution" — deviate only with an explicit ADR.

1. **One backend, row-level tenant isolation by `businessId`.** We do NOT spin a DB per tenant. We inherit Sitepresso's proven pattern: every tenant-owned row carries `businessId`, every tenant query is filtered by it, and a tenant-resolution layer makes `businessId` ambient on the request. (Grounded in `backend/src/core/middleware/requireBusiness.js` and the 421 `businessId` references across `backend/prisma/schema.prisma`.) Per-DB isolation is rejected: 162 models × N tenants of migrations is operationally untenable, and the payroll engine needs cross-tenant analytics for the Super Admin surface.
2. **"Pre-built system, NOT a builder."** Tenants CONFIGURE (data + settings + plan feature flags), never DESIGN. There is no page/form/layout builder. Branding = logo + ONE brand color + ONE of 5 fixed styles + a bound custom domain. This shrinks the surface dramatically vs. Sitepresso's storefront builder, and lets us delete the entire website/page-builder subsystem.
3. **Compliance is data, not code branches.** IN/NZ statutory rules (rates, thresholds, slabs, effective dates) live in **versioned, country-scoped rule tables** owned by Super Admin — never hard-coded in the engine. A pay run pins the rule-set version it executed against, so a run is reproducible and auditable forever. (See §8 and `05-compliance-IN.md`/`06-compliance-NZ.md`.)
4. **A pay run is a durable, resumable, idempotent state machine — not a request handler.** Payroll touches money and the tax authority. It runs on a real job queue (BullMQ on Redis) with idempotency keys, not on Sitepresso's fire-and-forget `node-cron` ticks. This is the single most important upgrade over the fork base (Sitepresso has `ioredis` + `node-cron` but **no** BullMQ — see §7.1).
5. **The tax authority is an external system of record we must converge with.** Payday filing (NZ, ≤2 working days) and TDS/PF/ESI deposits (IN, by 7th/15th) are submission pipelines with retries, reconciliation, and immutable receipts — modeled exactly like Sitepresso's gateway-webhook drains (`processPaddleWebhookRetries` L677, `processStripeWebhookRetries` L690, `reconcileStuckRazorpaySubscriptionsTask` L703 in `backend/src/core/lib/scheduler.js`; the latter delegates to `reconcileStuckRazorpaySubscriptions` in `controllers/razorpay.controller.js`).
6. **Data residency by market.** IN tenant PII and NZ tenant PII may be legally required to stay in-region. We design for **region-pinned tenants** from day one (region column on `Business`). Note the fork ships a **single `DATABASE_URL` Prisma singleton**, so true region routing means **deploy-per-region** (separate backend/worker fleet per market), not transparent in-process connection switching — see §9.2 for why and the trade-offs. We can launch single-region but must pin the region column from day one so the deploy-per-region split is a config change, not a data migration. (See §9.)

---

## 1. Monorepo Layout

We keep Sitepresso's **Turborepo + npm workspaces** structure (`package.json` `workspaces`, `turbo.json`) and its split between Next.js 14 app workspaces, shared `packages/*`, and a single Express + Prisma `backend/`. We **delete the vertical/storefront sprawl** and **add the HR vertical**.

### 1.1 Target tree (after fork surgery)

```
/ (turborepo root — package.json workspaces, turbo.json)
├── apps/
│   ├── marketing/            # NEW  hr.com — marketing + signup + onboarding wizard (forks apps/platform marketing pages)
│   ├── platform/             # REUSE admin.hr.com — Super Admin console (forks apps/platform, strips storefront admin)
│   ├── hr-admin/             # NEW  app.hr.com — Tenant Admin (HR/Finance) console
│   ├── ess/                  # NEW  tenant.com / tenant.hr.com — white-labeled Employee Self-Service portal
│   ├── router/               # REUSE host-based reverse proxy (apps/router/index.js + cloudflare-worker.js)
│   └── mobile/               # NEW  (Flutter or RN) ESS mobile — the only mobile precedent in the fork is apps/chat-mobile (Flutter)
├── packages/
│   ├── ui/                   # REUSE design system (packages/ui)
│   ├── admin-core/           # REUSE admin shell, tables, filters (packages/admin-core)
│   ├── theme-engine/         # REUSE-SLIMMED theming → exactly 5 fixed styles (packages/theme-engine)
│   ├── types/                # REUSE shared TS types (packages/types)
│   ├── payroll-core/         # NEW  pure, deterministic payroll calc library (no I/O) — see §6
│   ├── compliance-in/        # NEW  IN statutory calculators (PF/ESI/PT/TDS/gratuity) over rule tables
│   ├── compliance-nz/        # NEW  NZ statutory calculators (PAYE/KiwiSaver/ESCT/ACC/Holidays Act)
│   └── (no shared i18n package — see §1.4)  # i18n is per-app, NOT a package
└── backend/
    ├── prisma/schema.prisma  # REUSE skeleton (Business/User/Subscription/Auth/Billing) + NEW HR models
    └── src/
        ├── core/             # REUSE auth, rbac, prisma, redis, billing libs, scheduler shell
        ├── superadmin/       # REUSE-EXTENDED super-admin controllers/routes
        ├── domains/          # REUSE custom-domain + registrar adapters (Cloudflare/OpenProvider)
        ├── hr/               # NEW  HR domain: employees, attendance, leave, pay runs, filings
        └── index.js          # REUSE Express bootstrap (mounts /api/* + /api/internal)
```

### 1.2 What we DELETE from the fork (and why)

| Path in `/Users/kp/sitepresso` | Action | Reason |
|---|---|---|
| `apps/web/`, `apps/shop/`, `apps/booking/` (+ all sub-apps: public/staff/customer) | DELETE | Storefront verticals; replaced by HR surfaces. |
| `backend/src/web/`, `backend/src/shop/`, `backend/src/booking/` | DELETE | Vertical backends. |
| `apps/chat-*`, `apps/aapkarider-*`, `packages/chat-*`, `packages/ecom-ui`, `packages/blog-ui`, `packages/aapkarider-shared` | DELETE | Out-of-scope products. |
| 60+ profession themes + `scripts/build-theme-manifest.js` theme sprawl, `backend/src/core/generated/themeManifest.json` | DELETE / SLIM | Branding is now logo + 1 color + 1-of-5 styles only. |
| Page/site builder, `lib/pageTemplates.js`, `BusinessPage`, `BusinessContent`, SEO-page-override models | DELETE | "Configure, don't build." No designable surfaces. |
| Domain/mailbox **resale** (`backend/src/domains/domainService.js` reseller flows, `mailboxProvisioning.js`, `domainPricing*`) | DELETE-RESALE / KEEP-BIND | We keep custom-domain **binding + SSL**, drop the registrar storefront. |

### 1.3 What we KEEP verbatim or near-verbatim (reuse map → §10 has the full table)

- Tenant **router** + Cloudflare Worker (`apps/router/*`).
- **Auth/RBAC** (`backend/src/core/middleware/auth.middleware.js`, `core/lib/rbac.js`, `core/lib/roles.js`).
- **Tenant isolation primitive** (`businessId` everywhere; `requireBusiness.js`).
- **Custom-domain binding + SSL** (`core/lib/customDomainRouting.js`, Cloudflare-for-SaaS custom hostnames, `domains/adapters/*`).
- **Multi-gateway billing** (Razorpay/Stripe/Paddle controllers, webhook drains, reconciliation crons).
- **Super Admin shell** (`apps/platform`, `packages/admin-core`).
- **Design system + theming** (`packages/ui`, `packages/theme-engine` slimmed).
- **i18n** (`apps/platform/middleware.js` cookie-based locale + `apps/platform/i18n/{config,request}.js`, **next-intl**). Note: there is **no** shared `packages/i18n` in Sitepresso — i18n is wired per-Next.js-app via next-intl. We either (a) lift the shared registry/messages into a NEW `packages/i18n` during the fork, or (b) keep next-intl per-app and duplicate the small `config.js`. Sitepresso's `SUPPORTED_LOCALES` is actually `['en','hi','es','fr','de','it','pt-BR']`; we ship **en + hi** for launch and keep the others dormant.
- **Notifications** (`core/lib/notifications/router.js` WhatsApp→SMS→email cascade; siblings `countryRouting.js`, `providers.js`, `templates.js`, `priceCache.js`) for payslip/leave/payday notices.

### 1.4 Reuse-claim corrections (verified against the live repo, 2026-06-22)

The following claims in earlier drafts were **wrong** against `/Users/kp/sitepresso` and are corrected here:
- **`packages/i18n` does not exist.** i18n lives inside the Next.js apps (`apps/platform/i18n/*`, next-intl). The monorepo tree and reuse map (§10) reflect this; "create `packages/i18n`" is now a NEW item, not a REUSE.
- **`apps/shop-mobile` does not exist.** Only `apps/chat-mobile` (Flutter, `pubspec.yaml` present) exists. The mobile-ESS reuse pattern is **`apps/chat-mobile` only** (§13.3 corrected).
- **`Subscription.customDomain` is NOT `@unique`** in the live schema (it is a plain `String?`). Any "second claim rejected by a unique constraint" guarantee must be **added** by us — see §4.4.

---

## 2. The Four Surfaces & Their Hosts

| # | Surface | Canonical host | App workspace | Who | Auth principal |
|---|---|---|---|---|---|
| 1 | Marketing + Onboarding | `hr.com`, `www.hr.com` | `apps/marketing` | Prospects, new signups | Public + signup session |
| 2 | Super Admin | `admin.hr.com` | `apps/platform` | **We** (platform operators) | `User.role = SUPER_ADMIN` |
| 3 | Tenant Admin (HR console) | `app.hr.com` | `apps/hr-admin` | Employer's HR/Finance | `User` (BUSINESS_ADMIN / scoped roles) |
| 4 | Employee Self-Service | `<tenant>.hr.com` **or** bound `tenant.com` | `apps/ess` | Employees | `Customer`-style employee principal (see §5.4) |

This maps 1:1 onto Sitepresso's existing host topology. In `apps/router/cloudflare-worker.js` and `apps/router/index.js`:

- The **apex** (`hr.com`) serves marketing — `resolveRoute` falls through to `PLATFORM_PORT` for the platform host with no/reserved subdomain.
- `admin.<domain>` is an **operator-only** entry point, hard-locked at the edge: `adminHostLoginRedirectUrl()` (router `index.js` L688) + `ADMIN_HOST_ALLOWED_PREFIXES` (L679) redirect everything except login/superadmin to `/login`. We keep this guard exactly — it is the reason an attacker can't reach the marketing or tenant app via the admin host.
- `app.<domain>` is the **application host**; the bare root 302s to `/login` (worker L444), and `/dashboard` without an operator cookie 302s to login (`unauthenticatedDashboardRedirectUrl`, index.js L709).
- A **tenant subdomain** (`acme.hr.com`) or a **bound custom domain** (`hr.acme.com`) resolves to the tenant's surface — for us, the **ESS portal** by default, with the tenant admin always canonical on `app.hr.com` (Sitepresso intentionally keeps `/admin` off the tenant host and redirects it to `app.<domain>/dashboard` via `unifiedAdminRedirectUrl`, index.js L726; we keep that invariant).

**Reserved subdomains** (`RESERVED_SUBDOMAINS` set, router index.js L81): `www, api, admin, app, mail, platform, m, test`. We extend this with HR-specific reserves: `payroll, ess, status, docs`.

### 2.1 Surface ↔ host decision table (exact router behavior)

| Incoming `Host` | Path | Resolves to | Mechanism (Sitepresso fn) |
|---|---|---|---|
| `hr.com`, `www.hr.com` | any | `apps/marketing` (PLATFORM_PORT) | `resolveRoute` reserved/empty subdomain branch |
| `admin.hr.com` | `/login`,`/superadmin/*` | `apps/platform` | allow-listed in `ADMIN_HOST_ALLOWED_PREFIXES` |
| `admin.hr.com` | anything else | 302 → `/login` | `adminHostLoginRedirectUrl` |
| `app.hr.com` | `/` | 302 → `/login` | worker `subdomain==='app'` branch |
| `app.hr.com` | `/dashboard/*` (no cookie) | 302 → `/login?redirect=…` | `unauthenticatedDashboardRedirectUrl` |
| `app.hr.com` | `/dashboard/*` (authed) | `apps/hr-admin` | proxy to app port |
| `acme.hr.com` | `/admin/*` | 302 → `app.hr.com/dashboard` | `unifiedAdminRedirectUrl` |
| `acme.hr.com` | else | `apps/ess` (tenant resolved by subdomain) | `lookupVerticalFromBackend(subdomain)` → here a fixed `HR` vertical (NB: `Business.vertical` today is `'STATIC'\|'APPOINTMENT'\|'ECOMMERCE'`, default `APPOINTMENT`, schema L227 — we replace the enum domain with a single `HR` value during the fork) |
| `hr.acme.com` (bound custom domain) | any | `apps/ess` for that tenant | `lookupDomainRouteFromBackend(host)` → `/api/internal/domain-route` |
| `api.hr.com` | `/api/*` | `backend` (BACKEND_PORT) | `passthrough` set / `/api` prefix branch |

> **Simplification vs. Sitepresso:** Sitepresso routes a *vertical* (`booking|shop|web`) and many sub-apps (staff/customer/manager/delivery) per tenant host. We have **exactly one tenant-facing app per host** (ESS), so `SUB_APP_PORTS`, `CUSTOMER_PATHS`, `ASSET_PREFIX_SUBAPP`, and the `tenantScopedUrl` slug-rewrite machinery (router index.js L317–L408) collapse to a single target. We keep the file but reduce `PUBLIC_PORTS`/`SUB_APP_PORTS` to `{ hr: <ess_port> }`. This removes ~60% of the router's branching surface and the entire asset-prefix-routing class of bugs.

---

## 3. Tenant Resolution by `Host` Header

Tenant resolution is a **two-tier cache + single indexed DB lookup**, inherited directly from Sitepresso and kept almost verbatim.

### 3.1 The resolution pipeline (edge → router → backend)

```
Request (Host: acme.hr.com)
  │
  ├─ Tier 0  Cloudflare Worker (apps/router/cloudflare-worker.js)
  │     resolveEnvForHost(host) → apex match (hr.com)
  │     subdomain = "acme"; not reserved
  │     lookupVertical("acme")  ─── KV cache (ROUTER_CACHE, 60s) ──┐
  │                                                                │ miss
  │     GET {BACKEND_API}/api/internal/tenant-vertical?slug=acme ──┘ (x-internal-secret)
  │     → { vertical: "HR", slug: "acme" }  → proxy to ESS origin
  │     (sets x-tenant-host / x-sitepresso-host / x-tenant-slug)
  │
  ├─ Tier 1  Node router (apps/router/index.js) — the on-box path behind cloudflared tunnel
  │     redis.get("vertical:acme")  (60s TTL)  ─── miss ──┐
  │     lookupVerticalFromBackend("acme") ────────────────┘
  │     resolveSubAppPort → ESS port; proxy.web()
  │     forwards x-tenant-host = acme.hr.com on EVERY request (index.js L813)
  │
  └─ Tier 2  Backend (Express) — authoritative
        GET /api/internal/tenant-vertical (backend/src/core/routes/internal.routes.js)
          slug → prisma.business.findUnique({ where:{ slug } })
          host → prisma.business.findFirst({ subscription: routableCustomDomainWhere(host) })
        setTenantVertical(...) writes back to Redis (24h authoritative TTL)
```

**Why this is correct and fast:** the hot path is a KV/Redis hit (sub-ms). The DB is touched at most once per tenant per TTL window, and the query is a single indexed lookup on `Business.slug` (`@unique`) or on the custom-domain index. The 60s TTL at the edge (vs. 24h authoritative) bounds staleness when a tenant is suspended/deleted — see Sitepresso's own comment at router index.js L636.

### 3.2 How `businessId` becomes ambient on the request

There are **two** resolution contexts and they must not be conflated:

1. **Surface/app routing** (which app renders) — by `Host` subdomain or custom domain, done in the router (above). This produces `x-tenant-host` / `x-tenant-slug`.
2. **API authorization scope** (which `businessId` a logged-in principal may touch) — done in the backend from the **JWT**, NOT the host. `req.user.businessId` comes from the authenticated `User`/`Customer` row (`USER_SELECT.businessId` in `auth.middleware.js` L26). The host is used only as a **cross-check** that an ESS/customer session belongs to the tenant whose domain it arrived on (`resolveTenantBusinessId` + the 403 guard in `authenticateCustomer`, auth.middleware.js L244–L247). We keep this defense-in-depth: a stolen employee token replayed against another tenant's host is rejected.

The HR equivalent of `resolveTenantBusinessId` (auth.middleware.js L92) maps `acme.hr.com` → `Business.slug='acme'` → `businessId`, and for bound custom domains it must additionally consult the custom-domain table (Sitepresso retired BYO lookup at L120; **we re-enable it** because ESS lives on custom domains).

### 3.3 Edge cases & validation rules (resolution)

| Case | Behavior | Source |
|---|---|---|
| Unknown subdomain | Branded 404 "No portal connected", `X-Robots-Tag: noindex`, `Cache-Control: no-store` | `tenantNotFoundRoute` (index.js L577) |
| Suspended tenant (`Business.isActive=false` / `suspendedAt`) | Router still resolves; **backend** returns 423/403 + a "tenant suspended" ESS splash. We add an `isActive` check to `/api/internal/tenant-vertical` so suspended tenants 404 at the edge within ≤60s. | `Business.isActive`, `suspendedReason`, `suspendedAt` (schema L163–L165) |
| `www.` prefix on a custom apex | Normalized + apex/www both matched | `customDomainLookupHosts` (customDomainRouting.js L26) |
| Reserved subdomain collides with a tenant slug | Reserved wins (slug creation must reject reserved names) — enforce at signup | `RESERVED_SUBDOMAINS` |
| Tenant renamed slug | `slugLastChangedAt` recorded; old subdomain 404s after TTL; we issue a 301 from old→new for a grace window | `Business.slug`, `slugLastChangedAt` (schema L111–L112) |
| Custom domain DNS broke post-launch | Domain sweep re-checks; status flips, ESS stays on `<tenant>.hr.com` fallback | `processCustomDomainProvisioning` (scheduler.js L560) |

---

## 4. Custom-Domain Binding + SSL

We inherit **Cloudflare-for-SaaS Custom Hostnames** end-to-end. This is the single biggest reuse win after the router. A tenant may bind `careers.acme.com` or `hr.acme.com` to their ESS portal; we provision DNS validation + an edge TLS certificate automatically.

### 4.1 Data model (lives on the tenant's subscription record)

From `backend/prisma/schema.prisma` (Subscription, L1568–L1587):

| Field | Type | Meaning |
|---|---|---|
| `customDomain` | `String?` | the bound hostname (e.g. `hr.acme.com`) |
| `customDomainVerified` | `Boolean` | DNS + ownership verified |
| `customHostnameId` | `String?` | Cloudflare-for-SaaS custom hostname id |
| `customDomainStatus` | `String?` (`NONE`/`PENDING_DNS`/`PENDING_SSL`/`ACTIVE`/`FAILED`) | state-machine value |
| `customDomainStatusMessage` | `String?` | human guidance ("add this CNAME") |
| `customDomainCheckedAt` | `DateTime?` | last sweep timestamp |

> **HR refinement:** custom domains belong to the **ESS** surface, not a storefront. We move these fields to a cleaner `TenantDomain` model (1:1 with `Business`) in `03-data-model.md`, but keep the exact status vocabulary so `customDomainRouting.js` and the provisioning cron work unchanged.

### 4.2 Binding state machine

```
        ┌─────────────────────────────────────────────────────────┐
        │                                                          │
NONE ──(admin enters domain)──► PENDING_DNS ──(CNAME present)──► PENDING_SSL ──(cert issued)──► ACTIVE
        │                          │                                  │                           │
        │                          │ (sweep finds no CNAME after N)   │ (cert fails / CAA block)  │ (DNS later breaks)
        ▼                          ▼                                  ▼                           ▼
      (delete)                  FAILED ◄───────────────────────────FAILED                       FAILED
```

- **Routable while pending:** `ROUTABLE_CUSTOM_DOMAIN_STATUSES = ['ACTIVE','PENDING_DNS','PENDING_SSL','FAILED']` (customDomainRouting.js L1) — a tenant can preview ESS on the custom domain before the cert lands; SEO/indexing stays paused until `ACTIVE`.
- **Provisioning loop:** `processCustomDomainProvisioning()` (scheduler.js L560) runs every 5 min, calls `provisionCustomDomain()`, registers/refreshes the Cloudflare custom hostname, and persists the resulting status. We keep this cron cadence; binding does not need a job queue.
- **Apex vs www:** `isLikelyApexDomain` (customDomainRouting.js L19) + the `COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES` set already cover `co.in`, `co.nz`, `com.au`, etc. — directly relevant to IN/NZ tenants. We extend the set with `net.nz`, `govt.nz` defensively.
- **Redirect mode:** `domainRedirectUrl` (router index.js L463) supports binding `acme.com` → canonical host with a 301, for tenants who want their apex to forward.

### 4.3 SSL specifics & the edge

- Cloudflare-for-SaaS issues + renews the per-hostname certificate; we never touch ACME directly. The Worker terminates TLS; origin is reached over the cloudflared tunnel (or directly via `api.`/origin records). This is Sitepresso's exact production posture (`apps/router/cloudflare-worker.js` header comment + `passthrough` for `api`).
- **DCV (Domain Control Validation):** delegated DCV via a one-time `_acme-challenge` / Cloudflare-provided CNAME; surfaced to the tenant admin as `customDomainStatusMessage`.
- **Caching:** the router caches `domain-route:<host>` for 60s in Redis (`lookupDomainRouteFromBackend`, index.js L431) so a bound domain resolves without hammering the backend.

### 4.4 Edge cases (custom domain)

| Case | Handling |
|---|---|
| Tenant points domain at us before adding the CNAME | `PENDING_DNS`, sweep retries, admin sees "add this record" |
| CAA record blocks Cloudflare CA | `FAILED` with explicit message; admin must add CAA for the issuing CA |
| Domain later expires / DNS removed | Sweep flips status; ESS auto-falls back to `<tenant>.hr.com`; `customDomain` nulled by the renewal/cleanup path (scheduler.js L644 pattern) |
| Two tenants claim the same domain | **GAP in the fork base:** `Subscription.customDomain` in the live Sitepresso schema is a plain `String?` with **no** `@unique`/`@@unique` constraint — so the DB does *not* currently reject a duplicate bind. Sitepresso relies on the bind-time controller check + Cloudflare-for-SaaS rejecting a custom hostname already claimed in the zone. **We must ADD** a partial unique index on the new `TenantDomain` model: `@@unique([customDomain])` (or a Postgres partial unique index `WHERE customDomain IS NOT NULL`), AND keep the application-layer pre-check, AND rely on Cloudflare's per-hostname uniqueness as the third layer. Without the DB constraint a race between two tenants binding the same host could double-bind. This is a tracked hardening item, not a property we inherit. |
| White-label requirement: no "hr.com" leakage | ESS served on the custom host must emit tenant branding only; the branded 404 and any platform chrome are suppressed on bound hosts (we gate the Sitepresso `unknownSiteHtml` so it never shows platform logo on a tenant's own domain) |

---

## 5. Multi-Tenant Data Isolation (row-level `businessId`)

### 5.1 The invariant

Every tenant-owned table has a non-null `businessId String` FK to `Business.id` (`uuid`), and **every** query that reads/writes tenant data is filtered by it. Sitepresso enforces this by convention across 162 models and 421 `businessId` columns; we adopt the same discipline and harden it (below).

```prisma
model Employee {
  id          String   @id @default(uuid())
  businessId  String                       // ← tenant key, NEVER null for tenant data
  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  // ...
  @@index([businessId])                    // every tenant table indexes businessId first
  @@unique([businessId, employeeCode])      // tenant-scoped uniqueness, NOT global
}
```

**Rules (enforced in review + lint):**
1. Tenant tables index `businessId` first; composite uniques are **always** `[businessId, …]`, never a bare global unique on a tenant field (mirrors Sitepresso's `@@unique([businessId, code])` coupon pattern).
2. `onDelete: Cascade` from `Business` so tenant offboarding is a single delete (plus the GDPR soft-delete grace, below).
3. No raw SQL without an explicit `businessId` predicate; raw queries go through a reviewed helper.

### 5.2 Enforcement layers (defense in depth)

| Layer | Mechanism | Sitepresso source |
|---|---|---|
| **Routing** | Host → app; cross-host token replay rejected | `resolveTenantBusinessId` 403 (auth.middleware.js L244) |
| **AuthN** | JWT carries `businessId`; user/customer row re-fetched and `isActive` checked every request | `authenticateOperator` / `authenticateCustomer` |
| **AuthZ (role)** | `requireRole` / `requireAnyRole`; SUPER_ADMIN bypass is explicit | auth.middleware.js L265–L283 |
| **AuthZ (permission)** | Fine-grained `requirePermission(key)` + relational grants | `requirePermission`, `requireEcomPermission` (auth.middleware.js L295, L337) |
| **Scope guard** | `requireBusiness` blocks endpoints when `req.user.businessId` is absent | `requireBusiness.js` |
| **Query** | Controllers filter by `req.user.businessId`; `findOwned` helper centralizes "fetch row IFF it belongs to this tenant" | `core/lib/findOwned.js` |

### 5.3 Hardening we add over the fork (payroll handles money)

Sitepresso's isolation is **convention-based** (every controller remembers to filter). For a payroll product that is not good enough. We add:

1. **Prisma client extension / middleware** that injects `businessId` into every `find*`/`update*`/`delete*` on tenant models, sourced from an AsyncLocalStorage request context set right after auth. A query that forgets the filter is *automatically* scoped, and a query that tries to cross tenants throws. This is the belt to Sitepresso's suspenders. **Implementation note for the fork:** the extended client (`prisma.$extends(...)`) returns a *new* client object, but Sitepresso's `prisma.js` exports a `globalThis`-cached singleton **and** installs a `Proxy` on `PrismaClient` that forces every legacy `new PrismaClient()` (≈15 call sites — `notifications/router.js`, `webhookDispatcher.js`, `orderCoupon.js`, controllers, …) to return that singleton. We must therefore apply `$extends` **at the singleton definition** and re-export the extended client (and keep the Proxy pointing at the extended instance), or those stray instantiations will bypass the scoping extension entirely. This is a concrete, easy-to-get-wrong fork task, not a drop-in.
2. **Postgres Row-Level Security (RLS)** as the last line: `CREATE POLICY tenant_isolation USING (business_id = current_setting('app.current_business_id')::uuid)` on the highest-sensitivity tables (`PayRun`, `Payslip`, `EmployeeBankAccount`, `StatutoryFiling`). Even a SQL-injection or a forgotten filter cannot leak another tenant's payslips. **Pooled-connection hazard (must get right):** the fork uses **one shared `PrismaClient` pool** (`prisma.js` singleton), so the session var MUST be set with **`SET LOCAL app.current_business_id` inside an explicit `prisma.$transaction(...)`** — a plain `SET` leaks the value to the next request that reuses the pooled connection, which would be a cross-tenant breach *worse* than no RLS. If we front Postgres with PgBouncer in **transaction** pooling mode, `SET LOCAL` is the only safe form (session-level `SET` is incompatible with transaction pooling). The AsyncLocalStorage context (item 1) feeds the `businessId` into that transaction wrapper. SUPER_ADMIN/impersonation uses a `BYPASSRLS` service role through an audited path only. None of this exists in the fork today (no `$extends`, no `$transaction` session-var pattern, no RLS) — it is **all NEW** and is the top pre-launch isolation workstream.
3. **Field-level encryption** for the crown jewels — bank account numbers, IFSC/branch, IRD/PAN/Aadhaar-last-4, salary — encrypted at the application layer (envelope encryption, KMS-managed DEK per region) so a DB dump is not a payroll breach. (Detailed in `08-security-and-audit.md`.)

### 5.4 The employee principal (ESS)

Sitepresso has two principal types: `User` (operators/staff with `role`) and `Customer` (storefront end-users, business-scoped). We map **employees onto the `Customer` lineage** because it already encodes exactly what we need:

- `Customer.businessId` (tenant scope), `isActive`, `anonymisedAt` (GDPR), `passwordChangedAt` (token revocation), separate cookie namespace + JWT `type:'customer'` (auth.middleware.js L226), and the **host-cross-check 403**.
- We rename the concept to `Employee` in the HR schema but reuse the `authenticateCustomer` machinery so ESS sessions get cross-tenant isolation for free. An employee who is also an HR admin gets a linked `User` row for the `app.hr.com` console.

This split keeps the ESS attack surface (employees, the largest population) cleanly separated from the operator/admin surface — a property we get **for free** from the fork.

### 5.5 Tenant lifecycle & GDPR/DPDP

- **Suspend:** `Business.isActive=false`, `suspendedAt`, `suspendedReason` (schema L163). Pay runs blocked; ESS shows a notice; data retained.
- **Soft-delete with grace:** `pendingDeletionAt` + `anonymisedAt` (schema L169–L170). Sitepresso's `sweepExpiredDeletions` cron (scheduler.js L1147) purges after 30 days, anonymising PII while keeping transaction shells. **Payroll caveat:** statutory records (payslips, filings, Form 16/130, IR348) have **legal retention minimums** (IN: 8 years for various registers; NZ: 7 years for wage/time/holiday records under the Holidays Act/Employment Relations Act). Our deletion sweep must therefore **anonymise but retain statutory artifacts** for the retention window, not hard-delete them. This is a deliberate divergence from Sitepresso's purge.

---

## 6. Service Boundaries & Payroll-Engine Placement

### 6.1 The shape: modular monolith backend + pure calc packages + a queue worker tier

We deliberately **do not** go microservices at launch. Sitepresso runs a single clustered Express process (`ecosystem.config.js` → `sitepresso-backend` in `exec_mode: 'cluster'`) plus a separate scheduler process (`scheduler-worker.js`). We mirror that and add a **payroll worker tier**:

```
                         ┌──────────────────────────────────────────────┐
   Cloudflare ──tunnel──►│  Node router (apps/router)                    │
                         └──────────────────────────────────────────────┘
                              │ /api/*           │ app hosts
                              ▼                  ▼
        ┌───────────────────────────────┐   ┌───────────────────────────┐
        │  backend API (Express, cluster)│   │ Next.js apps (marketing,   │
        │  src/core  src/hr  src/superadmin│  │ platform, hr-admin, ess)   │
        │  src/domains                    │   └───────────────────────────┘
        └───────────────────────────────┘
              │ enqueues jobs (BullMQ)            │ reads/writes
              ▼                                   ▼
        ┌───────────────────────────────┐   ┌───────────────────────────┐
        │  Payroll workers (BullMQ tier) │   │ PostgreSQL (Prisma)        │
        │  pay-run, filing, payslip-pdf  │◄─►│ + Redis (cache + queues)   │
        │  uses packages/payroll-core,   │   └───────────────────────────┘
        │  compliance-in, compliance-nz  │
        └───────────────────────────────┘
              │ submits                          
              ▼                                   
        ┌───────────────────────────────────────────────────────────────┐
        │ External SoR: IRD (payday filing), TRACES/Income-Tax (24Q/TDS),│
        │ EPFO (ECR), ESIC, bank payment files (NEFT/RTGS / NZ direct    │
        │ credit), gateways (Razorpay/Stripe/Paddle for OUR billing)     │
        └───────────────────────────────────────────────────────────────┘
```

### 6.2 Logical service boundaries inside the modular monolith

Each is a directory under `backend/src/hr/` with its own controllers, services, and a thin public interface. They share the Prisma client but **own** their tables.

| Module | Owns | Talks to |
|---|---|---|
| `identity` | Employee, EmploymentContract, org structure, manager tree | core auth |
| `time` | Attendance, shifts, timesheets, biometric/punch ingest | leave, payroll |
| `leave` | Leave types, balances, requests, NZ Holidays-Act accruals | time, payroll |
| `compensation` | Salary structure, components, CTC, revisions, the 50%-wage rule engine | payroll |
| `payroll` | **PayRun** state machine, payslips, arrears, off-cycle, bank files | compensation, leave, compliance, filing |
| `compliance` | Versioned IN/NZ rule tables, calculators (delegates to `packages/compliance-*`) | payroll, filing |
| `filing` | Statutory submission pipelines (payday filing, 24Q/138, ECR, ESIC) + receipts | payroll, external SoR |
| `documents` | Payslip PDFs, Form 16/130, IR certificates, registers | object storage (`core/lib/s3.js`) |

**Boundary rule:** modules call each other only through their service interface (a function module), never by reaching into another module's Prisma models. This keeps the option open to extract `payroll`/`filing` into separate deployables later without a rewrite.

### 6.3 Payroll engine placement — the most important decision

The payroll **calculation** lives in **pure, deterministic, I/O-free packages** (`packages/payroll-core`, `packages/compliance-in`, `packages/compliance-nz`). The **orchestration** (load inputs → compute → persist → file → pay) lives in the **payroll worker tier**. This separation is non-negotiable and buys us:

1. **Provable correctness.** The calc packages take a frozen input snapshot + a pinned rule-set version and return a result with no clock, no DB, no network. They are unit-tested against golden vectors (the NZ Holidays Act in particular — our flagship — gets thousands of property-based test cases). A pay run is reproducible byte-for-byte.
2. **Determinism & reproducibility.** Re-running `compute(snapshot, rulesetVersion)` next year yields the identical result, which is exactly what an auditor or a tax dispute requires.
3. **Placement away from the request path.** Calculation never runs in an HTTP handler. The HR admin *triggers* a run (a fast 202 + job id); workers compute. This mirrors Sitepresso's gateway pattern where the webhook endpoint ACKs fast and a drain does the work (scheduler.js L1026 comment: "The endpoint returns quickly; this sweep is the reliability backstop").

```
packages/payroll-core/         # orchestration-agnostic primitives
  money.ts                     # integer-minor-unit money (paise/cents), banker's rounding policy
  proration.ts                 # mid-period joiners/leavers, LWP, calendar-day vs working-day
  components.ts                 # earnings/deductions component graph evaluation (ordered, cyclic-safe)
  result.ts                    # PayrollResult: per-component lines + statutory lines + net + audit trail

packages/compliance-in/
  wages.ts                     # 50%-of-remuneration "wages" recompute (Code on Wages, 21 Nov 2025)
  pf.ts esi.ts pt.ts tds.ts gratuity.ts   # each pure, reads a rule-table version
packages/compliance-nz/
  paye.ts kiwisaver.ts esct.ts acc.ts studentloan.ts
  holidays/                    # Holidays Act 2003 — RDP vs ADP, alt days, accruals (THE hard one)
```

### 6.4 Money & rounding (engine-wide policy)

- All money is **integer minor units** (paise for INR, cents for NZD) inside the engine; no floats. We do NOT reuse Sitepresso's `core/lib/currency.js` storefront pricing math for payroll — payroll rounding is statutory.
- Rounding is **per-statute**: e.g. EPF contributions round to the rupee per EPFO rules; PAYE per IRD tables; net pay to the smallest payable unit. The rounding policy is part of the pinned rule-set, not a global constant.
- FX (INR↔NZD) never enters a pay run — each tenant pays employees in their own market currency. FX only appears in OUR billing of the tenant (§ billing doc).

---

## 7. Background Jobs, Queues & the Pay-Run / Filing Pipelines

### 7.1 The queue gap in the fork — and how we close it

**Sitepresso has no job queue.** It has `ioredis` (`backend/package.json` L41) and `node-cron` (L43), and runs ~25 cron sweeps in `scheduler.js` (`initScheduler`, L941) on a dedicated `scheduler-worker.js` process. That model is fine for "every 5 min, scan for stale orders / drain webhooks." It is **wrong** for payroll because:

- A pay run must be **exactly-once per (tenant, period)** with an idempotency key — a double-tick must not pay people twice.
- It must be **resumable** after a crash mid-run (1,000-employee tenant, worker OOMs at employee 600).
- It needs **per-job state, retries with backoff, dead-letter, and progress** visible to the HR admin.
- Filing submissions need **ordered, rate-limited, retried** delivery to government endpoints with immutable receipts.

So we **add BullMQ** (on the existing Redis) as the queue layer, while **keeping `node-cron` for the genuinely periodic, idempotent sweeps** (domain provisioning, reminders, billing-webhook drains, dunning) exactly as Sitepresso does. The two coexist: cron schedules *when* something should be considered; BullMQ owns *durable execution*.

> ADR: BullMQ over a DB-polling cron for payroll. Rationale: native idempotency (jobId), retry/backoff, flows (parent/child for fan-out per employee), and rate-limited queues for government endpoints — all of which we'd otherwise hand-roll on top of `node-cron` + advisory locks.

### 7.2 Queues

| Queue | Producer | Concurrency | Idempotency key | Notes |
|---|---|---|---|---|
| `payrun.orchestrate` | HR admin "Run Payroll" → API 202 | 1 per tenant (tenant-scoped rate limiter) | `payrun:{businessId}:{periodId}` | Parent job; fans out per-employee child jobs (BullMQ Flows) |
| `payrun.employee` | parent flow | N (tunable) | `payslip:{payRunId}:{employeeId}` | Pure compute via `payroll-core`; writes draft Payslip |
| `payslip.pdf` | on APPROVED | N | `pdf:{payslipId}:{version}` | Renders + stores to S3 (`core/lib/s3.js`) |
| `filing.nz.payday` | on PAID (NZ) | 1, rate-limited to IRD | `payday:{payRunId}` | ≤2 working-day SLA; see §7.5 |
| `filing.in.tds` / `filing.in.ecr` / `filing.in.esic` | on PAID (IN) / monthly | 1, rate-limited | `tds:{businessId}:{period}` etc. | Deposit by 7th (TDS), 15th (PF/ESI) |
| `bankfile.generate` | on APPROVED | 1 per tenant | `bankfile:{payRunId}` | NEFT/RTGS (IN) / direct-credit batch (NZ) |
| `notify.payslip` | on PUBLISH | N | `notify:{payslipId}` | Reuses `core/lib/notifications/router.js` cascade |

### 7.3 The Pay-Run state machine (the heart of the system)

```
DRAFT ──(lock inputs)──► INPUTS_LOCKED ──(enqueue compute)──► CALCULATING
   ▲                                                              │
   │ (reopen, pre-approval only)                                  ▼
   └────────────────────────────────────────── CALCULATED ◄──(all employee jobs done)
                                                    │
                          (HR reviews variances)    │
                                                    ▼
                                   APPROVED ──(generate bank file + payslips)──► READY_TO_PAY
                                                    │
                            (bank file released)    ▼
                                                  PAID ──(enqueue statutory filings)──► FILING
                                                    │                                      │
                                                    │            (all receipts in)         ▼
                                                    └──────────────────────────────────► CLOSED
   any state ──(fatal/abandon, pre-PAID only)──► CANCELLED
```

**Transition guards (validation rules):**

| Transition | Guard |
|---|---|
| `DRAFT→INPUTS_LOCKED` | tenant `isActive`; period not already run; attendance/leave finalized for the period; no employee with missing mandatory statutory IDs (PF/UAN, ESIC, PAN for IN; IRD number, tax code, KiwiSaver status for NZ) unless explicitly exempted |
| `INPUTS_LOCKED→CALCULATING` | a frozen **input snapshot** is persisted (employees, comp structures, attendance, leave, the **pinned rule-set version** for the tenant's country); the snapshot is immutable |
| `CALCULATING→CALCULATED` | every `payrun.employee` child job succeeded; failures park the run, do not advance |
| `CALCULATED→APPROVED` | requires `payroll.approve` permission; **maker≠checker** (the user who created the run cannot approve it) for tenants on plans that enable segregation-of-duties; variance report acknowledged |
| `APPROVED→READY_TO_PAY` | bank file generated + checksummed; payslips rendered |
| `READY_TO_PAY→PAID` | bank file released / payment confirmed (manual confirm or bank API callback) |
| `PAID→FILING` | auto; filings enqueued with deadline metadata |
| `FILING→CLOSED` | all required filings have ACCEPTED receipts (or are explicitly deferred with a reason) |
| `*→CANCELLED` | only before `PAID`; after `PAID` the corrective path is an **off-cycle/adjustment run**, never a cancel |

**Idempotency & crash-safety:** the orchestrator job is keyed `payrun:{businessId}:{periodId}`; re-enqueue is a no-op if a non-terminal run exists. Each per-employee job is keyed by `{payRunId}:{employeeId}`, so a worker restart re-runs only the unfinished employees. The input snapshot guarantees a resumed run computes against the same data even if the tenant edited an employee mid-run.

> **Critical correctness note — BullMQ `jobId` is NOT a sufficient exactly-once guarantee.** BullMQ deduplicates only while a job with that `jobId` is *active/waiting/delayed*; once the job **completes and is evicted** (or if `removeOnComplete` is set), re-adding the same `jobId` enqueues a *new* job. So "exactly-once per (tenant, period)" cannot rest on the queue alone. The authoritative guard is a **DB unique constraint `@@unique([businessId, periodId, sequence])`** on `PayRun` (where `sequence` distinguishes the regular run from explicit off-cycle/adjustment runs), created **before** enqueue inside a transaction. The orchestrator's first action is "insert-or-find the `PayRun` row"; the queue job is merely the executor. A double-click, a retried 202, and a BullMQ re-add all collapse onto the same `PayRun` row — the DB, not Redis, is the source of exactly-once. This is the difference between "we usually don't double-pay" and "we provably cannot."

### 7.4 Off-cycle, arrears & corrections

- **Off-cycle run:** bonuses, final settlement (F&F), mid-month joiners. Same state machine, flagged `OFF_CYCLE`, links to the parent period.
- **Arrears:** retro salary revisions recompute affected past periods *in the calc package* and emit arrears lines in the next run — never silently mutate a `CLOSED` payslip. A closed payslip is immutable; corrections are additive.
- **Reversal:** a `PAID` run that was wrong spawns a compensating adjustment run; the original stays in the ledger (audit-grade).

### 7.5 NZ Payday Filing pipeline (flagship reliability requirement)

NZ requires **Employment Information filed within 2 working days of each payday** to IRD (verified 2026-06-22). This is modeled exactly like Sitepresso's webhook drains but **outbound** and **deadline-driven**:

```
PayRun → PAID (NZ)
   │ enqueue filing.nz.payday  (jobId = payday:{payRunId}, deadline = nextWorkingDay+2, IRD endpoint, ESCT/PAYE/KiwiSaver/SL totals)
   ▼
[filing worker]  build EI payload (per-employee lines) → submit to IRD gateway (myIR/gateway services)
   │ success → store immutable FilingReceipt (IRD ack id) → mark SUBMITTED
   │ transient fail → BullMQ retry w/ exponential backoff, capped before the 2-working-day deadline
   │ deadline approaching & still failing → escalate (alert ops + tenant), surface in Super Admin compliance dashboard
   ▼
Reconciliation cron (node-cron, mirrors processStripeWebhookRetries):
   scan SUBMITTED-without-ACK and PENDING-past-threshold filings → re-poll IRD → converge state
```

This reuses the **shape** of `processStripeWebhookRetries` (scheduler.js L690) / `reconcileStuckRazorpaySubscriptionsTask` (scheduler.js L703) — ACK-fast, drain-durably, reconcile-on-a-timer — applied to a government endpoint. A **working-day calendar** per country (with NZ public holidays, including regional anniversary days) drives the deadline math; the calendar is itself a versioned compliance table.

### 7.6 IN deposit & return pipeline

| Obligation | Cadence | Deadline (2026, verified) | Queue/cron |
|---|---|---|---|
| TDS on salary deposit | monthly | 7th of following month (30 Apr for March payroll) | `filing.in.tds` |
| EPF (ECR) deposit | monthly | 15th of following month | `filing.in.ecr` |
| ESI deposit | monthly | 15th of following month | `filing.in.esic` |
| Form 24Q → **Form 138** (TY 2026-27+) | quarterly | Q1 31 Jul, Q2 31 Oct, Q3 31 Jan, Q4 31 May | `filing.in.24q` |
| Form 16 → **Form 130** (TY 2026-27+) issuance | annual | 15 Jun after FY end | `documents` |

> **Verified nuance:** under the Income Tax Act 2025, Form 16 is renumbered **Form 130** and Form 24Q becomes **Form 138**, effective Tax Year 2026-27 (from 1 Apr 2026); for FY 2025-26 the legacy Form 16/24Q numbering still applies. The engine selects the form template by the pinned rule-set's effective date — never a hard-coded form name. (Sources at end.)

### 7.7 Worker deployment (ecosystem)

Following `ecosystem.config.js`, we declare PM2 processes:
- `hr-backend` (Express API, `exec_mode: cluster`),
- `hr-scheduler` (node-cron sweeps, `scheduler-worker.js` analog),
- `hr-payroll-workers` (BullMQ consumers, separate process, horizontally scalable, memory-capped per the `max_memory_restart` discipline),
- `hr-filing-workers` (lower concurrency, rate-limited to government endpoints).
Separating payroll/filing workers from the API process means a heavy 5,000-employee run never starves request latency — the same reason Sitepresso isolates the scheduler.

---

## 8. Compliance Rule Tables (versioned, Super-Admin-owned)

This is the spine that makes correctness provable and updates safe. It is **not** in scope to fully specify here (see `05-compliance-IN.md` / `06-compliance-NZ.md`), but the **architecture** is:

### 8.1 Shape

```prisma
model ComplianceRuleSet {
  id            String   @id @default(uuid())
  country       String   // 'IN' | 'NZ'
  version       Int      // monotonically increasing per country
  effectiveFrom DateTime // when this set becomes the law (e.g. 2026-04-01)
  effectiveTo   DateTime?
  status        String   // DRAFT | PUBLISHED | SUPERSEDED
  publishedBy   String?  // SUPER_ADMIN user id
  rules         Json     // the actual rate/threshold/slab payload (typed per country)
  createdAt     DateTime @default(now())
  @@unique([country, version])
  @@index([country, effectiveFrom])
}
```

- **Owned by Super Admin** at `admin.hr.com` — operators edit DRAFT, then PUBLISH. Tenants never touch these.
- A **pay run pins `complianceRuleSetId`** at `INPUTS_LOCKED`. The result is forever reproducible against that exact rule set.
- Updating rates for a new tax year = publishing a new version with a future `effectiveFrom`; no code deploy needed for a rate change.

### 8.2 The figures the rule tables encode (verified 2026-06-22, with effective dates)

**India (effective from the dates shown):**

| Rule | Value | Effective |
|---|---|---|
| New Labour Codes live (Code on Wages / Social Security / IR / OSH) | in force | **21 Nov 2025** |
| "Wages" definition: Basic+DA must be ≥ 50% of total remuneration; excess allowances reclassified as wages | ≥ 50% | 21 Nov 2025 (cascades to PF & gratuity) |
| EPF employee / employer | 12% / 12% (employer split: EPS 8.33% capped at ₹15,000 wage = ₹1,250/mo; EPF 3.67%; + EDLI + admin) | current |
| EPF mandatory threshold | 20+ employees | current |
| ESI employee / employer | 0.75% / 3.25% (total 4%) on gross ≤ **₹21,000/mo** (₹25,000 for persons with disability) | unchanged since 2017 (₹30,000 hike **proposed, not yet notified** as of Mar 2026 — flag) |
| ESI mandatory threshold | 10 employees | current |
| Professional Tax | **state-specific** slabs, capped **₹2,500/yr** | per-state |
| Gratuity | 15/26 × last drawn × years of service | current |
| New tax regime | **DEFAULT** (old regime opt-in); §87A → nil tax up to ~₹12L taxable; standard deduction **₹75,000**; +4% cess | FY 2025-26 / from AY |
| TDS deposit | by **7th** of following month (March: 30 Apr) | current |
| PF & ESI deposit | by **15th** | current |
| Form 24Q quarterly | Q1 31 Jul, Q2 31 Oct, Q3 31 Jan, Q4 31 May | current |
| Form renumbering: 16→**130**, 24Q→**138** | under Income Tax Act 2025 | **TY 2026-27 (from 1 Apr 2026)**; Form 16/24Q for FY 2025-26 |
| Mandatory digital wage/attendance registers + payslips | required | under Labour Codes |

**New Zealand (effective 1 Apr 2026 unless noted):**

| Rule | Value | Effective |
|---|---|---|
| KiwiSaver default min (employee & employer) | 3% → **3.5%** (then 4% in 2028) | **1 Apr 2026** |
| 16–17 year-olds eligible for employer KiwiSaver contributions | newly eligible | 1 Apr 2026 |
| Temporary rate reduction (stay at 3% for 3–12 months) | available | applications from 1 Feb 2026 |
| ACC earners' levy | 1.67% → **1.75%** per $100 liable earnings | 1 Apr 2026 |
| ACC max liable earnings cap | **$156,641** (max levy **$2,741.22**) | 2026-27 year |
| Adult minimum wage | **$23.95/hr** | 1 Apr 2026 |
| PAYE + **payday filing** to IRD | Employment Information within **2 working days** of each payday (electronic) | current |
| ESCT on employer KiwiSaver contributions | per ESCT thresholds | current |
| Student loan deductions | per IRD rates | current |
| Holidays Act 2003 | annual leave in **weeks**; RDP vs ADP; alternative/lieu days; sick/bereavement/public holidays | current — **flagship NZ feature** |

The **Holidays Act 2003** is explicitly the hardest, highest-value calculation (annual leave measured in weeks, relevant-daily-pay vs average-daily-pay, alternative/lieu days). Its calculators live in `packages/compliance-nz/holidays/` with exhaustive golden-vector tests; provable correctness here is our flagship NZ differentiator. Detailed in `06-compliance-NZ.md`.

---

## 9. Scalability, Multi-Region & Data Residency

### 9.1 Horizontal scale

- **Stateless API** (`exec_mode: cluster`) scales by adding instances behind the router; sessions are JWT (no sticky sessions). This is Sitepresso's existing posture.
- **Read scaling:** Postgres read replicas for the analytics/Super-Admin reporting path; pay-run writes always hit primary.
- **Worker scaling:** BullMQ consumers scale independently; payroll concurrency is capped per tenant (a 50k-employee enterprise run must not monopolize the pool) via a tenant-scoped rate limiter.
- **Caching tiers (reused):** Cloudflare edge → router Redis microcache (`apps/router/index.js` `servePublicMicrocache`, L235) → app SSR → DB. For HR, the microcache only applies to **public, anonymous** ESS shells (e.g. a careers/login page); anything carrying a session cookie is `no-store` (the `hasPrivateCookie` / `STOREFRONT_NO_CACHE_PREFIXES` guards, index.js L103, L160). Tenant-resolution caches: `vertical:<slug>` (60s), `domain-route:<host>` (60s), KV at the edge.

### 9.2 Multi-region & data residency (IN vs NZ)

IN's DPDP Act and NZ's Privacy Act create real pressure to keep PII in-region. We design **region-pinned tenants** from day one:

```prisma
model Business {
  // ...
  country  String?  // ISO-3166 alpha-2 — already exists (schema L123)
  region   String   @default("ap-south-1")  // NEW: data-residency region (IN: ap-south-1 Mumbai; NZ: australia-southeast / NZ region)
}
```

- **Region routing — and a hard constraint inherited from the fork.** The fork's Prisma layer is a **single process-wide `PrismaClient` singleton** bound to one `DATABASE_URL` (`backend/src/core/lib/prisma.js`: `globalThis[prismaGlobalKey] || new PrismaClient()`, plus a `Proxy` that forces every stray `new PrismaClient()` in legacy libs — e.g. `notifications/router.js`, `webhookDispatcher.js` — to return that one singleton). A single backend process therefore **cannot** transparently "select the regional Postgres at the connection layer" the way an earlier draft implied. The honest options are:
  1. **Deploy-per-region (recommended for launch):** run a **separate backend + scheduler + worker fleet per market** (`hr-backend-in` against Mumbai PG, `hr-backend-nz` against the NZ/Sydney PG), each with its own `DATABASE_URL`. The global router/Worker (Cloudflare) steers a tenant's traffic to the right regional origin by the tenant's `region`. This gives true residency with **zero** cross-region DB access and needs no change to the singleton. It is what the §13.3 open question should resolve to.
  2. **Single fleet + connection router (deferred):** replace the singleton with a per-region client map (`Map<region, PrismaClient>`) resolved from the request's tenant `region` via AsyncLocalStorage. This is a real refactor (the Proxy-forced singleton must be removed) and is **not** "from day one" cheap — call it out as such.

  Either way, the router/Worker is global (Cloudflare); only the data plane is regional. The earlier "route at the connection layer from day one" phrasing was an over-claim against the singleton reality and is corrected here.
- **No cross-region tenant data movement:** a pay run for an IN tenant never reads/writes NZ infra. Super-Admin analytics aggregates **de-identified** metrics cross-region (counts, totals), never raw PII.
- **KMS per region:** field-level encryption DEKs are region-scoped; a region's data is decryptable only with that region's keys.
- **Object storage:** payslip PDFs / Form 130 / IR certificates stored in the tenant's region bucket (`core/lib/s3.js` parameterized by region).
- **Backups & DR:** region-local backups; cross-region replication only for the region's own DR pair, never across the IN/NZ residency boundary.

### 9.3 Scale numbers we design to (sizing targets)

| Dimension | Target |
|---|---|
| Tenants | 50k |
| Employees / largest tenant | 50k |
| Monthly payslips at scale | low-millions |
| Pay-run latency (1k-employee tenant) | < 2 min wall-clock (parallel employee jobs) |
| Payday-filing SLA (NZ) | submit within minutes of PAID; hard deadline 2 working days |
| Tenant resolution p99 | < 5 ms (cache hit) |

---

## 10. Sitepresso Reuse Map (real file paths)

Legend: **REUSE** = take as-is / minor config; **ADAPT** = keep structure, change logic; **SLIM** = keep a reduced subset; **NEW** = build.

| Capability | Sitepresso path (READ-ONLY source) | Action | Notes |
|---|---|---|---|
| Host-based tenant router (on-box) | `apps/router/index.js` | ADAPT | Collapse verticals/sub-apps to single ESS target; keep admin-host lock, microcache, domain-route lookup, WS upgrade |
| Edge router (Cloudflare Worker) | `apps/router/cloudflare-worker.js` | ADAPT | Same; `VERCEL_URLS` → HR app origins; keep custom-hostname + redirect logic |
| Router config | `apps/router/wrangler.toml`, `apps/router/package.json` | REUSE | Zone routes, KV `ROUTER_CACHE`, `INTERNAL_SECRET` |
| Tenant-vertical / domain-route internal API | `backend/src/core/routes/internal.routes.js` | ADAPT | Fixed `HR` vertical; add `isActive` check; re-enable custom-domain `businessId` resolution |
| Custom-domain routing predicate | `backend/src/core/lib/customDomainRouting.js` | REUSE | apex/www + `co.in`/`co.nz`/`com.au` suffix handling already correct |
| Custom-domain provisioning + SSL sweep | `backend/src/core/lib/scheduler.js` (`processCustomDomainProvisioning`, L560) + `provisionCustomDomain` in `subscription.controller.js` | REUSE | Cloudflare-for-SaaS custom hostnames |
| Registrar adapters (binding/DNS, not resale) | `backend/src/domains/adapters/{interface,openprovider,byod,retry}.js` | SLIM | Keep DNS/binding helpers; drop reseller storefront/pricing |
| AuthN (operator + customer/employee) | `backend/src/core/middleware/auth.middleware.js` | REUSE | `authenticateOperator`, `authenticateCustomer` (→ Employee), token-revocation on password change, cross-host 403 |
| Token utils / cookies | `backend/src/core/utils/generateToken.js` | REUSE | Operator vs customer cookie namespaces, refresh tokens |
| RBAC | `backend/src/core/lib/rbac.js`, `core/lib/roles.js` | ADAPT | Replace ecom/appointment permission catalogs with HR catalog (payroll.run/approve, ess.view, etc.) |
| Tenant scope guard | `backend/src/core/middleware/requireBusiness.js` | REUSE | |
| Owned-row helper | `backend/src/core/lib/findOwned.js` | REUSE | "fetch IFF businessId matches" |
| Prisma client singleton | `backend/src/core/lib/prisma.js` | ADAPT | Add tenant-scoping client extension + RLS session var |
| Redis cache helpers | `backend/src/core/lib/redis.js` (`setTenantVertical`) | REUSE | Plus BullMQ on same Redis |
| Multi-gateway billing (OUR revenue) | `backend/src/core/controllers/{paddle,stripe,razorpay}.controller.js`, `core/lib/paddle.js`, `billingLedger.js`, `subscriptionInvoice.js`, `subscriptionMaterializer.js` | REUSE | Razorpay IN / Stripe NZ / Paddle RoW; webhook drains + reconciliation crons |
| Billing access / entitlements | `backend/src/core/lib/{billingAccess,featuresCatalog,trial}.js` | ADAPT | HR plan feature flags; per-seat (per-employee) pricing |
| Promo codes | (billing controllers / promo flows) | REUSE | |
| Scheduler shell + webhook drains/reconcile | `backend/src/core/lib/scheduler.js`, `backend/src/scheduler-worker.js` | REUSE-PATTERN | Keep periodic sweeps; ADD BullMQ for pay-run/filing |
| Notifications (WhatsApp→SMS→email) | `backend/src/core/lib/notifications/router.js` + `priceCache.js` | REUSE | Payslip published, leave approved, payday filed, deadline alerts |
| Super-Admin console shell | `apps/platform/*` (`middleware.js`, `app/`, `components/`, `lib/`) | ADAPT | Strip storefront admin; add tenants/plans/compliance-rulesets/impersonation |
| Super-Admin backend | `backend/src/superadmin/controllers/admin.controller.js`, `routes/admin.routes.js` | ADAPT | Tenant mgmt, plan/pricing, promo, compliance rule-set publish, impersonate, audit |
| Admin shell components | `packages/admin-core/*` | REUSE | Tables, filters, layout |
| Design system | `packages/ui/*` (`index.js`, `admin.js`) | REUSE | |
| Theming → 5 fixed styles | `packages/theme-engine/*` | SLIM | Exactly 5 styles; logo + 1 brand color; drop 60+ profession themes + `themeManifest.json` |
| i18n (en/hi) | `apps/platform/middleware.js`, `apps/platform/i18n/{config,request}.js` (**next-intl, per-app**) | ADAPT (+NEW `packages/i18n` if shared) | Cookie-based locale, no URL prefixes. **No `packages/i18n` exists today**; live `SUPPORTED_LOCALES=['en','hi','es','fr','de','it','pt-BR']` — ship en+hi. |
| Object storage | `backend/src/core/lib/s3.js` | REUSE | Parameterize by region for residency |
| GDPR/DPDP soft-delete + purge | `backend/src/core/lib/accountDeletion.js` + `sweepExpiredDeletions` cron | ADAPT | **Retain statutory artifacts** beyond purge (legal retention) |
| Deploy tooling | `ecosystem.config.js`, `scripts/deploy.sh`, `scripts/next-pm2-server.js` | REUSE | Add `hr-payroll-workers` / `hr-filing-workers` PM2 apps |
| Multi-tenant skeleton models | `backend/prisma/schema.prisma` (`Business` L108, `User`, `Subscription` L1568, `Customer`) | REUSE-SKELETON | Keep tenant/auth/billing/custom-domain; **delete** storefront models; **add** HR models (`03-data-model.md`) |

**DELETE outright:** `apps/{web,shop,booking}`, `apps/chat-*`, `apps/aapkarider-*`, `backend/src/{web,shop,booking}`, `packages/{chat-*,ecom-ui,blog-ui,aapkarider-shared}`, 60+ profession themes, page/site builder + `BusinessPage`/`BusinessContent`/SEO-override models, domain/mailbox **resale**.

---

## 11. End-to-End Flows (sequence-level)

### 11.1 Signup → onboarding → first pay run (happy path)

```
1. Prospect → hr.com (apps/marketing) → /signup → creates Business + BUSINESS_ADMIN User + Subscription (free/trial)
                                        slug 'acme' reserved-name-checked; Business.country/region set (IN/NZ)
2. Onboarding wizard (apps/marketing → handed to apps/hr-admin): company profile, statutory IDs
   (PF/ESIC/PAN/TAN for IN; IRD number/employer reg for NZ), pay calendar, salary structure (50%-wage validated for IN)
3. Optional: bind custom domain hr.acme.com → PENDING_DNS → (CNAME) → PENDING_SSL → ACTIVE (Cloudflare-for-SaaS)
4. Add employees (CSV import or one-by-one) → Employee rows (businessId scoped); employees invited to ESS
5. Run period: attendance/leave finalized → HR clicks "Run Payroll" → API 202 + payRunId
6. BullMQ: payrun.orchestrate → snapshot (pins ComplianceRuleSet) → fan-out payrun.employee → CALCULATED
7. HR reviews variance report → APPROVE (maker≠checker if enabled) → bank file + payslips generated → READY_TO_PAY
8. Bank file released → PAID → filings enqueued (NZ payday EI within 2 working days; IN TDS/ECR/ESIC by deadlines)
9. Payslips published → employees notified (WhatsApp→SMS→email) → view in ESS → CLOSED when all receipts ACCEPTED
```

### 11.2 NZ payday filing (failure/retry)

```
PAID → filing.nz.payday (deadline = +2 working days) → IRD submit
  ├─ ACK → FilingReceipt(ackId) stored → SUBMITTED → CLOSED contribution
  ├─ transient 5xx/timeout → BullMQ backoff retry (bounded before deadline)
  └─ persistent fail near deadline → escalate: ops alert + tenant banner + Super-Admin compliance dashboard flag
Reconciliation cron re-polls SUBMITTED-without-final-ACK and converges (mirrors processStripeWebhookRetries)
```

### 11.3 Super-Admin publishes a new tax-year rule set

```
admin.hr.com → /superadmin/compliance → new ComplianceRuleSet(country='NZ', version=N+1, effectiveFrom=2026-04-01, status=DRAFT)
  → edit KiwiSaver 3%→3.5%, ACC 1.67%→1.75%, cap $156,641, min wage $23.95 → validate → PUBLISH
  → pay runs with INPUTS_LOCKED on/after 2026-04-01 auto-pin version N+1; earlier runs keep their pinned version (reproducible)
```

---

## 12. API Surface (representative, not exhaustive)

All tenant APIs are mounted under `/api/hr/*`, authenticated by `requireAuth` + scoped by `requireBusiness` + permission guards. Internal/edge endpoints under `/api/internal/*`. Super-Admin under `/api/superadmin/*` (`requireSuperAdmin`).

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/internal/tenant-vertical?slug=` / `?host=` | internal secret | router tenant resolution (REUSE) |
| `GET /api/internal/domain-route?host=` | internal secret | custom-domain routing (REUSE) |
| `POST /api/hr/employees` / `GET /api/hr/employees` | `employee.write`/`read` | employee CRUD (tenant-scoped) |
| `POST /api/hr/employees/import` | `employee.write` | CSV bulk import (async job) |
| `POST /api/hr/pay-runs` | `payroll.run` | start a pay run → 202 + payRunId |
| `GET /api/hr/pay-runs/:id` | `payroll.read` | state-machine status + progress |
| `POST /api/hr/pay-runs/:id/approve` | `payroll.approve` (maker≠checker) | advance to APPROVED |
| `POST /api/hr/pay-runs/:id/mark-paid` | `payroll.pay` | confirm payment → PAID |
| `GET /api/hr/pay-runs/:id/bank-file` | `payroll.pay` | NEFT/RTGS or NZ direct-credit batch |
| `GET /api/hr/payslips/:id.pdf` | owner employee or `payroll.read` | rendered payslip |
| `GET /api/hr/filings` | `compliance.read` | filing statuses + receipts |
| `POST /api/hr/leave/requests` | employee (ESS) | apply for leave |
| `POST /api/hr/leave/requests/:id/decision` | `leave.approve` | approve/reject |
| `POST /api/hr/domains` | `settings.domains` | bind custom domain (REUSE provisioning) |
| `GET /api/ess/me/payslips` | employee | ESS payslip list |
| `POST /api/superadmin/compliance/rulesets` | SUPER_ADMIN | create/publish rule set |
| `POST /api/superadmin/tenants/:id/impersonate` | SUPER_ADMIN | audited impersonation token |

---

## 13. Risks, Open Questions & Decisions

### 13.1 Key decisions (committed)
- Single backend + row-level `businessId` isolation, hardened with a Prisma scoping extension + Postgres RLS on payroll tables.
- BullMQ on existing Redis for durable pay-run/filing; `node-cron` retained for periodic sweeps.
- Pure calc packages (`payroll-core`, `compliance-in`, `compliance-nz`) separated from orchestration; runs pin a versioned rule set for reproducibility.
- Reuse the entire host-routing + custom-domain + auth + billing stack from Sitepresso; delete storefront/builder.
- Region-pinned tenants for IN/NZ data residency from day one.

### 13.2 Risks
- **Holidays Act 2003 correctness (NZ)** — the highest-risk calculation; mitigated by golden-vector + property-based tests and a pinned rule set, but a known industry-wide minefield (RDP/ADP, alt days).
- **Government endpoint reliability/SLA** — IRD/EPFO/ESIC/TRACES outages threaten the 2-working-day / 7th / 15th deadlines; mitigated by retry/reconcile + early escalation, but ultimately bounded by their uptime.
- **Form renumbering (16→130, 24Q→138) timing** — must select form templates by effective date; a wrong cutover issues the wrong-named certificate.
- **ESI ₹30,000 ceiling proposal** — if notified mid-year, a new rule-set version must ship fast; the architecture supports it without a deploy.
- **Field-level encryption key management** — losing a regional KMS DEK is catastrophic for that region's payroll PII; needs hardened key rotation + escrow.
- **Convention-based isolation in the fork** — until the Prisma scoping extension + RLS land, we rely on Sitepresso's per-controller discipline; this is the top pre-launch hardening item.

### 13.3 Open questions for the founder
1. **Single multi-region cluster vs. fully separate IN/NZ stacks?** Residency leans toward separate data planes; ops cost leans toward one. Which way for launch?
2. **Maker–checker mandatory or plan-gated?** Segregation-of-duties on pay-run approval — force it for all, or only Enterprise plans?
3. **Bank payment integration depth at launch** — generate bank files for manual upload (NEFT/RTGS, NZ direct credit) vs. direct bank-API disbursement? The former is faster to ship and lower-risk.
4. **ESS mobile** — Flutter (the only mobile precedent in the fork is `apps/chat-mobile`; there is **no** `shop-mobile`) vs. React Native? Affects the `apps/mobile` choice.
5. **Statutory retention vs. DPDP/Privacy erasure** — confirm the exact retention windows (IN registers, NZ 7-year wage/holiday records) so the deletion sweep's "anonymise-but-retain" carve-out is legally precise.
6. **Contractor/gig & multi-state PT (IN)** — in scope for v1, or fast-follow? Affects the compensation/compliance module shape.

---

## Sources (2026 compliance verification, accessed 2026-06-22)

- India Labour Codes / 50% wage rule: [Ministry of Labour FAQs (16.03.2026)](https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf), [Cyril Shroff — Guide to the Labour Codes](https://www.cyrilshroff.com/wp-content/uploads/2025/12/Guide-to-the-Labour-Codes.pdf), [APA — India's New Labour Codes Are in Force](https://payroll.org/news-resources/news/news-detail/2025/12/17/india-s-new-labour-codes-are-in-force-payroll-teams-must-act), [LawChakra — Labour Codes 2025 explained](https://lawchakra.in/legal-updates/labour-codes-wage-rule-salaries-taxes/)
- India EPF/ESI/PT/TDS/new regime: [ClearTax — ESI rate](https://cleartax.in/s/esi-rate), [SalaryBox — EPF/ESI/TDS 2026](https://salarybox.in/how-to-calculate-epf-esi-and-tds-in-india-2026-step-by-step-hr-payroll-guide/), [Vakilsearch — ESI registration 2026](https://vakilsearch.com/article/esi-registration-india-employer-2026/), [Bhatt & Joshi — ESIC ₹30,000 proposal](https://bhattandjoshiassociates.com/esic-wage-ceiling-increase-proposed-hike-to-%E2%82%B925000-%E2%82%B930000-and-its-impact-on-workers/)
- India form renumbering (16→130, 24Q→138): [BusinessToday — 12 key tax forms changing from 1 Apr 2026](https://www.businesstoday.in/personal-finance/tax/story/new-income-tax-act-2025-explained-12-key-tax-forms-changing-from-april-1-2026-530661-2026-05-10), [SAG Infotech — new form numbers](https://blog.saginfotech.com/new-numbers-income-tax-forms-16-26as-24q-27q), [FutureX — Form 16 FY 2025-26 & Form 130](https://futurexsolutions.com/form-16-fy-2025-26-employer-guide/)
- NZ KiwiSaver/ACC/min wage 1 Apr 2026: [IRD — KiwiSaver changes](https://www.ird.govt.nz/kiwisaver-changes), [Mercans — ACC levy 1 Apr 2026](https://mercans.com/resources/statutory-alerts/tnew-zealand-changes-in-acc-levy-rates-1st-april-2026/), [Moore Markhams — 1 Apr 2026 payroll changes](https://www.markhams.co.nz/news/1-april-2026-payroll-changes/), [NZTaxTools — ACC 2026-27 ($156,641 cap)](https://nztax.tools/tax-insights/acc-earner-levy-2026-27/)
- NZ payday filing: [IRD — Payday filing](https://www.ird.govt.nz/employing-staff/payday-filing), [IRD — Filing employment information electronically](https://www.ird.govt.nz/employing-staff/payday-filing/filing-employment-information-electronically)

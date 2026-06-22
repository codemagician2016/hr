# DriftHR Feature 3 — Self-service Domain & Branding (dev contract)

**Owner gate:** `requireBusinessAdmin` (BUSINESS_ADMIN/Owner). Perm keys: `canEditDomain`, `canEditBranding` (real, in `apps/hr-admin/lib/nav.js`).

## 1. THE infra decision
- **Mode A — DriftHR subdomain** `{slug}-staging.drifthr.com` (prod `{slug}.drifthr.com`): we own the zone → **auto-provisionable now** on the DEDICATED tunnel `c87a09e3-258a-4c7a-8ab6-b30b01055d94`. Universal SSL covers 1-level `*.drifthr.com`.
- **Mode B — Custom domain** `hr.acme.com`: CF-for-SaaS backend ~90% built (Sitepresso). Blocked on a ONE-TIME manual action (not code): enable CF-for-SaaS on the zone, create `saas-origin.drifthr.com` fallback origin, set env (`CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID`, `…_FALLBACK_ORIGIN`, `CUSTOM_DOMAIN_TARGET_CNAME`, `PLATFORM_DOMAIN=drifthr.com`), extend token scope (Zone→SSL:Edit). Until then `isCloudflareCustomHostnameConfigured()` is false → **UI gates the section on `GET /api/business/domain-config`**.
- **Decision:** v1 = subdomain self-service + branding. v1.1 = flip the readiness flag after the one-time CF-for-SaaS enablement. UI built once, custom-domain section feature-gated.

## 2. Routing model (staging)
Each tenant subdomain is bound as `subscription.customDomain = {slug}-staging.drifthr.com` (status ACTIVE/verified), resolved by `resolveBusinessId` custom-domain path (same as demo-staging). A **one-time wildcard ingress `*.drifthr.com → http://localhost:4200`** on the DEDICATED tunnel means per-tenant provisioning only writes a DNS CNAME → `c87a09e3….cfargotunnel.com`; the backend never edits tunnel config.

## 3. Backend
### Reuse as-is (subscription.controller.js): CF-for-SaaS layer (`ensureCloudflareCustomHostname`/`…FallbackOrigin`/`cloudflareApi`/`isCloudflareCustomHostnameConfigured`), `updateCustomDomain`/`disconnectCustomDomain`/`getCustomDomainStatus`, status state machine (`customDomainStatusFrom`, `stabilizeCustomDomainStatus`), DNS/ownership (`inspectDomainDns`, `customDomainOwnershipVerified`, `dnsInstructionsForDomain`), `customDomainRouting.js`, `resolveBusinessId`, scheduler `processCustomDomainProvisioning`, slug primitives (`slugify`/`uniqueSlug`/`checkSlug`/`RESERVED_SLUGS`), `updateTheme` (`PUT /theme`), `uploadImage` (`POST /api/upload/image`).
### ADD
- **`backend/src/core/lib/subdomainProvision.js`** (NEW): `provisionSubdomain({businessId,slug,staging})` = idempotent DNS CNAME (`content:{DEDICATED}.cfargotunnel.com, proxied, comment:"drifthr-tenant:{businessId}"`) + bind subscription (customDomain host, ACTIVE, verified). `deprovisionSubdomain` = DELETE DNS **only if `comment===drifthr-tenant:{businessId}`** (tag-gated). HARD-CODE `DEDICATED_TUNNEL_ID=c87a09e3…` + `assert(DEDICATED !== '1fd39436-6495-4381-9a40-8c663b50c29a')`. CF creds from env; **best-effort** (log, don't fail the request) when unset.
- **`PATCH /api/business/slug` {slug}** (business.controller+routes): slugify → reject RESERVED (409) → no-op if same → uniqueness no-auto-suffix (409 taken) → 30-day cooldown via `slugLastChangedAt` (429) → provision NEW host first → update slug+stamp → deprovision OLD (tag-gated) → audit → `{slug,url}`. (The existing `PATCH /settings` silently drops slug — confirmed gap.)
- **`GET /api/business/domain-config`**: `{customDomainEnabled: isCloudflareCustomHostnameConfigured(), platformDomain, subdomainSuffix, targetCname}`.
- **Logo fix** `tenant.controller.js:298` + `me()`: `logoUrl: business.content?.logoUrl || null` (was `sub?.logoUrl||business.logoUrl`, both undefined).
- Wire `provisionSubdomain` into `setup()` on slug create/change (best-effort).
### PRUNE/REBRAND: `CUSTOM_DOMAIN_PROVIDER=cloudflare` (kills Vercel branch); delete Vercel cluster (`getVercelProjectDomain` etc.); `_sitepresso-verify`→`_drifthr-verify`; `PLATFORM_DOMAIN` default `'sitepresso.com'`→`'drifthr.com'`; user-facing "Sitepresso"→"DriftHR".

## 4. Frontend (hr-admin)
NEW `app/settings/domain/page.js`: **AddressCard** (live subdomain + custom domain if ACTIVE, copy/open), **SubdomainSection** (slugify-preview + debounced abortable `check-slug` + confirm modal "old URL stops working" → `PATCH /api/business/slug`; 409/429 inline), **CustomDomainSection** (gated on `domain-config.customDomainEnabled`; else "coming soon" teaser): connect → DNS panel (CNAME+TXT copy) → status timeline (PENDING_DNS→PENDING_SSL→ACTIVE, 20s poll, pause-on-hidden) → disconnect; friendly states, never "error". Extend **BrandingTab** in `app/settings/page.js`: LogoUploader (upload→`POST /api/upload/image`, degrade to URL on 501), HexColorInput (HEX_RE), BrandPreview ("what your employees see"). Owner-gate; hide destructive actions when `canEditDomain`/`canEditBranding` false (mirror `roles/page.js`).

## 5. QA (v1-blocking: 1-6,12,13,15; Mode B 7-11,14,16,17)
1 subdomain provision (CNAME tag, HTTPS loads) · 2 cleanup on change (new live before old removed) · 3 tag-safety (refuse delete if comment≠tag) · 4 slug collision/reserved 409 · 5 cooldown 429 · 6 `PATCH /settings{slug}` still no-ops · 7-9 custom-domain register+state-machine+verify · 10 ownership anti-hijack (no TXT→never ACTIVE) · 11 domain-in-use 409+transfer · 12 RBAC Owner-only (Manager/Employee→403) · **13 DEDICATED-tunnel-NOT-shared invariant (assert shared 1fd39436 byte-identical after provision; catch-all last; len delta ∈{0,+1})** · 14 Host preservation · 15 logo fix resolves · 16 logo upload/501 · 17 readiness gate.

## 6. Build sequence
1 env+Vercel-prune+rebrand · 2 logo fix (1-line) · 3 subdomainProvision.js (dedicated tunnel, not-shared assert) · 4 PATCH /business/slug + wire setup() · 5 GET /business/domain-config · 6 hr-admin settings/domain page · 7 extend BrandingTab · 8 QA · 9 (manual v1.1) CF-for-SaaS enablement.

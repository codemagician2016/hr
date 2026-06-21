# 14 — Security & Privacy Architecture

> **Surfaces covered:** all four — Marketing/Onboarding (`hr.com`), Super Admin (`admin.hr.com`), Tenant Admin / HR console (`app.hr.com`), Employee Self-Service / white-label (`tenant.com` · `tenant.hr.com`).
> **Backend:** `backend/src/hr/*`, `backend/src/core/*` (forked from Sitepresso), edge router `apps/router`.
> **Owner discipline:** Security & Privacy Architect.
> **Status:** Production spec — no MVP shortcuts. Every regulatory figure carries an effective date and a verified source.
> **Sibling docs:** `00-vision-and-principles.md`, `01-product-requirements.md`, `02-system-architecture.md`, `03-data-model.md`, `04-payroll-engine-design.md`, `05-compliance-india.md`, `06-compliance-newzealand.md`, `07-modules-core-hr.md`, `08-modules-time.md`, `09-modules-pay-adjacent.md`. Forward refs: `15-super-admin-platform.md` (impersonation UI, feature flags), `16-billing-and-plans.md`, `17-notifications.md`, `18-devops-and-deploy.md`.

---

## 0. Threat Context: Why Payroll SaaS Is a High-Value Target

A multi-tenant payroll system concentrates the three most attractive asset classes for an attacker into one database:

1. **Money-movement instructions** — bank account numbers (IFSC + account / NZ BSB-bank-branch + account), UPI VPAs, payment files (NACH/NEFT in IN, direct-credit batch files in NZ). A single mutated payee row reroutes a whole company's payroll.
2. **Identity-grade PII** — PAN, Aadhaar (where collected), IRD numbers, dates of birth, home addresses, bank details, salary. This is everything needed for identity theft and financial fraud, for *every employee of every tenant*.
3. **Authority to act** — a compromised HR/Finance operator can approve a pay run, change a bank account, or export the entire employee register.

The dominant risks for this class of system, in priority order, are: **(a) cross-tenant data leakage** (the existential SaaS bug), **(b) privilege escalation inside a tenant** (employee → HR → super-admin), **(c) payment-instruction tampering** (the "salary diversion" fraud), **(d) mass PII exfiltration** via an export endpoint or a compromised backup, and **(e) insider abuse** by our own staff via support/impersonation tooling. The entire architecture below is organised to make each of these either impossible by construction or loud and reversible.

This document is the security counterpart to the operational runbook we inherit from Sitepresso at `/Users/kp/sitepresso/SECURITY.md`, rebuilt for HR/payroll-grade sensitivity and for the **India DPDP Act 2023 + DPDP Rules 2025** and **NZ Privacy Act 2020** regimes.

---

## 1. Reuse From Sitepresso (Real Paths) & New-Build Boundary

### 1.1 What we reuse as-is or lightly hardened

| Capability | Sitepresso path (READ-ONLY fork base) | How HR/payroll uses it | Hardening delta for payroll |
|---|---|---|---|
| Operator + customer JWT auth, dual cookie scopes, refresh rotation | `backend/src/core/middleware/auth.middleware.js`, `backend/src/core/utils/generateToken.js` | "operator" → super-admin/tenant-admin/HR/Finance/manager; "customer" → **employee** (ESS) | Shorten access TTL on Finance routes; add step-up MFA gate (§3.4); add `tokenUse` already present |
| Tenant-scoped fetch helper | `backend/src/core/lib/findOwned.js` | Every tenant-owned read/write goes through an ownership check | Promote from helper to **mandatory Prisma middleware** (§5.3) |
| RBAC permission registry + effective-permission resolver | `backend/src/core/lib/rbac.js`, `backend/src/core/lib/roles.js` | Base for the HR permission catalogue | Replace booking/ecom permission keys with HR/payroll keys (§4) |
| Per-route permission middleware | `requirePermission`, `requireEcomPermission` in `auth.middleware.js` | Pattern reused as `requireHrPermission` with location/legal-entity scoping | Add **field-level** masking, not just route-level allow/deny (§4.6) |
| At-rest field encryption (AES-256-GCM) | `backend/src/core/lib/crypto.js` | Encrypt bank details, PAN, Aadhaar, IRD #, tax declarations | **Move key off `JWT_SECRET`** to a dedicated KMS-backed data-encryption key (§6.2) |
| Rate limiting / honeypot / Turnstile | `backend/src/core/middleware/abuse.middleware.js` | Login, password reset, ESS signup, public marketing forms | Add account-lockout + credential-stuffing detection (§3.6) |
| Public API key auth (hashed, scoped) | `backend/src/core/middleware/apiKey.middleware.js` | Tenant integrations (HRIS sync, their IdP) | Add per-key IP allowlist + scope catalogue for HR resources (§3.7) |
| Account deletion / soft-delete / anonymisation | `backend/src/core/lib/accountDeletion.js` | Employee + tenant erasure with statutory-retention carve-outs | Re-map retention windows to payroll law, not GDPR defaults (§9) |
| Immutable account audit log | `AccountAuditLog` model in `backend/prisma/schema.prisma` | Lifecycle forensics that survive purge | Extend pattern into a general `AuditEvent` stream (§7) |
| Data-export (portability) | `backend/src/core/controllers/dataExport.controller.js` | Tenant + employee data export (DPDP/Privacy Act rights) | Add employee-scoped export; sign + expire the artefact (§8.4) |
| Edge: Cloudflare orange-cloud, WAF, origin-cert pinning, host-scoped cookies | `apps/router/cloudflare-worker.js`, `/Users/kp/sitepresso/SECURITY.md` | White-label custom domains terminate at CF; origin IP hidden | Full-strict TLS mandatory; CF Access in front of `admin.hr.com` (§2) |

### 1.2 What we delete (and the security debt it removes)

Deleting the website/page builder and the `web/shop/booking` verticals (`backend/src/{web,shop,booking}`, `apps/{web,shop,booking}`) removes the **largest attack surface in Sitepresso**: user-authored HTML/CSS/Liquid-style content, file uploads to public storefronts, and buyer payment flows. Core principle "configure, don't build" is itself a security control — there is **no tenant-authored code path**, so stored-XSS-via-page-builder and SSTI-via-template are out of scope by construction. The 60+ profession themes and domain/mailbox resale also go, removing the OpenProvider credential blast radius from the payroll process.

### 1.3 What we build new (security-relevant)

- A **mandatory tenant-isolation Prisma middleware** (not an opt-in helper) — §5.3.
- A **KMS-backed envelope-encryption** layer for payroll PII with per-tenant data keys — §6.
- A unified **`AuditEvent`** append-only stream with hash-chaining for tamper-evidence — §7.
- A **step-up MFA / re-authentication** gate for money-movement and bulk-PII actions — §3.4.
- **DPDP 2025 + Privacy Act 2020 consent, retention, erasure, and breach-notification** engines wired to the data model — §8, §9, §10.

---

## 2. Trust Boundaries & Network Topology

```
                          ┌──────────────────────────────────────────────┐
   Public Internet        │                Cloudflare edge                │
        │                 │  WAF · L3/L4 DDoS · Bot Mgmt · TLS terminate  │
        ▼                 │  Rate-limit rules · Turnstile · mTLS to origin│
 ┌─────────────┐   HTTPS  └──────────────────────┬───────────────────────┘
 │ hr.com      │ (orange)                        │  Full(strict) — origin cert pinned
 │ admin.hr.com│◄──── CF Access (SSO+device) ────┤
 │ app.hr.com  │                                 │
 │ tenant.com  │ (white-label, CF for SaaS)      ▼
 └─────────────┘                    ┌─────────────────────────────┐
                                    │  apps/router (CF Worker)    │  tenant resolution by host
                                    │  → surface + tenant context │  (apps/router/cloudflare-worker.js)
                                    └──────────────┬──────────────┘
                                                   ▼
                          ┌────────────────────────────────────────────────┐
   PRIVATE NETWORK (VPC, no public ingress except 443 via CF allowlist)     │
   ┌──────────────┐   ┌──────────────────────┐   ┌──────────────────────┐   │
   │ Next.js apps │   │ Node/Express API      │   │ Redis (TLS, authN)   │   │
   │ (Vercel/edge)│──▶│ backend/src/hr + core │──▶│ sessions·queues·idemp│   │
   └──────────────┘   └─────────┬────────────┘   └──────────────────────┘   │
                                ▼                                            │
                    ┌──────────────────────────┐   ┌──────────────────────┐ │
                    │ PostgreSQL (RLS + col enc)│   │ KMS (data keys, HSM) │ │
                    │ private subnet, no pub IP │   │ envelope encryption  │ │
                    └──────────────────────────┘   └──────────────────────┘ │
                                ▼                                            │
                    ┌──────────────────────────┐                            │
                    │ Object store (S3/R2)      │  SSE + KMS, region-pinned  │
                    │ payslips·payment files·exp│  per data-residency zone   │
                    └──────────────────────────┘                            │
   └──────────────────────────────────────────────────────────────────────┘
```

**Trust boundaries (each a place where authZ is re-checked):**

| # | Boundary | What crosses it | Control |
|---|---|---|---|
| B1 | Internet → Cloudflare | All HTTP | WAF managed + custom rules, DDoS, bot mgmt, TLS 1.2+ |
| B2 | Cloudflare → origin | Proxied requests only | **Full (strict)** TLS with pinned **Cloudflare Origin Certificate**; origin firewall allows only CF IP ranges + `cf-connecting-ip` trust. Direct-to-origin = cert mismatch + dropped. Inherited pattern from `SECURITY.md`. |
| B3 | `admin.hr.com` gate | Super-admin operators only | **Cloudflare Access** (SSO via our IdP + hardware-key/device posture) *in front of* application auth — defence in depth so the super-admin app is never reachable by an unauthenticated request. |
| B4 | Edge router → surface | Tenant + surface resolution | `apps/router` resolves host → tenant; never trusts a client-supplied tenant id (§5.2). |
| B5 | App → API | Session JWT | Operator vs employee scope separation (§3). |
| B6 | API → DB | Every query | Tenant-isolation Prisma middleware + Postgres RLS (§5). |
| B7 | API → KMS | Decrypt requests | IAM-scoped, audited, rate-limited; app role can *use* keys, not *export* them (§6). |
| B8 | App → object store | Payslips, payment files, exports | Pre-signed, short-TTL, tenant-prefixed keys; bucket policy denies cross-prefix (§6.5). |

**Network hardening (inherited + extended from Sitepresso):** Postgres and Redis bind to private subnets with **no public IP**; only 443 ingress, and only from Cloudflare IP ranges. SSH is key-only to a bastion on a `/32` admin allowlist (`SECURITY.md`). `app.set('trust proxy', 1)` is already set in `backend/src/index.js`, and client IP is taken from `cf-connecting-ip` first (`abuse.middleware.js`) — both required for correct rate-limiting behind CF.

---

## 3. Authentication

Two **disjoint** principal classes, two cookie namespaces, two token shapes — inherited from Sitepresso and kept strictly separated because conflating them is the classic cross-surface privilege bug.

### 3.1 Principal classes & token scopes

| Principal class | Examples | Cookie pair (base names) | JWT `tokenUse` / `type` | Where it logs in |
|---|---|---|---|---|
| **Operator** | super-admin, tenant-admin, HR, Finance, manager | `ae_operator` / `ae_operator_refresh` | `tokenUse: access\|refresh`, **no** `type:customer` | `admin.hr.com`, `app.hr.com` |
| **Employee** | ESS user | `token` / `token_refresh` | `type: 'customer'` (+ mandatory `businessId` claim) | `tenant.com`, `tenant.hr.com` |

Grounding: the two namespaces and the `type:'customer'` discriminator are exactly the existing design in `backend/src/core/utils/generateToken.js` (`OPERATOR_COOKIE_NAME` vs `CUSTOMER_COOKIE_NAME`) and enforced in `auth.middleware.js` (`authenticateOperator` rejects `decoded.type === 'customer'`; `authenticateCustomer` *requires* it plus `businessId`). We **rename "customer" → "employee"** in the HR vertical's public surface and DB labels, but keep the proven token-discriminator mechanics.

> **Hard rule:** an employee token can **never** satisfy an operator route, and vice-versa, even with a valid signature. This is enforced at token-verify time (`assertAccessToken` / the `type` checks), *before* any DB lookup — so a stolen employee JWT replayed at `app.hr.com` fails closed at the boundary.

### 3.2 JWT claims (HR-specific)

**Operator access token (15 min TTL):**
```json
{
  "id": "usr_...",
  "tokenUse": "access",
  "role": "HR",                    // SUPER_ADMIN|TENANT_ADMIN|HR|FINANCE|MANAGER
  "businessId": "tnt_...",         // null only for SUPER_ADMIN
  "businessRoleId": "role_...",    // custom role → permission JSON
  "amr": ["pwd","totp"],           // auth methods present (for step-up)
  "sid": "sess_...",               // server session id (revocation handle)
  "iat": 1750000000, "exp": 1750000900
}
```

**Employee access token (15 min TTL):**
```json
{
  "id": "emp_...",
  "type": "customer",              // discriminator — kept from Sitepresso
  "tokenUse": "access",
  "businessId": "tnt_...",         // REQUIRED — bound to one tenant forever
  "sid": "sess_...",
  "iat": 1750000000, "exp": 1750000900
}
```

- **Access TTL 15 min, refresh 7 days** — the Sitepresso defaults (`ACCESS_TOKEN_EXPIRES_IN`, `REFRESH_TOKEN_EXPIRES_IN`). For **Finance role** we override access TTL to **5 min** and refresh to **8 h** so an idle Finance session can't be resumed days later to push a pay run.
- **`sid` is new for HR**: a server-side session row (Redis + a `Session` table mirror) lets us do **immediate, surgical revocation** (logout-all, admin force-logout, "your role changed") without waiting for token expiry — Sitepresso today relies only on `passwordChangedAt` for revocation (`tokenPredatesPasswordChange`). We keep that mechanism *and* add `sid` revocation.

### 3.3 Token lifecycle & rotation

- **Cookies:** `httpOnly`, `secure` (prod), `SameSite=Lax`, `Domain=.hr.com` for platform subdomains, **host-only** for white-label custom domains (a `Domain=.hr.com` cookie is rejected by the browser on `tenant.com`). This host-scoped vs shared-domain decision is already implemented in `generateToken.js` (`usesSharedCookieDomain`, `buildScopedCookieName`) and is *exactly* what we need for white-label ESS.
- **Refresh rotation:** on each refresh we mint a new access token (`setTokenCookie`) and, when sliding, a new refresh token; the prior refresh `jti` is added to a Redis **deny-list** (rotation-reuse detection). If a revoked refresh token is presented → **revoke the whole session family** (token-theft response).
- **Revocation triggers (all force re-auth):** password change (`passwordChangedAt` predate check — existing), role/permission change, employer-initiated offboarding, suspected compromise, admin force-logout, tenant suspension by super-admin.
- **`SameSite=Lax` + CSRF:** because auth is cookie-borne, all **state-changing** routes additionally require either a custom header (`X-Requested-With`/`X-CSRF-Token` double-submit) *or* an `Origin`/`Referer` allowlist check (the `originCheck` CORS allowlist already exists in `backend/src/index.js`). White-label origins are added to the allowlist dynamically from verified custom domains.

### 3.4 Multi-factor & step-up authentication (new)

| Scope | Requirement |
|---|---|
| Super-admin (`admin.hr.com`) | **Mandatory** phishing-resistant MFA (WebAuthn/FIDO2 hardware key) + Cloudflare Access device posture. No password-only path exists. |
| Tenant-admin / HR / Finance | **Mandatory** TOTP or WebAuthn at login; tenant policy can require WebAuthn. |
| Manager | MFA strongly recommended; tenant-admin can mandate it via tenant security policy. |
| Employee (ESS) | TOTP optional by default; **mandatory** to view/download own bank details, tax docs, or Form 16 / IR summaries. |

**Step-up (re-authentication) — required immediately before these "danger actions" regardless of session age:**

1. Approving / locking / disbursing a **pay run**.
2. Changing an **employee bank account / payment instruction** (employer-side *or* employee self-service).
3. **Bulk export** of employee PII or payroll (> N rows).
4. Creating/rotating a **public API key** or webhook secret.
5. Changing **tenant security policy**, SSO config, or another operator's role.
6. Super-admin **impersonation** start (§4.7).

Step-up = re-present MFA factor; result is a short-lived (`amr` upgraded, `step_up_exp` ~5 min) capability recorded in the session and audited. Implementation: a `requireStepUp(action)` middleware sits *after* `requirePermission(...)` on these routes.

### 3.5 Password & credential policy

- Hashing: **Argon2id** for new HR vertical (Sitepresso uses bcrypt; we keep bcrypt verification for migrated accounts and re-hash to Argon2id on next successful login). Params: `m=19456 (19 MiB), t=2, p=1` minimum, tuned to ~250 ms on prod hardware.
- Min length 12, screened against a breached-password set (k-anonymity range query against HIBP, no full password leaves the server); no composition rules (NIST 800-63B aligned).
- Password reset = single-use, 30-min-TTL, hashed token; reset invalidates all sessions and bumps `passwordChangedAt`.

### 3.6 Anti-automation & lockout (extends `abuse.middleware.js`)

- Login: rate-limited per-IP **and** per-account; after 5 failures in 15 min → exponential backoff + Turnstile challenge; after 10 → 15-min account soft-lock with email alert to the user.
- Credential-stuffing signal: many distinct accounts failing from one IP/ASN → CF WAF rule + temporary ASN throttle.
- IPv6 handled via `ipKeyGenerator` /64 normalisation (already in `abuse.middleware.js`) so an attacker can't rotate the low 64 bits to evade limits.
- Public ESS signup and "forgot password" enumeration-hardened: identical response + timing whether or not the email/employee exists.

### 3.7 Machine identities (public API + integrations)

- API keys: `hr_live_<random>`; only the **SHA-256 hash** is stored (`ApiKey.keyHash`, pattern from `apiKey.middleware.js`), shown once at creation.
- Scopes per HR resource (`read:employees`, `write:payruns:none-by-default`, `read:payslips`, …); writes to payroll/bank data are **not** grantable to API keys at launch (read + non-financial writes only) — money movement requires an interactive, MFA-stepped human.
- Per-key **IP allowlist** (new) and per-key rate limit; `lastUsedAt` touched on every call; one-click revoke.
- Inbound webhooks from gateways (Razorpay/Stripe/Paddle) verified by **signature** (Sitepresso already does HMAC verification for Paddle/Stripe/Razorpay — see `PADDLE_SECURITY_REVIEW.md`), with replay protection via timestamp window + idempotency keys.

---

## 4. Authorization — RBAC, the Permission Matrix & Enforcement

### 4.1 Role model

We keep Sitepresso's two-layer model: a coarse **system role** enum on `User.role` plus a fine-grained **custom role** (`BusinessRole.permissions` JSON, resolved by `effectivePermissions()` in `rbac.js`). For HR we redefine the enum and the permission catalogue.

| System role | Scope | Typical principal |
|---|---|---|
| `SUPER_ADMIN` | **Cross-tenant**, platform-wide (us) | Our staff at `admin.hr.com` |
| `TENANT_ADMIN` | One tenant, all of HR + Finance + settings | Employer's HR/IT owner |
| `HR` | One tenant, people data + leave + non-pay config | HR generalist |
| `FINANCE` | One tenant, payroll runs, payments, statutory filing | Payroll/Finance officer |
| `MANAGER` | One tenant, **own team only** (approvals, read) | Line manager |
| `EMPLOYEE` | Self only (ESS) | Every employee |

`SUPER_ADMIN` bypasses tenant filters by design — therefore it is the **most dangerous** role and is gated hardest (CF Access + WebAuthn + impersonation rules in §4.7). `effectivePermissions()` short-circuits to "all" for SUPER_ADMIN today (`requirePermission` returns `next()` immediately for it); for HR we *narrow* even super-admin so that reading raw tenant payroll PII requires an explicit, audited, time-boxed support grant (§4.7), not the standing role.

### 4.2 HR/Payroll permission catalogue (replaces booking/ecom keys)

Permission keys live in `backend/src/hr/lib/hrPermissions.js` (mirrors `rbac.js` structure). Grouped:

| Group | Keys (selected) |
|---|---|
| People | `people.read`, `people.read.sensitive` (bank/PAN/IRD/DOB), `people.write`, `people.create`, `people.terminate`, `people.export` |
| Compensation | `comp.read`, `comp.write`, `comp.read.others` (vs own team) |
| Bank/Payment | `bank.read`, `bank.write` (step-up), `payment.file.generate` (step-up), `payment.file.download` (step-up) |
| Payroll run | `payrun.view`, `payrun.create`, `payrun.edit`, `payrun.approve` (step-up), `payrun.lock`, `payrun.disburse` (step-up), `payrun.rollback` |
| Statutory | `statutory.view`, `statutory.file.generate` (PF/ESI/PT/TDS 24Q · PAYE/payday/KiwiSaver), `statutory.file.submit` |
| Leave/Time | `leave.read.team`, `leave.read.all`, `leave.approve`, `attendance.edit`, `roster.manage` |
| Documents | `doc.read.team`, `doc.read.all`, `doc.upload`, `payslip.read.all`, `payslip.read.own` |
| Settings | `settings.org`, `settings.security`, `settings.payroll.config`, `settings.api_keys` (step-up), `settings.sso` |
| Audit | `audit.read` |

Each key has a `sensitive` and a `stepUp` flag. Validation (`validatePermissions`) rejects unknown keys and non-boolean values — exactly Sitepresso's pattern.

### 4.3 The permission matrix (default presets)

✓ = allowed · ✓team = own team only · ✓self = own record only · ⤴ = allowed but requires step-up MFA · — = denied

| Capability | SUPER_ADMIN¹ | TENANT_ADMIN | HR | FINANCE | MANAGER | EMPLOYEE |
|---|---|---|---|---|---|---|
| View employee profile | ✓ (via grant) | ✓ | ✓ | ✓ | ✓team | ✓self |
| View **sensitive** PII (bank/PAN/IRD/DOB) | grant+audit | ✓ | ✓ | ✓ | — | ✓self ⤴ |
| Edit employee profile | — | ✓ | ✓ | — | — | ✓self (limited fields) |
| Create / onboard employee | — | ✓ | ✓ | — | — | — |
| Terminate / offboard | — | ✓ | ✓ | — | — | — |
| Change employee **bank account** | — | ✓ ⤴ | ✓ ⤴ | ✓ ⤴ | — | ✓self ⤴ |
| View compensation (all) | grant+audit | ✓ | ✓ | ✓ | ✓team | ✓self |
| Edit compensation | — | ✓ | ✓ | ✓ | — | — |
| Create / edit pay run | — | ✓ | — | ✓ | — | — |
| **Approve** pay run | — | ✓ ⤴ | — | ✓ ⤴ | — | — |
| **Disburse** / generate payment file | — | ✓ ⤴ | — | ✓ ⤴ | — | — |
| Rollback pay run | — | ✓ ⤴ | — | ✓ ⤴ | — | — |
| Generate statutory filing (PF/ESI/PT/TDS/PAYE/payday) | — | ✓ | — | ✓ | — | — |
| Approve leave | — | ✓ | ✓ | — | ✓team | — |
| Apply for leave | — | — | — | — | — | ✓self |
| Edit attendance / roster | — | ✓ | ✓ | — | ✓team | — |
| **Bulk export** PII / payroll | grant+audit ⤴ | ✓ ⤴ | ✓ ⤴ | ✓ ⤴ | — | — |
| Download own payslip / Form 16 / IR summary | — | ✓ | ✓ | ✓ | ✓self | ✓self |
| Manage roles / permissions | — | ✓ ⤴ | — | — | — | — |
| Manage tenant security policy / SSO | — | ✓ ⤴ | — | — | — | — |
| Create / rotate API key | — | ✓ ⤴ | — | — | — | — |
| Read audit log | — | ✓ | ✓(people) | ✓(payroll) | — | ✓self events |
| Cross-tenant platform admin | ✓ | — | — | — | — | — |
| Manage plans / billing / feature flags | ✓ | — | — | — | — | — |
| Impersonate (support) | ✓ ⤴ | — | — | — | — | — |

¹ SUPER_ADMIN can perform **platform** operations standing; access to a *tenant's* employee/payroll PII requires a **time-boxed, tenant-acknowledged support grant** that is logged (§4.7). "grant+audit" denotes this.

> **Segregation of duties (SoD) — enforced, not advisory.** The same operator may **create** a pay run *or* **approve** it, but the platform **blocks the same `userId` from doing both** when the tenant enables "two-person payroll" (default ON for tenants with > 25 employees). Approve fails with `SOD_CONFLICT` if `payrun.createdBy === currentUser.id`. Similarly, the operator who *adds/changes a payee bank account* cannot be the operator who *approves the first pay run that pays into it* within a cooling window (default 24 h) — this directly defeats the salary-diversion fraud (§11, T-C).

### 4.4 Enforcement points (defence in depth, four layers)

1. **Edge (`apps/router`)** — resolves tenant + surface from host; rejects requests for a surface the host isn't mapped to. Never reads tenant from the client body.
2. **Authentication middleware** — `requireAuth` (operator) / `requireEmployee` (ESS) populate `req.user`/`req.employee` with a *server-fetched* role + `businessId` (never trusts the JWT's role blindly: the DB row is authoritative — see `authenticateOperator` re-fetching `USER_SELECT`).
3. **Authorization middleware** — `requireRole(...)`, `requireHrPermission(key)`, and `requireStepUp(action)` per route. `requireHrPermission` mirrors `requirePermission`/`requireEcomPermission`: super-admin bypass, then `effectivePermissions(req.user)[key]`, with **location/legal-entity scoping** (a Manager's `leave.approve` only resolves for their own team/cost-centre, like the location-scoped ecom grants).
4. **Data layer** — tenant-isolation Prisma middleware + Postgres RLS (§5) and **field-level masking** (§4.6). Even a route bug that forgets layer 3 cannot return another tenant's row, and cannot return a sensitive column to a principal lacking `*.read.sensitive`.

### 4.5 Manager "own team only" scoping

`MANAGER` permissions resolve against a **reporting graph** (`Employee.managerId` closure, optionally cost-centre/department). The middleware computes `req.scope.employeeIds` once per request (cached) and every team-scoped query is constrained to that set *in addition to* `businessId`. A manager requesting an employee id outside their subtree gets **404** (not 403 — we don't confirm the row exists), matching `findOwned`'s "not found" semantics.

### 4.6 Field-level masking (new)

Route-level allow/deny is insufficient for payroll: HR may legitimately list employees but must not see bank numbers unless they hold `people.read.sensitive`. We add a **serialization guard**: response DTOs run through `maskSensitive(dto, req.user.permissions)` which redacts/partially-masks (`bank: "•••• 4321"`, `pan: "•••••1234F"`, `ird: "•••-•••-123"`) unless the caller holds the corresponding `*.read.sensitive` key, and full reveal of a single record is itself an audited event. This is enforced centrally in the HR response serializer so a controller cannot accidentally leak a column.

### 4.7 Super-admin support access & impersonation (new, strict)

Sitepresso has only a comment-level notion of impersonation (`tenant.controller.js`). For payroll we build a real, constrained flow:

- **No standing read of tenant payroll PII.** Super-admin sees tenant *metadata* (plan, status, counts, billing) by default.
- **Support grant:** to view a tenant's employee/payroll data, an operator opens a support session: pick tenant → state reason (ticket id) → **step-up MFA** → time-boxed grant (default 60 min, max 8 h). Optionally requires **tenant approval** (tenant-admin clicks "allow support access" — default ON; off only with explicit tenant opt-out and a signed waiver).
- **Impersonation** issues a *scoped, watermarked* operator session with `actingAs` + `onBehalfOf` claims; the impersonated session is **read-mostly** (write actions disabled unless the grant explicitly allows, and money-movement actions are *never* impersonatable). The UI shows a persistent red "VIEWING AS — support session" banner.
- **Everything is audited** to `AuditEvent` with `actorRealId` (the human) distinct from `actorEffectiveId` (the impersonated user), reason, and grant id. The tenant can see "Sitepresso support accessed your account on … for …" in their own audit view. Detailed UI in `15-super-admin-platform.md`.

---

## 5. Hard Tenant Isolation

This is the section that matters most. The guarantee we make: **no request, query, export, file URL, cache entry, or background job can return data belonging to a tenant other than the one in scope** — and the property holds even when an individual controller is buggy.

### 5.1 Isolation model: shared schema, `businessId` row-key + RLS

We keep Sitepresso's **shared-database, shared-schema, row-level `businessId`** model (every tenant-owned table carries `businessId` with `onDelete: Cascade`, see `backend/prisma/schema.prisma`). We harden it with **three independent, overlapping mechanisms** so that no single mistake leaks data:

```
Request → (1) server-derived businessId  →  (2) Prisma tenant middleware  →  (3) Postgres RLS
            never client-supplied            auto-injects businessId          enforces in DB engine
```

### 5.2 (1) `businessId` is server-derived, never client-supplied

- For operators: `req.user.businessId` comes from the **DB row** fetched in `authenticateOperator`, keyed off the token's `id` — not from any header/body/JWT-asserted tenant.
- For employees: `businessId` is a **mandatory token claim** bound at login and re-checked against the resolved tenant host in `authenticateCustomer` (`tenantBusinessId !== customer.businessId → 403`). This exact cross-host check already exists in `auth.middleware.js` — it stops a valid employee token for tenant A being replayed on tenant B's white-label domain.
- The edge router resolves tenant by **host**, and the API independently resolves/validates it. A mismatch is a hard 403. No endpoint accepts `?businessId=` from a client.

### 5.3 (2) Mandatory tenant-isolation Prisma middleware (promoted from `findOwned`)

Sitepresso's `findOwned` is *opt-in* (a controller must remember to call it). For payroll that is not good enough. We install a **Prisma client extension / middleware** that, for every model carrying `businessId`:

- **Injects** `where.businessId = ctx.businessId` on `findFirst/findMany/findUnique/update/updateMany/delete/deleteMany/count/aggregate`.
- **Stamps** `data.businessId = ctx.businessId` on `create/createMany`.
- **Rejects** (throws `TenantIsolationError`, 500 + alert) any query against a tenant-owned model when `ctx.businessId` is absent and the caller is not a `SUPER_ADMIN` operating under an explicit `withCrossTenant()` escape hatch.

`ctx` is carried via Node `AsyncLocalStorage` set in the auth middleware, so controllers can't forget it. Cross-tenant access (super-admin, platform jobs) must use an *explicit, audited* `prisma.$crossTenant(reason)` wrapper — making cross-tenant queries **greppable and reviewable** rather than the default.

```js
// backend/src/hr/lib/tenantPrisma.js (new)
prisma.$extends({
  query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    const ctx = tenantStore.getStore();           // AsyncLocalStorage
    if (TENANT_MODELS.has(model)) {
      if (!ctx?.businessId && !ctx?.crossTenant)
        throw new TenantIsolationError(`${model}.${operation} without tenant context`);
      if (ctx?.businessId) injectBusinessId(operation, args, ctx.businessId);
    }
    return query(args);
  }}},
});
```

### 5.4 (3) Postgres Row-Level Security as the backstop

Even if the app layer is bypassed (SQL injection, a raw `$queryRaw`, a future direct-DB tool), RLS in the engine enforces isolation:

```sql
ALTER TABLE "Employee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Employee" FORCE ROW LEVEL SECURITY;   -- applies even to table owner
CREATE POLICY tenant_isolation ON "Employee"
  USING ("businessId" = current_setting('app.business_id', true))
  WITH CHECK ("businessId" = current_setting('app.business_id', true));
```

The app sets `SET LOCAL app.business_id = $tenant` at the start of each transaction (per request) using a **non-superuser, non-`BYPASSRLS`** application DB role. Super-admin cross-tenant work uses a separate, narrowly-scoped role and is fully audited. `FORCE ROW LEVEL SECURITY` ensures even the table owner is subject to the policy. This is the layer that survives an app-code mistake.

### 5.5 Isolation in everything else (the parts people forget)

| Vector | Leak risk | Control |
|---|---|---|
| **Redis** (sessions, cache, queues) | Cache key collision across tenants | All keys prefixed `t:{businessId}:...`; cached query results keyed by tenant; no global keys hold tenant data |
| **Background jobs** (pay run, filing, emails) | Job picks up wrong tenant rows | Job payload carries `businessId`; worker sets the same `AsyncLocalStorage` ctx + RLS `SET LOCAL`; jobs are tenant-scoped, never "process all rows" |
| **Object store** (payslips, payment files, exports) | Guessable / cross-prefix URL | Keys: `t/{businessId}/payslips/{period}/{empId}.pdf`; **pre-signed, short-TTL** URLs only; bucket policy denies listing and cross-prefix reads; one bucket-prefix per residency zone (§9.5) |
| **Search/index** | Cross-tenant hits | Tenant filter is a *mandatory* query clause, not a ranking boost |
| **Logs / errors / Sentry** | PII or other tenant's id in a shared log | Structured logging with PII scrubbing (§7.4); `businessId` is metadata, employee PII never logged |
| **Webhooks / notifications** | Email/SMS to wrong tenant's people | Recipient resolved from the tenant-scoped query; templates rendered per-tenant; no global broadcast of tenant content |
| **Custom-domain cookies** | Cookie bleed across white-label domains | Host-only cookies on white-label domains (`usesSharedCookieDomain` → false), shared cookie only on `*.hr.com` |
| **CSV/Excel exports** | Formula injection | Sanitise leading `= + - @` in cell values; exports tenant-scoped by construction |

### 5.6 Continuous isolation testing

- **Property test in CI:** for every tenant-owned model, a generated test creates rows for tenant A and B, then asserts every list/get/update/delete endpoint with tenant A's session returns/affects **zero** B-rows. Fails the build on any leak.
- **RLS smoke test:** a fixture sets the wrong `app.business_id` and asserts queries return 0 rows.
- **`$queryRaw` audit:** a lint rule flags any raw SQL; each must be reviewed and must include a tenant predicate or run under an explicit cross-tenant role.
- **Negative IDOR suite:** authenticated tenant A tries B's payslip URL, B's employee id, B's pay run id → all 404/403.

---

## 6. Encryption

### 6.1 In transit

- **External:** TLS 1.2+ everywhere; HSTS (Sitepresso sets a 6-month HSTS header in `scripts/nginx-hardening.conf`; we extend to **1 year + `includeSubDomains` + preload** for the apex). Cloudflare **Full (strict)** to origin with a pinned Origin Certificate (`SECURITY.md`). White-label domains via **Cloudflare for SaaS** with auto-provisioned certs.
- **Internal:** TLS to Postgres (`sslmode=verify-full`) and to Redis (`rediss://` + AUTH). KMS calls over TLS. No plaintext service-to-service hops inside the VPC for sensitive data.

### 6.2 At rest — three tiers

| Tier | Mechanism | Covers |
|---|---|---|
| **Volume / database** | Storage-level encryption (KMS-managed keys) on the DB volume + automated snapshots; object store SSE-KMS | Everything, including indexes, WAL, backups |
| **Column / field (application)** | **AES-256-GCM envelope encryption** via `crypto.js` pattern, but with a **dedicated KMS-derived Data Encryption Key per tenant**, NOT `JWT_SECRET` | The crown jewels: bank account/IFSC/BSB, PAN, Aadhaar (if stored), IRD #, tax declarations, statutory IDs, government docs |
| **Object** | Per-object SSE-KMS + pre-signed access | Payslips, payment files, exports, uploaded docs |

> **Critical hardening over Sitepresso.** `backend/src/core/lib/crypto.js` today derives its key from `JWT_SECRET` (SHA-256). That couples session-signing with data-at-rest and means a leaked `JWT_SECRET` decrypts stored secrets. For payroll we **decouple**: a KMS-held root key → per-tenant **Data Encryption Keys (DEKs)** (envelope encryption). The DB stores only the **wrapped** DEK; plaintext DEKs live only in process memory for the request and are never persisted. We keep the proven GCM `iv|tag|ciphertext` wire format and the integrity-on-decrypt behaviour from `crypto.js`.

### 6.3 Key management & rotation

- Root keys in a managed **KMS/HSM** (region-pinned per residency zone). Application role can **encrypt/decrypt**, not **export** keys (boundary B7).
- **Per-tenant DEK** enables crypto-shredding: to satisfy a tenant deletion or a residency exit, destroy the tenant's wrapped DEK and the ciphertext is irrecoverable.
- **Rotation:** root key annual (KMS automatic); DEKs re-wrapped on root rotation; field re-encryption on DEK rotation is a background, tenant-scoped job. `JWT_SECRET` rotation story stays "rotate → re-sign on next refresh" (sessions invalidate gracefully).
- **Secrets at rest:** no secrets in the repo. App secrets in a secrets manager (AWS Secrets Manager / Doppler / Vault), injected as env at boot; `.env` files are dev-only and git-ignored (Sitepresso pattern). CI/CD secrets in the platform's encrypted store with least-privilege deploy roles.

### 6.4 What we never store

- **No raw card data** — ever. Billing via Razorpay (IN) / Stripe (NZ) / Paddle MoR (RoW); tokens only (Sitepresso billing pattern, `SECURITY.md`).
- **Aadhaar minimisation:** we **avoid storing the full Aadhaar number** wherever PF/ESI/tax flows accept a masked/last-4 or a reference; where a full value is unavoidable it is field-encrypted, access-gated (`people.read.sensitive` + step-up), and never logged or exported in plaintext. (Aadhaar handling has additional UIDAI obligations — see open question O-3.)
- **Passwords:** Argon2id hashes only; never reversible.

### 6.5 Backups

- Encrypted, automated daily DB snapshots (KMS), **region-pinned to the tenant's residency zone** (§9.5); cross-region copy only within the same legal zone. Point-in-time recovery via WAL.
- Backup **restore drills** quarterly; restores land in an isolated account, never over prod.
- Backups inherit RLS and column encryption — a stolen backup yields ciphertext for the crown-jewel columns and still needs KMS to decrypt (the whole point of §6.2).
- Object-store versioning + **Object Lock (WORM)** on payment files and statutory filings for tamper-evidence and ransomware resilience.

---

## 7. Audit Logging

### 7.1 Design: append-only, hash-chained `AuditEvent`

We generalise Sitepresso's `AccountAuditLog` (immutable, survives purge, used for subpoena/forensics) and `PricingAuditLog` into a single tenant-partitioned, **append-only, hash-chained** stream.

```prisma
model AuditEvent {
  id              String   @id @default(uuid())
  businessId      String?            // null for platform-level events
  occurredAt      DateTime @default(now())
  // WHO
  actorRealId     String?            // the human (even when impersonating)
  actorEffectiveId String?           // the principal acted-as
  actorType       String             // OPERATOR | EMPLOYEE | SYSTEM | SUPPORT
  actorRole       String?
  // WHAT
  action          String             // e.g. PAYRUN_APPROVED, BANK_ACCOUNT_CHANGED
  resourceType    String             // Employee | PayRun | PaymentFile | ...
  resourceId      String?
  outcome         String             // SUCCESS | DENIED | ERROR
  // CONTEXT
  ip              String?
  userAgent       String?
  requestId       String?
  supportGrantId  String?
  reason          String?
  // CHANGE
  before          Json?              // redacted/encrypted snapshot
  after           Json?
  // TAMPER-EVIDENCE
  prevHash        String?            // hash of previous event in this stream
  hash            String             // sha256(canonical(this) || prevHash)
  @@index([businessId, occurredAt])
  @@index([action, occurredAt])
  @@index([resourceType, resourceId])
  @@index([actorRealId, occurredAt])
}
```

- **Append-only** at the DB level: a trigger forbids `UPDATE`/`DELETE` on `AuditEvent`; the application DB role lacks those grants. RLS limits tenants to their own events (`businessId`); platform events visible only to super-admin.
- **Hash-chain** per `(businessId)` stream: each row hashes the prior row's hash, so any silent deletion/edit is detectable. Periodically the chain head is anchored (signed + timestamped, optionally written to WORM object storage) to give an external tamper proof.

### 7.2 What is always audited (non-exhaustive)

Authentication (login success/fail, MFA, step-up, logout, password/role change, session revoke); **every** money-movement action (pay-run create/edit/approve/lock/disburse/rollback, payment-file generate/download, bank-account add/change); statutory filing generate/submit; **sensitive PII read** (full bank/PAN/IRD reveal, bulk export — *the read itself is the event*); permission/role/security-policy/SSO/API-key changes; super-admin support grant + impersonation start/stop; employee lifecycle (onboard/terminate, soft-delete, purge); consent grant/withdraw; data-subject requests (access/erasure/correction); admin overrides.

### 7.3 Access, retention & immutability

- Tenants read their own audit via `audit.read`; super-admin reads platform + (under grant) tenant audit.
- Retention: payroll/financial audit **≥ 8 years** (aligns with IN tax-record norms and NZ IRD's 7-year tax-record requirement — see §9.2 for the NZ 6-yr-employment / 7-yr-tax split; we standardise audit to 8 to envelope both). Security/access audit **≥ 1 year hot, ≥ 7 years cold**. CERT-In log retention (§10.2) is **180 days minimum, stored in India** for IN-zone tenants.
- Audit data is itself PII-bearing → encrypted, access-controlled, never the target of a tenant export (excluded, as Sitepresso's `dataExport.controller.js` already excludes audit-log entries).

### 7.4 Operational logging hygiene

- Structured JSON logs; a **PII scrubber** strips bank/PAN/IRD/Aadhaar/salary/DOB before write (allowlist of safe fields). `businessId`, `requestId`, `userId` are kept as correlation metadata; raw PII never is.
- Sentry/error tracking configured with `beforeSend` scrubbing + EU/region-appropriate data residency for the error pipeline; no payload bodies for payroll routes.
- Log access is itself privileged and audited; logs region-pinned for IN-zone (CERT-In).

---

## 8. Privacy: DPDP Act 2023 + DPDP Rules 2025 (India) and Privacy Act 2020 (NZ)

### 8.1 Roles & the data-processing relationship

| Concept | India (DPDP Act 2023) | New Zealand (Privacy Act 2020) |
|---|---|---|
| The platform (us) | **Data Processor** acting for the tenant, *and* **Data Fiduciary** for our own operator accounts/marketing | **Agency** processing on behalf of the employer (also an Agency) |
| The tenant (employer) | **Data Fiduciary** for its employees' data | **Agency** (the employer) |
| The employee | **Data Principal** | **Individual** |
| Required contract | **Data Processing Agreement** (Fiduciary↔Processor) | DPA / IPP-aligned terms |

We provide a **DPA** to every tenant (Sitepresso already ships a DPA template at `/legal/dpa` — we replace the GDPR-centric version with DPDP- + Privacy-Act-2020-specific terms). The tenant is the controller/fiduciary of employee data; we process strictly on instruction.

> **Why the processor/fiduciary split raises our bar, not lowers it.** Under DPDP, the **Data Fiduciary (tenant) remains vicariously liable for breaches committed by its Data Processor (us)** ([DPDP Act 2023](https://www.ey.com/en_in/insights/cybersecurity/decoding-the-digital-personal-data-protection-act-2023)). A processor also **may not engage a sub-processor without the fiduciary's authorisation** — which is exactly why §9.4 publishes the sub-processor list, maps each to its residency zone, and gives tenants change-notice. Our DPA contractually flows these down, and the **₹250 crore** safeguards-failure penalty (§8.2) sits behind the security controls in §5/§6.

### 8.2 India — DPDP Act 2023 & DPDP Rules 2025 (verified, with effective dates)

- **DPDP Rules 2025 were published in the Official Gazette on 14 Nov 2025** with **phased commencement** ([PIB/MeitY](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf), [Shardul Amarchand Mangaldas](https://www.amsshardul.com/insight/enforcement-of-the-dpdp-act-and-notification-of-the-dpdp-rules/), [EY](https://www.ey.com/en_in/insights/cybersecurity/transforming-data-privacy-digital-personal-data-protection-rules-2025)). The Gazette/commencement dates are the **14th** of each month; some secondary commentary cites the **13th** (the date the Rules were signed) — we use the Gazette dates below and treat the 13th/14th delta as immaterial to any of our deadlines:
  - **14 Nov 2025:** commencement provisions + Data Protection Board of India (DPBI) establishment live (Rules 1–2 and Board-constitution provisions).
  - **14 Nov 2026:** consent-manager registration/obligations live (12 months post-notification).
  - **14 May 2027:** the substantive operational obligations — **notice & consent, security safeguards (Rule 6), breach notification (Rule 7), retention & erasure (Rule 8), data-principal rights, children's data, cross-border transfer, Significant Data Fiduciary duties** — come into force (18 months post-notification) ([Shardul Amarchand](https://www.amsshardul.com/insight/enforcement-of-the-dpdp-act-and-notification-of-the-dpdp-rules/), [Seclore](https://www.seclore.com/fundamentals/dpdp-rules-2025-compliance-guide/)).
- **We build to the full Rules now** (don't wait for 14 May 2027): notice, consent records, rights workflow, retention engine, breach process, security safeguards under Rule 6.
- **Employment-data nuance:** much HR processing rests on **employment necessity / legitimate-use** rather than consent (DPDP has carve-outs for processing necessary for employment, prevention of fraud, etc.), but we still record the lawful basis per purpose and obtain consent where required (e.g., optional wellness, voluntary disclosures, marketing to operators).
- **Penalty exposure:** up to **₹250 crore** per the schedule (e.g., failure to take reasonable security safeguards) — motivates §5/§6.
- **Significant Data Fiduciary (SDF):** if the Central Government designates us/a tenant an SDF, additional duties apply — appoint a **DPO in India**, **annual DPIA + independent audit**, algorithmic-fairness checks ([Medianama](https://www.medianama.com/2025/11/223-dpdp-rules-2025-data-fiduciary-obligations/)). We architect for this (audit hooks, DPIA register) even if not yet designated.

### 8.3 New Zealand — Privacy Act 2020 (verified)

- **13 Information Privacy Principles**; **IPP 12** restricts **cross-border disclosure** — personal information sent overseas must be protected by comparable safeguards ([FPF](https://fpf.org/blog/a-deep-dive-into-new-zealands-new-privacy-law-extraterritorial-effect-cross-border-data-transfers-restrictions-and-new-powers-of-the-privacy-commissioner/)). Drives our NZ residency option (§9.5).
- **Notifiable privacy breach** = a breach that has caused, or is likely to cause, **serious harm**; must notify the **Privacy Commissioner and affected individuals as soon as practicable** after becoming aware. The Act sets **no statutory hour-count** — "as soon as practicable" is the legal standard; the **72-hour** figure is the **Office of the Privacy Commissioner's expectation/guidance**, not a deadline in the statute ([Privacy Act Part 6](https://www.legislation.govt.nz/act/public/2020/0031/latest/LMS23530.html), [OPC NotifyUs](https://www.privacy.org.nz/responsibilities/privacy-breaches/notify-us/)). We operationalise the OPC's 72-hour expectation as our internal SLA.
- **Failure to notify is an offence**, fine up to **NZD $10,000** ([OPC](https://www.privacy.org.nz/responsibilities/privacy-breaches/)).
- **Privacy Officer** designated under the Act (Sitepresso already names one in `SECURITY.md`); we appoint a named Privacy Officer for the HR product.

### 8.4 Data-subject / data-principal rights — one workflow, two regimes

| Right | DPDP 2023 | Privacy Act 2020 | Our implementation |
|---|---|---|---|
| Access / portability | ✓ (s.11) | ✓ IPP 6 | **Employee-scoped export** (extends `dataExport.controller.js`): self-service JSON+PDF, signed + short-TTL link, step-up to download. Tenant-scoped export for the employer. |
| Correction | ✓ (s.12) | ✓ IPP 7 | Employee requests correction via ESS; routed to HR for verification; audited. Statutory/immutable fields (filed returns) corrected via amendment, not edit. |
| Erasure | ✓ (s.12) + Rule 8 retention | (limited; via retention) | §9 erasure engine with statutory carve-outs; crypto-shred via DEK destruction. |
| Withdraw consent | ✓ | n/a (basis-dependent) | Consent register (§8.5); withdrawal stops the consented processing, doesn't delete legally-required records. |
| Grievance / complaint | ✓ (grievance officer) | ✓ (complain to OPC) | In-app grievance channel + named officer; SLA tracked. |
| Nominate (DPDP) | ✓ | n/a | Employee can nominate (e.g., on death/incapacity) to exercise rights. |

**Request flow (state machine):** `RECEIVED → IDENTITY_VERIFIED → IN_PROGRESS → (FULFILLED | PARTIALLY_FULFILLED | REJECTED) → CLOSED`, each transition audited, each with an SLA timer (we target ≤ 30 days; tenants can tighten). Requests route to the **tenant** for employee data (they're the fiduciary) with us assisting as processor.

### 8.5 Consent & notice

- **Consent records** (`ConsentRecord`): purpose, lawful basis, version of the notice shown, timestamp, channel, withdrawal timestamp. Itemised, purpose-specific, withdrawable, in English + Hindi + (where relevant) the eighth-schedule languages required by DPDP for notices (i18n base exists: en/hi — extend).
- **Privacy notice** at collection (DPDP s.5) in clear language; cookie consent for non-essential analytics (Sitepresso's `CookieConsent.js` / `PostHogInit.js` opt-in pattern reused — analytics off until accept).
- We do **not** use employee payroll data for marketing or model-training; this is contractually and technically fenced.

---

## 9. Data Residency, Retention & Deletion

### 9.1 Residency zones

| Zone | Primary region | Use |
|---|---|---|
| `IN` | India (e.g. `ap-south-1`) | India-resident tenants; satisfies **CERT-In "ICT logs stored in India"** (mandatory) + **RBI payment-data localisation** for payment instructions (mandatory where applicable) + tenant comfort for PF/ESI/PAN data |
| `NZ`/`AU` | Australia/NZ region | NZ tenants; supports IPP 12 comparable-safeguards posture |
| `ROW` | EU/region of choice | Anything else |

A tenant's residency zone is chosen at onboarding and **pins** its DB rows, backups, object storage, KMS keys, and logs to that zone. Cross-zone movement is a deliberate, contracted migration — never implicit. (Architecture detail in `02-system-architecture.md`.)

> **Accuracy note — DPDP does NOT mandate general data localisation.** The DPDP Act 2023 (s.16) uses a **negative-list / blocklist** model: personal data may be transferred anywhere *except* to countries the Central Government restricts by notification — and as of mid-2026 **no restricted-country list has been notified** ([DPDP s.16](https://www.dpdpa.com/dpdpa2023/chapter-4/section16.html), [DPDP Rules 2025 Rule 15](https://www.dpdpa.com/dpdparules/rule15.html)). This is the **opposite** of GDPR's whitelist/adequacy model. So the `IN` residency zone is **not** required by DPDP itself; it is driven by the genuinely mandatory **sector-specific** rules — **CERT-In's 180-day in-India log retention** and, where payment data flows through us, the **RBI payment-system data-localisation** directive — plus tenant procurement preference. We offer it as the default for IN-zone tenants but do not overstate a DPDP localisation mandate that does not exist.

### 9.2 Retention schedule (payroll-aware, not GDPR-default)

Statutory record-keeping **overrides** erasure for the data classes the law requires us to keep:

| Data class | Retention | Driver |
|---|---|---|
| Payroll registers, payslips, wage/attendance registers (IN) | **8 years** after the financial year | IN labour-code digital-register + tax norms (we standardise to 8) |
| TDS / 24Q / Form 16 (or successor) records (IN) | **8 years** | Income-tax record norms |
| PF/ESI/PT records (IN) | **7–8 years** | EPFO/ESIC/state norms |
| Wage-time, holiday & leave records (NZ) | **6 years** statutory minimum | NZ Employment Relations Act 2000 (wages & time records) + Holidays Act 2003 — both mandate **6 years**, NOT 7 |
| PAYE / payday-filing / tax records (NZ) | **7 years** | IRD record-keeping (tax law) — the **longer** of the two NZ clocks |
| Security/access audit | 1 yr hot / 7 yr cold | Forensics |
| CERT-In ICT logs (IN-zone) | **≥ 180 days, in India** | CERT-In 2022 Directions (§10.2) |
| Marketing / operator analytics consent data | Until withdrawal + short tail | Consent-based |
| Large-platform user data under **DPDP Rule 8** | **3 years from last interaction** then erase (if designated class; **48 h prior erasure notice** to the principal) | DPDP Rules 2025 Rule 8 ([dpdpa Rule 8](https://www.dpdpa.com/dpdparules/rule8.html)) |

> **Note on DPDP Rule 8 3-year rule:** the prescriptive 3-year-then-delete applies to specific large classes — **e-commerce ≥ 2 crore registered users, online-gaming intermediaries ≥ 50 lakh, social-media ≥ 2 crore** (DPDP Rules 2025 Rule 8 / Third Schedule). Payroll statutory records are exempt as legally-required retention. We model retention **per data class per purpose**, so the engine applies 3-year erasure only where it legally bites and never deletes records the labour/tax law forces us to keep. We also implement the **48-hour pre-erasure notice** mechanism generically.

> **Note on NZ retention (corrected):** the Employment Relations Act 2000 (wages & time records) and Holidays Act 2003 require a **6-year** minimum; IRD/tax law requires **7 years**. We standardise NZ-zone payroll retention to **7 years** (the longer clock) which by construction satisfies the 6-year employment-law obligation — but the two statutes are kept distinct in the retention metadata so a future divergence (e.g. a Holidays Act amendment) re-derives correctly.

### 9.3 Erasure engine

- Built on Sitepresso's **soft-delete + grace-period + anonymise** pattern (`accountDeletion.js`): a deletion request sets `pendingDeletionAt`; a grace window allows undo; then a cron purges PII while preserving the immutable audit row (`AccountAuditLog`/`AuditEvent`) for legal-claims defence and subpoena — *exactly* the carve-out DPDP/Privacy Act permit for legal obligations.
- **Selective erasure:** erase the employee's *contact/identity PII* while retaining the *legally-required payroll record* in pseudonymised form (name → "Former Employee #", but salary/statutory figures retained for the 7–8 year window). After the retention window, full crypto-shred.
- **Tenant offboarding:** on tenant termination, export-then-purge with a contractual grace window; per-tenant **DEK destruction** crypto-shreds field-encrypted data instantly; bulk row purge cascades via `onDelete: Cascade`.

### 9.4 Sub-processors

Maintained, published sub-processor list (Cloudflare, cloud host/KMS, Razorpay/Stripe/Paddle, email/SMS providers, Sentry, etc.), each under a DPA, each mapped to the residency zones it touches; tenants notified of changes (DPDP/Privacy-Act flow-down obligation).

---

## 10. Breach Response

### 10.1 Definitions & severity

A **personal-data breach** = unauthorised processing, accidental disclosure, acquisition, sharing, use, alteration, destruction, or loss of access. Severity SEV-1 (mass PII / cross-tenant leak / payment-file compromise) → SEV-4 (contained, no PII). The clock starts at **awareness/detection**, not at the end of investigation.

### 10.2 Statutory notification clocks (verified)

| Regime | Notify whom | Deadline | Source |
|---|---|---|---|
| **India — DPDP Rule 7** | Data Principals (affected) + DPBI | Affected principals **without delay**; DPBI **initial intimation without delay**, **detailed report within 72 hours** (extendable on Board approval) | [DPDP Rule 7](https://www.dpdpa.com/dpdparules/rule7.html), [PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf) |
| **India — CERT-In** (IT Act s.70B, 2022 Directions) | CERT-In | **Within 6 hours** of noticing a cyber incident; maintain ICT logs **180 days, in India** | [CERT-In Directions 28-04-2022](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf), [UpGuard](https://www.upguard.com/blog/indias-6-hour-data-breach-reporting-rule) |
| **New Zealand — Privacy Act 2020** | Privacy Commissioner + affected individuals | **As soon as practicable** after awareness of a notifiable (serious-harm) breach — **no statutory hour-count**; OPC *guidance* expects ≤ 72 h, which we adopt as our internal SLA. **Failure to notify the Commissioner is an offence, fine up to NZD $10,000** | [Privacy Act Part 6](https://www.legislation.govt.nz/act/public/2020/0031/latest/LMS23530.html), [OPC](https://www.privacy.org.nz/responsibilities/privacy-breaches/notify-us/) |

> **Two parallel Indian clocks.** A single incident that is both a cyber incident *and* a personal-data breach triggers **CERT-In within 6 h** *and* **DPBI initial-without-delay / detailed-within-72 h**. Our runbook treats the **6-hour CERT-In clock as the binding one** for IN-zone incidents and pre-stages the report.

### 10.3 Incident-response runbook (the operational state machine)

```
DETECT ─▶ TRIAGE ─▶ CONTAIN ─▶ ERADICATE ─▶ RECOVER ─▶ NOTIFY ─▶ POST-INCIDENT
  │         │          │            │            │         │            │
  T0     classify   isolate      patch /     restore    legal       blameless
 alert   sev +      keys/        rotate      from        clocks      post-mortem
         scope      sessions/    creds       clean       (§10.2)     + control
                    tenants                  backup                  improvements
```

| Phase | Actions | Owner | Clock |
|---|---|---|---|
| **Detect** | Alerts from WAF, anomaly detection (mass export, off-hours bulk read, cross-tenant query error from §5.3), Sentry, gateway webhooks, customer report | On-call | T0 |
| **Triage** | Assign SEV; identify data classes + affected tenants/principals + residency zones; open incident channel; appoint Incident Commander | IC | T0+30 m |
| **Contain** | Revoke sessions (`sid`/session table), rotate compromised keys/DEKs/JWT secret, disable affected API keys, block IPs at CF, suspend a tenant if needed, freeze pay runs | Security | minutes |
| **Eradicate** | Patch the vuln, remove attacker persistence, validate isolation restored | Eng | hours |
| **Recover** | Restore from clean backup if needed, re-enable services, heightened monitoring | Eng | hours–days |
| **Notify** | **CERT-In ≤ 6 h** (IN cyber incident) → **DPBI/affected without delay, detailed ≤ 72 h** (IN) / **Commissioner + individuals ASAP** (NZ) → **affected tenants** (their DPA SLA, e.g. ≤ 48 h) → tenants then notify their employees as fiduciaries | IC + Legal/Privacy Officer | per §10.2 |
| **Post-incident** | Blameless post-mortem, root cause, tracked control improvements, update this doc | IC | ≤ 5 business days |

- **Pre-staged templates** for CERT-In, DPBI, and OPC reports (fields known in advance) so the 6-hour clock is achievable.
- **Tenant comms:** because tenants are the fiduciaries/agencies for *their* employees, our DPA defines that *we* notify the tenant promptly and *assist* them to notify their employees and regulators; for direct-to-principal cases the law may require principal notice too (DPDP Rule 7).
- **War-game:** tabletop the "cross-tenant payroll leak" and "salary-diversion fraud" scenarios twice a year.

---

## 11. Threat Model (Multi-Tenant Payroll)

Methodology: STRIDE per trust boundary (§2) + the payroll-specific abuse cases. Each threat → control(s) already specified above.

### 11.1 Top threats, ranked

| # | Threat | STRIDE | Scenario | Primary controls |
|---|---|---|---|---|
| **T-A** | **Cross-tenant data leak** | Information Disclosure | A controller forgets a `businessId` filter; an IDOR on a payslip URL; a raw SQL query without a tenant predicate | §5.3 mandatory Prisma middleware (throws without ctx) + §5.4 Postgres RLS `FORCE` + §5.5 prefixed object keys + §5.6 CI isolation property tests + IDOR suite |
| **T-B** | **Privilege escalation within a tenant** | Elevation of Privilege | Employee tampers JWT role; manager reads another team; HR self-grants Finance | Server-fetched role (not JWT-trusted), token `type` discriminator at boundary, `requireHrPermission` + reporting-graph scoping (§4.5), step-up for role changes, field masking (§4.6) |
| **T-C** | **Salary-diversion / payee tampering** | Tampering + Fraud | Attacker (or rogue insider) changes employee bank account, then approves the next pay run | `bank.write` + step-up MFA + **SoD cooling window** (§4.3) + bank-change → employee email/SMS alert + payment-file diff review + audit of before/after (§7) |
| **T-D** | **Mass PII / payroll exfiltration** | Information Disclosure | Compromised HR account bulk-exports everyone; stolen backup | Step-up on bulk export, export volume alerts/anomaly detection, exports audited as the read-event, column encryption so a stolen backup is ciphertext (§6.2/6.5), short-TTL signed export links |
| **T-E** | **Insider abuse via support/impersonation** | Elevation / Repudiation | Our own staff browses tenant salaries | No standing tenant-PII access for super-admin; time-boxed, tenant-acknowledged, step-up support grant; impersonation watermarked + write-limited + fully audited with real-vs-effective actor (§4.7) |
| **T-F** | **Account takeover (operator)** | Spoofing | Phished/cred-stuffed Finance login | Mandatory MFA (WebAuthn for super-admin), CF Access on `admin.hr.com`, lockout + Turnstile (§3.6), breached-password screening, short Finance TTL, session revocation |
| **T-G** | **Stolen / replayed token** | Spoofing | Leaked refresh token reused | Refresh rotation + reuse-detection → revoke family, `sid` server revocation, `passwordChangedAt` predate check (existing), host-scoped cookies, `httpOnly`+`Secure`+`SameSite` |
| **T-H** | **Payment-file tampering in transit/at rest** | Tampering | NACH/direct-credit file altered before bank submission | File generated server-side, hashed + signed, WORM/Object-Lock storage, checksum verified at download, generate+download both step-up + audited |
| **T-I** | **Injection (SQLi / XSS / CSV / SSRF)** | Tampering / Disclosure | Malicious input | Prisma parameterised queries (no string SQL), `$queryRaw` lint-gated, output encoding (no tenant-authored templates by principle), CSV formula-injection sanitisation, SSRF allowlist on outbound (webhooks/integrations) |
| **T-J** | **Webhook / gateway spoofing & replay** | Spoofing | Forged Razorpay/Stripe/Paddle callback marks payroll paid / fraudulent refund | HMAC signature verification (existing pattern, `PADDLE_SECURITY_REVIEW.md`), timestamp window, idempotency keys, amount/state reconciliation |
| **T-K** | **DoS / resource exhaustion** | Denial of Service | Login flood, expensive report spam | CF DDoS + WAF rate rules, app rate limits (`abuse.middleware.js`), per-tenant job concurrency caps, query timeouts, pagination caps |
| **T-L** | **Repudiation of a payroll action** | Repudiation | "I didn't approve that run" | Hash-chained, append-only `AuditEvent` with actor/step-up/IP; immutable; tamper-evident anchoring (§7.1) |
| **T-M** | **Supply-chain / dependency compromise** | Tampering | Malicious npm package | Weekly `npm audit` (Sitepresso cron), lockfile pinning, SBOM, Dependabot, signed builds, least-privilege CI, no `postinstall` from untrusted deps |
| **T-N** | **Secrets leakage** | Disclosure | Secret in repo/log/error | Secrets manager (not `.env` in prod), pre-commit secret scanning, log scrubbing (§7.4), KMS keys non-exportable, DEK decoupled from `JWT_SECRET` (§6.2) |
| **T-O** | **Residency / cross-border violation** | Compliance | NZ data processed/stored outside comparable-safeguard region; IN logs outside India | Residency-zone pinning (§9.1), CERT-In in-India logs, IPP-12 safeguards, sub-processor zone mapping (§9.4) |
| **T-P** | **Misconfiguration** | Multiple | Public bucket, RLS disabled on a new table, debug endpoint exposed | IaC with policy-as-code, "new tenant model must have `businessId` + RLS" CI check, no debug routes in prod, security headers enforced (`nginx-hardening.conf`), least-privilege bucket policies |

### 11.2 Abuse cases beyond STRIDE

- **Terminated-employee access:** offboarding immediately revokes sessions + API keys, removes role, but the **employee retains time-boxed self-service access** to their final payslip / tax docs (ESS read-only window) — balancing security with the legal duty to provide documents.
- **Shared/family device on ESS:** short idle timeout, explicit "this is a shared device" login option (no persistent cookie), MFA to reveal sensitive docs.
- **Manager spying on peers/own manager:** reporting-graph scoping strictly excludes lateral and upward reads; attempts are audited.
- **Over-broad tenant export to evade per-employee controls:** bulk export is step-up + volume-alerted + audited; field-masking still applies unless `*.read.sensitive` held.

### 11.3 Assumptions & residual risk

- We assume Cloudflare, the cloud KMS/HSM, and the gateways are trustworthy within their own boundaries; we mitigate their compromise with envelope encryption (KMS compromise still needs ciphertext + our app), signature verification (gateway), and origin-cert pinning (CF).
- Residual risk accepted at launch: a sufficiently privileged, MFA-holding, *colluding* pair of tenant operators can defeat SoD if the tenant disables two-person payroll — surfaced to the tenant as a security-posture warning. A fully-compromised running app process can decrypt data it is authorised to decrypt for the in-flight request (inherent to any system); blast radius is bounded per-tenant by DEKs and per-request by RLS/ctx.

---

## 12. Security Operations & Assurance

| Area | Practice |
|---|---|
| **SDLC** | Security review on every PR touching auth/RBAC/tenant-isolation/crypto/payment-file; threat-model update when boundaries change; the `security-review` skill run on relevant diffs. |
| **Testing** | CI isolation property tests (§5.6), negative IDOR suite, RLS smoke tests, dependency audit (`npm audit` cron, Sitepresso), SAST + secret scanning, DAST against staging. |
| **Pen-testing** | External pen-test pre-GA and annually; targeted test on payroll/payment-file flows; bug-bounty (private → public) post-GA. |
| **Monitoring** | Anomaly detection on bulk reads/exports, off-hours money-movement, cross-tenant query errors (which should be *zero*), failed-auth spikes; alerts to on-call. |
| **Access governance** | Least privilege for our staff; quarterly access reviews; JIT elevation for prod; all prod access via bastion + audited. |
| **Compliance roadmap** | SOC 2 Type II + ISO 27001 path; DPDP SDF readiness (DPIA register, India DPO); NZ Privacy Officer named; DPA + sub-processor list published. The at-rest encryption + audit posture is explicitly designed to shorten this path (noted as Sitepresso's intent in `crypto.js`). |
| **Business continuity** | Backups (§6.5) + restore drills; RTO/RPO targets per `02-system-architecture.md`; payroll-run idempotency so a recovery never double-pays. |

---

## 13. Decisions, Open Questions, Cross-Refs

### 13.1 Key security decisions (opinionated)

1. **Three-layer tenant isolation** (server-derived id → mandatory Prisma middleware → Postgres `FORCE` RLS). Opt-in `findOwned` is insufficient for payroll.
2. **Decouple data-at-rest encryption from `JWT_SECRET`** — KMS-backed per-tenant DEKs (envelope), enabling crypto-shredding. This is the single most important hardening over the Sitepresso fork.
3. **Step-up MFA + enforced Segregation of Duties** on all money-movement, killing the salary-diversion fraud class.
4. **No standing super-admin access to tenant payroll PII** — time-boxed, tenant-acknowledged, audited support grants + watermarked, write-limited impersonation.
5. **Append-only, hash-chained audit** as the system of record for every privileged/financial action.
6. **Residency zones** (IN / NZ-AU / ROW) pin data, keys, backups, and logs — satisfies CERT-In in-India logs and NZ IPP 12.
7. **Build to the full DPDP Rules 2025 now**, not to the 14 May 2027 enforcement date.

### 13.2 Open questions for the founder

- **O-1 (Residency hosting):** Confirm cloud + regions per zone (e.g., AWS `ap-south-1` for IN, an AU/NZ region for NZ). Affects KMS, backups, CERT-In log localisation, and IPP-12 posture. (Sitepresso runs single-region `ap-south-1` today.)
- **O-2 (KMS/HSM choice):** AWS KMS vs HashiCorp Vault vs cloud-HSM for the root key + per-tenant DEKs? Drives §6 implementation and SOC 2 scope.
- **O-3 (Aadhaar):** Do we ever store full Aadhaar, or always avoid it (masked/last-4 + reference)? Full Aadhaar storage triggers additional **UIDAI/Aadhaar Act** obligations beyond DPDP — recommend "avoid by default."
- **O-4 (SDF designation):** Plan for being designated (or a large tenant being designated) a **Significant Data Fiduciary** — appoint India-based DPO, annual DPIA + independent audit. Budget/timeline?
- **O-5 (Two-person payroll default):** Confirm the SoD default threshold (proposed: ON for > 25 employees) and whether tenants may disable it at all.
- **O-6 (Tenant-managed SSO/SAML/SCIM):** Which plans get SSO + SCIM provisioning to their own IdP? Affects auth surface and deprovisioning guarantees (T-A/T-F).
- **O-7 (Form 16 vs "Form 130"):** The 2025/26 renaming of the TDS certificate under the Income Tax Act 2025 is still being confirmed for the audit/retention naming (cross-ref `05-compliance-india.md`); does not change retention, only labels.
- **O-8 (Cyber-insurance + breach legal counsel):** Retain breach counsel and cyber-insurance before GA, given ₹250 crore exposure.

### 13.3 Cross-document dependencies

- `02-system-architecture.md` — network topology, residency-zone hosting, RTO/RPO, Redis/queue design that this doc secures.
- `03-data-model.md` — the `businessId`-keyed models RLS/middleware apply to; where `AuditEvent`, `ConsentRecord`, `Session` live; which columns are field-encrypted.
- `04-payroll-engine-design.md` — pay-run state machine that SoD/step-up/audit hook into; payment-file generation that §6.5/§11 T-H secure.
- `05-compliance-india.md` / `06-compliance-newzealand.md` — statutory record-retention windows that override erasure (§9.2); filing artefacts that need WORM + audit.
- `07-modules-core-hr.md`, `08-modules-time.md`, `09-modules-pay-adjacent.md` — the permission keys (§4.2) those modules consume.
- `15-super-admin-platform.md` — impersonation/support-grant UI (§4.7), feature flags, plan gating.
- `16-billing-and-plans.md` — which plans unlock MFA-mandatory, SSO/SCIM, residency choice, API access.
- `17-notifications.md` — breach/bank-change/security alerts delivery.
- `18-devops-and-deploy.md` — secrets management, IaC policy-as-code, CI security gates.

---

### Appendix A — Sitepresso security assets reused (real paths)

| Asset | Path |
|---|---|
| Operator/employee JWT + cookie scoping | `backend/src/core/utils/generateToken.js` |
| Auth + role + permission middleware | `backend/src/core/middleware/auth.middleware.js` |
| RBAC registry + effective-permission resolver | `backend/src/core/lib/rbac.js`, `backend/src/core/lib/roles.js` |
| Tenant-owned fetch helper (basis for §5.3) | `backend/src/core/lib/findOwned.js` |
| At-rest field encryption (AES-256-GCM) | `backend/src/core/lib/crypto.js` |
| Rate limit / honeypot / Turnstile | `backend/src/core/middleware/abuse.middleware.js` |
| Public API key auth (hashed + scoped) | `backend/src/core/middleware/apiKey.middleware.js` |
| Account deletion / soft-delete / anonymise | `backend/src/core/lib/accountDeletion.js` |
| Immutable lifecycle audit log (basis for §7) | `AccountAuditLog`, `PricingAuditLog` in `backend/prisma/schema.prisma` |
| Data export / portability | `backend/src/core/controllers/dataExport.controller.js` |
| Edge router / tenant resolution | `apps/router/cloudflare-worker.js` |
| CORS allowlist (`originCheck`), `trust proxy`, cookies | `backend/src/index.js` |
| nginx hardening + security headers + HSTS | `scripts/nginx-hardening.conf`, `/Users/kp/sitepresso/SECURITY.md` |
| Webhook signature verification posture | `PADDLE_SECURITY_REVIEW.md` |

### Appendix B — Verified compliance figures (June 2026)

| Figure | Value | Effective | Source |
|---|---|---|---|
| DPDP Rules 2025 published (Official Gazette) | 14 Nov 2025 | — | PIB/MeitY · Shardul Amarchand |
| DPBI / commencement provisions live | 14 Nov 2025 | live | Shardul Amarchand/EY |
| Consent-manager rules live | 14 Nov 2026 | future | Shardul Amarchand |
| DPDP substantive obligations (notice/consent/security/breach/retention/rights/SDF) | 14 May 2027 | future | Shardul Amarchand/Seclore |
| DPDP breach notice | Principals without delay; DPBI initial intimation without delay, detailed report ≤ 72 h (extendable on Board approval) | (live 14 May 2027) | DPDP Rule 7 |
| DPDP max penalty | ₹250 crore (failure of reasonable security safeguards, Schedule) | — | DPDP Act 2023 Schedule |
| DPDP Rule 8 large-platform erasure | 3 yrs from last interaction; 48 h pre-erasure notice (e-comm ≥2cr / gaming ≥50L / social ≥2cr users) | (live 14 May 2027) | DPDP Rule 8 |
| CERT-In incident report | ≤ 6 hours | live (since Jun 2022) | CERT-In Directions 28-04-2022 |
| CERT-In log retention | ≥ 180 days, stored in India | live | CERT-In Directions |
| NZ notifiable breach notice | "As soon as practicable" (statutory) — no fixed hours; OPC *guidance* expects ≤ 72 h | live | Privacy Act 2020 Part 6 |
| NZ failure-to-notify offence | Fine up to NZD $10,000 | live | Privacy Act 2020 |
| NZ cross-border control | IPP 12 (comparable safeguards) | live | Privacy Act 2020 |

> Payroll-rate figures (EPF/ESI/PT/TDS, PAYE/KiwiSaver/ACC/min-wage) are owned by `05-compliance-india.md` and `06-compliance-newzealand.md`; this doc references only the privacy/security-relevant retention and breach figures above.

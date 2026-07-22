# Feature 56 — Master Program Phase 3 wave 4: SSO (SAML 2.0 SP + OIDC RP) + SCIM 2.0 provisioning

Enterprise identity federation, zero of which existed before. Built on the
audit's reuse map: OIDC rides the existing social-auth seam + Redis code-hop,
SCIM bearer auth mirrors the ApiKey hash pattern, and provisioning/deactivation
reuse the atomic Employee+User+Customer flows.

## What shipped

### SSO — per-tenant, protocol-flexible
- `SsoConnection` (one per tenant): SAML **or** OIDC, `loginTarget`
  ESS/OPERATOR/BOTH, `jitProvision` toggle, encrypted secrets
  (clientSecretEnc / spPrivateKeyEnc via crypto.js AES-256-GCM).
- **OIDC RP** (openid-client v5): `/sso/:tenant/login` → IdP authorize
  (discovery cached 1h, PKCE+state+nonce in Redis) → `/sso/:tenant/callback`
  → id_token verify → identity resolution → one-time code → tenant-host
  cookie exchange.
- **SAML 2.0 SP** (@node-saml): `/sso/:tenant/metadata` (SP metadata XML),
  `/sso/:tenant/saml/login` (AuthnRequest, RelayState carries tenant+target),
  `/sso/:tenant/saml/acs` (signed-assertion validation: audience, signature,
  conditions). Tenant is a **path param** — solving the IdP-initiated
  no-Host-header problem.
- **Identity resolution**: assertion email → existing Employee in the tenant →
  ESS Customer (CustomerIdentity linkage, provider `sso-oidc`/`sso-saml`) or
  operator User (never JIT-minted); no match + jitProvision → provision via the
  shared bridge; no match + no JIT → clean error.
- **Return leg**: `/sso/complete?code=` (frontend) exchanges the single-use
  code for a session cookie via POST `/api/customer/sso/exchange` (ESS) or
  `/api/auth/sso/exchange` (operator). Router forwards `/sso/*` + `/scim/*` to
  the backend on every host but excludes `/sso/complete` (the frontend page).

### SCIM 2.0 — provisioning from the IdP
- `ScimToken` (hashed bearer, last4, per-tenant) — mint once, shown once.
- Bearer middleware (sha256 lookup, 120/min limit, SCIM error envelopes) →
  resolves businessId from the token.
- `/scim/v2`: ServiceProviderConfig / Schemas / ResourceTypes; Users GET
  (list + `userName`/`externalId`/`active eq` filter + startIndex/count), POST
  (create → Employee + User + Customer via the provisioning bridge, `scimManaged`,
  `externalId`), GET/PUT/PATCH (Operations add/replace/remove — active/name/
  emails/title; Azure quirks handled), DELETE (soft = deprovision).
- **Deactivation** (`active=false`) flips User + all matching Customers +
  Employee.isActive using the offboarding-settle revoke semantics WITHOUT
  creating a separation case, and (unlike settle) keeps businessRoleId so
  reactivation restores console access.
- **Global-email collision**: User.email is globally unique — a cross-tenant
  collision skips the operator User (Employee+Customer still created) with a
  warning in the SCIM response.

### Admin + login UI
- Settings → Single sign-on (`canManageSso`): connection form (protocol-
  specific, write-only secrets, SP endpoint copy-boxes, test button), SCIM
  token management (mint-once raw token, revoke, SCIM base URL).
- "Continue with <IdP>" button on both ESS and operator login pages (probes
  `/sso/:tenant/status`, fail-soft), operator org-ID SSO door mirroring the
  mobile pattern, return-leg pages on all three apps.

## Manual test (staging)
1. Settings → SSO: configure OIDC (issuer/clientId/secret) → Test → the
   discovery result shows; the ESS login page grows a "Continue with…" button.
2. Settings → SSO → SCIM: generate a token (copy it), point an IdP (or curl)
   at `/scim/v2/Users` with `Authorization: Bearer <token>` → POST creates an
   employee; PATCH active=false deactivates both identities.

## E2E evidence
`qa/e2e/e2e-p3-sso.js` on live staging: connection CRUD (OIDC secret
write-only, never echoed), discovery test, `/sso/demo/status`, OIDC login 302
with state+PKCE, SAML metadata XML, SCIM 401-without-bearer, discovery docs,
Users create → Employee materializes → `userName eq` filter → PATCH
active=false → deactivated → active=true → DELETE soft, full cleanup.
Units: scim 59 + attributes 32 + resolveIdentity 44 = 135.

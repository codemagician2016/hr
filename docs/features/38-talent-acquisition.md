# Feature 38 — Talent Acquisition (add-on vertical + candidate portal)

**Status:** in build (R0–R6). Owner-requested. Ships the recruitment/ATS as a
standalone, **entitlement-gated vertical** sold as a paid **add-on** to DriftHR,
plus a candidate-facing **careers portal** with accounts.

## Why
The recruitment/ATS backbone (Feature 12) already exists — Jobs, pipeline, Candidates,
Applications, screening + scoring, interview scorecards, merit list, Offers, and an
unauthenticated public careers apply. This feature (a) fixes/hardens the admin flow,
(b) lifts the whole talent flow into its **own monorepo vertical app** that *feels*
like the same product, (c) gates it as a **sellable add-on**, and (d) adds a real
**candidate portal** (accounts + rich profile + smart re-apply).

## Architecture
- **`apps/talent`** — a new monorepo vertical (shares `packages/*`, ships in the same
  tarball). Holds BOTH audiences:
  - **Admin ATS** at `app.drifthr.com/talent/*` (moved out of `apps/hr-admin/app/recruitment/*`).
    Seamless via the shared `packages/ui` shell + shared operator session cookie; the
    hr-admin "Talent Acquisition" nav item links to `/talent`.
  - **Candidate careers** at `{tenant}.drifthr.com/careers/*`, per-tenant, passwordless.
- **Entitlement gate** — the whole vertical (nav + `/talent` + `/careers` +
  `/api/hr/recruitment` + `/api/public/careers`) is gated by the
  `talent_acquisition` boolean entitlement. Reuses `core/lib/entitlements.js`
  (`assertBooleanFeature` → 402/403) + a new `requireEntitlement()` Express
  middleware. Sold via the existing multi-product billing rails
  (`PaddleBillingSubscription.productKind = 'TALENT'`).
- **Candidate identity** — per-tenant, passwordless **magic-link** accounts. Guest
  apply is allowed; on repeat apply the email is deduped and the candidate is offered
  a magic link to continue with their saved profile ("continue & apply", swap resume
  per job). New `authenticateCandidate`/`requireCandidate` mirroring the ESS
  `Customer` auth.

RBAC (`canManageHiring` — WHO) stays orthogonal to the entitlement (WHETHER the plan
includes it). The entitlement sits after `protect` and before the RBAC gates.

## Phases
- **R0** — Fix "New Job Post": gate the New-job button on `canManageHiring`, friendly
  403/409/402 errors (server was always the boundary; the button showed regardless).
- **R1** — Add-on entitlement foundation: `requireEntitlement`, OR-in an active
  `TALENT` sub in `booleanEntitlement`, `productKind:'TALENT'` + add-on price +
  checkout + webhook activation, BillingTab "Add-ons", nav entitlement wiring, gate
  recruitment + careers routes.
- **R2** — Extract `apps/talent`: move recruitment UI in, shared shell, router
  `/talent` wiring + nav link, PM2/ecosystem/tarball. No data migration (backend stays).
- **R3** — Candidate accounts: passwordless magic-link auth, careers app section,
  per-tenant theming.
- **R4** — Candidate profile: `CandidateEducation` (mirrors `EmployeeEducation`),
  `CandidateExperience` (net-new), `CandidateSkill`, resume→S3; self-service UI.
- **R5** — Smart apply: job board/detail + guest+returning flow (email dedupe →
  magic link → continue & apply, resume swap); applications land as `CAREER_PORTAL`.
- **R6** — HR side + candidate status timeline; optional F36 interview-invite
  template fix.

## Data model delta
- Reuse `Job`/`Candidate`/`Application` (+ `ApplicationSource.CAREER_PORTAL`,
  per-application `resumeUrl` snapshot).
- Candidate auth: passwordless (stateless signed token emailed → session cookie);
  candidate profile children `CandidateEducation` / `CandidateExperience` /
  `CandidateSkill`.
- Billing: `PaddleBillingSubscription.productKind += 'TALENT'`; entitlement key
  `talent_acquisition`.

## Deploy note
The DriftHR DBs (staging + prod) are **db-push-managed** — `prisma migrate deploy`
fails on ledger drift, so schema changes ship via `prisma db push` (or direct psql of
the migration SQL). The deploy script must be adjusted accordingly.

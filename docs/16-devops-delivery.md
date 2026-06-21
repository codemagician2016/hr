# 16 — DevOps & Delivery

**Product:** Multi-tenant, white-label HRMS & Payroll SaaS ("the platform")
**Author:** Senior Platform / DevOps Engineer
**Status:** Production-grade design (NOT an MVP). Forks the live Sitepresso platform at `/Users/kp/sitepresso`.
**Launch markets:** India (IN, `ap-south-1` Mumbai) and New Zealand (NZ, `ap-southeast-2` Sydney). Currencies INR + NZD. Tax year Apr–Mar in both.
**Last reviewed against 2026 compliance facts:** 2026-06-22.

> Cross-references (sibling docs, same `/Users/kp/docs` folder):
> - `02-system-architecture.md` — service topology, surfaces (hr.com / admin / app / tenant), tenant resolution.
> - `03-data-model.md` — Prisma schema; migration surface area.
> - `04-payroll-engine-design.md` — payroll run state machine; what a deploy must never interrupt.
> - `05-compliance-india.md` / `06-compliance-newzealand.md` — versioned compliance rule tables (deploy as **data**, not code).
> - `08-modules-time.md`, `09-modules-pay-adjacent.md` — scheduled jobs (PAYE/PF/ESI filing windows) the scheduler must run.
> - `12-admin-consoles.md` — Super-Admin operations that depend on this pipeline (impersonate, feature-flags, compliance-table publish).
> - `14-security-and-audit.md` (if present) — secrets handling, audit obligations this doc enforces.

---

## 0. Executive summary & opinionated stance

Sitepresso today ships via a **git-as-ledger + manual tarball→S3→SSM→PM2** model on **2× shared EC2 Graviton boxes** behind a **Cloudflare Tunnel**, with **Prisma `migrate deploy`**, a **PM2 `ecosystem.config.js` fleet manifest**, a **hard health-gate smoke test**, and a **cron watchdog**. This is documented as the canonical law in `/Users/kp/sitepresso/DEPLOY_POLICY.md` and implemented in `/Users/kp/sitepresso/scripts/ship.sh` + `/Users/kp/sitepresso/scripts/deploy.sh`. It is battle-tested and cheap, and it correctly solved real incidents (silent sub-app death → tenant 502s; Vercel build-minute bleed; half-applied migrations).

**My recommendation for the HRMS platform: keep the operational *philosophy* (git = rollback ledger, immutable releases, fleet manifest, hard health-gate, watchdog) but change the *substrate* in three deliberate ways**, because payroll/HR has different risk than a website builder:

1. **Containerize the release artifact** (OCI images in ECR), not raw tarballs. Payroll math must be byte-identical between staging and prod; "extract a tar over a running repo and `npm ci` on the box" is non-deterministic (host Node version, transient registry state, native module rebuilds). Sitepresso *already started* this migration — `/Users/kp/sitepresso/scripts/setup-ecr.sh` provisions 13 ECR repos with a keep-last-10 lifecycle policy — so we inherit, not invent.
2. **Add a real CI layer** (GitHub Actions) that runs the quality gates *before* a human can ship. Sitepresso deliberately disabled CI-on-push (`/Users/kp/sitepresso/.github/workflows/ci.yml` is `workflow_dispatch`-only) to stop Vercel/Action bleed. We re-enable CI as a **gate that produces the artifact** but still **never auto-deploys**. Deploy stays a deliberate human act.
3. **Split the two countries onto region-local data planes** (`ap-south-1` for IN tenants, `ap-southeast-2` for NZ tenants) for data-residency + latency, with a single shared global control plane (Super-Admin, billing, marketing). This is a payroll-grade requirement, not an optimization.

Everything below is concrete enough to implement on day one. Exact figures carry effective dates. Compliance *rates* (KiwiSaver 3.5%, ACC 1.75%, min wage $23.95, IN Basic≥50%) are deployed as **versioned data rows**, never as a code release — see §11.

---

## 1. Branch strategy & promotion discipline

We inherit Sitepresso's **three-branch, one-box-per-branch, branch==deployed invariant** (`DEPLOY_POLICY.md` "RULE #1"), but make the merge direction explicit and CI-enforced.

| Branch | Meaning | Target | Who pushes | Auto-deploy? |
|---|---|---|---|---|
| `development` | daily work branch; **the only branch anyone commits to** | local dev + ephemeral preview env | engineers (direct + PR merges) | No |
| `staging` | staging-live | `staging` data plane (`staging.hr.com` + `staging-api`) | promotion only (`merge --ff-only development`) | No (manual `ship staging`) |
| `main` | prod-live | prod data plane (`hr.com` / `app.hr.com` / `admin.hr.com`) | promotion only (`merge --ff-only staging`) | No (manual `ship prod`) |

**Hard rules (carried verbatim from Sitepresso, because they prevent the exact incident class we've already paid for):**

- **Commit only to `development`.** Promote with fast-forward only:
  `git checkout staging && git merge --ff-only development`, then `ship staging`;
  `git checkout main && git merge --ff-only staging`, then `ship prod`.
  A failing `--ff-only` means someone hand-committed to a deploy branch — **fix that**, never resolve with a parallel merge. (Source: `/Users/kp/sitepresso/scripts/ship.sh` header.)
- **The golden invariant:** a branch must always equal what is deployed to its box. Sequence is **merge → push → deploy, together**. Never push `staging`/`main` with code you haven't deployed; never deploy code not committed on that branch.
- **Git deploys nothing.** No GitHub Action fires on `push`/`pull_request` to deploy. Pushing any branch is free and safe. (We *do* add CI that runs on PR — see §3 — but it builds/tests, it never ships.)
- **Deploy permission is per-request.** Default stopping point for any unit of work is: edit → run checks → commit on `development` → report. Remote push / live deploy happens only when the **current** instruction explicitly says so. (`DEPLOY_POLICY.md` "RULE #2".)

### 1.1 Launch-phase constraint: "push to `development` only until domains provided"

Until the production domains (`hr.com`, `app.hr.com`, `admin.hr.com`, and the white-label apex/CNAME story) are registered, DNS-delegated to Cloudflare, and bound, **`staging` and `main` do not exist as live targets** — there is nowhere to ship. During this phase:

- All work lands on `development`. `staging`/`main` branches may exist in git for history but are **not promoted** and **not shipped**.
- "Staging" is the **ephemeral preview environment** (§2.4) spun from a `development` SHA, reachable on a throwaway `*.preview.internal` hostname via the existing Cloudflare Tunnel — no public domain required.
- The instant the founder provides domains, we run the one-time bootstrap in §10.1 and promotion opens.

### 1.2 Feature flags decouple merge from release

HR/payroll features (e.g. NZ Holidays Act engine v2, a new IN PT slab table) merge to `development` behind a **plan/feature flag** owned by Super-Admin (`packages/admin-core` feature-flag store, `02-system-architecture.md`). This lets us ship code dark and turn it on per-tenant/per-plan/per-country without a code deploy — essential because we cannot hold a payroll engine rewrite in a long-lived branch across a tax-year boundary.

---

## 2. Environments

### 2.1 Environment matrix

| Env | Branch | Purpose | Data | External calls | Region(s) |
|---|---|---|---|---|---|
| **local** | `development` | dev laptops; `scripts/dev-local.js` (inherited) | seeded/synthetic | all gateways in **test/sandbox** mode | n/a |
| **preview** (ephemeral) | any `development` SHA | PR review, demos pre-domain | per-PR throwaway DB (template-cloned) | sandbox | `ap-south-1` |
| **staging** | `staging` | pre-prod rehearsal; full compliance run-throughs | **anonymized** prod-shaped data | gateways in test; IRD/EPFO/ESIC connectors in **sandbox** | `ap-south-1` + `ap-southeast-2` |
| **production** | `main` | live tenants | real PII/payroll | **live** Razorpay/Stripe/Paddle; live filing connectors | `ap-south-1` (IN) + `ap-southeast-2` (NZ) |

**Non-negotiable:** staging must be able to exercise **every** compliance code path with sandbox connectors before any payroll figure reaches a real employee. The NZ Holidays Act calculation (relevant-daily-pay vs average-daily-pay, alt/lieu days) is the flagship correctness feature (`06-compliance-newzealand.md`); staging runs the **golden-case regression suite** (§3.3) on every promotion.

### 2.2 Service topology per environment

Inherited fleet shape from `/Users/kp/sitepresso/ecosystem.config.js` (PM2 cluster API + clustered Next apps + scheduler + router). HRMS fleet, per data-plane box:

| Process | From Sitepresso | HRMS role | Mode |
|---|---|---|---|
| `hr-backend` | `sitepresso-backend` (cluster) | Express + Prisma API; tenant-isolated by `businessId` | cluster (N=vCPU) |
| `hr-scheduler` | `sitepresso-scheduler` / `scheduler-worker.js` | payroll runs, PAYE/PF/ESI filing windows, payday-filing, renewals | fork (single, leader-locked) |
| `sp-router` | `apps/router` (`cloudflare-worker.js` + `index.js`) | host→surface routing, custom-domain resolution | cluster |
| `hr-admin` | `apps/platform` (`packages/admin-core`) | Super-Admin (`admin.hr.com`) | clustered Next |
| `hr-app` | new (`apps/hr` admin) | Tenant Admin / HR console (`app.hr.com`) | clustered Next |
| `hr-ess` | new (`apps/hr` employee) | white-label ESS (`tenant.com`) | clustered Next |
| `hr-marketing` | new | marketing + onboarding wizard (`hr.com`) | clustered Next |

The PM2 manifest stays the **single source of truth** for "what must run on a box" — this is exactly the lesson `ecosystem.config.js` encodes (sub-apps silently went missing → tenant 502s). `max_memory_restart` caps (500M Next / 900M clustered / cluster backend) are inherited to protect the shared box; the persistent 4 GiB swapfile + `vm.swappiness=10` safety net is inherited from the box build (`DEPLOY_POLICY.md`).

### 2.3 Critical scheduler caveat (HR-specific)

The scheduler must be **singleton with a distributed lock** (Redis `SETNX` lease, inherited Redis). A payroll run or a PAYE payday-filing submission must execute **exactly once** even though the API runs in cluster mode and even across a rolling deploy. We deploy the scheduler as `instances: 1` (as Sitepresso does) **and** wrap each scheduled job in a Redis lease keyed by `{tenantId}:{jobType}:{period}` so a stale process started during a deploy window cannot double-file. See §6.4.

### 2.4 Ephemeral preview environments

Inherit the template-DB pattern. On PR open, CI (§3) builds the image, runs migrations against a **cloned template database** (`CREATE DATABASE preview_pr123 TEMPLATE hr_seed`), boots the stack on a free port range, and registers a Cloudflare Tunnel ingress `pr123.preview.internal → 127.0.0.1:<port>`. Torn down on PR close (TTL 7 days hard cap via cron). No public domain, so this works **today, pre-launch**.

---

## 3. CI/CD pipeline & quality gates

**Design intent:** CI is a **gate + artifact factory**, not a deployer. It runs on PR and on push to `development`/`staging`/`main`; it builds the immutable image and pushes to ECR; **it never calls `ship`**. Deploy remains the deliberate human `scripts/ship.sh` act (§5). This reconciles Sitepresso's "no Action fires" law (which was about *deploys* and *Vercel build bleed*) with the reality that payroll code must not reach prod without passing automated gates.

### 3.1 Pipeline stages (GitHub Actions, `ap-south-1` OIDC role, no long-lived AWS keys)

```
on: [pull_request, push: development/staging/main]

job lint-and-typecheck      # eslint + tsc --noEmit across turbo graph (affected only)
job unit-tests              # backend pure unit (Zod, pricing, payroll math) — no DB/net
job compliance-golden       # §3.3 golden-case payroll regression (IN + NZ) — the flagship gate
job migration-check         # §3.2 shadow-DB migrate + drift + destructive-change scan
job build-images            # turbo build → docker buildx → push :sha to ECR (on push only)
job sbom-and-scan           # Trivy image + npm audit; SBOM (CycloneDX) attached to release
job e2e-smoke               # Playwright against a booted preview stack (login, run payroll, payslip)
```

Inherited concrete checks (already exist, keep them): `node --check` syntax sweep, `scripts/check-admin-architecture.js`, `check-layout-presets.js`, `check-theme-copy.js`, and `backend npm test` (pure unit) — all from `/Users/kp/sitepresso/.github/workflows/ci.yml`.

### 3.2 Migration gate (zero-tolerance)

`migration-check` runs against an empty **shadow DB**:
1. `prisma migrate deploy` from scratch — every migration must apply cleanly from zero.
2. `prisma migrate diff` between `schema.prisma` and the migration history — **drift fails the build** (catches a hand-edited DB or a forgotten migration).
3. **Destructive-change scanner** (regex + AST over the new migration SQL): any `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN ... TYPE`, `DROP NOT NULL`→`SET NOT NULL`, or non-concurrent index on a large table **fails CI unless** the migration filename carries an `expand_` / `contract_` prefix and a linked design note (§6 expand/contract protocol). Payroll tables (`PayrollRun`, `PayslipLine`, `LeaveLedger`) are on a **protected list** — destructive changes to them require a second reviewer label.

### 3.3 Compliance golden-case regression (the flagship gate)

A frozen fixture corpus of **known-correct payroll outcomes**, version-pinned to compliance effective dates. Each case is `{input roster + config + period} → expected {gross, deductions line-by-line, net, employer cost}`. CI recomputes and asserts **exact** equality (money compared in minor units, never floats).

- **NZ corpus** (effective 2026-04-01): KiwiSaver **3.5%** employee + **3.5%** employer default; **16–17 y/o now employer-contribution-eligible**; ACC earners' levy **1.75%** on first **$156,641**; adult minimum wage **$23.95/hr**; ESCT bands; student-loan deductions; and the **Holidays Act 2003** cases — annual leave in **weeks**, relevant-daily-pay vs average-daily-pay, alternative/lieu days, sick/bereavement/public holidays. ([paymasters.co.nz](https://paymasters.co.nz/blog/blog-april-2026-nz-payroll-changes-minimum-wage-kiwisaver-acc/), [markhams.co.nz](https://www.markhams.co.nz/news/1-april-2026-payroll-changes/))
- **IN corpus** (Labour Codes live **2025-11-21**): uniform "wages" definition → **Basic+DA ≥ 50% of total remuneration** (cascades into PF & gratuity); EPF 12%+12% (EPS 8.33% capped at ₹15,000 wage, EPF 3.67%, EDLI, admin charges, PF mandatory at 20+ employees); ESI 0.75%+3.25% on gross ≤ ₹21,000 (mandatory at 10); state-specific Professional Tax capped ₹2,500/yr; gratuity = 15/26 × last-drawn × years; new tax regime default with §87A nil tax to ~₹12L taxable and ₹75k standard deduction. ([labour.gov.in FAQ 16.03.2026](https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf), [payroll.org](https://payroll.org/news-resources/news/news-detail/2025/12/17/india-s-new-labour-codes-are-in-force-payroll-teams-must-act))

This gate runs in CI **and** as the staging promotion sign-off. A red golden case blocks `ship staging`/`ship prod` by policy.

### 3.4 Quality-gate summary table

| Gate | Stage | Blocks | Rationale |
|---|---|---|---|
| ESLint + `tsc --noEmit` | PR | merge | type safety across monorepo |
| Unit (payroll math, Zod, pricing) | PR | merge | inherited from `backend npm test` |
| Compliance golden cases | PR + promotion | merge + ship | provable payroll correctness |
| Migration shadow-apply + drift + destructive scan | PR | merge | zero-downtime + data-loss prevention |
| Image build + push :sha | push | (artifact) | immutable release |
| Trivy + npm audit + SBOM | push | release on CRITICAL | supply-chain (inherit `weekly-npm-audit.sh`) |
| Playwright e2e smoke | push | promotion | end-to-end (login→run payroll→payslip) |
| Post-deploy `smoke.sh` health gate | deploy | **rolls back** | inherited hard gate (§5.3) |

---

## 4. Configuration & secrets

### 4.1 Layered config model (inherited + hardened)

Sitepresso reads **per-box `.env` files** per app (`.env` / `.env.local` / `.env.production`, gitignored), with only `sp-router` having env injected via the PM2 manifest (`PLATFORM_DOMAIN` differs per box). We keep this layering but **move secrets out of box-resident `.env` files into AWS SSM Parameter Store (SecureString, KMS-encrypted)** fetched at boot — because payroll holds bank/PII/tax credentials and an on-box plaintext `.env` is an unacceptable blast radius.

| Layer | Holds | Source | Rotation |
|---|---|---|---|
| Code-shipped defaults | non-secret toggles, ports, public URLs | repo (`packages/config/ports.js` pattern) | with release |
| Env (`.env`, NEXT_PUBLIC_*) | per-box non-secret runtime (PLATFORM_DOMAIN, region) | PM2 manifest / box `.env` | on deploy |
| **SSM SecureString** | DB URL, JWT secret, gateway keys, IRD/EPFO creds, Cloudflare token, SMTP | `aws ssm get-parameters-by-path /hr/<env>/` at boot | scheduled + on-incident |
| Per-tenant secrets | tenant gateway sub-account refs, custom-domain origin certs | DB (encrypted column, app-level envelope) | per-tenant |

Path convention: `/hr/{prod|staging}/{region}/{service}/{KEY}`. The backend's boot sequence loads SSM → process env before `dotenv` defaults, so a missing secret fails fast (advisory `verify-config.js` already exists — `/Users/kp/sitepresso/scripts/deploy.sh` runs it; we promote the **payroll/gateway** subset to **blocking** for HR because a wrong key here mis-files real money).

### 4.2 `verify-config` becomes partly blocking for HR

Sitepresso's `verify-config.js` is intentionally **advisory** (a billing/config issue must not wedge a *code* deploy — that lesson is in `deploy.sh` §3b). We keep it advisory for marketing/branding config, but introduce a **blocking `verify-payroll-config`** check covering: live-vs-test gateway key parity with `ENV_LABEL`, presence of country filing credentials when a tenant in that country is active, and KMS key reachability. A wrong-mode gateway key in prod is a hard stop.

### 4.3 Secret rotation runbook

- **Gateway/API keys:** dual-write window. Add new key to SSM as `KEY_NEXT`, deploy, flip `KEY` ← `KEY_NEXT` on next deploy, revoke old. (This is the explicit pattern that bit Sitepresso — a revoked Paddle key — and why `verify-config` exists.)
- **JWT signing key:** support 2 active KIDs; rotate by adding new KID to the verify set, then switch the sign KID, then retire old after max token TTL.
- **DB password:** RDS managed rotation (Secrets Manager) → mirrored to SSM via a rotation Lambda; backend reconnects on auth error with backoff.

---

## 5. Deployment

### 5.1 Recommendation: containers over raw tarballs (with migration path)

**Inherited (Sitepresso today):** `scripts/ship.sh <staging|prod>` → `git archive` the committed branch tip → `aws s3 cp` to `s3://sp-deploy-<acct>` → SSM the right instance ID → backup, pull tarball, extract over `/home/ubuntu/sitepresso`, run `scripts/deploy.sh` (npm ci → `prisma migrate deploy` → turbo build → `pm2 startOrReload` → seeds → **`smoke.sh` hard gate**). Rollback = re-ship a previous commit (and the deploy keeps the last 5 `sp-prebackup-*.tgz` archives on the box).

**Why change for HRMS:** the tarball model rebuilds on the box (`npm ci`, native modules, `turbo build`), so the artifact that runs in prod is **not** the artifact tested in CI. For payroll that's a correctness hazard. **Move to immutable OCI images** built once in CI, scanned, and promoted by digest:

```
ship-hr <staging|prod> <image-sha>:
  1. resolve digest  ECR: hr-backend@sha256:… (built+scanned in CI, never rebuilt)
  2. SSM the data-plane box(es) for that env:
       - docker pull <digest>
       - run migrations as a one-shot container (§6) — gated, idempotent
       - docker compose up -d --no-build   (compose file is the fleet manifest, replacing ecosystem.config.js)
       - run scripts/smoke.sh <env>  → HARD GATE; on fail, compose roll back to previous digest
  3. write .build-commit + .build-digest; pm2/compose save
```

We **reuse**: the S3 deploy bucket + SSM transport, the backup-before-deploy + keep-last-5 discipline, the `ENV_LABEL` staging/prod switch, the half-applied-migration auto-resolve, the **hard smoke gate**, and the watchdog. We **replace**: on-box `npm ci`/`turbo build` (now done once in CI) and `pm2 startOrReload` of source (now `docker compose` of a digest). ECR + lifecycle policy already scaffolded in `/Users/kp/sitepresso/scripts/setup-ecr.sh`.

> **Pragmatic interim:** if container migration slips, the inherited tarball flow is acceptable for staging and for the pre-domain phase. The **non-negotiable** is that **prod** runs an artifact whose payroll engine was the one CI's golden-case gate approved — which immutable images guarantee and on-box rebuilds do not.

### 5.2 Why not Kubernetes / serverless (opinionated)

- **Not K8s** at launch: two countries × {staging,prod} = 4 small data planes plus one control plane. EC2 + `docker compose` + PM2-style supervision + a watchdog covers this at a fraction of the operational tax. Revisit K8s/ECS-Fargate when we exceed ~6 boxes per region or need fast horizontal autoscaling for payroll-run bursts.
- **Not Lambda for the API:** Prisma cold starts, long payroll-run transactions, and the singleton scheduler are anti-patterns for FaaS. The **router** stays a Cloudflare Worker (it already is — `apps/router/cloudflare-worker.js`).

### 5.3 The hard health gate (inherited, mandatory)

`scripts/smoke.sh <env>` probes every required local port; a **refused connection (curl 000) fails the deploy** — any HTTP status means "up". Inherited from `/Users/kp/sitepresso/scripts/smoke.sh` and wired as the final step of `deploy.sh`. For HRMS we **extend** the gate with a **synthetic payroll dry-run**: after boot, hit `POST /internal/health/payroll-dryrun` which runs one golden NZ case + one IN case through the live engine against an in-memory fixture and asserts the expected net — so a config/rate regression is caught **before** traffic, not on the first real run.

### 5.4 Deployment sequencing across two data planes

Promote **staging (both regions) → prod IN → prod NZ** (or vice-versa), never both prod regions simultaneously, so a bad release can't take down payroll on both continents in the same minute. Each region's `ship` is independent (separate instance IDs, separate SSM calls — exactly how `ship.sh` already keys `IID` per env).

---

## 6. Database migrations & zero-downtime

### 6.1 Engine

`prisma migrate deploy` (inherited; `deploy.sh` runs it, auto-resolving a half-applied migration by marking unfinished rows `rolled_back_at` before deploying). HRMS keeps this and runs migrations as a **one-shot container/SSM step that must succeed before the new image takes traffic**.

### 6.2 Expand / contract (mandatory protocol)

Every schema change that could break a running old version is split across releases so old and new code coexist during the rollout:

| Phase | Action | Old code | New code |
|---|---|---|---|
| **Expand** | add nullable column / new table / backfill-safe index (CONCURRENTLY) | ignores it | dual-writes / reads new optionally |
| **Migrate** | backfill in batches (background job, throttled, restartable) | unaffected | reads new, falls back to old |
| **Contract** | drop old column / tighten NOT NULL / drop fallback | gone | reads new only |

Migration filenames encode the phase (`expand_…`, `contract_…`) — this is what the CI destructive-change scanner (§3.2) keys off. **Never** ship expand+contract in one release. Payroll-financial tables (`PayrollRun`, `PayslipLine`, `LeaveLedger`, `JournalEntry`) are append-only by preference; corrections are new rows, not in-place edits — so contract phases on them are rare and review-gated.

### 6.3 Zero-downtime rules

- All new columns nullable or with DB default; **no** blocking `ALTER` on hot tables.
- Indexes created `CONCURRENTLY` (Postgres) — never inside a transaction that locks writes.
- Long backfills are **idempotent, batched, resumable**, run by the scheduler off-peak per region, and **stop before the payroll-run window** (a backfill must never contend with a live run).
- A migration must be **forward-safe with the previous app version** running, because cluster reload is rolling.

### 6.4 Deploy ↔ payroll-run safety interlock (HR-specific, critical)

A deploy must **never** land mid-payroll-run. The payroll run is a state machine (`04-payroll-engine-design.md`): `DRAFT → CALCULATING → REVIEW → APPROVED → PAYING → FILED`. We add a **deploy interlock**:

1. `ship-hr` checks a Redis flag `payroll:active:{region}` (set by the engine while any run is in `CALCULATING`/`PAYING`).
2. If active, deploy **waits** (configurable, default 20 min) or aborts with a loud message; it **does not** force through.
3. The scheduler holds a per-job Redis lease (§2.3); a process started during reload cannot grab a lease already held → no double-file of PF/ESI/PAYE.
4. Migrations that touch payroll tables additionally require **no run in any non-terminal state** for that region.

---

## 7. Observability

### 7.1 Inherited baseline

**Sentry is already wired** (`/Users/kp/sitepresso/backend/src/core/lib/sentry.js`, initialized in `scheduler-worker.js` with `unhandledRejection`/`uncaughtException` → `Sentry.captureException`). PM2 captures stdout/stderr per process; `logrotate` config exists (`scripts/logrotate-sitepresso.conf`); the **watchdog** (`scripts/watchdog.sh`, cron `*/3`) self-heals refused ports. We keep all of it and layer a real observability stack on top.

### 7.2 The three pillars

| Pillar | Tool (recommended) | What we instrument |
|---|---|---|
| **Logs** | structured JSON → CloudWatch Logs (or Loki) per region; PII-redacting serializer | request logs (with `tenantId`, `requestId`, `userId` — never raw bank/PII), payroll-run audit lines, filing submissions |
| **Metrics** | OpenTelemetry → Prometheus/CloudWatch | RED (rate/errors/duration) per surface; payroll-run duration/success; queue depth; DB pool saturation; KiwiSaver/PF calc counts |
| **Traces** | OpenTelemetry distributed tracing | router→backend→DB→gateway; one trace per payroll run; one per payday-filing call |
| **Errors** | Sentry (inherited) | exceptions with `tenantId` tag, release = image digest |

### 7.3 Payroll-grade SLOs & alerts

| Signal | SLO / threshold | Alert action |
|---|---|---|
| API 5xx rate (per surface) | < 0.1% over 5 min | page on-call |
| Payroll run failure | **any** failed run | page immediately + freeze that tenant's auto-file |
| Payday filing to IRD failure (NZ, within 2 working days) | any failed/late submission | page + escalate; surface in Super-Admin |
| PF/ESIC deposit job (IN, by 15th) / TDS (by 7th) miss | job not `SUCCESS` by SLA-1day | page + ticket |
| Custom-domain SSL not active < 24h after request | any | ops ticket (§9) |
| Scheduler heartbeat | missed 2 intervals | page (singleton is down) |
| DB replica lag | > 30s | warn; > 120s page |
| Box memory / swap pressure | swap-in spike | warn (the box OOM history is real — `ecosystem.config.js`) |

Every payroll-financial event also writes to the **immutable audit log** (separate concern, `14-security-and-audit.md`) — observability is for ops, the audit log is for compliance/legal; do not conflate.

### 7.4 Dashboards & on-call

Per-region Grafana/CloudWatch dashboards: fleet health (mirrors `smoke.sh` service list), payroll-run pipeline, filing-deadline countdown board (IN: TDS 7th, PF/ESIC 15th, Form 24Q quarterly Q1 31-Jul / Q2 31-Oct / Q3 31-Jan / Q4 31-May; NZ: payday filing within 2 working days). On-call rotation with the runbook links from §10.

---

## 8. Custom-domain provisioning operations (white-label)

This is a **first-class operational surface** for HRMS because the employee portal is white-labeled at `tenant.com`. We inherit Sitepresso's **Cloudflare-for-SaaS custom-hostname** machinery wholesale.

### 8.1 Inherited components

- `apps/router/cloudflare-worker.js` + `wrangler.toml` — host-aware routing (one Worker, both zones), already maps tenant hostnames → surfaces.
- `/Users/kp/sitepresso/backend/src/core/lib/cloudflareDns.js` — Cloudflare API client (zone lookup, DNS write), token from `CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN` / `CLOUDFLARE_API_TOKEN`.
- `/Users/kp/sitepresso/.github/workflows/cloudflare-custom-hostname.yml` — `workflow_dispatch` op that ensures the **fallback origin** (`custom.<zone>`) and creates/refreshes a **custom hostname** (per-tenant SSL via Cloudflare for SaaS).
- `backend/src/domains/*` — domain admin/public controllers, routing, renewal cron (we **delete** the resale/registrar pieces per the build brief, **keep** the custom-hostname binding).

### 8.2 Provisioning state machine (per tenant custom domain)

```
REQUESTED
  → DNS_PENDING        tenant adds CNAME tenant.com → cname.hr.com (or hr-provided target)
  → HOSTNAME_CREATED   POST Cloudflare custom_hostnames (fallback origin = custom.<zone>)
  → SSL_PENDING        Cloudflare issues cert (HTTP/TXT validation)
  → SSL_ACTIVE         cert active; Worker route live
  → VERIFIED           synthetic GET https://tenant.com/health == 200 from our prober
  → LIVE
[error branches]
  → DNS_MISCONFIGURED  (CNAME missing/wrong) — show tenant exact record, retry
  → SSL_FAILED         (validation timeout) — auto-retry 3×, then ops ticket
  → REVOKED            (tenant unbinds / churns) — delete custom hostname, route falls back
```

State stored on the tenant's domain row; transitions emit audit events and Super-Admin/Tenant-Admin notifications (inherited notifications system). The renewal/health cron (inherited `renewalCron.js` pattern) re-checks `SSL_ACTIVE` hostnames and alerts on cert-not-renewing.

### 8.3 Operational rules

- **Validation by data, not free-text:** tenant supplies an apex/subdomain; we compute the exact CNAME target and present it; we **never** let them "design" DNS — consistent with the "configure, not build" core principle.
- **Idempotent ops:** the hostname workflow is safe to re-run (it "creates or refreshes"); ops can re-trigger from Super-Admin without fear of duplicate certs.
- **Fallback origin** ensures an unmatched/just-bound hostname still terminates at our origin rather than erroring — inherited from the workflow.
- **Throughput:** custom-hostname creation is async (cert issuance minutes); SLO is **SSL_ACTIVE < 24h**, alert if breached (§7.3). Bulk onboarding (an enterprise tenant binding many subdomains) is queued, rate-limited under Cloudflare API limits.

---

## 9. Backups & disaster recovery

### 9.1 What we protect (tiered)

| Data class | Examples | RPO | RTO | Mechanism |
|---|---|---|---|---|
| **Tier 0 — financial/payroll** | `PayrollRun`, `PayslipLine`, `JournalEntry`, filing receipts | **≤ 5 min** | **≤ 1 h** | RDS PITR + cross-AZ standby + cross-region snapshot copy |
| **Tier 1 — operational HR/PII** | employees, leave ledger, attendance, config | ≤ 15 min | ≤ 2 h | RDS PITR |
| **Tier 2 — documents** | payslip PDFs, Form 16/24Q exports, IR exports | ≤ 1 h | ≤ 4 h | S3 versioned + cross-region replication + Object Lock |
| **Tier 3 — derived/cache** | Redis sessions, rendered artifacts | best-effort | n/a | rebuildable |

### 9.2 Mechanisms

- **Postgres:** managed **RDS** (per region) with **Multi-AZ**, **automated daily snapshots + PITR (transaction logs)**, and **cross-region snapshot copy** (IN→a second AWS region, NZ→another) for region-loss DR. Retention: 35 days PITR + monthly snapshot kept 7 years (payroll record-keeping; IN mandates digital wage/payslip registers — retention must exceed statutory minimums).
- **S3 documents:** versioning + cross-region replication + **Object Lock (compliance mode)** on tax artifacts (Form 16/24Q, IR filings, payslips) so they cannot be deleted/altered within the retention window.
- **Deploy artifacts:** ECR images retained (lifecycle keep-last-10 per repo, inherited from `setup-ecr.sh`) → any prior release is instantly redeployable. Plus on-box `sp-prebackup-*.tgz` (keep-last-5, inherited) for the legacy/interim flow.
- **Config:** SSM parameters are in version-controlled IaC (Terraform) + exported encrypted nightly.

### 9.3 DR drills (mandatory cadence)

- **Quarterly restore test:** restore Tier-0 RDS snapshot to an isolated VPC, run the **golden-case payroll regression** (§3.3) against the restored DB — proves the backup is not just present but *correct* and *computable*.
- **Annual region-failover game day:** promote cross-region replica, repoint Cloudflare/router, verify ESS + a payroll run end-to-end.
- **Backup monitoring:** alert if any scheduled snapshot/replication job fails (a silent backup failure is the classic DR killer).

### 9.4 Data residency in DR

IN tenant data must restore **within India**; NZ tenant data within an approved region. Cross-region copies for DR stay within the legally permissible set (e.g. IN→IN-second-AZ-region story, NZ→AU). This constrains where DR snapshots may land and is a hard architectural rule, not a preference (`02-system-architecture.md`).

---

## 10. Runbooks & operational procedures

### 10.1 One-time launch bootstrap (when domains are provided)

1. Register/transfer `hr.com`; delegate NS to Cloudflare; create zones for `hr.com` (+ any platform apex used for tenant CNAME target).
2. Provision data planes: RDS (IN `ap-south-1`, NZ `ap-southeast-2`), Redis, EC2 boxes, ECR, S3 buckets, SSM parameter trees `/hr/{env}/{region}/…`.
3. Install Cloudflare Tunnel on each box (inherited `cloudflared-…prod.yml` pattern: ingress `api.<domain> → 127.0.0.1:<port>`), route DNS, attach the router Worker to both zones.
4. Set up Cloudflare for SaaS (fallback origin `custom.<zone>`, custom-hostname token in SSM).
5. Seed compliance rule tables (§11) for the current tax year with effective dates.
6. Create `staging` + `main` branches at the vetted `development` SHA; run `ship staging` then, after golden-case + manual sign-off, `ship prod`.
7. Enable production alerting/on-call.

### 10.2 Standard deploy

`git checkout staging && git merge --ff-only development && git push && scripts/ship-hr staging <sha>` → verify golden-case green on staging → `git checkout main && git merge --ff-only staging && git push && scripts/ship-hr prod-in <sha>` → verify → `ship-hr prod-nz <sha>`.

### 10.3 Rollback

Re-ship the previous image digest: `scripts/ship-hr prod-in <previous-sha>`. If the bad release ran an **expand-only** migration (per §6.2 it always should), old code is forward-safe and rollback is instant. A migration that needs reversing uses its paired down-migration (only ever expand-phase, so reversible without data loss).

### 10.4 Incident: failed payroll run / filing miss

Freeze auto-file for the tenant → inspect Sentry trace + audit log → re-run from last good state (the run state machine is idempotent and restartable) → if a rate/config regression, hotfix the **compliance rule data row** (not code) and re-run.

---

## 11. Compliance rule tables are **data**, deployed without a code release

The single most important DevOps decision for this product: **statutory rates, thresholds, and slabs are versioned data rows with `effectiveFrom`/`effectiveTo`, edited in Super-Admin, not code constants.** A code deploy to change KiwiSaver from 3.0%→3.5% would be slow, risky, and untestable per-date. Instead the payroll engine **reads the rule version effective for the period being calculated** (`04-payroll-engine-design.md`, `05/06-compliance-*.md`).

**Rates currently encoded (with effective dates) that must exist as published rows on day one:**

- **NZ, effective 2026-04-01:** KiwiSaver default **3.5%** (employee + employer; →4% in 2028); 16–17 y/o now employer-contribution-eligible; ACC earners' levy **1.75%** on first **$156,641**; adult minimum wage **$23.95/hr**; ESCT bands; student-loan thresholds; Holidays Act 2003 leave-in-weeks parameters. ([paymasters.co.nz](https://paymasters.co.nz/blog/blog-april-2026-nz-payroll-changes-minimum-wage-kiwisaver-acc/))
- **IN, Labour Codes live 2025-11-21:** uniform wages definition (**Basic+DA ≥ 50% of total remuneration**); EPF 12%/12% split (EPS 8.33% capped at ₹15,000, EPF 3.67%, EDLI, admin charges; PF at 20+ employees); ESI 0.75%/3.25% on gross ≤ ₹21,000 (at 10 employees); state PT slabs capped ₹2,500/yr; gratuity 15/26 × last-drawn × years; new tax regime default, §87A nil-tax to ~₹12L taxable, ₹75k standard deduction. ([labour.gov.in FAQ 16.03.2026](https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf))

**Publish flow (Super-Admin → all tenants, no code deploy):** draft new rule version with `effectiveFrom` → validate against golden cases in staging → **publish** (writes the row, audited) → engine picks it up for periods on/after the date. A wrong rate is corrected by publishing a superseding version, never by a redeploy. This also cleanly handles the **Form 16 vs "Form 130" (Income Tax Act 2025) rename uncertainty** — the form mapping is a data attribute we flip when verified, not a code change.

---

## 12. Cost & scaling notes

### 12.1 Launch-scale topology (opinionated, cheap-but-correct)

| Component | Launch sizing | Notes |
|---|---|---|
| Compute | 2× `t4g.medium` Graviton **per region** (staging shares one) | inherited box class (`DEPLOY_POLICY.md`); ARM = ~20% cheaper; 4 GiB swapfile safety net |
| DB | RDS `db.t4g` Multi-AZ per region, scale to `db.r7g` on memory pressure | payroll is read-heavy at run time, write-bursty |
| Redis | small managed (ElastiCache) per region | sessions, scheduler leases, deploy interlock flag |
| CDN/SSL/Workers | Cloudflare (router Worker + Cloudflare for SaaS) | inherited; per-tenant SSL at scale is Cloudflare's job, not ours |
| Object store | S3 versioned + CRR + Object Lock | payslip/tax docs |
| Registry | ECR keep-last-10 | inherited lifecycle (`setup-ecr.sh`) |

### 12.2 Scaling levers (in order we'd pull them)

1. **Cluster instances** — bump PM2/compose instance counts (inherited `*_INSTANCES` env knobs in `ecosystem.config.js`).
2. **Vertical DB** — `t4g`→`r7g`; add **read replicas** for reporting/analytics so payroll runs never contend with dashboards.
3. **Horizontal app boxes** — add a box per region behind the tunnel; the fleet manifest + watchdog already make multi-box trivial.
4. **Payroll-run burst isolation** — month-end runs are spiky; move the engine to a **dedicated worker box / queue** (BullMQ on Redis) so a 50k-employee tenant's run doesn't starve the API. The scheduler→worker split already exists in Sitepresso (`scheduler-worker.js`).
5. **Move to ECS-Fargate/K8s** only when boxes exceed ~6/region or we need sub-minute autoscale.

### 12.3 Cost-control discipline (inherited lessons)

- **No build-on-push bleed:** CI builds an image once per merged SHA, not 22 projects per push (the Vercel incident — `DEPLOY_POLICY.md`). ECR lifecycle caps image storage.
- **Turbo remote cache** in CI so unchanged apps don't rebuild (inherited `turbo.json`).
- **Right-size on telemetry, not vibes:** the §7 dashboards drive sizing decisions; scale down staging off-hours.
- **Egress:** keep payroll/filing traffic in-region; cross-region only for DR snapshot copy (a controlled, scheduled cost).

---

## 13. Open items requiring founder/architect decision

These are surfaced in the StructuredOutput as open questions; listed here for the doc's completeness:

1. **Container migration now vs. interim tarball** for first prod cut.
2. **AWS account/region split** confirmation for NZ (`ap-southeast-2`) and the DR target regions that satisfy IN/NZ residency law.
3. **Filing-connector posture** (IRD payday filing API, EPFO/ESIC/TRACES) — direct integration vs. CA/partner gateway — drives §7 alerting and §4 credential handling.
4. **Form 16 → "Form 130"** (Income Tax Act 2025) confirmation to set the compliance-table form mapping.
5. **On-call ownership** for payroll-deadline alerts (these are money-and-legal, not best-effort).

# 18 — Integrations Strategy & Specifications

**Owner:** Senior Integrations Architect
**Status:** Production design (v1 scope flagged inline)
**Last updated:** 2026-06-22
**Markets:** India (IN) · New Zealand (NZ) · multi-currency INR/NZD · tax year Apr–Mar

> Cross-references: `02-system-architecture.md` (service topology, queues, secrets), `03-data-model.md` (canonical entities), `04-payroll-engine-design.md` (payrun outputs that feed disbursement + filing), `05-compliance-india.md` (EPFO/ESIC/TDS artefacts), `06-compliance-newzealand.md` (IRD payday filing, KiwiSaver/ESCT), `08-modules-time.md` (attendance ingestion), `11-ess-and-mobile.md` (employee notifications), `12-admin-consoles.md` (where integration config lives).

---

## 0. Integration Philosophy & Reuse Posture

This product is **"a pre-built system, not a builder."** That principle governs integrations too: tenants do **not** wire arbitrary pipelines. They **connect** a fixed catalogue of pre-built connectors via a guided flow (OAuth consent, file-format pick, device pairing), and they **use** them. Every connector below is something *we* build, certify, version, and operate. The only tenant-facing extensibility surface is the **outbound webhook + read-mostly public API** (§11), which is itself a fixed, versioned contract.

### 0.1 What we reuse from Sitepresso (real paths, READ-ONLY base at `/Users/kp/sitepresso`)

| Capability | Reused asset | Notes |
|---|---|---|
| Outbound webhooks (subscriptions, signed envelopes, retry/backoff) | `backend/src/core/lib/webhookDispatcher.js`, `backend/src/core/lib/publicApi.js` | `emit()`/`safeEmit()`, `MAX_ATTEMPTS=5`, backoff `[1,5,15,60,240]` min, HMAC-SHA256 envelope signing. Reuse wholesale; re-namespace events. |
| Public API key auth (hashed keys, scopes, timing-safe compare) | `backend/src/core/middleware/apiKey.middleware.js`, `backend/src/core/lib/publicApi.js` | `sp_live_` prefix → rebrand to `hr_live_`/`hr_test_`. SHA-256 key hash, `last4`, `lastUsedAt`. Scope model `{read:[], write:[]}`. |
| Public API routes shape (keys + webhook CRUD, test, replay) | `backend/src/core/routes/publicApi.routes.js`, `backend/src/core/controllers/publicApi.controller.js` | `/keys`, `/webhooks`, `/webhooks/:id/test`, `/webhooks/deliveries/:id/replay`. Reuse as the admin-plane control surface. |
| Multi-channel notifications (Email/SMS/WhatsApp), country routing, budget, DLT | `backend/src/core/lib/notifications/{router,providers,countryRouting,budgetEngine,templates,priceCache}.js`, `backend/src/core/lib/sms.js` | MSG91 for IN (DLT-compliant, ~20× cheaper), Twilio global incl. NZ, Twilio WA, SES email always-on fallback. Reuse the cascade engine verbatim; swap template keys to HR events. |
| Notification webhooks (delivery receipts inbound) | `backend/src/core/controllers/notificationWebhook.controller.js`, `backend/src/core/routes/notificationWebhook.routes.js` | Provider DLR callbacks → `MessageDelivery` status. |
| Social / SSO core (provider-agnostic, host→tenant, auth-code bridge) | `backend/src/core/lib/socialAuth/index.js`, `backend/src/core/lib/socialAuth/providers/google.js` | Registry pattern: drop a provider file + one registry line. Google live; Apple/Microsoft stubbed. Redis-backed single-use auth-code bridges platform-origin OAuth → tenant-host cookie. Critical for white-label SSO. |
| Billing-gateway adapter pattern (for *our* SaaS billing, not tenant payroll) | `backend/src/core/lib/billing/gateways/PaymentGateway.js`, `razorpayGateway.js`, `paddle.js`, `stripeConnect.js` | Adapter interface reused for the connector abstraction style; gateways themselves stay in the platform billing path (see `12-admin-consoles.md`). |
| Video provider adapters (pattern reference for connector registry) | `backend/src/core/lib/videoProviders/{googleMeet,zoom,msTeams}.js` | Same "registry of thin adapters with `isConfigured()`" shape we apply to accounting/bank connectors. |
| Crypto helpers (HMAC, token hashing) | `backend/src/core/lib/crypto.js`, `publicApi.js` | Webhook signing, secret-at-rest encryption for connector credentials. |
| i18n (en/hi) | `backend/src/i18n/`, `packages/...` | Extend with `mi` (te reo placeholders) — see `13-ux-ia-designsystem.md`. |

### 0.2 Connector classification (decides architecture, not just priority)

Every external system falls into exactly one of five **interaction modes**. This is the single most important taxonomy because it dictates auth, data-flow, and failure handling.

| Mode | Definition | Examples here | Failure model |
|---|---|---|---|
| **A — Live REST/OAuth API** | Real-time request/response or webhook callbacks | Xero, Zoho Books, IRD Gateway (payday filing), Slack/Teams, Google/Microsoft SSO, Twilio/MSG91/SES, biometric ADMS-cloud | Retry w/ backoff, circuit breaker, idempotency keys |
| **B — Government file-upload (no public API)** | We generate a spec-exact file; a human (or RPA-assisted human) uploads it to a portal | EPFO ECR, ESIC contribution, TRACES/Income-Tax **Form 24Q→138** quarterly, Professional Tax state portals | Validate before generate; portal ack captured as evidence artefact |
| **C — Bank disbursement file** | We generate a bank-specific batch file; tenant uploads to corporate-banking / H2H | IN: HDFC/ICICI/Axis bulk-NEFT, SBI; NZ: ANZ/ASB/BNZ/Westpac/Kiwibank direct-credit | Pre-validation + maker-checker; bank rejection file re-ingested |
| **D — Device push** | Hardware pushes events to us over a vendor protocol | Biometric clocks (ZKTeco/eSSL ADMS push), via gateway | At-least-once; dedupe on (device, userId, punchTs) |
| **E — Tenant-facing surface** | *We* expose contract; tenant/third-party consumes | Outbound webhooks, public read API | Signed, versioned, idempotent, replayable |

> **Hard architectural rule:** never pretend Mode B is Mode A. Indian statutory filing (EPFO, ESIC, TRACES) has **no production public API** for direct programmatic submission by a generic employer; the compliant path is spec-exact **file generation + portal upload** (optionally ERI-assisted for income-tax, see §6.4). New Zealand is the opposite: IRD offers **true gateway-services REST APIs** for payday filing. Designing IN as if it were NZ is the classic, expensive mistake.

---

## 1. Reference Architecture

### 1.1 Service placement

```
                          ┌─────────────────────────────────────────────┐
                          │  backend/src/hr  (new vertical)              │
   payrun finalised ─────▶│  integrations/                               │
                          │   ├─ accounting/   (xero, zoho, tally)       │
                          │   ├─ disbursement/ (in/*, nz/*)              │
                          │   ├─ statutory/    (epfo, esic, traces, ird) │
                          │   ├─ attendance/   (adms-gateway ingest)     │
                          │   ├─ collab/       (slack, teams)            │
                          │   └─ identity/     (sso: google/ms/saml)     │
                          └───────────────┬─────────────────────────────┘
                                          │ enqueue
                   ┌──────────────────────▼───────────────────────┐
                   │  Redis (BullMQ)  integration job queues       │
                   │   q:accounting.sync  q:filing.generate        │
                   │   q:disbursement.build  q:attendance.ingest   │
                   │   q:webhook.deliver (reuse webhookDispatcher)  │
                   └──────────────────────┬───────────────────────┘
                                          │
        ┌──────────────┬─────────────┬────▼─────────┬───────────────┐
        ▼              ▼             ▼              ▼               ▼
   Xero/Zoho      Bank H2H      IRD Gateway    EPFO/ESIC      ZKTeco ADMS
   (OAuth API)    (SFTP/portal) (mTLS REST)    (file+portal)  (push HTTP)
```

- All connectors run as **idempotent, queued jobs** (BullMQ on Redis — already in the stack per `02-system-architecture.md`). Synchronous request paths are forbidden for anything that touches an external network except OAuth redirects and the public read API.
- Each tenant connection is a row in `IntegrationConnection` (§1.3). Secrets are **envelope-encrypted at rest** (AES-256-GCM, KMS-wrapped DEK) reusing `crypto.js` patterns; never logged, never returned to the client (only `last4`/metadata).
- **Per-country data residency:** IN tenant statutory/bank artefacts are processed and stored in the `ap-south-1`-equivalent region; NZ tenant artefacts in an AU/NZ region. The integration layer is region-pinned by `tenant.dataRegion`. (See `02-system-architecture.md`.)

### 1.2 Cross-cutting concerns (apply to every connector)

| Concern | Standard |
|---|---|
| **Idempotency** | Every outbound submission carries an `idempotencyKey = sha256(tenantId|payrunId|connector|targetPeriod|attempt-cohort)`. Re-runs of the same logical action are deduped at the connector boundary and at the remote where supported (Xero `Idempotency-Key` header; IRD request-id). |
| **Retries** | Exponential backoff, jittered. Mode A: `[2s,8s,30s,2m,10m]` then DLQ. Mode E (webhooks): reuse `[1,5,15,60,240]` min from `webhookDispatcher.js`. |
| **Circuit breaker** | Per (connector, tenant) breaker. Open after 5 consecutive 5xx/timeouts within 60s; half-open probe after 5 min. Prevents one bad bank/portal from starving the queue. |
| **Audit** | Every external call writes an `IntegrationAuditLog` row: actor, connector, action, request hash, response code, latency, artefact ref. Immutable, feeds `12-admin-consoles.md` audit view. |
| **Reconciliation** | Disbursement + filing connectors are **two-phase**: (1) generate/submit, (2) confirm via return file / portal ack / status poll. A payrun is not "closed" until phase 2 succeeds. |
| **Secret rotation** | OAuth refresh tokens auto-rotated; static API keys/SFTP creds rotated on a 90-day reminder. Rotation never drops in-flight jobs. |
| **PII minimisation** | Connectors send only the fields the remote requires. Bank files carry account + amount + narration, never tax IDs unless mandated. Filing files carry statutory IDs by definition. |
| **Observability** | OpenTelemetry spans per job; per-connector dashboards (success rate, p95 latency, DLQ depth) in the platform Grafana. Alerts to on-call + tenant-facing status banner. |

### 1.3 Canonical data model (new — see `03-data-model.md` for full ERD)

```prisma
model IntegrationConnection {
  id            String   @id @default(cuid())
  businessId    String                       // row-level tenant isolation (reused pattern)
  connector     String                       // 'xero' | 'zoho_books' | 'tally' | 'bank_hdfc' | 'ird_payday' | 'epfo_ecr' | 'esic' | 'traces' | 'pt_<state>' | 'adms' | 'slack' | 'teams' | 'sso_google' | 'sso_microsoft' | 'sso_saml'
  mode          String                       // 'A'|'B'|'C'|'D'|'E'
  status        String                       // 'PENDING'|'ACTIVE'|'ERROR'|'EXPIRED'|'DISABLED'
  country       String?                      // 'IN'|'NZ' (null = global)
  config        Json                         // non-secret connector settings (org id, bank code, device serials...)
  secretRef     String?                      // pointer to envelope-encrypted secret blob (never inline)
  scopes        Json?                        // granted OAuth scopes / capabilities
  externalId    String?                      // remote tenant id (Xero tenantId, Slack team, IRD acct)
  lastSyncAt    DateTime?
  lastErrorAt   DateTime?
  lastError     String?
  createdBy     String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@unique([businessId, connector])
  @@index([businessId, status])
}

model IntegrationJob {
  id            String   @id @default(cuid())
  businessId    String
  connectionId  String
  kind          String   // 'accounting.journal' | 'disbursement.file' | 'filing.epfo_ecr' | 'filing.ird_ei' | ...
  payrunId      String?
  period        String?  // 'IN:2026-04' | 'NZ:PAYDAY:2026-04-30'
  idempotencyKey String  @unique
  status        String   // 'QUEUED'|'RUNNING'|'AWAITING_CONFIRM'|'SUCCEEDED'|'FAILED'|'CANCELLED'
  attempt       Int      @default(0)
  artefactRef   String?  // generated file (S3 key) or remote ref
  ackRef        String?  // portal/bank ack, return-file ref
  requestHash   String?
  responseCode  String?
  error         Json?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([businessId, kind, status])
}

model IntegrationAuditLog {
  id           String   @id @default(cuid())
  businessId   String
  connector    String
  action       String
  actorType    String   // 'SYSTEM'|'USER'|'SUPPORT_IMPERSONATE'
  actorId      String?
  requestHash  String?
  responseCode String?
  latencyMs    Int?
  artefactRef  String?
  createdAt    DateTime @default(now())
  @@index([businessId, connector, createdAt])
}
```

### 1.4 Connection state machine (all Mode-A/C/D connectors)

```
            connect()                grant/pair OK
  ┌──────┐ ──────────▶ ┌──────────┐ ──────────────▶ ┌────────┐
  │ none │             │ PENDING  │                 │ ACTIVE │◀───┐
  └──────┘             └────┬─────┘                 └───┬────┘    │ refresh OK
                            │ grant denied / timeout    │         │
                            ▼                           │ token expired / 401
                       ┌────────┐                       ▼
                       │ ERROR  │◀──── remote 5xx ──── ┌─────────┐
                       └───┬────┘   (breaker open)     │ EXPIRED │
              admin retry  │                           └────┬────┘
                           ▼            admin re-auth        │
                       (back to PENDING/ACTIVE) ◀────────────┘
   admin disable any state ──▶ DISABLED  (jobs paused, no new enqueues)
```

---

## 2. Accounting Integrations (Mode A — Xero, Zoho Books; Mode B — Tally)

**Purpose:** Post each finalised payrun into the tenant's general ledger as a **payroll journal** (and optionally a bills/payments entry for net pay + statutory liabilities). We are the system of record for payroll; the accounting system is the system of record for the GL. We **push journals**, we do **not** pull chart-of-accounts as truth — we let the tenant **map** our payroll line types to their GL accounts once, then reuse.

### 2.1 Common: the Payroll Journal abstraction

Regardless of target, a finalised payrun emits one canonical **PayrollJournal** (double-entry, balanced):

| Line type (canonical) | Dr/Cr | IN example account | NZ example account |
|---|---|---|---|
| `GROSS_WAGES` | Dr (expense) | Salaries & Wages | Wages & Salaries |
| `EMPLOYER_PF` / `EMPLOYER_KIWISAVER` | Dr (expense) | Employer PF Contribution | Employer KiwiSaver |
| `EMPLOYER_ESI` | Dr (expense) | Employer ESI | — |
| `NET_PAY_PAYABLE` | Cr (liability) | Net Salary Payable | Net Wages Payable |
| `PAYE_TDS_PAYABLE` | Cr (liability) | TDS Payable | PAYE Payable |
| `PF_PAYABLE` (EE+ER) | Cr (liability) | PF Payable | — |
| `ESI_PAYABLE` (EE+ER) | Cr (liability) | ESI Payable | — |
| `KIWISAVER_PAYABLE` (EE+ER) | Cr (liability) | — | KiwiSaver Payable |
| `ESCT_PAYABLE` | Cr / contra | — | ESCT Payable (within PAYE remittance) |
| `PT_PAYABLE` | Cr (liability) | Professional Tax Payable | — |
| `STUDENT_LOAN_PAYABLE` | Cr (liability) | — | Student Loan Payable |
| `GRATUITY_PROVISION` | Dr/Cr | Gratuity Expense / Provision | — |
| `REIMBURSEMENTS` | Dr (expense) | Reimbursements | Reimbursements |

The tenant performs a **one-time account mapping** (`AccountMapping` rows: canonical line → remote GL account id) via a guided screen in the HR console. Until mapping is complete, the connector status is `ACTIVE` but journal posting is blocked with a clear "map N remaining accounts" prompt. **This is configuration, not building** — a fixed list, dropdown-mapped to the tenant's existing accounts.

### 2.2 Xero (NZ-first, also IN) — **v1**

- **Why first for NZ:** Xero dominates NZ/AU SME accounting; tenants expect it. Source: Xero Developer Payroll NZ API.
- **Decision:** We integrate at the **Accounting API** level (Manual Journals + optionally Bank Transactions), **not** the Xero Payroll-NZ API. Rationale: *we* are the payroll engine and own the Holidays-Act-correct calculations (our flagship — see `06-compliance-newzealand.md`); pushing into Xero Payroll would surrender that and force double-entry of employees. We post the **GL journal** only.
- **Auth:** OAuth 2.0 Authorization Code + PKCE. Scopes: `accounting.transactions`, `accounting.settings.read` (to fetch chart of accounts + tax rates for mapping), `offline_access` (refresh token). Per Xero, access token ~30 min, refresh token 60 days rolling. Reuse the social-auth code-bridge pattern (`socialAuth/index.js`) for the platform-origin → tenant-host hop so consent works under white-label domains.
- **Data flow (push):**
  1. Payrun finalised → enqueue `q:accounting.sync` (kind `accounting.journal`).
  2. Resolve `AccountMapping`; build balanced `ManualJournals` payload (date = pay date, narration = `Payroll <period> <payrunId>`).
  3. `POST /api.xro/2.0/ManualJournals` with `Idempotency-Key` header = our `idempotencyKey`, `Xero-Tenant-Id` = `externalId`.
  4. Persist remote `JournalID` in `IntegrationJob.ackRef`; mark `SUCCEEDED`.
- **Rate limits (honour exactly):** Xero enforces 60 calls/min and 5,000 calls/day per tenant (App Partner program note: usage-based pricing from Mar 2026 — track this commercially). We batch one journal per payrun, so headroom is large; the rate limiter is shared across the tenant's connectors.
- **Error handling:** 401 → refresh token; on refresh failure → status `EXPIRED`, surface "reconnect Xero". 429 → respect `Retry-After`. 400 (unbalanced/invalid account) → `FAILED` with field-level error shown to HR; never silently drop.
- **Edge cases:** (a) negative net pay (recovery) → still balanced journal; (b) mid-period account archived in Xero → mapping re-validation on each post, prompt remap; (c) locked accounting period in Xero → surface "Xero period locked" error, do not retry blindly.

### 2.3 Zoho Books (IN-first, also NZ) — **v1**

- **Why:** Strong in IN SME segment; Zoho Payroll/Books ecosystem common among Indian tenants.
- **Decision:** Post **Journals** via Zoho Books API (`POST /books/v3/journals?organization_id=...`). Same GL-only posture as Xero.
- **Auth:** OAuth 2.0 (Zoho Accounts). Scope `ZohoBooks.journals.CREATE`, `ZohoBooks.settings.READ` (chart of accounts), `ZohoBooks.contacts.READ` if posting vendor bills. **Region-pinned tokens** — Zoho has DC-specific domains (`.in`, `.com`, `.com.au`); we store the `api_domain` returned at token exchange in `config` and always call the correct DC. (Common failure: calling `.com` for an `.in` org → 401.)
- **Data flow:** identical to Xero; idempotency via our own dedupe (Zoho lacks a first-class idempotency header → we guard with `IntegrationJob.idempotencyKey` + a pre-check query for an existing journal with our reference in `reference_number`).
- **Rate limits:** Zoho Books per-org per-day call caps by plan; we stay well within with one journal/payrun.

### 2.4 Tally (Tally Prime) — **Mode B, v1.5 (IN only)**

- **Reality:** Tally is desktop-first. There is **no cloud OAuth API**. Integration is via **Tally's XML/HTTP request-response on the local Tally server** (default port 9000) or **export of a Tally-importable XML voucher file**. Most SME tenants run Tally on-prem behind no public endpoint.
- **Decision (two tiers):**
  - **Tier 1 (v1.5, default):** Generate a **Tally-importable XML** payroll Journal Voucher file the tenant downloads and imports (`Gateway of Tally → Import Data → Vouchers`). Deterministic, zero infra on tenant side. Most robust.
  - **Tier 2 (later):** Optional **Tally Connector agent** (a small signed helper the tenant installs next to Tally) that accepts our pushed XML over a tenant-authenticated tunnel and POSTs to `http://localhost:9000`. Only for tenants who demand hands-free posting. Higher support cost; gate behind a plan flag.
- **XML shape:** `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY>...<VOUCHER VCHTYPE="Journal">...<ALLLEDGERENTRIES.LIST>` per canonical line, ledger names from `AccountMapping`. Ledger-name mismatch is the #1 failure → we validate names against a tenant-provided ledger list (one-time export they upload) before generating.
- **Why not Mode A:** Building a cloud bridge to thousands of on-prem Tally installs is an operational liability that violates "configure and use." File export keeps it deterministic.

### 2.5 Accounting connector capability matrix

| Connector | Mode | Auth | Mechanism | Market | Phase |
|---|---|---|---|---|---|
| Xero | A | OAuth2+PKCE | Manual Journals API | NZ (also IN) | **v1** |
| Zoho Books | A | OAuth2 (Zoho, DC-pinned) | Journals API | IN (also NZ) | **v1** |
| Tally Prime (file) | B | n/a (local) | Importable XML voucher | IN | **v1.5** |
| Tally Connector (agent) | A* | tenant token | localhost:9000 XML | IN | Later |
| QuickBooks Online | A | OAuth2 | Journal Entry | (RoW) | Later |
| MYOB | A | OAuth2 | GL | NZ/AU | Later |

---

## 3. Bank Disbursement Files (Mode C)

**Purpose:** Turn the payrun's net-pay lines into a bank-ready batch the tenant uploads to corporate banking (or we transmit via H2H/SFTP for enterprise tenants). **We never move money ourselves** — we are not a payment institution. We are a **file/instruction generator** with maker-checker and reconciliation. This keeps us out of money-transmitter licensing.

### 3.1 Disbursement state machine (shared IN + NZ)

```
 payrun.finalised
       │
       ▼
 BUILD_PENDING ──validate──▶ BUILD_FAILED (fix beneficiary/IFSC/account → re-run)
       │ valid
       ▼
 FILE_READY ──(maker creates)──▶ AWAITING_APPROVAL
       │                               │ checker approves
       │                               ▼
       │                         APPROVED ──(download / H2H push)──▶ SUBMITTED
       │                                                                  │
       │                                          bank ack / return file  │
       ▼                                                                  ▼
   CANCELLED                                              ┌───── RECONCILED (all credited)
                                                          ├───── PARTIALLY_FAILED (some rejects)
                                                          └───── REJECTED (file-level reject)
```

- **Maker-checker is mandatory** (Indian corporate banking norm; good practice everywhere). Two distinct users with `PAYROLL_DISBURSE_MAKER` / `PAYROLL_DISBURSE_CHECKER` roles (RBAC reused from `rbac.js`).
- **Beneficiary pre-validation** runs before file build: account number format, IFSC (IN) / bank-branch-suffix (NZ), name length, amount > 0, currency match, active beneficiary. Failures block the whole file (a half-paid payroll is worse than a delayed one) but are listed line-by-line for fast fixing.

### 3.2 India — NEFT/RTGS/IMPS bulk + bank-specific formats — **v1**

India has **no single national salary-file standard**; each bank publishes its own bulk-upload spec (CSV/Excel/fixed-width), plus the universal NEFT/RTGS rails underneath. We ship **per-bank templates**, selected by the tenant once.

| Bank | Format | Mechanism | Notes |
|---|---|---|---|
| **HDFC** | Fixed-width / Excel→CSV "Bulk Payment" (ENet) | Portal upload or H2H | Salary product (within + outside HDFC). |
| **ICICI** | CSV "PAB-SAL" (salary) / Bulk Transfers | CIB portal or **H2H** | ICICI offers Host-to-Host single-file upload. |
| **Axis** | CSV bulk payment | Corporate IB upload | |
| **SBI** | SBI corporate (e-CINB) text | Portal upload | Large PSU coverage. |
| **Kotak / Yes / others** | CSV variants | Portal | Add on demand. |
| **Generic NEFT/RTGS** | RBI NEFT CSV (beneficiary, IFSC, amount, narration) | Any bank's bulk-NEFT | Universal fallback. |

- **Canonical fields → bank mapping:** we maintain a per-bank field map (column order, headers, date format, amount format with/without decimals, debit-account placement, transaction-type code for NEFT vs RTGS vs IMPS, value date). Versioned in the **compliance/format rule tables** owned by Super Admin (see `12-admin-consoles.md`) so format tweaks ship without code deploy.
- **Rail selection:** amount-based default — IMPS/NEFT for typical salaries; RTGS for ≥ ₹2,00,000 single credits where the bank requires it. Tenant can override.
- **Validation rules (IN):** IFSC = `^[A-Z]{4}0[A-Z0-9]{6}$`; account number 9–18 digits; beneficiary name ≤ bank max (often 40); narration ≤ 18–35 chars depending on rail; no special chars the bank rejects. UPI not used for bulk salary.
- **Maker-checker + masked preview:** checker sees totals, count, hash of file; account numbers masked except last 4.
- **Reconciliation:** banks return a **status/response file** (per-record success/return reason). We ingest it (manual upload v1; SFTP auto for H2H tenants), map reason codes (e.g., "account closed", "name mismatch", "invalid IFSC") to per-employee `DisbursementResult`, and flip the payrun to `PARTIALLY_FAILED` with a re-issue workflow for the rejects only.

### 3.3 New Zealand — Direct Credit batch — **v1**

NZ has a more standardised landscape. Banks accept **bank-specific direct-credit batch files**; the most widely supported are the **BNZ IB4B** format and bank-native CSV, with the ABA-style fixed-length format common in AU/NZ tooling.

| Bank | Format | Notes |
|---|---|---|
| **BNZ** | **IB4B** (Internet Banking for Business) file | Documented public spec (BNZ IB4B file format guide). Primary target. |
| **ANZ** | Direct Credit (ANZ Transactive / .dc) | ANZ Transactive Global file formats. |
| **ASB** | ASB direct-credit / CSV | |
| **Westpac** | Westpac batch / CSV | |
| **Kiwibank** | Kiwibank direct credit | |
| **Generic ABA** | 120-byte fixed-length records, CRLF-separated; `.aba`/`.txt` | Descriptive + Detail + Batch-Control records. Useful fallback for PayHero-style tooling. |

- **NZ account number structure:** `BB-bbbb-AAAAAAA-SSS` (Bank–Branch–Account–Suffix). Validation: 2-digit bank, 4-digit branch, 7-digit account (zero-padded), 2–4 digit suffix. We validate the bank/branch against the NZ branch register and run the standard NZ bank-account **modulus check** before file build (rejects typo'd accounts pre-submission — a key correctness win).
- **Particulars / Code / Reference:** NZ direct credits carry three 12-char free-text fields shown on the payee's statement. We default Particulars=`SALARY`, Code=`<period>`, Reference=`<employer short name>` — tenant-configurable, length-validated.
- **Hash totals & control record:** IB4B/ABA require a batch control record with item count + value hash; we compute and embed it, and re-verify on download to catch truncation.
- **Reconciliation:** NZ banks generally don't return a structured per-item response file for direct credit (unlike IN), so reconciliation is **statement-based**: the tenant confirms the debit, and bounce-backs (closed account) appear as credits-reversed in the next statement → we expose a "mark disbursement returned" action and a re-issue flow.

### 3.4 Transmission options

| Tier | Mechanism | Who | Notes |
|---|---|---|---|
| **Download** (default, v1) | Tenant downloads file, uploads to their corporate banking portal | All | Zero bank-side onboarding; safest. |
| **H2H / SFTP** (v2) | We push file to bank's SFTP, ingest return file | Enterprise tenants with H2H agreements (ICICI/HDFC etc.) | Per-tenant SFTP creds (envelope-encrypted), PGP-signed files where bank requires. |
| **API** (future) | Direct bank payment API | Where a bank exposes one with proper licensing | Out of scope until licensing reviewed. |

---

## 4. Government Filing — New Zealand (Mode A — true API)

**IRD Payday Filing is our flagship NZ integration** because NZ requires **payday filing within 2 working days of each payday** and IRD provides **real gateway-services REST APIs**. (Source: IRD Digital Service Providers — Payday filing through gateway services; file-upload spec 2026–2027 also published as fallback.)

### 4.1 Two delivery channels (we build both; API is primary)

| Channel | Mechanism | When |
|---|---|---|
| **Gateway Services API** (primary, v1) | Authenticated REST submission of **Employment Information (EI)** per payday, plus **Employee Details** (new hire / departing) | Real-time, 2-working-day SLA |
| **File Upload spec** (fallback, v1) | Generate IRD's **Payday Filing File Upload** CSV per the 2026–2027 specification; tenant uploads via myIR | DR for API outage / unregistered tenants |

### 4.2 What we file

- **Employment Information (EI) return** per payday: per-employee gross earnings, PAYE, ESCT, KiwiSaver employee + employer contributions, student loan deductions, child support, payroll donations; plus pay period + payday date.
- **Employee Details:** new employees (with KiwiSaver status, tax code, IRD number) and departures, filed when they change.

### 4.3 2026-accurate figures embedded in the engine (effective **1 April 2026** unless noted)

| Item | Value (from 1 Apr 2026) | Notes |
|---|---|---|
| KiwiSaver default min (employee **and** employer) | **3.5%** (was 3%) | Rises to 4% in 2028. Temporary rate-reduction to 3% allowable (3–12 months) — engine must honour the employee's elected/reduced rate. |
| KiwiSaver eligibility age for employer contributions | now includes **16–17 year olds** | New from 2026; engine eligibility check updated. |
| Govt contribution (member tax credit) | **25c per $1**, max **NZD 260.72/yr** (from 1 Jul 2025) | Halved from 50c / 521.43. Not employer-deducted but affects member comms. |
| ACC earners' levy | **1.75%** (was 1.67%) on income up to **NZD 156,641** | Levy threshold + rate updated. |
| Adult minimum wage | **NZD 23.95/hr** | Affects gross + leave calcs. |
| ESCT | Employer KiwiSaver contributions taxed at the employee's ESCT rate (banded by prior-year income) | Filed within PAYE remittance. |
| Student loan | Standard deduction rate applied above the pay-period repayment threshold | Filed in EI. |

> The exact rates/thresholds live in the **versioned per-country compliance rule tables** (Super Admin, `05-/06-` docs), not hardcoded. The integration layer reads them; it doesn't own them.

### 4.4 Auth & transport

- **mTLS + OAuth** per IRD gateway-services security model. We register as a **Digital Service Provider (DSP)** and obtain gateway credentials; technical docs are behind IRD's **Gateway Customer Support Portal** (registration required since 1 Jul 2025). Per-tenant **delegated authority**: the employer authorises our software to file on their behalf (myIR linking / agency). We store the linkage, not the employer's myIR password.
- **Sandbox-first:** all EI/Employee-Details flows certified against IRD's test environment before a tenant goes live (IRD requires conformance).

### 4.5 Flow & error handling

```
 payrun.finalised (NZ)
    │
    ▼
 build EI return  ──schema/business-rule validate (IRD rules spec)──▶ VALIDATION_FAILED
    │ valid                                                                 │ show field errors
    ▼                                                                       ▼
 submit EI (gateway) ──ack(receipt id)──▶ FILED  ──poll status──▶ ACCEPTED
    │ 4xx (data)         │ 5xx/timeout                                  │ REJECTED (IRD)
    ▼                    ▼                                              ▼
 FILED_REJECTED      retry/backoff → DLQ → fallback to file-upload   correction return
```

- **Idempotency:** IRD request id per submission; resubmits of the same payday are corrections, not duplicates. We track `period = NZ:PAYDAY:<date>`.
- **Corrections:** amended EI supported; engine recomputes deltas and files an amendment referencing the original receipt.
- **2-working-day SLA monitor:** a job watches each NZ payrun; if not `ACCEPTED` within SLA, escalate to tenant + on-call. NZ public-holiday calendar drives "working day" math (shared with Holidays-Act engine, `06-compliance-newzealand.md`).
- **IRD number validation:** validated locally (modulus 11) before submission; note IRD raised the IRD-number validation upper limit (2026 update) — our validator tracks the current range from the rule table.

---

## 5. Government Filing — India (Mode B — file generation + portal upload)

**Critical truth (verified):** India has **no general public API** for an employer to programmatically submit EPFO ECR, ESIC contributions, or TRACES TDS returns. The compliant, production path is **spec-exact file generation** + **portal upload**, with optional **ERI-assisted** income-tax flows (§6.4). We build the hardest part — perfectly valid files — and make upload a 2-minute guided step, capturing the portal acknowledgement as the compliance artefact.

### 5.1 EPFO — Electronic Challan-cum-Return (ECR) — **v1**

- **Mechanism:** Generate the **ECR text file** (`#~#`-delimited per EPFO `ECR_ForEmployers_FileStructure`) → tenant uploads at the EPFO **Unified Member Portal** → portal returns a **TRRN** + challan → tenant pays → we capture TRRN + paid challan as artefacts.
- **2026 facts embedded:** EPF 12% employee + 12% employer; employer split **EPS 8.33% capped at ₹15,000 wage**, **EPF 3.67%**, plus **EDLI** + admin charges; **mandatory at 20+ employees**. The **New Labour Codes (live 21 Nov 2025)** impose a **uniform "wages" definition → Basic + DA must be ≥ 50% of total remuneration**, which cascades into the PF wage base and gratuity. Our ECR builder computes PF wages on the post-Labour-Code basis and flags structures that violate the 50% rule **before** file generation (see `05-compliance-india.md`).
- **Validation:** UAN format (12 digits), member name vs UAN, wage ≥ 0, no member in two ECR rows, gross/EPF/EPS/EDLI arithmetic cross-checks. Reject pre-generation, never let the portal be the first validator.
- **Due date monitor:** **PF by 15th** of following month → reminder + SLA job.

### 5.2 ESIC — Contribution file — **v1**

- **Mechanism:** Generate ESIC **monthly contribution** Excel/template → upload at ESIC portal → challan generated → pay → capture challan.
- **2026 facts:** ESI **0.75% employee + 3.25% employer** on **gross ≤ ₹21,000**; **mandatory at 10 employees**. Engine stops ESI deductions when an employee crosses the ₹21,000 ceiling mid-contribution-period per the half-year rule (Apr–Sep / Oct–Mar) — handled in payroll engine, surfaced in file.
- **Due date:** **ESIC by 15th**.

### 5.3 Income-Tax / TDS — Form 24Q → **Form 138** (quarterly), Form 16 → **Form 130** (annual) — **v1**

- **2026 rename (verified, effective TY 2026-27 / 1 Apr 2026 under the Income Tax Act 2025):**
  - **Form 24Q → Form 138** (quarterly salary TDS return).
  - **Form 16 → Form 130** (annual salary TDS certificate); **Form 16A → Form 131**.
  - We label artefacts with the **new** names for TY 2026-27+ and keep **legacy 24Q/16** labels for FY 2025-26 and prior. A document labelled "Form 16" for TY 2026-27 is non-compliant.
- **Mechanism (quarterly return):** Generate the **FVU-validatable text file** (NSDL/Protean RPU + **FVU** validation) → tenant (or their TAN-registered filer) uploads to the **TRACES 2.0 / income-tax e-filing** portal → token/provisional receipt captured. There is **no generic employer API**; ERIs have a restricted API (§6.4) but generic submission is file-based.
- **Quarterly due dates (FY 2026-27):** Q1 **31 Jul 2026**, Q2 **31 Oct 2026**, Q3 **31 Jan 2027**, Q4 **31 May 2027**. **TDS deposit by 7th** of following month (engine + reminder).
- **Annual certificate (Form 130):** generated from TRACES after Q4 processing; we assemble Part A (TRACES-downloaded) + Part B (our computation) and distribute via ESS (`11-ess-and-mobile.md`).
- **New tax regime default:** engine defaults to the **new regime** (old regime opt-in); **§87A → nil tax up to ~₹12L taxable**; **₹75,000 standard deduction**. These are payroll-engine facts (`05-compliance-india.md`); the filing file simply reflects computed TDS.

### 5.4 Professional Tax — state portals — **v1 (state-by-state rollout)**

- **Reality:** PT is **state-administered**; each state has its own portal, return format, and slabs, **capped ₹2,500/yr**. Examples 2026: **Karnataka** ₹200/month + ₹300 in February (annual ₹2,500); **Maharashtra** ₹200/month + ₹300 in February, with women earning ≤ ₹25,000/month exempt.
- **Mechanism:** Per-state file/return generator + portal-upload guide. We launch with the highest-volume states (KA, MH, WB, TN, AP/TS, GJ) and add states on demand. Slabs live in the **versioned compliance rule tables** keyed by `state + effectiveDate`.

### 5.5 India statutory connector matrix

| Filing | Body | Mode | Artefact | Due (FY26-27) | Phase |
|---|---|---|---|---|---|
| EPF ECR | EPFO | B (file+portal) | `#~#` ECR text → TRRN/challan | 15th monthly | v1 |
| ESIC contribution | ESIC | B | Contribution template → challan | 15th monthly | v1 |
| TDS quarterly | Income-Tax/TRACES | B (FVU file) | **Form 138** (was 24Q) | 31 Jul/31 Oct/31 Jan/31 May | v1 |
| TDS deposit | Income-Tax | B | Challan-cum-statement | 7th monthly | v1 |
| Salary certificate | TRACES | B (assemble) | **Form 130** (was 16) | post-Q4 | v1 |
| Professional Tax | State govts | B | State-specific return | state-specific | v1 (KA/MH first) |
| LWF (Labour Welfare Fund) | State | B | State return | half-yearly/yearly | v1.5 |

---

## 6. Identity & SSO (Mode A — Google / Microsoft / SAML)

**Reuse:** `backend/src/core/lib/socialAuth/index.js` (provider registry, host→tenant resolution, Redis auth-code bridge) + `providers/google.js`. The bridge is essential for **white-label** SSO: the OAuth SDK lives at the platform origin, but the JWT cookie must land on the **tenant's custom domain** (`tenant.com` / `tenant.hr.com`). The single-use Redis code carries the verified identity across origins.

### 6.1 Providers

| Provider | Protocol | Use | Phase |
|---|---|---|---|
| **Google** | OIDC (Google Identity, ID token verify via `google-auth-library`) | Employee + HR login | **v1** (already wired) |
| **Microsoft** | OIDC (Entra ID / Azure AD, multi-tenant app) | Enterprise tenants | **v1** (stub → finish per registry pattern: add `providers/microsoft.js`) |
| **Generic SAML 2.0** | SP-initiated SSO, per-tenant IdP metadata | Enterprise SSO (Okta/Entra/OneLogin/ADFS) | **v1.5** |
| Apple | OIDC | Employee mobile | Later |

### 6.2 SAML design (v1.5)

- **Per-tenant SP config:** each tenant uploads IdP metadata (entityID, SSO URL, X.509 signing cert) — **configure, not build**. We issue per-tenant SP metadata + ACS URL `https://app.hr.com/sso/saml/<tenantId>/acs` (and a tenant-domain variant resolved via the existing host→tenant lookup).
- **Assertion handling:** validate signature, audience, `NotOnOrAfter`, replay (cache assertion id in Redis). Map NameID/email → `Employee` via JIT or strict pre-provisioned matching (tenant choice). Optional SCIM 2.0 user provisioning — **later**.
- **Security:** signed assertions required; encrypted assertions supported; clock-skew ±2 min; force-authn + SLO optional. RBAC mapping from SAML group attributes → our roles via a fixed mapping screen.

### 6.3 Account-linking & precedence

- An employee may have password + Google + SAML identities (`CustomerIdentity`/`EmployeeIdentity` rows, reused pattern). Linking by verified email; conflicts resolved by tenant policy (e.g., SAML-only enforced → password login disabled for that tenant).

### 6.4 ERI / agency note (income-tax, IN)

- Separate from SSO: India's income-tax portal exposes a **restricted ERI (e-Return Intermediary) API** (add-client, prefill with consent, validate/submit, e-verify) only to **registered ERI agencies**. If we register as an ERI later, *some* income-tax flows could move from Mode B (file) toward Mode A (API) — but this is a licensing + liability decision, flagged as an **open question**, not v1.

---

## 7. Attendance Devices (Mode D — biometric)

**Purpose:** Ingest punches from on-prem biometric/RFID clocks into the time module (`08-modules-time.md`) without tenants installing desktop middleware.

### 7.1 Protocol decision: ADMS Push (not pull-SDK)

- **Decision:** Standardise on the **ADMS / push protocol** (ZKTeco, eSSL, and compatible) where the **device POSTs punches to our cloud endpoint over HTTP(S)**. This works behind NAT/firewalls (device → us), needs no inbound network on the tenant side, and avoids per-device polling. (Source: ZKTeco/eSSL ADMS push integration patterns.)
- **Bridge for non-cloud devices / mixed fleets:** support a certified **gateway** (e.g., a Cams-style universal connector) that normalises ZKTeco/eSSL/other brands to one JSON shape and forwards to us. Avoids us re-implementing every vendor's binary protocol.
- **Not chosen:** direct TCP pull via vendor SDK on a tenant PC (fragile, desktop dependency, violates "configure and use").

### 7.2 Endpoint, auth, data flow

- **Ingest endpoint:** `POST https://ingest.hr.com/attendance/adms/<deviceToken>` (per-device token; device pre-registered in HR console → token printed/paired). Token in path because cheap ADMS firmware can't always set custom headers; we additionally bind to the device serial in the payload + an allow-listed shared secret where firmware supports it.
- **Payload (normalised):** `{ deviceSerial, records: [{ userId, punchTs, direction, verifyMode, temp?, photoRef? }] }`. Vendor-native ADMS table format is parsed by a per-vendor adapter.
- **Mapping:** `deviceUserId → Employee` via a `DeviceEnrolment` table (tenant maps enrolment IDs to employees once). Unmapped IDs → quarantine queue, surfaced to HR.
- **Dedupe / idempotency:** unique on `(deviceSerial, userId, punchTs)`; at-least-once delivery tolerated.
- **Clock-skew & timezone:** device clock drift corrected against server time + tenant timezone; we store raw + normalised.
- **Offline buffering:** ADMS devices buffer and replay on reconnect → we accept backfilled timestamps and re-run the affected day's time aggregation.
- **Security:** per-device token rotation; rate-limit per device; reject implausible timestamps (future-dated > 5 min, > 30 days old) to quarantine.

### 7.3 Phasing

| Item | Phase |
|---|---|
| ADMS push ingest (ZKTeco/eSSL) | **v1** |
| Universal gateway (multi-brand) | v1.5 |
| Mobile geofenced / selfie punch (app) | v1 (separate, see `11-ess-and-mobile.md`) |
| Facial/QR kiosk (our PWA kiosk mode) | v1.5 |

---

## 8. Collaboration — Slack & Microsoft Teams (Mode A)

**Purpose:** Push HR events (leave requests/approvals, payslip-ready, birthdays, approvals needing action) and allow lightweight actions (approve/reject leave) from chat. **Not** a full conversational HR bot in v1.

### 8.1 Slack — **v1**

- **Auth:** Slack OAuth 2.0 (`chat:write`, `commands`, `users:read`, `im:write`). Per-tenant workspace install; bot token stored envelope-encrypted.
- **Outbound:** event-driven Block Kit messages via `chat.postMessage`. Reuse the notification router's event triggers; Slack is just another channel adapter registered alongside Email/SMS/WA (extend `notifications/providers.js` pattern).
- **Interactive:** approve/reject leave via Block Kit buttons → signed interaction payload (verify Slack signing secret, replay-protect) → action applied with RBAC check on the linking user.
- **Slash commands:** `/leave-balance`, `/whoisout` (read-only, scoped to the requesting employee).

### 8.2 Microsoft Teams — **v1.5**

- **Auth:** Entra ID app + Graph; incoming webhook or bot (Bot Framework) per tenant. Adaptive Cards mirror Slack Block Kit.
- **Decision:** ship Slack first (simpler install, common in IN/NZ SMEs); Teams second for enterprise.

### 8.3 Channel mapping & noise control

- Tenant maps event categories → Slack/Teams channels (config screen). Per-employee DMs for personal events (payslip ready, leave decision). Respect quiet hours + the notification budget engine so chat doesn't spam.

---

## 9. Notifications — Email / SMS / WhatsApp (Mode A)

**Full reuse** of the Sitepresso smart notification stack — this is one of the highest-value reuse wins.

| Channel | Provider | Reused file | HR usage |
|---|---|---|---|
| Email | SES (always-on fallback) | `notifications/providers.js`, `core/utils/email.js` | Payslips, Form 130/16, onboarding, approvals |
| SMS (IN) | **MSG91** (DLT-compliant, ~20× cheaper) | `sms.js`, `notifications/countryRouting.js` | OTP, payday alerts |
| SMS (NZ/global) | Twilio | `sms.js` | OTP, alerts |
| WhatsApp | Twilio WA Business | `notifications/providers.js`, `whatsappCatalog.js` | Payslip-ready, leave decisions, reminders |

- **Cascade engine reused verbatim** (`notifications/router.js`): per-event channel preferences, country detection, **TRAI/DLT** + TCPA opt-out (`SmsOptOut`), **budget pre-flight** (`budgetEngine.js`), provider price cache, email always-on fallback. We only swap template keys to HR events (`PAYSLIP_READY`, `LEAVE_APPROVED`, `PAYDAY_REMINDER`, `FORM130_AVAILABLE`, etc.) and register them in `templates.js`.
- **DLT (India):** SMS templates must be DLT-registered; the engine already tracks DLT approval status per `MessageTemplate`. HR transactional templates get registered under the tenant's (or our) DLT entity.
- **WhatsApp templates:** utility-category templates pre-approved (Meta); payslip-ready and OTP flows use approved templates only.
- **Delivery receipts:** provider DLR callbacks → `notificationWebhook.controller.js` → `MessageDelivery` status (reused).

---

## 10. Webhooks & Public API for Tenants (Mode E)

**Reuse:** `webhookDispatcher.js`, `publicApi.js`, `apiKey.middleware.js`, `publicApi.routes.js`. Rebrand key prefix `sp_live_` → `hr_live_` / `hr_test_`.

### 10.1 Outbound webhooks

- **Subscription model (reused):** `WebhookSubscription { businessId, url, events[], secret, isActive }`; `WebhookDelivery` with status + retries. `emit(event, payload, businessId)` / `safeEmit()` from HR controllers.
- **Signing (reused):** HMAC-SHA256 envelope (`signWebhookEnvelope(secret, body, timestamp)`); receivers verify signature + timestamp (replay window). Header: `X-HR-Signature: t=<ts>,v1=<hmac>`.
- **Retries (reused):** `MAX_ATTEMPTS=5`, backoff `[1,5,15,60,240]` min; `dispatchPendingRetries()` cron. Admin can **replay** any delivery (`/webhooks/deliveries/:id/replay`) and **test** a subscription (`/webhooks/:id/test`).
- **HR event catalogue (v1):**

| Event | Fires when |
|---|---|
| `employee.created` / `employee.updated` / `employee.terminated` | Lifecycle change |
| `payrun.finalised` | Payrun locked (triggers downstream accounting/disbursement internally too) |
| `payslip.published` | Payslip available to employee |
| `leave.requested` / `leave.approved` / `leave.rejected` | Leave workflow |
| `attendance.regularised` | Manual correction approved |
| `disbursement.completed` / `disbursement.failed` | Bank reconciliation result |
| `filing.accepted` / `filing.rejected` | Statutory filing outcome (IRD/EPFO/etc.) |
| `document.issued` | Form 130/16, payslip PDF generated |

- **Delivery guarantees:** at-least-once; receivers must be idempotent on `delivery.id`. Per-tenant rate cap; auto-disable a subscription after N consecutive hard failures with a notification.

### 10.2 Public REST API

- **Auth (reused):** `Authorization: Bearer hr_live_<...>`; SHA-256 hashed key lookup; scopes `{read:[...], write:[...]}`; `requireScope('read','employees')`; `lastUsedAt` touch; timing-safe compare.
- **Posture:** **read-mostly in v1.** Writes limited to safe, well-bounded operations (create leave request, upsert employee from HRIS). No payroll-mutating writes via public API (payroll runs only through the controlled engine).
- **Resources (HR scope set, replacing Sitepresso's `appointments/products/...`):** `employees`, `departments`, `attendance`, `leave`, `payslips`, `payruns` (read), `documents`, `org`.
- **Versioning:** `/api/v1/...`; additive changes only within a major; breaking changes → `/v2` with deprecation window.
- **Rate limits:** per-key token bucket (e.g., 600 req/min, 100k/day default; plan-tiered). `429` with `Retry-After`. Reuse `abuse.middleware.js` for throttling.
- **Pagination/filtering:** cursor-based, `?limit&cursor`, `updatedSince` for sync. ETags on read.
- **Errors:** consistent `{ error, message, field? }` shape (reused from `apiKey.middleware.js`).
- **Tenant isolation:** every query scoped by `businessId` from the key (row-level isolation, reused base pattern). No cross-tenant access possible by construction.

### 10.3 No-code bridge

- Publish a thin **Zapier/Make** app over the public API + webhooks for tenants who want light automation **without** us becoming a builder (these are *our* fixed triggers/actions, configured by the tenant). v1.5.

---

## 11. Phasing Summary (v1 / v1.5 / Later)

| Integration | Mode | Market | Phase |
|---|---|---|---|
| Outbound webhooks + public read API | E | all | **v1** (reuse) |
| Email/SMS/WhatsApp notifications | A | all | **v1** (reuse) |
| Google SSO | A | all | **v1** (reuse) |
| Microsoft (Entra) SSO | A | all | **v1** |
| Xero (Accounting journals) | A | NZ/IN | **v1** |
| Zoho Books (journals) | A | IN/NZ | **v1** |
| IRD Payday Filing (gateway API + file fallback) | A/B | NZ | **v1** (flagship) |
| EPFO ECR (file+portal) | B | IN | **v1** |
| ESIC contribution (file+portal) | B | IN | **v1** |
| TDS Form 138 / Form 130 (FVU file) | B | IN | **v1** |
| Professional Tax (KA/MH first) | B | IN | **v1** |
| Bank disbursement IN (HDFC/ICICI/Axis/SBI/generic) | C | IN | **v1** (download) |
| Bank disbursement NZ (BNZ IB4B/ANZ/ASB/Westpac/Kiwibank/ABA) | C | NZ | **v1** (download) |
| Biometric ADMS push (ZKTeco/eSSL) | D | all | **v1** |
| Slack | A | all | **v1** |
| Tally importable XML | B | IN | **v1.5** |
| SAML 2.0 SSO | A | all | **v1.5** |
| Microsoft Teams | A | all | **v1.5** |
| Universal biometric gateway | D | all | **v1.5** |
| LWF state filings | B | IN | **v1.5** |
| H2H/SFTP bank transmission + return-file ingest | C | IN | **v2** |
| Zapier/Make app | E | all | **v1.5** |
| Tally Connector agent | A* | IN | Later |
| QuickBooks/MYOB | A | RoW/NZ | Later |
| SCIM provisioning | A | all | Later |
| ERI income-tax API (if we register) | A | IN | Later (licensing) |
| Apple SSO | A | all | Later |

---

## 12. Cross-cutting Risks & Edge Cases (consolidated)

- **Mode-B portal drift:** EPFO/ESIC/TRACES/PT formats change without notice. Mitigation: formats in versioned rule tables (Super Admin), golden-file regression tests, FVU validation gate, "format version" stamped on every artefact.
- **IRD DSP gating:** technical docs + certification are behind IRD's Gateway Customer Support Portal (registration since 1 Jul 2025). Mitigation: register early; build the **file-upload fallback** so NZ tenants are never blocked by API onboarding.
- **Bank format sprawl (IN):** each bank differs; new banks = new template. Mitigation: per-bank format definitions are data, not code; generic NEFT fallback always available.
- **Maker-checker bypass risk:** disbursement must never single-actor. Enforced in RBAC + state machine.
- **Half-paid payroll:** beneficiary validation blocks the whole file on any invalid line; rejects re-issued as a delta batch only.
- **Labour-Code wage redefinition (IN, 21 Nov 2025):** Basic+DA ≥ 50% cascades into PF/gratuity → ECR + disbursement must use the new wage base; we validate structures pre-generation.
- **Token expiry mid-payrun (Xero/Zoho):** refresh proactively before posting; on failure, queue and prompt reconnect — never lose the journal.
- **White-label SSO cookie origin:** the auth-code bridge is the linchpin; tested across custom domains.
- **Data residency:** IN vs NZ artefacts region-pinned; connectors must not cross regions.

---

## 13. Sources (2026-verified)

- IRD — Payday filing through gateway services; Payday Filing File Upload Specification 2026–2027; Payroll calculations & business rules; IRD-number validation upper-limit update (ird.govt.nz).
- KiwiSaver 2026 changes (3% → 3.5% from 1 Apr 2026; 16–17 eligibility; govt contribution 25c/$, max NZD 260.72; ACC earners' levy 1.75% to NZD 156,641; min wage NZD 23.95) — ird.govt.nz/kiwisaver-changes and NZ provider summaries.
- EPFO Online ECR / Challan + ECR file structure (epfindia.gov.in).
- India Professional Tax 2026 state slabs (Karnataka, Maharashtra) — multiple 2026 guides.
- TDS forms rename — Form 24Q → **138**, Form 16 → **130**, Form 16A → **131** under Income Tax Act 2025, effective TY 2026-27 (CompuTax / Saral / Shriram Life guides); quarterly due dates Q1 31 Jul / Q2 31 Oct / Q3 31 Jan / Q4 31 May.
- Xero Developer — Payroll NZ API overview, Accounting API, App Partner usage-based pricing (Mar 2026).
- Bank file formats — ICICI bulk transfers / PAB-SAL; HDFC bulk payment; BNZ IB4B file format guide; ANZ Transactive Global file formats; ABA 120-byte fixed-length spec.
- Biometric — ZKTeco/eSSL ADMS push protocol; Cams universal biometric gateway (Callback + REST APIs).

*All rates/thresholds above are mirrored in the versioned per-country compliance rule tables (Super Admin); the integration layer reads them and must never hardcode a statutory figure.*

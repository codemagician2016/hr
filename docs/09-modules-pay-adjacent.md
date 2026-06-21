# 09 — Pay-Adjacent Modules: Expenses & Reimbursements, Loans & Advances, Payslip Design, Assets

> **Author role:** Senior HR Domain Analyst (Comp & Benefits)
> **Status:** Production design spec — exhaustive, not an MVP outline.
> **Scope:** The four modules that orbit the payroll engine but are not the engine itself: (1) **Expenses & Reimbursements**, (2) **Loans & Advances**, (3) **Payslip design & delivery**, (4) **Assets / IT-asset lifecycle + offboarding clearance**.
> **Markets:** India (IN) and New Zealand (NZ). Currencies INR, NZD. Tax year Apr–Mar (both).
> **Cross-refs:** `04-payroll-engine-design.md` (component/formula model, pay-run state machine, FnF), `01-product-requirements.md`, `02-system-architecture.md`. Sibling docs referenced by filename inline: `08-modules-leave-attendance.md` (leave/clearance), `10-offboarding-fnf.md` (FnF settlement), `11-statutory-filings.md` (Form 16 / payday filing), `06-rbac-and-approvals.md` (approval engine).

---

## 0. Why these four modules live together

These modules are "pay-adjacent" because each one **either feeds a payroll component or shares the payroll approval/payout rails**, but none of them is the payroll calculation itself:

| Module | Feeds payroll as… | Shares with payroll… | Owns independently… |
|---|---|---|---|
| Expenses & Reimbursements | Optional `REIMBURSEMENT` earning line (non-taxable in IN/NZ when policy-compliant) | Approval engine, bank-advice payout file | Receipt store, OCR, policy limits, GL/cost-centre coding |
| Loans & Advances | Recurring `LOAN_EMI` / `ADVANCE_RECOVERY` deduction line; salary advance as off-cycle pay | Approval engine, perquisite calc (IN), ledger | Amortisation schedule, balance ledger, restructuring |
| Payslip | — (it is the **rendered output** of a finalised pay run) | Pay-run snapshot, statutory breakup, FX | Branded template, multi-currency, distribution & access log |
| Assets | — | Offboarding clearance gate (blocks FnF), recovery-on-loss deduction | Asset register, assign/return state machine, depreciation (optional) |

**Opinionated stance:** expenses and loans are *configured*, never *built*. Tenants pick from pre-built policy primitives (limits, categories, approval chains, payout method). There is no policy-rule "builder" — consistent with the platform's core principle. The expressive power lives in **typed configuration**, not in a scripting surface.

---

## 1. Reuse map (grounded in Sitepresso, READ-ONLY)

We fork concrete infrastructure rather than reinventing it. Real paths in `/Users/kp/sitepresso`:

| Need | Reuse | Real path |
|---|---|---|
| Receipt/file upload to object store (S3 / Cloudflare R2 compatible, presign-capable, graceful fallback) | `s3.js` helper + `upload.controller.js` | `backend/src/core/lib/s3.js`, `backend/src/core/controllers/upload.controller.js` |
| Multi-currency conversion (USD-pivot, ECB feed, 24h cache, zero-decimal set) for multi-currency payslips & foreign-currency expenses | `fx.js` | `backend/src/domains/fx.js` |
| Notifications (email/SMS, country routing) for claim/loan status, payslip-ready | notifications providers + country routing | `backend/src/core/lib/notifications/providers.js`, `backend/src/core/lib/notifications/countryRouting.js`, `backend/src/core/utils/email.js`, `backend/src/core/lib/emailEvents.js` |
| Row-level tenant isolation (`businessId`) + JWT/RBAC middleware | core middleware | `backend/src/core/middleware/` |
| Money/minor-unit + invoice counter patterns (we mirror `*Minor` integer money and per-tenant sequential counters for claim/loan IDs) | `InvoiceCounter`, `AdjustmentLedger`, `refundAmountMinor` patterns | `backend/prisma/schema.prisma` |
| Approval-status pattern (`approvalStatus` DRAFT/PENDING_APPROVAL/APPROVED/REJECTED, `approvalNote`) | existing schema convention | `backend/prisma/schema.prisma` |
| Admin shell, list/detail/filter primitives | `packages/admin-core` | `packages/admin-core` |
| Design system (tables, forms, status pills, currency input) | `packages/ui` | `packages/ui` |
| PDF/templated document rendering pattern (we mirror `AppointmentInvoice` / `AppointmentPrescription` doc generation for payslip PDFs) | booking doc models | `backend/prisma/schema.prisma` (`AppointmentInvoice`, `AppointmentDocument`) |

**New build** lives under `backend/src/hr/{expenses,loans,payslip,assets}/` and `apps/hr` (admin) + ESS app. Money is stored as **integer minor units** (`amountMinor`) with an explicit `currency` ISO-4217 code on every monetary row — same convention as Sitepresso billing (`*Minor` fields).

**Convention note (load-bearing):** the S3 helper currently accepts a base64 `dataUrl` and 20 MB cap (`backend/src/core/controllers/upload.controller.js`). For receipts we extend it with a **presigned-PUT** path (`s3.presignPut(key, contentType)`) so mobile clients stream multi-MB photos/PDFs directly to the bucket without round-tripping base64 through Node. This is an additive change; the existing inline-base64 fallback stays intact.

---

## 2. Cross-cutting primitives (used by all four modules)

### 2.1 Money
- `amountMinor: int` + `currency: char(3)`. Never floats. Display formatting via locale; storage is integer minor units (paise for INR, cents for NZD). Zero-decimal currencies handled per `fx.js` `ZERO_DECIMAL` set (not relevant to INR/NZD but inherited).
- **FX freeze rule:** any cross-currency conversion (e.g., an NZD receipt paid by an INR-base tenant) **snapshots the rate** (`fxRate`, `fxRateDate`, `fxSource`) onto the row at the moment of conversion. Subsequent rate moves never retroactively change an approved claim. Source is `fx.js` (Frankfurter/ECB, 24h cache).

### 2.2 Per-tenant human-readable IDs
Mirror `InvoiceCounter`: a `SequenceCounter(businessId, kind)` issues `EXP-2026-000142`, `LOAN-2026-0007`, `PS-2026-04-000931`, `AST-000455`. Atomic increment in a transaction. Never expose raw UUIDs to end users.

### 2.3 Approval engine (shared)
All approvals route through the **central approval engine** documented in `06-rbac-and-approvals.md`. Pay-adjacent modules **declare an approval policy**, they do not implement chains themselves. Contract:

```
ApprovalPolicy {
  id, businessId, module: 'EXPENSE'|'LOAN'|'ADVANCE'|'ASSET_WRITEOFF',
  scope: { costCentreIds?, departmentIds?, gradeIds?, locationIds? },   // null = tenant-wide default
  steps: ApprovalStep[],          // ordered
  slaHours: int,                  // per-step SLA → escalation
  autoApproveUnderMinor?: int,    // claims below this auto-approve (still ledgered)
  active: bool, effectiveFrom, effectiveTo
}
ApprovalStep {
  order, approverType: 'REPORTING_MANAGER'|'ROLE'|'SPECIFIC_USER'|'COST_CENTRE_OWNER'|'FINANCE',
  roleId?, userId?, condition?: ConditionExpr,   // typed, NOT free-form script
  thresholdMinor?: int,           // step only fires above threshold (slab approvals)
  quorum?: 'ANY'|'ALL'            // for multi-approver steps
}
```
`ConditionExpr` is a **typed, closed DSL** (field op value, AND/OR of a fixed field set: `amountMinor`, `categoryId`, `currency`, `daysSinceExpense`, `isForeignReceipt`, `hasReceipt`, `policyBreachFlags`). No eval, no scripting — keeps us on the "configure, not build" side.

### 2.4 Cost centre / GL coding
Every expense, loan disbursement and asset carries an optional `costCentreId` and `glCode`. These flow to the export feed for the tenant's accounting system (Tally/Zoho Books/Xero/MYOB). Defined in `12-integrations.md`; here we only guarantee the fields exist and are validated against the tenant's chart-of-accounts table.

### 2.5 Audit
Every state transition writes an immutable `AuditLog` row (`actorId`, `actorRole`, `action`, `entityType`, `entityId`, `beforeJson`, `afterJson`, `ip`, `ts`, `impersonatedBy?`) — same pattern Sitepresso uses for billing/pricing audit. Impersonation by super-admin is always stamped.

---

# PART A — Expenses & Reimbursements

## A1. Domain model

### A1.1 Entities

```
ExpenseCategory {
  id, businessId, code, name, glCode?, costCentreDefault?,
  taxTreatment: 'REIMBURSEMENT_NON_TAXABLE'|'ALLOWANCE_TAXABLE'|'PERQUISITE',
  receiptRequired: bool, receiptThresholdMinor?: int,   // receipt mandatory above X
  perDiem: bool, mileage: bool,
  limit: ExpensePolicyLimit?,                            // see A2
  requiresProjectCode: bool, active: bool,
  countryScope: 'ALL'|'IN'|'NZ'
}

ExpenseClaim {
  id, humanId,            // EXP-2026-000142
  businessId, employeeId,
  status,                 // state machine, §A4
  title, costCentreId?, projectCode?,
  currency,               // claim settlement currency = employee's pay currency
  totalAmountMinor,       // sum of approved lines
  submittedTotalMinor,    // sum of submitted lines
  approvedTotalMinor,
  payoutMethod: 'PAYROLL'|'OFFCYCLE_BANK'|'PETTY_CASH'|'CORPORATE_CARD_RECON',
  payrollRunId?,          // when settled via payroll
  bankAdviceId?,          // when settled off-cycle
  policyBreachFlags: string[],   // ['OVER_LIMIT','NO_RECEIPT','STALE','DUPLICATE_SUSPECT']
  approvalRequestId?,
  createdAt, submittedAt, approvedAt, paidAt, closedAt,
  reimbursedInPayslipId?
}

ExpenseLine {
  id, claimId,
  categoryId, expenseDate, merchant?, description,
  originalCurrency, originalAmountMinor,
  fxRate?, fxRateDate?, fxSource?,            // frozen if cross-currency
  amountMinor,                                // in claim currency
  taxComponentMinor?,                         // GST/GST-input (IN: CGST/SGST/IGST; NZ: GST 15%)
  gstin?, gstRate?,                           // IN input-credit capture
  mileageKm?, mileageRateMinor?,              // mileage lines
  perDiemDays?, perDiemRateMinor?,
  receiptIds: string[],                       // 0..n receipt docs
  ocrConfidence?, ocrExtractJson?,
  lineBreachFlags: string[],
  glCode?, costCentreId?, billableToClient: bool
}

Receipt {
  id, businessId, employeeId, claimId?, lineId?,
  storageKey,            // s3 key (s3.js)
  mime, sizeBytes, sha256,    // dedupe / tamper-detect
  ocrStatus: 'PENDING'|'DONE'|'FAILED'|'SKIPPED',
  ocrJson?,              // structured extraction
  uploadedAt
}
```

### A1.2 Why "claim → lines"
A claim is the **approval & payout unit**; lines are the **policy & GL unit**. One business trip = one claim with N lines (flights, hotel, meals, taxi). Approval is at the claim level (with line-level breach surfacing); GL posting and tax treatment are per line. This mirrors the order/order-item split already in Sitepresso (`Order`/`OrderItem`).

## A2. Policy limits (typed, pre-built — not a builder)

```
ExpensePolicyLimit {
  id, businessId, categoryId,
  scope: { gradeIds?, departmentIds?, locationIds? },   // most specific wins
  periodicity: 'PER_CLAIM'|'PER_DAY'|'PER_TRIP'|'PER_MONTH'|'PER_QUARTER'|'PER_FY',
  capMinor: int, currency,
  enforcement: 'BLOCK'|'WARN_REQUIRE_APPROVAL'|'WARN_ONLY',
  perDiemRateMinor?, mileageRateMinor?,
  receiptThresholdMinor?,                  // receipt mandatory above
  requiresJustificationAboveMinor?,
  effectiveFrom, effectiveTo
}
```

**Resolution order** (deterministic): location-grade-department override → grade override → department override → category default → tenant default. First match wins (no merging — predictable). The resolver is pure and unit-tested with a fixture matrix.

**Mileage defaults we ship (tenant-overridable, with effective dates):**
- **NZ:** IRD kilometre rates apply to reimbursements made **on or after 4 June 2026** (Tier 1 / Tier 2 two-tier scheme). We seed the published 2026 rates into the country rule table and stamp `effectiveFrom = 2026-06-04`; tenants reimbursing at or below the IRD rate get tax-free treatment automatically. ([IRD/Deloitte 2026 rates](https://www.deloitte.com/nz/en/services/tax/perspectives/inland-revenue-2026-rates.html))
- **IN:** no statutory mileage rate; tenant sets a flat per-km rate. Default seed ₹/km is a tenant config with no statutory backing (we label it "company policy, not statutory").

## A3. Receipt OCR pipeline

**Goal:** auto-fill `merchant`, `expenseDate`, `originalAmountMinor`, `taxComponentMinor`, `gstin`/`gstRate` (IN), and GST (NZ), then let the employee confirm. OCR **never auto-submits**; it pre-fills, the human confirms. This is a deliberate liability boundary.

### A3.1 Flow
1. Mobile/web client requests `POST /ess/receipts/presign` → `{ uploadUrl, storageKey }` (extends `s3.js` with `presignPut`).
2. Client PUTs the image/PDF directly to the bucket; then `POST /ess/receipts` with `storageKey`, `mime`, `sizeBytes`, client-computed `sha256`.
3. Server verifies object exists, recomputes `sha256` (tamper/dedup), enqueues `ocr.extract` job (Redis/BullMQ — same scheduler infra as `backend/src/core/lib/scheduler.js`).
4. OCR worker calls the configured OCR provider (pluggable: AWS Textract / Google Document AI / Azure; default region-aware — IN tenants default to a provider with India data residency where required). Returns structured fields + per-field confidence.
5. Worker writes `ocrJson`, sets `ocrStatus=DONE`, normalises currency, attempts category suggestion (merchant→category map + MCC heuristics), pushes a notification (`emailEvents.js` pattern) and a realtime update to the open claim.
6. Employee reviews; low-confidence fields (`< 0.80`) are highlighted and must be touched before submit.

### A3.2 Duplicate / fraud heuristics (write `policyBreachFlags`)
- **`DUPLICATE_SUSPECT`:** same `sha256` of receipt already attached to another line; OR (same `merchant` + `amountMinor` + `expenseDate`) within tenant across any employee.
- **`STALE`:** `expenseDate` older than tenant's `maxClaimAgeDays` (default 90; configurable). Past cutoff → block submit unless manager override.
- **`AMOUNT_MISMATCH`:** OCR amount differs from entered amount by > 2% → warn.
- **`WEEKEND/HOLIDAY` flag** for categories where that's implausible (informational).
- **`ROUND_NUMBER` anomaly** (e.g., exactly ₹5,000.00 with no receipt) → soft flag.

### A3.3 Edge cases
- Multi-page PDF receipt → OCR first page, store all; amount from "total" detection.
- Foreign-currency receipt → store `originalCurrency`; conversion to claim currency at submit using frozen FX (`fx.js`).
- Corrupt/blank image → `ocrStatus=FAILED`, line still submittable manually, flagged `OCR_FAILED` (non-blocking).
- Receipt deleted after OCR → soft-delete; `sha256` retained for dedupe history.

## A4. Expense claim state machine

```
                         submit                 approve (all steps)
  DRAFT ───────────────────────────► SUBMITTED ──────────────────► APPROVED
   ▲  │                                   │   │                        │
   │  │ saveDraft                  recall │   │ reject                 │ schedulePayout
   │  └─────────(stay)                    ▼   ▼                        ▼
   └──────────────────────────────── RECALLED  REJECTED          PENDING_PAYOUT
                  (back to DRAFT)                                       │
                                                          paid via payroll/bank
                                                                       ▼
                                                                     PAID ──► CLOSED
                                                                       │
                                                              clawback/dispute
                                                                       ▼
                                                                   REOPENED
```

### A4.1 States
| State | Meaning | Who acts |
|---|---|---|
| `DRAFT` | Being assembled; lines editable | Employee |
| `SUBMITTED` | Awaiting approval; locked to employee except recall | Approver(s) |
| `RECALLED` | Employee pulled it back before first approval | Employee → DRAFT |
| `APPROVED` | All approval steps passed; amount frozen | System |
| `REJECTED` | An approver rejected (reason mandatory) | Employee may clone to new DRAFT |
| `PENDING_PAYOUT` | Queued to a payroll run or off-cycle bank batch | Finance/payroll |
| `PAID` | Disbursed (payroll finalised or bank advice executed) | System |
| `CLOSED` | Reconciled; terminal | System |
| `REOPENED` | Post-payment dispute/clawback | Finance |

### A4.2 Guarded transitions (selected)
- `submit`: requires ≥1 line; every line passes `receiptRequired`/`receiptThreshold`; `BLOCK`-level breaches absent; `STALE` resolved.
- `approve`: only the current step's eligible approver; quorum satisfied; **amount cannot be edited up by approver** (down-adjust allowed with note → recalculates `approvedTotalMinor`).
- `schedulePayout`: chooses `PAYROLL` (next open run for the employee's pay group) or `OFFCYCLE_BANK`. If payroll: appends a `REIMBURSEMENT` earning line to that run (see A5). Locked once run hits `VALIDATED` (per `04-payroll-engine-design.md` §5).
- `markPaid`: only by payroll-finalise event or confirmed bank-advice settlement.

### A4.3 Concurrency & idempotency
Approval actions are idempotent on `(claimId, stepOrder, approverId)`. A claim scheduled into a run carries `payrollRunId`; if that run is rolled back (`04-...` re-run safety), the claim reverts `PENDING_PAYOUT` automatically via the run's reversal hook.

## A5. Payout: via payroll vs. separate

| Method | When chosen | Mechanics | Statutory note |
|---|---|---|---|
| **PAYROLL** | Default for salaried; consolidates payout, one bank file | Approved claim total injected as a `REIMBURSEMENT` earning component into the employee's next open run for their pay group. Appears on payslip as a **non-taxable reimbursement line** (separate from taxable earnings). | **IN:** genuine reimbursement against bills is not "wages" and not part of CTC for PF/ESI/gratuity, **provided** it is actual-expense reimbursement with proof (not a fixed taxable allowance). NZ: tax-free reimbursing allowance when ≤ actual cost. |
| **OFFCYCLE_BANK** | Urgent / contractor / when claim shouldn't wait for run | Generates its own bank-advice batch (reuses payroll bank-advice writer, `04-...` §13) outside the salary run. | Same tax treatment; payslip annotation references the off-cycle reference, not the monthly payslip. |
| **PETTY_CASH** | Small cash offices | Marks paid manually with cash voucher ref; no bank file. | Recorded for register/audit. |
| **CORPORATE_CARD_RECON** | Card-paid expenses | No disbursement to employee; claim **reconciles** against the corporate-card statement line; nets to zero to employee. | Prevents double payment. |

**Critical IN rule (cascades from `04-payroll-engine-design.md` §8.1):** reimbursements must **not** be folded into the "wages" base. Under the Labour Codes uniform wages definition (live 21 Nov 2025), Basic+DA must be ≥ 50% of total remuneration; a tenant trying to disguise salary as "reimbursement" to dodge PF is a compliance risk. We therefore:
- Tag every reimbursement category `REIMBURSEMENT_NON_TAXABLE` only when `receiptRequired=true`.
- Surface an **anomaly** in the payroll VALIDATED gate if an employee's monthly reimbursements exceed a configurable % of gross (default 20%) — flagged to Finance as possible mis-classification. ([Labour Code payslip rules](https://www.patronaccounting.com/blog/payslip-labour-code-2025-mandatory-components-digital-issuance))

## A6. Expense API surface (`backend/src/hr/expenses/`)

**ESS (employee):**
```
POST   /ess/receipts/presign            → { uploadUrl, storageKey }
POST   /ess/receipts                    → create Receipt (triggers OCR)
GET    /ess/receipts/:id                → OCR status/result
POST   /ess/expense-claims              → create DRAFT
PATCH  /ess/expense-claims/:id          → edit DRAFT (title/cc/project)
POST   /ess/expense-claims/:id/lines    → add line (OCR prefill via receiptId)
PATCH  /ess/expense-claims/:id/lines/:lineId
DELETE /ess/expense-claims/:id/lines/:lineId
POST   /ess/expense-claims/:id/submit   → DRAFT→SUBMITTED (runs policy engine)
POST   /ess/expense-claims/:id/recall   → SUBMITTED→RECALLED
GET    /ess/expense-claims              → list (filter status/date)
GET    /ess/expense-claims/:id          → detail + timeline + audit
```
**HR/Finance (admin):**
```
GET    /hr/expense-claims                          → queue (filters: status, cc, breach)
POST   /hr/expense-claims/:id/approve              → with optional line down-adjust
POST   /hr/expense-claims/:id/reject               → reason required
POST   /hr/expense-claims/:id/schedule-payout      → method=PAYROLL|OFFCYCLE_BANK|...
POST   /hr/expense-claims/:id/reopen
GET    /hr/expense-categories  POST/PATCH          → config
GET    /hr/expense-policy-limits POST/PATCH        → config
GET    /hr/expenses/export?period=&format=tally|zoho|xero|myob|csv
```
**Validation rules (server, authoritative — client mirrors for UX):** currency must equal employee pay currency for PAYROLL payout; `expenseDate ≤ today`; `amountMinor > 0`; receipt presence per category; FX freeze on cross-currency; idempotency-key header on all mutating POSTs.

## A7. Screens (expenses)
- **ESS:** "My Expenses" list (status pills), "New Claim" wizard (snap receipt → OCR prefill → add lines → review breaches → submit), claim detail with approval timeline, "Reimbursements on payslip" cross-link.
- **HR/Finance:** approval queue (bulk approve under threshold), claim detail with line GL coding, policy-limit config grid, category config, export console, anomaly dashboard.
- **Manager:** "Pending my approval" (mobile-first; approve/reject with note; see policy breaches inline).

---

# PART B — Loans & Advances

## B1. Concepts & taxonomy

| Type | Definition | Recovery | Interest | IN tax angle |
|---|---|---|---|---|
| **Salary Advance** | Pre-payment of upcoming salary | Recovered in 1–3 upcoming runs | Usually 0% | Advance ≤ ₹2,00,000 aggregate → **nil perquisite** |
| **Loan (EMI)** | Lump sum repaid over months via EMI | Amortised over N months in payroll | 0% / concessional / market | Perquisite if interest-free/concessional **and** aggregate > ₹2,00,000 |
| **Festival/Emergency Advance** | Special-purpose advance | Lump or short EMI | Typically 0% | As above |

**Critical IN compliance fact (verified, 2026):** Under the **Draft Income-tax Rules, 2026 (Rule 15(5)(a), Table IV)** the perquisite value of an interest-free/concessional employer loan is computed using the **SBI lending rate as on the first day of the tax year (1 April)** for a loan of the same purpose, applied to the **maximum monthly outstanding balance**, **less** any interest the employee actually paid. Two exemptions: **(a) aggregate loan ≤ ₹2,00,000 → nil**, and **(b) loan for medical treatment of diseases specified in Rule 18 → nil**. ([Taxscan — SBI rate method](https://www.taxscan.in/top-stories/employer-loan-tax-rule-in-income-tax-rules-draft-2026-sbi-rate-method-explained-1442868), [Income Tax India tool](https://incometaxindia.gov.in/Pages/tools/concessional-or-interest-free-loan.aspx))

> The draft rules carry forward the long-standing SBI-benchmark method (previously Rule 3) into the Income-tax Act 2025 framework. We treat the **SBI rate and the ₹2,00,000 threshold as versioned, effective-dated entries in the IN country rule table** (per `04-payroll-engine-design.md` §10), so a rate change on 1 April is a data change, not a code change. **Open question for founder:** lock the exact 1-Apr-2026 SBI benchmark rate value(s) per purpose into the rule table before first IN payroll run.

**NZ:** employer concessional loans are generally a **fringe benefit (FBT)**, not PAYE — out of payroll's PAYE path but in scope for FBT reporting. We compute and surface FBT-relevant loan benefit data for the tenant's FBT return; we do not file FBT in v1 (see `11-statutory-filings.md`).

## B2. Data model

```
LoanProduct {                                  // pre-built template a tenant enables
  id, businessId, code, name,
  kind: 'ADVANCE'|'LOAN',
  maxPrincipalMinor, maxTenureMonths,
  interestModel: 'ZERO'|'FLAT'|'REDUCING'|'MARKET_BENCHMARK',
  interestRateBps?,                            // basis points if FLAT/REDUCING
  eligibility: { minTenureMonths, gradeIds?, employmentTypes? },
  maxConcurrentLoans, maxOutstandingMultipleOfNetPay?,   // affordability guard
  requiresGuarantor: bool, active, countryScope
}

Loan {
  id, humanId,            // LOAN-2026-0007
  businessId, employeeId, loanProductId,
  kind, currency,
  principalMinor,
  interestModel, interestRateBps,
  tenureMonths, emiMinor,                      // computed
  startPayPeriod,                              // first run that deducts
  status,                                      // state machine §B4
  outstandingPrincipalMinor,                   // live ledger balance
  outstandingInterestMinor,
  perquisiteMethod?: 'IN_SBI'|'NZ_FBT'|'NONE',
  disbursementMethod: 'PAYROLL_OFFCYCLE'|'BANK'|'NETTED',
  disbursedAt?, closedAt?,
  approvalRequestId?,
  reason?, purposeCode?                        // affects IN perquisite purpose lookup
}

LoanSchedule {                                  // immutable amortisation plan (regeneratable on restructure)
  id, loanId, installmentNo, dueePayPeriod,
  openingPrincipalMinor, principalComponentMinor,
  interestComponentMinor, emiMinor,
  closingPrincipalMinor, status: 'SCHEDULED'|'DEDUCTED'|'SKIPPED'|'PARTIAL'|'WAIVED'|'PREPAID'
}

LoanLedgerEntry {                               // append-only truth
  id, loanId, ts, payrollRunId?, type,        // DISBURSE|EMI_DEDUCT|PREPAY|WAIVE|INTEREST_ACCRUE|PERQUISITE|RESTRUCTURE|WRITE_OFF|REVERSAL
  amountMinor, balanceAfterMinor, note, actorId
}
```

**Amortisation math:**
- `REDUCING`: standard EMI = `P·r·(1+r)^n / ((1+r)^n − 1)`, `r = annualBps/12/10000`. Last installment absorbs rounding residue so `Σprincipal = P` exactly (integer-minor reconciliation; mirrors payroll rounding policy `04-...` §7).
- `FLAT`: `totalInterest = P·rateBps·tenureMonths/12/10000`; `emi = (P + totalInterest)/n`, residue on last.
- `ZERO`: `emi = P/n`, residue on last.

## B3. Affordability & eligibility validation (at request)
- `principalMinor ≤ product.maxPrincipalMinor`.
- `emiMinor ≤ affordabilityCapPct × employee.netPayMinor` (default 50% — prevents net pay going negative; **hard floor: post-all-deductions net ≥ minimum-wage-equivalent / never < 0**; cross-checked at every run by the payroll deduction-ceiling guard in `04-...`).
- `count(active loans) < product.maxConcurrentLoans`.
- tenure ≤ `min(product.maxTenureMonths, monthsRemainingIfFixedTerm, monthsToRetirement)`.
- guarantor present if required.
- **IN:** if interest-free/concessional and projected aggregate outstanding > ₹2,00,000 → mark `perquisiteMethod=IN_SBI` and warn employee that a taxable perquisite will accrue.

## B4. Loan state machine

```
  REQUESTED ──approve──► APPROVED ──disburse──► ACTIVE ──(all EMIs)──► CLOSED
      │                     │                     │  ▲                    
      │reject               │cancel               │  │ resume             
      ▼                     ▼                      ▼  │                    
  REJECTED              CANCELLED              ON_HOLD (LOP / leave / pause)
                                                   │                       
                                          restructure│   prepay-in-full     
                                                   ▼  └─────► CLOSED        
                                              RESTRUCTURED                  
                                                                            
  ACTIVE ──default/exit──► WRITE_OFF_PENDING ──approve──► WRITTEN_OFF       
```

| State | Notes |
|---|---|
| `REQUESTED` | Employee submitted; affordability validated |
| `APPROVED` | Approval chain cleared; schedule generated |
| `ACTIVE` | Disbursed; EMIs deduct each run |
| `ON_HOLD` | EMI paused (e.g., unpaid leave / LOP month) — tenure auto-extends or balloon, per product policy |
| `RESTRUCTURED` | New schedule generated; old schedule entries closed, ledger keeps history |
| `CLOSED` | Outstanding = 0 (natural completion or prepayment) |
| `WRITE_OFF_PENDING` → `WRITTEN_OFF` | On exit with residual balance; routes to FnF clawback first (`10-offboarding-fnf.md`) |

## B5. Auto-EMI deduction inside payroll (the integration that matters)

**Contract with the payroll engine (`04-payroll-engine-design.md`):**
1. Payroll run enters `CALCULATING`. For each employee, the engine calls `loans.getDueDeductions(employeeId, payPeriod)`.
2. We return ordered deduction lines: `[{ loanId, component:'LOAN_EMI', amountMinor, scheduleInstallmentNo }]`, already split principal/interest for the payslip.
3. The engine places these **after statutory deductions** in the evaluation order (`04-...` §3.4) and applies the **net-pay floor guard**: if EMI would push net below floor, it deducts the **maximum affordable** and writes a `PARTIAL` schedule entry; the shortfall rolls forward (tenure extends) — never a negative net.
4. On run **finalise**, the engine fires `loans.onRunFinalised(runId)` → we write `EMI_DEDUCT` ledger entries, advance schedule `SCHEDULED→DEDUCTED`, recompute `outstandingPrincipalMinor`, and — for IN perquisite loans — compute that month's **perquisite accrual** on max outstanding balance and feed it back as a **notional taxable perquisite** into the TDS base of the *next* run (since the EMI/balance for the current month is only known post-finalise).
5. On run **rollback/reversal**, `loans.onRunReversed(runId)` reverses those ledger entries idempotently (matched on `payrollRunId`).

**IN perquisite accrual detail:** monthly perquisite = `maxOutstandingThisMonth × (SBI_rate − employeeInterestRate)/12` (if employer rate is concessional). Accrued into a `PERQUISITE_LOAN_INTEREST` earning that is **taxable but not paid** — it inflates the TDS computation only, exactly like other notional perquisites. Versioned SBI rate from the IN rule table (effective-dated 1 Apr). Nil if aggregate ≤ ₹2,00,000 or medical (Rule 18).

**Salary advance recovery:** an advance disbursed off-cycle creates an `ADVANCE_RECOVERY` deduction over `recoveryMonths` (default 1). Same mechanics, no interest, no perquisite (almost always ≤ ₹2,00,000).

## B6. Prepayment, restructuring, exit
- **Prepay (partial):** reduces principal; **re-amortise** keeping EMI (shorter tenure) or keeping tenure (lower EMI) — employee choice within product policy. New `LoanSchedule` generated; ledger `PREPAY` entry.
- **Prepay (full):** computes payoff = `outstandingPrincipal + accruedInterest`; on settlement → `CLOSED`.
- **Restructure:** changes tenure/rate (e.g., promotion → higher EMI capacity). Requires re-approval. Old schedule rows → terminal; new plan from current period.
- **Exit / offboarding:** on initiation, `loans.getResidualForFnF(employeeId)` returns `outstandingPrincipal + accruedInterest + IN-perquisite-to-date`. FnF (`10-offboarding-fnf.md`) attempts full recovery from final settlement; shortfall → `WRITE_OFF_PENDING` (needs Finance approval) and may become a recoverable receivable.

## B7. Loans API surface (`backend/src/hr/loans/`)
```
# ESS
POST /ess/loans/eligibility            → simulate (product, principal, tenure) → emi, perquisite preview
POST /ess/loans                        → REQUESTED
GET  /ess/loans                        → my loans + live balance + schedule
GET  /ess/loans/:id/schedule           → amortisation
POST /ess/loans/:id/prepay/simulate
POST /ess/loans/:id/prepay
# HR/Finance
GET  /hr/loans                         → portfolio (filters: status, product, outstanding)
POST /hr/loans/:id/approve | /reject | /cancel
POST /hr/loans/:id/disburse            → method=PAYROLL_OFFCYCLE|BANK|NETTED
POST /hr/loans/:id/hold | /resume
POST /hr/loans/:id/restructure
POST /hr/loans/:id/write-off           → approval-gated
GET  /hr/loan-products POST/PATCH      → config
# Engine-internal (server-to-server)
GET  /internal/loans/due?employeeId=&payPeriod=
POST /internal/loans/run-finalised     { runId }
POST /internal/loans/run-reversed      { runId }
```

## B8. Edge cases (loans)
- Employee on LOP entire month → EMI can't deduct → `ON_HOLD` for that period; tenure extends; perquisite still accrues on outstanding (IN).
- Mid-loan currency change (transfer IN↔NZ) → not supported; loan must close and re-issue (different statutory regime). Hard block with guidance.
- Two loans, combined EMI breaches net floor → engine deducts in **product-defined priority order**, partials the lowest-priority.
- Interest-free loan crosses ₹2,00,000 mid-tenure → perquisite begins the month aggregate first exceeds threshold (engine re-evaluates monthly).
- Loan disbursed but employee resigns before first EMI → straight to FnF recovery.

---

# PART C — Payslip Design

## C1. Principles
- A payslip is a **rendered snapshot of a finalised pay run**, not a live computation. Once a run is `FINALISED` (`04-...` §5), each employee's payslip is **frozen** — re-rendering yields byte-identical content (deterministic template + frozen data). Corrections happen via the run's correction/off-cycle mechanism, never by mutating a payslip.
- **White-label, within guardrails:** logo, ONE brand color, ONE of ~5 fixed styles, tenant legal name/address/registration numbers. No layout builder (core principle). The 5 styles are pre-built React/PDF templates in `packages/ui` (reuse `theme-engine` slimmed to 5).
- **Statutory completeness is non-negotiable.** The template enforces presence of every legally mandated field per country; missing data blocks finalisation, not just rendering.

## C2. Payslip data model
```
Payslip {
  id, humanId,                 // PS-2026-04-000931
  businessId, employeeId, payrollRunId,
  payPeriodStart, payPeriodEnd, payDate,
  currency, fxDisplayCurrency?, fxRate?, fxRateDate?,   // optional second-currency view
  country: 'IN'|'NZ',
  snapshotJson,                // full frozen calc (earnings, deductions, employer contribs, statutory)
  ytdJson,                     // year-to-date aggregates (tax-year Apr–Mar)
  pdfStorageKey,               // rendered PDF in object store (s3.js)
  templateStyle: 1..5, brandColor, logoKey,
  status: 'GENERATED'|'PUBLISHED'|'VIEWED'|'CORRECTED'|'SUPERSEDED',
  publishedAt?, firstViewedAt?,
  accessLog: PayslipAccess[],  // who viewed/downloaded, when, IP
  hash                         // sha256 of snapshotJson for tamper-evidence
}
```

## C3. Mandatory content

### C3.1 Common
Employer (legal name, address, logo, registration); employee (name, code, designation, department, location, **bank a/c masked**, join date); pay period & pay date; pay frequency; days worked / LOP days / leave taken; **earnings table**; **deductions table**; **employer contributions** (informational); **net pay** in words + figures; **YTD** block; payslip ID + generation timestamp + tamper hash.

### C3.2 India (statutory — Labour Codes 2025, verified)
Every payslip **must** show, each separately identified: employee **PAN**, **UAN** (PF), **ESIC IP number**; pay period; **Basic + DA labelled as "wages"** (so the ≥50% rule is visible); **HRA** and each allowance; deductions — **EPF (employee 12%)**, **ESI (employee 0.75%)** if gross ≤ ₹21,000, **Professional Tax** (state slab, capped ₹2,500/yr), **TDS**; **gross**, **total deductions**, **net pay**; and **employer contributions** — employer EPF (split EPS 8.33% capped at ₹15,000 wage / EPF 3.67% / EDLI / admin charges) and employer ESI 3.25%. ([Labour Code payslip components](https://www.patronaccounting.com/blog/payslip-labour-code-2025-mandatory-components-digital-issuance), [salary payment rules 2025](https://www.mewurk.com/blog/salary-payment-rules-in-india-what-every-employer-must-know-in-2025)) Payslips must be **issued and archived digitally**; the digital wage register/payslip is mandatory under the Code on Wages.

### C3.3 New Zealand (statutory)
Gross earnings; **PAYE**; **ACC earners' levy** (1.75% on income up to $156,641 from 1 Apr 2026); **KiwiSaver employee deduction** (default min 3.5% from 1 Apr 2026) and **employer KiwiSaver contribution** + **ESCT** on it; **student loan** deduction if applicable; child support; **leave balances** (annual leave in **weeks** per Holidays Act 2003 — see `08-modules-leave-attendance.md`); net pay. Tax-free **reimbursing allowances** shown separately from gross (added to net, not taxed) per IRD. ([IRD reimbursing allowances](https://www.ird.govt.nz/employing-staff/deductions-from-other-payments/allowances/reimbursing-allowances))

> Figures (KiwiSaver 3.5%, ACC 1.75%/$156,641, min wage $23.95/hr) are versioned in the NZ rule table effective **1 Apr 2026** per `04-payroll-engine-design.md` §10.1 — the payslip reads them from the run snapshot, never hard-codes them.

## C4. Multi-currency on payslips
- **Primary:** always the employee's **pay currency** (statutory deductions only make sense in pay currency). An IN employee's payslip is INR; an NZ employee's is NZD.
- **Optional secondary view** (`fxDisplayCurrency`): for an expat or a founder reviewing across markets, the payslip can show a parenthetical converted net (e.g., "Net ₹1,84,200 (≈ NZD 3,640 @ 0.0198 on 2026-04-30")). The FX rate is **frozen at generation** (`fx.js`), stamped, and clearly labelled "indicative, non-statutory". Statutory math never uses the secondary currency.
- A tenant operating both IN and NZ entities gets **two payslip templates** auto-selected by the employee's legal-entity country — same brand, country-correct statutory layout.

## C5. Generation, publishing, distribution
1. Run `FINALISED` → fan-out job per employee: build `snapshotJson` + `ytdJson` from the frozen run, render PDF via the selected `templateStyle` (server-side React→PDF), upload to bucket (`s3.js`), compute `hash`, set `GENERATED`.
2. **Publish** (HR action or auto-on-finalise per tenant setting): status `PUBLISHED`, notify employee (email + ESS push, reuse `emailEvents.js`/notifications). Email contains a **link to ESS**, never the PDF as attachment by default (security; tenant can opt into password-protected PDF attachment where the password is the employee's DOB/PAN-last-4 per policy).
3. Employee views in ESS → `VIEWED`, `firstViewedAt`, `accessLog` row.
4. **Correction:** a finalised run that needs fixing spawns a correction run; the new payslip `SUPERSEDES` the old (old marked `CORRECTED`/`SUPERSEDED`, both retained — audit/legal). Never silently overwrite.

## C6. Access control & retention
- Employee sees only their own payslips (row-level `employeeId` + JWT, reuse core middleware).
- HR/Finance see all within tenant; **super-admin impersonation** to view a payslip is logged with `impersonatedBy` (Sitepresso impersonation+audit pattern).
- **Retention:** IN registers/payslips and NZ records — **keep ≥ 7 years** (NZ IRD record-keeping is 7 years; IN practical standard 7+). Payslips are immutable; deletion only via tenant-offboarding data lifecycle (`02-system-architecture.md`).

## C7. Payslip API surface (`backend/src/hr/payslip/`)
```
# ESS
GET  /ess/payslips                      → list (by tax year)
GET  /ess/payslips/:id                  → metadata + signed PDF URL (short-TTL presigned)
GET  /ess/payslips/:id/pdf              → 302 to presigned object URL; writes accessLog
# HR
POST /hr/payroll-runs/:runId/payslips/generate
POST /hr/payroll-runs/:runId/payslips/publish
GET  /hr/payslips?runId=&employeeId=&status=
GET  /hr/payslips/:id/access-log
POST /hr/payslips/:id/regenerate        → only if run not finalised; else correction flow
GET  /hr/payslips/verify/:hash          → tamper check (returns match/no-match)
```
**Validation:** generation blocked unless run `FINALISED`; every mandatory statutory field present (per-country validator) or generation fails loud with the missing-field list.

---

# PART D — Assets / IT-Asset Lifecycle

## D1. Why assets live in HR (and link to FnF)
Asset issuance/return is an HR-owned lifecycle because (a) it gates **offboarding clearance** — an employee with un-returned assets can't be cleared for FnF, and (b) unrecovered asset value can become a **payroll deduction** (recovery on loss/damage). The asset register also underpins audits and (optionally) depreciation for Finance.

## D2. Data model
```
Asset {
  id, humanId,            // AST-000455
  businessId, assetTag, category,   // LAPTOP|PHONE|MONITOR|ACCESS_CARD|SIM|FURNITURE|SOFTWARE_LICENCE|VEHICLE|OTHER
  make, model, serialNo?, imei?, macAddress?,
  purchaseDate?, purchaseCostMinor?, currency,
  depreciationMethod?: 'SLM'|'WDV'|'NONE', usefulLifeMonths?, residualMinor?,
  currentBookValueMinor?,           // computed
  status,                           // state machine §D3
  condition: 'NEW'|'GOOD'|'FAIR'|'POOR'|'DAMAGED'|'LOST',
  locationId?, costCentreId?, glCode?,
  warrantyExpiry?, notes
}

AssetAssignment {
  id, assetId, employeeId, businessId,
  assignedAt, assignedBy,
  acknowledgedAt?,                  // employee e-acceptance (handover note)
  expectedReturnAt?,                // for temporary issues
  returnedAt?, returnedCondition?,
  returnedToUserId?,
  status: 'ASSIGNED'|'ACK_PENDING'|'IN_USE'|'RETURN_REQUESTED'|'RETURNED'|'OVERDUE'|'LOST_DAMAGED',
  recoveryDeductionMinor?,          // if charged back via payroll
  recoveryLoanId?                   // if recovered via instalments
}

AssetClearanceItem {                // generated at offboarding
  id, offboardingId, assetId, assignmentId,
  required: bool, status: 'PENDING'|'RETURNED'|'WAIVED'|'CHARGED', resolvedBy?, resolvedAt?
}
```

## D3. Asset assignment state machine
```
  IN_STOCK ──assign──► ACK_PENDING ──employee acks──► IN_USE
     ▲                     │ (no ack in N days)          │
     │                     ▼                             │ return requested
     │                  (reminder/escalate)              ▼
     │                                            RETURN_REQUESTED
     │   returned & inspected (GOOD)                     │
     └──────────────────────────────────────────────────┤
                                                         │ returned DAMAGED/LOST
                                                         ▼
                                                  LOST_DAMAGED ──► recovery (payroll deduct or loan)
```
Overdue (past `expectedReturnAt`) → `OVERDUE`, reminders escalate to manager.

## D4. Assign / acknowledge / return flows
- **Assign:** HR/IT picks an `IN_STOCK` asset, assigns to employee, generates a **handover note** (templated PDF, reuse payslip render path) listing asset, serials, condition, value, employee responsibilities. Employee **e-acknowledges** in ESS (`acknowledgedAt`) — captured as consent (reuse `ConsentRecord` pattern from Sitepresso schema).
- **Return:** employee or IT initiates `RETURN_REQUESTED`; IT inspects, records `returnedCondition`. GOOD → `RETURNED`, asset → `IN_STOCK`/retired. DAMAGED/LOST → `LOST_DAMAGED` + recovery decision.
- **Recovery:** charge `recoveryDeductionMinor` (current book value or policy flat) either (a) one-shot payroll deduction (`ASSET_RECOVERY` component, subject to net-pay floor) or (b) instalments via a **Loan** record (reuses Part B). Recovery requires approval and respects the deduction-ceiling guard.

## D5. Offboarding clearance link (the high-value integration)
When offboarding is initiated (`10-offboarding-fnf.md`), the asset module is called: `assets.buildClearance(employeeId, offboardingId)` returns one `AssetClearanceItem` per active assignment. **FnF cannot reach `READY_TO_PAY` while any required clearance item is `PENDING`.** Resolution paths: returned (→inspected), waived (manager+Finance approval, reason logged), or charged (recovery deduction flows into the FnF run). This makes "did the employee return the laptop?" a **hard gate on the final paycheck**, which is exactly the control employers want.

## D6. Depreciation (optional, Finance-grade)
- SLM: `monthlyDep = (cost − residual)/usefulLifeMonths`. WDV: `bookValue ×= (1 − rate)` monthly.
- Recompute `currentBookValueMinor` on a monthly cron (reuse `backend/src/core/lib/scheduler.js` / `renewalCron.js` pattern). Drives loss-recovery valuation and an optional fixed-asset export to Finance. **Off by default** (most SMB tenants won't need it); enabled per plan feature flag.

## D7. Assets API surface (`backend/src/hr/assets/`)
```
# HR/IT
GET  /hr/assets  POST  /hr/assets  PATCH /hr/assets/:id
POST /hr/assets/:id/assign        { employeeId, expectedReturnAt? }
POST /hr/assets/:id/return        { condition, returnedToUserId }
POST /hr/assets/:id/mark-lost     { recoveryMethod }
POST /hr/asset-assignments/:id/recover   { method: PAYROLL_ONESHOT|LOAN, amountMinor }
GET  /hr/assets/export?format=csv|xero|tally
# ESS
GET  /ess/assets                  → my assigned assets
POST /ess/assets/:assignmentId/acknowledge
POST /ess/assets/:assignmentId/request-return
# Offboarding-internal
GET  /internal/assets/clearance?employeeId=&offboardingId=
```

---

## E. Plan / feature-flag gating (per `01-product-requirements.md`)
| Capability | Starter | Growth | Enterprise |
|---|---|---|---|
| Expenses (manual entry) | ✓ | ✓ | ✓ |
| Receipt OCR | — | ✓ | ✓ |
| Multi-level + conditional approvals | single step | 2-step | unlimited + slabs |
| Loans/Advances | advances only | + reducing-balance loans | + restructuring, perquisite engine |
| Multi-currency payslip secondary view | — | — | ✓ |
| Asset depreciation / fixed-asset export | — | — | ✓ |
| Accounting integrations (Tally/Xero/etc.) | CSV only | one connector | all connectors |

Gating reuses the plan/feature-flag mechanism from `apps/platform` + billing (`SITEPRESSO_BILLING_PLAN_V2.md` patterns).

## F. Notifications matrix (reuse `notifications/providers.js` + `countryRouting.js`)
| Event | Recipient | Channels |
|---|---|---|
| Claim submitted / approval pending | Approver | email + ESS push (+SMS opt) |
| Claim approved/rejected/paid | Employee | email + push |
| OCR done / failed | Employee | push |
| Loan approved / EMI deducted / loan closed | Employee | email + push |
| Perquisite accrual notice (IN) | Employee | email |
| Payslip published | Employee | email (ESS link) + push |
| Asset assigned (ack required) / return overdue | Employee + manager | email + push |
| Clearance pending blocking FnF | HR + manager | email |

## G. Consolidated validation rules (server-authoritative)
- All money positive integers in minor units; currency = employee pay currency for any payroll-routed payout.
- Idempotency-key required on every mutating POST (claim submit, approve, disburse, recover).
- FX frozen on conversion; never recomputed post-approval.
- Net-pay floor: no deduction (EMI, advance recovery, asset recovery) may drive net pay below the statutory floor / below zero — engine partials and rolls forward.
- IN perquisite: evaluate monthly on max outstanding; nil if ≤ ₹2,00,000 aggregate or medical (Rule 18).
- Payslip generation blocked unless run `FINALISED` and all country-mandatory fields present.
- Asset clearance `PENDING` hard-blocks FnF `READY_TO_PAY`.
- Reimbursement categories tagged non-taxable only when receipt-backed; >20%-of-gross reimbursement anomaly flagged to Finance (IN wage-disguise guard).

## H. Open questions for the founder
1. **IN SBI benchmark rate(s):** confirm and load the exact 1-Apr-2026 SBI lending rate(s) per loan purpose into the IN rule table before first IN payroll. (Draft Rules use SBI-as-on-1-April.)
2. **Form 16 vs "Form 130":** the founder's brief notes a possible rename under the Income-tax Act 2025 — payslip YTD must align with whatever annual certificate name is final; resolve in `11-statutory-filings.md`. **Verify before print.**
3. **Off-cycle reimbursement bank rails:** do we reuse the payroll bank-advice writer for standalone reimbursements, or integrate a payout API (RazorpayX / Wise) for instant reimbursement? Affects scope.
4. **Corporate-card feed:** in-scope for v1 (reconciliation) or v2? Drives the `CORPORATE_CARD_RECON` payout method maturity.
5. **FBT (NZ) for concessional loans:** v1 surfaces data only — confirm we are **not** filing FBT returns in v1.
6. **OCR provider & data residency:** confirm acceptable OCR vendor for IN data-residency constraints (Textract ap-south vs Document AI vs on-prem).
7. **Depreciation:** ship at all in v1, or pure register without book value?

## I. Risks
- **Mis-classification (IN):** tenants disguising salary as reimbursement to dodge PF under the new uniform-wages rule — mitigated by the >20% anomaly flag and receipt-required tagging, but ultimately a tenant compliance liability we must document, not just gate.
- **Perquisite drift:** SBI rate / ₹2,00,000 threshold are draft-rule values for 2026; if the final Income-tax Rules 2026 alter the method, our versioned rule table must be updated before year-end TDS truing-up, else under-withholding.
- **FX in payslips:** any non-statutory secondary-currency display must be unmistakably labelled "indicative" or it invites disputes; statutory math must remain single-currency.
- **Net-pay floor vs. loan recovery:** aggressive multi-loan tenants can create indefinite roll-forward; needs a max-tenure-extension cap and Finance alerting.
- **OCR over-trust:** auto-prefill must never auto-approve; the human-confirm boundary is a deliberate fraud/liability control and must not be "optimised away."
- **Offboarding deadlock:** asset clearance hard-gating FnF can trap a final paycheck if IT is slow; mitigate with the waive-with-approval path and SLA escalation.

---

## J. Sources (verified June 2026)
- India employer-loan perquisite — Draft Income-tax Rules 2026, SBI-rate method, ₹2,00,000 / Rule 18 exemptions: [Taxscan](https://www.taxscan.in/top-stories/employer-loan-tax-rule-in-income-tax-rules-draft-2026-sbi-rate-method-explained-1442868), [Income Tax India tool](https://incometaxindia.gov.in/Pages/tools/concessional-or-interest-free-loan.aspx), [ClearTax](https://cleartax.in/s/interest-free-employer-loan-taxability)
- India payslip statutory components / digital wage register (Labour Codes 2025): [Patron Accounting](https://www.patronaccounting.com/blog/payslip-labour-code-2025-mandatory-components-digital-issuance), [Mewurk salary payment rules 2025](https://www.mewurk.com/blog/salary-payment-rules-in-india-what-every-employer-must-know-in-2025)
- NZ reimbursing allowances (tax-free when ≤ actual cost; 7-year records; English): [IRD](https://www.ird.govt.nz/employing-staff/deductions-from-other-payments/allowances/reimbursing-allowances), [business.govt.nz](https://www.business.govt.nz/tax-and-money/paying-employees/employee-allowances)
- NZ 2026 kilometre/mileage rates (effective 4 June 2026): [Deloitte NZ](https://www.deloitte.com/nz/en/services/tax/perspectives/inland-revenue-2026-rates.html)
- Sitepresso reuse paths (read-only): `backend/src/core/lib/s3.js`, `backend/src/core/controllers/upload.controller.js`, `backend/src/domains/fx.js`, `backend/src/core/lib/notifications/{providers,countryRouting}.js`, `backend/src/core/utils/email.js`, `backend/src/core/lib/emailEvents.js`, `backend/prisma/schema.prisma`, `backend/src/core/lib/scheduler.js`, `packages/{ui,admin-core,theme-engine}`

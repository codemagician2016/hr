# 04 — Payroll Engine Design (Country-Agnostic Core + Pluggable Compliance)

> **Status:** Production design (v1). **Scope:** the calculation engine, the pay-run lifecycle, and the per-country compliance plug-in interface.
> **Author role:** Principal Payroll Systems Architect.
> **Stance for v1:** **Calculate-and-file-first.** The engine computes *every* number, produces *every* statutory file and *every* bank-advice file, and proves correctness — but **moves no money**. Disbursement is an *instruction artifact* (NEFT/bank-advice CSV, KiwiSaver/IRD files) handed to the employer, not an API call to a payment rail. This de-risks launch (no PSP licensing, no settlement liability) while delivering the hard, defensible value: provably-correct IN + NZ payroll.
> **Markets:** India (IN, INR) and New Zealand (NZ, NZD). Tax year **Apr–Mar in both**.
> **Sibling docs:** `01-architecture-and-multitenancy.md`, `02-data-model-hr-core.md`, `03-compliance-rule-tables.md`, `05-attendance-leave-and-holidays-act.md`, `06-ess-and-mobile.md`, `07-superadmin-and-billing.md`, `08-notifications-i18n-and-theming.md`. Cross-references below use these filenames.

---

## 0. Design tenets (opinionated, non-negotiable)

1. **The core knows no country.** The engine manipulates *components*, *amounts*, *bases*, and a *result graph*. It never hard-codes "EPF", "PAYE", "ESI", "KiwiSaver". Every statutory behaviour lives behind the `ComplianceModule` interface (§9) and a **versioned rule table** (§10) resolved by `(country, effectiveDate)`.
2. **Every number is explainable.** No figure exists without a trace: which component produced it, from which base, under which rule version, with which inputs. The `calc_explain` graph (§12) is a first-class output, persisted, immutable, and renderable to the employee, the HR admin, and an auditor. "Why is my PF ₹1,800?" must be answerable to the rupee, forever.
3. **Money is integer minor units.** All money is **64-bit integer** minor units (paise / NZ cents) + ISO-4217 `currencyCode`. **Never floats.** Rounding is an *explicit, named, per-jurisdiction policy* (§7), applied at declared points, logged in the trace.
   - **Type discipline — deliberate divergence from Sitepresso.** Sitepresso stores money as Prisma `Int` (32-bit; e.g. `AdjustmentLedger.amountMinor Int`, the `*Minor Int` convention throughout `backend/prisma/schema.prisma` — verified: there is **no** `BigInt` field in that schema). For *per-transaction* billing amounts `Int` is fine (max ≈ ₹2.14 crore / NZ$21.47M in minor units). For payroll it is **not**: a `YtdLedger` bucket aggregates annual gross/PF/PAYE across a full fiscal year and a large pay group, and an employer-level `aggregateForFiling` sum (e.g. monthly ECR total across thousands of employees) **overflows 32-bit signed at ≈ ₹2.14 cr**. Therefore all HR-payroll money columns are Prisma `BigInt` (Postgres `bigint`) and all in-engine arithmetic is JS `BigInt`. We reuse Sitepresso's *naming convention and rounding discipline*, **not** its column type. This is an intentional, documented departure — flagged so the data-model doc (`02-`) does not silently copy `Int`.
4. **Deterministic & idempotent.** A pay run is a pure function of `(frozen inputs snapshot, frozen rule-table versions, engine version)`. Re-running with the same triple yields byte-identical results. Re-runs are *safe by construction* (§11): inputs are content-hashed; compute is keyed by that hash; nothing external happens during compute.
5. **Inputs are snapshotted, not referenced.** At "freeze", the run copies every input it consumed (employee comp, attendance, leave, rule versions, FX if any) into an immutable snapshot. Later edits to master data **never** retro-alter a locked run. Corrections flow as **arrears/adjustments in a later run** (§6.4), never as silent mutation.
6. **The pay run is a state machine, not a script.** Transitions are guarded, audited, role-gated, and reversible only where law/accounting allows (§5). You cannot "disburse" before "approve"; you cannot "approve" with unresolved blocking anomalies.
7. **Compliance is data, owned by Super Admin.** Rates, slabs, thresholds, due dates are **rule-table rows** with effective dates and a version, edited only in Super Admin (`admin.hr.com`), versioned, audited, and published to tenants. Tenants *configure*, never *author* compliance (per the platform's "pre-built system, not a builder" principle). See `03-compliance-rule-tables.md`.
8. **Filing is an output abstraction.** Statutory returns (ECR, ESI contribution file, Form 24Q / Form 138-from-TY2026-27, EI dataset for IRD, KiwiSaver schedule) and bank advices are produced by **OutputGenerators** (§13) that consume the *same* locked result the payslip came from. The payslip an employee sees and the number on the ECR are the *same computed object* — they cannot diverge.

---

## 1. Where this sits in the platform (reuse map)

| Concern | Reuse from Sitepresso (READ-ONLY base at `/Users/kp/sitepresso`) | New in HR |
|---|---|---|
| Tenant isolation (row-level `businessId`) | `backend/src/core/middleware/requireBusiness.js`, `requireVertical.js`; every model carries `businessId` (`backend/prisma/schema.prisma`) | All payroll models carry `businessId`; `PayRun` scoped per tenant |
| Exactly-once external event ingest | `PaddleWebhookEvent` / `StripeWebhookEvent` / `RazorpayWebhookEvent` ledgers (`schema.prisma:1622–1690`) — dedup-on-id pattern | Reused verbatim for *inbound* filing ACKs and *outbound* file dispatch ledger |
| Atomic sequence numbering | `InvoiceCounter { series @id, lastValue }` (`schema.prisma:1877`) | `PayslipCounter`, `PayRunSequence`, statutory challan counters |
| Immutable money-event ledger | `AdjustmentLedger` (`schema.prisma:1883`) — append-only, `amountMinor`, `raw Json`, indexed `(businessId, createdAt)` | `PayrollLedger` (GL postings), `ArrearLedger` |
| Multi-currency money | `amountMinor Int` + currency convention across billing models; `backend/src/domains/fx.js` (Frankfurter/ECB feed) | Engine uses minor units; FX only for cross-currency *reporting*, never for in-country pay |
| Background jobs / cron | `backend/src/scheduler-worker.js`, `domains/renewalCron.js` | `payroll-worker` (compute, anomaly, file-gen jobs) |
| RBAC / auth | `backend/src/core/middleware/auth.middleware.js` (JWT) | Adds payroll roles: `PAYROLL_PREPARER`, `PAYROLL_APPROVER`, `PAYROLL_AUDITOR` |
| Admin shell | `packages/admin-core`, `packages/ui` | Tenant HR console (`apps/hr`), Super-Admin compliance editor |
| i18n | `backend/src/i18n/translator.js`, en/hi | Payslip + statutory copy localized (en, hi; NZ en) |
| Theming (slimmed to 5 styles) | `packages/theme-engine` | White-label payslip PDFs per tenant brand |

**Engine boundary:** the payroll engine is a backend package `backend/src/hr/payroll/` (pure-compute core) + `backend/src/hr/compliance/{in,nz}/` (country modules). The core has **zero** imports from country modules; country modules implement a published interface and are *registered*, not *imported by name*.

---

## 2. Domain vocabulary (precise definitions)

| Term | Definition |
|---|---|
| **Component** | An atomic, named, typed money-producing rule (e.g. `BASIC`, `HRA`, `EPF_EE`, `PAYE`, `FUEL_REIMB`). Has a `kind`, a `calcMethod`, and a `taxability/statutory` profile. The smallest explainable unit. |
| **Component instance** | A component *resolved for one employee in one period* → a concrete `amountMinor` plus its trace. |
| **Base** | A named, computed monetary aggregate used as input to other components (e.g. `PF_WAGES`, `ESI_GROSS`, `GROSS_EARNINGS_NZ`, `TAXABLE_INCOME`). Bases are derived, cached within a run, and themselves explainable. |
| **Earning** | Component that increases gross pay (BASIC, HRA, allowances, OT, bonus, arrears). |
| **Deduction** | Component that reduces net pay. Split into **statutory** (EPF_EE, ESI_EE, PT, TDS, PAYE, KiwiSaver_EE, StudentLoan) and **voluntary** (loan EMI, advance recovery, NPS, voluntary PF). |
| **Employer contribution** | Cost-to-company that is *not* paid to the employee but remitted on their behalf (EPF_ER, EPS, EDLI, ESI_ER, KiwiSaver_ER, ESCT, gratuity accrual). Appears on the CTC and the statutory remittance, never in net pay. |
| **Reimbursement** | Spend-against-claim money (fuel, telephone, LTA), often with tax-exemption rules and bill substantiation; flows through payroll but is *not* "wages" for most statutory bases. |
| **Net pay** | `Σ earnings − Σ employee deductions` for the period, in tenant base currency, integer minor units. |
| **Pay group** | A cohort sharing a pay frequency, pay calendar, country, and default component template (e.g. "IN-Monthly-Salaried", "NZ-Fortnightly-Waged"). |
| **Pay run** | One execution of payroll for one pay group × one pay period (or an off-cycle/FnF run). The unit the state machine governs. |
| **Pay period** | The worked interval `[periodStart, periodEnd]` a run pays for. **Pay date** is when employees are paid (may differ; NZ payday filing keys off pay date). |
| **LOP** | Loss of Pay — unpaid absence reducing payable days. |
| **Arrear / back-pay** | Money owed for a *prior* period, paid in a *current* run (revised CTC backdated, late join, correction). |
| **Off-cycle run** | A run outside the regular calendar (bonus, correction, FnF, mid-month advance settlement). |
| **FnF (Full & Final)** | Terminal settlement run for an exiting employee: final salary + leave encashment + gratuity + recoveries + notice adjustments. |

---

## 3. The component & formula model

### 3.1 Component definition (template, tenant-configurable within guardrails)

A `SalaryComponentDef` is **configured** by the tenant from a **catalog** the platform ships (the tenant cannot invent statutory components or alter their math — only choose, enable, and set rates/caps where the catalog permits). This honours "configure, don't build."

```jsonc
SalaryComponentDef {
  id              // uuid
  businessId      // tenant scope
  code            // stable machine key, e.g. "HRA", "EPF_EE" (unique per business+country)
  catalogKey      // references platform catalog entry; null for the few tenant-defined custom allowances
  country         // "IN" | "NZ" | null (country-agnostic, e.g. a generic allowance)
  name            // localized display
  kind            // EARNING | DEDUCTION_STATUTORY | DEDUCTION_VOLUNTARY |
                  // EMPLOYER_CONTRIBUTION | REIMBURSEMENT | INFORMATIONAL
  calcMethod      // FIXED | PERCENT_OF_BASE | SLAB | FORMULA_REF | ATTENDANCE_DRIVEN |
                  // STATUTORY (delegates entirely to ComplianceModule) | BALANCE_RECOVERY
  calcConfig      // JSON: { amountMinor } | { percent, ofBase, capMinor, floorMinor } |
                  //       { slabTableRef } | { formulaRef } | { recoveryPlanRef }
  prorationPolicy // PRORATE_CALENDAR_DAYS | PRORATE_WORKING_DAYS | PRORATE_30 | NEVER | FULL_IF_ANY_PAID_DAY
  lopBehavior     // REDUCES_WITH_LOP | FIXED_REGARDLESS | STATUTORY
  taxability      // FULLY_TAXABLE | EXEMPT | PARTIAL_EXEMPT(ruleRef) | PERQUISITE
  statutoryFlags  // bitset/array: { isPfWages, isEsiWages, isGratuityWages, isPtWages,
                  //   isNzGrossEarnings, isNzOrdinaryWeeklyPay, isPayeable, isReimbursement }
  ledgerAccount   // GL mapping (cost vs liability)
  displayOrder
  showOnPayslip   // bool
  effectiveFrom / effectiveTo   // component can be retired without deletion (audit)
  version
}
```

**Why `catalogKey` + `statutoryFlags` matter:** the **uniform "wages" definition** under the IN Labour Codes (2025) requires that statutory bases are computed from *flags*, not from component *names*. A tenant renaming "HRA" to "House Allowance" must not break PF math; the flag `isPfWages` (set by catalog, locked for statutory components) drives inclusion. See §8.1.

### 3.2 `calcMethod` semantics

| Method | Meaning | Example |
|---|---|---|
| `FIXED` | Constant minor-unit amount (subject to proration policy) | Special allowance ₹5,000 |
| `PERCENT_OF_BASE` | `round(percent × base, policy)`, clamped to `[floor, cap]` | HRA = 50% of BASIC; EPF_EE = 12% of `PF_WAGES` |
| `SLAB` | Piecewise function over a base via a referenced slab table | Professional Tax (state slab); NZ PAYE annualized |
| `FORMULA_REF` | Named pure function in a registry, given a typed context | Gratuity = `15/26 × lastDrawn × years` |
| `ATTENDANCE_DRIVEN` | Derived from attendance/leave inputs | Overtime = OT-hours × OT-rate; LOP deduction |
| `STATUTORY` | Fully delegated to the active `ComplianceModule`; engine supplies the base, module returns amount + sub-breakdown | TDS, ESI, EPF split, PAYE, KiwiSaver, ESCT |
| `BALANCE_RECOVERY` | Draws down a tracked balance (loan, advance) with schedule & cap | Salary advance recovery ₹10,000/month until cleared |

### 3.3 Bases (the dependency graph)

Bases are **declared**, **topologically ordered**, and **memoized per run**. The engine builds a DAG; cycles are a config error caught at validation. Country modules **declare which bases they need** and **may register new bases**.

Canonical bases:

| Base key | Definition | Used by |
|---|---|---|
| `GROSS_FIXED` | Σ earnings with `lopBehavior=FIXED_REGARDLESS`, pre-proration | sanity |
| `GROSS_EARNED` | Σ earnings after proration & LOP for the period | net pay, ESI gross (IN) |
| `PF_WAGES` (IN) | Σ components flagged `isPfWages` (≥ Basic+DA), apply ≥50%-of-total rule, ceiling logic | EPF, EPS, EDLI, admin |
| `ESI_GROSS` (IN) | Σ components flagged `isEsiWages` (now **Basic+DA** basis post-2025/26, verify §8.2) | ESI EE/ER |
| `PT_WAGES` (IN) | State-defined gross for Professional Tax | PT slab |
| `TAXABLE_INCOME` (IN) | Annualized projected taxable salary − std deduction − exemptions (regime-aware) | TDS |
| `NZ_GROSS_EARNINGS` | Holidays-Act "gross earnings" (taxable wages, OT, commission, most allowances; **excludes** discretionary bonuses, reimbursements, weekly ACC comp) | leave pay, BAPS |
| `NZ_ORDINARY_WEEKLY_PAY` | OWP per Holidays Act | annual-leave greater-of test |
| `NZ_PAYE_INCOME` | PAYE-able earnings for the pay period | PAYE, ACC levy |
| `NZ_KS_GROSS` | KiwiSaver-able gross | KiwiSaver EE/ER, ESCT |

> See `05-attendance-leave-and-holidays-act.md` for `NZ_GROSS_EARNINGS`, `OWP`, `RDP`/`ADP` derivations — the Holidays Act 2003 calculation is documented there in full and is **the** flagship NZ correctness feature. This doc consumes those bases; it does not re-derive them.

### 3.4 Evaluation order (within a run, per employee)

```
1. Resolve component set for employee (group template + employee overrides + active rule version)
2. Compute attendance-derived inputs (payable days, LOP days, OT, leave types)  ← from 05-attendance doc
3. Compute proration multipliers (per component policy)
4. Evaluate EARNINGS (topologically by base dependency)
5. Build statutory bases (PF_WAGES, ESI_GROSS, NZ_GROSS_EARNINGS, ...)
6. ComplianceModule.computeStatutory(bases, ytdState, ruleVersion) → statutory deductions + employer contributions + sub-breakdowns
7. Evaluate VOLUNTARY deductions & BALANCE_RECOVERY (respect net-pay floor / minimum-wage guard)
8. Evaluate REIMBURSEMENTS (claim-bounded)
9. Aggregate: GROSS_EARNED, total EE deductions, total ER contributions, NET_PAY
10. Apply jurisdiction rounding policy at declared points (§7)
11. Emit calc_explain graph (§12) + component instances + YTD deltas
```

Each step appends to the trace. Steps 4–9 are pure; step 6 is the only delegation point.

---

## 4. Pay groups, calendars, frequencies

```jsonc
PayGroup {
  id, businessId, country, name,
  currencyCode,                 // INR | NZD (must match country; no cross-currency pay)
  frequency,                    // MONTHLY | FORTNIGHTLY | WEEKLY | FOUR_WEEKLY
  payCalendarRef,               // schedule of (periodStart, periodEnd, payDate, cutoffDate)
  defaultComponentTemplateRef,
  workingDaysBasis,             // CALENDAR_DAYS | FIXED_26 | FIXED_30 | ACTUAL_WORKING_DAYS  (IN proration basis)
  fiscalYearStart,              // 04-01 (both markets)
  ptStateCode,                  // IN: drives PT slab; per work location
  esiApplicable, pfApplicable,  // IN toggles (employee-count thresholds, §8)
  ksDefaultRate,                // NZ default KiwiSaver EE rate
  cutoffPolicy                  // how mid-period joiners/leavers/attendance late-edits are handled
}
```

- **IN** is overwhelmingly **MONTHLY**. **NZ** is commonly **FORTNIGHTLY/WEEKLY** (and payday filing keys off each pay date).
- A tenant may run *multiple* pay groups (e.g. IN-salaried-monthly + NZ-waged-fortnightly) under one `businessId`. Each pay group → independent pay runs, independent compliance module selection by `country`.
- Pay calendars are generated a year ahead and editable (move pay date off weekends/public holidays). Cutoff date freezes attendance/leave inputs for the period.

---

## 5. Pay-run lifecycle state machine

### 5.1 States

```
DRAFT ──► INPUTS_OPEN ──► INPUTS_LOCKED ──► COMPUTED ──► VALIDATED ──► APPROVED ──► LOCKED ──► DISBURSEMENT_READY ──► PUBLISHED ──► FILED ──► CLOSED
   │            │                │              │            │             │           │                                                 │
   └─ CANCELLED ┘                └──────────────┴── REOPENED ◄────────────┘ (pre-LOCK only, audited)        ┌── REVERSED (post-LOCK, compensating run) ─┘
```

| State | Meaning | Allowed by | Key invariant |
|---|---|---|---|
| `DRAFT` | Run created for (group, period); nothing frozen | Preparer | mutable shell |
| `INPUTS_OPEN` | Collecting inputs: attendance, leave, one-time earnings/deductions, new joiners/leavers | Preparer | inputs editable |
| `INPUTS_LOCKED` | Cutoff reached; **inputs snapshot taken** (immutable copy + content hash) + **rule versions pinned** | Preparer | `inputHash` computed; no further input edits |
| `COMPUTED` | Engine ran; component instances + trace produced | system (worker) | result is pure fn of `inputHash` |
| `VALIDATED` | Anomaly/validation pass complete; blocking issues = 0 | system + Preparer (resolve warnings) | no `BLOCKER` anomalies open |
| `APPROVED` | Human approver signed off (dual-control optional) | **Approver** (≠ Preparer if 4-eyes on) | approval record w/ identity, time, totals hash |
| `LOCKED` | Financially frozen; payslip numbers immutable | Approver | totals immutable; YTD committed |
| `DISBURSEMENT_READY` | Bank-advice file(s) generated (no money moves) | system | file artifact stored + hashed |
| `PUBLISHED` | Payslips visible to employees (ESS) | Preparer/Approver | employee-visible == LOCKED numbers |
| `FILED` | Statutory files generated + (manually) submitted; ACKs recorded | Preparer/Auditor | filing artifacts + due-date tracking |
| `CLOSED` | Period fully reconciled; GL posted; archived | system | terminal |
| `CANCELLED` | Abandoned before LOCK | Approver | no YTD impact |
| `REOPENED` | Returned to `INPUTS_OPEN`/`COMPUTED` before LOCK | Approver | audited; invalidates prior compute |
| `REVERSED` | Post-LOCK correction via **compensating run** | Approver | original immutable; reversal references it |

### 5.2 Guarded transitions (selected)

| From → To | Guard / precondition | Side effects |
|---|---|---|
| `INPUTS_OPEN → INPUTS_LOCKED` | cutoff passed OR manual force; all blocking input validations pass (every active employee has comp + bank + valid statutory IDs *or* an accepted exception) | snapshot inputs; compute `inputHash = sha256(canonical(inputs ∪ ruleVersions ∪ engineVersion))`; pin `ComplianceRuleVersion` per country |
| `INPUTS_LOCKED → COMPUTED` | `inputHash` present; engine version recorded | enqueue compute job keyed by `inputHash` (idempotent); persist component instances + `calc_explain` |
| `COMPUTED → VALIDATED` | run anomaly suite (§8.5); 0 open `BLOCKER` | persist anomaly report; warnings may remain with acknowledgement |
| `VALIDATED → APPROVED` | approver identity ≠ preparer (if 4-eyes); approver re-confirms grand totals hash | write `Approval{by,at,totalsHash}` |
| `APPROVED → LOCKED` | approval valid; no rule-version drift since pin; **`payDate` still resolves to the pinned rule version (§11.2)**; **`DUP_PAYMENT` and `YTD_DRIFT` re-checked *inside the lock txn* — not just at VALIDATED, because a parallel run can lock in between (§11.1)** | take per-employee `YtdLedger … FOR UPDATE`; **commit YTD deltas**; allocate payslip numbers (atomic counter); freeze. If drift detected → abort, force recompute |
| `LOCKED → DISBURSEMENT_READY` | bank details present/validated per employee | generate bank-advice artifact(s); store + hash |
| `LOCKED → PUBLISHED` | LOCKED | render payslip PDFs; expose in ESS; notify (see `08-` notifications) |
| `* (pre-LOCK) → REOPENED` | approver action; reason mandatory | discard compute outputs (kept in history), return to editing |
| `LOCKED → REVERSED` | approver; reason; within open fiscal period | spawn `compensating run` that negates committed deltas; original untouched |
| `FILED → CLOSED` | all due filings generated; GL posted; reconciled | archive; lock period |

**Hard rules:**
- No transition skips. You cannot reach `APPROVED` from `COMPUTED`; validation is mandatory.
- **YTD is committed exactly at `LOCKED`** and nowhere else (single commit point → idempotency + audit simplicity).
- Post-`LOCKED` corrections are **always** compensating runs (negate + re-pay), never edits. This matches accrual accounting and statutory amendment semantics (revised 24Q, amended payday-filing).
- `inputHash` mismatch on re-compute ⇒ engine refuses to overwrite a `LOCKED` run (§11).

### 5.3 Run types overlay

The same machine governs all run types; `runType ∈ {REGULAR, OFF_CYCLE_BONUS, OFF_CYCLE_CORRECTION, ADVANCE, FNF, ARREAR_ONLY}`. Run type changes *which components are eligible* and *which YTD buckets accumulate*, not the state graph. FnF (§6.5) additionally requires terminal-state guards (no open run for that employee after FnF locks).

---

## 6. Proration, LOP, arrears, off-cycle, FnF

### 6.1 Proration

A component is prorated by its `prorationPolicy` against a **payable-days fraction** `f = payableDays / standardDays`.

- **IN choices** (set per pay group `workingDaysBasis`):
  - `FIXED_26`: standardDays = 26 (statutory/gratuity-aligned; common for waged).
  - `FIXED_30`: standardDays = 30 (common salaried convention).
  - `CALENDAR_DAYS`: standardDays = actual days in month (28–31).
  - `ACTUAL_WORKING_DAYS`: excludes weekly offs/holidays.
  - **Opinion:** default salaried IN to `CALENDAR_DAYS` (most defensible, matches "monthly salary ÷ days in month × payable days"); expose the choice but warn that `FIXED_30` over-pays in February and under-pays in 31-day months — surface this in onboarding.
- **NZ**: salaried prorate on working days; **waged employees are paid actual hours** (no proration construct) and leave/holiday pay is governed by Holidays-Act formulas (see `05-`), not a simple days fraction. The engine routes waged NZ earnings through `ATTENDANCE_DRIVEN` × RDP/OWP, not `PRORATE_*`.

`payableDays = standardDays − LOP_days` (plus joiner/leaver clipping).

### 6.2 LOP (Loss of Pay)

- LOP days come from attendance/leave engine (`05-`): unpaid leave, absent-without-approval, leave-balance-exhausted overflow.
- LOP reduces only components with `lopBehavior=REDUCES_WITH_LOP`. Fixed statutory minimums and certain allowances may be `FIXED_REGARDLESS`.
- **Negative-pay guard:** if deductions + LOP would push net below 0 (or below a minimum-wage floor), raise anomaly `NEGATIVE_NET` (BLOCKER) and offer carry-forward of recoveries.
- **LOP reversal / regularization:** if attendance is corrected after LOP was applied in a locked run, the correction is paid as **positive arrear** in the next run (never a silent edit).

### 6.3 Arrears & back-pay

`Arrear` = money for prior period(s) surfacing now. Sources:
1. **Backdated revision** (CTC increased effective a past date) → engine recomputes each affected past period and diffs against what was *actually locked*; the sum of deltas becomes itemized arrear earning lines (per source period).
   - **Determinism rule (critical, easy to get wrong):** the recompute of source period *P* uses the **revised compensation** but the **rule version that was pinned for *P*** (resolved by *P*'s original `payDate`), **not** today's rule version. A Dec-2025 arrear recomputed in a Jun-2026 run applies **Dec-2025** PF/ESI/PT/TDS rates, not Jun-2026 rates. Each source period therefore carries its own `ruleVersionRef` in the trace. (The *current* run's TDS projection, by contrast, absorbs the resulting arrear into the *current* year's annual tax — see below — because tax is on receipt.)
2. **Late joiner** paid for prior days.
3. **LOP/attendance correction** (positive or negative).
4. **Statutory rate change applied retrospectively** (rare) — handled purely via rule-version effective dates: Super Admin issues a backdated `effectiveFrom` version with a `correction` flag, and affected locked runs are surfaced for **compensating runs** (§10), never silently recomputed.

**Statutory treatment of arrears (critical):**
- **IN TDS:** arrears are taxable in the year of *receipt*; engine recomputes projected annual tax including the arrear and spreads/withholds accordingly. Optionally compute **Section 89(1) relief** worksheet (Form 10E) data for the employee (informational; relief is claimed by employee, but we surface the figures).
- **IN PF/ESI:** retrospective wage revision can create **arrear PF/ESI**; engine generates the additional contribution and flags it for the arrear ECR/return for the relevant month(s).
- **NZ PAYE:** back-pay is an *extra pay / lump-sum* — engine uses the **extra-pay PAYE method** (annualize, find marginal rate) per IRD, not the periodic table. ACC levy and KiwiSaver apply on the gross back-pay.
Each arrear line carries `sourcePeriod`, `reason`, `originalLockedAmount`, `recomputedAmount`, `delta` in its trace.

### 6.4 Adjustments (one-time)

One-time positive/negative lines (reimbursement top-up, deduction, bonus) entered during `INPUTS_OPEN`, each with category, taxability, statutory flags, and approval. Distinct from arrears (no source period). Stored on the input snapshot.

### 6.5 Off-cycle & bonus runs

- **Bonus run** (`OFF_CYCLE_BONUS`): pays a bonus outside the cycle.
  - **IN:** bonus is taxable; engine re-projects annual TDS to absorb it (avoids under-withholding). Statutory bonus under Payment of Bonus Act (8.33%–20% of eligible wages, eligibility ≤ wage ceiling) computed via `FORMULA_REF` where applicable.
  - **NZ:** discretionary bonus is **excluded** from Holidays-Act gross earnings but **included** in PAYE (extra-pay method) and KiwiSaver/ESCT. Productivity/contractual bonuses **are** gross earnings — flag-driven, not name-driven.
- **Correction run** (`OFF_CYCLE_CORRECTION`): compensating run referencing a locked run (§5.2).
- **Advance** (`ADVANCE`): mid-period payment, recovered via `BALANCE_RECOVERY` in the next regular run; tracked as a balance, not an expense.

### 6.6 Full & Final settlement (FnF)

FnF is a terminal `runType=FNF` for one (or batch of) exiting employee(s). Components:

| FnF line | IN logic | NZ logic |
|---|---|---|
| Salary up to last working day | prorate to LWD | actual to LWD |
| Leave encashment | encash eligible balance × per-day rate (per policy/state) | **annual leave paid out at greater of OWP / AWE** per Holidays Act; **8% accrual** for `<12 months` service; see `05-` |
| Gratuity | if ≥ 5 years (or as per Code on Social Security): `15/26 × lastDrawnWages × completedYears`; cap per Act | n/a (no statutory gratuity) |
| Notice pay / recovery | pay in lieu OR recover shortfall | per agreement |
| Bonus/arrears pending | included | included |
| Loan/advance outstanding | full recovery (capped at net; residual → debt note) | full recovery |
| Statutory finalization | final PF/ESI month, final TDS true-up, **Form 16** generation trigger | **final pay PAYE**, final KiwiSaver, final payday filing; cessation reason |
| Negative settlement | if recoveries > dues → `NET_RECOVERABLE` flagged; produces a debt advice, not a payslip credit | same |

FnF gates: cannot LOCK FnF while the employee has an unsettled prior locked run anomaly; on LOCK, employee is marked `payroll-terminated` (excluded from future regular runs); final statutory artifacts queued.

---

## 7. Rounding & money policy

- **Representation:** `BigInt` minor units + `currencyCode`. INR/NZD both have 2 minor digits (paise/cents).
- **Rounding is named and per-jurisdiction**, applied at *declared* points only, and recorded in the trace as a `ROUND` node (from, to, mode, scale).

| Policy id | Mode | Where applied | Jurisdiction |
|---|---|---|---|
| `IN_TDS_ROUND_10` | round TDS to nearest ₹10 (per IT convention, monthly withholding to whole rupee, some employers nearest 10) | TDS output | IN |
| `IN_PF_ROUND_RUPEE` | EPF/EPS rounded to nearest rupee (EPFO ECR convention) | EPF/EPS/EDLI/admin | IN |
| `IN_ESI_ROUND_UP_RUPEE` | ESI rounded **up** to next rupee (ESIC convention) | ESI EE & ER | IN |
| `IN_PT_EXACT_SLAB` | PT taken exactly from slab (no rounding) | PT | IN |
| `IN_NET_ROUND_RUPEE` | net pay rounded to rupee; residual posted to a rounding ledger | net | IN |
| `NZ_PAYE_CENT` | PAYE to the cent (IRD tables) | PAYE | NZ |
| `NZ_KS_CENT` | KiwiSaver/ESCT to the cent | KS/ESCT | NZ |
| `HALF_UP` default | banker's-vs-half-up declared per policy | generic | both |

- **Rounding residuals never vanish.** Any rounding difference posts to a per-run `ROUNDING_ADJUSTMENT` ledger line so `Σ components = net` reconciles to the cent/paisa.
- **No FX in pay.** A pay group pays in exactly one currency. `backend/src/domains/fx.js` (ECB/Frankfurter) is used **only** for cross-currency *consolidated reporting* (e.g. group-level cost in a presentation currency), clearly labelled "indicative", never to compute a payable.

---

## 8. India (IN) compliance module — concrete behaviour & 2026 figures

> All figures below are encoded as **rule-table rows** (§10) with effective dates; the module reads them, it does not hard-code them. Verified June 2026 (sources in §15).

### 8.1 Uniform "wages" definition (Labour Codes, live 21 Nov 2025)

- Four codes operational: **Code on Wages, Code on Social Security, Industrial Relations Code, OSH Code** (effective **21 Nov 2025**).
- Uniform **"wages"** definition: **basic + DA (+ retaining allowance)** must be **≥ 50% of total remuneration**. If excluded allowances exceed 50%, the excess is **added back into "wages"** for PF/ESI/gratuity.
- **Engine implementation:** base `WAGES_FLOOR_50` = `max(Σ isPfWages-flagged, 0.5 × total remuneration)`; this becomes the floor for `PF_WAGES`, `GRATUITY_WAGES`. This is the single most error-prone IN rule — it gets a dedicated validation (`WAGES_50_RULE` anomaly) and an explicit trace node.

### 8.2 EPF / EPS / EDLI (effective; ceiling ₹15,000)

| Item | Rate / rule | Base / cap |
|---|---|---|
| EPF employee (EE) | **12%** | of `PF_WAGES` |
| EPF employer (ER) split | **3.67%** to EPF + **8.33%** to EPS | of `PF_WAGES` |
| EPS (pension) cap | **8.33% of min(PF_WAGES, ₹15,000)**, statutorily capped at **₹1,250/mo** | excess ER share → EPF. *Arithmetic note: 8.33% × ₹15,000 = ₹1,249.50; EPFO fixes the ceiling at the rounded **₹1,250**, so the rule-table stores an absolute `epsCapMinor = 125000` paise applied as `min(8.33% × wages, ₹1,250)` — the cap is a hard figure, not a by-product of rounding. Logged as a `CAP` trace node.* |
| EDLI | **0.50%** of min(PF_WAGES, ₹15,000); max **₹75/mo** per employee | employer cost |
| EPF admin charges (A/c 2) | **0.50%** of PF_WAGES, **min ₹75/mo per establishment** (not per employee) | employer cost |
| EDLI admin charges (A/c 22) | **₹0 — administrative charge waived since 01 Apr 2017** (do not levy; older "0.01%/₹200" figures are obsolete) | — |
| Mandatory threshold | establishments with **20+** employees | |
| Ceiling note | wage ceiling **₹15,000** as of 2026 (proposals to raise to ₹21k/₹25k tracked but **not yet effective** — rule-table `effectiveTo` left open, alert on change) |

Module returns sub-breakdown: `{ EPF_EE, EPF_ER, EPS_ER, EDLI_ER, PF_ADMIN_ER }`, each with its own trace and the ceiling decision logged.

### 8.3 ESI (effective)

| Item | Rate | Base / threshold |
|---|---|---|
| ESI employee | **0.75%** | of ESI wages |
| ESI employer | **3.25%** | of ESI wages |
| Eligibility | gross wage **≤ ₹21,000/mo** (₹25,000 for persons with disability) | |
| Mandatory threshold | **10+** employees (state-notified variations) | |
| **Wage-base shift** | **CONFIRMED effective 21 Nov 2025** (ESIC notifications dated 10 & 11 Dec 2025 operationalising the Code on Social Security wage definition for ESI): the ₹21,000 *coverage test* and the *contribution base* now use **"wages" = Basic + DA + retaining allowance** (plus the ≥50% add-back, §8.1), **not** legacy gross. Rule-table carries `esiBaseMode` with `effectiveFrom=2025-11-21`; the module picks by `payDate`. Earlier drafts left the effective date "to verify" — that is now **resolved**; it is the same date as the wages definition. | `IN_ESI_BASE_CHANGE` anomaly downgraded to WARNING only for runs spanning the 21-Nov-2025 boundary |
| Contribution period rule | once in ESI, continue till period end (**Apr–Sep / Oct–Mar**) even if wage crosses ₹21k mid-period; exit only at boundary | encoded as `esiPeriodLock` state on employee |

### 8.4 Professional Tax (state-specific, cap ₹2,500/yr)

- **State slab tables** keyed by `ptStateCode`, monthly/half-yearly per state (e.g. Karnataka, Maharashtra, WB, TN differ; some states levy none).
- National cap **₹2,500/employee/year**; ~14 states/UTs levy PT.
- Implemented as `SLAB` over `PT_WAGES`, table resolved by `(state, effectiveDate)`. Maharashtra's February-extra-₹300 quirk encoded as a month-specific slab row.

### 8.5 TDS on salary (new regime default; FY 2025-26 / AY 2026-27)

**New regime is DEFAULT** (old regime opt-in via employee declaration).

New-regime slabs (FY 2025-26):

| Taxable income (₹) | Rate |
|---|---|
| 0 – 4,00,000 | Nil |
| 4,00,001 – 8,00,000 | 5% |
| 8,00,001 – 12,00,000 | 10% |
| 12,00,001 – 16,00,000 | 15% |
| 16,00,001 – 20,00,000 | 20% |
| 20,00,001 – 24,00,000 | 25% |
| Above 24,00,000 | 30% |

- **Standard deduction ₹75,000** (new regime, salaried).
- **Section 87A rebate** up to **₹60,000** ⇒ **nil tax for taxable income ≤ ₹12,00,000** (effectively ≤ ₹12.75L with std deduction). **Marginal relief** above ₹12L encoded.
- **Surcharge:** 10/15/25% bands (new regime caps top surcharge at 25%); **marginal relief** at ₹50L/₹1cr/₹2cr; **4% Health & Education cess** on (tax+surcharge).
- **Withholding method:** project annual taxable income → compute annual tax → subtract YTD TDS already deducted → divide by remaining months → withhold; recompute every run (handles arrears, bonus, mid-year joins, regime switch, declaration changes). Old-regime path applies Chapter VI-A deductions (80C, 80D, HRA exemption, etc.) when employee opts in.

**Deposit & filing (encoded due dates, §10):**

| Obligation | Due |
|---|---|
| TDS deposit | by **7th** of next month (Mar: by 30 Apr) |
| PF (ECR) | by **15th** of next month |
| ESI | by **15th** of next month |
| Form 24Q (quarterly) | Q1 **31 Jul**, Q2 **31 Oct**, Q3 **31 Jan**, Q4 **31 May** |
| Annual salary TDS certificate | **Form 16** by **15 Jun** following FY *(for FY 2025-26, issued under the Income-tax Act 1961 — still "Form 16")*. **From Tax Year 2026-27**, under the Income-tax Act 2025, the form series is renumbered (below). |

**Form renumbering under the Income-tax Act 2025 (corrected — these are DISTINCT forms, not alternative names for one form):**

| Income-tax Act 1961 form | Income-tax Act 2025 form | Purpose | First applies |
|---|---|---|---|
| Form 16 | **Form 130** | annual salary TDS certificate (Part A deposits + Part B computation) | TY 2026-27 |
| Form 16A | **Form 131** | TDS certificate (non-salary) | TY 2026-27 |
| Form 24Q | **Form 138** | quarterly TDS-on-salary return | TY 2026-27 |
| Form 27D | **Form 133** | TCS certificate | TY 2026-27 |

TDS-on-salary moves to **Section 392** of the new Act (was s.192). Structure/content is largely unchanged — only the section references and form ids change.

> **Resolved (was an open verification item):** an earlier draft wrote "Form 16 → 130/138" as if 130 and 138 were two candidate names for Form 16. They are **different forms**: **130 replaces Form 16**, **138 replaces Form 24Q**. Both renames are tied to the **Income-tax Act 2025, effective TY 2026-27** — so FY 2025-26 payroll still prints "Form 16"/"Form 24Q", and FY 2026-27 onwards prints "Form 130"/"Form 138". Because every form id is a rule-table field (`filingForms`, §10), the engine selects the correct id by the run's pinned rule version — a *data* change, zero code change. Super Admin still confirms against the final CBDT notification of the new-Act rules before the first TY 2026-27 filing.

### 8.6 Gratuity

- Formula `15/26 × lastDrawnWages × completedYears`, where `lastDrawnWages` is **"wages" per the Code definition (Basic+DA, with the ≥50% add-back, §8.1)** — a material increase vs the legacy Basic+DA-only base for employees whose allowances were >50% of pay.
- **Eligibility (changed under Code on Social Security 2020, live 21 Nov 2025):** **5 years** continuous service for permanent employees, **but fixed-term employees are now eligible on a pro-rata basis after just 1 year** of continuous service. Encode `gratuityEligibilityRule` per employment type in the rule table; do **not** hard-code "5 years".
- **Statutory cap ₹20,00,000** (verified current to 2026; also the tax-exemption ceiling under s.10(10) — track for revision). The cap limits the *statutory minimum obligation and tax exemption*, not what an employer may voluntarily pay.
- Accrued monthly as an `EMPLOYER_CONTRIBUTION`/provision (actuarial or simple-accrual, configurable); paid at FnF. The provision does **not** enter net pay or PF/ESI bases.

---

## 9. The `ComplianceModule` interface (the plug-in seam)

The core depends only on this interface. IN and NZ each provide an implementation; RoW can be added later without touching the engine.

```ts
interface ComplianceModule {
  readonly country: 'IN' | 'NZ';              // ISO-3166 alpha-2
  readonly capabilities: Capability[];        // ['PF','ESI','PT','TDS'] | ['PAYE','KIWISAVER','ESCT','STUDENT_LOAN','ACC']

  // 1. Declare bases this module consumes/produces (lets core build the DAG)
  declareBases(): BaseSpec[];

  // 2. Validate an employee is statutorily set up (IDs, codes, eligibility)
  validateEmployee(emp: EmployeeStatCtx, ruleVersion: RuleVersionRef): StatValidation[];

  // 3. THE core call: given frozen bases + YTD state + pinned rule version,
  //    return statutory deductions, employer contributions, and full sub-breakdowns.
  //    PURE. No I/O. Deterministic for a given (bases, ytd, ruleVersion).
  computeStatutory(ctx: {
    employee: EmployeeStatCtx;
    bases: Record<BaseKey, MinorAmount>;
    period: PayPeriod;
    ytd: YtdState;                    // YTD taxable, YTD TDS/PAYE, YTD PF, contribution-period flags
    ruleVersion: RuleVersionRef;      // pinned (country, effectiveDate, versionId)
    runType: RunType;                 // REGULAR | OFF_CYCLE_BONUS | FNF | ARREAR_ONLY | ADVANCE
  }): StatutoryResult;                // { lines: StatLine[], baseValues, traceNodes, ytdDeltas }

  // 4. Period-end / cross-employee aggregation (e.g. employer PF challan, ESI total)
  aggregateForFiling(runResults: LockedRunResult[], filing: FilingKind, ruleVersion): FilingDataset;

  // 5. Produce the statutory file for a filing obligation (delegates layout to OutputGenerator)
  generateFiling(dataset: FilingDataset, format: FilingFormat): FilingArtifact;

  // 6. Due-date calendar for the period (drives reminders & the FILED state)
  filingCalendar(period: PayPeriod, ruleVersion): FilingObligation[];
}

type StatLine = {
  code: string;                 // 'EPF_EE' | 'PAYE' | 'KIWISAVER_ER' | 'ESCT' ...
  kind: 'DEDUCTION_STATUTORY' | 'EMPLOYER_CONTRIBUTION';
  amountMinor: bigint;
  base: BaseKey;
  ruleApplied: { ruleVersion: string; rowId: string; rate?: number; cap?: bigint };
  subLines?: StatLine[];        // e.g. PF splits into EPF_ER/EPS/EDLI/admin
  trace: TraceNode[];           // explainability
};
```

**Contract guarantees the core enforces:**
- `computeStatutory` MUST be pure & side-effect-free (verified by replay test: same inputs ⇒ identical `StatutoryResult`).
- Every `StatLine.amountMinor` MUST be reconstructable from `base × rule` in its `trace` (auditor replay).
- A module MUST be selectable purely by `country`; the core never name-checks "IN"/"NZ" in business logic — it routes by the registered module's `country`.
- Modules are **registered** at boot (`registerComplianceModule(new InModule())`), enabling RoW expansion without core edits.

---

## 10. Rule-table versioning & effective dates

Owned and edited only in **Super Admin** (`admin.hr.com`); see `03-compliance-rule-tables.md` for the editor, approval workflow, and publication. The engine **consumes** versioned snapshots.

```jsonc
ComplianceRuleVersion {
  id, country,                  // 'IN' | 'NZ'
  versionLabel,                 // 'IN-FY2025-26.r3'
  effectiveFrom, effectiveTo,   // date range this version governs
  status,                       // DRAFT | PUBLISHED | SUPERSEDED
  publishedBy, publishedAt,
  changelog,                    // human + machine diff
  tables: {                     // the actual rate data
    pfRates, epsCap, edli, ptSlabs[state], esiRates, esiThreshold, esiBaseMode,
    incomeTaxSlabs[regime], stdDeduction, rebate87A, surcharge, cess,
    payeBrackets, accLevy, esctBrackets, ksRates, studentLoanThreshold, ...
  },
  filingForms,                  // form ids & layouts (lets us swap Form16→130 by data)
  dueDates                      // calendar rules per obligation
}
```

- **Resolution:** a pay run pins `ruleVersion = latest PUBLISHED where effectiveFrom ≤ payDate < effectiveTo` per country, **at `INPUTS_LOCKED`**. The pin is stored on the run snapshot. Re-runs reuse the pin (deterministic).
- **Mid-year change:** e.g. NZ KiwiSaver 3% → **3.5% on 1 Apr 2026**, ACC earners' levy **1.67% → 1.75%** on first **$156,641** (2026/27), minimum wage **$23.95/hr** from 1 Apr 2026 → all encoded as a new `NZ-FY2026-27` version with `effectiveFrom=2026-04-01`. A run paying 28 Mar 2026 pins the old version; 4 Apr 2026 pins the new. **No code deploy** to roll the year.
- **Retroactive correction to a rule:** if a published rate was wrong, Super Admin issues a *new* version with a backdated `effectiveFrom` and a `correction` flag; affected locked runs are surfaced for **compensating runs** (never silent recompute).
- **Audit:** every version change is an immutable `PricingAuditLog`-style row (we reuse the existing `PricingAuditLog` pattern at `backend/prisma/schema.prisma` — same shape: who/when/before/after/reason).

### 10.1 NZ figures encoded (2026/27, effective 1 Apr 2026)

| Item | Value |
|---|---|
| PAYE brackets | 10.5% ≤ $15,600; 17.5% $15,601–53,500; 30% $53,501–78,100; 33% $78,101–180,000; 39% > $180,000 |
| KiwiSaver default min | **3.5%** EE + **3.5%** ER (from 1 Apr 2026; → 4% in Apr 2028) |
| KiwiSaver eligibility | **16–17 year-olds** now eligible for employer contributions (from 1 Apr 2026) |
| KiwiSaver temp opt-down | members may apply to IRD (from Feb 2026) to stay on a lower rate 3–12 months |
| ACC earners' levy | **1.75%** (from 1.67%) on income up to **$156,641** (2026/27) |
| ESCT brackets | 10.5% ≤ $16,800; 17.5% $16,801–57,600; 30% $57,601–84,000; 33% $84,001–216,000; 39% > $216,000 (unchanged 2026/27) |
| Student loan | 12% above annual threshold **$24,128** (tax code `…SL`) |
| Adult minimum wage | **$23.95/hr** (from 1 Apr 2026) |
| Govt KiwiSaver contribution | halved to 25c/$1, max **$260.72/yr** (from 1 Jul 2025) — informational, not employer-paid |

### 10.2 NZ statutory behaviour notes

- **PAYE method:** annualize the period's PAYE income, locate marginal bracket, de-annualize per pay frequency (IRD's periodic method); ACC earners' levy folded into the PAYE deduction up to the cap. Extra pays (bonus, back-pay) use the **extra-pay** method.
- **ESCT** is computed on **employer** KiwiSaver contributions using the employee's prior-year total remuneration to pick the rate; reduces the net employer cash to the scheme but is a tax, remitted to IRD.
- **Payday filing:** employment information filed to IRD **within 2 working days of each payday** (electronic). The engine's `generateFiling` produces the EI dataset per pay run; the `FILED` state tracks the 2-working-day clock and alerts.
- **Holidays Act 2003:** the hard part (RDP vs ADP, OWP vs AWE greater-of, 4 weeks annual leave in **weeks**, alternative/lieu days, sick/bereavement/public holidays, 8% accrual) is fully specified in `05-attendance-leave-and-holidays-act.md`. This engine consumes the resulting `NZ_GROSS_EARNINGS`, `OWP`, `RDP`, `ADP`, `AWE` bases and the leave-pay component amounts. **Provable correctness here is our flagship NZ differentiator** — the engine's job is to keep those numbers immutable and traceable through to the payslip and payday file.

---

## 11. Idempotency & re-run safety

The single biggest source of payroll bugs is *accidental double-processing* and *silent drift*. The engine defends with four mechanisms:

1. **Content-addressed inputs.** At `INPUTS_LOCKED`, `inputHash = sha256(canonicalJSON(inputs ∪ pinnedRuleVersions ∪ engineVersion))`. The input snapshot is immutable.
2. **Compute keyed by `inputHash`.** The compute job's idempotency key is `(payRunId, inputHash)`. Re-enqueue with the same key ⇒ returns the cached result; never recomputes-and-overwrites. This is the same exactly-once discipline as Sitepresso's webhook ledgers (`PaddleWebhookEvent`/`StripeWebhookEvent`/`RazorpayWebhookEvent`, `schema.prisma:1622–1690`) where a duplicate event id is a no-op.
3. **YTD committed once, at LOCK, transactionally.** YTD deltas (`ytdDeltas` from each `StatutoryResult`) are applied in the same DB transaction that flips the run to `LOCKED` and allocates payslip numbers via an atomic counter (reusing the `InvoiceCounter { series, lastValue }` pattern, `schema.prisma:1877`). A crash mid-commit rolls back atomically — no half-committed YTD.
4. **Refuse-to-clobber on locked runs.** Any compute/file job targeting a `LOCKED`/`CLOSED` run with a *different* `inputHash` is rejected with `IMMUTABLE_RUN_VIOLATION`; the only path forward is a compensating run.

**Outbound file dispatch** (bank advice, statutory file) also gets a dedup ledger row keyed by `(payRunId, fileKind, contentHash)` so regenerating an identical file is a no-op and regenerating a *changed* file (which can only happen via a compensating run) is a new, linked artifact.

### 11.1 YTD serialization (the concurrency hole the four mechanisms above do NOT close)

Mechanisms 1–4 make a *single* run deterministic, but they do **not** by themselves prevent two **different** runs that touch the **same employee** from racing on YTD — and the IN TDS annual-projection method (§8.5) and the NZ student-loan/ACC-cap logic both **read YTD and write a YTD delta**, so a lost-update race directly produces a *wrong tax figure* (under- or over-withholding), not a mere duplicate. This happens in practice: a `REGULAR` monthly run and an `OFF_CYCLE_BONUS` run for the same employee, prepared in parallel and locked close together.

Defences (all required):

1. **Per-employee YTD lock at LOCK.** The `LOCKED` transition takes a row-level lock on `YtdLedger (businessId, employeeId, fiscalYear)` (`SELECT … FOR UPDATE`) *inside* the same transaction that commits the deltas and allocates payslip numbers. Two runs contending for the same employee's YTD serialize; the second blocks, then proceeds against the committed YTD of the first.
2. **Read-set revalidation.** Each run snapshots, at `INPUTS_LOCKED`, the **YTD version** (a monotonically increasing `ytdVersion` per `(employee, fiscalYear)`) it computed against. At `LOCK`, if the live `ytdVersion` for any included employee differs from the snapshot, the run is **not** committed: it transitions to `RULE_VERSION_DRIFT`-style block `YTD_DRIFT` and must **re-compute** (cheap, idempotent) against current YTD before re-attempting LOCK. This converts a silent wrong-tax race into a visible, forced recompute. TDS withholding is *self-correcting across the year* by construction (it re-projects each run), so the recompute is exact, not approximate.
3. **No parallel LOCK across overlapping periods for one employee.** A DB constraint / advisory lock forbids two *non-compensating* runs holding `LOCKED` with overlapping `[periodStart, periodEnd]` for the same employee. (Off-cycle runs targeting the *same* period are allowed but each re-reads committed YTD per (1).)

### 11.2 `payDate` mutation after the rule-version pin

§4 allows pay calendars to be edited (move a pay date off a weekend/public holiday). The rule version is pinned by `payDate` **at `INPUTS_LOCKED`** (§10). If `payDate` is later moved **across a rule-version effective-date boundary** (e.g. from 31 Mar 2026 to 1 Apr 2026, crossing every NZ FY2026-27 change), the pin is now stale and the run would file under the wrong year. Guard: moving `payDate` on a run that is `INPUTS_LOCKED` or beyond is **blocked**; the run must be `REOPENED` to `INPUTS_OPEN`, the calendar edited, then re-locked (which re-pins). Anomaly `PAYDATE_PIN_STALE` (BLOCKER) fires if any path produces a `payDate` whose resolved rule version differs from the pinned one.

---

## 12. Explainability & audit (`calc_explain`)

Every computed amount carries a **trace graph**. Persisted immutably alongside the run; renderable at three altitudes.

```jsonc
TraceNode {
  id, payRunId, employeeId, componentCode,
  op,            // INPUT | BASE_SUM | PERCENT | SLAB_LOOKUP | FORMULA | STATUTORY |
                 // CAP | FLOOR | PRORATE | LOP | ROUND | ARREAR_DIFF | YTD_PROJECT
  inputs,        // [{ ref, amountMinor }] — references to other nodes/bases
  params,        // { percent, rate, slabRowId, capMinor, ruleVersion, roundMode, days }
  outputMinor,   // result of this node
  ruleVersionRef,
  note           // localized human sentence, e.g. "EPF EE 12% of PF wages ₹50,000 (employer opted to contribute above the ₹15,000 ceiling) = ₹6,000" — or, if ceiling-restricted, "12% of ₹15,000 = ₹1,800"
}
```

- **Employee view (ESS):** plain-language payslip explainers ("Your PF: 12% of ₹50,000 = ₹6,000"). Localized en/hi (IN) / en (NZ) via `backend/src/i18n/translator.js`.
- **HR view:** full component breakdown, statutory splits, anomaly annotations, arrear provenance.
- **Auditor view:** replay button — re-execute the trace from the *snapshot* and confirm it reproduces the locked figure to the minor unit. Any mismatch ⇒ red audit event.
- **Immutable audit log:** state transitions, approvals, reopens, reversals, rule-version pins, file generations — append-only, reusing the `AdjustmentLedger`/`PricingAuditLog` append-only patterns (`schema.prisma:1883`, `PricingAuditLog`). Retained per statutory record-keeping (IN digital wage/attendance registers + payslips mandatory; NZ 7-year wage/time records).

---

## 13. Output abstraction (bank advice + statutory files)

A single `OutputGenerator` interface produces every artifact from a **locked** run's result. Generators are pure (locked-result → bytes) and versioned.

```ts
interface OutputGenerator<TFormat> {
  kind: 'BANK_ADVICE' | 'PAYSLIP_PDF' | 'STATUTORY_FILING' | 'GL_JOURNAL' | 'REGISTER';
  format: TFormat;                      // e.g. 'NEFT_CSV' | 'EPFO_ECR_TXT' | 'IRD_EI_CSV' | 'PDF' | 'XLSX'
  supports(country: string, runType: RunType): boolean;
  generate(input: LockedRunResult, opts): Artifact;   // bytes + contentHash + manifest
}
```

| Artifact | IN | NZ |
|---|---|---|
| **Bank advice** (no money moves) | NEFT/RTGS bulk-upload CSV per bank format (HDFC/ICICI/SBI templates), with debit account, IFSC, beneficiary, amount | bank-batch CSV / ABA-equivalent for NZ banks |
| **Statutory filings** | EPFO **ECR** text file; **ESIC** contribution file; **Form 24Q** (eTDS, FVU-ready) → renamed form watch; **PT** challan/return per state | IRD **payday filing** EI dataset; **KiwiSaver** schedule; ESCT included in EI |
| **Payslip** | white-labelled PDF (logo, brand color, 1 of 5 styles via `packages/theme-engine`), bilingual; statutory wage/attendance register | white-labelled PDF; Holidays-Act leave balances shown in weeks |
| **GL journal** | per-component debit/credit postings (cost vs liability accounts) for accounting export | same |
| **Registers** | mandatory digital wage register, attendance register, payslip archive (Labour Codes) | wage/time records (7-yr) |

- **Every artifact is hashed, stored, and dedup-ledgered** (§11). The file an employer downloads is provably the one generated from the locked run.
- **Format templates** are data (per-bank, per-state), versioned in Super Admin, so onboarding a new bank format is configuration, not code.
- **v1 boundary restated:** generators produce *instruction* files. **No PSP/bank API call, no settlement.** Money movement (Razorpay payouts / NZ bank API) is explicitly **post-v1**; the abstraction already accommodates it (a future `DISBURSE_API` generator/dispatcher), so v2 is additive.

---

## 14. Validation & anomaly engine (the `VALIDATED` gate)

Runs between `COMPUTED` and `VALIDATED`. Two severities: `BLOCKER` (must resolve to proceed) and `WARNING` (acknowledge to proceed). Catalog (selected):

| Code | Severity | Rule |
|---|---|---|
| `NEGATIVE_NET` | BLOCKER | net pay < 0 |
| `MISSING_BANK` | BLOCKER (if disbursing) | no validated bank account |
| `MISSING_STAT_ID` | BLOCKER | missing UAN/PF, ESIC IP, PAN (IN) or IRD number/tax code (NZ) where applicable |
| `WAGES_50_RULE` | BLOCKER (IN) | Basic+DA < 50% of total remuneration not corrected by add-back |
| `IN_ESI_BASE_CHANGE` | WARNING | ESI base mode ambiguous for period — confirm rule version |
| `PF_CEILING_DRIFT` | WARNING | PF wages cross ₹15k mid-year vs prior treatment |
| `TDS_SWING` | WARNING | month-on-month TDS delta > threshold (catches bonus/arrear mis-projection) |
| `NET_PAY_SWING` | WARNING | net deviates > X% from employee's trailing average |
| `NEW_JOINER_FULL_MONTH` | WARNING | joiner mid-month paid full (proration likely missed) |
| `LEAVER_NOT_FNF` | WARNING | termination date set but processed as regular run |
| `MINWAGE_FLOOR` | BLOCKER | hourly/derived rate < statutory minimum ($23.95 NZ / state min IN) |
| `KS_RATE_MISMATCH` | WARNING (NZ) | employee KS rate below new 3.5% default without valid opt-down |
| `DUP_PAYMENT` | BLOCKER | employee already paid in another locked run for overlapping period. **Re-evaluated at LOCK inside the txn (§11.1), not only at VALIDATED — a parallel run may lock between VALIDATED and LOCK.** |
| `RULE_VERSION_DRIFT` | BLOCKER | pinned rule version superseded by a correction since pin |
| `YTD_DRIFT` | BLOCKER | another run committed YTD for an included employee since this run's `ytdVersion` snapshot (§11.1) — forces idempotent recompute before LOCK |
| `PAYDATE_PIN_STALE` | BLOCKER | `payDate` now resolves to a different rule version than the pinned one (§11.2) — e.g. pay date moved across a FY boundary post-lock |
| `ROUNDING_UNBALANCED` | BLOCKER | Σ components ≠ net after rounding adjustment |

Anomalies are explainable (link to the offending trace nodes) and tracked to resolution. The suite is itself versioned.

---

## 15. End-to-end flow (worked, condensed)

**Regular IN monthly run, pay group "IN-Monthly-Salaried", period 2026-06-01..30, pay date 2026-06-30:**

1. `DRAFT` created (preparer). `INPUTS_OPEN`: attendance/leave imported (from `05-`), one-time adjustments entered, 2 new joiners (proration), 1 leaver flagged → routed to FnF.
2. Cutoff 2026-06-26 → `INPUTS_LOCKED`: snapshot taken, `inputHash` computed, rule version pinned `IN-FY2026-27.rN` (effectiveFrom ≤ 2026-06-30).
3. `COMPUTED`: per employee — earnings prorated, `PF_WAGES` built (50%-wages floor enforced), `In.computeStatutory` returns EPF split, ESI (period-lock honoured), PT (state slab), TDS (annual projection − YTD). Traces emitted.
4. `VALIDATED`: anomaly suite — one `TDS_SWING` warning (a bonus was included) acknowledged; zero blockers.
5. `APPROVED` by Finance head (≠ preparer; 4-eyes). Totals hash signed.
6. `LOCKED`: YTD committed in one tx; payslip numbers allocated atomically.
7. `DISBURSEMENT_READY`: HDFC NEFT CSV generated + hashed (no money moves).
8. `PUBLISHED`: white-labelled payslips to ESS; notifications fired.
9. `FILED`: ECR (by 15 Jul), ESI (by 15 Jul), TDS deposit reminder (by 7 Jul), 24Q queued for Q1 (31 Jul). Due-date clocks armed.
10. `CLOSED`: GL journal posted, period reconciled, archived.

**NZ fortnightly waged run** differs at steps 3 (waged hours × rate, Holidays-Act leave pay from `05-`, PAYE extra-pay for any bonus, KiwiSaver 3.5%, ESCT by prior-year band, ACC levy to cap, student-loan if `…SL`) and 9 (**payday filing within 2 working days of 2026-06-30**, not monthly).

---

## 16. API surface (engine, backend `backend/src/hr/payroll/`)

| Method & path | Purpose | Guard |
|---|---|---|
| `POST /payroll/runs` | create DRAFT (group, period) | `PAYROLL_PREPARER` |
| `POST /payroll/runs/:id/inputs` | upsert one-time earnings/deductions/adjustments | preparer, state≤`INPUTS_OPEN` |
| `POST /payroll/runs/:id/lock-inputs` | → `INPUTS_LOCKED` (snapshot, pin, hash) | preparer |
| `POST /payroll/runs/:id/compute` | enqueue compute (idempotent by `inputHash`) | preparer/system |
| `GET /payroll/runs/:id/explain/:employeeId` | full `calc_explain` graph | preparer/auditor/employee(self) |
| `POST /payroll/runs/:id/validate` | run anomaly suite | preparer |
| `POST /payroll/runs/:id/approve` | → `APPROVED` (4-eyes) | `PAYROLL_APPROVER` |
| `POST /payroll/runs/:id/lock` | → `LOCKED` (commit YTD) | approver |
| `POST /payroll/runs/:id/bank-advice` | generate bank file | approver |
| `POST /payroll/runs/:id/publish` | → `PUBLISHED` (payslips) | preparer/approver |
| `POST /payroll/runs/:id/filings/:kind` | generate statutory artifact | preparer/auditor |
| `POST /payroll/runs/:id/reverse` | spawn compensating run | approver |
| `POST /payroll/runs/fnf` | create FnF run for employee | preparer |
| `GET /payroll/runs/:id/artifacts` | list hashed outputs | preparer/auditor |
| `GET /payroll/calendar` | filing/due-date calendar | any payroll role |

All routes are `businessId`-scoped via `requireBusiness`/`requireVertical` (`backend/src/core/middleware/`). Compute/file/anomaly run on a dedicated `payroll-worker` (pattern from `backend/src/scheduler-worker.js`).

---

## 17. Data model (new payroll tables — summary)

`PayGroup`, `PayCalendar`, `SalaryComponentDef`, `EmployeeCompStructure`, `PayRun`, `PayRunInputSnapshot` (immutable, `inputHash`), `PayslipResult` (locked, per employee), `ComponentInstance`, `TraceNode`, `StatutoryLine`, `YtdLedger` (per employee × fiscal year × bucket), `ArrearLine`, `BalanceRecovery` (loans/advances), `ComplianceRuleVersion`, `FilingObligation`, `Artifact` (hashed outputs + dispatch ledger), `PayrollAudit` (append-only), `PayslipCounter`/`PayRunSequence` (atomic). Every table carries `businessId`. Money is `BigInt` minor + `currencyCode`. Full DDL lives in `02-data-model-hr-core.md`; this doc owns the *behavioural contract* those tables serve.

---

## 18. Sources (verified June 2026)

- EPFO contribution rates/ceiling: epfindia.gov.in ContributionRate.pdf; salarybox.in; mycsonline.in (2026).
- ESI rates/threshold & Basic+DA base shift: cleartax.in/s/esi-rate; vakilsearch.com; tallysolutions.com; paybooks.in (2026).
- New tax regime slabs / 87A ₹60k / std deduction ₹75k / marginal relief: incometax.gov.in (AY 2026-27); cleartax.in/s/income-tax-slabs; tax2win.in/guide/section-87a.
- TDS/PF/ESI due dates, Form 24Q quarterly dates, Form 16 (and 24Q→138 / Form 16 rename watch under IT Act 2025): cleartax.in/s/tds-payment-due-dates-and-penalties; caclubindia.com; legalsuvidha.com.
- IN Labour Codes live 21 Nov 2025 + uniform wages ≥50%: salarybox.in statutory-compliance-2026 guide.
- KiwiSaver 3.5% from 1 Apr 2026, 16–17 eligibility, temp opt-down, govt contribution $260.72: ird.govt.nz/kiwisaver-changes; generatewealth.co.nz; booster.co.nz; markhams.co.nz.
- NZ PAYE brackets 2026/27; ESCT brackets; student-loan threshold $24,128; min wage $23.95; ACC earners' levy 1.75% on $156,641: calculate.co.nz/reference/nz-tax-rates.php & nz-esct-rates.php; nztax.tools; ird.govt.nz; markhams.co.nz.
- Payday filing within 2 working days; Holidays Act gross earnings / RDP / ADP / OWP / AWE: ird.govt.nz/employing-staff/payday-filing; employment.govt.nz calculating-holiday-and-leave-pay; legislation.govt.nz Holidays Act 2003.

> **Compliance figures are encoded as versioned rule-table data (§10), not code constants.** Where a 2026 rename/base-shift is sourced only from secondary commentary (Form 16→130/138; ESI gross→Basic+DA effective date), it is gated behind a Super-Admin confirmation flag and the engine is name/base-agnostic, so confirming the official notification is a *data* change, not a code change.

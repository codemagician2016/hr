# Feature 26 — Reimbursement Paid via Payroll

> **One-paragraph summary.** Today F11 approves `ExpenseClaim`s but pays them out-of-band (the `reimburse` Finance action stamps `status=REIMBURSED` + a manual `paymentRef`). Most India employers instead settle approved reimbursements **through the monthly payslip** as a non-taxable, post-tax line that is **NOT** part of gross / PF / ESI / PT / TDS wage bases and is **added to net after** statutory deductions. The payroll engine already has the exact seam for this — `CATEGORY.REIMBURSEMENT` (engine.js §7), which evaluates a claim-bounded line, keeps it out of every statutory base, and adds it to net (`netMinor = gross − Σ EE deductions + Σ reimbursements`). This feature adds a **per-claim payout-channel choice** (`PAY_VIA_PAYROLL` vs `PAY_SEPARATELY`), a **reimbursement pay-pass** in the run that mirrors the loan-recovery deduction-pass (`loanRecovery.js` selectDuePending → engine cap → applyRecovery → unwind) **but as a positive payment**, an **idempotent stamp** against each claim (`payRunId` + `paidViaPayrollAmount` + `REIMBURSED` on disburse), and a **net-floor sanity guard** so a reimbursement is never silently shrunk by another recovery. No new payout math, no engine fork, no expense-engine fork.

- **Status:** SHIPPED (implemented end-to-end: schema + reimbursementPayout.js + payroll wiring + live tests; status updated 2026-07-21 by the Feature-45 audit)
- **Depends on:** F07 Payroll Run (engine.js / service.js / payrun.js), F11 Reimbursement/Travel (expenses.service.js, claims.controller.js, ExpenseClaim), the loan-recovery pass (controllers/loanRecovery.js)
- **Market:** India-first (the non-taxable-reimbursement treatment is IN; the mechanism is country-agnostic — engine already routes net-add generically)
- **Author convention:** money is integer **minor units (paise)** through the engine; Prisma `Decimal(15,2)` at rest. Every query tenant-scoped on `businessId`.

---

## 1. The statutory rule (why this is post-tax and base-exempt)

A genuine **reimbursement of a business expense actually incurred** by the employee (travel, hotel, client meals, mileage, telephone, etc.), supported by a bill and within policy, carries **no profit element** to the employee — the employer is merely repaying a cost. Under the Income-Tax Act this is **not "salary"/"perquisite"** in the employee's hands, so:

| Treatment | Rule |
|---|---|
| **Income-tax / TDS (192)** | Not taxable; **excluded** from the salary on which TDS u/s 192 is computed. No profit element ⇒ no TDS. (Contrast: a *fixed allowance* with no bill IS taxable salary.) |
| **PF (EPF wages)** | Not "basic wages" — excluded from the PF wage base. |
| **ESI (gross wages)** | Reimbursement of actual expenditure incurred in the course of duty is **excluded** from ESI "wages". |
| **Professional Tax (PT)** | Not part of the PT wage/salary base. |
| **LWF / Gratuity / Bonus** | Not part of any of these wage bases. |
| **Where it sits on the payslip** | A separate **post-tax** line, **added to net AFTER** all statutory + voluntary deductions. It increases net pay-out but inflates **no** wage base. |

**Net formula (already implemented):** `Net = Gross earned − Σ employee deductions (statutory + voluntary) + Σ reimbursements`. See `engine.js` §7–§8 (lines 326–356) — the engine already computes exactly this. We are wiring a data source into that existing seam, not changing the formula.

**Hard invariants the build must preserve:**
1. A reimbursement line **never** appears in `bases.*` (pfWages, esiWages, ptWages, taxable, gratuityWages, nzGrossEarnings) — guaranteed because `CATEGORY.REIMBURSEMENT` components are partitioned out **before** `sumFlagged()` builds bases (engine.js lines 140–151 vs 203–211).
2. The reimbursement is **post-tax** — evaluated in §7, after the compliance module (§5) and voluntary deductions (§6) have run. TDS/PF/ESI are already final.
3. The payout is **claim-bounded** — the amount paid = the approved claim amount (or its un-paid residual), never engine-fabricated.

**Sources:** [ClearTax — TDS on reimbursement of expenses](https://cleartax.in/s/tds-on-reimbursement-of-expenses) · [Mysa — Taxability of reimbursement of expenses to employees in India (2026)](https://www.mysa.io/blogs/taxability-reimbursement-expenses-employees-india) · [Busy — TDS on reimbursement of expenses: applicability & examples](https://busy.in/tds/tds-on-reimbursement-of-expenses-applicability-rules--examples/)

---

## 2. Codebase audit — what already exists (REUSE, do not fork)

### 2.1 The engine seam is already built
`backend/src/hr/payroll/engine.js`:
- `CATEGORY.REIMBURSEMENT` (line 35) is a first-class component category.
- §2 partition (lines 140–162) routes `REIMBURSEMENT` defs into `reimbursementDefs`, **separate** from earnings/deductions, so they touch no statutory base.
- §7 (lines 326–330) evaluates each via `evalSimple` (FIXED amount → `amountMinor`), claim-bounded.
- §8 (lines 339–356) sums them into `reimbTotalMinor` and **adds to net** after deductions; emits a `BASE_SUM / NET_PAY` trace node with a `REIMBURSEMENTS` input for the explain trail.
- The result already carries `reimbursements: [{code,label,amountMinor}]` and `reimbursementsMinor` (lines 370, 375).

> **This is the whole reason the feature is cheap.** The mapping layer (`buildEmployeePayInput`) just needs to **emit one `CATEGORY.REIMBURSEMENT` component per eligible claim**, identical in spirit to how it already emits the `LOAN_REPAYMENT` `CALC.BALANCE_RECOVERY` deduction (service.js lines 296–317).

### 2.2 Persistence already handles reimbursements
`backend/src/hr/payroll/service.js`:
- `buildComponentRows` (line 1063) already maps `r.reimbursements` → `PayRunLineComponent` rows with `category: 'REIMBURSEMENT'`.
- `buildPayslipSnapshot` (line 1093) already serialises `reimbursements` into the frozen payslip JSON.
- `PayRunLineComponent.category` enum already includes `REIMBURSEMENT` (used in `compRow`).

So payslip display + component persistence are **free**. What's missing is (a) the **selection** of which claims feed the line, and (b) the **stamp-back** against the claim after the engine reports the actual paid amount.

### 2.3 The loan-recovery pass — the pattern to MIRROR
`backend/src/hr/controllers/loanRecovery.js` is the reference implementation of a "pay-run pass" with idempotent stamping. We mirror its three functions **as a positive payment**:

| loanRecovery.js (deduction) | reimbursementPayout.js (NEW — positive payment) |
|---|---|
| `selectDuePending(tx, {…})` — row-locks (`FOR UPDATE SKIP LOCKED`) PENDING installments due ≤ periodEnd, oldest-first, clamps to loan outstanding, returns `{installments, totalDueMinor}` | `selectPayableClaims(tx, {…})` — row-locks APPROVED claims marked `PAY_VIA_PAYROLL`, un-paid, returns `{claims, totalPayableMinor}` |
| Engine applies **net-floor cap** (`CALC.BALANCE_RECOVERY`, RECOVERY_CAPPED_TO_NET) — deduction can't push net < 0 | Engine does **NOT** cap a reimbursement (it ADDS to net). Net-floor guard here is a **sanity check**, not a cap — see §6 |
| `applyRecovery(tx, {…, recoveredMinor})` — credits the loan EXACTLY what was debited, stamps installment `status/paidAt/payRunId/recoveredAmount`, partial trailing stays PENDING | `applyPayout(tx, {…, paidMinor})` — stamps each claim `status=REIMBURSED, payRunId, paidViaPayrollAmount, reimbursedAt`; idempotent |
| `unwindForRun(tx, {businessId, payRunId})` — resets stamped installments to PENDING, reverses Loan totals, on recompute/reopen/cancel | `unwindForRun(tx, {businessId, payRunId})` — resets stamped claims back to APPROVED, clears `payRunId/paidViaPayrollAmount`, on recompute/reopen/cancel |

The **wiring points** in `service.js` are identical to loan recovery:
- `loadRunRowBundles` (lines 673–687) attaches `b.loanRecovery` per employee → we add `b.reimbursementPayout`.
- `buildEmployeePayInput` (lines 296–317) emits the `LOAN_REPAYMENT` component → we emit one `CATEGORY.REIMBURSEMENT` component per claim (or one aggregated line; see §5.2).
- `persistComputedRun` unwinds then re-applies (lines 894, 944–986) → we add the symmetric reimbursement unwind + apply.

### 2.4 The expense engine — REUSE for eligibility
`backend/src/hr/expenses/expenses.service.js` + `policyEngine.js` already decide a claim is **within policy** (`policyVerdict`). A claim only becomes payroll-payable once `status=APPROVED` AND `policyVerdict ∈ {OK, NO_POLICY}` AND (if FLAGGED) the approver cleared it — i.e. the engine's existing verdict is the eligibility gate. **We do not re-run policy here.** We trust the approved claim.

### 2.5 The Finance reimburse action — already half-built
`claims.controller.js` `reimburse()` (lines 141–160) already:
- flips `APPROVED → REIMBURSED`,
- writes `paymentRef` and **`payRunId`** (the column already exists on `ExpenseClaim`, schema line 8838!).

So `ExpenseClaim.payRunId` is **already in the schema**. We add only `paidViaPayrollAmount` + `payoutChannel`. The existing manual-reimburse path becomes the `PAY_SEPARATELY` branch.

---

## 3. The two payout channels (the per-claim choice)

```
                          ExpenseClaim APPROVED
                                  │
                   payoutChannel? │  (set at submit, editable while APPROVED & unpaid)
              ┌───────────────────┴────────────────────┐
       PAY_SEPARATELY                            PAY_VIA_PAYROLL
   (out-of-band, today's path)            (NEW — picked up by next run)
              │                                        │
   Finance clicks "Reimburse"            next pay run for the employee's entity:
   → REIMBURSED + paymentRef             selectPayableClaims → REIMBURSEMENT line
   (payRunId NULL)                       → engine adds to net → on DISBURSE,
                                          applyPayout stamps REIMBURSED + payRunId
                                          + paidViaPayrollAmount
```

- **Default channel** is a **tenant setting** (`PayrollSettings.reimbursementDefaultChannel`, §4.3) so an employer that always pays via payroll doesn't set it per claim. Per-claim override always wins.
- The channel is **editable only while the claim is APPROVED and not yet paid/stamped**. Once a run has stamped it (`payRunId` set) the channel is frozen.

---

## 4. Data model (Prisma sketches — additive, all nullable/defaulted)

### 4.1 `ExpenseClaim` — add 3 fields (mirror LoanInstallment stamp fields)

```prisma
model ExpenseClaim {
  // … existing fields (note: payRunId String? ALREADY EXISTS, line 8838) …

  // Feature 26 — reimbursement paid via payroll.
  payoutChannel        ReimbursementPayoutChannel @default(PAY_SEPARATELY)
  // The paise ACTUALLY paid through a pay run for this claim — the single reconciliation
  // figure (mirrors LoanInstallment.recoveredAmount). Set by applyPayout off the engine's
  // reported reimbursement amount; reversed exactly by unwindForRun. NULL = never paid via
  // payroll. For a fully-paid claim == amount; a residual-paid claim < amount (see §5.4).
  paidViaPayrollAmount Decimal?                   @db.Decimal(15, 2)
  // payRunId String? ALREADY EXISTS — reuse it as the owning-run stamp.

  @@index([businessId, payoutChannel, status]) // selection scan for the pay pass
}

enum ReimbursementPayoutChannel {
  PAY_SEPARATELY   // out-of-band (today's manual Finance reimburse) — DEFAULT
  PAY_VIA_PAYROLL  // settle through the next pay run's payslip
}
```

> **Why no partial-payment row table?** A claim is paid **whole** through one run (an approved business reimbursement is owed in full and the engine never caps it — see §6), so a single `paidViaPayrollAmount == amount` is sufficient. The only partial case is the **net-floor sanity guard** firing (§6), which we treat as a **block**, not a partial — so the claim is either fully paid in a run or carried untouched to the next, never split. This keeps the stamp idempotent and reconciliation trivial (unlike loans, which genuinely split across installments).

### 4.2 Idempotency / concurrency anchors
- The owning-run stamp is `(payRunId set, status=REIMBURSED, paidViaPayrollAmount set)`. The pay pass only **selects** claims where `payoutChannel=PAY_VIA_PAYROLL AND status=APPROVED AND payRunId IS NULL` (un-paid) **OR** `payRunId = currentPayRunId` (this run's own prior stamp, for idempotent recompute — exactly the loanRecovery re-inclusion trick, loanRecovery.js lines 107–135).
- Row lock: `SELECT … FOR UPDATE SKIP LOCKED` on the candidate claim ids inside the run tx, so two runs for the same employee can't both grab the same claim (mirrors loanRecovery.js).

### 4.3 `PayrollSettings` (or `Entity`) — default channel
Add one tenant/entity setting (reuse the existing payroll-settings model if present; else a column on `Entity`):

```prisma
// on the existing payroll settings model (or Entity)
reimbursementDefaultChannel ReimbursementPayoutChannel @default(PAY_SEPARATELY)
// optional hard cap so a single run never pays out more reimbursement than salary net
// (sanity guard tuning, §6); NULL = no extra cap beyond the net-floor block.
```

---

## 5. The reimbursement pay-pass (mirror loanRecovery.js)

New file: `backend/src/hr/controllers/reimbursementPayout.js` (sits beside `loanRecovery.js`, owns the `ExpenseClaim` bookkeeping so payroll never forks the claim math).

### 5.1 `selectPayableClaims(tx, { businessId, employeeId, periodEnd, currentPayRunId })`
- Row-lock (`FOR UPDATE SKIP LOCKED`) the candidate claims for this employee:
  ```
  status = 'APPROVED'  (paid claims are REIMBURSED, so already excluded)
  AND payoutChannel = 'PAY_VIA_PAYROLL'
  AND deletedAt IS NULL
  AND (payRunId IS NULL OR payRunId = currentPayRunId)
  AND (expenseDate <= periodEnd OR expenseDate IS NULL)   -- don't pre-pay a future-dated claim
  AND importJobId IS NULL                                  -- never auto-pay a back-dated imported claim
  ORDER BY createdAt ASC                                   -- oldest claim first
  ```
- Return `{ claims:[{id, amountMinor}], totalPayableMinor }`. Amount per claim = `toMinor(claim.amount)` (the approved header amount). MIGRATED runs select nothing (mirrors loan recovery `if (!isMigrated)`).

### 5.2 Emit the engine component (in `buildEmployeePayInput`)
Right after the existing `LOAN_REPAYMENT` block (service.js line 317), add:

```js
const reimb = rows.reimbursementPayout || null;
if (reimb && reimb.totalPayableMinor > 0) {
  componentsForEngine.push({
    code: 'EXPENSE_REIMBURSEMENT',
    name: 'Expense reimbursement',
    category: CATEGORY.REIMBURSEMENT,       // <-- the existing engine seam (§7)
    calcMethod: CALC.FIXED,
    amountMinor: reimb.totalPayableMinor,    // claim-bounded; one aggregated line
    showOnPayslip: true,
    _order: order,
    isTaxable: false,                        // belt-and-braces; REIMBURSEMENT is never in bases anyway
    isPayeable: false,
  });
  order += 1;
}
```

- **One aggregated `EXPENSE_REIMBURSEMENT` line** (Σ of the period's payable claims) keeps the payslip clean. The per-claim breakdown lives on the claims themselves (each stamped `payRunId`) and can be shown in a payslip drill-down. (Alternative: one line per claim with code `EXPENSE_REIMBURSEMENT_<claimNumber>` — choose aggregated for V1; the stamp loop handles either.)
- Attach `reimb` onto `meta.reimbursementPayout` (mirror `meta.loanRecovery`, service.js line 435) so `persistComputedRun` can stamp.

### 5.3 `applyPayout(tx, { businessId, payRunId, paidAt, claims, paidMinor })`
- Distribute `paidMinor` across `claims` oldest-first. Because the engine does **not** cap reimbursements, `paidMinor == totalPayableMinor` in the normal case, so every selected claim is paid **in full**:
  ```
  for each claim (oldest first):
    credit = min(claim.amountMinor, remaining)
    if credit < claim.amountMinor:  // net-floor guard fired upstream (§6) — should not happen
        STOP (do not partial-pay a claim; leave it APPROVED for next run)
    stamp: status=REIMBURSED, payRunId, reimbursedAt=paidAt,
           paidViaPayrollAmount = claim.amount, reimbursedBy = system/run actor
    remaining -= credit
  ```
- Returns `{ paidMinor, paidClaimIds }`. (No employer-side ledger to roll forward — unlike a loan there is no outstanding balance; the claim simply closes.)

### 5.4 `unwindForRun(tx, { businessId, payRunId })`
- Find every claim stamped with this `payRunId`, reset: `status='APPROVED', payRunId=null, paidViaPayrollAmount=null, reimbursedAt=null, reimbursedBy=null`. Return the count. (Mirrors loanRecovery.js lines 309–349; simpler — no running totals to reverse.)

### 5.5 Wiring in `service.js` (mirror the loan-recovery wiring exactly)

| Site | loan recovery (existing) | reimbursement (NEW) |
|---|---|---|
| `loadRunRowBundles` selection (lines 679–687) | `b.loanRecovery = selectDuePending(...)` | `b.reimbursementPayout = selectPayableClaims(...)` (gated on `!isMigrated`) |
| `buildEmployeePayInput` component emit (296–317) | `LOAN_REPAYMENT` deduction | `EXPENSE_REIMBURSEMENT` reimbursement (§5.2) |
| `persistComputedRun` unwind (line 894) | `loanRecovery.unwindForRun(tx,…)` | `reimbursementPayout.unwindForRun(tx,…)` |
| `persistComputedRun` apply (944–986) | re-select under lock → `applyRecovery` off engine's actual `LOAN_REPAYMENT` figure | re-select under lock → `applyPayout` off engine's actual `EXPENSE_REIMBURSEMENT` figure (`r.reimbursements.filter(code==='EXPENSE_REIMBURSEMENT')`) |

> **Stamp-commit timing — the one real difference from loans.** A loan installment is *recovered* the moment the run is computed (the money leaves the employee). A reimbursement is *paid* only when the employer actually disburses. To avoid a claim showing REIMBURSED for a run that is later abandoned in DRAFT/COMPUTED, the **financial stamp is written at compute** (so recompute/idempotency mirror loans) **but the claim is only truly settled at the APPROVED→PAID boundary** (`disburseRun`). Concretely: `applyPayout` runs in `persistComputedRun` (claim → REIMBURSED, payRunId stamped) just like loans; `unwindForRun` runs on every recompute/reopen/cancel so an abandoned run cleanly releases the claims back to APPROVED. This keeps **one** idempotency model across both passes. (If product prefers REIMBURSED to appear strictly post-disbursement, move `applyPayout` to `disburseRun` and have compute only *reserve* via `payRunId` — documented as a V2 toggle.)

---

## 6. Net-floor sanity guard (the safety rail)

A reimbursement **adds** to net, so it can never push net negative on its own. The guard protects a different failure: a payslip whose **deductions already exceed earnings** (heavy LOP month + loan recovery) where dumping a large reimbursement would mask a genuinely broken payslip, OR a mis-configured claim amount that dwarfs salary (data-entry error / fraud).

Guard (evaluated in `persistComputedRun`, after the engine result is in, before `applyPayout`):

1. **Negative pre-reimbursement net block.** If `gross − Σ EE deductions < 0` (the engine already emits `NEGATIVE_NET` BLOCKER, engine.js line 359), do **NOT** stamp any reimbursement for that employee — the payslip is already broken; carry the claims to the next run. Surface anomaly `REIMBURSEMENT_DEFERRED_NEGATIVE_NET`.
2. **Reimbursement-to-net ratio block (configurable).** If `reimbTotalMinor > ratioCap × max(net_before_reimb, 0)` (default ratioCap e.g. 10×, or an absolute `reimbursementDefaultChannel` companion cap), defer the claims and emit a **WARNING** anomaly `REIMBURSEMENT_EXCEEDS_NET_SANITY` so a reviewer eyeballs it before approving the run. This is the analogue of loanRecovery's `RECOVERY_CAPPED_TO_NET` but **fail-closed-with-review**, not silent-cap.
3. **Never partial-pay.** If the guard fires for an aggregated line, defer the **whole** employee's reimbursement set (don't pay some claims and not others) — keeps reconciliation 1:1 (a claim is either fully REIMBURSED via this run or untouched).

The guard lives in the orchestrator (service.js), exactly as loan recovery's net-floor cap lives in the engine — neither forks the other's math. Because deferral leaves the claims APPROVED + un-stamped, the **next run picks them up automatically** with no manual intervention.

---

## 7. API + RBAC

Reuse F11 routes (`backend/src/hr/routes/expenses.routes.js`, `meExpenses.routes.js`) and the existing scope/permission gates (`canApproveExpense`, `canViewEmployees`). No new payroll routes — selection happens **inside** the existing compute/disburse flow.

| Method + path | Purpose | RBAC gate |
|---|---|---|
| `PATCH /expenses/claims/:id/payout-channel` | Set/flip `payoutChannel` (PAY_VIA_PAYROLL ↔ PAY_SEPARATELY). 409 if claim already stamped (`payRunId` set) or not APPROVED. | claim owner **while DRAFT/SUBMITTED**; `canApproveExpense` **while APPROVED** (Finance decides channel) — F1-scoped (out-of-scope ⇒ 404, per claims.controller pattern) |
| `POST /expenses/claims/:id/reimburse` | EXISTING (claims.controller.js `reimburse`). Now the explicit **PAY_SEPARATELY** settle. Reject (409) if `payoutChannel=PAY_VIA_PAYROLL` (must go through a run) unless an override flag forces manual. | `canApproveExpense` (Finance) — unchanged |
| `GET /payroll/runs/:id/reimbursements` | List the claims a run will pay / has paid (preview before disburse). Reads PayRunLineComponent `category=REIMBURSEMENT` + stamped claims. | `canRunPayroll` / `canViewPayroll` |
| `GET /me/expenses/claims` | EXISTING ESS list — now surfaces `payoutChannel` + "Paid in <payslip-month>" once stamped. | self-scope (ESS) |

**Settings:**

| Method + path | Purpose | RBAC |
|---|---|---|
| `PATCH /payroll/settings` (or `/entities/:id`) | Set `reimbursementDefaultChannel` (+ optional sanity ratio/cap). | `canManagePayrollSettings` / admin |

**Notification fan-out (reuse `notifyHrEvent`, notifications.js line 387):**
- On disburse, fire `HR_REIMBURSEMENT_PAID_VIA_PAYROLL` to the employee ("₹X reimbursement paid in your <Month> payslip").
- On `REIMBURSEMENT_EXCEEDS_NET_SANITY` during compute, fire `HR_PAYROLL_REIMBURSEMENT_REVIEW` to the run preparer.

---

## 8. UX (plain language)

### 8.1 hr-admin (apps/hr-admin)
- **Claim detail (Finance/approver view):** when a claim is APPROVED, a **"How to pay"** toggle: *Pay through payroll* (default if the tenant setting says so) vs *Pay separately (bank transfer)*. Greyed/locked once a run has picked it up ("Scheduled in PR-2026-06-IN" / "Paid in June payslip"). The existing **Reimburse** button only shows for *Pay separately* claims.
- **Pay-run review screen (F07):** a new **"Reimbursements"** summary card — N claims, ₹ total, per-employee breakdown, and any `REIMBURSEMENT_EXCEEDS_NET_SANITY` flags highlighted. Lets the preparer see exactly which approved claims will ride this payslip **before** disburse. Deferred claims (guard fired) show with a "carried to next run" badge.
- **Payslip preview/PDF:** the **Reimbursement** line already renders from `r.reimbursements` (engine + snapshot) — shown in its own non-taxable section, clearly **below** Net deductions, labelled "Reimbursement (non-taxable)". A drill-down lists the claim numbers it bundles.
- **Payroll settings:** "Default reimbursement payout channel" radio + an optional "Sanity cap: don't auto-pay reimbursement more than [N×] net" field.

### 8.2 ESS (apps/ess)
- **My Expenses list:** each approved claim shows a small badge: *Via payroll — June* or *Bank transfer* . Once paid, "Paid in your June payslip (PS-2026-06-…)" deep-links to the payslip.
- **My Payslip:** the **Reimbursement** line appears under earnings/deductions in a clearly separate, "not taxed, not part of PF/ESI base" callout, with a tap-through to the underlying claim(s).
- No new ESS submit step — the employee's existing claim flow is unchanged; the channel is mostly an employer decision (defaulted), surfaced read-only to the employee.

---

## 9. Build slices (3–5, each independently shippable + testable)

### Slice 1 — Schema + channel choice (no payroll yet)
- Migration: add `ExpenseClaim.payoutChannel` (+ `paidViaPayrollAmount`), `ReimbursementPayoutChannel` enum, `reimbursementDefaultChannel` setting, the `@@index`. (`payRunId` already exists.)
- `PATCH /claims/:id/payout-channel` endpoint + RBAC + 409 guards (not-APPROVED / already-stamped).
- Default-channel resolution at claim submit (read the tenant setting).
- hr-admin "How to pay" toggle + ESS read-only badge.
- **Tests:** channel flips only while APPROVED+unpaid; default applied from setting; out-of-scope ⇒ 404.

### Slice 2 — The reimbursement pay-pass module (pure-ish, mirrors loanRecovery)
- New `controllers/reimbursementPayout.js`: `selectPayableClaims`, `applyPayout`, `unwindForRun` — with the `FOR UPDATE SKIP LOCKED` row lock and the `payRunId = currentPayRunId` recompute re-inclusion.
- Unit tests mirroring the loan-recovery tests: select picks only PAY_VIA_PAYROLL+APPROVED; apply stamps idempotently; unwind reverses exactly; concurrent-run lock prevents double-pay; recompute reproduces the same set.

### Slice 3 — Engine wiring (the line appears on the payslip)
- `buildEmployeePayInput`: emit the `EXPENSE_REIMBURSEMENT` `CATEGORY.REIMBURSEMENT` component from `rows.reimbursementPayout` (§5.2); thread `meta.reimbursementPayout`.
- `loadRunRowBundles`: attach `b.reimbursementPayout = selectPayableClaims(...)` (gated `!isMigrated`).
- **Tests (the statutory heart):** assert the reimbursement is in `result.reimbursements`, in net, and **NOT** in `bases.pfWages/esiWages/ptWages/taxable`; assert PF/ESI/TDS are **identical** to a run without the reimbursement (base-invariance golden test); assert `net == net_without + reimbTotal`.

### Slice 4 — Stamp-back + unwind + net-floor guard (idempotency + safety)
- `persistComputedRun`: add `reimbursementPayout.unwindForRun` (beside the loan unwind, line 894) and the re-select-under-lock → `applyPayout` off the engine's actual `EXPENSE_REIMBURSEMENT` amount (beside lines 944–986).
- Net-floor sanity guard (§6): defer + anomaly on negative pre-reimbursement net or ratio breach; never partial-pay.
- `GET /payroll/runs/:id/reimbursements` preview; notification fan-out on disburse.
- **Tests:** recompute is idempotent (claim stamped once); reopen/cancel releases claims to APPROVED; guard defers (claim stays APPROVED, next run pays it); concurrent two-run race pays a claim exactly once.

### Slice 5 — Polish (review card, PDF, reconciliation report)
- hr-admin pay-run "Reimbursements" review card + payslip-PDF non-taxable section + claim deep-links.
- ESS "Paid in your <Month> payslip" deep-link.
- A reconciliation assertion in the run summary: `Σ PayRunLineComponent(REIMBURSEMENT) == Σ stamped claims.paidViaPayrollAmount == r.reimbursementsMinor` (debit-side parity, mirroring loan's debit==credit invariant).

---

## 10. Statutory & system edge cases

| # | Case | Handling |
|---|---|---|
| 1 | **Reimbursement must not inflate PF/ESI/PT/TDS** | Guaranteed structurally: `CATEGORY.REIMBURSEMENT` is partitioned out before bases are built (engine.js §2 vs §4). Slice-3 golden test asserts base-invariance. |
| 2 | **Heavy-LOP / negative-net month** | Net-floor guard §6.1: don't stamp; defer to next run; anomaly `REIMBURSEMENT_DEFERRED_NEGATIVE_NET`. |
| 3 | **Claim amount > salary (typo/fraud)** | Net-floor guard §6.2: ratio/abs cap → WARNING `REIMBURSEMENT_EXCEEDS_NET_SANITY`, defer for review. |
| 4 | **Future-dated claim** (`expenseDate > periodEnd`) | Excluded from `selectPayableClaims` (don't pre-pay). |
| 5 | **Off-cycle / arrear / FNF / bonus run** | A reimbursement *can* validly ride any run that pays the employee. V1: only the **regular** monthly run pays (gate `runType` to primary, mirroring LWF's once-per-period gate, service.js line 662) to avoid surprising a bonus-only run with reimbursements; make it a setting in V2. |
| 6 | **MIGRATED (historical-import) run** | Selects nothing (gated `!isMigrated`, like loan recovery) — imported claims (`importJobId` set) are also excluded by the selection filter (§5.1) so back-dated history isn't auto-paid. |
| 7 | **Claim approved AFTER the run computed** | Not in the frozen set; rides the **next** run. Recompute of the current run would pick it up only if re-computed before disburse (consistent with loan recovery). |
| 8 | **Channel changed after stamping** | Blocked: `PATCH payout-channel` 409s once `payRunId` is set. To move a stamped claim back to PAY_SEPARATELY, the run must be reopened (which unwinds the stamp). |
| 9 | **Recompute / reopen / cancel** | `unwindForRun` resets claims to APPROVED + clears stamp (§5.4) — idempotent, mirrors loans. |
| 10 | **Concurrent runs, same employee** | `FOR UPDATE SKIP LOCKED` in `selectPayableClaims` serialises; a claim can be stamped by only one run. |
| 11 | **GST/ITC on the bill** | Out of scope for payroll payout — GST input credit is an AP/finance concern on the original bill, not the payslip line. Documented as not-handled-here. |
| 12 | **Multi-currency claim** (`currencyCode != run currency`) | V1: only pay claims whose `currencyCode == payRun.currencyCode`; others stay PAY_SEPARATELY-eligible / flagged. (FX conversion is out of scope.) |
| 13 | **Partial approval** | Claim header `amount` is the approved figure (F11 already settles at the approved amount); we pay that. No line-level partial payout in V1. |
| 14 | **Form-16 / 24Q** | Because the line is non-taxable and base-exempt, it correctly **does not** appear in 24Q salary or Form-16 Part B taxable salary — no special handling needed; the existing filing reads `taxableMinor`, which excludes it. |

---

## 11. Reuse-vs-build matrix

| Capability | Reuse (existing) | Build (new) |
|---|---|---|
| Post-tax, base-exempt, add-to-net line | **`engine.js` `CATEGORY.REIMBURSEMENT` §2/§7/§8** | — |
| Payslip component + snapshot for reimbursements | **`buildComponentRows` / `buildPayslipSnapshot` (service.js)** | — |
| Pay-run pass pattern (select→engine→apply→unwind, row-lock, idempotent recompute) | **`controllers/loanRecovery.js`** (mirror) | `controllers/reimbursementPayout.js` (positive-payment mirror) |
| Claim eligibility (within policy / approved) | **`expenses.service.js` + `policyEngine.js` verdict** | — (trust the approved claim) |
| Claim stamp fields | **`ExpenseClaim.payRunId` (already exists)** | `payoutChannel`, `paidViaPayrollAmount` + enum |
| Manual (separate) reimburse | **`claims.controller.js` `reimburse()`** | gate it to PAY_SEPARATELY |
| Run lifecycle / disburse / publish | **`service.js` disburseRun/publishRun** | hook `applyPayout` stamp-commit semantics |
| RBAC scope + 404-not-403 | **`scopeResolver` + `canApproveExpense`** | new `payout-channel` endpoint reuses it |
| Notifications | **`notifyHrEvent` (notifications.js)** | 2 new event templates |
| Net-floor safety | **engine's RECOVERY_CAPPED_TO_NET pattern (analogue)** | orchestrator sanity guard §6 (defer-with-review) |
| Default channel setting | **payroll settings / Entity** | one enum column |

---

## 12. Acceptance criteria (definition of done)

1. An APPROVED, within-policy claim marked `PAY_VIA_PAYROLL` appears as a single non-taxable **Reimbursement** line on the employee's next regular payslip, added to net.
2. PF, ESI, PT, LWF, gratuity base and **TDS are byte-identical** to the same run computed without the reimbursement (golden base-invariance test passes).
3. On disburse, the claim flips to `REIMBURSED` with `payRunId` + `paidViaPayrollAmount == amount`; the employee is notified.
4. Recompute/reopen/cancel of the run releases the claim back to `APPROVED` and clears the stamp (idempotent; no double-pay; concurrent runs pay once).
5. A claim that would breach the net-floor sanity guard is **deferred** (stays APPROVED, anomaly raised) and is picked up automatically by the next run — never silently partial-paid.
6. `PAY_SEPARATELY` claims still settle exactly as today (manual reimburse, no payRunId).
7. Reconciliation holds: `Σ REIMBURSEMENT components == Σ stamped claim paidViaPayrollAmount == r.reimbursementsMinor`.

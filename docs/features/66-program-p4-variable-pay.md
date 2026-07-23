# Feature 66 — Master Program Phase 4 workforce wave E: variable-pay scheme engine (CLOSES PHASE 4)

Non-statutory variable pay / incentives / commission — a defined scheme
(target % or amount, achievement-linked, prorated) that computes a per-employee
payout and rides the existing pay run. Audit build-order #6 (highest); the last
Phase-4 feature. Mirrors the statutory BonusCycle/BonusAward pattern.

## What shipped
- **VariablePayScheme** (kind INCENTIVE/COMMISSION/BONUS; basis GROSS/BASIC/
  CTC/FIXED_AMOUNT; targetPct or targetAmount; payoutFrequency MONTHLY/
  QUARTERLY/ANNUAL; prorationMethod NONE/BY_ATTENDANCE/BY_TENURE; eligibility
  scope Json) + **VariablePayCycle** (DRAFT→COMPUTED→APPROVED→PAID→CANCELLED,
  four-eyes computedBy + version) + **VariablePayAward**
  (@@unique[cycleId,employeeId]: basisAmount, targetAmount, achievementPct,
  prorationFactor, computedAmount, queued, payRunInputItemId).
- **Pure compute core** (variablePay.js, integer paise, HALF_UP): target =
  fixed amount or pct-of-basis; computed = target × achievement% × proration.
  23 golden checks.
- **Service**: scheme CRUD; cycle create resolves eligible employees (scope
  filter) + their current-comp basis + seeds awards; PATCH achievement% while
  DRAFT/COMPUTED (editing a COMPUTED cycle re-opens it to DRAFT); compute
  freezes amounts + totals; approve = **canApprovePayroll maker-checker**
  (four-eyes approver≠computedBy, atomic COMPUTED-guarded claim — mirrors
  bonus, NOT a new engine module) → **payout via PayRunInputItem(kind=OTE,
  VARIABLE_PAY)** injected onto each employee's entity's current open run (no
  open run → award `queued` for later); cancel (DRAFT/COMPUTED only — APPROVED
  payouts are live).
- **API** /api/hr/variable-pay: schemes + cycles (compute/approve/cancel) +
  awards (list/patch). **UI**: Payroll → Variable Pay (Schemes tab +
  conditional target-by-basis; Cycles tab with the awards table, inline
  achievement editing, Compute/Approve/Cancel, queued/injected badges,
  four-eyes 403 surfaced).
- The existing statutory bonus + fixed-pay compute paths are byte-for-byte
  untouched (bonus 41, india 288, variance 39, nz 63, arrears 48 goldens all
  pass).

## Manual test (staging)
1. Payroll → Variable Pay → Schemes → create "Quarterly Incentive" (INCENTIVE,
   GROSS, target 10%, QUARTERLY).
2. Cycles → new cycle for the period → awards seed with each employee's target
   (10% of gross); edit an achievement% to 80 → Compute → the computed amount
   is target × 80%.
3. A different user with canApprovePayroll approves (the computer can't — four-
   eyes) → awards APPROVED, the payout rides the next open run as a one-time
   earning (or shows "Queued" until a run opens).

## E2E evidence
`qa/e2e/e2e-p4-varpay.js` on live staging: **12/12** — scheme create, cycle
seeds 34 awards (target = 10% of ₹85,566 gross = ₹8,556.60), patch
achievement 80%, compute (computed = ₹6,845.28 = target × 0.80), Finance
approves (four-eyes: HR-Admin computed) → awards APPROVED + OTE payout queued,
cleanup. Units: variablePay 23; bonus/india/variance/nz/arrears goldens
unchanged.

---

**PHASE 4 COMPLETE.** Mobile parity (3 waves) + workforce features (loan
interest, pipeline templates, careers CMS, OT pre-approval, open-shift claims,
variable pay). The approval engine reached 22/22 modules.

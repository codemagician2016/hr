# Feature 45 — Custom reimbursement: per-job-level limits, configurable routing, full console + mobile

The owner's ask: "client can set reimbursement as per job level or approval etc — full end to end."
The audit found grade-aware limits existed ONLY for travel (hotel/per-diem/transport matrices),
expense categories/limits had NO console (API-only), level-scoped approval routing was silently
dead, and the ₹50,000 HR-escalation threshold was a hard-coded constant.

## 1. Per-JOB-LEVEL reimbursement limits

- New `ExpenseGradeRule` (policyId → ExpensePolicy, `gradeRank` null=all-levels, per-claim /
  per-day / per-month cap overrides). REPLACE-ALL via
  `PUT /api/hr/expenses/categories/:id/policy/grade-rules` (mirrors the travel rule PUTs).
- `policyEngine.evalCategory` precedence: **exact gradeRank rule > all-levels rule > flat policy
  caps**, with null fields on the winning rule falling back (partial overrides compose). Verdict
  reasons carry the level ("per-claim cap (level 5)"). Month-to-date loads whenever ANY monthly
  cap could apply (flat or grade).
- gradeRank was already resolved on every ESS evaluation (it fed travel rules) — so the caps bite
  on web, m-host, and the new mobile screen with zero client changes.

## 2. Approval routing — configurable, and finally functional

- **Bug fix:** `openClaimApproval` sent `categoryCode: null, departmentId: null` and no level —
  so grade/department-scoped EXPENSE WorkflowDefinitions could NEVER match. The ctx now carries
  real `employeeLevel` (gradeId — same convention as LEAVE), `departmentId`, `locationId`,
  `categoryCode` from the current employment record. Level-scoped chains route.
- **Configurable threshold:** the built-in chain's "HR above ₹50,000" amount now reads
  `Business.featureFlags.expense.hrThresholdRupees`
  (`GET/PATCH /api/hr/expenses/settings`, audited); steps are cloned, never mutated; unset →
  the historical default.

## 3. Console + payout (previously API-only)

- Travel-policy console gains **Categories & limits** (category CRUD, flat limits, FLAG/HARD
  enforcement, and the **grade × caps override grid**) and **Approval & payout** (HR threshold;
  per-entity default `reimbursementDefaultChannel` — now writable via the org API).
- Admin expenses queue: per-approved-claim payout-channel toggle (PAY_SEPARATELY ↔
  PAY_VIA_PAYROLL; the Feature-26 payroll payout path was fully built but had no UI).

## 4. Mobile

New Flutter expenses screen (claims list, new claim, add bills with receipt capture, live policy
verdicts, submit/withdraw) — the app previously had only the approvals inbox. Same
`/api/hr/me/expenses/*` surface as ESS web; works identically on the m-hosts.

## 5. Tests

`gradeRules.unit.test.js` (9): precedence, partial-override fallback, monthly fallback asymmetry,
unknown-grade, no-rules regression, FLAG vs HARD. Existing `policyEngine.test.js` 19/19 green.
Live staging E2E: category+limits+grade-rule CRUD → ESS verdict honours the level cap → threshold
round-trip → payout-channel patch → routing ctx spot-check.

## 6. Not built (flag when wanted)

Visual scoped-workflow builder (scoped defs work via API; ChainBuilder still edits the module
default only); per-category budgets/analytics; OCR receipt extraction (column reserved).

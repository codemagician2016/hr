# Feature 62 — Master Program Phase 4 workforce wave A: loan interest methods + recruitment pipeline templates

Two independent workforce backend features (audit build-order picks #1 and #2 —
low effort, high value), each fetch-E2E-verified.

## Loan interest methods
- New `enum LoanInterestMethod { FLAT, REDUCING_BALANCE, SIMPLE, ZERO }` +
  `interestMethod` on LoanScheme and Loan (default FLAT — behaviour-preserving;
  snapshotted onto the Loan at create like interestRate).
- `buildSchedule` refactored to a pure `computeSchedule({principalMinor,
  annualRatePct, tenureMonths, method})` and branched:
  - **FLAT / SIMPLE** — today's math, kept byte-for-byte (regression-verified:
    a harness compared the refactor against a verbatim copy of the original
    across 5000 randomized loans — 0 mismatches).
  - **ZERO** — equal-principal, no interest.
  - **REDUCING_BALANCE** — amortized EMI in integer paise: monthly
    r = rate/12/100, EMI = P·r·(1+r)^n/((1+r)^n−1), per row
    interest = round(outstanding·r), principal = EMI − interest, the final row
    absorbs rounding so Σprincipal == P exactly and outstanding closes at 0.
- Wired into the loans create/update/read API + the enum-validated 422.
  Unit: loanSchedule 36 checks.

## Recruitment pipeline templates
- New `PipelineTemplate` + `PipelineTemplateStage` (reuse StageKind), tenant-
  scoped, unique name, exclusive isDefault, soft-delete.
- Routes under /api/hr/recruitment (canManageHiring OR canManageEmployees):
  list / create / get / patch / delete, `POST /:id/apply {jobId}` (append to a
  stage-less job; 409 STAGES_EXIST if it has stages; `?replace=true` allowed
  only when the job has 0 applications, else 409 STAGES_IN_USE — Application.
  currentStageId is an FK-less String so replacing under live applications
  would orphan pipeline positions), `/jobs/:id/apply-template` alias,
  `seed-defaults` (idempotent "Standard hiring" default + "Technical hiring").
- createJob auto-seeds the active default template's stages when the request
  names none (additive — previously createJob seeded nothing).
  Unit: pipelineTemplates 16 checks.

## Admin UI (hr-admin)
- Loans page: create/edit modal with the interest-method selector (+per-method
  explainer; read-only when snapshotted from a scheme) + a detail modal showing
  the amortization table (REDUCING visibly tapers the interest column).
- NEW Settings → Pipeline templates (list + ordered stage editor + restore
  defaults) + an "Apply template" affordance on the job pipeline tab (guarded
  replace that checks application count).

## Manual test (staging)
1. Loans → New loan → REDUCING_BALANCE, ₹120000 @ 12% / 12mo → approve → the
   schedule shows interest falling each month (₹1200 → ₹106); FLAT shows a flat
   ₹1200/mo.
2. Settings → Pipeline templates → Restore defaults → a job created afterward
   auto-gets the default stages; build a custom template and apply it to a
   stage-less job.

## E2E evidence
`qa/e2e/e2e-p4-wavea.js` on live staging: REDUCING loan (12 installments,
interest strictly decreasing 1200→106, Σprincipal == 120000), FLAT (flat
1200/installment), bad-method 422; pipeline seed-defaults, custom template
create, apply → 5 stages materialized (branches on the auto-seed-default
state), re-apply 409 STAGES_EXIST, exclusive default, cleanup. Units:
loanSchedule 36 + pipelineTemplates 16; FLAT regression harness 5000/5000.

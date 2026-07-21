# Feature 44 — Leave: full customisation + reconciliation completeness

Closes every gap from the leave-audit ("is leave management and reconciliation fully custom?"):
the engine was already policy-driven; this build makes every knob reachable, every ledger
reconcilable org-wide, and wires the four dormant engine seams.

## 1. Client-readiness (reconciliation)

- **`LEAVE_BALANCE` import kind** (the #1 onboarding blocker): migrate opening balances via the
  standard import pipeline (upload → map → validate → dry-run → commit). Columns:
  `employeeCode, leaveTypeCode, periodCode, openingBalance, note`. Lands the lot + an
  `OPENING_BALANCE` ledger row; idempotent (same opening → skipped); a lot with real movement is
  never clobbered (correction path = balance adjust).
- **Org-wide reconciliation sweep**: `GET /api/hr/leave/reconciliation/org?periodCode=…`
  (+`driftedOnly`, +`format=csv`) — every lot in the period re-derived from its ledger in two
  queries, drift flagged, CSV export for auditors.
- **Drift repair**: `POST /api/hr/leave/balances/:id/repair` — overwrites the persisted lot from
  the append-only ledger (the truth), recomputing the pendingApproval soft-hold; version-locked,
  audited with before/after. Reconciliation now *detects and heals*.
- **Adjust race fix**: `/balances/adjust` now takes the same version optimistic-lock as every
  other balance write (racing accrual could silently double-post before).

## 2. Config completeness

- Leave types + policies: **edit/delete from the console** (was create-only).
- Policy form exposes the full schema: probation gate, all in-service encashment knobs,
  **approval-chain binding** (workflow dropdown).
- **Tenure-tier editor** (`/policies/:id/tiers` CRUD) — accrual rate per tenure band, consumed by
  the accrual engine all along.
- **Applicability assignments editor** (`/policies/:id/assignments` CRUD) — scope a policy to an
  ENTITY / DEPARTMENT / GRADE / EMPLOYMENT_TYPE / single EMPLOYEE, effective-dated; consumed by
  the policy resolver all along. No assignments = tenant-wide by type.

## 3. Engine seams wired (existed as pure functions/columns; never invoked)

| Seam | Now |
|---|---|
| Join-month proration | A balance's first-ever tick where the employee joined inside the window grants `prorataOnJoin` (≤15th cutoff rule for monthly; day-prorated for upfront) instead of a full period. |
| Accrual frequency | Runner honours the policy's `accrualFrequency`: monthly / quarterly (Jan-Apr-Jul-Oct) / annual (1 April, matching the year-end gate). |
| Per-policy approval chain | `LeavePolicy.workflowDefinitionId` is finally consumed: `workflowResolver` prefers an explicitly BOUND published definition (`source: POLICY_BOUND`); unusable binding falls through safely. Passed by both ESS and operator apply paths. |
| Probation gate | New `LeavePolicy.blockDuringProbation` — blocks applications while `EmployeeStatus = PROBATION`, orthogonal to tenure months (validators §6b, code `PROBATION_BLOCKED`). |
| Carried-lot expiry | Nightly `runCarriedLotExpiry`: carry-forward lots (the `Carry-forward from <period>` OPENING_BALANCE rows) lapse `carryForwardExpiryMonths` after opening, carried-first FIFO consumption, marked LAPSE row = idempotency guard. |

## 4. Tests

`leaveAudit.unit.test.js` (13): probation gate on/off/confirmed/orthogonality; import validator
(uppercasing, natural key, negative/format/required); prorataOnJoin cutoff + upfront proration.
Regression: accrual.golden 32 · calendar 18 · validators 25 · leave.reconcile 28 — all green.
(leave.history/lwp.flow are live-DB suites; covered by staging E2E instead — local dev DB has
pre-existing drift.)

## 5. Deliberately NOT built (product decisions, flag when wanted)

Year-end overflow **auto-encashment** (money movement should not be automatic — needs an owner
decision on payout mechanics); visual workflow designer (JSON-configured chains work today);
leave forecasting.

# Feature 65 — Master Program Phase 4 workforce wave D: open-shift claims (22nd engine module)

Adds "open shifts" — publish an unassigned shift, eligible employees claim it,
the manager confirms — distinct from the existing 1:1 named shift swap. Audit
build-order #5 (HIGH).

## What shipped
- **OpenShift** (entity/location/department scope, date, shiftPatternId,
  headcount, filledCount, status OPEN/FILLED/CANCELLED) + **OpenShiftClaim**
  (@@unique[openShiftId, employeeId] — one claim per person per shift; reuses
  RequestStatus) + `WorkflowModule.OPEN_SHIFT_CLAIM` + `RosterSource.OPEN_CLAIM`.
- **consumers.openShiftClaim.js** — **22/22 modules now engine-wired**.
  onApprove (in the engine tx): flip the claim APPROVED → upsert the claimant's
  RosterDay for the day (source=OPEN_CLAIM, PUBLISHED, the shift's pattern,
  under the version optlock) → **race-safe atomic fill** (`updateMany where
  {status:OPEN, filledCount<headcount}` with the FILLED flip folded in — two
  concurrent last-slot approvals: the loser matches 0 rows → DECISION_RACE →
  tx rolls back) → recompute the claimant's day → when FILLED, auto-reject the
  remaining PENDING claims and cancel their engine tasks. Built-in default:
  one REPORTING_MANAGER step.
- **Admin** (/api/hr/attendance/open-shifts, canManageAttendance): publish /
  list (with claim counts) / detail (with claims) / cancel (cancels pending
  claims' engine requests). **ESS** (/me/shifts/open, self-scope): list open /
  claim (opens the engine chain in-tx) / my-claims / withdraw.
- **UI**: hr-admin Roster console gains an "Open shifts" tab (table + publish
  modal + claims drill-in + cancel); ESS shifts page gains an "Open shifts"
  section (claimable list + Claim + my-claims with withdraw).
- Existing roster grid/rotation/publish and the SHIFT_SWAP path are byte-for-
  byte untouched; the recompute path is unchanged for non-claim rosters
  (goldens pass).

## Manual test (staging)
1. Roster → Open shifts → Publish (date, shift pattern, headcount 1).
2. ESS → Shifts → Open shifts → Claim → the employee's manager approves in the
   Approvals inbox → the shift flips FILLED, the claimant's roster gets the
   day, and the other claimants are auto-rejected.

## E2E evidence
`qa/e2e/e2e-p4-openshift.js` on live staging: publish open shift → ESS sees +
claims (engine request opened) → double-claim 409 → manager Aarav approves via
the inbox → shift FILLED + claim APPROVED (consumer materialized the roster
day) → cleanup. Units: openShiftClaim 25 (fill/auto-reject/transitions);
derive goldens 27 + roster 10 + rotation 27 + otPreApproval 19 + resolver 8
unchanged.

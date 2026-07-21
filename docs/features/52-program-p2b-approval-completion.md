# Feature 52 — Master Program Phase 2 Wave B: SEPARATION · PAYRUN · OFFER (CLOSES PHASE 2)

Part of the locked program (docs/MASTER-PLAN-CUSTOM-DYNAMIC.md). With Wave A's
six modules, this completes the approval fabric: **all 17/17 WorkflowModules
now have registered engine consumers** — every approval in the platform can be
tenant-authored (scoped chains, priorities, SLAs) through one designer.

## SEPARATION (FnF approval)
- `computeFnf` landing on FNF_COMPUTED (re)opens a SEPARATION request — a
  recompute CANCELS the prior open request and opens a fresh one, so the
  approver always decides on the CURRENT snapshot; `approvalRequestId` (a dead
  column until now) stores the live request id.
- The FnF PayRun mint + FNF_APPROVED flip is extracted into ONE shared core
  (`_mintFnfApproval`) used by both the direct approve-fnf route and the new
  `consumers.separation` onApprove — byte-identical on either path, and
  IDEMPOTENT on (status FNF_COMPUTED ∧ no fnfPayRunId), closing the
  double-PayRun risk from the audit.
- The route keeps its fail-closed initiator≠approver SoD; the engine branch
  drives recordDecision when a request is open (legacy fallback otherwise).
  onReject leaves the case at FNF_COMPUTED for rework. Built-in default chain:
  one PAYROLL_MANAGER step (mirrors the canApprovePayroll gate).

## PAYRUN (delegation, never duplication)
- The run's hardened maker-checker (four-eyes, STALE_TOTALS, OPEN_BLOCKERS —
  payroll/payrun.js) STAYS the guard authority. The engine adds inbox
  visibility + tenant-authored chains:
  - submitRun opens a PAYRUN request (best-effort — a request failure never
    undoes the submit) and stamps `PayRun.approvalRequestId`.
  - the legacy /approve route runs `service.approveRun` FIRST (all guards),
    then marks the open request decided.
  - inbox onApprove DELEGATES to `service.approveRun` — a guard failure
    (e.g. STALE_TOTALS) throws, rolling back the decision so the request stays
    PENDING and the approver sees the real error. onReject delegates to
    `service.sendBackRun` with the decision comment.
  - sendBack / cancel / reopen close any open request.
  Built-in default: one PAYROLL_MANAGER step.

## OFFER (dormant states activated)
- The schema's unused PENDING_APPROVAL/APPROVED offer states become real:
  when a tenant authors an OFFER chain (built-in default is AUTO_APPROVE —
  behaviour unchanged until then), `sendOffer` on a DRAFT parks it
  PENDING_APPROVAL + opens the request (202); onApprove flips APPROVED so send
  can proceed; onReject/onCancel return it to DRAFT. The candidate-facing
  send/accept SoD (panellist/scorer conflict) is untouched.

## Manual test (staging)
1. Initiate a separation → compute FnF → the Approvals inbox shows the
   SEPARATION request; recompute → the old request is superseded; the
   initiator's approve is blocked (SoD); a payroll approver approves → the FnF
   PayRun appears once (second approve 409s).
2. Author a PAYRUN chain with an extra step → submit a run → the request
   appears in the inbox; an inbox approve enforces STALE_TOTALS/four-eyes
   exactly like the button.
3. Author an OFFER chain with an HR step → sending a draft offer returns
   "awaits internal approval"; approve from the inbox → send proceeds.

## Product fixes the E2E forced (riding this commit)
- **Clearance-lane lockout**: in a maker/checker tenant NO persona could clear
  the finance lane (route required canViewEmployees; the lane's designated
  canApprovePayroll holder lacked it; system roles are clone-to-edit; Super
  Admin sessions are not tenant-bound). The clearance route now admits either
  key, and updateClearance widens scope to ALL for payroll-approvers — the
  per-lane permission checks are unchanged.
- **codes.js null-ctx hotfix** (see docs/features/50 regression note): the
  P1.7 token expansion crashed every token-less allocateCode mint
  (SEP/ONB/LTR/EXP/HD) — `ctx = {}` parameter defaults don't apply to an
  explicit null. Fixed + regression suite codes.unit.test.js (7 checks).

## E2E evidence
`qa/e2e/e2e-p2b.js` on live staging: **18 pass / 0 fail** — separation
initiate (directory-wide subject rotation; one case per employee per UTC day)
→ all 5 clearance lanes incl. finance BY ITS OWN PERSONA → compute opens the
request (PENDING) → recompute supersedes (old CANCELLED, new PENDING) →
initiator approve blocked 403 (SoD) → checker approve via the engine branch →
FNF_APPROVED + FnF PayRun minted → second approve 409 (no double mint) →
OFFER def create/steps/delete + payroll list smoke → FULL cleanup (FNF run
cancelled, separation cancelled, employee back to ACTIVE).
All seven program E2E suites are now persisted in-repo at `qa/e2e/`.
Regression: workflowResolver 8/8 (incl. new bespoke-default assertions),
conditions 14/14, codes.unit 7/7, all 17 consumers registered, full route
graph loads.

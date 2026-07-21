# Feature 51 — Master Program Phase 2 Wave A: approval-engine onboarding (6 modules) + scoped workflow designer

Part of the locked program (docs/MASTER-PLAN-CUSTOM-DYNAMIC.md). Before this,
only 8 of 17 WorkflowModules routed through the Feature-10 approval engine —
the rest flipped status directly, so tenant-authored chains were decorative
for them. Wave A onboards SIX: **LOAN, TIMESHEET, ATTENDANCE_REGULARIZATION,
COMPENSATION, ASSET, DOCUMENT_SIGN** (Wave B: SEPARATION, OFFER, PAYRUN).

## The pattern (the leave consumer's, applied consistently)
- **Submit opens an ApprovalRequest** in the same tx (module, entityType,
  entityId, requesterEmployeeId, resolver ctx incl. amount/departmentId/
  employeeLevel=gradeId/locationId from the current EmploymentRecord).
- **Legacy decide endpoints drive `engine.recordDecision`** (systemActor —
  their existing permission gate stays the authz; approvals-inbox decisions
  enforce chain membership + engine SoD). Rows with no open request
  (pre-engine) keep the direct path.
- **Consumers carry the domain effect inside the engine tx**, guarded by
  conditional state checks so duplicate fires / races are no-ops.
- **Behaviour-preserving BUILT_IN_DEFAULT chains** (workflowResolver):
  LOAN + COMPENSATION → one HR step; TIMESHEET + ATTENDANCE_REGULARIZATION →
  reporting manager; ASSET + DOCUMENT_SIGN → AUTO_APPROVE (no approval existed
  — nothing changes until a tenant authors a chain).

## Per-module notes
- **LOAN** (consumers.loan.js): onApprove regenerates the EMI schedule +
  stamps totals (controller's exact math via exported `_buildSchedule`);
  onReject stores the ApprovalAction comment as rejectReason; onCancel drops
  installments. Cancel route closes any open request via `engine.cancel`.
- **TIMESHEET** (consumers.timesheet.js): stamp-only flips; request-cancel
  returns the sheet to DRAFT; LOCK stays a manual payroll-period step.
- **ATTENDANCE_REGULARIZATION** (consumers.regularization.js): onApprove
  materializes MANUAL IN/OUT punches (deduped on regularizationRequestId) and
  re-derives the day via `recompute` inside the engine tx. The previously
  MISUSED `approvalRequestId` column (it held an approver-id routing hint) now
  stores the REAL ApprovalRequest id.
- **COMPENSATION** (consumers.compensation.js): onApprove = the PROPOSED→
  EFFECTIVE supersession (close prior isCurrent, flip new) — engine and legacy
  paths share one implementation, closing the double-supersession risk;
  onReject/onCancel → REJECTED/WITHDRAWN. Maker/checker SoD unchanged
  (fail-closed proposer≠approver on the direct route; engine SoD on inbox).
- **ASSET** (consumers.asset.js): the consumer CREATES the assignment on
  approval (asset → ASSIGNED atomically); AUTO default terminalizes inside the
  assign tx → 201 with the same response as before; an authored chain returns
  202-pending. Reject/cancel create nothing.
- **DOCUMENT_SIGN** (consumers.documentSign.js): gates envelope DISPATCH (the
  only non-conflicting seam — signing itself is the signer-token flow). A
  pre-resolve keeps the pure-AUTO default on the historical direct path
  (invite tokens still ride the API response byte-identically); an authored
  chain → 202-pending, and on approval the consumer creates the envelope and
  emails each signer their sign link (new `HR_ESIGN_INVITE` template).

## Scoped workflow designer (frontend)
The approvals admin now supports MULTIPLE definitions per module: per-module
definition list (scope summary, priority, Live/Draft/Default badges), "New
scoped chain" modal (departments/grades/locations pickers, priority), the
ChainBuilder canvas edits the specific definition, publish/delete with
default-protection copy, and a resolution explainer (priority asc + specificity,
scope-less published def = fallback). Backend API already supported all of it.

## Manual test (staging)
1. Loans: create → submit → Approvals inbox shows the request (HR chain) →
   approve from the legacy button → EMI schedule appears; reject another with
   a reason.
2. ESS: file a missed-punch regularization → admin approves → punches + the
   day's attendance appear.
3. Compensation: propose a revision as maker → maker cannot decide own
   proposal → Finance checker approves/rejects.
4. Assets: assign — instant as before; author an ASSET chain with a real
   approver → assign returns "awaits approval".
5. Approvals → any process → "New scoped chain" with a department scope +
   priority 10 → publish → matching requests route to it, others fall back.

## E2E evidence
`scratchpad/e2e-p2a.js` on live staging (+ read-only DB verification of the
ApprovalRequest rows): loan approve path (request PENDING→APPROVED, 6 EMI
rows by the consumer) + reject with reason; ESS regularization
(approvalRequestId = real request id, punches materialized, day re-derived
PRESENT); timesheet generate→submit→approve through the engine; compensation
propose (request opened) + maker-blocked + checker reject; asset AUTO
201-instant with terminal APPROVED request; scoped-def create/steps/publish/
list/delete. Regression: workflowResolver 7/7, conditions 14/14, derive
goldens 27+10, fixes.unit — all green.

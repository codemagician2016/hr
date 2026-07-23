# Feature 64 — Master Program Phase 4 workforce wave C: OT pre-approval (21st engine module)

Overtime moves from purely after-the-fact auto-computation to an optional
manager pre-authorization gate, wired through the Feature-10 approval engine.
Audit build-order #4.

## What shipped
- **OvertimeRequest** model (one live request per employee-day; a decided row
  is re-opened on resubmit) + `WorkflowModule.OVERTIME` + `OvertimeRule.
  requirePreApproval` (default false).
- **consumers.overtime.js** (mirrors comp-off): onApprove/Reject/Cancel flip
  the request status (conditional-flip idempotent, PENDING-guarded).
  Registered — **21/21 modules now engine-wired**. Built-in default: one
  REPORTING_MANAGER step (48h ESCALATE) — the manager authorizes OT.
- **ESS**: POST/GET/cancel /me/attendance/overtime (submit opens the engine
  request in-tx + stamps approvalRequestId; cancel → engine.cancel). Manager
  decides through the existing /approvals inbox → the consumer flips APPROVED.
- **The gate** (attendance/service.js + derive.js): recompute batch-loads
  APPROVED OvertimeRequests → per-date authorized-minutes map → derive's
  overtime() caps otRaw to the authorized minutes (0 if none) ONLY when the
  resolved rule has requirePreApproval. When it's off, OT is **byte-for-byte
  unchanged** (27 derive goldens pass identically — regression-critical).
- **UI**: ESS attendance page gains an Overtime tab (request form
  hours+minutes + reason, my-requests list, withdraw-while-pending); admin
  Work-policies page gains the requirePreApproval toggle on the OT-rule editor
  + a read-only OT-requests queue (decisions ride the Approvals inbox).

## Bonus fix (surfaced by the E2E)
The approvals-inbox module filter (`approvals.controller.js` MODULES set) was a
**stale hardcoded list** that had never been updated as modules were added
across Phases 2–4 — so filtering the inbox by OVERTIME (or recognition,
comp-off, award, …) returned "Unknown module." Now derived from the Prisma
`WorkflowModule` enum, so it can never go stale again.

## Manual test (staging)
1. Settings → Attendance → Work policies: turn on "require pre-approval" on the
   OT rule.
2. ESS → Attendance → Overtime: request 2h on a day → it appears PENDING; the
   employee's manager sees it in Approvals → approve.
3. Admin OT-requests queue shows it APPROVED. With pre-approval on, a payroll
   recompute credits OT only up to approved minutes; with it off, OT is
   unchanged.

## E2E evidence
`qa/e2e/e2e-p4-ot.js` on live staging: **15/15** — OT rule with
requirePreApproval, ESS submit → engine request opened (PENDING +
approvalRequestId), admin visibility, manager Aarav approves via the inbox →
consumer flips APPROVED, separate ESS cancel → CANCELLED, cleanup. Units:
otPreApproval 19 (gate math; no-pre-approval path == golden); derive goldens
27/27 + roster 10 + fixes 46 + geofence 37 + latePenalty 13 unchanged.

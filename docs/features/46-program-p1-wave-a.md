# Feature 46 — Master Program Phase 1, Wave A (pay calendars · payslip controls · OT/late policies)

Part of the locked "fully custom & dynamic" program (docs/MASTER-PLAN-CUSTOM-DYNAMIC.md).
Wave A delivers P1.1 (pay-calendar UI), P1.2 (payslip branding/password/hold) and
P1.5 (overtime + late-coming policy console).

## What shipped

### P1.1 Pay calendars (per entity)
- CRUD API `GET/POST/PATCH/DELETE /api/hr/payroll/calendars` (`canRunPayroll`).
  Frequencies MONTHLY/WEEKLY/BIWEEKLY/SEMIMONTHLY; India entities are
  MONTHLY-only (422 otherwise). Pay-day / attendance-cutoff rules:
  `FIXED_DOM` (1–31, snaps to month end), `LAST_WORKING_DAY`,
  `N_DAYS_AFTER_PERIOD_END` (0–15). DELETE hard-deletes when unused,
  deactivates when PayRuns reference it (response says which).
- Admin UI: Settings → Payroll → "Pay calendars" table + modal
  (entity/code/name/frequency/rules; code+entity immutable after create).

### P1.2 Payslip presentation & control
- **Brand**: `renderPayslipPdf` accepts `{brand, pdfPassword}`; TenantBrand
  (tenant-level, active) primary/accent colors override the hardcoded palette
  (HEX-validated), logo fetched (≤1MB, 3s abort, in-process cache) and drawn in
  the header. Fail-soft everywhere: bad brand → stock render.
- **PDF password**: `GET/PATCH /api/hr/payroll/payslip-settings` with mode
  `NONE|DOB` (stored at `Business.featureFlags.payroll.payslipPdfPassword`).
  DOB mode encrypts the PDF with user+owner password `DDMMYYYY` of the
  employee's date of birth. (Bug found by E2E: the shared PDF identity resolver
  didn't select `dateOfBirth` — fixed in `resolvePayslipPdfIdentity`.)
- **Per-line hold**: `POST /runs/:id/lines/:lineId/hold|release`
  (`payslipHeldAt/By/Note` on PayRunLine; 409 on double-hold). Held lines are
  invisible in ESS list AND 404 on PDF. Admin UI: Hold/Release buttons + amber
  "Held" chip on both the pay-lines table and the Disburse payslips table.

### P1.5 Overtime + late-coming policy console
- OT rules CRUD `/api/hr/attendance/overtime-rules` (threshold minutes,
  weekday/weekly-off/holiday multipliers, optional monthly cap, rounding;
  optional entity/location scope, most-specific wins).
- Late rules CRUD `/api/hr/attendance/late-rules` — `allowedLatesPerMonth`
  (0–31) free lates, then every `perLates` (1–31) lates deduct
  `penaltyDayFraction` ∈ {0.25, 0.5, 1} day.
- **Late-penalty engine** `attendance/latePenalty.js` (pure, 13 unit checks):
  chronological month-context pass inside `recompute()`; penalty applied ON the
  offending day via `lopFraction`, idempotently reconciled through an
  `exceptionsJson.latePenalty` marker (base = stored − marker; new = min(1,
  base + computed)). Locked rows skipped; punch edits that remove a LATE_IN
  shift/remove downstream penalties automatically.
- Admin UI: NEW Settings → Attendance → Work policies page (nav entry,
  `canManageAttendance`) with live plain-words rule preview.

## Schema
- `PayRunLine`: + `payslipHeldAt DateTime?`, `payslipHeldBy`, `payslipHoldNote`.
- NEW `LateComingRule` (businessId, entityId?, locationId?,
  allowedLatesPerMonth=3, perLates=1, penaltyDayFraction=0.5, isActive).
- (PayCalendar model pre-existed; it now has routes + UI.)

## Manual test (staging)
1. Settings → Payroll: create a pay calendar for the IN entity — WEEKLY must be
   rejected; FIXED_DOM 28 pay day + cutoff 21 saves; delete removes it.
2. Settings → Payroll → Payslip settings: switch to "DOB password", download a
   payslip from ESS (m-demo-staging) — PDF asks for password = DDMMYYYY of DOB.
3. Payroll → open a run → Hold a line with a note — employee's payslip list no
   longer shows it, direct PDF URL 404s; Release restores it.
4. Settings → Attendance → Work policies: create a late rule (3 free, every
   late 0.5 day) — preview sentence updates live; recompute month attendance
   for an employee with 4+ LATE_IN days and check lopFraction on the 4th.

## E2E evidence
`scratchpad/e2e-wavea.js` against live staging: **25 pass / 0 fail**
(calendar CRUD + IN-WEEKLY 422 + bad-DOM 400; DOB → `/Encrypt` present in ESS
PDF bytes; hold → invisible + 404 → release → visible; OT/late CRUD +
validation; full cleanup). Unit: `latePenalty.unit.test.js` 13/13.

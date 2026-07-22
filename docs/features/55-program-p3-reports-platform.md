# Feature 55 — Master Program Phase 3 wave 3: Reports Platform (builder · exports · scheduler · dashboards)

Reverses the v1 "no report builder, fixed catalogue" decision
(docs/01-product-requirements.md §reporting). Built as a GAP-FILL over the
audit's reuse map: the statutory-register trio (definition JSON → projector →
exporters → export log) generalized into a tenant-facing platform.

## What shipped

### Shared tabular export layer
`reports/export/tabular.js` — one pure `{title, columns, rows, totals?}` →
CSV / XLSX / PDF helper (formula-injection neutralisation, Excel BOM, xlsx
optional-dep with CSV fallback, pdfkit A4-landscape with repeating headers +
page numbers, money/date formatting at export time). The four FIXED reports
(payroll register, statutory summary, headcount, leave liability) gained
`/export?format=` endpoints through it.

### Report builder over a dataset registry
- `reports/datasets.js` — 10 whitelisted datasets (employees, attendance_days,
  leave_requests, leave_balances, payroll_lines, expenses, loans,
  assets_assignments, helpdesk_tickets, recognition_ledger), each declaring
  columns/filters/groupable metadata + a prisma fetch that ANDs businessId AND
  the caller's F1 scope (fail-closed on NONE).
- `ReportDefinition` (chosen columns, filters, groupBy, sort, isShared,
  soft-delete) + `builder.service.js`: registry validation with allowed-list
  400s, 10k-row hard cap with `capped` flag, grouping (count + numeric/money
  sums), typed sort, pagination; export via the shared lib.
- Routes under /api/hr/reports: /datasets, /definitions CRUD (PATCH/DELETE
  creator-only; isShared visible to all viewers), /definitions/:id/run,
  /definitions/:id/export, /run-adhoc (builder preview).

### Scheduled email delivery
`ReportSchedule` (DAILY/WEEKLY/MONTHLY + anchor + hourUtc, format,
recipients, isActive, lastRunAt/lastStatus) + hourly runner (overlap-flagged;
pure due-window math incl. short-month clamping — a day-31 anchor fires
Feb 28/29; one attempt per window, fail-soft per schedule). Delivery renders
under the CREATOR's F1 scope (moved/deleted creator → fail-closed empty) and
emails the file as a real attachment (fixed a latent email.js bug: Buffer
attachments were utf8-mangled — XLSX/PDF would have arrived corrupt).
/schedules CRUD + /schedules/:id/run-now.

### Console (hr-admin /reports, 4 tabs)
Fixed reports (legacy 3 + the previously-unsurfaced Leave liability, export
split-buttons, fail-soft SVG dashboard strip: headcount-by-dept bars, latest
payroll totals, leave-liability value) · Report builder (dataset → ordered
column chips → typed filters → group/sort → capped preview → save with
share toggle) · Saved reports (run/export/edit/delete with creator-only
controls, schedule shortcut) · Schedules (cadence sentences, lastRun status
colors, run-now/pause/resume; visible only with canScheduleReports).

### RBAC
New keys `canViewReports` (builder + datasets; fixed reports accept it OR the
legacy canViewPayrollReports) and `canScheduleReports` — granted
Owner/HR-Admin/Finance. JSON keys, no migration.

## Manual test (staging)
1. Reports → Builder: dataset Employees → pick columns → group by status →
   Preview → Save (shared) → Export XLSX (opens in Excel, no mangling).
2. Saved reports → Schedule… → Daily 09:00 UTC, CSV, your email → Run now →
   the report lands in your inbox as an attachment; lastRun shows SENT.
3. Fixed reports → Leave liability renders; every fixed view exports CSV/XLSX/PDF.
4. A Finance login still reads the fixed reports (legacy key OR-gate).

## E2E evidence
`qa/e2e/e2e-p3-reports.js` on live staging: **19 pass / 0 fail** — registry
(10 datasets), ad-hoc run + allowed-list 400s + grouped run, definition save/
run, CSV (text/csv) + XLSX (PK zip magic) + PDF (%PDF) exports, schedule
create → run-now → REAL email delivery (sent=1, lastStatus SENT), fixed
headcount export, Finance OR-gate, full cleanup. (E2E caught: the employees
dataset selected `designation.name` — Designation uses `title`; fixed +
delta-deployed.) Units: tabular 49 + builder 75 + scheduleDue 39 = 163;
existing aggregations 9/9.

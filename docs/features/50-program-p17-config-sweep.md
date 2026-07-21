# Feature 50 — Master Program P1.7: config small-items sweep (CLOSES PHASE 1)

Part of the locked program (docs/MASTER-PLAN-CUSTOM-DYNAMIC.md). Seven small
hardcode/gap items from the audit hotlist, closing Phase 1 (config-critical).

## What shipped

1. **Document expiry automation** — nightly 03:30 sweep over
   `EmployeeDocument.expiresAt` (the field existed since Feature 4; nothing was
   proactive) + `BusinessDocument`: notifies the employee AND HR at T-30/7/1/0
   via new `HR_DOCUMENT_EXPIRING_SOON` (exact-day match = deduped; per-row
   fail-soft; tenant-editable body like every template since P1.6).

2. **Restricted-holiday elections** — `Holiday.isRestricted` + the engines'
   `optedRestrictedDates` plumbing existed but NOTHING populated it (restricted
   holidays never counted). New `RestrictedHolidayElection` store; ESS
   endpoints (list with allowance/used, elect with duplicate-409 +
   past-date/quota-422 guards, withdraw future-only); admin allowance setting
   (`/attendance/rh-settings`, featureFlags.leave.restrictedHolidayAllowance,
   default 2); wired into attendance recompute AND leaveContext so elected
   dates now flow into status/LOP + leave netting. ESS Schedule tab gets the
   picker card; Work-policies page gets the allowance setting.
   (E2E caught two bugs: Employee has no entityId/locationId scalars — org
   context resolves via the current EmploymentRecord; and duplicate-election
   had to check before the quota gate to 409 correctly.)

3. **`GET /api/hr/meta` + `/api/hr/me/meta`** — single enum-vocabulary
   endpoint (genders, marital, employment types, dependant relations,
   education, separation types, document categories, holiday types, payout
   banks, address types — values verified against schema.prisma). Frontends
   swapped their hardcoded arrays (ess profile; hr-admin lifecycle, leave,
   recruitment, separations) via cached hooks with fallbacks. Kills real
   drift: recruitment offered a non-existent TEMPORARY type and was missing
   APPRENTICE/CASUAL/CONSULTANT/FIXED_TERM.

4. **Entity.defaultPayoutBank** — per-entity default bank-file format;
   `createBatch` uses it when the request names no bank. Editable on the
   Settings→Payroll entity cards.

5. **Entity.noticeDivisorDays** — per-day divisor for notice pay-in-lieu/
   recovery (fnf.js hardcoded 30); NULL keeps the 30-day convention; the
   statutory 26-day gratuity/encashment basis untouched.

6. **Employee-number tokens** — the code prefix now expands `{ENTITY}`,
   `{DEPT}`, `{YYYY}`, `{YY}` ("EMP-{ENTITY}-{YY}-" → "EMP-BLR-26-000042"),
   threaded through employee create (real entity/dept codes) with matching
   server + client previews (sample ENT/DEPT). Prefix limit 24→40. Full
   back-compat: token-less prefixes mint identical codes.

7. **compVisibility in roles UI** — the backend always supported it; the roles
   editor now exposes ABSOLUTE / RANGE_ONLY / SELF_ONLY / NONE with a table
   column (frontend-only fix).

## Manual test (staging)
1. Settings → Attendance → Work policies: set Restricted holidays allowance 1.
   ESS → Attendance → Schedule: elect a restricted holiday; try a second (quota
   message), re-elect the same (already-elected message), withdraw.
2. Settings → Payroll entity card: pick ICICI + divisor 26 → save; disbursement
   batch form preselects ICICI.
3. Settings → Employee number: prefix `EMP-{ENTITY}-{YY}-` → preview
   EMP-ENT-26-000001; create an employee → real entity code lands in the code.
4. Settings → Roles: set Compensation visibility RANGE_ONLY on a role.
5. Upload an employee document expiring in 7 days → after 03:30 an expiry
   email lands (employee + HR).

## E2E evidence
`scratchpad/e2e-p17.js` on live staging: **23 pass / 0 fail** (meta operator +
ESS, allowance setting + bounds, RH lifecycle: create→list→elect→duplicate
409→quota 422→withdraw, entity bank/notice save+clear, token preview
expansion, compVisibility create/PUT/delete roundtrip, full cleanup).
Regressions local: derive goldens 27+10, leave calendar 18, latePenalty 13.

## Post-ship regression note (fixed same day)
The token-expansion change introduced a null-ctx crash: `expandTokens(prefix,
ctx = {})` — a parameter default does NOT apply to an explicit `null`, and
`allocateCode` passes `tokenCtx = null` for every token-less caller. Every
allocateCode-based mint (SEP/ONB/LTR/EXP/HD codes) 500'd between the P1.7 ship
and the fix (caught by the Phase-2B separation E2E, staging only). Fixed with
`const c = ctx || {}` + a dedicated regression suite
(`lifecycle/__tests__/codes.unit.test.js`, 7 checks incl. the null path).
Lesson: the P1.7 E2E exercised the settings PREVIEW (3-arg format) but never a
real allocation — E2Es must hit the actual mint path of a changed allocator.

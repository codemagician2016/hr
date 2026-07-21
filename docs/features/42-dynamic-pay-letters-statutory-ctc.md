# Feature 42 — Dynamic pay-days, self-serve letters, work-state statutory, CTC lock (India-first)

The "custom and dynamic, not hard-coded" pass, driven by the owner's asks: how salary days are
counted must be a company choice (5-day vs 6-day weeks, factory 26 basis…), HR must decide which
letters employees can request, statutory jurisdiction must follow the work location, and an agreed
CTC structure must be lockable. Built on the audit finding that the ENGINES already supported most
of this — the configuration surfaces didn't exist.

## 1. Pay-days / salary calculation basis (researched, finalised)

**Industry practice** (greytHR, Keka, Zoho Payroll, RazorpayX — see sources in the audit chat):
every major product ships the divisor as a TENANT SETTING with the same three families:
calendar days (28–31, weekends paid — most common for salaried), fixed days (30 or the factory
26 — constant per-day rate), and working days (Keka's model — divisor = the month's actual
working days; a full-month absentee earns ₹0). Indian law mandates none; it requires consistency.

**Finalised design (as-built):**
- Basis lives on **`Entity.prorationBasis`** (tenant default per legal entity), now writable from
  **Settings → Payroll** (new page) via the org entities API. Values:
  `CALENDAR_DAYS` (default) · `WORKING_DAYS` · `THIRTY_DAY_STANDARD` · `TWENTYSIX_DAY_STANDARD`
  (NEW — the engine's FIXED_26 was previously unreachable) · per-component overrides unchanged.
- The divisor is FROZEN with each run's attendance inputs (`freeze.js`) so a mid-year basis change
  never rewrites history; every payslip records the exact fraction in its trace.
- **Working days are PER-EMPLOYEE dynamic, never company-hardcoded:** divisor = calendar −
  that employee's `WEEKLY_OFF` days (from their assigned shift's `weeklyOffDays` — any 5-day /
  6-day / custom pattern) − their location's holiday-calendar days.
- **Working-day granularity** (owner ask): shift patterns define the week; assignment now works
  **company-/entity-wide, department-wide, an explicit list, or per employee** —
  `POST /shifts/:id/assign` accepts `{entityId}` | `{departmentId}` | `{employeeIds[]}` |
  `{employeeId}` (bulk = best-effort; overlapping windows are skipped and reported). Rosters
  still override single days.

Worked example (₹30,000; 30-day month; 22 working days; 4 days absent):
calendar → ₹26,000 · working-days → ₹24,545 · fixed-30 → ₹26,000 · fixed-26 → ₹25,385.

## 2. Letters — employee self-service is template-driven

- `LetterTemplate.selfServe` (new): HR toggles "Employee can request" per template on the
  templates console. ESS/mobile fetch `GET /me/letters/requestable` — **published + selfServe
  templates of THIS tenant, nothing hard-coded** (the old dual hard-coded lists are retired).
- Requests bind the real template (`DocumentRequest.letterTemplateId`), validated against the
  self-serve library (a forged id → 404), and display the template's actual name.
- Free-form requests ("Other" + purpose) are now **tenant-switchable**:
  `Business.featureFlags.letters.allowCustomRequests` (default ON for back-compat), toggled at
  `GET/PATCH /api/hr/letters/templates/settings`, enforced server-side (403 `custom_disabled`).
- Legacy kind-based requests still accepted (mobile back-compat).

## 3. Statutory — work-location state (wiring fix)

`Location.stateCode` documented "drives Professional Tax slab selection" but payroll never read
it — a Pune-entity employee posted to Bengaluru was taxed on MH slabs. Fixed precedence, applied
at pay-run preload from the current EmploymentRecord's Location:
**`StatutoryProfile.ptStateCode` (explicit override) > work Location.stateCode > employee
address state > entity registered state** (LWF follows unless `lwfStateCode` overrides).

Roadmap (explicitly out of scope here, needs its own program): move the in-code PT/ESI/PF/LWF
versioned rule tables (13 PT states, 16 LWF states in `compliance/india.js`) into DB-backed,
super-admin-editable rule rows per docs/05 §15 — today a slab change requires a deploy.

## 4. CTC — lock + what already existed

- Custom CTC structures per tenant (CtcPolicy builder + SalaryComponent master), maker-checker
  effective-dated revisions (`ANNUAL_REVISION` etc.), automatic retro **arrears**, and role-based
  comp visibility ALL pre-existed (audit).
- NEW — **CTC lock**: `CtcPolicy.isLocked` — any comp maker may lock; edits/deletes on a locked
  policy return **423** with a clear message; **only a `canApproveCompensation` holder may
  unlock** (SoD — the maker can't silently unfreeze). `POST /ctc-policies/:id/lock|/unlock`.
- Roadmap: bulk **IncrementCycle/IncrementProposal** (budget pools, calibration, batch increment
  letters) — the models exist and are unwired; increments today are per-employee revisions.

## 5. Manual QA checklist (staging)

1. Settings → Payroll: set an entity to Working days; freeze/run payroll for a test period →
   payslip trace divisor = that month's working days for each employee's own shift.
2. Set Fixed 26 → divisor 26 on the next run. Legacy runs unchanged.
3. Letters templates: toggle "Employee can request" on 2 templates → ESS Letters shows exactly
   those; toggle OFF custom requests → "Other" disappears and a forced POST returns 403.
4. Request a template-bound letter → HR queue shows the template name; fulfil → employee
   downloads.
5. Assign a shift to a whole department effective next Monday → members' rosters/working days
   follow it; one member with an overlapping personal assignment is reported skipped.
6. Employee posted to a location in another PT state → next run deducts that state's PT slab
   (check payslip PT line + trace).
7. Lock a CTC policy → edit returns "locked" (423); unlock as Finance (approver) → edit works;
   maker cannot unlock.

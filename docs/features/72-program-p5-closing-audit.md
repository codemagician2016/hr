# Feature 72 — Master Program Phase 5f: closing zero-hardcode audit + bug sweep

Final wave. A verification pass that confirms every item on the original elite-team
hardcode hotlist is closed (or explicitly deferred with a plan), sweeps for new
hardcodes, and snapshots the test-suite health. **This closes the 5-phase "fully
custom & dynamic" program.**

## Hotlist — every item resolved

| # | Original hotlist item (hardcoded / missing) | Status | Where closed |
|---|---|---|---|
| 1 | `payslipPdf.js` colors hardcoded, no tenant brand | ✅ closed | P1.2 — `renderPayslipPdf({brand})` overrides `COLOR.brand/accent` from `TenantBrand.primaryColor/accentColor` (default palette is just a fallback) |
| 2 | PayCalendar seed-only, zero routes | ✅ closed | P1.1 — GET/POST/PATCH/DELETE `/payroll/calendars` |
| 3 | `lifecycle/templates/seed.js` checklists baked in | ✅ closed | P1.4 — lifecycle template CRUD (`/lifecycle/templates` + seed-defaults) |
| 4 | `provision.js` probation hardcoded 90 | ✅ closed | P1.4 — resolves self > offer > tenant `ProbationPolicy` > 90 fallback |
| 5 | `OvertimeRule` no write path | ✅ closed | P1.5 — POST/PATCH `/attendance/overtime-rules`; P4 added OT pre-approval |
| 6 | `MessageTemplate` global (no businessId) | ✅ closed | P1.6 — `MessageTemplate.businessId` + tenant override router |
| 7 | `ChainBuilder` edits module-default only | ✅ closed | P2 — scoped workflow designer; `WorkflowDefinition.entityId` scoping |
| 8 | `registerConsumers.js` = 8 of 17 modules | ✅ closed | P2→P4 — **22** consumer modules registered (all live modules) |
| 9 | `countryContext.js` IN-only gate | ✅ closed | P5a — `REGISTRABLE_HR_COUNTRIES = ['IN','NZ']` |
| 10 | `disbursement.service.js` hard IN-gate | ✅ closed | P5a — `resolveDisbursementRoute`; P5e — NZ persists |
| 11 | payout adapters TODO stubs | ✅ resolved | P5e — config-ready seam (stub default + env-gated RazorpayX/Cashfree); live calls deferred by design |
| 12 | N+1 `payroll service.js:885` per-employee comp lookup | ✅ closed | P5d — `prefetchCurrentCompensations` (parity-proven, 0 mismatch) |
| 13 | N+1 `attendanceSweep → recompute` ~8 q/emp | ⏳ deferred | P5d — documented deferral (canonical punch-driven rollup; needs an adversarial verifier) |

Beyond the hotlist, the program also built (per phase): full salary-component authoring
(SLAB + all kinds), tax-template/notification-prefs UIs, approval consumers for all
modules, surveys/eNPS + R&R + reports + SSO/SCIM, 9 mobile modules, OT/open-shift/
variable-pay/loan-interest engines, custom fields (P5b), field-level permissions (P5c).

## Fresh-hardcode sweep (this wave)
- **No hardcoded tenant IDs** anywhere in `backend/src/hr` (grep for `businessId: '<uuid>'`
  → empty).
- **No stray country/currency/hex literals** in the P5 code (rbac, custom fields,
  disbursement NZ, payroll prefetch).
- **No unresolved TODO/FIXME/HACK** in P5-touched paths — the only `TODO(live)` markers
  are the intentional, documented payout-gateway network calls (P5e).

## Test-suite health snapshot
- Payroll goldens (money-path integrity): **all 9 green** — india 288, arrears 48, nz
  63, ptStates 55, variance 39, calendar 31, + bonus / lwp / variablePay.
- P5 units: fieldAccess **21/21**, customFields **22/22**, nzPersistence **2/2**,
  disbursement golden **25/25**.
- Live E2E coverage across P5: NZ-unlock IN-regression 7/7, custom fields 27/27,
  field-access 19/19, payroll-perf 9/9, + the SSM compensation-parity probe (66/66,
  0 mismatch).

## Tracked open follow-ups (carried forward, non-blocking)
1. Custom-field `HR_APPROVAL` ESS policy — route a self-edit through the F10 engine (P5b).
2. Field-perms: gate the standalone bank/statutory write endpoints + per-field READ
   greying in the admin edit form (P5c).
3. Batch `attendanceSweep` shared per-tenant-day inputs; batch the payroll loop's
   FBP-overlay + §192 tax-override resolvers (P5d).
4. Live payout-gateway calls (RazorpayX/Cashfree) + an NZ-tenant end-to-end walkthrough
   once an NZ staging tenant exists (P5e).

## Program status
**COMPLETE.** All 5 phases delivered, each wave E2E/parity-verified and committed on
`development`, staging-live. P1 config-critical · P2 approvals · P3 must-haves · P4
mobile+workforce · P5 hardening (a–f). The follow-ups above are documented, tracked,
and non-blocking.

# Adversarial Review — 03-data-model.md (HR & Payroll Data Model)

**Reviewer:** Adversarial Senior Reviewer (skeptic)
**Date:** 2026-06-22
**Target:** `/Users/kp/docs/03-data-model.md` (2470 → ~2640 lines after edits)
**Verdict:** needs-fixes (now corrected in-place — would be **solid** as edited)

The document is genuinely strong: 74 well-shaped Prisma models, sound effective-dating, an event-sourced leave ledger, immutable locked pay runs, versioned compliance rule tables, and accurate 2026 statutory figures. The defects were real but bounded — one systemic FK-discipline gap, a handful of missing core entities, and a few constraint/over-claim bugs. All were fixed in place.

---

## What I verified (and that held up)

### Sitepresso reuse claims — VERIFIED, citations are precise
Read `/Users/kp/sitepresso/backend/prisma/schema.prisma` (6235 lines). Every model line-number citation checked out:
- `model Business` (108), `User` (18), `BusinessRole` (3609), `BusinessLocation` (3636), `Subscription` (1500), `PricingTier` (2645), `TierFeature` (2757), `PricingAuditLog` (2780), `enum AuditAction` (2795), `ProductCategory` (722), `InvoiceCounter` (1877), `AdjustmentLedger` (1883), `SupportConversation` (2423), `SupportMessage` (2458), `InboxNotification` (2397), `NotificationConfig` (2848), `MessageTemplate` (2899), `MessageDelivery` (2943), `BudgetUsage` (2993) — all exact.
- The `BusinessPage (line 432)` and `Product (line 553)` citations point precisely at the **`businessId String`** field line (not the model header) — correct, since that table row illustrates the `businessId`/FK pattern.
- Field claims verified: `Business.shortId` (116), `Business.country // ISO-3166-1` (123), `User.signatureUrl`/`stampUrl` (37-38), `User.passwordChangedAt`/`emailVerified`/`pendingDeletionAt`/`anonymisedAt`, `amountUsd Decimal(10,2)` (1832), `providerCostUsd Decimal(10,6)` (2829), `multiplier Decimal(5,4)` (2702), `ProductPrice.currencyCode` (636).
- The "`Float` wart" claim is real: `consultationFee Float?` (59), `depositAmount Float?` (3698) confirmed.
- The "**421×**" `businessId` claim is correct as a raw occurrence count (`grep -c businessId` = 421). Slightly imprecise wording (only 121 are `businessId String` declarations across 123 models) but the headline number is honest.

### 2026 compliance figures — VERIFIED via web search against primary sources
- **NZ KiwiSaver:** 3.5% employee + 3.5% employer default from 1 Apr 2026, 16–17yo become employer-eligible, rises to 4% in 2028 — confirmed (IRD, MBIE, Business.govt.nz).
- **NZ ACC earners' levy:** 1.75% (up from 1.67%), cap **$156,641**, max levy **$2,741.22** — confirmed exactly (IRD, Calculate.co.nz, MBIE).
- **NZ min wage:** adult $23.95, starting-out/training $19.16 (80%) from 1 Apr 2026 — confirmed (MBIE, Employment NZ).
- **NZ student loan:** 12% over $24,128 annual (2026/27, unchanged) — confirmed (IRD).
- **NZ ESCT brackets** (10.5/17.5/30/33/39 at 16,800/57,600/84,000/216,000) — consistent with current law.
- **NZ KiwiSaver age cap:** compulsory employer for 16–65; "65 or over" excluded. Doc's `[16,65]` inclusive upper bound is a mild boundary imprecision (once 65, no longer compulsory) — left as-is, flagged below as a minor.
- **IN new tax regime FY25-26:** slabs (0-4L nil … >24L 30%), §87A nil up to ₹12L taxable, ₹75k standard deduction → ₹12.75L effectively nil — confirmed exactly (CBDT/ClearTax/IncomeTax dept).
- **IN EPF/EPS/ESI/Gratuity/PT** figures (12%+12%, EPS 8.33% cap ₹15k=₹1,250, EDLI/admin 0.5%, ESI 0.75%+3.25% ≤₹21k, gratuity 15/26, PT cap ₹2,500) — all consistent with current rules.

### Schema integrity — mostly sound
- Relation symmetry on aggregate roots is correct (`Entity` back-references all six children; `Employee` relation block complete; `SalaryComponent.structureLines` present).
- Effective-dating, optimistic-lock, soft-delete, and the event-sourced leave ledger are well-designed.
- Money is `Decimal` throughout; no `Float` regressions.

---

## What was WRONG / GAPS (and the fixes applied)

### CRITICAL

**C1. §1.2 "non-negotiable" tenant-FK rule violated by 16 models.**
16 models declared `businessId String` with **no `business Business @relation(...)` FK** — directly contradicting §1.2 ("Every HR table carries businessId with a cascade FK") and silently removing the claimed defense-in-depth (without the FK, a child row's `businessId` can drift from its parent's, and `prisma validate` enforces nothing). Affected: `StatutoryElectionHistory`, `PayRunLineComponent`, `AccrualRule`, `TimesheetEntry`, `ExpenseLine`, `LoanInstallment`, `EmployeeSkill`, `JobStage`, `Interview`, `Offer`, `HelpdeskMessage`, `WorkflowStep`, `ApprovalAction`, `AuditLog`, `Notification`, `NumberSequence`.
- **Fix:** Rewrote §1.2 to make the `business` relation mandatory even on child-of-child/line tables, document the `AuditLog.businessId?` nullable exception (platform actions must survive tenant deletion), and add a second CI lint ("reject any model with `businessId` but no FK"). Added the explicit `business Business @relation` field to the highest-risk models in their bodies: **`Notification`, `NumberSequence`** (no cascade parent — most dangerous), **`PayRunLineComponent`, `LoanInstallment`, `ApprovalAction`** (audit/money-critical).

**C2. Missing core entity: `SeparationCase` / FNF settlement.**
The doc referenced FNF in four places (`PayRunType.FNF`, `WorkflowModule.SEPARATION`, the offboarding asset-return checklist, and invariant #11 "cannot finalize TERMINATED with open loans/leave-encashment/asset recovery") but **never modeled the row that holds a separation**. For an IN/NZ payroll product this is statutory, not optional: IN gratuity (15/26, ≥5yr, waived on death/retrenchment) + leave encashment + notice adjustment, and **NZ holiday-pay-on-termination** (8% accrued+untaken annual leave at greater of OWP/AWE) must be persisted and provable.
- **Fix:** Added **§11A `SeparationCase`** with `SeparationType`/`SeparationStatus` enums, a settlement-component snapshot (gratuity, leave encashment, NZ holiday payout, notice recovery, loan foreclosure, asset recovery), clearance checklist, FNF PayRun link, a state machine, and the gating wiring to the `Employee → TERMINATED` guard. Added `separations SeparationCase[]` back-relation on `Employee`; updated §2 ER overview, §0.3 ownership table, and §21 invariant #11.

**C3. Entities promised in prose but never modeled.**
§12 prose described a `DocumentTemplate` table; §0.3 listed `DocumentRequest`, profile-change requests, and regularization requests as ESS writes — none were modeled. `AttendancePunch.regularizationRequestId` and `Attendance` pointed at a nonexistent request row.
- **Fix:** Added `DocumentTemplate` (+ `TemplateKind` enum), `ProfileChangeRequest`, `DocumentRequest`, `AttendanceRegularizationRequest` (+ shared `RequestStatus` enum) in §12/§12.1, with `business` + `employee` FKs and the corresponding `Employee` back-relations.

### CORRECTNESS / CONSISTENCY

**C4. §1.4 over-claim — "Every table" has `version`/`deletedAt`/`updatedAt`.**
False: 28 models lack `version`, 3 lacked `createdAt`, many lack `updatedAt`/`deletedAt` (correctly, for ledger/line tables — but the prose said "every table"). `PayRunLineComponent`, `ApprovalAction`, `NumberSequence` genuinely lacked `createdAt`.
- **Fix:** Replaced the "every table" block with an honest per-column applicability table (which roots get the full block, which tables deliberately omit each column and why). Added the missing `createdAt` to `PayRunLineComponent` and `ApprovalAction`.

**C5. `Holiday` nullable-unique gotcha — won't dedupe global holidays.**
`@@unique([businessId, entityId, locationId, date, name])` with nullable `entityId`/`locationId`: Postgres treats NULL as distinct, so two identical global (entity/location NULL) holidays both pass — duplicate public-holiday rows in payroll, a real correctness risk.
- **Fix:** Added a computed NOT-NULL `scopeKey` (`coalesce(entityId,'*')||':'||coalesce(locationId,'*')`) and moved the unique constraint onto it; documented the PG15 `NULLS NOT DISTINCT` alternative and why the derived-key approach is the portable fix.

**C6. `PayRun` unique blocks multiple off-cycle runs in a period.**
`@@unique([businessId, entityId, payCalendarId, periodStart, type])` lets only one row per type per period — but you legitimately need several `OFF_CYCLE`/`CORRECTION`/`BONUS` runs in the same period, while still enforcing exactly one `REGULAR`.
- **Fix:** Replaced with `@@unique([businessId, code])` plus a documented **partial unique index** `payrun_one_regular ... WHERE type='REGULAR'`. Updated the §7.2 invariant prose accordingly.

**C7. Dangling `WeekOffPattern` model.**
Referenced as a model in the §2 ER tree and §9.1 section header, but never defined — `ShiftPattern.weeklyOffDays` subsumes it.
- **Fix:** Removed the false model reference from both headers and added a note clarifying weekly-off lives on `ShiftPattern.weeklyOffDays`; rotating week-offs via effective-dated `ShiftAssignment`.

---

## Minors noted, not changed (acceptable as-is)

- **KiwiSaver age boundary:** doc's `maxAgeEmployerContrib: 65` / `age ∈ [16,65]` is inclusive; IRD excludes "65 or over." Engine should treat 65 as the last compulsory year boundary; the rule JSON is close enough but the engine doc (`06-compliance-NZ.md`) should pin the exact `< 65` vs `<= 65` semantics.
- **Form 16 → Form 130** rename under Income Tax Act 2025 is correctly flagged as open question O-3; `RemittanceKind.IN_FORM16` left as placeholder.
- **Soft references** (`parentPayRunId`, `convertedEmployeeId`, `linkedCompensationId`, `leaveBalanceId`, `ptRegistrationId`) are intentionally bare strings, not FKs — documented and acceptable.
- The "421×" wording could be tightened to "421 references / 121 declarations" but the number is truthful.

---

## Post-edit integrity check
- No duplicate model or enum names.
- New enums (`SeparationType`, `SeparationStatus`, `TemplateKind`, `RequestStatus`) used only by their new models.
- Code fences balanced (44 prisma/json opens; remaining bare fences are ASCII state-machine diagrams).
- Model count 64 → 74; enum count grew consistently; document structure intact.

**Bottom line:** the data model is production-grade in ambition and largely in execution. The FK-discipline gap (C1) and the missing FNF/Separation entity (C2) were the two that would have bitten in production; both are now closed. With the edits applied, this reads as a solid senior-level schema design.

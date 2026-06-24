# Feature 22 — Statutory Bonus (Payment of Bonus Act, 1965)

**Status:** spec / build-ready
**Owners:** Payroll squad (India compliance)
**Depends on:** F1 (RBAC), F4/F5 (Compensation + CTC), F7 (Payroll Run engine + PayRun state machine), F10 (Approval engine), notification fan-out (`notifyHrEvent`), F9 (Letters register)
**Last synthesized:** 2026-06-24

> One-line: an **annual** statutory-bonus cycle for India — per-employee **eligibility** (wages ≤ ₹21,000/mo, ≥ 30 worked days, Section 9 disqualification), a **pure capped-base computation** (8.33%–20% of `min(monthly Basic+DA, ₹7,000-or-min-wage) × eligible months`), a **bonus run that REUSES the existing PayRun(type=BONUS) pipeline** (we do not fork the engine or state machine), per-employee **bonus slips + statutory letters**, and the **Form C register**. Paid within **8 months** of the accounting-year close.

---

## 1. Summary & goals

DriftHR computes monthly payroll to the paise (`payroll/engine.js`, `compliance/india.js`) and already has a `PayRunType.BONUS` enum member (`schema.prisma:7588`) that is **never written** today. Statutory bonus is the missing annual obligation: every covered establishment (≥ 20 employees) must pay employees earning ≤ ₹21,000/month a bonus of **8.33% minimum to 20% maximum** on a **₹7,000-or-minimum-wage-capped** base, for the accounting year (FY), disbursed within **8 months** of year-end (i.e. by **30 Nov** for an Apr–Mar FY).

The whole annual flow is one new **vertical slice on top of already-built engines**: a pure `bonus.js` core (eligibility + capped-base math, effective-dated constants beside `compliance/india.js`'s `rules`), a thin orchestrator that mirrors `fnf.js → offboarding.controller.js` (pure compute → persist snapshot → mint a `PayRun(type=BONUS)` straight from the engine output), and a register/letter read layer that reuses `IssuedLetter` and the `notifyHrEvent` fan-out.

**Goals**
1. **Eligibility determination** per employee per FY: wage-ceiling gate (₹21,000/mo), 30-worked-days gate (Section 8), Section 9 disqualification, proportionate worked-month resolution (Section 13 deemed-worked days).
2. **Bonus computation** — pure, paise-exact, effective-dated: rate configurable **8.33%–20%**, base **capped at `max(₹7,000, applicable minimum wage)`**, prorated by eligible months/days; set-on/set-off carry-forward modelled (Sections 15–17) as an advisory.
3. **Bonus run + disbursal** — REUSE `PayRun(type=BONUS)` + the `payrun.js` state machine + `service.js` lifecycle (`DRAFT → COMPUTED → REVIEW → APPROVED → PAID → FILED → closed`), maker-checker, idempotency by `inputHash`, immutability post-approval. A bonus run is *one statutory PayRun per FY per entity*, not a monthly run.
4. **Bonus slip + letter + register** — a per-employee bonus statement (reuse the payslip snapshot pattern), an optional bonus-award **letter** via `IssuedLetter`, and the **Form C register** export (the statutory bonus-paid register).
5. **Notifications** — fan out `bonus.computed` (operator) and `bonus.published` (employee) through `notifyHrEvent` (new HR template keys), exactly like `payslip.published`.

**Non-goals (see §3 scope-out):** the full Schedule-I/II "available surplus / allocable surplus" balance-sheet computation from gross profits (we let HR enter the declared bonus **rate %** and surface set-on/set-off as an *advisory ledger*, not an audited Companies-Act computation); customary/Puja festival advance bonus reconciliation beyond a simple "advance paid" deduction; non-India bonus (NZ has no statutory bonus — feature is **India-gated** like F15/F16).

---

## 2. The statutory rule (researched; cite in code comments)

Sources: Payment of Bonus Act 1965 (indiacode.nic.in), Payment of Bonus (Amendment) Act 2015 (eff. retrospective 01-Apr-2014), Payment of Bonus (Amendment) Rules 2016.

| Lever | Rule | Section |
|---|---|---|
| **Applicability** | Every factory + every establishment employing **≥ 20 persons** on any day in the accounting year (once covered, stays covered). | §1(3), §3 |
| **Eligibility wage ceiling** | Employee whose **monthly wages (Basic + DA) ≤ ₹21,000** (was ₹10,000 pre-2015). Above ₹21,000 → **not entitled** under the Act. | §2(13), 2015 amendment |
| **Minimum worked days** | Must have **worked ≥ 30 days** in the accounting year to be eligible. | §8 |
| **Calculation ceiling (base)** | Bonus computed on **`min(actual monthly Basic+DA, max(₹7,000, the minimum wage for the scheduled employment))`**. Was ₹3,500 pre-2015. If Basic+DA < the cap, use actual; if ≥ cap, use the cap. | §12, 2015 amendment |
| **Minimum bonus** | **8.33%** of the (capped) annual eligible wages — payable **even at a loss / no allocable surplus**. | §10 |
| **Maximum bonus** | **20%** of the (capped) annual eligible wages, when allocable surplus permits. | §11 |
| **Rate band** | Any rate **8.33% ≤ r ≤ 20%** the employer declares for the year (driven by allocable surplus); we treat `r` as a tenant input per FY. | §10–11 |
| **Proportionate reduction** | Bonus is **proportional to days worked**; days **laid-off (under agreement), on paid leave, maternity leave (paid), temporary disablement from employment injury** are **deemed worked**. LWP/unauthorised-absent days reduce the eligible base. | §13 |
| **Disqualification** | An employee **dismissed for fraud, riotous/violent conduct on premises, or theft/misappropriation/sabotage** forfeits bonus for that year. | §9 |
| **Time limit** | Pay **within 8 months** of the close of the accounting year (extendable to 2 years by the appropriate Government). For Apr–Mar FY → **by 30 Nov**. | §19 |
| **Set-on / set-off** | Surplus above the 20% max is **set-on** (carried forward up to 4 years); a shortfall below the 8.33% min draws from prior **set-on** (set-off). Advisory ledger only here. | §15, §16, Sch-IV |
| **Register** | Maintain **Form A** (allocable surplus), **Form B** (set-on/set-off), **Form C** (bonus disbursed per employee), and **Form D** annual return. We generate **Form C** (per-employee) + a **Form D**-shaped summary. | Bonus Rules 1975, r.4–5 |

**Worked example (golden test seed).** Employee with monthly Basic+DA = ₹12,000 (≤ ₹21,000 → eligible), worked all 12 months, no min-wage override, declared rate 8.33%:
- capped base/month = `min(12,000, max(7,000, 0)) = 7,000`
- annual eligible wage = `7,000 × 12 = 84,000`
- bonus @ 8.33% = `roundToRupeeNearest(84,000 × 833/10000) = ₹6,997` (₹84,000 × 0.0833 = 6,997.20 → ₹6,997). At 20% = `₹16,800`.
- Second case: Basic+DA = ₹6,000 (< ₹7,000 cap) → base = actual ₹6,000 → annual ₹72,000 → @8.33% = **₹5,998** (6,000×12×0.0833 = 5,997.6 → 5,998). A third (Basic+DA ₹25,000) → **ineligible** (over ceiling).

---

## 3. Scope

### In scope — REUSE (consume only; do NOT rebuild)

- **`payroll/engine.js`** — not re-invoked per-employee for bonus (bonus is a single annual line, not a structured payslip), but the **minor-unit / rounding discipline** and the `PayRunLine`/`PayRunLineComponent` persistence shape are reused verbatim.
- **`payroll/payrun.js`** — the **pure state machine** (`STATE`, `transition`, `persistTransition`, `computeInputHash`, maker-checker, immutability). A bonus run rides the **same** `DRAFT→…→FILED→closed` graph; **zero new states**.
- **`payroll/service.js`** — `createRun` / `approveRun` / `listRuns` (already has a `type` filter, `service.js:1221`) / `getRun` / publish-disburse-file-close wrappers. Bonus runs flow through these; we add a thin `createBonusRun` that seeds `type:'BONUS'`.
- **`payroll/compliance/india.js`** — the `rules` object + `resolveVersion(versions, asOf)` (effective-dated resolution), `rupees()`, `roundToRupeeNearest()`, `pctExact()`. Bonus constants are added as a **new effective-dated `rules.bonus` block** and read through the **same** resolver (mirroring `professionalTax.states`).
- **`lifecycle/fnf.js` + `offboarding.controller.js`** — the **exact template** for "PURE compute core → persist snapshot → mint a `PayRun` directly from the engine output via `payRunInput`": `fnf.js` returns `{ snapshot, payRunInput, lines:{earnings,deductions} }` and the controller mints `PayRun(type=FNF)` with per-line `PayRunLine`+components (`offboarding.controller.js:735–812`). `bonus.js` + `bonusRun.controller.js` mirror this 1:1 with `type:'BONUS'`.
- **`integrations/notifications.js`** — `notifyHrEvent({ event, … })` + the HR template registry. Add `HR_BONUS_COMPUTED` / `HR_BONUS_PUBLISHED` keys.
- **`hr/letters` (`LetterTemplate` / `IssuedLetter`)** — the bonus-award letter is a seeded `LetterTemplate` (category `STATUTORY`/`COMPENSATION`); issuance writes an `IssuedLetter` register row (the immutable, reference-numbered audit record, `schema.prisma:9370`).
- **F10 approval engine + `notifyHrEvent`** — bonus-run approval reuses the maker-checker on the PayRun (canApprovePayroll), not a parallel approval.
- **F1 RBAC** — gate on existing `canRunPayroll` / `canApprovePayroll` / `canViewPayrollReports`; add **one** fine-grained `canManageBonus` only if a tenant wants to separate the bonus operator from the monthly-payroll operator (default: reuse payroll perms).

### Scope-out
- Gross-profit → available-surplus → allocable-surplus computation from the P&L (Schedule I–III). HR inputs the **declared rate %** for the FY; we compute per-employee from that. (`BonusCycle.allocableSurplus` is an *optional* HR-entered figure used only to drive set-on/set-off advisories.)
- Customary/interim bonus reconciliation beyond a single advance-paid deduction.
- NZ / any non-IN entity (India-gated, returns 404/`COUNTRY_NOT_SUPPORTED`).

---

## 4. Data model (Prisma sketches — additive; no edits to existing models)

Three new models, all `businessId`-scoped, soft-delete + `version` columns per house convention. No FK changes to `PayRun`; the bonus run **is** a `PayRun(type=BONUS)` and is linked from `BonusCycle.payRunId` (nullable, set at mint).

```prisma
/// One statutory-bonus cycle = (entity, accounting year). The header that the
/// per-employee BonusAward rows hang off, and that mints exactly ONE PayRun(BONUS).
model BonusCycle {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId      String
  entity        Entity   @relation(fields: [entityId], references: [id], onDelete: Restrict)
  accountingYear String                       // "2025-26" (FY; mirrors PayRun.taxYear)
  // The declared bonus rate for the year, 833..2000 (basis points: 8.33%..20%).
  rateBasisPoints Int    @default(833)         // 833 = 8.33% (min), 2000 = 20% (max)
  // Calculation-base cap: max(₹7,000, minWage). Stored in MINOR units (paise).
  calcCeilingMinor BigInt @default(700000)     // ₹7,000 default; raised if min-wage higher
  minWageMonthlyMinor BigInt?                   // optional per-scheduled-employment min wage (paise)
  eligibilityCeilingMinor BigInt @default(2100000) // ₹21,000/mo wage ceiling (paise)
  // Optional HR-entered allocable surplus (paise) → drives set-on/set-off advisory only.
  allocableSurplusMinor BigInt?
  status        BonusCycleStatus @default(DRAFT)
  // Statutory deadline = accountingYearEnd + 8 months (e.g. 2026-11-30). Resolved at create.
  dueDate       DateTime @db.Date
  payRunId      String?                        // the minted PayRun(type=BONUS); set at approve/mint
  computedAt    DateTime?
  computedBy    String?
  approvedAt    DateTime?
  approvedBy    String?
  notes         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  version       Int      @default(0)
  awards        BonusAward[]

  @@unique([businessId, entityId, accountingYear])   // exactly-once per (entity, FY)
  @@index([businessId, status, dueDate])
}

enum BonusCycleStatus {
  DRAFT          // created; eligibility/computation not yet run
  COMPUTED       // per-employee awards computed (snapshot frozen)
  APPROVED       // maker-checker passed; PayRun(BONUS) minted
  PAID           // disbursed (mirrors PayRun PAID)
  FILED          // Form C/D generated/filed
  CANCELLED
}

/// One employee's bonus award for the cycle — the immutable per-employee snapshot
/// (mirrors a PayRunLine for the bonus run). Eligibility verdict + the capped-base math.
model BonusAward {
  id              String   @id @default(uuid())
  businessId      String
  business        Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  bonusCycleId    String
  bonusCycle      BonusCycle @relation(fields: [bonusCycleId], references: [id], onDelete: Cascade)
  employeeId      String
  employee        Employee @relation(fields: [employeeId], references: [id], onDelete: Restrict)
  // Eligibility verdict (Section 8/9 + ceiling).
  eligible        Boolean
  ineligibleReason String?  // 'OVER_CEILING' | 'UNDER_30_DAYS' | 'DISQUALIFIED_S9' | 'NOT_COVERED'
  // Inputs (frozen): the resolved monthly Basic+DA, worked/eligible months & days.
  monthlyBasicDaMinor BigInt @default(0)
  cappedBaseMinor BigInt @default(0)            // min(monthly Basic+DA, calcCeiling) (paise)
  eligibleMonths  Decimal  @db.Decimal(5, 2) @default(0)  // proratable (e.g. 11.5 for a mid-year joiner)
  workedDays      Int      @default(0)
  rateBasisPoints Int                           // the rate actually applied (snapshot of cycle rate)
  // Outputs (paise).
  grossBonusMinor BigInt   @default(0)          // base × months × rate, rounded ₹1
  advancePaidMinor BigInt  @default(0)          // festival/interim advance already paid (deduction)
  netBonusMinor   BigInt   @default(0)          // grossBonus − advancePaid, floored at 0
  computeTrace    Json?                         // the explain[] for the bonus slip
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  version         Int      @default(0)

  @@unique([businessId, bonusCycleId, employeeId])
  @@index([businessId, bonusCycleId, eligible])
}
```

> **Reuse note:** the bonus **register** needs no new model — `IssuedLetter` (the immutable, reference-numbered issuance record, `schema.prisma:9370`) backs the bonus-award letter, and the **Form C** export is generated on the fly from `BonusAward` rows (or persisted as a `StatutoryRemittance{ kind: IN_BONUS, fileUrl }` if we add an `IN_BONUS`/`IN_FORM_C` member to `RemittanceKind`, `schema.prisma:7854` — additive enum value).

---

## 5. The pure compute core — `backend/src/hr/payroll/bonus.js`

Mirrors `fnf.js`: **PURE, no DB, no I/O, no `Date.now`, integer minor units (paise)**, unit-testable to the paise with plain `node`. Constants are effective-dated and resolved through `compliance/india.js resolveVersion`. Reuses `india._internals.{ rupees, roundToRupeeNearest, pctExact, resolveVersion }`.

### 5.1 Effective-dated constants (added to `compliance/india.js rules`)

```js
// Payment of Bonus Act 1965 (+ 2015 amendment, eff. retrospective 2014-04-01).
bonus: {
  versions: [
    { effectiveFrom: '2000-01-01', effectiveTo: '2014-03-31',
      eligibilityCeilingRupees: 10000, calcCeilingRupees: 3500,
      minRateNum: 833, maxRateNum: 2000, rateDen: 10000, minWorkedDays: 30 },
    { effectiveFrom: '2014-04-01',  // 2015 amendment
      eligibilityCeilingRupees: 21000, calcCeilingRupees: 7000,
      minRateNum: 833, maxRateNum: 2000, rateDen: 10000, minWorkedDays: 30 },
  ],
}
```

A `resolveBonusRule(asOf)` helper (exported like `resolveLeaveFloor`) returns the version covering the accounting-year **end** date. Recomputing a pre-2015 FY therefore correctly uses ₹10,000/₹3,500 (same effective-dated discipline as `computeStatutoryWages` / `professionalTax`).

### 5.2 Eligibility — `determineBonusEligibility(ctx)`

```
eligible iff:
  monthlyBasicDaMinor <= eligibilityCeilingMinor   (Section 2(13), ₹21,000)   → else OVER_CEILING
  AND workedDays >= minWorkedDays (30)             (Section 8)                → else UNDER_30_DAYS
  AND !disqualifiedS9                              (Section 9 dismissal flag) → else DISQUALIFIED_S9
  AND entityCovered                               (≥20 employees / opted-in)  → else NOT_COVERED
```
`disqualifiedS9` is set from the separation reason (`offboarding`/`SeparationCase.type` = `TERMINATION_FOR_CAUSE` with a fraud/theft sub-reason) — a flag the controller resolves; the pure core just consumes the boolean.

### 5.3 Computation — `computeBonusAward(ctx)`

```
cappedBaseMinor   = min(monthlyBasicDaMinor, calcCeilingMinor)         // calcCeiling = max(₹7,000, minWage)
annualWageMinor   = cappedBaseMinor × eligibleMonths                    // eligibleMonths fractional (Section 13)
grossBonusRaw     = pctExact(annualWageMinor, rateBasisPoints, 10000)   // 833..2000 bp
grossBonusMinor   = roundToRupeeNearest(grossBonusRaw)                  // nearest ₹1, EPF convention
netBonusMinor     = max(0, grossBonusMinor − advancePaidMinor)
```
- **Proration (Section 13).** `eligibleMonths` = `workedOrDeemedDays / standardDaysInYear × 12`, where laid-off-under-agreement / paid-leave / maternity / employment-injury days are **deemed worked** (the controller computes the day count from attendance/leave; the core takes the resolved fraction). Mid-year joiners/leavers prorate naturally.
- **Min/max guard.** The applied `rateBasisPoints` is clamped to `[minRateNum, maxRateNum]` (8.33%–20%) at the cycle level; the core asserts it stays in band and emits an anomaly otherwise.
- **Set-on/set-off (advisory).** A separate pure `computeSetOnSetOff({ allocableSurplusMinor, totalMinBonusMinor, totalMaxBonusMinor, priorSetOnMinor })` returns `{ setOnMinor, setOffMinor, distributableMinor }` (Sections 15–16, 4-year carry) used only for the Form B/D advisory panel — never gates an individual award.

### 5.4 Return shape (the `fnf.js` parallel)

```js
computeBonusCycle(cycle, employees[]) -> {
  accountingYear, rateBasisPoints, calcCeilingMinor,
  awards: [{ employeeId, eligible, ineligibleReason, cappedBaseMinor, eligibleMonths,
             grossBonusMinor, advancePaidMinor, netBonusMinor, trace }],
  totals: { eligibleCount, ineligibleCount, totalGrossMinor, totalNetMinor },
  // mint-ready, identical to fnf.payRunInput so the controller mints PayRun(BONUS)
  // with the SAME persist path the FnF controller uses:
  payRunInput: {
    type: 'BONUS', currencyCode: 'INR',
    lines: [{ employeeId, earnings:[{code:'STAT_BONUS', label, amountMinor:netBonusMinor}],
              deductions:[/* advancePaid if any */], grossMinor, netMinor }],
    grossMinor, totalDeductionsMinor, netMinor,
  },
  setOnSetOff,  // advisory
}
```

---

## 6. Orchestrator — `bonusRun.controller.js` (DB-touching, thin) + `bonus.service.js`

Mirrors `offboarding.controller.js` precisely. The math is in `bonus.js`; this layer only loads rows, calls the pure core, persists `BonusCycle`/`BonusAward`, and **mints the PayRun via the existing `service.js`/`payrun.js` path**.

1. **`createBonusCycle({ entityId, accountingYear, rateBasisPoints, minWageMonthlyMinor? })`** — exactly-once on `(businessId, entityId, accountingYear)`. Resolves `calcCeilingMinor = max(₹7,000-from-rule, minWageMonthlyMinor)`, `eligibilityCeilingMinor` from `resolveBonusRule(fyEnd)`, and `dueDate = fyEnd + 8 months`. India-gated (`assertCountry` from `tenant/countryContext`, as `service.createRun` does at `service.js:509`).
2. **`computeBonusCycle({ bonusCycleId })`** — for each active employee of the entity in that FY: resolve monthly Basic+DA from the current `CompensationRevision` (reuse `service.resolveCurrentCompensation`), worked/deemed days from the year's attendance/leave (reuse the F16 LWP attendance feed), the Section-9 flag from any `SeparationCase`. Call `bonus.computeBonusCycle`, persist `BonusAward` rows + frozen `computeTrace`, set `BonusCycle.status=COMPUTED`. **Idempotent** (re-compute clears prior awards, like `persistComputedRun`). Fire `notifyHrEvent({ event:'bonus.computed' })` to the operator.
3. **`approveBonusCycle({ bonusCycleId })`** — **maker-checker** (approver ≠ `computedBy`, same SoD as `approveRun`). On approve, mint the **`PayRun(type='BONUS')`** straight from `payRunInput` (the `offboarding.controller.js:735–812` pattern: `createRun` shell → `PayRunLine` + `PayRunLineComponent` per award → roll totals), link `BonusCycle.payRunId`, set `status=APPROVED`. The minted run then rides the **normal payroll lifecycle** (`pay`/`file`/`close` via the existing `service.js` endpoints) — no parallel disbursal code.
4. **`publishBonusSlips({ bonusCycleId })`** — flips the bonus run's payslips/award visibility for ESS and fans out `notifyHrEvent({ event:'bonus.published' })` per eligible employee (mirrors `publishRun`).
5. **`getFormCRegister({ bonusCycleId, format })`** — generates the **Form C** (per-employee bonus paid) + a Form D-shaped summary from `BonusAward` rows; CSV/PDF. Optionally persists a `StatutoryRemittance{ kind:IN_BONUS }` artifact row.
6. **`issueBonusLetters({ bonusCycleId })`** — for each eligible employee, render the seeded bonus-award `LetterTemplate` and write an `IssuedLetter` register row (reference-numbered, immutable) — reuses the F9 letters issuance path; no new render code.

All amounts stay **integer minor units** through `bonus.js`; conversion to `Decimal` happens only at the persistence edge (`money.fromMinor`, exactly as `payrun.js defaultFromMinor`).

---

## 7. API + RBAC

All under `/api/hr/bonus`; tenant-scoped; India-gated (404 `COUNTRY_NOT_SUPPORTED` for NZ). Mutations behind `payrollMutationLimiter` (reuse). Permissions reuse the payroll set; the optional `canManageBonus` defaults to `canRunPayroll`.

| Method + path | Permission | Handler | Notes |
|---|---|---|---|
| `POST /cycles` | `canRunPayroll` | `createBonusCycle` | exactly-once (entity, FY) |
| `GET /cycles` | `canViewPayrollReports` | `listBonusCycles` | paginated, tenant-scoped |
| `GET /cycles/:id` | `canViewPayrollReports` | `getBonusCycle` | header + awards + totals + set-on/off advisory |
| `POST /cycles/:id/compute` | `canRunPayroll` | `computeBonusCycle` | idempotent; freezes awards |
| `PATCH /cycles/:id` | `canRunPayroll` | `updateBonusCycle` | edit rate/min-wage while DRAFT only |
| `POST /cycles/:id/approve` | `canApprovePayroll` | `approveBonusCycle` | maker-checker; mints PayRun(BONUS) |
| `POST /cycles/:id/publish` | `canApprovePayroll` | `publishBonusSlips` | ESS visibility + `bonus.published` |
| `POST /cycles/:id/letters` | `canRunPayroll` | `issueBonusLetters` | writes IssuedLetter rows |
| `GET /cycles/:id/register` | `canViewPayrollReports` | `getFormCRegister` | Form C/D export (csv/pdf) |
| `GET /me/bonus` | self-scope (`attachSelfEmployee`) | `getMyBonus` | ESS: my eligible bonus awards/slips |

Disbursal/filing/close of the minted bonus run use the **existing** `POST /api/hr/payroll/runs/:id/{pay,file,close}` endpoints (the bonus run is a normal `PayRun`), so there is no duplicated lifecycle surface.

---

## 8. UX — hr-admin (operator) + ESS (employee), plain language

### hr-admin — "Statutory Bonus" (under Payroll)
- **Cycles list:** one card per (entity, FY) — accounting year, declared rate %, status chip (Draft / Computed / Approved / Paid / Filed), **due-by date** with an amber badge when within 30 days and red when overdue (8-month deadline). "New bonus cycle" button.
- **New cycle modal:** entity picker (reuse `listRunEntities`), accounting-year select (defaults to the just-closed FY), **rate slider 8.33%–20%** (defaults to 8.33% min), optional per-scheduled-employment **minimum wage** input (raises the ₹7,000 cap). Plain helper text: "Employees earning Basic+DA ≤ ₹21,000/month are eligible; bonus is computed on the lower of their Basic+DA and ₹7,000 (or the minimum wage, if higher)."
- **Cycle detail → Compute:** runs eligibility + computation, shows a table: employee, monthly Basic+DA, **eligible?** (green/grey with reason tooltip — "Over ₹21,000 ceiling" / "Worked < 30 days" / "Disqualified u/s 9"), capped base, eligible months, rate, gross bonus, advance paid, **net bonus**. A totals strip: eligible count, total payout. A **set-on/set-off advisory** panel if allocable surplus was entered.
- **Review → Approve:** maker-checker banner ("You computed this cycle; a different approver must approve"), disabled Approve for the maker — mirrors the payroll run UI. Approve mints the bonus PayRun and links it ("View bonus pay run →").
- **After approve:** "Publish slips" (notifies employees), "Issue bonus letters", "Download Form C register". The bonus pay run itself is paid/filed/closed from the normal Payroll Runs screen.

### ESS — "My Bonus"
- A card per FY: "Statutory Bonus 2025-26 — ₹6,997 (paid 12 Nov 2026)" with a **bonus slip** (read-only snapshot: capped base, months, rate, gross, any advance, net) and a download. If ineligible, a plain explanation ("Your monthly Basic+DA exceeds the ₹21,000 statutory ceiling, so statutory bonus under the Payment of Bonus Act does not apply.").
- Surfaced only after **publish** (PUBLISHED gate, exactly like `getMyPayslip`).

---

## 9. Slice plan (3–5 vertical slices)

**Slice 22a — Pure bonus core + effective-dated rule + golden tests.**
Add `rules.bonus` (+ `resolveBonusRule`) to `compliance/india.js`; write `payroll/bonus.js` (`determineBonusEligibility`, `computeBonusAward`, `computeBonusCycle`, `computeSetOnSetOff`). Golden tests to the paise for: capped-base (₹12k→₹7k), under-cap (₹6k actual), over-ceiling (₹25k ineligible), 8.33% and 20% bounds, mid-year proration, pre-2015 FY (₹10k/₹3.5k), Section-9 disqualified, < 30 days. **No DB.**

**Slice 22b — Schema + cycle CRUD + compute orchestrator.**
Add `BonusCycle` / `BonusAward` / `BonusCycleStatus` (+ optional `RemittanceKind.IN_BONUS`); migrate. Build `bonus.service.js` + `bonusRun.controller.js` for `createBonusCycle` / `computeBonusCycle` (idempotent persist) / `getBonusCycle` / `listBonusCycles`. India-gate + `assertCountry`. Wire routes + RBAC.

**Slice 22c — Approve → mint PayRun(BONUS) → disbursal reuse.**
`approveBonusCycle` (maker-checker) mints `PayRun(type='BONUS')` from `payRunInput` via the `offboarding.controller.js` persist pattern; link `payRunId`. Verify the run flows through the **existing** pay/file/close lifecycle and `listRuns({type:'BONUS'})`. Notification fan-out `bonus.computed` + register the HR template keys.

**Slice 22d — Slips, letters, Form C register, publish + ESS.**
`publishBonusSlips` (+ `bonus.published`), `getMyBonus` (ESS, PUBLISHED-gated), seed the bonus-award `LetterTemplate` + `issueBonusLetters` (IssuedLetter), `getFormCRegister` (CSV/PDF Form C + Form D summary). hr-admin + ESS screens.

**Slice 22e (optional) — Set-on/set-off advisory + 8-month-deadline scheduler.**
Surface the Sections 15–16 advisory ledger (Form B) from `allocableSurplusMinor` + prior set-on; add a `scheduler.js` cron that fires `notifyHrEvent({ event:'filing.due', FILING:'Statutory Bonus' })` when a cycle's `dueDate` is within 30 days and still unpaid (reuses the existing scheduler + `HR_FILING_DUE` template).

---

## 10. Statutory edge cases (must-handle; cite in tests)

1. **Wage ceiling exactly ₹21,000** → eligible (`≤`, inclusive). **₹21,001** → ineligible.
2. **Calc base when Basic+DA < ₹7,000** → use **actual** (do not gross up to ₹7,000). When **≥ ₹7,000** → cap at ₹7,000 (or min wage if higher).
3. **Minimum wage > ₹7,000** (Reptakos Brett & Co. line of cases / 2015 amendment) → the calc ceiling is `max(₹7,000, min wage)`. `calcCeilingMinor` carries this.
4. **< 30 worked days** → ineligible even if wages ≤ ₹21,000 (Section 8).
5. **Section 13 deemed-worked days** — paid leave, maternity (paid), lay-off under agreement, employment-injury disablement count as worked; **LWP/AWOL** reduce eligible months. Do **not** let a heavily-LWP employee silently fall below the implicit threshold without the day math.
6. **Section 9 disqualification** — dismissal for fraud/theft/violence forfeits the **whole year's** bonus; record `ineligibleReason='DISQUALIFIED_S9'`.
7. **Mid-year joiner/leaver** → prorate `eligibleMonths`; a leaver settled at FnF may still be owed bonus for worked months — the cycle must include separated-but-eligible employees for that FY (scope by employment window overlapping the FY, like the F18 `MIGRATED` run scoping in `loadRunBundles`).
8. **8.33% rounding** — ₹84,000 × 8.33% = ₹6,997.20 → **₹6,997** (`roundToRupeeNearest`); assert the documented rounding point (nearest ₹1, EPF convention) — never float.
9. **Rate outside band** — reject `< 833` or `> 2000` bp at create; the core clamps + flags.
10. **8-month deadline** — `dueDate = fyEnd + 8 months`; overdue cycles flagged (advisory; the Act allows extension by the appropriate Government, so this is a warning, not a hard block).
11. **Advance/interim (Puja) bonus** already paid → deduct from gross, floor net at 0 (`advancePaidMinor`).
12. **TDS on bonus** — statutory bonus is **taxable salary**; the bonus PayRun line is `isTaxable`, so when it rides the PayRun the TDS projection (`computeTds`) already annualises it. (We do not re-deduct PF/ESI/PT on the bonus line — bonus is not PF/ESI wage; the bonus run's lines carry no PF/ESI flags.)
13. **Re-compute idempotency** — recompute clears + rewrites `BonusAward`; an APPROVED cycle is immutable (mirror `IMMUTABLE_RUN_VIOLATION`).

---

## 11. What to reuse vs. build (one-glance)

| Concern | Reuse (file) | Build new |
|---|---|---|
| Statutory constants + effective-dating | `compliance/india.js` `rules` + `resolveVersion` | `rules.bonus` + `resolveBonusRule` |
| Capped-base / rate / rounding math | `india._internals.{rupees,roundToRupeeNearest,pctExact}` | `payroll/bonus.js` (pure) |
| Run lifecycle / state machine / SoD / idempotency | `payroll/payrun.js`, `payroll/service.js` | `createBonusRun` thin seed (`type:'BONUS'`) |
| "compute → snapshot → mint PayRun" pattern | `lifecycle/fnf.js` + `offboarding.controller.js` | `bonusRun.controller.js` (1:1 mirror) |
| Per-line persistence (PayRunLine/Component) | `service.persistComputedRun` / `offboarding` mint | reuse verbatim |
| Notifications | `integrations/notifications.js` `notifyHrEvent` | `HR_BONUS_COMPUTED` / `HR_BONUS_PUBLISHED` keys |
| Letter + register | `LetterTemplate` / `IssuedLetter` (F9) | seed bonus-award template |
| Filing artifact row | `StatutoryRemittance` | `RemittanceKind.IN_BONUS` (enum value) |
| Deadline reminder | `core/lib/scheduler.js` + `HR_FILING_DUE` | one cron predicate |
| RBAC | `canRunPayroll` / `canApprovePayroll` / `canViewPayrollReports` | optional `canManageBonus` |
| ESS self-scope | `service.getMyPayslip` / `attachSelfEmployee` | `getMyBonus` |

---

## 12. Acceptance (golden)
- A cycle with the §2 example employees computes ₹6,997 (₹12k), ₹5,998 (₹6k), and `OVER_CEILING` (₹25k) — to the paise.
- Approve is blocked for the maker (SoD) and mints exactly one `PayRun(type=BONUS)` whose `totalNet` = Σ `netBonusMinor`; the run pays/files/closes through the existing payroll lifecycle.
- Re-compute is idempotent; an APPROVED cycle rejects recompute.
- Form C lists every eligible employee with capped base, months, rate, gross, net; an ineligible employee shows the reason.
- ESS shows the slip only after publish; an over-ceiling employee sees the plain ineligibility explanation.

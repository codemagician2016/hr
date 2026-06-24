# Feature 15 — India Income-Tax Projection (employee-facing TDS statement + projection)

> **Status:** spec / dev contract · **Module:** `backend/src/hr/payroll/compliance/india.js` (extend — the pure engine) + new `backend/src/hr/tax/` (projection assembler) + new ESS controller/route `backend/src/hr/controllers/meTaxProjection.controller.js`, `backend/src/hr/routes/meTaxProjection.routes.js` · **Apps:** `apps/ess` (primary), `apps/hr-admin` (read-only operator view)
> **Market:** **INDIA ONLY** — this surface is country-gated and never renders for NZ tenants/employees (see §2, §9). NZ income-tax projection is roadmap.
> **Builds on:** the **already-present** India compliance engine (`india.js` `annualTaxNewRegime`, `computeTds`, slabs/rebate/surcharge/cess constants), the ESS tax-declaration surface (`meTax.controller.js` → `StatutoryProfile.taxRegime`/`section80CDeclared`/`hraExemptionClaimed`), the ESS payslip surface (`mePayslips.routes.js`, `service.resolveSelfEmployee`, `Payslip.snapshotJson`/`yptdJson`), the comp engine (`deriveBreakup.js`, `service.resolveCurrentCompensation`), and the payslip PDF renderer (`payslipPdf.renderPayslipPdf`).
> **Author note:** every schema field / function / RBAC key / file path below was verified against the live tree on 2026-06-24. Where the engine already does part of the job it is **extended, not duplicated** (flagged inline).

---

## 1. Summary & goals

DriftHR already computes **monthly TDS at run time**: `india.js compute()` calls `computeTds()`, which annualises the period gross (§192 projection), applies the standard deduction, runs `annualTaxNewRegime()` (slabs → §87A rebate → §87A marginal relief → surcharge → 4% cess), subtracts YTD TDS, divides by months-remaining, and emits a `TDS` deduction line on the payslip. The employee sees the **resulting monthly number** on their payslip — but has **no statement that shows the working**: what their projected annual income is, how their HRA exemption / 80C / standard deduction reduced it, what the annual tax/surcharge/cess is, how much TDS has already been deducted this FY, how much a previous employer deducted, and **how much TDS remains to be recovered over the rest of the year**. The owner's Figma is exactly that statement — a full IT computation an employee can read and download.

Three gaps must close to ship the Figma:

1. **The engine only knows the NEW regime.** `annualTaxNewRegime()` and the slab/rebate constants are NEW-regime only; `computeTds()` ignores `StatutoryProfile.taxRegime` entirely and never reads 80C/HRA. The Figma shows OLD-vs-NEW with 80C/HRA/perquisites — so the engine needs an **OLD-regime slab path, an HRA-exemption computation, a Chapter-VI-A (80C/80D/…) deduction aggregator with gross/qualifying/deductible amounts, and a perquisite valuation** (accommodation, concessional/interest-free loans). All pure, all paise, all effective-dated — same discipline as the existing module.
2. **There is no "annual projection" assembler.** Run-time `computeTds` projects from *this month's gross × months-remaining* — fine for a payslip, but the statement needs a **richer projection** that reads the employee's **current compensation structure** (the authoritative annual earnings, per component), their **YTD actuals from published payslips** (what was really earned + really deducted so far), their **declaration** (regime, 80C, HRA-claimed, perquisites, previous-employer income+TDS), computes the full annual IT, and reports **TDS deducted-so-far vs TDS-remaining-per-month**. This is a new read-only assembler that calls the pure engine.
3. **There is no employee-facing tax-projection surface or PDF.** The ESS has a tax *declaration* page (collect regime/80C) but no tax *statement*. We add `GET /api/hr/me/tax-projection` (the computed statement, JSON) and `GET /api/hr/me/tax-projection/pdf` (the downloadable IT computation), plus an `apps/ess` "Tax projection" page and an operator read-only mirror in `apps/hr-admin`.

**Goals (v1)**
- An India employee opens ESS → **Tax projection** and sees the full IT computation from the Figma: Basic / HRA / other allowances / residual choice pay → **HRA exemption** → gross earning after exemption → **value of perquisites** → **Chapter-VI-A deductions** (80C with *gross / qualifying / deductible* columns, 80D, 80CCD(1B), …) → **maximum qualifying amount** → **total taxable income** → **tax payable** → **surcharge** → **total tax (incl. cess)** → **TDS deducted in current year** → **TDS deducted by previous employer** → **monthly tax recoverable** for each remaining month.
- The statement computes on the **regime the employee elected** (`StatutoryProfile.taxRegime`) and **also** shows the **other regime's total tax** as a one-line "you would pay ₹X under {OLD|NEW}" comparison, so the employee can make an informed switch (the switch itself is the existing declaration flow, not this feature).
- The number the statement projects for "this month's TDS" **reconciles to the paise** with what the live payroll run will deduct (the statement and `india.compute()` share the same pure functions — a golden parity test asserts it).
- The employee can **download a branded PDF** of the statement.
- An operator with `canViewPayrollReports` can view any employee's projection read-only in hr-admin (for payroll-desk queries), scoped by F1.

**Non-goals (v1)**
- Editing the declaration here (that stays `meTax.controller.js`; this page **deep-links** to it).
- Form 16 / Form 12BB generation, e-filing, ITR (roadmap — but the projection is the data spine they'll reuse).
- Letting the employee enter arbitrary proofs/bills; v1 reads the **declared** amounts (`StatutoryProfile`) + a small set of **declaration extension fields** we add (previous-employer income/TDS, HRA rent, 80D, 80CCD(1B), home-loan interest, perquisite inputs). Proof-upload/verification is roadmap (we reuse `me/documents` for storage when it lands).
- NZ. Surface is hard-gated to `countryCode === 'IN'`.
- Surcharge **marginal relief** beyond what `annualTaxNewRegime` already approximates (we tighten it in §4.4, but full inter-band marginal relief tables stay roadmap-flagged).

---

## 2. Scope

### In scope (reuse-first)
- **Reuse as-is:**
  - `india.js` constants & helpers — `rules.incomeTaxNewRegime`, `rules.stdDeductionRupees`, `rules.rebate87A`, `rules.surchargeNewRegime`, `rules.cess`, `rules.noPanFlatRate`, `pctExact`, `roundHalfUpPaise`, `roundToRupeeNearest`, `rupees`, `periodAsOf`, `resolveVersion`, and the existing `annualTaxNewRegime()` / `computeTds()` (NEW-regime path stays the path it is today).
  - `service.resolveSelfEmployee(businessId, customer)` — the SELF_ONLY identity resolver (already reused by `meTax`, `meProfile`, …); **hoist-or-reuse**, never re-implement.
  - `service.resolveCurrentCompensation(businessId, employeeId, asOf)` — the authoritative current package (resolved component lines) → the projection's annual-earnings spine.
  - `service.taxYearFor(periodEnd, 4)` — FY Apr–Mar resolver (already in service).
  - `Payslip` rows (`status PUBLISHED|VIEWED`, `snapshotJson` per-component earnings/deductions incl. the `TDS` line, `yptdJson`) — the **YTD actuals** source.
  - `payslipPdf.renderPayslipPdf` PDF scaffolding (header/brand/table helpers `_internals.money/fmtDate`) — we add a sibling renderer reusing its pdfkit setup.
  - `meTax.controller.resolveCountry()` (country fail-closed: StatutoryProfile → Employee → current entity) — **hoist into a shared `resolveStatutoryCountry()` helper** (it is duplicated logic we now need in two controllers; §8).
  - F1: `requireCustomer` (ESS), `requireOperator` + `canViewPayrollReports` + `scopeWhere`/`resolveAccessibleEmployeeIds` (operator mirror).
- **Extend (engine):** `india.js` gains a pure **`projectAnnualIncomeTax()`** (regime-aware: NEW or OLD), an **`annualTaxOldRegime()`** (OLD slabs + §87A old-regime rebate), an **`hraExemption()`** (least-of-three), a **`chapterVIADeductions()`** (80C cap, 80D, 80CCD(1B), 80CCD(2), 80TTA/TTB, 24(b) home-loan interest), and a **`perquisiteValue()`** (accommodation, concessional loan). All pure, paise, effective-dated — added under `rules` + `_internals`.
- **Add (new):** `backend/src/hr/tax/projectionAssembler.js` (impure: loads comp + payslips + declaration, calls the pure engine, returns the statement object); `meTaxProjection.controller.js` + route; the ESS page; the hr-admin read-only mirror; the PDF renderer; a handful of additive `StatutoryProfile` declaration columns (§3.1).

### Out of scope (v1)
Form 16/12BB/24Q export (separate feature — reuses this engine), proof upload/verification, NZ, employee-entered ad-hoc components, multi-entity aggregation (an employee on one `EmploymentRecord` at a time; the projection reads the **current** record's entity for PF/state context).

---

## 3. Data model (Prisma sketches)

The regime + headline 80C + HRA-claimed flag **already exist** on `StatutoryProfile` (lines 7226–7229: `taxRegime INTaxRegime?`, `section80CDeclared Decimal?`, `hraExemptionClaimed Boolean?`). The Figma needs a few **more declared inputs**. All are **additive, nullable** columns on `StatutoryProfile` (no migration risk; consistent with how the NZ block sits on the same model). We do **not** create a new declaration model — `StatutoryProfile` is already the authoritative statutory record the payroll engine reads.

### 3.1 Extend `StatutoryProfile` (additive — India declaration inputs)

```prisma
model StatutoryProfile {
  // ... existing IN block unchanged (pan, uan, taxRegime, section80CDeclared,
  //     hraExemptionClaimed, ptStateCode, esiApplicable, ...) ...

  // ── Feature 15: declared IT-projection inputs (OLD-regime; ignored under NEW) ──
  // All amounts are ANNUAL rupees as DECLARED by the employee (proofs are roadmap).
  hraAnnualRentPaid       Decimal? @db.Decimal(15, 2) // rent paid p.a. (HRA exemption leg 3)
  hraMetroCity            Boolean? @default(false)     // 50% vs 40% of salary leg
  sec80DDeclared          Decimal? @db.Decimal(15, 2) // medical insurance premium
  sec80CCD1BDeclared      Decimal? @db.Decimal(15, 2) // NPS additional ₹50k (80CCD(1B))
  sec80TTADeclared        Decimal? @db.Decimal(15, 2) // savings interest (TTA/TTB)
  sec24BHomeLoanInterest  Decimal? @db.Decimal(15, 2) // self-occupied home-loan interest (cap ₹2L)
  otherChapterVIADeclared Json?                         // [{ section, label, grossAmount }] extensible

  // Perquisites (Figma "Value of perquisites"). Inputs the employer/HR sets, not
  // the employee — but stored here so the projection reads one record. Nullable.
  perqRentFreeAccom       Boolean? @default(false)     // employer-provided accommodation
  perqAccomCityPopBand    String?  @db.VarChar(8)       // ">40L" | "15-40L" | "<15L" (perq %)
  perqAccomIsLeased       Boolean? @default(false)     // employer-leased (actual rent leg)
  perqAccomLeaseRentPaid  Decimal? @db.Decimal(15, 2)  // employer's annual lease rent
  perqConcessionalLoanBal Decimal? @db.Decimal(15, 2)  // avg outstanding employer loan
  perqLoanRateChargedPct  Decimal? @db.Decimal(5, 2)   // rate actually charged (vs SBI rate)

  // ── Previous-employer income + TDS (Figma "Tax deducted by previous employer") ──
  // Declared on joining mid-FY (Form 12B). ANNUAL/cumulative rupees for THIS FY.
  prevEmployerTaxableIncome Decimal? @db.Decimal(15, 2)
  prevEmployerTdsDeducted   Decimal? @db.Decimal(15, 2)
  prevEmployerFY            String?  @db.VarChar(7)     // "2026-27" guard: only count when == current FY
}
```

**Audit:** changes to any of these material fields append a `StatutoryElectionHistory` row (the model already exists, lines 7267–7281) — exactly as `meTax.saveDeclaration` already does for `taxRegime`. No new audit model.

### 3.2 Optional cache (perf, not source-of-truth) — `TaxProjectionSnapshot`

The statement is **always recomputed on read** from live comp + payslips + declaration (so it never goes stale). For audit/history and to let the **payroll run** persist "the projection as of this run" we add a thin, optional snapshot. **Not required for v1 functional correctness** — flag as a fast-follow if read latency is fine without it.

```prisma
/// Append-only snapshot of a computed annual IT projection (audit/history).
/// NEVER the source of truth — the live statement recomputes from comp+payslips.
model TaxProjectionSnapshot {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  taxYear       String   // "2026-27"
  regime        INTaxRegime
  asOfDate      DateTime @db.Date           // projection as-of (period end / today)
  computedJson  Json                         // the full statement object (§5 shape)
  totalTaxMinor BigInt                        // annual total tax (paise) — quick filter
  payRunId      String?                       // set when minted during a run; null for ESS reads
  createdAt     DateTime @default(now())

  @@index([businessId, employeeId, taxYear])
}
```

---

## 4. The pure tax engine (extend `india.js`)

All additions live in `india.js` (pure, paise, effective-dated, unit-testable with plain `node`) and are exported under `_internals`. **No DB, no Date.now** — the assembler (§5) passes everything in. New effective-dated constants go under `rules`.

### 4.1 New rule constants (FY2025-26 / FY2026-27)

```js
// ── OLD-regime slabs (below 60y). Amounts in RUPEES. Effective FY2025-26. ──
incomeTaxOldRegime: {
  effectiveFrom: '2025-04-01',
  slabs: [
    { upTo: 250000,  num: 0,  den: 100 },
    { upTo: 500000,  num: 5,  den: 100 },
    { upTo: 1000000, num: 20, den: 100 },
    { upTo: null,    num: 30, den: 100 },
  ],
  // §87A (old regime): rebate up to ₹12,500 where taxable ≤ ₹5,00,000.
  rebate87A: { maxRebateRupees: 12500, taxableCeilingRupees: 500000 },
  stdDeductionRupees: 50000, // old-regime salaried standard deduction
},

// ── Chapter VI-A caps (old regime only) ──
chapterVIA: {
  effectiveFrom: '2025-04-01',
  sec80C_capRupees:    150000,  // 80C + 80CCC + 80CCD(1) combined ceiling
  sec80CCD1B_capRupees: 50000,  // additional NPS (over and above 80C)
  sec80D_capSelfRupees: 25000,  // (senior-citizen variants roadmap)
  sec80TTA_capRupees:    10000, // savings-account interest (TTB ₹50k roadmap)
  sec24B_capRupees:     200000, // self-occupied home-loan interest
},

// ── HRA exemption (§10(13A)) ──
hra: {
  effectiveFrom: '2000-01-01',
  metroPctNum: 50, nonMetroPctNum: 40, pctDen: 100, // % of (Basic+DA)
  rentMinusPctOfSalaryNum: 10, rentMinusPctOfSalaryDen: 100, // rent − 10% salary
},

// ── Perquisites (Rule 3) ──
perquisites: {
  effectiveFrom: '2025-04-01',
  accomOwnedPct: { '>40L': { num: 10, den: 100 }, '15-40L': { num: 75, den: 1000 }, '<15L': { num: 5, den: 100 } },
  // concessional loan: perq = (SBI benchmark rate − rate charged) × avg outstanding.
  sbiBenchmarkRatePct: 8.5, // effective-dated; resolved as-of
},
```

> **Roadmap-flagged constants:** senior-citizen (60–80 / 80+) OLD slabs & 80D/80TTB variants; surcharge marginal-relief inter-band tables; 80G/80E/80EEA. The engine signature accepts an `age`/`flags` bag so these slot in without a call-site change.

### 4.2 `hraExemption({ basicDaAnnualMinor, hraReceivedAnnualMinor, rentPaidAnnualMinor, metro })`
Pure. Least-of-three (§10(13A)):
1. HRA actually received,
2. rent paid − 10% of (Basic+DA),
3. 50% (metro) / 40% (non-metro) of (Basic+DA).
Returns `{ exemptMinor, leastLeg, legs:{received, rentMinus10, pctOfSalary} }`. Floors at 0. Under **NEW regime** HRA exemption is **0** — the assembler simply doesn't call it.

### 4.3 `chapterVIADeductions({ sec80cGrossMinor, sec80dGrossMinor, sec80ccd1bGrossMinor, sec80ttaGrossMinor, sec24bGrossMinor, others, asOf })`
Pure. For each section returns `{ section, label, grossMinor, qualifyingMinor, deductibleMinor }` where `deductible = min(gross, cap)` and `qualifying` is the pre-cap eligible amount (Figma's "gross / qualifying / deductible" columns). Aggregates to `{ lines[], totalDeductibleMinor, maxQualifyingMinor }`. **80C is capped at ₹1,50,000**; 80CCD(1B) is a **separate ₹50,000** (does not eat the 80C cap); 24(b) reduces income from house property (we model it as a deduction line for the salaried-only projection). OLD regime only.

### 4.4 `annualTaxOldRegime(taxableRupees)`
Mirrors `annualTaxNewRegime` exactly (slab walk → rebate → surcharge → 4% cess) but with `rules.incomeTaxOldRegime.slabs` and the old §87A (₹12,500 / ₹5,00,000). Surcharge bands are the **same** `rules.surchargeNewRegime` thresholds (5%/10%/15%/25% on income-tax) — surcharge is regime-independent; we reuse the array. Returns the identical shape `{ slabTaxMinor, taxAfterReliefMinor, surchargeMinor, cessMinor, totalAnnualTaxMinor }`.

### 4.5 `perquisiteValue({ accom, loan, asOf })`
Pure. Accommodation: employer-owned → % of salary by city-population band (Rule 3 table in `rules.perquisites.accomOwnedPct`); employer-leased → least of (lease rent, 10% of salary) less any rent recovered. Concessional loan: `(sbiBenchmarkRate − rateCharged) × avgOutstanding`, floored at 0. Returns `{ totalMinor, lines:[{ kind, label, amountMinor, explain }] }`. NEW and OLD both tax perquisites (they're income, not a deduction) — always added to gross.

### 4.6 `projectAnnualIncomeTax(input)` — the regime-aware orchestrator
The single pure entry the assembler calls. Pseudocode:

```
input = {
  regime,                       // 'NEW' | 'OLD'  (from StatutoryProfile.taxRegime)
  annualEarnings: { basicDaMinor, hraReceivedMinor, otherAllowancesMinor, residualChoicePayMinor },
  perquisitesInput,             // → perquisiteValue()
  hraInput,                     // → hraExemption()  (OLD only)
  chapterVIAInput,              // → chapterVIADeductions() (OLD only)
  prevEmployer: { taxableIncomeMinor, tdsMinor },
  hasPan, asOf,
}

1.  grossSalaryMinor = Σ annualEarnings  (Basic + HRA + other + residual)
2.  perq = perquisiteValue(...)                  → add perq.totalMinor to gross
3.  grossAfterPerqMinor = grossSalaryMinor + perq.totalMinor
4.  if regime === 'OLD':
       hra = hraExemption(...)                    → exemptMinor
       stdDed = oldRegime.stdDeductionRupees (₹50,000)
       chap = chapterVIADeductions(...)           → totalDeductibleMinor
       grossAfterExemptMinor = grossAfterPerq − hra.exemptMinor
       taxableMinor = max(0, grossAfterExempt − stdDed − chap.totalDeductible) + prevEmployer.taxableIncome
       tax = annualTaxOldRegime(round(taxable/100))
    else (NEW):
       stdDed = rules.stdDeductionRupees (₹75,000)        // already in engine
       taxableMinor = max(0, grossAfterPerq − stdDed) + prevEmployer.taxableIncome
       tax = annualTaxNewRegime(round(taxable/100))       // existing fn, unchanged
5.  if !hasPan and tax.totalAnnualTaxMinor > 0: apply §206AA 20% flat (existing rule)
6.  return {
       regime, grossSalaryMinor, perquisites: perq, hraExemptionMinor,
       grossAfterExemptMinor, standardDeductionMinor, chapterVIA: chap||null,
       taxableIncomeMinor, taxPayableMinor: tax.taxAfterReliefMinor,
       surchargeMinor: tax.surchargeMinor, cessMinor: tax.cessMinor,
       totalAnnualTaxMinor: tax.totalAnnualTaxMinor,
    }
```

> **Parity contract (§192):** the assembler also calls the **existing** `computeTds()` with the same projected annual gross so the *monthly recoverable* the statement prints equals the *monthly TDS* the live run will deduct. A golden test (`india.golden.test.js` new cases) asserts `statement.monthlyRecoverableMinor === india.compute(sameInputs).TDS.amountMinor` to the paise for both regimes.

### 4.7 Monthly recoverable
Given `totalAnnualTaxMinor`, `tdsDeductedThisFYMinor` (Σ TDS lines on published payslips this FY), `prevEmployerTdsMinor`, and `monthsRemaining` (12 − months already paid this FY, from the pay calendar):

```
remainingTaxMinor   = max(0, totalAnnualTax − tdsDeductedThisFY − prevEmployerTds)
monthlyRecoverable  = roundToRupeeNearest(remainingTax / monthsRemaining)   // existing rounding
```

Returns a per-month schedule `[{ month:'2026-07', amountMinor }, …]` for the remaining months (last month absorbs the rounding residual so Σschedule === remainingTax — same residual-absorption discipline as `deriveBreakup`'s balancing line).

---

## 5. The assembler (`backend/src/hr/tax/projectionAssembler.js`)

Impure (loads rows), but the **only** math it does is calling the pure engine. Tenant-scoped. Signature:

```js
async function buildTaxProjection({ businessId, employeeId, asOf /* default today */, db = prisma }) → statement
```

Steps:
1. **Country gate.** `resolveStatutoryCountry(businessId, employee)` (hoisted from `meTax`). If `!== 'IN'` → throw `COUNTRY_UNSUPPORTED` (controller maps to 422 "Tax projection is available for India only").
2. **FY window.** `taxYear = service.taxYearFor(asOf, 4)`; FY = 1-Apr → 31-Mar; `monthsElapsed` from published payslips this FY, `monthsRemaining = 12 − monthsElapsed`.
3. **Annual earnings spine.** `resolveCurrentCompensation(...)` → resolved component lines → bucket into `basicDa` (kind BASIC/DA), `hraReceived` (kind HOUSE_RENT_ALLOWANCE), `otherAllowances`, `residualChoicePay` (the BALANCING component). Annualise (×12, or use `amountAnnual` already on the line). This is the same shape `deriveBreakup` produces — reuse its component bucketing helper, don't re-derive.
4. **YTD actuals.** Sum the `TDS` deduction line across this FY's `Payslip.snapshotJson.employeeDeductions` (status PUBLISHED|VIEWED) → `tdsDeductedThisFYMinor`; sum taxable earnings → `ytdTaxableMinor` (used to blend projection: YTD-actual + remaining-months × current-monthly, matching `computeTds`'s projection method rather than naive ×12).
5. **Declaration.** Read `StatutoryProfile`: `taxRegime` (default NEW), `section80CDeclared`, `hraExemptionClaimed`/`hraAnnualRentPaid`/`hraMetroCity`, `sec80DDeclared`, `sec80CCD1BDeclared`, `sec80TTADeclared`, `sec24BHomeLoanInterest`, perquisite inputs, and the **previous-employer** fields (only counted when `prevEmployerFY === taxYear`).
6. **PAN.** `hasPan = !!sp.pan` → §206AA path.
7. **Compute (elected regime)** via `projectAnnualIncomeTax(...)`, **and** compute the **other** regime once for the comparison line.
8. **Monthly recoverable** (§4.7) → schedule.
9. **Return** the statement (§5.1).

### 5.1 Statement shape (the JSON the API + PDF render — mirrors the Figma rows)

```jsonc
{
  "employeeId": "…", "taxYear": "2026-27", "asOf": "2026-06-24",
  "regime": "OLD", "currencyCode": "INR",
  "annualEarnings": {
    "basicDa": 600000, "hra": 240000, "otherAllowances": 120000,
    "residualChoicePay": 90000, "grossSalary": 1050000
  },
  "hraExemption": { "exempt": 96000, "leastLeg": "rentMinus10", "legs": { … } },
  "grossEarningAfterExemption": 954000,
  "perquisites": { "total": 60000, "lines": [ { "kind":"ACCOMMODATION", "label":"Rent-free accommodation", "amount":60000, "explain":"10% of salary (>40L city)" } ] },
  "chapterVIA": {
    "lines": [
      { "section":"80C",       "label":"PF/VPF, Insurance, ELSS…", "gross":180000, "qualifying":180000, "deductible":150000 },
      { "section":"80CCD(1B)", "label":"NPS (additional)",          "gross":50000,  "qualifying":50000,  "deductible":50000  },
      { "section":"80D",       "label":"Medical insurance",         "gross":28000,  "qualifying":28000,  "deductible":25000  }
    ],
    "maxQualifying": 225000, "totalDeductible": 225000
  },
  "standardDeduction": 50000,
  "totalTaxableIncome": 739000,
  "taxPayable": 60300, "surcharge": 0, "cess": 2412, "totalTax": 62712,
  "tdsDeductedThisFY": 9000, "previousEmployerTds": 0,
  "remainingTax": 53712, "monthsRemaining": 9, "monthlyRecoverable": 5968,
  "schedule": [ { "month":"2026-07", "amount":5968 }, … ],
  "regimeComparison": { "elected":"OLD", "electedTotalTax":62712, "alternativeRegime":"NEW", "alternativeTotalTax":71400, "betterRegime":"OLD" },
  "investments80C": [ { "code":"PF",  "label":"Provident Fund (auto, from payslips)", "amount":72000, "source":"DERIVED" },
                      { "code":"VPF", "label":"Voluntary PF", "amount":0, "source":"DECLARED" },
                      { "code":"LIC", "label":"Insurance premium", "amount":48000, "source":"DECLARED" } ],
  "notes": [ "Figures are projected from your current salary and declaration. Final tax is computed at year-end." ],
  "anomalies": [ /* e.g. MISSING_PAN, WAGES_50_RULE inherited if relevant */ ]
}
```

All amounts surfaced as **major-unit rupees** (the assembler converts paise→rupees at the edge via `money.fromMinor`); internally everything is paise.

---

## 6. API (with RBAC)

All mounted under the existing `/api/hr/me/*` ESS surface (router index `backend/src/hr/routes/index.js`, next to line 95 `…/me/tax-declaration`). **CUSTOMER session, SELF_ONLY** — the subject is `resolveSelfEmployee(...)` from the session; no employee id is accepted from the client (structurally cross-employee-proof, identical to `meTax`/`mePayslips`).

| Method & path | Auth / scope | Body / query | Returns |
|---|---|---|---|
| `GET /api/hr/me/tax-projection` | `requireCustomer`, SELF_ONLY | `?asOf=YYYY-MM-DD` (optional; default today) | The statement (§5.1). `404` if no active employee; `422 COUNTRY_UNSUPPORTED` if not India; `422` if jurisdiction unset. |
| `GET /api/hr/me/tax-projection/pdf` | `requireCustomer`, SELF_ONLY | — | `application/pdf` branded IT computation (§7). Records SHA-256 like the payslip PDF. |
| `GET /api/hr/me/tax-projection/regimes` | `requireCustomer`, SELF_ONLY | — | `{ elected, electedTotalTax, NEW:{totalTax}, OLD:{totalTax}, betterRegime }` — the lightweight comparison for the declaration page's "which regime?" helper (lets `meTax` show savings without duplicating the engine). |

**Operator mirror** (hr-admin, read-only payroll-desk view), mounted on the operator payroll surface:

| Method & path | Auth / scope | Returns |
|---|---|---|
| `GET /api/hr/payroll/employees/:employeeId/tax-projection` | `requireOperator` + `canViewPayrollReports` + F1 `scopeWhere`/`resolveAccessibleEmployeeIds` (employee must be in caller's accessible set) | Same statement, for any in-scope India employee. |

**Route wiring**
- New `backend/src/hr/routes/meTaxProjection.routes.js` (mirrors `meTax.routes.js`: `router.use(requireCustomer)` then `GET /`, `GET /pdf`, `GET /regimes`) → mounted `router.use('/me/tax-projection', require('./meTaxProjection.routes'))`.
- Operator route added to the existing `payroll.routes.js` behind `canViewPayrollReports` (no new RBAC key — reuse).

**No new RBAC permission.** ESS is session-self; operator reuses `canViewPayrollReports` (rbac.js line 26).

---

## 7. PDF (`backend/src/hr/tax/taxProjectionPdf.js`)

A sibling of `payslipPdf.js` reusing its pdfkit setup + `_internals` (brand header, `money`, `fmtDate`). Renders the Figma's IT computation as a single statement: employer/employee header, FY + regime badge, then the row-stack exactly as §5.1 (Earnings → HRA exemption → Gross after exemption → Perquisites → Chapter VI-A table with gross/qualifying/deductible columns → Standard deduction → Total taxable income → Tax payable / Surcharge / Cess / **Total tax** → TDS current-year → TDS previous-employer → **Monthly tax recoverable** + the 80C investment table). Footer: "Projected — not a Form 16" disclaimer. Branding pulled the same way the payslip PDF resolves business identity (`resolvePayslipPdfIdentity` pattern; reuse for the header block). PDF hash persisted best-effort like `recordPayslipPdfHash` (optional — skip if no snapshot model in v1).

---

## 8. Shared helper hoist (no duplication)

`resolveCountry()` currently lives **only** inside `meTax.controller.js` (StatutoryProfile → Employee → current entity, fail-closed). This feature needs it too. **Hoist it once** to `backend/src/hr/lib/resolveStatutoryCountry.js` and have `meTax.controller.js` import it (one-line refactor, no behaviour change), then reuse in the assembler. Same for `resolveSelfEmployee` — it already lives in `service.js` and is imported by `meTax`; the new controller imports the same one. **No new copies of either.**

---

## 9. ESS & hr-admin UX (plain language)

### ESS — "Tax projection" (`apps/ess`, new page under the existing Tax/Pay menu)
- Lands on a **single scrollable statement** that reads top-to-bottom like the Figma:
  - **Header strip:** "FY 2026-27 · OLD regime" badge + a "Change regime / declaration" link that deep-links to the existing **Tax declaration** page (`/me/tax-declaration`). No editing here.
  - **Earnings block:** Basic, HRA, Other allowances, Residual Choice Pay, **Gross salary**.
  - **HRA exemption** line (OLD only) — shows the least-of-three with a small "how this is computed" tooltip; hidden entirely under NEW (replaced by a "NEW regime — exemptions don't apply" note).
  - **Gross earning after exemption.**
  - **Value of perquisites** (accommodation, concessional loan) — only if any perquisite input is set; each with a one-line explain.
  - **Deductions under Chapter VI-A** — a table with **Section · Gross amount · Qualifying amount · Deductible amount** columns (80C, 80CCD(1B), 80D, …), a **Maximum qualifying amount** subtotal, hidden under NEW.
  - **Standard deduction.**
  - **Total taxable income** (bold).
  - **Tax payable · Surcharge · Health & Education cess · Total tax** (the last bold).
  - **Tax deducted this year** (from your payslips) and **Tax deducted by previous employer** (from your declaration).
  - **Monthly tax recoverable** — a highlighted card: "₹5,968 will be deducted in each of your remaining 9 months" + a small month-by-month list.
  - **80C investments** table: PF/VPF (auto-derived from payslips, marked "from payslips"), Insurance, ELSS, etc. (declared) — each row tagged DERIVED vs DECLARED so the employee knows what they still need to declare.
  - **Regime comparison banner:** "Under NEW regime your total tax would be ₹71,400 — you're better off on OLD." (or vice-versa), with a CTA to the declaration page to switch.
  - **Download PDF** button (the §7 statement).
- **Empty/edge states:** no comp yet → "We'll show your projection once your salary is set up." No payslips yet → projects purely from structure (months-remaining = 12). Not India → the page isn't shown in the menu at all (country-gated client-side too).

### hr-admin — operator read-only mirror
- On the **employee payroll detail** drawer, a **"Tax projection"** tab (visible with `canViewPayrollReports`) showing the same statement read-only, for payroll-desk queries ("why is my TDS this much?"). Scoped by F1 — an operator only sees employees in their accessible set. Includes the same PDF download.

---

## 10. Build plan (5 slices)

**Slice 15a — Pure engine: OLD regime + HRA + Chapter VI-A + perquisites.**
Extend `india.js`: add `rules.incomeTaxOldRegime`, `rules.chapterVIA`, `rules.hra`, `rules.perquisites`; implement `annualTaxOldRegime`, `hraExemption`, `chapterVIADeductions`, `perquisiteValue`, and the `projectAnnualIncomeTax` orchestrator; export under `_internals`. **Golden tests** in `india.golden.test.js`: OLD-regime slab/rebate cases, HRA least-of-three, 80C cap + 80CCD(1B) separate cap, perquisite accommodation/loan, and the **§192 parity assert** (`projectAnnualIncomeTax` monthly recoverable === `computeTds` for the same inputs, both regimes). No DB. *Done = paise-exact goldens green.*

**Slice 15b — Declaration model + meTax extension.**
Add the §3.1 `StatutoryProfile` columns (migration, additive/nullable) + the optional `TaxProjectionSnapshot` (behind a flag). Extend `meTax.controller.saveDeclaration` to accept/persist the new OLD-regime inputs (HRA rent/metro, 80D, 80CCD(1B), 24(b), previous-employer income/TDS) with validation (numbers ≥ 0, `prevEmployerFY` guard), appending `StatutoryElectionHistory` for material changes. Hoist `resolveStatutoryCountry` (§8). *Done = declaration round-trips the new fields; wrong-country still 422.*

**Slice 15c — Assembler + ESS API.**
`projectionAssembler.buildTaxProjection` (§5) reusing `resolveSelfEmployee`, `resolveCurrentCompensation`, payslip YTD, declaration. `meTaxProjection.controller.js` + `meTaxProjection.routes.js` (`GET /`, `GET /regimes`) mounted at `/me/tax-projection`. Country-gated, SELF_ONLY. *Done = a seeded India employee gets a correct statement; an NZ employee gets 422; reconciles to the live run's TDS line.*

**Slice 15d — PDF + operator mirror.**
`taxProjectionPdf.js` (reuse `payslipPdf` setup) + `GET /me/tax-projection/pdf` (+ SHA-256 record). Operator `GET /api/hr/payroll/employees/:id/tax-projection` behind `canViewPayrollReports` + F1 scope. *Done = branded PDF downloads; operator sees in-scope employees only.*

**Slice 15e — ESS + hr-admin UI.**
The ESS "Tax projection" page (§9), country-gated in the menu, deep-linking to the declaration page, with the regime-comparison banner and PDF button. The hr-admin read-only "Tax projection" tab on the payroll employee drawer. *Done = the Figma statement renders end-to-end in both apps; switching regime in declaration changes the statement on refresh.*

> **Optional 15f (fast-follow):** persist a `TaxProjectionSnapshot` at run-approval time so the statement has history + the payroll desk can diff "projection at run N vs now". Pure add-on; no behaviour change to v1.

---

## 11. Security, tenancy & edge cases

- **Tenant isolation:** every query carries `businessId`; the assembler is `businessId`-scoped; payslips/comp/declaration reads are all tenant-scoped (no cross-tenant join). Operator path additionally intersects with F1 `resolveAccessibleEmployeeIds`.
- **SELF_ONLY / no IDOR:** ESS resolves the subject from the session (`resolveSelfEmployee`) — the client never supplies an employee id. Operator path validates `:employeeId ∈ accessible set` before computing (404 otherwise, never "forbidden" leak).
- **Country fail-closed:** if statutory country can't be resolved → 422, never assume India. NZ employees never reach the engine (no NZ branch exists here — single-country-per-tenant honoured; the surface is India-only by construction).
- **Read-only:** the projection **computes, never writes** (except the optional snapshot/PDF-hash, which are append-only/idempotent). It cannot change a payslip, a run, or the declaration. No SoD surface here (no maker-checker needed — nothing is approved).
- **PAN / §206AA:** no PAN on `StatutoryProfile` → 20% flat path (existing rule) + a `MISSING_PAN` anomaly surfaced on the statement so the employee is warned.
- **Previous-employer guard:** previous-employer income/TDS are counted **only** when `prevEmployerFY === currentTaxYear` — a stale prior-year declaration can't inflate this year's relief.
- **Regime correctness:** statement computes on the **elected** regime; under NEW, HRA/80C/Chapter-VI-A are **structurally skipped** (not just zeroed) so a stray declared 80C can't leak a NEW-regime deduction. The comparison line computes the *other* regime independently.
- **Mid-year / proration:** months-remaining derives from the pay calendar + published payslips, not the wall clock, so a joiner mid-FY projects over their actual remaining months (last month absorbs the rounding residual; Σschedule === remainingTax).
- **Negative/zero guards:** all deductions/exemptions floor at 0; taxable income floors at 0; `monthsRemaining` floors at 1 (December-or-later joiner still gets a single-month recovery, matching `computeTds`).
- **No proofs ⇒ declared-only:** v1 trusts declared amounts (consistent with the existing declaration model); the statement labels every 80C row DERIVED (from payslips) vs DECLARED so HR/employee see what's unproven. Proof verification is roadmap.
- **Parity drift defence:** the golden parity test (15a) fails the build if the statement's monthly recoverable ever diverges from `india.compute()`'s TDS line — the statement can never quietly lie about what payroll will deduct.
- **Effective-dating:** every new rate/slab/cap is effective-dated and resolved as-of the projection date via the existing `resolveVersion`/`periodAsOf`, so a future Budget change is a constants edit, not a code change.
```

---

**Summary (1 paragraph):** Feature 15 ships an India-only, employee-facing income-tax projection — the full IT computation from the owner's Figma (Basic/HRA/allowances/residual choice pay → HRA exemption → gross-after-exemption → perquisites → Chapter-VI-A 80C/80D/80CCD(1B) with gross/qualifying/deductible columns → standard deduction → total taxable income → tax/surcharge/cess → TDS-this-year and previous-employer TDS → **monthly tax recoverable** for each remaining month, plus an 80C investments table and an OLD-vs-NEW comparison). It **extends the existing pure `india.js` engine** (which today only knows the NEW regime + run-time monthly TDS) with an OLD-regime slab path, HRA least-of-three, a Chapter-VI-A aggregator, and perquisite valuation, then adds a read-only **assembler** that reuses `resolveSelfEmployee`, `resolveCurrentCompensation`, published-payslip YTD, and the `StatutoryProfile` declaration to compute the annual tax and project the remaining monthly TDS — guaranteed to reconcile to the live payroll run's TDS line by a golden parity test. It surfaces as `GET /api/hr/me/tax-projection` (+ `/pdf`, `/regimes`) on the SELF_ONLY ESS customer session, an operator read-only mirror behind `canViewPayrollReports` + F1 scope, an ESS "Tax projection" page, and a branded PDF — all country-gated to India, tenant-isolated, and computed (never written). Saved to `docs/features/15-india-it-projection.md`.

**Slice titles:**
- 15a — Pure engine: OLD regime + HRA + Chapter VI-A + perquisites (+ §192 parity goldens)
- 15b — Declaration model + `meTax` extension (new OLD-regime/prev-employer inputs, country hoist)
- 15c — Assembler + ESS API (`/me/tax-projection`, `/regimes`)
- 15d — PDF + operator read-only mirror (F1-scoped)
- 15e — ESS "Tax projection" page + hr-admin read-only tab
- 15f (optional fast-follow) — persist `TaxProjectionSnapshot` at run-approval for history/diff